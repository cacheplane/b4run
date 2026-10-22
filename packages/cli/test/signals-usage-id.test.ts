import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  readOrCreateUsageId,
  resolveUsageDir,
  USAGE_ID_FILENAME,
} from "../src/lib/signals/usage-id.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})
async function tempHome() {
  const dir = await mkdtemp(join(tmpdir(), "b4-usage-id-"))
  dirs.push(dir)
  return dir
}

describe("resolveUsageDir", () => {
  it("is ~/.b4", () => {
    expect(resolveUsageDir("/home/dev")).toBe(join("/home/dev", ".b4"))
  })
  it("is null without a home directory", () => {
    expect(resolveUsageDir("")).toBeNull()
  })
})

describe("readOrCreateUsageId", () => {
  it("creates a v4 UUID on first use and reports created", async () => {
    const dir = join(await tempHome(), ".b4")
    const first = await readOrCreateUsageId(dir)
    expect(first?.created).toBe(true)
    expect(first?.id).toMatch(UUID)
    expect((await readFile(join(dir, USAGE_ID_FILENAME), "utf8")).trim()).toBe(first?.id)
  })
  it("reads the same id back and reports not created", async () => {
    const dir = join(await tempHome(), ".b4")
    const first = await readOrCreateUsageId(dir)
    const second = await readOrCreateUsageId(dir)
    expect(second).toEqual({ id: first?.id, created: false })
  })
  it("replaces a malformed file", async () => {
    const dir = join(await tempHome(), ".b4")
    await readOrCreateUsageId(dir)
    await writeFile(join(dir, USAGE_ID_FILENAME), "not a uuid\n")
    const identity = await readOrCreateUsageId(dir)
    expect(identity?.created).toBe(true)
    expect(identity?.id).toMatch(UUID)
  })
  it("agrees on one id when two first runs race", async () => {
    const dir = join(await tempHome(), ".b4")
    const [a, b] = await Promise.all([readOrCreateUsageId(dir), readOrCreateUsageId(dir)])
    expect(a?.id).toMatch(UUID)
    expect(b?.id).toBe(a?.id)
    expect([a?.created, b?.created].filter((created) => created === true)).toHaveLength(1)
    expect((await readFile(join(dir, USAGE_ID_FILENAME), "utf8")).trim()).toBe(a?.id)
  })
  it("returns null when the directory cannot be written", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const home = await tempHome()
    await chmod(home, 0o500)
    try {
      expect(await readOrCreateUsageId(join(home, ".b4"))).toBeNull()
    } finally {
      await chmod(home, 0o700)
    }
  })
})
