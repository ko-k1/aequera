#!/usr/bin/env bash
# NixOS wrapper for the Aequera launcher (tools/build/aequera-run.sh).
#
#   bash tools/build/linux/nixos/aequera-run.sh                 # throwaway dev profile
#   bash tools/build/linux/nixos/aequera-run.sh --persistent    # real Aequera profile
# (any directory; arguments pass through to aequera-run.sh, which picks the
# objdir and MOZCONFIG itself)
#
# Runs the launcher inside steam-run; see env.sh for why.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
. "$SCRIPT_DIR/env.sh"

nixos_fhs_exec "$ROOT/tools/build/aequera-run.sh" "$@"
