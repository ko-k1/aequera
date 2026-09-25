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
objdir=${MOZ_OBJDIR:-obj-aequera-artifact}
bin="$objdir/dist/bin"
ini="$bin/browser/aequera-application.ini"

python3 /c/src/aequera/tools/build/aequera_app_ini.py "$bin/application.ini" "$ini"
ini_win=$(cygpath -w "$ini")

if [ "${1:-}" = "--persistent" ]; then
  shift
  exec "$bin/firefox.exe" -app "$ini_win" -no-remote -purgecaches "$@"
fi
exec ./mach run -- -app "$ini_win" -no-remote -purgecaches "$@"
