/**
 * `@b4run/ag-ui/angular` — the activity kit for Angular.
 *
 * Standalone components that take the plain views `@b4run/ag-ui/view` builds
 * (`reduceTurns`) and render the same DOM contract, classes and text as the
 * React kit (`@b4run/ag-ui/react`), styled by the same sheet
 * (`@b4run/ag-ui/styles.css`). `b4-turn-activity` renders a turn;
 * `b4-approval-card` a parked interrupt; the step rows and building blocks
 * are exported for custom steps.
 */
export { ApprovalCardComponent } from "./lib/approval-card.component.js"
export { ChecklistComponent } from "./lib/checklist.component.js"
export { DisclosureComponent } from "./lib/disclosure.component.js"
export { PlanStepComponent } from "./lib/plan-step.component.js"
export { ReasoningStepComponent } from "./lib/reasoning-step.component.js"
export { SourceChipsComponent } from "./lib/source-chips.component.js"
export {
  type DisclosureState,
  disclosure,
  elapsedSignal,
  liveSignal,
} from "./lib/state.js"
export { StepComponent, type StepRenderers } from "./lib/step.component.js"
export { StepDetailComponent } from "./lib/step-detail.component.js"
export { StepGroupComponent } from "./lib/step-group.component.js"
export { StepIconComponent } from "./lib/step-icon.component.js"
export { SubagentStepComponent } from "./lib/subagent-step.component.js"
export { SvgAttrsDirective } from "./lib/svg.js"
export { TurnActivityComponent } from "./lib/turn-activity.component.js"
