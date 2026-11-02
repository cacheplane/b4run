import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import Page, { metadata } from "./page"

it("explains pairing and downloading the Mac app", () => {
  const out = renderToStaticMarkup(<Page />)
  expect(out).toContain("Add your iPhone")
  expect(out).toMatch(/Camera/)
  expect(out).toContain('href="/app/download"')
  expect(metadata.robots).toMatchObject({ index: false })
})
