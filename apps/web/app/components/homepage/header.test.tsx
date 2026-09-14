// @vitest-environment jsdom
import { renderToString } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { HeaderInner } from "../HeaderInner"

const location = vi.hoisted(() => ({ pathname: "/" }))
vi.mock("next/navigation", () => ({ usePathname: () => location.pathname }))
it("keeps the docs header and scopes the blueprint action to home", () => {
  location.pathname = "/"
  const home = renderToString(<HeaderInner repoUrl="https://github.com/cacheplane/b4run" />)
  expect(home).toContain("Get the blueprint")
  expect(home).toContain("/docs/getting-started")
  location.pathname = "/docs/getting-started"
  const docs = renderToString(<HeaderInner repoUrl="https://github.com/cacheplane/b4run" />)
  expect(docs).not.toContain("Get the blueprint")
  expect(docs).toContain("npm create b4-app@latest my-agent")
})
