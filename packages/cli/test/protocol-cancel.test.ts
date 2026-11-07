import { afterEach, expect, it } from "vitest"
import { createExecutionHost, settleExecution } from "../src/lib/runtime/executor.ts"
import { createPermissionService, parkPermissions } from "../src/lib/runtime/permissions.ts"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

// R7 cases include real native boot/transactions and controlled provider unwind.
// Choose this integration budget before the first execution; old cases stay unchanged.
const budget = 30_000
const cleanups: (() => Promise<void>)[] = []
it(
  "refuses a mismatched exact-generation bind without renewing or advancing the native scope",
  async () => {
    const { f, accepted } = await setup(),
      backend = runtimeStorageRegistration(f.storage),
      before = await f.snapshot(accepted.threadId),
      nativeBefore = await f.native.scopeRecord(accepted.threadId)
    expect(await backend.openThread(accepted.threadId, false, crypto.randomUUID())).toBeUndefined()
    expect(await backend.openThread(accepted.threadId, true, crypto.randomUUID())).toBeUndefined()
    expect(
      await backend.openThread(accepted.threadId, true, before.scope.generation),
    ).toBeUndefined()
    const missing = crypto.randomUUID()
    expect(await backend.openThread(missing, true, crypto.randomUUID())).toBeUndefined()
    expect(await f.native.scopeRecord(missing)).toEqual([])
    const after = await f.snapshot(accepted.threadId)
    expect(await f.native.scopeRecord(accepted.threadId)).toEqual(nativeBefore)
    expect(after.scope).toEqual(before.scope)
    expect(after.thread).toEqual(before.thread)
    const exact = await backend.openThread(accepted.threadId, false, before.scope.generation)
    expect(exact).toBeDefined()
    expect((await exact?.snapshot())?.scope).toEqual(before.scope)
    expect(await exact?.transaction((tx) => tx.executionOwner())).toBeNull()
  },
  budget,
)
it(
  "retires a permission park that races an already accepted running Stop without another invocation",
  async () => {
    const { f, accepted } = await setup(),
      entered = barrier(),
      park = barrier()
    let invocations = 0
    const host = createExecutionHost({
      ...f.authority,
      async invoke({ run, store }) {
        invocations++
        entered.release()
        await park.promise
        await store.transaction((tx) =>
          parkPermissions(
            tx,
            run.run.run_id,
            [
              {
                interruptId: "race",
                namespace: [],
                request: {
                  kind: "tool",
                  detail: { toolName: "effect", suggestedPattern: "effect" },
                },
                protectedProposal: {},
              },
            ],
            "required",
          ),
        )
        return {}
      },
    })
    cleanups.push(
      () => host.close(),
      async () => park.release(),
    )
    await host.tick()
    await entered.promise
    await host.cancel(f.request(), accepted.threadId, accepted.runId, { wait: false })
    park.release()
    await host.idle()
    const snapshot = await f.snapshot(accepted.threadId)
    expect(invocations).toBe(1)
    expect(snapshot.runs[0]?.metadata).toMatchObject({
      reason: "permission",
      continuation: "closed",
    })
    expect(snapshot.pending[0]).toMatchObject({ disposition: "retired", decision: null })
    expect(snapshot.grants[0]?.consumedByRunId).toBeNull()
    expect(snapshot.thread?.pausedGeneration).toBeNull()
  },
  budget,
)
it(
  "binds native permission continuation to its new canonical Run and leaves a late predecessor close harmless",
  async () => {
    const f = await fixture()
    cleanups.push(() => f.close())
    const initial = await f.service.admitNativeCreation(
        f.request(),
        body({ on_completion: "keep" }),
      ),
      permissions = createPermissionService({ ...f.authority })
    let invocations = 0
    const host = createExecutionHost({
      ...f.authority,
      permissions,
      async invoke({ run, store }) {
        invocations++
        await store.transaction((tx) =>
          parkPermissions(tx, run.run.run_id, [
            {
              interruptId: "prompt",
              namespace: [],
              request: { kind: "tool", detail: { toolName: "effect", suggestedPattern: "effect" } },
              protectedProposal: {},
            },
          ]),
        )
        return {}
      },
    })
    cleanups.push(() => host.close())
    const oldSignal = new AbortController(),
      oldBinding = await host.bindNativeCreation(initial, oldSignal.signal)
    await host.tick()
    await host.idle()
    const resumed = await permissions.respondNativeCreation(
      f.request(),
      initial.threadId,
      initial.runId,
      {
        type: "command",
        id: 1,
        method: "input.respond",
        params: {
          responses: [{ namespace: [], interruptId: "prompt", response: { decision: "once" } }],
        },
      },
    )
    const newSignal = new AbortController(),
      newBinding = await host.bindNativeCreation(resumed, newSignal.signal)
    oldSignal.abort()
    await oldBinding.closed
    expect(
      (await f.snapshot(initial.threadId)).runs.find((r) => r.run.run_id === resumed.runId)
        ?.metadata.phase,
    ).toBe("accepted")
    newSignal.abort()
    await newBinding.closed
    await host.tick()
    await host.idle()
    expect(invocations).toBe(1)
    expect(
      (await f.snapshot(initial.threadId)).runs.find((r) => r.run.run_id === resumed.runId)
        ?.metadata.reason,
    ).toBe("client_disconnect")
  },
  budget,
)
it(
  "does not report clean completion for a missing control or a different generation",
  async () => {
    const { f, accepted } = await setup(),
      backend = runtimeStorageRegistration(f.storage).execution,
      scope = (await f.snapshot(accepted.threadId)).scope
    if (!backend?.controlProgress) throw new Error("Missing native control progress")
    expect(await backend.controlProgress(scope, crypto.randomUUID(), accepted.runId)).toBe(
      "uncertain",
    )
    expect(
      await backend.controlProgress(
        { ...scope, generation: crypto.randomUUID() },
        crypto.randomUUID(),
        accepted.runId,
      ),
    ).toBe("uncertain")
  },
  budget,
)
it.each(["cancel", "continue"] as const)(
  "binds REST creation disconnect=%s only from original service provenance",
  async (onDisconnect) => {
    const f = await fixture()
    cleanups.push(() => f.close())
    const input = body({ on_completion: "keep", on_disconnect: onDisconnect })
    const accepted = await f.service.admitRestCreation(f.request(), input)
    const entered = barrier(),
      unwind = barrier(),
      owning = new AbortController(),
      observer = new AbortController()
    let aborted = false
    const host = createExecutionHost({
      ...f.authority,
      async invoke({ signal }) {
        signal.addEventListener("abort", () => {
          aborted = true
        })
        entered.release()
        await unwind.promise
        return {}
      },
    })
    cleanups.push(
      () => host.close(),
      async () => {
        unwind.release()
      },
    )
    await expect(host.bindRestCreation({ ...accepted }, owning.signal)).rejects.toThrow(
      "Unrecognized owning stream",
    )
    const binding = await host.bindRestCreation(accepted, owning.signal)
    await host.tick()
    await entered.promise
    observer.abort()
    await host.tick()
    expect(aborted).toBe(false)
    owning.abort()
    await binding.closed
    await host.tick()
    expect(aborted).toBe(onDisconnect === "cancel")
    unwind.release()
    await host.idle()
    expect((await f.snapshot(accepted.threadId)).runs[0]?.metadata.reason).toBe(
      onDisconnect === "cancel" ? "client_disconnect" : "completed",
    )
  },
  budget,
)
it(
  "does not promote a background receipt into ownership and native POST uses its own trusted entrypoint",
  async () => {
    const f = await fixture()
    cleanups.push(() => f.close())
    const input = body({ on_completion: "keep", on_disconnect: "continue" })
    const background = await f.admit(input)
    const replay = await f.service.admitRestCreation(f.request(), input)
    const host = createExecutionHost({ ...f.authority, invoke: async () => ({}) })
    cleanups.push(() => host.close())
    await expect(host.bindRestCreation(background, new AbortController().signal)).rejects.toThrow(
      "Unrecognized owning stream",
    )
    await expect(host.bindRestCreation(replay, new AbortController().signal)).rejects.toThrow(
      "Unrecognized owning stream",
    )
    await host.cancel(f.request(), background.threadId, background.runId, { wait: true })
    const native = await f.service.admitNativeCreation(
      f.request(),
      body({
        on_completion: "keep",
        on_disconnect: "continue",
        metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
      }),
    )
    const disconnect = new AbortController(),
      binding = await host.bindNativeCreation(native, disconnect.signal)
    disconnect.abort()
    await binding.closed
    expect((await f.snapshot(native.threadId)).runs[0]?.metadata.reason).toBe("client_disconnect")
  },
  budget,
)
it(
  "rejects new work while a settled execution still owns provider unwind",
  async () => {
    const { f, accepted } = await setup()
    const settled = barrier(),
      unwind = barrier()
    const host = createExecutionHost({
      ...f.authority,
      async invoke({ run, store }) {
        await store.transaction((tx) =>
          settleExecution(tx, run.run.run_id, { status: "success", reason: "completed" }),
        )
        settled.release()
        await unwind.promise
        return {}
      },
    })
    cleanups.push(
      () => host.close(),
      async () => {
        unwind.release()
      },
    )
    await host.tick()
    await settled.promise
    await expect(
      f.admit(
        body({
          thread_id: accepted.threadId,
          metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        }),
      ),
    ).rejects.toMatchObject({ code: "thread_busy" })
    unwind.release()
    await host.idle()
    expect((await f.snapshot(accepted.threadId)).runs[0]?.unwoundAt).toEqual(expect.any(String))
  },
  budget,
)
it(
  "rolls back an unwind callback failure inside the exact owned release transaction",
  async () => {
    const { f, accepted } = await setup()
    const execution = runtimeStorageRegistration(f.storage).execution
    if (!execution) throw new Error("missing native execution storage")
    const lease = await execution.claim(accepted.threadId, "release-proof-owner", async () => {})
    if (!lease) throw new Error("missing native lease")
    cleanups.push(() => lease.release())
    await expect(
      lease.release(async (tx) => {
        expect(await tx.executionOwner()).toBe("release-proof-owner")
        throw new Error("release callback failed")
      }),
    ).rejects.toThrow("release callback failed")
    await lease.heartbeat()
    await lease.release(async (tx) => {
      const run = await tx.runs.get(accepted.runId)
      if (!run) throw new Error("missing Run")
      await tx.runs.put({ ...run, unwoundAt: new Date().toISOString() })
    })
    expect(
      await (await f.store(accepted.threadId)).transaction((tx) => tx.executionOwner()),
    ).toBeNull()
  },
  budget,
)
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
async function setup() {
  const f = await fixture()
  cleanups.push(() => f.close())
  const accepted = await f.admit(body({ on_completion: "keep" }))
  return { f, accepted }
}
it(
  "retires queued work without crossing started or invoking a graph",
  async () => {
    const { f, accepted } = await setup()
    let effects = 0
    const host = createExecutionHost({
      ...f.authority,
      invoke: async () => {
        effects++
        return {}
      },
    })
    cleanups.push(() => host.close())
    await host.cancel(f.request(), accepted.threadId, accepted.runId, { wait: true })
    await host.tick()
    await host.idle()
    const s = await f.snapshot(accepted.threadId)
    expect(effects).toBe(0)
    expect(s.runs[0]?.metadata).toMatchObject({
      phase: "settled",
      reason: "user_stop",
      effectsUncertain: false,
    })
    expect(s.runs[0]?.metadata.startedAt).toBeUndefined()
    expect(s.inbox.find((r) => r.kind === "dispatch")?.status).toBe("not_applied")
    expect(s.inbox.find((r) => r.kind === "control")).toMatchObject({
      runId: accepted.runId,
      status: "applied",
    })
  },
  budget,
)
it(
  "accepts remote exact control and holds ownership and wait=true until actual unwind",
  async () => {
    const { f, accepted } = await setup()
    const entered = barrier(),
      aborted = barrier(),
      unwind = barrier()
    let effects = 0
    const owner = createExecutionHost({
      ...f.authority,
      async invoke({ signal, store, run }) {
        effects++
        await store.transaction(async (tx) => {
          const row = await tx.runs.get(run.run.run_id)
          if (!row) throw new Error("missing executing Run")
          await tx.runs.put({ ...row, result: { values: { partial: "kept" } } })
        })
        signal.addEventListener("abort", () => aborted.release(), { once: true })
        entered.release()
        await unwind.promise
        return { values: { late: true } }
      },
    })
    const remote = createExecutionHost({
      ...f.authority,
      invoke: async () => {
        effects++
        return {}
      },
    })
    cleanups.push(
      () => owner.close(),
      () => remote.close(),
      async () => {
        unwind.release()
      },
    )
    await owner.tick()
    await entered.promise
    await remote.cancel(f.request(), accepted.threadId, accepted.runId, { wait: false })
    expect((await f.snapshot(accepted.threadId)).runs[0]?.metadata.phase).toBe("running")
    const waiting = remote.cancel(f.request(), accepted.threadId, accepted.runId, { wait: true })
    let finished = false
    void waiting.then(() => {
      finished = true
    })
    await owner.tick()
    await aborted.promise
    await remote.tick()
    expect(effects).toBe(1)
    expect(finished).toBe(false)
    expect((await f.snapshot(accepted.threadId)).runs[0]?.metadata.phase).toBe("running")
    unwind.release()
    await owner.idle()
    await waiting
    expect((await f.snapshot(accepted.threadId)).runs[0]).toMatchObject({
      run: { status: "interrupted" },
      metadata: { reason: "user_stop", effectsUncertain: false },
      result: { values: { partial: "kept" } },
    })
  },
  budget,
)
it.each(["stop", "resume"] as const)(
  "wins overlapping %s acceptance before its competing pause operation without targeting the successor",
  async (first) => {
    const { f, accepted } = await setup()
    const winnerEntered = barrier(),
      loserEntered = barrier(),
      releaseWinner = barrier()
    const policy = f.authority.policy
    let stopGates = 0
    const permissions = createPermissionService({
      ...f.authority,
      grants: "required",
      policy: {
        ...policy,
        async fallback(request) {
          if (first === "stop" && request.operation === "input.respond") loserEntered.release()
          return policy.fallback(request)
        },
      },
      async failpoint(point) {
        if (first === "resume" && point === "beforeCommit") {
          winnerEntered.release()
          await releaseWinner.promise
        }
      },
    })
    let effects = 0
    const host = createExecutionHost({
      ...f.authority,
      policy: {
        ...policy,
        async fallback(request) {
          if (request.operation === "run.cancel") {
            stopGates++
            if (first === "stop" && stopGates === 2) {
              winnerEntered.release()
              await releaseWinner.promise
            } else if (first === "resume" && stopGates === 1) loserEntered.release()
          }
          return policy.fallback(request)
        },
      },
      permissions,
      async invoke({ run, store }) {
        effects++
        if (run.run.run_id === accepted.runId)
          await store.transaction((tx) =>
            parkPermissions(
              tx,
              run.run.run_id,
              [
                {
                  interruptId: "same-public-id",
                  namespace: [],
                  request: {
                    kind: "tool",
                    detail: { toolName: "effect", suggestedPattern: "effect" },
                  },
                  protectedProposal: { value: true },
                },
              ],
              "required",
            ),
          )
        return {}
      },
    })
    cleanups.push(
      () => host.close(),
      async () => releaseWinner.release(),
    )
    await host.tick()
    await host.idle()
    const paused = await f.snapshot(accepted.threadId)
    const pending = paused.pending[0]
    if (!pending) throw new Error("missing prompt")
    const answer = {
      type: "command",
      id: 1,
      method: "input.respond",
      params: {
        responses: [
          {
            namespace: [],
            interruptId: pending.input.data.interruptId,
            response: { decision: "once", grant: pending.input.data.b4.grant },
          },
        ],
      },
    }
    let successor: string | undefined
    if (first === "stop") {
      const winner = host.cancel(f.request(), accepted.threadId, accepted.runId, { wait: true })
      await winnerEntered.promise
      const loser = permissions.respond(f.request(), accepted.threadId, accepted.runId, answer)
      const rejected = expect(loser).rejects.toMatchObject({ code: "stale_generation" })
      await loserEntered.promise
      releaseWinner.release()
      await winner
      await rejected
    } else {
      const winner = permissions.respond(f.request(), accepted.threadId, accepted.runId, answer)
      await winnerEntered.promise
      const loser = host.cancel(f.request(), accepted.threadId, accepted.runId, { wait: true })
      await loserEntered.promise
      releaseWinner.release()
      successor = (await winner).runId
      await loser
    }
    await host.tick()
    await host.idle()
    const stopped = await f.snapshot(accepted.threadId)
    expect(effects).toBe(first === "stop" ? 1 : 2)
    expect(stopped.runs.find((r) => r.run.run_id === accepted.runId)?.metadata).toMatchObject({
      reason: "permission",
      continuation: "closed",
    })
    if (first === "stop") {
      expect(stopped.runs).toHaveLength(1)
      expect(stopped.pending[0]).toMatchObject({ disposition: "retired", decision: null })
      expect(stopped.grants[0]?.consumedByRunId).toBeNull()
    } else
      expect(stopped.runs.find((r) => r.run.run_id === successor)?.metadata.reason).toBe(
        "completed",
      )
    expect(
      (await (await f.store(accepted.threadId)).transaction((tx) => tx.journal.read(0))).filter(
        (r) => r.event.method === "lifecycle",
      ),
    ).toHaveLength(0)
  },
  budget,
)
it(
  "keeps durable control after the HTTP waiter times out and rejects current authority loss",
  async () => {
    const { f, accepted } = await setup()
    const entered = barrier(),
      unwind = barrier()
    let aborted = false
    const owner = createExecutionHost({
      ...f.authority,
      async invoke({ signal }) {
        signal.addEventListener("abort", () => {
          aborted = true
        })
        entered.release()
        await unwind.promise
        return {}
      },
    })
    const remote = createExecutionHost({ ...f.authority, invoke: async () => ({}) })
    cleanups.push(
      () => owner.close(),
      () => remote.close(),
      async () => {
        unwind.release()
      },
    )
    await owner.tick()
    await entered.promise
    const timeout = new AbortController()
    const request = f.request()
    const waitingRequest = new Request(request, { signal: timeout.signal })
    const waiting = remote.cancel(waitingRequest, accepted.threadId, accepted.runId, { wait: true })
    const rejected = expect(waiting).rejects.toThrow("HTTP wait timeout")
    await remote.cancel(f.request(), accepted.threadId, accepted.runId, { wait: false })
    timeout.abort(new Error("HTTP wait timeout"))
    await rejected
    expect(
      (await f.snapshot(accepted.threadId)).inbox.filter((e) => e.kind === "control"),
    ).toHaveLength(1)
    await owner.tick()
    expect(aborted).toBe(true)
    unwind.release()
    await owner.idle()
    f.deny()
    await expect(
      remote.cancel(f.request(), accepted.threadId, accepted.runId, {}),
    ).rejects.toMatchObject({ code: "not_found" })
  },
  budget,
)
