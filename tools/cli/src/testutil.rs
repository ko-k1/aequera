//! Shared test fixtures: scratch roots, a fixture git runner, a tagged
//! origin repo, and a lock pointing at it.

use crate::lock::{LockFile, Patchset, Repository, ResolvedFrom, Revision, Upstream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A scratch root unique to this test process and call.
pub fn scratch(prefix: &str, name: &str) -> PathBuf {
    let id = COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "aequera-{prefix}-test-{}-{id}-{name}",
        std::process::id()
    ))
}

/// Run fixture git (no system config, fixed identity) and assert success;
/// returns trimmed stdout, so a diff's final line loses trailing spaces.
pub fn git(dir: &Path, args: &[&str]) -> String {
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

/// Best-effort directory symlink for tests. Windows without developer mode
/// (SeCreateSymbolicLinkPrivilege) cannot create one; callers in tests skip
/// when this returns false.
pub fn dir_symlink(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link).is_ok()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        false
    }
}

/// A tiny origin repo under `scratch`: one commit (`base.txt`) tagged
/// FIXTURE_1. Returns (origin path, tagged commit SHA).
pub fn fixture_origin(scratch: &Path) -> (PathBuf, String) {
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

/// A lock on channel "test" pinning `sha` at `url`, resolved from FIXTURE_1.
pub fn lock_for(url: &str, sha: &str) -> LockFile {
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
