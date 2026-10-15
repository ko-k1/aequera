# Shared by the POSIX launchers (aequera.sh, aequera-run.sh): which tree,
# which build, which binary, and the identity it starts with. Source it with
# LAUNCHER (the name in messages) and ROOT (the checkout root) set; every
# function exits the launcher on failure.

# FIREFOX_DIR from AEQUERA_WORKTREE (default firefox; candidate is the
# rebased candidate): one plain directory name under worktree/.
aequera_worktree() {
  WORKTREE_NAME="${AEQUERA_WORKTREE:-firefox}"
  case "$WORKTREE_NAME" in
    ""|.|..|*[!A-Za-z0-9._-]*)
      echo "$LAUNCHER: AEQUERA_WORKTREE must name a directory under worktree/ (got '$WORKTREE_NAME')" >&2
      exit 1 ;;
  esac
  FIREFOX_DIR="$ROOT/worktree/$WORKTREE_NAME"
}

# Portable canonicalizer: GNU realpath -m where it works, else python3
# (macOS BSD readlink has no -m).
aequera_canonical() {
  if command -v realpath >/dev/null 2>&1 && realpath -m / >/dev/null 2>&1; then
    realpath -m "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
  else
    printf '%s\n' "$1"
  fi
}

# aequera_objdir <override name> <override value>: OBJDIR. An override is
# explicit intent when absolute (POSIX or a Windows drive, for Git Bash);
# relative ones resolve against the worktree and must stay inside the
# checkout. Without one: obj/<worktree>/compiled when it holds a native
# Aequera binary, else obj/<worktree>/artifact (the mozconfigs' objdirs).
aequera_objdir() {
  local name="$1" value="$2"
  if [ -n "$value" ]; then
    case "$value" in
      /*|[A-Za-z]:[\\/]*) OBJDIR="$(aequera_canonical "$value")" ;;
      *)
        OBJDIR="$(aequera_canonical "$FIREFOX_DIR/$value")"
        case "$OBJDIR" in
          "$(aequera_canonical "$ROOT")"/*) ;;
          *) echo "$LAUNCHER: $name escapes repo root ($OBJDIR); refusing." >&2
             exit 1 ;;
        esac ;;
    esac
    return
  fi
  local base="$ROOT/obj/$WORKTREE_NAME"
  OBJDIR="$base/artifact"
  if [ -x "$base/compiled/dist/bin/aequera" ] \
    || [ -x "$base/compiled/dist/bin/aequera.exe" ] \
    || [ -x "$base/compiled/dist/Aequera.app/Contents/MacOS/aequera" ]; then
    OBJDIR="$base/compiled"
  fi
}

# EXE: the browser binary in OBJDIR. Compiled identity first, then the
# prebuilt artifact; native names before bundle layouts, then any macOS
# bundle (Aequera.app first). Windows Git Bash matches the .exe entries.
aequera_find_exe() {
  local c
  for c in \
    "$OBJDIR/dist/bin/aequera" \
    "$OBJDIR/dist/bin/aequera.exe" \
    "$OBJDIR/dist/Aequera.app/Contents/MacOS/aequera" \
    "$OBJDIR/dist/bin/firefox" \
    "$OBJDIR/dist/bin/firefox.exe" \
    "$OBJDIR/dist/Firefox.app/Contents/MacOS/firefox" \
    "$OBJDIR"/dist/Aequera.app/Contents/MacOS/* \
    "$OBJDIR"/dist/*.app/Contents/MacOS/*; do
    if [ -f "$c" ] && [ -x "$c" ]; then
      EXE="$c"
      return
    fi
  done
  echo "$LAUNCHER: no build in \"$OBJDIR\"; see tools/build/README.md." >&2
  exit 1
}

# Native Windows binaries need Windows-style paths when launched from a POSIX
# shell (Git Bash, MozillaBuild); everywhere else the path is used as-is.
aequera_to_native() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}

# aequera_write_ini <build ini> <launch ini>: the launch ini, verified to
# carry the Aequera identity (aequera_app_ini.py), rewritten every start so
# it never drifts from a rebuild. Fails closed without Python: a stale ini
# could carry Firefox's identity.
aequera_write_ini() {
  local python
  python="$(aequera_python)" || {
    echo "$LAUNCHER: cannot verify \"$2\" without python3; refusing to launch with a possibly stale identity." >&2
    exit 1
  }
  mkdir -p "$(dirname "$2")"
  "$python" "$ROOT/tools/build/aequera_app_ini.py" "$1" "$2"
}

# Prints python3, else python; fails when neither exists.
aequera_python() {
  if command -v python3 >/dev/null 2>&1; then
    echo python3
  elif command -v python >/dev/null 2>&1; then
    echo python
  else
    return 1
  fi
}

# aequera_dist_copies <dist/bin>: on Windows, the build's symlinks become
# copies (dist_copies.py: Gecko refuses symlinked built-in add-on files and
# objdir files in content processes there). mach relinks on every build, so
# this runs every start; without links it is one scan.
aequera_dist_copies() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *) return 0 ;;
  esac
  local python
  python="$(aequera_python)" || {
    echo "$LAUNCHER: python3 is needed to replace the build's symlinks in \"$1\"." >&2
    exit 1
  }
  "$python" "$ROOT/tools/build/dist_copies.py" "$1" || exit 1
}

# Like `mach run`, advertise the developer dirs: local builds symlink
# front-end files into dist, and the Windows content-process sandbox only
# resolves those links when the repo dir is set (upstream bug 1916286).
# Without it DevTools cannot open.
aequera_export_dev_dirs() {
  MOZ_DEVELOPER_REPO_DIR="$(aequera_to_native "$FIREFOX_DIR")"
  MOZ_DEVELOPER_OBJ_DIR="$(aequera_to_native "$OBJDIR")"
  export MOZ_DEVELOPER_REPO_DIR MOZ_DEVELOPER_OBJ_DIR
}
