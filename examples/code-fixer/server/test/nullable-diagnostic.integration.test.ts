import { fileURLToPath } from "node:url"
import { createAgentHarness, script } from "@b4run/testing"
import { expect, it } from "vitest"
import { attemptContext } from "../src/blueprint/attempt-context.ts"

it("runs the documented nullable diagnostic without another approval pause", async () => {
  const previous = process.env.B4_CODE_FIXER_TASK
  process.env.B4_CODE_FIXER_TASK = "nullable-inputs"
  const h = await createAgentHarness({
    appRoot: fileURLToPath(new URL("../", import.meta.url)),
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
    await h.close()
    await attemptContext().provider.destroyAll()
    if (previous === undefined) delete process.env.B4_CODE_FIXER_TASK
    else process.env.B4_CODE_FIXER_TASK = previous
  }
}, 120_000)
