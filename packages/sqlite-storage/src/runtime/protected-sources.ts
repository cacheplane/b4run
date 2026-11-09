import type {
  RuntimeCheckpointRecord,
  RuntimeNamespaceRecord,
  RuntimePendingRecord,
  RuntimeProtectedSourceRecord,
  RuntimeReceiptRecord,
  RuntimeRecords,
  RuntimeRunRecord,
} from "@b4run/sdk/agent-protocol"
import {
  canonicalRuntimeValue,
  isProtectedSource,
  protectedSourceId,
  stoppedSourceMatchesRun,
} from "@b4run/sdk/internal/runtime-identity"
import { sha256Hex } from "@b4run/sdk/pure"
import { pendingKey, receiptSpec } from "./receipts.js"
import { type Access, diagnostic, requireSame } from "./transaction.js"

export function makeProtectedSources(
  access: Access,
  strictReads = false,
): RuntimeRecords<RuntimeProtectedSourceRecord> {
  const { db, scope } = access
  const fail = (): never => {
    throw diagnostic("scope_mismatch", "Invalid protected checkpoint source")
  }
  const decode = (row: Record<string, unknown>): RuntimeProtectedSourceRecord => {
    const record = JSON.parse(String(row.payload)) as RuntimeProtectedSourceRecord
    if (
      (strictReads && !isProtectedSource(record)) ||
      record.threadId !== scope.threadId ||
      record.generation !== scope.generation
    )
      fail()
    requireSame(record.aliasId, row.id)
    requireSame(record.runId, row.run_id)
    requireSame(row.namespace, "[]")
    return record
  }
  return {
    async get(id) {
      access.check()
      access.reference("aliases", id)
      const row = db
        .prepare(
          "SELECT id,run_id,namespace,payload FROM aliases WHERE id=? AND thread_id=? AND generation=? AND id LIKE 'source:%'",
        )
        .get(id, scope.threadId, scope.generation)
      return row ? decode(row) : undefined
    },
    async list() {
      access.check()
      return db
        .prepare(
          "SELECT id,run_id,namespace,payload FROM aliases WHERE thread_id=? AND generation=? AND id LIKE 'source:%' ORDER BY id",
        )
        .all(scope.threadId, scope.generation)
        .map(decode)
    },
    async put(record) {
      access.check()
      if (!isProtectedSource(record)) fail()
      decode({
        id: record.aliasId,
        run_id: record.runId,
        namespace: "[]",
        payload: JSON.stringify(record),
      })
      const old = await this.get(record.aliasId)
      if (old) {
        if (!isProtectedSource(old)) fail()
        requireSame(record, old)
        return
      }
      for (const id of [record.runId, record.sourceRunId]) access.reference("runs", id)
      for (const id of [record.preRunCheckpointId, record.sourceCheckpointId])
        access.reference("checkpoints", id)
      const targetRow = db
        .prepare("SELECT payload FROM runs WHERE id=? AND thread_id=? AND generation=?")
        .get(record.runId, scope.threadId, scope.generation)
      const sourceRow = db
        .prepare("SELECT payload FROM runs WHERE id=? AND thread_id=? AND generation=?")
        .get(record.sourceRunId, scope.threadId, scope.generation)
      const selected = db
        .prepare(
          "SELECT payload,owner_run_id,namespace FROM checkpoints WHERE id=? AND thread_id=? AND generation=?",
        )
        .get(record.preRunCheckpointId, scope.threadId, scope.generation)
      const origin = db
        .prepare(
          "SELECT owner_run_id,namespace FROM checkpoints WHERE id=? AND thread_id=? AND generation=?",
        )
        .get(record.sourceCheckpointId, scope.threadId, scope.generation)
      const current = db
        .prepare(
          "SELECT t.payload,s.execution_owner FROM threads t JOIN scopes s USING(thread_id,generation) WHERE t.thread_id=? AND t.generation=?",
        )
        .get(scope.threadId, scope.generation)
      const target = targetRow ? JSON.parse(String(targetRow.payload)) : undefined,
        source = sourceRow ? JSON.parse(String(sourceRow.payload)) : undefined
      const thread = current ? JSON.parse(String(current.payload)) : undefined,
        head = selected ? JSON.parse(String(selected.payload)) : undefined
      if (
        !target ||
        !source ||
        !thread ||
        target.metadata.phase !== "accepted" ||
        target.preRunCheckpointId !== record.preRunCheckpointId ||
        thread.headCheckpointId !== record.preRunCheckpointId ||
        current?.execution_owner !== null ||
        record.sourceRunId === record.runId ||
        source.metadata.phase !== "settled" ||
        source.metadata.continuation !== "closed" ||
        !selected ||
        !origin ||
        selected.namespace !== "[]" ||
        origin.namespace !== "[]" ||
        origin.owner_run_id !== record.checkpointOwnerRunId
      )
        fail()
      if (selected!.owner_run_id === null) {
        if (
          head.payload?.safeHead !== true ||
          head.payload.reboundFrom?.runId !== record.sourceRunId ||
          head.payload.reboundFrom?.checkpointId !== record.sourceCheckpointId ||
          head.payload.reboundFrom?.checkpointOwnerRunId !== record.checkpointOwnerRunId
        )
          fail()
      } else if (
        selected!.owner_run_id !== record.sourceRunId ||
        record.preRunCheckpointId !== record.sourceCheckpointId ||
        source.metadata.reason !== "completed"
      )
        fail()
      requireSame(head.payload?.reboundFrom?.stoppedSource ?? null, record.stoppedSource)
      if (record.stoppedSource) {
        const proof = record.stoppedSource
        const read = async <T>(
          table: "runs" | "receipts" | "checkpoints" | "aliases" | "pending",
          id: string,
        ): Promise<T | undefined> => {
          const found = db
            .prepare(`SELECT payload FROM ${table} WHERE id=? AND thread_id=? AND generation=?`)
            .get(id, scope.threadId, scope.generation)
          return found ? (JSON.parse(String(found.payload)) as T) : undefined
        }
        if (
          selected!.owner_run_id !== null ||
          !stoppedSourceMatchesRun(proof, source as RuntimeRunRecord, scope.fence) ||
          thread.pausedGeneration !== null
        )
          fail()
        const nativeMatch = (
          checkpoint: RuntimeCheckpointRecord,
          ownerRunId: string,
          taskId: string,
          epoch: string,
          binding: NonNullable<NonNullable<RuntimePendingRecord["proposal"]>["nativeBinding"]>,
          pending: RuntimePendingRecord,
        ): Record<string, unknown> => {
          const payload = checkpoint.payload as {
            kind?: string
            v?: number
            writes?: {
              kind: "execution" | "administrative"
              ownerRunId: string
              taskId: string
              channel: string
              namespaceGeneration: string
              sourceCheckpointId: string | null
              fence: number
              value: [string, number[]]
            }[]
          }
          if (
            payload?.kind !== "langgraph" ||
            payload.v !== 1 ||
            !Array.isArray(payload.writes) ||
            payload.writes.some((write) => !["execution", "administrative"].includes(write.kind))
          )
            fail()
          const matches: Record<string, unknown>[] = []
          for (const write of payload.writes!) {
            if (
              write.kind !== "execution" ||
              write.ownerRunId !== ownerRunId ||
              write.taskId !== taskId ||
              write.channel !== "__interrupt__"
            )
              continue
            if (
              write.namespaceGeneration !== epoch ||
              !Number.isSafeInteger(write.fence) ||
              write.fence < 1 ||
              (write.ownerRunId !== checkpoint.ownerRunId &&
                write.sourceCheckpointId !== checkpoint.state.checkpoint.checkpoint_id) ||
              write.value?.[0] !== "json" ||
              !Array.isArray(write.value[1]) ||
              write.value[1].some((byte) => !Number.isSafeInteger(byte) || byte < 0 || byte > 255)
            )
              fail()
            const decoded: unknown = JSON.parse(
              new TextDecoder().decode(Uint8Array.from(write.value[1])),
            )
            // Native versions write either one Interrupt or one flat task batch.
            // Metadata stays unambiguous; unrelated sibling values remain opaque.
            const interrupts = Array.isArray(decoded) ? decoded : [decoded]
            const ids = new Set<string>()
            for (const item of interrupts) {
              if (!item || typeof item !== "object" || Array.isArray(item)) fail()
              const interrupt = item as { id?: unknown; value?: unknown }
              const id = interrupt.id
              if (typeof id !== "string" || !id || ids.has(id)) return fail()
              ids.add(id)
              if (id !== binding.interruptId) continue
              const value = interrupt.value
              if (!value || typeof value !== "object" || Array.isArray(value)) fail()
              const permission = value as Record<string, unknown>
              if (permission.interruptId !== pending.input.data.interruptId) continue
              const { interruptId: _id, grant: _grant, ...request } = permission
              if (
                canonicalRuntimeValue(request) ===
                canonicalRuntimeValue((pending.input.data.payload as { request: unknown }).request)
              )
                matches.push(permission)
            }
          }
          if (matches.length !== 1) fail()
          return matches[0]!
        }
        for (const [index, entry] of proof.path.entries()) {
          const segment = await read<RuntimeRunRecord>("runs", entry.runId)
          const candidates = db
            .prepare(
              "SELECT payload FROM receipts WHERE owner_run_id=? AND thread_id=? AND generation=?",
            )
            .all(entry.runId, scope.threadId, scope.generation)
            .map((row) => JSON.parse(String(row.payload)) as RuntimeReceiptRecord)
            .filter((row) => ["run.create", "input.respond"].includes(row.operation?.method ?? ""))
          const receipt = candidates[0]
          if (
            !segment ||
            candidates.length !== 1 ||
            receipt?.receiptId !== entry.receiptId ||
            receipt.state !== "accepted" ||
            receipt.receipt.runId !== entry.runId ||
            receipt.receipt.turnId !== segment.metadata.turnId ||
            receipt.operation?.method !== proof.creatorMethod ||
            receipt.operation.operationThreadId !== scope.threadId ||
            segment.preRunCheckpointId !== entry.selectedHead ||
            segment.metadata.phase !== "settled" ||
            segment.metadata.continuation !== "closed" ||
            (index &&
              (segment.metadata.reason !== "permission" ||
                !segment.unwoundAt ||
                segment.ownershipLoss))
          )
            fail()
          await receiptSpec.fields(receipt!, access)
          if (index === 0 && proof.kind !== "accepted_not_started") {
            const checkpoint = await read<RuntimeCheckpointRecord>(
              "checkpoints",
              entry.selectedHead,
            )
            const payload = checkpoint?.payload as
              | {
                  kind?: string
                  v?: number
                  writes?: {
                    kind: "execution" | "administrative"
                    ownerRunId: string
                    taskId: string
                    channel: string
                    namespaceGeneration: string
                    sourceCheckpointId: string | null
                    fence: number
                    value: [string, number[]]
                  }[]
                }
              | undefined
            if (
              !checkpoint ||
              checkpoint.namespace.length ||
              payload?.kind !== "langgraph" ||
              payload.v !== 1 ||
              !Array.isArray(payload.writes) ||
              payload.writes.some((write) => !["execution", "administrative"].includes(write.kind))
            )
              fail()
            const writes = payload!.writes!.filter(
              (write) => write.kind === "execution" && write.ownerRunId === record.sourceRunId,
            )
            if (
              !writes.length ||
              writes.some(
                (write) =>
                  !write.taskId ||
                  write.fence !== proof.execution.fence ||
                  write.namespaceGeneration !== record.sourceRunId ||
                  write.sourceCheckpointId !== entry.selectedHead,
              )
            )
              fail()
            if (proof.creatorMethod === "input.respond")
              for (const accepted of receipt!.operation!.permissionBindings ?? []) {
                const selected = writes.filter(
                  (write) =>
                    write.taskId === accepted.nativeBinding.interruptId &&
                    write.channel === "__resume__",
                )
                if (
                  selected.length !== 1 ||
                  selected[0]!.value?.[0] !== "json" ||
                  !Array.isArray(selected[0]!.value[1]) ||
                  selected[0]!.value[1].some(
                    (byte) => !Number.isSafeInteger(byte) || byte < 0 || byte > 255,
                  )
                )
                  fail()
                const value = JSON.parse(
                  new TextDecoder().decode(Uint8Array.from(selected[0]!.value[1])),
                )
                if (!Array.isArray(value) || value.at(-1) !== accepted.decision) fail()
              }
          }
          if (proof.creatorMethod === "run.create") {
            const frozen = entry.protectedSource
              ? await read<RuntimeProtectedSourceRecord>("aliases", entry.protectedSource.aliasId)
              : undefined
            if (
              segment!.metadata.previousRunId ||
              receipt!.operation!.targetRunId !== entry.runId ||
              !frozen ||
              !isProtectedSource(frozen) ||
              frozen.runId !== entry.runId ||
              frozen.threadId !== scope.threadId ||
              frozen.generation !== scope.generation ||
              frozen.preRunCheckpointId !== entry.selectedHead ||
              frozen.sourceCheckpointId !== record.sourceCheckpointId ||
              frozen.checkpointOwnerRunId !== record.checkpointOwnerRunId ||
              frozen.digest !== entry.protectedSource?.digest
            )
              fail()
            requireSame(receipt!.operation!.protectedSource, entry.protectedSource)
            continue
          }
          if (
            segment!.metadata.previousRunId !== entry.previousRunId ||
            receipt!.operation!.targetRunId !== entry.previousRunId ||
            entry.selectedHead !== record.sourceCheckpointId ||
            !receipt!.operation!.permissionBindings?.length
          )
            fail()
          const allowed = new Set([
            ...proof.path.slice(index + 1).map((item) => item.runId),
            record.checkpointOwnerRunId,
          ])
          for (const accepted of receipt!.operation!.permissionBindings!) {
            const binding = accepted.nativeBinding,
              pending = await read<RuntimePendingRecord>("pending", pendingKey(scope, accepted))
            const checkpoint = await read<RuntimeCheckpointRecord>(
              "checkpoints",
              binding.checkpointId,
            )
            if (
              !pending ||
              !checkpoint ||
              !checkpoint.ownerRunId ||
              !allowed.has(checkpoint.ownerRunId) ||
              canonicalRuntimeValue(checkpoint.namespace) !==
                canonicalRuntimeValue(accepted.namespace)
            )
              fail()
            const leaf = nativeMatch(
              checkpoint!,
              accepted.ownerRunId,
              binding.taskId,
              binding.namespaceGeneration,
              binding,
              pending!,
            )
            const grants = db
              .prepare(
                "SELECT payload FROM grants WHERE thread_id=? AND generation=? AND owner_run_id=? AND input_id=? AND paused_generation=?",
              )
              .all(
                scope.threadId,
                scope.generation,
                accepted.ownerRunId,
                pendingKey(scope, accepted),
                accepted.pausedGeneration,
              )
              .map((row) => JSON.parse(String(row.payload)) as { tokenHash: string })
              .filter((row) => !!row.tokenHash)
            if (
              grants.length > 1 ||
              (grants[0]
                ? typeof leaf.grant !== "string" || sha256Hex(leaf.grant) !== grants[0].tokenHash
                : leaf.grant !== undefined)
            )
              fail()
            let namespace = accepted.namespace,
              childCheckpoint = binding.checkpointId
            while (namespace.length) {
              const aliasId = `namespace:${sha256Hex(JSON.stringify([scope.threadId, scope.generation, accepted.ownerRunId, namespace]))}`
              const native = await read<RuntimeNamespaceRecord>("aliases", aliasId)
              if (
                !native ||
                native.v !== 1 ||
                native.kind !== "native_namespace" ||
                native.aliasId !== aliasId ||
                native.runId !== accepted.ownerRunId ||
                native.agentId !== pending!.proposal?.agentId ||
                native.checkpointId !== childCheckpoint ||
                !["parked", "retired"].includes(native.status) ||
                canonicalRuntimeValue(native.namespace) !== canonicalRuntimeValue(namespace) ||
                (childCheckpoint === binding.checkpointId &&
                  native.namespaceGeneration !== binding.namespaceGeneration)
              )
                fail()
              const parent = await read<RuntimeCheckpointRecord>(
                "checkpoints",
                native!.parentCheckpointId,
              )
              const parentNamespace = namespace.slice(0, -1)
              if (
                !parent ||
                !parent.ownerRunId ||
                !allowed.has(parent.ownerRunId) ||
                canonicalRuntimeValue(parent.namespace) !== canonicalRuntimeValue(parentNamespace)
              )
                fail()
              const parentAlias = parentNamespace.length
                ? await read<RuntimeNamespaceRecord>(
                    "aliases",
                    `namespace:${sha256Hex(JSON.stringify([scope.threadId, scope.generation, accepted.ownerRunId, parentNamespace]))}`,
                  )
                : undefined
              const forwarded = nativeMatch(
                parent!,
                accepted.ownerRunId,
                namespace.at(-1)!.split(":").at(-1)!,
                parentAlias?.namespaceGeneration ?? accepted.ownerRunId,
                binding,
                pending!,
              )
              requireSame(canonicalRuntimeValue(forwarded), canonicalRuntimeValue(leaf))
              childCheckpoint = native!.parentCheckpointId
              namespace = parentNamespace
            }
            if (childCheckpoint !== entry.selectedHead) fail()
          }
        }
      }
      const inherited = await this.get(
        protectedSourceId(scope.threadId, scope.generation, record.sourceRunId),
      )
      if (inherited && !isProtectedSource(inherited)) fail()
      requireSame(record.sourceDigest, inherited?.digest ?? null)
      requireSame(record.sourceRunIds, [record.sourceRunId, ...(inherited?.sourceRunIds ?? [])])
      const agents = [source.run.agent_id, ...(inherited?.agents ?? [])]
      const receipts = db
        .prepare(
          "SELECT payload FROM receipts WHERE owner_run_id=? AND thread_id=? AND generation=?",
        )
        .all(record.sourceRunId, scope.threadId, scope.generation)
      for (const row of receipts) {
        const operation = JSON.parse(String(row.payload)).operation
        if (["input.respond", "input.inject"].includes(operation?.method)) {
          if (!Array.isArray(operation.resolved.permissionAgents)) fail()
          agents.push(...operation.resolved.permissionAgents)
        }
      }
      for (const row of db
        .prepare(
          "SELECT payload FROM aliases WHERE run_id=? AND thread_id=? AND generation=? AND id LIKE 'namespace:%'",
        )
        .all(record.sourceRunId, scope.threadId, scope.generation)) {
        const namespace = JSON.parse(String(row.payload))
        if (namespace.v !== 1 || namespace.kind !== "native_namespace") fail()
        agents.push(namespace.agentId)
      }
      if (agents.some((id) => typeof id !== "string" || !id)) fail()
      requireSame(record.agents, [...new Set(agents)].sort())
      db.prepare(
        "INSERT INTO aliases(id,thread_id,generation,run_id,namespace,payload) VALUES (?,?,?,?,?,?)",
      ).run(
        record.aliasId,
        scope.threadId,
        scope.generation,
        record.runId,
        "[]",
        JSON.stringify(record),
      )
    },
  }
}
