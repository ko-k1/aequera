#!/bin/bash
# Builds addon/engine.wasm from engine/ (docs/design/ADS.md, "Engine").
#
#   bash aequera/extensions/ad-veil/build-engine.sh [--check]
#
# Needs rustup's Rust 1.98.1 with the wasm32-unknown-unknown target
# (`rustup target add wasm32-unknown-unknown`). The committed engine.wasm is
# that toolchain's output on an x86_64 Linux host, the reference CI
# (.github/workflows/ci.yml, engine job) rebuilds and compares with. Builds
# are byte-for-byte repeatable per host architecture but not across them
# (an aarch64 host emits different bytes from the same toolchain and
# source), and another build of rustc (a distro or nix package with its own
# LLVM) differs too. Elsewhere this still builds engine.wasm for local
# testing; before committing an engine change, take CI's build: the engine
# job fails on it and uploads the reference as the engine-wasm-ci artifact.
# --check rebuilds and fails if the result differs from the committed
# engine.wasm; off the reference host it cannot tell, and says so.
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
reference_host=true
if [ "$(uname -s)-$(uname -m)" != Linux-x86_64 ]; then
  reference_host=false
fi
if [ "${1:-}" = --check ]; then
  if [ "$reference_host" = false ]; then
    echo "engine.wasm: not checked; only an x86_64 Linux build is comparable (this host: $(uname -s) $(uname -m)); CI's engine job checks it" >&2
  elif cmp -s "$built" "$dest"; then
    echo "engine.wasm matches the build"
  else
    echo "engine.wasm differs from the build (rebuild and commit, or check the toolchain)" >&2
    exit 1
  fi
else
  cp "$built" "$dest"
  if [ "$reference_host" = false ]; then
    echo "engine.wasm: built on $(uname -s) $(uname -m), not the x86_64 Linux reference; fine for local testing, but commit CI's engine-wasm-ci build" >&2
  fi
fi
sha256sum "$dest" | sed "s|$root/||"
