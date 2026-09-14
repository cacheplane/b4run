import { expect, it } from "vitest"
import { collectChanges, renderReviewDiff } from "../src/blueprint/patch.ts"

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
