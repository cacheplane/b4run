import type { PostgresStoreOptions } from "./options.js"
import {
  assertIdentifier,
  DEFAULT_SCHEMA,
  DEFAULT_TABLE_PREFIX,
  INTERRUPT_GRANTS_MIGRATIONS,
  qualify,
  runMigrations,
} from "./schema.js"
import { throwNoPool } from "./sql.js"

/**
 * The approval-grant contract, declared structurally here rather than imported
 * from `@b4run/sdk`.
 *
 * Identical shape — deliberately, member for member — so a store built here
 * satisfies `@b4run/sdk`'s `InterruptGrantStore` and vice versa. The
 * duplication follows the same rule `ThreadsStore` in `threads.ts` follows:
 * this package's emitted `.d.ts` must not drag a consumer into another
 * workspace package to obtain its types, and adding a runtime dependency to
 * get a type-only import would do exactly that. Change one, change the other;
 * the structural assignability is what catches a drift, at the wiring site
 * that passes this store where an `InterruptGrantStore` is expected.
 *
 * See `packages/sdk/src/interrupt-grants.ts` for the design rationale behind
 * every field — in particular why `checkpointNs` is stored rather than the
 * `resume_key`/`checkpoint_id` pair the design names.
 */
export interface InterruptGrantRecord {
  readonly threadId: string
  readonly interruptId: string
  /** LangGraph's checkpoint namespace for the parked task, verbatim. */
  readonly checkpointNs: string
  /** Lowercase hex SHA-256 of the plaintext grant. Never the grant. */
  readonly tokenHash: string
  readonly issuedAt: string
  /** ISO-8601, or `null` for no TTL — a human approval may sit overnight. */
  readonly expiresAt: string | null
  readonly consumedAt: string | null
  /** `"once" | "always" | "deny"` when consumed, else `null`. */
  readonly consumedDecision: string | null
  readonly voidedAt: string | null
}

/** The outcome of a conditional consume. See {@link PostgresInterruptGrantStore.consume}. */
export type InterruptGrantConsumption =
  | { readonly outcome: "consumed"; readonly record: InterruptGrantRecord }
  | { readonly outcome: "already_consumed"; readonly record: InterruptGrantRecord }
  | { readonly outcome: "voided"; readonly record: InterruptGrantRecord }
  | { readonly outcome: "missing" }

/** Durable record of which parked approvals have been answered. */
export interface InterruptGrantStore {
  /** Write a new row. Fails if `(threadId, interruptId)` already exists. */
  issue(record: InterruptGrantRecord): Promise<void>
  get(threadId: string, interruptId: string): Promise<InterruptGrantRecord | undefined>
  /** Every row for a thread, consumed and voided ones included. */
  listForThread(threadId: string): Promise<readonly InterruptGrantRecord[]>
  consume(args: {
    readonly threadId: string
    readonly interruptId: string
    readonly decision: string
    readonly at: string
  }): Promise<InterruptGrantConsumption>
  voidOutstanding(args: {
    readonly threadId: string
    readonly keepInterruptIds: readonly string[]
    readonly at: string
  }): Promise<number>
}

/** An interrupt-grant store that also owns Postgres lifecycle. */
export interface PostgresInterruptGrantStore extends InterruptGrantStore {
  /** Apply migrations. Idempotent and memoized; call at boot to migrate eagerly. */
  ready(): Promise<void>
  /** Close the pool if this store owns it (`ownsPool`); otherwise a no-op. */
  close(): Promise<void>
}

export type PostgresInterruptGrantStoreOptions = PostgresStoreOptions

/**
 * Every column, in migration order, named explicitly.
 *
 * This constant is the other half of the no-DEFAULT rule in `schema.ts`: the
 * INSERT below names all nine and binds all nine, so there is no column whose
 * value the database chooses. Reusing it for the SELECT/RETURNING lists also
 * means a row can only ever be read back in the shape `rowToRecord` expects.
 */
const COLUMNS =
  "thread_id, interrupt_id, checkpoint_ns, token_hash, issued_at, expires_at, consumed_at, consumed_decision, voided_at"

interface GrantRow {
  thread_id: string
  interrupt_id: string
  checkpoint_ns: string
  token_hash: string
  issued_at: string
  expires_at: string | null
  consumed_at: string | null
  consumed_decision: string | null
  voided_at: string | null
}

function rowToRecord(row: GrantRow): InterruptGrantRecord {
  return {
    threadId: row.thread_id,
    interruptId: row.interrupt_id,
    checkpointNs: row.checkpoint_ns,
    tokenHash: row.token_hash,
    issuedAt: row.issued_at,
    // `?? null` rather than a bare read: the driver yields `null` already, but
    // the contract's type is `string | null` and a missing column would read
    // `undefined`, which would serialize differently on the wire.
    expiresAt: row.expires_at ?? null,
    consumedAt: row.consumed_at ?? null,
    consumedDecision: row.consumed_decision ?? null,
    voidedAt: row.voided_at ?? null,
  }
}

/** Postgres' unique-violation SQLSTATE — what a duplicate `issue` raises. */
const UNIQUE_VIOLATION = "23505"

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  )
}

/**
 * A Postgres-backed interrupt-grant store.
 *
 * The whole point of this implementation over the in-process memory store is
 * that the atomicity is the DATABASE's. `createMemoryInterruptGrantStore` gets
 * single-use for free from the JS event loop, which buys nothing the moment
 * there are two instances or one restart; here `consume` is a conditional
 * `UPDATE … WHERE consumed_at IS NULL AND voided_at IS NULL`, and the row
 * count that statement returns IS the answer to "did I win". There is
 * deliberately no read-before-write anywhere in `consume`: a SELECT that
 * decided the winner would be a check-then-act with a window between the two
 * halves, which is precisely the replay this store exists to refuse.
 *
 * The re-SELECT that follows a zero-row UPDATE is not that check. It runs only
 * after the decision has already been made against this caller, and it exists
 * solely to tell a LOSER *why* it lost — `"already_consumed"` (with the
 * recorded decision, so a double-submitting UI can render "already approved"
 * rather than re-prompting), `"voided"`, or `"missing"`.
 */
export function createPostgresInterruptGrantStore(
  options: PostgresInterruptGrantStoreOptions = {},
): PostgresInterruptGrantStore {
  const schema = options.schema ?? DEFAULT_SCHEMA
  const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX
  assertIdentifier("schema", schema)
  assertIdentifier("tablePrefix", prefix)
  const table = qualify({ schema, prefix }, "interrupt_grants")
  const ownsPool = options.ownsPool ?? false
  const pool = options.pool ?? throwNoPool()

  const assumeMigrated = options.assumeMigrated ?? false

  let initP: Promise<void> | undefined
  const ready = (): Promise<void> => {
    // See `assumeMigrated` in options.ts: a resolved promise, not a cheaper
    // migration — `runMigrations` costs a transaction plus an advisory lock
    // even when there is nothing left to apply.
    //
    // `component: "interrupt_grants"` gives this store its own migrations
    // table and its own advisory lock, so it versions independently of the
    // threads, permissions and checkpointer components and does not serialize
    // its cold start against theirs.
    initP ??= assumeMigrated
      ? Promise.resolve()
      : runMigrations(pool, INTERRUPT_GRANTS_MIGRATIONS, {
          schema,
          prefix,
          component: "interrupt_grants",
        })
    return initP
  }

  const selectOne = async (
    threadId: string,
    interruptId: string,
  ): Promise<InterruptGrantRecord | undefined> => {
    const res = await pool.query<GrantRow>(
      `SELECT ${COLUMNS} FROM ${table} WHERE thread_id = $1 AND interrupt_id = $2`,
      [threadId, interruptId],
    )
    const row = res.rows[0]
    return row ? rowToRecord(row) : undefined
  }

  return {
    ready,
    async close() {
      if (ownsPool) await pool.end()
    },

    async issue(record) {
      await ready()
      try {
        await pool.query(
          `INSERT INTO ${table} (${COLUMNS})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            record.threadId,
            record.interruptId,
            record.checkpointNs,
            record.tokenHash,
            record.issuedAt,
            record.expiresAt,
            record.consumedAt,
            record.consumedDecision,
            record.voidedAt,
          ],
        )
      } catch (error) {
        // Not `ON CONFLICT DO NOTHING`: a second grant for one parked call is
        // a bug at the park site, not a benign retry, and swallowing it would
        // leave the caller holding a plaintext grant whose hash is not the one
        // stored — an approval that can never be consumed. The message matches
        // the memory store's so a conformance suite can assert either.
        if (isUniqueViolation(error)) {
          throw new Error(
            `interrupt-grants: a grant already exists for (${record.threadId}, ${record.interruptId})`,
            { cause: error },
          )
        }
        throw error
      }
    },

    async get(threadId, interruptId) {
      await ready()
      return selectOne(threadId, interruptId)
    },

    async listForThread(threadId) {
      await ready()
      // Consumed and voided rows included: the record of a consumption is the
      // evidence that answers a replay, so it is never filtered out here.
      // Ordered by issue time under COLLATE "C" — byte ordering, so an
      // ISO-8601 string sorts chronologically regardless of database locale.
      const res = await pool.query<GrantRow>(
        `SELECT ${COLUMNS} FROM ${table} WHERE thread_id = $1
         ORDER BY issued_at COLLATE "C" ASC, interrupt_id COLLATE "C" ASC`,
        [threadId],
      )
      return res.rows.map(rowToRecord)
    },

    async consume({ threadId, interruptId, decision, at }) {
      await ready()
      // Bounded retry, mirroring `createThread`: the only way the UPDATE can
      // match nothing while the row is still outstanding is a concurrent
      // transaction that took the row and then rolled back, which leaves this
      // caller eligible again. Re-running the conditional UPDATE is the only
      // way to settle that — and it settles it without ever letting a SELECT
      // decide the winner.
      for (let attempt = 0; attempt < 3; attempt++) {
        const updated = await pool.query<GrantRow>(
          `UPDATE ${table} SET consumed_at = $1, consumed_decision = $2
           WHERE thread_id = $3 AND interrupt_id = $4
             AND consumed_at IS NULL AND voided_at IS NULL
           RETURNING ${COLUMNS}`,
          [at, decision, threadId, interruptId],
        )
        const won = updated.rows[0]
        if (won) return { outcome: "consumed", record: rowToRecord(won) }

        const existing = await selectOne(threadId, interruptId)
        if (!existing) return { outcome: "missing" }
        // Voided is checked before consumed, matching the memory store's
        // ordering. The two are mutually exclusive in practice — the UPDATE
        // that sets one requires the other to be NULL — but the order is
        // pinned so the answer cannot depend on which store you asked.
        if (existing.voidedAt !== null) return { outcome: "voided", record: existing }
        if (existing.consumedAt !== null) return { outcome: "already_consumed", record: existing }
      }
      throw new Error(
        `[postgres-storage] consume could not settle for (${threadId}, ${interruptId})`,
      )
    },

    async voidOutstanding({ threadId, keepInterruptIds, at }) {
      await ready()
      // ONE statement, not a read followed by a loop of updates: "the thread
      // moved on" has to be an instant, or a grant issued between the read and
      // the writes would survive a void that logically preceded it.
      //
      // `NOT (interrupt_id = ANY($3::text[]))` rather than `!= ALL` or a
      // generated IN-list: the keep-list is BOUND as one array parameter, so
      // its length never changes the statement text (no query-plan churn, no
      // interpolation) and an EMPTY keep-list behaves correctly — `x = ANY('{}')`
      // is false for every row, so `NOT false` is true and everything
      // outstanding for the thread is voided, which is exactly what "the
      // thread has no pending interrupts left" must mean. An IN-list would
      // have degenerated to `IN ()`, a syntax error.
      //
      // The count comes from RETURNING rather than `rowCount`: `SqlPool` is
      // typed on `rows` alone so that a non-`pg` driver can satisfy it.
      const res = await pool.query<{ interrupt_id: string }>(
        `UPDATE ${table} SET voided_at = $1
         WHERE thread_id = $2 AND consumed_at IS NULL AND voided_at IS NULL
           AND NOT (interrupt_id = ANY($3::text[]))
         RETURNING interrupt_id`,
        [at, threadId, [...keepInterruptIds]],
      )
      return res.rows.length
    },
  }
}
