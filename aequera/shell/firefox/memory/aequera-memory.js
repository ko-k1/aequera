/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera memory saver: discard tabs that have not been selected for a while,
// so their content processes can be released. Firefox's own tab unloader only
// acts when memory is scarce; this is the time-based policy for a browser that
// should stay light on a roomy machine too.
//
// Site isolation stays on. This never puts different sites in one content
// process; it only releases processes by unloading tabs the user is not using.
// Tabs of the same site are consolidated separately by the default pref
// dom.ipc.processCount.webIsolated (aequera-prefs.js).
//
// Loaded into each browser window by aequera-main.js. The pref is a delay in
// ms; 0 disables it. A check runs once a minute and discards at most one tab
// per window, so a burst of old tabs is released gradually instead of in one
// flush storm. `unloadInactiveTabs({ due: false })` is the test/manual path.
//
// Tabs the user or a page is actively using stay loaded: the selected tab,
// pinned and hidden tabs (workspaces and extensions own hidden state),
// split-view panes, private tabs, media playback, Picture-in-Picture, WebRTC
// sharing, beforeunload pages (discardBrowser refuses them), and tabs marked
// undiscardable by a page or extension.

var AequeraMemory = (() => {
  const PREF = "aequera.memory.unloadInactiveAfterMs";
  const DEFAULT_MS = 10 * 60 * 1000;
  const CHECK_MS = 60 * 1000;
  const MAX_TABS_PER_CHECK = 1;

  let timer = 0;
  let running = false;
  let destroyed = false;

  function delay() {
    try {
      // A string or boolean set through about:config must not read as 0 and
      // silently disable the timer.
      if (Services.prefs.getPrefType(PREF) != Services.prefs.PREF_INT) {
        return DEFAULT_MS;
      }
      const ms = Services.prefs.getIntPref(PREF, DEFAULT_MS);
      return ms >= 0 ? ms : DEFAULT_MS;
    } catch {
      // A malformed user value must not stop the window from loading.
      return DEFAULT_MS;
    }
  }

  function isPrivateWindow() {
    return (
      typeof PrivateBrowsingUtils != "undefined" &&
      PrivateBrowsingUtils.isWindowPrivate(window)
    );
  }

  function canUnload(tab, now, minAge) {
    if (
      tab.closing ||
      tab.selected ||
      tab.pinned ||
      // Hidden tabs belong to workspaces or extensions; workspaces have
      // their own unload clock, and extension state is not ours to discard.
      tab.hidden ||
      // Both panes are on screen; unloading one collapses the view.
      tab.splitview ||
      tab.undiscardable ||
      tab.soundPlaying ||
      tab.pictureinpicture ||
      tab.hasAttribute("pending")
    ) {
      return false;
    }
    const browser = tab.linkedBrowser;
    if (!browser?.isConnected || !browser.isRemoteBrowser) {
      return false;
    }
    // A page that is still loading may be about to become interactive; let
    // it settle and catch it on a later pass.
    if (browser.webProgress?.isLoadingDocument) {
      return false;
    }
    if (browser._sharingState?.webRTC?.sharing) {
      return false;
    }
    try {
      if (
        browser.browsingContext?.currentWindowGlobal?.hasActivePeerConnections()
      ) {
        return false;
      }
    } catch {
      // A browser going away: nothing to discard.
      return false;
    }
    if (
      typeof PrivateBrowsingUtils != "undefined" &&
      PrivateBrowsingUtils.isBrowserPrivate(browser)
    ) {
      return false;
    }
    return now - tab.lastAccessed >= minAge;
  }

  /**
   * Discard inactive tabs in this window. With `due`, only tabs whose own
   * delay has passed are candidates (the timer's pass); without it, every tab
   * that passes the protections is a candidate (tests and manual unload).
   * Returns the number discarded.
   */
  async function unloadInactiveTabs({
    due = true,
    limit = MAX_TABS_PER_CHECK,
  } = {}) {
    if (running || isPrivateWindow()) {
      return 0;
    }
    const minAge = due ? delay() : 0;
    if (due && !minAge) {
      return 0;
    }
    running = true;
    let unloaded = 0;
    try {
      const now = Date.now();
      const max = Number.isFinite(limit) ? Math.max(0, limit) : Infinity;
      for (const tab of gBrowser.tabs) {
        if (unloaded >= max) {
          break;
        }
        if (!canUnload(tab, now, minAge)) {
          continue;
        }
        try {
          // Flush session state first, so switching back restores the page.
          await gBrowser.prepareDiscardBrowser(tab);
        } catch {
          continue;
        }
        // Flushing is async: the tab may be selected, closed, or start
        // playing media since the snapshot.
        if (!canUnload(tab, Date.now(), minAge)) {
          continue;
        }
        try {
          if (gBrowser.discardBrowser(tab)) {
            unloaded++;
          }
        } catch (error) {
          console.error("aequera-memory: discarding a tab failed", error);
        }
      }
    } finally {
      running = false;
    }
    return unloaded;
  }

  function schedule(wait = CHECK_MS) {
    if (destroyed) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    if (delay() && !isPrivateWindow()) {
      timer = setTimeout(tick, wait);
    }
  }

  async function tick() {
    timer = 0;
    try {
      await unloadInactiveTabs({ due: true });
    } catch (error) {
      console.error("aequera-memory: unloading inactive tabs failed", error);
    }
    schedule();
  }

  function onPrefChange() {
    // A short delay is a test/manual setting; check it soon, then return to
    // the normal minute cadence.
    schedule(Math.min(delay(), CHECK_MS));
  }

  function destroy() {
    destroyed = true;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    Services.prefs.removeObserver(PREF, onPrefChange);
  }

  Services.prefs.addObserver(PREF, onPrefChange);
  window.addEventListener("unload", destroy, { once: true });
  // Start after the window is usable; the first check is still a minute away
  // unless a shorter delay was configured.
  window.delayedStartupPromise.then(() =>
    schedule(Math.min(delay(), CHECK_MS))
  );

  return {
    unloadInactiveTabs,
    get delay() {
      return delay();
    },
  };
})();
