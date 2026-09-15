import {
  lstat,
  mkdir as mkdirFs,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { BackendContext, FilesystemBackend } from "./types.js"

const DEFAULT_MAX_FILE_BYTES = 256 * 1024

export interface LocalFilesystemOptions {
  /**
   * Reject `readFile` when the target file exceeds this size.
   * Default: 256 KiB.
   */
  readonly maxFileBytes?: number
}

export function localFilesystem(opts: LocalFilesystemOptions = {}): FilesystemBackend {
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES

  async function assertWithinCap(path: string, limit: number): Promise<void> {
    const s = await stat(path)
    if (s.size > limit) {
      throw new Error(`File too large: ${s.size} bytes (max ${limit}) at ${path}`)
    }
  }

  async function readBytes(path: string, ctx: BackendContext, limit: number): Promise<Buffer> {
    ctx.signal.throwIfAborted()
    if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new Error("Invalid maxBytes limit")
    }
    await assertWithinCap(path, limit)
    if (limit === Infinity) return readFile(path, { signal: ctx.signal })
    const handle = await open(path, "r")
    try {
      const chunks: Buffer[] = []
      let length = 0
      for (;;) {
        ctx.signal.throwIfAborted()
        const chunk = Buffer.alloc(Math.min(64 * 1024, limit - length + 1))
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        ctx.signal.throwIfAborted()
        if (bytesRead === 0) return Buffer.concat(chunks, length)
        length += bytesRead
        if (length > limit) throw new Error(`File too large: exceeds ${limit} bytes at ${path}`)
        chunks.push(chunk.subarray(0, bytesRead))
      }
    } finally {
      await handle.close()
    }
  }

  return {
    async lstat(path) {
      const s = await lstat(path)
      return {
        kind: s.isSymbolicLink()
          ? "symlink"
          : s.isFile()
            ? "file"
            : s.isDirectory()
              ? "directory"
              : "other",
        size: s.size,
        executable: (s.mode & 0o111) !== 0,
        ...(s.isSymbolicLink() ? { target: await readlink(path) } : {}),
      }
    },
    async readFile(
      path: string,
      ctx: BackendContext,
      opts?: { readonly maxBytes?: number },
    ): Promise<string> {
      return (await readBytes(path, ctx, opts?.maxBytes ?? maxBytes)).toString("utf8")
    },
    async readBinaryFile(
      path: string,
      ctx: BackendContext,
      opts?: { readonly maxBytes?: number },
    ): Promise<Uint8Array> {
      return readBytes(path, ctx, opts?.maxBytes ?? maxBytes)
    },
    async writeFile(
      path: string,
      content: string,
      _ctx: BackendContext,
    ): Promise<{ readonly bytesWritten: number }> {
      // Create missing parent directories so writing to a nested workspace
      // path (e.g. "reports/result.md") succeeds without a separate mkdir.
      // `path` is already resolved and path-jailed inside the workspace root.
      await mkdirFs(dirname(path), { recursive: true })
      await writeFile(path, content, "utf8")
      return { bytesWritten: Buffer.byteLength(content, "utf8") }
    },
    async realPath(path: string, _ctx: BackendContext): Promise<string> {
      const tail: string[] = []
      let current = path
      for (;;) {
        try {
          const resolved = await realpath(current)
          return tail.length === 0 ? resolved : join(resolved, ...tail)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          const parent = dirname(current)
          if (parent === current) return path
          tail.unshift(basename(current))
          current = parent
        }
      }
    },
    async listDir(path: string, _ctx: BackendContext): Promise<readonly string[]> {
      return await readdir(path)
    },
    async statFile(path: string, _ctx: BackendContext) {
      const s = await stat(path)
      return { size: s.size, mtimeMs: s.mtimeMs }
    },
    async removeFile(path: string, _ctx: BackendContext) {
      await rm(path, { force: true })
    },
    async touchFile(path: string, _ctx: BackendContext) {
      const now = new Date()
      await utimes(path, now, now)
    },
    async mkdir(path: string, _ctx: BackendContext) {
      await mkdirFs(path, { recursive: true })
    },
  }
}
