import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const queues = new Map<string, Promise<unknown>>()
const LOCK_APPLICATION_ID = 0x4234524c
function inspectLock(db: DatabaseSync): number {
  const app = db.prepare("PRAGMA application_id").get()?.application_id
  const version = db.prepare("PRAGMA user_version").get()?.user_version
  const objects = db.prepare("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").all()
  if (
    objects.length ||
    (app !== 0 && app !== LOCK_APPLICATION_ID) ||
    (version !== 0 && version !== 1) ||
    (app === 0) !== (version === 0)
  )
    throw new Error("Incompatible permission lock database")
  return Number(app)
}
async function inspectExistingLock(path: string): Promise<void> {
  try {
    const file = await lstat(path)
    if (!file.isFile() || file.isSymbolicLink())
      throw new Error("Incompatible permission lock database")
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return
    throw error
  }
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    inspectLock(db)
  } finally {
    db.close()
  }
}
async function retryBusy<T>(callback: () => T | Promise<T>, deadline: number): Promise<T> {
  for (;;) {
    try {
      return await callback()
    } catch (error) {
      if (((error as { errcode?: number }).errcode ?? 0) % 256 !== 5 || Date.now() >= deadline)
        throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}
/** Node-only cross-instance/process kernel lock. The auxiliary database holds
 * no rule data. Process death releases the lock without guessing owner age. */
export async function withPermissionFile<T>(
  appRoot: string,
  callback: (path: string) => Promise<T>,
): Promise<T> {
  const root = await realpath(appRoot),
    directory = join(root, ".b4")
  const previous = queues.get(root) ?? Promise.resolve()
  const work = previous
    .catch(() => {})
    .then(async () => {
      await mkdir(directory, { recursive: true })
      const lockPath = join(directory, "permissions.lock.sqlite")
      // Existing foreign artifacts are inspected through a read-only handle
      // before any journaling pragma or mutable database open.
      const deadline = Date.now() + 5000
      await retryBusy(() => inspectExistingLock(lockPath), deadline)
      const db = new DatabaseSync(lockPath)
      try {
        db.exec("PRAGMA busy_timeout=0")
        await retryBusy(() => inspectLock(db), deadline)
        await retryBusy(() => db.exec("PRAGMA journal_mode=MEMORY"), deadline)
        await retryBusy(() => db.exec("BEGIN EXCLUSIVE"), deadline)
        const app = inspectLock(db)
        if (app === 0) {
          db.exec(`PRAGMA application_id=${LOCK_APPLICATION_ID}; PRAGMA user_version=1`)
        }
        const result = await callback(join(directory, "permissions.json"))
        db.exec("COMMIT")
        return result
      } finally {
        if (db.isTransaction) db.exec("ROLLBACK")
        db.close()
      }
    })
  queues.set(root, work)
  try {
    return await work
  } finally {
    if (queues.get(root) === work) queues.delete(root)
  }
}
export async function readPermissionFile(path: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { version: 1, allow: {}, deny: {} }
    throw new Error("Failed to read permissions.json", { cause: error })
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1)
      throw new Error("Unsupported permissions file")
    return parsed
  } catch (error) {
    throw new Error("Malformed permissions.json", { cause: error })
  }
}
/** Durable atomic replacement. Cache publication only follows this resolution. */
export async function writePermissionFile(
  path: string,
  document: Record<string, unknown>,
): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  let renamed = false
  try {
    const file = await open(temporary, "wx", 0o600)
    try {
      await file.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    renamed = true
    const directory = await open(join(path, ".."), "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    if (!renamed) await unlink(temporary).catch(() => {})
  }
}
