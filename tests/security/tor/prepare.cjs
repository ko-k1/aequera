// Tor window live check, step 1 (README.md): in the ordinary instance,
// write the Tor profile with the launcher's own code, then let that profile
// listen for Marionette (test only: the launcher never passes automation
// on to the Tor instance).
//
//   node tests/security/tor/prepare.cjs [ordinary port=28281] [Tor port=28282]
// Prints the Tor profile path to start the Tor instance on.
const fs = require("fs");
const path = require("path");
const { Marionette } = require("./marionette.cjs");

const mainPort = Number(process.argv[2] ?? 28281);
const torPort = Number(process.argv[3] ?? 28282);

(async () => {
  const m = new Marionette(mainPort);
  await m.connect();
  await m.context("chrome");
  const info = await m.run(`
    const { AequeraTorLauncher: L } = ChromeUtils.importESModule("chrome://browser/content/aequera/tor/aequera-tor-launch.sys.mjs");
    const scope = {};
    Services.scriptloader.loadSubScript("chrome://browser/content/aequera/tor/tor-model.js", scope);
    L.model = scope.AequeraTorModel;
    if (L.unavailable()) {
      throw new Error("Tor windows unavailable: " + L.unavailable());
    }
    const base = PathUtils.join(PathUtils.profileDir, "tor");
    const paths = { base, profile: PathUtils.join(base, "profile"), data: PathUtils.join(base, "data"), marker: PathUtils.join(base, "running") };
    if (await IOUtils.exists(paths.marker)) {
      throw new Error("a Tor instance is running on this profile; quit it first");
    }
    await L.prepareProfile(paths);
    return { profile: paths.profile, entryPoint: !!document.getElementById("menu_aequeraTorWindow") };
  `);
  if (!info.entryPoint) {
    throw new Error("no New Tor Window menu item in the ordinary instance");
  }
  fs.appendFileSync(
    path.join(info.profile, "user.js"),
    `user_pref("marionette.port", ${torPort});\nuser_pref("remote.prefs.recommended", false);\n`,
  );
  console.log(info.profile);
  m.close();
})().catch(e => {
  console.error("prepare failed:", e.message);
  process.exit(1);
});
