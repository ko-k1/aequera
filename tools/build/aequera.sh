#!/usr/bin/env bash
# Start the Aequera build: double-click is Windows-only; here run from any
# POSIX shell (Terminal, GNOME Console, macOS/Linux CI).
#
# POSIX counterpart of tools/build/aequera.cmd. Prefers the compiled build
# (native `aequera` binary with the Aequera icon embedded), falls back to the
# artifact build (Mozilla's prebuilt `firefox` binary). Always use this (or
# tools/build/aequera-run.sh for the `mach run` dev loop), never a bare
# binary: started bare, the artifact binary opens your Firefox profile, joins
# a running Firefox, and serves shell code from that profile's startup cache.
# This passes the Aequera identity (-app aequera-application.ini: its own
# profile roots — ~/.aequera on Linux, ~/Library/Application Support/Aequera
# on macOS — and its own single-instance channel), -no-remote, and
# -purgecaches.
#
# Usage: tools/build/aequera.sh [Firefox arguments...]
#   AEQUERA_OBJDIR overrides the build directory (absolute, or relative to
#   worktree/firefox). Default: worktree/firefox/obj-aequera when it holds a
#   native Aequera binary, else worktree/firefox/obj-aequera-artifact.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIREFOX_DIR="$REPO_ROOT/worktree/firefox"

# Resolve the object directory: explicit override wins, else prefer the
# compiled tree when it already holds a native binary.
if [ -n "${AEQUERA_OBJDIR:-}" ]; then
  case "$AEQUERA_OBJDIR" in
    /*) OBJDIR="$AEQUERA_OBJDIR" ;;
    *) OBJDIR="$FIREFOX_DIR/$AEQUERA_OBJDIR" ;;
  esac
else
  OBJDIR="$FIREFOX_DIR/obj-aequera-artifact"
  if [ -x "$FIREFOX_DIR/obj-aequera/dist/bin/aequera" ] \
    || [ -x "$FIREFOX_DIR/obj-aequera/dist/bin/aequera.exe" ] \
    || [ -x "$FIREFOX_DIR/obj-aequera/dist/Aequera.app/Contents/MacOS/aequera" ]; then
    OBJDIR="$FIREFOX_DIR/obj-aequera"
  fi
fi

# Locate the browser binary. Order: compiled identity first, then the
# prebuilt artifact; inside each, native name before bundle layout.
# (Windows Git Bash also matches the .exe entries when this script runs there.)
EXE=""
for candidate in \
  "$OBJDIR/dist/bin/aequera" \
  "$OBJDIR/dist/bin/aequera.exe" \
  "$OBJDIR/dist/Aequera.app/Contents/MacOS/aequera" \
  "$OBJDIR/dist/bin/firefox" \
  "$OBJDIR/dist/bin/firefox.exe" \
  "$OBJDIR/dist/Firefox.app/Contents/MacOS/firefox" \
  ; do
  if [ -x "$candidate" ]; then
    EXE="$candidate"
    break
  fi
done

if [ -z "$EXE" ]; then
  echo "aequera: no build in \"$OBJDIR\"; see tools/build/README.md." 1>&2
  exit 1
fi

# The build's own application.ini carries the Aequera identity; copy it next
# to the binary as browser/aequera-application.ini (verified there on every
# start, as aequera.cmd does, so it never drifts from a rebuild). Inside a
# macOS bundle the source lives under Contents/Resources instead.
EXE_DIR="$(dirname "$EXE")"
SRC_INI="$EXE_DIR/application.ini"
case "$EXE" in
  *.app/*)
    APP_ROOT="$(cd "$EXE_DIR/../.." && pwd)"
    if [ ! -f "$SRC_INI" ] && [ -f "$APP_ROOT/Contents/Resources/application.ini" ]; then
      SRC_INI="$APP_ROOT/Contents/Resources/application.ini"
    fi
    ;;
esac
INI="$EXE_DIR/browser/aequera-application.ini"
mkdir -p "$(dirname "$INI")"

if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON=python
else
  PYTHON=""
fi
if [ -z "$PYTHON" ]; then
  if [ ! -f "$INI" ]; then
    echo "aequera: cannot write \"$INI\" without python3; run tools/build/aequera-run.sh once." 1>&2
    exit 1
  fi
  echo "aequera: python3 not found, starting with the existing \"$INI\"." 1>&2
else
  "$PYTHON" "$SCRIPT_DIR/aequera_app_ini.py" "$SRC_INI" "$INI"
fi

# Like `mach run`, advertise the developer dirs: local builds symlink
# front-end files into dist. On Windows the content-process sandbox only
# resolves those links when MOZ_DEVELOPER_REPO_DIR is set (upstream bug
# 1916286); elsewhere the native paths are correct as-is. When this script
# runs under Windows Git/MozillaBuild bash, cygpath converts to the Windows
# form the native .exe needs for -app and the sandbox vars.
if command -v cygpath >/dev/null 2>&1; then
  export MOZ_DEVELOPER_REPO_DIR="$(cygpath -w "$FIREFOX_DIR")"
  export MOZ_DEVELOPER_OBJ_DIR="$(cygpath -w "$OBJDIR")"
  INI_ARG="$(cygpath -w "$INI")"
else
  export MOZ_DEVELOPER_REPO_DIR="$FIREFOX_DIR"
  export MOZ_DEVELOPER_OBJ_DIR="$OBJDIR"
  INI_ARG="$INI"
fi

exec "$EXE" -app "$INI_ARG" -no-remote -purgecaches "$@"
