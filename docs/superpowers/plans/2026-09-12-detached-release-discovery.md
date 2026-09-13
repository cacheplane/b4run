# Detached Release Discovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and independent code review.

**Goal:** Fix #636 without changing the publishing workflow.

**Architecture:** Reuse the canonical production main ref for scheduled history, matching the existing ancestry boundary.

**Tech Stack:** Node ESM, node:test, real local Git fixture.

Design: `docs/superpowers/specs/2026-09-12-detached-release-discovery-design.md`.

- [x] Add real detached-checkout tests in `scripts/release/test/candidate.test.mjs` for a completed release/no candidate, a new fixed-group candidate, and a missing canonical main ref (no managed tags/releases, so it reaches the scan). Assert detached HEAD/no-local-main fixture preconditions and terminal-verifier invocation. Run `node --test scripts/release/test/candidate.test.mjs`; verify the new positive cases fail with `REF_NOT_FOUND`.
- [x] In `scripts/release/candidate.mjs`, replace the scheduled scan's `ref: "main"` with `ref: PRODUCTION_MAIN_REF`. Make existing history assertions cover the canonical ref; rerun candidate tests green.
- [ ] Update `scripts/release/test/fixtures/release-script-hashes.json` and its digest in `scripts/release/test/workflow-contracts.test.mjs`. Run focused candidate/observer/workflow-contract tests, `pnpm test:release-integrity`, lint, and the full controller suite. Obtain independent implementation review.
- [ ] Submit one PR closing #636 and merge on green, including real Vercel/CopilotKit checks. Let existing runs finish before changing their head. Verify main CI and an ordinary release-detect no-op; do not publish a measurement release.
