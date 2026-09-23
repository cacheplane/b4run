import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ImageResponse } from "next/og"
import { webContentRoot } from "../../../lib/content-root"
import { COLOR } from "../../../lib/design-tokens"
import { DOCS_SEO_PAGES } from "../../seo/registry"
import { SOCIAL_IMAGE_SIZE } from "../../seo/social"
import type { TechArticleSeoPage } from "../../seo/types"

// Same assets as the blog card, read at module load so the build prerenders
// every page without a network fetch.
const assetRoot = join(webContentRoot(), "..", "public", "brand", "identity")
const titleFont = readFileSync(join(assetRoot, "fonts", "Inter-600.ttf"))
const bodyFont = readFileSync(join(assetRoot, "fonts", "Inter-400.ttf"))
const wordmark = `data:image/svg+xml;base64,${readFileSync(join(assetRoot, "logos", "wordmark-ink.svg")).toString("base64")}`

type DocsImagePage = Pick<TechArticleSeoPage, "path" | "title" | "description" | "breadcrumbs">

/** `/docs/memory/long-term` → `["memory", "long-term"]`, the route's catch-all param. */
export function docsImageSlug(path: string): readonly string[] {
  return path.replace(/^\/docs\//, "").split("/")
}

export function docsImageParams(): { slug: string[] }[] {
  return Object.keys(DOCS_SEO_PAGES).map((path) => ({ slug: [...docsImageSlug(path)] }))
}

export function docsImagePageFor(slug: readonly string[]): DocsImagePage | undefined {
  const path = `/docs/${slug.join("/")}`
  return Object.hasOwn(DOCS_SEO_PAGES, path)
    ? DOCS_SEO_PAGES[path as keyof typeof DOCS_SEO_PAGES]
    : undefined
}

/** The crumb above the page: its nav section, or "API Reference" for a package page. */
export function docsImageEyebrow(page: Pick<DocsImagePage, "breadcrumbs">): string {
  const parent = page.breadcrumbs.at(-2)?.label
  return parent === undefined || parent === "Docs" || parent === "Home"
    ? "Docs"
    : `Docs · ${parent}`
}

export function docsTitleFontSize(title: string): number {
  if (title.length <= 20) return 84
  if (title.length <= 32) return 76
  return 64
}

export function renderDocsImage(page: DocsImagePage) {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "60px 72px",
        background: COLOR.page,
        color: COLOR.ink,
        fontFamily: "Inter",
      }}
    >
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: 4,
          textTransform: "uppercase",
          color: COLOR["ink-muted"],
        }}
      >
        {docsImageEyebrow(page)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", maxWidth: "1040px" }}>
        <div
          style={{
            display: "flex",
            fontSize: docsTitleFontSize(page.title),
            fontWeight: 600,
            lineHeight: 1.1,
            letterSpacing: "-0.02em",
            // No overflow clip: it cuts descenders. Titles are short enough
            // that two lines at the smallest size is the ceiling.
            wordBreak: "break-word",
          }}
        >
          {page.title}
        </div>
        <div
          style={{
            display: "block",
            marginTop: 28,
            fontSize: 28,
            fontWeight: 400,
            lineHeight: 1.35,
            color: COLOR["ink-muted"],
            lineClamp: 3,
            maxWidth: "980px",
          }}
        >
          {page.description}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderTop: `1px solid ${COLOR.rule}`,
          paddingTop: 24,
        }}
      >
        {/* biome-ignore lint/performance/noImgElement: ImageResponse renders the supplied vector wordmark. */}
        <img src={wordmark} width={172} height={38} alt="b4.run" />
        <span style={{ fontSize: 22, fontWeight: 600, color: COLOR["ink-muted"] }}>
          Documentation
        </span>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: COLOR.relay,
            display: "flex",
          }}
        />
      </div>
    </div>,
    {
      ...SOCIAL_IMAGE_SIZE,
      fonts: [
        { name: "Inter", data: titleFont, weight: 600, style: "normal" },
        { name: "Inter", data: bodyFont, weight: 400, style: "normal" },
      ],
    },
  )
}
