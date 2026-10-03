import { RedeliverInput } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"
import { controllerRuntime } from "../../../lib/runtime.js"

/**
 * Resumes a draft-PR delivery a healable block stopped (rung 4 §4), under the approval already
 * given. Runs on the work order's own thread and awaits the worker, as approve does.
 */
export async function workflow(input: unknown) {
  return command(
    RedeliverInput,
    input,
    () => controllerRuntime().factory(),
    async ({ id, revision, bundleDigest, operationKey }, factory) => {
      const outcome = await factory.redeliver(id, {
        revision,
        bundleDigest,
        ...(operationKey ? { operationKey } : {}),
      })
      return { ...outcome, row: factory.show(id) }
    },
  )
}
