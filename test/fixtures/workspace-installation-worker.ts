import { createSourceBundle } from "@b4run/workspace/node"
import { openWorkspaceInstallation } from "../../packages/sqlite-storage/src/workspace/installation.ts"

const root = process.argv[2]
if (!root) throw new Error("Missing app root")
try {
  const owner = openWorkspaceInstallation(root)
  const bundle = createSourceBundle([
    { path: "bytes.bin", bytes: Uint8Array.of(0, 255, 128), executable: false },
  ])
  owner.sources.put(bundle)
  process.send?.({ status: "owned", installationId: owner.installationId, digest: bundle.digest })
  process.on("message", () => {
    owner.close()
    process.disconnect()
  })
} catch (error) {
  process.send?.({ status: "rejected", error: String(error) }, () => process.disconnect())
}
