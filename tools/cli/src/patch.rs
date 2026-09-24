//! Ordered Firefox patch-series pipeline (docs/engineering/PATCHING.md).
//!
//! - `status`: manifest validity, base-vs-lock comparison, worktree state.
//! - `check`: dry-run applicability of every series entry (read-only).
//! - `apply`: generate `worktree/firefox/` from the locked SHA and apply the
//!   ordered series. Idempotent: re-apply verifies instead of duplicating.
//!   Then sync overlays: Aequera-owned source copied into NEW directories of
//!   the worktree (never over upstream-tracked paths), so product code stays
//!   ordinary Aequera source and patches carry only the hooks that load it.
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
    #[serde(default)]
    pub overlays: Vec<OverlayEntry>,
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

/// Aequera-owned source copied into the worktree. `source` is relative to
/// the repo root; `dest` is relative to the worktree and must not contain
/// any upstream-tracked file. `dest` is fully owned: it is replaced on every
/// sync, so deletions in `source` propagate.
#[derive(Debug, Deserialize)]
pub struct OverlayEntry {
    pub id: String,
    pub source: String,
    pub dest: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AppliedState {
    base_sha: String,
    manifest_version: u32,
    applied: Vec<String>,
    #[serde(default)]
    overlays: Vec<String>,
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
    pub overlays_synced: usize,
    pub overlay_files: usize,
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
                && s.applied == patch_ids(&manifest)
                && s.overlays == overlay_ids(&manifest)
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
    let want = patch_ids(&manifest);
    // Validate overlay targets before touching the tree, so a bad manifest
    // fails with the worktree unchanged.
    for overlay in &manifest.overlays {
        validate_overlay(root, &wt, overlay)?;
    }

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
        let overlay_files = sync_overlays(root, &wt, &manifest)?;
        write_state(&wt, &state_for(lock, &manifest))?;
        return Ok(ApplyReport {
            base_sha: lock.upstream.revision.git.clone(),
            worktree_dir: wt.display().to_string(),
            entries_applied: want.len(),
            already_applied: true,
            overlays_synced: manifest.overlays.len(),
            overlay_files,
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
    let overlay_files = sync_overlays(root, &wt, &manifest)?;
    write_state(&wt, &state_for(lock, &manifest))?;
    Ok(ApplyReport {
        base_sha: lock.upstream.revision.git.clone(),
        worktree_dir: wt.display().to_string(),
        entries_applied: want.len(),
        already_applied: false,
        overlays_synced: manifest.overlays.len(),
        overlay_files,
    })
}

fn patch_ids(manifest: &PatchManifest) -> Vec<String> {
    manifest.patches.iter().map(|p| p.id.clone()).collect()
}

fn overlay_ids(manifest: &PatchManifest) -> Vec<String> {
    manifest.overlays.iter().map(|o| o.id.clone()).collect()
}

fn state_for(lock: &LockFile, manifest: &PatchManifest) -> AppliedState {
    AppliedState {
        base_sha: lock.upstream.revision.git.clone(),
        manifest_version: manifest.manifest_version,
        applied: patch_ids(manifest),
        overlays: overlay_ids(manifest),
    }
}

/// A manifest path must stay inside its base: relative, no `..`, no root or
/// drive prefix, not empty.
fn plain_relative(field: &str, id: &str, value: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let path = PathBuf::from(value);
    let plain = !value.is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)));
    if !plain {
        return Err(format!(
            "overlay {id:?}: {field} {value:?} must be a plain relative path (no '..', no root)"
        ));
    }
    Ok(path)
}

fn validate_overlay(root: &Path, wt: &Path, overlay: &OverlayEntry) -> Result<(), String> {
    let source = root.join(plain_relative("source", &overlay.id, &overlay.source)?);
    plain_relative("dest", &overlay.id, &overlay.dest)?;
    if !source.is_dir() {
        return Err(format!(
            "overlay {:?}: source directory {} missing",
            overlay.id,
            source.display()
        ));
    }
    // Overlays add Aequera-owned directories; changing Firefox files is what
    // patches are for. Any tracked path at or under dest is a hard refusal.
    let tracked = upstream::git(wt, &["ls-files", "--", &overlay.dest])
        .map_err(|e| format!("overlay {:?}: git ls-files failed: {e}", overlay.id))?;
    if !tracked.trim().is_empty() {
        return Err(format!(
            "overlay {:?}: dest {} is tracked by upstream Firefox; overlays may only add new directories (use a patch to change Firefox files)",
            overlay.id, overlay.dest
        ));
    }
    Ok(())
}

/// Replace every overlay dest with a fresh copy of its source. Returns the
/// number of files copied across all overlays.
fn sync_overlays(root: &Path, wt: &Path, manifest: &PatchManifest) -> Result<usize, String> {
    let mut total = 0;
    for overlay in &manifest.overlays {
        let source = root.join(&overlay.source);
        let dest = wt.join(&overlay.dest);
        if dest.exists() {
            std::fs::remove_dir_all(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;
        }
        total += copy_tree(&source, &dest)?;
    }
    Ok(total)
}

fn copy_tree(from: &Path, to: &Path) -> Result<usize, String> {
    std::fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
    let mut count = 0;
    for entry in std::fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))? {
        let entry = entry.map_err(|e| format!("{}: {e}", from.display()))?;
        let kind = entry
            .file_type()
            .map_err(|e| format!("{}: {e}", entry.path().display()))?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            count += copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &target)
                .map_err(|e| format!("{}: {e}", entry.path().display()))?;
            count += 1;
        } else {
            // Symlinks could point outside the overlay; refuse rather than follow.
            return Err(format!(
                "overlay source {} is not a regular file or directory",
                entry.path().display()
            ));
        }
    }
    Ok(count)
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

    fn write_manifest_with_overlays(root: &Path, base_sha: &str, overlays_yaml: &str) {
        write_manifest(
            root,
            base_sha,
            &format!(" []\n\noverlays:\n{overlays_yaml}"),
        );
    }

    #[test]
    fn overlay_syncs_source_into_worktree_and_resyncs_on_reapply() {
        let (root, lock, sha) = baseline("overlay");
        let src = root.join("aequera/shell/firefox");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.css"), "one\n").unwrap();
        std::fs::write(src.join("sub/b.js"), "two\n").unwrap();
        write_manifest_with_overlays(
            &root,
            &sha,
            "  - id: shell\n    source: aequera/shell/firefox\n    dest: browser/aequera\n",
        );

        let first = apply(&root, &lock).expect("apply");
        assert_eq!(first.overlays_synced, 1);
        assert_eq!(first.overlay_files, 2);
        let dest = root.join(WORKTREE_RELATIVE).join("browser/aequera");
        let read = |rel: &str| std::fs::read_to_string(dest.join(rel)).unwrap();
        assert_eq!(read("a.css"), "one\n");
        assert_eq!(read("sub/b.js"), "two\n");

        // Source edits and deletions propagate even when the patch state is
        // unchanged: the overlay is live Aequera source, not a one-shot copy.
        std::fs::write(src.join("a.css"), "changed\n").unwrap();
        std::fs::remove_file(src.join("sub/b.js")).unwrap();
        let again = apply(&root, &lock).expect("re-apply");
        assert!(again.already_applied);
        assert_eq!(again.overlay_files, 1);
        assert_eq!(read("a.css"), "changed\n");
        assert!(
            !dest.join("sub/b.js").exists(),
            "stale overlay file must be removed"
        );

        let st = status(&root, &lock).expect("status");
        assert_eq!(st.applied_state_matches, Some(true));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn overlay_refuses_dest_tracked_by_upstream() {
        let (root, lock, sha) = baseline("overlay-tracked");
        let src = root.join("aequera/shell/firefox");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.css"), "x\n").unwrap();
        // base.txt is Firefox-tracked: an overlay must never clobber upstream.
        write_manifest_with_overlays(
            &root,
            &sha,
            "  - id: bad\n    source: aequera/shell/firefox\n    dest: base.txt\n",
        );
        let err = apply(&root, &lock).expect_err("tracked dest must fail");
        assert!(err.contains("tracked by upstream"), "got: {err}");
        let base = std::fs::read_to_string(root.join(WORKTREE_RELATIVE).join("base.txt")).unwrap();
        // Line endings follow the host's core.autocrlf; content must not change.
        assert_eq!(base.trim_end(), "base", "upstream file must be untouched");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn overlay_rejects_path_traversal() {
        let (root, lock, sha) = baseline("overlay-traversal");
        std::fs::create_dir_all(root.join("aequera/shell/firefox")).unwrap();
        write_manifest_with_overlays(
            &root,
            &sha,
            "  - id: bad\n    source: aequera/shell/firefox\n    dest: ../escape\n",
        );
        let err = apply(&root, &lock).expect_err("traversal must fail");
        assert!(err.contains("must be a plain relative path"), "got: {err}");
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
