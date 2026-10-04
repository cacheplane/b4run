import type { StepView, ToolStep } from "./turns.js"

/** Client-side wording for a tool: reword, localize, or label a group. */
export interface StepLabelOverride {
  readonly icon?: string
  readonly running?: (args: unknown) => string
  readonly done?: (args: unknown, result: string | undefined) => string
  readonly group?: (count: number) => string
}

export type StepLabelOverrides = Readonly<Record<string, StepLabelOverride>>

/** Group wording for B4.run's built-in tools; apps extend it through overrides. */
export const BUILT_IN_GROUP_LABELS: Readonly<Record<string, (count: number) => string>> = {
  readFile: (n) => `Read ${n} files`,
  writeFile: (n) => `Saved ${n} files`,
  editFile: (n) => `Edited ${n} files`,
  listDir: (n) => `Listed ${n} directories`,
  runBash: (n) => `Ran ${n} commands`,
  recall: (n) => `Checked memory ${n} times`,
  readSkill: (n) => `Loaded ${n} skills`,
}

/** Tools a chat presents some other way; never merged into a group. */
const NEVER_GROUPED: ReadonlySet<string> = new Set(["task", "writeTodos"])

/** Labels are plain text; anything longer than this is cut with an ellipsis. */
const MAX_LABEL_LENGTH = 120

function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args)
  } catch {
    return undefined
  }
}

function tryLabel(produce: () => string): string | undefined {
  try {
    const label = produce()
    return typeof label === "string" && label !== "" ? label : undefined
  } catch {
    return undefined
  }
}

function truncate(label: string): string {
  const chars = [...label]
  return chars.length > MAX_LABEL_LENGTH
    ? `${chars.slice(0, MAX_LABEL_LENGTH - 1).join("")}…`
    : label
}

/**
 * The sentence for a tool step: the server's `b4.step` label, else the
 * app's override for that tool (given parsed args), else "Using X…" /
 * "Used X". Never throws, never echoes raw arguments, and never returns more
 * than 120 characters.
 */
export function stepLabel(step: ToolStep, overrides: StepLabelOverrides = {}): string {
  if (step.label !== undefined) return truncate(step.label)
  const override = overrides[step.name]
  const live = step.status === "pending" || step.status === "running" || step.status === "awaiting"
  if (override !== undefined) {
    const args = parseArgs(step.args)
    const produced = live
      ? override.running && tryLabel(() => override.running?.(args) ?? "")
      : override.done && tryLabel(() => override.done?.(args, step.result) ?? "")
    if (produced) return truncate(produced)
  }
  return live ? `Using ${step.name}…` : `Used ${step.name}`
}

export interface StepGroup {
  readonly kind: "group"
  readonly name: string
  readonly label: string
  readonly steps: readonly ToolStep[]
}

export type GroupedStep = StepView | StepGroup

/**
 * Consecutive done calls of one tool, two or more, folded into a group with a
 * summary label ("Read 2 files"). Running, failed and awaiting steps never
 * join a group, and `task`/`writeTodos` never do. Steps that are not grouped
 * are returned as the same objects they came in as.
 */
export function groupSteps(
  steps: readonly StepView[],
  overrides: StepLabelOverrides = {},
): readonly GroupedStep[] {
  const out: GroupedStep[] = []
  let run: ToolStep[] = []
  const flush = () => {
    if (run.length >= 2) {
      const name = (run[0] as ToolStep).name
      const label =
        overrides[name]?.group ??
        BUILT_IN_GROUP_LABELS[name] ??
        ((n: number) => `Used ${name} ${n} times`)
      out.push({ kind: "group", name, label: truncate(label(run.length)), steps: run })
    } else {
      out.push(...run)
    }
    run = []
  }
  for (const step of steps) {
    const groupable =
      step.kind === "tool" && step.status === "done" && !NEVER_GROUPED.has(step.name)
    if (groupable && (run.length === 0 || (run[0] as ToolStep).name === step.name)) {
      run.push(step)
      continue
    }
    flush()
    if (groupable) run.push(step)
    else out.push(step)
  }
  flush()
  return out
}
