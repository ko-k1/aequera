# Bootstrap — Windows

Target: Windows 10/11, 64-bit. This is the primary development host for the
current phase, so this guide is the most detailed of the three.

## 1. Visual Studio

Install Visual Studio 2022 (Community is sufficient) with the
**Desktop development with C++** workload. Firefox's build requires MSVC;
the exact version floor follows the official guide:

- `https://firefox-source-docs.mozilla.org/setup/windows_build.html`

## 2. MozillaBuild

Install the MozillaBuild package. It provides the MSYS2-based shell and UNIX
tooling the Firefox build expects on Windows. Run subsequent Firefox-side
commands from the MozillaBuild shell unless the Aequera CLI says otherwise;
`aequera` itself runs in any shell (PowerShell is fine).

## 3. Rust

Install via `https://rustup.rs` (rustup, stable channel). Verify:

```powershell
rustc --version
cargo --version
```

## 4. Git

Any recent Git for Windows. Verify:

```powershell
git --version
```

## 5. Verify with Aequera

```powershell
aequera doctor
```

Expected before fetching: `ok` for git, repository, lock, backend, and
patchset-manifest; `warn` for checkout/worktree (absent until fetched).
A `warn` on the compiler probe means `cl` is not on `PATH` — open a
Visual Studio developer prompt or re-run the VS installer check above.

## 6. Fetch the pinned source

```powershell
aequera upstream fetch
```

This downloads only the objects for the locked tag. It changes no baseline.

## Notes

- Prefer NTFS with ample free space; Defender exclusions for the checkout and
  future object/build directories materially improve build times. Exclusions
  are your explicit local decision, not something the tooling configures.
- Line endings: do not "fix" anything with CRLF conversions inside
  `upstream/` or `worktree/`. The managed trees are byte-exact by design.
