import type { RuntimeContext } from "@b4run/sdk"
import type { WorkOrderRow } from "../../../lib/domain/work-order.js"
import { IdInput } from "../../../lib/routes/input.js"
import { command, refused } from "../../../lib/routes/outcome.js"
import { controllerRuntime } from "../../../lib/runtime.js"

/**
 * Dispatches and AWAITS the run: the builder turn, then verification. The route returns
 * when the work order has left its active states. It runs on the work order's own thread,
 * so a second command on it while this is in flight is the runtime's `run_in_flight`, and
 * the runtime's cancel of this thread aborts `ctx.signal`, which cancels the work order.
 */
export async function workflow(input: unknown, ctx: RuntimeContext) {
  return command(
    IdInput,
    input,
    () => controllerRuntime().factory(),
    async ({ id, operationKey }, factory) => {
      // Load-bearing: a work order orphaned by a restart is re-tracked only here, and
      // without it `settle` would wait the whole budget on a row nothing is driving.
      await factory.reconcileWorkOrder(id)
      const outcome = await factory.dispatch(id, operationKey)
      if (!outcome.ok) return { ...outcome, row: factory.show(id) }
      // Fires when the runtime cancels this thread's run. Safe against a late abort by
      // SCHEDULING, not by the command refusing: `cancel` is legal from every non-terminal
      // state, so an abort landing after `settle` resolved would cancel a settled work order
      // — there is no `await` between the settle and the `removeEventListener` below, so the
      // listener is gone before any later abort can be delivered. The `catch` swallows a
      // `CommandInFlightError` from an operation key a crash left in flight, which is all
      // this path can do with one: the cancel it names may still be running.
      const onAbort = () => {
        void factory.cancel(id, `cancel:${id}:aborted-dispatch`).catch(() => undefined)
      }
      ctx.signal.addEventListener("abort", onAbort, { once: true })
      try {
        // The row's own budget, never a literal: the default lives in `config.ts` and is
        // copied onto the row at create time, so a second copy here would silently disagree
        // with it. No row means no budget to wait on — and nothing to dispatch either.
        const current = factory.show(id)
        if (!current) return refused("unknown_work_order", `Unknown work order ${id}`)
        const budget = current.maxActiveMs
        let row: WorkOrderRow
        try {
          row = await factory.settle(id, budget + 60_000)
        } catch (error) {
          // `settle` throws on timeout and when the factory is aborted mid-wait; both are
          // expected here and a route must not throw. The row is the outcome either way.
          const stalled = factory.show(id)
          return {
            ok: false,
            ...(stalled ? { state: stalled.state } : {}),
            message: `Dispatch did not settle: ${error instanceof Error ? error.message : String(error)}`,
            row: stalled,
          }
        }
        // Settled means "not active", which includes `cancel_requested`: say so rather than
        // report a work order that is still owed a cancel confirmation as finished.
        return {
          ok: row.state !== "cancel_requested",
          state: row.state,
          message:
            row.state === "cancel_requested"
              ? "Cancel requested; reconciliation will finish it"
              : "Settled",
          row,
        }
      } finally {
        ctx.signal.removeEventListener("abort", onAbort)
      }
    },
  )
}
