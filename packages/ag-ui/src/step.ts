import type { ToolDisplayIcon, ToolDisplaySource } from "@b4run/sdk"

/** The AG-UI `CUSTOM` event name a tool call's human-readable step travels as. */
export const B4_STEP_EVENT_NAME = "b4.step"

export type B4StepStatus = "running" | "completed" | "failed"

/** `CustomEvent.value` for `b4.step`. */
export interface B4StepEventValue {
  readonly toolCallId: string
  readonly status: B4StepStatus
  readonly icon?: ToolDisplayIcon
  readonly label?: string
  readonly sources?: readonly ToolDisplaySource[]
}
