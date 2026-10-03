# AG-UI 1.0 sub-project 4 — HTTP+protobuf binding, the remaining capability sections, and two parked decisions

**Date:** 2026-10-01
**Status:** Approved design (issue cacheplane/b4run#887)
**Sub-project:** 4 of 4 of the AG-UI 1.0 cut-over
(`docs/superpowers/specs/2026-10-01-ag-ui-1-0-cutover-design.md` §9)
**Delivered as:** three pull requests (§7)

## 1. Where this starts

- PR #888 (merged 2026-10-01) moved B4.run to `@ag-ui/*` 1.0.1.
- PR #883 (open, approved) adds `GET /agui/:routeId`
  (`packages/cli/src/lib/dev/agui-capabilities.ts`), where every claim is
  derived from the code that enforces it. It advertises
  `transport: { streaming: true }` and nothing else about transport.
- Sub-project 2 (#885, not started) adds the outbound events — `REASONING_*`,
  `SUBAGENT_*`, `STATE_*`, `STEP_*`, `ACTIVITY_DELTA`, `usage` — that most of
  the `reasoning`, `state` and `multiAgent` sections describe.
- The AG-UI handler (`packages/cli/src/lib/dev/agui-handler.ts`) answers
  only `text/event-stream`: three literal `content-type` headers and
  `encodeAgUiSse` (`packages/ag-ui/src/sse.ts`), which returns a string.
  `@ag-ui/encoder` 1.0.1 — already a dependency of `@b4run/ag-ui` — ships
  `encodeBinary` and `getContentType`, and `@ag-ui/proto` 1.0.1 is installed
  through it.
- `dependency-security-browser` (`.github/workflows/ci.yml`, added by #888)
  runs the only end-to-end CopilotKit → B4.run check. It is advisory: the
  required `validate` job aggregates exactly four lanes.
- `@b4run/ag-ui` declares `@copilotkit/react-core >=1.66.0` as an optional
  peer. Below 1.76.0 CopilotKit resolves `@ag-ui/*` 0.0.59.

## 2. Decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | Base and scope | Stack on #883 (`blove/agui-capabilities`). Ship the protobuf binding plus only the `reasoning`/`state` claims the current code already settles. #885 flips its own claims when it lands. |
| 2 | Accept negotiation | Upstream's: `EventEncoder`'s negotiator. An `Accept` that admits `application/vnd.ag-ui.event+proto` with positive quality — explicitly, through `application/*`, or through `*/*` — selects the binary binding; anything else (including no header) is SSE. This is the spec's SHOULD; `@ag-ui/client` 1.0.1 sends `Accept: text/event-stream` explicitly, so CopilotKit is unaffected. |
| 3 | `multiAgent` section | Omitted (UNKNOWN). Subagent tooling is app-wired, not route-declared, and no `SUBAGENT_*` event exists yet. #885 adds the section with the events. |
| 4 | `state` section | `{ snapshots: false, deltas: false, persistentState }` where `persistentState` is `true` for an `agent()` descriptor route (its compiled graph embeds the boot checkpointer), `false` for a chain, graph or workflow route (invoked once without one), and omitted for an agent route exporting a raw runnable and for a boot that cannot load route modules — the raw runnable is never handed the checkpointer, so persistence is its own code's to decide (review refinement of the original "from `route.mode`" rule). `memory` omitted: whether an app wires long-term memory is per-app tool wiring the handler cannot see. |
| 5 | `reasoning` section | `{ supported: false }` for every route: the translator has no `REASONING_*` branch and the langchain adapter's `chunkText` keeps only `text` blocks. |
| 6 | CopilotKit runtime CI step | Becomes the fifth `validate` lane (PR 2). |
| 7 | `@copilotkit/react-core` peer floor | Rises to `>=1.76.0` (PR 3). |
| 8 | WebSocket | Not warranted. No client asks for it, and persistent sockets on the Vercel/edge targets are a separate project. `transport.websocket` stays omitted. |
| 9 | Encoder seam | `encodeAgUiSse` is replaced (breaking) by `encodeAgUiEvent` + `agUiContentType` on the same `./sse` subpath. |
| 10 | PR decomposition | Three PRs: transport (stacked on #883), CI lane, peer floor. |

## 3. PR 1 — the HTTP+protobuf binding and the honest sections

### 3.1 `@b4run/ag-ui/sse`

`packages/ag-ui/src/sse.ts` exports two functions; `encodeAgUiSse` is
removed.

```ts
/** One AG-UI event as the bytes of the binding `accept` selects. */
export function encodeAgUiEvent(event: BaseEvent, accept?: string): Uint8Array
/** The content type of the binding `accept` selects. */
export function agUiContentType(accept?: string): string
```

Both construct `new EventEncoder(accept ? { accept } : {})` and delegate to
`encodeBinary` / `getContentType`. Under SSE, `encodeBinary` is the UTF-8
bytes of `data: <json>\n\n`; under protobuf it is a 4-byte unsigned
big-endian length followed by exactly that many bytes of one encoded event,
frames abutting with no separator. One negotiator decides both the header
and the frames, so they cannot disagree.

The rename is deliberate: a function named `encodeAgUiSse` that returns
protobuf would lie. The subpath keeps its `./sse` name — the public surface
catalog (`apps/web/content/docs/api.mdx`) pins subpaths, and the subpath
now serves both AG-UI HTTP bindings.

This is a breaking change to a public export on the 0.x train. The
changeset is `patch` (fixed group) with a **Breaking** paragraph naming the
old and new functions and the one-line migration
(`response.write(encodeAgUiEvent(event, accept))` works unchanged in Node:
`write` accepts a `Uint8Array`).

Edge safety is unchanged. `@b4run/ag-ui/sse` already imports
`@ag-ui/encoder`, which already imports `@ag-ui/proto` and
`@bufbuild/protobuf`; the edge bundle graph contains them today
(`packages/cli/test/api-reference-compatibility.test.ts` whitelists
`@bufbuild/protobuf/.../text-encoding.js`). `encodeBinary` adds no import.
`packages/cli/test/edge-bundle-purity.test.ts` and
`fetch-entry-purity.test.ts` are the proof and run unchanged.

### 3.2 The handler

`agui-handler.ts` already reads `accept` once per request. Three sites
change, and nothing else moves:

- The streaming `Response` (today `"content-type": "text/event-stream"`)
  sets `"content-type": agUiContentType(accept)` and enqueues
  `encodeAgUiEvent(event, accept)` directly — the per-request `TextEncoder`
  goes away.
- `clientToolPartialResponse` (the `done`-only body for a run whose client
  tools are all still pending) concatenates `Uint8Array` frames into one
  body and sets the same negotiated content type.
- The `cache-control: no-cache` / `connection: keep-alive` headers are
  unchanged for both bindings.

The live-turn attach path needs nothing: the tap publishes raw
`StreamChunk`s before AG-UI translation (`publishingTap`, agui-handler.ts
§"Pass-through tap"), so the bytes the primary client receives never reach
an attacher. A protobuf primary and an SSE attacher on `/threads/:id/runs/
:runId/stream` see the same turn.

### 3.3 The in-flight predicate

`isEventStream` (`packages/cli/src/lib/dev/runtime-fetch-core.ts`) decides
whether a response is still producing bytes after `fetch` resolves — it
holds the in-flight slot that delays sandbox release and per-request store
disposal. It becomes

```ts
/** True for a body the runtime is still producing after `fetch` resolves. */
export function isStreamingBody(contentType: string | null): boolean
```

true for `text/event-stream` or `application/vnd.ag-ui.event+proto`, with
parameters tolerated as today. Without this, a protobuf run would be
treated as settled the instant its headers were sent, and sandboxes would be
released under a run still using them. Every caller and the existing test
follow the rename. The `supportsResponseStreaming` comment in
`packages/cli/src/lib/build/targets/vercel-output.ts` names both media
types; the flag itself is already fixed.

### 3.4 Capabilities

`agui-capabilities.ts`:

- `TRANSPORT` becomes `{ streaming: true, httpBinary: true }`, advertised in
  the same commit that serves it.
- Every route gains `reasoning: { supported: false }` — a documented
  constant pinned on both sides: `packages/langchain/test/model-message-framing.test.ts`
  (non-text blocks carry no token) and a new `outbound.test.ts` case (no
  chunk becomes `REASONING_*`). #885 flips it and the pin together.
- Every route gains `state: { snapshots: false, deltas: false }` plus
  `persistentState` where B4.run settles it: `true` for an `agent()`
  descriptor route, whose compiled graph embeds the boot checkpointer;
  `false` for a chain, graph or workflow route, invoked once without one;
  omitted for an agent route exporting a raw runnable (the adapter never
  hands it the checkpointer, so its own code decides) and for a boot that
  cannot load route modules (it cannot tell the two apart). `snapshots` and
  `deltas` are false because no code emits `STATE_SNAPSHOT` or
  `STATE_DELTA`.
- A boot that cannot load route modules answers `transport`, `reasoning`
  and `state: { snapshots: false, deltas: false }` — the claims that need no
  module — and nothing else.
- The module comment's claim list grows by these entries and by the explicit
  omissions: `multiAgent`, `state.memory`, `transport.websocket`,
  `transport.resumable`, `transport.pushNotifications` — each with the
  reason it is UNKNOWN rather than false.

### 3.5 Tests

1. `packages/ag-ui/test/sse.test.ts`: SSE bytes for no Accept and for
   `text/event-stream`; a protobuf frame for the proto media type and for
   `*/*`, checked by reading the 4-byte big-endian length, slicing, and
   `decode`-ing with `@ag-ui/proto` (a new `@b4run/ag-ui` devDependency,
   exact `1.0.1`, matching the lockfile's existing copy); `agUiContentType`
   agrees with the frame kind in every case; an `Accept` that lists both
   with `text/event-stream;q=1` and the proto type with `q=0` is SSE.
2. `packages/ag-ui/test/conformance.test.ts`: the canned server answers with
   the negotiated binding, and a new case drives the real `HttpAgent` with
   `Accept: application/vnd.ag-ui.event+proto` and asserts the same event
   sequence as the SSE case. The client's own `parseProtoStream` is the
   decoder (it switches on the response content type), so the test uses no
   hand-rolled frame reader.
3. `packages/cli/test/agui-endpoint.test.ts`: a protobuf run against the
   real dev server — response content type, every frame decodes, the
   sequence equals the SSE run's; the client-tool partial response in
   protobuf; `isStreamingBody` for both media types and for neither. The
   frame reader lives in the test and tolerates frames split across chunks.
   `@ag-ui/proto` is added to `@b4run/cli` devDependencies for it.
4. `packages/cli/test/agui-capabilities.test.ts`: `transport.httpBinary`,
   `reasoning` and `state` for an agent route and a graph route; the
   "cannot load route modules" case returns exactly `transport`,
   `reasoning` and `state`; the
   "agrees with what POST enforces" block gains a protobuf `POST` whose
   content type matches the advertised binding.
5. `packages/ag-ui/test/outbound.test.ts` and `public-api.test.ts` follow
   the rename.

### 3.6 Documentation and release

- `packages/ag-ui/README.md`, `apps/web/content/docs/ag-ui.mdx`,
  `apps/web/content/docs/api.mdx` (§"SSE subpath") and
  `apps/web/content/docs/api/ag-ui.mdx` (the `api-contract` line and the
  `./sse` table) show `encodeAgUiEvent` / `agUiContentType` and state the
  negotiation rule in one sentence each: the binding follows `Accept`; a
  client that cannot read protobuf names `text/event-stream`.
- `ag-ui.mdx`'s capabilities section lists `transport.httpBinary`,
  `reasoning` and `state` next to the existing claims, and names what stays
  UNKNOWN until sub-project 2.
- `pnpm --dir apps/web seo:lastmod` after the content commit.
- Changeset: `@b4run/ag-ui` and `@b4run/cli`, `patch`, with the Breaking
  paragraph (§3.1).

## 4. PR 2 — the fifth `validate` lane

`dependency-security-browser` becomes required.

- `ci.yml`: `validate.needs` gains `dependency-security-browser`; the
  "Require every validation lane" step gains
  `LANE_4: ${{ needs.dependency-security-browser.result }}` and its loop
  reads `"$LANE_4"`. The job's own `if` already yields `skipped` on a
  prose-only PR — exactly what the step expects there — and `success`
  otherwise; its descriptor does not change.
- The audited pins are hand-transcribed in the same commit:
  `scripts/release/test/fixtures/workflow-entrypoints.json` (the `validate`
  job's `needs`, the `LANE_4` env entry, the new `run:` text) and
  `scripts/release/test/fixtures/workflow-safe-executables.json` (the step's
  script value). The inline pin in
  `scripts/release/test/workflow-contracts.test.mjs` covers the
  `dependency-security-browser` descriptor, which is unchanged; the plan
  confirms no `validate` pin lives there.
- `AGENTS.md` ("aggregates four independent lanes", "all four heavy lanes")
  and `CONTRIBUTORS.md` ("all four lanes") say five and name the new lane
  and its purpose.
- Proof: `pnpm test:release-integrity`, the focused contracts test, then
  `pnpm test:release-controller`.
- No changeset: CI only.
- Out of scope: `copilotkit-examples-e2e` stays a release-bearing job. It
  needs secrets and skips on software-factory PRs (#884).

## 5. PR 3 — the peer floor

- `packages/ag-ui/package.json`: `"@copilotkit/react-core": ">=1.76.0"`.
- `test/security-dependencies/dependency-resolution.test.ts`: the range pin
  follows.
- `packages/ag-ui/README.md` and `apps/web/content/docs/ag-ui.mdx`: the
  optional-peer sentence gains one clause — 1.76 is the first CopilotKit
  whose runtime speaks AG-UI 1.0, the wire B4.run serves (the grant lives
  at `metadata.grant`, a cancelled run ends with the cancelled outcome, and
  `AbstractAgent` is compared nominally).
- Changeset `patch` for `@b4run/ag-ui`, stating the install behavior as
  verified: pnpm warns on an unmet optional peer and installs; npm 7+
  rejects an installed peer outside the range with `ERESOLVE` even when it
  is optional, so an app pinned below 1.76.0 upgrades CopilotKit together
  with `@b4run/ag-ui` (or installs with `--legacy-peer-deps`). 1.76.0 is the
  first `@copilotkit/react-core` whose bundled AG-UI client is 1.0.1;
  1.70–1.75 resolve 0.0.59 and 1.66–1.69 resolve 0.0.57.
- No code change: `@b4run/ag-ui/react` imports only the
  `ReactActivityMessageRenderer` type from `@copilotkit/react-core/v2`.
- `pnpm --dir apps/web seo:lastmod` after the content commit.

## 6. Verification

Each PR: `pnpm lint`, `pnpm build`, `pnpm typecheck`, `pnpm test`, and
`node scripts/check-docs.mjs` where docs change. PR 1 additionally runs the
edge and fetch-entry purity tests and `pnpm pack:check`. PR 2 additionally
runs the release-integrity and release-controller suites. Node 24, from the
repository root.

## 7. Sequencing

1. PR 2 and PR 3 branch from `main` and can go up now, one at a time, with
   #883 counted against the two-active-PR guideline.
2. PR 1 branches from `blove/agui-capabilities`, opens against that branch,
   and retargets to `main` after #883 merges (rebase, not merge; the
   stacked-PR squash trap is the base's commits reappearing in the diff).
3. #887 closes when PR 1 merges; the issue's "websocket if warranted" line
   closes with decision 8.

## 8. Risks

- **Wildcard clients get bytes they did not expect.** A bare `curl` or a
  `fetch` with no `Accept` receives protobuf. This is the spec's rule and
  the encoder's default; documented in `ag-ui.mdx`. Every B4.run client —
  `@ag-ui/client`, CopilotKit, `b4 threads`, the examples' routes — names
  `text/event-stream`.
- **A streaming predicate misses the new media type.** Contained by §3.3's
  test for both media types and by the endpoint test, which reads a
  protobuf run to completion through the real in-flight tracking.
- **The `./sse` rename breaks an external integrator.** Contained by the
  Breaking paragraph and the one-line migration; the subpath and the
  negotiation rule are unchanged for SSE callers.
- **Two in-flight PRs touch `agui-handler.ts` and `agui-capabilities.ts`
  (#883 and PR 1).** PR 1 is stacked on #883, so there is no concurrent
  edit; it retargets after #883 merges.
