import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

/**
 * Write `text` to `path` so a reader sees the old file or the new one, never a torn one: the
 * bytes go to a temporary sibling in the same directory (so the rename stays on one file
 * system) and are renamed over `path`. A failed write leaves no temporary file behind.
 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, text)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
