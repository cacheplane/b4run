import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import Page, { metadata } from "./page"

it("shows the draft banner and stays noindex", () => {
  const out = renderToStaticMarkup(<Page />)
  expect(out).toContain("Draft: not yet reviewed")
  expect(out).toMatch(/Privacy/)
  expect(metadata.robots).toMatchObject({ index: false })
})

it("does not reuse the B4 privacy page", () => {
  const out = renderToStaticMarkup(<Page />)
  expect(out).not.toContain("2843 NW Lolo Dr")
  expect(out).not.toContain("B4_TELEMETRY_DISABLED")
})
