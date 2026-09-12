# Registry sweep performance implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans with independent review.

**Goal:** Reduce repeated read latency before publishing while retaining serial publication and complete verification.

**Architecture:** Await concurrent fresh metadata reads for the fixed manifest inside the existing `sweepLatest` helper; retain its returned order and all callers' gates.

**Tech stack:** Existing Node.js promises, npm reader, and node:test fixtures.

- [x] Profile existing release logs, production metadata reads, and the existing audit batch alternative.
- [x] Independently review the design and plan before implementation.
- [x] In `scripts/release/test/publisher.test.mjs`, add deterministic deferred-observation tests for overlapping reads, waiting for the last result, out-of-order completion, ambiguous results, and newer latest values. Exercise both untouched and partially published candidates. Observe the concurrency regression fail against the old loop, with safe cleanup and no timing-based speed assertion.
- [x] In `scripts/release/publisher.mjs`, replace the sequential `sweepLatest` accumulation with `Promise.all(manifest.packages.map(async (entry) => ({ entry, metadata: await observeMetadata(observeRegistry, entry.name) })))`. Add a short comment explaining that only reads overlap and the caller still gates every mutation. Do not change any other publisher behavior.
- [x] Run `node --test scripts/release/test/publisher.test.mjs`. Update only the publisher SHA256 in `scripts/release/test/fixtures/release-script-hashes.json`; verify the fixture shape before editing.
- [x] Run local release-integrity, root lint, build, typecheck, build-cache, inventory, and docs checks with pnpm 10.33. Build ran before docs checks.
- [ ] Use the required hosted release-controller lane for the complete suite, avoiding a duplicate long local run. Hosted CI must complete all required source, package, harness, and infrastructure checks before merge.
- [x] Update the existing performance runbook with the profile and narrowly scoped change. Obtain independent spec and quality review.
- [ ] Commit, submit one PR, and merge on green. Do not merge Version Packages or cut a release.
