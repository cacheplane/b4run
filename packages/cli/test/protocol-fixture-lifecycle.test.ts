import { execFile, spawn } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const docker = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile("docker", args, (error, stdout, stderr) =>
      done({ code: error ? Number(error.code) : 0, stdout, stderr }),
    )
  })

// New real child-runner lifecycle budget, selected before the first run.
// The child has45s to exit; outer60s leaves time for exact-owned fallback cleanup.
it("completes physical cleanup once while preserving a real shared-owner teardown failure", async () => {
  const child = spawn(
    process.execPath,
    [
      resolve(root, "node_modules/vitest/vitest.mjs"),
      "--run",
      "--config",
      resolve(root, "packages/cli/test/fixtures/protocol-failed-teardown.config.mjs"),
      "--fileParallelism",
      "false",
      "--maxWorkers",
      "1",
    ],
    { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  )
  let output = ""
  child.stdout.on("data", (value) => {
    output += String(value)
  })
  child.stderr.on("data", (value) => {
    output += String(value)
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000)
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (done, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => done({ code, signal }))
    },
  )
  let preserved: string | undefined
  const ids = new Set<string>()
  try {
    const result = await exited
    clearTimeout(timer)
    for (const match of output.matchAll(/R4 created own container ([a-f0-9]{64})/g))
      if (match[1]) ids.add(match[1])
    preserved = /R6 preserved failed shared fixture (.+)/.exec(output)?.[1]
    process.stdout.write(`R7 expected child teardown failure:\n${output}`)
    expect(result).toEqual({ code: 1, signal: null })
    expect(preserved).toBeDefined()
    if (!preserved) throw new Error("Missing preserved actual fixture artifact")
    const artifact = JSON.parse(readFileSync(resolve(preserved, "teardown-failure.json"), "utf8"))
    expect(artifact.errors.join(" ")).toContain("Owned permission work did not drain cleanly")
    const pg = process.env.B4_ADMISSION_POSTGRES === "1"
    if (pg) {
      expect(output.match(/R4 closed own PostgreSQL pools/g)).toHaveLength(1)
      expect(ids.size).toBe(1)
      for (const id of ids) {
        expect(output.split(`R4 removed own container ${id}`).length - 1).toBe(1)
        const inspected = await docker(["inspect", "--format", "{{.State.Status}}", id])
        expect(inspected.code).toBe(1)
        expect(inspected.stderr.trim()).toBe(`Error: No such object: ${id}`)
      }
    } else expect(ids.size).toBe(0)
    expect(output.match(/R6 closed own runtime installation /g)).toHaveLength(1)
    expect(JSON.stringify(artifact.errorCauses)).toContain(
      "intentional-post-drain-teardown-failure",
    )
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await exited
    for (const match of output.matchAll(/R4 created own container ([a-f0-9]{64})/g))
      if (match[1]) ids.add(match[1])
    for (const id of ids) {
      const inspected = await docker(["inspect", "--format", "{{.State.Status}}", id])
      if (inspected.code === 0) {
        const removed = await docker(["rm", "-f", id])
        expect(removed.code).toBe(0)
        process.stdout.write(`R7 lifecycle fallback removed own container ${id}\n`)
      }
    }
    if (preserved) rmSync(preserved, { recursive: true, force: true })
    const appDirectory = /R7 created lifecycle app directory (.+)/.exec(output)?.[1]
    if (appDirectory) rmSync(appDirectory, { recursive: true, force: true })
  }
}, 60_000)
