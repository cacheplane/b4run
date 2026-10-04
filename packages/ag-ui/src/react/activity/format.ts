import type { B4PlanActivityContent } from "../../activities.js"
import { type StepLabelOverrides, stepLabel } from "../../view/labels.js"
import type { ReasoningStep, StepView, ToolStep, TurnView } from "../../view/turns.js"

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

export function planProgress(todos: B4PlanActivityContent["todos"]): {
  done: number
  total: number
} {
  return { done: todos.filter((t) => t.status === "completed").length, total: todos.length }
}

/** "Thinking…", "Thought for 4s", or "Show reasoning" when the duration is unknown (spec §3). */
export function reasoningLabel(step: ReasoningStep): string {
  if (step.status === "streaming") return "Thinking…"
  const d =
    step.settledAt === undefined ? undefined : formatDuration(step.settledAt - step.startedAt)
  return d === undefined ? "Show reasoning" : `Thought for ${d}`
}
