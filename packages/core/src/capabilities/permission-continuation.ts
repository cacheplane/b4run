import type { PermissionRule } from "@b4run/permissions"
import { getConfig } from "@langchain/langgraph"

export const PERMISSION_CONTINUATION_KEY = "__b4PermissionContinuation"
export interface PermissionContinuationRequest {
  readonly runId: string
  readonly checkpointNs: string
  readonly nativeTaskId: string
  readonly interruptIndex: number
  readonly checkpointId: string
  readonly request: Readonly<Record<string, unknown>>
  readonly protectedProposal: unknown
  readonly rule: PermissionRule
}
interface ContinuationContext {
  readonly runId: string
  readonly resolve: (request: PermissionContinuationRequest) => Promise<boolean | undefined>
}
const contexts = new WeakMap<object, ContinuationContext>()
const toolProposals = new WeakMap<object, unknown>()
/** Internal adapter plumbing. This identity is never serialized; after restore
 * R8 must reconstruct it from the accepted continuation and exact task mapping.
 * A public JSON object cannot acquire an entry in this registry. */
export function createPermissionContinuationContext(options: ContinuationContext): object {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.runId) ||
    typeof options.resolve !== "function"
  )
    throw new Error("Invalid permission continuation")
  const context = Object.freeze({})
  contexts.set(context, { runId: options.runId, resolve: options.resolve })
  return context
}
function ambientContext():
  | {
      context: ContinuationContext
      checkpointNs: string
      nativeTaskId: string
      interruptIndex: number
      checkpointId: string
    }
  | undefined {
  let config: Record<string, unknown> | undefined
  try {
    config = getConfig()?.configurable
  } catch {
    return undefined
  }
  if (!config || !Object.hasOwn(config, PERMISSION_CONTINUATION_KEY)) return undefined
  const candidate = config[PERMISSION_CONTINUATION_KEY]
  const context = candidate && typeof candidate === "object" ? contexts.get(candidate) : undefined
  if (!context || typeof config.checkpoint_ns !== "string")
    throw new Error("Invalid permission continuation")
  const task = config.__pregel_task_id
  const scratchpad = config.__pregel_scratchpad as { interruptCounter?: unknown } | undefined
  if (
    typeof task !== "string" ||
    typeof scratchpad?.interruptCounter !== "number" ||
    !Number.isSafeInteger(scratchpad.interruptCounter) ||
    scratchpad.interruptCounter < -1
  )
    throw new Error("Invalid permission continuation")
  const namespace = config.checkpoint_ns.split("|").slice(0, -1).join("|")
  const checkpointId =
    (config.checkpoint_map as Record<string, unknown> | undefined)?.[namespace] ??
    config.checkpoint_id
  if (typeof checkpointId !== "string" || !checkpointId.length)
    throw new Error("Invalid permission continuation")
  return {
    context,
    checkpointNs: config.checkpoint_ns,
    nativeTaskId: task,
    interruptIndex: scratchpad.interruptCounter + 1,
    checkpointId,
  }
}
export function assertPermissionContinuationContext(): void {
  ambientContext()
}
export function withProtectedToolProposal<T extends object>(options: T, proposal: unknown): T {
  toolProposals.set(options, proposal)
  return options
}
export function protectedToolProposal(options: object | undefined): unknown {
  return options ? toolProposals.get(options) : undefined
}
export async function confirmRememberedPermission(
  request: Readonly<Record<string, unknown>>,
  protectedProposal: unknown,
  rule: PermissionRule,
): Promise<boolean> {
  const ambient = ambientContext()
  if (!ambient) return false
  const accepted = await ambient.context.resolve({
    runId: ambient.context.runId,
    checkpointNs: ambient.checkpointNs,
    nativeTaskId: ambient.nativeTaskId,
    interruptIndex: ambient.interruptIndex,
    checkpointId: ambient.checkpointId,
    request,
    protectedProposal,
    rule,
  })
  if (accepted === undefined) return false
  if (accepted !== true || protectedProposal === undefined)
    throw new Error("Invalid permission continuation")
  return true
}
