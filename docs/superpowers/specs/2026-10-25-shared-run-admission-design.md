# Shared run admission and callback ownership

The approved ATC rollout gate requires cross-replica serialization, single winning
browser-tool continuation, and protection from stale owners. The hosted report in
Hashbrown PR #760 reproduces lost canonical responses and duplicate continuations.

## Chosen behavior

Return retryable HTTP 409 (`run_in_flight`, `Retry-After: 1`) for a thread already
owned by another request. Do not queue in a serverless request. Admit only after
authentication, middleware, and thread authorization, but before reading the
checkpoint that decides a run/resume or accepting client-tool answers. AP resume
is an explicit ordering exception: authorize the thread, acquire shared ownership,
then derive its parked route and run route middleware; rejected middleware must
consume no grant/answer and release ownership. Keep the
process-local registry for local abort handles and draining.

## Shared ownership

Add SDK `RequestRunAdmission`: a request-scoped abort signal, asynchronous
`tryAcquire(threadId): Promise<boolean>`, and idempotent asynchronous `release()`.
A single instance owns at most one thread, and cannot be reused after release.
`RequestStores.runAdmission` supplies this optional coordination boundary.
Generated Postgres deployments install it automatically. Existing embedders and
local SQLite preserve their current local admission behavior.

Postgres implements a row per active thread with a random owner token and a
DB-clock expiry. Claim/renew/release are compare-and-set statements. Heartbeats
renew while execution is owned. Failure or expired ownership aborts the signal.
A crashed owner expires, allowing a later owner without operator cleanup.

A lease alone is insufficient. Expose the admission's fenced `SqlPool` and use it
for all runtime stores in that request. Once owned, every query/transaction locks
and validates the owner row and expiry in the same transaction as its effects;
validate again before commit. Expired owners cannot commit after takeover. Use
short transactions around store operations, not around model generation. Support
both pg and Neon pool structural APIs; no driver/dependency additions.

`pool.query` owns one short transaction. A checked-out client preserves explicit
BEGIN/COMMIT/ROLLBACK, locks the ownership row for that transaction, rejects nested
BEGIN, and validates again before COMMIT. Its synchronous release schedules and
completes any required rollback before returning the underlying connection; a
pool-size-one regression verifies no dirty connection can be reused. Idle mode
permits initialization and authorization queries; active mode always fences;
lost/released mode never falls back to an unfenced pool. Renewal uses
clock_timestamp(), cannot revive an expired owner, and release waits for any
in-flight renewal before owner-conditional deletion. An ownership failure is terminal.

Ownership survives cancelled responses until detached graph work and final
checkpoint/status writes settle. Normal completion must await release before the
next completed-response continuation can be admitted. Buffer successful terminal
frames (AG-UI RUN_FINISHED and AP success/end framing) until final writes and
awaited release complete, not merely until stream EOF. Test a follow-up triggered
by the terminal frame while release is deliberately delayed. Keep RunRegistry's
synchronous API; use a separate request-owned asynchronous finalizer, shared by
normal completion, detached cleanup and disposal. Disposal is the fallback
for validation errors and early returns. Never release on HTTP headers alone.

## Alternatives

Session advisory locks are not chosen: transaction-pooling and connection loss
cannot safely fence writes issued by other connections. A single replica or
process-local lock does not satisfy autoscaled deployment requirements. Holding
one transaction through a model call is avoided because it ties up a connection
and a long-running transaction for the entire generation.

## Scope and limitations

Coordinate AG-UI, AP stream/wait/resume, thread DELETE, and workspace inspection's
existing run exclusion. State/history GETs remain ordinary reads. Managed
workspaces already reject requestStores and remain outside this request-store
coordination mode; do not weaken that restriction in this patch. Fence the injected
checkpoint, thread, permission and client-tool stores. Separately configured
memory stores and boot-owned approval grants are not claimed to be SQL-fenced;
admission must precede callback/grant consumption, but external effects have no
exactly-once promise.
Do not claim distributed cancellation via the AP cancel endpoint or exactly-once
external tool effects; those need separate contracts. Fencing prevents stale
runtime storage commits. Conflicting callback answers retain existing first-answer
semantics. No release/publish or production backend switch is part of this change.

## Verification

Write failing tests before implementation. Use real disposable Postgres for
mutual exclusion, independent pools, expiry/takeover, late writes, wrong-owner
release, renewal, transaction rollback, naming, and pool lifecycle. Use two fetch
handlers sharing ownership for new-run contention, callback races with same and
different run IDs, delayed retries, complete histories, authorization-before-claim,
release-before-follow-up, disconnect/deferred cleanup, and failures. Verify emitted
Vercel/Workers wiring and edge bundle purity. Repeat the hosted probes only with a
built reviewed artifact; published consumers remain pinned until a separate release.
