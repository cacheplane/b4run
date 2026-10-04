import type { ToolDisplayIcon, ToolDisplaySource } from "@b4run/sdk"

/** The AG-UI `CUSTOM` event name a tool call's human-readable step travels as. */
export const B4_STEP_EVENT_NAME = "b4.step"

/** The statuses a step can carry; the one source for every validator. */
export const B4_STEP_STATUSES = ["running", "completed", "failed"] as const

export type B4StepStatus = (typeof B4_STEP_STATUSES)[number]

/** `CustomEvent.value` for `b4.step`. */
export interface B4StepEventValue {
  readonly toolCallId: string
  readonly status: B4StepStatus
  readonly icon?: ToolDisplayIcon
  readonly label?: string
  readonly sources?: readonly ToolDisplaySource[]
}
