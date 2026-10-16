/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// The build packaged this OS's platform files (jar.mn: platform/<os>/ at
// chrome://browser/content/aequera/platform/). Their contract on every OS is
// checked in node (platform/platform-contract.test.mjs).

const EXPECTED = { win: "windows", macosx: "macos", linux: "linux" }[AppConstants.platform];

add_task(async function test_window_platform_is_this_os() {
  is(window.AequeraPlatform?.id, EXPECTED, "the window scripts read this OS's AequeraPlatform");
});

add_task(async function test_tor_platform_is_this_os() {
  const { AequeraTorPlatform } = ChromeUtils.importESModule(
    "chrome://browser/content/aequera/platform/aequera-tor-platform.sys.mjs",
  );
  is(AequeraTorPlatform.id, EXPECTED, "Tor windows use this OS's module");
  ok(AequeraTorPlatform.supported(), "Tor windows are supported on this OS");
});

add_task(async function test_platform_stylesheet_is_imported() {
  const shell = [...document.styleSheets].find(sheet => sheet.href?.endsWith("/aequera/aequera-shell.css"));
  ok(shell, "aequera-shell.css is loaded");
  const imported = [...shell.cssRules].find(
    rule => CSSImportRule.isInstance(rule) && rule.href.endsWith("platform/aequera-platform.css"),
  );
  ok(imported?.styleSheet?.cssRules.length > 0, "and imports this OS's stylesheet, with its rules");
});
