// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
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
  test("a flat input reads as key/value rows and a text result as plain text, with no raw toggle for unchanged text", () => {
    const markup = renderToStaticMarkup(<StepDetail args='{"query":"a"}' result="3 hits" />)
    expect(markup).toBe(
      '<div class="b4-step__detail">' +
        '<dl class="b4-step__fields"><div class="b4-step__field"><dt>query</dt><dd>a</dd></div></dl>' +
        '<h4 class="b4-step__detail-label">Result</h4><p class="b4-step__value">3 hits</p>' +
        '<button type="button" class="b4-step__raw" aria-expanded="false">Show raw</button>' +
        "</div>",
    )
  })
  test("Show raw opens the pretty-printed originals of the sides shown as rows, and toggles back", () => {
    render(<StepDetail args='{"query":"a"}' result='{"hits":3}' />)
    const toggle = screen.getByRole("button", { name: "Show raw" })
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(toggle.textContent).toBe("Hide raw")
    const codes = Array.from(document.querySelectorAll("pre.b4-step__code"), (p) => p.textContent)
    expect(codes).toEqual(['{\n  "query": "a"\n}', '{\n  "hits": 3\n}'])
    expect(
      Array.from(document.querySelectorAll("h4.b4-step__detail-label"), (h) => h.textContent),
    ).toEqual(["Result", "Raw input", "Raw result"])
    fireEvent.click(toggle)
    expect(document.querySelector("pre.b4-step__code")).toBeNull()
    cleanup()
  })
  test("a side shown as it is gets no raw copy", () => {
    render(<StepDetail args='{"query":"a"}' result='"3 hits"' />)
    fireEvent.click(screen.getByRole("button", { name: "Show raw" }))
    expect(
      Array.from(document.querySelectorAll("h4.b4-step__detail-label"), (h) => h.textContent),
    ).toEqual(["Result", "Raw input"])
    cleanup()
  })
  test("a list of objects renders one group of rows per object", () => {
    const markup = renderToStaticMarkup(
      <StepDetail args="" result='[{"id":"KSTP"},{"id":"KRST"}]' />,
    )
    expect(markup).toContain(
      '<ol class="b4-step__records">' +
        '<li><dl class="b4-step__fields"><div class="b4-step__field"><dt>id</dt><dd>KSTP</dd></div></dl></li>' +
        '<li><dl class="b4-step__fields"><div class="b4-step__field"><dt>id</dt><dd>KRST</dd></div></dl></li>' +
        "</ol>",
    )
  })
  test("deep JSON stays pretty JSON with no raw toggle; a string result is unquoted", () => {
    const markup = renderToStaticMarkup(
      <StepDetail args='{"ids":[{"id":"KSTP"}]}' result='"wrote 431 bytes"' />,
    )
    expect(markup).toContain(
      '<pre class="b4-step__code">{\n  &quot;ids&quot;: [\n    {\n      &quot;id&quot;: &quot;KSTP&quot;\n    }\n  ]\n}</pre>',
    )
    expect(markup).toContain('<p class="b4-step__value">wrote 431 bytes</p>')
    expect(markup).not.toContain("b4-step__raw")
  })
  test("omits an empty section and never throws on bad JSON", () => {
    expect(prettyValue("{not json")).toBe("{not json")
    expect(prettyValue("")).toBe("")
    expect(renderToStaticMarkup(<StepDetail args="" result={undefined} />)).toBe(
      '<div class="b4-step__detail"><p class="b4-step__detail-empty">No details yet.</p></div>',
    )
    expect(renderToStaticMarkup(<StepDetail args="{}" result={undefined} />)).toBe(
      '<div class="b4-step__detail"><p class="b4-step__detail-empty">No details yet.</p></div>',
    )
    expect(renderToStaticMarkup(<StepDetail args="{not json" />)).toBe(
      '<div class="b4-step__detail"><p class="b4-step__value">{not json</p></div>',
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
      `<p class="b4-step__value">${"x".repeat(MAX_DETAIL_CHARS)}\n… (truncated)</p>`,
    )
  })
})
