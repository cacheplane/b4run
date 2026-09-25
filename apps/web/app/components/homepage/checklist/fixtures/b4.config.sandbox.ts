import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"

export default config({
  sandbox: {
    provider: dockerSandbox({ scope: "my-agent", image: "node:24-slim" }),
  },
})
