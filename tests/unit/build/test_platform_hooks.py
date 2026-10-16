"""Tests for the per-OS hooks of the POSIX build tooling.

    python -m unittest discover -s tests/unit/build

tools/build/common/host.sh maps the host to windows, macos, or linux and
sources tools/build/<os>/platform.sh; the shared launchers and test gate call
only the hooks it documents. These tests check that every platform defines
the whole contract, that the host mapping is right, and that each platform
picks the binary and launch ini its builds use. Every platform is exercised
on every host (uname is stubbed), so a change for one OS is checked on all
three CI runners.

Needs bash: Git Bash or MozillaBuild on Windows (never WSL's bash, which
cannot see Windows paths); skipped where none is found.
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BUILD = ROOT / "tools" / "build"
PLATFORMS = {"windows": "MINGW64_NT-10.0-26200", "macos": "Darwin", "linux": "Linux"}
HOOKS = (
    "aequera_platform_native_exes",
    "aequera_platform_artifact_exes",
    "aequera_platform_launch_ini",
    "aequera_to_native",
    "aequera_platform_prepare_dist",
    "aequera_platform_test_prefs",
)


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


def posix(path):
    return Path(path).as_posix()


@unittest.skipUnless(BASH, "needs bash (Git Bash or MozillaBuild on Windows)")
class PlatformHooks(unittest.TestCase):
    def run_host(self, host_uname, script):
        """Runs script with host.sh loaded for a host whose uname is host_uname."""
        prelude = (
            "set -euo pipefail\n"
            f"uname() {{ echo '{host_uname}'; }}\n"
            f"ROOT='{posix(ROOT)}'\n"
            "LAUNCHER=test\n"
            '. "$ROOT/tools/build/common/host.sh"\n'
        )
        return subprocess.run(
            [BASH, "-c", prelude + script],
            capture_output=True,
            text=True,
            check=False,
        )

    def run_platform(self, name, script):
        result = self.run_host(PLATFORMS[name], "aequera_load_platform\n" + script)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_host_mapping(self):
        cases = {
            "MINGW64_NT-10.0-26200": "windows",
            "MSYS_NT-10.0": "windows",
            "CYGWIN_NT-10.0": "windows",
            "Darwin": "macos",
            "Linux": "linux",
        }
        for uname, host in cases.items():
            with self.subTest(uname=uname):
                result = self.run_host(uname, "aequera_host")
                self.assertEqual(result.stdout.strip(), host, result.stderr)

    def test_unsupported_host_fails_with_a_message(self):
        result = self.run_host("FreeBSD", "aequera_load_platform")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported host 'FreeBSD'", result.stderr)

    def test_every_platform_defines_the_whole_contract(self):
        for name in PLATFORMS:
            with self.subTest(platform=name):
                missing = self.run_platform(
                    name,
                    'echo "$AEQUERA_HOST"\n'
                    + "".join(f"declare -F {h} >/dev/null || echo missing {h}\n" for h in HOOKS),
                ).split()
                self.assertEqual(missing, [name])

    def test_every_platform_has_a_mozconfig_fragment(self):
        for name in PLATFORMS:
            with self.subTest(platform=name):
                self.assertTrue((BUILD / name / "mozconfig").is_file())
                self.assertIn(f"tools/build/{name}/mozconfig", (BUILD / "mozconfig.platform").read_text())

    def test_only_windows_adds_test_prefs(self):
        prefs = {name: self.run_platform(name, "aequera_platform_test_prefs").split() for name in PLATFORMS}
        self.assertEqual(prefs["windows"], ["--setpref", "widget.windows.mica=false"])
        self.assertEqual(prefs["linux"], [])
        self.assertEqual(prefs["macos"], [])

    def test_prepare_dist_is_a_no_op_off_windows(self):
        for name in ("linux", "macos"):
            with self.subTest(platform=name):
                self.assertEqual(self.run_platform(name, "aequera_platform_prepare_dist /nonexistent"), "")


@unittest.skipUnless(BASH, "needs bash (Git Bash or MozillaBuild on Windows)")
class FindExe(unittest.TestCase):
    """The launchers' binary choice (launch-common.sh) per platform."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.objdir = Path(self.tmp.name) / "obj"

    def tearDown(self):
        self.tmp.cleanup()

    def binary(self, rel):
        path = self.objdir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        # A shebang makes the file executable to MSYS too, where chmod alone
        # does not.
        path.write_text("#!/bin/sh\n", encoding="utf-8")
        path.chmod(0o755)
        return path

    def find(self, name):
        script = (
            "set -euo pipefail\n"
            f"uname() {{ echo '{PLATFORMS[name]}'; }}\n"
            f"ROOT='{posix(ROOT)}'\n"
            "LAUNCHER=test\n"
            '. "$ROOT/tools/build/common/launch-common.sh"\n'
            f"OBJDIR='{posix(self.objdir)}'\n"
            "aequera_find_exe\n"
            'aequera_platform_launch_ini "$EXE" "$OBJDIR/dist/bin"\n'
            'printf "%s\\n" "$EXE" "$SRC_INI" "$INI" "$RESOURCES"\n'
        )
        result = subprocess.run([BASH, "-c", script], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        exe, src_ini, ini, resources = result.stdout.split("\n")[:4]
        base = posix(self.objdir) + "/"
        strip = lambda p: p[len(base):] if p.startswith(base) else p  # noqa: E731
        return strip(exe), strip(src_ini), strip(ini), strip(resources)

    def test_linux_prefers_the_compiled_binary(self):
        self.binary("dist/bin/firefox")
        self.assertEqual(self.find("linux")[0], "dist/bin/firefox")
        self.binary("dist/bin/aequera")
        self.assertEqual(
            self.find("linux"),
            ("dist/bin/aequera", "dist/bin/application.ini", "dist/bin/browser/aequera-application.ini", ""),
        )

    def test_windows_prefers_the_compiled_binary(self):
        self.binary("dist/bin/firefox.exe")
        self.assertEqual(self.find("windows")[0], "dist/bin/firefox.exe")
        self.binary("dist/bin/aequera.exe")
        self.assertEqual(
            self.find("windows"),
            ("dist/bin/aequera.exe", "dist/bin/application.ini", "dist/bin/browser/aequera-application.ini", ""),
        )

    def test_macos_bundle_keeps_the_launch_ini_in_resources(self):
        self.binary("dist/Firefox.app/Contents/MacOS/firefox")
        self.assertEqual(
            self.find("macos"),
            (
                "dist/Firefox.app/Contents/MacOS/firefox",
                "dist/Firefox.app/Contents/Resources/application.ini",
                "dist/Firefox.app/Contents/Resources/browser/aequera-application.ini",
                "dist/Firefox.app/Contents/Resources",
            ),
        )

    def test_macos_prefers_the_aequera_bundle(self):
        self.binary("dist/Firefox.app/Contents/MacOS/firefox")
        self.binary("dist/Aequera.app/Contents/MacOS/aequera")
        self.assertEqual(self.find("macos")[0], "dist/Aequera.app/Contents/MacOS/aequera")


if __name__ == "__main__":
    unittest.main()
