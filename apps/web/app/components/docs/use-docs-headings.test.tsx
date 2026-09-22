// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DocsTOC } from "./DocsTOC"
import { MobileDocsTOC } from "./MobileDocsTOC"

const location = vi.hoisted(() => ({ pathname: "/docs/getting-started" }))
vi.mock("next/navigation", () => ({ usePathname: () => location.pathname }))

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount())
  roots.length = 0
  document.body.innerHTML = ""
})

function setArticle(html: string) {
  document.querySelector("article.prose-b4")?.remove()
  const article = document.createElement("article")
  article.className = "prose-b4"
  article.innerHTML = html
  document.body.append(article)
}

const tocLinks = (root: ParentNode) =>
  Array.from(root.querySelectorAll("a")).map((a) => a.textContent)

describe("docs on-this-page", () => {
  it("re-reads the headings when the pathname changes (persistent layout TOC)", async () => {
    location.pathname = "/docs/getting-started"
    setArticle('<h2 id="install">Install</h2><h3>First run</h3>')
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<DocsTOC />))
    expect(tocLinks(container)).toEqual(["Install", "First run"])
    expect(container.querySelector('a[href="#first-run"]')).not.toBeNull()

    // Client-side navigation: the layout (and this TOC) stays mounted.
    location.pathname = "/docs/tools"
    setArticle('<h2 id="a-minimal-tool">A minimal tool</h2>')
    await act(async () => root.render(<DocsTOC />))
    expect(tocLinks(container)).toEqual(["A minimal tool"])
  })

  it("renders a collapsible mobile outline hidden at lg", async () => {
    location.pathname = "/docs/tools"
    setArticle('<h2 id="shared-tools">Shared tools</h2>')
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<MobileDocsTOC />))
    const details = container.querySelector("details")
    expect(details?.className).toContain("lg:hidden")
    expect(details?.querySelector("summary")?.textContent).toContain("On this page")
    expect(tocLinks(container)).toEqual(["Shared tools"])
    details?.setAttribute("open", "")
    await act(async () => container.querySelector("a")?.click())
    expect(details?.open).toBe(false)
  })
})
