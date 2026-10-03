/**
 * The tool-call record contract, declared structurally here rather than
 * imported from `@b4run/sdk`.
 *
 * Identical shape — member for member — to `@b4run/sdk`'s
 * `ToolCallRecordKind`, `ClientToolCallRecord`, `ClientToolCallAnswer`,
 * `ClientToolCallSettle` and `ClientToolCallStore`
 * (`packages/sdk/src/client-tool-calls.ts`), so a store built here satisfies
 * the SDK's interface and vice versa. This package's emitted `.d.ts` must not
 * drag a consumer into another workspace package for its types. Change one,
 * change the other; structural assignability at the wiring site catches a
 * drift.
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
