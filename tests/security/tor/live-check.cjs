// Tor window live check, step 2 (README.md): drives a Tor instance through
// the real Tor network and checks that nothing reaches the network around
// tor. Needs network access to the Tor network.
//
//   node tests/security/tor/live-check.cjs [Tor port=28282]
// Exit 0 when every check passes.
const http = require("http");
const { Marionette } = require("./marionette.cjs");

const torPort = Number(process.argv[2] ?? 28282);
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

  server.close();
  m.close();
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error("live check failed:", e);
  process.exit(1);
});
