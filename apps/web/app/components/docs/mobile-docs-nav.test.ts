import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { MobileDocsNav } from "./MobileDocsNav"
import { DOCS_NAV, DOCS_PAGES } from "./nav"

describe("MobileDocsNav", () => {
  it("renders native section disclosures with only the active section open", () => {
    const pathname = "/docs/testing"
    const markup = renderToStaticMarkup(
      createElement(MobileDocsNav, { pathname, onNavigate: () => undefined }),
    )
    const disclosures = [...markup.matchAll(/<details([^>]*)>([\s\S]*?)<\/details>/g)]

    expect(markup).toContain('<nav aria-label="Documentation"')
    expect(disclosures).toHaveLength(DOCS_NAV.length)
    expect(markup.match(/<summary/g)).toHaveLength(DOCS_NAV.length)
    // Proxy check: the ring itself is global (base.css); this only guards against re-suppressing it here.
    for (const summary of markup.matchAll(/<summary class="([^"]+)"/g)) {
      // The global :focus-visible ring must not be suppressed.
      expect(summary[1]).not.toContain("focus-visible:outline-none")
      expect(summary[1]).not.toMatch(/rounded/)
    }
    expect(disclosures.filter(([, attributes]) => attributes?.includes("open"))).toHaveLength(1)
    expect(disclosures.find(([, attributes]) => attributes?.includes("open"))?.[2]).toContain(
      ">Test<",
    )
  })

  it("marks the current page and includes every registered page link", () => {
    const pathname = "/docs/testing"
    const markup = renderToStaticMarkup(
      createElement(MobileDocsNav, { pathname, onNavigate: () => undefined }),
    )

    expect(markup).toMatch(
      new RegExp(`<a(?=[^>]*href="${pathname}")(?=[^>]*aria-current="page")[^>]*>`),
    )
    for (const page of DOCS_PAGES) {
      expect(markup).toContain(`href="${page.href}"`)
    }
  })
})
