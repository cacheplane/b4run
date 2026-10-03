import type { B4MessageContent } from "@b4run/sdk"

/**
 * The tool-call record contract, declared structurally here rather than
 * imported from `@b4run/sdk`. Only the result's content type is imported:
 * this package already depends on `@b4run/sdk` at run time for the result
 * codec (`encodeClientToolResult` / `decodeClientToolResult`), so naming its
 * `B4MessageContent` drags a consumer into nothing new.
 *
 * Identical shape — member for member — to `@b4run/sdk`'s
 * `ToolCallRecordKind`, `ClientToolCallRecord`, `ClientToolCallAnswer`,
 * `ClientToolCallSettle`, `ToolCallOrigin` and `ClientToolCallStore`
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
   * The route that ISSUED the call, as a route key (`<routeId>#<mode>`): the
   * AG-UI run's route for a root call, the child route for a subagent's call.
   * Client rows are only ever issued by the root route, so for them this is
   * also the route that may answer or resume the park.
   */
  readonly routeId: string
  readonly issuedAt: string
  /** ISO time after which a client call is abandoned; `null` means no expiry. Always `null` on a server row. */
  readonly expiresAt: string | null
  /** Client rows only. */
  readonly answeredAt: string | null
  /**
   * The client's result — text, or an ordered part list — set together with
   * `answeredAt`. Client rows only.
   */
  readonly result: B4MessageContent | null
  /** Client rows only. */
  readonly voidedAt: string | null
  /** Server rows only: when the tool returned or threw. */
  readonly settledAt: string | null
  /**
   * The nearest enclosing `task` call's provider tool-call id — the call that
   * launched the subagent this row was issued from; `null` for a root call.
   * May name a row that does not exist when that `task` ran under the bridge's
   * random fallback id; siblings still group.
   */
  readonly parentToolCallId: string | null
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

/** Where a server call was issued from, when not at the root: supplied by the writer. */
export interface ToolCallOrigin {
  /** The issuing route's key (`<routeId>#<mode>`). */
  readonly routeId: string
  /** The enclosing `task` call's provider id. */
  readonly parentToolCallId: string
}

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
    readonly result: B4MessageContent
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
   * Deletes rows that can no longer affect a turn: answered or voided client
   * rows whose settle time (`voidedAt`, else `answeredAt`) is before `before`,
   * outstanding client rows whose `expiresAt` is before `before`, and server
   * rows settled before `before`. Open rows — an outstanding client call that
   * is unexpired or has no expiry, and an unsettled server call — are kept.
   * Returns how many rows were deleted. `before` is an ISO-8601 string
   * compared as text.
   */
  prune(options: { readonly before: string }): Promise<number>
}
