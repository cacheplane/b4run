import { join } from "node:path"
import { Pool } from "pg"
import { expect, it } from "vitest"
import { postgresRuntimeStorage } from "../../postgres-storage/dist/node.js"
import {
  createRuntimeStorageHost,
  type RuntimeStorageHost,
} from "../src/lib/runtime/storage-host.ts"
import { fixture, reportOwnedCleanup } from "./fixtures/protocol-admission.ts"
import { runtimeWorker } from "./fixtures/protocol-owned-worker.ts"

it.skipIf(process.env.B4_ADMISSION_POSTGRES !== "1")(
  "native permission storage preserves the actual runtime catalog across worker boot",
  async () => {
    const started = performance.now()
    const phase = (name: string) => {
      if (process.env.B4_ADMISSION_TIMINGS === "1")
        process.stdout.write(
          `R8 catalog phase ${name} ${Math.round(performance.now() - started)}ms\n`,
        )
    }
    const f = await fixture()
    phase("fixture-ready")
    let pool: Pool | undefined, worker: RuntimeStorageHost | undefined
    let processOwner: ReturnType<typeof runtimeWorker> | undefined
    let primary: { error: unknown } | undefined
    const cleanup: unknown[] = []
    try {
      const boot = f.native.workerBoot,
        rules = f.native.ruleStore()
      if (!boot || !rules) throw new Error("Actual owned PostgreSQL native hooks are required")
      const diagnosticPool = new Pool({ connectionString: boot.connectionString })
      diagnosticPool.on("error", (error) => cleanup.push(error))
      pool = diagnosticPool
      const marker = async () =>
        (
          await diagnosticPool.query(
            `SELECT * FROM ${boot.schema}.${boot.tablePrefix}_runtime_installation`,
          )
        ).rows
      const before = await marker()
      const open = () =>
        createRuntimeStorageHost(
          postgresRuntimeStorage({
            pool: diagnosticPool,
            schema: boot.schema,
            tablePrefix: boot.tablePrefix,
          }),
        )
      worker = await open()
      phase("baseline-worker-boot")
      expect(worker.installationId).toBe(f.storage.installationId)
      await worker.close()
      worker = undefined
      await rules.ready()
      phase("permission-ready")
      await rules.load()
      phase("permission-load")
      expect(await f.native.ruleRows()).toEqual([])
      const coordinator = rules.rememberedRules
      if (!coordinator) throw new Error("Actual durable permission coordinator is required")
      const intent = await coordinator.prepare("catalog-always", [
        { tool: "tool", pattern: "send" },
      ])
      expect(await coordinator.apply(intent)).toBe("applied")
      await rules.load()
      expect(rules.match("tool", "send")).toBe("allow")
      expect(await f.native.ruleRows()).toEqual([{ kind: "allow", tool: "tool", pattern: "send" }])
      phase("always-rule-committed")
      worker = await open()
      phase("second-worker-boot")
      expect(worker.installationId).toBe(f.storage.installationId)
      expect(await marker()).toEqual(before)
      processOwner = runtimeWorker({
        root: f.directory,
        counter: join(f.directory, "unused-effects"),
        mode: "run",
        ...boot,
      })
      const ready = await processOwner.wait("ready")
      phase("independent-process-boot")
      expect(ready).toMatchObject({
        installationId: f.storage.installationId,
        pid: processOwner.child.pid,
      })
      expect(ready?.pid).not.toBe(process.pid)
      expect(await marker()).toEqual(before)
      processOwner.child.send("close")
      const closed = await processOwner.wait("closed")
      expect(closed).toMatchObject({ poolClosed: true, pid: processOwner.child.pid })
      if (processOwner.child.exitCode === null && processOwner.child.signalCode === null)
        await new Promise<void>((resolve) => processOwner?.child.once("exit", () => resolve()))
      expect(processOwner.child.exitCode).toBe(0)
      process.stdout.write(
        `R8 catalog independent Node ${processOwner.child.pid} pool closed and exited0\n`,
      )
    } catch (error) {
      primary = { error }
      throw error
    } finally {
      for (const close of [
        () => processOwner?.kill(),
        () => worker?.close(),
        async () => {
          if (!pool) return
          await pool.end()
          process.stdout.write("R8 catalog diagnostic PostgreSQL pool closed\n")
        },
        () => f.close(),
      ])
        try {
          await close()
        } catch (error) {
          cleanup.push(error)
        }
      reportOwnedCleanup("Native permission catalog cleanup failed", cleanup, primary)
    }
  },
  30_000,
)
