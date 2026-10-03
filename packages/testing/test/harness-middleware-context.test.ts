import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"
import { type AgentHarnessRunInfo, createAgentHarness } from "../src/harness.js"
import { expectToolCalled } from "../src/matchers.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const route = "/middleware-chat#agent"

function whoAmIFixtures(input: string) {
  return script().user(input).callsTool("whoAmI", { probe: input }).replies("done")
}

function middlewareSeenBy(run: { toolResults: ReadonlyArray<{ name: string; content: unknown }> }) {
  const result = run.toolResults.find((r) => r.name === "whoAmI")
  const content = result?.content
  const parsed = typeof content === "string" ? JSON.parse(content) : content
  return (parsed as { middleware: unknown }).middleware
}

describe("createAgentHarness({ middlewareContext })", () => {
  it("tools see undefined middleware context when none is supplied", async () => {
    await using h = await createAgentHarness({ appRoot, route })
    const run = await h.run({ input: "no context", fixtures: whoAmIFixtures("no context") })
    expectToolCalled(run, "whoAmI")
    expect(middlewareSeenBy(run)).toBeNull()
  }, 60_000)

  it("threads a static middleware context into every tool invocation", async () => {
    await using h = await createAgentHarness({
      appRoot,
      route,
      middlewareContext: { userId: "u-1", tenant: "acme" },
    })
    const run = await h.run({ input: "static", fixtures: whoAmIFixtures("static") })
    expectToolCalled(run, "whoAmI")
    expect(middlewareSeenBy(run)).toEqual({ userId: "u-1", tenant: "acme" })
  }, 60_000)

  it("evaluates a middleware context factory per run() with the turn's details", async () => {
    const seen: AgentHarnessRunInfo[] = []
    let counter = 0
    await using h = await createAgentHarness({
      appRoot,
      route,
      middlewareContext: async (run) => {
        seen.push(run)
        counter += 1
        return { session: `s-${counter}`, input: run.input }
      },
    })

    const first = await h.run({ input: "first", fixtures: whoAmIFixtures("first") })
    expect(middlewareSeenBy(first)).toEqual({ session: "s-1", input: "first" })

    h.reset()
    const second = await h.run({ input: "second", fixtures: whoAmIFixtures("second") })
    expect(middlewareSeenBy(second)).toEqual({ session: "s-2", input: "second" })

    expect(seen).toHaveLength(2)
    expect(seen[0]?.input).toBe("first")
    expect(seen[1]?.input).toBe("second")
    expect(seen[0]?.threadId).toBe(first.threadId)
    expect(seen[1]?.threadId).toBe(second.threadId)
    expect(seen[0]?.threadId).not.toBe(seen[1]?.threadId)
  }, 60_000)
})
