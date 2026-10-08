import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import {
  EMPTY_TURNS,
  reduceTurns,
  type SubagentStep,
  type TurnsView,
  type TurnView,
} from "../../src/view/turns.ts"
import { turnsFromState } from "../../src/view/turns-from-state.ts"
import { ai, base, ckpt, env, human, iso, T0, toolMsg } from "./state-fixtures.ts"

const firstTurn = (view: TurnsView): TurnView => view.turns[0] as TurnView

describe("turnsFromState", () => {
  test("one turn: user message opens it, tool call + result become a done step with the stamped times, b4:turn closes it", () => {
    const search = { id: "c1", name: "searchCorpus", args: { query: "ReAct" }, type: "tool_call" }
    const stamp = {
      status: "completed",
      icon: "search",
      label: "Searched the corpus",
      startedAt: iso(1),
      settledAt: iso(3),
    }
    const history = [
      ckpt("k0", 0, [human("u1", "Compare ReAct")]),
      ckpt("k1", 1, [human("u1", "Compare ReAct"), ai("a1", "", [search])]),
      ckpt("k2", 4, [
        human("u1", "Compare ReAct"),
        ai("a1", "", [search]),
        toolMsg("c1", "searchCorpus", "3 hits", stamp),
      ]),
      ckpt(
        "k3",
        6,
        [
          human("u1", "Compare ReAct"),
          ai("a1", "", [search]),
          toolMsg("c1", "searchCorpus", "3 hits", stamp),
          ai("a2", "ReAct interleaves…"),
        ],
        { metadata: { "b4:turn": { status: "done", endedAt: iso(6) } } },
      ),
    ]
    const { turns, warnings } = turnsFromState(base(history))
    expect(warnings).toEqual([])
    expect(turns.threadId).toBe("t-1")
    expect(turns.turns).toHaveLength(1)
    const turn = firstTurn(turns)
    expect(turn).toMatchObject({
      runId: "u1",
      status: "done",
      startedAt: T0,
      endedAt: T0 + 6000,
      text: "ReAct interleaves…",
      failed: 0,
    })
    expect(turn.steps).toEqual([
      expect.objectContaining({
        kind: "tool",
        id: "c1",
        name: "searchCorpus",
        status: "done",
        args: '{"query":"ReAct"}',
        result: "3 hits",
        label: "Searched the corpus",
        icon: "search",
        startedAt: T0 + 1000,
        settledAt: T0 + 3000,
      }),
    ])
  })

  test("a denied step, its decision, reasoning blocks and a plan snapshot", () => {
    const call = { id: "c1", name: "runBash", args: { command: "node x" }, type: "tool_call" }
    const todos = [
      { content: "a", status: "completed" },
      { content: "b", status: "pending" },
    ]
    const history = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt(
        "k1",
        1,
        [
          human("u1", "go"),
          ai(
            "a1",
            [
              { type: "thinking", thinking: "plan it" },
              { type: "text", text: "" },
            ],
            [call],
          ),
        ],
        { todos },
      ),
      ckpt(
        "k2",
        3,
        [
          human("u1", "go"),
          ai("a1", [{ type: "thinking", thinking: "plan it" }], [call]),
          toolMsg("c1", "runBash", "[B4_E3001] Permission denied by user: command", {
            status: "denied",
            icon: "run",
            decision: "deny",
            startedAt: iso(1),
            settledAt: iso(2),
          }),
        ],
        { todos, metadata: { "b4:turn": { status: "done", endedAt: iso(3) } } },
      ),
    ]
    const { turns } = turnsFromState(base(history))
    const turn = firstTurn(turns)
    // The todos first appear in k1, so the snapshot lands at that checkpoint
    // boundary: before the messages k1 added (the reasoning and the call).
    expect(turn.steps.map((s) => s.kind)).toEqual(["plan", "reasoning", "tool"])
    expect(turn.steps[1]).toMatchObject({ kind: "reasoning", text: "plan it", status: "done" })
    expect(turn.steps[0]).toMatchObject({ kind: "plan", todos })
    expect(turn.steps[2]).toMatchObject({
      kind: "tool",
      status: "denied",
      icon: "run",
      result: "[B4_E3001] Permission denied by user: command",
    })
    expect(turn.steps[2]).not.toHaveProperty("label")
    expect(turn.failed).toBe(0)
  })

  test("a root writeTodos call becomes the plan where live showed it: after the message's other calls, its own frames dropped", () => {
    const plan = { id: "cp", name: "writeTodos", args: { todos: [] }, type: "tool_call" }
    const run = { id: "c1", name: "runBash", args: { command: "ls" }, type: "tool_call" }
    const todos = [{ content: "a", status: "pending" }]
    const done = (startedAt: number, settledAt: number) => ({
      status: "completed",
      startedAt: iso(startedAt),
      settledAt: iso(settledAt),
    })
    const history = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [
        human("u1", "go"),
        ai("a1", [{ type: "thinking", thinking: "hm" }], [plan, run]),
      ]),
      ckpt(
        "k2",
        3,
        [
          human("u1", "go"),
          ai("a1", [{ type: "thinking", thinking: "hm" }], [plan, run]),
          toolMsg("cp", "writeTodos", "Updated", done(1, 2)),
          toolMsg("c1", "runBash", "a.md", done(1, 3)),
        ],
        { todos, metadata: { "b4:turn": { status: "done", endedAt: iso(3) } } },
      ),
    ]
    const { turns, warnings } = turnsFromState(base(history))
    expect(warnings).toEqual([])
    const turn = firstTurn(turns)
    expect(turn.steps.map((s) => s.kind)).toEqual(["reasoning", "tool", "plan"])
    expect(turn.steps[1]).toMatchObject({ kind: "tool", id: "c1", status: "done", result: "a.md" })
    // Timed by the writeTodos result that produced it, as live was, not by the checkpoint.
    expect(turn.steps[2]).toMatchObject({ kind: "plan", todos, startedAt: T0 + 2000 })
  })

  test("a task ToolMessage nests the child namespace's turn", () => {
    const task = {
      id: "ct",
      name: "task",
      args: { subagent: "researcher", input: "summarize" },
      type: "tool_call",
    }
    const read = { id: "n1", name: "readDoc", args: { path: "a.md" }, type: "tool_call" }
    const child = [
      ckpt("x0", 1, [human("cu", "summarize")]),
      ckpt("x1", 2, [human("cu", "summarize"), ai("ca1", "", [read])]),
      ckpt("x2", 4, [
        human("cu", "summarize"),
        ai("ca1", "", [read]),
        toolMsg("n1", "readDoc", "…", {
          status: "completed",
          label: "Read a.md",
          startedAt: iso(2),
          settledAt: iso(3),
        }),
        ai("ca2", "ReAct is…"),
      ]),
    ]
    const root = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), ai("a1", "", [task])]),
      ckpt(
        "k2",
        5,
        [
          human("u1", "go"),
          ai("a1", "", [task]),
          toolMsg(
            "ct",
            "task",
            "ReAct is…",
            {
              status: "completed",
              icon: "agent",
              label: "Heard back from researcher",
              startedAt: iso(1),
              settledAt: iso(5),
            },
            {
              b4_subagent: {
                name: "researcher",
                routeId: "/researcher",
                description: "Finds sources",
                depth: 1,
                checkpointNs: "tools:abc",
                outcome: "done",
              },
            },
          ),
          ai("a2", "Done."),
        ],
        { metadata: { "b4:turn": { status: "done", endedAt: iso(5) } } },
      ),
    ]
    const { turns, warnings } = turnsFromState(base(root, { "tools:abc": child }))
    expect(warnings).toEqual([])
    const sub = firstTurn(turns).steps.find((s) => s.kind === "subagent") as SubagentStep
    expect(sub).toMatchObject({
      kind: "subagent",
      id: "ct",
      name: "researcher",
      description: "Finds sources",
      status: "done",
    })
    expect(sub.turn.steps).toEqual([
      expect.objectContaining({ kind: "tool", id: "n1", label: "Read a.md", status: "done" }),
    ])
    expect(sub.turn.text).toBe("ReAct is…")
  })

  test("a parked head yields an awaiting turn with the approval attached to its step", () => {
    const call = { id: "c1", name: "runBash", args: { command: "node x" }, type: "tool_call" }
    const history = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), ai("a1", "", [call])]),
    ]
    const pending = [
      {
        interruptId: "perm-1",
        resumeKey: "a".repeat(32),
        grant: "g-1",
        value: {
          interruptId: "perm-1",
          type: "permission-request",
          kind: "command",
          toolCallId: "c1",
          detail: { command: "node x", suggestedPattern: "node" },
        },
      },
    ]
    const { turns } = turnsFromState(base(history, {}, pending, "interrupted"))
    const turn = firstTurn(turns)
    expect(turn.status).toBe("awaiting")
    expect(turn.steps[0]).toMatchObject({
      kind: "tool",
      id: "c1",
      status: "awaiting",
      approval: expect.objectContaining({
        interruptId: "perm-1",
        kind: "command",
        offersAlways: true,
        grant: "g-1",
      }),
    })
  })

  test("a parked call shows the running display its interrupt kept, as live did", () => {
    const call = {
      id: "c1",
      name: "fileFlightPlan",
      args: { flightPlan: { item7: "N738ZU" } },
      type: "tool_call",
    }
    const history = [
      ckpt("k0", 0, [human("u1", "file it")]),
      ckpt("k1", 1, [human("u1", "file it"), ai("a1", "", [call])]),
    ]
    const value = (step: unknown) => ({
      interruptId: "perm-1",
      type: "permission-request",
      kind: "tool",
      toolCallId: "c1",
      ...(step !== undefined ? { step } : {}),
      detail: { toolName: "fileFlightPlan", argsPreview: "{}", suggestedPattern: "fileFlightPlan" },
    })
    const restore = (step: unknown) =>
      firstTurn(
        turnsFromState(
          base(history, {}, [{ interruptId: "perm-1", value: value(step) }], "interrupted"),
        ).turns,
      ).steps[0]
    expect(restore({ icon: "write", label: "File N738ZU KSTP to KRST" })).toMatchObject({
      status: "awaiting",
      icon: "write",
      label: "File N738ZU KSTP to KRST",
    })
    // An older interrupt without `step`, or a malformed one, leaves the step bare.
    for (const step of [undefined, "File it", { icon: "nope", label: 7 }]) {
      const restored = restore(step)
      expect(restored).toMatchObject({ status: "awaiting" })
      expect(restored).not.toHaveProperty("label")
      expect(restored).not.toHaveProperty("icon")
    }
  })

  test("a restored every-call tool prompt does not offer always", () => {
    const call = { id: "c1", name: "fileFlightPlan", args: {}, type: "tool_call" }
    const history = [
      ckpt("k0", 0, [human("u1", "file it")]),
      ckpt("k1", 1, [human("u1", "file it"), ai("a1", "", [call])]),
    ]
    const pending = [
      {
        interruptId: "perm-1",
        resumeKey: "a".repeat(32),
        value: {
          interruptId: "perm-1",
          type: "permission-request",
          kind: "tool",
          allowAlways: false,
          toolCallId: "c1",
          detail: {
            toolName: "fileFlightPlan",
            argsPreview: "{}",
            suggestedPattern: "fileFlightPlan",
          },
        },
      },
    ]
    const { turns } = turnsFromState(base(history, {}, pending, "interrupted"))
    expect(firstTurn(turns).steps[0]).toMatchObject({
      id: "c1",
      status: "awaiting",
      approval: expect.objectContaining({ interruptId: "perm-1", offersAlways: false }),
    })
  })

  test("a failed and a stopped turn, two turns delimited by user messages", () => {
    const history = [
      ckpt("k0", 0, [human("u1", "one")]),
      ckpt("k1", 1, [human("u1", "one"), ai("a1", "first")], {
        metadata: { "b4:turn": { status: "failed", error: "model unavailable", endedAt: iso(1) } },
      }),
      ckpt("k2", 2, [human("u1", "one"), ai("a1", "first"), human("u2", "two")]),
      ckpt("k3", 3, [human("u1", "one"), ai("a1", "first"), human("u2", "two"), ai("a2", "sec")], {
        metadata: { "b4:turn": { status: "stopped", endedAt: iso(3) } },
      }),
    ]
    const { turns } = turnsFromState(base(history))
    expect(turns.turns.map((t) => [t.runId, t.status, t.error])).toEqual([
      ["u1", "failed", "model unavailable"],
      ["u2", "stopped", undefined],
    ])
  })

  test("missing or malformed stamps are ignored with a warning; the function never throws", () => {
    const call = { id: "c1", name: "x", args: {}, type: "tool_call" }
    const history = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [
        human("u1", "go"),
        ai("a1", "", [call]),
        env("ToolMessage", { tool_call_id: "c1", name: "x", content: "v", additional_kwargs: {} }),
      ]),
    ]
    const { turns, warnings } = turnsFromState(
      base(history, { "tools:ghost": [ckpt("g0", 0, [human("gu", "hi")])] }),
    )
    expect(firstTurn(turns).steps[0]).toMatchObject({
      kind: "tool",
      id: "c1",
      status: "done",
      result: "v",
    })
    expect(warnings).toEqual([
      expect.stringContaining("c1"),
      expect.stringContaining("tools:ghost"),
    ])
    expect(() =>
      turnsFromState({
        threadId: "t",
        status: "idle",
        root: [
          { id: "k", ts: "bad", metadata: null as never, values: { messages: [null, 5, {}] } },
        ],
        children: {},
        pendingInterrupts: [],
      }),
    ).not.toThrow()
  })

  test("a busy head stays working while an earlier unstamped turn still closes", () => {
    const call = { id: "c2", name: "x", args: {}, type: "tool_call" }
    const history = [
      ckpt("k0", 0, [human("u1", "one")]),
      ckpt("k1", 1, [human("u1", "one"), ai("a1", "first")]),
      ckpt("k2", 2, [human("u1", "one"), ai("a1", "first"), human("u2", "two")]),
      ckpt("k3", 3, [
        human("u1", "one"),
        ai("a1", "first"),
        human("u2", "two"),
        ai("a2", "", [call]),
      ]),
    ]
    const { turns } = turnsFromState(base(history, {}, [], "busy"))
    expect(turns.turns.map((t) => [t.runId, t.status, t.endedAt])).toEqual([
      ["u1", "done", T0 + 1000],
      ["u2", "working", undefined],
    ])
    expect(turns.turns[1]?.steps[0]).toMatchObject({ kind: "tool", id: "c2", status: "running" })
  })

  test("live and restored views agree: the synthesised events reduce to the same turns as the hand-written live stream", () => {
    const search = { id: "c1", name: "searchCorpus", args: { query: "ReAct" }, type: "tool_call" }
    const stamp = {
      status: "completed",
      icon: "search",
      label: "Searched the corpus",
      startedAt: iso(1),
      settledAt: iso(3),
    }
    const history = [
      ckpt("k0", 0, [human("u1", "Compare ReAct")]),
      ckpt("k1", 1, [human("u1", "Compare ReAct"), ai("a1", "", [search])]),
      ckpt(
        "k2",
        4,
        [
          human("u1", "Compare ReAct"),
          ai("a1", "", [search]),
          toolMsg("c1", "searchCorpus", "3 hits", stamp),
          ai("a2", "ReAct interleaves…"),
        ],
        { metadata: { "b4:turn": { status: "done", endedAt: iso(6) } } },
      ),
    ]
    const restored = turnsFromState(base(history)).turns

    let clock = T0
    const now = () => clock
    const live: Array<[number, BaseEvent]> = [
      [0, { type: EventType.RUN_STARTED, threadId: "t-1", runId: "u1" } as BaseEvent],
      [
        1,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "c1",
          toolCallName: "searchCorpus",
        } as BaseEvent,
      ],
      [
        1,
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "c1",
          delta: '{"query":"ReAct"}',
        } as BaseEvent,
      ],
      [1, { type: EventType.TOOL_CALL_END, toolCallId: "c1" } as BaseEvent],
      [
        3,
        {
          type: EventType.CUSTOM,
          name: "b4.step",
          value: {
            toolCallId: "c1",
            status: "completed",
            icon: "search",
            label: "Searched the corpus",
          },
        } as BaseEvent,
      ],
      [
        3,
        {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "c1",
          messageId: "tr-1",
          content: "3 hits",
        } as BaseEvent,
      ],
      [4, { type: EventType.TEXT_MESSAGE_START, messageId: "a2", role: "assistant" } as BaseEvent],
      [
        4,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "a2",
          delta: "ReAct interleaves…",
        } as BaseEvent,
      ],
      [4, { type: EventType.TEXT_MESSAGE_END, messageId: "a2" } as BaseEvent],
      [
        6,
        {
          type: EventType.RUN_FINISHED,
          threadId: "t-1",
          runId: "u1",
          outcome: { type: "success" },
        } as BaseEvent,
      ],
    ]
    let view: TurnsView = { turns: [] }
    for (const [s, event] of live) {
      clock = T0 + s * 1000
      view = reduceTurns(view, event, { now })
    }
    expect(restored).toEqual(view)
  })

  const openChild = () => {
    const task = {
      id: "ct",
      name: "task",
      args: { subagent: "researcher", input: "dig" },
      type: "tool_call",
    }
    const run = { id: "n1", name: "runBash", args: { command: "ls" }, type: "tool_call" }
    const child = [
      ckpt("x0", 1, [human("cu", "dig")]),
      ckpt("x1", 2, [human("cu", "dig"), ai("ca1", "", [run])]),
    ]
    const root = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), ai("a1", "", [task])]),
    ]
    return { root, child }
  }

  test("a parked child's gate pauses the subagent its open task call attached by input", () => {
    const { root, child } = openChild()
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
    const { turns, warnings } = turnsFromState(
      base(root, { "tools:ct": child }, pending, "interrupted"),
    )
    expect(warnings).toEqual([])
    const turn = firstTurn(turns)
    expect(turn.status).toBe("awaiting")
    const sub = turn.steps[0] as SubagentStep
    expect(sub).toMatchObject({ kind: "subagent", id: "ct", name: "researcher", status: "paused" })
    expect(sub.turn.status).toBe("awaiting")
    expect(sub.turn.steps[0]).toMatchObject({
      kind: "tool",
      id: "n1",
      status: "awaiting",
      approval: expect.objectContaining({ interruptId: "perm-2", kind: "command" }),
    })
  })

  test("a busy head with a running child shows the subagent running", () => {
    const { root, child } = openChild()
    const { turns, warnings } = turnsFromState(base(root, { "tools:ct": child }, [], "busy"))
    expect(warnings).toEqual([])
    const turn = firstTurn(turns)
    expect(turn.status).toBe("working")
    const sub = turn.steps[0] as SubagentStep
    expect(sub).toMatchObject({ kind: "subagent", id: "ct", status: "running" })
    expect(sub.turn.status).toBe("working")
    expect(sub.turn.steps[0]).toMatchObject({ kind: "tool", id: "n1", status: "running" })
  })

  test("a task ToolMessage with no b4_step still frames its child, with one warning", () => {
    const task = {
      id: "ct",
      name: "task",
      args: { subagent: "r", input: "dig" },
      type: "tool_call",
    }
    const read = { id: "n1", name: "readDoc", args: {}, type: "tool_call" }
    const child = [
      ckpt("x0", 1, [human("cu", "dig")]),
      ckpt("x1", 2, [human("cu", "dig"), ai("ca1", "", [read])]),
      ckpt("x2", 4, [
        human("cu", "dig"),
        ai("ca1", "", [read]),
        toolMsg("n1", "readDoc", "txt", {
          status: "completed",
          startedAt: iso(2),
          settledAt: iso(3),
        }),
      ]),
    ]
    const subagent = {
      name: "r",
      routeId: "/r",
      depth: 1,
      checkpointNs: "tools:ct",
      outcome: "done",
    }
    const root = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), ai("a1", "", [task])]),
      ckpt(
        "k2",
        5,
        [
          human("u1", "go"),
          ai("a1", "", [task]),
          env("ToolMessage", {
            tool_call_id: "ct",
            name: "task",
            content: "ok",
            additional_kwargs: { b4_subagent: subagent },
          }),
        ],
        { metadata: { "b4:turn": { status: "done", endedAt: iso(5) } } },
      ),
    ]
    const { turns, warnings } = turnsFromState(base(root, { "tools:ct": child }))
    // The child is framed at the task's ToolMessage time, so its earlier stamp clocks are clamped and say so.
    expect(warnings).toEqual([
      expect.stringMatching(/clamped b4_step clocks on tool call n1/),
      expect.stringMatching(/missing b4_step on tool call ct/),
    ])
    const sub = firstTurn(turns).steps[0] as SubagentStep
    expect(sub).toMatchObject({ kind: "subagent", id: "ct", status: "done", startedAt: T0 + 5000 })
    expect(sub.turn.steps).toEqual([
      expect.objectContaining({ kind: "tool", id: "n1", status: "done", result: "txt" }),
    ])
  })

  test("a stamp clock behind the model checkpoint is clamped, so the step still settles done", () => {
    const call = { id: "c1", name: "x", args: {}, type: "tool_call" }
    const history = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 5, [human("u1", "go"), ai("a1", "", [call])]),
      ckpt(
        "k2",
        6,
        [
          human("u1", "go"),
          ai("a1", "", [call]),
          toolMsg("c1", "x", "v", { status: "completed", startedAt: iso(1), settledAt: iso(2) }),
        ],
        { metadata: { "b4:turn": { status: "done", endedAt: iso(6) } } },
      ),
    ]
    const { turns, warnings } = turnsFromState(base(history))
    const turn = firstTurn(turns)
    expect(turn.steps[0]).toMatchObject({
      kind: "tool",
      id: "c1",
      status: "done",
      startedAt: T0 + 5000,
      settledAt: T0 + 5000,
    })
    expect(turn.failed).toBe(0)
    expect(warnings).toEqual([expect.stringMatching(/clamped b4_step clocks on tool call c1/)])
  })

  test("a thrown root writeTodos keeps its empty plan when the plan change belongs to a later turn", () => {
    const cp = { id: "cp", name: "writeTodos", args: { todos: [] }, type: "tool_call" }
    const cp2 = { id: "cp2", name: "writeTodos", args: { todos: [] }, type: "tool_call" }
    const todos = [{ content: "a", status: "pending" }]
    const turn1 = [
      human("u1", "go"),
      ai("a1", "", [cp]),
      toolMsg(
        "cp",
        "writeTodos",
        "boom",
        { status: "failed", startedAt: iso(1), settledAt: iso(2) },
        {},
        "error",
      ),
    ]
    const turn2 = [
      ...turn1,
      human("u2", "again"),
      ai("a2", "", [cp2]),
      toolMsg("cp2", "writeTodos", "Updated", {
        status: "completed",
        startedAt: iso(4),
        settledAt: iso(5),
      }),
    ]
    const history = [
      ckpt("k0", 0, [turn1[0]]),
      ckpt("k1", 1, turn1.slice(0, 2)),
      ckpt("k2", 2, turn1, { metadata: { "b4:turn": { status: "done", endedAt: iso(2) } } }),
      ckpt("k3", 3, turn2.slice(0, 4)),
      ckpt("k4", 4, turn2.slice(0, 5)),
      ckpt("k5", 5, turn2, { todos, metadata: { "b4:turn": { status: "done", endedAt: iso(5) } } }),
    ]
    const { turns } = turnsFromState(base(history))
    expect(turns.turns.map((t) => t.steps)).toEqual([
      [expect.objectContaining({ kind: "plan", todos: [] })],
      [expect.objectContaining({ kind: "plan", todos, startedAt: T0 + 5000 })],
    ])
    expect(turns.turns.map((t) => t.failed)).toEqual([0, 0])
  })

  test("a task ToolMessage whose subagent failed ends the nested turn failed", () => {
    const task = {
      id: "ct",
      name: "task",
      args: { subagent: "r", input: "dig" },
      type: "tool_call",
    }
    const child = [
      ckpt("x0", 1, [human("cu", "dig")]),
      ckpt("x1", 2, [human("cu", "dig"), ai("ca1", "half")]),
    ]
    const subagent = {
      name: "r",
      routeId: "/r",
      depth: 1,
      checkpointNs: "tools:ct",
      outcome: "failed",
      error: "boom",
    }
    const root = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), ai("a1", "", [task])]),
      ckpt(
        "k2",
        4,
        [
          human("u1", "go"),
          ai("a1", "", [task]),
          toolMsg(
            "ct",
            "task",
            "subagent_failed: boom",
            { status: "failed", startedAt: iso(1), settledAt: iso(3) },
            { b4_subagent: subagent },
            "error",
          ),
        ],
        { metadata: { "b4:turn": { status: "done", endedAt: iso(4) } } },
      ),
    ]
    const turn = firstTurn(turnsFromState(base(root, { "tools:ct": child })).turns)
    const sub = turn.steps[0] as SubagentStep
    expect(sub).toMatchObject({
      kind: "subagent",
      status: "failed",
      error: "boom",
      settledAt: T0 + 3000,
    })
    expect(sub.turn).toMatchObject({ status: "failed", error: "boom", text: "half" })
    expect(turn.failed).toBe(1)
  })

  test("parallel calls keep call order while settling in reverse", () => {
    const c1 = { id: "c1", name: "slow", args: {}, type: "tool_call" }
    const c2 = { id: "c2", name: "fast", args: {}, type: "tool_call" }
    const history = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), ai("a1", "", [c1, c2])]),
      ckpt(
        "k2",
        5,
        [
          human("u1", "go"),
          ai("a1", "", [c1, c2]),
          toolMsg("c1", "slow", "s", { status: "completed", startedAt: iso(1), settledAt: iso(4) }),
          toolMsg("c2", "fast", "f", { status: "completed", startedAt: iso(1), settledAt: iso(2) }),
        ],
        { metadata: { "b4:turn": { status: "done", endedAt: iso(5) } } },
      ),
    ]
    const turn = firstTurn(turnsFromState(base(history)).turns)
    expect(turn.steps).toEqual([
      expect.objectContaining({ id: "c1", status: "done", result: "s", settledAt: T0 + 4000 }),
      expect.objectContaining({ id: "c2", status: "done", result: "f", settledAt: T0 + 2000 }),
    ])
  })

  test("malformed input never throws and is named", () => {
    expect(turnsFromState(null as never)).toEqual({
      turns: EMPTY_TURNS,
      warnings: ["input is not an object"],
    })
    const inputs: unknown[] = [
      undefined,
      "x",
      42,
      { threadId: "t", status: "idle", root: [], children: "x", pendingInterrupts: "y" },
      {
        threadId: 1,
        status: "weird",
        root: [{ ts: "bad", metadata: "m", values: 3 }, null],
        children: { a: 5 },
        pendingInterrupts: [1],
      },
      { threadId: "t", status: "busy", root: "nope" },
    ]
    for (const input of inputs) expect(() => turnsFromState(input as never)).not.toThrow()
    const { turns, warnings } = turnsFromState({
      threadId: "t",
      status: "idle",
      root: [],
      children: "x",
      pendingInterrupts: "y",
    } as never)
    expect(turns).toEqual({ threadId: "t", turns: [] })
    expect(warnings).toEqual(["children is not an object", "pendingInterrupts is not an array"])
  })

  test("live and restored views agree on reasoning, a plan, a child with its own call and a failed root call", () => {
    const todos = [{ content: "a", status: "pending" }]
    const planCall = { id: "cp", name: "writeTodos", args: { todos }, type: "tool_call" }
    const task = {
      id: "ct",
      name: "task",
      args: { subagent: "researcher", input: "dig" },
      type: "tool_call",
    }
    const bash = { id: "c1", name: "runBash", args: { command: "rm" }, type: "tool_call" }
    const read = { id: "n1", name: "readDoc", args: { path: "a.md" }, type: "tool_call" }
    const a1 = ai("a1", [{ type: "thinking", thinking: "think" }], [planCall, task, bash])
    const child = [
      ckpt("x0", 1, [human("cu", "dig")]),
      ckpt("x1", 2, [human("cu", "dig"), ai("ca1", "", [read])]),
      ckpt("x2", 4, [
        human("cu", "dig"),
        ai("ca1", "", [read]),
        toolMsg("n1", "readDoc", "txt", {
          status: "completed",
          label: "Read a.md",
          startedAt: iso(2),
          settledAt: iso(3),
        }),
        ai("ca2", "found"),
      ]),
    ]
    const subagent = {
      name: "researcher",
      routeId: "/r",
      description: "Finds",
      depth: 1,
      checkpointNs: "tools:ct",
      outcome: "done",
    }
    const root = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), a1]),
      ckpt(
        "k2",
        6,
        [
          human("u1", "go"),
          a1,
          toolMsg("cp", "writeTodos", "Updated", {
            status: "completed",
            startedAt: iso(1),
            settledAt: iso(2),
          }),
          toolMsg(
            "ct",
            "task",
            "found",
            {
              status: "completed",
              icon: "agent",
              label: "Heard back",
              startedAt: iso(1),
              settledAt: iso(5),
            },
            { b4_subagent: subagent },
          ),
          toolMsg(
            "c1",
            "runBash",
            "boom",
            { status: "failed", icon: "run", startedAt: iso(1), settledAt: iso(3) },
            {},
            "error",
          ),
        ],
        { todos, metadata: { "b4:turn": { status: "done", endedAt: iso(6) } } },
      ),
    ]
    const { turns: restored, warnings } = turnsFromState(base(root, { "tools:ct": child }))
    expect(warnings).toEqual([])

    const ct = { subagentRunId: "ct" }
    const live: Array<[number, Record<string, unknown>]> = [
      [0, { type: EventType.RUN_STARTED, threadId: "t-1", runId: "u1" }],
      [1, { type: EventType.REASONING_START, messageId: "rspan:a1" }],
      [1, { type: EventType.REASONING_MESSAGE_START, messageId: "rsn:a1", role: "reasoning" }],
      [1, { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "rsn:a1", delta: "think" }],
      [1, { type: EventType.REASONING_MESSAGE_END, messageId: "rsn:a1" }],
      [1, { type: EventType.REASONING_END, messageId: "rspan:a1" }],
      [1, { type: EventType.TOOL_CALL_START, toolCallId: "ct", toolCallName: "task" }],
      [
        1,
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "ct",
          delta: '{"subagent":"researcher","input":"dig"}',
        },
      ],
      [1, { type: EventType.TOOL_CALL_END, toolCallId: "ct" }],
      [1, { type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "runBash" }],
      [1, { type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: '{"command":"rm"}' }],
      [1, { type: EventType.TOOL_CALL_END, toolCallId: "c1" }],
      [
        1,
        {
          type: EventType.SUBAGENT_STARTED,
          subagentRunId: "ct",
          name: "researcher",
          parentToolCallId: "ct",
          description: "Finds",
        },
      ],
      [2, { type: EventType.TOOL_CALL_START, toolCallId: "n1", toolCallName: "readDoc", ...ct }],
      [2, { type: EventType.TOOL_CALL_ARGS, toolCallId: "n1", delta: '{"path":"a.md"}', ...ct }],
      [2, { type: EventType.TOOL_CALL_END, toolCallId: "n1", ...ct }],
      [
        2,
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: "b4:plan:u1",
          activityType: "b4.plan",
          replace: true,
          content: { todos },
        },
      ],
      [
        3,
        {
          type: EventType.CUSTOM,
          name: "b4.step",
          value: { toolCallId: "n1", status: "completed", label: "Read a.md" },
          ...ct,
        },
      ],
      [
        3,
        {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "n1",
          messageId: "tr-n1",
          content: "txt",
          ...ct,
        },
      ],
      [
        3,
        { type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", messageId: "tr-c1", content: "boom" },
      ],
      [
        3,
        {
          type: EventType.CUSTOM,
          name: "b4.step",
          value: { toolCallId: "c1", status: "failed", icon: "run" },
        },
      ],
      [4, { type: EventType.TEXT_MESSAGE_START, messageId: "ca2", role: "assistant", ...ct }],
      [4, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "ca2", delta: "found", ...ct }],
      [4, { type: EventType.TEXT_MESSAGE_END, messageId: "ca2", ...ct }],
      [
        5,
        {
          type: EventType.SUBAGENT_FINISHED,
          subagentRunId: "ct",
          result: "found",
          outcome: { type: "success" },
        },
      ],
      [
        6,
        {
          type: EventType.RUN_FINISHED,
          threadId: "t-1",
          runId: "u1",
          outcome: { type: "success" },
        },
      ],
    ]
    let clock = T0
    let view: TurnsView = { turns: [] }
    for (const [s, event] of live) {
      clock = T0 + s * 1000
      view = reduceTurns(view, event as unknown as BaseEvent, { now: () => clock })
    }
    expect(firstTurn(restored).failed).toBe(1)
    expect(restored).toEqual(view)
  })

  test("an open task never claims the namespace an answered sibling owns", () => {
    const critic = {
      id: "tA",
      name: "task",
      args: { subagent: "critic", input: "review" },
      type: "tool_call",
    }
    const editor = {
      id: "tB",
      name: "task",
      args: { subagent: "editor", input: "review" },
      type: "tool_call",
    }
    const run = { id: "n1", name: "runBash", args: { command: "ls" }, type: "tool_call" }
    const a1 = ai("a1", "", [critic, editor])
    const criticNs = [
      ckpt("x0", 1, [human("cu", "review")]),
      ckpt("x1", 2, [human("cu", "review"), ai("ca", "fine")]),
    ]
    const editorNs = [
      ckpt("y0", 1, [human("eu", "review")]),
      ckpt("y1", 2, [human("eu", "review"), ai("ea", "", [run])]),
    ]
    const root = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), a1]),
      ckpt("k2", 3, [
        human("u1", "go"),
        a1,
        toolMsg(
          "tA",
          "task",
          "fine",
          { status: "completed", startedAt: iso(1), settledAt: iso(3) },
          {
            b4_subagent: {
              name: "critic",
              routeId: "/c",
              depth: 1,
              checkpointNs: "tools:A",
              outcome: "done",
            },
          },
        ),
      ]),
    ]
    const pending = [
      {
        interruptId: "perm-3",
        resumeKey: "c".repeat(32),
        value: {
          interruptId: "perm-3",
          type: "permission-request",
          kind: "command",
          callId: "tB",
          toolCallId: "n1",
          detail: {},
        },
      },
    ]
    const { turns, warnings } = turnsFromState(
      base(root, { "tools:A": criticNs, "tools:B": editorNs }, pending, "interrupted"),
    )
    expect(warnings).toEqual([])
    const [criticStep, editorStep] = firstTurn(turns).steps as SubagentStep[]
    expect(criticStep).toMatchObject({ kind: "subagent", id: "tA", name: "critic", status: "done" })
    expect(criticStep?.turn.text).toBe("fine")
    expect(editorStep).toMatchObject({
      kind: "subagent",
      id: "tB",
      name: "editor",
      status: "paused",
    })
    expect(editorStep?.turn.steps[0]).toMatchObject({
      kind: "tool",
      id: "n1",
      status: "awaiting",
      approval: expect.objectContaining({ interruptId: "perm-3" }),
    })
  })

  test("a checkpoint without a string ts and an object values is dropped with a warning", () => {
    const valid = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), ai("a1", "hi")], {
        metadata: { "b4:turn": { status: "done", endedAt: iso(1) } },
      }),
    ]
    const { turns, warnings } = turnsFromState(base([...valid, { nope: true } as never]))
    expect(firstTurn(turns)).toMatchObject({ runId: "u1", status: "done", text: "hi" })
    expect(warnings).toEqual(["ignored checkpoint #2 in root: not { ts: string, values: object }"])
  })

  test("a suspended subagent stamp pauses the step and leaves its turn open", () => {
    const task = {
      id: "ct",
      name: "task",
      args: { subagent: "r", input: "dig" },
      type: "tool_call",
    }
    const run = { id: "n1", name: "runBash", args: {}, type: "tool_call" }
    const child = [
      ckpt("x0", 1, [human("cu", "dig")]),
      ckpt("x1", 2, [human("cu", "dig"), ai("ca1", "", [run])]),
    ]
    const subagent = {
      name: "r",
      routeId: "/r",
      depth: 1,
      checkpointNs: "tools:ct",
      outcome: "suspended",
    }
    const root = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), ai("a1", "", [task])]),
      ckpt(
        "k2",
        4,
        [
          human("u1", "go"),
          ai("a1", "", [task]),
          toolMsg(
            "ct",
            "task",
            "",
            { status: "completed", startedAt: iso(1), settledAt: iso(3) },
            { b4_subagent: subagent },
          ),
        ],
        { metadata: { "b4:turn": { status: "done", endedAt: iso(4) } } },
      ),
    ]
    const turn = firstTurn(turnsFromState(base(root, { "tools:ct": child })).turns)
    const sub = turn.steps[0] as SubagentStep
    expect(sub).toMatchObject({ kind: "subagent", id: "ct", status: "paused" })
    expect(sub.settledAt).toBeUndefined()
    expect(sub.turn).toMatchObject({ status: "working" })
    expect(sub.turn.steps[0]).toMatchObject({ kind: "tool", id: "n1", status: "running" })
  })

  test("warnings come inline first, then one aggregated line per stamp reason, then unattached namespaces", () => {
    const c1 = { id: "c1", name: "x", args: {}, type: "tool_call" }
    const c2 = { id: "c2", name: "y", args: {}, type: "tool_call" }
    const bare = (id: string, name: string) =>
      env("ToolMessage", { tool_call_id: id, name, content: "v", additional_kwargs: {} })
    const history = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), ai("a1", "", [c1, c2]), bare("c1", "x"), bare("c2", "y")], {
        metadata: { "b4:turn": "yes" },
      }),
    ]
    const { warnings } = turnsFromState(
      base(history, {
        "tools:ghost": [ckpt("g0", 0, [human("gu", "hi")])],
        "tools:bad": "x" as never,
      }),
    )
    expect(warnings).toEqual([
      "children[tools:bad] is not an array",
      "ignored malformed b4:turn on checkpoint k1",
      "ignored missing b4_step on 2 tool calls: c1, c2",
      "child namespace tools:ghost is not named by any task call",
    ])
  })
})
