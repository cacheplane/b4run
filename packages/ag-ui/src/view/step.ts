import type { BaseEvent, CustomEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { isToolDisplayIcon, type ToolDisplaySource } from "@b4run/sdk"
import { B4_STEP_EVENT_NAME, B4_STEP_STATUSES, type B4StepEventValue } from "../step.js"

export { B4_STEP_EVENT_NAME, B4_STEP_STATUSES }

const STATUSES: ReadonlySet<string> = new Set<string>(B4_STEP_STATUSES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readSource(entry: unknown): ToolDisplaySource | undefined {
  if (!isRecord(entry) || typeof entry.title !== "string" || entry.title === "") return undefined
  return {
    title: entry.title,
    ...(typeof entry.href === "string" ? { href: entry.href } : {}),
  }
}

/**
 * The `b4.step` value an event carries, or undefined for any other event or a
 * malformed identity (a non-empty string `toolCallId` and a known `status`).
 * Optional fields are checked individually and dropped when invalid: `icon`
 * must be a known icon, `label` a string, and `sources` keeps only entries with
 * a non-empty string `title` (and `href` only when a string).
 */
export function readStepEvent(event: BaseEvent): B4StepEventValue | undefined {
  if (event.type !== EventType.CUSTOM) return undefined
  const custom = event as CustomEvent
  if (custom.name !== B4_STEP_EVENT_NAME) return undefined
  const value: unknown = custom.value
  if (!isRecord(value)) return undefined
  if (typeof value.toolCallId !== "string" || value.toolCallId === "") return undefined
  if (typeof value.status !== "string" || !STATUSES.has(value.status)) return undefined
  const { icon, label, sources } = value
  return {
    toolCallId: value.toolCallId,
    status: value.status as B4StepEventValue["status"],
    ...(isToolDisplayIcon(icon) ? { icon } : {}),
    ...(typeof label === "string" ? { label } : {}),
    ...(Array.isArray(sources)
      ? {
          sources: sources
            .map(readSource)
            .filter((source): source is ToolDisplaySource => source !== undefined),
        }
      : {}),
  }
}
