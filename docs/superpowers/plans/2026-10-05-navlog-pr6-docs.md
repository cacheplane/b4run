# Navlog PR 6: recipe pages, slugs and the last research prose

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the rename: move the two recipe pages to `flight-planner` slugs with matching titles across every pin, redirect the old slugs, and remove the remaining "research" prose that describes the scaffold (READMEs, the templates `AGENTS.md`, the llms.txt route, two code comments, the demo captions), leaving generic docs examples that merely use "research" as a sample name untouched.

**Architecture:** A docs page move on b4.run touches a fixed set of pins (nav, nav test, check-docs, SEO registry, page wrappers, anchors test, cross-links, the lastmod manifest); this plan lists each with its current line. Prose edits are limited to sentences that are now false. No code behaviour changes; the only code edits are two comments and the harness test file's name.

**Tech Stack:** MDX docs under `apps/web/content/docs`, Next.js app router wrappers, `scripts/check-docs.mjs` pins, the SEO lastmod generator.

**Spec:** `docs/superpowers/specs/2026-10-04-navlog-example-design.md` sections 3 and 8. **Branch:** `blove/navlog-docs` from `origin/main` after PR 5 (#942) merges, or stacked on `blove/navlog-deploy` before that.

**Rules:** run from the repo root with Node 24; every docs content change is committed before `pnpm --dir apps/web seo:lastmod`, and the regenerated manifest is committed separately; `node scripts/check-docs.mjs` and `pnpm --filter @b4run/web test` after every task; the `apps/web` page count does not change (two pages move, none added), so `packages/cli/test/docs-bundle.test.ts` needs no count bump, but run it (`pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/docs-bundle.test.ts`) to be sure. Parity-scoped files (example `src/`, template twins) are mirrored.

---

## Task 1: move the two recipe pages

**Files (every pin, with the line on the PR 5 branch):**
- Move: `apps/web/content/docs/recipes/research-assistant.mdx` → `recipes/flight-planner.mdx`; `recipes/research-web-ui.mdx` → `recipes/flight-planner-web-ui.mdx`
- Move: `apps/web/app/docs/recipes/research-assistant/page.tsx` → `app/docs/recipes/flight-planner/page.tsx`; `research-web-ui/page.tsx` → `flight-planner-web-ui/page.tsx` (update the import path and both `href`/`resolveStaticSeoPage` strings inside)
- Modify: `apps/web/app/components/docs/nav.ts:118-119` (labels "Build a Flight Planner", "Flight Planner Web UI"; hrefs)
- Modify: `apps/web/app/components/docs/nav.test.ts:136-137` (the `FOUNDATION_DOCS_NAV` copy), `:692` (`cardTitles` → `["Build a Flight Planner", "Tools", "Routes"]`), `:696` (reads `recipes/flight-planner.mdx`), `:704`, `:711` (breadcrumb titles)
- Modify: `scripts/check-docs.mjs:1775` (file path), `:1884` and `:1893` (journey-link source path and message), `:1910` (`expectedGettingStartedDecisionTitles`), `:1936`, `:3880` (file path), `:4097-4098` (`expectedNavDocEntries` labels and hrefs)
- Modify: `apps/web/app/seo/registry.ts:438-449` (paths, titles, sourcePaths; descriptions reworded: "Build a B4.run VFR flight planner for a Cessna 172N with weather and performance subagents, a POH-grounded navlog tool, planning, memory, keyless tests and the Workbench UI." and "Connect the flight-planner demo to CopilotKit over AG-UI with thread hydration, inline activity cards, the navlog sheet and route map, approval prompts, and memory-candidate review.")
- Modify: `apps/web/app/components/docs/docs-anchors.test.ts:1580` (file path)
- Modify cross-links: `apps/web/content/docs/getting-started.mdx:118` (href, title, subtitle "weather and performance subagents, planning, memory and a map Workbench"), `recipes/index.mdx:13` and `:23`, `ag-ui.mdx:395` and `:489`, the moved `flight-planner.mdx:209` self-link, and the H1s of both moved files
- Modify: `apps/web/next.config.ts` `redirects()`: add two permanent redirects from the old slugs to the new ones (`/docs/recipes/research-assistant` → `/docs/recipes/flight-planner`, `/docs/recipes/research-web-ui` → `/docs/recipes/flight-planner-web-ui`)

- [ ] **Step 1: Move with git**

```bash
git mv apps/web/content/docs/recipes/research-assistant.mdx apps/web/content/docs/recipes/flight-planner.mdx
git mv apps/web/content/docs/recipes/research-web-ui.mdx apps/web/content/docs/recipes/flight-planner-web-ui.mdx
git mv apps/web/app/docs/recipes/research-assistant apps/web/app/docs/recipes/flight-planner
git mv apps/web/app/docs/recipes/research-web-ui apps/web/app/docs/recipes/flight-planner-web-ui
```

- [ ] **Step 2: Rewrite every pin above**

The H1 of `flight-planner.mdx` becomes `# Build a Flight Planner`; of `flight-planner-web-ui.mdx`, `# Flight Planner Web UI`. Nav labels must equal the H1s (nav.test asserts it). Then:

```bash
grep -rn "research-assistant\|research-web-ui\|Research Assistant" apps/web/app apps/web/content scripts/check-docs.mjs packages/cli --include=*.ts --include=*.tsx --include=*.mjs --include=*.mdx | grep -v "lastmod.generated\|/blog/\|node_modules"
```
Expected after the edits: no hits (blog posts and `docs/brand/demo/evidence-matrix.md` keep their history).

- [ ] **Step 3: Redirects**

In `apps/web/next.config.ts`, inside `redirects()`, after the `/docs` entry:

```ts
      // The research recipes became the flight-planner recipes (navlog series, PR 6).
      { source: "/docs/recipes/research-assistant", destination: "/docs/recipes/flight-planner", permanent: true },
      { source: "/docs/recipes/research-web-ui", destination: "/docs/recipes/flight-planner-web-ui", permanent: true },
```

If `apps/web` has a redirects test (grep `redirects` under `apps/web/app` and `apps/web/test`), add the two entries to it.

- [ ] **Step 4: Check, commit, lastmod**

```bash
node scripts/check-docs.mjs
pnpm --filter @b4run/web test
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/docs-bundle.test.ts
git add -A apps/web scripts/check-docs.mjs
git commit -m "docs: the research recipes become the flight-planner recipes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod
pnpm --dir apps/web seo:lastmod:check && pnpm --dir apps/web seo:lastmod:routes
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate SEO lastmod for the moved recipe routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
Expected: the manifest drops the two old routes and adds the two new ones with the committer date of the content commit; `seo:lastmod:routes` passes. If the `generate-lastmod.test.ts` gate complains about a route it has never seen, the content commit was not made before regeneration; redo the order.

---

## Task 2: prose that is now false

**Files:**
- `README.md:37` (alt text: "Animation showing a generated flight-planner workspace, a deterministic test, and the B4.run Workbench"; note the GIF itself is re-recorded later, the alt describes what it will show), `:114` (link text "Flight planner (navlog)"), `:151` ("the published navlog starter's OpenAI live…"), `:168` (link to `/docs/recipes/flight-planner-web-ui`), `:178-181` ("Its navlog template is a two-package workspace…", "a navlog scaffold generated from…")
- `examples/README.md:9` (table row: "The flagship example, a VFR flight planner for a Cessna 172N: live weather tools, POH-grounded navlog computation, weather and performance subagents, memory, planning, offloading, approval-gated filing, and the map Workbench")
- `packages/create-b4-app/README.md:32` ("For the full flight-planning assistant, a `server` and `web` npm workspace with subagents, memory, planning and a map Workbench, select the `navlog` template with `npm create b4-app@latest my-agent -- --template navlog`." Keep the version-history sentence.)
- `AGENTS.md` workspace map row for the example (already renamed; reword the purpose to match `examples/README.md`)
- `apps/web/content/templates/AGENTS.md` (4 mentions): "research scaffold" → "navlog scaffold"; the sample system prompt line "You are a research coordinator…" → "You are a VFR flight-planning assistant for a Cessna 172N…"; the `src/tools/searchCorpus.ts` sample → `computeNavlog.ts`; the run body content string → the plan prompt
- `apps/web/app/llms.txt/route.ts` (2 mentions): same substitutions
- `apps/web/app/components/docs/api-reference.ts` (2 mentions): read them; if they are prose about the scaffold, reword; if they are generic examples, leave
- `apps/web/content/docs/api/ag-ui.mdx` (4 mentions): same rule
- `apps/web/app/lib/demo-media.json:14` and `:22`: captions become "Inspect the generated navlog route, co-located route files, shared computeNavlog tool, and keyless unit tests." and "Run npm test and see the deterministic navlog unit tests pass without a provider key." (`check-media.mjs` and `demo.test.mjs` pin these captions; update both, and the matching transcript lines in `docs/brand/demo/transcript.md` if they quote the captions)
- Code comments: `examples/navlog/server/src/app/navlog/state.ts` ("Accumulated planning context from tool and subagent results."), `memory.ts` ("Long-term, cross-session memory for the flight planner…"); mirror both to the template
- `packages/devkit/templates/app-navlog/web/README.md` and `server/README.md`: the one remaining mention each (read and reword)

Leave alone: `subagents.mdx` (a generic `support/[tenant]/subagents/research` example), `permissions.mdx`, `dispatch-from-route.mdx`, `add-a-tool.mdx`, `agents.mdx`, `tools.mdx`, `workspace.mdx`, `context-management.mdx`, `retry.mdx`, `reasoning-effort.mdx`, `observability.mdx`, `memory.mdx`, `testing.mdx`, `upgrading.mdx`, `stream-output.mdx`, `access-control.mdx` (generic examples or history), blog posts, CHANGELOGs, `docs/superpowers/**`, `docs/brand/demo/evidence-matrix.md`.

- [ ] **Step 1: Make the edits**, then:

```bash
grep -rn -i "research" README.md examples/README.md packages/create-b4-app/README.md apps/web/content/templates/AGENTS.md apps/web/app/llms.txt/route.ts apps/web/app/lib/demo-media.json examples/navlog packages/devkit/templates/app-navlog | grep -v node_modules
```
Expected: no hits except historical CHANGELOG lines.

- [ ] **Step 2: Gates and commit**

```bash
node scripts/check-docs.mjs
node scripts/readme-contracts.test.mjs 2>/dev/null || node --test scripts/readme-contracts.test.mjs
pnpm test:brand-demo
pnpm --filter @b4run/devkit test
pnpm --filter @b4run/web test
git add -A README.md examples/README.md AGENTS.md packages/create-b4-app/README.md apps/web/content/templates/AGENTS.md apps/web/app/llms.txt/route.ts apps/web/app/components/docs/api-reference.ts apps/web/content/docs/api/ag-ui.mdx apps/web/app/lib/demo-media.json docs/brand/demo examples/navlog packages/devkit/templates/app-navlog
git commit -m "docs: the last research prose describes the flight planner

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate SEO lastmod after the prose pass

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

`scripts/readme-contracts.test.mjs` pins README sentences (lines 461, 464, 1290, 1508, 1521 on the PR 5 branch reference "research"); update those pins to the new wording in the same commit.

---

## Task 3: the harness test file name

- [ ] `git mv test/generated/run-generated-research-activation.test.ts test/generated/run-generated-navlog-activation.test.ts`; grep the repo (`scripts/`, `.github/`, `docs/brand/demo`, `package.json`, `turbo.json`, `test/harness`) for the old file name and update every reference, including the evidence-matrix row if it is quoted as a test name (that file is historical; leave it). Run `pnpm verify:harness:self-test` and `pnpm verify:harness:framework` once. Commit `test(harness): the generated-activation test takes the navlog name`.

---

## Task 4: changeset, gate, PR

- [ ] Changeset `.changeset/navlog-docs.md`: `"create-b4-app": patch` and `"@b4run/devkit": patch` with "The navlog scaffold's READMEs, code comments and the `create-b4-app` README describe the flight planner; the docs recipes moved to `/docs/recipes/flight-planner` and `/docs/recipes/flight-planner-web-ui` (the old URLs redirect)."
- [ ] Gate: `pnpm lint && pnpm check:build-cache && pnpm build && pnpm typecheck && pnpm test && pnpm check:release-inventory && node scripts/check-docs.mjs && node scripts/check-changesets.mjs`, then `pnpm --dir apps/web seo:lastmod:check`.
- [ ] PR title "docs: flight-planner recipes and the last research prose"; body lists the moved slugs, the redirects, the prose files, and what was left alone and why; closes the series.

## Self-review against the spec

- Spec 3 naming: recipe slugs and titles (Task 1), redirects (Task 1 Step 3). Spec 8 docs: recipe pages (already rewritten in PR 3; retitled here), examples README, repo AGENTS.md, example READMEs, demo-media captions (Task 2); scaffold template id and changeset done in PR 2. The demo clips themselves remain out of scope (spec section 2).
- Placeholders: none; each pin names its file and current line. Line numbers may drift as the stack merges; the greps in each task are the ground truth.
