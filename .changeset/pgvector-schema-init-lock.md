---
"@b4run/memory-pgvector": patch
---

Make `initSchema` safe to run from several cold starts at once. Every statement it issues uses `IF NOT EXISTS`, which makes each one idempotent but not concurrency-safe: two sessions running the same statement race on the catalog and the loser raises `23505` instead of a no-op, on `pg_extension` for the extension, `pg_namespace` for the schema, `pg_type` for a table and `pg_class` for an index. A serverless deploy scaling from zero cold-starts several isolates that all initialize the same database, and the store's in-process memoization covers one process only.

The pass now runs in one transaction holding an advisory lock keyed on the schema and table prefix it builds, so concurrent callers queue and each one after the first no-ops through work that is already done. This is the same defect `@b4run/postgres-storage` carried as issue #709.
