import { describe, expect, it } from "vitest"
import { changedOutside } from "../src/verification/docker-verifier.ts"

describe("changedOutside", () => {
  const before = { "packages/devkit/src/a.ts": "1", "packages/devkit/dist/a.js": "old" }
  it("ignores changes under the snapshotIgnore prefixes and nothing else", () => {
    expect(
      changedOutside(before, { ...before, "packages/devkit/dist/a.js": "new" }, [
        "packages/devkit/dist/",
      ]),
    ).toBe(false)
    expect(
      changedOutside(before, { ...before, "packages/devkit/dist/b.js": "added" }, [
        "packages/devkit/dist/",
      ]),
    ).toBe(false)
    expect(
      changedOutside(before, { ...before, "packages/devkit/src/a.ts": "2" }, [
        "packages/devkit/dist/",
      ]),
    ).toBe(true)
    expect(
      changedOutside(before, { "packages/devkit/src/a.ts": "1" }, ["packages/devkit/dist/"]),
    ).toBe(false)
    expect(changedOutside(before, { ...before, "packages/devkit/dist/a.js": "new" }, [])).toBe(true)
    // A prefix is a directory prefix: `dist/` must not also cover `dist-notes.ts`.
    expect(
      changedOutside(before, { ...before, "packages/devkit/dist-notes.ts": "x" }, [
        "packages/devkit/dist/",
      ]),
    ).toBe(true)
  })
  it("compares over sorted entries so key order is never a change", () => {
    const reordered = { "packages/devkit/dist/a.js": "old", "packages/devkit/src/a.ts": "1" }
    expect(changedOutside(before, reordered, [])).toBe(false)
  })
})
