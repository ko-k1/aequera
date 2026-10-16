# Host platform for the POSIX build tooling (launchers, test gate). Source it
# with ROOT (the checkout root) and LAUNCHER (the name in messages) set, then
# call aequera_load_platform: it sets AEQUERA_HOST to windows, macos, or linux
# and sources tools/build/$AEQUERA_HOST/platform.sh.
#
# Shared scripts never branch on the OS themselves; everything that differs
# per OS is one of these hooks, and every platform.sh defines all of them
# (tests/unit/build/test_platform_hooks.py checks the contract):
#
#   aequera_platform_native_exes <objdir>
#       compiled Aequera binaries the objdir may hold, one path per line,
#       preferred first (a compiled objdir is recognized by any of them)
#   aequera_platform_artifact_exes <objdir>
#       Mozilla's prebuilt binaries (artifact builds), one path per line
#   aequera_platform_launch_ini <exe> <dist/bin>
#       sets SRC_INI (the build's application.ini), INI (where the launch
#       ini goes), and RESOURCES (an extra directory the startup-cache scan
#       covers, or empty)
#   aequera_to_native <path>
#       the path as the browser binary expects it
#   aequera_platform_prepare_dist <dist/bin>
#       fixes the build's dist/bin before a start or a test run; returns
#       non-zero on failure (callers decide whether that is fatal)
#   aequera_platform_test_prefs
#       extra mochitest arguments that restore Firefox's defaults for the
#       upstream tests, one per line

# Prints the host name (windows, macos, linux); fails on anything else.
# MozillaBuild, Git Bash, and Cygwin all count as Windows.
aequera_host() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    Darwin) echo macos ;;
    Linux) echo linux ;;
    *) return 1 ;;
  esac
}

aequera_load_platform() {
  AEQUERA_HOST="$(aequera_host)" || {
    echo "$LAUNCHER: unsupported host '$(uname -s)'; Aequera builds on Windows (MozillaBuild or Git Bash), macOS, and Linux." >&2
    exit 1
  }
  . "$ROOT/tools/build/$AEQUERA_HOST/platform.sh"
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
