import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { __clearB4ConfigCacheForTests, loadB4Config } from "../src/config.js"
import { registerNodeConfigLoader } from "../src/config-node.js"

// These suites load real `b4.config.ts` files off disk — opt the process
// into the node config loader (the `.` barrel no longer carries it).
registerNodeConfigLoader()

describe("loadB4Config memoization", () => {
  test("returns the identical result object for repeated calls on one appRoot", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "b4-config-memo-"))
    await writeFile(join(appRoot, "b4.config.ts"), "export default { }\n", "utf8")
    const a = await loadB4Config({ appRoot })
    const b = await loadB4Config({ appRoot })
    expect(b).toBe(a) // same promise result — no re-import, no re-access()
  })

  test("distinct appRoots are cached independently", async () => {
    const r1 = await mkdtemp(join(tmpdir(), "b4-config-memo-"))
    const r2 = await mkdtemp(join(tmpdir(), "b4-config-memo-"))
    await writeFile(join(r1, "b4.config.ts"), "export default { }\n", "utf8")
    await writeFile(join(r2, "b4.config.ts"), "export default { }\n", "utf8")
    expect(await loadB4Config({ appRoot: r1 })).not.toBe(await loadB4Config({ appRoot: r2 }))
  })

  test("test-only cache clear forces a fresh load", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "b4-config-memo-"))
    await writeFile(join(appRoot, "b4.config.ts"), "export default { }\n", "utf8")
    const a = await loadB4Config({ appRoot })
    __clearB4ConfigCacheForTests()
    const b = await loadB4Config({ appRoot })
    expect(b).not.toBe(a)
  })
})
