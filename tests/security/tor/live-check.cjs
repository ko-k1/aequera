// Tor window live check, step 2 (README.md): drives a Tor instance through
// the real Tor network and checks that nothing reaches the network around
// tor. Needs network access to the Tor network.
//
//   node tests/security/tor/live-check.cjs [Tor port=28282] [ordinary port=28281]
// Exit 0 when every check passes. On Windows (tor on a loopback TCP port,
// docs/design/TOR.md) it also checks the online gating and the port ban.
const http = require("http");
const net = require("net");
const { Marionette } = require("./marionette.cjs");

const torPort = Number(process.argv[2] ?? 28282);
const mainPort = Number(process.argv[3] ?? 28281);
const DAEMON = `const { AequeraTorDaemon: D } = ChromeUtils.importESModule("chrome://browser/content/aequera/tor/aequera-tor-daemon.sys.mjs");`;
const ONION = "http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/"; // the Tor Project's

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
}

async function chrome(m, body, timeout) {
  await m.context("chrome");
  return m.run(body, [], timeout);
}

async function load(m, url, timeoutMs = 90000) {
  await m.context("content");
  await m.cmd("WebDriver:SetTimeouts", { pageLoad: timeoutMs });
  try {
    await m.cmd("WebDriver:Navigate", { url });
  } catch {
    // Error pages time out or fail navigation; the document says what happened.
  }
  const r = await m.cmd("WebDriver:ExecuteScript", {
    script: "return [document.documentURI, document.title, document.body ? document.body.innerText.slice(0, 400) : ''];",
    args: [],
  });
  return { documentURI: r.value[0], title: r.value[1], text: r.value[2] };
}

/** Windows: online only while tor reports its listener; a port taken before
 *  tor starts keeps the instance offline; the ordinary instance cannot
 *  reach tor's port. */
async function windowsChecks(m, port) {
  check("Windows: online with tor listening", (await chrome(m, "return Services.io.offline;")) === false);
  await chrome(m, `${DAEMON} await D.stopTor();`);
  check("Windows: offline the moment tor stops", (await chrome(m, "return Services.io.offline;")) === true);

  // Another program holds the port before tor starts again.
  let squatterHits = 0;
  const squatter = net.createServer(socket => {
    squatterHits++;
    socket.destroy();
  });
  await new Promise(resolve => squatter.listen(port, "127.0.0.1", resolve));
  const taken = await chrome(
    m,
    `${DAEMON}
     D.startTor();
     const start = Date.now();
     while (D.state.status != "failed" && Date.now() - start < 30000) await new Promise(r => setTimeout(r, 250));
     const b = Services.wm.getMostRecentWindow("navigator:browser").gBrowser.selectedBrowser;
     b.loadURI(Services.io.newURI("https://example.org/?squatter=" + Date.now()), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
     await new Promise(r => setTimeout(r, 3000));
     return { status: D.state.status, detail: D.state.detail, offline: Services.io.offline };`,
    60000,
  );
  check(
    "Windows: a port taken before tor starts leaves it offline",
    taken.status == "failed" && taken.offline === true && squatterHits == 0,
    `${taken.status}, offline=${taken.offline}, squatter hits=${squatterHits}: ${taken.detail}`,
  );
  await new Promise(resolve => squatter.close(resolve));
  const again = await chrome(
    m,
    `${DAEMON}
     await D.restart();
     const start = Date.now();
     while (D.state.status != "connected" && Date.now() - start < 120000) await new Promise(r => setTimeout(r, 250));
     return { status: D.state.status, offline: Services.io.offline };`,
    150000,
  );
  check("Windows: Restart Tor on the freed port connects", again.status == "connected" && again.offline === false, JSON.stringify(again));

  // The ordinary instance (prepare.cjs bans the port, as the launcher does).
  const main = new Marionette(mainPort);
  try {
    await main.connect(10000);
    await main.context("chrome");
    const allowed = await main.run(`return Services.io.allowPort(${port}, "http") || Services.io.allowPort(${port}, "https");`);
    check("Windows: the ordinary instance cannot reach tor's port", allowed === false);
    main.close();
  } catch (error) {
    check("Windows: the ordinary instance cannot reach tor's port", false, `no ordinary instance on ${mainPort}: ${error.message}`);
  }
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

(async () => {
  // Nothing may ever reach this server from a Tor window.
  let localHits = 0;
  const server = http.createServer((req, res) => {
    localHits++;
    res.end("local");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  const m = new Marionette(torPort);
  await m.connect(90000);

  const t0 = Date.now();
  const boot = await chrome(
    m,
    `${DAEMON}
     const seen = [];
     const start = Date.now();
     while (!["connected", "failed", "refused"].includes(D.state.status) && Date.now() - start < 150000) {
       if (seen.at(-1) !== D.state.progress) seen.push(D.state.progress);
       await new Promise(r => setTimeout(r, 250));
     }
     // Raw JSON bodies for the IP checks below (test only).
     Services.prefs.setBoolPref("devtools.jsonview.enabled", false);
     return { state: D.state, seen };`,
    170000,
  );
  check("tor connects", boot.state.status == "connected", `${((Date.now() - t0) / 1000).toFixed(1)} s, ${boot.state.summary} ${boot.state.detail}`);

  const env = await chrome(
    m,
    `const required = ["network.proxy.type", "network.proxy.socks", "network.dns.disabled", "network.proxy.failover_direct",
                       "network.proxy.allow_bypass", "media.peerconnection.enabled", "browser.privatebrowsing.autostart", "xpinstall.enabled"];
     const unlocked = required.filter(n => !Services.prefs.prefIsLocked(n));
     Services.prefs.setIntPref("network.proxy.type", 0);
     const proxyType = Services.prefs.getIntPref("network.proxy.type");
     let dns = "resolved";
     try {
       await new Promise((resolve, reject) => Services.dns.asyncResolve("example.com", Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT, 0, null,
         { onLookupComplete(_r, _rec, status) { Components.isSuccessCode(status) ? resolve() : reject(status); } }, Services.tm.mainThread, {}));
     } catch (e) {
       dns = "failed: " + (e?.name ?? e);
     }
     const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");
     const t = Date.now();
     let search = (await SearchService.getDefaultPrivate())?.name;
     while (search != "DuckDuckGo (Onion)" && Date.now() - t < 10000) {
       await new Promise(r => setTimeout(r, 200));
       search = (await SearchService.getDefaultPrivate())?.name;
     }
     const w = Services.wm.getMostRecentWindow("navigator:browser");
     return { unlocked, proxyType, dns, search, private: PrivateBrowsingUtils.isWindowPrivate(w),
              button: w.document.getElementById("aequera-tor-button")?.getAttribute("label") };`,
  );
  check("required prefs are locked", env.unlocked.length == 0, env.unlocked.join(", "));
  check("a write to network.proxy.type has no effect", env.proxyType == 1);
  check("no local DNS", env.dns.startsWith("failed"), env.dns);
  check("every window is private", env.private === true);
  check("searches go to DuckDuckGo's onion service", env.search == "DuckDuckGo (Onion)", env.search);
  check("the Tor button says connected", env.button == "Tor", env.button);

  const first = json((await load(m, "https://check.torproject.org/api/ip")).text);
  check("check.torproject.org: IsTor", first?.IsTor === true, JSON.stringify(first));

  const webrtc = await m.cmd("WebDriver:ExecuteScript", { script: "return typeof RTCPeerConnection;", args: [] });
  check("no WebRTC in pages", webrtc.value == "undefined", webrtc.value);

  // Tor Browser's hardening, as a page's own script sees it (it writes its
  // findings to the title: Marionette's scripts run in a realm of their own,
  // which fingerprinting resistance does not cover).
  const probe = `document.title = JSON.stringify({
        tz: new Date().getTimezoneOffset(),
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        lang: navigator.language,
        webgl2: !!document.createElement("canvas").getContext("webgl2"),
        serviceWorker: "serviceWorker" in navigator,
        webauthn: typeof PublicKeyCredential,
        cores: navigator.hardwareConcurrency,
        inner: [innerWidth, innerHeight],
        screen: [screen.width, screen.height],
      })`;
  const fp = json((await load(m, `data:text/html,<title>x</title><script>${encodeURIComponent(probe)}</script>`)).title) ?? {};
  check(
    "fingerprinting resistance: UTC, English, no WebGL 2, service workers, or WebAuthn",
    fp.tz == 0 && /UTC|Atlantic\/Reykjavik/.test(fp.zone) && fp.lang == "en-US" && !fp.webgl2 && !fp.serviceWorker && fp.webauthn == "undefined",
    JSON.stringify(fp),
  );
  const upgraded = await load(m, "http://check.torproject.org/api/ip");
  check("HTTPS-only: an http address loads over HTTPS", upgraded.documentURI.startsWith("https://check.torproject.org/"), upgraded.documentURI.slice(0, 60));

  // Safest: no page script runs. (Standard again afterwards.)
  const SCRIPTED = `data:text/html,<title>no-script</title><script>document.title="script-ran"</script>`;
  const standardTitle = (await load(m, SCRIPTED)).title;
  await chrome(m, `${DAEMON} await D.setSecurityLevel("safest");`);
  const safestTitle = (await load(m, SCRIPTED)).title;
  await chrome(m, `${DAEMON} await D.setSecurityLevel("standard");`);
  check("Safest: page scripts do not run (Standard: they do)", standardTitle == "script-ran" && safestTitle == "no-script", `${standardTitle} / ${safestTitle}`);

  const other = json((await load(m, "https://api.ipify.org/?format=json")).text);
  const keys = await chrome(m, `${DAEMON} return [...D.nonces.keys()];`);
  check("each site has its own circuit", keys.includes("torproject.org") && keys.includes("ipify.org"), keys.join(", "));
  console.log(`     exits: torproject.org ${first?.IP}, ipify.org ${other?.ip} (may coincide by chance)`);

  await chrome(m, `${DAEMON} D.newCircuitFor("torproject.org");`);
  const renewed = json((await load(m, "https://check.torproject.org/api/ip")).text);
  check("a new circuit is still Tor", renewed?.IsTor === true, `${first?.IP} -> ${renewed?.IP}`);

  const onion = await load(m, ONION, 120000);
  check("an onion site loads", /Tor Project/i.test(onion.title + onion.text), onion.title);

  // A search with the session's engine lands on the onion service's results.
  const query = await chrome(
    m,
    `const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");
     return (await SearchService.getDefaultPrivate()).getSubmission("aequera browser").uri.spec;`,
  );
  const searchPage = await load(m, query, 120000);
  check(
    "a search returns the onion service's results",
    searchPage.documentURI.startsWith("https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/") && /DuckDuckGo/i.test(searchPage.title),
    `${searchPage.title} ${searchPage.documentURI.slice(0, 70)}`,
  );

  const local = await load(m, `http://127.0.0.1:${server.address().port}/`, 60000);
  check("localhost is unreachable", localHits == 0 && !/^local$/.test(local.text), `hits=${localHits} ${local.documentURI.slice(0, 50)}`);

  await chrome(m, `${DAEMON} await D.stopTor();`);
  // A URL never loaded before: nothing can come from a cache.
  const down = await load(m, `https://example.com/?live-check=${Date.now()}`, 60000);
  check("with tor stopped nothing loads", down.documentURI.startsWith("about:neterror"), down.documentURI.slice(0, 60));
  const back = await chrome(
    m,
    `${DAEMON}
     D.startTor();
     const start = Date.now();
     while (D.state.status != "connected" && Date.now() - start < 120000) await new Promise(r => setTimeout(r, 250));
     const b = Services.wm.getMostRecentWindow("navigator:browser").gBrowser.selectedBrowser;
     const t = Date.now();
     while (b.documentURI.spec.startsWith("about:neterror") && Date.now() - t < 60000) await new Promise(r => setTimeout(r, 250));
     return { status: D.state.status, uri: b.documentURI.spec };`,
    200000,
  );
  check("reconnected, the failed tab reloads", back.status == "connected" && back.uri.startsWith("https://example.com"), back.uri.slice(0, 50));

  const win = await chrome(m, `${DAEMON} return { tcp: D.usesTcp(), port: D.socksPort };`);
  if (win.tcp) {
    await windowsChecks(m, win.port);
  }

  server.close();
  m.close();
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error("live check failed:", e);
  process.exit(1);
});
