import type { WorkspaceFs } from "@b4run/sdk"
import { describe, expect, it } from "vitest"
import * as workspace from "../src/index.ts"
import type { SandboxHandle } from "../src/sandbox-types.ts"
import type { FilesystemBackend, WalkedEntry } from "../src/types.ts"

type Entry = {
  kind: "file" | "directory" | "symlink" | "other"
  size?: number
  executable?: boolean
  target?: string
  bytes?: Uint8Array
  names?: string[]
}
function fixture(entries: Record<string, Entry>) {
  const calls: string[] = []
  const backend: FilesystemBackend = {
    async lstat(path, ctx) {
      calls.push(path)
      expect(ctx.workspaceRoot).toBe("/workspace")
      const e = entries[path]
      if (!e) throw new Error(`Missing ${path}`)
      return {
        kind: e.kind,
        size: e.size ?? e.bytes?.length ?? 0,
        executable: e.executable ?? false,
        ...(e.target !== undefined ? { target: e.target } : {}),
      }
    },
    async listDir(path) {
      return entries[path]?.names ?? []
    },
    async readBinaryFile(path) {
      return entries[path]?.bytes ?? new Uint8Array()
    },
    async readFile() {
      throw new Error("unsafe text fallback")
    },
    async writeFile() {
      throw new Error("unexpected write")
    },
    async realPath(path) {
      return path
    },
  }
  const handle: SandboxHandle = {
    threadId: "test",
    workspaceRoot: "/workspace",
    filesystem: backend,
    exec: {
      async runCommand() {
        throw new Error("unexpected shell")
      },
    },
  }
  const ctx = { workspaceRoot: "/workspace", signal: new AbortController().signal }
  const author: WorkspaceFs = {
    stat: (path) =>
      backend.lstat?.(`/workspace${path === "." ? "" : `/${path}`}`, ctx) as ReturnType<
        NonNullable<FilesystemBackend["lstat"]>
      >,
    listDir: (path) => backend.listDir(`/workspace${path === "." ? "" : `/${path}`}`, ctx),
    readBinaryFile: (path, options) =>
      backend.readBinaryFile?.(`/workspace/${path}`, ctx, options) as Promise<Uint8Array>,
    readFile: () => {
      throw new Error("unsafe text fallback")
    },
    writeFile: () => {
      throw new Error("unexpected write")
    },
  }
  // The same tree served through the batch methods: a walk of `entries` below the root
  // (pruning root names) and a batch read with `readBinaryFile`'s maxBytes semantics.
  const batchCalls: string[] = []
  const batchedBackend: FilesystemBackend = {
    ...backend,
    async listDir(path) {
      throw new Error(`unexpected per-entry listDir: ${path}`)
    },
    async readBinaryFile(path) {
      throw new Error(`unexpected per-entry read: ${path}`)
    },
    async walkTree(path, _ctx, opts) {
      batchCalls.push(`walk ${path} prune=${(opts.prune ?? []).join(",")}`)
      const walked: WalkedEntry[] = []
      const visit = (directory: string, relative: string) => {
        for (const name of entries[directory]?.names ?? []) {
          const full = `${directory}/${name}`
          const rel = relative ? `${relative}/${name}` : name
          const e = entries[full] ?? { kind: "file" as const }
          walked.push({
            path: rel,
            kind: e.kind,
            size: e.size ?? e.bytes?.length ?? 0,
            executable: e.executable ?? false,
            ...(e.target !== undefined ? { target: e.target } : {}),
          })
          if (e.kind === "directory" && !(relative === "" && opts.prune?.includes(name)))
            visit(full, rel)
        }
      }
      visit(path, "")
      return walked
    },
    async readBinaryFiles(requests) {
      batchCalls.push(`read ${requests.length}`)
      return requests.map(({ path, maxBytes }) => {
        const bytes = entries[path]?.bytes ?? new Uint8Array()
        if (bytes.length > maxBytes) throw new Error(`${path}: content exceeds maxBytes`)
        return bytes
      })
    },
  }
  const batched: SandboxHandle = { ...handle, filesystem: batchedBackend }
  return { handle, author, batched, backend, batchedBackend, calls, batchCalls }
}
const text = (s: string) => new TextEncoder().encode(s)
const tree = (entry: Entry) => ({
  "/workspace": { kind: "directory" as const, names: ["file"] },
  "/workspace/file": entry,
})

describe("inspectWorkspace", () => {
  it("exports the inspection primitive", () => {
    expect(workspace).toHaveProperty("inspectWorkspace")
  })
  for (const adapter of ["handle", "author", "batched"] as const) {
    it(`inventories text and validated links through ${adapter}`, async () => {
      const f = fixture({
        "/workspace": { kind: "directory", names: ["src", ".git", "node_modules", "__proto__"] },
        "/workspace/src": { kind: "directory", names: ["a.ts"] },
        "/workspace/src/a.ts": { kind: "file", bytes: text("\ufeffhello\n") },
        "/workspace/.git": { kind: "directory", names: ["not-read"] },
        "/workspace/node_modules": { kind: "symlink", target: "/opt/deps" },
        "/workspace/__proto__": { kind: "file", bytes: text("safe") },
      })
      const result = await workspace.inspectWorkspace(f[adapter], {
        excludeRootDirectories: [".git"],
        expectedRootSymlinks: { node_modules: "/opt/deps" },
      })
      expect(result.files["src/a.ts"]).toBe("\ufeffhello\n")
      expect(Object.getOwnPropertyDescriptor(result.files, "__proto__")?.value).toBe("safe")
      expect(Object.getPrototypeOf(result.files)).toBeNull()
      expect(result.symlinks.node_modules).toBe("/opt/deps")
      expect(result.totalBytes).toBe(13)
      expect(f.calls).not.toContain("/workspace/.git/not-read")
    })
  }
  for (const [label, entry] of Object.entries({
    binary: { kind: "file", bytes: text("a\0b") },
    utf8: { kind: "file", bytes: new Uint8Array([0xff]) },
    executable: { kind: "file", executable: true, bytes: text("hello") },
    symlink: { kind: "symlink", target: "/etc/passwd" },
    device: { kind: "other" },
  } satisfies Record<string, Entry>)) {
    it(`rejects ${label}`, async () => {
      await expect(workspace.inspectWorkspace(fixture(tree(entry)).handle)).rejects.toThrow()
      await expect(workspace.inspectWorkspace(fixture(tree(entry)).batched)).rejects.toThrow()
    })
  }
  for (const name of ["..", ".", "a/b", "a\\b", "", "x\0y", "/escape"]) {
    it(`rejects invalid leaf ${JSON.stringify(name)} before access`, async () => {
      const f = fixture({ "/workspace": { kind: "directory", names: [name] } })
      await expect(workspace.inspectWorkspace(f.handle)).rejects.toThrow(/name/)
      expect(f.calls).toEqual(["/workspace"])
      const g = fixture({ "/workspace": { kind: "directory", names: [name] } })
      await expect(workspace.inspectWorkspace(g.batched)).rejects.toThrow(/name/)
      expect(g.calls).toEqual(["/workspace"])
      expect(g.batchCalls).toEqual(["walk /workspace prune="])
    })
  }
  it("bounds both stat size and actual bytes, individual and aggregate", async () => {
    await expect(
      workspace.inspectWorkspace(fixture(tree({ kind: "file", size: 9 })).handle, {
        maxFileBytes: 8,
      }),
    ).rejects.toThrow(/byte/)
    await expect(
      workspace.inspectWorkspace(
        fixture(tree({ kind: "file", size: 0, bytes: text("oversized") })).handle,
        { maxFileBytes: 8 },
      ),
    ).rejects.toThrow(/byte/)
    await expect(
      workspace.inspectWorkspace(fixture(tree({ kind: "file", bytes: text("abc") })).handle, {
        maxTotalBytes: 2,
      }),
    ).rejects.toThrow(/byte/)
  })
  it("bounds directories and rejects duplicate entries", async () => {
    const f = fixture({
      "/workspace": { kind: "directory", names: ["a", "b"] },
      "/workspace/a": { kind: "directory" },
      "/workspace/b": { kind: "directory" },
    })
    await expect(workspace.inspectWorkspace(f.handle, { maxEntries: 1 })).rejects.toThrow(/entries/)
    await expect(
      workspace.inspectWorkspace(
        fixture({ "/workspace": { kind: "directory", names: ["a", "a"] } }).handle,
      ),
    ).rejects.toThrow(/duplicate/)
  })
  it("requires expected links and directory exclusions to have their declared kind", async () => {
    await expect(
      workspace.inspectWorkspace(fixture(tree({ kind: "symlink", target: "wrong" })).handle, {
        expectedRootSymlinks: { file: "right" },
      }),
    ).rejects.toThrow(/symlink/)
    await expect(
      workspace.inspectWorkspace(fixture(tree({ kind: "file" })).handle, {
        excludeRootDirectories: ["file"],
      }),
    ).rejects.toThrow(/directory/)
    await expect(
      workspace.inspectWorkspace(fixture(tree({ kind: "file" })).handle, {
        expectedRootSymlinks: { absent: "right" },
      }),
    ).rejects.toThrow(/symlink/)
  })
  it("counts aggregate bytes across files and bounds unread directories", async () => {
    const f = fixture({
      "/workspace": { kind: "directory", names: ["a", "b"] },
      "/workspace/a": { kind: "file", bytes: text("abc") },
      "/workspace/b": { kind: "file", bytes: text("abc") },
    })
    await expect(workspace.inspectWorkspace(f.handle, { maxTotalBytes: 5 })).rejects.toThrow(
      /bytes/,
    )
    expect(await workspace.inspectWorkspace(f.handle, { maxTotalBytes: 6 })).toMatchObject({
      totalBytes: 6,
      entries: 2,
    })
  })
  it("applies exclusions only at the root and rejects symlink roots", async () => {
    const f = fixture({
      "/workspace": { kind: "directory", names: ["src"] },
      "/workspace/src": { kind: "directory", names: [".git"] },
      "/workspace/src/.git": { kind: "symlink", target: "/outside" },
    })
    await expect(
      workspace.inspectWorkspace(f.handle, { excludeRootDirectories: [".git"] }),
    ).rejects.toThrow(/symlink/)
    await expect(
      workspace.inspectWorkspace(
        fixture({ "/workspace": { kind: "symlink", target: "/outside" } }).handle,
      ),
    ).rejects.toThrow(/directory/)
  })
  it("rejects invalid limits and conflicting or traversing policies", async () => {
    const f = fixture(tree({ kind: "file" }))
    for (const maxEntries of [-1, Infinity, NaN, 0.5]) {
      await expect(workspace.inspectWorkspace(f.handle, { maxEntries })).rejects.toThrow(/limit/)
    }
    await expect(
      workspace.inspectWorkspace(f.handle, { excludeRootDirectories: ["../outside"] }),
    ).rejects.toThrow(/name/)
    await expect(
      workspace.inspectWorkspace(f.handle, {
        excludeRootDirectories: ["file"],
        expectedRootSymlinks: { file: "/target" },
      }),
    ).rejects.toThrow(/Conflicting/)
    delete f.author.stat
    await expect(workspace.inspectWorkspace(f.author)).rejects.toThrow(/metadata/)
  })
  it("fails closed without metadata or raw reads", async () => {
    const f = fixture(tree({ kind: "file" }))
    delete f.backend.lstat
    await expect(workspace.inspectWorkspace(f.handle)).rejects.toThrow(/metadata/)
    const g = fixture(tree({ kind: "file" }))
    delete g.backend.readBinaryFile
    await expect(workspace.inspectWorkspace(g.handle)).rejects.toThrow(/binary/)
  })
  it("checks cancellation before and after backend calls and forwards the signal", async () => {
    const controller = new AbortController()
    const f = fixture(tree({ kind: "file", bytes: text("ok") }))
    f.backend.readBinaryFile = async (_path, ctx) => {
      expect(ctx.signal).toBe(controller.signal)
      controller.abort()
      return text("ok")
    }
    await expect(
      workspace.inspectWorkspace(f.handle, { signal: controller.signal }),
    ).rejects.toThrow()
    f.calls.length = 0
    await expect(
      workspace.inspectWorkspace(f.handle, { signal: controller.signal }),
    ).rejects.toThrow()
    expect(f.calls).toEqual([])
  })
  describe("through a backend's batch methods", () => {
    const deep = () =>
      fixture({
        "/workspace": { kind: "directory", names: ["src", ".git", "top.txt"] },
        "/workspace/src": { kind: "directory", names: ["a.ts", "nested"] },
        "/workspace/src/a.ts": { kind: "file", bytes: text("a") },
        "/workspace/src/nested": { kind: "directory", names: ["b.ts"] },
        "/workspace/src/nested/b.ts": { kind: "file", bytes: text("bb") },
        "/workspace/.git": { kind: "directory", names: ["HEAD"] },
        "/workspace/.git/HEAD": { kind: "file", bytes: text("ref") },
        "/workspace/top.txt": { kind: "file", bytes: text("top") },
      })

    it("walks once, reads once, and lstats only the root", async () => {
      const f = deep()
      const result = await workspace.inspectWorkspace(f.batched, {
        excludeRootDirectories: [".git"],
      })
      expect(result).toEqual(
        await workspace.inspectWorkspace(deep().handle, { excludeRootDirectories: [".git"] }),
      )
      expect(f.batchCalls).toEqual(["walk /workspace prune=.git", "read 3"])
      expect(f.calls).toEqual(["/workspace"])
      expect(result.files[".git/HEAD"]).toBeUndefined()
    })

    it("counts walked entries against the entry limit", async () => {
      await expect(workspace.inspectWorkspace(deep().batched, { maxEntries: 6 })).rejects.toThrow(
        /entries/,
      )
      expect((await workspace.inspectWorkspace(deep().batched, { maxEntries: 7 })).entries).toBe(7)
    })

    it("refuses a walk entry whose parent was not walked as a directory", async () => {
      const f = deep()
      f.batchedBackend.walkTree = async () => [
        { path: "orphan/child.txt", kind: "file", size: 0, executable: false },
      ]
      await expect(workspace.inspectWorkspace(f.batched)).rejects.toThrow(/name/)
      f.batchedBackend.walkTree = async () => [
        { path: "file", kind: "file", size: 0, executable: false },
        { path: "file/child", kind: "file", size: 0, executable: false },
      ]
      await expect(workspace.inspectWorkspace(f.batched)).rejects.toThrow(/name/)
      f.batchedBackend.walkTree = async () => [
        { path: "dup", kind: "file", size: 0, executable: false },
        { path: "dup", kind: "file", size: 0, executable: false },
      ]
      await expect(workspace.inspectWorkspace(f.batched)).rejects.toThrow(/duplicate/)
    })

    it("refuses a file that grew between the walk and the read", async () => {
      const f = fixture(tree({ kind: "file", size: 2, bytes: text("grown") }))
      await expect(workspace.inspectWorkspace(f.batched)).rejects.toThrow(/exceeds maxBytes/)
    })

    it("skips the prefetch when the files exceed the byte budget, and still refuses", async () => {
      const f = deep()
      // Without a prefetch the loop reads per entry, and its own budget check refuses.
      f.batchedBackend.readBinaryFile = f.backend.readBinaryFile as NonNullable<
        FilesystemBackend["readBinaryFile"]
      >
      await expect(workspace.inspectWorkspace(f.batched, { maxTotalBytes: 4 })).rejects.toThrow(
        /bytes/,
      )
      expect(f.batchCalls).toEqual(["walk /workspace prune="])
    })

    it("stays per-entry unless the backend offers both batch methods", async () => {
      const f = deep()
      delete f.batchedBackend.readBinaryFiles
      await expect(workspace.inspectWorkspace(f.batched)).rejects.toThrow(/unexpected per-entry/)
      expect(f.batchCalls).toEqual([])
    })

    it("checks cancellation after the walk", async () => {
      const controller = new AbortController()
      const f = deep()
      const walk = f.batchedBackend.walkTree?.bind(f.batchedBackend)
      f.batchedBackend.walkTree = async (...args) => {
        const result = await (walk as NonNullable<typeof walk>)(...args)
        controller.abort()
        return result
      }
      await expect(
        workspace.inspectWorkspace(f.batched, { signal: controller.signal }),
      ).rejects.toThrow()
      expect(f.batchCalls).toEqual(["walk /workspace prune="])
    })
  })
})
