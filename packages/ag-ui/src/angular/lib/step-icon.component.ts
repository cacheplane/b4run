import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core"
import { stepGlyph } from "@b4run/ag-ui/view"
import { SvgAttrsDirective } from "./svg.js"

/**
 * A step's glyph (`stepGlyph`): 16×16, `currentColor`, 1.3 stroke. Unknown
 * names, `Object.prototype` keys included, draw the generic `tool` glyph.
 */
@Component({
  selector: "b4-step-icon",
  imports: [SvgAttrsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  template: `<svg class="b4-step__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">@for (shape of glyph(); track $index) {@switch (shape.tag) {@case ("circle") {<svg:circle [b4SvgAttrs]="shape.attrs" />}@case ("rect") {<svg:rect [b4SvgAttrs]="shape.attrs" />}@default {<svg:path [b4SvgAttrs]="shape.attrs" />}}}</svg>`,
})
export class StepIconComponent {
  readonly name = input<string | undefined>(undefined)
  protected readonly glyph = computed(() => stepGlyph(this.name()))
}
