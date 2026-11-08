import type {
  RuntimeNamespaceRecord,
  RuntimeReceiptRecord,
  RuntimeRecords,
} from "@b4run/sdk/agent-protocol"
import { sha256Hex } from "@b4run/sdk/pure"
import { type Access, diagnostic, requireSame } from "./transaction.js"

export function makeNamespaces(access: Access): RuntimeRecords<RuntimeNamespaceRecord> {
  const { scope } = access
  const decode = (row: {
    id: string
    run_id: string
    namespace: string
    payload: string
  }): RuntimeNamespaceRecord => {
    const record = JSON.parse(row.payload) as RuntimeNamespaceRecord
    if (record.v !== 1 || record.kind !== "native_namespace")
      throw diagnostic("scope_mismatch", "Invalid native namespace identity")
    requireSame(record.aliasId, row.id)
    requireSame(record.runId, row.run_id)
    requireSame(JSON.stringify(record.namespace), row.namespace)
    return record
  }
  return {
    async get(id) {
      await access.reference("aliases", id)
      const row = await access.query<{
        id: string
        run_id: string
        namespace: string
        payload: string
      }>(
        "SELECT id,run_id,namespace,payload FROM aliases WHERE id=? AND thread_id=? AND generation=? AND id LIKE 'namespace:%'",
        [id, scope.threadId, scope.generation],
      )
      return row.rows[0] ? decode(row.rows[0]) : undefined
    },
    async list() {
      const rows = await access.query<{
        id: string
        run_id: string
        namespace: string
        payload: string
      }>(
        "SELECT id,run_id,namespace,payload FROM aliases WHERE thread_id=? AND generation=? AND id LIKE 'namespace:%' ORDER BY id COLLATE \"C\"",
        [scope.threadId, scope.generation],
      )
      return rows.rows.map(decode)
    },
    async put(record) {
      await access.reference("aliases", record.aliasId)
      await access.reference("runs", record.runId)
      await access.reference("checkpoints", record.checkpointId)
      await access.reference("checkpoints", record.parentCheckpointId)
      if (
        record.kind !== "native_namespace" ||
        record.v !== 1 ||
        !record.namespace.length ||
        !record.agentId ||
        !Number.isSafeInteger(record.revision) ||
        record.revision < 1
      )
        throw diagnostic("scope_mismatch", "Invalid native namespace proof")
      const keys = [
        "v",
        "kind",
        "aliasId",
        "runId",
        "namespace",
        "agentId",
        "namespaceGeneration",
        "parentCheckpointId",
        "checkpointId",
        "revision",
        "status",
        "source",
      ]
      if (
        Object.keys(record).some((key) => !keys.includes(key)) ||
        !["running", "parked", "closed", "retired"].includes(record.status) ||
        record.namespace.some((part) => typeof part !== "string" || !part.length) ||
        (!record.source &&
          record.namespace.at(-1)?.split(":").at(-1) !== record.namespaceGeneration)
      )
        throw diagnostic("scope_mismatch", "Invalid native namespace fields")
      requireSame(
        record.aliasId,
        `namespace:${sha256Hex(JSON.stringify([scope.threadId, scope.generation, record.runId, record.namespace]))}`,
      )
      const pointers = await access.query<{ id: string; owner_run_id: string; namespace: string }>(
        "SELECT id,owner_run_id,namespace FROM checkpoints WHERE id IN (?,?) AND thread_id=? AND generation=?",
        [record.checkpointId, record.parentCheckpointId, scope.threadId, scope.generation],
      )
      const head = pointers.rows.find((row) => row.id === record.checkpointId),
        parent = pointers.rows.find((row) => row.id === record.parentCheckpointId)
      if (
        !head ||
        !parent ||
        (!record.source &&
          (head.owner_run_id !== record.runId || parent.owner_run_id !== record.runId)) ||
        head.namespace !== JSON.stringify(record.namespace) ||
        parent.namespace !== JSON.stringify(record.namespace.slice(0, -1))
      )
        throw diagnostic("scope_mismatch", "Native namespace head or parent is outside its binding")
      const run = await access.query<{ payload: string; execution_owner: string | null }>(
        "SELECT r.payload,s.execution_owner FROM runs r JOIN scopes s USING(thread_id,generation) WHERE r.id=? AND r.thread_id=? AND r.generation=?",
        [record.runId, scope.threadId, scope.generation],
      )
      const row = run.rows[0],
        owner = row ? JSON.parse(row.payload) : undefined
      if (record.source) {
        const source = record.source
        const keys = [
          "v",
          "kind",
          "threadId",
          "generation",
          "runId",
          "aliasId",
          "namespaceGeneration",
          "checkpointId",
          "parentCheckpointId",
          "receiptId",
        ]
        if (
          Object.keys(source).some((key) => !keys.includes(key)) ||
          source.v !== 1 ||
          source.kind !== "permission_continuation" ||
          source.threadId !== scope.threadId ||
          source.generation !== scope.generation ||
          source.runId === record.runId ||
          owner?.metadata.previousRunId !== source.runId ||
          source.namespaceGeneration === record.namespaceGeneration ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            record.namespaceGeneration,
          )
        )
          throw diagnostic("scope_mismatch", "Invalid native continuation source")
        requireSame(
          source.aliasId,
          `namespace:${sha256Hex(JSON.stringify([scope.threadId, scope.generation, source.runId, record.namespace]))}`,
        )
        const prior = await this.get(source.aliasId)
        if (
          !prior ||
          prior.runId !== source.runId ||
          prior.agentId !== record.agentId ||
          prior.namespaceGeneration !== source.namespaceGeneration ||
          prior.status !== "parked" ||
          prior.checkpointId !== source.checkpointId ||
          prior.parentCheckpointId !== source.parentCheckpointId ||
          record.parentCheckpointId !== source.parentCheckpointId ||
          JSON.stringify(prior.namespace) !== JSON.stringify(record.namespace) ||
          (record.checkpointId !== source.checkpointId && head.owner_run_id !== record.runId)
        )
          throw diagnostic("scope_mismatch", "Native continuation source binding changed")
        const selected = await access.query<{ payload: string }>(
          "SELECT payload FROM receipts WHERE id=? AND thread_id=? AND generation=?",
          [source.receiptId, scope.threadId, scope.generation],
        )
        const receipt = selected.rows[0]
          ? (JSON.parse(selected.rows[0].payload) as RuntimeReceiptRecord)
          : undefined
        if (
          receipt?.state !== "accepted" ||
          receipt.receipt.runId !== record.runId ||
          receipt.operation?.method !== "input.respond" ||
          receipt.operation.targetRunId !== source.runId ||
          receipt.operation.operationThreadId !== scope.threadId ||
          receipt.receipt.turnId !== owner.metadata.turnId
        )
          throw diagnostic("scope_mismatch", "Invalid native continuation receipt")
        const bindings = receipt.operation.permissionBindings?.filter(
          (binding) =>
            JSON.stringify(binding.namespace) === JSON.stringify(record.namespace) &&
            binding.ownerRunId === source.runId &&
            binding.nativeBinding.checkpointId === source.checkpointId &&
            binding.nativeBinding.namespaceGeneration === source.namespaceGeneration,
        )
        if (
          !bindings?.length ||
          bindings.some(
            (binding) =>
              binding.nativeBinding.checkpointNs.split("|").slice(0, -1).join("|") !==
                record.namespace.join("|") ||
              binding.nativeBinding.checkpointNs.split("|").at(-1)?.split(":").at(-1) !==
                binding.nativeBinding.taskId,
          )
        )
          throw diagnostic("scope_mismatch", "Native continuation has no exact accepted task")
      }
      const retirement =
        record.status === "retired" &&
        owner?.metadata.phase === "settled" &&
        owner.metadata.continuation === "closed" &&
        row?.execution_owner === null &&
        (owner.unwoundAt || owner.ownershipLoss)
      if (
        !retirement &&
        (record.status === "retired" ||
          owner?.metadata.phase !== "running" ||
          owner.execution?.fence !== scope.fence ||
          owner.execution?.ownerId !== row?.execution_owner)
      )
        throw diagnostic("stale_fence", "Native namespace update has no current execution owner")
      const old = await this.get(record.aliasId)
      if (old) {
        for (const key of [
          "runId",
          "namespace",
          "agentId",
          "namespaceGeneration",
          "parentCheckpointId",
          "source",
        ] as const)
          requireSame(record[key], old[key])
        if (
          record.revision <= old.revision ||
          (old.status !== "running" && record.status === "running")
        )
          throw diagnostic("stale_fence", "Native namespace revision is stale")
      }
      await access.query(
        "INSERT INTO aliases AS target(id,thread_id,generation,run_id,namespace,payload) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE target.thread_id=excluded.thread_id AND target.generation=excluded.generation",
        [
          record.aliasId,
          scope.threadId,
          scope.generation,
          record.runId,
          JSON.stringify(record.namespace),
          JSON.stringify(record),
        ],
      )
    },
  }
}
