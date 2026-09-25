import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import {
  builderHandoffOf,
  isFactoryImage,
  refuseRetiredVariables,
  stagedBuilderWorkspace,
} from "./src/builder-handoff.js"

refuseRetiredVariables()

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    // No default image: every thread runs the image its handoff names, and only an image the
    // factory prepared may be named. A managed workspace's image is read from its own record.
    provider: dockerSandbox({ scope: "software-factory-builder", images: isFactoryImage }),
    // The controller reads a thread's workspace through this app's own port
    // (`POST /threads/:id/workspace/inspect`), authorized by src/thread-access.ts, and
    // never opens this app's installation store or its volumes itself.
    workspaceRead: "http",
    // The ceiling every thread's policy is held to: a thread may not open what the app denies.
    network: { mode: "deny" },
    // The controller uploads each work order's captured source (`PUT /workspace/sources/:digest`,
    // stamped as the controller's by src/thread-access.ts) and creates the thread naming it,
    // with the work order's target in `factoryBuilder`. The policy admits a create only for a
    // source the controller uploaded; the framework verifies the source byte for byte and hands
    // it to the resolver as `thread.staged`.
    stagedWorkspaces: true,
    // Per thread, once, at its first admission: the thread runs the staged workspace, image,
    // policy and permissions, recorded, and no other. The handoff and the staged workspace must
    // name the same digest, links and baseline; nothing is read from disk.
    thread: async (thread) => {
      const handoff = builderHandoffOf(thread.metadata)
      return {
        workspace: stagedBuilderWorkspace(thread.staged, handoff),
        environment: { image: handoff.target.image },
        policy: handoff.target.policy,
        permissions: { allow: handoff.target.permissions },
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
    // attempt. A fixed property of the builder app, never of a handoff (a handoff supplies an
    // allow-list, not a mode): a command off a thread's list is a tool error the model reads
    // and recovers from. The controller still blocks on any interrupt that does reach it.
    mode: "non-interactive",
  },
})
