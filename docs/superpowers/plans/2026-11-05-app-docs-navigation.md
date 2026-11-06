# App Docs Navigation and Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, or superpowers:subagent-driven-development when delegation is selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the App/Framework entrance and ten app routes while preserving existing framework identities and export behavior.

**Architecture:** A section registry supplies navigation, search membership and content resolution. Existing explicit Next page wrappers remain; the catch-all stays a 404. Shared docs presentation adopts LLA typography using the existing Paper Relay color roles.

**Tech Stack:** Next.js App Router, MDX, React, TypeScript, Vitest, Tailwind/CSS modules.

---

## Implementation status — November 5, 2026

Implemented inline on `blove/app-docs-navigation` in `.worktrees/app-docs-navigation-20261105`. The two audiences, ten source-backed App drafts, scoped search, machine-readable exports, metadata, and docs typography are implemented. The owner authorized labeled release-download placeholders and planned Homebrew instructions while publication is pending. Browser review covers both audiences, the entrance, mobile controls, no-JavaScript navigation, and zoom. Validation details and remaining release gates are recorded in `docs/verification/2026-11-05-app-docs-navigation.md` and `docs/verification/app-docs-release-facts.md`. The Navlog capture and interactive inspector are subsequent phases.

## Prerequisites and file responsibilities

Read the approved design and delivery plan. Complete the content/media plan's release-fact task before publishing setup instructions. The existing `/docs` redirect is in `apps/web/next.config.ts`; `app/docs/[...slug]/page.tsx` is a 404, not an MDX loader. `llms-full.txt` currently special-cases only `recipes/index.mdx`. The SEO audit parses the literal `DOCS_NAV` source. These assumptions must be updated together.

Create:
- `apps/web/app/components/docs/doc-sections.ts`: section identity, registry and canonical path normalization.
- `apps/web/app/components/docs/doc-sources.ts`: explicit href-to-content mapping for authored pages.
- `apps/web/app/components/docs/DocsSectionSwitcher.tsx`: App/Framework links with current state.
- `apps/web/app/components/docs/doc-sections.test.ts`, `doc-sources.test.ts`, `docs-section-switcher.test.tsx`: membership, source mapping and accessible links.
- `apps/web/app/docs/page.tsx`: two-entrance landing page.
- `apps/web/app/docs/app/page.tsx`, and `app/docs/app/{install,codex,claude-code,first-conversation,manage-work,iphone,accounts-and-data,troubleshooting,b4-agents}/page.tsx`: explicit wrappers.
- `apps/web/content/docs/app/index.mdx` and matching nine named `.mdx` files: authored text, supplied by the content plan.
- `apps/web/app/components/docs/docs-identity.module.css` and `docs-identity.test.tsx`: docs-scoped layout rules and semantic checks.

Modify existing navigation, search, SEO and export files named by tasks below. Keep color literals in `app/styles/tokens.css` and use role variables in modules.

### Task 1: Introduce a section registry without breaking framework consumers

Files: new `doc-sections.ts`, `doc-sources.ts` and their tests; modify `nav.ts`, `nav.test.ts`, `scripts/check-docs.mjs`, `apps/web/scripts/audit-built-seo.mjs` and its `app/seo/audit-built-seo.test.ts`.

- [ ] Write tests for canonical `/docs/app`, `/docs/app/`, nested app pages, `/docs/api/sdk`, `/docs/approval-grants`, `/docs/application` (not App), and `/docs` (landing). Freeze the pre-change framework href inventory as a regression fixture at `app/components/docs/__fixtures__/framework-hrefs.json`.
- [ ] Run `pnpm --filter @b4run/web test -- app/components/docs/doc-sections.test.ts app/components/docs/nav.test.ts`; expect new imports or section expectations to fail.
- [ ] Implement these interfaces and exact prefix semantics:

```ts
export type DocsArea = "app" | "framework"
export function docsArea(href: string): DocsArea | null {
  const path = href.split(/[?#]/, 1)[0]!.replace(/\/+$/, "")
  if (path === "/docs") return null
  if (path === "/docs/app" || path.startsWith("/docs/app/")) return "app"
  return path.startsWith("/docs/") ? "framework" : null
}
```

Keep the existing literal `DOCS_NAV` as the framework registry while adding `APP_DOCS_NAV`; expose `navFor(area)` and area-specific ordered pages. `ALL_DOCS_PAGES` becomes their union plus existing API leaves exactly once. Source resolution is explicit (`/docs/app` -> `docs/app/index.mdx`, `/docs/recipes` -> `docs/recipes/index.mdx`). Do not derive arbitrary filesystem paths from a URL.
- [ ] Keep the actual route canonical spelling `/docs/app` consistent with Next's existing no-trailing-slash policy; links may normalize inbound `/docs/app/`. Update source-inventory consumers to include both literal registries, with tests proving the built SEO audit and root docs check see all ten app pages. Do not replace the typed `DocsPageHref` union with unrestricted string.
- [ ] Rerun the focused tests; expected PASS and identical framework href inventory. Commit `feat(docs): define app and framework sections` once content routes are present in the same buildable change (Task 2).

### Task 2: Add real pages, landing and section-aware navigation

Files: new wrappers/content listed above, `app/docs/page.tsx`, `DocsSectionSwitcher.tsx`; modify `next.config.ts`, `DocsSidebar.tsx`, `DocsNavGroups.tsx`, `MobileDocsNav.tsx`, `DocsNoScriptNav.tsx`, `DocsBreadcrumb.tsx`, `DocsPrevNext.tsx`, `nav.ts`, `app/seo/registry.ts`, `app/seo/resolve.ts`, `app/sitemap.ts`, `apps/web/scripts/generate-seo-lastmod.mjs`, `apps/web/scripts/audit-built-seo.mjs`, their `app/seo/` tests, and related nav tests.

- [ ] Write tests that `/docs` is not redirected; the landing links to both entrances; the mobile and desktop switcher agree; the last App page never links to Framework as next; API breadcrumbs retain their hub. No-script navigation must expose both labeled areas through ordinary links (it need not guess a client pathname on the server).
- [ ] Run `pnpm --filter @b4run/web test -- app/components/docs/nav.test.ts app/components/docs/docs-nav-groups.test.tsx app/components/docs/mobile-docs-nav.test.ts app/components/docs/docs-section-switcher.test.tsx`; expect new behavior to fail.
- [ ] Remove only the `/docs` -> `/docs/getting-started` redirect. Add the two-entrance page and ten complete text-first guides using the content plan's fact-checked drafts. Use the existing wrapper pattern: import MDX, resolve metadata, render `<DocsPage href="..." Content={...} />`. Do not link to unfinished drafts in public navigation.
- [ ] Add SEO entries with matching source paths and descriptions for all ten authored pages. Add `/docs` separately as a WebPage entrance to the static SEO registry, resolver, sitemap, lastmod generator source inventory and built SEO audit expected routes; it is not an eleventh authored guide. Test that `/docs` has canonical metadata and structured data and is no longer classified as a redirect. The switcher selects by route and links to the opposite section's home. `/docs` uses neutral entrance navigation; unknown routes keep a genuine 404. Move eyebrow-styled labels in docs navigation to sentence-case text and use simple previous/next links with a hairline.
- [ ] Verify app root PageActions exports slug `app`, not `app/` or empty. Update breadcrumb tests for Docs / App or Framework while retaining the API hierarchy. Add an ordinary docs link to the existing `/app` page and a reciprocal link from `/app` to app docs.
- [ ] Before importing the expanded SEO registry in tests or a build, run `pnpm --filter @b4run/web seo:lastmod` to generate valid entries for the new app routes and `/docs`. The generator supports uncommitted sources; do not hand-write dates. Run `pnpm --filter @b4run/web test -- app/seo/generate-lastmod.test.ts app/seo/audit-built-seo.test.ts app/seo/seo.test.ts` and the focused nav tests; expected PASS and all nav links target real routes. Commit named source/content files plus generated metadata together; no half-populated registry.

### Task 3: Search and machine-readable parity

Files: modify `search-index.ts`, `DocsSearch.tsx`, `docs-search-results.ts`, their tests, `app/llms.txt/route.ts`, `app/llms-full.txt/route.ts`, `lib/llms-markdown.mjs`, `app/api/markdown/[...slug]/route.ts` as needed, and corresponding route tests; `app/seo/registry.ts`, `app/sitemap.test.ts`.

- [ ] Add a typed `area: DocsArea` to search entries, distinct from the existing group `section`. Tests use identical terms in App and Framework pages: active-area search hides the other group until All docs is selected; results retain area labels, keyboard selection and existing API alias ranking. Switching pages resets default scope to the current area; `/docs` defaults to All docs.
- [ ] Run `pnpm --filter @b4run/web test -- app/components/docs/search-index.test.ts app/components/docs/docs-search-dialog.test.tsx app/llms-full.txt/route.test.ts app/api/markdown`; expect new app-index/source assertions to fail.
- [ ] Apply filtering before ranking and result limits. Reuse existing static index loading. Feed both nav registries into index construction and source mapping. Update full markdown compilation to resolve `app/index.mdx`; compact llms lists App and Framework entrances. Preserve existing heading/anchor and API ownership extraction.
- [ ] Ensure all ten pages appear once in sitemap and full reference. Markdown endpoints continue rejecting traversal. The docs inspector utility is excluded from authored-page exports; authored prose includes an ordinary link and meaningful text when interactive components are stripped.
- [ ] Run the focused tests plus `pnpm --filter @b4run/web test -- app/sitemap.test.ts app/seo/seo.test.ts`; expected PASS. Commit `feat(docs): scope search and exports by audience`.

### Task 4: Apply LLA docs typography with B4 colors

Files: modify `app/docs/layout.tsx`, `app/styles/tokens.css`, `app/styles/design-system.test.ts`, docs navigation components; new `docs-identity.module.css`, `docs-identity.test.tsx`; inspect existing `app/components/ReadingLayout.tsx` and keep unrelated callers unchanged.

- [ ] Add tests for docs-scoped Hanken font variables, no uppercase eyebrow in docs navigation, and continued Paper Relay contrast/token parity. Do not test whole prose strings or exact cosmetic DOM trees.
- [ ] Run `pnpm --filter @b4run/web test -- app/styles/design-system.test.ts app/components/docs/docs-identity.test.tsx`; expect typography expectations to fail.
- [ ] Load `Hanken_Grotesk` in the docs layout using `next/font/google`, following the installed Next documentation. Scope `--font-sans` to the docs wrapper; retain global Inter for unrelated marketing and JetBrains Mono for code. Centralize any new font role token; reuse existing palette variables. No decorative card grid, shadow, uppercase kicker, cobalt, or old amber.
- [ ] Ensure shared reading measures and mobile controls remain usable. Use strong control boundaries where needed rather than decorative rule color alone. Apply identity to both doc areas; avoid changing framework prose content unnecessarily.
- [ ] Run focused tests, then inspect App and Framework pages at 320/375/768/1024/1440 and 200% zoom. Check body text, long code, sidebar, mobile menu, search overlay, focus rings and no-script navigation. Commit `style(docs): apply studio typography and b4 palette`.

### Task 5: Integrated route and SEO validation

- [ ] After final source edits, regenerate with `pnpm --filter @b4run/web seo:lastmod` before any route/SEO tests or build, then run `pnpm --filter @b4run/web seo:lastmod:check` and `pnpm --filter @b4run/web seo:lastmod:routes`. The generated manifest is tracked and must be committed with the change. Run `pnpm --filter @b4run/web test`, `pnpm --filter @b4run/web typecheck`, `pnpm --filter @b4run/web lint`, and `pnpm --filter @b4run/web build`; all must pass. Run root required gates per AGENTS.md for this code scope.
- [ ] After the final build, run `pnpm --filter @b4run/web seo:audit-built`; expected PASS, including `/docs`, all app pages and the unchanged framework inventory. After source commits, rerun the lastmod checks; generation preserves entries whose source digests are unchanged. Never fabricate timestamps or omit required generated metadata.
- [ ] Verify the saved framework href inventory against the built site, including old research recipe redirects. Record any baseline failures separately; fix regressions before handoff. No public rollout until the ten-page content review has passed.
