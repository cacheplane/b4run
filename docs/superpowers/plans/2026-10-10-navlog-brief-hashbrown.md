# Navlog Brief as Structured UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The navlog agent answers with JSON matching a hashbrown UI-kit schema, and the web client renders it as brief components (BottomLine, RouteSummary, WatchFor, KeyNumbers, Assumptions, Citations, Prose) in the chat and the sheet's Brief tab.

**Architecture:** PR 1 adds `responseSchema` to `B4HttpAgent` so a CopilotKit runtime route can put `hashbrown: { ui: true, responseSchema }` on every run body (B4's server already binds it). PR 2 defines the kit once in `app/brief/` (hashbrown `s` schemas + React components), derives the JSON schema with `@hashbrownai/core`'s `createUiJsonSchema` for the server route, renders answers with `useUiKit` + `useJsonParser` in a custom markdown renderer for the chat and in the Brief tab, updates the agent prompt, the quality eval and one harness fixture.

**Tech Stack:** `@ag-ui/client` 1.0.1 `HttpAgent`, `@hashbrownai/core` + `@hashbrownai/react` 0.7.0 (`s`, `exposeComponent`, `useUiKit`, `useJsonParser`, `createUiJsonSchema`), CopilotKit v2 `CopilotChatAssistantMessage`, Vitest, `b4 eval`.

**Spec:** `docs/superpowers/specs/2026-10-10-navlog-brief-hashbrown-design.md`.

---

## Before you start

- Repo root `/Users/blove/repos/dawn/.claude/worktrees/b4-release-029b2a`. PR 1 branch: `blove/b4httpagent-response-schema` from `origin/main`. PR 2 branch: `blove/navlog-brief-hashbrown` (holds the spec and this plan; rebase/merge `main` after PR 1 lands — use `git merge origin/main`, never rebase in the shared worktree).
- Shared worktree: never `git checkout/switch/stash/reset/rebase/commit --amend` from a subagent (the controller switches branches); stage by explicit path; never bare `biome check --write` (navlog: `pnpm --filter @b4-example/navlog-web lint`; packages: `pnpm --filter <pkg> lint`). Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `exactOptionalPropertyTypes` on. Changesets: one fixed group, use `patch` (never `minor` on 0.x).
- Every `examples/navlog/web/app` file has a byte-identical twin in `packages/devkit/templates/app-navlog/web/app` (tests `.template`); every `examples/navlog/server/src` file likewise under `packages/devkit/templates/app-navlog/server/src`. Mirror at the end of PR 2.
- hashbrown 0.7.0 facts (verified from the npm tarballs): `@hashbrownai/core` exports `s` (schema builder), `createUiJsonSchema({ components, examples? })` (the exact JSON schema a UI kit sends, no React needed); `@hashbrownai/react` exports `exposeComponent(Component, { name, description, props })`, `useUiKit({ components })` (`.schema`, `.render(value)`), `useJsonParser(json, schema)` (`{ value, error, parserState }`), peer `react >=18 <20`. Read `node_modules/@hashbrownai/*/` after install for exact signatures before writing code; adjust names to what is exported.

---

# PR 1 — `B4HttpAgent({ responseSchema })`

### Task 1: The option and its tests

**Files:** `packages/ag-ui/src/client.ts`, its test (find with `git grep -l "B4HttpAgent" -- packages/ag-ui/test`; add a new `packages/ag-ui/test/client-response-schema.test.ts` if none fits).

- [ ] **Step 1: Failing tests.**

```ts
import type { RunAgentInput } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import { B4HttpAgent } from "../src/client.js"

const input: RunAgentInput = {
  threadId: "t1",
  runId: "r1",
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
}
const schema = { type: "object", properties: { ui: { type: "array" } }, required: ["ui"], additionalProperties: false }

class Probe extends B4HttpAgent {
  body(): Record<string, unknown> {
    return JSON.parse(String(this.requestInit(input).body)) as Record<string, unknown>
  }
}

describe("B4HttpAgent responseSchema", () => {
  test("without it, the run body is the plain AG-UI input", () => {
    const body = new Probe({ url: "http://b4.test/agui/x" }).body()
    expect(body).not.toHaveProperty("hashbrown")
    expect(body.threadId).toBe("t1")
  })
  test("with it, every run body carries hashbrown: { ui: true, responseSchema }", () => {
    const body = new Probe({ url: "http://b4.test/agui/x", responseSchema: schema }).body()
    expect(body.hashbrown).toEqual({ ui: true, responseSchema: schema })
    expect(body.threadId).toBe("t1")
  })
  test("a clone keeps the schema", () => {
    const agent = new Probe({ url: "http://b4.test/agui/x", responseSchema: schema })
    const clone = agent.clone() as Probe
    expect(clone.body().hashbrown).toEqual({ ui: true, responseSchema: schema })
  })
})
```

  Add a conformance test that the body is accepted by the server's reader — `readResponseFormat` lives in `packages/cli/src/lib/dev/response-schema.ts`; if importing `@b4run/cli` internals from `packages/ag-ui` is not allowed by the package graph, put this conformance test in `packages/cli/test/` instead (construct a `B4HttpAgent`, take its body, and assert `readResponseFormat(body)` is `{ ok: true, responseFormat: { type: "json_schema", name: "hashbrown_response", schema } }`).

- [ ] **Step 2:** Run → FAIL (unknown option / no `hashbrown`).

- [ ] **Step 3: Implement** in `packages/ag-ui/src/client.ts`:

```ts
import type { RunAgentInput } from "@ag-ui/core"
import { HttpAgent, type HttpAgentConfig } from "@ag-ui/client"

export interface B4HttpAgentConfig extends HttpAgentConfig {
  /**
   * A JSON Schema the route's final assistant message must match. Sent on
   * every run as `hashbrown: { ui: true, responseSchema }`, which B4.run binds
   * on the root model as the provider's structured output (see the AG-UI
   * docs' "Response schema"). Tool-calling turns are unaffected.
   */
  readonly responseSchema?: Readonly<Record<string, unknown>>
}

export class B4HttpAgent extends HttpAgent {
  readonly responseSchema: Readonly<Record<string, unknown>> | undefined

  constructor(config: B4HttpAgentConfig) {
    super(config)
    this.responseSchema = config.responseSchema
  }

  protected override requestInit(input: RunAgentInput): RequestInit {
    const init = super.requestInit(input)
    if (this.responseSchema === undefined) return init
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    return {
      ...init,
      body: JSON.stringify({ ...body, hashbrown: { ui: true, responseSchema: this.responseSchema } }),
    }
  }

  // …existing getCapabilities unchanged…
}
```

  Check `HttpAgentConfig` is exported by `@ag-ui/client` (else declare the config from `ConstructorParameters<typeof HttpAgent>[0]`). Check how `HttpAgent.clone()` builds the copy (read `node_modules/@ag-ui/client/dist/index.mjs`); if it does not call the subclass constructor with a config carrying `responseSchema`, override `clone()` to copy it. Export `B4HttpAgentConfig` from the package's client entry.

- [ ] **Step 4:** Tests → PASS. `pnpm --filter @b4run/ag-ui lint typecheck test` → green. If the package has an API report / exports test (grep `api` scripts or `exports` tests in `packages/ag-ui`), update it.

- [ ] **Step 5: Docs.** `apps/web/content/docs/ag-ui.mdx` "Response schema": add a short paragraph after the first one: a CopilotKit runtime route registers `new B4HttpAgent({ url, responseSchema })`, and every run carries the schema (with a 4-line code sample). In `apps/web/content/docs/api/ag-ui.mdx`, add `responseSchema` to the `B4HttpAgent` row/section. `node scripts/check-docs.mjs` → exit 0. Commit, then `pnpm --dir apps/web seo:lastmod` and commit the manifest (only the two docs routes may change).

- [ ] **Step 6: Changeset.** `.changeset/<name>.md`:

```md
---
"@b4run/ag-ui": patch
---

`B4HttpAgent` takes a `responseSchema`: every run then carries `hashbrown: { ui: true, responseSchema }`, so a CopilotKit runtime route can constrain a route's final answer to a JSON Schema (B4.run binds it as the provider's structured output).
```

  `node scripts/check-changesets.mjs` (if runnable locally) → pass. Commit.

- [ ] **Step 7: Ship PR 1.** Gates: `pnpm build && pnpm lint && pnpm typecheck && pnpm test --filter @b4run/ag-ui` (or the package-scoped equivalents) and `node scripts/check-docs.mjs`; push, open the PR (`ag-ui: B4HttpAgent takes a responseSchema`), auto-merge per the user's standing preference, bind it.

---

# PR 2 — the brief kit in navlog

### Task 2: Dependencies

- [ ] `pnpm --filter @b4-example/navlog-web add @hashbrownai/core@0.7.0 @hashbrownai/react@0.7.0` (exact pins, as the example pins other UI packages — match the file's existing style). Restore the dependency order if `pnpm add` re-sorts. Add the same two lines to `packages/devkit/templates/app-navlog/web/package.json.template`. Confirm the lockfile diff adds only `@hashbrownai/*` and their two `@cacheplane/partial-*` deps. Run `pnpm --filter @b4run/devkit test` (dependency guards; parity drift is expected until Task 9). Commit: `feat(navlog-web): add hashbrown`.

### Task 3: The kit definition (`app/brief/`)

**Files:** Create `examples/navlog/web/app/brief/schema.ts` (prop schemas, no React), `app/brief/components.tsx` (the seven components), `app/brief/kit.ts` (the exposed-component list + `briefJsonSchema`), and `app/brief/kit.test.ts(x)`.

- [ ] **Step 1: Failing test** (`kit.test.ts`):

```ts
import { describe, expect, test } from "vitest"
import { briefJsonSchema } from "./kit"

/** OpenAI strict mode: every object closed and fully required. */
function assertStrict(node: unknown, path = "$"): void {
  if (Array.isArray(node)) return node.forEach((n, i) => assertStrict(n, `${path}[${i}]`))
  if (node === null || typeof node !== "object") return
  const o = node as Record<string, unknown>
  if (o.type === "object" && o.properties !== undefined) {
    expect(o.additionalProperties, `${path} additionalProperties`).toBe(false)
    expect(new Set(o.required as string[]), `${path} required`).toEqual(new Set(Object.keys(o.properties as object)))
  }
  for (const [k, v] of Object.entries(o)) assertStrict(v, `${path}.${k}`)
}

describe("brief kit", () => {
  test("names all seven components", () => {
    const text = JSON.stringify(briefJsonSchema)
    for (const name of ["BottomLine", "RouteSummary", "WatchFor", "KeyNumbers", "Assumptions", "Citations", "Prose"]) {
      expect(text).toContain(name)
    }
  })
  test("is OpenAI-strict", () => {
    assertStrict(briefJsonSchema)
  })
})
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement.**
  - `schema.ts`: one `s.object(...)` prop schema per component with `s.string`/`s.number`/`s.enumeration`/`s.array`/`s.anyOf` (use whatever hashbrown's `s` names are — read `node_modules/@hashbrownai/core` types) and a description on each prop. Optional props in the spec (`when?`, `unit?`, `cite?`) are modelled as `s.anyOf([s.string(...), s.nullish()])` (or hashbrown's nullable form) so the schema stays fully `required` for strict mode. Shapes, exactly as the spec:
    - BottomLine `{ level: "GO"|"CAUTION"|"NO-GO", reason: string, cite: string[] }`
    - RouteSummary `{ from: string, to: string, via: string[], altitudeFt: number, departureUtc: string }`
    - WatchFor `{ items: { what: string, when: string|null, severity: "info"|"caution"|"danger", cite: string[] }[] }`
    - KeyNumbers `{ items: { label: string, value: string, unit: string|null, cite: string[] }[] }`
    - Assumptions `{ items: { statement: string, origin: "pilot"|"memory"|"default" }[] }`
    - Citations `{ items: { id: string, source: string, locator: string }[] }`
    - Prose `{ markdown: string }`
  - `components.tsx`: seven React components rendering those props with the workbench's classes (`wb-header-row` not needed; reuse `VerdictPill`-like level styling from `theme.css` for BottomLine, `wb-cat`/`wb-hazard` severity colours for WatchFor dots, mono tabular figures for KeyNumbers, `wb-row` rows for Assumptions, `.wb-prose` for Prose via the existing markdown renderer). Citation markers: a `<sup><a href="#cite-{id}">n</a></sup>` resolved from a `CitationsContext` (React context provided by the renderer with the answer's citation list); Citations renders `<ol>` items with `id={"cite-" + id}`. Assumptions' "Change" button calls `useBriefActions().changeAssumption(statement)` (a context the chat provides; default no-op).
  - `kit.ts`: the `exposeComponent(...)` list (name = component name, description = what it is for and when to use it, props = the schema) and `export const briefJsonSchema = createUiJsonSchema({ components })`. Keep `kit.ts` free of `"use client"` so the server route can import `briefJsonSchema`; if `exposeComponent` drags React into the server bundle, split: `createUiJsonSchema` takes the descriptor list built from `schema.ts` names/descriptions, and `components.tsx` pairs them with React components for `useUiKit`.

- [ ] **Step 4:** Tests → PASS; add one render test per component (`renderToStaticMarkup`, asserting the key text and, for WatchFor, the empty "Nothing during the flight" state and severity data attributes; for KeyNumbers mono figures; for Assumptions the origin tag and a "Change" button; for Citations the `id="cite-c1"` anchors; for Prose the markdown). Lint, typecheck. Commit: `feat(navlog-web): the planning brief kit`.

### Task 4: The server route sends the schema

**Files:** `examples/navlog/web/app/api/copilotkit/[...path]/route.ts` (+ its test).

- [ ] Construct `new B4HttpAgent({ url: agUiUrl, fetch: guardedFetch, responseSchema: briefJsonSchema })`. Test (in the route's existing test file): the agent the route registers carries `responseSchema` equal to `briefJsonSchema` (expose it the way the existing tests reach the agent, or assert on a captured `fetch` body containing `"hashbrown"`). Commit: `feat(navlog-web): every run asks for the brief kit's schema`.

### Task 5: Rendering in the chat

**Files:** Create `app/brief/BriefRenderer.tsx` (+ test); modify `app/components/NavlogChat.tsx`.

- [ ] **Step 1: Tests first** (`BriefRenderer.test.tsx`): (a) a complete JSON answer `{"ui":[{"BottomLine":{"props":{…}}}, …]}` (use the exact wrapper shape `createUiJsonSchema` defines — read it from `briefJsonSchema`) renders BottomLine's reason and the KeyNumbers figures; (b) a truncated prefix of that JSON renders the components completed so far without throwing; (c) plain markdown (`"**Filed.** Recorded the flight plan."`) renders through the markdown fallback; (d) clicking an assumption's "Change" calls the provided `changeAssumption` with the statement.
- [ ] **Step 2: Implement** `BriefRenderer({ content })`: if `content.trimStart()` starts with `{`, run `useJsonParser(content, uiKit.schema)` and render `uiKit.render(value)` inside `CitationsContext` (citations from the parsed value); otherwise render the existing markdown renderer (`CopilotChatAssistantMessage.MarkdownRenderer` with the `wb-prose` class, as NavlogChat does today — find how prose is styled now and keep it). `uiKit` comes from `useUiKit({ components })` (memoized).
- [ ] **Step 3: Wire into the chat.** In `NavlogChat.tsx`, wrap the activity kit's assistant-message slot:

```tsx
const AssistantMessage = Object.assign(function NavlogAssistantMessage(props: CopilotChatAssistantMessageProps) {
  const B4Assistant = slots.messageView.assistantMessage
  return <B4Assistant {...props} markdownRenderer={BriefRenderer} />
}, CopilotChatAssistantMessage)
```

  (module-level, not per render; confirm the prop that swaps the markdown renderer on `CopilotChatAssistantMessage` — `markdownRenderer` slot or similar — from `@copilotkit/react-core/v2` types) and pass `messageView={{ ...slots.messageView, assistantMessage: AssistantMessage, transformMessages }}`. Provide `BriefActionsContext` with `changeAssumption = (statement) => fill the composer with "Actually, " + statement` (use CopilotChat's input API or the textarea ref — find the existing way NavlogChat/DemoSuggestions set the composer text).
- [ ] **Step 4:** Tests (NavlogChat's existing tests + the new one) → PASS. Commit: `feat(navlog-web): the chat renders the brief kit`.

### Task 6: The Brief tab and the verdict

**Files:** `app/components/PlanningBrief.tsx` (or replace its use), `app/lib/assistant-text.ts` / `app/lib/verdict.ts`, tests.

- [ ] In `NavlogSheet`'s Brief panel, render `<BriefRenderer content={brief} />` (the same renderer) under the verdict card; keep `PlanningBrief` only as the fallback the renderer uses for a non-JSON answer (or fold its parsing into the fallback path).
- [ ] `resolveVerdict`: the planner's level comes from the parsed JSON's `BottomLine.level` (add `parseBriefAnswer(text)` in `app/brief/parse.ts` returning `{ bottomLine?: { level, reason } } | null` via a plain `JSON.parse` of a complete answer); fall back to `parsePlanningAnswer` for markdown answers. Tests: a JSON answer's CAUTION raises a GO weather verdict; a markdown answer still works.
- [ ] Commit: `feat(navlog-web): the Brief tab and the verdict read the structured answer`.

### Task 7: The agent prompt and the quality eval

**Files:** `examples/navlog/server/src/app/navlog/index.ts`, `examples/navlog/server/src/app/navlog/evals/navlog-quality.eval.ts` (+ its recorded fixtures).

- [ ] **Prompt:** replace the "Bottom line:/Watch for:/Numbers:/Assumptions:" answer-format instructions with: answer with the brief components; a planning answer is BottomLine, RouteSummary, WatchFor, KeyNumbers, Assumptions, Citations, then an optional Prose question; anything else is a single Prose; numbers stay plain with units (keep the existing rules about ETE, fuel incl. 1.1 gal, reserve h:mm, never tool field names); every POH figure, weather fact and hazard cites an id listed in Citations (`poh/<file>.md` + `Figure N`, `METAR <ICAO> <time>Z`, `TAF <ICAO>`, `AIRMET/SIGMET <id>`).
- [ ] **Eval:** give the eval cases `responseSchema: briefJsonSchema` — the server package must not import the web app; copy the schema into the eval as a JSON fixture `evals/brief-schema.json` generated from the web kit (add a web test that regenerates/compares it so they cannot drift: `expect(briefJsonSchema).toEqual(require("…/brief-schema.json"))`). Replace the regex assertions with JSON assertions: first component BottomLine with level ∈ {GO, CAUTION, NO-GO}; KeyNumbers labels include ETE, fuel burned, reserve; Assumptions non-empty; Citations has a `poh/` source.
- [ ] **Re-record** the eval's recorded replies against the real model (OpenAI key from `/Users/blove/repos/dawn/.env`, copied into `examples/navlog/server/.env` — gitignored — if not already): `pnpm --filter @b4-example/navlog-server exec b4 eval --record` (check the exact command in `examples/navlog/server/package.json`). Commit the regenerated fixtures and the eval. Never print the key.
- [ ] Commit: `feat(navlog): the planner answers with the brief kit; the quality eval checks the structure`.

### Task 8: Harness fixture and demo audit

- [ ] `test/generated/run-generated-navlog-activation.test.ts`: W8's plan journey gets one structured reply — `PLAN_REPLY` becomes a JSON string matching the kit (BottomLine + KeyNumbers + Citations + Prose with the current sentence as the Prose markdown, so `workbench-suggestions.ts`'s `getByText(planReply…)` assertion targets the Prose text — adjust the harness option to pass the visible Prose text, not the raw JSON). Keep `FILE_REPLY` plain (exercises the markdown fallback). Update the aimock fixture accounting comments.
- [ ] `docs/brand/demo/scenario.mjs` uses "Bottom line:" replies — leave them plain (fallback path); confirm `pnpm test:brand-demo` passes.
- [ ] Commit: `test(harness): the plan journey renders a structured brief`.

### Task 9: Docs, template mirror

- [ ] READMEs (example web + template web + example root `examples/navlog/README.md` if it describes the answer format) and `apps/web/content/docs/recipes/flight-planner.mdx` / `flight-planner-web-ui.mdx` where they describe "Bottom line:" text answers: describe the brief kit and the hashbrown schema. `node scripts/check-docs.mjs`; commit; `pnpm --dir apps/web seo:lastmod` and commit the manifest.
- [ ] Mirror web `app/` and server `src/` into the template (the web loop from earlier plans, plus the same loop for `examples/navlog/server/src` → `packages/devkit/templates/app-navlog/server/src`, including the new `evals/brief-schema.json`); update `packages/devkit/test/templates.test.ts` counts for new test files. `pnpm --filter @b4run/devkit test` → PASS. Commit.

### Task 10: Verify and ship

- [ ] `pnpm install --frozen-lockfile && pnpm build && pnpm lint && pnpm typecheck && pnpm --filter @b4-example/navlog-web test && pnpm --filter @b4-example/navlog-server test && pnpm --filter @b4run/devkit test && npx vitest --run test/harness/workbench- && pnpm test:brand-demo && pnpm --filter @b4run/web test && node scripts/check-docs.mjs && pnpm --filter @b4-example/navlog-web test:e2e`; then (dev servers stopped) `pnpm verify:harness:framework`.
- [ ] Live: plan KSTP → KRST with the real model; the answer streams in as components in the chat; the Brief tab shows the same; citation markers jump; "Change" fills the composer; an old thread's markdown answer still renders; axe clean.
- [ ] Re-fetch `main`; push; open PR 2 (`navlog: the planning brief as structured UI (hashbrown)`); auto-merge; bind.
