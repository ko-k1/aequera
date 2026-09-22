//! Local performance baselines (`aequera bench`).
//!
//! Records a host snapshot plus CLI operation timings today, and carries the
//! browser metric registry as explicitly pending until a browser build exists.
//! Local only: no network, no telemetry. See tools/benchmark/README.md.

use crate::{config, lock, patch};
use serde::Serialize;
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
pub struct BenchReport {
    pub recorded_at_unix: u64,
    pub host: HostSnapshot,
    pub cli_ops_us: CliOps,
    pub browser_metrics: BrowserMetrics,
}

#[derive(Debug, Serialize)]
pub struct HostSnapshot {
    pub os: String,
    pub arch: String,
    pub logical_cpus: usize,
    pub total_memory_bytes: u64,
    pub repo_volume_free_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct CliOps {
    pub lock_load_us: u128,
    pub manifest_load_us: u128,
    pub config_validate_us: u128,
}

#[derive(Debug, Serialize)]
pub struct BrowserMetrics {
    pub status: String,
    pub reason: String,
    pub registry: Vec<RegistryEntry>,
}

#[derive(Debug, Serialize)]
pub struct RegistryEntry {
    pub metric: String,
    pub unit: String,
    pub initial_target: String,
}

/// Run the benchmark. `out` optionally persists a JSON artifact.
pub fn run(root: &Path, out: Option<&Path>) -> Result<BenchReport, String> {
    let start = Instant::now();
    let loaded = lock::load(root)?;
    let lock_load_us = start.elapsed().as_micros();

    let start = Instant::now();
    let _manifest = patch::load_manifest(root, &loaded)?;
    let manifest_load_us = start.elapsed().as_micros();

    let start = Instant::now();
    let validation = config::validate_defaults(root)
        .map_err(|e| format!("bench aborted: defaults invalid: {e}"))?;
    if !validation.valid {
        return Err("bench aborted: defaults invalid; fix `config validate` first".into());
    }
    let config_validate_us = start.elapsed().as_micros();

    let mut system = sysinfo::System::new_all();
    system.refresh_all();
    let repo_volume_free_bytes = free_space_on_containing_volume(root);

    let report = BenchReport {
        recorded_at_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("clock: {e}"))?
            .as_secs(),
        host: HostSnapshot {
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            logical_cpus: std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1),
            total_memory_bytes: system.total_memory(),
            repo_volume_free_bytes,
        },
        cli_ops_us: CliOps {
            lock_load_us,
            manifest_load_us,
            config_validate_us,
        },
        browser_metrics: BrowserMetrics {
            status: "pending".into(),
            reason: "no built browser yet; registry fixed now for later comparability".into(),
            registry: vec![
                entry(
                    "input_to_visible_feedback",
                    "ms",
                    "<= 16 (<= 8.3 high-refresh)",
                ),
                entry("ui_animation", "fps", "60 baseline"),
                entry("tab_workspace_switch_feedback", "ms", "<= 16"),
                entry("command_surface_feedback", "ms", "<= 16"),
                entry("startup_to_usable_paint", "ms", "recorded, then budgeted"),
                entry("idle_cpu", "percent", "near zero"),
                entry("memory_idle_and_loaded", "MiB", "recorded, then budgeted"),
                entry(
                    "chrome_resilience_under_heavy_content",
                    "mixed",
                    "no input starvation",
                ),
            ],
        },
    };

    if let Some(path) = out {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let text = serde_json::to_string_pretty(&report).map_err(|e| format!("serialize: {e}"))?;
        std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(report)
}

fn entry(metric: &str, unit: &str, initial_target: &str) -> RegistryEntry {
    RegistryEntry {
        metric: metric.into(),
        unit: unit.into(),
        initial_target: initial_target.into(),
    }
}

/// Free bytes on the volume containing `path`, via first matching mount.
/// `None` when the volume cannot be determined (never an error).
fn free_space_on_containing_volume(path: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let canonical = std::fs::canonicalize(path).ok()?;
    // Windows canonicalization prefixes paths with `\\?\`, which defeats
    // prefix matching against mount points (`C:\`); strip it first.
    let normalized = canonical.to_string_lossy();
    let stripped = normalized
        .strip_prefix(r"\\?\UNC\")
        .map(|s| format!(r"\\{s}"))
        .unwrap_or_else(|| {
            normalized
                .strip_prefix(r"\\?\")
                .map(str::to_string)
                .unwrap_or_else(|| normalized.into_owned())
        });
    let canonical = Path::new(&stripped);
    let mut best: Option<(usize, u64)> = None;
    for disk in disks.list() {
        let mount = disk.mount_point();
        if canonical.starts_with(mount) {
            let depth = mount.components().count();
            let free = disk.available_space();
            if best.map(|(d, _)| depth > d).unwrap_or(true) {
                best = Some((depth, free));
            }
        }
    }
    best.map(|(_, free)| free)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_root() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    #[test]
    fn bench_runs_without_browser() {
        let report = run(&repo_root(), None).expect("bench must run pre-browser");
        assert_eq!(report.browser_metrics.status, "pending");
        assert_eq!(report.browser_metrics.registry.len(), 8);
        assert!(report.host.logical_cpus >= 1);
        assert!(report.host.total_memory_bytes > 0);
    }

    #[test]
    fn bench_artifact_round_trips() {
        let dir = std::env::temp_dir().join(format!("aequera-bench-test-{}", std::process::id()));
        let artifact = dir.join("nested/baseline.json");
        let report = run(&repo_root(), Some(&artifact)).expect("bench with --out");
        let text = std::fs::read_to_string(&artifact).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            parsed["cli_ops_us"]["lock_load_us"].as_u64().unwrap(),
            report.cli_ops_us.lock_load_us as u64
        );
        assert_eq!(parsed["browser_metrics"]["status"], "pending");
        std::fs::remove_dir_all(&dir).ok();
    }
}
