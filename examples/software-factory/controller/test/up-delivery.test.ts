import { generateKeyPairSync } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  ownSubprocessEnv,
  preflight,
  redactor,
  runKeyFile,
  type UpDeps,
  up,
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
})
