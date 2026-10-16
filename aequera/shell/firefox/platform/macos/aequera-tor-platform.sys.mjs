/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AequeraTorPlatform for macOS: what Tor windows do differently on this OS
// (docs/design/TOR.md). Packaged as
// chrome://browser/content/aequera/platform/aequera-tor-platform.sys.mjs on
// macOS builds only (jar.mn); Windows and Linux package their own module at
// that URL. Every OS's module exports the same members
// (platform/platform-contract.test.mjs). No static imports: the contract
// test loads it in node.

export const AequeraTorPlatform = Object.freeze({
  id: "macos",

  /** Tor windows exist on this OS. */
  supported() {
    return true;
  },

  /** tor's SOCKS listener: a Unix socket in a 0700 directory. */
  transport: "unix",

  /** The bundled tor's file name (tools/tor/fetch-bundle.sh). */
  executableName: "tor",

  /** The expert bundle's tor has no RPATH: its libevent and OpenSSL sit
   *  beside it, found as Tor Browser finds them. */
  libraryPathVariable: "DYLD_LIBRARY_PATH",

  /** A missing marker means no instance here. */
  async runsWithoutMarker(_profile) {
    return false;
  },

  /** Whether process `pid` is alive and its command line names `profile`
   *  (ps: macOS has no /proc). */
  async processRunsProfile(pid, profile) {
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const proc = await Subprocess.call({ command: "/bin/ps", arguments: ["-p", String(pid), "-o", "command="] });
    let out = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) {
      out += chunk;
    }
    const { exitCode } = await proc.wait();
    return exitCode === 0 && out.includes(profile);
  },
});
