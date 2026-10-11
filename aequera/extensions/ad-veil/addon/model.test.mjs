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
  const defaults = { offSites: [], veilSites: [], vault: true, saveImages: true };
  assert.deepEqual(settingsFrom(undefined), defaults);
  assert.deepEqual(settingsFrom("garbage"), defaults);
  assert.deepEqual(settingsFrom({ offSites: "x", veilSites: {}, vault: "yes", saveImages: 1 }), defaults);
  assert.deepEqual(
    settingsFrom({
      offSites: ["example.com", "example.com", 3, "", "a b", "https://x.com/"],
      veilSites: ["b.test", "a.test", null],
      vault: false,
      saveImages: false,
    }),
    { offSites: ["example.com"], veilSites: ["a.test", "b.test"], vault: false, saveImages: false }
  );
  // Settings from before veil mode (slice 2) keep their sites.
  assert.deepEqual(settingsFrom({ offSites: ["example.com"], vault: true }), {
    offSites: ["example.com"],
    veilSites: [],
    vault: true,
    saveImages: true,
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
    loaded: false,
  });
  // `loaded` only when said exactly, and only with an image.
  assert.equal(adFrom({ creative: "https://cdn.test/a.png", loaded: true }).loaded, true);
  assert.equal(adFrom({ creative: "https://cdn.test/a.png", loaded: "yes" }).loaded, false);
  assert.equal(adFrom({ link: "https://ad.test/", loaded: true }).loaded, false);
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

test("destinationOf follows ad click URLs to the advertiser", () => {
  const { destinationOf } = model;
  assert.equal(
    destinationOf("https://googleads.g.doubleclick.net/pcs/click?xai=1&adurl=https://shop.test/sale%3Fref%3Dad"),
    "https://shop.test/sale?ref=ad"
  );
  assert.equal(destinationOf("https://ad.test/c?u=javascript:alert(1)"), "https://ad.test/c?u=javascript:alert(1)");
  assert.equal(destinationOf("https://shop.test/"), "https://shop.test/");
  assert.equal(destinationOf("javascript:alert(1)"), null);
  assert.equal(destinationOf(null), null);
});

const day = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const vaultAds = [
  {
    id: 1,
    time: day(1),
    site: "news.test",
    page: "https://news.test/a",
    link: "https://ad.test/c?adurl=https://shop.test/",
    creative: "https://cdn.test/a.png",
    text: "",
  },
  {
    id: 2,
    time: day(3),
    site: "blog.test",
    page: "https://blog.test/",
    link: "https://ad.test/c?adurl=https://shop.test/x",
    creative: "https://cdn.test/a.png",
    text: "Sale",
  },
  { id: 3, time: day(2), site: "news.test", page: "https://news.test/b", link: "https://other.test/", creative: null, text: "Buy Things" },
  { id: 4, time: day(4), site: "news.test", page: "https://news.test/c", link: "https://www.other.test/y", creative: null, text: "buy things" },
  { id: 5, time: day(4, 13), site: "news.test", page: "https://news.test/d", link: "https://third.test/", creative: null, text: "Buy things" },
];

test("groupAds: one group per ad seen again, newest first, newest sighting names it", () => {
  const groups = model.groupAds(vaultAds);
  assert.deepEqual(
    groups.map(g => [g.kind, g.sightings.map(s => s.id)]),
    [
      ["text", [5]],
      ["text", [4, 3]],
      ["image", [2, 1]],
    ]
  );
  const image = groups[2];
  assert.equal(image.destination, "https://shop.test/x");
  assert.equal(image.text, "Sale");
  assert.equal(image.first, day(1));
  assert.equal(image.last, day(3));
  // Entries from before text was recorded.
  assert.equal(model.groupAds([{ id: 9, time: 1, creative: "https://cdn.test/b.png" }])[0].text, "");
});

test("filterGroups keeps the sightings a filter matches", () => {
  const groups = model.groupAds(vaultAds);
  const { filterGroups } = model;
  assert.equal(filterGroups(groups).length, 3);
  assert.deepEqual(
    filterGroups(groups, { kind: "image" }).map(g => g.sightings.length),
    [2]
  );
  const early = filterGroups(groups, { from: dayOf(day(1)), to: dayOf(day(2)) });
  assert.deepEqual(
    early.map(g => [g.kind, g.sightings.map(s => s.id)]),
    [
      ["text", [3]],
      ["image", [1]],
    ]
  );
  assert.equal(early[1].last, day(1));
  assert.deepEqual(
    filterGroups(groups, { site: "blog.test" }).map(g => g.sightings.map(s => s.id)),
    [[2]]
  );
  assert.equal(filterGroups(groups, { query: "SHOP.test" }).length, 1);
  assert.equal(filterGroups(groups, { query: "news.test" }).length, 3);
  assert.equal(filterGroups(groups, { query: "nothing" }).length, 0);
});

test("adsPerDay: every day from the first sighting, at least two weeks, at most retention", () => {
  const groups = model.groupAds(vaultAds);
  const series = model.adsPerDay(groups, day(5));
  assert.equal(series.length, 14);
  assert.equal(series.at(-1).day, dayOf(day(5)));
  assert.deepEqual(
    series.slice(-5).map(e => e.count),
    [1, 1, 1, 2, 0]
  );
  assert.equal(model.adsPerDay([], day(5)).length, 14);
  const old = model.groupAds([{ id: 1, time: day(5) - 200 * 86400000, creative: "https://cdn.test/a.png" }]);
  assert.equal(model.adsPerDay(old, day(5)).length, RETENTION_DAYS);
});

test("vaultStats counts sightings, ads, advertisers, sites, and their tops", () => {
  const stats = model.vaultStats(model.groupAds(vaultAds));
  assert.equal(stats.found, 5);
  assert.equal(stats.unique, 3);
  // shop.test, other.test (with and without www.), third.test.
  assert.equal(stats.advertisers, 3);
  assert.equal(stats.sites, 2);
  assert.equal(stats.since, day(1));
  assert.deepEqual(stats.kinds, { image: 2, text: 3 });
  assert.deepEqual(stats.top.sites, [
    { name: "news.test", count: 4 },
    { name: "blog.test", count: 1 },
  ]);
  assert.deepEqual(stats.top.networks, [{ name: "cdn.test", count: 2 }]);
  assert.deepEqual(model.vaultStats([]), {
    found: 0,
    unique: 0,
    advertisers: 0,
    sites: 0,
    since: null,
    kinds: { image: 0, text: 0 },
    top: { advertisers: [], networks: [], sites: [] },
  });
});
