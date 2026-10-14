// Unit tests for the pure Tor window model (the same file the browser loads).
// Run: node --test aequera/shell/firefox/tor/tor-model.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import model from "./tor-model.js";

const {
  INSTANCE_PREF,
  SOCKS_PATH_PREF,
  MAX_SOCKET_PATH_BYTES,
  UNKNOWN_SITE,
  PREFS,
  socketPathProblem,
  socketDir,
  newSocketPath,
  instancePrefs,
  requiredNames,
  checkRequired,
  userJs,
  torQuote,
  torrc,
  parseLogLine,
  isolationKey,
  launchArgs,
  isTorOpenableUrl,
} = model;

const SOCKET = "/run/user/1000/aequera-tor-ab12cd34/socks";
const URL_ = `file://${SOCKET}`;

test("every pref is listed once, with a reason", () => {
  const names = PREFS.map(p => p.name);
  assert.equal(new Set(names).size, names.length, "no duplicates");
  for (const p of PREFS) {
    assert.ok(p.why && p.why.length > 5, `${p.name} has a reason`);
    assert.ok(["boolean", "number", "string"].includes(typeof p.value), `${p.name} value type`);
  }
});

test("the prefs that keep traffic on tor are required", () => {
  const required = new Set(requiredNames());
  for (const name of [
    INSTANCE_PREF,
    "network.proxy.socks",
    "network.proxy.type",
    "network.proxy.socks5_remote_dns",
    "network.proxy.failover_direct",
    "network.proxy.allow_bypass",
    "network.proxy.allow_hijacking_localhost",
    "network.dns.disabled",
    "network.trr.mode",
    "network.http.http3.enable",
    "media.peerconnection.enabled",
    "xpinstall.enabled",
    "browser.privatebrowsing.autostart",
  ]) {
    assert.ok(required.has(name), `${name} is required`);
  }
  const value = name => PREFS.find(p => p.name === name).value;
  assert.equal(value("network.proxy.type"), 1);
  assert.equal(value("network.dns.disabled"), true);
  assert.equal(value("network.proxy.failover_direct"), false);
  assert.equal(value("network.proxy.allow_bypass"), false);
});

test("socket paths: absolute, no control characters, short enough for sun_path", () => {
  assert.equal(socketPathProblem(SOCKET), null);
  assert.match(socketPathProblem("relative/socks"), /absolute/);
  assert.match(socketPathProblem("/tmp/a\nb"), /control/);
  const tail = "/aequera-tor-ab12cd34/socks";
  const long = "/" + "a".repeat(MAX_SOCKET_PATH_BYTES - tail.length) + tail;
  assert.match(socketPathProblem(long), /longer/);
  const exact = "/" + "a".repeat(MAX_SOCKET_PATH_BYTES - tail.length - 1) + tail;
  assert.equal(exact.length, MAX_SOCKET_PATH_BYTES);
  assert.equal(socketPathProblem(exact), null, "exactly the limit is fine");
  // Multi-byte characters count in bytes, as sun_path does.
  const wide = "/" + "é".repeat(MAX_SOCKET_PATH_BYTES / 2) + tail;
  assert.match(socketPathProblem(wide), /longer/);
});

test("socket paths: only `socks` in a launcher-named directory (the one quit removes)", () => {
  for (const path of ["/tmp/socks", "/home/u/socks", "/run/user/1000/aequera-tor-ab12cd34/other", "/run/user/1000/aequera-tor-AB12CD34/socks", "/run/user/1000/aequera-tor-ab12cd3/socks", "/aequera-tor-ab12cd34x/socks"]) {
    assert.match(socketPathProblem(path), /aequera-tor-/, path);
  }
  assert.match(socketPathProblem("/run/../aequera-tor-ab12cd34/socks"), /normalized/);
  assert.equal(socketDir(SOCKET), "/run/user/1000/aequera-tor-ab12cd34");
  assert.equal(newSocketPath("/run/user/1000/", "0123abcd"), "/run/user/1000/aequera-tor-0123abcd/socks");
  assert.equal(socketPathProblem(newSocketPath("/tmp", "0123abcd")), null);
  assert.throws(() => newSocketPath("/tmp", "xyz"), /8 hex/);
});

test("instance prefs carry the socket and every listed pref", () => {
  const prefs = new Map(instancePrefs({ socksPath: SOCKET, socksUrl: URL_ }));
  assert.equal(prefs.get(INSTANCE_PREF), true);
  assert.equal(prefs.get(SOCKS_PATH_PREF), SOCKET);
  assert.equal(prefs.get("network.proxy.socks"), URL_);
  for (const p of PREFS) {
    assert.equal(prefs.get(p.name), p.value, p.name);
  }
  assert.throws(() => instancePrefs({ socksPath: SOCKET, socksUrl: "127.0.0.1" }), /file URL/);
});

test("checkRequired accepts the written prefs and names every wrong one", () => {
  const prefs = new Map(instancePrefs({ socksPath: SOCKET, socksUrl: URL_ }));
  assert.deepEqual(checkRequired(name => prefs.get(name), URL_), []);

  const tampered = new Map(prefs);
  tampered.set("network.proxy.type", 0);
  tampered.delete("network.dns.disabled");
  tampered.set("network.proxy.socks", "127.0.0.1");
  assert.deepEqual(
    checkRequired(name => tampered.get(name), URL_).sort(),
    ["network.dns.disabled", "network.proxy.socks", "network.proxy.type"].sort(),
  );

  // Optional prefs may differ.
  const optional = new Map(prefs);
  optional.set("geo.enabled", true);
  assert.deepEqual(checkRequired(name => optional.get(name), URL_), []);

  // Not the instance at all: nothing passes.
  assert.ok(checkRequired(() => undefined, URL_).includes(INSTANCE_PREF));
  // A non-file socket URL never passes, even if prefs match it.
  assert.ok(checkRequired(name => (name == "network.proxy.socks" ? "x" : prefs.get(name)), "x").includes("network.proxy.socks"));
});

test("user.js lines are valid JS literals", () => {
  const text = userJs([
    ["a.bool", true],
    ["a.int", 5],
    ["a.str", 'quote " and \\ backslash'],
  ]);
  const seen = [];
  const user_pref = (name, value) => seen.push([name, value]);
  // eslint-disable-next-line no-new-func
  new Function("user_pref", text)(user_pref);
  assert.deepEqual(seen, [
    ["a.bool", true],
    ["a.int", 5],
    ["a.str", 'quote " and \\ backslash'],
  ]);
  assert.throws(() => userJs([["x", 1.5]]), /integer/);
  assert.throws(() => userJs([["x", null]]), /unsupported/);
});

test("the whole instance user.js evaluates back to the instance prefs", () => {
  const prefs = instancePrefs({ socksPath: SOCKET, socksUrl: URL_ });
  const seen = [];
  // eslint-disable-next-line no-new-func
  new Function("user_pref", userJs(prefs))((n, v) => seen.push([n, v]));
  assert.deepEqual(seen, prefs);
});

test("torrc: own data dir, unix SOCKS socket with SOCKS-auth isolation, owner, no control port", () => {
  const text = torrc({ dataDir: "/home/u/.aequera/p/tor/data", socksPath: SOCKET, ownerPid: 4242 });
  const lines = text.split("\n");
  assert.ok(lines.includes('DataDirectory "/home/u/.aequera/p/tor/data"'));
  assert.ok(lines.includes(`SocksPort unix:"${SOCKET}" IsolateSOCKSAuth`));
  assert.ok(lines.includes("ControlPort 0"));
  assert.ok(lines.includes("ClientOnly 1"));
  assert.ok(lines.includes("__OwningControllerProcess 4242"));
  assert.ok(!/^SocksPort \d/m.test(text), "no TCP SOCKS port");
  assert.throws(() => torrc({ dataDir: "rel", socksPath: SOCKET, ownerPid: 1 }), /absolute/);
  assert.throws(() => torrc({ dataDir: "/d", socksPath: "x", ownerPid: 1 }), /socket path/);
  assert.throws(() => torrc({ dataDir: "/d", socksPath: SOCKET, ownerPid: 0 }), /pid/);
  assert.ok(!/GeoIP/.test(text), "no GeoIP lines without a bundle");
});

test("torrc: the bundled tor's GeoIP databases", () => {
  const text = torrc({
    dataDir: "/d",
    socksPath: SOCKET,
    ownerPid: 1,
    geoipFile: "/app/tor/geoip",
    geoip6File: "/app/tor/geoip6",
  });
  const lines = text.split("\n");
  assert.ok(lines.includes('GeoIPFile "/app/tor/geoip"'));
  assert.ok(lines.includes('GeoIPv6File "/app/tor/geoip6"'));
  assert.throws(() => torrc({ dataDir: "/d", socksPath: SOCKET, ownerPid: 1, geoipFile: "geoip" }), /absolute/);
});

test("torQuote escapes quotes and backslashes and refuses newlines", () => {
  assert.equal(torQuote('/a b/"c"\\d'), '"/a b/\\"c\\"\\\\d"');
  assert.throws(() => torQuote("/a\nControlPort 9051"), /control character/);
});

test("tor log: bootstrap progress, warnings, errors; other lines ignored", () => {
  assert.deepEqual(
    parseLogLine("Oct 14 18:00:00.000 [notice] Bootstrapped 5% (conn): Connecting to a relay"),
    { kind: "bootstrap", progress: 5, tag: "conn", summary: "Connecting to a relay" },
  );
  assert.deepEqual(parseLogLine("Oct 14 18:00:09.000 [notice] Bootstrapped 100% (done): Done"), {
    kind: "bootstrap",
    progress: 100,
    tag: "done",
    summary: "Done",
  });
  // Older tor: no tag.
  assert.deepEqual(parseLogLine("May 01 00:00:00.000 [notice] Bootstrapped 80%: Connecting to the Tor network"), {
    kind: "bootstrap",
    progress: 80,
    tag: "",
    summary: "Connecting to the Tor network",
  });
  assert.deepEqual(parseLogLine("Oct 14 18:00:00.000 [warn] Problem bootstrapping. Stuck at 5% (conn)"), {
    kind: "warn",
    message: "Problem bootstrapping. Stuck at 5% (conn)",
  });
  assert.deepEqual(parseLogLine("Oct 14 18:00:00.000 [err] Reading config failed"), {
    kind: "err",
    message: "Reading config failed",
  });
  assert.equal(parseLogLine("Oct 14 18:00:00.000 [notice] Opening Socks listener"), null);
  assert.equal(parseLogLine("garbage"), null);
  assert.equal(parseLogLine("[notice] Bootstrapped 250% (x): y").progress, 100, "clamped");
});

test("isolation key: a top-level document by its own site, the rest by the page's site", () => {
  assert.equal(isolationKey({ topLevelDocument: true, uriSite: "example.com", partitionSite: "old.org" }), "example.com");
  assert.equal(isolationKey({ partitionSite: "example.com", topSite: "other.org" }), "example.com");
  assert.equal(isolationKey({ firstPartyDomain: "fpi.org", topSite: "other.org" }), "fpi.org");
  assert.equal(isolationKey({ topSite: "Top.ORG " }), "top.org", "trimmed, lowercased");
  assert.equal(isolationKey({}), UNKNOWN_SITE);
  assert.equal(isolationKey({ topLevelDocument: true, partitionSite: "old.org" }), UNKNOWN_SITE, "never the previous page's site");
  assert.equal(isolationKey({ partitionSite: "  " }), UNKNOWN_SITE);
});

test("launch arguments: identity ini, profile, private window, optional URL", () => {
  assert.deepEqual(launchArgs({ profileDir: "/p" }), ["-profile", "/p", "-private-window"]);
  assert.deepEqual(launchArgs({ appIni: "/b/aequera-application.ini", profileDir: "/p", url: "https://e.org/" }), [
    "-app",
    "/b/aequera-application.ini",
    "-profile",
    "/p",
    "-private-window",
    "https://e.org/",
  ]);
  assert.deepEqual(
    launchArgs({ profileDir: "/p", start: true }),
    ["-profile", "/p", "-offline", "-private-window"],
    "a new instance starts offline (fail closed until its checks pass)"
  );
});

test("only web URLs are handed to a Tor window", () => {
  assert.ok(isTorOpenableUrl("https://example.com/a?b"));
  assert.ok(isTorOpenableUrl("http://abcdefghijklmnop.onion/"));
  assert.ok(!isTorOpenableUrl("file:///etc/passwd"));
  assert.ok(!isTorOpenableUrl("about:config"));
  assert.ok(!isTorOpenableUrl("javascript:alert(1)"));
  assert.ok(!isTorOpenableUrl("https://a b"));
  assert.ok(!isTorOpenableUrl(null));
});
