---
"@b4run/cli": patch
"@b4run/postgres-storage": patch
---

Namespace generated Postgres stores per deployment environment. The `hono` and `vercel` targets' `stores.mjs` now reads `B4_PG_SCHEMA` and `B4_PG_TABLE_PREFIX` per request, each a lowercase identifier or a `$NAME` reference to another variable, so `B4_PG_SCHEMA=$VERCEL_ENV` keeps a Vercel project's preview and production deployments in separate schemas of one database. Unset bindings keep `public.b4_*`. A bad value fails the request by name instead of falling back to `public`. Behavior change in `@b4run/postgres-storage`: `schema` and `tablePrefix` must now be lowercase. A mixed-case value previously passed validation and was folded to lowercase by unquoted DDL, so it never named the tables it appeared to, and its advisory-lock key differed from the lowercase spelling of the same tables. Such a value now throws at construction. Pass the lowercase spelling the database was already using. The enforced pattern is exported as `IDENTIFIER_PATTERN`.
