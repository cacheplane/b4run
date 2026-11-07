import { sha256Hex } from "@b4run/sdk/pure"
import type { RememberedRuleIntent } from "./rule-intents.js"

export class RuleIntentConflictError extends Error {
  constructor(message = "Conflicting permission rule intent") {
    super(message)
    this.name = "RuleIntentConflictError"
  }
}

/** Private persistence envelope. Never an author configuration schema. */
export interface RuleCoordinatorState {
  readonly v: 1
  readonly scopeId: string
  readonly revision: number
  readonly contentHash: string
  readonly receipts: Readonly<
    Record<string, { readonly fingerprint: string; readonly outcome: "applied" | "superseded" }>
  >
}
export function canonicalRuleValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalRuleValue).join(",")}]`
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalRuleValue((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`
}
export function ruleContentHash(value: unknown): string {
  return sha256Hex(canonicalRuleValue(value))
}
export function nextRuleRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER)
    throw new RuleIntentConflictError("Permission rule revision exhausted")
  return revision + 1
}
export function readRuleCoordinator(value: unknown, content: unknown): RuleCoordinatorState {
  const contentHash = ruleContentHash(content)
  if (value === undefined)
    return { v: 1, scopeId: crypto.randomUUID(), revision: 0, contentHash, receipts: {} }
  const state = value as RuleCoordinatorState
  if (
    state?.v !== 1 ||
    typeof state.scopeId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(state.scopeId) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    typeof state.contentHash !== "string" ||
    !state.receipts ||
    typeof state.receipts !== "object" ||
    Array.isArray(state.receipts)
  )
    throw new Error("Invalid private permission coordinator")
  for (const receipt of Object.values(state.receipts))
    if (
      !receipt ||
      typeof receipt.fingerprint !== "string" ||
      !["applied", "superseded"].includes(receipt.outcome)
    )
      throw new Error("Invalid private permission receipt")
  return state.contentHash === contentHash
    ? state
    : { ...state, revision: nextRuleRevision(state.revision), contentHash }
}
export function ruleIntentFingerprint(intent: RememberedRuleIntent): string {
  if (
    !intent ||
    typeof intent.operationId !== "string" ||
    !intent.operationId ||
    typeof intent.scopeId !== "string" ||
    typeof intent.revision !== "string" ||
    !Array.isArray(intent.rules) ||
    !intent.rules.length ||
    intent.rules.some(
      (rule) =>
        !rule || typeof rule.tool !== "string" || !rule.tool || typeof rule.pattern !== "string",
    )
  )
    throw new RuleIntentConflictError()
  return ruleContentHash(intent)
}
export function existingRuleReceipt(
  state: RuleCoordinatorState,
  intent: RememberedRuleIntent,
): "applied" | "superseded" | undefined {
  if (!Object.hasOwn(state.receipts, intent.operationId)) return undefined
  const receipt = state.receipts[intent.operationId]
  if (!receipt) throw new RuleIntentConflictError()
  if (receipt.fingerprint !== ruleIntentFingerprint(intent)) throw new RuleIntentConflictError()
  return receipt.outcome
}
export function withRuleReceipt(
  state: RuleCoordinatorState,
  intent: RememberedRuleIntent,
  outcome: "applied" | "superseded",
  content: unknown,
): RuleCoordinatorState {
  return {
    ...state,
    revision: nextRuleRevision(state.revision),
    contentHash: ruleContentHash(content),
    receipts: {
      ...state.receipts,
      [intent.operationId]: { fingerprint: ruleIntentFingerprint(intent), outcome },
    },
  }
}

export { permissionCandidateForRequest, permissionRuleForRequest } from "./rule-intents.js"
