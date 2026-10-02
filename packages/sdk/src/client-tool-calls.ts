/**
 * The retained record behind client-provided tools (cacheplane/b4run#743).
 *
 * A client tool call parks the turn; this record is how the server knows,
 * later, that a `role: "tool"` message answers a call it issued and is still
 * waiting on. It is bookkeeping the client never sees; it carries no
 * credential.
 *
 * Keyed on `(threadId, toolCallId)`: the provider's tool-call id is stable
 * across LangGraph's re-execution of an interrupted tool node, which re-runs
 * the stub and therefore the `issue` call, so a replayed `issue` is a no-op
 * rather than an orphan row.
 *
 * Edge-safe: no Node built-ins — `@b4run/sdk`'s main entry is loaded by the
 * edge targets.
 */

/** `config.configurable` key the adapter injects the per-run recorder under. */
export const CLIENT_TOOL_RECORDER_KEY = "__b4ClientToolRecorder"

export interface ClientToolCallRecord {
  readonly threadId: string
  /** The provider's tool-call id — what the client echoes back as `toolCallId`. */
  readonly toolCallId: string
  /** The park this call's result answers (`client-${toolCallId}`). */
  readonly interruptId: string
  /** The un-prefixed name the client registered, for auditing. */
  readonly toolName: string
  readonly runId: string
  /**
   * The route key (`<routeId>#<mode>`, e.g. `/chat#agent`) whose run issued
   * the call. Only that route may answer or resume it; recorded here, while
   * the call is issued, so it is never behind the park.
   */
  readonly routeId: string
  readonly issuedAt: string
  /** ISO time after which the call is abandoned; `null` means no expiry. */
  readonly expiresAt: string | null
  readonly answeredAt: string | null
  /** The client's result text, set together with `answeredAt`. */
  readonly result: string | null
  readonly voidedAt: string | null
}

export type ClientToolCallAnswer =
  | { readonly outcome: "answered"; readonly record: ClientToolCallRecord }
  | { readonly outcome: "already_answered"; readonly record: ClientToolCallRecord }
  | { readonly outcome: "voided"; readonly record: ClientToolCallRecord }
  | { readonly outcome: "missing" }

export interface ClientToolCallStore {
  /**
   * Idempotent: a row with the same `(threadId, toolCallId)` is left untouched.
   * Records are expected fresh (`answeredAt`, `result` and `voidedAt` null).
   */
  issue(record: ClientToolCallRecord): Promise<void>
  get(threadId: string, toolCallId: string): Promise<ClientToolCallRecord | undefined>
  /** Every row for the thread, in issue order. */
  listForThread(threadId: string): Promise<readonly ClientToolCallRecord[]>
  /**
   * Rows neither answered nor voided, in issue order. Does NOT enforce
   * `expiresAt`: expiry is the caller's job (the AG-UI handler treats expired
   * outstanding calls as abandoned and voids them).
   */
  listOutstanding(threadId: string): Promise<readonly ClientToolCallRecord[]>
  /**
   * Single-use: only a row neither answered nor voided can be answered. Does
   * NOT enforce `expiresAt`: expiry is the caller's job (the AG-UI handler
   * treats expired outstanding calls as abandoned and voids them).
   */
  answer(options: {
    readonly threadId: string
    readonly toolCallId: string
    readonly result: string
    readonly at: string
  }): Promise<ClientToolCallAnswer>
  /**
   * Voids outstanding rows — those named, or all of the thread's when
   * `toolCallIds` is omitted. Answered rows are never voided. Returns how
   * many were voided.
   */
  voidOutstanding(options: {
    readonly threadId: string
    readonly toolCallIds?: readonly string[]
    readonly at: string
  }): Promise<number>
  /**
   * Deletes rows that can no longer affect a turn: answered or voided rows
   * whose settle time (`voidedAt`, else `answeredAt`) is before `before`, and
   * outstanding rows whose `expiresAt` is before `before`. Outstanding rows
   * with no expiry, or an expiry at or after `before`, are kept. Returns how
   * many rows were deleted. `before` is an ISO-8601 string compared as text.
   */
  prune(options: { readonly before: string }): Promise<number>
}

/**
 * What the stub tool in `@b4run/core` calls to write the record before it
 * parks. Per-run: it closes over the thread and run whose AG-UI endpoint will
 * receive the answer.
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
}

function compareIssue(a: ClientToolCallRecord, b: ClientToolCallRecord): number {
  if (a.issuedAt !== b.issuedAt) return a.issuedAt < b.issuedAt ? -1 : 1
  return a.toolCallId < b.toolCallId ? -1 : a.toolCallId > b.toolCallId ? 1 : 0
}

/** Whether `prune({ before })` may delete this row. Exported for the CLI's tests. */
export function isClientToolCallPrunable(row: ClientToolCallRecord, before: string): boolean {
  if (row.voidedAt !== null) return row.voidedAt < before
  if (row.answeredAt !== null) return row.answeredAt < before
  return row.expiresAt !== null && row.expiresAt < before
}

/** In-process store for tests and embedders. Not durable. */
export function createMemoryClientToolCallStore(): ClientToolCallStore {
  // Nested by thread so distinct (threadId, toolCallId) pairs can never collide.
  const threads = new Map<string, Map<string, ClientToolCallRecord>>()
  const forThread = (threadId: string) =>
    [...(threads.get(threadId)?.values() ?? [])].sort(compareIssue)
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
        .filter((row) => row.answeredAt === null && row.voidedAt === null)
        .map((row) => ({ ...row }))
    },
    async answer({ threadId, toolCallId, result, at }) {
      const rows = threads.get(threadId)
      const row = rows?.get(toolCallId)
      if (!rows || !row) return { outcome: "missing" }
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
        if (row.answeredAt !== null || row.voidedAt !== null) continue
        if (only && !only.has(id)) continue
        rows.set(id, { ...row, voidedAt: at })
        count += 1
      }
      return count
    },
    async prune({ before }) {
      let count = 0
      for (const [threadId, rows] of threads) {
        for (const [id, row] of rows) {
          if (!isClientToolCallPrunable(row, before)) continue
          rows.delete(id)
          count += 1
        }
        if (rows.size === 0) threads.delete(threadId)
      }
      return count
    },
  }
}
