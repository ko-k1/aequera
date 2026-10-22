#!/usr/bin/env python3
"""Replace symlinks that escape a staged macOS app bundle with real files.

The build installs some files with mach's default absolute_symlink mode. That
is convenient inside an objdir, but a distributed app must not point at the
build tree: codesign rejects a nested bundle whose main executable or
Info.plist is a symlink, and the target does not exist on another Mac.

Internal symlinks (a framework's Versions/Current, for example) are valid and
stay symlinks. Only links whose resolved target is outside the bundle are
materialized.

Usage: python3 tools/build/macos/dereference_bundle.py Aequera.app
"""

import os
import shutil
import sys


def dereference_escaping_symlinks(bundle):
    root = os.path.realpath(bundle)
    if not os.path.isdir(root):
        raise SystemExit(f"dereference: not a directory: {bundle}")

    links = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for name in dirnames + filenames:
            path = os.path.join(dirpath, name)
            if os.path.islink(path):
                links.append(path)

    for path in links:
        target = os.path.realpath(path)
        try:
            inside = os.path.commonpath((root, target)) == root
        except ValueError:
            inside = False
        if inside:
            continue
        if not os.path.exists(target):
            raise SystemExit(
                f"dereference: dangling symlink outside the bundle: "
                f"{os.path.relpath(path, root)} -> {target}"
            )

        os.unlink(path)
        if os.path.isdir(target):
            shutil.copytree(target, path)
        else:
            shutil.copy2(target, path)


def main(argv):
    if len(argv) != 1:
        raise SystemExit("usage: dereference_bundle.py Aequera.app")
    dereference_escaping_symlinks(argv[0])


if __name__ == "__main__":
    main(sys.argv[1:])
