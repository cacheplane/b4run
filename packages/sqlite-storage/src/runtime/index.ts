import { AsyncLocalStorage } from "node:async_hooks"
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { openDb } from "../internal/db.js"
import { acquireOwner, assertSingleProcess, type OwnerLock } from "./owner.js"
import { installSchema, validateSchema } from "./schema.js"

export interface RuntimeInstallation {
  readonly path: string
  readonly installationId: string
  readonly settings: {
    readonly journalMode: string
    readonly synchronous: number
    readonly foreignKeys: number
  }
  close(): void
}
interface Context {
  readonly db: DatabaseSync
  readonly lock: OwnerLock
  readonly readers: Set<DatabaseSync>
  closed: boolean
  busy: boolean
  tail: Promise<void>
  pending: number
  readonly scopeTails: Map<string, Promise<void>>
  readonly leaseRequests: Map<string, { count: number }>
  readonly activity: AsyncLocalStorage<{ kind: "transaction" | "lease"; scopeKey: string }>
}
const contexts = new WeakMap<RuntimeInstallation, Context>()
function inspect(path: string, directory = false): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return false
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    throw new Error(`Invalid runtime path: ${path}`)
  return true
}
function inspectDatabase(path: string): boolean {
  const exists = inspect(path)
  let hasSidecar = false
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (!inspect(`${path}${suffix}`)) continue
    // Runtime state is WAL-only and the owner lock performs no writes. A
    // rollback journal may restore different committed bytes on mutable open;
    // reject even a cold journal rather than recover an unvalidated namespace.
    if (suffix === "-journal") throw new Error("Incompatible rollback journal in runtime namespace")
    hasSidecar = true
  }
  if (!exists && hasSidecar)
    throw new Error("Incompatible orphan runtime sidecar without its database")
  return exists
}
function preflight(path: string): string | undefined {
  if (!inspectDatabase(path)) return undefined
  // SQLite readOnly still updates shared-memory reader marks. Inspect a private
  // byte copy so even an incompatible WAL/SHM namespace remains untouched.
  // The second inspection runs under the lifetime owner, excluding live writers.
  const inspection = mkdtempSync(join(tmpdir(), "b4-runtime-inspect-"))
  let db: DatabaseSync | undefined
  try {
    const copy = join(inspection, "runtime.sqlite")
    copyFileSync(path, copy)
    if (inspect(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`)
    db = new DatabaseSync(copy, { readOnly: true })
    return validateSchema(db)
  } finally {
    try {
      db?.close()
    } finally {
      rmSync(inspection, { recursive: true, force: true })
    }
  }
}
/** Node trusted-host installation only. Does not bind a caller scope, activate
 * HTTP handlers, migrate legacy stores or advertise protocol capabilities. */
export function openRuntimeInstallation(
  appRoot: string,
  options: { readonly replicas?: number; readonly workers?: number } = {},
): RuntimeInstallation {
  assertSingleProcess(options)
  let directory = realpathSync(appRoot)
  for (const part of [".b4", "agent-protocol", "v1"]) {
    directory = join(directory, part)
    if (!inspect(directory, true)) mkdirSync(directory)
  }
  const path = join(directory, "runtime.sqlite")
  const expected = preflight(path)
  const ownerPath = join(directory, "runtime-owner.sqlite")
  inspectDatabase(ownerPath)
  const lock = acquireOwner(ownerPath)
  let db: DatabaseSync | undefined
  try {
    const current = preflight(path)
    if (current !== expected)
      throw new Error("Runtime installation changed during ownership acquisition")
    db = openDb(path, { synchronous: "FULL" })
    const installationId = current ?? installSchema(db)
    validateSchema(db)
    const { identity } = lock
    db.prepare("INSERT OR REPLACE INTO runtime_owner VALUES (1,?,?,?,?)").run(
      identity.pid,
      identity.start,
      identity.boot,
      identity.nonce,
    )
    const context: Context = {
      db,
      lock,
      readers: new Set(),
      closed: false,
      busy: false,
      tail: Promise.resolve(),
      pending: 0,
      scopeTails: new Map(),
      leaseRequests: new Map(),
      activity: new AsyncLocalStorage(),
    }
    const installation: RuntimeInstallation = {
      path,
      installationId,
      settings: {
        journalMode: String(db.prepare("PRAGMA journal_mode").get()?.journal_mode),
        synchronous: Number(db.prepare("PRAGMA synchronous").get()?.synchronous),
        foreignKeys: Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys),
      },
      close() {
        if (context.closed) return
        if (
          context.busy ||
          context.pending > 0 ||
          context.scopeTails.size > 0 ||
          context.leaseRequests.size > 0 ||
          context.readers.size > 0
        )
          throw new Error("Cannot close SQLite runtime during an active transaction or lease")
        context.closed = true
        try {
          for (const reader of context.readers) reader.close()
          db?.close()
        } finally {
          lock.close()
        }
      },
    }
    contexts.set(installation, context)
    return installation
  } catch (error) {
    try {
      db?.close()
    } finally {
      lock.close()
    }
    throw error
  }
}
/** Internal host seam. Not re-exported from the package. */
export function installationContext(installation: RuntimeInstallation): Context {
  const context = contexts.get(installation)
  if (!context || context.closed)
    throw new Error("SQLite runtime installation is closed or unrecognized")
  context.lock.assertHeld()
  return context
}
