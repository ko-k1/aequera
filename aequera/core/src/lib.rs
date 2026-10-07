//! `aequera-core`: browser domain concepts and state transitions.
//!
//! Ownership (`docs/ARCHITECTURE.md`): this crate is behavior and domain
//! state — navigation identity, tabs, workspaces, sessions. It is not a UI
//! toolkit and knows nothing about presentation: compact, expanded,
//! sidebar, and keyboard views all project this same model
//! (`docs/design/WORKSPACE.md`).
//!
//! Information model:
//!
//! ```text
//! Browser
//! ├── Workspace A (tabs + active tab + closed-tab stack)
//! ├── Workspace B
//! └── Workspace C
//! ```
//!
//! Rules the model enforces so shells don't have to:
//!
//! - a browser always has at least one workspace;
//! - the active workspace and every active tab always exist;
//! - closing a tab records where it was, so restore is exact;
//! - moving a tab repairs the source workspace exactly like a close.

pub mod command;
pub mod session;

pub type WorkspaceId = u64;
pub type TabId = u64;

/// A live navigation context. Location and presentation state live in the
/// shell; identity and membership live here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tab {
    pub id: TabId,
    pub url: String,
    pub title: String,
    pub pinned: bool,
}

/// A tab removed from a workspace, with its former position for exact restore.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedTab {
    pub tab: Tab,
    pub index: usize,
}

/// A persistent browsing context grouping related tabs and their state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: String,
    tabs: Vec<Tab>,
    active_tab: Option<TabId>,
    closed: Vec<ClosedTab>,
}

impl Workspace {
    /// Tab ids in display order.
    pub fn tabs(&self) -> Vec<TabId> {
        self.tabs.iter().map(|t| t.id).collect()
    }

    pub fn get(&self, tab: TabId) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.id == tab)
    }

    pub fn active_tab(&self) -> Option<TabId> {
        self.active_tab
    }

    /// Most-recently-closed first.
    pub fn closed_count(&self) -> usize {
        self.closed.len()
    }

    fn position(&self, tab: TabId) -> Option<usize> {
        self.tabs.iter().position(|t| t.id == tab)
    }

    /// Repair `active_tab` after the tab at `removed_index` left.
    /// Prefers the tab that slid into its place (same index), else the
    /// predecessor, else nothing when the workspace is now empty.
    fn repair_active(&mut self, removed_index: usize) {
        let current = self.active_tab;
        let still_present = current.is_some_and(|id| self.position(id).is_some());
        if still_present {
            return;
        }
        self.active_tab = self
            .tabs
            .get(removed_index)
            .or_else(|| self.tabs.last())
            .map(|t| t.id);
    }
}

/// The whole browsing session: ordered workspaces plus the active one.
#[derive(Debug)]
pub struct Browser {
    workspaces: Vec<Workspace>,
    active: Option<WorkspaceId>,
    next_id: u64,
}

impl Default for Browser {
    /// `Default` is the valid empty browser: one default workspace, active.
    /// Never a zero-workspace state (see `new()`).
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    EmptyName,
    WorkspaceNotFound(WorkspaceId),
    TabNotFound(TabId),
    LastWorkspace,
    NothingToRestore(WorkspaceId),
    UnsupportedSnapshot(u32),
    EmptySnapshot,
    DuplicateId(u64),
    IdExhausted,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::EmptyName => write!(f, "name must not be empty"),
            Error::WorkspaceNotFound(id) => write!(f, "no workspace {id}"),
            Error::TabNotFound(id) => write!(f, "no tab {id}"),
            Error::LastWorkspace => write!(f, "the last workspace cannot be removed"),
            Error::NothingToRestore(id) => write!(f, "workspace {id} has no closed tabs"),
            Error::UnsupportedSnapshot(v) => {
                write!(f, "snapshot schema v{v} is not supported by this build")
            }
            Error::EmptySnapshot => write!(f, "snapshot contains no workspaces"),
            Error::DuplicateId(id) => write!(f, "duplicate id {id} in snapshot"),
            Error::IdExhausted => write!(f, "id space exhausted"),
        }
    }
}

impl std::error::Error for Error {}

impl Browser {
    /// A browser starts with one default workspace, active. There is no
    /// valid browser state without a workspace to browse in.
    pub fn new() -> Self {
        let mut browser = Browser {
            workspaces: Vec::new(),
            active: None,
            next_id: 1,
        };
        let id = browser.issue_id();
        browser.workspaces.push(Workspace {
            id,
            name: "Workspace 1".into(),
            tabs: Vec::new(),
            active_tab: None,
            closed: Vec::new(),
        });
        browser.active = Some(id);
        browser
    }

    /// Workspace ids in display order.
    pub fn workspaces(&self) -> Vec<WorkspaceId> {
        self.workspaces.iter().map(|w| w.id).collect()
    }

    pub fn active_workspace(&self) -> WorkspaceId {
        self.active.expect("browser always has an active workspace")
    }

    pub fn get_workspace(&self, id: WorkspaceId) -> Result<&Workspace, Error> {
        self.workspaces
            .iter()
            .find(|w| w.id == id)
            .ok_or(Error::WorkspaceNotFound(id))
    }

    fn get_workspace_mut(&mut self, id: WorkspaceId) -> Result<&mut Workspace, Error> {
        self.workspaces
            .iter_mut()
            .find(|w| w.id == id)
            .ok_or(Error::WorkspaceNotFound(id))
    }

    pub fn create_workspace(&mut self, name: &str) -> Result<WorkspaceId, Error> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::EmptyName);
        }
        let id = self.try_issue_id()?;
        self.workspaces.push(Workspace {
            id,
            name: name.to_string(),
            tabs: Vec::new(),
            active_tab: None,
            closed: Vec::new(),
        });
        Ok(id)
    }

    pub fn rename_workspace(&mut self, id: WorkspaceId, name: &str) -> Result<(), Error> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::EmptyName);
        }
        self.get_workspace_mut(id)?.name = name.to_string();
        Ok(())
    }

    /// Remove a workspace and close its tabs with it. The last workspace
    /// cannot be removed; activity falls to the nearest neighbor.
    /// Returns the removed workspace (tabs included) for callers that
    /// surface undo.
    pub fn remove_workspace(&mut self, id: WorkspaceId) -> Result<Workspace, Error> {
        if self.workspaces.len() == 1 {
            return Err(Error::LastWorkspace);
        }
        let index = self
            .workspaces
            .iter()
            .position(|w| w.id == id)
            .ok_or(Error::WorkspaceNotFound(id))?;
        let removed = self.workspaces.remove(index);
        if self.active == Some(id) {
            let neighbor = self.workspaces.get(index.min(self.workspaces.len() - 1));
            self.active = neighbor.map(|w| w.id);
        }
        Ok(removed)
    }

    /// Switching is immediate and total: one pointer move, always visible.
    /// Workspace switches are high-frequency interactions, so this does no
    /// allocation beyond the lookup.
    pub fn switch_workspace(&mut self, id: WorkspaceId) -> Result<(), Error> {
        self.get_workspace(id)?;
        self.active = Some(id);
        Ok(())
    }

    /// Open a tab and activate it. Background-open is a separate, later
    /// operation — the default matches "the thing I just opened is current".
    pub fn open_tab(
        &mut self,
        workspace: WorkspaceId,
        url: &str,
        title: &str,
    ) -> Result<TabId, Error> {
        let id = self.try_issue_id()?;
        let ws = self.get_workspace_mut(workspace)?;
        ws.tabs.push(Tab {
            id,
            url: url.to_string(),
            title: title.to_string(),
            pinned: false,
        });
        ws.active_tab = Some(id);
        Ok(id)
    }

    /// Close a tab, recording its position for exact restore. Activity falls
    /// to the tab that takes its place, as in `Workspace::repair_active`.
    pub fn close_tab(&mut self, workspace: WorkspaceId, tab: TabId) -> Result<ClosedTab, Error> {
        let ws = self.get_workspace_mut(workspace)?;
        let index = ws.position(tab).ok_or(Error::TabNotFound(tab))?;
        let closed_tab = ws.tabs.remove(index);
        ws.repair_active(index);
        let closed = ClosedTab {
            tab: closed_tab,
            index,
        };
        ws.closed.push(closed.clone());
        Ok(closed)
    }

    /// Restore the most recently closed tab at its former position
    /// (clamped when the workspace shrank since) and activate it.
    pub fn restore_closed(&mut self, workspace: WorkspaceId) -> Result<TabId, Error> {
        let ws = self.get_workspace_mut(workspace)?;
        let closed = ws.closed.pop().ok_or(Error::NothingToRestore(workspace))?;
        let index = closed.index.min(ws.tabs.len());
        let id = closed.tab.id;
        ws.tabs.insert(index, closed.tab);
        ws.active_tab = Some(id);
        Ok(id)
    }

    pub fn switch_tab(&mut self, workspace: WorkspaceId, tab: TabId) -> Result<(), Error> {
        let ws = self.get_workspace_mut(workspace)?;
        if ws.position(tab).is_none() {
            return Err(Error::TabNotFound(tab));
        }
        ws.active_tab = Some(tab);
        Ok(())
    }

    /// Move a tab across (or within) workspaces. The source repairs exactly
    /// like a close (without recording); the moved tab activates in the
    /// destination so the user's intent stays visible.
    ///
    /// Validates both endpoints before mutating: a bad destination or
    /// unknown tab leaves all state untouched (no tab loss).
    pub fn move_tab(
        &mut self,
        tab: TabId,
        from: WorkspaceId,
        to: WorkspaceId,
        index: usize,
    ) -> Result<(), Error> {
        // Validate first: no mutation until both workspaces and the tab
        // are known to exist.
        let source_index = self
            .get_workspace(from)?
            .position(tab)
            .ok_or(Error::TabNotFound(tab))?;
        // Validates `to` exists before the source is touched.
        self.get_workspace(to)?;
        // Borrow discipline: remove first, then re-borrow the destination.
        let moving = self.get_workspace_mut(from)?.tabs.remove(source_index);
        {
            let source = self.get_workspace_mut(from)?;
            source.repair_active(source_index);
        }
        let dest = self.get_workspace_mut(to)?;
        let at = index.min(dest.tabs.len());
        dest.tabs.insert(at, moving);
        dest.active_tab = Some(tab);
        Ok(())
    }

    pub fn toggle_pin(&mut self, workspace: WorkspaceId, tab: TabId) -> Result<bool, Error> {
        let ws = self.get_workspace_mut(workspace)?;
        let slot = ws
            .tabs
            .iter_mut()
            .find(|t| t.id == tab)
            .ok_or(Error::TabNotFound(tab))?;
        slot.pinned = !slot.pinned;
        Ok(slot.pinned)
    }

    fn try_issue_id(&mut self) -> Result<u64, Error> {
        let id = self.next_id;
        // Fail with Err, never panic or wrap: wrapping would reuse ids and
        // break the uniqueness invariant. Exhaustion is unreachable except
        // via a crafted snapshot, which `restore` already rejects.
        self.next_id = self.next_id.checked_add(1).ok_or(Error::IdExhausted)?;
        Ok(id)
    }

    // Legacy name kept for the infallible `new()` path only.
    fn issue_id(&mut self) -> u64 {
        self.try_issue_id()
            .expect("fresh browser id space cannot be exhausted")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn browser_with_tabs() -> (Browser, WorkspaceId, Vec<TabId>) {
        let mut b = Browser::new();
        let ws = b.active_workspace();
        let ids = [
            "https://a.example",
            "https://b.example",
            "https://c.example",
        ]
        .iter()
        .map(|url| b.open_tab(ws, url, url).unwrap())
        .collect();
        (b, ws, ids)
    }

    /// Structural invariants every test can assert after any operation.
    fn assert_invariants(b: &Browser) {
        assert!(!b.workspaces.is_empty(), "a browser has workspaces");
        assert!(
            b.workspaces.iter().any(|w| Some(w.id) == b.active),
            "active workspace exists"
        );
        let mut seen = std::collections::HashSet::new();
        for w in &b.workspaces {
            assert!(seen.insert(w.id), "workspace ids unique");
            for t in &w.tabs {
                assert!(seen.insert(t.id), "tab ids unique across workspaces");
            }
            if let Some(active) = w.active_tab {
                assert!(
                    w.position(active).is_some(),
                    "active tab is a member of its workspace"
                );
            }
            if w.tabs.is_empty() {
                assert_eq!(w.active_tab, None, "empty workspace has no active tab");
            }
        }
    }

    #[test]
    fn new_browser_has_one_active_default_workspace() {
        let b = Browser::new();
        assert_eq!(b.workspaces().len(), 1);
        assert_eq!(b.active_workspace(), b.workspaces()[0]);
        assert_invariants(&b);
    }

    #[test]
    fn default_is_a_valid_browser() {
        let b = Browser::default();
        assert_eq!(b.workspaces().len(), 1);
        // Must not panic: Default is a valid browser, not an empty shell.
        let _ = b.active_workspace();
        assert_invariants(&b);
    }

    #[test]
    fn create_rename_and_switch_workspaces() {
        let mut b = Browser::new();
        let first = b.active_workspace();
        let second = b.create_workspace("Research").unwrap();
        assert_ne!(first, second);
        b.switch_workspace(second).unwrap();
        assert_eq!(b.active_workspace(), second);
        b.rename_workspace(second, "Deep research").unwrap();
        assert_eq!(b.get_workspace(second).unwrap().name, "Deep research");
        assert!(b.rename_workspace(second, "   ").is_err());
        assert!(b.create_workspace("").is_err());
        assert!(b.switch_workspace(999).is_err());
        assert_invariants(&b);
    }

    #[test]
    fn remove_workspace_falls_back_to_neighbor() {
        let mut b = Browser::new();
        let first = b.active_workspace();
        let second = b.create_workspace("B").unwrap();
        let third = b.create_workspace("C").unwrap();
        b.switch_workspace(second).unwrap();
        let removed = b.remove_workspace(second).unwrap();
        assert_eq!(removed.name, "B");
        // Same index now holds the neighbor that slid into place.
        assert_eq!(b.active_workspace(), third);
        assert_eq!(b.workspaces(), vec![first, third]);
        assert!(b.remove_workspace(999).is_err());
        assert_invariants(&b);
    }

    #[test]
    fn last_workspace_cannot_be_removed() {
        let mut b = Browser::new();
        let only = b.active_workspace();
        assert_eq!(b.remove_workspace(only), Err(Error::LastWorkspace));
        assert_invariants(&b);
    }

    #[test]
    fn open_activates_and_close_repairs_to_next() {
        let (mut b, ws, ids) = browser_with_tabs();
        assert_eq!(b.get_workspace(ws).unwrap().active_tab(), Some(ids[2]));
        b.switch_tab(ws, ids[0]).unwrap();
        b.close_tab(ws, ids[0]).unwrap();
        // The tab at the same index (old ids[1]) takes over.
        assert_eq!(b.get_workspace(ws).unwrap().active_tab(), Some(ids[1]));
        assert_invariants(&b);
    }

    #[test]
    fn close_last_tab_leaves_empty_workspace_without_active() {
        let mut b = Browser::new();
        let ws = b.active_workspace();
        let only = b.open_tab(ws, "https://solo.example", "solo").unwrap();
        b.close_tab(ws, only).unwrap();
        let w = b.get_workspace(ws).unwrap();
        assert!(w.tabs().is_empty());
        assert_eq!(w.active_tab(), None);
        assert_invariants(&b);
    }

    #[test]
    fn restore_returns_tab_to_former_position_and_activates() {
        let (mut b, ws, ids) = browser_with_tabs();
        b.close_tab(ws, ids[0]).unwrap();
        b.close_tab(ws, ids[2]).unwrap();
        // Most recent first.
        assert_eq!(b.restore_closed(ws).unwrap(), ids[2]);
        assert_eq!(b.get_workspace(ws).unwrap().tabs(), vec![ids[1], ids[2]]);
        assert_eq!(b.restore_closed(ws).unwrap(), ids[0]);
        assert_eq!(
            b.get_workspace(ws).unwrap().tabs(),
            vec![ids[0], ids[1], ids[2]]
        );
        assert_eq!(b.get_workspace(ws).unwrap().active_tab(), Some(ids[0]));
        assert_eq!(b.restore_closed(ws), Err(Error::NothingToRestore(ws)));
        assert_invariants(&b);
    }

    #[test]
    fn move_tab_across_workspaces_repairs_source_and_focuses_dest() {
        let (mut b, src, ids) = browser_with_tabs();
        let dest = b.create_workspace("Dest").unwrap();
        // Activate the tab under test so the source must repair around it.
        b.switch_tab(src, ids[0]).unwrap();
        b.move_tab(ids[0], src, dest, 0).unwrap();
        assert_eq!(b.get_workspace(src).unwrap().tabs(), vec![ids[1], ids[2]]);
        assert_eq!(b.get_workspace(dest).unwrap().tabs(), vec![ids[0]]);
        assert_eq!(b.get_workspace(dest).unwrap().active_tab(), Some(ids[0]));
        // Source activity repaired to the tab that took its place.
        assert_eq!(b.get_workspace(src).unwrap().active_tab(), Some(ids[1]));
        // Unknown tab or workspace fails without mutating (no tab loss).
        let tabs_before = b.get_workspace(src).unwrap().tabs();
        assert!(b.move_tab(999, src, dest, 0).is_err());
        assert_eq!(b.get_workspace(src).unwrap().tabs(), tabs_before);
        let tabs_before = b.get_workspace(src).unwrap().tabs();
        assert!(b.move_tab(ids[1], src, 999, 0).is_err());
        assert_eq!(
            b.get_workspace(src).unwrap().tabs(),
            tabs_before,
            "failed move to unknown workspace must not lose the tab"
        );
        assert!(b.get_workspace(src).unwrap().get(ids[1]).is_some());
        assert_invariants(&b);
    }

    #[test]
    fn pin_toggles() {
        let (mut b, ws, ids) = browser_with_tabs();
        assert!(b.toggle_pin(ws, ids[0]).unwrap());
        assert!(!b.toggle_pin(ws, ids[0]).unwrap());
        assert!(b.toggle_pin(ws, 999).is_err());
        assert_invariants(&b);
    }

    #[test]
    fn unknown_ids_fail_cleanly() {
        let mut b = Browser::new();
        let ws = b.active_workspace();
        assert_eq!(b.switch_tab(ws, 999), Err(Error::TabNotFound(999)));
        assert_eq!(
            b.get_workspace(999).unwrap_err(),
            Error::WorkspaceNotFound(999)
        );
        assert_invariants(&b);
    }
}
