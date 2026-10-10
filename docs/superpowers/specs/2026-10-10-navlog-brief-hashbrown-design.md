# Navlog planning brief as structured UI (hashbrown)

Date: 2026-10-10
Scope: `@b4run/ag-ui` (`B4HttpAgent`), `examples/navlog` (server prompt + eval,
web client) and its scaffold template twin.
Builds on: #1006, #1008, #1009, #1010 (merged)

## Goal

The agent answers with structured data instead of markdown, and the web client
renders it as components — in the chat and in the sheet's Brief tab — using
hashbrown's UI kit. "Watch for", key numbers and assumptions become real
components; the brief gains a route summary and per-claim citations.

Out of scope: replacing the CopilotKit chat with hashbrown's own chat;
re-recording the demo video; manual waypoint entry (a later sub-project).

## Decisions

| Question | Decision |
|---|---|
| Structured or parsed markdown | Structured: the final assistant message is JSON matching a schema. |
| Client integration | Keep CopilotKit + the activity kit; add hashbrown's UI kit (`useUiKit`, `useJsonParser`) to render the answer. |
| Server support | Already there: B4's AG-UI endpoint binds `hashbrown.responseSchema` on the root model (OpenAI strict structured output). |
| Framework change | `B4HttpAgent` gains a `responseSchema` option (it runs in the Next server route, so it must put `hashbrown` on the run body). |
| Delivery | Two PRs: B4 (`B4HttpAgent.responseSchema`), then navlog (kit, rendering, prompt, eval, fixture). |

## 1. Components

Each is a React component with typed props exposed to the model through
hashbrown:

| Component | Props | Renders as |
|---|---|---|
| `BottomLine` | `level: "GO" \| "CAUTION" \| "NO-GO"`, `reason`, `cite?: string[]` | verdict pill + one sentence, first and loudest |
| `RouteSummary` | `from`, `to`, `via: string[]`, `altitudeFt`, `departureUtc` | airport chips with arrows; altitude and departure in mono |
| `WatchFor` | `items: { what, when?, severity: "info" \| "caution" \| "danger", cite? }[]` | rows with a severity dot, time in mono; empty → "Nothing during the flight" |
| `KeyNumbers` | `items: { label, value, unit?, cite? }[]` | compact figure grid |
| `Assumptions` | `items: { statement, origin: "pilot" \| "memory" \| "default" }[]` | rows tagged with their origin; each has a "Change" action |
| `Citations` | `items: { id, source, locator }[]` | numbered sources (`poh/cruise-performance.md · Figure 5-7`, `METAR KRST 1353Z`) |
| `Prose` | `markdown` | questions, short replies ("Filed."), anything else |

- Citations are referenced by id (`cite: ["c1"]`) and render as superscript
  markers that link to the `Citations` list in the same answer.
- `RouteSummary` carries only what the agent chose; distance and ETE come from
  the computed navlog's totals, never repeated by the agent.
- A planning answer: `BottomLine`, `RouteSummary`, `WatchFor`, `KeyNumbers`,
  `Assumptions`, `Citations`, optional closing `Prose`. Any other answer:
  `Prose` alone.
- Styling follows the app's design rules (no uppercase, no shadows, cobalt only
  for links/focus/selection; status colours as labelled data).

## 2. Data flow

1. **One kit definition** in `examples/navlog/web/app/brief/`: the components
   and their hashbrown prop schemas. The server route derives the JSON schema
   from it; the browser builds the UI kit from it.
2. **`B4HttpAgent({ responseSchema })`** (`@b4run/ag-ui/client`): when set,
   every run body carries `hashbrown: { ui: true, responseSchema }`. The navlog
   CopilotKit runtime route constructs its agent with the brief schema. Tests,
   an AG-UI docs entry, and a patch changeset.
3. **Server**: unchanged; the schema is bound on the root model, tool-calling
   turns unaffected.
4. **Chat**: NavlogChat's assistant-message slot parses the message with
   `useJsonParser` while it streams and renders with `uiKit.render`. A message
   that is not JSON (a thread from before this change) falls back to the
   existing markdown renderer. Activity steps (plan, subagents, approvals) are
   untouched.
5. **Sheet**: the Brief tab renders the same answer (`navlogAnswerText` finds
   the turn that produced the navlog) with the same kit, under the computed
   verdict card. The verdict floor reads `BottomLine.level` instead of parsing
   "Bottom line:" text (keeping the text parse as the fallback for old threads).
6. **Interactions**: an assumption's "Change" fills the composer with
   "Actually, " + the statement; a citation marker scrolls to and highlights
   its entry.
7. **Prompt**: the navlog route's system prompt describes the components (what
   goes where, when to answer with `Prose` alone, how to number citations);
   hashbrown's schema descriptions repeat each component's purpose.

## 3. Testing, evals, fixtures, delivery

- `B4HttpAgent`: the body carries `hashbrown` only when `responseSchema` is set;
  a conformance test against the server's reader (`readResponseFormat`).
- Kit: each component renders from typed props; the derived schema is
  OpenAI-strict-valid (`additionalProperties: false`, all properties required)
  — pinned by a test.
- Chat: progressive render of a streamed JSON answer; markdown fallback; "Change"
  fills the composer; citation markers resolve.
- Sheet: Brief renders the kit; the verdict floor reads `BottomLine.level`.
- Eval: `navlog-quality.eval.ts` passes the brief schema as `responseSchema` and
  asserts on the parsed answer (BottomLine first with a level; KeyNumbers has
  ETE, fuel burned, reserve; Assumptions non-empty; at least one POH citation).
  Its recorded replies are re-recorded against the real model.
- Harness and demo: existing plain-text fixtures keep passing through the
  markdown fallback; W8 gains one structured plan reply so the scaffolded app
  exercises the kit in Chromium (axe included). Demo re-record stays a
  follow-up.
- Template: mirror; add `@hashbrownai/react` and `@hashbrownai/core` (0.7) to
  the template's dependencies; lockfile.
- PR 1 (B4) then PR 2 (navlog, consuming PR 1 via `workspace:*`).
