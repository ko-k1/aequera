#!/usr/bin/env bash
# Local smoke check (Linux/macOS). Mirrors PR CI step for step.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI_DIR="$ROOT/tools/cli"
# Cargo workspace target dir: member builds land in $ROOT/target, never in
# tools/cli/target (no such directory exists).
BIN="$ROOT/target/debug/aequera"

pushd "$CLI_DIR" > /dev/null
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
cargo build --workspace --locked
popd > /dev/null

pushd "$ROOT" > /dev/null
# Pure JS models (shell, extensions): node's built-in runner, no packages.
# Tracked files only, listed explicitly: a glob that matches nothing makes
# `node --test` pass with zero tests, so an empty list fails instead.
# (A read loop, not mapfile: macOS runs bash 3.2.)
NODE_TESTS=()
while IFS= read -r file; do
  NODE_TESTS+=("$file")
done < <(git ls-files ':(glob)aequera/**/*.test.js' ':(glob)aequera/**/*.test.mjs')
if [ "${#NODE_TESTS[@]}" -eq 0 ]; then
  echo "smoke: no node tests found under aequera/" >&2
  exit 1
fi
node --test "${NODE_TESTS[@]}"
# Build tooling in Python (stdlib unittest, no packages).
python3 -m unittest discover -s tests/unit/build
# The tor bundle scripts' integrity checks, offline (shims, no download).
bash tests/security/tor/scripts.test.sh
"$BIN" doctor
"$BIN" upstream status
"$BIN" patch status
"$BIN" config validate
popd > /dev/null

echo "smoke: all green"
