import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import { loadBuilderManifest } from "./src/builder-manifest.js"

const manifest = loadBuilderManifest()
// No cast: the manifest schema models the policy key by key, so what it parses IS the
// sandbox policy the framework accepts.
const policy = manifest.target.policy

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    ...policy,
    // The scope and the image are the whole of the provider's identity, and the controller's
    // own reader constructs a provider from these same two values: they address this thread's
    // workspace, so a reader built with either different would open a different one.
    provider: dockerSandbox({ scope: manifest.target.scope, image: manifest.target.image }),
    // The controller captured this workspace; the builder verifies and serves it. A resolver
    // rather than a static definition because a captured definition is what the controller
    // hands over, and sub-project 3 makes this a per-thread choice.
    workspace: async () => verifyCapturedWorkspaceDefinition(manifest.workspace),
  },
  toolOutput: {
    // The controller never reads a tool result, so nothing here is load-bearing
    // for correctness; the default threshold keeps large output out of context.
    previewLines: 10,
  },
  permissions: {
    // Derived by the controller from the target's own commands and environment links: only
    // what this target needs, so anything else surfaces as an interrupt.
    allow: { ...manifest.target.permissions },
  },
})
