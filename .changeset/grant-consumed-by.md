---
"@b4run/sdk": patch
"@b4run/cli": patch
"@b4run/sqlite-storage": patch
"@b4run/postgres-storage": patch
---

A consumed approval grant records who answered it. `InterruptGrantRecord` gains `consumedBy`, the `id` of the principal `src/auth.ts` resolved for the resuming request, or `null` for an anonymous answer. It's for audit only: grants stay caller-unbound, and no check reads it. `consume()` takes an optional `by`. The SQLite and Postgres grant stores add the `consumed_by` column in a new version-2 migration, and rows written before it read as `null`. A custom `InterruptGrantStore` must store and return the new field.
