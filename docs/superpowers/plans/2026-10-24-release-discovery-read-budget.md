# Release discovery pagination budget implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task with independent review before merge.

**Goal:** Let complete historical GitHub inventories fit a bounded operation budget while preserving each HTTP request's current deadline and every release authority check.

**Architecture:** Separate the GitHub reader's configurable pagination budget from its request timeout. Default callers retain existing limits; the production CLI explicitly selects a 60-second pagination budget. Explicit recovery read deadlines must still cap the whole operation. Preserve serial pagination, cancellation, byte/page/record bounds, identity and provenance verification, and the workflow deadline.

**Tech Stack:** Node.js release-controller modules and node:test.

## Evidence and scope

Candidate `de0fdca77bf92cb8efaafb4c43c6d9d6630f0d59` remains frozen.
Exact reconciliation 40116393474 blocked before tag/publication. Logging-only
read-only instrumentation reproduced historical 0.8.28 terminal verification
failing on GitHub `commit-check-runs` and `releases` timeouts. An isolated full
observer succeeds with no diagnostics. The checks API has eight pages; its first
response took 14,580ms, and the current complete-operation limit is 15,000ms.
Release history has five pages. Warm-cache retries do not repair this capacity
problem. Filtering pre-floor tags would save only six reads and is not the fix.

No publishing bypass, shortened inventory, disabled check, changed package bytes,
overlapping invocation or publisher rerun is authorized by this repair.

## Tasks

- [x] Add adapter regressions for an eight-page inventory exceeding the request
  timeout in aggregate but completing within a dedicated pagination budget;
  prove exhaustion still prevents further requests and explicit recovery
  deadlines remain controlling. Verify these fail for the intended reason.
- [x] Add the minimal validated pagination-budget option in
  `scripts/release/adapters/github.mjs`; preserve the per-request timeout cap.
- [x] Configure the production CLI reader in `scripts/release/cli.mjs` and test
  its factory boundary in `scripts/release/test/observe-production.test.mjs`.
- [x] Run the focused adapter/production/controller tests and required integrity
  checks. Update content pins and the digest snapshot in the same commit.
- [x] Run a complete read-only production discovery with the fix, retaining
  actual output and timing before any further reconciliation.
- [x] Independently review the exact change; create a PR and pass exact-head CI,
  then merge without changing the frozen package candidate.
- [x] Follow the ordinary supported controller, verify the immutable release,
  all package bytes/signatures/smokes/audit and charts, then save final evidence.
