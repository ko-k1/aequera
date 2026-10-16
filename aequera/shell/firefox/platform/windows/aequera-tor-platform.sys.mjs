/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AequeraTorPlatform for Windows: what Tor windows do differently on this
// OS (docs/design/TOR.md, Windows). Packaged as
// chrome://browser/content/aequera/platform/aequera-tor-platform.sys.mjs on
// Windows builds only (jar.mn); macOS and Linux package their own module at
// that URL. Every OS's module exports the same members
// (platform/platform-contract.test.mjs). No static imports: the contract
// test loads it in node.

/**
 * Whether a running Firefox holds `profile`. Firefox keeps
 * <profile>/parent.lock open with no sharing while it runs (nsProfileLock)
 * and leaves the file behind when it exits. A lock that opens is not held;
 * no lock is no instance; anything else (held, or an error that says
 * neither) counts as running: a profile is never rewritten on a guess.
 */
async function profileLocked(profile) {
  try {
    await IOUtils.read(PathUtils.join(profile, "parent.lock"), { maxBytes: 1 });
    return false;
  } catch (error) {
    return error?.name != "NotFoundError";
  }
}

export const AequeraTorPlatform = Object.freeze({
  id: "windows",

  /** Tor windows exist on this OS. */
  supported() {
    return true;
  },

  /** tor's SOCKS listener: a loopback TCP port. Firefox reaches a local
   *  SOCKS proxy here only over TCP or a named pipe, and tor offers no
   *  named pipe. */
  transport: "tcp",

  /** The bundled tor's file name (tools/tor/fetch-bundle.sh). */
  executableName: "tor.exe",

  /** The environment variable that points the bundled tor at its
   *  libraries, or null: the bundle's tor.exe is self-contained. */
  libraryPathVariable: null,

  /** Whether a Tor instance runs on `profile` though its marker is missing
   *  or unreadable: the profile lock tells (one that could not write the
   *  marker, or a removed one). */
  runsWithoutMarker(profile) {
    return profileLocked(profile);
  },

  /** Whether process `pid` runs `profile`: the lock is held. (Windows has no
   *  portable way to read another process's command line.) */
  processRunsProfile(_pid, profile) {
    return profileLocked(profile);
  },
});
