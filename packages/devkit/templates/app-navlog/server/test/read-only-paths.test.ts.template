import type { BackendContext, FilesystemBackend } from "@b4run/workspace"
import { describe, expect, it, vi } from "vitest"
import { readOnlyPaths } from "../src/lib/read-only-paths.ts"

const ROOT = "/app/workspace"
const ctx: BackendContext = { signal: new AbortController().signal, workspaceRoot: ROOT }
const PROTECTED = ["AGENTS.md", "aircraft/", "poh/", "regs/"] as const

function fakeBackend(): FilesystemBackend & Record<string, ReturnType<typeof vi.fn>> {
  return {
    lstat: vi.fn(async () => ({ kind: "file" as const, size: 1, executable: false })),
    readFile: vi.fn(async () => "content"),
    readBinaryFile: vi.fn(async () => new Uint8Array()),
    readBinaryFiles: vi.fn(async () => []),
    writeFile: vi.fn(async () => ({ bytesWritten: 1 })),
    listDir: vi.fn(async () => []),
    realPath: vi.fn(async (p: string) => p),
    statFile: vi.fn(async () => ({ size: 1, mtimeMs: 0 })),
    removeFile: vi.fn(async () => undefined),
    touchFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    walkTree: vi.fn(async () => []),
  }
}

const abs = (rel: string): string => `${ROOT}/${rel}`

describe("readOnlyPaths", () => {
  const PROTECTED_TARGETS = [
    "AGENTS.md",
    "aircraft/c172n.md",
    "aircraft",
    "poh/cruise-performance.md",
    "poh/new/deep.md",
    "regs/vfr-fuel-reserves.md",
    // A case-insensitive filesystem (macOS dev) resolves these to the protected files.
    "POH/cruise-performance.md",
    "agents.md",
  ]

  it("refuses every mutating method on a protected path, before reaching the backend", async () => {
    const next = fakeBackend()
    const fs = readOnlyPaths(PROTECTED)(next)
    for (const rel of PROTECTED_TARGETS) {
      await expect(fs.writeFile(abs(rel), "x", ctx)).rejects.toThrow(
        `${rel} is read-only reference material in this app; write reports under reports/`,
      )
      await expect(fs.removeFile?.(abs(rel), ctx)).rejects.toThrow(/read-only reference material/)
      await expect(fs.touchFile?.(abs(rel), ctx)).rejects.toThrow(/read-only reference material/)
      await expect(fs.mkdir?.(abs(rel), ctx)).rejects.toThrow(/read-only reference material/)
    }
    expect(next.writeFile).not.toHaveBeenCalled()
    expect(next.removeFile).not.toHaveBeenCalled()
    expect(next.touchFile).not.toHaveBeenCalled()
    expect(next.mkdir).not.toHaveBeenCalled()
  })

  it("lets writes through outside the protected entries", async () => {
    const next = fakeBackend()
    const fs = readOnlyPaths(PROTECTED)(next)
    for (const rel of [
      "reports/KSTP-KRST.md",
      "tool-outputs/x.txt",
      "flight-plans/261005-KSTP-KRST.txt",
      "poh2/x.md",
      "reports/AGENTS.md",
      "AGENTS.md.bak",
    ]) {
      await expect(fs.writeFile(abs(rel), "x", ctx)).resolves.toEqual({ bytesWritten: 1 })
    }
    expect(next.writeFile).toHaveBeenCalledTimes(6)
  })

  it("leaves a path outside the workspace root to the runtime's own path gate", async () => {
    const next = fakeBackend()
    const fs = readOnlyPaths(PROTECTED)(next)
    await fs.writeFile("/elsewhere/poh/x.md", "x", ctx)
    expect(next.writeFile).toHaveBeenCalledWith("/elsewhere/poh/x.md", "x", ctx)
  })

  it("forwards reads of protected paths unchanged", async () => {
    const next = fakeBackend()
    const fs = readOnlyPaths(PROTECTED)(next)
    await expect(fs.readFile(abs("poh/cruise-performance.md"), ctx)).resolves.toBe("content")
    await fs.listDir(abs("poh"), ctx)
    await fs.realPath(abs("poh"), ctx)
    await fs.lstat?.(abs("poh"), ctx)
    await fs.readBinaryFile?.(abs("poh/x"), ctx)
    await fs.readBinaryFiles?.([{ path: abs("poh/x"), maxBytes: 10 }], ctx)
    await fs.statFile?.(abs("poh/x"), ctx)
    await fs.walkTree?.(abs("poh"), ctx, { maxEntries: 10 })
    for (const method of [
      "readFile",
      "listDir",
      "realPath",
      "lstat",
      "readBinaryFile",
      "readBinaryFiles",
      "statFile",
      "walkTree",
    ]) {
      expect(next[method], method).toHaveBeenCalledTimes(1)
    }
  })

  it("keeps an optional method absent when the base lacks it", () => {
    const base: FilesystemBackend = {
      readFile: async () => "",
      writeFile: async () => ({ bytesWritten: 0 }),
      listDir: async () => [],
      realPath: async (p) => p,
    }
    const fs = readOnlyPaths(PROTECTED)(base)
    for (const method of [
      "lstat",
      "readBinaryFile",
      "readBinaryFiles",
      "statFile",
      "removeFile",
      "touchFile",
      "mkdir",
      "walkTree",
    ] as const) {
      expect(fs[method], method).toBeUndefined()
    }
  })
})
