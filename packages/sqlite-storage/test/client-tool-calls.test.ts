import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createClientToolCallStore } from "../src/client-tool-calls/index.js"
import type { ClientToolCallRecord } from "../src/client-tool-calls/types.js"

describe("createClientToolCallStore", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "b4-client-tool-calls-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function storePath() {
    return join(dir, "client-tool-calls.sqlite")
  }

  function newStore() {
    return createClientToolCallStore({ path: storePath() })
  }

  function call(overrides: Partial<ClientToolCallRecord> = {}): ClientToolCallRecord {
    return {
      threadId: "t-1",
      toolCallId: "call-1",
      interruptId: "client-call-1",
      toolName: "getLocation",
      runId: "r1",
      issuedAt: "2026-09-30T00:00:00.000Z",
      expiresAt: null,
      answeredAt: null,
      result: null,
      voidedAt: null,
      ...overrides,
    }
  }

  const at = "2026-09-30T01:00:00.000Z"

  it("issue + get round-trips every column", async () => {
    const store = newStore()
    const row = call({ expiresAt: "2026-10-01T00:00:00.000Z" })
    await store.issue(row)
    expect(await store.get("t-1", "call-1")).toEqual(row)
    expect(await store.get("t-1", "nope")).toBeUndefined()
  })

  it("a replayed issue is a no-op", async () => {
    const store = newStore()
    await store.issue(call())
    await store.issue(call({ runId: "r2" }))
    expect((await store.get("t-1", "call-1"))?.runId).toBe("r1")
  })

  it("answers once, keeps the result, and refuses the replay", async () => {
    const store = newStore()
    await store.issue(call())
    const first = await store.answer({
      threadId: "t-1",
      toolCallId: "call-1",
      result: "Paris",
      at,
    })
    expect(first.outcome).toBe("answered")
    expect(first.outcome === "answered" && first.record.result).toBe("Paris")
    const second = await store.answer({
      threadId: "t-1",
      toolCallId: "call-1",
      result: "Rome",
      at,
    })
    expect(second.outcome).toBe("already_answered")
    expect((await store.get("t-1", "call-1"))?.result).toBe("Paris")
  })

  it("an answer from another thread is missing", async () => {
    const store = newStore()
    await store.issue(call())
    const out = await store.answer({ threadId: "t-2", toolCallId: "call-1", result: "x", at })
    expect(out.outcome).toBe("missing")
    expect((await store.get("t-1", "call-1"))?.answeredAt).toBeNull()
  })

  it("a voided call cannot be answered", async () => {
    const store = newStore()
    await store.issue(call())
    expect(await store.voidOutstanding({ threadId: "t-1", at })).toBe(1)
    const out = await store.answer({ threadId: "t-1", toolCallId: "call-1", result: "x", at })
    expect(out.outcome).toBe("voided")
  })

  it("listOutstanding excludes answered and voided rows; named voids touch only those", async () => {
    const store = newStore()
    await store.issue(call({ toolCallId: "a", issuedAt: "2026-09-30T00:00:01.000Z" }))
    await store.issue(call({ toolCallId: "b", issuedAt: "2026-09-30T00:00:02.000Z" }))
    await store.issue(call({ toolCallId: "c", issuedAt: "2026-09-30T00:00:03.000Z" }))
    await store.issue(call({ toolCallId: "d", issuedAt: "2026-09-30T00:00:04.000Z" }))
    await store.answer({ threadId: "t-1", toolCallId: "a", result: "ok", at })
    expect(await store.voidOutstanding({ threadId: "t-1", toolCallIds: ["b", "a"], at })).toBe(1)
    const outstanding = await store.listOutstanding("t-1")
    expect(outstanding.map((r) => r.toolCallId)).toEqual(["c", "d"])
  })

  it("voiding an empty list voids nothing", async () => {
    const store = newStore()
    await store.issue(call())
    expect(await store.voidOutstanding({ threadId: "t-1", toolCallIds: [], at })).toBe(0)
    expect(await store.listOutstanding("t-1")).toHaveLength(1)
  })

  it("void-all never voids an answered row and counts what it voided", async () => {
    const store = newStore()
    await store.issue(call({ toolCallId: "a" }))
    await store.issue(call({ toolCallId: "b" }))
    await store.issue(call({ toolCallId: "c" }))
    await store.answer({ threadId: "t-1", toolCallId: "a", result: "ok", at })
    expect(await store.voidOutstanding({ threadId: "t-1", at })).toBe(2)
    expect((await store.get("t-1", "a"))?.voidedAt).toBeNull()
  })

  it("listForThread includes answered results, in issue order", async () => {
    const store = newStore()
    await store.issue(call({ toolCallId: "b", issuedAt: "2026-09-30T00:00:02.000Z" }))
    await store.issue(call({ toolCallId: "a", issuedAt: "2026-09-30T00:00:01.000Z" }))
    await store.answer({ threadId: "t-1", toolCallId: "a", result: "ok", at })
    const rows = await store.listForThread("t-1")
    expect(rows.map((r) => r.toolCallId)).toEqual(["a", "b"])
    expect(rows[0]?.result).toBe("ok")
  })

  it("a same-toolCallId row on another thread is unaffected", async () => {
    const store = newStore()
    await store.issue(call())
    await store.issue(call({ threadId: "t-2" }))
    await store.answer({ threadId: "t-1", toolCallId: "call-1", result: "ok", at })
    await store.voidOutstanding({ threadId: "t-1", at })
    const other = await store.get("t-2", "call-1")
    expect(other?.answeredAt).toBeNull()
    expect(other?.voidedAt).toBeNull()
  })

  it("a reopened store sees the answer", async () => {
    const first = newStore()
    await first.issue(call())
    await first.answer({ threadId: "t-1", toolCallId: "call-1", result: "ok", at })
    const second = newStore()
    const row = await second.get("t-1", "call-1")
    expect(row?.answeredAt).toBe(at)
    expect(row?.result).toBe("ok")
  })

  it("exactly one of many concurrent answers across two handles wins", async () => {
    const a = newStore()
    const b = newStore()
    await a.issue(call())
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 === 0 ? a : b).answer({
          threadId: "t-1",
          toolCallId: "call-1",
          result: `result-${i}`,
          at,
        }),
      ),
    )
    const winners = outcomes.filter((o) => o.outcome === "answered")
    expect(winners).toHaveLength(1)
    expect(outcomes.filter((o) => o.outcome === "already_answered")).toHaveLength(11)
    const winner = winners[0]
    expect((await a.get("t-1", "call-1"))?.result).toBe(
      winner?.outcome === "answered" ? winner.record.result : undefined,
    )
  })

  it("voiding twice counts the row only the first time", async () => {
    const store = newStore()
    await store.issue(call())
    expect(await store.voidOutstanding({ threadId: "t-1", at })).toBe(1)
    expect(await store.voidOutstanding({ threadId: "t-1", at })).toBe(0)
  })

  it("a named void does not touch the same id on another thread", async () => {
    const store = newStore()
    await store.issue(call())
    await store.issue(call({ threadId: "t-2" }))
    expect(await store.voidOutstanding({ threadId: "t-1", toolCallIds: ["call-1"], at })).toBe(1)
    expect((await store.get("t-2", "call-1"))?.voidedAt).toBeNull()
  })
})
