@echo off
rem Start the Aequera artifact build: double-click, or run from any shell.
rem
rem Always use this (or aequera-run.sh), never bare firefox.exe: the prebuilt
rem exe of an artifact build is Firefox until told otherwise, so started bare it
rem opens your Firefox profile, joins a running Firefox, and serves shell code
rem from that profile's startup cache. This passes the Aequera identity
rem (-app aequera-application.ini: its own profiles under %APPDATA%\Aequera and
rem its own single-instance channel), -no-remote, and -purgecaches.
rem
rem Usage: aequera.cmd [Firefox arguments...]
rem   AEQUERA_OBJDIR overrides the build directory
rem   (default: worktree\firefox\obj-aequera-artifact in this repository).
setlocal
set "OBJDIR=%~dp0..\..\worktree\firefox\obj-aequera-artifact"
if defined AEQUERA_OBJDIR set "OBJDIR=%AEQUERA_OBJDIR%"
set "BIN=%OBJDIR%\dist\bin"
set "INI=%BIN%\browser\aequera-application.ini"

if not exist "%BIN%\firefox.exe" (
  echo aequera: no build in "%BIN%"; see tools\build\README.md. 1>&2
  exit /b 1
)
rem Copied from the build's own (verified to carry the Aequera identity) on
rem every start, as aequera-run.sh does, so it never drifts from a rebuild.
where python >nul 2>&1
if errorlevel 1 (
  if not exist "%INI%" (
    echo aequera: cannot write "%INI%" without python; run tools/build/aequera-run.sh once. 1>&2
    exit /b 1
  )
  echo aequera: python not found, starting with the existing "%INI%". 1>&2
) else (
  python "%~dp0aequera_app_ini.py" "%BIN%\application.ini" "%INI%" || exit /b 1
)
start "" "%BIN%\firefox.exe" -app "%INI%" -no-remote -purgecaches %*
