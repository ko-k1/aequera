/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Tor windows: window side (docs/adr/0004-tor-windows.md, docs/design/TOR.md).
// Loaded into each browser window by aequera-main.js.
//
// Every window: "New Tor Window" in the app menu and the File menu,
// Ctrl+Shift+Alt+P (Command+Option+Shift+P on macOS), and "Open Link
// in Tor Window" on links. In the ordinary instance they start the Tor
// instance (aequera-tor-launch.sys.mjs); in the Tor instance every window is
// a Tor window, so they open one of its own.
//
// Tor instance windows: starts the instance's tor and circuit filter
// (aequera-tor-daemon.sys.mjs) and shows their state: the Tor button at the
// start of the toolbar (progress while connecting), its panel (status, new
// circuit for this site), and a notification when Tor stopped or the
// window refused to browse. Tabs that failed while Tor was connecting
// reload once it is connected.

var AequeraTor = (() => {
  const { AequeraTorLauncher } = ChromeUtils.importESModule(
    "chrome://browser/content/aequera/tor/aequera-tor-launch.sys.mjs",
  );
  const { AequeraTorDaemon } = ChromeUtils.importESModule(
    "chrome://browser/content/aequera/tor/aequera-tor-daemon.sys.mjs",
  );
  const { AequeraTorPlatform } = ChromeUtils.importESModule(
    "chrome://browser/content/aequera/platform/aequera-tor-platform.sys.mjs",
  );
  const KEY_ID = "aequera-key-tor-window";
  const NOTIFICATION = "aequera-tor-status";
  const WARNING_NOTIFICATION = "aequera-tor-warning";
  // Loads before tor listened (proxy errors), or before the instance went
  // online (it starts offline: netOffline).
  const PROXY_ERRORS = ["proxyConnectFailure", "proxyResolveFailure", "netOffline"];

  const tor = {
    instance: AequeraTorDaemon.isInstance(),
    lastStatus: null,
    button: null,
    panel: null,

    /** Why "New Tor Window" is unavailable here, or null. */
    unavailable() {
      if (this.instance) {
        return null;
      }
      return AequeraTorLauncher.unavailable();
    },

    /**
     * Open a Tor window (with a URL: a web link).
     *
     * @param {string|null} [url]
     */
    open(url = null) {
      if (this.instance) {
        if (url) {
          openTrustedLinkIn(url, "window", { private: true });
        } else {
          OpenBrowserWindow({ private: true });
        }
        return Promise.resolve();
      }
      return AequeraTorLauncher.openWindow(url).catch(error => {
        console.error("aequera-tor: cannot open a Tor window", error);
        this.notify(`Could not open a Tor window: ${error.message}`, "critical");
      });
    },

    // Entry points (every window)

    mountKey() {
      const keyset = document.createXULElement("keyset");
      keyset.id = "aequera-tor-keyset";
      const key = document.createXULElement("key");
      key.id = KEY_ID;
      // Private window's Ctrl+Shift+P, plus Alt (keys match modifiers
      // exactly, so neither Print nor Private Window fires).
      key.setAttribute("key", "P");
      key.setAttribute("modifiers", "accel,alt,shift");
      key.addEventListener("command", () => this.open());
      keyset.append(key);
      document.documentElement.append(keyset);
    },

    menuItem(tag, id, label) {
      const item = document.createXULElement(tag);
      item.id = id;
      item.setAttribute("label", label);
      item.setAttribute("key", KEY_ID);
      item.addEventListener("command", () => this.open());
      return item;
    },

    /** File menu: after "New Private Window". */
    mountFileMenu() {
      const anchor = document.getElementById("menu_newPrivateWindow");
      if (anchor && !document.getElementById("menu_aequeraTorWindow")) {
        anchor.after(this.menuItem("menuitem", "menu_aequeraTorWindow", "New Tor Window"));
      }
    },

    /** App menu: after "New private window". Its main view is built from a
     *  template the first time it shows, so this runs on every ViewShowing. */
    mountAppMenu() {
      const anchor = document.getElementById("appMenu-new-private-window-button2");
      if (anchor && !document.getElementById("appMenu-aequera-tor-window-button")) {
        const item = this.menuItem("toolbarbutton", "appMenu-aequera-tor-window-button", "New Tor window");
        item.className = "subviewbutton";
        // PanelUI shows a view's shortcuts once, before this item exists.
        const key = document.getElementById(KEY_ID);
        if (key) {
          item.setAttribute("shortcut", ShortcutUtils.prettifyShortcut(key));
        }
        anchor.after(item);
      }
    },

    /** Link context menu: after "Open Link in New Private Window", shown
     *  with it, for web links. */
    mountLinkMenu() {
      const menu = document.getElementById("contentAreaContextMenu");
      const anchor = document.getElementById("context-openlinkprivate");
      if (!menu || !anchor) {
        console.error("aequera-tor: link context menu missing");
        return;
      }
      const item = document.createXULElement("menuitem");
      item.id = "context-aequera-openlinktor";
      item.className = "context-menu-open-link";
      item.setAttribute("label", "Open Link in Tor Window");
      item.addEventListener("command", () => this.open(gContextMenu?.linkURL ?? null));
      anchor.after(item);
      // After nsContextMenu's own popupshowing handler (the menu's
      // attribute, registered first), which has set the anchor's state.
      menu.addEventListener("popupshowing", event => {
        if (event.target == menu) {
          item.hidden = anchor.hidden || !AequeraTorModel.isTorOpenableUrl(gContextMenu?.linkURL);
        }
      });
    },

    // Tor instance windows

    mountIndicator() {
      const navbar = document.getElementById("nav-bar");
      const target = document.getElementById("nav-bar-customization-target");
      if (!navbar || !target) {
        console.error("aequera-tor: nav-bar missing; no Tor indicator");
        return;
      }
      const button = document.createXULElement("toolbarbutton");
      button.id = "aequera-tor-button";
      button.className = "toolbarbutton-1";
      button.setAttribute("label", "Tor");
      button.setAttribute("aria-haspopup", "dialog");
      button.addEventListener("command", () => this.togglePanel());
      navbar.insertBefore(button, target);
      this.button = button;

      const panel = document.createXULElement("panel");
      panel.id = "aequera-tor-panel";
      panel.setAttribute("type", "arrow");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-labelledby", "aequera-tor-panel-title");
      const body = document.createElement("div");
      body.className = "aequera-tor-panel-body";
      const title = document.createElement("h2");
      title.id = "aequera-tor-panel-title";
      title.textContent = "Tor window";
      const status = document.createElement("p");
      status.className = "aequera-tor-status";
      status.setAttribute("role", "status");
      const progress = document.createElement("progress");
      progress.className = "aequera-tor-progress";
      progress.max = 100;
      const detail = document.createElement("p");
      detail.className = "aequera-tor-detail";
      const warnings = document.createElement("p");
      warnings.className = "aequera-tor-warnings";
      const about = document.createElement("p");
      about.className = "aequera-tor-about";
      about.textContent =
        "Sites and your network see a Tor address, not yours, and each site gets its own circuits. " +
        "Fingerprinting is resisted as in Tor Browser, and nothing from this window is kept. " +
        "Sites can still tell this browser apart from Tor Browser.";
      const actions = document.createElement("div");
      actions.className = "aequera-tor-actions";
      const circuit = document.createElement("button");
      circuit.className = "aequera-tor-new-circuit";
      circuit.textContent = "New circuit for this site";
      circuit.addEventListener("click", () => this.newCircuit());
      const restart = document.createElement("button");
      restart.className = "aequera-tor-restart";
      restart.textContent = "Restart Tor";
      restart.addEventListener("click", () => AequeraTorDaemon.restart());
      actions.append(circuit, restart);
      body.append(title, status, progress, detail, warnings, actions, this.securityLevelGroup(), about);
      panel.append(body);
      document.getElementById("mainPopupSet").append(panel);
      this.panel = panel;
    },

    /** Tor Browser's security levels (tor-model.js SECURITY_LEVELS). */
    securityLevelGroup() {
      const levels = {
        standard: ["Standard", "Every site works as in Firefox."],
        safer: ["Safer", "No JavaScript JIT or WebAssembly, no MathML or SVG fonts, no autoplay."],
        safest: ["Safest", "Also no JavaScript, SVG, or web fonts. Many sites break."],
      };
      const group = document.createElement("fieldset");
      group.className = "aequera-tor-security";
      const legend = document.createElement("legend");
      legend.textContent = "Security level";
      group.append(legend);
      for (const [level, [name, description]] of Object.entries(levels)) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "aequera-tor-security-level";
        input.value = level;
        input.addEventListener("change", () => {
          if (!input.checked) {
            return;
          }
          AequeraTorDaemon.setSecurityLevel(level).catch(error => {
            console.error("aequera-tor: cannot switch the security level", error);
            this.notify(`The security level could not be changed: ${error.message}`, "critical");
            // The radios show the level that is in force.
            this.render(AequeraTorDaemon.state);
          });
        });
        const text = document.createElement("span");
        const strong = document.createElement("strong");
        strong.textContent = name;
        text.append(strong, document.createElement("br"), description);
        label.append(input, text);
        group.append(label);
      }
      const hint = document.createElement("p");
      hint.className = "aequera-tor-security-hint";
      hint.textContent = "Applies to pages you load from now on; reload open pages.";
      group.append(hint);
      return group;
    },

    togglePanel() {
      if (this.panel.state == "open" || this.panel.state == "showing") {
        this.panel.hidePopup();
      } else {
        this.panel.openPopup(this.button, "bottomleft topleft");
      }
    },

    /** New circuits for the selected tab's site, then reload it. */
    newCircuit() {
      const site = AequeraTorDaemon.siteForURI(gBrowser.currentURI);
      if (!site) {
        return;
      }
      AequeraTorDaemon.newCircuitFor(site);
      gBrowser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
      this.panel?.hidePopup();
    },

    render(state) {
      const connected = state.status == "connected";
      const button = this.button;
      if (button) {
        button.setAttribute("tor-status", state.status);
        let label = "Tor";
        if (state.status == "starting" || state.status == "bootstrapping") {
          label = `Tor ${state.progress}%`;
        } else if (state.status == "failed" || state.status == "refused") {
          label = "Tor offline";
        }
        button.setAttribute("label", label);
        button.setAttribute("tooltiptext", `${state.summary || "Tor"}${state.detail ? `\n${state.detail}` : ""}`);
      }
      if (this.panel) {
        this.panel.querySelector(".aequera-tor-status").textContent = state.summary;
        const progress = this.panel.querySelector(".aequera-tor-progress");
        progress.value = state.progress;
        progress.hidden = connected || state.status == "failed" || state.status == "refused";
        this.panel.querySelector(".aequera-tor-detail").textContent = state.detail;
        this.panel.querySelector(".aequera-tor-new-circuit").hidden = !connected;
        this.panel.querySelector(".aequera-tor-restart").hidden = state.status != "failed";
        const level = AequeraTorDaemon.securityLevel();
        for (const input of this.panel.querySelectorAll(".aequera-tor-security input")) {
          input.checked = input.value == level;
        }
        this.panel.querySelector(".aequera-tor-warnings").textContent = (state.warnings ?? []).join("\n");
      }

      // Each new warning (search engine, remembered security level) once.
      const warnings = state.warnings ?? [];
      if (warnings.length > this.warningsShown) {
        this.warningsShown = warnings.length;
        this.showWarning(warnings.at(-1));
      }

      if (state.status == "failed") {
        this.notify(`Tor is not connected: ${state.summary}${state.detail ? ` (${state.detail})` : ""}`, "critical", [
          { label: "Restart Tor", callback: () => void AequeraTorDaemon.restart() },
        ]);
      } else if (state.status == "refused") {
        this.notify(state.summary, "critical");
      } else {
        this.clearNotification();
      }
      if (connected && this.lastStatus != "connected") {
        this.reloadFailedTabs();
      }
      this.lastStatus = state.status;
    },

    /** Tabs showing a proxy error (loaded before tor listened) reload. */
    reloadFailedTabs() {
      for (const tab of gBrowser.tabs) {
        const spec = tab.linkedBrowser?.documentURI?.spec ?? "";
        if (PROXY_ERRORS.some(code => spec.startsWith(`about:neterror?e=${code}`))) {
          tab.linkedBrowser.reload();
        }
      }
    },

    /** The label of the notification shown, so a state repeat keeps it. */
    notified: null,

    async notify(label, level, buttons = []) {
      const box = gNotificationBox;
      if (this.notified == label && box.getNotificationWithValue(NOTIFICATION)) {
        return;
      }
      box.getNotificationWithValue(NOTIFICATION)?.close();
      this.notified = label;
      const priority = level == "critical" ? box.PRIORITY_CRITICAL_MEDIUM : box.PRIORITY_INFO_MEDIUM;
      try {
        await box.appendNotification(NOTIFICATION, { label, priority }, buttons);
      } catch (error) {
        console.error("aequera-tor: notification failed", error);
      }
    },

    clearNotification() {
      this.notified = null;
      gNotificationBox.getNotificationWithValue(NOTIFICATION)?.close();
    },

    /** Warnings shown so far (render shows each new one once). */
    warningsShown: 0,

    /** A warning, in its own notification: status changes do not clear it. */
    async showWarning(label) {
      const box = gNotificationBox;
      box.getNotificationWithValue(WARNING_NOTIFICATION)?.close();
      try {
        await box.appendNotification(WARNING_NOTIFICATION, { label, priority: box.PRIORITY_WARNING_MEDIUM });
      } catch (error) {
        console.error("aequera-tor: warning notification failed", error);
      }
    },

    init() {
      // The Tor instance locks its network prefs and starts tor right away:
      // none of it needs the window's markup, which is parsed after this
      // script runs.
      if (this.instance) {
        AequeraTorDaemon.ensureStarted()?.catch?.(error => console.error("aequera-tor: startup failed", error));
      } else if (AequeraTorPlatform.transport == "tcp" && !this.unavailable()) {
        // A Tor instance can outlive this one: ban its port from the start,
        // not only when the next Tor window is opened (idempotent).
        AequeraTorLauncher.banTorPort().catch(error => console.error("aequera-tor: cannot ban tor's port", error));
      }
      window.addEventListener("load", () => this.mount(), { once: true });
    },

    mount() {
      // Off (aequera.tor.enabled), or a platform without Tor windows: no
      // entry points at all.
      if (!this.unavailable()) {
        this.mountKey();
        this.mountFileMenu();
        this.mountLinkMenu();
        window.addEventListener("ViewShowing", () => this.mountAppMenu(), true);
      }
      if (!this.instance) {
        return;
      }
      document.documentElement.setAttribute("aequera-tor", "true");
      this.mountIndicator();
      const unsubscribe = AequeraTorDaemon.subscribe(state => this.render(state));
      window.addEventListener("unload", unsubscribe, { once: true });
      this.render(AequeraTorDaemon.state);
    },
  };

  tor.init();
  return tor;
})();
