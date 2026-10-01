# AG-UI 1.0 cut-over — move B4.run to `@ag-ui/*` 1.0.1 and adopt the 1.0 wire semantics

**Date:** 2026-10-01
**Status:** Implemented on `blove/agui-1-0-cutover` (PR pending)
**Branch:** `blove/agui-1-0-cutover`
**Sub-project:** 1 of 4 (see §9 for the others)

## 1. Why now

CopilotKit 1.76.0 was published on 2026-10-01 and depends on `@ag-ui/client`,
`@ag-ui/core` and `@ag-ui/encoder` **1.0.1**. Every CopilotKit release from
1.70 through 1.75 pinned 0.0.59, which is what B4.run pins everywhere. The
research scaffold template lets CopilotKit float (`^1.70.0`) while pinning
`@ag-ui/client` exact, so a fresh `npm create b4-app --template research`
now installs both copies and fails `npm run typecheck`
(`test/generated/run-generated-research-activation.test.ts`, the
`harness-verify` lane). The failure reproduces with the stock `HttpAgent`,
not only with `B4HttpAgent`:

```
app/api/copilotkit/[...path]/route.ts(12,15): error TS2769:
  Type 'B4HttpAgent' is missing the following properties from type
  'AbstractAgent': resolvingPeerCeiling, resolvePeerCeiling,
  maxProtocolVersion, resolvedCeilingDuringConstruction
```

`AbstractAgent` 1.0.1 has private members, so TypeScript compares it
nominally: CopilotKit's `agents: Record<string, AbstractAgent>` accepts only
an agent compiled against the same `@ag-ui/client` copy. There is no fix on
0.0.59. Main's last green CI run (04:26 UTC) predates the publish; the next
run on main is expected to red the same lane.

Beyond the outage, 1.0 is the protocol freeze: one JSON Schema generates every
SDK, the 0.x deprecations expire on 2027-09-17, and 1.0 clients now *enforce*
the schema against what a server sends. B4.run's AG-UI surface should be
built on the frozen line.

## 2. What 1.0.1 changes, as it applies to B4.run

Verified against the published tarballs (0.0.59 from the workspace store,
1.0.1 fetched with `npm pack`), the upstream migration guide
(`docs/migrating-to-1-0.mdx`), the spec (`docs/spec/1.0/**`),
`DEPRECATIONS.md`, and threadplane's own cut-over
(`angular-agent-framework` `docs/superpowers/specs/2026-09-30-ag-ui-1-0-upgrade-design.md`,
merged 2026-09-30).

### 2.1 `@ag-ui/core`

- Main entry is zod-free. Every validator (`RunAgentInputSchema`,
  `AgentCapabilitiesSchema`, `*EventSchema`, …) lives at the new subpath
  `@ag-ui/core/schemas`. Peer `zod ^3.25.18 || ^4.0.0`; B4.run's `^4.4.3`
  satisfies it.
- Every 1.0.1 schema is **loose**: unknown keys are kept on parse. 0.0.59
  schemas stripped them.
- `EventType` drops the five `THINKING_*` members. B4.run never emitted them.
  Nothing was added or renamed; `REASONING_*`, `SUBAGENT_*` and `ACTIVITY_*`
  already existed in 0.0.59.
- `BinaryInputContent` is gone; content parts are `TextPart | ImagePart |
  AudioPart | VideoPart | DocumentPart`, each with a `source`
  (`DataSource | UrlSource | FileSource`). `UserMessage.content`,
  `ToolMessage.content` and `TOOL_CALL_RESULT.content` are
  `string | ContentPart[]`.
- New: `PROTOCOL_VERSION` (`"1.0"`), `RunAgentInput.protocolVersion?` and
  `parentRunId?`, `RUN_STARTED.protocolVersion?`, `RunFinishedCancelledOutcome`,
  `pendingToolCallIds?` on the success outcome, `usage?: TokenUsage[]` on
  `RUN_FINISHED` and `RUN_ERROR`, `contentToText`, `contentHasMedia`,
  `omitOptionalNulls`, `SubagentInfo` (was `SubAgentInfo`),
  `multiAgent.subagents` (was `subAgents`, no alias).
- `ResumeEntry` (`{ interruptId, status, payload?, metadata? }`),
  `Interrupt` and `AgentCapabilities` are otherwise unchanged.

### 2.2 `@ag-ui/client`

- `HttpAgent` config (`{ url, headers?, fetch? }`), the public fields
  (`url`, `headers`, `fetch`, `abortController`) and `clone()` are unchanged.
  `getCapabilities?()` is unchanged.
- `prepareRunAgentInput` stamps `protocolVersion: "1.0"` into every request
  built by `runAgent`.
- **Outgoing enforcement:** `HttpAgent.run` deep-strips unknown keys from the
  outgoing `RunAgentInput` with a console warning. A top-level
  `resume[].grant` does not survive.
- **Inbound enforcement:** inside `runAgent` / `connectAgent` the stream runs
  through `CompatibilityBoundary` → `enforceEvents` → chunk expansion →
  `verifyEvents`. Unknown event types and unknown properties on known events
  are stripped with a warning; a malformed known value fails the run. A
  top-level `Interrupt.grant` does not survive. A bare `HttpAgent.run()` runs
  none of this, which is why B4.run's current conformance test cannot see it.
- Protocol version negotiation: `maxProtocolVersion` is the ceiling the
  *peer* speaks, defaulting to the client's own version; a subclass need do
  nothing unless it targets an older server. On `RUN_STARTED` the client
  warns if the producer declares a newer or uninterpretable version.
- `MESSAGES_SNAPSHOT` applies in snapshot order; framing buffers are capped.
  B4.run emits neither.

### 2.3 Producer obligations (migration guide, verbatim where normative)

- Declare the producer's own version on `RUN_STARTED.protocolVersion`,
  "never an echo of the input's".
- A producer meeting "a newer minor of a line it implements MUST serve the
  run … answer with its own version, and SHOULD warn". Only a foreign major
  may be rejected, and only before `RUN_STARTED`.
- Optional fields "omitted never `null`": `rawEvent`, `RUN_FINISHED.result`,
  `outcome`, `parentMessageId`, `forwardedProps`, `resume[].payload`,
  media-part `metadata`, `tools[].parameters`.
- Frontend (client-provided) tool calls "finish as success with optional
  `pendingToolCallIds`, never as interrupt".
- `TOOL_CALL_RESULT` is "a standalone message, doesn't reopen answered calls".

### 2.4 CopilotKit 1.76

- Runtime v2 types `agents` against 1.0.1's `AbstractAgent`, parses request
  bodies with the loose 1.0.1 schema, calls `agent.getCapabilities?.()` for
  `/info`, `agent.clone()` per request, and assigns `agent.headers`.
- `react-core` v2 renders tool results with `result: toolMessage.content`,
  assuming a string. A `ContentPart[]` tool result would reach it unchanged;
  B4.run does not emit one in this sub-project.

## 3. Decisions

Accepted during brainstorming on 2026-10-01; implementation does not
relitigate them.

1. **Four sub-projects; this is the first.** (1) Cut-over, below.
   (2) Outbound richness: `usage`, `REASONING_*`, `SUBAGENT_*` lifecycle and
   attribution, `ACTIVITY_DELTA`, `STEP_*`. (3) Inbound multimodal and
   content-part tool results. (4) Transport and capabilities: protobuf,
   `reasoning`/`state`/`multiAgent`/`transport` sections. Each gets its own
   spec and plan.
2. **Hard cut, no backward compatibility.** Peer floor `@ag-ui/client
   >=1.0.1 <2.0.0`; `@b4run/ag-ui` imports `@ag-ui/core/schemas`, which
   0.0.59 does not ship. Breaking changes are acceptable.
3. **The approval grant travels in `metadata.grant` only.** Top-level
   `grant` is removed from emitted interrupts and no longer read from resume
   entries. `metadata` is schema-defined on both `Interrupt` and `ResumeEntry`,
   so it survives 1.0 enforcement in both directions; the top-level field is
   one the protocol guarantees to delete.
4. **`cancelled` outcome** for `POST /threads/:id/cancel` and server
   shutdown. Client disconnect emits nothing new. Everything else stays
   `RUN_ERROR`. Thread status logic is unchanged.
5. **Exact pins where the nominal type must agree.** Workspace packages pin
   `@ag-ui/core`/`encoder` exact `1.0.1` (as today). Examples and the
   research scaffold template pin `@copilotkit/react-core`,
   `@copilotkit/runtime` exact `1.76.0` and `@ag-ui/client` exact `1.0.1`,
   matched to what CopilotKit 1.76.0 pins. Bumps are deliberate PRs and the
   existing pin tests guard that the two move together.
6. **Multimodal input is refused, not dropped, until sub-project 3.** Text
   parts concatenate via `contentToText`; any media part is `422
   multimodal_not_supported`. `multimodal` is omitted from capabilities
   (AG-UI reads omitted as unknown).

## 4. Dependency and type cut-over

### 4.1 Manifests

| File | Change |
|---|---|
| `packages/ag-ui/package.json` | `@ag-ui/core` `1.0.1`, `@ag-ui/encoder` `1.0.1`; peer `@ag-ui/client` `>=1.0.1 <2.0.0`; dev `@ag-ui/client` `1.0.1`. zod unchanged. |
| `packages/cli/package.json` | `@ag-ui/core` `1.0.1`. |
| `examples/chat/web/package.json`, `examples/research/web/package.json` | `@ag-ui/client` `1.0.1`; `@copilotkit/react-core`, `@copilotkit/runtime` `1.76.0` (exact). |
| `packages/devkit/templates/app-research/web/package.json.template` | Same pins. |
| `pnpm-lock.yaml` | Regenerated. Re-fetch main immediately before merge (lockfile-staleness trap). |
| `packages/devkit/test/template-copilotkit-dependencies.test.ts`, `test/security-dependencies/dependency-resolution.test.ts` | Pinned numbers move to `1.0.1` / `1.76.0`; the assertions stay, as the guard that the two move together. |

`@ag-ui/client` 1.0.1 brings `@ag-ui/proto` 1.0.1 as a dependency; nothing in
B4.run imports it in this sub-project.

### 4.2 Imports that move to `@ag-ui/core/schemas`

- `packages/cli/src/lib/dev/agui-handler.ts`: `RunAgentInputSchema`.
- `packages/ag-ui/src/client.ts`: `AgentCapabilitiesSchema` (the file arrives with PR #883; it moves its import when it rebases).
- `packages/ag-ui/test/{conformance,outbound,activities}.test.ts`,
  `packages/cli/test/agui-capabilities.test.ts`: the event and capability
  schemas they assert with.

Types keep coming from `@ag-ui/core`.

### 4.3 Loose parsing

The handler's comment that the zod parse strips unknown keys (around
`agui-handler.ts:447`) is removed. Nothing depends on strip:
`validateRunEnvelope` judges the raw JSON, `readResponseFormat` and
`readClientToolDefinitions` read named keys off the raw JSON, and
`fromRunAgentInput` reads only named fields. A new test sends an unknown
top-level key and asserts it is neither rejected nor echoed anywhere
(`RUN_STARTED` carries no `input` echo today, and this stays so).

### 4.4 Type fallout the census expects

- `packages/ag-ui/src/inbound.ts`: `content` is `string | ContentPart[]`
  (handled in §5.3).
- `packages/ag-ui/src/outbound.ts`: the outcome union gains `cancelled`.
- `packages/ag-ui/src/types.ts` / `interrupts.ts`: `B4AguiInterrupt.grant`
  removed (§5.2).
- `examples/research/web/app/lib/transcript.ts`, `ToolCallCard.tsx`,
  `AppShell.tsx`, `MemoryPanel.tsx` and their devkit template mirrors:
  `ToolMessage.content` is no longer `string`. They render via
  `contentToText` and keep their string assumptions behind it. The research
  example and the template must stay byte-identical
  (`packages/devkit/test/templates.test.ts` parity).
- `B4HttpAgent` needs no change; the nominal error disappears once both sides
  compile against 1.0.1.

Anything else the compiler reports is in scope.

## 5. Wire behavior

### 5.1 Outbound

- **`RUN_STARTED.protocolVersion`** is `PROTOCOL_VERSION` imported from
  `@ag-ui/core`, never a literal.
- **`cancelled` outcome.** The handler already distinguishes `run.cancelled`
  (set by `POST /threads/:id/cancel` and shutdown) from a client disconnect.
  When the abort is a cancel, `toAguiEvents` ends the run with
  `RUN_FINISHED { outcome: { type: "cancelled" } }` instead of `RUN_ERROR`.
  The translator needs to know the abort kind; it is passed in through
  `ToAguiOptions` (a `cancelled: () => boolean` read at the catch site)
  rather than inferred from the error message. The handler's terminal-chunk
  projection for AP viewers (`output: { cancelled: true }`) is unchanged.
- **`pendingToolCallIds`.** When a turn ends on parked client-tool calls
  (`withParkedClientTools`), the success outcome carries the parked call ids
  for this turn. Absent otherwise: never `[]`, never `null`.
- **Interrupts** carry the grant at `metadata.grant` only. `toAguiInterrupt`
  stops copying it to the top level; `B4AguiInterrupt` loses `grant`. No
  shipped renderer reads the grant (`packages/ag-ui/src/react` renders
  activities only, and the research example does not enable grants).
- **Null discipline.** Every event B4.run constructs is audited for optional
  keys spelled `null` (`outbound.ts`, `activities.ts`, `interrupts.ts`, the
  handler's own `RUN_ERROR`s). A test encodes one of each event kind and
  asserts no optional key is `null`.
- **`TOOL_CALL_RESULT.content`** stays a string in this sub-project
  (`stringifyContent` as today); content-part results are sub-project 3.

### 5.2 Inbound

- **Resume grant:** `fromAguiResume` reads `entry.metadata.grant`, forwarding
  it only when it is a non-empty string (same guard as today, same reason: an
  opaque echo must not become a JSON channel into the grant check). Top-level
  `grant` is not read. `gateResumeWithGrants` is unchanged; it receives the
  same `B4ResumeRequest.grant`.
- **`protocolVersion`:** absent or any `1.x` → serve. A parseable version
  with a different major → `400 unsupported_protocol_version` at the envelope
  stage, before middleware and before any side effect. Unparseable → serve;
  the spec reserves rejection for a recognised foreign major. The check lives
  in `run-envelope.ts` beside the id checks, so it is pure and edge-reachable.
- **Message content:** `coerceContent` becomes: string → as is; `ContentPart[]`
  → if `contentHasMedia`, the envelope stage answers
  `422 multimodal_not_supported` (B4 error code `B4_E5401`, same family as the
  other envelope refusals); else `contentToText`. Any other shape → `""` as
  today. The refusal runs before middleware like the other envelope checks:
  it needs no I/O and discloses nothing about a thread.
- **Reasoning-role history:** a replayed `role: "reasoning"` message is
  dropped rather than mapped to `assistant`. It is the client's stored
  artefact of a previous turn, not conversation. `activity` messages are
  already filtered by the client before sending and are dropped if they
  arrive.

### 5.3 Capabilities (`GET /agui/:routeId`)

Claims are unchanged in this sub-project. `GET /agui/:routeId` is introduced
by PR #883, which rebases onto this change and adds
`transport: { streaming: true }` there (a fact the handler enforces: it only
answers SSE). No `multimodal`, `reasoning`, `state` or `multiAgent` section
until the sub-project that makes each one true.

## 6. Verification

### 6.1 The test that proves schema conformance

`packages/ag-ui/test/conformance.test.ts` currently pipes a bare
`agent.run()` through `verifyEvents(false)`, which in 1.0 skips enforcement.
It is rewritten to drive a real `HttpAgent.runAgent()` against an in-process
fixture server that serves B4.run's own `toAguiEvents` output over SSE, so the
full client pipeline runs: `CompatibilityBoundary` → `enforceEvents` → chunk
expansion → `verifyEvents`. The test spies on `console.warn` and asserts
**zero** calls: an enforcement strip is a failure, not noise. Fixtures:

1. plain text turn;
2. tool call with streamed args and a string result;
3. approval interrupt carrying `metadata.grant`, then a resume whose entry
   carries `metadata.grant` — the server-side gate must receive the grant;
4. client-tool park ending in success with `pendingToolCallIds`;
5. cancelled run;
6. `RUN_ERROR` with `code`;
7. `b4.plan` and `b4.subagent` activity snapshots (covered inside fixture 1's full turn).

This is the check that would have caught the grant problem, and it is the
acceptance test for §5.1's null discipline.

### 6.2 Other tests

- Grant channel: `pending-interrupts-endpoint`, `agui-client-tools`,
  `thread-access-*`, the React renderer tests — every assertion reading
  `grant` top-level moves to `metadata.grant`; one test asserts the top-level
  key is absent on the wire.
- `protocolVersion`: absent / `"1.0"` / `"1.7"` / `"2.0"` / `"garbage"`.
- Unknown top-level key: tolerated, not echoed.
- Multimodal: text-only parts concatenate in order; one image part → 422
  with the code; the refusal happens before middleware (a rejecting
  middleware does not run).
- `cancelled`: cancel endpoint and shutdown → `RUN_FINISHED cancelled`;
  client disconnect → no new frame; AP viewer still sees
  `{ cancelled: true }`.
- `pendingToolCallIds`: present with the parked ids; absent on an ordinary
  success.
- `test/security-dependencies/copilotkit-v2-runtime.test.ts` runs against
  CopilotKit 1.76 and is **added to CI** as a step of the `dependency-security-browser` job in `ci.yml` (it is the
  only end-to-end CopilotKit → B4.run check and it is off CI today; adding a
  step shifts the audited workflow fixtures, which are regenerated in the
  same commit).
- Mutation check on every new test: revert the behavior, confirm the test
  fails.

### 6.3 Gates

`pnpm ci:validate` locally, with these called out because they are the ones
this change touches: `pack:check` (new transitive dep), `check-docs.mjs`
(pins below), `seo:lastmod:routes`, devkit template parity, the generated
research activation harness (`verify:harness:framework`) — which is red on
main today and is this PR's acceptance gate.

## 7. Documentation

- `/docs/ag-ui`: grant channel (`metadata.grant`, both directions),
  `cancelled`, `pendingToolCallIds`, `protocolVersion` handling,
  `multimodal_not_supported`, the 1.0 peer requirement.
- `/docs/api/ag-ui`: peer range, the `@ag-ui/core/schemas` note for anyone
  validating with B4.run's types, `B4AguiInterrupt` without `grant`.
- `packages/ag-ui/README.md`, `apps/web/content/docs/recipes/research-web-ui.mdx`,
  the `examples/*/web` READMEs: version numbers.
- `scripts/check-docs.mjs` pins and `apps/web/app/components/docs/api-reference*.ts`
  wherever the symbol list changes (`B4AguiInterrupt` shape).
- Regenerate the SEO lastmod manifest after the content commits.

## 8. Release

- One changeset, `patch` on the fixed 0.x group (repo convention), whose text
  states the breaking changes plainly: peer floor `@ag-ui/client 1.0.1`;
  `grant` moved to `metadata.grant` on interrupts and resume entries;
  CopilotKit `1.76.0` in examples and scaffold; multimodal input refused.
- Issues for sub-projects 2, 3 and 4 are filed before this merges, each
  naming the capability section it will turn on.
- PR #883 (capability advertisement) stays blocked until this lands and then
  rebases onto it; its `GET /agui/:routeId` is unaffected except for
  `transport.streaming`.

## 9. Out of scope (the other sub-projects)

- **2 — Outbound richness:** `usage` from the langchain adapter's
  `usage_metadata`; `REASONING_*` (the adapter currently discards reasoning
  blocks in `chunkText`); `SUBAGENT_STARTED/FINISHED/ERROR` with
  `subagentRunId` attribution alongside the existing `b4.subagent` activity
  cards; `ACTIVITY_DELTA`; `STEP_*`.
- **3 — Multimodal:** `ContentPart[]` user input into the runtime (images,
  documents, files), content-part tool results outbound, and the
  `multimodal` capability section.
- **4 — Transport and capabilities:** protobuf
  (`Accept: application/vnd.ag-ui.event+proto`, `httpBinary`), websocket if
  warranted, and the `reasoning`, `state`, `multiAgent` sections.

## 10. Risks

- **Enforcement strips something B4.run relies on.** Contained by §6.1: the
  conformance test runs the real client pipeline with warnings as failures.
- **A fresh scaffold installs two `@ag-ui/client` copies.** Contained by
  exact pins (§3.5) and the pin tests; the generated-app harness installs
  from npm and is the acceptance gate.
- **Something else reads the top-level grant.** The grep in the plan covers
  `packages/`, `examples/`, `apps/web`, and the devkit templates; the wire
  test asserts absence.
- **Two in-flight PRs touch `agui-handler.ts`** (#883 and this). #883 merges
  second and rebases; its handler change is a dozen lines in a different
  region.
