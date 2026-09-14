import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { dockerSandbox } from "@b4run/sandbox"
import { z } from "zod"
import { redactEvidence } from "./evidence.js"
import { selectFixture } from "./fixture-catalog.js"
import { sandboxImage } from "./verifier.js"

export async function runChild(
  exe: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  interactive = false,
  signal?: AbortSignal,
) {
  return new Promise<{ status: string; exitCode: number | null; output: string }>((resolveRun) => {
    const child = spawn(exe, args, {
      env: { ...process.env, ...env },
      detached: true,
      stdio: [interactive ? "inherit" : "ignore", "pipe", "pipe"],
    })
    let output = ""
    let timedOut = false
    let cancelled = false
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-1024 * 1024)
    }
    child.stdout.on("data", capture)
    child.stderr.on("data", capture)
    if (interactive) child.stderr.pipe(process.stderr)
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          child.kill("SIGKILL")
        }
      }
    }
    const cancel = () => {
      cancelled = true
      kill()
    }
    process.once("SIGINT", cancel)
    process.once("SIGTERM", cancel)
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
    const timeout = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    child.on("error", (error) => {
      output += error.message
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      process.removeListener("SIGINT", cancel)
      process.removeListener("SIGTERM", cancel)
      signal?.removeEventListener("abort", cancel)
      resolveRun({
        status: cancelled
          ? "cancelled"
          : timedOut
            ? "timed-out"
            : code === 0
              ? "completed"
              : "infrastructure-failed",
        exitCode: code,
        output,
      })
    })
  })
}

export async function runAttempt(options: {
  task: string
  mode: "live" | "replay"
  outputRoot: string
  timeoutMs?: number
  interactive?: boolean
}) {
  const task = selectFixture(options.task)
  if (options.mode === "live" && !process.env.OPENAI_API_KEY)
    throw new Error("OPENAI_API_KEY is required; no replay fallback is used")
  const id = randomUUID()
  const output = resolve(options.outputRoot, id)
  await mkdir(output, { recursive: true })
  const startedAt = new Date().toISOString()
  await writeFile(
    join(output, "attempt.json"),
    JSON.stringify({ id, task, mode: options.mode, startedAt }),
    { flag: "wx" },
  )
  const worker = fileURLToPath(new URL("../../scripts/attempt-worker.ts", import.meta.url))
  const child = await runChild(
    process.execPath,
    ["--import", "tsx", worker],
    {
      B4_CODE_FIXER_TASK: task,
      B4_CODE_FIXER_MODE: options.mode,
      B4_CODE_FIXER_ATTEMPT_DIR: output,
      B4_CODE_FIXER_INTERACTIVE: options.interactive ? "1" : "0",
    },
    options.timeoutMs ?? 600_000,
    options.interactive ?? false,
  )
  let receipt: Record<string, unknown> = { passed: false, status: child.status }
  try {
    receipt = JSON.parse(await readFile(join(output, "worker-result.json"), "utf8"))
  } catch (error) {
    receipt.error =
      child.status === "completed" ? `Missing worker receipt: ${String(error)}` : child.status
    if (child.status === "completed") receipt.status = "artifact-failed"
  }
  if (child.status !== "completed") {
    receipt.status = child.status
    receipt.passed = false
  }
  // Child cleanup is best effort. This parent owns the durable acquisition log.
  try {
    let registered = ""
    try {
      registered = await readFile(join(output, "owned-threads.jsonl"), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const provider = dockerSandbox({ scope: "code-fixer", image: sandboxImage })
    await destroyRegisteredThreads(provider, registered)
  } catch (error) {
    receipt.cleanupError = String(error)
    receipt.passed = false
    receipt.status = "cleanup-failed"
  }
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/.test(name) && value && value.length > 5)
    .map(([, value]) => value as string)
  const final = redactEvidence(
    {
      ...receipt,
      id,
      task,
      mode: options.mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      child,
    },
    secrets,
    [process.env.HOME ?? ""],
  ) as Record<string, unknown>
  try {
    await writeFile(join(output, "result.json"), JSON.stringify(final, null, 2), { flag: "wx" })
  } catch (error) {
    final.passed = false
    final.status = "artifact-failed"
    final.artifactError = redactEvidence(String(error), secrets, [process.env.HOME ?? ""])
    console.error(JSON.stringify({ attempt: final }))
  }
  return { output, receipt: final }
}

export async function destroyRegisteredThreads(
  provider: { destroy(id: string): Promise<void> },
  registered: string,
) {
  const cleanup = await Promise.allSettled(
    [...new Set(registered.trim().split("\n").filter(Boolean))].map(async (line) => {
      await provider.destroy(z.uuid().parse(JSON.parse(line)))
    }),
  )
  const failed = cleanup.filter((result) => result.status === "rejected")
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      "Owned sandbox cleanup failed",
    )
}
