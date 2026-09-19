import type { Db } from "../internal/db.js"
import type { InterruptGrantRecord, InterruptGrantStore } from "./types.js"

/**
 * The row as SQLite hands it back. `node:sqlite` returns `NULL` as `null` and
 * TEXT as `string`, so this maps 1:1 onto {@link InterruptGrantRecord} once
 * the snake_case column names are camel-cased.
 */
interface InterruptGrantRow {
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

const SELECT_COLUMNS =
  "thread_id, interrupt_id, checkpoint_ns, token_hash, issued_at, expires_at, consumed_at, consumed_decision, voided_at"

function rowToRecord(row: InterruptGrantRow): InterruptGrantRecord {
  return {
    threadId: row.thread_id,
    interruptId: row.interrupt_id,
    checkpointNs: row.checkpoint_ns,
    tokenHash: row.token_hash,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedDecision: row.consumed_decision,
    voidedAt: row.voided_at,
  }
}

/**
 * `node:sqlite` types `changes` as `number | bigint` — it widens to bigint
 * only past 2^53, which a grant sweep will never reach, but the union has to
 * be collapsed somewhere and doing it here keeps the call sites readable.
 */
function changeCount(changes: number | bigint): number {
  return typeof changes === "bigint" ? Number(changes) : changes
}

/**
 * SQLite-backed {@link InterruptGrantStore}.
 *
 * SQLite is B4.run's local-dev default, so this is the implementation that
 * actually runs under `b4 dev` — the in-memory store in `@b4run/sdk` proves
 * the semantics, and this one has to reproduce them against a file that
 * outlives the process. It answers the same conformance expectations: same
 * outcome precedence, same duplicate-issue rejection, same counting rule for
 * `voidOutstanding`.
 *
 * The store is deliberately thin: every guarantee is expressed as a SQL
 * predicate rather than as JavaScript around a read, because JavaScript around
 * a read is exactly the race the grant exists to close.
 */
export function makeInterruptGrantStore(db: Db): InterruptGrantStore {
  const selectOne = () =>
    db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM interrupt_grants WHERE thread_id = ? AND interrupt_id = ?`,
    )

  function readRow(threadId: string, interruptId: string): InterruptGrantRecord | undefined {
    const row = selectOne().get(threadId, interruptId) as unknown as InterruptGrantRow | undefined
    return row ? rowToRecord(row) : undefined
  }

  return {
    async issue(record) {
      // Every column is named and every value supplied — there are no DEFAULTs
      // in the schema to fall back on, on purpose. The PRIMARY KEY does the
      // duplicate rejection: a SELECT-then-INSERT would leave a window in
      // which two parks of the same interrupt both believe they are the first,
      // and the SDK's memory store throws here, so this must throw too.
      db.prepare(
        `INSERT INTO interrupt_grants(${SELECT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.threadId,
        record.interruptId,
        record.checkpointNs,
        record.tokenHash,
        record.issuedAt,
        record.expiresAt,
        record.consumedAt,
        record.consumedDecision,
        record.voidedAt,
      )
    },

    async get(threadId, interruptId) {
      return readRow(threadId, interruptId)
    },

    async listForThread(threadId) {
      // Consumed and voided rows included: the contract says so, because a
      // caller reconciling a thread's outstanding approvals needs to see the
      // answered ones to know they are answered.
      const rows = db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM interrupt_grants WHERE thread_id = ? ORDER BY issued_at, interrupt_id`,
        )
        .all(threadId) as unknown as InterruptGrantRow[]
      return rows.map(rowToRecord)
    },

    async consume({ threadId, interruptId, decision, at }) {
      // The single-use point. The WHERE clause carries the whole guarantee:
      // exactly one UPDATE can find the row unconsumed and unvoided, so the
      // winner is decided by the engine's row count and never by a prior read.
      // A replay — concurrent, or after a process restart — changes 0 rows.
      const changes = changeCount(
        db
          .prepare(
            `UPDATE interrupt_grants
               SET consumed_at = ?, consumed_decision = ?
             WHERE thread_id = ?
               AND interrupt_id = ?
               AND consumed_at IS NULL
               AND voided_at IS NULL`,
          )
          .run(at, decision, threadId, interruptId).changes,
      )

      if (changes > 0) {
        const record = readRow(threadId, interruptId)
        // Unreachable in practice: the UPDATE just matched this row, and there
        // is no DELETE path on this table. Kept as a type-level floor rather
        // than a non-null assertion, so a future deleter fails loudly.
        if (!record) return { outcome: "missing" }
        return { outcome: "consumed", record }
      }

      // Zero rows changed means one of three different facts, and the caller
      // renders each differently — so read the row back to tell them apart,
      // AFTER the decision rather than before it.
      const record = readRow(threadId, interruptId)
      if (!record) return { outcome: "missing" }
      // Voided wins over already-consumed when a row is somehow both: the SDK's
      // memory store checks in this order, and staleness is the stronger
      // complaint — "that proposal is gone" beats "that answer is in".
      if (record.voidedAt !== null) return { outcome: "voided", record }
      if (record.consumedAt !== null) return { outcome: "already_consumed", record }
      // Also unreachable: not missing, not voided, not consumed means the
      // UPDATE's predicate held and it would have matched.
      return { outcome: "missing" }
    },

    async voidOutstanding({ threadId, keepInterruptIds, at }) {
      // One statement, and the engine's row count is the answer — the same
      // reason `consume` is a conditional UPDATE. The `IS NULL` guards keep
      // the sweep idempotent: a grant already voided keeps its original
      // timestamp and is not counted twice.
      //
      // SQL has no empty `NOT IN ()` — `NOT IN ()` is a syntax error, not a
      // vacuous-true predicate — so the empty keep-list is spelled as the
      // separate statement it really is. Empty means "the thread kept nothing
      // pending", i.e. void everything outstanding, which is the common case
      // when a thread finishes or is abandoned; degrading it to a no-op would
      // leave exactly the stale grants this method exists to kill.
      const placeholders = keepInterruptIds.map(() => "?").join(", ")
      const sql =
        keepInterruptIds.length === 0
          ? `UPDATE interrupt_grants
               SET voided_at = ?
             WHERE thread_id = ? AND consumed_at IS NULL AND voided_at IS NULL`
          : `UPDATE interrupt_grants
               SET voided_at = ?
             WHERE thread_id = ?
               AND consumed_at IS NULL
               AND voided_at IS NULL
               AND interrupt_id NOT IN (${placeholders})`
      return changeCount(db.prepare(sql).run(at, threadId, ...keepInterruptIds).changes)
    },
  }
}
