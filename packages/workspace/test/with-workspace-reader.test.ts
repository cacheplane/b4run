import { describe, expect, test } from "vitest"
import { inspectWorkspace } from "../src/inspect-workspace.ts"
import type {
  ReadOnlyFilesystemBackend,
  SandboxProvider,
  SandboxWorkspaceReader,
} from "../src/sandbox-types.ts"
import { scopedWorkspaceReader, withWorkspaceReader } from "../src/with-workspace-reader.ts"

const text = (value: string) => new TextEncoder().encode(value)

function reads(files: Record<string, string>): ReadOnlyFilesystemBackend {
  const has = (path: string) => Object.hasOwn(files, path)
  const isDirectory = (path: string) =>
    path === "/workspace" || Object.keys(files).some((key) => key.startsWith(`${path}/`))
  return {
    async lstat(path) {
      if (has(path)) {
        return { kind: "file", size: text(files[path] as string).length, executable: false }
      }
      if (isDirectory(path)) return { kind: "directory", size: 0, executable: false }
      throw new Error(`ENOENT: ${path}`)
    },
    async listDir(path) {
      const prefix = `${path}/`
      const names = new Set<string>()
      for (const key of Object.keys(files)) {
        if (key.startsWith(prefix)) {
          const part = key.slice(prefix.length).split("/")[0]
          if (part !== undefined) names.add(part)
        }
      }
      return [...names].sort()
    },
    async readFile(path) {
      if (!has(path)) throw new Error(`ENOENT: ${path}`)
      return files[path] as string
    },
    async readBinaryFile(path) {
      if (!has(path)) throw new Error(`ENOENT: ${path}`)
      return text(files[path] as string)
    },
    async statFile(path) {
      if (!has(path)) throw new Error(`ENOENT: ${path}`)
      return { size: text(files[path] as string).length, mtimeMs: 0 }
    },
  }
}

function providerFor(options: {
  readonly files?: Record<string, string>
  readonly closeError?: Error
  readonly openError?: Error
  readonly capable?: boolean
}): { provider: SandboxProvider; closes: number } {
  const state = { closes: 0 }
  const reader: SandboxWorkspaceReader = {
    threadId: "t",
    workspaceRoot: "/workspace",
    filesystem: reads(options.files ?? {}),
    async close() {
      state.closes += 1
      if (options.closeError) throw options.closeError
    },
  }
  const provider = {
    name: "test",
    acquire: async () => ({}) as never,
    release: async () => {},
    destroy: async () => {},
    ...(options.capable === false
      ? {}
      : {
          openWorkspaceReader: async () => {
            if (options.openError) throw options.openError
            return reader
          },
        }),
  } satisfies SandboxProvider
  return {
    provider,
    get closes() {
      return state.closes
    },
  }
}

const input = { threadId: "t", signal: new AbortController().signal }

describe("withWorkspaceReader", () => {
  test("returns the operation result and closes the reader", async () => {
    const harness = providerFor({ files: { "/workspace/a.txt": "one" } })
    const result = await withWorkspaceReader(harness.provider, input, async (r) => {
      expect(r.threadId).toBe("t")
      return r.filesystem.readFile("/workspace/a.txt", {
        signal: input.signal,
        workspaceRoot: "/workspace",
      })
    })
    expect(result).toBe("one")
    expect(harness.closes).toBe(1)
  })

  test("closes the reader when the operation throws, and rethrows the body failure", async () => {
    const harness = providerFor({})
    const failure = new Error("verification failed")
    await expect(
      withWorkspaceReader(harness.provider, input, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(harness.closes).toBe(1)
  })

  test("a close failure surfaces on its own", async () => {
    const closeError = new Error("reader cleanup failed")
    const harness = providerFor({ closeError })
    await expect(withWorkspaceReader(harness.provider, input, async () => "ok")).rejects.toBe(
      closeError,
    )
  })

  test("a close failure never swallows the body failure", async () => {
    const closeError = new Error("reader cleanup failed")
    const bodyError = new Error("verification failed")
    const harness = providerFor({ closeError })
    const thrown = await withWorkspaceReader(harness.provider, input, async () => {
      throw bodyError
    }).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([bodyError, closeError])
  })

  test("a provider without the capability rejects and never calls close", async () => {
    const harness = providerFor({ capable: false })
    await expect(withWorkspaceReader(harness.provider, input, async () => "ok")).rejects.toThrow(
      /does not support reading a thread workspace/,
    )
    expect(harness.closes).toBe(0)
  })

  test("an open failure is not masked, and close is not called", async () => {
    const openError = new Error("no workspace storage")
    const harness = providerFor({ openError })
    await expect(withWorkspaceReader(harness.provider, input, async () => "ok")).rejects.toBe(
      openError,
    )
    expect(harness.closes).toBe(0)
  })

  test("the reader it hands over is inspectWorkspace-compatible", async () => {
    const harness = providerFor({
      files: { "/workspace/src/a.ts": "export const a = 1\n", "/workspace/TASK.md": "do it\n" },
    })
    const inspection = await withWorkspaceReader(harness.provider, input, (r) =>
      inspectWorkspace(r),
    )
    expect(inspection.files).toEqual({
      "TASK.md": "do it\n",
      "src/a.ts": "export const a = 1\n",
    })
    expect(harness.closes).toBe(1)
  })
})

describe("scopedWorkspaceReader", () => {
  test("opens lazily, returns the result and closes", async () => {
    const harness = providerFor({ files: { "/workspace/a.txt": "one" } })
    let opened = 0
    const result = await scopedWorkspaceReader(
      async () => {
        opened += 1
        return harness.provider.openWorkspaceReader?.(input) as Promise<SandboxWorkspaceReader>
      },
      async (r) =>
        r.filesystem.readFile("/workspace/a.txt", {
          signal: input.signal,
          workspaceRoot: "/workspace",
        }),
    )
    expect({ result, opened, closes: harness.closes }).toEqual({
      result: "one",
      opened: 1,
      closes: 1,
    })
  })

  test("an open failure surfaces without a close", async () => {
    const openError = new Error("no such workspace")
    const harness = providerFor({ openError })
    await expect(
      scopedWorkspaceReader(
        () => harness.provider.openWorkspaceReader?.(input) as Promise<SandboxWorkspaceReader>,
        async () => "ok",
      ),
    ).rejects.toBe(openError)
    expect(harness.closes).toBe(0)
  })

  test("a close failure never swallows the body failure", async () => {
    const closeError = new Error("reader cleanup failed")
    const bodyError = new Error("verification failed")
    const harness = providerFor({ closeError })
    const thrown = await scopedWorkspaceReader(
      () => harness.provider.openWorkspaceReader?.(input) as Promise<SandboxWorkspaceReader>,
      async () => {
        throw bodyError
      },
    ).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([bodyError, closeError])
  })
})
