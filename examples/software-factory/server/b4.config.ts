import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import {
  builderManifestDir,
  loadBuilderManifest,
  loadBuilderTarget,
  workOrderIdOf,
} from "./src/builder-manifest.js"

// The process's one target: provider, policy and permissions are one per app, so they are
// read once, here. Boot refuses without it.
const { target } = loadBuilderTarget()
// Boot refuses without the directory; an empty one is fine, because a thread with no
// manifest is refused at resolve time, by name.
const manifestDir = builderManifestDir()

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    // No cast: the target schema models the policy key by key, so what it parses IS the
    // sandbox policy the framework accepts.
    ...target.policy,
    // The scope and the image are the whole of the provider's identity, and the controller's
    // own reader constructs a provider from these same two values: they address this thread's
    // workspace, so a reader built with either different would open a different one.
    provider: dockerSandbox({ scope: target.scope, image: target.image }),
    // Per thread: the controller writes `<dir>/<workOrderId>.json` before it creates the
    // thread with `{ factoryWorkOrderId }`, and the thread serves that capture and no other.
    // The controller captured it; the builder verifies and serves it.
    workspace: async (thread) => {
      const workOrderId = workOrderIdOf(thread.metadata)
      const manifest = await loadBuilderManifest(manifestDir, workOrderId, target.id, {
        signal: thread.signal,
      })
      return verifyCapturedWorkspaceDefinition(manifest.workspace)
    },
  },
  toolOutput: {
    // The controller never reads a tool result, so nothing here is load-bearing
    // for correctness; the default threshold keeps large output out of context.
    previewLines: 10,
  },
  permissions: {
    // Nobody answers a builder's prompt: the controller has no gate for it, and a parked
    // command blocked the first live run's work order as `unexpected_interrupt` after its one
    // attempt. A fixed property of the builder app, not of the target, so it is set here and
    // not in the target file: a command off the list is a tool error the model reads and
    // recovers from. The controller still blocks on any interrupt that does reach it.
    mode: "non-interactive",
    // Derived by the controller from the target's own commands and environment links, plus
    // the read-only commands every builder reads with (`builderPermissions`).
    allow: { ...target.permissions },
  },
})
