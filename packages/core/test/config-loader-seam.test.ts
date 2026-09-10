import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
  __clearB4ConfigCacheForTests,
  __clearConfigLoaderForTests,
  loadB4Config,
  registerConfigLoader,
  seedB4Config,
} from "../src/config.js"

// Both the memo and the registered loader are process-global. This suite is
// the only one that runs with NO loader registered, so it must leave the
// module in the state it found it in on BOTH sides.
beforeEach(() => {
  __clearB4ConfigCacheForTests()
  __clearConfigLoaderForTests()
})

afterEach(() => {
  __clearB4ConfigCacheForTests()
  __clearConfigLoaderForTests()
})

describe("config loader seam", () => {
  test("rejects with an actionable error when no loader is registered", async () => {
    await expect(loadB4Config({ appRoot: "/app" })).rejects.toThrow(/no config loader registered/i)
    await expect(loadB4Config({ appRoot: "/app" })).rejects.toThrow(/b4\.config\.ts/)
  })

  test("dispatches through the registered loader and memoizes its result", async () => {
    let calls = 0
    registerConfigLoader(async ({ appRoot }) => {
      calls += 1
      return { appRoot, config: { appDir: "src/app" }, configPath: `${appRoot}/b4.config.ts` }
    })

    const first = await loadB4Config({ appRoot: "/app" })
    const second = await loadB4Config({ appRoot: "/app" })

    expect(first.config.appDir).toBe("src/app")
    expect(second).toBe(first)
    expect(calls).toBe(1)
  })

  test("a seed beats the registered loader", async () => {
    let calls = 0
    registerConfigLoader(async ({ appRoot }) => {
      calls += 1
      return { appRoot, config: { appDir: "from-loader" }, configPath: `${appRoot}/b4.config.ts` }
    })

    seedB4Config("/app", { appDir: "seeded" })
    const loaded = await loadB4Config({ appRoot: "/app" })

    expect(loaded.configPath).toBe("<seeded>")
    expect(loaded.config.appDir).toBe("seeded")
    expect(calls).toBe(0)
  })

  test("a seed survives an in-flight registered load rejecting after the seed lands", async () => {
    registerConfigLoader(async () => {
      throw new Error("loader blew up")
    })

    // Do NOT await: seed while the load is in flight, so the rejection
    // eviction has to identity-check the cached promise to spare the seed.
    const inFlight = loadB4Config({ appRoot: "/app" })
    seedB4Config("/app", { appDir: "seeded" })
    await expect(inFlight).rejects.toThrow(/loader blew up/)

    const loaded = await loadB4Config({ appRoot: "/app" })
    expect(loaded.configPath).toBe("<seeded>")
    expect(loaded.config.appDir).toBe("seeded")
  })
})
