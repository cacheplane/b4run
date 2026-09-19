---
"@b4run/postgres-storage": patch
"@b4run/testing": patch
"@b4run/sdk": patch
---

Add an application document store: a versioned JSON document written with compare-and-swap, with a Postgres backend and an in-process one.

B4.run persisted everything it owns — checkpoints, threads, permission grants — and nothing an application owns, so every stateful agent app rebuilt the same layer beside it and rebuilt its bugs with it.

`@b4run/sdk` now exports the contract and the in-process implementation: `Document`, `DocumentStore`, `ConflictError`, and `createMemoryDocumentStore`. `create(value)` inserts under a generated key; `commit(key, version, value)` replaces a document only if it is still at that version; `commit(key, null, value)` inserts under a caller-supplied key and fails if the row exists, which is how a binding keyed by someone else's id is claimed exactly once across instances. A rejected write throws `ConflictError` — one class, exported from the SDK, so `instanceof` holds whichever backend produced it.

`@b4run/postgres-storage` adds `createPostgresDocumentStore`, plus `documentStoreFromEnv` and `closeDocumentStoresFromEnv` on the `/node` entry: Postgres when `DATABASE_URL` is set and process memory when it is not, memoized per process and per store name, with a failed cold start deliberately not memoized. All document stores in a database share one `<prefix>_documents` table keyed `(store_name, doc_key)`; the store name is a bound parameter rather than an identifier, so it can never collide with a B4.run table. `schema`/`tablePrefix` and the `B4_PG_SCHEMA` / `B4_PG_TABLE_PREFIX` bindings apply exactly as they do to the other three stores, and `namingFromEnv` is exported for wiring that reads them directly.

The in-process store is not a mock: it enforces compare-and-swap and deep-copies values in and out, and `@b4run/testing` exports `runDocumentStoreConformance`, one suite answered by both implementations — in-process on every run, and against real Postgres in the `B4_TEST_PGSTORAGE` lane.

The table is created by a numbered, forward-only migration under the existing advisory lock rather than by a bare `CREATE TABLE IF NOT EXISTS`, which never alters a table that already exists. A shipped migration is frozen and every insert names every column, so no column default can be the difference between a fresh database and an old one — the failure mode that the reference implementation this was extracted from actually hit.
