/**
 * The activity kit's wording, framework-free: what a turn's summary line, a
 * step's muted tail, a subagent row and a step's detail panel say. The React
 * kit (`./react`) and the Angular kit (`@b4run/ag-ui-angular`) both render
 * from these, so the two can never word a turn differently.
 */
import type { B4PlanActivityContent } from "../activities.js"
import { type StepGroup, type StepLabelOverrides, stepLabel } from "./labels.js"
import type { ReasoningStep, StepView, SubagentStep, ToolStep, TurnView } from "./turns.js"

/**
 * `<1s`, `Ns`, `Nm Ms` (the host chat's format). Undefined for an unknown or
 * negative duration: the UI then drops the time rather than claiming `<1s`.
 */
export function formatDuration(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return "<1s"
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const isTool = (step: StepView): step is ToolStep => step.kind === "tool"

/** Steps in this turn and every nested subagent turn (a subagent counts as one step too). */
export function countSteps(turn: TurnView): number {
  let n = 0
  for (const step of turn.steps) {
    n += 1
    if (step.kind === "subagent") n += countSteps(step.turn)
  }
  return n
}

/** Sources cited by this turn's tool steps and every nested subagent turn's. */
export function countSources(turn: TurnView): number {
  let n = 0
  for (const step of turn.steps) {
    if (isTool(step)) n += step.sources?.length ?? 0
    else if (step.kind === "subagent") n += countSources(step.turn)
  }
  return n
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`

export interface SummaryLine {
  /** The sentence ("Searching the corpus", "Worked for 1m 12s"). */
  readonly text: string
  /** The muted tail ("· 12s", "· 9 steps · 3 sources · 1 failed"), possibly empty. */
  readonly meta: string
  /** Whether the text is the running treatment (shimmer) — only while working. */
  readonly live: boolean
}

/**
 * The newest running tool step, searching nested turns too, worded through
 * `stepLabel` so the app's overrides and the "Using x…" fallback apply.
 */
function activeLabel(turn: TurnView, labels: StepLabelOverrides | undefined): string | undefined {
  let best: ToolStep | undefined
  const visit = (t: TurnView) => {
    for (const step of t.steps) {
      if (isTool(step) && step.status === "running") {
        if (best === undefined || step.startedAt >= best.startedAt) best = step
      } else if (step.kind === "subagent") visit(step.turn)
    }
  }
  visit(turn)
  return best === undefined ? undefined : stepLabel(best, labels)
}

/** The summary line for a turn at time `now` (spec §3.1). */
export function summaryLine(
  turn: TurnView,
  now: number,
  labels?: StepLabelOverrides | undefined,
): SummaryLine {
  const elapsed = formatDuration((turn.endedAt ?? now) - turn.startedAt)
  const tick = elapsed === undefined ? "" : `· ${elapsed}`
  switch (turn.status) {
    case "working":
      return { text: activeLabel(turn, labels) ?? "Working", meta: tick, live: true }
    case "awaiting":
      return { text: "Waiting for your approval", meta: tick, live: false }
    case "stopped":
      return {
        text: elapsed === undefined ? "Stopped" : `Stopped after ${elapsed}`,
        meta: "",
        live: false,
      }
    default: {
      const parts = [plural(countSteps(turn), "step")]
      const sources = countSources(turn)
      if (sources > 0) parts.push(plural(sources, "source"))
      if (turn.failed > 0) parts.push(`${turn.failed} failed`)
      return {
        text: elapsed === undefined ? "Worked" : `Worked for ${elapsed}`,
        meta: `· ${parts.join(" · ")}`,
        live: false,
      }
    }
  }
}

/** Where a subagent's own turn stands, as its parent row sees it. */
export interface NestedTurn {
  readonly name: string
  readonly status: SubagentStep["status"]
}

/**
 * The summary of a subagent's own turn. While the subagent runs it reads like
 * any turn (spec §3.1: the active step's label, the elapsed tick); once it
 * pauses or settles it names the subagent: "researcher · paused",
 * "researcher finished · 5 steps", "researcher failed · boom".
 */
export function nestedSummaryLine(
  turn: TurnView,
  nested: NestedTurn,
  now: number,
  labels?: StepLabelOverrides | undefined,
): SummaryLine {
  const steps = `· ${plural(countSteps(turn), "step")}`
  switch (nested.status) {
    case "running":
      return summaryLine(turn, now, labels)
    case "paused":
      return { text: `${nested.name} · paused`, meta: "", live: false }
    case "failed":
      return {
        text: `${nested.name} failed`,
        meta: turn.error ? `· ${turn.error}` : steps,
        live: false,
      }
    default:
      return { text: `${nested.name} finished`, meta: steps, live: false }
  }
}

/** A tool step's muted tail: awaiting approval, denied, or failed with no error text to open. */
export function stepMeta(step: ToolStep): string {
  if (step.status === "awaiting") return "· awaiting approval"
  if (step.status === "denied") return "· denied"
  if (step.status === "failed" && step.result === undefined) return "· failed"
  return ""
}

/** A merged group's muted tail: the sources its calls cite, when any. */
export function groupMeta(group: StepGroup): string {
  const sources = group.steps.reduce((n, step) => n + (step.sources?.length ?? 0), 0)
  return sources > 0 ? `· ${plural(sources, "source")}` : ""
}

/**
 * An own-key lookup: tool names come off the wire, so a per-tool table must
 * not find `toString` on `Object.prototype`.
 */
export function ownEntry<T>(
  table: Readonly<Record<string, T>> | undefined,
  key: string | undefined,
): T | undefined {
  return table !== undefined && key !== undefined && Object.hasOwn(table, key)
    ? table[key]
    : undefined
}

export function planProgress(todos: B4PlanActivityContent["todos"]): {
  done: number
  total: number
} {
  return { done: todos.filter((t) => t.status === "completed").length, total: todos.length }
}

/** A plan item's status as the visually hidden text after it: " (done)". */
export function todoStatusLabel(status: B4PlanActivityContent["todos"][number]["status"]): string {
  if (status === "completed") return " (done)"
  if (status === "in_progress") return " (in progress)"
  return " (pending)"
}

/** "Thinking…", "Thought for 4s", or "Show reasoning" when the duration is unknown (spec §3). */
export function reasoningLabel(step: ReasoningStep): string {
  if (step.status === "streaming") return "Thinking…"
  const d =
    step.settledAt === undefined ? undefined : formatDuration(step.settledAt - step.startedAt)
  return d === undefined ? "Show reasoning" : `Thought for ${d}`
}

/** A paused subagent is waiting on an approval, so its row reads as awaiting. */
const SUBAGENT_ROW_STATE = {
  running: "running",
  paused: "awaiting",
  done: "done",
  failed: "failed",
} as const

/** The `data-state` of a subagent's row. */
export function subagentRowState(
  status: SubagentStep["status"],
): (typeof SUBAGENT_ROW_STATE)[keyof typeof SUBAGENT_ROW_STATE] {
  return SUBAGENT_ROW_STATE[status]
}

/** Whether a subagent is still running or paused on an approval. */
export const isSubagentLive = (step: Pick<SubagentStep, "status">): boolean =>
  step.status === "running" || step.status === "paused"

/** A settled subagent row's sentence: "researcher finished", "researcher failed". */
export function subagentSettledText(step: Pick<SubagentStep, "name" | "status">): string {
  return step.status === "failed" ? `${step.name} failed` : `${step.name} finished`
}

/** A subagent row's muted tail: the error once failed, the step count once done. */
export function subagentMeta(step: SubagentStep): string {
  if (step.status === "failed") return step.error ? `· ${step.error}` : ""
  if (isSubagentLive(step)) return ""
  return `· ${plural(countSteps(step.turn), "step")}`
}

/** JSON pretty-printed with two spaces; anything else (or invalid JSON) as-is. Never throws. */
export function prettyValue(text: string): string {
  if (text.trim() === "") return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** A step's inputs or output longer than this is cut; a tool can return megabytes. */
export const MAX_DETAIL_CHARS = 20_000

/** `text`, or its first `MAX_DETAIL_CHARS` characters followed by a "… (truncated)" line. */
export function capDetail(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n… (truncated)` : text
}

/** A step's Inputs and Output as the detail panel shows them; empty strings when absent. */
export function stepDetailText(
  args: string,
  result: string | undefined,
): { readonly inputs: string; readonly output: string; readonly empty: boolean } {
  const inputs = capDetail(prettyValue(args))
  const output = result === undefined ? "" : capDetail(prettyValue(result))
  return { inputs, output, empty: inputs.trim() === "" && output.trim() === "" }
}

/** Sources come off the wire: only web, mail and same-origin paths become links. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:|\/)/i
export const isSafeHref = (href: string): boolean => SAFE_HREF.test(href)
