# App Docs Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, or superpowers:subagent-driven-development when delegation is selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver ten production app guides and a real, replayable Navlog conversation alongside the existing framework docs.

**Architecture:** Four bounded plans share one approved design and a versioned capture contract. Website changes belong to b4run; the opt-in recording command belongs to b4app and uses its existing client boundary.

**Tech Stack:** Next.js/React/MDX, TypeScript/Vitest, Swift/Swift Testing, static JSON and video.

---

## Authority and baseline

Approved design: `docs/superpowers/specs/2026-11-05-app-docs-inspector-design.md` in b4run. The owner approved the written design on November 5, 2026, then requested implementation plans. This plan set does not authorize a production deployment or claim recordings already exist.

Planning workspace: `/Users/blove/repos/b4run/.worktrees/app-docs-design-20261105`, branch `blove/app-docs-design`; website baseline `c1e179655`, design commit `37e16272e`. App reference workspace: `/Users/blove/.codex/worktrees/894b/b4app`, baseline `a7e1ef743cebaf3704a3fa37ede72db8018df12d`. References are local evidence, not assertions that remote main has not advanced.

Implementation paths in the website plans are relative to a fresh b4run implementation worktree; app paths in the capture plan are relative to a separate b4app worktree. Never switch or clean the owner's dirty `/Users/blove/repos/b4run` checkout. Create `blove/` branches per PR from refreshed integration bases, carry the reviewed documents forward, and reconcile moved files before editing. Read each checkout's AGENTS.md. Do not install dependencies or run application suites merely to validate these planning documents.

## Plans and order

| Plan | Deliverable | Dependencies |
| --- | --- | --- |
| `2026-11-05-app-docs-navigation.md` | Section-aware navigation, search/export parity, LLA docs presentation, complete text-only guides | Verified facts for public content; source groundwork can start immediately |
| `2026-11-05-app-docs-capture.md` | Versioned public contract, bounded opt-in recorder, first real reviewed Navlog capture | App/runtime qualification; no dependency on docs navigation |
| `2026-11-05-app-docs-inspector.md` | Inline/full-page Replay, Source, stable lesson jumps, accessible fallback | Capture contract fixed; synthetic test fixtures permit development before real capture |
| `2026-11-05-app-docs-content-media.md` | Release fact sheet, ten finished guides, verified videos/captures and onboarding acceptance | Editorial tasks start first; media wiring follows capture and inspector |

Start the content plan's release-fact task first, then navigation. Complete the capture contract before building the inspector. Each PR must build and test independently: publishable text-only pages are valid before media is ready; unsupported or unverified instructions stay off the public registry. Do not merge stubs or dead navigation links to represent the ten-page inventory. The capture package and recorder can land before any website route uses them. The inspector can be tested with labeled fixtures while remaining absent from public lesson manifests until real assets qualify.

## Shared implementation rules

- Use existing package managers, lockfile and workspace scripts. No new dependencies needed for replay or navigation; browser verification may use available browser tools. Keep test files under `apps/web/app/**/*.test.{ts,tsx}` because the current Vitest config only discovers that tree.
- Each code task follows write failing behavioral test, run it, implement the smallest change, rerun, inspect diff, commit. Commit only the task's named files. Prose edits receive factual/editorial review and link checks instead of prose-mirroring tests.
- Run website commands from the repository root with `pnpm --filter @b4run/web ...`. Install with `pnpm install --frozen-lockfile` in the implementation worktree. Build dependency packages before any command that reads their `dist/`. Do not share stale node_modules across incompatible branches.
- Refresh the B4 API-contract work already underway before recording. A newer protocol changes the normalizer's input mapping, not the requirement to preserve real app-observed semantics. Amend affected plans if ownership or wire shapes changed.
- Public release facts come from the released app and checked release artifacts. Do not turn README ambitions or fake runtime tests into user-facing compatibility claims.
- No model run is part of ordinary tests. Paid/live qualification is explicit and uses existing authorized credentials without printing them. If credentials, devices or released binaries are unavailable, complete independent work and report the exact unverified gate. Never substitute fixture output for a public real recording.

## Final validation and handoff

- [ ] Run the targeted behavioral checks named by each task; then the applicable repository-required checks. Website code changes require web test, typecheck, lint, build and relevant root CI gates. Use the actual branch's AGENTS.md and CI classifier; do not assume docs-only exemption covers TS/CSS changes.
- [ ] App changes: `swift build`, `swift test`, `swift format lint --strict --recursive Sources Tests Apps Package.swift`, and `Scripts/docs-index.sh --check`; record fixture and live results separately. Run macOS/iOS builds when shared app code changes. Do not change Hub contracts for this work.
- [ ] Recheck all existing framework URLs, `/docs` behavior, app pages, search, exports, canonical metadata and sitemap on the built site.
- [ ] Review responsive behavior, keyboard controls, source links and error fallbacks in a real browser. Inspect representative app/framework pages and the inspector at the specified widths and zoom.
- [ ] Record verification with exact revisions and remaining limitations. Update app milestones/compatibility only for actual app changes; allocate a decision number using `Scripts/docs-index.sh --next` when opening its PR, not now.
- [ ] Prepare scoped PRs. Do not merge or publish without the applicable session authorization. Publishing the real assets and site is a separate concrete handoff after verification.

## Success boundary

Ten usable production guides, preserved framework routes, and at least one real multi-turn Navlog capture with a readable interactive inspection path. Approval content uses a separately qualified real request/decision. No hosted inference, invented response, automatic user-session recording, or unrelated website rebrand is required.
