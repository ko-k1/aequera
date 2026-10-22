#!/bin/bash
# Package a built Aequera.app as a macOS disk image (DMG) and a zip of the
# bundle. The app is ad-hoc signed, not Developer ID signed or notarized.
# Runs on macOS only (hdiutil, codesign, plutil).
#
#   bash tools/build/macos/package.sh [options]
#
# Options:
#   --app <path>       app bundle (default: the build's dist/*.app in obj/)
#   --out-dir <dir>    output directory (default: obj/macos/package)
#   --version <text>   artifact version (default: upstream/manifests/firefox.lock)
#   --no-check         skip the launch smoke test
#   -h, --help         show this help
#
# The artifact build runs Mozilla's prebuilt Firefox binary. It keeps
# Firefox's compiled-in identity unless started with -app, which would make a
# double-clicked app join a running Firefox and open Firefox's profile. The
# staged bundle therefore gets a small launcher as CFBundleExecutable that
# starts the real binary with Aequera's launch ini. Apart from the launcher,
# the launch ini, and the ad-hoc signature, the build output is unchanged.
#
# Signing is ad-hoc: the app runs locally, but Gatekeeper blocks it after
# download on another Mac until the user explicitly opens it. A release needs a
# Developer ID signature and notarization; that belongs to the release
# pipeline, not this build artifact.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

usage() {
  cat >&2 <<'EOF'
usage: tools/build/macos/package.sh [options]

Package a built Aequera.app as an unsigned DMG and ZIP.

Options:
  --app <path>       app bundle (default: obj/firefox/{artifact,compiled}/dist/*.app)
  --out-dir <dir>    output directory (default: obj/macos/package)
  --version <text>   artifact version (default: upstream/manifests/firefox.lock)
  --no-check         skip the launch smoke test
  -h, --help         show this help
EOF
}

die() {
  echo "package: $*" >&2
  exit 1
}

APP=""
OUT_DIR=""
VERSION=""
CHECK=1

while [ $# -gt 0 ]; do
  case "$1" in
    --app)
      [ $# -ge 2 ] || { usage; exit 2; }
      APP="$2"
      shift 2
      ;;
    --out-dir)
      [ $# -ge 2 ] || { usage; exit 2; }
      OUT_DIR="$2"
      shift 2
      ;;
    --version)
      [ $# -ge 2 ] || { usage; exit 2; }
      VERSION="$2"
      shift 2
      ;;
    --no-check)
      CHECK=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "package: unknown argument '$1'" >&2
      usage
      exit 2
      ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || die "macOS only; run this on a Mac or the macOS CI runner."

for tool in hdiutil ditto codesign plutil shasum python3; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
done

# Default to the artifact build, then a compiled build, then any bundle under
# the generated objdirs (the bundle name follows MOZ_APP_DISPLAYNAME, so a
# mismatch in branding can leave Firefox.app). The explicit patterns keep a
# stale build of the other profile from winning over the profile that exists.
if [ -z "$APP" ]; then
  for candidate in \
    "$ROOT/obj/firefox/artifact/dist/Aequera.app" \
    "$ROOT/obj/firefox/compiled/dist/Aequera.app" \
    "$ROOT"/obj/*/*/dist/Aequera.app; do
    if [ -d "$candidate" ]; then
      APP="$candidate"
      break
    fi
  done
fi
if [ -z "$APP" ]; then
  for candidate in \
    "$ROOT"/obj/firefox/artifact/dist/*.app \
    "$ROOT"/obj/firefox/compiled/dist/*.app \
    "$ROOT"/obj/*/*/dist/*.app; do
    if [ -d "$candidate/Contents/MacOS" ]; then
      APP="$candidate"
      break
    fi
  done
fi
[ -n "$APP" ] || die "no built app bundle found; build first (tools/build/README.md) or pass --app."
case "$APP" in
  /*) ;;
  *) APP="$PWD/$APP" ;;
esac
[ -d "$APP" ] || die "app bundle not found: $APP"
[ -f "$APP/Contents/Info.plist" ] || die "not an app bundle (no Contents/Info.plist): $APP"
[ -d "$APP/Contents/MacOS" ] || die "app bundle has no Contents/MacOS: $APP"

if [ -z "$OUT_DIR" ]; then
  OUT_DIR="$ROOT/obj/macos/package"
fi
case "$OUT_DIR" in
  /*) ;;
  *) OUT_DIR="$PWD/$OUT_DIR" ;;
esac

if [ -z "$VERSION" ]; then
  VERSION="$(awk '
    /^upstream:/ { up = 1; next }
    up && /^  version:/ { gsub(/"/, "", $2); print $2; exit }
  ' "$ROOT/upstream/manifests/firefox.lock")"
fi
[ -n "$VERSION" ] || die "cannot read the upstream version from upstream/manifests/firefox.lock; pass --version."
# Keep output names portable: no spaces or path separators.
VERSION="$(printf '%s' "$VERSION" | LC_ALL=C tr -c 'A-Za-z0-9._-' '-')"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ARCH="aarch64" ;;
  x86_64) ;;
  *) die "unsupported host architecture '$ARCH'" ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/aequera-package.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

# Work on a copy: the objdir stays exactly as mach left it, and a rerun
# never packages a launcher into a launcher.
STAGED="$WORK/Aequera.app"
ditto "$APP" "$STAGED"
MACOS="$STAGED/Contents/MacOS"
RESOURCES="$STAGED/Contents/Resources"
PLIST="$STAGED/Contents/Info.plist"

EXE="$(plutil -extract CFBundleExecutable raw -o - "$PLIST")" \
  || die "Info.plist has no CFBundleExecutable"
[ -n "$EXE" ] || die "Info.plist has an empty CFBundleExecutable"
[ "$EXE" != "aequera-launch" ] \
  || die "$APP is already packaged (CFBundleExecutable=aequera-launch); pass the build output instead."
[ -f "$MACOS/$EXE" ] || die "CFBundleExecutable '$EXE' is missing from Contents/MacOS"

BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw -o - "$PLIST" 2>/dev/null || true)"
case "$BUNDLE_ID" in
  org.aequera.*) ;;
  *) echo "package: warning: unexpected CFBundleIdentifier '${BUNDLE_ID:-missing}'" >&2 ;;
esac

# The build writes the identity into application.ini (mozconfig.branding and
# patches/build/branding). The bundle carries it in Resources; keep dist/bin
# as a fallback for a bundle that has not staged it.
if [ -f "$RESOURCES/application.ini" ]; then
  SRC_INI="$RESOURCES/application.ini"
elif [ -f "$(dirname "$APP")/bin/application.ini" ]; then
  SRC_INI="$(dirname "$APP")/bin/application.ini"
else
  die "no application.ini in the bundle or next to it; is this a built Aequera.app?"
fi
mkdir -p "$RESOURCES/browser"
python3 "$ROOT/tools/build/common/aequera_app_ini.py" \
  "$SRC_INI" "$RESOURCES/browser/aequera-application.ini"

# CFBundleExecutable points at this launcher instead of the Firefox binary.
# The launcher passes -app (Aequera identity: own profile, own remoting
# channel) and -no-remote (never hand off to a running Firefox).
LAUNCHER="$MACOS/aequera-launch"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
# Generated by tools/build/macos/package.sh. Start the bundled binary with
# Aequera's launch ini: the prebuilt binary of an artifact build otherwise
# uses Firefox's compiled-in identity and profile.
set -e
here=\$(CDPATH= cd "\$(dirname "\$0")" && pwd)
app=\$(CDPATH= cd "\$here/.." && pwd)
ini="\$app/Resources/browser/aequera-application.ini"
[ -f "\$ini" ] || { echo "Aequera: missing \$ini" >&2; exit 1; }
exec "\$here/$EXE" -app "\$ini" -no-remote "\$@"
EOF
chmod 755 "$LAUNCHER"
plutil -replace CFBundleExecutable -string aequera-launch "$PLIST"
[ "$(plutil -extract CFBundleExecutable raw -o - "$PLIST")" = "aequera-launch" ] \
  || die "could not point CFBundleExecutable at the launcher"

# Adding the launcher and rewriting the ini invalidates the outer signature.
# Re-sign only the bundle, not its nested helpers: --deep would re-sign them
# too and strip their entitlements (JIT/sandbox), while the helpers are
# unchanged. Verify the seal; the nested code keeps the build's signatures.
find "$STAGED" -name .DS_Store -delete 2>/dev/null || true
xattr -cr "$STAGED" 2>/dev/null || true
codesign --force --sign - "$STAGED"
codesign --verify --strict "$STAGED"

if [ "$CHECK" -eq 1 ]; then
  command -v perl >/dev/null 2>&1 || die "perl not found on PATH (or pass --no-check)"
  echo "package: smoke-testing the bundle (--version)"
  # macOS has no timeout(1); perl's alarm keeps a broken launch from hanging
  # the CI job. A throwaway HOME keeps --version from touching a real profile
  # if the binary decides to create one.
  mkdir -p "$WORK/home"
  version_output="$(
    HOME="$WORK/home" perl -e 'alarm 120; exec @ARGV' "$LAUNCHER" --version 2>&1
  )" || die "bundle did not start: $version_output"
  case "$version_output" in
    *Firefox*|*Aequera*) ;;
    *) die "unexpected --version output: $version_output" ;;
  esac
  printf 'package: %s\n' "$version_output"
fi

mkdir -p "$OUT_DIR"
BASE="Aequera-$VERSION-macos-$ARCH"
DMG="$OUT_DIR/$BASE.dmg"
ZIP="$OUT_DIR/$BASE.zip"

# A plain drag-to-Applications image. Finder window/background layout is
# release polish, not needed for a testable artifact.
DMG_STAGE="$WORK/dmg"
mkdir -p "$DMG_STAGE"
ditto "$STAGED" "$DMG_STAGE/Aequera.app"
ln -s /Applications "$DMG_STAGE/Applications"
hdiutil create -quiet -volname "Aequera $VERSION" -srcfolder "$DMG_STAGE" \
  -ov -format UDZO "$DMG"

ditto -c -k --sequesterRsrc --keepParent "$STAGED" "$ZIP"

(
  cd "$OUT_DIR"
  shasum -a 256 "$(basename "$DMG")" "$(basename "$ZIP")" > SHA256SUMS
)

echo "package: $DMG"
echo "package: $ZIP"
echo "package: $OUT_DIR/SHA256SUMS"
