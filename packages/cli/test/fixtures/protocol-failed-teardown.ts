import { it } from "vitest"
import { createExecutionHost } from "../../src/lib/runtime/executor.ts"
import { sharedPermissionFixtures } from "./protocol-admission.ts"

const fixtures = sharedPermissionFixtures({ onCompletion: "keep" })
// Deliberate child-runner failure: actual work drains before its owned hook fails.
it("preserves a delegated real host's post-drain teardown failure", async () => {
  const f = await fixtures.create()
  process.stdout.write(`R7 created lifecycle app directory ${f.directory}\n`)
  await f.admit()
  const host = createExecutionHost({ ...f.authority, invoke: async () => ({}) })
  f.ownHost({
    ...host,
    async close() {
      await host.close()
      throw new Error("intentional-post-drain-teardown-failure")
    },
  })
}, 30_000)
