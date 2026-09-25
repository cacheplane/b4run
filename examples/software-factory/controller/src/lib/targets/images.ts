import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { imageRecipeDigest } from "../domain/digest.js"
import { type Target, type TargetRecipe, tagFor } from "./catalog.js"

/** The Docker platform this host builds and runs: the image object's `platform`. */
export function hostPlatform(arch: string = process.arch): string {
  if (arch === "arm64") return "linux/arm64"
  if (arch === "x64") return "linux/amd64"
  throw new Error(`Unsupported host architecture ${arch}`)
}

/** sha256 of the target's Dockerfile, over its exact bytes. */
export function dockerfileSha256Of(recipe: Pick<TargetRecipe, "directory">): string {
  return createHash("sha256")
    .update(readFileSync(join(recipe.directory, "Dockerfile")))
    .digest("hex")
}

/** `sha256:<hex>` of a `<name>[:<tag>]@sha256:<hex>` reference the schema already checked. */
export function baseDigestOf(baseImage: string): string {
  return baseImage.slice(baseImage.indexOf("@") + 1)
}

/**
 * The recipe tag of a loaded target: its recipe key on its image's platform. Moved here from
 * `catalog.ts` (which cannot import this module at runtime); every importer of `imageTag`
 * now imports it from `targets/images.js`.
 */
export function imageTag(target: Target): string {
  return tagFor(target.id, target.pin, recipeKey(target, target.image.platform))
}

/** The recipe tag `recipe` builds under on `platform` (this host's by default). */
export function recipeTag(recipe: TargetRecipe, platform: string = hostPlatform()): string {
  return tagFor(recipe.id, recipe.pin, recipeKey(recipe, platform))
}

/** The registry key of `recipe` (at its own pin) on `platform`: see `imageRecipeDigest`. */
export function recipeKey(
  recipe: TargetRecipe,
  platform: string,
  dockerfileSha256: string = dockerfileSha256Of(recipe),
): string {
  return imageRecipeDigest({
    targetId: recipe.id,
    pin: recipe.pin,
    platform,
    baseImage: recipe.baseImage,
    dockerfileSha256,
    imageContext: recipe.imageContext,
    lockfile: recipe.lockfile,
    imageAssertResolves: recipe.imageAssertResolves,
    commandsCwd: recipe.commands.cwd,
  })
}
