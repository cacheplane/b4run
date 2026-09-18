import type { PoolClient } from "pg"

/** pgvector index dimension ceilings: plain vector ≤2000, halfvec ≤4000. */
export function vectorColumnDef(dimensions: number): { type: string; ops: string } {
  if (!Number.isInteger(dimensions) || dimensions <= 0)
    throw new Error(`pgvector: dimensions must be a positive integer, got ${dimensions}`)
  if (dimensions <= 2000) return { type: `vector(${dimensions})`, ops: "vector_cosine_ops" }
  if (dimensions <= 4000) return { type: `halfvec(${dimensions})`, ops: "halfvec_cosine_ops" }
  throw new Error(
    `pgvector: ${dimensions} dims exceeds the 4000 halfvec index ceiling; reduce embedding dimensions or use a smaller model`,
  )
}

/**
 * The one shape a schema or table prefix may take.
 *
 * Deliberately identical to `@b4run/postgres-storage`'s `IDENTIFIER_PATTERN`.
 * The two packages keep separate copies because this one depends on
 * `@b4run/memory`, not on the agent-state stores, and a dependency edge purely
 * to share four lines would drag that package's LangGraph peers in with it.
 * Change one, change the other.
 */
export const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/

/**
 * Guard SQL identifiers that are interpolated into DDL (they can't be bound as
 * $1 placeholders in Postgres). `prefix`/`schema` come from the store's own
 * config, not untrusted query input, but a malformed config must not produce
 * broken/injected DDL — so reject anything that isn't a plain identifier.
 *
 * Lowercase only: `initSchema` below interpolates these UNQUOTED, and Postgres
 * folds an unquoted identifier to lowercase. A value like `MySchema` therefore
 * created `myschema` and never named the object the caller wrote — so the
 * configured name and the real name are now required to be the same string.
 */
export function assertIdentifier(name: string, value: string): void {
  if (!IDENTIFIER_PATTERN.test(value))
    throw new Error(
      `pgvector: ${name} must be a lowercase SQL identifier (${IDENTIFIER_PATTERN}), got ${JSON.stringify(value)}`,
    )
}

/** Namespaces B4.run's advisory locks away from any the host application takes. */
const ADVISORY_LOCK_CLASS = 0x4441574e

/** FNV-1a 32-bit, coerced to the signed int4 `pg_advisory_xact_lock` accepts. */
function advisoryLockId(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash | 0
}

/**
 * Idempotent, concurrency-safe schema init.
 *
 * `IF NOT EXISTS` makes each statement idempotent but NOT safe to run
 * concurrently: two sessions executing the same one race on the catalog and the
 * loser raises 23505 rather than a no-op — `pg_extension` for the extension,
 * `pg_namespace` for the schema, `pg_type` for a table, `pg_class` for an
 * index. A serverless deploy scaling 0→N cold-starts N isolates that all run
 * this against an uninitialized database, and the memoization in
 * `pgvector-store.ts` covers one process only.
 *
 * So the whole pass runs in ONE transaction holding `pg_advisory_xact_lock`
 * keyed on the schema and prefix it builds: concurrent callers queue, and every
 * one after the first finds the work done and no-ops through it.
 * `@b4run/postgres-storage` carried the same defect as issue #709.
 */
export async function initSchema(
  client: PoolClient,
  opts: { prefix: string; schema: string; dimensions: number; m: number; efConstruction: number },
): Promise<void> {
  const { prefix, schema, dimensions, m, efConstruction } = opts
  assertIdentifier("prefix", prefix)
  assertIdentifier("schema", schema)
  const t = `${schema}.${prefix}_memories`
  const tk = `${schema}.${prefix}_tokens`
  const { type, ops } = vectorColumnDef(dimensions)

  await client.query("BEGIN")
  try {
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      ADVISORY_LOCK_CLASS,
      advisoryLockId(`pgvector:${schema}.${prefix}`),
    ])
    await client.query("CREATE EXTENSION IF NOT EXISTS vector")
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    await client.query(`CREATE TABLE IF NOT EXISTS ${t} (
      id text PRIMARY KEY, kind text NOT NULL, namespace text NOT NULL, content text NOT NULL,
      data jsonb NOT NULL, source jsonb NOT NULL, confidence real NOT NULL, tags jsonb NOT NULL,
      status text NOT NULL, supersedes jsonb, created_at text NOT NULL, updated_at text NOT NULL,
      effective_at text, expires_at text, embedding ${type}, embedding_model text)`)
    await client.query(`CREATE TABLE IF NOT EXISTS ${tk} (
      memory_id text NOT NULL REFERENCES ${t}(id) ON DELETE CASCADE, token text NOT NULL)`)
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${prefix}_ns_status_updated ON ${t} (namespace, status, updated_at DESC)`,
    )
    // Equality filter for kind-scoped windows; COALESCE(effective_at, created_at)
    // ordering is intentionally unindexed at this scale.
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${prefix}_ns_kind_effective ON ${t} (namespace, kind, effective_at DESC)`,
    )
    // The global browse order + keyset seek. `id COLLATE "C"` matches SQLite's BINARY
    // tie-break; `updated_at` is deliberately UNCOLLATED so the store's ORDER BY (also
    // uncollated) keeps matching it. That rests on every stored updated_at being the
    // same fixed-width ISO form — MemoryRecord types it as a bare string and nothing
    // enforces it, and mixed widths make glibc collation and byte order disagree,
    // silently splitting the two backends' order.
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${prefix}_updated_id ON ${t} (updated_at DESC, id COLLATE "C" ASC)`,
    )
    // browse()'s namespace clauses are C-collated on both sides — `= $1` and the
    // half-open `>= $1 AND < $2` — and the default-collation composite above cannot
    // serve either. stats() and prune() still match with `left(namespace, n) = $1` and
    // get nothing from this index.
    await client.query(`CREATE INDEX IF NOT EXISTS ${prefix}_ns_c ON ${t} (namespace COLLATE "C")`)
    await client.query(`CREATE INDEX IF NOT EXISTS ${prefix}_tok ON ${tk} (token)`)
    await client.query(`CREATE INDEX IF NOT EXISTS ${prefix}_tok_mem ON ${tk} (memory_id)`)
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${prefix}_hnsw ON ${t} USING hnsw (embedding ${ops}) WITH (m = ${m}, ef_construction = ${efConstruction})`,
    )
    await client.query("COMMIT")
  } catch (error) {
    // Leave the caller a usable connection rather than one stuck in an aborted
    // transaction, and never let the rollback's own failure mask the cause.
    try {
      await client.query("ROLLBACK")
    } catch {}
    throw error
  }
}
