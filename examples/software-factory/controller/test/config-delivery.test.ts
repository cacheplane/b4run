import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { loadConfig } from "../src/lib/config.ts"
import {
  APP_CREDENTIAL_VARIABLES,
  controllerRuntime,
  resetControllerRuntimeForTests,
} from "../src/lib/runtime.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString()

afterEach(async () => {
  await resetControllerRuntimeForTests()
  for (const name of [
    ...APP_CREDENTIAL_VARIABLES,
    "FACTORY_DELIVERY_REPOSITORY",
    "FACTORY_DELIVERY_BASE_BRANCH",
    "FACTORY_WORKER_URL",
    "FACTORY_STATE_DIR",
    "FACTORY_WORKER_TOKEN",
  ])
    delete process.env[name]
})

describe("the controller's delivery configuration", () => {
  const env = {
    FACTORY_WORKER_URL: "http://127.0.0.1:4100",
    FACTORY_STATE_DIR: "/tmp/state",
    FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
  }
  it("needs all four variables or none, and refuses a key in its environment", () => {
    const all = {
      ...env,
      FACTORY_GITHUB_APP_ID: "7",
      FACTORY_GITHUB_APP_PRIVATE_KEY_FILE: "/k.pem",
      FACTORY_DELIVERY_REPOSITORY: "cacheplane/b4run",
      FACTORY_DELIVERY_BASE_BRANCH: "main",
    }
    expect(loadConfig(all).delivery).toEqual({
      repository: "cacheplane/b4run",
      baseBranch: "main",
      appId: 7,
      privateKeyFile: "/k.pem",
    })
    expect(loadConfig(env).delivery).toBeUndefined()
    const { FACTORY_DELIVERY_BASE_BRANCH: _, ...three } = all
    expect(() => loadConfig(three)).toThrow(/missing FACTORY_DELIVERY_BASE_BRANCH/)
    expect(() => loadConfig({ ...env, FACTORY_GITHUB_APP_PRIVATE_KEY: PEM })).toThrow(
      /FACTORY_GITHUB_APP_PRIVATE_KEY is retired/,
    )
    try {
      loadConfig({ ...env, FACTORY_GITHUB_APP_PRIVATE_KEY: PEM })
    } catch (error) {
      expect(String(error).includes("MII")).toBe(false)
    }
  })
})

describe("the controller's own environment", () => {
  it("consumes the app's credential variables on its first read, before any child is spawned", () => {
    Object.assign(process.env, {
      FACTORY_WORKER_URL: "http://127.0.0.1:4100",
      FACTORY_STATE_DIR: "/tmp/state",
      FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
      FACTORY_GITHUB_APP_ID: "7",
      FACTORY_GITHUB_APP_PRIVATE_KEY_FILE: "/k.pem",
      FACTORY_DELIVERY_REPOSITORY: "cacheplane/b4run",
      FACTORY_DELIVERY_BASE_BRANCH: "main",
    })
    expect(controllerRuntime().config.delivery).toMatchObject({
      appId: 7,
      privateKeyFile: "/k.pem",
    })
    for (const name of APP_CREDENTIAL_VARIABLES) expect(process.env[name], name).toBeUndefined()
  })
})
