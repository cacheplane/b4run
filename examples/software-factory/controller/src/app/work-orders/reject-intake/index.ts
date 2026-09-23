import type { RuntimeContext } from "@b4run/sdk"
import { RejectIntakeInput } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"
import { intakeSettle, settleOutcome } from "../../../lib/routes/settle.js"
import { controllerRuntime } from "../../../lib/runtime.js"

/**
 * Rejects a drafted task with a note. With attempts left the factory starts a redraft on the
 * same thread, and this route AWAITS it the way `intake` does, so the caller sees the
 * redraft's outcome rather than an `intake_running` row it would have to poll. With no
 * attempts left the row is `blocked`, which is the outcome, and `ok` is false either way
 * unless the redraft parked a new draft.
 */
export async function workflow(input: unknown, ctx: RuntimeContext) {
  return command(
    RejectIntakeInput,
    input,
    () => controllerRuntime().factory(),
    async ({ id, note, operationKey }, factory) => {
      await factory.reconcileWorkOrder(id)
      const outcome = await factory.rejectIntake(id, {
        note,
        ...(operationKey ? { operationKey } : {}),
      })
      if (!outcome.ok) return { ...outcome, row: factory.show(id) }
      // The factory calls an exhausted rejection a success (the rejection was recorded); for
      // a script the row is `blocked`, which is not a draft to approve, so `ok` is false and
      // the message says why rather than keeping the factory's wording.
      if (outcome.state !== "intake_running")
        return {
          ...outcome,
          ok: false,
          message: "Intake rejected; no drafter attempts remain, the work order is blocked",
          row: factory.show(id),
        }
      return settleOutcome(factory, id, ctx.signal, intakeSettle(id, "Redraft"))
    },
  )
}
