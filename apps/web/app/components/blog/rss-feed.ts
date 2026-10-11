import type { Post } from "./post-index"

interface BuildOpts {
  readonly siteUrl: string
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function rfc822(dateIso: string): string {
  return new Date(`${dateIso}T00:00:00Z`).toUTCString()
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  avif: "image/avif",
}

/** The post's picture as Media RSS, so readers and syncs can skip the title-card og:image. */
function mediaContent(image: string | undefined, siteUrl: string): string {
  if (!image) return ""
  const url = new URL(image, siteUrl)
  const ext = url.pathname.split(".").pop()?.toLowerCase() ?? ""
  const type = IMAGE_TYPES[ext]
  return `
      <media:content url="${escapeXml(url.href)}" medium="image"${type ? ` type="${type}"` : ""}/>`
}

export function buildRssFeed(posts: readonly Post[], opts: BuildOpts): string {
  const { siteUrl } = opts
  const items = posts
    .map((p) => {
      const url = `${siteUrl}/blog/${p.slug}`
      return `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${url}</link>
      <guid>${url}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <description>${escapeXml(p.description)}</description>${mediaContent(p.image, siteUrl)}
    </item>`
    })
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>B4.run</title>
    <link>${siteUrl}/blog</link>
    <atom:link href="${siteUrl}/blog/rss.xml" rel="self" type="application/rss+xml"/>
    <description>Writing on the agent stack, type-safety, and the tools we're building.</description>
    <language>en</language>
${items}
  </channel>
</rss>
`
}
