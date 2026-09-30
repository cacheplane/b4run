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
  ownSubprocessEnv,
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

  it("reads a .env line as dotenv does: a comment tail, either quote, CRLF", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-up-"))
    dir = root
    const path = join(root, ".env")
    const read = (text: string) => {
      writeFileSync(path, text)
      return openaiKeyFor({}, [path])?.key
    }
    expect(read(`OPENAI_API_KEY=${KEY} # the team's key\n`)).toBe(KEY)
    expect(read(`OPENAI_API_KEY=${KEY}\t#tabbed comment\n`)).toBe(KEY)
    expect(read(`OPENAI_API_KEY='${KEY}'\n`)).toBe(KEY)
    expect(read(`OPENAI_API_KEY="${KEY}"  # quoted, then a comment\n`)).toBe(KEY)
    expect(read(`A=1\r\nOPENAI_API_KEY=${KEY}\r\nB=2\r\n`)).toBe(KEY)
    expect(read(`OPENAI_API_KEY="${KEY}"\r\n`)).toBe(KEY)
    // A # with no space before it is part of the value, as dotenv reads it.
    expect(read(`OPENAI_API_KEY=${KEY}#x\n`)).toBe(`${KEY}#x`)
    expect(read("OPENAI_API_KEY= # nothing yet\n")).toBeUndefined()
  })

  it("refuses a .env value with whitespace or a stray quote, never echoing it", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-up-"))
    dir = root
    const path = join(root, ".env")
    for (const line of [
      `OPENAI_API_KEY=${KEY} trailing-word`,
      `OPENAI_API_KEY="${KEY}`,
      `OPENAI_API_KEY=${KEY}'`,
      `OPENAI_API_KEY="${KEY}'`,
      `OPENAI_API_KEY='${KEY}"`,
      `OPENAI_API_KEY="sk-not-a-real "key""`,
      `OPENAI_API_KEY="${KEY} inner space"`,
    ]) {
      writeFileSync(path, `${line}\n`)
      let thrown: unknown
      try {
        openaiKeyFor({}, [path])
      } catch (error) {
        thrown = error
      }
      expect(thrown, line).toBeInstanceOf(Error)
      const text = (thrown as Error).message
      expect(text).toContain(path)
      expect(text).toMatch(/whitespace or a stray quote/)
      expect(text).not.toContain(KEY)
      expect(text).not.toContain("sk-not-a-real")
    }
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

  it("keeps every provider key and cloud or GitHub credential out of the controller's", () => {
    const secretsLike = {
      ANTHROPIC_API_KEY: "a",
      ANTHROPIC_BASE_URL: "b",
      SOME_VENDOR_API_KEY: "c",
      OPENAI_ORG_ID: "d",
      OPENAI_BASE_URL: "e",
      AWS_SECRET_ACCESS_KEY: "f",
      AWS_PROFILE: "g",
      GH_TOKEN: "h",
      GITHUB_TOKEN: "i",
    }
    const apps = appProcesses(
      fresh(),
      { token: "t".repeat(64), openaiApiKey: KEY },
      { PATH: "/bin", FACTORY_MAX_ACTIVE_MS: "18000000", ...secretsLike },
    )
    const byName = Object.fromEntries(apps.map((a) => [a.name, a]))
    for (const name of Object.keys(secretsLike))
      expect(byName.controller?.env[name], name).toBeUndefined()
    expect(byName.controller?.env.PATH).toBe("/bin")
    expect(byName.controller?.env.FACTORY_MAX_ACTIVE_MS).toBe("18000000")
    // A deny-list, by design (D7 as landed): the workers still inherit the operator's other variables.
    expect(byName.builder?.env).toMatchObject(secretsLike)
    expect(byName.drafter?.env).toMatchObject(secretsLike)
  })
})

describe("up's own subprocesses", () => {
  it("never receive the key or the token", () => {
    const env = ownSubprocessEnv({
      PATH: "/bin",
      OPENAI_API_KEY: KEY,
      FACTORY_WORKER_TOKEN: "t".repeat(64),
    })
    expect(env).toEqual({ PATH: "/bin" })
  })

  it("git, ps and docker are each run with that environment", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/lib/operator/up.ts"), "utf8")
    const calls = [
      ...source.matchAll(/\b(?:execFileSync|execFile|run|spawnSync|spawn)\(\s*"(git|ps|docker)"/g),
    ]
    expect(calls.map((c) => c[1]).sort()).toEqual(["git", "ps"])
    for (const call of calls) {
      // The whole call, to its matching parenthesis.
      let depth = 0
      let end = call.index
      for (; end < source.length; end++) {
        if (source[end] === "(") depth++
        else if (source[end] === ")" && --depth === 0) break
      }
      expect(source.slice(call.index, end), call[0]).toMatch(
        /env: (?:ownSubprocessEnv\(\)|gitEnv\b)/,
      )
    }
  })
})

describe("preflight", () => {
  it("reports every problem at once, before anything starts", async () => {
    const config = fresh()
    const printed: string[] = []
    const { problems, secrets } = await preflight(
      config,
      deps({
        env: { B4_PERMISSIONS_MODE: "interactive", FACTORY_STATE_DIR: "/elsewhere" },
        portFree: async (port) => port !== 47100,
        docker: { info: async () => undefined, imagePresent: async () => false },
        out: (line) => printed.push(line),
      }),
    )
    expect(secrets).toBeUndefined()
    expect(printed.join("\n")).not.toMatch(/[a-f0-9]{64}/)
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

  it("passes a clean start and hands back the secrets, printing neither", async () => {
    const printed: string[] = []
    const { problems, secrets } = await preflight(
      fresh(),
      deps({ out: (line) => printed.push(line) }),
    )
    expect(problems).toEqual([])
    expect(secrets?.openaiApiKey).toBe(KEY)
    expect(secrets?.token).toMatch(/^[a-f0-9]{64}$/)
    const text = printed.join("\n")
    expect(text).toContain("OPENAI_API_KEY: from the environment")
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(secrets?.token ?? "\0")
    expect(text).not.toMatch(/[a-f0-9]{64}/)
  })

  it("never prints an operator's own token or a key read from a .env", async () => {
    const config = fresh()
    const dotenv = join(dir as string, ".env")
    writeFileSync(dotenv, `OPENAI_API_KEY=${KEY}\n`)
    const token = "operator-token-0123456789abcdef-0123"
    const printed: string[] = []
    const { secrets } = await preflight(
      config,
      deps({
        env: { FACTORY_WORKER_TOKEN: token },
        dotenvPaths: [dotenv],
        out: (line) => printed.push(line),
      }),
    )
    expect(secrets).toEqual({ token, openaiApiKey: KEY })
    const text = printed.join("\n")
    expect(text).toContain(`OPENAI_API_KEY: from ${dotenv}`)
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(token)
  })

  // root reads a mode-000 file anyway, so the refusal cannot be provoked there.
  it.skipIf(process.getuid?.() === 0)(
    "reports an unreadable .env as a problem, naming the file and never a value",
    async () => {
      const config = fresh()
      const dotenv = join(dir as string, ".env")
      writeFileSync(dotenv, `OPENAI_API_KEY=${KEY}\n`)
      chmodSync(dotenv, 0o000)
      const printed: string[] = []
      const { problems, secrets } = await preflight(
        config,
        deps({ env: {}, dotenvPaths: [dotenv], out: (line) => printed.push(line) }),
      )
      expect(secrets).toBeUndefined()
      expect(problems.join("\n")).toContain(`could not read ${dotenv}`)
      expect([...problems, ...printed].join("\n")).not.toContain(KEY)
    },
  )
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

  it("serializes takeovers: a live takeover mutex holds the stale lock where it is", () => {
    const config = fresh()
    const checkout = join(dir as string, ".up.lock")
    const lock = join(config.stateDir, "up.lock")
    const probe = acquireLock(config, settings, checkout)
    if (!("refused" in probe)) probe.release()
    writeFileSync(lock, stale(config, {}))
    const me = commandOf(process.pid) ?? ""
    const mutex = `${lock}.takeover`
    const held = JSON.stringify({ pid: process.pid, command: me.slice(0, 40), startedAt: "x" })
    writeFileSync(mutex, held)
    expect(acquireLock(config, settings, checkout)).toMatchObject({
      refused: expect.stringContaining("another up is taking it over"),
    })
    // Neither the stale lock nor the other up's mutex was touched.
    expect(readFileSync(lock, "utf8")).toBe(stale(config, {}))
    expect(readFileSync(mutex, "utf8")).toBe(held)
    expect(existsSync(checkout)).toBe(false)
  })

  it("takes over a takeover mutex a crashed up left behind, then the stale lock", () => {
    const config = fresh()
    const checkout = join(dir as string, ".up.lock")
    const lock = join(config.stateDir, "up.lock")
    const probe = acquireLock(config, settings, checkout)
    if (!("refused" in probe)) probe.release()
    writeFileSync(lock, stale(config, {}))
    writeFileSync(
      `${lock}.takeover`,
      JSON.stringify({ pid: 2 ** 22 + 3, command: "cli.ts up", startedAt: "x" }),
    )
    const taken = acquireLock(config, settings, checkout)
    if ("refused" in taken) throw new Error(taken.refused)
    expect(JSON.parse(readFileSync(lock, "utf8")).up.pid).toBe(process.pid)
    // No mutex, temp or aside file is left behind.
    expect(readdirSync(config.stateDir)).toEqual(["up.lock"])
    taken.release()
  })

  it("refuses a takeover mutex of the wrong shape, leaving it and the lock in place", () => {
    const config = fresh()
    const checkout = join(dir as string, ".up.lock")
    const lock = join(config.stateDir, "up.lock")
    const probe = acquireLock(config, settings, checkout)
    if (!("refused" in probe)) probe.release()
    writeFileSync(lock, stale(config, {}))
    writeFileSync(`${lock}.takeover`, "garbage")
    expect(acquireLock(config, settings, checkout)).toMatchObject({
      refused: expect.stringContaining(`${lock}.takeover is not a lock up wrote`),
    })
    expect(readFileSync(`${lock}.takeover`, "utf8")).toBe("garbage")
    expect(readFileSync(lock, "utf8")).toBe(stale(config, {}))
  })

  it("never overwrites a lock that appears while it creates its own", () => {
    const config = fresh()
    const checkout = join(dir as string, ".up.lock")
    const first = acquireLock(config, settings, checkout)
    if ("refused" in first) throw new Error(first.refused)
    // No temporary file is left beside a lock it created.
    expect(readdirSync(config.stateDir)).toEqual(["up.lock"])
    expect(readdirSync(dir as string).filter((n) => n.startsWith(".up.lock"))).toEqual([".up.lock"])
    first.release()
  })

  it("releases the state lock when the checkout lock fails for another reason", () => {
    const config = fresh()
    const checkout = join(dir as string, "no-such-dir", ".up.lock")
    expect(() => acquireLock(config, settings, checkout)).toThrow(/ENOENT/)
    expect(existsSync(join(config.stateDir, "up.lock"))).toBe(false)
    expect(readdirSync(config.stateDir)).toEqual([])
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
