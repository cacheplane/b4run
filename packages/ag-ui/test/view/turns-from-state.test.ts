import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import {
  reduceTurns,
  type SubagentStep,
  type TurnsView,
  type TurnView,
} from "../../src/view/turns.ts"
import { type ThreadStateForTurns, turnsFromState } from "../../src/view/turns-from-state.ts"

const T0 = Date.parse("2026-10-05T00:00:00.000Z")
const firstTurn = (view: TurnsView): TurnView => view.turns[0] as TurnView
const iso = (s: number) => new Date(T0 + s * 1000).toISOString()
const env = (cls: string, kwargs: Record<string, unknown>) => ({
  lc: 1,
  type: "constructor",
  id: ["langchain_core", "messages", cls],
  kwargs,
})
const human = (id: string, content: string) => env("HumanMessage", { id, content })
const ai = (id: string, content: unknown, tool_calls: unknown[] = []) =>
  env("AIMessageChunk", { id, content, tool_calls, additional_kwargs: {} })
const toolMsg = (
  tool_call_id: string,
  name: string,
  content: string,
  step: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  status?: string,
) =>
  env("ToolMessage", {
    tool_call_id,
    name,
    content,
    ...(status ? { status } : {}),
    additional_kwargs: { b4_step: step, ...extra },
  })
const ckpt = (
  id: string,
  s: number,
  messages: unknown[],
  extra: { todos?: unknown; metadata?: Record<string, unknown> } = {},
) => ({
  id,
  ts: iso(s),
  metadata: { source: "loop", step: 0, parents: {}, ...(extra.metadata ?? {}) },
  values: { messages, ...(extra.todos ? { todos: extra.todos } : {}) },
})
const base = (
  root: ReturnType<typeof ckpt>[],
  children: Record<string, ReturnType<typeof ckpt>[]> = {},
  pending: unknown[] = [],
  status: ThreadStateForTurns["status"] = "idle",
): ThreadStateForTurns => ({
  threadId: "t-1",
  status,
  root,
  children,
  pendingInterrupts: pending as never,
})

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

  test("a failed step, a denied decision, reasoning blocks and a plan snapshot", () => {
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
          toolMsg(
            "c1",
            "runBash",
            "[B4_E3001] Permission denied by user: command",
            {
              status: "failed",
              icon: "run",
              decision: "deny",
              startedAt: iso(1),
              settledAt: iso(2),
            },
            {},
            "error",
          ),
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
      status: "failed",
      icon: "run",
      result: "[B4_E3001] Permission denied by user: command",
    })
    expect(turn.failed).toBe(1)
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
    expect(turn.steps[2]).toMatchObject({ kind: "plan", todos, startedAt: T0 + 3000 })
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
      }),
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
})
