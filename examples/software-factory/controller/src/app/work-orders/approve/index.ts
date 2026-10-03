import { ApproveInput } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"
import { controllerRuntime } from "../../../lib/runtime.js"

/**
 * Approves a review bundle. Runs on the work order's own thread: the revision and the
 * bundle digest are the caller's claim about what it read, and a stale claim is a refusal
 * value, not a thrown error.
 */
export async function workflow(input: unknown) {
  return command(
    ApproveInput,
    input,
    () => controllerRuntime().factory(),
    async ({ id, revision, bundleDigest, operationKey }, factory) => {
      await factory.reconcileWorkOrder(id)
      const outcome = await factory.approve(id, {
        revision,
        bundleDigest,
        ...(operationKey ? { operationKey } : {}),
      })
      return { ...outcome, row: factory.show(id) }
    },
  )
}
