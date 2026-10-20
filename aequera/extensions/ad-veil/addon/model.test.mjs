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

test("a single label covers only itself, never every name under it", () => {
  const off = new Set(["com", "localhost"]);
  assert.ok(!covers(off, "example.com"));
  assert.ok(!covers(off, "news.example.com"));
  assert.ok(covers(off, "com"));
  assert.ok(covers(off, "localhost"));
  assert.equal(siteMode({ off, veil: new Set() }, "example.com"), "block");
  const privateModes = new Map([["com", "off"]]);
  assert.equal(resolveMode({ off: new Set(), veil: new Set(), privateModes }, "example.com", true), "block");
  // Two labels and more still cover their subdomains.
  assert.ok(covers(new Set(["co.uk"]), "example.co.uk"));
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

test("siteKey and sameSite: a page's own subdomains, not another site", () => {
  const { siteKey, sameSite } = model;
  assert.equal(siteKey("https://news.example.com/a"), "example.com");
  assert.equal(siteKey("https://www.bbc.co.uk/"), "bbc.co.uk");
  assert.equal(siteKey("https://127.0.0.1:8080/"), "127.0.0.1");
  assert.equal(siteKey("about:blank"), null);
  assert.ok(sameSite("https://shop.example.com/", "https://www.example.com/x"));
  assert.ok(!sameSite("https://example.org/", "https://example.com/"));
  assert.ok(!sameSite("about:blank", "about:blank"));
  // One tenant of a shared platform is not another tenant's own page.
  assert.equal(siteKey("https://evil.github.io/x"), "evil.github.io");
  assert.equal(siteKey("https://blog.example.blogspot.com/"), "example.blogspot.com");
  assert.equal(siteKey("https://bucket.s3.amazonaws.com/k"), "bucket.s3.amazonaws.com");
  assert.ok(!sameSite("https://evil.github.io/", "https://victim.github.io/"));
  assert.ok(sameSite("https://a.github.io/", "https://a.github.io/x"));
  assert.equal(siteKey("https://github.io/"), "github.io");
});

test("fetchableImageUrl: only public http(s) images reach the vault fetch", () => {
  const { fetchableImageUrl } = model;
  assert.equal(fetchableImageUrl("https://cdn.example.com/ad.png"), "https://cdn.example.com/ad.png");
  assert.equal(fetchableImageUrl("http://cdn.example.com/ad.png"), "http://cdn.example.com/ad.png");
  for (const url of [
    "http://127.0.0.1:8123/x.png",
    "http://localhost/x.png",
    "http://[::1]/x.png",
    "http://10.0.0.5/x.png",
    "http://192.168.1.1/x.png",
    "http://172.16.0.1/x.png",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/x.png",
    "http://[fd00::1]/x.png",
    "http://[fe80::1]/x.png",
    "http://[::ffff:192.168.0.1]/x.png",
    "http://[64:ff9b::a00:1]/x.png",
    "http://printer.local/x.png",
    "http://foo.internal/x.png",
    "http://host.home.arpa/x.png",
    "http://999.1.1.1/x.png",
    "file:///etc/passwd.png",
    "ftp://example.com/x.png",
    "blob:https://example.com/x",
    "",
  ]) {
    assert.equal(fetchableImageUrl(url), null, url);
  }
  // A public host that merely starts like a private name is still fetched.
  assert.equal(fetchableImageUrl("https://localhost.example.com/x.png"), "https://localhost.example.com/x.png");
  assert.equal(fetchableImageUrl("https://172.32.0.1/x.png"), "https://172.32.0.1/x.png");
});

test("popupVerdict: click-anywhere and link-riding popups close, controls and links open", () => {
  const { popupVerdict } = model;
  const page = "https://news.test/story";
  const click = (kind, href = null, age = 50) => ({ kind, href, age });
  // A click on plain content: another site, or a blank window, closes.
  assert.equal(popupVerdict(click("plain"), "https://ads.test/land", page), true);
  assert.equal(popupVerdict(click("plain"), "about:blank", page), true);
  assert.equal(popupVerdict(click("plain"), "https://news.test/gallery", page), false, "the page's own site");
  // A link opens itself; a popup riding on it closes.
  assert.equal(popupVerdict(click("link", "https://other.test/a"), "https://other.test/a#top", page), false);
  assert.equal(popupVerdict(click("link", "https://other.test/a"), "https://ads.test/land", page), true);
  assert.equal(popupVerdict(click("link", "https://other.test/a"), "https://www.other.test/b", page), false, "the link's site");
  assert.equal(popupVerdict(click("link", "https://other.test/a"), "about:blank", page), false);
  // A control (sign-in, share) opens anything.
  assert.equal(popupVerdict(click("control"), "https://accounts.test/oauth", page), false);
  // No recent click: Firefox's popup blocker decided.
  assert.equal(popupVerdict(null, "https://ads.test/", page), false);
  assert.equal(popupVerdict(click("plain", null, 5000), "https://ads.test/", page), false);
});

test("proceduralFrom keeps known operators and actions, never styles", () => {
  const { proceduralFrom } = model;
  const hide = { selector: [{ type: "css-selector", arg: ".card" }, { type: "has-text", arg: "Sponsored" }] };
  assert.deepEqual(proceduralFrom([hide]), [{ ...hide, action: null }]);
  assert.deepEqual(proceduralFrom([{ selector: [{ type: "css-selector", arg: ".x" }], action: { type: "remove" } }]), [
    { selector: [{ type: "css-selector", arg: ".x" }], action: { type: "remove" } },
  ]);
  assert.deepEqual(
    proceduralFrom([{ selector: [{ type: "css-selector", arg: ".x" }], action: { type: "remove-attr", arg: "onclick" } }])[0].action,
    { type: "remove-attr", arg: "onclick" }
  );
  // Styles, unknown operators, bad arguments, and bad shapes are dropped.
  assert.deepEqual(proceduralFrom([{ selector: [{ type: "css-selector", arg: ".x" }], action: { type: "style", arg: "color: red" } }]), []);
  assert.deepEqual(proceduralFrom([{ selector: [{ type: "eval", arg: "x" }] }]), []);
  assert.deepEqual(proceduralFrom([{ selector: [{ type: "has-text", arg: 5 }] }]), []);
  assert.deepEqual(proceduralFrom([{ selector: [] }, null, "x", { selector: [{ type: "has-text", arg: "a".repeat(2000) }] }]), []);
  assert.deepEqual(proceduralFrom([{ selector: [{ type: "css-selector", arg: ".x" }], action: { type: "remove-class" } }]), []);
  assert.deepEqual(proceduralFrom(null), []);
  assert.equal(proceduralFrom(Array(600).fill(hide)).length, 500);
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

test("adSize: own size, at most 800 wide, short side at least 24, null when unknown", () => {
  const { adSize } = model;
  assert.deepEqual(adSize(300, 250), { width: 300, height: 250 });
  assert.deepEqual(adSize(1600, 400), { width: 800, height: 200 });
  assert.deepEqual(adSize(320, 10), { width: 768, height: 24 });
  assert.equal(adSize(0, 250), null);
  assert.equal(adSize(undefined, undefined), null);
});

test("packAds: around the middle, never overlapping, within its bounds", () => {
  const SIZES = [
    [300, 250],
    [728, 90],
    [160, 600],
    [320, 50],
    [300, 600],
    [970, 250],
    [250, 250],
    [180, 120],
  ];
  const sizes = Array.from({ length: 400 }, (_, i) => ({ width: SIZES[i % 8][0], height: SIZES[i % 8][1] }));
  const gap = 12;
  const started = performance.now();
  const { positions, bounds } = model.packAds(sizes, { gap });
  const took = performance.now() - started;
  assert.equal(positions.length, 400);
  // The first is centered on the origin.
  assert.ok(Math.abs(positions[0].x + 150) <= 16, `first x ${positions[0].x}`);
  assert.equal(positions[0].y, 0);
  const boxes = positions.map(({ x, y }, i) => ({ x, y, w: sizes[i].width, h: sizes[i].height }));
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    assert.ok(a.x >= bounds.left && a.y >= bounds.top && a.x + a.w <= bounds.right && a.y + a.h <= bounds.bottom, `${i} in bounds`);
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      const apart = a.x + a.w + gap <= b.x + 0.001 || b.x + b.w + gap <= a.x + 0.001 || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y;
      assert.ok(apart, `${i} and ${j} overlap`);
    }
  }
  // A collage around the middle: about as much above as below, wider than tall.
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  assert.ok(Math.abs(bounds.top + bounds.bottom) < height * 0.2, `balanced: ${bounds.top} ${bounds.bottom}`);
  assert.ok(width > height, `wider than tall: ${width}×${height}`);
  // Dense: the ads cover most of the collage's area.
  const area = sizes.reduce((n, s) => n + s.width * s.height, 0);
  assert.ok(area / (width * height) > 0.5, `density ${(area / (width * height)).toFixed(2)}`);
  console.log(`packAds: 400 ads in ${took.toFixed(1)} ms, ${Math.round(width)}×${Math.round(height)}, density ${(area / (width * height)).toFixed(2)}`);
  assert.deepEqual(model.packAds([]), { positions: [], bounds: { left: 0, top: 0, right: 0, bottom: 0 } });
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
