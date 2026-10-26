# Shared Run Admission Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Steps use checkbox syntax for tracking.

**Goal:** Prevent competing replicas from executing the same thread or resuming the same browser callback concurrently, and fence stale storage writes.

**Architecture:** Request-scoped admission after authorization, Postgres leases with owner-checked short storage transactions, runtime release tied to actual execution lifetime, automatic generated-store wiring. Preserve local registry behavior for existing callers.

**Tech Stack:** TypeScript, existing pg/Neon structural SqlPool, Vitest, existing disposable Postgres/Testcontainers, pnpm/Turbo.

## Task 1: Storage ownership and fencing
- [ ] Add failing `packages/postgres-storage/test/run-admission.test.ts` cases for two pools, expiry, takeover, owner-fenced writes/transactions, safe release and renewal.
- [ ] Run and confirm expected failures.
- [ ] Define `RequestRunAdmission` in `packages/sdk/src/run-admission.ts`, export it from sdk.
- [ ] Implement `packages/postgres-storage/src/run-admission.ts` plus focused internal fenced-pool helper; add migration in the admission module through existing runMigrations component convention.
- [ ] Export constructor/types from main and node entries, without new dependencies. Run storage/SDK build, tests, lint, typecheck and real PG cases.

## Task 2: Runtime admission and release
- [ ] Add failing shared-handler tests in `packages/cli/test/shared-run-admission.test.ts`, using existing runtime fixtures.
- [ ] Extend `RequestStores` and add `packages/cli/src/lib/dev/request-run-admission.ts` for weak request binding and conflict responses.
- [ ] Bind/unbind request admissions in `runtime-fetch-core.ts`. Compose ownership loss into request shutdown signals.
- [ ] Claim after policy authorization before decisions in `agui-handler.ts` and AP run/state-mutation handlers.
- [ ] Await normal execution/admission release before closing successful responses; keep admission until detached work settles on cancellation/abandonment. Dispose as fallback.
- [ ] Verify local callers still pass with no admission configured; add denial, crash/error, immediate continuation and deferred-cleanup coverage.

## Task 3: Generated wiring and documentation
- [ ] Add failing build-output tests for admission constructor, fenced pool on all stores, readiness and disposal.
- [ ] Modify `packages/cli/src/lib/build/targets/web-runtime.ts` to create request admission and bind its pool to every request store. Await close before pool.end; include migration readiness.
- [ ] Document manual requestStores wiring and boundaries in postgres-storage README and deployment docs; add patch changeset for SDK/storage/CLI fixed group.
- [ ] Review spec compliance, then code quality. Resolve issues before proceeding.

## Task 4: Validation and handoff
- [ ] Run repository required source, release integrity, docs, pack and harness gates, plus disposable Postgres integration.
- [ ] Inspect the final diff, include exact verification outcomes and remaining release/hosted validation requirements in a PR, attach it.
- [ ] Do not merge/release b4.run or enable Hashbrown production without corresponding user authorization.

## Exact gates and correctness decisions

- Baseline: `pnpm --filter @b4run/cli exec vitest run test/run-registry.test.ts` (14 pass) and `pnpm --filter @b4run/postgres-storage exec vitest run test/driver-structural.test.ts test/edge-bundle.test.ts` (4 pass).
- Red storage: `pnpm --filter @b4run/postgres-storage exec vitest run test/run-admission.test.ts`; initially fails the missing public export assertion.
- Real storage: `B4_TEST_PGSTORAGE=1 pnpm --filter @b4run/postgres-storage exec vitest run test/run-admission.test.ts`; real disposable PG, including explicit BEGIN/COMMIT, nested-BEGIN rejection, rollback-on-release, pool-size-one reuse, expiry during an open transaction, late renewal/release after takeover.
- Runtime: `pnpm --filter @b4run/cli exec vitest run test/shared-run-admission.test.ts test/request-stores.test.ts test/run-registry.test.ts`; no ownership or partial allocation leaks; retry from terminal frame cannot beat delayed async release.
- Generated wiring: run changed build/web-runtime tests via `pnpm --filter @b4run/cli exec vitest run <changed-test-paths>`; verify Node/Neon constructors use the same fenced pool and migrations precede assumeMigrated.
- Integration: shared admission after thread authorization in AG-UI/AP stream/wait/resume, DELETE, workspace inspect. AP resume route middleware is after ownership/route discovery, before grant consumption. Add rejection tests for each gate.
- Full gates: `pnpm ci:validate` from root, then `B4_TEST_PGSTORAGE=1 pnpm --filter @b4run/postgres-storage test` and relevant CLI real-PG suite. Inspect exact failures; do not waive required gates.
- No nested transaction wrapper. Fenced-client release awaits rollback internally before underlying pool reuse. DB-clock validation immediately before COMMIT; late owner releases are CAS no-ops.
- Final scope: injected checkpoint/thread/permission/client-tool stores fenced; external memory, boot approval-grant persistence and tool side effects are not described as fenced. Preserve managed-workspace/requestStores refusal.
