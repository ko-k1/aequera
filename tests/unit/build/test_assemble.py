"""Tests for tools/patch/assemble.py's containment validation.

    python -m unittest discover -s tests/unit/build

_reject_diff_escape must refuse any diff whose target paths could write
outside worktree/firefox/ or into the repository's git directory, including
beyond the first hunk of a file section and through git's C-style path
quoting, while accepting plain `git diff` output.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools" / "patch"))

import assemble  # noqa: E402


def diff(*lines):
    return "\n".join(lines) + "\n"


def refuses(test, text):
    with test.assertRaises(SystemExit):
        assemble._reject_diff_escape(text, "test.diff")


def accepts(test, text):
    try:
        assemble._reject_diff_escape(text, "test.diff")
    except SystemExit as error:
        test.fail(f"refused: {error}")


OK = diff(
    "diff --git a/browser/foo.js b/browser/foo.js",
    "index 1111111..2222222 100644",
    "--- a/browser/foo.js",
    "+++ b/browser/foo.js",
    "@@ -1,3 +1,3 @@",
    " a",
    "-b",
    "+c",
    " d",
)


class RejectDiffEscape(unittest.TestCase):
    def test_accepts_plain_git_diff(self):
        accepts(self, OK)

    def test_accepts_second_file_with_headers(self):
        accepts(self, OK + diff(
            "diff --git a/added.txt b/added.txt",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/added.txt",
            "@@ -0,0 +1,1 @@",
            "+new",
        ))

    def test_refuses_header_after_first_hunk_without_diff_git(self):
        # A section for another file may omit its `diff --git` line; its
        # `---`/`+++` headers follow the first hunk's exhausted counts and
        # must still be validated.
        refuses(self, diff(
            "diff --git a/ok.txt b/ok.txt",
            "--- a/ok.txt",
            "+++ b/ok.txt",
            "@@ -1 +1 @@",
            "-x",
            "+y",
            "--- /dev/null",
            "+++ b/../evil.txt",
            "@@ -0,0 +1 @@",
            "+boom",
        ))

    def test_refuses_dev_null_bypass_to_traversal(self):
        refuses(self, diff(
            "diff --git a/ok.txt b/ok.txt",
            "--- /dev/null",
            "+++ b/../../evil.txt",
            "@@ -0,0 +1 @@",
            "+x",
        ))

    def test_refuses_traversal_in_diff_git_paths(self):
        for line in (
            "diff --git a/../evil b/../evil",
            "diff --git a/ok b/../../evil",
            "diff --git /abs/path b/abs/path",
            "diff --git a/C:/evil b/C:/evil",
            "diff --git a/a\\b b/a\\b",
        ):
            refuses(self, line + "\n")

    def test_refuses_git_directory_targets(self):
        for target in ("a/.git/config", "b/.git", "a/sub/.git/hooks/x", "a/.GIT/config"):
            refuses(self, diff(
                "diff --git a/ok.txt b/ok.txt",
                "--- /dev/null",
                f"+++ {target}",
                "@@ -0,0 +1 @@",
                "+x",
            ))

    def test_refuses_unterminated_quote_in_diff_git(self):
        refuses(self, 'diff --git "a/ok b/ok\n')

    def test_refuses_binary_sections(self):
        refuses(self, diff(
            "diff --git a/x.png b/x.png",
            "GIT binary patch",
            "literal 4",
        ))
        refuses(self, diff(
            "diff --git a/x.png b/x.png",
            "Binary files a/x.png and b/x.png differ",
        ))

    def test_refuses_hunk_count_mismatch(self):
        # A context line when the old side's count is exhausted cannot
        # belong to the hunk (git errs on it too).
        refuses(self, diff(
            "diff --git a/ok.txt b/ok.txt",
            "--- a/ok.txt",
            "+++ b/ok.txt",
            "@@ -1 +1 @@",
            "-x",
            " y",
        ))
        refuses(self, diff(
            "diff --git a/ok.txt b/ok.txt",
            "--- a/ok.txt",
            "+++ b/ok.txt",
            "@@ -x +1 @@",
            "-x",
            "+y",
        ))

    def test_hunk_content_shaped_like_headers_is_not_misread(self):
        accepts(self, diff(
            "diff --git a/ok.txt b/ok.txt",
            "--- a/ok.txt",
            "+++ b/ok.txt",
            "@@ -1,2 +1,1 @@",
            "-../evil",
            "--- ../evil",
            "+ok",
        ))

    def test_no_newline_marker_consumes_no_line(self):
        accepts(self, diff(
            "diff --git a/ok.txt b/ok.txt",
            "--- a/ok.txt",
            "+++ b/ok.txt",
            "@@ -1 +1 @@",
            "-x",
            "\\ No newline at end of file",
            "+y",
        ))


class Unquote(unittest.TestCase):
    def test_decodes_as_git_does(self):
        self.assertEqual(assemble._unquote('"a/my file"'), "a/my file")
        self.assertEqual(assemble._unquote('"a/tab\\tname"'), "a/tab\tname")
        self.assertEqual(assemble._unquote('"a/\\303\\251"'), "a/\u00e9")
        self.assertEqual(assemble._unquote('"a/\\056\\056"'), "a/..")

    def test_splits_quoted_and_plain_fields(self):
        self.assertEqual(
            assemble._split_c('diff --git "a/my file" "b/my file"'),
            ["diff", "--git", "a/my file", "b/my file"],
        )
        self.assertEqual(assemble._split_c("diff --git a/x b/x"), ["diff", "--git", "a/x", "b/x"])
        self.assertIsNone(assemble._split_c('diff --git "a/x b/x'))

    def test_quoted_traversal_is_refused(self):
        # `\056` is a `.` to git: the validator must decode before checking.
        refuses(self, 'diff --git "a/\\056\\056/evil" "b/\\056\\056/evil"\n')


if __name__ == "__main__":
    unittest.main()
