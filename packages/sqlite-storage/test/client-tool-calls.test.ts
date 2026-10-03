import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createClientToolCallStore } from "../src/client-tool-calls/index.js"
import { CLIENT_TOOL_CALLS_MIGRATIONS } from "../src/client-tool-calls/schema.js"
import type { ClientToolCallRecord } from "../src/client-tool-calls/types.js"
import { runMigrations } from "../src/internal/migrate.js"

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
      kind: "client",
      interruptId: "client-call-1",
      toolName: "getLocation",
      runId: "r1",
      routeId: "/park#agent",
      issuedAt: "2026-09-30T00:00:00.000Z",
      expiresAt: null,
      answeredAt: null,
      result: null,
      voidedAt: null,
      settledAt: null,
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

  function serverCall(overrides: Partial<ClientToolCallRecord> = {}): ClientToolCallRecord {
    return call({
      toolCallId: "call-s1",
      kind: "server",
      interruptId: "",
      toolName: "readFile",
      expiresAt: null,
      ...overrides,
    })
  }

  it("round-trips kind and settledAt", async () => {
    const store = newStore()
    await store.issue(serverCall({ settledAt: "2026-09-30T00:00:05.000Z" }))
    const row = await store.get("t-1", "call-s1")
    expect(row?.kind).toBe("server")
    expect(row?.settledAt).toBe("2026-09-30T00:00:05.000Z")
    expect(row?.interruptId).toBe("")
  })

  it("settles a server row once, keeps the first time, and reports missing for a client row", async () => {
    const store = newStore()
    await store.issue(serverCall())
    await store.issue(call())
    expect(
      await store.settle({
        threadId: "t-1",
        toolCallId: "call-s1",
        at: "2026-09-30T00:00:01.000Z",
      }),
    ).toBe("settled")
    expect(
      await store.settle({
        threadId: "t-1",
        toolCallId: "call-s1",
        at: "2026-09-30T00:00:02.000Z",
      }),
    ).toBe("already_settled")
    expect((await store.get("t-1", "call-s1"))?.settledAt).toBe("2026-09-30T00:00:01.000Z")
    expect(
      await store.settle({ threadId: "t-1", toolCallId: "call-1", at: "2026-09-30T00:00:01.000Z" }),
    ).toBe("missing")
    expect(
      await store.settle({ threadId: "t-1", toolCallId: "nope", at: "2026-09-30T00:00:01.000Z" }),
    ).toBe("missing")
  })

  it("listOutstanding is open client rows only; answer and void skip server rows", async () => {
    const store = newStore()
    await store.issue(call())
    await store.issue(serverCall())
    expect((await store.listOutstanding("t-1")).map((r) => r.toolCallId)).toEqual(["call-1"])
    expect(
      (
        await store.answer({
          threadId: "t-1",
          toolCallId: "call-s1",
          result: "x",
          at: "2026-09-30T00:00:01.000Z",
        })
      ).outcome,
    ).toBe("missing")
    expect(await store.voidOutstanding({ threadId: "t-1", at: "2026-09-30T00:00:01.000Z" })).toBe(1)
    expect((await store.get("t-1", "call-s1"))?.voidedAt).toBeNull()
  })

  it("prune deletes only non-open rows older than `before`, on this thread, and counts them", async () => {
    const store = newStore()
    const OLD = "2026-09-01T00:00:00.000Z"
    const NEW = "2026-09-20T00:00:00.000Z"
    await store.issue(call({ toolCallId: "old_answered", answeredAt: OLD, result: "r" }))
    await store.issue(call({ toolCallId: "old_voided", voidedAt: OLD }))
    await store.issue(serverCall({ toolCallId: "old_settled", settledAt: OLD }))
    await store.issue(call({ toolCallId: "new_answered", answeredAt: NEW, result: "r" }))
    await store.issue(serverCall({ toolCallId: "new_settled", settledAt: NEW }))
    await store.issue(call({ toolCallId: "open_client", issuedAt: "2020-01-01T00:00:00.000Z" }))
    await store.issue(
      serverCall({ toolCallId: "open_server", issuedAt: "2020-01-01T00:00:00.000Z" }),
    )
    await store.issue(call({ threadId: "t-2", toolCallId: "other_thread", voidedAt: OLD }))
    expect(await store.prune({ threadId: "t-1", before: "2026-09-10T00:00:00.000Z" })).toBe(3)
    expect((await store.listForThread("t-1")).map((r) => r.toolCallId).sort()).toEqual([
      "new_answered",
      "new_settled",
      "open_client",
      "open_server",
    ])
    expect(await store.get("t-2", "other_thread")).toBeDefined()
  })

  it("prune keeps a row whose terminal timestamp equals `before`, and goes by the terminal time, not issuedAt", async () => {
    const store = newStore()
    const AT = "2026-09-10T00:00:00.000Z"
    await store.issue(call({ toolCallId: "boundary", voidedAt: AT }))
    await store.issue(
      call({
        toolCallId: "recent_issue_old_void",
        issuedAt: "2026-09-29T00:00:00.000Z",
        voidedAt: "2026-09-01T00:00:00.000Z",
      }),
    )
    expect(await store.prune({ threadId: "t-1", before: AT })).toBe(1)
    expect((await store.listForThread("t-1")).map((r) => r.toolCallId)).toEqual(["boundary"])
  })

  it("prune rejects a `before` that is not canonical Date#toISOString output", async () => {
    const store = newStore()
    for (const bad of ["2026-09-10T00:00:00Z", "nope"]) {
      await expect(store.prune({ threadId: "t-1", before: bad })).rejects.toThrow(
        "prune: `before` must be a canonical Date#toISOString() value",
      )
    }
  })

  it("migration 2 backfills a version-1 row as kind=client with no settledAt", async () => {
    const path = storePath()
    const v1 = new DatabaseSync(path)
    runMigrations(
      v1,
      CLIENT_TOOL_CALLS_MIGRATIONS.filter((m) => m.version === 1),
    )
    v1.prepare(
      `INSERT INTO client_tool_calls(thread_id, tool_call_id, interrupt_id, tool_name, run_id, route_id, issued_at, expires_at, answered_at, result, voided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "t-1",
      "legacy",
      "client-legacy",
      "openPanel",
      "r0",
      "/park#agent",
      "2026-09-29T00:00:00.000Z",
      null,
      null,
      null,
      null,
    )
    v1.close()
    const store = newStore()
    const row = await store.get("t-1", "legacy")
    expect(row?.kind).toBe("client")
    expect(row?.settledAt).toBeNull()
    expect((await store.listOutstanding("t-1")).map((r) => r.toolCallId)).toEqual(["legacy"])
  })

  it("persists kind explicitly rather than relying on the backfill default", async () => {
    const store = newStore()
    await store.issue(serverCall())
    const db = new DatabaseSync(storePath())
    const row = db
      .prepare("SELECT kind, settled_at FROM client_tool_calls WHERE tool_call_id = ?")
      .get("call-s1") as { kind: string; settled_at: string | null }
    db.close()
    expect(row).toEqual({ kind: "server", settled_at: null })
  })

  it("rejects a record whose kind is neither client nor server", async () => {
    const store = newStore()
    await expect(store.issue(call({ kind: "other" as never }))).rejects.toThrow()
  })
})
