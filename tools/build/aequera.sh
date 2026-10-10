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
#   worktree/firefox). Default: obj/firefox/compiled when it holds a native
#   Aequera binary, else obj/firefox/artifact (the mozconfigs' objdirs).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# AEQUERA_WORKTREE=candidate starts the rebased candidate's build.
WORKTREE_NAME="${AEQUERA_WORKTREE:-firefox}"
case "$WORKTREE_NAME" in
  ""|.|..|*[!A-Za-z0-9._-]*)
    echo "aequera: AEQUERA_WORKTREE must name a directory under worktree/ (got '$WORKTREE_NAME')" 1>&2
    exit 1 ;;
esac
FIREFOX_DIR="$REPO_ROOT/worktree/$WORKTREE_NAME"

# Resolve the object directory: explicit override wins, else prefer the
# compiled tree when it already holds a native binary.
# Absolute means POSIX (`/*`) or Windows drive (`C:/...`, for Git Bash).
if [ -n "${AEQUERA_OBJDIR:-}" ]; then
  case "$AEQUERA_OBJDIR" in
    /*|[A-Za-z]:[\\/]*) OBJDIR="$AEQUERA_OBJDIR" ;;
    *) OBJDIR="$FIREFOX_DIR/$AEQUERA_OBJDIR" ;;
  esac
else
  OBJ_ROOT="$REPO_ROOT/obj/$WORKTREE_NAME"
  OBJDIR="$OBJ_ROOT/artifact"
  if [ -x "$OBJ_ROOT/compiled/dist/bin/aequera" ] \
    || [ -x "$OBJ_ROOT/compiled/dist/bin/aequera.exe" ] \
    || [ -x "$OBJ_ROOT/compiled/dist/Aequera.app/Contents/MacOS/aequera" ]; then
    OBJDIR="$OBJ_ROOT/compiled"
  fi
fi

# Containment: a relative override with `..` must not escape the repo.
# Absolute overrides are explicit user intent (allowed); relative ones are
# canonicalized and required to stay under REPO_ROOT.
# Portable canonicalizer: GNU realpath -m where it works, else python3
# (macOS BSD readlink has no -m, so it is not used here).
_canonical() {
  if command -v realpath >/dev/null 2>&1 && realpath -m / >/dev/null 2>&1; then
    realpath -m "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
  else
    printf '%s\n' "$1"
  fi
}
if [ -n "${AEQUERA_OBJDIR:-}" ]; then
  case "$AEQUERA_OBJDIR" in
    /*|[A-Za-z]:[\\/]*) OBJDIR="$(_canonical "$OBJDIR")" ;;
    *) _OBJDIR_CANON="$(_canonical "$OBJDIR")"
       _REPO_CANON="$(_canonical "$REPO_ROOT")"
       case "$_OBJDIR_CANON" in
         "$_REPO_CANON"/*) ;;
         *) echo "aequera: AEQUERA_OBJDIR escapes repo root ($_OBJDIR_CANON); refusing." 1>&2; exit 1 ;;
       esac
       OBJDIR="$_OBJDIR_CANON" ;;
  esac
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
  # Fail closed: a stale INI could carry the wrong (Firefox) identity.
  # Never launch with an unverified INI.
  echo "aequera: cannot verify \"$INI\" without python3; refusing to launch with a possibly stale identity." 1>&2
  exit 1
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
