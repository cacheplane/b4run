import { AbstractAgent, type BaseEvent, type Message, verifyEvents } from "@ag-ui/client"
import { EventType, PROTOCOL_VERSION } from "@ag-ui/core"
import { EMPTY, from, lastValueFrom, toArray } from "rxjs"
import { describe, expect, it } from "vitest"
import { reduceTurns, type SubagentStep, type TurnsView } from "../../src/view/turns.ts"
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
function endedWithOpenChild(
  status: "stopped" | "done" | "failed",
  { childAt = 2, error }: { childAt?: number; error?: string } = {},
): ThreadStateForTurns {
  const child = [
    ckpt("x0", 1, [human("cu", "dig")]),
    ckpt("x1", childAt, [human("cu", "dig"), ai("ca1", "half")]),
  ]
  const turn1 = [human("u1", "go"), ai("a1", "", [task("ct", "dig")])]
  const turn2 = [...turn1, human("u2", "again"), ai("a2", "ok")]
  const root = [
    ckpt("k0", 0, turn1.slice(0, 1)),
    ckpt("k1", 1, turn1, {
      metadata: { "b4:turn": { status, endedAt: iso(3), ...(error ? { error } : {}) } },
    }),
    ckpt("k2", 4, turn2.slice(0, 3)),
    ckpt("k3", 6, turn2, { metadata: { "b4:turn": { status: "done", endedAt: iso(6) } } }),
  ]
  return base(root, { "tools:ct": child })
}

/** Two turns, the first stamped as ending after the second's user message was checkpointed (clock skew). */
function skewedEnd(): ThreadStateForTurns {
  const turn1 = [human("u1", "one"), ai("a1", "first")]
  const turn2 = [...turn1, human("u2", "two"), ai("a2", "second")]
  return base([
    ckpt("k0", 0, turn1.slice(0, 1)),
    ckpt("k1", 1, turn1, { metadata: { "b4:turn": { status: "done", endedAt: iso(5) } } }),
    ckpt("k2", 4, turn2.slice(0, 3)),
    ckpt("k3", 6, turn2, { metadata: { "b4:turn": { status: "done", endedAt: iso(6) } } }),
  ])
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

  it.each([
    [
      "a stopped turn whose open child checkpointed after the next user message",
      () => endedWithOpenChild("stopped", { childAt: 5 }),
      "stopped",
    ],
    ["a turn stamped as ending after the next user message", skewedEnd, "done"],
  ] as const)("keeps each root turn contiguous: %s", async (_, state, firstStatus) => {
    const { events, warnings } = eventsFromState(state())
    expect(warnings).toEqual([expect.stringMatching(/^clamped clocks on turn u2 /)])
    await expect(verified(events)).resolves.toHaveLength(events.length)
    const starts = events.flatMap((e, i) => (e.type === EventType.RUN_STARTED ? [i] : []))
    const ends = events.flatMap((e, i) =>
      e.type === EventType.RUN_FINISHED || e.type === EventType.RUN_ERROR ? [i] : [],
    )
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    expect(ends[0] as number).toBeLessThan(starts[1] as number)
    const { turns } = turnsFromState(state())
    expect(turns.turns.map((t) => [t.runId, t.status])).toEqual([
      ["u1", firstStatus],
      ["u2", "done"],
    ])
  })

  it("abandons an open subagent on RUN_ERROR, as live: the reducer fails it with the run's error", async () => {
    const state = endedWithOpenChild("failed", { error: "boom" })
    const { events, warnings } = eventsFromState(state)
    expect(warnings).toEqual([])
    const runError = events.findIndex((e) => e.type === EventType.RUN_ERROR)
    expect(events[runError]).toMatchObject({ runId: "u1", message: "boom" })
    expect(
      events.filter(
        (e) => e.type === EventType.SUBAGENT_ERROR || e.type === EventType.SUBAGENT_FINISHED,
      ),
    ).toEqual([])
    await expect(verified(events)).resolves.toHaveLength(events.length)
    const [first, second] = turnsFromState(state).turns.turns
    expect(first).toMatchObject({ runId: "u1", status: "failed", error: "boom" })
    expect(first?.steps[0]).toMatchObject({
      kind: "subagent",
      id: "ct",
      status: "failed",
      error: "boom",
    })
    expect((first?.steps[0] as SubagentStep | undefined)?.turn.status).toBe("failed")
    expect(second).toMatchObject({ runId: "u2", status: "done" })
  })

  it("attributes a dispatch gate's interrupt to the subagent it suspended", async () => {
    const state = parkedChild()
    const dispatch = {
      interruptId: "perm-d",
      resumeKey: "d".repeat(32),
      value: {
        interruptId: "perm-d",
        type: "permission-request",
        kind: "command",
        callId: "ct",
        detail: {},
      },
    }
    const { events } = eventsFromState({ ...state, pendingInterrupts: [dispatch] })
    expect(events.at(-2)).toMatchObject({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "ct",
      outcome: { type: "suspended", interruptIds: ["perm-d"] },
    })
    const outcome = (events.at(-1) as BaseEvent & { outcome: { interrupts: unknown[] } }).outcome
    expect(outcome.interrupts).toEqual([
      expect.objectContaining({ id: "perm-d", toolCallId: "ct", subagentRunId: "ct" }),
    ])
    await expect(verified(events)).resolves.toHaveLength(events.length)
  })

  it("replays a busy thread with its head run left open: verifier-clean, user message and announced call restored", async () => {
    const call = { id: "c2", name: "runBash", args: { command: "ls" }, type: "tool_call" }
    const turn1 = [human("u1", "one"), ai("a1", "first")]
    const turn2 = [...turn1, human("u2", "two"), ai("a2", "", [call])]
    const state = base(
      [
        ckpt("k0", 0, turn1.slice(0, 1)),
        ckpt("k1", 1, turn1, { metadata: { "b4:turn": { status: "done", endedAt: iso(1) } } }),
        ckpt("k2", 2, turn2.slice(0, 3)),
        ckpt("k3", 3, turn2),
      ],
      {},
      [],
      "busy",
    )
    const { events, warnings } = eventsFromState(state)
    expect(warnings).toEqual([])
    const terminals = events.filter(
      (e) => e.type === EventType.RUN_FINISHED || e.type === EventType.RUN_ERROR,
    )
    expect(terminals).toEqual([expect.objectContaining({ runId: "u1" })])
    const starts = ofType(events, EventType.RUN_STARTED)
    expect(starts.map((e) => e.runId)).toEqual(["u1", "u2"])
    expect(starts[1]?.input).toMatchObject({
      runId: "u2",
      messages: [{ id: "u2", role: "user", content: "two" }],
    })
    expect(events.at(-1)).toMatchObject({ type: EventType.TOOL_CALL_END, toolCallId: "c2" })
    await expect(verified(events)).resolves.toHaveLength(events.length)

    const messages = await messagesAfterConnect(events)
    expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["one", "two"])
    const announced = messages.at(-1) as Extract<Message, { role: "assistant" }>
    expect(announced.role).toBe("assistant")
    expect(announced.toolCalls?.[0]).toMatchObject({
      id: "c2",
      function: { name: "runBash", arguments: '{"command":"ls"}' },
    })
  })

  it("turnsFromState is the fold of eventsFromState through reduceTurns", () => {
    const states = [
      drained(),
      failedThenDone(),
      parkedChild(),
      endedWithOpenChild("stopped"),
      endedWithOpenChild("done"),
      endedWithOpenChild("failed", { error: "boom" }),
      endedWithOpenChild("stopped", { childAt: 5 }),
      skewedEnd(),
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
