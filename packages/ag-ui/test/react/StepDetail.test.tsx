import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SourceChips } from "../../src/react/activity/SourceChips.js"
import { StatusText } from "../../src/react/activity/StatusText.js"
import { StepDetail } from "../../src/react/activity/StepDetail.js"
import { capDetail, MAX_DETAIL_CHARS, prettyValue } from "../../src/view/activity-format.js"

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
  test("only web, mail and same-origin hrefs become links; anything else is a plain chip", () => {
    const markup = renderToStaticMarkup(
      <SourceChips
        sources={[
          { title: "evil", href: "javascript:alert(1)" },
          { title: "data", href: "data:text/html,hi" },
          { title: "mail", href: "mailto:a@b.test" },
          { title: "local", href: "/files/a.md" },
        ]}
        limit={4}
      />,
    )
    expect(markup).not.toContain("javascript:")
    expect(markup).not.toContain("data:")
    expect(markup).toContain('<span class="b4-chip">evil</span>')
    expect(markup).toContain('<span class="b4-chip">data</span>')
    expect(markup).toContain('href="mailto:a@b.test"')
    expect(markup).toContain('href="/files/a.md"')
    expect(markup.match(/<a /g)).toHaveLength(2)
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
  test("caps each value at 20 000 characters with a truncated line", () => {
    expect(MAX_DETAIL_CHARS).toBe(20_000)
    const long = "x".repeat(MAX_DETAIL_CHARS + 5)
    expect(capDetail("x".repeat(MAX_DETAIL_CHARS))).toHaveLength(MAX_DETAIL_CHARS)
    expect(capDetail(long)).toBe(`${"x".repeat(MAX_DETAIL_CHARS)}\n… (truncated)`)
    const markup = renderToStaticMarkup(<StepDetail args={long} result={`${long}END`} />)
    expect(markup).not.toContain("END")
    expect(markup.match(/… \(truncated\)/g)).toHaveLength(2)
    expect(markup).toContain(
      `<pre class="b4-step__code">${"x".repeat(MAX_DETAIL_CHARS)}\n… (truncated)</pre>`,
    )
  })
})
