import { config } from "@b4run/cli"
import { attemptContext } from "./src/blueprint/attempt-context.js"
import { sandboxPolicy } from "./src/blueprint/verifier.js"

export default config({
  appDir: "src/app",
  sandbox: { ...sandboxPolicy, provider: attemptContext().provider },
  permissions: {
    allow: {
      bash: [
        "npm test",
        "npm run test",
        "npm --silent test",
        "node --import tsx src/cli.ts",
        "node --import tsx test/evaluate-tool.ts",
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
