import type { WorkspaceFs } from "@b4run/sdk"
import { describe, expect, it } from "vitest"
import * as workspace from "../src/index.ts"
import type { SandboxHandle } from "../src/sandbox-types.ts"
import type { FilesystemBackend } from "../src/types.ts"

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
  return { handle, author, backend, calls }
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
  for (const adapter of ["handle", "author"] as const) {
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
    })
  }
  for (const name of ["..", ".", "a/b", "a\\b", "", "x\0y", "/escape"]) {
    it(`rejects invalid leaf ${JSON.stringify(name)} before access`, async () => {
      const f = fixture({ "/workspace": { kind: "directory", names: [name] } })
      await expect(workspace.inspectWorkspace(f.handle)).rejects.toThrow(/name/)
      expect(f.calls).toEqual(["/workspace"])
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
})
