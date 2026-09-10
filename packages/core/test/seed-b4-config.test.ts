import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { __clearB4ConfigCacheForTests, loadB4Config, seedB4Config } from "../src/config.js"
import { registerNodeConfigLoader } from "../src/config-node.js"

// These suites load real `b4.config.ts` files off disk — opt the process
// into the node config loader (the `.` barrel no longer carries it).
registerNodeConfigLoader()

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  __clearB4ConfigCacheForTests()
})

async function fixtureDir(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-seed-config-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  return appRoot
}

describe("seedB4Config", () => {
  test("primes the memo so loadB4Config never touches disk", async () => {
    // A nonexistent appRoot: the disk path would reject on access() — success
    // here proves the seed satisfied the load without any filesystem read.
    seedB4Config("/nonexistent/edge-app", { memory: { recall: {} } })
    const loaded = await loadB4Config({ appRoot: "/nonexistent/edge-app" })
    expect(loaded.config.memory?.recall).toEqual({})
    expect(loaded.configPath).toBe("<seeded>")
  })

  test("a seeded config wins over a real config file (explicit beats disk)", async () => {
    const appRoot = await fixtureDir()
    await writeFile(
      join(appRoot, "b4.config.ts"),
      'export default { permissions: { mode: "bypass" } }\n',
      "utf8",
    )
    // Load from disk first so the memo holds the disk entry, then seed: an
    // explicit seed overwrites a cached disk load, not just an empty memo.
    const fromDisk = await loadB4Config({ appRoot })
    expect(fromDisk.configPath).toBe(join(appRoot, "b4.config.ts"))

    seedB4Config(appRoot, { permissions: { mode: "non-interactive" } })
    const loaded = await loadB4Config({ appRoot })
    expect(loaded.configPath).toBe("<seeded>")
    expect(loaded.config.permissions?.mode).toBe("non-interactive")
  })

  test("a seed survives an in-flight disk load rejecting after the seed lands", async () => {
    const appRoot = "/nonexistent/edge-app-race"
    // Start a disk load (will reject: no such directory) but do NOT await it
    // yet — then seed while it is in flight. The rejection eviction must not
    // delete the seed (it identity-checks the cached promise).
    const inFlight = loadB4Config({ appRoot })
    seedB4Config(appRoot, { permissions: { mode: "non-interactive" } })
    await inFlight.catch(() => {})

    const loaded = await loadB4Config({ appRoot })
    expect(loaded.configPath).toBe("<seeded>")
    expect(loaded.config.permissions?.mode).toBe("non-interactive")
  })
})
