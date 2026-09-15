import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"

it("configures an ordinary managed workspace without an attempt bootstrap", async () => {
  const source = await readFile(new URL("../b4.config.ts", import.meta.url), "utf8")
  expect(source).toContain("fixtureWorkspace")
  expect(source).not.toContain("attemptContext")
  const route = await readFile(new URL("../src/app/fix/index.ts", import.meta.url), "utf8")
  expect(route).toContain("prepareReview")
})
