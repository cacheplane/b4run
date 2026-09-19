import { config } from "@b4run/cli"
import { loadFixture } from "./src/fixtures/catalog.js"
import {
  builderSandboxProvider,
  fixtureWorkspace,
  sandboxPolicy,
} from "./src/fixtures/workspace.js"

const task = process.env.FACTORY_TASK_ID ?? "cli-flags"
const { manifest } = loadFixture(task)

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    ...sandboxPolicy,
    // Same constructor the controller's workspace reader uses, so the scope and image that
    // address this thread's workspace volume are one declaration, not two.
    provider: builderSandboxProvider(),
    workspace: fixtureWorkspace(task),
  },
  toolOutput: {
    // The controller never reads a tool result, so nothing here is load-bearing
    // for correctness; the default threshold keeps large output out of context.
    previewLines: 10,
  },
  permissions: {
    allow: {
      // Prepared dependencies are readable inside the container, never writable.
      readFile: [
        `/opt/fixtures/${manifest.id}/node_modules`,
        `/opt/fixtures/${manifest.id}/node_modules/`,
      ],
      listDir: [`/opt/fixtures/${manifest.id}/node_modules`],
      // Prefix matches on the whole command. Only what the fixture's own test
      // command needs: anything else should surface as an unexpected interrupt.
      bash: ["npm test", "npm run test", "npm --silent test", "node ", "cat", "ls", "head"],
    },
  },
})
