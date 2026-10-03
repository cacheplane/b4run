import createMDX from "@next/mdx"
import type { NextConfig } from "next"
import { MDX_REHYPE_PLUGINS, MDX_REMARK_PLUGINS } from "./lib/mdx-plugins"

// Unhashed public files (favicons, brand kit) keep their URLs across deploys,
// so browsers may reuse them for a day and revalidate in the background for a
// week. HTML and route output keep the platform default (revalidate).
const PUBLIC_ASSET_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800"

// A Content-Security-Policy limited to directives that cannot break Next's
// inline hydration scripts, JSON-LD, or third-party media. A script-src policy
// needs per-request nonces (which forces dynamic rendering) or 'unsafe-inline'.
// No upgrade-insecure-requests: production is HTTPS-only under HSTS already,
// and it would rewrite same-origin assets when the site runs over plain HTTP.
const CONTENT_SECURITY_POLICY = [
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ")

export const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Vercel's default is max-age=63072000 without includeSubDomains. No preload.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
] as const

export const PUBLIC_ASSET_SOURCES = [
  "/brand/:path*",
  "/favicon.ico",
  "/favicon-:size(\\d+x\\d+).png",
  "/apple-touch-icon.png",
] as const

const nextConfig: NextConfig = {
  experimental: { useTypeScriptCli: true },
  reactStrictMode: true,
  // OG image modules read these at load; trace them in case a route renders on demand.
  outputFileTracingIncludes: {
    "/blog/*": [
      "./public/brand/identity/fonts/Inter-600.ttf",
      "./public/brand/identity/logos/wordmark-ink.svg",
    ],
    "/opengraph-image": ["./public/brand/identity/fonts/Inter-600.ttf"],
    "/og/docs/*": [
      "./public/brand/identity/fonts/Inter-600.ttf",
      "./public/brand/identity/fonts/Inter-400.ttf",
      "./public/brand/identity/logos/wordmark-ink.svg",
    ],
  },
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  typescript: { tsconfigPath: "./tsconfig.build.json" },
  async headers() {
    return [
      { source: "/:path*", headers: [...SECURITY_HEADERS] },
      ...PUBLIC_ASSET_SOURCES.map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: PUBLIC_ASSET_CACHE_CONTROL }],
      })),
    ]
  },
  async redirects() {
    return [
      // Next removes trailing slashes. An explicit file URL keeps the portable
      // identity page's relative assets working on the site and in the ZIP.
      {
        source: "/brand/identity",
        destination: "/brand/identity/index.html",
        permanent: true,
      },
      // The docs have no index page; send /docs to the first guide with a
      // cacheable 308 instead of rendering a page that redirects.
      {
        source: "/docs",
        destination: "/docs/getting-started",
        permanent: true,
      },
    ]
  },
}

const withMDX = createMDX({
  options: {
    // Turbopack requires serializable plugin references — see lib/mdx-plugins.ts
    remarkPlugins: MDX_REMARK_PLUGINS,
    rehypePlugins: MDX_REHYPE_PLUGINS,
  },
})

export default withMDX(nextConfig)
