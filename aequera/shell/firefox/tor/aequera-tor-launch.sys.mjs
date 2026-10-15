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
import { randomHex, removeSocketDir, torModel } from "chrome://browser/content/aequera/tor/aequera-tor-common.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

const ENABLED_PREF = "aequera.tor.enabled";

/** Environment variables the Tor instance must not inherit: those that pick
 *  a profile ahead of `-profile` (a restart sets them; Firefox clears them
 *  after startup, removed here regardless) or turn the remoting client off
 *  (MOZ_NEW_INSTANCE: no handoff to the running Tor instance), and those
 *  that turn on remote control (Marionette and the Remote Agent export them
 *  while this instance is automated: the Tor instance would listen for
 *  automation too). */
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
  "MOZ_NEW_INSTANCE",
  "MOZ_MARIONETTE",
  "MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS",
  "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS",
];

/** How long a new instance may take to come up before another window is
 *  asked of it (its remoting server starts before its first window). */
const START_WAIT_MS = 20000;

/** How long a remoting client may take to hand its command line over. One
 *  still running after this became an instance itself. */
const HANDOFF_WAIT_MS = 15000;

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

function sleep(ms) {
  return new Promise(resolve => lazy.setTimeout(resolve, ms));
}

/** Resolves with the process's exit code, or null if it still runs after `ms`. */
function exitWithin(proc, ms) {
  return Promise.race([proc.wait().then(({ exitCode }) => exitCode), sleep(ms).then(() => null)]);
}

export const AequeraTorLauncher = {
  model: null,

  /** The live child of this session (if this session started it). */
  child: null,
  /** The pending launch, so launches never overlap. */
  queue: Promise.resolve(),

  /** Test hooks: replace Subprocess.call, and the liveness of a marker's pid. */
  spawn: null,
  processAlive: null,
  /** How long a new instance and a handoff may take (tests shorten them). */
  startWaitMs: START_WAIT_MS,
  handoffWaitMs: HANDOFF_WAIT_MS,

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
    if (Services.prefs.getBoolPref(torModel().INSTANCE_PREF, false)) {
      // Already the Tor instance: its own windows are Tor windows.
      return "instance";
    }
    return null;
  },

  /**
   * Open a Tor window, optionally with a web URL. Resolves once the browser
   * process for it is up (the window appears from that process); rejects
   * when it could not start or the handoff failed.
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
    this.model ??= torModel();
    if (url && !this.model.isTorOpenableUrl(url)) {
      throw new Error("aequera-tor: only http(s) URLs open in a Tor window");
    }
    const paths = torPaths();
    const running = await this.instanceRunning(paths);
    if (!running) {
      await this.prepareProfile(paths);
    }

    const exe = Services.dirsvc.get("XREExeF", Ci.nsIFile).path;
    // Always -offline (launchArgs): if `running` was wrong and this process
    // becomes the instance, it stays offline until its own checks pass.
    const args = this.model.launchArgs({ appIni: await this.appIni(), profileDir: paths.profile, url });
    const environment = Object.fromEntries(STRIPPED_ENV.map(name => [name, null]));
    const call = this.spawn ?? (options => lazy.Subprocess.call(options));
    const proc = await call({ command: exe, arguments: args, environment, environmentAppend: true, stderr: "stdout" });
    this.drain(proc);

    if (!running) {
      this.adopt(proc, paths);
      await this.waitForStart(paths, proc);
      return;
    }
    // A remoting client: it hands the command line to the running instance
    // and exits. Never waited on longer than that.
    const exitCode = await exitWithin(proc, this.handoffWaitMs);
    if (exitCode === null) {
      // It became an instance itself (offline until its checks pass).
      this.adopt(proc, paths);
      throw new Error("aequera-tor: the running Tor instance did not answer; a new one started in its place");
    } else if (exitCode !== 0) {
      throw new Error(`aequera-tor: the running Tor instance did not take the window (exit ${exitCode})`);
    }
  },

  /** Track `proc` as this session's Tor instance until it exits, then
   *  remove what it left (afterExit). */
  adopt(proc, paths) {
    this.child = proc;
    const exited = () => {
      this.forget(proc);
      this.afterExit(paths);
    };
    proc.wait().then(exited, exited);
  },

  /**
   * After this session's Tor instance exited: its socket directory and
   * marker, which a SIGTERM, SIGKILL, or crash leaves behind (Firefox's
   * profile lock ends the process on SIGTERM before any quit code runs).
   * Queued behind any launch in progress, and only while no Tor instance
   * runs on the profile.
   *
   * @returns {Promise<boolean>} whether anything was removed
   */
  afterExit(paths) {
    const run = this.queue.then(() => this.removeLeftovers(paths));
    this.queue = run.catch(error => console.error("aequera-tor: cannot clean up after the Tor instance", error));
    return run;
  },

  async removeLeftovers(paths) {
    if (await this.instanceRunning(paths)) {
      return false;
    }
    this.model ??= torModel();
    await this.removeOldSocketDir(paths);
    await IOUtils.remove(paths.marker, { ignoreAbsent: true });
    return true;
  },

  forget(proc) {
    if (this.child === proc) {
      this.child = null;
    }
  },

  /**
   * Whether a Tor instance runs on the profile: this session's child, or
   * the process its marker names, alive and started on that profile (a
   * crashed instance leaves its marker; a reused pid is another program).
   */
  async instanceRunning(paths) {
    if (this.child) {
      return true;
    }
    let pid;
    try {
      pid = Number((await IOUtils.readUTF8(paths.marker)).trim());
    } catch (error) {
      // No marker: no instance. A marker that cannot be read: unknown, so
      // assumed running (its profile is never rewritten on a guess).
      if (error?.name == "NotFoundError") {
        return false;
      }
      console.error("aequera-tor: cannot read the running-session marker", error);
      return true;
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    const alive = this.processAlive ?? ((p, profile) => this.processRunsProfile(p, profile));
    try {
      return await alive(pid, paths.profile);
    } catch (error) {
      console.error("aequera-tor: cannot tell whether the Tor instance runs", error);
      // Unknown: never rewrite a profile that may be in use.
      return true;
    }
  },

  /** Whether `pid` is a process whose command line names `profile`. */
  async processRunsProfile(pid, profile) {
    if (AppConstants.platform == "linux") {
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
    }
    // macOS: no /proc.
    const proc = await lazy.Subprocess.call({ command: "/bin/ps", arguments: ["-p", String(pid), "-o", "command="] });
    let out = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) {
      out += chunk;
    }
    const { exitCode } = await proc.wait();
    return exitCode === 0 && out.includes(profile);
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

  /**
   * Wait until the new instance is up (its marker). Rejects if it exited
   * first, or if it is not up after startWaitMs (it stays this session's
   * child, and offline).
   */
  async waitForStart(paths, proc) {
    let exitCode;
    proc.wait().then(
      result => (exitCode = result.exitCode),
      () => (exitCode = -1),
    );
    const deadline = Date.now() + this.startWaitMs;
    while (Date.now() < deadline) {
      if (await IOUtils.exists(paths.marker)) {
        return;
      }
      if (exitCode !== undefined) {
        throw new Error(`aequera-tor: the Tor window's browser exited before it started (exit ${exitCode})`);
      }
      await sleep(100);
    }
    // Still running but no marker: it is not working as a Tor instance (it
    // stays offline, -offline). Kept as this session's child; the user is told.
    throw new Error(`aequera-tor: the Tor window did not start within ${this.startWaitMs / 1000} s`);
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
   * A fresh profile for the Tor instance (no Tor instance runs): the old one
   * removed with what a crashed session left (marker, socket directory), so
   * nothing of a Tor session survives it; user.js written; tor's data
   * directory kept.
   */
  async prepareProfile(paths) {
    await IOUtils.makeDirectory(paths.base, { permissions: 0o700 });
    await this.removeOldSocketDir(paths);
    await IOUtils.remove(paths.marker, { ignoreAbsent: true });
    await IOUtils.remove(paths.profile, { recursive: true, ignoreAbsent: true });
    await IOUtils.makeDirectory(paths.profile, { permissions: 0o700 });
    await IOUtils.makeDirectory(paths.data, { permissions: 0o700 });
    await IOUtils.setPermissions(paths.data, 0o700);

    const socksPath = await this.socketPath();
    const socksUrl = Services.io.newFileURI(new lazy.FileUtils.File(socksPath)).spec;
    const executable = Services.prefs.getStringPref(this.model.EXECUTABLE_PREF, "");
    const level = await this.rememberedSecurityLevel(paths);
    const prefs = this.model.instancePrefs({ socksPath, socksUrl, dataDir: paths.data, executable, level });
    await IOUtils.writeUTF8(PathUtils.join(paths.profile, "user.js"), this.model.userJs(prefs));
  },

  /**
   * The security level the last Tor session chose (the Tor instance keeps
   * it in <profile>/tor/settings.json, beside its throwaway profile).
   * Nothing remembered: Standard; unreadable or unknown: Safest (never a
   * silent Standard).
   */
  async rememberedSecurityLevel(paths) {
    let settings;
    try {
      settings = await IOUtils.readJSON(PathUtils.join(paths.base, "settings.json"));
    } catch (error) {
      if (error?.name == "NotFoundError") {
        return "standard";
      }
      // Unreadable or not JSON: the strictest, never a silent Standard.
      console.error("aequera-tor: cannot read the remembered security level", error);
      return "safest";
    }
    const level = this.model.securityLevel(settings?.securityLevel, null);
    if (level === null) {
      console.error("aequera-tor: unknown remembered security level", settings?.securityLevel);
      return "safest";
    }
    return level;
  },

  /**
   * The previous session's socket directory, when it did not quit cleanly
   * (a crash leaves it; a clean quit removes it). Only a directory this
   * launcher names (socketPathProblem) is removed.
   */
  async removeOldSocketDir(paths) {
    let text;
    try {
      text = await IOUtils.readUTF8(PathUtils.join(paths.profile, "user.js"));
    } catch {
      return;
    }
    const socksPath = this.model.parseUserJs(text).get(this.model.SOCKS_PATH_PREF);
    await removeSocketDir(this.model, typeof socksPath == "string" ? socksPath : "");
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
      const path = this.model.newSocketPath(root, randomHex(8));
      if (this.model.socketPathProblem(path)) {
        continue;
      }
      const dir = this.model.socketDir(path);
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
