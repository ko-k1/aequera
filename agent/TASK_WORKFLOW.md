# Agent Task Workflow

## 1. Understand

Read the relevant documentation and identify the current architecture boundary.

## 2. Classify

Determine whether the task is configuration, first-party extension, Aequera source, Firefox patch, or exceptional Gecko work.

## 3. Slice

Break the task into the smallest meaningful units. For upstream-facing work, prefer an ordered logical patch series.

## 4. Implement

Make the smallest change that can prove the intended behavior. Do not mix unrelated cleanup with feature work.

## 5. Verify

Run focused tests first, then broader tests as the change warrants. UI changes should receive performance and accessibility checks.

## 6. Inspect the Boundary

Before finalizing, ask:

- did Aequera source remain separate from Firefox source?
- did the task introduce an undocumented API/config value?
- did it create new privilege or network behavior?
- could a higher-level mechanism have avoided a patch?

## 7. Record

Update architecture/docs/ADR/config schema when the change affects a public or long-lived project assumption.

## 8. Report

Prefer concise, machine-readable command output and clearly identify:

- upstream revision;
- patchset state;
- tests run;
- benchmark state;
- unresolved risks.
