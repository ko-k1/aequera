//! `aequera doctor`: local prerequisite and repository-state checks.

use crate::{lock, output};
use serde::Serialize;
use std::process::{Command, ExitCode};

#[derive(Serialize)]
struct Check {
    name: &'static str,
    result: &'static str, // "ok" | "warn" | "fail"
    detail: String,
}

pub fn run(json: bool) -> ExitCode {
    let mut checks: Vec<Check> = Vec::new();

    // 1. Git must exist: the entire upstream/patch model is Git-native.
    match Command::new("git").arg("--version").output() {
        Ok(out) if out.status.success() => checks.push(Check {
            name: "git",
            result: "ok",
            detail: String::from_utf8_lossy(&out.stdout).trim().to_string(),
        }),
        _ => checks.push(Check {
            name: "git",
            result: "fail",
            detail: "git not found on PATH; required for upstream and patch operations".into(),
        }),
    }

    // 2. Platform identity (informational; OS-specific checks key off it).
    checks.push(Check {
        name: "platform",
        result: "ok",
        detail: format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH),
    });

    // 3. Native compiler probe (warn-level: needed for future Firefox builds,
    // not for CLI work). Resolution guides live in tools/bootstrap/.
    let (compiler, guide) = expected_compiler();
    checks.push(Check {
        name: "compiler",
        result: if compiler_present(compiler) {
            "ok"
        } else {
            "warn"
        },
        detail: if compiler_present(compiler) {
            format!("{compiler} found on PATH")
        } else {
            format!("{compiler} not on PATH; see tools/bootstrap/{guide}")
        },
    });

    // 4. Repository discovery + lock validity.
    match lock::discover() {
        None => checks.push(Check {
            name: "repository",
            result: "fail",
            detail: "no upstream/manifests/firefox.lock found walking up from cwd".into(),
        }),
        Some(root) => {
            checks.push(Check {
                name: "repository",
                result: "ok",
                detail: format!("root: {}", root.display()),
            });
            match lock::load(&root) {
                Ok(l) => {
                    checks.push(Check {
                        name: "lock",
                        result: "ok",
                        detail: format!(
                            "{} {} @ {}",
                            l.upstream.channel,
                            l.upstream.version,
                            lock::short_sha(&l.upstream.revision.git)
                        ),
                    });
                    let manifest = root.join(&l.patchset.manifest);
                    checks.push(Check {
                        name: "backend",
                        result: if l.upstream.repository.kind == "git" {
                            "ok"
                        } else {
                            "fail"
                        },
                        detail: format!(
                            "type={} url={}",
                            l.upstream.repository.kind, l.upstream.repository.url
                        ),
                    });
                    checks.push(Check {
                        name: "patchset-manifest",
                        result: if manifest.is_file() { "ok" } else { "fail" },
                        detail: format!("{}: {}", l.patchset.manifest, exists(manifest.is_file())),
                    });
                    checks.push(state_check(
                        "checkout",
                        &root.join("upstream/firefox"),
                        "managed checkout present",
                        "absent (expected until W2/W3 fetch+checkout land)",
                    ));
                    checks.push(state_check(
                        "worktree",
                        &root.join("worktree/firefox"),
                        "generated worktree present",
                        "absent (expected until W3 pipeline lands)",
                    ));
                }
                Err(e) => checks.push(Check {
                    name: "lock",
                    result: "fail",
                    detail: e,
                }),
            }
        }
    }

    let failed = checks.iter().any(|c| c.result == "fail");
    let human = checks
        .iter()
        .map(|c| format!("[{}] {} — {}", c.result, c.name, c.detail))
        .collect::<Vec<_>>()
        .join("\n");
    output::emit(json, &human, &checks);
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn exists(present: bool) -> &'static str {
    if present { "present" } else { "MISSING" }
}

/// (compiler probe, bootstrap guide) for this OS.
fn expected_compiler() -> (&'static str, &'static str) {
    if cfg!(target_os = "windows") {
        ("cl", "windows.md")
    } else if cfg!(target_os = "macos") {
        ("cc", "macos.md")
    } else {
        ("cc", "linux.md")
    }
}

/// Best-effort PATH probe. Warn-level by design: absence must guide,
/// never block CLI work.
fn compiler_present(compiler: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        Command::new("where")
            .arg(compiler)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let probe = format!("command -v {compiler}");
        Command::new("sh")
            .args(["-c", probe.as_str()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Presence check that is not fooled by skeleton `.gitkeep` placeholders.
fn state_check(
    name: &'static str,
    path: &std::path::Path,
    present_detail: &str,
    absent_detail: &str,
) -> Check {
    if lock::substantive_present(path) {
        Check {
            name,
            result: "ok",
            detail: present_detail.into(),
        }
    } else if path.is_dir() {
        Check {
            name,
            result: "warn",
            detail: "skeleton placeholder only; no real managed state yet".into(),
        }
    } else {
        Check {
            name,
            result: "warn",
            detail: absent_detail.into(),
        }
    }
}
