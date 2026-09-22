//! Session snapshots: versioned, plain-data mirrors of [`Browser`].
//!
//! Persistence seed for workspace recovery (`docs/ROADMAP.md` Phase 2).
//! Core stays I/O-free by design: this module converts between live state
//! and serializable snapshots. Writing bytes to disk belongs to a later
//! services layer, which will reuse exactly these types.
//!
//! Failure model: a snapshot with an unknown schema version is refused
//! outright; dangling pointers inside a known version are repaired
//! deterministically (never a half-restored shell, never a panic).

use crate::{Browser, ClosedTab, Error, Tab, TabId, Workspace, WorkspaceId};
use serde::{Deserialize, Serialize};

/// Current snapshot schema generation.
pub const SNAPSHOT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub version: u32,
    pub workspaces: Vec<SnapshotWorkspace>,
    pub active: Option<WorkspaceId>,
    pub next_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotWorkspace {
    pub id: WorkspaceId,
    pub name: String,
    pub tabs: Vec<SnapshotTab>,
    pub active_tab: Option<TabId>,
    pub closed: Vec<SnapshotClosed>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotTab {
    pub id: TabId,
    pub url: String,
    pub title: String,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotClosed {
    pub tab: SnapshotTab,
    pub index: usize,
}

impl Browser {
    /// Capture the full restorable state.
    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            version: SNAPSHOT_VERSION,
            workspaces: self
                .workspaces
                .iter()
                .map(|w| SnapshotWorkspace {
                    id: w.id,
                    name: w.name.clone(),
                    tabs: w
                        .tabs
                        .iter()
                        .map(|t| SnapshotTab {
                            id: t.id,
                            url: t.url.clone(),
                            title: t.title.clone(),
                            pinned: t.pinned,
                        })
                        .collect(),
                    active_tab: w.active_tab,
                    closed: w
                        .closed
                        .iter()
                        .map(|c| SnapshotClosed {
                            tab: SnapshotTab {
                                id: c.tab.id,
                                url: c.tab.url.clone(),
                                title: c.tab.title.clone(),
                                pinned: c.tab.pinned,
                            },
                            index: c.index,
                        })
                        .collect(),
                })
                .collect(),
            active: self.active,
            next_id: self.next_id,
        }
    }

    /// Replace live state with a snapshot. Unknown schema versions are
    /// refused; an empty workspace list is refused (a browser always has a
    /// workspace); dangling pointers are repaired to deterministic
    /// fallbacks so restore can never produce an invalid browser.
    pub fn restore(&mut self, snap: &SessionSnapshot) -> Result<(), Error> {
        if snap.version != SNAPSHOT_VERSION {
            return Err(Error::UnsupportedSnapshot(snap.version));
        }
        if snap.workspaces.is_empty() {
            return Err(Error::EmptySnapshot);
        }
        let mut workspaces = Vec::with_capacity(snap.workspaces.len());
        for sw in &snap.workspaces {
            let tabs: Vec<Tab> = sw
                .tabs
                .iter()
                .map(|t| Tab {
                    id: t.id,
                    url: t.url.clone(),
                    title: t.title.clone(),
                    pinned: t.pinned,
                })
                .collect();
            // Repair: an active tab that is not a member falls back to the
            // first tab, or nothing when the workspace is empty.
            let active_tab = match sw.active_tab {
                Some(id) if tabs.iter().any(|t| t.id == id) => Some(id),
                _ => tabs.first().map(|t| t.id),
            };
            workspaces.push(Workspace {
                id: sw.id,
                name: sw.name.clone(),
                tabs,
                active_tab,
                closed: sw
                    .closed
                    .iter()
                    .map(|c| ClosedTab {
                        tab: Tab {
                            id: c.tab.id,
                            url: c.tab.url.clone(),
                            title: c.tab.title.clone(),
                            pinned: c.tab.pinned,
                        },
                        index: c.index,
                    })
                    .collect(),
            });
        }
        // Repair: a missing active workspace falls back to the first listed.
        let active = match snap.active {
            Some(id) if workspaces.iter().any(|w| w.id == id) => Some(id),
            _ => workspaces.first().map(|w| w.id),
        };
        // Reseed above every restored id so future ids never collide.
        let max_id = workspaces
            .iter()
            .flat_map(|w| {
                std::iter::once(w.id)
                    .chain(w.tabs.iter().map(|t| t.id))
                    .chain(w.closed.iter().map(|c| c.tab.id))
            })
            .chain(snap.next_id.checked_sub(1))
            .max()
            .unwrap_or(0);
        self.workspaces = workspaces;
        self.active = active;
        self.next_id = max_id.saturating_add(1).max(snap.next_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lived_in_browser() -> Browser {
        let mut b = Browser::new();
        let ws = b.active_workspace();
        b.open_tab(ws, "https://a.example", "Alpha").unwrap();
        let pinned = b.open_tab(ws, "https://b.example", "Beta").unwrap();
        b.toggle_pin(ws, pinned).unwrap();
        b.close_tab(ws, pinned).unwrap();
        let research = b.create_workspace("Research").unwrap();
        b.open_tab(research, "https://c.example", "Gamma").unwrap();
        b.switch_workspace(research).unwrap();
        b
    }

    fn observable(b: &Browser) -> (Vec<WorkspaceId>, WorkspaceId, Vec<(TabId, bool)>) {
        let order = b.workspaces();
        let active = b.active_workspace();
        let tabs = b
            .get_workspace(active)
            .unwrap()
            .tabs()
            .iter()
            .map(|id| {
                let tab = b.get_workspace(active).unwrap().get(*id).unwrap();
                (*id, tab.pinned)
            })
            .collect();
        (order, active, tabs)
    }

    #[test]
    fn round_trip_through_json_preserves_observable_state() {
        let before = lived_in_browser();
        let json = serde_json::to_string(&before.snapshot()).unwrap();
        assert!(json.contains("\"version\":1"), "schema version recorded");

        let snap: SessionSnapshot = serde_json::from_str(&json).unwrap();
        let mut after = Browser::new();
        after.restore(&snap).unwrap();

        assert_eq!(observable(&before), observable(&after));
        assert_eq!(
            before
                .get_workspace(before.active_workspace())
                .unwrap()
                .name,
            after.get_workspace(after.active_workspace()).unwrap().name
        );
        assert_eq!(
            before
                .get_workspace(before.active_workspace())
                .unwrap()
                .closed_count(),
            after
                .get_workspace(after.active_workspace())
                .unwrap()
                .closed_count()
        );
    }

    #[test]
    fn unknown_schema_version_refused() {
        let mut snap = lived_in_browser().snapshot();
        snap.version = 999;
        let mut fresh = Browser::new();
        assert_eq!(fresh.restore(&snap), Err(Error::UnsupportedSnapshot(999)));
        // Refusal leaves prior state untouched.
        assert_eq!(fresh.workspaces().len(), 1);
    }

    #[test]
    fn empty_snapshot_refused() {
        let snap = SessionSnapshot {
            version: SNAPSHOT_VERSION,
            workspaces: vec![],
            active: None,
            next_id: 1,
        };
        let mut fresh = Browser::new();
        assert_eq!(fresh.restore(&snap), Err(Error::EmptySnapshot));
    }

    #[test]
    fn dangling_pointers_repaired_deterministically() {
        let mut snap = lived_in_browser().snapshot();
        // Point active workspace and active tab at ids that do not exist.
        snap.active = Some(9999);
        snap.workspaces[0].active_tab = Some(8888);
        let mut fresh = Browser::new();
        fresh.restore(&snap).unwrap();
        // Falls back to the first listed workspace...
        assert_eq!(fresh.active_workspace(), snap.workspaces[0].id);
        // ...whose active tab repaired to its first member tab.
        let ws = fresh.get_workspace(fresh.active_workspace()).unwrap();
        assert_eq!(ws.active_tab(), ws.tabs().first().copied());
    }

    #[test]
    fn ids_never_collide_after_restore() {
        let before = lived_in_browser();
        let max_before = before
            .snapshot()
            .workspaces
            .iter()
            .flat_map(|w| {
                std::iter::once(w.id)
                    .chain(w.tabs.iter().map(|t| t.id))
                    .chain(w.closed.iter().map(|c| c.tab.id))
            })
            .max()
            .unwrap();
        let mut after = Browser::new();
        after.restore(&before.snapshot()).unwrap();
        let ws = after.active_workspace();
        let t = after.open_tab(ws, "https://new.example", "New").unwrap();
        let w = after.create_workspace("Later").unwrap();
        assert!(t > max_before, "tab id {t} reuses restored range");
        assert!(w > max_before, "workspace id {w} reuses restored range");
    }
}
