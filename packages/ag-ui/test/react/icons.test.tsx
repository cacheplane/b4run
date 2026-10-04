import { TOOL_DISPLAY_ICONS } from "@b4run/sdk"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { Chevron, StepIcon } from "../../src/react/activity/icons.js"

describe("StepIcon", () => {
  test("renders an aria-hidden 16px SVG for every ToolDisplayIcon name and the extras", () => {
    for (const name of [...TOOL_DISPLAY_ICONS, "alert", "check"] as const) {
      const markup = renderToStaticMarkup(<StepIcon name={name} />)
      expect(markup).toContain('class="b4-step__icon"')
      expect(markup).toContain('aria-hidden="true"')
      expect(markup).toContain('viewBox="0 0 16 16"')
      expect(markup).toContain('stroke="currentColor"')
    }
  })
  test("an unknown name falls back to the generic tool glyph", () => {
    expect(renderToStaticMarkup(<StepIcon name="nope" />)).toBe(
      renderToStaticMarkup(<StepIcon name="tool" />),
    )
  })
  test("the chevron is 12px and aria-hidden", () => {
    const markup = renderToStaticMarkup(<Chevron />)
    expect(markup).toContain('viewBox="0 0 12 12"')
    expect(markup).toContain('class="b4-chevron"')
    expect(markup).toContain('aria-hidden="true"')
  })
})
