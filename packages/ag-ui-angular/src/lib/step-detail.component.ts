import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core"
import { stepDetailText } from "@b4run/ag-ui/view"

/** A step's Inputs and Output (`stepDetailText`); CSS caps it at 250px with scroll. */
@Component({
  selector: "b4-step-detail",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  template: `<div class="b4-step__detail">@if (text().empty) {<p class="b4-step__detail-empty">No details yet.</p>}@if (hasInputs()) {<h4 class="b4-step__detail-label">Inputs</h4><pre class="b4-step__code">{{ text().inputs }}</pre>}@if (hasOutput()) {<h4 class="b4-step__detail-label">Output</h4><pre class="b4-step__code">{{ text().output }}</pre>}</div>`,
})
export class StepDetailComponent {
  readonly args = input.required<string>()
  readonly result = input<string | undefined>(undefined)
  protected readonly text = computed(() => stepDetailText(this.args(), this.result()))
  protected readonly hasInputs = computed(() => this.text().inputs.trim() !== "")
  protected readonly hasOutput = computed(() => this.text().output.trim() !== "")
}
