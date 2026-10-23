import { AIMessage } from "@langchain/core/messages"
import { DynamicStructuredTool } from "@langchain/core/tools"
import {
  Annotation,
  Command,
  END,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { expect, test } from "vitest"
import { z } from "zod"
import { streamAgent } from "../src/agent-adapter.ts"
import { convertSubagentTaskToLangChain } from "../src/subagent-tool-bridge.ts"

test("parallel dynamically invoked children retain their checkpointed tool identities", async () => {
  const state = Annotation.Root({ messages: Annotation<unknown[]>() })
  const lookup = new DynamicStructuredTool({
    name: "lookup",
    description: "Read browser state",
    schema: z.object({}),
    func: async () => String(interrupt("browser-result")),
  })
  const child = new StateGraph(state)
    .addNode("plan", (state) => ({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: `child-${(state.messages[0] as { content: string }).content}`,
              name: "lookup",
              args: {},
              type: "tool_call",
            },
          ],
        }),
      ],
    }))
    .addNode("tools", new ToolNode([lookup]))
    .addEdge(START, "plan")
    .addEdge("plan", "tools")
    .addEdge("tools", END)
    .compile()
  const task = convertSubagentTaskToLangChain(
    {
      name: "task",
      schema: z.object({ subagent: z.string(), input: z.string() }),
    },
    async () => ({
      ok: true,
      child: { routeId: "/child", routeKey: "/child#agent", graph: child },
    }),
  )
  const saver = new MemorySaver()
  const root = new StateGraph(state)
    .addNode("tools", new ToolNode([task]))
    .addEdge(START, "tools")
    .addEdge("tools", END)
    .compile({ checkpointer: saver })
  const config = { configurable: { thread_id: "child-replay" } }
  await root.invoke(
    {
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "task-child-A",
              name: "task",
              args: { subagent: "child", input: "A" },
              type: "tool_call",
            },
            {
              id: "task-child-B",
              name: "task",
              args: { subagent: "child", input: "B" },
              type: "tool_call",
            },
          ],
        }),
      ],
    },
    config,
  )
  const decisions: Record<string, string> = {}
  // ToolNode surfaces one thrown interrupt; both child checkpoints retain their
  // native IDs. Resolve both so the regression reaches both resumed tool ends.
  for await (const tuple of saver.list(config)) {
    for (const [, channel, value] of tuple.pendingWrites ?? []) {
      if (channel === "__interrupt__") decisions[(value as { id: string }).id] = "found"
    }
  }
  const chunks = []

  for await (const chunk of streamAgent({
    entry: root,
    checkpointer: saver,
    input: new Command({ resume: decisions }),
    threadId: "child-replay",
    tools: [],
    routeParamNames: [],
    signal: new AbortController().signal,
  }))
    chunks.push(chunk)

  const childCalls = chunks.filter(({ type }) => type === "subagent.tool_call")
  expect(childCalls).toHaveLength(2)
  expect(childCalls.map(({ data }) => data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "child-A", replayed: true }),
      expect.objectContaining({ id: "child-B", replayed: true }),
    ]),
  )
})
