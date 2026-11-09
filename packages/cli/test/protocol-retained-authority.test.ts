import { afterEach, expect, it } from "vitest"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { createPermissionService, parkPermissions } from "../src/lib/runtime/permissions.ts"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

// Real-store integration budget chosen before the first run; older budgets stay unchanged.
const budget = 30_000
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
it.each(["missing", "forged"] as const)(
  "filters revoked canonical child before a %s retained map can admit its Run",
  async (kind) => {
    const s = await scenario()
    s.f.removeAgent("/other#agent")
    await s.f.native.corruptRetainedPermissionAgents(
      s.initial.threadId,
      s.generation,
      s.resumed.runId,
      kind === "missing" ? undefined : ["/chat#agent"],
    )
    const rows = await s.f.search({})
    expect(rows.map((r) => r.run_id)).not.toContain(s.resumed.runId)
    expect(rows.map((r) => r.run_id)).toContain(s.initial.runId)
    expect(rows.map((r) => r.run_id)).toContain(s.successor.runId)
    expect(s.invocations()).toBe(3)
  },
  budget,
)
it.each(["permission-retry", "receipt-lookup"] as const)(
  "authorizes revoked canonical child before full operation read for %s",
  async (kind) => {
    const s = await scenario()
    s.f.removeAgent("/other#agent")
    const temporary = s.backend.temporary
    if (!temporary) throw new Error("Missing actual native temporary capability")
    const read = temporary.readOperation
    let reads = 0
    Object.assign(temporary, {
      readOperation(...args: Parameters<typeof read>) {
        reads++
        return read(...args)
      },
    })
    cleanups.push(async () => {
      Object.assign(temporary, { readOperation: read })
    })
    if (kind === "permission-retry")
      await expect(
        s.permissions.respond(s.f.request(), s.initial.threadId, s.initial.runId, s.command),
      ).rejects.toMatchObject({ code: "not_found" })
    else expect(await s.f.lookup(s.token)).toEqual([])
    expect(reads).toBe(0)
    expect(s.invocations()).toBe(3)
  },
  budget,
)
const paths = ["permission-retry", "receipt-lookup"] as const
for (const path of paths) {
  it.each(["root", "thread"] as const)(
    `denies %s before the full retained operation read for ${path}`,
    async (authority) => {
      const s = await scenario(),
        audit = watch(s)
      if (authority === "root") s.f.removeAgent("/chat#agent")
      else s.f.deny()
      await denied(s, path)
      expect(audit.reads()).toBe(0)
    },
    budget,
  )
  it(
    `replays the authorized exact retained operation for ${path}`,
    async () => {
      const s = await scenario(),
        audit = watch(s)
      const result = await operation(s, path)
      if (path === "permission-retry")
        expect(result).toMatchObject({
          runId: s.resumed.runId,
          responseMeta: { b4: { receipt: { replayed: true } } },
        })
      else expect(result).toMatchObject([{ run_id: s.resumed.runId }])
      expect(audit.reads()).toBe(1)
      expect(s.invocations()).toBe(3)
    },
    budget,
  )
  it.each(["root", "child", "thread"] as const)(
    `reauthorizes current %s policy after the full retained operation read for ${path}`,
    async (authority) => {
      const s = await scenario(),
        audit = watch(s, undefined, async () => {
          if (authority === "thread") s.f.deny()
          else s.f.removeAgent(authority === "root" ? "/chat#agent" : "/other#agent")
        })
      await denied(s, path)
      expect(audit.reads()).toBe(1)
    },
    budget,
  )
  it.each(["missing", "unknown-method", "missing-agents", "duplicate-agents"] as const)(
    `fails closed before payload on %s minimal operation authority for ${path}`,
    async (fault) => {
      const s = await scenario(),
        audit = watch(s),
        search = s.backend.searchOperations
      Object.assign(s.backend, {
        async searchOperations(...args: Parameters<typeof search>) {
          return (await search(...args)).map((row) => {
            if (row.operationAuthority.runId !== s.resumed.runId) return row
            const bad = { ...row.operationAuthority }
            if (fault === "unknown-method") bad.method = "state.fork"
            if (fault === "missing-agents") bad.permissionAgents = null
            if (fault === "duplicate-agents")
              bad.permissionAgents = ["/other#agent", "/other#agent"]
            const altered = { ...row, operationAuthority: bad }
            if (fault === "missing") Reflect.deleteProperty(altered, "operationAuthority")
            return altered
          })
        },
      })
      cleanups.push(async () => {
        Object.assign(s.backend, { searchOperations: search })
      })
      await expect(operation(s, path)).rejects.toMatchObject({ code: "storage_unavailable" })
      expect(audit.reads()).toBe(0)
      // Invalid private facts never disclose a diagnostic to a denied Thread.
      s.f.deny()
      await denied(s, path)
      expect(audit.reads()).toBe(0)
    },
    budget,
  )
  it.each(["missing", "forged"] as const)(
    `denies revoked canonical child before secondary %s map diagnostics for ${path}`,
    async (fault) => {
      const s = await scenario(),
        audit = watch(s)
      await s.f.native.corruptRetainedPermissionAgents(
        s.initial.threadId,
        s.generation,
        s.resumed.runId,
        fault === "missing" ? undefined : ["/chat#agent"],
      )
      s.f.removeAgent("/other#agent")
      await denied(s, path)
      expect(audit.reads()).toBe(0)
    },
    budget,
  )
  it(
    `reauthorizes actual receipt child before secondary mismatch diagnostics for ${path}`,
    async () => {
      const s = await scenario(),
        audit = watch(s, async () => {
          await s.f.native.alterRetainedOperation(
            s.initial.threadId,
            s.generation,
            s.resumed.runId,
            ["/changed#agent"],
          )
          s.f.removeAgent("/changed#agent")
        })
      await denied(s, path)
      expect(audit.reads()).toBe(1)
    },
    budget,
  )
  it.each(["map", "subject-id", "lineage", "provenance"] as const)(
    `rechecks actual retained %s after the full-read gate for ${path}`,
    async (fault) => {
      const s = await scenario(),
        origin = crypto.randomUUID(),
        audit = watch(s, async () => {
          if (fault === "map")
            await s.f.native.corruptRetainedPermissionAgents(
              s.initial.threadId,
              s.generation,
              s.resumed.runId,
              undefined,
            )
          else
            await s.f.native.corruptRetainedControlFacts(
              s.initial.threadId,
              s.generation,
              s.resumed.runId,
              fault === "provenance" ? "subject-provenance" : fault,
              fault === "provenance" ? origin : crypto.randomUUID(),
            )
        })
      s.f.revokeOrigin(origin)
      if (fault === "subject-id" || fault === "provenance") await denied(s, path)
      else await expect(operation(s, path)).rejects.toMatchObject({ code: "storage_unavailable" })
      expect(audit.reads()).toBe(1)
    },
    budget,
  )
  it(
    `rechecks child authority on a real live-to-retained transition for ${path}`,
    async () => {
      const s = await scenario(false),
        audit = watch(s),
        open = s.backend.openThread
      let transitioned = false
      Object.assign(s.backend, {
        async openThread(...args: Parameters<typeof open>) {
          if (!transitioned && args[0] === s.initial.threadId) {
            transitioned = true
            await s.host.tick()
            await s.host.idle()
            s.f.removeAgent("/other#agent")
          }
          return open(...args)
        },
      })
      cleanups.push(async () => {
        Object.assign(s.backend, { openThread: open })
      })
      await denied(s, path)
      expect(transitioned).toBe(true)
      expect(audit.reads()).toBe(0)
      expect(s.invocations()).toBe(3)
    },
    budget,
  )
  it(
    `authorizes canonical operation even after its independent Run is gone for ${path}`,
    async () => {
      const s = await scenario(),
        audit = watch(s)
      await s.f.native.removeRetainedRun(s.initial.threadId, s.generation, s.resumed.runId)
      await expect(operation(s, path)).rejects.toMatchObject({ code: "submission_target_gone" })
      expect(audit.reads()).toBe(1)
      s.f.removeAgent("/other#agent")
      await denied(s, path)
      expect(audit.reads()).toBe(1)
    },
    budget,
  )
}
it.each(["initial-retry", "initial-lookup"] as const)(
  "replays retained canonical run.create for %s",
  async (path) => {
    const s = await scenario(),
      audit = watch(s)
    if (path === "initial-retry")
      expect(await s.f.admit(body({ on_completion: "keep" }))).toMatchObject({
        runId: s.initial.runId,
        responseMeta: { b4: { receipt: { replayed: true } } },
      })
    else
      expect(await s.f.lookup(s.initial.responseMeta.b4.receipt.submissionId)).toMatchObject([
        { run_id: s.initial.runId },
      ])
    expect(audit.reads()).toBe(1)
    expect(s.invocations()).toBe(3)
  },
  budget,
)
it(
  "retains canonical initial/continuation rows and authorizes before global windows",
  async () => {
    const s = await scenario()
    expect((await s.f.search({})).map((r) => r.run_id).sort()).toEqual(
      [s.initial.runId, s.resumed.runId, s.successor.runId].sort(),
    )
    s.f.removeAgent("/other#agent")
    const allowed = await s.f.search({}),
      page = await s.f.search({}, { offset: 0, limit: 1 })
    expect(allowed.map((r) => r.run_id)).not.toContain(s.resumed.runId)
    expect(page).toEqual(allowed.slice(0, 1))
    expect(await s.f.search({}, { status: "success", thread_id: s.initial.threadId })).toEqual(
      allowed.filter((r) => r.status === "success"),
    )
  },
  budget,
)
it.each(["missing", "forged"] as const)(
  "refuses %s stored search map for an otherwise authorized canonical child",
  async (fault) => {
    const s = await scenario()
    await s.f.native.corruptRetainedPermissionAgents(
      s.initial.threadId,
      s.generation,
      s.resumed.runId,
      fault === "missing" ? undefined : ["/chat#agent"],
    )
    await expect(s.f.search({})).rejects.toMatchObject({ code: "storage_unavailable" })
    s.f.deny()
    expect(await s.f.search({})).toEqual([])
  },
  budget,
)
function operation(s: Awaited<ReturnType<typeof scenario>>, path: (typeof paths)[number]) {
  return path === "permission-retry"
    ? s.permissions.respond(s.f.request(), s.initial.threadId, s.initial.runId, s.command)
    : s.f.lookup(s.token)
}
async function denied(s: Awaited<ReturnType<typeof scenario>>, path: (typeof paths)[number]) {
  if (path === "permission-retry")
    await expect(operation(s, path)).rejects.toMatchObject({ code: "not_found" })
  else expect(await operation(s, path)).toEqual([])
}
function watch(
  s: Awaited<ReturnType<typeof scenario>>,
  before?: () => Promise<void>,
  after?: () => Promise<void>,
) {
  const temporary = s.backend.temporary
  if (!temporary) throw new Error("Missing actual temporary capability")
  const read = temporary.readOperation
  let reads = 0
  Object.assign(temporary, {
    async readOperation(...args: Parameters<typeof read>) {
      reads++
      await before?.()
      const actual = await read(...args)
      await after?.()
      return actual
    },
  })
  cleanups.push(async () => {
    Object.assign(temporary, { readOperation: read })
  })
  return { reads: () => reads }
}
async function scenario(cleanup = true) {
  const f = await fixture()
  cleanups.push(() => f.close())
  const initial = await f.admit(body({ on_completion: "keep" }))
  let invocations = 0
  const permissions = createPermissionService({ ...f.authority, grants: "required" })
  const host = createExecutionHost({
    ...f.authority,
    permissions,
    async invoke({ run, store }) {
      invocations++
      if (run.run.run_id === initial.runId)
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
      return { values: { protectedResult: "child-result" } }
    },
  })
  cleanups.push(() => host.close())
  await host.tick()
  await host.idle()
  const pending = (await f.snapshot(initial.threadId)).pending[0]
  if (!pending) throw new Error("Missing actual child proposal")
  const token = crypto.randomUUID(),
    command = {
      type: "command",
      id: 1,
      method: "input.respond",
      params: {
        metadata: { b4: { v: 1, submissionId: token } },
        responses: [
          {
            namespace: ["child"],
            interruptId: "effect",
            response: { decision: "once", grant: pending.input.data.b4.grant },
          },
        ],
      },
    }
  const resumed = await permissions.respond(f.request(), initial.threadId, initial.runId, command)
  await host.tick()
  await host.idle()
  const generation = (await f.snapshot(initial.threadId)).scope.generation
  const successor = await f.admit(
    body({
      thread_id: initial.threadId,
      on_completion: "delete",
      metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
    }),
  )
  if (cleanup) {
    await host.tick()
    await host.idle()
  }
  const backend = runtimeStorageRegistration(f.storage)
  if (cleanup) expect(await backend.readThread(initial.threadId)).toBeUndefined()
  return {
    f,
    initial,
    resumed,
    successor,
    command,
    token,
    generation,
    backend,
    permissions,
    host,
    invocations: () => invocations,
  }
}
