import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { notifyDevRunFinished, setDevRunListener } from "../src/lib/signals/dev-run-notifier.ts"
import { signalsDisabledReason } from "../src/lib/signals/env.ts"

const ROUTE_NAME = "zzqx"
const NOTICE_LINE = "B4.run collects anonymous usage signals"

const tempDirs: string[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("dev run notifier", () => {
  it("is a no-op without a listener and never throws from a listener", () => {
    setDevRunListener(null)
    expect(() => notifyDevRunFinished({ routeKind: "graph" })).not.toThrow()
    setDevRunListener(() => {
      throw new Error("boom")
    })
    expect(() => notifyDevRunFinished({ routeKind: "agent" })).not.toThrow()
    setDevRunListener(null)
  })

  it("forwards the route kind", () => {
    const seen: string[] = []
    setDevRunListener(({ routeKind }) => {
      seen.push(routeKind)
    })
    notifyDevRunFinished({ routeKind: "chain" })
    setDevRunListener(null)
    expect(seen).toEqual(["chain"])
  })
})

describe("b4 dev reports the first AG-UI run once", { timeout: 60_000 }, () => {
  it("sends cli:dev_first_run_completed once for two runs, prints the notice once, and reports the command at exit", async () => {
    const signals = await startSignalsServer()
    cleanups.push(signals.close)

    const appRoot = await makeTempDir("b4-cli-dev-signals-app-")
    await writeFixture(appRoot, {
      "b4.config.ts": "export default {};\n",
      "package.json": '{"type":"module"}\n',
      [`src/app/${ROUTE_NAME}/index.ts`]:
        "export const graph = async (_input, ctx) => ({ ok: true });\n",
    })
    const home = await makeTempDir("b4-cli-dev-signals-home-")

    const dev = startDev({ cwd: appRoot, home, signalsUrl: signals.url })
    cleanups.push(async () => {
      if (!dev.exited()) {
        dev.child.kill("SIGKILL")
        await dev.closed
      }
    })

    const baseUrl = await dev.waitForReadyUrl(30_000)
    const pathKey = encodeURIComponent(`/${ROUTE_NAME}#graph`)

    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${baseUrl}/agui/${pathKey}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({
          threadId: randomUUID(),
          runId: randomUUID(),
          messages: [{ id: "1", role: "user", content: "hello" }],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        }),
        signal: AbortSignal.timeout(15_000),
      })
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain("RUN_FINISHED")
    }

    // The child-to-parent IPC can land after the SSE response has ended.
    await waitUntil(
      () => signals.bodies.some((body) => firstEventName(body) === "cli:dev_first_run_completed"),
      10_000,
      () => `dev first-run signal; bodies so far: ${JSON.stringify(signals.bodies)}`,
    )

    // SIGTERM ourselves and wait for a full exit so the exit-time send completes.
    dev.child.kill("SIGTERM")
    const exited = await Promise.race([
      dev.closed.then(() => true),
      delay(20_000).then(() => false),
    ])
    expect(exited, `dev process did not exit\nSTDERR:\n${dev.stderr()}`).toBe(true)

    const firstRunBodies = signals.bodies.filter(
      (body) => firstEventName(body) === "cli:dev_first_run_completed",
    )
    expect(firstRunBodies).toHaveLength(1)
    const pkg = JSON.parse(
      await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { version: string }
    expect(firstEvent(firstRunBodies[0])?.properties).toEqual({
      cli_version: pkg.version,
      route_kind: "graph",
    })

    const completedBodies = signals.bodies.filter(
      (body) => firstEventName(body) === "cli:command_completed",
    )
    expect(completedBodies).toHaveLength(1)
    const completedProperties = firstEvent(completedBodies[0])?.properties
    expect(completedProperties?.command).toBe("dev")
    expect(completedProperties?.outcome).toBe("ok")

    const usageId = (await readFile(join(home, ".b4", "usage-id"), "utf8")).trim()
    expect(signals.bodies.length).toBeGreaterThan(0)
    for (const body of signals.bodies) {
      expect(body.usage_id).toBe(usageId)
    }

    expect(countOccurrences(dev.stderr(), NOTICE_LINE)).toBe(1)

    for (const raw of signals.rawBodies) {
      expect(raw).not.toContain(appRoot)
      expect(raw).not.toContain(ROUTE_NAME)
    }
  })
})

interface SignalBody {
  readonly usage_id?: unknown
  readonly events?: ReadonlyArray<{
    readonly event?: unknown
    readonly properties?: Record<string, unknown>
  }>
}

function firstEvent(body: SignalBody | undefined) {
  return body?.events?.[0]
}

function firstEventName(body: SignalBody): unknown {
  return firstEvent(body)?.event
}

async function startSignalsServer(): Promise<{
  readonly bodies: SignalBody[]
  readonly rawBodies: string[]
  readonly url: string
  readonly close: () => Promise<void>
}> {
  const bodies: SignalBody[] = []
  const rawBodies: string[] = []
  const server: Server = createServer((request, response) => {
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      raw += chunk
    })
    request.on("end", () => {
      rawBodies.push(raw)
      try {
        bodies.push(JSON.parse(raw) as SignalBody)
      } catch {
        bodies.push({})
      }
      response.writeHead(202).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    bodies,
    rawBodies,
    url: `http://127.0.0.1:${port}/v1/signals`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function startDev(options: {
  readonly cwd: string
  readonly home: string
  readonly signalsUrl: string
}) {
  const packageRoot = join(import.meta.dirname, "..")
  const entryPath = join(packageRoot, "src", "index.ts")
  const tsxLoaderPath = join(packageRoot, "node_modules", "tsx", "dist", "loader.mjs")

  const env: Record<string, string | undefined> = { ...process.env }
  // Drop every variable that makes reporting inert (the opt-out, the
  // do-not-report flag, and each CI marker), as decided by the source of truth.
  for (const name of Object.keys(env)) {
    if (signalsDisabledReason({ [name]: "1" }) !== null) {
      delete env[name]
    }
  }
  env.HOME = options.home
  env.B4_SIGNALS_URL = options.signalsUrl

  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", tsxLoaderPath, entryPath, "dev"],
    { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  )

  let stdout = ""
  let stderr = ""
  let exitCode: number | null | undefined
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const closed = new Promise<void>((resolve) => {
    child.once("close", (code) => {
      exitCode = code
      resolve()
    })
  })

  return {
    child,
    closed,
    exited: () => exitCode !== undefined,
    stderr: () => stderr,
    waitForReadyUrl: async (timeoutMs: number): Promise<string> => {
      let url: string | undefined
      await waitUntil(
        () => {
          url = /B4\.run dev ready at (http:\/\/\S+)/.exec(stdout)?.[1]
          return url !== undefined || exitCode !== undefined
        },
        timeoutMs,
        () => `b4 dev readiness\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
      )
      if (url === undefined) {
        throw new Error(`b4 dev exited (code ${exitCode})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
      }
      return url
    },
  }
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function writeFixture(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(root, relativePath)
      await mkdir(join(filePath, ".."), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  describeWait: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${describeWait()}`)
    }
    await delay(25)
  }
}

function countOccurrences(input: string, needle: string): number {
  return input.split(needle).length - 1
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
