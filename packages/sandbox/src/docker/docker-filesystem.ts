import { randomUUID } from "node:crypto"
import type { BackendContext, FilesystemBackend } from "@b4run/workspace"
import { metadataFromStat, readSandboxFiles, walkSandboxTree } from "../batch-read.js"
import { readSandboxBytes } from "../bounded-read.js"
import type { Docker, SpawnResult } from "./docker-cli.js"
import {
  type DockerPidExhaustionRecovery,
  isDockerExecAdmissionPidExhaustion,
  isStartedShellPidExhaustion,
} from "./docker-pid-exhaustion.js"

interface DockerFilesystemOptions {
  readonly runWithExecLease?: <T>(operation: () => Promise<T>) => Promise<T>
  readonly pidExhaustionRecovery?: DockerPidExhaustionRecovery
}

function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** FilesystemBackend whose ops run inside a docker container via `docker exec`. */
export function dockerFilesystem(
  docker: Docker,
  container: string,
  opts: DockerFilesystemOptions = {},
): FilesystemBackend {
  const run = async (cmd: string, ctx: BackendContext, stdin?: string): Promise<SpawnResult> => {
    const startedMarker = `__B4_FILESYSTEM_STARTED_${randomUUID()}__`
    const startedPrefix = `${startedMarker}\n`
    const attempt = async () => {
      const result = await docker.exec(
        container,
        ["sh", "-c", `printf '%s\\n' ${q(startedMarker)}; ${cmd}`],
        {
          ...(stdin !== undefined ? { stdin } : {}),
          signal: ctx.signal,
        },
      )
      const started = result.stdout.startsWith(startedPrefix)
      return {
        result: started ? { ...result, stdout: result.stdout.slice(startedPrefix.length) } : result,
        started,
      }
    }
    const executeWithLease = <T>(operation: () => Promise<T>) =>
      opts.runWithExecLease !== undefined ? opts.runWithExecLease(operation) : operation()
    let recoveryToken: unknown
    const firstAttempt = await executeWithLease(async () => {
      recoveryToken = opts.pidExhaustionRecovery?.captureToken()
      return attempt()
    })
    let result = firstAttempt.result
    if (
      opts.pidExhaustionRecovery !== undefined &&
      recoveryToken !== undefined &&
      (firstAttempt.started
        ? isStartedShellPidExhaustion(result)
        : isDockerExecAdmissionPidExhaustion(result))
    ) {
      const recovered = await opts.pidExhaustionRecovery.recoverAndRetry(
        recoveryToken,
        async () => (await attempt()).result,
      )
      if (recovered !== undefined) result = recovered
    }
    return result
  }
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
      const metadata = metadataFromStat(r.stdout.trimEnd())
      if (metadata.kind !== "symlink") return metadata
      const target = await run(`readlink -n -- ${q(path)}`, ctx)
      if (target.exitCode !== 0) throw new Error(`readlink failed: ${target.stderr.trim()}`)
      return {
        ...metadata,
        target: target.stdout,
      }
    },
    async walkTree(path, ctx, walkOpts) {
      return walkSandboxTree(path, walkOpts, (cmd) => run(cmd, ctx))
    },
    async readBinaryFiles(requests, ctx) {
      return readSandboxFiles(requests, (cmd) => run(cmd, ctx))
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
