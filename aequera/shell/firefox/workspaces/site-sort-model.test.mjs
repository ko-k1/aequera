// Unit tests for the pure "Sort tabs by site" model (the file the browser loads).
// Run: node --test aequera/shell/firefox/workspaces/site-sort-model.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import model from "./site-sort-model.js";

const { DEFAULT_OVER, normalizeOver, addressKey, planSort } = model;

const WORKSPACES = [{ id: "ws-1", name: "Personal" }];
let accessed = 0;
const tab = (url, site, extra = {}) => ({
  key: url,
  url,
  site,
  sortable: true,
  selected: false,
  sharing: false,
  lastAccessed: ++accessed,
  ...extra,
});
const many = (site, count, start = 0) =>
  Array.from({ length: count }, (_, i) => tab(`https://${site}/p${String(start + i).padStart(2, "0")}`, site));

test("over defaults to 7 and recovers from bad values; 0 is kept", () => {
  assert.equal(DEFAULT_OVER, 7);
  assert.equal(normalizeOver(3), 3);
  assert.equal(normalizeOver(0), 0);
  for (const bad of [-1, 2.5, NaN, "7", null, undefined]) {
    assert.equal(normalizeOver(bad), 7);
  }
});

test("addressKey ignores the scheme and www.", () => {
  assert.equal(addressKey("https://www.Example.com/A"), "example.com/a");
  assert.equal(addressKey("http://example.com/b"), "example.com/b");
  assert.equal(addressKey("about:config"), "about:config");
});

test("sorts by site, then address; non-web pages last", () => {
  const tabs = [
    tab("about:newtab", null),
    tab("https://news.ycombinator.com/item", "ycombinator.com"),
    tab("https://docs.github.com/z", "github.com"),
    tab("http://github.com/a", "github.com"),
    tab("file:///home/x.txt", null),
    tab("https://www.bbc.co.uk/news", "bbc.co.uk"),
  ];
  const plan = planSort(WORKSPACES, "ws-1", tabs);
  assert.deepEqual(plan.order, [
    "https://www.bbc.co.uk/news",
    "https://docs.github.com/z",
    "http://github.com/a",
    "https://news.ycombinator.com/item",
    "about:newtab",
    "file:///home/x.txt",
  ]);
  assert.deepEqual(plan.moves, []);
  assert.equal(plan.select, null);
});

test("equal addresses keep their tab order (stable)", () => {
  const a = tab("https://a.com/", "a.com", { key: "first" });
  const b = tab("https://a.com/", "a.com", { key: "second" });
  assert.deepEqual(planSort(WORKSPACES, "ws-1", [a, b]).order, ["first", "second"]);
  assert.deepEqual(planSort(WORKSPACES, "ws-1", [b, a]).order, ["second", "first"]);
});

test("exactly 7 tabs of a site stay; 8 move to a new workspace named after it", () => {
  const stay = planSort(WORKSPACES, "ws-1", [...many("github.com", 7), tab("https://a.com/", "a.com")]);
  assert.deepEqual(stay.moves, []);
  assert.equal(stay.order.length, 8);

  const github = many("github.com", 8);
  const plan = planSort(WORKSPACES, "ws-1", [tab("https://a.com/", "a.com"), ...github.toReversed()]);
  assert.deepEqual(plan.moves, [{ workspace: null, name: "github.com", keys: github.map(t => t.key) }]);
  assert.deepEqual(plan.order, ["https://a.com/"]);
});

test("the threshold is configurable and 0 never moves", () => {
  const tabs = [...many("a.com", 3), tab("https://b.com/", "b.com")];
  assert.equal(planSort(WORKSPACES, "ws-1", tabs, { over: 2 }).moves.length, 1);
  assert.equal(planSort(WORKSPACES, "ws-1", tabs, { over: 3 }).moves.length, 0);
  assert.equal(planSort(WORKSPACES, "ws-1", [...many("a.com", 50), ...tabs], { over: 0 }).moves.length, 0);
});

test("an existing workspace of that name is reused (case-insensitive)", () => {
  const workspaces = [...WORKSPACES, { id: "ws-4", name: "GitHub.com" }];
  const plan = planSort(workspaces, "ws-1", [...many("github.com", 8), tab("https://a.com/", "a.com")]);
  assert.equal(plan.moves[0].workspace, "ws-4");
});

test("sorting inside the site's own workspace moves nothing", () => {
  const workspaces = [...WORKSPACES, { id: "ws-2", name: "github.com" }];
  const plan = planSort(workspaces, "ws-2", [...many("github.com", 9), tab("https://a.com/", "a.com")]);
  assert.deepEqual(plan.moves, []);
  assert.equal(plan.order.length, 10);
});

test("the workspace never empties", () => {
  // One site only: already alone, nothing moves.
  assert.deepEqual(planSort(WORKSPACES, "ws-1", many("github.com", 12)).moves, []);
  // Two big sites and nothing else: the first moves, the last stays.
  const plan = planSort(WORKSPACES, "ws-1", [...many("b.com", 8), ...many("a.com", 9)]);
  assert.deepEqual(plan.moves.map(m => m.name), ["a.com"]);
  assert.equal(plan.order.length, 8);
  // A grouped tab that stays is enough to keep the workspace.
  const grouped = tab("https://c.com/", "c.com", { sortable: false });
  assert.deepEqual(planSort(WORKSPACES, "ws-1", [grouped, ...many("a.com", 8)]).moves.map(m => m.name), ["a.com"]);
});

test("grouped and split tabs neither sort nor move nor count", () => {
  const grouped = many("a.com", 3).map(t => ({ ...t, sortable: false }));
  const plan = planSort(WORKSPACES, "ws-1", [...grouped, ...many("a.com", 7, 10), tab("https://b.com/", "b.com")]);
  assert.deepEqual(plan.moves, []);
  assert.ok(grouped.every(t => !plan.order.includes(t.key)));
});

test("tabs sharing camera, mic, or screen stay (they cannot be hidden)", () => {
  const github = many("github.com", 8);
  github[0].sharing = true;
  const plan = planSort(WORKSPACES, "ws-1", [...github, ...many("x.com", 2)]);
  assert.deepEqual(plan.moves, []);
  assert.ok(plan.order.includes(github[0].key));

  github.push(...many("github.com", 1, 50));
  const moved = planSort(WORKSPACES, "ws-1", [...github, ...many("x.com", 2)]);
  assert.equal(moved.moves[0].keys.length, 8);
  assert.ok(moved.order.includes(github[0].key));
});

test("when the selected tab moves, the most recently used staying tab is selected", () => {
  const github = many("github.com", 8);
  github[3].selected = true;
  const older = tab("https://a.com/old", "a.com", { lastAccessed: 1 });
  const recent = tab("https://a.com/recent", "a.com", { lastAccessed: 1e9 });
  const plan = planSort(WORKSPACES, "ws-1", [older, ...github, recent]);
  assert.equal(plan.select, recent.key);

  const staying = planSort(WORKSPACES, "ws-1", [{ ...older, selected: true }, ...many("github.com", 8)]);
  assert.equal(staying.select, null);
});

test("several sites move in site order, each to its own workspace", () => {
  const plan = planSort(WORKSPACES, "ws-1", [
    ...many("z.com", 8),
    tab("https://keep.com/", "keep.com"),
    ...many("m.com", 9),
  ]);
  assert.deepEqual(
    plan.moves.map(m => [m.name, m.keys.length]),
    [
      ["m.com", 9],
      ["z.com", 8],
    ]
  );
  assert.deepEqual(plan.order, ["https://keep.com/"]);
});

test("inputs are not mutated", () => {
  const tabs = [tab("https://b.com/", "b.com"), tab("https://a.com/", "a.com")];
  const copy = structuredClone(tabs);
  planSort(WORKSPACES, "ws-1", tabs);
  assert.deepEqual(tabs, copy);
});
