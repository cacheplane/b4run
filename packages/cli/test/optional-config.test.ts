import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { resolveSandboxManager } from "../src/lib/runtime/resolve-sandbox.ts"

const roots: string[] = []
async function root() {
  const path = await mkdtemp(join(tmpdir(), "b4-config-fail-closed-"))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
it("fails closed when configured sandbox cannot load", async () => {
  const appRoot = await root()
  await writeFile(
    join(appRoot, "b4.config.ts"),
    "throw new Error('required sandbox configuration failed'); export default {}",
  )
  await expect(resolveSandboxManager(appRoot)).rejects.toThrow(
    "required sandbox configuration failed",
  )
})
it("does not treat a missing imported module as an absent configuration", async () => {
  const appRoot = await root()
  await writeFile(
    join(appRoot, "b4.config.ts"),
    "import './missing-required-provider.js'; export default {}",
  )
  await expect(resolveSandboxManager(appRoot)).rejects.toThrow()
})
it("rejects a dangling config symlink", async () => {
  const appRoot = await root()
  await symlink(join(appRoot, "missing.ts"), join(appRoot, "b4.config.ts"))
  await expect(resolveSandboxManager(appRoot)).rejects.toThrow()
})
it("keeps genuinely absent config optional", async () => {
  expect(await resolveSandboxManager(await root())).toBeUndefined()
})
