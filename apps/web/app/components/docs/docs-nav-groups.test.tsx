// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { DocsNavGroups } from "./DocsNavGroups"
import { DocsNoScriptNav } from "./DocsNoScriptNav"
import { DOCS_NAV, DOCS_PAGES } from "./nav"

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount())
  roots.length = 0
  document.body.innerHTML = ""
})

describe("desktop docs sidebar groups", () => {
  it("collapses every section except the current page's", () => {
    const markup = renderToStaticMarkup(
      createElement(DocsNavGroups, { pathname: "/docs/deployment/vercel", variant: "sidebar" }),
    )
    const groups = [...markup.matchAll(/<details([^>]*)>([\s\S]*?)<\/details>/g)]
    expect(groups).toHaveLength(DOCS_NAV.length)
    const open = groups.filter(([, attributes]) => attributes?.includes("open"))
    expect(open).toHaveLength(1)
    expect(open[0]?.[2]).toContain(">Deploy<")
    expect(markup).toMatch(
      /<a(?=[^>]*href="\/docs\/deployment\/vercel")(?=[^>]*aria-current="page")/,
    )
    expect(markup.match(/data-docs-nav-item/g)).toHaveLength(DOCS_PAGES.length)
  })

  it("reopens a collapsed current group and scrolls its link into the rail", async () => {
    const scroller = document.createElement("aside")
    scroller.setAttribute("data-docs-nav-scroller", "")
    document.body.append(scroller)
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 800, height: 800 }) as DOMRect
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
      return this.getAttribute("aria-current") === "page"
        ? ({ top: 2075, bottom: 2105, height: 30 } as DOMRect)
        : originalRect.call(this)
    }
    try {
      const root = createRoot(scroller)
      roots.push(root)
      await act(async () =>
        root.render(
          createElement(DocsNavGroups, { pathname: "/docs/deployment/vercel", variant: "sidebar" }),
        ),
      )
      expect(scroller.scrollTop).toBeCloseTo(2075 - 800 / 3)

      const group = scroller.querySelector<HTMLDetailsElement>("details[open]")
      if (group) group.open = false
      await act(async () =>
        root.render(
          createElement(DocsNavGroups, { pathname: "/docs/deployment/node", variant: "sidebar" }),
        ),
      )
      expect(scroller.querySelector('[aria-current="page"]')?.closest("details")?.open).toBe(true)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })
})

describe("no-JS docs navigation", () => {
  it("renders every docs link inside a noscript disclosure", () => {
    const markup = renderToStaticMarkup(createElement(DocsNoScriptNav))
    expect(markup).toMatch(/^<noscript><details[^>]*data-docs-noscript-nav/)
    for (const page of DOCS_PAGES) expect(markup).toContain(`href="${page.href}"`)
  })
})
