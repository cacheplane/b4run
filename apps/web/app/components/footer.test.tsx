import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { Footer } from "./Footer"
import { NAVLOG_DEMO_URL } from "./site-links"

/**
 * The opening `<a …>` tag whose href is exactly `href`. Plain string search
 * rather than a RegExp built from the href: a hostname in a pattern reads as
 * an incomplete hostname check to static analysis, and nothing here needs
 * pattern matching.
 */
const anchor = (html: string, href: string) => {
  const at = html.indexOf(`href="${href}"`)
  expect(at, href).toBeGreaterThanOrEqual(0)
  const start = html.lastIndexOf("<a ", at)
  const end = html.indexOf(">", at)
  expect(start, href).toBeGreaterThanOrEqual(0)
  expect(end, href).toBeGreaterThan(start)
  return html.slice(start, end + 1)
}

it("opens same-origin files in a new tab as plain anchors, off-site links with rel, internal links in place", () => {
  const html = renderToStaticMarkup(<Footer />)
  // `target` on SiteLink forces a plain <a> (see primitives.test.tsx), so the
  // client router never intercepts these file URLs.
  for (const href of ["/blog/rss.xml", "/llms.txt"]) {
    const tag = anchor(html, href)
    expect(tag).toContain('target="_blank"')
    expect(tag).not.toContain("rel=")
  }
  const github = anchor(html, "https://github.com/cacheplane/b4run")
  expect(github).toContain('target="_blank"')
  expect(github).toContain('rel="noopener noreferrer"')
  for (const href of ["/docs/getting-started", "/blog", "/privacy"]) {
    const tag = anchor(html, href)
    expect(tag).not.toContain("target=")
    expect(tag).not.toContain("rel=")
  }
  expect(html).not.toContain("↗")
})

it("no longer links the code-fixer walkthrough, which left the homepage", () => {
  const html = renderToStaticMarkup(<Footer />)
  expect(html).not.toMatch(/walkthrough|code-fixer/i)
})

it("tags its calls to action and marks the footer surface", () => {
  const html = renderToStaticMarkup(<Footer />)
  expect(html).toContain('data-signal-surface="footer"')
  const cases: [string, string][] = [
    ["https://github.com/cacheplane/b4run", "footer_github"],
    ["https://www.npmjs.com/org/b4run", "footer_npm"],
    [NAVLOG_DEMO_URL, "footer_live_demo"],
    ["/blog/rss.xml", "footer_rss"],
  ]
  for (const [href, id] of cases) expect(anchor(html, href)).toContain(`data-cta-id="${id}"`)
})
