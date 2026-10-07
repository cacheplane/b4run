import { createElement, type ReactElement } from "react"
import { CHEVRON_GLYPH, type GlyphShape, stepGlyph } from "../../view/activity-glyphs.js"

/** `stroke-width` → `strokeWidth`: React names SVG presentation attributes in camelCase. */
const reactName = (attr: string): string =>
  attr.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())

/** One shape of a shared glyph (`@b4run/ag-ui/view`) as a React element. */
export function GlyphShapeElement({ shape }: { readonly shape: GlyphShape }): ReactElement {
  return createElement(
    shape.tag,
    Object.fromEntries(Object.entries(shape.attrs).map(([k, v]) => [reactName(k), v])),
  )
}

/**
 * A step's glyph (`stepGlyph`): 16×16, `currentColor`, 1.3 stroke. Unknown
 * names, `Object.prototype` keys included, draw the generic `tool` glyph.
 */
export function StepIcon({ name }: { readonly name: string | undefined }): ReactElement {
  return (
    <svg
      className="b4-step__icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      {stepGlyph(name).map((shape, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: A glyph's shapes are a fixed list, never reordered.
        <GlyphShapeElement key={index} shape={shape} />
      ))}
    </svg>
  )
}

/** The disclosure chevron; CSS rotates it 90° when open. */
export function Chevron(): ReactElement {
  return (
    <svg
      className="b4-chevron"
      viewBox="0 0 12 12"
      width="11"
      height="11"
      aria-hidden="true"
      focusable="false"
    >
      {CHEVRON_GLYPH.map((shape, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: A glyph's shapes are a fixed list, never reordered.
        <GlyphShapeElement key={index} shape={shape} />
      ))}
    </svg>
  )
}
