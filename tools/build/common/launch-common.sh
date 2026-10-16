# Shared by the POSIX launchers (aequera.sh, aequera-run.sh): which tree,
# which build, which binary, and the identity it starts with. Source it with
# LAUNCHER (the name in messages) and ROOT (the checkout root) set; every
# function exits the launcher on failure. What differs per OS comes from the
# host's platform hooks (host.sh, tools/build/<os>/platform.sh).

. "$ROOT/tools/build/common/host.sh"
aequera_load_platform

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
# Aequera binary for this host, else obj/<worktree>/artifact (the
# mozconfigs' objdirs).
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
  local base="$ROOT/obj/$WORKTREE_NAME" exe
  OBJDIR="$base/artifact"
  while IFS= read -r exe; do
    if [ -f "$exe" ] && [ -x "$exe" ]; then
      OBJDIR="$base/compiled"
      return
    fi
  done < <(aequera_platform_native_exes "$base/compiled")
}

# EXE: the browser binary in OBJDIR. Compiled identity first, then the
# prebuilt artifact, each in the host's preferred order.
aequera_find_exe() {
  local c
  while IFS= read -r c; do
    if [ -f "$c" ] && [ -x "$c" ]; then
      EXE="$c"
      return
    fi
  done < <(aequera_platform_native_exes "$OBJDIR"; aequera_platform_artifact_exes "$OBJDIR")
  echo "$LAUNCHER: no build in \"$OBJDIR\"; see tools/build/$AEQUERA_HOST/README.md." >&2
  exit 1
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
  "$python" "$ROOT/tools/build/common/aequera_app_ini.py" "$1" "$2"
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
