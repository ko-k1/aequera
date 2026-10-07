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
