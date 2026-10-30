import { WorkspaceInspectionError } from "@b4run/workspace"
import { describe, expect, it, test } from "vitest"
import { changedAfterSuite, changedDuringSuite } from "../src/lib/verification/grade-suite.ts"

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

test("rejects mutation detected while reading the post-suite snapshot as tamper", async () => {
  const before = Object.freeze({ "dist/testing/index.js": "original" })
  const after = async () => {
    throw new WorkspaceInspectionError("changed", "file grew while being read")
  }

  const result = changedAfterSuite(before, after, new AbortController().signal)

  await expect(result).resolves.toBe(true)
})

test("compares a stable post-suite snapshot without manufacturing tamper", async () => {
  const before = Object.freeze({ "dist/testing/index.js": "original" })
  const after = async () => ({ ...before })

  const result = await changedAfterSuite(before, after, new AbortController().signal)

  expect(result).toBe(false)
})

test("still detects a stable post-suite rewrite", async () => {
  const before = Object.freeze({ "dist/testing/index.js": "original" })
  const after = async () => ({ "dist/testing/index.js": "rewritten" })

  const result = await changedAfterSuite(before, after, new AbortController().signal)

  expect(result).toBe(true)
})

test("preserves unrelated inspection, backend and cancellation failures", async () => {
  const before = Object.freeze({ "dist/testing/index.js": "original" })
  const errors = [
    new WorkspaceInspectionError("invalid_options", "invalid limit"),
    new WorkspaceInspectionError("root_missing", "workspace is absent"),
    new WorkspaceInspectionError("refused", "inspection cap exceeded"),
    new Error("backend disconnected"),
    new DOMException("caller cancelled", "AbortError"),
  ]

  for (const error of errors) {
    const result = changedAfterSuite(
      before,
      async () => {
        throw error
      },
      new AbortController().signal,
    )

    await expect(result).rejects.toBe(error)
  }
})

test("preserves cancellation racing a changed post-suite snapshot", async () => {
  const before = Object.freeze({ "dist/testing/index.js": "original" })
  const controller = new AbortController()
  const reason = new Error("caller cancelled verification")
  const after = async () => {
    controller.abort(reason)
    throw new WorkspaceInspectionError("changed", "file grew while being read")
  }

  const result = changedAfterSuite(before, after, controller.signal)

  await expect(result).rejects.toBe(reason)
})
