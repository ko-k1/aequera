# tools/upstream

Upstream acquisition logic lives in `tools/cli/src/upstream.rs` (`aequera
upstream fetch/checkout/verify`, `aequera bootstrap`).

This directory is reserved for future standalone upstream helpers that
cannot live in the CLI (e.g. large shell/Python sync scripts). Do not add
duplicates of the CLI implementation here.
