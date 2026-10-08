import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core"
import { isSafeHref, type StepSource } from "@b4run/ag-ui/view"

/**
 * File or URL chips from a step's `sources`, with "+N" overflow. Sources come
 * off the wire: only web, mail and same-origin paths (`isSafeHref`) become links.
 */
@Component({
  selector: "b4-source-chips",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  template: `@if (sources().length > 0) {<ul class="b4-step__sources" aria-label="Sources">@for (source of shown(); track $index) {<li>@if (linkOf(source); as href) {<a class="b4-chip" [href]="href" target="_blank" rel="noreferrer">{{ source.title }}</a>} @else {<span class="b4-chip">{{ source.title }}</span>}</li>}@if (more() > 0) {<li class="b4-chip b4-chip--more">+{{ more() }}</li>}</ul>}`,
})
export class SourceChipsComponent {
  readonly sources = input.required<readonly StepSource[]>()
  /** Chips shown before the "+N" overflow chip. */
  readonly limit = input(3)
  protected readonly shown = computed(() => this.sources().slice(0, this.limit()))
  protected readonly more = computed(() => this.sources().length - this.shown().length)
  protected linkOf(source: StepSource): string | undefined {
    return source.href && isSafeHref(source.href) ? source.href : undefined
  }
}
