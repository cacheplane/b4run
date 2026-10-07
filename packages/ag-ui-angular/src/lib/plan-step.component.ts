import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core"
import { CHEVRON_GLYPH, type PlanStep, planProgress } from "@b4run/ag-ui/view"
import { ChecklistComponent } from "./checklist.component"
import { disclosure } from "./state"
import { StepIconComponent } from "./step-icon.component"
import { CHEVRON_TEMPLATE, SvgAttrsDirective } from "./svg"

/**
 * "Made a plan · 2 of 4 done" with the checklist; updates in place, running
 * only while the owning turn works. Attaches to the contract's `li`:
 * `<li b4-plan-step [step]="…" [live]="…">`.
 */
@Component({
  selector: "li[b4-plan-step]",
  imports: [ChecklistComponent, StepIconComponent, SvgAttrsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "b4-step",
    "data-kind": "plan",
    "[attr.data-state]": "live() ? 'running' : 'done'",
    "[attr.data-expanded]": "panel.open() ? 'true' : null",
  },
  template: `<button type="button" class="b4-step__line" [attr.aria-expanded]="panel.open()" (click)="panel.toggle()">${CHEVRON_TEMPLATE}<b4-step-icon name="plan" /><span class="b4-step__text">Made a plan</span><span class="b4-step__meta">· {{ progress().done }} of {{ progress().total }} done</span></button>@if (panel.open()) {<div class="b4-step__children"><b4-checklist [todos]="step().todos" /></div>}`,
})
export class PlanStepComponent {
  readonly step = input.required<PlanStep>()
  /** Whether the owning turn is still working; the plan is running only then. */
  readonly live = input.required<boolean>()

  protected readonly chevron = CHEVRON_GLYPH
  protected readonly progress = computed(() => planProgress(this.step().todos))
  protected readonly panel = disclosure(this.live, this.live, () => this.step().startedAt)
}
