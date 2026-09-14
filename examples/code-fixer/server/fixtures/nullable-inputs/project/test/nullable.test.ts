import assert from "node:assert/strict"
import test from "node:test"
import { compileTool } from "../src/pipeline.js"

test("a nullable TypeScript tool accepts null at runtime", () => {
  const { validator } = compileTool("export default async function tool(input: { value: string | null }) { return input }")
  assert.equal(validator.safeParse({ value: null }).success, true, "nullable-input rejected")
  assert.equal(validator.safeParse({ value: "hello" }).success, true)
})
