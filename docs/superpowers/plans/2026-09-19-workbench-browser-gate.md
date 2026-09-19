# Workbench Browser Gate (SP4, step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CI open the scaffolded Workbench in headless Chromium, send the README demo prompt through the real CopilotKit runtime to the real B4 server (aimock behind it), and prove the run completes and the thread restores after reload.

**Architecture:** A seventh web assertion (W7) inside the existing generated-app activation test, executed against the Workbench the harness has already booted. The browser journey lives in a small typed helper (`test/harness/workbench-browser.ts`) that reuses the exported journey functions from `docs/brand/demo/capture.mjs`; Chromium is injected so the helper has a unit test with a fake browser, and the activation test passes the real `@playwright/test` chromium. `harness-verify` gains one Chromium install step. No new job, runner, or test-id contract.

**Tech Stack:** vitest 4 (test/generated lane), `@playwright/test` 1.62.1 (root devDependency, used as a library — `chromium.launch`, not the runner), `@b4run/testing` aimock `script()` fixtures, existing harness (`withPackagedNpmServer`, `httpOkReadiness`).

**Spec:** `docs/superpowers/specs/2026-09-19-workbench-browser-gate-design.md`

**Environment:** Node 24 (`nvm use 24` — Node 22 fails ~8 harness tests spuriously). Run `pnpm install --frozen-lockfile && pnpm build` once in a fresh worktree. Install a browser once: `pnpm exec playwright install chromium`. Capture exit codes directly (`cmd > /tmp/x.log 2>&1; echo $?`); never pipe a gate through `tail`. Never run bare `biome check --write`; use `pnpm lint:fix` or the package's lint script.

---

## File structure

| File | Responsibility |
|---|---|
| `docs/brand/demo/capture.d.ts` (create) | Type declarations for the four journey helpers so TypeScript under `test/tsconfig.json` (no `allowJs`) can import the `.mjs`. |
| `test/harness/workbench-browser.ts` (create) | `runWorkbenchBrowserJourney(options, deps)`: launch → open → send → complete → read thread id → restore → collect console errors → screenshot on failure → close. Pure orchestration; no harness state. |
| `test/harness/workbench-browser.test.ts` (create) | Unit tests with a fake `chromium` proving ordering, the console-error assertion, the missing-thread-id failure, and the screenshot-on-failure path. |
| `test/generated/run-generated-research-activation.test.ts` (modify) | Register `DEMO_FIXTURES`; call W7 at the end of the `dev:web` session with the real chromium. |
| `.github/workflows/ci.yml` (modify, `harness-verify` job) | `pnpm exec playwright install --with-deps chromium` after `Build`. |

---

### Task 1: Type declarations for the capture helpers

**Files:**
- Create: `docs/brand/demo/capture.d.ts`
- Test: `pnpm typecheck` (root; `test/tsconfig.json` is what compiles `test/**`)

- [ ] **Step 1: Write a probe import that must fail to type-check**

Create `test/harness/workbench-browser.ts` with only:

```ts
import { openReadyWorkbench } from "../../docs/brand/demo/capture.mjs"

export const probe = openReadyWorkbench
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `pnpm typecheck > /tmp/tc1.log 2>&1; echo "exit=$?"; grep -m2 -E "capture.mjs|TS7016|TS2307" /tmp/tc1.log`
Expected: `exit=1` and a `TS7016` ("Could not find a declaration file for module '../../docs/brand/demo/capture.mjs'") or `TS2307`.

- [ ] **Step 3: Write the declaration file**

`docs/brand/demo/capture.d.ts`:

```ts
/**
 * Types for the journey helpers `capture.mjs` exports. The README capture
 * script and the Workbench browser gate (test/harness/workbench-browser.ts)
 * share these; keep the signatures in step with the .mjs.
 */
import type { Page } from "@playwright/test"

export function openReadyWorkbench(page: Page, url: string): Promise<void>

export function fillActiveWorkbenchComposer(page: Page, prompt: string): Promise<void>

export function waitForWorkbenchRunCompletion(page: Page): Promise<void>

export function restoreWorkbenchThread(
  page: Page,
  options: {
    readonly workbenchUrl: string
    readonly threadId: string
    readonly prompt: string
    readonly tools: readonly string[]
    readonly answer: string
  },
): Promise<void>
```

- [ ] **Step 4: Run typecheck to verify it passes**

Run: `pnpm typecheck > /tmp/tc2.log 2>&1; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 5: Confirm lint and the brand-demo unit tests are untouched**

Run: `pnpm lint > /tmp/l1.log 2>&1; echo "lint=$?"; pnpm test:brand-demo > /tmp/bd.log 2>&1; echo "brand-demo=$?"`
Expected: both `0`. (Root lint runs `biome lint` over `docs/brand/demo`; a `.d.ts` there must pass it.)

- [ ] **Step 6: Commit**

```bash
git add docs/brand/demo/capture.d.ts test/harness/workbench-browser.ts
git commit -m "test(harness): declare types for the Workbench capture helpers

The activation harness will drive the scaffolded Workbench through the same
journey the README recording uses. test/tsconfig.json has no allowJs, so the
.mjs helpers need a declaration file to be importable from TypeScript.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The browser journey helper, unit-tested with a fake browser

**Files:**
- Modify: `test/harness/workbench-browser.ts` (replace the probe)
- Create: `test/harness/workbench-browser.test.ts`

The helper takes its browser as a dependency so the unit test never launches Chromium. The activation test (Task 3) passes the real one.

- [ ] **Step 1: Write the failing unit tests**

`test/harness/workbench-browser.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"

import {
  runWorkbenchBrowserJourney,
  type WorkbenchBrowserDeps,
  type WorkbenchBrowserJourney,
} from "./workbench-browser.ts"

const PROMPT = "What are common agent architectures?"
const ANSWER = "ReAct and plan-and-execute are common. [corpus/agent-architectures.md]"

function fakeDeps(overrides: {
  readonly threadId?: string | undefined
  readonly consoleErrors?: readonly string[]
  readonly pageErrors?: readonly string[]
  readonly failRestore?: boolean
} = {}) {
  const calls: string[] = []
  const listeners = new Map<string, (payload: unknown) => void>()
  const page = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
    }),
    evaluate: vi.fn(async () => overrides.threadId),
    screenshot: vi.fn(async () => {
      calls.push("screenshot")
    }),
    getByRole: vi.fn(() => ({
      click: vi.fn(async () => {
        calls.push("click:Send")
      }),
    })),
  }
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {
      calls.push("context.close")
    }),
  }
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {
      calls.push("browser.close")
    }),
  }
  const chromium = { launch: vi.fn(async () => browser) }
  const journey: WorkbenchBrowserJourney = {
    openReadyWorkbench: vi.fn(async () => {
      calls.push("open")
      // Emit the errors after the page is open, like a real page would.
      for (const text of overrides.consoleErrors ?? []) {
        listeners.get("console")?.({
          type: () => "error",
          text: () => text,
          location: () => ({ url: "" }),
        })
      }
      for (const message of overrides.pageErrors ?? []) {
        listeners.get("pageerror")?.(new Error(message))
      }
    }),
    fillActiveWorkbenchComposer: vi.fn(async () => {
      calls.push("fill")
    }),
    waitForWorkbenchRunCompletion: vi.fn(async () => {
      calls.push("complete")
    }),
    restoreWorkbenchThread: vi.fn(async () => {
      calls.push("restore")
      if (overrides.failRestore) throw new Error("thread rail did not list the prompt")
    }),
  }
  const deps: WorkbenchBrowserDeps = { chromium: chromium as never, journey }
  return { calls, deps, page, chromium }
}

const baseOptions = {
  webUrl: "http://127.0.0.1:4712",
  prompt: PROMPT,
  tools: ["searchCorpus", "readDoc"],
  answer: ANSWER,
  screenshotPath: "/tmp/never-written.png",
}

describe("runWorkbenchBrowserJourney", () => {
  it("drives open → fill → send → complete → restore, then closes context and browser", async () => {
    const { calls, deps, chromium } = fakeDeps({ threadId: "t-1" })
    const result = await runWorkbenchBrowserJourney(baseOptions, deps)
    expect(calls).toEqual([
      "open",
      "fill",
      "click:Send",
      "complete",
      "restore",
      "context.close",
      "browser.close",
    ])
    expect(result).toEqual({ threadId: "t-1" })
    expect(chromium.launch).toHaveBeenCalledWith({ headless: true })
  })

  it("fails when the Workbench never persists the thread id, and still closes the browser", async () => {
    const { calls, deps, page } = fakeDeps({ threadId: undefined })
    await expect(runWorkbenchBrowserJourney(baseOptions, deps)).rejects.toThrow(
      /did not persist the active thread id/,
    )
    expect(page.screenshot).toHaveBeenCalledWith({ path: baseOptions.screenshotPath, fullPage: true })
    expect(calls.slice(-2)).toEqual(["context.close", "browser.close"])
  })

  it("fails on a console error even when every step succeeded", async () => {
    const { deps } = fakeDeps({ threadId: "t-1", consoleErrors: ["Hydration failed"] })
    await expect(runWorkbenchBrowserJourney(baseOptions, deps)).rejects.toThrow(
      /console errors.*Hydration failed/s,
    )
  })

  it("fails on an uncaught page error", async () => {
    const { deps } = fakeDeps({ threadId: "t-1", pageErrors: ["boom"] })
    await expect(runWorkbenchBrowserJourney(baseOptions, deps)).rejects.toThrow(/pageerror: boom/)
  })

  it("screenshots and rethrows when restoration fails", async () => {
    const { deps, page } = fakeDeps({ threadId: "t-1", failRestore: true })
    await expect(runWorkbenchBrowserJourney(baseOptions, deps)).rejects.toThrow(
      /thread rail did not list the prompt/,
    )
    expect(page.screenshot).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `pnpm exec vitest --run --config test/generated/vitest.config.ts test/harness/workbench-browser.test.ts > /tmp/wb1.log 2>&1; echo "exit=$?"; grep -E "Tests|does not provide an export|not a function" /tmp/wb1.log | head -3`
Expected: `exit=1`; the module has no `runWorkbenchBrowserJourney` export yet.

- [ ] **Step 3: Write the helper**

Replace `test/harness/workbench-browser.ts` entirely:

```ts
/**
 * The Workbench browser gate: drive the scaffolded web client in a real
 * browser, through the real CopilotKit runtime, to the real B4 server.
 *
 * This is the README recording's journey (docs/brand/demo/capture.mjs)
 * promoted to a CI assertion. The journey functions are imported from there so
 * the gate and the recording cannot drift; `chromium` is injected so this file
 * has a unit test that never launches a browser.
 *
 * Fail closed: a missing browser, a missing persisted thread id, a console
 * error, or an uncaught page error each fail the journey. There is no skip.
 */
import type { Browser, BrowserContext, Page } from "@playwright/test"

import {
  fillActiveWorkbenchComposer,
  openReadyWorkbench,
  restoreWorkbenchThread,
  waitForWorkbenchRunCompletion,
} from "../../docs/brand/demo/capture.mjs"

export interface WorkbenchBrowserJourney {
  readonly openReadyWorkbench: typeof openReadyWorkbench
  readonly fillActiveWorkbenchComposer: typeof fillActiveWorkbenchComposer
  readonly waitForWorkbenchRunCompletion: typeof waitForWorkbenchRunCompletion
  readonly restoreWorkbenchThread: typeof restoreWorkbenchThread
}

export interface WorkbenchBrowserDeps {
  readonly chromium: { launch(options: { headless: true }): Promise<Browser> }
  readonly journey?: WorkbenchBrowserJourney
}

export interface WorkbenchBrowserOptions {
  /** The generated web client's base URL (the harness's `dev:web` session). */
  readonly webUrl: string
  /** The prompt to send; must match an aimock fixture's `userMessage`. */
  readonly prompt: string
  /** Tool names the fixture calls, in order — asserted as cards after reload. */
  readonly tools: readonly string[]
  /** The fixture's final reply — asserted on screen after reload. */
  readonly answer: string
  /** Written only when the journey fails, next to the harness transcripts. */
  readonly screenshotPath: string
}

const DEFAULT_JOURNEY: WorkbenchBrowserJourney = {
  openReadyWorkbench,
  fillActiveWorkbenchComposer,
  waitForWorkbenchRunCompletion,
  restoreWorkbenchThread,
}

/** The key the Workbench persists its thread list under (AppShell / thread-source.ts). */
const THREADS_STORAGE_KEY = "b4.workbench.threads"

export async function runWorkbenchBrowserJourney(
  options: WorkbenchBrowserOptions,
  deps: WorkbenchBrowserDeps,
): Promise<{ readonly threadId: string }> {
  const journey = deps.journey ?? DEFAULT_JOURNEY
  const browser = await deps.chromium.launch({ headless: true })
  let context: BrowserContext | undefined
  try {
    context = await browser.newContext()
    const page = await context.newPage()
    const errors = collectPageErrors(page)
    try {
      await journey.openReadyWorkbench(page, options.webUrl)
      await journey.fillActiveWorkbenchComposer(page, options.prompt)
      await page.getByRole("button", { name: "Send", exact: true }).click()
      await journey.waitForWorkbenchRunCompletion(page)

      const threadId = await readPersistedThreadId(page, options.prompt)
      if (threadId === undefined) {
        throw new Error("Workbench did not persist the active thread id")
      }
      await journey.restoreWorkbenchThread(page, {
        workbenchUrl: options.webUrl,
        threadId,
        prompt: options.prompt,
        tools: options.tools,
        answer: options.answer,
      })
      if (errors.length > 0) {
        throw new Error(`Workbench console errors during the browser gate:\n${errors.join("\n")}`)
      }
      return { threadId }
    } catch (error) {
      // Best effort: the rendered state is the one thing the transcript cannot show.
      await page.screenshot({ path: options.screenshotPath, fullPage: true }).catch(() => undefined)
      throw error
    }
  } finally {
    await context?.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() !== "error") return
    const { url } = message.location()
    errors.push(url === "" ? message.text() : `${message.text()} [${url}]`)
  })
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`))
  return errors
}

async function readPersistedThreadId(page: Page, prompt: string): Promise<string | undefined> {
  return page.evaluate(
    ({ key, title }) => {
      const raw = localStorage.getItem(key)
      const threads: unknown = raw === null ? [] : JSON.parse(raw)
      if (!Array.isArray(threads)) return undefined
      const thread = threads.find(
        (entry) => typeof entry === "object" && entry !== null && (entry as { title?: unknown }).title === title,
      ) as { id?: unknown } | undefined
      return typeof thread?.id === "string" ? thread.id : undefined
    },
    { key: THREADS_STORAGE_KEY, title: prompt },
  )
}
```

Note the fake page in the test implements `evaluate` as `async () => threadId`, ignoring the function — that is why `readPersistedThreadId` is exercised for real only in Task 4.

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm exec vitest --run --config test/generated/vitest.config.ts test/harness/workbench-browser.test.ts > /tmp/wb2.log 2>&1; echo "exit=$?"; grep -E "Tests " /tmp/wb2.log`
Expected: `exit=0`, `Tests  5 passed (5)`.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck > /tmp/tc3.log 2>&1; echo "typecheck=$?"; pnpm lint > /tmp/l2.log 2>&1; echo "lint=$?"`
Expected: both `0`. If lint reports formatting, run `pnpm lint:fix` and re-run `pnpm lint` (never bare `biome check --write`).

- [ ] **Step 6: Commit**

```bash
git add test/harness/workbench-browser.ts test/harness/workbench-browser.test.ts
git commit -m "test(harness): add the Workbench browser journey with an injected browser

Open the scaffolded Workbench, send a prompt, wait for the run to settle,
read the persisted thread id, reload and restore the thread, and fail on any
console or page error. The browser is a dependency so the ordering, the
fail-closed paths, and the screenshot-on-failure are unit-tested without
Chromium.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Wire W7 into the activation test

**Files:**
- Modify: `test/generated/run-generated-research-activation.test.ts` (imports ~L1-30; fixture registration ~L1117-1121; end of the `dev:web` session ~L1560-1567)

- [ ] **Step 1: Add the imports**

After the existing `createAimock, script` import line, add:

```ts
import { DEMO_FIXTURES, DEMO_PROMPT } from "../../docs/brand/demo/scenario.mjs"
import { runWorkbenchBrowserJourney } from "../harness/workbench-browser.ts"
```

`scenario.mjs` needs a declaration too. Create `docs/brand/demo/scenario.d.ts`:

```ts
import type { AimockFixture } from "../../../packages/testing/src/fixture-builder.ts"

export const DEMO_PROMPT: string
export const DEMO_FIXTURES: readonly AimockFixture[]
```

`AimockFixture` is exported as an interface from `packages/testing/src/fixture-builder.ts:9` (verified).

- [ ] **Step 2: Register the demo fixtures**

In the `aimock.addFixtures([...])` call, append the demo fixtures as the last spread:

```ts
    aimock.addFixtures([
      ...createSafeResearchFixtures(),
      ...createGatedAndBuiltFixtures(),
      ...createWebHopFixtures(),
      // W7: the README recording's journey, driven from a real browser.
      ...DEMO_FIXTURES,
    ])
```

- [ ] **Step 3: Add W7 at the end of the `dev:web` session**

Immediately before `return { webInterruptId: webInterrupt.interruptId }` (the last statement of the `async ({ url: webUrl }) => { … }` callback), insert:

```ts
            // W7 — the Workbench, in a real browser. Everything above proves the
            // web tier over HTTP; this proves the page renders, sends, streams,
            // settles, persists the thread, and restores it after a reload —
            // the README recording's journey, now required. The +3 is the
            // demo fixture's two tool turns plus its reply, the browser's only
            // path to a model being the B4 server behind the CopilotKit route.
            const { chromium } = await import("@playwright/test")
            const browserJournalStart = activeAimock.getRequests().length
            const browserResult = await runWorkbenchBrowserJourney(
              {
                webUrl,
                prompt: DEMO_PROMPT,
                tools: ["searchCorpus", "readDoc"],
                answer: "ReAct and plan-and-execute are common. [corpus/agent-architectures.md]",
                screenshotPath: join(dirname(commandsTranscriptPath), "workbench-browser.png"),
              },
              { chromium },
            )
            expect(browserResult.threadId).toMatch(
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
            )
            expect(activeAimock.getRequests()).toHaveLength(browserJournalStart + 3)
```

`dirname` and `join` are already imported from `node:path` at the top of the file; `commandsTranscriptPath` is the const defined at line 1073 and is in scope inside the session callback at line 1445 (the session options a few lines above already use it). Thread ids are `randomUUID()` (`thread-source.ts:194`), hence the UUID pattern.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck > /tmp/tc4.log 2>&1; echo "exit=$?"; grep -m3 "error TS" /tmp/tc4.log`
Expected: `exit=0`. A `TS7016` on `scenario.mjs` means the `.d.ts` from Step 1 is missing or misnamed.

- [ ] **Step 5: Commit (the run is Task 5; this commit is the wiring)**

```bash
git add docs/brand/demo/scenario.d.ts test/generated/run-generated-research-activation.test.ts
git commit -m "test(generated): W7 — drive the scaffolded Workbench in headless Chromium

The seventh web assertion opens the generated web client in a real browser,
sends the README demo prompt through the CopilotKit runtime to the B4 server,
waits for the run to settle, and restores the thread after a reload. Fails
closed on a missing browser, a missing persisted thread, or any console error.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Install Chromium in the `harness-verify` job

**Files:**
- Modify: `.github/workflows/ci.yml` (`harness-verify` job, between `Build` and `Harness Coordinator Self-Test`)

- [ ] **Step 1: Add the step**

Find the `harness-verify:` job. After its `- name: Build` / `run: pnpm build` step, insert:

```yaml
      # W7 in the generated-app activation test drives the scaffolded Workbench
      # in headless Chromium (test/harness/workbench-browser.ts). Root `pnpm exec`
      # resolves because @playwright/test is a root devDependency, unlike the
      # inspector lane which must --filter.
      - name: Install Chromium for the Workbench browser gate
        run: pnpm exec playwright install --with-deps chromium
```

- [ ] **Step 2: Run the workflow-contract audit**

Adding a step does not change the workflow entrypoint set, but the contracts test pins workflow shape. Run: `pnpm test:release-integrity > /tmp/wc.log 2>&1; echo "exit=$?"; grep -iE "workflow|fail" /tmp/wc.log | head -5`
Expected: `exit=0`. If it fails naming `ci.yml`, the audited fixture must be regenerated per `docs/superpowers/**/workflow` notes — read the failure text; it names the fixture and the expected regeneration command.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(harness-verify): install Chromium for the Workbench browser gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Local acceptance run, then prove the assertions bind

**Files:** none modified permanently.

The activation lane needs the local registry the harness builds; the lane command does that itself.

- [ ] **Step 1: Ensure a browser exists locally**

Run: `pnpm exec playwright install chromium > /tmp/pw.log 2>&1; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 2: Run the framework lane (the same command CI runs)**

Run: `pnpm verify:harness:framework > /tmp/lane.log 2>&1; echo "exit=$?"`
Expected: `exit=0`. Confirm W7 actually executed — the aimock journal delta assertion only runs if the browser did:

Run: `R=$(ls -t artifacts/testing/*/framework/vitest-report.json | head -1); echo "$R"; node -e 'const r=require(process.argv[1]); for (const f of r.testResults) for (const a of f.assertionResults) if (/activation/.test(a.fullName)) console.log(a.status, a.fullName, Math.round(a.duration/1000)+"s")' "$R"`
(The lane writes `artifacts/testing/<runId>/framework/vitest-report.json` — `scripts/harness-report.mjs:64,177,238`.)
Expected: the activation test `passed`. Note its duration for the PR description.

- [ ] **Step 3: Mutation 1 — a wrong prompt must fail at restoration, not pass**

Temporarily edit the W7 call: `prompt: \`${DEMO_PROMPT} (mutated)\``. Run the lane again:

Run: `pnpm verify:harness:framework > /tmp/lane-mut1.log 2>&1; echo "exit=$?"`
Expected: `exit=1`. The failure must be the gate, not an earlier assertion: `grep -m1 -E "did not persist the active thread id|unmatched|fixture" /tmp/lane-mut1.log`. (A mutated prompt matches no fixture, so the run errors and no thread persists.) Confirm the screenshot was written: `find artifacts/testing -name workbench-browser.png`. Revert the edit: `git checkout -- test/generated/run-generated-research-activation.test.ts`.

- [ ] **Step 4: Mutation 2 — no browser must fail, not skip**

Run: `PLAYWRIGHT_BROWSERS_PATH=$(mktemp -d) pnpm verify:harness:framework > /tmp/lane-mut2.log 2>&1; echo "exit=$?"; grep -m1 -iE "Executable doesn't exist|browser.*not (found|installed)" /tmp/lane-mut2.log`
Expected: `exit=1` and Playwright's missing-executable message. No `skipped` for the activation test.

- [ ] **Step 5: Clean tree, final gates**

Run: `git status --short; pnpm typecheck > /tmp/tc5.log 2>&1; echo "typecheck=$?"; pnpm lint > /tmp/l5.log 2>&1; echo "lint=$?"; node scripts/check-docs.mjs > /tmp/cd5.log 2>&1; echo "check-docs=$?"`
Expected: empty status; all three `0`.

---

### Task 6: Pull request

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin blove/sp4-workbench-browser-gate
gh pr create --base main --title "test(harness): open the scaffolded Workbench in a real browser (SP4, step 1)" --body-file - <<'EOF'
Closes the last open item of the Workbench arc: a seventh web assertion (W7) in the generated-app activation harness drives the scaffolded Workbench in headless Chromium — through the real CopilotKit runtime to the real B4 server, aimock behind it — sends the README demo prompt, waits for the run to settle, and restores the thread after a reload. It reuses the journey helpers `docs/brand/demo/capture.mjs` already exports, so the gate and the README recording cannot drift.

Spec: `docs/superpowers/specs/2026-09-19-workbench-browser-gate-design.md`.

**Why now.** `npm create b4-app@latest` is the advertised activation, and nothing in CI rendered the scaffolded Workbench. The three historical "green tests, dead UI" defects were all only visible on a rendered page; since then the template took CopilotKit 1.68→1.70 and 0.8.32–0.8.33 changed what the Workbench renders.

**Shape.** No new job, runner, or test-id contract: W7 attaches to the app the harness has already booted; `harness-verify` gains one `playwright install` step and is already `LANE_3` of `validate`. The browser is injected, so the journey has five unit tests with a fake browser.

**Fail closed.** Missing Chromium, missing persisted thread id, any console/page error → red. No skip path. Mutation-verified locally: a mutated prompt fails at restoration with a screenshot in the artifact; an empty `PLAYWRIGHT_BROWSERS_PATH` fails, not skips.

**Measured.** Activation test duration locally: <fill from Task 5 Step 2> (was ~3–4 min before W7).

Step 2 (gated journey, memory panel, plan/subagent cards) is a separate PR after this lane's CI cost is measured.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 2: Watch `harness-verify` and `validate`**

`validate` is an aggregate that registers late; `harness-verify` green is the signal that matters here. Record its wall clock vs the ~12 min baseline in the PR description. `review` will be red on credits; that does not block, but `required_conversation_resolution` does — resolve any CodeQL thread before merging.

---

## Self-review

**Spec coverage.** Where it runs (Task 3, 4) ✓. The journey steps 1–8 (Task 2 helper + Task 3 wiring; step 1 fixture registration ✓; step 6 the +3 delta ✓; step 7 localStorage seam ✓; step 8 console errors ✓). Failure behaviour: fail closed + screenshot (Task 2, verified in Task 5 mutations) ✓. Budget: measured in Task 5 / Task 6 ✓. Type coverage risk → `capture.d.ts` (Task 1) and `scenario.d.ts` (Task 3) ✓. Testing the gate itself: unit tests with fake browser + two mutations ✓. Out of scope: step 2 named in the PR ✓.

**Placeholders.** One deliberate fill-in in the PR body (`<fill from Task 5 Step 2>`) — a measurement, filled at Task 6. Two "verify the name/shape" guards (AimockFixture type name; `t-` thread-id prefix) give the exact command and the fallback.

**Type consistency.** `runWorkbenchBrowserJourney(options, deps)` — same signature in Task 2 test, Task 2 impl, Task 3 call. `WorkbenchBrowserDeps.chromium.launch({ headless: true })` matches the test's `toHaveBeenCalledWith({ headless: true })`. `restoreWorkbenchThread` option names (`workbenchUrl, threadId, prompt, tools, answer`) match `capture.d.ts` and the `.mjs`.
