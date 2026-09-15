import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { configuredProject } from "./src/project/catalog.js"
import { projectWorkspace, sandboxImage, sandboxPolicy } from "./src/project/workspace.js"

const task = configuredProject.id

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    ...sandboxPolicy,
    provider: dockerSandbox({ scope: "code-fixer-local", image: sandboxImage }),
    workspace: projectWorkspace(task),
  },
  permissions: {
    allow: {
      // Prepared dependencies are readable inside the container, never writable.
      readFile: [`/opt/fixtures/${task}/node_modules`, `/opt/fixtures/${task}/node_modules/`],
      listDir: [`/opt/fixtures/${task}/node_modules`],
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
