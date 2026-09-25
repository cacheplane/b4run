import { fileURLToPath } from "node:url"
import { LLMock } from "@copilotkit/aimock"
import { afterAll, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

// Regression for #778: a record run whose model turn comes back empty used to
// produce a tape that replay then refused to load. It must fail at record time.
it("refuses to hand back a recording that replay would reject", async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-record-placeholder"

  // An upstream that answers with an empty assistant message. Added through
  // `addFixture`, which skips the validation `addFixturesFromJSON` applies.
  const upstream = new LLMock({ port: 0 })
  upstream.addFixture({ match: {}, response: { content: "" } })
  await upstream.start()

  const recordH = await createAgentHarness({
    appRoot,
    route: "/chat#agent",
    record: true,
    recordUpstream: upstream.url,
  })
  afterAll(async () => {
    await recordH.close()
    await upstream.stop()
  })

  await recordH.run({ input: "say nothing" })
  expect(() => recordH.getRecordedFixtures()).toThrow(
    /turn 0 of "say nothing": content is empty string/,
  )
})
