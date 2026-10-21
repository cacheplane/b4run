// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { CTA_IDS, SIGNAL_SURFACES } from "../lib/analytics/events"
import { BlogCta } from "./blog/BlogCta"
import { CopyPromptButton } from "./CopyPromptButton"
import { Footer } from "./Footer"
import { HeaderInner } from "./HeaderInner"
import { MobileMenu } from "./MobileMenu"

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}))

it("only uses declared call-to-action ids and surfaces in rendered markup", () => {
  const html = [
    renderToStaticMarkup(<Footer />),
    renderToStaticMarkup(<BlogCta />),
    renderToStaticMarkup(<HeaderInner repoUrl="https://github.com/cacheplane/b4run" />),
    renderToStaticMarkup(<MobileMenu />),
    renderToStaticMarkup(<CopyPromptButton prompt="p" variant="docs" />),
  ].join("")
  document.body.innerHTML = html
  const ids = [...document.querySelectorAll("[data-cta-id]")].map((e) =>
    e.getAttribute("data-cta-id"),
  )
  const surfaces = [...document.querySelectorAll("[data-signal-surface]")].map((e) =>
    e.getAttribute("data-signal-surface"),
  )
  expect(ids.length).toBeGreaterThan(10)
  expect(surfaces).toEqual(expect.arrayContaining(["header", "mobile_nav", "footer", "blog"]))
  for (const id of ids) expect(CTA_IDS as readonly (string | null)[]).toContain(id)
  for (const s of surfaces) expect(SIGNAL_SURFACES as readonly (string | null)[]).toContain(s)
})
