import { ChangeDetectionStrategy, Component, computed, forwardRef, input } from "@angular/core"
import {
  CHEVRON_GLYPH,
  isSubagentLive,
  type StepLabelOverrides,
  type SubagentStep,
  subagentMeta,
  subagentRowState,
  subagentSettledText,
} from "@b4run/ag-ui/view"
import { disclosure } from "./state.js"
import { defaultNow, type StepRenderers } from "./step.component.js"
import { StepIconComponent } from "./step-icon.component.js"
import { CHEVRON_TEMPLATE, SvgAttrsDirective } from "./svg.js"
// Circular with turn-activity.component.ts: both sides reference the other
// through `forwardRef`, so either may load first.
import { TurnActivityComponent } from "./turn-activity.component.js"

/**
 * "Asked researcher", its description as a muted line beneath, with the
 * child's own activity nested; folds to "researcher finished · 5 steps".
 * Descriptions are third-person summaries, so they are never spliced into the
 * sentence. Attaches to the contract's `li`: `<li b4-subagent-step [step]="…">`.
 */
@Component({
  selector: "li[b4-subagent-step]",
  imports: [forwardRef(() => TurnActivityComponent), StepIconComponent, SvgAttrsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "b4-step",
    "data-kind": "subagent",
    "[attr.data-state]": "rowState()",
    "[attr.data-expanded]": "panel.open() ? 'true' : null",
  },
  template: `<button type="button" class="b4-step__line" [attr.aria-expanded]="panel.open()" (click)="panel.toggle()">${CHEVRON_TEMPLATE}<b4-step-icon [name]="step().status === 'failed' ? 'alert' : 'agent'" /><span class="b4-step__text">@if (live()) {Asked <b>{{ step().name }}</b>@if (step().description) {<span class="b4-step__note">{{ step().description }}</span>}} @else {<ng-container>{{ settledText() }}</ng-container>}</span>@if (meta()) {<span class="b4-step__meta">{{ meta() }}</span>}</button>@if (panel.open()) {<div class="b4-step__children"><b4-turn-activity [turn]="step().turn" [labels]="labels()" [renderStep]="renderStep()" [now]="now()" [nested]="{ name: step().name, status: step().status }" /></div>}`,
})
export class SubagentStepComponent {
  readonly step = input.required<SubagentStep>()
  readonly labels = input<StepLabelOverrides | undefined>(undefined)
  readonly renderStep = input<StepRenderers | undefined>(undefined)
  readonly now = input<() => number>(defaultNow)

  protected readonly chevron = CHEVRON_GLYPH
  protected readonly live = computed(() => isSubagentLive(this.step()))
  protected readonly rowState = computed(() => subagentRowState(this.step().status))
  protected readonly settledText = computed(() => subagentSettledText(this.step()))
  protected readonly meta = computed(() => subagentMeta(this.step()))
  protected readonly panel = disclosure(
    () => this.live() || this.step().status === "failed",
    this.live,
    () => this.step().startedAt,
  )
}
