import { config } from "@b4run/cli"
import { loadTask } from "./src/targets/catalog.js"
import {
  builderSandboxProvider,
  targetSandboxPolicy,
  targetWorkspace,
} from "./src/targets/workspace.js"

const task = loadTask(process.env.FACTORY_TASK_ID ?? "cli-flags")
const { commands, environmentLinks } = task.target
/** Prefix matches on the whole command: the target's build and test invocations, at the root and at the target's cwd. */
const invocations = [commands.build, commands.test]
  .filter((argv) => argv.length > 0)
  .flatMap((argv) => {
    const head = argv.slice(0, 2).join(" ")
    return commands.cwd === "." ? [head] : [head, `cd ${commands.cwd} && ${head}`]
  })

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    ...targetSandboxPolicy(task.target),
    // Same constructor the controller's workspace reader uses, so the scope and image that
    // address this thread's workspace are one declaration, not two.
    provider: builderSandboxProvider(task.target),
    // The builder's own archive of the pinned subtree; the controller captures its own.
    workspace: targetWorkspace(task, "builder"),
  },
  toolOutput: {
    // The controller never reads a tool result, so nothing here is load-bearing
    // for correctness; the default threshold keeps large output out of context.
    previewLines: 10,
  },
  permissions: {
    allow: {
      // The image's dependency tree is readable inside the container, never writable.
      readFile: environmentLinks.flatMap((link) => [link.target, `${link.target}/`]),
      listDir: environmentLinks.map((link) => link.target),
      // Only what the target's own commands need: anything else should surface as an interrupt.
      bash: [...invocations, "node ", "cat", "ls", "head"],
    },
  },
})
