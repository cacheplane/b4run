---
"@b4run/postgres-storage": patch
---

Fix the first request to a freshly provisioned schema failing with `23505` on `pg_namespace_nspname_index`. The checkpointer, threads store and permissions store each take an advisory lock keyed on schema, table prefix and component, deliberately so they version independently. The schema is the one object all three share, so creating it under those three different locks left them racing on `CREATE SCHEMA IF NOT EXISTS`, which is no more concurrency-safe than `CREATE TABLE IF NOT EXISTS`: the loser raised a duplicate-key error instead of a no-op, and the partly-created schema meant only a second run succeeded.

Schema creation now takes a lock keyed on the schema alone, in its own short transaction, so the shared DDL is serialized while the per-component migrations still run independently. This is the cold start after a deploy to a new environment, which is what `B4_PG_SCHEMA` exists for.
