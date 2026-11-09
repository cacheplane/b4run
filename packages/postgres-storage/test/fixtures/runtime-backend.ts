import { existsSync } from "node:fs"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool, type PoolConfig } from "pg"
import { afterAll, beforeAll, expect } from "vitest"
import { declareRuntimeStorageContract } from "../../../../test/agent-protocol/runtime-storage-contract.ts"

export async function runtime() {
  const path = new URL("../../src/runtime/node.ts", import.meta.url)
  expect(existsSync(path), "fresh coordinated Postgres runtime factory must exist").toBe(true)
  return import("../../src/runtime/node.ts")
}
export function realBackend() {
  let container: StartedPostgreSqlContainer
  let first: Pool
  let second: Pool
  let counter = 0
  const ownedPools = new Set<Pool>()
  const clientErrors: Error[] = []
  beforeAll(async () => {
    if (process.env.B4_TEST_PGSTORAGE !== "1")
      throw new Error("Runtime Postgres tests require B4_TEST_PGSTORAGE=1 and local Docker")
    const resourceId = process.env.B4_PROTOCOL_PG_RESOURCE_ID ?? crypto.randomUUID()
    process.stdout.write(`R8 own runtime conformance resource label ${resourceId}\n`)
    container = await new PostgreSqlContainer("postgres:16")
      .withLabels({ "org.b4run.protocol-resource": resourceId })
      .withStartupTimeout(180_000)
      .start()
    process.stdout.write(`R8 created own runtime conformance container ${container.getId()}\n`)
    first = new Pool({ connectionString: container.getConnectionUri() })
    second = new Pool({ connectionString: container.getConnectionUri() })
    for (const pool of [first, second]) {
      pool.on("error", (error) => clientErrors.push(error))
      pool.on("connect", (client) => client.on("error", (error) => clientErrors.push(error)))
    }
    const engine = await first.query<{ version: string }>("SELECT version()")
    process.stdout.write(`R3 engine: ${engine.rows[0]?.version}; container ${container.getId()}\n`)
    const [a, b] = await Promise.all([first.connect(), second.connect()])
    try {
      const [p, q] = await Promise.all([
        a.query("SELECT pg_backend_pid() AS pid"),
        b.query("SELECT pg_backend_pid() AS pid"),
      ])
      expect(p.rows[0].pid).not.toBe(q.rows[0].pid)
      process.stdout.write(`R3 independent backend processes: ${p.rows[0].pid}, ${q.rows[0].pid}\n`)
    } finally {
      a.release()
      b.release()
    }
  }, 240_000)
  afterAll(async () => {
    const failures: unknown[] = []
    const pools = [first, second, ...ownedPools].filter((pool): pool is Pool => !!pool)
    const results = await Promise.allSettled(pools.map((pool) => pool.end()))
    for (const result of results) if (result.status === "rejected") failures.push(result.reason)
    if (results.every((result) => result.status === "fulfilled"))
      process.stdout.write(
        `R8 closed all ${pools.length} own runtime conformance PostgreSQL pools\n`,
      )
    if (container) {
      const id = container.getId()
      try {
        await container.stop()
        process.stdout.write(`R3 removed own container ${id}\n`)
      } catch (error) {
        failures.push(error)
      }
    }
    failures.push(...clientErrors)
    if (failures.length)
      throw new AggregateError(failures, "Runtime conformance resource cleanup failed")
  })
  return {
    pool(options: PoolConfig) {
      const pool = new Pool({ ...options, connectionString: container.getConnectionUri() })
      pool.on("error", (error) => clientErrors.push(error))
      pool.on("connect", (client) => client.on("error", (error) => clientErrors.push(error)))
      const end = pool.end.bind(pool)
      let ending: Promise<void> | undefined
      Object.defineProperty(pool, "end", { value: () => (ending ??= end()) })
      ownedPools.add(pool)
      return pool
    },
    get first() {
      return first
    },
    get second() {
      return second
    },
    naming() {
      return { schema: "runtime_tests", tablePrefix: `b4_ap_v1_case_${++counter}` }
    },
  }
}
export const ids = {
  thread: "10000000-0000-4000-8000-000000000001",
  generation: "10000000-0000-4000-8000-000000000002",
  pausedGeneration: "10000000-0000-4000-8000-000000000003",
  predecessor: "10000000-0000-4000-8000-000000000004",
  continuation: "10000000-0000-4000-8000-000000000005",
  firstGrant: "grant-one",
  secondGrant: "grant-two",
  firstInput: "input-one",
  secondInput: "input-two",
  submission: "10000000-0000-4000-8000-000000000006",
}
export const now = () => "2026-11-06T00:00:00.000Z"
export const scope = { threadId: ids.thread, generation: ids.generation, fence: 1 }
export function sharedContract(backend: ReturnType<typeof realBackend>) {
  declareRuntimeStorageContract({
    ids,
    now,
    async createBackend() {
      const { openPostgresRuntimeInstallation } = await runtime()
      const { bindRuntimeStore, createRuntimeBinding } = await import(
        "../../src/runtime/binding.ts"
      )
      const naming = backend.naming()
      const owner = await openPostgresRuntimeInstallation({ pool: backend.first, ...naming })
      const other = await openPostgresRuntimeInstallation({ pool: backend.second, ...naming })
      const store = await bindRuntimeStore(owner, createRuntimeBinding(owner, scope), now)
      const observer = await bindRuntimeStore(other, createRuntimeBinding(other, scope), now)
      return {
        store,
        observer: observer.committedReader(),
        advanceFence: () => observer.advanceFence(),
        async close() {
          await owner.close()
          await other.close()
        },
      }
    },
  })
}
export async function bound(backend: ReturnType<typeof realBackend>, naming = backend.naming()) {
  const { openPostgresRuntimeInstallation } = await runtime()
  const { bindRuntimeStore, createRuntimeBinding } = await import("../../src/runtime/binding.ts")
  const owner = await openPostgresRuntimeInstallation({ pool: backend.first, ...naming })
  const other = await openPostgresRuntimeInstallation({ pool: backend.second, ...naming })
  const store = await bindRuntimeStore(owner, createRuntimeBinding(owner, scope), now)
  const observer = await bindRuntimeStore(other, createRuntimeBinding(other, scope), now)
  return {
    owner,
    other,
    store,
    observer,
    naming,
    async close() {
      await owner.close()
      await other.close()
    },
  }
}
