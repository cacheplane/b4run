/**
 * `@b4run/ag-ui/react` — the React activity kit.
 *
 * React is an OPTIONAL peer dependency: importing the root (`@b4run/ag-ui`) or
 * `./sse` never loads this module. This entry has no CopilotKit dependency;
 * the CopilotKit connector lives at `@b4run/ag-ui/copilotkit`.
 *
 * Components take plain props built by `@b4run/ag-ui/view` (`reduceTurns`) and
 * render the DOM contract in the activity-components spec: `TurnActivity` for a
 * turn, `ApprovalCard` for a parked interrupt, and the step rows and building
 * blocks (`Disclosure`, `StepIcon`, `StatusText`, `Checklist`) for custom steps.
 *
 * Deprecated, removed in a later release once the research example adopts the
 * kit: `PlanActivityCard`, `ActivityChecklist`, `SubagentPanel`, the
 * `classNames`/`components` slots and `cx`.
 */

/** @deprecated Legacy card; removed when the research example adopts `TurnActivity`. */
export { ActivityChecklist } from "./ActivityChecklist.js"
export {
  ApprovalCard,
  type ApprovalCardProps,
  type ApprovalDecision,
  approvalPayload,
  scopeLine,
} from "./activity/ApprovalCard.js"
export { Disclosure, type DisclosureProps, useDisclosure } from "./activity/Disclosure.js"
export { formatDuration, type SummaryLine, summaryLine } from "./activity/format.js"
export { Chevron, StepIcon } from "./activity/icons.js"
export { Checklist, PlanStep, type PlanStepProps } from "./activity/PlanStep.js"
export { ReasoningStep } from "./activity/ReasoningStep.js"
export { SourceChips, type SourceChipsProps } from "./activity/SourceChips.js"
export { StatusText } from "./activity/StatusText.js"
export { Step, type StepProps, type StepRenderer, type StepRenderers } from "./activity/Step.js"
export { StepDetail, type StepDetailProps } from "./activity/StepDetail.js"
export { StepGroup, type StepGroupProps } from "./activity/StepGroup.js"
export { SubagentStep, type SubagentStepProps } from "./activity/SubagentStep.js"
export { TurnActivity, type TurnActivityProps } from "./activity/TurnActivity.js"
export { useElapsed, useLive } from "./activity/useLive.js"
/** @deprecated Legacy card; removed when the research example adopts `TurnActivity`. */
export { PlanActivityCard } from "./PlanActivityCard.js"
/** @deprecated Legacy customization slots; the kit is styled through `@layer b4-activity` and tokens. */
export {
  type B4ActivityClassNames,
  type B4ActivityComponents,
  type B4TodoRowProps,
  type B4ToolRowProps,
  cx,
} from "./parts.js"
/** @deprecated Legacy card; removed when the research example adopts `SubagentStep`. */
export { SubagentPanel } from "./SubagentPanel.js"
export { planActivityContentSchema } from "./schemas.js"
export {
  EMPTY_SUBAGENT_RUNS,
  isSubagentMessage,
  reduceSubagentRuns,
  type SubagentEventSource,
  type SubagentRun,
  type SubagentRunsState,
  type SubagentToolCall,
  useSubagentRuns,
} from "./useSubagentRuns.js"
