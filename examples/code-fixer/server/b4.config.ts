import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { fixtureWorkspace, sandboxImage, sandboxPolicy } from "./src/fixtures/workspace.js"

const task = process.env.B4_CODE_FIXER_TASK ?? "cli-flags"

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    ...sandboxPolicy,
    provider: dockerSandbox({ scope: "code-fixer-local", image: sandboxImage }),
    workspace: fixtureWorkspace(task),
  },
  permissions: {
    allow: {
      // Prepared dependencies are readable inside the container, never writable.
      readFile: [
        "/opt/fixtures/cli-flags/node_modules",
        "/opt/fixtures/cli-flags/node_modules/",
        "/opt/fixtures/nullable-inputs/node_modules",
        "/opt/fixtures/nullable-inputs/node_modules/",
      ],
      listDir: [
        "/opt/fixtures/cli-flags/node_modules",
        "/opt/fixtures/nullable-inputs/node_modules",
      ],
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
