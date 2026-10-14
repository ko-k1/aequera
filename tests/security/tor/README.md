# Tor window live check

Checks Tor windows (`docs/design/TOR.md`) through the real Tor network:
that the Tor instance connects, keeps traffic on tor (locked prefs, no
local DNS, no WebRTC, localhost unreachable, nothing loads while tor is
down), gives sites their own circuits, reaches onion sites, and that "New
Tor window" reaches a running Tor instance. Run it after changes to `tor/`
and on every upstream update (the re-check list is in the design doc).

Needs: a build (`tools/build/README.md`), `tor` (on `PATH`, or its path in
the ordinary profile's `aequera.tor.executable`), network access to Tor,
and Node.js (the scripts use only its standard library). On NixOS, use the
`-nixos` launcher and `nix shell nixpkgs#tor`, or set the executable pref to
a store path.

## Steps

Ports: 28281 for the ordinary instance and 28282 for the Tor instance.
Profiles: any two new directories; absolute paths.

1. An ordinary instance with Marionette (headless is fine for steps 1–2):

   ```sh
   mkdir -p /abs/main && printf '%s\n' \
     'user_pref("marionette.port", 28281);' \
     'user_pref("remote.prefs.recommended", false);' > /abs/main/user.js
   bash tools/build/aequera-run.sh --persistent -profile /abs/main \
     --headless -marionette -remote-allow-system-access &
   ```

2. Write the Tor profile with the launcher's own code, start the Tor instance
   on it the way the launcher does (`-private-window`), plus Marionette, and
   run the check:

   ```sh
   TOR_PROFILE=$(node tests/security/tor/prepare.cjs)
   bash tools/build/aequera-run.sh --persistent -profile "$TOR_PROFILE" \
     -private-window --headless -marionette -remote-allow-system-access &
   node tests/security/tor/live-check.cjs
   ```

   `remote.prefs.recommended` is off in both profiles: the remote agent's
   recommended prefs (feeds off, and more) would otherwise change what is
   being checked.

3. Handoff (needs a window system: headless Firefox never acts as a
   remoting client). Run steps 1–2 without `--headless` in a session (a
   headless sway works: `WLR_BACKENDS=headless sway`, then
   `WAYLAND_DISPLAY=<its socket>`), then:

   ```sh
   node tests/security/tor/handoff.cjs
   ```

Quit both instances afterwards. On a clean quit the Tor instance removes
its socket directory and `<main profile>/tor/running`; tor's directory
cache stays in `<main profile>/tor/data`.

## Last run

2026-10-14, Linux (NixOS, steam-run), tor 0.4.9.14: live check 15/15 and
handoff passed (`docs/design/TOR.md`, Verification).
