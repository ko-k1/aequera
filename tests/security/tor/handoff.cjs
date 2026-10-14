// Tor window live check, step 3 (README.md; needs a window system:
// headless Firefox never acts as a remoting client). With the Tor instance
// running, "New Tor window" in the ordinary instance must open a window in
// the Tor instance, through the real launcher and Firefox's remoting.
//
//   node tests/security/tor/handoff.cjs [ordinary port=28281] [Tor port=28282]
const { Marionette } = require("./marionette.cjs");

const mainPort = Number(process.argv[2] ?? 28281);
const torPort = Number(process.argv[3] ?? 28282);
const COUNT = `return [...Services.wm.getEnumerator("navigator:browser")].length;`;

(async () => {
  const tor = new Marionette(torPort);
  await tor.connect();
  await tor.context("chrome");
  const before = await tor.run(COUNT);

  const main = new Marionette(mainPort);
  await main.connect();
  await main.context("chrome");
  await main.run(`
    const { AequeraTorLauncher: L } = ChromeUtils.importESModule("chrome://browser/content/aequera/tor/aequera-tor-launch.sys.mjs");
    await L.openWindow();`);

  const after = await tor.run(
    `const t = Date.now();
     let n;
     while ((n = [...Services.wm.getEnumerator("navigator:browser")].length) == ${before} && Date.now() - t < 20000) {
       await new Promise(r => setTimeout(r, 200));
     }
     return n;`,
  );
  const ok = after == before + 1;
  console.log(`${ok ? "PASS" : "FAIL"} New Tor window reaches the running Tor instance (${before} -> ${after} windows)`);
  tor.close();
  main.close();
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.error("handoff check failed:", e);
  process.exit(1);
});
