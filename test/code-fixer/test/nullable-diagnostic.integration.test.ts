import { rm } from "node:fs/promises"
import { createAgentHarness, script } from "@b4run/testing"
import { expect, it } from "vitest"
import { isolatedApp } from "../evaluation/isolated-app.ts"

it("runs the documented nullable diagnostic without another approval pause", async () => {
  const appRoot = await isolatedApp(undefined, "nullable-inputs")
  const h = await createAgentHarness({
    appRoot,
    route: "/fix#agent",
  })
  try {
    const command = `printf '%s' '{"source":"export default async function tool(input: { value: string | null }) { return input }","inputs":[{"value":null},{"value":"hello"}]}' | node --import tsx test/evaluate-tool.ts`
    const run = await h.run({
      input: "Inspect the fixture",
      fixtures: script()
        .user("Inspect the fixture")
        .callsTool("runBash", { command })
        .replies("Inspected the fixture."),
    })
    expect(run.interrupts).toEqual([])
    const result = run.toolResults.find((value) => value.name === "runBash")
    const content =
      typeof result?.content === "string" ? JSON.parse(result.content) : result?.content
    expect(content.exitCode).toBe(0)
    expect(JSON.parse(content.stdout).accepted).toEqual([false, true])
  } finally {
    await h.close({ destroyWorkspaces: true })
    await rm(appRoot, { recursive: true, force: true })
  }
}, 120_000)
