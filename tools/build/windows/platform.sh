# Windows hooks for the POSIX build tooling (MozillaBuild or Git Bash);
# sourced by tools/build/common/host.sh, which documents the contract.

aequera_platform_native_exes() {
  printf '%s\n' "$1/dist/bin/aequera.exe"
}

aequera_platform_artifact_exes() {
  printf '%s\n' "$1/dist/bin/firefox.exe"
}

aequera_platform_launch_ini() {
  SRC_INI="$2/application.ini"
  INI="$2/browser/aequera-application.ini"
  RESOURCES=""
}

# Native Windows binaries need Windows-style paths when started from a POSIX
# shell; cygpath ships with MozillaBuild, Git Bash, and Cygwin.
aequera_to_native() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}

# The build's symlinks become copies (dist_copies.py: Gecko refuses
# symlinked built-in add-on files and objdir files in content processes
# here). mach relinks on every build, so this runs on every start; without
# links it is one scan.
aequera_platform_prepare_dist() {
  local python
  python="$(aequera_python)" || {
    echo "$LAUNCHER: python3 is needed to replace the build's symlinks in \"$1\"." >&2
    return 1
  }
  "$python" "$ROOT/tools/build/windows/dist_copies.py" "$1"
}

# Frame material: Aequera turns on Windows 11 Mica, Firefox leaves it off.
aequera_platform_test_prefs() {
  printf '%s\n' --setpref widget.windows.mica=false
}
