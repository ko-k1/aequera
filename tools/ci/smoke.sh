#!/usr/bin/env bash
# Local smoke check (Linux/macOS). Mirrors PR CI step for step.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI_DIR="$ROOT/tools/cli"
BIN="$CLI_DIR/target/debug/aequera"

pushd "$CLI_DIR" > /dev/null
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build
popd > /dev/null

pushd "$ROOT" > /dev/null
"$BIN" doctor
"$BIN" upstream status
"$BIN" patch status
"$BIN" config validate
popd > /dev/null

echo "smoke: all green"
