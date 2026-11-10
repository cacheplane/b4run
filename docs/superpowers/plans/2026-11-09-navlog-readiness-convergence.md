# Navlog readiness convergence plan

**Goal:** Qualify a later exact valid readback after at most one patch, within the original API budget.

**Scope:** `.github/workflows/deploy-navlog.yml`, `scripts/release/test/workflow-contracts.test.mjs`, `scripts/release/test/fixtures/workflow-entrypoints.json`, `scripts/release/test/fixtures/workflow-safe-executables.json`, this plan and the matching spec. Isolated branch `blove/navlog-readiness-convergence-20261109` starts at main 71543329; preserve the diagnostic branch unmerged.

- [x] Coordinator approved the bounded read-only convergence direction; create isolated main-based worktree and author the later-match regression before implementation.
- [x] Frozen install succeeded, then actual baseline RED for one valid post-ack mismatch followed by a later valid match. Preserve raw result and require the expected readback-mismatch failure.
- [x] Implement a ten-readback maximum and one-second abort-aware gaps using the original shared signal. Keep mutation branch single-entry and all validation failures terminal; clean timers/listeners and require a validated match before upload.
- [x] Add meaningful synthetic cap/abort/error/no-op/output/query/own-upload-ID regressions; run focused GREEN, all workflow contracts, integrity and scoped formatting/whitespace checks under the sole local lane. No provider calls, build or unrelated full CI. Preserve raw outputs and owned process/group joins.
- [ ] Produce exact six-file diff/hash/validation receipt and release the local lane. Fresh SPEC then QUALITY review and root read precede further work.
- [ ] Any later commit/push/draft PR requires a distinct grant. Hold every merge/deploy/rerun while the explicit user production approval remains pending. No publication/version-PR action.

Actual outcomes: frozen install 0; baseline RED 1 with one expected readback-mismatch assertion; first regression GREEN 1/1; focused readiness 53/53; full workflow contracts 316/316; integrity 34/34; scoped formatting 0 (three files, no fixes); git diff --check 0. Raw logs: `/private/tmp/navlog-convergence-{install,red,first-green,focused,workflow,integrity,format,format-check}.log`. PID/PGID/start/deadline/exit/join evidence: `/private/tmp/navlog-convergence-owned-outcomes.log`; all eight owned producers joined and groups closed. No new provider request, production action, commit, push or PR was performed.
