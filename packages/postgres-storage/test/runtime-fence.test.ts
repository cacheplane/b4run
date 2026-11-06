import { describe, expect, it } from "vitest"
import { bound, realBackend, scope, sharedContract } from "./fixtures/runtime-backend.ts"
import { run, thread } from "./fixtures/runtime-data.ts"

describe.skipIf(process.env.B4_TEST_PGSTORAGE !== "1")("real Postgres runtime conformance", () => {
  const backend = realBackend()
  sharedContract(backend)
  const checkpoint = {
    v: 4,
    id: "native-checkpoint",
    ts: "2026-11-06T00:00:00.000Z",
    channel_values: { messages: ["owned"] },
    channel_versions: { messages: 1 },
    versions_seen: {},
  }
  const config = { configurable: { thread_id: scope.threadId, checkpoint_ns: "" } }
  const metadata = { source: "loop" as const, step: 1, parents: {} }
  it("fences cached connections and actual saver writes after independent durable takeover", async () => {
    const fixture = await bound(backend)
    await fixture.store.transaction(async (tx) => {
      await tx.runs.put(run)
      await tx.thread.put(thread)
    })
    const cached = await fixture.store.pool.connect()
    await fixture.store.transaction(async (tx) => {
      await tx.runs.put(run)
      await tx.thread.put(thread)
    })
    const saver = fixture.store.checkpointer(run.run.run_id)
    try {
      await saver.put(config, checkpoint, metadata, {})
      await saver.putWrites(
        { ...config, configurable: { ...config.configurable, checkpoint_id: checkpoint.id } },
        [["messages", "pending"]],
        "task",
      )
      const current = await fixture.observer.advanceFence()
      await expect(cached.query("SELECT 1")).rejects.toMatchObject({ code: "stale_fence" })
      await expect(
        saver.put(config, { ...checkpoint, id: "stale" }, metadata, {}),
      ).rejects.toMatchObject({ code: "stale_fence" })
      await expect(
        saver.putWrites(
          { ...config, configurable: { ...config.configurable, checkpoint_id: checkpoint.id } },
          [["messages", "stale"]],
          "stale-task",
        ),
      ).rejects.toMatchObject({ code: "stale_fence" })
      const tuple = await current.checkpointer(run.run.run_id).getTuple(config)
      expect(tuple?.checkpoint.id).toBe(checkpoint.id)
      expect(tuple?.pendingWrites).toEqual([["task", "messages", "pending"]])
    } finally {
      cached.release()
      await fixture.close()
    }
  })
  it("enlists saver checkpoint and pending writes in the shared rollback and commit", async () => {
    const fixture = await bound(backend)
    await fixture.store.transaction(async (tx) => {
      await tx.runs.put(run)
      await tx.thread.put(thread)
    })
    const saver = fixture.store.checkpointer(run.run.run_id)
    try {
      await expect(
        fixture.store.transaction(async () => {
          await saver.put(config, checkpoint, metadata, {})
          await saver.putWrites(
            { ...config, configurable: { ...config.configurable, checkpoint_id: checkpoint.id } },
            [["messages", "pending"]],
            "task",
          )
          expect(
            await fixture.observer.checkpointer(run.run.run_id).getTuple(config),
          ).toBeUndefined()
          await Promise.resolve()
          throw new Error("rollback saver")
        }),
      ).rejects.toThrow("rollback saver")
      expect(await fixture.observer.checkpointer(run.run.run_id).getTuple(config)).toBeUndefined()
      await fixture.store.transaction(async () => {
        await saver.put(config, checkpoint, metadata, {})
        await saver.putWrites(
          { ...config, configurable: { ...config.configurable, checkpoint_id: checkpoint.id } },
          [["messages", "pending"]],
          "task",
        )
      })
      expect(
        (await fixture.observer.checkpointer(run.run.run_id).getTuple(config))?.pendingWrites,
      ).toEqual([["task", "messages", "pending"]])
    } finally {
      await fixture.close()
    }
  })
  it("expired current lease rejects writes and cached BEGIN before takeover", async () => {
    const fixture = await bound(backend)
    await fixture.store.transaction(async (tx) => {
      await tx.runs.put(run)
      await tx.thread.put(thread)
    })
    const cached = await fixture.store.pool.connect()
    try {
      await backend.second.query(
        `UPDATE ${fixture.naming.schema}.${fixture.naming.tablePrefix}_scopes SET lease_expires_at=clock_timestamp()-interval '1 second'`,
      )
      await expect(cached.query("BEGIN")).rejects.toMatchObject({ code: "stale_fence" })
      await expect(fixture.store.transaction((tx) => tx.snapshot())).rejects.toMatchObject({
        code: "stale_fence",
      })
      const current = await fixture.observer.advanceFence()
      expect((await current.snapshot()).scope.fence).toBe(2)
    } finally {
      cached.release()
      await fixture.close()
    }
  })
  it("rejects foreign graph Thread/namespace and canonical Run ownership even without a fence change", async () => {
    const fixture = await bound(backend)
    const saver = fixture.store.checkpointer(run.run.run_id)
    try {
      await fixture.store.transaction(async (tx) => {
        await tx.runs.put(run)
        await tx.thread.put(thread)
      })
      await saver.put(config, checkpoint, metadata, {})
      await expect(
        saver.put(
          { configurable: { thread_id: "foreign", checkpoint_ns: "" } },
          checkpoint,
          metadata,
          {},
        ),
      ).rejects.toMatchObject({ code: "scope_mismatch" })
      await expect(
        saver.put(
          { configurable: { thread_id: scope.threadId, checkpoint_ns: "child" } },
          checkpoint,
          metadata,
          {},
        ),
      ).rejects.toMatchObject({ code: "scope_mismatch" })
      await expect(
        fixture.store.checkpointer("missing").put(config, checkpoint, metadata, {}),
      ).rejects.toMatchObject({ code: "scope_mismatch" })
      const nextId = "10000000-0000-4000-8000-000000000099"
      await fixture.store.transaction(async (tx) => {
        await tx.runs.put({ ...run, run: { ...run.run, run_id: nextId } })
        await tx.thread.put({ ...thread, currentRunId: nextId })
      })
      await expect(
        saver.put(config, { ...checkpoint, id: "late" }, metadata, {}),
      ).rejects.toMatchObject({ code: "scope_mismatch" })
      await expect(
        fixture.store.checkpointer(nextId).put(config, checkpoint, metadata, {}),
      ).rejects.toMatchObject({ code: "scope_mismatch" })
      expect(
        (
          await backend.second.query(
            `SELECT owner_run_id,fence,generation FROM ${fixture.naming.schema}.${fixture.naming.tablePrefix}_native_checkpoints`,
          )
        ).rows,
      ).toEqual([{ owner_run_id: run.run.run_id, fence: "1", generation: scope.generation }])
    } finally {
      await fixture.close()
    }
  })
  it("caught native saver failure poisons the whole outer transaction", async () => {
    const fixture = await bound(backend)
    try {
      await fixture.store.transaction(async (tx) => {
        await tx.runs.put(run)
        await tx.thread.put(thread)
      })
      await expect(
        fixture.store.transaction(async (tx) => {
          await tx.thread.put({ ...thread, revision: 2 })
          try {
            await fixture.store
              .checkpointer(run.run.run_id)
              .put({ configurable: { thread_id: "foreign" } }, checkpoint, metadata, {})
          } catch {}
        }),
      ).rejects.toMatchObject({ code: "scope_mismatch" })
      expect((await fixture.observer.snapshot()).revision).toBe(1)
    } finally {
      await fixture.close()
    }
  })
  it("rejects a native checkpoint with an absent or foreign-scope parent", async () => {
    const fixture = await bound(backend)
    try {
      await fixture.store.transaction(async (tx) => {
        await tx.runs.put(run)
        await tx.thread.put(thread)
      })
      await expect(
        fixture.store
          .checkpointer(run.run.run_id)
          .put(
            { ...config, configurable: { ...config.configurable, checkpoint_id: "absent-parent" } },
            checkpoint,
            metadata,
            {},
          ),
      ).rejects.toThrow(/foreign key/i)
      expect(await fixture.observer.checkpointer(run.run.run_id).getTuple(config)).toBeUndefined()
    } finally {
      await fixture.close()
    }
  })
  it("rolls back native and projection writes when the lease expires before COMMIT", async () => {
    const fixture = await bound(backend)
    try {
      await fixture.store.transaction(async (tx) => {
        await tx.runs.put(run)
        await tx.thread.put(thread)
      })
      await expect(
        fixture.store.transaction(async (tx) => {
          await tx.thread.put({ ...thread, revision: 2 })
          await fixture.store.checkpointer(run.run.run_id).put(config, checkpoint, metadata, {})
          await tx.journal.append({
            eventId: "expired-event",
            ownerRunId: run.run.run_id,
            namespace: [],
            event: {
              type: "event",
              method: "lifecycle",
              params: {
                namespace: [],
                timestamp: Date.parse(checkpoint.ts),
                data: { event: "completed" },
              },
            },
          })
          await fixture.store.pool.query(
            `UPDATE ${fixture.naming.schema}.${fixture.naming.tablePrefix}_scopes SET lease_expires_at=clock_timestamp()-interval '1 second'`,
          )
        }),
      ).rejects.toMatchObject({ code: "stale_fence" })
      expect((await fixture.observer.snapshot()).revision).toBe(1)
      expect((await fixture.observer.snapshot()).throughSeq).toBe(0)
      expect(
        (
          await backend.second.query(
            `SELECT * FROM ${fixture.naming.schema}.${fixture.naming.tablePrefix}_projections`,
          )
        ).rows,
      ).toEqual([])
      expect(await fixture.observer.checkpointer(run.run.run_id).getTuple(config)).toBeUndefined()
    } finally {
      await fixture.close()
    }
  })
  it("a read lease also excludes independent native saver mutations until provider unwind", async () => {
    const fixture = await bound(backend)
    let start!: () => void
    const gate = new Promise<void>((resolve) => {
      start = resolve
    })
    let finished = false
    const write = gate.then(async () => {
      await fixture.observer.checkpointer(run.run.run_id).put(config, checkpoint, metadata, {})
      finished = true
    })
    try {
      await fixture.store.transaction(async (tx) => {
        await tx.runs.put(run)
        await tx.thread.put(thread)
      })
      await fixture.store.withReadLease(async () => {
        start()
        let blocked = false
        for (let attempt = 0; attempt < 50 && !finished && !blocked; attempt++) {
          const result = await backend.second.query<{ blocked: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%') AS blocked",
          )
          blocked = result.rows[0]?.blocked ?? false
          if (!blocked && !finished) await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(finished).toBe(false)
        expect(blocked).toBe(true)
      })
      await write
      expect(
        (await fixture.observer.checkpointer(run.run.run_id).getTuple(config))?.checkpoint.id,
      ).toBe(checkpoint.id)
    } finally {
      start()
      await write
      await fixture.close()
    }
  })
  it.each(["put", "putWrites"])(
    "caught pre-SQL %s validation rolls back the complete outer transaction",
    async (method) => {
      const fixture = await bound(backend)
      const saver = fixture.store.checkpointer(run.run.run_id)
      try {
        await fixture.store.transaction(async (tx) => {
          await tx.runs.put(run)
          await tx.thread.put(thread)
        })
        let childError: unknown
        await expect(
          fixture.store.transaction(async (tx) => {
            await tx.thread.put({ ...thread, revision: 2 })
            try {
              if (method === "put") await saver.put({ configurable: {} }, checkpoint, metadata, {})
              else await saver.putWrites({ configurable: {} }, [["messages", "pending"]], "task")
            } catch (error) {
              childError = error
            }
          }),
        ).rejects.toThrow(/thread_id is required/)
        expect(childError).toBeInstanceOf(Error)
        expect((await fixture.observer.snapshot()).revision).toBe(1)
      } finally {
        await fixture.close()
      }
    },
  )
  it.each(["put", "putWrites"])(
    "caught pre-SQL %s serializer failure rolls back and preserves the original error",
    async (method) => {
      const fixture = await bound(backend)
      const saver = fixture.store.checkpointer(run.run.run_id)
      const original = saver.serde.dumpsTyped
      const injected = new Error("injected pre-SQL serialization failure")
      try {
        await fixture.store.transaction(async (tx) => {
          await tx.runs.put(run)
          await tx.thread.put(thread)
        })
        saver.serde.dumpsTyped = async () => {
          throw injected
        }
        const operation = () =>
          method === "put"
            ? saver.put(config, checkpoint, metadata, {})
            : saver.putWrites(
                {
                  ...config,
                  configurable: { ...config.configurable, checkpoint_id: checkpoint.id },
                },
                [["messages", "pending"]],
                "task",
              )
        await expect(operation()).rejects.toBe(injected)
        await expect(
          fixture.store.transaction(async (tx) => {
            await tx.thread.put({ ...thread, revision: 2 })
            try {
              await operation()
            } catch (error) {
              expect(error).toBe(injected)
            }
          }),
        ).rejects.toBe(injected)
        expect((await fixture.observer.snapshot()).revision).toBe(1)
      } finally {
        saver.serde.dumpsTyped = original
        await fixture.close()
      }
    },
  )
  it("caught falsy serializer rejection still aborts the outer transaction", async () => {
    const fixture = await bound(backend)
    const saver = fixture.store.checkpointer(run.run.run_id)
    const original = saver.serde.dumpsTyped
    try {
      await fixture.store.transaction(async (tx) => {
        await tx.runs.put(run)
        await tx.thread.put(thread)
      })
      saver.serde.dumpsTyped = async () => Promise.reject(undefined)
      await expect(
        fixture.store.transaction(async (tx) => {
          await tx.thread.put({ ...thread, revision: 2 })
          try {
            await saver.put(config, checkpoint, metadata, {})
          } catch {}
        }),
      ).rejects.toBeUndefined()
      expect((await fixture.observer.snapshot()).revision).toBe(1)
    } finally {
      saver.serde.dumpsTyped = original
      await fixture.close()
    }
  })
  it("caught list deserialization rejection poisons its complete async-iteration lifetime", async () => {
    const fixture = await bound(backend)
    const saver = fixture.store.checkpointer(run.run.run_id)
    const original = saver.serde.loadsTyped
    const injected = new Error("injected list deserialization failure")
    try {
      await fixture.store.transaction(async (tx) => {
        await tx.runs.put(run)
        await tx.thread.put(thread)
      })
      await saver.put(config, checkpoint, metadata, {})
      saver.serde.loadsTyped = async () => {
        throw injected
      }
      const iterator = saver.list(config)
      await expect(
        fixture.store.transaction(async (tx) => {
          await tx.thread.put({ ...thread, revision: 2 })
          try {
            for await (const tuple of iterator) void tuple
          } catch (error) {
            expect(error).toBe(injected)
          }
        }),
      ).rejects.toBe(injected)
      expect((await fixture.observer.snapshot()).revision).toBe(1)
    } finally {
      saver.serde.loadsTyped = original
      await fixture.close()
    }
  })
  it("keeps standalone saver reads, lazy list termination and later writes usable", async () => {
    const fixture = await bound(backend)
    const saver = fixture.store.checkpointer(run.run.run_id)
    try {
      await fixture.store.transaction(async (tx) => {
        await tx.runs.put(run)
        await tx.thread.put(thread)
      })
      await expect(saver.put({ configurable: {} }, checkpoint, metadata, {})).rejects.toThrow(
        /thread_id is required/,
      )
      await saver.put(config, checkpoint, metadata, {})
      expect((await saver.get(config))?.id).toBe(checkpoint.id)
      expect(await saver.listNamespaces(scope.threadId)).toEqual([""])
      let seen = 0
      for await (const tuple of saver.list(config)) {
        expect(tuple.checkpoint.id).toBe(checkpoint.id)
        seen++
        break
      }
      expect(seen).toBe(1)
      await saver.putWrites(
        { ...config, configurable: { ...config.configurable, checkpoint_id: checkpoint.id } },
        [["messages", "after-list"]],
        "task",
      )
      expect((await saver.getTuple(config))?.pendingWrites).toEqual([
        ["task", "messages", "after-list"],
      ])
      await saver.close()
      expect((await fixture.observer.snapshot()).revision).toBe(1)
    } finally {
      await fixture.close()
    }
  })
})
