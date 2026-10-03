import { fileURLToPath } from "node:url"
import type { B4ContentPart } from "@b4run/sdk"
import { afterAll, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const seen: unknown[] = []
const h = await createAgentHarness({
  appRoot,
  route: "/chat#agent",
  middlewareContext: (run) => {
    seen.push(run.input)
    return {}
  },
})
afterAll(() => h.close())

it("run() accepts a content-part list and delivers it unchanged", async () => {
  const input: readonly B4ContentPart[] = [
    { type: "text", text: "see" },
    { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
  ]
  const run = await h.run({
    input,
    fixtures: [{ match: { turnIndex: 0, hasToolResult: false }, response: { content: "seen" } }],
  })
  expect(run.finalMessage).toBe("seen")
  expect(seen).toEqual([input])
}, 60_000)
