//! Unified command surface seed (`docs/PRODUCT.md`, "Command Surface").
//!
//! The user should never need to know which subsystem owns an item before
//! finding it. Commands are therefore **data, not closures**: a serializable
//! action enum the shell lists, searches, and routes through one entry point
//! (`Browser::execute`). Presentation (palette, keyboard, buttons) varies;
//! meaning stays here.

use crate::{Browser, Error, TabId, WorkspaceId};
use serde::Serialize;

/// Stable command identity, e.g. `"tab.close"`, `"workspace.switch"`.
pub type CommandId = String;

/// Where a command is meaningful.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    Global,
    Workspace(WorkspaceId),
}

/// Every mutation the shell may request, as data. Adding a variant is a
/// deliberate product decision, not a scattered method call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum CommandAction {
    OpenTab {
        workspace: WorkspaceId,
        url: String,
        title: String,
    },
    CloseTab {
        workspace: WorkspaceId,
        tab: TabId,
    },
    SwitchTab {
        workspace: WorkspaceId,
        tab: TabId,
    },
    RestoreClosed {
        workspace: WorkspaceId,
    },
    MoveTab {
        tab: TabId,
        from: WorkspaceId,
        to: WorkspaceId,
        index: usize,
    },
    TogglePin {
        workspace: WorkspaceId,
        tab: TabId,
    },
    CreateWorkspace {
        name: String,
    },
    RenameWorkspace {
        workspace: WorkspaceId,
        name: String,
    },
    RemoveWorkspace {
        workspace: WorkspaceId,
    },
    SwitchWorkspace {
        workspace: WorkspaceId,
    },
    /// Convenience: open in the currently active workspace.
    OpenUrl {
        url: String,
        title: String,
    },
}

/// What an executed command changed, so the shell can report back whether
/// the action succeeded and what the new state is (UX principle: visible
/// state, no silent outcomes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum CommandOutcome {
    TabOpened(TabId),
    TabClosed(TabId),
    TabSwitched(TabId),
    TabRestored(TabId),
    TabMoved(TabId),
    PinToggled(TabId, bool),
    WorkspaceCreated(WorkspaceId),
    WorkspaceRenamed(WorkspaceId),
    WorkspaceRemoved(WorkspaceId),
    WorkspaceSwitched(WorkspaceId),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub id: CommandId,
    pub title: String,
    pub hint: Option<String>,
    pub scope: Scope,
    pub action: CommandAction,
}

impl Command {
    fn named(id: &str, title: String, scope: Scope, action: CommandAction) -> Self {
        Command {
            id: id.into(),
            title,
            hint: None,
            scope,
            action,
        }
    }

    pub fn with_hint(mut self, hint: &str) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

#[derive(Debug, Default)]
pub struct CommandRegistry {
    commands: Vec<Command>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    DuplicateId(CommandId),
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegistryError::DuplicateId(id) => write!(f, "duplicate command id {id:?}"),
        }
    }
}

impl std::error::Error for RegistryError {}

impl CommandRegistry {
    pub fn new() -> Self {
        CommandRegistry::default()
    }

    pub fn register(&mut self, command: Command) -> Result<(), RegistryError> {
        if self.commands.iter().any(|c| c.id == command.id) {
            return Err(RegistryError::DuplicateId(command.id));
        }
        self.commands.push(command);
        Ok(())
    }

    pub fn all(&self) -> &[Command] {
        &self.commands
    }

    pub fn for_scope(&self, scope: &Scope) -> Vec<&Command> {
        self.commands
            .iter()
            .filter(|c| match (&c.scope, scope) {
                (Scope::Global, _) => true,
                (Scope::Workspace(a), Scope::Workspace(b)) => a == b,
                _ => false,
            })
            .collect()
    }

    /// One query across everything registered: title prefix matches first
    /// (stable registration order within each rank), then substring matches.
    /// Case-insensitive. Empty query returns everything.
    pub fn search(&self, query: &str) -> Vec<&Command> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return self.commands.iter().collect();
        }
        let mut prefix = Vec::new();
        let mut substring = Vec::new();
        for command in &self.commands {
            let title = command.title.to_lowercase();
            if title.starts_with(&q) {
                prefix.push(command);
            } else if title.contains(&q) {
                substring.push(command);
            }
        }
        prefix.extend(substring);
        prefix
    }
}

impl Browser {
    /// The single mutation path shells use. Every variant routes to a tested
    /// domain operation; outcomes report the new state.
    pub fn execute(&mut self, action: &CommandAction) -> Result<CommandOutcome, Error> {
        match action {
            CommandAction::OpenTab {
                workspace,
                url,
                title,
            } => self
                .open_tab(*workspace, url, title)
                .map(CommandOutcome::TabOpened),
            CommandAction::CloseTab { workspace, tab } => {
                self.close_tab(*workspace, *tab)?;
                Ok(CommandOutcome::TabClosed(*tab))
            }
            CommandAction::SwitchTab { workspace, tab } => {
                self.switch_tab(*workspace, *tab)?;
                Ok(CommandOutcome::TabSwitched(*tab))
            }
            CommandAction::RestoreClosed { workspace } => self
                .restore_closed(*workspace)
                .map(CommandOutcome::TabRestored),
            CommandAction::MoveTab {
                tab,
                from,
                to,
                index,
            } => {
                self.move_tab(*tab, *from, *to, *index)?;
                Ok(CommandOutcome::TabMoved(*tab))
            }
            CommandAction::TogglePin { workspace, tab } => self
                .toggle_pin(*workspace, *tab)
                .map(|pinned| CommandOutcome::PinToggled(*tab, pinned)),
            CommandAction::CreateWorkspace { name } => self
                .create_workspace(name)
                .map(CommandOutcome::WorkspaceCreated),
            CommandAction::RenameWorkspace { workspace, name } => {
                self.rename_workspace(*workspace, name)?;
                Ok(CommandOutcome::WorkspaceRenamed(*workspace))
            }
            CommandAction::RemoveWorkspace { workspace } => {
                self.remove_workspace(*workspace)?;
                Ok(CommandOutcome::WorkspaceRemoved(*workspace))
            }
            CommandAction::SwitchWorkspace { workspace } => {
                self.switch_workspace(*workspace)?;
                Ok(CommandOutcome::WorkspaceSwitched(*workspace))
            }
            CommandAction::OpenUrl { url, title } => {
                let active = self.try_active_workspace()?;
                self.open_tab(active, url, title)
                    .map(CommandOutcome::TabOpened)
            }
        }
    }
}

/// Contextual command set for the current browser state: workspace switches,
/// per-tab switch/close in the active workspace, restore when something is
/// restorable, and the global workspace commands. The shell renders these;
/// ranking and filtering live in [`CommandRegistry`].
///
/// Never panics: a broken invariant yields fewer commands (fail-closed to a
/// known-good subset), never a shell crash during palette render.
pub fn commands_for(browser: &Browser) -> Vec<Command> {
    let mut out = Vec::new();
    let Ok(active) = browser.try_active_workspace() else {
        return out;
    };

    for id in browser.workspaces() {
        let Ok(ws) = browser.get_workspace(id) else {
            continue;
        };
        out.push(Command::named(
            &format!("workspace.switch.{id}"),
            format!("Switch to {}", ws.name),
            Scope::Global,
            CommandAction::SwitchWorkspace { workspace: id },
        ));
    }

    let Ok(ws) = browser.get_workspace(active) else {
        return out;
    };
    for tab_id in ws.tabs() {
        let Some(tab) = ws.get(tab_id) else {
            continue;
        };
        let label = if tab.title.is_empty() {
            tab.url.clone()
        } else {
            tab.title.clone()
        };
        out.push(Command::named(
            &format!("tab.switch.{tab_id}"),
            format!("Switch to {label}"),
            Scope::Workspace(active),
            CommandAction::SwitchTab {
                workspace: active,
                tab: tab_id,
            },
        ));
        out.push(Command::named(
            &format!("tab.close.{tab_id}"),
            format!("Close {label}"),
            Scope::Workspace(active),
            CommandAction::CloseTab {
                workspace: active,
                tab: tab_id,
            },
        ));
    }
    if ws.closed_count() > 0 {
        out.push(
            Command::named(
                "tab.restore",
                "Restore closed tab".into(),
                Scope::Workspace(active),
                CommandAction::RestoreClosed { workspace: active },
            )
            .with_hint("reopens the most recently closed tab where it was"),
        );
    }
    out.push(Command::named(
        "workspace.new",
        "New workspace".into(),
        Scope::Global,
        CommandAction::CreateWorkspace {
            name: "Workspace".into(),
        },
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Browser;

    fn sample_registry() -> CommandRegistry {
        let mut r = CommandRegistry::new();
        r.register(Command::named(
            "tab.close",
            "Close tab".into(),
            Scope::Global,
            CommandAction::OpenUrl {
                url: "https://x.example".into(),
                title: "x".into(),
            },
        ))
        .unwrap();
        r.register(Command::named(
            "tab.clone",
            "Clone tab".into(),
            Scope::Global,
            CommandAction::OpenUrl {
                url: "https://y.example".into(),
                title: "y".into(),
            },
        ))
        .unwrap();
        r.register(Command::named(
            "workspace.close",
            "Close workspace".into(),
            Scope::Global,
            CommandAction::OpenUrl {
                url: "https://z.example".into(),
                title: "z".into(),
            },
        ))
        .unwrap();
        r
    }

    #[test]
    fn search_ranks_prefix_before_substring_case_insensitively() {
        let r = sample_registry();
        let hits: Vec<&str> = r.search("clo").iter().map(|c| c.id.as_str()).collect();
        // "Close tab" and "Clone tab" share the prefix; registration order holds.
        assert_eq!(hits, vec!["tab.close", "tab.clone", "workspace.close"]);
        let hits: Vec<&str> = r.search("CLOSE").iter().map(|c| c.id.as_str()).collect();
        assert_eq!(hits.len(), 2);
        assert_eq!(r.search("").len(), 3);
        assert!(r.search("nope").is_empty());
    }

    #[test]
    fn duplicate_ids_rejected() {
        let mut r = sample_registry();
        let err = r
            .register(Command::named(
                "tab.close",
                "Close tab again".into(),
                Scope::Global,
                CommandAction::OpenUrl {
                    url: "https://q.example".into(),
                    title: "q".into(),
                },
            ))
            .unwrap_err();
        assert_eq!(err, RegistryError::DuplicateId("tab.close".into()));
    }

    #[test]
    fn scope_filters_workspace_commands() {
        let mut r = CommandRegistry::new();
        r.register(Command::named(
            "a",
            "Global".into(),
            Scope::Global,
            CommandAction::OpenUrl {
                url: "https://a.example".into(),
                title: "a".into(),
            },
        ))
        .unwrap();
        r.register(Command::named(
            "b",
            "Ws 7".into(),
            Scope::Workspace(7),
            CommandAction::OpenUrl {
                url: "https://b.example".into(),
                title: "b".into(),
            },
        ))
        .unwrap();
        assert_eq!(r.for_scope(&Scope::Workspace(7)).len(), 2);
        assert_eq!(r.for_scope(&Scope::Workspace(8)).len(), 1);
        assert_eq!(r.for_scope(&Scope::Global).len(), 1);
    }

    #[test]
    fn execute_routes_every_action_family() {
        let mut b = Browser::new();
        let ws = b.active_workspace();

        let CommandOutcome::TabOpened(t1) = b
            .execute(&CommandAction::OpenUrl {
                url: "https://a.example".into(),
                title: "A".into(),
            })
            .unwrap()
        else {
            panic!("expected TabOpened")
        };
        assert_eq!(
            b.execute(&CommandAction::TogglePin {
                workspace: ws,
                tab: t1
            })
            .unwrap(),
            CommandOutcome::PinToggled(t1, true)
        );
        assert_eq!(
            b.execute(&CommandAction::SwitchTab {
                workspace: ws,
                tab: t1
            })
            .unwrap(),
            CommandOutcome::TabSwitched(t1)
        );

        let CommandOutcome::WorkspaceCreated(ws2) = b
            .execute(&CommandAction::CreateWorkspace { name: "Two".into() })
            .unwrap()
        else {
            panic!("expected WorkspaceCreated")
        };
        assert_eq!(
            b.execute(&CommandAction::MoveTab {
                tab: t1,
                from: ws,
                to: ws2,
                index: 0,
            })
            .unwrap(),
            CommandOutcome::TabMoved(t1)
        );
        assert_eq!(
            b.execute(&CommandAction::SwitchWorkspace { workspace: ws2 })
                .unwrap(),
            CommandOutcome::WorkspaceSwitched(ws2)
        );
        assert_eq!(
            b.execute(&CommandAction::CloseTab {
                workspace: ws2,
                tab: t1
            })
            .unwrap(),
            CommandOutcome::TabClosed(t1)
        );
        assert_eq!(
            b.execute(&CommandAction::RestoreClosed { workspace: ws2 })
                .unwrap(),
            CommandOutcome::TabRestored(t1)
        );
        assert_eq!(
            b.execute(&CommandAction::RenameWorkspace {
                workspace: ws2,
                name: "Second".into(),
            })
            .unwrap(),
            CommandOutcome::WorkspaceRenamed(ws2)
        );
        assert_eq!(
            b.execute(&CommandAction::RemoveWorkspace { workspace: ws2 })
                .unwrap(),
            CommandOutcome::WorkspaceRemoved(ws2)
        );
        assert!(
            b.execute(&CommandAction::SwitchTab {
                workspace: ws,
                tab: 999
            })
            .is_err()
        );
    }

    #[test]
    fn commands_for_reflects_live_state() {
        let mut b = Browser::new();
        let ws = b.active_workspace();
        b.execute(&CommandAction::OpenTab {
            workspace: ws,
            url: "https://a.example".into(),
            title: "Alpha".into(),
        })
        .unwrap();
        b.execute(&CommandAction::OpenTab {
            workspace: ws,
            url: "https://b.example".into(),
            title: "Beta".into(),
        })
        .unwrap();

        let cmds = commands_for(&b);
        // 1 workspace switch + 2 tabs x (switch + close) + new workspace.
        assert_eq!(cmds.len(), 1 + 4 + 1);
        assert!(cmds.iter().any(|c| c.title == "Switch to Beta"));
        assert!(cmds.iter().all(|c| !c.title.is_empty()));

        // Closing a tab surfaces the restore command.
        let beta = b.get_workspace(ws).unwrap().tabs()[1];
        b.execute(&CommandAction::CloseTab {
            workspace: ws,
            tab: beta,
        })
        .unwrap();
        let cmds = commands_for(&b);
        assert!(cmds.iter().any(|c| c.id == "tab.restore"));
    }
}
