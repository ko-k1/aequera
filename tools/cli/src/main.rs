//! Aequera CLI: intent-oriented interface over the browser workflow.
//!
//! Agents and humans invoke operations (`upstream status`, `patch apply`)
//! instead of reconstructing Git/upstream mechanics by hand.
//! See `docs/engineering/CLI.md` and `UPSTREAM.md`.
//!
//! Slice policy: only commands whose workstream has landed are real.
//! Everything else fails loudly with its owning workstream (never a stub
//! that pretends success).

mod bench;
mod config;
mod demo;
mod doctor;
mod lock;
mod output;
mod patch;
mod upstream;

use clap::{Parser, Subcommand};
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "aequera",
    version,
    about = "Intent-oriented interface over the Aequera browser workflow"
)]
struct Cli {
    /// Emit machine-readable JSON instead of human text.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Check local prerequisites and repository state.
    Doctor,
    /// Scripted core boundary proof (drives aequera-core end to end).
    Demo,
    /// Acquire and materialize the locked baseline (fetch, checkout, verify).
    Bootstrap,
    /// Pinned Firefox upstream operations (UPSTREAM.md).
    Upstream {
        #[command(subcommand)]
        op: UpstreamOp,
    },
    /// Ordered Firefox patch-series operations (PATCHING.md).
    Patch {
        #[command(subcommand)]
        op: PatchOp,
    },
    /// Configuration validation and migration.
    Config {
        #[command(subcommand)]
        op: ConfigOp,
    },
    /// Build the Aequera artifact.
    Build,
    /// Run the test suite.
    Test,
    /// Run local performance benchmarks (no remote telemetry).
    Bench {
        /// Write the JSON artifact to this path (parents created as needed).
        #[arg(long)]
        out: Option<std::path::PathBuf>,
    },
    /// Release readiness operations.
    Release {
        #[command(subcommand)]
        op: ReleaseOp,
    },
}

#[derive(Subcommand)]
enum UpstreamOp {
    /// Show the pinned revision, patchset, config, and worktree state.
    Status,
    /// Fetch remote objects without changing the baseline (W2).
    Fetch,
    /// Verify checkout matches the lock (W3).
    Verify,
    /// Check out a channel or revision into the managed tree (W2/W3).
    Checkout {
        /// Channel name or exact revision.
        target: String,
    },
    /// Resolve and adopt a new baseline revision (W3).
    Update,
    /// Remove generated upstream state (W3).
    Clean,
}

#[derive(Subcommand)]
enum PatchOp {
    Status,
    Check,
    Apply,
    Rebase { revision: String },
    Export,
}

#[derive(Subcommand)]
enum ConfigOp {
    /// Validate configuration files (defaults, or --file <candidate>).
    Validate {
        /// Candidate file to validate instead of the committed defaults.
        #[arg(long)]
        file: Option<std::path::PathBuf>,
    },
    /// Migrate a file toward the current schema (requires --file).
    Migrate {
        /// Candidate file to migrate.
        #[arg(long)]
        file: Option<std::path::PathBuf>,
    },
}

#[derive(Subcommand)]
enum ReleaseOp {
    Check,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Doctor => doctor::run(cli.json),
        Command::Demo => demo_cmd(cli.json),
        Command::Bootstrap => bootstrap(cli.json),
        Command::Upstream { op } => match op {
            UpstreamOp::Status => upstream_status(cli.json),
            UpstreamOp::Fetch => upstream_fetch(cli.json),
            UpstreamOp::Verify => upstream_verify(cli.json),
            UpstreamOp::Checkout { target } => upstream_checkout(cli.json, &target),
            UpstreamOp::Update => todo_cmd("upstream update", "W3 patch pipeline"),
            UpstreamOp::Clean => todo_cmd("upstream clean", "W3 patch pipeline"),
        },
        Command::Patch { op } => match op {
            PatchOp::Status => patch_status(cli.json),
            PatchOp::Check => patch_check(cli.json),
            PatchOp::Apply => patch_apply(cli.json),
            PatchOp::Rebase { .. } => todo_cmd("patch rebase", "update flow (later slice)"),
            PatchOp::Export => todo_cmd("patch export", "later slice"),
        },
        Command::Config { op } => match op {
            ConfigOp::Validate { file } => config_validate(cli.json, file.as_deref()),
            ConfigOp::Migrate { file } => config_migrate(cli.json, file.as_deref()),
        },
        Command::Build => todo_cmd("build", "W2 bootstrap / W3 pipeline"),
        Command::Test => todo_cmd("test", "W6 CI and test skeleton"),
        Command::Bench { out } => bench_cmd(cli.json, out.as_deref()),
        Command::Release { .. } => todo_cmd("release", "W8 docs closure / release"),
    }
}

/// Loud placeholder: exit non-zero and name the owning workstream.
fn todo_cmd(cmd: &str, workstream: &str) -> ExitCode {
    eprintln!("aequera {cmd}: not implemented in this slice (owner: {workstream}).");
    eprintln!("Refusing to pretend success. See docs/PHASE0_FOUNDATION.md.");
    ExitCode::from(2)
}

/// Load the repository root and lock, or report why that failed.
fn load_context() -> Result<(std::path::PathBuf, lock::LockFile), ExitCode> {
    let root = match lock::discover() {
        None => {
            eprintln!(
                "No Aequera repository found: walked up from the current directory without finding upstream/manifests/firefox.lock."
            );
            return Err(ExitCode::FAILURE);
        }
        Some(root) => root,
    };
    match lock::load(&root) {
        Err(e) => {
            eprintln!("Lock file unreadable: {e}");
            Err(ExitCode::FAILURE)
        }
        Ok(lock) => Ok((root, lock)),
    }
}

fn upstream_fetch(json: bool) -> ExitCode {
    let (root, lock) = match load_context() {
        Err(code) => return code,
        Ok(ctx) => ctx,
    };
    match upstream::fetch(&root, &lock) {
        Err(e) => {
            eprintln!("Fetch failed: {e}");
            ExitCode::FAILURE
        }
        Ok(report) => {
            let lock_line = if report.matches_lock {
                "match"
            } else {
                "MISMATCH"
            };
            let human = format!(
                "Upstream fetch\n\
                 --------------\n\
                 Remote        : {remote}\n\
                 Fetched ref   : {fetched}\n\
                 Resolved SHA  : {sha}\n\
                 Lock SHA      : {lock_line}\n\
                 Checkout dir  : {dir}\n\
                 \n\
                 Baseline unchanged: no checkout modified, no lock modified.",
                remote = report.remote_url,
                fetched = report.fetched_ref,
                sha = report.resolved_sha,
                dir = report.checkout_dir,
            );
            output::emit(json, &human, &report);
            ExitCode::SUCCESS
        }
    }
}

fn upstream_checkout(json: bool, target: &str) -> ExitCode {
    let (root, lock) = match load_context() {
        Err(code) => return code,
        Ok(ctx) => ctx,
    };
    match upstream::checkout(&root, &lock, target) {
        Err(e) => {
            eprintln!("Checkout failed: {e}");
            ExitCode::FAILURE
        }
        Ok(report) => {
            let human = format!(
                "Upstream checkout\n\
                 -----------------\n\
                 Target        : {target}\n\
                 Resolved SHA  : {sha}\n\
                 HEAD          : {head} (detached)\n\
                 Checkout dir  : {dir}",
                target = report.target,
                sha = report.resolved_sha,
                head = report.head_sha,
                dir = report.checkout_dir,
            );
            output::emit(json, &human, &report);
            ExitCode::SUCCESS
        }
    }
}

fn upstream_verify(json: bool) -> ExitCode {
    let (root, lock) = match load_context() {
        Err(code) => return code,
        Ok(ctx) => ctx,
    };
    match upstream::verify(&root, &lock) {
        Err(e) => {
            eprintln!("Verify failed: {e}");
            ExitCode::FAILURE
        }
        Ok(report) => {
            let flag = |b: bool| if b { "OK" } else { "DRIFT" };
            let human = format!(
                "Aequera Upstream\n\
                 ----------------\n\
                 Channel       : {channel}\n\
                 Version       : {version}\n\
                 Locked SHA    : {short}...\n\
                 Current SHA   : {head}\n\
                 \n\
                 Repository    : {remote_flag}\n\
                 Revision      : {rev_flag}\n\
                 Clean tree    : {tree_flag}\n\
                 \n\
                 status: {status}",
                channel = lock.upstream.channel,
                version = lock.upstream.version,
                short = lock::short_sha(&lock.upstream.revision.git),
                head = report.head_sha.as_deref().unwrap_or("<no checkout>"),
                remote_flag = flag(report.remote_ok),
                rev_flag = flag(report.revision_exists && report.head_matches),
                tree_flag = flag(report.tree_clean),
                status = if report.verified {
                    "verified"
                } else {
                    "drift detected (see flags; repair is an explicit update)"
                },
            );
            output::emit(json, &human, &report);
            if report.verified {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
    }
}

fn bootstrap(json: bool) -> ExitCode {
    let (root, lock) = match load_context() {
        Err(code) => return code,
        Ok(ctx) => ctx,
    };
    match upstream::bootstrap(&root, &lock) {
        Err(e) => {
            eprintln!("Bootstrap failed: {e}");
            ExitCode::FAILURE
        }
        Ok(report) => {
            let human = format!(
                "Aequera bootstrap\n\
                 -----------------\n\
                 Fetched ref   : {fetched} ({sha})\n\
                 Checkout      : {dir} @ {head} (detached)\n\
                 Verify        : passed\n\
                 \n\
                 Clean baseline ready for patch application.",
                fetched = report.fetch.fetched_ref,
                sha = report.fetch.resolved_sha,
                dir = report.checkout.checkout_dir,
                head = report.checkout.head_sha,
            );
            output::emit(json, &human, &report);
            ExitCode::SUCCESS
        }
    }
}

fn patch_status(json: bool) -> ExitCode {
    let (root, lock) = match load_context() {
        Err(code) => return code,
        Ok(ctx) => ctx,
    };
    match patch::status(&root, &lock) {
        Err(e) => {
            eprintln!("Patch status failed: {e}");
            ExitCode::FAILURE
        }
        Ok(report) => {
            let human = format!(
                "Patch status\n\
                 ------------\n\
                 Manifest      : {manifest} (valid)\n\
                 Base vs lock  : {base}\n\
                 Worktree      : {wt}\n\
                 Applied state : {applied}",
                manifest = report.manifest_path,
                base = if report.base_matches_lock {
                    "match"
                } else {
                    "DRIFT (rebase required)"
                },
                wt = match (&report.worktree_present, &report.worktree_head) {
                    (false, _) => "absent".to_string(),
                    (true, Some(h)) => format!("present @ {}", &h[..12.min(h.len())]),
                    (true, None) => "present (unreadable HEAD)".to_string(),
                },
                applied = match report.applied_state_matches {
                    None => "none recorded",
                    Some(true) => "matches manifest",
                    Some(false) => "STALE (re-apply required)",
                },
            );
            output::emit(json, &human, &report);
            if report.base_matches_lock {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
    }
}

fn patch_check(json: bool) -> ExitCode {
    let (root, lock) = match load_context() {
        Err(code) => return code,
        Ok(ctx) => ctx,
    };
    match patch::check(&root, &lock) {
        Err(e) => {
            eprintln!("Patch check failed: {e}");
            ExitCode::FAILURE
        }
        Ok(report) => {
            let mut human = format!(
                "Patch check\n-----------\nEntries: {} (all apply cleanly)",
                report.entries_checked
            );
            for e in &report.entries {
                human.push_str(&format!("\n  [clean] {} ({} file(s))", e.id, e.files.len()));
            }
            output::emit(json, &human, &report);
            ExitCode::SUCCESS
        }
    }
}

fn patch_apply(json: bool) -> ExitCode {
    let (root, lock) = match load_context() {
        Err(code) => return code,
        Ok(ctx) => ctx,
    };
    match patch::apply(&root, &lock) {
        Err(e) => {
            eprintln!("Patch apply failed: {e}");
            ExitCode::FAILURE
        }
        Ok(report) => {
            let patches = if report.already_applied {
                format!(
                    "Already applied and verified ({} entries) @ {}",
                    report.entries_applied, report.base_sha
                )
            } else {
                format!(
                    "Applied {} entries onto {}",
                    report.entries_applied, report.base_sha
                )
            };
            let human = format!(
                "Patch apply\n-----------\n{patches}\nSynced {} overlays ({} files)\n{}",
                report.overlays_synced, report.overlay_files, report.worktree_dir
            );
            output::emit(json, &human, &report);
            ExitCode::SUCCESS
        }
    }
}

fn config_validate(json: bool, file: Option<&std::path::Path>) -> ExitCode {
    match file {
        Some(path) => {
            let result = config::validate_file(path);
            let human = if result.ok {
                format!("Config valid: {}", result.file)
            } else {
                format!(
                    "Config invalid: {}\n  - {}",
                    result.file,
                    result.errors.join("\n  - ")
                )
            };
            output::emit(json, &human, &result);
            if result.ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        None => {
            let (root, _) = match load_context() {
                Err(code) => return code,
                Ok(ctx) => ctx,
            };
            match config::validate_defaults(&root) {
                Err(e) => {
                    eprintln!("Config validation failed: {e}");
                    ExitCode::FAILURE
                }
                Ok(report) => {
                    let mut human = format!(
                        "Config validation\n------------------\nFiles: {} ({})",
                        report.files_checked,
                        if report.valid {
                            "all valid"
                        } else {
                            "FAILURES PRESENT"
                        },
                    );
                    for r in &report.results {
                        human.push_str(&format!(
                            "\n  [{}] {}",
                            if r.ok { "ok" } else { "FAIL" },
                            r.file
                        ));
                        for e in &r.errors {
                            human.push_str(&format!("\n        - {e}"));
                        }
                    }
                    output::emit(json, &human, &report);
                    if report.valid {
                        ExitCode::SUCCESS
                    } else {
                        ExitCode::FAILURE
                    }
                }
            }
        }
    }
}

fn config_migrate(json: bool, file: Option<&std::path::Path>) -> ExitCode {
    let path = match file {
        Some(path) => path,
        None => {
            eprintln!(
                "config migrate requires --file <candidate>; committed defaults are never rewritten in place."
            );
            return ExitCode::FAILURE;
        }
    };
    match config::migrate_file(path) {
        Err(e) => {
            eprintln!("Config migration failed: {e}");
            ExitCode::FAILURE
        }
        Ok(report) => {
            let human = format!(
                "Config migration\n----------------\nFile: {file}\nSchema: v{from} -> v{to}\nResult: {note}",
                file = report.file,
                from = report.from_schema,
                to = report.to_schema,
                note = report.note,
            );
            output::emit(json, &human, &report);
            ExitCode::SUCCESS
        }
    }
}

fn bench_cmd(json: bool, out: Option<&std::path::Path>) -> ExitCode {
    let (root, _) = match load_context() {
        Err(code) => return code,
        Ok(ctx) => ctx,
    };
    match bench::run(&root, out) {
        Err(e) => {
            eprintln!("Bench failed: {e}");
            ExitCode::FAILURE
        }
        Ok(report) => {
            let human = format!(
                "Aequera bench\n-------------\nHost      : {os}/{arch} ({cpus} cpus, {ram} MiB RAM, {disk} free on repo volume)\nRecorded  : {ts}{artifact}\nCLI ops   : lock_load {lock}us, manifest_load {man}us, config_validate {cfg}us\nBrowser   : pending — no built browser yet (see tools/benchmark/README.md)",
                os = report.host.os,
                arch = report.host.arch,
                cpus = report.host.logical_cpus,
                ram = report.host.total_memory_bytes / 1024 / 1024,
                disk = report
                    .host
                    .repo_volume_free_bytes
                    .map(|b| format!("{} MiB", b / 1024 / 1024))
                    .unwrap_or_else(|| "unknown".into()),
                ts = report.recorded_at_unix,
                artifact = out
                    .map(|p| format!(" (artifact: {})", p.display()))
                    .unwrap_or_default(),
                lock = report.cli_ops_us.lock_load_us,
                man = report.cli_ops_us.manifest_load_us,
                cfg = report.cli_ops_us.config_validate_us,
            );
            output::emit(json, &human, &report);
            ExitCode::SUCCESS
        }
    }
}

fn demo_cmd(json: bool) -> ExitCode {
    match demo::run() {
        Err(e) => {
            eprintln!("Demo failed: {e}");
            ExitCode::FAILURE
        }
        Ok(report) => {
            let human = format!(
                "Aequera demo\n------------\nSteps executed : {}\nSearch \"switch\"  : {} hits (first: {})\nRestore equal  : {}\n\nEvery mutation above ran through Browser::execute; search ran one registry; restore verified by equality.",
                report.steps.len(),
                report.search_probe.hits,
                report.search_probe.first_hit.as_deref().unwrap_or("<none>"),
                report.restore_equal,
            );
            output::emit(json, &human, &report);
            if report.restore_equal {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
    }
}

fn upstream_status(json: bool) -> ExitCode {
    match lock::discover() {
        None => {
            eprintln!(
                "No Aequera repository found: walked up from the current directory without finding upstream/manifests/firefox.lock."
            );
            ExitCode::FAILURE
        }
        Some(root) => match lock::load(&root) {
            Err(e) => {
                eprintln!("Lock file unreadable: {e}");
                ExitCode::FAILURE
            }
            Ok(l) => {
                let checkout_present = lock::substantive_present(&root.join("upstream/firefox"));
                let worktree_present = lock::substantive_present(&root.join("worktree/firefox"));
                let status = serde_json::json!({
                    "name": l.upstream.name,
                    "repository": l.upstream.repository.url,
                    "channel": l.upstream.channel,
                    "version": l.upstream.version,
                    "locked_sha": l.upstream.revision.git,
                    "locked_sha_short": lock::short_sha(&l.upstream.revision.git),
                    "resolved_from": format!("{}:{}", l.upstream.resolved_from.kind, l.upstream.resolved_from.ref_name),
                    "pinned_at": l.upstream.pinned_at,
                    "patchset_version": l.patchset.version,
                    "patchset_manifest": l.patchset.manifest,
                    "checkout_present": checkout_present,
                    "worktree_present": worktree_present,
                });
                let human = format!(
                    "Aequera Upstream\n\
                     ----------------\n\
                     Repository    : {repo}\n\
                     Channel       : {channel}\n\
                     Version       : {version}\n\
                     Locked SHA    : {short}...\n\
                     Resolved from : {kind}:{reference}\n\
                     Patchset      : v{ps} ({manifest})\n\
                     Checkout      : {co}\n\
                     Worktree      : {wt}\n\
                     \n\
                     status: lock-only (no checkout yet; verify/checkout land in W2/W3)",
                    repo = l.upstream.repository.url,
                    channel = l.upstream.channel,
                    version = l.upstream.version,
                    short = lock::short_sha(&l.upstream.revision.git),
                    kind = l.upstream.resolved_from.kind,
                    reference = l.upstream.resolved_from.ref_name,
                    ps = l.patchset.version,
                    manifest = l.patchset.manifest,
                    co = presence(checkout_present),
                    wt = presence(worktree_present),
                );
                output::emit(json, &human, &status);
                ExitCode::SUCCESS
            }
        },
    }
}

fn presence(present: bool) -> &'static str {
    if present { "present" } else { "absent" }
}
