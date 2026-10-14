// Unit tests for the pure workspace model (the same file the browser loads).
// Run: node --test aequera/shell/firefox/workspaces/workspace-model.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import model from "./workspace-model.js";

const {
  WORKSPACE_SOURCE,
  normalizeState,
  initialState,
  createWorkspace,
  workspaceForDigit,
  digitForWorkspace,
  planClose,
  removeWorkspace,
  membershipOf,
  planSwitch,
} = model;

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

/** A state with `count` workspaces ws-1..ws-count. */
const withWorkspaces = count => {
  let state = initialState();
  while (state.workspaces.length < count) {
    state = createWorkspace(state).state;
  }
  return state;
};

test("digits 1..8 reach that workspace and 9 the last one", () => {
  const three = withWorkspaces(3);
  assert.equal(workspaceForDigit(three, 1), "ws-1");
  assert.equal(workspaceForDigit(three, 3), "ws-3");
  assert.equal(workspaceForDigit(three, 4), null, "no 4th workspace");
  assert.equal(workspaceForDigit(three, 9), "ws-3", "9 is the last");
  const twelve = withWorkspaces(12);
  assert.equal(workspaceForDigit(twelve, 8), "ws-8");
  assert.equal(workspaceForDigit(twelve, 9), "ws-12");
  for (const bad of [0, 10, 1.5, "1", NaN]) {
    assert.equal(workspaceForDigit(three, bad), null);
  }
});

test("the digit shown for a workspace is the one that reaches it", () => {
  const three = withWorkspaces(3);
  assert.deepEqual(
    three.workspaces.map(w => digitForWorkspace(three, w.id)),
    [1, 2, 3],
    "with 8 or fewer, each shows its position"
  );
  const ten = withWorkspaces(10);
  assert.deepEqual(
    ten.workspaces.map(w => digitForWorkspace(ten, w.id)),
    [1, 2, 3, 4, 5, 6, 7, 8, null, 9]
  );
  assert.equal(digitForWorkspace(three, "nope"), null);
  for (const state of [three, ten, withWorkspaces(9)]) {
    for (const w of state.workspaces) {
      const digit = digitForWorkspace(state, w.id);
      if (digit) {
        assert.equal(workspaceForDigit(state, digit), w.id, `${w.id} via ${digit}`);
      }
    }
  }
});

test("planClose closes the workspace's tabs; pinned and other tabs stay", () => {
  const state = withWorkspaces(3);
  const tabs = [
    tab("a1", "ws-1"),
    tab("b1", "ws-2", { hidden: true, hiddenBy: WORKSPACE_SOURCE }),
    tab("b2", "ws-2", { hidden: true, hiddenBy: WORKSPACE_SOURCE }),
    tab("pin", null, { pinned: true }),
  ];
  assert.deepEqual(planClose(state, tabs, "ws-2"), { switchTo: null, close: ["b1", "b2"] });
  assert.deepEqual(planClose(state, [], "ws-3"), { switchTo: null, close: [] }, "an empty one closes too");
});

test("closing the active workspace switches to the next one, else the previous one", () => {
  const state = withWorkspaces(3);
  assert.equal(planClose({ ...state, active: "ws-2" }, [], "ws-2").switchTo, "ws-3");
  assert.equal(planClose({ ...state, active: "ws-3" }, [], "ws-3").switchTo, "ws-2");
  assert.equal(planClose({ ...state, active: "ws-1" }, [], "ws-1").switchTo, "ws-2");
});

test("tabs with a stale workspace close with the first workspace (where they belong)", () => {
  const state = withWorkspaces(2);
  assert.deepEqual(planClose(state, [tab("old", "ws-gone"), tab("a", "ws-1")], "ws-1").close, ["old", "a"]);
});

test("the only workspace and unknown ones cannot close", () => {
  assert.equal(planClose(initialState(), [tab("a", "ws-1")], "ws-1"), null);
  assert.equal(planClose(withWorkspaces(2), [], "nope"), null);
  assert.throws(() => removeWorkspace(initialState(), "ws-1"), /cannot remove/);
});

test("removeWorkspace keeps order, moves the active one, and never reuses ids", () => {
  const state = { ...withWorkspaces(3), active: "ws-2" };
  const after = removeWorkspace(state, "ws-2");
  assert.deepEqual(after.workspaces.map(w => w.id), ["ws-1", "ws-3"]);
  assert.equal(after.active, "ws-3");
  assert.equal(removeWorkspace(state, "ws-3").active, "ws-2", "closing another keeps the active one");
  const { workspace } = createWorkspace(after);
  assert.equal(workspace.id, "ws-4", "a new workspace does not take the closed one's id");
  assert.equal(state.workspaces.length, 3, "input not mutated");
});
