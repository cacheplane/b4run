import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import Page, { metadata } from "./page"

it("shows the draft banner and stays noindex", () => {
  const out = renderToStaticMarkup(<Page />)
  expect(out).toContain("Draft: not yet reviewed")
  expect(out).toMatch(/Terms/)
  expect(metadata.robots).toMatchObject({ index: false })
})
