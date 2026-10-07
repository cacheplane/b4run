import { ChangeDetectionStrategy, Component, computed, forwardRef, input } from "@angular/core"
import {
  CHEVRON_GLYPH,
  type GroupedStep,
  groupSteps,
  type NestedTurn,
  nestedSummaryLine,
  type StepLabelOverrides,
  summaryLine,
  type TurnView,
} from "@b4run/ag-ui/view"
import { PlanStepComponent } from "./plan-step.component"
import { ReasoningStepComponent } from "./reasoning-step.component"
import { disclosure, elapsedSignal } from "./state"
import { defaultNow, StepComponent, type StepRenderers } from "./step.component"
import { StepGroupComponent } from "./step-group.component"
// Circular with subagent-step.component.ts (a subagent nests a turn): both
// sides reference the other through `forwardRef`, so either may load first.
import { SubagentStepComponent } from "./subagent-step.component"
import { CHEVRON_TEMPLATE, SvgAttrsDirective } from "./svg"

const trackItem = (item: GroupedStep): string =>
  item.kind === "group" ? `g:${item.steps[0]?.id}` : item.id

/**
 * The summary line plus the step list for one turn (or one subagent run,
 * nested): working, awaiting, done, failed or stopped. Give it a `TurnView`
 * from `reduceTurns` (`@b4run/ag-ui/view`) and it renders the turn. Open while
 * live, folded once settled; a turn settled when it first renders ("restored")
 * starts folded.
 */
@Component({
  selector: "b4-turn-activity",
  imports: [
    PlanStepComponent,
    ReasoningStepComponent,
    StepComponent,
    StepGroupComponent,
    forwardRef(() => SubagentStepComponent),
    SvgAttrsDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  // One live region per turn (spec §5.5). It carries the sentence only, never
  // the ticking time, so its text node changes only when the sentence does.
  template: `<section class="b4-turn" [attr.data-state]="turn().status" [attr.data-expanded]="panel.open() ? 'true' : null"><button type="button" class="b4-turn__summary" [attr.aria-expanded]="panel.open()" (click)="panel.toggle()">${CHEVRON_TEMPLATE}<span class="b4-turn__text" [attr.data-live]="line().live ? 'true' : null">{{ line().text }}</span>@if (line().meta) {<span class="b4-turn__time">{{ line().meta }}</span>}</button>@if (panel.open()) {<ol class="b4-turn__steps">@for (item of grouped(); track trackItem(item)) {@switch (item.kind) {@case ("group") {<li b4-step-group [group]="item" [labels]="labels()" [renderStep]="renderStep()" [now]="now()"></li>}@case ("tool") {<li b4-step [step]="item" [labels]="labels()" [renderStep]="renderStep()" [now]="now()"></li>}@case ("plan") {<li b4-plan-step [step]="item" [live]="turn().status === 'working'"></li>}@case ("reasoning") {<li b4-reasoning-step [step]="item"></li>}@case ("subagent") {<li b4-subagent-step [step]="item" [labels]="labels()" [renderStep]="renderStep()" [now]="now()"></li>}}}</ol>}<span class="b4-visually-hidden" role="status">{{ line().text }}</span></section>`,
})
export class TurnActivityComponent {
  readonly turn = input.required<TurnView>()
  readonly labels = input<StepLabelOverrides | undefined>(undefined)
  readonly renderStep = input<StepRenderers | undefined>(undefined)
  /** The clock; defaults to `Date.now`. Inject in tests. */
  readonly now = input<() => number>(defaultNow)
  /** Set when this is a subagent's turn: the summary names the subagent instead. */
  readonly nested = input<NestedTurn | undefined>(undefined)

  protected readonly chevron = CHEVRON_GLYPH
  protected readonly trackItem = trackItem
  private readonly live = computed(() => {
    const status = this.turn().status
    return status === "working" || status === "awaiting"
  })
  private readonly sampled = elapsedSignal(this.live, () => this.now()())
  protected readonly line = computed(() => {
    const nested = this.nested()
    return nested
      ? nestedSummaryLine(this.turn(), nested, this.sampled(), this.labels())
      : summaryLine(this.turn(), this.sampled(), this.labels())
  })
  // No key: a turn that becomes live again is automation's.
  protected readonly panel = disclosure(this.live, this.live)
  protected readonly grouped = computed(() => groupSteps(this.turn().steps, this.labels()))
}
