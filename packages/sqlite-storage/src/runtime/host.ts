import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import type {
  RuntimeOperationSearch,
  RuntimeStorageFactory,
  RuntimeThreadRecord,
} from "@b4run/sdk/agent-protocol"
import { bindRuntimeStore, createRuntimeBinding } from "./binding.js"
import { installationContext, openRuntimeInstallation } from "./index.js"
import { assertRuntimeQueueEntry, makeRuntimeStore } from "./transaction.js"

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
    try {
      return register({
        installationId: installation.installationId,
        close: () => installation.close(),
        execution: {
          async listCandidates() {
            return read((db) =>
              db
                .prepare(
                  "SELECT DISTINCT t.thread_id FROM threads t JOIN scopes s USING(thread_id,generation) JOIN runs r ON r.id=t.current_run_id WHERE s.deleted=0 AND json_extract(r.payload,'$.metadata.phase')!='settled' ORDER BY t.thread_id",
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
                `SELECT r.id,r.thread_id,r.generation,s.fence,json_extract(r.payload,'$.operation.resolved.agent_id') AS agent_id,json_extract(r.payload,'$.operation.provenance') AS provenance FROM receipts r JOIN scopes s USING(thread_id,generation) WHERE ${fields.join(" AND ")} ORDER BY r.id`,
              )
              .all(...values)
              .map((row) => ({
                receiptId: String(row.id),
                ...(typeof row.agent_id === "string" ? { agentId: row.agent_id } : {}),
                ...(typeof row.provenance === "string"
                  ? { provenance: JSON.parse(row.provenance) }
                  : {}),
                scope: {
                  threadId: String(row.thread_id),
                  generation: String(row.generation),
                  fence: Number(row.fence),
                },
                thread: thread(db, String(row.thread_id), String(row.generation)),
              }))
          })
        },
        async openThread(id, create) {
          // A synchronous canonical generation selection cannot race a pending
          // same-process bind. SQLite itself is single execution-owner only.
          let scope = read((db) =>
            db
              .prepare(
                "SELECT thread_id,generation,fence FROM scopes WHERE thread_id=? AND deleted=0",
              )
              .get(id),
          )
          if (!scope && !create) return undefined
          if (!scope) scope = { thread_id: id, generation: randomUUID(), fence: 1 }
          // If a transaction is active, wait through a harmless committed scope
          // read using its serialized queue rather than binding in its middle.
          await waitForWriter(id, String(scope.generation))
          const canonical =
            read((db) =>
              db
                .prepare(
                  "SELECT thread_id,generation,fence FROM scopes WHERE thread_id=? AND deleted=0",
                )
                .get(id),
            ) ?? scope
          return bindRuntimeStore(
            installation,
            createRuntimeBinding(installation, {
              threadId: id,
              generation: String(canonical.generation),
              fence: Number(canonical.fence),
            }),
          )
        },
      })
    } catch (error) {
      installation.close()
      throw error
    }
  }
}
