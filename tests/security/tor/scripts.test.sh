#!/usr/bin/env bash
# Offline tests for tools/tor/fetch-bundle.sh and tools/tor/update-pin.sh:
# their integrity checks, in a fake checkout with shims for uname, curl, gpg.
# Nothing is downloaded. bash 3.2 (macOS) compatible.
#
#   bash tests/security/tor/scripts.test.sh
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FAILED=0
PASSED=0
ok() { PASSED=$((PASSED + 1)); echo "ok - $1"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else fail "$1"; fi; }
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# A fake checkout: the two scripts, a lock, an objdir.
mkdir -p "$T/repo/tools/tor" "$T/repo/upstream/manifests" "$T/repo/obj/firefox/artifact/dist/bin" "$T/bin"
cp "$ROOT/tools/tor/fetch-bundle.sh" "$ROOT/tools/tor/update-pin.sh" "$T/repo/tools/tor/"
BIN="$T/repo/obj/firefox/artifact/dist/bin"

# uname: always Linux x86_64. curl: never used by fetch-bundle here (the
# archive is cached); for update-pin it serves files from $T/serve.
cat > "$T/bin/uname" <<'EOF'
#!/bin/sh
case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac
EOF
cat > "$T/bin/curl" <<'EOF'
#!/bin/sh
# Writes each -O URL's file from $FAKE_SERVE; fails if it is not there.
for a in "$@"; do
  case "$a" in
    https://*) f="${a##*/}"; [ -f "$FAKE_SERVE/$f" ] || exit 22; cp "$FAKE_SERVE/$f" "./$f" ;;
  esac
done
EOF
cat > "$T/bin/gpg" <<'EOF'
#!/bin/sh
# --verify prints VALIDSIG with $FAKE_FPR as the primary key (empty: a bad
# signature, exit 1); anything else succeeds.
for a in "$@"; do
  if [ "$a" = "--verify" ]; then
    [ -n "$FAKE_FPR" ] || exit 1
    echo "[GNUPG:] VALIDSIG 022DA248432D2A0E0F54E65E316C1FACD62D07D9 2026-10-14 0 4 0 1 10 00 $FAKE_FPR"
    exit 0
  fi
done
exit 0
EOF
chmod +x "$T/bin/uname" "$T/bin/curl" "$T/bin/gpg"
export PATH="$T/bin:$PATH"

# A tiny bundle in the expert bundle's layout.
mkdir -p "$T/fixture/tor/pluggable_transports" "$T/fixture/data" "$T/fixture/docs" "$T/repo/obj/tor-bundle"
printf '#!/bin/sh\necho fake tor\n' > "$T/fixture/tor/tor"
chmod +x "$T/fixture/tor/tor"
echo geoip > "$T/fixture/data/geoip"
echo geoip6 > "$T/fixture/data/geoip6"
echo license > "$T/fixture/docs/tor.txt"
ARCHIVE_NAME=tor-expert-bundle-linux-x86_64-15.0.25.tar.gz
(cd "$T/fixture" && tar -czf "$T/$ARCHIVE_NAME" tor data docs)
GOOD_SHA="$(sha256_of "$T/$ARCHIVE_NAME")"

write_lock() { # sha [release_url] [schema]
  cat > "$T/repo/upstream/manifests/tor-expert-bundle.lock" <<EOF
# test lock
schema_version: ${3:-1}

upstream:
  name: tor-expert-bundle
  release_url: ${2:-https://dist.torproject.org/torbrowser/15.0.25/}
  tor_browser_version: "15.0.25"
  tor_version: "0.4.9.14"
  signing_key: EF6E286DDA85EA2A4BA7DE684E2C6E8793298290
  pinned_at: 2026-10-14

bundles:
  linux-x86_64: $1
  macos-aarch64: $1
  macos-x86_64: $1
EOF
}
FETCH="$T/repo/tools/tor/fetch-bundle.sh"
CACHE="$T/repo/obj/tor-bundle/$ARCHIVE_NAME"

echo "# fetch-bundle.sh"

# A good pin: installed whole, nothing staged left behind.
write_lock "$GOOD_SHA"
cp "$T/$ARCHIVE_NAME" "$CACHE"
bash "$FETCH" >/dev/null 2>&1
check "good pin: installs" "[ -x '$BIN/tor/tor' ] && [ -f '$BIN/tor/geoip' ] && [ -f '$BIN/tor/geoip6' ] && [ -f '$BIN/tor/licenses/tor.txt' ]"
check "good pin: marker names the archive's hash" "grep -q '\"sha256\": \"$GOOD_SHA\"' '$BIN/tor/aequera-tor-bundle.json'"
check "good pin: no staging directory left" "! ls -d '$BIN'/.tor-bundle.* >/dev/null 2>&1"

# A tampered archive: refused, deleted, the installed bundle untouched.
echo keep > "$BIN/tor/keep"
printf 'x' >> "$CACHE"
bash "$FETCH" >/dev/null 2>&1
code=$?
check "tampered archive: exit 1" "[ $code -eq 1 ]"
check "tampered archive: deleted from the cache" "[ ! -f '$CACHE' ]"
check "tampered archive: installed bundle untouched" "[ -f '$BIN/tor/keep' ]"

# Bad locks: refused before any download or install.
cp "$T/$ARCHIVE_NAME" "$CACHE"
for bad in "z${GOOD_SHA#?}" "${GOOD_SHA}0" "short"; do
  write_lock "$bad"
  bash "$FETCH" >/dev/null 2>&1
  code=$?
  check "bad pin '${bad:0:12}...': exit 1" "[ $code -eq 1 ]"
done
write_lock "$GOOD_SHA" "https://example.com/torbrowser/15.0.25/"
bash "$FETCH" >/dev/null 2>&1
code=$?
check "release_url outside dist.torproject.org: exit 1" "[ $code -eq 1 ]"
write_lock "$GOOD_SHA" "" 2
bash "$FETCH" >/dev/null 2>&1
code=$?
check "unknown schema_version: exit 1" "[ $code -eq 1 ]"
check "bad locks: installed bundle untouched" "[ -f '$BIN/tor/keep' ]"

echo "# update-pin.sh"

PIN="$T/repo/tools/tor/update-pin.sh"
LOCK="$T/repo/upstream/manifests/tor-expert-bundle.lock"
export FAKE_SERVE="$T/serve"
mkdir -p "$FAKE_SERVE"
NEW_LINUX="$(printf 'a%.0s' $(seq 64))"
NEW_ARM="$(printf 'b%.0s' $(seq 64))"
NEW_X86="$(printf 'c%.0s' $(seq 64))"
cat > "$FAKE_SERVE/sha256sums-signed-build.txt" <<EOF
$NEW_LINUX  tor-expert-bundle-linux-x86_64-15.0.30.tar.gz
$NEW_ARM  tor-expert-bundle-macos-aarch64-15.0.30.tar.gz
$NEW_X86  tor-expert-bundle-macos-x86_64-15.0.30.tar.gz
EOF
echo sig > "$FAKE_SERVE/sha256sums-signed-build.txt.asc"
write_lock "$GOOD_SHA"
cp "$LOCK" "$T/lock.before"

FAKE_FPR=0000000000000000000000000000000000000000 bash "$PIN" 15.0.30 0.4.9.15 >/dev/null 2>"$T/err"
code=$?
check "another key's signature: exit 1" "[ $code -eq 1 ]"
check "another key's signature: says so" "grep -q 'no valid signature' '$T/err'"
check "another key's signature: lock unchanged" "cmp -s '$LOCK' '$T/lock.before'"

FAKE_FPR="" bash "$PIN" 15.0.30 0.4.9.15 >/dev/null 2>"$T/err"
code=$?
check "bad signature (gpg fails): exit 1 with a reason" "[ $code -eq 1 ] && grep -q 'no valid signature' '$T/err'"
check "bad signature: lock unchanged" "cmp -s '$LOCK' '$T/lock.before'"

grep -v macos-x86_64 "$FAKE_SERVE/sha256sums-signed-build.txt" > "$T/partial" && cp "$T/partial" "$FAKE_SERVE/sha256sums-signed-build.txt"
FAKE_FPR=EF6E286DDA85EA2A4BA7DE684E2C6E8793298290 bash "$PIN" 15.0.30 0.4.9.15 >/dev/null 2>&1
code=$?
check "a platform missing from the list: exit 1, lock unchanged" "[ $code -eq 1 ] && cmp -s '$LOCK' '$T/lock.before'"
echo "$NEW_X86  tor-expert-bundle-macos-x86_64-15.0.30.tar.gz" >> "$FAKE_SERVE/sha256sums-signed-build.txt"

FAKE_FPR=EF6E286DDA85EA2A4BA7DE684E2C6E8793298290 bash "$PIN" 15.0.30 0.4.9.15 >/dev/null 2>&1
code=$?
check "signed by the pinned key: exit 0" "[ $code -eq 0 ]"
check "signed: header kept" "head -1 '$LOCK' | grep -q '^# test lock'"
check "signed: new release pinned" "grep -q 'tor_browser_version: \"15.0.30\"' '$LOCK' && grep -q 'release_url: https://dist.torproject.org/torbrowser/15.0.30/' '$LOCK'"
check "signed: every platform's hash" "grep -q \"linux-x86_64: $NEW_LINUX\" '$LOCK' && grep -q \"macos-aarch64: $NEW_ARM\" '$LOCK' && grep -q \"macos-x86_64: $NEW_X86\" '$LOCK'"

# The two scripts agree on the format: fetch-bundle reads what update-pin wrote.
mkdir -p "$T/fixture2" && cp -R "$T/fixture/"* "$T/fixture2/"
(cd "$T/fixture2" && tar -czf "$T/tor-expert-bundle-linux-x86_64-15.0.30.tar.gz" tor data docs)
NEW_REAL="$(sha256_of "$T/tor-expert-bundle-linux-x86_64-15.0.30.tar.gz")"
sed "s/linux-x86_64: $NEW_LINUX/linux-x86_64: $NEW_REAL/" "$LOCK" > "$T/lock2" && cp "$T/lock2" "$LOCK"
cp "$T/tor-expert-bundle-linux-x86_64-15.0.30.tar.gz" "$T/repo/obj/tor-bundle/"
bash "$FETCH" >/dev/null 2>&1
code=$?
check "fetch-bundle reads update-pin's lock" "[ $code -eq 0 ] && grep -q '\"tor_browser_version\": \"15.0.30\"' '$BIN/tor/aequera-tor-bundle.json'"

echo "# $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
