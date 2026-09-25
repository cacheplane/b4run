import { spawn } from "node:child_process"

export interface SpawnResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type Spawner = (
  args: readonly string[],
  opts?: { readonly stdin?: string; readonly signal?: AbortSignal },
) => Promise<SpawnResult>

/**
 * Run `executable` and collect its output. A child that exits before reading all of its stdin
 * closes the pipe, and Node then emits EPIPE on the stdin stream; left unhandled that is an
 * uncaught exception that takes the whole process down. The child's exit status already reports
 * the failure, so EPIPE is ignored and any other stdin error rejects.
 */
export function spawnCollect(
  executable: string,
  args: readonly string[],
  opts?: { readonly stdin?: string; readonly signal?: AbortSignal },
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts?.signal ? { signal: opts.signal } : {}),
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => {
      stdout += String(c)
    })
    child.stderr.on("data", (c) => {
      stderr += String(c)
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }))
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error)
    })
    if (opts?.stdin !== undefined) child.stdin.end(opts.stdin)
    else child.stdin.end()
  })
}

const defaultSpawn: Spawner = (args, opts) => spawnCollect("docker", args, opts)

export interface Docker {
  run(args: readonly string[], opts?: { readonly signal?: AbortSignal }): Promise<SpawnResult>
  exec(
    container: string,
    command: readonly string[],
    opts?: { readonly stdin?: string; readonly signal?: AbortSignal },
  ): Promise<SpawnResult>
}

/** Thin docker-CLI wrapper. `spawn` is injectable so unit tests need no daemon. */
export function createDocker(deps: { readonly spawn?: Spawner } = {}): Docker {
  const sp = deps.spawn ?? defaultSpawn
  return {
    run: (args, opts) => sp(args, opts),
    exec: (container, command, opts) => sp(["exec", "-i", container, ...command], opts),
  }
}
