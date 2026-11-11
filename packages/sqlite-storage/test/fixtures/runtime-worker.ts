import cluster from "node:cluster"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { bindRuntimeStore, createRuntimeBinding } from "../../src/runtime/binding.ts"
import { openRuntimeInstallation } from "../../src/runtime/index.ts"
import { checkpoint, eventId, now, receipt, run, scope, thread } from "./runtime-data.ts"

const root = process.argv[2]
const mode = process.argv[3]
if (!root) throw new Error("Missing runtime root")
if (mode === "hot-runtime-journal" || mode === "hot-owner-journal") {
  const isRuntime = mode === "hot-runtime-journal"
  const db = new DatabaseSync(
    join(root, ".b4/agent-protocol/v1", isRuntime ? "runtime.sqlite" : "runtime-owner.sqlite"),
  )
  db.exec(
    "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=1; PRAGMA cache_spill=ON",
  )
  if (isRuntime) db.exec("UPDATE runtime_installation SET version=999")
  else
    db.exec(
      "CREATE TABLE owner_probe(version INTEGER); INSERT INTO owner_probe VALUES (2); CREATE TABLE owner_spill(payload TEXT); INSERT INTO owner_spill VALUES ('committed')",
    )
  db.exec("BEGIN EXCLUSIVE")
  if (isRuntime) {
    db.exec("UPDATE runtime_installation SET version=2")
    db.prepare("UPDATE runtime_owner SET process_start=?").run("synthetic-spill".repeat(100_000))
  } else {
    db.exec("UPDATE owner_probe SET version=1")
    db.prepare("UPDATE owner_spill SET payload=?").run("synthetic-spill".repeat(100_000))
  }
  // Keep the uncommitted spill and its real rollback journal alive until the
  // parent kills this process. No payload is sent over IPC or logged.
  process.send?.({ status: "hot-journal" })
  process.on("message", () => undefined)
} else if (mode === "cluster" && cluster.isPrimary) {
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
