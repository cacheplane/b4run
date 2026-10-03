/**
 * The retained record of tool calls (cacheplane/b4run#743, generalized by the
 * 2026-10-02 design). Two kinds of row share one table:
 *
 * - `client`: a client-provided tool call that parked the turn. The row is how
 *   the server knows, later, that a `role: "tool"` message answers a call it
 *   issued and is still waiting on. Only an OPEN client row (neither answered
 *   nor voided) is ever answerable.
 * - `server`: one of the server's own tool calls, recorded for identity only
 *   (issued, then settled when the tool returns or throws). Never answerable;
 *   a tool message naming it is history.
 *
 * It is bookkeeping the client never sees; it carries no credential.
 *
 * Keyed on `(threadId, toolCallId)`: the provider's tool-call id is stable
 * across LangGraph's re-execution of an interrupted tool node. The client stub
 * writes client rows and the LangChain tool converter writes server rows
 * (`issue`/`settle`); a replayed `issue` of either is a no-op on the key, not
 * an orphan row.
 *
 * Edge-safe: no Node built-ins — `@b4run/sdk`'s main entry is loaded by the
 * edge targets.
 */

/** `config.configurable` key the adapter injects the per-run recorder under. */
export const CLIENT_TOOL_RECORDER_KEY = "__b4ClientToolRecorder"

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
  | {
      readonly outcome: "already_answered"
      readonly record: ClientToolCallRecord
    }
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

/**
 * What the writers call to maintain the record. The client stub in
 * `@b4run/core` writes client rows (`has`/`record`) before it parks; the
 * LangChain tool converter writes server rows (`issue`/`settle`) around each
 * server tool call. Per-run: it closes over the thread and run whose AG-UI
 * endpoint will receive the answer.
 */
export interface ClientToolRecorder {
  /**
   * Whether this run's thread already recorded the call — true on LangGraph's
   * replay of a parked stub. The stub takes its permission decision and writes
   * the record only when this is false, so both happen once, before the park.
   */
  has(toolCallId: string): Promise<boolean>
  record(call: {
    readonly toolCallId: string
    readonly interruptId: string
    readonly toolName: string
  }): Promise<void>
  /** Writes a server row for one of the server's own tool calls, before it runs. Idempotent on the id. */
  issue(call: { readonly toolCallId: string; readonly toolName: string }): Promise<void>
  /** Stamps the server row once the tool returned or threw. Idempotent. */
  settle(toolCallId: string): Promise<void>
}

function compareIssue(a: ClientToolCallRecord, b: ClientToolCallRecord): number {
  if (a.issuedAt !== b.issuedAt) return a.issuedAt < b.issuedAt ? -1 : 1
  return a.toolCallId < b.toolCallId ? -1 : a.toolCallId > b.toolCallId ? 1 : 0
}

/** In-process store for tests and embedders. Not durable. */
export function createMemoryClientToolCallStore(): ClientToolCallStore {
  // Nested by thread so distinct (threadId, toolCallId) pairs can never collide.
  const threads = new Map<string, Map<string, ClientToolCallRecord>>()
  const forThread = (threadId: string) =>
    [...(threads.get(threadId)?.values() ?? [])].sort(compareIssue)
  const isOpen = (row: ClientToolCallRecord) =>
    row.kind === "client"
      ? row.answeredAt === null && row.voidedAt === null
      : row.settledAt === null
  const terminalAt = (row: ClientToolCallRecord): string | null =>
    row.kind === "client" ? (row.voidedAt ?? row.answeredAt) : row.settledAt
  return {
    async issue(record) {
      let rows = threads.get(record.threadId)
      if (!rows) {
        rows = new Map()
        threads.set(record.threadId, rows)
      }
      if (!rows.has(record.toolCallId)) rows.set(record.toolCallId, { ...record })
    },
    async get(threadId, toolCallId) {
      const row = threads.get(threadId)?.get(toolCallId)
      return row ? { ...row } : undefined
    },
    async listForThread(threadId) {
      return forThread(threadId).map((row) => ({ ...row }))
    },
    async listOutstanding(threadId) {
      return forThread(threadId)
        .filter((row) => row.kind === "client" && isOpen(row))
        .map((row) => ({ ...row }))
    },
    async answer({ threadId, toolCallId, result, at }) {
      const rows = threads.get(threadId)
      const row = rows?.get(toolCallId)
      if (!rows || !row || row.kind !== "client") return { outcome: "missing" }
      if (row.voidedAt !== null) return { outcome: "voided", record: { ...row } }
      if (row.answeredAt !== null) return { outcome: "already_answered", record: { ...row } }
      const next = { ...row, answeredAt: at, result }
      rows.set(toolCallId, next)
      return { outcome: "answered", record: { ...next } }
    },
    async voidOutstanding({ threadId, toolCallIds, at }) {
      const rows = threads.get(threadId)
      if (!rows) return 0
      const only = toolCallIds === undefined ? undefined : new Set(toolCallIds)
      let count = 0
      for (const [id, row] of rows) {
        if (row.kind !== "client" || row.answeredAt !== null || row.voidedAt !== null) continue
        if (only && !only.has(id)) continue
        rows.set(id, { ...row, voidedAt: at })
        count += 1
      }
      return count
    },
    async settle({ threadId, toolCallId, at }) {
      const rows = threads.get(threadId)
      const row = rows?.get(toolCallId)
      if (!rows || !row || row.kind !== "server") return "missing"
      if (row.settledAt !== null) return "already_settled"
      rows.set(toolCallId, { ...row, settledAt: at })
      return "settled"
    },
    async prune({ threadId, before }) {
      let canonical = false
      try {
        canonical = new Date(before).toISOString() === before
      } catch {
        canonical = false
      }
      if (!canonical) {
        throw new Error("prune: `before` must be a canonical Date#toISOString() value")
      }
      const rows = threads.get(threadId)
      if (!rows) return 0
      let count = 0
      for (const [id, row] of rows) {
        if (isOpen(row)) continue
        const at = terminalAt(row)
        if (at === null) continue
        if (at >= before) continue
        rows.delete(id)
        count += 1
      }
      return count
    },
  }
}
