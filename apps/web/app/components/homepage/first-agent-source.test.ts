import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { firstAgentSource, prepareFirstAgent } from "./first-agent-source"

const templateRoot = fileURLToPath(
  new URL("../../../../../packages/devkit/templates/app-basic/", import.meta.url),
)

it("shows the basic template's agent and tool exactly as scaffolded", async () => {
  for (const source of Object.values(firstAgentSource.sources)) {
    expect(source.text).toBe(readFileSync(resolve(templateRoot, source.path), "utf8"))
  }
  const prepared = await prepareFirstAgent()
  expect(prepared.agent.raw).toBe(firstAgentSource.sources.agent.text.trimEnd())
  expect(prepared.tool.raw).toBe(firstAgentSource.sources.tool.text.trimEnd())
  expect(prepared.agent.url).toBe("")
})
