import { describe, expect, it } from "vitest"
import { assertPendingGrantIdentities } from "../../../test/agent-protocol/runtime-pending-identities.ts"
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
    "version-zero",
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
          version: ["version", "999"],
          "version-zero": ["version", "0"],
          format: ["format", "other"],
          installation: ["installation_id", "bad"],
          schema: ["schema_name", "other"],
          prefix: ["table_prefix", "other"],
        } as const
      )[mode as "version" | "version-zero" | "format" | "installation" | "schema" | "prefix"]
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
      const first = await fixture.store.transaction(async (tx) => {
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
        const record = await tx.journal.append(event)
        expect(record.seq).toBe(1)
        return record
      })
      const journalTable = `${fixture.naming.schema}.${fixture.naming.tablePrefix}_journal`
      const firstBytes = (
        await backend.second.query(
          `SELECT id,seq::text AS seq,encode(convert_to(payload,'UTF8'),'hex') AS bytes FROM ${journalTable} WHERE seq=1`,
        )
      ).rows
      expect(firstBytes).toHaveLength(1)
      // Same unsequenced body produces a new canonical fact; actual collision rollback is
      // retained separately in the new legacy-future-ID UNIQUE case, not silently waived.
      const second = await fixture.store.transaction((tx) => tx.journal.append(event))
      expect(first.eventId).toBe(`b4e1.${ids.generation}.1`)
      expect(second.eventId).toBe(`b4e1.${ids.generation}.2`)
      expect(second.seq).toBe(2)
      expect(await fixture.store.transaction((tx) => tx.journal.read(0))).toEqual([first, second])
      expect(
        (
          await backend.second.query(
            `SELECT id,seq::text AS seq,encode(convert_to(payload,'UTF8'),'hex') AS bytes FROM ${journalTable} WHERE seq=1`,
          )
        ).rows,
      ).toEqual(firstBytes)
      await fixture.store.transaction((tx) => tx.runs.delete(run.run.run_id))
      const snapshot = await fixture.observer.snapshot()
      expect(snapshot.runs).toEqual([])
      expect(snapshot.checkpoints).toEqual([checkpoint])
      expect(snapshot.throughSeq).toBe(2)
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
      ).toEqual([{ through_seq: "2" }])
    } finally {
      await fixture.close()
    }
  })
  it("rejects a pending identity whose canonical owner belongs to another scope", async () => {
    const fixture = await bound(backend)
    const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
    const { run } = await import("./fixtures/runtime-data.ts")
    try {
      await fixture.store.transaction((tx) => tx.runs.put(run))
      const other = await bindRuntimeStore(
        fixture.owner,
        createRuntimeBinding(fixture.owner, {
          threadId: crypto.randomUUID(),
          generation: crypto.randomUUID(),
          fence: 1,
        }),
      )
      await expect(
        other.transaction((tx) =>
          tx.pending.get({
            ownerRunId: run.run.run_id,
            pausedGeneration: "pause",
            namespace: [],
            inputId: "public-input",
            proposalHash: "proposal",
          }),
        ),
      ).rejects.toMatchObject({ code: "scope_mismatch" })
    } finally {
      await fixture.close()
    }
  })
  it("keeps exact compound pending identities and immutable historical grants", async () => {
    const fixture = await bound(backend)
    const { run, thread } = await import("./fixtures/runtime-data.ts")
    try {
      await assertPendingGrantIdentities(fixture.store, run, thread)
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

  // Native journal guards use the existing suite-owned backend and per-case namespace.
  type PgJournalInput = Pick<
    import("@b4run/sdk/agent-protocol").RuntimeJournalRecord,
    "namespace" | "ownerRunId" | "event"
  >
  type PgJournalData = typeof import("./fixtures/runtime-data.ts")
  type PgJournalFixture = Awaited<ReturnType<typeof bound>> & { data: PgJournalData; table: string }
  const pgJournalLegacyIds = [
    "90000000-0000-4000-8000-000000000001",
    "90000000-0000-4000-8000-000000000002",
    "90000000-0000-4000-8000-000000000003",
    "90000000-0000-4000-8000-000000000004",
  ] as const
  function pgJournalInput(
    data: PgJournalData,
    namespace: readonly string[] = [],
    ownerRunId: string | null = data.run.run.run_id,
  ): PgJournalInput {
    return {
      namespace,
      ownerRunId,
      event: {
        type: "event",
        method: "lifecycle",
        params: {
          namespace: [...namespace],
          timestamp: Date.parse(data.run.run.created_at),
          data: { event: "completed", cause: { type: "toolCall", toolCallId: "retained-cause" } },
        },
      },
    }
  }
  function pgJournalBaselinePositive(input: PgJournalInput, _baselineId: string): never {
    // The legacy ID parameter keeps the test-first API removal mechanical; it supplies no authority.
    return input as never
  }
  async function pgJournalFacts(f: PgJournalFixture) {
    const args = [ids.thread, ids.generation]
    return {
      scope: (
        await backend.second.query(
          `SELECT thread_id,generation,fence::text AS fence,lease_expires_at::text AS lease_expires_at,execution_owner,deleted,through_seq::text AS h FROM ${f.table}_scopes WHERE thread_id=$1 AND generation=$2`,
          args,
        )
      ).rows,
      journal: (
        await backend.second.query(
          `SELECT thread_id,generation,id,seq::text AS seq,owner_run_id,namespace,payload FROM ${f.table}_journal WHERE thread_id=$1 AND generation=$2 ORDER BY seq`,
          args,
        )
      ).rows,
      projections: (
        await backend.second.query(
          `SELECT thread_id,generation,through_seq::text AS through_seq,revision::text AS revision,payload FROM ${f.table}_projections WHERE thread_id=$1 AND generation=$2`,
          args,
        )
      ).rows,
      threads: (
        await backend.second.query(
          `SELECT thread_id,generation,revision::text AS revision,head_checkpoint_id,current_run_id,paused_generation,payload FROM ${f.table}_threads WHERE thread_id=$1 AND generation=$2`,
          args,
        )
      ).rows,
      runs: (
        await backend.second.query(
          `SELECT * FROM ${f.table}_runs WHERE thread_id=$1 AND generation=$2 ORDER BY id`,
          args,
        )
      ).rows,
      identities: (
        await backend.second.query(
          `SELECT * FROM ${f.table}_run_identities WHERE thread_id=$1 AND generation=$2 ORDER BY id`,
          args,
        )
      ).rows,
    }
  }
  async function withPgJournalFixture(body: (f: PgJournalFixture) => Promise<void>) {
    const fixture = await bound(backend)
    try {
      const data = await import("./fixtures/runtime-data.ts")
      const f = {
        ...fixture,
        data,
        table: `${fixture.naming.schema}.${fixture.naming.tablePrefix}`,
      }
      await fixture.store.transaction(async (tx) => {
        await tx.runs.put(data.run)
        await tx.thread.put(data.thread)
        expect(await tx.runs.get(data.run.run.run_id)).toEqual(data.run)
      })
      const before = await pgJournalFacts(f)
      expect(before.scope[0]?.h).toBe("0")
      expect(before.journal).toEqual([])
      expect(before.projections).toEqual([])
      const rollback = new Error("PG journal valid append setup rollback")
      let reached = false
      await expect(
        fixture.store.transaction(async (tx) => {
          const record = await tx.journal.append(
            pgJournalBaselinePositive(pgJournalInput(data), pgJournalLegacyIds[3]),
          )
          expect(record.seq).toBe(1)
          expect(await tx.journal.read(0)).toEqual([record])
          reached = true
          throw rollback
        }),
      ).rejects.toBe(rollback)
      expect(reached, "SETUP: actual valid append/read/callback rollback must run").toBe(true)
      expect(await pgJournalFacts(f)).toEqual(before)
      await body(f)
    } finally {
      await fixture.close()
    }
  }

  it("refuses wider caller journal stamps before native watermark or projection writes", async () => {
    await withPgJournalFixture(async (f) => {
      const before = await pgJournalFacts(f)
      for (const level of ["outer", "embedded"] as const) {
        for (const [key, value] of [
          ["eventId", pgJournalLegacyIds[0]],
          ["seq", 99],
          ["b4", { v: 1, delivery: "snapshot" }],
          ["eventId", undefined],
          ["seq", undefined],
          ["b4", undefined],
        ] as const) {
          const input = pgJournalInput(f.data)
          const base = pgJournalBaselinePositive(input, pgJournalLegacyIds[1]) as unknown as Record<
            string,
            unknown
          >
          const wider =
            level === "outer"
              ? { ...base, [key]: value }
              : { ...base, event: { ...input.event, [key]: value } }
          const outcome = await f.store
            .transaction((tx) => tx.journal.append(wider as never))
            .then(
              () => "resolved" as const,
              () => "rejected" as const,
            )
          expect({ outcome, after: await pgJournalFacts(f) }, `${level} ${key} supplied`).toEqual({
            outcome: "rejected",
            after: before,
          })
        }
      }
      const next = await f.store.transaction((tx) =>
        tx.journal.append(pgJournalBaselinePositive(pgJournalInput(f.data), pgJournalLegacyIds[2])),
      )
      expect(next.seq).toBe(1)
    })
  })

  it("refuses a missing current Run even when its canonical identity remains retained", async () => {
    await withPgJournalFixture(async (f) => {
      const runId = f.data.run.run.run_id
      await f.store.transaction((tx) => tx.runs.delete(runId))
      expect(
        (await backend.second.query(`SELECT id FROM ${f.table}_runs WHERE id=$1`, [runId])).rows,
      ).toEqual([])
      expect(
        (
          await backend.second.query(
            `SELECT id,thread_id,generation FROM ${f.table}_run_identities WHERE id=$1`,
            [runId],
          )
        ).rows,
      ).toEqual([{ id: runId, thread_id: ids.thread, generation: ids.generation }])
      const before = await pgJournalFacts(f)
      const outcome = await f.store
        .transaction((tx) =>
          tx.journal.append(
            pgJournalBaselinePositive(pgJournalInput(f.data), pgJournalLegacyIds[0]),
          ),
        )
        .then(
          () => "resolved" as const,
          () => "rejected" as const,
        )
      expect({ outcome, after: await pgJournalFacts(f) }).toEqual({
        outcome: "rejected",
        after: before,
      })
    })
  })

  it("refuses a native NULL turn identity that contradicts the stored Run metadata", async () => {
    await withPgJournalFixture(async (f) => {
      const runId = f.data.run.run.run_id
      const changed = await backend.second.query(
        `UPDATE ${f.table}_runs SET turn_id=NULL WHERE id=$1 AND thread_id=$2 AND generation=$3 RETURNING id`,
        [runId, ids.thread, ids.generation],
      )
      expect(changed.rows).toEqual([{ id: runId }])
      const row = (
        await backend.second.query(`SELECT turn_id,payload FROM ${f.table}_runs WHERE id=$1`, [
          runId,
        ])
      ).rows[0]
      expect(row?.turn_id).toBeNull()
      expect(JSON.parse(row.payload).metadata.turnId).toBe(f.data.run.metadata.turnId)
      const before = await pgJournalFacts(f)
      const outcome = await f.store
        .transaction((tx) =>
          tx.journal.append(
            pgJournalBaselinePositive(pgJournalInput(f.data), pgJournalLegacyIds[0]),
          ),
        )
        .then(
          () => "resolved" as const,
          () => "rejected" as const,
        )
      expect({ outcome, after: await pgJournalFacts(f) }).toEqual({
        outcome: "rejected",
        after: before,
      })
    })
  })

  it("uses stored continuation turn authority and rolls back appended facts with the callback", async () => {
    await withPgJournalFixture(async (f) => {
      const turnId = f.data.run.metadata.turnId
      const continuation = {
        ...f.data.run,
        run: { ...f.data.run.run, run_id: ids.continuation },
        metadata: { ...f.data.run.metadata, previousRunId: f.data.run.run.run_id, turnId },
      }
      await f.store.transaction(async (tx) => {
        await tx.runs.put(continuation)
        await tx.thread.put({ ...f.data.thread, currentRunId: ids.continuation, revision: 2 })
      })
      const native = (
        await backend.second.query(`SELECT id,turn_id,payload FROM ${f.table}_runs WHERE id=$1`, [
          ids.continuation,
        ])
      ).rows[0]
      expect(native.turn_id).toBe(turnId)
      expect(native.id).not.toBe(turnId)
      expect(JSON.parse(native.payload)).toEqual(continuation)
      const input = pgJournalInput(f.data, ["child/slash", "leaf"], ids.continuation)
      const before = await pgJournalFacts(f)
      const rollback = new Error("PG ordinary callback after successful append")
      await expect(
        f.store.transaction(async (tx) => {
          const staged = await tx.journal.append(
            pgJournalBaselinePositive(input, pgJournalLegacyIds[0]),
          )
          expect(staged.seq).toBe(1)
          expect(await tx.journal.read(0)).toEqual([staged])
          throw rollback
        }),
      ).rejects.toBe(rollback)
      expect(await pgJournalFacts(f)).toEqual(before)
      const committed = await f.store.transaction((tx) =>
        tx.journal.append(pgJournalBaselinePositive(input, pgJournalLegacyIds[1])),
      )
      expect(committed.seq).toBe(1)
      expect(await f.store.transaction((tx) => tx.journal.read(0))).toEqual([committed])
      const id = `b4e1.${ids.generation}.1`
      expect(committed).toMatchObject({
        eventId: id,
        seq: 1,
        namespace: input.namespace,
        ownerRunId: ids.continuation,
        event: {
          eventId: id,
          seq: 1,
          b4: { v: 1, generation: ids.generation, runId: ids.continuation, turnId },
        },
      })
      expect(committed.event.params.data).toEqual(input.event.params.data)
      expect(
        (
          await backend.second.query(
            `SELECT id,seq::text AS seq,namespace,payload FROM ${f.table}_journal`,
          )
        ).rows,
      ).toEqual([
        {
          id,
          seq: "1",
          namespace: JSON.stringify(input.namespace),
          payload: JSON.stringify(committed),
        },
      ])
    })
  })

  it("rolls back caught native projection INSERT and UPSERT aborts after journal and watermark writes", async () => {
    await withPgJournalFixture(async (f) => {
      const fn = `${f.table}_journal_guard_abort`
      for (const seq of [1, 2]) {
        if (seq === 2) {
          const preceding = await f.store.transaction((tx) =>
            tx.journal.append(
              pgJournalBaselinePositive(pgJournalInput(f.data), pgJournalLegacyIds[1]),
            ),
          )
          expect(preceding.seq).toBe(1)
          expect(
            (
              await backend.second.query(
                `SELECT through_seq::text AS h FROM ${f.table}_projections`,
              )
            ).rows,
          ).toEqual([{ h: "1" }])
        }
        const before = await pgJournalFacts(f)
        // Raw PRIVATE fixture DDL outside any fenced callback: no dollar-quote/control bypass.
        await backend.second.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.thread_id='${ids.thread}' AND NEW.generation='${ids.generation}' AND NEW.through_seq=${seq}
            AND EXISTS(SELECT 1 FROM ${f.table}_journal WHERE thread_id=NEW.thread_id AND generation=NEW.generation AND seq=${seq})
            AND (SELECT through_seq FROM ${f.table}_scopes WHERE thread_id=NEW.thread_id AND generation=NEW.generation)=${seq}
          THEN RAISE EXCEPTION 'fixture projection failure after real journal and H' USING ERRCODE='P0001'; END IF;
          RETURN NEW; END $$`)
        try {
          await backend.second.query(
            `CREATE TRIGGER journal_guard_abort BEFORE ${seq === 1 ? "INSERT" : "UPDATE"} ON ${f.table}_projections FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
          )
          try {
            let caught = false
            let nativeMessage = ""
            let nativeCode: unknown
            const outcome = await f.store
              .transaction(async (tx) => {
                await tx.thread.put({
                  ...f.data.thread,
                  revision: seq + 1,
                  thread: { ...f.data.thread.thread, metadata: { attemptedWrite: seq } },
                })
                try {
                  await tx.journal.append(
                    pgJournalBaselinePositive(pgJournalInput(f.data), pgJournalLegacyIds[2]),
                  )
                } catch (error) {
                  caught = true
                  nativeMessage = error instanceof Error ? error.message : String(error)
                  nativeCode = (error as { code?: unknown })?.code
                }
                return "caught" as const
              })
              .then(
                () => "resolved" as const,
                () => "rejected" as const,
              )
            expect(
              { caught, nativeCode },
              "SETUP: real conditional native trigger must run",
            ).toEqual({ caught: true, nativeCode: "P0001" })
            expect(nativeMessage).toContain("fixture projection failure after real journal and H")
            expect({ outcome, after: await pgJournalFacts(f) }).toEqual({
              outcome: "rejected",
              after: before,
            })
          } finally {
            await backend.second.query(`DROP TRIGGER journal_guard_abort ON ${f.table}_projections`)
          }
        } finally {
          await backend.second.query(`DROP FUNCTION ${fn}()`)
        }
      }
    })
  })

  it("allows an ordinary thread write after a caught prewrite invalid journal stamp without advancing H", async () => {
    await withPgJournalFixture(async (f) => {
      const before = await pgJournalFacts(f)
      const changed = {
        ...f.data.thread,
        revision: 2,
        thread: { ...f.data.thread.thread, metadata: { ordinaryWrite: "retained" } },
      }
      const base = pgJournalBaselinePositive(
        pgJournalInput(f.data),
        pgJournalLegacyIds[0],
      ) as unknown as Record<string, unknown>
      let caught = false
      const value = await f.store.transaction(async (tx) => {
        await tx.thread.put(changed)
        try {
          await tx.journal.append({ ...base, b4: { v: 1, delivery: "snapshot" } } as never)
        } catch {
          caught = true
        }
        return "ordinary-write-committed" as const
      })
      const after = await pgJournalFacts(f)
      expect({
        caught,
        value,
        scope: after.scope,
        journal: after.journal,
        projections: after.projections,
        runs: after.runs,
        identities: after.identities,
      }).toEqual({
        caught: true,
        value: "ordinary-write-committed",
        scope: before.scope,
        journal: before.journal,
        projections: before.projections,
        runs: before.runs,
        identities: before.identities,
      })
      expect(await f.store.transaction((tx) => tx.thread.get())).toEqual(changed)
      expect(after.threads).toEqual([
        { ...before.threads[0], revision: "2", payload: JSON.stringify(changed) },
      ])
    })
  })

  it("commits the maximum safe journal coordinate and refuses the next fact", async () => {
    await withPgJournalFixture(async (f) => {
      await backend.second.query(
        `UPDATE ${f.table}_scopes SET through_seq=9007199254740990 WHERE thread_id=$1 AND generation=$2`,
        [ids.thread, ids.generation],
      )
      expect(
        (
          await backend.second.query(
            `SELECT through_seq::text AS h,pg_typeof(through_seq)::text AS type FROM ${f.table}_scopes`,
          )
        ).rows,
      ).toEqual([{ h: "9007199254740990", type: "bigint" }])
      const last = await f.store.transaction((tx) =>
        tx.journal.append(
          pgJournalBaselinePositive(pgJournalInput(f.data, [], null), pgJournalLegacyIds[0]),
        ),
      )
      expect(last.seq).toBe(9007199254740991)
      expect(
        (await backend.second.query(`SELECT through_seq::text AS h FROM ${f.table}_scopes`)).rows,
      ).toEqual([{ h: "9007199254740991" }])
      const before = await pgJournalFacts(f)
      await expect(
        f.store.transaction((tx) =>
          tx.journal.append(
            pgJournalBaselinePositive(pgJournalInput(f.data, [], null), pgJournalLegacyIds[1]),
          ),
        ),
      ).rejects.toThrow(/capacity|exhaust|sequence/i)
      expect(await pgJournalFacts(f)).toEqual(before)
      expect(await f.store.transaction((tx) => tx.journal.read(9007199254740990))).toEqual([last])
      const id = `b4e1.${ids.generation}.9007199254740991`
      expect(last).toMatchObject({
        eventId: id,
        seq: 9007199254740991,
        event: { eventId: id, seq: 9007199254740991, b4: { v: 1, generation: ids.generation } },
      })
      expect(Object.hasOwn(last.event.b4 as object, "runId")).toBe(false)
      expect(Object.hasOwn(last.event.b4 as object, "turnId")).toBe(false)
    })
  })

  it("rolls back caught post-allocation JavaScript errors including undefined without losing failure state", async () => {
    await withPgJournalFixture(async (f) => {
      const { installationContext } = await import("../src/runtime/index.ts")
      type SqlClient = import("../src/sql.ts").SqlClient
      type SqlResult<R> = import("../src/sql.ts").SqlResult<R>
      for (const fault of [new Error("fixture JS after native journal and H"), undefined]) {
        const before = await pgJournalFacts(f)
        let reached = 0
        let nativeWitness: { h: unknown; journal: unknown } | undefined
        let caught = false
        let caughtValue: unknown = "not-caught"
        let restored = false
        let descriptorBefore: PropertyDescriptor | undefined
        let descriptorAfter: PropertyDescriptor | undefined
        const outcome = await f.store
          .transaction(async (tx) => {
            await tx.thread.put({
              ...f.data.thread,
              revision: 2,
              thread: { ...f.data.thread.thread, metadata: { attemptedWrite: "must roll back" } },
            })
            const activity = installationContext(f.owner).host.activity.getStore()
            if (
              activity?.kind !== "transaction" ||
              activity.owner !== f.owner ||
              !activity.active ||
              activity.scopeKey !==
                JSON.stringify([f.owner.installationId, ids.thread, ids.generation]) ||
              !activity.client
            )
              throw new Error("SETUP: expected exact active enlisted client")
            const client: SqlClient = activity.client
            descriptorBefore = Object.getOwnPropertyDescriptor(client, "query")
            const originalQuery = client.query
            const query = <R = unknown>(sql: string, values?: readonly unknown[]) =>
              originalQuery.call(client, sql, values) as Promise<SqlResult<R>>
            Object.defineProperty(client, "query", {
              configurable: true,
              writable: true,
              value: async <R = unknown>(
                sql: string,
                values?: readonly unknown[],
              ): Promise<SqlResult<R>> => {
                if (sql.startsWith(`INSERT INTO ${f.table}_projections`)) {
                  reached += 1
                  // Original fenced/enlisted query on SAME native writer; no observer connection.
                  const h = await query<{ h: string }>(
                    `SELECT through_seq::text AS h FROM ${f.table}_scopes WHERE thread_id=$1 AND generation=$2`,
                    [ids.thread, ids.generation],
                  )
                  const journal = await query<{ n: string }>(
                    `SELECT count(*)::text AS n FROM ${f.table}_journal WHERE thread_id=$1 AND generation=$2 AND seq=1`,
                    [ids.thread, ids.generation],
                  )
                  nativeWitness = { h: h.rows[0]?.h, journal: journal.rows[0]?.n }
                  // OUTSIDE originalQuery/enlistClient's catch, to require journal's own failure slot.
                  throw fault
                }
                return query<R>(sql, values)
              },
            })
            try {
              try {
                await tx.journal.append(
                  pgJournalBaselinePositive(pgJournalInput(f.data), pgJournalLegacyIds[0]),
                )
              } catch (error) {
                caught = true
                caughtValue = error
              }
            } finally {
              if (descriptorBefore) {
                Object.defineProperty(client, "query", descriptorBefore)
                restored = true
              } else restored = Reflect.deleteProperty(client, "query")
              descriptorAfter = Object.getOwnPropertyDescriptor(client, "query")
            }
            return "caught" as const
          })
          .then(
            (value) => ({ status: "resolved" as const, value }),
            (reason) => ({ status: "rejected" as const, reason }),
          )
        expect(restored, "SETUP: restore exact scoped client query method").toBe(true)
        expect(descriptorAfter).toEqual(descriptorBefore)
        expect(
          { reached, nativeWitness, caught },
          "SETUP: real native allocation+insert precede JS fault",
        ).toEqual({ reached: 1, nativeWitness: { h: "1", journal: "1" }, caught: true })
        expect(caughtValue).toBe(fault)
        expect({ outcome, after: await pgJournalFacts(f) }).toEqual({
          outcome: { status: "rejected", reason: fault },
          after: before,
        })
        if (outcome.status === "rejected") expect(outcome.reason).toBe(fault)
      }
    })
  })

  it("refuses a native canonical journal ID collision without overwriting or skipping a fact", async () => {
    await withPgJournalFixture(async (f) => {
      const collisionId = `b4e1.${ids.generation}.2`
      const legacy: import("@b4run/sdk/agent-protocol").RuntimeJournalRecord = {
        eventId: collisionId,
        seq: 1,
        namespace: [],
        ownerRunId: null,
        event: {
          type: "event",
          method: "values",
          params: {
            namespace: [],
            timestamp: 0,
            data: { legacy: "retain exact bytes 🌱", unknown: [true, null, 3.25] },
          },
        },
      }
      const payload = JSON.stringify(legacy)
      const client = await backend.second.connect()
      try {
        await client.query("BEGIN")
        try {
          await client.query(
            `INSERT INTO ${f.table}_journal(thread_id,generation,id,seq,owner_run_id,namespace,payload) VALUES ($1,$2,$3,1,NULL,'[]',$4)`,
            [ids.thread, ids.generation, collisionId, payload],
          )
          const changed = await client.query(
            `UPDATE ${f.table}_scopes SET through_seq=1 WHERE thread_id=$1 AND generation=$2 AND through_seq=0 RETURNING through_seq::text AS h`,
            [ids.thread, ids.generation],
          )
          expect(changed.rows).toEqual([{ h: "1" }])
          await client.query(
            `INSERT INTO ${f.table}_projections(thread_id,generation,through_seq,revision,payload) VALUES ($1,$2,1,$3,$4)`,
            [ids.thread, ids.generation, f.data.thread.revision, JSON.stringify({ throughSeq: 1 })],
          )
          await client.query("COMMIT")
        } catch (error) {
          try {
            await client.query("ROLLBACK")
          } catch {
            /* Preserve the original setup failure. */
          }
          throw error
        }
      } finally {
        client.release()
      }
      expect(
        (await backend.second.query(`SELECT id,seq::text AS seq FROM ${f.table}_journal`)).rows,
      ).toEqual([{ id: collisionId, seq: "1" }])
      expect(
        (await backend.second.query(`SELECT through_seq::text AS h FROM ${f.table}_scopes`)).rows,
      ).toEqual([{ h: "1" }])
      expect(await f.store.transaction((tx) => tx.journal.read(0))).toEqual([legacy])
      const legacyBytes = (
        await backend.second.query(
          `SELECT encode(convert_to(payload,'UTF8'),'hex') AS bytes FROM ${f.table}_journal WHERE id=$1`,
          [collisionId],
        )
      ).rows[0]?.bytes
      expect(legacyBytes).toBe(Buffer.from(payload, "utf8").toString("hex"))
      const before = await pgJournalFacts(f)
      let caught = false
      let nativeCode: unknown
      const outcome = await f.store
        .transaction(async (tx) => {
          await tx.thread.put({
            ...f.data.thread,
            revision: 2,
            thread: {
              ...f.data.thread.thread,
              metadata: { attemptedWrite: "collision must roll back" },
            },
          })
          try {
            await tx.journal.append(
              pgJournalBaselinePositive(pgJournalInput(f.data, [], null), pgJournalLegacyIds[0]),
            )
          } catch (error) {
            caught = true
            nativeCode = (error as { code?: unknown })?.code
          }
          return "caught" as const
        })
        .then(
          () => "resolved" as const,
          () => "rejected" as const,
        )
      expect({ outcome, caught, after: await pgJournalFacts(f) }).toEqual({
        outcome: "rejected",
        caught: true,
        after: before,
      })
      expect(nativeCode).toBe("23505")
      expect(
        (
          await backend.second.query(
            `SELECT encode(convert_to(payload,'UTF8'),'hex') AS bytes FROM ${f.table}_journal WHERE id=$1`,
            [collisionId],
          )
        ).rows[0]?.bytes,
      ).toBe(legacyBytes)
      expect(await f.store.transaction((tx) => tx.journal.read(0))).toEqual([legacy])
    })
  })

  it("keeps canonical global order and final projection H across awaited concurrent appends", async () => {
    await withPgJournalFixture(async (f) => {
      const { installationContext } = await import("../src/runtime/index.ts")
      type SqlClient = import("../src/sql.ts").SqlClient
      type SqlResult<R> = import("../src/sql.ts").SqlResult<R>
      const before = await pgJournalFacts(f)
      const nativeProjectionOrder: number[] = []
      let lowHeld = false
      let highCompleted = false
      let lowAfterHigh = false
      let restored = false
      let descriptorBefore: PropertyDescriptor | undefined
      let descriptorAfter: PropertyDescriptor | undefined
      const records = await f.store.transaction(async (tx) => {
        const activity = installationContext(f.owner).host.activity.getStore()
        if (
          activity?.kind !== "transaction" ||
          activity.owner !== f.owner ||
          !activity.active ||
          activity.scopeKey !==
            JSON.stringify([f.owner.installationId, ids.thread, ids.generation]) ||
          !activity.client
        )
          throw new Error("SETUP: expected exact active concurrent-append client")
        const client: SqlClient = activity.client
        descriptorBefore = Object.getOwnPropertyDescriptor(client, "query")
        const originalQuery = client.query
        const query = <R = unknown>(sql: string, values?: readonly unknown[]) =>
          originalQuery.call(client, sql, values) as Promise<SqlResult<R>>
        let releaseLow!: () => void
        const highestProjection = new Promise<void>((resolve) => {
          releaseLow = resolve
        })
        Object.defineProperty(client, "query", {
          configurable: true,
          writable: true,
          value: async <R = unknown>(
            sql: string,
            values?: readonly unknown[],
          ): Promise<SqlResult<R>> => {
            const projection = sql.startsWith(`INSERT INTO ${f.table}_projections`)
            const seq = values?.[2]
            if (projection && seq === 1) {
              lowHeld = true
              // Wait OUTSIDE the original query queue, allowing all actual higher writes to run.
              await highestProjection
              lowAfterHigh = highCompleted
            }
            const result = await query<R>(sql, values)
            if (projection && typeof seq === "number") {
              nativeProjectionOrder.push(seq)
              if (seq === 3) {
                highCompleted = true
                releaseLow()
              }
            }
            return result
          },
        })
        const appends: Promise<import("@b4run/sdk/agent-protocol").RuntimeJournalRecord>[] = []
        const settlements: Promise<void>[] = []
        let fulfilledAppends = 0
        try {
          const work = [
            { input: pgJournalInput(f.data, ["parallel/one"]), legacyId: pgJournalLegacyIds[0] },
            { input: pgJournalInput(f.data, ["parallel", "two"]), legacyId: pgJournalLegacyIds[1] },
            { input: pgJournalInput(f.data, []), legacyId: pgJournalLegacyIds[2] },
          ]
          for (const { input, legacyId } of work) {
            const append = tx.journal.append(pgJournalBaselinePositive(input, legacyId))
            appends.push(append)
            settlements.push(
              append.then(
                () => {
                  fulfilledAppends += 1
                  // While seq1 is held it cannot fulfill: two fulfillments are the OTHER appends.
                  // A missed seq3 interception must fail the strict order assertions, not hang the gate.
                  if (fulfilledAppends === work.length - 1) releaseLow()
                },
                () => {
                  releaseLow()
                },
              ),
            )
          }
          // Explicit aggregate await; no append may outlive this owner callback.
          return await Promise.all(appends)
        } finally {
          releaseLow()
          // Also join every actual append on an early rejection before restoring the scoped method.
          await Promise.allSettled(appends)
          // Join every immediately attached settlement observer before restoring the client method.
          await Promise.all(settlements)
          if (descriptorBefore) {
            Object.defineProperty(client, "query", descriptorBefore)
            restored = true
          } else restored = Reflect.deleteProperty(client, "query")
          descriptorAfter = Object.getOwnPropertyDescriptor(client, "query")
        }
      })
      expect(
        { lowHeld, highCompleted, lowAfterHigh, restored },
        "SETUP: real H3 UPSERT must complete before older H1 UPSERT",
      ).toEqual({ lowHeld: true, highCompleted: true, lowAfterHigh: true, restored: true })
      expect(descriptorAfter).toEqual(descriptorBefore)
      expect(nativeProjectionOrder).toHaveLength(3)
      expect([...nativeProjectionOrder].sort((a, b) => a - b)).toEqual([1, 2, 3])
      expect(nativeProjectionOrder.indexOf(3)).toBeLessThan(nativeProjectionOrder.indexOf(1))
      const ordered = [...records].sort((a, b) => a.seq - b.seq)
      expect(ordered.map((record) => record.seq)).toEqual([1, 2, 3])
      expect(ordered.map((record) => record.eventId)).toEqual(
        [1, 2, 3].map((seq) => `b4e1.${ids.generation}.${seq}`),
      )
      for (const record of ordered)
        expect(record.event).toMatchObject({
          eventId: record.eventId,
          seq: record.seq,
          b4: {
            v: 1,
            generation: ids.generation,
            runId: f.data.run.run.run_id,
            turnId: f.data.run.metadata.turnId,
          },
        })
      expect(await f.store.transaction((tx) => tx.journal.read(0))).toEqual(ordered)
      const facts = await pgJournalFacts(f)
      expect(facts.scope).toEqual([{ ...before.scope[0], h: "3" }])
      expect(facts.threads).toEqual(before.threads)
      expect(facts.runs).toEqual(before.runs)
      expect(facts.identities).toEqual(before.identities)
      expect(facts.journal.map((row) => row.seq)).toEqual(["1", "2", "3"])
      expect(facts.projections).toEqual([
        {
          thread_id: ids.thread,
          generation: ids.generation,
          through_seq: "3",
          revision: "1",
          payload: JSON.stringify({ throughSeq: 3 }),
        },
      ])
    })
  })
})
