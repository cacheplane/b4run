import type { RuntimeContext } from "@b4run/sdk"
import { IdInput } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"
import { settleOutcome } from "../../../lib/routes/settle.js"
import { controllerRuntime } from "../../../lib/runtime.js"

/**
 * Dispatches and AWAITS the run: the builder turn, then verification. The route returns
 * when the work order has left its active states. It runs on the work order's own thread,
 * so a second command on it while this is in flight is the runtime's `run_in_flight`, and
 * the runtime's cancel of this thread aborts `ctx.signal`, which cancels the work order
 * (see `settleOutcome` for the abort listener's safety argument).
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
      return settleOutcome(factory, id, ctx.signal, {
        what: "Dispatch",
        abortKey: `cancel:${id}:aborted-dispatch`,
        // Settled means "not active", which includes `cancel_requested`: say so rather than
        // report a work order that is still owed a cancel confirmation as finished.
        success: (row) => row.state !== "cancel_requested",
        message: (row) =>
          row.state === "cancel_requested"
            ? "Cancel requested; reconciliation will finish it"
            : "Settled",
      })
    },
  )
}
