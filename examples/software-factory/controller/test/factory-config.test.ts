import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  applyConfigDefaults,
  DEFAULT_CONFIG_PATH,
  EXAMPLE_ROOT,
  factoryConfigPath,
  loadFactoryConfig,
  ownedVariableConflicts,
  parseFactoryConfig,
} from "../src/lib/operator/factory-config.ts"

const PATH = join(EXAMPLE_ROOT, "factory.config.ts")
const good = {
  state: ".factory",
  controller: { port: 4300 },
  builder: { port: 4100 },
  drafter: { port: 4200 },
}
const refusal = (value: unknown): string => {
  try {
    parseFactoryConfig(value, PATH)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error("expected a refusal")
}

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("parseFactoryConfig", () => {
  it("resolves the state beside the file and derives loopback URLs from the ports", () => {
    expect(parseFactoryConfig(good, PATH)).toEqual({
      path: PATH,
      stateDir: join(EXAMPLE_ROOT, ".factory"),
      ports: { controller: 4300, builder: 4100, drafter: 4200 },
      urls: {
        controller: "http://127.0.0.1:4300",
        builder: "http://127.0.0.1:4100",
        drafter: "http://127.0.0.1:4200",
      },
    })
    expect(parseFactoryConfig({ ...good, state: "/var/tmp/f" }, PATH).stateDir).toBe("/var/tmp/f")
  })

  it("fails closed on a near-miss, naming the path", () => {
    expect(refusal({ ...good, contoller: { port: 4300 } })).toMatch(/contoller/)
    expect(refusal({ ...good, controller: { port: 4300, prot: 1 } })).toMatch(/controller/)
    expect(refusal({ ...good, controller: { port: "4300" } })).toMatch(/controller\.port/)
    expect(refusal({ ...good, drafter: undefined })).toMatch(/drafter/)
    expect(refusal({ ...good, builder: { port: 80 } })).toMatch(/builder\.port/)
    expect(refusal({ ...good, builder: { port: 1023 } })).toMatch(/builder\.port/)
    expect(refusal({ ...good, builder: { port: 65536 } })).toMatch(/builder\.port/)
    expect(refusal({ ...good, builder: { port: 4100.5 } })).toMatch(/builder\.port/)
    expect(refusal({ ...good, state: "" })).toMatch(/state/)
    expect(refusal({ ...good, state: "  \t" })).toMatch(/state: must name a directory/)
    expect(refusal(null)).toMatch(/default export must be a plain object, got null/)
    expect(refusal([good])).toMatch(/got an array/)
  })

  it("accepts the port bounds", () => {
    expect(parseFactoryConfig({ ...good, builder: { port: 1024 } }, PATH).ports.builder).toBe(1024)
    expect(parseFactoryConfig({ ...good, builder: { port: 65535 } }, PATH).ports.builder).toBe(
      65535,
    )
  })

  it("refuses a default export that is not a plain object", () => {
    expect(refusal(new Map())).toMatch(/must be a plain object/)
    expect(refusal(Object.assign(Object.create({ inherited: 1 }), good))).toMatch(
      /must be a plain object/,
    )
    expect(refusal(Promise.resolve(good))).toMatch(
      /a promise: export the object itself \(top-level await is allowed\)/,
    )
    expect(parseFactoryConfig(Object.assign(Object.create(null), good), PATH).ports.builder).toBe(
      4100,
    )
  })

  it("does not read the replaced-key table through the prototype chain", () => {
    const message = refusal({ ...good, toString: 1, constructor: 2 })
    expect(message).not.toMatch(/function|\[native code\]/)
    expect(message).toMatch(/Unrecognized key/)
  })

  it("refuses the spec's draft keys with what replaced them", () => {
    const worker = { url: "http://127.0.0.1:4100", token: { env: "FACTORY_WORKER_TOKEN" } }
    expect(refusal({ ...good, worker })).toMatch(/worker: the factory has two workers/)
    expect(refusal({ ...good, token: "x" })).toMatch(/token: up generates the worker token/)
    expect(refusal({ ...good, host: "0.0.0.0" })).toMatch(
      /host: up binds every process to 127\.0\.0\.1/,
    )
  })

  it("refuses two processes on one port", () => {
    expect(refusal({ ...good, drafter: { port: 4100 } })).toMatch(
      /drafter\.port: 4100 is also builder\.port/,
    )
  })

  it("refuses a state directory inside an app root", () => {
    for (const inside of ["controller/.factory", "server", "drafter/state"])
      expect(refusal({ ...good, state: inside })).toMatch(/inside the \w+'s app root/)
  })

  it("refuses a name that only starts with two dots", () => {
    for (const inside of ["controller/..x", "server/..cache/state"])
      expect(refusal({ ...good, state: inside })).toMatch(/inside the \w+'s app root/)
    expect(parseFactoryConfig({ ...good, state: "..x" }, PATH).stateDir).toBe(
      resolve(EXAMPLE_ROOT, "..x"),
    )
  })

  it("refuses a state directory reached through a symlink into an app root", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-config-"))
    symlinkSync(join(EXAMPLE_ROOT, "drafter"), join(dir, "link"))
    expect(refusal({ ...good, state: join(dir, "link") })).toMatch(/inside the drafter's app root/)
    expect(refusal({ ...good, state: join(dir, "link", "not", "yet") })).toMatch(
      /inside the drafter's app root/,
    )
  })

  const caseInsensitive = (() => {
    const upper = join(EXAMPLE_ROOT, "CONTROLLER")
    if (!existsSync(upper)) return false
    const a = statSync(upper)
    const b = statSync(join(EXAMPLE_ROOT, "controller"))
    return a.dev === b.dev && a.ino === b.ino
  })()
  it.skipIf(!caseInsensitive)("refuses a case variant on a case-insensitive filesystem", () => {
    for (const inside of ["Controller/.factory", "SERVER", "dRaFtEr/x"])
      expect(refusal({ ...good, state: inside })).toMatch(/inside the \w+'s app root/)
  })
})

describe("the config file", () => {
  it("the committed one loads", async () => {
    expect(DEFAULT_CONFIG_PATH).toBe(PATH)
    const loaded = await loadFactoryConfig(DEFAULT_CONFIG_PATH)
    expect(loaded.stateDir).toBe(join(EXAMPLE_ROOT, ".factory"))
    expect(loaded.ports).toEqual({ controller: 4300, builder: 4100, drafter: 4200 })
  })

  it("refuses a missing file and a file with no default export", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-config-"))
    await expect(loadFactoryConfig(join(dir, "nope.ts"))).rejects.toThrow(/No factory config at/)
    const bare = join(dir, "bare.ts")
    writeFileSync(bare, "export const config = {}\n")
    await expect(loadFactoryConfig(bare)).rejects.toThrow(/has no default export/)
  })

  it("names the file when importing it fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-config-"))
    const broken = join(dir, "broken.ts")
    writeFileSync(broken, 'throw new Error("boom")\nexport default {}\n')
    await expect(loadFactoryConfig(broken)).rejects.toThrow(
      `factory config ${broken} failed to load: boom`,
    )
  })

  it("is named by --config, else FACTORY_CONFIG, else the example's own; none reads none", () => {
    expect(factoryConfigPath({}, undefined)).toEqual({ path: DEFAULT_CONFIG_PATH, named: false })
    expect(factoryConfigPath({ FACTORY_CONFIG: "a.ts" }, undefined)).toEqual({
      path: resolve("a.ts"),
      named: true,
    })
    expect(factoryConfigPath({ FACTORY_CONFIG: "a.ts" }, "b.ts")?.path).toBe(resolve("b.ts"))
    expect(factoryConfigPath({ FACTORY_CONFIG: "none" }, undefined)).toBeUndefined()
  })

  it("resolves a relative name against where pnpm was run (INIT_CWD), else the cwd", () => {
    const at = { INIT_CWD: "/where/typed" }
    expect(factoryConfigPath(at, "c.ts", "/controller")?.path).toBe("/where/typed/c.ts")
    expect(factoryConfigPath({ ...at, FACTORY_CONFIG: "e.ts" }, undefined, "/controller")).toEqual({
      path: "/where/typed/e.ts",
      named: true,
    })
    expect(factoryConfigPath({}, "c.ts", "/controller")?.path).toBe("/controller/c.ts")
    expect(factoryConfigPath(at, "/abs/c.ts", "/controller")?.path).toBe("/abs/c.ts")
  })

  it("refuses an empty --config rather than falling back", () => {
    expect(() => factoryConfigPath({}, "")).toThrow("--config needs a path")
    expect(() => factoryConfigPath({ FACTORY_CONFIG: "a.ts" }, "")).toThrow("--config needs a path")
  })
})

describe("the environment and the config", () => {
  const config = parseFactoryConfig(good, PATH)

  it("fills the CLI's two variables when unset, and keeps the environment's when set", () => {
    const env: Record<string, string | undefined> = {}
    expect(applyConfigDefaults(env, config)).toEqual([])
    expect(env).toEqual({
      FACTORY_CONTROLLER_URL: "http://127.0.0.1:4300",
      FACTORY_STATE_DIR: join(EXAMPLE_ROOT, ".factory"),
    })
    const exported = { FACTORY_CONTROLLER_URL: "http://127.0.0.1:4300/", FACTORY_STATE_DIR: "/old" }
    const warnings = applyConfigDefaults(exported, config)
    expect(exported.FACTORY_STATE_DIR).toBe("/old")
    expect(warnings).toEqual([
      `FACTORY_STATE_DIR is /old in the environment but ${join(EXAMPLE_ROOT, ".factory")} in ${PATH}; using the environment's`,
    ])
  })

  it("warns when only one of the two variables is set in the environment, naming both sources", () => {
    const env: Record<string, string | undefined> = {
      FACTORY_CONTROLLER_URL: "http://127.0.0.1:4300",
    }
    const warnings = applyConfigDefaults(env, config)
    expect(env).toEqual({
      FACTORY_CONTROLLER_URL: "http://127.0.0.1:4300",
      FACTORY_STATE_DIR: join(EXAMPLE_ROOT, ".factory"),
    })
    expect(warnings).toEqual([
      `FACTORY_CONTROLLER_URL is from the environment but FACTORY_STATE_DIR is from ${PATH}: reads may come from one registry and writes go to another controller`,
    ])
  })

  it("names every variable up owns that the environment sets otherwise", () => {
    expect(ownedVariableConflicts({}, config)).toEqual([])
    expect(
      ownedVariableConflicts(
        {
          FACTORY_STATE_DIR: join(EXAMPLE_ROOT, ".factory"),
          FACTORY_WORKER_URL: "http://127.0.0.1:9999",
          FACTORY_DRAFTER_URL: "http://127.0.0.1:4200/",
        },
        config,
      ),
    ).toEqual([
      `FACTORY_WORKER_URL is http://127.0.0.1:9999 in the environment but up starts the builder at http://127.0.0.1:4100: unset it (the CLI reads ${PATH}) or make them equal`,
    ])
    expect(
      ownedVariableConflicts({ FACTORY_STATE_DIR: "/old", FACTORY_CONTROLLER_URL: "" }, config),
    ).toEqual([
      `FACTORY_STATE_DIR is /old in the environment but up keeps the controller's state in ${join(EXAMPLE_ROOT, ".factory")}: unset it (the CLI reads ${PATH}) or make them equal`,
    ])
  })

  it("names all four owned variables, in order, when every one disagrees", () => {
    const tail = `: unset it (the CLI reads ${PATH}) or make them equal`
    expect(
      ownedVariableConflicts(
        {
          FACTORY_STATE_DIR: "/s",
          FACTORY_DRAFTER_URL: "http://d",
          FACTORY_WORKER_URL: "http://w",
          FACTORY_CONTROLLER_URL: "http://c",
        },
        config,
      ),
    ).toEqual([
      `FACTORY_CONTROLLER_URL is http://c in the environment but up starts the controller at http://127.0.0.1:4300${tail}`,
      `FACTORY_WORKER_URL is http://w in the environment but up starts the builder at http://127.0.0.1:4100${tail}`,
      `FACTORY_DRAFTER_URL is http://d in the environment but up starts the drafter at http://127.0.0.1:4200${tail}`,
      `FACTORY_STATE_DIR is /s in the environment but up keeps the controller's state in ${join(EXAMPLE_ROOT, ".factory")}${tail}`,
    ])
  })
})
