# B4.run Workbench — the navlog example's web client

A [CopilotKit](https://docs.copilotkit.ai) v2 app (`@copilotkit/react-core/v2` +
`@copilotkit/runtime/v2`) that talks to B4.run's `/navlog` agent over AG-UI. Its
required catch-all route (`app/api/copilotkit/[...path]/route.ts`) registers an
`B4HttpAgent` (`@b4run/ag-ui/client`) pointed at B4.run's encoded `/navlog#agent` endpoint. It is a
workbench rather than a chat widget: CopilotKit's stock `<CopilotChat>` sits in a
floating dock inside B4.run's `<B4Activity>`, so each turn's plan, the `weather` and
`performance` subagents, tool steps and approval appear in the conversation, and the
map, sheet and weather strip read the same turns from outside the chat.

The live app uses a real model; there is no aimock/demo mode. Its browser test is
model-free and proves the page discovers `GET /api/copilotkit/info` instead of sending
a legacy base-URL POST.

## Layout

- **Connect screen** (`app/components/ConnectScreen.tsx`) — replaces the whole shell when
  the B4.run server is not answering, with the two commands that start it. It re-probes
  every 5 seconds through `GET /api/b4/memory/candidates` (an allowlisted read, so it
  measures B4.run's own liveness rather than this Next process's), and clears itself the
  moment the server comes up — no reload. "Try again" probes immediately.
- **Route map** (full viewport, `app/components/RouteMap.tsx`) — a
  [Leaflet](https://leafletjs.com) map on OpenStreetMap tiles (credited in the map's
  attribution control, as the tile policy requires), muted in light mode and inverted in
  dark so the route carries the color. It draws the planned route, one marker per
  waypoint colored by flight category and labelled with the category as text, and the
  cruise magnetic heading at each leg's midpoint, then fits the route between the
  floating panels. Leaflet loads only in the browser (`next/dynamic` with `ssr: false`).
- **Chat dock** (floating left, `app/components/ChatDock.tsx`) — the brand, the thread
  title and run status, "+ New conversation", a "Threads" disclosure holding the thread
  list (`app/components/ThreadRail.tsx`, each thread titled from its first user
  message), the memory panel (`app/components/MemoryPanel.tsx`, the candidates the agent
  proposed with `remember()`, with Approve and Delete on each; it takes no space until
  one is waiting), and the chat (`app/components/NavlogChat.tsx`, below).
- **Weather strip** (floating top right, `app/components/WeatherStrip.tsx`) — one chip
  per airport in the `weather` subagent's brief, colored by the worse of the category
  now and at ETA (`worstCategory`) and naming both when they differ (`KRST VFR now,
  MVFR at ETA`), and the first winds-aloft line. A chip opens the raw METAR (or SPECI)
  and TAF. Each map marker shows the same category as its chip. On phones the chips
  are one horizontally scrolling row.
- **Navlog sheet** (floating bottom, `app/components/NavlogSheet.tsx`) — collapsed, one
  line of totals (route, distance, ETE, fuel, reserve, with a warning under 45 minutes);
  open, the legs table (`NavlogTable.tsx`: TC, variation, MC, wind, WCA, MH, TAS, GS,
  distance, ETE, ETA and fuel per climb and cruise segment), the ICAO flight plan items
  7 to 19 (`FlightPlanBlock.tsx`) and the assistant's brief. **Print** prints the sheet
  alone on one landscape page (the `@media print` rules in `app/theme.css`); **Copy FPL**
  copies the filing-ready `(FPL-…)` message. Hovering or focusing a row highlights that
  leg on the map. The chat's opened `computeNavlog` step
  (`StepViews.tsx`) shows the totals and a link that opens the sheet.
- **Phones** (under 768 px) — the dock and the sheet become one bottom sheet with
  **Chat** and **Navlog** tabs, the navlog as one card per leg; the map stays behind it
  and the weather chips sit just above. Only the layout that applies is rendered
  (`app/lib/use-media-query.ts`), so there is always exactly one chat.
- **Chat** (`app/components/NavlogChat.tsx`) — `<CopilotChat>` with B4.run's slots
  (`useB4ChatSlots`): one `TurnActivity` per turn (summary line, the plan, the `weather` /
  `performance` subagents nested, each tool call as a step) and the kit's `ApprovalCard`
  for the `fileFlightPlan` approval. `StepViews.tsx` gives `computeNavlog` a totals view
  and `renderChart` its image, through `B4Activity`'s `renderStep`. Before the first
  message the chat shows the starter suggestions (`DemoSuggestions.tsx`). The input waits
  while an approval is open, and takes PNG, JPEG, GIF and WebP attachments up to 4 MB when
  the route's model takes images; a refused file gets one dismissible line above the chat.
  Parts the model never saw (`b4.content_parts_dropped`) show as notices in the dock
  (`DropNotices.tsx`), and run errors as a banner (`RunError.tsx`).

### How data reaches the map and the sheet

Nothing new is stored. The workbench derives every surface from the activity turns
`B4Activity` provides (`useB4ActivityContext`), through pure selectors with their own
unit tests:

- `latestNavlogResult(turns)` and `parseNavlog` (`app/lib/navlog-selectors.ts`) — the most
  recent `computeNavlog` tool result, parsed into the `Navlog` shape
  (`app/lib/navlog-types.ts` mirrors the server's type field for field).
- `latestWeatherBriefText(turns)` and `parseWeatherBrief` (`app/lib/weather-selectors.ts`)
  — the most recent completed `weather` subagent step, parsed from the brief the
  subagent is prompted to write. The parser tolerates bullets, bold headers and SPECI reports, and a
  brief it cannot read leaves the strip empty rather than throwing.
- `routeGeometry(navlog)` (`app/lib/route-geometry.ts`) — the polyline, markers, heading
  labels and bounds the map draws.

```
browser
  → /api/copilotkit/* (app/api/copilotkit/[...path]/route.ts, this app, no API key)
    → B4HttpAgent → POST /agui/%2Fnavlog%23agent  (B4.run dev server, holds OPENAI_API_KEY)
      → live /navlog agent
        → AG-UI event stream back to the browser
```

- `app/api/copilotkit/[...path]/route.ts` — `CopilotRuntime` with
  `agents: { default: new B4HttpAgent(...) }`, with `runner: createB4AgentRunner(InMemoryAgentRunner, ...)` from `@b4run/ag-ui/copilotkit-runtime` (CopilotKit's runner class passed in), served through
  `createCopilotRuntimeHandler` from `@copilotkit/runtime/v2` with
  `basePath: "/api/copilotkit"` and shared `GET`/`POST` exports. No LLM credentials
  live here; the B4.run server holds `OPENAI_API_KEY`.
- `app/page.tsx` — `CopilotKit` (`runtimeUrl="/api/copilotkit"`,
  `useSingleEndpoint={false}`, a 100 ms render throttle) plus a
  `CopilotChatConfigurationProvider` carrying the active thread id. `AppShell` mounts
  `<B4Activity key={threadId}>` (keyed so a thread switch resets the turns and any open
  approval) and the dock's `NavlogChat` inside it.

Components/hooks that omit `agentId` resolve CopilotKit's default agent id
(`"default"`), which the runtime route registers as the B4.run `/navlog` agent — same
pattern as `examples/chat/web`, no per-component wiring needed.

## Thread history

Switching threads restores that conversation. The chat mounts per thread and calls
CopilotKit's `connect`; the runtime route's runner (`createB4AgentRunner`) answers by replaying
`GET /threads/:id/events` from B4.run's checkpoints as the AG-UI events a live run would
have sent — messages, the turns (plan, subagents, tool steps), attachments and tool
media, and a parked approval. A restored thread and a live one therefore render through
one path, and the browser never reads thread state itself. The thread rail
(`app/lib/thread-source.ts`) keeps only ids, titles and recency in `localStorage`.

A thread with no checkpoint yet (a brand-new one) restores as an empty chat, not an
error. What a restore does not bring back: drop notices (they come from stream-only
events), and a user image the adapter dropped (it never reached the checkpoint).

## Permission gates

The `fileFlightPlan` call is approval-gated. `B4Activity` handles the interrupt and
renders it as the kit's `ApprovalCard` in the chat; the input stays disabled until it is
answered. A run parked on a gate survives a reload, because the replay carries the
parked interrupt and the card comes back with it.

## The proxy

The B4.run dev server sets no CORS headers, so the browser reaches the memory routes
through the same-origin catch-all at `app/api/b4/[...path]/route.ts`. That proxy is
**not** open. `app/lib/proxy-allowlist.ts` is a pure function listing every route the
browser may reach — three of them:

| Method | Path |
| --- | --- |
| GET | `/memory/candidates` |
| POST | `/memory/candidates/:id/approve` |
| POST | `/memory/candidates/:id/reject` |

Anything else — a path that is not listed, or a listed path with the wrong method — is
rejected with **403** and never forwarded. Thread history is not on the list: the
runner reads it server to server. Running, resuming, and cancelling a thread go through
CopilotKit's own runtime route.

## Memory review

The panel is **candidates only**. It lists what the agent proposed with `remember()` and
offers two decisions per candidate: **Approve** (`/approve`, which reports back when the
new record supersedes an older belief) and **Delete** (`/reject`, a hard delete on the
server with no undo — hence the label, not "Dismiss"). It shows at most three at a time
and counts the rest, so it cannot push the thread list off the rail. With no candidates it
renders nothing at all — except the one line reporting the outcome of the decision you
just made, or a load failure. It cannot browse, search, or edit stored
memories — that is still `b4 memory list` and the rest of the `b4 memory` CLI.

## Running

This demo needs a real model API key. There is no keyless or mock demo mode.

```bash
pnpm install
pnpm build                           # build the B4.run packages this app uses through dist
cd examples/navlog
cp server/.env.example server/.env   # set OPENAI_API_KEY here — the server needs it, not this app
pnpm dev                             # server on :3002, web on :3010
# open http://localhost:3010
```

`web/.env.example` sets `B4_SERVER_URL` (default `http://127.0.0.1:3002`); copy it to
`web/.env` if your server listens elsewhere. Its other variables are for the deployed
demo (see [Deploy](#deploy-vercel)) and stay unset locally.

`pnpm --filter @b4run/ag-ui test` renders the cards on the server and checks their
schemas and bounds. Here, `typecheck` / `build` verify the CopilotKit/AG-UI wiring
compiles and the Next.js app builds. The repository's packaged navlog activation
proves the deterministic wire path. `pnpm --filter @b4-example/navlog-web
test:e2e` drives the real page in a browser to verify V2 transport selection. None of
these checks exercises a live model; this client intentionally has no demo/mock mode.

## Restyling it

`app/theme.css` is the one file to edit. The whole palette is defined there as CSS
variables and re-exported as Tailwind tokens via `@theme inline`, which is why the app's
utilities read `bg-wb-surface`, `border-wb-border`, `text-wb-muted`, `rounded-wb`. Change
a `--wb-*` value and the light and dark palettes, the activity-card tokens, and every
utility move together. The same file holds the single focus ring (`wb-focus`), the two
roles the b4 gradient is allowed to play (`.wb-brand-mark`, `.wb-primary-action`), and
the `.wb-prose` rules for rendered markdown.

It also holds the map workbench's tokens: `--wb-dock-width`, `--wb-sheet-max` and
`--wb-gutter` for the layout, `--wb-route` for the route line, the `--wb-cat-*`
flight-category colors the chips and the markers share, the filter that mutes the map
tiles (inverted in dark mode), and the print rules.

The palette follows the OS light/dark setting. To pin one regardless, set
`data-wb-theme="light"` or `data-wb-theme="dark"` on `<html>` — `theme.css` defines both
branches.

The plan and subagent steps are **not forks**. They are the packaged
`@b4run/ag-ui/react` components `B4Activity` renders (`TurnActivity` and its steps),
themed through the `--b4-activity-*` tokens in `app/theme.css` and extended per tool in
`app/components/StepViews.tsx` — validation, bounds, and layout stay in the package
where they are tested. The package's CSS is unlayered and Tailwind's utilities are not,
so a utility cannot override a property the package stylesheet sets; use the tokens for
those.

## Test coverage

`pnpm --filter @b4-example/navlog-web test` runs 28 test files: the proxy and
CopilotKit runtime routes and the allowlist, the thread source, the thread rail, the
chat (attachments, echo stripping, approval gating), the step views, drop notices,
the connect screen, the memory panel, media parts, the shell's thread-switch and
server-probe behaviour, and the map workbench: the navlog and weather selectors, route
geometry, formatting, the navlog table, sheet, flight plan block, the weather strip, and
the desktop and phone layouts. The navlog fixture (`SAMPLE_NAVLOG`) is the server's own
`computeNavlog` output, not hand-written numbers. `RouteMap` itself needs a real DOM and
is exercised in the browser, not in Vitest. `typecheck` and `build` prove the
CopilotKit/AG-UI wiring compiles. The activity components themselves are tested in
`@b4run/ag-ui`.

The model-free `test:e2e` browser test proves the V2 transport begins with
`GET /api/copilotkit/info` rather than the legacy single-endpoint `POST`. The connect
screen, its auto-recovery, the empty chat, thread restore including the new-thread
case, and every proxy allow/reject case were also verified by hand in a real browser
against a real server. A full planning run — streaming, activity cards, the approval
gate live and across a reload, memory candidates appearing and superseding — needs a
real `OPENAI_API_KEY` and has not been exercised in this repo; those paths are covered
by unit tests only.

## What it does not do yet

- **The map needs the network.** Tiles come from `tile.openstreetmap.org` under the
  OpenStreetMap tile usage policy, which suits development and light use, not heavy
  production traffic; point the `L.tileLayer` URL in `RouteMap.tsx` at your own provider
  before you ship. Offline, the map is blank and the route, markers and labels still
  draw on it. It opens on the continental US until a navlog arrives.

- **Threads are local to the browser.** The rail keeps its own list in `localStorage`
  (`app/lib/thread-source.ts`) because the B4.run server cannot enumerate threads. The
  list is not shared across browsers, devices, or profiles, and clearing site data
  clears it — the server still holds the conversations, but this client would no longer
  know their ids.
- **Restores replay stored events.** Only what the checkpoint stores comes back:
  messages, the turns (plan, subagents, tool steps), attachments and tool media, and a
  parked approval. Notices for parts the model never saw do not return.
- **Memory review is candidates only** — see above. No browsing, searching, or editing.
- **A connection loss costs you your draft.** When a probe finds the B4.run server down,
  the connect screen replaces the whole shell — which unmounts the chat input, so anything
  typed but not sent is gone when the server comes back.

## Security caveat

Same as the server: tools run against the workspace with real network and filesystem
access as configured. Do not point untrusted users at a local run of this example.

The allowlist bounds WHICH routes are reachable, not WHO may reach them. Who is the
server's job: `server/src/thread-access.ts` makes every thread owned by the principal
that created it, and `server/src/auth.ts` resolves that principal. Locally (no
`B4_INTERNAL_TOKEN`) one local principal owns everything, so anything that can reach
this Next app can read any thread by its id and delete memory candidates; run it only
on a machine you are the sole user of. The deployed demo turns the guards below on.

## Deploy (Vercel)

The live demo runs this client on Vercel in front of the server on Railway (see
[`../server/README.md`](../server/README.md#deploy-railway)).

**Project.** Import the `cacheplane/b4run` repository, set the Root Directory to
`examples/navlog/web`, and turn on "Include source files outside of the Root
Directory". `vercel.json` builds the client and the workspace packages it uses from
the repository root (`pnpm turbo run build --filter=@b4-example/navlog-web...`), and
`scripts/vercel-ignore-build.sh` skips preview builds when nothing the client is built
from changed. `factory/*` branches never build.

**Variables** (the same list as `.env.example`):

| Variable | Purpose |
|---|---|
| `B4_SERVER_URL` | The Railway service's public URL. |
| `B4_INTERNAL_TOKEN` | The same secret as the server's, at least 32 characters. |
| `B4_DEMO_ORIGINS` | The site's own origin(s), comma-separated. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | The rate limiter's store. |
| `B4_DEMO_ADMIN_TOKEN` | The demo owner's secret: long and random (`openssl rand -base64 32`). Shorter than 32 characters and the owner route stays a 404. |

**The guards** (`app/lib/proxy-guard.ts`, applied by both proxy routes before anything
is forwarded):

1. **Origin.** With `B4_DEMO_ORIGINS` set, a browser call from another origin gets 403.
2. **Visitor.** Every browser gets an HTTP-only visitor cookie (`__Host-b4_visitor`
   when deployed), and its id is forwarded as `X-B4-Visitor`. The server makes each
   thread owned by the visitor that created it, so one browser cannot read another's
   conversations.
3. **Rate limit.** Counted twice, per visitor id and per client IP, so clearing the
   cookie does not reset it. A run (a CopilotKit POST) draws on a tight bucket, ten a
   minute; a read (any GET, including CopilotKit's `/info`) on a loose one, 120 a
   minute. The IP is `X-Real-IP`, else the first `X-Forwarded-For` hop, which Vercel's
   edge sets; behind a proxy that passes client-supplied forwarding headers through,
   the IP key is forgeable and only the visitor key holds. Without Upstash, or
   when it errors, the limiter is skipped: the proxy fails open rather than take the
   demo down.
4. **Token.** Every upstream call carries `B4_INTERNAL_TOKEN`; the server refuses any
   call without it.

With none of these variables set, as in local development and the test lanes, the
only effect is the visitor cookie and header, which a server without a token ignores.

**Memory approval is the owner's.** Long-term memory is shared by the whole demo: any
visitor's agent may propose a memory, and the proposed candidates are visible to every
visitor in the memory panel, but only the demo owner may approve or delete one. Visit
`/api/admin?token=<B4_DEMO_ADMIN_TOKEN>` once to make your browser the owner: it sets an
HTTP-only owner cookie holding an HMAC of the token, never the token itself. Everyone
else gets the panel's "reserved for the demo owner" message. With `B4_DEMO_ADMIN_TOKEN`
unset the route is a 404.
