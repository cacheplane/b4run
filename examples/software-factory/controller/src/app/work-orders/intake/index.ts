import type { RuntimeContext } from "@b4run/sdk"
import { IdInput } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"
import { settleIntakeOutcome } from "../../../lib/routes/settle-intake.js"
import { controllerRuntime } from "../../../lib/runtime.js"

/**
 * Starts intake and AWAITS it: the drafter turn, the read of `draft/`, the oracle proof. Like
 * `dispatch`, it runs on the work order's own thread and returns when the row has left
 * `intake_running`; `ok` iff it parked in `awaiting_intake_approval`, since a blocked intake
 * (an invalid draft, a check that passed on the baseline, attempts exhausted) owes the
 * operator work and a script must not read it as a draft to approve.
 */
export async function workflow(input: unknown, ctx: RuntimeContext) {
  return command(
    IdInput,
    input,
    () => controllerRuntime().factory(),
    async ({ id, operationKey }, factory) => {
      // Load-bearing, as in `dispatch`: an intake orphaned by a restart is re-tracked only
      // here, and without it `settleIntake` would wait the whole budget on a row nothing drives.
      await factory.reconcileWorkOrder(id)
      const outcome = await factory.intake(id, operationKey)
      if (!outcome.ok) return { ...outcome, row: factory.show(id) }
      return settleIntakeOutcome(factory, id, ctx.signal, "Intake")
    },
  )
}
