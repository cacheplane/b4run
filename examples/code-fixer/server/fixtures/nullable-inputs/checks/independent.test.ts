import assert from "node:assert/strict"
import test from "node:test"
import { compileTool } from "../src/pipeline.js"

test("preserves null alternatives, required fields, and nested inputs", () => {
  const { schema, validator } = compileTool(`export default async function tool(input: {
    value: string | null; optional?: number | null;
    nested: { flag: boolean | null }; missing: null;
  }) { return input }`)
  assert.deepEqual([...schema.required].sort(), ["missing", "nested", "value"])
  assert.ok(schema.properties.value?.anyOf?.some(s => s.type === "null"))
  const valid = { value: null, nested: { flag: null }, missing: null }
  for (const input of [valid, { ...valid, value: "yes", optional: 2 }, { ...valid, optional: null }]) {
    assert.equal(validator.safeParse(input).success, true)
  }
  for (const value of [42, false, [], {}, undefined]) {
    assert.equal(validator.safeParse({ ...valid, value }).success, false)
  }
  for (const input of [{ nested: { flag: true }, missing: null }, { ...valid, optional: "bad" }, { ...valid, nested: { flag: "bad" } }, { ...valid, missing: "bad" }]) {
    assert.equal(validator.safeParse(input).success, false)
  }
})
test("preserves existing non-nullable and array behavior", () => {
  const { validator } = compileTool(`export default async function tool(input: {
    label: string; count: number; tags: string[] | null
  }) { return input }`)
  assert.equal(validator.safeParse({ label: "a", count: 2, tags: ["one"] }).success, true)
  assert.equal(validator.safeParse({ label: "a", count: 2, tags: null }).success, true)
  assert.equal(validator.safeParse({ label: null, count: 2, tags: [] }).success, false)
  assert.equal(validator.safeParse({ label: "a", count: "2", tags: [] }).success, false)
  assert.equal(validator.safeParse({ label: "a", count: 2, tags: [1] }).success, false)
})
