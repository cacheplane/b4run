import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import {
  builderManifestDir,
  isFactoryImage,
  loadBuilderManifest,
  refuseRetiredVariables,
  workOrderIdOf,
} from "./src/builder-manifest.js"

refuseRetiredVariables()

// Boot refuses without the directory; an empty one is fine, because a thread with no
// manifest is refused at admission, by name.
const manifestDir = builderManifestDir()

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    // No default image: every thread runs the image its manifest names, and only an image the
    // factory prepared may be named. The scope is the whole of the storage address the
    // controller's reader needs; a managed workspace's image is read from its own record.
    provider: dockerSandbox({ scope: "software-factory-builder", images: isFactoryImage }),
    // The ceiling every thread's policy is held to: a thread may not open what the app denies.
    network: { mode: "deny" },
    // Per thread, once, at its first admission: the controller writes `<dir>/<workOrderId>.json`
    // before it creates the thread with `{ factoryWorkOrderId }`, and the thread runs that
    // manifest's workspace, image, policy and permissions, recorded, and no other. The
    // controller captured the workspace; the builder verifies it byte for byte and serves it.
    thread: async (thread) => {
      const manifest = await loadBuilderManifest(manifestDir, workOrderIdOf(thread.metadata), {
        signal: thread.signal,
      })
      return {
        workspace: verifyCapturedWorkspaceDefinition(manifest.workspace),
        environment: { image: manifest.target.image },
        policy: manifest.target.policy,
        permissions: { allow: manifest.target.permissions },
      }
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
    // attempt. A fixed property of the builder app, never of a manifest (a manifest supplies an
    // allow-list, not a mode): a command off a thread's list is a tool error the model reads
    // and recovers from. The controller still blocks on any interrupt that does reach it.
    mode: "non-interactive",
  },
})
