import { createHash } from "node:crypto"
import {
  configuredImages,
  configureImages,
  type Image,
  tagFor,
} from "../src/lib/targets/catalog.ts"
import {
  baseDigestOf,
  dockerfileSha256Of,
  ImagePrepareError,
  type ImageRegistry,
  type RecordedImage,
  recipeKey,
} from "../src/lib/targets/images.ts"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/**
 * The unit suite's registry: every target at every pin has an image, synthesised from its
 * recipe (the local id is `sha256:<recipe key>`), and nothing touches Docker. So `loadTarget`
 * loads everywhere a unit test reaches, and two recipes never share an image.
 */
export function staticImageRegistry(platform = "linux/arm64"): ImageRegistry {
  const answer = (recipe: Parameters<ImageRegistry["recorded"]>[0]): RecordedImage => {
    const dockerfileSha256 = dockerfileSha256Of(recipe)
    const key = recipeKey(recipe, platform, dockerfileSha256)
    const image: Image = {
      localId: `sha256:${key}`,
      platform,
      baseManifestDigest: baseDigestOf(recipe.baseImage),
      dockerfileSha256,
      lockfileSha256: sha(`${recipe.pin}:${recipe.lockfile}`),
      pnpmVersion: "10.33.0",
    }
    return { key, tag: tagFor(recipe.id, recipe.pin, key), image }
  }
  return {
    recorded: answer,
    async ensure(recipe, { signal }) {
      signal.throwIfAborted()
      return answer(recipe)
    },
    async present() {
      return true
    },
    close() {},
  }
}

/** A registry that has built nothing and cannot build: `loadTarget` finds no image anywhere. */
export function emptyImageRegistry(): ImageRegistry {
  return {
    recorded: () => undefined,
    async ensure(recipe) {
      throw new ImagePrepareError(
        `Target ${recipe.id} at ${recipe.pin}: this test builds nothing`,
        "",
        "",
      )
    },
    async present() {
      return false
    },
    close() {},
  }
}

/** Configure `registry` process-wide; the returned function puts the previous one back. */
export function useImages(registry: ImageRegistry): () => void {
  const previous = configuredImages()
  configureImages(registry)
  return () => configureImages(previous)
}
