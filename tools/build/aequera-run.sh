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
# cache, which otherwise keeps serving pre-rebuild chrome.
#
# MOZCONFIG: exported as usual for mach (see tools/build/README.md). When
# unset, the mozconfig matching the selected objdir is used and reported;
# AEQUERA_BUILD=compiled|artifact overrides that guess for custom objdirs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TOPSRCDIR="$ROOT/worktree/firefox"
if [ ! -d "$TOPSRCDIR" ]; then
  echo "aequera-run: no Firefox tree at $TOPSRCDIR; run \`aequera patch apply\` first." >&2
  exit 1
fi

EXE_SUFFIX=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXE_SUFFIX=".exe" ;;
esac

if [ -z "${MOZ_OBJDIR:-}" ]; then
  # Same layout as the mozconfigs: obj/<worktree>/{compiled,artifact}.
  OBJ_ROOT="$ROOT/obj/$(basename "$TOPSRCDIR")"
  if [ -x "$OBJ_ROOT/compiled/dist/bin/aequera$EXE_SUFFIX" ]; then
    OBJDIR="$OBJ_ROOT/compiled"
  else
    OBJDIR="$OBJ_ROOT/artifact"
  fi
else
  case "$MOZ_OBJDIR" in
    /*|[A-Za-z]:[\\/]*) OBJDIR="$MOZ_OBJDIR" ;;
    *) # Relative: canonicalize (portable: GNU realpath -m, else python3)
       # and require containment under the repo root.
       _canonical() {
         if command -v realpath >/dev/null 2>&1 && realpath -m / >/dev/null 2>&1; then
           realpath -m "$1"
         elif command -v python3 >/dev/null 2>&1; then
           python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
         else
           printf '%s\n' "$1"
         fi
       }
       OBJDIR="$(_canonical "$TOPSRCDIR/$MOZ_OBJDIR")"
       _TOP_CANON="$(_canonical "$ROOT")"
       case "$OBJDIR" in
         "$_TOP_CANON"/*) ;;
         *) echo "aequera-run: MOZ_OBJDIR escapes repo root ($OBJDIR); refusing." >&2; exit 1 ;;
       esac ;;
  esac
fi

BIN="$OBJDIR/dist/bin"
EXE="$BIN/aequera$EXE_SUFFIX"
[ -x "$EXE" ] || EXE="$BIN/firefox$EXE_SUFFIX"
if [ ! -x "$EXE" ]; then
  shopt -s nullglob
  candidates=("$OBJDIR"/dist/*.app/Contents/MacOS/*)
  shopt -u nullglob
  APP_BIN=""
  # Quoted expansion preserves spaces; length guard keeps `set -u`
  # safe on older bash with an empty array.
  if [ "${#candidates[@]}" -gt 0 ]; then
    for c in "${candidates[@]}"; do
      case "$c" in
        *Aequera.app/Contents/MacOS/*) APP_BIN="$c"; break ;;
      esac
    done
  fi
  [ -n "$APP_BIN" ] || APP_BIN="${candidates[0]:-}"
  if [ -n "$APP_BIN" ] && [ -x "$APP_BIN" ]; then
    EXE="$APP_BIN"
  fi
fi
[ -x "$EXE" ] || {
  echo "aequera-run: no build in $BIN; see tools/build/README.md." >&2
  exit 1
}

# Native Windows binaries need Windows-style paths when launched from a
# POSIX shell; everywhere else absolute POSIX paths are correct as-is.
to_native() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}

# Like `mach run`, advertise the developer dirs: local builds symlink
# front-end files into dist, and the content-process sandbox only resolves
# those links when the repo dir is advertised (upstream bug 1916286).
export MOZ_DEVELOPER_REPO_DIR="$(to_native "$TOPSRCDIR")"
export MOZ_DEVELOPER_OBJ_DIR="$(to_native "$OBJDIR")"

if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON=python
else
  PYTHON=""
fi
# Bundle binaries stage dist/bin into the .app, so the source ini may live
# in either place; the launch ini goes next to the binary that uses it.
# Unverified against a real Mac bundle layout (see tools/build/README.md).
SRC_INI="$BIN/application.ini"
case "$EXE" in
  *.app/Contents/MacOS/*)
    APP_CONTENTS="$(dirname "$(dirname "$EXE")")"
    BUNDLE_RESOURCES="$APP_CONTENTS/Resources"
    INI="$BUNDLE_RESOURCES/browser/aequera-application.ini"
    mkdir -p "$(dirname "$INI")"
    [ -f "$SRC_INI" ] || SRC_INI="$BUNDLE_RESOURCES/application.ini"
    ;;
  *)
    INI="$BIN/browser/aequera-application.ini"
    mkdir -p "$(dirname "$INI")"
    ;;
esac
if [ -z "$PYTHON" ]; then
  # Fail closed: never launch with a possibly stale (Firefox) identity.
  echo "aequera-run: cannot verify \"$INI\" without python3; refusing to launch." >&2
  exit 1
else
  "$PYTHON" "$ROOT/tools/build/aequera_app_ini.py" "$SRC_INI" "$INI"
fi
INI_NATIVE="$(to_native "$INI")"

if [ "${1:-}" = "--persistent" ]; then
  shift
  exec "$EXE" -app "$INI_NATIVE" -no-remote -purgecaches "$@"
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
exec ./mach run -- -app "$INI_NATIVE" -no-remote -purgecaches "$@"
