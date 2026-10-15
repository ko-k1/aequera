#!/bin/bash
# Put the pinned tor expert bundle (upstream/manifests/tor-expert-bundle.lock)
# into a build, as <dist/bin>/tor, where Tor windows find it first
# (aequera-tor-daemon.sys.mjs). Run after `mach build`; the build keeps it.
#
#   bash tools/tor/fetch-bundle.sh [objdir]
#
# objdir: default obj/firefox/compiled when it holds a build, else
# obj/firefox/artifact (the objdirs tools/build/aequera-run.sh picks from).
# The archive is downloaded once into obj/tor-bundle/ and checked against
# the pinned SHA-256 on every run; a mismatch is deleted and refused.
# Linux x86_64, macOS (arm64, x86_64), and Windows x86_64 (Git Bash or the
# MozillaBuild shell; a self-contained tor.exe).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCK="$ROOT/upstream/manifests/tor-expert-bundle.lock"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) PLATFORM=linux-x86_64 ;;
  Darwin-arm64) PLATFORM=macos-aarch64 ;;
  Darwin-x86_64) PLATFORM=macos-x86_64 ;;
  MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64) PLATFORM=windows-x86_64 ;;
  *) echo "fetch-bundle: no pinned tor bundle for $(uname -s) $(uname -m)" >&2; exit 2 ;;
esac

lock_value() { awk -v key="$1:" '$1 == key { v = $2; gsub(/"/, "", v); print v; exit }' "$LOCK"; }
# Every value is checked against an exact pattern before use (it also goes
# into the marker file below).
must_match() {
  printf '%s\n' "$2" | grep -Eq "$3" || { echo "fetch-bundle: bad $1 in $LOCK: '$2'" >&2; exit 1; }
}
must_match schema_version "$(lock_value schema_version)" '^1$'
VERSION="$(lock_value tor_browser_version)"
TOR_VERSION="$(lock_value tor_version)"
RELEASE_URL="$(lock_value release_url)"
SHA256="$(lock_value "$PLATFORM")"
must_match tor_browser_version "$VERSION" '^[0-9]+(\.[0-9]+)+$'
must_match tor_version "$TOR_VERSION" '^[0-9]+(\.[0-9]+)+$'
must_match "pin for $PLATFORM" "$SHA256" '^[0-9a-f]{64}$'
must_match release_url "$RELEASE_URL" "^https://dist\.torproject\.org/torbrowser/${VERSION//./\\.}/\$"

# The objdir the launchers start (tools/build/aequera-run.sh): the compiled
# build when its binary exists, else the artifact build.
if [ $# -gt 0 ]; then
  OBJDIR="$1"
elif [ -x "$ROOT/obj/firefox/compiled/dist/bin/aequera" ] || [ -x "$ROOT/obj/firefox/compiled/dist/bin/aequera.exe" ]; then
  OBJDIR="$ROOT/obj/firefox/compiled"
else
  OBJDIR="$ROOT/obj/firefox/artifact"
fi
BIN="$OBJDIR/dist/bin"
[ -d "$BIN" ] || { echo "fetch-bundle: no build at $BIN; run mach build first" >&2; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

FILE="tor-expert-bundle-$PLATFORM-$VERSION.tar.gz"
CACHE="$ROOT/obj/tor-bundle"
ARCHIVE="$CACHE/$FILE"
mkdir -p "$CACHE"
if [ ! -f "$ARCHIVE" ]; then
  echo "fetch-bundle: downloading $FILE" >&2
  if [ -t 2 ]; then PROGRESS=--progress-bar; else PROGRESS=--silent; fi
  curl -fL --show-error "$PROGRESS" --proto '=https' --tlsv1.2 -o "$ARCHIVE.part" "$RELEASE_URL$FILE"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
GOT="$(sha256_of "$ARCHIVE")"
if [ "$GOT" != "$SHA256" ]; then
  rm -f "$ARCHIVE"
  echo "fetch-bundle: $FILE has SHA-256 $GOT, pinned $SHA256; deleted, refusing" >&2
  exit 1
fi

# Assemble beside the destination, then swap it in whole.
STAGE="$(mktemp -d "$BIN/.tor-bundle.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$ARCHIVE" -C "$STAGE" tor data docs
OUT="$STAGE/out"
mv "$STAGE/tor" "$OUT"                       # tor, its libraries, pluggable_transports/
mv "$STAGE/data/geoip" "$STAGE/data/geoip6" "$OUT/"
mv "$STAGE/docs" "$OUT/licenses"             # tor, libevent, OpenSSL, lyrebird, conjure
cat > "$OUT/aequera-tor-bundle.json" <<EOF
{
  "source": "$RELEASE_URL$FILE",
  "sha256": "$SHA256",
  "platform": "$PLATFORM",
  "tor_browser_version": "$VERSION",
  "tor_version": "$TOR_VERSION"
}
EOF
chmod -R u+rwX,go+rX,go-w "$OUT"
rm -rf "$BIN/tor"
mv "$OUT" "$BIN/tor"
echo "fetch-bundle: tor $TOR_VERSION (Tor Browser $VERSION, $PLATFORM) installed in $BIN/tor"
