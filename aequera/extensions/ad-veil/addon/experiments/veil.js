/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* global ExtensionAPI, Services */

// Ad Veil's one privileged API (ADR 0003; docs/design/ADS.md, Veil mode).
//
// Firefox's tracking protection blocks the major ad networks before any
// extension sees the request. On a site the user veiled, this lets those
// ad requests through, and nothing else:
// - a tracking-protection block from an advertising table
//   (aequera.adveil.veil.adTables, default Firefox's ads-track list), or of
//   an EasyList ad server host;
// - a fingerprinting-protection block of an EasyList ad server host (the
//   largest ad networks are on Firefox's fingerprinting list too).
// Social, cryptomining, email, and analytics blocking stay, and the site
// keeps tracking protection's cookie and storage rules: this lifts single
// blocks, it does not add a site exception, and an allowed channel is still a
// tracking channel to Firefox (nsIChannelClassifierService.idl), so tracker
// cookie rules keep applying to it. It uses Firefox's channel classifier
// service, as Firefox's own webcompat add-on does, and listens only while a
// site is veiled.

const TRACKING = Ci.nsIUrlClassifierBlockedChannel.TRACKING_PROTECTION;
const FINGERPRINTING = Ci.nsIUrlClassifierBlockedChannel.FINGERPRINTING_PROTECTION;
const AD_TABLES_PREF = "aequera.adveil.veil.adTables";
const AD_TABLES_DEFAULT = "ads-track-digest256";
// Where jar.mn packages the add-on (resource://builtin-addons/adveil/).
const MODEL_BASE = "resource://builtin-addons/adveil/";

this.aequeraVeil = class extends ExtensionAPI {
  constructor(extension) {
    super(extension);
    // The add-on's model: the same site rules as its background page.
    const sandbox = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), {
      wantGlobalProperties: ["URL"],
      sandboxName: "Ad Veil model",
    });
    // Through Ad Veil's built-in resource URL: the script loader refuses the
    // file: root an unpacked (developer) build gives the add-on.
    Services.scriptloader.loadSubScript(`${MODEL_BASE}model.js`, sandbox);
    this.model = sandbox.VeilModel;
    this.adHosts = new Set();
    this.modes = { off: new Set(), veil: new Set(), privateModes: new Map() };
    this.classifier = null;
  }

  onShutdown() {
    this.stop();
  }

  adTables() {
    const value = Services.prefs.getStringPref(AD_TABLES_PREF, AD_TABLES_DEFAULT);
    return new Set(
      value
        .split(",")
        .map(table => table.trim())
        .filter(Boolean)
    );
  }

  allows(channel) {
    const site = this.model.siteOf(channel.topLevelUrl);
    if (this.model.resolveMode(this.modes, site, channel.isPrivateBrowsing) != "veil") {
      return false;
    }
    const adHost = this.model.covers(this.adHosts, this.model.hostOf(channel.url));
    if (channel.reason == TRACKING) {
      const tables = this.adTables();
      return adHost || channel.tables.split(",").some(table => tables.has(table.trim()));
    }
    return channel.reason == FINGERPRINTING && adHost;
  }

  observe(subject, topic) {
    if (topic != "urlclassifier-before-block-channel") {
      return;
    }
    const channel = subject.QueryInterface(Ci.nsIUrlClassifierBlockedChannel);
    try {
      if (this.allows(channel)) {
        channel.allow();
      }
    } catch (error) {
      // A malformed channel is left blocked.
      console.error("Ad Veil: veil decision failed", error);
    }
  }

  start() {
    if (this.classifier) {
      return;
    }
    this.classifier = Cc["@mozilla.org/url-classifier/channel-classifier-service;1"].getService(
      Ci.nsIChannelClassifierService
    );
    this.listener = { observe: (subject, topic) => this.observe(subject, topic) };
    this.classifier.addListener(this.listener);
  }

  stop() {
    if (!this.classifier) {
      return;
    }
    this.classifier.removeListener(this.listener);
    this.classifier = null;
    this.listener = null;
  }

  site(value) {
    return this.model.siteOf(`https://${value}/`);
  }

  getAPI() {
    return {
      aequeraVeil: {
        setAdHosts: async hosts => {
          this.adHosts = new Set(hosts.map(host => this.model.hostOf(`https://${host}/`)).filter(Boolean));
        },
        setSiteModes: async (offSites, veilSites, privateModes) => {
          const sites = list => new Set(list.map(value => this.site(value)).filter(Boolean));
          this.modes = {
            off: sites(offSites),
            veil: sites(veilSites),
            privateModes: new Map(privateModes.map(({ site, mode }) => [this.site(site), mode]).filter(([site]) => site)),
          };
          // Listen only while some page could be veiled.
          const anyVeil = this.modes.veil.size || [...this.modes.privateModes.values()].includes("veil");
          if (anyVeil) {
            this.start();
          } else {
            this.stop();
          }
        },
      },
    };
  }
};
