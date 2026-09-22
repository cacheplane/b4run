import type { Factory } from "../controller/factory.js"
import type { WorkOrderRow } from "../domain/work-order.js"
import { type RouteOutcome, refused } from "./outcome.js"

/**
 * Await an intake run the caller just started (`intake`, or the redraft a `reject-intake`
 * triggered) and report where it settled. Shared by both routes so the abort listener, the
 * budget and the "did not settle" shape cannot drift between them.
 *
 * The abort listener fires when the runtime cancels this thread's run and cancels the work
 * order. As in `dispatch`, it is safe against a late abort by scheduling: there is no `await`
 * between the settle and the `removeEventListener`, so the listener is gone before any later
 * abort can be delivered. The `catch` swallows a `CommandInFlightError` from an operation key
 * a crash left in flight, which is all this path can do with one.
 */
export async function settleIntakeOutcome(
  factory: Factory,
  id: string,
  signal: AbortSignal,
  what: "Intake" | "Redraft",
): Promise<RouteOutcome> {
  const onAbort = () => {
    void factory.cancel(id, `cancel:${id}:aborted-intake`).catch(() => undefined)
  }
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    // The row's own budget, never a literal (see `dispatch`).
    const current = factory.show(id)
    if (!current) return refused("unknown_work_order", `Unknown work order ${id}`)
    let row: WorkOrderRow
    try {
      row = await factory.settleIntake(id, current.maxActiveMs + 60_000)
    } catch (error) {
      // `settleIntake` throws on timeout and when the factory is aborted mid-wait; both are
      // expected here and a route must not throw. The row is the outcome either way.
      const stalled = factory.show(id)
      return {
        ok: false,
        ...(stalled ? { state: stalled.state } : {}),
        message: `${what} did not settle: ${error instanceof Error ? error.message : String(error)}`,
        row: stalled,
      }
    }
    // Only a parked draft is a success: `blocked` (invalid, oracle passed, attempts
    // exhausted, run failed), `cancelled` and `cancel_requested` all owe the operator work.
    const parked = row.state === "awaiting_intake_approval"
    return {
      ok: parked,
      state: row.state,
      message: parked
        ? "Draft awaiting approval"
        : row.state === "cancel_requested"
          ? "Cancel requested; reconciliation will finish it"
          : `${what} settled in ${row.state}${row.blockedReason ? ` (${row.blockedReason})` : ""}`,
      row,
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}
