// Unit tests for the pure new tab model (the same file the browser loads).
// Run: node --test aequera/shell/firefox/newtab/newtab-model.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import model from "./newtab-model.js";

const { isUntouched, reusable } = model;

const NEW_TAB = "about:newtab";
const blank = (extra = {}) => ({ url: NEW_TAB, newTabURL: NEW_TAB, ...extra });
const site = (extra = {}) => ({ url: "https://example.com/", newTabURL: NEW_TAB, ...extra });

test("an untouched new tab page is reusable", () => {
  assert.ok(isUntouched(blank()));
});

test("anything that marks the page as used, or off screen, rules it out", () => {
  for (const key of ["pinned", "hidden", "pending", "busy", "canGoBack", "canGoForward", "typed"]) {
    assert.ok(!isUntouched(blank({ [key]: true })), key);
  }
  assert.ok(!isUntouched(site()), "a site");
  assert.ok(!isUntouched(blank({ url: "about:home" })), "about:home is a page the user chose");
  assert.ok(!isUntouched(null));
  assert.ok(!isUntouched({ newTabURL: NEW_TAB }), "no address");
});

test("the window's own new tab address counts (private windows)", () => {
  const priv = "about:privatebrowsing";
  assert.ok(isUntouched({ url: priv, newTabURL: priv }));
  assert.ok(!isUntouched({ url: NEW_TAB, newTabURL: priv }));
});

test("no untouched page: open a new tab", () => {
  assert.equal(reusable([]), -1);
  assert.equal(reusable(undefined), -1);
  assert.equal(reusable([site({ selected: true }), blank({ typed: true })]), -1);
});

test("the selected tab wins, else the last untouched page", () => {
  assert.equal(reusable([blank(), site({ selected: true }), blank(), site()]), 2);
  assert.equal(reusable([blank({ selected: true }), site(), blank()]), 0);
  assert.equal(reusable([site(), blank({ hidden: true }), blank()]), 2);
  assert.equal(reusable([blank(), blank({ hidden: true, selected: true })]), 0, "a hidden selected tab is not reused");
});
