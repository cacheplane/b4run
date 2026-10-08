import { NgTemplateOutlet } from "@angular/common"
import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core"
import { stepDetailView } from "@b4run/ag-ui/view"

/**
 * A step's input and result, readable first (`stepDetailView`): rows for an
 * object, a group of rows per object in a short list, plain text for a
 * string, pretty JSON for anything deeper.
 * When rows reshaped a value, "Show raw" opens the originals.
 */
@Component({
  selector: "b4-step-detail",
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  template: `<div class="b4-step__detail">@if (view().empty) {<p class="b4-step__detail-empty">No details yet.</p>}@if (view().input; as input) {<ng-container *ngTemplateOutlet="blockTpl; context: { $implicit: input }" />}@if (view().result; as result) {<h4 class="b4-step__detail-label">Result</h4><ng-container *ngTemplateOutlet="blockTpl; context: { $implicit: result }" />}@if (view().raw; as raw) {<button type="button" class="b4-step__raw" [attr.aria-expanded]="showRaw()" (click)="showRaw.set(!showRaw())">{{ showRaw() ? "Hide raw" : "Show raw" }}</button>@if (showRaw() && raw.input.trim() !== "") {<h4 class="b4-step__detail-label">Raw input</h4><pre class="b4-step__code">{{ raw.input }}</pre>}@if (showRaw() && raw.result.trim() !== "") {<h4 class="b4-step__detail-label">Raw result</h4><pre class="b4-step__code">{{ raw.result }}</pre>}}</div><ng-template #blockTpl let-block>@switch (block.kind) {@case ("fields") {<ng-container *ngTemplateOutlet="fieldsTpl; context: { $implicit: block.fields }" />}@case ("records") {<ol class="b4-step__records">@for (fields of block.records; track $index) {<li><ng-container *ngTemplateOutlet="fieldsTpl; context: { $implicit: fields }" /></li>}</ol>}@case ("text") {<p class="b4-step__value">{{ block.text }}</p>}@default {<pre class="b4-step__code">{{ block.text }}</pre>}}</ng-template><ng-template #fieldsTpl let-fields><dl class="b4-step__fields">@for (field of fields; track field.key) {<div class="b4-step__field"><dt>{{ field.key }}</dt><dd>{{ field.value }}</dd></div>}</dl></ng-template>`,
})
export class StepDetailComponent {
  readonly args = input.required<string>()
  readonly result = input<string | undefined>(undefined)
  protected readonly view = computed(() => stepDetailView(this.args(), this.result()))
  protected readonly showRaw = signal(false)
}
