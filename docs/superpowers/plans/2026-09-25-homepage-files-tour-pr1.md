# Homepage Files Tour, PR 1 (Foundation + Tour) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Your first agent" section and the code-fixer walkthrough with a seven-stop folder tour of the scaffolded `src/app/hello/` agent. The tour pins on scroll at desktop sizes, and its tool stop embeds a type-to-schema playground that shows the schema the real extractor produces. The page becomes hero → tour → closing CTA.

**Architecture:** GSAP enters through one helper, `motion/gsap.ts` (`withMotion` over `gsap.matchMedia()`), that only client islands import. The playground's eight `greet.ts` variants are real tool files. `scripts/export-homepage-demos.mjs` runs `extractToolSchemasForRoute` from `@b4run/core/node` on each and records `schema-variants.json`, and a test re-runs the extraction and expects that file exactly. The tour's stops are data (`tour-stops.ts`), and each panel's text is a snapshot (`tour-sources.json`) pinned to the real file: the `app-basic` template for scaffolded stops, typechecked fixtures for added ones. `FolderTour` is a server component that renders every stop as a stacked card. `TourClient` is a leaf island that adds the chip bar's current marker and, at desktop sizes with motion on, the ScrollTrigger pin with the file tree as a tablist.

**Tech Stack:** Next.js 16 (app router, server components), React 19, CSS modules, GSAP 3.15.0 + ScrollTrigger, Vitest 4 (jsdom 30 + `renderToString`), Biome, `@b4run/core/node` (built).

**Spec:** `docs/superpowers/specs/2026-09-25-homepage-files-tour-design.md` (PR 1 in "Delivery").

**How this plan was checked:** every code block below was written into this worktree and run before the plan was committed, then removed. Lint, typecheck, the full `apps/web` suite (55 files, 878 tests), `scripts/check-docs.mjs`, and the Task 9 Playwright + axe script all passed. That run used GSAP 3.12.5, copied from another local checkout, because installing 3.15.0 would have changed this branch. Task 1 installs 3.15.0 for real.

## Risks / open questions

1. **GSAP's license is not OSI-approved.** `npm view gsap license` reports "Standard 'no charge' license: https://gsap.com/standard-license". Since the Webflow acquisition that license allows commercial use at no cost, but it isn't MIT. Brian should confirm it's acceptable for this repo before Task 1 lands.
2. **Only GSAP 3.12.5 was verified; 3.15.0 wasn't.** The `matchMedia`, `ScrollTrigger.create({ pin })`, `revert()` and `getTweensOf` behaviour the tests rely on is long-standing API. If a Task 1 or Task 5 test fails only after the install, read the 3.15 changelog before changing a test.
3. **The pinned stage must fit under the header.** Otherwise part of the current card sits below the fold while pinned. The plan pins only at `(min-width: 960px) and (min-height: 700px)` (a deviation, below). The verification run measured the stage fitting at 1024×768 and 1440×900. Task 9 re-measures it (`stageFits`).
4. **`apps/web` tests now import a built package.** `schema-variants.test.ts` loads `@b4run/core/node`, which resolves to `packages/core/dist/node.js`. CI's `source-validate` runs `pnpm build` before `pnpm test`, and turbo's `test` task depends on `build`, so both see it built. A fresh worktree must run `pnpm build` (or `pnpm turbo run build --filter=@b4run/core`) first. No `apps/web` test did this before; the old `first-agent-source` pin only read files.
5. **The takeaway keeps its two-column grid with one child.** The instructions say to remove only the code-fixer column, so `.takeaway { grid-template-columns: 1fr 1.15fr }` stays, and above 760px its right track is empty (see the Task 9 takeaway screenshot). The session fixing the 375px overflow owns that CSS. Expect a merge conflict in `homepage.module.css`, since this PR deletes most of that file.
6. **GSAP runs in both node and jsdom test files.** Vitest isolates each file by default, so a node-environment import of GSAP (`seo.test.ts` renders the page) can't leave GSAP initialized without a `window` for a later jsdom file. The full suite passed that way. If a jsdom test ever fails with `_win is undefined`, check that `isolate` is still on.
7. **The lockfile changes.** Adding `gsap`, `zod` and `@b4run/sdk` to `apps/web` updates `pnpm-lock.yaml`. Re-fetch main and re-run `pnpm install` just before merging (see memory: lockfile staleness trap).
8. **The planning fixture reads like a support agent.** The spec fixes `plan.md` to the docs' support-desk checklist ("Understand the customer request", …). It's accurate, but it reads oddly on a hello agent. It's a one-line swap later if Brian wants greeting-themed items.
9. **The site footer still links the code-fixer walkthrough.** `apps/web/app/components/Footer.tsx` points to `examples/code-fixer/server/WALKTHROUGH.md`, and `/blueprints/code-fixer.md` still ships. Both are outside the homepage and outside this spec, and this plan leaves them.

## Deviations from the spec, and why

- **Pin condition.** The tour pins at `(min-width: 960px) and (min-height: 700px)`, not ≥ 960px alone. A pinned card taller than the viewport would hide its own content.
- **No `scrub: 0.8`.** The tour has no scroll-linked tween to scrub. Stops change discretely from ScrollTrigger's `onUpdate`, with `snap` to each stop, and each change runs its own tweens: the 250ms marker slide and the 300ms `power2.out` fade with a 12px lift. The pin's length follows the spec (`end: "+=" + stops × 70vh`).
- **The pinned layout.** When pinned, each card uses CSS subgrid: the tree sits top-left, the current stop's copy sits under it, and its file sits on the right. This keeps the tallest stop (the playground) inside a 768px-tall viewport.
- **The cards stay `<article>`s, without `role="tabpanel"`.** axe reports `aria-allowed-role` for a tabpanel on `<article>`. Each tab's `aria-controls` names its card.
- **The flash colour.** Changed schema lines flash `--color-relay-tint` mixed into the panel (`color-mix(… 40%, var(--color-panel))`, settling at 14%). At full strength the tint sits under light panel text and fails contrast. Each changed line also gets a `+` in the gutter, so colour isn't the only signal.
- **How the schema is laid out.** The playground shows each recorded schema through `formatSchema`, which keeps scalar arrays and small scalar objects on one line so the JSON fits the panel. The values are exactly the extractor's; only the whitespace differs.
- **The eval stop's docs link** goes to `/docs/evals#your-scaffolded-app-already-has-an-eval`, not bare `/docs/evals`. Non-negotiable 1 asks for a page and an anchor.
- **Stops 3–6 are snapshotted too.** `tour-sources.json` holds all seven files' text, not just the three from the template, and one test pins each to its file on disk. The fixtures are still typechecked in place.
- **The SEO description changes.** It said "Watch an agent fix a real bug", which is false once the code-fixer is gone. `seo.test.ts` also required "workspaces", "sandboxes", "approval", "recorded" and "blueprint" to appear on the page. Task 7 updates both.
- **Explicit devDependencies.** `apps/web` gains `@b4run/sdk` (`workspace:*`) and `zod` (`4.4.3`, the root's pin). The fixtures do resolve both today, but only through the repository root's own devDependencies, so a root cleanup would silently break the web typecheck.

## Spec assumptions that are wrong in the code

- **`highlight.ts` can't simply stay.** It imports `evidence` for `prepareHomepage()` and `recordedDiff()`. Task 7 cuts it down to `highlightCode()`.
- **The page's SEO depends on the code-fixer.** `HOME_DESCRIPTION` (`app/seo/registry.ts`) and the snippet-terms test in `app/seo/seo.test.ts` both describe the code-fixer.
- **The eval's template file has a `.template` suffix.** It's `evals/smoke.eval.ts.template`; the scaffold drops the suffix. The tree shows `evals/smoke.eval.ts`, and the pin reads the `.template` file.
- **A tool without JSDoc gets an empty description, not a missing one.** The extractor emits `"description": ""`, and the live region says so.
- **Biome rewrites the variants' type literals.** A literal that fits in 100 columns goes onto one line, so six of the eight variants have a single-line input type and only the two `formal-language` variants are multi-line. The files are recorded as Biome formats them.
- **jsdom 30 implements neither `matchMedia` nor `IntersectionObserver`** (nor `scrollIntoView` or `window.scrollTo`). The tests stub them.
- **`site-chrome.test.tsx` pins three olive text uses.** Two of them (`.flowNumber` and the `::after` arrow) belong to the code-fixer, so the pin becomes 1.
- **`DeveloperHome` has to prepare the tour's data itself.** `renderToString` can't render async components, so `DeveloperHome` awaits `prepareFolderTour()` and passes the data to a synchronous `FolderTour`, as it did for `prepareFirstAgent()`.
- **Next's dev server (Turbopack) won't follow a symlinked package outside the repository root.** This only matters for ad-hoc verification.

**Rules that apply to every task** (from `AGENTS.md` and the website design system):
- Run commands from the repo root, on Node 24: `source ~/.nvm/nvm.sh && nvm use 24`.
- In `app/`:
  - no hex colours, and no `rgba()`, `hsl()` or named colours in CSS
  - `border-radius` only `0` or `50%`
  - the words `rounded` and `shadow-x` must not appear anywhere in source, including comments
  - all colours are `var(--color-*)` from `app/styles/tokens.css`
  - `app/styles/design-system.test.ts` enforces all of this.
- `exactOptionalPropertyTypes` is on: never write `{ x: undefined }`; use a conditional spread.
- Never run bare `biome check --write`. Use `pnpm --dir apps/web lint`, and for fixes the scoped `pnpm --dir apps/web exec biome check --write --config-path ../../packages/config-biome/biome.json --css-parse-tailwind-directives=true <paths>`.
- Import `gsap` only through `app/components/homepage/motion/gsap.ts`, and only from `"use client"` islands.
- Build first: `apps/web` tests load `@b4run/core/node` from `packages/core/dist`. If `packages/core/dist/node.js` is missing, run `pnpm build`.
- `next dev` writes `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` and can touch `apps/web/next-env.d.ts`. Never `git commit -a` or `git add -A`/`git add .`: stage explicit paths, and run `git status --short` before every commit.
- Never use `git stash`: the stash is shared with other worktrees.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File Structure

All paths are under `apps/web/app/components/homepage/` unless shown from the repo root.

| File | Responsibility |
|---|---|
| Modify `apps/web/package.json`, `pnpm-lock.yaml` | `gsap` 3.15.0 (dependency), and `@b4run/sdk` `workspace:*` plus `zod` 4.4.3 (devDependencies). |
| Create `motion/gsap.ts` | Re-exports `gsap` and `ScrollTrigger`; `REDUCE`/`FULL`/`DESKTOP` queries; `registerScrollTrigger()`; `withMotion()`. |
| Create `motion/media-stub.ts` | A controllable `window.matchMedia` for jsdom tests. |
| Create `motion/gsap.test.ts` | Reduce-branch final states with no tweens, branch swap on change, register once. |
| Create `playground/variants/<id>/tools/greet.ts` (8) | The real tool files: `base`, `nodoc`, `language`, `language-nodoc`, `formal`, `formal-nodoc`, `formal-language`, `formal-language-nodoc`. |
| Create `apps/web/scripts/export-homepage-demos.mjs` | Extracts each variant's schema with `@b4run/core/node` and writes `schema-variants.json` (schema part only in PR 1). |
| Create `playground/schema-variants.json` | Generated: `{ tool, variants: [{ id, formal, language, jsdoc, source, schema }] }`. |
| Create `playground/format-schema.ts` + test | Prints a JSON value compactly for the panel. |
| Create `playground/schema-variants.test.ts` | Re-runs the extraction and expects the JSON exactly; pins `base` to the template. |
| Create `playground/types.ts` | `PlaygroundVariant`. |
| Create `playground/schema-variants.ts` | Server-only: highlights each variant's source and schema. |
| Create `playground/SchemaPlayground.tsx` + `playground.module.css` + test | The island: three `aria-pressed` toggles, source and schema panes, diff marks, live region. |
| Create `tour/fixtures/hello/{plan.md,memory.ts,skills/greetings/SKILL.md,subagents/translator/index.ts}` | Stops 3–6, typechecked by `pnpm --dir apps/web typecheck`. |
| Create `tour/tour-stops.ts` | The seven stops. |
| Create `tour/tour-sources.json` + `tour/tour-sources.ts` | Each stop's file text, and `prepareTourCode()` (server-only). |
| Create `tour/tour-stops.test.ts` | Pins each text to its file; checks order, template origin, two sentences, docs anchors. |
| Create `tour/TourClient.tsx` + `tour/tour.module.css` + test | The island: chip bar marker (IntersectionObserver), tablist keys, pin, marker slide, fades, settle. |
| Create `tour/prepare.ts` | `prepareFolderTour()`. |
| Create `tour/FolderTour.tsx` + test | The server shell: every stop as a full card, at `id="first-agent"`. |
| Modify `DeveloperHome.tsx` | Tour instead of FirstAgent, Walkthrough, recording and Narrative; takeaway loses its code-fixer column. |
| Modify `highlight.ts`, `types.ts` | Drop the evidence-only code. |
| Modify `homepage.module.css` | Delete dead CSS (walkthrough, chapters, project overview, execution flow, `.markerDot`). |
| Modify `homepage.test.tsx` | Tests for the new page; code-fixer tests removed. |
| Delete | `Walkthrough.tsx`, `Narrative.tsx`, `ProjectOverview.tsx`, `FirstAgent.tsx`, `evidence.{json,ts,test.ts}`, `narrative-source.{json,ts,test.ts}`, `first-agent-source.{json,ts,test.ts}`, `apps/web/scripts/export-homepage-evidence.mjs`. |
| Modify `apps/web/app/seo/registry.ts`, `apps/web/app/seo/seo.test.ts` | New home description and snippet terms. |
| Modify `apps/web/app/site-chrome.test.tsx` | Olive text count 3 → 1. |
| Modify `apps/web/app/seo/lastmod.generated.json` | Regenerated; only the `/` entry changes (Task 9). |

---

### Task 1: GSAP and the motion helper

**Files:**
- Modify: `apps/web/package.json`, `pnpm-lock.yaml`
- Create: `apps/web/app/components/homepage/motion/gsap.ts`
- Create: `apps/web/app/components/homepage/motion/media-stub.ts`
- Test: `apps/web/app/components/homepage/motion/gsap.test.ts`

- [ ] **Step 1: Confirm the version and add the dependencies, pinned exactly**

Run: `npm view gsap version`
Expected: `3.15.0`. If npm now reports a newer version, stop and ask before pinning it: the tests were verified against the 3.x API.

```bash
pnpm --filter @b4run/web add --save-exact gsap@3.15.0
pnpm --filter @b4run/web add --save-dev --save-exact zod@4.4.3 "@b4run/sdk@workspace:*"
```

Expected `apps/web/package.json` changes (pnpm keeps keys sorted): `"gsap": "3.15.0"` under `dependencies`; `"@b4run/sdk": "workspace:*"` and `"zod": "4.4.3"` under `devDependencies`. No `^`.

Check the lockfile change stays inside `apps/web`'s importer and GSAP's own entries:

Run: `git diff --stat pnpm-lock.yaml && git diff pnpm-lock.yaml`
Expected: only additions. The `apps/web` importer gains `gsap` under `dependencies`, and `'@b4run/sdk'` (`link:../../packages/sdk`) and `zod` (`4.4.3`) under `devDependencies`, and `gsap@3.15.0` appears under `packages:` and `snapshots:`. If any other importer's resolved version moves, stop: run `git checkout pnpm-lock.yaml apps/web/package.json && pnpm install`, re-fetch main, and retry.

Run: `node -p "require('./apps/web/node_modules/gsap/package.json').version"`
Expected: `3.15.0`

- [ ] **Step 2: Write the failing test**

Create `apps/web/app/components/homepage/motion/gsap.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { FULL, gsap, type MotionConditions, REDUCE, withMotion } from "./gsap"
import { type MediaStub, stubMatchMedia } from "./media-stub"

let media: MediaStub | undefined
afterEach(() => {
  media?.restore()
  media = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const box = () => {
  const element = document.createElement("div")
  document.body.append(element)
  return element
}
/** Tweens that take time; `gsap.set` is instant and does not count. */
const moving = (element: Element) =>
  gsap.getTweensOf(element).filter((tween) => tween.duration() > 0)

it("under reduced motion runs only the reduce branch: final state, no tweens", () => {
  media = stubMatchMedia({ [REDUCE]: true, [FULL]: false })
  const element = box()
  const full = vi.fn(() => undefined)
  const stop = withMotion(element, {
    reduce: () => {
      gsap.set(element, { opacity: 0.5 })
    },
    full,
  })
  expect(full).not.toHaveBeenCalled()
  expect(element.style.opacity).toBe("0.5")
  expect(moving(element)).toEqual([])
  stop()
  // The cleanup reverts what the branch did.
  expect(element.style.opacity).toBe("")
})

it("with motion on runs the full branch, and swaps branches when the preference changes", async () => {
  media = stubMatchMedia({ [REDUCE]: false, [FULL]: true, "(min-width: 960px)": true })
  const element = box()
  const cleanup = vi.fn()
  const seen: MotionConditions[] = []
  const stop = withMotion(
    element,
    {
      reduce: (conditions) => {
        seen.push(conditions)
        gsap.set(element, { opacity: 1 })
      },
      full: (conditions) => {
        seen.push(conditions)
        gsap.to(element, { opacity: 0.2, duration: 1 })
        return cleanup
      },
    },
    { wide: "(min-width: 960px)" },
  )
  expect(seen).toEqual([{ wide: true, reduce: false, full: true }])
  expect(moving(element)).toHaveLength(1)

  await media.change({ [REDUCE]: true, [FULL]: false })
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(moving(element)).toEqual([])
  expect(seen.at(-1)).toEqual({ wide: true, reduce: true, full: false })
  expect(element.style.opacity).toBe("1")
  stop()
})

it("registers ScrollTrigger once, however many islands start", async () => {
  media = stubMatchMedia({ [REDUCE]: true, [FULL]: false })
  vi.resetModules()
  const fresh = await import("./gsap")
  const register = vi.spyOn(fresh.gsap, "registerPlugin")
  const setup = { reduce: () => undefined, full: () => undefined }
  fresh.withMotion(box(), setup)()
  fresh.withMotion(box(), setup)()
  expect(register).toHaveBeenCalledTimes(1)
  expect(register).toHaveBeenCalledWith(fresh.ScrollTrigger)
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/motion/gsap.test.ts`
Expected: FAIL; `./gsap` and `./media-stub` cannot be resolved.

- [ ] **Step 4: Write the matchMedia stub**

jsdom 30 has no `window.matchMedia`, and GSAP's `matchMedia()` calls it. Create `apps/web/app/components/homepage/motion/media-stub.ts`:

```ts
/**
 * A controllable `window.matchMedia` for tests. jsdom has none, and GSAP's
 * `matchMedia()` needs one. Not used by the site.
 */
export interface MediaStub {
  /** Sets which queries match, then notifies listeners the way a browser does. */
  change(next: Readonly<Record<string, boolean>>): Promise<void>
  restore(): void
}

type Listener = () => void

export function stubMatchMedia(initial: Readonly<Record<string, boolean>>): MediaStub {
  const matching = new Map(Object.entries(initial))
  const listeners = new Set<Listener>()
  const previous = Object.getOwnPropertyDescriptor(window, "matchMedia")
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query,
      get matches() {
        return matching.get(query) ?? false
      },
      onchange: null,
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      dispatchEvent: () => false,
    }),
  })
  return {
    async change(next) {
      // GSAP ignores media changes that arrive within 2ms of the last one.
      await new Promise((resolve) => setTimeout(resolve, 5))
      for (const [query, matches] of Object.entries(next)) matching.set(query, matches)
      for (const listener of [...listeners]) listener()
    },
    restore() {
      if (previous) Object.defineProperty(window, "matchMedia", previous)
      else Reflect.deleteProperty(window, "matchMedia")
    },
  }
}
```

- [ ] **Step 5: Write the helper**

Create `apps/web/app/components/homepage/motion/gsap.ts`. `withMotion` is GSAP's React cleanup pattern without `@gsap/react`: a `gsap.matchMedia()` context reverts every tween and ScrollTrigger a branch created, and the effect returns `media.revert`.

```ts
import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"

/**
 * GSAP for the homepage demos. Import it only from `"use client"` islands under
 * `homepage/`; server components never touch it.
 */
export { gsap, ScrollTrigger }

/** The visitor asked for less motion: show final states at once. */
export const REDUCE = "(prefers-reduced-motion: reduce)"
/** Motion is fine. */
export const FULL = "(prefers-reduced-motion: no-preference)"
/**
 * Where the folder tour pins: wide enough for the tree beside the panel, and
 * tall enough that the tallest stop fits under the header.
 */
export const DESKTOP = "(min-width: 960px) and (min-height: 700px)"

/** Which named queries match, keyed as they were passed to `withMotion`. */
export type MotionConditions = Readonly<Record<string, boolean>>
export type MotionCleanup = () => void

export interface MotionSetup {
  /** Reduced motion: put everything in its final state; start no tweens. */
  readonly reduce: (conditions: MotionConditions) => MotionCleanup | undefined
  /** Motion allowed. */
  readonly full: (conditions: MotionConditions) => MotionCleanup | undefined
}

let registered = false

/** Registers ScrollTrigger once, and only in a browser. Returns whether it can run. */
export function registerScrollTrigger(): boolean {
  if (typeof window === "undefined") return false
  if (!registered) {
    gsap.registerPlugin(ScrollTrigger)
    registered = true
  }
  return true
}

/**
 * Runs `setup.reduce` or `setup.full` for the visitor's motion preference, inside
 * a `gsap.matchMedia()` scoped to `scope`, and runs it again whenever the
 * preference or one of `queries` changes. Tweens and ScrollTriggers a branch
 * creates synchronously are reverted on each change and by the returned
 * cleanup, which a React effect returns.
 */
export function withMotion(
  scope: Element,
  setup: MotionSetup,
  queries: Readonly<Record<string, string>> = {},
): MotionCleanup {
  if (!registerScrollTrigger()) return () => undefined
  const media = gsap.matchMedia(scope)
  media.add({ ...queries, reduce: REDUCE, full: FULL }, (context) => {
    // gsap updates this object in place on every change; hand out a snapshot.
    const conditions: MotionConditions = { ...context.conditions }
    return conditions.reduce ? setup.reduce(conditions) : setup.full(conditions)
  })
  return () => media.revert()
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/motion/gsap.test.ts`
Expected: PASS (3 tests).

Run: `pnpm --dir apps/web typecheck`
Expected: exit 0. That proves `gsap/ScrollTrigger` resolves its types through GSAP's ambient module declarations.

- [ ] **Step 7: Commit**

```bash
git status --short
git add apps/web/package.json pnpm-lock.yaml apps/web/app/components/homepage/motion/gsap.ts apps/web/app/components/homepage/motion/media-stub.ts apps/web/app/components/homepage/motion/gsap.test.ts
git commit -m "feat(web): gsap and a reduced-motion-aware helper for the homepage demos

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The playground's variants and their recorded schemas

**Files:**
- Create: `apps/web/app/components/homepage/playground/variants/{base,nodoc,language,language-nodoc,formal,formal-nodoc,formal-language,formal-language-nodoc}/tools/greet.ts`
- Create: `apps/web/scripts/export-homepage-demos.mjs`
- Create: `apps/web/app/components/homepage/playground/format-schema.ts`
- Create (generated): `apps/web/app/components/homepage/playground/schema-variants.json`
- Test: `apps/web/app/components/homepage/playground/format-schema.test.ts`
- Test: `apps/web/app/components/homepage/playground/schema-variants.test.ts`

**Why the variants live here, and how the test calls the extractor.**

- **Where the variants live.** Each variant is its own route folder (`variants/<id>/tools/greet.ts`), because the extractor names a tool after its file; that keeps the name `greet` in all eight.
- **Lint and typecheck.** They sit under `apps/web/app`, so `pnpm --dir apps/web typecheck` (tsconfig `include: ["**/*.ts"]`) and lint cover them. They have no imports, so both pass.
- **Next.js.** Next only treats `page`, `layout`, `route` and similar filenames as routes, so these files aren't pages.
- **How the test calls the extractor.** The test imports `extractSchemaVariants` from the export script, which calls `extractToolSchemasForRoute` from `@b4run/core/node`. That resolves through `apps/web/node_modules/@b4run/core` (a workspace devDependency) to `packages/core/dist/node.js`. So the test needs a built core; see "Rules" above.
- **Why this route.** This follows the existing pattern of a test importing a script (`app/seo/generate-lastmod.test.ts` imports `scripts/generate-seo-lastmod.mjs`), and it means the test and the script can never disagree.
- **Compiler options.** The extractor runs with `packages/config-typescript/node.json`, the options a scaffolded app extends (`@b4run/config-typescript/node`). Without it, the extractor would find `apps/web/tsconfig.json`, which is Next's config, not a B4 app's. Eight extractions take about 2s, hence the test's 60s timeout.

- [ ] **Step 1: Write the variant files**

Each file is exactly as Biome formats it. (Biome keeps a type literal on one line when it fits in 100 columns, so only the `formal-language` variants are multi-line.)

`apps/web/app/components/homepage/playground/variants/base/tools/greet.ts` (byte-identical to `packages/devkit/templates/app-basic/src/app/hello/tools/greet.ts`):

```ts
/** Greet someone by name. */
export default async (input: { readonly name: string }) => {
  return { message: `Hello, ${input.name}!` }
}
```

`apps/web/app/components/homepage/playground/variants/nodoc/tools/greet.ts`:

```ts
export default async (input: { readonly name: string }) => {
  return { message: `Hello, ${input.name}!` }
}
```

`apps/web/app/components/homepage/playground/variants/language/tools/greet.ts`:

```ts
/** Greet someone by name. */
export default async (input: { readonly name: string; readonly language: "en" | "es" }) => {
  return { message: `Hello, ${input.name}!` }
}
```

`apps/web/app/components/homepage/playground/variants/language-nodoc/tools/greet.ts`:

```ts
export default async (input: { readonly name: string; readonly language: "en" | "es" }) => {
  return { message: `Hello, ${input.name}!` }
}
```

`apps/web/app/components/homepage/playground/variants/formal/tools/greet.ts`:

```ts
/** Greet someone by name. */
export default async (input: { readonly name: string; readonly formal?: boolean }) => {
  return { message: `Hello, ${input.name}!` }
}
```

`apps/web/app/components/homepage/playground/variants/formal-nodoc/tools/greet.ts`:

```ts
export default async (input: { readonly name: string; readonly formal?: boolean }) => {
  return { message: `Hello, ${input.name}!` }
}
```

`apps/web/app/components/homepage/playground/variants/formal-language/tools/greet.ts`:

```ts
/** Greet someone by name. */
export default async (input: {
  readonly name: string
  readonly formal?: boolean
  readonly language: "en" | "es"
}) => {
  return { message: `Hello, ${input.name}!` }
}
```

`apps/web/app/components/homepage/playground/variants/formal-language-nodoc/tools/greet.ts`:

```ts
export default async (input: {
  readonly name: string
  readonly formal?: boolean
  readonly language: "en" | "es"
}) => {
  return { message: `Hello, ${input.name}!` }
}
```

Run: `diff apps/web/app/components/homepage/playground/variants/base/tools/greet.ts packages/devkit/templates/app-basic/src/app/hello/tools/greet.ts && pnpm exec biome check --config-path packages/config-biome/biome.json apps/web/app/components/homepage/playground/variants`
Expected: no diff output, then `Checked 8 files … No fixes applied.`

- [ ] **Step 2: Write the failing tests**

Create `apps/web/app/components/homepage/playground/format-schema.test.ts`:

```ts
import { expect, it } from "vitest"
import { formatSchema } from "./format-schema"

it("keeps scalar arrays and small scalar objects on one line", () => {
  expect(
    formatSchema({
      name: "greet",
      description: "Greet someone by name.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          formal: { type: "boolean" },
          language: { type: "string", enum: ["en", "es"] },
        },
        required: ["name", "language"],
        additionalProperties: false,
      },
    }),
  ).toEqual([
    "{",
    '  "name": "greet",',
    '  "description": "Greet someone by name.",',
    '  "parameters": {',
    '    "type": "object",',
    '    "properties": {',
    '      "name": { "type": "string" },',
    '      "formal": { "type": "boolean" },',
    '      "language": { "type": "string", "enum": ["en", "es"] }',
    "    },",
    '    "required": ["name", "language"],',
    '    "additionalProperties": false',
    "  }",
    "}",
  ])
})

it("breaks a scalar object that does not fit the width", () => {
  expect(formatSchema({ a: "x".repeat(40), b: "y".repeat(40) }, 64)).toEqual([
    "{",
    `  "a": "${"x".repeat(40)}",`,
    `  "b": "${"y".repeat(40)}"`,
    "}",
  ])
})

it("prints what it is given and nothing else", () => {
  expect(formatSchema([])).toEqual(["[]"])
  expect(formatSchema({})).toEqual(["{}"])
  expect(() => formatSchema({ run: () => 1 })).toThrow("Not a JSON value: function")
})
```

Create `apps/web/app/components/homepage/playground/schema-variants.test.ts`:

```ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  extractSchemaVariants,
  schemaVariantsFile,
  variantCombinations,
  variantId,
} from "../../../../scripts/export-homepage-demos.mjs"

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url))
const recorded = JSON.parse(readFileSync(schemaVariantsFile, "utf8"))

interface RecordedVariant {
  readonly id: string
  readonly formal: boolean
  readonly language: boolean
  readonly jsdoc: boolean
  readonly source: string
  readonly schema: {
    readonly description: string
    readonly parameters: {
      readonly properties: Record<string, unknown>
      readonly required: readonly string[]
    }
  }
}
const variants: readonly RecordedVariant[] = recorded.variants

describe("the type-to-schema playground shows what the framework extracts", () => {
  it("records every combination of the three toggles once", () => {
    expect(variants.map((variant) => variant.id)).toEqual(variantCombinations().map(variantId))
    expect(new Set(variants.map((variant) => variant.id)).size).toBe(8)
  })

  it("starts from the scaffold's own greet tool", () => {
    const template = resolve(
      repoRoot,
      "packages/devkit/templates/app-basic/src/app/hello/tools/greet.ts",
    )
    expect(variants.find((variant) => variant.id === "base")?.source).toBe(
      readFileSync(template, "utf8"),
    )
  })

  it("changes only what each toggle says it changes", () => {
    for (const { id, formal, language, jsdoc, schema } of variants) {
      expect(Object.keys(schema.parameters.properties), id).toEqual([
        "name",
        ...(formal ? ["formal"] : []),
        ...(language ? ["language"] : []),
      ])
      expect(schema.parameters.required, id).toEqual(["name", ...(language ? ["language"] : [])])
      expect(schema.description, id).toBe(jsdoc ? "Greet someone by name." : "")
    }
  })

  it("reproduces schema-variants.json exactly when the extraction runs again", async () => {
    expect(await extractSchemaVariants()).toEqual(recorded)
  }, 60_000)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/playground/`
Expected: FAIL; `./format-schema` and `../../../../scripts/export-homepage-demos.mjs` cannot be resolved.

- [ ] **Step 4: Write the formatter**

Create `apps/web/app/components/homepage/playground/format-schema.ts`:

```ts
type Scalar = null | boolean | number | string

const isScalar = (value: unknown): value is Scalar =>
  value === null || ["boolean", "number", "string"].includes(typeof value)
const isFlat = (value: unknown): boolean =>
  isScalar(value) || (Array.isArray(value) && value.every(isScalar))

function inline(value: unknown): string {
  if (isScalar(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return "{}"
    return `{ ${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${inline(entry)}`).join(", ")} }`
  }
  throw new TypeError(`Not a JSON value: ${typeof value}`)
}

/**
 * Prints a JSON value the way the playground shows it: two-space indents, with
 * arrays of scalars, and objects of scalars that fit in `width`, kept on one
 * line. The values are the extractor's; only the layout is ours, so the schema
 * fits the panel.
 */
export function formatSchema(value: unknown, width = 64): string[] {
  const print = (node: unknown, indent: string, prefix: string, suffix: string): string[] => {
    const oneLine = `${indent}${prefix}${inline(node)}${suffix}`
    const flatObject =
      typeof node === "object" &&
      node !== null &&
      !Array.isArray(node) &&
      Object.values(node).every(isFlat)
    if (isFlat(node) || (flatObject && oneLine.length <= width)) return [oneLine]
    const inner = `${indent}  `
    if (Array.isArray(node)) {
      return [
        `${indent}${prefix}[`,
        ...node.flatMap((item, index) =>
          print(item, inner, "", index < node.length - 1 ? "," : ""),
        ),
        `${indent}]${suffix}`,
      ]
    }
    const entries = Object.entries(node as Record<string, unknown>)
    return [
      `${indent}${prefix}{`,
      ...entries.flatMap(([key, entry], index) =>
        print(entry, inner, `${JSON.stringify(key)}: `, index < entries.length - 1 ? "," : ""),
      ),
      `${indent}}${suffix}`,
    ]
  }
  return print(value, "", "", "")
}
```

- [ ] **Step 5: Write the export script (schema part)**

Create `apps/web/scripts/export-homepage-demos.mjs`. PR 3 adds `--record-tests` to it.

```js
// Regenerates the data behind the homepage demos from the real framework.
//
//   pnpm build   # @b4run/core resolves to its built dist/
//   node apps/web/scripts/export-homepage-demos.mjs
//
// Schema variants: runs @b4run/core's tool-schema extractor, the one `b4
// typegen` uses, on each playground variant of the scaffold's greet tool, and
// writes app/components/homepage/playground/schema-variants.json. The
// playground test runs the same extraction and expects this file exactly.
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { extractToolSchemasForRoute } from "@b4run/core/node"

const scriptFile = realpathSync(fileURLToPath(import.meta.url))
const webRoot = resolve(dirname(scriptFile), "..")
const repoRoot = resolve(webRoot, "..", "..")
export const playgroundRoot = join(webRoot, "app", "components", "homepage", "playground")
export const schemaVariantsFile = join(playgroundRoot, "schema-variants.json")
// The compiler options a scaffolded app extends (@b4run/config-typescript/node).
const toolTsconfig = join(repoRoot, "packages", "config-typescript", "node.json")

/** `base` is the scaffold's own greet.ts; each flag names one change from it. */
export function variantId({ formal, language, jsdoc }) {
  const flags = [formal && "formal", language && "language", !jsdoc && "nodoc"].filter(Boolean)
  return flags.length === 0 ? "base" : flags.join("-")
}

/** Every combination of the playground's three toggles, in a fixed order. */
export function variantCombinations() {
  const combinations = []
  for (const formal of [false, true]) {
    for (const language of [false, true]) {
      for (const jsdoc of [true, false]) combinations.push({ formal, language, jsdoc })
    }
  }
  return combinations
}

export async function extractSchemaVariants() {
  const variants = []
  for (const flags of variantCombinations()) {
    const id = variantId(flags)
    // Each variant is its own route folder, so the tool is named greet in all of them.
    const routeDir = join(playgroundRoot, "variants", id)
    const schemas = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
      tsconfig: toolTsconfig,
    })
    if (schemas.length !== 1 || schemas[0]?.name !== "greet") {
      throw new Error(`Expected exactly one greet tool in ${routeDir}`)
    }
    const source = readFileSync(join(routeDir, "tools", "greet.ts"), "utf8")
    variants.push({ id, ...flags, source, schema: schemas[0] })
  }
  return { tool: "greet", variants }
}

function isDirectExecution(invokedPath, modulePath) {
  return (
    invokedPath !== undefined && realpathSync(resolve(invokedPath)) === realpathSync(modulePath)
  )
}

if (isDirectExecution(process.argv[1], scriptFile)) {
  const data = await extractSchemaVariants()
  writeFileSync(schemaVariantsFile, `${JSON.stringify(data, null, 2)}\n`)
  // Write it in the repository's JSON style, so lint passes on the committed file.
  execFileSync(
    "pnpm",
    [
      "exec",
      "biome",
      "format",
      "--write",
      "--config-path",
      join(repoRoot, "packages", "config-biome", "biome.json"),
      schemaVariantsFile,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  )
  console.log(`Wrote ${data.variants.length} schema variants to ${schemaVariantsFile}`)
}
```

- [ ] **Step 6: Generate the recorded schemas**

Run: `ls packages/core/dist/node.js || pnpm build`
Then: `node apps/web/scripts/export-homepage-demos.mjs`
Expected, last lines:

```text
Formatted 1 file in …ms. Fixed 1 file.
Wrote 8 schema variants to …/apps/web/app/components/homepage/playground/schema-variants.json
```

Spot-check: `node -e 'const d=require("./apps/web/app/components/homepage/playground/schema-variants.json");for(const v of d.variants)console.log(v.id, JSON.stringify(v.schema.parameters.required), JSON.stringify(v.schema.description))'`
Expected:

```text
base ["name"] "Greet someone by name."
nodoc ["name"] ""
language ["name","language"] "Greet someone by name."
language-nodoc ["name","language"] ""
formal ["name"] "Greet someone by name."
formal-nodoc ["name"] ""
formal-language ["name","language"] "Greet someone by name."
formal-language-nodoc ["name","language"] ""
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/playground/`
Expected: PASS (7 tests). If "reproduces schema-variants.json exactly" fails, re-run the script and look at `git diff`; never edit the JSON by hand.

Run: `pnpm --dir apps/web lint && pnpm --dir apps/web typecheck`
Expected: exit 0 for both.

- [ ] **Step 8: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/playground/variants apps/web/app/components/homepage/playground/format-schema.ts apps/web/app/components/homepage/playground/format-schema.test.ts apps/web/app/components/homepage/playground/schema-variants.json apps/web/app/components/homepage/playground/schema-variants.test.ts apps/web/scripts/export-homepage-demos.mjs
git commit -m "feat(web): record the schemas the extractor derives from eight greet.ts variants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The SchemaPlayground island

**Files:**
- Create: `apps/web/app/components/homepage/playground/types.ts`
- Create: `apps/web/app/components/homepage/playground/schema-variants.ts`
- Create: `apps/web/app/components/homepage/playground/SchemaPlayground.tsx`
- Create: `apps/web/app/components/homepage/playground/playground.module.css`
- Test: `apps/web/app/components/homepage/playground/SchemaPlayground.test.tsx`

**How server data reaches the island** (the same way `CodePanel` gets it): the server highlights each variant with `highlightCode()` and passes plain, serialisable props (`sourceLines`/`schemaLines` as HTML strings). The island renders them with `dangerouslySetInnerHTML` under the same Biome suppression `CodePanel` uses.

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/homepage/playground/SchemaPlayground.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it } from "vitest"
import { SchemaPlayground } from "./SchemaPlayground"
import { preparePlayground } from "./schema-variants"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
})

const variants = await preparePlayground()

async function mount() {
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () => root?.render(<SchemaPlayground variants={variants} />))
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label))
  return {
    press: (label: string) => act(async () => button(label)?.click()),
    pressed: () =>
      [...container.querySelectorAll("button")].map((node) => node.getAttribute("aria-pressed")),
    source: () => container.querySelector('[aria-label="greet.ts source"] pre')?.textContent ?? "",
    schema: () =>
      container.querySelector('[aria-label="What the model sees"] pre')?.textContent ?? "",
    changed: () =>
      [...container.querySelectorAll('[data-changed="true"]')].map((line) =>
        (line.textContent ?? "").replace(/^\+/, "").trim(),
      ),
    live: () => container.querySelector('[aria-live="polite"]')?.textContent,
  }
}

it("starts on the scaffold's greet.ts, with nothing announced or marked", async () => {
  const view = await mount()
  expect(view.pressed()).toEqual(["false", "false", "true"])
  expect(view.source()).toContain("/** Greet someone by name. */")
  expect(view.schema()).toContain('"required": ["name"]')
  expect(view.changed()).toEqual([])
  expect(view.live()).toBe("")
})

it("re-derives the schema as each toggle flips, marks the changed lines and says why", async () => {
  const view = await mount()

  await view.press("language")
  expect(view.pressed()).toEqual(["false", "true", "true"])
  expect(view.source()).toContain('readonly language: "en" | "es"')
  expect(view.changed()).toEqual([
    '"language": { "type": "string", "enum": ["en", "es"] }',
    '"required": ["name", "language"],',
  ])
  expect(view.live()).toBe("Required: name, language. Description: Greet someone by name.")

  await view.press("JSDoc")
  expect(view.pressed()).toEqual(["false", "true", "false"])
  expect(view.source()).not.toContain("/**")
  expect(view.changed()).toEqual(['"description": "",'])
  expect(view.live()).toBe(
    "Required: name, language. No description, so the model sees only the name greet.",
  )

  await view.press("formal")
  expect(view.pressed()).toEqual(["true", "true", "false"])
  expect(view.changed()).toEqual(['"formal": { "type": "boolean" },'])
  // An optional field never becomes required.
  expect(view.schema()).toContain('"required": ["name", "language"]')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/playground/SchemaPlayground.test.tsx`
Expected: FAIL; `./SchemaPlayground` and `./schema-variants` cannot be resolved.

- [ ] **Step 3: Write the types and the server preparation**

Create `apps/web/app/components/homepage/playground/types.ts`:

```ts
/** One recorded greet.ts variant, prepared for the playground island. */
export interface PlaygroundVariant {
  readonly id: string
  readonly formal: boolean
  readonly language: boolean
  readonly jsdoc: boolean
  /** From the extracted schema. */
  readonly required: readonly string[]
  /** From the extracted schema; empty when the tool has no JSDoc. */
  readonly description: string
  /** Highlighted HTML, one entry per source line (highlightCode). */
  readonly sourceLines: readonly string[]
  /** Highlighted HTML, one entry per schema line. */
  readonly schemaLines: readonly string[]
  /** The schema as displayed, one entry per line; the diff compares these. */
  readonly schemaText: readonly string[]
}
```

Create `apps/web/app/components/homepage/playground/schema-variants.ts`:

```ts
import "server-only"
import { highlightCode } from "../highlight"
import { formatSchema } from "./format-schema"
import data from "./schema-variants.json"
import type { PlaygroundVariant } from "./types"

/** The playground's eight greet.ts variants, highlighted, as export-homepage-demos.mjs recorded them. */
export async function preparePlayground(): Promise<readonly PlaygroundVariant[]> {
  return Promise.all(
    data.variants.map(async (variant) => {
      const schemaText = formatSchema(variant.schema)
      const [source, schema] = await Promise.all([
        highlightCode(variant.source, "typescript", "src/app/hello/tools/greet.ts", ""),
        highlightCode(schemaText.join("\n"), "json", "What the model sees", ""),
      ])
      return {
        id: variant.id,
        formal: variant.formal,
        language: variant.language,
        jsdoc: variant.jsdoc,
        required: variant.schema.parameters.required,
        description: variant.schema.description,
        sourceLines: source.lines,
        schemaLines: schema.lines,
        schemaText,
      }
    }),
  )
}
```

- [ ] **Step 4: Write the island**

Create `apps/web/app/components/homepage/playground/SchemaPlayground.tsx`. The toggles sit in a `<fieldset>` because Biome's `useSemanticElements` rejects `role="group"` on a `<div>` (the old `Walkthrough` did the same). A changed line is compared without its trailing comma, so adding a property doesn't mark the unchanged line above it.

```tsx
"use client"
import { useState } from "react"
import styles from "./playground.module.css"
import type { PlaygroundVariant } from "./types"

type Flag = "formal" | "language" | "jsdoc"
type Flags = Readonly<Record<Flag, boolean>>

const TOGGLES: readonly { readonly flag: Flag; readonly label: string }[] = [
  { flag: "formal", label: "formal?: boolean" },
  { flag: "language", label: 'language: "en" | "es"' },
  { flag: "jsdoc", label: "JSDoc" },
]

const pick = (variants: readonly PlaygroundVariant[], flags: Flags) =>
  variants.find(
    (variant) =>
      variant.formal === flags.formal &&
      variant.language === flags.language &&
      variant.jsdoc === flags.jsdoc,
  )

/** A new sibling adds a trailing comma to the line above it; that is not a change. */
const bare = (line: string) => line.replace(/,$/, "")

/** What the live region says after a toggle. */
export function describeVariant(variant: PlaygroundVariant): string {
  const description = variant.description
    ? `Description: ${variant.description}`
    : "No description, so the model sees only the name greet."
  return `Required: ${variant.required.join(", ")}. ${description}`
}

/**
 * The tool stop's demo: toggle greet.ts's input type and JSDoc, and see the
 * schema the framework extracts for each of the eight recorded variants.
 */
export function SchemaPlayground({
  variants,
}: {
  readonly variants: readonly PlaygroundVariant[]
}) {
  const [flags, setFlags] = useState<Flags>({ formal: false, language: false, jsdoc: true })
  const [before, setBefore] = useState<readonly string[] | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const variant = pick(variants, flags)
  if (!variant) return null
  const previous = before === null ? null : new Set(before.map(bare))

  function toggle(flag: Flag) {
    const next = { ...flags, [flag]: !flags[flag] }
    const target = pick(variants, next)
    if (!variant || !target) return
    setBefore(variant.schemaText)
    setFlags(next)
    setAnnouncement(describeVariant(target))
  }

  return (
    <div className={styles.playground}>
      <fieldset className={styles.toggles} aria-label="Change greet.ts">
        {TOGGLES.map(({ flag, label }) => (
          <button
            key={flag}
            type="button"
            className={styles.toggle}
            aria-pressed={flags[flag]}
            onClick={() => toggle(flag)}
          >
            <span className={styles.box} aria-hidden="true">
              {flags[flag] ? "■" : "□"}
            </span>
            <code>{label}</code>
          </button>
        ))}
      </fieldset>
      <div className={styles.panes}>
        <section className={styles.pane} aria-label="greet.ts source">
          <p className={styles.paneLabel}>src/app/hello/tools/greet.ts</p>
          <pre className={styles.code}>
            <code>
              {variant.sourceLines.map((html, index) => {
                const lineKey = `${variant.id}:source:${index}`
                return (
                  <span key={lineKey} className={styles.line}>
                    {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Only server-produced Shiki tokens; highlightCode escapes all source text. */}
                    <span dangerouslySetInnerHTML={{ __html: html }} />
                  </span>
                )
              })}
            </code>
          </pre>
        </section>
        <section className={styles.pane} aria-label="What the model sees">
          <p className={styles.paneLabel}>What the model sees</p>
          <pre className={styles.code}>
            <code>
              {variant.schemaLines.map((html, index) => {
                const lineKey = `${variant.id}:schema:${index}`
                const changed =
                  previous !== null && !previous.has(bare(variant.schemaText[index] ?? ""))
                return (
                  <span key={lineKey} className={styles.line} data-changed={changed}>
                    <span className={styles.gutter} aria-hidden="true">
                      {changed ? "+" : " "}
                    </span>
                    {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Only server-produced Shiki tokens; highlightCode escapes all source text. */}
                    <span dangerouslySetInnerHTML={{ __html: html }} />
                  </span>
                )
              })}
            </code>
          </pre>
        </section>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
```

- [ ] **Step 5: Write the styles**

Create `apps/web/app/components/homepage/playground/playground.module.css`:

```css
/* The type-to-schema playground (the folder tour's tool stop). Dark-panel
   tokens only (tokens.css). */
.playground {
  /* The global focus ring is tuned for paper; on the panel it uses the accent. */
  --color-focus: var(--color-panel-accent);
  container-type: inline-size;
  background: var(--color-panel);
  color: var(--color-panel-ink);
}
.toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-inline-size: 0;
  margin: 0;
  padding: 12px 16px;
  border: 0;
  border-bottom: 1px solid var(--color-panel-rule);
  background: var(--color-panel-strip);
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--color-panel-rule);
  background: transparent;
  color: var(--color-panel-muted);
  font:
    12px / 1.4 var(--font-mono),
    monospace;
  cursor: pointer;
}
.toggle code {
  font: inherit;
}
.toggle[aria-pressed="true"] {
  border-color: var(--color-panel-accent);
  color: var(--color-panel-ink);
}
.box {
  color: var(--color-panel-accent);
}
.panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}
.pane {
  min-width: 0;
}
.pane + .pane {
  border-top: 1px solid var(--color-panel-rule);
}
.paneLabel {
  margin: 0;
  padding: 12px 16px 0;
  font:
    11px / 1.6 var(--font-mono),
    monospace;
  color: var(--color-panel-muted);
}
.code {
  margin: 0;
  padding: 8px 16px 16px;
  font:
    12px / 1.7 var(--font-mono),
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
  background: transparent;
  color: var(--color-panel-ink);
}
.code code {
  font: inherit;
}
.line {
  display: block;
}
.gutter {
  display: inline-block;
  width: 2ch;
  color: var(--color-panel-accent);
}
/* A changed line keeps a faint tint (and its + in the gutter) until the next
   toggle. Full-strength relay-tint under light panel text would be unreadable,
   so the tint is mixed into the panel. */
.line[data-changed="true"] {
  background-color: color-mix(in srgb, var(--color-relay-tint) 14%, var(--color-panel));
}
/* Source left, schema right, once the schema's longest line fits unwrapped. */
@container (min-width: 820px) {
  .panes {
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  }
  .pane + .pane {
    border-top: 0;
    border-left: 1px solid var(--color-panel-rule);
  }
}
/* The flash: colour only, 600ms. Reduced motion keeps the static tint. */
@media (prefers-reduced-motion: no-preference) {
  .line[data-changed="true"] {
    animation: schema-flash 600ms ease-out;
  }
}
@keyframes schema-flash {
  from {
    background-color: color-mix(in srgb, var(--color-relay-tint) 40%, var(--color-panel));
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/playground/ app/styles/design-system.test.ts`
Expected: PASS, including the design-system guard (`color-mix(` isn't banned; the guard bans `rgba(`, `hsl(`, `oklch(` and named colours).

Run: `pnpm --dir apps/web lint && pnpm --dir apps/web typecheck`
Expected: exit 0. If Biome reorders imports, apply the scoped fix from "Rules". Biome orders `./SchemaPlayground` before `./schema-variants`.

- [ ] **Step 7: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/playground/types.ts apps/web/app/components/homepage/playground/schema-variants.ts apps/web/app/components/homepage/playground/SchemaPlayground.tsx apps/web/app/components/homepage/playground/playground.module.css apps/web/app/components/homepage/playground/SchemaPlayground.test.tsx
git commit -m "feat(web): a playground that shows greet.ts's schema change as its type changes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The tour's stops, fixtures and pins

**Files:**
- Create: `apps/web/app/components/homepage/tour/fixtures/hello/plan.md`
- Create: `apps/web/app/components/homepage/tour/fixtures/hello/memory.ts`
- Create: `apps/web/app/components/homepage/tour/fixtures/hello/skills/greetings/SKILL.md`
- Create: `apps/web/app/components/homepage/tour/fixtures/hello/subagents/translator/index.ts`
- Create: `apps/web/app/components/homepage/tour/tour-stops.ts`
- Create: `apps/web/app/components/homepage/tour/tour-sources.json`
- Create: `apps/web/app/components/homepage/tour/tour-sources.ts`
- Test: `apps/web/app/components/homepage/tour/tour-stops.test.ts`

**How the fixtures are typechecked.** They sit under `apps/web/app`, so `pnpm --dir apps/web typecheck` compiles them against `@b4run/sdk` and `zod`. Both are now explicit devDependencies (Task 1) and resolve to the same `zod@4.4.3` the SDK uses. Step 6 proves a type error in a fixture fails the gate. The docs-anchor check reuses `DOCS_INDEX` from `app/components/docs/search-index.ts`, which slugs headings with `github-slugger`, as the site does.

- [ ] **Step 1: Write the fixtures**

`apps/web/app/components/homepage/tour/fixtures/hello/plan.md` (the checklist from `/docs/planning#quick-start`):

```md
- [ ] Understand the customer request
- [ ] Check account context
- [ ] Decide whether to answer or escalate
- [ ] Write the final response
```

`apps/web/app/components/homepage/tour/fixtures/hello/memory.ts`:

```ts
import { defineMemory } from "@b4run/sdk"
import { z } from "zod"

export default defineMemory({
  kind: "semantic",
  scope: ["workspace", "route"],
  schema: z.object({
    subject: z.string(),
    predicate: z.string(),
    value: z.string(),
  }),
})
```

`apps/web/app/components/homepage/tour/fixtures/hello/skills/greetings/SKILL.md`:

```md
---
description: How to greet someone formally or for the time of day.
---

Use this skill when the user asks for a formal greeting or one that fits the time of day.

1. Say "Good morning", "Good afternoon" or "Good evening" for the local time.
2. For a formal greeting, use the person's title and family name.
3. Keep the greeting to one sentence.
```

`apps/web/app/components/homepage/tour/fixtures/hello/subagents/translator/index.ts`:

```ts
import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  description: "Translate a short greeting into the language the user asks for.",
  systemPrompt: "You translate greetings. Reply with the translation only.",
})
```

- [ ] **Step 2: Write the failing test**

Create `apps/web/app/components/homepage/tour/tour-stops.test.ts`:

```ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { DOCS_INDEX } from "../../docs/search-index"
import { scaffoldTree } from "../scaffold-tree"
import { tourSources } from "./tour-sources"
import { TOUR_ROOT, tourStops } from "./tour-stops"

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url))

describe("the folder tour shows real files", () => {
  it("walks the hello agent's seven files in order", () => {
    expect(tourStops.map((stop) => [stop.file, stop.state])).toEqual([
      ["index.ts", "scaffolded"],
      ["tools/greet.ts", "scaffolded"],
      ["plan.md", "added"],
      ["memory.ts", "added"],
      ["skills/greetings/SKILL.md", "added"],
      ["subagents/translator/index.ts", "added"],
      ["evals/smoke.eval.ts", "scaffolded"],
    ])
  })

  it("shows each file exactly as it is on disk", () => {
    for (const stop of tourStops) {
      expect(tourSources[stop.id], stop.origin).toBe(
        readFileSync(resolve(repoRoot, stop.origin), "utf8"),
      )
    }
  })

  it("takes the scaffolded files from the basic template, as the hero's tree lists them", () => {
    const hello = scaffoldTree.entries.find((entry) => entry.path === "src/app/hello")
    const scaffolded = tourStops.filter((stop) => stop.state === "scaffolded")
    expect(scaffolded.map((stop) => `${TOUR_ROOT}${stop.file}`)).toEqual(
      hello?.children?.map((child) => child.path),
    )
    for (const stop of scaffolded) {
      expect(stop.origin.replace(/\.template$/, "")).toBe(
        `packages/devkit/templates/app-basic/${TOUR_ROOT}${stop.file}`,
      )
    }
  })

  it("keeps the added files as fixtures the web typecheck covers", () => {
    for (const stop of tourStops.filter((candidate) => candidate.state === "added")) {
      expect(stop.origin).toBe(`apps/web/app/components/homepage/tour/fixtures/hello/${stop.file}`)
    }
    // `pnpm --dir apps/web typecheck` compiles every .ts under apps/web, fixtures included,
    // against @b4run/sdk and zod. Keep it that way.
    const tsconfig = JSON.parse(readFileSync(resolve(repoRoot, "apps/web/tsconfig.json"), "utf8"))
    expect(tsconfig.include).toContain("**/*.ts")
    expect(tsconfig.exclude).toEqual(["node_modules"])
  })

  it("says each thing in two sentences, without an em dash", () => {
    for (const stop of tourStops) {
      expect(stop.copy.match(/[.!?](?=\s|$)/g), stop.id).toHaveLength(2)
      expect(`${stop.title} ${stop.copy}`, stop.id).not.toContain("—")
    }
  })

  it("links every stop to a docs heading that exists", () => {
    for (const stop of tourStops) {
      const [path, anchor] = stop.docsHref.split("#")
      const page = DOCS_INDEX.find((entry) => entry.href === path)
      expect(page, stop.docsHref).toBeDefined()
      expect(anchor, stop.docsHref).toBeTruthy()
      expect(
        page?.headings.map((heading) => heading.anchor),
        stop.docsHref,
      ).toContain(anchor)
    }
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/tour/tour-stops.test.ts`
Expected: FAIL; `./tour-sources` and `./tour-stops` cannot be resolved.

- [ ] **Step 4: Write the stops**

Create `apps/web/app/components/homepage/tour/tour-stops.ts`. The copy has no em dashes (the homepage test forbids them) and avoids "e.g." (the two-sentence count would miscount it).

```ts
/**
 * The folder tour's seven stops: the hello agent `npm create b4-app` scaffolds,
 * plus four files you can add to it. Each panel shows a real file (`origin`);
 * tour-stops.test.ts pins the text and checks every docs anchor.
 */
export type TourStopId = "index" | "greet" | "plan" | "memory" | "skill" | "subagent" | "eval"

export interface TourStop {
  readonly id: TourStopId
  /** Path under TOUR_ROOT, as the tree shows it. */
  readonly file: string
  /** Whether the scaffold creates the file or you add it. */
  readonly state: "scaffolded" | "added"
  readonly title: string
  /** Two sentences. */
  readonly copy: string
  /** A docs page and one of its heading anchors. */
  readonly docsHref: string
  readonly docsLabel: string
  readonly language: "typescript" | "markdown"
  /** The file the panel shows, relative to the repository root. */
  readonly origin: string
}

/** What the client island needs to draw the tree and the chip bar. */
export type TourTab = Pick<TourStop, "id" | "file" | "state">

export const TOUR_ROOT = "src/app/hello/"
const TEMPLATE = "packages/devkit/templates/app-basic/src/app/hello/"
const FIXTURES = "apps/web/app/components/homepage/tour/fixtures/hello/"

export const tourStops: readonly TourStop[] = [
  {
    id: "index",
    file: "index.ts",
    state: "scaffolded",
    title: "One export is the agent.",
    copy: "index.ts picks the model and writes the system prompt. Every TypeScript file in tools/ becomes one of its tools.",
    docsHref: "/docs/agents#a-minimal-agent",
    docsLabel: "Agents",
    language: "typescript",
    origin: `${TEMPLATE}index.ts`,
  },
  {
    id: "greet",
    file: "tools/greet.ts",
    state: "scaffolded",
    title: "Your types are the tool schema.",
    copy: "The file name is the tool's name, and the JSDoc above it is the description. B4 reads the input type and writes the JSON schema the model sees.",
    docsHref: "/docs/tools#tool-descriptions",
    docsLabel: "Tool descriptions",
    language: "typescript",
    origin: `${TEMPLATE}tools/greet.ts`,
  },
  {
    id: "plan",
    file: "plan.md",
    state: "added",
    title: "Add plan.md and it plans.",
    copy: "A markdown checklist next to index.ts turns planning on and seeds the todo list. The agent gets a writeTodos tool to keep the list current.",
    docsHref: "/docs/planning#quick-start",
    docsLabel: "Planning",
    language: "markdown",
    origin: `${FIXTURES}plan.md`,
  },
  {
    id: "memory",
    file: "memory.ts",
    state: "added",
    title: "Add memory.ts and it remembers.",
    copy: "defineMemory declares the shape of the records and where they are scoped. The agent gets remember and recall tools typed from your schema.",
    docsHref: "/docs/memory/long-term#generated-recall-and-remember-tools",
    docsLabel: "Long-term memory",
    language: "typescript",
    origin: `${FIXTURES}memory.ts`,
  },
  {
    id: "skill",
    file: "skills/greetings/SKILL.md",
    state: "added",
    title: "Add a skill for long instructions.",
    copy: "The model sees each skill's description, not its body. It loads the full text only when it needs it, with readSkill.",
    docsHref: "/docs/skills#quick-start",
    docsLabel: "Skills",
    language: "markdown",
    origin: `${FIXTURES}skills/greetings/SKILL.md`,
  },
  {
    id: "subagent",
    file: "subagents/translator/index.ts",
    state: "added",
    title: "Add a subagent to hand work off.",
    copy: "A folder under subagents/ is a full agent with its own prompt and tools. The parent gets a task tool and uses each description to decide when to delegate.",
    docsHref: "/docs/subagents#quick-start",
    docsLabel: "Subagents",
    language: "typescript",
    origin: `${FIXTURES}subagents/translator/index.ts`,
  },
  {
    id: "eval",
    file: "evals/smoke.eval.ts",
    state: "scaffolded",
    title: "The scaffold ships an eval.",
    copy: "smoke.eval.ts replays a scripted reply and scores it, so npm run eval needs no API key. Add --live to try the real model.",
    docsHref: "/docs/evals#your-scaffolded-app-already-has-an-eval",
    docsLabel: "Evals",
    language: "typescript",
    // The scaffold drops the .template suffix when it copies the file.
    origin: `${TEMPLATE}evals/smoke.eval.ts.template`,
  },
]
```

- [ ] **Step 5: Write the sources snapshot and its loader**

Create `apps/web/app/components/homepage/tour/tour-sources.json`. Each value is the file at the stop's `origin`, byte for byte (the test enforces this):

```json
{
  "index": "import { agent } from \"@b4run/sdk\"\n\nexport default agent({\n  model: \"gpt-5-mini\",\n  systemPrompt: \"You are a friendly assistant. Use greet to greet people by name.\",\n})\n",
  "greet": "/** Greet someone by name. */\nexport default async (input: { readonly name: string }) => {\n  return { message: `Hello, ${input.name}!` }\n}\n",
  "plan": "- [ ] Understand the customer request\n- [ ] Check account context\n- [ ] Decide whether to answer or escalate\n- [ ] Write the final response\n",
  "memory": "import { defineMemory } from \"@b4run/sdk\"\nimport { z } from \"zod\"\n\nexport default defineMemory({\n  kind: \"semantic\",\n  scope: [\"workspace\", \"route\"],\n  schema: z.object({\n    subject: z.string(),\n    predicate: z.string(),\n    value: z.string(),\n  }),\n})\n",
  "skill": "---\ndescription: How to greet someone formally or for the time of day.\n---\n\nUse this skill when the user asks for a formal greeting or one that fits the time of day.\n\n1. Say \"Good morning\", \"Good afternoon\" or \"Good evening\" for the local time.\n2. For a formal greeting, use the person's title and family name.\n3. Keep the greeting to one sentence.\n",
  "subagent": "import { agent } from \"@b4run/sdk\"\n\nexport default agent({\n  model: \"gpt-5-mini\",\n  description: \"Translate a short greeting into the language the user asks for.\",\n  systemPrompt: \"You translate greetings. Reply with the translation only.\",\n})\n",
  "eval": "import { contains, defineEval } from \"@b4run/evals\"\nimport { script } from \"@b4run/testing\"\n\nexport default defineEval({\n  name: \"greets by name\",\n  dataset: [\n    {\n      name: \"ada\",\n      input: \"Say hello to Ada\",\n      fixtures: script().user(\"Say hello to Ada\").replies(\"Hello, Ada!\"),\n    },\n  ],\n  scorers: [contains(\"Hello\", { threshold: 1 })],\n  threshold: 1,\n})\n"
}
```

Create `apps/web/app/components/homepage/tour/tour-sources.ts`:

```ts
import "server-only"
import { highlightCode } from "../highlight"
import type { DisplayCode } from "../types"
import sources from "./tour-sources.json"
import { TOUR_ROOT, type TourStopId, tourStops } from "./tour-stops"

/** Each stop's file text; tour-stops.test.ts pins it to the file at `origin`. */
export const tourSources: Readonly<Record<TourStopId, string>> = sources

/** Every stop's file, highlighted for a CodePanel. */
export async function prepareTourCode(): Promise<Readonly<Record<TourStopId, DisplayCode>>> {
  const entries = await Promise.all(
    tourStops.map(async (stop) => {
      const code = await highlightCode(
        sources[stop.id].trimEnd(),
        stop.language,
        `${TOUR_ROOT}${stop.file}`,
        "",
      )
      return [stop.id, { ...code, wrap: true }] as const
    }),
  )
  return Object.fromEntries(entries) as Record<TourStopId, DisplayCode>
}
```

- [ ] **Step 6: Run the tests, and prove the fixtures are typechecked**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/tour/tour-stops.test.ts`
Expected: PASS (6 tests).

Run: `pnpm --dir apps/web typecheck`
Expected: exit 0.

Mutation check: prove the gate binds. Change `kind: "semantic"` to `kind: "nope"` in `fixtures/hello/memory.ts`, run `pnpm --dir apps/web typecheck`, and expect exit 1 with `Type '"nope"' is not assignable to type '"episodic" | "procedural" | "reflection" | "semantic"'`. Change it back to `"semantic"` and re-run typecheck (exit 0). Then run the tour-stops test again: it pins the file's text, so a leftover edit fails it.

Run: `pnpm --dir apps/web lint`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/tour/fixtures apps/web/app/components/homepage/tour/tour-stops.ts apps/web/app/components/homepage/tour/tour-sources.json apps/web/app/components/homepage/tour/tour-sources.ts apps/web/app/components/homepage/tour/tour-stops.test.ts
git commit -m "feat(web): the folder tour's seven stops, pinned to real and typechecked files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The TourClient island and the tour styles

**Files:**
- Create: `apps/web/app/components/homepage/tour/TourClient.tsx`
- Create: `apps/web/app/components/homepage/tour/tour.module.css`
- Test: `apps/web/app/components/homepage/tour/TourClient.test.tsx`

**How it works:**

- **Server-rendered content comes in as `children`.** The server renders the cards; the island receives them as `children` (a server component passing server-rendered elements into a client island), plus `stops`, which are plain `{ id, file, state }` objects.
- **Pinning is opt-in.** `withMotion`'s full branch at `DESKTOP` sets `data-pinned="true"` on the island's root in the DOM (React doesn't manage that attribute), so CSS switches the layout before `ScrollTrigger.create({ pin })` measures it. Reverting the `matchMedia` context unpins, clears GSAP's inline props and removes the attribute.
- **Two sources of the current stop.** When stacked, an IntersectionObserver picks the current card; when pinned, ScrollTrigger's `onUpdate` does.
- **Only one effect animates.** It runs only while pinned, and only on `transform`, `opacity`/`visibility` (`autoAlpha`) and colour.
- **Test stubs.** The tests stub `matchMedia` (media-stub), `IntersectionObserver`, `scrollIntoView` and `window.scrollTo`: jsdom 30 has none of them.

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/homepage/tour/TourClient.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DESKTOP, FULL, REDUCE } from "../motion/gsap"
import { type MediaStub, stubMatchMedia } from "../motion/media-stub"
import { TourClient } from "./TourClient"
import { tourStops } from "./tour-stops"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** jsdom has no IntersectionObserver; this one lets a test say which card is in view. */
class FakeIntersectionObserver {
  static latest: FakeIntersectionObserver | undefined
  readonly callback: IntersectionObserverCallback
  readonly targets: Element[] = []
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    FakeIntersectionObserver.latest = this
  }
  observe(target: Element) {
    this.targets.push(target)
  }
  unobserve() {}
  disconnect() {
    this.targets.length = 0
  }
  takeRecords() {
    return []
  }
}

const stops = tourStops.map(({ id, file, state }) => ({ id, file, state }))
let root: Root | undefined
let media: MediaStub | undefined
const scrollIntoView = vi.fn()

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  // jsdom implements neither; the tour only asks the browser to scroll.
  Element.prototype.scrollIntoView = scrollIntoView
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  media?.restore()
  media = undefined
  Reflect.deleteProperty(Element.prototype, "scrollIntoView")
  scrollIntoView.mockReset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mount(matching: Readonly<Record<string, boolean>>) {
  media = stubMatchMedia(matching)
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () =>
    root?.render(
      <TourClient stops={stops}>
        {stops.map((stop, index) => (
          <article key={stop.id} id={`tour-${stop.id}`} data-stop={index}>
            <h3>{stop.file}</h3>
          </article>
        ))}
      </TourClient>,
    ),
  )
  const client = container.querySelector<HTMLElement>('[data-tour="root"]')
  const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  return {
    client,
    tabs,
    cards: () => [...container.querySelectorAll<HTMLElement>("[data-stop]")],
    live: () => container.querySelector('[aria-live="polite"]')?.textContent,
    key: (target: Element | undefined, key: string) =>
      act(async () => {
        target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
      }),
  }
}

it("moves through the files with the arrow keys, Home and End, and scrolls to each", async () => {
  const view = await mount({ [REDUCE]: true, [FULL]: false, [DESKTOP]: false })
  expect(view.tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
    "true",
    ...Array(6).fill("false"),
  ])
  expect(view.tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1])
  expect(view.live()).toBe("")

  view.tabs[0]?.focus()
  await view.key(view.tabs[0], "ArrowDown")
  expect(document.activeElement).toBe(view.tabs[1])
  expect(view.tabs[1]?.getAttribute("aria-selected")).toBe("true")
  expect(view.tabs[1]?.tabIndex).toBe(0)
  expect(scrollIntoView.mock.contexts.at(-1)).toBe(view.cards()[1])
  expect(view.live()).toBe("tools/greet.ts, 2 of 7")

  await view.key(view.tabs[1], "End")
  expect(document.activeElement).toBe(view.tabs[6])
  await view.key(view.tabs[6], "ArrowRight")
  expect(document.activeElement).toBe(view.tabs[0])
  await view.key(view.tabs[0], "ArrowUp")
  expect(document.activeElement).toBe(view.tabs[6])
  await view.key(view.tabs[6], "Home")
  expect(document.activeElement).toBe(view.tabs[0])
  expect(view.live()).toBe("index.ts, 1 of 7")
})

it("marks the card in view in the chip bar", async () => {
  const view = await mount({ [REDUCE]: true, [FULL]: false, [DESKTOP]: false })
  const observer = FakeIntersectionObserver.latest
  expect(observer?.targets).toEqual(view.cards())
  const memory = view.cards()[3]
  await act(async () =>
    observer?.callback(
      [{ isIntersecting: true, target: memory } as unknown as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    ),
  )
  const current = [...document.querySelectorAll('[data-tour="chips"] a[aria-current="true"]')]
  expect(current.map((chip) => chip.getAttribute("href"))).toEqual(["#tour-memory"])
  expect(view.live()).toBe("memory.ts, 4 of 7")
})

it("pins only at desktop sizes with motion on, and lets go when motion is reduced", async () => {
  const view = await mount({ [REDUCE]: false, [FULL]: true, [DESKTOP]: false })
  expect(view.client?.dataset.pinned).toBeUndefined()

  await act(async () => media?.change({ [DESKTOP]: true }))
  expect(view.client?.dataset.pinned).toBe("true")
  // Each tab names the card it shows. The cards stay <article>s (tabpanel is not
  // an allowed role on <article>).
  expect(view.tabs.map((tab) => tab.getAttribute("aria-controls"))).toEqual(
    view.cards().map((card) => card.id),
  )

  await act(async () => media?.change({ [REDUCE]: true, [FULL]: false }))
  expect(view.client?.dataset.pinned).toBeUndefined()
  // Nothing is left hidden or moved once the pin lets go.
  expect(view.cards().map((card) => card.getAttribute("style") ?? "")).toEqual(Array(7).fill(""))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/tour/TourClient.test.tsx`
Expected: FAIL; `./TourClient` cannot be resolved.

- [ ] **Step 3: Write the island**

Create `apps/web/app/components/homepage/tour/TourClient.tsx`:

```tsx
"use client"
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { DESKTOP, gsap, ScrollTrigger, withMotion } from "../motion/gsap"
import styles from "./tour.module.css"
import type { TourTab } from "./tour-stops"

const cardsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-stop]")]
const headerHeight = () => document.querySelector("header")?.getBoundingClientRect().height ?? 0

/**
 * Behaviour for the folder tour. The server renders every stop as a stacked
 * card (`children`); this island adds the chip bar's current marker, and, at
 * desktop sizes with motion on, pins the stage with the file tree as a tablist
 * beside one card at a time.
 */
export function TourClient({
  stops,
  children,
}: {
  readonly stops: readonly TourTab[]
  readonly children: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const chipsRef = useRef<HTMLElement>(null)
  const markerRef = useRef<HTMLSpanElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const triggerRef = useRef<ScrollTrigger | null>(null)
  const pinnedRef = useRef(false)
  const activeRef = useRef(0)
  const [active, setActive] = useState(0)
  const [pinned, setPinned] = useState(false)
  const [moved, setMoved] = useState(false)
  const count = stops.length
  const current = stops[active]

  const moveTo = useCallback((index: number) => {
    if (index === activeRef.current) return
    activeRef.current = index
    setActive(index)
    setMoved(true)
  }, [])

  // Pin at desktop sizes with motion on. Otherwise the cards stay stacked.
  useEffect(() => {
    const root = rootRef.current
    const stage = stageRef.current
    if (!root || !stage) return
    return withMotion(
      root,
      {
        reduce: () => {
          root.removeAttribute("data-pinned")
        },
        full: ({ desktop }) => {
          if (!desktop) return undefined
          const cards = cardsOf(root)
          const last = count - 1
          root.setAttribute("data-pinned", "true")
          pinnedRef.current = true
          setPinned(true)
          triggerRef.current = ScrollTrigger.create({
            trigger: stage,
            pin: stage,
            start: () => `top top+=${headerHeight()}`,
            end: () => `+=${count * window.innerHeight * 0.7}`,
            snap: { snapTo: 1 / last, duration: { min: 0.2, max: 0.5 }, ease: "power1.inOut" },
            invalidateOnRefresh: true,
            onUpdate: (self) => moveTo(Math.round(self.progress * last)),
          })
          return () => {
            triggerRef.current = null
            pinnedRef.current = false
            setPinned(false)
            const tabs = tabRefs.current.filter((tab): tab is HTMLButtonElement => tab !== null)
            const moving = [...cards, ...tabs, ...(markerRef.current ? [markerRef.current] : [])]
            gsap.killTweensOf(moving)
            gsap.set(moving, { clearProps: "opacity,visibility,transform" })
            root.removeAttribute("data-pinned")
          }
        },
      },
      { desktop: DESKTOP },
    )
  }, [count, moveTo])

  // Stacked: the card crossing the upper middle of the viewport is the current one.
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        if (pinnedRef.current) return
        for (const entry of entries) {
          if (entry.isIntersecting) moveTo(Number((entry.target as HTMLElement).dataset.stop))
        }
      },
      { rootMargin: "-40% 0px -55% 0px" },
    )
    for (const card of cardsOf(root)) observer.observe(card)
    return () => observer.disconnect()
  }, [moveTo])

  // Keep the current chip in view inside the chip bar (horizontally only).
  useEffect(() => {
    const chips = chipsRef.current
    const chip = chips?.querySelector<HTMLElement>(`[data-chip="${active}"]`)
    if (chips && chip) chips.scrollLeft = Math.max(0, chip.offsetLeft - 16)
  }, [active])

  // Pinned: fade the new card in, slide the marker to its row, settle an added file.
  const activeState = current?.state
  useEffect(() => {
    const root = rootRef.current
    if (!pinned || !root) return
    const cards = cardsOf(root)
    const shown = cards[active]
    const hide = gsap.to(
      cards.filter((card) => card !== shown),
      { autoAlpha: 0, duration: 0.15, overwrite: "auto" },
    )
    const show = shown
      ? gsap.fromTo(
          shown,
          { autoAlpha: 0, y: 12 },
          { autoAlpha: 1, y: 0, duration: 0.3, ease: "power2.out", overwrite: "auto" },
        )
      : undefined
    const tab = tabRefs.current[active]
    const marker = markerRef.current
    const slide =
      tab && marker
        ? gsap.to(marker, {
            y: tab.offsetTop + tab.offsetHeight / 2 - marker.offsetHeight / 2,
            duration: 0.25,
            ease: "power2.out",
          })
        : undefined
    const settle =
      tab && activeState === "added"
        ? gsap.fromTo(tab, { x: -8 }, { x: 0, duration: 0.25, ease: "power2.out" })
        : undefined
    return () => {
      for (const tween of [hide, show, slide, settle]) tween?.kill()
    }
  }, [active, activeState, pinned])

  function goTo(index: number) {
    moveTo(index)
    const trigger = triggerRef.current
    if (trigger) {
      const offset = ((trigger.end - trigger.start) * index) / (count - 1)
      window.scrollTo({ top: trigger.start + offset, behavior: "smooth" })
      return
    }
    document.getElementById(`tour-${stops[index]?.id}`)?.scrollIntoView({ block: "start" })
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowRight: index + 1,
      ArrowUp: index - 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: count - 1,
    }
    const target = moves[event.key]
    if (target === undefined) return
    event.preventDefault()
    const next = (target + count) % count
    tabRefs.current[next]?.focus()
    goTo(next)
  }

  return (
    <div
      ref={rootRef}
      className={styles.client}
      data-tour="root"
      style={{ "--stops": count } as CSSProperties}
    >
      <nav ref={chipsRef} className={styles.chips} data-tour="chips" aria-label="Jump to a file">
        {stops.map((stop, index) => (
          <a
            key={stop.id}
            href={`#tour-${stop.id}`}
            className={styles.chip}
            data-chip={index}
            aria-current={index === active ? "true" : undefined}
            onClick={() => moveTo(index)}
          >
            {stop.state === "added" ? <span aria-hidden="true">+ </span> : null}
            {stop.file}
          </a>
        ))}
      </nav>
      <div ref={stageRef} className={styles.stage} data-tour="stage">
        <div className={styles.tree}>
          <p className={styles.treeRoot}>my-agent/src/app/hello/</p>
          <div className={styles.tabsFrame}>
            <span ref={markerRef} className={styles.marker} aria-hidden="true" />
            <div
              role="tablist"
              aria-label="Files in my-agent/src/app/hello"
              aria-orientation="vertical"
              className={styles.tabs}
            >
              {stops.map((stop, index) => (
                <button
                  key={stop.id}
                  ref={(node) => {
                    tabRefs.current[index] = node
                  }}
                  type="button"
                  role="tab"
                  id={`tour-tab-${stop.id}`}
                  className={styles.tab}
                  aria-selected={index === active}
                  aria-controls={`tour-${stop.id}`}
                  tabIndex={index === active ? 0 : -1}
                  data-state={stop.state}
                  data-settled={stop.state === "scaffolded" || index <= active}
                  onClick={() => goTo(index)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                >
                  {stop.state === "added" ? (
                    <span className={styles.plus} aria-hidden="true">
                      +
                    </span>
                  ) : null}
                  {stop.file}
                  <span className="sr-only">
                    {stop.state === "added" ? ", added" : ", scaffolded"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className={styles.cards}>{children}</div>
      </div>
      <p className="sr-only" aria-live="polite">
        {moved && current ? `${current.file}, ${active + 1} of ${count}` : ""}
      </p>
    </div>
  )
}
```

- [ ] **Step 4: Write the styles**

Create `apps/web/app/components/homepage/tour/tour.module.css`. It also holds the card styles `FolderTour` uses in Task 6. Rules for `[data-pinned="true"]` come last, so each more specific selector follows the plain rule it overrides (Biome's `noDescendingSpecificity`).

```css
/* The folder tour (#first-agent). Paper Relay tokens only (tokens.css).
   Stacked cards by default (no JS, reduced motion, below 960px); TourClient
   sets [data-pinned="true"] on .client to pin the stage at desktop sizes. */
.tour {
  padding: 56px 0 24px;
  border-bottom: 1px solid var(--color-rule);
  scroll-margin-top: var(--header-h);
}
.intro {
  max-width: 640px;
  margin-bottom: 32px;
}
.eyebrow {
  margin: 0;
}
.intro h2 {
  font-size: clamp(30px, 3.5vw, 43px);
  font-weight: 500;
  line-height: 1.08;
  letter-spacing: -0.045em;
  margin: 24px 0 16px;
}
.intro p:not([data-ui="eyebrow"]) {
  font-size: 15px;
  line-height: 1.8;
  color: var(--color-ink-muted);
  margin: 0;
}
/* The hero terminal's agent row carries the same dot (relay on paper is
   1.6:1, so it is outlined). */
.markerDot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 10px;
  border: 1.5px solid var(--color-ink);
  border-radius: 50%;
  background: var(--color-relay);
  vertical-align: -1px;
}

/* The chip bar: plain links to each card, sticky under the header. */
.chips {
  position: sticky;
  top: var(--header-h);
  z-index: 2;
  display: flex;
  gap: 8px;
  overflow-x: auto;
  margin: 0;
  padding: 10px 0;
  background: var(--color-page);
  border-bottom: 1px solid var(--color-rule);
  scrollbar-width: none;
}
/* Two classes, so it outranks `.home a { color: inherit }`. */
.chips .chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--color-rule-strong);
  font:
    12px / 1.4 var(--font-mono),
    monospace;
  color: var(--color-ink);
  text-decoration: none;
  white-space: nowrap;
}
/* The current file: tint, ink border and an underline, so colour is not the only signal. */
.chips .chip[aria-current="true"] {
  border-color: var(--color-ink);
  background: var(--color-relay-tint);
  color: var(--color-relay-ink);
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* One card per stop: copy left, file right; one column on phones. */
.card {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.4fr);
  gap: 40px;
  align-items: start;
  padding: 40px 0;
  border-top: 1px solid var(--color-rule);
  scroll-margin-top: calc(var(--header-h) + 64px);
}
.card:first-child {
  border-top: 0;
}
.cardCopy {
  min-width: 0;
}
.cardFile {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 0;
  font:
    13px / 1.6 var(--font-mono),
    monospace;
  overflow-wrap: anywhere;
}
.cardFile code {
  font: inherit;
}
.badge {
  padding: 2px 8px;
  border: 1px solid var(--color-rule-strong);
  font:
    11px / 1.6 var(--font-mono),
    monospace;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--color-ink-muted);
}
.badge[data-state="added"] {
  border-color: var(--color-relay-tint);
  background: var(--color-relay-tint);
  color: var(--color-relay-ink);
}
.cardCopy h3 {
  font-size: 24px;
  font-weight: 500;
  line-height: 1.2;
  letter-spacing: -0.03em;
  margin: 16px 0 12px;
}
.cardCopy p:not(.cardFile) {
  font-size: 15px;
  line-height: 1.7;
  color: var(--color-ink-muted);
  margin: 0 0 8px;
}
.docsLink {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  font-size: 13px;
  text-underline-offset: 5px;
}
.cardPanel {
  min-width: 0;
}

/* The file tree: a tablist, shown only while pinned. */
.tree {
  display: none;
}
.treeRoot {
  height: 28px;
  margin: 0;
  font:
    13px / 28px var(--font-mono),
    monospace;
  color: var(--color-ink-muted);
}
.tabsFrame {
  position: relative;
}
.tabs {
  display: flex;
  flex-direction: column;
}
/* The Relay dot; TourClient slides it to the current row. */
.marker {
  position: absolute;
  top: 0;
  left: 6px;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--color-ink);
  border-radius: 50%;
  background: var(--color-relay);
  pointer-events: none;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 36px;
  padding: 0 12px 0 24px;
  border: 0;
  background: transparent;
  color: var(--color-ink);
  font:
    13px / 1 var(--font-mono),
    monospace;
  text-align: left;
  cursor: pointer;
}
/* An added file is ghosted until its stop is reached. */
.tab[data-settled="false"] {
  color: var(--color-ink-muted);
}
.tab[aria-selected="true"] {
  background: var(--color-relay-tint);
  color: var(--color-relay-ink);
  font-weight: 600;
}

@media (max-width: 760px) {
  .tour {
    padding: 36px 0 16px;
  }
  .card {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
    padding: 32px 0;
  }
  .cardCopy h3 {
    margin: 12px 0 10px;
  }
}
@media (prefers-reduced-motion: no-preference) {
  .tab {
    transition:
      color 250ms ease-out,
      background-color 250ms ease-out;
  }
}

/* Pinned (desktop, motion on): the tree top-left, the current card's copy
   under it and its file on the right. Cards share one grid cell; TourClient
   fades between them. Subgrid lines each card up with the stage columns. */
.client[data-pinned="true"] .chips {
  display: none;
}
.client[data-pinned="true"] .stage {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  column-gap: 40px;
  padding-top: 24px;
  background: var(--color-page);
}
.client[data-pinned="true"] .tree {
  position: relative;
  z-index: 1;
  display: block;
  grid-area: 1 / 1;
  align-self: start;
}
.client[data-pinned="true"] .cards {
  display: grid;
  grid-area: 1 / 1 / 2 / 3;
  grid-template-columns: subgrid;
}
.client[data-pinned="true"] .card {
  grid-area: 1 / 1 / 2 / 3;
  grid-template-columns: subgrid;
  padding: 0;
  border-top: 0;
}
.client[data-pinned="true"] .cardCopy {
  grid-column: 1;
  padding-top: calc(28px + var(--stops) * 36px + 32px);
}
.client[data-pinned="true"] .cardPanel {
  grid-column: 2;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/tour/ app/components/homepage/motion/ app/styles/design-system.test.ts`
Expected: PASS. jsdom prints no "Not implemented: window.scrollTo" error, because the test stubs it.

Run: `pnpm --dir apps/web lint && pnpm --dir apps/web typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/tour/TourClient.tsx apps/web/app/components/homepage/tour/tour.module.css apps/web/app/components/homepage/tour/TourClient.test.tsx
git commit -m "feat(web): the tour island: chip bar, file tablist and a desktop-only pin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The FolderTour server shell

**Files:**
- Create: `apps/web/app/components/homepage/tour/prepare.ts`
- Create: `apps/web/app/components/homepage/tour/FolderTour.tsx`
- Test: `apps/web/app/components/homepage/tour/FolderTour.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/homepage/tour/FolderTour.test.tsx`:

```tsx
// @vitest-environment jsdom
import { renderToString } from "react-dom/server"
import { expect, it } from "vitest"
import { FolderTour } from "./FolderTour"
import { prepareFolderTour } from "./prepare"
import { tourSources } from "./tour-sources"
import { tourStops } from "./tour-stops"

const data = await prepareFolderTour()
const render = () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(<FolderTour {...data} />)
  return container
}

it("server renders all seven stops in full, stacked and visible, before any script runs", () => {
  const section = render().querySelector("section#first-agent")
  expect(section?.querySelector("h2")?.textContent).toBe("An agent is a folder.")
  const cards = [...(section?.querySelectorAll<HTMLElement>("article[data-stop]") ?? [])]
  expect(cards.map((card) => card.id)).toEqual(tourStops.map((stop) => `tour-${stop.id}`))
  for (const [index, stop] of tourStops.entries()) {
    const card = cards[index]
    expect(card?.getAttribute("style"), stop.id).toBeNull()
    expect(card?.getAttribute("role"), stop.id).toBeNull()
    expect(card?.querySelector("code")?.textContent).toBe(`src/app/hello/${stop.file}`)
    expect(card?.querySelector("h3")?.textContent).toBe(stop.title)
    expect(card?.textContent).toContain(stop.copy)
    expect(card?.querySelector(`a[href="${stop.docsHref}"]`)?.textContent).toBe(
      `${stop.docsLabel} →`,
    )
    // The panel shows the whole file: every non-blank line is on the page.
    const shown = card?.querySelector("pre")?.textContent ?? ""
    for (const line of tourSources[stop.id].split("\n").filter((text) => text.trim() !== "")) {
      expect(shown, `${stop.id}: ${line}`).toContain(line)
    }
  }
  // The chip bar is plain links, so it works before any script runs.
  const chips = [...(section?.querySelectorAll('[data-tour="chips"] a') ?? [])]
  expect(chips.map((chip) => chip.getAttribute("href"))).toEqual(
    tourStops.map((stop) => `#tour-${stop.id}`),
  )
  expect(section?.querySelectorAll('[role="tab"]')).toHaveLength(7)
  expect(section?.querySelector("[data-pinned]")).toBeNull()
})

it("opens the tool stop on the playground, showing the scaffold's own schema", () => {
  const greet = render().querySelector("#tour-greet")
  expect(
    [...(greet?.querySelectorAll("button[aria-pressed]") ?? [])].map((button) =>
      button.getAttribute("aria-pressed"),
    ),
  ).toEqual(["false", "false", "true"])
  expect(greet?.textContent).toContain('"description": "Greet someone by name."')
  expect(greet?.textContent).toContain('"required": ["name"]')
  expect(greet?.querySelector('[aria-live="polite"]')).not.toBeNull()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/tour/FolderTour.test.tsx`
Expected: FAIL; `./FolderTour` and `./prepare` cannot be resolved.

- [ ] **Step 3: Write the preparation and the shell**

Create `apps/web/app/components/homepage/tour/prepare.ts`:

```ts
import "server-only"
import { preparePlayground } from "../playground/schema-variants"
import { prepareTourCode } from "./tour-sources"

/** Everything the folder tour renders, highlighted on the server. */
export async function prepareFolderTour() {
  const [code, variants] = await Promise.all([prepareTourCode(), preparePlayground()])
  return { code, variants }
}

export type FolderTourData = Awaited<ReturnType<typeof prepareFolderTour>>
```

Create `apps/web/app/components/homepage/tour/FolderTour.tsx`. It's synchronous: `renderToString` (the tests) can't render async components, so the caller awaits `prepareFolderTour()`.

```tsx
import { Eyebrow } from "../../ui/Eyebrow"
import { CodePanel } from "../CodePanel"
import { SchemaPlayground } from "../playground/SchemaPlayground"
import type { FolderTourData } from "./prepare"
import { TourClient } from "./TourClient"
import styles from "./tour.module.css"
import { TOUR_ROOT, type TourTab, tourStops } from "./tour-stops"

const tabs: readonly TourTab[] = tourStops.map(({ id, file, state }) => ({ id, file, state }))

/**
 * "Your first agent": the scaffolded hello agent, one file per stop. Every stop
 * renders here in full, stacked, so the page reads the same without
 * JavaScript; TourClient adds the chip bar's marker, the pinned tree and the
 * motion.
 */
export function FolderTour({ code, variants }: FolderTourData) {
  return (
    <section id="first-agent" className={styles.tour} aria-labelledby="first-agent-title">
      <div className={styles.intro}>
        <Eyebrow className={styles.eyebrow}>
          <span className={styles.markerDot} aria-hidden="true" />
          Your first agent
        </Eyebrow>
        <h2 id="first-agent-title">An agent is a folder.</h2>
        <p>
          Every file in src/app/hello/ is a feature. The scaffold starts you with three. Add a file
          and the agent gets the tools that come with it.
        </p>
      </div>
      <TourClient stops={tabs}>
        {tourStops.map((stop, index) => (
          <article
            key={stop.id}
            id={`tour-${stop.id}`}
            data-stop={index}
            className={styles.card}
            aria-labelledby={`tour-title-${stop.id}`}
          >
            <div className={styles.cardCopy}>
              <p className={styles.cardFile}>
                <code>{`${TOUR_ROOT}${stop.file}`}</code>
                <span className={styles.badge} data-state={stop.state}>
                  {stop.state === "added" ? "+ added" : "scaffolded"}
                </span>
              </p>
              <h3 id={`tour-title-${stop.id}`}>{stop.title}</h3>
              <p>{stop.copy}</p>
              <a className={styles.docsLink} href={stop.docsHref}>
                {stop.docsLabel} →
              </a>
            </div>
            <div className={styles.cardPanel}>
              {stop.id === "greet" ? (
                <SchemaPlayground variants={variants} />
              ) : (
                <CodePanel code={code[stop.id]} />
              )}
            </div>
          </article>
        ))}
      </TourClient>
    </section>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/tour/`
Expected: PASS (11 tests across the three tour files).

Run: `pnpm --dir apps/web lint && pnpm --dir apps/web typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/tour/prepare.ts apps/web/app/components/homepage/tour/FolderTour.tsx apps/web/app/components/homepage/tour/FolderTour.test.tsx
git commit -m "feat(web): the folder tour renders every stop in full on the server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The tour replaces FirstAgent, and the code-fixer leaves the homepage

**Files:**
- Modify: `apps/web/app/components/homepage/DeveloperHome.tsx`
- Modify: `apps/web/app/components/homepage/highlight.ts`
- Modify: `apps/web/app/components/homepage/types.ts`
- Modify: `apps/web/app/components/homepage/homepage.module.css`
- Modify: `apps/web/app/components/homepage/homepage.test.tsx`
- Modify: `apps/web/app/seo/registry.ts`, `apps/web/app/seo/seo.test.ts`
- Modify: `apps/web/app/site-chrome.test.tsx`
- Delete: `apps/web/app/components/homepage/{Walkthrough.tsx,Narrative.tsx,ProjectOverview.tsx,FirstAgent.tsx}`
- Delete: `apps/web/app/components/homepage/{evidence.json,evidence.ts,evidence.test.ts,narrative-source.json,narrative-source.ts,narrative-source.test.ts,first-agent-source.json,first-agent-source.ts,first-agent-source.test.ts}`
- Delete: `apps/web/scripts/export-homepage-evidence.mjs`

- [ ] **Step 1: Confirm nothing else imports what is being removed**

Run: `git grep -nE "Walkthrough|Narrative|ProjectOverview|FirstAgent|narrative-source|first-agent-source|export-homepage-evidence|prepareHomepage|curatedEvidenceUrl|exampleFileUrl|exampleUrl|homepage/evidence|WalkthroughProps" -- apps packages scripts .github ':!**/CHANGELOG.md'`
Expected: matches only inside `apps/web/app/components/homepage/`, in the files this task deletes or modifies (`DeveloperHome.tsx`, `highlight.ts`, `types.ts`, `homepage.test.tsx` and the deleted files). The OG image (`app/opengraph-image.tsx`) and other routes import nothing from them. `CodePanel.tsx` and `highlightCode` stay: the tour uses both.

- [ ] **Step 2: Write the failing tests**

Replace `apps/web/app/components/homepage/homepage.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { CodePanel } from "./CodePanel"
import { DeveloperHome } from "./DeveloperHome"
import { ScaffoldTerminal } from "./ScaffoldTerminal"
import { prepareTourCode } from "./tour/tour-sources"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})

it("opens with the install command, then the folder tour of the agent it creates", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const hero = container.querySelector('[aria-labelledby="home-title"]')
  expect(hero?.textContent).toContain("npm create b4-app@latest my-agent")
  expect(hero?.querySelector('a[href="/docs/getting-started"]')?.textContent).toBe("Get started →")
  const first = container.querySelector("#first-agent")
  expect(first?.textContent).toContain("src/app/hello/index.ts")
  expect(first?.textContent).toContain("src/app/hello/tools/greet.ts")
  const order = ["home-title", "first-agent", "run-title"].map((id) =>
    [...container.querySelectorAll("[id]")].findIndex((node) => node.id === id),
  )
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
})

it("shows the runtime and what the command creates beside the headline", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const hero = container.querySelector('[aria-labelledby="home-title"]')
  expect(hero?.textContent).toContain("Runs on LangGraph.js. You keep the graph.")
  const figure = hero?.querySelector("figure")
  expect(figure?.querySelector("figcaption")?.textContent).toBe("What npm create b4-app scaffolds")
  // The tree's agent row points at the section that opens those files.
  expect(figure?.querySelector('a[href="#first-agent"]')).not.toBeNull()
  expect(container.querySelector("#first-agent")).not.toBeNull()
  // The old dot hung directly off the hero; the eclipse now sits beside the
  // terminal, as an empty decorative element outside the figure.
  expect(hero?.querySelectorAll(':scope > [aria-hidden="true"]')).toHaveLength(0)
  const decorations = [...(hero?.querySelectorAll('[aria-hidden="true"]:empty') ?? [])]
  expect(decorations.filter((node) => !node.closest("figure"))).toHaveLength(1)
})

it("marks only off-site links with ↗ and opens them in a new tab", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  for (const link of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href") ?? ""
    if (href.startsWith("http")) {
      expect(link.getAttribute("target"), href).toBe("_blank")
      expect(link.getAttribute("rel"), href).toContain("noopener")
    } else {
      expect(link.textContent, href).not.toContain("↗")
    }
    expect(href).not.toContain("docs/superpowers")
  }
  expect(container.querySelector("details")).toBeNull()
})

it("ends with the install command, and the code-fixer walkthrough is gone", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const takeaway = container.querySelector('[aria-labelledby="run-title"]')
  expect(takeaway?.textContent).toContain("npm create b4-app@latest my-agent")
  expect(takeaway?.querySelector('a[href="/docs/getting-started"]')).not.toBeNull()
  expect(takeaway?.children).toHaveLength(1)
  expect(container.textContent).not.toMatch(/code-fixer|code fixer|b4 add/i)
  expect(container.querySelector('a[href*="examples/code-fixer"]')).toBeNull()
  expect(container.textContent).not.toContain("—")
})

it("names every labelled region uniquely", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const labels = [...container.querySelectorAll("section[aria-label]")].map((node) =>
    node.getAttribute("aria-label"),
  )
  expect(labels).toContain("src/app/hello/index.ts")
  expect(labels).toContain("What the model sees")
  expect(new Set(labels).size).toBe(labels.length)
})

it("renders source markup as inert text", async () => {
  const { highlightCode } = await import("./highlight")
  const code = await highlightCode(
    '<script>alert("inert")</script>',
    "typescript",
    "example.ts",
    "https://example.com/source",
  )
  const html = renderToString(<CodePanel code={code} />)
  expect(html).not.toContain('<script>alert("inert")</script>')
  expect(html).toContain("&lt;")
  // Token colours are classes from app/styles/syntax.css, not inline styles.
  expect(html).toContain('class="sh')
  expect(html).not.toContain("style=")
})

it("renders and copies a tour file whole, with visual wrapping only", async () => {
  const { eval: smoke } = await prepareTourCode()
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  await act(async () => root?.render(<CodePanel code={smoke} />))
  const rendered = [...container.querySelectorAll("pre code > span")]
    .map((line) => (line.lastElementChild?.textContent ?? "").trimEnd())
    .join("\n")
  expect(rendered.trimEnd()).toBe(smoke.raw.trimEnd())
  expect(container.querySelector("[aria-expanded]")).toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click())
  expect(writeText).toHaveBeenCalledWith(smoke.raw)
})

it("renders the scaffold as a captioned figure a screen reader can follow", () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(<ScaffoldTerminal />)
  const figure = container.querySelector("figure")
  expect(figure?.querySelector("figcaption")?.textContent).toBe("What npm create b4-app scaffolds")
  expect(figure?.textContent).toContain("npm create b4-app@latest my-agent")
  expect(figure?.textContent).toContain("Created my-agent (basic template)")
  expect(figure?.textContent).toContain("cd my-agent && npm install && npm test")
  expect(figure?.querySelector("ul")?.children).toHaveLength(4)
  expect(figure?.querySelectorAll("ul ul > li")).toHaveLength(3)
  // Glyphs, prompts, the marker and the arrow are decoration: with every
  // aria-hidden node removed, what remains reads as plain labels and notes.
  const spoken = figure?.cloneNode(true) as HTMLElement
  for (const hidden of spoken.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
  const text = spoken.textContent ?? ""
  expect(text).not.toMatch(/[│├└─✔↓$]/)
  expect(text).toContain("src/app/hello/, the agent")
  expect(text).toContain("npm create b4-app@latest my-agent")
  const agent = figure?.querySelector<HTMLAnchorElement>('a[href="#first-agent"]')
  expect(agent?.textContent?.replace(/\s+/g, " ")).toContain("src/app/hello/")
  expect(agent?.textContent).toContain("the agent")
  // Every row's --i is unique, so no two lines appear at once.
  // Read the attribute: jsdom's CSSStyleDeclaration is unreliable for custom properties.
  const orders = [...(figure?.querySelectorAll("[style*='--i']") ?? [])].map(
    (node) => node.getAttribute("style")?.match(/--i:\s*(\d+)/)?.[1],
  )
  expect(new Set(orders).size).toBe(orders.length)
  expect(orders).toHaveLength(10)
})

it("marks the first-agent section with the dot the terminal's agent row carries", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const eyebrow = container.querySelector('#first-agent [data-ui="eyebrow"]')
  expect(eyebrow?.textContent).toBe("Your first agent")
  expect(eyebrow?.querySelector('span[aria-hidden="true"]')).not.toBeNull()
})
```

In `apps/web/app/seo/seo.test.ts`, replace the `HOME_DESCRIPTION` value:

```ts
const HOME_DESCRIPTION =
  "Build TypeScript agents where files are features: tools, planning, memory, skills, subagents and evals. Scaffold your own app with one command."
```

and, in `bases every snippet claim on visibly rendered homepage sections`, replace the term list with:

```ts
    for (const term of [
      "typescript",
      "tools",
      "planning",
      "memory",
      "skills",
      "subagents",
      "evals",
    ])
```

In `apps/web/app/site-chrome.test.tsx`, replace:

```ts
    // The three olive text uses (the hero's .runtime line, .flowNumber and the
    // ::after arrow); the .receipt border also uses olive but is
    // `border-left: … var(--color-olive)`.
    expect(css.match(/(^|\s)color: var\(--color-olive\);/gm)).toHaveLength(3)
```

with:

```ts
    // The one olive text use: the hero's .runtime line.
    expect(css.match(/(^|\s)color: var\(--color-olive\);/gm)).toHaveLength(1)
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/homepage.test.tsx app/seo/seo.test.ts app/site-chrome.test.tsx`
Expected: FAIL.
- `ends with the install command, and the code-fixer walkthrough is gone`: the page still says `b4 add code-fixer`.
- `names every labelled region uniquely`: there's no `What the model sees` yet.
- The homepage SEO test: the registry's description differs.
- `homepage tokens`: 3 olive uses, not 1.

- [ ] **Step 4: Replace DeveloperHome**

Replace `apps/web/app/components/homepage/DeveloperHome.tsx` with the file below. The hero is unchanged. `FirstAgent`, the recording block, `Walkthrough` and `Narrative` become `<FolderTour />`. In the takeaway, only the second (code-fixer) column goes; the first column and every takeaway class are untouched, because another session owns the takeaway's overflow CSS.

```tsx
import { CopyCommand } from "../ui/CopyCommand"
import { Eyebrow } from "../ui/Eyebrow"
import styles from "./homepage.module.css"
import { ScaffoldTerminal } from "./ScaffoldTerminal"
import { scaffoldTree } from "./scaffold-tree"
import { FolderTour } from "./tour/FolderTour"
import { prepareFolderTour } from "./tour/prepare"

const createCommand = scaffoldTree.command

export async function DeveloperHome() {
  const tour = await prepareFolderTour()
  return (
    <main id="content" tabIndex={-1} className={styles.home}>
      <div className={styles.container}>
        <section className={styles.hero} aria-labelledby="home-title">
          <div className={styles.heroCopy}>
            <Eyebrow className={styles.eyebrow}>An agent framework, the way I'd build it.</Eyebrow>
            <h1 id="home-title">
              Ridiculous speed.
              <br />
              Readable code.
            </h1>
            <p className={styles.lede}>
              Write the agent in TypeScript, give it tools, and set its limits.
              <br />
              You ship code you can actually read.
            </p>
            <p className={styles.runtime}>Runs on LangGraph.js. You keep the graph.</p>
            <div className={styles.heroActions}>
              <CopyCommand command={createCommand} className={styles.command ?? ""} />
              <a href="/docs/getting-started" className={styles.textLink}>
                Get started →
              </a>
            </div>
          </div>
          <div className={styles.heroVisual}>
            <span className={styles.eclipse} aria-hidden="true" />
            <ScaffoldTerminal />
          </div>
        </section>
        <FolderTour {...tour} />
        <section className={styles.takeaway} aria-labelledby="run-title">
          <div>
            <Eyebrow tone="panel" className={styles.eyebrow}>
              Get started
            </Eyebrow>
            <h2 id="run-title">Build your own agent.</h2>
            <p>Scaffold a new B4 app with one command:</p>
            <CopyCommand command={createCommand} variant="dark" className={styles.command ?? ""} />
            <br />
            <a href="/docs/getting-started" className={styles.reportLink}>
              Getting Started →
            </a>
          </div>
        </section>
      </div>
    </main>
  )
}
```

- [ ] **Step 5: Cut highlight.ts and types.ts down to what the tour uses**

Replace `apps/web/app/components/homepage/highlight.ts` with the file below. `prepareHomepage` and `recordedDiff` go; `diff` leaves the highlighter's languages and `json` stays for the playground.

```ts
import "server-only"
import { type BundledLanguage, createHighlighter } from "shiki"
import { COLOR } from "../../../lib/design-tokens"
import { syntaxClassesFor } from "../../../lib/shiki-classes"
import { PAPER_RELAY_THEME } from "../../../lib/shiki-theme"
import type { DisplayCode } from "./types"

const highlighter = createHighlighter({
  langs: ["typescript", "markdown", "json"],
  themes: [PAPER_RELAY_THEME],
})
const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

export async function highlightCode(
  raw: string,
  lang: BundledLanguage,
  path: string,
  url: string,
  firstLine = 1,
): Promise<DisplayCode> {
  const tokens = (await highlighter).codeToTokens(raw.trimEnd(), {
    lang,
    theme: "paper-relay",
  }).tokens
  return {
    raw,
    path,
    url,
    firstLine,
    lines: tokens.map(
      (line) =>
        line
          .map((token) => {
            // Colour only, as before; app/styles/syntax.css holds the classes.
            const style = `color:${token.color ?? COLOR["panel-ink"]}`
            const classes = syntaxClassesFor(style)
            const attribute = classes ? `class="${classes.join(" ")}"` : `style="${style}"`
            return `<span ${attribute}>${escapeHtml(token.content)}</span>`
          })
          .join("") || " ",
    ),
  }
}
```

Replace `apps/web/app/components/homepage/types.ts` with:

```ts
export interface DisplayCode {
  readonly raw: string
  readonly lines: readonly string[]
  readonly path: string
  readonly url: string
  readonly firstLine: number
  readonly fold?: { readonly start: number; readonly end: number }
  readonly wrap?: boolean
  readonly linkLabel?: string
  /** Accessible region name when `path` alone would repeat another panel's. */
  readonly label?: string
}
```

- [ ] **Step 6: Delete the code-fixer files**

```bash
git rm apps/web/app/components/homepage/Walkthrough.tsx apps/web/app/components/homepage/Narrative.tsx apps/web/app/components/homepage/ProjectOverview.tsx apps/web/app/components/homepage/FirstAgent.tsx apps/web/app/components/homepage/evidence.json apps/web/app/components/homepage/evidence.ts apps/web/app/components/homepage/evidence.test.ts apps/web/app/components/homepage/narrative-source.json apps/web/app/components/homepage/narrative-source.ts apps/web/app/components/homepage/narrative-source.test.ts apps/web/app/components/homepage/first-agent-source.json apps/web/app/components/homepage/first-agent-source.ts apps/web/app/components/homepage/first-agent-source.test.ts apps/web/scripts/export-homepage-evidence.mjs
```

- [ ] **Step 7: Delete the dead CSS**

Replace `apps/web/app/components/homepage/homepage.module.css` with the file below. It keeps the hero rules byte for byte (lines 1–130 today, minus `.markerDot`, which moved to `tour.module.css`), the `CodePanel` rules, `.takeaway`/`.reportLink`, `.textLink` and the `.wrapCode` rules. It drops `.sectionHeading`, `.steps`, `.walkthroughGrid`, `.agentSource`, `.proof*`, `.brief`, `.receipt`, `.failure`, `.checks`, `.approval`, `.fileTabs`, `.lower`, `.chapter*`, `.codeCaption`, `.skillNote`, `.recording*`, `.projectOverview` through `.ownership`, and their media-query entries. In the 760px block, `.walkthroughGrid, .takeaway { grid-template-columns: 1fr; }` becomes `.takeaway { … }` with the same declaration, so the takeaway's behaviour doesn't change.

```css
.home {
  background: var(--color-page);
  color: var(--color-ink);
  font-family: var(--font-sans);
  padding: 0 40px 72px;
  /* The hero's eclipse crops at the page edge and under the header. `clip`
     is not a scroll container, so nothing inside becomes scrollable. */
  overflow: clip;
}
.container {
  max-width: 1200px;
  margin: auto;
}
.home * {
  box-sizing: border-box;
}
.home a {
  color: inherit;
}
/* Copy left, the scaffold terminal right; stacked below 960px. */
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 48px;
  align-items: start;
  padding: 64px 0 44px;
  position: relative;
}
.heroCopy {
  min-width: 0;
  position: relative;
  z-index: 1;
}
.eyebrow {
  margin: 0;
}
/* Sized so each headline line fits the copy column at every desktop width. */
.hero h1 {
  font-size: clamp(44px, 4.8vw, 68px);
  line-height: 1.03;
  letter-spacing: -0.055em;
  font-weight: 600;
  margin: 20px 0 24px;
}
.lede {
  font-size: 19px;
  line-height: 1.65;
  max-width: 550px;
  margin: 0;
}
.runtime {
  margin: 12px 0 0;
  font-size: 15px;
  font-weight: 500;
  color: var(--color-olive);
}
/* The eyebrow stays on one line in both the fallback and the loaded mono font,
   so the font swap never shifts the hero. */
.heroCopy > .eyebrow {
  white-space: nowrap;
}
.home h1,
.home h2,
.home h3 {
  text-wrap: balance;
}
.home p {
  text-wrap: pretty;
}
/* Stacked, so the link never moves when the command's mono font swaps in. */
.heroActions {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin-top: 32px;
}
/* One line at every width, so the font swap cannot change the hero's height. */
.home .command {
  max-width: 100%;
  font-size: 13px;
  white-space: nowrap;
}
/* Top-aligned with the headline (eyebrow + its margin). */
.heroVisual {
  position: relative;
  min-width: 0;
  margin-top: 40px;
}
/* The signature dot, as an eclipse behind the terminal's top-right corner.
   Decorative; `.home` crops it at the page edge. Never behind text: it sits
   entirely inside the terminal column's corner. */
.eclipse {
  position: absolute;
  top: -220px;
  right: -220px;
  width: 440px;
  height: 440px;
  border-radius: 50%;
  background: var(--color-relay);
  pointer-events: none;
}
@media (max-width: 959px) {
  .hero {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 72px;
  }
  .heroVisual {
    margin-top: 0;
  }
  /* 60px overshoot above the terminal stays inside the 72px row gap. */
  .eclipse {
    top: -60px;
    right: -60px;
    width: 200px;
    height: 200px;
  }
}
.codePanel {
  --color-focus: var(--color-panel-accent);
  background: var(--color-panel);
  color: var(--color-panel-ink);
  min-width: 0;
}
.codeHeading {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  padding: 2px 18px;
  align-items: center;
  font:
    11px / 1.6 var(--font-mono),
    monospace;
  border-bottom: 1px solid var(--color-panel-rule);
  color: var(--color-panel-muted);
}
.codeHeading > span {
  display: flex;
  align-items: center;
  min-height: 44px;
  overflow-wrap: anywhere;
}
.codeHeading a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  white-space: nowrap;
  text-underline-offset: 3px;
  color: inherit;
}
.code {
  margin: 0;
  padding: 18px 12px 20px;
  font:
    13px / 1.9 var(--font-mono),
    monospace;
  overflow-x: auto;
  background: transparent;
  color: var(--color-panel-ink);
  tab-size: 2;
}
.code code {
  font: inherit;
}
.codeLine {
  display: flex;
  width: max-content;
  min-width: 100%;
  padding-right: 16px;
  border-left: 2px solid transparent;
}
.lineNumber {
  min-width: 36px;
  padding-right: 12px;
  text-align: right;
  color: var(--color-panel-dim);
  user-select: none;
}
.highlightLine {
  background: color-mix(in srgb, var(--color-panel-accent) 15%, transparent);
  border-left-color: var(--color-panel-accent);
}
.fold {
  display: block;
  background: var(--color-panel-strip);
  color: var(--color-panel-ink);
  border: 1px solid var(--color-panel-rule);
  padding: 9px 12px;
  font:
    11px / 1.6 var(--font-mono),
    monospace;
  cursor: pointer;
  margin: 16px 18px 0;
  min-height: 44px;
}
.foldMarker {
  border-left: 2px solid transparent;
  display: block;
  color: var(--color-panel-dim);
  font-style: italic;
}
.codeFooter {
  border-top: 1px solid var(--color-panel-rule);
  padding: 12px 18px;
  display: flex;
  gap: 14px;
  align-items: center;
  font-size: 11px;
  color: var(--color-panel-muted);
}
.codeFooter button {
  color: var(--color-panel-ink);
  background: transparent;
  border: 1px solid var(--color-panel-rule);
  padding: 8px 10px;
  min-height: 44px;
  white-space: nowrap;
  cursor: pointer;
}
.takeaway h2 {
  font-size: clamp(34px, 4.8vw, 54px);
  line-height: 1.06;
  letter-spacing: -0.045em;
  font-weight: 500;
  margin: 0;
}
.takeaway {
  --color-focus: var(--color-panel-accent);
  background: var(--color-panel);
  color: var(--color-page);
  display: grid;
  grid-template-columns: 1fr 1.15fr;
  gap: 40px;
  margin-top: 72px;
  padding: 40px;
}
.takeaway .eyebrow {
  margin-bottom: 18px;
}
.takeaway h2 + p {
  margin: 16px 0 12px;
}
.takeaway p {
  color: var(--color-panel-muted);
  font-size: 14px;
  line-height: 1.7;
}
.reportLink {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  font-size: 13px;
  line-height: 1.7;
  text-underline-offset: 3px;
}
@media (max-width: 760px) {
  .home {
    padding: 0 24px 48px;
  }
  .hero {
    padding-top: 40px;
  }
  .takeaway {
    grid-template-columns: 1fr;
  }
  .takeaway {
    padding: 26px;
    gap: 24px;
    margin-top: 48px;
  }
  .code {
    font-size: 12px;
  }
}
@media (max-width: 430px) {
  .home {
    padding-right: 18px;
    padding-left: 18px;
  }
  .hero h1 {
    font-size: 43px;
  }
  .lede {
    font-size: 17px;
  }
  .codeHeading {
    flex-wrap: wrap;
    row-gap: 0;
  }
  .codeFooter {
    flex-wrap: wrap;
  }
  .takeaway {
    padding: 22px;
  }
  .eyebrow {
    font-size: 11px;
  }
}
.textLink {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  font-size: 13px;
  text-underline-offset: 5px;
}
/* Kept last: biome's noDescendingSpecificity wants these more specific
   .wrapCode rules after the plain .codeLine and .lineNumber rules. */
.wrapCode .codeLine {
  width: 100%;
}
.wrapCode .lineNumber {
  flex-shrink: 0;
}
.wrapCode .codeLine > span:last-child {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
```

Run: `grep -nE "walkthrough|chapter|projectOverview|executionFlow|recording|markerDot|olive" apps/web/app/components/homepage/homepage.module.css`
Expected: exactly one line, `  color: var(--color-olive);` (inside `.runtime`).

- [ ] **Step 8: Update the SEO registry**

In `apps/web/app/seo/registry.ts`, in `HOME_SEO_PAGE`, replace the `description` value with:

```ts
  description:
    "Build TypeScript agents where files are features: tools, planning, memory, skills, subagents and evals. Scaffold your own app with one command.",
```

(143 characters; `seo.test.ts` requires 50–155.)

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/ app/seo/seo.test.ts app/site-chrome.test.tsx app/styles/design-system.test.ts`
Expected: PASS (13 files).

Run: `pnpm --dir apps/web lint && pnpm --dir apps/web typecheck`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git status --short   # expect no apps/web/AGENTS.md, CLAUDE.md or next-env.d.ts changes
git add apps/web/app/components/homepage/DeveloperHome.tsx apps/web/app/components/homepage/highlight.ts apps/web/app/components/homepage/types.ts apps/web/app/components/homepage/homepage.module.css apps/web/app/components/homepage/homepage.test.tsx apps/web/app/seo/registry.ts apps/web/app/seo/seo.test.ts apps/web/app/site-chrome.test.tsx
git commit -m "feat(web): the folder tour replaces the first-agent section and the code-fixer walkthrough

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(The `git rm` deletions from Step 6 are already staged and go into this commit.)

---

### Task 8: Gates

**Files:** none new.

- [ ] **Step 1: Lint**

Run: `pnpm --dir apps/web lint`
Expected: exit 0. If Biome reports formatting, apply the scoped fix from "Rules" to `app/components/homepage scripts/export-homepage-demos.mjs` only.

- [ ] **Step 2: Typecheck**

Run: `pnpm --dir apps/web typecheck`
Expected: exit 0.

- [ ] **Step 3: The full web suite**

Run: `pnpm --dir apps/web test`
Expected: all files pass (55 when this plan was verified, 878 tests plus 1 skipped). Don't pipe it through `tail`: that hides the exit code.

- [ ] **Step 4: The docs check**

Run: `node scripts/check-docs.mjs`
Expected: `Docs completeness check passed.` It scans `apps/web/app`, fixtures included, for banned phrases (`openai:gpt`, `auto-bound` and the rest).

- [ ] **Step 5: Commit any lint fixes**

```bash
git status --short
git add apps/web/app/components/homepage apps/web/scripts/export-homepage-demos.mjs
git commit -m "style(web): format the folder tour

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Skip this commit if nothing changed.

---

### Task 9: Browser, motion and accessibility verification, then lastmod

**Files:**
- Create (scratchpad only, not committed): `<scratchpad>/verify-tour.mjs`
- Modify: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: Start the dev server**

Use the `web` configuration in `.claude/launch.json` (`pnpm --dir apps/web dev --port 3217`) through `preview_start`, or run it in the background. Wait for `http://localhost:3217/` to return 200.

- [ ] **Step 2: Write the verification script**

Find axe: `find ~/repos -maxdepth 6 -name axe.min.js -path '*axe-core*' 2>/dev/null | head -1`. On this machine that's `/Users/blove/repos/event-horizon/node_modules/axe-core/axe.min.js`.

Create `<scratchpad>/verify-tour.mjs`. It uses the repo's `playwright-core@1.62.1` and the installed Chrome, and relies on the `data-tour` hooks, because CSS-module class names are hashed.

```js
import { readFileSync } from "node:fs"
import { chromium } from "/Users/blove/repos/dawn/.claude/worktrees/zen-curie-dd3701/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs"

const [AXE, OUT] = process.argv.slice(2)
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
})
const results = []
for (const [width, height] of [
  [375, 812],
  [768, 1024],
  [1024, 768],
  [1440, 900],
]) {
  for (const reducedMotion of ["no-preference", "reduce"]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion })
    await page.goto("http://localhost:3217/", { waitUntil: "networkidle" })
    await page.locator("#first-agent").scrollIntoViewIfNeeded()
    await page.waitForTimeout(800)
    const facts = await page.evaluate(() => {
      const header = document.querySelector("header")?.getBoundingClientRect().height ?? 0
      const root = document.querySelector('[data-tour="root"]')
      const stage = document.querySelector('[data-tour="stage"]')
      const pinned = root?.getAttribute("data-pinned") === "true"
      const targets = [...document.querySelectorAll("#first-agent button, #first-agent a")]
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 0)
      return {
        horizontalScroll: document.documentElement.scrollWidth > innerWidth,
        pinned,
        stageFits: pinned
          ? (stage?.getBoundingClientRect().height ?? 0) <= innerHeight - header + 1
          : null,
        smallestTarget: Math.min(...targets.map((rect) => Math.min(rect.width, rect.height))),
      }
    })
    if (facts.pinned) {
      // Keyboard: the tree is a tablist; two arrow presses reach plan.md.
      await page.locator('[role="tab"]').first().focus()
      await page.keyboard.press("ArrowDown")
      await page.keyboard.press("ArrowDown")
      await page.waitForTimeout(1500)
      facts.keyboard = await page.evaluate(() => ({
        focused: document.activeElement?.id,
        selected: document.querySelector('[role="tab"][aria-selected="true"]')?.id,
        visible: [...document.querySelectorAll("[data-stop]")]
          .filter((card) => getComputedStyle(card).visibility === "visible")
          .map((card) => card.id),
      }))
    } else {
      // Keyboard: the chip bar is links; Enter on plan.md jumps to its card.
      await page.locator('[data-tour="chips"] a[href="#tour-plan"]').focus()
      await page.keyboard.press("Enter")
      await page.waitForTimeout(1200)
      facts.keyboard = await page.evaluate(() => {
        const header = document.querySelector("header")?.getBoundingClientRect().height ?? 0
        const chips = document.querySelector('[data-tour="chips"]')
        return {
          cardTop: Math.round(document.querySelector("#tour-plan")?.getBoundingClientRect().top),
          chipsTop: Math.round(chips?.getBoundingClientRect().top ?? -1),
          header: Math.round(header),
          current: document.querySelector('[data-tour="chips"] [aria-current="true"]')?.getAttribute("href"),
        }
      })
    }
    // The playground by keyboard: Space on the language toggle.
    await page.locator("#tour-greet").scrollIntoViewIfNeeded()
    if (facts.pinned) {
      await page.locator("#tour-tab-greet").focus()
      await page.keyboard.press("Enter")
      await page.waitForTimeout(1500)
    }
    const language = page.locator('#tour-greet button[aria-pressed]', { hasText: "language" })
    await language.focus()
    await page.keyboard.press("Space")
    await page.waitForTimeout(200)
    facts.playground = await page.evaluate(() => ({
      pressed: document
        .querySelector("#tour-greet button[aria-pressed]:nth-of-type(2)")
        ?.getAttribute("aria-pressed"),
      live: document.querySelector('#tour-greet [aria-live="polite"]')?.textContent,
    }))
    await page.screenshot({ path: `${OUT}/tour-${width}-${reducedMotion}.png` })
    await page.addScriptTag({ content: readFileSync(AXE, "utf8") })
    facts.axe = await page.evaluate(async () => {
      const report = await window.axe.run(document, { resultTypes: ["violations"] })
      return report.violations.map((violation) => `${violation.id} (${violation.nodes.length})`)
    })
    await page
      .locator('[aria-labelledby="run-title"]')
      .screenshot({ path: `${OUT}/takeaway-${width}-${reducedMotion}.png` })
    results.push({ width, height, reducedMotion, ...facts })
    await page.close()
  }
}
await browser.close()
console.log(JSON.stringify(results, null, 2))
```

- [ ] **Step 3: Run it and check every fact**

Run: `node <scratchpad>/verify-tour.mjs "<axe path>" "<scratchpad>" > <scratchpad>/verify.json`
Then: `node -e 'for (const x of require(process.argv[1])) console.log(x.width, x.reducedMotion, x.horizontalScroll, x.pinned, x.stageFits, x.smallestTarget, JSON.stringify(x.keyboard), x.playground.pressed, JSON.stringify(x.axe))' <scratchpad>/verify.json`

Expected (this is what the verification run printed):

| viewport | motion | horizontalScroll | pinned | stageFits | keyboard |
|---|---|---|---|---|---|
| 375×812 | both | false | false | null | chips `current: "#tour-plan"`, `chipsTop === header` (sticky), `header < cardTop < innerHeight / 2` |
| 768×1024 | both | false | false | null | the same |
| 1024×768 | no-preference | false | **true** | **true** | `focused` and `selected` are `tour-tab-plan`; `visible` is `["tour-plan"]` |
| 1024×768 | reduce | false | false | null | chips as above |
| 1440×900 | no-preference | false | **true** | **true** | as at 1024 |
| 1440×900 | reduce | false | false | null | chips as above |

On every row:
- `smallestTarget` ≥ 24: the 32px chips and 36px tabs and toggles; WCAG 2.5.8.
- `playground.pressed` is `"true"`, and `playground.live` is `Required: name, language. Description: Greet someone by name.`
- `axe` is `[]`.

- [ ] **Step 4: Look at the screenshots**

Open each `tour-*.png` and `takeaway-*.png` with the Read tool and check:
- **Pinned (1024 and 1440, motion on):**
  - the tree sits top-left, with the Relay dot on the current row
  - the added files show `+` and are muted until reached
  - the current stop's copy sits under the tree, and its file sits on the right
  - nothing is cut off under the header.
- **The playground:**
  - after `language` is pressed, the `language` and `required` lines carry a `+` and the tint
  - at 1440 the source and the schema sit side by side, and the schema's `"language"` line doesn't wrap.
- **Stacked (375, 768, and reduced motion):**
  - the chip bar sticks under the header
  - chip labels read `+ plan.md` (with the gap), not `+plan.md`
  - cards stack with full content.
- **The takeaway:**
  - one column, with no code-fixer text
  - its right track is empty above 760px. That's expected (Risk 5); note it for the session fixing the takeaway.

Fix anything that fails, rerun Task 8, and commit the fixes with a message naming the defect.

- [ ] **Step 5: Stop the dev server and clean up what it wrote**

Stop the server. Then run `git status --short`. Delete `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` if they appear. If `apps/web/next-env.d.ts` is modified, run `git checkout apps/web/next-env.d.ts`.

- [ ] **Step 6: Regenerate the SEO lastmod manifest**

All content is committed, so the generator dates `/` by the newest commit touching the homepage sources.

Run: `pnpm --dir apps/web seo:lastmod`
Then: `git diff apps/web/app/seo/lastmod.generated.json`
Expected: only the `"/"` entry changes (its date and source digest). If any other route's entry moves, don't commit it: stop and investigate, since no other route's sources changed.

```bash
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate lastmod for the homepage folder tour

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Final full check**

Run: `pnpm --dir apps/web test && pnpm --dir apps/web typecheck && pnpm --dir apps/web lint && pnpm --dir apps/web seo:lastmod:check`
Expected: exit 0 for all four.

---

## Spec coverage checklist (PR 1)

| Spec requirement | Where |
|---|---|
| `gsap` pinned exactly; lockfile updated in the same PR | Task 1, Step 1 (re-fetch main before merge: Risk 7) |
| `motion/gsap.ts`: ScrollTrigger registered once, client-only; `withMotion` over `gsap.matchMedia()` with `reduce`/`no-preference` and cleanup | Task 1 (`registerScrollTrigger`, `withMotion`, 3 tests) |
| `gsap` imported only from client islands under `homepage/` | Task 1 (re-export); `TourClient` is the only importer |
| Playground: 8 real variant files, `name` stays `greet` | Task 2, Step 1; test "records every combination…" |
| Export script (schema part) writes source + `ExtractedToolSchema` | Task 2, Steps 5–6 |
| Test re-runs extraction and reproduces the JSON exactly | Task 2, `schema-variants.test.ts` |
| Playground: three `aria-pressed` toggles, source left / schema right, 600ms `relay-tint` flash, live region with required fields and description | Task 3 (flash tint mixed into the panel: see Deviations) |
| Tour: 7 stops, `my-agent/src/app/hello/`, scaffolded vs `+` added | Task 4 (`tour-stops.ts`), Task 5 (tree) |
| Stops 1, 2, 7 read the real `app-basic` files, pinned | Task 4, "shows each file exactly as it is on disk" plus the template-origin test |
| Stops 3–6 fixtures typechecked against `@b4run/sdk` | Task 4, Step 6 (typecheck and mutation check) |
| Every docs link has an anchor that exists | Task 4, "links every stop to a docs heading that exists" (`DOCS_INDEX`, `github-slugger`) |
| Desktop pin (≥ 960px, motion on), snap to each stop, `end = stops × 70vh` | Task 5 (`DESKTOP`, `ScrollTrigger.create`); Task 9 row checks |
| Tablist: arrows, Home, End; activating scrolls to the stop | Task 5, first test; Task 9 keyboard facts |
| Relay dot slides between rows over 250ms | Task 5 (`slide` tween) |
| Panel fades in with a 12px lift over 300ms (`power2.out`) | Task 5 (`show` tween) |
| Added files ghosted, then settle | Task 5 (`data-settled`, `settle` tween) |
| Below 960px: stacked cards and a sticky chip bar marked by IntersectionObserver | Task 5 (second test); Task 9 `chipsTop` |
| No JS / reduced motion: stacked, no pin, every panel visible | Task 6 SSR test; Task 5 third test; Task 9 reduce rows |
| Content visible by default; hidden only by JS just before it animates | Task 6 (no `style` on any SSR card); Task 5 (`autoAlpha` only while pinned; cleared on unpin) |
| Hero's `#first-agent` link keeps working | Task 7 homepage tests (`a[href="#first-agent"]` and `#first-agent`) |
| Motion only on transform, opacity and colour; one pinned section | Task 5 (`y`, `x`, `autoAlpha`; CSS colour transitions); a single `ScrollTrigger` |
| Accessibility: native buttons and links, 24px targets, `aria-live`, colour never the only signal | Tasks 3 and 5 (`■`/`□`, `+` gutter, underline on the current chip); Task 9 `smallestTarget` and axe |
| Design system: tokens only, radius 0/50%, guard passes | Tasks 3, 5 and 7 (the design-system test runs in each) |
| Server shells render the content; islands are leaves | `FolderTour` (server) → `TourClient`/`SchemaPlayground` (client) |
| Remove the code-fixer (components, evidence, narrative-source, first-agent-source, export script, tests, dead CSS) | Task 7, Steps 1, 6 and 7 |
| `highlight.ts` stays if still used | Task 7, Step 5 (kept, cut down to `highlightCode`) |
| Takeaway loses only its code-fixer column | Task 7, Step 4 (no takeaway CSS change beyond the dead `.walkthroughGrid` selector) |
| Tests updated, including the `site-chrome` olive pin | Task 7, Step 2 |
| Page is hero → tour → closing CTA | Task 7, "opens with the install command, then the folder tour…" |
| Playwright + axe at 375/768/1024/1440, motion on and reduced | Task 9, Steps 2–4 |
| `pnpm --dir apps/web test`, `typecheck`, `lint`, then `seo:lastmod` committing only `/` | Tasks 8 and 9 |
| `next dev` traps; explicit staging | Rules; Task 9, Step 5; every commit step |
