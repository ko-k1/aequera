//! Managed acquisition of the pinned Firefox source.
//!
//! `fetch` downloads Git objects for the lock's provenance ref and proves
//! they resolve to the locked SHA. It never moves the baseline, never edits
//! the lock, never checks anything out. See UPSTREAM.md ("Fetch vs Update").

use crate::lock::{self, LockFile};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Managed checkout location, relative to the repository root.
pub const CHECKOUT_RELATIVE: &str = "upstream/firefox";

/// Skeleton placeholder the tooling is allowed to claim inside managed dirs.
const PLACEHOLDER: &str = ".gitkeep";

#[derive(Debug, Serialize)]
pub struct FetchReport {
    pub remote_url: String,
    pub fetched_ref: String,
    pub resolved_sha: String,
    pub lock_sha: String,
    pub matches_lock: bool,
    pub checkout_dir: String,
}

/// Ensure the managed checkout exists as a Git repo bound to the lock's
/// remote. A fresh skeleton directory (placeholder only) is claimed;
/// anything else unexpected stops the operation.
pub fn ensure_repo(root: &Path, lock: &LockFile) -> Result<PathBuf, String> {
    validate_remote_url(&lock.upstream.repository.url)?;
    let dir = root.join(CHECKOUT_RELATIVE);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    claim_placeholders(&dir)?;

    if !dir.join(".git").exists() {
        git(&dir, &["init"])?;
        git(
            &dir,
            &["remote", "add", "origin", &lock.upstream.repository.url],
        )?;
    }
    let actual = git(&dir, &["remote", "get-url", "origin"])?;
    if actual.trim() != lock.upstream.repository.url {
        return Err(format!(
            "unexpected remote for {}: got {:?}, lock requires {:?}; refusing to fetch",
            dir.display(),
            actual.trim(),
            lock.upstream.repository.url
        ));
    }
    Ok(dir)
}

/// Fetch the lock's provenance ref and verify it resolves to the locked SHA.
pub fn fetch(root: &Path, lock: &LockFile) -> Result<FetchReport, String> {
    let dir = ensure_repo(root, lock)?;
    let provenance = &lock.upstream.resolved_from;
    validate_ref_name(&provenance.ref_name)?;

    // Fetch exactly the provenance ref — never a branch tip.
    match provenance.kind.as_str() {
        "tag" => {
            git(
                &dir,
                &["fetch", "--no-tags", "origin", "tag", &provenance.ref_name],
            )?;
        }
        other => {
            return Err(format!(
                "unsupported resolved_from type {other:?} (this slice supports tag)"
            ));
        }
    }

    let resolved = git(
        &dir,
        &["rev-parse", &format!("{}^{{commit}}", provenance.ref_name)],
    )?;
    let resolved = resolved.trim().to_string();
    if resolved != lock.upstream.revision.git {
        return Err(format!(
            "provenance drift: {} resolves to {resolved} but the lock pins {}; refusing to continue",
            provenance.ref_name, lock.upstream.revision.git
        ));
    }

    Ok(FetchReport {
        remote_url: lock.upstream.repository.url.clone(),
        fetched_ref: format!("{}:{}", provenance.kind, provenance.ref_name),
        resolved_sha: resolved,
        lock_sha: lock.upstream.revision.git.clone(),
        matches_lock: true,
        checkout_dir: dir.display().to_string(),
    })
}

#[derive(Debug, Serialize)]
pub struct CheckoutReport {
    pub target: String,
    pub resolved_sha: String,
    pub head_sha: String,
    pub detached: bool,
    pub checkout_dir: String,
}

#[derive(Debug, Serialize)]
pub struct VerifyReport {
    pub remote_url: String,
    pub remote_ok: bool,
    pub revision_exists: bool,
    pub head_sha: Option<String>,
    pub head_matches: bool,
    pub tree_clean: bool,
    pub verified: bool,
}

#[derive(Debug, Serialize)]
pub struct BootstrapReport {
    pub fetch: FetchReport,
    pub checkout: CheckoutReport,
    pub verify: VerifyReport,
}

/// Materialize the locked baseline as a detached checkout.
///
/// The target may be the lock's channel name or the locked SHA itself —
/// nothing else. Adopting a *new* revision is `update` (a later slice),
/// never a casual checkout argument.
pub fn checkout(root: &Path, lock: &LockFile, target: &str) -> Result<CheckoutReport, String> {
    let want = resolve_target(lock, target)?;
    let dir = ensure_repo(root, lock)?;

    let status = git(&dir, &["status", "--porcelain"])?;
    if !status.trim().is_empty() {
        return Err(format!(
            "working tree of {} is not clean; refusing to checkout (commit, stash, or clean it first)",
            dir.display()
        ));
    }

    if git(&dir, &["cat-file", "-e", &format!("{want}^{{commit}}")]).is_err() {
        return Err(format!(
            "object {want} is not present locally; run `aequera upstream fetch` first"
        ));
    }

    git(&dir, &["checkout", "--detach", &want])?;
    let head = git(&dir, &["rev-parse", "HEAD"])?;
    let head = head.trim().to_string();
    if head != want {
        return Err(format!(
            "checkout landed on {head} instead of {want}; managed repo left untouched beyond the failed checkout"
        ));
    }

    Ok(CheckoutReport {
        target: target.to_string(),
        resolved_sha: want,
        head_sha: head,
        detached: true,
        checkout_dir: dir.display().to_string(),
    })
}

/// Verify the managed checkout against the lock. State mismatches are
/// reported (verified=false), never repaired: repair is an explicit update.
pub fn verify(root: &Path, lock: &LockFile) -> Result<VerifyReport, String> {
    let dir = root.join(CHECKOUT_RELATIVE);
    if !dir.join(".git").exists() {
        return Err(format!(
            "no managed checkout at {}; run `aequera bootstrap` first",
            dir.display()
        ));
    }

    let remote_url = git(&dir, &["remote", "get-url", "origin"])?;
    let remote_url = remote_url.trim().to_string();
    let remote_ok = remote_url == lock.upstream.repository.url;

    let want = &lock.upstream.revision.git;
    let revision_exists = git(&dir, &["cat-file", "-e", &format!("{want}^{{commit}}")]).is_ok();

    let head_sha = git(&dir, &["rev-parse", "HEAD"])
        .ok()
        .map(|h| h.trim().to_string());
    let head_matches = head_sha.as_deref() == Some(want.as_str());

    let status = git(&dir, &["status", "--porcelain"])?;
    let tree_clean = status.trim().is_empty();

    Ok(VerifyReport {
        remote_url,
        remote_ok,
        revision_exists,
        head_sha,
        head_matches,
        tree_clean,
        verified: remote_ok && revision_exists && head_matches && tree_clean,
    })
}

/// Full acquisition flow: fetch the provenance ref, materialize the locked
/// baseline, and prove the result verifies. Any step may stop the flow.
pub fn bootstrap(root: &Path, lock: &LockFile) -> Result<BootstrapReport, String> {
    let fetch_report = fetch(root, lock)?;
    let checkout_report = checkout(root, lock, &lock.upstream.channel)?;
    let verify_report = verify(root, lock)?;
    if !verify_report.verified {
        return Err(format!(
            "baseline materialized but does not verify: {verify_report:?}"
        ));
    }
    Ok(BootstrapReport {
        fetch: fetch_report,
        checkout: checkout_report,
        verify: verify_report,
    })
}

#[derive(Debug, Serialize)]
pub struct UpdateReport {
    pub from_version: String,
    pub from_sha: String,
    pub to_version: String,
    pub to_sha: String,
    pub to_ref: String,
    pub candidate_path: String,
    /// The same candidate was already staged; nothing was written.
    pub already_staged: bool,
}

/// Stage a newer release as the candidate baseline (UPSTREAM1.md, "update").
///
/// Fetches exactly `tag`, resolves it to a full SHA, and writes
/// `candidate.lock`. The lock, the managed checkout's HEAD, and the worktree
/// stay untouched: the known-good baseline remains the build input until the
/// series is rebased onto the candidate and the gates pass.
pub fn update(root: &Path, lock: &LockFile, tag: &str) -> Result<UpdateReport, String> {
    validate_ref_name(tag)?;
    if lock.upstream.channel != "release" {
        return Err(format!(
            "upstream update supports the release channel only (lock channel {:?})",
            lock.upstream.channel
        ));
    }
    let to_version = release_tag_version(tag).ok_or_else(|| {
        format!("{tag:?} is not a release tag (want FIREFOX_<major>_<minor>[_<patch>]_RELEASE)")
    })?;
    if !version_newer(&to_version, &lock.upstream.version)? {
        return Err(format!(
            "{tag} ({to_version}) is not newer than the locked {}; update only moves forward",
            lock.upstream.version
        ));
    }
    // An existing candidate is in-progress work: never replaced implicitly.
    let existing = lock::load_candidate(root, lock)?;
    if let Some(c) = &existing
        && c.upstream.resolved_from.ref_name != tag
    {
        return Err(format!(
            "{} already stages {} ({}); delete it to stage another release",
            lock::CANDIDATE_RELATIVE,
            c.upstream.version,
            c.upstream.resolved_from.ref_name
        ));
    }

    let dir = ensure_repo(root, lock)?;
    git(&dir, &["fetch", "--no-tags", "origin", "tag", tag])?;
    let to_sha = git(&dir, &["rev-parse", &format!("{tag}^{{commit}}")])?;
    if to_sha == lock.upstream.revision.git {
        return Err(format!("{tag} resolves to the locked revision {to_sha}"));
    }

    let mut report = UpdateReport {
        from_version: lock.upstream.version.clone(),
        from_sha: lock.upstream.revision.git.clone(),
        to_version: to_version.clone(),
        to_sha: to_sha.clone(),
        to_ref: format!("tag:{tag}"),
        candidate_path: lock::CANDIDATE_RELATIVE.to_string(),
        already_staged: false,
    };
    if let Some(c) = existing {
        if c.upstream.revision.git != to_sha {
            return Err(format!(
                "{} pins {} for {tag}, but the remote now resolves it to {to_sha}; refusing (delete the candidate to re-stage)",
                lock::CANDIDATE_RELATIVE,
                c.upstream.revision.git
            ));
        }
        report.already_staged = true;
        return Ok(report);
    }

    let mut candidate = lock.clone();
    candidate.upstream.version = to_version;
    candidate.upstream.revision.git = to_sha;
    candidate.upstream.resolved_from.kind = "tag".into();
    candidate.upstream.resolved_from.ref_name = tag.to_string();
    candidate.upstream.pinned_at = Some(today_utc());
    write_candidate(root, &candidate)?;
    // Prove the written file loads back as the same candidate.
    match lock::load_candidate(root, lock)? {
        Some(c) if c.upstream.revision.git == candidate.upstream.revision.git => Ok(report),
        _ => Err(format!(
            "{} did not round-trip after writing",
            lock::CANDIDATE_RELATIVE
        )),
    }
}

/// `FIREFOX_157_0_1_RELEASE` -> `157.0.1`. Betas, ESR, and build tags are
/// not release baselines and yield `None`.
fn release_tag_version(tag: &str) -> Option<String> {
    let body = tag.strip_prefix("FIREFOX_")?.strip_suffix("_RELEASE")?;
    let parts: Vec<&str> = body.split('_').collect();
    let numeric = parts
        .iter()
        .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    (numeric && (2..=3).contains(&parts.len())).then(|| parts.join("."))
}

/// Dotted numeric comparison; missing components count as 0 (156.0 < 156.0.1).
fn version_newer(candidate: &str, current: &str) -> Result<bool, String> {
    let parse = |v: &str| -> Result<Vec<u64>, String> {
        v.split('.')
            .map(|p| p.parse::<u64>())
            .collect::<Result<_, _>>()
            .map_err(|_| format!("unparsable version {v:?}"))
    };
    let (mut a, mut b) = (parse(candidate)?, parse(current)?);
    let len = a.len().max(b.len());
    a.resize(len, 0);
    b.resize(len, 0);
    Ok(a > b)
}

fn write_candidate(root: &Path, candidate: &LockFile) -> Result<(), String> {
    let body = serde_yaml::to_string(candidate).map_err(|e| format!("candidate: {e}"))?;
    let text = format!(
        "# Aequera Firefox upstream CANDIDATE — generated by `aequera upstream update`.\n\
         #\n\
         # Not the pin: builds and `patch apply` use firefox.lock until this\n\
         # candidate is adopted. Check the series with `aequera patch check\n\
         # --candidate`. Delete this file to abandon the candidate.\n\
         \n{body}"
    );
    let path = root.join(lock::CANDIDATE_RELATIVE);
    // Atomic temp+rename: a crash must not leave a half-written candidate.
    let tmp = path.with_extension(format!("lock.tmp-{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Current UTC date as YYYY-MM-DD (the lock's `pinned_at` format).
fn today_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Days since 1970-01-01 to a proleptic Gregorian date (H. Hinnant's
/// `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

fn resolve_target(lock: &LockFile, target: &str) -> Result<String, String> {
    if target == lock.upstream.channel || target == lock.upstream.revision.git {
        Ok(lock.upstream.revision.git.clone())
    } else {
        Err(format!(
            "refusing to check out {target:?}: this slice only materializes the locked baseline (channel {:?} or its SHA); adopting another revision is `upstream update`",
            lock.upstream.channel
        ))
    }
}

/// Lock-controlled git ref allow-list: prevents option injection
/// (`--upload-pack=...`) and rev-parse expansion (`^{...}`, `:`, `@`).
/// Single-arg `Command` prevents shell injection, but git still parses
/// leading `-` as an option, so the ref itself must be constrained.
fn validate_ref_name(r: &str) -> Result<(), String> {
    let ok = !r.is_empty()
        && r.len() <= 256
        && !r.starts_with('-')
        && !r.starts_with('.')
        && !r.starts_with('/')
        && !r.ends_with('/')
        && !r.ends_with('.')
        && !r.contains("..")
        && !r.contains([':', '~', '^', '?', '*', '[', '\\', ' ', '\t', '\n', '\0'])
        && r.bytes().all(|b| {
            matches!(
                b,
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-' | b'/'
            )
        });
    if ok {
        Ok(())
    } else {
        Err(format!(
            "refusing lock ref {r:?}: must match [A-Za-z0-9._/-]+, no leading '-', no '..', no git expansion"
        ))
    }
}

/// Remote URLs are passed as a single argv element, but git still
/// interprets `ext::` / `fd::` as command execution and a leading `-`
/// as an option. Allow-list safe transports: https/file absolute paths
/// (production uses https, tests use local absolute paths).
fn validate_remote_url(url: &str) -> Result<(), String> {
    if url.is_empty() || url.starts_with('-') || url.contains('\0') || url.contains('\n') {
        return Err(format!("refusing lock remote URL {url:?}: unsafe value"));
    }
    // Block git's command-execution transports (ext::sh -c ..., fd::...).
    // `https://` contains `://` (single colon), never `::`.
    if url.contains("::") || url.starts_with("ext:") || url.starts_with("fd:") {
        return Err(format!(
            "refusing lock remote URL {url:?}: ext::/fd:: transports allow command execution"
        ));
    }
    let safe = url.starts_with("https://")
        || url.starts_with("file://")
        || url.starts_with('/')
        || url.starts_with("git@")
        || url.starts_with("ssh://")
        // Windows absolute path (C:\..., C:/...).
        || (url.len() >= 3
            && url.as_bytes()[0].is_ascii_alphabetic()
            && url.as_bytes()[1] == b':'
            && (url.as_bytes()[2] == b'\\' || url.as_bytes()[2] == b'/'));
    if !safe {
        return Err(format!(
            "refusing lock remote URL {url:?}: want https://, file://, ssh, or an absolute path"
        ));
    }
    Ok(())
}

/// Remove skeleton placeholders the tooling owns. Anything else is left
/// alone: this function claims, it never cleans.
fn claim_placeholders(dir: &Path) -> Result<(), String> {
    let marker = dir.join(PLACEHOLDER);
    if marker.is_file() {
        std::fs::remove_file(&marker).map_err(|e| format!("{}: {e}", marker.display()))?;
    }
    Ok(())
}

/// Run git in `dir`, returning trimmed stdout or a loud stderr-bearing error.
pub(crate) fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_with_env(dir, args, &[])
}

/// `git` with extra environment variables (e.g. `GIT_INDEX_FILE` for a
/// throwaway index that never touches the real one).
pub(crate) fn git_with_env(
    dir: &Path,
    args: &[&str],
    envs: &[(&str, &Path)],
) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .envs(envs.iter().map(|(k, v)| (*k, *v)))
        .current_dir(dir)
        .output()
        .map_err(|e| format!("failed to execute git: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed in {}: {}",
            args.join(" "),
            dir.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock::{Patchset, Repository, ResolvedFrom, Revision, Upstream};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Scratch root unique to this test process run.
    fn scratch(name: &str) -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "aequera-test-{}-{}-{}",
            std::process::id(),
            id,
            name
        ))
    }

    /// Build a tiny origin repo with one commit and a lightweight tag.
    /// Returns (origin_path, tagged_commit_sha).
    fn fixture_origin(scratch: &Path) -> (PathBuf, String) {
        let origin = scratch.join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        let git = |dir: &Path, args: &[&str]| {
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
        };
        git(&origin, &["init"]);
        std::fs::write(origin.join("f.txt"), "x").unwrap();
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

    #[test]
    fn fetch_resolves_tag_to_locked_sha() {
        let root = scratch("fetch-ok");
        let (origin, sha) = fixture_origin(&root);
        let lock = lock_for(origin.to_str().unwrap(), &sha);
        let report = fetch(&root, &lock).expect("fetch should succeed");
        assert!(report.matches_lock);
        assert_eq!(report.resolved_sha, sha);
        assert!(root.join(CHECKOUT_RELATIVE).join(".git").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn fetch_rejects_provenance_drift() {
        let root = scratch("fetch-drift");
        let (origin, _sha) = fixture_origin(&root);
        let lock = lock_for(
            origin.to_str().unwrap(),
            "0000000000000000000000000000000000000000",
        );
        let err = fetch(&root, &lock).expect_err("drift must fail");
        assert!(err.contains("provenance drift"), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_repo_rejects_unexpected_remote() {
        let root = scratch("remote-mismatch");
        let dir = root.join(CHECKOUT_RELATIVE);
        std::fs::create_dir_all(&dir).unwrap();
        let out = Command::new("git")
            .args(["init"])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(out.status.success());
        let out = Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://example.invalid/other.git",
            ])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(out.status.success());
        let (_origin, sha) = fixture_origin(&root);
        let lock = lock_for("https://example.invalid/expected.git", &sha);
        let err = ensure_repo(&root, &lock).expect_err("remote mismatch must fail");
        assert!(err.contains("unexpected remote"), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    /// Commit a new file on top of the fixture origin; returns the new SHA.
    fn commit_file(origin: &Path, name: &str) -> String {
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(origin)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(out.status.success());
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        std::fs::write(origin.join(name), "y").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "second"]);
        git(&["rev-parse", "HEAD"])
    }

    #[test]
    fn checkout_detaches_at_locked_sha() {
        let root = scratch("checkout-ok");
        let (origin, sha) = fixture_origin(&root);
        let lock = lock_for(origin.to_str().unwrap(), &sha);
        fetch(&root, &lock).expect("fetch first");
        let report = checkout(&root, &lock, "test").expect("checkout channel");
        assert_eq!(report.resolved_sha, sha);
        assert_eq!(report.head_sha, sha);
        assert!(report.detached);
        // The locked SHA itself is an equally valid target.
        checkout(&root, &lock, &sha).expect("checkout sha");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn checkout_rejects_unknown_target() {
        let root = scratch("checkout-target");
        let (origin, sha) = fixture_origin(&root);
        let lock = lock_for(origin.to_str().unwrap(), &sha);
        fetch(&root, &lock).expect("fetch first");
        let err = checkout(&root, &lock, "main").expect_err("unknown target must fail");
        assert!(
            err.contains("only materializes the locked baseline"),
            "got: {err}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn checkout_requires_fetched_object() {
        let root = scratch("checkout-missing");
        let (origin, sha) = fixture_origin(&root);
        let lock = lock_for(origin.to_str().unwrap(), &sha);
        // No fetch: the object is unknown locally.
        let dir = ensure_repo(&root, &lock).expect("repo setup");
        assert!(dir.is_dir());
        let err = checkout(&root, &lock, "test").expect_err("missing object must fail");
        assert!(
            err.contains("run `aequera upstream fetch` first"),
            "got: {err}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn verify_passes_on_clean_baseline() {
        let root = scratch("verify-ok");
        let (origin, sha) = fixture_origin(&root);
        let lock = lock_for(origin.to_str().unwrap(), &sha);
        fetch(&root, &lock).expect("fetch first");
        checkout(&root, &lock, "test").expect("checkout");
        let report = verify(&root, &lock).expect("verify runs");
        assert!(report.verified, "got: {report:?}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn verify_detects_head_drift_and_dirty_tree() {
        let root = scratch("verify-drift");
        let (origin, sha) = fixture_origin(&root);
        let other = commit_file(&origin, "g.txt");
        assert_ne!(other, sha);
        let lock = lock_for(origin.to_str().unwrap(), &sha);
        fetch(&root, &lock).expect("fetch first");
        // Bring over the non-tagged commit too, so the drift target exists.
        let dir = root.join(CHECKOUT_RELATIVE);
        let out = Command::new("git")
            .args(["fetch", "origin"])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(out.status.success());

        // Drift the checkout to the other commit (bypasses checkout(), which
        // would rightly refuse) and dirty the tree.
        let out = Command::new("git")
            .args(["checkout", "--detach", &other])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(out.status.success());
        std::fs::write(dir.join("dirty.txt"), "uncommitted").unwrap();

        let report = verify(&root, &lock).expect("verify runs");
        assert!(!report.verified);
        assert!(!report.head_matches);
        assert!(!report.tree_clean);
        assert!(
            report.revision_exists,
            "locked object still present: {report:?}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bootstrap_composes_fetch_checkout_verify() {
        let root = scratch("bootstrap-ok");
        let (origin, sha) = fixture_origin(&root);
        let lock = lock_for(origin.to_str().unwrap(), &sha);
        let report = bootstrap(&root, &lock).expect("bootstrap composes");
        assert!(report.fetch.matches_lock);
        assert_eq!(report.checkout.head_sha, sha);
        assert!(report.verify.verified);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn fetch_rejects_malicious_ref_names() {
        for bad in [
            "--upload-pack=touch /tmp/pwn",
            "-h",
            "../escape",
            "tag^{commit}",
            "a:b",
            "a\\b",
            "",
        ] {
            assert!(
                validate_ref_name(bad).is_err(),
                "malicious ref {bad:?} must be refused"
            );
        }
        assert!(validate_ref_name("FIREFOX_156_0_RELEASE").is_ok());
        assert!(validate_remote_url("--evil").is_err());
    }

    #[test]
    fn remote_url_blocks_command_execution_transports() {
        for bad in [
            "ext::sh -c touch /tmp/pwn",
            "fd::3",
            "ext::ssh evil",
            "not-a-url",
            "",
        ] {
            assert!(
                validate_remote_url(bad).is_err(),
                "unsafe remote {bad:?} must be refused"
            );
        }
        for good in [
            "https://github.com/mozilla-firefox/firefox.git",
            "file:///tmp/origin",
            "/tmp/origin",
        ] {
            assert!(
                validate_remote_url(good).is_ok(),
                "safe remote {good:?} must pass"
            );
        }
    }

    #[test]
    fn release_tag_version_accepts_only_release_tags() {
        assert_eq!(
            release_tag_version("FIREFOX_157_0_1_RELEASE").as_deref(),
            Some("157.0.1")
        );
        assert_eq!(
            release_tag_version("FIREFOX_157_0_RELEASE").as_deref(),
            Some("157.0")
        );
        for bad in [
            "FIREFOX_157_0b5_RELEASE",
            "FIREFOX_157_0_BUILD1",
            "FIREFOX_140_3_0esr_RELEASE",
            "FIREFOX_157_RELEASE",
            "FIREFOX__0_RELEASE",
            "FIXTURE_1",
        ] {
            assert_eq!(release_tag_version(bad), None, "{bad}");
        }
    }

    #[test]
    fn version_newer_pads_missing_components() {
        assert!(version_newer("157.0.1", "156.0").unwrap());
        assert!(version_newer("156.0.1", "156.0").unwrap());
        assert!(!version_newer("156.0", "156.0").unwrap());
        assert!(!version_newer("155.9.9", "156.0").unwrap());
        assert!(version_newer("157.0", "15x").is_err());
    }

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(20_736), (2026, 10, 10));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    fn tag(origin: &Path, name: &str) {
        let out = Command::new("git")
            .args(["tag", name])
            .current_dir(origin)
            .output()
            .unwrap();
        assert!(out.status.success());
    }

    /// Origin with FIREFOX_1_0_RELEASE (locked) and FIREFOX_1_1_RELEASE;
    /// returns (root, release lock on 1.0, 1.1 sha).
    fn release_fixture(name: &str) -> (PathBuf, LockFile, String) {
        let root = scratch(name);
        let (origin, base) = fixture_origin(&root);
        tag(&origin, "FIREFOX_1_0_RELEASE");
        let next = commit_file(&origin, "g.txt");
        tag(&origin, "FIREFOX_1_1_RELEASE");
        std::fs::create_dir_all(root.join("upstream/manifests")).unwrap();
        let mut lock = lock_for(origin.to_str().unwrap(), &base);
        lock.upstream.channel = "release".into();
        lock.upstream.version = "1.0".into();
        lock.upstream.resolved_from.ref_name = "FIREFOX_1_0_RELEASE".into();
        (root, lock, next)
    }

    #[test]
    fn update_stages_candidate_without_moving_the_baseline() {
        let (root, lock, next) = release_fixture("update-ok");
        let report = update(&root, &lock, "FIREFOX_1_1_RELEASE").expect("update");
        assert!(!report.already_staged);
        assert_eq!(report.to_sha, next);
        assert_eq!(report.to_version, "1.1");

        let candidate = lock::load_candidate(&root, &lock)
            .expect("loads")
            .expect("staged");
        assert_eq!(candidate.upstream.revision.git, next);
        assert_eq!(candidate.upstream.version, "1.1");
        assert_eq!(
            candidate.upstream.resolved_from.ref_name,
            "FIREFOX_1_1_RELEASE"
        );
        assert!(candidate.upstream.pinned_at.is_some());
        // Nothing checked out: the managed repo has no HEAD yet.
        assert!(git(&root.join(CHECKOUT_RELATIVE), &["rev-parse", "HEAD"]).is_err());

        let again = update(&root, &lock, "FIREFOX_1_1_RELEASE").expect("idempotent");
        assert!(again.already_staged);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn update_refuses_old_foreign_or_replacing_targets() {
        let (root, lock, _next) = release_fixture("update-refuse");
        let err = update(&root, &lock, "FIREFOX_1_0_RELEASE").expect_err("not newer");
        assert!(err.contains("not newer"), "got: {err}");
        let err = update(&root, &lock, "FIXTURE_1").expect_err("not a release tag");
        assert!(err.contains("not a release tag"), "got: {err}");
        let err = update(&root, &lock, "--upload-pack=x").expect_err("unsafe ref");
        assert!(err.contains("refusing lock ref"), "got: {err}");

        update(&root, &lock, "FIREFOX_1_1_RELEASE").expect("stage 1.1");
        let err = update(&root, &lock, "FIREFOX_1_2_RELEASE").expect_err("already staged");
        assert!(err.contains("already stages 1.1"), "got: {err}");

        // A candidate pointing at another remote is refused, not trusted.
        let path = root.join(lock::CANDIDATE_RELATIVE);
        let text = std::fs::read_to_string(&path).unwrap();
        let url = &lock.upstream.repository.url;
        std::fs::write(
            &path,
            text.replace(url.as_str(), "https://example.invalid/x.git"),
        )
        .unwrap();
        let err = lock::load_candidate(&root, &lock).expect_err("foreign remote");
        assert!(err.contains("different upstream"), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }
}
