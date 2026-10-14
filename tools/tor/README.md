# tools/tor — the bundled tor

Tor windows (`docs/design/TOR.md`, ADR 0004) run the tor that Tor Browser
ships: the Tor Project's **tor expert bundle** (tor, its libevent and
OpenSSL, the lyrebird and conjure pluggable transports, GeoIP databases).
A build carries it as `<app>/tor`, and the Tor instance prefers it to a tor on
`PATH`. `aequera.tor.executable` still overrides both.

| File | Role |
|---|---|
| `upstream/manifests/tor-expert-bundle.lock` | The pin: Tor Browser release, tor version, signing key, SHA-256 per platform |
| `fetch-bundle.sh` | Puts the pinned bundle into a build (`<objdir>/dist/bin/tor`); downloads once into `obj/tor-bundle/`, checks the SHA-256 on every run |
| `update-pin.sh` | Re-pins to a Tor Browser release after verifying its signed checksum list |

## Use

After `mach build` (a build keeps the directory; a clobber removes it):

```sh
bash tools/tor/fetch-bundle.sh            # obj/firefox/compiled, else artifact
bash tools/tor/fetch-bundle.sh <objdir>
```

`tools/build/aequera-run.sh` says when a build has no bundled tor.

## Trust

- The browser never downloads tor. Only this script does, at build time.
- The hashes in the lock come only from `sha256sums-signed-build.txt` of the
  release. `update-pin.sh` uses them only after `gpg` verifies that file's
  signature as made by the **primary key `EF6E 286D DA85 EA2A 4BA7 DE68 4E2C
  6E87 9329 8290`** (Tor Browser Developers). The key is fetched by WKD, as in
  the Tor Project's verification guide. A key that only claims the address
  is not accepted: the primary fingerprint must match.
- `fetch-bundle.sh` refuses (and deletes) an archive with any other hash, so
  a cache or mirror cannot substitute one.
- The bundle's `aequera-tor-bundle.json` marks the directory. A directory
  without it is never run as the bundled tor.

## Update

```sh
bash tools/tor/update-pin.sh <tor-browser-version>   # needs gpg: nix shell nixpkgs#gnupg -c ...
bash tools/tor/fetch-bundle.sh
```

Then run the live check (`tests/security/tor/README.md`). Pin a new release
when Tor Browser publishes one with a tor security fix.

## Platforms

Linux x86_64: verified (2026-10-14, tor 0.4.9.14, in the live check). macOS
arm64 and x86_64: pinned, unverified (the bundle's library lookup there and
where an app bundle's `GreD` puts `tor/` are untested). Windows: no Tor
windows yet. Release packaging (the installer's manifest) does not carry
`tor/` yet: a packaging slice of its own.

Licenses: `<app>/tor/licenses/` (tor: BSD-3-Clause; libevent: BSD-3-Clause;
OpenSSL: Apache-2.0; lyrebird and conjure: the licenses of their Go
components, collected in their files).
