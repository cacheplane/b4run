import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core"
import {
  CHEVRON_GLYPH,
  groupMeta,
  type StepGroup,
  type StepLabelOverrides,
} from "@b4run/ag-ui/view"
import { disclosure } from "./state.js"
import { defaultNow, StepComponent, type StepRenderers } from "./step.component.js"
import { StepIconComponent } from "./step-icon.component.js"
import { CHEVRON_TEMPLATE, SvgAttrsDirective } from "./svg.js"

const never = () => false

/**
 * Consecutive done calls of one tool, merged ("Searched the corpus 2 times");
 * the meta counts the merged sources, and the row opens to the individual
 * steps. Attaches to the contract's `li`: `<li b4-step-group [group]="…">`.
 */
@Component({
  selector: "li[b4-step-group]",
  imports: [StepComponent, StepIconComponent, SvgAttrsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "b4-step",
    "data-state": "done",
    "data-kind": "group",
    "[attr.data-expanded]": "panel.open() ? 'true' : null",
  },
  template: `<button type="button" class="b4-step__line" [attr.aria-expanded]="panel.open()" (click)="panel.toggle()">${CHEVRON_TEMPLATE}<b4-step-icon [name]="group().steps[0]?.icon" /><span class="b4-step__text">{{ group().label }}</span>@if (meta()) {<span class="b4-step__meta">{{ meta() }}</span>}</button>@if (panel.open()) {<div class="b4-step__children"><ol class="b4-turn__steps">@for (step of group().steps; track step.id) {<li b4-step [step]="step" [labels]="labels()" [renderStep]="renderStep()" [now]="now()"></li>}</ol></div>}`,
})
export class StepGroupComponent {
  readonly group = input.required<StepGroup>()
  readonly labels = input<StepLabelOverrides | undefined>(undefined)
  readonly renderStep = input<StepRenderers | undefined>(undefined)
  readonly now = input<() => number>(defaultNow)

  protected readonly chevron = CHEVRON_GLYPH
  protected readonly panel = disclosure(never, never)
  protected readonly meta = computed(() => groupMeta(this.group()))
}
