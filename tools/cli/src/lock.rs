//! Lock-file discovery and parsing.
//!
//! The lock (`upstream/manifests/firefox.lock`) is the canonical pin.
//! Channel, version, and ref are provenance; the full SHA is authoritative.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// File name searched upward from the current directory.
pub const LOCK_RELATIVE: &str = "upstream/manifests/firefox.lock";

/// Staged candidate baseline written by `aequera upstream update`. Same
/// schema as the lock, never authoritative: builds and `patch apply` keep
/// using the lock until the candidate is adopted.
pub const CANDIDATE_RELATIVE: &str = "upstream/manifests/candidate.lock";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LockFile {
    pub schema_version: u32,
    pub upstream: Upstream,
    pub patchset: Patchset,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Upstream {
    pub name: String,
    pub repository: Repository,
    pub channel: String,
    pub version: String,
    pub revision: Revision,
    pub resolved_from: ResolvedFrom,
    pub pinned_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Repository {
    #[serde(rename = "type")]
    pub kind: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Revision {
    pub git: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ResolvedFrom {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "ref")]
    pub ref_name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Patchset {
    pub manifest: String,
    pub version: u32,
}

/// Walk up from the current directory to the Aequera repository root.
pub fn discover() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        // Use symlink_metadata so a planted `firefox.lock` symlink to
        // outside the repo is not followed: only a regular file counts.
        match std::fs::symlink_metadata(dir.join(LOCK_RELATIVE)) {
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => return Some(dir),
            _ => {}
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Load and minimally validate the lock file.
pub fn load(root: &Path) -> Result<LockFile, String> {
    load_file(&root.join(LOCK_RELATIVE))
}

/// Load the staged candidate, if one exists. It must describe the same
/// upstream as the lock (name, remote, channel, patchset manifest): only the
/// revision moves in an update, so anything else is refused rather than
/// trusted.
pub fn load_candidate(root: &Path, lock: &LockFile) -> Result<Option<LockFile>, String> {
    let path = root.join(CANDIDATE_RELATIVE);
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{path:?}: {e}")),
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
            return Err(format!("{path:?}: not a regular file; refusing"));
        }
        Ok(_) => {}
    }
    let candidate = load_file(&path)?;
    let (c, l) = (&candidate.upstream, &lock.upstream);
    if c.name != l.name
        || c.repository.kind != l.repository.kind
        || c.repository.url != l.repository.url
        || c.channel != l.channel
        || candidate.patchset.manifest != lock.patchset.manifest
    {
        return Err(format!(
            "{path:?} describes a different upstream than the lock (only the revision may move); delete it and re-run `aequera upstream update`"
        ));
    }
    Ok(Some(candidate))
}

fn load_file(path: &Path) -> Result<LockFile, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path:?}: {e}"))?;
    let lock: LockFile =
        serde_yaml::from_str(&text).map_err(|e| format!("{path:?}: invalid YAML: {e}"))?;
    if lock.schema_version != 1 {
        return Err(format!(
            "unsupported schema_version {} (this CLI supports 1)",
            lock.schema_version
        ));
    }
    if !is_full_sha(&lock.upstream.revision.git) {
        return Err("upstream.revision.git is not a full 40-character commit SHA".into());
    }
    Ok(lock)
}

/// Short display form only; never stored back into the lock.
pub fn short_sha(full: &str) -> &str {
    full.get(..12).unwrap_or(full)
}

pub fn is_full_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// True only if the directory holds real managed state, not just the
/// skeleton `.gitkeep`. A real checkout or worktree always carries `.git`.
pub fn substantive_present(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    match std::fs::read_dir(path) {
        Ok(entries) => entries.flatten().any(|e| {
            let name = e.file_name();
            // `.gitkeep` is the skeleton placeholder; anything else
            // (including `.git`) is substantive state.
            name != ".gitkeep"
        }),
        Err(_) => false,
    }
}
