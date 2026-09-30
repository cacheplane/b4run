import { describe, expect, it } from "vitest"
import { type ClientToolCallRecord, createMemoryClientToolCallStore } from "../src/index.js"

function call(over: Partial<ClientToolCallRecord> = {}): ClientToolCallRecord {
  return {
    threadId: "t1",
    toolCallId: "call_1",
    interruptId: "client-call_1",
    toolName: "openPanel",
    runId: "r1",
    issuedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2026-09-30T00:10:00.000Z",
    answeredAt: null,
    result: null,
    voidedAt: null,
    ...over,
  }
}

describe("createMemoryClientToolCallStore", () => {
  it("issues once and treats a replayed issue as a no-op", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    await store.issue(call({ runId: "r2" }))
    expect((await store.get("t1", "call_1"))?.runId).toBe("r1")
  })

  it("answers exactly once and keeps the result", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    const first = await store.answer({
      threadId: "t1",
      toolCallId: "call_1",
      result: "ok",
      at: "2026-09-30T00:01:00.000Z",
    })
    expect(first.outcome).toBe("answered")
    const second = await store.answer({
      threadId: "t1",
      toolCallId: "call_1",
      result: "again",
      at: "2026-09-30T00:02:00.000Z",
    })
    expect(second.outcome).toBe("already_answered")
    expect((await store.get("t1", "call_1"))?.result).toBe("ok")
  })

  it("does not answer across threads, or a voided or missing call", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    expect(
      (
        await store.answer({
          threadId: "t2",
          toolCallId: "call_1",
          result: "x",
          at: "2026-09-30T00:01:00.000Z",
        })
      ).outcome,
    ).toBe("missing")
    await store.voidOutstanding({ threadId: "t1", at: "2026-09-30T00:01:00.000Z" })
    expect(
      (
        await store.answer({
          threadId: "t1",
          toolCallId: "call_1",
          result: "x",
          at: "2026-09-30T00:02:00.000Z",
        })
      ).outcome,
    ).toBe("voided")
  })

  it("lists only outstanding calls and voids only those named", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    await store.issue(call({ toolCallId: "call_2", interruptId: "client-call_2" }))
    await store.issue(call({ toolCallId: "call_3", interruptId: "client-call_3" }))
    await store.answer({
      threadId: "t1",
      toolCallId: "call_3",
      result: "done",
      at: "2026-09-30T00:01:00.000Z",
    })
    expect((await store.listOutstanding("t1")).map((r) => r.toolCallId)).toEqual([
      "call_1",
      "call_2",
    ])
    expect(
      await store.voidOutstanding({
        threadId: "t1",
        toolCallIds: ["call_2"],
        at: "2026-09-30T00:02:00.000Z",
      }),
    ).toBe(1)
    expect((await store.listOutstanding("t1")).map((r) => r.toolCallId)).toEqual(["call_1"])
  })

  it("lists answered-but-unconsumed calls for the resume", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    await store.answer({
      threadId: "t1",
      toolCallId: "call_1",
      result: "ok",
      at: "2026-09-30T00:01:00.000Z",
    })
    expect((await store.listForThread("t1")).map((r) => [r.toolCallId, r.result])).toEqual([
      ["call_1", "ok"],
    ])
  })
})
