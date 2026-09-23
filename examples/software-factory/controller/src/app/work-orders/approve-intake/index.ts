import { ApproveIntakeInput } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"
import { controllerRuntime } from "../../../lib/runtime.js"

/**
 * Approves a drafted task by digest. Runs on the work order's own thread: the revision and
 * the task digest are the caller's claim about what it read, and a stale or wrong claim is a
 * refusal value, not a thrown error. The factory recomputes the digest from disk before it
 * accepts, so the person's consent binds the bytes the builder and the verifier will get.
 */
export async function workflow(input: unknown) {
  return command(
    ApproveIntakeInput,
    input,
    () => controllerRuntime().factory(),
    async ({ id, revision, taskDigest, operationKey }, factory) => {
      await factory.reconcileWorkOrder(id)
      const outcome = await factory.approveIntake(id, {
        revision,
        taskDigest,
        ...(operationKey ? { operationKey } : {}),
      })
      return { ...outcome, row: factory.show(id) }
    },
  )
}
