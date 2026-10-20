/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// One new tab page per window (newtab-model.js): New Tab (Ctrl+T, the tab
// strip's and the rail's +, the command surface) goes to an untouched new tab
// page already open in this workspace instead of loading another, and focuses
// the address bar as a new tab does. Every one of those entry points calls
// BrowserCommands.openTab(); this wraps it. Requests that ask for something
// else (a URL, a background tab, a new window, middle-click paste) open as
// Firefox opens them. aequera.newtab.single off restores Firefox's behavior.

var AequeraNewTabWindow = (() => {
  const PREF = "aequera.newtab.single";

  const newTabWindow = {
    /** Firefox's BrowserCommands.openTab, which this wraps. */
    openTab: null,

    enabled() {
      return Services.prefs.getBoolPref(PREF, true);
    },

    /**
     * Whether a request to BrowserCommands.openTab() asks for a plain new
     * tab page in the foreground of this window, the request one already open
     * can answer.
     */
    plainRequest({ event, url } = {}) {
      if (url) {
        return false;
      }
      if (!event) {
        return true;
      }
      if (
        event.button == 1 &&
        Services.prefs.getBoolPref("middlemouse.paste", false) &&
        gMiddleClickNewTabUsesPasteboard
      ) {
        return false;
      }
      const where = BrowserUtils.whereToOpenLink(event, false, true);
      return where == "tab" || where == "current";
    },

    /** The tab to reuse for a new tab request, or null. */
    reusableTab() {
      const tabs = gBrowser.visibleTabs;
      const newTabURL = BROWSER_NEW_TAB_URL;
      const index = AequeraNewTabModel.reusable(
        tabs.map(tab => {
          const browser = tab.linkedBrowser;
          return {
            url: browser?.currentURI?.spec,
            newTabURL,
            selected: tab.selected,
            pinned: tab.pinned,
            hidden: tab.hidden,
            pending: tab.hasAttribute("pending") || !tab.linkedPanel,
            busy: tab.hasAttribute("busy"),
            canGoBack: browser?.canGoBack,
            canGoForward: browser?.canGoForward,
            typed: !!browser?.userTypedValue,
          };
        })
      );
      return index == -1 ? null : tabs[index];
    },

    /** BrowserCommands.openTab, answered by an open page when it can be. */
    open(options) {
      let tab = null;
      try {
        tab = this.enabled() && this.plainRequest(options) ? this.reusableTab() : null;
      } catch (error) {
        // New Tab must keep working: fall back to opening one.
        console.error("aequera: new tab reuse failed", error);
      }
      if (!tab) {
        this.openTab.call(BrowserCommands, options);
        return;
      }
      gBrowser.selectedTab = tab;
      // As a new tab does. Focus taken before the tab switch settles keeps
      // the switch from moving it to the page (Tabbrowser
      // _adjustFocusAfterTabSwitch).
      gURLBar.select();
    },

    init() {
      if (typeof BrowserCommands != "object" || typeof BrowserCommands.openTab != "function") {
        return;
      }
      this.openTab = BrowserCommands.openTab;
      BrowserCommands.openTab = options => this.open(options);
    },
  };

  newTabWindow.init();
  return newTabWindow;
})();
