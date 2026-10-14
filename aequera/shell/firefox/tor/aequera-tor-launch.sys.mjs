/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tor windows: the ordinary instance's side (docs/adr/0004-tor-windows.md).
// Opens a Tor window: starts the Tor instance (a second Aequera process on
// the throwaway profile <profile>/tor/profile, written fresh with the prefs
// of tor-model.js), or, while it runs, asks it for another window through
// Firefox's per-profile remoting (the same command line, which a running
// instance receives instead).

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

const MODEL_URL = "chrome://browser/content/aequera/tor/tor-model.js";
const ENABLED_PREF = "aequera.tor.enabled";

/** Environment variables the Tor instance must not inherit: those that pick
 *  a profile ahead of `-profile` (a restart sets them; Firefox clears them
 *  after startup, removed here regardless), and those that turn on remote
 *  control (Marionette and the Remote Agent export them while this instance
 *  is automated: the Tor instance would listen for automation too). */
const STRIPPED_ENV = [
  "XRE_PROFILE_PATH",
  "XRE_PROFILE_LOCAL_PATH",
  "XRE_START_OFFLINE",
  "XRE_RESTARTED_BY_PROFILE_MANAGER",
  "XRE_RESTARTED_BY_PROFILE_SELECTOR",
  "XRE_RESTART_TO_PROFILE_MANAGER",
  "XUL_APP_FILE",
  "MOZ_RESET_PROFILE_RESTART",
  "SELECTABLE_PROFILE_RESET_PATH",
  "MOZ_MARIONETTE",
  "MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS",
  "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS",
];

/** How long a new instance may take to come up before another window is
 *  asked of it (its remoting server starts before its first window). */
const START_WAIT_MS = 20000;

function loadModel() {
  const scope = {};
  Services.scriptloader.loadSubScript(MODEL_URL, scope);
  return scope.AequeraTorModel;
}

function randomHex(length) {
  return Services.uuid
    .generateUUID()
    .toString()
    .replace(/[^0-9a-f]/g, "")
    .slice(0, length);
}

/** The ordinary profile's Tor layout. */
function torPaths() {
  const base = PathUtils.join(PathUtils.profileDir, "tor");
  return {
    base,
    profile: PathUtils.join(base, "profile"),
    data: PathUtils.join(base, "data"),
    marker: PathUtils.join(base, "running"),
  };
}

export const AequeraTorLauncher = {
  model: null,

  /** The live child of this session (if this session started it). */
  child: null,
  /** The pending launch, so launches never overlap. */
  queue: Promise.resolve(),

  /** Test hook: replaces Subprocess.call. */
  spawn: null,

  /**
   * Why Tor windows cannot be opened from here, or null.
   *
   * @returns {null|"disabled"|"platform"|"instance"}
   */
  unavailable() {
    if (!Services.prefs.getBoolPref(ENABLED_PREF, true)) {
      return "disabled";
    }
    if (!["linux", "macosx"].includes(AppConstants.platform)) {
      // Windows: Firefox reaches a local SOCKS proxy only through a named
      // pipe, which tor does not offer (ADR 0004).
      return "platform";
    }
    if (Services.prefs.getBoolPref("aequera.tor.instance", false)) {
      // Already the Tor instance: its own windows are Tor windows.
      return "instance";
    }
    return null;
  },

  /**
   * Open a Tor window, optionally with a web URL. Resolves once the browser
   * process for it was started (the window appears from that process).
   *
   * @param {string|null} [url]
   */
  openWindow(url = null) {
    const run = this.queue.then(() => this.launch(url));
    this.queue = run.catch(() => {});
    return run;
  },

  async launch(url) {
    const why = this.unavailable();
    if (why) {
      throw new Error(`aequera-tor: Tor windows unavailable (${why})`);
    }
    this.model ??= loadModel();
    if (url && !this.model.isTorOpenableUrl(url)) {
      throw new Error("aequera-tor: only http(s) URLs open in a Tor window");
    }
    const paths = torPaths();
    const running = this.child !== null || (await IOUtils.exists(paths.marker));
    if (!running) {
      await this.prepareProfile(paths);
    }

    const exe = Services.dirsvc.get("XREExeF", Ci.nsIFile).path;
    const args = this.model.launchArgs({ appIni: await this.appIni(), profileDir: paths.profile, url });
    const environment = Object.fromEntries(STRIPPED_ENV.map(name => [name, null]));
    const call = this.spawn ?? (options => lazy.Subprocess.call(options));
    const proc = await call({ command: exe, arguments: args, environment, environmentAppend: true, stderr: "stdout" });
    this.drain(proc);

    if (!running) {
      this.child = proc;
      proc.wait().then(
        () => this.forget(proc),
        () => this.forget(proc),
      );
      await this.waitForStart(paths, proc);
    } else {
      // A remoting client: it hands the command line to the running
      // instance and exits.
      await proc.wait();
    }
  },

  forget(proc) {
    if (this.child === proc) {
      this.child = null;
    }
  },

  /** Read and drop the child's output, so a full pipe never blocks it. */
  async drain(proc) {
    try {
      while ((await proc.stdout.readString()) !== "") {
        // Nothing to keep: the instance logs to its own console.
      }
    } catch {
      // Closed: the process is gone.
    }
  },

  /** Wait until the new instance is up (its marker), or it exited. */
  async waitForStart(paths, proc) {
    let exited = false;
    proc.wait().then(
      () => (exited = true),
      () => (exited = true),
    );
    const deadline = Date.now() + START_WAIT_MS;
    while (!exited && Date.now() < deadline) {
      if (await IOUtils.exists(paths.marker)) {
        return;
      }
      await new Promise(resolve => lazy.setTimeout(resolve, 100));
    }
  },

  /**
   * The identity ini this process was started with (`-app`), next to the
   * application's browser directory as tools/build/aequera-run.sh places it;
   * null when started without one (a packaged build).
   */
  async appIni() {
    const gre = Services.dirsvc.get("GreD", Ci.nsIFile).path;
    const ini = PathUtils.join(gre, "browser", "aequera-application.ini");
    return (await IOUtils.exists(ini)) ? ini : null;
  },

  /**
   * A fresh profile for the Tor instance: the old one removed (nothing of a
   * Tor session survives it), user.js written, tor's data directory kept.
   */
  async prepareProfile(paths) {
    await IOUtils.makeDirectory(paths.base, { permissions: 0o700 });
    await IOUtils.remove(paths.profile, { recursive: true, ignoreAbsent: true });
    await IOUtils.makeDirectory(paths.profile, { permissions: 0o700 });
    await IOUtils.makeDirectory(paths.data, { permissions: 0o700 });
    await IOUtils.setPermissions(paths.data, 0o700);

    const socksPath = await this.socketPath();
    const socksUrl = Services.io.newFileURI(new lazy.FileUtils.File(socksPath)).spec;
    const executable = Services.prefs.getStringPref(this.model.EXECUTABLE_PREF, "");
    const prefs = this.model.instancePrefs({ socksPath, socksUrl, dataDir: paths.data, executable });
    await IOUtils.writeUTF8(PathUtils.join(paths.profile, "user.js"), this.model.userJs(prefs));
  },

  /**
   * A socket path in a new 0700 directory: the user's runtime directory
   * where there is one (short, private), else the temporary directory. The
   * Tor instance's tor listens there; nothing exists at it before.
   */
  async socketPath() {
    const roots = [];
    const runtime = Services.env.get("XDG_RUNTIME_DIR");
    if (runtime && (await IOUtils.exists(runtime))) {
      roots.push(runtime);
    }
    roots.push(PathUtils.tempDir, "/tmp");
    for (const root of roots) {
      const dir = PathUtils.join(root, `aequera-tor-${randomHex(8)}`);
      const path = PathUtils.join(dir, "socks");
      if (this.model.socketPathProblem(path)) {
        continue;
      }
      try {
        await IOUtils.makeDirectory(dir, { permissions: 0o700, createAncestors: false, ignoreExisting: false });
      } catch (error) {
        console.error("aequera-tor: cannot create socket directory", dir, error);
        continue;
      }
      return path;
    }
    throw new Error("aequera-tor: no directory for tor's socket");
  },
};
