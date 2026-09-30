import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseFactoryConfig } from "../src/lib/operator/factory-config.ts"
import {
  acquireLock,
  appProcesses,
  commandOf,
  dotenvCandidates,
  openaiKeyFor,
  preflight,
  type UpDeps,
  workerTokenFor,
} from "../src/lib/operator/up.ts"

const KEY = "sk-not-a-real-key-for-tests"
let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "factory-up-"))
  dir = root
  return parseFactoryConfig(
    {
      state: join(root, "state"),
      controller: { port: 47300 },
      builder: { port: 47100 },
      drafter: { port: 47200 },
    },
    join(root, "factory.config.ts"),
  )
}
const deps = (patch: Partial<UpDeps> = {}): UpDeps => ({
  env: { OPENAI_API_KEY: KEY },
  dotenvPaths: [join(dir ?? tmpdir(), ".env")],
  checkoutLock: join(dir ?? tmpdir(), ".up.lock"),
  docker: { info: async () => undefined, imagePresent: async () => true },
  drafterImage: `node:24-slim@sha256:${"0".repeat(64)}`,
  portFree: async () => true,
  launch: (name, _cwd, port) => ({
    command: process.execPath,
    args: ["-e", "", name, String(port)],
  }),
  fetch,
  out: () => undefined,
  readyTimeoutMs: 5_000,
  stopTimeoutMs: 2_000,
  ...patch,
})

describe("the worker token", () => {
  it("is generated when unset: 64 hex, different every start", () => {
    const a = workerTokenFor({})
    expect(a).toMatchObject({ source: "generated" })
    expect(a.token).toMatch(/^[a-f0-9]{64}$/)
    expect(workerTokenFor({}).token).not.toBe(a.token)
  })
  it("is the operator's when set, checked as the workers check it", () => {
    expect(workerTokenFor({ FACTORY_WORKER_TOKEN: "t".repeat(32) })).toEqual({
      token: "t".repeat(32),
      source: "environment",
    })
    expect(() => workerTokenFor({ FACTORY_WORKER_TOKEN: "short" })).toThrow(/at least 32/)
    expect(() => workerTokenFor({ FACTORY_WORKER_TOKEN: `${"t".repeat(32)} x` })).toThrow(
      /whitespace/,
    )
  })
})

describe("the model key", () => {
  it("comes from the environment, else only its own line of the first .env that exists", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-up-"))
    dir = root
    const linked = join(root, "linked.env") // a linked worktree's: absent
    const main = join(root, "main.env") // the main worktree's
    const paths = [linked, main]
    expect(openaiKeyFor({ OPENAI_API_KEY: KEY }, paths)).toEqual({
      key: KEY,
      source: "the environment",
    })
    expect(openaiKeyFor({}, paths)).toBeUndefined()
    writeFileSync(main, `OTHER_SECRET=nope\nexport OPENAI_API_KEY="${KEY}"\n`)
    expect(openaiKeyFor({}, paths)).toEqual({ key: KEY, source: main })
    writeFileSync(main, "OPENAI_API_KEY=\n")
    expect(openaiKeyFor({}, paths)).toBeUndefined()
  })

  it("looks in this checkout, then the main worktree, never FACTORY_REPO_ROOT", () => {
    const candidates = dotenvCandidates()
    expect(candidates[0]).toMatch(/\.env$/)
    expect(candidates.every((c) => !c.includes(process.env.FACTORY_REPO_ROOT ?? "\0"))).toBe(true)
  })
})

describe("each app's environment", () => {
  it("shares the token, gives the key to the workers only, and the URLs and state to the controller", () => {
    const config = fresh()
    const apps = appProcesses(
      config,
      { token: "t".repeat(64), openaiApiKey: KEY },
      {
        OPENAI_API_KEY: KEY,
        HOST: "0.0.0.0",
        PORT: "1",
        PATH: "/bin",
        FACTORY_MAX_ACTIVE_MS: "18000000",
      },
    )
    const byName = Object.fromEntries(apps.map((a) => [a.name, a]))
    for (const app of apps) {
      expect(app.env.FACTORY_WORKER_TOKEN).toBe("t".repeat(64))
      expect(app.env.HOST).toBeUndefined()
      expect(app.env.PORT).toBeUndefined()
      expect(app.env.PATH).toBe("/bin")
      expect(app.args).toEqual(
        expect.arrayContaining([
          "start",
          "--host",
          "127.0.0.1",
          "--port",
          String(config.ports[app.name]),
        ]),
      )
    }
    expect(byName.controller?.env.OPENAI_API_KEY).toBeUndefined()
    expect(byName.builder?.env.OPENAI_API_KEY).toBe(KEY)
    expect(byName.drafter?.env.OPENAI_API_KEY).toBe(KEY)
    expect(byName.controller?.env).toMatchObject({
      FACTORY_WORKER_URL: "http://127.0.0.1:47100",
      FACTORY_DRAFTER_URL: "http://127.0.0.1:47200",
      FACTORY_STATE_DIR: config.stateDir,
      FACTORY_MAX_ACTIVE_MS: "18000000",
    })
    expect(byName.builder?.cwd).toMatch(/software-factory\/server$/)
  })
})

describe("preflight", () => {
  it("reports every problem at once, before anything starts", async () => {
    const config = fresh()
    const { problems, secrets } = await preflight(
      config,
      deps({
        env: { B4_PERMISSIONS_MODE: "interactive", FACTORY_STATE_DIR: "/elsewhere" },
        portFree: async (port) => port !== 47100,
        docker: { info: async () => undefined, imagePresent: async () => false },
      }),
    )
    expect(secrets).toBeUndefined()
    const text = problems.join("\n")
    expect(text).toContain("B4_PERMISSIONS_MODE is set")
    expect(text).toContain("FACTORY_STATE_DIR is /elsewhere")
    expect(text).toContain("OPENAI_API_KEY is not set")
    expect(text).toContain("builder.port 47100 is in use")
    expect(text).toContain(`docker pull node:24-slim@sha256:${"0".repeat(64)}`)
    expect(text).not.toContain(KEY)
  })

  it("refuses when Docker does not answer, without asking for the image", async () => {
    const config = fresh()
    let asked = false
    const { problems } = await preflight(
      config,
      deps({
        docker: {
          info: async () => {
            throw new Error("Cannot connect to the Docker daemon")
          },
          imagePresent: async () => {
            asked = true
            return true
          },
        },
      }),
    )
    expect(problems.join("\n")).toContain("Docker is not available (Cannot connect")
    expect(asked).toBe(false)
  })

  it("passes a clean start and hands back the secrets", async () => {
    const { problems, secrets } = await preflight(fresh(), deps())
    expect(problems).toEqual([])
    expect(secrets?.openaiApiKey).toBe(KEY)
    expect(secrets?.token).toMatch(/^[a-f0-9]{64}$/)
  })

  it("reports an unreadable .env as a problem, naming the file and never a value", async () => {
    const config = fresh()
    const dotenv = join(dir as string, ".env")
    writeFileSync(dotenv, `OPENAI_API_KEY=${KEY}\n`)
    chmodSync(dotenv, 0o000)
    const { problems, secrets } = await preflight(config, deps({ env: {}, dotenvPaths: [dotenv] }))
    expect(secrets).toBeUndefined()
    expect(problems.join("\n")).toContain(`could not read ${dotenv}`)
    expect(problems.join("\n")).not.toContain(KEY)
  })
})

describe("the locks", () => {
  const settings = { approvalTtlMs: 86_400_000, maxActiveMs: 18_000_000 }
  const stale = (config: ReturnType<typeof fresh>, children: Record<string, unknown>) =>
    JSON.stringify({
      up: { pid: 2 ** 22 + 1, command: "cli.ts up", startedAt: "x" },
      ports: config.ports,
      controller: settings,
      children,
    })

  it("admits one up per state directory and per checkout, and records the controller's settings", () => {
    const config = fresh()
    const checkout = join(dir as string, ".up.lock")
    const first = acquireLock(config, settings, checkout)
    if ("refused" in first) throw new Error(first.refused)
    // A second up on the same state, or in the same checkout with another state, refuses.
    expect(acquireLock(config, settings, join(dir as string, "other.lock"))).toMatchObject({
      refused: expect.stringContaining("already running"),
    })
    const elsewhere = parseFactoryConfig(
      {
        state: join(dir as string, "state2"),
        controller: { port: 47301 },
        builder: { port: 47101 },
        drafter: { port: 47201 },
      },
      join(dir as string, "factory.config.ts"),
    )
    expect(acquireLock(elsewhere, settings, checkout)).toMatchObject({
      refused: expect.stringContaining("already running"),
    })
    // The refused second attempt released the state lock it had taken.
    expect(existsSync(join(elsewhere.stateDir, "up.lock"))).toBe(false)
    const lock = join(config.stateDir, "up.lock")
    const recorded = JSON.parse(readFileSync(lock, "utf8"))
    expect(recorded.controller).toEqual(settings)
    expect(recorded.up.pid).toBe(process.pid)
    expect(readFileSync(lock, "utf8")).not.toMatch(/[a-f0-9]{64}/)
    first.release()
    expect(existsSync(lock)).toBe(false)
    expect(existsSync(checkout)).toBe(false)
  })

  it("takes over a stale lock by rename, and treats a reused pid as not holding it", () => {
    const config = fresh()
    const checkout = join(dir as string, ".up.lock")
    const lock = join(config.stateDir, "up.lock")
    const first = acquireLock(config, settings, checkout)
    if ("refused" in first) throw new Error(first.refused)
    first.release()
    // Dead pid.
    writeFileSync(lock, stale(config, {}))
    const second = acquireLock(config, settings, checkout)
    if ("refused" in second) throw new Error(second.refused)
    second.release()
    // A live pid (this process) whose command line is not the recorded one: reused, not held.
    writeFileSync(
      lock,
      JSON.stringify({
        ...JSON.parse(stale(config, {})),
        up: { pid: process.pid, command: "no such command line", startedAt: "x" },
      }),
    )
    const third = acquireLock(config, settings, checkout)
    if ("refused" in third) throw new Error(third.refused)
    third.release()
    expect(readdirSync(config.stateDir).filter((n) => n.includes("stale"))).toEqual([])
  })

  it("refuses a stale lock whose children still run as recorded, naming them and never killing them", () => {
    const config = fresh()
    const checkout = join(dir as string, ".up.lock")
    const lock = join(config.stateDir, "up.lock")
    const probe = acquireLock(config, settings, checkout) // creates the directory
    if (!("refused" in probe)) probe.release()
    const me = commandOf(process.pid) ?? ""
    writeFileSync(lock, stale(config, { builder: { pid: process.pid, command: me.slice(0, 40) } }))
    const refused = acquireLock(config, settings, checkout)
    expect(refused).toMatchObject({
      refused: expect.stringContaining(`builder pid ${process.pid}`),
    })
    expect(refused).toMatchObject({
      refused: expect.stringContaining(`ps -ww -p ${process.pid} -o command=`),
    })
    expect(process.kill(process.pid, 0)).toBe(true)
  })

  it("refuses a lock file of the wrong shape instead of throwing, and leaves it in place", () => {
    const config = fresh()
    const checkout = join(dir as string, ".up.lock")
    const lock = join(config.stateDir, "up.lock")
    const probe = acquireLock(config, settings, checkout)
    if (!("refused" in probe)) probe.release()
    for (const text of ["", "{}", '{"up":{"pid":"x"}}', "[]", "null", "not json"]) {
      writeFileSync(lock, text)
      expect(acquireLock(config, settings, checkout)).toMatchObject({
        refused: expect.stringContaining("is not a lock up wrote"),
      })
      expect(readFileSync(lock, "utf8")).toBe(text)
    }
    expect(existsSync(checkout)).toBe(false)
  })

  it("rewrites the lock whole when it records the children", () => {
    const config = fresh()
    const checkout = join(dir as string, ".up.lock")
    const lock = acquireLock(config, settings, checkout)
    if ("refused" in lock) throw new Error(lock.refused)
    lock.recordChildren({ builder: { pid: 12345, command: "b4.js start --port 47100" } })
    for (const path of [join(config.stateDir, "up.lock"), checkout]) {
      expect(JSON.parse(readFileSync(path, "utf8")).children).toEqual({
        builder: { pid: 12345, command: "b4.js start --port 47100" },
      })
    }
    expect(readdirSync(config.stateDir)).toEqual(["up.lock"])
    lock.release()
  })
})
