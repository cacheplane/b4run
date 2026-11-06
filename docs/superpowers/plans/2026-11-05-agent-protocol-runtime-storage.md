# Agent Protocol Runtime and Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement coordinated durable execution and recovery on single-owner SQLite and shared Postgres.

**Architecture:** A backend transaction bundle owns Runs, checkpoints, grants, receipts and journal facts. Shared services perform admission, executor/control, state operations and projection; adapters supply real safe-boundary hooks. Store/memory and external tool effects remain separate transaction domains.

**Tech Stack:** TypeScript, node:sqlite DatabaseSync, Postgres SqlPool, LangGraph/LangChain adapters, Vitest, real subprocess/Testcontainers tests.

---

**Approved specs:** [Runtime](../specs/2026-11-05-agent-protocol-runtime-design.md), [wire](../specs/2026-11-05-agent-protocol-wire-design.md).
**Dependencies:** P0, C1–C5. All commands run from the B4 implementation root. Build before checks importing package dist. Keep this work on the integration branch; no API handler independently executes a graph.

## File boundaries

Create SDK `packages/sdk/src/agent-protocol/storage.ts` and export its types from
`agent-protocol/index.ts`. Create backend bundles under
`packages/sqlite-storage/src/runtime/` and `packages/postgres-storage/src/runtime/`:
`index.ts`, `schema.ts`, `transaction.ts`, `threads.ts`, `runs.ts`,
`checkpoints.ts`, `receipts.ts`, `journal.ts`, `inbox.ts`, `maintenance.ts`.
These files implement backend persistence, not duplicated business state machines.

Create services under `packages/cli/src/lib/dev/protocol/runtime/`:
`admission.ts`, `executor.ts`, `ownership.ts`, `permissions.ts`, `inputs.ts`,
`state.ts`, `projection.ts`, `retention.ts`, `webhooks.ts`.
Keep existing execute-route-core/agent adapters as the execution entry; extract
only responsibilities needed for the approved transaction/lifecycle boundary.

P0 verified that `packages/sdk/src/backend-adapter.ts` is the current shared
BackendAdapter owner and exposes only kind/execute/stream with a signal. R8/R10
extend that existing contract for the approved adapter hooks; those hooks are
required implementation work, not existing capabilities. Do not create a second
adapter interface or infer safe-boundary support from the current methods.

### R1: Define transaction bundle and real-backend conformance harness

**Files:** Create SDK storage.ts and `packages/sdk/test/agent-protocol-storage.contract.ts`; create `test/agent-protocol/runtime-storage-contract.ts`; modify SDK agent-protocol/index.ts exports. Backend test entrypoints are created/run in R2/R3, not falsely reported GREEN here.

- [ ] Define compile-contract cases for required transaction/fence/snapshot/delete/copy capabilities, reduced custom-store capabilities and portable DTO-only imports. A checkpointer get/put object must not typecheck as a full coordinated store.
- [ ] Run `pnpm --filter @b4run/sdk typecheck`; expect missing new public storage types/contract failures, not unrelated dependency failures.
- [ ] Implement the transaction-context interface for generation/fence, Run/checkpoint/pending/grant/receipt/journal operations, coherent snapshot, copy/delete and read leases. No unvalidated public principal/store handle enters it.
- [ ] Write shared actual-backend test declarations: injected failure after second grant consume restores both; commit exposes grant/continuation/receipt together; stale transaction fence fails. Parameterize only backend factory, deterministic IDs/clock and internal failure injection. The harness does not implement another admission algorithm.
- [ ] Run `pnpm build` and SDK typecheck to GREEN. No backend case is claimed run: R2 creates its SQLite entrypoint and R3 its real Postgres entrypoint, each invoking every shared assertion, including async callback failure rather than an unawaited DatabaseSync transaction Promise.
- [ ] Commit `test: define coordinated runtime storage contract` with explicit files and a fixed-group patch changeset. R1's exit is a compilable public interface/harness, not backend conformance certification.

### R2: Install fresh SQLite schema and exclusive owner

**Files:** Create SQLite runtime files; modify `packages/sqlite-storage/src/internal/db.ts` only to expose necessary options, `packages/cli/src/lib/runtime/execute-route.ts`, `packages/cli/src/lib/dev/boot-runtime.ts`; create `packages/sqlite-storage/test/runtime-storage.test.ts` and `packages/sqlite-storage/test/runtime-owner.test.ts` calling R1's shared assertions.

- [ ] Test fresh namespace, marker mismatch rejection before writes, restart durability, two-process exclusive ownership and untouched legacy file bytes.
- [ ] Run `pnpm --filter @b4run/sqlite-storage test runtime-storage runtime-owner`; expect new namespace/owner invariants to fail.
- [ ] Open `.b4/agent-protocol/v1/runtime.sqlite` with foreign keys/WAL and explicit durable commit settings (FULL for the runtime DB); do not globally change independent memory DB behavior. Store schema/installation marker and install coherent runtime tables.
- [ ] Implement a process-identity-verified exclusive lock for the database lifetime, safe stale-owner recovery and rejection of declared replicas/cluster workers. Thread/run/checkpoint IDs and generation ownership are real columns, not inferred timestamps.
- [ ] Rebuild and run the suites, including subprocess crash after commit/before publication and incompatible-store checksum comparison. Restart must preserve committed receipt/checkpoint facts.
- [ ] Commit `feat: add single-owner SQLite runtime storage`.

### R3: Install shared Postgres transactions and fenced writes

**Files:** Create Postgres runtime files; modify `packages/postgres-storage/src/schema.ts`, `internal/tx.ts`, `internal/fenced-pool.ts`, `options.ts`, `src/index.ts`; create `packages/postgres-storage/test/runtime-storage.test.ts` and `packages/postgres-storage/test/runtime-fence.test.ts` calling every R1 shared assertion.

- [ ] Add concurrent cold-boot/version tests, transaction rollback, explicit schema/prefix mismatch and stale writer after takeover. Use two real connections/processes, not two objects on one mock pool.
- [ ] Run `B4_TEST_PGSTORAGE=1 pnpm --filter @b4run/postgres-storage test runtime-storage runtime-fence`; verify no skip and expected invariant failures.
- [ ] Implement fresh `b4_ap_v1` naming under the configured schema and shared transaction context. Guard schema installation with advisory locks and marker validation before DDL. Keep old tables intact.
- [ ] Implement atomic generation/fence checks for every checkpoint/pending/projection/journal mutation, including adapter saver writes through the fenced pool. A stale cached connection cannot bypass the check.
- [ ] Rebuild/run both real-backend suites and existing schema-create-race/run-admission tests. Test independent instances see one committed outcome and malformed identifiers fail before SQL.
- [ ] Commit `feat: coordinate Postgres runtime state and fencing`.

### R4: Commit initial admissions and durable receipt lookup

**Files:** Create runtime/admission.ts; modify `request-run-admission.ts`, `run-registry.ts`, `packages/cli/src/lib/runtime/execute-route-core.ts`; create `packages/cli/test/protocol-admission.test.ts`, `protocol-receipts.test.ts`.

- [ ] Add lost-ack/concurrent retry tests, stateless identity reuse, changed input under one token, literal B4 operation selectors, injection/fork lookup, expired/gone/ambiguous lookup and current-auth-before-disclosure cases.
- [ ] Run `pnpm --filter @b4run/cli test protocol-admission protocol-receipts`; assert no duplicate accepted row/user message in the failure case.
- [ ] Implement normalize/fingerprint/authorize -> existing receipt -> new-operation expectations -> one Run/root/dispatch/journal/projection transaction. Apply resolved default values from the original receipt on exact retries.
- [ ] Implement indexed ledger lookup through the approved Run search selectors, returning the actual authorized Run plus query-scoped receipt state. Keep ordinary metadata equality and top-level response schemas intact.
- [ ] Rebuild/run focused suites and both backend conformance suites. Failpoint before/after commit must yield zero or one accepted Run, never an inferred success from transmitted bytes.
- [ ] Commit `feat: admit runs with durable submission reconciliation`.

Contract assertion:

```ts
const first = await fixture.admit(request)
fixture.loseNextAcknowledgement()
const recovered = await fixture.admit(request)
expect(recovered.runId).toBe(first.runId)
expect(await fixture.countRunsForSubmission(request.submissionId)).toBe(1)
expect(await fixture.lookup(request.submissionId)).toMatchObject({ state: "accepted" })
```

The fixture methods call actual service/backend code; they do not implement
another admission algorithm inside the test.

### R5: Dispatch, started boundary and ownership recovery

**Files:** Create runtime/executor.ts, ownership.ts; modify `serve-runtime.ts`, `execute-route-server.ts`, `execute-route-core.ts`; create `packages/cli/test/protocol-dispatch.test.ts`, `protocol-owner-loss.test.ts`, `fixtures/protocol-runtime-worker.ts`.

- [ ] Test accepted-never-started dispatch, crash after started marker, forced owner loss, late terminal winner, two-process claim and missed NOTIFY with polling. Use a scratch-file counter to prove uncertain effects are not repeated.
- [ ] Run `pnpm --filter @b4run/cli test protocol-dispatch protocol-owner-loss`; expect dispatch/restart failures.
- [ ] Implement durable dispatch and atomic startedAt/owner/fence before graph invocation. Built-in lease is 60 s/heartbeat 15 s, durable poll 1 s; injectable clocks accelerate tests without changing product defaults.
- [ ] Classify proven never-started versus started-lost work. Fence stale writes before releasing ownership; record error/execution_lost/effectsUncertain rather than rerun started graphs. Never infer death from a socket or empty registry.
- [ ] Rebuild/run crash tests on SQLite and two-process Postgres; assert actual counter remains one and stale owner writes reject. Record terminal state through the common service.
- [ ] Commit `feat: dispatch accepted runs with fenced recovery`.

### R6: Permission pause, complete resume and remembered-rule intents

**Files:** Create runtime/permissions.ts; modify `approval-grants.ts`, `pending-interrupts.ts`, `packages/core/src/capabilities/permission-gate.ts`, `packages/permissions/src/thread-store.ts`; create `packages/cli/test/protocol-permissions.test.ts`.

- [ ] Test one/full-batch, duplicate/missing/foreign prompt, once/always/deny, grant modes, Always=false, expiry negative abandonment, protected proposal edits and failures after partial consumption.
- [ ] Run `pnpm --filter @b4run/cli test protocol-permissions`; verify a failed batch consumes no grants and starts no continuation.
- [ ] Implement exact paused-generation validation and one transaction consuming all grants/admitting a linked continuation/saving receipt. Lookup exact accepted retries before rejecting their consumed pause. Preserve nested namespace and current caller authority.
- [ ] Enlist native permission DB writes or persist idempotent remembered-rule intents in the same acceptance transaction; apply the existing configured-scope rule before protected execution. I/O failure cannot execute under a falsely remembered rule. Test intent retry without replay after later user rule edits.
- [ ] Rebuild/run focused tests plus approval-grants-agent-route/subagent-interrupts. Confirm allowAlways=false maps to once, configured deny/constraints prevail and expired positives cannot act.
- [ ] Commit `feat: resume permission batches atomically`.

### R7: Exact-run stop, cleanup intent and shutdown

**Files:** Modify runtime/executor.ts, admission.ts, permissions.ts; create `packages/cli/test/protocol-cancel.test.ts`, `protocol-temporary-cleanup.test.ts`, `protocol-shutdown.test.ts`.

- [ ] Add both stop/resume race orders, stale predecessor stop, queued/running/parked states, wait false/true, observer versus owning-stream closure, REST overrides, parked temporary thread and finalizer-versus-successor tests.
- [ ] Run `pnpm --filter @b4run/cli test protocol-cancel protocol-temporary-cleanup protocol-shutdown`; assert zero graph invocations for parked Stop.
- [ ] Persist exact-target control rows and retire paused eligibility without permission answers/new Run. Hold ownership until actual unwind; late controls never select current successor by Thread pointer.
- [ ] Implement binding cleanup intent propagation, REST re-evaluation, independent result retention and generation/head guarded finalization. Implement drain/deadline/shutdown outcomes; forced loss stays uncertain. Provider read leases block conflicting cleanup.
- [ ] Rebuild/run focused tests on real stores. Assert old interrupted outcome remains historical, no second native terminal is required, and late old finalizer cannot erase a new Run.
- [ ] Commit `feat: stop exact executions and preserve cleanup intent`.

### R8: Safe-boundary injection and checkpoint rebinding

**Files:** Create runtime/inputs.ts; modify `packages/sdk/src/backend-adapter.ts`, `packages/langchain/src/agent-adapter.ts`, `agent-middleware.ts`, `packages/langgraph/src/langgraph-adapter.ts`, `packages/cli/src/lib/runtime/execute-route-core.ts`; create `packages/cli/test/protocol-injection.test.ts`, `protocol-safe-head.test.ts`.

- [ ] Test steering during model/tool work, FIFO bounds, duplicate tokens, root/child authority, privileged system input, pause/finish race and pending tools after stop/lost owner.
- [ ] Run `pnpm --filter @b4run/cli test protocol-injection protocol-safe-head`; a real test model must consume injected text at its next eligible step.
- [ ] Implement bounded exact-Run/namespace inbox and owner-applied checkpoint+applied-disposition boundary before the next model step. Preserve accepted/applied/not_applied identity; never drain into a successor or resume permissions automatically.
- [ ] Implement adapter checkpoint-rebind hooks that retire future executable source tasks without running them. Preserve lost-effect uncertainty; mark not-executed only with durable proof. Unsupported custom hooks fail explicitly before state mutation.
- [ ] Rebuild/run focused and relevant langchain middleware tests; assert no concurrent graph invoke and no protected source action on a fresh post-stop user turn.
- [ ] Commit `feat: apply active input and safely rebind stopped checkpoints`.

### R9: Coherent journal, snapshots and bounded history

**Files:** Create runtime/projection.ts; modify backend journal/checkpoint files; create `packages/cli/test/protocol-recovery.test.ts`, `protocol-history.test.ts`, `protocol-filter-replay.test.ts`.

- [ ] Test append-before-publish crash, unchanged old event bytes, initial hydration frames, snapshot H versus concurrent events, eventId/seq mapping, namespace filters, paging fragments, generation mismatch and history invalidation.
- [ ] Run `pnpm --filter @b4run/cli test protocol-recovery protocol-history protocol-filter-replay`; verify tests fail on the existing coalesced hub approach.
- [ ] Implement per-generation ordered append/materialization and coherent Thread/ThreadState metadata. Hydration is a derived unsequenced values frame at the exact requested boundary, never current state followed by older deltas.
- [ ] Implement authenticated generation/revision/branch history cursors, page fragments without fake checkpoints, stable item identities and complete pending/open activity. Invalid/expired/ahead replay is explicit resync. No user-controlled runtime metadata.
- [ ] Rebuild/run real-store replay tests and bounded-observer tests. Check filtered gaps do not trigger false loss, widened coverage recovers, and partial output/uncertain activities survive restart.
- [ ] Commit `feat: materialize coherent protocol recovery and history`.

### R10: State PATCH, copy and fork

**Files:** Create runtime/state.ts; modify backend checkpoints/threads files and adapter hooks in the existing SDK contract owner `packages/sdk/src/backend-adapter.ts`, `packages/langchain/src/agent-adapter.ts` and `packages/langgraph/src/langgraph-adapter.ts` as needed; create `packages/cli/test/protocol-state-operations.test.ts`.

- [ ] Test no-execution PATCH/copy, merge/message rules, ignored metadata-only checkpoint, full copied history, stable remapped checkpoint IDs, source/destination authority, root/child fork and unresolved protected tasks.
- [ ] Run `pnpm --filter @b4run/cli test protocol-state-operations`; count model/tool calls rather than only responses.
- [ ] Implement locked append-only state revisions and coherent copy with fresh destination ownership/protected provenance. Do not clone grants, native aliases, thread-local allow rules, live sandbox handles or usable client-tool receipts.
- [ ] Implement source-scoped checkpoint resolution and one-Run fork with returned canonical IDs. Lock source/destination in UUID order; use prepared invisible rows where cross-copy work cannot fit one transaction. Unsafe rebind/workspace reconstruction refuses before exposure.
- [ ] Rebuild/run tests across backend and adapter profiles; assert later source deletion does not destroy an independent copy or relabel inherited private data public.
- [ ] Commit `feat: implement authorized thread state copy and fork`.

### R11: Rollback and explicit deletion

**Files:** Modify runtime/state.ts; create backend maintenance implementation and `packages/cli/test/protocol-rollback.test.ts`, `protocol-delete.test.ts`.

- [ ] Test active/paused/latest-settled eligibility, dependent successors/branches, cleanup crash/retry, owned nested checkpoints, spent grants and unchanged workspace/Store/external effects.
- [ ] Run `pnpm --filter @b4run/cli test protocol-rollback protocol-delete`; assert obsolete rollback fails before even interrupting another execution.
- [ ] Implement maintenance preflight/record -> exact-run unwind -> target-owned cleanup/head restore/invalidation under exclusion. Keep failure recoverable and busy; keep private retry tombstones, not a publicly readable fake Run.
- [ ] Implement finished/non-actionable Run deletion versus explicit Thread cascade/logical revocation. Provider teardown is durable idempotent cleanup; seven-day escalation does not silently abandon the obligation. Never delete a shared app workspace or independent copies/Store.
- [ ] Rebuild/run process/crash tests. wait=true proves cleanup completion; ordinary deleted resources return absence and stale replay/history cannot resurrect them.
- [ ] Commit `feat: coordinate rollback and resource deletion`.

### R12: Retention, quotas and webhook delivery

**Files:** Create runtime/retention.ts, webhooks.ts; modify backend maintenance/inbox/schema; create `packages/cli/test/protocol-retention.test.ts`, `protocol-webhooks.test.ts`.

- [ ] Test 24h/64MiB raw replay, seven-day settled receipts/temp results, unresolved obligations, materialization prerequisite, seq overflow, quota failure and large pending/output behavior. Test callback payload at permission settlement, restart/retry and expired delivery budget.
- [ ] Run `pnpm --filter @b4run/cli test protocol-retention protocol-webhooks`; force boundary time/size using internal clocks and controlled data, not actual multi-day sleeps.
- [ ] Implement independent retention classes and private spent-token safety. Enforce advertised inbox/observer/request/prompt quotas without silent truncation; raw replay eviction never deletes history/pending grants. Rollback and explicit deletion apply their distinct scopes.
- [ ] Implement durable webhook RunWaitResponse payload and stable B4-Webhook-Id, five attempts/10-minute budget and per-attempt timeout. Validate/authorize destination before acceptance; dial approved DNS address with original TLS name, no redirects/caller auth leakage; explicit policy permits private scratch targets for tests.
- [ ] Rebuild/run tests with a real local callback listener under explicit test policy. Assert duplicate delivery is possible/documented, never duplicate execution; unsupported hosts reject webhook before admission.
- [ ] Commit `feat: enforce runtime retention and durable callbacks`.

## Exit checkpoint

Run all new service tests and shared actual-backend conformance. Then run the
current required repository gates and relevant Postgres/sandbox/fault lanes.
Record exact counts/skips/backend settings. HTTP/AG-UI/host end-to-end proof
belongs to bindings/release plans; do not claim that backend unit tests close
those gates. Freeze the transaction/adapter interfaces for downstream binding
and client work, with no hidden replay of uncertain effects.
