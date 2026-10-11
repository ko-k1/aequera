// Unit tests for Ad Veil's pure model (the same file the add-on loads).
// Run: node --test aequera/extensions/ad-veil/addon/model.test.mjs
// (or bun test <same path>)
import { test } from "node:test";
import assert from "node:assert/strict";
import model from "./model.js";

const { siteOf, hostOf, isSiteOff, settingsFrom, withSite, adFrom, dayOf, cutoff, RETENTION_DAYS } = model;

test("siteOf names the site without www., http(s) only", () => {
  assert.equal(siteOf("https://www.example.com/a?b"), "example.com");
  assert.equal(siteOf("http://news.example.com:8080/"), "news.example.com");
  assert.equal(siteOf("https://wwwexample.com/"), "wwwexample.com");
  assert.equal(siteOf("about:newtab"), null);
  assert.equal(siteOf("moz-extension://x/vault.html"), null);
  assert.equal(siteOf("not a url"), null);
  assert.equal(hostOf("https://www.example.com/"), "www.example.com");
});

test("a site turned off covers its subdomains, not its parents or lookalikes", () => {
  const off = new Set(["example.com"]);
  assert.ok(isSiteOff(off, "example.com"));
  assert.ok(isSiteOff(off, "news.example.com"));
  assert.ok(!isSiteOff(off, "badexample.com"));
  assert.ok(!isSiteOff(new Set(["news.example.com"]), "example.com"));
  assert.ok(!isSiteOff(off, null));
});

test("settings recover to defaults from anything", () => {
  assert.deepEqual(settingsFrom(undefined), { offSites: [], vault: true });
  assert.deepEqual(settingsFrom("garbage"), { offSites: [], vault: true });
  assert.deepEqual(settingsFrom({ offSites: "x", vault: "yes" }), { offSites: [], vault: true });
  assert.deepEqual(
    settingsFrom({ offSites: ["example.com", "example.com", 3, "", "a b", "https://x.com/"], vault: false }),
    { offSites: ["example.com"], vault: false }
  );
});

test("withSite turns a site off and on", () => {
  const off = withSite([], "example.com", false);
  assert.deepEqual(off, ["example.com"]);
  assert.deepEqual(withSite(off, "example.com", false), ["example.com"]);
  assert.deepEqual(withSite(off, "example.com", true), []);
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
