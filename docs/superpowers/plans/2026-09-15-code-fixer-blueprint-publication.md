# Code-fixer blueprint publication implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make the qualified code-fixer application discoverable through `b4 add code-fixer`.

**Architecture:** Publish an agent-facing installation guide derived from the corrected ordinary example. Pin source to `0003db2802b718ed167c8266b09a2d00ae01a522` and packages to published 0.8.32. Extend the existing catalog category allowlist; retain the print-only CLI contract. No runtime or release-controller changes.

**Tech Stack:** Markdown, Next route handlers, TypeScript, Vitest.

**Approved spec:** `docs/superpowers/specs/2026-09-14-code-fixer-app-correction-design.md`, Actual blueprint delivery. Library/example work and standalone qualification are complete.

### Task 1: Publish guide and catalog coverage

Files: `apps/web/content/blueprints/agents/code-fixer.md`, `apps/web/lib/blueprints.ts`, `apps/web/app/blueprints/catalog.test.ts`, `apps/web/app/blueprints/routes.test.ts`.

- [x] Add a failing catalog expectation for code-fixer in agents, and route tests proving it is listed and returns the qualified source/release instructions without frontmatter.
- [x] Run `pnpm --filter @b4run/web test app/blueprints` and confirm missing guide/category failures.
- [x] Add `agents` to ALLOWED_CATEGORIES and promote `examples/code-fixer/BLUEPRINT.md` into the public guide with frontmatter and exact pins.
- [x] Complete the file inventory (.dockerignore, compiler config, test configs, source/scripts/fixtures); preserve the qualified transformations, exclude consumer helper, preserve user files and defaults to sibling app for app-global configuration conflicts.
- [x] Provide a primary-route `// b4-blueprint: code-fixer@1` marker; record copied file hashes after that documented addition. Include reproducible pinned acquisition and lockfile handling, provenance and actual verification commands.
- [x] Preserve supported public scaffold behavior for a new application, remove scaffold demonstration routes only when freshly created and identified, and never mix unqualified package versions.
- [x] Run the blueprint tests again; all must pass.

### Task 2: Connect docs and durable qualification evidence

Files: `apps/web/content/docs/blueprints.mdx`, `examples/code-fixer/BLUEPRINT.md`, `examples/code-fixer/server/README.md`, `docs/superpowers/runbooks/2026-09-15-code-fixer-standalone-qualification.md`.

- [x] Explain complete agent examples in blueprint docs, add agents to category list, and show `b4 add code-fixer`.
- [x] Replace the unpublished draft with a link to the authoritative guide and qualified source/release facts; avoid duplicate installation instructions.
- [x] Add a concise README installation entry; keep monorepo development instructions.
- [x] Commit a qualification record with exact source, release, package integrity, test results and public CI/audit links. Distinguish deterministic replays from live-model quality; no timing marketing claims.
- [x] Review final guide against the previously qualified transformations and reproduce any materially changed installation steps in a new standalone directory. In particular verify public scaffolding and marker addition if not covered by the previous qualification.

### Task 3: Review and validation

- [x] Independent guide/quick-start review against the approved correction spec and qualification receipt, fixing material findings.
- [x] Run web tests, scoped formatting, docs check and required SEO metadata regeneration/check as applicable.
- [ ] Run `pnpm ci:validate`; investigate failures, preserving unrelated user state.
- [ ] Commit and open a focused PR, respecting the limit of two active full CI submissions. Merge on green under existing user authorization after required checks pass; retain release-controller reliability findings for separate work.
