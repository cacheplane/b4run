import { generateKeyPairSync } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { type AddressInfo, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  deliveryKeyProblems,
  EXAMPLE_ROOT,
  parseFactoryConfig,
  type ResolvedFactoryConfig,
} from "../src/lib/operator/factory-config.ts"
import {
  appProcesses,
  commandOf,
  ownSubprocessEnv,
  preflight,
  realUpDeps,
  redactor,
  runKeyFile,
  type UpDeps,
  up,
  writeRunKey,
} from "../src/lib/operator/up.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString()
const CONFIG_PATH = join(EXAMPLE_ROOT, "factory.config.ts")
const base = {
  state: ".factory",
  controller: { port: 4300 },
  builder: { port: 4100 },
  drafter: { port: 4200 },
}
const draftPr = (app: Record<string, unknown>) => ({
  ...base,
  delivery: { draftPr: { repository: "cacheplane/b4run", baseBranch: "main", app } },
})

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("factory.config.ts delivery", () => {
  it("resolves the key's file or names its variable, and refuses both, neither or a near-miss", () => {
    const file = parseFactoryConfig(draftPr({ id: 1, privateKeyFile: "~/k.pem" }), CONFIG_PATH)
    expect(file.delivery).toMatchObject({
      appId: 1,
      key: { file: expect.stringMatching(/\/k\.pem$/) },
    })
    expect(file.delivery?.key).not.toEqual({ file: "~/k.pem" })
    const env = parseFactoryConfig(
      draftPr({ id: 1, privateKeyEnv: "B4_FACTORY_APP_KEY" }),
      CONFIG_PATH,
    )
    expect(env.delivery?.key).toEqual({ env: "B4_FACTORY_APP_KEY" })
    expect(() => parseFactoryConfig(draftPr({ id: 1 }), CONFIG_PATH)).toThrow(/exactly one/)
    expect(() =>
      parseFactoryConfig(draftPr({ id: 1, privateKeyFile: "a", privateKeyEnv: "B" }), CONFIG_PATH),
    ).toThrow(/exactly one/)
    expect(() => parseFactoryConfig(draftPr({ id: 1, privateKey: PEM }), CONFIG_PATH)).toThrow(
      /privateKey: the config names no secret/,
    )
    const withToken = { ...draftPr({ id: 1, privateKeyFile: "k" }) }
    ;(withToken.delivery.draftPr as Record<string, unknown>).branchPrefix = "bot/"
    expect(() => parseFactoryConfig(withToken, CONFIG_PATH)).toThrow(
      /branchPrefix: fixed at factory\//,
    )
  })

  it("refuses a key file that is shared, missing, or inside an app root", () => {
    dir = mkdtempSync(join(tmpdir(), "up-key-"))
    const key = join(dir, "app.pem")
    writeFileSync(key, PEM, { mode: 0o600 })
    const at = (path: string) =>
      parseFactoryConfig(draftPr({ id: 1, privateKeyFile: path }), CONFIG_PATH)
    expect(deliveryKeyProblems(at(key))).toEqual([])
    chmodSync(key, 0o640)
    expect(deliveryKeyProblems(at(key)).join()).toMatch(/chmod 600/)
    expect(deliveryKeyProblems(at(join(dir, "nope.pem"))).join()).toMatch(/does not exist/)
    expect(
      deliveryKeyProblems(at(join(EXAMPLE_ROOT, "controller", "package.json"))).join(),
    ).toMatch(/inside .*controller/)
  })
})

describe("up and the GitHub App's key", () => {
  const withEnvKey = (): ResolvedFactoryConfig =>
    parseFactoryConfig(draftPr({ id: 7, privateKeyEnv: "B4_FACTORY_APP_KEY" }), CONFIG_PATH)

  it("gives the controller the four delivery variables, the key as a path, and no worker any of them", () => {
    const config = withEnvKey()
    const env = {
      PATH: "/bin",
      B4_FACTORY_APP_KEY: PEM,
      FACTORY_GITHUB_APP_ID: "999",
      FACTORY_DELIVERY_REPOSITORY: "x/y",
    }
    const apps = appProcesses(config, { token: "t".repeat(64), openaiApiKey: "sk-test" }, env)
    const byName = Object.fromEntries(apps.map((a) => [a.name, a.env]))
    expect(byName.controller).toMatchObject({
      FACTORY_GITHUB_APP_ID: "7",
      FACTORY_GITHUB_APP_PRIVATE_KEY_FILE: runKeyFile(config.stateDir),
      FACTORY_DELIVERY_REPOSITORY: "cacheplane/b4run",
      FACTORY_DELIVERY_BASE_BRANCH: "main",
    })
    // Booleans, never the environment: a failing assertion must not print a key.
    for (const name of ["controller", "builder", "drafter"])
      expect(JSON.stringify(byName[name]).includes("PRIVATE KEY"), name).toBe(false)
    for (const name of ["builder", "drafter"])
      expect(
        Object.keys(byName[name] ?? {}).filter((k) => /GITHUB_APP|DELIVERY|APP_KEY/.test(k)),
      ).toEqual([])
  })

  it("never hands up's own git, ps and docker the key's variable or a delivery variable", async () => {
    const config = withEnvKey()
    const problems: string[] = []
    await preflight(config, {
      env: {
        B4_FACTORY_APP_KEY: PEM,
        FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
        OPENAI_API_KEY: "sk-x",
      },
      dotenvPaths: [],
      checkoutLock: "/nonexistent",
      docker: { info: async () => {}, imagePresent: async () => true },
      drafterImage: "x",
      portFree: async () => true,
      launch: () => ({ command: "true", args: [] }),
      fetch,
      out: (line) => problems.push(line),
      readyTimeoutMs: 1,
      stopTimeoutMs: 1,
    })
    expect(problems.join("\n")).toContain("GitHub App 7: key from $B4_FACTORY_APP_KEY")
    expect(problems.join("\n").includes("MII")).toBe(false)
    const own = ownSubprocessEnv({
      B4_FACTORY_APP_KEY: PEM,
      FACTORY_GITHUB_APP_PRIVATE_KEY_FILE: "/k",
      PATH: "/bin",
    })
    expect(own).toEqual({ PATH: "/bin" })
  })

  it("redacts every line of the key's body from up's output", () => {
    const redact = redactor({
      token: "t".repeat(64),
      openaiApiKey: "sk-test-key",
      githubAppKey: PEM,
    })
    const body = PEM.split("\n")[3] as string
    const redacted = redact(`leaked ${body} here`)
    expect(redacted.includes(body)).toBe(false)
    expect(redacted === "leaked [GITHUB_APP_KEY] here").toBe(true)
  })
})

describe("up's preflight and the GitHub App's key", () => {
  const problemsFor = async (env: Record<string, string>) => {
    const lines: string[] = []
    const { problems } = await preflight(
      parseFactoryConfig(draftPr({ id: 7, privateKeyEnv: "B4_FACTORY_APP_KEY" }), CONFIG_PATH),
      {
        env: { FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN, OPENAI_API_KEY: "sk-x", ...env },
        dotenvPaths: [],
        checkoutLock: "/nonexistent",
        docker: { info: async () => {}, imagePresent: async () => true },
        drafterImage: "x",
        portFree: async () => true,
        launch: () => ({ command: "true", args: [] }),
        fetch,
        out: (line) => lines.push(line),
        readyTimeoutMs: 1,
        stopTimeoutMs: 1,
      },
    )
    return { problems: problems.join("\n"), printed: lines.join("\n") }
  }

  it("refuses a key the controller could not sign with, at start, never quoting it", async () => {
    // GitHub signs RS256: an EC key parses but the controller would refuse it when it opens.
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString()
    const notRsa = await problemsFor({ B4_FACTORY_APP_KEY: ec })
    expect(notRsa.problems.includes("not an RSA private key")).toBe(true)
    expect(notRsa.problems.includes("PRIVATE KEY-----") || notRsa.printed.includes("MI")).toBe(
      false,
    )
    const garbage = await problemsFor({ B4_FACTORY_APP_KEY: "not a key at all" })
    expect(garbage.problems.includes("not a PEM private key")).toBe(true)
    expect(garbage.problems.includes("not a key at all")).toBe(false)
    const unset = await problemsFor({})
    expect(unset.problems.includes("names B4_FACTORY_APP_KEY, which is not set")).toBe(true)
  })
})

/** Three ports free on loopback right now, chosen by the kernel. */
async function freePorts(): Promise<{ controller: number; builder: number; drafter: number }> {
  const servers = [createServer(), createServer(), createServer()]
  const ports = await Promise.all(
    servers.map(
      (server) =>
        new Promise<number>((done, fail) => {
          server.once("error", fail)
          server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port))
        }),
    ),
  )
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))))
  const [controller, builder, drafter] = ports as [number, number, number]
  return { controller, builder, drafter }
}

const FAKE_APP = join(import.meta.dirname, "fixtures/fake-factory-app.mjs")
interface Reported {
  readonly name: string
  readonly pid?: number
  readonly reconciled?: boolean
  readonly deliveryVariables?: readonly string[]
  readonly pemInEnvironment?: boolean
  readonly keyFile?: {
    readonly path: string
    readonly mode?: number
    readonly directoryMode?: number
    readonly isPem?: boolean
    readonly missing?: boolean
  } | null
}
const reportsIn = (path: string): Reported[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Reported)
    : []

describe("up runs the controller with the app's key, and no worker sees it", () => {
  /** `up` over the fake apps, with `delivery` configured as `app` says. */
  async function deliveringUp(app: Record<string, unknown>, extraEnv: Record<string, string>) {
    const root = dir as string
    const ports = await freePorts()
    const config = parseFactoryConfig(
      {
        state: join(root, "state"),
        controller: { port: ports.controller },
        builder: { port: ports.builder },
        drafter: { port: ports.drafter },
        delivery: { draftPr: { repository: "cacheplane/b4run", baseBranch: "main", app } },
      },
      join(root, "factory.config.ts"),
    )
    const report = join(root, "report.jsonl")
    const lines: string[] = []
    const stop = new AbortController()
    const deps: UpDeps = {
      env: {
        PATH: process.env.PATH ?? "",
        OPENAI_API_KEY: "sk-not-a-real-key-for-tests",
        FAKE_APP_REPORT: report,
        ...extraEnv,
      },
      dotenvPaths: [],
      checkoutLock: join(root, ".up.lock"),
      docker: { info: async () => undefined, imagePresent: async () => true },
      drafterImage: `node:24-slim@sha256:${"0".repeat(64)}`,
      portFree: async () => true,
      launch: (name, _cwd, port) => ({
        command: "/usr/bin/env",
        args: [
          `FAKE_APP_NAME=${name}`,
          process.execPath,
          FAKE_APP,
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
        ],
      }),
      fetch,
      out: (line) => lines.push(line),
      readyTimeoutMs: 10_000,
      stopTimeoutMs: 2_000,
    }
    const done = up(config, deps, stop.signal, new AbortController().signal)
    const deadline = Date.now() + 15_000
    while (
      !lines.some((line) => line.includes("│ ready:")) &&
      !lines.some((l) => /refused/.test(l))
    ) {
      if (Date.now() > deadline) break
      await new Promise((r) => setTimeout(r, 25))
    }
    const started = Object.fromEntries(
      reportsIn(report)
        .filter((r) => r.pid !== undefined)
        .map((r) => [r.name, r]),
    )
    return { config, lines, started, stop, done }
  }

  it("writes the variable's key to a private run file for the controller alone, replacing a leftover, and removes it on stop", async () => {
    dir = mkdtempSync(join(tmpdir(), "up-delivery-"))
    // A crashed up's leftover, shared and stale: it must not survive the next start.
    const leftover = runKeyFile(join(dir, "state"))
    mkdirSync(join(dir, "state", "run"), { recursive: true })
    writeFileSync(leftover, "stale", { mode: 0o644 })
    const { config, lines, started, stop, done } = await deliveringUp(
      { id: 7, privateKeyEnv: "B4_FACTORY_APP_KEY" },
      { B4_FACTORY_APP_KEY: PEM, FACTORY_DELIVERY_REPOSITORY: "elsewhere/repo" },
    )
    expect(lines.some((line) => line.includes("│ ready:"))).toBe(true)
    const controller = started.controller
    expect(controller?.deliveryVariables).toEqual([
      "FACTORY_DELIVERY_BASE_BRANCH",
      "FACTORY_DELIVERY_REPOSITORY",
      "FACTORY_GITHUB_APP_ID",
      "FACTORY_GITHUB_APP_PRIVATE_KEY_FILE",
    ])
    expect(controller?.pemInEnvironment).toBe(false)
    expect(controller?.keyFile).toEqual({
      path: runKeyFile(config.stateDir),
      mode: 0o600,
      directoryMode: 0o700,
      isPem: true,
    })
    for (const name of ["builder", "drafter"]) {
      expect(started[name]?.deliveryVariables, name).toEqual([])
      expect(started[name]?.pemInEnvironment, name).toBe(false)
      expect(started[name]?.keyFile, name).toBe(null)
    }
    stop.abort()
    expect(await done).toBe(0)
    expect(existsSync(runKeyFile(config.stateDir))).toBe(false)
    expect(lines.join("\n").includes("PRIVATE KEY")).toBe(false)
  }, 30_000)

  it("gives the controller the operator's key file by path, and leaves no run copy", async () => {
    dir = mkdtempSync(join(tmpdir(), "up-delivery-"))
    const keyDir = mkdtempSync(join(tmpdir(), "up-delivery-key-"))
    try {
      const key = join(keyDir, "app.pem")
      writeFileSync(key, PEM, { mode: 0o600 })
      const leftover = runKeyFile(join(dir, "state"))
      mkdirSync(join(dir, "state", "run"), { recursive: true })
      writeFileSync(leftover, "stale", { mode: 0o600 })
      const { lines, started, stop, done } = await deliveringUp({ id: 7, privateKeyFile: key }, {})
      expect(lines.some((line) => line.includes("│ ready:"))).toBe(true)
      expect(existsSync(leftover)).toBe(false)
      expect(started.controller?.keyFile).toEqual({
        path: key,
        mode: 0o600,
        directoryMode: 0o700,
        isPem: true,
      })
      for (const name of ["builder", "drafter"])
        expect(started[name]?.deliveryVariables, name).toEqual([])
      stop.abort()
      expect(await done).toBe(0)
      // The operator's own file is theirs: up never removes it.
      expect(existsSync(key)).toBe(true)
    } finally {
      rmSync(keyDir, { recursive: true, force: true })
    }
  }, 30_000)

  it("M1: refuses a run directory that is a link, writing the key nowhere, and releases its locks", async () => {
    dir = mkdtempSync(join(tmpdir(), "up-delivery-"))
    const elsewhere = join(dir, "elsewhere")
    mkdirSync(elsewhere, { mode: 0o755 })
    mkdirSync(join(dir, "state"))
    symlinkSync(elsewhere, join(dir, "state", "run"))
    // A file the link would otherwise have had up remove as its "leftover".
    writeFileSync(join(elsewhere, "github-app.pem"), "someone else's", { mode: 0o600 })
    const { lines, stop, done } = await deliveringUp(
      { id: 7, privateKeyEnv: "B4_FACTORY_APP_KEY" },
      { B4_FACTORY_APP_KEY: PEM },
    )
    stop.abort()
    expect(await done).toBe(1)
    expect(lines.some((l) => l.includes("refused:") && l.includes("run"))).toBe(true)
    expect(readFileSync(join(elsewhere, "github-app.pem"), "utf8") === "someone else's").toBe(true)
    expect(existsSync(join(dir, "state", "up.lock"))).toBe(false)
    expect(existsSync(join(dir, ".up.lock"))).toBe(false)
  }, 30_000)

  it("M4: refuses a leftover that is not a file, and releases its locks", async () => {
    dir = mkdtempSync(join(tmpdir(), "up-delivery-"))
    mkdirSync(runKeyFile(join(dir, "state")), { recursive: true })
    const { lines, stop, done } = await deliveringUp(
      { id: 7, privateKeyEnv: "B4_FACTORY_APP_KEY" },
      { B4_FACTORY_APP_KEY: PEM },
    )
    stop.abort()
    expect(await done).toBe(1)
    expect(
      lines.some((l) => l.includes("refused:") && l.includes("github-app.pem is a directory")),
    ).toBe(true)
    expect(existsSync(join(dir, "state", "up.lock"))).toBe(false)
    expect(existsSync(join(dir, ".up.lock"))).toBe(false)
  }, 30_000)
})

describe("review of Tasks 19-20: up's own processes, pasted keys, the run copy", () => {
  /** A variable no other test registers, holding a generated key. */
  const KEY_VAR = "B4_REVIEW_I1_APP_KEY"
  const envKeyConfig = () =>
    parseFactoryConfig(draftPr({ id: 7, privateKeyEnv: KEY_VAR }), CONFIG_PATH)

  it("I1: the real git, docker and ps up runs never see the key's variable, before any preflight", async () => {
    // A key, then a value no shape test would recognise: the config's name alone must drop it
    // from git and docker. ps judges locks with no config in reach, so its guard is the value's
    // shape: a value that is not a PEM key is not a key the controller could use either.
    await ownProcessesSee(PEM, ["git", "docker", "ps"])
    await ownProcessesSee("a-secret-of-no-recognisable-shape", ["git", "docker"])
  })

  async function ownProcessesSee(value: string, guarded: readonly string[]): Promise<void> {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = mkdtempSync(join(tmpdir(), "up-own-env-"))
    const bin = join(dir, "bin")
    mkdirSync(bin)
    const seen = join(dir, "seen.log")
    // Each fake records only whether the variable was present: never its value.
    for (const tool of ["git", "docker", "ps"])
      writeFileSync(
        join(bin, tool),
        `#!/bin/sh\nif [ -n "\${${KEY_VAR}+x}" ]; then echo "${tool} present" >> "${seen}"; else echo "${tool} absent" >> "${seen}"; fi\ncase "$1" in -C) echo /tmp/nowhere;; esac\nexit 0\n`,
        { mode: 0o755 },
      )
    const saved = { PATH: process.env.PATH, key: process.env[KEY_VAR] }
    process.env.PATH = `${bin}:${saved.PATH ?? ""}`
    process.env[KEY_VAR] = value
    try {
      const deps = realUpDeps(() => {}, envKeyConfig())
      await deps.docker.info()
      await deps.docker.imagePresent("img")
      commandOf(process.pid)
    } finally {
      process.env.PATH = saved.PATH
      if (saved.key === undefined) delete process.env[KEY_VAR]
      else process.env[KEY_VAR] = saved.key
    }
    const lines = readFileSync(seen, "utf8").trim().split("\n")
    expect(lines.filter((l) => l.startsWith("git ")).length).toBe(2)
    expect(lines.filter((l) => l.startsWith("docker ")).length).toBe(2)
    expect(lines.filter((l) => l.startsWith("ps ")).length).toBe(1)
    expect(
      lines.filter((l) => l.endsWith(" present") && guarded.includes(l.split(" ")[0] as string)),
    ).toEqual([])
  }

  it("M1: writes the key's copy exclusively, never through a link left at its name", () => {
    dir = mkdtempSync(join(tmpdir(), "up-run-key-"))
    const state = join(dir, "state")
    mkdirSync(join(state, "run"), { recursive: true, mode: 0o700 })
    const elsewhere = join(dir, "elsewhere.pem")
    writeFileSync(elsewhere, "someone else's", { mode: 0o644 })
    symlinkSync(elsewhere, runKeyFile(state))
    const refusal = writeRunKey(state, PEM)
    expect(refusal?.includes("EEXIST")).toBe(true)
    expect(readFileSync(elsewhere, "utf8") === "someone else's").toBe(true)
    rmSync(runKeyFile(state))
    expect(writeRunKey(state, PEM)).toBeUndefined()
    expect(readFileSync(runKeyFile(state), "utf8").includes("PRIVATE KEY-----")).toBe(true)
  })

  it("I2: a key pasted where its file's path belongs is refused by name, never quoted", () => {
    const body = PEM.split("\n")[2] as string
    const oneLine = PEM.split("\n")
      .filter((l) => l !== "" && !l.startsWith("-----"))
      .join("")
    for (const pasted of [PEM, oneLine, `/keys/${"a".repeat(2000)}.pem`]) {
      let refusal = ""
      try {
        parseFactoryConfig(draftPr({ id: 1, privateKeyFile: pasted }), CONFIG_PATH)
      } catch (error) {
        refusal = String(error)
      }
      expect(refusal.includes("delivery.draftPr.app.privateKeyFile")).toBe(true)
      expect(refusal.includes(body)).toBe(false)
      expect(refusal.includes(oneLine.slice(100, 140))).toBe(false)
    }
  })

  it("M2: no worker inherits a FACTORY_GITHUB_ variable, and up refuses the retired ones before anything starts", async () => {
    const apps = appProcesses(
      envKeyConfig(),
      { token: "t".repeat(64), openaiApiKey: "sk-test" },
      { PATH: "/bin", FACTORY_GITHUB_TOKEN: "ghp_not_real", FACTORY_GITHUB_ANYTHING: "x" },
    )
    for (const app of apps)
      expect(
        Object.keys(app.env).filter(
          (k) =>
            k.startsWith("FACTORY_GITHUB_") &&
            k !== "FACTORY_GITHUB_APP_ID" &&
            k !== "FACTORY_GITHUB_APP_PRIVATE_KEY_FILE",
        ),
        app.name,
      ).toEqual([])
    for (const retired of ["FACTORY_GITHUB_TOKEN", "FACTORY_GITHUB_APP_PRIVATE_KEY"]) {
      const { problems, secrets } = await preflight(envKeyConfig(), {
        env: {
          FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
          OPENAI_API_KEY: "sk-x",
          [KEY_VAR]: PEM,
          [retired]: retired === "FACTORY_GITHUB_TOKEN" ? "ghp_not_real_value" : PEM,
        },
        dotenvPaths: [],
        checkoutLock: "/nonexistent",
        docker: { info: async () => {}, imagePresent: async () => true },
        drafterImage: "x",
        portFree: async () => true,
        launch: () => ({ command: "true", args: [] }),
        fetch,
        out: () => {},
        readyTimeoutMs: 1,
        stopTimeoutMs: 1,
      })
      expect(secrets === undefined, retired).toBe(true)
      const text = problems.join("\n")
      expect(text.includes(`${retired} is set`), retired).toBe(true)
      expect(text.includes("ghp_not_real_value") || text.includes("MII")).toBe(false)
    }
  })

  it("M3: redacts the key's body however it is re-wrapped, re-encoded or cut", () => {
    for (const kind of ["pkcs1", "pkcs8"] as const) {
      const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: kind, format: "pem" })
        .toString()
      const redact = redactor({ token: "t".repeat(64), openaiApiKey: "sk-x", githubAppKey: pem })
      const body = pem.split("\n").filter((l) => l !== "" && !l.startsWith("-----"))
      const b64 = body.join("")
      const chunks = (b64.match(/.{24}/g) ?? []).map((c) => c.slice(0, 16))
      const leaks = (text: string) => {
        const out = text.split("\n").map(redact).join("\n")
        return chunks.some((chunk) => out.includes(chunk))
      }
      expect(leaks(JSON.stringify(pem)), `${kind} json`).toBe(false)
      expect(leaks(b64), `${kind} one line`).toBe(false)
      expect(leaks((b64.match(/.{1,76}/g) ?? []).join("\n")), `${kind} 76`).toBe(false)
      expect(leaks(`x ${(body[2] as string).slice(0, 40)}…`), `${kind} cut`).toBe(false)
      const whole = Buffer.from(pem).toString("base64")
      expect(redact(whole) === whole, `${kind} base64 of the PEM`).toBe(false)
      const hex = Buffer.from(b64, "base64").toString("hex")
      expect(redact(hex) === hex, `${kind} hex DER`).toBe(false)
      expect(redact(hex.toUpperCase()) === hex.toUpperCase(), `${kind} HEX DER`).toBe(false)
      // An ordinary line is untouched.
      expect(redact("controller ready on 127.0.0.1:4300")).toBe(
        "controller ready on 127.0.0.1:4300",
      )
    }
  })

  it("M5: refuses a key file inside the state directory, reached through a link, or a directory", () => {
    dir = mkdtempSync(join(tmpdir(), "up-key-m5-"))
    const state = join(dir, "state")
    mkdirSync(state)
    const inside = join(state, "k.pem")
    writeFileSync(inside, PEM, { mode: 0o600 })
    const link = join(dir, "link.pem")
    symlinkSync(inside, link)
    const at = (path: string) =>
      parseFactoryConfig(
        { ...draftPr({ id: 1, privateKeyFile: path }), state },
        join(dir as string, "factory.config.ts"),
      )
    expect(deliveryKeyProblems(at(inside)).some((p) => p.includes(`inside ${state}`))).toBe(true)
    expect(deliveryKeyProblems(at(link)).some((p) => p.includes(`inside ${state}`))).toBe(true)
    const directory = join(dir, "keydir")
    mkdirSync(directory, { mode: 0o700 })
    expect(deliveryKeyProblems(at(directory)).some((p) => p.includes("not a regular file"))).toBe(
      true,
    )
  })
})

describe("the key's variable and GitHub credentials in up's children", () => {
  const withKeyEnv = (name: string) =>
    parseFactoryConfig(draftPr({ id: 1, privateKeyEnv: name }), CONFIG_PATH)

  it("refuses a privateKeyEnv that names an essential or factory-owned variable, naming the field only", () => {
    for (const name of [
      "PATH",
      "HOME",
      "USER",
      "SHELL",
      "TMPDIR",
      "NODE_OPTIONS",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "FACTORY_WORKER_TOKEN",
      "FACTORY_STATE_DIR",
      "FACTORY_SOMETHING_NEW",
      "OPENAI_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "_LEADING",
      "lower_case",
    ]) {
      let refusal = ""
      try {
        withKeyEnv(name)
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error)
      }
      expect(refusal.includes("delivery.draftPr.app.privateKeyEnv"), name).toBe(true)
      expect(refusal.includes(name), name).toBe(false)
    }
    for (const name of ["B4_FACTORY_APP_KEY", "MY_APP_KEY"])
      expect(withKeyEnv(name).delivery?.key, name).toEqual({ env: name })
  })

  it("keeps GH_TOKEN, GITHUB_TOKEN and every GITHUB_APP_ variable from the workers and the controller", () => {
    const credentials = {
      GH_TOKEN: "h",
      GITHUB_TOKEN: "i",
      GH_ENTERPRISE_TOKEN: "j",
      GITHUB_ENTERPRISE_TOKEN: "k",
      GITHUB_APP_PRIVATE_KEY: "l",
      GITHUB_APP_ID: "m",
    }
    const apps = appProcesses(
      parseFactoryConfig(base, CONFIG_PATH),
      { token: "t".repeat(64), openaiApiKey: "sk-test" },
      { PATH: "/bin", OTHER: "kept", ...credentials },
    )
    for (const app of apps) {
      expect(
        Object.keys(app.env).filter((k) => Object.hasOwn(credentials, k)),
        app.name,
      ).toEqual([])
      expect(app.env.PATH, app.name).toBe("/bin")
    }
    for (const app of apps.filter((a) => a.name !== "controller"))
      expect(app.env.OTHER, app.name).toBe("kept")
  })

  it("keeps every GITHUB_APP_ variable from up's own git, ps and docker", () => {
    const own = ownSubprocessEnv({ PATH: "/bin", GITHUB_APP_PRIVATE_KEY: "x", GITHUB_APP_ID: "1" })
    expect(own).toEqual({ PATH: "/bin" })
  })
})
