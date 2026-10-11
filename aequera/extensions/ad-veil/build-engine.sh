#!/bin/bash
# Builds addon/engine.wasm from engine/ (docs/design/ADS.md, "Engine").
#
#   bash aequera/extensions/ad-veil/build-engine.sh [--check]
#
# Needs cargo, rustc with the wasm32-unknown-unknown target, and lld; on
# NixOS: nix shell nixpkgs#rustc nixpkgs#cargo nixpkgs#lld -c bash <this>.
# --check rebuilds and fails if the result differs from the committed
# engine.wasm (same toolchain required: the rustc version is in the log).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
target="$root/target/adveil-wasm"
cd "$root"
rustc --version
cargo build -q --release --locked -p aequera-adveil-engine \
  --target wasm32-unknown-unknown --target-dir "$target" \
  --config 'profile.release.opt-level=3' \
  --config 'profile.release.lto=true' \
  --config 'profile.release.codegen-units=1' \
  --config 'profile.release.panic="abort"' \
  --config 'profile.release.strip=true'
built="$target/wasm32-unknown-unknown/release/aequera_adveil_engine.wasm"
dest="$here/addon/engine.wasm"
if [ "${1:-}" = --check ]; then
  if cmp -s "$built" "$dest"; then
    echo "engine.wasm matches the build"
  else
    echo "engine.wasm differs from the build (rebuild and commit, or check the toolchain)" >&2
    exit 1
  fi
else
  cp "$built" "$dest"
fi
sha256sum "$dest" | sed "s|$root/||"
