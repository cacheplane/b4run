import type { StepView, TurnsView, TurnView } from "@b4run/ag-ui/view"
import type { Navlog } from "./navlog-types"

/** The subset of an AG-UI message this selector reads. */
export interface MessageLike {
  readonly id: string
  readonly role: string
  readonly content?: unknown
  readonly toolCallId?: string
  readonly toolCalls?: readonly {
    readonly id: string
    readonly function: { readonly name: string }
  }[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** Parse a `computeNavlog` tool result (JSON text, or a `{ result }` envelope) into a Navlog, or null. */
export function parseNavlog(text: string): Navlog | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const candidate =
    isRecord(parsed) && "result" in parsed && isRecord(parsed.result) ? parsed.result : parsed
  if (!isRecord(candidate)) return null
  if (
    !Array.isArray(candidate.legs) ||
    !Array.isArray(candidate.waypoints) ||
    !isRecord(candidate.totals) ||
    !isRecord(candidate.flightPlan)
  ) {
    return null
  }
  return candidate as unknown as Navlog
}

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("")
  }
  return ""
}

export interface ToolResultRef {
  readonly id: string
  readonly result: string
}

function findToolResult(
  turn: TurnView,
  name: string,
  accept: (result: string) => boolean,
): ToolResultRef | null {
  for (let i = turn.steps.length - 1; i >= 0; i--) {
    const step: StepView | undefined = turn.steps[i]
    if (step === undefined) continue
    if (step.kind === "subagent") {
      const nested = findToolResult(step.turn, name, accept)
      if (nested !== null) return nested
    } else if (
      step.kind === "tool" &&
      step.name === name &&
      step.status === "done" &&
      step.result !== undefined &&
      accept(step.result)
    ) {
      return { id: step.id, result: step.result }
    }
  }
  return null
}

/** Newest turn first, newest step first, recursing into subagent turns; done tool steps named `name` whose result passes `accept`. */
export function latestToolResult(
  view: TurnsView,
  name: string,
  accept: (result: string) => boolean,
): ToolResultRef | null {
  for (let i = view.turns.length - 1; i >= 0; i--) {
    const turn = view.turns[i]
    if (turn === undefined) continue
    const found = findToolResult(turn, name, accept)
    if (found !== null) return found
  }
  return null
}

/** The latest done computeNavlog step whose result parses (a failed call leaves the last good plan up). */
export function latestNavlogResult(view: TurnsView): ToolResultRef | null {
  return latestToolResult(view, "computeNavlog", (result) => parseNavlog(result) !== null)
}

/** Whether the latest turn is parked on an approval. */
export function isAwaitingApproval(view: TurnsView): boolean {
  return view.turns.at(-1)?.status === "awaiting"
}

/**
 * The planning answer for the navlog on screen: the last non-empty assistant
 * prose AFTER the tool message `toolCallId` and before the next user message —
 * the reply of the turn that produced the navlog. A later turn's reply
 * ("Filed.") never replaces the brief. Empty while that turn has not answered.
 */
export function navlogAnswerText(messages: readonly MessageLike[], toolCallId: string): string {
  const resultAt = messages.findIndex(
    (message) => message.role === "tool" && message.toolCallId === toolCallId,
  )
  if (resultAt < 0) return ""
  let answer = ""
  for (const message of messages.slice(resultAt + 1)) {
    if (message.role === "user") break
    if (message.role !== "assistant") continue
    const text = contentText(message.content).trim()
    if (text.length > 0) answer = text
  }
  return answer
}
