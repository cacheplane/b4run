import { readFileSync } from "node:fs"
import { join } from "node:path"
import { notFound } from "next/navigation"
import { ImageResponse } from "next/og"
import { webContentRoot } from "../../../lib/content-root"
import { getAuthoredPosts, selectVisiblePosts } from "../../components/blog/post-index"

// Assets sit beside the content root in both the site build and test workspace.
const assetRoot = join(webContentRoot(), "..", "public", "brand", "identity")
const font = readFileSync(join(assetRoot, "fonts", "Inter-600.ttf"))
const wordmark = `data:image/svg+xml;base64,${readFileSync(join(assetRoot, "logos", "wordmark-ink.svg")).toString("base64")}`

export const contentType = "image/png"
export const size = { width: 1200, height: 630 }
export const alt = "B4.run blog post title, type, and publication date"

function visiblePosts(currentDate: string, posts = getAuthoredPosts()) {
  return selectVisiblePosts(posts, currentDate)
}

export function generateImageParamsForDate(currentDate: string, posts = getAuthoredPosts()) {
  return visiblePosts(currentDate, posts).map((post) => ({ slug: post.slug }))
}

export function generateImageParams() {
  return generateImageParamsForDate(new Date().toISOString().slice(0, 10))
}

// Next's metadata-route loader recognizes this export and prerenders the known slugs.
export function generateStaticParams() {
  return generateImageParams()
}

interface BlogImageContent {
  readonly title: string
  readonly date: string
  readonly type: "post" | "release"
  readonly version?: string
}

export function titleFontSize(title: string): number {
  if (title.length <= 48) return 84
  if (title.length <= 72) return 74
  if (title.length <= 110) return 64
  return 54
}

export function renderBlogImage(post: BlogImageContent) {
  const type = post.type === "release" ? `Release · v${post.version}` : "Essay"
  const eyebrow = `${type} · ${post.date}`
  const fontSize = titleFontSize(post.title)

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "60px 72px",
        background: "#f5f4f0",
        color: "#111111",
        fontFamily: "Inter",
      }}
    >
      <div
        style={{
          fontSize: 22,
          letterSpacing: 4,
          textTransform: "uppercase",
          color: "#55594f",
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          display: "flex",
          fontSize,
          fontWeight: 600,
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
          maxHeight: "350px",
          maxWidth: "1040px",
          overflow: "hidden",
          wordBreak: "break-word",
          fontFamily: "Inter",
        }}
      >
        {post.title}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderTop: "1px solid #d6d6cc",
          paddingTop: 24,
        }}
      >
        {/* biome-ignore lint/performance/noImgElement: ImageResponse renders the supplied vector wordmark. */}
        <img src={wordmark} width={172} height={38} alt="b4.run" />
        <span style={{ fontSize: 22, color: "#55594f" }}>Notes on building agents.</span>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: "#b4ce37",
            display: "flex",
          }}
        />
      </div>
    </div>,
    { ...size, fonts: [{ name: "Inter", data: font, weight: 600, style: "normal" }] },
  )
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = visiblePosts(new Date().toISOString().slice(0, 10)).find(
    (candidate) => candidate.slug === slug,
  )
  if (!post) notFound()

  return renderBlogImage(post)
}
