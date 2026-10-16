#!/bin/bash
# Aequera shell test gate. Run from the build shell inside worktree/firefox
# after `aequera patch apply` and `./mach build`.
#
#   bash tools/build/test-shell.sh [aequera|upstream|all] [--repeat N]
# (run from worktree/firefox; the script path is relative to the checkout root)
#
# aequera:  Aequera-owned tests (browser/aequera/tests: the shell;
#           browser/aequera-adveil/tests: Ad Veil), Aequera defaults.
# upstream: Firefox's own sidebar, tab, bookmarks-toolbar, about:home cache,
#           private browsing page, and in-content page (error pages,
#           Settings, about:protections) tests with Firefox's defaults
#           restored, to prove the patches change nothing by default.
#
# What differs per OS (extra Firefox defaults, dist fixes) comes from
# tools/build/<os>/platform.sh.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAUNCHER=test-shell
. "$SCRIPT_DIR/common/host.sh"
aequera_load_platform
# Step parsing: explicit suite or all; leading flags mean "all + flags".
# Unknown positional steps fail closed (never zero-suite green).
step=all
if [ $# -gt 0 ]; then
  case "$1" in
    aequera|upstream|all) step="$1"; shift ;;
    -*) step=all ;;
    *) echo "test-shell: unknown step '$1'; want [aequera|upstream|all] [--repeat N]" >&2; exit 2 ;;
  esac
fi
extra=("$@")

# Firefox release defaults for the prefs aequera-prefs.js overrides that
# Firefox's tests depend on.
FIREFOX_DEFAULTS=(
  # Aequera locks sidebar.revamp and friends (aequera-prefs.js); Firefox's own
  # tests must turn the revamp on, so upstream runs (only) unlock them.
  --setenv AEQUERA_UNLOCK_SHELL_PREFS=1
  --setpref sidebar.revamp=false
  --setpref sidebar.verticalTabs=false
  --setpref sidebar.verticalTabs.requireRevamp=true
  --setpref browser.tabs.parkedHiddenSources=
  --setpref browser.toolbars.bookmarks.visibility=newtab
  --setpref aequera.bookmarks.hoverPeek=false
  --setpref browser.uiCustomization.defaultExclusions=
  --setpref browser.uiCustomization.defaultNavbarPlacements=
  # Privacy defaults: with unified telemetry off, Glean interaction events
  # are not recorded and browser_vertical_tabs.js fails its "must be
  # recorded" checks. Upload/study/sponsored prefs stay as Firefox's test
  # profile sets them (testing/profiles), so tests stay offline.
  --setpref toolkit.telemetry.unified=true
  --setpref toolkit.telemetry.archive.enabled=true
  # Privacy model and appearance: Firefox's Standard tracking protection
  # (the one-time Strict switch is marked done before the first window),
  # no GPC header, and the light scheme headless Firefox reports without
  # the dark default.
  --setpref aequera.privacy.trackingProtectionApplied=true
  --setpref privacy.globalprivacycontrol.enabled=false
  --setpref ui.systemUsesDarkTheme=0
  # Ad Veil: Firefox has no built-in content blocker; its tests must not
  # run behind EasyList.
  --setpref aequera.adveil.enabled=false
  # AI features: Firefox 157's defaults (Aequera blocks them by default);
  # the sidebar tests list the chatbot, the tabs pane shows smart tab groups.
  --setpref browser.ai.control.default=available
  --setpref browser.ai.control.translations=default
  --setpref browser.ai.control.pdfjsAltText=default
  --setpref browser.ai.control.smartTabGroups=default
  --setpref browser.ai.control.linkPreviewKeyPoints=default
  --setpref browser.ai.control.sidebarChatbot=default
  --setpref browser.ai.control.smartWindow=default
  --setpref browser.ai.control.speechRecognition=default
  --setpref browser.ml.chat.enabled=true
  --setpref browser.ml.linkPreview.enabled=true
  --setpref browser.tabs.groups.smart.enabled=true
  --setpref browser.tabs.groups.smart.userEnabled=true
  --setpref browser.translations.enable=true
  --setpref pdfjs.enableAltText=true
  --setpref extensions.ml.enabled=true
)
# Per-OS defaults (frame material: Windows 11 Mica), only where the pref
# means something. (A read loop, not mapfile: macOS runs bash 3.2.)
while IFS= read -r arg; do
  FIREFOX_DEFAULTS+=("$arg")
done < <(aequera_platform_test_prefs)
SIDEBAR_TESTS=browser/components/sidebar/tests/browser
TAB_TESTS=browser/components/tabbrowser/test/browser/tabs
PLACES_TESTS=browser/components/places/tests/browser
HOMECACHE_TESTS=browser/components/newtab/test/browser/abouthomecache
PRIVATE_TESTS=browser/components/privatebrowsing/test/browser
PREFS_TESTS=browser/components/preferences/tests
status=0

# Artifact builds do not refresh the test index on their own; new or moved
# Aequera test manifests are invisible to mach until this runs.
./mach build-backend -b TestManifest > /dev/null || status=1

# The platform's dist fixes (Windows: the build's symlinks become copies,
# tools/build/windows/dist_copies.py), for every objdir of this worktree,
# whichever MOZCONFIG runs.
for bin in "$ROOT/obj/$(basename "$PWD")"/*/dist/bin; do
  [ -d "$bin" ] || continue
  aequera_platform_prepare_dist "$bin" || status=1
done

if [ "$step" = aequera ] || [ "$step" = all ]; then
  ./mach mochitest --headless "${extra[@]}" \
    browser/aequera/tests/browser browser/aequera-adveil/tests/browser || status=1
fi
if [ "$step" = upstream ] || [ "$step" = all ]; then
  # Sidebar: patches/browser/aequera-rail touches the revamp coupling,
  # toggleTabstrip, and CustomizableUI.reset. Each file runs in its own
  # session: on an Aequera build the DEFAULT pref branch differs from
  # Firefox's (vertical tabs on), which --setpref (user branch) cannot undo,
  # and these files otherwise leak saved sidebar state into each other.
  for file in \
    browser_sidebar_animation.js \
    browser_launcher_splitter_expand_on_hover.js \
    browser_sidebar_expand_on_hover.js \
    browser_vertical_tabs.js \
    browser_toolbar_sidebar_button.js; do
    ./mach mochitest --headless "${extra[@]}" "${FIREFOX_DEFAULTS[@]}" \
      --setpref sidebar.visibility=always-show \
      "$SIDEBAR_TESTS/$file" || status=1
  done
  # Tab closing / hidden tabs: patches/browser/workspace-hooks touches
  # Tabbrowser's last-tab path.
  ./mach mochitest --headless "${extra[@]}" "${FIREFOX_DEFAULTS[@]}" \
    "$TAB_TESTS/browser_closeWindowWithLastTab_contentClose.js" \
    "$TAB_TESTS/browser_hiddentab_contextmenu.js" \
    "$TAB_TESTS/browser_pinned_and_hidden_tabs.js" \
    "$TAB_TESTS/browser_multiselect_tabs_close.js" \
    "$TAB_TESTS/browser_list_all_tabs_menu_items.js" || status=1
  # Bookmarks toolbar: Aequera's drawer restyles and re-times it.
  ./mach mochitest --headless "${extra[@]}" "${FIREFOX_DEFAULTS[@]}" \
    "$PLACES_TESTS/browser_autoshow_bookmarks_toolbar.js" \
    "$PLACES_TESTS/browser_bookmarks_toolbar_context_menu_view_options.js" \
    "$PLACES_TESTS/browser_click_bookmarks_on_toolbar.js" \
    "$PLACES_TESTS/browser_toolbar_overflow.js" || status=1
  # New tab: patches/browser/newtab changes the page about:newtab and
  # about:home resolve to and the about:home startup cache lookup; with
  # aequera.newtab.enabled off both must behave exactly as in Firefox.
  ./mach mochitest --headless "${extra[@]}" "${FIREFOX_DEFAULTS[@]}" \
    --setpref aequera.newtab.enabled=false \
    "$HOMECACHE_TESTS/browser_basic_endtoend.js" \
    "$HOMECACHE_TESTS/browser_no_cache.js" \
    "$HOMECACHE_TESTS/browser_overwrite_cache.js" \
    "$HOMECACHE_TESTS/browser_same_consumer.js" || status=1
  # Private browsing page: patches/browser/privatebrowsing adds a stylesheet
  # gated by aequera.privatebrowsing.enabled; off (with Firefox's promo
  # defaults) the page must behave exactly as in Firefox. The pin promo test
  # is skipped on Firefox's own Linux CI and is left out here too.
  ./mach mochitest --headless "${extra[@]}" "${FIREFOX_DEFAULTS[@]}" \
    --setpref aequera.privatebrowsing.enabled=false \
    --setpref browser.vpn_promo.enabled=true \
    --setpref browser.promo.relay.enabled=true \
    --setpref browser.promo.pin.enabled=true \
    "$PRIVATE_TESTS/browser_privatebrowsing_about.js" \
    "$PRIVATE_TESTS/browser_privatebrowsing_about_search_banner.js" \
    "$PRIVATE_TESTS/browser_privatebrowsing_about_default_promo.js" \
    "$PRIVATE_TESTS/browser_privatebrowsing_about_nova_promo.js" || status=1
  # In-content pages: patches/toolkit/in-content imports a stylesheet gated
  # by aequera.incontent.enabled, and the shell's jar.mn serves Aequera
  # illustrations at Firefox's illustration URLs. Off, with Firefox's promo
  # defaults, the error pages, Settings, and about:protections must behave
  # exactly as in Firefox (the illustration tests check those URLs).
  # Every More from Mozilla test, found at run time so new upstream files
  # run too, except browser_moreFromMozilla_config.js: it searches Settings
  # for the literal "More from Mozilla", and the branding names the pane
  # "More from Aequera" (-vendor-short-name), on master too. An unmatched
  # glob stays literal, so a moved directory fails the run, never skips it.
  MFM_TESTS=()
  for test in "$PREFS_TESTS"/moreFromMozilla/browser_*.js; do
    case "$test" in
      */browser_moreFromMozilla_config.js) ;;
      *) MFM_TESTS+=("$test") ;;
    esac
  done
  ./mach mochitest --headless "${extra[@]}" "${FIREFOX_DEFAULTS[@]}" \
    --setpref aequera.incontent.enabled=false \
    --setpref browser.preferences.moreFromMozilla=true \
    --setpref browser.vpn_promo.enabled=true \
    --setpref browser.promo.relay.enabled=true \
    --setpref browser.contentblocking.report.show_mobile_app=true \
    --setpref browser.contentblocking.report.hide_vpn_banner=false \
    browser/base/content/test/about/browser_aboutNetError_feltprivacy_illustrations.js \
    "${MFM_TESTS[@]}" \
    "$PREFS_TESTS/browser_defaultbrowser_alwayscheck.js" \
    browser/components/protections/test/browser/browser_protections_vpn.js || status=1
  # Settings: patches/browser/rail-position adds a vertical tabs side choice
  # to Browser layout, offered only for a shell-hosted rail
  # (sidebar.verticalTabs.requireRevamp false); with Firefox's defaults the
  # layout settings must behave exactly as in Firefox.
  ./mach mochitest --headless "${extra[@]}" "${FIREFOX_DEFAULTS[@]}" \
    "$PREFS_TESTS/browser_tabs_browsing_pane.js" \
    "$PREFS_TESTS/browser_appearance_pane.js" || status=1
fi
exit $status
