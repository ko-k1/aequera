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
pub(crate) const STATE_FILE: &str = ".aequera-applied.json";

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

/// How one patch file lands on a candidate baseline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Applicability {
    /// Applies byte-for-byte.
    Clean,
    /// Applies only through a 3-way merge: correct content, stale patch file.
    ThreeWay,
    /// Needs a manual rebase.
    Conflict,
}

#[derive(Debug, Serialize)]
pub struct CandidateFile {
    pub id: String,
    pub file: String,
    pub result: Applicability,
    pub conflicts: Vec<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CandidateCheckReport {
    pub base_version: String,
    pub base_sha: String,
    pub candidate_version: String,
    pub candidate_sha: String,
    pub clean: usize,
    pub three_way: usize,
    pub conflicts: usize,
    pub files: Vec<CandidateFile>,
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
    // The lock is an input file: its `manifest` pointer must not escape the
    // repo (e.g. `../../etc/evil.yaml`). Validate before joining.
    let manifest_rel = plain_relative("manifest", "patchset", &lock.patchset.manifest)?;
    let path = root.join(&manifest_rel);
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
    // Offline pointer validation (PR-CI friendly, no upstream objects needed):
    // a broken `series`/`source`/`dest` must fail `patch status`, not wait for
    // the nightly full `patch check` that needs GBs of Firefox history.
    validate_manifest_pointers(root, &manifest)?;
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
    // Later patches depend on earlier ones, so each file is checked against
    // the tree as the preceding files leave it. The series is applied, in
    // order, to a throwaway index seeded from the locked HEAD: cumulative,
    // independent of the worktree's current state, and never touching it.
    let index = ScratchIndex::seeded(&wt, "HEAD")?;
    let mut entries = Vec::new();
    for entry in &manifest.patches {
        let files = series_files(root, entry)?;
        for f in &files {
            index.apply(&wt, f).map_err(|e| {
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

/// Dry-run the series against a staged candidate baseline (read-only).
///
/// Same cumulative scratch-index method as `check`, seeded from the
/// candidate SHA inside the managed checkout (whose HEAD, index, and files
/// are never touched). Each file is tried exactly, then by 3-way merge;
/// the merge reads the preimage blobs of the series' authored base, so the
/// manifest base must still equal the lock. In a conflicting file, the
/// conflicted paths stay at their pre-patch content and the cleanly merged
/// paths are kept, so one conflict does not cascade into every later patch
/// that only builds on the file's other hunks. A file that fails without
/// unmerged paths is rolled back whole.
pub fn check_candidate(
    root: &Path,
    lock: &LockFile,
    candidate: &LockFile,
) -> Result<CandidateCheckReport, String> {
    let manifest = load_manifest(root, lock)?;
    require_base_matches(&manifest, lock)?;
    let repo = root.join(upstream::CHECKOUT_RELATIVE);
    if !repo.join(".git").exists() {
        return Err(format!(
            "no managed checkout at {}; run `aequera bootstrap` first",
            repo.display()
        ));
    }
    let want = &candidate.upstream.revision.git;
    if upstream::git(&repo, &["cat-file", "-e", &format!("{want}^{{commit}}")]).is_err() {
        return Err(format!(
            "candidate {want} is not present locally; run `aequera upstream update --to {}`",
            candidate.upstream.resolved_from.ref_name
        ));
    }

    let index = ScratchIndex::seeded(&repo, want)?;
    let mut files = Vec::new();
    for entry in &manifest.patches {
        for f in series_files(root, entry)? {
            let before = index.write_tree(&repo)?;
            let (result, conflicts, detail) = match index.apply_with_fallback(&repo, &f) {
                Ok(result) => (result, Vec::new(), None),
                Err(e) => {
                    let conflicts = index.keep_ours_on_conflicts(&repo)?;
                    if conflicts.is_empty() {
                        index.reset_to(&repo, &before)?;
                    }
                    (Applicability::Conflict, conflicts, Some(e))
                }
            };
            files.push(CandidateFile {
                id: entry.id.clone(),
                file: f.strip_prefix(root).unwrap_or(&f).display().to_string(),
                result,
                conflicts,
                detail,
            });
        }
    }
    let count = |r: Applicability| files.iter().filter(|f| f.result == r).count();
    Ok(CandidateCheckReport {
        base_version: lock.upstream.version.clone(),
        base_sha: lock.upstream.revision.git.clone(),
        candidate_version: candidate.upstream.version.clone(),
        candidate_sha: want.clone(),
        clean: count(Applicability::Clean),
        three_way: count(Applicability::ThreeWay),
        conflicts: count(Applicability::Conflict),
        files,
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

    // Idempotency: identical patches + proof that the worktree's tracked
    // files equal base + the whole ordered series means no patch re-apply
    // is needed. Overlays are part of the state: a changed overlay list
    // re-syncs overlays and reports already_applied:false without
    // re-running `git apply` (which would fail on an already-patched tree).
    if let Ok(state) = read_state(&wt)
        && state.base_sha == lock.upstream.revision.git
        && state.manifest_version == manifest.manifest_version
        && state.applied == want
    {
        verify_worktree_matches_series(root, &wt, &manifest)?;
        let overlays_changed = state.overlays != overlay_ids(&manifest);
        let overlay_files = sync_overlays(root, &wt, &manifest)?;
        write_state(&wt, &state_for(lock, &manifest))?;
        return Ok(ApplyReport {
            base_sha: lock.upstream.revision.git.clone(),
            worktree_dir: wt.display().to_string(),
            entries_applied: want.len(),
            already_applied: !overlays_changed,
            overlays_synced: manifest.overlays.len(),
            overlay_files,
        });
    }

    let mut applied = Vec::new();
    for entry in &manifest.patches {
        for f in series_files(root, entry)? {
            let rel = f.display().to_string();
            // Single `git apply` (no separate `--check`): check-then-apply
            // is a TOCTOU window where the patch file could change between
            // the two invocations. Apply fails atomically with the same
            // diagnostic either way.
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

/// The tree the series should produce, built in a scratch index (so a
/// dependent series is applied cumulatively, as `apply` does), compared with
/// the worktree's tracked files. Untracked output (overlays, objdir) is out
/// of scope; any tracked difference is drift.
pub(crate) fn verify_worktree_matches_series(
    root: &Path,
    wt: &Path,
    manifest: &PatchManifest,
) -> Result<(), String> {
    let index = ScratchIndex::seeded(wt, "HEAD")?;
    for entry in &manifest.patches {
        for f in series_files(root, entry)? {
            index.apply(wt, &f).map_err(|e| {
                format!(
                    "series {:?}: {} no longer applies to base: {e}",
                    entry.id,
                    f.display()
                )
            })?;
        }
    }
    let expected = index.write_tree(wt)?;
    upstream::git(wt, &["diff", "--quiet", &expected, "--"]).map_err(|_| {
        "state claims the series is applied but tracked worktree files differ from base + series; worktree needs rebuild".to_string()
    })?;
    Ok(())
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
/// drive prefix, not empty. Backslash and colon are rejected explicitly so
/// a manifest validated on Linux cannot traverse when applied on Windows
/// (where `\` is a separator and `:` introduces a drive).
pub(crate) fn plain_relative(field: &str, id: &str, value: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    if value.is_empty() || value.contains(['\\', ':', '\0']) {
        return Err(format!(
            "{id:?}: {field} {value:?} must be a plain relative path (no '..', no root, no '\\' or ':')"
        ));
    }
    let path = PathBuf::from(value);
    let plain = path.components().all(|c| matches!(c, Component::Normal(_)));
    if !plain {
        return Err(format!(
            "{id:?}: {field} {value:?} must be a plain relative path (no '..', no root)"
        ));
    }
    Ok(path)
}

pub(crate) fn validate_overlay(
    root: &Path,
    wt: &Path,
    overlay: &OverlayEntry,
) -> Result<(), String> {
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
pub(crate) fn sync_overlays(
    root: &Path,
    wt: &Path,
    manifest: &PatchManifest,
) -> Result<usize, String> {
    let mut total = 0;
    for overlay in &manifest.overlays {
        // Re-validate here (never trust raw strings): guarantees `dest`
        // cannot be empty/root/traversal even if a future caller skips
        // `validate_overlay`. An empty `dest` would make `wt.join("") == wt`
        // and `remove_dir_all` would wipe the worktree itself.
        let source_rel = plain_relative("source", &overlay.id, &overlay.source)?;
        let dest_rel = plain_relative("dest", &overlay.id, &overlay.dest)?;
        let source = root.join(source_rel);
        let dest = wt.join(dest_rel);
        // Never follow a symlink at `dest`: a planted link to `/` or `$HOME`
        // must not have its target wiped. Remove the link itself, refuse to
        // recurse through it.
        match std::fs::symlink_metadata(&dest) {
            Ok(meta) if meta.file_type().is_symlink() => {
                std::fs::remove_file(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;
            }
            Ok(meta) if meta.is_dir() => {
                std::fs::remove_dir_all(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;
            }
            Ok(_) => {
                std::fs::remove_file(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", dest.display())),
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

pub(crate) fn require_base_matches(
    manifest: &PatchManifest,
    lock: &LockFile,
) -> Result<(), String> {
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

/// Offline manifest pointer check: every `series`/`source`/`dest` must be a
/// plain relative path and its directory must exist in the repo. Runs in
/// `status` so PR CI (no Firefox objects) still catches a renamed or
/// traversal series before the nightly `check` (which proves applicability).
fn validate_manifest_pointers(root: &Path, manifest: &PatchManifest) -> Result<(), String> {
    for entry in &manifest.patches {
        let series_rel = plain_relative("series", &entry.id, &entry.series)?;
        let dir = root.join("patches").join(&series_rel);
        if !dir.is_dir() {
            return Err(format!(
                "series {:?}: directory {} missing",
                entry.id,
                dir.display()
            ));
        }
    }
    for overlay in &manifest.overlays {
        let source_rel = plain_relative("source", &overlay.id, &overlay.source)?;
        let dest_rel = plain_relative("dest", &overlay.id, &overlay.dest)?;
        let source = root.join(source_rel);
        if !source.is_dir() {
            return Err(format!(
                "overlay {:?}: source directory {} missing",
                overlay.id,
                source.display()
            ));
        }
        // `dest` validity (plain relative) already proven; existence is
        // worktree state, not repo state, so no filesystem check here.
        let _ = dest_rel;
    }
    Ok(())
}

/// Resolve a series entry to its ordered patch files.
pub(crate) fn series_files(root: &Path, entry: &PatchEntry) -> Result<Vec<PathBuf>, String> {
    // `series` comes from the manifest: validate before joining so
    // `../../etc` cannot escape `patches/`.
    let series_rel = plain_relative("series", &entry.id, &entry.series)?;
    let dir = root.join("patches").join(&series_rel);
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
    // A symlinked *.patch would apply bytes from outside the repo. Refuse
    // rather than follow: patches must be committed repo files.
    for p in &files {
        if std::fs::symlink_metadata(p)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(format!(
                "series {:?}: {} is a symlink; refusing",
                entry.id,
                p.display()
            ));
        }
    }
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
    // A worktree directory deleted by hand stays registered, and `worktree
    // add` refuses a registered path: drop such stale records first.
    upstream::git(&repo, &["worktree", "prune"])?;
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

/// A temporary Git index file, seeded from a tree-ish and deleted on drop.
/// Patches applied with `--cached` land only here, never in a working tree
/// or its real index.
pub(crate) struct ScratchIndex {
    path: PathBuf,
}

impl ScratchIndex {
    pub(crate) fn seeded(wt: &Path, treeish: &str) -> Result<Self, String> {
        // Exclusive creation (O_EXCL): a predictable /tmp path without
        // `create_new` lets an attacker pre-create a symlink and have
        // `git read-tree/write-tree` follow it. Retry with a per-attempt
        // counter so parallel processes never collide.
        for attempt in 0..100 {
            let path = std::env::temp_dir().join(format!(
                "aequera-check-index-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or_default(),
                attempt
            ));
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => {
                    let index = Self { path };
                    if let Err(e) =
                        upstream::git_with_env(wt, &["read-tree", treeish], &index.env())
                    {
                        std::fs::remove_file(&index.path).ok();
                        return Err(format!("could not seed scratch index: {e}"));
                    }
                    return Ok(index);
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("could not create scratch index: {e}")),
            }
        }
        Err("could not create unique scratch index after 100 attempts".into())
    }

    fn env(&self) -> [(&str, &Path); 1] {
        [("GIT_INDEX_FILE", self.path.as_path())]
    }

    pub(crate) fn apply(&self, wt: &Path, patch: &Path) -> Result<(), String> {
        let patch = patch.display().to_string();
        upstream::git_with_env(wt, &["apply", "--cached", &patch], &self.env()).map(|_| ())
    }

    /// Exact apply first; on failure, a 3-way merge from the preimage blobs
    /// named in the patch's `index` lines. A 3-way conflict leaves unmerged
    /// entries in this index (see `keep_ours_on_conflicts`, `reset_to`).
    fn apply_with_fallback(&self, wt: &Path, patch: &Path) -> Result<Applicability, String> {
        if self.apply(wt, patch).is_ok() {
            return Ok(Applicability::Clean);
        }
        let patch = patch.display().to_string();
        upstream::git_with_env(wt, &["apply", "--cached", "-3", &patch], &self.env())
            .map(|_| Applicability::ThreeWay)
    }

    /// Paths left unmerged by a failed 3-way apply, sorted and deduplicated.
    /// Resolve every unmerged path to its pre-patch content (stage 2, or
    /// absent if it had none), keeping the patch's cleanly merged paths so
    /// later patches that build on them still see them. Returns the
    /// resolved paths in index order.
    fn keep_ours_on_conflicts(&self, wt: &Path) -> Result<Vec<String>, String> {
        let out = upstream::git_with_env(wt, &["ls-files", "-u", "-z"], &self.env())?;
        let mut paths: Vec<&str> = Vec::new();
        let mut ours = Vec::new();
        // NUL-terminated `<mode> <object> <stage>\t<path>`, one per stage.
        for record in out.split('\0').filter(|r| !r.is_empty()) {
            let Some((meta, path)) = record.split_once('\t') else {
                continue;
            };
            if paths.last() != Some(&path) {
                paths.push(path);
            }
            if let [mode, object, "2"] = meta.split(' ').collect::<Vec<_>>()[..] {
                ours.push(format!("{mode},{object},{path}"));
            }
        }
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let mut remove = vec!["update-index", "--force-remove", "--"];
        remove.extend(&paths);
        upstream::git_with_env(wt, &remove, &self.env())?;
        for info in &ours {
            upstream::git_with_env(
                wt,
                &["update-index", "--add", "--cacheinfo", info],
                &self.env(),
            )?;
        }
        Ok(paths.into_iter().map(String::from).collect())
    }

    /// Replace the index contents with `tree` (drops unmerged entries).
    fn reset_to(&self, wt: &Path, tree: &str) -> Result<(), String> {
        upstream::git_with_env(wt, &["read-tree", tree], &self.env()).map(|_| ())
    }

    /// Write the index as a tree object; returns its id.
    pub(crate) fn write_tree(&self, wt: &Path) -> Result<String, String> {
        upstream::git_with_env(wt, &["write-tree"], &self.env())
            .map_err(|e| format!("could not write expected tree: {e}"))
    }
}

impl Drop for ScratchIndex {
    fn drop(&mut self) {
        std::fs::remove_file(&self.path).ok();
    }
}

fn read_state(wt: &Path) -> Result<AppliedState, String> {
    let path = wt.join(STATE_FILE);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{path:?}: invalid state: {e}"))
}

fn write_state(wt: &Path, state: &AppliedState) -> Result<(), String> {
    let path = wt.join(STATE_FILE);
    let text = serde_json::to_string_pretty(state).map_err(|e| format!("state: {e}"))?;
    // Atomic temp+rename: a crash mid-write must not leave a half JSON file
    // that `status()` then misreads as valid applied state.
    let tmp = wt.join(format!("{STATE_FILE}.tmp-{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))?;
    // Best-effort cleanup of stale tmp files from crashed processes.
    if let Ok(entries) = std::fs::read_dir(wt) {
        let prefix = format!("{STATE_FILE}.tmp-");
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&prefix) {
                std::fs::remove_file(entry.path()).ok();
            }
        }
    }
    Ok(())
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
    fn check_validates_dependent_series_cumulatively() {
        let (root, lock, sha) = baseline("dependent");
        // 0002's context only exists after 0001: each alone against base
        // fails, the ordered series applies.
        let origin = root.join("origin");
        std::fs::write(origin.join("base.txt"), "base\none\n").unwrap();
        let first = git(&origin, &["diff"]);
        git(&origin, &["commit", "-am", "one"]);
        std::fs::write(origin.join("base.txt"), "base\none\ntwo\n").unwrap();
        let second = git(&origin, &["diff"]);
        let series = root.join("patches/browser/dependent");
        std::fs::create_dir_all(&series).unwrap();
        std::fs::write(series.join("0001-one.patch"), format!("{first}\n")).unwrap();
        std::fs::write(series.join("0002-two.patch"), format!("{second}\n")).unwrap();
        write_manifest(
            &root,
            &sha,
            "  - id: dependent\n    series: browser/dependent\n",
        );

        let report = check(&root, &lock).expect("ordered series must check clean");
        assert!(report.all_clean);
        // check is read-only: the worktree still holds the pristine base.
        let base = std::fs::read_to_string(root.join(WORKTREE_RELATIVE).join("base.txt")).unwrap();
        assert_eq!(base.trim_end(), "base");

        let applied = apply(&root, &lock).expect("apply");
        assert_eq!(applied.entries_applied, 1);
        let content =
            std::fs::read_to_string(root.join(WORKTREE_RELATIVE).join("base.txt")).unwrap();
        assert!(content.contains("two"), "got: {content:?}");

        // Re-apply must verify the whole series, not reverse-check files one
        // by one (reversing 0001 alone fails while 0002 sits on top of it).
        let again = apply(&root, &lock).expect("re-apply of a dependent series");
        assert!(again.already_applied);

        // A hand edit in the worktree is drift, never "already applied".
        let wt_file = root.join(WORKTREE_RELATIVE).join("base.txt");
        std::fs::write(&wt_file, "base\none\ntwo\nhand edit\n").unwrap();
        let err = apply(&root, &lock).expect_err("drifted worktree must be refused");
        assert!(err.contains("worktree needs rebuild"), "got: {err}");
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

    #[test]
    fn overlay_rejects_windows_separator_and_drive() {
        assert!(plain_relative("dest", "x", "a\\b").is_err());
        assert!(plain_relative("dest", "x", "C:/evil").is_err());
        assert!(plain_relative("dest", "x", "").is_err());
        assert!(plain_relative("dest", "x", "browser/aequera").is_ok());
    }

    #[test]
    fn series_rejects_path_traversal() {
        let root = scratch("series-traversal");
        std::fs::create_dir_all(root.join("patches")).unwrap();
        for evil in ["../escape", "/abs", "a\\b", "C:/evil", ""] {
            let entry = PatchEntry {
                id: "evil".into(),
                series: evil.into(),
            };
            let err = series_files(&root, &entry).expect_err("traversal must fail");
            assert!(err.contains("must be a plain relative path"), "got: {err}");
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn manifest_pointer_rejects_traversal() {
        let root = scratch("manifest-traversal");
        std::fs::create_dir_all(&root).unwrap();
        let mut lock = lock_for("https://example.invalid/x.git", &"a".repeat(40));
        lock.patchset.manifest = "../../etc/evil.yaml".into();
        let err = load_manifest(&root, &lock).expect_err("traversal must fail");
        assert!(err.contains("must be a plain relative path"), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reapply_after_overlay_change_is_not_already_applied() {
        let (root, lock, sha) = baseline("overlay-idem");
        let src = root.join("aequera/shell/firefox");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.css"), "x\n").unwrap();
        write_manifest_with_overlays(
            &root,
            &sha,
            "  - id: shell\n    source: aequera/shell/firefox\n    dest: browser/aequera\n",
        );
        let first = apply(&root, &lock).expect("apply");
        assert!(!first.already_applied);
        // Change the overlay id list: same patches, different overlays.
        // Must not report already_applied.
        write_manifest_with_overlays(
            &root,
            &sha,
            "  - id: shell-v2\n    source: aequera/shell/firefox\n    dest: browser/aequera\n",
        );
        let second = apply(&root, &lock).expect("re-apply with new overlay");
        assert!(
            !second.already_applied,
            "changed overlays must force a fresh apply, got: {second:?}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn overlay_change_with_nonempty_series_does_not_reapply_patches() {
        let (root, lock, sha) = baseline("overlay-series");
        // One real patch.
        let origin = root.join("origin");
        std::fs::write(origin.join("base.txt"), "base\npatched\n").unwrap();
        let diff = git(&origin, &["diff"]);
        git(&origin, &["checkout", "--", "base.txt"]);
        let series = root.join("patches/browser/smoke");
        std::fs::create_dir_all(&series).unwrap();
        std::fs::write(series.join("0001-smoke.patch"), format!("{diff}\n")).unwrap();
        // Overlay source.
        let src = root.join("aequera/shell/firefox");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.css"), "x\n").unwrap();
        // Manifest with both patches and overlays.
        let text = format!(
            "manifest_version: 1\n\nbase:\n  upstream:\n    channel: test\n    version: \"0\"\n    revision: \"{sha}\"\n\npatches:\n  - id: smoke\n    series: browser/smoke\n\noverlays:\n  - id: shell\n    source: aequera/shell/firefox\n    dest: browser/aequera\n"
        );
        std::fs::create_dir_all(root.join("patches")).unwrap();
        std::fs::write(root.join("patches/manifest.yaml"), &text).unwrap();

        let first = apply(&root, &lock).expect("first apply");
        assert!(!first.already_applied);
        let content =
            std::fs::read_to_string(root.join(WORKTREE_RELATIVE).join("base.txt")).unwrap();
        assert!(content.contains("patched"));

        // Change only the overlay id: patches identical. Must succeed
        // without re-running `git apply` (which would fail on an
        // already-patched tree) and report already_applied:false.
        let text2 = text.replace("- id: shell\n", "- id: shell-v2\n");
        std::fs::write(root.join("patches/manifest.yaml"), &text2).unwrap();
        let second = apply(&root, &lock).expect("overlay-only re-apply must succeed");
        assert!(
            !second.already_applied,
            "overlay change must not claim already_applied, got: {second:?}"
        );
        let content2 =
            std::fs::read_to_string(root.join(WORKTREE_RELATIVE).join("base.txt")).unwrap();
        assert!(
            content2.contains("patched"),
            "patch content lost: {content2:?}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    fn lines(prefix: &str) -> String {
        (1..=10).map(|i| format!("{prefix}{i}\n")).collect()
    }

    #[test]
    fn check_candidate_reports_clean_three_way_and_conflict() {
        let root = scratch("candidate");
        let origin = root.join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init"]);
        // Byte-exact checkouts whatever core.autocrlf says (Windows runners set
        // it system-wide for the CLI's git calls, not for this helper's).
        std::fs::write(origin.join(".gitattributes"), "* -text\n").unwrap();
        std::fs::write(origin.join("a.txt"), lines("a")).unwrap();
        std::fs::write(origin.join("b.txt"), "b\n").unwrap();
        std::fs::write(origin.join("c.txt"), "c\n").unwrap();
        git(&origin, &["add", "."]);
        git(&origin, &["commit", "-m", "base"]);
        git(&origin, &["tag", "FIXTURE_1"]);
        let base = git(&origin, &["rev-parse", "HEAD"]);

        // Series authored on base. 0001/0004 stack on c.txt (cumulative),
        // 0002 edits a5, 0003 edits b's only line.
        let series = root.join("patches/browser/cand");
        std::fs::create_dir_all(&series).unwrap();
        let capture = |name: &str, edits: &[(&str, &str)]| {
            for (file, content) in edits {
                std::fs::write(origin.join(file), content).unwrap();
            }
            let diff = git(&origin, &["diff"]);
            std::fs::write(series.join(name), format!("{diff}\n")).unwrap();
            git(&origin, &["add", "."]);
        };
        capture("0001-c.patch", &[("c.txt", "c\none\n")]);
        let a5 = lines("a").replace("a5\n", "A5\n");
        capture("0002-a.patch", &[("a.txt", &a5)]);
        // 0003 conflicts in b.txt; its c.txt hunk merges cleanly, and 0004
        // only applies on top of it (no cascade from the b.txt conflict).
        capture(
            "0003-bc.patch",
            &[("b.txt", "ours\n"), ("c.txt", "c\none\nthree\n")],
        );
        capture("0004-c.patch", &[("c.txt", "c\none\nthree\nfour\n")]);
        git(&origin, &["reset", "--hard", "-q", &base]);

        // Candidate upstream: a2 is context for 0002 (exact apply fails, a
        // 3-way merge succeeds); b's only line changed under 0003.
        std::fs::write(origin.join("a.txt"), lines("a").replace("a2\n", "X2\n")).unwrap();
        std::fs::write(origin.join("b.txt"), "theirs\n").unwrap();
        git(&origin, &["commit", "-am", "candidate"]);
        git(&origin, &["tag", "FIXTURE_2"]);
        let next = git(&origin, &["rev-parse", "HEAD"]);

        let lock = lock_for(origin.to_str().unwrap(), &base);
        crate::upstream::bootstrap(&root, &lock).expect("bootstrap");
        let repo = root.join(upstream::CHECKOUT_RELATIVE);
        git(
            &repo,
            &["fetch", "-q", "--no-tags", "origin", "tag", "FIXTURE_2"],
        );
        write_manifest(&root, &base, "  - id: cand\n    series: browser/cand\n");
        let mut candidate = lock.clone();
        candidate.upstream.revision.git = next.clone();

        let report = check_candidate(&root, &lock, &candidate).expect("check runs");
        let results: Vec<_> = report.files.iter().map(|f| f.result).collect();
        assert_eq!(
            results,
            [
                Applicability::Clean,
                Applicability::ThreeWay,
                Applicability::Conflict,
                Applicability::Clean,
            ],
            "got: {report:?}"
        );
        assert_eq!(report.files[2].conflicts, ["b.txt"]);
        assert_eq!(
            (report.clean, report.three_way, report.conflicts),
            (2, 1, 1)
        );
        assert_eq!(report.candidate_sha, next);

        // Read-only: the managed checkout is still the clean locked baseline.
        assert_eq!(git(&repo, &["rev-parse", "HEAD"]), base);
        assert_eq!(git(&repo, &["status", "--porcelain"]), "");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn check_candidate_requires_fetched_candidate() {
        let (root, lock, sha) = baseline("candidate-missing");
        write_manifest(&root, &sha, " []\n");
        let mut candidate = lock.clone();
        candidate.upstream.revision.git = "1".repeat(40);
        let err = check_candidate(&root, &lock, &candidate).expect_err("missing object");
        assert!(err.contains("upstream update --to"), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }
}
