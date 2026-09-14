import assert from "node:assert/strict"
import test from "node:test"
import { inspectTool } from "./inspect-tool.js"

test("a nullable TypeScript tool accepts null at runtime", () => {
  const { accepted } = inspectTool("export default async function tool(input: { value: string | null }) { return input }", [{ value: null }, { value: "hello" }])
  assert.equal(accepted[0], true, "nullable-input rejected")
  assert.equal(accepted[1], true)
})
