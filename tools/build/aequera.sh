#!/usr/bin/env bash
# Start the Aequera build: double-click is Windows-only; here run from any
# POSIX shell (Terminal, GNOME Console, macOS/Linux CI).
#
# POSIX counterpart of tools/build/windows/aequera.cmd. Prefers the compiled build
# (native `aequera` binary with the Aequera icon embedded), falls back to the
# artifact build (Mozilla's prebuilt `firefox` binary). Always use this (or
# tools/build/aequera-run.sh for the `mach run` dev loop), never a bare
# binary: started bare, the artifact binary opens your Firefox profile, joins
# a running Firefox, and serves shell code from that profile's startup cache.
# This passes the Aequera identity (-app aequera-application.ini: its own
# profile roots — ~/.aequera on Linux, ~/Library/Application Support/Aequera
# on macOS — and its own single-instance channel), -no-remote, and
# -purgecaches when the build changed since the last launch.
#
# Usage: tools/build/aequera.sh [Firefox arguments...]
#   AEQUERA_OBJDIR overrides the build directory (absolute, or relative to
#   worktree/firefox). Default: obj/firefox/compiled when it holds a native
#   Aequera binary, else obj/firefox/artifact (the mozconfigs' objdirs).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAUNCHER=aequera
. "$SCRIPT_DIR/common/launch-common.sh"
# AEQUERA_WORKTREE=candidate starts the rebased candidate's build.
aequera_worktree
aequera_objdir AEQUERA_OBJDIR "${AEQUERA_OBJDIR:-}"
aequera_find_exe

BIN="$OBJDIR/dist/bin"

# The build's own application.ini carries the Aequera identity; copy it as
# browser/aequera-application.ini (verified on every start, as aequera.cmd
# does, so it never drifts from a rebuild). Where it lives (next to the
# binary, or in a macOS bundle's Resources) is the platform's call
# (tools/build/<os>/platform.sh), the same as for aequera-run.sh.
aequera_platform_launch_ini "$EXE" "$BIN"
aequera_write_ini "$SRC_INI" "$INI"
INI_ARG="$(aequera_to_native "$INI")"
aequera_export_dev_dirs
aequera_platform_prepare_dist "$BIN" || exit 1

# Startup cache: purged only when the build changed since the last launch of
# this profile (common/startup-cache.sh; the stamp is shared with
# aequera-run.sh --persistent, which starts the same profile).
. "$SCRIPT_DIR/common/startup-cache.sh"
SCAN=("$BIN")
[ -d "$RESOURCES" ] && SCAN+=("$RESOURCES")
aequera_launch_purge "$OBJDIR/.aequera-launch-persistent" "${SCAN[@]}" -- "$@"
exec "$EXE" -app "$INI_ARG" -no-remote ${PURGE[@]+"${PURGE[@]}"} "$@"
