import { NgTemplateOutlet } from "@angular/common"
import { ChangeDetectionStrategy, Component, input, output } from "@angular/core"
import { CHEVRON_GLYPH } from "@b4run/ag-ui/view"
import { CHEVRON_TEMPLATE, SvgAttrsDirective } from "./svg"

/**
 * A controlled `<button aria-expanded>` with the chevron, plus its panel,
 * rendered only while open: the building block for custom steps. The parent
 * owns `open` (see `disclosure()`) and flips it on `toggle`.
 *
 * Project the button's content with `ngProjectAs="b4-summary"` (or a
 * `<b4-summary>` element); everything else is the panel:
 *
 * ```html
 * <b4-disclosure className="b4-step__line" panelClassName="b4-step__detail"
 *                [open]="state.open()" (toggle)="state.toggle()">
 *   <ng-container ngProjectAs="b4-summary"><span class="b4-step__text">Checked the route</span></ng-container>
 *   <p>…</p>
 * </b4-disclosure>
 * ```
 *
 * The kit's own rows render this markup inline instead, so the sheet's
 * `.b4-step > .b4-step__line` child selectors see the button directly.
 */
@Component({
  selector: "b4-disclosure",
  imports: [NgTemplateOutlet, SvgAttrsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  template: `<button type="button" [class]="className()" [attr.aria-expanded]="open()" (click)="toggle.emit()">${CHEVRON_TEMPLATE}<ng-content select="b4-summary" /></button>@if (open()) {@if (panelClassName(); as panelClass) {<div [class]="panelClass"><ng-container [ngTemplateOutlet]="panel" /></div>} @else {<ng-container [ngTemplateOutlet]="panel" />}}<ng-template #panel><ng-content /></ng-template>`,
})
export class DisclosureComponent {
  readonly open = input.required<boolean>()
  /** Class of the toggle button (`b4-turn__summary`, `b4-step__line`). */
  readonly className = input.required<string>()
  /** Wrapper around the panel (`b4-step__detail`, `b4-step__children`); none by default. */
  readonly panelClassName = input<string | undefined>(undefined)
  readonly toggle = output<void>()
  protected readonly chevron = CHEVRON_GLYPH
}
