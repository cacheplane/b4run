import cluster from "node:cluster"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { bindRuntimeStore, createRuntimeBinding } from "../../src/runtime/binding.ts"
import { openRuntimeInstallation } from "../../src/runtime/index.ts"
import { checkpoint, eventId, now, receipt, run, scope, thread } from "./runtime-data.ts"

const root = process.argv[2]
const mode = process.argv[3]
if (!root) throw new Error("Missing runtime root")
if (mode === "cluster" && cluster.isPrimary) {
  cluster.setupPrimary({
    exec: fileURLToPath(new URL("./runtime-worker.ts", import.meta.url)),
    args: [root, "cluster-worker"],
    execArgv: ["--import", "tsx"],
  })
  const worker = cluster.fork()
  worker.on("message", (message) => process.send?.(message))
  worker.on("exit", () => process.disconnect?.())
} else {
  try {
    const owner = openRuntimeInstallation(root)
    const store = bindRuntimeStore(owner, createRuntimeBinding(owner, scope))
    if (mode === "commit") {
      await store.transaction(async (tx) => {
        await tx.runs.put(run)
        await tx.checkpoints.put(checkpoint)
        await tx.thread.put(thread)
        await tx.receipts.put(receipt)
        await tx.journal.append({
          eventId,
          namespace: [],
          ownerRunId: run.run.run_id,
          event: {
            type: "event",
            method: "lifecycle",
            params: { namespace: [], timestamp: Date.parse(now), data: { event: "completed" } },
          },
        })
      })
    }
    process.send?.({ status: "owned", installationId: owner.installationId })
    // Publication is a distinct action after the durable commit. The test kills
    // the owner before sending it, so durable facts must survive without it.
    process.on("message", (command) => {
      if (command === "publish") writeFileSync(`${root}/published`, "published")
      else {
        owner.close()
        process.disconnect?.()
      }
    })
  } catch (error) {
    process.send?.({ status: "rejected", error: String(error) }, () => process.disconnect?.())
  }
}
