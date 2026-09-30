import { type ChildProcess, execFile, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

const run = promisify(execFile)
const tsxBin = join(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs")
const cliEntry = join(import.meta.dirname, "../src/cli.ts")
const packageRoot = join(import.meta.dirname, "..")
/** Where a person types `pnpm factory up` (the example's own script, D18). */
const exampleRoot = join(packageRoot, "..")
const KEY = "sk-not-a-real-key-for-tests"
/** A known token, so the lane can prove it never leaves the three processes' environments. */
const TOKEN = "7".repeat(64)

/** Ports the kernel hands out now; `up`'s preflight re-checks them. */
async function freePorts(n: number): Promise<number[]> {
  const ports: number[] = []
  while (ports.length < n) {
    const port = await new Promise<number>((done) => {
      const server = createServer().listen(0, "127.0.0.1", () => {
        const address = server.address()
        server.close(() => done(typeof address === "object" && address ? address.port : 0))
      })
    })
    if (port >= 1024 && !ports.includes(port)) ports.push(port)
  }
  return ports
}

/** What a failure message may show of up's output: never the key or the token (Trap 5). */
const redacted = (text: string) =>
  text.replaceAll(KEY, "<the key>").replaceAll(TOKEN, "<the token>")

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let dir: string | undefined
let upProcess: ChildProcess | undefined
/** The children up recorded in its lock, so a failed run never leaves them serving. */
let children: number[] = []

afterEach(async () => {
  // Only on a failure mid-lane: stop up (it stops its children), then SIGKILL any child it
  // recorded that is still there, by pid (never by pattern), before the state directory goes.
  const upPid = upProcess?.pid
  if (
    upProcess &&
    upPid !== undefined &&
    upProcess.exitCode === null &&
    upProcess.signalCode === null
  ) {
    const exited = new Promise((done) => upProcess?.once("exit", done))
    process.kill(-upPid, "SIGINT")
    await Promise.race([exited, new Promise((done) => setTimeout(done, 60_000))])
    if (alive(upPid)) process.kill(-upPid, "SIGKILL")
  }
  for (const pid of children)
    if (alive(pid))
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        // Gone between the check and the kill.
      }
  upProcess = undefined
  children = []
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("factory up with the real controller, builder and drafter", () => {
  it("serves all three on loopback, reconciles, keeps the token and key to itself, and stops on one Ctrl-C", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-up-lane-"))
    const [controller, builder, drafter] = await freePorts(3)
    const config = join(dir, "factory.config.ts")
    const state = join(dir, "state")
    writeFileSync(
      config,
      `export default ${JSON.stringify({ state, controller: { port: controller }, builder: { port: builder }, drafter: { port: drafter } })}\n`,
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FACTORY_CONFIG: config,
      OPENAI_API_KEY: KEY,
      FACTORY_WORKER_TOKEN: TOKEN,
    }
    for (const name of [
      "FACTORY_STATE_DIR",
      "FACTORY_CONTROLLER_URL",
      "FACTORY_WORKER_URL",
      "FACTORY_DRAFTER_URL",
      "FACTORY_APPROVAL_TTL_MS",
      "FACTORY_MAX_ACTIVE_MS",
      "B4_PERMISSIONS_MODE",
    ])
      delete env[name]
    // Exactly as a person starts it: `pnpm factory up` from the example, so the outer pnpm, the
    // inner `pnpm --silent --filter` and the controller's `factory` script all stand between the
    // terminal and up, and relay the Ctrl-C below as they do in a terminal. Its own process
    // group, as a terminal's foreground group would be. The apps are detached from it, so the
    // SIGINT below reaches that chain and up only: up stops the apps itself.
    const started = spawn("pnpm", ["factory", "up"], {
      env,
      cwd: exampleRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    upProcess = started
    let output = ""
    started.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    started.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    const deadline = Date.now() + 180_000
    while (!output.includes("│ ready:")) {
      if (Date.now() > deadline || started.exitCode !== null)
        throw new Error(`up did not become ready:\n${redacted(output)}`)
      await new Promise((r) => setTimeout(r, 250))
    }
    // The lock records pids, commands, ports and the controller's settings; read it while held.
    const lockText = readFileSync(join(state, "up.lock"), "utf8")
    const lock = JSON.parse(lockText) as {
      controller: unknown
      ports: Record<string, number>
      children: Record<string, { pid: number; command: string }>
    }
    children = Object.values(lock.children).map((child) => child.pid)
    expect(lock.controller).toEqual({ approvalTtlMs: 900_000, maxActiveMs: 1_200_000 })
    expect(lock.ports).toEqual({ controller, builder, drafter })
    expect(Object.keys(lock.children).sort()).toEqual(["builder", "controller", "drafter"])
    for (const port of [controller, builder, drafter])
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200)
    // A worker answers only the token holder, and nobody printed the token or the key.
    for (const port of [builder, drafter])
      expect(
        (
          await fetch(`http://127.0.0.1:${port}/threads`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(403)
    // No failure message may echo a secret (Trap 5): assert on booleans.
    expect(output.includes(KEY)).toBe(false)
    expect(output.includes(TOKEN)).toBe(false)
    // The CLI reads the same config: the registry the reconcile opened is there to read.
    const { stdout } = await run(process.execPath, [tsxBin, cliEntry, "list"], {
      env,
      cwd: packageRoot,
    })
    expect(JSON.parse(stdout)).toEqual([])

    const stopStarted = Date.now()
    const exited = new Promise<number | null>((done) => started.once("exit", done))
    process.kill(-(started.pid as number), "SIGINT")
    const code = await exited
    const stopMs = Date.now() - stopStarted
    expect(code, redacted(output)).toBe(0)
    expect(stopMs).toBeLessThan(60_000)
    // Detached, each app got exactly one SIGTERM from up and closed cleanly (review C1): exit
    // code 0, never "by signal". A child killed mid-close is a finding, not a flake: read its log.
    for (const name of ["controller", "builder", "drafter"])
      expect(redacted(output)).toContain(`${name} exited with code 0`)
    expect(redacted(output)).not.toContain("by signal")
    expect(redacted(output)).toContain("stopped (clean)")
    // Nothing secret in what up printed, in any log (its own up.log included), or in the lock.
    expect(output.includes(KEY)).toBe(false)
    expect(output.includes(TOKEN)).toBe(false)
    const logs = readdirSync(join(state, "logs"))
    expect(logs.sort()).toEqual(["builder.log", "controller.log", "drafter.log", "up.log"])
    for (const log of logs) {
      const text = readFileSync(join(state, "logs", log), "utf8")
      expect(text.includes(KEY), log).toBe(false)
      expect(text.includes(TOKEN), log).toBe(false)
    }
    expect(lockText.includes(TOKEN)).toBe(false)
    expect(lockText.includes(KEY)).toBe(false)
    for (const port of [controller, builder, drafter])
      await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow()
    expect(existsSync(join(state, "up.lock"))).toBe(false)
    expect(existsSync(join(exampleRoot, ".up.lock"))).toBe(false)
    for (const pid of children) expect(alive(pid), `child ${pid} survived`).toBe(false)
    const { stdout: ps } = await run("ps", ["-Ao", "pid=,command="])
    const survivors = ps
      .split("\n")
      .filter((line) => [controller, builder, drafter].some((p) => line.includes(`--port ${p}`)))
    expect(survivors).toEqual([])
  }, 300_000)
})
