import { expect, it } from "vitest"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { createPermissionService, parkPermissions } from "../src/lib/runtime/permissions.ts"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, sharedPermissionFixtures } from "./fixtures/protocol-admission.ts"

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing current permission fixture fact")
  return value
}
const fixtures = sharedPermissionFixtures({ onCompletion: "keep" })
it("isolates new logical boot admission after closing one host over the real shared installation", async () => {
  const first = await fixtures.create(),
    initial = await first.admit()
  const host = createExecutionHost({ ...first.authority, invoke: async () => ({}) })
  first.ownHost(host)
  await host.close()
  const next = body({
    thread_id: initial.threadId,
    if_not_exists: "create",
    on_completion: "keep",
    metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
  })
  await expect(first.admit(next)).rejects.toMatchObject({ code: "storage_unavailable" })
  const second = await fixtures.create()
  expect((await second.admit()).runId).toEqual(expect.any(String))
  await expect(first.admit(next)).rejects.toMatchObject({ code: "storage_unavailable" })
}, 30_000)

async function scenario(namespaces: readonly (readonly string[])[], pauses = 1) {
  const f = await fixtures.create()
  const initial = await f.admit()
  let fail = false,
    invocations = 0,
    effects = 0
  const permissions = createPermissionService({
    ...f.authority,
    grants: "required",
    failpoint(point) {
      if (point === "afterConsume" && fail) {
        fail = false
        throw new Error("injected-current-batch-consume")
      }
    },
  })
  const host = createExecutionHost({
    storage: f.storage,
    permissions,
    async invoke({ run, store }) {
      if (++invocations <= pauses)
        await store.transaction((tx) =>
          parkPermissions(
            tx,
            run.run.run_id,
            namespaces.map((namespace) => ({
              interruptId: "namespace-local-id",
              namespace,
              request: { kind: "tool", detail: { toolName: "effect", suggestedPattern: "effect" } },
              protectedProposal: { runId: run.run.run_id, namespace },
            })),
            "required",
          ),
        )
      else effects++
      return {}
    },
  })
  f.ownHost(host)
  async function drive() {
    await host.tick()
    await host.idle()
  }
  async function command(runId: string) {
    const snapshot = await f.snapshot(initial.threadId)
    const responses = snapshot.pending
      .filter((p) => p.disposition === "pending")
      .map((p) => ({
        namespace: p.namespace,
        interruptId: p.input.data.interruptId,
        response: { decision: "once", grant: required(p.input.data.b4.grant) },
      }))
    return {
      id: 1,
      method: "input.respond",
      params: {
        responses,
        metadata: {
          b4: {
            v: 1,
            submissionId: crypto.randomUUID(),
            expected: {
              generation: snapshot.scope.generation,
              runId,
              pausedGeneration: required(snapshot.thread?.pausedGeneration),
            },
          },
        },
      },
    }
  }
  const respond = (runId: string, body: Awaited<ReturnType<typeof command>>) =>
    f.trackWork("permission", () => permissions.respond(f.request(), initial.threadId, runId, body))
  await drive()
  return {
    f,
    initial,
    host,
    drive,
    command,
    respond,
    effects: () => effects,
    failAfterConsume() {
      fail = true
    },
  }
}

it("accepts equal public interrupt IDs at distinct namespaces atomically without crossing their grants", async () => {
  const s = await scenario([[], ["delegate", "child"]])
  const parked = await s.f.snapshot(s.initial.threadId)
  expect(parked.pending).toHaveLength(2)
  expect(parked.grants).toHaveLength(2)
  const command = await s.command(s.initial.runId)
  const swapped = {
    ...command,
    params: {
      ...command.params,
      responses: command.params.responses.map((answer, i) => ({
        ...answer,
        response: {
          ...answer.response,
          grant: required(command.params.responses[1 - i]).response.grant,
        },
      })),
    },
  }
  await expect(s.respond(s.initial.runId, swapped)).rejects.toMatchObject({ code: "grant_invalid" })
  const missing = {
    ...command,
    params: { ...command.params, responses: command.params.responses.slice(0, 1) },
  }
  await expect(s.respond(s.initial.runId, missing)).rejects.toMatchObject({
    code: "incomplete_responses",
  })
  s.failAfterConsume()
  await expect(s.respond(s.initial.runId, command)).rejects.toThrow(
    "injected-current-batch-consume",
  )
  const failed = await s.f.snapshot(s.initial.threadId)
  expect(failed.grants).toEqual(parked.grants)
  expect(failed.pending).toEqual(parked.pending)
  expect(failed.runs).toHaveLength(1)
  expect(failed.receipts).toHaveLength(1)
  await s.drive()
  expect(s.effects()).toBe(0)
  const accepted = await s.respond(s.initial.runId, command)
  expect(
    (
      await s.respond(s.initial.runId, {
        ...command,
        params: { ...command.params, responses: [...command.params.responses].reverse() },
      })
    ).runId,
  ).toBe(accepted.runId)
  await s.drive()
  expect(s.effects()).toBe(1)
  expect(
    (await s.f.snapshot(s.initial.threadId)).grants.every(
      (g) => g.consumedByRunId === accepted.runId,
    ),
  ).toBe(true)
})

it("retains historical consumed grants while a later pause reuses the same namespace and interrupt ID", async () => {
  const s = await scenario([[]], 2)
  const firstCommand = await s.command(s.initial.runId)
  const first = await s.respond(s.initial.runId, firstCommand)
  const history = (await s.f.snapshot(s.initial.threadId)).grants
  await s.drive()
  const secondPause = await s.f.snapshot(s.initial.threadId)
  expect(secondPause.pending).toHaveLength(2)
  expect(secondPause.grants).toHaveLength(2)
  expect(secondPause.grants.filter((g) => g.consumedByRunId === null)).toHaveLength(1)
  expect(secondPause.grants.find((g) => g.grantId === required(history[0]).grantId)).toEqual(
    history[0],
  )
  expect((await s.respond(s.initial.runId, firstCommand)).runId).toBe(first.runId)
  const command = await s.command(first.runId)
  const oldToken = {
    ...command,
    params: {
      ...command.params,
      responses: command.params.responses.map((a) => ({
        ...a,
        response: required(firstCommand.params.responses[0]).response,
      })),
    },
  }
  await expect(s.respond(first.runId, oldToken)).rejects.toMatchObject({ code: "grant_invalid" })
  const wrongNamespace = {
    ...command,
    params: {
      ...command.params,
      responses: command.params.responses.map((a) => ({ ...a, namespace: ["other"] })),
    },
  }
  await expect(s.respond(first.runId, wrongNamespace)).rejects.toMatchObject({
    code: "incomplete_responses",
  })
  expect((await s.f.snapshot(s.initial.threadId)).grants).toEqual(secondPause.grants)
  expect(s.effects()).toBe(0)
  const second = await s.respond(first.runId, command)
  expect((await s.respond(first.runId, command)).runId).toBe(second.runId)
  await s.drive()
  expect(s.effects()).toBe(1)
  const final = await s.f.snapshot(s.initial.threadId)
  expect(final.grants).toHaveLength(2)
  expect(final.pending).toHaveLength(2)
  expect(final.grants.find((g) => g.grantId === required(history[0]).grantId)).toEqual(history[0])
})

it("rejects a genuinely duplicate current namespace and interrupt address before parking", async () => {
  const s = await scenario([[], []])
  const snapshot = await s.f.snapshot(s.initial.threadId)
  expect(snapshot.pending).toEqual([])
  expect(snapshot.grants).toEqual([])
  expect(snapshot.runs).toHaveLength(1)
  expect(snapshot.runs[0]?.metadata.reason).toBe("execution_error")
  expect(s.effects()).toBe(0)
})

// Multiple scopes, concurrent requests and native FK teardown share a bounded
// integration budget; the permission behavior tests retain their existing budgets.
it("removes only drained owned test scopes before the next scenario can see or execute them", async () => {
  const first = await scenario([[]]),
    second = await scenario([[]])
  const physicalHooks = runtimeStorageRegistration(first.f.storage)
  expect(first.f.storage).not.toBe(second.f.storage)
  expect(first.f.storage.installationId).toBe(second.f.storage.installationId)
  expect(runtimeStorageRegistration(first.f.storage).openThread).toBe(
    runtimeStorageRegistration(second.f.storage).openThread,
  )
  expect(runtimeStorageRegistration(first.f.storage).execution).toBe(
    runtimeStorageRegistration(second.f.storage).execution,
  )
  const firstCommand = await first.command(first.initial.runId)
  const secondCommand = await second.command(second.initial.runId)
  const foreign = {
    ...secondCommand,
    params: {
      ...secondCommand.params,
      responses: secondCommand.params.responses.map((answer) => ({
        ...answer,
        response: {
          ...answer.response,
          grant: required(firstCommand.params.responses[0]).response.grant,
        },
      })),
    },
  }
  const [accepted] = await Promise.all([
    first.respond(first.initial.runId, firstCommand),
    expect(second.respond(second.initial.runId, foreign)).rejects.toMatchObject({
      code: "grant_invalid",
    }),
  ])
  expect(
    (await second.f.snapshot(second.initial.threadId)).grants.every(
      (grant) => grant.consumedByRunId === null,
    ),
  ).toBe(true)
  expect((await fixtures.candidates())?.includes(first.initial.threadId)).toBe(true)
  expect((await first.f.search({})).map((row) => row.run_id)).toEqual(
    expect.arrayContaining([first.initial.runId, second.initial.runId, accepted.runId]),
  )
  await fixtures.reset()
  expect(await fixtures.candidates()).toEqual([])
  expect(first.effects()).toBe(0)
  expect(second.effects()).toBe(0)
  const fresh = await fixtures.create()
  const freshRun = await fresh.admit()
  expect(fresh.storage).not.toBe(first.f.storage)
  expect(fresh.storage.installationId).toBe(first.f.storage.installationId)
  expect(runtimeStorageRegistration(fresh.storage).openThread).toBe(physicalHooks.openThread)
  expect(runtimeStorageRegistration(fresh.storage).execution).toBe(physicalHooks.execution)
  expect((await fresh.search({})).map((row) => row.run_id)).toEqual([freshRun.runId])
  expect(await fixtures.candidates()).toEqual([freshRun.threadId])
  expect(first.effects()).toBe(0)
  expect(second.effects()).toBe(0)
}, 15_000)
