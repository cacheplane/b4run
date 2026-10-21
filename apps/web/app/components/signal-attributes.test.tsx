// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { track } from "../lib/analytics/client"
import { CTA_IDS, SIGNAL_SURFACES } from "../lib/analytics/events"
import { BlogCta } from "./blog/BlogCta"
import { CopyPromptButton } from "./CopyPromptButton"
import { Footer } from "./Footer"
import { HeaderInner } from "./HeaderInner"
import { MobileMenu } from "./MobileMenu"

vi.mock("../lib/analytics/client", () => ({ track: vi.fn() }))

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

it.each([
  ["header", <HeaderInner key="h" repoUrl="https://github.com/cacheplane/b4run" />],
  ["mobile_nav", <MobileMenu key="m" />],
] as const)(
  "the %s install chip reports its surface and never the command",
  async (surface, element) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    })
    vi.mocked(track).mockClear()
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(element))
    const chip = container.querySelector<HTMLButtonElement>('[data-ui="copy-command"] button')
    await act(async () => chip?.click())
    expect(track).toHaveBeenCalledWith("site:install_command_copied", { surface })
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toContain("npm create")
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  },
)
