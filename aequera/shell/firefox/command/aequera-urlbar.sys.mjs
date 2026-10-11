/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Aequera command surface: the urlbar provider bridge.
//
// One provider per process, registered with Firefox's public
// ProvidersManager API (no Firefox patch). It holds no logic of its own:
// each query asks the querying window's AequeraCommand (command/
// aequera-command.js, a window script) for rows, and each pick hands the
// row's action back to that window. Keep this module this thin. Modules are
// kept in the startup cache, so after a front-end rebuild a profile can run a
// stale copy of it; the window scripts always load fresh (see the shell
// README, "Startup cache"). Behavior changes belong in the window script.

import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
});

const DYNAMIC_TYPE = "aequeraCommand";

// Laid out like a native row: icon, title, separator, action label.
const VIEW_TEMPLATE = {
  attributes: { selectable: true },
  children: [
    {
      name: "no-wrap",
      tag: "span",
      classList: ["urlbarView-no-wrap"],
      children: [
        { name: "icon", tag: "img", classList: ["urlbarView-favicon"] },
        { name: "title", tag: "span", classList: ["urlbarView-title"] },
        { name: "title-separator", tag: "span", classList: ["urlbarView-title-separator"] },
        { name: "action", tag: "span", classList: ["urlbarView-action"] },
      ],
    },
  ],
};

const ICONS = {
  workspace: "chrome://browser/skin/tabbrowser/tab-groups.svg",
  closed: "chrome://browser/skin/history.svg",
  command: "chrome://global/skin/icons/arrow-right.svg",
};

class AequeraCommandProvider extends UrlbarProvider {
  /** queryContext -> the window whose urlbar started the query. */
  #windows = new WeakMap();

  get name() {
    return "AequeraCommands";
  }

  get type() {
    return lazy.UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  async isActive(queryContext, controller) {
    const window = controller?.browserWindow;
    if (
      queryContext.sapName != "urlbar" ||
      !queryContext.trimmedSearchString ||
      queryContext.restrictInSearchMode() ||
      !window?.AequeraCommand
    ) {
      return false;
    }
    this.#windows.set(queryContext, window);
    return true;
  }

  async startQuery(queryContext, addCallback) {
    const window = this.#windows.get(queryContext);
    if (!window || window.closed) {
      return;
    }
    let rows;
    try {
      rows = window.AequeraCommand.rows(queryContext.searchString);
    } catch (error) {
      console.error("aequera-urlbar: rows failed", error);
      return;
    }
    rows.forEach((row, index) => {
      addCallback(
        this,
        new lazy.UrlbarResult({
          type: lazy.UrlbarShared.RESULT_TYPE.DYNAMIC,
          source: lazy.UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
          // Right after the heuristic row, in model order.
          suggestedIndex: 1 + index,
          // Plain strings only: the payload crosses the urlbar actor boundary
          // and must not hold references into the window's compartment.
          // Namespaced: the view reserves payload fields such as `action`
          // (secondary-action button), `type`, and `title`.
          payload: {
            dynamicType: DYNAMIC_TYPE,
            aequera: {
              kind: String(row.kind),
              title: String(row.title),
              detail: String(row.detail),
              action: JSON.stringify(row.action),
            },
          },
        })
      );
    });
  }

  getViewTemplate(_result) {
    return VIEW_TEMPLATE;
  }

  getViewUpdate(result) {
    const { kind, title, detail } = result.payload.aequera;
    return {
      icon: { attributes: { src: ICONS[kind] ?? ICONS.command } },
      title: { textContent: title, attributes: { dir: "auto" } },
      action: { textContent: detail },
    };
  }

  onEngagement(_queryContext, controller, details) {
    const window = controller.browserWindow;
    try {
      window.AequeraCommand.run(JSON.parse(details.result.payload.aequera.action));
    } catch (error) {
      console.error("aequera-urlbar: pick failed", error);
    }
  }
}

export const AequeraUrlbar = {
  provider: new AequeraCommandProvider(),
};

lazy.ProvidersManager.getInstanceForSap("urlbar").registerProvider(AequeraUrlbar.provider);
