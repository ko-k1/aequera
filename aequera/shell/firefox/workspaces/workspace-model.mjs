/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Aequera workspaces: pure model (no Firefox APIs; unit-tested with node).
//
// A window holds ordered workspaces; every non-pinned tab belongs to exactly
// one. Switching shows the target's tabs and hides the rest using Firefox's
// native hidden-tab mechanism. The window controller (aequera-workspaces.js)
// turns the plans computed here into gBrowser calls and persists state with
// SessionStore. All functions return new values and never mutate inputs.

/** hiddenBy source for tabs this feature hides. Only these are ever shown
 *  again: tabs hidden by extensions keep their own state. */
export const WORKSPACE_SOURCE = "aequera-workspaces";

const defaultName = index => `Workspace ${index + 1}`;

/**
 * @typedef {{ id: string, name: string }} Workspace
 * @typedef {{ workspaces: Workspace[], active: string, nextId: number }} State
 */

/** @returns {State} */
export function initialState() {
  return { workspaces: [{ id: "ws-1", name: "Personal" }], active: "ws-1", nextId: 2 };
}

/**
 * Parse persisted JSON into a valid State. Anything unusable recovers to a
 * known-good state instead of throwing (configuration failures must not
 * break the window).
 *
 * @param {string | undefined} raw
 * @returns {State}
 */
export function normalizeState(raw) {
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const list = Array.isArray(parsed?.workspaces) ? parsed.workspaces : [];
  const seen = new Set();
  const workspaces = [];
  for (const item of list) {
    const id = item?.id;
    if (typeof id !== "string" || !id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const name =
      typeof item.name === "string" && item.name.trim()
        ? item.name.trim()
        : defaultName(workspaces.length);
    workspaces.push({ id, name });
  }
  if (!workspaces.length) {
    return initialState();
  }
  const active = seen.has(parsed.active) ? parsed.active : workspaces[0].id;
  const numericIds = workspaces
    .map(w => Number(/^ws-(\d+)$/.exec(w.id)?.[1]))
    .filter(Number.isFinite);
  const nextId = Math.max(
    Number.isInteger(parsed.nextId) ? parsed.nextId : 0,
    numericIds.length ? Math.max(...numericIds) + 1 : 1
  );
  return { workspaces, active, nextId };
}

/**
 * @param {State} state
 * @param {string} [name]
 * @returns {{ state: State, workspace: Workspace }}
 */
export function createWorkspace(state, name) {
  const workspace = {
    id: `ws-${state.nextId}`,
    name: name?.trim() || defaultName(state.workspaces.length),
  };
  return {
    state: { ...state, workspaces: [...state.workspaces, workspace], nextId: state.nextId + 1 },
    workspace,
  };
}

/** @returns {State} */
export function withActive(state, id) {
  if (!state.workspaces.some(w => w.id === id)) {
    throw new Error(`unknown workspace ${id}`);
  }
  return { ...state, active: id };
}

/**
 * The workspace a tab belongs to. Tabs with no or a stale workspace id
 * belong to the first workspace, so no tab is ever orphaned.
 */
export function membershipOf(tab, state) {
  return state.workspaces.some(w => w.id === tab.workspace)
    ? tab.workspace
    : state.workspaces[0].id;
}

/**
 * @typedef {object} TabInfo
 * @property {*} key         opaque identity handed back in the plan
 * @property {string|null} workspace
 * @property {boolean} pinned    pinned tabs are global (never hidden)
 * @property {boolean} hidden
 * @property {string|null} hiddenBy
 * @property {boolean} selected
 * @property {boolean} sharing   camera/mic/screen sharing: cannot be hidden
 */

/**
 * What switching to `target` must do. The controller applies it in order:
 * open a new tab (if openNew) or select `select`, then show, then hide
 * (Firefox refuses to hide the selected tab).
 *
 * @param {State} state
 * @param {TabInfo[]} tabs
 * @param {string} target
 * @param {{ lastSelected?: * }} [options]
 * @returns {{ show: *[], hide: *[], select: *|null, openNew: boolean }}
 */
export function planSwitch(state, tabs, target, { lastSelected } = {}) {
  if (!state.workspaces.some(w => w.id === target)) {
    throw new Error(`unknown workspace ${target}`);
  }
  const inTarget = t => membershipOf(t, state) === target;
  const ours = t => t.hidden && t.hiddenBy === WORKSPACE_SOURCE;
  const movable = tabs.filter(t => !t.pinned);

  const show = movable.filter(t => inTarget(t) && ours(t)).map(t => t.key);
  const hide = movable.filter(t => !inTarget(t) && !t.hidden && !t.sharing).map(t => t.key);

  const selected = tabs.find(t => t.selected);
  const keepsSelection = !selected || selected.pinned || selected.sharing || inTarget(selected);
  if (keepsSelection) {
    return { show, hide, select: null, openNew: false };
  }
  // Candidates: target tabs that will be visible after the switch.
  const reachable = movable.filter(t => inTarget(t) && (!t.hidden || ours(t)));
  const preferred = reachable.find(t => t.key === lastSelected) ?? reachable[0];
  return preferred
    ? { show, hide, select: preferred.key, openNew: false }
    : { show, hide, select: null, openNew: true };
}
