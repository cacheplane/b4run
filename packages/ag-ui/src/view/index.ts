/**
 * `@b4run/ag-ui/view`: the framework-free half of the client. Pure reducers
 * and selectors over AG-UI events — what a chat shows for a turn — with no
 * React, no CopilotKit. `./react` builds on it; so can an Angular client.
 */
export type { B4StepEventValue, B4StepStatus } from "../step.js"
export {
  type ApprovalDecision,
  approvalErrorLine,
  approvalPayload,
  dispatchDecision,
  scopeLine,
} from "./activity-approval.js"
export {
  type DisclosureMemory,
  initialDisclosure,
  isDisclosureOpen,
  observeDisclosure,
  toggleDisclosure,
} from "./activity-disclosure.js"
export {
  capDetail,
  countSources,
  countSteps,
  formatDuration,
  groupMeta,
  isSafeHref,
  isSubagentLive,
  MAX_DETAIL_CHARS,
  type NestedTurn,
  nestedSummaryLine,
  ownEntry,
  planProgress,
  prettyValue,
  reasoningLabel,
  type SummaryLine,
  stepDetailText,
  stepMeta,
  subagentMeta,
  subagentRowState,
  subagentSettledText,
  summaryLine,
  todoStatusLabel,
} from "./activity-format.js"
export {
  CHECKLIST_TICK,
  CHEVRON_GLYPH,
  checklistBox,
  type Glyph,
  type GlyphShape,
  STEP_GLYPHS,
  stepGlyph,
} from "./activity-glyphs.js"
export {
  ELAPSED_TICK_MS,
  NO_FLASH_MS,
  noFlashRemaining,
  sampleElapsed,
} from "./activity-timing.js"
export {
  BUILT_IN_GROUP_LABELS,
  type GroupedStep,
  groupSteps,
  type StepGroup,
  type StepLabelOverride,
  type StepLabelOverrides,
  stepLabel,
} from "./labels.js"
export { isSubagentMessage } from "./messages.js"
export { blocksToParts } from "./parts.js"
export { B4_STEP_EVENT_NAME, B4_STEP_STATUSES, readStepEvent } from "./step.js"
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
  type EventsFromStateResult,
  eventsFromState,
  type PendingInterruptForTurns,
  type ThreadStateForTurns,
  type TurnsFromStateResult,
  turnsFromState,
} from "./turns-from-state.js"
