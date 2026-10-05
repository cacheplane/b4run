# B4.run activity components: one turn, told in plain language

Status: design approved in brainstorming on 2026-10-03. Builds on
`2026-08-10-ag-ui-plan-subagent-activities-design.md`,
the 2026-08-19 activity design-system spec and
`2026-10-02-ag-ui-1-0-outbound-richness-design.md` (#914, merged
`0b332062b`: `SUBAGENT_*` + `subagentRunId` attribution, `b4.subagent`
removed). Reference mockups:
`docs/superpowers/specs/assets/2026-10-03-b4-activity-components/`.

This spec covers the shared design for every host and details sub-projects 1
and 2. Sub-projects 3 and 4 get their own specs that cite this one.

## 1. Decisions

Accepted during brainstorming; implementation does not relitigate them.

1. **Scope: the full chat-surface kit.** B4 renders everything an agent does
   during a turn: reasoning, tool calls, the plan, subagents and approvals.
   The host keeps the message list, the assistant's final markdown, the
   composer and the message toolbar.
2. **Direction B: one activity summary per turn, steps in plain language.**
   A turn's work folds under one summary line ("Worked for 1m 12s · 9 steps ·
   3 sources"). Each step is a sentence ("Searched the corpus for …"), not a
   function name. Approvals are a standalone card after the activity.
   Direction A (one trace row per tool call) and C (the plan as a timeline)
   were rejected.
3. **Layered for every host.** A framework-free view core, React components,
   Angular components, and thin connectors for each chat host. One stylesheet
   and one DOM contract serve React and Angular.
4. **B4 owns the components now.** threadplane (Angular today, React later)
   adopts them later through connectors. B4 code never references threadplane
   names (`--tplane-*`, class names, packages); it matches threadplane by
   using the same values.
5. **Theme API: keep `--b4-activity-*`.** Defaults are threadplane's values.
   New variables are added under the same prefix.
6. **Angular is a separate package** (`@b4run/ag-ui-angular`). Angular
   libraries need Angular's compiler. Keeping it out of `@b4run/ag-ui`
   keeps that package's build plain `tsc`.
7. **First host connector: CopilotKit (React).** CopilotKit Angular and
   threadplane follow in sub-projects 3 and 4. assistant-ui is a design-only
   sketch (§6.4) that keeps component APIs host-neutral.
8. **Step labels are computed on the server and overridable on the client.**
   Tools export a `display` description. B4 sends a `b4.step` custom event per
   tool call. Apps can override labels per tool in the connector.
9. **threadplane guidance is the default for anything not decided here.**
   threadplane's chat follows a ChatGPT-like model: AI as plain text, the
   human in a bubble, activity muted and secondary to the answer.
10. **No product names in code, comments, commits or public docs** (the
    threadplane rule). They appear only in spec files like this one.

## 2. What a turn looks like

Five states of one research turn. The mockup file
`direction-b-lifecycle.html` in the assets folder shows each.

1. **Working.** The summary line names the current step with a soft shimmer
   and the elapsed time ("Searching the corpus · 12s"). The activity is open.
   Finished steps read in the past tense; the active step reads in the
   present tense and is darker.
2. **Needs approval.** The summary reads "Waiting for your approval". A
   paused subagent shows "researcher · paused". The approval card sits after
   the activity.
3. **Done, collapsed.** The activity folds to "Worked for 1m 12s · 9 steps ·
   3 sources". The answer is the focus.
4. **Done, expanded.** One sentence per step. Repeated calls merge ("Searched
   the corpus 2 times"). A subagent folds to one line ("researcher finished ·
   5 steps"). A decided call records its decision ("allowed once"). Every step
   opens to its inputs and output.
5. **Something failed.** The failing step turns red, opens itself, and says
   whether the run continued ("the agent continued with the remaining
   sources") or stopped. The summary adds "· 1 failed".

## 3. Component catalog

Every component exists in React (`@b4run/ag-ui/react`) and Angular
(`@b4run/ag-ui-angular`), takes plain props built by the view core (§6),
and renders the DOM contract in §5.6.

| Component | Renders | States |
|---|---|---|
| `TurnActivity` | The summary line plus the step list for one turn (or one subagent run, nested). | working · awaiting · done · failed · stopped |
| `Step` | Icon, sentence, optional meta ("· 4 of 4 done"), optional source chips. Clicking opens `StepDetail`. | pending · running · done · failed · awaiting |
| `StepGroup` | Consecutive calls of the same tool, merged: "Searched the corpus 2 times". Opens to the individual steps. | same as `Step`, worst state wins |
| `StepDetail` | The step's **Inputs** and **Output** (pretty JSON or text), capped at 250px with scroll. | — |
| `PlanStep` | "Made a plan · 2 of 4 done" with an SVG checklist. Updates in place. | running only while the run is active; settles when it ends |
| `ReasoningStep` | "Thinking…", "Thought for 4s", "Show reasoning" (no duration). Opens to the reasoning text. | streaming · done · encrypted (not openable) |
| `SubagentStep` | "Asked researcher to <task description>" with the child's own `TurnActivity` nested in a soft grey block. Folds to "researcher finished · 5 steps". Replaces the `task` tool call that started it. | running · paused · done · failed |
| `ApprovalCard` | "<agent> wants to <label>", the reason, the payload, buttons, the scope line. | awaiting · deciding · failed-to-send |
| `SourceChips` | File or URL chips from a step's `sources`, "+N" overflow. | — |

Building blocks also exported for custom steps: `Disclosure`, `StepIcon`,
`StatusText`, `Checklist`. These replace the Aug-19 spec's `components` and
`classNames` slots, which are removed.

### 3.1 Behavior rules

- **Open and closed.** `TurnActivity` is open while working or awaiting, and
  folds when the turn settles. Tool steps start closed; the plan, a
  streaming reasoning span and a running subagent are open while live. A
  failed step opens itself. A manual toggle wins until that item becomes live again. Restored
  turns start folded. Nothing closes while the user has it open to read
  (reasoning in particular).
- **Summary line.** While working it shows the active step's running label;
  with several active steps, the most recently started. Elapsed time ticks
  once a second. When done: "Worked for {d} · {n} steps", plus "· {m}
  sources" when any step reported sources, plus "· {k} failed" when any
  failed. A cancelled turn reads "Stopped after {d}". Durations use `<1s`,
  `Ns`, `Nm Ms` (threadplane's format), and never claim `<1s` for an unknown
  duration.
- **Merging.** Only consecutive calls of the same tool merge, and only when
  done. The merged label comes from the client's label table for built-in tools or
  the connector's `labels` overrides (§4), else "Used {tool} {n} times". `writeTodos` and `task` never merge.
- **No spinner flash.** A step that settles within 300 ms never shows its
  running treatment.
- **Hidden tools.** `writeTodos` renders as `PlanStep`, and `task` as
  `SubagentStep`, so their raw tool calls are hidden. Apps can hide more with
  `hiddenTools`.
- **Per-tool views.** `renderStep: { [tool]: Component }` replaces a step's
  `StepDetail` with an app view (for example a table instead of JSON). The
  sentence line stays.

### 3.2 Approval card

- Placement: after the turn's activity, one card per pending interrupt, in
  pending order. The gated step shows as awaiting in the activity, and every
  subagent above it shows as paused.
- Text: "{agent} wants to {running label}". The agent is "The agent" for the
  root run and the subagent's name otherwise. The reason comes from the
  interrupt (e.g. "It isn't on this app's allow-list."). The payload is
  `detail.argsPreview` or the command.
- Buttons on one row: **Allow once** (primary), **Always allow**
  (secondary), **Deny** (text, right-aligned). Labels never wrap.
- Scope line under the buttons, built from the interrupt's
  `detail.suggestedPattern` and kind: "“Always allow” applies to this exact
  command, for this app", "… to every call of deployProd …", or "… in this
  conversation only" for per-thread grants. When the gate does not offer
  `always` (B4 never offers it for some gates), the button and scope line are
  absent.
- `role="alert"` when it appears; focus does not move. After a decision the
  card unmounts, and the step's sentence gains "· allowed once", "· always
  allowed" or "· denied".
- Denial resumes with `status: "cancelled"`, the protocol's own denial
  (unchanged from today).

## 4. Step labels: `display` on tools

Tools are files with named exports (`description`, `returnDirect`, …). A
new optional named export describes how a call reads to a person:

```ts
// src/tools/searchCorpus.ts
export const display = {
  icon: "search",
  running: (args: { query: string }) => `Searching the corpus for “${args.query}”`,
  done: (args: { query: string }) => `Searched the corpus for “${args.query}”`,
  sources: (result: Array<{ path: string }>) => result.map((r) => ({ title: r.path })),
} satisfies ToolDisplay
```

- `icon` is one of a fixed set: `search`, `read`, `write`, `run`, `web`,
  `memory`, `plan`, `agent`, `think`, `tool` (default). Icons ship as inline
  SVG; apps can swap the set.
- Every field is optional. The fallbacks are "Using {tool}…", "Used
  {tool}" and no sources. Grouped-step labels ("Searched the corpus 2 times")
  are a client concern: the view core's label table for built-in tools, plus
  the connector's `labels` overrides.
- Labels are plain text, never HTML. A label longer than 120 characters is
  truncated with "…". A label function that throws falls back to the default;
  the server logs once per tool, the pure view core stays silent and the
  connector or component layer owns any warning.
- Built-in tools ship labels: `readFile`, `writeFile`, `editFile`,
  `listDir`, `runBash`, `recall`, `remember`, `task`, `writeTodos`, plus the
  capability tools.
- `ToolDisplay` is exported from `@b4run/sdk`. `b4 check` validates the
  export's shape; this needs its own shape validation, because B4 config and
  tool exports have no runtime schema.

### 4.1 The `b4.step` event

For every tool call, the server evaluates the labels and emits an AG-UI
`CUSTOM` event named `b4.step`:

```ts
{ type: "CUSTOM", name: "b4.step", value: {
  toolCallId, status: "running" | "completed" | "failed", icon?, label?, sources?
} }
```

- `running` goes out as the call starts (before `TOOL_CALL_RESULT`), with
  `icon` and the running `label`; `completed` goes out as the call returns, just before the result, with the done `label` and `sources`; `failed` follows an error result, for every
  tool, display or not. A subagent's step carries `subagentRunId`.
- Every tool's done payload, with timing and the gate decision, is stored on the
  checkpointed `ToolMessage` as `additional_kwargs.b4_step` (the `task` tool's
  message also carries `b4_subagent`); `GET /threads/:id/turns` rebuilds a restored
  thread from it (`2026-10-05-activity-restore-from-storage-design.md`). (The
  tool-call record is opt-in and pruned, so it is not the durable home.)
- B4.run's vendor events share the `b4.` prefix (`b4.step`,
  `b4.content_parts_dropped`); a client that doesn't know a name ignores it.
- Grouped-step labels are computed on the client (see §4's fallbacks).

**Client override.** The connector accepts `labels: { [tool]: StepLabelOverride }`
(`running(args)`, `done(args, result)`, `group(count)`, `icon`). Client fields
win over server fields for that tool: `stepLabel` tries the override first,
then the server's `b4.step` label, then the "Using X…"/"Used X" fallback.
This is how an app rewords or localizes a label a built-in tool ships with.
The decision shown on a decided call ("· allowed once", "· denied") comes
from the connector that sent the resume, not from `TurnsView`: the reducer
clears the approval when the turn resumes.

## 5. Visual spec

Values are threadplane's, under B4 names. No threadplane names appear in B4.

### 5.1 Variables (`--b4-activity-*`)

| Variable | Light | Dark |
|---|---|---|
| `surface` | `#fff` | `rgb(17 17 17)` |
| `surface-alt` (new) | `rgb(249 249 249)` | `rgb(44 44 44)` |
| `border` | `rgb(229 229 229)` | `rgb(45 45 45)` |
| `text` | `rgb(28 28 28)` | `rgb(245 245 245)` |
| `muted` | `rgb(115 115 115)` | `rgb(160 160 160)` |
| `running` / `running-bg` (new) | `#b45309` / `#fffbeb` | `#fbbf24` / `rgb(45 35 21)` |
| `complete` | `#15803d` | `#4ade80` |
| `failed` / `failed-bg` (new) | `#b91c1c` / `#fef2f2` | `#fca5a5` / `rgb(45 21 21)` |
| `primary` / `on-primary` (new) | `rgb(28 28 28)` / `#fff` | `#fff` / `rgb(28 28 28)` |
| `radius` / `radius-card` (new) / `radius-pill` (new) | `8px` / `16px` / `9999px` | same |
| `font-mono` (new) | `ui-monospace, SFMono-Regular, Menlo, monospace` | same |

`complete` is darker than threadplane's `#16a34a`, which is about 3.3:1 on
white and fails 4.5:1 for small text. `#16a34a` stays acceptable for icons
(3:1).

### 5.2 Type and spacing

- Step sentences 14px, line height 1.5. Meta, chips and code 12–12.5px.
  Summary line 14px muted. The approval title 14.5px, weight 500.
- Fonts inherit from the host; B4 sets only the mono stack.
- 4px grid. The step list hangs off a 1px left rule (margin-left 5px,
  padding-left 18px). Steps are 26px minimum height, 5px vertical padding.
  Icons are 16px, `currentColor`, 1.3 stroke.
- The nested subagent block: `surface-alt`, 12px radius, 8px/12px padding.
- The approval card: 1px border, `radius-card`, 14px/16px padding, a
  hairline shadow `0 1px 3px rgb(0 0 0 / 5%)`. Payload in mono on
  `surface-alt` with 10px radius. Buttons are pills, 6px/15px padding, 13px,
  weight 500.

### 5.3 Theme

Dark follows the host, not the OS: `.dark` or `[data-theme="dark"]` on an
ancestor. `data-b4-theme="light" | "dark" | "auto"` overrides, and `auto`
follows `prefers-color-scheme`. The attribute goes on the root element
(`:root`) or, for `.dark`/`[data-theme="dark"]`, on the element that carries
that class or attribute. Fixes the failure where an OS in dark mode
painted near-white text on a light chat.

### 5.4 Motion

- Running summary text: a 2.2s linear shimmer. Chevron rotation 200ms.
- Open and close mount instantly; no height animation.
- `prefers-reduced-motion`: no shimmer (the text turns solid and darker), no
  rotation transition, no looping animation. Correctness never depends on
  an animation ending.

### 5.5 Accessibility

- Every disclosure is a `<button aria-expanded>`, at least 24px tall (WCAG
  2.2 AA target size), with a visible focus ring.
- Status is never conveyed by color alone: icons differ by shape, and every
  state has text.
- One visually hidden `role="status"` region per turn carries the summary
  line, updated only when the step changes (not every second). The approval
  card uses `role="alert"`. Focus never moves on its own.
- Icons are `aria-hidden`; chips are a list with an accessible name.

### 5.6 DOM contract

Both frameworks render the same classes and attributes; the stylesheet and
the tests target only these:

```
section.b4-turn[data-state=working|awaiting|done|failed|stopped][data-expanded]
  button.b4-turn__summary[aria-expanded] > .b4-chevron .b4-turn__text[data-live] .b4-turn__time
  ol.b4-turn__steps
    li.b4-step[data-state=pending|running|done|failed|awaiting][data-kind=tool|plan|reasoning|subagent|group]
      button.b4-step__line[aria-expanded]  > .b4-step__icon .b4-step__text .b4-step__meta .b4-chevron
      span.b4-step__line.b4-step__line--static   (encrypted reasoning; not a button)
      .b4-step__detail > .b4-step__detail-label  .b4-step__code | .b4-step__detail-empty
      .b4-step__reasoning | .b4-step__children | .b4-step__sources
        .b4-chip  .b4-chip--more
      .b4-checklist > .b4-checklist__item[data-status] > .b4-checklist__box .b4-checklist__text
.b4-approval[data-state=awaiting|deciding|failed]
  .b4-approval__title .b4-approval__reason .b4-approval__payload
  .b4-approval__actions > .b4-approval__button--primary .b4-approval__button--secondary .b4-approval__button--text
  .b4-approval__scope  .b4-approval__error
.b4-visually-hidden[role=status]
```

The stylesheet ships as `@b4run/ag-ui/react/styles.css` and is shared by the
Angular package. All rules sit in `@layer b4-activity`, so app CSS always
wins without specificity games.

## 6. Architecture and data flow

| Layer | Entry | Depends on |
|---|---|---|
| Protocol | `@b4run/ag-ui` | `@ag-ui/core` |
| View core | `@b4run/ag-ui/view` (new) | protocol only; no React, no Angular |
| React components | `@b4run/ag-ui/react` | view core, React |
| Angular components | `@b4run/ag-ui-angular` (new package) | view core, Angular |
| CopilotKit React connector | `@b4run/ag-ui/copilotkit` (new) | view core, React components, `@copilotkit/react-core` |
| CopilotKit Angular connector | `@b4run/ag-ui-angular/copilotkit` | view core, Angular components, `@copilotkit/angular` |
| threadplane connector | `@b4run/ag-ui-angular/threadplane` | view core, Angular components |

`./react` no longer depends on CopilotKit. `b4ActivityRenderers` and the
renderers move to `./copilotkit`.

### 6.1 View core

`reduceTurns(state, event) → TurnsView` is a pure reducer over AG-UI events
and absorbs `reduceSubagentRuns` (#914). Same events in, same view out,
whether live, replayed or restored. It owns:

- turn boundaries and timing (start, active step, elapsed, settled),
- steps from `TOOL_CALL_*`, merged with `b4.step` labels and client
  overrides,
- plan from `b4.plan` activity snapshots, per owner (root or subagent),
- reasoning from `REASONING_*`, with step merging,
- subagents from `SUBAGENT_*` and `subagentRunId`, attached to their `task`
  call by `parentToolCallId`, nested via `parentSubagentRunId`,
- approvals: each `Interrupt` attaches to its step by `toolCallId`
  (AG-UI 1.0 `Interrupt.toolCallId`, filled by `toAguiInterrupt`), with the
  paused state propagated to every ancestor subagent,
- merging through `groupSteps`; the 300 ms spinner threshold and open/closed
  defaults are component state in the React and Angular kits, not view state,
- tool output: renders `TOOL_CALL_RESULT.content` as-is (sub-project 1 made
  the clean content the wire contract, so there is no unwrapping branch).

### 6.2 CopilotKit (React) connector

- `<B4Activity agentId? labels? hiddenTools? renderStep? renderInChat? />`
  hides CopilotKit's generic tool rows with a wildcard `useRenderTool`,
  registers `useInterrupt` (in-chat by default; `renderInChat={false}`
  renders the cards after its children for a host with its own transcript),
  and provides the turns to `useB4ChatSlots`. It does not register the plan
  activity renderer: the plan renders as `PlanStep` inside `TurnActivity`,
  and registering it would show the plan twice.
- `useB4ChatSlots()` returns props spread onto `<CopilotChat>`:
  - `messageView.transformMessages` merges a turn's consecutive
    tool-call-only assistant messages into one, so one `TurnActivity`
    renders per turn,
  - `assistantMessage.toolCallsView` renders `TurnActivity` for that message,
  - `toolbarVisible` is false for messages with no text.
- Every open interrupt must be answered before CopilotKit resumes. Each
  card resolves its own interrupt id independently; nothing waits for all of
  them together.
- Pending interrupts after a reload: CopilotKit restores them from the replayed
  `RUN_FINISHED`; a host with its own transcript reads `GET /threads/:id/turns`,
  which embeds them.

### 6.3 Protocol changes in `@b4run/ag-ui`

1. `TOOL_CALL_RESULT.content` carries the tool's actual output, not the
   serialized `ToolMessage`.
2. The `b4.step` custom event (§4.1).
3. `toAguiInterrupt` always sets `toolCallId` when the gate has one, and
   carries the scope inputs for §3.2 (`suggestedPattern`, kind, whether
   `always` is offered).

### 6.4 assistant-ui sketch (not built)

Kept to check that component APIs don't assume CopilotKit:
`makeAssistantToolUI` / the tool fallback renders `Step` from the same view
core; a message-part component renders `TurnActivity`; the approval card
renders from the runtime's interrupt state via `@assistant-ui/react-ag-ui`.
No code ships.

## 7. Error handling

| Situation | Behavior |
|---|---|
| Malformed `b4.plan` or `b4.step` payload | That piece is dropped; the step falls back to default labels; the connector may warn in dev mode, the view core never logs. |
| Unparseable args or output | Raw text in `StepDetail`; never a crash. |
| Label function throws (server) | Default label; logged once per tool. |
| Interrupt without `toolCallId` | The card still renders; the activity shows "Waiting for your approval" without marking a step. |
| Stream ends with work open | Running steps → failed ("didn't finish"); subagents → failed with `cancelled` or `unterminated`; plan settles; summary "Stopped after {d}". |
| Stream ends with calls handed to the client | A `RUN_FINISHED` that lists `pendingToolCallIds` leaves those steps as they are: the client still owes their results, so they are not abandoned work. |
| A resumed run after an approval | The same turn continues (Working → Needs approval → Working → Done): approvals clear, paused steps and subagents resume. The wire carries no resume signal; the reducer treats a same-thread run over an awaiting turn as a resume, backed by the server's `409 resume_required` policy, and a connector that knows better passes `resuming`. |
| Decision fails to send | The card stays, buttons re-enable, inline error text. |

## 8. Testing

- **Protocol:** translator tests for the clean result, `b4.step` emission
  and ordering, label fallbacks and throwing labels, interrupt scope fields.
  The existing AG-UI 1.0 conformance gate stays green; `b4.step` passes its
  `CUSTOM` verification.
- **View core:** a recorded research run (fixture) reduced to a snapshot;
  live, replay and restore of the same events produce identical views;
  ordering tests for merges, nested subagents, multiple interrupts and
  cancel mid-subagent.
- **Components:** every component in every state, light and dark, asserted
  against the DOM contract (§5.6). React and Angular run the same fixtures:
  that is the parity test.
- **Accessibility:** axe in component tests; a Playwright keyboard pass
  (toggle, approve, deny) in the research example.
- **Hosts:** Playwright drives one recorded run through each host and
  compares the contract DOM, not pixels.

## 9. Rollout

Each sub-project is its own plan and PRs. Changesets are `patch` (0.x fixed
group).

1. **Protocol + view core.** §6.3, `ToolDisplay` + `b4.step` + built-in
   labels, `@b4run/ag-ui/view` with `reduceTurns`, the CopilotKit spike.
   Docs: the tools page (`display`), the AG-UI page (`b4.step`).
2. **React kit + CopilotKit React.** The components, `./copilotkit`,
   `@layer b4-activity`, and the research example plus its scaffold template
   adopting them (byte-for-byte). Breaking: `./react` exports and the removed
   `classNames`/`components` slots, with an upgrading entry.
3. **Angular kit + CopilotKit Angular.** New `@b4run/ag-ui-angular`
   (ng-packagr), joining the release train: pins, inventory, pack checks, a
   CI lane.
4. **threadplane.** Upstream in `~/repos/angular-agent-framework`: an
   activity-renderer slot and a slot replacing the tool-call region; the
   threadplane connector; dogfooding the research backend in threadplane's
   `<chat>`. Upstream reports: the reduced-motion selector bug
   (`.tplane-chat-typing-dot` vs `.chat-typing__dot`), the missing
   `aria-expanded` on the tool-call group header, success-green contrast,
   and sub-24px disclosure targets.

## 10. Deferred

- Edit and respond actions on approvals: needs B4 protocol support beyond
  once/always/deny.
- Editing the plan before a run starts.
- Grouping steps by plan item (direction C's timeline).
- assistant-ui connector code (§6.4 is design only).
- Reasoning step counts ("Thought for 9s · 3 steps", "3 steps"): they need a
  per-span step count the view does not carry.
- The decided-call suffix ("· allowed once", "· always allowed", "· denied")
  on the gated step's sentence: the reducer clears the approval on resume;
  the connector that sent the decision will annotate the step in
  sub-project 2b.
