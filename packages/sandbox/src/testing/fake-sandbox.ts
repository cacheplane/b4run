import type {
  BackendContext,
  ExecBackend,
  FilesystemBackend,
  OpenWorkspaceReaderInput,
  ReadOnlyFilesystemBackend,
  SandboxHandle,
  SandboxProvider,
  SandboxWorkspaceReader,
} from "@b4run/workspace"

type ExecFn = (
  args: {
    readonly command: string
    readonly cwd?: string
    readonly env?: Readonly<Record<string, string>>
  },
  ctx: BackendContext,
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>

const ROOT = "/workspace"

interface FakeEntry {
  content: string
  mtimeMs: number
}
type FakeVolume = Map<string, FakeEntry>

/** In-memory SandboxProvider for unit + wiring tests. No Docker. */
export function fakeSandbox(opts: { readonly exec?: ExecFn } = {}): SandboxProvider {
  const volumes = new Map<string, FakeVolume>()
  const liveThreads = new Set<string>()

  const volumeFor = (threadId: string): FakeVolume => {
    let v = volumes.get(threadId)
    if (!v) {
      v = new Map()
      volumes.set(threadId, v)
    }
    return v
  }

  const isDirectory = (vol: FakeVolume, path: string): boolean => {
    if (path === ROOT) return true
    const prefix = path.endsWith("/") ? path : `${path}/`
    for (const key of vol.keys()) if (key.startsWith(prefix)) return true
    return false
  }

  const children = (vol: FakeVolume, path: string): readonly string[] => {
    const prefix = path.endsWith("/") ? path : `${path}/`
    const names = new Set<string>()
    for (const key of vol.keys()) {
      if (key.startsWith(prefix)) {
        const part = key.slice(prefix.length).split("/")[0]
        if (part !== undefined) names.add(part)
      }
    }
    return [...names].sort()
  }

  // The read half offers the same MEMBERS as dockerFilesystem (lstat,
  // readBinaryFile, statFile), so `inspectWorkspace` works against both instead
  // of failing the fake for a missing capability.
  //
  // It is not equivalent in behaviour, and two gaps matter when choosing what to
  // prove here rather than in the Docker lane: this volume models no symlinks
  // (`kind` is only "file" or "directory", `target` is never set, so
  // `expectedRootSymlinks` cannot be exercised) and `executable` is always
  // false. `listDir` on a missing path also answers `[]` where Docker's `find`
  // fails. Assert those against real Docker.
  const makeReads = (vol: FakeVolume): ReadOnlyFilesystemBackend =>
    Object.freeze({
      async readFile(
        path: string,
        _ctx: BackendContext,
        readOpts?: { readonly maxBytes?: number },
      ) {
        const entry = vol.get(path)
        if (entry === undefined) throw new Error(`ENOENT: ${path}`)
        const max = readOpts?.maxBytes
        if (max !== undefined && max !== Number.POSITIVE_INFINITY) {
          const bytes = Buffer.from(entry.content, "utf8")
          if (bytes.byteLength > max) {
            throw new Error(`readFile ${path}: content exceeds maxBytes (${max}).`)
          }
        }
        return entry.content
      },
      async readBinaryFile(
        path: string,
        _ctx: BackendContext,
        readOpts?: { readonly maxBytes?: number },
      ) {
        const entry = vol.get(path)
        if (entry === undefined) throw new Error(`ENOENT: ${path}`)
        const bytes = new Uint8Array(Buffer.from(entry.content, "utf8"))
        const max = readOpts?.maxBytes
        if (max !== undefined && max !== Number.POSITIVE_INFINITY && bytes.byteLength > max) {
          throw new Error(`readBinaryFile ${path}: content exceeds maxBytes (${max}).`)
        }
        return bytes
      },
      async lstat(path: string) {
        const entry = vol.get(path)
        if (entry !== undefined) {
          return {
            kind: "file" as const,
            size: Buffer.byteLength(entry.content),
            executable: false,
          }
        }
        if (isDirectory(vol, path)) {
          return { kind: "directory" as const, size: 0, executable: false }
        }
        throw new Error(`ENOENT: ${path}`)
      },
      async listDir(path: string) {
        return children(vol, path)
      },
      async statFile(path: string) {
        const entry = vol.get(path)
        if (entry === undefined) throw new Error(`ENOENT: ${path}`)
        return { size: Buffer.byteLength(entry.content), mtimeMs: entry.mtimeMs }
      },
    })

  const makeFilesystem = (vol: FakeVolume): FilesystemBackend => {
    const reads = makeReads(vol)
    return {
      readFile: reads.readFile,
      readBinaryFile: reads.readBinaryFile,
      lstat: reads.lstat,
      listDir: reads.listDir,
      statFile: reads.statFile,
      async writeFile(path, content) {
        vol.set(path, { content, mtimeMs: Date.now() })
        return { bytesWritten: Buffer.byteLength(content) }
      },
      async realPath(path) {
        return path
      },
    }
  }

  const defaultExec: ExecFn = async () => ({ stdout: "", stderr: "", exitCode: 0 })

  return {
    name: "fake",
    async acquire({ threadId }): Promise<SandboxHandle> {
      liveThreads.add(threadId)
      const vol = volumeFor(threadId)
      const exec: ExecBackend = { runCommand: (args, ctx) => (opts.exec ?? defaultExec)(args, ctx) }
      return { threadId, filesystem: makeFilesystem(vol), exec, workspaceRoot: ROOT }
    },
    async openWorkspaceReader({
      threadId,
      signal,
    }: OpenWorkspaceReaderInput): Promise<SandboxWorkspaceReader> {
      signal.throwIfAborted()
      const vol = volumes.get(threadId)
      // Absence is an error, not an empty view: a verifier must be able to tell
      // "produced nothing" from "does not exist".
      if (vol === undefined) {
        throw new Error(`Sandbox unavailable: no workspace storage for thread "${threadId}".`)
      }
      return {
        threadId,
        workspaceRoot: ROOT,
        filesystem: makeReads(vol),
        async close() {
          // Nothing to release: the fake holds no out-of-process resource.
        },
      }
    },
    async release(threadId) {
      liveThreads.delete(threadId)
    },
    async destroy(threadId) {
      liveThreads.delete(threadId)
      volumes.delete(threadId)
    },
    async preflight() {
      return { ok: true }
    },
  }
}
