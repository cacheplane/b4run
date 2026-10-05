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

/** The converter sets `tool_call_id` and `status`; this module only produces the payload. */
export interface StepEventData extends StepPayload {
  readonly tool_call_id: string
  readonly status: "running" | "completed" | "denied"
}

const warned = new Set<string>()

function warnOnce(toolName: string, field: string, detail: string): void {
  const key = `${toolName}\u0000${field}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[b4] display.${field} for tool "${toolName}" ${detail}`)
}

function truncate(label: string): string {
  if (label.length <= TOOL_DISPLAY_LABEL_MAX) return label
  let head = label.slice(0, TOOL_DISPLAY_LABEL_MAX - 1)
  const last = head.charCodeAt(head.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1)
  return `${head}…`
}

function readLabel(
  toolName: string,
  field: "running" | "done",
  produce: () => unknown,
): string | undefined {
  try {
    const value = produce()
    if (value === undefined || value === null) return undefined
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      warnOnce(toolName, field, "returned a non-text value; using the default label")
      return undefined
    }
    const text = String(value).trim()
    if (text === "") return undefined
    return truncate(text)
  } catch {
    warnOnce(toolName, field, "threw; using the default label")
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
    warnOnce(toolName, "sources", "threw; showing no sources")
    return undefined
  }
}

/** The step as a call begins: icon plus the `running` sentence. Never throws. */
export function describeRunning(
  display: ToolDisplay,
  input: unknown,
  toolName: string,
): StepPayload {
  const fn = display.running
  const label = fn ? readLabel(toolName, "running", () => fn(input)) : undefined
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
  const doneFn = display.done
  const sourcesFn = display.sources
  const label = doneFn ? readLabel(toolName, "done", () => doneFn(input, output)) : undefined
  const sources = sourcesFn ? readSources(toolName, () => sourcesFn(output)) : undefined
  return {
    ...(display.icon !== undefined ? { icon: display.icon } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(sources !== undefined ? { sources } : {}),
  }
}

/**
 * The step as a denied call returns (`status: "denied"`): the icon alone. The
 * denial text is the model's result, not a thing the tool did, so `done` and
 * `sources` are never asked to describe it — they would read it as output (a
 * "48 hits" label for a 48-character reason).
 */
export function describeDenied(display: ToolDisplay): StepPayload {
  return display.icon !== undefined ? { icon: display.icon } : {}
}

/**
 * The step for a tool that threw: the icon only. There is no output for `done`
 * to describe, so the label is the client's fallback. Without a display, bare.
 */
export function describeFailed(display: ToolDisplay | undefined): StepPayload {
  return display?.icon !== undefined ? { icon: display.icon } : {}
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
