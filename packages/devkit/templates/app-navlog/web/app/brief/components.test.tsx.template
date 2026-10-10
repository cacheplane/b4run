// @vitest-environment jsdom
import { createUiJsonSchema } from "@hashbrownai/core"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import {
  Assumptions,
  BottomLine,
  BriefActionsContext,
  BriefMarkdownContext,
  BriefVerdictContext,
  briefComponents,
  Citations,
  CitationsContext,
  KeyNumbers,
  Prose,
  RouteSummary,
  WatchFor,
} from "./components"
import { briefJsonSchema } from "./kit"
import { briefDefinitions } from "./schema"

const CITATIONS = [
  { id: "c1", source: "poh/cruise-performance.md", locator: "Figure 5-7" },
  { id: "c2", source: "METAR KRST 1353Z", locator: "" },
]

function withCitations(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <CitationsContext.Provider value={{ items: CITATIONS, idPrefix: "" }}>
      {node}
    </CitationsContext.Provider>,
  )
}

describe("briefComponents", () => {
  test("pairs every definition with its component, name and description unchanged", () => {
    expect(briefComponents.map((c) => c.name)).toEqual(briefDefinitions.map((d) => d.name))
    for (const [i, exposed] of briefComponents.entries()) {
      expect(exposed.description).toBe(briefDefinitions[i]?.description)
      expect(exposed.props).toBe(briefDefinitions[i]?.props)
      expect(typeof exposed.component).toBe("function")
    }
  })

  test("the browser's kit asks for exactly the schema the server route sends", () => {
    expect(createUiJsonSchema({ components: briefComponents })).toEqual(briefJsonSchema)
  })
})

describe("BottomLine", () => {
  test("shows the level as a word and the reason, with citation markers", () => {
    const html = withCitations(
      <BottomLine level="CAUTION" reason="Freezing level below cruise." cite={["c2"]} />,
    )
    expect(html).toContain('data-level="CAUTION"')
    expect(html).toContain(">CAUTION<")
    expect(html).toContain("Freezing level below cruise.")
    expect(html).toContain('href="#cite-c2"')
    expect(html).toMatch(/<sup[^>]*><a[^>]*>2<\/a><\/sup>/)
  })

  test("under a worse card verdict it shows that level and notes the planner's", () => {
    const raised = {
      level: "CAUTION" as const,
      reason: "Gusty.",
      raisedFrom: "GO" as const,
      floorReasons: ["gusts 25 kt at KRST"],
    }
    const html = renderToStaticMarkup(
      <BriefVerdictContext.Provider value={raised}>
        <BottomLine level="GO" reason="VFR." cite={[]} />
      </BriefVerdictContext.Provider>,
    )
    expect(html).toContain('data-level="CAUTION"')
    expect(html).not.toContain('data-level="GO"')
    expect(html).toContain("The planner said GO. Raised: gusts 25 kt at KRST.")
    const same = renderToStaticMarkup(
      <BriefVerdictContext.Provider value={raised}>
        <BottomLine level="NO-GO" reason="Ice." cite={[]} />
      </BriefVerdictContext.Provider>,
    )
    expect(same).toContain('data-level="NO-GO"')
    expect(same).not.toContain("The planner said")
  })

  test("a citation id the answer does not list draws no marker", () => {
    const html = withCitations(<BottomLine level="GO" reason="Clear." cite={["c9"]} />)
    expect(html).not.toContain("<sup")
  })
})

describe("RouteSummary", () => {
  test("shows the airports in order, the altitude and the departure in mono", () => {
    const html = renderToStaticMarkup(
      <RouteSummary
        from="KSTP"
        to="KRST"
        via={["RWF"]}
        altitudeFt={5500}
        departureUtc="2026-10-10 1500Z"
      />,
    )
    expect(html.indexOf("KSTP")).toBeLessThan(html.indexOf("RWF"))
    expect(html.indexOf("RWF")).toBeLessThan(html.indexOf("KRST"))
    expect(html).toContain("5,500 ft")
    expect(html).toContain("2026-10-10 1500Z")
    expect(html).toContain("font-mono")
  })
})

describe("WatchFor", () => {
  test("rows carry their severity as data and words, and the time in mono", () => {
    const html = withCitations(
      <WatchFor
        items={[
          {
            what: "Freezing level 4,000 ft",
            when: "2100Z–0300Z",
            severity: "danger",
            cite: ["c2"],
          },
          { what: "Gusty crosswind at KRST", when: null, severity: "caution", cite: [] },
        ]}
      />,
    )
    expect(html).toContain('data-severity="danger"')
    expect(html).toContain('data-severity="caution"')
    expect(html).toContain("Danger")
    expect(html).toContain("2100Z–0300Z")
    expect(html).toContain("Gusty crosswind at KRST")
    expect(html).toContain('href="#cite-c2"')
  })

  test("with nothing to watch it says so", () => {
    expect(renderToStaticMarkup(<WatchFor items={[]} />)).toContain("Nothing during the flight")
  })
})

describe("KeyNumbers", () => {
  test("figures are mono tabular with their units", () => {
    const html = withCitations(
      <KeyNumbers
        items={[
          { label: "ETE", value: "1:12", unit: null, cite: [] },
          { label: "Fuel burned", value: "9.4", unit: "gal", cite: ["c1"] },
        ]}
      />,
    )
    expect(html).toContain("ETE")
    expect(html).toContain("1:12")
    expect(html).toContain("Fuel burned")
    expect(html).toMatch(/font-mono[^"]*tabular-nums[^>]*>9\.4/)
    expect(html).toContain("gal")
    expect(html).toContain('href="#cite-c1"')
  })
})

describe("Assumptions", () => {
  test("each statement is tagged with its origin and has a Change button", () => {
    const html = renderToStaticMarkup(
      <Assumptions
        items={[
          { statement: "Full fuel, 40 gal usable.", origin: "default" },
          { statement: "Departing KSTP.", origin: "pilot" },
        ]}
      />,
    )
    expect(html).toContain("Full fuel, 40 gal usable.")
    expect(html).toContain('data-origin="default"')
    expect(html).toContain("Default")
    expect(html).toContain("You said")
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).toContain(">Change<")
  })

  test("Change hands the statement to the brief's actions", async () => {
    const changeAssumption = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <BriefActionsContext.Provider value={{ changeAssumption }}>
          <Assumptions items={[{ statement: "Full fuel.", origin: "memory" }]} />
        </BriefActionsContext.Provider>,
      )
    })
    host.querySelector("button")?.click()
    expect(changeAssumption).toHaveBeenCalledWith("Full fuel.")
    await act(async () => root.unmount())
    host.remove()
  })
})

describe("Citations", () => {
  test("numbers the sources with anchors the markers link to", () => {
    const html = renderToStaticMarkup(<Citations items={CITATIONS} />)
    expect(html).toContain('id="cite-c1"')
    expect(html).toContain('id="cite-c2"')
    expect(html).toContain("poh/cruise-performance.md")
    expect(html).toContain("Figure 5-7")
    expect(html).toContain("<ol")
  })

  test("the anchors take the renderer's prefix, so two answers on one page do not collide", () => {
    const html = renderToStaticMarkup(
      <CitationsContext.Provider value={{ items: CITATIONS, idPrefix: "m1-" }}>
        <Citations items={CITATIONS} />
        <BottomLine level="GO" reason="Clear." cite={["c1"]} />
      </CitationsContext.Provider>,
    )
    expect(html).toContain('id="m1-cite-c1"')
    expect(html).toContain('href="#m1-cite-c1"')
  })
})

describe("Prose", () => {
  test("renders its markdown", () => {
    const html = renderToStaticMarkup(
      <Prose markdown={"**Filed.** Recorded the flight plan.\n\n- one\n- two"} />,
    )
    expect(html).toContain("<strong")
    expect(html).toContain("Filed.")
    expect(html).toContain("<li>one</li>")
    expect(html).toContain("wb-prose")
  })

  test("uses the markdown renderer the host provides", () => {
    const html = renderToStaticMarkup(
      <BriefMarkdownContext.Provider value={({ content }) => <pre>{content}</pre>}>
        <Prose markdown="**Filed.**" />
      </BriefMarkdownContext.Provider>,
    )
    expect(html).toContain("<pre>**Filed.**</pre>")
  })
})
