"""Tests for the shell-chrome reference extension's manifest.

    python -m unittest discover -s tests/unit/build

aequera/extensions/shell-chrome is a manual proof (about:debugging), not a
packaged overlay, so nothing in the build compiles or packages it. Its
acceptance criteria from its README are enforced here instead: the manifest
parses, its minimum version tracks the lock, its permissions stay within the
documented set, its icons and background scripts resolve, and its sources
carry no network call sites.
"""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
EXT = ROOT / "aequera" / "extensions" / "shell-chrome"
LOCK = ROOT / "upstream" / "manifests" / "firefox.lock"

ALLOWED_PERMISSIONS = {"tabs", "sessions", "storage", "history", "bookmarks"}


class ShellChromeManifest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))

    def test_min_version_tracks_the_lock(self):
        match = re.search(r'^  version: "([^"]+)"$', LOCK.read_text(encoding="utf-8"), re.MULTILINE)
        self.assertIsNotNone(match, "no upstream version in firefox.lock")
        gecko = self.manifest["browser_specific_settings"]["gecko"]
        self.assertEqual(gecko["strict_min_version"], match.group(1))
        self.assertEqual(gecko["id"], "shell-chrome@aequera")
        self.assertEqual(self.manifest["manifest_version"], 2)

    def test_permissions_stay_within_the_documented_set(self):
        self.assertLessEqual(set(self.manifest["permissions"]), ALLOWED_PERMISSIONS)

    def test_icons_and_background_scripts_resolve(self):
        for size, icon in self.manifest["icons"].items():
            path = EXT / icon
            self.assertTrue(path.is_file(), icon)
            self.assertEqual(path.read_bytes()[:8], b"\x89PNG\r\n\x1a\n", icon)
        for script in self.manifest["background"]["scripts"]:
            self.assertTrue((EXT / script).is_file(), script)

    def test_sources_have_no_network_call_sites(self):
        for script in (EXT / "src").glob("*.js"):
            if script.name.endswith(".test.js"):
                continue
            text = script.read_text(encoding="utf-8")
            for sink in ("fetch(", "new XMLHttpRequest", "new WebSocket", "sendBeacon("):
                self.assertNotIn(sink, text, f"{script.name} uses {sink}")


if __name__ == "__main__":
    unittest.main()
