import { appendFileSync } from "node:fs"
import type { RuntimeStore } from "@b4run/sdk/agent-protocol"
import { sqliteRuntimeStorage } from "@b4run/sqlite-storage"
import { Pool } from "pg"
import { postgresRuntimeStorage } from "../../../postgres-storage/dist/node.js"
import { setRequestPrincipal } from "../../src/lib/dev/auth.ts"
import { authorizeProtocolAgent, createAgentCatalog } from "../../src/lib/dev/protocol/catalog.ts"
import { createAdmissionService } from "../../src/lib/runtime/admission.ts"
import { createExecutionHost } from "../../src/lib/runtime/executor.ts"
import { parkPermissions } from "../../src/lib/runtime/permissions.ts"
import { createRuntimeStorageHost } from "../../src/lib/runtime/storage-host.ts"

type Boot = {
  root: string
  counter: string
  mode: "accept" | "marker" | "effect" | "run" | "park-gap" | "park-released"
  connectionString?: string
  schema?: string
  tablePrefix?: string
}
const boot = await new Promise<Boot>((resolve) => process.once("message", resolve))
const pool = boot.connectionString
  ? new Pool({ connectionString: boot.connectionString })
  : undefined
const storage = await createRuntimeStorageHost(
  pool
    ? postgresRuntimeStorage({
        pool,
        schema: boot.schema ?? "public",
        tablePrefix: boot.tablePrefix ?? "b4_ap_v1",
      })
    : sqliteRuntimeStorage(boot.root),
)
const registry = {
  appRoot: boot.root,
  entries: [
    {
      assistantId: "/chat#agent",
      routeId: "/chat",
      routeFile: `${boot.root}/entry.ts`,
      routePath: "chat/agent.ts",
      mode: "agent" as const,
    },
  ],
  lookup(id: string) {
    return this.entries.find((entry) => entry.assistantId === id) ?? null
  },
}
const admission = createAdmissionService({
  storage,
  deploymentId: "worker-test",
  policy: { create: () => ({ decision: "allow" }), fallback: () => ({ decision: "allow" }) },
  catalog: async (request) =>
    createAgentCatalog({
      request,
      appRoot: boot.root,
      config: { server: { agentProtocol: { defaultAgentId: "/chat#agent" } } },
      registry,
      middleware: undefined,
      limits: { requestBytes: 1048576, pendingPrompts: 64 },
    }),
  authorizeAgent: (request, id) =>
    authorizeProtocolAgent({ request, registry, middleware: undefined }, id),
  resolveAgent: async () => ({ boundary: { adapter: { parseInput: (value) => value } } }),
})
let captured: RuntimeStore | undefined
let unwind: (() => void) | undefined
const host = createExecutionHost({
  storage,
  async invoke({ store, signal, run }) {
    captured = store
    if (boot.mode === "park-gap" || boot.mode === "park-released") {
      await store.transaction((tx) =>
        parkPermissions(tx, run.run.run_id, [
          {
            interruptId: "permission",
            namespace: [],
            request: { kind: "tool", detail: { toolName: "effect", suggestedPattern: "effect" } },
            protectedProposal: {},
          },
        ]),
      )
      process.send?.({ status: "parked" })
      if (boot.mode === "park-gap")
        await new Promise<void>((resolve) => {
          unwind = resolve
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      return {}
    }
    if (boot.mode === "marker") process.send?.({ status: "marker" })
    else {
      if (boot.mode === "effect")
        await store.transaction(async (tx) => {
          const run = (await tx.runs.list())[0]
          if (!run) throw new Error("Missing executing Run")
          await tx.runs.put({ ...run, result: { values: { partial: "durably retained" } } })
        })
      appendFileSync(boot.counter, "effect\n")
      process.send?.({ status: "effect" })
    }
    if (boot.mode === "effect" || boot.mode === "marker")
      await new Promise<void>((resolve) => {
        unwind = resolve
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
    return { values: { worker: true } }
  },
})
process.on("message", async (command) => {
  try {
    if (command === "tick") {
      await host.tick()
      if (boot.mode === "run" || boot.mode === "park-released") await host.idle()
      process.send?.({ status: "ticked" })
    } else if (command === "stale-write") {
      if (!captured) {
        process.send?.({ status: "stale-write", code: "no-captured-store" })
        return
      }
      try {
        await captured.transaction(async (tx) => {
          const run = (await tx.runs.list())[0]
          if (run) await tx.runs.put({ ...run, run: { ...run.run, status: "success" } })
        })
        process.send?.({ status: "stale-write", code: "accepted" })
      } catch (error) {
        process.send?.({ status: "stale-write", code: (error as { code?: string }).code })
      }
    } else if (command === "close") {
      unwind?.()
      await host.idle()
      await host.close()
      await storage.close()
      await pool?.end()
      process.send?.({ status: "closed", poolClosed: pool?.ended ?? true, pid: process.pid }, () =>
        process.disconnect?.(),
      )
    }
  } catch (error) {
    process.send?.({ status: "error", message: String(error) })
  }
})
if (boot.mode === "accept") {
  const request = new Request("http://local/runs", { method: "POST" })
  setRequestPrincipal(request, { id: "alice" })
  const accepted = await admission.admit(request, {
    input: { value: 1 },
    on_completion: "keep",
    metadata: { b4: { v: 1, submissionId: "10000000-0000-4000-8000-000000000010" } },
  })
  process.send?.({ status: "accepted", threadId: accepted.threadId, runId: accepted.runId })
} else
  process.send?.({
    status: "ready",
    ownerId: host.ownerId,
    installationId: storage.installationId,
    pid: process.pid,
  })
