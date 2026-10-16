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
   on it the way the launcher does (`-offline -private-window`: it goes
   online only once its checks pass), plus Marionette, and run the check:

   ```sh
   TOR_PROFILE=$(node tests/security/tor/prepare.cjs)
   bash tools/build/aequera-run.sh --persistent -profile "$TOR_PROFILE" \
     -offline -private-window --headless -marionette -remote-allow-system-access &
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

2026-10-14, Linux (NixOS, steam-run), the bundled tor 0.4.9.14: live check
19/19, now with fingerprinting resistance, HTTPS-only, Safest, and an onion
search. The handoff passed before and after the code review fixes. Crash
recovery, "checks never run" and refusal were checked by hand
(`docs/design/TOR.md`, Verification). 2026-10-15, after the PR review
fixes: the real "New Tor window" flow with the bundled tor passed
(`IsTor: true`); the live check itself was not re-run.

2026-10-16, Windows 11 x86_64, the bundled `tor.exe` 0.4.9.14: live check
24/24, including the Windows checks (online only while tor listens, a
taken port stays offline, the port banned in the ordinary instance). On
Windows, start both instances with `tools\build\aequera.cmd` and the same
arguments instead of `aequera-run.sh --persistent` (in PowerShell through
`Start-Process`: a pipe on its output stays open as long as the browser
runs), and pass both Marionette ports to the check:
`node tests/security/tor/live-check.cjs 28282 28281`. Steps 1-2 need no
window system there; the handoff (step 3) was not run.

A Tor instance started here by hand (step 2) has no ordinary instance
watching it. Quit it through Firefox (close its windows, or Quit), not
SIGTERM: SIGTERM ends Firefox before any quit code runs (its profile lock
re-raises it), so the socket directory and marker stay until the next "New
Tor window" removes them. One started by "New Tor window" is cleaned up by
the ordinary instance when it exits.

Page-side values come from the page's own script (it writes them to the
title). Marionette's scripts run in a realm of their own, which
fingerprinting resistance does not cover; read there, the timezone is the
system's.
