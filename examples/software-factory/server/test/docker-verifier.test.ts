import { describe, expect, it } from "vitest"
import { changedDuringSuite } from "../src/verification/docker-verifier.ts"

describe("changedDuringSuite", () => {
  const before = { "packages/devkit/src/a.ts": "1", "packages/devkit/dist/a.js": "old" }
  it("reports a change anywhere, the target's build output included", () => {
    // The point of the fix: the build output is where the independent oracle reads from, so a
    // rewrite there is the tamper that matters most, not one to be excused.
    expect(changedDuringSuite(before, { ...before, "packages/devkit/dist/a.js": "new" })).toBe(true)
    expect(changedDuringSuite(before, { ...before, "packages/devkit/dist/b.js": "added" })).toBe(
      true,
    )
    expect(changedDuringSuite(before, { ...before, "packages/devkit/src/a.ts": "2" })).toBe(true)
    // A deletion is a change too, wherever it lands.
    expect(changedDuringSuite(before, { "packages/devkit/src/a.ts": "1" })).toBe(true)
  })
  it("reports no change when the snapshots agree", () => {
    expect(changedDuringSuite(before, { ...before })).toBe(false)
  })
  it("compares over sorted entries so key order is never a change", () => {
    const reordered = { "packages/devkit/dist/a.js": "old", "packages/devkit/src/a.ts": "1" }
    expect(changedDuringSuite(before, reordered)).toBe(false)
  })
})
