import { config } from "@b4run/cli"
import { attemptContext } from "./src/blueprint/attempt-context.js"
import { sandboxPolicy } from "./src/blueprint/verifier.js"

export default config({
  appDir: "src/app",
  sandbox: { ...sandboxPolicy, provider: attemptContext().provider },
  permissions: {
    allow: {
      // Prepared dependencies are readable inside the container, never writable.
      readFile: [`/opt/fixtures/${attemptContext().task}/node_modules/`],
      listDir: [`/opt/fixtures/${attemptContext().task}/node_modules`],
      bash: [
        "npm test",
        "npm run test",
        "npm --silent test",
        // General Node diagnostics still run under the isolated sandbox policy.
        "node ",
        "printf",
        "cat",
        "ls",
        "head",
        "git diff",
        "git status",
      ],
    },
  },
})
