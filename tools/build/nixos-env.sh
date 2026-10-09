# Shared NixOS setup for the *-nixos.sh wrappers; source it, then call
# nixos_fhs_exec <script> [args...] to run a repo script under steam-run.
#
# Mozilla's prebuilt artifact binaries (firefox, xpcshell) expect an FHS
# system: on NixOS they cannot find GTK/X11, and `mach bootstrap` refuses the
# distro. steam-run provides the FHS environment, with:
#   - LD_LIBRARY_PATH unset: a nix-shell's libraries can need a newer glibc
#     than the FHS one and break loading;
#   - TMPDIR under .tmp/: steam-run cannot see /tmp/nix-shell.* dirs;
#   - XDG_CACHE_HOME under .tmp/: the host ~/.cache/fontconfig crashes the
#     browser at startup (SIGSEGV in FcNameUnparseLangSet);
#   - MINIDUMP_SAVE_PATH under .tmp/: crash dumps survive temp profiles.
# Expects ROOT (repo root) to be set by the caller.

nixos_fhs_exec() {
  if ! command -v steam-run >/dev/null 2>&1; then
    echo "nixos: steam-run not found; enable programs.steam or add pkgs.steam-run" >&2
    exit 2
  fi
  local state="$ROOT/.tmp/nixos"
  mkdir -p "$state/tmp" "$state/cache" "$state/dumps"
  cd "$ROOT/worktree/firefox"
  exec env -u LD_LIBRARY_PATH \
    TMPDIR="$state/tmp" \
    XDG_CACHE_HOME="$state/cache" \
    MINIDUMP_SAVE_PATH="$state/dumps" \
    steam-run bash "$@"
}
