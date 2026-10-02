import { describe, expect, it } from "vitest"
import { type ClientToolCallRecord, createMemoryClientToolCallStore } from "../src/index.js"

function call(over: Partial<ClientToolCallRecord> = {}): ClientToolCallRecord {
  return {
    threadId: "t1",
    toolCallId: "call_1",
    interruptId: "client-call_1",
    toolName: "openPanel",
    runId: "r1",
    routeId: "/park#agent",
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

  it("listForThread includes answered calls with their result", async () => {
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

  it("does not collide ids containing NUL across threads", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call({ threadId: "a", toolCallId: "b\u0000c" }))
    expect(await store.get("a\u0000b", "c")).toBeUndefined()
    const res = await store.answer({
      threadId: "a\u0000b",
      toolCallId: "c",
      result: "x",
      at: "2026-09-30T00:01:00.000Z",
    })
    expect(res.outcome).toBe("missing")
  })

  it("voidOutstanding with an empty list voids nothing", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    expect(
      await store.voidOutstanding({
        threadId: "t1",
        toolCallIds: [],
        at: "2026-09-30T00:01:00.000Z",
      }),
    ).toBe(0)
    expect((await store.listOutstanding("t1")).length).toBe(1)
  })

  it("never voids an answered row", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    await store.answer({
      threadId: "t1",
      toolCallId: "call_1",
      result: "ok",
      at: "2026-09-30T00:01:00.000Z",
    })
    expect(await store.voidOutstanding({ threadId: "t1", at: "2026-09-30T00:02:00.000Z" })).toBe(0)
    const row = await store.get("t1", "call_1")
    expect(row?.voidedAt).toBeNull()
    expect(row?.answeredAt).toBe("2026-09-30T00:01:00.000Z")
  })

  it("leaves a same-id row on another thread unaffected", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    await store.issue(call({ threadId: "t2" }))
    await store.answer({
      threadId: "t1",
      toolCallId: "call_1",
      result: "ok",
      at: "2026-09-30T00:01:00.000Z",
    })
    expect((await store.get("t2", "call_1"))?.answeredAt).toBeNull()
    await store.voidOutstanding({ threadId: "t1", at: "2026-09-30T00:02:00.000Z" })
    expect((await store.get("t2", "call_1"))?.voidedAt).toBeNull()
    await store.voidOutstanding({ threadId: "t2", at: "2026-09-30T00:03:00.000Z" })
    expect((await store.get("t1", "call_1"))?.voidedAt).toBeNull()
  })

  it("does not let callers mutate stored rows through returned records", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    const got = (await store.get("t1", "call_1")) as { runId: string }
    got.runId = "mutated"
    ;((await store.listForThread("t1"))[0] as { runId: string }).runId = "mutated"
    expect((await store.get("t1", "call_1"))?.runId).toBe("r1")
  })

  describe("prune", () => {
    const BEFORE = "2026-09-30T12:00:00.000Z"

    it("deletes answered and voided rows settled before the cutoff and keeps later ones", async () => {
      const store = createMemoryClientToolCallStore()
      await store.issue(
        call({ toolCallId: "old_answered", answeredAt: "2026-09-30T01:00:00.000Z", result: "ok" }),
      )
      await store.issue(
        call({ toolCallId: "new_answered", answeredAt: "2026-09-30T12:00:00.000Z", result: "ok" }),
      )
      await store.issue(call({ toolCallId: "old_voided", voidedAt: "2026-09-30T01:00:00.000Z" }))
      await store.issue(call({ toolCallId: "new_voided", voidedAt: "2026-09-30T13:00:00.000Z" }))
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect((await store.listForThread("t1")).map((row) => row.toolCallId)).toEqual([
        "new_answered",
        "new_voided",
      ])
    })

    it("a void is the settle time: an old answer with a recent void is kept", async () => {
      const store = createMemoryClientToolCallStore()
      await store.issue(
        call({
          toolCallId: "answered_then_voided",
          answeredAt: "2026-09-30T01:00:00.000Z",
          result: "ok",
          voidedAt: "2026-09-30T13:00:00.000Z",
        }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.get("t1", "answered_then_voided")).toBeDefined()
    })

    it("deletes outstanding rows expired before the cutoff and keeps unexpired or never-expiring ones", async () => {
      const store = createMemoryClientToolCallStore()
      await store.issue(call({ toolCallId: "expired_old", expiresAt: "2026-09-30T00:10:00.000Z" }))
      await store.issue(call({ toolCallId: "expires_at_cutoff", expiresAt: BEFORE }))
      await store.issue(
        call({ toolCallId: "expires_later", expiresAt: "2026-09-30T13:00:00.000Z" }),
      )
      await store.issue(call({ toolCallId: "never_expires", expiresAt: null }))
      expect(await store.prune({ before: BEFORE })).toBe(1)
      expect((await store.listOutstanding("t1")).map((row) => row.toolCallId)).toEqual([
        "expires_at_cutoff",
        "expires_later",
        "never_expires",
      ])
    })

    it("sweeps every thread and is idempotent", async () => {
      const store = createMemoryClientToolCallStore()
      await store.issue(
        call({ threadId: "t1", toolCallId: "a", voidedAt: "2026-09-30T01:00:00.000Z" }),
      )
      await store.issue(
        call({ threadId: "t2", toolCallId: "b", voidedAt: "2026-09-30T01:00:00.000Z" }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.listForThread("t1")).toEqual([])
      expect(await store.listForThread("t2")).toEqual([])
    })
  })
})
