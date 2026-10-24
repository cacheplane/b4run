import {
  B4_STEP_EVENT_NAME,
  B4_TOOL_STEP_STATUSES,
  type B4ToolStep,
  mergeToolStep,
  readToolStep,
} from "@b4run/sdk"
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch"
import type { RunnableConfig } from "@langchain/core/runnables"

/**
 * Validates a producer step and returns an owned v1 value, including nested
 * queries, sources and errors. Intended for sibling producer helpers.
 *
 * @throws TypeError when the version, kind, status or call identity is invalid.
 */
export function normalizeToolStep(
  step: B4ToolStep & { readonly toolCallId: string },
): B4ToolStep & { readonly toolCallId: string } {
  if (
    typeof step !== "object" ||
    step === null ||
    Array.isArray(step) ||
    step.v !== 1 ||
    (step.kind !== "server" && step.kind !== "provider") ||
    !B4_TOOL_STEP_STATUSES.includes(step.status) ||
    typeof step.toolCallId !== "string" ||
    step.toolCallId.trim() === ""
  ) {
    throw new TypeError(
      "emitToolStep requires a v1 step with a valid kind, status and nonempty toolCallId",
    )
  }
  const read = readToolStep(step)
  if (read === undefined) throw new TypeError("emitToolStep could not normalize the step")
  const normalized = mergeToolStep(undefined, read, "call")
  return { ...normalized, toolCallId: step.toolCallId }
}

/**
 * Emits a normalized `b4.step` LangChain custom event from a Node server.
 *
 * Pass the runnable's config explicitly, or pass `undefined` to use Node's
 * active runnable context. Consumers receive it through `streamEvents` v2.
 * Without a listening callback there is no live event; outside an active
 * runnable, missing callback context is ignored. Dispatch failures are secondary
 * and never replace the tool's result. Detached background callback errors
 * follow LangChain's own callback policy. Both `awaitHandlers: true` and
 * `raiseError: true` are needed for listener errors to reject this dispatch
 * promise; default handlers log and swallow errors upstream. This does not checkpoint progress or emit
 * standard AG-UI tool lifecycle frames.
 *
 * @throws TypeError for invalid producer identity, version, kind or status.
 */
export async function emitToolStep(
  config: RunnableConfig | undefined,
  step: B4ToolStep & { readonly toolCallId: string },
): Promise<void> {
  const value = normalizeToolStep(step)
  try {
    await dispatchCustomEvent(B4_STEP_EVENT_NAME, value, config)
  } catch {
    // Tool output and graph control flow remain authoritative if transport fails.
  }
}
