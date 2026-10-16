# macOS hooks for the POSIX build tooling; sourced by
# tools/build/common/host.sh, which documents the contract.
#
# The bundle layout below is unverified against a real Mac build (see
# tools/build/macos/README.md): the lists keep every location a build may
# use, native dist/bin names before bundles.

aequera_platform_native_exes() {
  printf '%s\n' \
    "$1/dist/bin/aequera" \
    "$1/dist/Aequera.app/Contents/MacOS/aequera"
}

# Prebuilt binary first, then any bundle (Aequera.app first); unmatched
# globs stay literal and are skipped by the caller's existence check.
aequera_platform_artifact_exes() {
  local c
  printf '%s\n' \
    "$1/dist/bin/firefox" \
    "$1/dist/Firefox.app/Contents/MacOS/firefox"
  for c in "$1"/dist/Aequera.app/Contents/MacOS/* "$1"/dist/*.app/Contents/MacOS/*; do
    printf '%s\n' "$c"
  done
}

# Bundle binaries stage dist/bin into the .app, so the build's ini may live
# in either place; the launch ini goes into the bundle's Resources, which
# the startup-cache scan then covers too.
aequera_platform_launch_ini() {
  SRC_INI="$2/application.ini"
  INI="$2/browser/aequera-application.ini"
  RESOURCES=""
  case "$1" in
    *.app/Contents/MacOS/*)
      RESOURCES="$(dirname "$(dirname "$1")")/Resources"
      INI="$RESOURCES/browser/aequera-application.ini"
      [ -f "$SRC_INI" ] || SRC_INI="$RESOURCES/application.ini"
      ;;
  esac
}

aequera_to_native() {
  printf '%s\n' "$1"
}

# dist/bin symlinks work as they are here.
aequera_platform_prepare_dist() {
  return 0
}

# Frame material has no pref Firefox's tests depend on here.
aequera_platform_test_prefs() {
  return 0
}
