/**
 * `@b4run/ag-ui-angular` — the activity kit for Angular.
 *
 * Standalone components that take the plain views `@b4run/ag-ui/view` builds
 * (`reduceTurns`) and render the same DOM contract, classes and text as the
 * React kit (`@b4run/ag-ui/react`), styled by the same sheet
 * (`@b4run/ag-ui-angular/styles.css`). `b4-turn-activity` renders a turn;
 * `b4-approval-card` a parked interrupt; the step rows and building blocks
 * are exported for custom steps.
 */
export { ApprovalCardComponent } from "./lib/approval-card.component"
export { ChecklistComponent } from "./lib/checklist.component"
export { DisclosureComponent } from "./lib/disclosure.component"
export { PlanStepComponent } from "./lib/plan-step.component"
export { ReasoningStepComponent } from "./lib/reasoning-step.component"
export { SourceChipsComponent } from "./lib/source-chips.component"
export {
  type DisclosureState,
  disclosure,
  elapsedSignal,
  liveSignal,
} from "./lib/state"
export { StepComponent, type StepRenderers } from "./lib/step.component"
export { StepDetailComponent } from "./lib/step-detail.component"
export { StepGroupComponent } from "./lib/step-group.component"
export { StepIconComponent } from "./lib/step-icon.component"
export { SubagentStepComponent } from "./lib/subagent-step.component"
export { SvgAttrsDirective } from "./lib/svg"
export { TurnActivityComponent } from "./lib/turn-activity.component"
