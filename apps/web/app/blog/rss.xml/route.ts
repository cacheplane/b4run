import { getAllPosts } from "../../components/blog/post-index"
import { buildRssFeed } from "../../components/blog/rss-feed"

// Rendered once at build time and served from the CDN; rebuilt every deploy.
export const dynamic = "force-static"

const SITE_URL = "https://b4.run"

export function GET() {
  const xml = buildRssFeed(getAllPosts(), { siteUrl: SITE_URL })
  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  })
}
