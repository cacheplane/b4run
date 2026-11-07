import { randomUUID } from "node:crypto"
import type {
  RuntimeRetainedRun,
  RuntimeRetainedSubject,
  RuntimeStorageFactory,
  RuntimeThreadRecord,
} from "@b4run/sdk/agent-protocol"
import { withTransaction } from "../internal/tx.js"
import type { PostgresRuntimeOptions } from "../options.js"
import { bindRuntimeStore, createRuntimeBinding } from "./binding.js"
import { installationContext } from "./index.js"
import { openPostgresRuntimeInstallation } from "./node.js"
import { table } from "./schema.js"
import { assertRuntimeHostEntry, diagnostic, makeRuntimeStore } from "./transaction.js"

/** Node-only trusted boot registration; PG's root edge graph never loads it. */
export function postgresRuntimeStorage(options: PostgresRuntimeOptions): RuntimeStorageFactory {
  return async (register) => {
    const installation = await openPostgresRuntimeInstallation(options)
    const context = installationContext(installation)
    const name = (value: string) => table(context.naming, value)
    const active = async <T>(callback: () => Promise<T>): Promise<T> => {
      assertRuntimeHostEntry(installation)
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
    const authSubject = (row: RuntimeThreadRecord): RuntimeRetainedSubject => {
      const { thread_id, created_at, updated_at, status, metadata } = row.thread
      return {
        thread: { thread_id, created_at, updated_at, status, metadata },
        protectedMetadata:
          row.protectedMetadata.provenance === undefined
            ? {}
            : { provenance: row.protectedMetadata.provenance },
      }
    }
    const retainedRun = (row: {
      thread_id: string
      generation: string
      subject: string
      payload: string
      retained_at: string
      retained_until: string
    }): RuntimeRetainedRun => ({
      scope: { threadId: row.thread_id, generation: row.generation },
      subject: JSON.parse(row.subject),
      record: JSON.parse(row.payload),
      retainedAt: row.retained_at,
      retainedUntil: row.retained_until,
    })
    try {
      return register({
        installationId: installation.installationId,
        close: () => installation.close(),
        findRun: (id) =>
          active(async () => {
            const rows = await context.pool.query<{
              thread_id: string
              generation: string
              subject: string
              payload: string
              location: "live" | "retained"
            }>(
              `SELECT r.thread_id,r.generation,t.payload AS subject,r.payload,'live' AS location FROM ${name("runs")} r JOIN ${name("scopes")} s USING(thread_id,generation) JOIN ${name("threads")} t USING(thread_id,generation) WHERE r.id=$1 AND s.deleted=0 UNION ALL SELECT r.thread_id,r.generation,s.payload AS subject,r.payload,'retained' AS location FROM ${name("retained_runs")} r JOIN ${name("retained_subjects")} s USING(thread_id,generation) WHERE r.id=$1`,
              [id],
            )
            const row = rows.rows[0]
            if (!row) return undefined
            const agentId = JSON.parse(row.payload).run.agent_id
            return typeof agentId === "string"
              ? {
                  scope: { threadId: row.thread_id, generation: row.generation },
                  subject:
                    row.location === "live"
                      ? authSubject(JSON.parse(row.subject))
                      : JSON.parse(row.subject),
                  agentId,
                  location: row.location,
                }
              : undefined
          }),
        temporary: {
          candidates: () =>
            active(async () => {
              const rows = await context.pool.query<{ thread: string; run: string }>(
                `SELECT t.payload AS thread,r.payload AS run FROM ${name("threads")} t JOIN ${name("scopes")} s USING(thread_id,generation) JOIN ${name("runs")} r ON r.id=t.current_run_id WHERE s.deleted=0 AND s.execution_owner IS NULL`,
              )
              return rows.rows.flatMap((row) => {
                const t = JSON.parse(row.thread) as RuntimeThreadRecord,
                  r = JSON.parse(row.run)
                return t.cleanupIntent?.onCompletion === "delete" &&
                  !t.pausedGeneration &&
                  r.unwoundAt &&
                  r.metadata.phase === "settled" &&
                  r.metadata.continuation === "closed"
                  ? [
                      {
                        threadId: t.thread.thread_id,
                        generation: t.generation,
                        runId: r.run.run_id,
                        headCheckpointId: t.headCheckpointId,
                        cleanupIntentId: t.cleanupIntent.intentId,
                      },
                    ]
                  : []
              })
            }),
          finalize: (plan) =>
            active(async () => {
              const rows = await context.pool.query<{ fence: string }>(
                `SELECT fence FROM ${name("scopes")} WHERE thread_id=$1 AND generation=$2 AND deleted=0`,
                [plan.threadId, plan.generation],
              )
              const row = rows.rows[0]
              if (!row) return false
              try {
                return await makeRuntimeStore(
                  installation,
                  {
                    threadId: plan.threadId,
                    generation: plan.generation,
                    fence: Number(row.fence),
                  },
                  () => new Date().toISOString(),
                ).finalizeTemporary(plan)
              } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "stale_fence")
                  return false
                throw error
              }
            }),
          readRun: (id) =>
            active(async () => {
              const rows = await context.pool.query<Parameters<typeof retainedRun>[0]>(
                `SELECT r.*,s.payload AS subject FROM ${name("retained_runs")} r JOIN ${name("retained_subjects")} s USING(thread_id,generation) WHERE r.id=$1`,
                [id],
              )
              return rows.rows[0] ? retainedRun(rows.rows[0]) : undefined
            }),
          listRuns: () =>
            active(async () => {
              const rows = await context.pool.query<Parameters<typeof retainedRun>[0]>(
                `SELECT r.*,s.payload AS subject FROM ${name("retained_runs")} r JOIN ${name("retained_subjects")} s USING(thread_id,generation) ORDER BY r.id`,
              )
              return rows.rows.map(retainedRun)
            }),
          readOperation: (query) =>
            active(async () => {
              const rows = await context.pool.query<{
                receipt: string
                subject: string
                run: string | null
              }>(
                `SELECT r.payload AS receipt,s.payload AS subject,u.payload AS run FROM ${name("receipts")} r JOIN ${name("retained_subjects")} s USING(thread_id,generation) LEFT JOIN ${name("retained_runs")} u ON u.id=(r.payload::jsonb)->'receipt'->>'runId' AND u.thread_id=r.thread_id AND u.generation=r.generation WHERE r.id=$1 AND r.thread_id=$2 AND r.generation=$3`,
                [query.receiptId, query.threadId, query.generation],
              )
              const row = rows.rows[0]
              return row
                ? {
                    scope: { threadId: query.threadId, generation: query.generation },
                    subject: JSON.parse(row.subject),
                    receipt: JSON.parse(row.receipt),
                    run: row.run ? JSON.parse(row.run) : undefined,
                  }
                : undefined
            }),
        },
        execution: {
          controlProgress: (scope, id, runId) =>
            active(async () => {
              const rows = await context.pool.query<{
                control: string
                run: string
                thread: string | null
              }>(
                `SELECT i.payload AS control,r.payload AS run,t.payload AS thread FROM ${name("inbox")} i JOIN ${name("runs")} r ON r.id=i.owner_run_id LEFT JOIN ${name("threads")} t ON t.thread_id=i.thread_id AND t.generation=i.generation WHERE i.id=$1 AND i.thread_id=$2 AND i.generation=$3`,
                [id, scope.threadId, scope.generation],
              )
              const row = rows.rows[0]
              if (!row) {
                const retained = await context.pool.query<{ payload: string }>(
                  `SELECT payload FROM ${name("retained_runs")} WHERE id=$1 AND thread_id=$2 AND generation=$3`,
                  [runId, scope.threadId, scope.generation],
                )
                if (!retained.rows[0]) return "uncertain"
                const proof = JSON.parse(retained.rows[0].payload)
                return proof.unwoundAt && !proof.ownershipLoss ? "completed" : "uncertain"
              }
              const c = JSON.parse(row.control),
                r = JSON.parse(row.run),
                t = row.thread ? JSON.parse(row.thread) : undefined
              if (c.runId !== runId) return "uncertain"
              return r.ownershipLoss || r.metadata.reason === "execution_lost"
                ? "uncertain"
                : c.status === "accepted" ||
                    (!!r.metadata.startedAt &&
                      !r.unwoundAt &&
                      r.metadata.reason !== "execution_lost") ||
                    (t?.currentRunId === c.runId && t.cleanupIntent?.onCompletion === "delete")
                  ? "pending"
                  : "completed"
            }),
          listCandidates: () =>
            active(async () => {
              const result = await context.pool.query<{ thread_id: string }>(
                `SELECT DISTINCT t.thread_id FROM ${name("threads")} t JOIN ${name("scopes")} s USING(thread_id,generation) JOIN ${name("runs")} r ON r.id=t.current_run_id WHERE s.deleted=0 AND (s.execution_owner IS NOT NULL OR (r.payload::jsonb)->'metadata'->>'phase'!='settled') ORDER BY t.thread_id`,
              )
              return result.rows.map((row) => row.thread_id)
            }),
          claim: (id, ownerId, callback) =>
            active(async () => {
              const result = await context.pool.query<{ generation: string; fence: string }>(
                `SELECT generation,fence FROM ${name("scopes")} WHERE thread_id=$1 AND deleted=0`,
                [id],
              )
              const row = result.rows[0]
              if (!row) return undefined
              return makeRuntimeStore(
                installation,
                { threadId: id, generation: row.generation, fence: Number(row.fence) },
                () => new Date().toISOString(),
              ).claimExecution(ownerId, callback)
            }),
        },
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
              retained_subject: string | null
            }>(
              `SELECT r.id,r.thread_id,r.generation,s.fence,t.payload AS thread,a.payload AS retained_subject,(r.payload::jsonb)->'operation'->'resolved'->>'agent_id' AS agent_id,(r.payload::jsonb)->'operation'->'provenance' AS provenance FROM ${name("receipts")} r JOIN ${name("scopes")} s USING(thread_id,generation) LEFT JOIN ${name("threads")} t USING(thread_id,generation) LEFT JOIN ${name("retained_subjects")} a USING(thread_id,generation) WHERE ${conditions.join(" AND ")} ORDER BY r.id`,
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
              ...(row.retained_subject
                ? { retainedSubject: JSON.parse(row.retained_subject) }
                : {}),
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
                execution_owner: string | null
                live: boolean
              }>(
                `SELECT thread_id,generation,fence,execution_owner,lease_expires_at>clock_timestamp() AS live FROM ${name("scopes")} WHERE thread_id=$1 AND deleted=0 FOR UPDATE`,
                [id],
              )
              const existing = rows.rows[0]
              if (existing) {
                if (!existing.live) {
                  if (existing.execution_owner)
                    throw diagnostic(
                      "storage_unavailable",
                      "Expired execution ownership awaits durable reconciliation",
                    )
                  return { ...existing, renewIdle: true as const }
                }
                return existing
              }
              if (!create) return undefined
              const generation = randomUUID()
              await client.query(
                `INSERT INTO ${name("scopes")}(thread_id,generation,fence,lease_expires_at) VALUES ($1,$2,1,clock_timestamp()+interval '60 seconds')`,
                [id, generation],
              )
              return { thread_id: id, generation, fence: "1" }
            })
            if (!scope) return undefined
            if ("renewIdle" in scope && scope.renewIdle) {
              // Do not hold the binding transaction/row lock while waiting on
              // inspection unwind. The existing fenced transition owns scope
              // exclusion and rechecks generation/fence/unowned/expired facts.
              try {
                return await makeRuntimeStore(
                  installation,
                  {
                    threadId: scope.thread_id,
                    generation: scope.generation,
                    fence: Number(scope.fence),
                  },
                  () => new Date().toISOString(),
                ).renewIdleScope()
              } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "stale_fence")
                  throw diagnostic(
                    "storage_unavailable",
                    "Runtime scope changed during idle renewal; retry",
                  )
                throw error
              }
            }
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
