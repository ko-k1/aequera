#!/usr/bin/env bash
# NixOS wrapper for the local browser benchmark (browser_bench.py).
#
#   bash tools/benchmark/browser-bench-nixos.sh --aequera --label aequera --out <json> [args...]
#   bash tools/benchmark/browser-bench-nixos.sh --exe <firefox dir>/firefox --label firefox --out <json> [args...]
#
# --aequera fills in the artifact build (obj/firefox/artifact, or
# AEQUERA_OBJDIR) with the launcher's identity (-app, as aequera-run.sh does).
# Any other arguments go to browser_bench.py (--runs, --pref name=value, ...).
#
# The browser runs in a private headless sway (Wayland, the GPU renderer), not
# on the desktop: tab switches need a real compositor (headless Firefox never
# finishes one), and the benchmark must not open windows on the user's
# session. Needs `sway` on PATH (nix shell nixpkgs#sway) and steam-run, with
# the TMPDIR and fontconfig cache recipe of tools/build/linux/nixos/env.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

for tool in sway steam-run; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "browser-bench: $tool not found (sway: nix shell nixpkgs#sway)" >&2
    exit 2
  fi
done

STATE="${AEQUERA_BENCH_STATE:-$ROOT/.tmp/nixos}"
mkdir -p "$STATE/tmp" "$STATE/cache" "$STATE/bench"

ARGS=()
if [ "${1:-}" = "--aequera" ]; then
  shift
  OBJDIR="${AEQUERA_OBJDIR:-$ROOT/obj/firefox/artifact}"
  BIN="$OBJDIR/dist/bin"
  [ -x "$BIN/firefox" ] || { echo "browser-bench: no build in $BIN" >&2; exit 1; }
  INI="$BIN/browser/aequera-application.ini"
  steam-run python3 "$ROOT/tools/build/common/aequera_app_ini.py" "$BIN/application.ini" "$INI"
  TOPSRCDIR="$(readlink -f "$BIN/browser/defaults/preferences/aequera-prefs.js")"
  TOPSRCDIR="${TOPSRCDIR%/browser/aequera/aequera-prefs.js}"
  # As aequera-run.sh: dist symlinks into the source tree, and the content
  # sandbox resolves them only with the developer dirs advertised.
  ARGS+=(--exe "$BIN/firefox" --app-ini "$INI"
    --env "MOZ_DEVELOPER_REPO_DIR=$TOPSRCDIR" --env "MOZ_DEVELOPER_OBJ_DIR=$OBJDIR")
fi

# Private headless compositor; its socket name comes from its log.
SWAY_LOG="$STATE/bench/sway.log"
SWAY_CONF="$STATE/bench/sway.conf"
printf '%s\n' 'output HEADLESS-1 resolution 1920x1080' 'default_border none' > "$SWAY_CONF"
env -u WAYLAND_DISPLAY -u DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE \
  WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 \
  sway --verbose -c "$SWAY_CONF" > "$SWAY_LOG" 2>&1 &
SWAY_PID=$!
trap 'kill "$SWAY_PID" 2>/dev/null || true' EXIT
SOCKET=""
for _ in $(seq 100); do
  SOCKET="$(grep -a -o "wayland display '[^']*'" "$SWAY_LOG" | head -1 | cut -d"'" -f2 || true)"
  [ -n "$SOCKET" ] && break
  sleep 0.1
done
[ -n "$SOCKET" ] || { echo "browser-bench: sway did not start (see $SWAY_LOG)" >&2; exit 1; }

env -u LD_LIBRARY_PATH -u DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE \
  TMPDIR="$STATE/tmp" XDG_CACHE_HOME="$STATE/cache" \
  WAYLAND_DISPLAY="$SOCKET" MOZ_ENABLE_WAYLAND=1 GDK_BACKEND=wayland \
  steam-run python3 "$SCRIPT_DIR/browser_bench.py" "${ARGS[@]}" "$@"
