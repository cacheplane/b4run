import { IdInput } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"
import { controllerRuntime } from "../../../lib/runtime.js"

/**
 * Returns a work order a candidate failure blocked to `received`, attempts permitting, so the
 * next `dispatch` starts a fresh builder thread. Runs on the work order's own thread; it
 * denies and cancels whatever is left on the old builder thread and returns, it does not
 * dispatch.
 */
export async function workflow(input: unknown) {
  return command(
    IdInput,
    input,
    () => controllerRuntime().factory(),
    async ({ id, operationKey }, factory) => {
      await factory.reconcileWorkOrder(id)
      const outcome = await factory.retry(id, operationKey)
      return { ...outcome, row: factory.show(id) }
    },
  )
}
