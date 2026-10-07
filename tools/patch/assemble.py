"""Assemble a patch-series file from a header and a captured git diff.

Workflow (docs/engineering/PATCHING.md): edit the generated
worktree/firefox/ tree, capture `git diff -- <paths>` to a file, revert the
tree, then assemble the patch file with its metadata header:

  python tools/patch/assemble.py <diff-file> <header-file> <out-patch>

The header answers the patch rule (why / what / depends / validation /
upstream risk); see patches/toolkit/default-favicon/ for the format. All
files are UTF-8 and the output is forced LF: patch files are eol=lf by
.gitattributes because git apply matches them byte-for-byte.
"""

import sys


def main(diff_file: str, header_file: str, out_patch: str) -> int:
    with open(diff_file, encoding="utf-8") as handle:
        diff = handle.read()
    if not diff.strip():
        print(f"{diff_file}: empty diff; nothing to assemble", file=sys.stderr)
        return 1
    with open(header_file, encoding="utf-8") as handle:
        header = handle.read()
    if not header.endswith("\n"):
        header += "\n"
    with open(out_patch, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(header + diff)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2], sys.argv[3]))
