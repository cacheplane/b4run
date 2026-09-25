import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Image } from "../src/lib/targets/catalog.ts"
import { appRoot } from "../src/lib/targets/catalog.ts"

/**
 * `Release 0.10.0 (#782)` on main: after the devkit target was introduced, with every devkit
 * path the target names present. In a shallow checkout `ensurePin` fetches it by sha.
 */
export const SECOND_PIN = "bfaf0c2b3030eebb572703c8f70f0e063593b1fa"

/** What `target:prepare` prints on stdout. */
export interface PreparedImage extends Image {
  readonly key: string
  readonly tag: string
  readonly pin: string
  readonly built: boolean
  readonly identity: string
}

/**
 * Run `target:prepare devkit --pin SECOND_PIN` against a registry of its own (a fresh
 * `FACTORY_STATE_DIR`), as an operator warming a pin would. The image stays on the daemon, so a
 * later build of the same recipe is served from Docker's build cache. Requires Docker.
 */
export function prepareDevkitSecondPin(): {
  readonly stateDir: string
  readonly printed: PreparedImage
  cleanup(): void
} {
  const stateDir = mkdtempSync(join(tmpdir(), "factory-devkit-pin-state-"))
  const cleanup = () => rmSync(stateDir, { recursive: true, force: true })
  try {
    const started = Date.now()
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/prepare-target.ts", "devkit", "--pin", SECOND_PIN],
      {
        cwd: appRoot,
        env: { ...process.env, FACTORY_STATE_DIR: stateDir },
        stdio: ["ignore", "pipe", "inherit"],
        encoding: "utf8",
        timeout: 1_140_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    process.stderr.write(`target:prepare devkit --pin ${SECOND_PIN}: ${Date.now() - started} ms\n`)
    return { stateDir, printed: JSON.parse(out) as PreparedImage, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
