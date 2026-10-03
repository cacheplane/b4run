import { describe, expect, it } from "vitest"
import { type ClientToolCallRecord, createMemoryClientToolCallStore } from "../src/index.js"

function call(over: Partial<ClientToolCallRecord> = {}): ClientToolCallRecord {
  return {
    threadId: "t1",
    toolCallId: "call_1",
    kind: "client",
    interruptId: "client-call_1",
    toolName: "openPanel",
    runId: "r1",
    routeId: "/park#agent",
    issuedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2026-09-30T00:10:00.000Z",
    answeredAt: null,
    result: null,
    voidedAt: null,
    settledAt: null,
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
    await store.voidOutstanding({
      threadId: "t1",
      at: "2026-09-30T00:01:00.000Z",
    })
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
    expect(
      await store.voidOutstanding({
        threadId: "t1",
        at: "2026-09-30T00:02:00.000Z",
      }),
    ).toBe(0)
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
    await store.voidOutstanding({
      threadId: "t1",
      at: "2026-09-30T00:02:00.000Z",
    })
    expect((await store.get("t2", "call_1"))?.voidedAt).toBeNull()
    await store.voidOutstanding({
      threadId: "t2",
      at: "2026-09-30T00:03:00.000Z",
    })
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
})

function serverCall(over: Partial<ClientToolCallRecord> = {}): ClientToolCallRecord {
  return {
    threadId: "t1",
    toolCallId: "call_s1",
    kind: "server",
    interruptId: "",
    toolName: "readFile",
    runId: "r1",
    routeId: "/park#agent",
    issuedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: null,
    answeredAt: null,
    result: null,
    voidedAt: null,
    settledAt: null,
    ...over,
  }
}

describe("createMemoryClientToolCallStore — server rows", () => {
  it("settles a server row once; a second settle reports already_settled and keeps the first time", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(serverCall())
    expect(
      await store.settle({
        threadId: "t1",
        toolCallId: "call_s1",
        at: "2026-09-30T00:00:01.000Z",
      }),
    ).toBe("settled")
    expect(
      await store.settle({
        threadId: "t1",
        toolCallId: "call_s1",
        at: "2026-09-30T00:00:02.000Z",
      }),
    ).toBe("already_settled")
    expect((await store.get("t1", "call_s1"))?.settledAt).toBe("2026-09-30T00:00:01.000Z")
  })

  it("settle reports missing for an unknown id and for a client row", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    expect(
      await store.settle({
        threadId: "t1",
        toolCallId: "nope",
        at: "2026-09-30T00:00:01.000Z",
      }),
    ).toBe("missing")
    expect(
      await store.settle({
        threadId: "t1",
        toolCallId: "call_1",
        at: "2026-09-30T00:00:01.000Z",
      }),
    ).toBe("missing")
    expect((await store.get("t1", "call_1"))?.settledAt).toBeNull()
  })

  it("listOutstanding returns open client rows only; listForThread returns both kinds", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    await store.issue(serverCall())
    expect((await store.listOutstanding("t1")).map((r) => r.toolCallId)).toEqual(["call_1"])
    expect((await store.listForThread("t1")).map((r) => r.toolCallId).sort()).toEqual([
      "call_1",
      "call_s1",
    ])
  })

  it("answer and voidOutstanding never touch a server row", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(serverCall())
    expect(
      (
        await store.answer({
          threadId: "t1",
          toolCallId: "call_s1",
          result: "x",
          at: "2026-09-30T00:00:01.000Z",
        })
      ).outcome,
    ).toBe("missing")
    expect(
      await store.voidOutstanding({
        threadId: "t1",
        at: "2026-09-30T00:00:01.000Z",
      }),
    ).toBe(0)
    expect((await store.get("t1", "call_s1"))?.voidedAt).toBeNull()
  })
})

describe("createMemoryClientToolCallStore — prune", () => {
  const T0 = "2026-09-01T00:00:00.000Z"
  const T1 = "2026-09-20T00:00:00.000Z"
  const BEFORE = "2026-09-10T00:00:00.000Z"

  it("deletes only non-open rows whose terminal timestamp is older than `before`", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call({ toolCallId: "old_answered", answeredAt: T0, result: "r" }))
    await store.issue(call({ toolCallId: "old_voided", voidedAt: T0 }))
    await store.issue(serverCall({ toolCallId: "old_settled", settledAt: T0 }))
    await store.issue(call({ toolCallId: "new_answered", answeredAt: T1, result: "r" }))
    await store.issue(serverCall({ toolCallId: "new_settled", settledAt: T1 }))
    await store.issue(call({ toolCallId: "open_client", issuedAt: "2020-01-01T00:00:00.000Z" }))
    await store.issue(
      serverCall({
        toolCallId: "open_server",
        issuedAt: "2020-01-01T00:00:00.000Z",
      }),
    )
    expect(await store.prune({ threadId: "t1", before: BEFORE })).toBe(3)
    expect((await store.listForThread("t1")).map((r) => r.toolCallId).sort()).toEqual([
      "new_answered",
      "new_settled",
      "open_client",
      "open_server",
    ])
  })

  it("prunes one thread only and returns 0 when nothing qualifies", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call({ threadId: "t1", toolCallId: "x", voidedAt: T0 }))
    await store.issue(call({ threadId: "t2", toolCallId: "x", voidedAt: T0 }))
    expect(await store.prune({ threadId: "t1", before: BEFORE })).toBe(1)
    expect(await store.get("t1", "x")).toBeUndefined()
    expect(await store.get("t2", "x")).toBeDefined()
    expect(await store.prune({ threadId: "t1", before: BEFORE })).toBe(0)
  })

  it("keeps a row whose terminal timestamp equals `before`", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call({ toolCallId: "edge", voidedAt: BEFORE }))
    expect(await store.prune({ threadId: "t1", before: BEFORE })).toBe(0)
    expect(await store.get("t1", "edge")).toBeDefined()
  })

  it("rejects a `before` that is not a canonical toISOString value", async () => {
    const store = createMemoryClientToolCallStore()
    const message = "prune: `before` must be a canonical Date#toISOString() value"
    await expect(store.prune({ threadId: "t1", before: "2026-09-10T00:00:00Z" })).rejects.toThrow(
      message,
    )
    await expect(store.prune({ threadId: "t1", before: "nope" })).rejects.toThrow(message)
  })

  it("decides on the terminal timestamp, not issuedAt", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call({ toolCallId: "recent_issue", issuedAt: T1, voidedAt: T0 }))
    expect(await store.prune({ threadId: "t1", before: BEFORE })).toBe(1)
  })
})
