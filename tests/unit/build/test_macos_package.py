"""Checks for the macOS packaging script and its CI entry point.

    python -m unittest discover -s tests/unit/build

The script itself runs only on macOS (hdiutil, codesign), so these tests
cover what every host can check: shell syntax, the help/error contract, and
that the workflow invokes the packager. The macOS runner's actual package
step is the integration proof.
"""

import os
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "tools" / "build" / "macos" / "package.sh"
DEREFERENCE = ROOT / "tools" / "build" / "macos" / "dereference_bundle.py"
VERIFY = ROOT / "tools" / "build" / "macos" / "verify_packaged_app.py"
MOZCONFIG = ROOT / "tools" / "build" / "macos" / "mozconfig"
WORKFLOW = ROOT / ".github" / "workflows" / "macos.yml"


def find_bash():
    found = shutil.which("bash")
    if os.name != "nt":
        return found
    # On Windows, PATH may name WSL's launcher (System32, WindowsApps) first;
    # use the bash that ships with Git instead.
    if found and "system32" not in found.lower() and "windowsapps" not in found.lower():
        return found
    git = shutil.which("git")
    if git:
        candidate = Path(git).resolve().parents[1] / "bin" / "bash.exe"
        if candidate.is_file():
            return str(candidate)
    return None


BASH = find_bash()


@unittest.skipUnless(BASH, "needs bash (Git Bash or MozillaBuild on Windows)")
class MacosPackage(unittest.TestCase):
    def run_script(self, *args):
        return subprocess.run(
            [BASH, SCRIPT.as_posix(), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_script_parses(self):
        result = subprocess.run(
            [BASH, "-n", SCRIPT.as_posix()],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_help_works_without_running_the_packager(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--app", result.stderr)
        self.assertIn("--out-dir", result.stderr)

    def test_unknown_argument_is_rejected(self):
        result = self.run_script("--not-an-option")
        self.assertEqual(result.returncode, 2)
        self.assertIn("unknown argument", result.stderr)

    @unittest.skipIf(platform.system() == "Darwin", "macOS is the supported host")
    def test_other_hosts_fail_with_the_reason(self):
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("macOS only", result.stderr)

    def test_workflow_uses_the_packager(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("tools/build/macos/package.sh", text)
        self.assertIn("macos-15", text)
        self.assertIn("macos-15-intel", text)
        # Building dist/Aequera.app is not enough: mach package strips the
        # developer plist paths and writes the omni.jars.
        self.assertIn("./mach package", text)
        self.assertIn("dist/firefox/Aequera.app", text)

    def test_macos_mozconfig_skips_machs_dmg_layout(self):
        text = MOZCONFIG.read_text(encoding="utf-8")
        # mach's DMG path expects Mozilla's branding dsstore. Aequera's
        # packager creates the DMG from its own layout, so mach must not fail
        # on the missing file before package.sh can run.
        self.assertIn("export MOZ_PKG_FORMAT=ZIP", text)

    def make_app(self, root, *, developer_paths=False, omni=True, browser_omni=True):
        app = Path(root) / "Aequera.app"
        contents = app / "Contents"
        resources = contents / "Resources"
        (resources / "browser").mkdir(parents=True)
        (contents / "MacOS").mkdir()
        info = {
            "CFBundleExecutable": "firefox",
            "CFBundleIdentifier": "org.aequera.browser",
        }
        if developer_paths:
            info["MozillaDeveloperRepoPath"] = "/build/repo"
            info["MozillaDeveloperObjPath"] = "/build/obj"
        with (contents / "Info.plist").open("wb") as stream:
            plistlib.dump(info, stream)
        if omni:
            (resources / "omni.ja").write_bytes(b"gre")
        if browser_omni:
            (resources / "browser" / "omni.ja").write_bytes(b"browser")
        return app

    def run_verify(self, app):
        return subprocess.run(
            [sys.executable, VERIFY.as_posix(), app.as_posix()],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_verify_accepts_mach_packaged_app(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = self.make_app(tmp)
            result = self.run_verify(app)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_verify_rejects_unpackaged_developer_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = self.make_app(
                tmp, developer_paths=True, omni=False, browser_omni=False
            )
            result = self.run_verify(app)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("omni.ja", result.stderr)
            self.assertIn("MozillaDeveloperRepoPath", result.stderr)
            self.assertIn("./mach package", result.stderr)

    def test_verify_rejects_missing_browser_omnijar(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = self.make_app(tmp, browser_omni=False)
            result = self.run_verify(app)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("browser/omni.ja", result.stderr)

    def test_packager_uses_mach_package_output_and_content_smoke(self):
        text = SCRIPT.read_text(encoding="utf-8")
        self.assertIn("verify_packaged_app.py", text)
        self.assertIn("dist/firefox", text)
        self.assertIn("dist/aequera", text)
        self.assertIn("--headless", text)
        self.assertIn("--screenshot", text)
        self.assertNotIn("smoke-testing the bundle (--version)", text)
        # The old default was the developer bundle; never select it again.
        self.assertNotIn('"$ROOT/obj/firefox/artifact/dist/Aequera.app"', text)

    @unittest.skipIf(os.name == "nt", "creating symlinks needs extra privileges")
    def test_dereference_materializes_only_escaping_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Aequera.app"
            contents = root / "Contents"
            contents.mkdir(parents=True)
            (contents / "inside.txt").write_text("inside", encoding="utf-8")
            external = Path(tmp) / "ChannelPrefs"
            external.write_text("binary", encoding="utf-8")
            os.symlink(external, contents / "outside")
            os.symlink("inside.txt", contents / "inside")

            result = subprocess.run(
                [sys.executable, DEREFERENCE.as_posix(), root.as_posix()],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((contents / "outside").is_symlink())
            self.assertEqual(
                (contents / "outside").read_text(encoding="utf-8"), "binary"
            )
            self.assertTrue((contents / "inside").is_symlink())

    def test_packager_resigns_nested_bundles_from_the_inside_out(self):
        text = SCRIPT.read_text(encoding="utf-8")
        loop = text.index("while IFS= read -r -d '' nested; do")
        find = text.index('done < <(find "$STAGED/Contents" -depth')
        dereference = text.index(
            'python3 "$ROOT/tools/build/macos/dereference_bundle.py" "$STAGED"'
        )
        outer = text.index('codesign --force --sign - "$STAGED"')
        launcher = text.index('codesign --force --sign - "$LAUNCHER"')
        self.assertLess(dereference, outer)
        self.assertLess(loop, find)
        self.assertLess(find, outer)
        self.assertLess(launcher, outer)
        self.assertIn("-name '*.app'", text)
        self.assertIn("-name '*.framework'", text)


if __name__ == "__main__":
    unittest.main()
