import { type ChildProcess, fork } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sqliteRuntimeStorage } from "@b4run/sqlite-storage"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool } from "pg"
import { afterEach, expect, it } from "vitest"
import { postgresRuntimeStorage } from "../../postgres-storage/dist/node.js"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

it("provides private backend-owned atomic claim, heartbeat and fenced release", async () => {
  const f = await fixture()
  try {
    const accepted = await f.admit(body({ on_completion: "keep" }))
    const ownership = runtimeStorageRegistration(f.storage).execution
    expect(
      ownership,
      "ownership recovery must be supplied by the authoritative backend",
    ).toBeDefined()
    if (!ownership) throw new Error("Missing backend ownership")
    const before = await f.snapshot(accepted.threadId)
    await expect(
      ownership.claim(accepted.threadId, "rolled-back-owner", async (tx) => {
        const run = (await tx.runs.list())[0]
        if (!run) throw new Error("Missing accepted Run")
        await tx.runs.put({
          ...run,
          execution: { ownerId: "rolled-back-owner", fence: tx.scope.fence },
          metadata: { ...run.metadata, phase: "running", startedAt: new Date().toISOString() },
        })
        throw new Error("claim callback failed")
      }),
    ).rejects.toThrow("claim callback failed")
    expect(await f.snapshot(accepted.threadId)).toEqual(before)
    let fence = 0
    const lease = await ownership.claim(accepted.threadId, "owner-a", async (tx) => {
      fence = tx.scope.fence
    })
    expect(lease).toBeDefined()
    if (!lease) throw new Error("Missing owner lease")
    expect(await ownership.claim(accepted.threadId, "owner-a", async () => {})).toBeUndefined()
    expect(await ownership.claim(accepted.threadId, "owner-b", async () => {})).toBeUndefined()
    await lease.heartbeat()
    await lease.release()
    await expect(lease.store.transaction(async () => {})).rejects.toMatchObject({
      code: "stale_fence",
    })
    const next = await ownership.claim(accepted.threadId, "owner-b", async (tx) => {
      expect(tx.scope.fence).toBeGreaterThan(fence)
    })
    expect(next).toBeDefined()
    await next?.release()
  } finally {
    await f.close()
  }
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
function stopped(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()))
}
function worker(boot: Record<string, unknown>) {
  const child = fork(new URL("./fixtures/protocol-runtime-worker.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { PATH: process.env.PATH ?? "", B4_TELEMETRY_DISABLED: "1" },
  })
  const messages: Record<string, unknown>[] = []
  let waiter: (() => void) | undefined
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  child.on("message", (message: Record<string, unknown>) => {
    messages.push(message)
    waiter?.()
  })
  child.on("exit", () => waiter?.())
  child.send(boot)
  cleanups.push(async () => {
    const done = stopped(child)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await done
  })
  return {
    child,
    async wait(status: string) {
      for (;;) {
        const index = messages.findIndex(
          (message) => message.status === status || message.status === "error",
        )
        if (index >= 0) {
          const message = messages.splice(index, 1)[0]
          if (message?.status === "error") throw new Error(String(message.message))
          return message
        }
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Worker exited: ${stderr}`)
        await new Promise<void>((resolve) => {
          waiter = resolve
        })
      }
    },
    async kill() {
      const done = stopped(child)
      child.kill("SIGKILL")
      await done
    },
  }
}
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "b4-dispatch-process-"))
  cleanups.push(async () => {
    rmSync(root, { recursive: true, force: true })
  })
  return { root, counter: join(root, "effects") }
}
it.each(["accepted", "marker", "effect"] as const)(
  "recovers SQLite after an actual process kill at %s without replaying uncertain work",
  async (boundary) => {
    const paths = scratch()
    const acceptedWorker = worker({ ...paths, mode: "accept" })
    const accepted = await acceptedWorker.wait("accepted")
    await acceptedWorker.kill()
    if (boundary !== "accepted") {
      const started = worker({ ...paths, mode: boundary })
      await started.wait("ready")
      started.child.send("tick")
      await started.wait(boundary)
      await started.kill()
    }
    const recovery = worker({ ...paths, mode: "run" })
    await recovery.wait("ready")
    recovery.child.send("tick")
    await recovery.wait("ticked")
    recovery.child.send("close")
    await recovery.wait("closed")
    await stopped(recovery.child)
    const f = await fixture(sqliteRuntimeStorage(paths.root))
    try {
      const snapshot = await f.snapshot(String(accepted?.threadId))
      expect(snapshot.runs[0]).toMatchObject({
        run: { run_id: accepted?.runId, status: boundary === "accepted" ? "success" : "error" },
        metadata: {
          reason: boundary === "accepted" ? "completed" : "execution_lost",
          effectsUncertain: boundary !== "accepted",
          phase: "settled",
        },
      })
      if (boundary === "effect")
        expect(snapshot.runs[0]?.result?.values).toEqual({ partial: "durably retained" })
      expect(existsSync(paths.counter) ? readFileSync(paths.counter, "utf8") : "").toBe(
        boundary === "marker" ? "" : "effect\n",
      )
    } finally {
      await f.close()
    }
  },
  60_000,
)

// This is a separately invoked actual integration lane, never reported as run
// when B4_TEST_PGSTORAGE is absent.
if (process.env.B4_TEST_PGSTORAGE === "1") {
  it("claims from two Node processes, fences a live stale worker after DB lease loss, and recovers accepted/idle scopes", async () => {
    const paths = scratch()
    const container = await new PostgreSqlContainer("postgres:16")
      .withStartupTimeout(180_000)
      .start()
    const pool = new Pool({ connectionString: container.getConnectionUri() })
    const engine = await pool.query<{ version: string }>("SELECT version()")
    process.stdout.write(`R5 actual database: ${engine.rows[0]?.version}\n`)
    const errors: Error[] = []
    pool.on("error", (error) => errors.push(error))
    cleanups.push(async () => {
      await pool.end()
      await container.stop()
      process.stdout.write(`R5 removed own container ${container.getId()}\n`)
      expect(errors).toEqual([])
    })
    const schema = "r5_process",
      tablePrefix = "b4_ap_v1_case"
    const boot = { ...paths, connectionString: container.getConnectionUri(), schema, tablePrefix }
    const acceptedWorker = worker({ ...boot, mode: "accept" })
    const accepted = await acceptedWorker.wait("accepted")
    acceptedWorker.child.send("close")
    await acceptedWorker.wait("closed")
    await stopped(acceptedWorker.child)
    // Proven never-started expiry: no graph hook has run, and recovery may
    // safely start the same canonical Run after fencing the idle binding.
    await pool.query(
      `UPDATE "${schema}"."${tablePrefix}_scopes" SET lease_expires_at=clock_timestamp()-interval '1 second'`,
    )
    const first = worker({ ...boot, mode: "effect" }),
      second = worker({ ...boot, mode: "effect" })
    const [firstReady, secondReady] = await Promise.all([first.wait("ready"), second.wait("ready")])
    process.stdout.write(
      `R5 independent Node claim workers: ${first.child.pid}/${second.child.pid}\n`,
    )
    first.child.send("tick")
    second.child.send("tick")
    await Promise.all([first.wait("ticked"), second.wait("ticked")])
    const claimedOwner = await pool.query<{ execution_owner: string }>(
      `SELECT execution_owner FROM "${schema}"."${tablePrefix}_scopes" WHERE thread_id=$1`,
      [accepted?.threadId],
    )
    const ownerId = claimedOwner.rows[0]?.execution_owner
    const winners = [
      { worker: first, ownerId: firstReady?.ownerId },
      { worker: second, ownerId: secondReady?.ownerId },
    ].filter((entry) => entry.ownerId === ownerId)
    expect(winners, "exactly one actual Node contender must own the durable claim").toHaveLength(1)
    const winner = winners[0]?.worker
    if (!winner) throw new Error("Missing durable claim winner")
    // Claim acknowledgement precedes graph I/O. Wait for the actual external
    // file effect, including the graph's prior durable partial-result write.
    await winner.wait("effect")
    expect(readFileSync(paths.counter, "utf8")).toBe("effect\n")
    await pool.query(
      `UPDATE "${schema}"."${tablePrefix}_scopes" SET lease_expires_at=clock_timestamp()-interval '1 second'`,
    )
    const recovery = worker({ ...boot, mode: "run" })
    await recovery.wait("ready")
    recovery.child.send("tick")
    await recovery.wait("ticked")
    expect(readFileSync(paths.counter, "utf8")).toBe("effect\n")
    // Exactly one worker captured an executing store. Ask both; the winner's
    // actual cached transaction must reject after takeover.
    first.child.send("stale-write")
    second.child.send("stale-write")
    const staleResults = await Promise.all([first.wait("stale-write"), second.wait("stale-write")])
    expect(staleResults.map((result) => result?.code).sort()).toEqual([
      "no-captured-store",
      "stale_fence",
    ])
    const f = await fixture(postgresRuntimeStorage({ pool, schema, tablePrefix }))
    try {
      expect((await f.snapshot(String(accepted?.threadId))).runs[0]).toMatchObject({
        run: { status: "error" },
        metadata: { reason: "execution_lost", effectsUncertain: true },
        result: { values: { partial: "durably retained" } },
      })
      const retained = await f.admit(body({ on_completion: "keep" }))
      // Finish the new accepted case through the same executor, then verify an
      // exact retained receipt survives a real DB-clock idle expiry.
      const { createExecutionHost } = await import("../src/lib/runtime/executor.ts")
      const host = createExecutionHost({ storage: f.storage, invoke: async () => ({}) })
      await host.tick()
      await host.idle()
      await host.close()
      const old = await f.store(retained.threadId)
      await pool.query(
        `UPDATE "${schema}"."${tablePrefix}_scopes" SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE thread_id=$1`,
        [retained.threadId],
      )
      expect((await f.admit(body({ on_completion: "keep" }))).runId).toBe(retained.runId)
      await expect(old.transaction(async () => {})).rejects.toMatchObject({ code: "stale_fence" })
    } finally {
      await f.close()
    }
    for (const process of [first, second, recovery]) {
      process.child.send("close")
      await process.wait("closed")
      await stopped(process.child)
    }
    for (const boundary of ["marker", "effect"] as const) {
      const prefix = `${tablePrefix}_crash_${boundary}`
      const counter = join(paths.root, `effects-${boundary}`)
      const crashBoot = { ...boot, tablePrefix: prefix, counter }
      const accept = worker({ ...crashBoot, mode: "accept" })
      const ids = await accept.wait("accepted")
      await accept.kill()
      const started = worker({ ...crashBoot, mode: boundary })
      await started.wait("ready")
      started.child.send("tick")
      await started.wait(boundary)
      await started.kill()
      await pool.query(
        `UPDATE "${schema}"."${prefix}_scopes" SET lease_expires_at=clock_timestamp()-interval '1 second'`,
      )
      const restarted = worker({ ...crashBoot, mode: "run" })
      await restarted.wait("ready")
      restarted.child.send("tick")
      await restarted.wait("ticked")
      restarted.child.send("close")
      await restarted.wait("closed")
      await stopped(restarted.child)
      const inspection = await fixture(
        postgresRuntimeStorage({ pool, schema, tablePrefix: prefix }),
      )
      try {
        const recovered = (await inspection.snapshot(String(ids?.threadId))).runs[0]
        expect(recovered).toMatchObject({
          run: { run_id: ids?.runId, status: "error" },
          metadata: { reason: "execution_lost", effectsUncertain: true },
        })
        if (boundary === "effect")
          expect(recovered?.result?.values).toEqual({ partial: "durably retained" })
        expect(existsSync(counter) ? readFileSync(counter, "utf8") : "").toBe(
          boundary === "marker" ? "" : "effect\n",
        )
      } finally {
        await inspection.close()
      }
    }
    const polling = await fixture(
      postgresRuntimeStorage({ pool, schema, tablePrefix: `${tablePrefix}_poll` }),
    )
    const { createExecutionHost } = await import("../src/lib/runtime/executor.ts")
    let invoked!: () => void
    const polled = new Promise<void>((resolve) => {
      invoked = resolve
    })
    const pollCounter = join(paths.root, "poll-effects")
    const { appendFileSync } = await import("node:fs")
    const pollingHost = createExecutionHost({
      storage: polling.storage,
      invoke: async () => {
        appendFileSync(pollCounter, "effect\n")
        invoked()
        return {}
      },
    })
    try {
      await pollingHost.start()
      const accepted = await polling.admit(body({ on_completion: "keep" }))
      // No notification is sent and no direct tick is called after acceptance.
      // The actual default one-second durable poll is the only dispatcher.
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          polled,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error("Durable poll did not discover accepted dispatch")),
              5_000,
            )
          }),
        ])
      } finally {
        clearTimeout(deadline)
      }
      await pollingHost.idle()
      expect(readFileSync(pollCounter, "utf8")).toBe("effect\n")
      expect((await polling.snapshot(accepted.threadId)).runs[0]?.run.status).toBe("success")
    } finally {
      await pollingHost.close()
      await polling.close()
    }
    const heartbeatPrefix = `${tablePrefix}_heartbeat`
    const heartbeatFixture = await fixture(
      postgresRuntimeStorage({ pool, schema, tablePrefix: heartbeatPrefix }),
    )
    try {
      const accepted = await heartbeatFixture.admit(body({ on_completion: "keep" }))
      const backend = runtimeStorageRegistration(heartbeatFixture.storage).execution
      if (!backend) throw new Error("Missing real Postgres execution backend")
      const beforeClaim = await heartbeatFixture.snapshot(accepted.threadId)
      await expect(
        backend.claim(accepted.threadId, "rollback-owner", async (tx) => {
          const row = (await tx.runs.list())[0]
          if (!row) throw new Error("Missing accepted Run")
          await tx.runs.put({
            ...row,
            execution: { ownerId: "rollback-owner", fence: tx.scope.fence },
            metadata: { ...row.metadata, phase: "running", startedAt: new Date().toISOString() },
          })
          for (const entry of await tx.inbox.list())
            await tx.inbox.put({ ...entry, status: "applied" })
          throw new Error("Postgres claim callback failed")
        }),
      ).rejects.toThrow("Postgres claim callback failed")
      expect(await heartbeatFixture.snapshot(accepted.threadId)).toEqual(beforeClaim)
      const lease = await backend.claim(accepted.threadId, "heartbeat-owner", async () => {})
      if (!lease) throw new Error("Missing real Postgres execution lease")
      expect(
        await backend.claim(accepted.threadId, "heartbeat-owner", async () => {}),
      ).toBeUndefined()
      await pool.query(
        `UPDATE "${schema}"."${heartbeatPrefix}_scopes" SET lease_expires_at=clock_timestamp()+interval '5 seconds'`,
      )
      await lease.heartbeat()
      const renewed = await pool.query<{ remaining: number }>(
        `SELECT extract(epoch FROM lease_expires_at-clock_timestamp())::float8 AS remaining FROM "${schema}"."${heartbeatPrefix}_scopes"`,
      )
      expect(renewed.rows[0]?.remaining).toBeGreaterThan(55)
      expect(renewed.rows[0]?.remaining).toBeLessThanOrEqual(60)
      await pool.query(
        `UPDATE "${schema}"."${heartbeatPrefix}_scopes" SET lease_expires_at=clock_timestamp()-interval '1 second'`,
      )
      await expect(lease.heartbeat()).rejects.toMatchObject({ code: "stale_fence" })
      const expired = await pool.query<{ expired: boolean }>(
        `SELECT lease_expires_at<=clock_timestamp() AS expired FROM "${schema}"."${heartbeatPrefix}_scopes"`,
      )
      expect(expired.rows[0]?.expired).toBe(true)
      await expect(heartbeatFixture.store(accepted.threadId)).rejects.toMatchObject({
        code: "storage_unavailable",
      })
      await lease.release()
      await expect(lease.heartbeat()).rejects.toMatchObject({ code: "stale_fence" })
      const timers = new Map<unknown, { delay: number; callback: () => void }>()
      const heartbeatCounter = join(paths.root, "heartbeat-effects")
      let entered!: () => void, aborted!: () => void
      const invoking = new Promise<void>((resolve) => {
        entered = resolve
      })
      const aborting = new Promise<void>((resolve) => {
        aborted = resolve
      })
      const host = createExecutionHost({
        storage: heartbeatFixture.storage,
        clock: {
          now: () => new Date().toISOString(),
          setInterval(callback, delay) {
            const handle = {}
            timers.set(handle, { callback, delay })
            return handle
          },
          clearInterval(handle) {
            timers.delete(handle)
          },
        },
        async invoke({ signal }) {
          appendFileSync(heartbeatCounter, "effect\n")
          entered()
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                aborted()
                resolve()
              },
              { once: true },
            ),
          )
          // A provider's late success after abort cannot settle an expired Run.
          return { values: { staleSuccess: true } }
        },
      })
      try {
        await host.tick()
        await invoking
        expect([...timers.values()].map((timer) => timer.delay)).toContain(15_000)
        await pool.query(
          `UPDATE "${schema}"."${heartbeatPrefix}_scopes" SET lease_expires_at=clock_timestamp()-interval '1 second'`,
        )
        for (const timer of timers.values()) if (timer.delay === 15_000) timer.callback()
        await aborting
        await host.idle()
        await host.tick()
        await host.idle()
        expect(readFileSync(heartbeatCounter, "utf8")).toBe("effect\n")
        expect((await heartbeatFixture.snapshot(accepted.threadId)).runs[0]).toMatchObject({
          run: { status: "error" },
          metadata: { reason: "execution_lost", effectsUncertain: true },
        })
      } finally {
        await host.close()
      }
    } finally {
      await heartbeatFixture.close()
    }
    const guardedPool = new Pool({
      connectionString: container.getConnectionUri(),
      max: 2,
      connectionTimeoutMillis: 200,
      application_name: "r5_inspection_guard_probe",
    })
    guardedPool.on("error", (error) => errors.push(error))
    const guardPrefix = `${tablePrefix}_guards`
    const guarded = await fixture(
      postgresRuntimeStorage({ pool: guardedPool, schema, tablePrefix: guardPrefix }),
    )
    let independent: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      const accepted = await guarded.admit(body({ on_completion: "keep" }))
      const store = await guarded.store(accepted.threadId)
      const registration = runtimeStorageRegistration(guarded.storage)
      const execution = registration.execution
      if (!execution) throw new Error("Missing real execution hooks")
      const outcomes = await store.withReadLease(async () => {
        // A spare work client permits ordinary committed discovery reads.
        expect(await execution.listCandidates()).toContain(accepted.threadId)
        expect((await registration.readThread(accepted.threadId))?.thread.thread_id).toBe(
          accepted.threadId,
        )
        const held = await guardedPool.connect()
        try {
          return await Promise.allSettled([
            execution.claim(accepted.threadId, "saturated-callback-owner", async () => {}),
            execution.listCandidates(),
          ])
        } finally {
          held.release()
        }
      })
      for (const outcome of outcomes) {
        expect.soft(outcome.status).toBe("rejected")
        if (outcome.status === "rejected")
          expect.soft(outcome.reason).toMatchObject({ code: "pool_capacity" })
      }
      expect.soft(guardedPool.waitingCount).toBe(0)
      let releaseLate!: () => void
      const lateBarrier = new Promise<void>((resolve) => {
        releaseLate = resolve
      })
      let late: Promise<PromiseSettledResult<unknown>[]> | undefined
      await store.withReadLease(async () => {
        late = (async () => {
          await lateBarrier
          return Promise.allSettled([
            execution.listCandidates(),
            execution.claim(accepted.threadId, "expired-callback-owner", async () => {}),
          ])
        })()
      })
      releaseLate()
      for (const outcome of await (late ?? Promise.resolve([]))) {
        expect.soft(outcome.status).toBe("rejected")
        if (outcome.status === "rejected")
          expect.soft(outcome.reason).toMatchObject({ code: "closed_transaction" })
      }
      independent = await fixture(
        postgresRuntimeStorage({ pool: guardedPool, schema, tablePrefix: guardPrefix }),
      )
      const other = runtimeStorageRegistration(independent.storage)
      let entered!: () => void, release!: () => void
      const enteredInspection = new Promise<void>((resolve) => {
        entered = resolve
      })
      const providerUnwind = new Promise<void>((resolve) => {
        release = resolve
      })
      let unwound = false,
        renewedBeforeUnwind = false,
        settled = false
      const inspection = store.withReadLease(async () => {
        entered()
        await providerUnwind
        unwound = true
      })
      await enteredInspection
      const before = await pool.query<{ fence: string }>(
        `SELECT fence FROM "${schema}"."${guardPrefix}_scopes" WHERE thread_id=$1`,
        [accepted.threadId],
      )
      await pool.query(
        `UPDATE "${schema}"."${guardPrefix}_scopes" SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE thread_id=$1`,
        [accepted.threadId],
      )
      let renewed: import("@b4run/sdk/agent-protocol").RuntimeStore | undefined,
        renewalError: unknown
      const renewal = other.openThread(accepted.threadId, false).then(
        (value) => {
          renewed = value
          renewedBeforeUnwind = !unwound
          settled = true
        },
        (error) => {
          renewalError = error
          settled = true
        },
      )
      let observedWaitingLock = false
      try {
        for (let attempt = 0; attempt < 100 && !settled; attempt++) {
          const waiting = await pool.query<{ waiting: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND NOT l.granted AND a.application_name=$1) AS waiting",
            ["r5_inspection_guard_probe"],
          )
          if (waiting.rows[0]?.waiting) {
            observedWaitingLock = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        const during = await pool.query<{ fence: string }>(
          `SELECT fence FROM "${schema}"."${guardPrefix}_scopes" WHERE thread_id=$1`,
          [accepted.threadId],
        )
        expect.soft(observedWaitingLock).toBe(true)
        expect.soft(settled).toBe(false)
        expect.soft(during.rows[0]?.fence).toBe(before.rows[0]?.fence)
      } finally {
        release()
        await Promise.allSettled([inspection, renewal])
      }
      expect.soft(renewalError).toBeUndefined()
      expect.soft(renewedBeforeUnwind).toBe(false)
      expect(renewed).toBeDefined()
      if (renewed)
        expect((await renewed.snapshot()).scope.fence).toBeGreaterThan(
          Number(before.rows[0]?.fence),
        )
      await expect(store.transaction(async () => {})).rejects.toMatchObject({ code: "stale_fence" })
      const beforeConcurrent = await pool.query<{ fence: string; generation: string }>(
        `SELECT fence,generation FROM "${schema}"."${guardPrefix}_scopes" WHERE thread_id=$1`,
        [accepted.threadId],
      )
      await pool.query(
        `UPDATE "${schema}"."${guardPrefix}_scopes" SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE thread_id=$1`,
        [accepted.threadId],
      )
      const concurrentRenewals = await Promise.allSettled([
        registration.openThread(accepted.threadId, false),
        other.openThread(accepted.threadId, false),
      ])
      expect(concurrentRenewals.some((outcome) => outcome.status === "fulfilled")).toBe(true)
      for (const outcome of concurrentRenewals) {
        if (outcome.status === "rejected")
          expect(outcome.reason).toMatchObject({ code: "storage_unavailable" })
        else
          expect((await outcome.value?.snapshot())?.scope.generation).toBe(
            beforeConcurrent.rows[0]?.generation,
          )
      }
      const afterConcurrent = await pool.query<{ fence: string; execution_owner: string | null }>(
        `SELECT fence,execution_owner FROM "${schema}"."${guardPrefix}_scopes" WHERE thread_id=$1`,
        [accepted.threadId],
      )
      expect(Number(afterConcurrent.rows[0]?.fence)).toBe(
        Number(beforeConcurrent.rows[0]?.fence) + 1,
      )
      expect(afterConcurrent.rows[0]?.execution_owner).toBeNull()
    } finally {
      await independent?.close()
      await guarded.close()
      await guardedPool.end()
    }
  }, 240_000)
}
