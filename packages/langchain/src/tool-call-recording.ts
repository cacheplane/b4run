/**
 * The tool-call record's server-row discipline, shared by every writer of
 * server rows (the tool converter and the subagent bridge): issue before the
 * body runs, settle in `finally`, and never settle a park.
 */
import { CLIENT_TOOL_RECORDER_KEY, type ClientToolRecorder, type ToolCallOrigin } from "@b4run/sdk"
import { isGraphInterrupt } from "@langchain/langgraph"

/** A recorder that records server calls: both `issue` and `settle` present. */
type ServerCallRecorder = ClientToolRecorder &
  Required<Pick<ClientToolRecorder, "issue" | "settle">>

/**
 * The per-run recorder the runtime injected, when it records server calls.
 * Present only on AG-UI runs where a route opted into client tools or a store
 * is configured; a recorder without `issue`/`settle` (a leftover default store
 * kept to close old parks) records nothing here.
 */
function readServerCallRecorder(config: unknown): ServerCallRecorder | undefined {
  if (typeof config !== "object" || config === null) return undefined
  const configurable = (config as { configurable?: Record<string, unknown> }).configurable
  const candidate = configurable?.[CLIENT_TOOL_RECORDER_KEY] as ClientToolRecorder | undefined
  return candidate &&
    typeof candidate.issue === "function" &&
    typeof candidate.settle === "function"
    ? (candidate as ServerCallRecorder)
    : undefined
}

/**
 * Where the current tool call is being issued from, read off the subagent
 * stack the bridge carries in `config.metadata.b4.subagent_stack`: the top
 * entry's route key and the `task` call that launched it. `undefined` at the
 * root, and for a stack entry written before route keys were stacked.
 */
export function readCallOrigin(config: unknown): ToolCallOrigin | undefined {
  if (typeof config !== "object" || config === null) return undefined
  const b4 = (config as { metadata?: { b4?: unknown } }).metadata?.b4
  if (typeof b4 !== "object" || b4 === null) return undefined
  const stack = (b4 as { subagent_stack?: unknown }).subagent_stack
  if (!Array.isArray(stack) || stack.length === 0) return undefined
  const top = stack[stack.length - 1] as { callId?: unknown; routeKey?: unknown }
  if (typeof top.callId !== "string" || typeof top.routeKey !== "string") return undefined
  return { routeId: top.routeKey, parentToolCallId: top.callId }
}

/**
 * Run `body` as one recorded server tool call. With no server-call recorder on
 * `config`, or no provider tool-call id, the body runs untouched. Otherwise
 * `issue` runs first, with the call's `origin` (the issuing subagent route and
 * its launching `task` call; absent at the root) forwarded untouched — a call
 * the server cannot account for must not run, so an issue failure is the
 * call's error — and `settle` runs in `finally` for a return (a refusal
 * returned as text included), a throw and an abort, but NOT for a
 * `GraphInterrupt`: a park is not completion. The resumed re-execution issues
 * again (a no-op on the key) and settles when the body really returns or
 * throws. A settle failure is warned
 * and swallowed: the body already ran, and an unsettled server row is never
 * answerable and only delays pruning.
 */
export async function recordToolCall<T>(
  config: unknown,
  call: {
    readonly toolCallId: string
    readonly toolName: string
    readonly origin?: ToolCallOrigin
  },
  body: () => Promise<T>,
): Promise<T> {
  const recorder = call.toolCallId === "" ? undefined : readServerCallRecorder(config)
  if (!recorder) return body()
  await recorder.issue(call)
  let parked = false
  try {
    return await body()
  } catch (error) {
    parked = isGraphInterrupt(error)
    throw error
  } finally {
    if (!parked) {
      try {
        await recorder.settle(call.toolCallId)
      } catch (error) {
        console.warn(
          `B4: could not settle tool call ${call.toolCallId} for ${call.toolName}.`,
          error,
        )
      }
    }
  }
}
