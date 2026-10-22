import {
  type B4StepSource,
  type B4ToolStep,
  type B4ToolStepStatus,
  type B4ToolStepUpdate,
  mergeToolStep,
} from "@b4run/sdk"
import type { StepSource, StepStatus, StepView, ToolStep, TurnsView, TurnView } from "./turns.js"

/** The error a failed step carries when its producer named none (the contract default). */
const DEFAULT_FAILURE = { message: "Tool call did not finish" } as const

/** View statuses that settle a tool step. */
const SETTLED: ReadonlySet<StepStatus> = new Set(["done", "failed", "denied", "cancelled"])

/** Whether a tool step has settled: done, failed, denied or cancelled. */
export function isSettledStatus(status: StepStatus): boolean {
  return SETTLED.has(status)
}

/** A view status in contract terms: pending, running and awaiting are all `running`. */
function contractStatus(status: StepStatus): B4ToolStepStatus {
  switch (status) {
    case "done":
      return "completed"
    case "failed":
    case "denied":
    case "cancelled":
      return status
    default:
      return "running"
  }
}

/**
 * A merged contract status as the view shows it. `running` keeps the open
 * status the call already had (pending, running, or awaiting an approval),
 * except that a step that explicitly says `running` lifts a pending call.
 */
function viewStatus(
  previous: StepStatus,
  merged: B4ToolStepStatus,
  stated: B4ToolStepStatus | undefined,
): StepStatus {
  if (merged === "completed") return "done"
  if (merged !== "running") return merged
  if (SETTLED.has(previous)) return previous
  return previous === "pending" && stated === "running" ? "running" : previous
}

/** A view source in contract shape: a source with no id or kind gets the legacy defaults. */
function contractSource(source: StepSource, toolCallId: string, index: number): B4StepSource {
  return {
    ...source,
    id: source.id ?? `${toolCallId}:${index}`,
    kind: source.kind ?? (source.href !== undefined ? "url" : "record"),
  }
}

/** One tool step in contract shape, without `toolCallId` (the record key carries it). */
function toContractStep(step: ToolStep): B4ToolStep {
  const status = contractStatus(step.status)
  return {
    v: 1,
    kind: step.toolKind ?? "server",
    status,
    ...(step.builtin !== undefined ? { builtin: step.builtin } : {}),
    ...(step.provider !== undefined ? { provider: step.provider } : {}),
    ...(step.label !== undefined ? { label: step.label } : {}),
    ...(step.icon !== undefined ? { icon: step.icon } : {}),
    ...(step.queries !== undefined ? { queries: step.queries } : {}),
    ...(step.sources !== undefined
      ? { sources: step.sources.map((source, i) => contractSource(source, step.id, i)) }
      : {}),
    startedAt: step.startedAt,
    ...(step.settledAt !== undefined ? { settledAt: step.settledAt } : {}),
    ...(status === "failed" ? { error: step.error ?? DEFAULT_FAILURE } : {}),
    ...(step.decision !== undefined ? { decision: step.decision } : {}),
  }
}

function collect(turn: TurnView, into: Record<string, B4ToolStep>): void {
  for (const step of turn.steps as readonly StepView[]) {
    if (step.kind === "tool") into[step.id] = toContractStep(step)
    else if (step.kind === "subagent") collect(step.turn, into)
  }
}

/**
 * Every tool step of a thread view in `b4.step` contract shape, keyed by tool
 * call id, nested subagent turns included. Statuses map to contract terms:
 * `pending`, `running` and `awaiting` read `running`, `done` reads
 * `completed`, and `failed`, `denied` and `cancelled` read as themselves. A
 * failed step without a producer error carries the contract's default error.
 * Times are the view's clock (epoch ms by default).
 */
export function toContractSteps(view: TurnsView): Record<string, B4ToolStep> {
  const steps: Record<string, B4ToolStep> = {}
  for (const turn of view.turns) collect(turn, steps)
  return steps
}

const json = (value: unknown): string | undefined =>
  value === undefined ? undefined : JSON.stringify(value)

/** Whether two tool steps show the same step (so the old one keeps its identity); ignores args and result. */
export function sameToolStep(a: ToolStep, b: ToolStep): boolean {
  return (
    a.status === b.status &&
    a.settledAt === b.settledAt &&
    a.icon === b.icon &&
    a.label === b.label &&
    a.toolKind === b.toolKind &&
    a.builtin === b.builtin &&
    a.provider === b.provider &&
    a.decision === b.decision &&
    (a.sources === b.sources || json(a.sources) === json(b.sources)) &&
    json(a.queries) === json(b.queries) &&
    json(a.error) === json(b.error)
  )
}

/**
 * Folds one `b4.step` update into a tool step by the contract's merge rules
 * (`mergeToolStep`): `failed` wins; `completed`, `denied` and `cancelled`
 * settle an unfailed step; `running` only lifts an unsettled one and adds
 * nothing to a settled one; a `"message"` source (the call's result) beats a
 * `"call"` source; a settle out of running drops the running label and
 * sources unless it restates them. The view keeps its
 * own clock: a step that settles here takes `at` unless it already settled.
 * `error` is kept only when a producer sent one. Returns `step` itself when
 * nothing it shows changed.
 */
export function mergeIntoToolStep(
  step: ToolStep,
  update: B4ToolStepUpdate,
  source: "call" | "message",
  at: number,
): ToolStep {
  const merged = mergeToolStep(toContractStep(step), update, source)
  const status = viewStatus(step.status, merged.status, update.status)
  const {
    label: _label,
    sources: _sources,
    icon: _icon,
    toolKind: _toolKind,
    builtin: _builtin,
    provider: _provider,
    queries: _queries,
    error: _error,
    decision: _decision,
    ...frame
  } = step
  const producerError =
    merged.error !== undefined && (update.error !== undefined || step.error !== undefined)
  const patched: ToolStep = {
    ...frame,
    ...(merged.icon !== undefined ? { icon: merged.icon } : {}),
    ...(merged.label !== undefined ? { label: merged.label } : {}),
    ...(merged.sources !== undefined ? { sources: merged.sources } : {}),
    ...(merged.kind === "provider" ? { toolKind: merged.kind } : {}),
    ...(merged.builtin !== undefined ? { builtin: merged.builtin } : {}),
    ...(merged.provider !== undefined ? { provider: merged.provider } : {}),
    ...(merged.queries !== undefined ? { queries: merged.queries } : {}),
    ...(producerError && merged.error !== undefined ? { error: merged.error } : {}),
    ...(merged.decision !== undefined ? { decision: merged.decision } : {}),
    status,
    ...(SETTLED.has(status) ? { settledAt: step.settledAt ?? at } : {}),
  }
  return sameToolStep(step, patched) ? step : patched
}
