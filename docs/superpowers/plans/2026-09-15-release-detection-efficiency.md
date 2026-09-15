# Release Detection Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce redundant release detection and transient failures without changing publication order, publisher deadlines, or operator steps.

**Architecture:** Keep the current release controller and exact candidate binding. Add narrowly proven no-op decisions, bounded concurrent read-only inventory discovery, and settled transient download retries. Ownership discovery remains independent of release display labels; mutation boundaries continue to fetch fresh authorization evidence.

**Tech Stack:** Node.js ESM, node:test, existing GitHub and Git readers, GitHub Actions.

Approved scope and evidence: issue #668. Merges queue detection; they do not cancel the active publisher. A first-attempt pending run can legitimately have an empty jobs response. Historical discovery currently scans 483 releases serially, taking approximately 110 seconds for the first inventory pass in a local read-only trace. This is not an end-to-end release benchmark.

## Task 1: Implement and test the coordinated detector changes

**Files:** `scripts/release/observe.mjs`, `scripts/release/candidate.mjs`, `scripts/release/recovery/observe.mjs`, `scripts/release/adapters/github.mjs`, and only if transport settlement requires it `scripts/release/adapters/http.mjs`; corresponding tests under `scripts/release/test/`.

- [x] Add failing regressions for queued first-attempt runs with positively verified identity and zero jobs. Preserve failure for missing history on completed, started, retried, inconsistent, or mismatched runs. Read the exact run again around the jobs observation; only explicitly unstarted statuses qualify. Existing normalization remains strict for all other callers.
- [x] Add failing regressions for an ordinary non-version push returning NO_CANDIDATE without remote discovery. Keep global arbitration for version pushes, schedules, explicit dispatch, controller/dependency/workflow changes, and recovery/terminal-record changes. Establish unchanged maintenance inputs by comparing immutable current and first-parent trees; missing or malformed evidence falls back to full discovery.
- [x] Add failing regressions for bounded concurrent historical inventory reads, deterministic ownership results, complete ownership discovery despite changed tags/body labels, and draining started reads on failure. Use a small fixed concurrency bound. Share successful asset inventory promises only within one read-only discovery invocation; discard errors and preserve uncached reads at mutation/authorization boundaries.
- [x] Add failing regressions for a settled HTTP 5xx release-asset response followed by success. Retry a small fixed number of times within the original operation deadline and byte limits. Do not retry unsettled timeout/abort/network failures, authentication errors, invalid redirects, malformed successful content, oversize content, or identity/digest mismatches. Preserve credential stripping on signed redirects. Exercise the real HTTP transport with HTML/JSON 5xx at both the API and signed-download hops, plus bodies that never finish or whose cancellation never settles; a mocked SERVER_ERROR alone is insufficient. The current safelyCancelBody helper does not await settlement, so do not treat its return as retry authorization.
- [x] Run each new focused test before implementation and record the expected failure. Implement the smallest changes using existing reader contracts and no new service, credential, workflow gate, or publishing step.
- [x] Run `node --test scripts/release/test/observe-production.test.mjs scripts/release/test/candidate.test.mjs scripts/release/test/github-adapter.test.mjs` and affected recovery/HTTP tests. All must pass.
- [x] Review specification compliance, then code quality; fix findings and repeat focused tests.

## Task 2: Integrity, documentation, and integration validation

**Files:** `scripts/release/test/fixtures/release-script-hashes.json`, `scripts/release/test/workflow-contracts.test.mjs`, this plan, and a concise runbook under `docs/superpowers/runbooks/` if useful.

- [x] Regenerate only intentionally changed reachable script pins and the reviewed fixture digest. Run `node --test scripts/release/test/workflow-contracts.test.mjs` and `pnpm test:release-integrity` first.
- [ ] Run scoped Biome and `pnpm test:release-controller`; all must pass. Run repository validation appropriate to release tooling and use CI for the complete required lanes, including real Vercel and CopilotKit jobs.
- [x] Record measured local request concurrency/count or fixture timing separately from live release timing. Do not claim an end-to-end speedup until observed on a real run.
- [x] Obtain final independent review, fix findings, and commit a coherent change with no workflow changes that interrupt current runs.

## Task 3: PR, merge, and monitoring

- [ ] Check active full CI submissions before pushing; respect the repository limit and do not cancel release runs.
- [ ] Open a PR linking issue #668, explaining behavior and validation. No user-facing package change means no package release changeset.
- [ ] Monitor required checks and fix actual regressions. Merge only once required checks, release-bearing boundary jobs, and review are green.
- [ ] Monitor the resulting main CI and release detector. Report PR/merge identity, measured result, and any remaining publisher bottleneck separately.
