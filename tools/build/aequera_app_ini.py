"""Place the build's application.ini where `-app` needs it, after verifying it.

The build writes Aequera's identity into dist/bin/application.ini itself
(tools/build/mozconfig.branding and patches/build/branding):

  Vendor/Name    -> Aequera (window class, registry on Windows, crash/app identity)
  RemotingName   -> aequera (single-instance channel: never hands off to or
                    from a running Firefox)
  Profile        -> Aequera (its own profiles.ini and profile root:
                    %APPDATA%\\Aequera\\Profiles and %LOCALAPPDATA%\\Aequera\\Profiles
                    on Windows, ~/.aequera on Linux,
                    ~/Library/Application Support/Aequera on macOS)

The prebuilt binary of an artifact build (firefox.exe on Windows, firefox on
Linux, Firefox.app on macOS) ignores that file and uses the identity compiled
into it (Mozilla's), unless started with `-app <ini>` from the browser/ app
directory; this copies it there. A build whose ini lacks the identity is
refused rather than patched over, so a broken configuration shows up here
instead of as a launch that shares Firefox's profiles.

The copy drops [Crash Reporter] and [AppUpdate]: the artifact binary has
both compiled in (they cannot be configured out of an artifact build), and
their servers are Mozilla's. Without them nothing is uploaded or updated.

Usage: python aequera_app_ini.py <build application.ini> <output ini>
"""

import configparser
import sys

IDENTITY = {
    "Vendor": "Aequera",
    "Name": "Aequera",
    "RemotingName": "aequera",
    "Profile": "Aequera",
}
MOZILLA_SERVICES = ("Crash Reporter", "AppUpdate")


def main(source: str, target: str) -> int:
    ini = configparser.ConfigParser(interpolation=None)
    ini.optionxform = str  # keys are case-sensitive for XRE
    with open(source, encoding="utf-8") as handle:
        ini.read_file(handle)
    if not ini.has_section("App") or not ini.has_option("App", "ID"):
        print(f"{source}: no [App] ID; not a Firefox application.ini", file=sys.stderr)
        return 1
    wrong = {
        key: ini.get("App", key, fallback=None)
        for key, value in IDENTITY.items()
        if ini.get("App", key, fallback=None) != value
    }
    if wrong:
        print(
            f"{source}: not an Aequera identity {wrong}; build with "
            "tools/build/mozconfig.branding and patches/build/branding",
            file=sys.stderr,
        )
        return 1
    for section in MOZILLA_SERVICES:
        ini.remove_section(section)
    with open(target, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("; Copied by tools/build/aequera_app_ini.py - do not edit.\n")
        ini.write(handle, space_around_delimiters=False)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
