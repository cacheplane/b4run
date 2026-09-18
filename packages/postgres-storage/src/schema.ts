import { withTransaction } from "./internal/tx.js"
import type { SqlPool } from "./sql.js"

/**
 * The one shape a schema or table prefix may take. Exported so generated wiring
 * can reuse it.
 *
 * `@b4run/memory-pgvector` keeps a deliberate copy of this, for the same reason
 * and enforcing the same rule — it interpolates unquoted too, but depends on
 * `@b4run/memory` rather than on this package. Change one, change the other.
 */
export const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/

/**
 * Guard SQL identifiers that are interpolated into DDL (Postgres cannot bind
 * them as `$1` placeholders). `prefix`/`schema` come from the store's own
 * config, not untrusted query input, but a malformed config must not produce
 * broken/injected DDL — so reject anything that isn't a plain identifier.
 *
 * Lowercase only, deliberately: every identifier here is interpolated
 * UNQUOTED, and Postgres folds an unquoted identifier to lowercase. A value
 * like `MySchema` therefore never named the object the caller wrote — the
 * tables landed in `myschema` — while the advisory-lock key derived from the
 * original spelling differed from the one `myschema` would take, so two
 * spellings of one namespace did not serialize their migrations against each
 * other. Rejecting mixed case makes the configured name and the real name the
 * same string.
 */
export function assertIdentifier(name: string, value: string): void {
  if (!IDENTIFIER_PATTERN.test(value))
    throw new Error(
      `postgres-storage: ${name} must be a lowercase SQL identifier (${IDENTIFIER_PATTERN}), got ${JSON.stringify(value)}`,
    )
}

/** Default table/index prefix. Two apps can share one database by varying it. */
export const DEFAULT_TABLE_PREFIX = "b4"

/** Default Postgres schema the stores create their tables in. */
export const DEFAULT_SCHEMA = "public"

/** Where a store's tables live. Both parts are identifier-checked on construction. */
export interface TableNaming {
  readonly schema: string
  readonly prefix: string
}

/** Fully-qualified name for one of a store's logical tables. */
export function qualify(naming: TableNaming, table: string): string {
  return `${naming.schema}.${naming.prefix}_${table}`
}

/**
 * One forward-only schema step. Versioned rather than "CREATE IF NOT EXISTS and
 * hope", mirroring `@b4run/sqlite-storage`'s migrate.ts, so later shape
 * changes are expressible.
 */
export interface Migration {
  readonly version: number
  readonly up: (naming: TableNaming) => string
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
 * Apply every migration newer than what the database already has.
 *
 * The whole thing runs inside ONE transaction holding `pg_advisory_xact_lock`.
 * That is not belt-and-braces: an edge deploy scaling 0→N cold-starts N
 * processes that migrate simultaneously, and concurrent `CREATE TABLE IF NOT
 * EXISTS` / migration-row inserts against a virgin database fail with 23505 on
 * the `pg_type` catalog index and on the migrations primary key. A memoized
 * in-process `ready()` only covers the single-process race.
 *
 * `component` gives each store its own migrations table and its own lock, so
 * the three stores in this package version independently and do not serialize
 * against each other.
 *
 * The schema itself is the one object they DO share, so it cannot be created
 * under a per-component lock: three components hold three different locks and
 * race each other on `CREATE SCHEMA IF NOT EXISTS`, which is no more
 * concurrency-safe than the `CREATE TABLE IF NOT EXISTS` above and fails the
 * loser with 23505 on `pg_namespace`. {@link ensureSchema} takes a lock keyed
 * on the schema alone, in its own short transaction, so the shared DDL is
 * serialized without making the three stores serialize for the whole of their
 * migrations.
 */
/**
 * Create the schema every component in it shares, under a lock keyed on the
 * schema alone.
 *
 * Kept to its own transaction rather than folded into the caller's: holding a
 * schema-wide lock for the length of a migration pass would serialize all
 * three stores against each other, which is exactly what the per-component
 * lock exists to avoid. Committing the schema separately is safe because
 * creating it is idempotent and additive — a later failure leaves an empty
 * schema, never a wrong one.
 */
async function ensureSchema(pool: SqlPool, schema: string): Promise<void> {
  // Fast path: read the catalog first. The schema almost always exists — the
  // default `public` always does — and a schema that exists needs no lock, no
  // transaction, and no DDL. This keeps a cold start at one advisory lock per
  // component, which is what it cost before this guard existed.
  //
  // The check is an optimization and NOT the correctness mechanism. Two cold
  // starts can both read "missing" and both proceed; the lock below is what
  // makes the DDL safe, and `IF NOT EXISTS` under it makes the loser a no-op.
  const existing = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])
  if (existing.rows.length > 0) return

  await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      ADVISORY_LOCK_CLASS,
      advisoryLockId(`schema:${schema}`),
    ])
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
  })
}

export async function runMigrations(
  pool: SqlPool,
  migrations: readonly Migration[],
  opts: { readonly schema: string; readonly prefix: string; readonly component: string },
): Promise<void> {
  const { schema, prefix, component } = opts
  assertIdentifier("schema", schema)
  assertIdentifier("tablePrefix", prefix)
  assertIdentifier("component", component)
  const naming: TableNaming = { schema, prefix }
  const versions = qualify(naming, `${component}_migrations`)
  const sorted = [...migrations].sort((a, b) => a.version - b.version)

  await ensureSchema(pool, schema)

  await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      ADVISORY_LOCK_CLASS,
      advisoryLockId(`${schema}.${prefix}.${component}`),
    ])
    await client.query(`CREATE TABLE IF NOT EXISTS ${versions} (version integer PRIMARY KEY)`)
    const res = await client.query<{ v: number | null }>(
      `SELECT max(version) AS v FROM ${versions}`,
    )
    const current = res.rows[0]?.v ?? 0
    for (const migration of sorted) {
      if (migration.version <= current) continue
      await client.query(migration.up(naming))
      await client.query(`INSERT INTO ${versions} (version) VALUES ($1)`, [migration.version])
    }
  })
}

/**
 * `created_at`/`updated_at` are app-generated ISO-8601 strings kept as `text`,
 * not `timestamptz`: a `Thread` is serialized straight to JSON on the wire, so
 * the exact string the store handed out must come back unchanged. ISO-8601
 * sorts lexicographically, so `ORDER BY updated_at DESC` is still chronological
 * — under `COLLATE "C"`, which is byte ordering and therefore independent of
 * the database's locale.
 *
 * `metadata` is `jsonb` so a merge is one atomic `||` rather than a
 * read-modify-write. Note that `pg` parses jsonb on read: the driver hands back
 * an object, and `JSON.parse`-ing it again would throw.
 */
export const THREADS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (naming) => `
      CREATE TABLE IF NOT EXISTS ${qualify(naming, "threads")} (
        thread_id text PRIMARY KEY,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'idle'
      );
      CREATE INDEX IF NOT EXISTS ${naming.prefix}_threads_updated_idx
        ON ${qualify(naming, "threads")} (updated_at COLLATE "C" DESC);
    `,
  },
]

/**
 * One row per granted pattern, rather than one JSON document per store: that is
 * what makes `addAllow` an `INSERT … ON CONFLICT DO NOTHING` — atomic across
 * instances, where the file store's read-modify-write of permissions.json needs
 * an in-process write queue and still loses grants across processes.
 *
 * `scope` and `kind` are stored explicitly even though only `('runtime',
 * 'allow')` rows are written today: config entries come from `b4.config.ts`
 * on every construction and are deliberately never persisted, so `load()`
 * filters on `scope = 'runtime'` and config can never leak in from the table.
 * The primary key IS the conflict target — it is what makes a repeat grant a
 * no-op instead of a duplicate row.
 */
export const PERMISSIONS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (naming) => `
      CREATE TABLE IF NOT EXISTS ${qualify(naming, "permissions")} (
        scope text NOT NULL,
        kind text NOT NULL,
        tool text NOT NULL,
        pattern text NOT NULL,
        created_at text NOT NULL,
        PRIMARY KEY (scope, kind, tool, pattern)
      );
    `,
  },
]

/**
 * One table for every application document store, keyed `(store_name,
 * doc_key)`. A table per named store was the alternative and is worse on two
 * counts: the store name would have to be a SQL identifier interpolated into
 * DDL, and an app that quite reasonably names a store `threads` would collide
 * with B4.run's own `<prefix>_threads`. Here the name is a bound parameter, so
 * it can be any string and can never name one of our tables.
 *
 * `doc_key` is `text` so it holds both a generated uuid and a caller-supplied
 * id (a thread id, say) with one column type. `version` is the compare-and-swap
 * guard: every write states the version it expects and the statement's row
 * count reports whether it matched.
 *
 * ── Why this is a numbered migration and not `CREATE TABLE IF NOT EXISTS` ──
 *
 * `CREATE TABLE IF NOT EXISTS` never ALTERS a table that already exists. It is
 * therefore not a schema definition, it is a first-boot side effect, and the
 * moment new code changes the statement the two diverge silently: fresh
 * databases get the new shape, every older database keeps the old one, and
 * nothing anywhere reports the difference.
 *
 * That is not hypothetical. The hashbrown invoicing example — the first
 * consumer of this store, and where it was extracted from — declared
 * `id uuid DEFAULT gen_random_uuid()` in new code. It passed every test,
 * because tests run against a database created by that same statement. Against
 * a database created before it, the column had no default, and the insert that
 * had stopped supplying an id wrote NULL.
 *
 * So this store takes the other branch of the issue's choice and ships real
 * migrations, reusing the runner the other three stores already use
 * ({@link runMigrations}: forward-only, versioned, under
 * `pg_advisory_xact_lock`). Two rules make that hold:
 *
 *  1. A SHIPPED migration is frozen. Never edit the `up` of a version that has
 *     been released — a database that already recorded it will never re-run it.
 *     Change the shape by APPENDING `{ version: 2, up: … }` with `ALTER TABLE`.
 *     `test/documents-ddl.test.ts` pins version 1's exact text so this fails
 *     loudly instead of quietly.
 *  2. No column default is load-bearing. Every INSERT in `documents.ts` names
 *     every column and supplies every value, so the DDL's defaults (there are
 *     none, deliberately) can never be the difference between two databases.
 */
export const DOCUMENTS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (naming) => `
      CREATE TABLE IF NOT EXISTS ${qualify(naming, "documents")} (
        store_name text NOT NULL,
        doc_key text NOT NULL,
        version integer NOT NULL,
        value jsonb NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (store_name, doc_key)
      );
    `,
  },
]

/**
 * Checkpoint and metadata are BYTEA, not jsonb. B4.run serializes both with
 * LangGraph's `JsonPlusSerializer` and stores the resulting bytes opaquely,
 * exactly as the SQLite saver stores a BLOB. jsonb cannot hold a NUL byte
 * (22P05) or a lone surrogate (22P02), and both reach checkpoints for real via
 * sandbox stdout flowing into tool results.
 */
export const CHECKPOINTER_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (naming) => `
      CREATE TABLE IF NOT EXISTS ${qualify(naming, "checkpoints")} (
        thread_id text NOT NULL,
        checkpoint_ns text NOT NULL DEFAULT '',
        checkpoint_id text NOT NULL,
        parent_checkpoint_id text,
        type text,
        checkpoint bytea NOT NULL,
        metadata bytea NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE TABLE IF NOT EXISTS ${qualify(naming, "writes")} (
        thread_id text NOT NULL,
        checkpoint_ns text NOT NULL DEFAULT '',
        checkpoint_id text NOT NULL,
        task_id text NOT NULL,
        idx integer NOT NULL,
        channel text NOT NULL,
        type text,
        value bytea,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
    `,
  },
]
