#!/bin/bash
# Run the Aequera build under its own application identity, never Firefox's.
# Dev loop: run from a POSIX shell with worktree/firefox as the working
# directory, after ./mach build. Any checkout path works (paths resolve from
# this script's location, never from a hardcoded prefix):
#
#   bash tools/build/aequera-run.sh                 # dev: throwaway profile via mach run
#   bash tools/build/aequera-run.sh --persistent    # real profile (Linux ~/.aequera,
#                                                   # macOS ~/Library/.../Aequera,
#                                                   # Windows %APPDATA%\Aequera)
#
# Outside a build shell (file manager, taskbar, dock), start the real profile
# with tools/build/aequera.cmd (Windows) or tools/build/aequera.sh
# (Linux/macOS): persistent without needing mach.
#
# Both pass -app (Aequera identity: remoting "aequera", its own profile roots
# per configs/defaults/branding.toml) and -no-remote, so neither instance
# ever hands off to or talks to a running Firefox, and Firefox's profiles.ini
# is never touched.
# -purgecaches drops the startup cache, which otherwise keeps serving Firefox
# chrome (browser.xhtml, patched scripts) from before a `mach build faster`;
# Aequera's own scripts bypass it anyway (aequera/shell/README.md).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# From inside worktree/firefox. Prefers the compiled build when present;
# probes native names on every OS (.exe under Windows shells, bare names on
# Linux, .app bundle binaries on macOS).
if [ -z "${MOZ_OBJDIR:-}" ]; then
  if [ -x obj-aequera/dist/bin/aequera ] \
    || [ -x obj-aequera/dist/bin/aequera.exe ] \
    || [ -x obj-aequera/dist/Aequera.app/Contents/MacOS/aequera ]; then
    objdir=obj-aequera
  else
    objdir=obj-aequera-artifact
  fi
else
  objdir=$MOZ_OBJDIR
fi
bin="$objdir/dist/bin"
exe="$bin/aequera"
[ -x "$exe" ] || exe="$bin/aequera.exe"
[ -x "$exe" ] || exe="$bin/firefox"
[ -x "$exe" ] || exe="$bin/firefox.exe"
[ -x "$exe" ] || exe="$objdir/dist/Aequera.app/Contents/MacOS/aequera"
[ -x "$exe" ] || exe="$objdir/dist/Firefox.app/Contents/MacOS/firefox"
if [ ! -x "$exe" ]; then
  echo "aequera-run: no build in \"$objdir\"; run ./mach build first (see tools/build/README.md)." 1>&2
  exit 1
fi
ini="$bin/browser/aequera-application.ini"
mkdir -p "$(dirname "$ini")"

# Like `mach run` (python/mozbuild/mozbuild/mach_commands.py), advertise the
# developer dirs: local builds symlink front-end files into dist. On Windows
# the content-process sandbox only resolves those links when
# MOZ_DEVELOPER_REPO_DIR is set (upstream bug 1916286: without it DevTools
# cannot open and Ctrl+Shift+I / F12 fail with "builtin-modules.js is not
# found"); elsewhere the native paths are correct as-is. `mach run` sets
# these itself, so this is a no-op for that branch and the fix for
# direct-exe launches. cygpath exists only under Windows POSIX shells
# (MozillaBuild, Git Bash): use the Windows form there, native elsewhere.
TOPSRCDIR="$(cd "$SCRIPT_DIR/../../worktree/firefox" && pwd)"
case "$objdir" in
/*|[A-Za-z]:*) ABSOBJDIR="$objdir" ;;
*) ABSOBJDIR="$TOPSRCDIR/$objdir" ;;
esac
if command -v cygpath >/dev/null 2>&1; then
  export MOZ_DEVELOPER_REPO_DIR="$(cygpath -w "$TOPSRCDIR")"
  export MOZ_DEVELOPER_OBJ_DIR="$(cygpath -w "$ABSOBJDIR")"
else
  export MOZ_DEVELOPER_REPO_DIR="$TOPSRCDIR"
  export MOZ_DEVELOPER_OBJ_DIR="$ABSOBJDIR"
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON=python
else
  PYTHON=""
fi
if [ -z "$PYTHON" ]; then
  if [ ! -f "$ini" ]; then
    echo "aequera-run: cannot write \"$ini\" without python3; build once on a machine with python." 1>&2
    exit 1
  fi
  echo "aequera-run: python3 not found, starting with the existing \"$ini\"." 1>&2
else
  "$PYTHON" "$SCRIPT_DIR/aequera_app_ini.py" "$bin/application.ini" "$ini"
fi
if command -v cygpath >/dev/null 2>&1; then
  ini_arg=$(cygpath -w "$ini")
else
  ini_arg="$ini"
fi

if [ "${1:-}" = "--persistent" ]; then
  shift
  exec "$exe" -app "$ini_arg" -no-remote -purgecaches "$@"
fi
exec ./mach run -- -app "$ini_arg" -no-remote -purgecaches "$@"
