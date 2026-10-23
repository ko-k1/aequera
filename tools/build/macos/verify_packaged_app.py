#!/usr/bin/env python3
"""Reject an unpackaged macOS developer bundle before it is distributed.

``mach build`` leaves ``dist/Aequera.app`` as a developer bundle.  It uses
symlinks into the objdir, has no ``omni.ja`` files, and its Info.plist keeps
the build machine's ``MozillaDeveloperRepoPath`` and
``MozillaDeveloperObjPath`` entries.  Firefox therefore treats it as an
unpackaged build.  The first content-process launch calls
``CacheSandboxParams``, fails to read the repo/obj directories, and crashes in
``ContentParent::BeginSubprocessLaunch`` with ``MOZ_CRASH``.

A distributable app comes from ``./mach package``.  That stage writes the GRE
and browser ``omni.ja`` files and removes the developer-only plist entries.

Usage: python3 tools/build/macos/verify_packaged_app.py Aequera.app
"""

import plistlib
import sys
from pathlib import Path

DEVELOPER_KEYS = (
    "MozillaDeveloperRepoPath",
    "MozillaDeveloperObjPath",
)
OMNIJARS = (
    "omni.ja",
    "browser/omni.ja",
)


def verify(bundle):
    root = Path(bundle)
    plist_path = root / "Contents" / "Info.plist"
    resources = root / "Contents" / "Resources"

    if not plist_path.is_file():
        raise SystemExit(f"verify: not an app bundle (no {plist_path}): {bundle}")

    try:
        with plist_path.open("rb") as stream:
            info = plistlib.load(stream)
    except Exception as exc:  # noqa: BLE001 - report the plist to the user
        raise SystemExit(f"verify: cannot read {plist_path}: {exc}")

    issues = []
    for name in DEVELOPER_KEYS:
        if name in info:
            issues.append(f"Info.plist contains {name}")

    for name in OMNIJARS:
        path = resources / name
        if not path.is_file():
            issues.append(f"missing {path.relative_to(root)}")
        elif path.stat().st_size == 0:
            issues.append(f"empty {path.relative_to(root)}")

    if not issues:
        return

    lines = [f"verify: {bundle} is not a mach-packaged app:"]
    lines.extend(f"  - {issue}" for issue in issues)
    lines.append("")
    lines.append(
        "Run ./mach package in worktree/firefox and package "
        "dist/<package-dir>/Aequera.app; do not distribute dist/Aequera.app."
    )
    raise SystemExit("\n".join(lines))


def main(argv):
    if len(argv) != 1:
        raise SystemExit("usage: verify_packaged_app.py Aequera.app")
    verify(argv[0])


if __name__ == "__main__":
    main(sys.argv[1:])
