# Publisher Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Let serial npm publication finish within a bounded sixty-minute window without timeout-driven restarts.

**Architecture:** Change the existing publisher constant and its workflow job ceiling together. Keep all smaller deadlines, sequencing, evidence and cancellation paths unchanged. Use injected clocks for long-duration regressions.

**Tech Stack:** Node.js ESM, node:test, GitHub Actions, existing release integrity fixtures.

Spec: docs/superpowers/specs/2026-09-16-publisher-budget-design.md.

- [x] Verify the publisher suite on clean origin/main in the owned worktree.
- [x] Add a CLI regression in scripts/release/test/publisher.test.mjs using publisherCliFilesystem, publisherFixture, and injected scheduleTimeout/cancelTimeout/now/poll. Advance a single virtual overall clock during sub-ten-minute propagation waits for multiple packages, exceed 25 minutes, and assert successful persisted evidence and exactly canonical ordered publication. Do not override overallTimeoutMs: exercise the production default. Observe failure with old default.
- [x] Add a deterministic sixty-minute expiry case using the same clock/scheduler and normal CLI flow; assert aborted signal, stopped progression and no successful report. Retain existing shortened-budget registry/poll cancellation and real subprocess-tree termination coverage; change their default assertion to 60 minutes. Add a workflow contract asserting publish-npm timeout 65 and five-minute headroom over PUBLISHER_OVERALL_TIMEOUT_MS. Observe expected red tests before implementation.
- [x] Change scripts/release/publisher.mjs constant to 60 * 60_000 and its explanatory comment, and only the publish-npm timeout in .github/workflows/release.yml to 65. Leave process-runner preparation defaults and all other limits unchanged.
- [ ] Run node --test scripts/release/test/publisher.test.mjs, focused workflow contract, scoped Biome and git diff --check. Independently review the source/tests. Regenerate the changed publisher pin in scripts/release/test/fixtures/release-script-hashes.json and its reviewed SHA256 snapshot in scripts/release/test/workflow-contracts.test.mjs. Update only the publish-npm timeout in the mirrored scripts/release/test/fixtures/release-workflow-b4-disabled.yml and workflow-entrypoints.json descriptor. Run node --test scripts/release/test/workflow-contracts.test.mjs and pnpm test:release-integrity, then full pnpm test:release-controller.
- [x] Preserve the old workflow-policy variant and add the exact new disabled variant in scripts/release/abandonment-workflow-policy.json and its existing EXPECTED_VARIANTS list in abandonment-workflow-policy.mjs. Preserve HEAD workflow bytes in test/fixtures/release-workflow-b4-before-publisher-budget.yml. In abandonment-reachability.test.mjs bind both variants to their fixtures, classify both disabled and assert only the publish-npm timeout differs. Run abandonment-reachability and preflight-owner/CLI tests before the full suite.
- [ ] Record the measured 0.8.34 failure/restart evidence and next-candidate measurement constraint in a short runbook. Commit and open a single focused PR related to #668 once CI capacity permits. All package behavior is unchanged; no changeset is expected.
- [ ] Merge exact reviewed head only after required CI and real vercel-native/copilotkit-examples-e2e pass. Monitor main rollout without extra dispatches. Measure the budget change on the next ordinary candidate containing it, not on an old tag or a synthetic release.
