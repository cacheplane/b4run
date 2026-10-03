# AG-UI Multimodal — PR 1 (Runtime Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry AG-UI 1.0 content parts (image/audio/video/document, by `data`/`url`/`file` source) from both front doors to the model, let tools return parts, announce every part the model cannot use, and remove the `422 multimodal_not_supported` refusal.

**Architecture:** One SDK-owned part type (`B4ContentPart`, structurally AG-UI's `ContentPart`) widens `B4Message`, the route input message, the after-middleware message and the tool return. `packages/langchain/src/content-parts.ts` converts parts to LangChain standard content blocks under a `ModalitySupport` read from the model's `profile` (with a per-provider fallback), returning the parts it dropped; the adapter emits a `content_parts_dropped` chunk that the CLI logs and `@b4run/ag-ui` maps to a `CUSTOM` event. The envelope stage stops judging content; the Agent Protocol run path gets the same 8 MiB body bound.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), vitest, `@ag-ui/core` 1.0.1, `@langchain/core` 1.2.x standard content blocks (`{ type: "image", data|url|fileId, mimeType }`), pnpm workspace. Node 24. Run everything from the repo root. Never bare `biome check --write`.

**Spec:** `docs/superpowers/specs/2026-10-02-ag-ui-multimodal-design.md` (PR 1 = §9 item 1).

**Conventions that bite here:**
- `src/` imports siblings with `.js`; `test/` imports with `.ts` (or `.js` — follow the file you're in).
- Never write `{ x: undefined }` into an optional field; use `...(x !== undefined ? { x } : {})`.
- Per-package test: `pnpm --filter @b4run/<pkg> test -- <file>`; lint: `pnpm lint`; typecheck needs a build first: `pnpm build && pnpm typecheck`.
- Changesets are `patch` (fixed group on 0.x).

---

## File map

| File | Change |
|---|---|
| `packages/sdk/src/content-parts.ts` | **Create.** `B4ContentPart`, `B4PartSource`, `B4MessageContent`, `isContentPartArray`, `contentPartsText` |
| `packages/sdk/src/index.ts` | Export the above |
| `packages/sdk/src/middleware.ts` | `MiddlewareAfterMessage.content: B4MessageContent` |
| `packages/sdk/test/content-parts.test.ts` | **Create.** Guard + text tests |
| `packages/ag-ui/test/content-parts-shape.test.ts` | **Create.** Compile-time `ContentPart` ⇄ `B4ContentPart` assignability |
| `packages/ag-ui/src/inbound.ts` | `B4Message.content: B4MessageContent`; parts kept, not flattened |
| `packages/ag-ui/test/inbound.test.ts` | Parts tests |
| `packages/ag-ui/src/outbound.ts` | `toResultContent`; `content_parts_dropped` → `CUSTOM` |
| `packages/ag-ui/test/outbound.test.ts`, `conformance.test.ts` | Parts result + CUSTOM through the real client |
| `packages/langchain/src/chat-model-factory.ts` | `ModalitySupport`, `resolveModalitySupport`, `DEFAULT_MODALITY_SUPPORT`, `FILE_HANDLE_PROVIDERS` |
| `packages/langchain/src/content-parts.ts` | **Create.** `toLangChainContent`, `DroppedPart`, `formatDroppedPartsWarning` |
| `packages/langchain/src/unwrap-tool-result.ts` | `content: string \| readonly B4ContentPart[]` |
| `packages/langchain/src/tool-converter.ts` | Build a `ToolMessage` with blocks; dispatch drops |
| `packages/langchain/src/tool-loop.ts` | Same for the non-agent loop |
| `packages/langchain/src/agent-adapter.ts` | Parts in `InputMessage`; `extractMessages` after materialize; drop chunk |
| `packages/langchain/src/index.ts` | Export new symbols |
| `packages/langchain/test/content-parts.test.ts`, `chat-model-factory-modality.test.ts`, `agent-adapter-multimodal.test.ts`, `unwrap-tool-result.test.ts` (extend), `tool-converter-parts.test.ts` | Tests |
| `packages/cli/src/lib/dev/request-limits.ts` | **Create.** `AGUI_BODY_MAX_BYTES` moves here |
| `packages/cli/src/lib/dev/client-tool-runtime.ts` | Re-export the constant |
| `packages/cli/src/lib/dev/run-envelope.ts` | Remove the media refusal |
| `packages/cli/src/lib/dev/agui-handler.ts` | `messageText` at the client-tool seams; `toAfterMessage` widened |
| `packages/cli/src/lib/dev/runtime-fetch-core.ts` | Bounded AP run bodies |
| `packages/cli/src/lib/runtime/execute-route-core.ts` | Log `content_parts_dropped` |
| `packages/cli/test/agui-run-envelope.test.ts`, `ap-body-limit.test.ts` (create) | Tests |
| `packages/testing/src/record-fixtures.ts`, `matchers.ts` | Text of parts |
| `packages/testing/test/record-fixtures.test.ts` (extend or create), `matchers.test.ts` | Tests |
| `apps/web/content/docs/ag-ui.mdx`, `api/ag-ui.mdx`, `tools.mdx` | Docs |
| `scripts/check-docs.mjs` | Forbidden-phrase pin |
| `apps/web/app/seo/lastmod.generated.json` | Regenerated |
| `.changeset/agui-multimodal-input.md` | **Create** |

---

### Task 1: `B4ContentPart` in the SDK

**Files:**
- Create: `packages/sdk/src/content-parts.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/content-parts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/sdk/test/content-parts.test.ts
import { describe, expect, it } from "vitest"
import {
  type B4ContentPart,
  contentPartsText,
  isContentPartArray,
} from "../src/content-parts.ts"

const image: B4ContentPart = {
  type: "image",
  source: { type: "data", value: "iVBORw0KGgo=", mimeType: "image/png" },
}

describe("isContentPartArray", () => {
  it("accepts text and media parts with a valid source", () => {
    expect(isContentPartArray([{ type: "text", text: "hi" }, image])).toBe(true)
    expect(
      isContentPartArray([
        { type: "document", source: { type: "url", value: "https://x.test/a.pdf" } },
        { type: "audio", source: { type: "file", value: "file_123", provider: "openai" } },
      ]),
    ).toBe(true)
  })

  it("rejects non-arrays, non-object entries, unknown part types and malformed sources", () => {
    expect(isContentPartArray("hi")).toBe(false)
    expect(isContentPartArray([null])).toBe(false)
    expect(isContentPartArray([{ type: "reasoning", text: "x" }])).toBe(false)
    expect(isContentPartArray([{ type: "image", source: { type: "blob", value: "x" } }])).toBe(false)
    expect(isContentPartArray([{ type: "image", source: { type: "data", value: "x" } }])).toBe(false) // data needs mimeType
    expect(isContentPartArray([{ type: "text" }])).toBe(false)
  })

  it("accepts an empty array", () => {
    expect(isContentPartArray([])).toBe(true)
  })
})

describe("contentPartsText", () => {
  it("returns a string as is and concatenates text parts in order, skipping media", () => {
    expect(contentPartsText("plain")).toBe("plain")
    expect(contentPartsText([{ type: "text", text: "a" }, image, { type: "text", text: "b" }])).toBe("ab")
    expect(contentPartsText([image])).toBe("")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @b4run/sdk test -- test/content-parts.test.ts`
Expected: FAIL — cannot find module `../src/content-parts.ts`.

- [ ] **Step 3: Implement**

```ts
// packages/sdk/src/content-parts.ts
/**
 * Message content parts, structurally identical to AG-UI 1.0's `ContentPart`
 * (`@ag-ui/core`), declared here so tools, middleware and the langchain
 * adapter never import the protocol package. `packages/ag-ui` pins the two
 * shapes to each other at compile time.
 *
 * A media part's `source` says where its bytes are: carried inline (`data`),
 * fetchable by URL (`url`) — B4.run never fetches it; the provider does — or
 * already at the model provider under a handle it issued (`file`).
 */

export interface B4DataSource {
  readonly type: "data"
  /** The bytes, base64-encoded. */
  readonly value: string
  readonly mimeType: string
}

export interface B4UrlSource {
  readonly type: "url"
  readonly value: string
  readonly mimeType?: string
}

export interface B4FileSource {
  readonly type: "file"
  /** The provider's handle, opaque: never fetched, parsed or inspected. */
  readonly value: string
  /** Lowercase vendor id (`openai`, `anthropic`, `google`) when the producer knows it. */
  readonly provider?: string
  readonly mimeType?: string
}

export type B4PartSource = B4DataSource | B4UrlSource | B4FileSource

export interface B4TextPart {
  readonly type: "text"
  readonly text: string
  readonly id?: string
  readonly metadata?: unknown
}

export type B4MediaPartType = "image" | "audio" | "video" | "document"

export interface B4MediaPart {
  readonly type: B4MediaPartType
  readonly source: B4PartSource
  readonly id?: string
  readonly metadata?: unknown
}

export type B4ContentPart = B4TextPart | B4MediaPart

/** What a user or tool message carries: plain text, or an ordered list of parts. */
export type B4MessageContent = string | readonly B4ContentPart[]

const MEDIA_PART_TYPES: ReadonlySet<string> = new Set(["image", "audio", "video", "document"])
const SOURCE_TYPES: ReadonlySet<string> = new Set(["data", "url", "file"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPartSource(value: unknown): value is B4PartSource {
  if (!isRecord(value) || typeof value.type !== "string" || !SOURCE_TYPES.has(value.type)) return false
  if (typeof value.value !== "string") return false
  if (value.type === "data") return typeof value.mimeType === "string"
  if (value.mimeType !== undefined && typeof value.mimeType !== "string") return false
  if (value.type === "file" && value.provider !== undefined && typeof value.provider !== "string") return false
  return true
}

export function isContentPart(value: unknown): value is B4ContentPart {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (value.id !== undefined && typeof value.id !== "string") return false
  if (value.type === "text") return typeof value.text === "string"
  return MEDIA_PART_TYPES.has(value.type) && isPartSource(value.source)
}

/** Structural guard for an unvalidated content array; an empty array is a (text-less) part list. */
export function isContentPartArray(value: unknown): value is readonly B4ContentPart[] {
  return Array.isArray(value) && value.every(isContentPart)
}

/** The text of a message: a string as is; a part list's text parts, in order; media contributes nothing. */
export function contentPartsText(content: B4MessageContent): string {
  if (typeof content === "string") return content
  let text = ""
  for (const part of content) if (part.type === "text") text += part.text
  return text
}
```

Add to `packages/sdk/src/index.ts` (alphabetical among the other `./x.js` groups):

```ts
export type {
  B4ContentPart,
  B4DataSource,
  B4FileSource,
  B4MediaPart,
  B4MediaPartType,
  B4MessageContent,
  B4PartSource,
  B4TextPart,
  B4UrlSource,
} from "./content-parts.js"
export { contentPartsText, isContentPart, isContentPartArray } from "./content-parts.js"
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @b4run/sdk test -- test/content-parts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Check the SDK's public-API pin, if any**

Run: `pnpm --filter @b4run/sdk test`
Expected: PASS. If a test pins the export list (search `packages/sdk/test` for `Object.keys(sdk)` or a snapshot of exports), add the new names to it in the order the test expects.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/content-parts.ts packages/sdk/src/index.ts packages/sdk/test/content-parts.test.ts
git commit -m "feat(sdk): B4ContentPart — the AG-UI 1.0 content part shape for tools and middleware"
```

---

### Task 2: Pin `B4ContentPart` to AG-UI's `ContentPart`

**Files:**
- Create: `packages/ag-ui/test/content-parts-shape.test.ts`

- [ ] **Step 1: Write the compile-time test**

```ts
// packages/ag-ui/test/content-parts-shape.test.ts
import type { ContentPart } from "@ag-ui/core"
import type { B4ContentPart } from "@b4run/sdk"
import { expect, test } from "vitest"

/**
 * The SDK's part type is a structural copy of the protocol's. Either direction
 * failing to assign means a 1.x addition widened one side: update
 * `packages/sdk/src/content-parts.ts` deliberately rather than letting the
 * runtime carry a shape it does not know.
 */
type AssignableBothWays<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

const pinned: AssignableBothWays<ContentPart, B4ContentPart> = true

test("B4ContentPart and ContentPart are mutually assignable", () => {
  expect(pinned).toBe(true)
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4run/ag-ui test -- test/content-parts-shape.test.ts`
Expected: PASS. If it fails to typecheck on `metadata` (`any` vs `unknown`) or `id`, the SDK side is wrong — fix `content-parts.ts` to match the protocol (the protocol is the authority), not the test. `pnpm --filter @b4run/ag-ui typecheck` must also pass (vitest alone does not typecheck; run `pnpm build && pnpm --filter @b4run/ag-ui typecheck` after Task 1's build).

- [ ] **Step 3: Commit**

```bash
git add packages/ag-ui/test/content-parts-shape.test.ts
git commit -m "test(ag-ui): pin B4ContentPart to the protocol's ContentPart"
```

---

### Task 3: `ModalitySupport` and `resolveModalitySupport`

**Files:**
- Modify: `packages/langchain/src/chat-model-factory.ts` (after `unsupportedResponseFormatMessage`)
- Modify: `packages/langchain/src/index.ts`
- Test: `packages/langchain/test/chat-model-factory-modality.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/langchain/test/chat-model-factory-modality.test.ts
import { describe, expect, it } from "vitest"
import {
  DEFAULT_MODALITY_SUPPORT,
  type ModalitySupport,
  resolveModalitySupport,
} from "../src/chat-model-factory.ts"

const fullProfile = {
  imageInputs: true,
  imageUrlInputs: true,
  pdfInputs: true,
  audioInputs: true,
  videoInputs: true,
  imageToolMessage: true,
  pdfToolMessage: true,
}

describe("resolveModalitySupport", () => {
  it("reads every flag off the model profile", () => {
    expect(resolveModalitySupport({ profile: fullProfile }, "google")).toEqual({
      image: { data: true, url: true },
      pdf: true,
      audio: true,
      video: true,
      toolResult: { image: true, pdf: true },
      file: true,
    } satisfies ModalitySupport)
  })

  it("defaults an absent flag to false", () => {
    const support = resolveModalitySupport({ profile: { imageInputs: true } }, "openai")
    expect(support.image).toEqual({ data: true, url: false })
    expect(support.pdf).toBe(false)
    expect(support.audio).toBe(false)
    expect(support.toolResult).toEqual({ image: false, pdf: false })
  })

  it("uses the provider fallback when the profile is missing or empty", () => {
    expect(resolveModalitySupport({}, "ollama")).toEqual({
      ...DEFAULT_MODALITY_SUPPORT,
      image: { data: true, url: false },
    })
    expect(resolveModalitySupport({ profile: {} }, "mistral")).toEqual(DEFAULT_MODALITY_SUPPORT)
    expect(resolveModalitySupport(undefined, "groq")).toEqual(DEFAULT_MODALITY_SUPPORT)
  })

  it("claims file handles only for the providers whose converters map fileId", () => {
    expect(resolveModalitySupport({ profile: fullProfile }, "openai").file).toBe(true)
    expect(resolveModalitySupport({ profile: fullProfile }, "anthropic").file).toBe(true)
    expect(resolveModalitySupport({ profile: fullProfile }, "xai").file).toBe(false)
    expect(resolveModalitySupport({}, "openai").file).toBe(true)
  })

  it("the default claims images by data and url and nothing else", () => {
    expect(DEFAULT_MODALITY_SUPPORT).toEqual({
      image: { data: true, url: true },
      pdf: false,
      audio: false,
      video: false,
      toolResult: { image: false, pdf: false },
      file: false,
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @b4run/langchain test -- test/chat-model-factory-modality.test.ts`
Expected: FAIL — `resolveModalitySupport` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/langchain/src/chat-model-factory.ts`, directly after `unsupportedResponseFormatMessage`:

```ts
/**
 * What a route's model can take, as a content part: the one judgment behind
 * both the run-time drop decision (`toLangChainContent`) and the `multimodal`
 * section of `GET /agui/:routeId`. Read off LangChain's per-model `profile`
 * (`@langchain/core` `ModelProfile`), every flag defaulting to `false`; a
 * model with no profile — every `ollama` and `mistral` model, an unknown id
 * elsewhere — falls back to a conservative per-provider table. `file` is a
 * provider fact, not a profile one: whether its converter maps a `fileId`.
 */
export interface ModalitySupport {
  readonly image: { readonly data: boolean; readonly url: boolean }
  readonly pdf: boolean
  readonly audio: boolean
  readonly video: boolean
  readonly toolResult: { readonly image: boolean; readonly pdf: boolean }
  readonly file: boolean
}

/** Images inline or by URL, and nothing else: what every provider's converter handles. */
export const DEFAULT_MODALITY_SUPPORT: ModalitySupport = {
  image: { data: true, url: true },
  pdf: false,
  audio: false,
  video: false,
  toolResult: { image: false, pdf: false },
  file: false,
}

/** Providers whose LangChain converter maps a provider file handle (`fileId`). */
export const FILE_HANDLE_PROVIDERS: readonly BuiltInModelProviderId[] = [
  "openai",
  "anthropic",
  "google",
]

const PROVIDER_MODALITY_FALLBACK: Partial<Record<BuiltInModelProviderId, ModalitySupport>> = {
  // `@langchain/ollama` base64-encodes `image_url` content and cannot pass a URL through.
  ollama: { ...DEFAULT_MODALITY_SUPPORT, image: { data: true, url: false } },
}

interface ProfileFlags {
  readonly imageInputs?: unknown
  readonly imageUrlInputs?: unknown
  readonly pdfInputs?: unknown
  readonly audioInputs?: unknown
  readonly videoInputs?: unknown
  readonly imageToolMessage?: unknown
  readonly pdfToolMessage?: unknown
}

function readProfile(model: unknown): ProfileFlags | undefined {
  if (typeof model !== "object" || model === null) return undefined
  const profile = (model as { readonly profile?: unknown }).profile
  if (typeof profile !== "object" || profile === null || Object.keys(profile).length === 0) {
    return undefined
  }
  return profile as ProfileFlags
}

export function resolveModalitySupport(
  model: unknown,
  provider: BuiltInModelProviderId,
): ModalitySupport {
  const file = FILE_HANDLE_PROVIDERS.includes(provider)
  const profile = readProfile(model)
  if (!profile) {
    return { ...(PROVIDER_MODALITY_FALLBACK[provider] ?? DEFAULT_MODALITY_SUPPORT), file }
  }
  return {
    image: { data: profile.imageInputs === true, url: profile.imageUrlInputs === true },
    pdf: profile.pdfInputs === true,
    audio: profile.audioInputs === true,
    video: profile.videoInputs === true,
    toolResult: {
      image: profile.imageToolMessage === true,
      pdf: profile.pdfToolMessage === true,
    },
    file,
  }
}
```

Add to the `chat-model-factory.js` export block in `packages/langchain/src/index.ts`:

```ts
export type { JsonSchemaResponseFormat, ModalitySupport } from "./chat-model-factory.js"
export {
  createChatModel,
  DEFAULT_MODALITY_SUPPORT,
  FILE_HANDLE_PROVIDERS,
  JSON_SCHEMA_RESPONSE_FORMAT_PROVIDERS,
  providerPackages,
  resolveModalitySupport,
  seedModelImporter,
  supportsJsonSchemaResponseFormat,
  unsupportedResponseFormatMessage,
} from "./chat-model-factory.js"
```

(Replace the existing `export type { JsonSchemaResponseFormat }` line and the existing `export { createChatModel, … }` block.)

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @b4run/langchain test -- test/chat-model-factory-modality.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/chat-model-factory.ts packages/langchain/src/index.ts packages/langchain/test/chat-model-factory-modality.test.ts
git commit -m "feat(langchain): resolveModalitySupport — what a model takes, from its LangChain profile"
```

---

### Task 4: `toLangChainContent` and the drop record

**Files:**
- Create: `packages/langchain/src/content-parts.ts`
- Modify: `packages/langchain/src/index.ts`
- Test: `packages/langchain/test/content-parts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/langchain/test/content-parts.test.ts
import type { B4ContentPart } from "@b4run/sdk"
import { describe, expect, it } from "vitest"
import { DEFAULT_MODALITY_SUPPORT, type ModalitySupport } from "../src/chat-model-factory.ts"
import { formatDroppedPartsWarning, toLangChainContent } from "../src/content-parts.ts"

const ALL: ModalitySupport = {
  image: { data: true, url: true },
  pdf: true,
  audio: true,
  video: true,
  toolResult: { image: true, pdf: true },
  file: true,
}

const png = { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } } as const
const imgUrl = { type: "image", source: { type: "url", value: "https://x.test/a.png" } } as const
const pdf = {
  type: "document",
  source: { type: "data", value: "JVBERi0=", mimeType: "application/pdf" },
} as const
const wav = { type: "audio", source: { type: "data", value: "UklGRg==", mimeType: "audio/wav" } } as const
const mp4 = { type: "video", source: { type: "url", value: "https://x.test/a.mp4" } } as const
const handle = {
  type: "image",
  source: { type: "file", value: "file_abc", provider: "openai" },
} as const

describe("toLangChainContent — user position", () => {
  it("returns a string unchanged with no drops", () => {
    expect(toLangChainContent("hi", ALL, "openai", "user")).toEqual({ content: "hi", dropped: [] })
  })

  it("maps every part and source to LangChain standard blocks when supported", () => {
    const parts: B4ContentPart[] = [{ type: "text", text: "look" }, png, imgUrl, pdf, wav, mp4, handle]
    const { content, dropped } = toLangChainContent(parts, ALL, "openai", "user")
    expect(dropped).toEqual([])
    expect(content).toEqual([
      { type: "text", text: "look" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "image", url: "https://x.test/a.png" },
      { type: "file", data: "JVBERi0=", mimeType: "application/pdf" },
      { type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
      { type: "video", url: "https://x.test/a.mp4" },
      { type: "image", fileId: "file_abc" },
    ])
  })

  it("drops unsupported modalities and says why", () => {
    const { content, dropped } = toLangChainContent(
      [{ type: "text", text: "t" }, png, pdf, wav, mp4],
      DEFAULT_MODALITY_SUPPORT,
      "openai",
      "user",
    )
    expect(content).toEqual([
      { type: "text", text: "t" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ])
    expect(dropped).toEqual([
      { index: 2, type: "document", source: "data", reason: "modality_unsupported" },
      { index: 3, type: "audio", source: "data", reason: "modality_unsupported" },
      { index: 4, type: "video", source: "url", reason: "modality_unsupported" },
    ])
  })

  it("drops a url image when only inline images are supported", () => {
    const support = { ...ALL, image: { data: true, url: false } }
    const { dropped } = toLangChainContent([imgUrl], support, "ollama", "user")
    expect(dropped).toEqual([{ index: 0, type: "image", source: "url", reason: "url_source_unsupported" }])
  })

  it("drops a file handle the provider cannot resolve, and a foreign provider's handle", () => {
    expect(toLangChainContent([handle], { ...ALL, file: false }, "xai", "user").dropped).toEqual([
      { index: 0, type: "image", source: "file", reason: "file_source_unsupported" },
    ])
    expect(toLangChainContent([handle], ALL, "anthropic", "user").dropped).toEqual([
      { index: 0, type: "image", source: "file", reason: "foreign_file_provider" },
    ])
    // No provider named: the route's provider is assumed to have minted it.
    const anon = { type: "image", source: { type: "file", value: "f" } } as const
    expect(toLangChainContent([anon], ALL, "anthropic", "user").dropped).toEqual([])
  })

  it("a document is a PDF or nothing", () => {
    const notPdf = { type: "document", source: { type: "data", value: "x", mimeType: "text/csv" } } as const
    const urlNoMime = { type: "document", source: { type: "url", value: "https://x.test/a.pdf" } } as const
    const urlPdf = {
      type: "document",
      source: { type: "url", value: "https://x.test/a.pdf", mimeType: "application/pdf" },
    } as const
    const { content, dropped } = toLangChainContent([notPdf, urlNoMime, urlPdf], ALL, "openai", "user")
    expect(dropped).toEqual([
      { index: 0, type: "document", source: "data", reason: "document_not_pdf" },
      { index: 1, type: "document", source: "url", reason: "document_not_pdf" },
    ])
    expect(content).toEqual([{ type: "file", url: "https://x.test/a.pdf", mimeType: "application/pdf" }])
  })

  it("an array that loses every block becomes an empty string", () => {
    expect(toLangChainContent([wav], DEFAULT_MODALITY_SUPPORT, "openai", "user").content).toBe("")
    expect(toLangChainContent([], ALL, "openai", "user").content).toBe("")
  })
})

describe("toLangChainContent — tool position", () => {
  it("additionally requires the tool-message flags; audio and video never reach the model", () => {
    const support = { ...ALL, toolResult: { image: true, pdf: false } }
    const { content, dropped } = toLangChainContent(
      [{ type: "text", text: "r" }, png, pdf, wav],
      support,
      "openai",
      "tool",
    )
    expect(content).toEqual([
      { type: "text", text: "r" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ])
    expect(dropped).toEqual([
      { index: 2, type: "document", source: "data", reason: "tool_result_media_unsupported" },
      { index: 3, type: "audio", source: "data", reason: "tool_result_media_unsupported" },
    ])
  })
})

describe("formatDroppedPartsWarning", () => {
  it("names the model, each part and its reason, and points at the capability document", () => {
    const text = formatDroppedPartsWarning({
      provider: "openai",
      model: "gpt-5-mini",
      routeId: "/chat",
      parts: [
        { index: 1, type: "audio", source: "data", reason: "modality_unsupported" },
        { index: 2, type: "image", source: "url", reason: "url_source_unsupported" },
      ],
    })
    expect(text).toBe(
      "B4: dropped 2 content part(s) the model cannot use (openai/gpt-5-mini): audio/data (modality_unsupported), image/url (url_source_unsupported). GET /agui/%2Fchat lists what this route accepts.",
    )
  })

  it("omits the capability pointer without a route id", () => {
    expect(
      formatDroppedPartsWarning({
        provider: "ollama",
        model: "llama3",
        parts: [{ index: 0, type: "video", source: "url", reason: "modality_unsupported" }],
      }),
    ).toBe("B4: dropped 1 content part(s) the model cannot use (ollama/llama3): video/url (modality_unsupported).")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @b4run/langchain test -- test/content-parts.test.ts`
Expected: FAIL — cannot find module `../src/content-parts.ts`.

- [ ] **Step 3: Implement**

```ts
// packages/langchain/src/content-parts.ts
/**
 * AG-UI content parts → LangChain standard content blocks, under what the
 * route's model can take. Pure: the one place that decides a part is dropped,
 * so the capability document (`GET /agui/:routeId`) and the run agree.
 *
 * Spec (AG-UI 1.0, run-input): a producer handed a part it cannot use MUST NOT
 * fail the run; it skips the part, continues, and warns. The drops come back
 * as data for the caller to announce (`formatDroppedPartsWarning`, and the
 * `content_parts_dropped` chunk).
 */

import type { B4ContentPart, B4MessageContent, BuiltInModelProviderId } from "@b4run/sdk"
import type { ModalitySupport } from "./chat-model-factory.js"

export type DropReason =
  | "modality_unsupported"
  | "url_source_unsupported"
  | "file_source_unsupported"
  | "foreign_file_provider"
  | "document_not_pdf"
  | "tool_result_media_unsupported"

export interface DroppedPart {
  /** Position in the message's part list. */
  readonly index: number
  readonly type: string
  readonly source?: "data" | "url" | "file"
  readonly reason: DropReason
}

/** A LangChain standard content block (`@langchain/core` `Multimodal.Standard` or a text block). */
export type LangChainContentBlock = Readonly<Record<string, unknown>> & { readonly type: string }

export interface ConvertedContent {
  readonly content: string | readonly LangChainContentBlock[]
  readonly dropped: readonly DroppedPart[]
}

const PDF = "application/pdf"

function supportsModality(part: Extract<B4ContentPart, { type: "image" | "audio" | "video" | "document" }>, support: ModalitySupport): boolean {
  switch (part.type) {
    case "image":
      return support.image.data || support.image.url || support.file
    case "audio":
      return support.audio
    case "video":
      return support.video
    case "document":
      return support.pdf
  }
}

function toolResultAllows(type: string, support: ModalitySupport): boolean {
  if (type === "image") return support.toolResult.image
  if (type === "document") return support.toolResult.pdf
  return false
}

function block(
  type: "image" | "audio" | "video" | "file",
  source: Extract<B4ContentPart, { source: unknown }>["source"],
): LangChainContentBlock {
  switch (source.type) {
    case "data":
      return { type, data: source.value, mimeType: source.mimeType }
    case "url":
      return { type, url: source.value, ...(source.mimeType !== undefined ? { mimeType: source.mimeType } : {}) }
    case "file":
      return { type, fileId: source.value, ...(source.mimeType !== undefined ? { mimeType: source.mimeType } : {}) }
  }
}

export function toLangChainContent(
  content: B4MessageContent,
  support: ModalitySupport,
  provider: BuiltInModelProviderId | undefined,
  position: "user" | "tool",
): ConvertedContent {
  if (typeof content === "string") return { content, dropped: [] }
  const blocks: LangChainContentBlock[] = []
  const dropped: DroppedPart[] = []
  content.forEach((part, index) => {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text })
      return
    }
    const drop = (reason: DropReason) =>
      dropped.push({ index, type: part.type, source: part.source.type, reason })

    if (part.type === "document" && part.source.mimeType !== PDF) return drop("document_not_pdf")
    if (!supportsModality(part, support)) return drop("modality_unsupported")
    if (position === "tool" && !toolResultAllows(part.type, support)) {
      return drop("tool_result_media_unsupported")
    }
    if (part.source.type === "file") {
      if (!support.file) return drop("file_source_unsupported")
      if (part.source.provider !== undefined && part.source.provider !== provider) {
        return drop("foreign_file_provider")
      }
    } else if (part.type === "image") {
      // Image sources are gated individually: a model may take bytes but not a URL.
      if (part.source.type === "data" && !support.image.data) return drop("modality_unsupported")
      if (part.source.type === "url" && !support.image.url) return drop("url_source_unsupported")
    }
    blocks.push(block(part.type === "document" ? "file" : part.type, part.source))
  })
  return { content: blocks.length === 0 ? "" : blocks, dropped }
}

export interface DroppedPartsReport {
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly routeId?: string
  readonly messageId?: string
  readonly toolCallId?: string
  readonly parts: readonly DroppedPart[]
}

/** The spec's developer warning: what was dropped, why, and where to see what is accepted. */
export function formatDroppedPartsWarning(report: DroppedPartsReport): string {
  const model = `${report.provider ?? "unknown"}/${report.model ?? "unknown"}`
  const list = report.parts
    .map((part) => `${part.type}/${part.source ?? "?"} (${part.reason})`)
    .join(", ")
  const pointer =
    report.routeId !== undefined
      ? ` GET /agui/${encodeURIComponent(report.routeId)} lists what this route accepts.`
      : ""
  return `B4: dropped ${report.parts.length} content part(s) the model cannot use (${model}): ${list}.${pointer}`
}
```

Add to `packages/langchain/src/index.ts`:

```ts
export type {
  ConvertedContent,
  DropReason,
  DroppedPart,
  DroppedPartsReport,
  LangChainContentBlock,
} from "./content-parts.js"
export { formatDroppedPartsWarning, toLangChainContent } from "./content-parts.js"
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @b4run/langchain test -- test/content-parts.test.ts`
Expected: PASS (10 tests). If the "image/url when only inline" case reports `modality_unsupported` instead of `url_source_unsupported`, check the ordering: `supportsModality` passes (data is true), then the per-source gate fires — that is the intended path.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/content-parts.ts packages/langchain/src/index.ts packages/langchain/test/content-parts.test.ts
git commit -m "feat(langchain): toLangChainContent — content parts to model blocks, with every drop recorded"
```

---

### Task 5: `B4Message` carries parts (`@b4run/ag-ui` inbound)

**Files:**
- Modify: `packages/ag-ui/src/inbound.ts`
- Modify: `packages/ag-ui/test/inbound.test.ts`
- Modify: `packages/ag-ui/package.json` only if `@b4run/sdk` is not already a dependency (check `grep '"@b4run/sdk"' packages/ag-ui/package.json`; it is used by `client.ts`'s types in #883, so it is likely there — if absent add `"@b4run/sdk": "workspace:*"` to `dependencies` and run `pnpm install`).

- [ ] **Step 1: Update the tests**

In `packages/ag-ui/test/inbound.test.ts`, replace the two tests `"a user message's text parts concatenate in order"` and `"a tool message's text parts concatenate in order"` with:

```ts
  test("a user message's parts are kept as parts, in order", () => {
    const parts = [
      { type: "text", text: "Hello, " },
      { type: "image", source: { type: "url", value: "https://x.test/a.png" } },
      { type: "text", text: "world" },
    ]
    const { messages } = fromRunAgentInput(input([{ id: "1", role: "user", content: parts }]))
    expect(messages[0]?.content).toEqual(parts)
  })

  test("a tool message's parts are kept as parts", () => {
    const parts = [
      { type: "text", text: '{"ok":true}' },
      { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
    ]
    const { messages } = fromRunAgentInput(
      input([{ id: "2", role: "tool", toolCallId: "c1", content: parts }]),
    )
    expect(messages[0]).toEqual({ role: "tool", content: parts, id: "2", toolCallId: "c1" })
  })

  test("non-object entries in a part list are dropped; a list with none left is empty text", () => {
    const { messages } = fromRunAgentInput(
      input([
        { id: "1", role: "user", content: [null, 42, { type: "text", text: "a" }] as unknown as never },
        { id: "2", role: "user", content: [null] as unknown as never },
      ]),
    )
    expect(messages[0]?.content).toEqual([{ type: "text", text: "a" }])
    expect(messages[1]?.content).toBe("")
  })

  test("an entry that is an object but not a valid part is dropped", () => {
    const { messages } = fromRunAgentInput(
      input([
        {
          id: "1",
          role: "user",
          content: [{ type: "image", source: { type: "blob", value: "x" } }, { type: "text", text: "t" }] as unknown as never,
        },
      ]),
    )
    expect(messages[0]?.content).toEqual([{ type: "text", text: "t" }])
  })
```

Keep the existing `"stringifies non-string, non-parts content"` and `String()` fallback tests as they are.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/ag-ui test -- test/inbound.test.ts`
Expected: FAIL — content is a concatenated string, not the parts.

- [ ] **Step 3: Implement**

In `packages/ag-ui/src/inbound.ts`:

```ts
import type { Message, RunAgentInput } from "@ag-ui/core"
import { type B4MessageContent, isContentPart } from "@b4run/sdk"
import { type B4ResumeRequest, fromAguiResume } from "./interrupts.js"

export interface B4Message {
  readonly role: "user" | "assistant" | "system" | "developer" | "tool"
  /** Plain text, or the ordered content parts the client sent (AG-UI 1.0). */
  readonly content: B4MessageContent
  readonly id?: string
  readonly toolCallId?: string
}
```

Replace `coerceContent` with:

```ts
/**
 * A message's content. 1.0 content is `string | ContentPart[]`; a string is
 * kept as is and a part list is kept as parts — the runtime decides what the
 * model can take (`toLangChainContent`), so nothing is flattened here.
 * Entries that are not valid parts are dropped, so an unvalidated list cannot
 * throw downstream; a list with nothing left is empty text. Any other shape
 * becomes its JSON, as before.
 */
function coerceMessageContent(content: unknown): B4MessageContent {
  if (typeof content === "string") return content
  if (content === undefined || content === null) return ""
  if (Array.isArray(content)) {
    const parts = content.filter(isContentPart)
    return parts.length === 0 ? "" : parts
  }
  try {
    const json = JSON.stringify(content)
    return typeof json === "string" ? json : String(content)
  } catch {
    return String(content)
  }
}
```

Update `toB4ToolMessage(message, content: B4MessageContent)` and both call sites in `toB4Message` to use `coerceMessageContent`. Remove the `contentToText` import. Update the file's header comment: replace the sentence about media parts being refused with "Media parts are carried through; the runtime drops what the route's model cannot take and announces it."

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @b4run/ag-ui test -- test/inbound.test.ts`
Expected: PASS.

- [ ] **Step 5: Build and typecheck downstream**

Run: `pnpm build && pnpm typecheck`
Expected: FAIL in `packages/cli` (`agui-handler.ts`: `encoder.encode(message.content)`, `toAfterMessage`, `newestUserMessage.content` into `streamRoute` are still typed string). That is Task 10's job; note the error sites, do not fix them here.

- [ ] **Step 6: Commit**

```bash
git add packages/ag-ui/src/inbound.ts packages/ag-ui/test/inbound.test.ts
git commit -m "feat(ag-ui): B4Message carries content parts instead of flattening them"
```

---

### Task 6: Adapter — parts into the model, drops announced

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts`
- Test: `packages/langchain/test/agent-adapter-multimodal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/langchain/test/agent-adapter-multimodal.test.ts
import { agent } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, describe, expect, it, vi } from "vitest"
import { __resetMaterializedAgentsForTests, type AgentStreamChunk, streamAgent } from "../src/agent-adapter.ts"

const seenMessages: BaseMessage[][] = []
let fakeProfile: Record<string, unknown> = {}

class ProfiledChatModel extends BaseChatModel {
  constructor(_options: Record<string, unknown>) {
    super({})
  }
  get profile(): Record<string, unknown> {
    return fakeProfile
  }
  _llmType(): string {
    return "profiled-fake"
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    seenMessages.push(messages)
    const message = new AIMessage({ content: "seen" })
    return { generations: [{ text: "seen", message }] }
  }
  // biome-ignore lint/suspicious/noExplicitAny: loose bindTools in the hierarchy
  bindTools(): any {
    return this
  }
}

const png = { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } } as const
const wav = { type: "audio", source: { type: "data", value: "UklG", mimeType: "audio/wav" } } as const

async function run(content: unknown): Promise<AgentStreamChunk[]> {
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ProfiledChatModel }))
  try {
    const chunks: AgentStreamChunk[] = []
    for await (const chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry: agent({ model: "gpt-5-mini", systemPrompt: "Describe." }),
      input: { messages: [{ role: "user", content }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      threadId: `t-${Math.random()}`,
      tools: [],
    })) {
      chunks.push(chunk)
    }
    return chunks
  } finally {
    vi.doUnmock("@langchain/openai")
  }
}

function humanContent(): unknown {
  const human = seenMessages.at(-1)?.find((m) => m.getType() === "human")
  return human?.content
}

describe("multimodal user input", () => {
  afterEach(() => {
    seenMessages.length = 0
    fakeProfile = {}
    __resetMaterializedAgentsForTests()
  })

  it("carries supported parts to the model as standard blocks", async () => {
    fakeProfile = { imageInputs: true, audioInputs: true }
    const chunks = await run([{ type: "text", text: "what is this" }, png, wav])
    expect(humanContent()).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "audio", data: "UklG", mimeType: "audio/wav" },
    ])
    expect(chunks.some((c) => c.type === "content_parts_dropped")).toBe(false)
  })

  it("drops what the profile refuses, runs anyway, and announces the drop before the model turn", async () => {
    fakeProfile = { imageInputs: true }
    const chunks = await run([{ type: "text", text: "listen" }, wav, png])
    expect(humanContent()).toEqual([
      { type: "text", text: "listen" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ])
    const dropIndex = chunks.findIndex((c) => c.type === "content_parts_dropped")
    expect(dropIndex).toBeGreaterThanOrEqual(0)
    expect(chunks[dropIndex]?.data).toEqual({
      provider: "openai",
      model: "gpt-5-mini",
      parts: [{ index: 1, type: "audio", source: "data", reason: "modality_unsupported" }],
    })
    expect(chunks.findIndex((c) => c.type === "done")).toBeGreaterThan(dropIndex)
  })

  it("a plain string is unchanged and array content no longer degrades to [object Object]", async () => {
    await run("plain")
    expect(humanContent()).toBe("plain")
    seenMessages.length = 0
    await run([{ type: "text", text: "only text" }])
    expect(humanContent()).toEqual([{ type: "text", text: "only text" }])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/langchain test -- test/agent-adapter-multimodal.test.ts`
Expected: FAIL — the human message content is `"[object Object]"`-style text (array input hits `formatAgentMessage`).

- [ ] **Step 3: Implement**

In `packages/langchain/src/agent-adapter.ts`:

(a) Imports — add:

```ts
import { type B4MessageContent, type BuiltInModelProviderId, isContentPartArray } from "@b4run/sdk"
import {
  DEFAULT_MODALITY_SUPPORT,
  type ModalitySupport,
  resolveModalitySupport,
} from "./chat-model-factory.js"
import { type DroppedPart, toLangChainContent } from "./content-parts.js"
```

(`createChatModel` is already imported from `./chat-model-factory.js`; merge into that import.)

(b) Beside the `materializedAgents` cache (near line 82), add a side table keyed by the materialized agent, so cached agents keep their modality:

```ts
/** What the materialized agent's root model takes, read once at model construction. */
interface MaterializedModality {
  readonly support: ModalitySupport
  readonly provider: BuiltInModelProviderId | undefined
  readonly model: string | undefined
}
const materializedModality = new WeakMap<AgentLike, MaterializedModality>()
const RAW_RUNNABLE_MODALITY: MaterializedModality = {
  support: DEFAULT_MODALITY_SUPPORT,
  provider: undefined,
  model: undefined,
}
```

(c) In `materializeAgent`, right after `const llm = await createChatModel({...})`, compute the support, and record it on the returned agent at every return point that yields a new agent (the end of the function where `createAgent(...)` result is produced — search for where the result is stored in `materializedAgents` near line 223; set `materializedModality.set(result, modality)` just before `return result`). Code:

```ts
  const modality: MaterializedModality = {
    support: resolveModalitySupport(llm, provider),
    provider,
    model: descriptor.model,
  }
```

…and after the agent is built (same variable the function returns):

```ts
  materializedModality.set(materialized, modality)
```

(Use the actual local name of the built agent in that function. The cache path `if (cached) return cached` needs nothing: the entry was set when it was first built.)

(d) Tool conversion needs the support too (Task 7 consumes it). Move the `langchainTools = tools.map(...)` block to AFTER `createChatModel`/`modality`, and pass `modality` as the new sixth argument of `convertToolToLangChain` (Task 7 adds the parameter; until then leave the call unchanged and reorder only).

(e) Replace `InputMessage`, `isInputMessageArray`, `extractMessages`:

```ts
interface InputMessage {
  readonly role: string
  readonly content: B4MessageContent
}

function isInputMessageArray(value: unknown): value is readonly InputMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { role?: unknown }).role === "string" &&
        (typeof (item as { content?: unknown }).content === "string" ||
          isContentPartArray((item as { content?: unknown }).content)),
    )
  )
}

interface ExtractedMessages {
  readonly messages: HumanMessage[]
  readonly dropped: readonly DroppedPart[]
}

/**
 * The user turn(s) for the model. Content parts become LangChain standard
 * blocks under what the root model takes; what it cannot take is dropped and
 * returned for the caller to announce — never a failed run (AG-UI 1.0).
 */
function extractMessages(
  input: Record<string, unknown>,
  modality: MaterializedModality,
): ExtractedMessages {
  // LangGraph protocol format: {messages: [{role, content}, ...]}
  if (isInputMessageArray(input.messages)) {
    const dropped: DroppedPart[] = []
    const messages = input.messages
      .filter((msg) => msg.role === "user")
      .map((msg) => {
        const converted = toLangChainContent(msg.content, modality.support, modality.provider, "user")
        dropped.push(...converted.dropped)
        return new HumanMessage({ content: converted.content as HumanMessage["content"] })
      })
    return { messages, dropped }
  }

  // Legacy flat-object format: {key: value, ...}
  return { messages: [new HumanMessage(formatAgentMessage(input))], dropped: [] }
}

function droppedPartsChunk(modality: MaterializedModality, dropped: readonly DroppedPart[]): AgentStreamChunk {
  return {
    type: "content_parts_dropped",
    data: { provider: modality.provider, model: modality.model, parts: dropped },
  }
}
```

(f) In `streamAgent`: delete the early `const messages = isCommandInput ? [] : extractMessages(agentInput)`. In the descriptor branch, after `materializedAgent` is obtained:

```ts
    const modality = materializedModality.get(materializedAgent) ?? RAW_RUNNABLE_MODALITY
    const extracted = isCommandInput ? { messages: [], dropped: [] } : extractMessages(agentInput, modality)
    if (extracted.dropped.length > 0) yield droppedPartsChunk(modality, extracted.dropped)
    const runnableInput = isCommandInput ? options.input : { messages: extracted.messages }
```

In the legacy raw-runnable branch, before `const runnableInput = ...`:

```ts
  const extracted = isCommandInput ? { messages: [], dropped: [] } : extractMessages(agentInput, RAW_RUNNABLE_MODALITY)
  if (extracted.dropped.length > 0) yield droppedPartsChunk(RAW_RUNNABLE_MODALITY, extracted.dropped)
  const runnableInput = isCommandInput ? options.input : { messages: extracted.messages }
```

(g) `executeAgentTurn` (the non-streaming path; search for its `extractMessages(` call): apply the same shape. It has no stream to announce on, so log:

```ts
    if (extracted.dropped.length > 0) {
      console.warn(formatDroppedPartsWarning({ provider: modality.provider, model: modality.model, parts: extracted.dropped }))
    }
```

(import `formatDroppedPartsWarning` from `./content-parts.js`). If `executeAgentTurn` materializes before extracting, read `materializedModality` the same way; if it extracts first, reorder so materialization comes first.

(h) `content_parts_dropped` must not be treated as a reserved root name — it is not in `RESERVED_ROOT_EVENT_NAMES`, so a tool's `b4.capability` dispatch with `event: "content_parts_dropped"` (Task 7) flows through `on_custom_event` unchanged. Nothing to do; verify by reading `isCapabilityEventName`.

- [ ] **Step 4: Run the new test and the adapter suite**

Run: `pnpm --filter @b4run/langchain test -- test/agent-adapter-multimodal.test.ts test/agent-adapter.test.ts test/agent-descriptor-integration.test.ts test/agent-response-format.test.ts`
Expected: PASS. If `agent-descriptor-integration.test.ts` fails on `input: { question: "hi" }`, the legacy flat-object path regressed — `extractMessages` must still fall through to `formatAgentMessage` when `input.messages` is absent.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts packages/langchain/test/agent-adapter-multimodal.test.ts
git commit -m "feat(langchain): carry user content parts to the model; drop and announce what it cannot take"
```

---

### Task 7: Tools return parts

**Files:**
- Modify: `packages/langchain/src/unwrap-tool-result.ts`
- Modify: `packages/langchain/src/tool-converter.ts`
- Modify: `packages/langchain/src/tool-loop.ts`
- Modify: `packages/langchain/src/agent-adapter.ts` (pass `modality` to `convertToolToLangChain`)
- Test: `packages/langchain/test/unwrap-tool-result.test.ts` (extend; create if absent), `packages/langchain/test/tool-converter-parts.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/langchain/test/unwrap-tool-result.test.ts` (create the file with the standard imports if it does not exist):

```ts
import { describe, expect, it } from "vitest"
import { unwrapToolResult } from "../src/unwrap-tool-result.ts"

const png = { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } } as const

describe("unwrapToolResult with content parts", () => {
  it("keeps a part array as parts", () => {
    const parts = [{ type: "text", text: "chart" }, png]
    expect(unwrapToolResult(parts)).toEqual({ content: parts, stateUpdates: undefined })
  })

  it("keeps a wrapped part array and its state", () => {
    const parts = [png]
    expect(unwrapToolResult({ result: parts, state: { n: 1 } })).toEqual({
      content: parts,
      stateUpdates: { n: 1 },
    })
  })

  it("an array that is not a part list is still JSON", () => {
    expect(unwrapToolResult([1, 2])).toEqual({ content: "[1,2]", stateUpdates: undefined })
    expect(unwrapToolResult([{ type: "text" }])).toEqual({ content: '[{"type":"text"}]', stateUpdates: undefined })
  })
})
```

Create `packages/langchain/test/tool-converter-parts.test.ts`:

```ts
import { ToolMessage } from "@langchain/core/messages"
import { describe, expect, it, vi } from "vitest"
import type { ModalitySupport } from "../src/chat-model-factory.ts"
import { convertToolToLangChain } from "../src/tool-converter.ts"

vi.mock("@langchain/core/callbacks/dispatch/web", () => ({ dispatchCustomEvent: vi.fn() }))
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch/web"

const png = { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } } as const
const wav = { type: "audio", source: { type: "data", value: "UklG", mimeType: "audio/wav" } } as const
const ALL: ModalitySupport = {
  image: { data: true, url: true },
  pdf: true,
  audio: true,
  video: true,
  toolResult: { image: true, pdf: true },
  file: true,
}
const config = { configurable: { tool_call_id: "call_1" } }

function tool(result: unknown) {
  return { name: "render", description: "d", run: async () => result }
}

describe("tool results with content parts", () => {
  it("returns a ToolMessage whose content is the model-visible blocks and whose kwargs keep every part", async () => {
    const converted = convertToolToLangChain(tool([{ type: "text", text: "here" }, png]), undefined, undefined, [], [], {
      support: ALL,
      provider: "openai",
      model: "gpt-5-mini",
    })
    const out = (await converted.invoke({}, config)) as ToolMessage
    expect(out).toBeInstanceOf(ToolMessage)
    expect(out.tool_call_id).toBe("call_1")
    expect(out.content).toEqual([
      { type: "text", text: "here" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ])
    expect(out.additional_kwargs.b4_content_parts).toEqual([{ type: "text", text: "here" }, png])
  })

  it("keeps media out of the model's view when the profile refuses it, and announces the drop", async () => {
    const converted = convertToolToLangChain(tool([{ type: "text", text: "here" }, png, wav]), undefined, undefined, [], [], {
      support: { ...ALL, toolResult: { image: false, pdf: false } },
      provider: "openai",
      model: "gpt-5-mini",
    })
    const out = (await converted.invoke({}, config)) as ToolMessage
    expect(out.content).toEqual([{ type: "text", text: "here" }])
    expect(out.additional_kwargs.b4_content_parts).toEqual([{ type: "text", text: "here" }, png, wav])
    expect(dispatchCustomEvent).toHaveBeenCalledWith(
      "b4.capability",
      {
        event: "content_parts_dropped",
        data: {
          provider: "openai",
          model: "gpt-5-mini",
          toolCallId: "call_1",
          parts: [
            { index: 1, type: "image", source: "data", reason: "tool_result_media_unsupported" },
            { index: 2, type: "audio", source: "data", reason: "tool_result_media_unsupported" },
          ],
        },
      },
      expect.anything(),
    )
  })

  it("offload sees only the text; media parts bypass it", async () => {
    const offload = vi.fn(async (content: string) => `<stub for ${content.length} chars>`)
    const converted = convertToolToLangChain(tool([{ type: "text", text: "x".repeat(10) }, png]), undefined, offload, [], [], {
      support: ALL,
      provider: "openai",
      model: "gpt-5-mini",
    })
    const out = (await converted.invoke({}, config)) as ToolMessage
    expect(offload).toHaveBeenCalledWith("x".repeat(10), "render", "call_1", expect.anything())
    expect(out.content).toEqual([
      { type: "text", text: "<stub for 10 chars>" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ])
  })

  it("a string result is unchanged (no ToolMessage wrapping here)", async () => {
    const converted = convertToolToLangChain(tool("plain"), undefined, undefined, [], [], {
      support: ALL,
      provider: "openai",
      model: "gpt-5-mini",
    })
    expect(await converted.invoke({}, config)).toBe("plain")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/langchain test -- test/unwrap-tool-result.test.ts test/tool-converter-parts.test.ts`
Expected: FAIL — `content` is a JSON string; `convertToolToLangChain` has five parameters.

- [ ] **Step 3: Implement `unwrapToolResult`**

```ts
// packages/langchain/src/unwrap-tool-result.ts (edited parts)
import { type B4ContentPart, isContentPartArray } from "@b4run/sdk"

export interface UnwrappedToolResult {
  /** The agent-facing content: text, or the ordered parts the tool returned. */
  readonly content: string | readonly B4ContentPart[]
  readonly stateUpdates: Record<string, unknown> | undefined
}

export function unwrapToolResult(value: unknown): UnwrappedToolResult {
  if (isContentPartArray(value) && value.length > 0) return { content: value, stateUpdates: undefined }
  if (!isWrapperShape(value)) {
    return { content: JSON.stringify(value), stateUpdates: undefined }
  }
  const { result, state } = value as { result: unknown; state?: unknown }
  if (result === undefined) {
    return { content: JSON.stringify(value), stateUpdates: undefined }
  }
  const content =
    typeof result === "string"
      ? result
      : isContentPartArray(result) && result.length > 0
        ? result
        : JSON.stringify(result)
  const stateUpdates =
    state !== undefined && state !== null && typeof state === "object"
      ? (state as Record<string, unknown>)
      : undefined
  return { content, stateUpdates }
}
```

Update the doc comment: a part array (plain or wrapped) is kept as parts; an empty array is JSON `[]` as before.

- [ ] **Step 4: Implement the converter**

In `packages/langchain/src/tool-converter.ts`:

```ts
import { type B4ContentPart, contentPartsText } from "@b4run/sdk"
import type { BuiltInModelProviderId } from "@b4run/sdk"
import type { ModalitySupport } from "./chat-model-factory.js"
import { type LangChainContentBlock, toLangChainContent } from "./content-parts.js"

/** The root model's modality, for shaping a tool's media result. */
export interface ToolResultModality {
  readonly support: ModalitySupport
  readonly provider: BuiltInModelProviderId | undefined
  readonly model: string | undefined
}

/** The key under which a ToolMessage keeps every part the tool returned, for the UI. */
export const B4_CONTENT_PARTS_KEY = "b4_content_parts"

export function convertToolToLangChain(
  tool: B4ToolDefinition,
  middlewareContext?: Readonly<Record<string, unknown>>,
  offload?: OffloadFn,
  routeParamNames: readonly string[] = [],
  streamTransformers: readonly StreamTransformer[] = [],
  modality?: ToolResultModality,
): DynamicStructuredTool {
```

Inside the tool `func`, replace from `const { content, stateUpdates } = unwrapToolResult(rawResult)` through `const convertedResult = ...` with:

```ts
      const { content, stateUpdates } = unwrapToolResult(rawResult)
      let finalContent: string | readonly LangChainContentBlock[]
      let partsForUi: readonly B4ContentPart[] | undefined
      if (typeof content === "string") {
        finalContent = offload
          ? await offload(content, tool.name, toolCallId || undefined, signal)
          : content
      } else {
        // Offload bounds the text; media bypass it (their size is the body's business).
        partsForUi = content
        const text = contentPartsText(content)
        const offloadedText = offload
          ? await offload(text, tool.name, toolCallId || undefined, signal)
          : text
        const modelParts: B4ContentPart[] = [
          ...(offloadedText.length > 0 ? [{ type: "text" as const, text: offloadedText }] : []),
          ...content.filter((part) => part.type !== "text"),
        ]
        const support = modality?.support ?? DEFAULT_TOOL_MODALITY.support
        const converted = toLangChainContent(modelParts, support, modality?.provider, "tool")
        // Indices are reported against the tool's ORIGINAL part list.
        const textCount = content.filter((part) => part.type === "text").length
        const mediaOffset = offloadedText.length > 0 ? 1 : 0
        const dropped = converted.dropped.map((drop) => {
          const mediaOrdinal = drop.index - mediaOffset
          const original = content
            .map((part, index) => ({ part, index }))
            .filter(({ part }) => part.type !== "text")[mediaOrdinal]
          return { ...drop, index: original?.index ?? drop.index + textCount - mediaOffset }
        })
        if (dropped.length > 0) {
          try {
            await dispatchCustomEvent(
              "b4.capability",
              {
                event: "content_parts_dropped",
                data: {
                  provider: modality?.provider,
                  model: modality?.model,
                  ...(toolCallId ? { toolCallId } : {}),
                  parts: dropped,
                },
              },
              liveConfig,
            )
          } catch {
            // The announce is secondary; the result still stands.
          }
        }
        finalContent = converted.content
      }

      const toolMessage = (): ToolMessage =>
        new ToolMessage({
          content: finalContent as ToolMessage["content"],
          tool_call_id: toolCallId,
          name: tool.name,
          ...(partsForUi ? { additional_kwargs: { [B4_CONTENT_PARTS_KEY]: partsForUi } } : {}),
        })

      const convertedResult = stateUpdates
        ? new Command({ update: { ...stateUpdates, messages: [toolMessage()] } })
        : partsForUi
          ? toolMessage()
          : finalContent
```

Add near the top of the file:

```ts
import { DEFAULT_MODALITY_SUPPORT } from "./chat-model-factory.js"
const DEFAULT_TOOL_MODALITY: ToolResultModality = {
  support: DEFAULT_MODALITY_SUPPORT,
  provider: undefined,
  model: undefined,
}
```

Make sure `liveConfig` is in scope where the dispatch happens (it is the patched config used by the existing `b4.capability` dispatch further down; if it is declared after this point, move its declaration up).

Note on the simpler alternative for indices: if the index remap above reads as too clever, instead convert the ORIGINAL `content` with `toLangChainContent(content, support, provider, "tool")` to get `dropped` with original indices, and separately build `finalContent` by replacing the text blocks of `converted.content` with one `{ type: "text", text: offloadedText }` block at the position of the first text block. Either is acceptable; the tests only assert indices against the original list.

In `packages/langchain/src/tool-loop.ts`, the non-agent loop:

```ts
import { isContentPartArray } from "@b4run/sdk"
import { DEFAULT_MODALITY_SUPPORT } from "./chat-model-factory.js"
import { toLangChainContent } from "./content-parts.js"
```

and replace `content: JSON.stringify(output)` with:

```ts
            content: isContentPartArray(output) && output.length > 0
              ? (toLangChainContent(output, DEFAULT_MODALITY_SUPPORT, undefined, "tool").content as ToolMessage["content"])
              : JSON.stringify(output),
```

(The chain loop has no profile and no stream: media is text-only for the model there, and the UI gets nothing extra. Document this in a one-line comment.)

In `packages/langchain/src/agent-adapter.ts` `materializeAgent`, pass the modality (now that tools are converted after the model exists — Task 6 (d)):

```ts
    const converted = convertToolToLangChain(
      tool,
      opts.middlewareContext,
      opts.offload,
      opts.routeParamNames ?? [],
      opts.streamTransformers ?? [],
      modality,
    )
```

The legacy raw-runnable branch in `streamAgent` passes `RAW_RUNNABLE_MODALITY`.

Export from `packages/langchain/src/index.ts`:

```ts
export type { OffloadFn, ToolResultModality } from "./tool-converter.js"
export { B4_CONTENT_PARTS_KEY, convertToolToLangChain } from "./tool-converter.js"
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @b4run/langchain test`
Expected: PASS across the package (offload tests, tool-converter tests, state-update tests included). A failure in `offload-integration.test.ts` means the string path changed — it must be byte-identical to before.

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/src/unwrap-tool-result.ts packages/langchain/src/tool-converter.ts packages/langchain/src/tool-loop.ts packages/langchain/src/agent-adapter.ts packages/langchain/src/index.ts packages/langchain/test/unwrap-tool-result.test.ts packages/langchain/test/tool-converter-parts.test.ts
git commit -m "feat(langchain): tools return content parts; media reaches the model when its profile allows"
```

---

### Task 8: Outbound — parts on `TOOL_CALL_RESULT`, drops as `CUSTOM`

**Files:**
- Modify: `packages/ag-ui/src/outbound.ts`
- Modify: `packages/ag-ui/test/outbound.test.ts`, `packages/ag-ui/test/conformance.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/ag-ui/test/outbound.test.ts`:

```ts
const PNG_PART = { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } }

describe("content parts outbound", () => {
  test("a tool result that is a part array becomes ContentPart[] content", async () => {
    const parts = [{ type: "text", text: "chart" }, PNG_PART]
    const events = await collect([
      { type: "tool_call", data: { id: "c1", name: "render", input: {} } },
      { type: "tool_result", data: { id: "c1", name: "render", output: parts } },
      { type: "done", data: {} },
    ])
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT)
    expect(result).toEqual({ type: EventType.TOOL_CALL_RESULT, messageId: "tr-1", toolCallId: "c1", content: parts })
    expect(() => ToolCallResultEventSchema.parse(result)).not.toThrow()
  })

  test("a ToolMessage that kept its parts in kwargs emits them, not the model-visible blocks", async () => {
    const parts = [{ type: "text", text: "chart" }, PNG_PART]
    const toolMessage = {
      lc: 1,
      type: "constructor",
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: {
        content: [{ type: "text", text: "chart" }],
        tool_call_id: "c1",
        additional_kwargs: { b4_content_parts: parts },
      },
    }
    const events = await collect([
      { type: "tool_result", data: { id: "c1", name: "render", output: toolMessage } },
      { type: "done", data: {} },
    ])
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as { content: unknown }
    expect(result.content).toEqual(parts)
  })

  test("content_parts_dropped becomes a vendor-prefixed CUSTOM event", async () => {
    const data = {
      provider: "openai",
      model: "gpt-5-mini",
      parts: [{ index: 1, type: "audio", source: "data", reason: "modality_unsupported" }],
    }
    const events = await collect([
      { type: "content_parts_dropped", data },
      { type: "token", data: "ok" },
      { type: "done", data: {} },
    ])
    expect(events[1]).toEqual({ type: EventType.CUSTOM, name: "b4.content_parts_dropped", value: data })
  })
})
```

In `packages/ag-ui/test/conformance.test.ts`, add to `CANNED` (after the `searchCorpus` tool result, before the plan/subagent chunks):

```ts
  {
    type: "content_parts_dropped",
    data: { provider: "openai", model: "gpt-5-mini", parts: [{ index: 0, type: "video", source: "url", reason: "modality_unsupported" }] },
  },
  { type: "tool_call", data: { id: "call_render_0_3", name: "renderChart", input: {} } },
  {
    type: "tool_result",
    data: {
      id: "call_render_0_3",
      name: "renderChart",
      output: [{ type: "text", text: "chart" }, { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } }],
    },
  },
```

and extend the file's assertions so the received events include a `CUSTOM` named `b4.content_parts_dropped` and a `TOOL_CALL_RESULT` whose `content` is an array of two parts — following how the file already asserts the ordinary tool result. The zero-warnings gate already in the file is the point: both must pass the real client's enforcement silently.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/ag-ui test -- test/outbound.test.ts test/conformance.test.ts`
Expected: FAIL — content is a JSON string; the `content_parts_dropped` chunk is ignored.

- [ ] **Step 3: Implement**

In `packages/ag-ui/src/outbound.ts`:

```ts
import type { ContentPart, CustomEvent, /* …existing… */ } from "@ag-ui/core"
import { isContentPartArray } from "@b4run/sdk"

export type AguiOutboundEvent =
  | /* …existing members… */
  | CustomEvent

/** The CUSTOM event name for the spec's lossy-downgrade warning. */
export const B4_CONTENT_PARTS_DROPPED_EVENT = "b4.content_parts_dropped"
```

Replace `stringifyContent` with:

```ts
/**
 * A tool result's wire content. A part array (the tool returned parts, or a
 * ToolMessage kept them under `additional_kwargs.b4_content_parts` so the UI
 * sees every part even when the model saw only text) travels as parts;
 * anything else is text, as before.
 */
function toResultContent(output: unknown): string | ContentPart[] {
  if (isContentPartArray(output) && output.length > 0) return [...output] as ContentPart[]
  const kept = keptParts(output)
  if (kept) return kept
  if (typeof output === "string") return output
  if (output === undefined || output === null) return ""
  try {
    const serialized = JSON.stringify(output)
    return typeof serialized === "string" ? serialized : String(output)
  } catch {
    return String(output)
  }
}

/** `additional_kwargs.b4_content_parts` off a live ToolMessage or its serialized `kwargs` form. */
function keptParts(output: unknown): ContentPart[] | undefined {
  if (typeof output !== "object" || output === null) return undefined
  const record = output as { readonly additional_kwargs?: unknown; readonly kwargs?: { readonly additional_kwargs?: unknown } }
  const kwargs = record.additional_kwargs ?? record.kwargs?.additional_kwargs
  if (typeof kwargs !== "object" || kwargs === null) return undefined
  const parts = (kwargs as { readonly b4_content_parts?: unknown }).b4_content_parts
  return isContentPartArray(parts) && parts.length > 0 ? ([...parts] as ContentPart[]) : undefined
}
```

In the `tool_result` case: `content: toResultContent(tr.output)`.

Add a case before `default` in the chunk `switch`:

```ts
        case "content_parts_dropped": {
          yield* flushText()
          yield* ledger.onPassthrough({
            type: EventType.CUSTOM,
            name: B4_CONTENT_PARTS_DROPPED_EVENT,
            value: chunk.data,
          })
          break
        }
```

(`CUSTOM` ends an open chunk stream in its lane per spec, which `flushText()` does for text; if `ledger.onPassthrough` rejects a `CustomEvent` type, widen its parameter type — it already accepts `TextMessageEndEvent` and `ToolCallEndEvent`.)

Export `B4_CONTENT_PARTS_DROPPED_EVENT` from `packages/ag-ui/src/index.ts`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @b4run/ag-ui test`
Expected: PASS, including `conformance.test.ts` with zero client warnings and `public-api.test.ts` (add the new export to its pinned list if it has one).

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/outbound.ts packages/ag-ui/src/index.ts packages/ag-ui/test/outbound.test.ts packages/ag-ui/test/conformance.test.ts
git commit -m "feat(ag-ui): tool results travel as content parts; dropped parts announced as CUSTOM"
```

---

### Task 9: Remove the envelope refusal

**Files:**
- Modify: `packages/cli/src/lib/dev/run-envelope.ts`
- Modify: `packages/cli/test/agui-run-envelope.test.ts`

- [ ] **Step 1: Update the tests**

In `packages/cli/test/agui-run-envelope.test.ts`, replace the whole `describe("multimodal input", …)` block with:

```ts
describe("multimodal input", () => {
  const image = { type: "image", source: { type: "url", value: "https://example.test/a.png" } }

  it("serves a message carrying a media part; middleware runs", async () => {
    let middlewareRan = false
    const { handler } = await setup({
      middleware: () => {
        middlewareRan = true
        return { action: "continue" }
      },
    })
    const response = await handler.fetch(
      aguiPost(HELLO_ROUTE, {
        messages: [{ id: "1", role: "user", content: [{ type: "text", text: "see" }, image] }],
      }),
    )
    expect(response.status).toBe(200)
    expect(middlewareRan).toBe(true)
    await drain(response)
  })

  it("serves a media part on a tool message too", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(
      aguiPost(HELLO_ROUTE, {
        messages: [
          { id: "1", role: "user", content: "hello" },
          { id: "2", role: "tool", toolCallId: "c1", content: [image] },
        ],
      }),
    )
    expect(response.status).toBe(200)
    await drain(response)
  })

  it("a part with an unknown source type is a schema failure (400), not an envelope refusal", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(
      aguiPost(HELLO_ROUTE, {
        messages: [{ id: "1", role: "user", content: [{ type: "image", source: { type: "blob", value: "x" } }] }],
      }),
    )
    expect(response.status).toBe(400)
  })

  it("serves text-only parts", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(
      aguiPost(HELLO_ROUTE, {
        messages: [{ id: "1", role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    )
    expect(response.status).toBe(200)
    await drain(response)
  })
})
```

If a unit test in the same file calls `validateRunEnvelope` with a media part expecting `multimodal_not_supported`, delete it.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/cli test -- test/agui-run-envelope.test.ts`
Expected: FAIL — 422 where 200 is expected. (The 400 case may fail or pass depending on the schema; keep it either way — if the 1.0 schema accepts an unknown source arm, change the assertion to `toBe(200)` and note it in the test name: the spec says closed arms fail validation, and the SDK's behaviour is the fact.)

- [ ] **Step 3: Implement**

In `packages/cli/src/lib/dev/run-envelope.ts`: delete `MEDIA_PART_TYPES`, `carriesMediaPart`, the `"multimodal_not_supported"` member of `RunEnvelopeRejectionCode`, and the `if (carriesMediaPart(body.messages)) { … }` block. Replace the header paragraph "Image, audio, video and document content parts are refused…" with:

```
 * Content is NOT judged here. Image, audio, video and document parts are
 * carried to the runtime, which drops what the route's model cannot take and
 * announces it (`content_parts_dropped`) — a run is never failed over a part
 * (AG-UI 1.0, run-input). The model is known only after middleware, so no
 * content decision belongs at the envelope stage.
```

- [ ] **Step 4: Run**

Run: `pnpm --filter @b4run/cli test -- test/agui-run-envelope.test.ts`
Expected: PASS. (The package may not fully typecheck until Task 10.)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/run-envelope.ts packages/cli/test/agui-run-envelope.test.ts
git commit -m "feat(cli): stop refusing media content parts at the AG-UI envelope stage"
```

---

### Task 10: CLI — widened content through the handler, after-middleware, and the log

**Files:**
- Modify: `packages/sdk/src/middleware.ts`
- Modify: `packages/cli/src/lib/dev/agui-handler.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route-core.ts`
- Test: `packages/cli/test/agui-handler-parts.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/agui-handler-parts.test.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// A graph route that echoes the content it was given, so the test can see what
// crossed the handler without a model.
const ECHO_ROUTE =
  "export const graph = async (input) => ({ echoed: input.messages?.[0]?.content ?? null })\n"

async function setup(): Promise<Awaited<ReturnType<typeof createRuntimeFetchHandler>>> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-agui-parts-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "agui-parts-fixture", "type": "module" }\n',
    "src/app/echo/index.ts": ECHO_ROUTE,
  }
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(dirname(join(appRoot, rel)), { recursive: true })
    await writeFile(join(appRoot, rel), src, "utf8")
  }
  const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
  cleanup.push(() => handler.close())
  return handler
}

const parts = [
  { type: "text", text: "see" },
  { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
]

async function sse(response: Response): Promise<string> {
  return await response.text()
}

describe("content parts through the AG-UI handler", () => {
  it("reaches the route as parts, not as text or [object Object]", async () => {
    const handler = await setup()
    const response = await handler.fetch(
      new Request("http://localhost/agui/%2Fecho%23graph", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({
          threadId: "t-1",
          runId: "r-1",
          messages: [{ id: "1", role: "user", content: parts }],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      }),
    )
    expect(response.status).toBe(200)
    const body = await sse(response)
    expect(body).toContain(JSON.stringify(parts))
    expect(body).not.toContain("[object Object]")
  })

  it("after-middleware sees the parts the client sent", async () => {
    const seen: unknown[] = []
    const appRoot = await mkdtemp(join(tmpdir(), "b4-agui-parts-mw-"))
    cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
    await mkdir(join(appRoot, "src/app/echo"), { recursive: true })
    await writeFile(join(appRoot, "b4.config.ts"), "export default {}\n")
    await writeFile(join(appRoot, "package.json"), '{ "name": "x", "type": "module" }\n')
    await writeFile(join(appRoot, "src/app/echo/index.ts"), ECHO_ROUTE)
    const handler = await createRuntimeFetchHandler({
      appRoot,
      drainDeadlineMs: 250,
      middleware: () => ({ action: "continue" }),
      middlewareAfter: (run) => {
        seen.push(run.messages[0]?.content)
        return { action: "continue" }
      },
    })
    cleanup.push(() => handler.close())
    const response = await handler.fetch(
      new Request("http://localhost/agui/%2Fecho%23graph", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ threadId: "t-2", runId: "r-2", messages: [{ id: "1", role: "user", content: parts }], state: {}, tools: [], context: [], forwardedProps: {} }),
      }),
    )
    await response.text()
    expect(seen).toEqual([parts])
  })

  it("logs a content_parts_dropped chunk once per run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    cleanup.push(() => warn.mockRestore())
    const appRoot = await mkdtemp(join(tmpdir(), "b4-agui-parts-drop-"))
    cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
    await mkdir(join(appRoot, "src/app/drop"), { recursive: true })
    await writeFile(join(appRoot, "b4.config.ts"), "export default {}\n")
    await writeFile(join(appRoot, "package.json"), '{ "name": "x", "type": "module" }\n')
    // A graph route that emits the chunk the adapter would: the CLI's log is what is under test.
    await writeFile(
      join(appRoot, "src/app/drop/index.ts"),
      `export const graph = async function* () {
  yield { type: "content_parts_dropped", data: { provider: "openai", model: "gpt-5-mini", parts: [{ index: 0, type: "audio", source: "data", reason: "modality_unsupported" }] } }
  yield { type: "done", data: {} }
}
`,
    )
    const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
    cleanup.push(() => handler.close())
    const response = await handler.fetch(
      new Request("http://localhost/agui/%2Fdrop%23graph", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ threadId: "t-3", runId: "r-3", messages: [{ id: "1", role: "user", content: "x" }], state: {}, tools: [], context: [], forwardedProps: {} }),
      }),
    )
    const body = await response.text()
    expect(body).toContain('"name":"b4.content_parts_dropped"')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped 1 content part(s) the model cannot use (openai/gpt-5-mini): audio/data (modality_unsupported)"))
  })
})
```

If the `middlewareAfter` option is named differently on `createRuntimeFetchHandler` (check `packages/cli/src/lib/dev/runtime-fetch-handler.ts` and how `applyMiddlewareAfter` is wired in `agui-handler.ts`), use that name; if after-middleware can only be registered through the app's `middleware.ts` file, write it into the fixture as `src/middleware.ts` with `export const after = …` following `packages/cli/test` precedents (search `middlewareAfter` there). If graph routes cannot `yield` chunks (check how `execute-route-core.ts` treats an async-generator graph), replace the third test's route with a `graph` returning `{}` and instead unit-test the log by calling the exported log formatter site directly — but try the generator first; `execute-route-core.ts` does iterate `AsyncIterable` route outputs.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/cli test -- test/agui-handler-parts.test.ts`
Expected: FAIL to compile or run (handler still types content as string; no log).

- [ ] **Step 3: Implement**

`packages/sdk/src/middleware.ts`:

```ts
import type { B4MessageContent } from "./content-parts.js"

export interface MiddlewareAfterMessage {
  readonly role: string
  /** What the client sent: text, or AG-UI 1.0 content parts. */
  readonly content: B4MessageContent
  readonly id?: string
}
```

`packages/cli/src/lib/dev/agui-handler.ts`:

- `toAfterMessage`'s parameter type: `readonly content: B4MessageContent` (import `type B4MessageContent, contentPartsText` from `@b4run/sdk`).
- `screenOversizedClientToolResults` measures `encoder.encode(messageText(message)).byteLength` where, added near the helpers:

```ts
/**
 * A message's text for the client-tool seams. PR 1 carries parts only to the
 * MODEL; a client-tool result with parts is stored and screened as its text
 * until sub-project 3's PR 2 widens the store contract (spec §6).
 */
function messageText(message: { readonly content: B4MessageContent }): string {
  return contentPartsText(message.content)
}
```

- Every place the handler hands a tool message's `content` to `resolveClientToolTurn` / the store as a `result: string` (search `message.content` in `agui-handler.ts` and `client-tool-turn.ts`): wrap with `contentPartsText(...)`. `client-tool-turn.ts` takes `messages: readonly B4Message[]`-shaped input; if it reads `.content` as a string, map the messages first: `messages: sized.messages.map((m) => ({ ...m, content: contentPartsText(m.content) }))` at the two `resolveClientToolTurn({ … messages … })` call sites, so `client-tool-turn.ts` itself stays string-typed in PR 1.
- The `streamRoute` input (`messages: [{ role: "user", content: newestUserMessage.content }]`) now passes parts through — no code change, but confirm `execute-route-core.ts`'s `input: unknown` accepts it (it does).

`packages/cli/src/lib/runtime/execute-route-core.ts`: in the `switch (chunk.type)` over adapter chunks (the one with `case "token"` … `default`), add before `default`:

```ts
          case "content_parts_dropped": {
            // The spec's lossy-downgrade warning: for the developer, on the
            // server, whichever front door the run came through. The chunk
            // also passes through, so the AG-UI adapter can announce it on the
            // stream as a CUSTOM event.
            console.warn(
              formatDroppedPartsWarning({
                ...(chunk.data as Omit<DroppedPartsReport, "routeId">),
                routeId,
              }),
            )
            yield { type: chunk.type, data: chunk.data }
            break
          }
```

Import `formatDroppedPartsWarning, type DroppedPartsReport` from `@b4run/langchain` (the package is already a dependency; `execute-route-core.ts` already imports `OffloadFn` from it). `routeId` is in scope in that function (used for `tool_call` naming nearby — confirm the local name).

- [ ] **Step 4: Build, typecheck, run**

Run: `pnpm build && pnpm typecheck && pnpm --filter @b4run/cli test -- test/agui-handler-parts.test.ts test/agui-run-envelope.test.ts test/agui-client-tools.test.ts`
Expected: typecheck PASS workspace-wide; tests PASS. (Use the actual client-tools test filename: `ls packages/cli/test | grep client-tool`.)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/middleware.ts packages/cli/src/lib/dev/agui-handler.ts packages/cli/src/lib/runtime/execute-route-core.ts packages/cli/test/agui-handler-parts.test.ts
git commit -m "feat(cli): content parts flow through the AG-UI handler; dropped parts are logged per run"
```

---

### Task 11: Agent Protocol — bounded bodies, array content

**Files:**
- Create: `packages/cli/src/lib/dev/request-limits.ts`
- Modify: `packages/cli/src/lib/dev/client-tool-runtime.ts`, `packages/cli/src/lib/dev/runtime-fetch-core.ts`
- Test: `packages/cli/test/ap-body-limit.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/ap-body-limit.test.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { AGUI_BODY_MAX_BYTES } from "../src/lib/dev/request-limits.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function setup() {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-ap-limit-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  await mkdir(join(appRoot, "src/app/echo"), { recursive: true })
  await writeFile(join(appRoot, "b4.config.ts"), "export default {}\n")
  await writeFile(join(appRoot, "package.json"), '{ "name": "x", "type": "module" }\n')
  await writeFile(
    join(appRoot, "src/app/echo/index.ts"),
    "export const graph = async (input) => ({ echoed: input.messages?.[0]?.content ?? null })\n",
  )
  const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
  cleanup.push(() => handler.close())
  return handler
}

async function createThread(handler: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const res = await handler.fetch(
    new Request("http://localhost/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  )
  return ((await res.json()) as { thread_id: string }).thread_id
}

describe("Agent Protocol run body", () => {
  it("is bounded like the AG-UI body: a declared over-cap length is 413 unread", async () => {
    const handler = await setup()
    const threadId = await createThread(handler)
    const res = await handler.fetch(
      new Request(`http://localhost/threads/${threadId}/runs/wait`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(AGUI_BODY_MAX_BYTES + 1) },
        body: JSON.stringify({ route: "/echo#graph", input: {} }),
      }),
    )
    expect(res.status).toBe(413)
  })

  it("carries array content to the route intact", async () => {
    const handler = await setup()
    const threadId = await createThread(handler)
    const parts = [
      { type: "text", text: "see" },
      { type: "image", source: { type: "url", value: "https://x.test/a.png" } },
    ]
    const res = await handler.fetch(
      new Request(`http://localhost/threads/${threadId}/runs/wait`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "/echo#graph", input: { messages: [{ role: "user", content: parts }] } }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { echoed?: unknown } | { output?: { echoed?: unknown } }
    expect(JSON.stringify(body)).toContain(JSON.stringify(parts))
  })
})
```

Adjust the `/threads` creation and `/runs/wait` response shape to what `packages/cli/test/ap-attach-endpoint.test.ts` does (it already creates threads and posts runs; copy its request helpers rather than guessing). The `content-length` header may be stripped by `Request`; if the first test cannot force a declared length, send a real over-cap body instead: `body: JSON.stringify({ route: "/echo#graph", input: { pad: "x".repeat(AGUI_BODY_MAX_BYTES) } })` — `readBoundedText` counts streamed bytes too.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/cli test -- test/ap-body-limit.test.ts`
Expected: FAIL — `request-limits.js` does not exist; the over-cap request is 200/400, not 413.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/lib/dev/request-limits.ts
/**
 * Body ceilings for the two run endpoints that carry conversation content.
 * Larger than the other JSON endpoints' 1 MiB because an AG-UI client resends
 * the thread's entire message history on every run, and because inline media
 * parts (`source.type: "data"`, base64) ride inside it: 8 MiB leaves room for
 * a long conversation and a few images while keeping one request from
 * buffering without bound. Shared by `POST /agui/:routeId` and the Agent
 * Protocol `POST /threads/:id/runs/*` family, which now accept the same
 * content shapes. There is deliberately no per-part cap (spec §2.5).
 */
export const AGUI_BODY_MAX_BYTES = 8 * 1024 * 1024
```

In `client-tool-runtime.ts`, replace the `AGUI_BODY_MAX_BYTES` declaration and its comment with `export { AGUI_BODY_MAX_BYTES } from "./request-limits.js"` (keeps existing imports working).

In `runtime-fetch-core.ts`, add a helper near the other shared utilities:

```ts
import { AGUI_BODY_MAX_BYTES } from "./request-limits.js"

/** An Agent Protocol run body, bounded like the AG-UI one; a 413 when over the ceiling. */
async function readRunBody(request: Request): Promise<{ readonly ok: true; readonly raw: string } | { readonly ok: false; readonly response: Response }> {
  try {
    return { ok: true, raw: await readBoundedText(request, AGUI_BODY_MAX_BYTES) }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return { ok: false, response: payloadTooLarge(error) }
    throw error
  }
}
```

(`readBoundedText` must be added to the existing `./bounded-body.js` import; `payloadTooLarge` and `RequestBodyTooLargeError` are already imported.) At each of the three run-body sites (`const rawBody = await request.text()` at roughly lines 2518, 2935 and 3893 — the `/runs/stream`, `/runs/wait` and resume handlers; confirm by reading each function's name), replace with:

```ts
  const read = await readRunBody(request)
  if (!read.ok) return read.response
  const rawBody = read.raw
```

- [ ] **Step 4: Run**

Run: `pnpm --filter @b4run/cli test -- test/ap-body-limit.test.ts test/ap-attach-endpoint.test.ts test/runtime-fetch-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/request-limits.ts packages/cli/src/lib/dev/client-tool-runtime.ts packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/ap-body-limit.test.ts
git commit -m "fix(cli): bound Agent Protocol run bodies at the AG-UI ceiling"
```

---

### Task 12: Testing package — fixtures key on text parts

**Files:**
- Modify: `packages/testing/src/record-fixtures.ts`, `packages/testing/src/matchers.ts`
- Test: `packages/testing/test/record-fixtures.test.ts` (extend or create), `packages/testing/test/matchers.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/testing/test/record-fixtures.test.ts` (create with `import { describe, expect, it } from "vitest"` and `import { recordingsToFixtures } from "../src/record-fixtures.js"` if absent):

```ts
describe("recordingsToFixtures with multimodal requests", () => {
  it("keys a recorded turn on the text of its parts", () => {
    const [fixture] = recordingsToFixtures([
      {
        request: {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "describe this" },
                { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
              ],
            },
          ],
        },
        response: { content: "a cat" },
      },
    ])
    expect(fixture?.match.userMessage).toBe("describe this")
  })

  it("skips a user message with no text and keys on the next one that has some", () => {
    const [fixture] = recordingsToFixtures([
      {
        request: {
          messages: [
            { role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] },
            { role: "user", content: "now this" },
          ],
        },
        response: { content: "ok" },
      },
    ])
    expect(fixture?.match.userMessage).toBe("now this")
  })
})
```

Add to `packages/testing/test/matchers.test.ts` a case for whichever matcher reads a tool message's content (`expectOffloaded`, around `resolveMessageContent`'s caller at line ~149):

```ts
  it("reads array content on a serialized ToolMessage as its text", () => {
    const run: AgentRunResult = {
      ...base,
      finalState: {
        messages: [
          {
            id: ["langchain_core", "messages", "ToolMessage"],
            kwargs: { name: "search", content: [{ type: "text", text: "offloaded to workspace/x.txt" }, { type: "image", data: "AAAA", mimeType: "image/png" }] },
          },
        ],
      },
    }
    expect(() => expectOffloaded(run, "search")).not.toThrow()
  })
```

(Match the real shape `expectOffloaded` inspects — read the function first and mirror an existing passing test's `finalState`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/testing test -- test/record-fixtures.test.ts test/matchers.test.ts`
Expected: FAIL — `userMessage` undefined; array content resolves to `undefined`.

- [ ] **Step 3: Implement**

`record-fixtures.ts`:

```ts
/** The text of a recorded message: a string as is; an array's `text` parts joined (the rule aimock's matcher uses). */
function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join("")
  return text.length > 0 ? text : undefined
}

function firstUserMessage(req: Recording["request"]): string | undefined {
  for (const m of req.messages ?? []) {
    if (m.role !== "user") continue
    const text = messageText(m.content)
    if (text !== undefined) return text
  }
  return undefined
}
```

`matchers.ts` `resolveMessageContent`: after each `typeof … === "string"` check, add the array case:

```ts
function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return undefined
  return value
    .map((part) =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("")
}

function resolveMessageContent(m: Record<string, unknown>): string | undefined {
  const kwContent = contentText((m as { kwargs?: { content?: unknown } }).kwargs?.content)
  if (kwContent !== undefined) return kwContent
  return contentText((m as { content?: unknown }).content)
}
```

- [ ] **Step 4: Run**

Run: `pnpm --filter @b4run/testing test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/record-fixtures.ts packages/testing/src/matchers.ts packages/testing/test/record-fixtures.test.ts packages/testing/test/matchers.test.ts
git commit -m "fix(testing): fixtures and matchers read the text of multimodal message content"
```

---

### Task 13: Docs, check-docs pin, changeset

**Files:**
- Modify: `apps/web/content/docs/ag-ui.mdx`, `apps/web/content/docs/api/ag-ui.mdx`, `apps/web/content/docs/tools.mdx`
- Modify: `scripts/check-docs.mjs`
- Create: `.changeset/agui-multimodal-input.md`
- Regenerate: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: `ag-ui.mdx`**

In the error table under "Envelope validation", delete the row `| \`422\` | \`multimodal_not_supported\` | … |`.

Replace the section `### Multimodal content is refused, not dropped` (heading and paragraph) with:

```mdx
### Multimodal content is carried, and what the model cannot take is announced

A 1.0 message's `content` may be a list of parts: `text`, and `image`, `audio`, `video` or `document` parts whose `source` is inline bytes (`data`, base64 with a `mimeType`), a URL (`url`), or a handle the model provider issued (`file`). B4.run carries them to the route's model as LangChain content blocks: inline bytes as bytes, a URL as a URL — B4.run never fetches it; the provider does — and a provider handle as that provider's file id, when the route runs on the provider that minted it. A `document` is a PDF: a part whose `mimeType` is not `application/pdf` is not guessed at.

What the model cannot use is **dropped, never refused**, as the protocol requires: the run continues with the parts that remain, and the drop is announced for the developer — once per run in the server log, and on the stream as a `CUSTOM` event named `b4.content_parts_dropped` whose `value` lists each dropped part's `index`, `type`, `source` and `reason` (`modality_unsupported`, `url_source_unsupported`, `file_source_unsupported`, `foreign_file_provider`, `document_not_pdf`, `tool_result_media_unsupported`). Which parts a route's model takes is read from the model's LangChain profile; the [capability document](#capabilities) advertises it as `multimodal.input`, so a client can hide an attach control the route would only drop. Inline parts count against the 8 MiB body ceiling; there is no per-part limit.

Tools can return parts too: a tool's result may be an array of the same parts (or `{ result: parts, state }`), and it travels as `TOOL_CALL_RESULT.content`. The model sees the media only when its profile admits media in tool messages; the UI sees every part regardless.

`role: "reasoning"` and `role: "activity"` history is dropped on the way in: it is the client's stored artefact of an earlier turn, not something the assistant said.
```

In `### Where the check runs`, no change is needed except confirming the paragraph no longer references content.

Under `### Inbound input` (the adapter API section), change the sentence about `fromRunAgentInput` to end: "…where you can inspect tools, state, and context. `B4Message.content` is a string or the ordered content parts the client sent; see [Multimodal content](#multimodal-content-is-carried-and-what-the-model-cannot-take-is-announced)."

If the `## Capabilities` section (from #883) lists sections, add a bullet: "`multimodal.input` — lands with sub-project 3's PR 2; until then the key is omitted (unknown)." Only if #883 has merged into this branch's base; otherwise skip.

- [ ] **Step 2: `api/ag-ui.mdx`**

Update the `B4Message` row in the exports table to: ``| `B4Message` | Describe a normalized inbound message; `content` is text or AG-UI content parts. |``. Add, near the `B4RunInput` contract fence, a plain `ts` block (no `api-contract` attribute, since the interface is not pinned today):

````mdx
```ts
export interface B4Message {
  readonly role: "user" | "assistant" | "system" | "developer" | "tool"
  /** Plain text, or the ordered content parts the client sent (AG-UI 1.0). */
  readonly content: string | readonly B4ContentPart[]
  readonly id?: string
  readonly toolCallId?: string
}
```

`B4ContentPart` is exported by `@b4run/sdk` and is structurally AG-UI's `ContentPart`.
````

Add `B4_CONTENT_PARTS_DROPPED_EVENT` to the exports table: ``| `B4_CONTENT_PARTS_DROPPED_EVENT` | The `CUSTOM` event name (`b4.content_parts_dropped`) that announces parts the model could not use. |``.

- [ ] **Step 3: `tools.mdx`**

Under `## Input and output rules`, add a paragraph:

```mdx
A tool may return media. Return an array of content parts — `{ type: "text", text }` and `{ type: "image" | "audio" | "video" | "document", source }`, where `source` is `{ type: "data", value, mimeType }` (base64), `{ type: "url", value }` or `{ type: "file", value, provider? }` — or `{ result: parts, state }` to update state alongside. The type is `B4ContentPart` from `@b4run/sdk`. Over AG-UI the parts travel as `TOOL_CALL_RESULT.content`; the model sees the media only when its profile admits media in tool messages, and the result's text is what tool-output offloading bounds. See [AG-UI](/docs/ag-ui#multimodal-content-is-carried-and-what-the-model-cannot-take-is-announced).
```

- [ ] **Step 4: `scripts/check-docs.mjs`**

Add to `forbiddenContent` (before the closing `]`):

```js
  {
    pattern: /multimodal_not_supported|[Mm]ultimodal content is refused/,
    message:
      "describes the retired multimodal refusal; media parts are carried and what the model cannot take is dropped and announced",
    shouldCheck: (filePath) => !/CHANGELOG\.md$/.test(filePath),
  },
```

Run: `node scripts/check-docs.mjs`
Expected: PASS. If it flags `packages/ag-ui/src/inbound.ts` or `run-envelope.ts`, the retired wording survived there — fix the source comment, not the pin.

- [ ] **Step 5: Changeset**

```md
---
"@b4run/sdk": patch
"@b4run/ag-ui": patch
"@b4run/langchain": patch
"@b4run/cli": patch
"@b4run/testing": patch
---

Carry AG-UI 1.0 content parts to the model. A user message's `image`, `audio`, `video` and `document` parts — inline, by URL, or as a provider file handle — reach the route's model as LangChain content blocks; what the model cannot take (read from its LangChain profile) is dropped and announced, once per run in the server log and on the stream as `CUSTOM` `b4.content_parts_dropped`, never refused: the `422 multimodal_not_supported` envelope rejection is gone. Tools may return `B4ContentPart[]` (new in `@b4run/sdk`), which travels as `TOOL_CALL_RESULT.content`. The Agent Protocol run endpoints now bound their bodies at the same 8 MiB as `/agui`.
```

- [ ] **Step 6: Regenerate lastmod, run the web checks**

```bash
git add apps/web/content scripts/check-docs.mjs .changeset/agui-multimodal-input.md
git commit -m "docs: multimodal content is carried and announced; tools may return content parts"
pnpm --dir apps/web seo:lastmod
pnpm --filter @b4run/web test
```

Expected: the lastmod generator rewrites only the `/docs/ag-ui`, `/docs/api/ag-ui` and `/docs/tools` entries; web tests PASS (including `api-reference-inventory.test.ts` and the lastmod coverage gate).

```bash
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate SEO lastmod for the multimodal docs"
```

---

### Task 14: Full validation

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: clean. Fix with `pnpm lint:fix` scoped by the package's own `lint` script if needed — never bare `biome check --write`.

- [ ] **Step 2: Build, typecheck, test**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: all green. Known places a failure would point at: `packages/cli/test/agui-client-tools*.test.ts` (string-typed client-tool results — PR 1 flattens them via `contentPartsText`), `test/security-dependencies` (no new runtime deps were added; `@b4run/sdk` was already a dependency of every package touched — confirm with `grep '"@b4run/sdk"' packages/{ag-ui,langchain,cli,testing}/package.json`; if `packages/ag-ui` lacked it and Task 5 added it, `pnpm install` must have updated the lockfile and the dependency-resolution test may need its pin regenerated per that test's own instructions).

- [ ] **Step 3: Release-integrity and docs gates that CI runs**

Run: `pnpm test:release-integrity && node scripts/check-docs.mjs && pnpm check:release-inventory`
Expected: PASS (no release scripts were touched, so no pin changes).

- [ ] **Step 4: Open the PR**

```bash
git push -u origin blove/agui-multimodal-spec
gh pr create --repo cacheplane/b4run --base main --title "feat: carry AG-UI content parts to the model; tools return parts (multimodal PR 1)" --body-file - <<'EOF'
Sub-project 3 of the AG-UI 1.0 cut-over, PR 1 of 3 — spec: docs/superpowers/specs/2026-10-02-ag-ui-multimodal-design.md. Closes nothing yet; #886 closes with PR 3.

- `@b4run/sdk`: `B4ContentPart` (structurally AG-UI's `ContentPart`), pinned to the protocol type in `packages/ag-ui`.
- `@b4run/langchain`: `resolveModalitySupport` (LangChain `model.profile` + per-provider fallback) and `toLangChainContent`; user parts reach the model as standard blocks; tools may return parts; every drop is recorded and announced (`content_parts_dropped`).
- `@b4run/ag-ui`: `B4Message.content` carries parts; `TOOL_CALL_RESULT.content` is `ContentPart[]` for a parts result; `CUSTOM b4.content_parts_dropped` passes the 1.0 client's enforcement with zero warnings.
- `@b4run/cli`: the `422 multimodal_not_supported` envelope refusal is removed (spec: a run MUST NOT fail over a part); drops are logged once per run; Agent Protocol run bodies are bounded at the AG-UI 8 MiB.
- `@b4run/testing`: fixtures and matchers read the text of array content.

PR 2 (after #883): the `multimodal` capability section and client-tool results with parts. PR 3: the research example UI.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Then bind the PR for CI monitoring per the session's PR tooling.

---

## Self-review notes

- Spec §3.2 "assistant/system/developer stay text" — enforced where? `coerceMessageContent` keeps parts for every role; the adapter only reads `role === "user"` messages, and the handler forwards only the newest user message, so non-user parts never reach a model. Documented in Task 5's comment; no extra gate needed.
- Spec §6 (client-tool parts) is PR 2; Task 10's `messageText` flattening is the explicit PR 1 stand-in and is labelled as such in code.
- Spec §4.3 (capability section) is PR 2; `resolveModalitySupport` (Task 3) is the function it will call.
- Spec §8 recorded gpt-5-mini fixtures: not in PR 1 — they need a live recording session; PR 3 adds them with the example. Unit tests use synthetic profiles throughout.
