@echo off
rem Start the Aequera build: double-click, or run from any shell.
rem
rem Prefers the compiled build (aequera.exe with the Aequera icon embedded),
rem falls back to the artifact build (Mozilla's prebuilt firefox.exe). Always
rem use this (or aequera-run.sh), never a bare exe: started bare, the
rem artifact binary opens your Firefox profile, joins a running Firefox, and
rem serves shell code from that profile's startup cache. This passes the
rem Aequera identity (-app aequera-application.ini: its own profiles under
rem %APPDATA%\Aequera and its own single-instance channel), -no-remote, and
rem -purgecaches.
rem
rem Usage: aequera.cmd [Firefox arguments...]
rem   AEQUERA_OBJDIR overrides the build directory
rem   (default: worktree\firefox\obj-aequera when it holds aequera.exe,
rem   else worktree\firefox\obj-aequera-artifact in this repository).
setlocal
set "OBJDIR=%~dp0..\..\worktree\firefox\obj-aequera"
if not exist "%OBJDIR%\dist\bin\aequera.exe" set "OBJDIR=%~dp0..\..\worktree\firefox\obj-aequera-artifact"
if defined AEQUERA_OBJDIR set "OBJDIR=%AEQUERA_OBJDIR%"
set "BIN=%OBJDIR%\dist\bin"
set "INI=%BIN%\browser\aequera-application.ini"
set "EXE=%BIN%\aequera.exe"
if not exist "%EXE%" set "EXE=%BIN%\firefox.exe"

if not exist "%EXE%" (
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
start "" "%EXE%" -app "%INI%" -no-remote -purgecaches %*
