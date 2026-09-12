# Post-publication handoff implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement the tasks with test-first changes and independent review.

**Goal:** Finish an existing npm-complete candidate with repaired, reviewed verification code in the existing release and independent-audit workflows.

**Architecture:** Candidate version, commit, manifest, npm bytes and provenance remain immutable. A post-publication run on main executes its own exact GitHub SHA; its run/attempt identifies the executor, separately from the candidate recorded in every receipt. Main executor authority requires repository/workflow identity, candidate ancestry, executor ancestry on main through an exact remote comparison, source pins, and successful exact main CI. Existing tag execution remains supported. No per-release authorization file, new workflow, credential, gate, timeout, or recovery activation is introduced.

**Tech stack:** Node ESM, node:test, GitHub Actions and existing read/write adapters.

The user approved this boundary on September 12 after reviewing the publication-blocker proposal. PR #633 remains draft; the new path requires five real passing smoke receipts, not an exception. Failed historical Actions receipts remain intact.

## Task 1: Reviewed executor authority

Files: create `scripts/release/postpublication-executor.mjs` and `scripts/release/test/postpublication-executor.test.mjs`; modify `scripts/release/audit-executor.mjs` and its tests/support as needed.

- [x] Add failing tests for a CI-approved main executor operating on an ancestor candidate, and refusal for foreign repo, wrong workflow/event, unmerged source/candidate, failed or mismatched CI, changed pins and forged authority objects.
- [x] Run the focused tests and confirm the expected missing-authority failure.
- [x] Factor reusable main-source verification from the existing audit executor. Retain exact candidate/tag execution and frozen historical files; generic main authority replaces live per-version authorizations. Historical main source without the new authority pin cannot become retroactively authorized. Return an unforgeable, candidate-bound identity for downstream validation.
- [x] Make the same module's workflow entrypoint validate the actual environment/run before enabling the main route. Reuse existing CI waiting semantics within the existing job deadline if CI is still running.
- [x] Run focused authority and audit-executor tests.

## Task 2: Durable smoke handoff

Files: `scripts/release/metadata.mjs`, `scripts/release/cli.mjs`, `scripts/release/observe.mjs`, `scripts/release/test/metadata.test.mjs` (or existing smoke-reconciliation test file), relevant production-observer tests.

- [x] Add a failing real-module NPM_COMPLETE reconciliation test using five successful receipts from a different, approved main executor. Assert original base assets, npm digest, tag and candidate remain identical.
- [x] Pass the Git reader to reconciliation only where needed; authorize the exact smoke run/attempt and bind Actions artifact head SHA/branch to the verified executor. Keep receipt candidate identity unchanged.
- [x] Independently authorize durable main-run smoke evidence during observation/audit. Preserve the existing tag path and exact archive/digest/job/attempt checks.
- [x] Test replay, wrong executor, changed bytes, missing lanes, failed receipt and immutable candidate mismatch; assert rejected cases cause zero writes.

## Task 3: Existing workflow routing and audit

Files: `.github/workflows/release.yml`, `scripts/release/audit.mjs`, `scripts/release/independent-audit.mjs`, workflow/audit/CLI contract tests.

- [x] Add failing workflow contracts for a main route limited to npm-complete transitions, exact executor checkout, and unchanged candidate-only npm/attestation/preparation jobs.
- [x] Keep pre-publication tag routing unchanged. Permit main to continue only from durable post-publication states after authority validation. Hydration and all verification/finalization jobs use the authorized executor SHA, with existing dependencies, permissions and deadlines.
- [x] Dispatch the independent audit on main for a main post-publication run; retain candidate-tag dispatch for ordinary tag runs. The audit authorizes its own exact main SHA independently.
- [x] Test actual observer → smoke reconciliation → audit dispatch/record → independent audit → audit reconciliation → immutable publication against the same draft fixture, including rerun and identity mismatch refusal.
- [x] Check current 0.8.31 draft against the new read-only route before any remote publication action.

## Task 4: Integrity, review and release

Files: release script pin fixture, workflow-contract digest snapshot, release runbook/measurement report.

- [x] Regenerate the exact reachable script pins and digest snapshot; run `pnpm test:release-integrity` and focused workflow contracts.
- [ ] Run the full release-controller suite; complete repository validation through CI, including real Vercel and CopilotKit checks. Do not cancel or interrupt active runs.
- [x] Independently review the complete implementation and end-to-end evidence. Fix findings before submission/merge.
- [ ] Open one repair PR, merge on green under existing authorization, then let the normal main controller resume 0.8.31 (or dispatch the existing workflow if needed).
- [ ] Verify five real smokes, independent audit, immutable GitHub publication and all original artifact identities. Update timing report with separate npm and complete-release elapsed times.


Plan review resolved: authorize routing in detect (already checks:read/full history); reconciliation and audit correlation need checks:read/full history too. Release detect pins main checkout to github.sha; historical tag invocation still observes current controller. Both release and separately dispatched audit wait for their own exact CI within existing deadlines. No historical per-version main authorization is inherited by the new generic path.
