# Agent Protocol Store and Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve standard generic Store and the authoritative managed-memory projection with atomic review across all writers.

**Architecture:** StoreService routes literal namespace/key addresses to generic adapters or the memory domain coordinator. Memory HTTP, CLI, Inspector and runtime writes share namespace-serialized mutation/revision/receipt primitives. There is no transaction across runtime checkpoints and external memory/tool effects.

**Tech Stack:** TypeScript, node:sqlite, Postgres/pgvector, Vitest, Fetch, existing Navlog/Inspector consumers.

---

**Approved spec:** [Store and memory review](../specs/2026-11-05-agent-protocol-store-design.md); wire 10–11 governs shared error framing.
**Dependencies:** P0 and C1/C2/C5. S1–S4 may develop independently of the execution runtime after the shared contracts freeze; HTTP composition waits for B1's route boundary. Do not change the already-approved memory namespace/record/approval policy.

## File responsibilities

Create `packages/sdk/src/store.ts` for public Store access/adapter types;
`packages/memory/src/mutation-coordinator.ts`, `revision.ts`, `review-receipts.ts`
for domain coordination; generic adapters in
`packages/sqlite-storage/src/store/{index,schema}.ts` and
`packages/postgres-storage/src/store/{index,schema}.ts`;
`packages/cli/src/lib/dev/protocol/{store-service,routes-store}.ts` for HTTP.
Existing memory backends remain authoritative; do not copy MemoryRecords into a
second generic document table or expose runtime internal records through Store.

### S1: Add complete identity lookup and domain mutation contract

**Files:** Modify `packages/memory/src/types.ts`, `reconcile.ts`, `sqlite-store.ts`, `packages/memory-pgvector/src/pgvector-store.ts`, `queries.ts`, `schema.ts`; create mutation-coordinator.ts and `packages/memory/test/mutation-coordinator.test.ts`.

- [ ] Test concurrent same-identity approvals, A→B→A and already-active writes, more than 10000 same-scope records and more than 50 matching candidates. Assert exactly one active semantic fact, no overwritten superseded history and preserved canonical recency on dedup.
- [ ] Run `pnpm --filter @b4run/memory test mutation-coordinator`; expect current bounded-scan/concurrent behavior failures.
- [ ] Add transaction-aware namespace mutation context and complete indexed identity lookup to both backends. Identity comparison preserves typed JSON semantics and canonical scope bytes; no arbitrary scan cap is an invariant check.
- [ ] Change reconciliation to run inside that context for every applicable kind. Detect pre-existing multiple-active invariant conflicts as explicit 409-domain errors; do not silently repair or change procedural-write support.
- [ ] Run focused SQLite tests and `B4_TEST_PGVECTOR=1 pnpm --filter @b4run/memory-pgvector test`; ensure actual Postgres transactions collect/run. Test process-level competing writers and rollback on injected failure.
- [ ] Commit `feat: coordinate authoritative memory identity mutations` plus fixed-group patch changeset.

Core invariant assertion:

```ts
const results = await Promise.all([review(candidateA), review(candidateB)])
expect(await store.activeByIdentity(scope, identity)).toHaveLength(1)
expect(await store.get(previouslySupersededId)).toMatchObject({ status: "superseded" })
expect(results.every((r) => r.committed)).toBe(true)
```

Create the review fixture using the actual coordinator/backend; do not serialize
requests only in the test wrapper and claim the product now serializes them.

### S2: Add generic Store adapters and literal-address conformance

**Files:** Create generic adapter files above and SDK store.ts; modify storage/package exports and `packages/sdk/src/index.ts`; create `test/agent-protocol/store-contract.ts`, `packages/sqlite-storage/test/store.test.ts`, `packages/postgres-storage/test/store.test.ts`.

- [ ] Test namespace/key tuples (including equal keys in different scopes, root [], Unicode/empty components), full replacement/no-op PUT timestamps, delete absent, deterministic order and JSON equality filter semantics.
- [ ] Run `pnpm --filter @b4run/sqlite-storage test store` and real `B4_TEST_PGSTORAGE=1 pnpm --filter @b4run/postgres-storage test store`; assert collection and expected missing-adapter failures.
- [ ] Implement separate compatible generic storage, preserving configured data across fresh runtime generation. Use tuple keys, not delimiter-joined strings. Do not apply managed memory reconciliation to generic PUT.
- [ ] Implement prefix/suffix namespace component matching, depth truncation/dedup-before-pagination and filter-before-page order. Return live offset pages without pretending a frozen snapshot.
- [ ] Rebuild/run both adapter suites and package type/pack checks. Test mixed namespace traversal cannot fall through the reserved managed prefix into generic storage.
- [ ] Commit `feat: implement generic Agent Protocol Store backends`.

### S3: Revisions, conditional mutation and approval receipts

**Files:** Create revision.ts, review-receipts.ts; modify both memory coordinators/backends; create `packages/memory/test/review-revision.test.ts`, `review-receipts.test.ts`.

- [ ] Test changed values at equal timestamps, stale approval/reject, deleted candidate/canonical-key dedup, identical-key retries, changed payload under one key and seven-day expiry. Verify affected snapshots correspond to the committed transaction.
- [ ] Run `pnpm --filter @b4run/memory test review-revision review-receipts`; expect unguarded mutation failures.
- [ ] Implement private monotonic/opaque item revision independent of timestamp/data-derived ID and strong public ETags. Conditional generic/managed mutation must compare in the mutation transaction, not a separate GET then write.
- [ ] Commit Idempotency-Key approval receipts, canonical item/action/superseded/removed snapshots and replay classification with the domain mutation. Preserve canonical timestamps on dedup and stable retry identity after candidate removal.
- [ ] Run focused tests and actual pgvector equivalents. Full receipt expiry returns reconciliation-required behavior; no blind reapproval or authority based only on an old token.
- [ ] Commit `feat: guard Store review with revisions and receipts`.

### S4: Shared writer integration and ask revalidation

**Files:** Modify `packages/core/src/capabilities/built-in/memory.ts`, `packages/cli/src/commands/memory.ts`, `packages/cli/src/lib/dev/memory-handler.ts`, `packages/memory/src/reconcile.ts`; modify `packages/inspector/app/api/memory/[id]/approve/route.ts`, `packages/inspector/app/api/memory/[id]/reject/route.ts`, `packages/inspector/app/api/memory/[id]/forget/route.ts` and `packages/inspector/src/store/resolve.ts` as coordinator callers; use `git grep 'approveWithReconcile' -- packages/inspector` to catch additional callers. Create `packages/cli/test/protocol-memory-writers.test.ts`.

- [ ] Test runtime auto/ask/candidate/off, CLI approve/reject/prune/consolidate, Inspector and HTTP races on one identity. Exercise a changed candidate while human approval/embedding work is pending; distinguish Once versus Always/headless policy.
- [ ] Run `pnpm --filter @b4run/cli test protocol-memory-writers memory-command`; confirm existing independent writer paths fail the invariant case.
- [ ] Route all writes through the domain coordinator. Do human/embedding I/O outside DB transactions, then revalidate revision/proposal on entry. New logical candidate ID on superseded-address collision is stable per operation; never demote an active identical record.
- [ ] Preserve existing memory scope/default policy and kind-specific semantics, and reject unsupported coordinator combinations before writing. Do not introduce a new Inspector public API or b4app memory UI.
- [ ] Rebuild/run writer/CLI/Inspector tests and real backend concurrency. Assert no long transaction spans user wait and no unrelated memory records/scopes disappear during runtime cutover.
- [ ] Commit `refactor: share memory mutation coordination across writers`.

### S5: Store dispatch, authorization and HTTP routes

**Files:** Create store-service.ts, routes-store.ts; modify `packages/core/src/config.ts`, SDK store.ts, protocol routes composition and existing CORS runtime support; create `packages/cli/test/protocol-store-http.test.ts`, `protocol-store-policy.test.ts`.

- [ ] Add ordinary CRUD/search/namespaces and approval wire fixtures: repeated ordered namespace query, omitted root [], DELETE JSON/empty 204, explicit approve namespace/key/if_revision, ETag/If-Match, stale revision and all auth-before-pagination/receipt cases.
- [ ] Run `pnpm --filter @b4run/cli test protocol-store-http protocol-store-policy`; verify generic metadata/root semantics do not accidentally become global ID lookup.
- [ ] Dispatch reserved [b4,memory,opaqueScope] into the authoritative backend with full public MemoryRecord values/dates; keep embeddings/internal revision private. Implement explicit StoreAccessPolicy: configured authentication without generic policy denies generic access by default; memory review-all does not grant it.
- [ ] Apply exact approved filter/operators/order/page bounds. Default raw managed PUT is denied; optional candidate policy cannot promote/forge provenance/bypass coordination. Remove old memory candidate GET/approve/reject routes; approval is the sole extra Store operation.
- [ ] Rebuild/run focused HTTP/CORS/auth tests and actual schema fixtures. Expose required ETag/If-Match headers through existing CORS; no runtime journal/grant/receipt data is reachable through generic Store.
- [ ] Commit `feat: expose standard Store and managed memory review`.

### S6: Navlog/scaffold review and complete client behavior

**Files:** Modify `examples/navlog/web/app/api/b4/[...path]/route.ts`, `examples/navlog/web/app/lib/memory-candidates.ts`, `examples/navlog/web/app/lib/use-memory-candidates.ts`, their exact matching `packages/devkit/templates/app-navlog/web` copies and existing MemoryPanel/proxy tests. Create `examples/navlog/web/app/lib/memory-review-operations.ts`, its scaffold copy, `examples/navlog/web/app/lib/memory-review-operations.test.ts`, and `packages/cli/test/protocol-review-consumer.test.ts`.

- [ ] Test owner-only method/address allowlists, namespace/key retention, GET/ETag hydration, stale-card reconfirmation, conditional rejection and empty 204. Add lost response after committed dedup/removal, reload with pending intent, changed request under one key, receipt expiry and current canonical refetch cases.
- [ ] Run `pnpm --filter @b4-example/navlog-web test memory-review-operations MemoryPanel` and `pnpm --filter @b4run/cli test protocol-review-consumer`; verify tests collect and old URL/no-receipt behavior fails.
- [ ] Before an intended approval, persist one UUID Idempotency-Key plus exact namespace/key/if_revision/fingerprint and creation/expiry context in the review-operation module, scoped to the authorized proxy/session/deployment. Keep it through reload/lost acknowledgement until settled or explicitly reconciled. Send only that key for identical retries; a changed card/decision requires new user confirmation and a new intended operation, never mutation of the stored request.
- [ ] Forward Idempotency-Key and approved conditional headers through the narrow owner proxy, preserving principal/address checks; expose/read ETag through existing CORS. Recover a lost response by the same key/body within its advertised receipt window, including when dedup deleted the candidate. After recovery, refetch current canonical resources because receipt snapshots describe the original commit. After expiry refetch/reconcile and require a fresh deliberate review; do not blindly replay or infer rejection from absence.
- [ ] Replace old list/read/approve/reject calls with Store search/GET/approve/conditional DELETE and full canonical outcomes. Do not parse 204 as JSON or blanket-allow Store deletion. Refresh cards only after committed/recovered outcome; changed/unauthorized failures remain visible. Apply identical scaffold operation persistence/header/retry behavior, with no grant or endpoint secret in stored UI intent.
- [ ] Rebuild/run hook/proxy/consumer and required example tests. Assert one committed approval, no duplicate supersession or recency update under lost response/reload, and deliberate reconfirmation after expiry. Commit `refactor: use retry-safe Store memory review consumers` with explicit files.

## Exit checkpoint

Run generic/managed Store conformance on the actual supported SQLite/Postgres
backends and cross-writer race suites, then required repo checks. Verify the
reserved prefix/namespace encoding, existing memory values/timestamps/scope and
no-new-b4app-memory-UI boundary against the approved spec. Packed/generated and
live qualification follow the release plan; runtime fresh namespace must not
reset memory or generic Store data.
