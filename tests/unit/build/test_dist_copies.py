"""Tests for tools/build/dist_copies.py (Windows dev builds: dist links -> copies).

    python -m unittest discover -s tests/unit/build

Symlink creation needs a privilege on Windows (Developer Mode or admin); the
tests that need links skip themselves where the host cannot make them.
"""

import os
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
TOOL = os.path.join(ROOT, "tools", "build", "dist_copies.py")
sys.path.insert(0, os.path.dirname(TOOL))

import dist_copies  # noqa: E402


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class DistCopiesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.src = os.path.join(self.root, "src")
        self.bin = os.path.join(self.root, "obj", "dist", "bin")
        os.makedirs(self.bin)
        write(os.path.join(self.src, "addon", "content.js"), "content")
        write(os.path.join(self.src, "gen", "PromiseWorker.js"), "worker")

    def tearDown(self):
        self.tmp.cleanup()

    def link(self, target, rel):
        dest = os.path.join(self.bin, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        try:
            os.symlink(target, dest)
        except (OSError, NotImplementedError) as e:
            self.skipTest(f"host cannot create symlinks: {e}")
        return dest

    def test_replaces_file_links_with_copies_of_their_targets(self):
        a = self.link(os.path.join(self.src, "addon", "content.js"), "builtin-addons/adveil/content.js")
        b = self.link(os.path.join(self.src, "gen", "PromiseWorker.js"), "modules/workers/PromiseWorker.js")

        result = dist_copies.replace_links(self.bin)

        self.assertEqual(result, (2, ()))
        for path, text in ((a, "content"), (b, "worker")):
            self.assertFalse(os.path.islink(path))
            self.assertEqual(read(path), text)

    def test_copy_keeps_the_target_mtime(self):
        target = os.path.join(self.src, "addon", "content.js")
        os.utime(target, (1_700_000_000, 1_700_000_000))
        dest = self.link(target, "content.js")

        dist_copies.replace_links(self.bin)

        self.assertEqual(int(os.path.getmtime(dest)), 1_700_000_000)

    def test_second_run_finds_nothing_and_leaves_sources_alone(self):
        self.link(os.path.join(self.src, "addon", "content.js"), "content.js")
        dist_copies.replace_links(self.bin)

        self.assertEqual(dist_copies.replace_links(self.bin).copied, 0)
        self.assertEqual(read(os.path.join(self.src, "addon", "content.js")), "content")

    def test_leaves_regular_files_untouched(self):
        plain = os.path.join(self.bin, "application.ini")
        write(plain, "[App]")

        self.assertEqual(dist_copies.replace_links(self.bin).copied, 0)
        self.assertEqual(read(plain), "[App]")

    def test_dangling_link_is_reported_and_kept_while_the_rest_are_copied(self):
        dest = self.link(os.path.join(self.src, "missing.js"), "missing.js")
        good = self.link(os.path.join(self.src, "addon", "content.js"), "sub/content.js")

        result = dist_copies.replace_links(self.bin)

        self.assertEqual(result.copied, 1)
        self.assertEqual(result.dangling, (dest,))
        self.assertTrue(os.path.islink(dest))
        self.assertFalse(os.path.islink(good))

    def test_copies_links_in_nested_real_directories(self):
        deep = self.link(os.path.join(self.src, "addon", "content.js"), "a/b/c/content.js")

        self.assertEqual(dist_copies.replace_links(self.bin).copied, 1)
        self.assertEqual(read(deep), "content")

    def test_copy_of_a_read_only_source_stays_writable(self):
        target = os.path.join(self.src, "addon", "content.js")
        os.chmod(target, stat.S_IREAD)
        try:
            dest = self.link(target, "content.js")

            dist_copies.replace_links(self.bin)

            self.assertTrue(os.access(dest, os.W_OK))
            os.remove(dest)
        finally:
            os.chmod(target, stat.S_IREAD | stat.S_IWRITE)

    def test_failed_copy_leaves_the_link_and_no_temp_file(self):
        dest = self.link(os.path.join(self.src, "addon", "content.js"), "content.js")
        real_copy = dist_copies.shutil.copy2

        def broken(*_args, **_kwargs):
            raise OSError("disk full")

        dist_copies.shutil.copy2 = broken
        try:
            with self.assertRaises(OSError):
                dist_copies.replace_links(self.bin)
        finally:
            dist_copies.shutil.copy2 = real_copy

        self.assertTrue(os.path.islink(dest))
        self.assertEqual(os.listdir(self.bin), ["content.js"])

    def test_does_not_follow_directory_links(self):
        os.makedirs(os.path.join(self.src, "dirtarget"))
        write(os.path.join(self.src, "dirtarget", "inner.js"), "inner")
        dest = os.path.join(self.bin, "linkeddir")
        try:
            os.symlink(os.path.join(self.src, "dirtarget"), dest, target_is_directory=True)
        except (OSError, NotImplementedError) as e:
            self.skipTest(f"host cannot create symlinks: {e}")

        self.assertEqual(dist_copies.replace_links(self.bin).copied, 0)
        self.assertTrue(os.path.islink(dest))
        self.assertEqual(read(os.path.join(self.src, "dirtarget", "inner.js")), "inner")

    def test_refuses_a_directory_that_is_not_dist_bin(self):
        with self.assertRaises(ValueError):
            dist_copies.replace_links(self.src)

    def test_cli_is_a_no_op_off_windows_unless_forced(self):
        self.link(os.path.join(self.src, "addon", "content.js"), "content.js")
        run = subprocess.run([sys.executable, TOOL, self.bin], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        on_windows = sys.platform in ("win32", "cygwin", "msys")
        self.assertEqual(os.path.islink(os.path.join(self.bin, "content.js")), not on_windows)

        forced = subprocess.run(
            [sys.executable, TOOL, "--any-os", self.bin], capture_output=True, text=True
        )
        self.assertEqual(forced.returncode, 0, forced.stderr)
        self.assertFalse(os.path.islink(os.path.join(self.bin, "content.js")))

    def test_cli_warns_about_dangling_links_without_failing(self):
        self.link(os.path.join(self.src, "missing.js"), "missing.js")
        run = subprocess.run(
            [sys.executable, TOOL, "--any-os", self.bin], capture_output=True, text=True
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("warning: 1 links to missing files", run.stderr)

    def test_cli_reports_a_missing_directory(self):
        run = subprocess.run(
            [sys.executable, TOOL, "--any-os", os.path.join(self.root, "nope", "dist", "bin")],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("dist-copies:", run.stderr)


if __name__ == "__main__":
    unittest.main()
