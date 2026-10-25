# Tag-only 0.15.3 Terminal Recovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, task by task. Do not delegate implementation; use read-only review checkpoints.

**Goal:** Retire only the unpublished, tag-only 0.15.3 candidate with reviewed evidence and resume the ordinary 0.15.4 release.

**Architecture:** Add an incident-pinned schema-2 terminal record variant and a read-only collector/CLI. Merge reviewed code first, capture fresh evidence from that exact merge, then merge a record-only PR before normal release work.

**Tech Stack:** Node ESM, node:test, existing GitHub/npm/git readers, canonical JSON and release content pins. No new dependencies.

---

### Task 1: Canonical record and arbitration

**Files:**
- Modify: `scripts/release/terminal-record-store.mjs`
- Modify: `scripts/release/abandonment.mjs` to reject schema-2 git-only records at every Release tombstone boundary.
- Test: `scripts/release/test/abandonment.test.mjs` for producer/reader rejection and schema-1 compatibility.
- Modify: `scripts/release/observe.mjs` and its tests to reject a visible Release for schema 2.
- Modify: `scripts/release/candidate.mjs` only if needed to reject a visible Release for a schema-2 record.
- Test: `scripts/release/test/terminal-record-store.test.mjs`
- Test: `scripts/release/test/candidate.test.mjs`
- Create: `scripts/release/test/support/tagged-0153-record-fixture.mjs`

- [ ] Add a fixed-identity schema-2 fixture and acceptance test; run `node --test scripts/release/test/terminal-record-store.test.mjs` and observe schema rejection.
- [ ] Add identity/predecessor/inventory/publication/freshness rejection tests.
- [ ] Accept only schema 1 or incident-pinned schema 2. Keep schema-1 predecessor and evidence validators intact; share strict npm/run/authority/time validation.
- [ ] Prove git-record acceptance but Release tombstone/body producer and reader rejection for the same schema-2 bytes; retain schema-1 behavior. Add explicit guards in `canonicalAbandonmentBytes` and `parseAnyAbandonmentRecord` (and any delegated body boundary).
- [ ] Add candidate tests proving a matching tag-only record excludes 0.15.3, an unrecorded tag blocks newer releases, and visible Release/tag drift is refused.
- [ ] Run parser/candidate tests and inspect observer consumers for null-marker assumptions. Add observer regressions where needed.

### Task 2: Read-only evidence collector

**Files:**
- Create: `scripts/release/tagged-0153-recovery.mjs`
- Create: `scripts/release/test/tagged-0153-recovery.test.mjs`

- [ ] Write failing collector tests using injected readers/clock/wait.
- [ ] Export a documented `captureTagged0153Record` function. Use existing complete GitHub inventory and npm exact-version adapters, with fixed repository/tag/candidate pins.
- [ ] Verify live main ancestry, authenticated operator, exact tag peel, absent Release, complete candidate runs and all attempts with one skipped publisher each.
- [ ] Collect two strict 21-package ABSENT/404/E404 sweeps, waiting at least 60 seconds after the first; bracket with identical fresh GitHub snapshots and bound total evidence span.
- [ ] Return production-parser-validated canonical bytes; never expose a writer dependency.
- [ ] Verify all negative cases and proof ordering with focused tests.

### Task 3: CLI, documentation and integrity pins

**Files:**
- Create: `scripts/release/capture-v0.15.3-terminal.mjs`
- Create: `scripts/release/test/capture-v0.15.3-terminal.test.mjs`
- Create: `docs/superpowers/runbooks/2026-10-25-release-0153-terminal-recovery.md`
- Modify: `scripts/release/test/fixtures/release-script-hashes.json`
- Modify: `scripts/release/test/workflow-contracts.test.mjs`

- [ ] Write failing CLI boundary tests for exact arguments, clean/reviewed checkout and exclusive output.
- [ ] Implement a read-only CLI accepting `--reviewed-commit` and `--output`; prove exact local checkout and live-main ancestry, then write a new mode-0600 record. Keep secrets out of diagnostics.
- [ ] Document exact capture/review/record-only-PR/reobserve steps and existing workflow/publishing invariants.
- [ ] Repin changed release-reachable modules and update the pin fixture digest snapshot. Do not change workflow command allowlists or abandonment topology.
- [ ] Run `node --test scripts/release/test/terminal-record-store.test.mjs scripts/release/test/tagged-0153-recovery.test.mjs scripts/release/test/capture-v0.15.3-terminal.test.mjs scripts/release/test/candidate.test.mjs scripts/release/test/observe-production.test.mjs scripts/release/test/workflow-contracts.test.mjs`.
- [ ] Run `pnpm test:release-integrity`, scoped Biome, `node scripts/check-docs.mjs`, and `pnpm test:release-controller`; review code and exact pin diff.
- [ ] Commit/open implementation PR, attach it to this chat, and wait for all required CI plus native Vercel and CopilotKit before merge. Account for active main/version-PR CI submissions.

### Task 4: Fresh production evidence and terminal record

**Files:**
- Create in a separate PR only: `scripts/release/terminal-records/v0.15.3.json`

- [ ] After implementation merge, use a clean isolated checkout at its exact reviewed merge SHA. Refresh live state; refuse if any package/Release/tag/publication changed.
- [ ] Run the read-only collector with token provided privately through the environment. Inspect canonical output and independent absence/job/tag observations.
- [ ] Copy exact output bytes into the record path, review and open a record-only PR; run integrity/controller checks and required CI before merge.
- [ ] Reobserve production arbitration using the merged record. Preserve the failed tag and all historical evidence.

### Task 5: Normal release and Hashbrown registry validation

- [ ] Refresh/check the Version Packages PR contains both compatibility fixes and the peer correction; wait for required CI, then merge under existing authorization.
- [ ] Use only the supported release controller with exact candidate/version and verify registry publication, smokes, independent audit, and immutable GitHub Release.
- [ ] Update existing Hashbrown pins/lockfile to the compatible released set, perform a clean install, and rerun core/server/lifecycle build/test/lint, full ATC browser matrix, default/agent builds and real Postgres runtime/artifact checks.
- [ ] Update PR #731 evidence and remaining hosted smoke configuration; clean disposable resources. Do not merge Hashbrown or deploy production implicitly.
