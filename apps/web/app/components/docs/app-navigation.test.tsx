import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import config from "../../../next.config"
import frameworkHrefs from "./__fixtures__/framework-hrefs.json"
import { DocsNavGroups } from "./DocsNavGroups"
import { DocsNoScriptNav } from "./DocsNoScriptNav"
import { DocsSectionSwitcher } from "./DocsSectionSwitcher"
import { docsArea } from "./doc-sections"
import { docContentPath } from "./doc-sources"
import {
  filterDocsSearchResults,
  flattenDocsSearchIndex,
  resultsForArea,
} from "./docs-search-results"
import { MobileDocsNav } from "./MobileDocsNav"
import { ALL_DOCS_PAGES, breadcrumbsFor, navFor, siblingsFor } from "./nav"
import { DOCS_INDEX } from "./search-index"

describe("app documentation", () => {
  it("preserves every framework URL in its original order", () => {
    expect(
      ALL_DOCS_PAGES.filter((p) => docsArea(p.href) === "framework").map((p) => p.href),
    ).toEqual(frameworkHrefs)
  })
  it("filters search by audience before ranking and keeps heading results in scope", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    for (const area of ["app", "framework"] as const) {
      const scoped = resultsForArea(results, area)
      expect(scoped.length).toBeGreaterThan(0)
      expect(scoped.every((result) => docsArea(result.href) === area)).toBe(true)
      expect(
        filterDocsSearchResults("conversation", scoped).every(
          (result) => docsArea(result.href) === area,
        ),
      ).toBe(true)
    }
    expect(resultsForArea(results, "all")).toEqual(results)
  })
  it("uses segment boundaries and normalizes inbound paths", () => {
    expect(docsArea("/docs/app/")).toBe("app")
    expect(docsArea("/docs/app/install?from=home#requirements")).toBe("app")
    expect(docsArea("/docs/application")).toBe("framework")
    expect(docsArea("/docs/api/sdk")).toBe("framework")
    expect(docsArea("/docs")).toBeNull()
    expect(docsArea("/app/download")).toBeNull()
  })
  it("registers ten real app pages once and resolves directory indexes", () => {
    const pages = ALL_DOCS_PAGES.filter((p) => docsArea(p.href) === "app")
    expect(pages).toHaveLength(10)
    expect(new Set(pages.map((p) => p.href)).size).toBe(10)
    expect(docContentPath("/docs/app")).toBe("docs/app/index.mdx")
    expect(docContentPath("/docs/recipes")).toBe("docs/recipes/index.mdx")
    expect(() => docContentPath("/docs/../../secret")).toThrow()
    expect(navFor("app").flatMap((s) => s.items)).toEqual(pages)
  })
  it("keeps reading order within each audience", () => {
    expect(siblingsFor("/docs/app").prev).toBeNull()
    expect(siblingsFor("/docs/app/b4-agents").next).toBeNull()
    expect(siblingsFor("/docs/faq").next).toBeNull()
    expect(breadcrumbsFor("/docs/app/install")).toContainEqual({ label: "App", href: "/docs/app" })
    expect(breadcrumbsFor("/docs/api/sdk")).toContainEqual({
      label: "Framework",
      href: "/docs/getting-started",
    })
  })
  it("renders audience links and app-only navigation on desktop and mobile", () => {
    const switcher = renderToStaticMarkup(
      createElement(DocsSectionSwitcher, { pathname: "/docs/app/install" }),
    )
    expect(switcher).toContain('href="/docs/app"')
    expect(switcher).toContain('aria-current="true"')
    expect(switcher).toContain('href="/docs/getting-started"')
    for (const html of [
      renderToStaticMarkup(
        createElement(DocsNavGroups, { pathname: "/docs/app/install", variant: "sidebar" }),
      ),
      renderToStaticMarkup(
        createElement(MobileDocsNav, { pathname: "/docs/app/install", onNavigate: () => {} }),
      ),
    ]) {
      expect(html).toContain('href="/docs/app/install"')
      expect(html).not.toContain('href="/docs/tools"')
    }
    const fallback = renderToStaticMarkup(createElement(DocsNoScriptNav))
    expect(fallback).toContain('href="/docs/app/install"')
    expect(fallback).toContain('href="/docs/tools"')
  })
  it("serves the docs entrance rather than redirecting to framework setup", async () => {
    const redirects = (await config.redirects?.()) ?? []
    expect(redirects.some((r) => r.source === "/docs")).toBe(false)
  })
})
