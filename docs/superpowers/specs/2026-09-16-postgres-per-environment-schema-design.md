# Per-environment schema for generated Postgres stores

Issue: cacheplane/b4run#682.

## Problem

`b4 build` for the `hono` and `vercel` targets emits `stores.mjs`, which builds
the checkpointer, threads store and permissions store with the package
defaults: schema `public`, table prefix `b4`. One Neon database attached to
both the preview and production environments of a Vercel project therefore
shares `public.b4_*` between the two, unless the stores are hand-composed.

The stores themselves already accept `schema` and `tablePrefix`. The gap is
the generated wiring, which exposes neither.

## Design

### Runtime bindings

`stores.mjs` reads two new bindings per request, through the same `binding`
helper as `DATABASE_URL`:

| Binding | Store option | Default |
|---|---|---|
| `B4_PG_SCHEMA` | `schema` | `public` |
| `B4_PG_TABLE_PREFIX` | `tablePrefix` | `b4` |

A value is either a literal identifier or a reference of the form `$NAME`,
which resolves to the value of binding `NAME` read the same way. The reference
form is what makes one setting serve every environment: on Vercel,
`B4_PG_SCHEMA=$VERCEL_ENV` yields the schema `preview` on a preview deployment
and `production` on a production deployment. `B4_ENV` or any other variable
works the same way.

Unset bindings keep the package defaults, so an existing deployment that sets
neither continues to use `public.b4_*`.

### Validation

The resolved value must match `^[a-z_][a-z0-9_]*$`. A literal that does not
match, a reference to an unset binding, or a reference whose value does not
match throws an error naming the binding. It does not fall back to `public`:
a typo silently writing production data into the shared default schema is
the bug this feature exists to prevent.

`assertIdentifier` in `@b4run/postgres-storage` tightens from
`/^[a-z_][a-z0-9_]*$/i` to the case-sensitive pattern. Postgres folds an
unquoted identifier to lowercase, so a mixed-case value never named the
object the caller wrote, and the advisory-lock key derived from it differed
from the lowercase spelling of the same tables.

### Migration bookkeeping

The isolate-level `migrated` boolean becomes a `Set` keyed by
`${schema}.${prefix}`. Bindings are per request, so two namespaces served by
one isolate each get their own cold-start pass. `runMigrations` already issues
`CREATE SCHEMA IF NOT EXISTS`, so a fresh schema needs no extra step.

## Tests

- `packages/postgres-storage/test/schema.test.ts`: lowercase-only pattern.
- `packages/postgres-storage/test/threads.test.ts` (gated real Postgres):
  two stores with the same prefix in different schemas hold independent data
  and create their tables under their own schema.
- `packages/cli/test/hono-target.test.ts`: the emitted `stores.mjs` is run
  with stubbed drivers and asked what naming it passed to each store, for the
  literal, reference, unset, invalid and dangling-reference cases, and for
  the per-namespace migration pass.

## Docs

`deployment/edge.mdx`, `persistence.mdx`, `api/postgres-storage.mdx` and the
package README describe the bindings and the recipe.
