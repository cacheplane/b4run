import { DatabaseSync } from "node:sqlite"
import type { WorkOrderRow } from "../domain/work-order.js"
import { createWorkOrderStore } from "./work-orders.js"

/**
 * A read-only view of the registry, for the read paths that must not be able to write it.
 * The Factory owns the one writing connection; this opens a second, `readOnly` one, so a
 * read cannot migrate, lock out, or mutate the registry the controller is driving.
 */
export interface RegistryReader {
  show(id: string): WorkOrderRow | null
  close(): void
}

export function openRegistryReader(path: string): RegistryReader {
  const db = new DatabaseSync(path, { readOnly: true })
  const store = createWorkOrderStore(db)
  return {
    show: (id) => store.get(id),
    close: () => db.close(),
  }
}
