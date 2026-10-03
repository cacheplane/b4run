import { IdInput } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"
import { controllerRuntime } from "../../../lib/runtime.js"

/** Denies a review bundle. Runs on the work order's own thread. */
export async function workflow(input: unknown) {
  return command(
    IdInput,
    input,
    () => controllerRuntime().factory(),
    async ({ id, operationKey }, factory) => {
      await factory.reconcileWorkOrder(id)
      const outcome = await factory.deny(id, operationKey)
      return { ...outcome, row: factory.show(id) }
    },
  )
}
