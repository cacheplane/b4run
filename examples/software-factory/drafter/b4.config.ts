import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import { DRAFTER_IMAGE } from "./src/drafter-image.js"
import { drafterManifestDir, loadDrafterManifest, workOrderIdOf } from "./src/drafter-manifest.js"

// Boot refuses without the directory; an empty one is fine, because a thread with no
// manifest is refused at resolve time, by name.
const manifestDir = drafterManifestDir()

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    // The scope and the image are the whole of the provider's identity, and the controller's
    // reader constructs a provider from these same two values to address a thread's workspace.
    provider: dockerSandbox({
      scope: "software-factory-drafter",
      image: process.env.FACTORY_DRAFTER_IMAGE ?? DRAFTER_IMAGE,
    }),
    // Per thread: the controller writes `<dir>/<workOrderId>.json` before it creates the
    // thread with `{ factoryWorkOrderId }`, and the thread serves that capture and no other.
    workspace: async (thread) => {
      const workOrderId = workOrderIdOf(thread.metadata)
      const manifest = await loadDrafterManifest(manifestDir, workOrderId, {
        signal: thread.signal,
      })
      return verifyCapturedWorkspaceDefinition(manifest.workspace)
    },
    // Same field names as the controller's `targetSandboxPolicy`; smaller than a builder's
    // because the drafter reads and writes files and runs nothing heavier than `grep`.
    network: { mode: "deny" },
    resources: { memoryMb: 1024, cpus: 1, timeoutMs: 60_000 },
  },
  toolOutput: {
    // The controller never reads a tool result; the default threshold keeps large output out
    // of context.
    previewLines: 10,
  },
  permissions: {
    // Nobody is watching a drafter turn: a command off the list is denied, never queued for
    // a person. The list is a prefix match over the whole command line, so it bounds which
    // commands may START a shell line, not what the shell can then do (`cat x; node -e ...`
    // passes). It is not a security boundary and is not relied on as one: the real boundary
    // is that the network is denied and the controller reads only the re-rooted `draft/`.
    // `find` is left off because it carries `-exec` and `-delete`; `listDir` and `grep -r`
    // cover the need.
    mode: "non-interactive",
    allow: { bash: ["ls", "cat", "head", "tail", "grep", "wc"] },
  },
})
