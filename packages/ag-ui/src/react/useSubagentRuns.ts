import type { AbstractAgent } from "@ag-ui/client"
import type {
  ActivitySnapshotEvent,
  BaseEvent,
  Message,
  ReasoningMessageContentEvent,
  SubagentErrorEvent,
  SubagentFinishedEvent,
  SubagentStartedEvent,
  TextMessageContentEvent,
  ToolCallArgsEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { useEffect, useState } from "react"
import { B4_PLAN_ACTIVITY_TYPE, type B4PlanActivityContent } from "../activities.js"

/** One tool call a subagent made, as its attributed frames arrived. */
export interface SubagentToolCall {
  readonly id: string
  readonly name: string
  /** The arguments text streamed so far (`TOOL_CALL_ARGS` deltas concatenated). */
  readonly args: string
  readonly result?: string
  readonly status: "running" | "completed"
}

/** Everything a client has learned about one subagent invocation. */
export interface SubagentRun {
  readonly subagentRunId: string
  readonly name: string
  readonly description?: string
  readonly parentToolCallId?: string
  readonly parentSubagentRunId?: string
  readonly status: "running" | "completed" | "suspended" | "failed"
  readonly result?: unknown
  readonly error?: string
  /** Ids of the invocations this one dispatched (`parentSubagentRunId` points back here). */
  readonly children: readonly string[]
  readonly toolCalls: readonly SubagentToolCall[]
  readonly plan?: B4PlanActivityContent["todos"]
  /** The subagent's own assistant prose, concatenated. */
  readonly text: string
  /** The subagent's visible reasoning, concatenated. */
  readonly reasoning: string
}

export interface SubagentRunsState {
  /** The thread the runs belong to; a run on another thread starts over. */
  readonly threadId: string | undefined
  readonly runs: ReadonlyMap<string, SubagentRun>
}

export const EMPTY_SUBAGENT_RUNS: SubagentRunsState = { threadId: undefined, runs: new Map() }

type Attributed = BaseEvent & { readonly subagentRunId?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readPlan(content: unknown): B4PlanActivityContent["todos"] | undefined {
  if (!isRecord(content) || !Array.isArray(content.todos)) return undefined
  const todos: Array<B4PlanActivityContent["todos"][number]> = []
  for (const todo of content.todos) {
    if (!isRecord(todo) || typeof todo.content !== "string") return undefined
    if (todo.status !== "pending" && todo.status !== "in_progress" && todo.status !== "completed") {
      return undefined
    }
    todos.push({ content: todo.content, status: todo.status })
  }
  return todos
}

function withRun(
  state: SubagentRunsState,
  id: string,
  update: (run: SubagentRun) => SubagentRun,
): SubagentRunsState {
  const run = state.runs.get(id)
  if (run === undefined) return state
  const runs = new Map(state.runs)
  runs.set(id, update(run))
  return { threadId: state.threadId, runs }
}

function withToolCall(
  state: SubagentRunsState,
  owner: string,
  toolCallId: string,
  update: (call: SubagentToolCall) => SubagentToolCall,
): SubagentRunsState {
  return withRun(state, owner, (run) => ({
    ...run,
    toolCalls: run.toolCalls.map((call) => (call.id === toolCallId ? update(call) : call)),
  }))
}

/**
 * Fold one AG-UI event into the subagent tree. Pure, so it is testable without
 * React and reusable by a non-React client: `SUBAGENT_STARTED/FINISHED/ERROR`
 * open and close invocations, and every other event tagged `subagentRunId`
 * lands on its invocation. Events for an id this client never saw announced
 * are ignored (the producer may tag without announcing; nothing to show then).
 * A `RUN_STARTED` on a different thread starts over; on the same thread the
 * runs stay, so a resumed invocation (re-announced under the same id) updates
 * in place rather than duplicating.
 */
export function reduceSubagentRuns(state: SubagentRunsState, event: BaseEvent): SubagentRunsState {
  switch (event.type) {
    case EventType.RUN_STARTED: {
      const threadId = (event as { threadId?: unknown }).threadId
      const next = typeof threadId === "string" ? threadId : undefined
      if (next === state.threadId) return state
      return { threadId: next, runs: new Map() }
    }
    case EventType.SUBAGENT_STARTED: {
      const started = event as SubagentStartedEvent
      const existing = state.runs.get(started.subagentRunId)
      const runs = new Map(state.runs)
      runs.set(started.subagentRunId, {
        subagentRunId: started.subagentRunId,
        name: started.name,
        ...(started.description !== undefined ? { description: started.description } : {}),
        ...(started.parentToolCallId !== undefined
          ? { parentToolCallId: started.parentToolCallId }
          : {}),
        ...(started.parentSubagentRunId !== undefined
          ? { parentSubagentRunId: started.parentSubagentRunId }
          : {}),
        status: "running",
        // A continued invocation keeps what the earlier run showed.
        children: existing?.children ?? [],
        toolCalls: existing?.toolCalls ?? [],
        ...(existing?.plan !== undefined ? { plan: existing.plan } : {}),
        text: existing?.text ?? "",
        reasoning: existing?.reasoning ?? "",
      })
      const parent =
        started.parentSubagentRunId !== undefined
          ? runs.get(started.parentSubagentRunId)
          : undefined
      if (parent !== undefined && !parent.children.includes(started.subagentRunId)) {
        runs.set(parent.subagentRunId, {
          ...parent,
          children: [...parent.children, started.subagentRunId],
        })
      }
      return { threadId: state.threadId, runs }
    }
    case EventType.SUBAGENT_FINISHED: {
      const finished = event as SubagentFinishedEvent
      return withRun(state, finished.subagentRunId, (run) => ({
        ...run,
        status: finished.outcome?.type === "suspended" ? "suspended" : "completed",
        ...(finished.result !== undefined ? { result: finished.result } : {}),
      }))
    }
    case EventType.SUBAGENT_ERROR: {
      const failed = event as SubagentErrorEvent
      return withRun(state, failed.subagentRunId, (run) => ({
        ...run,
        status: "failed",
        error: failed.message,
      }))
    }
    default:
      break
  }

  const owner = (event as Attributed).subagentRunId
  if (typeof owner !== "string" || !state.runs.has(owner)) return state
  switch (event.type) {
    case EventType.TEXT_MESSAGE_CONTENT: {
      const { delta } = event as TextMessageContentEvent
      return withRun(state, owner, (run) => ({ ...run, text: run.text + delta }))
    }
    case EventType.REASONING_MESSAGE_CONTENT: {
      const { delta } = event as ReasoningMessageContentEvent
      return withRun(state, owner, (run) => ({ ...run, reasoning: run.reasoning + delta }))
    }
    case EventType.TOOL_CALL_START: {
      const { toolCallId, toolCallName } = event as ToolCallStartEvent
      return withRun(state, owner, (run) => ({
        ...run,
        toolCalls: run.toolCalls.some((call) => call.id === toolCallId)
          ? run.toolCalls
          : [...run.toolCalls, { id: toolCallId, name: toolCallName, args: "", status: "running" }],
      }))
    }
    case EventType.TOOL_CALL_ARGS: {
      const { toolCallId, delta } = event as ToolCallArgsEvent
      return withToolCall(state, owner, toolCallId, (call) => ({
        ...call,
        args: call.args + delta,
      }))
    }
    case EventType.TOOL_CALL_RESULT: {
      const { toolCallId, content } = event as ToolCallResultEvent
      // 1.0 lets a result be content parts; the panel shows their text.
      const result =
        typeof content === "string"
          ? content
          : content.map((part) => (part.type === "text" ? part.text : "")).join("")
      return withToolCall(state, owner, toolCallId, (call) => ({
        ...call,
        result,
        status: "completed",
      }))
    }
    case EventType.ACTIVITY_SNAPSHOT: {
      const { activityType, content } = event as ActivitySnapshotEvent
      if (activityType !== B4_PLAN_ACTIVITY_TYPE) return state
      const plan = readPlan(content)
      if (plan === undefined) return state
      return withRun(state, owner, (run) => ({ ...run, plan }))
    }
    default:
      return state
  }
}

/** The subset of `AbstractAgent` the hook needs: the subscription seam. */
export type SubagentEventSource = Pick<AbstractAgent, "subscribe">

/**
 * The subagent tree of the agent's current thread, kept current from its event
 * stream. Pass the `agent` CopilotKit's `useAgent()` returns (or any
 * `@ag-ui/client` agent); `undefined` while there is none.
 */
export function useSubagentRuns(agent: SubagentEventSource | undefined): SubagentRunsState {
  const [state, setState] = useState<SubagentRunsState>(EMPTY_SUBAGENT_RUNS)
  useEffect(() => {
    if (agent === undefined) return
    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        setState((previous) => reduceSubagentRuns(previous, event))
      },
    })
    return () => subscription.unsubscribe()
  }, [agent])
  return state
}

/** Narrow a transcript message to one a subagent produced. */
export function isSubagentMessage(
  message: Message,
): message is Message & { subagentRunId: string } {
  return typeof (message as { subagentRunId?: unknown }).subagentRunId === "string"
}
