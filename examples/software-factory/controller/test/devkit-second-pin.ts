import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appRoot, targetsDir } from "../src/lib/targets/catalog.ts"

/**
 * `Release 0.10.0 (#782)` on main: after the devkit target was introduced, with every devkit
 * path the target names present. In a shallow checkout `ensurePin` fetches it by sha.
 */
export const SECOND_PIN = "bfaf0c2b3030eebb572703c8f70f0e063593b1fa"

/**
 * Prepare `devkit` at {@link SECOND_PIN} into a COPY of `targets/devkit`
 * (`FACTORY_TARGETS_DIR`), so the working tree is never written. The image stays, and the next
 * lane's build is served from Docker's layer cache. Requires Docker; `test:sandbox` only.
 */
export function prepareDevkitSecondPin(): {
  readonly targetsDir: string
  cleanup(): void
} {
  const copy = mkdtempSync(join(tmpdir(), "factory-devkit-pin-targets-"))
  try {
    cpSync(join(targetsDir, "devkit"), join(copy, "devkit"), { recursive: true })
    const started = Date.now()
    execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/prepare-target.ts", "devkit", "--pin", SECOND_PIN],
      {
        cwd: appRoot,
        env: { ...process.env, FACTORY_TARGETS_DIR: copy },
        stdio: ["ignore", "inherit", "inherit"],
        timeout: 1_140_000,
      },
    )
    process.stderr.write(`target:prepare devkit --pin ${SECOND_PIN}: ${Date.now() - started} ms\n`)
  } catch (error) {
    rmSync(copy, { recursive: true, force: true })
    throw error
  }
  return { targetsDir: copy, cleanup: () => rmSync(copy, { recursive: true, force: true }) }
}
