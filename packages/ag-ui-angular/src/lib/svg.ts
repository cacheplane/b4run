import { Directive, ElementRef, effect, inject, input, Renderer2 } from "@angular/core"

/**
 * Sets an SVG shape's attributes from a shared glyph (`@b4run/ag-ui/view`'s
 * `GlyphShape.attrs`), in order, and removes the ones a new glyph drops.
 */
@Directive({ selector: "[b4SvgAttrs]" })
export class SvgAttrsDirective {
  readonly b4SvgAttrs = input.required<Readonly<Record<string, string>>>()
  private readonly element = inject<ElementRef<Element>>(ElementRef)
  private readonly renderer = inject(Renderer2)
  private applied: readonly string[] = []

  constructor() {
    effect(() => {
      const attrs = this.b4SvgAttrs()
      const node = this.element.nativeElement
      for (const name of this.applied) {
        if (!Object.hasOwn(attrs, name)) this.renderer.removeAttribute(node, name)
      }
      for (const [name, value] of Object.entries(attrs)) {
        this.renderer.setAttribute(node, name, value)
      }
      this.applied = Object.keys(attrs)
    })
  }
}

/**
 * The disclosure chevron (`CHEVRON_GLYPH`), as a template fragment: the CSS
 * rotates `[aria-expanded="true"] > .b4-chevron`, so it must be the button's
 * own child rather than inside a component host. Templates that use it expose
 * `chevron = CHEVRON_GLYPH` and import {@link SvgAttrsDirective}.
 */
export const CHEVRON_TEMPLATE = `<svg class="b4-chevron" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">@for (shape of chevron; track $index) {<svg:path [b4SvgAttrs]="shape.attrs" />}</svg>`
