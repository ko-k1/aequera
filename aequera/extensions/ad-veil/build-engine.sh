#!/bin/bash
# Builds addon/engine.wasm from engine/ (docs/design/ADS.md, "Engine").
#
#   bash aequera/extensions/ad-veil/build-engine.sh [--check]
#
# Needs rustup's Rust 1.98.1 with the wasm32-unknown-unknown target
# (`rustup target add wasm32-unknown-unknown`): the committed engine.wasm is
# that toolchain's output, and CI (.github/workflows/ci.yml, engine job)
# rebuilds it with the same one. Another build of rustc (a distro or nix
# package with its own LLVM) emits different bytes even at the same version.
# --check rebuilds and fails if the result differs from the committed
# engine.wasm.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
target="$root/target/adveil-wasm"
cd "$root"
rustc --version
# Panic locations embed source paths: map the cargo registry and the checkout
# to fixed prefixes, so the binary names no home directory and rebuilds the
# same on any machine.
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
remap="['--remap-path-prefix=$cargo_home/registry/src=/cargo/registry/src', '--remap-path-prefix=$root=/aequera']"
cargo build -q --release --locked -p aequera-adveil-engine \
  --target wasm32-unknown-unknown --target-dir "$target" \
  --config "target.wasm32-unknown-unknown.rustflags=$remap" \
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
