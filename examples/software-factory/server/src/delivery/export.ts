import { randomUUID } from "node:crypto"
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Bundle } from "../domain/work-order.js"

export interface ExportInput {
  readonly directory: string
  readonly bundle: Bundle
  readonly changes: Readonly<Record<string, string>>
}

/**
 * Write the approved bytes. The receipt is named by the bundle digest, so a retry
 * lands on the same name with the same content and a second delivery is
 * impossible. Differing content under an existing name is a hard error rather
 * than an overwrite: the operator approved a specific bundle, once.
 */
export async function exportApproved(input: ExportInput): Promise<string> {
  const path = join(input.directory, `${input.bundle.digest}.json`)
  const body = `${JSON.stringify({ bundle: input.bundle, changes: input.changes }, null, 2)}\n`
  await mkdir(input.directory, { recursive: true })
  // Write the whole body to a sibling temp file first, then publish it under the digest with
  // `link`, which is atomic and fails with EEXIST when the name is taken. That is both
  // halves of the guarantee at once: the final name never appears holding half a receipt
  // (a torn write leaves only the temp file, which the retry replaces), and two exports
  // racing under one digest still cannot both believe they created it. `rename` would be
  // atomic too, but it overwrites, and this file is the one thing the controller cannot
  // take back.
  const tmpPath = join(input.directory, `.${input.bundle.digest}.${randomUUID()}.tmp`)
  try {
    await writeFile(tmpPath, body)
    await link(tmpPath, path)
    return path
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  } finally {
    await rm(tmpPath, { force: true })
  }
  const existing = await readFile(path, "utf8")
  if (existing !== body)
    throw new Error(`Bundle ${input.bundle.digest} was already exported with different content`)
  return path
}
