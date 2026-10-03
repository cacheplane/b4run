# AG-UI 1.0 sub-project 3 — multimodal input and content-part tool results

**Date:** 2026-10-02
**Status:** Approved design, implementation pending
**Issue:** cacheplane/b4run#886
**Sub-project:** 3 of 4 of the AG-UI 1.0 cut-over
(`docs/superpowers/specs/2026-10-01-ag-ui-1-0-cutover-design.md` §9)
**Depends on:** PR #888 (merged 2026-10-01) and PR #883 (`GET /agui/:routeId`
capabilities; open at the time of writing — PR 2 below lands after it)

## 1. Why

AG-UI 1.0 made message content `string | ContentPart[]`, where a part is
`TextPart | ImagePart | AudioPart | VideoPart | DocumentPart` and each media
part carries a `source` of inline bytes (`data`), a URL (`url`) or a provider
file handle (`file`). The cut-over (#888) took the smallest conforming stance it
could while the runtime could not carry media to a model: the AG-UI envelope
stage refuses any message with a media part (`422 multimodal_not_supported`,
`run-envelope.ts`) and `packages/ag-ui/src/inbound.ts` flattens whatever
reaches it to text with `contentToText`.

Three things make that stance untenable now:

- **It violates the spec.** `docs/spec/1.0/basic/run-input.mdx`: a producer
  handed a part it cannot use "MUST NOT fail the run because of it. Skipping
  what it cannot use and continuing is the conforming behaviour", and
  `versioning.mdx` makes the skip a *lossy downgrade* that "MUST emit a
  warning that names what was lost and why."
- **The other front door is worse.** The Agent Protocol path
  (`POST /threads/:id/runs/*`) has no multimodal check at all and reads its
  body unbounded (`runtime-fetch-core.ts:2518, 2935, 3893`); array content
  reaches `extractMessages` in `packages/langchain/src/agent-adapter.ts`,
  fails its `typeof content === "string"` guard, falls into the legacy
  flat-object formatter and becomes the literal string `"[object Object]"`.
- **The models already take it.** Every curated model in
  `packages/sdk/src/known-model-ids.ts` accepts image input, and gpt-5-mini
  (the canonical default) accepts images by data and by URL and PDFs. The
  LangChain provider packages convert the standard multimodal blocks, and
  every package but `ollama` and `mistralai` ships a per-model `profile`
  saying which modalities a model takes.

## 2. Decisions

Settled in brainstorming on 2026-10-01/02; implementation does not relitigate
them.

1. **Skip and announce, never refuse.** A part the route's model cannot use
   is dropped, the run continues, and the drop is announced to the developer
   (§5). The `422 multimodal_not_supported` refusal is removed entirely; no
   content-based refusal replaces it.
2. **All three sources are carried.** `data` → inline bytes; `url` → handed
   to the provider *as a URL* (B4.run never fetches it: no SSRF surface, no
   buffering, no new size cap); `file` → the provider's file id, only when the
   part's `provider` is absent or equals the route's provider id, otherwise
   dropped — the spec's own rule for handles.
3. **Support comes from LangChain's `model.profile`, with a per-provider
   fallback.** One function decides both what is carried at run time and what
   `GET /agui/:routeId` advertises (§4).
4. **A `DocumentPart` is a PDF or nothing.** AG-UI's capability flag is `pdf`;
   a document whose `mimeType` is not `application/pdf` (including a `url`
   source that does not say) is dropped and announced rather than guessed.
5. **No new size limits.** The 8 MiB AG-UI body ceiling bounds inline parts;
   `url` and `file` carry no bytes. The Agent Protocol run path gets the same
   ceiling. Checkpoint duplication of inline media and media offload are a
   follow-up issue (§8), not solved here.
6. **A tool returns parts directly.** The AG-UI part shape is the B4.run
   tool-author shape: `execute` may return `string`, JSON, or
   `B4ContentPart[]`. Media reaches the model when the profile says the model
   takes media in tool messages, and reaches the UI on `TOOL_CALL_RESULT`
   regardless.
7. **Client-tool results carry parts** under the same rules as a server tool
   result. The 64 KiB screen bounds the text/JSON portion; inline bytes are
   bounded by the body.
8. **The research example renders media and gates its attach control on the
   capability document**, and gains one media-producing tool.

## 3. The content type and where it lives

### 3.1 `B4ContentPart` in `@b4run/sdk`

```ts
export type B4PartSource =
  | { readonly type: "data"; readonly value: string; readonly mimeType: string }
  | { readonly type: "url"; readonly value: string; readonly mimeType?: string }
  | { readonly type: "file"; readonly value: string; readonly provider?: string; readonly mimeType?: string }

export type B4ContentPart =
  | { readonly type: "text"; readonly text: string; readonly id?: string; readonly metadata?: unknown }
  | { readonly type: "image" | "audio" | "video" | "document"; readonly source: B4PartSource; readonly id?: string; readonly metadata?: unknown }

export type B4MessageContent = string | readonly B4ContentPart[]
```

Structurally identical to `@ag-ui/core`'s `ContentPart`, declared in the SDK so
tools, middleware and the langchain adapter do not import `@ag-ui/core`. A
compile-time test in `packages/ag-ui/test` asserts mutual assignability
(`ContentPart` ⇄ `B4ContentPart`), so a 1.x addition to the AG-UI shape fails
the build rather than silently widening.

### 3.2 Types that widen from `string` to `B4MessageContent`

| Type | Where | Note |
|---|---|---|
| `B4Message.content` | `packages/ag-ui/src/inbound.ts` | user and tool roles carry parts; assistant/system/developer stay text in 1.0 (the spec reserves assistant parts for a later minor) |
| `InputMessage.content` | `packages/langchain/src/agent-adapter.ts` | `isInputMessageArray` accepts `string | B4ContentPart[]`; array content no longer falls into `formatAgentMessage` |
| `MiddlewareAfterMessage.content` | `packages/sdk/src/middleware.ts` | `after` middleware sees what the client sent |
| tool `execute` return | `packages/sdk` tool types | `string | JsonValue | B4ContentPart[]`, and `{ result: B4ContentPart[], state }` through the existing wrapper |
| `ClientToolCallStore.answer({ result })` / `ClientToolCallRecord.result` | `packages/sdk/src/client-tool-calls.ts` | `string | readonly B4ContentPart[]`; the SQLite and Postgres stores keep a part list in the existing `TEXT` column as a self-describing JSON envelope (`encodeClientToolResult`/`decodeClientToolResult` in `@b4run/sdk`, shared so the stores cannot drift; decoding admits only an envelope whose `parts` is a valid list); rows answered before this change are plain text and decode as text; no schema migration |
| `B4ToolResultData.output` | `packages/ag-ui/src/types.ts` | already `unknown`; a part array now passes through instead of being stringified |

### 3.3 Inbound flow

```
AG-UI POST /agui/:route ─┐                               ┌─ toLangChainContent(parts, support)
                          ├→ B4Message[] → streamRoute ───┤   → HumanMessage(content blocks)
AP  POST /threads/:id/runs┘  (newest user message only)   └─ dropped[] → announce (§5)
```

- `run-envelope.ts`: `MEDIA_PART_TYPES`, `carriesMediaPart`, the
  `multimodal_not_supported` code and its rejection are removed. Structural
  validation of parts stays with `RunAgentInputSchema` at the handler's parse
  step: an unknown `source.type` or a `data` source without `mimeType` is a
  schema failure and keeps today's 400, as the spec requires for the closed
  source arms. Nothing modality-specific is judged before middleware any
  more: the drop decision needs the route's model, which by #883's rule is
  disclosed only after middleware.
- `inbound.ts` `coerceContent` → `coerceMessageContent`: string → as is;
  array → the parts, with any entry that is not a structurally valid part
  dropped (`isContentPart`; an unvalidated list cannot throw — behind the
  handler's schema parse the filter changes nothing, it protects direct
  callers of `fromRunAgentInput`) and text parts kept as parts, not
  concatenated; an array with nothing left → `""`; any other shape → its
  JSON, as today.
- Messages handed to LangChain are built with `content: blocks` plus
  `response_metadata: { output_version: "v1" }`. `@langchain/core` 1.2's
  `isDataContentBlock` recognises only legacy `source_type` blocks under a
  bare `content:`; the standard blocks this design emits are converted by the
  OpenAI package only when the message carries that `output_version`
  (without it, Chat Completions sends them raw — a 400 from the API — and the
  Responses path drops them silently). The `contentBlocks:` constructor
  field sets the same metadata but serialises the message with
  `content_blocks` and no `content`, which every B4.run reader of
  `kwargs.content` (testing matchers, episode recording, the research
  example's hydration) would miss; so the metadata is set by hand on a
  `content:` message instead. Anthropic and Google convert either way. Tests
  run real messages through `convertMessagesToCompletionsMessageParams` and
  the Anthropic payload converter to pin this, and assert the serialised
  form keeps `kwargs.content`.
- The handler still forwards only the newest user message to the route
  (`agui-handler.ts` `newestUserMessage`); the checkpointer owns history. So
  media in resent history costs wire bytes, not model tokens.
- Agent Protocol: the three `await request.text()` sites become
  `readBoundedText(request, AGUI_BODY_MAX_BYTES)` with the existing
  `payloadTooLarge` 413; `input.messages[].content` accepts
  `B4MessageContent`. The constant moves out of `client-tool-runtime.ts`
  into a neutral module (`request-limits.ts`) since it now bounds two
  endpoints.

### 3.4 Outbound flow

```
tool.execute → string | JSON | B4ContentPart[]
  → unwrapToolResult: a part array is kept, not JSON.stringify'd
  → offload (OffloadFn) receives the text portion only; media parts bypass it
  → ToolMessage.content: text + media blocks when support.toolResult allows, else text only (+ dropped)
  → B4ToolResultData.output carries the parts
  → outbound.ts: TOOL_CALL_RESULT.content = parts (string path unchanged)
```

`stringifyContent` in `outbound.ts` becomes `toResultContent(output)`: a
`B4ContentPart[]` (or a LangChain `ToolMessage` whose content is such an
array) passes through as `ContentPart[]`; everything else stringifies as
today. `tool-loop.ts` (the non-agent loop) gets the same treatment as
`tool-converter.ts`.

## 4. Modality support — one function, two call sites

### 4.1 `resolveModalitySupport`

In `packages/langchain/src/chat-model-factory.ts`, beside
`JSON_SCHEMA_RESPONSE_FORMAT_PROVIDERS`:

```ts
export interface ModalitySupport {
  readonly image: { readonly data: boolean; readonly url: boolean } // profile.imageInputs / imageUrlInputs
  readonly pdf: { readonly data: boolean; readonly url: boolean }    // profile.pdfInputs, minus provider overrides
  readonly audio: boolean                                            // profile.audioInputs
  readonly video: boolean                                            // profile.videoInputs
  readonly toolResult: { readonly image: boolean; readonly pdf: boolean } // profile.imageToolMessage / pdfToolMessage
  readonly file: { readonly image: boolean; readonly pdf: boolean }  // provider maps a FileSource handle, per part type
}
export function resolveModalitySupport(model: unknown, provider: BuiltInModelProviderId): ModalitySupport
```

- Reads `model.profile` (`@langchain/core` `ModelProfile`); every flag
  defaults to `false` when absent.
- When the profile is missing or empty — every `ollama` and `mistral` model,
  an unknown id on any provider — `PROVIDER_MODALITY_FALLBACK` applies:
  `ollama` → `image.data` only (its converter base64-encodes and cannot take a
  URL); `mistral` → `image.data` and `image.url`; every other provider →
  `image.data` and `image.url`. Audio, video, pdf and tool-result media are
  claimed only when a profile says so.
- Provider overrides apply last, in both branches, for converter limits the
  profile does not know about (verified by running real messages through the
  installed converters): `openai`'s Chat Completions path — the one B4.run
  uses; `useResponsesApi` is never set — maps a `file` block only from `data`
  or `fileId` (a PDF URL vanishes silently) and reduces a tool message to its
  text (media in a tool result never reaches the model, with no record). So
  for `openai`: `pdf.url = false` and `toolResult = { image: false, pdf: false }`,
  whatever gpt-5-mini's profile claims.
- `file` is a provider fact, not a profile one, per part type, verified
  against the converters: `anthropic` maps a `fileId` for images and
  documents; `openai`'s Chat Completions path (the one B4.run uses) maps it
  only for `file` blocks, its image branch has no `fileId` case; `google`'s
  converter throws on `fileId`. So `anthropic → { image: true, pdf: true }`,
  `openai → { image: false, pdf: true }`, every other provider → none.
- The reader follows a `RunnableBinding`'s `.bound` (depth-guarded): with a
  response format bound, `createChatModel` returns `model.withConfig(...)`,
  and for Anthropic that binding has no `profile` of its own.

### 4.2 `toLangChainContent`

New pure module `packages/langchain/src/content-parts.ts`:

```ts
export type DropReason =
  | "modality_unsupported" | "url_source_unsupported" | "file_source_unsupported"
  | "foreign_file_provider" | "document_not_pdf" | "tool_result_media_unsupported"
export interface DroppedPart { readonly index: number; readonly type: string; readonly source?: "data" | "url" | "file"; readonly reason: DropReason }
export function toLangChainContent(
  content: B4MessageContent,
  support: ModalitySupport,
  provider: BuiltInModelProviderId,
  position: "user" | "tool",
): { readonly content: MessageContent; readonly dropped: readonly DroppedPart[] }
```

| Part | Carried when | Else |
|---|---|---|
| `text` | always | — |
| `image` data / url | `image.data` / `image.url` | drop (`modality_unsupported` / `url_source_unsupported`) |
| `image` / `document` file | `file.image` / `file.pdf` and (`provider` absent or equal) | drop (`file_source_unsupported` / `foreign_file_provider`) |
| `document` | `mimeType === "application/pdf"` and `pdf` | drop (`document_not_pdf` / `modality_unsupported`) |
| `audio` / `video` | `audio` / `video` | drop |
| any media, `position: "tool"` | additionally `toolResult.image` (image) / `toolResult.pdf` (pdf); audio/video never | drop (`tool_result_media_unsupported`) |

Mapping to LangChain standard blocks: `data` → `{ type, data: value, mimeType }`;
`url` → `{ type, url: value, mimeType? }`; `file` → `{ type, fileId: value, mimeType? }`;
`document` → LangChain `type: "file"`. Text parts → `{ type: "text", text }`.
Exception: the `ollama` and `mistralai` converters accept only the legacy
`image_url` block and throw on a standard `image` block, so for those two
providers an image becomes `{ type: "image_url", image_url: { url } }`, with
a `data` source rendered as a `data:<mimeType>;base64,<value>` URL (which is
the form `ollama`'s converter decodes).
A string input is returned as a string with no drops. A content array that
ends up with no blocks at all becomes `""` (the run still proceeds; the model
sees an empty user turn, which is what the client sent minus what it cannot
use). In `position: "tool"`, an array whose surviving blocks are all text
collapses to a string: `@langchain/ollama` throws on any non-string tool
content, and a text-only block list carries nothing a string does not. A
`document` `url` source is gated by `pdf.url` (reason `url_source_unsupported`),
mirroring images. For `ollama`, a `url` image is dropped
(`url_source_unsupported`) regardless of what a future profile claims: its
converter decodes only base64 data URLs and would send `""` for anything else.

### 4.3 The `multimodal` capability section

`agui-capabilities.ts` (#883), agent routes only. The handler obtains the
route's model through the same path `POST` would (`createChatModel` with the
descriptor's `model`/`provider`, no bind, no network call; the provider
package import is the memoized one `POST` does) and maps
`resolveModalitySupport`:

```
multimodal.input  = { image: support.image.data, audio: support.audio, video: support.video, pdf: support.pdf, file: false }
multimodal.output = { image: false, audio: false }
```

- `file: false` is deliberate. AG-UI's `input.file` means "arbitrary file
  uploads of a kind the four parts do not cover", which no path here takes;
  a `FileSource` *handle* is a source, not that flag.
- The profile is read off the model's CLASS, not an instance
  (`readModelProfile`): every provider package's `profile` getter is a static
  per-id table that reads only `this.model`, and most constructors throw
  without a credential, which a capability document must not depend on. When
  the provider package is not installed, the `multimodal` key is **omitted**:
  AG-UI reads omitted as unknown, and the route could not run anyway.
  Non-agent routes and raw runnables omit it too; a chain/graph/workflow
  route's content handling is the author's. (Amended for PR 2: the first
  draft said "construct the model; omit on a missing API key".)
- Derivation test, in the #883 style: for every curated model id and each of
  the four media types, `multimodal.input.<flag>` equals whether
  `toLangChainContent` carries a one-part `data` message of that type under
  the same `ModalitySupport`. One function feeds both, so the test pins that
  they cannot drift.
- The flags describe the INLINE (`data`) source: AG-UI's `input.image` is
  "can process image inputs", and a client that sends bytes is never
  surprised. URL support varies by provider (Gemini and Ollama drop image
  URLs; OpenAI drops PDF URLs) and a dropped URL part is reported by the
  run's dropped-parts warning; the docs say so beside the capability table,
  which is what keeps the warning's `GET /agui/<route>` pointer honest.
- A provider package that is installed but broken (an import error that is
  not "missing", a getter that throws) is `ok: false` like every other
  provider-level failure in the sibling preflights: the section is omitted
  and the rest of the document stands; `POST` still reports the real error.

## 5. Announce — the lossy-downgrade warning

The spec's MUST is a developer warning that names what was lost and why; it
does not require a wire event. B4.run does both:

1. **Server log, always.** The CLI logs once per run, through the handler's
   existing `console.warn` convention:
   `B4: dropped 2 content part(s) from the user message: image/url (openai/gpt-5-mini: url_source_unsupported), audio/data (modality_unsupported). GET /agui/<route> lists what this route accepts.`
   On the Agent Protocol stream the chunk also passes through as an SSE
   event named `content_parts_dropped`, the way other capability chunks
   (`plan_update`) do; the non-streaming `invoke` path has the log only.
   Drops inside a subagent arrive as `subagent.content_parts_dropped` and
   are logged the same way. The pointer names the route's assistant id
   (`/chat#agent`), which is what `GET /agui/:routeId` resolves.
2. **`CUSTOM` event on the AG-UI stream.** The adapter emits a new runtime
   chunk `{ type: "content_parts_dropped", data: { provider?, model?, toolCallId?, parts: DroppedPart[] } }`
   (`provider`/`model` name the route's model and are omitted on the
   raw-runnable path; `toolCallId` is present for a tool-result drop; the
   message a user-turn drop belongs to is the newest user message, so it
   carries no id);
   `outbound.ts` maps it to
   `{ type: "CUSTOM", name: "b4.content_parts_dropped", value: data }`,
   placed after the frames of the user message it belongs to; a tool-result
   drop is dispatched while the tool runs, so its `CUSTOM` precedes that
   call's `TOOL_CALL_RESULT` and correlates by `toolCallId`. `CUSTOM` is the
   right escape hatch (vendor-prefixed, legally ignored by a consumer that
   does not know it, carries nothing the protocol models elsewhere); `RAW` is
   not (it is for a provider-native event).

No opt-out switch: the spec says an implementation MUST NOT silence these by
default, and the "MAY offer a way" is not needed yet.

## 6. Client-tool results with parts

A frontend tool that "produced a screenshot or picked a file" answers with a
media part (spec, `tool-calls.mdx`). The trailing `role: "tool"` message now
carries `B4MessageContent`:

- `screenOversizedClientToolResults` measures
  `JSON.stringify(content with every data.value replaced by "")` against
  `MAX_CLIENT_TOOL_RESULT` (64 KiB): text and JSON stay bounded; inline bytes
  are bounded by the body only (decision 5). A string result measures as
  today.
- `resolveClientToolTurn` passes the content through unchanged;
  `ClientToolCallStore.answer` stores it (§3.2).
- Replay to the model goes through `toLangChainContent(…, "tool")`, so the
  model sees media only when `support.toolResult` allows, and the drop is
  announced like any other.

## 7. Example, template and docs

**`examples/research/web` and `packages/devkit/templates/app-research/web`**
(kept byte-identical, as today):

- `app/lib/transcript.ts`: user and tool items expose `parts` alongside
  `text`; a `b4.content_parts_dropped` CUSTOM event becomes a `notice` item
  attached to its message.
- Media is drawn by the app's own `Transcript`, in the user bubble and
  BESIDE `renderToolCall(...)` for a tool result: CopilotKit 1.76's tool
  renderer hands the app's `render` only `contentToText(toolMessage.content)`,
  so a renderer registered through it can never see a media part. A new
  `MediaParts` component: image → `<img>` (a data URL built from a `data`
  source, or the `url`; a `file` handle renders as a chip, since nobody but
  the provider can show it); document → link chip; audio/video → native
  element. The card's text/JSON preview is unchanged.
- Composer: an attach-image control (file picker → base64 `data` part; no
  URL input — the capability flag describes the inline source), rendered only
  when the route takes images. In the browser the agent is CopilotKit's
  runtime proxy, which already carries the capabilities `/info` fetched
  through `B4HttpAgent.getCapabilities()`; the gate is
  `useCapabilities()?.multimodal?.input?.image === true` from
  `@copilotkit/react-core/v2`; absent or unknown hides it. The message is
  sent as `agent.addMessage({ role: "user", content: parts })`, the shape
  CopilotKit's own submit uses. (Amended for PR 3: the first draft named
  `getCapabilities()` and `ToolCallCard`.)
- Notices: `agent.subscribe({ onCustomEvent })` collects
  `b4.content_parts_dropped` events; the transcript places each after the
  tool call it names, or after the newest user message.
- `app/lib/hydrate.ts`: a restored user message holds the checkpoint's
  LangChain v1 blocks (`{ type: "image", data|url, mimeType }`), not AG-UI
  parts — a `blocksToParts` mapper restores the part shape; a restored tool
  message's parts are read from `additional_kwargs.b4_content_parts`.
- One media-producing server tool, `renderChart`: takes the research findings
  and returns `[{ type: "text", … }, { type: "image", source: { type: "data", mimeType: "image/svg+xml", value } }]`.
  SVG keeps it dependency-free. On gpt-5-mini the image is UI-only — the
  OpenAI override sets `toolResult` all-false — so every `renderChart` call
  also emits the dropped-parts notice: the example demonstrates exactly that
  path. Its input is `{ title, series: [{ label, value }] }` (the research
  state holds no structured findings to read).

**Docs** (`apps/web/content/docs`): `ag-ui.mdx` gains a "Multimodal input"
section (what is carried, the drop-and-announce rule, the CUSTOM event, the
8 MiB ceiling, the capability section) and loses the error-table row and the
"Multimodal content is refused, not dropped" section, which inverts to
*dropped and announced, never refused*; `api/ag-ui.mdx` documents
`B4Message.content` and `B4ContentPart`; the tool-authoring page documents
returning parts from `execute`; `recipes/research-web-ui.mdx` documents the
attach control. `scripts/check-docs.mjs` gets a forbidden-phrase pin on
`multimodal_not_supported` and "refused, not dropped". Regenerate
`seo:lastmod`; changeset `patch`.

## 8. Testing

- Unit, against synthetic `ModalitySupport` values: `toLangChainContent` for
  every part type × source × position; `resolveModalitySupport` for a full
  profile, an empty profile, and each fallback provider;
  `coerceMessageContent`; the oversized-result screen with and without inline
  bytes; `unwrapToolResult`/`toResultContent` with a part array, a wrapper
  carrying one, and a plain string.
- Wire, through the real `@ag-ui/client` pipeline (the #888 conformance gate,
  warnings as failures): a `TOOL_CALL_RESULT` whose `content` is parts, and
  the `b4.content_parts_dropped` CUSTOM event, both validate and arrive.
- Capability derivation test (§4.3).
- Agent Protocol: array content reaches the adapter intact (no
  `"[object Object]"`); a body over `AGUI_BODY_MAX_BYTES` is 413.
- Fixtures: `packages/testing/src/record-fixtures.ts` `firstUserMessage`
  reads text parts (the rule aimock's own matcher uses), so a recorded
  multimodal turn keys on its text; `matchers.ts` `resolveMessageContent`
  learns array content. Two new recorded gpt-5-mini fixtures: an image turn
  (`data` and `url`), and a tool returning an image part (recorded with PR 3,
  which needs a live session). Known limitation, predating this work: B4.run
  keys a fixture on the FIRST user message with text while aimock replays on
  the LAST; the two agree for every single-turn case, including the SDK's
  split `[text] + [image]` form, and diverge only in a multi-turn recording.
- Example: the existing research web tests gain a rendered-image case and an
  attach-control-hidden-when-capability-absent case.

## 9. PR split

Each independently green on `validate`:

1. **Runtime core** — SDK `B4ContentPart` and widened types,
   `content-parts.ts`, `resolveModalitySupport`, adapter inbound and outbound,
   the drop chunk and server log, `run-envelope` 422 removal, `inbound.ts`,
   AP body bound and array content, `request-limits.ts`, fixture/testing
   updates, docs for all of that.
2. **Capabilities and client tools** — the `multimodal` section on `GET`, the
   derivation test, client-tool-result parts (store contract, screen, replay),
   the CUSTOM-event wire test. Depends on PR 1 and on #883 merged.
3. **Example and UI** — transcript/ToolCallCard/composer/`renderChart`, the
   template mirror, recipe docs, the demo fixture.

Plus a follow-up issue opened when this spec lands: **media compaction and
offload** — checkpoint duplication of `data` parts per step, per-part size
limits, offloading media to the thread workspace, and the cost of clients
resending media history on every run.

## 10. Out of scope

- `multimodal.output` (image/audio generation): the 1.0 protocol defines no
  carrier; both flags are advertised `false`.
- Assistant-message parts (`ReasoningPart`, `ToolCallPart`, `AssistantPart`):
  reserved by the spec for a later minor; not emitted.
- B4.run fetching a `url` source itself, or any per-part size cap (§9
  follow-up).
- Media on `system`/`developer` messages.

## 11. Risks

- **A wrong upstream profile is our wrong claim.** Contained by the fallback
  being conservative (images only) and by the derivation test keeping the
  claim and the enforcement identical, so a wrong claim is at least an
  honest one.
- **Constructing a model on `GET`.** No network call is made and the import is
  the memoized one `POST` performs; a constructor that throws (no credential)
  omits the section rather than failing the request.
- **Checkpoint growth from inline media.** Known, deferred to the follow-up
  issue; the 8 MiB body ceiling is the only bound.
- **#883 is still open.** PR 1 touches `agui-handler.ts` and `run-envelope.ts`
  in regions #883 does not; PR 2 is sequenced after #883 merges.
