import { config } from "@b4run/cli"
// TEMPORARY until the builder manifest lands (Task 3)
import { loadTask } from "../controller/src/lib/targets/catalog.js"
// TEMPORARY until the builder manifest lands (Task 3)
import { builderPermissions } from "../controller/src/lib/targets/permissions.js"
// TEMPORARY until the builder manifest lands (Task 3)
import {
  builderSandboxProvider,
  targetSandboxPolicy,
  targetWorkspace,
} from "../controller/src/lib/targets/workspace.js"

const task = loadTask(process.env.FACTORY_TASK_ID ?? "cli-flags")

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
    // Derived from the target's own commands and environment links: only what this target
    // needs, so anything else surfaces as an interrupt.
    allow: { ...builderPermissions(task.target) },
  },
})
