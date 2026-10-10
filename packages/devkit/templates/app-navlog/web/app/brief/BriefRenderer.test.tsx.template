// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { BriefRenderer } from "./BriefRenderer"
import { BriefActionsContext, BriefMarkdownContext } from "./components"

/** A planning answer in the exact wrapper shape `briefJsonSchema` asks for. */
const ANSWER = JSON.stringify({
  ui: [
    {
      BottomLine: {
        props: { level: "CAUTION", reason: "Gusts to 25 kt at KRST.", cite: ["c2"] },
      },
    },
    {
      KeyNumbers: {
        props: {
          items: [
            { label: "ETE", value: "1:12", unit: null, cite: [] },
            { label: "Fuel burned", value: "9.4", unit: "gal", cite: ["c1"] },
          ],
        },
      },
    },
    {
      Assumptions: {
        props: { items: [{ statement: "Full fuel, 40 gal usable.", origin: "default" }] },
      },
    },
    {
      Citations: {
        props: {
          items: [
            { id: "c1", source: "poh/cruise-performance.md", locator: "Figure 5-7" },
            { id: "c2", source: "METAR KRST 1353Z", locator: "" },
          ],
        },
      },
    },
  ],
})

describe("BriefRenderer", () => {
  test("a complete JSON answer renders its components, citations resolved", () => {
    const html = renderToStaticMarkup(<BriefRenderer content={ANSWER} idPrefix="m1-" />)
    expect(html).toContain("Gusts to 25 kt at KRST.")
    expect(html).toContain('data-level="CAUTION"')
    expect(html).toContain("1:12")
    expect(html).toContain("9.4")
    expect(html).toContain('id="m1-cite-c2"')
    // The bottom line cites c2, the second source.
    expect(html).toMatch(/href="#m1-cite-c2"[^>]*>2<\/a>/)
    expect(html).not.toContain("{&quot;ui")
  })

  test("every prefix of a streamed answer renders what is complete so far, without throwing", () => {
    let seenBottomLine = false
    for (let n = 0; n <= ANSWER.length; n += 7) {
      const html = renderToStaticMarkup(<BriefRenderer content={ANSWER.slice(0, n)} />)
      // A prefix is never shown as raw JSON.
      expect(html).not.toContain("{&quot;ui")
      if (html.includes("Gusts to 25 kt at KRST.")) seenBottomLine = true
      if (seenBottomLine) expect(html).toContain('data-level="CAUTION"')
    }
    expect(seenBottomLine).toBe(true)
    // Mid-stream: the bottom line is done, the numbers are not yet.
    const cut = ANSWER.indexOf('"Fuel burned"')
    const html = renderToStaticMarkup(<BriefRenderer content={ANSWER.slice(0, cut)} />)
    expect(html).toContain("Gusts to 25 kt at KRST.")
    expect(html).not.toContain("9.4")
  })

  test("a single Prose shows its text while it streams, not only once it closes", () => {
    const reply = JSON.stringify({
      ui: [{ Prose: { props: { markdown: "Recorded the flight plan for N738ZU." } } }],
    })
    const html = renderToStaticMarkup(
      <BriefRenderer content={reply.slice(0, reply.indexOf("for N738ZU"))} />,
    )
    expect(html).toContain("Recorded the flight plan")
    expect(html).not.toContain("{&quot;ui")
  })

  test("is memoized, so a host re-render with the same answer skips the parse", () => {
    expect((BriefRenderer as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    )
  })

  test("plain markdown renders through the markdown renderer", () => {
    const html = renderToStaticMarkup(
      <BriefRenderer content={"**Filed.** Recorded the flight plan."} />,
    )
    expect(html).toContain("<strong>Filed.</strong>")
    expect(html).toContain("wb-prose")
  })

  test("the markdown fallback is the host's renderer when it provides one", () => {
    const html = renderToStaticMarkup(
      <BriefMarkdownContext.Provider value={({ content }) => <pre>{content}</pre>}>
        <BriefRenderer content="Filed." />
      </BriefMarkdownContext.Provider>,
    )
    expect(html).toBe("<pre>Filed.</pre>")
  })

  test("a complete string that is not a usable answer falls back to markdown", () => {
    expect(renderToStaticMarkup(<BriefRenderer content="{ not json }" />)).toContain("{ not json }")
    expect(renderToStaticMarkup(<BriefRenderer content='{"ui": 3}' />)).toContain("{&quot;ui")
  })

  test("an assumption's Change calls the chat's changeAssumption with the statement", async () => {
    const changeAssumption = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <BriefActionsContext.Provider value={{ changeAssumption, changeDisabled: false }}>
          <BriefRenderer content={ANSWER} />
        </BriefActionsContext.Provider>,
      )
    })
    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Change: Full fuel, 40 gal usable."]',
    )
    expect(button).not.toBeNull()
    button?.click()
    expect(changeAssumption).toHaveBeenCalledWith("Full fuel, 40 gal usable.")
    await act(async () => root.unmount())
    host.remove()
  })
})
