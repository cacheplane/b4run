import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readSourceFile } from "../src/source-bundle.ts"
import { captureWorkspaceSource, type WorkspaceSourceDefinition } from "../src/source-capture.ts"

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }))

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "capture-"))
  await fs.mkdir(join(root, "source"))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
const definition = (include: string[] = []): WorkspaceSourceDefinition => ({
  directory: "source",
  include,
})
describe("captureWorkspaceSource", () => {
  it("captures exact bytes, BOM, executable bits, references and inline text independently", async () => {
    await fs.writeFile(join(root, "source", "binary"), Buffer.from([0, 255, 1]), { mode: 0o755 })
    await fs.writeFile(join(root, "TASK.md"), "task", { mode: 0o755 })
    const bundle = await captureWorkspaceSource(root, {
      ...definition(["binary"]),
      files: [
        { path: "TASK.md", file: "TASK.md" },
        { path: "bom", text: "\ufeffhello" },
      ],
    })
    await fs.rm(join(root, "source"), { recursive: true })
    expect([...readSourceFile(bundle, "binary")]).toEqual([0, 255, 1])
    expect(Buffer.from(readSourceFile(bundle, "bom")).toString()).toBe("\ufeffhello")
    expect(bundle.files.map((f) => [f.path, f.executable])).toEqual([
      ["TASK.md", true],
      ["binary", true],
      ["bom", false],
    ])
    expect(Object.isFrozen(bundle.files)).toBe(true)
  })
  it("requires exact inventory and existing directory exclusions", async () => {
    await fs.writeFile(join(root, "source", "a"), "a")
    await expect(captureWorkspaceSource(root, definition())).rejects.toThrow(/inventory/i)
    await expect(captureWorkspaceSource(root, definition(["missing"]))).rejects.toThrow(
      /inventory/i,
    )
    await fs.mkdir(join(root, "source", "ignored"))
    await fs.writeFile(join(root, "source", "ignored", "anything"), "ignored")
    await expect(
      captureWorkspaceSource(root, { ...definition(["a"]), excludeDirectories: ["ignored"] }),
    ).resolves.toBeDefined()
    await expect(
      captureWorkspaceSource(root, { ...definition(["a"]), excludeDirectories: ["absent"] }),
    ).rejects.toThrow()
  })
  it.each([
    { directory: "../source", include: [] },
    { directory: ".", include: ["/absolute"] },
    { directory: ".", include: ["A/x", "a/y"] },
    { directory: ".", include: ["a", "A"] },
    { directory: ".", include: ["a"], files: [{ path: "a", text: "x" }] },
    { directory: ".", include: [], excludeDirectories: ["a", "a"] },
    { directory: ".", include: ["a/x"], excludeDirectories: ["a"] },
    { directory: ".", include: [], files: [{ path: "a", text: "\ud800" }] },
    { directory: ".", include: [], files: [{ path: "a", text: "x", file: "a" }] },
    { directory: ".", include: [], unexpected: true },
    { directory: ".", include: new Array(1) },
    { directory: ".", include: new Array(10001).fill("a") },
  ])("rejects invalid descriptor %# before IO", async (input) => {
    const io = vi.spyOn(fs, "realpath")
    await expect(captureWorkspaceSource(root, input as WorkspaceSourceDefinition)).rejects.toThrow()
    expect(io).not.toHaveBeenCalled()
  })
  it("does not invoke getters", async () => {
    const getter = vi.fn(() => ".")
    await expect(
      captureWorkspaceSource(root, {
        get directory() {
          return getter()
        },
        include: [],
      }),
    ).rejects.toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
  it("rejects symlinks in directories, files, extra references, and exclusions", async () => {
    await fs.writeFile(join(root, "original"), "x")
    await fs.symlink(join(root, "original"), join(root, "source", "link"))
    await expect(captureWorkspaceSource(root, definition(["link"]))).rejects.toThrow(/symlink/i)
    await fs.rm(join(root, "source", "link"))
    await fs.symlink(join(root, "source"), join(root, "alias"))
    await expect(captureWorkspaceSource(root, { directory: "alias", include: [] })).rejects.toThrow(
      /symlink/i,
    )
    await expect(
      captureWorkspaceSource(root, { ...definition(), files: [{ path: "x", file: "alias/x" }] }),
    ).rejects.toThrow(/symlink/i)
    await fs.symlink(join(root, "source"), join(root, "source", "excluded"))
    await expect(
      captureWorkspaceSource(root, { ...definition(), excludeDirectories: ["excluded"] }),
    ).rejects.toThrow(/symlink/i)
  })
  it("allows appRoot symlink spelling and directory dot", async () => {
    await fs.symlink(join(root, "source"), join(root, "alias"))
    await expect(
      captureWorkspaceSource(join(root, "alias"), { directory: ".", include: [] }),
    ).resolves.toBeDefined()
  })
  it("rejects special files without blocking", async () => {
    execFileSync("mkfifo", [join(root, "source", "pipe")])
    await expect(captureWorkspaceSource(root, definition(["pipe"]))).rejects.toThrow(/regular/i)
  })
  it("rejects oversized files before opening a data handle", async () => {
    const handle = await fs.open(join(root, "source", "large"), "w")
    await handle.truncate(16 * 1024 * 1024 + 1)
    await handle.close()
    await expect(captureWorkspaceSource(root, definition(["large"]))).rejects.toThrow(/limit/i)
  })
  it("honors cancellation before filesystem IO", async () => {
    const io = vi.spyOn(fs, "realpath")
    await expect(
      captureWorkspaceSource(root, definition(), { signal: AbortSignal.abort() }),
    ).rejects.toThrow()
    expect(io).not.toHaveBeenCalled()
  })
  it.each(["overwrite", "growth", "inventory", "abort"])(
    "rejects %s during read and closes file handles",
    async (change) => {
      const target = join(root, "source", "a")
      await fs.writeFile(target, "original")
      const controller = new AbortController()
      const originalOpen = fs.open
      let closed = false
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await originalOpen(...args)
        const originalRead = handle.read.bind(handle)
        const originalClose = handle.close.bind(handle)
        handle.close = async () => {
          closed = true
          await originalClose()
        }
        let first = true
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          if (first) {
            first = false
            if (change === "overwrite") await fs.writeFile(target, "modified")
            if (change === "growth") await fs.appendFile(target, "growth")
            if (change === "inventory") await fs.writeFile(join(root, "source", "extra"), "extra")
            if (change === "abort") controller.abort()
          }
          return originalRead(...readArgs)
        }) as typeof handle.read
        return handle
      })
      await expect(
        captureWorkspaceSource(root, definition(["a"]), { signal: controller.signal }),
      ).rejects.toThrow()
      expect(closed).toBe(true)
    },
  )
  it("closes directory handles when traversal is cancelled", async () => {
    const controller = new AbortController()
    const original = fs.opendir
    let closed = false
    vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      const handle = await original(...args)
      const close = handle.close.bind(handle)
      handle.close = (async () => {
        closed = true
        await close()
      }) as typeof handle.close
      controller.abort()
      return handle
    })
    await expect(
      captureWorkspaceSource(root, definition(), { signal: controller.signal }),
    ).rejects.toThrow()
    expect(closed).toBe(true)
  })
  it("bounds directory traversal including empty directories", async () => {
    for (let batch = 0; batch < 101; batch++) {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) => fs.mkdir(join(root, "source", `dir-${batch}-${i}`))),
      )
    }
    await expect(captureWorkspaceSource(root, definition())).rejects.toThrow(/traversal.*limit/i)
  }, 30000)
  it("bounds all inspected paths while counting shared ancestors only once", async () => {
    const files = Array.from({ length: 5000 }, (_, i) => ({
      path: `file-${i}`,
      file: `dir-${i}/file`,
    }))
    for (let offset = 0; offset < files.length; offset += 100) {
      await Promise.all(
        files.slice(offset, offset + 100).map(async ({ file }) => {
          await fs.mkdir(join(root, file.split("/")[0] as string))
          await fs.writeFile(join(root, file), "")
        }),
      )
    }
    // appRoot + source + 4999 directories + 4999 files = exactly 10000 paths.
    await expect(
      captureWorkspaceSource(root, { ...definition(), files: files.slice(0, 4999) }),
    ).resolves.toBeDefined()
    const stats = vi.spyOn(fs, "lstat")
    await expect(captureWorkspaceSource(root, { ...definition(), files })).rejects.toThrow(
      /traversal.*limit/i,
    )
    expect(stats).not.toHaveBeenCalledWith(join(root, "dir-4999"), expect.anything())
  }, 30000)
  it("bounds aggregate bytes including inline files", async () => {
    const names = ["a", "b", "c", "d"]
    for (const name of names) {
      const handle = await fs.open(join(root, "source", name), "w")
      await handle.truncate(16 * 1024 * 1024)
      await handle.close()
    }
    await expect(
      captureWorkspaceSource(root, { ...definition(names), files: [{ path: "extra", text: "x" }] }),
    ).rejects.toThrow(/total byte limit/i)
  })
})
