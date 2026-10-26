import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool } from "pg"
import { afterAll, beforeAll, expect, test } from "vitest"
import { postgresCheckpointer } from "../src/checkpointer.js"
import * as storage from "../src/index.js"

const enabled = process.env.B4_TEST_PGSTORAGE === "1"
let container: StartedPostgreSqlContainer
let pool: Pool

beforeAll(async () => {
  if (!enabled) return
  container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
  pool = new Pool({ connectionString: container.getConnectionUri() })
  pool.on("error", () => {})
}, 240_000)

afterAll(async () => {
  await pool?.end()
  await container?.stop()
})

function options() {
  return { pool, tablePrefix: `admit_${crypto.randomUUID().replaceAll("-", "")}` }
}

const createAdmission = storage.createPostgresRunAdmission

test("exports request-scoped Postgres run admission", () => {
  expect("createPostgresRunAdmission" in storage).toBe(true)
})

test.skipIf(!enabled)(
  "independent admissions exclude one another and release permits a successor",
  async () => {
    const input = options()
    const a = createAdmission(input)
    const b = createAdmission(input)
    try {
      expect(await a.tryAcquire("thread")).toBe(true)
      expect(await b.tryAcquire("thread")).toBe(false)
      expect(await a.tryAcquire("thread")).toBe(true)
      await a.release()
      expect(await b.tryAcquire("thread")).toBe(true)
      await expect(a.pool.query("SELECT 1")).rejects.toThrow()
    } finally {
      await a.close()
      await b.close()
    }
  },
)

test.skipIf(!enabled)(
  "expiry fences the old owner's queries and transactions after takeover",
  async () => {
    const input = options()
    const a = createAdmission(input)
    const b = createAdmission(input)
    try {
      expect(await a.tryAcquire("thread")).toBe(true)
      await pool.query(
        `UPDATE ${input.tablePrefix}_run_admissions SET expires_at = clock_timestamp() - interval '1 second'`,
      )
      expect(await b.tryAcquire("thread")).toBe(true)

      await expect(a.pool.query("SELECT 1")).rejects.toThrow()
      const stale = await a.pool.connect()
      try {
        await expect(stale.query("BEGIN")).rejects.toThrow()
        await stale.query("ROLLBACK")
      } finally {
        stale.release()
      }
      await a.close()
      const c = createAdmission(input)
      try {
        expect(await c.tryAcquire("thread")).toBe(false)
        expect((await b.pool.query<{ value: number }>("SELECT 1 AS value")).rows[0]?.value).toBe(1)
      } finally {
        await c.close()
      }
      expect(a.signal.aborted).toBe(true)
    } finally {
      await a.close()
      await b.close()
    }
  },
)

test.skipIf(!enabled)(
  "fenced checkpointer retains its transactional writes and pool ownership",
  async () => {
    const input = options()
    const admission = createAdmission(input)
    const saver = postgresCheckpointer({ ...input, pool: admission.pool })
    try {
      await saver.ready()
      expect(await admission.tryAcquire("thread")).toBe(true)
      await saver.put(
        { configurable: { thread_id: "thread", checkpoint_ns: "" } },
        {
          v: 4,
          id: "checkpoint",
          ts: new Date().toISOString(),
          channel_values: { messages: ["owned"] },
          channel_versions: { messages: 1 },
          versions_seen: {},
        },
        { source: "loop", step: 1, parents: {} },
        { messages: 1 },
      )
      await saver.putWrites(
        { configurable: { thread_id: "thread", checkpoint_ns: "", checkpoint_id: "checkpoint" } },
        [["messages", "pending"]],
        "task",
      )
      expect(
        (await saver.getTuple({ configurable: { thread_id: "thread", checkpoint_ns: "" } }))
          ?.pendingWrites,
      ).toHaveLength(1)
    } finally {
      await admission.close()
      await saver.close()
    }
    expect((await pool.query("SELECT 1 AS value")).rows[0].value).toBe(1)
  },
)

test.skipIf(!enabled)("renewal prevents takeover and expired renewal is terminal", async () => {
  const input = options()
  const a = createAdmission({ ...input, leaseDurationMs: 180, heartbeatIntervalMs: 30 })
  const b = createAdmission(input)
  try {
    expect(await a.tryAcquire("thread")).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await b.tryAcquire("thread")).toBe(false)
    await pool.query(
      `UPDATE ${input.tablePrefix}_run_admissions SET expires_at = clock_timestamp() - interval '1 second'`,
    )
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(a.signal.aborted).toBe(true)
    expect(await b.tryAcquire("thread")).toBe(true)
    await a.release()
    expect((await b.pool.query("SELECT 1")).rows).toHaveLength(1)
  } finally {
    await a.close()
    await b.close()
  }
})

test.skipIf(!enabled)(
  "late COMMIT rolls back effects after expiry while the row is locked",
  async () => {
    const input = options()
    const admission = createAdmission({ ...input, leaseDurationMs: 250, heartbeatIntervalMs: 200 })
    await pool.query(`CREATE TABLE ${input.tablePrefix}_effects (value integer)`)
    const client = await admission.pool.connect()
    try {
      expect(await admission.tryAcquire("thread")).toBe(true)
      await client.query("BEGIN")
      await client.query(`INSERT INTO ${input.tablePrefix}_effects VALUES (1)`)
      await expect(client.query("BEGIN")).rejects.toThrow(/nested/)
      await new Promise((resolve) => setTimeout(resolve, 350))
      await expect(client.query("COMMIT")).rejects.toThrow()
      expect((await pool.query(`SELECT * FROM ${input.tablePrefix}_effects`)).rows).toEqual([])
    } finally {
      client.release()
      await admission.close()
    }
  },
)

test.skipIf(!enabled)(
  "synchronous client release rolls back before a size-one pool can reuse it",
  async () => {
    const owned = new Pool({ connectionString: container.getConnectionUri(), max: 1 })
    const input = { ...options(), pool: owned }
    const admission = createAdmission(input)
    try {
      await owned.query(`CREATE TABLE ${input.tablePrefix}_effects (value integer)`)
      expect(await admission.tryAcquire("thread")).toBe(true)
      const client = await admission.pool.connect()
      await client.query("BEGIN")
      await client.query(`INSERT INTO ${input.tablePrefix}_effects VALUES (1)`)
      client.release()

      expect((await owned.query(`SELECT * FROM ${input.tablePrefix}_effects`)).rows).toEqual([])
    } finally {
      await admission.close()
      await owned.end()
    }
  },
)

test.skipIf(!enabled)(
  "independent pools share naming and request objects stay terminal",
  async () => {
    const other = new Pool({ connectionString: container.getConnectionUri() })
    const input = { ...options(), schema: "admission_tests" }
    const a = createAdmission(input)
    const b = createAdmission({ ...input, pool: other })
    try {
      await a.ready()
      expect(await a.tryAcquire("thread")).toBe(true)
      expect(await b.tryAcquire("thread")).toBe(false)
      await expect(a.tryAcquire("other")).rejects.toThrow(/another thread/)
      await a.release()
      await a.release()
      await expect(a.tryAcquire("thread")).rejects.toThrow(/released/)
      expect(await b.tryAcquire("thread")).toBe(true)
    } finally {
      await a.close()
      await b.close()
      await other.end()
    }
  },
)

test("rejects invalid admission naming and durations before querying", () => {
  const input = { pool: {} as Pool }

  expect(() => createAdmission({ ...input, schema: "Bad" })).toThrow(/identifier/)
  expect(() => createAdmission({ ...input, leaseDurationMs: 0 })).toThrow(/heartbeat/)
  expect(() =>
    createAdmission({ ...input, leaseDurationMs: 100, heartbeatIntervalMs: 100 }),
  ).toThrow(/heartbeat/)
})

test.skipIf(!enabled)(
  "active queries cannot escape fencing through compound or unsupported controls",
  async () => {
    const admission = createAdmission(options())
    const client = await admission.pool.connect()
    try {
      expect(await admission.tryAcquire("thread")).toBe(true)
      for (const sql of [
        "SELECT 1; COMMIT; SELECT 2",
        "SELECT 1-- comment\r; COMMIT; SELECT 2",
        "BEGIN WORK",
        "COMMIT AND CHAIN",
        "ROLLBACK TO savepoint",
        "SAVEPOINT escape",
      ]) {
        await expect(client.query(sql)).rejects.toThrow(/unsupported/)
      }
      expect((await admission.pool.query("SELECT '; COMMIT' AS literal")).rows).toHaveLength(1)
    } finally {
      client.release()
      await admission.close()
    }
  },
)

test.skipIf(!enabled)("ownership validation errors immediately abort the request", async () => {
  let rejectValidation = false
  const raw: storage.SqlPool = {
    query: pool.query.bind(pool),
    end: async () => {},
    async connect() {
      const client = await pool.connect()
      return {
        query: async <R = unknown>(
          sql: string,
          values?: readonly unknown[],
        ): Promise<storage.SqlResult<R>> => {
          if (rejectValidation && sql.startsWith("SELECT thread_id FROM"))
            throw new Error("connection lost")
          const result = await client.query(sql, values as unknown[])
          return { rows: result.rows as R[] }
        },
        release: () => client.release(),
      }
    },
  }
  const admission = createAdmission({ ...options(), pool: raw })
  try {
    expect(await admission.tryAcquire("thread")).toBe(true)
    rejectValidation = true

    await expect(admission.pool.query("SELECT 1")).rejects.toThrow("connection lost")
    expect(admission.signal.aborted).toBe(true)
  } finally {
    await admission.close()
  }
})

test.skipIf(!enabled)(
  "release waits for an in-flight renewal before deleting ownership",
  async () => {
    let renewalStarted: () => void = () => {}
    let finishRenewal: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      renewalStarted = resolve
    })
    const continueRenewal = new Promise<void>((resolve) => {
      finishRenewal = resolve
    })
    const raw: storage.SqlPool = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect()
        return {
          async query<R = unknown>(
            sql: string,
            values?: readonly unknown[],
          ): Promise<storage.SqlResult<R>> {
            if (sql.startsWith("UPDATE ")) {
              renewalStarted()
              await continueRenewal
            }
            const result = await client.query(sql, values as unknown[])
            return { rows: result.rows as R[] }
          },
          release: () => client.release(),
        }
      },
      end: async () => {},
    }
    const input = options()
    const a = createAdmission({
      ...input,
      pool: raw,
      leaseDurationMs: 1000,
      heartbeatIntervalMs: 20,
    })
    const b = createAdmission(input)
    try {
      expect(await a.tryAcquire("thread")).toBe(true)
      await started
      let completed = false
      const released = a.release().then(() => {
        completed = true
      })
      await Promise.resolve()
      expect(completed).toBe(false)
      finishRenewal()
      await released

      expect((await pool.query(`SELECT * FROM ${input.tablePrefix}_run_admissions`)).rows).toEqual(
        [],
      )
      expect(await b.tryAcquire("thread")).toBe(true)
    } finally {
      finishRenewal()
      await a.close()
      await b.close()
    }
  },
)

test("close ends only owned pools and is idempotent even before acquisition", async () => {
  let closes = 0
  const raw: storage.SqlPool = {
    query: async () => ({ rows: [] }),
    connect: async () => {
      throw new Error("unexpected connect")
    },
    end: async () => {
      closes++
    },
  }
  const admission = createAdmission({ pool: raw, ownsPool: true, assumeMigrated: true })

  await admission.ready()
  await admission.close()
  await admission.close()
  await admission.pool.end()

  expect(closes).toBe(1)
  expect(admission.signal.aborted).toBe(true)
  await expect(admission.pool.query("SELECT 1")).rejects.toThrow(/released/)
  expect(() => createAdmission({})).toThrow(/pool/)
})

test.skipIf(!enabled)(
  "a renewal blocked on an independent row lock cannot revive an expired owner",
  async () => {
    const input = options()
    const a = createAdmission({ ...input, leaseDurationMs: 600, heartbeatIntervalMs: 100 })
    const b = createAdmission(input)
    const lock = await pool.connect()
    try {
      expect(await a.tryAcquire("thread")).toBe(true)
      await lock.query("BEGIN")
      await lock.query(
        `SELECT thread_id FROM ${input.tablePrefix}_run_admissions WHERE thread_id = $1 FOR UPDATE`,
        ["thread"],
      )
      let waiting = false
      for (let attempt = 0; attempt < 30 && !waiting; attempt++) {
        const status = await pool.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1) AS waiting",
          [`%${input.tablePrefix}_run_admissions%`],
        )
        waiting = status.rows[0]?.waiting ?? false
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      expect(a.signal.aborted).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 800))
      await lock.query("ROLLBACK")
      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(a.signal.aborted).toBe(true)
      expect(await b.tryAcquire("thread")).toBe(true)
    } finally {
      await lock.query("ROLLBACK")
      lock.release()
      await a.close()
      await b.close()
    }
  },
)

for (const tag of ["tag", "é"]) {
  test.skipIf(!enabled)(`dollar syntax ${tag} cannot hide an unfenced write`, async () => {
    const input = options()
    const admission = createAdmission(input)
    await pool.query(`CREATE TABLE ${input.tablePrefix}_effects (value integer)`)
    try {
      expect(await admission.tryAcquire("thread")).toBe(true)
      const sql =
        tag === "é"
          ? `SELECT $é$--$é$; COMMIT; INSERT INTO ${input.tablePrefix}_effects VALUES (1); SELECT 1`
          : `SELECT 1 AS foo$tag$; COMMIT; INSERT INTO ${input.tablePrefix}_effects VALUES (1); SELECT 1 AS foo$tag$`

      const error = await admission.pool.query(sql).then(
        () => undefined,
        (reason: unknown) => reason,
      )

      expect((await pool.query(`SELECT * FROM ${input.tablePrefix}_effects`)).rows).toEqual([])
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toMatch(/unsupported/)
    } finally {
      await admission.close()
    }
  })
}

test.skipIf(!enabled)(
  "active SQL rejects uncertain dollar and backslash syntax while bound values remain supported",
  async () => {
    const admission = createAdmission(options())
    try {
      expect(await admission.tryAcquire("thread")).toBe(true)
      for (const sql of [
        "SELECT $$literal$$",
        "SELECT $é$literal$é$",
        String.raw`SELECT 'back\slash'`,
      ]) {
        await expect(admission.pool.query(sql)).rejects.toThrow(/unsupported/)
      }
      const value = String.raw`$é$; COMMIT; back\slash`
      expect(
        (await admission.pool.query<{ value: string }>("SELECT $1::text AS value", [value])).rows[0]
          ?.value,
      ).toBe(value)
    } finally {
      await admission.close()
    }
  },
)
