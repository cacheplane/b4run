import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import nextConfig from "../next.config"

interface TypeScriptConfig {
  readonly extends?: string
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
}

function readConfig(relativePath: string): TypeScriptConfig {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as TypeScriptConfig
}

describe("production web build boundary", () => {
  it("keeps test files in the normal web typecheck", () => {
    const config = readConfig("../tsconfig.json")

    expect(config.include).toContain("**/*.ts")
    expect(config.exclude).not.toContain("**/*.test.ts")
  })

  it("uses a production-only TypeScript config that excludes test modules", () => {
    const config = readConfig("../tsconfig.build.json")

    expect(config.extends).toBe("./tsconfig.json")
    expect(config.exclude).toEqual(
      expect.arrayContaining([
        "node_modules",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.spec.ts",
        "**/*.spec.tsx",
      ]),
    )
    expect(nextConfig.typescript?.tsconfigPath).toBe("./tsconfig.build.json")
  })
})

describe("production response policy", () => {
  it("proxies PostHog through /ingest so the browser talks only to b4.run", async () => {
    const rewrites = await nextConfig.rewrites?.()
    expect(rewrites).toEqual([
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      { source: "/ingest/:path*", destination: "https://us.i.posthog.com/:path*" },
    ])
    expect(nextConfig.skipTrailingSlashRedirect).toBe(true)
  })

  it("restores trailing-slash redirects for every path except /ingest", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? []

    expect(redirects[0]).toEqual({
      source: "/:path((?!ingest(?:/|$)).*)/",
      destination: "/:path",
      permanent: true,
    })
    expect(String(redirects[0]?.source)).toContain("ingest")
  })

  it("redirects the docs root permanently from config instead of a page", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? []

    expect(redirects).toContainEqual({
      source: "/docs",
      destination: "/docs/getting-started",
      permanent: true,
    })
    expect(existsSync(new URL("./docs/page.tsx", import.meta.url))).toBe(false)
  })

  it("redirects the retired research recipe slugs to the flight-planner recipes", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? []

    expect(redirects).toContainEqual({
      source: "/docs/recipes/research-assistant",
      destination: "/docs/recipes/flight-planner",
      permanent: true,
    })
    expect(redirects).toContainEqual({
      source: "/docs/recipes/research-web-ui",
      destination: "/docs/recipes/flight-planner-web-ui",
      permanent: true,
    })
    expect(existsSync(new URL("./docs/recipes/research-assistant/page.tsx", import.meta.url))).toBe(
      false,
    )
    expect(existsSync(new URL("./docs/recipes/research-web-ui/page.tsx", import.meta.url))).toBe(
      false,
    )
  })

  it("redirects /call to /updates when B4_CALL_URL is unset", async () => {
    const saved = process.env.B4_CALL_URL
    delete process.env.B4_CALL_URL
    vi.resetModules()
    try {
      const { default: fresh } = await import("../next.config")
      const redirects = (await fresh.redirects?.()) ?? []
      expect(redirects).toContainEqual({
        source: "/call",
        destination: "/updates",
        permanent: false,
      })
    } finally {
      if (saved !== undefined) process.env.B4_CALL_URL = saved
    }
  })

  it("sends security headers on every route without a script-blocking CSP", async () => {
    const rules = await nextConfig.headers?.()
    const all = rules?.find((rule) => rule.source === "/:path*")
    const headers = new Map(all?.headers.map(({ key, value }) => [key, value]))

    expect(headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin")
    expect(headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains")
    expect(headers.get("Strict-Transport-Security")).not.toContain("preload")
    expect(headers.get("Permissions-Policy")).toContain("camera=()")
    expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'")
    // Next hydrates with inline scripts; a script-src without nonces breaks the site.
    expect(headers.get("Content-Security-Policy")).not.toMatch(
      /script-src|default-src|upgrade-insecure-requests/,
    )
    expect(all?.headers.some(({ key }) => key === "Cache-Control")).toBe(false)
  })

  it("caches unhashed public assets for a day and leaves HTML revalidating", async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    const cached = rules.filter((rule) => rule.headers.some(({ key }) => key === "Cache-Control"))

    expect(cached.map((rule) => rule.source)).toEqual([
      "/brand/:path*",
      "/favicon.ico",
      "/favicon-:size(\\d+x\\d+).png",
      "/apple-touch-icon.png",
    ])
    for (const rule of cached) {
      expect(rule.headers).toEqual([
        { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
      ])
    }
  })
})

describe("Vercel cron schedule", () => {
  it("runs the growth tick every 30 minutes", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
      readonly crons?: readonly { path: string; schedule: string }[]
    }

    expect(config.crons).toEqual([{ path: "/api/growth/tick", schedule: "*/30 * * * *" }])
  })
})
