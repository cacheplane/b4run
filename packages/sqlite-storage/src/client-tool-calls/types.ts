/**
 * The client tool call contract, declared structurally here rather than
 * imported from `@b4run/sdk`.
 *
 * Identical shape — member for member — to `@b4run/sdk`'s
 * `ClientToolCallRecord`, `ClientToolCallAnswer` and `ClientToolCallStore`
 * (`packages/sdk/src/client-tool-calls.ts`), so a store built here satisfies
 * the SDK's interface and vice versa. This package's emitted `.d.ts` must not
 * drag a consumer into another workspace package for its types. Change one,
 * change the other; structural assignability at the wiring site catches a
 * drift.
 */
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
   * `expiresAt`: expiry is the caller's job.
   */
  listOutstanding(threadId: string): Promise<readonly ClientToolCallRecord[]>
  /**
   * Single-use: only a row neither answered nor voided can be answered. Does
   * NOT enforce `expiresAt`: expiry is the caller's job.
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
