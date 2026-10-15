# Startup cache policy shared by the POSIX launchers (aequera-run.sh,
# aequera.sh); source it, then call
#   aequera_launch_purge <stamp file> <scan dir>... -- <launch args...>
# which sets PURGE to (-purgecaches) or to nothing.
#
# Firefox caches compiled chrome scripts per profile. In a local build that
# chrome is linked from the source tree, and overlay syncs change it without
# a version bump, so a stale cache would serve old code; but purging on every
# launch cost about half a second of startup (tools/benchmark). So purge only
# when a file under the scan dirs changed since the stamp (the last launch of
# the same kind). The scan follows links and compares change times (ctime:
# copies that keep mtimes still count). The launch ini is skipped: launchers
# rewrite it every time and it holds no code. Firefox still purges by itself
# after `mach build` (the .purgecaches sentinel), a crash, or safe mode. An
# explicit profile choice always purges (its state is unknown here); pass
# -purgecaches to force one.
aequera_launch_purge() {
  local stamp="$1"; shift
  local scan=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do
    scan+=("$1"); shift
  done
  [ $# -gt 0 ] && shift
  PURGE=()
  local arg changed=""
  for arg in "$@"; do
    case "$arg" in
      -P|-p|-profile|--profile|-ProfileManager|--ProfileManager) changed=1 ;;
    esac
  done
  if [ -z "$changed" ] && [ -f "$stamp" ]; then
    changed="$(find -L "${scan[@]}" -type f -cnewer "$stamp" \
      ! -name aequera-application.ini -print -quit 2>/dev/null || true)"
  else
    changed=1
  fi
  [ -n "$changed" ] && PURGE=(-purgecaches)
  # Touched before launching: anything that changes from here on is newer.
  touch "$stamp" 2>/dev/null || PURGE=(-purgecaches)
}
