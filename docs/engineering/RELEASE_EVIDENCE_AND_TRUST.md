# Aequera Release Evidence & Trust

## Status

Proposed policy and evidence model for Aequera releases.

## Purpose

Aequera is intended to be a browser that users can evaluate from observable facts rather than from promises.

Release quality therefore includes not only whether Aequera builds and runs, but whether users can inspect:

- exactly which Firefox source was used
- exactly which Aequera changes were applied
- whether the source and build are reproducible
- which automated and manual validations passed
- how Firefox WebExtensions compatibility was checked
- what performance characteristics were measured
- which privacy/security defaults were enabled
- which known limitations or failures remain
- how the release relates to previous releases

The purpose of this document is to define the evidence that Aequera should publish with a release and the conditions under which a build may be presented as a release candidate or stable release.

This is an evidence framework, not a subjective quality score.

---

# 1. Core Principle

Aequera should make release trust inspectable.

The guiding rule is:

> A user should be able to determine what Aequera is built from, what was changed, what was tested, what was measured, and what remains unknown.

A release should therefore never rely solely on statements such as:

- "stable"
- "production ready"
- "secure"
- "fast"
- "compatible"

without supporting evidence.

These words may appear as product terminology, but the underlying evidence must remain available.

---

# 2. Evidence Model

A release is described through several independent evidence dimensions.

## 2.1 Upstream provenance

The release identifies the exact Firefox source revision used as its base.

Required information:

```yaml
channel: release
version: "153.0"
revision: "<full git revision>"
repository: "https://github.com/mozilla-firefox/firefox"
```

The exact commit revision is the source identity.

The Firefox version and channel provide human-readable context, but are not substitutes for the exact revision.

### Evidence

- upstream repository
- channel
- Firefox version
- full Git revision
- source acquisition timestamp
- verification result

---

## 2.2 Aequera patch provenance

The release identifies the exact Aequera patchset applied to the upstream revision.

Required information:

```yaml
patchset:
  version: "0.x.y"
  manifest: "patches/manifest.yaml"
  base_revision: "<full git revision>"
```

Every patch series should be traceable to:

- a feature or change domain
- an ordered patch sequence
- its declared upstream base
- its validation requirements
- its current applicability state

A release must not depend on undocumented local edits to the Firefox checkout.

---

## 2.3 Configuration provenance

Configuration changes must be distinguishable from source changes.

Examples include:

- privacy defaults
- telemetry policy
- sponsored-content settings
- default search configuration
- feature flags
- enterprise-style policies
- platform-specific defaults

The release should publish the effective configuration source and, where practical, its normalized form.

The distinction is:

```text
source code
patches
configuration
extensions
```

Each should be independently inspectable.

---

# 3. Reproducibility Evidence

A release should be reproducible from declared inputs.

The minimum conceptual input set is:

```text
Firefox source revision
+
Aequera source revision
+
Aequera patchset
+
configuration
+
build configuration
+
toolchain/environment information
```

The build system should record these inputs in a machine-readable release manifest.

Example:

```yaml
release:
  version: "0.x.y"

upstream:
  channel: release
  version: "153.0"
  revision: "<full git revision>"

aequera:
  revision: "<full git revision>"

patchset:
  version: "0.x.y"

configuration:
  revision: "<git revision>"

build:
  platform: linux-x86_64
  profile: release
```

The goal is not to claim bit-for-bit reproducibility until it has actually been demonstrated.

Aequera should explicitly distinguish:

```text
rebuildable
reproducible
bit-for-bit reproducible
```

These are different claims.

---

# 4. Validation Evidence

A release should publish results from validation layers appropriate to the affected components.

## 4.1 Source and patch validation

At minimum:

```text
source acquisition       PASS / FAIL
revision verification    PASS / FAIL
patch applicability      PASS / FAIL
patch integrity          PASS / FAIL
configuration validation PASS / FAIL
```

A patch conflict is a release-blocking condition for a release build based on that patchset unless it is explicitly resolved and recorded.

---

## 4.2 Build validation

The release candidate must successfully build for each supported target platform.

The evidence should identify:

- platform
- architecture
- build profile
- toolchain
- source revision
- build result
- build artifact identifier

A successful upstream build does not imply a successful Aequera build. Aequera's own build result must be recorded independently.

---

## 4.3 Functional testing

Testing should be organized by responsibility.

Examples:

```text
unit
integration
browser/UI
workspace
customization
extensions
privacy/security behavior
accessibility
startup/shutdown
session restore
navigation
downloads
media
```

The exact test matrix may change over time.

The release should publish:

```text
tests run
tests passed
tests failed
tests skipped
known intermittent failures
```

A failure must not silently become a pass through omission.

---

# 5. Firefox Compatibility Evidence

Aequera is intended to retain compatibility with the Firefox WebExtension ecosystem.

Compatibility should therefore be treated as an explicit release concern.

The evidence should include, where applicable:

```text
extension install
extension startup
permission handling
background execution
content scripts
browser APIs used by supported extensions
extension update behavior
```

Aequera may also maintain a compatibility corpus containing representative extensions.

Compatibility claims should state their scope.

For example:

```text
WebExtensions compatibility:
- tested against: <corpus/version>
- install: PASS
- startup: PASS
- update: PASS
- known incompatible APIs: <list>
```

Do not claim universal extension compatibility from a limited test corpus.

---

# 6. Performance Evidence

Performance is part of Aequera's user experience model.

A release should therefore measure performance rather than relying only on subjective impressions.

Relevant measurements may include:

```text
startup latency
first usable browser UI
window creation
tab creation
navigation responsiveness
input-to-response latency
animation frame stability
workspace switching
memory usage
idle/background activity
CPU usage
GPU usage
power behavior
```

Not every metric must be a release blocker.

The important requirement is that:

1. the metric is defined
2. the measurement environment is recorded
3. the baseline is identified
4. the result is reproducible enough to compare over time

Firefox already has established automated performance infrastructure such as Raptor and Perfherder. Aequera may use upstream measurements where they are applicable and should add Aequera-specific measurements for behavior introduced by Aequera.

Reference:

- https://firefox-source-docs.mozilla.org/testing/perfdocs/webextension.html

---

# 7. Security and Privacy Evidence

Privacy and security are product properties, not only implementation details.

Aequera should expose the effective security/privacy configuration for every release.

Evidence may include:

```text
telemetry configuration
data collection configuration
sponsored/remote-content configuration
permission defaults
certificate/security settings
extension permission behavior
network-related defaults
content isolation assumptions
sandbox configuration
```

Where Aequera intentionally differs from Firefox defaults, the difference should be documented.

Security claims must be scoped.

For example:

```text
"This release disables feature X by default"
```

is an inspectable claim.

By contrast:

```text
"This release is completely secure"
```

is not a meaningful evidence statement.

Known security limitations, upstream advisories, and unresolved security-relevant issues should be disclosed according to the project's security policy.

---

# 8. Upstream Release Evidence

Aequera should take advantage of Mozilla's existing release evidence rather than replacing it with unverified claims.

Mozilla's release process separates build, promotion, push, and ship phases. Release promotion is specifically designed to ship compiled binaries that have already been tested, reducing release-specific differences between tested and shipped artifacts.

Reference:

- https://firefox-source-docs.mozilla.org/taskcluster/release-promotion.html

Mozilla also records release parameters such as version and revision-related information in its release automation.

Reference:

- https://firefox-source-docs.mozilla.org/taskcluster/parameters.html

Aequera should preserve the relevant upstream provenance and link to the corresponding upstream release evidence when available.

Important distinction:

```text
Mozilla release evidence
        !=
Aequera release evidence
```

Mozilla's evidence establishes evidence about the Firefox upstream component.

Aequera must separately establish evidence for:

```text
Aequera patches
Aequera configuration
Aequera integrations
Aequera UI/UX behavior
Aequera build
```

---

# 9. Mozilla CI and External Evidence

Where appropriate, Aequera development may use upstream CI and tools such as Try and Treeherder as supporting evidence.

Mozilla documents Try as a system for building and testing changes on automation infrastructure, with results visible through Treeherder.

References:

- https://firefox-source-docs.mozilla.org/tools/try/index.html
- https://firefox-source-docs.mozilla.org/testing/treeherder-try/index.html

External CI results must be referenced with:

```text
repository
revision
task/run identifier
timestamp
result
```

Do not treat a dashboard screenshot or a transient green state as sufficient provenance on its own.

---

# 10. Release Evidence Bundle

Every Aequera release should produce a machine-readable evidence bundle.

Suggested structure:

```text
release-evidence/
└── <aequera-version>/
    ├── release.yaml
    ├── upstream.json
    ├── source.json
    ├── patches.json
    ├── configuration.json
    ├── build.json
    ├── tests.json
    ├── compatibility.json
    ├── performance.json
    ├── security.json
    ├── known-issues.md
    └── checksums.txt
```

Human-readable release notes may summarize these files.

The machine-readable files should remain the canonical evidence representation.

---

# 11. Evidence States

Aequera should distinguish evidence state from product marketing language.

Recommended states:

| State | Meaning |
|---|---|
| `verified` | Checked by an automated or explicitly documented verification procedure |
| `measured` | Supported by a recorded measurement |
| `observed` | Seen in a defined test or manual validation |
| `documented` | Declared by source/configuration documentation but not independently measured by the release pipeline |
| `unknown` | Not currently verified |
| `failed` | Verification or validation did not pass |

The state should always be accompanied by scope.

Example:

```yaml
extension_compatibility:
  state: measured
  corpus: "aequera-webext-corpus-0.3"
  timestamp: "2026-09-23T..."
```

`unknown` is a valid and preferable state to an unsupported claim.

---

# 12. Release Gates

A release gate should answer:

> Is there enough evidence to distribute this build as the release type being claimed?

The gate should be deterministic and machine-checkable.

## Stable release minimum

A stable release should require, at minimum:

```text
[PASS] exact upstream revision recorded
[PASS] Aequera source revision recorded
[PASS] patchset recorded
[PASS] patch application verified
[PASS] supported-platform builds passed
[PASS] required functional tests passed
[PASS] critical compatibility tests passed
[PASS] release configuration captured
[PASS] known critical issues reviewed
[PASS] evidence bundle generated
```

Additional product-specific gates may be required for features such as:

- GPU acceleration changes
- compositor changes
- workspace architecture
- major customization changes
- browser security changes
- major WebExtension integration changes

---

# 13. Failed or Incomplete Evidence

A failed test should remain visible.

A release pipeline should not transform:

```text
FAIL
```

into:

```text
PASS
```

merely by removing the test from the report.

Instead:

```yaml
tests:
  status: partial

failures:
  - id: "<test-id>"
    state: known
    impact: "<description>"
    disposition: "<fixed|accepted|deferred>"
```

A release may proceed with a non-critical known issue only when:

1. the issue is documented
2. its scope is understood
3. its impact is assessed
4. the release policy explicitly permits it

Critical failures should block the corresponding release gate.

---

# 14. Release Candidate Flow

The intended release flow is:

```text
Firefox Release update detected
            |
            v
Resolve exact upstream revision
            |
            v
Update upstream lock
            |
            v
Check patch applicability
            |
       +----+----+
       |         |
     pass      conflict
       |         |
       v         v
Apply patchset  stop/rebase
       |
       v
Build Aequera
       |
       v
Run required tests
       |
       v
Run compatibility tests
       |
       v
Run performance benchmarks
       |
       v
Review security/privacy changes
       |
       v
Generate evidence bundle
       |
       v
Release candidate
       |
       v
Final release gate
       |
       v
Stable release
```

---

# 15. Release History

Aequera should retain release evidence across versions.

Example:

```text
release history

0.4.0
Firefox 153.0
revision: A
patchset: P4
result: released

0.4.1
Firefox 153.0.1
revision: B
patchset: P4
result: released

0.5.0
Firefox 154.0
revision: C
patchset: P5
result: release candidate
```

The history should make upstream transitions visible.

Useful derived measurements include:

```text
upstream update success rate
patch conflict frequency
time-to-update
build failure rate
test regression rate
compatibility regression rate
performance regression count
```

These are historical engineering measurements, not a user-facing quality score.

---

# 16. User-Facing Transparency

Release information should be presented at two levels.

## Human-facing

Users should be able to quickly see:

```text
Aequera version
Firefox base version
Firefox revision
Aequera revision
supported platforms
validation summary
known limitations
privacy/security changes
compatibility scope
performance changes
```

## Machine-facing

Advanced users and maintainers should be able to retrieve the complete evidence bundle.

Example:

```bash
aequera release info
aequera release evidence
aequera release verify
```

Potential output:

```text
Aequera       : 0.5.0
Firefox       : 154.0
Revision      : <full SHA>
Patchset      : 0.5
Build         : verified
Tests         : verified
Compatibility : measured
Performance   : measured
Security      : reviewed
Evidence      : complete
```

The CLI should present states and facts, not replace them with a single opaque "trust" score.

---

# 17. Verification by Users and Third Parties

Aequera should make independent verification practical.

A third party should be able to:

```text
clone Aequera
        |
        v
read release manifest
        |
        v
obtain exact Firefox revision
        |
        v
obtain exact patchset
        |
        v
rebuild or inspect the build inputs
        |
        v
run the documented validation
        |
        v
compare the resulting evidence
```

The project should publish enough information to make disagreements diagnosable.

For example:

```text
"My build differs"
```

should be reducible to one or more explicit differences:

```text
upstream revision
Aequera revision
patchset
configuration
toolchain
platform
build mode
```

---

# 18. Transparency Does Not Mean Perfect Certainty

No release evidence system can prove that software contains no bugs.

The purpose of this system is narrower and more practical:

```text
make claims traceable
make inputs explicit
make validation visible
make failures visible
make changes comparable
make unknowns explicit
```

The absence of evidence should remain distinguishable from evidence of absence.

---

# 19. Relationship to Aequera Architecture

This evidence model directly depends on the upstream and patch architecture.

```text
upstream/firefox/
        |
        v
firefox.lock
        |
        v
Aequera patchset
        |
        v
configuration
        |
        v
Aequera build
        |
        +-- tests
        +-- compatibility
        +-- performance
        +-- security/privacy checks
                |
                v
        release evidence
```

This is why the project must preserve strict separation between:

```text
upstream
Aequera source
patches
configuration
build artifacts
evidence
```

Each layer contributes different evidence and should not be conflated.

---

# 20. Initial Implementation Roadmap

The evidence system should be implemented progressively.

### Stage 1 — Provenance

Implement:

```text
Firefox lock
Aequera revision
patchset identity
configuration identity
```

### Stage 2 — Build evidence

Implement:

```text
build manifest
platform
toolchain
artifact hashes
```

### Stage 3 — Validation evidence

Implement:

```text
test result collection
patch validation
compatibility result collection
```

### Stage 4 — Performance evidence

Implement:

```text
benchmark execution
baseline comparison
regression recording
```

### Stage 5 — Release evidence

Implement:

```text
evidence bundle
release gate
release history
CLI verification
```

### Stage 6 — Independent verification

Document a clean-room verification path that does not depend on a maintainer's local working tree.

---

# 21. Intended CLI

The evidence model should be exposed through the Aequera CLI.

```bash
aequera upstream status
aequera upstream verify

aequera patch status
aequera patch check

aequera build
aequera test
aequera bench

aequera release check
aequera release evidence
aequera release verify
```

The CLI should produce both:

```text
human-readable output
machine-readable output
```

for example:

```bash
aequera release verify --json
```

This allows CI, agents, release automation, and humans to consume the same evidence.

---

# 22. Design Rule

Aequera should prefer:

```text
evidence > assertion
measurement > impression
provenance > trust-me
explicit unknown > unsupported certainty
historical record > one-time claim
reproducible process > manual procedure
```

The release system exists to make these principles operational.

---

# References

Mozilla Firefox Source Documentation:

- Release Promotion
  https://firefox-source-docs.mozilla.org/taskcluster/release-promotion.html

- Taskcluster Parameters
  https://firefox-source-docs.mozilla.org/taskcluster/parameters.html

- Pocket Guide: Shipping Firefox
  https://firefox-source-docs.mozilla.org/contributing/pocket-guide-shipping-firefox.html

- Pushing to Try
  https://firefox-source-docs.mozilla.org/tools/try/index.html

- Understanding Treeherder Results
  https://firefox-source-docs.mozilla.org/testing/treeherder-try/index.html

- Automated Testing
  https://firefox-source-docs.mozilla.org/testing/automated-testing/index.html

- Firefox Performance / Raptor
  https://firefox-source-docs.mozilla.org/testing/perfdocs/webextension.html
