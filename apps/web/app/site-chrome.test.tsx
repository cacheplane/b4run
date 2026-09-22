// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ComponentType, ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { useMDXComponents } from "../mdx-components"
import { CodeHeaderRow, TabPill } from "./components/mdx/CodeBlock"
import { ReadingLayout } from "./components/ReadingLayout"
import RootLayout from "./layout"

vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "font-inter" }),
  JetBrains_Mono: () => ({ variable: "font-mono" }),
}))
vi.mock("./components/Header", () => ({ Header: () => <header>header</header> }))

const appDir = resolve(__dirname)
const read = (path: string) => readFileSync(resolve(appDir, path), "utf8")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) ? [path] : []
  })
}

function renderRoot(): Document {
  const html = renderToStaticMarkup(
    <RootLayout>
      <p>page</p>
    </RootLayout>,
  )
  return new DOMParser().parseFromString(html, "text/html")
}

describe("site footer", () => {
  it("is rendered on the server for every route, so hydration cannot drop it", () => {
    const doc = renderRoot()
    expect(doc.querySelectorAll("footer[data-site-footer]")).toHaveLength(1)
    expect(read("layout.tsx")).not.toMatch(/HideOnDocs|usePathname/)
  })

  it("is hidden by CSS only where the docs layout renders its marker", () => {
    expect(read("docs/layout.tsx")).toMatch(/<div data-docs-brand data-docs-layout>/)
    expect(read("globals.css")).toMatch(
      /body:has\(\[data-docs-layout\]\) \[data-site-footer\] \{\s*display: none;/,
    )
  })
})

describe("skip link and landmarks", () => {
  it("puts the skip link first in the body, pointing at #content", () => {
    const doc = renderRoot()
    const first = doc.body.querySelector("a, button, input, [tabindex]")
    expect(first?.textContent).toBe("Skip to content")
    expect(first?.getAttribute("href")).toBe("#content")
  })

  it("leaves <main> to each page instead of wrapping every route", () => {
    expect(renderRoot().querySelectorAll("main")).toHaveLength(0)
  })

  it("wraps only the article column of a reading layout in <main>", () => {
    const html = renderToStaticMarkup(
      <ReadingLayout
        left={<nav>sidebar</nav>}
        leftLabel="Docs sidebar"
        right={<nav>toc</nav>}
        rightLabel="Page contents"
      >
        <article>body</article>
      </ReadingLayout>,
    )
    const doc = new DOMParser().parseFromString(html, "text/html")
    const mains = doc.querySelectorAll("main")
    expect(mains).toHaveLength(1)
    const main = mains[0]
    expect(main?.id).toBe("content")
    expect(main?.getAttribute("tabindex")).toBe("-1")
    expect(main?.querySelector("article")).not.toBeNull()
    expect(main?.querySelector("aside")).toBeNull()
    expect(main?.closest("aside")).toBeNull()
    // Two complementary landmarks must be told apart (axe landmark-unique).
    expect([...doc.querySelectorAll("aside")].map((a) => a.getAttribute("aria-label"))).toEqual([
      "Docs sidebar",
      "Page contents",
    ])
  })

  it("gives every non-reading page its own focusable <main id=content>", () => {
    for (const path of [
      "components/homepage/DeveloperHome.tsx",
      "blog/page.tsx",
      "blog/tags/[tag]/page.tsx",
      "not-found.tsx",
    ]) {
      expect(read(path), path).toMatch(/<main id="content" tabIndex=\{-1\}/)
    }
  })
})

describe("Fraunces removal", () => {
  it("no longer loads Fraunces or uses the display font", () => {
    const files = [...sourceFiles(appDir), resolve(appDir, "../mdx-components.tsx")]
    for (const file of files) {
      const source = readFileSync(file, "utf8")
      expect(source, file).not.toMatch(/Fraunces|--font-fraunces|font-display|'opsz'|'SOFT'/)
    }
  })
})

describe("keyboard-reachable scroll regions", () => {
  it("makes the prose table wrapper a named, focusable region", () => {
    const Table = useMDXComponents({}).table as ComponentType<{ children?: ReactNode }>
    const html = renderToStaticMarkup(<Table />)
    const wrapper = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector("[data-prose-table]")
    // A <section> with an accessible name is a region landmark.
    expect(wrapper?.tagName).toBe("SECTION")
    expect(wrapper?.getAttribute("aria-label")).toBeTruthy()
    expect(wrapper?.getAttribute("tabindex")).toBe("0")
  })

  it("wraps code tabs onto a new row instead of scrolling them", () => {
    const html = renderToStaticMarkup(<CodeHeaderRow left={<span>a.ts</span>} right={null} />)
    const strip = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector("[data-code-header] > div")
    expect(strip?.className).toContain("flex-wrap")
    expect(read("docs/docs-brand.css")).not.toMatch(/overflow-x: auto/)
  })

  it("lets a long file-name tab break after each slash", () => {
    const html = renderToStaticMarkup(<TabPill label="server/src/index.ts" active />)
    expect(html).toContain("server/<wbr/>src/<wbr/>index.ts")
  })
})

describe("homepage contrast", () => {
  it("uses the darkened olive for text (4.74:1 on paper, not 4.48:1)", () => {
    const css = read("components/homepage/homepage.module.css")
    expect(css).not.toMatch(/(^|[^-])color: #667811/m)
    expect(css.match(/color: #627410/g)).toHaveLength(2)
  })
})
