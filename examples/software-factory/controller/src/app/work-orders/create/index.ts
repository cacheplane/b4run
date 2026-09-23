import { createInputSchema } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"
import { controllerRuntime } from "../../../lib/runtime.js"

/**
 * Creates a work order. The thread this runs on is the caller's choice (the work order
 * does not exist yet); the created id is the thread for every command after.
 */
export async function workflow(input: unknown) {
  return command(
    createInputSchema(input),
    input,
    () => controllerRuntime().factory(),
    async (input, factory) => {
      const key = input.operationKey ? { operationKey: input.operationKey } : {}
      const row =
        "taskId" in input
          ? await factory.create({ taskId: input.taskId, ...key })
          : await factory.createFromIssue({
              origin: input.origin,
              pin: input.pin,
              issue: input.issue,
              ...key,
            })
      return { ok: true, state: row.state, message: "Created", row }
    },
  )
}
