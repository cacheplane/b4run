// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { track } from "../lib/analytics/client"
import { DISCLOSURE_VERSION, FOUNDER_UPDATES_DISCLOSURE } from "../lib/growth/disclosure"
import { FounderUpdatesForm } from "./FounderUpdatesForm"

vi.mock("../lib/analytics/client", () => ({ track: vi.fn() }))
const ph = vi.hoisted(() => ({
  __loaded: true,
  has_opted_out_capturing: (() => false) as () => boolean,
  get_distinct_id: (() => "distinct-1") as () => string,
}))
vi.mock("posthog-js", () => ({ default: ph }))

const roots: ReturnType<typeof createRoot>[] = []
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement("div")
  document.body.append(container)
})

afterEach(async () => {
  vi.mocked(track).mockClear()
  ph.__loaded = true
  ph.has_opted_out_capturing = () => false
  ph.get_distinct_id = () => "distinct-1"
  vi.unstubAllGlobals()
  for (const root of roots) await act(async () => root.unmount())
  roots.length = 0
  document.body.innerHTML = ""
})

async function render() {
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(<FounderUpdatesForm />))
}

async function fillAndSubmit(email: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="email"]')
  if (!input) throw new Error("no email input")
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(input, email)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  const button = container.querySelector<HTMLButtonElement>('button[type="submit"]')
  await act(async () => button?.click())
}

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("founder updates form", () => {
  it("posts the submission with the current disclosure version and reports submit then success", async () => {
    const fetchMock = stubFetch(200, { ok: true })
    await render()
    await fillAndSubmit("reader@example.com")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    expect(call[0]).toBe("/api/growth/forms/founder-updates")
    const body = JSON.parse(call[1].body)
    expect(body.email).toBe("reader@example.com")
    expect(body.disclosure_version).toBe(DISCLOSURE_VERSION)
    expect(typeof body.submission_id).toBe("string")
    expect(body.posthog_distinct_id).toBe("distinct-1")
    expect(body.b4_hp).toBe("")
    expect("website_url" in body).toBe(false)

    expect(vi.mocked(track).mock.calls).toEqual([
      ["site:form_submit", { form: "founder_updates" }],
      ["site:form_success", { form: "founder_updates" }],
    ])
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toContain("reader@example.com")
    expect(container.textContent).toContain("Thanks. Watch for a note from Brian.")
    expect(container.querySelector("form")).toBeNull()
  })

  it("reports site:form_fail with the server's error code", async () => {
    stubFetch(429, { error: "rate_limited" })
    await render()
    await fillAndSubmit("reader@example.com")

    expect(vi.mocked(track).mock.calls).toContainEqual([
      "site:form_fail",
      { form: "founder_updates", failure_reason: "rate_limited" },
    ])
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toContain("reader@example.com")
    expect(container.querySelector("form")).not.toBeNull()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })

  describe("omits posthog_distinct_id", () => {
    async function postedBody() {
      const fetchMock = stubFetch(200, { ok: true })
      await render()
      await fillAndSubmit("reader@example.com")
      const call = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
      return JSON.parse(call[1].body) as Record<string, unknown>
    }

    it("when the visitor has opted out", async () => {
      ph.has_opted_out_capturing = () => true
      expect(await postedBody()).not.toHaveProperty("posthog_distinct_id")
    })

    it("when posthog-js is not loaded", async () => {
      ph.__loaded = false
      expect(await postedBody()).not.toHaveProperty("posthog_distinct_id")
    })

    it("when reading the id throws", async () => {
      ph.get_distinct_id = () => {
        throw new Error("boom")
      }
      expect(await postedBody()).not.toHaveProperty("posthog_distinct_id")
    })
  })

  it("reports a network failure when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline")
      }),
    )
    await render()
    await fillAndSubmit("reader@example.com")
    expect(vi.mocked(track).mock.calls).toContainEqual([
      "site:form_fail",
      { form: "founder_updates", failure_reason: "network" },
    ])
  })

  it("renders the disclosure text verbatim and links /privacy", async () => {
    await render()
    expect(container.textContent).toContain(FOUNDER_UPDATES_DISCLOSURE)
    expect(container.querySelector('a[href="/privacy"]')).not.toBeNull()
  })

  it("has a hidden honeypot that keyboards and autofill skip", async () => {
    await render()
    expect(container.querySelector('input[name="website_url"]')).toBeNull()
    const trap = container.querySelector<HTMLInputElement>('input[name="b4_hp"]')
    expect(trap).not.toBeNull()
    expect(trap?.tabIndex).toBe(-1)
    expect(trap?.getAttribute("autocomplete")).toBe("off")
    expect(trap?.getAttribute("aria-hidden")).toBe("true")
    expect(trap?.getAttribute("type")).toBe("text")
    expect(trap?.style.position).toBe("absolute")
    expect(trap?.style.opacity).toBe("0")
    expect(container.querySelector("textarea")?.getAttribute("maxlength")).toBe("1000")
  })
})

describe("updates page", () => {
  async function loadPage(enabled: boolean) {
    vi.resetModules()
    vi.doMock("../lib/growth/updates-enabled", () => ({ UPDATES_FORM_ENABLED: enabled }))
    return (await import("./page")).default
  }
  afterEach(() => vi.doUnmock("../lib/growth/updates-enabled"))

  it("renders the form when the backend is configured", async () => {
    const Page = await loadPage(true)
    const html = renderToStaticMarkup(<Page />)
    expect(html).toContain("<form")
    expect(html).not.toContain("Updates are not open yet.")
  })

  it("renders a notice and no form when it is not", async () => {
    const Page = await loadPage(false)
    const html = renderToStaticMarkup(<Page />)
    expect(html).not.toContain("<form")
    expect(html).toContain("Updates are not open yet. Check back soon.")
  })
})
