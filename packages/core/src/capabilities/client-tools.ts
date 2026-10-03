/**
 * The server half of client-provided tools (cacheplane/b4run#743).
 *
 * An AG-UI client registers tool definitions; for a route that opted in, each
 * becomes a per-run STUB named `client_<name>`. When the model calls it, the
 * stub gates on the `clientTool` permission key, records the outstanding call
 * through the per-run `ClientToolRecorder`, and parks with `interrupt()`. The
 * park is never projected to the client: the AG-UI handler resumes it
 * internally with `{ clientToolResult }` once the client's `role: "tool"`
 * message arrives.
 */
import type { PermissionsStore } from "@b4run/permissions"
import { CLIENT_TOOL_RECORDER_KEY, type ClientToolRecorder } from "@b4run/sdk"
import { getConfig, interrupt } from "@langchain/langgraph"
import { codedReason, type GateResult } from "./permission-gate.js"
import type { B4ToolDefinition } from "./types.js"

/** Model-visible prefix for every client tool: `foo` becomes `client_foo`. */
export const CLIENT_TOOL_PREFIX = "client_"
/** Interrupt envelope `type` for a parked client tool call — never projected to the client. */
export const CLIENT_TOOL_CALL_TYPE = "client-tool-call"
/** Tool result for a new call to a replay-only stub: the tool was not offered on this run. */
export const CLIENT_TOOL_UNAVAILABLE_RESULT =
  "[client tool unavailable] This client tool was not offered on this run."
/** Tool result recorded for a call the client never answered. */
export const ABANDONED_CLIENT_TOOL_RESULT = "The client did not return a result for this tool call."

/** A client tool definition after envelope validation. */
export interface ClientToolDefinition {
  /** As the client registered it; the model sees `client_<name>`. */
  readonly name: string
  readonly description: string
  /** Caller-authored JSON Schema, already bounded by envelope validation. */
  readonly parameters: Record<string, unknown>
  /**
   * Set by the runtime — never read from a client — for a stub rebuilt only so
   * a parked call can replay: see `ClientToolStubOptions.replayOnly`.
   */
  readonly replayOnly?: boolean
}

export interface ClientToolStubOptions {
  /**
   * The stub exists only to replay a call that already parked, because this
   * run's request did not offer the tool. A NEW call to it (nothing recorded
   * for its tool-call id) is refused with {@link CLIENT_TOOL_UNAVAILABLE_RESULT}
   * — no gate, no record, no park — since the client never offered the tool
   * on this run and could not answer it.
   */
  readonly replayOnly?: boolean
}

export interface ClientToolCallEnvelope {
  readonly type: typeof CLIENT_TOOL_CALL_TYPE
  readonly interruptId: string
  readonly toolCallId: string
  readonly name: string
  readonly input: unknown
}

/** What the internal resume delivers to a parked client tool call. */
export interface ClientToolResumeValue {
  readonly clientToolResult: string
}

export class MissingClientToolRecorderError extends Error {
  constructor() {
    super("client tool call parked with no recorder; refusing to park a call nobody can answer")
    this.name = "MissingClientToolRecorderError"
  }
}

export function isClientToolCallEnvelope(value: unknown): value is ClientToolCallEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === CLIENT_TOOL_CALL_TYPE &&
    typeof (value as { interruptId?: unknown }).interruptId === "string" &&
    typeof (value as { toolCallId?: unknown }).toolCallId === "string"
  )
}

/**
 * Stable across LangGraph's re-execution of the tool node on resume, unlike
 * the permission park's time-derived id: the provider's tool-call id is.
 */
export function clientToolInterruptId(toolCallId: string): string {
  return `client-${toolCallId}`
}

/**
 * Allow unless the operator said otherwise under the `clientTool` key.
 * Deliberately not `gateToolOp`: that matches `tool:<name>`, and a
 * caller-named tool must never inherit an approval granted to the server's
 * own tool of the same name. `always` is never offered: its pattern would be
 * a caller-authored string persisted into the operator's permissions.
 *
 * Mode: `bypass` allows. `non-interactive` also allows an unmatched name —
 * unlike `gateToolOp`, which fails closed there, this gate never prompts, so
 * there is no prompt whose absence could fail closed; only an explicit deny
 * refuses.
 */
export async function gateClientToolOp(
  permissions: PermissionsStore | undefined,
  name: string,
): Promise<GateResult> {
  if (!permissions || permissions.mode === "bypass") return { allowed: true }
  if (permissions.match("clientTool", name) === "deny") {
    return { allowed: false, reason: `Permission denied: client tool ${name}`, code: "B4_E3001" }
  }
  return { allowed: true }
}

function readClientToolResult(resumed: unknown): string | undefined {
  if (typeof resumed !== "object" || resumed === null) return undefined
  const text = (resumed as Partial<Record<keyof ClientToolResumeValue, unknown>>).clientToolResult
  return typeof text === "string" ? text : undefined
}

function readRecorder(): ClientToolRecorder | undefined {
  const configurable = (getConfig()?.configurable ?? {}) as Record<string, unknown>
  const recorder = configurable[CLIENT_TOOL_RECORDER_KEY]
  return recorder &&
    typeof (recorder as ClientToolRecorder).record === "function" &&
    typeof (recorder as ClientToolRecorder).has === "function"
    ? (recorder as ClientToolRecorder)
    : undefined
}

/**
 * The stub tool for one client tool. Its body is the park: gate, record,
 * `interrupt()`. LangGraph re-executes it from the top on resume, so the gate
 * and the record sit behind `recorder.has()`: the permission decision is taken
 * once, before the park, and a deny added while the call is parked cannot
 * discard a result the client already produced (its side effect happened).
 *
 * A resume value that is not `{ clientToolResult: string }` is never handed to
 * the model as a successful empty result; it reads as abandoned.
 */
export function createClientToolStub(
  definition: ClientToolDefinition,
  permissions: PermissionsStore | undefined,
  options: ClientToolStubOptions = {},
): B4ToolDefinition {
  return {
    name: `${CLIENT_TOOL_PREFIX}${definition.name}`,
    description: `[Client-provided tool; definition authored by the caller] ${definition.description}`,
    schema: definition.parameters,
    clientTool: true,
    async run(input, context) {
      const toolCallId = context.toolCallId
      if (!toolCallId) throw new Error("client tool call has no provider tool-call id")
      const recorder = readRecorder()
      if (!recorder) throw new MissingClientToolRecorderError()
      const interruptId = clientToolInterruptId(toolCallId)
      if (!(await recorder.has(toolCallId))) {
        if (options.replayOnly) return CLIENT_TOOL_UNAVAILABLE_RESULT
        const gate = await gateClientToolOp(permissions, definition.name)
        if (!gate.allowed) return codedReason(gate)
        await recorder.record({ toolCallId, interruptId, toolName: definition.name })
      }
      const envelope: ClientToolCallEnvelope = {
        type: CLIENT_TOOL_CALL_TYPE,
        interruptId,
        toolCallId,
        name: definition.name,
        input,
      }
      const resumed: unknown = interrupt(envelope)
      return { result: readClientToolResult(resumed) ?? ABANDONED_CLIENT_TOOL_RESULT }
    },
  }
}
