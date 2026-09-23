import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { UnknownWorkOrderError } from "../domain/errors.js"
import type {
  Bundle,
  Candidate,
  FactoryEvent,
  Receipt,
  WorkOrderRow,
} from "../domain/work-order.js"
import { oracleReceiptIdFor } from "../intake/oracle.js"
import { RegistryOutdatedError, RegistryVersionError, SCHEMA_VERSION } from "./db.js"
import { createEvidenceStore } from "./evidence.js"
import { createWorkOrderStore } from "./work-orders.js"

export interface RegistryReader {
  show(id: string): WorkOrderRow | null
  list(): WorkOrderRow[]
  events(id: string): FactoryEvent[]
  evidence(id: string): {
    candidate: Candidate | null
    receipt: Receipt | null
    bundle: Bundle | null
    /** The receipt of the oracle proof the approved draft was parked on; null without intake. */
    oracleReceipt: Receipt | null
  }
  /** Exposed for tests that prove the connection cannot write. */
  readonly db: DatabaseSync
  close(): void
}

/**
 * Read-only view of a registry another process writes. SQLite in WAL mode serves readers
 * alongside one writer; `readOnly` makes a write a SQLite error rather than a second writer.
 * The file must already exist: a reader never creates a registry, and a path typo must not
 * look like an empty factory. A WAL left by a crashed writer that needs recovery makes the
 * read-only open fail (SQLITE_READONLY_RECOVERY); the remedy is to start the controller,
 * which recovers it, not to retry here.
 */
export function openRegistryReader(path: string): RegistryReader {
  if (!existsSync(path)) throw new Error(`Registry ${path} does not exist`)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    throw openFailure(path, error)
  }
  // The same refusal `openRegistry` makes, for the same reason: a registry written by a
  // newer factory has columns and meanings this build does not know, and reading it anyway
  // would report a work order it cannot actually describe. The reader cannot migrate —
  // it is read-only — so the only answer is to say so. The same holds the other way: an
  // older registry lacks columns the row schema requires, and reading it would surface as
  // a validation error on a row that is fine, not a registry that is behind.
  try {
    const version =
      (db.prepare("SELECT max(version) AS v FROM schema_version").get() as { v: number | null })
        .v ?? 0
    if (version > SCHEMA_VERSION) throw new RegistryVersionError(version)
    if (version < SCHEMA_VERSION) throw new RegistryOutdatedError(version)
  } catch (error) {
    db.close()
    throw error instanceof RegistryVersionError || error instanceof RegistryOutdatedError
      ? error
      : openFailure(path, error)
  }
  const store = createWorkOrderStore(db)
  const evidence = createEvidenceStore(db)
  let closed = false
  const mustGet = (id: string): WorkOrderRow => {
    const row = store.get(id)
    if (!row) throw new UnknownWorkOrderError(id)
    return row
  }
  return {
    db,
    show: (id) => store.get(id),
    list: () => store.list(),
    events: (id) => store.events(id),
    evidence(id) {
      const row = mustGet(id)
      const candidate = row.candidateDigest ? evidence.candidate(row.candidateDigest) : null
      const bundle = row.bundleDigest ? evidence.bundle(row.bundleDigest) : null
      const receipt = bundle ? evidence.receipt(bundle.receiptId) : null
      const oracleId = oracleReceiptIdFor(store.events(id), row.taskDigest)
      const oracleReceipt = oracleId ? evidence.receipt(oracleId) : null
      return { candidate, receipt, bundle, oracleReceipt }
    },
    // Idempotent: the CLI closes a reader per poll and again in a `finally`, and a second
    // `db.close()` is a throw from node:sqlite, not a no-op.
    close: () => {
      if (closed) return
      closed = true
      db.close()
    },
  }
}

/**
 * The extended result codes a read-only open can fail with. node:sqlite reports them as
 * `{ code: "ERR_SQLITE_ERROR", errcode, errstr }` and the symbolic name never appears in the
 * message, so the number is the only thing to match on. SQLITE_READONLY_RECOVERY is
 * 264 (8 | 1 << 8): a WAL a crashed writer left behind needs recovery, which only a writable
 * connection can do, so retrying here will never work. SQLITE_READONLY_DBMOVED is 1032.
 */
const SQLITE_READONLY_RECOVERY = 264
const SQLITE_READONLY_DBMOVED = 1032

function openFailure(path: string, error: unknown): Error {
  const errcode = (error as { errcode?: unknown }).errcode
  if (errcode === SQLITE_READONLY_RECOVERY)
    return new Error("Registry needs recovery; start the controller, which recovers it", {
      cause: error,
    })
  if (errcode === SQLITE_READONLY_DBMOVED)
    return new Error("Registry file was moved or deleted while open", { cause: error })
  // An SQLite file that is not a registry at all: the tables this reader needs are absent.
  // Saying so names the mistake (a path pointing at some other database) instead of leaking
  // a bare "no such table".
  if (/no such table: schema_version/.test(String((error as { message?: unknown }).message)))
    return new Error(`${path} is not a factory registry`, { cause: error })
  return error instanceof Error ? error : new Error(String(error))
}
