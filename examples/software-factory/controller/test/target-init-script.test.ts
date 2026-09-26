import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { appRoot, targetsDir } from "../src/lib/targets/catalog.ts"
import { cleanupPinRepos, MINI, pinRepo } from "./pin-repo.ts"

const dirs: string[] = []
afterEach(() => {
  cleanupPinRepos()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
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

  it("writes with --write, into a relative catalog resolved against pnpm's invoking directory", async () => {
    const { root, pin } = pinRepo(MINI)
    const invoked = mkdtempSync(join(tmpdir(), "factory-init-invoked-"))
    dirs.push(invoked)
    const { stdout, stderr } = await run(
      process.execPath,
      [tsxBin, "scripts/target-init.ts", "@m/app", "--pin", pin, "--targets-dir", "t", "--write"],
      {
        cwd: appRoot,
        env: { ...process.env, FACTORY_REPO_ROOT: root, FACTORY_NO_FETCH: "1", INIT_CWD: invoked },
      },
    )
    expect(stdout).toContain("--- /dev/null\n+++ b/app/target.json\n")
    const manifest = join(invoked, "t", "app", "target.json")
    expect(stderr).toContain(`target:init: wrote ${manifest}\n`)
    expect(stderr).toContain(`target:init: wrote ${join(invoked, "t", "app", "Dockerfile")}\n`)
    expect(JSON.parse(readFileSync(manifest, "utf8")).commands.cwd).toBe("packages/app")
    expect(existsSync(join(appRoot, "t"))).toBe(false)
  })

  it("prints a refusal as one line and exits 1", async () => {
    const failure = await run(
      process.execPath,
      [tsxBin, "scripts/target-init.ts", "@m/app", "--force"],
      {
        cwd: appRoot,
      },
    ).catch((error: { code: number; stderr: string }) => error)
    expect(failure).toMatchObject({ code: 1 })
    const { stderr } = failure as { stderr: string }
    expect(stderr).toMatch(/^target:init: Unknown option '--force'/)
    expect(stderr).not.toMatch(/^\s+at /m)
  })
})
