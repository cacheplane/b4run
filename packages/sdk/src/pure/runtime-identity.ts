import type { PermissionPayloadV1 } from "../agent-protocol/metadata.js"
import type { RuntimePendingRecord } from "../agent-protocol/storage.js"
import { sha256Hex } from "./hash.js"

/** One canonical spelling for private durable runtime identities. */
export function canonicalRuntimeValue(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalRuntimeValue).join(",")}]`
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalRuntimeValue((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`
}

export function runtimePermissionProposalHash(item: RuntimePendingRecord): string {
  const payload = item.input.data.payload as PermissionPayloadV1
  return sha256Hex(
    canonicalRuntimeValue({
      ownerRunId: item.ownerRunId,
      namespace: item.namespace,
      inputId: item.input.data.interruptId,
      pausedGeneration: item.input.data.b4.pausedGeneration,
      request: payload.request,
      allowAlways: payload.allowAlways,
      expiresAt: item.input.data.b4.expiresAt ?? null,
      proposal: item.proposal,
    }),
  )
}
