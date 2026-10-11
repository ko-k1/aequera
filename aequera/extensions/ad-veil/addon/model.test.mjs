// Unit tests for Ad Veil's pure model (the same file the add-on loads).
// Run: node --test aequera/extensions/ad-veil/addon/model.test.mjs
// (or bun test <same path>)
import { test } from "node:test";
import assert from "node:assert/strict";
import model from "./model.js";

const { siteOf, hostOf, covers, siteMode, resolveMode, settingsFrom, withMode, adHostsFrom, adFrom, dayOf, cutoff, RETENTION_DAYS } =
  model;

test("siteOf names the site without www., http(s) only", () => {
  assert.equal(siteOf("https://www.example.com/a?b"), "example.com");
  assert.equal(siteOf("http://news.example.com:8080/"), "news.example.com");
  assert.equal(siteOf("https://wwwexample.com/"), "wwwexample.com");
  assert.equal(siteOf("about:newtab"), null);
  assert.equal(siteOf("moz-extension://x/vault.html"), null);
  assert.equal(siteOf("not a url"), null);
  assert.equal(hostOf("https://www.example.com/"), "www.example.com");
});

test("a site in a set covers its subdomains, not its parents or lookalikes", () => {
  const off = new Set(["example.com"]);
  assert.ok(covers(off, "example.com"));
  assert.ok(covers(off, "news.example.com"));
  assert.ok(!covers(off, "badexample.com"));
  assert.ok(!covers(new Set(["news.example.com"]), "example.com"));
  assert.ok(!covers(off, null));
});

test("siteMode: block by default, veil where veiled, off wins", () => {
  const lists = { off: new Set(["off.test"]), veil: new Set(["veil.test", "both.test"]) };
  assert.equal(siteMode(lists, "news.test"), "block");
  assert.equal(siteMode(lists, "veil.test"), "veil");
  assert.equal(siteMode(lists, "a.veil.test"), "veil");
  assert.equal(siteMode(lists, "off.test"), "off");
  assert.equal(siteMode({ off: new Set(["both.test"]), veil: lists.veil }, "both.test"), "off");
  assert.equal(siteMode(lists, null), "block");
});

test("private-window choices win there, nearest site first, and nowhere else", () => {
  const state = {
    off: new Set(),
    veil: new Set(["example.com"]),
    privateModes: new Map([
      ["news.example.com", "block"],
      ["shop.test", "off"],
    ]),
  };
  assert.equal(resolveMode(state, "example.com", false), "veil");
  assert.equal(resolveMode(state, "example.com", true), "veil");
  assert.equal(resolveMode(state, "news.example.com", false), "veil");
  assert.equal(resolveMode(state, "a.news.example.com", true), "block");
  assert.equal(resolveMode(state, "shop.test", true), "off");
  assert.equal(resolveMode(state, "shop.test", false), "block");
  assert.equal(model.nearest(state.privateModes, null), undefined);
});

test("settings recover to defaults from anything", () => {
  const defaults = { offSites: [], veilSites: [], vault: true, showImages: false };
  assert.deepEqual(settingsFrom(undefined), defaults);
  assert.deepEqual(settingsFrom("garbage"), defaults);
  assert.deepEqual(settingsFrom({ offSites: "x", veilSites: {}, vault: "yes", showImages: 1 }), defaults);
  assert.deepEqual(
    settingsFrom({
      offSites: ["example.com", "example.com", 3, "", "a b", "https://x.com/"],
      veilSites: ["b.test", "a.test", null],
      vault: false,
      showImages: true,
    }),
    { offSites: ["example.com"], veilSites: ["a.test", "b.test"], vault: false, showImages: true }
  );
  // Settings from before veil mode (slice 2) keep their sites.
  assert.deepEqual(settingsFrom({ offSites: ["example.com"], vault: true }), {
    offSites: ["example.com"],
    veilSites: [],
    vault: true,
    showImages: false,
  });
});

test("totals recover from anything; since is never in the future", () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(model.totalsFrom(undefined, now), { blocked: 0, hidden: 0, since: now });
  assert.deepEqual(model.totalsFrom({ blocked: -1, hidden: 2.5, since: now + 1 }, now), {
    blocked: 0,
    hidden: 0,
    since: now,
  });
  assert.deepEqual(model.totalsFrom({ blocked: 12, hidden: 3, since: now - 5 }, now), {
    blocked: 12,
    hidden: 3,
    since: now - 5,
  });
});

test("badgeText is short and never shows 0", () => {
  const cases = [
    [0, ""],
    [-3, ""],
    [NaN, ""],
    [7, "7"],
    [999, "999"],
    [1000, "1k"],
    [1250, "1.2k"],
    [9999, "9.9k"],
    [12500, "12k"],
    [999999, "999k"],
    [1500000, "1.5M"],
  ];
  for (const [count, text] of cases) {
    assert.equal(model.badgeText(count), text, String(count));
  }
});

test("listInfo reads the version and counts rules", () => {
  const list = "[Adblock Plus 2.0]\n! Version: 202610110853\n! Title: x\n\n||ads.example^\nexample.com##.ad\n";
  assert.deepEqual(model.listInfo(list), { version: "202610110853", rules: 2 });
  assert.deepEqual(model.listInfo(""), { version: null, rules: 0 });
});

test("withMode moves a site between block, veil, and off", () => {
  const none = { offSites: [], veilSites: [] };
  const veiled = withMode(none, "example.com", "veil");
  assert.deepEqual(veiled, { offSites: [], veilSites: ["example.com"] });
  const off = withMode(veiled, "example.com", "off");
  assert.deepEqual(off, { offSites: ["example.com"], veilSites: [] });
  assert.deepEqual(withMode(off, "example.com", "block"), none);
  assert.deepEqual(withMode(none, "example.com", "nonsense"), none);
});

test("adHostsFrom takes whole-host rules only", () => {
  const list = [
    "[Adblock Plus 2.0]",
    "! comment",
    "||ads.example^",
    "||pagead2.googlesyndication.com^",
    "||track.example^$third-party",
    "||cdn.example^$script,image",
    "||news.example^$domain=a.test",
    "||ads.example/banner^",
    "@@||ads.example^",
    "||bad.example^$badfilter",
    "example.com##.ad",
    "||*.wild^",
  ].join("\n");
  assert.deepEqual(adHostsFrom(list), ["ads.example", "cdn.example", "pagead2.googlesyndication.com", "track.example"]);
});

test("adFrom keeps only http(s) links and creatives, bounded text", () => {
  assert.deepEqual(adFrom({ link: "https://ad.test/c?x=1", creative: "https://cdn.test/a.png", text: "  Buy\n now  " }), {
    link: "https://ad.test/c?x=1",
    creative: "https://cdn.test/a.png",
    text: "Buy now",
  });
  assert.equal(adFrom({ link: "javascript:alert(1)" }), null);
  assert.equal(adFrom({ text: "only text" }), null);
  assert.equal(adFrom(null), null);
  assert.equal(adFrom({ link: `https://ad.test/${"a".repeat(3000)}` }), null);
  assert.equal(adFrom({ creative: "https://cdn.test/a.png", text: "x".repeat(500) }).text.length, 200);
  assert.equal(adFrom({ creative: "data:image/png;base64,AAAA" }), null);
});

test("dayOf and cutoff", () => {
  assert.match(dayOf(Date.now()), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dayOf(new Date(2026, 0, 5, 23, 59).getTime()), "2026-01-05");
  const now = Date.now();
  assert.equal(now - cutoff(now), RETENTION_DAYS * 86400000);
});
