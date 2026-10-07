import { NgComponentOutlet } from "@angular/common"
import { ChangeDetectionStrategy, Component, computed, input, type Type } from "@angular/core"
import {
  CHEVRON_GLYPH,
  ownEntry,
  type StepLabelOverrides,
  stepLabel,
  stepMeta,
  type ToolStep,
} from "@b4run/ag-ui/view"
import { SourceChipsComponent } from "./source-chips.component"
import { disclosure, liveSignal } from "./state"
import { StepDetailComponent } from "./step-detail.component"
import { StepIconComponent } from "./step-icon.component"
import { CHEVRON_TEMPLATE, SvgAttrsDirective } from "./svg"

/**
 * Per-tool views that replace a step's `b4-step-detail` (spec §3.1 "Per-tool
 * views"): a component per tool name, given the step as its `step` input. The
 * sentence line stays.
 */
export type StepRenderers = Readonly<Record<string, Type<unknown>>>

export const defaultNow = (): number => Date.now()

/**
 * One tool call as a sentence; opens to its inputs and output. Attaches to the
 * contract's own `li` (`<li b4-step [step]="…">`), so the list keeps its
 * `ol > li` structure.
 */
@Component({
  selector: "li[b4-step]",
  imports: [
    NgComponentOutlet,
    SourceChipsComponent,
    StepDetailComponent,
    StepIconComponent,
    SvgAttrsDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "b4-step",
    "data-kind": "tool",
    "[attr.data-state]": "rowState()",
    "[attr.data-expanded]": "panel.open() ? 'true' : null",
  },
  template: `<button type="button" class="b4-step__line" [attr.aria-expanded]="panel.open()" (click)="panel.toggle()">${CHEVRON_TEMPLATE}<b4-step-icon [name]="failed() ? 'alert' : step().icon" /><span class="b4-step__text">{{ label() }}</span>@if (meta()) {<span class="b4-step__meta">{{ meta() }}</span>}</button>@if (panel.open()) {@if (custom(); as view) {<div class="b4-step__detail"><ng-container *ngComponentOutlet="view; inputs: { step: step() }" /></div>} @else {<b4-step-detail [args]="step().args" [result]="step().result" />}}@if (step().sources; as sources) {<b4-source-chips [sources]="sources" />}`,
})
export class StepComponent {
  readonly step = input.required<ToolStep>()
  readonly labels = input<StepLabelOverrides | undefined>(undefined)
  readonly renderStep = input<StepRenderers | undefined>(undefined)
  /** The clock; defaults to `Date.now`. Inject in tests. */
  readonly now = input<() => number>(defaultNow)

  protected readonly chevron = CHEVRON_GLYPH
  private readonly live = liveSignal(this.step, () => this.now()())
  protected readonly failed = computed(() => this.step().status === "failed")
  protected readonly rowState = computed(() =>
    this.step().status === "running" && !this.live() ? "pending" : this.step().status,
  )
  // Keyed by `startedAt`: the same call going awaiting → running keeps what
  // the user opened; a re-presented call hands control back to automation.
  protected readonly panel = disclosure(this.failed, this.live, () => this.step().startedAt)
  protected readonly label = computed(() => stepLabel(this.step(), this.labels()))
  protected readonly meta = computed(() => stepMeta(this.step()))
  protected readonly custom = computed(() => ownEntry(this.renderStep(), this.step().name))
}
