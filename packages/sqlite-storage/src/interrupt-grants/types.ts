/**
 * The approval-grant contract, declared structurally here rather than imported
 * from `@b4run/sdk`.
 *
 * Identical shape — deliberately, member for member — so a store built here
 * satisfies `@b4run/sdk`'s `InterruptGrantStore` and vice versa. The
 * duplication follows the same rule `ThreadsStore` in `threads/store.ts` follows:
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
  /**
   * The `id` of the principal that answered, from the app's `src/auth.ts`;
   * `null` until consumed, and for an anonymous answer. Audit only: grants are
   * not bound to a caller, and no check reads this field.
   */
  readonly consumedBy: string | null
  readonly voidedAt: string | null
}

/** The outcome of a conditional consume. See {@link InterruptGrantStore.consume}. */
export type InterruptGrantConsumption =
  | { readonly outcome: "consumed"; readonly record: InterruptGrantRecord }
  | {
      readonly outcome: "already_consumed"
      readonly record: InterruptGrantRecord
    }
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
    /** The answering principal's `id`, recorded as `consumedBy`. Omit for an anonymous answer. */
    readonly by?: string
  }): Promise<InterruptGrantConsumption>
  /**
   * Stamp `voided_at` on every unvoided grant for `threadId` — consumed ones
   * included — whose `interruptId` is NOT in `keepInterruptIds`, i.e. every
   * grant whose parked prompt the thread has moved past. A consumed grant is
   * voided here once its resumed turn has completed, which is what later lets
   * `prune` delete it; a consumed grant whose prompt is still parked (its
   * resume failed) is never voided and never pruned. Returns how many were
   * voided.
   *
   * This is the staleness half of #736, and it is what replaces a stored
   * `checkpoint_id`: "the thread moved on" becomes a fact B4 asserts rather
   * than a behavior it inherits from LangGraph advancing the checkpoint.
   */
  voidOutstanding(args: {
    readonly threadId: string
    readonly keepInterruptIds: readonly string[]
    readonly at: string
  }): Promise<number>

  /**
   * Deletes voided rows whose `voidedAt` is before `before`. Nothing else is
   * ever deleted: an outstanding row is a parked prompt, and a consumed row
   * that was never voided is a prompt whose resume did not complete — under
   * `approvals.grants: "optional"` a parked prompt with no row would resume
   * ungated. Returns how many rows were deleted. `before` is an ISO-8601
   * string compared as text.
   */
  prune(options: { readonly before: string }): Promise<number>
}
