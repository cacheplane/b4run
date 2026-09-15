import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadFixtureManifest, makeManifest } from "./support/recovery/manifest.ts"

const target = "/opt/fixtures/cli-flags/node_modules"
const file = (path = "src/a.ts", content = "hello", executable = false) => ({
  path,
  content,
  executable,
})
describe("recovery source manifest", () => {
  it("canonicalizes ordering, binds source bytes and executable mode", () => {
    const manifest = makeManifest([file("z"), file("a")], target)
    expect(manifest).toEqual(makeManifest([file("a"), file("z")], target))
    expect(manifest.files.map((f) => f.path)).toEqual(["a", "z"])
    expect(makeManifest([file()], target).digest).not.toBe(
      makeManifest([file(undefined, "changed")], target).digest,
    )
    expect(makeManifest([file()], target).digest).not.toBe(
      makeManifest([file(undefined, undefined, true)], target).digest,
    )
  })
  it.each([
    "/abs",
    "../escape",
    "a/../b",
    "a//b",
    "a\\b",
    ".git/config",
    "node_modules/a",
    "a/.git/b",
    "a b",
    "./a",
  ])("rejects unsafe path %s", (path) => {
    expect(() => makeManifest([file(path)], target)).toThrow()
  })
  it("rejects duplicates, ancestor conflicts and unknown dependency targets", () => {
    expect(() => makeManifest([file(), file()], target)).toThrow()
    expect(() => makeManifest([file("src"), file()], target)).toThrow()
    expect(() => makeManifest([file()], "/tmp/deps")).toThrow()
  })
  it.each(["cli-flags", "nullable-inputs"] as const)(
    "loads only the real %s visible inventory",
    async (id) => {
      const manifest = await loadFixtureManifest(id)
      expect(manifest.files.some((f) => f.path === "TASK.md")).toBe(true)
      expect(manifest.files.find((f) => f.path === ".gitignore")?.content).toBe("/node_modules\n")
      expect(manifest.files.some((f) => /checks|reference.patch|manifest.json/.test(f.path))).toBe(
        false,
      )
      expect(manifest.files.some((f) => f.path === "package-lock.json")).toBe(true)
      expect(manifest.digest).toMatch(/^[a-f0-9]{64}$/)
    },
  )
  it("rejects links, nonfiles and inventory mismatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "recovery-fixture-"))
    try {
      const fixture = join(root, "cli-flags")
      await mkdir(join(fixture, "project"), { recursive: true })
      await writeFile(
        join(fixture, "manifest.json"),
        JSON.stringify({ allowedSourcePaths: ["a"], immutablePaths: [] }),
      )
      await writeFile(join(fixture, "task.md"), "task")
      await symlink(join(fixture, "task.md"), join(fixture, "project/a"))
      await expect(loadFixtureManifest("cli-flags", root)).rejects.toThrow()
      await rm(join(fixture, "project/a"))
      await mkdir(join(fixture, "project/a"))
      await expect(loadFixtureManifest("cli-flags", root)).rejects.toThrow()
      await rm(join(fixture, "project/a"), { recursive: true })
      await writeFile(join(fixture, "project/a"), "a")
      await writeFile(join(fixture, "project/extra"), "extra")
      await expect(loadFixtureManifest("cli-flags", root)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
it("preserves a source UTF-8 BOM as exact manifested bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "recovery-bom-"))
  try {
    const fixture = join(root, "cli-flags")
    await mkdir(join(fixture, "project"), { recursive: true })
    await writeFile(
      join(fixture, "manifest.json"),
      JSON.stringify({ allowedSourcePaths: ["a"], immutablePaths: [] }),
    )
    await writeFile(join(fixture, "task.md"), "task")
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61])
    await writeFile(join(fixture, "project/a"), bytes)
    const manifest = await loadFixtureManifest("cli-flags", root)
    const source = manifest.files.find((file) => file.path === "a")
    expect(source).toBeDefined()
    expect(Buffer.from(source?.content ?? "", "utf8")).toEqual(bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
