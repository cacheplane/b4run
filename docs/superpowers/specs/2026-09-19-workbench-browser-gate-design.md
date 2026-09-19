# Workbench browser gate (SP4, step 1)

**Status:** design, 2026-09-19. Closes the last open item of the Workbench arc
(`2026-08-19-dawn-workbench-design.md`, "SP4: browser activation gate") and
follow-up 2 of `2026-08-10-ag-ui-plan-subagent-activities-design.md`.

## Problem

`npm create b4-app@latest` is the advertised activation on the homepage header,
mobile menu, README, and `llms.txt`, and the README's product-loop recording is
the generated Workbench. Nothing in CI opens that Workbench in a browser. The
activation harness drives the generated web tier over HTTP only (W1–W6 in
`test/generated/run-generated-research-activation.test.ts`); the only research
e2e (`examples/research/web/e2e/copilotkit-v2.spec.ts`) runs against the
*example*, not the scaffold, and asserts transport selection only.

The three historical "every test green, UI dead" defects (StrictMode `useRef`
latch, connect predicate on the wrong server, array-form content hydrating a
blank thread) were all integration failures only a rendered page shows. Since
then the template took `@copilotkit/react-core ^1.68.3 → ^1.70.0` and
`@ag-ui/client 0.0.57 → 0.0.59` (#524), and 0.8.32–0.8.33 changed what the
Workbench renders (per-model assistant messages, middleware request bodies). PRs
currently merge on bot auto-approval while review credits are out.

## What already exists and is reused

`docs/brand/demo/capture.mjs` (#530) scaffolds the research starter in internal
mode, boots server and Workbench against aimock with a scrubbed environment,
launches headless Chromium from `@playwright/test` (already a root
devDependency at 1.62.1), and exports the journey as helpers:

| helper | what it proves |
|---|---|
| `openReadyWorkbench(page, url)` | `GET /api/copilotkit/info` answers 200 during first load |
| `fillActiveWorkbenchComposer(page, prompt)` | "New conversation" is visible; `textbox "Message"` accepts input |
| `waitForWorkbenchRunCompletion(page)` | `Stop` hides, `Send` returns, composer is editable again |
| `restoreWorkbenchThread(page, {workbenchUrl, threadId, prompt, tools, answer})` | reload → the thread rail lists the auto-titled thread → clicking it fetches `/api/b4/threads/:id/state` → tool cards and the answer are on screen |

All locators are role- or text-based; no `data-testid` contract is needed for
this journey. The sibling modules it imports (`scenario.mjs`, `stage.mjs`,
`processes.mjs`, `normalize-log.mjs`) have no top-level side effects. The script
itself has no CI invocation (`pnpm media:readme:capture` only).

`docs/brand/demo/scenario.mjs` exports `DEMO_PROMPT`
("What are common agent architectures?") and `DEMO_FIXTURES` (one `searchCorpus`
call, one `readDoc` call, a cited reply). The prompt is distinct from every
prompt the activation test already scripts, so it adds no fixture-matching
ambiguity.

## Design

### Where it runs

Inside the existing activation test, as a seventh web assertion (**W7**) in the
`dev:web` session, after W6. It attaches to the generated app the harness has
already installed, built, and booted. No new CI job, no new test runner, no
Playwright suite: `chromium` is imported from `@playwright/test` and driven
directly, exactly as `capture.mjs` does.

`harness-verify` is already `LANE_3` of the required `validate` aggregate, so
the gate is required by construction. The job gains one step after `Build`:

```
pnpm exec playwright install --with-deps chromium
```

Root `pnpm exec` resolves because `@playwright/test` is a root devDependency
(the inspector's `--filter` requirement does not apply here).

### The journey (W7)

1. `DEMO_FIXTURES` is registered on the harness's aimock alongside the existing
   fixtures. Journal accounting for W1–W6 is untouched: W7 runs after them and
   asserts only its own delta.
2. Launch headless Chromium; new context; collect every `console` error and
   `pageerror` for the page's lifetime.
3. `openReadyWorkbench(page, webUrl)`.
4. `fillActiveWorkbenchComposer(page, DEMO_PROMPT)`; click `Send`.
5. `waitForWorkbenchRunCompletion(page)`.
6. Assert the aimock journal grew by exactly 3 (`DEMO_FIXTURES` is two tool
   calls and one reply). The browser's only path to a model is the B4 server —
   W6's invariant, now proven from a real page.
7. Read the thread id from `localStorage["b4.workbench.threads"]`, the entry
   whose `title` equals the prompt (the seam `capture.mjs` reads at line ~951;
   missing id is a failure). Then `restoreWorkbenchThread(page, …)` with the
   fixture's tool names and answer text.
8. Assert the collected console/page errors are empty. Close the browser in a
   `finally`.

### Failure behaviour

Fail closed. A missing Chromium is a failure, not a skip (`playwright install`
is documented for local runs). On any W7 failure a full-page screenshot is
written next to the session transcript the harness already preserves, so the
uploaded artifact carries the rendered state.

### Budget

The capture script measures the same journey at well under 30 s after the
Workbench is ready. `harness-verify` runs ~12 min of its 30-min budget;
Chromium install is 1–2 min cold. The activation test's own
`ACTIVATION_TIMEOUT_MS` (20 min) needs no change; W7's per-step waits are the
helpers' own (60–120 s).

## Out of scope (step 2)

The gated journey ("Trigger a permission prompt" → `Allow once` → completion),
the memory panel (`aria-label="Memory candidates"`), and plan/subagent card
assertions. Those are the spec's original list and may justify a `test-ids`
contract; step 1 lands and is measured first because of the CI merge treadmill.

## Testing the gate itself

- The existing `docs/brand/demo/demo.test.mjs` unit tests keep covering the
  helpers with a fake `chromium`; no duplication.
- A local run of the framework lane with Chromium installed is the acceptance
  check; a second run with a deliberately wrong prompt must fail at step 7
  (thread rail) to prove the assertions bind.
- Mutation to prove fail-closed: run once with the Chromium cache path pointed
  at an empty directory and confirm W7 fails rather than skips.

## Risks

- **Type coverage.** The test is TypeScript and the helpers are untyped `.mjs`;
  neither the root nor `test/tsconfig.json` sets `allowJs` (verified). A
  minimal `capture.d.mts` beside the script declaring the four helpers is
  therefore part of step 1, and `pnpm typecheck` is the first gate the plan runs.
- **Chromium on CI.** `--with-deps` on `ubuntu-latest` is the same call the
  inspector and examples lanes already make.
- **Flake surface.** One browser, one page, no video, no parallelism, waits
  bounded by the helpers. The lane has no retries, deliberately: a retry would
  re-run against a thread already persisted by the first attempt.
