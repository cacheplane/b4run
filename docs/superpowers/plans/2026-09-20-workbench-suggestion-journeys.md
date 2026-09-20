# Workbench Suggestion Journeys (SP4, step 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CI click the scaffolded Workbench's three suggestions in headless Chromium and prove the plan/subagent cards fill, the permission gate resolves through `Allow once`, and a remembered preference appears in the memory panel and can be approved.

**Architecture:** A new exported helper `runWorkbenchSuggestionJourneys` in `test/harness/workbench-browser.ts` reuses step 1's browser scaffolding (launch, console-error collection with the 404-probe allowlist, abort race, screenshot on failure) by extracting it into a shared internal `withWorkbenchPage`. The activation test calls it as **W8** right after W7 in the same `dev:web` session, with one new aimock fixture (`remember`). Unit tests drive the helper with the step 1 fake browser; the lane and three mutations prove it binds.

**Tech Stack:** vitest 4 (`test/generated` lane), `@playwright/test` 1.62.1 as a library, `@b4run/testing` aimock `script()` fixtures, step 1's `test/harness/workbench-browser.ts`.

**Spec:** `docs/superpowers/specs/2026-09-20-workbench-suggestion-journeys-design.md`

**Environment:** Node 24 (`export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH`). `pnpm install --frozen-lockfile && pnpm build` once in a fresh worktree; `pnpm exec playwright install chromium` once. Capture exit codes with `cmd > /tmp/x.log 2>&1; echo $?` — never pipe a gate through `tail`. Never run root `pnpm lint:fix` or bare `biome check --write`; scope formatting to your files: `pnpm exec biome check --write --config-path packages/config-biome/biome.json <files>`. Declaration files beside `.mjs` must be `.d.mts`.

**Facts the code depends on (verified 2026-09-20):**
- Suggestion buttons: `<button>` whose accessible name is `title` + `message` (`EmptyState.tsx:43-53`). Titles: `Research a topic`, `Trigger a permission prompt`, `Teach it a preference`.
- **Card `<details>` state:** the plan card is `open={hasActiveTodo}` (our fixture leaves one todo `in_progress`, so it is expanded); the subagent card is `open={content.status === "running"}`, so a *completed* subagent renders COLLAPSED and its `Subagent tools` list is hidden until the `<summary>` is clicked. Card summaries include the `▸` marker in `textContent`, so header assertions must not use `{ exact: true }`.
- Safe journey = 10 model turns (root 7 incl. one `writeTodos` with statuses completed/in_progress/pending/pending; researcher 3). Plan card summary text: `Plan · 1/4 complete`. Subagent card summary: `researcher · completed · 2 tools`; tools list `aria-label="Subagent tools"`. Root reply: `I wrote a short report covering ReAct and plan-and-execute architectures. [corpus/agent-architectures.md]`.
- Gated journey = 2 turns; the gate is `role="alert"` with buttons `Allow once` / `Allow always` / `Deny` (`PermissionPrompt.tsx:269-271`); `FETCH_COMMAND = "node scripts/fetch-source.mjs quantum computing"`; `GATED_REPLY = "Fetched external context after approval."` — both constants already exist in the activation test.
- Memory panel: `aria-label="Memory candidates"`; row shows `candidate.content` then `candidate.namespace`; Approve button `aria-label` is `Approve: ${shortLabel(content)}` with `LABEL_LIMIT = 60` (our content is 36 chars, so it is the full content). The panel refetches after a decision. `remember`'s schema: `data: { subject, predicate, value }` plus `content`.
- **Memory panel lifecycle (verified in `MemoryPanel.tsx`):** it subscribes to the agent and calls `load()` on `onRunFinishedEvent`, so the new candidate appears after the run completes with **no reload** — journey 3 must not reload. It returns `null` when there are no candidates, so the `aria-label="Memory candidates"` element does not exist until one does (Playwright locators are lazy, so locating the panel before the row appears is fine), and after approving the only candidate the element is replaced by the outcome line — `waitFor({ state: "hidden" })` on the row is still correct either way.
- **The gate command is inside the alert:** `InterruptCard` puts `role="alert"` on the wrapper and renders `{children}` within it, so `getByRole("alert").filter({ hasText: fetchCommand })` matches.
- `New conversation` is a button (`getByRole("button", { name: "New conversation", exact: true })`, already used by `openReadyWorkbench`).

---

## File structure

| File | Responsibility |
|---|---|
| `test/harness/workbench-browser.ts` (modify) | Extract `withWorkbenchPage` (launch → errors → abort race → screenshot → close) from `runWorkbenchBrowserJourney`; add `runWorkbenchSuggestionJourneys` and its three journey functions. |
| `test/harness/workbench-browser.test.ts` (modify) | Fake-browser tests for the new helper: ordering per journey, journey-named failure, per-journey screenshot name, refactor-safety of W7's tests. |
| `test/generated/run-generated-research-activation.test.ts` (modify) | `createTeachFixture()`; W8 call after W7. |

---

### Task 1: Extract the page scaffolding without changing W7's behaviour

**Files:**
- Modify: `test/harness/workbench-browser.ts`
- Test: `test/harness/workbench-browser.test.ts` (existing 21 tests must stay green, unchanged)

- [ ] **Step 1: Confirm the baseline is green**

Run: `pnpm exec vitest --run --config test/generated/vitest.config.ts test/harness/workbench-browser.test.ts > /tmp/t1a.log 2>&1; echo "exit=$?"; grep "Tests " /tmp/t1a.log`
Expected: `exit=0`, `Tests  21 passed (21)`.

- [ ] **Step 2: Extract `withWorkbenchPage`**

In `test/harness/workbench-browser.ts`, add below the existing option types:

```ts
/**
 * Everything a browser journey needs around its page: launch, console/page
 * error collection (with the hydrate-probe allowlist), the abort race, the
 * failure screenshot (with collected errors attached), and cleanup. Step 1's
 * journey and step 2's suggestion journeys share it so the fail-closed rules
 * cannot drift between them.
 */
export interface WorkbenchPageOptions {
  readonly screenshotPath: string
  readonly signal?: AbortSignal
}

async function withWorkbenchPage<T>(
  options: WorkbenchPageOptions,
  deps: WorkbenchBrowserDeps,
  body: (page: Page, errors: readonly string[]) => Promise<T>,
): Promise<T> {
  // Move the existing body of runWorkbenchBrowserJourney here verbatim, from
  // the pre-launch abort check through the `finally`, replacing the journey
  // steps with `await raceAbort(body(page, errors), options.signal)` and
  // keeping: the closeOnAbort listener, the screenshot + mkdir in the catch,
  // the console-error append on failure, and the context/browser close.
}
```

Then make `runWorkbenchBrowserJourney` a thin caller: keep its prompt-shape check first, then

```ts
  return withWorkbenchPage(options, deps, async (page, errors) => {
    await journey.openReadyWorkbench(page, options.webUrl)
    await journey.fillActiveWorkbenchComposer(page, options.prompt)
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await journey.waitForWorkbenchRunCompletion(page)
    const threadId = /* existing lookup via findPersistedThreadId */
    await journey.restoreWorkbenchThread(page, { /* existing args */ })
    if (errors.length > 0) throw new Error(`Workbench console errors during the browser gate:\n${errors.join("\n")}`)
    return { threadId }
  })
```

The exact existing lines are in the file; do not change any message text, the allowlist, `raceAbort`, or `JOURNEY_ABORTED_MESSAGE`.

- [ ] **Step 3: Run the existing tests — they must pass unchanged**

Run: `pnpm exec vitest --run --config test/generated/vitest.config.ts test/harness/workbench-browser.test.ts > /tmp/t1b.log 2>&1; echo "exit=$?"; grep "Tests " /tmp/t1b.log`
Expected: `exit=0`, `Tests  21 passed (21)`. If any test changed behaviour, the extraction is wrong — fix the extraction, not the test.

- [ ] **Step 4: Typecheck, lint, commit**

Run: `pnpm typecheck > /tmp/t1c.log 2>&1; echo $?; pnpm lint > /tmp/t1d.log 2>&1; echo $?` — both `0`.

```bash
git add test/harness/workbench-browser.ts
git commit -m "test(harness): extract the Workbench page scaffolding from the browser gate

No behaviour change: launch, error collection, abort race, screenshot, and
cleanup move into withWorkbenchPage so the suggestion journeys share them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The three suggestion journeys, unit-tested with the fake browser

**Files:**
- Modify: `test/harness/workbench-browser.ts`
- Modify: `test/harness/workbench-browser.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/harness/workbench-browser.test.ts` (reuse the file's `fakeDeps` and extend its fake `page` with `getByRole(...).click/waitFor`, `getByText`, `getByLabel`, and `request.get` as shown; keep the existing tests untouched):

```ts
import { runWorkbenchSuggestionJourneys, type SuggestionJourneyDeps } from "./workbench-browser.ts"

function fakeSuggestionDeps(overrides: { readonly failAt?: "research" | "gate" | "teach" } = {}) {
  const calls: string[] = []
  const locator = (name: string) => ({
    click: vi.fn(async () => { calls.push(`click:${name}`) }),
    waitFor: vi.fn(async () => { calls.push(`wait:${name}`) }),
    last: () => ({ waitFor: vi.fn(async () => { calls.push(`wait:${name}`) }) }),
    getByText: (text: string) => locator(`${name}>${text}`),
    getByRole: (role: string, o?: { name?: string | RegExp }) => locator(`${name}>${role}:${String(o?.name ?? "")}`),
    getByLabel: (label: string) => locator(`${name}>label:${label}`),
  })
  const screenshots: string[] = []
  const page = {
    on: vi.fn(),
    evaluate: vi.fn(async () => "[]"),
    screenshot: vi.fn(async (o: { path: string }) => { screenshots.push(o.path) }),
    getByRole: vi.fn((role: string, o?: { name?: string | RegExp }) => locator(`${role}:${String(o?.name ?? "")}`)),
    getByText: vi.fn((text: string) => locator(`text:${text}`)),
    getByLabel: vi.fn((label: string) => locator(`label:${label}`)),
    request: { get: vi.fn(async () => ({ ok: () => true, status: () => 200, json: async () => ({ candidates: [] }) })) },
  }
  const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => { calls.push("context.close") }) }
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => { calls.push("browser.close") }) }
  const chromium = { launch: vi.fn(async () => browser as never) }
  const journey = {
    openReadyWorkbench: vi.fn(async () => { calls.push("open") }),
    waitForWorkbenchRunCompletion: vi.fn(async () => {
      calls.push("complete")
      const n = calls.filter((c) => c === "complete").length
      if (overrides.failAt === "research" && n === 1) throw new Error("research boom")
      if (overrides.failAt === "gate" && n === 2) throw new Error("gate boom")
      if (overrides.failAt === "teach" && n === 3) throw new Error("teach boom")
    }),
    journalLength: vi.fn(() => 0),
  }
  const deps: SuggestionJourneyDeps = { chromium: chromium as never, journey: journey as never }
  return { calls, deps, page, screenshots }
}

const suggestionOptions = {
  webUrl: "http://127.0.0.1:4712",
  screenshotDir: "/tmp/never",
  fetchCommand: "node scripts/fetch-source.mjs quantum computing",
  gatedReply: "Fetched external context after approval.",
  researchReply: "I wrote a short report covering ReAct and plan-and-execute architectures. [corpus/agent-architectures.md]",
  teachContent: "User prefers concise, cited reports.",
}

describe("runWorkbenchSuggestionJourneys", () => {
  it("runs research → gate → teach, each from a new conversation, in one browser", async () => {
    const { calls, deps } = fakeSuggestionDeps()
    await runWorkbenchSuggestionJourneys(suggestionOptions, deps)
    expect(calls.filter((c) => c === "open")).toHaveLength(1)
    expect(calls.filter((c) => c === "click:button:New conversation")).toHaveLength(3)
    expect(calls.filter((c) => c === "complete")).toHaveLength(3)
    expect(calls).toContain("click:button:/^Research a topic/")
    expect(calls).toContain("click:button:/^Trigger a permission prompt/")
    expect(calls).toContain("click:button:Allow once")
    expect(calls).toContain("click:button:/^Teach it a preference/")
    expect(calls).toContain("click:button:Approve: User prefers concise, cited reports.")
    expect(calls.slice(-2)).toEqual(["context.close", "browser.close"])
  })

  it("names the journey in the failure and the screenshot", async () => {
    const { deps, screenshots } = fakeSuggestionDeps({ failAt: "gate" })
    await expect(runWorkbenchSuggestionJourneys(suggestionOptions, deps)).rejects.toThrow(
      /^Trigger a permission prompt: .*gate boom/s,
    )
    expect(screenshots).toEqual(["/tmp/never/workbench-browser-gate.png"])
  })

  it("stops at the first failing journey", async () => {
    const { calls, deps } = fakeSuggestionDeps({ failAt: "research" })
    await expect(runWorkbenchSuggestionJourneys(suggestionOptions, deps)).rejects.toThrow(/^Research a topic:/)
    expect(calls).not.toContain("click:button:/^Trigger a permission prompt/")
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest --run --config test/generated/vitest.config.ts test/harness/workbench-browser.test.ts > /tmp/t2a.log 2>&1; echo "exit=$?"` — expect `exit=1` (no such export).

- [ ] **Step 3: Implement the helper**

Append to `test/harness/workbench-browser.ts`:

```ts
export interface SuggestionJourneyOptions {
  readonly webUrl: string
  /** Directory for per-journey failure screenshots (`workbench-browser-<journey>.png`). */
  readonly screenshotDir: string
  readonly fetchCommand: string
  readonly gatedReply: string
  readonly researchReply: string
  readonly teachContent: string
  readonly signal?: AbortSignal
}

export interface SuggestionJourneyDeps {
  readonly chromium: WorkbenchBrowserDeps["chromium"]
  readonly journey?: Pick<WorkbenchBrowserJourney, "openReadyWorkbench" | "waitForWorkbenchRunCompletion">
}

/** One journey's step, named so a failure says which suggestion broke. */
type SuggestionJourney = (typeof JOURNEYS)[number]

const JOURNEYS = [
  { key: "research", title: "Research a topic" },
  { key: "gate", title: "Trigger a permission prompt" },
  { key: "teach", title: "Teach it a preference" },
] as const

const VISIBLE = { state: "visible", timeout: 120_000 } as const
const HIDDEN = { state: "hidden", timeout: 120_000 } as const

async function startSuggestion(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "New conversation", exact: true }).click()
  await page.getByRole("button", { name: new RegExp(`^${title}`) }).click()
}

async function researchJourney(page: Page, o: SuggestionJourneyOptions, j: NonNullable<SuggestionJourneyDeps["journey"]>) {
  await startSuggestion(page, "Research a topic")
  await j.waitForWorkbenchRunCompletion(page)
  const main = page.getByRole("main")
  // Substring matches, never { exact: true }: each card summary starts with the
  // `▸` marker, which is a real aria-hidden element and so part of textContent.
  // The plan card stays expanded (open={hasActiveTodo}; the fixture leaves one
  // todo in_progress), so its checklist needs no click.
  await main.getByText("Plan · 1/4 complete").last().waitFor(VISIBLE)
  const subagentCard = main.locator("details").filter({ hasText: "researcher · completed" }).last()
  await subagentCard.locator("summary").waitFor(VISIBLE)
  await subagentCard.getByText(/researcher · completed · 2 tools/).waitFor(VISIBLE)
  // The subagent card collapses the moment its subagent finishes
  // (open={content.status === "running"}), so the tools list is in the DOM but
  // hidden. Expanding it is the only way to see the list — and is itself a real
  // user action worth gating.
  await subagentCard.locator("summary").click()
  const tools = subagentCard.getByLabel("Subagent tools")
  await tools.getByText("searchCorpus", { exact: true }).waitFor(VISIBLE)
  await tools.getByText("readDoc", { exact: true }).waitFor(VISIBLE)
  await main.getByText("writeFile", { exact: true }).last().waitFor(VISIBLE)
  await main.getByText(o.researchReply, { exact: true }).last().waitFor(VISIBLE)
}

async function gateJourney(page: Page, o: SuggestionJourneyOptions, j: NonNullable<SuggestionJourneyDeps["journey"]>) {
  await startSuggestion(page, "Trigger a permission prompt")
  const alert = page.getByRole("alert").filter({ hasText: o.fetchCommand })
  await alert.waitFor(VISIBLE)
  await alert.getByRole("button", { name: "Allow once", exact: true }).click()
  await alert.waitFor(HIDDEN)
  await j.waitForWorkbenchRunCompletion(page)
  await page.getByRole("main").getByText(o.gatedReply, { exact: true }).last().waitFor(VISIBLE)
}

async function teachJourney(page: Page, o: SuggestionJourneyOptions, j: NonNullable<SuggestionJourneyDeps["journey"]>) {
  await startSuggestion(page, "Teach it a preference")
  await j.waitForWorkbenchRunCompletion(page)
  const panel = page.getByLabel("Memory candidates")
  await panel.getByText(o.teachContent, { exact: true }).waitFor(VISIBLE)
  await panel.getByRole("button", { name: `Approve: ${o.teachContent}`, exact: true }).click()
  await panel.getByText(o.teachContent, { exact: true }).waitFor(HIDDEN)
  const response = await page.request.get(new URL("/api/b4/memory/candidates", o.webUrl).href)
  if (!response.ok()) throw new Error(`memory candidates read failed with HTTP ${response.status()}`)
  const body = (await response.json()) as { candidates?: Array<{ content?: unknown }> }
  if ((body.candidates ?? []).some((c) => c.content === o.teachContent)) {
    throw new Error("approved candidate is still listed by /api/b4/memory/candidates")
  }
}

export async function runWorkbenchSuggestionJourneys(
  options: SuggestionJourneyOptions,
  deps: SuggestionJourneyDeps,
): Promise<void> {
  const journey = deps.journey ?? DEFAULT_JOURNEY
  let current: SuggestionJourney = JOURNEYS[0]
  await withWorkbenchPage(
    {
      // A function, not a string: withWorkbenchPage resolves it at screenshot
      // time, so each journey's failure writes its own file instead of the
      // three overwriting one another.
      screenshotPath: () => join(options.screenshotDir, `workbench-browser-${current.key}.png`),
      signal: options.signal,
    },
    { chromium: deps.chromium },
    async (page, errors) => {
      await journey.openReadyWorkbench(page, options.webUrl)
      for (const next of JOURNEYS) {
        current = next
        try {
          if (next.key === "research") await researchJourney(page, options, journey)
          else if (next.key === "gate") await gateJourney(page, options, journey)
          else await teachJourney(page, options, journey)
          // Per journey, not once at the end: a console error from the research
          // journey must not be reported against "Teach it a preference" with a
          // screenshot of the memory panel.
          if (errors.length > 0) {
            throw new Error(`Workbench console errors:\n${errors.join("\n")}`)
          }
        } catch (error) {
          // The journey name goes on INSIDE the page body, so withWorkbenchPage
          // stays the single outer wrapping site and a CI log does not print the
          // same Playwright timeout three times.
          throw new Error(`${next.title}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          })
        }
      }
    },
  )
}
```

`withWorkbenchPage` accepts `screenshotPath` as `string | (() => string)` and resolves it at screenshot time (Task 1's follow-up commit), which is what makes the per-journey file name work; it also backstops the success-path `errors.length` check, so the per-journey check above is for attribution, not safety. Import `join` from `node:path` if not already imported.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest --run --config test/generated/vitest.config.ts test/harness/workbench-browser.test.ts > /tmp/t2b.log 2>&1; echo "exit=$?"; grep "Tests " /tmp/t2b.log`
Expected: `exit=0`, `Tests  24 passed (24)`.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm typecheck > /tmp/t2c.log 2>&1; echo $?; pnpm lint > /tmp/t2d.log 2>&1; echo $?` — both `0`.

```bash
git add test/harness/workbench-browser.ts test/harness/workbench-browser.test.ts
git commit -m "test(harness): drive the three Workbench suggestions in the browser

Research a topic (plan card, subagent card, report), Trigger a permission
prompt (Allow once → completion), Teach it a preference (memory candidate →
Approve). Each from a new conversation; failures name the journey and write
a journey-specific screenshot.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Wire W8 into the activation test

**Files:**
- Modify: `test/generated/run-generated-research-activation.test.ts`

- [ ] **Step 1: Add the teach fixture and constants**

Next to `BROWSER_PROMPT`/`BROWSER_REPLY`:

```ts
// W8's third journey. The Workbench's "Teach it a preference" suggestion sends
// this exact text; memory is in candidate mode in the template, so the
// remember() call below becomes a row in the memory panel.
const TEACH_PROMPT = "Remember that I prefer concise, cited reports."
const TEACH_CONTENT = "User prefers concise, cited reports."
const TEACH_REPLY = "Noted — I'll keep reports concise and cited."
const RESEARCH_REPLY =
  "I wrote a short report covering ReAct and plan-and-execute architectures. [corpus/agent-architectures.md]"
```

Replace the literal root reply in `createSafeResearchFixtures()` with `RESEARCH_REPLY` (same text). Add:

```ts
function createTeachFixture() {
  return script()
    .user(TEACH_PROMPT)
    .callsTool("remember", {
      data: { subject: "user", predicate: "prefers", value: "concise, cited reports" },
      content: TEACH_CONTENT,
    })
    .replies(TEACH_REPLY)
    .build()
}
```

Register it as the last spread in `registeredFixtures` (after `...createBrowserFixtures()`); the existing `findPromptCollisions` assertion covers it.

- [ ] **Step 2: Add W8 right after W7's journal assertion**

```ts
            // W8 — the three empty-state suggestions, in the same browser. Each
            // starts a new conversation and asserts its own exact journal delta:
            // Research = 10 (root 7 + researcher 3), Gate = 2 (the runBash turn,
            // then the resumed reply after Allow once), Teach = 2 (remember +
            // reply). The cards, the gate, and the memory panel are the surfaces
            // a template or CopilotKit bump breaks first.
            const suggestionsJournalStart = activeAimock.getRequests().length
            await runWorkbenchSuggestionJourneys(
              {
                webUrl,
                screenshotDir: dirname(browserScreenshotPath),
                fetchCommand: FETCH_COMMAND,
                gatedReply: GATED_REPLY,
                researchReply: RESEARCH_REPLY,
                teachContent: TEACH_CONTENT,
                signal: lifecycleSignal,
              },
              { chromium },
            )
            expect(activeAimock.getRequests()).toHaveLength(suggestionsJournalStart + 10 + 2 + 2)
```

Import `runWorkbenchSuggestionJourneys` alongside `runWorkbenchBrowserJourney`. Add `workbench-browser-research.png`, `-gate.png`, `-teach.png` to the wrapper's failure message next to the existing screenshot line.

- [ ] **Step 3: Typecheck, lint, commit (lane run is Task 4)**

Run: `pnpm typecheck > /tmp/t3a.log 2>&1; echo $?; pnpm lint > /tmp/t3b.log 2>&1; echo $?` — both `0`.

```bash
git add test/generated/run-generated-research-activation.test.ts
git commit -m "test(generated): W8 — click the three Workbench suggestions in the browser

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Lane acceptance and three mutations

- [ ] **Step 1: Green run** — `pnpm verify:harness:framework > /tmp/lane.log 2>&1; echo $?` → `0`. Record the activation test's duration from `artifacts/testing/<latest>/framework/vitest-report.json`.
- [ ] **Step 2: Mutation research** — change `"Plan · 1/4 complete"` to `"Plan · 4/4 complete"` in `researchJourney`; lane must exit 1 with `Research a topic:` in the message and `workbench-browser-research.png` present. Revert.
- [ ] **Step 3: Mutation gate** — comment out the `Allow once` click; lane must exit 1 with `Trigger a permission prompt:` and the alert `waitFor(HIDDEN)` timeout in the cause chain. Revert.
- [ ] **Step 4: Mutation teach** — change `TEACH_CONTENT` in the W8 call to `"wrong"`; lane must exit 1 with `Teach it a preference:`. Revert.
- [ ] **Step 5:** `git status --short` empty; `pnpm typecheck`, `pnpm lint`, `node scripts/check-docs.mjs` all `0`.

---

### Task 5: Pull request

- [ ] Push `blove/sp4-step2-suggestion-journeys`; open the PR with the spec link, the three journeys and their deltas, the measured activation duration and `harness-verify` wall clock, the three mutation results, and "Not covered" from the spec. End with the Claude Code attribution line.

---

## Self-review

**Spec coverage.** W8 placement (Task 3) ✓; three journeys with their assertions (Task 2) ✓; teach fixture (Task 3) ✓; journey-named failures + per-journey screenshots (Task 2) ✓; deltas 10/2/2 (Task 3) ✓; mutations one per journey (Task 4) ✓; shared scaffolding so fail-closed rules cannot drift (Task 1) ✓.

**Placeholders.** Task 1 Step 2 says "move the existing body verbatim" and Task 1 Step 3 pins that the 21 existing tests must pass unchanged — the code is in the file and the test is the contract. No TBDs.

**Type consistency.** `SuggestionJourneyOptions`/`SuggestionJourneyDeps` names match between Task 2's tests and implementation and Task 3's call; `withWorkbenchPage` signature in Task 1 matches its use in Task 2.
