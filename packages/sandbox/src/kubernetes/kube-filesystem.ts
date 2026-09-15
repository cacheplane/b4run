import type { BackendContext, FilesystemBackend } from "@b4run/workspace"
import { readSandboxBytes } from "../bounded-read.js"
import type { KubeClient } from "./kube-client.js"

function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** FilesystemBackend whose ops run inside a pod via KubeClient.exec. */
export function kubeFilesystem(
  client: KubeClient,
  namespace: string,
  pod: string,
): FilesystemBackend {
  const run = (cmd: string, ctx: BackendContext, stdin?: string) =>
    client.exec(namespace, pod, ["sh", "-c", cmd], {
      ...(stdin !== undefined ? { stdin } : {}),
      signal: ctx.signal,
    })
  return {
    async readFile(path, ctx, opts) {
      if (opts?.maxBytes !== undefined && opts.maxBytes !== Infinity) {
        return (
          await readSandboxBytes(path, opts.maxBytes, "readFile", (cmd) => run(cmd, ctx))
        ).toString("utf8")
      }
      const r = await run(`cat ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`readFile failed: ${r.stderr.trim()}`)
      return r.stdout
    },
    async readBinaryFile(path, ctx, opts) {
      return readSandboxBytes(path, opts?.maxBytes, "readBinaryFile", (cmd) => run(cmd, ctx))
    },
    async lstat(path, ctx) {
      const r = await run(`stat -c '%f %s' -- ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`lstat failed: ${r.stderr.trim()}`)
      const match = /^([a-fA-F0-9]+) ([0-9]+)\s*$/.exec(r.stdout)
      if (!match) throw new Error("Invalid lstat response")
      const mode = Number.parseInt(match[1] ?? "", 16)
      const size = Number(match[2])
      if (!Number.isSafeInteger(size)) throw new Error("Invalid lstat size")
      const kind =
        (mode & 0xf000) === 0xa000
          ? "symlink"
          : (mode & 0xf000) === 0x8000
            ? "file"
            : (mode & 0xf000) === 0x4000
              ? "directory"
              : "other"
      const metadata = { kind, size, executable: (mode & 0o111) !== 0 } as const
      if (kind !== "symlink") return metadata
      const target = await run(`readlink -n -- ${q(path)}`, ctx)
      if (target.exitCode !== 0) throw new Error(`readlink failed: ${target.stderr.trim()}`)
      return {
        ...metadata,
        target: target.stdout,
      }
    },
    async writeFile(path, content, ctx) {
      const r = await run(`mkdir -p "$(dirname ${q(path)})" && cat > ${q(path)}`, ctx, content)
      if (r.exitCode !== 0) throw new Error(`writeFile failed: ${r.stderr.trim()}`)
      return { bytesWritten: Buffer.byteLength(content) }
    },
    async listDir(path, ctx) {
      const r = await run(`find ${q(path)} -mindepth 1 -maxdepth 1 -print0`, ctx)
      if (r.exitCode !== 0) throw new Error(`listDir failed: ${r.stderr.trim()}`)
      return r.stdout
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.slice(entry.lastIndexOf("/") + 1))
    },
    async realPath(path, ctx) {
      const r = await run(`realpath -m ${q(path)}`, ctx)
      return r.exitCode === 0 ? r.stdout.trim() : path
    },
    async statFile(path, ctx) {
      const r = await run(`stat -c '%s %Y' ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`statFile failed: ${r.stderr.trim()}`)
      const [size, mtime] = r.stdout.trim().split(" ")
      return { size: Number(size), mtimeMs: Number(mtime) * 1000 }
    },
    async removeFile(path, ctx) {
      await run(`rm -f ${q(path)}`, ctx)
    },
    async touchFile(path, ctx) {
      await run(`touch ${q(path)}`, ctx)
    },
    async mkdir(path, ctx) {
      await run(`mkdir -p ${q(path)}`, ctx)
    },
  }
}
