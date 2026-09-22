//! `aequera demo`: a scripted boundary proof that the CLI (standing in for
//! the future shell) drives the whole product loop through `aequera-core`
//! and nothing else: route commands, report outcomes, search one surface,
//! snapshot, restore, verify equality.
//!
//! This is a living integration check of the shell-consumes-core boundary,
//! not a product feature.

use aequera_core::command::{CommandAction, CommandOutcome, commands_for};
use aequera_core::{Browser, command::CommandRegistry};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct DemoStep {
    pub step: String,
    pub outcome: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct DemoReport {
    pub steps: Vec<DemoStep>,
    pub search_probe: SearchProbe,
    pub restore_equal: bool,
}

#[derive(Debug, Serialize)]
pub struct SearchProbe {
    pub query: String,
    pub hits: usize,
    pub first_hit: Option<String>,
}

pub fn run() -> Result<DemoReport, String> {
    let mut browser = Browser::new();
    let mut steps = Vec::new();

    let exec = |b: &mut Browser, steps: &mut Vec<DemoStep>, label: &str, action: CommandAction| {
        let outcome = b.execute(&action).map_err(|e| format!("{label}: {e}"))?;
        steps.push(DemoStep {
            step: label.into(),
            outcome: json(&outcome),
        });
        Ok::<CommandOutcome, String>(outcome)
    };

    let home = browser.active_workspace();
    exec(
        &mut browser,
        &mut steps,
        "open alpha",
        CommandAction::OpenTab {
            workspace: home,
            url: "https://a.example".into(),
            title: "Alpha".into(),
        },
    )?;
    let beta = match exec(
        &mut browser,
        &mut steps,
        "open beta",
        CommandAction::OpenTab {
            workspace: home,
            url: "https://b.example".into(),
            title: "Beta".into(),
        },
    )? {
        CommandOutcome::TabOpened(id) => id,
        other => return Err(format!("expected TabOpened, got {other:?}")),
    };
    let research = match exec(
        &mut browser,
        &mut steps,
        "create research",
        CommandAction::CreateWorkspace {
            name: "Research".into(),
        },
    )? {
        CommandOutcome::WorkspaceCreated(id) => id,
        other => return Err(format!("expected WorkspaceCreated, got {other:?}")),
    };
    exec(
        &mut browser,
        &mut steps,
        "move beta to research",
        CommandAction::MoveTab {
            tab: beta,
            from: home,
            to: research,
            index: 0,
        },
    )?;
    exec(
        &mut browser,
        &mut steps,
        "switch to research",
        CommandAction::SwitchWorkspace {
            workspace: research,
        },
    )?;
    exec(
        &mut browser,
        &mut steps,
        "close beta",
        CommandAction::CloseTab {
            workspace: research,
            tab: beta,
        },
    )?;
    exec(
        &mut browser,
        &mut steps,
        "restore beta",
        CommandAction::RestoreClosed {
            workspace: research,
        },
    )?;

    // One query across the unified surface.
    let registry = {
        let mut r = CommandRegistry::new();
        for cmd in commands_for(&browser) {
            r.register(cmd).map_err(|e| format!("registry: {e}"))?;
        }
        r
    };
    let hits = registry.search("switch");
    let probe = SearchProbe {
        query: "switch".into(),
        hits: hits.len(),
        first_hit: hits.first().map(|c| c.title.clone()),
    };
    if hits.is_empty() {
        return Err("search probe: no hits for \"switch\"".into());
    }

    // Snapshot, restore into a fresh browser, compare observable state.
    let snap = browser.snapshot();
    let snap_json = serde_json::to_string(&snap).map_err(|e| format!("snapshot: {e}"))?;
    let parsed: aequera_core::session::SessionSnapshot =
        serde_json::from_str(&snap_json).map_err(|e| format!("snapshot parse: {e}"))?;
    let mut revived = Browser::new();
    revived
        .restore(&parsed)
        .map_err(|e| format!("restore: {e}"))?;
    let restore_equal = observable(&browser) == observable(&revived);

    Ok(DemoReport {
        steps,
        search_probe: probe,
        restore_equal,
    })
}

fn json(outcome: &CommandOutcome) -> serde_json::Value {
    serde_json::to_value(outcome).unwrap_or(serde_json::Value::Null)
}

fn observable(b: &Browser) -> (Vec<u64>, u64, Vec<u64>) {
    let active = b.active_workspace();
    let tabs = b
        .get_workspace(active)
        .map(|w| w.tabs())
        .unwrap_or_default();
    (b.workspaces(), active, tabs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_transcript_completes_and_restores_equal() {
        let report = run().expect("demo must complete");
        assert!(report.steps.len() >= 7, "got: {:?}", report.steps.len());
        assert!(report.search_probe.hits >= 2);
        assert!(report.restore_equal);
    }
}
