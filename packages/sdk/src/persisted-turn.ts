import { isToolDisplayIcon, type ToolDisplayIcon, type ToolDisplaySource } from "./tool-display.js"

/** `additional_kwargs` key: the step a ToolMessage persists (every tool, display or not). */
export const B4_STEP_KEY = "b4_step"
/** `additional_kwargs` key: the subagent a `task` ToolMessage launched. */
export const B4_SUBAGENT_KEY = "b4_subagent"
/** Checkpoint-metadata key: how and when the turn that owns this checkpoint ended. */
export const B4_TURN_METADATA_KEY = "b4:turn"

/** How a permission gate was answered for a call. */
export type GateDecision = "once" | "always" | "deny"

/**
 * The step a ToolMessage carries for a restored thread (spec §2.1). Times are
 * ISO strings. `denied` is a call a gate blocked, persisted on a `success`
 * ToolMessage: not a failure, never a success label.
 */
export interface PersistedStep {
  readonly status: "completed" | "failed" | "denied"
  readonly icon?: ToolDisplayIcon
  readonly label?: string
  readonly sources?: readonly ToolDisplaySource[]
  readonly startedAt: string
  readonly settledAt: string
  readonly decision?: GateDecision
}

/** The subagent a `task` call launched, on its ToolMessage (spec §2.1). */
export interface PersistedSubagent {
  readonly name: string
  readonly routeId: string
  readonly description?: string
  readonly depth: number
  /** The child's LangGraph checkpoint namespace, e.g. `tools:<task id>`. */
  readonly checkpointNs: string
  readonly outcome: "done" | "failed" | "suspended"
  readonly error?: string
}

/** How a turn ended, stamped on the head checkpoint's metadata when the run ends (spec §2.2). */
export interface PersistedTurnEnd {
  readonly status: "done" | "failed" | "stopped"
  readonly error?: string
  readonly endedAt: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value))

const DECISIONS: ReadonlySet<string> = new Set(["once", "always", "deny"])

function readSources(value: unknown): readonly ToolDisplaySource[] | undefined {
  if (!Array.isArray(value)) return undefined
  const sources: ToolDisplaySource[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.title !== "string" || entry.title === "") continue
    sources.push({
      title: entry.title,
      ...(typeof entry.href === "string" ? { href: entry.href } : {}),
    })
  }
  return sources
}

/** A `b4_step` stamp, or undefined when its identity fields are missing. Invalid optional fields are dropped. */
export function readPersistedStep(value: unknown): PersistedStep | undefined {
  if (!isRecord(value)) return undefined
  if (value.status !== "completed" && value.status !== "failed" && value.status !== "denied") {
    return undefined
  }
  if (!isIsoDate(value.startedAt) || !isIsoDate(value.settledAt)) return undefined
  const sources = readSources(value.sources)
  return {
    status: value.status,
    startedAt: value.startedAt,
    settledAt: value.settledAt,
    ...(isToolDisplayIcon(value.icon) ? { icon: value.icon } : {}),
    ...(typeof value.label === "string" && value.label !== "" ? { label: value.label } : {}),
    ...(sources !== undefined ? { sources } : {}),
    ...(typeof value.decision === "string" && DECISIONS.has(value.decision)
      ? { decision: value.decision as GateDecision }
      : {}),
  }
}

/** A `b4_subagent` stamp, or undefined when any required field is missing or malformed. */
export function readPersistedSubagent(value: unknown): PersistedSubagent | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.name !== "string" || value.name === "") return undefined
  if (typeof value.routeId !== "string" || value.routeId === "") return undefined
  if (typeof value.depth !== "number" || !Number.isInteger(value.depth) || value.depth < 1)
    return undefined
  if (typeof value.checkpointNs !== "string" || value.checkpointNs === "") return undefined
  if (value.outcome !== "done" && value.outcome !== "failed" && value.outcome !== "suspended")
    return undefined
  return {
    name: value.name,
    routeId: value.routeId,
    depth: value.depth,
    checkpointNs: value.checkpointNs,
    outcome: value.outcome,
    ...(typeof value.description === "string" && value.description !== ""
      ? { description: value.description }
      : {}),
    ...(typeof value.error === "string" && value.error !== "" ? { error: value.error } : {}),
  }
}

/** A `b4:turn` stamp, or undefined when malformed. */
export function readPersistedTurnEnd(value: unknown): PersistedTurnEnd | undefined {
  if (!isRecord(value)) return undefined
  if (value.status !== "done" && value.status !== "failed" && value.status !== "stopped")
    return undefined
  if (!isIsoDate(value.endedAt)) return undefined
  return {
    status: value.status,
    endedAt: value.endedAt,
    ...(typeof value.error === "string" && value.error !== "" ? { error: value.error } : {}),
  }
}
