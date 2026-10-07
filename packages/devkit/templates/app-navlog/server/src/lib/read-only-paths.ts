import { isAbsolute, relative, sep } from "node:path"
import type { BackendContext, FilesystemBackend, FilesystemMiddleware } from "@b4run/workspace"

/**
 * Workspace paths the agent may read but never change. An entry ending in "/"
 * protects that directory and everything under it; any other entry protects
 * that one file.
 *
 * The workspace is one host directory every visitor's turns share, and the
 * runtime's path gate covers only paths OUTSIDE it. Without this, any visitor
 * could get the agent to rewrite the POH tables, the aircraft baseline or
 * AGENTS.md for everyone. Backend methods receive an already-resolved
 * absolute path inside `ctx.workspaceRoot`; matching is case-insensitive
 * because a case-insensitive filesystem resolves `POH/x.md` to `poh/x.md`.
 * Matching is on the resolved path, not a symlink's target. That is safe here
 * because this backend cannot create symlinks and the route denies runBash;
 * an app that enables shell execution must revisit this.
 */
export function readOnlyPaths(protectedPaths: readonly string[]): FilesystemMiddleware {
  const entries = protectedPaths.map((entry) => entry.toLowerCase())

  const protectedRelative = (path: string, ctx: BackendContext): string | undefined => {
    const rel = relative(ctx.workspaceRoot, path).split(sep).join("/")
    if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return undefined
    const folded = rel.toLowerCase()
    const hit = entries.some((entry) =>
      entry.endsWith("/")
        ? folded === entry.slice(0, -1) || folded.startsWith(entry)
        : folded === entry,
    )
    return hit ? rel : undefined
  }

  const guard = (path: string, ctx: BackendContext): void => {
    const rel = protectedRelative(path, ctx)
    if (rel !== undefined) {
      throw new Error(
        `${rel} is read-only reference material in this app; write reports under reports/`,
      )
    }
  }

  return (next: FilesystemBackend): FilesystemBackend => {
    const { lstat, readBinaryFile, readBinaryFiles, statFile, walkTree } = next
    const { removeFile, touchFile, mkdir } = next
    return {
      readFile: (path, ctx, opts) => next.readFile(path, ctx, opts),
      writeFile: async (path, content, ctx) => {
        guard(path, ctx)
        return await next.writeFile(path, content, ctx)
      },
      listDir: (path, ctx) => next.listDir(path, ctx),
      realPath: (path, ctx) => next.realPath(path, ctx),
      ...(lstat && { lstat: (path, ctx) => lstat.call(next, path, ctx) }),
      ...(readBinaryFile && {
        readBinaryFile: (path, ctx, opts) => readBinaryFile.call(next, path, ctx, opts),
      }),
      ...(readBinaryFiles && {
        readBinaryFiles: (requests, ctx) => readBinaryFiles.call(next, requests, ctx),
      }),
      ...(statFile && { statFile: (path, ctx) => statFile.call(next, path, ctx) }),
      ...(walkTree && { walkTree: (path, ctx, opts) => walkTree.call(next, path, ctx, opts) }),
      ...(removeFile && {
        removeFile: async (path, ctx) => {
          guard(path, ctx)
          await removeFile.call(next, path, ctx)
        },
      }),
      ...(touchFile && {
        touchFile: async (path, ctx) => {
          guard(path, ctx)
          await touchFile.call(next, path, ctx)
        },
      }),
      ...(mkdir && {
        mkdir: async (path, ctx) => {
          guard(path, ctx)
          await mkdir.call(next, path, ctx)
        },
      }),
    }
  }
}
