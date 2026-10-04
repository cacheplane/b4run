import type { BaseEvent, CustomEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { B4_STEP_EVENT_NAME, type B4StepEventValue } from "../step.js"

export { B4_STEP_EVENT_NAME }

const STATUSES: ReadonlySet<string> = new Set(["running", "completed", "failed"])

/** The `b4.step` value an event carries, or undefined for any other event or a malformed value. */
export function readStepEvent(event: BaseEvent): B4StepEventValue | undefined {
  if (event.type !== EventType.CUSTOM) return undefined
  const custom = event as CustomEvent
  if (custom.name !== B4_STEP_EVENT_NAME) return undefined
  const value = custom.value as Record<string, unknown> | null | undefined
  if (typeof value !== "object" || value === null) return undefined
  if (typeof value.toolCallId !== "string" || value.toolCallId === "") return undefined
  if (typeof value.status !== "string" || !STATUSES.has(value.status)) return undefined
  return value as unknown as B4StepEventValue
}
