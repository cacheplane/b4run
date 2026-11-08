import type {
  RuntimeGrantRecord,
  RuntimePendingRecord,
  RuntimeReceiptRecord,
  RuntimeStorageScope,
} from "@b4run/sdk/agent-protocol"
import { runtimePermissionProposalHash } from "@b4run/sdk/internal/runtime-identity"
import { sha256Hex } from "@b4run/sdk/pure"
import { type RecordSpec, requireSame } from "./transaction.js"
/** Private physical key. Payload inputId remains the public namespace-local
 * interrupt ID; this exact projection also owns grant references and CAS. */
export function pendingKey(
  scope: RuntimeStorageScope,
  identity: Pick<
    RuntimeGrantRecord,
    "ownerRunId" | "pausedGeneration" | "namespace" | "inputId" | "proposalHash"
  >,
): string {
  return sha256Hex(
    JSON.stringify([
      scope.threadId,
      scope.generation,
      identity.ownerRunId,
      identity.pausedGeneration,
      identity.namespace,
      identity.inputId,
      identity.proposalHash,
    ]),
  )
}
export const grantSpec: RecordSpec<RuntimeGrantRecord> = {
  table: "grants",
  fields(row, access) {
    access.reference("runs", row.ownerRunId)
    access.reference("runs", row.consumedByRunId)
    access.reference("pending", pendingKey(access.scope, row))
    return {
      id: row.grantId,
      ownerRunId: row.ownerRunId,
      namespace: row.namespace,
      inputId: pendingKey(access.scope, row),
      pausedGeneration: row.pausedGeneration,
      consumedByRunId: row.consumedByRunId,
    }
  },
}
export const pendingSpec: RecordSpec<RuntimePendingRecord> = {
  table: "pending",
  fields(row, access) {
    requireSame(row.input.namespace, row.namespace)
    requireSame(row.input.runId, row.ownerRunId)
    access.reference("runs", row.ownerRunId)
    access.reference("runs", row.input.turnId)
    return {
      id: pendingKey(access.scope, {
        ownerRunId: row.ownerRunId,
        namespace: row.namespace,
        inputId: row.input.data.interruptId,
        pausedGeneration: row.input.data.b4.pausedGeneration,
        proposalHash: row.input.data.b4.proposalHash,
      }),
      ownerRunId: row.ownerRunId,
      namespace: row.namespace,
      status: row.disposition,
      turnId: row.input.turnId,
    }
  },
}
export const receiptSpec: RecordSpec<RuntimeReceiptRecord> = {
  table: "receipts",
  fields(row, access) {
    access.reference("runs", row.receipt.runId)
    access.reference("runs", row.receipt.turnId)
    const oldRow = access.db
      .prepare("SELECT payload FROM receipts WHERE id=? AND thread_id=? AND generation=?")
      .get(row.receiptId, access.scope.threadId, access.scope.generation)
    const old = oldRow ? (JSON.parse(String(oldRow.payload)) as RuntimeReceiptRecord) : undefined
    if (
      old &&
      (old.operation?.permissionBindings !== undefined ||
        row.operation?.permissionBindings !== undefined ||
        old.operation?.protectedSource ||
        row.operation?.protectedSource)
    ) {
      requireSame(row.operation, old.operation)
      requireSame(row.receipt, old.receipt)
      requireSame(row.fingerprint, old.fingerprint)
    }
    if (row.operation?.permissionBindings !== undefined) {
      if (
        row.operation.method !== "input.respond" ||
        !Array.isArray(row.operation.permissionBindings) ||
        !row.operation.permissionBindings.length
      )
        throw new Error("Invalid native permission receipt")
      for (const binding of row.operation.permissionBindings) {
        const key = pendingKey(access.scope, binding)
        const selected = access.db
          .prepare("SELECT payload FROM pending WHERE id=? AND thread_id=? AND generation=?")
          .get(key, access.scope.threadId, access.scope.generation)
        const pending = selected
          ? (JSON.parse(String(selected.payload)) as RuntimePendingRecord)
          : undefined
        if (
          binding.v !== 1 ||
          binding.ownerRunId !== row.operation.targetRunId ||
          !pending ||
          pending.disposition !== "answered" ||
          pending.decision !== binding.decision
        )
          throw new Error("Invalid native accepted binding")
        requireSame(binding.namespace, pending.namespace)
        requireSame(binding.inputId, pending.input.data.interruptId)
        requireSame(binding.pausedGeneration, pending.input.data.b4.pausedGeneration)
        requireSame(binding.proposalHash, pending.input.data.b4.proposalHash)
        requireSame(binding.nativeBinding, pending.proposal?.nativeBinding)
        requireSame(binding.proposalHash, runtimePermissionProposalHash(pending))
        const grants = access.db
          .prepare(
            "SELECT payload FROM grants WHERE thread_id=? AND generation=? AND owner_run_id=? AND input_id=? AND paused_generation=?",
          )
          .all(
            access.scope.threadId,
            access.scope.generation,
            binding.ownerRunId,
            key,
            binding.pausedGeneration,
          )
          .map((value) => JSON.parse(String(value.payload)) as RuntimeGrantRecord)
          .filter(
            (grant) =>
              grant.proposalHash === binding.proposalHash &&
              JSON.stringify(grant.namespace) === JSON.stringify(binding.namespace),
          )
        if (!["off", "optional", "required"].includes(binding.grantMode))
          throw new Error("Invalid native grant mode")
        if (binding.grantMode === "off") {
          if (binding.grantId !== null) throw new Error("Invalid native off-mode grant")
        } else if (
          (binding.grantMode === "required" && grants.length !== 1) ||
          (binding.grantId === null
            ? grants.length !== 0
            : grants.length !== 1 ||
              grants[0]?.grantId !== binding.grantId ||
              grants[0]?.consumedByRunId !== row.receipt.runId)
        )
          throw new Error("Invalid native consumed grant")
      }
    }

    return {
      id: row.receiptId,
      ownerRunId: row.receipt.runId,
      turnId: row.receipt.turnId,
      status: row.state,
    }
  },
}
