import { applyPatch } from "diff"
import { expect, it } from "vitest"
import { collectChanges, renderReviewDiff } from "../src/review/patch.ts"

const baseline = { "src/cli.ts": "old", "test/test.ts": "assert", "package.json": "{}" }
it("accepts only a focused source patch", () => {
  expect(collectChanges(baseline, { ...baseline, "src/cli.ts": "new" }, ["src/cli.ts"])).toEqual({
    "src/cli.ts": "new",
  })
  expect(collectChanges(baseline, baseline, ["src/cli.ts"])).toEqual({})
})
it("rejects test edits, new paths, removals, and oversized output", () => {
  for (const target of [
    { ...baseline, "test/test.ts": "pass" },
    { ...baseline, "new.ts": "" },
    { "src/cli.ts": "new" },
    { ...baseline, "src/cli.ts": "x".repeat(1024 * 1024 + 1) },
  ]) {
    expect(() => collectChanges(baseline, target, ["src/cli.ts"])).toThrow()
  }
})

it("renders a review patch from actual source bytes including missing final newlines", () => {
  expect(renderReviewDiff({ "src/cli.ts": "old" }, { "src/cli.ts": "new\n" })).toBe(
    "--- a/src/cli.ts\n+++ b/src/cli.ts\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n",
  )
})

it("shows small contextual hunks for distant edits instead of replacing the file", () => {
  const before = `${Array.from({ length: 100 }, (_, i) => `const value${i} = ${i}`).join("\n")}\n`
  const after = before
    .replace("value10 = 10", "value10 = 11")
    .replace("value80 = 80", "value80 = 81")
  const diff = renderReviewDiff({ "src/example.ts": before }, { "src/example.ts": after })
  expect(diff.match(/^@@/gm)).toHaveLength(2)
  expect(diff).not.toContain("value50")
  expect(diff.split("\n").length).toBeLessThan(25)
})

it.each([
  ["old", "new\n"],
  ["first\r\nsecond\r\n", "first\r\nchanged\r\n"],
  ["\uFEFFconst café = 1\n", "\uFEFFconst café = 2\n"],
])("produces a patch that reconstructs exact candidate bytes", (before, after) => {
  const patch = renderReviewDiff({ "src/example.ts": before }, { "src/example.ts": after })
  expect(applyPatch(before, patch)).toBe(after)
})
