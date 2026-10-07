# Chat — CopilotKit web client (AG-UI)

The canonical reference for **connecting a web client to B4.run over AG-UI**. This is a
[CopilotKit](https://docs.copilotkit.ai) v2 app (`@copilotkit/react-core/v2` +
`@copilotkit/runtime/v2`) whose required catch-all runtime route
(`app/api/copilotkit/[...path]/route.ts`) registers a `B4HttpAgent` (`@b4run/ag-ui/client`) pointed at B4.run's
`POST /agui/{routeId}` endpoint (the URL-encoded assistant id, e.g.
`%2Fchat%23agent`; see `@b4run/ag-ui`). It replaces the previous hand-rolled SSE
smoke client.

This app runs **live** against a real model — there is no aimock/demo mode here. The
deterministic, no-key checks cover both boundaries: a loopback integration drives the
real CopilotKit handler through `B4HttpAgent` and forwards a schema-valid AG-UI stream,
while the package-owned browser test loads this page, proves it discovers
`GET /api/copilotkit/info` without a legacy base-URL POST, and answers the sidebar's
`connect` with a recorded replay to pin the activity kit's DOM (a restored turn and a
restored permission prompt). Neither check calls a model.

Scope: basic chat with the `/chat` route. The sidebar runs inside `B4Activity` from
`@b4run/ag-ui/copilotkit` and takes its `messageView` slots from `useB4ChatSlots()`, so
each turn renders as one `TurnActivity` (the tool calls, the `writeTodos` plan, the
model's reasoning) instead of CopilotKit's generic tool rows, and a permission prompt
renders as an `ApprovalCard` with Allow once, Always allow and Deny. It still drives only
`/chat`, so it remains a transport-wiring example, not a coordinator UI.

## Architecture

```
browser
  -> /api/copilotkit/* (app/api/copilotkit/[...path]/route.ts, this app, no API key)
    -> B4HttpAgent -> POST /agui/%2Fchat%23agent  (B4.run dev server, holds OPENAI_API_KEY)
      -> live /chat agent
        -> AG-UI event stream back to the browser
```

- `app/api/copilotkit/[...path]/route.ts` — `CopilotRuntime` with
  `agents: { default: new B4HttpAgent(...) }` and
  `runner: createB4AgentRunner(InMemoryAgentRunner, { url })` from
  `@b4run/ag-ui/copilotkit-runtime`, served through `createCopilotRuntimeHandler` from
  `@copilotkit/runtime/v2` with `basePath: "/api/copilotkit"` and shared `GET`/`POST`
  exports. The runner answers the sidebar's `connect` by replaying
  `GET /threads/:id/events` from the B4.run server, so a reload restores the
  conversation, its activity and a parked approval. No LLM credentials live here; the
  B4.run server holds `OPENAI_API_KEY`.
- `app/page.tsx` — `CopilotKit` (`runtimeUrl="/api/copilotkit"`,
  `useSingleEndpoint={false}`) wrapping `B4Activity` and a `CopilotSidebar` with
  `useB4ChatSlots()`'s `messageView`. The tab's thread id lives in `sessionStorage`, so a
  reload reconnects to the same thread.

This example has no users to tell apart, so the runner's replay uses the default
`fetch`. An app with users passes a `fetch` that carries the current caller's identity,
derived per request (see `examples/navlog/web` and the AG-UI docs' "Restoring a
conversation after a reload").

CopilotKit's sidebar falls back to the literal agent id `"default"`. This example
registers the B4.run `/chat#agent` route under that id.

## Running

Run these commands from the repository root. They intentionally enter the parent
`examples/chat` package before using its server/web scripts:

```bash
cd examples/chat
cp server/.env.example server/.env   # add OPENAI_API_KEY — the server needs it, not this app
pnpm install
pnpm dev                             # server on :3001, web on :3000
# open http://localhost:3000
```

`pnpm --filter @b4-example/chat-web typecheck` / `build` verify that the
CopilotKit/AG-UI wiring compiles and the Next.js app builds. `pnpm --filter
@b4-example/chat-web test:e2e` launches the real page and verifies its V2 discovery
transport in a dedicated CI lane. These deterministic checks do **not** exercise a live
model; there's no automated substitute for the smoke below because this client
intentionally has no demo/mock mode.

## Live smoke checklist (run manually, with a real `OPENAI_API_KEY`)

1. From `examples/chat`, run `cp server/.env.example server/.env` and set `OPENAI_API_KEY`.
2. `pnpm dev` (server :3001, web :3000).
3. Open http://localhost:3000. Send "list the files in the workspace" — expect a
   streamed assistant reply in the sidebar.
4. Confirm a second message in the same thread continues the conversation without
   replaying prior user messages to the B4.run route.
5. Choose **Trigger a permission prompt**. Expect an approval card ("The agent wants
   to …") with Allow once, Always allow and Deny; reload while it is open and confirm
   the card comes back; choose Allow once and confirm the turn finishes.

## Security caveat

Same as the server: `runBash` runs real shell commands on your machine with
`cwd: workspace/`. Do not point untrusted users at this example.
