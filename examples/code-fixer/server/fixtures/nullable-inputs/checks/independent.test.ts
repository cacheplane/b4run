import assert from "node:assert/strict"
import test from "node:test"
import { inspectTool } from "../test/inspect-tool.js"

test("preserves null alternatives, required fields, and nested inputs", () => {
  const valid = { value: null, nested: { flag: null }, missing: null }
  const inputs = [valid, { ...valid, value: "yes", optional: 2 }, { ...valid, optional: null },
    ...[42, false, [], {}, undefined].map(value => ({ ...valid, value })),
    { nested: { flag: true }, missing: null }, { ...valid, optional: "bad" }, { ...valid, nested: { flag: "bad" } }, { ...valid, missing: "bad" }]
  const { schema, accepted } = inspectTool(`export default async function tool(input: {
    value: string | null; optional?: number | null;
    nested: { flag: boolean | null }; missing: null;
  }) { return input }`, inputs)
  assert.deepEqual([...schema.required].sort(), ["missing", "nested", "value"])
  assert.ok(schema.properties.value?.anyOf?.some(s => s.type === "null"))
  assert.deepEqual(accepted, [true, true, true, false, false, false, false, false, false, false, false, false])
})
test("preserves existing non-nullable and array behavior", () => {
  const { accepted } = inspectTool(`export default async function tool(input: {
    label: string; count: number; tags: string[] | null
  }) { return input }`, [
    { label: "a", count: 2, tags: ["one"] },
    { label: "a", count: 2, tags: null },
    { label: null, count: 2, tags: [] },
    { label: "a", count: "2", tags: [] },
    { label: "a", count: 2, tags: [1] },
  ])
  assert.deepEqual(accepted, [true, true, false, false, false])
})
