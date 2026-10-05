import { B4_TURN_METADATA_KEY, readPersistedTurnEnd } from "@b4run/sdk"
import { MemorySaver } from "@langchain/langgraph-checkpoint"
import { describe, expect, test } from "vitest"
import { readTerminalError, stampTurnEnd, turnEndFor } from "../src/lib/dev/turn-end-stamp.ts"

const cfg = (threadId: string) => ({ configurable: { thread_id: threadId, checkpoint_ns: "" } })
const checkpoint = (id: string) => ({
  v: 4,
  id,
  ts: "2026-10-05T00:00:00.000Z",
  channel_values: { messages: [] },
  channel_versions: {},
  versions_seen: {},
})
const END = { status: "done", endedAt: "2026-10-05T00:00:03.000Z" } as const
const metadataOf = (tuple: { metadata?: unknown } | undefined): Record<string, unknown> =>
  (tuple?.metadata ?? {}) as Record<string, unknown>

describe("turn end stamp", () => {
  test("re-puts the head checkpoint with b4:turn, keeping id, parent, values and other metadata", async () => {
    const saver = new MemorySaver()
    const first = await saver.put(
      cfg("t1"),
      checkpoint("c1") as never,
      { source: "input", step: -1, parents: {} } as never,
    )
    await saver.put(
      first,
      checkpoint("c2") as never,
      {
        source: "loop",
        step: 0,
        parents: {},
        "b4:checkpoint-routes": { checkpointId: "c2", routes: ["/x#agent"] },
      } as never,
    )

    await stampTurnEnd(saver, "t1", END)

    const head = await saver.getTuple(cfg("t1"))
    expect(head?.checkpoint.id).toBe("c2")
    expect(head?.parentConfig?.configurable?.checkpoint_id).toBe("c1")
    expect(readPersistedTurnEnd(metadataOf(head)[B4_TURN_METADATA_KEY])).toEqual(END)
    expect(metadataOf(head)["b4:checkpoint-routes"]).toEqual({
      checkpointId: "c2",
      routes: ["/x#agent"],
    })
    // The chain is untouched: the parent is still readable under its own id.
    const parent = await saver.getTuple(first)
    expect(parent?.checkpoint.id).toBe("c1")
    expect(metadataOf(parent)[B4_TURN_METADATA_KEY]).toBeUndefined()
  })

  test("a root checkpoint (no parent) is re-put without inventing one", async () => {
    const saver = new MemorySaver()
    await saver.put(
      cfg("t-root"),
      checkpoint("c1") as never,
      { source: "input", step: -1, parents: {} } as never,
    )

    await stampTurnEnd(saver, "t-root", END)

    const head = await saver.getTuple(cfg("t-root"))
    expect(head?.checkpoint.id).toBe("c1")
    expect(head?.parentConfig).toBeUndefined()
    expect(readPersistedTurnEnd(metadataOf(head)[B4_TURN_METADATA_KEY])).toEqual(END)
  })

  test("never stamps a parked head: an __interrupt__ pending write means no put at all", async () => {
    const saver = new MemorySaver()
    const head = await saver.put(
      cfg("t-parked"),
      checkpoint("c1") as never,
      { source: "loop", step: 0, parents: {} } as never,
    )
    await saver.putWrites(
      head,
      [["__interrupt__", [{ value: { interruptId: "perm-1" } }]]],
      "task-1",
    )
    const puts: unknown[] = []
    const original = saver.put.bind(saver)
    saver.put = async (...args: Parameters<MemorySaver["put"]>) => {
      puts.push(args)
      return original(...args)
    }

    await stampTurnEnd(saver, "t-parked", END)

    expect(puts).toEqual([])
    const after = await saver.getTuple(cfg("t-parked"))
    expect(metadataOf(after)[B4_TURN_METADATA_KEY]).toBeUndefined()
    expect(after?.pendingWrites?.map(([, channel]) => channel)).toEqual(["__interrupt__"])
  })

  test("a thread with no checkpoint is a no-op; a saver failure is swallowed", async () => {
    const saver = new MemorySaver()
    await expect(stampTurnEnd(saver, "t-none", END)).resolves.toBeUndefined()
    const brokenRead = {
      getTuple: async () => {
        throw new Error("db down")
      },
    } as unknown as MemorySaver
    await expect(stampTurnEnd(brokenRead, "t1", END)).resolves.toBeUndefined()

    const brokenWrite = new MemorySaver()
    await brokenWrite.put(
      cfg("t1"),
      checkpoint("c1") as never,
      { source: "loop", step: 0, parents: {} } as never,
    )
    brokenWrite.put = async () => {
      throw new Error("disk full")
    }
    await expect(stampTurnEnd(brokenWrite, "t1", END)).resolves.toBeUndefined()
    expect(metadataOf(await brokenWrite.getTuple(cfg("t1")))[B4_TURN_METADATA_KEY]).toBeUndefined()
  })

  test("turnEndFor maps the handler facts: parked → none, cancelled → stopped, error → failed, else done", () => {
    const at = () => "2026-10-05T00:00:03.000Z"
    expect(turnEndFor({ sawInterrupt: true, cancelled: false }, at)).toBeUndefined()
    expect(turnEndFor({ sawInterrupt: true, cancelled: true, error: "boom" }, at)).toBeUndefined()
    expect(turnEndFor({ sawInterrupt: false, cancelled: true }, at)).toEqual({
      status: "stopped",
      endedAt: at(),
    })
    expect(turnEndFor({ sawInterrupt: false, cancelled: true, error: "boom" }, at)).toEqual({
      status: "stopped",
      endedAt: at(),
    })
    expect(turnEndFor({ sawInterrupt: false, cancelled: false, error: "boom" }, at)).toEqual({
      status: "failed",
      error: "boom",
      endedAt: at(),
    })
    expect(turnEndFor({ sawInterrupt: false, cancelled: false, error: "" }, at)).toEqual({
      status: "done",
      endedAt: at(),
    })
    expect(turnEndFor({ sawInterrupt: false, cancelled: false }, at)).toEqual({
      status: "done",
      endedAt: at(),
    })
  })

  test("readTerminalError reads the error string off a done chunk and nothing else", () => {
    expect(readTerminalError(undefined)).toBeUndefined()
    expect(readTerminalError({ type: "done", output: null })).toBeUndefined()
    expect(readTerminalError({ type: "done", output: { ok: true } })).toBeUndefined()
    expect(readTerminalError({ type: "done", output: { cancelled: true } })).toBeUndefined()
    expect(readTerminalError({ type: "done", output: { error: 42 } })).toBeUndefined()
    expect(readTerminalError({ type: "done", output: { error: "boom" } })).toBe("boom")
    expect(readTerminalError({ type: "chunk", data: { error: "boom" } })).toBeUndefined()
  })
})
