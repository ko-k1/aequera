//! Ordered Firefox patch-series pipeline (docs/engineering/PATCHING.md).
//!
//! - `status`: manifest validity, base-vs-lock comparison, worktree state.
//! - `check`: dry-run applicability of every series entry (read-only).
//! - `apply`: generate `worktree/firefox/` from the locked SHA and apply the
//!   ordered series. Idempotent: re-apply verifies instead of duplicating.
//!
//! Textual application is necessary but never sufficient proof of an update:
//! applies cleanly != builds != behaves correctly != passes quality gates.

use crate::lock::{self, LockFile};
use crate::upstream;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Generated build tree, relative to the repository root.
pub const WORKTREE_RELATIVE: &str = "worktree/firefox";

/// Applied-state record, relative to the worktree root.
const STATE_FILE: &str = ".aequera-applied.json";

#[derive(Debug, Deserialize)]
pub struct PatchManifest {
    pub manifest_version: u32,
    pub base: ManifestBase,
    #[serde(default)]
    pub patches: Vec<PatchEntry>,
}

#[derive(Debug, Deserialize)]
pub struct ManifestBase {
    pub upstream: BaseUpstream,
}

#[derive(Debug, Deserialize)]
pub struct BaseUpstream {
    pub channel: String,
    pub version: String,
    pub revision: String,
}

#[derive(Debug, Deserialize)]
pub struct PatchEntry {
    pub id: String,
    pub series: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AppliedState {
    base_sha: String,
    manifest_version: u32,
    applied: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct StatusReport {
    pub manifest_path: String,
    pub manifest_ok: bool,
    pub base_matches_lock: bool,
    pub base_channel: Option<String>,
    pub base_version: Option<String>,
    pub base_sha: Option<String>,
    pub lock_sha: String,
    pub worktree_present: bool,
    pub worktree_head: Option<String>,
    pub applied_state_matches: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct CheckEntry {
    pub id: String,
    pub files: Vec<String>,
    pub clean: bool,
}

#[derive(Debug, Serialize)]
pub struct CheckReport {
    pub entries_checked: usize,
    pub all_clean: bool,
    pub entries: Vec<CheckEntry>,
}

#[derive(Debug, Serialize)]
pub struct ApplyReport {
    pub base_sha: String,
    pub worktree_dir: String,
    pub entries_applied: usize,
    pub already_applied: bool,
}

/// Load and minimally validate the patchset manifest named by the lock.
pub fn load_manifest(root: &Path, lock: &LockFile) -> Result<PatchManifest, String> {
    let path = root.join(&lock.patchset.manifest);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let manifest: PatchManifest = serde_yaml::from_str(&text)
        .map_err(|e| format!("{}: invalid YAML: {e}", path.display()))?;
    if manifest.manifest_version != 1 {
        return Err(format!(
            "unsupported manifest_version {} (this CLI supports 1)",
            manifest.manifest_version
        ));
    }
    Ok(manifest)
}

pub fn status(root: &Path, lock: &LockFile) -> Result<StatusReport, String> {
    let manifest = load_manifest(root, lock)?;
    let base_matches = manifest.base.upstream.revision == lock.upstream.revision.git;
    let wt = root.join(WORKTREE_RELATIVE);
    let worktree_present = lock::substantive_present(&wt);
    let worktree_head = worktree_present
        .then(|| upstream::git(&wt, &["rev-parse", "HEAD"]).ok())
        .flatten()
        .map(|h| h.trim().to_string());
    let applied_state_matches = worktree_present
        .then(|| read_state(&wt).ok())
        .flatten()
        .map(|s| {
            s.base_sha == lock.upstream.revision.git
                && s.manifest_version == manifest.manifest_version
                && s.applied
                    == manifest
                        .patches
                        .iter()
                        .map(|p| p.id.clone())
                        .collect::<Vec<_>>()
        });
    Ok(StatusReport {
        manifest_path: lock.patchset.manifest.clone(),
        manifest_ok: true,
        base_matches_lock: base_matches,
        base_channel: Some(manifest.base.upstream.channel.clone()),
        base_version: Some(manifest.base.upstream.version.clone()),
        base_sha: Some(manifest.base.upstream.revision.clone()),
        lock_sha: lock.upstream.revision.git.clone(),
        worktree_present,
        worktree_head,
        applied_state_matches,
    })
}

pub fn check(root: &Path, lock: &LockFile) -> Result<CheckReport, String> {
    let manifest = load_manifest(root, lock)?;
    require_base_matches(&manifest, lock)?;
    let wt = ensure_worktree_shell(root, lock)?;
    let mut entries = Vec::new();
    for entry in &manifest.patches {
        let files = series_files(root, entry)?;
        for f in &files {
            upstream::git(&wt, &["apply", "--check", &f.display().to_string()]).map_err(|e| {
                format!(
                    "series {:?}: {} does not apply cleanly: {e}",
                    entry.id,
                    f.display()
                )
            })?;
        }
        entries.push(CheckEntry {
            id: entry.id.clone(),
            files: files.iter().map(|f| f.display().to_string()).collect(),
            clean: true,
        });
    }
    Ok(CheckReport {
        entries_checked: entries.len(),
        all_clean: true,
        entries,
    })
}

pub fn apply(root: &Path, lock: &LockFile) -> Result<ApplyReport, String> {
    let manifest = load_manifest(root, lock)?;
    require_base_matches(&manifest, lock)?;
    let wt = ensure_worktree_shell(root, lock)?;
    let want: Vec<String> = manifest.patches.iter().map(|p| p.id.clone()).collect();

    // Idempotency: identical state + reverse-check proof means "already applied".
    if let Ok(state) = read_state(&wt)
        && state.base_sha == lock.upstream.revision.git
        && state.manifest_version == manifest.manifest_version
        && state.applied == want
    {
        for entry in &manifest.patches {
            for f in series_files(root, entry)? {
                upstream::git(&wt, &["apply", "--check", "--reverse", &f.display().to_string()])
                    .map_err(|e| {
                        format!(
                            "state claims {:?} applied but reverse-check fails on {}: {e}; worktree needs rebuild",
                            entry.id,
                            f.display()
                        )
                    })?;
            }
        }
        return Ok(ApplyReport {
            base_sha: lock.upstream.revision.git.clone(),
            worktree_dir: wt.display().to_string(),
            entries_applied: want.len(),
            already_applied: true,
        });
    }

    let mut applied = Vec::new();
    for entry in &manifest.patches {
        for f in series_files(root, entry)? {
            let rel = f.display().to_string();
            upstream::git(&wt, &["apply", "--check", &rel]).map_err(|e| {
                format!(
                    "series {:?}: pre-apply check failed on {rel}: {e}",
                    entry.id
                )
            })?;
            upstream::git(&wt, &["apply", &rel])
                .map_err(|e| format!("series {:?}: apply failed on {rel}: {e}", entry.id))?;
        }
        applied.push(entry.id.clone());
    }
    write_state(
        &wt,
        &AppliedState {
            base_sha: lock.upstream.revision.git.clone(),
            manifest_version: manifest.manifest_version,
            applied: want.clone(),
        },
    )?;
    Ok(ApplyReport {
        base_sha: lock.upstream.revision.git.clone(),
        worktree_dir: wt.display().to_string(),
        entries_applied: want.len(),
        already_applied: false,
    })
}

fn require_base_matches(manifest: &PatchManifest, lock: &LockFile) -> Result<(), String> {
    // Revision is authoritative; channel is policy metadata that must also
    // agree (a Release series on an ESR lock is a category error).
    // Version stays informational and is surfaced in status output.
    if manifest.base.upstream.channel != lock.upstream.channel {
        return Err(format!(
            "patch drift: manifest base channel {} != lock channel {}; rebase the series before applying",
            manifest.base.upstream.channel, lock.upstream.channel
        ));
    }
    if manifest.base.upstream.revision != lock.upstream.revision.git {
        return Err(format!(
            "patch drift: manifest base {} != lock {}; rebase the series before applying",
            manifest.base.upstream.revision, lock.upstream.revision.git
        ));
    }
    Ok(())
}

/// Resolve a series entry to its ordered patch files.
fn series_files(root: &Path, entry: &PatchEntry) -> Result<Vec<PathBuf>, String> {
    let dir = root.join("patches").join(&entry.series);
    if !dir.is_dir() {
        return Err(format!(
            "series {:?}: directory {} missing",
            entry.id,
            dir.display()
        ));
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "patch").unwrap_or(false))
        .collect();
    files.sort();
    if files.is_empty() {
        return Err(format!(
            "series {:?}: no *.patch files in {}",
            entry.id,
            dir.display()
        ));
    }
    Ok(files)
}

/// Ensure the worktree exists at the locked SHA. Creates it via
/// `git worktree add --detach` on first use; thereafter requires HEAD to
/// match the lock (rebuilds are explicit: delete the directory).
fn ensure_worktree_shell(root: &Path, lock: &LockFile) -> Result<PathBuf, String> {
    let wt = root.join(WORKTREE_RELATIVE);
    let sha = &lock.upstream.revision.git;
    if lock::substantive_present(&wt) {
        let head = upstream::git(&wt, &["rev-parse", "HEAD"])
            .map_err(|e| format!("worktree at {} is not a usable git tree: {e}", wt.display()))?;
        if head.trim() != sha {
            return Err(format!(
                "worktree HEAD {} != lock {sha}; delete {} to rebuild explicitly",
                head.trim(),
                wt.display()
            ));
        }
        return Ok(wt);
    }
    // Claim skeleton placeholders, then create the linked worktree.
    std::fs::create_dir_all(&wt).map_err(|e| format!("{}: {e}", wt.display()))?;
    let marker = wt.join(".gitkeep");
    if marker.is_file() {
        std::fs::remove_file(&marker).map_err(|e| format!("{}: {e}", marker.display()))?;
    }
    let repo = root.join(upstream::CHECKOUT_RELATIVE);
    if !repo.join(".git").exists() {
        return Err(format!(
            "no managed checkout at {}; run `aequera bootstrap` first",
            repo.display()
        ));
    }
    upstream::git(
        &repo,
        &[
            "worktree",
            "add",
            "--detach",
            &wt.display().to_string(),
            sha,
        ],
    )
    .map_err(|e| format!("git worktree add failed: {e}"))?;
    Ok(wt)
}

fn read_state(wt: &Path) -> Result<AppliedState, String> {
    let path = wt.join(STATE_FILE);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{path:?}: invalid state: {e}"))
}

fn write_state(wt: &Path, state: &AppliedState) -> Result<(), String> {
    let path = wt.join(STATE_FILE);
    let text = serde_json::to_string_pretty(state).map_err(|e| format!("state: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock::{Patchset, Repository, ResolvedFrom, Revision, Upstream};
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn scratch(name: &str) -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "aequera-patch-test-{}-{}-{}",
            std::process::id(),
            id,
            name
        ))
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "fixture git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn fixture_origin(scratch: &Path) -> (PathBuf, String) {
        let origin = scratch.join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init"]);
        std::fs::write(origin.join("base.txt"), "base\n").unwrap();
        git(&origin, &["add", "."]);
        git(&origin, &["commit", "-m", "fixture"]);
        git(&origin, &["tag", "FIXTURE_1"]);
        let sha = git(&origin, &["rev-parse", "HEAD"]);
        (origin, sha)
    }

    fn lock_for(url: &str, sha: &str) -> LockFile {
        LockFile {
            schema_version: 1,
            upstream: Upstream {
                name: "firefox".into(),
                repository: Repository {
                    kind: "git".into(),
                    url: url.into(),
                },
                channel: "test".into(),
                version: "0".into(),
                revision: Revision { git: sha.into() },
                resolved_from: ResolvedFrom {
                    kind: "tag".into(),
                    ref_name: "FIXTURE_1".into(),
                },
                pinned_at: None,
            },
            patchset: Patchset {
                manifest: "patches/manifest.yaml".into(),
                version: 0,
            },
        }
    }

    fn write_manifest(root: &Path, base_sha: &str, entries_yaml: &str) {
        let text = format!(
            "manifest_version: 1\n\nbase:\n  upstream:\n    channel: test\n    version: \"0\"\n    revision: \"{base_sha}\"\n\npatches:\n{entries_yaml}"
        );
        let dir = root.join("patches");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.yaml"), text).unwrap();
    }

    /// Scratch repo root with fetched + checked-out baseline; returns (root, lock, sha).
    fn baseline(name: &str) -> (PathBuf, LockFile, String) {
        let root = scratch(name);
        let (origin, sha) = fixture_origin(&root);
        let lock = lock_for(origin.to_str().unwrap(), &sha);
        crate::upstream::fetch(&root, &lock).expect("fetch");
        crate::upstream::checkout(&root, &lock, "test").expect("checkout");
        (root, lock, sha)
    }

    #[test]
    fn apply_empty_series_creates_worktree_and_is_idempotent() {
        let (root, lock, sha) = baseline("empty");
        write_manifest(&root, &sha, " []\n");

        let first = apply(&root, &lock).expect("first apply");
        assert!(!first.already_applied);
        assert_eq!(first.entries_applied, 0);
        let wt = root.join(WORKTREE_RELATIVE);
        let head = upstream::git(&wt, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(head.trim(), sha);

        // Byte-identical re-apply proves idempotency instead of duplicating.
        let second = apply(&root, &lock).expect("second apply");
        assert!(second.already_applied);

        let st = status(&root, &lock).expect("status");
        assert!(st.base_matches_lock);
        assert!(st.worktree_present);
        assert_eq!(st.applied_state_matches, Some(true));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn apply_real_series_modifies_worktree() {
        let (root, lock, sha) = baseline("series");
        // Generate a genuine patch from the fixture origin.
        let origin = root.join("origin");
        std::fs::write(origin.join("base.txt"), "base\npatched\n").unwrap();
        let diff = git(&origin, &["diff"]);
        git(&origin, &["checkout", "--", "base.txt"]);
        let series = root.join("patches/browser/smoke");
        std::fs::create_dir_all(&series).unwrap();
        // The git() helper trims stdout; restore the trailing newline so the
        // patch file is well-formed.
        std::fs::write(series.join("0001-smoke.patch"), format!("{diff}\n")).unwrap();
        write_manifest(&root, &sha, "  - id: smoke\n    series: browser/smoke\n");

        let report = check(&root, &lock).expect("check");
        assert_eq!(report.entries_checked, 1);
        assert!(report.all_clean);

        let applied = apply(&root, &lock).expect("apply");
        assert!(!applied.already_applied);
        assert_eq!(applied.entries_applied, 1);
        let content =
            std::fs::read_to_string(root.join(WORKTREE_RELATIVE).join("base.txt")).unwrap();
        assert!(content.contains("patched"), "got: {content:?}");

        let again = apply(&root, &lock).expect("re-apply");
        assert!(again.already_applied);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn apply_refuses_drifted_base() {
        let (root, lock, _sha) = baseline("drift");
        write_manifest(&root, "1111111111111111111111111111111111111111", " []\n");
        let err = apply(&root, &lock).expect_err("drifted base must fail");
        assert!(err.contains("patch drift"), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }
}
