#!/bin/bash
# Pin a Tor Browser release's tor expert bundles in
# upstream/manifests/tor-expert-bundle.lock, after verifying the release's
# signed checksum list with the Tor Browser Developers signing key.
#
#   bash tools/tor/update-pin.sh <tor-browser-version>     e.g. 15.0.25
#
# Needs curl and gpg (NixOS: nix shell nixpkgs#gnupg -c bash ...). The key
# is fetched by WKD, as the Tor Project's verification guide does, and the
# signature must come from the primary key fingerprint below: a key that
# merely claims the address is not enough. The tor version recorded is read
# from the Linux x86_64 tor itself (run with its own libraries) on Linux,
# else given as a second argument.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCK="$ROOT/upstream/manifests/tor-expert-bundle.lock"
SIGNING_KEY=EF6E286DDA85EA2A4BA7DE684E2C6E8793298290
PLATFORMS="linux-x86_64 macos-aarch64 macos-x86_64"

VERSION="${1:?usage: update-pin.sh <tor-browser-version> [tor-version]}"
case "$VERSION" in
  *[!0-9.]*|"") echo "update-pin: version must be digits and dots" >&2; exit 2 ;;
esac
TOR_VERSION="${2:-}"
URL="https://dist.torproject.org/torbrowser/$VERSION/"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export GNUPGHOME="$WORK/gnupg"
mkdir -m 700 "$GNUPGHOME"
cd "$WORK"

curl -fsSL --proto '=https' --tlsv1.2 -O "${URL}sha256sums-signed-build.txt" -O "${URL}sha256sums-signed-build.txt.asc"
gpg --quiet --auto-key-locate nodefault,wkd --locate-keys torbrowser@torproject.org >/dev/null
# VALIDSIG's last field is the primary key fingerprint of the signing key.
PRIMARY="$(gpg --status-fd 1 --verify sha256sums-signed-build.txt.asc sha256sums-signed-build.txt 2>/dev/null |
  awk '$2 == "VALIDSIG" { print $NF }')"
if [ "$PRIMARY" != "$SIGNING_KEY" ]; then
  echo "update-pin: no valid signature by $SIGNING_KEY (got '${PRIMARY:-none}')" >&2
  exit 1
fi
echo "update-pin: sha256sums-signed-build.txt signed by $SIGNING_KEY" >&2

# "platform sha256" per line (bash 3.2 on macOS: no associative arrays).
: > hashes
for p in $PLATFORMS; do
  h="$(awk -v f="tor-expert-bundle-$p-$VERSION.tar.gz" '$2 == f { print $1 }' sha256sums-signed-build.txt)"
  [ "${#h}" -eq 64 ] || { echo "update-pin: no $p bundle in $VERSION" >&2; exit 1; }
  echo "$p $h" >> hashes
done
sha_for() { awk -v p="$1" '$1 == p { print $2 }' "$WORK/hashes"; }

if [ -z "$TOR_VERSION" ]; then
  if [ "$(uname -s)-$(uname -m)" != Linux-x86_64 ]; then
    echo "update-pin: give the tor version as the second argument on this platform" >&2
    exit 2
  fi
  F="tor-expert-bundle-linux-x86_64-$VERSION.tar.gz"
  curl -fsSL --proto '=https' --tlsv1.2 -O "$URL$F"
  [ "$(sha256sum "$F" | cut -d' ' -f1)" = "$(sha_for linux-x86_64)" ] || { echo "update-pin: $F does not match the signed list" >&2; exit 1; }
  mkdir x && tar -xzf "$F" -C x tor
  TOR_VERSION="$(LD_LIBRARY_PATH="$WORK/x/tor" "$WORK/x/tor/tor" --version | awk 'NR == 1 { print $3 }')"
fi
case "$TOR_VERSION" in
  [0-9]*.*) ;;
  *) echo "update-pin: unexpected tor version '$TOR_VERSION'" >&2; exit 1 ;;
esac

# The header stays; everything from schema_version on is rewritten.
awk '/^schema_version:/ { exit } { print }' "$LOCK" > "$WORK/lock"
cat >> "$WORK/lock" <<EOF
schema_version: 1

upstream:
  name: tor-expert-bundle
  release_url: $URL
  tor_browser_version: "$VERSION"
  tor_version: "$TOR_VERSION"
  signing_key: $SIGNING_KEY
  pinned_at: $(date -u +%Y-%m-%d)

bundles:
EOF
for p in $PLATFORMS; do
  echo "  $p: $(sha_for "$p")" >> "$WORK/lock"
done
mv "$WORK/lock" "$LOCK"
echo "update-pin: pinned Tor Browser $VERSION (tor $TOR_VERSION)"
