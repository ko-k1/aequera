# Linux hooks for the POSIX build tooling (NixOS included; its FHS wrappers
# are in nixos/); sourced by tools/build/common/host.sh, which documents the
# contract.

aequera_platform_native_exes() {
  printf '%s\n' "$1/dist/bin/aequera"
}

aequera_platform_artifact_exes() {
  printf '%s\n' "$1/dist/bin/firefox"
}

aequera_platform_launch_ini() {
  SRC_INI="$2/application.ini"
  INI="$2/browser/aequera-application.ini"
  RESOURCES=""
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
