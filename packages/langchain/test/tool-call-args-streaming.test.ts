import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, test } from "vitest"
import { type AgentStreamChunk, streamAgent } from "../src/agent-adapter.ts"

interface Fragment {
  readonly id?: string
  readonly name?: string
  readonly args?: string
  readonly index?: number
}

function event(
  kind: string,
  run_id: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return { event: kind, run_id, name: "model", data, ...extra }
}

/** One `on_chat_model_stream` event carrying tool-call fragments (and maybe text). */
function fragments(run_id: string, tool_call_chunks: Fragment[], content = "") {
  return event("on_chat_model_stream", run_id, { chunk: { content, tool_call_chunks } })
}

function modelEnd(run_id: string, tool_calls: Array<{ id: string; name: string; args: unknown }>) {
  return event("on_chat_model_end", run_id, { output: { content: "", tool_calls } })
}

const GRAPH_END = { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: {} } }

async function collect(events: Record<string, unknown>[]): Promise<AgentStreamChunk[]> {
  const entry = {
    invoke: async () => ({}),
    async *streamEvents() {
      yield* events
    },
  }
  const chunks: AgentStreamChunk[] = []
  for await (const chunk of streamAgent({
    entry,
    checkpointer: new MemorySaver(),
    input: {},
    tools: [],
    routeParamNames: [],
    signal: new AbortController().signal,
  }))
    chunks.push(chunk)
  return chunks
}

function deltasFor(chunks: AgentStreamChunk[], id: string): string[] {
  return chunks
    .filter((chunk) => chunk.type === "tool_call_args")
    .map((chunk) => chunk.data as { id: string; delta: string })
    .filter((data) => data.id === id)
    .map((data) => data.delta)
}

describe("streamAgent — incremental tool-call arguments", () => {
  test("a multi-fragment turn yields deltas that concatenate to the announced arguments", async () => {
    const args = { city: "Paris", days: 3 }
    const chunks = await collect([
      fragments("m1", [{ id: "call_1", name: "weather", args: "", index: 0 }]),
      fragments("m1", [{ args: '{"city":', index: 0 }]),
      fragments("m1", [{ args: '"Par', index: 0 }]),
      fragments("m1", [{ args: 'is","days":3}', index: 0 }]),
      modelEnd("m1", [{ id: "call_1", name: "weather", args }]),
      GRAPH_END,
    ])

    expect(chunks).toEqual([
      { type: "tool_call_args", data: { id: "call_1", name: "weather", delta: '{"city":' } },
      { type: "tool_call_args", data: { id: "call_1", name: "weather", delta: '"Par' } },
      { type: "tool_call_args", data: { id: "call_1", name: "weather", delta: 'is","days":3}' } },
      { type: "tool_call", data: { id: "call_1", name: "weather", input: args } },
      { type: "done", data: {} },
    ])
    expect(deltasFor(chunks, "call_1").join("")).toBe(JSON.stringify(args))
  })

  test("a turn without fragments is identical to the single announce of today", async () => {
    const chunks = await collect([
      event("on_chat_model_stream", "m1", { chunk: { content: "" } }),
      modelEnd("m1", [{ id: "call_1", name: "weather", args: { city: "Paris" } }]),
      GRAPH_END,
    ])

    expect(chunks).toEqual([
      { type: "tool_call", data: { id: "call_1", name: "weather", input: { city: "Paris" } } },
      { type: "done", data: {} },
    ])
  })

  test("raw provider text is re-serialized so the deltas match JSON.stringify of the parse", async () => {
    const raw = '{ "note": "caf\\u00e9", "n": 1.0 }'
    const args = JSON.parse(raw)
    const chunks = await collect([
      fragments("m1", [{ id: "call_1", name: "save", args: raw.slice(0, 9), index: 0 }]),
      fragments("m1", [{ args: raw.slice(9, 20), index: 0 }]),
      fragments("m1", [{ args: raw.slice(20), index: 0 }]),
      modelEnd("m1", [{ id: "call_1", name: "save", args }]),
      GRAPH_END,
    ])

    expect(deltasFor(chunks, "call_1").join("")).toBe(JSON.stringify(args))
  })

  test("two interleaved calls in one turn keep their fragments separate by index", async () => {
    const chunks = await collect([
      fragments("m1", [{ id: "call_a", name: "alpha", args: "", index: 0 }]),
      fragments("m1", [{ args: '{"a":', index: 0 }]),
      fragments("m1", [{ id: "call_b", name: "beta", args: '{"b":', index: 1 }]),
      fragments("m1", [{ args: "1}", index: 0 }]),
      fragments("m1", [{ args: "2}", index: 1 }]),
      modelEnd("m1", [
        { id: "call_a", name: "alpha", args: { a: 1 } },
        { id: "call_b", name: "beta", args: { b: 2 } },
      ]),
      GRAPH_END,
    ])

    expect(deltasFor(chunks, "call_a")).toEqual(['{"a":', "1}"])
    expect(deltasFor(chunks, "call_b")).toEqual(['{"b":', "2}"])
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "tool_call_args",
      "tool_call_args",
      "tool_call_args",
      "tool_call_args",
      "tool_call",
      "tool_call",
      "done",
    ])
  })

  test("fragments that arrive before the id and name are known are released, not lost", async () => {
    const chunks = await collect([
      fragments("m1", [{ args: '{"q":', index: 0 }]),
      fragments("m1", [{ id: "call_1", name: "search", args: '"x"}', index: 0 }]),
      modelEnd("m1", [{ id: "call_1", name: "search", args: { q: "x" } }]),
      GRAPH_END,
    ])

    expect(deltasFor(chunks, "call_1")).toEqual(['{"q":"x"}'])
  })

  test("the two orchestration tools stay on the single-delta path", async () => {
    for (const name of ["writeTodos", "task"]) {
      const chunks = await collect([
        fragments("m1", [{ id: "call_1", name, args: '{"todos":', index: 0 }]),
        fragments("m1", [{ args: "[]}", index: 0 }]),
        modelEnd("m1", [{ id: "call_1", name, args: { todos: [] } }]),
        GRAPH_END,
      ])

      expect(chunks).toEqual([
        { type: "tool_call", data: { id: "call_1", name, input: { todos: [] } } },
        { type: "done", data: {} },
      ])
    }
  })

  test("text and fragments on the same chunk both surface", async () => {
    const chunks = await collect([
      fragments("m1", [{ id: "call_1", name: "t", args: "{}", index: 0 }], "Sure,"),
      modelEnd("m1", [{ id: "call_1", name: "t", args: {} }]),
      GRAPH_END,
    ])

    expect(chunks).toEqual([
      { type: "token", messageId: "m1", data: "Sure," },
      { type: "tool_call_args", data: { id: "call_1", name: "t", delta: "{}" } },
      { type: "message_end", data: { messageId: "m1" } },
      { type: "tool_call", data: { id: "call_1", name: "t", input: {} } },
      { type: "done", data: {} },
    ])
  })

  test("a subagent's model never streams its arguments to the root surface", async () => {
    const child = {
      metadata: {
        b4: { subagent_stack: [{ callId: "c1", name: "researcher", routeId: "/r#researcher" }] },
      },
    }
    const chunks = await collect(
      [
        fragments("child-m1", [{ id: "call_child", name: "lookup", args: '{"q":1}', index: 0 }]),
        GRAPH_END,
      ].map((entry, index) => (index === 0 ? { ...entry, ...child } : entry)),
    )

    expect(chunks.filter((chunk) => chunk.type === "tool_call_args")).toEqual([])
  })

  test("fragments without an index correlate by id, and without either are dropped", async () => {
    const chunks = await collect([
      fragments("m1", [{ id: "call_1", name: "t", args: '{"a":' }]),
      fragments("m1", [{ id: "call_1", args: "1}" }]),
      fragments("m1", [{ args: "ignored" }]),
      modelEnd("m1", [{ id: "call_1", name: "t", args: { a: 1 } }]),
      GRAPH_END,
    ])

    expect(deltasFor(chunks, "call_1")).toEqual(['{"a":', "1}"])
    expect(chunks.filter((chunk) => chunk.type === "tool_call_args")).toHaveLength(2)
  })

  test("a resume replay with no model turn announces once and streams nothing", async () => {
    const args = { command: "fetch" }
    const first = await collect([
      fragments("m1", [{ id: "call_1", name: "runBash", args: '{"command":', index: 0 }]),
      fragments("m1", [{ args: '"fetch"}', index: 0 }]),
      modelEnd("m1", [{ id: "call_1", name: "runBash", args }]),
      event("on_tool_start", "exec-1", { input: args }, { name: "runBash" }),
      event(
        "on_tool_error",
        "exec-1",
        {
          error: {
            name: "GraphInterrupt",
            interrupts: [{ id: "int-1", value: { interruptId: "int-1" } }],
          },
        },
        { name: "runBash" },
      ),
      GRAPH_END,
    ])
    const resumed = await collect([
      event("on_tool_start", "exec-2", { input: args }, { name: "runBash" }),
      event(
        "on_tool_end",
        "exec-2",
        { output: { tool_call_id: "call_1", content: "ok" } },
        { name: "runBash" },
      ),
      GRAPH_END,
    ])

    expect(deltasFor(first, "call_1").join("")).toBe(JSON.stringify(args))
    expect(first.filter((chunk) => chunk.type === "tool_call")).toHaveLength(1)
    expect(resumed.filter((chunk) => chunk.type === "tool_call_args")).toEqual([])
    expect(resumed.filter((chunk) => chunk.type === "tool_call")).toEqual([
      { type: "tool_call", data: { id: "call_1", name: "runBash", input: args } },
    ])
  })
})
