import { randomUUID } from "node:crypto"
import type { RuntimeStorageFactory, RuntimeThreadRecord } from "@b4run/sdk/agent-protocol"
import { withTransaction } from "../internal/tx.js"
import type { PostgresRuntimeOptions } from "../options.js"
import { bindRuntimeStore, createRuntimeBinding } from "./binding.js"
import { installationContext } from "./index.js"
import { openPostgresRuntimeInstallation } from "./node.js"
import { table } from "./schema.js"

/** Node-only trusted boot registration; PG's root edge graph never loads it. */
export function postgresRuntimeStorage(options: PostgresRuntimeOptions): RuntimeStorageFactory {
  return async (register) => {
    const installation = await openPostgresRuntimeInstallation(options)
    const context = installationContext(installation)
    const name = (value: string) => table(context.naming, value)
    const active = async <T>(callback: () => Promise<T>): Promise<T> => {
      installationContext(installation)
      context.pending++
      try {
        return await callback()
      } finally {
        context.pending--
      }
    }
    const readThread = async (id: string): Promise<RuntimeThreadRecord | undefined> => {
      const rows = await context.pool.query<{ payload: string }>(
        `SELECT t.payload FROM ${name("threads")} t JOIN ${name("scopes")} s USING(thread_id,generation) WHERE t.thread_id=$1 AND s.deleted=0`,
        [id],
      )
      return rows.rows[0] ? JSON.parse(rows.rows[0].payload) : undefined
    }
    try {
      return register({
        installationId: installation.installationId,
        close: () => installation.close(),
        readThread: (id) => active(() => readThread(id)),
        listThreads: () =>
          active(async () => {
            const rows = await context.pool.query<{ payload: string }>(
              `SELECT t.payload FROM ${name("threads")} t JOIN ${name("scopes")} s USING(thread_id,generation) WHERE s.deleted=0 ORDER BY t.thread_id`,
            )
            return rows.rows.map((row) => JSON.parse(row.payload))
          }),
        searchOperations: (query) =>
          active(async () => {
            const values = [query.scopeKey, query.submissionId, query.submissionKind]
            const conditions = [
              "((r.payload::jsonb)->'operation'->>'scopeKey')=$1",
              "((r.payload::jsonb)->'receipt'->>'submissionId')=$2",
              "((r.payload::jsonb)->'receipt'->>'submissionKind')=$3",
            ]
            for (const key of ["operationThreadId", "targetRunId", "method"] as const) {
              const value = query[key]
              if (value !== undefined) {
                values.push(value)
                conditions.push(`((r.payload::jsonb)->'operation'->>'${key}')=$${values.length}`)
              }
            }
            const rows = await context.pool.query<{
              id: string
              thread_id: string
              generation: string
              fence: string
              thread: string | null
              agent_id: string | null
              provenance: Record<string, unknown> | null
            }>(
              `SELECT r.id,r.thread_id,r.generation,s.fence,t.payload AS thread,(r.payload::jsonb)->'operation'->'resolved'->>'agent_id' AS agent_id,(r.payload::jsonb)->'operation'->'provenance' AS provenance FROM ${name("receipts")} r JOIN ${name("scopes")} s USING(thread_id,generation) LEFT JOIN ${name("threads")} t USING(thread_id,generation) WHERE ${conditions.join(" AND ")} ORDER BY r.id`,
              values,
            )
            return rows.rows.map((row) => ({
              receiptId: row.id,
              ...(row.agent_id ? { agentId: row.agent_id } : {}),
              ...(row.provenance ? { provenance: row.provenance } : {}),
              scope: {
                threadId: row.thread_id,
                generation: row.generation,
                fence: Number(row.fence),
              },
              thread: row.thread ? JSON.parse(row.thread) : undefined,
            }))
          }),
        openThread: (id, create) =>
          active(async () => {
            const scope = await withTransaction(context.pool, async (client) => {
              await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
                `b4:runtime:bind:${installation.installationId}:${id}`,
              ])
              const rows = await client.query<{
                thread_id: string
                generation: string
                fence: string
              }>(
                `SELECT thread_id,generation,fence FROM ${name("scopes")} WHERE thread_id=$1 AND deleted=0 FOR UPDATE`,
                [id],
              )
              const existing = rows.rows[0]
              if (existing || !create) return existing
              const generation = randomUUID()
              await client.query(
                `INSERT INTO ${name("scopes")}(thread_id,generation,fence,lease_expires_at) VALUES ($1,$2,1,clock_timestamp()+interval '60 seconds')`,
                [id, generation],
              )
              return { thread_id: id, generation, fence: "1" }
            })
            if (!scope) return undefined
            return bindRuntimeStore(
              installation,
              createRuntimeBinding(installation, {
                threadId: scope.thread_id,
                generation: scope.generation,
                fence: Number(scope.fence),
              }),
            )
          }),
      })
    } catch (error) {
      await installation.close()
      throw error
    }
  }
}
