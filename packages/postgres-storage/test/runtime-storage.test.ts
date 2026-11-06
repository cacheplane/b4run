import { describe, expect, it } from "vitest"
import { bound, ids, realBackend, runtime, sharedContract } from "./fixtures/runtime-backend.ts"

describe.skipIf(process.env.B4_TEST_PGSTORAGE !== "1")("real Postgres runtime conformance", () => {
  const backend = realBackend()
  sharedContract(backend)
  it("serializes real concurrent cold boots and preserves legacy tables", async () => {
    const { openPostgresRuntimeInstallation } = await runtime()
    await backend.first.query("CREATE TABLE public.b4_threads (payload text)")
    await backend.first.query("INSERT INTO public.b4_threads VALUES ('preserved')")
    const naming = { schema: "cold_boot", tablePrefix: "b4_ap_v1" }
    const [a, b] = await Promise.all([
      openPostgresRuntimeInstallation({ pool: backend.first, ...naming }),
      openPostgresRuntimeInstallation({ pool: backend.second, ...naming }),
    ])
    try {
      expect(a.installationId).toBe(b.installationId)
      expect(a.installationId).toMatch(/^[0-9a-f-]{36}$/)
      expect((await backend.first.query("SELECT * FROM public.b4_threads")).rows).toEqual([
        { payload: "preserved" },
      ])
    } finally {
      await a.close()
      await b.close()
    }
  })
  it.each([
    "version",
    "format",
    "installation",
    "schema",
    "prefix",
    "missing_table",
    "missing_constraint",
  ])("rejects incompatible %s without any DDL or runtime write", async (mode) => {
    const { openPostgresRuntimeInstallation } = await runtime()
    const fixture = await bound(backend)
    const { naming } = fixture
    await fixture.close()
    const table = `${naming.schema}.${naming.tablePrefix}`
    if (mode === "missing_table") await backend.first.query(`DROP TABLE ${table}_maintenance`)
    else if (mode === "missing_constraint")
      await backend.first.query(`ALTER TABLE ${table}_runs DROP CONSTRAINT owner_run_id_fkey`)
    else {
      const mutation = (
        {
          version: ["version", "2"],
          format: ["format", "other"],
          installation: ["installation_id", "bad"],
          schema: ["schema_name", "other"],
          prefix: ["table_prefix", "other"],
        } as const
      )[mode as "version" | "format" | "installation" | "schema" | "prefix"]
      const [column, value] = mutation
      await backend.first.query(`UPDATE ${table}_runtime_installation SET ${column}=$1`, [value])
    }
    const before = await backend.first.query(
      "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
      [naming.schema],
    )
    const statements: string[] = []
    const pool = {
      query: backend.second.query.bind(backend.second),
      end: async () => {},
      async connect() {
        const client = await backend.second.connect()
        return {
          async query<R>(sql: string, values?: readonly unknown[]) {
            statements.push(sql)
            const result = await client.query(sql, values as unknown[])
            return { rows: result.rows as R[] }
          },
          release() {
            client.release()
          },
        }
      },
    }
    await expect(openPostgresRuntimeInstallation({ pool, ...naming })).rejects.toThrow(
      /incompatible|marker|namespace/i,
    )
    expect(
      statements.filter((sql) => /^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)/i.test(sql)),
    ).toEqual([])
    expect(
      (
        await backend.first.query(
          "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
          [naming.schema],
        )
      ).rows,
    ).toEqual(before.rows)
  })
  it("rejects explicitly reused unmarked legacy namespace before DDL", async () => {
    const { openPostgresRuntimeInstallation } = await runtime()
    await backend.first.query("CREATE TABLE public.reused_threads (payload text)")
    await backend.first.query("INSERT INTO public.reused_threads VALUES ('old')")
    await expect(
      openPostgresRuntimeInstallation({
        pool: backend.first,
        schema: "public",
        tablePrefix: "reused",
      }),
    ).rejects.toThrow(/namespace|incompatible/i)
    expect((await backend.first.query("SELECT * FROM public.reused_threads")).rows).toEqual([
      { payload: "old" },
    ])
    expect(
      (
        await backend.first.query(
          "SELECT to_regclass('public.reused_runtime_installation') AS object",
        )
      ).rows[0].object,
    ).toBe(null)
  })
  it("rejects malformed and overlength identifiers before ANY SQL", async () => {
    const { openPostgresRuntimeInstallation } = await runtime()
    const statements: string[] = []
    const pool = {
      async query<R>(sql: string) {
        statements.push(sql)
        return { rows: [] as R[] }
      },
      async connect() {
        throw new Error("SQL connection attempted")
      },
      async end() {},
    }
    for (const options of [
      { schema: "Bad" },
      { tablePrefix: "a;drop" },
      { schema: "s".repeat(64) },
      { tablePrefix: "p".repeat(50) },
    ])
      await expect(openPostgresRuntimeInstallation({ pool, ...options })).rejects.toThrow(
        /identifier|length/i,
      )
    expect(statements).toEqual([])
  })
  it("provides concurrent committed snapshots on independent MVCC readers", async () => {
    const fixture = await bound(backend)
    try {
      const [a, b] = await Promise.all([
        fixture.observer.committedReader().snapshot(),
        fixture.observer.committedReader().snapshot(),
      ])
      expect(a).toEqual(b)
      expect(a.scope.threadId).toBe(ids.thread)
    } finally {
      await fixture.close()
    }
  })
  it("awaits rejection and rejects every escaped transaction handle", async () => {
    const fixture = await bound(backend)
    let escaped: import("@b4run/sdk/agent-protocol").RuntimeTransaction | undefined
    try {
      await expect(
        fixture.store.transaction(async (tx) => {
          escaped = tx
          await Promise.resolve()
          throw new Error("async failure")
        }),
      ).rejects.toThrow("async failure")
      await expect(escaped?.snapshot()).rejects.toMatchObject({ code: "closed_transaction" })
      await expect(escaped?.runs.list()).rejects.toMatchObject({ code: "closed_transaction" })
      await expect(
        fixture.store.transaction(() => fixture.store.transaction(async () => undefined)),
      ).rejects.toThrow(/nested/i)
    } finally {
      await fixture.close()
    }
  })
  it("validates one committed format across independent caller search paths", async () => {
    const { openPostgresRuntimeInstallation } = await runtime()
    const naming = backend.naming()
    const first = await backend.first.connect(),
      second = await backend.second.connect()
    const pinned = (client: typeof first) => ({
      query: client.query.bind(client),
      async connect() {
        return { query: client.query.bind(client), release() {} }
      },
      async end() {},
    })
    try {
      await first.query("SET search_path=public")
      const owner = await openPostgresRuntimeInstallation({ ...naming, pool: pinned(first) })
      await second.query(`SET search_path=${naming.schema},public`)
      const other = await openPostgresRuntimeInstallation({ ...naming, pool: pinned(second) })
      expect(other.installationId).toBe(owner.installationId)
      await owner.close()
      await other.close()
    } finally {
      await first.query("RESET search_path")
      await second.query("RESET search_path")
      first.release()
      second.release()
    }
  })
  it("persists safe integer revisions and fences above the int32 boundary", async () => {
    const fixture = await bound(backend)
    try {
      await fixture.store.transaction((tx) =>
        tx.thread.put({
          thread: {
            thread_id: ids.thread,
            created_at: "2026-11-06T00:00:00.000Z",
            updated_at: "2026-11-06T00:00:00.000Z",
            metadata: {},
            status: "idle",
          },
          generation: ids.generation,
          revision: 2 ** 32,
          headCheckpointId: null,
          currentRunId: null,
          pausedGeneration: null,
          protectedMetadata: {},
        }),
      )
      expect((await fixture.observer.snapshot()).revision).toBe(2 ** 32)
      await backend.first.query(
        `UPDATE ${fixture.naming.schema}.${fixture.naming.tablePrefix}_scopes SET fence=$1`,
        [2 ** 32],
      )
      const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
      const current = await bindRuntimeStore(
        fixture.owner,
        createRuntimeBinding(fixture.owner, {
          threadId: ids.thread,
          generation: ids.generation,
          fence: 2 ** 32,
        }),
      )
      await current.withReadLease(async ({ snapshot }) => {
        expect(snapshot.scope.fence).toBe(2 ** 32)
      })
    } finally {
      await fixture.close()
    }
  })
  it("does not overwrite another scope after a concurrent global identity collision", async () => {
    const { openPostgresRuntimeInstallation } = await runtime()
    const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
    const naming = backend.naming()
    const one = await openPostgresRuntimeInstallation({ pool: backend.first, ...naming })
    let release!: () => void, read!: () => void, staged!: () => void
    const allowCommit = new Promise<void>((r) => {
        release = r
      }),
      secondRead = new Promise<void>((r) => {
        read = r
      }),
      firstStaged = new Promise<void>((r) => {
        staged = r
      })
    const pool = {
      query: backend.second.query.bind(backend.second),
      async end() {},
      async connect() {
        const client = await backend.second.connect()
        return {
          async query<R>(sql: string, values?: readonly unknown[]) {
            const result = await client.query(sql, values as unknown[])
            if (sql.includes(`FROM ${naming.schema}.${naming.tablePrefix}_maintenance WHERE id=`)) {
              read()
              release()
            }
            return { rows: result.rows as R[] }
          },
          release() {
            client.release()
          },
        }
      },
    }
    const two = await openPostgresRuntimeInstallation({ pool, ...naming })
    const first = await bindRuntimeStore(
      one,
      createRuntimeBinding(one, { threadId: ids.thread, generation: ids.generation, fence: 1 }),
    )
    const second = await bindRuntimeStore(
      two,
      createRuntimeBinding(two, {
        threadId: "other-thread",
        generation: "other-generation",
        fence: 1,
      }),
    )
    const job = {
      jobId: "global-collision",
      kind: "retention" as const,
      runId: null,
      status: "pending" as const,
      payload: { owner: "first" },
    }
    const a = first.transaction(async (tx) => {
      await tx.maintenance.put(job)
      staged()
      await allowCommit
    })
    let b: Promise<void> | undefined
    try {
      await firstStaged
      b = second.transaction((tx) => tx.maintenance.put({ ...job, payload: { owner: "second" } }))
      await secondRead
      await a
      await expect(b).rejects.toMatchObject({ code: "scope_mismatch" })
      expect((await first.snapshot()).maintenance).toEqual([job])
      expect((await second.snapshot()).maintenance).toEqual([])
    } finally {
      release()
      await Promise.allSettled([a, ...(b ? [b] : [])])
      await one.close()
      await two.close()
    }
  })
  it("refuses closing while a cached fenced client still owns a pool connection", async () => {
    const fixture = await bound(backend)
    const client = await fixture.store.pool.connect()
    try {
      await expect(fixture.owner.close()).rejects.toThrow(/active|queued/)
    } finally {
      client.release()
      await new Promise<void>((r) => setImmediate(r))
      await fixture.close()
    }
  })
  it("excludes one Thread under a read lease while another Thread makes progress without an open transaction", async () => {
    const fixture = await bound(backend)
    const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
    const other = await bindRuntimeStore(
      fixture.owner,
      createRuntimeBinding(fixture.owner, {
        threadId: "free-thread",
        generation: "free-generation",
        fence: 1,
      }),
    )
    try {
      await fixture.store.withReadLease(async (lease) => {
        expect(lease.snapshot.scope.threadId).toBe(ids.thread)
        await expect(fixture.store.transaction((tx) => tx.snapshot())).rejects.toThrow(/nested/i)
        await expect(other.withReadLease(async () => undefined)).rejects.toThrow(/nested.*lease/i)
        await other.transaction((tx) =>
          tx.maintenance.put({
            jobId: "free",
            kind: "retention",
            runId: null,
            status: "pending",
            payload: {},
          }),
        )
        expect((await other.committedReader().snapshot()).maintenance).toHaveLength(1)
        const active = await backend.second.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
        )
        expect(active.rows[0].n).toBe(0)
      })
      expect(
        (
          await backend.second.query(
            `SELECT * FROM ${fixture.naming.schema}.${fixture.naming.tablePrefix}_leases`,
          )
        ).rows,
      ).toEqual([])
    } finally {
      await fixture.close()
    }
  })
  it("persists explicit checkpoint lineage, canonical identities and ordered projection facts together", async () => {
    const fixture = await bound(backend)
    const { run, thread } = await import("./fixtures/runtime-data.ts")
    const checkpointId = "20000000-0000-4000-8000-000000000001"
    const checkpoint: import("@b4run/sdk/agent-protocol").RuntimeCheckpointRecord = {
      state: { checkpoint: { checkpoint_id: checkpointId }, values: { committed: true } },
      namespace: [],
      ownerRunId: run.run.run_id,
      parentCheckpointId: null,
      payload: { adapter: "serialized" },
      masked: false,
      lineage: [
        {
          threadId: ids.thread,
          generation: ids.generation,
          checkpointId,
          runId: run.run.run_id,
          namespace: [],
          protectedMetadata: { lineage: "host" },
        },
      ],
    }
    const event = {
      eventId: "journal-fact",
      namespace: [],
      ownerRunId: run.run.run_id,
      event: {
        type: "event" as const,
        method: "lifecycle" as const,
        params: { namespace: [], timestamp: 0, data: { event: "completed" as const } },
      },
    }
    try {
      await expect(
        fixture.store.transaction((tx) => tx.checkpoints.put(checkpoint)),
      ).rejects.toThrow(/foreign key/i)
      await fixture.store.transaction(async (tx) => {
        await tx.runs.put(run)
        await tx.checkpoints.put(checkpoint)
        await tx.thread.put({ ...thread, headCheckpointId: checkpointId })
        await tx.inbox.put({
          entryId: "inbox",
          kind: "control",
          runId: run.run.run_id,
          namespace: [],
          status: "accepted",
          payload: { stop: true },
          createdAt: run.run.created_at,
        })
        expect((await tx.journal.append(event)).seq).toBe(1)
      })
      await expect(fixture.store.transaction((tx) => tx.journal.append(event))).rejects.toThrow(
        /unique/i,
      )
      await fixture.store.transaction((tx) => tx.runs.delete(run.run.run_id))
      const snapshot = await fixture.observer.snapshot()
      expect(snapshot.runs).toEqual([])
      expect(snapshot.checkpoints).toEqual([checkpoint])
      expect(snapshot.throughSeq).toBe(1)
      const table = `${fixture.naming.schema}.${fixture.naming.tablePrefix}`
      expect(
        (await backend.second.query(`SELECT id,thread_id,generation FROM ${table}_run_identities`))
          .rows,
      ).toEqual([{ id: run.run.run_id, thread_id: ids.thread, generation: ids.generation }])
      expect(
        (
          await backend.second.query(
            `SELECT checkpoint_id,ancestor_checkpoint_id,ancestor_run_id FROM ${table}_checkpoint_lineage`,
          )
        ).rows,
      ).toEqual([
        {
          checkpoint_id: checkpointId,
          ancestor_checkpoint_id: checkpointId,
          ancestor_run_id: run.run.run_id,
        },
      ])
      expect(
        (await backend.second.query(`SELECT through_seq FROM ${table}_projections`)).rows,
      ).toEqual([{ through_seq: "1" }])
    } finally {
      await fixture.close()
    }
  })
  it("has one true SQL CAS winner for concurrent distinct continuation grant consumes", async () => {
    const fixture = await bound(backend)
    const { run, thread } = await import("./fixtures/runtime-data.ts")
    const grant = {
      grantId: "cas-grant",
      tokenHash: "hash",
      proposalHash: "proposal",
      inputId: "cas-input",
      ownerRunId: run.run.run_id,
      pausedGeneration: "pause",
      namespace: [],
      expiresAt: null,
      consumedByRunId: null,
    }
    const next = [
      "20000000-0000-4000-8000-000000000011",
      "20000000-0000-4000-8000-000000000012",
    ] as const
    try {
      await fixture.store.transaction(async (tx) => {
        await tx.runs.put(run)
        for (const id of next) await tx.runs.put({ ...run, run: { ...run.run, run_id: id } })
        await tx.thread.put({ ...thread, pausedGeneration: "pause" })
        await tx.pending.put({
          input: {
            namespace: [],
            runId: run.run.run_id,
            turnId: run.run.run_id,
            data: {
              interruptId: grant.inputId,
              payload: {},
              b4: { v: 1, pausedGeneration: "pause", proposalHash: "proposal", status: "waiting" },
            },
          },
          ownerRunId: run.run.run_id,
          namespace: [],
          disposition: "pending",
          decision: null,
        })
        await tx.grants.put(grant)
      })
      const result = await fixture.store.transaction((tx) =>
        Promise.all(next.map((id) => tx.grants.consume(grant.grantId, id))),
      )
      expect(result.filter(Boolean)).toHaveLength(1)
      const winner = next[result[0] ? 0 : 1]
      expect((await fixture.observer.snapshot()).grants).toEqual([
        { ...grant, consumedByRunId: winner },
      ])
      const rows = await backend.second.query(
        `SELECT consumed_by_run_id,payload FROM ${fixture.naming.schema}.${fixture.naming.tablePrefix}_grants`,
      )
      expect(rows.rows[0].consumed_by_run_id).toBe(winner)
      expect(JSON.parse(rows.rows[0].payload)).toEqual({ ...grant, consumedByRunId: winner })
    } finally {
      await fixture.close()
    }
  })
  it.each(["snapshot", "lease"])(
    "releases queued work bookkeeping when %s connection acquisition fails",
    async (operation) => {
      const { openPostgresRuntimeInstallation } = await runtime()
      const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
      let reject = false
      const pool = backend.pool({ max: 3 })
      const connect = pool.connect.bind(pool)
      Object.defineProperty(pool, "connect", {
        value: async () => {
          if (reject) throw new Error("injected connection acquisition failure")
          return connect()
        },
      })
      const owner = await openPostgresRuntimeInstallation({ pool, ...backend.naming() })
      const store = await bindRuntimeStore(
        owner,
        createRuntimeBinding(owner, { threadId: ids.thread, generation: ids.generation, fence: 1 }),
      )
      reject = true
      await expect(
        operation === "snapshot"
          ? store.committedReader().snapshot()
          : store.withReadLease(async () => undefined),
      ).rejects.toThrow("injected connection acquisition failure")
      await expect(owner.close()).resolves.toBeUndefined()
      await pool.end()
    },
  )

  it("shares schema creation exclusion with existing legacy store installers", async () => {
    const { openPostgresRuntimeInstallation } = await runtime()
    const { createPostgresThreadsStore } = await import("../src/threads.ts")
    const naming = { schema: "mixed_cold_boot", tablePrefix: "b4_ap_v1" }
    let created!: () => void, release!: () => void
    const schemaCreated = new Promise<void>((r) => {
        created = r
      }),
      allowCommit = new Promise<void>((r) => {
        release = r
      })
    let legacyPid = 0
    const runtimePool = {
      query: backend.first.query.bind(backend.first),
      async end() {},
      async connect() {
        const client = await backend.first.connect()
        return {
          async query<R>(sql: string, values?: readonly unknown[]) {
            const result = await client.query(sql, values as unknown[])
            if (sql.startsWith("CREATE SCHEMA")) {
              created()
              await allowCommit
            }
            return { rows: result.rows as R[] }
          },
          release() {
            client.release()
          },
        }
      },
    }
    const legacyPool = {
      query: backend.second.query.bind(backend.second),
      async end() {},
      async connect() {
        const client = await backend.second.connect()
        legacyPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid
        return {
          query: client.query.bind(client),
          release() {
            client.release()
          },
        }
      },
    }
    const opening = openPostgresRuntimeInstallation({ pool: runtimePool, ...naming })
    let legacy: ReturnType<typeof createPostgresThreadsStore> | undefined,
      ready: Promise<void> | undefined
    try {
      await schemaCreated
      legacy = createPostgresThreadsStore({ pool: legacyPool, schema: naming.schema })
      ready = legacy.ready()
      // Consume any rejection immediately while the independent monitor proves
      // which backend is blocked; the original promise is still asserted below.
      void ready.catch(() => {})
      let blocked = false
      for (let attempt = 0; attempt < 50 && !blocked; attempt++) {
        blocked =
          (
            await backend.first.query<{ blocked: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock') AS blocked",
              [legacyPid],
            )
          ).rows[0]?.blocked ?? false
        if (!blocked) await new Promise((r) => setTimeout(r, 10))
      }
      expect(blocked).toBe(true)
      release()
      const owner = await opening
      await expect(ready).resolves.toBeUndefined()
      await legacy.createThread({ thread_id: "legacy-preserved" })
      expect((await legacy.getThread("legacy-preserved"))?.thread_id).toBe("legacy-preserved")
      await owner.close()
    } finally {
      release()
      await Promise.allSettled([opening, ...(ready ? [ready] : [])])
      await legacy?.close()
    }
  })
  it("rejects max-one read-lease capacity before an unsafe other-Thread callback and releases all work", async () => {
    const { openPostgresRuntimeInstallation } = await runtime()
    const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
    // The driver timeout bounds cleanup of the deliberately broken RED path;
    // the required product boundary must reject before attempting acquisition.
    const pool = backend.pool({
      max: 1,
      connectionTimeoutMillis: 200,
      application_name: "r3_max_one",
    })
    const owner = await openPostgresRuntimeInstallation({ pool, ...backend.naming() })
    const first = await bindRuntimeStore(
      owner,
      createRuntimeBinding(owner, { threadId: ids.thread, generation: ids.generation, fence: 1 }),
    )
    const other = await bindRuntimeStore(
      owner,
      createRuntimeBinding(owner, {
        threadId: "max-one-other",
        generation: "max-one-other-generation",
        fence: 1,
      }),
    )
    let entered = false
    try {
      await expect(
        first.withReadLease(async () => {
          entered = true
          return other.transaction((tx) => tx.snapshot())
        }),
      ).rejects.toMatchObject({ code: "pool_capacity" })
      expect(entered).toBe(false)
    } finally {
      // Subsequent one-connection work proves the failed acquisition returned
      // its client and transaction; close must observe no pending/held work.
      await other.transaction((tx) => tx.snapshot())
      await owner.close()
      await pool.end()
      expect(pool.totalCount).toBe(0)
      expect(pool.waitingCount).toBe(0)
      expect(
        (
          await backend.second.query(
            "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND pid IN (SELECT pid FROM pg_stat_activity WHERE application_name=$1)",
            ["r3_max_one"],
          )
        ).rows[0].n,
      ).toBe(0)
    }
  })
  it("fails saturated max-two callback work promptly and cleans the lease on its owning session", async () => {
    const { openPostgresRuntimeInstallation } = await runtime()
    const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
    const pool = backend.pool({
      max: 2,
      connectionTimeoutMillis: 200,
      application_name: "r3_max_two_saturated",
    })
    const naming = backend.naming()
    const owner = await openPostgresRuntimeInstallation({ pool, ...naming })
    const first = await bindRuntimeStore(
      owner,
      createRuntimeBinding(owner, { threadId: ids.thread, generation: ids.generation, fence: 1 }),
    )
    const other = await bindRuntimeStore(
      owner,
      createRuntimeBinding(owner, {
        threadId: "capacity-other",
        generation: "capacity-other-generation",
        fence: 1,
      }),
    )
    let blocker: import("pg").PoolClient | undefined
    try {
      await first.withReadLease(async () => {
        blocker = await pool.connect()
        await expect(other.transaction((tx) => tx.snapshot())).rejects.toMatchObject({
          code: "pool_capacity",
        })
        await expect(other.committedReader().snapshot()).rejects.toMatchObject({
          code: "pool_capacity",
        })
        await expect(other.pool.query("SELECT 1")).rejects.toMatchObject({ code: "pool_capacity" })
        await expect(other.advanceFence()).rejects.toMatchObject({ code: "pool_capacity" })
        expect(pool.waitingCount).toBe(0)
        expect(
          (
            await backend.second.query(
              `SELECT fence FROM ${naming.schema}.${naming.tablePrefix}_scopes WHERE thread_id=$1`,
              ["capacity-other"],
            )
          ).rows[0].fence,
        ).toBe("1")
        // Keep the second connection checked out until the lease itself settles.
        // Cleanup must use its own held session rather than queue behind us.
      })
    } finally {
      blocker?.release()
      await other.transaction((tx) => tx.snapshot())
      const successor = await other.advanceFence()
      expect((await successor.snapshot()).scope.fence).toBe(2)
      await owner.close()
      await pool.end()
      expect(pool.totalCount).toBe(0)
      expect(pool.waitingCount).toBe(0)
      expect(
        (await backend.second.query(`SELECT * FROM ${naming.schema}.${naming.tablePrefix}_leases`))
          .rows,
      ).toEqual([])
      expect(
        (
          await backend.second.query(
            "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND pid IN (SELECT pid FROM pg_stat_activity WHERE application_name=$1)",
            ["r3_max_two_saturated"],
          )
        ).rows[0].n,
      ).toBe(0)
    }
  })
  it.each([false, true])(
    "reserves max-two simultaneous leases without overcommitting an idle=%s pool",
    async (warm) => {
      const { openPostgresRuntimeInstallation } = await runtime()
      const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
      const pool = backend.pool({
        max: 2,
        connectionTimeoutMillis: 200,
        application_name: "r3_max_two_race",
      })
      const naming = backend.naming()
      const owner = await openPostgresRuntimeInstallation({ pool, ...naming })
      const peer = await openPostgresRuntimeInstallation({ pool, ...naming })
      const first = await bindRuntimeStore(
        owner,
        createRuntimeBinding(owner, { threadId: ids.thread, generation: ids.generation, fence: 1 }),
      )
      const second = await bindRuntimeStore(
        peer,
        createRuntimeBinding(peer, {
          threadId: "race-second",
          generation: "race-second-generation",
          fence: 1,
        }),
      )
      const free = await bindRuntimeStore(
        owner,
        createRuntimeBinding(owner, {
          threadId: "race-free",
          generation: "race-free-generation",
          fence: 1,
        }),
      )
      let entered = 0
      const callback = async () => {
        entered++
        await free.transaction((tx) => tx.snapshot())
      }
      try {
        if (warm) {
          const clients = await Promise.allSettled([pool.connect(), pool.connect()])
          for (const client of clients) if (client.status === "fulfilled") client.value.release()
          const failed = clients.find((client) => client.status === "rejected")
          if (failed?.status === "rejected") throw failed.reason
          expect(pool.idleCount).toBe(2)
        }

        const outcomes = await Promise.allSettled([
          first.withReadLease(callback),
          second.withReadLease(callback),
        ])
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
        const rejected = outcomes.find((outcome) => outcome.status === "rejected")
        expect(rejected).toMatchObject({ status: "rejected", reason: { code: "pool_capacity" } })
        expect(entered).toBe(1)
        await free.transaction((tx) => tx.snapshot())
      } finally {
        await owner.close()
        await peer.close()
        await pool.end()
        expect(pool.totalCount).toBe(0)
        expect(pool.waitingCount).toBe(0)
        expect(
          (
            await backend.second.query(
              `SELECT * FROM ${naming.schema}.${naming.tablePrefix}_leases`,
            )
          ).rows,
        ).toEqual([])
        expect(
          (
            await backend.second.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND pid IN (SELECT pid FROM pg_stat_activity WHERE application_name=$1)",
              ["r3_max_two_race"],
            )
          ).rows[0].n,
        ).toBe(0)
      }
    },
  )
  it("refuses unverified structural-pool leases before acquisition while preserving ordinary work", async () => {
    const { openPostgresRuntimeInstallation } = await runtime()
    const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
    let connects = 0,
      entered = false
    const pool = {
      query: backend.first.query.bind(backend.first),
      async end() {},
      async connect() {
        connects++
        return backend.first.connect()
      },
    }
    const owner = await openPostgresRuntimeInstallation({ pool, ...backend.naming() })
    const store = await bindRuntimeStore(
      owner,
      createRuntimeBinding(owner, { threadId: ids.thread, generation: ids.generation, fence: 1 }),
    )
    const before = connects
    try {
      await expect(
        store.withReadLease(async () => {
          entered = true
        }),
      ).rejects.toMatchObject({ code: "pool_capacity" })
      expect(entered).toBe(false)
      expect(connects).toBe(before)
      await store.transaction((tx) => tx.snapshot())
      expect((await store.committedReader().snapshot()).scope.threadId).toBe(ids.thread)
    } finally {
      await owner.close()
    }
  })
  it("rejects nested max-one fence advancement before checkout and preserves both fences", async () => {
    const { openPostgresRuntimeInstallation } = await runtime()
    const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
    const pool = backend.pool({ max: 1, connectionTimeoutMillis: 200 })
    const naming = backend.naming()
    const owner = await openPostgresRuntimeInstallation({ pool, ...naming })
    const first = await bindRuntimeStore(
      owner,
      createRuntimeBinding(owner, { threadId: ids.thread, generation: ids.generation, fence: 1 }),
    )
    const other = await bindRuntimeStore(
      owner,
      createRuntimeBinding(owner, {
        threadId: "nested-fence",
        generation: "nested-fence-generation",
        fence: 1,
      }),
    )
    try {
      await first.transaction(async () => {
        await expect(first.advanceFence()).rejects.toThrow(/nested/i)
        await expect(other.advanceFence()).rejects.toThrow(/nested/i)
        expect(pool.waitingCount).toBe(0)
      })
      expect(
        (
          await backend.second.query(
            `SELECT fence FROM ${naming.schema}.${naming.tablePrefix}_scopes ORDER BY thread_id`,
          )
        ).rows,
      ).toEqual([{ fence: "1" }, { fence: "1" }])
      const successor = await other.advanceFence()
      expect((await successor.snapshot()).scope.fence).toBe(2)
    } finally {
      await owner.close()
      await pool.end()
      expect(pool.totalCount).toBe(0)
      expect(pool.waitingCount).toBe(0)
    }
  })
  it("permits free other-scope fence advancement from a max-two lease callback", async () => {
    const { openPostgresRuntimeInstallation } = await runtime()
    const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
    const pool = backend.pool({ max: 2, connectionTimeoutMillis: 200 })
    const naming = backend.naming()
    const owner = await openPostgresRuntimeInstallation({ pool, ...naming })
    const first = await bindRuntimeStore(
      owner,
      createRuntimeBinding(owner, { threadId: ids.thread, generation: ids.generation, fence: 1 }),
    )
    const other = await bindRuntimeStore(
      owner,
      createRuntimeBinding(owner, {
        threadId: "free-fence",
        generation: "free-fence-generation",
        fence: 1,
      }),
    )
    try {
      await first.withReadLease(async () => {
        await expect(first.advanceFence()).rejects.toThrow(/nested/i)
        const successor = await other.advanceFence()
        expect((await successor.snapshot()).scope.fence).toBe(2)
      })
      expect(
        (await backend.second.query(`SELECT * FROM ${naming.schema}.${naming.tablePrefix}_leases`))
          .rows,
      ).toEqual([])
    } finally {
      await owner.close()
      await pool.end()
      expect(pool.totalCount).toBe(0)
      expect(pool.waitingCount).toBe(0)
    }
  })
  it("rejects callback-time raw-pool capacity waits before checkout", async () => {
    const { openPostgresRuntimeInstallation } = await runtime()
    const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
    const pool = backend.pool({ max: 1, connectionTimeoutMillis: 200 })
    const owner = await openPostgresRuntimeInstallation({ pool, ...backend.naming() })
    const first = await bindRuntimeStore(
      owner,
      createRuntimeBinding(owner, { threadId: ids.thread, generation: ids.generation, fence: 1 }),
    )
    const other = await bindRuntimeStore(
      owner,
      createRuntimeBinding(owner, {
        threadId: "raw-pool-other",
        generation: "raw-pool-generation",
        fence: 1,
      }),
    )
    try {
      await first.transaction(async () => {
        await expect(other.pool.query("SELECT 1")).rejects.toMatchObject({ code: "pool_capacity" })
        expect(pool.waitingCount).toBe(0)
      })
      expect((await other.pool.query<{ n: number }>("SELECT 1 AS n")).rows[0]?.n).toBe(1)
    } finally {
      await owner.close()
      await pool.end()
      expect(pool.totalCount).toBe(0)
      expect(pool.waitingCount).toBe(0)
    }
  })
  it("rejects internal binding from an active max-one transaction before creating another scope", async () => {
    const { openPostgresRuntimeInstallation } = await runtime()
    const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
    const pool = backend.pool({ max: 1, connectionTimeoutMillis: 200 })
    const naming = backend.naming()
    const owner = await openPostgresRuntimeInstallation({ pool, ...naming })
    const first = await bindRuntimeStore(
      owner,
      createRuntimeBinding(owner, { threadId: ids.thread, generation: ids.generation, fence: 1 }),
    )
    const capability = createRuntimeBinding(owner, {
      threadId: "nested-binding",
      generation: "nested-binding-generation",
      fence: 1,
    })
    try {
      await first.transaction(async () => {
        await expect(bindRuntimeStore(owner, capability)).rejects.toThrow(/nested/i)
        expect(pool.waitingCount).toBe(0)
      })
      expect(
        (
          await backend.second.query(
            `SELECT count(*)::int AS n FROM ${naming.schema}.${naming.tablePrefix}_scopes`,
          )
        ).rows[0].n,
      ).toBe(1)
      const free = await bindRuntimeStore(owner, capability)
      expect((await free.snapshot()).scope.threadId).toBe("nested-binding")
    } finally {
      await owner.close()
      await pool.end()
      expect(pool.totalCount).toBe(0)
      expect(pool.waitingCount).toBe(0)
    }
  })
})
