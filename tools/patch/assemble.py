"""Assemble a patch-series file from a header and a captured git diff.

Workflow (docs/engineering/PATCHING.md): edit the generated
worktree/firefox/ tree, capture `git diff -- <paths>` to a file, revert the
tree, then assemble the patch file with its metadata header:

  python tools/patch/assemble.py <diff-file> <header-file> <out-patch>

The header answers the patch rule (why / what / depends / validation /
upstream risk); see patches/toolkit/default-favicon/ for the format. All
files are UTF-8 and the output is forced LF: patch files are eol=lf by
.gitattributes because git apply matches them byte-for-byte.

Containment: diff/header/out must live inside the repo (capture to a repo
path such as patches/.tmp/, not /tmp, so traversal cannot overwrite
outside files).
"""

import sys
from pathlib import Path

REQUIRED_HEADER_FIELDS = (
    "Subject:",
    "Why Firefox source must change:",
    "What it changes",
    "Depends on:",
    "Validation:",
    "Upstream risk:",
)


def _inside_repo(path: Path, repo: Path) -> Path:
    resolved = (repo / path).resolve()
    try:
        resolved.relative_to(repo.resolve())
    except ValueError:
        print(f"{path}: escapes repository root; refusing", file=sys.stderr)
        raise SystemExit(1)
    return resolved


def _reject_diff_escape(diff: str, diff_file: str) -> None:
    """Refuse diffs whose target paths could write outside the worktree.

    `git apply` trusts `---/+++/diff --git` paths: `../`, absolute, or
    `/dev/null`-bypass entries would land outside `worktree/firefox/`.
    Only `a/<path>` / `b/<path>` with plain relative <path> are accepted.

    Only file-header lines are validated: `---`/`+++` are only headers
    before the first `@@` hunk of each file. Diff *content* lines such as
    `--- ../foo` (a removed line `-- ../foo`) must not be misread as headers.
    `diff --git` paths are parsed with shell-like quoting so
    `"a/my file"` works.
    """
    import shlex

    in_hunk = False
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            in_hunk = False
            try:
                parts = shlex.split(line)
            except ValueError:
                print(f"{diff_file}: suspicious diff header {line!r}; refusing", file=sys.stderr)
                raise SystemExit(1)
            # Expect `diff --git a/<src> b/<dst>`.
            if len(parts) != 4 or parts[0] != "diff" or parts[1] != "--git" or not parts[2].startswith("a/") or not parts[3].startswith("b/"):
                print(f"{diff_file}: suspicious diff header {line!r}; refusing", file=sys.stderr)
                raise SystemExit(1)
            for candidate in (parts[2][2:], parts[3][2:]):
                _check_target(_unquote(candidate), diff_file, line)
        elif line.startswith("@@ "):
            in_hunk = True
        elif (line.startswith("--- ") or line.startswith("+++ ")) and not in_hunk:
            path = line[4:].strip().split("\t")[0].strip()
            path = _unquote(path)
            if path in ("-", "/dev/null"):
                continue
            if path.startswith(("a/", "b/")):
                target = path[2:]
            else:
                target = path
            _check_target(target, diff_file, line)


def _unquote(path: str) -> str:
    """Strip git C-style quoting (`\"a/my file\"`) for validation."""
    path = path.strip()
    if len(path) >= 2 and path.startswith('"') and path.endswith('"'):
        try:
            # Git quotes with C escapes; unicode_escape covers \\, \t, \".
            return bytes(path[1:-1], "utf-8").decode("unicode_escape")
        except Exception:
            return path[1:-1]
    return path.strip('"')


def _check_target(target: str, diff_file: str, line: str) -> None:
    if not target or target.startswith(("/", "\\")) or "\\" in target or ":" in target:
        print(f"{diff_file}: absolute/odd path {line!r}; refusing", file=sys.stderr)
        raise SystemExit(1)
    parts = target.split("/")
    if any(p in ("", ".", "..") for p in parts):
        print(f"{diff_file}: path escape {line!r}; refusing", file=sys.stderr)
        raise SystemExit(1)


def main(diff_file: str, header_file: str, out_patch: str) -> int:
    repo = Path(__file__).resolve().parents[2]
    diff_path = _inside_repo(Path(diff_file), repo)
    header_path = _inside_repo(Path(header_file), repo)
    out_path = _inside_repo(Path(out_patch), repo)
    with open(diff_path, encoding="utf-8") as handle:
        diff = handle.read()
    if not diff.strip():
        print(f"{diff_file}: empty diff; nothing to assemble", file=sys.stderr)
        return 1
    if "diff --git " not in diff:
        print(f"{diff_file}: no 'diff --git' header found; refusing", file=sys.stderr)
        return 1
    _reject_diff_escape(diff, diff_file)
    if not out_path.name.endswith(".patch"):
        print(f"{out_patch}: output must end in .patch; refusing", file=sys.stderr)
        return 1
    with open(header_path, encoding="utf-8") as handle:
        header = handle.read()
    missing = [f for f in REQUIRED_HEADER_FIELDS if f not in header]
    if missing:
        print(
            f"{header_file}: missing patch-rule fields {missing}; refusing",
            file=sys.stderr,
        )
        return 1
    if not header.endswith("\n"):
        header += "\n"
    with open(out_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(header + diff)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2], sys.argv[3]))
