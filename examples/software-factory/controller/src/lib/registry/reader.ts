import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { UnknownWorkOrderError } from "../controller/factory.js"
import type {
  Bundle,
  Candidate,
  FactoryEvent,
  Receipt,
  WorkOrderRow,
} from "../domain/work-order.js"
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
  const db = new DatabaseSync(path, { readOnly: true })
  const store = createWorkOrderStore(db)
  const evidence = createEvidenceStore(db)
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
      return { candidate, receipt, bundle }
    },
    close: () => db.close(),
  }
}
