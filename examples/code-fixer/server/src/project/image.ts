import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Every input of the prepared image: the recipe, the context allowlist, and each
 * file that allowlist admits. The base image is pinned by digest in the recipe.
 */
export const imageInputs = [
  "Dockerfile",
  ".dockerignore",
  "sample/project/package.json",
  "sample/project/package-lock.json",
] as const

/**
 * Content-addressed tag for an app's prepared image. Installations with the same
 * inputs share one image; different inputs never share a tag, so preparing one
 * installation cannot re-point the image another installation is using.
 */
export function preparedImageTag(root: string): string {
  const hash = createHash("sha256").update("b4-code-fixer-image/1\0")
  for (const path of imageInputs) {
    const bytes = readFileSync(join(root, path))
    hash.update(`${path}\0${bytes.length}\0`).update(bytes)
  }
  return `b4-code-fixer:${hash.digest("hex").slice(0, 32)}`
}

/** The recipe's single base image, which must be pinned by digest. */
export function baseImage(dockerfile: string): string {
  const from = dockerfile
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^FROM\s/i.test(line))
  const reference = from.length === 1 ? from[0]?.split(/\s+/)[1] : undefined
  if (!reference || !/^[a-z0-9./_-]+(?::[\w.-]+)?@sha256:[a-f0-9]{64}$/.test(reference))
    throw new Error("The Dockerfile needs exactly one FROM pinned by sha256 digest")
  return reference
}
