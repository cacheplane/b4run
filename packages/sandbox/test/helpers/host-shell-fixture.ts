import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Owns direct children and their stdio; does not promise descendant-tree cleanup. */
export function createHostShellFixture(options: { ipc?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "b4-read-cap-"))
  const controller = new AbortController()
  const outputSizes: number[] = []
  const children: ChildProcessWithoutNullStreams[] = []
  const owners: { closed: Promise<void>; operation: Promise<unknown> }[] = []
  let admitting = true
  let disposal: Promise<void> | undefined
  const run = (argv: string[], stdin?: string, signal: AbortSignal = controller.signal) => {
    if (!admitting) return Promise.reject(new Error("Host-shell fixture is closing"))
    if (signal !== controller.signal)
      return Promise.reject(new Error("Expected fixture caller signal"))
    // An actual adapter's pre-aborted caller signal must not launch a new child.
    try {
      signal.throwIfAborted()
    } catch (error) {
      return Promise.reject(error)
    }
    let markClosed!: () => void
    let launched = false
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve
    })
    const operation = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve, reject) => {
        // The opt-in IPC tuple still guarantees the same three non-null pipe streams.
        const child = (
          options.ipc
            ? spawn(argv[0] as string, argv.slice(1), {
                signal,
                stdio: ["pipe", "pipe", "pipe", "ipc"],
              })
            : spawn(argv[0] as string, argv.slice(1), { signal })
        ) as ChildProcessWithoutNullStreams
        launched = true
        children.push(child)
        const out: Buffer[] = []
        const err: Buffer[] = []
        let failed = false
        let failure: unknown
        const remember = (error: unknown) => {
          if (!failed) {
            failed = true
            failure = error
          }
        }
        let childClosed = false
        let ipcClosed = !options.ipc
        if (options.ipc)
          child.once("disconnect", () => {
            ipcClosed = true
            if (childClosed) markClosed()
          })
        child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
        child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
        child.on("error", remember)
        child.stdout.on("error", remember)
        child.stderr.on("error", remember)
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE") remember(error)
        })
        // Node's close event follows direct-child exit/error and closed stdio.
        child.on("close", (code) => {
          const stdout = Buffer.concat(out).toString("utf8")
          outputSizes.push(Buffer.byteLength(stdout))
          childClosed = true
          if (ipcClosed) markClosed()
          if (failed) reject(failure)
          else resolve({ stdout, stderr: Buffer.concat(err).toString("utf8"), exitCode: code ?? 1 })
        })
        try {
          child.stdin.end(stdin ?? "")
        } catch (error) {
          remember(error)
        }
      },
    )
    // Observe rejection now while preserving the original promise for the caller.
    void operation.catch(() => {})
    // A synchronous spawn validation throw creates no ChildProcess to close.
    if (launched) owners.push({ closed, operation })
    return operation
  }
  const ctx: { workspaceRoot: string; signal: AbortSignal } = {
    workspaceRoot: root,
    signal: controller.signal,
  }
  return {
    root,
    children,
    outputSizes,
    ctx,
    run,
    abort: (reason: unknown) => controller.abort(reason),
    close() {
      if (disposal) return disposal
      admitting = false
      controller.abort(new Error("Host-shell fixture is closing"))
      disposal = (async () => {
        // Unknown close remains pending and retains root; never infer close from error.
        const drains = await Promise.allSettled(owners.map((owner) => owner.closed))
        const failures = drains.flatMap((entry) =>
          entry.status === "rejected" ? [entry.reason] : [],
        )
        if (failures.length)
          throw new AggregateError(failures, "Host-shell child close failed; root retained")
        // Operation failures still belong to callers; teardown joins their settlement.
        await Promise.allSettled(owners.map((owner) => owner.operation))
        rmSync(root, { recursive: true, force: true })
      })()
      return disposal
    },
  }
}

export type HostShellFixture = ReturnType<typeof createHostShellFixture>
