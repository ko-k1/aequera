/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AequeraTorPlatform for Linux: what Tor windows do differently on this OS
// (docs/design/TOR.md). Packaged as
// chrome://browser/content/aequera/platform/aequera-tor-platform.sys.mjs on
// every build that is neither Windows nor macOS (jar.mn); the other OSes
// package their own module at that URL. Every OS's module exports the same
// members (platform/platform-contract.test.mjs). No static imports: the
// contract test loads it in node.

export const AequeraTorPlatform = Object.freeze({
  id: "linux",

  /** Tor windows exist on Linux, not on the other Unixes this module is
   *  packaged for (nothing has checked them). */
  supported() {
    return Services.appinfo.OS == "Linux";
  },

  /** tor's SOCKS listener: a Unix socket in a 0700 directory. */
  transport: "unix",

  /** The bundled tor's file name (tools/tor/fetch-bundle.sh). */
  executableName: "tor",

  /** The expert bundle's tor has no RPATH: its libevent and OpenSSL sit
   *  beside it, found as Tor Browser finds them. */
  libraryPathVariable: "LD_LIBRARY_PATH",

  /** A missing marker means no instance here. */
  async runsWithoutMarker(_profile) {
    return false;
  },

  /** Whether process `pid` is alive and its command line names `profile`
   *  (procfs). */
  async processRunsProfile(pid, profile) {
    // procfs reports a size of 0: without maxBytes IOUtils reads nothing.
    const readProc = async name =>
      new TextDecoder().decode(await IOUtils.read(`/proc/${pid}/${name}`, { maxBytes: 1 << 16 }));
    let stat;
    try {
      stat = await readProc("stat");
    } catch {
      return false; // no such process
    }
    // "pid (comm) S ...": a zombie (exited, not yet reaped) or dead process
    // runs nothing.
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    if (state == "Z" || state == "X") {
      return false;
    }
    let cmdline = "";
    try {
      cmdline = await readProc("cmdline");
    } catch {}
    if (!cmdline) {
      // A live process whose command line cannot be read: assume it is the
      // instance rather than rewrite a profile it may be using.
      return true;
    }
    return cmdline.split("\0").includes(profile);
  },
});
