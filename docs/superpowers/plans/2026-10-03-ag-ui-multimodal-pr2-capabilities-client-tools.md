# AG-UI Multimodal — PR 2 (Capability Section + Client-Tool Parts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Advertise what a route's model takes as `multimodal.input` on `GET /agui/:routeId`, derived from the same `resolveModalitySupport` that drops parts at run time; and carry a client tool's content-part results through the store and back to the model under the same rules as a server tool result.

**Architecture:** A new preflight `checkRouteModalitySupport` in `execute-route-core.ts` loads the route descriptor like its siblings, resolves the provider, and reads the model's LangChain profile **without constructing the model** (profiles are static per-class tables reachable through the prototype getter; most constructors throw without an API key). The capabilities handler maps the resulting `ModalitySupport` onto AG-UI's `multimodal` section. For client tools, `ClientToolCallStore.answer({ result })` widens to `B4MessageContent`; the three stores (memory, SQLite, Postgres) serialise a part array into the existing text column with a self-describing JSON envelope (a codec in `@b4run/sdk`, so they cannot drift; pre-existing rows are plain text and decode as text); the resume value widens so the parked stub's `{ result }` carries parts into `convertToolToLangChain`, which already applies the tool-position rules and announces drops.

**Tech Stack / conventions:** as PR 1's plan (`docs/superpowers/plans/2026-10-02-ag-ui-multimodal-pr1-runtime-core.md`, header): NodeNext ESM, `exactOptionalPropertyTypes`, vitest/`node:test`, Biome only on your files with `--config-path packages/config-biome/biome.json`, never repo-wide `lint:fix`. **Spec:** `docs/superpowers/specs/2026-10-02-ag-ui-multimodal-design.md` §4.3, §6 (amended for this plan: profile read without construction; the store codec). **Base:** PR 1 (#912) merged.

---

## File map

| File | Change |
|---|---|
| `packages/langchain/src/chat-model-factory.ts` | **Add** `readModelProfile({ provider, model, importer? })` — profile via the class's prototype getter, no construction |
| `packages/langchain/test/chat-model-factory-modality.test.ts` | Tests against the real `@langchain/openai` / `@langchain/anthropic` / `@langchain/google-genai` classes |
| `packages/cli/src/lib/runtime/execute-route-core.ts` | **Add** `checkRouteModalitySupport(routeModule)` beside `checkRouteReasoningSupport` |
| `packages/cli/src/lib/dev/agui-capabilities.ts` | `multimodal` section from it; omitted when it cannot be settled |
| `packages/cli/test/agui-capabilities.test.ts` | Section assertions per fixture route; derivation test vs `toLangChainContent` |
| `packages/langchain/src/content-parts.ts` | `formatDroppedPartsWarning` regains the `GET /agui/<assistant id>` pointer |
| `packages/langchain/test/content-parts.test.ts`, `packages/cli/test/agui-handler-parts.test.ts` | Pointer strings |
| `packages/sdk/src/client-tool-calls.ts` | `result: B4MessageContent \| null`, `answer({ result: B4MessageContent })`; **add** `encodeClientToolResult` / `decodeClientToolResult`; memory store stores the value as given |
| `packages/sqlite-storage/src/client-tool-calls/{types,store}.ts`, `packages/postgres-storage/src/client-tool-calls.ts` | Widen the mirrored types; encode on write, decode on read |
| `packages/core/src/capabilities/client-tools.ts` | `ClientToolResumeValue.clientToolResult: B4MessageContent`; `readClientToolResult` accepts parts |
| `packages/cli/src/lib/dev/client-tool-turn.ts` | Store the content as sent; resume with it; drop the PR 1 warning |
| `packages/cli/src/lib/dev/client-tool-abandon.ts` | A parts result closes as its text (+ warn) — the abandon write bypasses the converter |
| `packages/cli/src/lib/dev/agui-handler.ts` | 64 KiB screen measures the JSON with `data.value` blanked |
| Tests: `packages/sdk/test/client-tool-calls.test.ts`, `packages/sqlite-storage/test/client-tool-calls.test.ts`, `packages/postgres-storage/test/client-tool-calls.test.ts`, `packages/cli/test/client-tool-turn.test.ts`, `packages/cli/test/agui-client-tools.test.ts`, `packages/cli/test/client-tool-abandon.test.ts` | Round trips with parts |
| `apps/web/content/docs/ag-ui.mdx` | `multimodal` row in the Capabilities table; rewrite the two "not yet" sentences in Multimodal content; Limits/Storage/413 rows; fix the stale `reasoning.supported` row |
| `.changeset/agui-multimodal-capabilities.md`, `apps/web/app/seo/lastmod.generated.json` | patch; regen |

---

### Task 1: `readModelProfile` — a model's profile without constructing it

**Files:** `packages/langchain/src/chat-model-factory.ts`, `packages/langchain/src/index.ts`, `packages/langchain/test/chat-model-factory-modality.test.ts`

- [ ] **Step 1: Failing test** (append to the modality test file)

```ts
import { readModelProfile, resolveModalitySupport } from "../src/chat-model-factory.ts"

describe("readModelProfile", () => {
  it("reads gpt-5-mini's profile from the real @langchain/openai class without constructing it", async () => {
    delete process.env.OPENAI_API_KEY
    const profiled = await readModelProfile({ provider: "openai", model: "gpt-5-mini" })
    expect(profiled).toBeDefined()
    expect(resolveModalitySupport(profiled, "openai")).toEqual({
      image: { data: true, url: true },
      pdf: { data: true, url: false },
      audio: false,
      video: false,
      toolResult: { image: false, pdf: false },
      file: { image: false, pdf: true },
    })
  })

  it("reads an Anthropic profile without an API key (its constructor would throw)", async () => {
    delete process.env.ANTHROPIC_API_KEY
    const profiled = await readModelProfile({ provider: "anthropic", model: "claude-haiku-4-5" })
    expect(resolveModalitySupport(profiled, "anthropic").file).toEqual({ image: true, pdf: true })
  })

  it("an unknown model id or a provider without profiles yields the fallback", async () => {
    expect(resolveModalitySupport(await readModelProfile({ provider: "openai", model: "gpt-unknown" }), "openai").image).toEqual({ data: true, url: true })
    expect(resolveModalitySupport(await readModelProfile({ provider: "ollama", model: "llama3" }), "ollama").image).toEqual({ data: true, url: false })
  })

  it("returns undefined when the provider package is not installed", async () => {
    const importer = async () => { throw Object.assign(new Error("Cannot find package '@langchain/xai'"), { code: "ERR_MODULE_NOT_FOUND" }) }
    expect(await readModelProfile({ provider: "xai", model: "grok-4", importer })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run** `pnpm --filter @b4run/langchain test` → FAIL (not exported).

- [ ] **Step 3: Implement** (after `resolveModalitySupport`)

```ts
/**
 * A model's LangChain `profile` read off its class, without constructing it:
 * every provider package's `profile` getter is a static per-id table that
 * reads only `this.model`, and most constructors throw without a credential,
 * which a capability document must not depend on. `undefined` when the
 * provider package is not installed (the route could not run either) — the
 * caller advertises nothing rather than guessing. A class without a getter
 * (`ollama`, `mistral`) yields an empty profile, so the provider fallback
 * applies, exactly as at run time.
 */
export async function readModelProfile(options: {
  readonly provider: BuiltInModelProviderId
  readonly model: string
  readonly importer?: Importer
}): Promise<{ readonly model: string; readonly profile: unknown } | undefined> {
  const spec = providerSpecs[options.provider]
  const importer = options.importer ?? seededImporter ?? defaultModelImporter
  let moduleExports: Record<string, unknown>
  try {
    moduleExports = await importer(spec.packageName)
  } catch (error) {
    if (isMissingModuleError(error, spec.packageName)) return undefined
    throw error
  }
  const Constructor = moduleExports[spec.exportName]
  if (typeof Constructor !== "function") return undefined
  const getter = findProfileGetter(Constructor.prototype)
  const profile = getter ? getter.call({ model: options.model }) : {}
  return { model: options.model, profile }
}

function findProfileGetter(prototype: object | null): (() => unknown) | undefined {
  for (let current = prototype; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "profile")
    if (descriptor?.get) return descriptor.get
  }
  return undefined
}
```

Export `readModelProfile` from `index.ts`. Note `resolveModalitySupport` reads `.profile` by property access, so `{ model, profile }` is enough.

- [ ] **Step 4: Run** → PASS. If the getter in a provider package reads anything beyond `this.model` (verify by reading `node_modules/.pnpm/@langchain+openai@*/.../dist/chat_models/base.js` `get profile()`, anthropic `chat_models.js`, google-genai `chat_models.js`), pass those fields too and say so in the comment.

- [ ] **Step 5: Commit** `feat(langchain): readModelProfile — a model's LangChain profile without constructing it`

---

### Task 2: `checkRouteModalitySupport` preflight

**Files:** `packages/cli/src/lib/runtime/execute-route-core.ts` (beside `checkRouteReasoningSupport`, ~L951), test in `packages/cli/test/agui-capabilities.test.ts` (Task 3 covers it end to end; add a direct unit test only if the file has precedent for calling `check*` directly — `grep -n "checkRouteReasoningSupport" packages/cli/test/*.ts`).

- [ ] **Step 1: Implement**

```ts
export type RouteModalitySupport =
  | { readonly ok: true; readonly support: ModalitySupport }
  | { readonly ok: false; readonly message: string }

/**
 * What the route's root model takes as content parts — the same judgment the
 * run applies (`resolveModalitySupport`), read off the model's profile
 * without constructing it. `ok: false` for a non-agent route, a raw runnable,
 * an unresolvable provider, or a provider package that is not installed:
 * nothing is claimed in any of those cases.
 */
export async function checkRouteModalitySupport(routeModule: PreparedRouteModuleOptions): Promise<RouteModalitySupport> {
  const prepared = await getPreparedRouteModules(routeModule)   // same memoized load as the siblings
  const normalized = prepared.module
  if (normalized.kind !== "agent" || !isB4Agent(normalized.entry)) {
    return { ok: false, message: `Route "${routeModule.routeId}" is not an agent() descriptor route` }
  }
  const descriptor = normalized.entry
  let provider: ReturnType<typeof resolveProvider>
  try {
    provider = resolveProvider({ model: descriptor.model, ...(descriptor.provider !== undefined ? { provider: descriptor.provider } : {}) })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  const profiled = await readModelProfile({ provider, model: descriptor.model })
  if (!profiled) return { ok: false, message: `Provider package for "${provider}" is not installed` }
  return { ok: true, support: resolveModalitySupport(profiled, provider) }
}
```

Mirror exactly how `checkRouteReasoningSupport` obtains `prepared`/`normalized` (copy its first lines) and import `readModelProfile`, `resolveModalitySupport`, `type ModalitySupport` from `@b4run/langchain`.

- [ ] **Step 2:** `pnpm build && pnpm --filter @b4run/cli typecheck` green. Commit `feat(cli): checkRouteModalitySupport preflight`.

---

### Task 3: The `multimodal` capability section

**Files:** `packages/cli/src/lib/dev/agui-capabilities.ts`, `packages/cli/test/agui-capabilities.test.ts`

- [ ] **Step 1: Failing tests** (in the first describe block, which needs no API key)

```ts
it("advertises multimodal input from the model profile on an agent route", async () => {
  const handler = await createHandler()
  expect((await capabilities(handler, "/open#agent")).multimodal).toEqual({
    input: { image: true, audio: false, video: false, pdf: true, file: false },
    output: { image: false, audio: false },
  })
  // gemini-2.5-flash: image/audio/video/pdf all true in its profile
  expect((await capabilities(handler, "/gemini#agent")).multimodal?.input).toEqual({ image: true, audio: true, video: true, pdf: true, file: false })
})

it("omits multimodal for a raw runnable and a non-agent route", async () => {
  const handler = await createHandler()
  expect((await capabilities(handler, "/raw#agent")).multimodal).toBeUndefined()
  expect((await capabilities(handler, "/echo#graph")).multimodal).toBeUndefined()
})
```

Update the whole-document `toEqual` assertions that exist for `/open`, `/closed`, `/gemini` to include the section. In the derivation block ("agrees with what POST enforces"), add:

```ts
it.each(["/open#agent", "/gemini#agent"])("multimodal.input on %s equals what the run carries", async (routeKey) => {
  await withModel()
  const handler = await createHandler()
  const advertised = (await capabilities(handler, routeKey)).multimodal?.input
  const support = await checkRouteModalitySupport({ appRoot, routeFile: routeFileFor(routeKey), routeId: routeIdFor(routeKey), bootFallbacks })
  if (!support.ok) throw new Error(support.message)
  const carried = (type: "image" | "audio" | "video" | "document") =>
    toLangChainContent([{ type, source: { type: "data", value: "AAAA", mimeType: type === "document" ? "application/pdf" : `${type}/x` } }], support.support, undefined, "user").dropped.length === 0
  expect(advertised).toEqual({ image: carried("image"), audio: carried("audio"), video: carried("video"), pdf: carried("document"), file: false })
})
```

(Resolve `appRoot`/`routeFile`/`bootFallbacks` from the test's existing fixture helpers; `toLangChainContent` from `@b4run/langchain`.)

- [ ] **Step 2:** Run the file → FAIL (no `multimodal` key).

- [ ] **Step 3: Implement** in `agentCapabilities()`: inside the shared `try`, add `const modality = await checkRouteModalitySupport(routeModule)`; keep `multimodal` undefined on the unloadable-boot return. Then:

```ts
    ...(modality.ok
      ? {
          multimodal: {
            // `file` is AG-UI's "arbitrary uploads the four parts do not cover";
            // a provider file HANDLE is a source, not that flag.
            input: {
              image: modality.support.image.data,
              audio: modality.support.audio,
              video: modality.support.video,
              pdf: modality.support.pdf.data,
              file: false,
            },
            // 1.0 defines no image/audio output carrier.
            output: { image: false, audio: false },
          },
        }
      : {}),
```

Add a header-comment bullet in the file's "every claim is DERIVED" list: `multimodal.input` is `checkRouteModalitySupport`, the profile read `toLangChainContent` applies at run time; omitted for a raw runnable, a non-agent route, or a missing provider package. Keep the module `node:`-free (the preflight lives in `execute-route-core.ts`).

- [ ] **Step 4:** Run the file + `pnpm --filter @b4run/cli typecheck` → PASS. Commit `feat(cli): advertise multimodal.input from the route model's profile`.

---

### Task 4: The warning's capability pointer returns

**Files:** `packages/langchain/src/content-parts.ts`, `packages/langchain/test/content-parts.test.ts`, `packages/cli/test/agui-handler-parts.test.ts`

- [ ] `formatDroppedPartsWarning`: when `routeId` is present append ` GET /agui/${encodeURIComponent(routeId)} lists what this route accepts.` after the part list (the sentence PR 1 withdrew; `routeId` there is already the assistant id). Update the two formatter expectations and the two exact strings in the CLI handler test. Remove the "PR 2 reintroduces" comment. Tests green; commit `fix(langchain): the dropped-parts warning points at the capability document again`.

---

### Task 5: Client-tool result codec and store contract

**Files:** `packages/sdk/src/client-tool-calls.ts`, `packages/sdk/src/index.ts`, `packages/sdk/test/client-tool-calls.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { createMemoryClientToolCallStore, decodeClientToolResult, encodeClientToolResult } from "../src/client-tool-calls.ts"

const parts = [{ type: "text", text: "shot" }, { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } }] as const

describe("client tool result codec", () => {
  it("text round-trips as itself, parts as a self-describing envelope", () => {
    expect(encodeClientToolResult("plain")).toBe("plain")
    const encoded = encodeClientToolResult(parts)
    expect(JSON.parse(encoded)).toEqual({ $b4: "content-parts", parts })
    expect(decodeClientToolResult(encoded)).toEqual(parts)
    expect(decodeClientToolResult("plain")).toBe("plain")
  })
  it("a stored text that merely looks like the envelope but is not a valid part list stays text", () => {
    const text = JSON.stringify({ $b4: "content-parts", parts: [{ type: "blob" }] })
    expect(decodeClientToolResult(text)).toBe(text)
  })
  it("null stays null", () => { expect(decodeClientToolResult(null)).toBeNull() })
})

it("the memory store returns a parts result as parts", async () => {
  const store = createMemoryClientToolCallStore()
  await store.issue(record({ toolCallId: "c1" }))   // use the file's existing record helper
  const answer = await store.answer({ threadId: "t", toolCallId: "c1", result: parts, at: "2026-10-03T00:00:00.000Z" })
  expect(answer.outcome === "answered" && answer.record.result).toEqual(parts)
  expect((await store.get("t", "c1"))?.result).toEqual(parts)
})
```

- [ ] **Step 2: Implement**

```ts
import { type B4ContentPart, type B4MessageContent, isContentPartArray } from "./content-parts.js"

// ClientToolCallRecord
  /** The client's result, set together with `answeredAt`: text, or the parts it sent. */
  readonly result: B4MessageContent | null
// answer()
    readonly result: B4MessageContent

const CLIENT_TOOL_RESULT_ENVELOPE = "content-parts"

/**
 * How a store keeps a part-list result in its text column: a self-describing
 * JSON envelope. Text is stored as itself, so rows written before parts
 * existed need nothing. Decoding admits only an envelope whose `parts` is a
 * structurally valid list; anything else is the text it is.
 */
export function encodeClientToolResult(result: B4MessageContent): string {
  return typeof result === "string" ? result : JSON.stringify({ $b4: CLIENT_TOOL_RESULT_ENVELOPE, parts: result })
}

export function decodeClientToolResult(stored: string | null): B4MessageContent | null {
  if (stored === null || !stored.startsWith('{"$b4":')) return stored
  try {
    const value: unknown = JSON.parse(stored)
    if (typeof value === "object" && value !== null && (value as { $b4?: unknown }).$b4 === CLIENT_TOOL_RESULT_ENVELOPE) {
      const parts = (value as { parts?: unknown }).parts
      if (isContentPartArray(parts)) return parts as readonly B4ContentPart[]
    }
  } catch {}
  return stored
}
```

The memory store keeps the value as given (no encoding — it is not a text column). Export both functions and keep the `ClientToolCallRecord` doc in sync.

- [ ] **Step 3:** sdk tests green; `pnpm build` will now break sqlite/postgres typecheck — Task 6. Commit `feat(sdk): client tool results carry content parts; a text-column codec for stores`.

---

### Task 6: SQLite and Postgres stores

**Files:** `packages/sqlite-storage/src/client-tool-calls/{types,store}.ts`, `packages/postgres-storage/src/client-tool-calls.ts`, their tests.

- [ ] Widen the two mirrored type copies exactly as the SDK (keep the "member for member identical" comments true). On write (`issue` and `answer`): `encodeClientToolResult(record.result ?? …)` for a non-null result (`null` stays `NULL`). On read (row → record): `decodeClientToolResult(row.result)`. **No schema migration**: the column is `TEXT`; say so in a comment above the codec use, citing spec §3.2. Tests in each package: a parts answer round-trips through a real DB (`get`, `listForThread` show parts); a row inserted with raw text (simulate a pre-parts row by inserting via the store with a string) reads back as text; the Postgres DDL test is untouched (eleven columns, v1 SQL). Postgres tests need `B4_TEST_PGSTORAGE=1` + Docker — run them if Docker is available, else say so (CI's gated `postgres-storage-docker` lane runs them).
- [ ] Commit `feat(storage): client tool results round-trip content parts through SQLite and Postgres`.

---

### Task 7: Resume with parts; store as sent; abandon as text

**Files:** `packages/core/src/capabilities/client-tools.ts`, `packages/cli/src/lib/dev/client-tool-turn.ts`, `packages/cli/src/lib/dev/client-tool-abandon.ts`, `packages/cli/src/lib/dev/agui-handler.ts`, tests `packages/cli/test/client-tool-turn.test.ts`, `packages/cli/test/agui-client-tools.test.ts`, `packages/cli/test/client-tool-abandon.test.ts`

- [ ] **Step 1: Failing tests**
  - `client-tool-turn.test.ts`: replace "a media-only tool answer is stored as its text and the dropped media is announced" with "a tool answer with parts is stored as parts and resumes with them": the stored record's `result` equals the parts; the resolved turn's `resume[key]` is `{ clientToolResult: parts }`; no `console.warn`.
  - `agui-client-tools.test.ts`: a round trip where the client answers `[{ type: "text", text: "panel opened" }, png]` against aimock (gpt-5-mini: `toolResult` all-false): aimock's second request carries the tool message with text `panel opened` only; the SSE stream of the resumed run carries `b4.content_parts_dropped` with `tool_result_media_unsupported` for index 1 and a `TOOL_CALL_RESULT` whose content is the two parts (the UI copy from `additional_kwargs.b4_content_parts`).
  - 64 KiB screen tests (~`:738`/`:754`): add a case where a parts answer has a 100 KB `data.value` but 10 bytes of text → NOT 413 (bytes are the body's business); and a parts answer whose text alone exceeds 64 KiB → 413.
  - `client-tool-abandon.test.ts`: an answered parts result closes as its text and warns once.

- [ ] **Step 2: Implement**
  - `core/client-tools.ts`: `ClientToolResumeValue.clientToolResult: B4MessageContent`; `readClientToolResult` returns a string or a valid part list (`isContentPartArray`) else `undefined`. The stub's `{ result }` then carries parts into `unwrapToolResult` → `convertToolToLangChain` (tool position, drops announced, UI copy kept) — nothing else to do there; add a comment saying so.
  - `client-tool-turn.ts`: `store.answer({ …, result: message.content, at })`; delete the PR 1 warning block; `answeredResult` returns `row.result` when it is a string or a part list; the resume map carries it. `AbandonedClientToolCall.result` / `calls[].result` stay `string`: at the one place a stored result becomes an abandon close, use `contentPartsText(result)` and `console.warn` once when parts were present (`B4: client tool result for <id> closed as text; its N media part(s) are not replayed on this path.`), because `client-tool-abandon.ts` writes a `ToolMessage` straight into the `tools` node, bypassing the converter.
  - `agui-handler.ts` `screenOversizedClientToolResults`: measure `encoder.encode(resultTextForScreen(message.content)).byteLength` where `resultTextForScreen` is the content for a string, and for parts `JSON.stringify(parts.map(p => p.type === "text" ? p : { ...p, source: p.source.type === "data" ? { ...p.source, value: "" } : p.source }))`. Replace `messageText` with it (keep the name if you prefer; update its comment: inline bytes are bounded by the body, text/JSON by 64 KiB, spec §6).

- [ ] **Step 3:** `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/client-tool-turn.test.ts test/agui-client-tools.test.ts test/client-tool-abandon.test.ts test/agui-handler-parts.test.ts` green; `pnpm build && pnpm typecheck`. Commit `feat(cli): client tool results with content parts are stored, screened on their text, and replayed under the tool-result rules`.

---

### Task 8: Docs and changeset

- [ ] `ag-ui.mdx`: Capabilities table — add a `multimodal.input.*` row ("the route model's profile, as `toLangChainContent` applies it at run time; `file` is always `false`; omitted for a raw runnable, a non-agent route, or a provider package that is not installed") and `multimodal.output` ("always `false`: 1.0 defines no carrier"); fix the stale `reasoning.supported` row to match `STREAMED_REASONING`. Multimodal content section: replace "The capability document does not yet say which parts a route accepts…" and the "stored and replayed to the model as their text only" sentence with the new behaviour (parts stored and replayed under the tool-result rules; the abandon path closes as text). Limits: "Each tool result | at most 64 KiB of text/JSON; inline media bytes count against the 8 MiB body only". Storage: one sentence on the text-column envelope (pre-existing rows unaffected). 413 row wording. `check-docs` must pass; regenerate lastmod in its own commit.
- [ ] `.changeset/agui-multimodal-capabilities.md` (`@b4run/cli`, `@b4run/sdk`, `@b4run/langchain`, `@b4run/sqlite-storage`, `@b4run/postgres-storage`; patch): the `multimodal` section; client tool results carry parts (`ClientToolCallRecord.result` / `answer.result` widened; stores keep text rows as-is); the warning pointer.

### Task 9: Validation

- [ ] `pnpm lint`, `pnpm build`, `pnpm typecheck`, `pnpm test` (isolate flakes), `pnpm check:release-inventory`, `pnpm test:release-integrity`, `node scripts/check-docs.mjs`, `node scripts/check-changesets.mjs`, `pnpm --dir apps/web seo:lastmod:check`. Open the PR against `main` with the body modelled on #912's; it closes nothing (PR 3 closes #886).

## Self-review notes
- Spec §4.3 said "construct the model; omit on missing API key". The survey showed constructors throw without a key while the profile is static — the plan reads the profile off the class instead and omits only for a missing provider package; the spec is amended alongside this plan.
- Spec §6's "64 KiB on the JSON with data values blanked" is Task 7's screen.
- The abandon path's text-only close is the one place parts do not reach the converter; it is announced and documented rather than re-plumbed (the `tools`-node write predates this work).
