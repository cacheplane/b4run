# Discovery inventory reuse implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Avoid duplicate immutable inventory reads within one discovery invocation.
**Architecture:** A private bounded wrapper scoped to resolveProductionCandidate, leaving the production reader and external evidence readers fresh.
**Tech Stack:** Node ESM, node:test, existing release controller adapters.

## Task 1: Regression tests and implementation

Files: scripts/release/observe.mjs; scripts/release/test/observe-production.test.mjs.

- [ ] Add integration tests with injected discovery methods invoking the provided inventory reader. Assert same-SHA sequential/concurrent reads use one original call across exact/global discovery. Assert distinct SHAs, separate resolution calls, original-reader calls, and main refs stay fresh. Assert failures/non-valid results can retry. Assert deep immutable copies do not freeze the source. Exercise 2048-entry capacity plus overflow without brittle wall-time assertions.
- [ ] Run `node --test --test-name-pattern='inventory reuse' scripts/release/test/observe-production.test.mjs` and record the expected assertion failures before implementation.
- [ ] Wrap the inventory parameter after reader validation inside resolveProductionCandidate. Private helper: Map of SHA to Promise; only full SHA keys; bypass mutable refs and overflow; Promise.resolve().then(() => reader.read(input)) preserves sync errors/receiver; clone and deepFreeze valid results; evict rejected/non-valid entries. Do not alter the factory or external readers. Reuse existing isSha and deepFreeze.
- [ ] Re-run the focused regressions and complete observation tests. Review no changes to selection or authorization inputs.

## Task 2: Integrity and measurement

Files: scripts/release/test/fixtures/release-script-hashes.json; scripts/release/test/workflow-contracts.test.mjs; docs/superpowers/runbooks/2026-09-20-discovery-inventory-performance.md.

- [ ] Recompute only the observe.mjs content pin and the fixture digest snapshot. Do not touch workflows or historical policy fixtures.
- [ ] Run `PATH="/tmp/b4-pnpm10-bin:$PATH" pnpm test:release-integrity` and `node --test scripts/release/test/workflow-contracts.test.mjs`.
- [ ] Replay 100 first-parent current/parent inventory pairs at the fixed 0.9.0 commit through resolveProductionCandidate with real Git/production inventory and injected scheduled discovery. Compare baseline/current output digests and counts in alternating runs. Retain an exact reproducible command in the runbook and explicitly limit timing claims to this local workload.
- [ ] Run scoped Biome using packages/config-biome/biome.json, then the full `pnpm test:release-controller` suite. Record actual results.

## Task 3: Review, merge and monitor

- [ ] Independent spec compliance and code-quality reviews; resolve concrete findings.
- [ ] Commit scoped changes, check active CI submission capacity, create and attach PR referencing #668 with measured limits.
- [ ] Wait for required validation and separate CopilotKit/Vercel checks on the exact head. Merge using --match-head-commit, no bypass or workflow cancellations.
- [ ] Monitor main CI and ordinary release observation. Do not cut another release for the benchmark.
