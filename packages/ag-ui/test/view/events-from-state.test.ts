import { AbstractAgent, type BaseEvent, type Message, verifyEvents } from "@ag-ui/client"
import { EventType, PROTOCOL_VERSION } from "@ag-ui/core"
import { EMPTY, from, lastValueFrom, toArray } from "rxjs"
import { describe, expect, it } from "vitest"
import { reduceTurns, type TurnsView } from "../../src/view/turns.ts"
import {
  eventsFromState,
  type ThreadStateForTurns,
  turnsFromState,
} from "../../src/view/turns-from-state.ts"
import { ai, base, ckpt, human, iso, toolMsg } from "./state-fixtures.ts"

/** An agent whose `connect` replays `events`: the path CopilotKit's chat takes on mount. */
class ReplayAgent extends AbstractAgent {
  constructor(private readonly events: readonly BaseEvent[]) {
    super({ threadId: "t-1" })
  }
  run() {
    return EMPTY
  }
  protected override connect() {
    return from(this.events)
  }
}

async function messagesAfterConnect(events: readonly BaseEvent[]): Promise<Message[]> {
  const agent = new ReplayAgent(events)
  await agent.connectAgent()
  return agent.messages
}

async function verified(events: readonly BaseEvent[]): Promise<BaseEvent[]> {
  return lastValueFrom(from(events).pipe(verifyEvents(), toArray()))
}

const ofType = (events: readonly BaseEvent[], type: EventType) =>
  events.filter((e) => e.type === type) as (BaseEvent & Record<string, unknown>)[]

/** user "search" → a `searchCorpus` call → its stamped result → "Found it." */
function drained(): ThreadStateForTurns {
  const search = { id: "c1", name: "searchCorpus", args: { query: "x" }, type: "tool_call" }
  const stamp = { status: "completed", startedAt: iso(1), settledAt: iso(2) }
  const turn = [
    human("u1", "search"),
    ai("a1", "", [search]),
    toolMsg("c1", "searchCorpus", "3 hits", stamp),
    ai("a2", "Found it."),
  ]
  return base([
    ckpt("k0", 0, turn.slice(0, 1)),
    ckpt("k1", 1, turn.slice(0, 2)),
    ckpt("k2", 2, turn.slice(0, 3)),
    ckpt("k3", 3, turn, { metadata: { "b4:turn": { status: "done", endedAt: iso(3) } } }),
  ])
}

/** Two turns, the first failed. */
function failedThenDone(): ThreadStateForTurns {
  const turn1 = [human("u1", "one"), ai("a1", "first")]
  const turn2 = [...turn1, human("u2", "two"), ai("a2", "second")]
  return base([
    ckpt("k0", 0, turn1.slice(0, 1)),
    ckpt("k1", 1, turn1, {
      metadata: { "b4:turn": { status: "failed", error: "model unavailable", endedAt: iso(1) } },
    }),
    ckpt("k2", 2, turn2.slice(0, 3)),
    ckpt("k3", 3, turn2, { metadata: { "b4:turn": { status: "done", endedAt: iso(3) } } }),
  ])
}

const task = (id: string, input: string) => ({
  id,
  name: "task",
  args: { subagent: "researcher", input },
  type: "tool_call",
})

/** A parked head: an open `task` whose child is parked at a gate. */
function parkedChild(): ThreadStateForTurns {
  const run = { id: "n1", name: "runBash", args: { command: "ls" }, type: "tool_call" }
  const child = [
    ckpt("x0", 1, [human("cu", "dig")]),
    ckpt("x1", 2, [human("cu", "dig"), ai("ca1", "", [run])]),
  ]
  const root = [
    ckpt("k0", 0, [human("u1", "go")]),
    ckpt("k1", 1, [human("u1", "go"), ai("a1", "", [task("ct", "dig")])]),
  ]
  const pending = [
    {
      interruptId: "perm-2",
      resumeKey: "b".repeat(32),
      value: {
        interruptId: "perm-2",
        type: "permission-request",
        kind: "command",
        callId: "ct",
        toolCallId: "n1",
        detail: { command: "ls" },
      },
    },
  ]
  return base(root, { "tools:ct": child }, pending, "interrupted")
}

/** A turn that ended (`status`) with its `task` call still open, followed by a second turn. */
function endedWithOpenChild(status: "stopped" | "done"): ThreadStateForTurns {
  const child = [
    ckpt("x0", 1, [human("cu", "dig")]),
    ckpt("x1", 2, [human("cu", "dig"), ai("ca1", "half")]),
  ]
  const turn1 = [human("u1", "go"), ai("a1", "", [task("ct", "dig")])]
  const turn2 = [...turn1, human("u2", "again"), ai("a2", "ok")]
  const root = [
    ckpt("k0", 0, turn1.slice(0, 1)),
    ckpt("k1", 1, turn1, { metadata: { "b4:turn": { status, endedAt: iso(3) } } }),
    ckpt("k2", 4, turn2.slice(0, 3)),
    ckpt("k3", 5, turn2, { metadata: { "b4:turn": { status: "done", endedAt: iso(5) } } }),
  ]
  return base(root, { "tools:ct": child })
}

/** A finished `task` whose stamp settled before the child's last checkpoint. */
function lateChild(): ThreadStateForTurns {
  const child = [
    ckpt("x0", 1, [human("cu", "dig")]),
    ckpt("x1", 2, [human("cu", "dig"), ai("ca1", "early")]),
    ckpt("x2", 6, [human("cu", "dig"), ai("ca1", "early"), ai("ca2", "late")]),
  ]
  const subagent = {
    name: "researcher",
    routeId: "/r",
    depth: 1,
    checkpointNs: "tools:ct",
    outcome: "done",
  }
  const turn = [
    human("u1", "go"),
    ai("a1", "", [task("ct", "dig")]),
    toolMsg(
      "ct",
      "task",
      "late",
      { status: "completed", startedAt: iso(1), settledAt: iso(3) },
      { b4_subagent: subagent },
    ),
  ]
  const root = [
    ckpt("k0", 0, turn.slice(0, 1)),
    ckpt("k1", 1, turn.slice(0, 2)),
    ckpt("k2", 7, turn, { metadata: { "b4:turn": { status: "done", endedAt: iso(7) } } }),
  ]
  return base(root, { "tools:ct": child })
}

describe("eventsFromState", () => {
  it("replays a drained turn as a complete chat: user input, timestamps, verifier-clean, CopilotKit messages", async () => {
    const state = drained()
    const { events, warnings } = eventsFromState(state)
    expect(warnings).toEqual([])
    expect(events[0]).toEqual({
      type: EventType.RUN_STARTED,
      threadId: "t-1",
      runId: "u1",
      protocolVersion: PROTOCOL_VERSION,
      input: {
        threadId: "t-1",
        runId: "u1",
        messages: [{ id: "u1", role: "user", content: "search" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      timestamp: expect.any(Number),
    })
    let previous = Number.NEGATIVE_INFINITY
    for (const event of events) {
      expect(typeof event.timestamp).toBe("number")
      expect(event.timestamp as number).toBeGreaterThanOrEqual(previous)
      previous = event.timestamp as number
    }
    expect(await verified(events)).toHaveLength(events.length)

    const messages = await messagesAfterConnect(events)
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    expect(messages[0]).toMatchObject({ id: "u1", content: "search" })
    const call = messages[1] as Extract<Message, { role: "assistant" }>
    expect(call.toolCalls?.[0]?.function.name).toBe("searchCorpus")
    expect(messages[2]).toMatchObject({ role: "tool", toolCallId: call.toolCalls?.[0]?.id })
    expect(messages[3]).toMatchObject({ id: "a2", role: "assistant", content: "Found it." })
  })

  it("replays a failed turn followed by another: both user messages, verifier-clean", async () => {
    const { events } = eventsFromState(failedThenDone())
    expect(ofType(events, EventType.RUN_ERROR)).toHaveLength(1)
    await expect(verified(events)).resolves.toHaveLength(events.length)
    const messages = await messagesAfterConnect(events)
    expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["one", "two"])
  })

  it("suspends a parked head's open subagent before the interrupt, attributing its interrupt", async () => {
    const { events, warnings } = eventsFromState(parkedChild())
    expect(warnings).toEqual([])
    const last = events.at(-1) as BaseEvent & Record<string, unknown>
    expect(last.type).toBe(EventType.RUN_FINISHED)
    const outcome = last.outcome as { type: string; interrupts: { subagentRunId?: string }[] }
    expect(outcome.type).toBe("interrupt")
    expect(outcome.interrupts[0]?.subagentRunId).toBe("ct")
    expect(events.at(-2)).toMatchObject({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "ct",
      outcome: { type: "suspended", interruptIds: ["perm-2"] },
    })
    await expect(verified(events)).resolves.toHaveLength(events.length)
  })

  it.each([
    ["stopped", "cancelled", "The run was cancelled.", "cancelled"],
    ["done", "unterminated", "The run ended before the subagent finished.", "success"],
  ] as const)(
    "closes an open subagent when a %s turn ends (%s)",
    async (status, code, message, outcomeType) => {
      const { events, warnings } = eventsFromState(endedWithOpenChild(status))
      expect(warnings).toEqual([])
      const firstEnd = events.findIndex((e) => e.type === EventType.RUN_FINISHED)
      expect(events[firstEnd]).toMatchObject({ runId: "u1", outcome: { type: outcomeType } })
      expect(events[firstEnd - 1]).toMatchObject({
        type: EventType.SUBAGENT_ERROR,
        subagentRunId: "ct",
        message,
        code,
      })
      await expect(verified(events)).resolves.toHaveLength(events.length)
    },
  )

  it("finishes a subagent after its child's latest event, even when the stamp settled earlier", async () => {
    const { events } = eventsFromState(lateChild())
    const finished = events.findIndex((e) => e.type === EventType.SUBAGENT_FINISHED)
    const owned = events.flatMap((e, i) =>
      e.type !== EventType.SUBAGENT_FINISHED &&
      (e as unknown as Record<string, unknown>).subagentRunId === "ct"
        ? [i]
        : [],
    )
    expect(owned.length).toBeGreaterThan(0)
    expect(finished).toBeGreaterThan(Math.max(...owned))
    await expect(verified(events)).resolves.toHaveLength(events.length)
  })

  it("turnsFromState is the fold of eventsFromState through reduceTurns", () => {
    const states = [
      drained(),
      failedThenDone(),
      parkedChild(),
      endedWithOpenChild("stopped"),
      endedWithOpenChild("done"),
      lateChild(),
    ]
    for (const state of states) {
      let view: TurnsView = { threadId: state.threadId, turns: [] }
      for (const event of eventsFromState(state).events) {
        view = reduceTurns(view, event, { now: () => event.timestamp ?? 0, resuming: false })
      }
      expect(turnsFromState(state).turns).toEqual(view)
    }
  })

  it("returns no events and the warnings for input that is not an object", () => {
    expect(eventsFromState(null as never)).toEqual({
      events: [],
      warnings: ["input is not an object"],
    })
  })
})
