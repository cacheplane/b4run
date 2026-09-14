# Public Surfaces Implementation Plan

> Use superpowers:executing-plans inline. Independent spec/plan and final reviews
> are required; preserve the existing worktree and ignored recordings.

**Goal:** Verify production and complete shared brand surfaces plus the developer narrative.
**Architecture:** Scoped blog CSS, existing shared footer, repository assets, and
an example-owned walkthrough. Reuse logo geometry and established source code.
**Tech Stack:** Next.js, CSS Modules, Markdown, existing SVG/PNG tools, Vitest.
**Spec:** ../specs/2026-09-14-public-surfaces-design.md

- [ ] Verify live homepage source, controls, mobile reflow, links and OG output.
- [ ] Add blog.module.css and apply it through app/blog/layout.tsx and blog
  cards/header/tags/meta. Replace the legacy blog FinalCta with a small BlogCta
  using the exact scaffold command and developer-walkthrough link. Preserve
  metadata, source content, visibility and reading layout.
- [ ] Apply paper/ink/Inter to article OG while preserving offline rendering,
  visibility and dimensions. Reuse the supplied wordmark. Run existing image
  tests before/after and inspect generated cards for long titles.
- [ ] Update Footer.tsx and root README; preserve activation commands, substantive
  LangGraph boundaries and retained demo receipts. Fix only the root historical
  demo destination and corresponding contract if needed.
- [ ] Add repository social-card SVG and rendered PNG from the supplied logo and
  approved headline; document dimensions and regeneration in docs/brand/README.md.
- [ ] Write WALKTHROUGH.md from actual example sources and link it from homepage,
  footer, root/example READMEs and recipes overview. Correct example evidence
  summary to final report. Independent review checks claims and snippet accuracy.
- [ ] Run web tests/lint/typecheck, build, seo:lastmod/check and built SEO audit;
  check README contracts and docs completeness. Browser QA: 320/390/768/1280,
  blog index/tag/article, docs regression, source links and social-card output.
- [ ] Run pnpm ci:validate, changesets and whitespace checks. Review final diff.
  Check CI capacity, create PR, wait for required validation and preview, merge
  exact reviewed head on green with known hosted-review credit exception.

No extra design approval is required: this applies the previously approved brand
and the user's explicit authorization of follow-ups 1–3. Execution and merge
results are recorded in the task response and verification ledger.
