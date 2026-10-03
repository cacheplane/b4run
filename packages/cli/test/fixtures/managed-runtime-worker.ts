import { dockerSandbox } from "@b4run/sandbox"
import { startRuntimeServer } from "../../src/lib/dev/runtime-server.ts"

const [appRoot, scope, image] = process.argv.slice(2)
if (!appRoot || !scope || !image) throw new Error("Missing runtime fixture arguments")
const runtime = await startRuntimeServer({
  appRoot,
  config: {
    sandbox: {
      provider: dockerSandbox({ scope, image }),
      workspace: { source: { directory: "source", include: ["file.txt"] } },
      network: { mode: "deny" },
    },
  },
})
process.send?.({ url: runtime.url })
