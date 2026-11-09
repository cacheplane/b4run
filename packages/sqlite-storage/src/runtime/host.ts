import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import type {
  RuntimeOperationSearch,
  RuntimeRetainedRun,
  RuntimeRetainedSubject,
  RuntimeStorageFactory,
  RuntimeThreadRecord,
} from "@b4run/sdk/agent-protocol"
import { bindRuntimeStore, createRuntimeBinding } from "./binding.js"
import { installationContext, openRuntimeInstallation } from "./index.js"
import { assertRuntimeQueueEntry, makeRuntimeStore, runtimeBindingTurn } from "./transaction.js"

/** One installation registered with a trusted execution host at boot. No
 * package-exported scope binder and no request-controlled authorization hook. */
export function sqliteRuntimeStorage(
  appRoot: string,
  options: { readonly replicas?: number; readonly workers?: number } = {},
): RuntimeStorageFactory {
  return (register) => {
    const installation = openRuntimeInstallation(appRoot, options)
    // Discovery reads committed state even while an asynchronous writer is
    // suspended; never inspect the writer connection's uncommitted records.
    const read = <T>(callback: (db: DatabaseSync) => T): T => {
      const context = installationContext(installation)
      const db = new DatabaseSync(installation.path, { readOnly: true })
      context.readers.add(db)
      try {
        return callback(db)
      } finally {
        context.readers.delete(db)
        db.close()
      }
    }
    const thread = (
      db: DatabaseSync,
      id: string,
      generation?: string,
    ): RuntimeThreadRecord | undefined => {
      const row =
        generation === undefined
          ? db
              .prepare(
                "SELECT t.payload FROM threads t JOIN scopes s USING(thread_id,generation) WHERE t.thread_id=? AND s.deleted=0",
              )
              .get(id)
          : db
              .prepare("SELECT payload FROM threads WHERE thread_id=? AND generation=?")
              .get(id, generation)
      return row ? JSON.parse(String(row.payload)) : undefined
    }
    const waitForWriter = async (id: string, selectedGeneration?: string): Promise<void> => {
      const context = installationContext(installation)
      // Reject self-tail reentry before waiting. Committed generation discovery
      // supplies only a queue key; the canonical scope is reread after waiting.
      assertRuntimeQueueEntry(installation)
      const generation =
        selectedGeneration ??
        read(
          (db) =>
            db.prepare("SELECT generation FROM scopes WHERE thread_id=? AND deleted=0").get(id)
              ?.generation,
        )
      if (generation !== undefined)
        assertRuntimeQueueEntry(installation, JSON.stringify([id, String(generation)]))
      await context.tail
    }
    const permissionResponseFacts = `COALESCE((SELECT json_group_array(json_object('runId',json_extract(a.payload,'$.receipt.runId'),'turnId',json_extract(a.payload,'$.receipt.turnId'),'operationThreadId',json_extract(a.payload,'$.operation.operationThreadId'),'targetRunId',json_extract(a.payload,'$.operation.targetRunId'),'permissionAgents',json_extract(a.payload,'$.operation.resolved.permissionAgents'))) FROM receipts a WHERE a.owner_run_id=r.id AND a.thread_id=r.thread_id AND a.generation=r.generation AND json_extract(a.payload,'$.operation.method')='input.respond'),'[]') AS permission_responses, COALESCE((SELECT json_group_array(DISTINCT json_object('runId',json_extract(a.payload,'$.receipt.runId'),'turnId',json_extract(a.payload,'$.receipt.turnId'),'operationThreadId',json_extract(a.payload,'$.operation.operationThreadId'),'targetRunId',json_extract(a.payload,'$.operation.targetRunId'),'permissionAgents',json_extract(a.payload,'$.operation.resolved.permissionAgents'),'namespace',json_extract(a.payload,'$.operation.resolved.namespace'),'namespaceGeneration',json_extract(a.payload,'$.operation.resolved.namespaceGeneration'),'injectionAgent',json_extract(a.payload,'$.operation.resolved.injectionAgent'))) FROM receipts a WHERE a.owner_run_id=r.id AND a.thread_id=r.thread_id AND a.generation=r.generation AND json_extract(a.payload,'$.operation.method')='input.inject'),'[]') AS input_injections`
    const namespaceBindings = `COALESCE((SELECT json_group_array(json(n.payload)) FROM aliases n WHERE n.run_id=r.id AND n.thread_id=r.thread_id AND n.generation=r.generation AND n.id LIKE 'namespace:%'),'[]') AS namespace_bindings`
    const nativeNamespaceProofs = `COALESCE((SELECT json_group_array(json_object('v',json_extract(n.payload,'$.v'),'kind',json_extract(n.payload,'$.kind'),'runId',n.run_id,'namespace',json(n.namespace),'agentId',json_extract(n.payload,'$.agentId'),'namespaceGeneration',json_extract(n.payload,'$.namespaceGeneration'),'parentCheckpointId',json_extract(n.payload,'$.parentCheckpointId'),'source',json_extract(n.payload,'$.source'))) FROM aliases n WHERE n.run_id=r.id AND n.thread_id=r.thread_id AND n.generation=r.generation AND n.id LIKE 'namespace:%'),'[]')`
    const protectedSourceRecords = `COALESCE((SELECT json_group_array(json(p.payload)) FROM aliases p WHERE p.run_id=r.id AND p.thread_id=r.thread_id AND p.generation=r.generation AND p.id LIKE 'source:%'),'[]')`
    const protectedSourceReference = `(SELECT json_extract(c.payload,'$.operation.protectedSource') FROM receipts c WHERE c.owner_run_id=r.id AND c.thread_id=r.thread_id AND c.generation=r.generation AND json_extract(c.payload,'$.operation.method') IN ('run.create','input.respond') LIMIT 1)`
    const protectedSourceFacts = `json_object('reference',json(${protectedSourceReference}),'records',json(${protectedSourceRecords}))`
    const operationSourceRecords = protectedSourceRecords.replace(
      "p.run_id=r.id",
      "p.run_id=json_extract(r.payload,'$.receipt.runId')",
    )
    const operationNamespaceProofs = nativeNamespaceProofs.replace(
      "n.run_id=r.id",
      "n.run_id=json_extract(r.payload,'$.receipt.runId')",
    )
    const canonicalRunAuthority = `(SELECT json_object('turnId',json_extract(c.payload,'$.receipt.turnId'),'previousRunId',CASE WHEN json_extract(c.payload,'$.operation.method')='input.respond' THEN json_extract(c.payload,'$.operation.targetRunId') ELSE NULL END,'protectedSource',json_object('reference',json(json_extract(c.payload,'$.operation.protectedSource')),'records',json(${operationSourceRecords})),'nativeNamespaces',json(${operationNamespaceProofs}),'permissionResponses',json(COALESCE((SELECT json_group_array(json_object('runId',json_extract(a.payload,'$.receipt.runId'),'turnId',json_extract(a.payload,'$.receipt.turnId'),'operationThreadId',json_extract(a.payload,'$.operation.operationThreadId'),'targetRunId',json_extract(a.payload,'$.operation.targetRunId'),'permissionAgents',json_extract(a.payload,'$.operation.resolved.permissionAgents'))) FROM receipts a WHERE a.owner_run_id=json_extract(r.payload,'$.receipt.runId') AND a.thread_id=r.thread_id AND a.generation=r.generation AND json_extract(a.payload,'$.operation.method')='input.respond'),'[]')),'inputInjections',json(COALESCE((SELECT json_group_array(DISTINCT json_object('runId',json_extract(a.payload,'$.receipt.runId'),'turnId',json_extract(a.payload,'$.receipt.turnId'),'operationThreadId',json_extract(a.payload,'$.operation.operationThreadId'),'targetRunId',json_extract(a.payload,'$.operation.targetRunId'),'permissionAgents',json_extract(a.payload,'$.operation.resolved.permissionAgents'),'namespace',json_extract(a.payload,'$.operation.resolved.namespace'),'namespaceGeneration',json_extract(a.payload,'$.operation.resolved.namespaceGeneration'),'injectionAgent',json_extract(a.payload,'$.operation.resolved.injectionAgent'))) FROM receipts a WHERE a.owner_run_id=json_extract(r.payload,'$.receipt.runId') AND a.thread_id=r.thread_id AND a.generation=r.generation AND json_extract(a.payload,'$.operation.method')='input.inject'),'[]'))) FROM receipts c WHERE c.owner_run_id=json_extract(r.payload,'$.receipt.runId') AND c.thread_id=r.thread_id AND c.generation=r.generation AND json_extract(c.payload,'$.operation.method') IN ('run.create','input.respond') AND (SELECT COUNT(DISTINCT json_object('method',json_extract(c2.payload,'$.operation.method'),'turnId',json_extract(c2.payload,'$.receipt.turnId'),'threadId',json_extract(c2.payload,'$.operation.operationThreadId'),'targetRunId',json_extract(c2.payload,'$.operation.targetRunId'))) FROM receipts c2 WHERE c2.owner_run_id=json_extract(r.payload,'$.receipt.runId') AND c2.thread_id=r.thread_id AND c2.generation=r.generation AND json_extract(c2.payload,'$.operation.method') IN ('run.create','input.respond'))=1 LIMIT 1)`
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
    const retainedRun = (row: Record<string, unknown>): RuntimeRetainedRun => ({
      scope: { threadId: String(row.thread_id), generation: String(row.generation) },
      subject: JSON.parse(String(row.subject)),
      record: JSON.parse(String(row.payload)),
      retainedAt: String(row.retained_at),
      retainedUntil: String(row.retained_until),
    })
    try {
      return register({
        installationId: installation.installationId,
        close: () => installation.close(),
        async findRun(id) {
          return read((db) => {
            const row = db
              .prepare(
                `SELECT r.thread_id,r.generation,r.payload,t.payload AS subject,'live' AS location,${permissionResponseFacts},${namespaceBindings},${nativeNamespaceProofs} AS native_namespaces,${protectedSourceFacts} AS protected_source FROM runs r JOIN scopes s USING(thread_id,generation) JOIN threads t USING(thread_id,generation) WHERE r.id=? AND s.deleted=0 UNION ALL SELECT r.thread_id,r.generation,r.payload,s.payload AS subject,'retained' AS location,${permissionResponseFacts},${namespaceBindings},${nativeNamespaceProofs} AS native_namespaces,${protectedSourceFacts} AS protected_source FROM retained_runs r JOIN retained_subjects s USING(thread_id,generation) WHERE r.id=?`,
              )
              .get(id, id)
            if (!row) return undefined
            const record = JSON.parse(String(row.payload)),
              agentId = record.run.agent_id
            return typeof agentId === "string"
              ? {
                  scope: { threadId: String(row.thread_id), generation: String(row.generation) },
                  subject:
                    row.location === "live"
                      ? authSubject(JSON.parse(String(row.subject)))
                      : JSON.parse(String(row.subject)),
                  agentId,
                  location: row.location === "live" ? ("live" as const) : ("retained" as const),
                  namespaceBindings: JSON.parse(String(row.namespace_bindings)),
                  authority: {
                    turnId: record.metadata.turnId,
                    previousRunId: record.metadata.previousRunId ?? null,
                    permissionResponses: JSON.parse(String(row.permission_responses)),
                    inputInjections: JSON.parse(String(row.input_injections)),
                    nativeNamespaces: JSON.parse(String(row.native_namespaces)),
                    protectedSource: JSON.parse(String(row.protected_source)),
                  },
                }
              : undefined
          })
        },
        temporary: {
          async candidates() {
            return read((db) =>
              db
                .prepare(
                  "SELECT t.payload AS thread,r.payload AS run FROM threads t JOIN scopes s USING(thread_id,generation) JOIN runs r ON r.id=t.current_run_id WHERE s.deleted=0 AND s.execution_owner IS NULL",
                )
                .all()
                .flatMap((row) => {
                  const t = JSON.parse(String(row.thread)) as RuntimeThreadRecord,
                    r = JSON.parse(String(row.run))
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
                }),
            )
          },
          async finalize(plan) {
            await waitForWriter(plan.threadId, plan.generation)
            const scope = read((db) =>
              db
                .prepare(
                  "SELECT generation,fence FROM scopes WHERE thread_id=? AND generation=? AND deleted=0",
                )
                .get(plan.threadId, plan.generation),
            )
            if (!scope) return false
            try {
              return await makeRuntimeStore(
                installation,
                {
                  threadId: plan.threadId,
                  generation: plan.generation,
                  fence: Number(scope.fence),
                },
                () => new Date().toISOString(),
              ).finalizeTemporary(plan)
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "stale_fence")
                return false
              throw error
            }
          },
          async readRun(id) {
            return read((db) => {
              const row = db
                .prepare(
                  "SELECT r.*,s.payload AS subject FROM retained_runs r JOIN retained_subjects s USING(thread_id,generation) WHERE r.id=?",
                )
                .get(id)
              return row ? retainedRun(row) : undefined
            })
          },
          async listRuns() {
            return read((db) =>
              db
                .prepare(
                  "SELECT r.*,s.payload AS subject FROM retained_runs r JOIN retained_subjects s USING(thread_id,generation) ORDER BY r.id",
                )
                .all()
                .map(retainedRun),
            )
          },
          async readOperation(query) {
            return read((db) => {
              const row = db
                .prepare(
                  `SELECT r.payload AS receipt,s.payload AS subject,u.payload AS run,${canonicalRunAuthority} AS run_authority FROM receipts r JOIN retained_subjects s USING(thread_id,generation) LEFT JOIN retained_runs u ON u.id=json_extract(r.payload,'$.receipt.runId') AND u.thread_id=r.thread_id AND u.generation=r.generation WHERE r.id=? AND r.thread_id=? AND r.generation=?`,
                )
                .get(query.receiptId, query.threadId, query.generation)
              return row
                ? {
                    scope: { threadId: query.threadId, generation: query.generation },
                    subject: JSON.parse(String(row.subject)),
                    receipt: JSON.parse(String(row.receipt)),
                    run: row.run ? JSON.parse(String(row.run)) : undefined,
                    runAuthority: row.run_authority ? JSON.parse(String(row.run_authority)) : null,
                  }
                : undefined
            })
          },
        },
        execution: {
          async controlProgress(scope, id, runId) {
            return read((db) => {
              const row = db
                .prepare(
                  "SELECT i.payload AS control,r.payload AS run,t.payload AS thread FROM inbox i JOIN runs r ON r.id=i.owner_run_id LEFT JOIN threads t USING(thread_id,generation) WHERE i.id=? AND i.thread_id=? AND i.generation=?",
                )
                .get(id, scope.threadId, scope.generation)
              if (!row) {
                const retained = db
                  .prepare(
                    "SELECT payload FROM retained_runs WHERE id=? AND thread_id=? AND generation=?",
                  )
                  .get(runId, scope.threadId, scope.generation)
                if (!retained) return "uncertain"
                const proof = JSON.parse(String(retained.payload))
                if (proof.ownershipLoss || proof.metadata.reason === "execution_lost")
                  return "execution_lost"
                return proof.unwoundAt ? "completed" : "uncertain"
              }
              const c = JSON.parse(String(row.control)),
                r = JSON.parse(String(row.run)),
                t = row.thread ? JSON.parse(String(row.thread)) : undefined
              if (c.runId !== runId) return "uncertain"
              return r.ownershipLoss || r.metadata.reason === "execution_lost"
                ? "execution_lost"
                : c.status === "accepted" ||
                    (!!r.metadata.startedAt &&
                      !r.unwoundAt &&
                      r.metadata.reason !== "execution_lost") ||
                    (t?.currentRunId === c.runId && t.cleanupIntent?.onCompletion === "delete")
                  ? "pending"
                  : "completed"
            })
          },
          async listCandidates() {
            return read((db) =>
              db
                .prepare(
                  "SELECT DISTINCT t.thread_id FROM threads t JOIN scopes s USING(thread_id,generation) JOIN runs r ON r.id=t.current_run_id WHERE s.deleted=0 AND (s.execution_owner IS NOT NULL OR json_extract(r.payload,'$.metadata.phase')!='settled') ORDER BY t.thread_id",
                )
                .all()
                .map((row) => String(row.thread_id)),
            )
          },
          async claim(id, ownerId, callback) {
            await waitForWriter(id)
            const scope = read((db) =>
              db
                .prepare("SELECT generation,fence FROM scopes WHERE thread_id=? AND deleted=0")
                .get(id),
            )
            if (!scope) return undefined
            try {
              return await makeRuntimeStore(
                installation,
                { threadId: id, generation: String(scope.generation), fence: Number(scope.fence) },
                () => new Date().toISOString(),
              ).claimExecution(ownerId, callback)
            } catch (error) {
              // Concurrent same-process claims may have selected the same cut.
              if (error instanceof Error && "code" in error && error.code === "stale_fence")
                return undefined
              throw error
            }
          },
        },
        async readThread(id) {
          return read((db) => thread(db, id))
        },
        async listThreads() {
          return read((db) =>
            db
              .prepare(
                "SELECT t.payload FROM threads t JOIN scopes s USING(thread_id,generation) WHERE s.deleted=0 ORDER BY t.thread_id",
              )
              .all()
              .map((row) => JSON.parse(String(row.payload))),
          )
        },
        async searchOperations(query: RuntimeOperationSearch) {
          return read((db) => {
            const fields = [
              "json_extract(r.payload,'$.operation.scopeKey')=?",
              "json_extract(r.payload,'$.receipt.submissionId')=?",
              "json_extract(r.payload,'$.receipt.submissionKind')=?",
            ]
            const values = [query.scopeKey, query.submissionId, query.submissionKind]
            for (const key of ["operationThreadId", "targetRunId", "method"] as const) {
              const value = query[key]
              if (value !== undefined) {
                fields.push(`json_extract(r.payload,'$.operation.${key}')=?`)
                values.push(value)
              }
            }
            return db
              .prepare(
                `SELECT r.id,r.thread_id,r.generation,s.fence,t.payload AS thread,a.payload AS retained_subject,json_object('runId',json_extract(r.payload,'$.receipt.runId'),'turnId',json_extract(r.payload,'$.receipt.turnId'),'method',json_extract(r.payload,'$.operation.method'),'operationThreadId',json_extract(r.payload,'$.operation.operationThreadId'),'targetRunId',json_extract(r.payload,'$.operation.targetRunId'),'permissionAgents',json_extract(r.payload,'$.operation.resolved.permissionAgents'),'namespace',json_extract(r.payload,'$.operation.resolved.namespace'),'namespaceGeneration',json_extract(r.payload,'$.operation.resolved.namespaceGeneration'),'injectionAgent',json_extract(r.payload,'$.operation.resolved.injectionAgent'),'runAuthority',json(${canonicalRunAuthority})) AS operation_authority,json_extract(r.payload,'$.operation.resolved.agent_id') AS agent_id,json_extract(r.payload,'$.operation.provenance') AS provenance FROM receipts r JOIN scopes s USING(thread_id,generation) LEFT JOIN threads t USING(thread_id,generation) LEFT JOIN retained_subjects a USING(thread_id,generation) WHERE ${fields.join(" AND ")} ORDER BY r.id`,
              )
              .all(...values)
              .map((row) => ({
                receiptId: String(row.id),
                operationAuthority: JSON.parse(String(row.operation_authority)),
                ...(typeof row.agent_id === "string" ? { agentId: row.agent_id } : {}),
                ...(typeof row.provenance === "string"
                  ? { provenance: JSON.parse(row.provenance) }
                  : {}),
                scope: {
                  threadId: String(row.thread_id),
                  generation: String(row.generation),
                  fence: Number(row.fence),
                },
                thread: row.thread ? JSON.parse(String(row.thread)) : undefined,
                ...(row.retained_subject
                  ? { retainedSubject: JSON.parse(String(row.retained_subject)) }
                  : {}),
              }))
          })
        },
        async openThread(id, create, expectedGeneration) {
          if (expectedGeneration !== undefined && create) return undefined
          // A synchronous canonical generation selection cannot race a pending
          // same-process bind. SQLite itself is single execution-owner only.
          let scope = read((db) =>
            db
              .prepare(
                "SELECT thread_id,generation,fence FROM scopes WHERE thread_id=? AND deleted=0",
              )
              .get(id),
          )
          if (expectedGeneration !== undefined && scope?.generation !== expectedGeneration)
            return undefined
          if (!scope && !create) return undefined
          if (!scope) scope = { thread_id: id, generation: randomUUID(), fence: 1 }
          return runtimeBindingTurn(
            installation,
            JSON.stringify([id, String(scope.generation)]),
            () => {
              let canonical = read((db) =>
                db
                  .prepare(
                    "SELECT thread_id,generation,fence FROM scopes WHERE thread_id=? AND deleted=0",
                  )
                  .get(id),
              )
              if (expectedGeneration !== undefined && canonical?.generation !== expectedGeneration)
                return undefined
              if (!canonical && !create) return undefined
              if (!canonical) canonical = { thread_id: id, generation: randomUUID(), fence: 1 }
              return bindRuntimeStore(
                installation,
                createRuntimeBinding(installation, {
                  threadId: id,
                  generation: String(canonical.generation),
                  fence: Number(canonical.fence),
                }),
              )
            },
          )
        },
      })
    } catch (error) {
      installation.close()
      throw error
    }
  }
}
