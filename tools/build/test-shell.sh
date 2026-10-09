#!/bin/bash
# Aequera shell test gate. Run from the build shell inside worktree/firefox
# after `aequera patch apply` and `./mach build`.
#
#   bash tools/build/test-shell.sh [aequera|upstream|all] [--repeat N]
# (run from worktree/firefox; the script path is relative to the checkout root)
#
# aequera:  Aequera-owned tests (browser/aequera/tests), Aequera defaults.
# upstream: Firefox's own sidebar, tab, and bookmarks-toolbar tests with
#           Firefox's defaults restored, to prove the patches change nothing
#           by default.
set -u
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
)
# Frame material is per-OS (Windows 11 Mica; opaque toolbar fallback
# elsewhere): only reset it where the pref means something.
case "$(uname -s)" in
MINGW*|MSYS*|CYGWIN*)
  FIREFOX_DEFAULTS+=(--setpref widget.windows.mica=false)
  ;;
esac
SIDEBAR_TESTS=browser/components/sidebar/tests/browser
TAB_TESTS=browser/components/tabbrowser/test/browser/tabs
PLACES_TESTS=browser/components/places/tests/browser
status=0

# Artifact builds do not refresh the test index on their own; new or moved
# Aequera test manifests are invisible to mach until this runs.
./mach build-backend -b TestManifest > /dev/null || status=1

if [ "$step" = aequera ] || [ "$step" = all ]; then
  ./mach mochitest --headless "${extra[@]}" browser/aequera/tests/browser || status=1
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
fi
exit $status
