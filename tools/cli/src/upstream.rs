//! Managed acquisition of the pinned Firefox source.
//!
//! `fetch` downloads Git objects for the lock's provenance ref and proves
//! they resolve to the locked SHA. It never moves the baseline, never edits
//! the lock, never checks anything out. See UPSTREAM.md ("Fetch vs Update").

use crate::lock::LockFile;
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
    let out = Command::new("git")
        .args(args)
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
}
