#!/bin/bash
# Run the Aequera build under its own application identity, never Firefox's.
# Portable across Linux, macOS, and Windows (MozillaBuild or git-bash):
# all paths derive from this script's location, so any checkout directory
# works. Never start a bare exe: the artifact binary would open your Firefox
# profile, join a running Firefox, and serve shell code from the startup cache.
#
#   bash tools/build/aequera-run.sh                 # throwaway dev profile
#   bash tools/build/aequera-run.sh --persistent    # real Aequera profile
#
# Both pass -app (Aequera identity: remoting "aequera", its own profile root)
# and -no-remote, so neither instance hands off to a running Firefox, and
# Firefox's profiles.ini is never touched. -purgecaches drops the startup
# cache, which otherwise keeps serving pre-rebuild chrome; it is passed only
# when the build changed since the last launch (startup-cache.sh).
#
# MOZCONFIG: exported as usual for mach (see tools/build/README.md). When
# unset, the mozconfig matching the selected objdir is used and reported;
# AEQUERA_BUILD=compiled|artifact overrides that guess for custom objdirs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAUNCHER=aequera-run
. "$SCRIPT_DIR/launch-common.sh"
# AEQUERA_WORKTREE=candidate runs the rebased candidate (aequera patch rebase).
aequera_worktree
TOPSRCDIR="$FIREFOX_DIR"
if [ ! -d "$TOPSRCDIR" ]; then
  echo "aequera-run: no Firefox tree at $TOPSRCDIR; run \`aequera patch apply\` first." >&2
  exit 1
fi
aequera_objdir MOZ_OBJDIR "${MOZ_OBJDIR:-}"
aequera_find_exe
BIN="$OBJDIR/dist/bin"
aequera_export_dev_dirs

# Bundle binaries stage dist/bin into the .app, so the source ini may live
# in either place; the launch ini goes next to the binary that uses it.
# Unverified against a real Mac bundle layout (see tools/build/README.md).
SRC_INI="$BIN/application.ini"
case "$EXE" in
  *.app/Contents/MacOS/*)
    APP_CONTENTS="$(dirname "$(dirname "$EXE")")"
    BUNDLE_RESOURCES="$APP_CONTENTS/Resources"
    INI="$BUNDLE_RESOURCES/browser/aequera-application.ini"
    [ -f "$SRC_INI" ] || SRC_INI="$BUNDLE_RESOURCES/application.ini"
    ;;
  *)
    INI="$BIN/browser/aequera-application.ini"
    ;;
esac
aequera_write_ini "$SRC_INI" "$INI"
INI_NATIVE="$(aequera_to_native "$INI")"

# Tor windows run the tor bundled into the build (tools/tor/fetch-bundle.sh);
# without it they use tor from PATH or aequera.tor.executable.
if [ ! -f "$BIN/tor/aequera-tor-bundle.json" ]; then
  echo "aequera-run: no bundled tor in $BIN/tor; for Tor windows: bash tools/tor/fetch-bundle.sh" >&2
fi

# Startup cache: purged only when the build changed since the last launch of
# the same kind (startup-cache.sh). The persistent stamp is shared with
# aequera.sh, which starts the same profile.
. "$SCRIPT_DIR/startup-cache.sh"
SCAN=("$BIN")
[ -n "${BUNDLE_RESOURCES:-}" ] && SCAN+=("$BUNDLE_RESOURCES")

if [ "${1:-}" = "--persistent" ]; then
  shift
  aequera_launch_purge "$OBJDIR/.aequera-launch-persistent" "${SCAN[@]}" -- "$@"
  exec "$EXE" -app "$INI_NATIVE" -no-remote ${PURGE[@]+"${PURGE[@]}"} "$@"
fi

cd "$TOPSRCDIR"
if [ -z "${MOZCONFIG:-}" ]; then
  case "${AEQUERA_BUILD:-}" in
    compiled) MOZCONFIG="$ROOT/tools/build/mozconfig.compiled" ;;
    artifact) MOZCONFIG="$ROOT/tools/build/mozconfig.artifact" ;;
    "") case "$(basename "$OBJDIR")" in
      compiled) MOZCONFIG="$ROOT/tools/build/mozconfig.compiled" ;;
      *) MOZCONFIG="$ROOT/tools/build/mozconfig.artifact" ;;
    esac ;;
    *) echo "aequera-run: unknown AEQUERA_BUILD=$AEQUERA_BUILD, want compiled|artifact" >&2
      exit 1 ;;
  esac
  export MOZCONFIG
  echo "aequera-run: MOZCONFIG unset, using $MOZCONFIG" >&2
fi
aequera_launch_purge "$OBJDIR/.aequera-launch-dev" "${SCAN[@]}" -- "$@"
exec ./mach run -- -app "$INI_NATIVE" -no-remote ${PURGE[@]+"${PURGE[@]}"} "$@"
