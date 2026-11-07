import { createPermissionsStore } from "../../dist/node.js"

process.send?.({ ready: true })
process.once("message", async ({ appRoot, pattern }) => {
  process.send?.({ started: true })
  try {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.addAllow("tool", pattern)
    process.send?.({ done: true })
    process.disconnect()
  } catch (error) {
    process.stderr.write(String(error))
    process.exitCode = 1
    process.disconnect()
  }
})
