# Navlog provider readiness implementation plan

> **For agentic workers:** Execute inline with the coordinator’s explicit source/heavy-lane grants. Use superpowers:executing-plans and the requested fresh spec/quality reviews.

**Goal:** Persist Railway `/readyz` healthcheck and 120-second timeout for production navlog-server via the existing project secret in Actions.

**Architecture:** Add one bounded inline API configuration step before upload. Validate credential target, read current settings, apply an exact environment-bound patch only when needed, and read back before proceeding. Preserve the existing upload/poll/probe and read-only diagnosis.

**Tech Stack:** GitHub Actions, Node 24 built-in fetch/streams, Railway GraphQL, existing node:test/vm workflow contracts and audited workflow descriptor fixtures.

## Task 1: Source review checkpoint

- [x] Coordinator reviews the spec, exact provider scope evidence, proposed six-file scope, and mocked-test matrix.
- [x] Confirm HTTPS main still equals the pinned baseline before implementation.
- [x] Obtain coordinator implementation grant; no Node/build/tests/API/PR/push under the initial source-only grant.

## Task 2: Operational tests and implementation

- [x] Extend `scripts/release/test/workflow-contracts.test.mjs` with a VM harness for the exact new inline step. Assert configuration executes only in deploy, before upload, using the existing secret.
- [x] Add meaningful tests for target binding, unchanged settings, exact patch, verified readback, safe failure behavior, bounded requests, and no mutation retries.
- [x] Under the heavy-lane grant, run `node --test --test-name-pattern='navlog readiness' scripts/release/test/workflow-contracts.test.mjs` and observe missing implementation failures.
- [x] Add the inline step to `.github/workflows/deploy-navlog.yml` using only fixed queries and the exact two-field environment patch in the spec.
- [x] Update only deploy-navlog’s changed descriptors and shifted step indexes in `scripts/release/test/fixtures/workflow-entrypoints.json` and `workflow-safe-executables.json`; do not modify the classifier.
- [x] Run focused new tests, full workflow contracts, and `pnpm test:release-integrity` from the worktree root. Focused readiness: 37 passed; full workflow contracts: 300 passed; release integrity: 34 passed. All exited 0. Initial regression RED exited 1 because the configuration step was absent.

## Task 3: Review, CI, and provider evidence

- [ ] Run scoped formatting and inspect the full diff for credential/error-body output and unintended scope.
- [ ] Request fresh spec then quality review through the coordinator; fix findings.
- [ ] Run the required verification lane under the coordinator’s exclusive heavy-work grant and inspect outcomes.
- [ ] Commit/push and create the PR only after explicit coordinator grant; wait for required checks and merge on green per user authorization.
- [ ] Observe the merged main deployment configuration log (safe before/after), exact uploaded deployment status, and public `/readyz` response. Report any provider failure without blind mutation retries.

Local verification uses an isolated temporary home, environment allowlist, synthetic API responses only, and child umask 022. Raw command output is preserved under `/private/tmp/navlog-provider-{install,red,green,workflow,integrity,docs,format,format-check}-20261109.log`. No provider API calls or publication operations have been performed.

The scoped Biome check passed (three files, no fixes); `git diff --check` passed. The docs completeness command exited 1 because this deliberately unbuilt checkout has no SDK/CLI `dist` output. Its only reported failures were the SDK errors import, CLI docs-bundle import, and CLI surface import. The subsequent authorized full `pnpm build` passed all 29 tasks (28 cached; 7.79 seconds), and the built docs check passed with “Docs completeness check passed.” Those raw outputs are preserved at `/private/tmp/navlog-provider-build-20261109.log` and `/private/tmp/navlog-provider-docs-built-20261109.log`; the original failed docs log remains unchanged. `/private/tmp/navlog-provider-build-docs-outcomes-20261109.log` records both producers exiting 0, joining, and closing their owned process groups. Full required PR CI and live provider configuration/rollout observation remain pending. The initial failed command had no remaining matching worktree/docs producer in a targeted escalated process audit. An earlier default-sandbox `ps` probe was denied; that probe did not alter the docs result.
