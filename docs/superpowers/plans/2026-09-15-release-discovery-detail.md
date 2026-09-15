# Release Discovery Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Preserve useful, bounded discovery failure detail without changing publishing behavior.

**Architecture:** Reuse cli.mjs safeDetail in the discovery catch when building its diagnostic. The persisted report remains the operator surface; controller policy and workflow outputs do not consume detail.

**Tech Stack:** Node.js ESM, node:test, existing release CLI and integrity pins.

Spec: docs/superpowers/specs/2026-09-15-release-discovery-detail-design.md.

- [ ] Add a regression in scripts/release/test/observe-production.test.mjs injecting a plain Error from discoverScheduledCandidate via the CLI's existing loader fixture. Assert detail appears in returned/persisted report while the plan remains blocked and no mutations are authorized. Run it and observe failure.
- [ ] Add cases for bounded credential-redacted detail and hostile getters, reusing scripts/release/test/cli-failure-detail.test.mjs coverage rather than duplicating its whole matrix.
- [ ] In scripts/release/cli.mjs attach safeDetail(error) only to the discovery failure diagnostic. Preserve all authorization and code/classification behavior.
- [ ] Run node --test scripts/release/test/observe-production.test.mjs scripts/release/test/cli-failure-detail.test.mjs, scoped Biome, and git diff --check.
- [ ] Review source independently; update the intentional cli.mjs SHA256 pin and fixture digest in workflow-contracts.test.mjs. Run focused integrity/workflow-contract tests then the full controller suite.
- [ ] Continue the read-only pinned-npm replay. If it identifies a different root-cause defect, document and test that defect before any further production edit; do not guess a candidate-selection fix.
- [ ] Open a PR, merge only after required CI and production-boundary lanes pass, and inspect the resulting report. Existing authorization to continue, PR, merge on green, and monitor applies; no new release dispatch or workflow cancellation.
