import type { Factory } from "../controller/factory.js"
import type { WorkOrderRow } from "../domain/work-order.js"
import { type RouteOutcome, refused } from "./outcome.js"

export interface SettleOptions {
  /** Names the run in the "did not settle" message: `Dispatch`, `Intake`, `Redraft`. */
  readonly what: string
  /** The operation key of the cancel an aborted route issues, e.g. `cancel:<id>:aborted-dispatch`. */
  readonly abortKey: string
  /** Is the settled row the outcome a script may treat as success? */
  readonly success: (row: WorkOrderRow) => boolean
  /** The message for a settled row, success or not. */
  readonly message: (row: WorkOrderRow) => string
}

/**
 * Await a run the caller just started (`dispatch`, `intake`, or the redraft a
 * `reject-intake` triggered) and report where it settled. Shared by the awaiting routes so
 * the abort listener, the budget and the "did not settle" shape cannot drift between them.
 *
 * The abort listener fires when the runtime cancels this thread's run and cancels the work
 * order. It is safe against a late abort by SCHEDULING, not by the command refusing: `cancel`
 * is legal from every non-terminal state, so an abort landing after `settle` resolved would
 * cancel a settled work order — there is no `await` between the settle and the
 * `removeEventListener` below, so the listener is gone before any later abort can be
 * delivered. The `catch` swallows a `CommandInFlightError` from an operation key a crash left
 * in flight, which is all this path can do with one: the cancel it names may still be running.
 */
export async function settleOutcome(
  factory: Factory,
  id: string,
  signal: AbortSignal,
  options: SettleOptions,
): Promise<RouteOutcome> {
  const onAbort = () => {
    void factory.cancel(id, options.abortKey).catch(() => undefined)
  }
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    // The row's own budget, never a literal: the default lives in `config.ts` and is copied
    // onto the row at create time, so a second copy here would silently disagree with it. No
    // row means no budget to wait on — and nothing to have started either.
    const current = factory.show(id)
    if (!current) return refused("unknown_work_order", `Unknown work order ${id}`)
    let row: WorkOrderRow
    try {
      row = await factory.settle(id, current.maxActiveMs + 60_000)
    } catch (error) {
      // `settle` throws on timeout and when the factory is aborted mid-wait; both are
      // expected here and a route must not throw. The row is the outcome either way.
      const stalled = factory.show(id)
      return {
        ok: false,
        ...(stalled ? { state: stalled.state } : {}),
        message: `${options.what} did not settle: ${error instanceof Error ? error.message : String(error)}`,
        row: stalled,
      }
    }
    return { ok: options.success(row), state: row.state, message: options.message(row), row }
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

/** The intake half of the truth table: only a parked draft is a success. */
export function intakeSettle(id: string, what: "Intake" | "Redraft"): SettleOptions {
  return {
    what,
    abortKey: `cancel:${id}:aborted-intake`,
    // `blocked` (invalid, oracle passed, attempts exhausted, run failed), `cancelled` and
    // `cancel_requested` all owe the operator work.
    success: (row) => row.state === "awaiting_intake_approval",
    message: (row) =>
      row.state === "awaiting_intake_approval"
        ? "Draft awaiting approval"
        : row.state === "cancel_requested"
          ? "Cancel requested; reconciliation will finish it"
          : `${what} settled in ${row.state}${row.blockedReason ? ` (${row.blockedReason})` : ""}`,
  }
}
