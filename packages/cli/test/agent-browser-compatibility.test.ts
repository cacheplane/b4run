import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventType } from "@ag-ui/core"
import { agent, createMemoryClientToolCallStore } from "@b4run/sdk"
import { createThreadsStore } from "@b4run/sqlite-storage"
import { MemorySaver } from "@langchain/langgraph"
import { expect, test, vi } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { __normalizeB4StreamForTests } from "../src/lib/dev/agui-handler.ts"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.ts"
import { buildStaticRouteModule } from "../src/lib/runtime/static-modules.ts"

test("the AG-UI boundary preserves replay identity metadata", async () => {
  const chunks = (async function* () {
    yield {
      type: "tool_call" as const,
      id: "call",
      name: "client_findAircraft",
      input: {},
      replayed: true,
    }
  })()
  const result = []

  for await (const chunk of __normalizeB4StreamForTests(chunks, new Set(["findAircraft"]))) {
    result.push(chunk)
  }

  expect(result).toEqual([
    { type: "tool_call", data: { id: "call", name: "findAircraft", input: {}, replayed: true } },
  ])
})

test("browser continuations preserve the output cap and schema on both OpenAI API paths", async () => {
  const mock = await createAimock({
    fixtures: [
      {
        match: { userMessage: "hello", hasToolResult: true },
        response: { content: '{"ui":["done"]}' },
      },
      {
        match: { userMessage: "hello" },
        response: { toolCalls: [{ id: "call-find", name: "client_findAircraft", arguments: {} }] },
      },
    ],
  })
  const wireBodies: Record<string, unknown>[] = []
  const nativeFetch = globalThis.fetch
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (
      url.startsWith(mock.baseUrl) &&
      /\/(chat\/completions|responses)$/.test(url) &&
      typeof init?.body === "string"
    ) {
      wireBodies.push(JSON.parse(init.body) as Record<string, unknown>)
    }
    return nativeFetch(input, init)
  })
  const schema = {
    type: "object",
    properties: { ui: { type: "array", items: { type: "string" } } },
    required: ["ui"],
    additionalProperties: false,
  }
  vi.stubEnv("OPENAI_API_KEY", "test-not-used")
  vi.stubEnv("OPENAI_BASE_URL", mock.baseUrl)

  try {
    for (const summary of [undefined, "auto"] as const) {
      const root = await mkdtemp(join(tmpdir(), "b4-browser-compat-"))
      const descriptor = agent({
        model: "gpt-5-mini",
        systemPrompt: "ATC",
        maxOutputTokens: 4096,
        retry: { maxAttempts: 1 },
        reasoning: { openai: { effort: "low", ...(summary ? { summary } : {}) } },
      })
      const runtime = await createRuntimeFetchHandler({
        appRoot: root,
        config: {
          server: {
            agui: {
              clientTools: ["/atc"],
              clientForwardedProps: { "/atc": ["responseSchema"] },
              clientToolStore: createMemoryClientToolCallStore(),
            },
          },
        },
        modules: {
          routes: [
            buildStaticRouteModule({
              kind: "agent",
              routeId: "/atc",
              routeFile: join(root, "src/app/atc/index.ts"),
              routePath: "src/app/atc/index.ts",
              routeModule: { default: descriptor },
              tools: [],
            }),
          ],
        },
        checkpointer: new MemorySaver(),
        threadsStore: createThreadsStore({ path: join(root, "threads.sqlite") }),
        permissionsStore: {
          mode: "non-interactive",
          load: async () => {},
          match: () => "allow",
          addAllow: async () => {
            throw new Error("unexpected permission write")
          },
        },
      })
      const messages: Record<string, unknown>[] = [{ id: "user", role: "user", content: "hello" }]
      const start = wireBodies.length
      const run = async (runId: string) => {
        const response = await runtime.fetch(
          new Request(`http://host/agui/${encodeURIComponent("/atc#agent")}`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: JSON.stringify({
              threadId: "thread",
              runId,
              messages,
              tools: [
                {
                  name: "findAircraft",
                  description: "Find aircraft",
                  parameters: { type: "object", properties: {} },
                },
              ],
              state: {},
              context: [],
              forwardedProps: { responseSchema: schema },
            }),
          }),
        )
        const text = await response.text()
        expect(response.status).toBe(200)
        return text.split("\n\n").flatMap((frame) => {
          const data = frame.split("\n").find((line) => line.startsWith("data:"))
          return data ? [JSON.parse(data.slice(5)) as Record<string, unknown>] : []
        })
      }

      try {
        const first = await run("first")
        const call = first.find((event) => event.type === EventType.TOOL_CALL_START)
        expect(call?.parentMessageId).toEqual(expect.any(String))
        messages.push(
          {
            id: call?.parentMessageId,
            role: "assistant",
            toolCalls: [
              {
                id: "call-find",
                type: "function",
                function: { name: "findAircraft", arguments: "{}" },
              },
            ],
          },
          { id: "result", role: "tool", toolCallId: "call-find", content: "found" },
        )

        const resumed = await run("resumed")

        expect(resumed.at(-1)?.type).toBe(EventType.RUN_FINISHED)
        const replay = resumed.find(
          (event) => event.type === EventType.TOOL_CALL_START && event.toolCallId === "call-find",
        )
        expect(replay).toBeDefined()
        expect(replay).not.toHaveProperty("parentMessageId")
        expect(
          resumed.filter(
            (event) => event.type === EventType.TOOL_CALL_ARGS && event.toolCallId === "call-find",
          ),
        ).toEqual([])
        await mock.settled()
        const bodies = wireBodies.slice(start)
        expect(bodies).toHaveLength(2)
        for (const body of bodies) {
          expect(body.max_completion_tokens ?? body.max_output_tokens ?? body.max_tokens).toBe(4096)
          const format = body.response_format as { json_schema?: { schema?: unknown } } | undefined
          const text = body.text as { format?: { schema?: unknown } } | undefined
          expect(format?.json_schema?.schema ?? text?.format?.schema).toEqual(schema)
        }
      } finally {
        await runtime.close()
        await rm(root, { recursive: true, force: true })
      }
    }
  } finally {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await mock.close()
  }
}, 30000)
