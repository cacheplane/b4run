// Deterministic (aimock) regression: `agentsMd: { writable: false }` in
// b4.config.ts reaches the rendered system prompt — workspace/AGENTS.md is
// injected as read-only guidance with no writeFile instruction.
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"
import { createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app-agents-md-read-only", import.meta.url))

it("injects workspace/AGENTS.md as read-only guidance when the app sets agentsMd.writable false", async () => {
  const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
  try {
    const run = await h.run({ input: "Hello.", fixtures: script().user("Hello.").replies("Hi.") })
    expect(run.systemPrompt).toContain("House style: answer in metric units.")
    expect(run.systemPrompt).toContain("# Project guidance")
    expect(run.systemPrompt).toContain("Do NOT modify `AGENTS.md`")
    expect(run.systemPrompt).not.toContain("# Memory")
    expect(run.systemPrompt).not.toContain('writeFile({ path: "AGENTS.md"')
  } finally {
    await h.close()
  }
}, 60_000)
