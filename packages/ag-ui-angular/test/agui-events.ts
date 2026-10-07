import type { B4TurnEvent } from "../events/src/turns-store"

/** AG-UI events as the B4.run translator sends them, for the connector tests. */
const ev = (type: string, fields: object = {}): B4TurnEvent => ({ type, ...fields }) as B4TurnEvent

export const runStarted = (runId: string, extra: object = {}): B4TurnEvent =>
  ev("RUN_STARTED", { threadId: "t", runId, ...extra })
export const runFinished = (runId: string, extra: object = {}): B4TurnEvent =>
  ev("RUN_FINISHED", { threadId: "t", runId, ...extra })
export const runError = (message: string, extra: object = {}): B4TurnEvent =>
  ev("RUN_ERROR", { message, ...extra })
export const toolStart = (toolCallId: string, toolCallName: string, extra: object = {}) =>
  ev("TOOL_CALL_START", { toolCallId, toolCallName, ...extra })
export const toolArgs = (toolCallId: string, delta: string, extra: object = {}) =>
  ev("TOOL_CALL_ARGS", { toolCallId, delta, ...extra })
export const toolEnd = (toolCallId: string, extra: object = {}) =>
  ev("TOOL_CALL_END", { toolCallId, ...extra })
export const toolResult = (toolCallId: string, content: string, extra: object = {}) =>
  ev("TOOL_CALL_RESULT", { messageId: `m-${toolCallId}`, toolCallId, content, ...extra })
export const step = (
  toolCallId: string,
  status: "running" | "completed" | "failed",
  label: string,
  extra: object = {},
): B4TurnEvent =>
  ev("CUSTOM", {
    name: "b4.step",
    value: { toolCallId, status, label, icon: "run" },
    ...extra,
  })
export const subagentStarted = (subagentRunId: string, name: string, extra: object = {}) =>
  ev("SUBAGENT_STARTED", { subagentRunId, name, ...extra })
export const subagentFinished = (subagentRunId: string, extra: object = {}) =>
  ev("SUBAGENT_FINISHED", { subagentRunId, outcome: { type: "success" }, ...extra })

/** The interrupt the shared approval fixture "command, offers always" shows. */
export const commandInterrupt = {
  id: "i1",
  reason: "command",
  toolCallId: "c1",
  message: "It isn't on this app's allow-list.",
  responseSchema: { type: "string", enum: ["once", "always", "deny"] },
  metadata: { detail: { command: "rm -rf build", suggestedPattern: "rm -rf build" } },
}

export const parked = (runId: string, interrupts: readonly unknown[]): B4TurnEvent =>
  runFinished(runId, { outcome: { type: "interrupt", interrupts } })

/** A run that parks on `commandInterrupt`: the gated call reads "Run a command". */
export const parkedRun = (runId = "r1"): B4TurnEvent[] => [
  runStarted(runId),
  toolStart("c1", "runBash"),
  toolArgs("c1", '{"command":"rm -rf build"}'),
  toolEnd("c1"),
  step("c1", "running", "Run a command"),
  parked(runId, [commandInterrupt]),
]
