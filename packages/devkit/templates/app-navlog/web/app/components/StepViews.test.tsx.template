// @vitest-environment jsdom
import type { ToolStep } from "@b4run/ag-ui/view"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { ChartStepView, NAVLOG_STEP_RENDERERS, NavlogStepView } from "./StepViews"
import { SheetControlContext } from "./sheet-control"

function step(extra: Partial<ToolStep> & Pick<ToolStep, "name">): ToolStep {
  return { kind: "tool", id: "call_1", status: "done", args: "{}", startedAt: 0, ...extra }
}

describe("NavlogStepView", () => {
  test("a done navlog reads as a one-line summary with a way to the sheet", () => {
    const html = renderToStaticMarkup(
      <NavlogStepView
        step={step({ name: "computeNavlog", result: JSON.stringify(SAMPLE_NAVLOG) })}
      />,
    )
    expect(html).toContain("66 nm")
    expect(html).toContain("2 legs")
    expect(html).toContain("5.5 gal")
    expect(html).toContain("See the navlog sheet")
    expect(html).not.toContain("b4-step__detail")
  })

  test("the button opens the sheet through SheetControlContext", () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const openSheet = vi.fn()
    const container = document.createElement("div")
    const root = createRoot(container)
    act(() =>
      root.render(
        <SheetControlContext.Provider value={{ openSheet }}>
          <NavlogStepView
            step={step({ name: "computeNavlog", result: JSON.stringify(SAMPLE_NAVLOG) })}
          />
        </SheetControlContext.Provider>,
      ),
    )
    const button = container.querySelector("button")
    expect(button?.textContent).toBe("See the navlog sheet")
    act(() => button?.click())
    expect(openSheet).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
  })

  test("a running call, or a result that is not a navlog, falls back to the kit's detail", () => {
    const running = renderToStaticMarkup(
      <NavlogStepView step={step({ name: "computeNavlog", status: "running", args: '{"a":1}' })} />,
    )
    expect(running).toContain("b4-step__detail")
    expect(running).not.toContain("See the navlog sheet")
    const garbage = renderToStaticMarkup(
      <NavlogStepView step={step({ name: "computeNavlog", result: "oops" })} />,
    )
    expect(garbage).toContain("Result")
    expect(garbage).toContain("oops")
  })
})

describe("ChartStepView", () => {
  test("draws the step's media parts", () => {
    const html = renderToStaticMarkup(
      <ChartStepView
        step={step({
          name: "renderChart",
          result: "Chart rendered.",
          parts: [
            {
              type: "image",
              source: { type: "data", value: "PHN2Zz4=", mimeType: "image/svg+xml" },
            },
          ],
        })}
      />,
    )
    expect(html).toContain('src="data:image/svg+xml;base64,PHN2Zz4="')
    expect(html).not.toContain("b4-step__detail")
  })

  test("with no parts, falls back to the kit's detail", () => {
    const html = renderToStaticMarkup(
      <ChartStepView step={step({ name: "renderChart", result: "Chart rendered." })} />,
    )
    expect(html).not.toContain("<img")
    expect(html).toContain("Chart rendered.")
  })
})

describe("NAVLOG_STEP_RENDERERS", () => {
  test("registers the navlog and chart views by tool name only", () => {
    expect(Object.keys(NAVLOG_STEP_RENDERERS).sort()).toEqual(["computeNavlog", "renderChart"])
  })
})
