import { IdInput } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"
import { controllerRuntime } from "../../../lib/runtime.js"

/**
 * Cancels a work order. Runs on the work order's own thread, so it cannot start while a
 * dispatch is in flight on it: the runtime answers `run_in_flight`, and the way to stop a
 * live dispatch is `POST /threads/<id>/cancel`.
 */
export async function workflow(input: unknown) {
  return command(
    IdInput,
    input,
    () => controllerRuntime().factory(),
    async ({ id, operationKey }, factory) => {
      await factory.reconcileWorkOrder(id)
      const outcome = await factory.cancel(id, operationKey)
      return { ...outcome, row: factory.show(id) }
    },
  )
}
