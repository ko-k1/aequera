#!/bin/bash
# Package a mach-packaged Aequera.app as a macOS disk image (DMG) and a zip
# of the bundle. The app is ad-hoc signed, not Developer ID signed or
# notarized. Runs on macOS only (hdiutil, codesign, plutil).
#
#   bash tools/build/macos/package.sh [options]
#
# Options:
#   --app <path>       packaged app (default: a dist/<pkg>/*.app in obj/)
#   --out-dir <dir>    output directory (default: obj/macos/package)
#   --version <text>   artifact version (default: upstream/manifests/firefox.lock)
#   --no-check         skip the launch smoke test
#   -h, --help         show this help
#
# Run ./mach package in worktree/firefox first. mach's build output,
# dist/Aequera.app, is a developer bundle: it has no omni.ja and keeps the
# build machine's MozillaDeveloperRepoPath/MozillaDeveloperObjPath entries.
# Firefox then treats it as unpackaged and crashes on the first content
# process launch. ./mach package creates dist/firefox/Aequera.app with the
# omni.jars and without those entries; this script refuses anything else.
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

Package a mach-packaged Aequera.app as an ad-hoc-signed DMG and ZIP.

Run ./mach package in worktree/firefox first; the developer bundle in
dist/Aequera.app is not distributable.

Options:
  --app <path>       packaged app (default: a packaged app under obj/.../dist/*/*.app)
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
# the generated objdirs. The package staging directory is named after
# MOZ_APP_NAME: "firefox" for the artifact build (it runs Mozilla's prebuilt
# binary), "aequera" for a compiled build. The app bundle name follows
# MOZ_APP_DISPLAYNAME, so a branding mismatch can leave Firefox.app. Only
# dist/<package-dir>/*.app is considered: dist/*.app itself is mach's
# unpackaged developer bundle. The explicit profiles keep a stale build of
# the other profile from winning over the profile that exists.
if [ -z "$APP" ]; then
  for dist in \
    "$ROOT/obj/firefox/artifact/dist" \
    "$ROOT/obj/firefox/compiled/dist" \
    "$ROOT"/obj/*/*/dist; do
    for package_dir in "$dist/firefox" "$dist/aequera" "$dist"/*; do
      [ -d "$package_dir" ] || continue
      case "$(basename "$package_dir")" in
        *.app) continue ;;
      esac
      for candidate in "$package_dir"/*.app; do
        if [ -d "$candidate/Contents/MacOS" ]; then
          APP="$candidate"
          break 3
        fi
      done
    done
  done
fi
[ -n "$APP" ] || die "no mach-packaged app found; run ./mach package in worktree/firefox, then retry or pass --app dist/<package-dir>/Aequera.app."
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

# browser/app/macbuild/Contents/moz.build is build metadata that
# assemble_macos_bundle copies into the app. It is not app content, and
# codesign treats files directly in Contents as unsigned subcomponents.
rm -f "$STAGED/Contents/moz.build"

# mach's default NSDISTMODE=absolute_symlink leaves files in the bundle
# pointing back into the objdir. Materialize those links so the app is
# self-contained and codesign does not see a symlinked framework executable.
python3 "$ROOT/tools/build/macos/dereference_bundle.py" "$STAGED"

# dist/Aequera.app (mach build output) is not distributable: it lacks the
# omni.jars and still points at the CI/local repo and objdirs. Running it on
# another Mac crashes in ContentParent::BeginSubprocessLaunch when the first
# content process asks for those paths. Only dist/firefox/Aequera.app, made by
# ./mach package, is accepted.
python3 "$ROOT/tools/build/macos/verify_packaged_app.py" "$STAGED"

EXE="$(plutil -extract CFBundleExecutable raw -o - "$PLIST")" \
  || die "Info.plist has no CFBundleExecutable"
[ -n "$EXE" ] || die "Info.plist has an empty CFBundleExecutable"
[ "$EXE" != "aequera-launch" ] \
  || die "$APP already has the packaging launcher (CFBundleExecutable=aequera-launch); pass the mach package output instead."
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
# The artifact build signs each Mach-O while extracting it, which also
# invalidates the signature of every nested bundle that seals those binaries
# (updater.app, crashreporter.app, plugin-container.app, ChannelPrefs.framework,
# UpdateSettings.framework). Re-sign those bundles from the inside out. Avoid
# --deep: it would re-sign helper executables too and drop their entitlements.
find "$STAGED" -name .DS_Store -delete 2>/dev/null || true
xattr -cr "$STAGED" 2>/dev/null || true
while IFS= read -r -d '' nested; do
  codesign --force --sign - "$nested"
done < <(find "$STAGED/Contents" -depth -type d \
  \( -name '*.app' -o -name '*.framework' -o -name '*.appex' -o -name '*.xpc' \) \
  -print0)
# A script's signature lives in an extended attribute; sign the launcher
# before the outer bundle seal so verification can see it.
codesign --force --sign - "$LAUNCHER"
codesign --force --sign - "$STAGED"
codesign --verify --deep --strict "$STAGED"

if [ "$CHECK" -eq 1 ]; then
  command -v perl >/dev/null 2>&1 || die "perl not found on PATH (or pass --no-check)"
  command -v file >/dev/null 2>&1 || die "file not found on PATH (or pass --no-check)"
  echo "package: smoke-testing the bundle (headless content process)"
  # --version only exercises the parent process, which is why the old
  # smoke test passed the broken developer bundle. A headless screenshot
  # creates a remote browser, so it must launch a content process and flush
  # its sandbox parameters before it can write the image.
  #
  # macOS has no timeout(1); perl's alarm keeps a broken launch from hanging
  # the CI job. A throwaway HOME and profile keep the check away from a real
  # browser session.
  mkdir -p "$WORK/home" "$WORK/profile" "$WORK/smoke"
  screenshot="$WORK/smoke/aequera-package.png"
  if ! HOME="$WORK/home" perl -e 'alarm 240; exec @ARGV' \
      "$LAUNCHER" --headless --profile "$WORK/profile" \
      --screenshot "$screenshot" \
      'data:text/html,<title>Aequera package smoke test</title><h1>ok</h1>' \
      >"$WORK/smoke.log" 2>&1; then
    sed -n '1,120p' "$WORK/smoke.log" >&2 || true
    die "bundle did not complete a headless content-process launch"
  fi
  [ -s "$screenshot" ] || {
    sed -n '1,120p' "$WORK/smoke.log" >&2 || true
    die "headless screenshot was not written: $screenshot"
  }
  if ! file "$screenshot" | grep -q 'PNG image data'; then
    sed -n '1,120p' "$WORK/smoke.log" >&2 || true
    die "headless screenshot is not a PNG: $screenshot"
  fi
  echo "package: headless content-process smoke test passed"
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
