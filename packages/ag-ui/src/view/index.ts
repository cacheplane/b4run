/**
 * `@b4run/ag-ui/view`: the framework-free half of the client. Pure reducers
 * and selectors over AG-UI events — what a chat shows for a turn — with no
 * React, no CopilotKit. `./react` builds on it; so can an Angular client.
 */
export type { B4StepEventValue, B4StepStatus } from "../step.js"
export {
  BUILT_IN_GROUP_LABELS,
  type GroupedStep,
  groupSteps,
  type StepGroup,
  type StepLabelOverride,
  type StepLabelOverrides,
  stepLabel,
} from "./labels.js"
export { B4_STEP_EVENT_NAME, B4_STEP_STATUSES, readStepEvent } from "./step.js"
export {
  EMPTY_SUBAGENT_RUNS,
  isSubagentMessage,
  reduceSubagentRuns,
  type SubagentRun,
  type SubagentRunsState,
  type SubagentToolCall,
} from "./subagent-runs.js"
export {
  type ApprovalView,
  EMPTY_TURNS,
  type PlanStep,
  type ReasoningStep,
  type ReduceTurnsOptions,
  reduceTurns,
  type StepSource,
  type StepStatus,
  type StepView,
  type SubagentStep,
  type ToolStep,
  type TurnStatus,
  type TurnsView,
  type TurnView,
} from "./turns.js"
export {
  type CheckpointForTurns,
  type PendingInterruptForTurns,
  type ThreadStateForTurns,
  type TurnsFromStateResult,
  turnsFromState,
} from "./turns-from-state.js"
