# Workspace Installation Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Give local workspace storage one durable installation identity and one active runtime owner, with recoverable first-start crashes.

**Architecture:** An internal SQLite installation owner holds a writer transaction in a separate admission database for its lifetime. A committed initializing/ready record coordinates bootstrap with the FULL-synchronous state database. Source storage operates through this owner; no public config or runtime path accepts managed workspace options until provider integration can enforce them.

**Tech Stack:** Node 24 node:sqlite, TypeScript, Vitest, child processes.

---

This independently testable prerequisite implements the ownership portion of `docs/superpowers/specs/2026-09-14-workspace-implementation-contracts.md`. Build/config wiring follows it. The existing runtime and app remain unchanged. No PR before the requested corrected-app walkthrough.

## Files and contract

- Create `packages/sqlite-storage/src/workspace/installation.ts`: filesystem bootstrap, admission lock, identity validation, connection cleanup.
- Create `packages/sqlite-storage/test/workspace-installation.test.ts`: reopen, failure, corruption and concurrent-process tests.
- Create `test/fixtures/workspace-installation-worker.ts`: actual process owner used for SIGKILL testing.
- Reuse `packages/sqlite-storage/src/workspace/source-store.ts` without exposing a raw connection.
- Update `packages/sqlite-storage/README.md`: internal component and single-host limits.
- Add `.changeset/workspace-installation-ownership.md`: patch sqlite-storage.

Internal API:

```ts
interface WorkspaceInstallation {
  readonly installationId: string
  readonly sources: WorkspaceSourceStore
  close(): void
}
function openWorkspaceInstallation(appRoot: string): WorkspaceInstallation
```

The owner opens `<canonical appRoot>/.b4/workspaces/admission.sqlite` and `state.sqlite`. Database paths must be regular files; reject symlink state-directory descendants and database files. App-root symlink aliases may canonicalize to the same installation. Local trusted host tree only; no hostile-host openat/whole-directory-loss guarantee.

## Task 1: Installation ownership implementation

- [x] Write failing tests for first open, persisted UUID on reopen, source put/get surviving reopen, same-process second connection refusal, and idempotent close with operations rejected after close.
- [x] Run `pnpm --filter @b4run/sqlite-storage test -- workspace-installation.test.ts`; observe expected missing implementation failure.
- [x] Implement admission metadata `(version=1, installation_id UUID, phase initializing|ready)` with exactly one row. Set synchronous FULL and busy_timeout=0 before mutation. Hold BEGIN IMMEDIATE throughout the returned owner's lifetime. No provider work is possible during bootstrap.
- [x] For fresh admission (absent or empty database only; reject unrelated nonempty databases) under the writer lock, refuse pre-existing state. Persist initializing UUID, commit, reacquire immediately. If reacquisition loses, close and fail; do not touch state unlocked. Reload/validate metadata after reacquisition because another process may have advanced it.
- [x] Under the guard, create state identity `(version=1, installation_id)` and source tables in one state transaction. Initializing may resume missing/empty state, or matching fully initialized state. Reject unrelated/nonempty/incomplete state. Ready requires both identity and existing complete source schema; never silently recreate missing source tables.
- [x] Persist ready admission metadata only after the state transaction commits. Commit and reacquire admission; reload and validate matching identities before returning. A concurrent winner may own the installation: losing reacquisition fails safely.
- [x] Return guarded source operations; close state then rollback/close admission. Constructor failure closes both connections and releases the guard; never deletes storage as error recovery. Do not expose test fault injection in the production API.
- [x] Run focused tests and scoped typecheck; resolve failures.

## Task 2: Recovery and failure qualification

- [x] Add tests creating on-disk bootstrap states corresponding to crashes before the first admission metadata commit, before state creation, after state commit and before ready metadata. Verify safe recovery retains UUID/source bytes.
- [x] Add rejection tests for ready admission with missing/empty/mismatched state, state without admission, unsupported versions, invalid UUID/phase, incomplete tables, symlinks, and metadata errors. Verify failures release connections and never repair corruption.
- [x] Spawn a real child process holding the owner, verify another process cannot open, SIGKILL owner, then reopen with original UUID/source bytes. Use IPC readiness and bounded deadlines, no timing sleeps. Ensure child cleanup even if assertions fail.
- [x] Add canonical app-root alias test and validate concurrent callers resolve to the same lock.
- [x] Run focused tests repeatedly only where new crash/concurrency coverage warrants it; then run all sqlite-storage tests and typecheck.

## Task 3: Review, documentation and verification

- [x] Independent spec and quality review; fix actionable findings with regression tests.
- [x] Document that the internal owner is not wired into runtime yet, one local host/active owner, concurrent thread operations remain possible, process death releases lock, whole-directory loss/network filesystems/multi-host unsupported.
- [x] Add patch changeset; run `pnpm build`, `pnpm --filter @b4run/sqlite-storage test`, `pnpm --filter @b4run/sqlite-storage typecheck`, `pnpm lint`, `node scripts/check-docs.mjs`, `git diff --check`.
- [x] Record exact evidence and outstanding runtime/build integration. Commit locally using explicit files, no PR/push.

## Following integration constraints

Inspection found `loadB4ConfigUncached` throws for both missing config and import/validation errors. `build.ts`, `resolve-sandbox.ts`, and direct route execution currently swallow load errors. Workspace configuration must not be enabled until callers distinguish a genuinely absent config from an invalid or unreadable required configuration. Checking a generic ENOENT from a transitive import is insufficient: absence must be established for the config file itself.

Build integration must capture before cleaning existing artifacts, carry the verified bundle into Node deployment artifacts, and import those bytes at built startup without rereading the source checkout. Unsupported targets must fail before emission. Accepting `sandbox.workspace` while the legacy manager ignores it would violate the approved design; do not publish that partial behavior.


## Verification evidence

Implemented on `blove/code-fixer-app-correction`, 2026-09-14. Independent plan,
spec-compliance, and quality reviews passed. The implementation observed failing
behavior tests before passing them. Review found SQL LIKE's underscore wildcard
could misclassify an unrelated `sqliteXcustom` table; an observed failing
regression now protects the exact reserved-prefix check.

- `pnpm --filter @b4run/sqlite-storage test`: 7 files, 72 tests passed, including
  33 installation tests and real child-process exclusion/SIGKILL recovery.
- `pnpm --filter @b4run/sqlite-storage typecheck`: passed.
- `pnpm build`: 26 tasks passed.
- `pnpm lint`: 28 tasks passed.
- `node scripts/check-docs.mjs`: passed.
- `git diff --check`: passed before commit.

Bootstrap crash boundaries are represented by injected durable database states;
no production fault-injection API was added. The precise commit/reacquire race
windows are defended in code and reviewed, but are not deterministically
fault-injected by tests. Exact schema-constraint introspection beyond identity,
version, required columns/tables and verified bundle readback remains optional
hardening. Whole-repository `pnpm ci:validate` and Docker qualification have not
been rerun for this storage-only prerequisite. Build/config artifacts, provider
lifecycle integration, runtime ownership wiring and the app walkthrough remain
outstanding; no PR or push is part of this step.
