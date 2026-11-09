import type { RuntimeStore } from "@b4run/sdk/agent-protocol"
import { afterEach, expect, it } from "vitest"
import { createExecutionHost, settleExecution } from "../src/lib/runtime/executor.ts"
import { createPermissionService, parkPermissions } from "../src/lib/runtime/permissions.ts"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

// R7 cases include real native boot/transactions and controlled provider unwind.
// Choose this integration budget before the first execution; old cases stay unchanged.
const budget = 30_000
const cleanups: (() => Promise<void>)[] = []
it.each(["root", "child", "thread"] as const)(
  "authorizes denied retained %s before the explicit full Run/result read",
  async (authority) => {
    const s = await retainedChild()
    if (authority === "thread") s.f.deny()
    else s.f.removeAgent(authority === "root" ? "/chat#agent" : "/other#agent")
    const audit = auditedRetainedControl(s.f)
    const before = await s.f.native.scopeRecord(s.accepted.threadId)
    await expect(
      audit.controller.cancel(s.f.request(), s.accepted.threadId, s.resumed.runId, { wait: true }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(audit.events).not.toContain("retained_payload_read")
    expect(audit.events).not.toContain("native_bind")
    expect(await s.f.native.scopeRecord(s.accepted.threadId)).toEqual(before)
    expect(s.invocations()).toBe(3)
  },
  budget,
)
it.each(["minimal", "full"] as const)(
  "rejects a corrupt retained %s subject ID at its own read boundary",
  async (phase) => {
    const s = await retainedChild()
    const corrupt = () =>
      s.f.native.corruptRetainedControlFacts(
        s.accepted.threadId,
        s.generation,
        s.resumed.runId,
        "subject-id",
        crypto.randomUUID(),
      )
    if (phase === "minimal") await corrupt()
    const audit = auditedRetainedControl(s.f, phase === "full" ? corrupt : undefined)
    await expect(
      audit.controller.cancel(s.f.request(), s.accepted.threadId, s.resumed.runId, { wait: true }),
    ).rejects.toMatchObject({ code: "not_found" })
    if (phase === "minimal") expect(audit.events).not.toContain("retained_payload_read")
    else expect(audit.events.filter((e) => e === "retained_payload_read")).toHaveLength(1)
    expect(audit.events).not.toContain("native_bind")
    expect(s.invocations()).toBe(3)
  },
  budget,
)
it(
  "gates the full retained payload and then reauthorizes the actual stored facts",
  async () => {
    const s = await retainedChild(),
      audit = auditedRetainedControl(s.f)
    const before = await s.f.native.scopeRecord(s.accepted.threadId)
    await audit.controller.cancel(s.f.request(), s.accepted.threadId, s.resumed.runId, {
      wait: true,
    })
    expect(audit.events).toEqual([
      "authorize:/chat#agent",
      "authorize:/other#agent",
      "thread_gate",
      "retained_payload_read",
      "authorize:/chat#agent",
      "authorize:/other#agent",
      "thread_gate",
    ])
    expect(await s.f.native.scopeRecord(s.accepted.threadId)).toEqual(before)
    expect(s.invocations()).toBe(3)
  },
  budget,
)
it.each([
  ["before-read", "root"],
  ["before-read", "child"],
  ["before-read", "thread"],
  ["after-read", "root"],
  ["after-read", "child"],
  ["after-read", "thread"],
] as const)(
  "reauthorizes retained authority %s when %s is revoked",
  async (phase, authority) => {
    const s = await retainedChild()
    const revoke = async () => {
      if (authority === "thread") s.f.deny()
      else s.f.removeAgent(authority === "root" ? "/chat#agent" : "/other#agent")
    }
    const audit = auditedRetainedControl(
      s.f,
      phase === "before-read" ? revoke : undefined,
      phase === "after-read" ? revoke : undefined,
    )
    const before = await s.f.native.scopeRecord(s.accepted.threadId)
    await expect(
      audit.controller.cancel(s.f.request(), s.accepted.threadId, s.resumed.runId, { wait: true }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(audit.events.slice(0, 4)).toEqual([
      "authorize:/chat#agent",
      "authorize:/other#agent",
      "thread_gate",
      "retained_payload_read",
    ])
    const second =
      authority === "root"
        ? ["authorize:/chat#agent"]
        : authority === "child"
          ? ["authorize:/chat#agent", "authorize:/other#agent"]
          : ["authorize:/chat#agent", "authorize:/other#agent", "thread_gate"]
    expect(audit.events.slice(4)).toEqual(second)
    expect(await s.f.native.scopeRecord(s.accepted.threadId)).toEqual(before)
    expect(s.invocations()).toBe(3)
  },
  budget,
)
it.each(["map", "provenance", "root", "lineage"] as const)(
  "rejects actual retained %s facts changed after minimal authorization",
  async (kind) => {
    const s = await retainedChild(),
      blockedOrigin = crypto.randomUUID()
    s.f.revokeOrigin(blockedOrigin)
    const change = async () => {
      if (kind === "map")
        await s.f.native.corruptRetainedPermissionAgents(
          s.accepted.threadId,
          s.generation,
          s.resumed.runId,
          undefined,
        )
      else
        await s.f.native.corruptRetainedControlFacts(
          s.accepted.threadId,
          s.generation,
          s.resumed.runId,
          kind === "provenance" ? "subject-provenance" : kind,
          kind === "provenance"
            ? blockedOrigin
            : kind === "root"
              ? "/changed#agent"
              : s.resumed.runId,
        )
    }
    const audit = auditedRetainedControl(s.f, change)
    await expect(
      audit.controller.cancel(s.f.request(), s.accepted.threadId, s.resumed.runId, { wait: true }),
    ).rejects.toMatchObject({
      code: kind === "root" || kind === "provenance" ? "not_found" : "storage_unavailable",
    })
    expect(audit.events.slice(0, 4)).toEqual([
      "authorize:/chat#agent",
      "authorize:/other#agent",
      "thread_gate",
      "retained_payload_read",
    ])
    expect(audit.events.filter((e) => e === "retained_payload_read")).toHaveLength(1)
    expect(audit.events).not.toContain("native_bind")
    expect(s.invocations()).toBe(3)
  },
  budget,
)
it.each(["allowed", "revoked"] as const)(
  "checks canonical child authority before exact control binding when child is %s",
  async (authority) => {
    const scenario = await continuedChild(),
      { f, accepted, resumed } = scenario
    if (authority === "revoked") f.removeAgent("/other#agent")
    if (process.env.B4_ADMISSION_POSTGRES === "1") await f.native.expireOwner(accepted.threadId)
    const before = await f.native.scopeRecord(accepted.threadId),
      audit = auditedControl(f),
      { controller, events } = audit
    const cancelling = controller.cancel(f.request(), accepted.threadId, resumed.runId, {
      wait: false,
    })
    if (authority === "revoked") {
      await expect(cancelling).rejects.toMatchObject({ code: "not_found" })
      expect(await f.native.scopeRecord(accepted.threadId)).toEqual(before)
      expect(events).toEqual(["authorize:/chat#agent", "authorize:/other#agent"])
    } else {
      await cancelling
      expect(events.indexOf("authorize:/other#agent")).toBeLessThan(events.indexOf("native_bind"))
      audit.restore()
      expect(
        (await f.snapshot(accepted.threadId)).runs.find((r) => r.run.run_id === resumed.runId)
          ?.metadata.reason,
      ).toBe("user_stop")
    }
    expect(scenario.invocations()).toBe(1)
  },
  budget,
)
it.each([
  "missing",
  "empty",
  "cross-turn",
  "cross-target",
  "cross-thread",
  "duplicate",
  "forged-map",
  "denied-thread",
] as const)(
  "fails closed before binding canonical continuation authority with %s facts",
  async (kind) => {
    const s = await continuedChild()
    await (await s.f.store(s.accepted.threadId)).transaction(async (tx) => {
      const receipt = (await tx.receipts.list()).find((r) => r.receipt.runId === s.resumed.runId)
      if (!receipt?.operation) throw new Error("Missing canonical continuation receipt")
      if (kind === "forged-map") {
        const thread = await tx.thread.get()
        if (!thread) throw new Error("Missing exact Thread")
        await tx.thread.put({
          ...thread,
          revision: thread.revision + 1,
          protectedMetadata: {
            ...thread.protectedMetadata,
            permissionAgentsByRun: { [s.resumed.runId]: ["/chat#agent"] },
          },
          thread: {
            ...thread.thread,
            metadata: {
              ...thread.thread.metadata,
              permissionAgentsByRun: { [s.resumed.runId]: ["/chat#agent"] },
            },
          },
        })
      } else if (kind === "missing") {
        const { operation: _operation, ...without } = receipt
        await tx.receipts.put(without)
      } else if (kind === "duplicate") {
        await tx.receipts.put({ ...receipt, receiptId: crypto.randomUUID() })
      } else if (kind === "cross-turn") {
        await tx.receipts.put({
          ...receipt,
          receipt: { ...receipt.receipt, turnId: s.resumed.runId },
        })
      } else {
        await tx.receipts.put({
          ...receipt,
          operation: {
            ...receipt.operation,
            ...(kind === "cross-target" ? { targetRunId: s.resumed.runId } : {}),
            ...(kind === "cross-thread" ? { operationThreadId: crypto.randomUUID() } : {}),
            ...(kind === "empty" || kind === "denied-thread"
              ? { resolved: { ...receipt.operation.resolved, permissionAgents: [] } }
              : {}),
          },
        })
      }
    })
    if (kind === "forged-map") s.f.removeAgent("/other#agent")
    if (kind === "denied-thread") s.f.deny()
    if (process.env.B4_ADMISSION_POSTGRES === "1") await s.f.native.expireOwner(s.accepted.threadId)
    const before = await s.f.native.scopeRecord(s.accepted.threadId),
      audit = auditedControl(s.f)
    await expect(
      audit.controller.cancel(s.f.request(), s.accepted.threadId, s.resumed.runId, { wait: false }),
    ).rejects.toMatchObject({
      code: kind === "forged-map" || kind === "denied-thread" ? "not_found" : "storage_unavailable",
    })
    expect(audit.events).not.toContain("native_bind")
    expect(await s.f.native.scopeRecord(s.accepted.threadId)).toEqual(before)
    expect(s.invocations()).toBe(1)
  },
  budget,
)
it.each(["before-tx", "during-retry"] as const)(
  "rechecks canonical child authority when revoked %s without another writer or control",
  async (phase) => {
    const s = await continuedChild(),
      backend = runtimeStorageRegistration(s.f.storage)
    let changed = false,
      afterRace: unknown
    const audit = auditedControl(s.f, async () => {
      if (changed) return
      changed = true
      if (phase === "during-retry") {
        const lease = await backend.execution?.claim(
          s.accepted.threadId,
          crypto.randomUUID(),
          async () => {},
        )
        if (!lease) throw new Error("Missing actual native test contention lease")
        await lease.release()
        if (process.env.B4_ADMISSION_POSTGRES === "1")
          await s.f.native.expireOwner(s.accepted.threadId)
      }
      afterRace = await s.f.native.scopeRecord(s.accepted.threadId)
      s.f.removeAgent("/other#agent")
    })
    await expect(
      audit.controller.cancel(s.f.request(), s.accepted.threadId, s.resumed.runId, { wait: false }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(audit.events).toEqual([
      "authorize:/chat#agent",
      "authorize:/other#agent",
      "native_bind",
      "authorize:/chat#agent",
      "authorize:/other#agent",
    ])
    expect(await s.f.native.scopeRecord(s.accepted.threadId)).toEqual(afterRace)
    audit.restore()
    const snapshot = await s.f.snapshot(s.accepted.threadId)
    expect(snapshot.inbox.some((r) => r.kind === "control" && r.runId === s.resumed.runId)).toBe(
      false,
    )
    expect(snapshot.runs.find((r) => r.run.run_id === s.resumed.runId)?.metadata.phase).toBe(
      "accepted",
    )
    expect(s.invocations()).toBe(1)
  },
  budget,
)
it.each(["visible", "hidden"] as const)(
  "rechecks actual canonical receipt facts inside the control transaction when Thread is %s",
  async (policy) => {
    const s = await continuedChild()
    const audit = auditedControl(s.f, async (store) => {
      if (!store) throw new Error("Missing actual bound store")
      await store.transaction(async (tx) => {
        const receipt = (await tx.receipts.list()).find((r) => r.receipt.runId === s.resumed.runId)
        if (!receipt?.operation) throw new Error("Missing canonical continuation receipt")
        await tx.receipts.put({
          ...receipt,
          operation: {
            ...receipt.operation,
            resolved: { ...receipt.operation.resolved, permissionAgents: [] },
          },
        })
      })
      if (policy === "hidden") s.f.deny()
    })
    await expect(
      audit.controller.cancel(s.f.request(), s.accepted.threadId, s.resumed.runId, { wait: false }),
    ).rejects.toMatchObject({ code: policy === "hidden" ? "not_found" : "storage_unavailable" })
    expect(audit.events).toEqual([
      "authorize:/chat#agent",
      "authorize:/other#agent",
      "native_bind",
      "authorize:/chat#agent",
    ])
    audit.restore()
    const snapshot = await s.f.snapshot(s.accepted.threadId)
    expect(snapshot.inbox.some((r) => r.kind === "control" && r.runId === s.resumed.runId)).toBe(
      false,
    )
    expect(snapshot.runs.find((r) => r.run.run_id === s.resumed.runId)?.metadata.phase).toBe(
      "accepted",
    )
    expect(s.invocations()).toBe(1)
  },
  budget,
)
it.each(["allowed", "revoked"] as const)(
  "rechecks exact canonical child authority after live-to-retained transition when %s",
  async (authority) => {
    const s = await continuedChild()
    await s.host.tick()
    await s.host.idle()
    const successor = await s.f.admit(
      body({
        thread_id: s.accepted.threadId,
        on_completion: "delete",
        metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
      }),
    )
    const entered = barrier(),
      release = barrier(),
      policy = s.f.authority.policy
    let held = false
    const audit = auditedControl(s.f, undefined, {
      ...policy,
      async fallback(request) {
        if (request.operation === "run.cancel" && !held) {
          held = true
          entered.release()
          await release.promise
        }
        return policy.fallback(request)
      },
    })
    const waiting = audit.controller
      .cancel(s.f.request(), s.accepted.threadId, s.resumed.runId, { wait: true })
      .then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      )
    cleanups.push(async () => {
      release.release()
      await waiting
    })
    await entered.promise
    await s.host.tick()
    await s.host.idle()
    const backend = runtimeStorageRegistration(s.f.storage)
    expect(await backend.readThread(s.accepted.threadId)).toBeUndefined()
    const retained = await backend.temporary?.readRun(s.resumed.runId)
    expect(retained?.record.metadata.reason).toBe("completed")
    expect((await backend.temporary?.readRun(successor.runId))?.record.metadata.reason).toBe(
      "completed",
    )
    const afterCleanup = await s.f.native.scopeRecord(s.accepted.threadId),
      bindsBeforeRelease = audit.events.filter((e) => e === "native_bind").length,
      temporary = backend.temporary
    if (!temporary) throw new Error("Missing actual retained capability")
    const read = temporary.readRun
    let payloadReads = 0
    Object.assign(temporary, {
      readRun(...args: Parameters<typeof read>) {
        payloadReads++
        return read(...args)
      },
    })
    cleanups.push(async () => {
      Object.assign(temporary, { readRun: read })
    })
    if (authority === "revoked") s.f.removeAgent("/other#agent")
    release.release()
    const result = await waiting
    if (authority === "revoked")
      expect(result).toMatchObject({ ok: false, error: { code: "not_found" } })
    else expect(result).toEqual({ ok: true })
    expect(audit.events.filter((e) => e === "native_bind")).toHaveLength(bindsBeforeRelease + 1)
    expect(payloadReads).toBe(authority === "revoked" ? 0 : 1)
    expect(await s.f.native.scopeRecord(s.accepted.threadId)).toEqual(afterCleanup)
    expect(s.invocations()).toBe(3)
  },
  budget,
)
it.each(["missing", "forged"] as const)(
  "refuses a retained continuation with a %s saved map instead of degrading its canonical authority",
  async (kind) => {
    const s = await continuedChild()
    await s.host.tick()
    await s.host.idle()
    const generation = (await s.f.snapshot(s.accepted.threadId)).scope.generation
    await s.f.admit(
      body({
        thread_id: s.accepted.threadId,
        on_completion: "delete",
        metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
      }),
    )
    await s.host.tick()
    await s.host.idle()
    const backend = runtimeStorageRegistration(s.f.storage)
    expect(await backend.readThread(s.accepted.threadId)).toBeUndefined()
    await s.f.native.corruptRetainedPermissionAgents(
      s.accepted.threadId,
      generation,
      s.resumed.runId,
      kind === "forged" ? ["/chat#agent"] : undefined,
    )
    const before = await s.f.native.scopeRecord(s.accepted.threadId),
      audit = auditedControl(s.f)
    await expect(
      audit.controller.cancel(s.f.request(), s.accepted.threadId, s.resumed.runId, { wait: true }),
    ).rejects.toMatchObject({ code: "storage_unavailable" })
    expect(audit.events).not.toContain("native_bind")
    expect(await s.f.native.scopeRecord(s.accepted.threadId)).toEqual(before)
    expect(s.invocations()).toBe(3)
  },
  budget,
)
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
  "preserves a permission park published after Stop was accepted during active execution",
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
      continuation: "waiting",
    })
    expect(snapshot.pending[0]).toMatchObject({ disposition: "pending", decision: null })
    expect(snapshot.grants[0]?.consumedByRunId).toBeNull()
    expect(snapshot.thread?.pausedGeneration).not.toBeNull()
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
      async invoke({ signal, stopSignal }) {
        stopSignal.addEventListener("abort", () => {
          aborted = true
        })
        entered.release()
        await unwind.promise
        signal.throwIfAborted()
        stopSignal.throwIfAborted()
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
      async invoke({ signal, stopSignal, store, run }) {
        effects++
        await store.transaction(async (tx) => {
          const row = await tx.runs.get(run.run.run_id)
          if (!row) throw new Error("missing executing Run")
          await tx.runs.put({ ...row, result: { values: { partial: "kept" } } })
        })
        stopSignal.addEventListener("abort", () => aborted.release(), { once: true })
        entered.release()
        await unwind.promise
        expect(signal.aborted).toBe(false)
        stopSignal.throwIfAborted()
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
      async invoke({ signal, stopSignal }) {
        stopSignal.addEventListener("abort", () => {
          aborted = true
        })
        entered.release()
        await unwind.promise
        expect(signal.aborted).toBe(false)
        stopSignal.throwIfAborted()
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

async function continuedChild() {
  const { f, accepted } = await setup()
  let invocations = 0
  const permissions = createPermissionService({ ...f.authority, grants: "required" })
  const host = createExecutionHost({
    ...f.authority,
    permissions,
    async invoke({ run, store }) {
      invocations++
      if (run.run.run_id === accepted.runId)
        await store.transaction((tx) =>
          parkPermissions(
            tx,
            run.run.run_id,
            [
              {
                agentId: "/other#agent",
                interruptId: "effect",
                namespace: ["child"],
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
  cleanups.push(() => host.close())
  await host.tick()
  await host.idle()
  const pending = (await f.snapshot(accepted.threadId)).pending[0]
  if (!pending) throw new Error("Missing exact child permission proposal")
  const resumed = await permissions.respond(f.request(), accepted.threadId, accepted.runId, {
    type: "command",
    id: 1,
    method: "input.respond",
    params: {
      responses: [
        {
          namespace: ["child"],
          interruptId: "effect",
          response: { decision: "once", grant: pending.input.data.b4.grant },
        },
      ],
    },
  })
  return { f, accepted, resumed, host, invocations: () => invocations }
}
function auditedControl(
  f: Awaited<ReturnType<typeof fixture>>,
  onBind?: (store: RuntimeStore | undefined) => Promise<void>,
  policy = f.authority.policy,
) {
  const backend = runtimeStorageRegistration(f.storage),
    open = backend.openThread,
    events: string[] = []
  Object.assign(backend, {
    async openThread(...args: Parameters<typeof open>) {
      events.push("native_bind")
      const store = await open(...args)
      await onBind?.(store)
      return store
    },
  })
  const restore = () => {
    Object.assign(backend, { openThread: open })
  }
  const controller = createExecutionHost({
    ...f.authority,
    policy,
    async authorizeAgent(request, id) {
      events.push(`authorize:${id}`)
      await f.authority.authorizeAgent(request, id)
    },
    async invoke() {
      throw new Error("Exact control must not invoke a provider")
    },
  })
  cleanups.push(
    () => controller.close(),
    async () => restore(),
  )
  return { controller, events, restore }
}

async function retainedChild() {
  const s = await continuedChild()
  await s.host.tick()
  await s.host.idle()
  const generation = (await s.f.snapshot(s.accepted.threadId)).scope.generation
  await s.f.admit(
    body({
      thread_id: s.accepted.threadId,
      on_completion: "delete",
      metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
    }),
  )
  await s.host.tick()
  await s.host.idle()
  expect(
    await runtimeStorageRegistration(s.f.storage).readThread(s.accepted.threadId),
  ).toBeUndefined()
  return { ...s, generation }
}
function auditedRetainedControl(
  f: Awaited<ReturnType<typeof fixture>>,
  beforeRead?: () => Promise<void>,
  afterRead?: () => Promise<void>,
) {
  const policy = f.authority.policy
  const audit = auditedControl(f, undefined, {
    ...policy,
    async fallback(request) {
      if (request.operation === "run.cancel") audit.events.push("thread_gate")
      return policy.fallback(request)
    },
  })
  const temporary = runtimeStorageRegistration(f.storage).temporary
  if (!temporary) throw new Error("Missing actual native retained capability")
  const read = temporary.readRun
  Object.assign(temporary, {
    async readRun(...args: Parameters<typeof read>) {
      audit.events.push("retained_payload_read")
      await beforeRead?.()
      const value = await read(...args)
      await afterRead?.()
      return value
    },
  })
  cleanups.push(async () => {
    Object.assign(temporary, { readRun: read })
  })
  return audit
}
