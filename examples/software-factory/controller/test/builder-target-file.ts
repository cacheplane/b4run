import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BuilderTarget } from "../src/lib/builder-manifest.ts"

/**
 * A builder target file for `targetId`, as `factory builder-target` writes it, without the
 * catalog: the controller's config reads only the id out of it, and a test should not need
 * the target prepared (or its pin fetched) to name one. Returns the file's path.
 */
export function writeTargetFile(dir: string, targetId: string): string {
  const file: BuilderTarget = {
    version: 1,
    target: {
      id: targetId,
      scope: "software-factory-builder",
      image: `b4-factory-${targetId}:000000000000-000000000000`,
      policy: {
        network: { mode: "deny" },
        env: {},
        resources: { memoryMb: 1024, cpus: 1, timeoutMs: 60_000 },
      },
      permissions: { bash: ["npm test"] },
    },
  }
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${targetId}.target.json`)
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return path
}
