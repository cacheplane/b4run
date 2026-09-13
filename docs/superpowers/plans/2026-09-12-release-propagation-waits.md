# Release propagation waits implementation plan

> **For agentic workers:** Use superpowers:executing-plans for test-first implementation and independent review.

**Goal:** Avoid false terminal failures during already-budgeted npm and CI convergence.

**Architecture:** Add exact package-bound propagation classification inside the existing npm audit adapter; allow an absent validate job only for one valid active main CI run. Preserve all successful-proof requirements and existing budgets.

**Tech stack:** Node ESM, node:test, existing release adapters.

Design: `docs/superpowers/specs/2026-09-12-release-propagation-waits-design.md`.

## 1. npm audit

Files: `scripts/release/npm-audit.mjs`, `scripts/release/test/npm-audit.test.mjs`, existing publisher tests.

- [x] Add failing tests using the captured ETARGET/E404 shapes bound to the current package; verify scoped and unscoped names, wrong version/package/URL and batch rejection.
- [x] Test finite diagnostic codes without output/secrets and explicitly prove observable fatal E401/E403/integrity codes remain fatal, and pending followed by complete verified evidence.
- [x] Implement two exact summary matches and a finite diagnostic-code allowlist. Compute retry eligibility independently of whether a diagnostic code is emitted. Supply the validated single-package identity to the private classifier. Preserve batch and proof parsing.
- [x] Exercise existing publisher convergence/deadline/one-publication tests; add real audit-adapter integration if needed to demonstrate these new errors consume the same budget.

## 2. CI waiter

Files: `scripts/release/candidate.mjs`, `scripts/release/test/candidate.test.mjs`.

- [x] Reproduce active exact CI with no validate check failing prematurely.
- [x] Add absent→created→successful check, bounded absence, failed/completed/unknown-state and conflicting identity tests.
- [x] Return pending only for valid unique active main CI, null conclusion and zero named validate checks. Preserve exact success correlation.

## 3. Review and submission

Files: `scripts/release/test/fixtures/release-script-hashes.json`, digest in `scripts/release/test/workflow-contracts.test.mjs`, release performance runbook.

- [x] Update changed source pins and digest; run integrity and workflow contracts.
- [x] Run relevant focused and complete controller suites; lint and independent review.
- [x] Update performance runbook with behavior and measurement limits.
- [ ] Submit one PR, complete required hosted checks including Vercel and CopilotKit, and merge on green. Preserve active CI/release runs. Verify main checks without cutting another release.

Validation before submission: 3,847 complete controller tests, 440 focused/workflow-contract tests, 33 integrity checks, lint and documentation checks passed; independent implementation review found no actionable issues. CodeQL identified single-occurrence slash replacement. The follow-up uses `replaceAll` in the production matcher and both test helpers; package-name validation permits at most one slash, so accepted inputs retain identical behavior. The correction also received independent review and will receive full hosted validation before merge.
