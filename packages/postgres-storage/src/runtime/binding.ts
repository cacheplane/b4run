import type { RuntimeStorageScope } from "@b4run/sdk/agent-protocol"
import { withTransaction } from "../internal/tx.js"
import { installationContext, type PostgresRuntimeInstallation } from "./index.js"
import { table } from "./schema.js"
import { assertRuntimeWriteEntry, diagnostic, makeRuntimeStore } from "./transaction.js"

const bindings = new WeakMap<
  object,
  { installation: PostgresRuntimeInstallation; scope: RuntimeStorageScope }
>()
/** Internal trusted-host capability, inactive until the C5-to-backend bridge.
 * IDs/principals/configuration alone never construct a package-exported store. */
export function createRuntimeBinding(
  installation: PostgresRuntimeInstallation,
  scope: RuntimeStorageScope,
): object {
  installationContext(installation)
  if (!scope.threadId || !scope.generation || !Number.isSafeInteger(scope.fence) || scope.fence < 1)
    throw new Error("Invalid runtime scope")
  const capability = Object.freeze({})
  bindings.set(capability, { installation, scope: Object.freeze({ ...scope }) })
  return capability
}
export async function bindRuntimeStore(
  installation: PostgresRuntimeInstallation,
  capability: object,
  now: () => string = () => new Date().toISOString(),
) {
  const binding = bindings.get(capability)
  if (!binding || binding.installation !== installation)
    throw new Error("Unrecognized internal runtime binding")
  const context = installationContext(installation)
  const { scope } = binding
  assertRuntimeWriteEntry(installation, scope)
  context.pending++
  try {
    await withTransaction(context.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `b4:runtime:bind:${installation.installationId}:${scope.threadId}`,
      ])
      const name = table(context.naming, "scopes")
      const result = await client.query<{ fence: string; deleted: number; live: boolean }>(
        `SELECT fence,deleted,lease_expires_at>clock_timestamp() AS live FROM ${name} WHERE thread_id=$1 AND generation=$2 FOR UPDATE`,
        [scope.threadId, scope.generation],
      )
      const row = result.rows[0]
      if (!row) {
        if (scope.fence !== 1)
          throw diagnostic("stale_fence", "New runtime scope must start at fence 1")
        await client.query(
          `INSERT INTO ${name}(thread_id,generation,fence,lease_expires_at) VALUES ($1,$2,1,clock_timestamp()+interval '60 seconds')`,
          [scope.threadId, scope.generation],
        )
      } else if (Number(row.fence) !== scope.fence || row.deleted !== 0 || !row.live)
        throw diagnostic("stale_fence", "Runtime binding is stale")
    })
  } finally {
    context.pending--
  }
  return makeRuntimeStore(installation, scope, now)
}
