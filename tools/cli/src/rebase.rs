//! Candidate rebase and adoption (UPSTREAM1.md, "Candidate baseline";
//! PATCHING.md, "Rebase Flow").
//!
//! - `start`/`resume`/`abort`: replay the ordered series onto the staged
//!   candidate in `worktree/candidate` (a linked worktree of the managed
//!   checkout), one commit per patch file: exact apply, then 3-way. A
//!   conflict stops for a manual resolution (`--continue`); `--abort`
//!   discards the candidate worktree. Each commit message is the patch
//!   header verbatim plus an `Aequera-Patch:` trailer naming its file, so a
//!   rationale can be amended in place.
//! - `adopt`: turn a finished rebase into the new baseline. Every commit is
//!   exported back to its patch file (header + `git diff`), the exported
//!   series is proven to rebuild the candidate tree exactly, and only then
//!   are the patch files, the manifest base, and firefox.lock rewritten,
//!   `worktree/firefox` moved to the new revision, and the candidate
//!   removed. All checks run before the first write.

use crate::lock::{self, LockFile};
use crate::patch::{self, Applicability, PatchManifest};
use crate::upstream;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Candidate worktree, relative to the repository root.
pub const CANDIDATE_WORKTREE_RELATIVE: &str = "worktree/candidate";

/// Rebase progress, relative to the candidate worktree root.
const STATE_FILE: &str = ".aequera-rebase.json";

/// Last line of every rebase commit message: maps the commit to its file.
const TRAILER: &str = "Aequera-Patch: ";

/// The patch rule's header fields (same list as tools/patch/assemble.py).
const REQUIRED_HEADER_FIELDS: [&str; 6] = [
    "Subject:",
    "Why Firefox source must change:",
    "What it changes",
    "Depends on:",
    "Validation:",
    "Upstream risk:",
];

/// Rebase commits are scaffolding (export ignores authorship): a fixed
/// identity, and the user's signing setup must not block them.
const COMMIT_CONFIG: [&str; 6] = [
    "-c",
    "user.name=Aequera rebase",
    "-c",
    "user.email=rebase@aequera.invalid",
    "-c",
    "commit.gpgsign=false",
];

#[derive(Debug, Serialize, Deserialize)]
struct RebaseState {
    base_sha: String,
    candidate_sha: String,
    /// Repo-relative patch files, series order.
    files: Vec<String>,
    /// Index of the next file to commit.
    next: usize,
    /// `files[next]` is applied (staged, possibly with conflicts) but not
    /// committed yet; the value is how it applied.
    pending: Option<Applicability>,
    /// How each committed file applied.
    results: Vec<Applicability>,
}

#[derive(Debug, Serialize)]
pub struct RebasedFile {
    pub file: String,
    pub result: Applicability,
}

#[derive(Debug, Serialize)]
pub struct RebaseStop {
    pub file: String,
    pub unmerged: Vec<String>,
    pub detail: String,
}

#[derive(Debug, Serialize)]
pub struct RebaseReport {
    pub candidate_sha: String,
    pub worktree_dir: String,
    pub total: usize,
    pub committed: Vec<RebasedFile>,
    pub stopped: Option<RebaseStop>,
    pub done: bool,
    pub overlay_files: usize,
}

#[derive(Debug, Serialize)]
pub struct AbortReport {
    pub worktree_dir: String,
}

#[derive(Debug, Serialize)]
pub struct AdoptReport {
    pub dry_run: bool,
    pub from_version: String,
    pub from_sha: String,
    pub to_version: String,
    pub to_sha: String,
    pub patches_rewritten: Vec<String>,
    pub patches_unchanged: usize,
    pub worktree_dir: String,
    pub entries_applied: usize,
}

/// Start a rebase of the series onto the staged candidate.
pub fn start(root: &Path, lock: &LockFile, candidate: &LockFile) -> Result<RebaseReport, String> {
    let manifest = patch::load_manifest(root, lock)?;
    patch::require_base_matches(&manifest, lock)?;
    let files = series_list(root, &manifest)?;
    let wt = root.join(CANDIDATE_WORKTREE_RELATIVE);
    if lock::substantive_present(&wt) {
        return Err(format!(
            "{} exists: continue the rebase (`aequera patch rebase --continue`) or discard it (`--abort`)",
            wt.display()
        ));
    }
    let repo = checkout_repo(root)?;
    let sha = &candidate.upstream.revision.git;
    if upstream::git(&repo, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_err() {
        return Err(format!(
            "candidate {sha} is not present locally; run `aequera upstream update --to {}`",
            candidate.upstream.resolved_from.ref_name
        ));
    }
    // A worktree directory deleted by hand stays registered and blocks
    // `worktree add` on the same path: drop such stale records first.
    upstream::git(&repo, &["worktree", "prune"])?;
    std::fs::create_dir_all(&wt).map_err(|e| format!("{}: {e}", wt.display()))?;
    let marker = wt.join(".gitkeep");
    if marker.is_file() {
        std::fs::remove_file(&marker).map_err(|e| format!("{}: {e}", marker.display()))?;
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

    let state = RebaseState {
        base_sha: lock.upstream.revision.git.clone(),
        candidate_sha: sha.clone(),
        files,
        next: 0,
        pending: None,
        results: Vec::new(),
    };
    write_state(&wt, &state)?;
    run(root, &manifest, &wt, state)
}

/// Commit the resolved file and replay the rest of the series.
pub fn resume(root: &Path, lock: &LockFile, candidate: &LockFile) -> Result<RebaseReport, String> {
    let manifest = patch::load_manifest(root, lock)?;
    patch::require_base_matches(&manifest, lock)?;
    let wt = root.join(CANDIDATE_WORKTREE_RELATIVE);
    let mut state = load_state(root, lock, candidate, &manifest, &wt)?;
    if let Some(result) = state.pending {
        let unmerged = unmerged_paths(&wt)?;
        if !unmerged.is_empty() {
            return Err(format!(
                "unresolved conflicts in {}: {}; edit them, `git add` them, then run `aequera patch rebase --continue`",
                wt.display(),
                unmerged.join(", ")
            ));
        }
        commit(root, &wt, &state.files[state.next])?;
        state.results.push(result);
        state.next += 1;
        state.pending = None;
        write_state(&wt, &state)?;
    }
    run(root, &manifest, &wt, state)
}

/// Discard the candidate worktree (and any conflict resolutions in it).
/// The candidate lock stays staged.
pub fn abort(root: &Path) -> Result<AbortReport, String> {
    let wt = root.join(CANDIDATE_WORKTREE_RELATIVE);
    if !lock::substantive_present(&wt) {
        return Err(format!("no candidate worktree at {}", wt.display()));
    }
    let repo = checkout_repo(root)?;
    // `worktree remove` refuses a directory that is not one of this
    // repository's worktrees, so nothing else can be deleted here.
    upstream::git(
        &repo,
        &["worktree", "remove", "--force", &wt.display().to_string()],
    )?;
    upstream::git(&repo, &["worktree", "prune"])?;
    Ok(AbortReport {
        worktree_dir: wt.display().to_string(),
    })
}

/// Apply and commit from `state.next` on; stop at the first conflict.
fn run(
    root: &Path,
    manifest: &PatchManifest,
    wt: &Path,
    mut state: RebaseState,
) -> Result<RebaseReport, String> {
    while state.next < state.files.len() {
        let rel = state.files[state.next].clone();
        let patch_path = root.join(&rel).display().to_string();
        let applied = if upstream::git(wt, &["apply", "--index", &patch_path]).is_ok() {
            Ok(Applicability::Clean)
        } else {
            upstream::git(wt, &["apply", "--index", "-3", &patch_path])
                .map(|_| Applicability::ThreeWay)
        };
        match applied {
            Ok(result) => {
                // Recorded before committing: if the commit fails, the
                // staged change is committed by `--continue`, never re-applied.
                state.pending = Some(result);
                write_state(wt, &state)?;
                commit(root, wt, &rel)?;
                state.results.push(result);
                state.next += 1;
                state.pending = None;
                write_state(wt, &state)?;
            }
            Err(detail) => {
                state.pending = Some(Applicability::Conflict);
                write_state(wt, &state)?;
                let unmerged = unmerged_paths(wt)?;
                let stop = RebaseStop {
                    file: rel,
                    unmerged,
                    detail,
                };
                return Ok(report(wt, &state, Some(stop), 0));
            }
        }
    }
    // Done: make the candidate buildable like worktree/firefox.
    for overlay in &manifest.overlays {
        patch::validate_overlay(root, wt, overlay)?;
    }
    let overlay_files = patch::sync_overlays(root, wt, manifest)?;
    Ok(report(wt, &state, None, overlay_files))
}

fn report(
    wt: &Path,
    state: &RebaseState,
    stopped: Option<RebaseStop>,
    overlay_files: usize,
) -> RebaseReport {
    RebaseReport {
        candidate_sha: state.candidate_sha.clone(),
        worktree_dir: wt.display().to_string(),
        total: state.files.len(),
        committed: state
            .files
            .iter()
            .zip(&state.results)
            .map(|(file, result)| RebasedFile {
                file: file.clone(),
                result: *result,
            })
            .collect(),
        done: stopped.is_none() && state.next == state.files.len(),
        stopped,
        overlay_files,
    }
}

/// Commit the staged change for `rel` with its patch header as message.
fn commit(root: &Path, wt: &Path, rel: &str) -> Result<(), String> {
    if upstream::git(wt, &["diff", "--cached", "--quiet"]).is_ok() {
        return Err(format!(
            "{rel} leaves no change on the candidate (already upstream?); remove it from the series, then `--abort` and start again"
        ));
    }
    let staged = upstream::git_bytes(wt, &["diff", "--cached"])?;
    if has_conflict_markers(&staged) {
        return Err(format!(
            "the staged change for {rel} still contains conflict markers; finish the resolution, `git add`, then `--continue`"
        ));
    }
    let header = read_header(&root.join(rel), rel)?;
    let body = header
        .strip_prefix("Subject: ")
        .ok_or_else(|| format!("{rel}: header must start with \"Subject: \""))?;
    let message = format!("{body}{TRAILER}{rel}\n");
    let mut args: Vec<&str> = COMMIT_CONFIG.to_vec();
    args.extend([
        "commit",
        "--no-verify",
        "--cleanup=verbatim",
        "--quiet",
        "-F",
        "-",
    ]);
    upstream::git_with_input(wt, &args, message.as_bytes()).map(|_| ())
}

/// Turn a finished rebase into the new baseline (see module docs).
/// `dry_run` runs every check, including the export proof, and returns
/// the report without writing anything.
pub fn adopt(
    root: &Path,
    lock: &LockFile,
    candidate: &LockFile,
    dry_run: bool,
) -> Result<AdoptReport, String> {
    let manifest = patch::load_manifest(root, lock)?;
    patch::require_base_matches(&manifest, lock)?;
    let wt = root.join(CANDIDATE_WORKTREE_RELATIVE);
    let state = load_state(root, lock, candidate, &manifest, &wt)?;
    if state.pending.is_some() || state.next != state.files.len() {
        return Err(format!(
            "the rebase is not finished ({}/{} committed); run `aequera patch rebase --continue`",
            state.next,
            state.files.len()
        ));
    }
    let dirty = upstream::git(&wt, &["status", "--porcelain", "--untracked-files=no"])?;
    if !dirty.is_empty() {
        return Err(format!(
            "{} has uncommitted tracked changes; commit them into the right patch (`git commit --amend` on its commit) or revert them:\n{dirty}",
            wt.display()
        ));
    }

    // 1. Export every commit to its patch text (memory only).
    let exported = export(root, &wt, &state)?;

    // 2. Prove the exported series rebuilds the candidate tree exactly.
    let repo = checkout_repo(root)?;
    let expected = upstream::git(&wt, &["rev-parse", "HEAD^{tree}"])?;
    verify_export(&repo, &state.candidate_sha, &exported, &expected)?;

    // 3. worktree/firefox must hold nothing but generated state.
    let ff = root.join(patch::WORKTREE_RELATIVE);
    let ff_present = lock::substantive_present(&ff);
    if ff_present {
        require_generated_only(root, &ff, lock, &manifest)?;
    }

    // 4. New manifest and lock text, parsed and checked before writing.
    let manifest_path = root.join(&lock.patchset.manifest);
    let manifest_text = read_text(&manifest_path)?;
    let new_manifest = rewrite_manifest_base(&manifest_text, &manifest, candidate)?;
    let lock_path = root.join(lock::LOCK_RELATIVE);
    let new_lock = rewrite_lock(&read_text(&lock_path)?, lock, candidate)?;

    let rewritten: Vec<String> = exported
        .iter()
        .filter(|e| e.changed)
        .map(|e| e.rel.clone())
        .collect();
    let mut report = AdoptReport {
        dry_run,
        from_version: lock.upstream.version.clone(),
        from_sha: lock.upstream.revision.git.clone(),
        to_version: candidate.upstream.version.clone(),
        to_sha: candidate.upstream.revision.git.clone(),
        patches_unchanged: exported.len() - rewritten.len(),
        patches_rewritten: rewritten,
        worktree_dir: ff.display().to_string(),
        entries_applied: 0,
    };
    if dry_run {
        return Ok(report);
    }

    // 5. Writes: patch files, manifest, lock, then drop the candidate lock.
    for e in exported.iter().filter(|e| e.changed) {
        write_atomic(&root.join(&e.rel), &e.text)?;
    }
    write_atomic(&manifest_path, new_manifest.as_bytes())?;
    write_atomic(&lock_path, new_lock.as_bytes())?;
    let candidate_path = root.join(lock::CANDIDATE_RELATIVE);
    std::fs::remove_file(&candidate_path)
        .map_err(|e| format!("{}: {e}", candidate_path.display()))?;

    // 6. Move worktree/firefox onto the new baseline and apply the series.
    let adopted = lock::load(root)?;
    if ff_present {
        upstream::git(&ff, &["reset", "--quiet", "--hard", &state.candidate_sha])?;
        let applied_state = ff.join(patch::STATE_FILE);
        if applied_state.exists() {
            std::fs::remove_file(&applied_state)
                .map_err(|e| format!("{}: {e}", applied_state.display()))?;
        }
    }
    let applied = patch::apply(root, &adopted).map_err(|e| {
        format!("baseline files are rewritten (review with `git diff`), but applying the new series failed: {e}")
    })?;

    // 7. The candidate is now the baseline: its worktree is redundant.
    upstream::git(
        &repo,
        &["worktree", "remove", "--force", &wt.display().to_string()],
    )?;

    report.worktree_dir = applied.worktree_dir;
    report.entries_applied = applied.entries_applied;
    Ok(report)
}

struct Exported {
    rel: String,
    text: Vec<u8>,
    changed: bool,
}

/// One patch text per rebase commit: header from the commit message,
/// diff regenerated with git's defaults pinned (no user diff config).
fn export(root: &Path, wt: &Path, state: &RebaseState) -> Result<Vec<Exported>, String> {
    let range = format!("{}..HEAD", state.candidate_sha);
    let commits = upstream::git(wt, &["rev-list", "--reverse", &range])?;
    let commits: Vec<&str> = commits.lines().filter(|l| !l.is_empty()).collect();
    if commits.len() != state.files.len() {
        return Err(format!(
            "{} holds {} commits on the candidate, the series has {} files; one commit per patch file is required",
            wt.display(),
            commits.len(),
            state.files.len()
        ));
    }
    let mut out = Vec::new();
    for (commit, rel) in commits.iter().zip(&state.files) {
        let raw = upstream::git_bytes(wt, &["cat-file", "commit", commit])?;
        let raw =
            String::from_utf8(raw).map_err(|_| format!("commit {commit}: message is not UTF-8"))?;
        let message = raw
            .split_once("\n\n")
            .map(|(_, m)| m)
            .ok_or_else(|| format!("commit {commit}: no message"))?;
        let body = message
            .strip_suffix(&format!("{TRAILER}{rel}\n"))
            .ok_or_else(|| {
                format!(
                    "commit {commit}: last line must be `{TRAILER}{rel}` (commits must stay in series order, one per file)"
                )
            })?;
        let mut header = format!("Subject: {}", body.trim_end_matches('\n'));
        header.push_str("\n\n");
        let missing: Vec<&str> = REQUIRED_HEADER_FIELDS
            .iter()
            .copied()
            .filter(|f| !header.lines().any(|l| l.starts_with(f)))
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "commit {commit} ({rel}): header misses patch-rule fields {missing:?}"
            ));
        }
        let parent = format!("{commit}^");
        let diff = upstream::git_bytes(
            wt,
            &[
                "-c",
                "diff.noprefix=false",
                "-c",
                "diff.mnemonicPrefix=false",
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--no-relative",
                "--diff-algorithm=myers",
                "--indent-heuristic",
                "--unified=3",
                "--abbrev=12",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                &parent,
                commit,
            ],
        )?;
        if !diff.starts_with(b"diff --git ") {
            return Err(format!("commit {commit} ({rel}): empty diff"));
        }
        let mut text = header.into_bytes();
        text.extend_from_slice(&diff);
        let changed = std::fs::read(root.join(rel))
            .map(|old| old != text)
            .unwrap_or(true);
        out.push(Exported {
            rel: rel.clone(),
            text,
            changed,
        });
    }
    Ok(out)
}

/// Apply the exported texts in order to a scratch index seeded from the
/// candidate; the result must be exactly the rebased tree.
fn verify_export(
    repo: &Path,
    candidate_sha: &str,
    exported: &[Exported],
    expected_tree: &str,
) -> Result<(), String> {
    let dir = ScratchDir::create()?;
    let index = patch::ScratchIndex::seeded(repo, candidate_sha)?;
    for (i, e) in exported.iter().enumerate() {
        let path = dir.0.join(format!("{i:04}.patch"));
        std::fs::write(&path, &e.text).map_err(|err| format!("{}: {err}", path.display()))?;
        index
            .apply(repo, &path)
            .map_err(|err| format!("exported {} does not apply: {err}", e.rel))?;
    }
    let tree = index.write_tree(repo)?;
    if tree != expected_tree {
        return Err(format!(
            "exported series builds tree {tree}, the rebased candidate is {expected_tree}; refusing to adopt"
        ));
    }
    Ok(())
}

/// worktree/firefox may be moved only if every tracked difference from
/// its locked base is the series itself (or there is none).
fn require_generated_only(
    root: &Path,
    ff: &Path,
    lock: &LockFile,
    manifest: &PatchManifest,
) -> Result<(), String> {
    let head = upstream::git(ff, &["rev-parse", "HEAD"])?;
    if head != lock.upstream.revision.git {
        return Err(format!(
            "{} is at {head}, not the lock; fix or delete it before adopting",
            ff.display()
        ));
    }
    if upstream::git(ff, &["diff", "--quiet", "HEAD", "--"]).is_ok() {
        return Ok(());
    }
    patch::verify_worktree_matches_series(root, ff, manifest).map_err(|_| {
        format!(
            "{} has tracked edits beyond base + series; promote them into a patch or discard them before adopting",
            ff.display()
        )
    })
}

/// New manifest text: only `version`/`revision` inside the `base:` block.
fn rewrite_manifest_base(
    text: &str,
    manifest: &PatchManifest,
    candidate: &LockFile,
) -> Result<String, String> {
    let start = text
        .find("\nbase:\n")
        .ok_or("manifest: no top-level `base:` block")?
        + 1;
    // The block ends at the next top-level key (unindented, not a comment).
    let mut end = text.len();
    let mut pos = start;
    for (i, line) in text[start..].split_inclusive('\n').enumerate() {
        let first = line.chars().next().unwrap_or(' ');
        if i > 0 && !first.is_whitespace() && first != '#' {
            end = pos;
            break;
        }
        pos += line.len();
    }
    let old = &manifest.base.upstream;
    let new = &candidate.upstream;
    let mut block = text[start..end].to_string();
    block = replace_once(
        &block,
        &format!("version: \"{}\"", old.version),
        &format!("version: \"{}\"", new.version),
        "manifest base",
    )?;
    block = replace_once(
        &block,
        &format!("revision: \"{}\"", old.revision),
        &format!("revision: \"{}\"", new.revision.git),
        "manifest base",
    )?;
    let out = format!("{}{block}{}", &text[..start], &text[end..]);
    let parsed: PatchManifest =
        serde_yaml::from_str(&out).map_err(|e| format!("rewritten manifest: {e}"))?;
    if parsed.base.upstream.revision != new.revision.git
        || parsed.base.upstream.version != new.version
        || parsed.patches.len() != manifest.patches.len()
    {
        return Err("rewritten manifest does not describe the candidate base".into());
    }
    Ok(out)
}

/// New lock text: the candidate's version, SHA, ref, and pin date, with
/// the committed layout and comments kept.
fn rewrite_lock(text: &str, lock: &LockFile, candidate: &LockFile) -> Result<String, String> {
    let (old, new) = (&lock.upstream, &candidate.upstream);
    if old.resolved_from.kind != "tag" || new.resolved_from.kind != "tag" {
        return Err("lock rewrite supports tag provenance only".into());
    }
    let mut out = replace_once(
        text,
        &format!("version: \"{}\"", old.version),
        &format!("version: \"{}\"", new.version),
        "firefox.lock",
    )?;
    out = replace_once(
        &out,
        &format!("git: \"{}\"", old.revision.git),
        &format!("git: \"{}\"", new.revision.git),
        "firefox.lock",
    )?;
    out = replace_once(
        &out,
        &format!("ref: {}\n", old.resolved_from.ref_name),
        &format!("ref: {}\n", new.resolved_from.ref_name),
        "firefox.lock",
    )?;
    match (&old.pinned_at, &new.pinned_at) {
        (Some(o), Some(n)) => {
            out = replace_once(
                &out,
                &format!("pinned_at: {o}\n"),
                &format!("pinned_at: {n}\n"),
                "firefox.lock",
            )?;
        }
        _ => return Err("lock and candidate must both carry pinned_at".into()),
    }
    let parsed: LockFile =
        serde_yaml::from_str(&out).map_err(|e| format!("rewritten lock: {e}"))?;
    let p = &parsed.upstream;
    if p.revision.git != new.revision.git
        || p.version != new.version
        || p.resolved_from.ref_name != new.resolved_from.ref_name
        || p.pinned_at != new.pinned_at
        || p.repository.url != old.repository.url
        || p.channel != old.channel
    {
        return Err("rewritten lock does not describe the candidate".into());
    }
    Ok(out)
}

fn replace_once(text: &str, from: &str, to: &str, what: &str) -> Result<String, String> {
    match text.matches(from).count() {
        1 => Ok(text.replacen(from, to, 1)),
        n => Err(format!(
            "{what}: expected exactly one `{from}`, found {n}; edit it by hand"
        )),
    }
}

/// Repo-relative patch files of the manifest's series, in apply order,
/// '/'-separated on every platform (stored in state and commit trailers).
fn series_list(root: &Path, manifest: &PatchManifest) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    for entry in &manifest.patches {
        for f in patch::series_files(root, entry)? {
            let rel = f
                .strip_prefix(root)
                .map_err(|_| format!("{} is outside the repository", f.display()))?;
            let parts: Vec<String> = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            files.push(parts.join("/"));
        }
    }
    Ok(files)
}

/// Load the rebase state and prove it still matches the lock, the
/// candidate, the manifest's series, and the worktree's history.
fn load_state(
    root: &Path,
    lock: &LockFile,
    candidate: &LockFile,
    manifest: &PatchManifest,
    wt: &Path,
) -> Result<RebaseState, String> {
    let path = wt.join(STATE_FILE);
    let text = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "no rebase in progress ({}: {e}); start one with `aequera patch rebase`",
            path.display()
        )
    })?;
    let state: RebaseState = serde_json::from_str(&text)
        .map_err(|e| format!("{}: invalid state: {e}", path.display()))?;
    if state.base_sha != lock.upstream.revision.git
        || state.candidate_sha != candidate.upstream.revision.git
    {
        return Err(format!(
            "the rebase in {} was started for another lock/candidate pair; `--abort` and start again",
            wt.display()
        ));
    }
    if state.files != series_list(root, manifest)? {
        return Err(
            "the manifest's series changed since the rebase started; `--abort` and start again"
                .into(),
        );
    }
    if state.next > state.files.len() || state.results.len() != state.next {
        return Err(format!("{}: inconsistent state", path.display()));
    }
    let count = upstream::git(
        wt,
        &[
            "rev-list",
            "--count",
            &format!("{}..HEAD", state.candidate_sha),
        ],
    )?;
    let count: usize = count
        .parse()
        .map_err(|_| "rev-list --count: not a number")?;
    if count != state.next {
        let hint = if state.pending.is_some() && count == state.next + 1 {
            " (the resolution was committed by hand: `git reset --soft HEAD~1` in the candidate worktree, then `--continue`)"
        } else {
            ""
        };
        return Err(format!(
            "{} has {count} rebase commits, the state expects {}{hint}",
            wt.display(),
            state.next
        ));
    }
    Ok(state)
}

fn write_state(wt: &Path, state: &RebaseState) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state).map_err(|e| format!("state: {e}"))?;
    write_atomic(&wt.join(STATE_FILE), text.as_bytes())
}

/// Text before the first `diff --git` line: the patch-rule header.
fn read_header(path: &Path, rel: &str) -> Result<String, String> {
    let text = read_text(path)?;
    let at = text
        .find("\ndiff --git ")
        .ok_or_else(|| format!("{rel}: no `diff --git` line"))?;
    Ok(text[..=at].to_string())
}

fn read_text(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn unmerged_paths(wt: &Path) -> Result<Vec<String>, String> {
    let out = upstream::git(wt, &["diff", "--name-only", "--diff-filter=U"])?;
    Ok(out.lines().map(String::from).collect())
}

/// Added lines that are conflict markers (`git apply -3` style).
fn has_conflict_markers(diff: &[u8]) -> bool {
    diff.split(|b| *b == b'\n').any(|line| {
        line.starts_with(b"+<<<<<<< ")
            || line.starts_with(b"+>>>>>>> ")
            || line.starts_with(b"+||||||| ")
            || line == b"+======="
    })
}

fn checkout_repo(root: &Path) -> Result<PathBuf, String> {
    let repo = root.join(upstream::CHECKOUT_RELATIVE);
    if !repo.join(".git").exists() {
        return Err(format!(
            "no managed checkout at {}; run `aequera bootstrap` first",
            repo.display()
        ));
    }
    Ok(repo)
}

/// Temp+rename in the target's directory: no half-written file on crash.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}", std::process::id()));
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Exclusively created temp directory, removed on drop.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn create() -> Result<Self, String> {
        for attempt in 0..100 {
            let path = std::env::temp_dir().join(format!(
                "aequera-adopt-{}-{}-{attempt}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or_default(),
            ));
            // create_dir fails on an existing path (or planted symlink).
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("could not create scratch dir: {e}")),
            }
        }
        Err("could not create unique scratch dir after 100 attempts".into())
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn scratch(name: &str) -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "aequera-rebase-test-{}-{}-{}",
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

    fn lines(prefix: &str) -> String {
        (1..=10).map(|i| format!("{prefix}{i}\n")).collect()
    }

    fn header(subject: &str) -> String {
        format!(
            "Subject: [PATCH] {subject}\n\
             Why Firefox source must change:\n  fixture.\n\
             What it changes:\n  - fixture.\n\
             Depends on: nothing.\n\
             Validation: unit test.\n\
             Upstream risk: low.\n\n"
        )
    }

    fn lock_text(url: &str, sha: &str, version: &str, tag: &str) -> String {
        format!(
            "# fixture lock\n\nschema_version: 1\n\nupstream:\n  name: firefox\n  repository:\n    type: git\n    url: {url}\n\n  channel: test\n  version: \"{version}\"\n\n  revision:\n    git: \"{sha}\"\n\n  resolved_from:\n    type: tag\n    ref: {tag}\n\n  pinned_at: 2026-01-01\n\npatchset:\n  manifest: patches/manifest.yaml\n  version: 0\n"
        )
    }

    struct Fixture {
        root: PathBuf,
        lock: LockFile,
        candidate: LockFile,
        base: String,
        next: String,
    }

    /// Repo root with lock, manifest (one series + one overlay), the
    /// series' patch files, a fetched candidate, and its candidate.lock.
    /// `edits` are (patch name, file, new content) on the base; `upstream`
    /// are the candidate's (file, content) changes.
    fn fixture(name: &str, edits: &[(&str, &str, &str)], upstream: &[(&str, &str)]) -> Fixture {
        let root = scratch(name);
        let origin = root.join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "-q"]);
        std::fs::write(origin.join("a.txt"), lines("a")).unwrap();
        std::fs::write(origin.join("b.txt"), "b\n").unwrap();
        std::fs::write(origin.join("c.txt"), "c\n").unwrap();
        git(&origin, &["add", "."]);
        git(&origin, &["commit", "-q", "-m", "base"]);
        git(&origin, &["tag", "FIXTURE_1"]);
        let base = git(&origin, &["rev-parse", "HEAD"]);

        let series = root.join("patches/browser/one");
        std::fs::create_dir_all(&series).unwrap();
        for (patch_name, file, content) in edits {
            std::fs::write(origin.join(file), content).unwrap();
            // Committed patches carry 12-char index abbreviations.
            let diff = git(&origin, &["diff", "--abbrev=12"]);
            let text = format!("{}{diff}\n", header(patch_name));
            std::fs::write(series.join(patch_name), text).unwrap();
            git(&origin, &["add", "."]);
        }
        git(&origin, &["reset", "-q", "--hard", &base]);
        for (file, content) in upstream {
            std::fs::write(origin.join(file), content).unwrap();
        }
        git(&origin, &["commit", "-q", "-am", "candidate"]);
        git(&origin, &["tag", "FIXTURE_2"]);
        let next = git(&origin, &["rev-parse", "HEAD"]);

        let url = origin.to_str().unwrap();
        std::fs::create_dir_all(root.join("upstream/manifests")).unwrap();
        std::fs::write(
            root.join(lock::LOCK_RELATIVE),
            lock_text(url, &base, "0", "FIXTURE_1"),
        )
        .unwrap();
        std::fs::write(
            root.join("patches/manifest.yaml"),
            format!(
                "# fixture manifest\nmanifest_version: 1\n\nbase:\n  upstream:\n    channel: test\n    version: \"0\"\n    revision: \"{base}\"\n\npatches:\n  - id: one\n    series: browser/one\n\noverlays:\n  - id: shell\n    source: aequera/shell/firefox\n    dest: browser/aequera\n"
            ),
        )
        .unwrap();
        let overlay = root.join("aequera/shell/firefox");
        std::fs::create_dir_all(&overlay).unwrap();
        std::fs::write(overlay.join("x.css"), "x\n").unwrap();

        let lock = lock::load(&root).unwrap();
        upstream::bootstrap(&root, &lock).expect("bootstrap");
        let repo = root.join(upstream::CHECKOUT_RELATIVE);
        git(
            &repo,
            &["fetch", "-q", "--no-tags", "origin", "tag", "FIXTURE_2"],
        );
        let mut candidate = lock.clone();
        candidate.upstream.version = "1".into();
        candidate.upstream.revision.git = next.clone();
        candidate.upstream.resolved_from.ref_name = "FIXTURE_2".into();
        candidate.upstream.pinned_at = Some("2026-02-02".into());
        upstream::write_candidate(&root, &candidate).unwrap();
        let candidate = lock::load_candidate(&root, &lock).unwrap().unwrap();
        Fixture {
            root,
            lock,
            candidate,
            base,
            next,
        }
    }

    #[test]
    fn rebase_and_adopt_move_the_baseline() {
        let a5 = lines("a").replace("a5\n", "A5\n");
        let f = fixture(
            "adopt",
            &[
                ("0001-c.patch", "c.txt", "c\none\n"),
                ("0002-a.patch", "a.txt", &a5),
            ],
            // a2 is context for 0002: exact apply fails, 3-way succeeds.
            &[("a.txt", &lines("a").replace("a2\n", "X2\n"))],
        );
        let root = &f.root;
        let p1 = root.join("patches/browser/one/0001-c.patch");
        let p1_before = std::fs::read(&p1).unwrap();
        // worktree/firefox on the old baseline, series applied.
        patch::apply(root, &f.lock).expect("apply on old base");

        let report = start(root, &f.lock, &f.candidate).expect("rebase");
        assert!(report.done, "got: {report:?}");
        let results: Vec<_> = report.committed.iter().map(|c| c.result).collect();
        assert_eq!(results, [Applicability::Clean, Applicability::ThreeWay]);
        let cand_wt = root.join(CANDIDATE_WORKTREE_RELATIVE);
        assert!(
            cand_wt.join("browser/aequera/x.css").is_file(),
            "overlay synced"
        );
        let msg = git(&cand_wt, &["log", "-1", "--format=%B"]);
        assert!(msg.starts_with("[PATCH] 0002-a.patch\n"), "got: {msg}");
        assert!(msg.ends_with("Aequera-Patch: patches/browser/one/0002-a.patch"));

        // Dry run: same verdict, nothing written.
        let preview = adopt(root, &f.lock, &f.candidate, true).expect("dry run");
        assert!(preview.dry_run);
        assert_eq!(
            preview.patches_rewritten,
            ["patches/browser/one/0002-a.patch"]
        );
        assert_eq!(lock::load(root).unwrap().upstream.revision.git, f.base);
        assert!(root.join(lock::CANDIDATE_RELATIVE).exists());
        assert!(cand_wt.exists());

        let adopted = adopt(root, &f.lock, &f.candidate, false).expect("adopt");
        assert_eq!(
            adopted.patches_rewritten,
            ["patches/browser/one/0002-a.patch"]
        );
        assert_eq!(adopted.patches_unchanged, 1);
        // Untouched upstream file: the export is byte-identical.
        assert_eq!(std::fs::read(&p1).unwrap(), p1_before);

        let lock = lock::load(root).unwrap();
        assert_eq!(lock.upstream.revision.git, f.next);
        assert_eq!(lock.upstream.version, "1");
        assert_eq!(lock.upstream.resolved_from.ref_name, "FIXTURE_2");
        assert_eq!(lock.upstream.pinned_at.as_deref(), Some("2026-02-02"));
        let lock_text = std::fs::read_to_string(root.join(lock::LOCK_RELATIVE)).unwrap();
        assert!(lock_text.starts_with("# fixture lock\n"), "comments kept");
        let manifest = patch::load_manifest(root, &lock).unwrap();
        assert_eq!(manifest.base.upstream.revision, f.next);
        assert_eq!(manifest.base.upstream.version, "1");
        assert!(!root.join(lock::CANDIDATE_RELATIVE).exists());
        assert!(!cand_wt.exists(), "candidate worktree removed");

        // worktree/firefox moved: new base + rewritten series, verified.
        let ff = root.join(patch::WORKTREE_RELATIVE);
        assert_eq!(git(&ff, &["rev-parse", "HEAD"]), f.next);
        let a = std::fs::read_to_string(ff.join("a.txt")).unwrap();
        assert!(a.contains("X2\n") && a.contains("A5\n"), "got: {a}");
        let st = patch::status(root, &lock).unwrap();
        assert_eq!(st.applied_state_matches, Some(true));
        assert!(patch::check(root, &lock).unwrap().all_clean);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn conflict_stops_and_continue_commits_the_resolution() {
        let f = fixture(
            "conflict",
            &[("0001-b.patch", "b.txt", "ours\n")],
            &[("b.txt", "theirs\n")],
        );
        let root = &f.root;
        let cand_wt = root.join(CANDIDATE_WORKTREE_RELATIVE);
        patch::apply(root, &f.lock).expect("apply on old base");

        let report = start(root, &f.lock, &f.candidate).expect("rebase runs");
        assert!(!report.done);
        let stop = report.stopped.expect("stopped");
        assert_eq!(stop.unmerged, ["b.txt"]);
        let err = adopt(root, &f.lock, &f.candidate, false).expect_err("not finished");
        assert!(err.contains("not finished"), "got: {err}");
        let err = resume(root, &f.lock, &f.candidate).expect_err("unresolved");
        assert!(err.contains("unresolved conflicts"), "got: {err}");

        // Abort, then a fresh start reaches the same stop.
        abort(root).expect("abort");
        assert!(!cand_wt.exists());
        let again = start(root, &f.lock, &f.candidate).expect("restart");
        assert!(again.stopped.is_some());

        // Staged leftovers of the conflict are refused.
        std::fs::write(
            cand_wt.join("b.txt"),
            "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n",
        )
        .unwrap();
        git(&cand_wt, &["add", "b.txt"]);
        let err = resume(root, &f.lock, &f.candidate).expect_err("markers");
        assert!(err.contains("conflict markers"), "got: {err}");

        std::fs::write(cand_wt.join("b.txt"), "resolved\n").unwrap();
        git(&cand_wt, &["add", "b.txt"]);
        let done = resume(root, &f.lock, &f.candidate).expect("continue");
        assert!(done.done, "got: {done:?}");
        assert_eq!(done.committed[0].result, Applicability::Conflict);

        // A hand edit in worktree/firefox blocks adoption...
        let ff = root.join(patch::WORKTREE_RELATIVE);
        std::fs::write(ff.join("c.txt"), "hand edit\n").unwrap();
        let err = adopt(root, &f.lock, &f.candidate, false).expect_err("hand edit");
        assert!(err.contains("tracked edits"), "got: {err}");
        // ...a pristine base (series not applied) does not.
        git(&ff, &["checkout", "--", "."]);
        adopt(root, &f.lock, &f.candidate, false).expect("adopt");
        let patch_text =
            std::fs::read_to_string(root.join("patches/browser/one/0001-b.patch")).unwrap();
        assert!(
            patch_text.contains("\n-theirs\n+resolved\n"),
            "got: {patch_text}"
        );
        assert!(patch_text.starts_with("Subject: [PATCH] 0001-b.patch\n"));
        assert_eq!(
            std::fs::read_to_string(ff.join("b.txt")).unwrap(),
            "resolved\n"
        );
        let _ = &f.base;
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn manifest_rewrite_touches_only_the_base_block() {
        let text = "# c\nmanifest_version: 1\n\nbase:\n  upstream:\n    channel: release\n    version: \"156.0\"\n    revision: \"aaaa\"\n\npatches:\n  - id: x\n    series: browser/x\n";
        let manifest: PatchManifest = serde_yaml::from_str(text).unwrap();
        let mut cand: LockFile =
            serde_yaml::from_str(&lock_text("/o", "bbbb", "157.0.1", "T")).unwrap();
        cand.upstream.revision.git = "bbbb".into();
        let out = rewrite_manifest_base(text, &manifest, &cand).unwrap();
        assert_eq!(
            out,
            text.replace("\"156.0\"", "\"157.0.1\"")
                .replace("\"aaaa\"", "\"bbbb\"")
        );
    }

    #[test]
    fn conflict_marker_detection_reads_added_lines_only() {
        assert!(has_conflict_markers(b"@@ -1 +1 @@\n+<<<<<<< ours\n+x\n"));
        assert!(has_conflict_markers(b"+=======\n"));
        assert!(!has_conflict_markers(
            b" <<<<<<< context\n-=======\n+=========\n"
        ));
    }
}
