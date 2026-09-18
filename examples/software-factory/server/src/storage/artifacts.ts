import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
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
      try {
        await writeFile(pathFor(digest), content, { flag: "wx" })
      } catch (error) {
        // Identical content under an identical name: the write already happened.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      return { digest, bytes }
    },
    async read(digest) {
      try {
        return await readFile(pathFor(digest), "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error(`Artifact not found: ${digest}`)
        throw error
      }
    },
  }
}
