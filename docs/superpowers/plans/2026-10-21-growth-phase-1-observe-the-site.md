# Growth Phase 1: Observe the Site — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `/privacy`, start capturing website signals in the `b4run` PostHog project through a typed event module, and put the first dashboard under version control with a sync and quality tool.

**Architecture:** `apps/web` gains a `posthog-js` client initialised from `instrumentation-client.ts` behind a host gate, one client island that listens for delegated clicks and visible time, and a typed `app/lib/analytics` module every emitter goes through. `scripts/posthog/` is a root TypeScript tool (run with `tsx`, tested with vitest) that validates JSON insight and dashboard definitions, plans and applies them against the PostHog API, and samples live events against the event contract. The event contract in `scripts/posthog/contract.ts` is the single taxonomy; a test pins the web module to it.

**Tech Stack:** Next.js 16.3 (`instrumentation-client.ts`, `rewrites`), React 19, `posthog-js` (latest 1.x, pinned exact), vitest 4 (jsdom for islands), zod 4.4.3 (root devDependency), `tsx` (root devDependency), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-20-growth-lifecycle-design.md` — sections "Surfaces that emit signals", "Event taxonomy", "Analytics tooling", "Privacy page", phase 1 of "Phases". Phases 2–4 get their own plans.

**One deviation from the spec, decided here:** the read-only `plan` check runs in the daily scheduled workflow (Task 9) rather than on every pull request, so no PostHog secret is exposed to PR runs. The unit tests that validate every JSON definition and pin the web module to the contract run on every PR through `pnpm test`.

## Global Constraints

- The word *tracking* appears nowhere in code, copy, docs, event names, or file names. The only exception is the posthog-js option `respect_dnt`, which is the library's name. Use *signals*, *observability*, *analytics*.
- No personal data reaches PostHog: no email, no email domain, no name, no copied text, no search query text, no free text of any kind. Properties are a fixed allowlist per event.
- PostHog project: the `b4run` project on US cloud, `https://us.i.posthog.com`, proxied through a same-origin `/ingest` rewrite. The client key is `NEXT_PUBLIC_POSTHOG_KEY`; the tooling keys are `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PERSONAL_API_KEY_READONLY`, `POSTHOG_PROJECT_ID`, `POSTHOG_HOST` (default `https://us.i.posthog.com`).
- Capture runs only on `b4.run` / `www.b4.run`, or anywhere when `NEXT_PUBLIC_POSTHOG_CAPTURE_ANYWHERE=true`. Preview deployments and localhost emit nothing by default.
- `/privacy` must exist in the same PR as the first emitter and be linked from the footer.
- Every new public route needs a `STATIC_SEO_PAGES` entry, a `lastmod` source mapping, and a regenerated `apps/web/app/seo/lastmod.generated.json` (run `pnpm --dir apps/web seo:lastmod` after committing the content).
- Event names: prefixes `site:`, `docs:`, `blog:`; lowercase snake_case; static names, vary by property. `$pageview` as-is.
- String properties are capped at 128 characters. Forbidden property names: `email`, `path`, `prompt`, `messages`, `error`, `threadId`, `runId`, `query`, `text`, `command`.
- `exactOptionalPropertyTypes` is on: spread optionals conditionally.
- Run all commands from the repo root. Lint with `pnpm lint`; never bare `biome check --write`.
- Scripts under `scripts/` are not release-pinned; nothing here touches `scripts/release`.
- `apps/web` is private; `scripts/` is not a package. No changeset is needed for phase 1.

## Review Focus

1. A visitor with Do Not Track enabled expects nothing to be captured. Pinned in Task 3 by asserting `respect_dnt: true` in the init options.
2. A preview deployment on `*.vercel.app` must not pollute production data. Pinned in Task 3 by `shouldCaptureSignals` tests.
3. A copy button must never send the copied text or the command string. Pinned in Task 6 by asserting the captured properties object has only `surface` / `source_page` / `code_lang`.
4. A `mailto:` or same-origin link must not count as an external link click; an external link inside a `[data-cta-id]` element must count once as a CTA click and not also as an external click. Pinned in Task 5.
5. Time in a hidden tab must not count toward `site:engaged_time`. Pinned in Task 5 by the tracker tests ported with the module.

---

### Task 1: The `/privacy` page and its SEO registration

**Files:**
- Create: `apps/web/content/privacy.mdx`
- Create: `apps/web/app/privacy/page.tsx`
- Modify: `apps/web/app/seo/types.ts` (add `"legal"` to `WebPageSeoPage.routeKind`)
- Modify: `apps/web/app/seo/registry.ts` (add `PRIVACY_SEO_PAGE`, include in `STATIC_SEO_PAGES`)
- Modify: `apps/web/app/seo/resolve.ts:96-116` (`buildSeoPageInventory` lists `/privacy` after `/blog`)
- Modify: `apps/web/app/sitemap.ts` (`sitemapPolicy` case `"legal"` → `{ changeFrequency: "yearly", priority: 0.2 }`)
- Modify: `apps/web/scripts/generate-seo-lastmod.mjs` (route source map gains `/privacy` → `[app/privacy/page.tsx, content/privacy.mdx]`)
- Modify: `apps/web/app/components/Footer.tsx` (Legal column gains `{ label: "Privacy", href: "/privacy" }` first)
- Modify: `apps/web/app/seo/seo.test.ts:335-380` (inventory now 95 routes; `/privacy` after `/blog`; route kinds gain one `"legal"`)
- Modify: `apps/web/app/sitemap.test.ts:183-184` (`2 + ...` becomes `3 + ...`; 94 becomes 95)
- Test: `apps/web/app/privacy/privacy.test.tsx`, `apps/web/app/components/footer.test.tsx`

**Interfaces:**
- Produces: `PRIVACY_SEO_PAGE: StaticWebSeoPage` with `path: "/privacy"`, `routeKind: "legal"`, `sourcePath: "apps/web/content/privacy.mdx"`.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/app/privacy/privacy.test.tsx
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import Page, { metadata } from "./page"

it("names the controller, the deletion address, and every subprocessor", () => {
  const html = renderToStaticMarkup(<Page />)
  expect(html).toContain("Cacheplane")
  expect(html).toContain("2843 NW Lolo Dr")
  expect(html).toContain("brian@b4.run")
  for (const sub of ["Vercel", "Neon", "PostHog", "Resend", "Google Calendar"]) expect(html).toContain(sub)
  expect(html).toContain("B4_TELEMETRY_DISABLED")
  expect(html).not.toMatch(/tracking/i)
  expect(metadata.alternates?.canonical).toBe("https://b4.run/privacy")
})
```

Add to `footer.test.tsx`: `anchor(html, "/privacy")` renders without `target=`.

In `seo.test.ts`, update the two inventory tests: paths `["/", "/blog", "/privacy", ...docs, ...posts, ...tags]`, length 95, route kinds `["home", "blog-index", "legal", ...]`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/web test -- privacy footer seo.test`
Expected: FAIL — `./page` not found; `/privacy` anchor missing; inventory length 94.

- [ ] **Step 3: Write `content/privacy.mdx` and `app/privacy/page.tsx`**

The MDX describes categories, not an event catalogue, in this order: what the website records (pageviews, clicks on calls to action, copy buttons, search opens, visible time; anonymous identifier; no account), what the `b4` CLI will report once that ships (command name, version, OS, outcome; opt-out `B4_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`; nothing from `create-b4-app` or a running app), what happens when you give us your email (occasional updates and a personal note from Brian; one-click unsubscribe; nothing sent to PostHog), subprocessors (Vercel, Neon, PostHog US, Resend, Google Calendar), retention (contacts until unsubscribe or deletion request; signals per PostHog project retention), controller `Cacheplane, 2843 NW Lolo Dr, Bend, OR`, deletion requests to `brian@b4.run`, and a "Last updated" line.

`page.tsx`: `export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/privacy"))` (the overload returns `SeoPage | undefined` for a non-docs path; `toMetadata` accepts undefined). It renders `<main id="content">` containing the imported MDX component inside the same centered column the blog post page uses (`ReadingLayout` is for pages with sidebar and TOC asides, so do not use it here). MDX element mapping comes from `apps/web/mdx-components.tsx` automatically.

- [ ] **Step 4: Register the route**

`types.ts`: `routeKind: "home" | "legal"`. `registry.ts`: `PRIVACY_SEO_PAGE` with title `Privacy`, description `How B4.run's website and CLI record anonymous signals, what happens to an email you give us, and how to opt out or ask for deletion.`, `kind: "WebPage"`, `breadcrumbs: [{ label: "Home", href: "/" }, { label: "Privacy" }]`. `resolve.ts`, `sitemap.ts`, `generate-seo-lastmod.mjs` as listed in Files. Footer link.

- [ ] **Step 5: Commit the content, then regenerate the manifest**

```bash
git add apps/web && git commit -m "feat(web): privacy page"
pnpm --dir apps/web seo:lastmod
pnpm --dir apps/web seo:lastmod:routes
```
Expected: the second command exits 0; only `/privacy` changed in `lastmod.generated.json`.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --dir apps/web test && pnpm --dir apps/web typecheck && pnpm --dir apps/web lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): record /privacy in the SEO lastmod manifest"
```

---

### Task 2: PostHog reverse proxy and robots

**Files:**
- Modify: `apps/web/next.config.ts` (add `rewrites()` and `skipTrailingSlashRedirect: true`)
- Modify: `apps/web/app/robots.ts` (`disallow: ["/api/", "/ingest/"]` for every rule)
- Test: `apps/web/app/production-build-config.test.ts`, `apps/web/app/robots.test.ts`

- [ ] **Step 1: Write the failing tests**

In `production-build-config.test.ts`:
```ts
it("proxies PostHog through /ingest so the browser talks only to b4.run", async () => {
  const rewrites = await nextConfig.rewrites?.()
  expect(rewrites).toEqual([
    { source: "/ingest/static/:path*", destination: "https://us-assets.i.posthog.com/static/:path*" },
    { source: "/ingest/:path*", destination: "https://us.i.posthog.com/:path*" },
  ])
  expect(nextConfig.skipTrailingSlashRedirect).toBe(true)
})
```
In `robots.test.ts`: every rule's `disallow` equals `["/api/", "/ingest/"]`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/web test -- production-build-config robots`
Expected: FAIL — `rewrites` undefined.

- [ ] **Step 3: Implement**

`rewrites()` returns exactly the two entries above, in that order (the static one must come first). `skipTrailingSlashRedirect: true` at the top level of `nextConfig`. The `withMDX` wrapper must still receive the config.

- [ ] **Step 4: Run tests to verify they pass, then commit**

Run: `pnpm --dir apps/web test -- production-build-config robots`
Expected: PASS.

```bash
git add apps/web/next.config.ts apps/web/app/robots.ts apps/web/app/*.test.ts
git commit -m "feat(web): proxy PostHog ingest through /ingest"
```

---

### Task 3: Client initialisation behind a host gate

**Files:**
- Modify: `apps/web/package.json` (add `posthog-js` exact version; run `pnpm install`)
- Create: `apps/web/app/lib/analytics/capture-gate.ts`
- Create: `apps/web/instrumentation-client.ts`
- Test: `apps/web/app/lib/analytics/capture-gate.test.ts`, `apps/web/app/lib/analytics/instrumentation-client.test.ts`

**Interfaces:**
- Produces: `shouldCaptureSignals(input: { key: string | undefined; host: string | undefined; captureAnywhere: boolean }): boolean`; `POSTHOG_INIT_OPTIONS` (exported from `instrumentation-client.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// capture-gate.test.ts
it.each([
  [{ key: "phc_x", host: "b4.run", captureAnywhere: false }, true],
  [{ key: "phc_x", host: "www.b4.run", captureAnywhere: false }, true],
  [{ key: "phc_x", host: "b4-run-git-x.vercel.app", captureAnywhere: false }, false],
  [{ key: "phc_x", host: "localhost:3000", captureAnywhere: false }, false],
  [{ key: "phc_x", host: "localhost:3000", captureAnywhere: true }, true],
  [{ key: undefined, host: "b4.run", captureAnywhere: true }, false],
  [{ key: "   ", host: "b4.run", captureAnywhere: false }, false],
])("shouldCaptureSignals(%o) → %s", (input, expected) => {
  expect(shouldCaptureSignals(input)).toBe(expected)
})
```

```ts
// instrumentation-client.test.ts  (@vitest-environment jsdom)
// Mock "posthog-js" default export with { init: vi.fn() }. Set
// process.env.NEXT_PUBLIC_POSTHOG_KEY and window.location host via
// vi.stubGlobal / history, then dynamic-import "../../../instrumentation-client".
it("pins every init option", async () => {
  const { POSTHOG_INIT_OPTIONS } = await import("../../../instrumentation-client")
  expect(POSTHOG_INIT_OPTIONS).toEqual({
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2026-01-30",
    capture_pageview: "history_change",
    capture_pageleave: "if_capture_pageview",
    autocapture: true,
    capture_performance: { web_vitals: true },
    person_profiles: "identified_only",
    respect_dnt: true,
    disable_surveys: true,
    disable_session_recording: true,
  })
})
it("calls init on b4.run and not on a preview host", ...)  // two cases via vi.resetModules()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/web test -- capture-gate instrumentation-client`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`capture-gate.ts` is framework-free: trims the key, lowercases the host, compares to the two production hosts. `instrumentation-client.ts` reads `process.env.NEXT_PUBLIC_POSTHOG_KEY` and `process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_ANYWHERE === "true"`, exports `POSTHOG_INIT_OPTIONS` with the literal object above (`satisfies Partial<PostHogConfig>`), and calls `posthog.init(key, POSTHOG_INIT_OPTIONS)` only when the gate passes. `capture_pageview` must be the string `"history_change"`, not `true`.

- [ ] **Step 4: Run tests, typecheck, build**

Run: `pnpm --dir apps/web test -- capture-gate instrumentation-client && pnpm --dir apps/web typecheck && pnpm --filter @b4run/web build`
Expected: PASS; the build succeeds with the env var unset.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/instrumentation-client.ts apps/web/app/lib/analytics
git commit -m "feat(web): initialise PostHog behind a production-host gate"
```

---

### Task 4: Typed event module

**Files:**
- Create: `apps/web/app/lib/analytics/events.ts`
- Create: `apps/web/app/lib/analytics/client.ts`
- Test: `apps/web/app/lib/analytics/client.test.ts`

**Interfaces:**
- Produces (from `events.ts`):
  ```ts
  export const SIGNAL_EVENTS = {
    siteCtaClick: "site:cta_click",
    siteExternalLinkClick: "site:external_link_click",
    siteInstallCommandCopied: "site:install_command_copied",
    siteEngagedTime: "site:engaged_time",
    docsSearchOpen: "docs:search_open",
    docsSearchResultClick: "docs:search_result_click",
    docsCopyCodeClick: "docs:copy_code_click",
    blogCopyCodeClick: "blog:copy_code_click",
  } as const
  export type SignalEventName = (typeof SIGNAL_EVENTS)[keyof typeof SIGNAL_EVENTS]
  export type SignalSurface = "header" | "mobile_nav" | "footer" | "home" | "docs" | "blog"
  export type CtaId = "header_get_started" | "header_blog" | "header_live_demo" | "header_github"
    | "footer_github" | "footer_npm" | "footer_live_demo" | "footer_rss"
    | "home_scaffold" | "home_get_started" | "home_github" | "home_live_demo"
    | "blog_cta_get_started" | "docs_prompt_copy"
  export interface SignalProperties {
    readonly cta_id?: CtaId; readonly surface?: SignalSurface; readonly destination_url?: string
    readonly destination_host?: string; readonly engaged_seconds?: 10 | 30
    readonly code_lang?: string; readonly source_page?: string
  }
  ```
- Produces (from `client.ts`, `"use client"`):
  ```ts
  export function sourcePage(href: string): string          // pathname only, no search or hash, "/" fallback
  export function safeLabel(value: unknown): string | undefined  // trimmed, ≤128 chars, else undefined
  export function track(event: SignalEventName, properties?: SignalProperties): void
  export function copyCodeEventFor(pathname: string): SignalEventName | undefined // "/docs/*" → docs, "/blog/*" → blog, else undefined
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// client.test.ts (@vitest-environment jsdom); mock posthog-js { capture: vi.fn() }
it("adds source_page as a pathname and drops search and hash", () => {
  history.replaceState(null, "", "/docs/agents?x=1#top")
  track(SIGNAL_EVENTS.docsSearchOpen)
  expect(capture).toHaveBeenCalledWith("docs:search_open", { source_page: "/docs/agents" })
})
it("caps labels at 128 characters and rejects blanks", () => {
  expect(safeLabel("  ")).toBeUndefined()
  expect(safeLabel("a".repeat(200))).toHaveLength(128)
})
it("never throws when capture throws", ...)
it.each([["/docs/x", "docs:copy_code_click"], ["/blog/y", "blog:copy_code_click"], ["/", undefined]])(
  "copyCodeEventFor(%s)", ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/web test -- analytics/client`
Expected: FAIL.

- [ ] **Step 3: Implement** `events.ts` and `client.ts` as specified. `track` wraps `posthog.capture` in try/catch and returns on the server (`typeof window === "undefined"`).

- [ ] **Step 4: Run tests to verify they pass, then commit**

```bash
git add apps/web/app/lib/analytics
git commit -m "feat(web): typed signal events and capture client"
```

---

### Task 5: The signals island: delegated clicks and visible time

**Files:**
- Create: `apps/web/app/lib/analytics/engaged-time.ts` (port of Threadplane's `createEngagedTimeTracker`; same API; thresholds `[10_000, 30_000]`)
- Create: `apps/web/app/lib/analytics/click-signals.ts`
- Create: `apps/web/app/lib/analytics/SiteSignals.tsx`
- Modify: `apps/web/app/layout.tsx` (render `<SiteSignals />` inside `<body>` after the footer)
- Modify: `apps/web/app/components/HeaderInner.tsx`, `MobileMenu.tsx`, `Footer.tsx`, `app/components/blog/BlogCta.tsx`, homepage CTA components under `app/components/homepage` (add `data-cta-id` from the `CtaId` union; Footer `LinkItem` gains optional `ctaId`)
- Modify: `apps/web/app/site-chrome.test.tsx` (mock `SiteSignals` like `Header`)
- Test: `apps/web/app/lib/analytics/engaged-time.test.ts`, `click-signals.test.ts`, `site-signals.test.tsx`

**Interfaces:**
- Consumes: `track`, `sourcePage`, `safeLabel`, `SIGNAL_EVENTS` from Task 4.
- Produces:
  ```ts
  // click-signals.ts (framework-free)
  export type ClickSignal =
    | { event: "site:cta_click"; cta_id: string; surface: string; destination_url?: string }
    | { event: "site:external_link_click"; destination_host: string; surface: string }
  export function classifyClick(target: EventTarget | null, currentOrigin: string): ClickSignal | undefined
  ```
  Rules: walk up to the nearest `a[href]` or `[data-cta-id]`. A `[data-cta-id]` element wins and yields `site:cta_click` with `surface` from the nearest `[data-signal-surface]` ancestor, else derived from `location.pathname` (`/docs/*` → `"docs"`, `/blog/*` → `"blog"`, anything else → `"home"`). Otherwise an anchor whose URL origin differs from `currentOrigin` and whose protocol is `http:`/`https:` yields `site:external_link_click` with `destination_host = url.host`. `mailto:`, same-origin, and non-anchor targets yield `undefined`.

- [ ] **Step 1: Write the failing tests**

Port Threadplane's `engaged-time.spec.ts` cases: hidden time not counted; re-asserting visible does not reset; each threshold fires once; `isComplete` after both.

```ts
// click-signals.test.ts (@vitest-environment jsdom)
it("counts a data-cta-id element once as a cta click, even when it is an external anchor", ...)
it("counts an off-site https anchor as an external link click with its host only", ...)
it.each(["mailto:x@y.z", "/docs", "#top"])("ignores %s", ...)
```

```tsx
// site-signals.test.tsx (@vitest-environment jsdom); mock ./client { track: vi.fn() }
it("fires site:engaged_time at 10 and 30 visible seconds and never for hidden time", ...) // vi.useFakeTimers
it("fires docs:search_open when the window event is dispatched", ...)
it("tracks a delegated click", ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/web test -- engaged-time click-signals site-signals`
Expected: FAIL.

- [ ] **Step 3: Implement**

`SiteSignals` is a `"use client"` component rendering `null`. In one `useEffect`: a capturing `click` listener on `document` that calls `classifyClick` and `track`; a `visibilitychange` listener driving `setVisible`; a 1-second interval calling `tick` that clears itself when `isComplete()`; a listener for `OPEN_DOCS_SEARCH_EVENT` (import from `components/docs/docs-search-events`) that tracks `docsSearchOpen`. All removed on cleanup. Add `data-signal-surface="header" | "mobile_nav" | "footer" | "blog"` on the header nav, mobile drawer, footer, and `BlogCta` roots; add `data-cta-id` values from the `CtaId` union to the links listed in Files.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm --dir apps/web test && pnpm --dir apps/web typecheck && pnpm --dir apps/web lint`
Expected: PASS (including `site-chrome.test.tsx` and `footer.test.tsx`).

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): signals island for CTA, external link, search open and visible time"
```

---

### Task 6: Copy buttons and docs search results

**Files:**
- Modify: `apps/web/app/components/ui/CopyCommand.tsx` (optional prop `surface?: SignalSurface`; on copy, when `surface` is set, `track(siteInstallCommandCopied, { surface })`)
- Modify: `apps/web/app/components/blog/BlogCta.tsx` (`surface="blog"`), homepage `CopyCommand` usages (`surface="home"`)
- Modify: `apps/web/app/components/mdx/CodeBlock.tsx` (`CopyButton` gains optional `language?: string`; on copy, `const event = copyCodeEventFor(location.pathname); if (event) track(event, { ...(language ? { code_lang: language } : {}) })`; `Pre` and `RehypeFigureHeader` pass the language)
- Modify: `apps/web/app/components/docs/DocsSearch.tsx:178,369` (`navigate` tracks `docsSearchResultClick` before `router.push`)
- Test: `apps/web/app/components/copy-feedback.test.tsx` (extend), `apps/web/app/components/mdx/mdx.test.tsx` (extend), `apps/web/app/components/docs/docs-search-dialog.test.tsx` (extend)

**Interfaces:**
- Consumes: `track`, `copyCodeEventFor`, `SIGNAL_EVENTS`, `SignalSurface` from Task 4.

- [ ] **Step 1: Write the failing tests** (each file mocks `../lib/analytics/client` or the relative path)

```ts
it("reports an install command copy with the surface and never the command", async () => {
  // render <CopyCommand command="npm create b4-app@latest my-agent" surface="blog" />, click
  expect(track).toHaveBeenCalledWith("site:install_command_copied", { surface: "blog" })
  expect(JSON.stringify(track.mock.calls)).not.toContain("npm create")
})
it("a CopyCommand without a surface reports nothing", ...)
it("a code copy on /docs/* reports docs:copy_code_click with code_lang and not the code", ...)
it("choosing a search result reports docs:search_result_click without the query", ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/web test -- copy-feedback mdx docs-search-dialog`
Expected: FAIL.

- [ ] **Step 3: Implement** as listed in Files.

- [ ] **Step 4: Run the web suite, typecheck, lint; commit**

```bash
git add apps/web
git commit -m "feat(web): copy and search-result signals"
```

---

### Task 7: PostHog tooling core — env, client, schema, sync

**Files:**
- Create: `scripts/posthog/package.json` (`{ "name": "@b4run/posthog-tools", "private": true, "type": "module" }` — not a workspace member; it only marks the directory ESM)
- Create: `scripts/posthog/tsconfig.json` (extends `../../packages/config-typescript/node.json`, `noEmit`, includes `*.ts`)
- Create: `scripts/posthog/vitest.config.ts` (`test.name: "posthog-tools"`, `include: ["scripts/posthog/**/*.test.ts"]`)
- Modify: `vitest.workspace.ts` (add `./scripts/posthog/vitest.config.ts`)
- Modify: root `package.json` `typecheck` (append `&& tsc -p scripts/posthog/tsconfig.json --noEmit`)
- Create: `scripts/posthog/env.ts`, `client.ts`, `schema.ts`, `sync.ts`
- Test: `scripts/posthog/env.test.ts`, `schema.test.ts`, `sync.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // env.ts
  export interface PosthogEnv { readonly POSTHOG_PERSONAL_API_KEY: string; readonly POSTHOG_HOST: string; readonly POSTHOG_PROJECT_ID: number }
  export function parseEnv(source: Record<string, string | undefined>): PosthogEnv  // zod; key ≥ 20 chars; host url default https://us.i.posthog.com; id positive int
  // client.ts
  export interface PosthogClient {
    get<T>(path: string, query?: Record<string, string>): Promise<T>
    post<T>(path: string, body: unknown): Promise<T>
    patch<T>(path: string, body: unknown): Promise<T>
    delete(path: string): Promise<void>
  }
  export function createPosthogClient(env: PosthogEnv, fetchImpl?: typeof fetch): PosthogClient
  // paths are relative to `${host}/api/projects/${id}`; retries 429/502/503/504 up to 3 attempts with 500ms·2^n backoff capped at 8s
  // schema.ts
  export const DashboardLocal, InsightLocal   // zod, same shape as Threadplane's tools/posthog/schema.ts minus CohortLocal; InsightLocal.kind: "trends" | "funnel"
  // sync.ts
  export interface SyncClient { listDashboards(); listInsights(); createDashboard(body); createInsight(body); updateDashboard(id, body); updateInsight(id, body); deleteDashboard(id); deleteInsight(id) }
  export function toSyncClient(client: PosthogClient): SyncClient
  export function computePlan(input: { root: string; client: SyncClient }): Promise<SyncPlan>
  export function applyPlan(input: { root: string; client: SyncClient; plan: SyncPlan; deleteOrphans?: boolean }): Promise<ApplyResult>  // writes posthog_id back into the JSON atomically
  export function toPostHogInsight(local: InsightLocal): unknown   // InsightVizNode / TrendsQuery or FunnelsQuery, as in Threadplane's sync.ts
  export function formatPlan(plan: SyncPlan): string   // "[create] insight foo", "[update] ...", "[orphan] ..."
  ```

- [ ] **Step 1: Write the failing tests**

`env.test.ts`: defaults the host; rejects a short key and a non-numeric id.
`schema.test.ts`: a `trends` insight parses; a `funnel` without steps fails; a slug with uppercase fails; a dashboard tile references a string slug.
`sync.test.ts` with an in-memory `SyncClient`: a local insight with `posthog_id: null` and no remote name match plans `create`; with a matching `posthog_id` plans `update`; a remote with no local plans `orphan`; `applyPlan` creates insights before dashboards and resolves tile slugs to ids; `toPostHogInsight` of a trends insight with one event and a breakdown produces `{ query: { kind: "InsightVizNode", source: { kind: "TrendsQuery", series: [{ kind: "EventsNode", event, math }], breakdownFilter: { breakdown, breakdown_type: "event" }, interval, dateRange: { date_from } } } }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest --run --config scripts/posthog/vitest.config.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**, porting `computePlan`, `applyPlan`, `toPostHogInsight`, and `atomicWriteJson` from `~/repos/angular-agent-framework/tools/posthog/sync.ts` (drop cohorts; replace `openapi-fetch` with `client.ts`).

- [ ] **Step 4: Run tests, typecheck, lint; commit**

Run: `pnpm exec vitest --run --config scripts/posthog/vitest.config.ts && tsc -p scripts/posthog/tsconfig.json --noEmit && pnpm lint`

```bash
git add scripts/posthog vitest.workspace.ts package.json
git commit -m "feat(posthog): dashboards-as-code sync tool"
```

---

### Task 8: Event contract, live quality sampler, CLI, and the first dashboard

**Files:**
- Create: `scripts/posthog/contract.ts`
- Create: `scripts/posthog/quality.ts`
- Create: `scripts/posthog/cli.ts` (subcommands `plan`, `apply [--delete-orphans]`, `quality [--days N] [--limit-per-event N]`)
- Create: `scripts/posthog/insights/pageviews-by-path.json`, `cta-clicks-by-id.json`, `install-command-copied-by-surface.json`, `external-links-by-host.json`, `engaged-time.json`, `docs-search.json` (trends: `docs:search_open` and `docs:search_result_click`), `copy-code-by-surface.json` (trends: both copy events)
- Create: `scripts/posthog/dashboards/site-and-docs-engagement.json` (name `Growth · Site and docs engagement`, description `Event counts for the website and docs. A copied install command is intent, not an install; engaged time is visible seconds, not session length.`, tags `["growth"]`, all seven tiles)
- Modify: root `package.json` scripts: `"posthog:plan": "tsx scripts/posthog/cli.ts plan"`, `"posthog:apply": "tsx scripts/posthog/cli.ts apply"`, `"posthog:quality": "tsx scripts/posthog/cli.ts quality"`
- Test: `scripts/posthog/contract.test.ts`, `quality.test.ts`, `taxonomy.test.ts`, `cli.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // contract.ts
  export const FORBIDDEN_PROPERTIES = ["email", "path", "prompt", "messages", "error", "threadId", "runId", "query", "text", "command"] as const
  export interface EventContract { readonly requiredProperties: readonly string[]; readonly allowedProperties: readonly string[]; readonly allowedBreakdowns: readonly string[] }
  export const EVENT_CONTRACT: Readonly<Record<string, EventContract>>
  // keys: $pageview plus the eight SIGNAL_EVENTS values; required: cta_click → cta_id, surface; external_link_click → destination_host, surface;
  // install_command_copied → surface; engaged_time → engaged_seconds; search/copy events → source_page only
  export const MAX_LABEL_LENGTH = 128
  // quality.ts
  export interface LiveEvent { event: string; timestamp: string; properties: Record<string, unknown> }
  export interface QualityFinding { severity: "error" | "warning"; kind: "missing_required_property" | "forbidden_property" | "unexpected_property" | "label_too_long" | "insufficient_event_coverage"; event: string; property: string; timestamp: string; message: string }
  export function evaluateEvents(events: readonly LiveEvent[], coverage: readonly { event: string; minCount: number }[]): QualityFinding[]
  export function fetchRecentEvents(client: PosthogClient, input: { eventNames: readonly string[]; after: string; limitPerEvent: number }): Promise<LiveEvent[]>  // GET events?event=&after=&limit=
  export const DEFAULT_COVERAGE: readonly { event: string; minCount: number }[]  // $pageview ≥ 1 only in phase 1
  ```
  PostHog's own `$`-prefixed and campaign properties (the `INTERNAL_PROPERTY_NAMES` set in Threadplane's `live-quality.ts`) are ignored, not reported as unexpected.

- [ ] **Step 1: Write the failing tests**

`contract.test.ts`: every key in `EVENT_CONTRACT` except `$pageview` is a value of `SIGNAL_EVENTS` imported from `../../apps/web/app/lib/analytics/events.ts`, and vice versa (this is the code-taxonomy pin); no allowed property is forbidden.
`taxonomy.test.ts`: every `events[].event` and `steps[].event` across `insights/*.json` is a key of `EVENT_CONTRACT`; every breakdown is in that event's `allowedBreakdowns`; every dashboard tile slug has an insight file.
`quality.test.ts`: a `site:cta_click` without `cta_id` → `missing_required_property` error; a property named `email` → `forbidden_property` error; an unknown property → `unexpected_property` warning; a 129-char `cta_id` → `label_too_long` error; `$current_url` is ignored; zero `$pageview` events → `insufficient_event_coverage` error.
`cli.test.ts`: `plan` prints the formatted plan and exits 0 with an empty plan; `quality` exits 1 when any error finding exists.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest --run --config scripts/posthog/vitest.config.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `contract.ts`, `quality.ts` (port of `evaluate`/`fetch` from Threadplane's `live-quality.ts` with the extra `label_too_long` rule), `cli.ts` (parses `process.argv`, builds env and client lazily, never reads env at import), and the seven insight files plus the dashboard. Each insight `description` states its limit (for example, the install-command insight: `Copy clicks on the npm create command. A copy is intent, not an npm install.`).

- [ ] **Step 4: Run tests; typecheck; lint; then a read-only plan against the live project**

Run: `pnpm exec vitest --run --config scripts/posthog/vitest.config.ts && pnpm typecheck && pnpm lint`
Run: `set -a && source .env && set +a && POSTHOG_PERSONAL_API_KEY="$POSTHOG_PERSONAL_API_KEY_READONLY" pnpm posthog:plan`
Expected: seven `[create] insight` lines and one `[create] dashboard` line, no errors. Do not run `apply` in this task.

- [ ] **Step 5: Commit**

```bash
git add scripts/posthog package.json
git commit -m "feat(posthog): event contract, live quality check, and the site engagement dashboard"
```

---

### Task 9: Scheduled quality workflow and operator docs

**Files:**
- Create: `.github/workflows/posthog-quality.yml`
- Create: `docs/growth/README.md`
- Modify: `AGENTS.md` ("Where things live" gains `- Growth signals and PostHog dashboards: \`scripts/posthog/\`, operations in \`docs/growth/README.md\`.`)
- (There is no root `.env.example`; the variable names are documented in `docs/growth/README.md` only.)
- Test: `node scripts/check-docs.mjs` (bans phrases in `docs/`), `pnpm lint`

- [ ] **Step 1: Write the workflow**

Model on Threadplane's `.github/workflows/posthog-quality.yml`: `workflow_dispatch` with `days` (default `7`) and `limit_per_event` (default `100`), `schedule: cron "23 14 * * *"`, `permissions: contents: read`, `env: DO_NOT_TRACK: "1"`. Steps: checkout (pin to the same SHAs `ci.yml` uses), pnpm 10.33.0, Node 24.17.0, `pnpm install --frozen-lockfile`, then one step with `POSTHOG_PERSONAL_API_KEY: ${{ secrets.POSTHOG_PERSONAL_API_KEY_READONLY }}` and `POSTHOG_PROJECT_ID: ${{ secrets.POSTHOG_PROJECT_ID }}` that fails fast when either is empty, runs `pnpm posthog:plan` and then `pnpm posthog:quality --days "$DAYS" --limit-per-event "$LIMIT"`.

- [ ] **Step 2: Write `docs/growth/README.md`**

Sections: Ownership table (`apps/web/app/lib/analytics` emits; `scripts/posthog` defines dashboards and checks; PostHog measures engagement and nothing else), Operator commands (`pnpm posthog:plan`, `pnpm posthog:apply`, `pnpm posthog:quality -- --days 7`), Environment (the five variable names, which key each command needs, the `NEXT_PUBLIC_POSTHOG_CAPTURE_ANYWHERE` escape hatch), Measurement limits (copied command ≠ install; engaged time is visible seconds; counts not funnels), and a pointer to the spec. No banned phrases (`node scripts/check-docs.mjs` lists them).

- [ ] **Step 3: Verify**

Run: `node scripts/check-docs.mjs && pnpm lint && pnpm test -- scripts/posthog`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/posthog-quality.yml docs/growth/README.md AGENTS.md
git commit -m "docs(growth): PostHog quality workflow and operations guide"
```

---

### Task 10: Full validation and the owner handoff

**Files:** none new.

- [ ] **Step 1: Run the full local gate**

Run: `pnpm ci:validate`
Expected: every stage passes. If `seo:lastmod:routes` complains, the `/privacy` sources changed after the manifest was generated: re-run `pnpm --dir apps/web seo:lastmod` on top of the committed content and commit the manifest.

- [ ] **Step 2: Write the handoff note into the PR description**

List what the owner does before the switch is live, none of which the repo can do:
1. In PostHog, create the project API token for the `b4run` project and set `NEXT_PUBLIC_POSTHOG_KEY` in the Vercel project for Production (and Preview only if preview capture is wanted together with `NEXT_PUBLIC_POSTHOG_CAPTURE_ANYWHERE=true`).
2. Add GitHub Actions secrets `POSTHOG_PERSONAL_API_KEY_READONLY` and `POSTHOG_PROJECT_ID`.
3. Run `pnpm posthog:apply` once locally with the write key to create the dashboard; commit the `posthog_id` writebacks.
4. Confirm in the PostHog project settings that `autocapture_opt_out` is off (the client cannot override it) and that session recording is off.

- [ ] **Step 3: Open the PR** with the superpowers:finishing-a-development-branch skill.
