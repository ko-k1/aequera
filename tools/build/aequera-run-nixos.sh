#!/usr/bin/env bash
# NixOS wrapper for the Aequera launcher (tools/build/aequera-run.sh).
#
#   bash tools/build/aequera-run-nixos.sh                 # throwaway dev profile
#   bash tools/build/aequera-run-nixos.sh --persistent    # real Aequera profile
# (any directory; arguments pass through to aequera-run.sh, which picks the
# objdir and MOZCONFIG itself)
#
# Runs the launcher inside steam-run; see nixos-env.sh for why.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
. "$SCRIPT_DIR/nixos-env.sh"

nixos_fhs_exec "$ROOT/tools/build/aequera-run.sh" "$@"
