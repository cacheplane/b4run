import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { BlogCta } from "./BlogCta"

it("sends readers to Getting Started, not the code-fixer walkthrough", () => {
  const html = renderToStaticMarkup(<BlogCta />)
  expect(html).toContain('href="/docs/getting-started"')
  expect(html).toContain("npm create b4-app@latest my-agent")
  expect(html).not.toMatch(/walkthrough|code-fixer/i)
})

it("marks the blog surface and tags the Getting Started link", () => {
  const html = renderToStaticMarkup(<BlogCta />)
  expect(html).toContain('data-signal-surface="blog"')
  expect(html).toMatch(
    /<a [^>]*href="\/docs\/getting-started"[^>]*data-cta-id="blog_cta_get_started"/,
  )
})
