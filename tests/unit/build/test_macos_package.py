"""Checks for the macOS packaging script and its CI entry point.

    python -m unittest discover -s tests/unit/build

The script itself runs only on macOS (hdiutil, codesign), so these tests
cover what every host can check: shell syntax, the help/error contract, and
that the workflow invokes the packager. The macOS runner's actual package
step is the integration proof.
"""

import os
import platform
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "tools" / "build" / "macos" / "package.sh"
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


if __name__ == "__main__":
    unittest.main()
