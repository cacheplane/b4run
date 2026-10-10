# @dawn-ai/devkit

## 0.14.1

### Patch Changes

- 73ee0fd: A readability pass on the navlog template, the example new apps start from.
  - **READMEs:** they now describe the current layout, request flow, structured answer and tests. AGENTS.md gains a navlog section.
  - **Memory schema:** its text describes navlog's facts.
  - **Removed:** the unused `state.ts`.
  - **Map:** the marker and label helpers move out of `RouteMap`, and the label priorities are named.
  - **`ThreadWorkbench`:** now has its own file.
  - **Comments and props:**
    - Comments describe the code as it is.
    - Props that both said "brief" now say `weatherBrief` and `planningAnswer`.
- 6357657: In the navlog template's Weather tab, a reporting station just past the destination now reads "near destination", even when the route's measured length runs a mile or two short of the navlog's total.
- c97a074: Refinements to the navlog template:
  - Map labels no longer collide. A label moves left of its marker or hides until hovered, and route waypoints always keep theirs.
  - The planning brief's components share one rhythm: the bottom line as a tinted card, Watch for as an aligned list, Assumptions as a list with captions and uniform Change buttons, and key numbers with their values aligned.
  - The route bar's altitude and departure are one labeled field.
- f610118: Polish for the navlog template:
  - The route bar's controls share the app's 32px height, and it lays out in two rows in a narrow map panel.
  - The map refits the route when its panel resizes.
  - The sheet header no longer wraps.
  - Weather reports drop the repeated "METAR"/"TAF" word.
  - The chat composer no longer shows the transcript underneath it.
  - Key numbers wrap evenly.
- 53d3bbc: The navlog template gains a route bar on the map, with autocomplete over a bundled OurAirports snapshot of US airports and navaids. Its Plan/Replan button sends the route as one chat message. Two new tools, `lookupNavaid` and `findRouteStations`, resolve navaids and find reporting stations within 25 nm of the course. A new Weather tab groups METARs and TAFs by origin, en route and destination, replacing the weather chips on the map.

## 0.14.0

### Patch Changes

- e2f717a: `@b4run/ag-ui/react/copilotkit` exports `useB4ActivityContext` and its `B4ActivityContextValue` type: the turns, labels, `renderStep` and clock `B4Activity` provides, for host UI outside the chat such as a map or a sheet. It throws outside `B4Activity`, and its error now names `useB4ActivityContext` instead of `useB4ChatSlots`.

  A restored thread keeps its media. `eventsFromState` replays a user message that carried an attachment as AG-UI content parts in its `RUN_STARTED` input, and a tool result whose ToolMessage kept parts (`b4_content_parts`) as those parts in `TOOL_CALL_RESULT`, the shape the live stream sends; `reduceTurns` keeps a result's non-text parts on `ToolStep.parts`, live or restored. `@b4run/ag-ui/view` exports `blocksToParts`, the checkpoint-block-to-part mapper the replay uses.

  The navlog template's web client chats through CopilotKit's stock `<CopilotChat>` inside `B4Activity`, with `computeNavlog` and `renderChart` step views, the kit's `ApprovalCard` for approvals, and image attachments through the chat's own input. It restores a thread through `createB4AgentRunner(InMemoryAgentRunner, { url, fetch })` in its CopilotKit route, so its `/api/b4` proxy now forwards only the three memory-candidate routes, and its map, sheet and weather strip read the activity turns with `useB4ActivityContext`. The custom transcript, composer, tool-call card, permission components and checkpoint hydrator are gone from the template.

  `@b4run/ag-ui/copilotkit-runtime` no longer imports `@copilotkit/runtime`. The runner is built with `createB4AgentRunner(InMemoryAgentRunner, { url, fetch })`, where the CopilotKit runtime route passes its own `InMemoryAgentRunner` class from `@copilotkit/runtime/v2`; the `B4AgentRunner` class export is gone. The runner extends the copy of CopilotKit the route resolves, so an npm workspace that hoists `@b4run/ag-ui` to the root while installing `@copilotkit/runtime` only under the web package no longer fails with `Cannot find package '@copilotkit/runtime'`. `@copilotkit/runtime` is no longer a peer dependency of `@b4run/ag-ui`, and `rxjs` (`^7.8.1`) is now a regular dependency instead of an optional peer.

- ad56b6d: **Breaking:** the legacy activity surfaces are removed; the activity kit (`reduceTurns` and the components built on it) is the one way to present B4.run activity. Removed from `@b4run/ag-ui/react`: `PlanActivityCard`, `ActivityChecklist`, `SubagentPanel`, the `classNames`/`components` props and their `B4ActivityClassNames`, `B4ActivityComponents`, `B4TodoRowProps` and `B4ToolRowProps` types, `cx`, `planActivityContentSchema`, `useSubagentRuns` and `SubagentEventSource`, and the re-exports of the subagent-runs model and `isSubagentMessage`. Removed from `@b4run/ag-ui/view`: `reduceSubagentRuns`, `EMPTY_SUBAGENT_RUNS`, `SubagentRun`, `SubagentRunsState` and `SubagentToolCall`. Removed from `@b4run/ag-ui/react/copilotkit`: `b4ActivityRenderers` and `b4PlanActivityRenderer`. The stylesheet drops the `.b4-activity*` rules and the `--b4-activity-gap`, `-font-size`, `-margin`, `-padding`, `-header-weight` and `-badge-bg` tokens. Replacements: wrap `<CopilotChat>` or `<CopilotSidebar>` in `B4Activity` and spread `useB4ChatSlots()` onto it (one `TurnActivity` per turn, with the plan, reasoning and subagents as steps, and an `ApprovalCard` per parked interrupt); `useB4Turns` with `TurnActivity` for a host with its own transcript; `reduceTurns` from `@b4run/ag-ui/view` for a client without React. `isSubagentMessage` stays in `@b4run/ag-ui/view`. The chat example's sidebar now runs on `B4Activity` + `useB4ChatSlots`, and its runtime route restores threads with `createB4AgentRunner`.

  The navlog template's READMEs describe the activity kit instead of the removed renderers and `b4.subagent` activity.

  `ApprovalCard` (via `approvalPayload`) shows a subagent dispatch gate as readable lines (the subagent and its route, the input preview, the reason) instead of a JSON dump of its detail.

  Activity-kit fixes: `useB4Turns` folds an event that carries a numeric `timestamp` (a restored thread's replay) at that time instead of on arrival, so a restored turn reads its real duration ("Worked for 3m 12s", not "<1s") and live events keep the configured clock. `SubagentStep` reads "Asked researcher" with the subagent's description on a muted `.b4-step__note` line beneath, instead of splicing the description into "Asked researcher to …". An approval card for a step with no running label (a restored parked call) reads "The agent wants to use fileFlightPlan" instead of "wants to using fileFlightPlan…". The navlog template's chat sits on the dock's translucent panel, and its awaiting-approval placeholder fits the dock.

- d0bb6a1: The approval card lists a tool call's arguments instead of printing their JSON: when the args preview is a JSON object, each key is a row, a nested object's keys read `parent.key`, anything deeper is compact JSON, and a value past 80 characters is cut with the whole of it a click away. Other payloads (a command, a subagent gate, a preview the server cut short) print as before. `approvalArgsRows` (`@b4run/ag-ui/view`) is the shared helper both kits render from, with its `ApprovalArgRow` type and `MAX_APPROVAL_ARG_CHARS`.

  A merged run of one tool's calls is phrased from the calls' own labels when they share leading words and end in a short name: "Looked up KSTP" and "Looked up KRST" merge as "Looked up KSTP and KRST", three name all three, and more name two and count the rest. A trailing parenthetical is left out. An app's `group` label and the built-in tools' wording still come first, and labels that do not fit still read "Used X n times". `phraseGroupLabel` (`@b4run/ag-ui/view`) is the rule.

  The navlog template's `lookupAirport` puts an airport's details in parentheses, so its calls merge by name, and drops its `group` label.

- c4238e1: The research template's web client renders media parts (images, audio, video, documents) in user messages and beside tool cards, shows a notice for each part the model did not receive (`b4.content_parts_dropped`), restores media when it hydrates a thread, and offers an image attachment when the route's capability document says its model takes images. The research server ships `renderChart`, a tool that returns a text summary and an inline SVG bar chart. `@b4run/testing`'s agent harness `run({ input })` accepts a list of content parts as well as a string.
- 0b33206: **Breaking:** subagents are presented with AG-UI 1.0's `SUBAGENT_STARTED/FINISHED/ERROR` events and `subagentRunId` attribution; the `b4.subagent` activity is removed. `toAguiEvents` announces a subagent when the `task` tool starts it (`subagentRunId` is the `task` tool-call id; `parentToolCallId`, `parentSubagentRunId` and `description` are carried), tags the child's text, reasoning, tool calls, results, usage and plan with that id, and closes every announced invocation before the run ends — `SUBAGENT_FINISHED { result }` on success, `{ outcome: suspended, interruptIds }` at a child's interrupt (the interrupt carries the child's `subagentRunId`), `SUBAGENT_ERROR` on failure, cancel (`code: "cancelled"`) or a stream that ended first (`code: "unterminated"`). The `task` call is an ordinary tool call again. Removed: `B4_SUBAGENT_ACTIVITY_TYPE`, `B4SubagentActivityContent`, `SubagentActivityCard`, `b4SubagentActivityRenderer`, `subagentActivityContentSchema`, `SubagentActivityContentOutput`; `b4ActivityRenderers` holds the plan renderer only. New in `@b4run/ag-ui/react`: `useSubagentRuns(agent)`, `reduceSubagentRuns`, `EMPTY_SUBAGENT_RUNS`, `isSubagentMessage`, `SubagentPanel` and the `SubagentRun` types. `GET /agui/:routeId` advertises `multiAgent: { supported, delegation, handoffs: false, subagents: [{ name, description }] }` from the subagent registry the `task` tool dispatches from. The research example, the research scaffold and the chat web client render subagents with the panel.
- d58cf4d: The approval card drops a lone wrapping object argument's prefix (`flightPlan.item7` reads `item7`), and the navlog dock's disabled-input placeholder is shorter and never wraps.
- b25fc3b: A route can require approval on every call of a tool, with no standing approval possible: write the `tools.approve` entry as `{ tool: "fileFlightPlan", allowAlways: false }` instead of the bare name (bare names keep today's behavior, and the two forms mix in one list). For such a tool every call prompts in interactive mode even when the permission store holds an allow rule for it, the interrupt envelope carries `allowAlways: false`, and the AG-UI interrupt advertises `responseSchema.enum: ["once", "deny"]`, so the activity kit's approval card offers only Allow once and Deny. A client that answers `always` anyway gets `once`: the call runs, nothing is persisted, and the step records `once`. Bypass mode still allows and a deny rule still denies; non-interactive mode and contexts without interrupts fail closed, an allow rule notwithstanding, so a headless run of such a tool needs bypass. `@b4run/sdk` exports `ApproveEntry`, `NormalizedApproveEntry` and `normalizeApproveEntries`; `b4 check` validates the object form (unknown names, malformed entries, overlap with `constrain`), and the reserved `task` check covers it. The navlog example and scaffold approve `fileFlightPlan` this way, so on a shared permission store one visitor can no longer approve filing for everyone.
- 0231fb5: Align on AG-UI 1.0.2 and CopilotKit 1.77.1. `@b4run/ag-ui` and `@b4run/cli` now depend on `@ag-ui/core` (and `@ag-ui/encoder`) 1.0.2, the release CopilotKit 1.77.1 and `@copilotkit/angular` 0.5.3 are built on, so an app using them resolves one `@ag-ui/core` version with B4.run. The navlog scaffold generated by `create-b4-app` pins `@ag-ui/client` 1.0.2 and `@copilotkit/react-core`/`@copilotkit/runtime` 1.77.1. The optional peer ranges are unchanged: `@ag-ui/client` `>=1.0.1 <2.0.0` and `@copilotkit/react-core` `>=1.76.0`.
- a5b0f48: `forwardIdentity({ headers, resolve })`, from `@b4run/ag-ui/client` and `@b4run/ag-ui/copilotkit-runtime`, returns a `fetch` for a server-side route that talks to B4.run on a browser's behalf, such as a CopilotKit runtime route. On every upstream call it strips the declared identity headers from whatever the call carried, so a browser can't forge them, then sets the current caller's values. Pass it to both `B4HttpAgent` and `createB4AgentRunner`, and read the headers back in the app's `src/auth.ts`. The navlog template's runtime route now uses it instead of a hand-written wrapper.
- 4f66bec: `@b4run/memory-pgvector` no longer registers pgvector type parsers from the pool's `connect` event. That call could not be awaited, so a freshly opened connection reached its caller while the type lookup was still running and the caller's first statement landed on a busy client: pg's "Calling client.query() when the client is already executing a query" deprecation, which pg@9 turns into an error. Nothing in the store reads a vector-typed column, so no parser is needed.

  The navlog scaffold's `getAdvisories` tool normalizes aviationweather.gov advisories: fields AWC sends as null are omitted instead of reading `"null"`, validity times are ISO 8601 for every product (the G-AIRMET expiry and AIRMET/SIGMET times arrive as epoch seconds), altitudes read "surface", "freezing level" or "4,000 ft", freezing-level contours report their level, AIRMETs are labelled AIRMET, and a G-AIRMET's cause is kept.

- b7ac51d: The navlog template plans from a demo aircraft baseline, `workspace/aircraft/c172n.md` (N734ST, 50 gal usable, 2400 RPM), which the agent reads with `readDoc` alongside `recall`; a recalled fact overrides it and the pilot's request overrides both. Its `b4.config.ts` wraps the workspace filesystem with a `readOnlyPaths` middleware, so the agent can no longer rewrite `AGENTS.md`, `aircraft/`, `poh/` or `regs/`, which every thread shares. The template now depends on `@b4run/workspace`. It also sets `agentsMd: { writable: false }`, so `AGENTS.md` is injected as read-only guidance rather than with an instruction to update it.
- 2ab47d1: The navlog scaffold's agents brief like a pilot would. The weather subagent opens with a GO, CAUTION or NO-GO verdict and the forecast horizon, and tags each advisory with its altitudes, valid window and whether it falls during the flight. The planner answers with a bottom line, up to three hazards, the numbers (ETE is takeoff to landing; fuel burned already includes start, taxi and takeoff) and its assumptions, and after filing says the plan was recorded in the workspace, not transmitted.
- 01e32ae: The navlog template's memory panel takes less of the chat dock: each candidate is one row with Approve and Delete beside its text, the namespace and confidence move to the tooltip, and the panel is capped at 30% of the dock (25% on a phone) instead of 40%.
- 37d02b5: The navlog scaffold's `computeNavlog` and `fileFlightPlan` accept a departure with the day the pilot named, `"tomorrow 1500Z"` or `"1500Z tomorrow"` (and `"today …"`). "Tomorrow" is the first such time at least 12 hours ahead, so a pilot asking in the morning or the evening of any US time zone gets their tomorrow; a bare `1500Z` is still its next occurrence. The planner passes the day through to the navlog and the weather brief instead of dropping it, which had put a "tomorrow" flight on today's date.
- a5949f1: The `navlog` scaffold ships a visitor principal (`src/auth.ts`), route middleware and a thread-access policy that are inert in development and turn on behind a proxy that sets `B4_INTERNAL_TOKEN`, a memory backend switch to Postgres + pgvector on `DATABASE_URL`, and proxy guards in the Workbench (origin allowlist, per-visitor cookie, per-visitor and per-IP rate limit, token injection, owner-only memory approval). The scaffold gains three dependencies, `@b4run/memory-pgvector` (server) and `@upstash/ratelimit` and `@upstash/redis` (web), and now builds the `node` target only, since a thread-access policy cannot ship to LangSmith. The example repository adds a Railway Dockerfile and a Vercel project config for the live demo.
- 194fab1: The navlog scaffold's READMEs, code comments, the `create-b4-app` README and its post-scaffold hint for the `basic` template describe the flight planner; the docs recipes moved to `/docs/recipes/flight-planner` and `/docs/recipes/flight-planner-web-ui` (the old URLs redirect).
- 84e4dde: The navlog scaffold's weather-brief parser reads airport lines that arrive without their "Airports:" header. A model sometimes writes them straight after "Forecast horizon:", which used to fold them into the horizon, leave the brief with no airports, hide the weather strip and switch off the verdict floor.
- 936b7bf: The navlog scaffold's route map honors `prefers-reduced-motion` fully: besides skipping the animated fit to the route, it turns off Leaflet's tile fade, zoom animation and marker zoom animation.
- fbbfba6: The `navlog` scaffold's Workbench is map-first: a full-viewport route map (Leaflet, OpenStreetMap), a floating chat dock, flight-category chips with matching airport markers, and a bottom navlog sheet with the legs table, the ICAO flight plan, the brief, print and copy. Phones get one tabbed bottom sheet.
- b403739: The navlog scaffold's `computeNavlog` accepts a wind with no forecast temperature (`tempC: null`), which is what `getWindsAloft` returns at 3,000 ft. The planner's first call had failed schema validation on every route flown low enough to use that level.
- aa14c62: The navlog scaffold resolves the departure time once with a new `resolveDeparture` tool, and the planner hands the same UTC instant and hours-ahead figure to the weather subagent and to `computeNavlog`. The weather subagent no longer works out "tomorrow" itself, which had put a departure 15 hours out at 39 and marked a covered brief preliminary.
- 4794753: The `navlog` scaffold is now a Cessna 172N VFR flight planner: live aviationweather.gov tools (no key), a POH-grounded `computeNavlog` tool, `weather` and `performance` subagents, and `fileFlightPlan` behind per-call approval. The research corpus, `searchCorpus`, the `researcher` subagent, `runBash` and the Docker sandbox seam are gone from the scaffold. `npm test` runs keyless unit tests of the math and parsers; `npm run eval` replays scripted cases without a key.
- 4412897: The navlog scaffold's `getTaf` tool returns each forecast group decoded: its UTC window, ceiling, visibility, wind, weather and flight category. The weather subagent reads the TAF at the ETA from these periods instead of decoding day-hour groups such as FM080200 itself, which had placed a change 13 hours before departure "after arrival".
- 53e3716: The research scaffold is now the `navlog` template: `npm create b4-app -- --template navlog`. The `research` id still works in `create-b4-app` for one release and prints a deprecation notice; `@b4run/devkit`'s `resolveTemplateDir` accepts only `basic` and `navlog`. The scaffold's route is now `/navlog` (`/navlog#agent`). Only names changed in this release; the flight-planning retheme follows.
- 52b19ec: The navlog template's server `tsconfig.json` now typechecks its `test/` files too (with `allowImportingTsExtensions`, since the tests import their sources with a `.ts` extension), so `pnpm typecheck` in a generated navlog app covers the tests as well as `src/`.
- b25fc3b: The navlog template's web client now enforces the weather brief's verdict rules in code. A deterministic floor (IFR or LIFR at the ETA, a reserve under 45 min: NO-GO; MVFR, gusts over 20 kt, a preliminary forecast, a freezing level near the cruise, LLWS, turbulence or convection during the flight: CAUTION) raises the agent's call when it is too optimistic, and the verdict card, the pills and the planning brief's bottom line all show the raised level with the reasons and the agent's own call. The planning brief's closing question no longer lands under Assumptions: it is parsed as a separate closing and shown after the sections, on screen only.
- 2ab47d1: The navlog template's chat dock reads like a flight-planning tool rather than developer output. Tool cards show a plain title and a one-line result summary ("Current weather (METAR) for KFCM, KDLH", "2 airports VFR"), with the raw arguments and result behind a Details button, and never show memory record ids. The transcript stays with the newest output while you are at the bottom and offers "Jump to latest" when you scroll up. The composer's message box takes the full width and grows to eight lines, with the attach, hint and Send controls in a row below it. The flight plan approval summarizes the plan in one line and offers only "Allow once" and "Deny". A restored conversation shows its plan as the Plan card instead of raw `writeTodos` JSON. Each subagent card appears under the call that started it instead of after every later message. The header gives the conversation title its own row, with a Running, Awaiting approval or Ready status.
- 2ab47d1: The navlog template's map side shows the go/no-go call. A verdict card tops the navlog sheet (and a verdict pill the weather strip) with GO, CAUTION or NO-GO as a word, an icon and a color, the reason, and hazard chips parsed from the weather brief's advisories — during-flight hazards in amber, or red for icing and convection at or below the cruise altitude, the rest muted with their relevance. The verdict comes from the brief's `Verdict:` line, else the planning answer's `Bottom line:`; older briefs show no card. A preliminary brief says so. Winds aloft read as words (`Winds 5,500 ft: 318° at 26 kt (MSP, 24 h forecast)`) with the raw line one click away. The sheet's brief is now the planning answer of the turn that computed the navlog, with echoed tool calls and the plan checklist stripped (`stripToolEchoes` in `lib/assistant-text.ts`), rendered as its Watch for / Numbers / Assumptions sections. A reloaded thread keeps its weather strip and marker colors (read from the restored `task` call). Leaflet's controls move to the bottom right above the sheet, each airport is one marker with one label, the map paints the tiles' own color while they load, the totals are stat tiles, the table header sticks, phone leg cards carry fuel remaining, the phone sheet lowers to a peek, and the variation is footnoted as coming from the FAA airport record.
- feb5f9a: The navlog template's `getWindsAloft` takes the time the leg is flown (`validAtUtc`: the departure or the leg's ETA) instead of forecast hours, reads the 6-, 12- and 24-hour FB products and uses the one whose FOR USE window contains that time, returning the window as UTC instants. When no published product covers the time yet it says so (`covered: false` with a note), so the brief marks the winds preliminary. The weather subagent no longer works out forecast hours itself.
- 4e794d7: The navlog scaffold's `getWindsAloft` reads the shortest published winds-aloft forecast (6, 12 or 24 hours) that reaches the requested hours ahead, instead of rejecting anything but those three values. A model that asks for the wind one hour out now gets the 6-hour product on the first call rather than an error and a retry; a period past 24 hours, or a negative one, is still refused.
- 03fb4e6: `ownedThreads({ owner?, adminsRead? })` is the common thread-access policy as a value. Each caller reaches only the threads it created, stamped `{ ownerId }` from its principal, and `adminsRead` principals may also read the rest. It denies an anonymous caller, and denies a missing row ahead of any admin branch, so "not yours" and "never existed" stay the same answer. The `create-b4-app` templates now use it in place of a hand-written policy. `ownedThreadsOptions(policy)` reads its options back, for build targets that translate it.
- bcfc8b8: An app can now declare one place that resolves who is calling: `src/auth.ts` default-exports `defineAuth({ authenticate })`. B4.run calls `authenticate` once per request, before middleware and the thread-access policy, and passes the result to middleware and the thread-access policy as `req.principal` and to every tool as `ctx.principal`. A principal is any object with a string `id`. `undefined` makes the request anonymous, `reject(...)` answers it before any endpoint runs, and a throw or malformed result fails it with a 500.

  `b4 typegen` declares the type `authenticate` resolves to on `B4Register`, so `ctx.principal` is typed. The node and web build targets carry `src/auth.ts` in their build, and the `langsmith` target refuses an app that has one. An auth file that does not default-export `defineAuth` fails the boot with `B4_E3005`. The harness takes a `principal` option, and `createAgentProtocolInjector` takes `auth`.

  **Breaking:** `ThreadAccessRequest.headers` is removed. A thread-access policy that read identity from headers must move that read into `src/auth.ts` and use `req.principal`. The `basic` and `navlog` templates are migrated, and the `navlog` template no longer ships `src/middleware.ts`.

## 0.13.1

### Patch Changes

- 0c76234: Move to AG-UI protocol 1.0 (`@ag-ui/core`/`@ag-ui/encoder` 1.0.1; `@ag-ui/client` optional peer `>=1.0.1 <2.0.0`; validators at `@ag-ui/core/schemas`). Approval grants (new in this release) travel over AG-UI in `metadata.grant` only, on interrupts and on resume entries; a 1.0 client strips a top-level `grant` in both directions. Breaking for AG-UI clients relative to 0.13.0: a cancelled or shut-down run ends with `RUN_FINISHED { outcome: cancelled }` instead of `RUN_ERROR`; a request declaring a foreign protocol major is refused with `400 unsupported_protocol_version`; a null route result is omitted rather than sent as `result: null`; messages carrying image, audio, video or document parts are refused with `422 multimodal_not_supported` until multimodal input lands. `RUN_STARTED` declares `protocolVersion: "1.0"`; a turn that leaves client-provided tool calls parked names them in `outcome.pendingToolCallIds`; 1.0 content parts are read as text; reasoning and activity history is dropped on the way in. Examples and the research scaffold pin CopilotKit 1.76.0 and `@ag-ui/client` 1.0.1 exactly.
- c726631: CopilotKit 1.76 hands `useAgent` a replacement agent instance for the same thread a beat after first render. The research web app applied a restored transcript to the first instance, so a reloaded thread came back empty in the browser. The app shell now carries an applied restore over to an empty, idle replacement instance for the same thread.

## 0.13.0

### Patch Changes

- 03795da: A Docker command that exits before reading its stdin no longer crashes the process with an uncaught `EPIPE`. The Docker client and the devkit test process helper now ignore `EPIPE` on the child's stdin, where the exit status already reports the failure, and still surface any other stdin error. Batched workspace reads send their scripts over stdin, which made this reachable.

## 0.12.0

## 0.11.2

## 0.11.1

### Patch Changes

- 837bcfb: `@b4run/cli` now exports the `B4Config` type alongside `config()`. Under pnpm's isolated `node_modules`, an app depends only on `@b4run/cli` and cannot resolve `@b4run/core`, so `export default config({})` in `b4.config.ts` failed `tsc` with TS2883 (the inferred `B4Config` type could not be named). This affected the research template. The basic template's `b4.config.ts` now uses `config({})` too.

## 0.11.0

### Patch Changes

- 24fd0fd: The basic template now scaffolds a single `/hello` agent route with one typed `greet` tool. It drops the route group, the `[tenant]` segment and `state.ts`, so a new app starts with the smallest working agent.

  `basic` is now the default template, so `npm create b4-app@latest my-agent` scaffolds it. The research workspace is still available with `npm create b4-app@latest my-agent -- --template research`.

## 0.10.0

## 0.9.0

## 0.8.36

## 0.8.35

## 0.8.34

## 0.8.33

## 0.8.32

### Patch Changes

- 0003db2: Breaking change: Docker and Kubernetes sandbox providers now require a stable
  application/environment `scope`. All resource names hash scope and thread ID,
  preventing collisions caused by the previous thread-name normalization. Research
  scaffolds now supply scope explicitly.

  Existing resources use different names and are not automatically reattached,
  migrated, or deleted. Export required data before upgrading and manage old
  resources explicitly. Scope is not authorization or cross-process coordination.

## 0.8.31

## 0.8.30

## 0.8.29

## 0.8.28

## 0.8.27

## 0.8.26

## 0.8.25

## 0.8.24

## 0.8.23

### Patch Changes

- 21654e8: Align the CopilotKit v2 examples, research scaffold, and Dawn AG-UI runtime on CopilotKit 1.70 and AG-UI 0.0.59.
- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.

## 0.8.22

### Patch Changes

- 95abcf5: Expose Dawn planning and subagent progress as bounded standard AG-UI activity
  snapshots. The research web example renders plan checklists and delegated-work
  status from those snapshots, which exclude child prose, prompts, tool inputs,
  tool outputs, and final child answers. The generated research starter renders these
  activities in the web client it ships.
- bedad77: Documentation only: every public export of this package now has an API reference
  page on dawnai.org, and the package README leads with a concise entrypoint. No
  runtime behavior changed.
- 0bf4ed9: Leave CopilotKit telemetry off in a scaffolded app.

  CopilotKit's runtime reports usage by default, so `npm run build` on a freshly
  generated app POSTed to `https://telemetry.copilotkit.ai/ingest` while Next
  collected page data — before the author had written a line of code. The
  generated `web/next.config.mjs` now sets `COPILOTKIT_TELEMETRY_DISABLED` unless
  the environment already says otherwise, so opting back in is still one variable
  away.

  The placement is the fix, not a detail. CopilotKit builds its telemetry client
  at module scope and reads the environment inside that constructor, and ESM
  evaluates imports before the importing module's body — so setting this in the
  route handler that imports the runtime would look correct and change nothing.
  `next.config.mjs` is the first module Next evaluates, for `next build`,
  `next dev` and `next start` alike.

- 56d2758: Scaffold the Dawn Workbench alongside the agent.

  `npm create dawn-ai-app` now generates a two-package npm workspace instead of a
  flat server-only app. `server/` holds everything that used to sit at the project
  root and runs on port 3002; `web/` is the Dawn Workbench — a Next 16 client with
  a thread rail, a streaming transcript, plan and subagent activity cards, tool
  cards, permission prompts that survive a reload, a memory-candidate panel, and a
  connect screen — on port 3010. One `npm install` at the root installs both, and
  the root scripts delegate into the package that owns each job.

  The template's web tree mirrors `examples/research/web` under a parity guard that
  compares the two trees byte-for-byte, so the shipped scaffold cannot drift from
  the example it is dogfooded against.

  Two fixes fall out of the restructure. `dawn verify`'s dependency probe now walks
  parent `node_modules` directories the way Node itself resolves, so hoisted
  workspace dependencies are no longer reported as missing. And the generated web
  package ships an ambient CSS declaration, so `npm run typecheck` succeeds on a
  freshly scaffolded app rather than only after a build has generated Next's own
  type declarations.

- 8ec1cfa: Point new users at a UI after scaffolding. The research template's next steps
  name `npx dawn inspect` (the Inspector the template already installs), and the
  basic template no longer points at a README it does not ship.
- d42774e: **Breaking:** scenario files must default export `scenarios("<route>")` from
  `@dawn-ai/sdk/testing`. A plain default-exported array now throws
  `RunScenarioLoadError` at load; wrap the array in `scenarios("/route")` to
  migrate.

  Add route-scoped fluent `dawn test` scenarios with generated application-tool
  types, invocation-local in-process tool mocks, and declarative mock call
  assertions.

- 1f5f3f8: The research scaffold gains a complete npm lifecycle (`install` → `verify` →
  `dev`) and an explicit `.env` handoff, and its AG-UI wiring is checked against
  the packaged build.

## 0.8.21

## 0.8.20

## 0.8.19

## 0.8.18

### Patch Changes

- 7088072: Fix two defects found smoke-testing the published 0.8.17 artifacts.

  **`dawn memory` subcommand flags were rejected by the CLI.** `memory` is registered as
  `memory [subcommand] [args...]`, and commander claimed every `--flag` after the
  subcommand for itself — so each one failed with `error: unknown option` before the
  handler that parses it ever ran. This made every documented subcommand flag unusable
  from the real CLI: `prune --cap`, `prune --namespace`, and all five distillation flags
  (`--dry-run`, `--namespace`, `--model`, `--provider`, `--max-batches`), including the
  `--dry-run` the cron recipe recommends for a zero-cost plan. The `prune` flags have been
  broken since they were introduced; the distillation flags since 0.8.17.

  The command now uses `passThroughOptions()` (with `enablePositionalOptions()` on the
  program, which commander requires for it). The flags reached the handler correctly all
  along — the repo's tests called `runMemoryCommand([...])` directly and so never crossed
  commander's parsing layer. Added tests that drive the real program.

  **A fresh `create-dawn-ai-app` research app failed `npm test` out of the box.** The
  research template's `test/research.test.ts.template` is kept exactly in sync with the
  dogfooded `examples/research/server/test/research.test.ts`, but the Memory Inspector
  change that reworded CLI approve output to `approved <id> (activated)` updated only the
  example. The template kept asserting `Approved: <id>`, so the default template — the one
  whose generated README tells users to run `npm test` — shipped a failing suite from
  0.8.14 through 0.8.17. Fixed the assertion and added a parity test asserting the shared
  test files stay identical, so the example can no longer be fixed without the template.

## 0.8.17

### Patch Changes

- 1a9ae7b: Support TypeScript 7 workspaces and generated apps, and move Dawn's Next.js applications
  to Next 16.3's experimental CLI type checker with `experimental.useTypeScriptCli`.

  Consolidate tool analysis in Core behind one compiler boundary and program, with shared
  projections for declarations, JSON Schema, and Vite Zod metadata. Core internally pins
  the exact TypeScript 6 compatibility wrapper and implementation until the native compiler
  API can be revisited for TypeScript 7.1. Generated JSON schemas now preserve mapped-type
  optionality and use a compiler-neutral fallback for collection intersections.

  Generate collision-safe Vite metadata bindings and remove the unsupported `extractJsDoc`
  and `extractParameterType` exports. Their removal is an intentional breaking change.

  Add permanent packed-consumer and exact-version post-publish verification for the
  TypeScript tooling packages.

## 0.8.16

### Patch Changes

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).
- 3b8ffd5: Scaffold templates now pin `vitest` with a caret (`^4.1.10`) instead of an exact
  stale version. The old exact `4.1.4` pin made fresh `npm install`s crash with
  npm's arborist `edgesOut` bug after an upstream peer-landscape change (vitest
  ≤4.1.9 became uninstallable under npm's strict peer resolution) — a failure
  mode a caret range rides out automatically. Existing broken scaffolds can fix
  themselves with `npm install --legacy-peer-deps` or by bumping `vitest` to
  `^4.1.10`.

## 0.8.15

## 0.8.14

### Patch Changes

- 937be0f: New `@dawn-ai/inspector`: a browser-based runtime inspector (`dawn inspect`) with a
  Memory panel — browse, search (recall-equivalent hybrid), inspect, and govern
  memories with supersede-aware approval. Ships as a scaffold devDependency.

  BREAKING: `MemoryStore` now requires `browse(q?)` and `stats(opts?)`; custom stores
  must implement them (the built-in sqlite/pgvector stores already do, and
  `runMemoryStoreConformance` enforces the contract). The config-facing store type is
  now the full `MemoryStore` contract. `dawn memory approve` now supersedes a
  contradicting active row instead of leaving two actives.

## 0.8.13

### Patch Changes

- a7e4ced: Improve the getting-started experience for scaffolded apps. `create-dawn-app`
  now prints next-steps guidance after creating an app (cd / install / test / run
  it live), the templates gain a `dev` script (`dawn dev --port 3000`) so you can
  actually run the agent, and the research template README shows the live path
  (ask a question via `/agui`) plus a pointer to the web-UI recipe.

## 0.8.12

## 0.8.11

## 0.8.10

## 0.8.9

## 0.8.8

### Patch Changes

- 6fb2b10: Improve the default scaffold and packaged external verification.

  The research scaffold now dogfoods reviewable memory and the Docker sandbox,
  shared scaffold tools can run through sandbox-aware workspace APIs, generated
  apps use pnpm 11 build policy in `pnpm-workspace.yaml`, and packaged scaffold
  tests install the current packed devkit templates instead of stale registry
  contents.

## 0.8.7

### Patch Changes

- ef2e583: Fix fresh scaffolds failing `npm install`: the app templates pinned `zod@^3.24.0` while `@dawn-ai/sdk` declares an optional peer of `zod@^4`, which npm's strict peer resolution rejects (ERESOLVE) on every new app. Templates now scaffold `zod@^4.0.0` (the template code uses only APIs present in both majors, and `@langchain/core` accepts `^3.25.76 || ^4`).

## 0.8.6

## 0.8.5

## 0.8.4

## 0.8.3

### Patch Changes

- 2744a5c: Add long-term memory. Routes gain a typed, cross-session memory collection via
  `defineMemory({ kind, scope, schema })` in `memory.ts` — the agent gets generated
  `remember`/`recall` tools backed by a namespaced `@dawn-ai/memory` store
  (node:sqlite, deterministic keyword+recency recall). Plus route-local `memory.md`
  profile injection and a `dawn memory` CLI (list/search/inspect/approve/reject/forget).
  Writes default to a `candidate` queue (config `memory.writes`). Ships the `semantic`
  kind; vector recall, episodic/procedural kinds, and the dev inspector UI are deferred.
  The research scaffold template now ships a `memory.ts`/`memory.md` example.

## 0.8.2

## 0.8.1

### Patch Changes

- 306380e: Fix test-harness scenario isolation. `createAgentHarness().reset()` now clears
  the accumulated aimock fixtures (restoring the constructor baseline) instead of
  only swapping the thread id. Previously fixtures were registered additively and
  aimock's matcher is first-match-in-array-order, so a loosely-matched fixture
  from an earlier scenario (a raw `FixtureSet` without a `userMessage`, e.g. the
  offload pattern) could shadow a later run's first model call. This surfaced as a
  HITL permission interrupt that "only fired on the first run." The research
  scaffold's HITL test now shares one harness with `reset()` between tests instead
  of constructing a dedicated one.

## 0.8.0

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

## 0.7.0

### Minor Changes

- 16268a6: Add a "research" scaffold template — a deep-research assistant that showcases
  Dawn's broad capability set (planning, subagents, custom tools + typegen,
  tool-output offloading, AGENTS.md memory, skills, HITL permissions, workspace,
  persistence, tests, and evals) — and make it the default `create-dawn-ai-app`
  output. It runs offline and deterministically out of the box (replay fixtures)
  and against a real model under `--live`. The minimal "basic" template remains
  available via `--template basic`.

### Patch Changes

- c35ccba: The research scaffold template now defaults to the `gpt-5-mini` model (was `gpt-4o-mini`) for its coordinator, researcher subagent, and eval judge.

## 0.6.0

### Patch Changes

- 95ae2f9: `create-dawn-ai-app` now scaffolds a sample `@dawn-ai/evals` eval (`evals/smoke.eval.ts`) plus an `eval` script in new apps, alongside the existing `@dawn-ai/testing` sample test, so a freshly scaffolded app can run `dawn eval` out of the box.

## 0.5.0

## 0.4.0

### Patch Changes

- 1387bd5: `create-dawn-ai-app` now scaffolds a working `test/agent.test.ts` in new apps: it imports `@dawn-ai/testing`, adds it (plus `vitest`) to devDependencies, and wires a `"test": "vitest run"` script. The sample drives the generated `hello/[tenant]` agent route through `createAgentHarness` with an inline `script()` fixture, so a freshly scaffolded app has a passing, CI-safe agent test out of the box. This was deferred until `@dawn-ai/testing` was published to npm (now at 1.0.0).

## 0.3.0

## 0.2.0

### Patch Changes

- 82dd52f: Correct package README links and CLI/runtime examples, export the SDK reasoning type, and fix `dawn build` agent deployment entry generation.

## 0.1.8

## 0.1.7

## 0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

## 0.1.2

## 0.0.4

### Patch Changes

- fbe7770: Add codegen wiring to dawn dev and build commands

  - `dawn typegen` now emits `.dawn/routes/<id>/tools.json` and `.dawn/routes/<id>/state.json` alongside the existing `.dawn/dawn.generated.d.ts`
  - `dawn dev` runs typegen on startup and re-runs on state.ts/tools changes (path-based watch routing with 100ms debounce)
  - `dawn build` runs typegen as a pre-step after route discovery
  - App template includes zod-based state.ts for stateful route scaffolding

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.
