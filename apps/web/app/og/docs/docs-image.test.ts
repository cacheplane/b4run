import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ALL_DOCS_PAGES } from "../../components/docs/nav"
import { DOCS_SEO_PAGES } from "../../seo/registry"
import { toMetadata } from "../../seo/resolve"

type RouteModule = typeof import("./[...slug]/route")
type ImageModule = typeof import("./docs-image")

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const nativeFetch = globalThis.fetch
const remoteUrls: string[] = []
let route: RouteModule
let image: ImageModule

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

async function expectPng(response: Response, label: string) {
  const bytes = new Uint8Array(await response.arrayBuffer())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(response.status, label).toBe(200)
  expect(response.headers.get("content-type"), label).toMatch(/^image\/png(?:;|$)/)
  expect([...bytes.slice(0, PNG_SIGNATURE.length)], label).toEqual(PNG_SIGNATURE)
  expect(view.getUint32(16), label).toBe(1200)
  expect(view.getUint32(20), label).toBe(630)
}

function get(slug: string[]) {
  return route.GET(new Request(`https://b4.run/og/docs/${slug.join("/")}`), {
    params: Promise.resolve({ slug }),
  })
}

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input)
      if (/^https?:\/\//.test(url)) {
        remoteUrls.push(url)
        return Promise.reject(new Error("OG images must render offline"))
      }
      return nativeFetch(input, init)
    }),
  )
  route = await import("./[...slug]/route")
  image = await import("./docs-image")
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe("docs Open Graph images", () => {
  it("prerenders exactly one image per registered docs page and nothing on demand", () => {
    expect(route.dynamic).toBe("force-static")
    expect(route.dynamicParams).toBe(false)

    const paths = route.generateStaticParams().map(({ slug }) => `/docs/${slug.join("/")}`)
    expect([...paths].sort()).toEqual(ALL_DOCS_PAGES.map(({ href }) => href).sort())
  })

  it("serves each param at the URL the page's metadata advertises", () => {
    for (const { slug } of route.generateStaticParams()) {
      const page = image.docsImagePageFor(slug)
      expect(page, slug.join("/")).toBeDefined()
      if (!page) continue
      const [ogImage] = (toMetadata(DOCS_SEO_PAGES[page.path as keyof typeof DOCS_SEO_PAGES])
        .openGraph?.images ?? []) as { url: string }[]
      expect(ogImage?.url).toBe(`/og/docs/${slug.join("/")}`)
    }
  })

  it("renders every docs image as a 1200 by 630 PNG without remote fetch", async () => {
    for (const { slug } of route.generateStaticParams()) {
      await expectPng(await get(slug), slug.join("/"))
    }
    expect(remoteUrls).toEqual([])
  }, 120_000)

  it.each([
    ["unknown", ["not-a-b4-page"]],
    ["partial", ["memory", "long-term", "extra"]],
    ["prototype key", ["constructor"]],
  ])("returns 404 for an %s slug", async (_kind, slug) => {
    expect((await get(slug)).status).toBe(404)
  })

  it("labels the page with its nav section, or API Reference for a package page", () => {
    const eyebrow = (path: keyof typeof DOCS_SEO_PAGES) =>
      image.docsImageEyebrow(DOCS_SEO_PAGES[path])

    expect(eyebrow("/docs/getting-started")).toBe("Docs · Get Started")
    expect(eyebrow("/docs/memory/long-term")).toBe("Docs · Memory")
    expect(eyebrow("/docs/api")).toBe("Docs · Reference")
    expect(eyebrow("/docs/api/postgres-storage")).toBe("Docs · API Reference")
  })

  it("steps the title size down for long titles and still renders one", async () => {
    const longest = Object.values(DOCS_SEO_PAGES).reduce((a, b) =>
      b.title.length > a.title.length ? b : a,
    )
    expect(image.docsTitleFontSize("Agents")).toBe(84)
    expect(image.docsTitleFontSize(longest.title)).toBeLessThan(84)

    const title = "Persist Tenant-Scoped Threads Across Durable Postgres Deployments Everywhere"
    expect(image.docsTitleFontSize(title)).toBe(64)
    await expectPng(image.renderDocsImage({ ...longest, title }), "synthetic long title")
  })
})
