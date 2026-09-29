import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_CONFIG_PATH,
  EXAMPLE_ROOT,
  factoryConfigPath,
  loadFactoryConfig,
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
    expect(refusal({ ...good, builder: { port: 4100.5 } })).toMatch(/builder\.port/)
    expect(refusal({ ...good, state: "" })).toMatch(/state/)
    expect(refusal(null)).toMatch(/default export must be an object, got null/)
    expect(refusal([good])).toMatch(/got an array/)
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

  it("is named by --config, else FACTORY_CONFIG, else the example's own; none reads none", () => {
    expect(factoryConfigPath({}, undefined)).toEqual({ path: DEFAULT_CONFIG_PATH, named: false })
    expect(factoryConfigPath({ FACTORY_CONFIG: "a.ts" }, undefined)).toEqual({
      path: resolve("a.ts"),
      named: true,
    })
    expect(factoryConfigPath({ FACTORY_CONFIG: "a.ts" }, "b.ts")?.path).toBe(resolve("b.ts"))
    expect(factoryConfigPath({ FACTORY_CONFIG: "none" }, undefined)).toBeUndefined()
  })
})
