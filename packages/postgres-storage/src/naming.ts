import { DEFAULT_SCHEMA, DEFAULT_TABLE_PREFIX, IDENTIFIER_PATTERN } from "./schema.js"

/** Where a set of stores puts its tables, resolved from environment variables. */
export interface ResolvedNaming {
  readonly schema: string
  readonly tablePrefix: string
}

/**
 * Read `B4_PG_SCHEMA` / `B4_PG_TABLE_PREFIX` the way a generated deployment
 * does.
 *
 * `@b4run/cli`'s `hono` and `vercel` targets emit the same rules inside their
 * `stores.mjs` (`namingBinding` in
 * `packages/cli/src/lib/build/targets/web-runtime.ts`), reading a per-request
 * `env` object rather than `process.env` because workerd has no `process`.
 * That copy cannot be replaced by a call into this one — it runs before this
 * package is even in scope on some targets — so the two are kept deliberately
 * in step, the same arrangement as `IDENTIFIER_PATTERN` and
 * `@b4run/memory-pgvector`: change one, change the other.
 *
 * `env` is REQUIRED and has no `process.env` default. This module is reachable
 * from the edge-safe main entry, where `process` is not merely empty but
 * UNDECLARED — reading it is a ReferenceError, and a default parameter would
 * put that reference in the bundle whether or not anyone called it without an
 * argument. `@b4run/postgres-storage/node` passes `process.env`.
 *
 * The `$NAME` form resolves to another variable, which is what lets a single
 * deployment config write `B4_PG_SCHEMA=$VERCEL_ENV` and get `preview` and
 * `production` in separate schemas of one database. Unset or empty keeps the
 * package defaults, so an existing deployment that sets neither keeps its
 * `public.b4_*` tables.
 */
export function namingFromEnv(env: Readonly<Record<string, string | undefined>>): ResolvedNaming {
  return {
    schema: resolve(env, "B4_PG_SCHEMA", DEFAULT_SCHEMA),
    tablePrefix: resolve(env, "B4_PG_TABLE_PREFIX", DEFAULT_TABLE_PREFIX),
  }
}

function resolve(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: string,
): string {
  const raw = env[name]
  if (raw === undefined || raw === "") return fallback
  let value = raw
  if (raw.startsWith("$")) {
    const source = raw.slice(1)
    // `$` alone names nothing, so it is never looked up — otherwise the error
    // would read "references , which is not set".
    const resolved = source === "" ? undefined : env[source]
    if (resolved === undefined || resolved === "") {
      throw new Error(
        `postgres-storage: ${name} is ${JSON.stringify(raw)}, which references ` +
          `${source === "" ? "an empty variable name" : `${source}, and that variable is not set to a non-empty string here`}. ` +
          `Set ${name} to a literal identifier, or to $NAME for a variable this deployment sets.`,
      )
    }
    value = resolved
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `postgres-storage: ${name} must resolve to a lowercase SQL identifier (${IDENTIFIER_PATTERN}), ` +
        `got ${JSON.stringify(value)}${raw === value ? "" : ` from ${raw}`}.`,
    )
  }
  // The validated string, not the original: the two differ for a reference,
  // and only this one has been checked.
  return value
}
