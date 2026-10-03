# Homepage Files Tour, PR 3 (Test and ship + The last mile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the last two demo sections between "You keep the graph" (`#route-shapes`) and the closing takeaway:

1. **Test and ship** (`#test-and-ship`): the scaffold's recorded `npm test` and `b4 eval`, replayable line by line, beside a deploy-target switcher (`node · langsmith · hono · vercel · kubernetes`) that shows the `b4.config.ts` line and the recorded `b4 build` output for each.
2. **The last mile** (`#last-mile`): twelve tiles, each a toggle button that turns over to show what in B4 handles that part of shipping, with a real code excerpt and a docs link, and an "N of 12 opened" counter that says "Handled." at twelve.

**Architecture:**

- **Pattern.** As in PR 1 and PR 2: server shells render everything; `"use client"` leaf islands (`TestReplay`, `DeployTargets`, `ProductionChecklist`) add behaviour. `gsap` comes only through `motion/gsap.ts` (`withMotion`, `REDUCE`/`FULL`); tests use `motion/media-stub.ts`.
- **Recorded, not written.** `apps/web/scripts/export-homepage-demos.mjs` gains `--record-tests` and `--record-builds`. Both scaffold the basic app with this checkout's `create-b4-app --mode internal` into a temp directory, `pnpm install --prefer-offline`, and run the real commands with `OPENAI_API_KEY` deleted from the environment:
  - `--record-tests`: `npm test -- --reporter=verbose` and `npx b4 eval` → `ship/test-replay.json`.
  - `--record-builds`: `npx b4 build` under the scaffold's own `b4.config.ts` (the defaults), then under each `ship/fixtures/targets/<target>.ts` → `ship/build-outputs.json`.
  - Transcripts lose ANSI codes, timings and the temp path, and nothing else (`normalizeTranscript`, unit-tested).
- **Pinned to the source of truth.** `ship.test.ts` pins the replay to the template's test name, eval name and case, and test script, and pins the eval lines to the CLI reporter's two template literals in `packages/cli/src/commands/eval.ts`. It pins the targets to `BUILD_TARGET_NAMES`, each recorded config to its typechecked fixture, the defaults and the replacement rule to the recorded `targets:` lines, and the Kubernetes commands to the docs page. `checklist.test.ts` pins every excerpt to a real file, line for line, and runs the handler where one can run: the tool-schema extractor, the middleware, the thread-access policy, the CLI's command registry.
- **Rendering rules from the PR 1 and PR 2 reviews.** Every variant is mounted in one grid cell (`visibility: hidden` + `aria-hidden` + `inert` when inactive), so nothing shifts. Semantic state and the announcement change in the handler; GSAP only animates, the next action kills it and clears inline `opacity` and `transform`, and reduced motion starts no tweens.

**Tech Stack:** Next.js 16, React 19, CSS modules, GSAP 3.15.0 (through `motion/gsap.ts`), Vitest 4 with jsdom 30, Biome. Tests use the workspace's built `@b4run/core`, `@b4run/cli`, `@b4run/sdk`, `@b4run/sandbox`, `@b4run/permissions` and, new in this PR, `@b4run/postgres-storage`.

**Spec:** `docs/superpowers/specs/2026-09-25-homepage-files-tour-design.md`, sections "4. Test and ship" and "5. The last mile: production checklist", plus Non-negotiables, Architecture, Testing and the Scripts note. This is PR 3 in the spec's "Delivery" section.

**Base branch:** `blove/homepage-tracer-shapes-impl` (PR #851, not merged yet). Work on `blove/homepage-ship-checklist`, created from it. Rebase onto main once #851 merges.

**How this plan was checked:** every code block below was written into a worktree on the base branch and run before the plan was committed, and then removed. The code blocks are the verified files, copied verbatim. These checks all passed:

- the recorder: `node apps/web/scripts/export-homepage-demos.mjs --record-tests --record-builds` (22s, no network needed with a warm pnpm store); its JSON output is reproduced below
- `pnpm --dir apps/web lint` and `pnpm --dir apps/web typecheck`
- the full `pnpm --dir apps/web test`: 64 files, 960 passed, 1 skipped
- `node scripts/check-docs.mjs` and `pnpm check:build-cache`
- the Task 8 Playwright + axe script: Chromium at 375, 768, 1024 and 1440 with motion on and reduced (8 rows), plus the WebKit focus and keyboard pass at 375 and 1024

Three mutation checks failed as they should: dropping the checklist's focus rescue reds "keeps focus on the tile's button when a turn would strand it"; changing the hono fixture to `["node", "hono"]` reds "builds each target with its own typechecked config"; dropping `keepFocus` from the replay buttons reds "puts focus on a replay button when a click leaves it on an ancestor".

Not executed during verification: Task 8 Step 6 (lastmod), which needs the implementation committed first.

## Risks and decisions

Items marked **Decision** need Brian.

1. **Decision: the test command shows `--reporter=verbose`.** Plain `npm test` in the scaffold prints only `Test Files 1 passed (1)` and `Tests 1 passed (1)`; vitest 4's default reporter never names a passing test, in a TTY or not (checked both ways). The spec wants the transcript to contain "greets by name", so the recording runs, and the page shows, `npm test -- --reporter=verbose`. The alternatives are to show plain `npm test` with no test name (and drop that spec assertion), or to change the template's `test` script, which is a product change outside this PR.
2. **Decision: one new devDependency, `@b4run/postgres-storage` (`workspace:*`).** The persistence tile's excerpt comes from a fixture `b4.config.ts` that has to typecheck against the real package. The fixture uses `createPostgresPool` from `@b4run/postgres-storage/node`, so `apps/web` needs no `pg` or `@types/pg` of its own (the package's declarations resolve them from its own `node_modules`). The lockfile diff is 3 added lines in the `apps/web` importer, and no package or snapshot changes. `pnpm check:build-cache` passes. The fallback, if Brian doesn't want it, is to pin the excerpt to the `/docs/configuration#postgres-backend` code block instead of a typechecked fixture, which is weaker.
3. **Decision: the recording is a manual step, not a CI job.** The scaffold installs third-party packages (`vitest`, `typescript`, `zod`, `@types/node`, and for builds `hono`, `@neondatabase/serverless`, `@langchain/openai`). `--prefer-offline` reads pnpm's store first, and falls back to the npm registry for anything missing, which a CI runner's store would be. It also takes about 22 seconds. So CI runs only the shape and pin tests on the committed JSON. Drift is still caught: the tests fail if the template's test name, eval name or case, or test script changes, if the reporter's format strings change, if a target fixture changes without a re-record, or if `BUILD_TARGET_NAMES` gains a target. Re-recording is one command. No API key is ever needed.
4. **Decision: the checklist excerpts are short.** Each tile shows the file path and one to two real lines (the sandbox line wraps to three at 375px), not the whole file, because twelve whole files don't fit a 2 × 6 phone grid. Every line is pinned to a real file (typechecked fixture, tour fixture, or template file typechecked by the generated-app harness).
5. **Decision: the server renders every tile turned over.** The spec requires the no-JS page to show each tile's answer. So the server HTML (and no-JS visitors, and crawlers) get all twelve answers, `aria-pressed="true"` and "12 of 12 opened · Handled."; the island turns them face down in its first effect, without an announcement. A visitor who is already scrolled to `#last-mile` during hydration sees the tiles turn once. It's far below the fold, so in practice nobody does. If focus is already on an answer's docs link, it moves to that tile's button (tested with `hydrateRoot`).
6. **The recording needs a built checkout.** `create-b4-app --mode internal` wires every `@b4run/*` dependency to this checkout's `packages/*` by `file:` override, and those resolve to `dist/`. Run `pnpm build` first.
7. **`seo:lastmod:check` is red on the base branch.** As in PR 2, Task 8 splices in only the `/` entry.

## Deviations from the spec, and why

- **Deploy targets are native radios in a `<fieldset>`, not tabs.** This matches the nearest sections (PR 2's call tracer and route-shape switcher), gives arrow, Home and End keys natively, and needs no roving-tabindex code. The chosen cell gets the tint and an ink border as well as the filled radio. The five targets wrap at 375px, and the cells overlap by 1px so borders never double.
- **Kubernetes shows the Node build, then the docs' own `docker build` and `helm install` commands**, verbatim from `/docs/deployment/kubernetes` (pinned). There's no `kubernetes` build target; `b4 build` can't emit it.
- **Each target's config lists only that target.** The docs show `["node", "hono"]` and `["node", "vercel"]`; a single-target list is valid, and it lets each tab's recorded output show exactly that target's files. The column note says "node and langsmith are the defaults. Setting build.targets replaces them.", proven by the recorded default build (`targets: node, langsmith`) and the recorded `["hono"]` build (`targets: hono`).
- **The replay announces once per action, at the action.** The rule from the reviews is one announcement per action, set immediately, and never dependent on an animation finishing. A start announcement followed by an end announcement would be two per action, and the end one would wait on the stream. So pressing **Replay** sets one polite message, `Replayed npm test -- --reporter=verbose. Tests 1 passed (1).`, and the lines only fade in. Replaying the same run twice in a row alternates the wording ("… again."), so every press changes the text. **Skip** changes no state and announces nothing.
- **The log is `role="log"` with `aria-live="off"`.** `role="log"` tells assistive technology this is a sequential transcript that can be read or navigated line by line; `aria-live="off"` overrides the role's implicit polite live region, so the lines themselves are never read out one by one. The single polite region beside it carries the per-action message. Every line is in the DOM from the start (only its opacity animates), so the panel is its final height up front and a screen-reader user can read the whole transcript at any time.
- **The line hook is `data-replay-line`, not `data-line`.** `app/styles/ui.css` pads every `pre [data-line]` for MDX code blocks, which indented the log (caught in the first screenshots). A test asserts the log has no `pre [data-line]`.
- **Tiles: a toggle button above two faces, not a button that flips.** A `<button>` can't contain the docs link. So each tile is an `<li>` with a `<button aria-pressed>` (the number and title), which never moves, above a two-face grid cell: the front says what you'd otherwise write, the back says what handles it, with the path, the excerpt and the docs link. The face not showing is `visibility: hidden`, `aria-hidden` and `inert`. The flip is a 300ms `rotateY` from -90° on the face now showing, with `backface-visibility: hidden` and an 800px perspective; under reduced motion it's an instant swap. Focus stays on the button, so it can't be stranded on a face.
- **"N of 12 opened" counts tiles currently turned over**, which is what `aria-pressed` says. Turning one back decrements it. "Handled." (with the decorative Relay dot, `aria-hidden`) keeps its space while hidden, so it never moves anything.
- **The grid is 2 columns on phones, 3 from a 560px container, 4 from 880px.** The spec says 4 × 3 on desktop and 2 × 6 on phones; tablets get 3 × 4.
- **WebKit focus.** Safari doesn't focus a clicked button, and WebKit moves focus on mousedown to the nearest focusable ancestor (`<main tabindex="-1">`). Every control here hands focus back: the deploy radios (the PR 2 rule), the tile buttons, and the replay and Skip buttons (`keepFocus`), so the next Tab continues from the control.
- **Headings.** Section 4 had none in the spec; it's "Test it offline, then pick where it runs." Section 5 uses the spec's "The parts you'd write next are already here."

## Spec assumptions that are wrong in the code

- **"`npm test` … has the scaffold's test name 'greets by name'" is false for plain `npm test`.** See Risk 1.
- **The eval reporter prints two kinds of line**, not one: `PASS greets by name › ada mean=1.00 [contains(Hello)=1.00]` per case (with the scorer detail in brackets), then the suite verdict `PASS greets by name mean=1.00` (`printReport` in `packages/cli/src/commands/eval.ts`). The spec's `PASS <name> › <case> mean=…` is the first kind.
- **The node target writes more than `server.mjs` and a `Dockerfile`**: `.b4/build/workspace.json`, `.b4/build/modules.mjs`, `.b4/build/server.mjs` and `Dockerfile` (at the app root, not in `.b4/build`). The page shows the recorded list.
- **The langsmith target writes one `.b4/build/<route>.ts` per route** as well as `langgraph.json`.
- **The hono target writes four files**: `.b4/build/modules.edge.mjs`, `stores.mjs`, `app.mjs`, and `wrangler.toml` at the app root. Without `@b4run/postgres-storage`, `@neondatabase/serverless` and `hono` in `dependencies` it still builds but prints a warning, so the recorder adds them.
- **The vercel target fails to build in a bare scaffold.** esbuild can't resolve `hono`, `@langchain/openai`, `@b4run/postgres-storage` and `@neondatabase/serverless`, because the function must bundle every dependency (`/docs/deployment/vercel#select-the-target`). The recorder adds them. It writes `.vercel/output/config.json`, `.vercel/output/functions/b4.func/.vc-config.json`, `.vercel/output/functions/b4.func/index.mjs` and a root `vercel.json`.
- **"The defaults are node and langsmith, and setting `build.targets` replaces them" is right** (`DEFAULT_BUILD_TARGETS` and `config?.build?.targets ?? DEFAULT_BUILD_TARGETS` in `packages/cli/src/commands/build.ts`), and the recordings prove it.
- **Streaming is `POST /threads/:thread_id/runs/stream`**, not `:id` (the runtime's route comment and `/docs/dev-server/agent-protocol`). `POST /agui/{routeId}` is right (the docs' spelling; the runtime comment says `:routeId`).
- **Retries don't cover "provider calls" in general, or every 5xx.** `retry: { maxAttempts, baseDelay }` on `agent()` retries model calls whose error matches a rate limit (`429`, "rate limit"), `500`/`502`/`503`, a network error, or OpenAI's "overloaded"/"server_error" (`/docs/retry#whats-retried`). A streaming call retries only before anything has streamed, and always with a 1s base delay. The tile says "Model calls that hit a rate limit, a server error or a network error retry with backoff."
- **Persistence is three stores, not two.** The Postgres backend is the checkpointer, the thread store and the permission store, wired to one pool (`/docs/configuration#postgres-backend`). The fixture wires all three.
- **`dockerSandbox()` needs `scope` and `image`** (or `images`). `sandbox` goes in `b4.config.ts`. Enforcement of `network` depends on the provider (`/docs/sandbox#whats-isolated`); the page makes no network claim at all, and doesn't mention the default denylist.
- **`b4 inspect` inspects long-term memory**, not traces or threads: it opens the Inspector, whose one panel is Memory (`/docs/inspector`). The scaffold ships `@b4run/inspector`, so it works there (pinned).
- **`b4 eval --record` needs `OPENAI_API_KEY` and skips cases with inline fixtures.** The scaffold's smoke eval has inline `script()` fixtures, so `--record` wouldn't write anything for it. The tile says only that `--record` "captures new fixtures from the model".
- **`src/thread-access.ts` isn't deny-by-default for an app that doesn't have one.** Without the file, every thread endpoint is open (the template's `thread-access.ts.example` says so). The tile says only what the policy decides.
- **The eval file is `smoke.eval.ts.template` in the template**, like the test (`agent.test.ts.template`). The scaffold writes them without `.template`; the page shows the scaffolded paths.

**Rules that apply to every task** (from `AGENTS.md`, PR 1 and PR 2's plans, and the website design system):
- Run commands from the repo root, on Node 24: `source ~/.nvm/nvm.sh && nvm use 24`.
- Build first: `pnpm build`. The tests load `@b4run/*` from `dist/`, and the recorder scaffolds from `packages/create-b4-app/dist`.
- In `app/`: no hex, `rgba()`, `hsl()` or named colours in CSS; `border-radius` only `0` or `50%`; never the words `rounded` or `shadow-x`, even in comments; all colours are `var(--color-*)` from `app/styles/tokens.css`; no `--color-olive` text. `app/styles/design-system.test.ts` enforces this, fixtures included.
- No em dash in user-facing copy (`homepage.test.tsx` checks the rendered page; `checklist.test.ts` checks each item).
- `exactOptionalPropertyTypes` is on: never write `{ x: undefined }`.
- Never run bare `biome check --write`. Use `pnpm --dir apps/web lint`; for fixes, the scoped `pnpm --dir apps/web exec biome check --write --config-path ../../packages/config-biome/biome.json --css-parse-tailwind-directives=true <paths>`.
- Import `gsap` only through `app/components/homepage/motion/gsap.ts`, and only from `"use client"` islands.
- `next dev` writes `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` and can touch `apps/web/next-env.d.ts`. Never commit them. Stage explicit paths only, and run `git status --short` before every commit.
- Never use `git stash`, never `pkill`, and never kill a process you didn't start.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File Structure

All paths are under `apps/web/app/components/homepage/` unless shown from the repo root.

| File | Responsibility |
|---|---|
| Modify `apps/web/package.json`, `pnpm-lock.yaml` | `@b4run/postgres-storage` devDependency (Task 1). |
| Modify `apps/web/scripts/export-homepage-demos.mjs` | `--record-tests`, `--record-builds`, `normalizeTranscript`, `recordingEnv` (Task 2). |
| Create `ship/fixtures/targets/{node,langsmith,hono,vercel}.ts` | One typechecked `b4.config.ts` per build target. |
| Create `ship/test-replay.json`, `ship/build-outputs.json` | The recordings (generated, committed). |
| Create `ship/ship-data.ts` | Typed recordings, the five deploy targets, announcements, links. |
| Create `ship/ship.test.ts` | Normalizer, recording pins, targets, docs anchors. |
| Create `ship/prepare.ts` | Server-only highlighting of each target's config. |
| Create `ship/TestReplay.tsx`, `ship/DeployTargets.tsx` | The two islands. |
| Create `ship/TestAndShip.tsx`, `ship/ship.module.css` | The server shell, `#test-and-ship`, and its styles. |
| Create `ship/TestAndShip.test.tsx` | SSR, replay, stream kill, targets, focus. |
| Create `checklist/fixtures/{b4.config.sandbox.ts,b4.config.postgres.ts}`, `checklist/fixtures/src/{middleware.ts,auth.ts,thread-access.ts,app/support/index.ts}` | Typechecked sources for the excerpts. |
| Create `checklist/checklist.ts` | The twelve items and `describeToggle`. |
| Create `checklist/checklist.test.ts` | Excerpt pins, handler runs, CLI registry, anchors, contrast. |
| Create `checklist/ProductionChecklist.tsx`, `checklist/LastMile.tsx`, `checklist/checklist.module.css` | The island, the server shell `#last-mile`, styles. |
| Create `checklist/ProductionChecklist.test.tsx` | SSR, mount, turns, Handled., flip kill, focus, hydration focus. |
| Modify `DeveloperHome.tsx`, `homepage.test.tsx` | Both sections after `#route-shapes`, before the takeaway. |
| Modify `apps/web/app/seo/lastmod.generated.json` | Only the `/` entry (Task 8). |

---

### Task 1: The devDependency

**Files:**
- Modify: `apps/web/package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Add it**

```bash
pnpm --filter @b4run/web add --save-dev "@b4run/postgres-storage@workspace:*"
```

pnpm writes `"workspace:^0.12.0"`. Change it to `"workspace:*"`, to match the other `@b4run/*` entries, and reinstall:

```bash
sed -i '' 's/"workspace:^0.12.0"/"workspace:*"/' apps/web/package.json
pnpm install
```

(On Linux, use `sed -i` without the `''`.)

- [ ] **Step 2: Check the diff**

Run: `git diff apps/web/package.json pnpm-lock.yaml`
Expected: exactly these lines added, and nothing else:

```diff
+    "@b4run/postgres-storage": "workspace:*",
```

```diff
+      '@b4run/postgres-storage':
+        specifier: workspace:*
+        version: link:../../packages/postgres-storage
```

If anything else moves, run `git checkout pnpm-lock.yaml apps/web/package.json && pnpm install`, re-fetch the base branch, and retry.

- [ ] **Step 3: Commit**

```bash
git status --short
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): devDependency for the persistence checklist fixture

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The recorder, the recordings and their pins

**Files:**
- Modify: `apps/web/scripts/export-homepage-demos.mjs`
- Create: `ship/fixtures/targets/{node,langsmith,hono,vercel}.ts`, `ship/ship-data.ts`, `ship/test-replay.json`, `ship/build-outputs.json`
- Test: `ship/ship.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/homepage/ship/ship.test.ts`:

```ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BUILD_TARGET_NAMES } from "@b4run/core"
import { describe, expect, it } from "vitest"
import {
  APP_NAME,
  BUILD_COMMAND,
  BUILD_IDS,
  EVAL_COMMAND,
  normalizeTranscript,
  TEST_COMMAND,
} from "../../../../scripts/export-homepage-demos.mjs"
import { DOCS_INDEX } from "../../docs/search-index"
import hono from "./fixtures/targets/hono"
import langsmith from "./fixtures/targets/langsmith"
import node from "./fixtures/targets/node"
import vercel from "./fixtures/targets/vercel"
import {
  buildFor,
  buildOutputs,
  deployTargets,
  describeReplay,
  describeTarget,
  type ReplayId,
  replaySummary,
  SHIP_FIXTURES,
  shipLinks,
  testReplay,
  writtenFiles,
} from "./ship-data"

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url))
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8")
const TEMPLATE = "packages/devkit/templates/app-basic/"
const runOf = (id: ReplayId) => {
  const run = testReplay.runs.find((candidate) => candidate.id === id)
  if (!run) throw new Error(`No recorded ${id} run`)
  return run
}
const recordings = JSON.stringify([testReplay, buildOutputs])

describe("the recordings are cleaned, and only cleaned", () => {
  it("drops ANSI codes, timings and the temp path, and nothing else", () => {
    const raw = [
      "",
      "\u001b[1m\u001b[46m RUN \u001b[49m\u001b[22m \u001b[36mv4.1.11 \u001b[39m\u001b[90m/private/var/t/my-agent\u001b[39m",
      "",
      "",
      " \u001b[32m✓\u001b[39m test/agent.test.ts\u001b[2m > \u001b[22mgreets by name\u001b[32m 246\u001b[2mms\u001b[22m\u001b[39m\r",
      "   Start at  12:31:06",
      "   Duration  1.18s (transform 14ms, setup 0ms)",
      "PASS greets by name › ada mean=1.00 [contains(Hello)=1.00]",
      "Build complete: .b4/build (in /var/t/my-agent)",
      "",
    ].join("\n")
    expect(normalizeTranscript(raw, ["/var/t/my-agent", "/private/var/t/my-agent"])).toEqual([
      " RUN  v4.1.11 my-agent",
      "",
      " ✓ test/agent.test.ts > greets by name",
      "PASS greets by name › ada mean=1.00 [contains(Hello)=1.00]",
      "Build complete: .b4/build (in my-agent)",
    ])
  })

  it("leaves no escape codes, timings, absolute paths or model key in either file", () => {
    expect(recordings).not.toContain(String.fromCharCode(27))
    expect(recordings).not.toContain("\\u001b")
    expect(recordings).not.toMatch(/\d+(?:\.\d+)?ms\b|Start at|Duration/)
    expect(recordings).not.toMatch(/\/Users\/|\/home\/|\/private\/|\/var\/|\/tmp\/|[A-Z]:\\\\/)
    expect(recordings).not.toMatch(/OPENAI_API_KEY|sk-[A-Za-z0-9]/)
    expect([testReplay.app, buildOutputs.app]).toEqual([APP_NAME, APP_NAME])
  })
})

describe("the test replay is the scaffold's own npm test and b4 eval", () => {
  it("records the two commands the page offers, in order", () => {
    expect(testReplay.runs.map((run) => [run.id, run.command])).toEqual([
      ["test", TEST_COMMAND],
      ["eval", EVAL_COMMAND],
    ])
  })

  it("runs the scaffold's test script and passes its one test, by name", () => {
    const script = JSON.parse(read(`${TEMPLATE}package.json.template`)).scripts.test
    const testName = /\bit\("([^"]+)"/.exec(read(`${TEMPLATE}test/agent.test.ts.template`))?.[1]
    expect(testName).toBe("greets by name")
    const { lines } = runOf("test")
    expect(lines).toContain(`> ${script} --reporter=verbose`)
    expect(lines).toContain(` ✓ test/agent.test.ts > ${testName}`)
    expect(lines.filter((line) => /passed/.test(line))).toEqual([
      " Test Files  1 passed (1)",
      "      Tests  1 passed (1)",
    ])
    expect(lines.join("\n")).not.toMatch(/failed|✗|×|FAIL/)
  })

  it("prints the eval's PASS lines in the CLI reporter's own format", () => {
    const smoke = read(`${TEMPLATE}src/app/hello/evals/smoke.eval.ts.template`)
    const [suite, testCase] = [...smoke.matchAll(/\bname: "([^"]+)"/g)].map((match) => match[1])
    expect([suite, testCase]).toEqual(["greets by name", "ada"])
    // The format is the reporter's: these are its two template literals, as source text.
    const reporter = read("packages/cli/src/commands/eval.ts")
    expect(reporter).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the reporter's source text.
      '`${c.passed ? "PASS" : "FAIL"} ${report.name} › ${c.name} mean=${c.mean.toFixed(2)} [${detail}]`',
    )
    expect(reporter).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the reporter's source text.
      '`${verdict} ${report.name} mean=${report.mean.toFixed(2)}${report.reason ? ` (${report.reason})` : ""}`',
    )
    expect(runOf("eval").lines).toEqual([
      `PASS ${suite} › ${testCase} mean=1.00 [contains(Hello)=1.00]`,
      `PASS ${suite} mean=1.00`,
    ])
  })

  it("announces the command and how it ended, and words a repeat differently", () => {
    expect(replaySummary(runOf("test"))).toBe("Tests 1 passed (1)")
    expect(describeReplay(runOf("test"), false)).toBe(
      "Replayed npm test -- --reporter=verbose. Tests 1 passed (1).",
    )
    expect(describeReplay(runOf("eval"), true)).toBe(
      "Replayed npx b4 eval again. PASS greets by name mean=1.00.",
    )
  })
})

describe("the deploy targets are the CLI's own, built for real", () => {
  it("offers every build target the CLI knows, in its order, then Kubernetes", () => {
    expect(deployTargets.map((target) => target.id)).toEqual([...BUILD_TARGET_NAMES, "kubernetes"])
    expect(buildOutputs.command).toBe(BUILD_COMMAND)
    expect(buildOutputs.builds.map((build) => build.id)).toEqual(BUILD_IDS)
    expect(BUILD_IDS).toEqual(["default", ...BUILD_TARGET_NAMES])
  })

  it("builds each target with its own typechecked config, which lists only that target", () => {
    const configs = { node, langsmith, hono, vercel }
    for (const name of BUILD_TARGET_NAMES) {
      expect(configs[name].build?.targets, name).toEqual([name])
      expect(buildFor(name).config, name).toBe(read(`${SHIP_FIXTURES}${name}.ts`))
    }
  })

  it("emits node and langsmith by default, and a build.targets list replaces them", () => {
    expect(buildFor("default").config).toBe(read(`${TEMPLATE}b4.config.ts`))
    expect(buildFor("default").lines).toContain("  targets: node, langsmith")
    expect(writtenFiles(buildFor("default"))).toEqual([
      ...writtenFiles(buildFor("node")),
      ...writtenFiles(buildFor("langsmith")),
    ])
    for (const name of BUILD_TARGET_NAMES) {
      expect(buildFor(name).lines, name).toContain(`  targets: ${name}`)
    }
    expect(read("apps/web/content/docs/deployment.mdx")).toContain(
      "Specifying build targets replaces the defaults.",
    )
  })

  it("writes the files each target's docs page lists", () => {
    const expected: Readonly<Record<string, readonly string[]>> = {
      node: [".b4/build/server.mjs", "Dockerfile"],
      langsmith: [".b4/build/langgraph.json"],
      hono: [".b4/build/app.mjs", "wrangler.toml"],
      vercel: [".vercel/output/functions/b4.func/index.mjs", "vercel.json"],
    }
    for (const target of deployTargets) {
      const files = writtenFiles(buildFor(target.build))
      const page = read(`apps/web/content/docs${target.docsHref.split("#")[0]?.slice(5)}.mdx`)
      for (const file of expected[target.build] ?? []) {
        expect(files, target.id).toContain(file)
        if (target.id !== "kubernetes") expect(page, `${target.id} ${file}`).toContain(file)
      }
    }
  })

  it("installs Kubernetes with the docs' own commands and the repository's chart", () => {
    const docs = read("apps/web/content/docs/deployment/kubernetes.mdx")
    const kubernetes = deployTargets.find((target) => target.id === "kubernetes")
    expect(kubernetes?.build).toBe("node")
    for (const command of kubernetes?.after ?? []) expect(docs).toContain(command)
    expect(read("charts/b4-app/Chart.yaml")).toMatch(/^name: b4-app$/m)
  })

  it("announces the target and the files its build writes", () => {
    const [first] = deployTargets
    if (!first) throw new Error("No targets")
    expect(describeTarget(first)).toBe(
      "Deploy target node. The full B4 HTTP runtime as a Node server, with a Dockerfile. b4 build writes .b4/build/workspace.json, .b4/build/modules.mjs, .b4/build/server.mjs, Dockerfile.",
    )
  })

  it("links to docs headings that exist", () => {
    for (const href of [
      ...deployTargets.map((target) => target.docsHref),
      ...shipLinks.map((link) => link.href),
    ]) {
      const [path, anchor] = href.split("#")
      const page = DOCS_INDEX.find((entry) => entry.href === path)
      expect(page, href).toBeDefined()
      expect(
        page?.headings.map((heading) => heading.anchor),
        href,
      ).toContain(anchor)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/ship/ship.test.ts`
Expected: FAIL; `normalizeTranscript` isn't exported from the script, and `./fixtures/targets/hono` and `./ship-data` can't be resolved.

- [ ] **Step 3: Write the target fixtures**

Each is a whole `b4.config.ts` that selects one target. `ship/fixtures/targets/node.ts`:

```ts
import { config } from "@b4run/cli"

export default config({
  build: { targets: ["node"] },
})
```

`langsmith.ts`, `hono.ts` and `vercel.ts` are the same file with `"langsmith"`, `"hono"` and `"vercel"` in place of `"node"`:

```bash
for t in langsmith hono vercel; do
  sed "s/\"node\"/\"$t\"/" apps/web/app/components/homepage/ship/fixtures/targets/node.ts \
    > apps/web/app/components/homepage/ship/fixtures/targets/$t.ts
done
```

- [ ] **Step 4: Extend the export script**

Replace `apps/web/scripts/export-homepage-demos.mjs` with the version below. The schema-variant half is unchanged; `writeJson` is the old inline Biome call, factored out.

```js
// Regenerates the data behind the homepage demos from the real framework.
//
//   pnpm build   # every @b4run package and create-b4-app resolve to their dist/
//   node apps/web/scripts/export-homepage-demos.mjs                  # schema variants
//   node apps/web/scripts/export-homepage-demos.mjs --record-tests   # ship/test-replay.json
//   node apps/web/scripts/export-homepage-demos.mjs --record-builds  # ship/build-outputs.json
//
// Schema variants: runs @b4run/core's tool-schema extractor, the one `b4
// typegen` uses, on each playground variant of the scaffold's greet tool, and
// writes app/components/homepage/playground/schema-variants.json. The
// playground test runs the same extraction and expects this file exactly.
//
// Recordings: scaffolds the basic app into a temp directory with this
// checkout's create-b4-app (`--mode internal`, so every @b4run package is this
// checkout's), installs it, and runs the real commands with OPENAI_API_KEY
// removed from the environment. The transcripts lose ANSI codes, timings and
// the temp path, and nothing else. The install reads pnpm's store first and
// falls back to the npm registry for anything the store lacks. No model is
// called: the scaffold's test and eval replay script() fixtures.
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { extractToolSchemasForRoute } from "@b4run/core/node"

const scriptFile = realpathSync(fileURLToPath(import.meta.url))
const webRoot = resolve(dirname(scriptFile), "..")
const repoRoot = resolve(webRoot, "..", "..")
export const playgroundRoot = join(webRoot, "app", "components", "homepage", "playground")
export const schemaVariantsFile = join(playgroundRoot, "schema-variants.json")
export const shipRoot = join(webRoot, "app", "components", "homepage", "ship")
export const testReplayFile = join(shipRoot, "test-replay.json")
export const buildOutputsFile = join(shipRoot, "build-outputs.json")
const templateRoot = join(repoRoot, "packages", "devkit", "templates", "app-basic")
// The compiler options a scaffolded app extends (@b4run/config-typescript/node).
const toolTsconfig = join(repoRoot, "packages", "config-typescript", "node.json")

/** The name the recordings give the scaffolded app, in place of its temp path. */
export const APP_NAME = "my-agent"
/** `npm test`, with vitest's verbose reporter so the transcript names each test. */
export const TEST_COMMAND = "npm test -- --reporter=verbose"
export const EVAL_COMMAND = "npx b4 eval"
export const BUILD_COMMAND = "npx b4 build"
/** `default` is the scaffold's own b4.config.ts; the rest set `build.targets`. */
export const BUILD_IDS = ["default", "node", "langsmith", "hono", "vercel"]
/**
 * The packages the hono and vercel targets' runtime imports, which the app has
 * to declare (`/docs/deployment/vercel#select-the-target`), plus the model
 * provider the scaffold's gpt-5-mini route bundles. Postgres storage comes
 * from this checkout, like every other @b4run package in the scaffold.
 */
const EDGE_DEPENDENCIES = [
  `@b4run/postgres-storage@file:${join(repoRoot, "packages", "postgres-storage")}`,
  "@neondatabase/serverless",
  "hono",
  "@langchain/openai",
]
/** Everything a build writes, cleared before each target runs. */
const BUILD_OUTPUTS = [".b4/build", ".vercel", "Dockerfile", "wrangler.toml", "vercel.json"]

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

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
/** A timing at the end of a line, as vitest prints after each test ("246ms", "1.2s"). */
const TRAILING_TIMING = /\s+\d+(?:\.\d+)?m?s$/
/** vitest's wall-clock summary lines. */
const TIMING_LINE = /^\s*(?:Start at|Duration)\s/

/**
 * One command's output as the page shows it: no ANSI codes, no timings, and
 * the app's temp path (any of `roots`, longest first) written as `my-agent`.
 * Runs of blank lines collapse to one, and blank lines at either end go.
 */
export function normalizeTranscript(text, roots) {
  const byLength = [...roots].sort((a, b) => b.length - a.length)
  const lines = []
  for (const raw of text.replace(ANSI, "").replaceAll("\r", "").split("\n")) {
    if (TIMING_LINE.test(raw)) continue
    let line = raw
    for (const root of byLength) line = line.replaceAll(root, APP_NAME)
    line = line.replace(TRAILING_TIMING, "").trimEnd()
    if (line === "" && (lines.length === 0 || lines.at(-1) === "")) continue
    lines.push(line)
  }
  while (lines.at(-1) === "") lines.pop()
  return lines
}

/** The environment every recorded command runs in: no model key, no colour. */
export function recordingEnv() {
  const env = {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
  }
  delete env.OPENAI_API_KEY
  return env
}

/** Runs `command` in `cwd` with stderr folded into stdout; throws on a non-zero exit. */
function run(command, cwd) {
  const result = spawnSync("sh", ["-c", `${command} 2>&1`], {
    cwd,
    env: recordingEnv(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status} in ${cwd}:\n${result.stdout}`)
  }
  return result.stdout
}

/**
 * Scaffolds the basic app into a fresh temp directory and installs it. The
 * internal-mode `.npmrc` (`ignore-workspace=true`, for a scaffold inside a pnpm
 * workspace) goes, as an external scaffold's does; the temp directory is in
 * no workspace.
 */
export function scaffoldBasicApp() {
  const tempRoot = mkdtempSync(join(tmpdir(), "b4-homepage-"))
  const appRoot = join(tempRoot, APP_NAME)
  execFileSync(
    process.execPath,
    [join(repoRoot, "packages", "create-b4-app", "dist", "bin.js"), appRoot, "--mode", "internal"],
    { stdio: "ignore" },
  )
  rmSync(join(appRoot, ".npmrc"), { force: true })
  run("pnpm install --prefer-offline", appRoot)
  return { tempRoot, appRoot, roots: [...new Set([appRoot, realpathSync(appRoot)])] }
}

/** The scaffold's tests and evals, exactly as they print. */
export function recordTestReplay({ appRoot, roots }) {
  const record = (id, command) => ({
    id,
    command,
    lines: normalizeTranscript(run(command, appRoot), roots),
  })
  return { app: APP_NAME, runs: [record("test", TEST_COMMAND), record("eval", EVAL_COMMAND)] }
}

/**
 * `b4 build` under the scaffold's own config (the defaults), then under each
 * target's config from ship/fixtures/targets/, from a clean tree each time.
 */
export function recordBuilds({ appRoot, roots }) {
  const packages = EDGE_DEPENDENCIES.map((name) => `'${name}'`).join(" ")
  run(`pnpm add --prefer-offline ${packages}`, appRoot)
  const builds = []
  for (const id of BUILD_IDS) {
    const configFile =
      id === "default"
        ? join(templateRoot, "b4.config.ts")
        : join(shipRoot, "fixtures", "targets", `${id}.ts`)
    const config = readFileSync(configFile, "utf8")
    writeFileSync(join(appRoot, "b4.config.ts"), config)
    for (const output of BUILD_OUTPUTS) {
      rmSync(join(appRoot, output), { recursive: true, force: true })
    }
    builds.push({ id, config, lines: normalizeTranscript(run(BUILD_COMMAND, appRoot), roots) })
  }
  return { app: APP_NAME, command: BUILD_COMMAND, builds }
}

/** Writes `data` in the repository's JSON style, so lint passes on the committed file. */
function writeJson(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  execFileSync(
    "pnpm",
    [
      "exec",
      "biome",
      "format",
      "--write",
      "--config-path",
      join(repoRoot, "packages", "config-biome", "biome.json"),
      file,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  )
}

function isDirectExecution(invokedPath, modulePath) {
  return (
    invokedPath !== undefined && realpathSync(resolve(invokedPath)) === realpathSync(modulePath)
  )
}

if (isDirectExecution(process.argv[1], scriptFile)) {
  const flags = new Set(process.argv.slice(2))
  if (flags.has("--record-tests") || flags.has("--record-builds")) {
    const app = scaffoldBasicApp()
    try {
      if (flags.has("--record-tests")) {
        writeJson(testReplayFile, recordTestReplay(app))
        console.log(`Wrote ${testReplayFile}`)
      }
      if (flags.has("--record-builds")) {
        writeJson(buildOutputsFile, recordBuilds(app))
        console.log(`Wrote ${buildOutputsFile}`)
      }
    } finally {
      rmSync(app.tempRoot, { recursive: true, force: true })
    }
  } else {
    const data = await extractSchemaVariants()
    writeJson(schemaVariantsFile, data)
    console.log(`Wrote ${data.variants.length} schema variants to ${schemaVariantsFile}`)
  }
}
```

- [ ] **Step 5: Record**

```bash
pnpm build
node apps/web/scripts/export-homepage-demos.mjs --record-tests --record-builds
```

Expected: two `Wrote …` lines, in about 20 to 30 seconds. `ship/test-replay.json` must be exactly:

```json
{
  "app": "my-agent",
  "runs": [
    {
      "id": "test",
      "command": "npm test -- --reporter=verbose",
      "lines": [
        "> test",
        "> vitest run --reporter=verbose",
        "",
        " RUN  v4.1.11 my-agent",
        "",
        " ✓ test/agent.test.ts > greets by name",
        "",
        " Test Files  1 passed (1)",
        "      Tests  1 passed (1)"
      ]
    },
    {
      "id": "eval",
      "command": "npx b4 eval",
      "lines": [
        "PASS greets by name › ada mean=1.00 [contains(Hello)=1.00]",
        "PASS greets by name mean=1.00"
      ]
    }
  ]
}
```

and `ship/build-outputs.json` exactly:

```json
{
  "app": "my-agent",
  "command": "npx b4 build",
  "builds": [
    {
      "id": "default",
      "config": "import { config } from \"@b4run/cli\"\n\nexport default config({})\n",
      "lines": [
        "Build complete: .b4/build",
        "  1 route(s) compiled",
        "  targets: node, langsmith",
        "  wrote .b4/build/workspace.json",
        "  wrote .b4/build/modules.mjs",
        "  wrote .b4/build/server.mjs",
        "  wrote Dockerfile",
        "  wrote .b4/build/hello.ts",
        "  wrote .b4/build/langgraph.json"
      ]
    },
    {
      "id": "node",
      "config": "import { config } from \"@b4run/cli\"\n\nexport default config({\n  build: { targets: [\"node\"] },\n})\n",
      "lines": [
        "Build complete: .b4/build",
        "  1 route(s) compiled",
        "  targets: node",
        "  wrote .b4/build/workspace.json",
        "  wrote .b4/build/modules.mjs",
        "  wrote .b4/build/server.mjs",
        "  wrote Dockerfile"
      ]
    },
    {
      "id": "langsmith",
      "config": "import { config } from \"@b4run/cli\"\n\nexport default config({\n  build: { targets: [\"langsmith\"] },\n})\n",
      "lines": [
        "Build complete: .b4/build",
        "  1 route(s) compiled",
        "  targets: langsmith",
        "  wrote .b4/build/hello.ts",
        "  wrote .b4/build/langgraph.json"
      ]
    },
    {
      "id": "hono",
      "config": "import { config } from \"@b4run/cli\"\n\nexport default config({\n  build: { targets: [\"hono\"] },\n})\n",
      "lines": [
        "Build complete: .b4/build",
        "  1 route(s) compiled",
        "  targets: hono",
        "  wrote .b4/build/modules.edge.mjs",
        "  wrote .b4/build/stores.mjs",
        "  wrote .b4/build/app.mjs",
        "  wrote wrangler.toml"
      ]
    },
    {
      "id": "vercel",
      "config": "import { config } from \"@b4run/cli\"\n\nexport default config({\n  build: { targets: [\"vercel\"] },\n})\n",
      "lines": [
        "Build complete: .b4/build",
        "  1 route(s) compiled",
        "  targets: vercel",
        "  wrote .vercel/output/config.json",
        "  wrote .vercel/output/functions/b4.func/.vc-config.json",
        "  wrote .vercel/output/functions/b4.func/index.mjs",
        "  wrote vercel.json"
      ]
    }
  ]
}
```

Only the vitest version in `RUN  v4.1.11` may differ, if pnpm's store resolves a newer `vitest@^4`. Anything else that differs is a real change in the framework: stop and look at it, don't edit the JSON. If the install step fails with a registry error, your pnpm store lacks one of the scaffold's third-party packages and there's no network; retry online.

- [ ] **Step 6: Write the data module**

Create `apps/web/app/components/homepage/ship/ship-data.ts`:

```ts
import type { BuildTargetName } from "@b4run/core"
import builds from "./build-outputs.json"
import replay from "./test-replay.json"

/**
 * "Test and ship". Both halves show recordings of real commands, which
 * `scripts/export-homepage-demos.mjs --record-tests --record-builds` makes by
 * scaffolding the basic app and running them; ship.test.ts pins what they
 * claim to the template, the CLI and the docs.
 */
export type ReplayId = "test" | "eval"

export interface ReplayRun {
  readonly id: ReplayId
  readonly command: string
  readonly lines: readonly string[]
}

export const testReplay = replay as {
  readonly app: string
  readonly runs: readonly ReplayRun[]
}

/** The line a run ends on, for the announcement: vitest's test count, or the eval verdict. */
export function replaySummary(run: ReplayRun): string {
  const summary =
    run.id === "test"
      ? [...run.lines].reverse().find((line) => /^\s*Tests\s/.test(line))
      : run.lines.at(-1)
  return (summary ?? "").trim().replace(/\s+/g, " ")
}

/**
 * What the live region says when a run is replayed. The transcript is final
 * the moment the button is pressed; only its lines fade in. Replaying the
 * same run again changes the wording, so the region's text always changes.
 */
export function describeReplay(run: ReplayRun, again: boolean): string {
  return `Replayed ${run.command}${again ? " again" : ""}. ${replaySummary(run)}.`
}

export type BuildId = "default" | BuildTargetName

export interface BuildRecording {
  readonly id: BuildId
  /** The b4.config.ts the build ran with. */
  readonly config: string
  readonly lines: readonly string[]
}

export const buildOutputs = builds as {
  readonly app: string
  readonly command: string
  readonly builds: readonly BuildRecording[]
}

export type TargetId = BuildTargetName | "kubernetes"

export interface DeployTarget {
  readonly id: TargetId
  /** The recorded build this tab shows. Kubernetes runs the node build. */
  readonly build: BuildTargetName
  /** One sentence under the output. */
  readonly summary: string
  /** Commands after `b4 build`, verbatim from the docs page. */
  readonly after: readonly string[]
  readonly docsHref: string
  readonly docsLabel: string
}

export const SHIP_FIXTURES = "apps/web/app/components/homepage/ship/fixtures/targets/"

export const deployTargets: readonly DeployTarget[] = [
  {
    id: "node",
    build: "node",
    summary: "The full B4 HTTP runtime as a Node server, with a Dockerfile.",
    after: [],
    docsHref: "/docs/deployment/node#emitted-files",
    docsLabel: "Node and Docker",
  },
  {
    id: "langsmith",
    build: "langsmith",
    summary: "A langgraph.json and one graph entry per route, for LangSmith to run.",
    after: [],
    docsHref: "/docs/deployment/langsmith#build-output",
    docsLabel: "LangSmith",
  },
  {
    id: "hono",
    build: "hono",
    summary: "A Hono app over the web-standard runtime. It serves the edge subset of B4.",
    after: [],
    docsHref: "/docs/deployment/edge#emitted-artifacts",
    docsLabel: "Edge and Hono",
  },
  {
    id: "vercel",
    build: "vercel",
    summary:
      "A Build Output API tree with one streaming function. It serves the edge subset of B4.",
    after: [],
    docsHref: "/docs/deployment/vercel#emitted-artifacts",
    docsLabel: "Vercel",
  },
  {
    id: "kubernetes",
    build: "node",
    summary: "The Node build in an image, installed with the b4-app Helm chart.",
    after: [
      "docker build -t ghcr.io/you/my-b4-app:2026-08-10 .",
      [
        "helm install b4-app oci://ghcr.io/cacheplane/charts/b4-app \\",
        "  --namespace b4-app \\",
        "  --set image.repository=ghcr.io/you/my-b4-app \\",
        "  --set image.tag=2026-08-10",
      ].join("\n"),
    ],
    docsHref: "/docs/deployment/kubernetes#install-or-upgrade-the-application",
    docsLabel: "Kubernetes",
  },
]

export function buildFor(id: BuildId): BuildRecording {
  const recording = buildOutputs.builds.find((candidate) => candidate.id === id)
  if (!recording) throw new Error(`No recorded build for ${id}`)
  return recording
}

/** The files a build wrote, from its `wrote …` lines. */
export function writtenFiles(recording: BuildRecording): readonly string[] {
  return recording.lines.flatMap((line) => {
    const match = /^\s*wrote (.+)$/.exec(line)
    return match?.[1] ? [match[1]] : []
  })
}

/** What the live region says after the visitor picks a target. */
export function describeTarget(target: DeployTarget): string {
  const files = writtenFiles(buildFor(target.build))
  return `Deploy target ${target.id}. ${target.summary} b4 build writes ${files.join(", ")}.`
}

/** The section's own links, below both halves. */
export const shipLinks = [
  { href: "/docs/testing-agents#your-scaffolded-app-already-has-a-test", label: "Testing agents" },
  { href: "/docs/evals#execution-replay-vs-live", label: "Evals" },
  { href: "/docs/deployment#choose-a-target", label: "Deployment" },
] as const
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/ship/ship.test.ts`
Expected: PASS, 13 tests.

Then the playground's test, which imports the same script: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/playground`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git status --short
git add apps/web/scripts/export-homepage-demos.mjs apps/web/app/components/homepage/ship/fixtures apps/web/app/components/homepage/ship/test-replay.json apps/web/app/components/homepage/ship/build-outputs.json apps/web/app/components/homepage/ship/ship-data.ts apps/web/app/components/homepage/ship/ship.test.ts
git commit -m "feat(web): record the scaffold's tests and builds for the ship section

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The TestReplay and DeployTargets islands and the TestAndShip shell

**Files:**
- Create: `ship/prepare.ts`, `ship/TestReplay.tsx`, `ship/DeployTargets.tsx`, `ship/TestAndShip.tsx`, `ship/ship.module.css`
- Test: `ship/TestAndShip.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/homepage/ship/TestAndShip.test.tsx`. It asserts that each stream or fade was **created** (a spy), and that the next action killed it and cleared its inline styles; it never asserts that a sub-second tween is still running after `act()`.

```tsx
// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { recordingEnv } from "../../../../scripts/export-homepage-demos.mjs"
import { FULL, gsap, REDUCE } from "../motion/gsap"
import { type MediaStub, stubMatchMedia } from "../motion/media-stub"
import { DeployTargets } from "./DeployTargets"
import { prepareDeployTargets } from "./prepare"
import { deployTargets, describeTarget, testReplay } from "./ship-data"
import { TestAndShip } from "./TestAndShip"
import { TestReplay } from "./TestReplay"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let media: MediaStub | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
  media?.restore()
  media = undefined
})

const code = await prepareDeployTargets()
const [testRun, evalRun] = testReplay.runs
if (!testRun || !evalRun) throw new Error("The recording has two runs")

async function mount(node: React.ReactNode, reduce: boolean) {
  media = stubMatchMedia({ [REDUCE]: reduce, [FULL]: !reduce })
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () => root?.render(node))
  const q = <T extends Element>(selector: string) => {
    const match = container.querySelector<T>(selector)
    if (!match) throw new Error(`No ${selector}`)
    return match
  }
  return {
    container,
    q,
    press: (selector: string) => act(async () => q<HTMLButtonElement>(selector).click()),
    live: () => container.querySelector('[aria-live="polite"]')?.textContent,
    tweensOn: (selector: string) =>
      [...container.querySelectorAll(selector)].flatMap((node) => gsap.getTweensOf(node)),
    styled: (selector: string) =>
      [...container.querySelectorAll<HTMLElement>(selector)].filter(
        (node) => node.style.opacity !== "" || node.style.transform !== "",
      ),
  }
}

it("renders both halves complete on the server, with nothing announced", () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(<TestAndShip code={code} />)
  const section = container.querySelector("section#test-and-ship")
  expect(section?.getAttribute("aria-labelledby")).toBe("test-and-ship-title")
  // Every recorded line is in the log, which is a log but not a live region.
  const log = container.querySelector('[role="log"]')
  expect(log?.getAttribute("aria-live")).toBe("off")
  for (const run of testReplay.runs) {
    expect(log?.textContent).toContain(run.command)
    for (const line of run.lines.filter(Boolean)) expect(log?.textContent).toContain(line)
  }
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((input) => [
      input.value,
      input.checked,
    ]),
  ).toEqual(deployTargets.map((target) => [target.id, target.id === "node"]))
  const panels = [...container.querySelectorAll("[data-target]")]
  expect(panels.map((panel) => panel.getAttribute("data-target"))).toEqual(
    deployTargets.map((target) => target.id),
  )
  expect(panels[0]?.textContent).toContain('build: { targets: ["node"] },')
  expect(panels[0]?.textContent).toContain("wrote .b4/build/server.mjs")
  expect(panels.at(-1)?.textContent).toContain("helm install b4-app")
  expect(panels.slice(1).every((panel) => panel.getAttribute("aria-hidden") === "true")).toBe(true)
  expect(container.textContent).toContain("Setting build.targets replaces them.")
  // No element starts hidden by an inline style: the no-JS page is complete.
  expect(container.querySelector("[style]")).toBeNull()
  // ui.css pads every `pre [data-line]` for docs code blocks; the log must not match it.
  expect(container.querySelector("pre [data-line]")).toBeNull()
  expect(
    [...container.querySelectorAll('[aria-live="polite"]')].map((node) => node.textContent),
  ).toEqual(["", ""])
})

it("records with no model key, whatever the shell has set", () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-not-a-real-key")
  expect(recordingEnv()).not.toHaveProperty("OPENAI_API_KEY")
  vi.unstubAllEnvs()
})

it("announces a replay once, at once, and words a repeat differently", async () => {
  const view = await mount(<TestReplay />, true)
  expect(view.live()).toBe("")
  await view.press('[data-replay="test"]')
  expect(view.live()).toBe("Replayed npm test -- --reporter=verbose. Tests 1 passed (1).")
  await view.press('[data-replay="test"]')
  expect(view.live()).toBe("Replayed npm test -- --reporter=verbose again. Tests 1 passed (1).")
  await view.press('[data-replay="eval"]')
  expect(view.live()).toBe("Replayed npx b4 eval. PASS greets by name mean=1.00.")
  // Reduced motion: every line shows, and nothing moves.
  expect(view.tweensOn("[data-replay-line]")).toEqual([])
  expect(view.styled("[data-replay-line]")).toEqual([])
})

it("streams the lines in with motion on, and Skip or the next replay shows them all", async () => {
  const view = await mount(<TestReplay />, false)
  const fromTo = vi.spyOn(gsap, "fromTo")
  await view.press('[data-replay="test"]')
  // Assert the stream started, not that it is still running.
  expect(fromTo).toHaveBeenCalledTimes(1)
  const [targets, from, to] = fromTo.mock.calls[0] ?? []
  expect([...(targets as NodeListOf<Element>)]).toEqual([
    ...view.container.querySelectorAll('[data-run="test"] [data-replay-line]'),
  ])
  expect(targets as NodeListOf<Element>).toHaveLength(testRun.lines.length)
  expect(from).toEqual({ opacity: 0 })
  expect((to as gsap.TweenVars).stagger).toBe(0.08)
  await view.press('[data-action="skip"]')
  expect(view.tweensOn('[data-run="test"] [data-replay-line]')).toEqual([])
  expect(view.styled('[data-run="test"] [data-replay-line]')).toEqual([])
  expect(view.live()).toBe("Replayed npm test -- --reporter=verbose. Tests 1 passed (1).")

  await view.press('[data-replay="test"]')
  await view.press('[data-replay="eval"]')
  expect(fromTo).toHaveBeenCalledTimes(3)
  expect(view.tweensOn('[data-run="test"] [data-replay-line]')).toEqual([])
  expect(view.styled('[data-run="test"] [data-replay-line]')).toEqual([])
  expect(view.live()).toBe("Replayed npx b4 eval. PASS greets by name mean=1.00.")
})

it("puts focus on a replay button when a click leaves it on an ancestor", async () => {
  const view = await mount(<TestReplay />, true)
  const main = document.createElement("main")
  main.tabIndex = -1
  document.body.replaceChildren(main)
  main.append(view.container)
  main.focus()
  await view.press('[data-replay="eval"]')
  expect(document.activeElement).toBe(view.q('[data-replay="eval"]'))
  main.focus()
  await view.press('[data-action="skip"]')
  expect(document.activeElement).toBe(view.q('[data-action="skip"]'))
})

it("switches the deploy target at once, announces it, and keeps the others inert", async () => {
  const view = await mount(<DeployTargets code={code} />, true)
  await act(async () => view.q<HTMLInputElement>('input[value="hono"]').click())
  expect(view.container.querySelector<HTMLInputElement>("input:checked")?.value).toBe("hono")
  const active = view.q('[data-target][data-active="true"]')
  expect(active.getAttribute("data-target")).toBe("hono")
  expect(active.textContent).toContain("wrote wrangler.toml")
  expect(
    [...view.container.querySelectorAll('[data-target]:not([data-active="true"])')].every(
      (node) => node.getAttribute("aria-hidden") === "true" && node.hasAttribute("inert"),
    ),
  ).toBe(true)
  const hono = deployTargets.find((target) => target.id === "hono")
  if (!hono) throw new Error("No hono target")
  expect(view.live()).toBe(describeTarget(hono))
  expect(view.tweensOn("[data-target]")).toEqual([])
})

it("fades a target in with motion on, and the next pick kills the fade", async () => {
  const view = await mount(<DeployTargets code={code} />, false)
  const fromTo = vi.spyOn(gsap, "fromTo")
  await act(async () => view.q<HTMLInputElement>('input[value="vercel"]').click())
  expect(fromTo).toHaveBeenCalledTimes(1)
  const [faded] = fromTo.mock.calls[0] ?? []
  expect((faded as Element).getAttribute("data-target")).toBe("vercel")
  await act(async () => view.q<HTMLInputElement>('input[value="kubernetes"]').click())
  expect(view.q('[data-target][data-active="true"]').getAttribute("data-target")).toBe("kubernetes")
  expect(view.tweensOn('[data-target="vercel"]')).toEqual([])
  expect(view.styled('[data-target="vercel"]')).toEqual([])
})

it("gives focus to the checked radio when a click leaves it on an ancestor", async () => {
  const view = await mount(<DeployTargets code={code} />, true)
  // WebKit moves focus on mousedown to the nearest focusable ancestor.
  const main = document.createElement("main")
  main.tabIndex = -1
  document.body.replaceChildren(main)
  main.append(view.container)
  main.focus()
  await act(async () => view.q<HTMLInputElement>('input[value="langsmith"]').click())
  expect(document.activeElement).toBe(view.q('input[value="langsmith"]'))
  // Focus already in the group stays where the visitor put it.
  view.q<HTMLInputElement>('input[value="langsmith"]').focus()
  await act(async () => view.q<HTMLInputElement>('input[value="node"]').click())
  expect(document.activeElement).toBe(view.q('input[value="langsmith"]'))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/ship/TestAndShip.test.tsx`
Expected: FAIL; `./DeployTargets`, `./prepare`, `./TestAndShip` and `./TestReplay` can't be resolved.

- [ ] **Step 3: Server-side highlighting**

Create `apps/web/app/components/homepage/ship/prepare.ts`:

```ts
import "server-only"
import { highlightCode } from "../highlight"
import { buildFor, deployTargets, type TargetId } from "./ship-data"

/** Each target's b4.config.ts, highlighted on the server: one HTML string per line. */
export async function prepareDeployTargets(): Promise<
  Readonly<Record<TargetId, readonly string[]>>
> {
  const entries = await Promise.all(
    deployTargets.map(async (target) => {
      const code = await highlightCode(
        buildFor(target.build).config,
        "typescript",
        "b4.config.ts",
        "",
      )
      return [target.id, code.lines] as const
    }),
  )
  return Object.fromEntries(entries) as Record<TargetId, readonly string[]>
}
```

- [ ] **Step 4: The replay island**

Create `apps/web/app/components/homepage/ship/TestReplay.tsx`:

```tsx
"use client"
import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react"
import { gsap, withMotion } from "../motion/gsap"
import styles from "./ship.module.css"
import { describeReplay, type ReplayId, testReplay } from "./ship-data"

type Stream = ReturnType<typeof gsap.fromTo>

/** Stops a running replay and drops the inline opacity it left on its lines. */
function stopStream(stream: { current: Stream | null }) {
  const running = stream.current
  stream.current = null
  if (!running) return
  const targets = running.targets()
  running.kill()
  gsap.set(targets, { clearProps: "opacity" })
}

/**
 * Safari doesn't focus a clicked button: WebKit moves focus on mousedown to
 * the nearest focusable ancestor (<main tabindex="-1"> or <body>). Put it on
 * the button, so the next Tab continues from here.
 */
function keepFocus(event: MouseEvent<HTMLButtonElement>) {
  const button = event.currentTarget
  const focused = document.activeElement
  if (focused === null || (focused !== button && focused.contains(button))) button.focus()
}

/** The button label for each run: the command a visitor would type. */
const LABEL: Readonly<Record<ReplayId, string>> = { test: "npm test", eval: "b4 eval" }

/**
 * The scaffold's recorded `npm test` and `b4 eval`. Every line is in the page
 * from the start, so the terminal is its final height and a screen reader can
 * read the whole log. Replaying sets the announcement at once and only fades
 * the lines in, about 80ms apart; Skip, the next replay, or reduced motion
 * shows them all at once.
 */
export function TestReplay() {
  const rootRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef(false)
  const streamRef = useRef<Stream | null>(null)
  const [replaying, setReplaying] = useState<ReplayId | null>(null)
  const [replays, setReplays] = useState(0)
  const [announcement, setAnnouncement] = useState("")

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stop = withMotion(root, {
      reduce: () => {
        motionRef.current = false
        stopStream(streamRef)
        return undefined
      },
      full: () => {
        motionRef.current = true
        return () => {
          motionRef.current = false
        }
      },
    })
    return () => {
      stop()
      stopStream(streamRef)
    }
  }, [])

  // The log is already complete when this runs; the stream only moves pixels,
  // and the next action kills it.
  useLayoutEffect(() => {
    if (replays === 0 || replaying === null) return
    stopStream(streamRef)
    if (!motionRef.current) return
    const lines = rootRef.current?.querySelectorAll(`[data-run="${replaying}"] [data-replay-line]`)
    if (!lines?.length) return
    streamRef.current = gsap.fromTo(
      lines,
      { opacity: 0 },
      { opacity: 1, duration: 0.01, ease: "none", stagger: 0.08, clearProps: "opacity" },
    )
  }, [replays, replaying])

  function replay(id: ReplayId) {
    const run = testReplay.runs.find((candidate) => candidate.id === id)
    if (!run) return
    setReplaying(id)
    setReplays((count) => count + 1)
    setAnnouncement((current) =>
      current === describeReplay(run, false)
        ? describeReplay(run, true)
        : describeReplay(run, false),
    )
  }

  return (
    <div ref={rootRef} className={styles.replay}>
      <div className={styles.controls}>
        {testReplay.runs.map((run) => (
          <button
            key={run.id}
            type="button"
            data-replay={run.id}
            onClick={(event) => {
              keepFocus(event)
              replay(run.id)
            }}
          >
            <span aria-hidden="true">▶ </span>Replay {LABEL[run.id]}
          </button>
        ))}
        <button
          type="button"
          data-action="skip"
          onClick={(event) => {
            keepFocus(event)
            stopStream(streamRef)
          }}
        >
          Skip
        </button>
      </div>
      <div className={styles.terminal}>
        <p className={styles.bar}>{testReplay.app}</p>
        <pre
          className={styles.log}
          role="log"
          aria-live="off"
          aria-label={`Recorded output in ${testReplay.app}`}
        >
          <code>
            {testReplay.runs.map((run) => (
              <span key={run.id} className={styles.run} data-run={run.id}>
                <span className={styles.line}>
                  <span className={styles.prompt} aria-hidden="true">
                    ${" "}
                  </span>
                  {run.command}
                </span>
                {run.lines.map((line, index) => {
                  const lineKey = `${run.id}:${index}`
                  return (
                    <span key={lineKey} className={styles.line} data-replay-line="">
                      {line || " "}
                    </span>
                  )
                })}
              </span>
            ))}
          </code>
        </pre>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
```

- [ ] **Step 5: The deploy-target island**

Create `apps/web/app/components/homepage/ship/DeployTargets.tsx`:

```tsx
"use client"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { gsap, withMotion } from "../motion/gsap"
import styles from "./ship.module.css"
import { buildFor, buildOutputs, deployTargets, describeTarget, type TargetId } from "./ship-data"

type Fade = ReturnType<typeof gsap.fromTo>

/** Stops a running fade and drops the inline opacity it left behind. */
function stopFade(fade: { current: Fade | null }) {
  const running = fade.current
  fade.current = null
  if (!running) return
  const targets = running.targets()
  running.kill()
  gsap.set(targets, { clearProps: "opacity" })
}

/**
 * The deploy-target switcher: one radio per target, and for each the
 * b4.config.ts line that selects it and the recorded `b4 build` output. Every
 * target stays mounted in one grid cell, so the tallest reserves the space.
 */
export function DeployTargets({
  code,
}: {
  readonly code: Readonly<Record<TargetId, readonly string[]>>
}) {
  const name = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const optionsRef = useRef<HTMLFieldSetElement>(null)
  const motionRef = useRef(false)
  const fadeRef = useRef<Fade | null>(null)
  const [active, setActive] = useState<TargetId>("node")
  const [changes, setChanges] = useState(0)
  const [refocus, setRefocus] = useState(false)
  const [announcement, setAnnouncement] = useState("")

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stop = withMotion(root, {
      reduce: () => {
        motionRef.current = false
        stopFade(fadeRef)
        return undefined
      },
      full: () => {
        motionRef.current = true
        return () => {
          motionRef.current = false
        }
      },
    })
    return () => {
      stop()
      stopFade(fadeRef)
    }
  }, [])

  useLayoutEffect(() => {
    if (changes === 0) return
    stopFade(fadeRef)
    if (!motionRef.current) return
    const target = rootRef.current?.querySelector(`[data-target="${active}"]`)
    if (!target) return
    fadeRef.current = gsap.fromTo(
      target,
      { opacity: 0 },
      { opacity: 1, duration: 0.2, ease: "power1.out", clearProps: "opacity" },
    )
  }, [changes, active])

  // Focus moves once React commits, when the old target is inert.
  useLayoutEffect(() => {
    if (!refocus) return
    rootRef.current?.querySelector<HTMLInputElement>(`input[value="${active}"]`)?.focus()
    setRefocus(false)
  }, [refocus, active])

  function choose(id: TargetId) {
    const target = deployTargets.find((candidate) => candidate.id === id)
    if (!target) return
    // Clicking a label doesn't focus its radio in Safari, and WebKit may have
    // moved focus on mousedown to an ancestor (<main tabindex="-1"> or
    // <body>). Focus may also sit on a docs link this change makes inert.
    // Give it to the newly checked radio.
    const root = rootRef.current
    const focused = document.activeElement
    const stranded =
      root !== null &&
      (focused === null ||
        ((root.contains(focused) || focused.contains(root)) &&
          optionsRef.current?.contains(focused) !== true))
    setActive(id)
    setChanges((count) => count + 1)
    setAnnouncement(describeTarget(target))
    setRefocus(stranded)
  }

  return (
    <div ref={rootRef} className={styles.targets}>
      <fieldset ref={optionsRef} className={styles.options}>
        <legend className={styles.legend}>Deploy target</legend>
        {deployTargets.map((target) => (
          <label key={target.id} className={styles.option}>
            <input
              type="radio"
              name={name}
              value={target.id}
              checked={target.id === active}
              onChange={() => choose(target.id)}
            />
            <span>{target.id}</span>
          </label>
        ))}
      </fieldset>
      <div className={styles.stage}>
        {deployTargets.map((target) => {
          const on = target.id === active
          const build = buildFor(target.build)
          return (
            <div
              key={target.id}
              className={styles.panel}
              data-target={target.id}
              data-active={on}
              aria-hidden={on ? undefined : true}
              inert={on ? undefined : true}
            >
              <p className={styles.path}>b4.config.ts</p>
              <pre className={styles.code}>
                <code>
                  {code[target.id].map((html, index) => {
                    const lineKey = `${target.id}:config:${index}`
                    return (
                      <span
                        key={lineKey}
                        className={styles.line}
                        // biome-ignore lint/security/noDangerouslySetInnerHtml: Only server-produced Shiki tokens; highlightCode escapes all source text.
                        dangerouslySetInnerHTML={{ __html: html }}
                      />
                    )
                  })}
                </code>
              </pre>
              <pre className={styles.output}>
                <code>
                  {[buildOutputs.command, ...target.after].map((command, commandIndex) => (
                    <span key={command} className={styles.run}>
                      {command.split("\n").map((part, index) => {
                        const partKey = `${command}:${index}`
                        return (
                          <span key={partKey} className={styles.line}>
                            <span className={styles.prompt} aria-hidden="true">
                              {index === 0 ? "$ " : "  "}
                            </span>
                            {part}
                          </span>
                        )
                      })}
                      {commandIndex === 0 &&
                        build.lines.map((line, index) => {
                          const lineKey = `${target.id}:out:${index}`
                          return (
                            <span key={lineKey} className={styles.line}>
                              {line}
                            </span>
                          )
                        })}
                    </span>
                  ))}
                </code>
              </pre>
              <p className={styles.note}>
                <span>{target.summary}</span>
                <a href={target.docsHref}>{target.docsLabel} →</a>
              </p>
            </div>
          )
        })}
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
```

- [ ] **Step 6: The shell and the styles**

Create `apps/web/app/components/homepage/ship/TestAndShip.tsx`:

```tsx
import { Eyebrow } from "../../ui/Eyebrow"
import { DeployTargets } from "./DeployTargets"
import styles from "./ship.module.css"
import { shipLinks, type TargetId } from "./ship-data"
import { TestReplay } from "./TestReplay"

/**
 * "Test and ship": the scaffold's recorded tests beside the deploy targets.
 * Each half is its own island; the server renders both complete.
 */
export function TestAndShip({
  code,
}: {
  readonly code: Readonly<Record<TargetId, readonly string[]>>
}) {
  return (
    <section id="test-and-ship" className={styles.section} aria-labelledby="test-and-ship-title">
      <div className={styles.intro}>
        <Eyebrow className={styles.eyebrow}>Test and ship</Eyebrow>
        <h2 id="test-and-ship-title">Test it offline, then pick where it runs.</h2>
        <p>
          The scaffold's test and eval answer from script() fixtures instead of a model, so they
          need no API key. One line of b4.config.ts picks what b4 build emits.
        </p>
      </div>
      <div className={styles.columns}>
        <div className={styles.column}>
          <h3 className={styles.columnTitle}>npm test and b4 eval</h3>
          <p className={styles.columnNote}>
            Recorded in a fresh scaffold, with no OPENAI_API_KEY set.
          </p>
          <TestReplay />
        </div>
        <div className={styles.column}>
          <h3 className={styles.columnTitle}>b4 build</h3>
          <p className={styles.columnNote}>
            node and langsmith are the defaults. Setting build.targets replaces them.
          </p>
          <DeployTargets code={code} />
        </div>
      </div>
      <p className={styles.links}>
        {shipLinks.map((link) => (
          <a key={link.href} href={link.href}>
            {link.label} →
          </a>
        ))}
      </p>
    </section>
  )
}
```

Create `apps/web/app/components/homepage/ship/ship.module.css`:

```css
/* "Test and ship" (#test-and-ship). Paper Relay tokens only (tokens.css). */
.section {
  padding: 56px 0;
  border-bottom: 1px solid var(--color-rule);
  container-type: inline-size;
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

/* Stacked on phones, side by side when there's room for both panels. */
.columns {
  display: grid;
  gap: 40px;
}
.column {
  min-width: 0;
}
.columnTitle {
  margin: 0 0 4px;
  font:
    500 15px / 1.5 var(--font-mono),
    monospace;
  color: var(--color-ink);
}
.columnNote {
  margin: 0 0 16px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-ink-muted);
}
@container (min-width: 960px) {
  .columns {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}

/* Replay buttons: native buttons, 44px tall, wrapping on narrow screens. */
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.controls button {
  min-height: 44px;
  padding: 0 16px;
  border: 1px solid var(--color-rule-strong);
  background: var(--color-page);
  font:
    13px / 1.4 var(--font-mono),
    monospace;
  color: var(--color-ink);
  cursor: pointer;
}
.controls button:hover {
  background: var(--color-relay-tint);
}

/* The terminal, and the deploy panels: the dark code panel. */
.terminal,
.panel {
  background: var(--color-panel);
  color: var(--color-panel-ink);
  /* The global focus ring is tuned for paper; on the panel it uses the accent. */
  --color-focus: var(--color-panel-accent);
}
.bar,
.path {
  margin: 0;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-panel-rule);
  background: var(--color-panel-strip);
  font:
    12px / 1.6 var(--font-mono),
    monospace;
  color: var(--color-panel-muted);
}
.log,
.code,
.output {
  margin: 0;
  padding: 16px;
  font:
    13px / 1.7 var(--font-mono),
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}
.log code,
.code code,
.output code {
  font: inherit;
}
.output {
  border-top: 1px solid var(--color-panel-rule);
  color: var(--color-panel-muted);
}
.run {
  display: block;
}
.run + .run {
  margin-top: 1lh;
}
.line {
  display: block;
  min-height: 1lh;
}
.prompt {
  color: var(--color-panel-accent);
}

/* Deploy targets: the segmented control, as in "You keep the graph". Every
   cell overlaps its right and bottom neighbours by 1px, so borders never
   double; the padding gives the last cell's overlap back. */
.options {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  min-inline-size: 0;
  margin: 0 0 16px;
  padding: 0 1px 1px 0;
  border: 0;
}
.legend {
  margin-bottom: 8px;
  padding: 0;
  font:
    12px / 1.6 var(--font-mono),
    monospace;
  color: var(--color-ink-muted);
}
.option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  margin: 0 -1px -1px 0;
  padding: 0 14px;
  border: 1px solid var(--color-rule-strong);
  font:
    13px / 1.4 var(--font-mono),
    monospace;
  color: var(--color-ink);
  cursor: pointer;
}
.option input {
  margin: 0;
  accent-color: var(--color-ink);
}
.option:has(input:checked) {
  position: relative;
  z-index: 1;
  border-color: var(--color-ink);
  background: var(--color-relay-tint);
}

/* Every target sits in the same grid cell: the tallest sets the height, so
   switching never shifts the page. Only the active one is visible. */
.stage {
  display: grid;
}
.stage > * {
  grid-area: 1 / 1;
}
.stage > :not([data-active="true"]) {
  visibility: hidden;
}
.panel {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
}
.note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  margin: auto 0 0;
  padding: 8px 16px;
  border-top: 1px solid var(--color-panel-rule);
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-panel-muted);
}
.note a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: var(--color-panel-ink);
  text-underline-offset: 5px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 0 24px;
  margin: 16px 0 0;
}
.links a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  font-size: 14px;
  text-underline-offset: 5px;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/ship app/styles/design-system.test.ts`
Expected: PASS (21 tests in `ship/`, and the design-system guard).

- [ ] **Step 8: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/ship/prepare.ts apps/web/app/components/homepage/ship/TestReplay.tsx apps/web/app/components/homepage/ship/DeployTargets.tsx apps/web/app/components/homepage/ship/TestAndShip.tsx apps/web/app/components/homepage/ship/ship.module.css apps/web/app/components/homepage/ship/TestAndShip.test.tsx
git commit -m "feat(web): the test replay and deploy-target switcher

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The checklist fixtures, items and pins

**Files:**
- Create: `checklist/fixtures/b4.config.sandbox.ts`, `checklist/fixtures/b4.config.postgres.ts`, `checklist/fixtures/src/middleware.ts`, `checklist/fixtures/src/auth.ts`, `checklist/fixtures/src/thread-access.ts`, `checklist/fixtures/src/app/support/index.ts`, `checklist/checklist.ts`
- Test: `checklist/checklist.test.ts`

**Why fixtures, a tour fixture and template files.** Every excerpt comes from a file something typechecks: the fixtures here and the tour's `memory.ts` by `pnpm --dir apps/web typecheck` (tsconfig `include: ["**/*.ts"]`), and the template's `greet.ts`, `agent.test.ts.template` and `smoke.eval.ts.template` by the generated-app harness, which scaffolds the basic app and runs its `typecheck`. The streaming and Inspector excerpts are an endpoint and a command, pinned to the docs page and to the runtime or the CLI.

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/homepage/checklist/checklist.test.ts`:

```ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createProgram } from "@b4run/cli"
import { extractToolSchemasForRoute } from "@b4run/core/node"
import type { PermissionDecision } from "@b4run/permissions"
import { dockerSandbox, kubernetesSandbox } from "@b4run/sandbox"
import {
  allow,
  deny,
  isB4Agent,
  type MiddlewareRequest,
  permit,
  reject,
  type ThreadAccessRequest,
} from "@b4run/sdk"
import { describe, expect, it } from "vitest"
import { contrast } from "../../../../lib/design-system-checks"
import { COLOR } from "../../../../lib/design-tokens"
import { DOCS_INDEX } from "../../docs/search-index"
import { checklist, describeToggle } from "./checklist"
import sandboxConfig from "./fixtures/b4.config.sandbox"
import support from "./fixtures/src/app/support/index"
import middleware from "./fixtures/src/middleware"
import threadAccess from "./fixtures/src/thread-access"

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url))
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8")
const itemOf = (id: string) => {
  const item = checklist.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`No checklist item ${id}`)
  return item
}

describe("the checklist shows real code", () => {
  it("has twelve items, each with a docs link and one or two sentences", () => {
    expect(checklist).toHaveLength(12)
    expect(new Set(checklist.map((item) => item.id)).size).toBe(12)
    for (const item of checklist) {
      for (const text of [item.title, item.chore, item.handledBy, item.code]) {
        expect(text, item.id).not.toContain("—")
      }
      expect(item.handledBy.match(/[.!?](?=\s|$)/g)?.length, item.id).toBeLessThanOrEqual(2)
      expect(item.chore, item.id).toMatch(/\.$/)
    }
  })

  it("takes every excerpt from its file, line for line", () => {
    for (const item of checklist) {
      const source = read(item.origin)
      const lines = source.split("\n").map((line) => line.trim())
      for (const line of item.code.split("\n")) {
        if (item.origin.endsWith(".mdx")) expect(source, item.id).toContain(line)
        else expect(lines, `${item.id}: ${line}`).toContain(line.trim())
      }
    }
  })

  it("reads a tool's schema from its types and doc comment, as b4 typegen does", async () => {
    const [greet, ...rest] = await extractToolSchemasForRoute({
      routeDir: resolve(repoRoot, "packages/devkit/templates/app-basic/src/app/hello"),
      sharedToolsDir: undefined,
      tsconfig: resolve(repoRoot, "packages/config-typescript/node.json"),
    })
    expect(rest).toEqual([])
    expect(greet?.name).toBe("greet")
    expect(greet?.description).toBe("Greet someone by name.")
    expect(greet?.parameters).toMatchObject({ required: ["name"], additionalProperties: false })
  }, 60_000)

  it("streams on the endpoints the runtime serves", () => {
    const runtime = read("packages/cli/src/lib/dev/runtime-fetch-core.ts")
    expect(runtime).toContain("// POST /threads/:thread_id/runs/stream")
    expect(runtime).toContain("// POST /agui/:routeId")
  })

  it("turns away a request the middleware rejects, and lets the rest through", async () => {
    const request = (headers: Record<string, string>) =>
      ({ headers, params: {}, routeId: "/support", method: "POST" }) as unknown as MiddlewareRequest
    if (typeof middleware !== "function") throw new Error("The fixture is a handler function")
    await expect(middleware(request({}))).resolves.toEqual(
      reject(401, { error: "Missing x-api-key" }),
    )
    await expect(middleware(request({ "x-api-key": "k" }))).resolves.toEqual(allow())
  })

  it("stamps a thread's owner, and lets only that owner back in", async () => {
    const request = (headers: Record<string, string>, ownerId?: string) =>
      ({
        action: "read",
        headers,
        thread: ownerId === undefined ? undefined : { access: { ownerId } },
      }) as unknown as ThreadAccessRequest
    await expect(threadAccess.create?.(request({ "x-user-id": "ada" }))).resolves.toEqual(
      permit({ ownerId: "ada" }),
    )
    await expect(threadAccess.create?.(request({}))).resolves.toEqual(deny())
    await expect(threadAccess.fallback(request({ "x-user-id": "ada" }, "ada"))).resolves.toEqual(
      permit(),
    )
    await expect(threadAccess.fallback(request({ "x-user-id": "bob" }, "ada"))).resolves.toEqual(
      deny(),
    )
    await expect(threadAccess.fallback(request({ "x-user-id": "ada" }))).resolves.toEqual(deny())
  })

  it("names exactly the three approval decisions", () => {
    const decisions = ["once", "always", "deny"] as const satisfies readonly PermissionDecision[]
    const exhaustive: [Exclude<PermissionDecision, (typeof decisions)[number]>] extends [never]
      ? true
      : false = true
    expect(exhaustive).toBe(true)
    expect(itemOf("approval").handledBy).toContain(
      decisions.join(", ").replace(", deny", " or deny"),
    )
    expect(isB4Agent(support)).toBe(true)
  })

  it("configures a real sandbox provider, and names a real Kubernetes one", () => {
    expect(typeof dockerSandbox).toBe("function")
    expect(typeof kubernetesSandbox).toBe("function")
    expect(typeof sandboxConfig.sandbox?.provider.acquire).toBe("function")
    expect(itemOf("sandbox").handledBy).toContain("kubernetesSandbox")
  })

  it("names only commands and flags the b4 CLI has", () => {
    const program = createProgram({ stdout: () => undefined, stderr: () => undefined })
    const command = (name: string) => program.commands.find((entry) => entry.name() === name)
    expect(command("typegen")).toBeDefined()
    expect(command("inspect")).toBeDefined()
    expect(command("eval")?.options.map((option) => option.long)).toContain("--record")
    expect(itemOf("evals").handledBy).toContain("b4 eval --record")
    expect(itemOf("schemas").handledBy).toContain("b4 typegen")
    expect(itemOf("inspect").code).toBe("b4 inspect")
    // The basic scaffold installs the Inspector, so b4 inspect works in it.
    expect(
      JSON.parse(read("packages/devkit/templates/app-basic/package.json.template")).devDependencies,
    ).toHaveProperty("@b4run/inspector")
  })

  it("announces each turn with the new count, and Handled. at twelve", () => {
    const [first] = checklist
    if (!first) throw new Error("No items")
    expect(describeToggle(first, true, 1)).toBe(
      "Tool schemas: b4 typegen reads the tool's TypeScript types and its doc comment. 1 of 12 opened.",
    )
    expect(describeToggle(first, false, 0)).toBe("Tool schemas closed. 0 of 12 opened.")
    expect(describeToggle(first, true, 12)).toMatch(/12 of 12 opened\. Handled\.$/)
  })

  it("links to docs headings that exist", () => {
    for (const item of checklist) {
      const [path, anchor] = item.docsHref.split("#")
      const page = DOCS_INDEX.find((entry) => entry.href === path)
      expect(page, item.docsHref).toBeDefined()
      expect(
        page?.headings.map((heading) => heading.anchor),
        item.docsHref,
      ).toContain(anchor)
    }
  })

  it("keeps tile text at 4.5:1 or more on paper and on the opened tint", () => {
    for (const background of [COLOR.page, COLOR["relay-tint"]]) {
      for (const foreground of [COLOR.ink, COLOR["ink-muted"], COLOR["relay-ink"]]) {
        expect(
          contrast(foreground, background),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/checklist/checklist.test.ts`
Expected: FAIL; `./checklist` and the fixtures can't be resolved.

- [ ] **Step 3: Write the fixtures**

`checklist/fixtures/src/middleware.ts` (the `/docs/middleware#file-location` example):

```ts
import { allow, defineMiddleware, reject } from "@b4run/sdk"

export default defineMiddleware(async (req) => {
  if (!req.headers["x-api-key"]) {
    return reject(401, { error: "Missing x-api-key" })
  }
  return allow()
})
```

`checklist/fixtures/src/auth.ts`:

```ts
export interface Principal {
  readonly id: string
}

/** Resolve the caller from a trusted header. Replace it with your token check. */
export async function principalOf(
  headers: Readonly<Record<string, string>>,
): Promise<Principal | undefined> {
  const id = headers["x-user-id"]
  return id === undefined ? undefined : { id }
}
```

`checklist/fixtures/src/thread-access.ts`:

```ts
import { defineThreadAccess, deny, permit } from "@b4run/sdk"
import { principalOf } from "./auth.js"

export default defineThreadAccess({
  create: async (req) => {
    const user = await principalOf(req.headers)
    return user ? permit({ ownerId: user.id }) : deny()
  },
  fallback: async (req) => {
    const user = await principalOf(req.headers)
    const owner = req.thread?.access?.ownerId
    return user !== undefined && owner === user.id ? permit() : deny()
  },
})
```

`checklist/fixtures/src/app/support/index.ts`:

```ts
import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "You help customers with their orders.",
  tools: { approve: ["refund"] },
  retry: { maxAttempts: 5, baseDelay: 500 },
})
```

`checklist/fixtures/b4.config.sandbox.ts`:

```ts
import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"

export default config({
  sandbox: {
    provider: dockerSandbox({ scope: "my-agent", image: "node:24-slim" }),
  },
})
```

`checklist/fixtures/b4.config.postgres.ts`. Importing it creates a `pg` pool, which connects only on a query, so the test doesn't import it; the typecheck covers it.

```ts
import { config } from "@b4run/cli"
import {
  createPostgresPermissionsStore,
  createPostgresPool,
  createPostgresThreadsStore,
  postgresCheckpointer,
} from "@b4run/postgres-storage/node"

const pool = createPostgresPool({ connectionString: process.env.DATABASE_URL })

export default config({
  checkpointer: postgresCheckpointer({ pool }),
  threadsStore: createPostgresThreadsStore({ pool }),
  permissions: { store: createPostgresPermissionsStore({ pool, mode: "non-interactive" }) },
})
```

- [ ] **Step 4: Write the items**

Create `apps/web/app/components/homepage/checklist/checklist.ts`:

```ts
/**
 * "The last mile": twelve parts of shipping an agent, and what in B4 handles
 * each. Every `code` excerpt is lines of a real file (`origin`): a fixture
 * under checklist/fixtures/ or the tour's, which the web typecheck compiles,
 * or a basic-template file, which the generated-app harness typechecks.
 * checklist.test.ts pins each excerpt, and runs the handler where one can run.
 */
export type ChecklistId =
  | "schemas"
  | "streaming"
  | "auth"
  | "thread-access"
  | "approval"
  | "sandbox"
  | "memory"
  | "retries"
  | "persistence"
  | "tests"
  | "evals"
  | "inspect"

export interface ChecklistItem {
  readonly id: ChecklistId
  readonly title: string
  /** The front of the tile: the work you would otherwise write. */
  readonly chore: string
  /** The back of the tile: what handles it. One or two sentences. */
  readonly handledBy: string
  /** Where the excerpt lives in the scaffolded app, when it is a file. */
  readonly file: string | null
  /** A few real lines, or the command or endpoints that do the work. */
  readonly code: string
  /** The file the excerpt comes from, relative to the repository root. */
  readonly origin: string
  readonly docsHref: string
  readonly docsLabel: string
}

export const CHECKLIST_FIXTURES = "apps/web/app/components/homepage/checklist/fixtures/"
const TEMPLATE = "packages/devkit/templates/app-basic/"

export const checklist: readonly ChecklistItem[] = [
  {
    id: "schemas",
    title: "Tool schemas",
    chore: "Describe every tool's input as JSON Schema, and keep it in step with the code.",
    handledBy: "b4 typegen reads the tool's TypeScript types and its doc comment.",
    file: "src/app/hello/tools/greet.ts",
    code: "/** Greet someone by name. */\nexport default async (input: { readonly name: string }) => {",
    origin: `${TEMPLATE}src/app/hello/tools/greet.ts`,
    docsHref: "/docs/tools#tool-descriptions",
    docsLabel: "Tools",
  },
  {
    id: "streaming",
    title: "Streaming",
    chore: "Stream tokens and tool calls to a web client as they happen.",
    handledBy: "Every route streams over Agent Protocol and AG-UI.",
    file: null,
    code: "POST /threads/:thread_id/runs/stream\nPOST /agui/{routeId}",
    origin: "apps/web/content/docs/dev-server/agent-protocol.mdx",
    docsHref: "/docs/dev-server/agent-protocol#streaming-over-sse",
    docsLabel: "Agent Protocol",
  },
  {
    id: "auth",
    title: "Auth",
    chore: "Check who is calling before a route runs.",
    handledBy: "One middleware file runs before every route request.",
    file: "src/middleware.ts",
    code: "export default defineMiddleware(async (req) => {",
    origin: `${CHECKLIST_FIXTURES}src/middleware.ts`,
    docsHref: "/docs/middleware#file-location",
    docsLabel: "Middleware",
  },
  {
    id: "thread-access",
    title: "Thread access",
    chore: "Keep one user out of another user's threads.",
    handledBy: "One policy file decides who may create, read, change or delete each thread.",
    file: "src/thread-access.ts",
    code: "export default defineThreadAccess({",
    origin: `${CHECKLIST_FIXTURES}src/thread-access.ts`,
    docsHref: "/docs/thread-access#the-shape",
    docsLabel: "Thread access",
  },
  {
    id: "approval",
    title: "Human approval",
    chore: "Pause a risky tool call until a person says yes.",
    handledBy: "The run pauses, and a person answers once, always or deny.",
    file: "src/app/support/index.ts",
    code: 'tools: { approve: ["refund"] },',
    origin: `${CHECKLIST_FIXTURES}src/app/support/index.ts`,
    docsHref: "/docs/permissions#per-tool-approval",
    docsLabel: "Permissions",
  },
  {
    id: "sandbox",
    title: "Sandboxing",
    chore: "Run the agent's shell commands away from your host.",
    handledBy:
      "The file tools and runBash run in a Docker container, or in a Kubernetes Pod with kubernetesSandbox.",
    file: "b4.config.ts",
    code: 'provider: dockerSandbox({ scope: "my-agent", image: "node:24-slim" }),',
    origin: `${CHECKLIST_FIXTURES}b4.config.sandbox.ts`,
    docsHref: "/docs/sandbox#quickstart",
    docsLabel: "Sandbox",
  },
  {
    id: "memory",
    title: "Memory",
    chore: "Remember facts about a user from one conversation to the next.",
    handledBy: "A memory.ts file gives the agent remember and recall tools.",
    file: "src/app/hello/memory.ts",
    code: 'export default defineMemory({\n  kind: "semantic",',
    origin: "apps/web/app/components/homepage/tour/fixtures/hello/memory.ts",
    docsHref: "/docs/memory/long-term#declare-a-collection",
    docsLabel: "Long-term memory",
  },
  {
    id: "retries",
    title: "Model retries",
    chore: "Retry the model after a rate limit or a dropped connection.",
    handledBy:
      "Model calls that hit a rate limit, a server error or a network error retry with backoff.",
    file: "src/app/support/index.ts",
    code: "retry: { maxAttempts: 5, baseDelay: 500 },",
    origin: `${CHECKLIST_FIXTURES}src/app/support/index.ts`,
    docsHref: "/docs/retry#configuring-retry",
    docsLabel: "Retry",
  },
  {
    id: "persistence",
    title: "Persistence",
    chore: "Keep threads and checkpoints when the server restarts.",
    handledBy:
      "@b4run/postgres-storage gives you the checkpointer, the thread store and the permission store.",
    file: "b4.config.ts",
    code: "checkpointer: postgresCheckpointer({ pool }),\nthreadsStore: createPostgresThreadsStore({ pool }),",
    origin: `${CHECKLIST_FIXTURES}b4.config.postgres.ts`,
    docsHref: "/docs/configuration#postgres-backend",
    docsLabel: "Postgres backend",
  },
  {
    id: "tests",
    title: "Offline tests",
    chore: "Test the agent without paying for a model call.",
    handledBy: "script() fixtures stand in for the model, so npm test needs no API key.",
    file: "test/agent.test.ts",
    code: 'fixtures: script().user("Say hello to Ada").replies("Hello, Ada!"),',
    origin: `${TEMPLATE}test/agent.test.ts.template`,
    docsHref: "/docs/testing-agents#your-scaffolded-app-already-has-a-test",
    docsLabel: "Testing agents",
  },
  {
    id: "evals",
    title: "Evals",
    chore: "Score the agent on a dataset before you ship.",
    handledBy:
      "b4 eval replays each case offline, and b4 eval --record captures new fixtures from the model.",
    file: "src/app/hello/evals/smoke.eval.ts",
    code: 'export default defineEval({\n  name: "greets by name",',
    origin: `${TEMPLATE}src/app/hello/evals/smoke.eval.ts.template`,
    docsHref: "/docs/evals#recording-fixtures-with---record",
    docsLabel: "Evals",
  },
  {
    id: "inspect",
    title: "Inspection",
    chore: "See what the agent has remembered, and govern it.",
    handledBy: "b4 inspect opens the Inspector, a browser view of the app's long-term memory.",
    file: null,
    code: "b4 inspect",
    origin: "apps/web/content/docs/inspector.mdx",
    docsHref: "/docs/inspector#launching",
    docsLabel: "Inspector",
  },
]

/** What the live region says after a tile turns. The count always changes, so the text does. */
export function describeToggle(item: ChecklistItem, open: boolean, opened: number): string {
  const count = `${opened} of ${checklist.length} opened.`
  const done = opened === checklist.length ? " Handled." : ""
  return open
    ? `${item.title}: ${item.handledBy} ${count}${done}`
    : `${item.title} closed. ${count}`
}
```

- [ ] **Step 5: Run the test and the typecheck**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/checklist/checklist.test.ts`
Expected: PASS, 12 tests.

Run: `pnpm --dir apps/web typecheck`
Expected: exit 0. This is what proves every fixture compiles against the real packages.

- [ ] **Step 6: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/checklist/fixtures apps/web/app/components/homepage/checklist/checklist.ts apps/web/app/components/homepage/checklist/checklist.test.ts
git commit -m "feat(web): the production checklist items, pinned to real code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The ProductionChecklist island and the LastMile shell

**Files:**
- Create: `checklist/ProductionChecklist.tsx`, `checklist/LastMile.tsx`, `checklist/checklist.module.css`
- Test: `checklist/ProductionChecklist.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/homepage/checklist/ProductionChecklist.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from "react"
import { createRoot, hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { FULL, gsap, REDUCE } from "../motion/gsap"
import { type MediaStub, stubMatchMedia } from "../motion/media-stub"
import { checklist, describeToggle } from "./checklist"
import { LastMile } from "./LastMile"
import { ProductionChecklist } from "./ProductionChecklist"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let media: MediaStub | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
  media?.restore()
  media = undefined
})

const [first, second] = checklist
if (!first || !second) throw new Error("The checklist has items")

function query(container: Element) {
  const q = <T extends Element>(selector: string) => {
    const match = container.querySelector<T>(selector)
    if (!match) throw new Error(`No ${selector}`)
    return match
  }
  return {
    q,
    pressed: () =>
      [...container.querySelectorAll("[data-toggle]")].map((node) =>
        node.getAttribute("aria-pressed"),
      ),
    counter: () => container.querySelector("[data-counter]")?.textContent,
    handled: () => q("[data-done]"),
    live: () => container.querySelector('[aria-live="polite"]')?.textContent,
    face: (id: string, face: "chore" | "handled") =>
      q<HTMLElement>(`[data-item="${id}"] [data-face="${face}"]`),
  }
}

async function mount(reduce: boolean) {
  media = stubMatchMedia({ [REDUCE]: reduce, [FULL]: !reduce })
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () => root?.render(<ProductionChecklist />))
  const view = query(container)
  return {
    ...view,
    container,
    toggle: (id: string) =>
      act(async () => view.q<HTMLButtonElement>(`[data-toggle="${id}"]`).click()),
  }
}

it("renders every tile turned over on the server, so each answer is in the page", () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(<LastMile />)
  const view = query(container)
  expect(container.querySelector("section#last-mile")?.getAttribute("aria-labelledby")).toBe(
    "last-mile-title",
  )
  expect(view.pressed()).toEqual(checklist.map(() => "true"))
  for (const item of checklist) {
    const answer = view.face(item.id, "handled")
    expect(answer.getAttribute("data-active"), item.id).toBe("true")
    expect(answer.hasAttribute("inert"), item.id).toBe(false)
    expect(answer.textContent, item.id).toContain(item.handledBy)
    expect(answer.textContent, item.id).toContain(item.code)
    expect(answer.querySelector("a")?.getAttribute("href"), item.id).toBe(item.docsHref)
    const chore = view.face(item.id, "chore")
    expect(chore.getAttribute("aria-hidden"), item.id).toBe("true")
    expect(chore.hasAttribute("inert"), item.id).toBe(true)
  }
  expect(view.counter()).toBe("12 of 12 opened")
  expect(view.handled().getAttribute("aria-hidden")).toBeNull()
  expect(container.querySelector("[style]")).toBeNull()
  expect(view.live()).toBe("")
})

it("turns every tile face down once it runs, without announcing anything", async () => {
  const view = await mount(true)
  expect(view.pressed()).toEqual(checklist.map(() => "false"))
  expect(view.counter()).toBe("0 of 12 opened")
  expect(view.handled().getAttribute("aria-hidden")).toBe("true")
  expect(view.face(first.id, "handled").hasAttribute("inert")).toBe(true)
  expect(view.live()).toBe("")
})

it("turns a tile at once, counts it, and announces each turn once", async () => {
  const view = await mount(true)
  await view.toggle(first.id)
  expect(view.q(`[data-toggle="${first.id}"]`).getAttribute("aria-pressed")).toBe("true")
  expect(view.face(first.id, "handled").getAttribute("data-active")).toBe("true")
  expect(view.face(first.id, "chore").hasAttribute("inert")).toBe(true)
  expect(view.counter()).toBe("1 of 12 opened")
  expect(view.live()).toBe(describeToggle(first, true, 1))
  await view.toggle(first.id)
  expect(view.counter()).toBe("0 of 12 opened")
  expect(view.live()).toBe("Tool schemas closed. 0 of 12 opened.")
  // Reduced motion: no tweens at all.
  expect(view.container.querySelectorAll("[data-face]").length).toBe(24)
  expect(
    [...view.container.querySelectorAll("[data-face]")].flatMap((node) => gsap.getTweensOf(node)),
  ).toEqual([])
})

it("says Handled. when all twelve are open, and only then", async () => {
  const view = await mount(true)
  for (const item of checklist) await view.toggle(item.id)
  expect(view.counter()).toBe("12 of 12 opened")
  expect(view.handled().getAttribute("data-done")).toBe("true")
  expect(view.handled().getAttribute("aria-hidden")).toBeNull()
  expect(view.live()).toMatch(/12 of 12 opened\. Handled\.$/)
})

it("flips with rotateY when motion is on, and the next turn kills the flip", async () => {
  const view = await mount(false)
  const fromTo = vi.spyOn(gsap, "fromTo")
  await view.toggle(first.id)
  expect(fromTo).toHaveBeenCalledTimes(1)
  const [target, from, to] = fromTo.mock.calls[0] ?? []
  expect(target).toBe(view.face(first.id, "handled"))
  expect(from).toMatchObject({ rotateY: -90 })
  expect(to).toMatchObject({ rotateY: 0, duration: 0.3 })
  await view.toggle(second.id)
  expect(view.counter()).toBe("2 of 12 opened")
  const flipped = view.face(first.id, "handled")
  expect(gsap.getTweensOf(flipped)).toEqual([])
  expect(flipped.style.transform).toBe("")
  expect(flipped.style.opacity).toBe("")
})

it("keeps focus on the tile's button when a turn would strand it", async () => {
  const view = await mount(true)
  await view.toggle(first.id)
  // Focus on the docs link the next turn hides.
  view.face(first.id, "handled").querySelector("a")?.focus()
  await view.toggle(first.id)
  expect(document.activeElement).toBe(view.q(`[data-toggle="${first.id}"]`))
  // WebKit leaves focus on an ancestor after a click on a button.
  const main = document.createElement("main")
  main.tabIndex = -1
  document.body.replaceChildren(main)
  main.append(view.container)
  main.focus()
  await view.toggle(second.id)
  expect(document.activeElement).toBe(view.q(`[data-toggle="${second.id}"]`))
})

it("moves focus off an answer the first render hides", async () => {
  media = stubMatchMedia({ [REDUCE]: true, [FULL]: false })
  const container = document.createElement("div")
  container.innerHTML = renderToString(<ProductionChecklist />)
  document.body.replaceChildren(container)
  container.querySelector<HTMLAnchorElement>(`[data-item="${second.id}"] a`)?.focus()
  await act(async () => {
    root = hydrateRoot(container, <ProductionChecklist />)
  })
  expect(document.activeElement).toBe(container.querySelector(`[data-toggle="${second.id}"]`))
  expect(query(container).counter()).toBe("0 of 12 opened")
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/checklist/ProductionChecklist.test.tsx`
Expected: FAIL; `./LastMile` and `./ProductionChecklist` can't be resolved.

- [ ] **Step 3: The island**

Create `apps/web/app/components/homepage/checklist/ProductionChecklist.tsx`:

```tsx
"use client"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { gsap, withMotion } from "../motion/gsap"
import { type ChecklistId, type ChecklistItem, checklist, describeToggle } from "./checklist"
import styles from "./checklist.module.css"

type Flip = ReturnType<typeof gsap.fromTo>

/** Stops a running flip and drops the inline styles it left behind. */
function stopFlip(flip: { current: Flip | null }) {
  const running = flip.current
  flip.current = null
  if (!running) return
  const targets = running.targets()
  running.kill()
  gsap.set(targets, { clearProps: "opacity,transform" })
}

const EVERY_ID: ReadonlySet<ChecklistId> = new Set(checklist.map((item) => item.id))

/**
 * The production checklist: twelve tiles, each a toggle button that turns its
 * tile over to show what handles that part. The server renders every tile
 * turned over, so the answers are there without JavaScript; the island turns
 * them back once it runs. Each tile's two faces share one grid cell, so a
 * turn never moves the page. The state and the announcement change at once;
 * the 300ms rotateY only moves pixels, and the next turn kills it.
 */
export function ProductionChecklist() {
  const rootRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef(false)
  const flipRef = useRef<Flip | null>(null)
  const [open, setOpen] = useState<ReadonlySet<ChecklistId>>(EVERY_ID)
  const [turn, setTurn] = useState<{ readonly id: ChecklistId; readonly count: number } | null>(
    null,
  )
  const [focusTarget, setFocusTarget] = useState<ChecklistId | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const done = open.size === checklist.length

  // Turn every tile face down once JavaScript runs. If focus is already on a
  // docs link this hides, hand it to that tile's button.
  useEffect(() => {
    const focused = document.activeElement
    const face = focused?.closest("[data-face]")
    const item = face ? rootRef.current?.contains(face) && face.closest("[data-item]") : null
    setOpen(new Set())
    const id = item ? item.getAttribute("data-item") : null
    if (id && EVERY_ID.has(id as ChecklistId)) setFocusTarget(id as ChecklistId)
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stop = withMotion(root, {
      reduce: () => {
        motionRef.current = false
        stopFlip(flipRef)
        return undefined
      },
      full: () => {
        motionRef.current = true
        return () => {
          motionRef.current = false
        }
      },
    })
    return () => {
      stop()
      stopFlip(flipRef)
    }
  }, [])

  // The tile is already turned when this runs: swing the face now showing in
  // from edge-on. Its back face stays hidden, so only one face ever shows.
  useLayoutEffect(() => {
    if (turn === null) return
    stopFlip(flipRef)
    if (!motionRef.current) return
    const face = rootRef.current?.querySelector(
      `[data-item="${turn.id}"] [data-face][data-active="true"]`,
    )
    if (!face) return
    flipRef.current = gsap.fromTo(
      face,
      { rotateY: -90, transformPerspective: 800 },
      { rotateY: 0, duration: 0.3, ease: "power2.out", clearProps: "transform" },
    )
  }, [turn])

  useLayoutEffect(() => {
    if (focusTarget === null) return
    rootRef.current?.querySelector<HTMLElement>(`[data-toggle="${focusTarget}"]`)?.focus()
    setFocusTarget(null)
  }, [focusTarget])

  function toggle(item: ChecklistItem) {
    const next = new Set(open)
    const nowOpen = !next.has(item.id)
    if (nowOpen) next.add(item.id)
    else next.delete(item.id)
    // Safari doesn't focus a clicked button: WebKit moves focus on mousedown
    // to the nearest focusable ancestor (<main tabindex="-1"> or <body>).
    // Focus may also sit on a docs link this turn hides. Give it to the button.
    const root = rootRef.current
    const focused = document.activeElement
    const stranded =
      root !== null &&
      (focused === null ||
        focused.contains(root) ||
        (root.contains(focused) && !focused.matches("[data-toggle]")))
    setOpen(next)
    setTurn((previous) => ({ id: item.id, count: (previous?.count ?? 0) + 1 }))
    setAnnouncement(describeToggle(item, nowOpen, next.size))
    if (stranded) setFocusTarget(item.id)
  }

  return (
    <div ref={rootRef} className={styles.checklist}>
      <p className={styles.counter}>
        <span data-counter="">
          {open.size} of {checklist.length} opened
        </span>
        <span className={styles.handled} data-done={done} aria-hidden={done ? undefined : true}>
          <span className={styles.dot} aria-hidden="true" />
          Handled.
        </span>
      </p>
      <ol className={styles.grid}>
        {checklist.map((item, index) => {
          const on = open.has(item.id)
          return (
            <li key={item.id} className={styles.tile} data-item={item.id} data-open={on}>
              <button
                type="button"
                className={styles.toggle}
                data-toggle={item.id}
                aria-pressed={on}
                onClick={() => toggle(item)}
              >
                <span className={styles.number} aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>{item.title}</span>
              </button>
              <div className={styles.faces}>
                <p
                  className={styles.face}
                  data-face="chore"
                  data-active={!on}
                  aria-hidden={on ? true : undefined}
                  inert={on ? true : undefined}
                >
                  {item.chore}
                </p>
                <div
                  className={styles.face}
                  data-face="handled"
                  data-active={on}
                  aria-hidden={on ? undefined : true}
                  inert={on ? undefined : true}
                >
                  <p className={styles.answer}>{item.handledBy}</p>
                  {item.file && <p className={styles.file}>{item.file}</p>}
                  <pre className={styles.code}>
                    <code>{item.code}</code>
                  </pre>
                  <a href={item.docsHref}>{item.docsLabel} →</a>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
```

- [ ] **Step 4: The shell and the styles**

Create `apps/web/app/components/homepage/checklist/LastMile.tsx`:

```tsx
import { Eyebrow } from "../../ui/Eyebrow"
import styles from "./checklist.module.css"
import { ProductionChecklist } from "./ProductionChecklist"

/**
 * "The last mile": the production checklist. The island is the whole demo;
 * the server renders every tile turned over, so each answer is in the page.
 */
export function LastMile() {
  return (
    <section id="last-mile" className={styles.section} aria-labelledby="last-mile-title">
      <div className={styles.intro}>
        <Eyebrow className={styles.eyebrow}>The last mile</Eyebrow>
        <h2 id="last-mile-title">The parts you'd write next are already here.</h2>
        <p>
          Twelve things an agent needs before real users reach it. Turn a tile over to see the file,
          config or command that handles it.
        </p>
      </div>
      <ProductionChecklist />
    </section>
  )
}
```

Create `apps/web/app/components/homepage/checklist/checklist.module.css`:

```css
/* "The last mile" (#last-mile). Paper Relay tokens only (tokens.css). */
.section {
  padding: 56px 0;
  border-bottom: 1px solid var(--color-rule);
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

.checklist {
  container-type: inline-size;
}

/* The count is text. "Handled." keeps its space while hidden, so it never
   moves anything when it appears. */
.counter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 16px;
  margin: 0 0 16px;
  font:
    13px / 1.6 var(--font-mono),
    monospace;
  color: var(--color-ink);
}
.handled {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--color-relay-ink);
}
.handled:not([data-done="true"]) {
  visibility: hidden;
}
/* The Relay marker: decorative, a fill, never text. */
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--color-relay);
}

/* 2 columns on phones, 3 on tablets, 4 × 3 on desktop. */
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
@container (min-width: 560px) {
  .grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@container (min-width: 880px) {
  .grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.tile {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--color-rule-strong);
  background: var(--color-page);
}
.tile[data-open="true"] {
  border-color: var(--color-ink);
  background: var(--color-relay-tint);
}
.toggle {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 12px;
  border: 0;
  border-bottom: 1px solid var(--color-rule);
  background: transparent;
  font:
    500 14px / 1.35 var(--font-sans),
    sans-serif;
  color: var(--color-ink);
  text-align: left;
  cursor: pointer;
}
.number {
  font:
    12px / 1.35 var(--font-mono),
    monospace;
  color: var(--color-ink-muted);
}

/* Both faces share one grid cell: the taller sets the tile's height, so a
   turn never moves the page. Only the active face is visible, and the other
   is aria-hidden and inert as well. */
.faces {
  display: grid;
  flex: 1;
  perspective: 800px;
}
.face {
  grid-area: 1 / 1;
  min-width: 0;
  margin: 0;
  padding: 12px;
  backface-visibility: hidden;
}
.face:not([data-active="true"]) {
  visibility: hidden;
}
p.face {
  font-size: 14px;
  line-height: 1.55;
  color: var(--color-ink-muted);
}
.answer {
  margin: 0 0 8px;
  font-size: 14px;
  line-height: 1.55;
  color: var(--color-ink);
}
.file {
  margin: 0 0 4px;
  font:
    12px / 1.5 var(--font-mono),
    monospace;
  color: var(--color-ink-muted);
  overflow-wrap: anywhere;
}
.code {
  margin: 0 0 4px;
  font:
    12px / 1.55 var(--font-mono),
    monospace;
  color: var(--color-relay-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.code code {
  font: inherit;
}
.face a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  font-size: 14px;
  text-underline-offset: 5px;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/checklist app/styles/design-system.test.ts`
Expected: PASS (19 tests in `checklist/`, and the design-system guard).

- [ ] **Step 6: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/checklist/ProductionChecklist.tsx apps/web/app/components/homepage/checklist/LastMile.tsx apps/web/app/components/homepage/checklist/checklist.module.css apps/web/app/components/homepage/checklist/ProductionChecklist.test.tsx
git commit -m "feat(web): the production checklist tiles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Both sections join the page

**Files:**
- Modify: `DeveloperHome.tsx`
- Test: `homepage.test.tsx`

- [ ] **Step 1: Update the page test first**

In `apps/web/app/components/homepage/homepage.test.tsx`, replace the first test, `it("opens with the install command, then the folder tour, the guardrails and the route shapes", …)`, with:

```tsx
it("opens with the install command, then the tour, guardrails, route shapes, shipping and the checklist", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const hero = container.querySelector('[aria-labelledby="home-title"]')
  expect(hero?.textContent).toContain("npm create b4-app@latest my-agent")
  expect(hero?.querySelector('a[href="/docs/getting-started"]')?.textContent).toBe("Get started →")
  const first = container.querySelector("#first-agent")
  expect(first?.textContent).toContain("src/app/hello/index.ts")
  expect(first?.textContent).toContain("src/app/hello/tools/greet.ts")
  expect(container.querySelector("#guardrails h2")?.textContent).toBe(
    "Four checks decide what a call can do.",
  )
  expect(container.querySelector("#route-shapes h2")?.textContent).toBe("Pick the shape per route.")
  expect(container.querySelector("#test-and-ship h2")?.textContent).toBe(
    "Test it offline, then pick where it runs.",
  )
  expect(container.querySelector("#last-mile h2")?.textContent).toBe(
    "The parts you'd write next are already here.",
  )
  const order = [
    "home-title",
    "first-agent",
    "guardrails",
    "route-shapes",
    "test-and-ship",
    "last-mile",
    "run-title",
  ].map((id) => [...container.querySelectorAll("[id]")].findIndex((node) => node.id === id))
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/homepage.test.tsx`
Expected: FAIL in that test only: `#test-and-ship h2` is `undefined`.

- [ ] **Step 3: Render both sections**

Replace `apps/web/app/components/homepage/DeveloperHome.tsx` with:

```tsx
import { CopyCommand } from "../ui/CopyCommand"
import { Eyebrow } from "../ui/Eyebrow"
import { LastMile } from "./checklist/LastMile"
import { Guardrails } from "./gates/Guardrails"
import { prepareGates } from "./gates/prepare"
import styles from "./homepage.module.css"
import { ScaffoldTerminal } from "./ScaffoldTerminal"
import { scaffoldTree } from "./scaffold-tree"
import { prepareRouteShapes } from "./shapes/prepare"
import { RouteShapes } from "./shapes/RouteShapes"
import { prepareDeployTargets } from "./ship/prepare"
import { TestAndShip } from "./ship/TestAndShip"
import { FolderTour } from "./tour/FolderTour"
import { prepareFolderTour } from "./tour/prepare"

const createCommand = scaffoldTree.command

export async function DeveloperHome() {
  const [tour, gates, shapes, targets] = await Promise.all([
    prepareFolderTour(),
    prepareGates(),
    prepareRouteShapes(),
    prepareDeployTargets(),
  ])
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
        <Guardrails {...gates} />
        <RouteShapes code={shapes} />
        <TestAndShip code={targets} />
        <LastMile />
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

- [ ] **Step 4: Run the page tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/homepage.test.tsx app/seo/seo.test.ts app/site-chrome.test.tsx`
Expected: PASS. The em-dash check, the unique-region check, the SEO snippet terms and the olive pin all still hold.

- [ ] **Step 5: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/DeveloperHome.tsx apps/web/app/components/homepage/homepage.test.tsx
git commit -m "feat(web): test and ship, and the last mile, follow the route shapes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Gates

**Files:** none new.

- [ ] **Step 1: Lint**

Run: `pnpm --dir apps/web lint`
Expected: exit 0 with no warnings. If Biome reports formatting, apply the scoped fix from "Rules" to `app/components/homepage/ship app/components/homepage/checklist app/components/homepage/DeveloperHome.tsx app/components/homepage/homepage.test.tsx scripts/export-homepage-demos.mjs` only.

- [ ] **Step 2: Typecheck**

Run: `pnpm --dir apps/web typecheck`
Expected: exit 0.

- [ ] **Step 3: The full web suite**

Run: `pnpm --dir apps/web test`
Expected: every file passes: 64 files and 960 tests passed, with 1 skipped, when this plan was verified. Don't pipe it through `tail`, because that hides the exit code.

- [ ] **Step 4: The docs check and the build-cache check**

Run: `node scripts/check-docs.mjs`
Expected: `Docs completeness check passed.` It scans `apps/web/app`, fixtures and recordings included, for banned phrases.

Run: `pnpm check:build-cache`
Expected: `Build cache config check passed (…)`. `apps/web` now also depends on `@b4run/postgres-storage`.

- [ ] **Step 5: Commit any lint fixes**

```bash
git status --short
git add apps/web/app/components/homepage/ship apps/web/app/components/homepage/checklist apps/web/app/components/homepage/DeveloperHome.tsx apps/web/app/components/homepage/homepage.test.tsx apps/web/scripts/export-homepage-demos.mjs
git commit -m "style(web): format the ship and checklist sections

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Skip this commit if nothing changed.

---

### Task 8: Browser, motion and accessibility verification, then lastmod

**Files:**
- Create (scratchpad only, not committed): `<scratchpad>/verify-pr3.mjs`
- Modify: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: Start the dev server**

Run in the background: `pnpm --dir apps/web dev --port 3219`. Wait for `http://localhost:3219/` to return 200.

- [ ] **Step 2: Find the tools**

- **Playwright:** the repo's `node_modules/.pnpm/playwright-core@1.62.1`. It needs Chromium revision 1234 and WebKit revision 2336 in `~/Library/Caches/ms-playwright`; if either is missing, run `pnpm --dir apps/web exec playwright install chromium webkit`.
- **axe:** `find ~/repos -maxdepth 6 -name axe.min.js -path '*axe-core*' 2>/dev/null | head -1`. When this plan was verified, that was `/Users/blove/repos/liveloveapp/node_modules/axe-core/axe.min.js`.

- [ ] **Step 3: Write the verification script**

Create `<scratchpad>/verify-pr3.mjs`. It relies on `data-*` hooks and `input[value]`, because CSS-module class names are hashed. Change the import path to your checkout's root.

The Chromium pass checks, at 375, 768, 1024 and 1440 px with motion on and reduced:
- no horizontal scroll, and the smallest visible target in both sections
- lines still fading 100ms after **Replay npm test** with motion on, and none under reduced motion
- no layout shift of `#last-mile` or the takeaway across a replay (mid-stream and after), every target, and four tiles
- keyboard only: Enter on **Replay b4 eval**; arrows through the targets; Enter on a tile, Tab to its docs link, Tab to the next tile, Space
- rapid: **Replay npm test**, **Replay b4 eval**, **Skip** with no delay; then three tiles with no delay
- all twelve open: the counter and "Handled."
- axe, and screenshots

The WebKit pass checks focus after a label click, a replay click, a tile click and a tile closed from its own docs link, and arrow, Space and Enter by keyboard.

```js
import { readFileSync } from "node:fs"
import {
  chromium,
  webkit,
} from "/Users/blove/repos/dawn/.claude/worktrees/agent-ac67a10b4ccd02c90/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs"

const [AXE, OUT, BASE = "http://localhost:3219"] = process.argv.slice(2)

/** Tops of the sections after each demo: none may move when a demo changes. */
const layout = (page) =>
  page.evaluate(() => {
    const top = (selector) =>
      Math.round(document.querySelector(selector).getBoundingClientRect().top + scrollY)
    return { lastMile: top("#last-mile"), takeaway: top('[aria-labelledby="run-title"]') }
  })

const said = (page) => page.evaluate(() => window.__said)
const leftovers = (page, selector) =>
  page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].filter(
        (node) => node.style.opacity !== "" || node.style.transform !== "",
      ).length,
    selector,
  )
const focused = (page) =>
  page.evaluate(() => {
    const node = document.activeElement
    return (
      node?.getAttribute("data-toggle") ??
      node?.getAttribute("data-replay") ??
      node?.getAttribute("data-action") ??
      node?.getAttribute("value") ??
      node?.textContent?.trim().slice(0, 30) ??
      node?.tagName
    )
  })

async function chromiumPass(browser) {
  const results = []
  for (const [width, height] of [
    [375, 812],
    [768, 1024],
    [1024, 768],
    [1440, 900],
  ]) {
    for (const reducedMotion of ["no-preference", "reduce"]) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion })
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" })
      await page.locator("#test-and-ship").scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      const facts = await page.evaluate(() => {
        const targets = [
          ...document.querySelectorAll(
            "#test-and-ship button, #test-and-ship label, #test-and-ship a, #last-mile button, #last-mile a",
          ),
        ]
          .filter(
            (node) =>
              node.getClientRects().length > 0 &&
              getComputedStyle(node).visibility === "visible" &&
              !node.closest("[inert]"),
          )
          .map((node) => node.getBoundingClientRect())
          .filter((rect) => rect.width > 0)
        return {
          horizontalScroll: document.documentElement.scrollWidth > innerWidth,
          smallestTarget: Math.round(
            Math.min(...targets.map((rect) => Math.min(rect.width, rect.height))),
          ),
          counter: document.querySelector("#last-mile [data-counter]")?.textContent,
        }
      })

      // Layout shift: replays, every target and every tile leave the page below still.
      const before = await layout(page)
      const shifts = []
      const record = async () => {
        const now = await layout(page)
        shifts.push(now.lastMile - before.lastMile, now.takeaway - before.takeaway)
      }
      await page.locator('#test-and-ship [data-replay="test"]').click()
      await page.waitForTimeout(100)
      facts.streamingLines = await page.evaluate(
        () =>
          [...document.querySelectorAll('#test-and-ship [data-run="test"] [data-replay-line]')].filter(
            (node) => Number(getComputedStyle(node).opacity) < 1,
          ).length,
      )
      await record()
      await page.waitForTimeout(1200)
      await record()
      for (const id of ["langsmith", "hono", "vercel", "kubernetes", "node"]) {
        await page.locator(`#test-and-ship input[value="${id}"]`).check()
        await page.waitForTimeout(50)
        await record()
      }
      await page.locator("#last-mile").scrollIntoViewIfNeeded()
      for (const id of ["schemas", "streaming", "sandbox", "inspect"]) {
        await page.locator(`#last-mile [data-toggle="${id}"]`).click()
        await page.waitForTimeout(50)
        await record()
      }
      facts.maxShift = Math.max(...shifts.map(Math.abs))
      await page.waitForTimeout(500)

      // Keyboard only: the replay, the targets and a tile.
      await page.locator('#test-and-ship [data-replay="eval"]').focus()
      await page.keyboard.press("Enter")
      await page.waitForTimeout(50)
      facts.replayKeyboard = await page.evaluate(
        () => document.querySelector('#test-and-ship [aria-live="polite"]')?.textContent,
      )
      await page.locator('#test-and-ship input[value="node"]').focus()
      await page.keyboard.press("ArrowRight")
      await page.keyboard.press("ArrowRight")
      await page.waitForTimeout(300)
      facts.targetsKeyboard = await page.evaluate(() => ({
        focused: document.activeElement?.getAttribute("value"),
        visible: document
          .querySelector('#test-and-ship [data-target][data-active="true"]')
          ?.getAttribute("data-target"),
        live: [...document.querySelectorAll('#test-and-ship [aria-live="polite"]')].at(-1)
          ?.textContent,
      }))
      await page.locator('#last-mile [data-toggle="auth"]').focus()
      await page.keyboard.press("Enter")
      await page.waitForTimeout(50)
      const opened = await page.evaluate(() => ({
        pressed: document.querySelector('#last-mile [data-toggle="auth"]').getAttribute("aria-pressed"),
        live: document.querySelector('#last-mile [aria-live="polite"]').textContent,
      }))
      await page.keyboard.press("Tab")
      const tabbedTo = await page.evaluate(() => document.activeElement?.getAttribute("href"))
      await page.keyboard.press("Tab")
      const next = await focused(page)
      await page.keyboard.press("Space")
      await page.waitForTimeout(50)
      facts.tileKeyboard = {
        opened,
        tabbedTo,
        next,
        nextPressed: await page.evaluate(
          () => document.activeElement?.getAttribute("aria-pressed"),
        ),
      }

      // Rapid: replay, replay, skip; then three tiles in a row.
      await page.waitForTimeout(1500)
      await page.evaluate(() => {
        const live = document.querySelector('#test-and-ship [aria-live="polite"]')
        window.__said = []
        new MutationObserver(() => window.__said.push(live.textContent)).observe(live, {
          childList: true,
          characterData: true,
          subtree: true,
        })
      })
      await page.locator('#test-and-ship [data-replay="test"]').click({ delay: 0 })
      await page.locator('#test-and-ship [data-replay="eval"]').click({ delay: 0 })
      await page.locator('#test-and-ship [data-action="skip"]').click({ delay: 0 })
      const replaySaid = await said(page)
      await page.waitForTimeout(1500)
      facts.rapidReplay = {
        said: replaySaid,
        leftovers: await leftovers(page, "#test-and-ship [data-replay-line]"),
      }
      await page.evaluate(() => {
        const live = document.querySelector('#last-mile [aria-live="polite"]')
        window.__said = []
        new MutationObserver(() => window.__said.push(live.textContent)).observe(live, {
          childList: true,
          characterData: true,
          subtree: true,
        })
      })
      for (const id of ["memory", "retries", "persistence"]) {
        await page.locator(`#last-mile [data-toggle="${id}"]`).click({ delay: 0 })
      }
      const tileSaid = await said(page)
      await page.waitForTimeout(800)
      facts.rapidTiles = {
        said: tileSaid,
        counter: await page.evaluate(() => document.querySelector("#last-mile [data-counter]").textContent),
        leftovers: await leftovers(page, "#last-mile [data-face]"),
      }
      // Open the rest: Handled. shows.
      for (const id of await page.evaluate(() =>
        [...document.querySelectorAll('#last-mile [data-toggle][aria-pressed="false"]')].map((node) =>
          node.getAttribute("data-toggle"),
        ),
      )) {
        await page.locator(`#last-mile [data-toggle="${id}"]`).click()
      }
      await page.waitForTimeout(500)
      facts.allOpen = await page.evaluate(() => ({
        counter: document.querySelector("#last-mile [data-counter]").textContent,
        handledVisible: getComputedStyle(document.querySelector("#last-mile [data-done]")).visibility,
        live: document.querySelector('#last-mile [aria-live="polite"]').textContent,
      }))

      await page.locator('#test-and-ship input[value="kubernetes"]').check()
      await page.waitForTimeout(400)
      await page.locator("#test-and-ship").screenshot({ path: `${OUT}/ship-${width}-${reducedMotion}.png` })
      await page.locator("#last-mile").screenshot({ path: `${OUT}/mile-${width}-${reducedMotion}.png` })
      await page.addScriptTag({ content: readFileSync(AXE, "utf8") })
      facts.axe = await page.evaluate(async () => {
        const report = await window.axe.run(document, { resultTypes: ["violations"] })
        return report.violations.map((violation) => `${violation.id} (${violation.nodes.length})`)
      })
      results.push({ browser: "chromium", width, height, reducedMotion, ...facts })
      await page.close()
    }
  }
  return results
}

async function webkitPass(browser) {
  const results = []
  for (const [width, height] of [
    [375, 812],
    [1024, 768],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" })
    await page.locator("#test-and-ship").scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    const facts = {}
    // Pointer: a label click, a replay button, a tile button.
    await page.locator("#test-and-ship label", { hasText: "vercel" }).click()
    await page.waitForTimeout(100)
    facts.labelClick = await focused(page)
    await page.locator('#test-and-ship [data-replay="test"]').click()
    facts.replayClick = await focused(page)
    await page.locator("#last-mile").scrollIntoViewIfNeeded()
    await page.locator('#last-mile [data-toggle="schemas"]').click()
    await page.waitForTimeout(100)
    facts.tileClick = await focused(page)
    // A tile closed while its docs link has focus.
    await page.locator('#last-mile [data-item="schemas"] a').focus()
    await page.locator('#last-mile [data-toggle="schemas"]').click()
    await page.waitForTimeout(100)
    facts.closeFromLink = await focused(page)
    // Keyboard only.
    await page.locator('#test-and-ship input[value="node"]').focus()
    await page.keyboard.press("ArrowRight")
    await page.waitForTimeout(100)
    facts.arrow = await focused(page)
    await page.locator('#last-mile [data-toggle="auth"]').focus()
    await page.keyboard.press("Space")
    await page.waitForTimeout(100)
    facts.space = await page.evaluate(() => ({
      focus: document.activeElement?.getAttribute("data-toggle"),
      pressed: document.activeElement?.getAttribute("aria-pressed"),
    }))
    await page.keyboard.press("Enter")
    await page.waitForTimeout(100)
    facts.enter = await page.evaluate(() => ({
      focus: document.activeElement?.getAttribute("data-toggle"),
      pressed: document.activeElement?.getAttribute("aria-pressed"),
    }))
    facts.inertFocus = await page.evaluate(() => Boolean(document.activeElement?.closest("[inert]")))
    results.push({ browser: "webkit", width, height, ...facts })
    await page.close()
  }
  return results
}

const chrome = await chromium.launch()
const chromeResults = await chromiumPass(chrome)
await chrome.close()
const safari = await webkit.launch()
const safariResults = await webkitPass(safari)
await safari.close()
console.log(JSON.stringify([...chromeResults, ...safariResults], null, 2))
```

- [ ] **Step 4: Run it and check every fact**

```bash
mkdir -p <scratchpad>/shots
node <scratchpad>/verify-pr3.mjs "<axe path>" <scratchpad>/shots > <scratchpad>/verify.json
node -e 'for (const x of require(process.argv[1])) console.log(JSON.stringify(x))' <scratchpad>/verify.json
```

Expected on **all 8 Chromium rows** (this is what the verification run printed):

| Fact | Expected |
|---|---|
| `horizontalScroll` | `false` |
| `smallestTarget` | `44` |
| `counter` (after load) | `"0 of 12 opened"` |
| `streamingLines` | `7` with motion on (the stream is running), `0` reduced |
| `maxShift` | `0` |
| `replayKeyboard` | `"Replayed npx b4 eval. PASS greets by name mean=1.00."` |
| `targetsKeyboard` | `focused: "hono"`, `visible: "hono"`, `live` = `Deploy target hono. A Hono app over the web-standard runtime. It serves the edge subset of B4. b4 build writes .b4/build/modules.edge.mjs, .b4/build/stores.mjs, .b4/build/app.mjs, wrangler.toml.` |
| `tileKeyboard` | `opened.pressed: "true"`, `opened.live` = `Auth: One middleware file runs before every route request. 5 of 12 opened.`; `tabbedTo: "/docs/middleware#file-location"`; `next: "thread-access"`; `nextPressed: "true"` |
| `rapidReplay` | `said` is exactly two entries (the npm test and b4 eval messages; Skip says nothing); `leftovers: 0` |
| `rapidTiles` | `said` is exactly three entries (Memory 7, Model retries 8, Persistence 9 of 12); `counter: "9 of 12 opened"`; `leftovers: 0` |
| `allOpen` | `counter: "12 of 12 opened"`, `handledVisible: "visible"`, `live` ends `12 of 12 opened. Handled.` |
| `axe` | `[]` |

Expected on **both WebKit rows**: `labelClick: "vercel"`, `replayClick: "test"`, `tileClick: "schemas"`, `closeFromLink: "schemas"`, `arrow: "langsmith"`, `space: { focus: "auth", pressed: "true" }`, `enter: { focus: "auth", pressed: "false" }`, `inertFocus: false`.

- [ ] **Step 5: Look at the screenshots**

Open each `ship-*.png` and `mile-*.png` with the Read tool, and check:

- **Test and ship at 1024 and 1440:** two columns. The replay terminal's lines start flush with the `$` prompt (no indent from `ui.css`); the Kubernetes panel shows the node config, the recorded node build, then `docker build` and the four-line `helm install`.
- **At 375 and 768:** one column; the replay buttons and the five target cells wrap without horizontal scroll.
- **The last mile at 1440:** a 4 × 3 grid, all tiles turned over (the script opened all twelve), "12 of 12 opened" with the Relay dot and "Handled.". **At 768:** 3 columns. **At 375:** 2 columns; long excerpt lines wrap inside the tile.
- **Ignore** the sticky site header over the section top in element screenshots, and the Next dev indicator.

Fix anything that fails, rerun Task 7, and commit the fixes with a message naming the defect.

- [ ] **Step 6: Stop the dev server and clean up what it wrote**

Stop the server you started. Run `git status --short`. Delete `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` if they appear. If `apps/web/next-env.d.ts` is modified, run `git checkout apps/web/next-env.d.ts`.

- [ ] **Step 7: Regenerate lastmod, keeping only the `/` entry**

All content is committed, so the generator dates `/` by the newest commit touching the homepage sources. Splice in only `/`:

```bash
git show HEAD:apps/web/app/seo/lastmod.generated.json > <scratchpad>/lastmod-head.json
pnpm --dir apps/web seo:lastmod
node -e '
const fs = require("node:fs")
const file = "apps/web/app/seo/lastmod.generated.json"
const fresh = JSON.parse(fs.readFileSync(file, "utf8"))
const head = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
head.routes["/"] = fresh.routes["/"]
fs.writeFileSync(file, JSON.stringify(head, null, 2) + "\n")
' <scratchpad>/lastmod-head.json
git diff --stat apps/web/app/seo/lastmod.generated.json
```

Expected: `1 file changed, 3 insertions(+), 3 deletions(-)`: the `/` entry's `lastModified`, `sourceDigest` and `recordDigest`. Nothing else.

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/seo`
Expected: PASS, including "covers every route the site renders".

```bash
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate lastmod for test and ship, and the last mile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Final full check**

Run: `pnpm --dir apps/web test && pnpm --dir apps/web typecheck && pnpm --dir apps/web lint && node scripts/check-docs.mjs && pnpm check:build-cache`
Expected: exit 0 for all five. Don't add `seo:lastmod:check` (Risk 7).

---

## Spec coverage checklist (PR 3)

| Spec requirement | Where |
|---|---|
| Section `#test-and-ship`, two columns on desktop, stacked on phones | Task 3 (`ship.module.css` container query); Task 8 screenshots |
| `▶ npm test` and `▶ b4 eval` stream recorded lines about 80ms apart; Skip or reduced motion shows everything; panel at final height up front | Task 3 (`TestReplay`, stagger 0.08, every line always in the DOM); Task 8 `streamingLines`, `maxShift` |
| `--record-tests` scaffolds `app-basic` in a temp dir, runs both, strips ANSI, timings and paths, writes `ship/test-replay.json` | Task 2 (recorder, `normalizeTranscript` unit test, no-key and no-path assertions); the test command is `npm test -- --reporter=verbose` (Risk 1) |
| Shape test: passing lines, "greets by name", eval `PASS <name> › <case> mean=…` in the reporter's format, no `OPENAI_API_KEY` | Task 2 (`ship.test.ts`, pinned to the template and to `eval.ts`'s format strings); Task 3 (`recordingEnv` drops the key) |
| Deploy targets `node · langsmith · hono · vercel` plus `kubernetes` (Node build + `b4-app` chart) | Tasks 2 and 3 (radios, see Deviations; Kubernetes commands pinned to the docs; chart name pinned) |
| Each shows the `build.targets` line, the command, and what it emits | Task 2 (real `b4 build` per target, recorded; configs pinned to typechecked fixtures); Task 3 panels |
| Defaults are node and langsmith; `build.targets` replaces them; the copy says so | Task 2 (recorded default and single-target builds; docs sentence pinned); Task 3 column note |
| Every target name against `BUILD_TARGET_NAMES`, every docs anchor | Task 2 |
| Section `#last-mile`, heading "The parts you'd write next are already here." | Tasks 5 and 6 |
| 12 tiles, 4 × 3 desktop, 2 × 6 phones, each a `<button aria-pressed>` | Task 5 (toggle button per tile; 3 columns on tablets, see Deviations) |
| 300ms `rotateY` flip, cross-fade or instant under reduced motion | Task 5 (`rotateY` from -90 with `backface-visibility`; reduced = instant swap) |
| "N of 12 opened"; one Relay dot beside "Handled." at twelve | Task 5 (text counter, announced; decorative dot) |
| Items with snippet and `docsHref`; every "handled by" claim true | Task 4 (excerpts pinned line for line; handlers run; CLI registry; corrections in "Spec assumptions") |
| Every `docsHref` route and anchor exists | Tasks 2 and 4 (`DOCS_INDEX`) |
| Honesty: outputs recorded from real runs; snippets typechecked; links anchored | Tasks 2 and 4; Task 7 typecheck |
| Accessibility: native controls, global focus ring, polite live region, colour not the only signal, 44px targets, contrast | Tasks 3 and 5 tests; Task 4 contrast test; Task 8 (`smallestTarget`, axe, WebKit focus) |
| Content visible without JS; gsap only in islands via `motion/gsap.ts` | SSR tests (no inline `style`; every answer turned over); all three islands import `../motion/gsap` |
| Motion: only transform and opacity; reduced motion starts no tweens; next action kills and clears | Tasks 3 and 5 tests; Task 8 `leftovers` |
| Design-system guard; server shells with leaf islands | Tasks 3 and 5 Step "run the tests"; Task 7 |
| Playwright + axe at 375/768/1024/1440, motion on and reduced | Task 8 (plus WebKit) |
| lastmod: commit only `/` | Task 8 Step 7 |
