import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core"
import { CHEVRON_GLYPH, type ReasoningStep, reasoningLabel } from "@b4run/ag-ui/view"
import { disclosure } from "./state"
import { StepIconComponent } from "./step-icon.component"
import { CHEVRON_TEMPLATE, SvgAttrsDirective } from "./svg"

/**
 * A reasoning span: "Thinking…", "Thought for 4s" or "Show reasoning"; opens
 * to its text while streaming and on demand once done. An encrypted span
 * (done with no text) is not openable, so its line is a plain `span`.
 * Attaches to the contract's `li`: `<li b4-reasoning-step [step]="…">`.
 */
@Component({
  selector: "li[b4-reasoning-step]",
  imports: [StepIconComponent, SvgAttrsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "b4-step",
    "data-kind": "reasoning",
    "[attr.data-state]": "streaming() ? 'running' : 'done'",
    "[attr.data-expanded]": "panel.open() && !encrypted() ? 'true' : null",
  },
  template: `@if (encrypted()) {<span class="b4-step__line b4-step__line--static"><b4-step-icon name="think" /><span class="b4-step__text">{{ label() }}</span></span>} @else {<button type="button" class="b4-step__line" [attr.aria-expanded]="panel.open()" (click)="panel.toggle()">${CHEVRON_TEMPLATE}<b4-step-icon name="think" /><span class="b4-step__text">{{ label() }}</span></button>@if (panel.open()) {<div class="b4-step__detail"><p class="b4-step__reasoning">{{ step().text }}</p></div>}}`,
})
export class ReasoningStepComponent {
  readonly step = input.required<ReasoningStep>()

  protected readonly chevron = CHEVRON_GLYPH
  protected readonly streaming = computed(() => this.step().status === "streaming")
  protected readonly encrypted = computed(() => !this.streaming() && this.step().text.trim() === "")
  protected readonly label = computed(() => reasoningLabel(this.step()))
  protected readonly panel = disclosure(this.streaming, this.streaming, () => this.step().startedAt)
}
