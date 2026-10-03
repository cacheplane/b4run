import { type ActivitySnapshotEvent, EventType } from "@ag-ui/core"

export const B4_PLAN_ACTIVITY_TYPE = "b4.plan"

export interface B4PlanActivityContent {
  readonly todos: ReadonlyArray<{
    readonly content: string
    readonly status: "pending" | "in_progress" | "completed"
  }>
}

/**
 * The capability chunks that become activities. A subagent's lifecycle is no
 * longer one of them: it is presented with AG-UI 1.0's `SUBAGENT_*` events and
 * `subagentRunId` attribution (see `outbound.ts`), and a child's own
 * `plan_update` reaches this projector unwrapped, with the child as `owner`.
 */
export type B4ActivityChunkType = "plan_update"

/** The one built-in orchestration tool that has a canonical activity. */
export type OrchestrationToolName = "writeTodos"

/**
 * Correlation between a recognized activity and the root tool call that
 * produced it, keyed by the model/provider tool-call id (logical identity).
 * Package-private: it never reaches the wire. The consumer is the
 * orchestration suppression ledger, which decides whether the generic tool
 * frames for that call are redundant with the activity emitted here.
 * Populated at exactly one boundary: a valid ROOT `plan_update` carrying a
 * non-empty `tool_call_id`. A child's plan never correlates — nothing of a
 * child's is suppressed.
 */
export interface B4ActivityCorrelation {
  readonly toolCallId: string
  readonly toolName: OrchestrationToolName
}

/** An activity projection plus optional orchestration correlation. */
export interface ProjectedB4Activity {
  readonly event: ActivitySnapshotEvent | null
  readonly orchestration?: B4ActivityCorrelation
}

export interface B4ActivityProjector {
  /**
   * `owner` is the subagent (`call_id`, also its AG-UI `subagentRunId`) whose
   * plan this is; absent for the root agent's own plan.
   */
  project(type: B4ActivityChunkType, data: unknown, owner?: string): ProjectedB4Activity
}

export function isB4ActivityChunkType(value: string): value is B4ActivityChunkType {
  return value === "plan_update"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseTodos(data: unknown): B4PlanActivityContent["todos"] | null {
  try {
    if (!isRecord(data) || !Array.isArray(data.todos)) return null

    const parsed: Array<B4PlanActivityContent["todos"][number]> = []
    for (const todo of data.todos) {
      if (!isRecord(todo)) return null
      const content = todo.content
      const status = todo.status
      if (typeof content !== "string" || content.trim().length === 0) return null
      if (status !== "pending" && status !== "in_progress" && status !== "completed") return null
      parsed.push({ content: content.trim(), status })
    }
    return parsed
  } catch {
    return null
  }
}

function readRawNonemptyString(data: unknown, key: string): string | null {
  try {
    if (!isRecord(data)) return null
    const value = data[key]
    return typeof value === "string" && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * Plan snapshots: complete replacements under one stable id per owner —
 * `b4:plan:<runId>` for the root agent, `b4:plan:<call_id>` for a subagent,
 * the latter tagged with the child's `subagentRunId`.
 */
export function createB4ActivityProjector(runId: string): B4ActivityProjector {
  return {
    project(type, data, owner) {
      if (type !== "plan_update") return { event: null }
      const parsedTodos = parseTodos(data)
      if (parsedTodos === null) return { event: null }
      const event: ActivitySnapshotEvent = {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: owner === undefined ? `b4:plan:${runId}` : `b4:plan:${owner}`,
        activityType: B4_PLAN_ACTIVITY_TYPE,
        replace: true,
        content: { todos: parsedTodos },
        ...(owner !== undefined ? { subagentRunId: owner } : {}),
      }
      const toolCallId = owner === undefined ? readRawNonemptyString(data, "tool_call_id") : null
      return {
        event,
        ...(toolCallId !== null
          ? { orchestration: { toolCallId, toolName: "writeTodos" as const } }
          : {}),
      }
    },
  }
}
