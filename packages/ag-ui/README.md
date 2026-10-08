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

Requires `@ag-ui/core` 1.0.2 and `@b4run/sdk` (the matching B4.run release, for the shared content-part types), both dependencies. `@ag-ui/client` `>=1.0.1 <2.0.0` is an optional peer.

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
import "@b4run/ag-ui/styles.css"
import { B4Activity, useB4ChatSlots } from "@b4run/ag-ui/react/copilotkit"
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

`@b4run/ag-ui/react/copilotkit` is the only entry that imports `@copilotkit/react-core`; it needs a bundler (CopilotKit's bundle imports its own CSS), so import it from a bundled React app, not from Node or an edge runtime.

- `B4Activity` wraps your chat: it hides CopilotKit's generic tool rows, renders one `ApprovalCard` per parked interrupt, and keeps the thread's turns current from the agent's events; `labels`, `hiddenTools` and `renderStep` reword, hide or re-render steps per tool.
- `useB4ChatSlots()` returns the props to spread onto `<CopilotChat>`: one tool row per turn rendered as `TurnActivity`, no toolbar under tool-only rows.
- `useB4Turns()` is the agent's thread as turns (`reduceTurns`) plus `markResuming()` to call before sending a resume and `clearResuming()` to forget it when the resume request failed, for a host with its own transcript.

`react` and `@copilotkit/react-core` (`>=1.76.0`) are optional peer dependencies used only by the `./react` and `./react/copilotkit` subpaths; only `./react/copilotkit` imports CopilotKit. Importing the root or `./sse` entry never loads them, so a server-only consumer installs nothing extra. The floor tracks the wire protocol: 1.76.0 is the first `@copilotkit/react-core` whose bundled AG-UI client speaks 1.0, the protocol B4.run serves, and earlier releases resolve a pre-1.0 `@ag-ui/*` (0.0.59 on 1.70–1.75). pnpm warns on an unmet optional peer; npm 7+ rejects it with `ERESOLVE`.

## Angular activity kit

`@b4run/ag-ui/angular` is the same kit for Angular 22 or later: standalone, `OnPush` components with signal inputs (`<b4-turn-activity>`, `<b4-approval-card>`, the step rows such as `<li b4-step>`, and the building blocks) that render the same DOM contract as the React kit, from the same `@b4run/ag-ui/view` values, styled by the same sheet. Two connectors place them in a chat:

- `@b4run/ag-ui/angular/events` takes any AG-UI event stream (an RxJS `Observable<BaseEvent>`, or anything with the same `subscribe`) with no chat framework: `provideB4Turns` folds it into a `B4TurnsStore`, `<b4-message-activity>` renders a turn's activity on its first assistant message, and `<b4-approvals>` renders the parked interrupts' approval cards.
- `@b4run/ag-ui/angular/copilotkit` drives CopilotKit's `<copilot-chat>` (`@copilotkit/angular` `>=0.5.3`, the only Angular entry that imports it): `provideB4Activity` follows the chat's agent into turns, and `B4ActivityAssistantMessageComponent` and `B4ActivityApprovalsComponent` go in the chat's `[assistantMessageComponent]` and `[messageViewChildrenComponent]`.

```ts
import { Component, inject } from "@angular/core"
import { CopilotChat } from "@copilotkit/angular"
import {
  B4ActivityApprovalsComponent,
  B4ActivityAssistantMessageComponent,
  B4ActivityStore,
  provideB4Activity,
} from "@b4run/ag-ui/angular/copilotkit"

@Component({
  selector: "app-chat",
  imports: [CopilotChat],
  providers: [provideB4Activity({ agentId: "default" })],
  template: `<copilot-chat agentId="default"
    [assistantMessageComponent]="assistant"
    [messageViewChildrenComponent]="approvals" />`,
})
export class ChatComponent {
  readonly activity = inject(B4ActivityStore) // created with the chat, so it sees every event
  readonly assistant = B4ActivityAssistantMessageComponent
  readonly approvals = B4ActivityApprovalsComponent
}
```

Load the sheet once, for example in `angular.json`'s `styles` (`"@b4run/ag-ui/styles.css"`). `@angular/core`, `@angular/common`, `@angular/platform-browser` (`^22.0.0`) and `@copilotkit/angular` are optional peer dependencies; the other entries never load them. The Angular entries ship in Angular's partial compilation format, which your Angular CLI build links.

## Styling

The kit ships with B4.run's visual identity via an optional stylesheet. Every rule sits in `@layer b4-activity`, so any unlayered app CSS wins without specificity games. Without the stylesheet, the components render structured, unstyled markup.

```ts
import "@b4run/ag-ui/styles.css"
```

To restyle, override the design tokens in your own CSS:

```css
:root {
  --b4-activity-radius-card: 8px;
  --b4-activity-font-mono: "JetBrains Mono", monospace;
}
```

Palette tokens are the one case worth care. Your `:root` block wins in dark
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

The design tokens are `--b4-activity-` plus `surface`, `surface-alt`, `border`, `text`, `muted`, `running`, `running-bg`, `complete`, `failed`, `failed-bg`, `primary`, `on-primary`, `radius`, `radius-card`, `radius-pill`, and `font-mono`.

Put the overrides in plain, unlayered CSS. A Tailwind `@theme` block is not a substitute: token values declared there lose to this sheet.

Light and dark values ship out of the box. Dark follows the host, not the OS: a `.dark` or `[data-theme="dark"]` ancestor selects it; set `data-b4-theme="dark"` or `data-b4-theme="light"` on the root element to force one, or `data-b4-theme="auto"` to follow `prefers-color-scheme`. All three of the sheet's token blocks are wrapped in `:where()`, so they carry no specificity at all and your own `:root` block wins in every theme, whichever sheet the browser parses first.

Beyond tokens, the kit is markup with stable classes (`.b4-turn`, `.b4-step`, `.b4-approval` and their `__` parts) and `data-state`/`data-kind` attributes, so unlayered app CSS can target any part. For a step whose detail needs its own view, pass `renderStep` (per tool) to `B4Activity` or `TurnActivity`; for a wholly different presentation, build on `reduceTurns` from `./view` and the blocks `./react` exports.

## Framework-free view

`@b4run/ag-ui/view` is the half of the client with no React: `reduceTurns(view, event)` folds AG-UI events into the turns of a thread — tool steps with their `b4.step` labels, the plan, reasoning, nested subagent turns, and approvals attached to the calls they gate — and `stepLabel`/`groupSteps` turn steps into sentences. `./react` and `./angular` build on it; so can any other framework.

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
- `@b4run/ag-ui/react/copilotkit` is a supported React application surface recorded as `browser-only`: it imports CopilotKit, whose bundle imports its own CSS, so it needs a bundler. Browser bundles only: import it from a bundled React app, not from Node or an edge runtime. The other entries never load it.
- `@b4run/ag-ui/angular`, `@b4run/ag-ui/angular/events` and `@b4run/ag-ui/angular/copilotkit` are supported Angular application surfaces recorded as `browser-only`: they ship in Angular's partial compilation format, which an Angular build's linker finishes (a plain Node import fails for want of Angular's JIT compiler). Import them from an Angular application built with the Angular CLI. The other entries never load them.
- `@b4run/ag-ui/copilotkit-runtime` is a supported application surface recorded as `edge-safe`: `createB4AgentRunner(InMemoryAgentRunner, options)` extends the CopilotKit runner class the route passes in (the entry never imports `@copilotkit/runtime`; it imports only `rxjs`, a regular dependency, and uses `fetch`), so it runs wherever your CopilotKit runtime route runs, Node or an edge runtime. It belongs on the server, beside that route. The other entries never load it.
- `@b4run/ag-ui/styles.css` is a supported integration surface carrying the default appearance of both kits. It is a stylesheet asset, so it has no runtime classification at all: a bundler resolves it and nothing evaluates it as JavaScript. Import it once alongside your global CSS; it is optional, and every rule that styles an element is scoped to the `b4-activity` prefix (the sheet also declares `--b4-activity-*` custom properties on `:root`, which is intended and harmless — each of those three blocks is wrapped in `:where()`, so an application's own `:root` override always wins).

They translate protocol data; they do not authenticate callers or make client-provided state authoritative.

## Related

- [AG-UI API reference](https://b4.run/docs/api/ag-ui) — exact adapter, activity, and renderer contracts.
- [AG-UI and Web Clients](https://b4.run/docs/ag-ui) — client and transport setup.
- [Agent Protocol](https://b4.run/docs/dev-server/agent-protocol) — the underlying B4.run runtime endpoints.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/ag-ui` changelog](https://github.com/cacheplane/b4run/blob/main/packages/ag-ui/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
