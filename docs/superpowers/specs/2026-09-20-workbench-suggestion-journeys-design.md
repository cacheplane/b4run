# Workbench suggestion journeys (SP4, step 2)

**Status:** design, 2026-09-20. Extends the step 1 gate
(`2026-09-19-workbench-browser-gate-design.md`, merged as `3a26d1a2`, PR #750)
to the three suggestions the Workbench's empty state offers — the full list the
Workbench arc originally named for SP4: "click a suggestion, watch the plan
fill, the subagent run, the permission gate fire, approve, see memory
candidates."

## Problem

Step 1 proves the scaffolded Workbench renders, sends, streams, settles,
persists, and restores — for one plain prompt. It does not exercise the three
surfaces a new user meets first by clicking the suggestions: the plan and
subagent activity cards, the permission gate with its `Allow once` resolution,
and the memory panel. Those are exactly the surfaces the earlier arcs shipped
(logical-identity resume, drop-in activity renderers, memory candidates) and the
ones a CopilotKit or template bump is most likely to break silently.

## What already exists and is reused

- **Two of the three suggestions send prompts the harness already scripts
  byte-for-byte**, and aimock fixtures are static and reusable:
  - "Research a topic" → `SAFE_PROMPT`: root fixture of 7 model turns
    (`recall`, `writeTodos`, `task` → researcher subagent, `searchCorpus`,
    `readDoc`, `writeFile`, reply) plus the researcher's 3 (`searchCorpus`,
    `readDoc`, reply). **10 turns.** `writeTodos` is called once with statuses
    completed / in_progress / pending / pending, so the plan card's final state
    is `1/4 complete`.
  - "Trigger a permission prompt" → `GATED_PROMPT`: `runBash` gate, then on
    resume the reply `Fetched external context after approval.` **2 turns.**
- The suggestion buttons are `<button>`s whose accessible name is the title
  followed by the message (`EmptyState.tsx`), so `getByRole("button", { name:
  /^Research a topic/ })` locates each.
- Packaged cards: the plan card's summary is `Plan · {completed}/{total}
  complete`; the subagent card's is `{name} · {status} · {n} tools` with a
  `Subagent tools` list (`packages/ag-ui/src/react/*ActivityCard.tsx`).
- A `runBash` permission renders the non-subagent branch of
  `PermissionPrompt.tsx`: a `role="alert"` card with `Allow once` /
  `Allow always` / `Deny`; `Allow once` resolves the interrupt with
  `payload: "once"` — the same resolution W5 performs over HTTP.
- Memory is `writes: "candidate"` in the template, so `remember(...)` creates
  a candidate the panel lists under `aria-label="Memory candidates"`, each row
  with the content and namespace and an `Approve` button whose `aria-label` is
  `Approve: <content, collapsed to 60 chars>`. The panel refetches after a
  decision.
- Step 1's helper module, its injected-browser test seam, its console-error
  allowlist, abort wiring, prompt-shape guard, and screenshot/cause-chain
  plumbing.

## Design

### Where it runs

**W8**, immediately after W7 in the same `dev:web` session and the same browser
context (one Chromium launch for both). A new exported helper
`runWorkbenchSuggestionJourneys(options, deps)` in
`test/harness/workbench-browser.ts` runs the three journeys in order; each
starts from `New conversation`, so each is its own thread and its own exact
journal delta. Same fail-closed rules as W7: no skip path, console errors fail
(with the step 1 allowlist), abort honoured, screenshot on failure, and the
thrown error names the journey.

### Journey 1 — Research a topic (delta 10)

1. Click `New conversation`; click the suggestion button `/^Research a topic/`.
2. Wait for completion (`waitForWorkbenchRunCompletion`).
3. Assert visible in `main`: a `Plan` card whose summary contains
   `1/4 complete` (that card stays expanded — `open={hasActiveTodo}` and the
   fixture leaves one todo `in_progress`); a subagent card whose summary
   contains `researcher · completed · 2 tools`. **The subagent card collapses
   when its subagent finishes** (`open={content.status === "running"}`), so its
   tools list is in the DOM but not visible: click the card's `<summary>` to
   expand it — a real user action, and the only way to see the list — then
   assert `searchCorpus` and `readDoc` under `Subagent tools`. Then a
   `writeFile` tool card; and the root reply
   `I wrote a short report covering ReAct and plan-and-execute architectures.
   [corpus/agent-architectures.md]`.
4. Assert the aimock journal grew by exactly 10.

### Journey 2 — Trigger a permission prompt (delta 2)

1. `New conversation`; click `/^Trigger a permission prompt/`.
2. Wait for a `role="alert"` card containing the fetch command
   (`node scripts/fetch-source.mjs quantum computing`). While it is up, `Send`
   is blocked (the composer explains the outstanding approval — asserted by
   the existing Composer unit tests; here we assert only the card).
3. Click `Allow once`. Assert the alert card is gone, the run completes, and
   `Fetched external context after approval.` is visible.
4. Assert the journal grew by exactly 2 (the gated turn and the resumed turn).

### Journey 3 — Teach it a preference (delta 2, new fixture)

New fixture, registered after the browser fixture and covered by the step 1
collision guard:

```
.user("Remember that I prefer concise, cited reports.")
.callsTool("remember", {
  data: { subject: "user", predicate: "prefers", value: "concise, cited reports" },
  content: "User prefers concise, cited reports.",
})
.replies("Noted — I'll keep reports concise and cited.")
```

1. `New conversation`; click `/^Teach it a preference/`; wait for completion.
2. Assert the memory panel (`aria-label="Memory candidates"`) lists a row with
   `User prefers concise, cited reports.`
3. Click `Approve: User prefers concise, cited reports.` (button by accessible
   name). Assert the row leaves the list, and `GET /api/b4/memory/candidates`
   from the page origin returns 200 with no candidate carrying that content.
4. Assert the journal grew by exactly 2 (the `remember` turn and the reply).

### Failure behaviour

Unchanged from step 1, plus: the error message is prefixed with the journey
name (`Research a topic:` …), and the screenshot file name carries a journey
suffix (`workbench-browser-research.png`, `-gate.png`, `-teach.png`) so a
failure in journey 2 does not overwrite evidence of journey 1.

### Budget

Three runs against aimock ≈ 30–60 s on the lane. `harness-verify` measured
13.2 min of 30 after step 1.

## Out of scope

`Allow always` and `Deny` branches; subagent-approval gates; reloading these
threads (W7 proves restore once); visual assertions; the Reject decision.

## Testing the gate itself

- Unit tests with the fake browser: each journey's call ordering, the
  journey-named failure, and per-journey screenshot naming.
- Lane mutations, one per journey, each must exit 1 with the cause chain:
  assert `4/4 complete` (must fail — the fixture ends at 1/4); skip the
  `Allow once` click (the run must not complete within the completion wait);
  assert a wrong candidate content.

## Risks

- **Suggestion-button names include the message**, so a copy change to a
  suggestion title breaks the locator; the regex anchors on the title only.
- **Card summaries carry the `▸` marker in their `textContent`** (it is a real
  `aria-hidden` element, not generated content — the trap recorded when the
  ladder gaps were closed), so header assertions must be substring or regex
  matches, never `{ exact: true }`.
- **`Allow once` timing**: the card appears mid-stream; the wait is on the
  alert role, not on a fixed delay.
- **Per-wait timeouts must stay well inside the lane budget.** At 120 s a
  drifted locator is killed by the harness deadline instead of by Playwright,
  and the abort rejects outside the page body — losing the journey name, the
  call log naming the locator, and the screenshot (taken against a closed
  page). 45 s keeps Playwright's own timeout the one that wins.
- **`.last()` masks duplicate cards.** One fresh thread must render exactly one
  plan card and one `researcher` subagent card; duplicates are the regression
  the AG-UI suppression ledger fixed, so the journeys assert `toHaveCount(1)`
  rather than tolerating a second.
- **Approve and Reject are indistinguishable by removal alone** — both drop the
  row and both delete the candidate server-side — so the teach journey needs an
  assertion only the approve path satisfies.
- **Journal deltas are exact** (10/2/2). A StrictMode double-send or a
  suggestions-reload that hits the model would show up as a wrong count — that
  strictness is the point.
