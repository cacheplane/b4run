# npm Audit Diagnostics Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Avoid full release restarts for recognized transient npm audit failures and preserve safe diagnostic evidence.

**Architecture:** Classify full command results inside the existing npm audit adapter; map recognized single-package transient failures into the publisher's existing pending loop. Batch verification still rejects errors. No publishing workflow changes.

**Tech Stack:** Node.js, npm 11.17.0, node:test.

- [ ] Baseline frozen pnpm 10.33 install and targeted npm audit/publisher tests.
- [ ] Add failing regressions in `scripts/release/test/npm-audit.test.mjs` for exact transient/error envelopes, strict exit-code correlation, ambiguous/unknown/fatal responses, and single/batch diagnostics without secret output.
- [ ] Add failing publisher regressions in `scripts/release/test/publisher.test.mjs` proving recognized transient failures use the existing bounded convergence loop, fatal failures do not poll, abort/deadline remain effective, and no duplicate upload occurs.
- [ ] Implement the smallest shared command-result classifier in `scripts/release/npm-audit.mjs`. Wire safe logging through the existing adapter/publisher interfaces only if necessary. Keep batch errors fatal and all positive evidence checks intact.
- [ ] Refresh reviewed release content pins only for affected release-reachable modules; preserve workflow and permission inventories.
- [ ] Run targeted tests, lint, integrity and complete controller suite; complete repository-required validation/CI, independent spec and quality reviews.
- [ ] Submit only after the preceding CI optimization PR's active runs finish. Normal main refresh, no force push, no live release mutation. Merge on green at the exact reviewed head.
