import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"

async function loadBlogCta(enabled: boolean) {
  vi.resetModules()
  vi.doMock("../../lib/growth/updates-enabled", () => ({ UPDATES_FORM_ENABLED: enabled }))
  return (await import("./BlogCta")).BlogCta
}

afterEach(() => vi.doUnmock("../../lib/growth/updates-enabled"))

it.each([true, false])(
  "sends readers to Getting Started, not the code-fixer walkthrough (enabled=%s)",
  async (enabled) => {
    const BlogCta = await loadBlogCta(enabled)
    const html = renderToStaticMarkup(<BlogCta />)
    expect(html).toContain('href="/docs/getting-started"')
    expect(html).toContain("npm create b4-app@latest my-agent")
    expect(html).not.toMatch(/walkthrough|code-fixer/i)
  },
)

it.each([true, false])(
  "marks the blog surface and tags the Getting Started link (enabled=%s)",
  async (enabled) => {
    const BlogCta = await loadBlogCta(enabled)
    const html = renderToStaticMarkup(<BlogCta />)
    expect(html).toContain('data-signal-surface="blog"')
    expect(html).toMatch(
      /<a [^>]*href="\/docs\/getting-started"[^>]*data-cta-id="blog_cta_get_started"/,
    )
  },
)

it("offers founder updates with its own call-to-action id when enabled", async () => {
  const BlogCta = await loadBlogCta(true)
  const html = renderToStaticMarkup(<BlogCta />)
  expect(html).toMatch(/<a [^>]*href="\/updates"[^>]*data-cta-id="blog_cta_updates"/)
  expect(html).toContain("Get updates from Brian")
})

it("omits the founder updates link when not enabled", async () => {
  const BlogCta = await loadBlogCta(false)
  const html = renderToStaticMarkup(<BlogCta />)
  expect(html).not.toContain('href="/updates"')
  expect(html).not.toContain("Get updates from Brian")
})
