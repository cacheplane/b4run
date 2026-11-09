import { afterEach, describe, expect, it } from "vitest"
import { body, fixture as makeFixture, threadId, token } from "./fixtures/protocol-admission.ts"

function required<T>(value: T | undefined): T {
  expect(value).toBeDefined()
  if (value === undefined) throw new Error("Required fixture record is absent")
  return value
}
const fixtures: Awaited<ReturnType<typeof makeFixture>>[] = []
afterEach(async () => {
  for (const value of fixtures.splice(0)) await value.close()
})
async function setup() {
  const f = await makeFixture()
  fixtures.push(f)
  return { f, body, token, threadId }
}
describe("durable protocol admission", () => {
  it("recovers accepted identity after a lost acknowledgement without another user message", async () => {
    const { f, body, token } = await setup()
    const first = await f.admit(body())
    f.loseNextAcknowledgement()
    await expect(f.admit(body())).rejects.toThrow("lost-afterCommit")
    const recovered = await f.admit(body())
    expect(recovered.runId).toBe(first.runId)
    expect(recovered.responseMeta.b4.receipt.replayed).toBe(true)
    const snapshot = await f.snapshot(first.threadId)
    expect(snapshot.runs.filter((row) => row.metadata.submissionId === token)).toHaveLength(1)
    expect(snapshot.thread?.thread.messages).toHaveLength(1)
    expect(snapshot.inbox.filter((row) => row.kind === "dispatch")).toHaveLength(1)
    expect((await f.lookup())[0]?.metadata.b4).toMatchObject({ lookup: { state: "accepted" } })
  })
  it("serializes concurrent omitted-thread retries to one Run, root, dispatch and message", async () => {
    const { f } = await setup()
    const values = await Promise.all(Array.from({ length: 8 }, () => f.admit()))
    expect(new Set(values.map((value) => value.runId)).size).toBe(1)
    const snapshot = await f.snapshot(required(values[0]).threadId)
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.inbox).toHaveLength(1)
    expect(snapshot.thread?.thread.messages).toHaveLength(1)
    expect(snapshot.runs[0]?.metadata.turnId).toBe(values[0]?.runId)
  })
  it.each(["before", "after"] as const)(
    "fails %s commit with zero or one accepted row and retries safely",
    async (point) => {
      const { f } = await setup()
      if (point === "before") f.failBeforeCommit()
      else f.loseNextAcknowledgement()
      await expect(f.admit()).rejects.toThrow(`lost-${point}Commit`)
      expect(await f.lookup()).toHaveLength(point === "before" ? 0 : 1)
      const accepted = await f.admit()
      const snapshot = await f.snapshot(accepted.threadId)
      expect(snapshot.runs).toHaveLength(1)
      expect(snapshot.receipts).toHaveLength(1)
      expect(snapshot.thread?.thread.messages).toHaveLength(1)
    },
  )
  it("uses original resolved defaults and input after catalog/schema/current-head changes", async () => {
    const { f } = await setup()
    const first = await f.admit()
    await (await f.store(first.threadId)).transaction(async (tx) => {
      const row = required(await tx.thread.get())
      await tx.thread.put({
        ...row,
        pausedGeneration: "10000000-0000-4000-8000-000000000099",
        revision: row.revision + 1,
      })
    })
    f.defaultAgent("/changed#agent")
    f.parser(() => {
      throw new Error("changed schema")
    })
    expect((await f.admit()).runId).toBe(first.runId)
    expect((await f.snapshot(first.threadId)).runs[0]?.run.agent_id).toBe("/chat#agent")
  })
  it("rejects changed input under a token but ignores object key order", async () => {
    const { f, body } = await setup()
    const first = await f.admit(body({ input: { a: 1, b: 2 } }))
    expect((await f.admit(body({ input: { b: 2, a: 1 } }))).runId).toBe(first.runId)
    await expect(f.admit(body({ input: { a: 2, b: 2 } }))).rejects.toMatchObject({
      code: "submission_conflict",
    })
    expect((await f.snapshot(first.threadId)).runs).toHaveLength(1)
  })
  it("does not reuse a token across principal scopes", async () => {
    const { f } = await setup()
    const first = await f.admit()
    const second = await f.admit(undefined, "bob")
    expect(first.runId).not.toBe(second.runId)
    expect(first.threadId).not.toBe(second.threadId)
  })
  it("requires explicit create for a missing provided Thread", async () => {
    const { f, body, threadId } = await setup()
    await expect(f.admit(body({ thread_id: threadId }))).rejects.toMatchObject({
      code: "not_found",
    })
    const result = await f.admit(body({ thread_id: threadId, if_not_exists: "create" }))
    expect(result.threadId).toBe(threadId)
    expect((await f.snapshot(threadId)).runs[0]?.run.on_completion).toBe("keep")
  })
  it("validates expected scope only for new operations", async () => {
    const { f, body } = await setup()
    const result = await f.admit()
    await expect(
      f.admit(
        body({
          thread_id: result.threadId,
          metadata: {
            b4: {
              v: 1,
              submissionId: "10000000-0000-4000-8000-000000000020",
              expected: { generation: "10000000-0000-4000-8000-000000000099" },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "stale_generation" })
    expect((await f.snapshot(result.threadId)).runs).toHaveLength(1)
  })
  it("reauthorizes an exact retry before disclosing its receipt", async () => {
    const { f } = await setup()
    const first = await f.admit()
    f.deny()
    await expect(f.admit()).rejects.toMatchObject({ code: "not_found" })
    expect((await f.snapshot(first.threadId)).runs).toHaveLength(1)
  })
  it("rejects protected config and unsupported webhook before any acceptance", async () => {
    const { f, body } = await setup()
    await expect(
      f.admit(body({ config: { configurable: { principal: "forged" } } })),
    ).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(f.admit(body({ webhook: "https://example.com" }))).rejects.toMatchObject({
      code: "not_supported",
    })
    expect(await f.lookup()).toEqual([])
  })
})

describe("runtime storage boot registration", () => {
  it("closes an installation if a factory attempts a second registration", async () => {
    const { createRuntimeStorageHost } = await import("../src/lib/runtime/storage-host.ts")
    let closed = 0
    const backend = {
      installationId: "test-installation",
      close() {
        closed++
      },
      async readThread() {
        return undefined
      },
      async listThreads() {
        return []
      },
      async searchOperations() {
        return []
      },
      async openThread() {
        return undefined
      },
    }
    await expect(
      createRuntimeStorageHost((register) => {
        register(backend)
        return register(backend)
      }),
    ).rejects.toThrow("exactly once")
    expect(closed).toBe(1)
  })
  it("rejects forged host shapes and closed installations", async () => {
    const { runtimeStorageRegistration } = await import("../src/lib/runtime/storage-host.ts")
    expect(() =>
      runtimeStorageRegistration({ installationId: "forged", close: async () => {} }),
    ).toThrow("unrecognized")
    const { f } = await setup()
    await f.storage.close()
    expect(() => runtimeStorageRegistration(f.storage)).toThrow("unrecognized")
  })
  it("cannot replay a contextless production receipt", async () => {
    const { f } = await setup()
    const accepted = await f.admit()
    const record = required((await f.snapshot(accepted.threadId)).receipts[0])
    const { operation: _private, ...contextless } = record
    await f.seedReceipt(accepted.threadId, contextless)
    await expect(f.admit()).rejects.toMatchObject({ code: "receipt_expired" })
    expect((await f.snapshot(accepted.threadId)).runs).toHaveLength(1)
  })
})

describe("receipt route authority", () => {
  it("replays under an invalid current default using original authorized Agent", async () => {
    const { f } = await setup()
    const first = await f.admit()
    f.defaultAgent("/missing#agent")
    expect((await f.admit()).runId).toBe(first.runId)
  })
  it("conceals receipts when the original Agent is removed or denied", async () => {
    const { f } = await setup()
    await f.admit()
    f.removeOriginalAgent()
    await expect(f.admit()).rejects.toMatchObject({ code: "not_found" })
    expect(await f.lookup()).toEqual([])
  })
})

it("binds only a real boot-created service to a request and never replaces it", async () => {
  const { f } = await setup()
  const helpers = await import("../src/lib/dev/request-run-admission.ts")
  expect(helpers).toHaveProperty("bindRequestProtocolAdmission")
  const request = f.request()
  expect(() => helpers.bindRequestProtocolAdmission(request, { ...f.service })).toThrow(
    "Unrecognized",
  )
  helpers.bindRequestProtocolAdmission(request, f.service)
  expect(helpers.requestProtocolAdmission(request)).toBe(f.service)
  expect(() => helpers.bindRequestProtocolAdmission(request, { ...f.service })).toThrow()
})

it("excludes transport command IDs and trace IDs from an exact operation fingerprint", async () => {
  const { f, body } = await setup()
  const first = await f.admit(body({ id: 1, trace_id: "first" }))
  expect((await f.admit(body({ id: 2, trace_id: "retry" }))).runId).toBe(first.runId)
})
it("does not create a second token identity when an omitted Thread becomes explicit", async () => {
  const { f, body } = await setup()
  const accepted = await f.admit()
  expect((await f.admit(body({ thread_id: accepted.threadId }))).runId).toBe(accepted.runId)
  await expect(
    f.admit(body({ thread_id: accepted.threadId, on_completion: "keep" })),
  ).rejects.toMatchObject({ code: "submission_conflict" })
  expect((await f.snapshot(accepted.threadId)).runs).toHaveLength(1)
})

it("maps route input schema rejection to invalid_argument without accepting work", async () => {
  const { f } = await setup()
  f.parser(() => {
    throw new Error("private parser detail")
  })
  await expect(f.admit()).rejects.toMatchObject({ code: "invalid_argument" })
  expect(await f.lookup()).toEqual([])
})

it.each(["catalog", "resolution"] as const)(
  "recovers a receipt committed while a concurrent retry is resolving %s",
  async (phase) => {
    const { f } = await setup()
    const barrier = f.pauseNext(phase)
    const delayed = f.admit()
    await barrier.entered
    const winner = await f.admit()
    if (phase === "catalog") f.defaultAgent("/missing#agent")
    else
      f.parser(() => {
        throw new Error("schema changed after acceptance")
      })
    barrier.release()
    expect((await delayed).runId).toBe(winner.runId)
    expect((await f.snapshot(winner.threadId)).runs).toHaveLength(1)
  },
)
it("preserves messages that omit IDs across exact retries", async () => {
  const { f, body } = await setup()
  const request = body({ input: { messages: [{ role: "user", content: "no ID" }] } })
  const accepted = await f.admit(request)
  expect((await f.admit(request)).runId).toBe(accepted.runId)
  expect((await f.snapshot(accepted.threadId)).thread?.thread.messages).toEqual([
    { role: "user", content: "no ID" },
  ])
})

it("keeps opaque business input.messages outside the public message projection", async () => {
  const { f, body } = await setup()
  f.declareMessages(false)
  const input = { messages: [{ kind: "business", count: 1 }] }
  const accepted = await f.admit(body({ input }))
  const snapshot = await f.snapshot(accepted.threadId)
  expect(snapshot.runs[0]?.run.input).toEqual(input)
  expect(snapshot.thread?.thread.messages).toEqual([])
})

it("reconciles C3-equivalent message IDs instead of comparing raw message arrays", async () => {
  const { f, body } = await setup()
  const message = { id: "user-1", role: "user", content: "hello" }
  const first = await f.admit(body({ input: { messages: [message] } }))
  f.parser(() => {
    throw new Error("current schema must not run")
  })
  const replay = await f.admit(body({ input: { messages: [message, message] } }))
  expect(replay.runId).toBe(first.runId)
  expect((await f.admit(body({ input: {}, messages: [message] }))).runId).toBe(first.runId)
  expect(f.resolutionCount()).toBe(1)
  const snapshot = await f.snapshot(first.threadId)
  expect(snapshot.runs).toHaveLength(1)
  expect(snapshot.thread?.thread.messages).toHaveLength(1)
  await expect(
    f.admit(body({ input: { messages: [{ ...message, content: "changed" }] } })),
  ).rejects.toMatchObject({ code: "submission_conflict" })
})
it.each([{ temperature: 0.5 }, { configurable: { temperature: 0.5 } }])(
  "reconciles explicit ORIGINAL resolved config defaults %j",
  async (defaults) => {
    const { f, body } = await setup()
    f.originalConfigDefaults(defaults)
    const first = await f.admit()
    f.originalConfigDefaults({ temperature: 0.9 })
    f.defaultAgent("/missing#agent")
    expect((await f.admit(body({ config: defaults }))).runId).toBe(first.runId)
    expect(f.resolutionCount()).toBe(1)
    await expect(f.admit(body({ config: { temperature: 0.8 } }))).rejects.toMatchObject({
      code: "submission_conflict",
    })
  },
)
it("retains explicit nondefault mechanical intent while reconciling explicit default values", async () => {
  const { f, body } = await setup()
  const first = await f.admit(body({ on_disconnect: "continue" }))
  expect(
    (
      await f.admit(
        body({
          on_disconnect: "continue",
          on_completion: "delete",
          if_not_exists: "reject",
          stream_mode: "values",
        }),
      )
    ).runId,
  ).toBe(first.runId)
  await expect(f.admit()).rejects.toMatchObject({ code: "submission_conflict" })
})
it("normalizes nonobject input/messages identity without replaying its custom combiner", async () => {
  const { f, body } = await setup()
  let combines = 0
  f.combineMessages((input, messages) => {
    combines++
    return { business: input, messages }
  })
  const message = { id: "user-1", role: "user", content: "hello" }
  const first = await f.admit(body({ input: "literal", messages: [message] }))
  expect((await f.admit(body({ input: "literal", messages: [message, message] }))).runId).toBe(
    first.runId,
  )
  expect(combines).toBe(1)
  await expect(
    f.admit(body({ input: { input: "literal" }, messages: [message] })),
  ).rejects.toMatchObject({ code: "submission_conflict" })
})
it("preserves opaque business arrays and their order during receipt comparison", async () => {
  const { f, body } = await setup()
  f.declareMessages(false)
  const first = await f.admit(body({ input: ["first", "second"] }))
  expect((await f.admit(body({ input: ["first", "second"] }))).runId).toBe(first.runId)
  await expect(f.admit(body({ input: ["second", "first"] }))).rejects.toMatchObject({
    code: "submission_conflict",
  })
})

it("captures pure identity before a new-operation parser mutates its execution input", async () => {
  const { f, body } = await setup()
  f.parser((value) => {
    const execution = value as Record<string, unknown>
    execution.question = "execution"
    return execution
  })
  const first = await f.admit(body({ input: { question: "wire" } }))
  expect((await f.snapshot(first.threadId)).runs[0]?.run.input).toMatchObject({
    question: "execution",
  })
  expect((await f.admit(body({ input: { question: "wire" } }))).runId).toBe(first.runId)
  expect(f.resolutionCount()).toBe(1)
})
it("fails closed for an old private receipt context without normalization facts", async () => {
  const { f } = await setup()
  const first = await f.admit()
  const row = required((await f.snapshot(first.threadId)).receipts[0])
  const { normalization: _facts, ...oldContext } = required(row.operation)
  await f.seedReceipt(first.threadId, {
    ...row,
    operation: oldContext as NonNullable<typeof row.operation>,
  })
  await expect(f.admit()).rejects.toMatchObject({ code: "receipt_expired" })
  expect((await f.snapshot(first.threadId)).runs).toHaveLength(1)
})
