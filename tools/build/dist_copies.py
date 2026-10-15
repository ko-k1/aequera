"""Turn the symlinks in a Windows dev build's dist/bin into plain copies.

Where Python may create symlinks (Developer Mode, or an elevated shell),
`mach build` and `mach build faster` symlink front-end files from dist/bin
into the source tree and the objdir. Two Windows-only Gecko rules then break
the browser's content processes:

- ExtensionProtocolHandler resolves the links of built-in add-on files and
  refuses targets outside the add-on's directory (AllowExternalResource is
  false on Windows: it assumes Windows dev builds copy). Ad Veil's content
  scripts and Firefox's new tab bundle fail to load.
- The content sandbox's dev-build exception allows reads only under
  MOZ_DEVELOPER_REPO_DIR (worktree/firefox). Aequera's objdir lives outside
  it (obj/<worktree>/...), so generated files linked into the objdir, such
  as modules/workers/PromiseWorker.js, cannot be read.

Copies are what Firefox's own Windows builds use when symlinks are
unavailable, so this restores the layout upstream tests. mach replaces the
copies with links again on every build, so the launchers and
test-shell.sh run this each time; a run without links costs one scan.
Copies keep the target's modification time (mach's up-to-date checks
compare it) and stay writable (mach deletes them to relink). Their new
change time makes startup-cache.sh purge once after each build, as a
rebuild should.

A link whose target is gone is reported and left alone: it is broken with
or without this step, and the next build removes or replaces it.

Usage: python dist_copies.py [--any-os] <objdir>/dist/bin [...]
A no-op off Windows unless --any-os (tests) is given.
"""

import os
import shutil
import stat
import sys
import tempfile
from collections.abc import Iterator
from typing import NamedTuple

MAX_LISTED = 5


class Result(NamedTuple):
    copied: int
    dangling: tuple[str, ...]


def _is_dir_link(entry: os.DirEntry) -> bool:
    """A directory symlink or a junction (is_symlink() is False for those)."""
    if entry.is_symlink():
        return os.path.isdir(entry.path)
    is_junction = getattr(entry, "is_junction", None)
    return bool(is_junction and is_junction())


def _file_links(top: str) -> Iterator[str]:
    """Every file symlink under top. Directory links and junctions are
    neither followed nor returned."""
    stack = [top]
    while stack:
        with os.scandir(stack.pop()) as entries:
            for entry in entries:
                if _is_dir_link(entry):
                    continue
                if entry.is_symlink():
                    yield entry.path
                elif entry.is_dir(follow_symlinks=False):
                    stack.append(entry.path)


def _is_dist_bin(path: str) -> bool:
    parent, name = os.path.split(os.path.normpath(path))
    return name == "bin" and os.path.basename(parent) == "dist"


def _make_writable(path: str) -> None:
    os.chmod(path, os.stat(path).st_mode | stat.S_IWRITE)


def _replace_with_copy(link: str) -> None:
    """Swap the link for a copy of its target via a temporary sibling: the
    path never goes missing, and an interrupted run leaves the link."""
    target = os.path.realpath(link)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(link), prefix=".dist-copy-")
    os.close(fd)
    try:
        shutil.copy2(target, tmp)
        _make_writable(tmp)
        os.replace(tmp, link)
    except BaseException:
        if os.path.exists(tmp):
            _make_writable(tmp)
            os.remove(tmp)
        raise


def replace_links(dist_bin: str) -> Result:
    """Replace every file symlink under dist_bin with a copy.

    Raises ValueError for a directory that is not an existing .../dist/bin.
    Links whose target is gone are skipped and returned in Result.dangling.
    """
    if not _is_dist_bin(dist_bin):
        raise ValueError(f"not a dist/bin directory: {dist_bin}")
    if not os.path.isdir(dist_bin):
        raise ValueError(f"no such directory: {dist_bin}")

    copied = 0
    dangling = []
    for link in _file_links(dist_bin):
        if not os.path.exists(link):
            dangling.append(link)
            continue
        _replace_with_copy(link)
        copied += 1
    return Result(copied, tuple(dangling))


def _report(d: str, result: Result) -> None:
    if result.copied:
        print(f"dist-copies: replaced {result.copied} symlinks with copies in {d}", file=sys.stderr)
    if result.dangling:
        shown = ", ".join(result.dangling[:MAX_LISTED])
        more = len(result.dangling) - MAX_LISTED
        tail = f" and {more} more" if more > 0 else ""
        print(
            f"dist-copies: warning: {len(result.dangling)} links to missing files left as they are "
            f"(rebuild to fix): {shown}{tail}",
            file=sys.stderr,
        )


def main(argv: list[str]) -> int:
    any_os = "--any-os" in argv
    dirs = [a for a in argv if a != "--any-os"]
    if not dirs:
        print("usage: dist_copies.py [--any-os] <objdir>/dist/bin [...]", file=sys.stderr)
        return 2
    if sys.platform not in ("win32", "cygwin", "msys") and not any_os:
        return 0
    status = 0
    for d in dirs:
        try:
            _report(d, replace_links(d))
        except (ValueError, OSError) as e:
            print(f"dist-copies: {e}", file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
