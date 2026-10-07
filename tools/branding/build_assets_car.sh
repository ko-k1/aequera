#!/bin/bash
# Compile the macOS asset catalog (Assets.car) from the committed .xcassets.
# Runs only on macOS with the Xcode command line tools installed:
#   bash tools/branding/build_assets_car.sh
# Commit the resulting aequera/design/branding/Assets.car: the macOS bundle
# step (browser/app/moz.build) and package-manifest.in require it next to
# firefox.icns / document.icns, and actool exists only on Apple hosts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRANDING="$ROOT/aequera/design/branding"
XCASSETS="$BRANDING/macos/Assets.xcassets"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "build_assets_car: xcrun not found; run this on macOS with the Xcode command line tools." >&2
  exit 1
fi

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
xcrun actool --compile "$OUT" --platform macosx "$XCASSETS" >/dev/null
cp "$OUT/Assets.car" "$BRANDING/Assets.car"
echo "wrote $BRANDING/Assets.car"
