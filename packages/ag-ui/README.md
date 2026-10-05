<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180" />
</p>

# @b4run/ag-ui

Supported AG-UI protocol translation for B4.run runtime streams, client inputs, interrupts, activities, and SSE responses.

**Use this when:** You are translating B4.run runs or activity snapshots for an AG-UI client.

## Install

```bash
pnpm add @b4run/ag-ui
```

Requires `@ag-ui/core` 1.0.1 and `@b4run/sdk` (the matching B4.run release, for the shared content-part types), both dependencies. `@ag-ui/client` `>=1.0.1 <2.0.0` is an optional peer.

## Example

```ts
import { fromRunAgentInput, toAguiEvents } from "@b4run/ag-ui"
import { agUiContentType, encodeAgUiEvent } from "@b4run/ag-ui/sse"

const b4Input = fromRunAgentInput(runAgentInput)
const accept = request.headers.accept

response.writeHead(200, { "content-type": agUiContentType(accept) })
for await (const event of toAguiEvents(b4Chunks, { threadId, runId })) {
  response.write(encodeAgUiEvent(event, accept))
}
```

`accept` selects the AG-UI HTTP binding: SSE unless the header admits `application/vnd.ag-ui.event+proto` with a positive quality (named, or through a wildcard such as `*/*`), then 4-byte big-endian length-prefixed protobuf frames. A client that cannot read protobuf names `text/event-stream`; `@ag-ui/client` and CopilotKit do.

Plan activity snapshots are translated on the root surface; use the focused API reference for their exact identifiers and payload contracts. Subagents are presented with AG-UI 1.0's `SUBAGENT_STARTED/FINISHED/ERROR` events, and everything a child does is emitted as the ordinary events for those things tagged with its `subagentRunId`.

Built-in planning is presented once. A `writeTodos` call whose plan activity was emitted produces no `TOOL_CALL_*` events, correlated by the model's tool-call id; every other tool, `task` included, is unchanged. The rule fails open, so the ordinary tool events are preserved whenever the activity cannot be produced. A client that registers no activity renderer therefore sees less for `writeTodos`: the activity snapshot is the canonical surface for it.

## Streamed tool-call arguments

A `tool_call_args` chunk with `data: { id, name, delta }` carries one fragment
of a root tool call's arguments ahead of its `tool_call` announce. The first
fragment for an id opens the call with `TOOL_CALL_START`; each non-empty
fragment is one `TOOL_CALL_ARGS` delta; the announce, which still carries the
complete input, emits whatever the deltas did not cover and then
`TOOL_CALL_END`. The deltas concatenate to exactly the single delta a
non-streamed call carries, so a client that appends them verbatim sees the same
argument JSON either way. A `tool_call` with no preceding fragments takes the
single-delta path unchanged. Run completion, interruption and errors end any
streamed call still open. The two orchestration tools never stream.

## Model message framing

Model tokens can include `messageId` alongside their string `data`. A
`message_end` chunk with `data: { messageId }` ends that source message. The
translator allocates an AG-UI message ID for each source and routes interleaved
content independently, including nested model calls inside concurrent tools.
An empty model produces no text message. Run completion, interruption, and errors
close any remaining open messages.

Anonymous tokens retain their implicit boundaries at tool events and run end.
The CLI carries identity through in-process chunks, NDJSON, and live-turn
snapshots. Raw Agent Protocol SSE retains its existing string `chunk` payload;
use AG-UI when consuming independently framed model messages.

Message identity does not deduplicate work repeated by graph checkpoint replay.
Complete generation in a separate tool step before an approval-gated operation
when the generated response must not repeat on resume.

## HTTP client

`@b4run/ag-ui/client` exports `B4HttpAgent`, an `@ag-ui/client` `HttpAgent`
whose `getCapabilities()` reads `GET /agui/{routeId}`, the route's AG-UI
capabilities, with the agent's own URL, headers and `fetch`. Register it
wherever you would register an `HttpAgent`; CopilotKit's runtime reports what it
returns from `/info`. It throws on a non-2xx answer. `@ag-ui/client` is an
optional peer dependency, needed only for this subpath.

```ts
import { B4HttpAgent } from "@b4run/ag-ui/client"

const agent = new B4HttpAgent({ url: "http://127.0.0.1:3001/agui/%2Fchat%23agent" })
```

## Activity components

`@b4run/ag-ui/react` is the React activity kit: `TurnActivity` renders one turn in plain language (the summary line and the step list, nested for subagents), `ApprovalCard` renders a parked interrupt, and the step rows (`Step`, `StepGroup`, `PlanStep`, `ReasoningStep`, `SubagentStep`) and building blocks (`Disclosure`, `StepIcon`, `StatusText`, `Checklist`) are exported for custom steps. Components take plain props built by `@b4run/ag-ui/view` (`reduceTurns`), and the entry has no CopilotKit dependency. In a CopilotKit chat, the connector below wires it up:

```tsx
import "@b4run/ag-ui/react/styles.css"
import { B4Activity, useB4ChatSlots } from "@b4run/ag-ui/copilotkit"
import { CopilotChat, CopilotKit } from "@copilotkit/react-core/v2"

function Chat() {
  return <CopilotChat {...useB4ChatSlots()} />
}

export default function Page() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit" useSingleEndpoint={false}>
      <B4Activity>
        <Chat />
      </B4Activity>
    </CopilotKit>
  )
}
```

## CopilotKit connector

`@b4run/ag-ui/copilotkit` is the only entry that imports `@copilotkit/react-core`; it needs a bundler (CopilotKit's bundle imports its own CSS), so import it from a bundled React app, not from Node or an edge runtime.

- `B4Activity` wraps your chat: it hides CopilotKit's generic tool rows, renders one `ApprovalCard` per parked interrupt, and keeps the thread's turns current from the agent's events; `labels`, `hiddenTools` and `renderStep` reword, hide or re-render steps per tool.
- `useB4ChatSlots()` returns the props to spread onto `<CopilotChat>`: one tool row per turn rendered as `TurnActivity`, no toolbar under tool-only rows.
- `useB4Turns()` is the agent's thread as turns (`reduceTurns`) plus `markResuming()` to call before sending a resume and `clearResuming()` to forget it when the resume request failed, for a host with its own transcript.

`b4ActivityRenderers` and `b4PlanActivityRenderer` moved here from `./react`.

## React renderers

Deprecated: the legacy cards and the `classNames`/`components` rungs go away once the navlog example adopts the kit. `b4ActivityRenderers` renders the legacy plan card from the plan activity snapshots. The drop-in is one prop:

```tsx
import { CopilotKit } from "@copilotkit/react-core/v2"
import { b4ActivityRenderers } from "@b4run/ag-ui/copilotkit"

<CopilotKit
  runtimeUrl="/api/copilotkit"
  useSingleEndpoint={false}
  renderActivityMessages={b4ActivityRenderers}
>
```

The legacy surfaces, each in layers from drop-in to build-your-own:

- Activities: `b4ActivityRenderers` (the plan renderer, ready to pass to CopilotKit's `renderActivityMessages`) and `b4PlanActivityRenderer` on its own, both from `@b4run/ag-ui/copilotkit`; and from `@b4run/ag-ui/react`, `PlanActivityCard` plus `ActivityChecklist` — plain React components taking `content` — with `planActivityContentSchema`, the strict validator behind the renderer, for presenting the plan another way.
- Subagents: `useSubagentRuns(agent)` subscribes to an `@ag-ui/client` agent (the one CopilotKit's `useAgent()` returns) and folds `SUBAGENT_STARTED/FINISHED/ERROR` plus every event tagged `subagentRunId` into a tree; `SubagentPanel` renders it nested; `reduceSubagentRuns` is the pure reducer behind the hook, for a non-React client.

```tsx
import { SubagentPanel, useSubagentRuns } from "@b4run/ag-ui/react"
import { useAgent } from "@copilotkit/react-core/v2"

function Subagents() {
  const { agent } = useAgent()
  const { runs } = useSubagentRuns(agent)
  return <SubagentPanel runs={runs} />
}
```

`react` and `@copilotkit/react-core` (`>=1.76.0`) are optional peer dependencies used only by the `./react` and `./copilotkit` subpaths; only `./copilotkit` imports CopilotKit. Importing the root or `./sse` entry never loads them, so a server-only consumer installs nothing extra. The floor tracks the wire protocol: 1.76.0 is the first `@copilotkit/react-core` whose bundled AG-UI client speaks 1.0, the protocol B4.run serves, and earlier releases resolve a pre-1.0 `@ag-ui/*` (0.0.59 on 1.70–1.75). pnpm warns on an unmet optional peer; npm 7+ rejects it with `ERESOLVE`.

### Customizing the activity cards

The kit and the legacy cards ship with B4.run's visual identity via an optional stylesheet (`@layer b4-activity`, so any unlayered app CSS wins), plus a four-rung customization ladder for the legacy cards. A card renders structured-but-unstyled markup if the stylesheet is not imported.

**Rung 1 — tokens.** Import the stylesheet once, then override its CSS custom properties in your own CSS to restyle without touching markup:

```ts
import "@b4run/ag-ui/react/styles.css"
```

```css
:root {
  --b4-activity-radius: 4px;
  --b4-activity-padding: 12px 14px;
}
```

Palette tokens are the one case worth care. Your `:root` block now wins in dark
mode too, so a single hard-coded colour applies to BOTH themes — pick values
that work in each, or scope them the way the sheet does, on the host's dark
selectors:

```css
:root {
  --b4-activity-running: #6d28d9;
}

.dark,
[data-theme="dark"],
:root[data-b4-theme="dark"] {
  --b4-activity-running: #a78bfa;
}
```

Dark does not follow the OS unless the root carries `data-b4-theme="auto"`; add a `prefers-color-scheme` block only if you set that.

The design tokens are `--b4-activity-` plus `surface`, `surface-alt`, `border`, `text`, `muted`, `running`, `running-bg`, `complete`, `failed`, `failed-bg`, `primary`, `on-primary`, `radius`, `radius-card`, `radius-pill`, and `font-mono`; the legacy geometry tokens `gap`, `font-size`, `margin`, `padding`, `header-weight` and `badge-bg` remain until the legacy cards go. `--b4-activity-badge-bg` defaults to `var(--b4-activity-border)`, so the depth badge follows the palette until you point it elsewhere — `transparent`, plus a border through `classNames.badge`, gives an outline chip.

Put the overrides in plain, unlayered CSS. A Tailwind `@theme` block is not a substitute: token values declared there lose to this sheet in every configuration tested.

Light and dark values ship out of the box. Dark follows the host, not the OS: a `.dark` or `[data-theme="dark"]` ancestor selects it; set `data-b4-theme="dark"` or `data-b4-theme="light"` on the root element to force one, or `data-b4-theme="auto"` to follow `prefers-color-scheme`. All three of the sheet's token blocks are wrapped in `:where()`, so they carry no specificity at all and your own `:root` block wins in every theme, whichever sheet the browser parses first.

**Rung 2 — `classNames`.** Pass per-part class names; they are appended to the package defaults, never substituted:

```tsx
<PlanActivityCard content={content} classNames={{ root: "my-plan-card", title: "font-mono" }} />
```

Appended is not the same as applied. `styles.css` is plain, unlayered CSS, and an unlayered rule beats a layered one regardless of specificity, so a Tailwind utility touching a property the sheet already sets on that same element loses silently. **A `classNames` entry only takes effect on a property the sheet leaves unset there.** Most of what it does claim is reachable at rung 1 instead: background, border color, radius, text color, font-size, margin and padding on the card, and the header's weight, all have tokens. Reachable at neither rung, and needing rung 4: the badge's radius, font-size, weight and padding; the section label's weight and size; the item-status and overflow font-sizes; and the list and item geometry.

A class is applied to every element of that part the card renders, so a part that repeats gets it more than once. `item` lands on each row, and on `SubagentPanel` `list`, `itemGlyph`, `itemLabel` and `itemStatus` land on both a child's plan checklist and its tools list.

Three keys are easy to confuse. `section` is a card's labelled region and exists only on `SubagentPanel`; `checklist` is `ActivityChecklist`'s own wrapper, which both surfaces render; `marker` is the disclosure triangle, an `aria-hidden` span that is the first child of the header.

> **Upgrading from 0.8.21 or earlier.** `classNames.section` used to land on the checklist wrapper as well as the labelled region — pass `classNames.checklist` for the wrapper now. Three changes fail silently rather than erroring. `.b4-activity__header::before` is gone, replaced by `.b4-activity__marker`; `.b4-activity__section` no longer matches the checklist wrapper, which is `.b4-activity__checklist`; and the marker is now the FIRST CHILD of `<summary>`, so `:first-child` and `nth-child()` selectors against the header shift by one. A plain `:root` palette override also now wins in dark mode and under `data-b4-theme`, where the package's dark rules used to outrank it — so a partial override that used to lose now leaks through; set palette tokens as a set. A `<summary>` `textContent` assertion also now sees the `▸` glyph, which a pseudo-element never contributed.

**Rung 3 — `components`.** Replace a leaf's rendering while the card keeps ownership of validation, ordering, and the bounded-content rules:

```tsx
<PlanActivityCard
  content={content}
  components={{
    TodoRow: ({ content, status, glyph, label }) => (
      <span>
        <span aria-hidden="true">{glyph}</span> {content} ({label})
      </span>
    ),
  }}
/>
```

`ActivityChecklist`, `PlanActivityCard`, and `SubagentPanel` all accept `classNames` and `components`; `SubagentPanel` also has a `ToolRow` slot for its tool rows.

**Rung 4 — eject.** For anything the ladder does not cover, copy `PlanActivityCard.tsx`, `SubagentPanel.tsx`, and `ActivityChecklist.tsx` into your own app. Each carries package-internal imports that do not exist in your tree, so repoint them — note they resolve to two *different* entries:

| File | Rewrite | To |
|---|---|---|
| `ActivityChecklist.tsx` | `"../activities.js"` | `"@b4run/ag-ui"` |
| `ActivityChecklist.tsx` | `"./parts.js"` | `"@b4run/ag-ui/react"` |
| `PlanActivityCard.tsx` | `"../activities.js"` | `"@b4run/ag-ui"` |
| `PlanActivityCard.tsx` | `"./parts.js"` | `"@b4run/ag-ui/react"` |
| `SubagentPanel.tsx` | `"./parts.js"` | `"@b4run/ag-ui/react"` |
| `SubagentPanel.tsx` | `"./useSubagentRuns.js"` | `"@b4run/ag-ui/react"` |

`B4PlanActivityContent` lives on the root entry; `cx`, the `classNames`/`components` types, and the `SubagentRun` types come from `/react`. The `"./ActivityChecklist.js"` imports need no change — they resolve to the sibling file you copied. After those rewrites the components are yours to change freely.

## Framework-free view

`@b4run/ag-ui/view` is the half of the client with no React: `reduceTurns(view, event)` folds AG-UI events into the turns of a thread — tool steps with their `b4.step` labels, the plan, reasoning, nested subagent turns, and approvals attached to the calls they gate — and `stepLabel`/`groupSteps` turn steps into sentences. `./react` builds on it; an Angular client can too.

```ts
import { EMPTY_TURNS, reduceTurns } from "@b4run/ag-ui/view"

let view = EMPTY_TURNS
for (const event of events) view = reduceTurns(view, event)
```

## Runtime and stability

- `@b4run/ag-ui` is a supported, edge-safe integration surface.
- `@b4run/ag-ui/sse` is a supported, edge-safe integration surface.
- `@b4run/ag-ui/client` is a supported, edge-safe integration surface.
- `@b4run/ag-ui/view` is a supported, edge-safe integration surface with no React dependency.
- `@b4run/ag-ui/react` is a supported React application surface, built for browser bundles. B4.run records its runtime as `node-only`, which means only that it does not pass B4.run's edge-safety guard — not that it requires Node: React's own JSX runtime reads `process.env.NODE_ENV`, which an application bundler substitutes as usual but the stricter edge guard rejects. The other entries never load it.
- `@b4run/ag-ui/copilotkit` is a supported React application surface recorded as `browser-only`: it imports CopilotKit, whose bundle imports its own CSS, so it needs a bundler. Browser bundles only: import it from a bundled React app, not from Node or an edge runtime. The other entries never load it.
- `@b4run/ag-ui/react/styles.css` is a supported integration surface carrying the cards' default appearance. It is a stylesheet asset, so it has no runtime classification at all: a bundler resolves it and nothing evaluates it as JavaScript. Import it once alongside your global CSS; it is optional, and every rule that styles an element is scoped to the `b4-activity` prefix (the sheet also declares `--b4-activity-*` custom properties on `:root`, which is intended and harmless — each of those three blocks is wrapped in `:where()`, so an application's own `:root` override always wins).

They translate protocol data; they do not authenticate callers or make client-provided state authoritative.

## Related

- [AG-UI API reference](https://b4.run/docs/api/ag-ui) — exact adapter, activity, and renderer contracts.
- [AG-UI and Web Clients](https://b4.run/docs/ag-ui) — client and transport setup.
- [Agent Protocol](https://b4.run/docs/dev-server/agent-protocol) — the underlying B4.run runtime endpoints.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/ag-ui` changelog](https://github.com/cacheplane/b4run/blob/main/packages/ag-ui/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
