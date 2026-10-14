// Unit tests for the pure command-surface model (the same file the browser loads).
// Run: node --test aequera/shell/firefox/command/command-model.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import model from "./command-model.js";

const { MAX_ROWS, matches, normalizeQuery, rows } = model;

const sources = (extra = {}) => ({
  workspaces: [
    { id: "ws-1", name: "Personal", tabCount: 3 },
    { id: "ws-2", name: "Work", tabCount: 1 },
    { id: "ws-3", name: "Research notes", tabCount: 0 },
  ],
  active: "ws-1",
  closed: [],
  ...extra,
});

test("normalizeQuery trims, lowercases, and collapses whitespace", () => {
  assert.equal(normalizeQuery("  New   Work "), "new work");
  assert.equal(normalizeQuery(undefined), "");
});

test("one character matches word starts only; longer queries match every token", () => {
  assert.ok(matches("w", "Work"));
  assert.ok(matches("n", "Research notes"), "start of a later word");
  assert.ok(!matches("o", "Work"), "mid-word single letter does not match");
  assert.ok(matches("or", "Work"));
  assert.ok(matches("notes res", "Research notes"), "token order does not matter");
  assert.ok(!matches("notes xyz", "Research notes"));
  assert.ok(!matches("", "Work"));
});

test("an empty query yields no rows (Firefox's zero-prefix list stays)", () => {
  assert.deepEqual(rows("", sources()), []);
  assert.deepEqual(rows("   ", sources()), []);
});

test("workspace rows exclude the active workspace and carry a switch action", () => {
  const result = rows("p", sources());
  assert.equal(result.length, 0, "Personal is active");
  const [work] = rows("wor", sources());
  assert.equal(work.kind, "workspace");
  assert.equal(work.title, "Work");
  assert.equal(work.detail, "Switch to workspace · 1 tab");
  assert.deepEqual(work.action, { type: "switch-workspace", id: "ws-2" });
});

test("closed tabs match title or url and restore by closedId", () => {
  const closed = [
    { closedId: 7, title: "Rust book", url: "https://doc.rust-lang.org/book/", workspace: "Work" },
    { closedId: 9, title: "", url: "https://example.com/", workspace: null },
  ];
  const [byTitle] = rows("rust", sources({ closed }));
  assert.equal(byTitle.kind, "closed");
  assert.equal(byTitle.detail, "Reopen closed tab · Work");
  assert.deepEqual(byTitle.action, { type: "restore-closed", closedId: 7 });
  const [byUrl] = rows("example", sources({ closed }));
  assert.equal(byUrl.title, "https://example.com/", "untitled tab falls back to its url");
  assert.equal(byUrl.detail, "Reopen closed tab");
});

test("commands need three characters and restore needs a closed tab", () => {
  assert.deepEqual(rows("ne", sources()), [], "too short for commands");
  assert.deepEqual(
    rows("new", sources()).map(r => r.action),
    [
      { type: "command", id: "new-tab" },
      { type: "command", id: "new-workspace" },
      { type: "command", id: "new-tor-window" },
    ]
  );
  assert.deepEqual(rows("reopen", sources()), [], "nothing to restore");
  const closed = [{ closedId: 1, title: "A", url: "https://a.test/", workspace: null }];
  assert.deepEqual(rows("reopen", sources({ closed })).map(r => r.title), ["Restore closed tab"]);
});

test("sort tabs by site is a command, also found by domain", () => {
  for (const query of ["sort", "sort tabs", "by domain", "organize"]) {
    assert.deepEqual(
      rows(query, sources()).map(r => r.action),
      [{ type: "command", id: "sort-by-site" }],
      query
    );
  }
});

test("new Tor window is a command, also found as Brave's name and by onion", () => {
  for (const query of ["tor", "new tor", "private window with tor", "onion"]) {
    assert.deepEqual(
      rows(query, sources()).map(r => r.action),
      [{ type: "command", id: "new-tor-window" }],
      query
    );
  }
});

test("sections keep prototype order and the list is capped", () => {
  const closed = [
    { closedId: 1, title: "Work log", url: "https://a.test/", workspace: null },
    { closedId: 2, title: "Work plan", url: "https://b.test/", workspace: null },
    { closedId: 3, title: "Work notes", url: "https://c.test/", workspace: null },
  ];
  const result = rows("work", sources({ closed }));
  assert.equal(result.length, MAX_ROWS);
  assert.deepEqual(
    result.map(r => r.kind),
    ["workspace", "closed", "closed"]
  );
});
