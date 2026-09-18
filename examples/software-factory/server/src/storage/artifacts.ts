import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DIGEST_PATTERN } from "../domain/work-order.js"

export interface ArtifactRef {
  readonly digest: string
  readonly bytes: number
}

export interface ArtifactStore {
  /** Write content under its own sha256. Returns the same ref for identical content. */
  put(content: string): Promise<ArtifactRef>
  read(digest: string): Promise<string>
  pathFor(digest: string): string
}

/**
 * Immutable evidence lives outside the registry so a row never carries megabytes
 * of check output. The digest is the name, so a second write of the same bytes is
 * a no-op rather than a conflict.
 */
export function createArtifactStore(directory: string): ArtifactStore {
  const assertDigest = (digest: string): string => {
    if (!DIGEST_PATTERN.test(digest)) throw new Error(`Invalid artifact digest: ${digest}`)
    return digest
  }
  const pathFor = (digest: string) => join(directory, `${assertDigest(digest)}.txt`)

  return {
    pathFor,
    async put(content) {
      const digest = createHash("sha256").update(content).digest("hex")
      const bytes = Buffer.byteLength(content)
      await mkdir(directory, { recursive: true })
      const finalPath = pathFor(digest)
      // Write to a sibling temp file and rename onto the final path: rename is
      // atomic on POSIX, so a crash mid-write never leaves a truncated file under
      // the digest. This also self-heals a stale partial file left by an earlier
      // crash, since a fresh put() of the same content renames the correct bytes
      // over it.
      const tmpPath = join(directory, `.${digest}.${randomUUID()}.tmp`)
      try {
        await writeFile(tmpPath, content)
        await rename(tmpPath, finalPath)
      } catch (error) {
        await rm(tmpPath, { force: true })
        throw error
      }
      return { digest, bytes }
    },
    async read(digest) {
      let content: string
      try {
        content = await readFile(pathFor(digest), "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error(`Artifact not found: ${digest}`)
        throw error
      }
      // The digest is the name, so re-hashing is what makes the name a promise rather than a
      // label: a truncated, edited or swapped file is caught here instead of being parsed as
      // the approved bytes. It belongs in the store rather than at any one call site because
      // the guarantee is the store's own — every reader gets it, and no reader can forget it.
      const actual = createHash("sha256").update(content).digest("hex")
      if (actual !== digest)
        throw new Error(`Artifact ${digest} does not hash to its name (found ${actual})`)
      return content
    },
  }
}
