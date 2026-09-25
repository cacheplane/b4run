import { join } from "node:path"
import { configuredImages, loadTargetRecipe } from "../src/lib/targets/catalog.ts"
import { dockerImageBuilder } from "../src/lib/targets/image-builder.ts"
import {
  type EnsuredImage,
  type ImageRegistry,
  openImageRegistry,
} from "../src/lib/targets/images.ts"

declare module "vitest" {
  export interface ProvidedContext {
    /** The directory of this `test:sandbox` run's own image registry (`lane-images.global.ts`). */
    readonly laneImagesDir: string
  }
}

/**
 * The registry one `test:sandbox` run shares across its lane files, in a directory the run's
 * global setup created for it alone (`mkdtemp`): two worktrees, or two runs, on one host never
 * share a registry, and nothing survives the run but the images themselves on the daemon, which
 * the next run's `ensure` re-verifies and, by the build cache, rebuilds in seconds.
 */
export function openLaneImages(dir: string): ImageRegistry {
  return openImageRegistry({
    path: join(dir, "images.sqlite"),
    builder: dockerImageBuilder(),
    buildTimeoutMs: 1_140_000,
  })
}

/** Build (or re-verify) `targetId` at `pin` (its default pin when absent) in the run's registry. */
export async function ensureLaneImage(targetId: string, pin?: string): Promise<EnsuredImage> {
  const registry = configuredImages()
  if (registry === undefined) throw new Error("the lane setup did not configure an image registry")
  return await registry.ensure(loadTargetRecipe(targetId, pin !== undefined ? { pin } : {}), {
    signal: AbortSignal.timeout(1_200_000),
    onBuild: () => process.stderr.write(`lane: building ${targetId}${pin ? ` at ${pin}` : ""}\n`),
  })
}
