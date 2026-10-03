import {
  TOOL_DISPLAY_LABEL_MAX,
  type ToolDisplay,
  type ToolDisplayIcon,
  type ToolDisplaySource,
} from "@b4run/sdk"
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch/web"
import type { RunnableConfig } from "@langchain/core/runnables"

/** The name of the AG-UI `CUSTOM` event (and the LangChain custom event) a step travels as. */
export const B4_STEP_EVENT_NAME = "b4.step"

/** What one `b4.step` dispatch carries, before the adapter adds identity. */
export interface StepPayload {
  readonly icon?: ToolDisplayIcon
  readonly label?: string
  readonly sources?: readonly ToolDisplaySource[]
}

export interface StepEventData extends StepPayload {
  readonly tool_call_id: string
  readonly status: "running" | "completed"
}

const warned = new Set<string>()

function warnOnce(toolName: string, field: string): void {
  const key = `${toolName}\u0000${field}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[b4] display.${field} for tool "${toolName}" threw; using the default label`)
}

function truncate(label: string): string {
  return label.length > TOOL_DISPLAY_LABEL_MAX
    ? `${label.slice(0, TOOL_DISPLAY_LABEL_MAX - 1)}…`
    : label
}

function readLabel(
  toolName: string,
  field: "running" | "done",
  produce: () => unknown,
): string | undefined {
  try {
    const value = produce()
    if (value === undefined || value === null) return undefined
    return truncate(String(value))
  } catch {
    warnOnce(toolName, field)
    return undefined
  }
}

function readSources(
  toolName: string,
  produce: () => unknown,
): readonly ToolDisplaySource[] | undefined {
  try {
    const value = produce()
    if (!Array.isArray(value)) return undefined
    const sources: ToolDisplaySource[] = []
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) continue
      const { title, href } = entry as { title?: unknown; href?: unknown }
      if (typeof title !== "string" || title === "") continue
      sources.push({ title, ...(typeof href === "string" && href !== "" ? { href } : {}) })
    }
    return sources
  } catch {
    warnOnce(toolName, "sources")
    return undefined
  }
}

/** The step as a call begins: icon plus the `running` sentence. Never throws. */
export function describeRunning(
  display: ToolDisplay,
  input: unknown,
  toolName: string,
): StepPayload {
  const label = display.running
    ? readLabel(toolName, "running", () => display.running?.(input))
    : undefined
  return {
    ...(display.icon !== undefined ? { icon: display.icon } : {}),
    ...(label !== undefined ? { label } : {}),
  }
}

/** The step as a call returns: icon, the `done` sentence, and its sources. Never throws. */
export function describeDone(
  display: ToolDisplay,
  input: unknown,
  output: unknown,
  toolName: string,
): StepPayload {
  const label = display.done
    ? readLabel(toolName, "done", () => display.done?.(input, output))
    : undefined
  const sources = display.sources
    ? readSources(toolName, () => display.sources?.(output))
    : undefined
  return {
    ...(display.icon !== undefined ? { icon: display.icon } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(sources !== undefined ? { sources } : {}),
  }
}

/** Stream one step over LangChain's custom-event channel; a failure never fails the tool. */
export async function dispatchStep(
  config: RunnableConfig | undefined,
  data: StepEventData,
): Promise<void> {
  try {
    await dispatchCustomEvent(B4_STEP_EVENT_NAME, data, config)
  } catch {
    // Display is secondary; the tool result is what matters.
  }
}
