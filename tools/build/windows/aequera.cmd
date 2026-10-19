@echo off
rem Start the Aequera build: double-click, or run from any shell.
rem
rem Prefers the compiled build (aequera.exe with the Aequera icon embedded),
rem falls back to the artifact build (Mozilla's prebuilt firefox.exe). Always
rem use this (or tools/build/aequera.sh on Linux/macOS, aequera-run.sh for the
rem mach dev loop), never a bare exe: started bare, the
rem artifact binary opens your Firefox profile, joins a running Firefox, and
rem serves shell code from that profile's startup cache. This passes the
rem Aequera identity (-app aequera-application.ini: its own profiles under
rem %APPDATA%\Aequera and its own single-instance channel), -no-remote, and
rem -purgecaches.
rem
rem Usage: aequera.cmd [Firefox arguments...]
rem   AEQUERA_OBJDIR overrides the build directory: absolute, or relative to
rem   worktree\firefox and then it must stay inside the checkout. A relative
rem   one with a `..` component, a leading separator, or a `:` (drive,
rem   stream) is refused outright -- the same escape aequera.sh catches by
rem   resolving and comparing, without needing an external program here.
rem   Default: obj\firefox\compiled when it holds aequera.exe, else
rem   obj\firefox\artifact in this repository.
rem
rem User-controlled text (arguments, AEQUERA_OBJDIR) is only ever expanded
rem with `!` after cmd has parsed the line, so `&`, `|`, `<`, `>` in a URL
rem or path stay data. (A double quote inside an argument cannot be made
rem safe in batch; cmd offers no way to escape it.)
setlocal DisableDelayedExpansion

rem The checkout root, resolved from this script's location before delayed
rem expansion is on, so a `!` in the path is left alone.
set "ROOT=%~dp0..\..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

setlocal EnableDelayedExpansion

set "OBJDIR=!ROOT!\obj\firefox\compiled"
if not exist "!OBJDIR!\dist\bin\aequera.exe" set "OBJDIR=!ROOT!\obj\firefox\artifact"
if defined AEQUERA_OBJDIR (
  rem Drop every `"` first: one would break out of the quoting below.
  set "OVERRIDE=!AEQUERA_OBJDIR:"=!"
  if "!OVERRIDE:~1,1!"==":" (
    rem Drive-absolute: explicit intent, used as given.
    set "OBJDIR=!OVERRIDE!"
  ) else if "!OVERRIDE:~0,2!"=="\\" (
    rem UNC-absolute: explicit intent, used as given.
    set "OBJDIR=!OVERRIDE!"
  ) else (
    rem Relative to worktree\firefox. The base path plus an override with no
    rem `..`, no leading separator, and no colon provably stays under the
    rem worktree, so the normalized result needs no further comparison.
    set "BAD="
    if not "!OVERRIDE:..=!"=="!OVERRIDE!" set "BAD=1"
    if "!OVERRIDE:~0,1!"=="\" set "BAD=1"
    if "!OVERRIDE:~0,1!"=="/" set "BAD=1"
    if not "!OVERRIDE::=!"=="!OVERRIDE!" set "BAD=1"
    if defined BAD (
      echo aequera: AEQUERA_OBJDIR escapes the checkout; refusing. 1>&2
      exit /b 1
    )
    for %%I in ("!ROOT!\worktree\firefox\!OVERRIDE!") do set "OBJDIR=%%~fI"
  )
)
rem Like `mach run`, advertise the developer dirs: local builds symlink
rem front-end files into dist, and the Windows content-process sandbox only
rem resolves those links when MOZ_DEVELOPER_REPO_DIR is set (upstream bug
rem 1916286: without it DevTools cannot open and Ctrl+Shift+I / F12 fail
rem with "builtin-modules.js is not found").
for %%I in ("!ROOT!\worktree\firefox") do set "MOZ_DEVELOPER_REPO_DIR=%%~fI"
for %%I in ("!OBJDIR!") do set "MOZ_DEVELOPER_OBJ_DIR=%%~fI"
set "BIN=!OBJDIR!\dist\bin"
set "INI=!BIN!\browser\aequera-application.ini"
set "EXE=!BIN!\aequera.exe"
if not exist "!EXE!" set "EXE=!BIN!\firefox.exe"

if not exist "!EXE!" (
  echo aequera: no build in "!BIN!"; see tools\build\windows\README.md. 1>&2
  exit /b 1
)
rem Copied from the build's own (verified to carry the Aequera identity) on
rem every start, as aequera-run.sh does, so it never drifts from a rebuild.
where python >nul 2>&1
if errorlevel 1 (
  rem Fail closed: a stale INI could carry the wrong (Firefox) identity.
  echo aequera: cannot verify "!INI!" without python; refusing to launch with a possibly stale identity. 1>&2
  exit /b 1
) else (
  python "%~dp0..\common\aequera_app_ini.py" "!BIN!\application.ini" "!INI!" || exit /b 1
  rem The build's symlinks become copies (dist_copies.py): Gecko refuses
  rem symlinked built-in add-on and objdir files in content processes here.
  python "%~dp0dist_copies.py" "!BIN!" || exit /b 1
)
rem Collect the arguments with delayed expansion off (`!` in a URL survives),
rem then splice them in with `!ARGS!`: cmd has already parsed the `start`
rem line when the text arrives, so metacharacters in an argument cannot
rem start another command.
setlocal DisableDelayedExpansion
set "ARGS=%*"
setlocal EnableDelayedExpansion
start "" "!EXE!" -app "!INI!" -no-remote -purgecaches !ARGS!
