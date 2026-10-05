import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { NavlogCardView } from "./NavlogCard"

// Same stub as ToolCallCard.test.tsx: the real module imports CSS Node cannot load.
vi.mock("@copilotkit/react-core/v2", () => ({ useRenderTool: () => {} }))

describe("NavlogCardView", () => {
  test("in progress shows a skeleton line", () => {
    const html = renderToStaticMarkup(<NavlogCardView status="inProgress" parameters={{}} />)
    expect(html).toContain("Computing the navlog")
  })
  test("complete shows the compact summary from the result", () => {
    const html = renderToStaticMarkup(
      <NavlogCardView status="complete" parameters={{}} result={JSON.stringify(SAMPLE_NAVLOG)} />,
    )
    expect(html).toContain("computeNavlog")
    expect(html).toContain("66 nm")
    expect(html).toContain("2 legs")
    expect(html).toContain("5.5 gal")
  })
  test("a result that is not a navlog falls back to the tool name", () => {
    const html = renderToStaticMarkup(
      <NavlogCardView status="complete" parameters={{}} result="oops" />,
    )
    expect(html).toContain("computeNavlog")
    expect(html).not.toContain("nm")
  })
})
