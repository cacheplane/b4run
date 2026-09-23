import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { writeFileAtomic } from "../src/lib/storage/atomic-file.ts"

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("writeFileAtomic", () => {
  it("replaces the file whole and leaves no temporary sibling", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-atomic-"))
    const path = join(dir, "wo-a.json")
    await writeFileAtomic(path, "one\n")
    await writeFileAtomic(path, "two\n")
    expect(readFileSync(path, "utf8")).toBe("two\n")
    expect(readdirSync(dir)).toEqual(["wo-a.json"])
  })

  it("leaves nothing behind when the write fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-atomic-"))
    // The target is a directory: the rename over it fails after the temporary file exists.
    const path = join(dir, "occupied")
    mkdirSync(path)
    writeFileSync(join(path, "child"), "keep")
    await expect(writeFileAtomic(path, "y")).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(["occupied"])
  })
})
