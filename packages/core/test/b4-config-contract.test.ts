import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import * as configApi from "../src/config.ts"
import * as nodeApi from "../src/node.ts"

// These old names are intentional negative fixtures for the clean break.
const legacyConfigFile = "dawn.config.ts"
const tempDirs: string[] = []

type LoadedConfig = { configPath: string; config: { appDir?: string } }
type DiscoveredApp = { appRoot: string; configPath: string; routesDir: string; b4Dir: string }

function loadConfig(appRoot: string): Promise<LoadedConfig> {
  const load = Reflect.get(configApi, "loadB4Config")
  expect(load).toBeTypeOf("function")
  return (load as (options: { appRoot: string }) => Promise<LoadedConfig>)({ appRoot })
}

function findApp(options: { appRoot?: string; cwd?: string }): Promise<DiscoveredApp> {
  const find = Reflect.get(nodeApi, "findB4App")
  expect(find).toBeTypeOf("function")
  return (find as (options: { appRoot?: string; cwd?: string }) => Promise<DiscoveredApp>)(options)
}

beforeEach(() => {
  nodeApi.registerNodeConfigLoader()
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-config-contract-"))
  tempDirs.push(appRoot)
  await mkdir(join(appRoot, "src/app"), { recursive: true })
  await writeFile(join(appRoot, "package.json"), '{"type":"module"}\n')
  return appRoot
}

describe("B4 configuration contract", () => {
  it("loads the literal b4.config.ts filename with no legacy config present", async () => {
    const appRoot = await createApp()
    await writeFile(join(appRoot, "b4.config.ts"), 'export default { appDir: "src/app" }\n')

    expect(await loadConfig(appRoot)).toMatchObject({
      configPath: join(appRoot, "b4.config.ts"),
      config: { appDir: "src/app" },
    })
    expect(Reflect.get(configApi, "B4_CONFIG_FILE")).toBe("b4.config.ts")
  })

  it("never evaluates a legacy config when the B4 config exists", async () => {
    const appRoot = await createApp()
    await writeFile(join(appRoot, "b4.config.ts"), 'export default { appDir: "src/app" }\n')
    await writeFile(join(appRoot, legacyConfigFile), 'throw new Error("legacy config executed")\n')

    expect((await loadConfig(appRoot)).config).toEqual({ appDir: "src/app" })
  })

  it("rejects a project that only supplies the legacy config", async () => {
    const appRoot = await createApp()
    await writeFile(join(appRoot, legacyConfigFile), "export default {}\n")

    await expect(loadConfig(appRoot)).rejects.toMatchObject({
      code: "ENOENT",
      path: join(appRoot, "b4.config.ts"),
    })
    await expect(findApp({ appRoot })).rejects.toThrow("b4.config.ts")
  })

  it("discovers B4 config from a nested directory and uses .b4 for generated state", async () => {
    const appRoot = await createApp()
    await writeFile(join(appRoot, "b4.config.ts"), 'export default { appDir: "src/app" }\n')

    const app = await findApp({ cwd: join(appRoot, "src/app") })
    expect(app).toEqual({
      appRoot,
      configPath: join(appRoot, "b4.config.ts"),
      routesDir: join(appRoot, "src/app"),
      b4Dir: join(appRoot, ".b4"),
    })
  })

  it("does not export legacy configuration or discovery aliases", () => {
    expect(Reflect.get(configApi, "loadDawnConfig")).toBeUndefined()
    expect(Reflect.get(configApi, "seedDawnConfig")).toBeUndefined()
    expect(Reflect.get(configApi, "DAWN_CONFIG_FILE")).toBeUndefined()
    expect(Reflect.get(nodeApi, "findDawnApp")).toBeUndefined()
  })
})
