import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { appRoot, targetsDir } from "../src/lib/targets/catalog.ts"
import { cleanupPinRepos, MINI, pinRepo } from "./pin-repo.ts"

afterEach(cleanupPinRepos)
const run = promisify(execFile)
// `.bin/tsx` is a shell shim `execFile(process.execPath, ...)` cannot run: tsx's own entry.
const tsxBin = join(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs")

describe("target-init.ts", () => {
  it("prints the proposal as a diff and writes nothing without --write", async () => {
    const { root, pin } = pinRepo(MINI)
    const { stdout, stderr } = await run(
      process.execPath,
      [tsxBin, "scripts/target-init.ts", "@m/app", "--pin", pin],
      { cwd: appRoot, env: { ...process.env, FACTORY_REPO_ROOT: root, FACTORY_NO_FETCH: "1" } },
    )
    expect(stdout).toContain("--- /dev/null\n+++ b/targets/app/target.json\n")
    expect(stdout).toContain("+++ b/targets/app/Dockerfile\n")
    expect(stderr).toContain("target:init: nothing written")
    expect(existsSync(join(targetsDir, "app"))).toBe(false)
  })
})
