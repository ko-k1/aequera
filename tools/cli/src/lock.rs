//! Lock-file discovery and parsing.
//!
//! The lock (`upstream/manifests/firefox.lock`) is the canonical pin.
//! Channel, version, and ref are provenance; the full SHA is authoritative.

use serde::Deserialize;
use std::path::{Path, PathBuf};

/// File name searched upward from the current directory.
pub const LOCK_RELATIVE: &str = "upstream/manifests/firefox.lock";

#[derive(Debug, Deserialize)]
pub struct LockFile {
    pub schema_version: u32,
    pub upstream: Upstream,
    pub patchset: Patchset,
}

#[derive(Debug, Deserialize)]
pub struct Upstream {
    pub name: String,
    pub repository: Repository,
    pub channel: String,
    pub version: String,
    pub revision: Revision,
    pub resolved_from: ResolvedFrom,
    pub pinned_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Repository {
    #[serde(rename = "type")]
    pub kind: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
pub struct Revision {
    pub git: String,
}

#[derive(Debug, Deserialize)]
pub struct ResolvedFrom {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "ref")]
    pub ref_name: String,
}

#[derive(Debug, Deserialize)]
pub struct Patchset {
    pub manifest: String,
    pub version: u32,
}

/// Walk up from the current directory to the Aequera repository root.
pub fn discover() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        if dir.join(LOCK_RELATIVE).is_file() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Load and minimally validate the lock file.
pub fn load(root: &Path) -> Result<LockFile, String> {
    let path = root.join(LOCK_RELATIVE);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{path:?}: {e}"))?;
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
