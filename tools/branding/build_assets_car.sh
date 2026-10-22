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
# --app-icon names the set Info.plist's CFBundleIconName expects; without it
# actool compiles the catalog but never registers the application icon.
xcrun actool --compile "$OUT" --platform macosx \
  --minimum-deployment-target 10.15 --target-device mac \
  --product-type com.apple.product-type.application --app-icon AppIcon \
  --output-partial-info-plist "$OUT/partial.plist" "$XCASSETS" >/dev/null
cp "$OUT/Assets.car" "$BRANDING/Assets.car"
echo "wrote $BRANDING/Assets.car"
