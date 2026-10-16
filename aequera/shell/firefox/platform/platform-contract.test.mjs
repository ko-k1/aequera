// The per-OS shell files (platform/<os>/) and how jar.mn packages them.
//
//   node --test aequera/shell/firefox/platform/platform-contract.test.mjs
//
// Each build packages one OS's files at the same chrome URLs, so shared code
// relies on every OS defining the same members with the same kinds of
// values. A browser runs only its own OS's files; this checks all three on
// every host (PR CI runs it on Windows, Linux, and macOS), and that no shared
// runtime code asks which OS it runs on.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const PLATFORM_DIR = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = dirname(PLATFORM_DIR);
const OSES = ["windows", "macos", "linux"];
// jar.mn's preprocessor conditions, in order (#ifdef, #elifdef, #else).
const JAR_BRANCHES = { windows: "XP_WIN", macos: "XP_MACOSX", linux: "else" };

/** Member name -> "method" or "value", sorted (value types are checked
 *  one by one: some are null on one OS and a string on another). */
function shape(object) {
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map(key => [key, typeof object[key] == "function" ? "method" : "value"]),
  );
}

/** AequeraPlatform as the window script defines it (nothing is called). */
function windowPlatform(os) {
  const source = readFileSync(join(PLATFORM_DIR, os, "aequera-platform.js"), "utf8");
  const context = vm.createContext({});
  vm.runInContext(`${source}\nglobalThis.result = AequeraPlatform;`, context);
  return context.result;
}

async function torPlatform(os) {
  const url = pathToFileURL(join(PLATFORM_DIR, os, "aequera-tor-platform.sys.mjs"));
  return (await import(url.href)).AequeraTorPlatform;
}

test("every OS directory has the same files", () => {
  const listing = os => readdirSync(join(PLATFORM_DIR, os)).sort();
  for (const os of OSES) {
    assert.deepEqual(listing(os), listing("windows"), os);
  }
});

test("AequeraPlatform has the same members on every OS", () => {
  const reference = shape(windowPlatform("windows"));
  for (const os of OSES) {
    const platform = windowPlatform(os);
    assert.equal(platform.id, os);
    assert.ok(Object.isFrozen(platform), `${os}: frozen`);
    assert.deepEqual(shape(platform), reference, os);
    assert.equal(typeof platform.systemBackdrop, "boolean");
    assert.equal(typeof platform.updatesDragImage, "boolean");
    assert.ok(["alt", "control"].includes(platform.workspaceDigitModifier), os);
  }
});

test("AequeraTorPlatform has the same members on every OS", async () => {
  const reference = shape(await torPlatform("windows"));
  for (const os of OSES) {
    const platform = await torPlatform(os);
    assert.equal(platform.id, os);
    assert.ok(Object.isFrozen(platform), `${os}: frozen`);
    assert.deepEqual(shape(platform), reference, os);
    assert.ok(["tcp", "unix"].includes(platform.transport), os);
    assert.ok(platform.libraryPathVariable === null || typeof platform.libraryPathVariable == "string", os);
  }
});

test("the per-OS values Aequera depends on", async () => {
  const win = windowPlatform("windows");
  assert.equal(win.systemBackdrop, true, "Acrylic: auto is glass on Windows");
  assert.equal(win.workspaceDigitModifier, "alt", "Firefox's tabs take Ctrl+digit on Windows");
  assert.equal(windowPlatform("linux").updatesDragImage, false, "Linux cannot swap a drag image");
  assert.equal((await torPlatform("windows")).transport, "tcp", "Windows Firefox needs a TCP SOCKS port");
  assert.equal((await torPlatform("windows")).executableName, "tor.exe");
  for (const os of ["macos", "linux"]) {
    assert.equal((await torPlatform(os)).transport, "unix", `${os}: SOCKS over a Unix socket`);
  }
});

/** jar.mn's platform lines per preprocessor branch: destination -> source. */
function jarBranches() {
  const branches = {};
  let current = null;
  for (const raw of readFileSync(join(SHELL_DIR, "jar.mn"), "utf8").split("\n")) {
    const line = raw.trim();
    const directive = line.match(/^#(ifdef|elifdef|else|endif)\b\s*(\w*)/);
    if (directive) {
      current = { ifdef: directive[2], elifdef: directive[2], else: "else", endif: null }[directive[1]];
      if (current) {
        branches[current] = {};
      }
      continue;
    }
    const entry = line.match(/^(content\/browser\/aequera\/platform\/\S+)\s+\((\S+)\)$/);
    if (entry) {
      assert.ok(current, `${entry[1]} is outside a per-OS branch`);
      branches[current][entry[1]] = entry[2];
    }
  }
  return branches;
}

test("jar.mn packages each OS's own files at the same URLs", () => {
  const branches = jarBranches();
  assert.deepEqual(Object.keys(branches).sort(), Object.values(JAR_BRANCHES).sort());
  const files = readdirSync(join(PLATFORM_DIR, "windows")).sort();
  for (const [os, branch] of Object.entries(JAR_BRANCHES)) {
    const entries = branches[branch];
    assert.deepEqual(
      Object.keys(entries).sort(),
      files.map(file => `content/browser/aequera/platform/${file}`),
      `${os}: every file packaged once`,
    );
    for (const [destination, source] of Object.entries(entries)) {
      assert.equal(source, `platform/${os}/${destination.split("/").pop()}`, `${os}: ${destination}`);
    }
  }
});

test("shared shell code never asks which OS it runs on", () => {
  const offenders = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        // Per-OS code lives in platform/; tests state per-OS expectations.
        if (path != PLATFORM_DIR && name != "tests") {
          walk(path);
        }
      } else if (/\.(js|mjs|css)$/.test(name) && !name.endsWith(".test.mjs")) {
        const text = readFileSync(path, "utf8");
        if (/AppConstants\.platform|-moz-platform/.test(text)) {
          offenders.push(relative(SHELL_DIR, path));
        }
      }
    }
  };
  walk(SHELL_DIR);
  assert.deepEqual(offenders, [], "move OS-specific code to platform/<os>/");
});
