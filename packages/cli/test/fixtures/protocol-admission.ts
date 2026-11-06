import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadAccessPolicy } from "@b4run/sdk"
import type { B4Message, RuntimeReceiptRecord, RuntimeStore } from "@b4run/sdk/agent-protocol"
import { sqliteRuntimeStorage } from "@b4run/sqlite-storage"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool } from "pg"
import { afterAll, beforeAll, expect } from "vitest"
import { postgresRuntimeStorage } from "../../../postgres-storage/dist/node.js"
import { setRequestPrincipal } from "../../src/lib/dev/auth.ts"
import { authorizeProtocolAgent, createAgentCatalog } from "../../src/lib/dev/protocol/catalog.ts"
import { mergePublicMessages } from "../../src/lib/dev/protocol/messages.ts"
import { createAdmissionService } from "../../src/lib/runtime/admission.ts"
import { createRuntimeStorageHost } from "../../src/lib/runtime/storage-host.ts"

/** Real lifecycle only: admission and reconciliation always call production. */
function realBackend() {
  let container: StartedPostgreSqlContainer | undefined
  let first: Pool, second: Pool
  let counter = 0
  const errors: Error[] = []
  beforeAll(async () => {
    if (process.env.B4_TEST_PGSTORAGE !== "1")
      throw new Error("R4 Postgres fixtures require B4_TEST_PGSTORAGE=1")
    container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
    first = new Pool({ connectionString: container.getConnectionUri() })
    second = new Pool({ connectionString: container.getConnectionUri() })
    for (const pool of [first, second]) {
      pool.on("error", (error) => errors.push(error))
      pool.on("connect", (client) => client.on("error", (error) => errors.push(error)))
    }
    const [a, b] = await Promise.all([first.connect(), second.connect()])
    try {
      const [one, two] = await Promise.all([
        a.query("SELECT pg_backend_pid() AS pid"),
        b.query("SELECT pg_backend_pid() AS pid"),
      ])
      expect(one.rows[0].pid).not.toBe(two.rows[0].pid)
      process.stdout.write(
        `R4 actual PostgreSQL: independent processes ${one.rows[0].pid}/${two.rows[0].pid}; default pg.Pool max=${first.options.max}\n`,
      )
    } finally {
      a.release()
      b.release()
    }
  }, 240_000)
  afterAll(async () => {
    try {
      await Promise.all([first?.end(), second?.end()])
    } finally {
      if (container) {
        const id = container.getId()
        await container.stop()
        process.stdout.write(`R4 removed own container ${id}\n`)
      }
    }
    expect(errors, "own SQL clients settle before fixture cleanup").toEqual([])
  })
  return {
    get first() {
      return first
    },
    naming() {
      return { schema: "r4_protocol", tablePrefix: `b4_ap_v1_case_${++counter}` }
    },
  }
}
const postgres = process.env.B4_ADMISSION_POSTGRES === "1" ? realBackend() : undefined

export const token = "10000000-0000-4000-8000-000000000010"
export const threadId = "10000000-0000-4000-8000-000000000011"
export const body = (extra: Record<string, unknown> = {}) => ({
  input: { messages: [{ id: "user-1", role: "user", content: "hello" }] },
  metadata: { b4: { v: 1, submissionId: token } },
  ...extra,
})
export async function fixture(
  factory = undefined as import("@b4run/sdk/agent-protocol").RuntimeStorageFactory | undefined,
) {
  const bootStarted = performance.now()
  const directory = mkdtempSync(join(tmpdir(), "b4-admission-"))
  let registration!: import("@b4run/sdk/agent-protocol").RuntimeStorageRegistrationOptions
  const chosen =
    factory ??
    (postgres
      ? postgresRuntimeStorage({ pool: postgres.first, ...postgres.naming() })
      : sqliteRuntimeStorage(directory))
  const storage = await createRuntimeStorageHost(async (register) =>
    chosen((value) => {
      registration = value
      return register(value)
    }),
  )
  if (process.env.B4_ADMISSION_TIMINGS === "1")
    process.stdout.write(`R4 fixture boot ${Math.round(performance.now() - bootStarted)}ms\n`)
  const work = new Set<Promise<unknown>>()
  function track<T>(label: string, promise: Promise<T>): Promise<T> {
    const started = performance.now()
    work.add(promise)
    void promise
      .finally(() => {
        work.delete(promise)
        if (process.env.B4_ADMISSION_TIMINGS === "1")
          process.stdout.write(`R4 ${label} ${Math.round(performance.now() - started)}ms\n`)
      })
      .catch(() => {})
    return promise
  }
  let allowed = true
  let agent = "/chat#agent"
  let originalAvailable = true
  let messages = true
  let configDefaults: Readonly<Record<string, unknown>> = {}
  let combineInput: ((input: unknown, messages: readonly B4Message[]) => unknown) | undefined
  let resolutions = 0
  let parse = (value: unknown) => value
  const pauses = new Map<string, { entered: () => void; wait: Promise<void> }>()
  const pause = async (phase: string) => {
    const value = pauses.get(phase)
    if (value) {
      pauses.delete(phase)
      value.entered()
      await value.wait
    }
  }
  let fail: "beforeCommit" | "afterCommit" | undefined
  const revokedOrigins = new Set<string>()
  const requests: import("@b4run/sdk").ThreadAccessRequest[] = []
  const policy: ThreadAccessPolicy = {
    create: (request) => {
      requests.push(request)
      return allowed ? { decision: "allow", stamp: { owner: "alice" } } : { decision: "deny" }
    },
    fallback: (request) => {
      requests.push(request)
      return {
        decision:
          allowed &&
          !revokedOrigins.has(request.provenance?.sourceThreadId ?? request.threadId ?? "")
            ? "allow"
            : "deny",
      }
    },
  }
  const request = (principal = "alice"): Request => {
    const result = new Request("http://local/runs", { method: "POST" })
    setRequestPrincipal(result, { id: principal })
    return result
  }
  const registry = () => ({
    appRoot: directory,
    entries: ["/chat#agent", "/changed#agent", "/other#agent"]
      .filter((id) => originalAvailable || id !== "/chat#agent")
      .map((id) => ({
        assistantId: id,
        routeId: id.split("#")[0] ?? id,
        routeFile: `${directory}/entry.ts`,
        routePath: "chat/agent.ts",
        mode: "agent" as const,
      })),
    lookup(id: string) {
      return this.entries.find((entry) => entry.assistantId === id) ?? null
    },
  })
  const service = createAdmissionService({
    storage,
    deploymentId: "deployment-test",
    policy,
    catalog: async (request) => {
      await pause("catalog")
      return createAgentCatalog({
        request,
        appRoot: directory,
        config: { server: { agentProtocol: { defaultAgentId: agent } } },
        registry: registry(),
        middleware: undefined,
        limits: { requestBytes: 1048576, pendingPrompts: 64 },
      })
    },
    authorizeAgent: (request, id) =>
      authorizeProtocolAgent({ request, registry: registry(), middleware: undefined }, id),
    resolveAgent: async () => {
      resolutions++
      await pause("resolution")
      return {
        boundary: {
          adapter: {
            parseInput: (value: unknown) => parse(value),
            ...(messages
              ? {
                  messages: {
                    reduce: mergePublicMessages,
                    ...(combineInput ? { combineInput } : {}),
                  },
                }
              : {}),
          },
        },
        config: { allowedKeys: ["temperature"] },
        defaults: configDefaults,
      }
    },
    failpoint(point) {
      if (point === fail) {
        fail = undefined
        throw new Error(`lost-${point}`)
      }
    },
  })
  return {
    storage,
    service,
    request,
    admit: (value = body(), principal = "alice") =>
      track("admission", service.admit(request(principal), value)),
    search: (metadata: Record<string, unknown>, extra = {}, principal = "alice") =>
      track("search", service.searchRuns(request(principal), { metadata, ...extra })),
    lookup: (submissionId = token, extra = {}) =>
      track(
        "lookup",
        service.searchRuns(request(), {
          metadata: { "b4.submissionId": submissionId, "b4.submissionKind": "b4", ...extra },
        }),
      ),
    pauseNext(phase: "catalog" | "resolution") {
      let entered!: () => void, release!: () => void
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve
      })
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      pauses.set(phase, { entered, wait })
      return { entered: enteredPromise, release }
    },
    revokeOrigin(id: string) {
      revokedOrigins.add(id)
    },
    policyRequests() {
      return requests
    },
    deny() {
      allowed = false
    },
    removeOriginalAgent() {
      originalAvailable = false
    },
    defaultAgent(value: string) {
      agent = value
    },
    originalConfigDefaults(value: Readonly<Record<string, unknown>>) {
      configDefaults = value
    },
    combineMessages(value: typeof combineInput) {
      combineInput = value
    },
    resolutionCount() {
      return resolutions
    },
    declareMessages(value: boolean) {
      messages = value
    },
    parser(value: typeof parse) {
      parse = value
    },
    loseNextAcknowledgement() {
      fail = "afterCommit"
    },
    failBeforeCommit() {
      fail = "beforeCommit"
    },
    async store(id: string): Promise<RuntimeStore> {
      return registration.openThread(id, false).then((value) => {
        if (!value) throw new Error("missing test thread")
        return value
      })
    },
    async snapshot(id: string) {
      return (await this.store(id)).snapshot()
    },
    async seedReceipt(id: string, receipt: RuntimeReceiptRecord) {
      await (await this.store(id)).transaction((tx) => tx.receipts.put(receipt))
    },
    async close() {
      await Promise.allSettled([...work])
      await storage.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
