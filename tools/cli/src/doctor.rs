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

    // 3b. Rust toolchain (warn-level): the CLI and Firefox builds need it.
    let guide = expected_compiler().1;
    for tool in ["rustc", "cargo"] {
        checks.push(tool_check(
            tool,
            tool,
            &["--version"],
            format!(
                "{tool} not on PATH; install via https://rustup.rs, see tools/bootstrap/{guide}"
            ),
        ));
    }

    // 3c. Host build tooling per OS (warn-level; the bootstrap guides
    // resolve each one). Never blocks CLI work.
    #[cfg(target_os = "windows")]
    checks.push({
        let shell = std::path::Path::new("C:/mozilla-build/start-shell.bat");
        Check {
            name: "mozillabuild",
            result: if shell.is_file() { "ok" } else { "warn" },
            detail: if shell.is_file() {
                "MozillaBuild shell present".into()
            } else {
                "no C:\\mozilla-build\\start-shell.bat; see tools/bootstrap/windows.md".into()
            },
        }
    });
    #[cfg(target_os = "macos")]
    checks.push(tool_check(
        "xcode-tools",
        "xcode-select",
        &["-p"],
        "no Xcode command line tools; run xcode-select --install, see tools/bootstrap/macos.md"
            .into(),
    ));
    #[cfg(target_os = "macos")]
    checks.push(tool_check(
        "brew",
        "brew",
        &["--version"],
        "no Homebrew on PATH; install the formulae in the official guide, see tools/bootstrap/macos.md"
            .into(),
    ));
    #[cfg(target_os = "linux")]
    checks.push(tool_check(
        "clang",
        "clang",
        &["--version"],
        "no clang on PATH; install clang + distro headers, see tools/bootstrap/linux.md".into(),
    ));

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
                    // Validate the lock's manifest pointer before joining: same
                    // traversal guard as patch::load_manifest (no `..`/abs).
                    // On failure report fail (no existence oracle outside the
                    // repo) and continue with remaining checks.
                    let manifest = match crate::patch::plain_relative(
                        "manifest",
                        "patchset",
                        &l.patchset.manifest,
                    ) {
                        Ok(rel) => root.join(&rel),
                        Err(e) => {
                            checks.push(Check {
                                name: "patchset-manifest",
                                result: "fail",
                                detail: e,
                            });
                            // Sentinel that is never a file: keeps the flow
                            // below (backend/compat/checkout checks) intact.
                            root.join("invalid-manifest-pointer")
                        }
                    };
                    let manifest_valid = manifest
                        .file_name()
                        .map(|n| n != "invalid-manifest-pointer")
                        .unwrap_or(true);
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
                    if manifest_valid {
                        checks.push(Check {
                            name: "patchset-manifest",
                            result: if manifest.is_file() { "ok" } else { "fail" },
                            detail: format!(
                                "{}: {}",
                                l.patchset.manifest,
                                exists(manifest.is_file())
                            ),
                        });
                    }
                    // Compatibility matrix pin (docs/engineering/COMPATIBILITY.md):
                    // matrix.firefox must equal the lock, or platform claims drift.
                    checks.push(compat_matrix_check(&root, &l));
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
/// never block CLI work. Uses direct argv (no shell string) so a future
/// parameterized probe cannot become shell injection.
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
        // `command -v` is a shell builtin: keep the shell invocation but
        // never interpolate untrusted input. Today `compiler` is a
        // hardcoded "cc"; assert that invariant so future callers cannot
        // pass through arbitrary strings.
        debug_assert!(matches!(compiler, "cc" | "cl"));
        if !matches!(compiler, "cc" | "cl") {
            return false;
        }
        Command::new("sh")
            .args(["-c", "command -v \"$0\"", compiler])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Run `program args`, returning an ok/warn check with the tool's first
/// output line, or the hint when it cannot run. Warn-level by design:
/// missing build tooling must guide, never block CLI work.
fn tool_check(name: &'static str, program: &str, args: &[&str], missing_hint: String) -> Check {
    match Command::new(program).args(args).output() {
        Ok(out) if out.status.success() => {
            let line = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            Check {
                name,
                result: "ok",
                detail: if line.is_empty() {
                    format!("{program} found on PATH")
                } else {
                    line
                },
            }
        }
        _ => Check {
            name,
            result: "warn",
            detail: missing_hint,
        },
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

fn compat_matrix_check(root: &std::path::Path, lock: &lock::LockFile) -> Check {
    let path = root.join("tests/compatibility/matrix.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            return Check {
                name: "compat-matrix",
                result: "warn",
                detail: format!("matrix.json unreadable: {e}"),
            };
        }
    };
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return Check {
                name: "compat-matrix",
                result: "fail",
                detail: format!("matrix.json invalid JSON: {e}"),
            };
        }
    };
    let fx = &v["firefox"];
    let m_channel = fx["channel"].as_str().unwrap_or("");
    let m_version = fx["version"].as_str().unwrap_or("");
    let m_revision = fx["revision"].as_str().unwrap_or("");
    if m_channel == lock.upstream.channel
        && m_version == lock.upstream.version
        && m_revision == lock.upstream.revision.git
    {
        Check {
            name: "compat-matrix",
            result: "ok",
            detail: format!("matrix firefox {m_channel} {m_version} matches lock"),
        }
    } else {
        Check {
            name: "compat-matrix",
            result: "fail",
            detail: format!(
                "matrix firefox {m_channel} {m_version} {} != lock {} {} {}",
                lock::short_sha(m_revision),
                lock.upstream.channel,
                lock.upstream.version,
                lock::short_sha(&lock.upstream.revision.git)
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiler_probe_names_a_bootstrap_guide() {
        let (compiler, guide) = expected_compiler();
        assert!(!compiler.is_empty());
        assert!(guide.ends_with(".md"), "got: {guide}");
    }

    #[test]
    fn tool_check_reports_missing_tool_as_warn() {
        let check = tool_check(
            "no-such-tool",
            "aequera-definitely-missing-binary-xyz",
            &["--version"],
            "hint".into(),
        );
        assert_eq!(check.result, "warn");
        assert_eq!(check.detail, "hint");
    }
}
