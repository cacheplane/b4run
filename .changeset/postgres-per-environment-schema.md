---
"@b4run/cli": patch
"@b4run/postgres-storage": patch
---

Namespace generated Postgres stores per deployment environment. The `hono` and `vercel` targets' `stores.mjs` now reads `B4_PG_SCHEMA` and `B4_PG_TABLE_PREFIX` per request, each a lowercase identifier or a `$NAME` reference to another variable, so `B4_PG_SCHEMA=$VERCEL_ENV` keeps a Vercel project's preview and production deployments in separate schemas of one database. Unset bindings keep `public.b4_*`. A bad value fails the request by name instead of falling back to `public`. `@b4run/postgres-storage` now rejects mixed-case `schema` and `tablePrefix` values, which unquoted DDL folded to lowercase anyway, and exports the `IDENTIFIER_PATTERN` it enforces.
