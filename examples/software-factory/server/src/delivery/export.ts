import { mkdir, readFile, writeFile } from "node:fs/promises"
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
  try {
    // `wx` is the whole guard: an exclusive create is atomic, so two exports racing
    // under one digest cannot both believe they created the file.
    await writeFile(path, body, { flag: "wx" })
    return path
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const existing = await readFile(path, "utf8")
  if (existing !== body)
    throw new Error(`Bundle ${input.bundle.digest} was already exported with different content`)
  return path
}
