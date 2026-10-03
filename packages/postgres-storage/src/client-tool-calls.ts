import type { PostgresStoreOptions } from "./options.js"
import {
  assertIdentifier,
  CLIENT_TOOL_CALLS_MIGRATIONS,
  DEFAULT_SCHEMA,
  DEFAULT_TABLE_PREFIX,
  qualify,
  runMigrations,
} from "./schema.js"
import { throwNoPool } from "./sql.js"

/**
 * The client tool call contract, declared structurally here rather than
 * imported from `@b4run/sdk` (same rule as `interrupt-grants.ts`: this
 * package's `.d.ts` must not drag a consumer into another workspace package).
 * Member for member identical to `@b4run/sdk`'s `ClientToolCallRecord`,
 * `ClientToolCallAnswer`, `ClientToolCallSettle` and `ClientToolCallStore`;
 * change one, change the other. Structural assignability at the wiring site
 * catches a drift.
 */
export type ToolCallRecordKind = "client" | "server"

export interface ClientToolCallRecord {
  readonly threadId: string
  /** The provider's tool-call id — what the client echoes back as `toolCallId`. */
  readonly toolCallId: string
  /** `client`: a parked client tool call. `server`: one of the server's own tool calls, identity only. */
  readonly kind: ToolCallRecordKind
  /** The park this call's result answers (`client-${toolCallId}`); `""` on a server row. */
  readonly interruptId: string
  /** The un-prefixed name the client registered, or the server tool's name. */
  readonly toolName: string
  readonly runId: string
  /**
   * The route key (`<routeId>#<mode>`, e.g. `/chat#agent`) whose run issued
   * the call. Only that route may answer or resume it; recorded here, while
   * the call is issued, so it is never behind the park.
   */
  readonly routeId: string
  readonly issuedAt: string
  /** ISO time after which a client call is abandoned; `null` means no expiry. Always `null` on a server row. */
  readonly expiresAt: string | null
  /** Client rows only. */
  readonly answeredAt: string | null
  /** The client's result text, set together with `answeredAt`. Client rows only. */
  readonly result: string | null
  /** Client rows only. */
  readonly voidedAt: string | null
  /** Server rows only: when the tool returned or threw. */
  readonly settledAt: string | null
}

export type ClientToolCallAnswer =
  | { readonly outcome: "answered"; readonly record: ClientToolCallRecord }
  | { readonly outcome: "already_answered"; readonly record: ClientToolCallRecord }
  | { readonly outcome: "voided"; readonly record: ClientToolCallRecord }
  | { readonly outcome: "missing" }

export type ClientToolCallSettle = "settled" | "already_settled" | "missing"

export interface ClientToolCallStore {
  /**
   * Idempotent: a row with the same `(threadId, toolCallId)` is left untouched.
   * Records are expected fresh (`answeredAt`, `result`, `voidedAt` and `settledAt` null).
   */
  issue(record: ClientToolCallRecord): Promise<void>
  get(threadId: string, toolCallId: string): Promise<ClientToolCallRecord | undefined>
  /** Every row for the thread, in issue order. */
  listForThread(threadId: string): Promise<readonly ClientToolCallRecord[]>
  /**
   * Open CLIENT rows — neither answered nor voided — in issue order. Server
   * rows are never listed here. Does NOT enforce `expiresAt`: expiry is the
   * caller's job (the AG-UI handler treats expired outstanding calls as
   * abandoned and voids them).
   */
  listOutstanding(threadId: string): Promise<readonly ClientToolCallRecord[]>
  /**
   * Single-use: only a row neither answered nor voided can be answered. Client
   * rows only; a server row is `missing`. Does NOT enforce `expiresAt`: expiry
   * is the caller's job (the AG-UI handler treats expired outstanding calls as
   * abandoned and voids them).
   */
  answer(options: {
    readonly threadId: string
    readonly toolCallId: string
    readonly result: string
    readonly at: string
  }): Promise<ClientToolCallAnswer>
  /**
   * Voids outstanding rows — those named, or all of the thread's when
   * `toolCallIds` is omitted. Answered rows are never voided, and a server row
   * is never voided. Returns how many were voided.
   */
  voidOutstanding(options: {
    readonly threadId: string
    readonly toolCallIds?: readonly string[]
    readonly at: string
  }): Promise<number>
  /**
   * Stamps `settledAt` on a server row. Idempotent: a second call reports
   * `already_settled` and keeps the first timestamp. A client row, or an
   * unknown id, is `missing`.
   */
  settle(options: {
    readonly threadId: string
    readonly toolCallId: string
    readonly at: string
  }): Promise<ClientToolCallSettle>
  /**
   * Deletes the thread's NON-open rows whose terminal timestamp (`answeredAt`,
   * `voidedAt` or `settledAt`, whichever is set) is older than `before`.
   * `before` must be a canonical `Date#toISOString()` string (UTC, millisecond
   * precision, `Z` suffix), as every stored timestamp is; a store rejects any
   * other form by throwing. Such strings compare chronologically as text,
   * which is what the SQL stores do. Open rows are never eligible, however
   * old. Returns how many rows were deleted. A delete path is acceptable here,
   * unlike for interrupt grants: a closed tool-call row carries no authority.
   */
  prune(options: { readonly threadId: string; readonly before: string }): Promise<number>
}

/** A client-tool-call store that also owns Postgres lifecycle. */
export interface PostgresClientToolCallStore extends ClientToolCallStore {
  /** Apply migrations. Idempotent and memoized; call at boot to migrate eagerly. */
  ready(): Promise<void>
  /** Close the pool if this store owns it (`ownsPool`); otherwise a no-op. */
  close(): Promise<void>
}

export type PostgresClientToolCallStoreOptions = PostgresStoreOptions

/** Every column, in migration order. The INSERT names and binds all thirteen. */
const COLUMNS =
  "thread_id, tool_call_id, interrupt_id, tool_name, run_id, route_id, issued_at, expires_at, answered_at, result, voided_at, kind, settled_at"

interface CallRow {
  thread_id: string
  tool_call_id: string
  interrupt_id: string
  tool_name: string
  run_id: string
  route_id: string
  issued_at: string
  expires_at: string | null
  answered_at: string | null
  result: string | null
  voided_at: string | null
  kind: string
  settled_at: string | null
}

function rowToRecord(row: CallRow): ClientToolCallRecord {
  return {
    threadId: row.thread_id,
    toolCallId: row.tool_call_id,
    kind: row.kind === "server" ? "server" : "client",
    interruptId: row.interrupt_id,
    toolName: row.tool_name,
    runId: row.run_id,
    routeId: row.route_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at ?? null,
    answeredAt: row.answered_at ?? null,
    result: row.result ?? null,
    voidedAt: row.voided_at ?? null,
    settledAt: row.settled_at ?? null,
  }
}

/** `prune` compares timestamps as text, so `before` must be the canonical `Date#toISOString()` form every stored timestamp has. */
function assertCanonicalBefore(before: string): void {
  let canonical: string | undefined
  try {
    canonical = new Date(before).toISOString()
  } catch {
    canonical = undefined
  }
  if (canonical !== before) {
    throw new Error("prune: `before` must be a canonical Date#toISOString() value")
  }
}

/**
 * A Postgres-backed {@link ClientToolCallStore}: the multi-instance
 * counterpart of the SDK's memory store and `@b4run/sqlite-storage`'s store,
 * with the same outcome precedence and counting rules. Two kinds of row share
 * the table: `client` rows park and are answered or voided; `server` rows are
 * identity-only (issued, then settled). Listing, answering and voiding touch
 * client rows only; `settle` touches server rows only. `prune` requires a
 * canonical `Date#toISOString()` `before`, since timestamps compare as text.
 *
 * Every guarantee is a SQL predicate. `answer` is a conditional
 * `UPDATE … WHERE answered_at IS NULL AND voided_at IS NULL`, and the row the
 * statement RETURNS names the winner; the re-read after a zero-row UPDATE only
 * tells a loser why it lost, from the row's actual state.
 *
 * Does NOT enforce `expires_at`: expiry is the caller's job (the AG-UI handler
 * treats expired outstanding calls as abandoned and voids them).
 */
export function createPostgresClientToolCallStore(
  options: PostgresClientToolCallStoreOptions = {},
): PostgresClientToolCallStore {
  const schema = options.schema ?? DEFAULT_SCHEMA
  const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX
  assertIdentifier("schema", schema)
  assertIdentifier("tablePrefix", prefix)
  const table = qualify({ schema, prefix }, "client_tool_calls")
  const ownsPool = options.ownsPool ?? false
  const pool = options.pool ?? throwNoPool()
  const assumeMigrated = options.assumeMigrated ?? false

  let initP: Promise<void> | undefined
  const ready = (): Promise<void> => {
    // Its own component: own migrations table and advisory lock, so this store
    // versions independently of the others.
    initP ??= assumeMigrated
      ? Promise.resolve()
      : runMigrations(pool, CLIENT_TOOL_CALLS_MIGRATIONS, {
          schema,
          prefix,
          component: "client_tool_calls",
        })
    return initP
  }

  const selectOne = async (
    threadId: string,
    toolCallId: string,
  ): Promise<ClientToolCallRecord | undefined> => {
    const res = await pool.query<CallRow>(
      `SELECT ${COLUMNS} FROM ${table} WHERE thread_id = $1 AND tool_call_id = $2`,
      [threadId, toolCallId],
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
      // The PRIMARY KEY decides: a replayed issue (LangGraph re-runs the stub
      // when it resumes) leaves the existing row untouched.
      await pool.query(
        `INSERT INTO ${table} (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (thread_id, tool_call_id) DO NOTHING`,
        [
          record.threadId,
          record.toolCallId,
          record.interruptId,
          record.toolName,
          record.runId,
          record.routeId,
          record.issuedAt,
          record.expiresAt,
          record.answeredAt,
          record.result,
          record.voidedAt,
          record.kind,
          record.settledAt,
        ],
      )
    },

    async get(threadId, toolCallId) {
      await ready()
      return selectOne(threadId, toolCallId)
    },

    async listForThread(threadId) {
      await ready()
      // COLLATE "C": byte ordering, so ISO-8601 strings sort chronologically
      // regardless of the database locale.
      const res = await pool.query<CallRow>(
        `SELECT ${COLUMNS} FROM ${table} WHERE thread_id = $1
         ORDER BY issued_at COLLATE "C" ASC, tool_call_id COLLATE "C" ASC`,
        [threadId],
      )
      return res.rows.map(rowToRecord)
    },

    async listOutstanding(threadId) {
      await ready()
      const res = await pool.query<CallRow>(
        `SELECT ${COLUMNS} FROM ${table}
         WHERE thread_id = $1 AND kind = 'client' AND answered_at IS NULL AND voided_at IS NULL
         ORDER BY issued_at COLLATE "C" ASC, tool_call_id COLLATE "C" ASC`,
        [threadId],
      )
      return res.rows.map(rowToRecord)
    },

    async answer({ threadId, toolCallId, result, at }) {
      await ready()
      // No retry loop (unlike the interrupt-grant store's `consume`): a zero-row
      // UPDATE is classified from the row's actual state and every state maps
      // to a terminal answer. A SELECT never decides the winner.
      const updated = await pool.query<CallRow>(
        `UPDATE ${table} SET answered_at = $1, result = $2
         WHERE thread_id = $3 AND tool_call_id = $4 AND kind = 'client'
           AND answered_at IS NULL AND voided_at IS NULL
         RETURNING ${COLUMNS}`,
        [at, result, threadId, toolCallId],
      )
      const won = updated.rows[0]
      if (won) return { outcome: "answered", record: rowToRecord(won) }

      const existing = await selectOne(threadId, toolCallId)
      if (existing?.kind !== "client") return { outcome: "missing" }
      // Voided wins over already-answered, as in the SDK's memory store.
      if (existing.voidedAt !== null) return { outcome: "voided", record: existing }
      if (existing.answeredAt !== null) return { outcome: "already_answered", record: existing }
      // Exists but neither answered nor voided: only possible if it was issued
      // between the UPDATE and this read, so the UPDATE rightly matched nothing.
      return { outcome: "missing" }
    },

    async voidOutstanding({ threadId, toolCallIds, at }) {
      // Naming no calls voids none — and needs no round trip.
      if (toolCallIds !== undefined && toolCallIds.length === 0) return 0
      await ready()
      // One statement; ids are bound as a single array (NULL = all). The count
      // comes from RETURNING because `SqlPool` exposes `rows` alone.
      const res = await pool.query<{ tool_call_id: string }>(
        `UPDATE ${table} SET voided_at = $1
         WHERE thread_id = $2 AND kind = 'client' AND answered_at IS NULL AND voided_at IS NULL
           AND ($3::text[] IS NULL OR tool_call_id = ANY($3::text[]))
         RETURNING tool_call_id`,
        [at, threadId, toolCallIds === undefined ? null : [...toolCallIds]],
      )
      return res.rows.length
    },

    async settle({ threadId, toolCallId, at }) {
      await ready()
      const updated = await pool.query<{ tool_call_id: string }>(
        `UPDATE ${table} SET settled_at = $1
         WHERE thread_id = $2 AND tool_call_id = $3 AND kind = 'server' AND settled_at IS NULL
         RETURNING tool_call_id`,
        [at, threadId, toolCallId],
      )
      if (updated.rows.length > 0) return "settled"
      const existing = await selectOne(threadId, toolCallId)
      return existing?.kind === "server" ? "already_settled" : "missing"
    },

    async prune({ threadId, before }) {
      assertCanonicalBefore(before)
      await ready()
      // Terminal timestamp per kind; an open row has none and never matches.
      // Canonical ISO-8601 UTC text compares chronologically under COLLATE "C".
      const res = await pool.query<{ tool_call_id: string }>(
        `DELETE FROM ${table}
         WHERE thread_id = $1
           AND (CASE WHEN kind = 'client' THEN COALESCE(voided_at, answered_at) ELSE settled_at END) COLLATE "C" < $2
         RETURNING tool_call_id`,
        [threadId, before],
      )
      return res.rows.length
    },
  }
}
