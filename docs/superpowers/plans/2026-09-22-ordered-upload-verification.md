# Ordered upload / verification implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans for implementation after design review.

**Goal:** Overlap registry-side scanning while keeping npm writes serial and completion fully verified.
**Architecture:** Existing publisher upload loop plus a bounded pending list and later convergence loop. Keep bootstrap behavior and the final evidence sweep.
**Tech Stack:** Node ESM, node:test, existing injected registry/clock/process interfaces.

## Task 1: Establish fault and performance contracts

Files: scripts/release/test/publisher.test.mjs; existing fixtures only where required.

- [ ] Read the design recovery limits and existing publication-history/CLI authority callers. Verify there is no implied exactly-once hidden-acceptance guarantee; report any conflict before implementation.
- [ ] Add clock-based ordinary OIDC overlap regression with all 21 packages delayed from acceptance. Assert canonical write order, max one write in flight, no polling until uploads end, unchanged canonical evidence. Run it red on baseline.
- [ ] Add first/middle/last upload failures and scan-pending runner-loss cases. Assert visible versions skipped, candidate latest converged, hidden duplicate rejection remains failure and halts later writes. Keep old bootstrap tests unchanged.
- [ ] Add pending-budget tests counting upload-to-verification queue time, already-ready late observations, overall expiry and final-sweep drift. Watch meaningful failures before changing production behavior.

## Task 2: Minimal publisher change

File: scripts/release/publisher.mjs.

- [ ] Add a manifest-bounded pending list in publishManifestSerially. Keep existing already-present/recovered branches, all pre-write sweeps and publishTarball unchanged.
- [ ] After successful new upload, ordinary mode queues entry plus now(); firstPublication still awaits current verification immediately. After upload loop, verify queued entries serially.
- [ ] Allow waitUntilVerified to receive an optional convergence start time, defaulting to now() for unchanged callers. Pass acceptance time for queued entries. Keep clock/pending-delay/error handling and final fresh evidence sweep unchanged.
- [ ] Run publisher and npm-audit tests; update only assertions whose ordinary-mode timing is intentionally changed. Use scoped Biome config packages/config-biome/biome.json.

## Task 3: Integrity, review and rollout

Files: scripts/release/test/fixtures/release-script-hashes.json; scripts/release/test/workflow-contracts.test.mjs; new runbook under docs/superpowers/runbooks/.

- [ ] Recompute changed module pins and fixture digest only. Run pnpm test:release-integrity and workflow-contracts.test.mjs, then pnpm test:release-controller.
- [ ] Record deterministic old/new elapsed time, operation order and evidence equality; keep simulated results distinct from production savings.
- [ ] Independent spec and code reviews; resolve recovery-contract findings. Confirm no new dependencies, workflow jobs, services, credentials or manual steps.
- [ ] Wait for #783 rollout and available CI capacity; submit one performance PR. Require exact-head validate, real vercel-native and copilotkit-examples-e2e. Merge normally, monitor main, measure next ordinary release without dispatching one solely for this change.
