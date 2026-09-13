# Release propagation waits implementation plan

> **For agentic workers:** Use superpowers:executing-plans for test-first implementation and independent review.

**Goal:** Avoid false terminal failures during already-budgeted npm and CI convergence.

**Architecture:** Add exact package-bound propagation classification inside the existing npm audit adapter; allow an absent validate job only for one valid active main CI run. Preserve all successful-proof requirements and existing budgets.

**Tech stack:** Node ESM, node:test, existing release adapters.

Design: `docs/superpowers/specs/2026-09-12-release-propagation-waits-design.md`.

## 1. npm audit

Files: `scripts/release/npm-audit.mjs`, `scripts/release/test/npm-audit.test.mjs`, existing publisher tests.

- [ ] Add failing tests using the captured ETARGET/E404 shapes bound to the current package; verify scoped and unscoped names, wrong version/package/URL and batch rejection.
- [ ] Test finite diagnostic codes without output/secrets, and pending followed by complete verified evidence.
- [ ] Implement two exact summary matches and a finite diagnostic-code allowlist. Supply the validated single-package identity to the private classifier. Preserve batch and proof parsing.
- [ ] Exercise existing publisher convergence/deadline/one-publication tests; add real audit-adapter integration if needed to demonstrate these new errors consume the same budget.

## 2. CI waiter

Files: `scripts/release/candidate.mjs`, `scripts/release/test/candidate.test.mjs`.

- [ ] Reproduce active exact CI with no validate check failing prematurely.
- [ ] Add absent→created→successful check, bounded absence, failed/completed/unknown-state and conflicting identity tests.
- [ ] Return pending only for valid unique active main CI, null conclusion and zero named validate checks. Preserve exact success correlation.

## 3. Review and submission

Files: `scripts/release/test/fixtures/release-script-hashes.json`, digest in `scripts/release/test/workflow-contracts.test.mjs`, release performance runbook.

- [ ] Update changed source pins and digest; run integrity and workflow contracts.
- [ ] Run relevant focused and complete controller suites; lint and independent review.
- [ ] Update performance runbook with behavior and measurement limits.
- [ ] Submit one PR, complete required hosted checks including Vercel and CopilotKit, and merge on green. Preserve active CI/release runs. Verify main checks without cutting another release.
