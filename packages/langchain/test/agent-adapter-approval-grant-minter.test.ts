import { APPROVAL_GRANT_MINTER_KEY, type ApprovalGrantMinter } from "@b4run/sdk"
import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, test } from "vitest"
import { streamAgent } from "../src/agent-adapter.js"

/**
 * The injection seam for approval grants.
 *
 * The park site in `@b4run/core` reads the minter out of the ambient run
 * config with `getConfig()`; this is the other end of that wire, and it is
 * worth pinning separately because the two halves live in different packages
 * and a silently dropped `configurable` key would degrade `"required"` into a
 * refused turn with no obvious cause.
 */
describe("streamAgent — approval-grant minter injection", () => {
  const minter: ApprovalGrantMinter = { mint: async () => "b4ag_test" }

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

  test("forwards the minter into config.configurable under the shared key", async () => {
    const configurable = await configFor({ threadId: "t-1", approvalGrantMinter: minter })
    expect(configurable[APPROVAL_GRANT_MINTER_KEY]).toBe(minter)
    expect(configurable.thread_id).toBe("t-1")
  })

  test("omits the key entirely when no minter is supplied", async () => {
    // Optional by construction, exactly like `threadId`. The park site — not
    // this adapter — decides what the absence means, and a defaulted no-op
    // minter here would satisfy its presence check and park without a grant.
    const configurable = await configFor({ threadId: "t-2" })
    expect(Object.hasOwn(configurable, APPROVAL_GRANT_MINTER_KEY)).toBe(false)
  })

  test("a route param cannot shadow the minter", async () => {
    // `configurable` is shared with route params, which come from the URL.
    // The minter is spread after them, so the injected value wins.
    const configurable = await configFor({
      threadId: "t-3",
      routeParamNames: [APPROVAL_GRANT_MINTER_KEY],
      input: { messages: [], [APPROVAL_GRANT_MINTER_KEY]: "attacker-supplied" },
      approvalGrantMinter: minter,
    })
    expect(configurable[APPROVAL_GRANT_MINTER_KEY]).toBe(minter)
  })
})
