#!/bin/bash
# Aequera shell test gate. Run from the MozillaBuild shell inside
# worktree/firefox after `aequera patch apply` and `./mach build`.
#
#   bash /c/src/aequera/tools/build/test-shell.sh [aequera|upstream|all] [--repeat N]
#
# aequera:  Aequera-owned tests (browser/aequera/tests), Aequera defaults.
# upstream: Firefox's own sidebar and tab tests with Firefox's defaults
#           restored, to prove the patches change nothing by default.
set -u
step=${1:-all}
shift || true
extra=("$@")

# Firefox release defaults for every pref aequera-prefs.js overrides.
FIREFOX_DEFAULTS=(
  --setpref sidebar.revamp=false
  --setpref sidebar.verticalTabs=false
  --setpref sidebar.visibility=always-show
  --setpref sidebar.animation.expand-on-hover.duration-ms=400
  --setpref sidebar.animation.expand-on-hover.delay-duration-ms=200
  --setpref sidebar.animation.expand-on-hover.collapse-delay-ms=0
  --setpref sidebar.animation.expand-on-hover.easing=ease-in-out
  --setpref widget.windows.mica=false
  --setpref browser.tabs.parkedHiddenSources=
)
SIDEBAR_TESTS=browser/components/sidebar/tests/browser
TAB_TESTS=browser/components/tabbrowser/test/browser/tabs
status=0

# Artifact builds do not refresh the test index on their own; new or moved
# Aequera test manifests are invisible to mach until this runs.
./mach build-backend -b TestManifest > /dev/null || status=1

if [ "$step" = aequera ] || [ "$step" = all ]; then
  ./mach mochitest --headless "${extra[@]}" browser/aequera/tests/browser || status=1
fi
if [ "$step" = upstream ] || [ "$step" = all ]; then
  ./mach mochitest --headless "${extra[@]}" "${FIREFOX_DEFAULTS[@]}" \
    "$SIDEBAR_TESTS/browser_sidebar_animation.js" \
    "$SIDEBAR_TESTS/browser_launcher_splitter_expand_on_hover.js" || status=1
  # Tab closing / hidden tabs: patches/browser/workspace-hooks touches
  # Tabbrowser's last-tab path.
  ./mach mochitest --headless "${extra[@]}" "${FIREFOX_DEFAULTS[@]}" \
    "$TAB_TESTS/browser_closeWindowWithLastTab_contentClose.js" \
    "$TAB_TESTS/browser_hiddentab_contextmenu.js" \
    "$TAB_TESTS/browser_pinned_and_hidden_tabs.js" \
    "$TAB_TESTS/browser_multiselect_tabs_close.js" \
    "$TAB_TESTS/browser_list_all_tabs_menu_items.js" || status=1
  # This file turns vertical tabs on itself; orientation switches read the
  # DEFAULT branch (Aequera: expand-on-hover), which --setpref (user branch)
  # cannot reset, so only visibility and the new collapse delay are reset.
  ./mach mochitest --headless "${extra[@]}" \
    --setpref sidebar.visibility=always-show \
    --setpref sidebar.animation.expand-on-hover.collapse-delay-ms=0 \
    "$SIDEBAR_TESTS/browser_sidebar_expand_on_hover.js" || status=1
fi
exit $status
