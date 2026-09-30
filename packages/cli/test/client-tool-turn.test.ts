import type { B4Message } from "@b4run/ag-ui"
import { ABANDONED_CLIENT_TOOL_RESULT } from "@b4run/core"
import {
  type ClientToolCallRecord,
  type ClientToolCallStore,
  createMemoryClientToolCallStore,
} from "@b4run/sdk"
import { describe, expect, test, vi } from "vitest"

import { resolveClientToolTurn } from "../src/lib/dev/client-tool-turn.js"
import type {
  PendingInterrupt,
  PendingInterruptSnapshot,
} from "../src/lib/dev/pending-interrupts.js"

const THREAD = "thread-1"
const NOW = new Date("2026-09-30T12:00:00.000Z")
const KEY_A = "a".repeat(32)
const KEY_B = "b".repeat(32)
const KEY_P = "c".repeat(32)

function clientPark(toolCallId: string, resumeKey: string | null): PendingInterrupt {
  const interruptId = `client-${toolCallId}`
  return {
    aliases: [interruptId],
    interruptId,
    resumeKey,
    value: {
      type: "client-tool-call",
      interruptId,
      toolCallId,
      name: "open_panel",
      input: { panel: "settings" },
    },
  }
}

const permissionPark: PendingInterrupt = {
  aliases: ["perm-1"],
  interruptId: "perm-1",
  resumeKey: KEY_P,
  value: { interruptId: "perm-1", type: "permission", kind: "tool", detail: "writeFile" },
}

function snapshot(...interrupts: PendingInterrupt[]): PendingInterruptSnapshot {
  return { interrupts, malformed: false }
}

function record(
  toolCallId: string,
  overrides: Partial<ClientToolCallRecord> = {},
): ClientToolCallRecord {
  return {
    threadId: THREAD,
    toolCallId,
    interruptId: `client-${toolCallId}`,
    toolName: "open_panel",
    runId: "run-1",
    routeId: "/park#agent",
    issuedAt: "2026-09-30T11:59:00.000Z",
    expiresAt: null,
    answeredAt: null,
    result: null,
    voidedAt: null,
    ...overrides,
  }
}

const user = (content: string): B4Message => ({ role: "user", content })
const tool = (toolCallId: string, content: string): B4Message => ({
  role: "tool",
  toolCallId,
  content,
})

async function storeWith(...records: ClientToolCallRecord[]): Promise<ClientToolCallStore> {
  const store = createMemoryClientToolCallStore()
  for (const r of records) await store.issue(r)
  return store
}

describe("resolveClientToolTurn", () => {
  test("no client parks is none, even with tool messages present", async () => {
    const store = await storeWith(record("call-1"))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(permissionPark),
      messages: [user("hi"), tool("call-1", "opened")],
      now: NOW,
    })
    expect(turn).toEqual({ mode: "none" })
    expect((await store.get(THREAD, "call-1"))?.answeredAt).toBeNull()
  })

  test("one park and its tool message resumes with the result and answers the record", async () => {
    const store = await storeWith(record("call-1"))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("open settings"), tool("call-1", "opened")],
      now: NOW,
    })
    expect(turn).toEqual({
      mode: "resume",
      resume: { [KEY_A]: { clientToolResult: "opened" } },
      others: [],
    })
    const row = await store.get(THREAD, "call-1")
    expect(row?.result).toBe("opened")
    expect(row?.answeredAt).toBe(NOW.toISOString())
  })

  test("the same envelope after the park is gone is none, not an error", async () => {
    const store = await storeWith(
      record("call-1", { answeredAt: NOW.toISOString(), result: "opened" }),
    )
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(),
      messages: [user("open settings"), tool("call-1", "opened")],
      now: NOW,
    })
    expect(turn).toEqual({ mode: "none" })
  })

  test("the same envelope while the park is still pending resumes again with the stored result", async () => {
    const store = await storeWith(
      record("call-1", { answeredAt: "2026-09-30T11:59:30.000Z", result: "opened" }),
    )
    const answer = vi.spyOn(store, "answer")
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("open settings"), tool("call-1", "a different result")],
      now: NOW,
    })
    expect(turn).toEqual({
      mode: "resume",
      resume: { [KEY_A]: { clientToolResult: "opened" } },
      others: [],
    })
    expect(answer).not.toHaveBeenCalled()
    expect((await store.get(THREAD, "call-1"))?.result).toBe("opened")
  })

  test("two parks answered across two envelopes: partial, then resume with both", async () => {
    const store = await storeWith(record("call-1"), record("call-2"))
    const pending = snapshot(clientPark("call-1", KEY_A), clientPark("call-2", KEY_B))

    const first = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending,
      messages: [user("go"), tool("call-1", "one")],
      now: NOW,
    })
    expect(first).toEqual({ mode: "partial" })

    // AG-UI clients resend the whole history, so call-1's message comes again.
    const second = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending,
      messages: [user("go"), tool("call-1", "one"), tool("call-2", "two")],
      now: NOW,
    })
    expect(second).toEqual({
      mode: "resume",
      resume: {
        [KEY_A]: { clientToolResult: "one" },
        [KEY_B]: { clientToolResult: "two" },
      },
      others: [],
    })
  })

  test("a tool message for another thread's record is ignored; a new user message abandons", async () => {
    const store = await storeWith(record("call-1"), record("call-x", { threadId: "thread-2" }))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("go"), tool("call-x", "stolen"), user("never mind")],
      now: NOW,
    })
    expect(turn).toEqual({
      mode: "abandon",
      calls: [
        { toolCallId: "call-1", toolName: "open_panel", result: ABANDONED_CLIENT_TOOL_RESULT },
      ],
      abandonedToolCallIds: ["call-1"],
      reason: "new_user_message",
    })
    const other = await store.get("thread-2", "call-x")
    expect(other?.answeredAt).toBeNull()
    expect(other?.result).toBeNull()
  })

  test("a new user message keeps the results already answered", async () => {
    const store = await storeWith(record("call-1"), record("call-2"))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A), clientPark("call-2", KEY_B)),
      messages: [user("go"), tool("call-1", "one"), user("something else")],
      now: NOW,
    })
    expect(turn).toEqual({
      mode: "abandon",
      calls: [
        { toolCallId: "call-1", toolName: "open_panel", result: "one" },
        { toolCallId: "call-2", toolName: "open_panel", result: ABANDONED_CLIENT_TOOL_RESULT },
      ],
      abandonedToolCallIds: ["call-2"],
      reason: "new_user_message",
    })
  })

  test("a forged tool message with an unknown id answers nothing", async () => {
    const store = await storeWith(record("call-1"))
    const before = await store.listForThread(THREAD)
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("go"), tool("forged", "evil")],
      now: NOW,
    })
    expect(turn).toEqual({ mode: "partial" })
    expect(await store.listForThread(THREAD)).toEqual(before)
    expect(await store.get(THREAD, "forged")).toBeUndefined()
  })

  test("an expired outstanding call abandons and its late result is not answered", async () => {
    const store = await storeWith(record("call-1", { expiresAt: "2026-09-30T11:59:59.000Z" }))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("go"), tool("call-1", "late")],
      now: NOW,
    })
    expect(turn).toEqual({
      mode: "abandon",
      calls: [
        { toolCallId: "call-1", toolName: "open_panel", result: ABANDONED_CLIENT_TOOL_RESULT },
      ],
      abandonedToolCallIds: ["call-1"],
      reason: "expired",
    })
    expect((await store.get(THREAD, "call-1"))?.answeredAt).toBeNull()
  })

  test("expiry exactly at now counts as expired", async () => {
    const store = await storeWith(record("call-1", { expiresAt: NOW.toISOString() }))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("go"), tool("call-1", "late")],
      now: NOW,
    })
    expect(turn).toMatchObject({ mode: "abandon", reason: "expired" })
  })

  test("expired beats a new user message", async () => {
    const store = await storeWith(record("call-1", { expiresAt: "2026-09-30T11:00:00.000Z" }))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("go"), user("again")],
      now: NOW,
    })
    expect(turn).toMatchObject({ mode: "abandon", reason: "expired" })
  })

  test("a park with no resume key is unanswerable", async () => {
    const store = await storeWith(record("call-1"))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", null)),
      messages: [user("go"), tool("call-1", "opened")],
      now: NOW,
    })
    expect(turn).toMatchObject({
      mode: "abandon",
      reason: "unanswerable",
      abandonedToolCallIds: ["call-1"],
    })
  })

  test("a park with no record is unanswerable", async () => {
    const store = await storeWith()
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("go"), tool("call-1", "opened")],
      now: NOW,
    })
    expect(turn).toEqual({
      mode: "abandon",
      calls: [
        { toolCallId: "call-1", toolName: "open_panel", result: ABANDONED_CLIENT_TOOL_RESULT },
      ],
      abandonedToolCallIds: ["call-1"],
      reason: "unanswerable",
    })
    expect(await store.get(THREAD, "call-1")).toBeUndefined()
  })

  test("unanswerable beats expired and a new user message", async () => {
    const store = await storeWith(record("call-1", { expiresAt: "2026-09-30T11:00:00.000Z" }))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A), clientPark("call-2", KEY_B)),
      messages: [user("go"), user("again")],
      now: NOW,
    })
    expect(turn).toMatchObject({ mode: "abandon", reason: "unanswerable" })
  })

  test("a permission park alongside an answered client park is returned in others", async () => {
    const store = await storeWith(record("call-1"))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(permissionPark, clientPark("call-1", KEY_A)),
      messages: [user("go"), tool("call-1", "opened")],
      now: NOW,
    })
    expect(turn).toEqual({
      mode: "resume",
      resume: { [KEY_A]: { clientToolResult: "opened" } },
      others: [permissionPark],
    })
  })

  test("tool message content is stored verbatim, including the empty string", async () => {
    const store = await storeWith(record("call-1"))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("go"), tool("call-1", "")],
      now: NOW,
    })
    expect(turn).toEqual({
      mode: "resume",
      resume: { [KEY_A]: { clientToolResult: "" } },
      others: [],
    })
    expect((await store.get(THREAD, "call-1"))?.result).toBe("")
  })

  test("the first of duplicate tool messages for one call wins", async () => {
    const store = await storeWith(record("call-1"))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("go"), tool("call-1", "first"), tool("call-1", "second")],
      now: NOW,
    })
    expect(turn).toMatchObject({ resume: { [KEY_A]: { clientToolResult: "first" } } })
  })

  test("every park answered but a new user message last abandons, keeping every result", async () => {
    const store = await storeWith(
      record("call-1", { answeredAt: "2026-09-30T11:59:30.000Z", result: "one" }),
      record("call-2"),
    )
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(permissionPark, clientPark("call-1", KEY_A), clientPark("call-2", KEY_B)),
      messages: [user("go"), tool("call-1", "one"), tool("call-2", "two"), user("next")],
      now: NOW,
    })
    expect(turn).toEqual({
      mode: "abandon",
      calls: [
        { toolCallId: "call-1", toolName: "open_panel", result: "one" },
        { toolCallId: "call-2", toolName: "open_panel", result: "two" },
      ],
      abandonedToolCallIds: [],
      reason: "new_user_message",
    })
    expect((await store.get(THREAD, "call-2"))?.result).toBe("two")
  })

  test("a trailing assistant message is not new input", async () => {
    const store = await storeWith(record("call-1"))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("go"), { role: "assistant", content: "hm" }],
      now: NOW,
    })
    expect(turn).toEqual({ mode: "partial" })
  })

  test("an outstanding row with no pending park is never answered", async () => {
    const store = await storeWith(record("call-1"), record("call-2"))
    const none = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(),
      messages: [user("go"), tool("call-1", "opened")],
      now: NOW,
    })
    expect(none).toEqual({ mode: "none" })
    // With another client park pending, call-1's message still answers nothing.
    const partial = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-2", KEY_B)),
      messages: [user("go"), tool("call-1", "opened")],
      now: NOW,
    })
    expect(partial).toEqual({ mode: "partial" })
    expect((await store.get(THREAD, "call-1"))?.answeredAt).toBeNull()
  })

  test("a tool message naming a permission park is ignored", async () => {
    const store = await storeWith(record("call-1"))
    const answer = vi.spyOn(store, "answer")
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(permissionPark, clientPark("call-1", KEY_A)),
      messages: [user("go"), tool("perm-1", "once")],
      now: NOW,
    })
    expect(turn).toEqual({ mode: "partial" })
    expect(answer).not.toHaveBeenCalled()
    expect(await store.get(THREAD, "perm-1")).toBeUndefined()
  })

  test("a record for a different park is unanswerable and never answered", async () => {
    const store = await storeWith(record("call-1", { interruptId: "client-other" }))
    const answer = vi.spyOn(store, "answer")
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("go"), tool("call-1", "opened")],
      now: NOW,
    })
    expect(turn).toMatchObject({ mode: "abandon", reason: "unanswerable" })
    expect(answer).not.toHaveBeenCalled()
  })

  test("a voided record with its park still pending is unanswerable", async () => {
    const store = await storeWith(record("call-1", { voidedAt: "2026-09-30T11:59:30.000Z" }))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("go"), tool("call-1", "opened")],
      now: NOW,
    })
    expect(turn).toMatchObject({
      mode: "abandon",
      reason: "unanswerable",
      abandonedToolCallIds: ["call-1"],
    })
  })

  test("an unparseable expiresAt is expired and not answered", async () => {
    const store = await storeWith(record("call-1", { expiresAt: "garbage" }))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("go"), tool("call-1", "opened")],
      now: NOW,
    })
    expect(turn).toMatchObject({ mode: "abandon", reason: "expired" })
    expect((await store.get(THREAD, "call-1"))?.answeredAt).toBeNull()
  })

  test("an expired call beside one answered in this run keeps the real result", async () => {
    const store = await storeWith(
      record("call-1"),
      record("call-2", { expiresAt: "2026-09-30T11:00:00.000Z" }),
    )
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A), clientPark("call-2", KEY_B)),
      messages: [user("go"), tool("call-1", "one"), tool("call-2", "late")],
      now: NOW,
    })
    expect(turn).toEqual({
      mode: "abandon",
      calls: [
        { toolCallId: "call-1", toolName: "open_panel", result: "one" },
        { toolCallId: "call-2", toolName: "open_panel", result: ABANDONED_CLIENT_TOOL_RESULT },
      ],
      abandonedToolCallIds: ["call-2"],
      reason: "expired",
    })
  })

  test("a malformed snapshot with a client park pending is unanswerable", async () => {
    const store = await storeWith(record("call-1"))
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: { interrupts: [clientPark("call-1", KEY_A)], malformed: true },
      messages: [user("go"), tool("call-1", "opened")],
      now: NOW,
    })
    expect(turn).toMatchObject({ mode: "abandon", reason: "unanswerable" })
  })

  test("an invalid now throws", async () => {
    const store = await storeWith(record("call-1"))
    await expect(
      resolveClientToolTurn({
        store,
        threadId: THREAD,
        pending: snapshot(clientPark("call-1", KEY_A)),
        messages: [],
        now: new Date(Number.NaN),
      }),
    ).rejects.toThrow(/invalid Date/)
  })
})
