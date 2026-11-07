import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ThreadAccessPolicy } from "@b4run/sdk"
import type { B4Message, RuntimeReceiptRecord, RuntimeStore } from "@b4run/sdk/agent-protocol"
import { sqliteRuntimeStorage } from "@b4run/sqlite-storage"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool } from "pg"
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest"
import { postgresRuntimeStorage } from "../../../postgres-storage/dist/node.js"
import { setRequestPrincipal } from "../../src/lib/dev/auth.ts"
import { authorizeProtocolAgent, createAgentCatalog } from "../../src/lib/dev/protocol/catalog.ts"
import { mergePublicMessages } from "../../src/lib/dev/protocol/messages.ts"
import { createAdmissionService } from "../../src/lib/runtime/admission.ts"
import type { ExecutionHost } from "../../src/lib/runtime/executor.ts"
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
      try {
        await closeSharedOwners()
      } finally {
        await Promise.all([first?.end(), second?.end()])
      }
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
  borrowed?: BorrowedFixture,
) {
  const bootStarted = performance.now()
  const directory = mkdtempSync(join(tmpdir(), "b4-admission-"))
  if (borrowed) borrowed.directory = directory
  let registration = borrowed?.owner
    .registration as import("@b4run/sdk/agent-protocol").RuntimeStorageRegistrationOptions
  const chosen =
    factory ??
    (postgres
      ? postgresRuntimeStorage({ pool: postgres.first, ...postgres.naming() })
      : sqliteRuntimeStorage(directory))
  const storage =
    borrowed?.owner.storage ??
    (await createRuntimeStorageHost(async (register) =>
      chosen((value) => {
        registration = value
        return register(value)
      }),
    ))
  if (process.env.B4_ADMISSION_TIMINGS === "1")
    process.stdout.write(`R4 fixture boot ${Math.round(performance.now() - bootStarted)}ms\n`)
  const work = borrowed?.work ?? new Set<Promise<unknown>>()
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
  function trackWork<T>(label: string, run: () => Promise<T>): Promise<T> {
    if (borrowed?.group.closing) return Promise.reject(new Error("Permission fixture is closing"))
    return track(label, run())
  }
  let allowed = true
  let agent = "/chat#agent"
  const unavailableAgents = new Set<string>()
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
      .filter((id) => (originalAvailable || id !== "/chat#agent") && !unavailableAgents.has(id))
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
    authority: {
      storage,
      deploymentId: "deployment-test",
      policy,
      authorizeAgent: (request: Request, id: string) =>
        authorizeProtocolAgent({ request, registry: registry(), middleware: undefined }, id),
    },
    directory,
    storage,
    service,
    request,
    admit: (
      value = borrowed
        ? body({
            thread_id: borrowed.threadId,
            if_not_exists: "create",
            metadata: { b4: { v: 1, submissionId: borrowed.submissionId } },
          })
        : body(),
      principal = "alice",
    ) =>
      trackWork("admission", async () => {
        if (borrowed && (value as Record<string, unknown>).thread_id !== borrowed.threadId)
          throw new Error("Borrowed fixture must use its owned Thread")
        const result = await service.admit(request(principal), value)
        if (borrowed) {
          const row = await registration.readThread(result.threadId)
          if (!row) throw new Error("Missing admitted fixture scope")
          borrowed.scopes.set(result.threadId, row.generation)
        }
        return result
      }),
    search: (metadata: Record<string, unknown>, extra = {}, principal = "alice") =>
      trackWork("search", () => service.searchRuns(request(principal), { metadata, ...extra })),
    lookup: (submissionId = token, extra = {}) =>
      trackWork("lookup", () =>
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
    removeAgent(id: string) {
      unavailableAgents.add(id)
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
    trackWork,
    ownHost(host: ExecutionHost) {
      borrowed?.hosts.add(host)
    },
    async store(id: string): Promise<RuntimeStore> {
      if (borrowed?.group.closing) throw new Error("Permission fixture is closing")
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
      if (borrowed) return borrowed.closeGroup()
      await Promise.allSettled([...work])
      await storage.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

interface BorrowedGroup {
  closing: boolean
  readonly fixtures: Set<BorrowedFixture>
  closePromise?: Promise<void>
}
interface BorrowedFixture {
  readonly owner: SharedPermissionOwner
  readonly group: BorrowedGroup
  readonly threadId: string
  readonly submissionId: string
  readonly scopes: Map<string, string>
  readonly hosts: Set<ExecutionHost>
  readonly work: Set<Promise<unknown>>
  readonly closeGroup: () => Promise<void>
  directory?: string
}
interface SharedPermissionOwner {
  readonly storage: Awaited<ReturnType<typeof createRuntimeStorageHost>>
  readonly registration: import("@b4run/sdk/agent-protocol").RuntimeStorageRegistrationOptions
  readonly root: string
  readonly naming?: { readonly schema: string; readonly tablePrefix: string }
  readonly groups: Set<BorrowedGroup>
  failed: boolean
  close(): Promise<void>
}
const sharedPermissionOwners = new Set<SharedPermissionOwner>()
async function closeSharedOwners(): Promise<void> {
  const results = await Promise.allSettled(
    [...sharedPermissionOwners].map((owner) => owner.close()),
  )
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (errors.length) throw new AggregateError(errors, "Shared permission fixture shutdown failed")
}

/** R6-only lifecycle. One actual server installation, independent fresh scopes;
 * no candidate/read filters or per-fixture execution dispatcher. */
export function sharedPermissionFixtures() {
  let owner: SharedPermissionOwner
  let group: BorrowedGroup | undefined
  async function closeGroup(value: BorrowedGroup): Promise<void> {
    if (value.closePromise) return value.closePromise
    value.closing = true
    value.closePromise = (async () => {
      const results = await Promise.allSettled(
        [...value.fixtures].flatMap((f) => [...f.hosts].map((host) => host.close())),
      )
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      )
      for (const f of value.fixtures) {
        if (f.work.size)
          process.stdout.write(`R6 teardown draining ${f.work.size} active request(s)\n`)
        const settled = await Promise.allSettled([...f.work])
        errors.push(
          ...settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        )
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          "Owned permission work did not drain cleanly; scopes preserved",
        )
      const scopes = [...value.fixtures].flatMap((f) =>
        [...f.scopes].map(([threadId, generation]) => ({ threadId, generation })),
      )
      await deleteOwnedPermissionScopes(owner, scopes)
      for (const f of value.fixtures)
        if (f.directory) rmSync(f.directory, { recursive: true, force: true })
    })().catch((error) => {
      owner.failed = true
      throw error
    })
    return value.closePromise
  }
  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "b4-r6-permission-installation-"))
    chmodSync(root, 0o700)
    let registration!: import("@b4run/sdk/agent-protocol").RuntimeStorageRegistrationOptions
    const naming = postgres?.naming()
    const chosen =
      postgres && naming
        ? postgresRuntimeStorage({ pool: postgres.first, ...naming })
        : sqliteRuntimeStorage(root)
    const storage = await createRuntimeStorageHost((register) =>
      chosen((value) => {
        registration = value
        return register(value)
      }),
    )
    let closePromise: Promise<void> | undefined
    owner = {
      root,
      storage,
      registration,
      ...(naming ? { naming } : {}),
      groups: new Set(),
      failed: false,
      close() {
        if (closePromise) return closePromise
        closePromise = (async () => {
          const errors: unknown[] = []
          for (const value of owner.groups) {
            try {
              await closeGroup(value)
            } catch (error) {
              errors.push(error)
            }
          }
          if (owner.failed) {
            try {
              await preservePermissionFixture(owner, errors)
            } catch (error) {
              errors.push(error)
            }
          }
          try {
            await storage.close()
          } catch (error) {
            owner.failed = true
            errors.push(error)
          }
          if (!owner.failed) rmSync(root, { recursive: true, force: true })
          else process.stdout.write(`R6 preserved failed shared fixture ${root}\n`)
          if (errors.length)
            throw new AggregateError(errors, "Shared permission owner cleanup failed")
        })()
        return closePromise
      },
    }
    sharedPermissionOwners.add(owner)
  }, 240_000)
  beforeEach(() => {
    if (owner.failed)
      throw new Error("Prior shared permission teardown failed; refusing another test")
    group = { closing: false, fixtures: new Set() }
    owner.groups.add(group)
  })
  afterEach(async () => {
    if (group) await closeGroup(group)
  })
  afterAll(async () => {
    await owner?.close()
  })
  return {
    async create() {
      if (!group || group.closing) throw new Error("Permission fixture group is closing")
      const current = group
      const state: BorrowedFixture = {
        owner,
        group: current,
        threadId: crypto.randomUUID(),
        submissionId: crypto.randomUUID(),
        scopes: new Map(),
        hosts: new Set(),
        work: new Set(),
        closeGroup: () => closeGroup(current),
      }
      current.fixtures.add(state)
      return fixture(undefined, state)
    },
    async reset() {
      if (!group) throw new Error("Missing permission fixture group")
      await closeGroup(group)
      group = { closing: false, fixtures: new Set() }
      owner.groups.add(group)
    },
    async candidates() {
      return owner.registration.execution?.listCandidates()
    },
  }
}

const permissionScopeTables = [
  "checkpoint_writes",
  "aliases",
  "projections",
  "leases",
  "journal",
  "checkpoint_lineage",
  "grants",
  "pending",
  "receipts",
  "inbox",
  "maintenance",
  "checkpoints",
  "runs",
  "threads",
  "run_identities",
  "checkpoint_identities",
  "scopes",
] as const
interface OwnedPermissionScope {
  readonly threadId: string
  readonly generation: string
}
function permissionTable(owner: SharedPermissionOwner, name: string): string {
  return owner.naming ? `${owner.naming.schema}.${owner.naming.tablePrefix}_${name}` : name
}
/** Trusted TEST-ONLY teardown after every fixture host/request drained. This is
 * neither a runtime delete implementation nor an R11 capability/certification. */
async function deleteOwnedPermissionScopes(
  owner: SharedPermissionOwner,
  scopes: readonly OwnedPermissionScope[],
): Promise<void> {
  const pairs = [
    ...new Map(
      scopes.map((scope) => [JSON.stringify([scope.threadId, scope.generation]), scope]),
    ).values(),
  ]
  if (!pairs.length) return
  const expected = new Set(pairs.map((scope) => JSON.stringify([scope.threadId, scope.generation])))
  const values = pairs.flatMap((scope) => [scope.threadId, scope.generation])
  const validate = (
    rows: readonly {
      thread_id: string
      generation: string
      execution_owner: unknown
      leases: unknown
    }[],
  ) => {
    const actual = new Set(rows.map((row) => JSON.stringify([row.thread_id, row.generation])))
    if (
      rows.length !== pairs.length ||
      actual.size !== expected.size ||
      rows.some(
        (row) =>
          !expected.has(JSON.stringify([row.thread_id, row.generation])) ||
          row.execution_owner !== null ||
          row.leases !== 0,
      )
    )
      throw new Error("Owned permission scope is missing or still active; preserving every scope")
  }
  if (owner.naming) {
    if (!postgres) throw new Error("Missing owned PostgreSQL fixture pool")
    const client = await postgres.first.connect()
    try {
      await client.query("BEGIN")
      const owned = `owned(thread_id,generation) AS (VALUES ${pairs.map((_, i) => `($${i * 2 + 1}::text,$${i * 2 + 2}::text)`).join(",")})`
      const result = await client.query(
        `WITH ${owned} SELECT s.thread_id,s.generation,s.execution_owner,
        (SELECT count(*)::int FROM ${permissionTable(owner, "leases")} l WHERE l.thread_id=s.thread_id AND l.generation=s.generation) AS leases
        FROM ${permissionTable(owner, "scopes")} s JOIN owned o USING(thread_id,generation) FOR UPDATE OF s`,
        values,
      )
      validate(result.rows)
      const tables = ["native_writes", "native_checkpoints", ...permissionScopeTables]
      const deletes = tables
        .slice(0, -1)
        .map(
          (table, i) =>
            `d${i} AS (DELETE FROM ${permissionTable(owner, table)} t USING owned o WHERE t.thread_id=o.thread_id AND t.generation=o.generation RETURNING t.thread_id)`,
        )
      const removed = await client.query(
        `WITH ${owned},${deletes.join(",")} DELETE FROM ${permissionTable(owner, "scopes")} s USING owned o WHERE s.thread_id=o.thread_id AND s.generation=o.generation RETURNING s.thread_id,s.generation`,
        values,
      )
      if (removed.rowCount !== pairs.length)
        throw new Error("Owned permission scope deletion was incomplete")
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  } else {
    const db = new DatabaseSync(join(owner.root, ".b4", "agent-protocol", "v1", "runtime.sqlite"))
    try {
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE")
      const where = pairs.map(() => "(thread_id=? AND generation=?)").join(" OR ")
      const rows = db
        .prepare(`SELECT s.thread_id,s.generation,s.execution_owner,s.execution_nonce,
        (SELECT count(*) FROM leases l WHERE l.thread_id=s.thread_id AND l.generation=s.generation) AS leases
        FROM scopes s WHERE ${where}`)
        .all(...values)
      validate(rows as unknown as Parameters<typeof validate>[0])
      if (rows.some((row) => row.execution_nonce !== null))
        throw new Error("Owned permission scope still has an execution nonce; preserving it")
      for (const table of permissionScopeTables)
        db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...values)
      db.exec("COMMIT")
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK")
      db.close()
    }
  }
}

async function preservePermissionFixture(
  owner: SharedPermissionOwner,
  errors: readonly unknown[],
): Promise<void> {
  const scopes = [...owner.groups].flatMap((group) =>
    [...group.fixtures].flatMap((f) =>
      [...f.scopes].map(([threadId, generation]) => ({ threadId, generation })),
    ),
  )
  const records: Record<string, unknown> = {}
  if (owner.naming) {
    if (!postgres) throw new Error("Missing owned PostgreSQL fixture pool")
    for (const table of ["native_writes", "native_checkpoints", ...permissionScopeTables])
      records[table] = (
        await postgres.first.query(`SELECT * FROM ${permissionTable(owner, table)}`)
      ).rows
  } else {
    const db = new DatabaseSync(join(owner.root, ".b4", "agent-protocol", "v1", "runtime.sqlite"), {
      readOnly: true,
    })
    try {
      for (const table of permissionScopeTables)
        records[table] = db.prepare(`SELECT * FROM ${table}`).all()
    } finally {
      db.close()
    }
  }
  writeFileSync(
    join(owner.root, "teardown-failure.json"),
    JSON.stringify({ scopes, errors: errors.map(String), records }, null, 2),
    { mode: 0o600 },
  )
}
