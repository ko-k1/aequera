#!/usr/bin/env bash
# NixOS wrapper for the Aequera shell test gate (tools/build/test-shell.sh).
#
#   bash tools/build/test-shell-nixos.sh [aequera|upstream|all] [--repeat N]
# (any directory; arguments pass through to test-shell.sh)
#
# Runs the gate inside steam-run; see nixos-env.sh for why.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
. "$SCRIPT_DIR/nixos-env.sh"

if [ -z "${MOZCONFIG:-}" ]; then
  export MOZCONFIG="$ROOT/tools/build/mozconfig.artifact"
  echo "test-shell-nixos: MOZCONFIG unset, using $MOZCONFIG" >&2
fi

nixos_fhs_exec "$ROOT/tools/build/test-shell.sh" "$@"
