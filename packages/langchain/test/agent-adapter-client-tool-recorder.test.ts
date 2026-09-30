import { CLIENT_TOOL_RECORDER_KEY, type ClientToolRecorder } from "@b4run/sdk"
import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, test } from "vitest"
import { streamAgent } from "../src/agent-adapter.js"

/**
 * The injection seam for client-provided tools (cacheplane/b4run#743): the
 * client tool stub in `@b4run/core` reads the per-run recorder out of the
 * ambient run config with `getConfig()`, so the adapter must put it there,
 * under the shared key, where no route param can reach it.
 */
describe("streamAgent — client tool recorder injection", () => {
  const recorder: ClientToolRecorder = {
    has: async () => false,
    record: async () => {},
  }

  async function configFor(
    options: Partial<Parameters<typeof streamAgent>[0]>,
  ): Promise<Record<string, unknown>> {
    let seen: Record<string, unknown> = {}
    const entry = {
      invoke: async () => ({}),
      streamEvents: async function* (_input: unknown, config: Record<string, unknown>) {
        seen = (config.configurable ?? {}) as Record<string, unknown>
        yield { event: "on_chain_end", name: "LangGraph", data: { output: { messages: [] } } }
      },
    }
    for await (const _chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry,
      input: { messages: [] },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
      ...options,
    })) {
      // drain
    }
    return seen
  }

  test("forwards the recorder into config.configurable under the shared key", async () => {
    const configurable = await configFor({ threadId: "t-1", clientToolRecorder: recorder })
    expect(configurable[CLIENT_TOOL_RECORDER_KEY]).toBe(recorder)
    expect(configurable.thread_id).toBe("t-1")
  })

  test("omits the key entirely when no recorder is supplied", async () => {
    // The stub refuses to park without a recorder; a defaulted one here would
    // let it park a call nobody can answer.
    const configurable = await configFor({ threadId: "t-2" })
    expect(Object.hasOwn(configurable, CLIENT_TOOL_RECORDER_KEY)).toBe(false)
  })

  test("a route param cannot shadow the recorder", async () => {
    const configurable = await configFor({
      threadId: "t-3",
      routeParamNames: [CLIENT_TOOL_RECORDER_KEY],
      input: { messages: [], [CLIENT_TOOL_RECORDER_KEY]: "attacker-supplied" },
      clientToolRecorder: recorder,
    })
    expect(configurable[CLIENT_TOOL_RECORDER_KEY]).toBe(recorder)
  })
})
