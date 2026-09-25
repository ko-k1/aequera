// Unit tests for the pure workspace model. Run: node --test aequera/shell/firefox/workspaces
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKSPACE_SOURCE,
  normalizeState,
  initialState,
  createWorkspace,
  membershipOf,
  planSwitch,
} from "./workspace-model.mjs";

const two = () => createWorkspace(initialState(), "Work").state;
const tab = (key, workspace, extra = {}) => ({
  key,
  workspace,
  pinned: false,
  hidden: false,
  hiddenBy: null,
  selected: false,
  sharing: false,
  ...extra,
});

test("initialState has exactly one active workspace", () => {
  const state = initialState();
  assert.equal(state.workspaces.length, 1);
  assert.equal(state.active, state.workspaces[0].id);
});

test("normalizeState recovers to a known-good state from bad input", () => {
  for (const raw of [undefined, "", "not json", "{}", '{"workspaces":[]}', '{"workspaces":[{"id":""}]}']) {
    const state = normalizeState(raw);
    assert.equal(state.workspaces.length, 1, `input ${JSON.stringify(raw)}`);
    assert.equal(state.active, state.workspaces[0].id);
  }
});

test("normalizeState keeps valid workspaces, drops invalid/duplicate ones, repairs active", () => {
  const raw = JSON.stringify({
    workspaces: [
      { id: "a", name: "A" },
      { id: "a", name: "dup" },
      { id: 7, name: "bad id" },
      { id: "b", name: "" },
    ],
    active: "missing",
  });
  const state = normalizeState(raw);
  assert.deepEqual(state.workspaces.map(w => w.id), ["a", "b"]);
  assert.equal(state.workspaces[1].name, "Workspace 2", "empty name gets a default");
  assert.equal(state.active, "a", "dangling active falls back to the first");
});

test("createWorkspace appends with a unique id and never mutates its input", () => {
  const before = initialState();
  const snapshot = JSON.stringify(before);
  const { state, workspace } = createWorkspace(before, "Work");
  assert.equal(JSON.stringify(before), snapshot, "input untouched");
  assert.equal(state.workspaces.length, 2);
  assert.equal(workspace.name, "Work");
  assert.notEqual(workspace.id, before.workspaces[0].id);
  const again = createWorkspace(state).workspace;
  assert.ok(![...state.workspaces.map(w => w.id)].includes(again.id), "ids stay unique");
});

test("membershipOf falls back to the first workspace for unknown or missing ids", () => {
  const state = two();
  const [first, second] = state.workspaces;
  assert.equal(membershipOf(tab("t", second.id), state), second.id);
  assert.equal(membershipOf(tab("t", "gone"), state), first.id);
  assert.equal(membershipOf(tab("t", null), state), first.id);
});

test("planSwitch hides the other workspace and shows the target's own hidden tabs", () => {
  const state = two();
  const [p, w] = state.workspaces.map(x => x.id);
  const tabs = [
    tab("p1", p, { selected: true }),
    tab("p2", p),
    tab("w1", w, { hidden: true, hiddenBy: WORKSPACE_SOURCE }),
  ];
  const plan = planSwitch(state, tabs, w);
  assert.deepEqual(plan.show, ["w1"]);
  assert.deepEqual(plan.hide, ["p1", "p2"]);
  assert.equal(plan.select, "w1", "selection moves into the target before hiding");
  assert.equal(plan.openNew, false);
});

test("planSwitch never touches pinned tabs, sharing tabs, or tabs hidden by someone else", () => {
  const state = two();
  const [p, w] = state.workspaces.map(x => x.id);
  const tabs = [
    tab("pinned", p, { pinned: true, selected: true }),
    tab("sharing", p, { sharing: true }),
    tab("ext", w, { hidden: true, hiddenBy: "extension@example" }),
    tab("w1", w, { hidden: true, hiddenBy: WORKSPACE_SOURCE }),
  ];
  const plan = planSwitch(state, tabs, w);
  assert.deepEqual(plan.show, ["w1"], "extension-hidden tab stays hidden");
  assert.deepEqual(plan.hide, [], "pinned and sharing tabs stay visible");
  assert.equal(plan.select, null, "a pinned selected tab is global: keep it");
});

test("planSwitch prefers the target's last selected tab", () => {
  const state = two();
  const [p, w] = state.workspaces.map(x => x.id);
  const tabs = [
    tab("p1", p, { selected: true }),
    tab("w1", w, { hidden: true, hiddenBy: WORKSPACE_SOURCE }),
    tab("w2", w, { hidden: true, hiddenBy: WORKSPACE_SOURCE }),
  ];
  assert.equal(planSwitch(state, tabs, w, { lastSelected: "w2" }).select, "w2");
  assert.equal(planSwitch(state, tabs, w, { lastSelected: "p1" }).select, "w1", "ignores a last-selected outside the target");
});

test("planSwitch into an empty workspace asks for a new tab", () => {
  const state = two();
  const [p, w] = state.workspaces.map(x => x.id);
  const plan = planSwitch(state, [tab("p1", p, { selected: true })], w);
  assert.equal(plan.openNew, true);
  assert.equal(plan.select, null);
  assert.deepEqual(plan.hide, ["p1"]);
});

test("planSwitch to the active workspace is a visibility repair, not a selection change", () => {
  const state = two();
  const [p, w] = state.workspaces.map(x => x.id);
  const tabs = [
    tab("p1", p, { selected: true }),
    tab("w1", w), // wrongly visible, e.g. after a restore
    tab("p2", p, { hidden: true, hiddenBy: WORKSPACE_SOURCE }),
  ];
  const plan = planSwitch(state, tabs, p);
  assert.deepEqual(plan.hide, ["w1"]);
  assert.deepEqual(plan.show, ["p2"]);
  assert.equal(plan.select, null);
});

test("planSwitch to an unknown workspace is refused", () => {
  assert.throws(() => planSwitch(two(), [], "nope"), /unknown workspace/);
});
