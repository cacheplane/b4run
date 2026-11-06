import type { RuntimeStorageScope } from "@b4run/sdk/agent-protocol"
import { installationContext, type RuntimeInstallation } from "./index.js"
import { type BoundRuntimeStore, diagnostic, makeRuntimeStore } from "./transaction.js"

const bindings = new WeakMap<
  object,
  { installation: RuntimeInstallation; scope: RuntimeStorageScope }
>()
/** Trusted host plumbing only; not a policy gate or public package export.
 * C5/admission must validate current authority and provenance before minting.
 * That bridge is deliberately not activated by R2. */
export function createRuntimeBinding(
  installation: RuntimeInstallation,
  scope: RuntimeStorageScope,
): object {
  installationContext(installation)
  if (!scope.threadId || !scope.generation || !Number.isSafeInteger(scope.fence) || scope.fence < 1)
    throw new Error("Invalid runtime scope")
  const capability = Object.freeze({})
  bindings.set(capability, { installation, scope: Object.freeze({ ...scope }) })
  return capability
}
export function bindRuntimeStore(
  installation: RuntimeInstallation,
  capability: object,
  now: () => string = () => new Date().toISOString(),
): BoundRuntimeStore {
  const binding = bindings.get(capability)
  if (!binding || binding.installation !== installation)
    throw new Error("Unrecognized internal runtime binding")
  const { scope } = binding
  const { db, busy } = installationContext(installation)
  if (busy) throw new Error("Cannot bind a runtime scope during an active database transaction")
  db.exec("BEGIN IMMEDIATE")
  try {
    const row = db
      .prepare("SELECT fence,deleted FROM scopes WHERE thread_id=? AND generation=?")
      .get(scope.threadId, scope.generation)
    if (!row) {
      if (scope.fence !== 1)
        throw diagnostic("stale_fence", "New runtime scope must start at fence 1")
      db.prepare("INSERT INTO scopes(thread_id,generation,fence) VALUES (?,?,?)").run(
        scope.threadId,
        scope.generation,
        scope.fence,
      )
    } else if (row.fence !== scope.fence || row.deleted !== 0)
      throw diagnostic("stale_fence", "Runtime binding is stale")
    db.exec("COMMIT")
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK")
    throw error
  }
  return makeRuntimeStore(installation, scope, now)
}
