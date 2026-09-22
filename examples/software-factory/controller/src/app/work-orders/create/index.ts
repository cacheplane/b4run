import { CreateInput } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"
import { controllerRuntime } from "../../../lib/runtime.js"

/**
 * Creates a work order. The thread this runs on is the caller's choice (the work order
 * does not exist yet); the created id is the thread for every command after.
 */
export async function workflow(input: unknown) {
  return command(
    CreateInput,
    input,
    () => controllerRuntime().factory(),
    async ({ taskId, operationKey }, factory) => {
      const row = await factory.create({ taskId, ...(operationKey ? { operationKey } : {}) })
      return { ok: true, state: row.state, message: "Created", row }
    },
  )
}
