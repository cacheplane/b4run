# Prose-only CI Performance Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Avoid full runtime CI for narrowly proven runbook-only edits while preserving full validation for release-bearing changes.

**Architecture:** Extend the existing scope classifier and metadata job; reuse the stable validate job to choose the expected outcomes. No new publishing workflow or gate.

**Tech Stack:** Node.js, Git, GitHub Actions YAML, Vitest.

## Tasks

- [ ] Baseline: frozen pnpm 10.33 install; run `pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts ci-scope` and release-integrity tests.
- [ ] Extend `test/k8s-compat/ci-scope.test.ts` with real Git path/mode/rename/empty/mixed cases and workflow gate truth-table regressions. Observe intended failures before implementation.
- [ ] Extend `scripts/ci-scope.mjs` and `scripts/ci-scope.d.mts` with a separate prose-only classification while retaining the metadata-only interface. Fail closed outside regular runbook Markdown paths. Add exact-diff whitespace checking for the prose path.
- [ ] Update `.github/workflows/ci.yml`: classifier output, prose validation, full-lane and auxiliary job conditions, and stable validate result expectations. Preserve main-push coverage and metadata exception.
- [ ] Update only the CI entries in both existing workflow audit inventories (`workflow-entrypoints.json`, `workflow-safe-executables.json`), and update release-integrity/workflow assertions only where the intended CI contract changes; no release content pins should change for CI-only code.
- [ ] Update `AGENTS.md` and `CONTRIBUTORS.md` with the narrow prose exception and submission guidance.
- [ ] Run focused tests, lint, integrity, full validation as appropriate to the existing Definition of Done; inspect any failure rather than bypassing checks.
- [ ] Obtain independent spec and quality review, commit, submit one PR, wait for all relevant technical checks, merge on green using the exact reviewed head.
- [ ] Verify a useful follow-up runbook-only PR takes the prose path, update measured evidence, and continue to the separately reviewed npm diagnostics change.

Independent spec/plan review passed. Raw modes must validate both sides (100644; zero only for the absent add/delete side), retain merge-base semantics, account for renames as delete/add, and reject malformed or contradictory scope outputs.


Quality review found that PR-owned classifier code could authorize its own skipped
validation. Extract the dependency-free classifier from the exact trusted base
SHA into a temporary `.mjs` file for both decisions, and default prose to false
when that base has no prose export. Exercise the actual workflow shell against a
forged PR classifier, a legacy base, a current base with qualifying runbook edits,
and a failing trusted classifier; assert cleanup and no forged execution. Update
only the affected CI command inventory and focused contracts.
