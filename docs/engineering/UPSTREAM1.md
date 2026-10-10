# Firefox Upstream Management

## Purpose

Aequera is built on top of Firefox/Gecko, but Firefox is not part of Aequera's source of truth.

Aequera maintains a reproducible relationship with Firefox upstream so that a build can always answer:

> Which Firefox source revision is this build based on, which Aequera changes were applied to it, and which validations passed for that combination?

The upstream workflow therefore treats Firefox as an external, versioned input to the Aequera build system.

---

## Core Model

```text
Mozilla Firefox upstream
        |
        | acquire
        v
upstream/firefox/
        |
        | exact revision from lock
        v
clean Firefox baseline
        |
        | create generated worktree
        v
worktree/firefox/
        |
        | apply Aequera patchset
        | apply Aequera configuration
        v
Aequera build tree
        |
        +--> build
        +--> test
        +--> benchmark
        +--> package
```

The important separation is:

```text
upstream source  !=  Aequera source  !=  patchset  !=  configuration
```

Each layer has a different ownership and update policy.

---

## Design Principles

### 1. Pin source by exact revision

Aequera must pin Firefox by an immutable Git revision, represented by the complete commit SHA.

A product version such as `155.0`, a branch name such as `release`, or a channel name such as `release` is metadata, not the final reproducibility pin.

```text
channel       -> human / release policy
version       -> product identity
ref/tag       -> resolution hint
commit SHA    -> reproducible source identity
```

The lock file must contain the complete revision.

```yaml
revision:
  git: "0123456789abcdef0123456789abcdef01234567"
```

Short SHAs may be displayed by the CLI, but they must not be the canonical value stored in the lock.

### 2. Do not vendor Firefox history into Aequera

The default Aequera repository should not contain the entire Firefox Git history as part of its own repository history.

The managed checkout lives under:

```text
upstream/firefox/
```

and is generated/managed by the Aequera tooling.

The committed Aequera repository stores the metadata required to reproduce that checkout instead:

```text
upstream/manifests/firefox.lock
```

This keeps Aequera's history focused on Aequera.

### 3. Keep upstream clean

`upstream/firefox/` is an upstream working repository and must remain free of normal Aequera modifications.

Aequera changes are developed and assembled in a generated worktree:

```text
upstream/firefox/     # clean upstream checkout
worktree/firefox/     # generated Aequera build tree
```

The upstream checkout must never become an undocumented source of Aequera behavior.

### 4. Prefer the smallest integration layer

When implementing a feature, use the least upstream-invasive mechanism that satisfies the requirement:

```text
supported configuration / preference
        |
        v
first-party WebExtension / browser module
        |
        v
Aequera-owned source
        |
        v
Firefox browser/toolkit patch
        |
        v
Gecko/platform patch
```

Moving downward increases upstream coupling and maintenance cost.

### 5. Every upstream update is a compatibility event

A new Firefox revision is not considered adopted merely because the patchset applies.

An update is complete only after the required build, functional tests, compatibility tests, performance checks, and release gates have passed.

---

## Source Acquisition

### Preferred repository

The default Git backend should use Mozilla's official Firefox Git repository:

```text
https://github.com/mozilla-firefox/firefox.git
```

Mozilla's Firefox source documentation supports Git-based checkouts, while Mozilla's development infrastructure also uses Mercurial and `git-cinnabar` for workflows that interact directly with Mozilla's Mercurial repositories. Aequera should therefore keep source acquisition behind an upstream backend abstraction even if the first implementation is Git-only.

References:

- Firefox source setup: https://firefox-source-docs.mozilla.org/setup/
- Firefox Git repository: https://github.com/mozilla-firefox/firefox
- Git/cinnabar notes: https://firefox-source-docs.mozilla.org/contributing/git-tricks.html

### Initial bootstrap

A first checkout is conceptually equivalent to:

```bash
git clone https://github.com/mozilla-firefox/firefox.git upstream/firefox
```

However, users and agents should normally invoke:

```bash
aequera bootstrap
```

rather than manually cloning the repository.

The CLI owns:

1. repository creation;
2. remote verification;
3. fetch strategy;
4. lock resolution;
5. exact revision checkout;
6. repository cleanliness checks;
7. worktree preparation.

### Do not couple the design to one branch name

Firefox has multiple development/release channels and Mozilla's branch/reference layout can change over time.

The Aequera manifest should therefore treat a channel/ref as a resolver input, not as the immutable identity of the source.

```text
channel/ref
    |
    v
resolver
    |
    v
exact commit SHA
    |
    v
firefox.lock
```

Hard-coded branch names may exist inside a channel-specific resolver, but the rest of Aequera must operate on the resolved revision.

---

## Lock File

The committed lock file is the canonical declaration of the Firefox source used by the current Aequera baseline.

Recommended location:

```text
upstream/manifests/firefox.lock
```

A minimal lock shape is:

```yaml
schema_version: 1

upstream:
  name: firefox
  repository:
    type: git
    url: https://github.com/mozilla-firefox/firefox.git

  channel: release
  version: "<release-version>"

  revision:
    git: "<full-40-character-commit-sha>"

  resolved_from:
    type: "<tag-or-release-reference>"
    ref: "<resolved-reference>"

patchset:
  manifest: patches/manifest.yaml
  version: "<patchset-version>"
```

The precise schema may evolve, but the following invariants should remain:

- the repository URL is recorded;
- the channel is recorded;
- the human-readable Firefox version is recorded when applicable;
- the complete Git revision is recorded;
- the Aequera patchset identity is recorded;
- the lock is committed to Aequera's repository.

### What is authoritative?

```text
firefox.lock
    |
    +-- channel       informational / policy metadata
    +-- version       informational / product metadata
    +-- ref/tag       provenance / resolution metadata
    +-- revision      authoritative source pin
```

A build must never silently replace the locked revision with the current remote branch tip.

---

## Channel Policy

Aequera should model Firefox channels as different upstream inputs, not as different Aequera products unless explicitly declared otherwise.

### Release

**Primary production baseline.**

Release is the default channel for supported Aequera builds intended for normal users.

Firefox moved to a two-week major release cadence beginning with Firefox 155 in September 2026. This makes automated upstream checking and patch maintenance especially important for Aequera.

Source: https://firefox-admin-docs.mozilla.org/guides/firefox-channels/

### mozilla-central

**Forward-compatibility and development preview.**

mozilla-central should be tracked independently from the production lock. It is useful for detecting future patch breakage and API/UI changes before they reach Release.

Aequera should be able to perform a compatibility check against a central revision without replacing the production `firefox.lock`.

Conceptually:

```text
Release lock
    |
    +--> production build

Central revision
    |
    +--> preview / forward-compatibility validation
```

### ESR

**Future optional LTS baseline.**

ESR should not be a second mandatory target during the initial Aequera development phase. It can become a separate distribution/baseline later if long-term compatibility and reduced upstream churn become a product requirement.

Mozilla describes ESR as an annual major-release line with incremental security/stability updates between major ESR releases.

Source: https://firefox-admin-docs.mozilla.org/guides/firefox-channels/

Recommended initial policy:

```text
release          = production
mozilla-central  = preview / compatibility
ESR              = optional future target
```

---

## Repository Layout

```text
aequera/
├── upstream/
│   ├── firefox/                 # managed, gitignored checkout
│   └── manifests/
│       ├── firefox.lock         # committed production baseline
│       └── channels/
│           ├── central.lock     # optional central preview pin
│           └── esr.lock         # optional future ESR pin
│
├── patches/
│   ├── manifest.yaml
│   ├── browser/
│   ├── toolkit/
│   ├── gecko/
│   └── build/
│
└── worktree/
    └── firefox/                 # generated patched tree
```

`upstream/firefox/` and `worktree/firefox/` are working/generated state and should not be treated as Aequera source-of-truth files.

---

## Bootstrap Flow

```text
aequera bootstrap
        |
        v
validate local prerequisites
        |
        v
create / validate upstream/firefox
        |
        v
configure official remote
        |
        v
fetch required references
        |
        v
read firefox.lock
        |
        v
resolve + verify exact revision
        |
        v
checkout detached clean baseline
        |
        v
prepare generated worktree
        |
        v
ready for patch application
```

A bootstrap must fail rather than silently drifting to another source revision.

---

## Worktree Flow

The generated build tree should be derived from the pinned upstream repository.

```text
upstream/firefox/
      |
      | locked commit
      v
Git worktree
      |
      v
worktree/firefox/
      |
      +-- Aequera patch series
      +-- build integration
      +-- generated configuration
      |
      v
Aequera build
```

Git worktrees are useful here because multiple revisions can be checked out from a single repository without duplicating the full object database.

Mozilla's own Firefox contributor documentation also describes Git worktrees as a useful mechanism for maintaining parallel checkouts.

Reference: https://firefox-source-docs.mozilla.org/contributing/git-tricks.html

---

## Patch Application Boundary

The upstream source and Aequera's patchset must have an explicit base relationship.

Example:

```yaml
base:
  upstream:
    channel: release
    version: "<version>"
    revision: "<full-sha>"

patches:
  - id: browser-shell
    series: patches/browser/shell
  - id: workspace
    series: patches/browser/workspace
  - id: motion
    series: patches/browser/motion
```

This allows the system to answer:

```text
Patchset X was authored against Firefox revision Y.
```

A patch application that succeeds textually is not sufficient proof of compatibility.

The patch pipeline must distinguish:

```text
applies cleanly
        !=
behaves correctly
        !=
passes Aequera quality gates
```

---

## Fetch vs Update

These operations must remain separate.

### `fetch`

Fetch new remote objects and references without changing the active source baseline.

```bash
aequera upstream fetch
```

Expected behavior:

```text
remote state
   ↓
local Git object database
```

No lock change. No automatic checkout. No automatic patch rebase.

### `update`

Resolve a new target and intentionally move the Aequera baseline.

```bash
aequera upstream update
```

Expected flow:

```text
current lock
    |
    v
resolve candidate
    |
    v
new exact revision
    |
    v
update lock
    |
    v
prepare clean baseline
    |
    v
patch applicability
    |
    v
rebase if required
    |
    v
build + test + benchmark
```

An update should produce a reviewable lock-file change and a recorded compatibility result.

#### Candidate baseline (implemented: stage + check)

```bash
aequera upstream update --to FIREFOX_157_0_1_RELEASE
aequera patch check --candidate
```

`update` fetches exactly the given release tag, resolves it to a full SHA,
and writes `upstream/manifests/candidate.lock` (lock schema, generated
header). It refuses betas/ESR/build tags, versions not newer than the lock,
and replacing a different staged candidate. `firefox.lock`, the managed
checkout's HEAD, and the worktree are untouched, so the known-good baseline
stays the build input. Deleting `candidate.lock` abandons the candidate.

`patch check --candidate` applies the series cumulatively to a scratch index
seeded from the candidate SHA: each patch file is reported `clean`, `3-way`
(content merges; the patch file is stale), or `conflict` (manual rebase,
with the unmerged paths). Conflicted paths stay at the candidate's content
and the patch's other paths are kept, so one conflict does not cascade into
later patches. Exit status is non-zero while any conflict remains.

Not yet implemented: rebasing the series onto the candidate, exporting the
refreshed patch files, and adopting the candidate as the lock.

---

## Verification

`aequera upstream verify` should check at minimum:

```text
repository URL
      |
      v
expected revision exists
      |
      v
HEAD == locked revision
      |
      v
working tree clean
      |
      v
source identity valid
```

Example conceptual output:

```text
Aequera Upstream
----------------
Channel       : release
Version       : <version>
Locked SHA    : 0123456...
Current SHA   : 0123456...

Revision      : OK
Repository    : OK
Clean tree    : OK

status: verified
```

If the checked-out revision differs from the lock, the command must report drift explicitly.

---

## Drift Detection

There are several distinct kinds of drift.

### Source drift

```text
HEAD != firefox.lock revision
```

This is always significant.

### Remote drift

```text
remote has newer revision
```

This is informational until an explicit update is requested.

### Patch drift

```text
patchset base != current upstream revision
```

This means the patchset must be checked/rebased before it can become the new baseline.

### Configuration drift

```text
generated configuration != committed configuration
```

The build system should report this separately from source drift.

---

## Update and Rebase Policy

Aequera should not continuously mutate patch commits as part of a background update.

The preferred workflow is explicit and reviewable:

```text
fetch
  ↓
select new revision
  ↓
update candidate lock
  ↓
create clean worktree
  ↓
apply / rebase patch series
  ↓
resolve conflicts
  ↓
run tests
  ↓
run benchmarks
  ↓
accept new baseline
```

A failed rebase must not destroy the previous known-good baseline.

The old lock and old patchset must remain recoverable until the new baseline has passed the required gates.

---

## Release Cadence Strategy

The Firefox Release channel now changes substantially more frequently than traditional four-week cadence.

Aequera should therefore separate:

```text
upstream observation
        |
        v
candidate update
        |
        v
compatibility work
        |
        v
release adoption
```

from:

```text
automatic production update
```

A release appearing upstream should create a candidate, not silently change a user's or developer's working baseline.

A future CI service can periodically perform:

```text
aequera upstream check
        |
        +--> detect new Release
        +--> inspect central health
        +--> test patch applicability
        +--> report required maintenance
```

---

## mozilla-central Tracking

Central should have an independent lock because its purpose is different from the production Release lock.

```text
upstream/manifests/
├── firefox.lock
└── channels/
    └── central.lock
```

A central check may use a temporary worktree:

```text
central.lock
    |
    v
temporary Firefox worktree
    |
    v
Aequera patch applicability
    |
    v
compatibility tests
```

A failing central check should normally create a maintenance signal rather than invalidate the current Release baseline.

This lets Aequera prepare for upstream changes without making unreleased Firefox development revisions part of production.

---

## ESR Tracking

ESR is optional during initial development.

If an ESR variant is introduced, it should receive its own lock and patch compatibility result:

```text
upstream/manifests/channels/esr.lock
```

Do not solve ESR support by making the main patchset silently conditional on channel names.

Instead, define explicit compatibility boundaries:

```text
Aequera patchset
      |
      +--> Release compatibility
      |
      +--> Central compatibility
      |
      +--> ESR compatibility (optional)
```

A patch that cannot be shared should make that divergence explicit.

---

## Development Builds

Mozilla supports artifact builds for frontend-oriented development. Artifact builds can reduce the cost of repeatedly compiling native components when working primarily on higher-level browser code.

This is a build optimization, not a replacement for Aequera's source pinning model.

The source identity remains:

```text
locked Firefox revision
```

Reference: https://firefox-source-docs.mozilla.org/contributing/build/artifact_builds.html

Aequera should eventually allow profiles such as:

```text
aequera build --profile dev

aequera build --profile artifact

aequera build --profile release
```

The exact build profiles belong to the build system documentation rather than this upstream policy.

---

## Upstream Backend Abstraction

Aequera v0 should be able to operate using a Git checkout, but the upstream subsystem should have an internal backend interface.

Conceptually:

```text
UpstreamBackend
      |
      +-- Git backend
      |
      +-- Mozilla Mercurial / git-cinnabar backend (future)
```

The rest of Aequera should consume normalized data:

```text
repository
channel
version
revision
provenance
```

rather than knowing how Mozilla's upstream repository was fetched.

This is particularly useful because Mozilla maintains Mercurial-based infrastructure alongside Git-based workflows, and `git-cinnabar` is used when interacting between Git and Mozilla's Mercurial repositories.

Reference: https://firefox-source-docs.mozilla.org/contributing/git-tricks.html

---

## CLI Contract

The upstream command surface should expose intent, not raw Git mechanics.

Recommended commands:

```bash
aequera upstream status
aequera upstream fetch
aequera upstream verify
aequera upstream checkout <channel-or-revision>
aequera upstream update
aequera upstream clean
```

Potential future commands:

```bash
aequera upstream check

aequera upstream compare <revision>
aequera upstream history
```

Raw Git remains an implementation detail and an escape hatch for maintainers, but agents should normally use the Aequera commands when operating on upstream state.

---

## Failure Safety

The upstream subsystem must be conservative around destructive operations.

The following conditions should stop the operation unless explicitly overridden:

- modified files exist in `upstream/firefox/`;
- the lock file is malformed;
- the locked revision cannot be resolved;
- the expected remote is missing or unexpected;
- the generated worktree has uncommitted changes during a destructive reset;
- patchset base metadata does not match the selected upstream revision;
- a requested update would overwrite a known-good baseline without preserving it.

The CLI should prefer:

```text
fail clearly
```

over:

```text
repair silently
```

Silent source mutation is especially undesirable in an agent-driven development environment.

---

## Provenance and Reproducibility

A release artifact should be traceable to at least:

```text
Aequera version
Firefox channel
Firefox version
Firefox exact revision
Aequera patchset version
configuration/profile
build profile
validation result
```

The eventual release metadata should be sufficient to reconstruct the source inputs without relying on an undocumented developer machine state.

Example provenance:

```yaml
aequera:
  version: "<aequera-version>"

firefox:
  channel: release
  version: "<firefox-version>"
  revision: "<full-sha>"

patchset:
  version: "<patchset-version>"
  manifest: "patches/manifest.yaml"

build:
  profile: release

validation:
  status: passed
```

---

## What Must Never Happen

### Do not use the moving branch tip as the production source

Bad:

```text
git pull
build
release
```

Good:

```text
resolve
→ lock exact revision
→ verify
→ patch
→ test
→ release
```

### Do not modify upstream directly

Bad:

```text
upstream/firefox/
└── manual Aequera edits
```

Good:

```text
upstream/firefox/  # clean
        |
        v
worktree/firefox/  # Aequera changes
```

### Do not treat a successful patch application as a successful update

```text
patch applies
    !=
build succeeds
    !=
behavior is correct
    !=
performance is acceptable
```

### Do not make the version string the only pin

```yaml
version: "<version>"
```

is not enough.

The exact revision must also be stored.

---

## Standard Lifecycle

The complete upstream lifecycle is:

```text
                 +------------------+
                 | Firefox upstream |
                 +--------+---------+
                          |
                       acquire
                          |
                          v
                 +------------------+
                 | local Git source |
                 +--------+---------+
                          |
                    resolve / pin
                          |
                          v
                 +------------------+
                 |  firefox.lock    |
                 +--------+---------+
                          |
                   verify exact SHA
                          |
                          v
                 +------------------+
                 | clean baseline   |
                 +--------+---------+
                          |
                     worktree
                          |
                          v
                 +------------------+
                 | Aequera patchset |
                 +--------+---------+
                          |
                build / test / bench
                          |
                          v
                 +------------------+
                 | accepted release |
                 +------------------+
                          |
                   observe upstream
                          |
                          +-----------> next update
```

This lifecycle is the foundation for `aequera upstream`, the patch subsystem, CI, and the release process.

---

## Relationship to Other Documents

| Document | Responsibility |
|---|---|
| `docs/ARCHITECTURE.md` | Overall Aequera architecture and subsystem boundaries |
| `docs/SOURCE_LAYOUT.md` | Where Aequera source and integration code lives |
| `docs/engineering/PATCHING.md` | Patch series, patch metadata, rebase and application |
| `docs/engineering/CLI.md` | Aequera CLI architecture and command contract |
| `docs/engineering/DEVELOPMENT.md` | Local developer workflow and build setup |
| `docs/engineering/TESTING.md` | Functional and regression validation |
| `docs/engineering/PERFORMANCE.md` | Performance and responsiveness validation |
| `docs/engineering/RELEASE.md` | Release and packaging process |
| `docs/ROADMAP.md` | Implementation order and milestones |

The upstream document defines **how Firefox enters Aequera and how its identity is preserved**. It does not define individual Aequera features or UI architecture.

---

## Current Policy Summary

```text
Primary production source:
    Firefox Release

Forward compatibility source:
    mozilla-central

Optional future long-term baseline:
    Firefox ESR

Acquisition:
    Git-managed Firefox checkout

Canonical pin:
    full commit SHA

Committed source metadata:
    upstream/manifests/firefox.lock

Aequera modifications:
    Aequera source + explicit patch series

Upstream checkout:
    clean / managed / gitignored

Patched checkout:
    generated worktree

Update model:
    explicit, reviewable, reproducible

CLI:
    intent-oriented `aequera upstream ...`
```

The central rule is simple:

> **Aequera does not track “the current Firefox” directly. Aequera tracks a specific Firefox source revision, explicitly selected and recorded as an input to a reproducible build.**
