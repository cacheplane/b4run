import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SourceChips } from "../../src/react/activity/SourceChips.js"
import { StatusText } from "../../src/react/activity/StatusText.js"
import { prettyValue, StepDetail } from "../../src/react/activity/StepDetail.js"

describe("StatusText", () => {
  test("renders the muted meta fragment, or nothing when empty", () => {
    expect(renderToStaticMarkup(<StatusText>· 4 of 4 done</StatusText>)).toBe(
      '<span class="b4-step__meta">· 4 of 4 done</span>',
    )
    expect(renderToStaticMarkup(<StatusText>{""}</StatusText>)).toBe("")
  })
})

describe("SourceChips", () => {
  test("renders a labelled list of chips with +N overflow after the limit", () => {
    const markup = renderToStaticMarkup(
      <SourceChips
        sources={[
          { title: "a.md" },
          { title: "b.md", href: "https://x.test/b" },
          { title: "c.md" },
          { title: "d.md" },
        ]}
        limit={3}
      />,
    )
    expect(markup).toContain('<ul class="b4-step__sources" aria-label="Sources">')
    expect(markup).toContain(
      '<a class="b4-chip" href="https://x.test/b" target="_blank" rel="noreferrer">b.md</a>',
    )
    expect(markup).toContain('<span class="b4-chip">a.md</span>')
    expect(markup).toContain('<li class="b4-chip b4-chip--more">+1</li>')
    expect(markup).not.toContain("d.md")
  })
  test("renders nothing for no sources", () => {
    expect(renderToStaticMarkup(<SourceChips sources={[]} />)).toBe("")
  })
})

describe("StepDetail", () => {
  test("pretty-prints JSON inputs and output, labels the sections, and passes text through", () => {
    const markup = renderToStaticMarkup(<StepDetail args='{"query":"a"}' result="3 hits" />)
    expect(markup).toContain('<div class="b4-step__detail">')
    expect(markup).toContain('<h4 class="b4-step__detail-label">Inputs</h4>')
    expect(markup).toContain(
      '<pre class="b4-step__code">{\n  &quot;query&quot;: &quot;a&quot;\n}</pre>',
    )
    expect(markup).toContain('<h4 class="b4-step__detail-label">Output</h4>')
    expect(markup).toContain('<pre class="b4-step__code">3 hits</pre>')
  })
  test("omits an empty section and never throws on bad JSON", () => {
    expect(prettyValue("{not json")).toBe("{not json")
    expect(prettyValue("")).toBe("")
    const markup = renderToStaticMarkup(<StepDetail args="" result={undefined} />)
    expect(markup).toBe(
      '<div class="b4-step__detail"><p class="b4-step__detail-empty">No details yet.</p></div>',
    )
  })
})
