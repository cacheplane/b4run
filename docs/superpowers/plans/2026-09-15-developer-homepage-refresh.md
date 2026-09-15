# Developer Homepage Refresh Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for implementation and independent review. Steps use checkbox syntax.

**Goal:** Align the developer homepage with the qualified ordinary code-fixer app and public installation guide.

**Architecture:** Preserve historical evidence and its walkthrough; add a separate bounded qualified-source snapshot for capability panels. Keep existing presentation components and update only provenance, capability copy, project map, and installation copy.

**Tech Stack:** Existing Next.js, React, Shiki, TypeScript, Vitest, CSS modules.

**Spec:** `docs/superpowers/specs/2026-09-15-developer-homepage-refresh-design.md`.

## Task 1: Qualified capability source

Files: create `apps/web/app/components/homepage/qualified-source.json`,
`qualified-source.ts`, `qualified-source.test.ts`; modify `highlight.ts`.

- [x] Add failing tests for release/source identity, exact source hashes and contiguous excerpts, pinned source links, and separation from historical source.
- [x] Run `pnpm --filter @b4run/web test app/components/homepage` and confirm intended failures.
- [x] Capture only needed source files via `git show 0003db2802b718ed167c8266b09a2d00ae01a522:examples/code-fixer/server/<path>`; record hashes and excerpt ranges. Use a small typed helper to supply excerpt text and pinned URLs, with no runtime git/network dependency.
- [x] Point capability preparation at qualified source, with short accurate explanations for workspace ownership, sandbox policy, example-owned verification, and runtime approval. Keep the historical walkthrough preparation unchanged.
- [x] Run homepage tests and scoped Biome. Review source against pinned Git files.

## Task 2: Homepage narrative and installation

Files: `DeveloperHome.tsx`, `Walkthrough.tsx`, `Capabilities.tsx`,
`homepage.test.tsx`, `../HeaderInner.tsx`, `header.test.tsx`, and
`homepage.module.css` only if layout needs it. Point the existing homepage-only
header blueprint action to the published guide; preserve the docs header.

- [x] Add a regression asserting rendered homepage contains the guide-printing command/link, qualified revision context, historical source label, and no `run:agent` command.
- [x] Run focused tests to confirm the obsolete command/labels fail those assertions.
- [x] Preserve the headline and result-first layout. Label historical source clearly. Label capabilities as the qualified 0.8.32 example. Update the file map with candidate preparation and replace retired setup with `b4 add code-fixer`, a guide description, CLI prerequisite docs, and the direct public guide link.
- [x] Run focused tests and docs checks. Review explanatory copy against source/guide.

## Task 3: Verification and delivery

- [x] Independently review spec compliance and code quality; resolve findings.
- [x] Run `pnpm --filter @b4run/web test`, `pnpm lint`, `pnpm build`, and `pnpm typecheck`; regenerate SEO lastmod only if its check requires it.
- [x] Start the built site and inspect desktop and 320px/390px layouts, keyboard selections, copying, reduced motion, no-JavaScript initial content, and docs layout. Save ignored review screenshots.
- [ ] Commit the completed change and open a PR with concise behavior and validation evidence. Respect the repository limit on simultaneous full CI submissions.
- [ ] Wait for all required CI and production-boundary lanes; merge on green under the user's existing authorization. Verify the deployed homepage and guide links.

Article and launch-material development follow the completed homepage refresh.

## Local verification receipt

September 15: web suite 639 passed, one existing skip; homepage suite 25 passed.
Repository lint, build, and typecheck passed. Built SEO audit passed all 83 URLs.
Playwright verified keyboard selection, exact clipboard contents for all four
qualified panels and recorded agent, independent recorded file/step selection,
folding, no page overflow at 320/390/640/768/1280px, reduced-motion operation,
and no-JavaScript source/result/installation content. Docs layout was visually
compared before/after and its header regression test passed. Independent spec
and code reviews approved. Review captures are local ignored artifacts under
`artifacts/visuals/homepage-refresh/`.
