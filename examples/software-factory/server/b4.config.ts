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
    // Derived by the controller from the target's own commands and environment links: only
    // what this target needs, so anything else surfaces as an interrupt.
    allow: { ...target.permissions },
  },
})
