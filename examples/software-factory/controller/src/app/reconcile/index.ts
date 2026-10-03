import { ReconcileInput } from "../../lib/routes/input.js"
import { command } from "../../lib/routes/outcome.js"
import { controllerRuntime } from "../../lib/runtime.js"

/** Reconciles every work order. Called by the operator or a supervisor; the app cannot do it at boot unasked. */
export async function workflow(input: unknown) {
  return command(
    ReconcileInput,
    input,
    () => controllerRuntime().factory(),
    async (_parsed, factory) => {
      // The boot walk itself, not a loop over the rows: it also settles open command intents
      // and guards each row, which a bare `reconcileWorkOrder` per row does neither of.
      await factory.reconcileAll()
      return { ok: true, message: "Reconciled" }
    },
  )
}
