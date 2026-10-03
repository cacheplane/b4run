import { describe, expect, it } from "vitest"
import {
  type B4ContentPart,
  type ClientToolCallRecord,
  createMemoryClientToolCallStore,
  decodeClientToolResult,
  encodeClientToolResult,
} from "../src/index.js"

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

describe("createMemoryClientToolCallStore — prune with server rows", () => {
  const T0 = "2026-09-01T00:00:00.000Z"
  const T1 = "2026-09-20T00:00:00.000Z"
  const BEFORE = "2026-09-10T00:00:00.000Z"

  it("deletes terminal rows of both kinds older than `before` and keeps open ones", async () => {
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
    expect(await store.prune({ before: BEFORE })).toBe(3)
    expect((await store.listForThread("t1")).map((r) => r.toolCallId).sort()).toEqual([
      "new_answered",
      "new_settled",
      "open_client",
      "open_server",
    ])
  })

  it("deletes a settled server row older than `before` on every thread", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(serverCall({ threadId: "t1", toolCallId: "s", settledAt: T0 }))
    await store.issue(serverCall({ threadId: "t2", toolCallId: "s", settledAt: T0 }))
    expect(await store.prune({ before: BEFORE })).toBe(2)
    expect(await store.get("t1", "s")).toBeUndefined()
    expect(await store.get("t2", "s")).toBeUndefined()
  })

  it("keeps an unsettled server row however old its issuedAt", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(serverCall({ issuedAt: "2020-01-01T00:00:00.000Z" }))
    expect(await store.prune({ before: BEFORE })).toBe(0)
    expect(await store.get("t1", "call_s1")).toBeDefined()
  })

  it("keeps a server row settled after `before`", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(serverCall({ settledAt: T1 }))
    expect(await store.prune({ before: BEFORE })).toBe(0)
    expect(await store.get("t1", "call_s1")).toBeDefined()
  })

  it("keeps rows whose terminal timestamp equals `before`", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call({ toolCallId: "edge", voidedAt: BEFORE }))
    await store.issue(serverCall({ toolCallId: "edge_server", settledAt: BEFORE }))
    expect(await store.prune({ before: BEFORE })).toBe(0)
    expect(await store.get("t1", "edge")).toBeDefined()
    expect(await store.get("t1", "edge_server")).toBeDefined()
  })

  it("decides on the terminal timestamp, not issuedAt", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call({ toolCallId: "recent_issue", issuedAt: T1, voidedAt: T0 }))
    await store.issue(serverCall({ toolCallId: "recent_server", issuedAt: T1, settledAt: T0 }))
    expect(await store.prune({ before: BEFORE })).toBe(2)
  })
})

const parts: readonly B4ContentPart[] = [
  { type: "text", text: "shot" },
  { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
]

describe("client tool result codec", () => {
  it("text round-trips as itself, parts as a self-describing envelope", () => {
    expect(encodeClientToolResult("plain")).toBe("plain")
    const encoded = encodeClientToolResult(parts)
    expect(JSON.parse(encoded)).toEqual({ $b4: "content-parts", parts })
    expect(decodeClientToolResult(encoded)).toEqual(parts)
    expect(decodeClientToolResult("plain")).toBe("plain")
  })

  it("a stored text that merely looks like the envelope but is not a valid part list stays text", () => {
    const text = JSON.stringify({ $b4: "content-parts", parts: [{ type: "blob" }] })
    expect(decodeClientToolResult(text)).toBe(text)
  })

  it("null stays null", () => {
    expect(decodeClientToolResult(null)).toBeNull()
  })
})

describe("memory store with a parts result", () => {
  it("returns a parts result as parts", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call({ threadId: "t", toolCallId: "c1" }))
    const answer = await store.answer({
      threadId: "t",
      toolCallId: "c1",
      result: parts,
      at: "2026-10-03T00:00:00.000Z",
    })
    expect(answer.outcome === "answered" && answer.record.result).toEqual(parts)
    expect((await store.get("t", "c1"))?.result).toEqual(parts)
  })
})
