# AG-UI Multimodal — PR 3 (Research Example) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The research example (and its devkit template) renders media parts in user messages and tool cards, lets a user attach an image when the route's capability document says the model takes one, shows the dropped-parts notice, ships one media-producing tool (`renderChart`), and replays a recorded gpt-5-mini fixture for it.

**Architecture:** All rendering stays in the app's own `Transcript` (CopilotKit's tool renderer flattens results with `contentToText` before the app's `render` sees them, so media is drawn beside `renderToolCall`, not inside it). The capability gate is CopilotKit's `useCapabilities()` — in the browser the agent is the runtime's proxy, which already carries what `/info` fetched from `B4HttpAgent.getCapabilities()`. The composer sends `agent.addMessage({ role: "user", content: parts })` (CopilotKit 1.76's own submit path uses exactly that shape). Drops arrive as `CUSTOM b4.content_parts_dropped` via `agent.subscribe({ onCustomEvent })` and become `notice` transcript items. Rehydration maps the checkpoint's LangChain v1 blocks back to AG-UI parts and reads a tool message's `additional_kwargs.b4_content_parts`. `renderChart` returns `[text, image/svg+xml data part]`; on gpt-5-mini the image is UI-only and the notice fires — the demo of that path.

**Tech Stack / conventions:** as PR 1's plan header. Example web tests: vitest 4, `renderToStaticMarkup` for simple components, `// @vitest-environment jsdom` + `createRoot`/`act` for stateful ones, every suite `vi.mock("@copilotkit/react-core/v2", …)`. `examples/research/{server,web}` and `packages/devkit/templates/app-research/{server,web}` must stay byte-identical (`packages/devkit/test/templates.test.ts`; test files mirror as `*.test.ts(x).template` and the counts at ~L519-524 are hard-coded). The template's tracked `server/.b4/*.generated.d.ts` must be regenerated when a tool is added (`packages/cli/test/run-typegen.test.ts` ~L377). **Spec:** `docs/superpowers/specs/2026-10-02-ag-ui-multimodal-design.md` §7 (amended with this plan). **Base:** PR 2.

---

## File map (every `examples/research/...` file has a byte-identical twin under `packages/devkit/templates/app-research/...`; tests mirror with a `.template` suffix)

| File | Change |
|---|---|
| `examples/research/server/src/tools/renderChart.ts` | **Create** — `{ title, series }` → `[text, image/svg+xml data part]` |
| `examples/research/server/src/app/research/index.ts` | system prompt step for `renderChart` |
| `examples/research/server/test/research.test.ts` | a scripted turn where the model calls `renderChart`; assert the tool result's parts |
| `examples/research/server/test/render-chart.test.ts` | **Create** — unit test of the SVG (deterministic bytes) |
| `packages/devkit/templates/app-research/server/.b4/{b4,scenarios}.generated.d.ts` | regenerated (typegen) |
| `examples/research/web/app/lib/parts.ts` | **Create** — `partsOf(content)`, `mediaParts`, `dataUrl(part)`, `blocksToParts` (LangChain v1 → AG-UI) |
| `examples/research/web/app/lib/transcript.ts` | `user`/`toolCall` items carry `parts`; new `notice` item kind; CUSTOM notices merged by `toolCallId`/position |
| `examples/research/web/app/lib/hydrate.ts` | HumanMessage blocks → parts; ToolMessage `b4_content_parts` → parts |
| `examples/research/web/app/components/MediaParts.tsx` | **Create** — `<img>`/`<audio>`/`<video>`/document chip/file-handle chip per part |
| `examples/research/web/app/components/Transcript.tsx` | render `MediaParts` in the user bubble and beside `renderToolCall`; `notice` case |
| `examples/research/web/app/components/Composer.tsx` | attach-image control (file input → base64 data part), chips, `onSend({ text, parts })` |
| `examples/research/web/app/components/AppShell.tsx` | capability gate via `useCapabilities()`; `send` builds parts; `onCustomEvent` subscription for notices |
| tests: `parts.test.ts`, `transcript.test.ts`, `hydrate.test.ts`, `MediaParts.test.tsx`, `Composer.test.tsx`, `AppShell.test.tsx` | + `.template` mirrors; bump the counts in `packages/devkit/test/templates.test.ts` |
| `packages/testing/src/harness.ts` | `run({ input: string \| readonly B4ContentPart[] })` passes parts through as the user content |
| `examples/research/server/evals/research-quality.eval.ts` + `*.fixtures.json` | a recorded `renderChart` case (recording needs `OPENAI_API_KEY`) |
| `apps/web/content/docs/recipes/research-web-ui.mdx`, `ag-ui.mdx` (Multimodal content: link to the recipe) | docs; lastmod regen; changeset |

---

### Task 1: `renderChart` tool

**Files:** `examples/research/server/src/tools/renderChart.ts` (+ template twin), `examples/research/server/test/render-chart.test.ts` (+ `.template`), `examples/research/server/src/app/research/index.ts` (+ twin), template `.b4/*.generated.d.ts`.

- [ ] **Step 1: Failing test** (`render-chart.test.ts`)

```ts
import { describe, expect, it } from "vitest"
import renderChart from "../src/tools/renderChart.js"

const ctx = {} as never // the tool reads no context

describe("renderChart", () => {
  it("returns a text summary and an inline SVG image part", async () => {
    const parts = await renderChart({ title: "Mentions", series: [{ label: "A", value: 3 }, { label: "B", value: 1 }] }, ctx)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: "text", text: "Chart \"Mentions\": A 3, B 1." })
    expect(parts[1]).toMatchObject({ type: "image", source: { type: "data", mimeType: "image/svg+xml" } })
    const svg = Buffer.from((parts[1] as { source: { value: string } }).source.value, "base64").toString("utf8")
    expect(svg.startsWith("<svg")).toBe(true)
    expect(svg).toContain("Mentions")
    expect(svg).toContain(">A<")
  })
  it("rejects an empty series and more than 12 bars", async () => {
    await expect(renderChart({ title: "x", series: [] }, ctx)).rejects.toThrow(/series/)
    await expect(renderChart({ title: "x", series: Array.from({ length: 13 }, (_, i) => ({ label: `${i}`, value: i })) }, ctx)).rejects.toThrow(/12/)
  })
  it("escapes labels and titles", async () => {
    const [, image] = await renderChart({ title: "<b>&", series: [{ label: "a<b", value: 1 }] }, ctx)
    const svg = Buffer.from((image as { source: { value: string } }).source.value, "base64").toString("utf8")
    expect(svg).not.toContain("<b>")
    expect(svg).toContain("&lt;b&gt;&amp;")
  })
})
```

- [ ] **Step 2: Implement**

```ts
// examples/research/server/src/tools/renderChart.ts
import type { B4ContentPart, B4ToolContext } from "@b4run/sdk"

const MAX_BARS = 12
const WIDTH = 480
const BAR_HEIGHT = 22
const GAP = 8
const LABEL_WIDTH = 120

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/**
 * Render a horizontal bar chart of the findings as an inline SVG. Returned as
 * content parts: a one-line summary the model always sees, and the image —
 * which reaches the model only where its profile admits media in a tool
 * message (never on OpenAI's Chat Completions path) and the UI always.
 */
export default async (
  input: { readonly title: string; readonly series: ReadonlyArray<{ readonly label: string; readonly value: number }> },
  _ctx: B4ToolContext,
): Promise<B4ContentPart[]> => {
  if (input.series.length === 0) throw new Error("renderChart needs at least one series entry")
  if (input.series.length > MAX_BARS) throw new Error(`renderChart draws at most ${MAX_BARS} bars`)
  const max = Math.max(...input.series.map((s) => s.value), 0) || 1
  const height = 40 + input.series.length * (BAR_HEIGHT + GAP)
  const bars = input.series
    .map((s, i) => {
      const y = 40 + i * (BAR_HEIGHT + GAP)
      const w = Math.round(((WIDTH - LABEL_WIDTH - 60) * s.value) / max)
      return `<text x="0" y="${y + 16}" font-size="13">${escape(s.label)}</text><rect x="${LABEL_WIDTH}" y="${y}" width="${w}" height="${BAR_HEIGHT}" fill="#4f46e5"/><text x="${LABEL_WIDTH + w + 6}" y="${y + 16}" font-size="13">${s.value}</text>`
    })
    .join("")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" font-family="system-ui, sans-serif"><text x="0" y="22" font-size="16" font-weight="600">${escape(input.title)}</text>${bars}</svg>`
  const summary = `Chart "${input.title}": ${input.series.map((s) => `${s.label} ${s.value}`).join(", ")}.`
  return [
    { type: "text", text: summary },
    { type: "image", source: { type: "data", value: Buffer.from(svg, "utf8").toString("base64"), mimeType: "image/svg+xml" } },
  ]
}
```

(Confirm the example's tool signature convention against `readDoc.ts` — `(input, ctx)` with `B4ToolContext` from `@b4run/sdk` — and whether `Buffer` is acceptable in example server code: the server runs on Node; if the example avoids `Buffer` elsewhere, use `btoa(unescape(encodeURIComponent(svg)))`.) Add a step to the system prompt in `src/app/research/index.ts`: "When findings compare quantities, call `renderChart` with a short title and up to 12 label/value pairs; the chart is shown to the user." Mirror both files to the template. Regenerate the template's `.b4/b4.generated.d.ts` and `scenarios.generated.d.ts`: `pnpm --filter @b4run/cli build && cd packages/devkit/templates/app-research/server && node ../../../../cli/bin/b4.js typegen` (confirm the invocation `packages/cli/test/run-typegen.test.ts` uses, ~L377) and commit the regenerated files.

- [ ] **Step 3:** `pnpm --filter @b4-example/research-server test` green (the new file + `research.test.ts`); `pnpm --filter @b4run/devkit test` (template parity + the count — a `.test.ts.template` was added: bump the hard-coded count); `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/run-typegen.test.ts`. Commit `feat(research): renderChart returns an inline SVG as a content part`.

---

### Task 2: `renderChart` in a scripted scenario

**Files:** `examples/research/server/test/research.test.ts` (+ `.template`)

- [ ] Add a case: `script().user("Compare mentions of A and B").callsTool("renderChart", { title: "Mentions", series: [{ label: "A", value: 3 }, { label: "B", value: 1 }] }).replies("Here is the chart.")`; assert `expectToolCalled(run, "renderChart")`, and that `run.toolResults` for that call has `content` whose parts include `{ type: "text", text: 'Chart "Mentions": A 3, B 1.' }` and an `image` part — read `packages/testing/src/run-result.ts` for how `toolResults[].content` is populated from the `tool_result` chunk (it may be the serialized `ToolMessage`; if so assert on `kwargs.additional_kwargs.b4_content_parts`, and note it). Commit `test(research): the agent can call renderChart`.

---

### Task 3: `parts.ts` and the transcript model

**Files:** `examples/research/web/app/lib/parts.ts` (create), `lib/transcript.ts`, `lib/hydrate.ts`, tests.

- [ ] **Step 1: Failing tests** (`parts.test.ts`, extend `transcript.test.ts`, `hydrate.test.ts`)

```ts
// parts.test.ts
import { blocksToParts, dataUrl, mediaParts, partsOf } from "./parts"
const png = { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } }
describe("partsOf", () => {
  it("a string is one text part; an array keeps valid parts; junk yields []", () => {
    expect(partsOf("hi")).toEqual([{ type: "text", text: "hi" }])
    expect(partsOf([{ type: "text", text: "a" }, png, null])).toEqual([{ type: "text", text: "a" }, png])
    expect(partsOf(42)).toEqual([])
  })
})
describe("mediaParts / dataUrl", () => {
  it("keeps non-text parts; a data source becomes a data: URL, a url source its URL, a file handle undefined", () => {
    expect(mediaParts([{ type: "text", text: "a" }, png])).toEqual([png])
    expect(dataUrl(png)).toBe("data:image/png;base64,AAAA")
    expect(dataUrl({ type: "image", source: { type: "url", value: "https://x/a.png" } })).toBe("https://x/a.png")
    expect(dataUrl({ type: "image", source: { type: "file", value: "file_1" } })).toBeUndefined()
  })
})
describe("blocksToParts", () => {
  it("maps LangChain v1 blocks from a checkpoint back to AG-UI parts", () => {
    expect(blocksToParts([{ type: "text", text: "t" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "image", url: "https://x/a.png" }, { type: "file", data: "JVBE", mimeType: "application/pdf" }, { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }])).toEqual([
      { type: "text", text: "t" },
      png,
      { type: "image", source: { type: "url", value: "https://x/a.png" } },
      { type: "document", source: { type: "data", value: "JVBE", mimeType: "application/pdf" } },
      { type: "image", source: { type: "data", value: "BBBB", mimeType: "image/png" } },
    ])
  })
})
```

`transcript.test.ts`: a user message with `[text, png]` yields `{ kind: "user", text: "…", parts: [text, png] }`; an image-only user message is NOT skipped (today empty-text users are dropped at ~L132 — keep that rule only when there are no media parts either); a tool result with parts yields `toolCall.toolResult.parts`; a `notice` item: given `notices` (from CUSTOM events) keyed by `toolCallId`, the item `{ kind: "notice", toolCallId, parts: DroppedPart[] }` follows its tool call; a user-turn notice (no `toolCallId`) follows the newest user item. `hydrate.test.ts`: a `HumanMessage` whose `kwargs.content` is v1 blocks hydrates to parts; a `ToolMessage` with `kwargs.additional_kwargs.b4_content_parts` hydrates to those parts (winning over `content`).

- [ ] **Step 2: Implement** `parts.ts` (pure; `isContentPart`/`contentPartsText` from `@b4run/sdk` — check the web app already depends on `@b4run/sdk`; if not, add it as a dependency of the example web and the template web `package.json`, which are NOT mirrored, so edit both), `transcript.ts` (`TranscriptItem` gains `parts?: readonly B4ContentPart[]` on `user` and on `toolCall.toolResult`, plus `{ kind: "notice"; toolCallId?: string; parts: readonly DroppedPartLike[] }`; `buildTranscript(messages, notices)` where `notices` is the list the shell collected), `hydrate.ts` (use `blocksToParts` for HumanMessage array content; for ToolMessage prefer `additional_kwargs.b4_content_parts` when it is a valid part list, else today's text). Keep `userText`/`toolResultText` for the chat title and previews.

- [ ] **Step 3:** `pnpm --filter @b4-example/research-web test` green. Commit `feat(research-web): transcript carries content parts and drop notices`.

---

### Task 4: `MediaParts` and the `Transcript` rendering

**Files:** `components/MediaParts.tsx` (create), `components/Transcript.tsx`, tests.

- [ ] **Tests** (`MediaParts.test.tsx` with `renderToStaticMarkup`): an image data part → `<img src="data:image/png;base64,AAAA" alt="image">`; a url image → `<img src="https://…">`; a document → a link chip (`<a href=data:… download>`), a file handle → a chip with the handle text and no link; audio/video → `<audio controls src>`/`<video controls src>`; text parts are not rendered (the bubble/card already shows text). `Transcript` tests (jsdom): a user item with parts shows the text AND the image; a toolCall item with result parts shows `renderToolCall(...)` output AND the media below it; a `notice` item renders a muted line "2 content parts were not sent to the model: image (tool_result_media_unsupported), audio (modality_unsupported)".
- [ ] **Implement**: `MediaParts({ parts })` as described; in `Transcript.tsx` the `user` case renders `<MediaParts parts={mediaParts(item.parts ?? [])}/>` under the text; the `toolCall` case renders media after `renderToolCall(...)` (CopilotKit's renderer flattens content, so this is the only place the media can be drawn — say so in a comment); add the `notice` case (the exhaustive `never` default forces it). Styling: reuse existing classes; images `max-width: 100%`. Commit `feat(research-web): render media parts and dropped-part notices`.

---

### Task 5: the composer's attach control and the shell wiring

**Files:** `components/Composer.tsx`, `components/AppShell.tsx`, tests.

- [ ] **Composer**: `onSend: (message: { text: string; parts: B4ContentPart[] }) => void`; new prop `canAttachImages: boolean`; when true, an "Attach image" button (`<label>` over a hidden `<input type="file" accept="image/*" multiple>`) and a chip row of pending attachments with a remove button; files are read with `FileReader.readAsDataURL` and become `{ type: "image", source: { type: "data", value: <base64 after the comma>, mimeType: file.type }, metadata: { filename: file.name } }`; Send is enabled when text is non-empty OR an attachment is pending; sending clears both. Keep the textarea's accessible name "Message" and the buttons "Send"/"Stop" (the demo capture and the harness select by them). Tests: with `canAttachImages=false` no button; with it, the button exists; a pending attachment enables Send with empty text; `onSend` receives `{ text, parts: [text?, image…] }` (jsdom; construct a `File` and dispatch `change`; stub `FileReader` if jsdom's is incomplete).
- [ ] **AppShell**: `const capabilities = useCapabilities()` (from `@copilotkit/react-core/v2`; the test's `vi.mock` must add it — return `{ multimodal: { input: { image: true } } }` by default and `undefined` in a negative case); `canAttachImages = capabilities?.multimodal?.input?.image === true`; `send({ text, parts })` → `agent.addMessage({ id, role: "user", content: parts.length > 0 ? [...(text ? [{ type: "text", text }] : []), ...parts] : text })`; `onUserMessage(text || "(image)")` for the rail title; `agent.subscribe({ onCustomEvent({ event }) { if (event.name === "b4.content_parts_dropped") setNotices(n => [...n, event.value]) } })` with the same lifecycle as the existing `onRunFinishedEvent` subscription in `MemoryPanel.tsx`; pass `notices` into `buildTranscript`. Tests (jsdom, extending `AppShell.test.tsx`): the attach button is absent when `useCapabilities()` returns no `multimodal`; present when `image: true`; sending with an attachment calls `agent.addMessage` with array content; a `b4.content_parts_dropped` custom event produces a `notice` item in the rendered transcript.
- [ ] Commit `feat(research-web): attach an image when the route takes one; show what the model did not see`.

---

### Task 6: harness accepts parts; recorded `renderChart` fixture

**Files:** `packages/testing/src/harness.ts` (+ its test), `examples/research/server/evals/research-quality.eval.ts` (+ a `*.fixtures.json`), template twins.

- [ ] `harness.run({ input })`: widen `input` to `string | readonly B4ContentPart[]` and pass it through as the user message content (today it builds `{ role: "user", content: input }`); `script().user()` stays text (fixture keys are text; PR 1's `firstUserMessage` reads text parts). Test: `run({ input: [text, png] })` reaches the route as parts (use the harness's own fake-route test pattern).
- [ ] Add an eval case `renders a chart for a quantitative comparison` with NO inline fixture (so `--record` captures it). **Recording needs a live key**: run `OPENAI_API_KEY=… pnpm --filter @b4-example/research-server exec b4 eval --record evals/research-quality.eval.ts` (confirm the exact CLI form in `packages/cli/src/commands/eval.ts`); commit the produced `research-quality.<slug>.fixtures.json` beside the eval (and its template twin). If no key is available in the session, STOP at this step and report `NEEDS_CONTEXT`: the controller records it. Replay (`pnpm --filter @b4-example/research-server test`/eval) must pass from the committed fixture.
- [ ] Commit `test(research): recorded gpt-5-mini fixture for renderChart; harness input accepts parts`.

---

### Task 7: docs, changeset, template parity, validation

- [ ] `apps/web/content/docs/recipes/research-web-ui.mdx`: Composer bullet (~L19) mentions attaching an image; new `## Attach an image` section after "The workbench shell": the `useCapabilities()` gate (why not `getCapabilities()` in the browser), the part the composer sends, media in tool cards drawn beside `renderToolCall` (CopilotKit flattens), the notice, and `renderChart` as the example of a media result that the UI shows and gpt-5-mini does not see. `ag-ui.mdx` Multimodal content: one link to the recipe. `check-docs`; lastmod regen in its own commit.
- [ ] `.changeset/agui-multimodal-example.md` — `@b4run/devkit`, `create-b4-app` (the template changed), `@b4run/testing` (harness input widened); patch.
- [ ] `pnpm --filter @b4run/devkit test` (parity + counts), `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/run-typegen.test.ts`, then the full gate list from PR 1's Task 14 (lint, build-cache, build, typecheck, test with flake isolation, release-inventory, release-integrity, check-docs, check-changesets, lastmod check, pack:check). The `harness-verify` lane (generated research app activation) is the CI gate most likely to notice the template change — run `pnpm verify:harness:self-test` if it is cheap; otherwise rely on CI.
- [ ] Open the PR (base: PR 2's branch until it merges). It closes #886.

## Self-review notes
- Spec §7 said the gate is `B4HttpAgent.getCapabilities()`; in the browser that call happens inside CopilotKit's `/info`, and the app reads `useCapabilities()` — spec amended with this plan.
- Spec §7 said media is rendered in `ToolCallCard`; CopilotKit's renderer only ever receives `contentToText(content)`, so media is drawn in `Transcript` beside the card — amended.
- The URL-paste control in §7 is dropped (YAGNI; the capability flag describes the inline source).
- A recorded USER-image fixture (spec §8) needs a live key like the chart one; Task 6 covers the harness widening and records the chart case; the image-turn recording is listed in the eval as a second case to record in the same session if a key is present.
