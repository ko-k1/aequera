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

import re
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

# git's quote.c escapes, for unquote_c_style-faithful decoding.
_C_ESCAPES = {
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "\\": "\\",
    '"': '"',
}


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

    `git apply` trusts `---/+++/diff --git` paths: `../`, absolute,
    `.git/`-targeting, or `/dev/null`-bypass entries would land outside
    `worktree/firefox/` or inside the repository's own git directory. Only
    `a/<path>` / `b/<path>` with plain relative <path> are accepted.

    Only file-header lines are validated: `---`/`+++` are headers before a
    file's `@@` hunks and again once a hunk's line counts are exhausted (a
    removed line whose text begins `-- ` renders as `--- `, so hunk contents
    are counted, not guessed). Quoted paths are decoded exactly as git
    decodes them (`unquote_c_style`), so what is validated is what git will
    use. Binary sections are refused: this tool assembles text patches, and
    their encoded data could hide header-shaped lines.
    """
    in_hunk = False
    old_left = new_left = 0
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            in_hunk = False
            parts = _split_c(line)
            # Expect `diff --git a/<src> b/<dst>`; trailing fields are not
            # part of a header `git diff` writes.
            if (
                parts is None
                or len(parts) != 4
                or parts[0] != "diff"
                or parts[1] != "--git"
                or not parts[2].startswith("a/")
                or not parts[3].startswith("b/")
            ):
                print(f"{diff_file}: suspicious diff header {line!r}; refusing", file=sys.stderr)
                raise SystemExit(1)
            for candidate in (parts[2][2:], parts[3][2:]):
                _check_target(candidate, diff_file, line)
            continue
        if line.startswith("GIT binary patch") or line.startswith("Binary files "):
            print(f"{diff_file}: binary diff sections are not supported; refusing", file=sys.stderr)
            raise SystemExit(1)
        if in_hunk:
            if line.startswith("\\"):
                continue  # "\ No newline at end of file" consumes no line
            marker = line[:1]
            if marker == "-" and old_left > 0:
                old_left -= 1
            elif marker == "+" and new_left > 0:
                new_left -= 1
            elif marker == " " and old_left > 0 and new_left > 0:
                old_left -= 1
                new_left -= 1
            else:
                print(f"{diff_file}: hunk does not match its counts at {line!r}; refusing", file=sys.stderr)
                raise SystemExit(1)
            if old_left == 0 and new_left == 0:
                in_hunk = False
            continue
        if line.startswith("@@ "):
            match = re.match(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
            if not match:
                print(f"{diff_file}: suspicious hunk header {line!r}; refusing", file=sys.stderr)
                raise SystemExit(1)
            in_hunk = True
            old_left = int(match.group(2) or "1")
            new_left = int(match.group(4) or "1")
            continue
        if line.startswith("--- ") or line.startswith("+++ "):
            path = _unquote(line[4:].strip().split("\t")[0].strip())
            if path in ("-", "/dev/null"):
                continue
            target = path[2:] if path.startswith(("a/", "b/")) else path
            _check_target(target, diff_file, line)


def _split_c(line: str) -> list[str] | None:
    """Split a git header line into space-separated, C-quoted fields.

    The counterpart of git's quoted-path writer: a field is either a
    `"..."` string with backslash escapes or a run of non-space characters.
    None when a quoted field is unterminated.
    """
    fields = []
    i = 0
    while i < len(line):
        while i < len(line) and line[i] == " ":
            i += 1
        if i >= len(line):
            break
        if line[i] == '"':
            j = i + 1
            while j < len(line):
                if line[j] == "\\":
                    j += 2
                    continue
                if line[j] == '"':
                    break
                j += 1
            if j >= len(line):
                return None
            fields.append(_unquote(line[i : j + 1]))
            i = j + 1
        else:
            j = i
            while j < len(line) and line[j] != " ":
                j += 1
            fields.append(line[i:j])
            i = j
    return fields


def _unquote(path: str) -> str:
    """Decode git's C-style path quoting, as git's unquote_c_style does.

    Unquoted input is returned unchanged (minus stray quotes). Malformed
    quoting is returned as is: the containment checks still apply.
    """
    path = path.strip()
    if len(path) < 2 or not (path.startswith('"') and path.endswith('"')):
        return path.strip('"')
    out = bytearray()
    i = 1
    end = len(path) - 1
    while i < end:
        char = path[i]
        if char != "\\":
            out.extend(char.encode("utf-8"))
            i += 1
            continue
        i += 1
        if i >= end:
            return path
        esc = path[i]
        if esc in _C_ESCAPES:
            out.extend(_C_ESCAPES[esc].encode())
            i += 1
        elif esc in "01234567":
            j = i
            while j < end and j < i + 3 and path[j] in "01234567":
                j += 1
            out.append(int(path[i:j], 8) & 0xFF)
            i = j
        else:
            # As git: an unknown escape keeps its character, drops the `\`.
            out.extend(esc.encode("utf-8"))
            i += 1
    return out.decode("utf-8", "surrogateescape")


def _check_target(target: str, diff_file: str, line: str) -> None:
    if not target or target.startswith(("/", "\\")) or "\\" in target or ":" in target:
        print(f"{diff_file}: absolute/odd path {line!r}; refusing", file=sys.stderr)
        raise SystemExit(1)
    parts = target.split("/")
    if any(p in ("", ".", "..") for p in parts):
        print(f"{diff_file}: path escape {line!r}; refusing", file=sys.stderr)
        raise SystemExit(1)
    if any(p.lower() == ".git" for p in parts):
        print(f"{diff_file}: path targets a git directory {line!r}; refusing", file=sys.stderr)
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
