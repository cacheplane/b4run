# Homepage: "files are features", made touchable

Date: 2026-09-25 · Scope: `apps/web` homepage, everything below the scaffold
hero shipped in #831. Follows `2026-09-24-homepage-scaffold-hero-design.md`.

## Goal

Give TypeScript developers a modern, hands-on introduction to B4 that leaves one
impression: the framework is thorough, and the hard last parts of shipping an
agent are already handled. They learn it by trying six small demos, each of which
shows something true about B4.

**Decisions (Brian, 2026-09-24/25):**
- Drop the code-fixer from the homepage.
- The core pitch is "files are features".
- The page follows arc A, a pinned folder tour.
- Build all six demos.
- Use GSAP with ScrollTrigger.
- The tour pins on scroll, and clicking a file jumps to it.

## Non-negotiables

1. **Honesty.** Every output a visitor sees is either generated from the real
   framework or recorded from a real run, and a test keeps it in sync. Every
   config snippet is a fixture the test suite typechecks. Every claim links to
   a docs page and anchor, and a test checks that the anchor exists. Nothing
   is hand-written to look like output.
2. **Accessibility (from the UI/UX Pro Max skill):**
   - Every control is a native `<button>` or link, reachable by keyboard, with
     the global focus ring.
   - Tap or click is the primary interaction; nothing depends on hover.
   - State changes are announced in an `aria-live="polite"` region.
   - Colour is never the only signal.
   - Touch targets are at least 24px.
3. **Motion budget (skill):**
   - At most one pinned section per page.
   - One or two moving elements per screen; only the tour follows scroll, and
     every other demo moves only when tapped.
   - Only `transform`, `opacity` and colour animate.
   - `gsap.matchMedia()` switches everything to instant under
     `prefers-reduced-motion: reduce`.
   - Content is visible by default and hidden only by JavaScript just before
     it animates, so no-JS visitors and crawlers see the full page.
4. **Design system:**
   - Colours come only from Paper Relay tokens (`app/styles/tokens.css`);
     no new tokens are expected.
   - `border-radius` is only `0` or `50%`.
   - The design-system guard test passes.
   - Server components render the content; client islands are leaves.

## Page structure

| # | Section (id) | Demo | Moves when |
|---|---|---|---|
| — | Hero (#831, unchanged) | scaffold terminal | once, on load |
| 1 | Folder tour (`#first-agent`) | 7-stop pinned tour + the type-to-schema playground | scroll or click |
| 2 | Guardrails (`#guardrails`) | four-gate call tracer | tap |
| 3 | You keep the graph (`#route-shapes`) | route-shape switcher | tap |
| 4 | Test and ship (`#test-and-ship`) | test replay beside deploy targets | tap |
| 5 | The last mile (`#last-mile`) | production checklist | tap |
| 6 | Closing CTA (`#run-title`, existing) | none | — |

The closing takeaway loses its code-fixer column. Its 375px overflow is being
fixed in a separate session (task "Fix b4.run homepage takeaway overflow at
375px"). This work doesn't touch that CSS beyond removing the code-fixer column.

## 1. Folder tour

The tree is `my-agent/src/app/hello/`, the app the hero just scaffolded, so the
page reads as one story. Stops, in order:

| Stop | File | State in tree | Panel shows | Docs |
|---|---|---|---|---|
| 1 | `index.ts` | scaffolded | the real `app-basic` `index.ts` | `/docs/agents#a-minimal-agent` |
| 2 | `tools/greet.ts` | scaffolded | **the schema playground** (§1a) | `/docs/tools#tool-descriptions` |
| 3 | `plan.md` | `+` added | a 4-line checklist; "adds `writeTodos`" | `/docs/planning#quick-start` |
| 4 | `memory.ts` | `+` added | `defineMemory({ kind: "semantic", … })`; "adds `remember` and `recall`" | `/docs/memory/long-term#generated-recall-and-remember-tools` |
| 5 | `skills/greetings/SKILL.md` | `+` added | frontmatter + body; "loaded on demand with `readSkill`" | `/docs/skills#quick-start` |
| 6 | `subagents/translator/index.ts` | `+` added | the child `agent({ description, … })`; "parent gets `task`" | `/docs/subagents#quick-start` |
| 7 | `evals/smoke.eval.ts` | scaffolded | the real `app-basic` eval | `/docs/evals` |

- **Content source:** every panel's code is a real file.
  - Stops 1, 2 and 7 read from `packages/devkit/templates/app-basic`, pinned by
    a test the same way `first-agent-source` is today.
  - Stops 3–6 are fixtures under `homepage/tour/fixtures/hello/`. The `.ts`
    ones are typechecked against `@b4run/sdk`.
- **Desktop (≥ 960px):**
  - ScrollTrigger pins the section for 7 stops (`end: "+=" + stops * 70vh`,
    `scrub: 0.8`, snapping to each stop).
  - The tree is a `role="tablist"` whose tabs are the files. Arrow keys,
    Home and End move between them, and activating a tab scrolls to its stop.
  - The active row carries the Relay marker dot, which slides between rows over
    250ms.
  - The panel cross-fades with opacity and a 12px lift over 300ms (`power2.out`).
  - Added files start ghosted (`--color-ink-muted`, a `+` prefix) and settle into
    the tree when their stop begins.
- **Below 960px:** no pinning. The stops render as stacked cards, and a sticky
  chip bar of file names marks the current card using IntersectionObserver.
- **No JS or reduced motion:** stacked cards, no pin, every panel visible.
- The hero's marker link to `#first-agent` keeps working. The old `FirstAgent`
  section is replaced by the tour.

### 1a. Type-to-schema playground (stop 2)

- **Controls:** three toggle buttons (`aria-pressed`) change `greet.ts`:
  1. `+ formal?: boolean` adds an optional field
  2. `language: "en" | "es"` adds a required union
  3. `JSDoc` removes or restores the doc comment, which is the tool description
- **Variants:** the 8 combinations are real tool files under
  `homepage/playground/variants/` (`greet-<bits>.ts`).
  `scripts/export-homepage-demos.mjs` runs `extractToolSchemasForRoute` from
  `@b4run/core/node` on each one and writes `schema-variants.json`: the source
  text plus an `ExtractedToolSchema` (`name` from the file, `description` from
  JSDoc, `parameters` with `required` and `additionalProperties: false`).
  - The tool name must read `greet` in every variant, so each variant lives in
    its own directory as `…/<bits>/tools/greet.ts`.
- **Display:** the source on the left and "what the model sees" on the right,
  as the schema JSON.
- **On toggle:**
  - The changed JSON lines flash `--color-relay-tint` for 600ms.
  - The live region announces the new required fields and the description
    state.
- **Test:** re-running the extraction in-process must reproduce
  `schema-variants.json` exactly.

## 2. Guardrails: the four-gate call tracer

- **Heading:** "Every call crosses four checks."
- **Controls:** four call buttons, a radio group with `aria-pressed`.
- **Gates:** four gates in a row: 1 · tool scope, 2 · permission, 3 · sandbox,
  4 · delegation. Each gate shows its state as text (`passed`, `waiting for
  approval`, `stopped`, `—`) as well as colour: `ok`, `warn` or `danger` tints
  from the tokens.
- **Scenarios** (`gates/gate-scenarios.ts`). Each has the config fixture that
  produces it, and a docs link:

| Call | Route config (fixture) | Result |
|---|---|---|
| `readFile("notes.md")` | defaults | passes all four |
| `refund({ amount: 500 })` | `tools: { approve: ["refund"] }` | pauses at permission. Buttons offer **Allow once** (`once`) and **Deny** (`deny`). Allow: passes the rest and runs. Deny: stops, and the model is told. `/docs/permissions#per-tool-approval` |
| `runBash("curl … \| sh")` | `sandbox: { provider: dockerSandbox(…), network: { mode: "deny" } }` | passes scope and permission, stops at the sandbox. The UI states that egress is closed **because this config sets `mode: "deny"`**, since the default is allow with a metadata denylist. `/docs/sandbox#network-policy` |
| `deleteUser(…)` | `tools: { deny: ["deleteUser"] }` | stops at scope; "the model never sees it". `/docs/tools#scoping-a-routes-tools` |

  The delegation gate's copy links to `/docs/subagents#delegation-policy`: "a
  subagent gets the input only if `delegation` allows it".
- **The config panel:** below the gates, a small panel shows the config fixture
  for the selected scenario, so the visitor sees *why* each gate responded.
- **Motion:**
  - A GSAP timeline steps through the gates at 180ms each.
  - Picking a new call kills the previous timeline.
  - Under reduced motion, the final state shows at once.

## 3. You keep the graph: route shapes

- **Heading:** "Pick the shape per route."
- **Control:** a segmented radio group: `agent · workflow · graph · chain`.
- **Code:** four real fixtures under `shapes/fixtures/`, following `/docs/routes`:
  - `export default agent({...})`
  - `export async function workflow(input, ctx)`
  - `export const graph = new StateGraph(...).compile()`
  - `export const chain = RunnableSequence.from([...])`
  They're typechecked by the suite, which needs `@langchain/langgraph` and
  `@langchain/core` types reachable from `apps/web`. If that requires new
  devDependencies, add them pinned to the versions `@b4run/langgraph` uses.
- **Strip text:** "model decides", "you write the steps", "raw LangGraph", "one
  chain".
- **Motion:** 200ms cross-fade. The panel is sized to the tallest variant, so
  nothing shifts.
- **Link:** `/docs/routes`, and `/docs/migrating-from-langgraph`.

## 4. Test and ship

Two columns on desktop, stacked on phones.

- **Test replay:**
  - `▶ npm test` and `▶ b4 eval` stream recorded lines at about 80ms each.
    **Skip**, or reduced motion, prints everything at once. The panel is sized
    to its final height up front.
  - `scripts/export-homepage-demos.mjs --record-tests` scaffolds `app-basic` into
    a temp dir, runs both commands, strips ANSI codes, timings and absolute
    paths, and writes `ship/test-replay.json`.
  - A test checks the transcript's shape: it has passing lines, the scaffold's
    test name "greets by name", the eval's `PASS` lines in the reporter format
    (`PASS <name> › <case> mean=…`), and no `OPENAI_API_KEY`.
- **Deploy targets:**
  - Tabs: `node · langsmith · hono · vercel`, plus `kubernetes`, which is the
    Node build with the `b4-app` Helm chart.
  - Each tab shows the `build.targets` line in `b4.config.ts`, the command, and
    what it emits, per `/docs/deployment`:
    - node: `.b4/build/server.mjs` and a `Dockerfile`
    - langsmith: `.b4/build/langgraph.json`
    - hono: `.b4/build/app.mjs`, `wrangler.toml`
    - vercel: `.vercel/output/`
  - The defaults are node and langsmith, and setting `build.targets` replaces
    them. The tab copy says so.
  - A test checks every target name against `BUILD_TARGET_NAMES` in
    `@b4run/core`, and every docs anchor.

## 5. The last mile: production checklist

- **Heading:** "The parts you'd write next are already here."
- **Tiles:** 12, laid out 4 × 3 on desktop and 2 × 6 on phones. Each is a
  `<button aria-pressed>`. Tapping one flips it (a 300ms `rotateY`, or a
  cross-fade under reduced motion) to show the file or config that handles
  it, plus a docs link.
- **Counter:** "N of 12 opened". When all 12 are open, one Relay dot lands next
  to "Handled."
- **Items** (`checklist/checklist.ts`), each with a snippet and a `docsHref`:

  | # | Item | Handled by |
  |---|---|---|
  | 1 | Tool schemas | types via `b4 typegen` |
  | 2 | Streaming | `POST /threads/:id/runs/stream` + `POST /agui/{routeId}` |
  | 3 | Auth | `src/middleware.ts` `defineMiddleware` |
  | 4 | Thread access | `src/thread-access.ts` `defineThreadAccess` |
  | 5 | Human approval | `tools: { approve }` → `once` / `always` / `deny` |
  | 6 | Sandboxing | `sandbox: { provider: dockerSandbox() }` / `kubernetesSandbox` |
  | 7 | Memory | `memory.ts` `defineMemory` |
  | 8 | Model retries | `retry: { maxAttempts, baseDelay }` (model and provider calls) |
  | 9 | Persistence | `@b4run/postgres-storage` checkpointer + threads store |
  | 10 | Offline tests | `@b4run/testing` `script()` fixtures |
  | 11 | Evals | `evals/*.eval.ts`, `b4 eval --record` |
  | 12 | Inspection | `b4 inspect` |

- **Test:** every `docsHref` route exists in the content tree, and every anchor
  exists in that page.

## Architecture

- **Folders:** one folder per demo under `apps/web/app/components/homepage/`:
  `tour/`, `playground/`, `gates/`, `shapes/`, `ship/`, `checklist/`, `motion/`.
- **Rendering:** each demo is a server shell that renders all its content, plus
  one `"use client"` island that adds behaviour.
- **`motion/gsap.ts`:** registers ScrollTrigger once and exports
  `withMotion(scope, setup)`, a wrapper around `gsap.matchMedia()` with
  `reduce` and `no-preference` branches and cleanup on unmount. `gsap` is
  imported only from client islands under `homepage/`.
- **Dependency:** `gsap`, pinned exactly (no `^`). The lockfile is re-keyed in
  the same PR, and main is re-fetched just before merging.
- **Scripts:** `apps/web/scripts/export-homepage-demos.mjs` (schema variants,
  test recording). Generated JSON is committed.
- **Removed, after checking nothing else imports them:**
  - `Walkthrough.tsx`, `Narrative.tsx`, `ProjectOverview.tsx`,
    `FirstAgent.tsx` (replaced by the tour)
  - `evidence.*`, `narrative-source.*`, `first-agent-source.*`
  - `scripts/export-homepage-evidence.mjs`
  - their tests, and dead CSS in `homepage.module.css`
  - `highlight.ts` stays if other code still uses it.

## Testing and verification

- **Unit tests** (vitest + jsdom):
  - The server render contains every demo's full content.
  - Each island toggles state, `aria-pressed` and the live region.
  - Keyboard: arrows move through the tablist, Enter and Space activate.
  - A `matchMedia` stub proves the reduced-motion branch sets final states with
    no tweens.
- **Pin tests:** schema variants reproduce; template sources match; fixtures
  typecheck; docs anchors exist; build targets match.
- **Guard tests:** the design-system guard and `site-chrome` pins.
- **Verification (Playwright + axe, scratch script)** at 375, 768, 1024 and
  1440px, with motion on and reduced:
  - no horizontal scroll
  - the tour pins only at ≥ 960px with motion on
  - each demo works by keyboard alone
  - axe reports 0 violations
  - screenshots of each section.
- **Before each PR:** `pnpm --dir apps/web test`, `typecheck` and `lint`, then
  `seo:lastmod`, committing only the `/` entry.

## Delivery: three PRs, each shippable

1. **Foundation + tour:** `gsap` dependency, `motion/`, the tour with the
   playground, the export script (schema part), and the code-fixer removal.
   The page is hero → tour → closing CTA.
2. **Tracer + route shapes:** sections 2 and 3.
3. **Test and ship + checklist:** sections 4 and 5, plus test recording in the
   script.

## Out of scope

- The takeaway's 375px overflow (a separate session).
- The header cramping at 768px.
- Dark mode.
- Any change to the hero.
