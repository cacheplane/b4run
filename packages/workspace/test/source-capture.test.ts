import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
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
  /**
   * Run `mutate()` on every turn of the event loop from the moment `after()` first holds until
   * `pending` settles, and return how many times it ran. The capture awaits dozens of
   * filesystem calls between its first inspection of a path and its final re-inspection, each
   * yielding a turn, so a mutation that begins once the path is tracked lands inside that window.
   */
  async function churnUntilSettled(
    pending: Promise<unknown>,
    after: () => boolean,
    mutate: () => void,
  ): Promise<number> {
    let settled = false
    const settle = pending.then(
      () => (settled = true),
      () => (settled = true),
    )
    let mutations = 0
    while (!settled) {
      if (after()) {
        mutate()
        mutations++
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    await settle
    return mutations
  }
  /** Whether the capture has inspected `path` (spelled as the capture does: realpath'd) at least once. */
  const inspected =
    (spy: { mock: { calls: readonly (readonly unknown[])[] } }, path: string) => () =>
      spy.mock.calls.some((call) => call[0] === path)
  it("tolerates entries appearing and vanishing in directories above the source", async () => {
    // Two capture roots sharing one parent, as the software factory's concurrent captures do
    // (`captures/<role>/<task>.<instance>`): each capture creates and removes its own staging
    // directory beside the other's, which changes the shared parent's mtime, never a byte
    // of either source. Only the directories' identities are checked.
    await fs.mkdir(join(root, "nest", "source"), { recursive: true })
    for (let i = 0; i < 20; i++) await fs.writeFile(join(root, "nest", "source", `f${i}`), `${i}`)
    const include = Array.from({ length: 20 }, (_, i) => `f${i}`)
    let n = 0
    const real = await fs.realpath(root)
    const lstat = vi.spyOn(fs, "lstat")
    const capture = captureWorkspaceSource(root, { directory: "nest/source", include })
    const mutations = await churnUntilSettled(capture, inspected(lstat, join(real, "nest")), () => {
      mkdirSync(join(root, "nest", `sibling-${n}`))
      rmSync(join(root, "nest", `sibling-${n}`), { recursive: true })
      mkdirSync(join(root, `sibling-${n}`))
      rmSync(join(root, `sibling-${n}`), { recursive: true })
      n++
    })
    expect(mutations).toBeGreaterThan(2)
    const bundle = await capture
    expect(bundle.files.map((f) => f.path)).toEqual([...include].sort())
  })
  /**
   * Spy on `lstat` and run `mutate()` once, synchronously, right after the capture's first lstat
   * of `path` resolves and before the capture sees the result. The capture awaits one filesystem
   * call at a time, so no other lstat is in flight while `mutate()` runs: a multi-step mutation
   * (two renames, say) is atomic from the capture's point of view, and the capture is known to
   * have recorded `path` before it changes. Racing a real mutation against the capture from the
   * event loop instead lets an in-flight threadpool lstat land between the steps (#941).
   */
  function mutateAfterFirstInspection(path: string, mutate: () => void) {
    const original = fs.lstat
    let mutated = false
    return vi.spyOn(fs, "lstat").mockImplementation((async (
      ...args: Parameters<typeof fs.lstat>
    ) => {
      const stats = await original(...args)
      if (!mutated && args[0] === path) {
        mutated = true
        mutate()
      }
      return stats
    }) as typeof fs.lstat)
  }
  it("still rejects an ancestor directory that is swapped out", async () => {
    await fs.mkdir(join(root, "nest", "source"), { recursive: true })
    await fs.writeFile(join(root, "nest", "source", "a"), "a")
    const real = await fs.realpath(root)
    // Once the walk has reached `nest/source`, `nest` itself has been inspected and recorded.
    const lstat = mutateAfterFirstInspection(join(real, "nest", "source"), () => {
      // Replace `nest` with a fresh directory holding the same tree: a new inode, same bytes.
      mkdirSync(join(root, "nest2", "source"), { recursive: true })
      writeFileSync(join(root, "nest2", "source", "a"), "a")
      renameSync(join(root, "nest"), join(root, "nest-old"))
      renameSync(join(root, "nest2"), join(root, "nest"))
    })
    await expect(
      captureWorkspaceSource(root, { directory: "nest/source", include: ["a"] }),
    ).rejects.toThrow(/changed during capture/)
    expect(lstat.mock.calls.filter((call) => call[0] === join(real, "nest", "source"))).not.toEqual(
      [],
    )
  })
  it("rejects an ancestor directory whose identity changes, even with its source intact", async () => {
    // The identity check itself, isolated from what a real swap also changes below the ancestor:
    // every later lstat of `nest` reports a different inode, and nothing else moves.
    await fs.mkdir(join(root, "nest", "source"), { recursive: true })
    await fs.writeFile(join(root, "nest", "source", "a"), "a")
    const real = await fs.realpath(root)
    const nest = join(real, "nest")
    const original = fs.lstat
    let seen = 0
    vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const stats = await original(...args)
      if (args[0] !== nest || seen++ === 0) return stats
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        ino: (stats.ino as bigint) + 1n,
      })
    }) as typeof fs.lstat)
    await expect(
      captureWorkspaceSource(root, { directory: "nest/source", include: ["a"] }),
    ).rejects.toMatchObject({ message: `Source changed during capture: ${nest}` })
    expect(seen).toBeGreaterThan(1)
  })
  it("rejects a source file that changes after it is first inspected", async () => {
    await fs.mkdir(join(root, "nest", "source"), { recursive: true })
    await fs.writeFile(join(root, "nest", "source", "a"), "a")
    const real = await fs.realpath(root)
    mutateAfterFirstInspection(join(real, "nest", "source", "a"), () =>
      appendFileSync(join(root, "nest", "source", "a"), "a"),
    )
    await expect(
      captureWorkspaceSource(root, { directory: "nest/source", include: ["a"] }),
    ).rejects.toThrow(/changed/)
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
