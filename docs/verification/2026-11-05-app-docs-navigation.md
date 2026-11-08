# App documentation: release facts and navigation

Implemented inline in `.worktrees/app-docs-navigation-20261105`, branch `blove/app-docs-navigation`, from planning commit `941610a03` (website baseline `c1e179655`). App source reference: `a7e1ef743cebaf3704a3fa37ede72db8018df12d`. The owner's original b4run checkout was not changed.

## Delivered

- `/docs` is the audience entrance. App guides live under `/docs/app`; every existing framework URL and its reading order is retained, including the API reference leaves.
- App / Framework links work in the desktop sidebar, mobile menu, and no-JavaScript fallback. Breadcrumbs and previous/next links remain within the selected audience.
- Search defaults to the current audience and offers App, Framework, and All docs. Scope is applied before ranking and the result limit. API alias ranking remains covered.
- Ten source-backed App drafts have real routes, metadata, sitemap entries, Markdown endpoints, full LLM exports, and CLI documentation bundle entries. Navlog is the maintained example and the bridge to framework documentation.
- Docs use Hanken Grotesk with existing B4 Paper Relay colors and monospace code. Navigation labels use normal capitalization; previous/next links use a plain ruled layout.
- At the owner's direction, Mac and iPhone downloads are explicitly labeled placeholders and the planned Homebrew install command is included. See `app-docs-release-facts.md` for source evidence and pre-release verification still needed.
- The built SEO auditor now recognizes the docs entrance, existing privacy/updates pages, and the existing `/ingest/` robots exclusion. The privacy/updates wrappers now emit their registered WebPage and breadcrumb metadata; their prose is unchanged.

## Browser checks

Production Next build served locally on port 3217. Checked App overview, framework Getting Started, and the docs entrance at widths 320, 375, 768, 1024, and 1440. Document scroll width matched viewport width in all 15 checks. Computed docs font was Hanken Grotesk. Reviewed desktop and mobile screenshots.

Mobile menu showed both audiences and App navigation. Search opened with App selected, switching to Framework showed framework results, All docs remained selectable, and Escape closed the dialog and restored focus to the search trigger. With JavaScript disabled, mobile navigation exposed all 10 App and 66 framework journey links plus the audience home links. At 200% CSS zoom, the install page did not overflow horizontally; this is a zoom simulation, not an OS/browser zoom certification. `/api/markdown/app` returned HTTP 200 with the overview text.

The built SEO audit passed for 117 sitemap pages, 92 authored docs, 92 docs social cards, both LLM exports, all 11 robots groups, and negative social-image routes. No production deployment or live model calls were performed.

## Validation status

- Production website build: passed. Final website lint: passed (492 files). Scoped CLI/script lint and `git diff --check`: passed.
- Initial `pnpm ci:validate` passed release integrity, repository lint, build-cache checks, the workspace build (29 tasks), and typecheck (59 tasks). Its broad test run was stopped after timing failures; a bounded two-worker source run was then allowed to finish.
- `pnpm test -- --maxWorkers=2`: 12,878 passed, 385 skipped, 3 failed across 1,043 test files. No website tests failed. Two failures were the unchanged Vercel target tests exceeding their 5-second deadline; the third was the retired brand name in the inherited design note.
- Brand gate after correcting the design note and staging all new files: 15 passed. An initial isolated Vercel rerun still timed out once; both cases passed with a 30-second diagnostic limit. After the broad validation load stopped, both passed again with the normal 5-second deadline (2 passed, 131 deselected). No timeout setting or runtime code was changed. The original full run remains recorded as failed; it was not rerun in full after the focused fixes/checks.
- CLI documentation bundle: 40 passed. Final manifest/sitemap checks: 41 passed. Built SEO audit: passed with zero failures. All release placeholders remain explicit.
- Auxiliary `test:test-runner`, `test:brand-demo`, and `test:brand-demo-rag`: passed. These were run separately because the forwarded source-worker flag skips them in the root test wrapper.
- Remaining gates: release inventory, release controller (4,184 tests), chart sync, docs completeness, package checks, TypeScript package-consumer checks, and harness self-test all passed.
- Main harness: runtime passed (17 tests, 1 skipped), smoke passed (3 tests), framework failed (120 passed, 1 failed, 1 skipped). The failure is generated Navlog activation: the third AG-UI request returned HTTP 409, `malformed_checkpoint`, with `Pending checkpoint interrupts cannot be addressed safely`. Its preceding two requests returned 200. See the qualification finding in `app-docs-release-facts.md`. This prevents claiming a fully green repository gate or qualified Navlog capture.
- Final source/diff review was performed inline, honoring the owner's execution preference; no independent subagent review was run. The implementation leaves framework runtime code unchanged and preserves the pinned framework URL inventory.

Harness evidence is retained locally under `artifacts/testing/harness-2026-11-06T061312-352Z-22411/` (gitignored).

Release artifact installation, provider compatibility against the published app, iPhone distribution, recordings, and the interactive turn inspector remain subsequent work. This phase does not claim those integrations or assets are finished.
