import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { ReasoningStep } from "../../src/react/activity/ReasoningStep.js"
import type { ReasoningStep as View } from "../../src/view/turns.js"

/**
 * Overrides may clear an optional field with `undefined` (`settledAt`);
 * {@link compact} then drops the key, which `exactOptionalPropertyTypes`
 * requires of the built view.
 */
type Loose<T> = { [K in keyof T]?: T[K] | undefined }
const compact = <T extends object>(o: Loose<T>): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

const step = (o: Loose<View>): View =>
  compact<View>({
    kind: "reasoning",
    id: "r",
    text: "Let me think",
    status: "done",
    startedAt: 0,
    settledAt: 4000,
    ...o,
  })

describe("ReasoningStep", () => {
  test("streaming reads Thinking…, is running and open", () => {
    const markup = renderToStaticMarkup(
      <ReasoningStep step={step({ status: "streaming", settledAt: undefined })} />,
    )
    expect(markup).toContain('data-state="running" data-kind="reasoning" data-expanded="true"')
    expect(markup).toContain(">Thinking…<")
    expect(markup).toContain(
      '<div class="b4-step__detail"><p class="b4-step__reasoning">Let me think</p></div>',
    )
  })

  test("done reads Thought for 4s and is closed", () => {
    const markup = renderToStaticMarkup(<ReasoningStep step={step({})} />)
    expect(markup).toContain('data-state="done" data-kind="reasoning">')
    expect(markup).toContain(">Thought for 4s<")
    expect(markup).not.toContain("b4-step__detail")
  })

  test("encrypted (done with no text) is not openable", () => {
    const markup = renderToStaticMarkup(<ReasoningStep step={step({ text: "" })} />)
    expect(markup).toContain('<span class="b4-step__line b4-step__line--static">')
    expect(markup).not.toContain("<button")
    expect(markup).toContain(">Thought for 4s<")
  })
})
