import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const USAGE_ID_FILENAME = "usage-id"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface UsageIdentity {
  readonly id: string
  readonly created: boolean
}

/** The directory holding the usage id, or null when no home directory is known. */
export function resolveUsageDir(homeDir?: string): string | null {
  let home: string
  try {
    home = homeDir ?? homedir()
  } catch {
    return null
  }
  if (home === "") return null
  return join(home, ".b4")
}

/**
 * Read the persisted random id, or create one. Any filesystem failure yields
 * null so callers can stay silent rather than fail a command.
 */
export async function readOrCreateUsageId(dir: string): Promise<UsageIdentity | null> {
  const file = join(dir, USAGE_ID_FILENAME)
  try {
    const existing = (await readFile(file, "utf8")).trim()
    if (UUID_PATTERN.test(existing)) return { id: existing, created: false }
  } catch {
    // Missing or unreadable: fall through and create one.
  }
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    return null
  }
  const id = randomUUID()
  try {
    // Exclusive create: of two concurrent first runs (turbo), exactly one wins.
    await writeFile(file, `${id}\n`, { flag: "wx", mode: 0o600 })
    return { id, created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") return null
  }
  // The winner may not have written its id yet; give it a moment before replacing.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const winner = (await readFile(file, "utf8")).trim()
      if (UUID_PATTERN.test(winner)) return { id: winner, created: false }
      if (winner !== "") break
    } catch {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  try {
    await writeFile(file, `${id}\n`, { mode: 0o600 })
    return { id, created: true }
  } catch {
    return null
  }
}
