import type { RuntimeStorageScope } from "@b4run/sdk/agent-protocol"
import type { TableNaming } from "../schema.js"
import type { SqlClient, SqlPool } from "../sql.js"
export interface PostgresRuntimeInstallation {
  readonly installationId: string
  readonly schema: string
  readonly tablePrefix: string
  close(): Promise<void>
}
export interface Activity {
  readonly owner: PostgresRuntimeInstallation
  readonly kind: "transaction" | "lease"
  readonly scopeKey: string
  readonly installationId: string
  readonly client?: SqlClient
  active: boolean
  failure?: unknown
}
export interface Host {
  uuid(): string
  reserveReadLease(): () => void
  assertWorkCapacity(): void
  activity: { getStore(): Activity | undefined; run<T>(activity: Activity, callback: () => T): T }
}
export interface InstallationContext {
  readonly pool: SqlPool
  readonly naming: TableNaming
  readonly host: Host
  closed: boolean
  closing: boolean
  pending: number
  readonly handles: Set<SqlClient>
}
const contexts = new WeakMap<PostgresRuntimeInstallation, InstallationContext>()
export function registerInstallation(
  owner: PostgresRuntimeInstallation,
  context: InstallationContext,
): void {
  contexts.set(owner, context)
}
export function installationContext(owner: PostgresRuntimeInstallation): InstallationContext {
  const context = contexts.get(owner)
  if (!context || context.closed || context.closing)
    throw new Error("Runtime installation is closed")
  return context
}
export function scopeKey(owner: PostgresRuntimeInstallation, scope: RuntimeStorageScope): string {
  return JSON.stringify([owner.installationId, scope.threadId, scope.generation])
}
