import { B4_STEP_EVENT_NAME, type ToolDisplayIcon, type ToolDisplaySource } from "@b4run/sdk"

/** The AG-UI `CUSTOM` event name a tool call's human-readable step travels as; owned by `@b4run/sdk`. */
export { B4_STEP_EVENT_NAME }

/**
 * The statuses a step can carry.
 *
 * @deprecated Use `B4_TOOL_STEP_STATUSES` from `@b4run/sdk`.
 */
export const B4_STEP_STATUSES = ["running", "completed", "failed", "denied"] as const

/**
 * A legacy step status: `running`, `completed`, `failed` or `denied`.
 *
 * @deprecated Use `B4ToolStepStatus` from `@b4run/sdk`, which adds `cancelled`.
 */
export type B4StepStatus = (typeof B4_STEP_STATUSES)[number]

/**
 * `CustomEvent.value` for `b4.step`.
 *
 * @deprecated Use `B4ToolStep` from `@b4run/sdk`.
 */
export interface B4StepEventValue {
  readonly toolCallId: string
  readonly status: B4StepStatus
  readonly icon?: ToolDisplayIcon
  readonly label?: string
  readonly sources?: readonly ToolDisplaySource[]
}
