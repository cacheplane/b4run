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
      parentToolCallId: null,
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

  describe("content-part results (spec §3.2: the TEXT column keeps an envelope)", () => {
    const parts = [
      { type: "text", text: "panel opened" },
      { type: "image", source: { type: "data", value: "iVBORw0KGgo=", mimeType: "image/png" } },
    ] as const

    it("a parts answer round-trips through get and listForThread", async () => {
      const store = newStore()
      await store.issue(call())
      const answered = await store.answer({
        threadId: "t-1",
        toolCallId: "call-1",
        result: parts,
        at,
      })
      expect(answered.outcome === "answered" && answered.record.result).toEqual(parts)
      const row = await store.get("t-1", "call-1")
      expect(row?.answeredAt).toBe(at)
      expect(row?.result).toEqual(parts)
      expect((await store.listForThread("t-1"))[0]?.result).toEqual(parts)
      // A reopened handle decodes it too.
      expect((await newStore().get("t-1", "call-1"))?.result).toEqual(parts)
    })

    it("an issued record carrying parts round-trips", async () => {
      const store = newStore()
      const row = call({ answeredAt: at, result: parts })
      await store.issue(row)
      expect(await store.get("t-1", "call-1")).toEqual(row)
    })

    it("a text answer still reads back as text", async () => {
      const store = newStore()
      await store.issue(call())
      await store.answer({ threadId: "t-1", toolCallId: "call-1", result: "Paris", at })
      expect((await store.get("t-1", "call-1"))?.result).toBe("Paris")
    })

    it("text that looks like the envelope but is not a valid part list reads back as that text", async () => {
      const store = newStore()
      const lookalikes = [
        '{"$b4":"content-parts","parts":[{"type":"image"}]}',
        '{"$b4":"content-parts","parts":"nope"}',
        '{"$b4":"other","parts":[]}',
        '{"$b4": not json',
      ]
      for (const [i, text] of lookalikes.entries()) {
        await store.issue(call({ toolCallId: `look-${i}` }))
        await store.answer({ threadId: "t-1", toolCallId: `look-${i}`, result: text, at })
        expect((await store.get("t-1", `look-${i}`))?.result).toBe(text)
      }
    })
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

  it("prune deletes terminal rows of both kinds older than `before` on every thread, keeps open ones, and counts them", async () => {
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
    await store.issue(serverCall({ threadId: "t-2", toolCallId: "other_thread", settledAt: OLD }))
    expect(await store.prune({ before: "2026-09-10T00:00:00.000Z" })).toBe(4)
    expect((await store.listForThread("t-1")).map((r) => r.toolCallId).sort()).toEqual([
      "new_answered",
      "new_settled",
      "open_client",
      "open_server",
    ])
    expect(await store.get("t-2", "other_thread")).toBeUndefined()
  })

  it("prune keeps an unsettled server row with an old issuedAt and a server row settled after `before`", async () => {
    const store = newStore()
    const AT = "2026-09-10T00:00:00.000Z"
    await store.issue(serverCall({ toolCallId: "unsettled", issuedAt: "2020-01-01T00:00:00.000Z" }))
    await store.issue(
      serverCall({ toolCallId: "settled_later", settledAt: "2026-09-20T00:00:00.000Z" }),
    )
    expect(await store.prune({ before: AT })).toBe(0)
    expect((await store.listForThread("t-1")).map((r) => r.toolCallId).sort()).toEqual([
      "settled_later",
      "unsettled",
    ])
  })

  it("prune keeps rows whose terminal timestamp equals `before`, and goes by the terminal time, not issuedAt", async () => {
    const store = newStore()
    const AT = "2026-09-10T00:00:00.000Z"
    await store.issue(call({ toolCallId: "boundary", voidedAt: AT }))
    await store.issue(serverCall({ toolCallId: "boundary_server", settledAt: AT }))
    await store.issue(
      call({
        toolCallId: "recent_issue_old_void",
        issuedAt: "2026-09-29T00:00:00.000Z",
        voidedAt: "2026-09-01T00:00:00.000Z",
      }),
    )
    await store.issue(
      serverCall({
        toolCallId: "recent_issue_old_settle",
        issuedAt: "2026-09-29T00:00:00.000Z",
        settledAt: "2026-09-01T00:00:00.000Z",
      }),
    )
    expect(await store.prune({ before: AT })).toBe(2)
    expect((await store.listForThread("t-1")).map((r) => r.toolCallId).sort()).toEqual([
      "boundary",
      "boundary_server",
    ])
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
      .prepare(
        "SELECT kind, settled_at, parent_tool_call_id FROM client_tool_calls WHERE tool_call_id = ?",
      )
      .get("call-s1") as {
      kind: string
      settled_at: string | null
      parent_tool_call_id: string | null
    }
    db.close()
    expect(row).toEqual({ kind: "server", settled_at: null, parent_tool_call_id: null })
  })

  it("rejects a record whose kind is neither client nor server", async () => {
    const store = newStore()
    await expect(store.issue(call({ kind: "other" as never }))).rejects.toThrow()
  })

  it("round-trips the parent task link", async () => {
    const store = newStore()
    await store.issue(serverCall({ toolCallId: "child", parentToolCallId: "call_task_1" }))
    await store.issue(serverCall({ toolCallId: "root" }))
    expect((await store.get("t-1", "child"))?.parentToolCallId).toBe("call_task_1")
    expect((await store.get("t-1", "root"))?.parentToolCallId).toBeNull()
  })

  it("migration 3 reads a version-2 row's parent link as null", async () => {
    const path = storePath()
    const v2 = new DatabaseSync(path)
    runMigrations(
      v2,
      CLIENT_TOOL_CALLS_MIGRATIONS.filter((m) => m.version <= 2),
    )
    v2.prepare(
      `INSERT INTO client_tool_calls(thread_id, tool_call_id, kind, interrupt_id, tool_name, run_id, route_id, issued_at, expires_at, answered_at, result, voided_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "t-1",
      "legacy",
      "server",
      "",
      "readFile",
      "r0",
      "/park#agent",
      "2026-10-01T00:00:00.000Z",
      null,
      null,
      null,
      null,
      "2026-10-01T00:00:01.000Z",
    )
    v2.close()
    const store = newStore()
    expect((await store.get("t-1", "legacy"))?.parentToolCallId).toBeNull()
  })

  describe("prune", () => {
    const BEFORE = "2026-09-30T12:00:00.000Z"

    it("deletes answered and voided rows settled before the cutoff and keeps later ones", async () => {
      const store = newStore()
      await store.issue(
        call({ toolCallId: "old_answered", answeredAt: "2026-09-30T01:00:00.000Z", result: "ok" }),
      )
      await store.issue(call({ toolCallId: "new_answered", answeredAt: BEFORE, result: "ok" }))
      await store.issue(call({ toolCallId: "old_voided", voidedAt: "2026-09-30T01:00:00.000Z" }))
      await store.issue(call({ toolCallId: "new_voided", voidedAt: "2026-09-30T13:00:00.000Z" }))
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect((await store.listForThread("t-1")).map((row) => row.toolCallId).sort()).toEqual([
        "new_answered",
        "new_voided",
      ])
    })

    it("a void is the settle time: an old answer with a recent void is kept", async () => {
      const store = newStore()
      await store.issue(
        call({
          toolCallId: "answered_then_voided",
          answeredAt: "2026-09-30T01:00:00.000Z",
          result: "ok",
          voidedAt: "2026-09-30T13:00:00.000Z",
        }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.get("t-1", "answered_then_voided")).toBeDefined()
    })

    it("deletes outstanding rows expired before the cutoff and keeps unexpired or never-expiring ones", async () => {
      const store = newStore()
      await store.issue(call({ toolCallId: "expired_old", expiresAt: "2026-09-30T00:10:00.000Z" }))
      await store.issue(call({ toolCallId: "expires_at_cutoff", expiresAt: BEFORE }))
      await store.issue(
        call({ toolCallId: "expires_later", expiresAt: "2026-09-30T13:00:00.000Z" }),
      )
      await store.issue(call({ toolCallId: "never_expires", expiresAt: null }))
      expect(await store.prune({ before: BEFORE })).toBe(1)
      expect((await store.listOutstanding("t-1")).map((row) => row.toolCallId).sort()).toEqual([
        "expires_at_cutoff",
        "expires_later",
        "never_expires",
      ])
    })

    it("sweeps every thread and is idempotent", async () => {
      const store = newStore()
      await store.issue(
        call({ threadId: "t-1", toolCallId: "a", voidedAt: "2026-09-30T01:00:00.000Z" }),
      )
      await store.issue(
        call({ threadId: "t-2", toolCallId: "b", voidedAt: "2026-09-30T01:00:00.000Z" }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.listForThread("t-1")).toEqual([])
      expect(await store.listForThread("t-2")).toEqual([])
    })
  })
})
