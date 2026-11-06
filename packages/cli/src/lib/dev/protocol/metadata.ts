import { THREAD_ACCESS_METADATA_KEY } from "@b4run/sdk"
import type { OperationLookupSelectors, RequestMetadataV1 } from "@b4run/sdk/agent-protocol"
import { ProtocolError } from "./errors.js"

export function protocolRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
export function invalid(): never {
  throw new ProtocolError("invalid_argument")
}
export function canonicalProtocolId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  )
    invalid()
  return value
}
export const RECEIPT_SELECTORS = [
  "b4.submissionId",
  "b4.submissionKind",
  "b4.operationThreadId",
  "b4.targetRunId",
] as const
export function parseRequestMetadata(value: unknown): RequestMetadataV1 {
  const record = protocolRecord(value)
  if (
    record.v !== 1 ||
    Object.keys(record).some((key) => !["v", "submissionId", "expected"].includes(key))
  )
    invalid()
  if (Object.hasOwn(record, "submissionId")) canonicalProtocolId(record.submissionId)
  if (Object.hasOwn(record, "expected")) {
    const expected = protocolRecord(record.expected)
    for (const key of Object.keys(expected)) {
      if (!["generation", "runId", "pausedGeneration"].includes(key)) invalid()
      canonicalProtocolId(expected[key])
    }
  }
  return record as unknown as RequestMetadataV1
}
export function parseCallerMetadata(
  value: unknown,
  kind: "thread" | "run",
): Record<string, unknown> {
  const record = protocolRecord(value)
  for (const key of Object.keys(record)) {
    if (
      (RECEIPT_SELECTORS as readonly string[]).includes(key) ||
      key === THREAD_ACCESS_METADATA_KEY
    )
      invalid()
    if (key === "b4") {
      if (kind === "thread") invalid()
      parseRequestMetadata(record.b4)
    }
  }
  return { ...record }
}
export interface RunSearchMetadata {
  readonly filters: Record<string, unknown>
  readonly lookup?: {
    readonly submissionId: string
    readonly submissionKind: "b4" | "agui"
    readonly operationThreadId?: string
    readonly targetRunId?: string
  }
}
export function parseRunSearchMetadata(value: unknown): RunSearchMetadata {
  const record = protocolRecord(value)
  if (!RECEIPT_SELECTORS.some((key) => Object.hasOwn(record, key)))
    return { filters: { ...record } }
  if (record["b4.submissionKind"] !== "b4" && record["b4.submissionKind"] !== "agui") invalid()
  if (typeof record["b4.submissionId"] !== "string") invalid()
  if (record["b4.submissionKind"] === "b4") canonicalProtocolId(record["b4.submissionId"])
  for (const key of ["b4.operationThreadId", "b4.targetRunId"])
    if (Object.hasOwn(record, key)) canonicalProtocolId(record[key])
  const selectors = record as OperationLookupSelectors
  return {
    filters: Object.fromEntries(
      Object.entries(record).filter(
        ([key]) => !(RECEIPT_SELECTORS as readonly string[]).includes(key),
      ),
    ),
    lookup: {
      submissionId: selectors["b4.submissionId"],
      submissionKind: selectors["b4.submissionKind"],
      ...(selectors["b4.operationThreadId"] !== undefined
        ? { operationThreadId: selectors["b4.operationThreadId"] }
        : {}),
      ...(selectors["b4.targetRunId"] !== undefined
        ? { targetRunId: selectors["b4.targetRunId"] }
        : {}),
    },
  }
}
/** Literal top-level equality, including complete nested JSON values. This is
 * deliberately independent of Store's filter language and receipt lookups. */
export function matchesLiteralFilters(
  value: Record<string, unknown>,
  filters: Record<string, unknown>,
): boolean {
  return Object.entries(filters).every(
    ([key, wanted]) => Object.hasOwn(value, key) && jsonEqual(value[key], wanted),
  )
}
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]))
    )
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null ||
    Array.isArray(left) ||
    Array.isArray(right)
  )
    return false
  const l = left as Record<string, unknown>,
    r = right as Record<string, unknown>
  return Object.keys(l).length === Object.keys(r).length && matchesLiteralFilters(l, r)
}
const protectedConfig = new Set([
  "b4",
  "thread_id",
  "run_id",
  "checkpoint_id",
  "checkpoint_ns",
  "principal",
  "namespace",
  "owner",
  "fence",
  "permissions",
  "grant",
  "grants",
  "store",
  "sandbox",
  "checkpointer",
  "runtime",
  "deploymentId",
])
export interface ProtocolConfigPolicy {
  readonly allowedKeys: readonly string[]
  readonly parse?: (config: Record<string, unknown>) => unknown
}
/** Validate structure/protected fields separately from resolved adapter schema.
 * In REST only configurable is route config; in ASP the whole config is. */
export function validateProtocolConfig(
  value: unknown,
  policy?: ProtocolConfigPolicy,
  carrier: "rest" | "asp" = "rest",
): Record<string, unknown> {
  const record = protocolRecord(value)
  for (const key of Object.keys(record)) if (protectedConfig.has(key)) invalid()
  if (carrier === "rest") {
    if (
      Object.hasOwn(record, "tags") &&
      (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== "string"))
    )
      invalid()
    if (Object.hasOwn(record, "recursion_limit") && !Number.isInteger(record.recursion_limit))
      invalid()
  }
  const configurable =
    carrier === "asp"
      ? record
      : Object.hasOwn(record, "configurable")
        ? protocolRecord(record.configurable)
        : undefined
  if (configurable) {
    for (const key of Object.keys(configurable))
      if (protectedConfig.has(key) || !policy?.allowedKeys.includes(key)) invalid()
    if (policy?.parse) {
      try {
        policy.parse(configurable)
      } catch {
        invalid()
      }
    }
  }
  return { ...record }
}
