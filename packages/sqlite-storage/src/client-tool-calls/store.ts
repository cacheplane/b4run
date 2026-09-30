import type { Db } from "../internal/db.js"
import type { ClientToolCallAnswer, ClientToolCallRecord, ClientToolCallStore } from "./types.js"

interface ClientToolCallRow {
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
}

const SELECT_COLUMNS =
  "thread_id, tool_call_id, interrupt_id, tool_name, run_id, route_id, issued_at, expires_at, answered_at, result, voided_at"

function rowToRecord(row: ClientToolCallRow): ClientToolCallRecord {
  return {
    threadId: row.thread_id,
    toolCallId: row.tool_call_id,
    interruptId: row.interrupt_id,
    toolName: row.tool_name,
    runId: row.run_id,
    routeId: row.route_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    answeredAt: row.answered_at,
    result: row.result,
    voidedAt: row.voided_at,
  }
}

/** `node:sqlite` types `changes` as `number | bigint`; collapse it here. */
function changeCount(changes: number | bigint): number {
  return typeof changes === "bigint" ? Number(changes) : changes
}

/**
 * SQLite-backed {@link ClientToolCallStore}: the durable counterpart of
 * `createMemoryClientToolCallStore` in `@b4run/sdk`, with the same outcome
 * precedence and counting rules. Every guarantee is a SQL predicate, not
 * JavaScript around a read.
 *
 * Does NOT enforce `expires_at`: expiry is the caller's job (the AG-UI handler
 * treats expired outstanding calls as abandoned and voids them).
 */
export function makeClientToolCallStore(db: Db): ClientToolCallStore {
  function readRow(threadId: string, toolCallId: string): ClientToolCallRecord | undefined {
    const row = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM client_tool_calls WHERE thread_id = ? AND tool_call_id = ?`,
      )
      .get(threadId, toolCallId) as unknown as ClientToolCallRow | undefined
    return row ? rowToRecord(row) : undefined
  }

  return {
    async issue(record) {
      // The PRIMARY KEY decides: a replayed issue (LangGraph re-runs the stub
      // when it resumes) leaves the existing row untouched.
      db.prepare(
        `INSERT INTO client_tool_calls(${SELECT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, tool_call_id) DO NOTHING`,
      ).run(
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
      )
    },

    async get(threadId, toolCallId) {
      return readRow(threadId, toolCallId)
    },

    async listForThread(threadId) {
      const rows = db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM client_tool_calls WHERE thread_id = ? ORDER BY issued_at, tool_call_id`,
        )
        .all(threadId) as unknown as ClientToolCallRow[]
      return rows.map(rowToRecord)
    },

    async listOutstanding(threadId) {
      const rows = db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM client_tool_calls
           WHERE thread_id = ? AND answered_at IS NULL AND voided_at IS NULL
           ORDER BY issued_at, tool_call_id`,
        )
        .all(threadId) as unknown as ClientToolCallRow[]
      return rows.map(rowToRecord)
    },

    async answer({ threadId, toolCallId, result, at }): Promise<ClientToolCallAnswer> {
      // Single-use: the WHERE clause carries the guarantee; the engine's row
      // count, not a prior read, names the winner.
      const changes = changeCount(
        db
          .prepare(
            `UPDATE client_tool_calls
               SET answered_at = ?, result = ?
             WHERE thread_id = ?
               AND tool_call_id = ?
               AND answered_at IS NULL
               AND voided_at IS NULL`,
          )
          .run(at, result, threadId, toolCallId).changes,
      )
      const record = readRow(threadId, toolCallId)
      if (!record) return { outcome: "missing" }
      if (changes > 0) return { outcome: "answered", record }
      // Voided wins over already-answered, as in the SDK's memory store.
      if (record.voidedAt !== null) return { outcome: "voided", record }
      if (record.answeredAt !== null) return { outcome: "already_answered", record }
      // Exists but neither answered nor voided: only possible if it was issued
      // between the UPDATE and this read, so the UPDATE rightly matched nothing.
      return { outcome: "missing" }
    },

    async voidOutstanding({ threadId, toolCallIds, at }) {
      // An empty `IN ()` is a syntax error, and naming no calls voids none.
      if (toolCallIds !== undefined && toolCallIds.length === 0) return 0
      const named = toolCallIds
        ? ` AND tool_call_id IN (${toolCallIds.map(() => "?").join(", ")})`
        : ""
      return changeCount(
        db
          .prepare(
            `UPDATE client_tool_calls
               SET voided_at = ?
             WHERE thread_id = ? AND answered_at IS NULL AND voided_at IS NULL${named}`,
          )
          .run(at, threadId, ...(toolCallIds ?? [])).changes,
      )
    },
  }
}
