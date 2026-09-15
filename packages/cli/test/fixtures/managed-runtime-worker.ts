import { dockerSandbox } from "@b4run/sandbox"
import { startRuntimeServer } from "../../src/lib/dev/runtime-server.ts"

const [appRoot, scope] = process.argv.slice(2)
if (!appRoot || !scope) throw new Error("Missing runtime fixture arguments")
const runtime = await startRuntimeServer({
  appRoot,
  config: {
    sandbox: {
      provider: dockerSandbox({ scope, image: "b4-code-fixer:fixture-v1" }),
      workspace: { source: { directory: "source", include: ["file.txt"] } },
      network: { mode: "deny" },
    },
  },
})
process.send?.({ url: runtime.url })
