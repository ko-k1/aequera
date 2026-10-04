#!/bin/bash
# Run the Aequera build under its own application identity, never Firefox's.
# From the MozillaBuild shell inside worktree/firefox, after ./mach build:
#
#   bash /c/src/aequera/tools/build/aequera-run.sh            # dev: throwaway profile
#   bash /c/src/aequera/tools/build/aequera-run.sh --persistent  # real profile in %APPDATA%\Aequera
#
# Both pass -app (Aequera identity: remoting "aequera", profiles under
# %APPDATA%\Aequera) and -no-remote, so neither instance ever hands off to or
# talks to a running Firefox, and Firefox's profiles.ini is never touched.
# -purgecaches drops the startup cache, which otherwise keeps serving Firefox
# chrome (browser.xhtml, patched scripts) from before a `mach build faster`;
# Aequera's own scripts bypass it anyway (aequera/shell/README.md).
set -euo pipefail
# From inside worktree/firefox. Prefers the compiled build when present.
if [ -z "${MOZ_OBJDIR:-}" ]; then
  if [ -x obj-aequera/dist/bin/aequera.exe ]; then
    objdir=obj-aequera
  else
    objdir=obj-aequera-artifact
  fi
else
  objdir=$MOZ_OBJDIR
fi
bin="$objdir/dist/bin"
exe="$bin/aequera.exe"
[ -x "$exe" ] || exe="$bin/firefox.exe"
ini="$bin/browser/aequera-application.ini"

# Like `mach run` (python/mozbuild/mozbuild/mach_commands.py), advertise the
# developer dirs: local builds symlink front-end files into dist, and the
# Windows content-process sandbox only resolves those links when
# MOZ_DEVELOPER_REPO_DIR is set (upstream bug 1916286: without it DevTools
# cannot open and Ctrl+Shift+I / F12 fail with "builtin-modules.js is not
# found"). `mach run` sets these itself, so this is a no-op for that branch
# and the fix for direct-exe launches.
TOPSRCDIR="$(cd "$(dirname "$0")/../../worktree/firefox" && pwd)"
case "$objdir" in
/*|[A-Za-z]:*) ABSOBJDIR="$objdir" ;;
*) ABSOBJDIR="$TOPSRCDIR/$objdir" ;;
esac
export MOZ_DEVELOPER_REPO_DIR="$(cygpath -w "$TOPSRCDIR")"
export MOZ_DEVELOPER_OBJ_DIR="$(cygpath -w "$ABSOBJDIR")"

python3 /c/src/aequera/tools/build/aequera_app_ini.py "$bin/application.ini" "$ini"
ini_win=$(cygpath -w "$ini")

if [ "${1:-}" = "--persistent" ]; then
  shift
  exec "$exe" -app "$ini_win" -no-remote -purgecaches "$@"
fi
exec ./mach run -- -app "$ini_win" -no-remote -purgecaches "$@"
