/* Palette parity tests — run with: node --test src/palette.test.js
 * (from aequera/extensions/shell-chrome/). No browser.* dependency;
 * fixtures mirror the prototype store shapes in prototype/shell/app.js.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { rankCandidates, PALETTE_CAP } = require("./palette");

function sources() {
  return {
    tabs: [
      { title: "Alpha docs", url: "https://a.example/docs", workspace: "Research", tabId: 11, windowId: 1 },
      { title: "Beta mail", url: "https://b.example/inbox", workspace: "Personal", tabId: 12, windowId: 2 },
    ],
    workspaces: [
      { name: "Research", tabCount: 1, windowId: 1 },
      { name: "Personal", tabCount: 1, windowId: 2 },
    ],
    history: [{ title: "Alpha changelog", url: "https://a.example/news" }],
    bookmarks: [{ title: "Beta homepage", url: "https://b.example/" }],
    closed: [{ title: "Gamma old", url: "https://c.example/old", workspace: "Research" }],
    canRestore: true,
  };
}

function kinds(items) {
  return items.map((i) => i.kind);
}

describe("rankCandidates", () => {
  it("empty query returns every section in prototype order, capped", () => {
    const items = rankCandidates("", sources());
    assert.deepEqual(
      kinds(items),
      ["Tab", "Tab", "Workspace", "Workspace", "History", "Bookmark", "Closed", "Command", "Command"],
    );
    assert.ok(items.length <= PALETTE_CAP);
  });

  it("matches case-insensitively across tabs, history and bookmarks", () => {
    const items = rankCandidates("ALPHA", sources());
    assert.deepEqual(kinds(items), ["Tab", "History"]);
    assert.equal(items[0].title, "Alpha docs");
    assert.equal(items[0].action.type, "switch-tab");
  });

  it("workspace names match on their own; tabs match title/URL only (prototype parity)", () => {
    const items = rankCandidates("pers", sources());
    assert.deepEqual(kinds(items), ["Workspace"]);
    assert.equal(items[0].action.type, "switch-workspace");
    assert.equal(items[0].action.windowId, 2);
  });

  it("restore command is gated on canRestore", () => {
    const open = sources();
    open.canRestore = true;
    const shut = sources();
    shut.canRestore = false;
    const withRestore = rankCandidates("restore", open);
    assert.equal(withRestore.length, 1);
    assert.equal(withRestore[0].action.type, "restore-closed");
    assert.deepEqual(rankCandidates("restore", shut), []);
  });

  it("closed entries reopen by URL like the prototype", () => {
    const items = rankCandidates("gamma", sources());
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "Closed");
    assert.equal(items[0].action.type, "open-url");
    assert.equal(items[0].action.url, "https://c.example/old");
  });

  it("cap holds under overflow, tabs first", () => {
    const s = sources();
    for (let i = 0; i < 20; i++) {
      s.history.push({ title: "filler " + i, url: "https://f.example/" + i });
    }
    const items = rankCandidates("", s);
    assert.equal(items.length, PALETTE_CAP);
    assert.equal(items[0].kind, "Tab");
  });
});
