import type { BaseEvent, CustomEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { isToolDisplayIcon, readToolStep, type ToolDisplaySource } from "@b4run/sdk"
import { B4_STEP_EVENT_NAME, B4_STEP_STATUSES, type B4StepEventValue } from "../step.js"

export { B4_STEP_EVENT_NAME, B4_STEP_STATUSES }

const STATUSES: ReadonlySet<string> = new Set<string>(B4_STEP_STATUSES)

/**
 * The `b4.step` value an event carries in the legacy shape, or undefined for
 * any other event or a malformed identity (a non-empty string `toolCallId` and
 * a legacy `status`: `running`, `completed`, `failed` or `denied`). Reads
 * through `readToolStep`, so v1 values are accepted too and narrowed back:
 * `icon` must be a known icon, `label` a non-empty string, and `sources` keep
 * only `title` and `href`.
 *
 * @deprecated Read `CustomEvent.value` with `readToolStep` from `@b4run/sdk`,
 * which returns the v1 `B4ToolStep` (and knows `cancelled`).
 */
export function readStepEvent(event: BaseEvent): B4StepEventValue | undefined {
  if (event.type !== EventType.CUSTOM) return undefined
  const custom = event as CustomEvent
  if (custom.name !== B4_STEP_EVENT_NAME) return undefined
  const step = readToolStep(custom.value)
  const toolCallId = step?.toolCallId
  if (step?.status === undefined || toolCallId === undefined) return undefined
  if (!STATUSES.has(step.status)) return undefined
  const { icon, label, sources } = step
  return {
    toolCallId,
    status: step.status as B4StepEventValue["status"],
    ...(isToolDisplayIcon(icon) ? { icon } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(sources !== undefined
      ? {
          sources: sources.map(
            ({ title, href }): ToolDisplaySource => ({
              title,
              ...(href !== undefined ? { href } : {}),
            }),
          ),
        }
      : {}),
  }
}
