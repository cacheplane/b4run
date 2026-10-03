import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"

export default config({
  // No bash allow rules: an unknown command pauses for a person.
  permissions: { mode: "interactive" },
  sandbox: {
    provider: dockerSandbox({ scope: "my-agent", image: "node:24-slim" }),
    network: { mode: "deny" },
  },
})
