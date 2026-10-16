// AequeraTorPlatform's fail-closed checks on every OS, on stubbed Gecko
// globals (IOUtils, PathUtils, Services).
//
//   node --test aequera/shell/firefox/platform/tor-platform.test.mjs
//
// A Tor profile is never rewritten on a guess: whatever cannot be told for
// sure counts as a running instance. A browser runs only its own OS's
// module; these run all three on every host (PR CI: Windows, Linux, macOS).

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLATFORM_DIR = dirname(fileURLToPath(import.meta.url));

async function torPlatform(os) {
  const url = pathToFileURL(join(PLATFORM_DIR, os, "aequera-tor-platform.sys.mjs"));
  return (await import(url.href)).AequeraTorPlatform;
}

const GLOBALS = ["IOUtils", "PathUtils", "Services"];
const saved = Object.fromEntries(GLOBALS.map(name => [name, globalThis[name]]));
afterEach(() => {
  for (const name of GLOBALS) {
    globalThis[name] = saved[name];
  }
});

const notFound = () => Object.assign(new Error("absent"), { name: "NotFoundError" });

/** IOUtils.read answering from `files` (path -> text, or an Error to throw). */
function stubFiles(files) {
  globalThis.PathUtils = { join: (...parts) => parts.join("/") };
  globalThis.IOUtils = {
    async read(path) {
      if (!(path in files)) {
        throw notFound();
      }
      const content = files[path];
      if (content instanceof Error) {
        throw content;
      }
      return new TextEncoder().encode(content);
    },
  };
}

test("Windows: the profile lock tells, and only a clean absence means not running", async () => {
  const win = await torPlatform("windows");
  const lock = "C:/p/parent.lock";
  stubFiles({});
  assert.equal(await win.runsWithoutMarker("C:/p"), false, "no lock file: not running");
  stubFiles({ [lock]: "" });
  assert.equal(await win.runsWithoutMarker("C:/p"), false, "a lock that opens: not held");
  stubFiles({ [lock]: Object.assign(new Error("sharing violation"), { name: "NotAllowedError" }) });
  assert.equal(await win.runsWithoutMarker("C:/p"), true, "a held lock: running");
  stubFiles({ [lock]: new Error("anything else") });
  assert.equal(await win.processRunsProfile(1234, "C:/p"), true, "an unknown error: running");
});

test("Linux: /proc tells, and an unreadable command line counts as running", async () => {
  const linux = await torPlatform("linux");
  const stat = state => `42 (firefox) ${state} 1 42 42 0`;
  stubFiles({});
  assert.equal(await linux.processRunsProfile(42, "/p"), false, "no such process");
  stubFiles({ "/proc/42/stat": stat("Z"), "/proc/42/cmdline": "firefox\0-profile\0/p\0" });
  assert.equal(await linux.processRunsProfile(42, "/p"), false, "a zombie runs nothing");
  stubFiles({ "/proc/42/stat": stat("X") });
  assert.equal(await linux.processRunsProfile(42, "/p"), false, "a dead process runs nothing");
  stubFiles({ "/proc/42/stat": stat("S") });
  assert.equal(await linux.processRunsProfile(42, "/p"), true, "live, command line unreadable: running");
  stubFiles({ "/proc/42/stat": stat("S"), "/proc/42/cmdline": "" });
  assert.equal(await linux.processRunsProfile(42, "/p"), true, "live, command line empty: running");
  stubFiles({ "/proc/42/stat": stat("S"), "/proc/42/cmdline": "firefox\0-profile\0/p\0" });
  assert.equal(await linux.processRunsProfile(42, "/p"), true, "names the profile");
  assert.equal(await linux.processRunsProfile(42, "/p2"), false, "another profile: an exact argument, not a prefix");
  // A process name with ") " in it must not shift the state field.
  stubFiles({ "/proc/42/stat": "42 (a) Z (b) S 1 42", "/proc/42/cmdline": "x\0/p\0" });
  assert.equal(await linux.processRunsProfile(42, "/p"), true, "state read after the last ')'");
});

test("a missing marker means no instance off Windows", async () => {
  for (const os of ["linux", "macos"]) {
    assert.equal(await (await torPlatform(os)).runsWithoutMarker("/p"), false, os);
  }
});

test("Tor windows are supported on Linux only among the Unixes the Linux module serves", async () => {
  const linux = await torPlatform("linux");
  for (const [osName, expected] of [
    ["Linux", true],
    ["FreeBSD", false],
    ["OpenBSD", false],
  ]) {
    globalThis.Services = { appinfo: { OS: osName } };
    assert.equal(linux.supported(), expected, osName);
  }
  assert.equal((await torPlatform("windows")).supported(), true);
  assert.equal((await torPlatform("macos")).supported(), true);
});
