# AG-UI HTTP+protobuf binding and the reasoning/state sections — Implementation Plan (PR 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /agui/:routeId` answers the AG-UI HTTP+protobuf binding when the request's `Accept` admits `application/vnd.ag-ui.event+proto`, `GET /agui/:routeId` advertises `transport.httpBinary` plus the `reasoning` and `state` sections the current code already settles, and `@b4run/ag-ui/sse` exposes one negotiator for both bindings.

**Architecture:** `@b4run/ag-ui/sse` replaces `encodeAgUiSse(event, accept): string` with `encodeAgUiEvent(event, accept): Uint8Array` and `agUiContentType(accept): string`, both delegating to `@ag-ui/encoder`'s `EventEncoder` so the header and the frames share one rule. The CLI handler's three content-type sites read from it; the runtime's "is this body still streaming" predicate learns the second media type; the capabilities module adds the new claims. The live-turn attach path is untouched because it taps raw chunks before translation.

**Tech Stack:** TypeScript 6 / NodeNext ESM, vitest, `@ag-ui/encoder` 1.0.1 (`encodeBinary`, `getContentType`), `@ag-ui/proto` 1.0.1 (`decode`, test-only), `@ag-ui/client` 1.0.1 `HttpAgent` (conformance).

**Spec:** `docs/superpowers/specs/2026-10-01-ag-ui-transport-capabilities-design.md` §3.

**Branch:** `blove/agui-transport-capabilities`, based on `origin/blove/agui-capabilities` (PR #883). Open the PR against `blove/agui-capabilities`; retarget to `main` after #883 merges. Node 24 (`nvm use 24`), every command from the repo root, never bare `biome check --write`.

**Conventions that bite here:**
- `src/` imports siblings with `.js`; `test/` imports with `.ts` (packages/ag-ui tests use both; follow the file you edit).
- `exactOptionalPropertyTypes`: never `{ x: undefined }`.
- Block comments cannot contain the text `*/*` — it closes the comment. Write "a wildcard range" in comments; the literal is fine inside strings.
- Adding a devDependency changes `pnpm-lock.yaml`: run `pnpm install` (not `--frozen-lockfile`) once, commit the lockfile with the manifest.

---

## File map

| File | Change |
|---|---|
| `packages/ag-ui/src/sse.ts` | `encodeAgUiEvent` + `agUiContentType` replace `encodeAgUiSse`. |
| `packages/ag-ui/package.json` | devDependency `@ag-ui/proto: 1.0.1`. |
| `packages/ag-ui/test/sse.test.ts` | Negotiation + frame tests. |
| `packages/ag-ui/test/outbound.test.ts` | Rename follow-up (decode bytes). |
| `packages/ag-ui/test/conformance.test.ts` | Canned server negotiates; protobuf case through the real `HttpAgent`. |
| `packages/cli/src/lib/dev/runtime-fetch-core.ts` | `isEventStream` → `isStreamingBody`, both media types. |
| `packages/cli/test/request-stores.test.ts` | Predicate test follows. |
| `packages/cli/src/lib/build/targets/vercel-output.ts` | Comment names both media types. |
| `packages/cli/src/lib/dev/agui-handler.ts` | Three sites use the negotiated encoder/content type. |
| `packages/cli/package.json` | devDependency `@ag-ui/proto: 1.0.1`. |
| `packages/cli/test/agui-endpoint.test.ts` | Protobuf run against the real server. |
| `packages/cli/test/agui-client-tools.test.ts` | Partial response in protobuf. |
| `packages/cli/src/lib/dev/agui-capabilities.ts` | `httpBinary`, `reasoning`, `state`. |
| `packages/cli/test/agui-capabilities.test.ts` | Claims follow; protobuf `POST` agreement. |
| `packages/ag-ui/README.md`, `apps/web/content/docs/ag-ui.mdx`, `apps/web/content/docs/api.mdx`, `apps/web/content/docs/api/ag-ui.mdx` | Rename + negotiation rule + new claims. |
| `apps/web/app/components/docs/api-reference.ts`, `apps/web/app/components/docs/api-reference.test.ts`, `scripts/check-docs.mjs` | Contract-id pins: `./sse:encodeAgUiSse` → `./sse:encodeAgUiEvent` + `./sse:agUiContentType`. |
| `apps/web/app/seo/lastmod.generated.json` | Regenerated. |
| `.changeset/agui-protobuf-transport.md` | `patch` for `@b4run/ag-ui` + `@b4run/cli`, Breaking paragraph. |

---

### Task 1: `@b4run/ag-ui/sse` negotiates both bindings

**Files:**
- Modify: `packages/ag-ui/src/sse.ts`
- Modify: `packages/ag-ui/package.json` (devDependencies)
- Modify: `packages/ag-ui/test/sse.test.ts`
- Modify: `packages/ag-ui/test/outbound.test.ts:7,152-156`

- [ ] **Step 1: Add the test-only protobuf decoder**

In `packages/ag-ui/package.json` `devDependencies`, add (alphabetical, after `@ag-ui/client`):

```json
    "@ag-ui/proto": "1.0.1",
```

Run: `pnpm install`
Expected: completes; `git status` shows `pnpm-lock.yaml` modified (the `packages/ag-ui` importer gains `@ag-ui/proto`; no new package versions, 1.0.1 is already in the lockfile).

- [ ] **Step 2: Write the failing tests**

Replace `packages/ag-ui/test/sse.test.ts` with:

```ts
import { EventType } from "@ag-ui/core"
import { AGUI_MEDIA_TYPE } from "@ag-ui/encoder"
import { decode } from "@ag-ui/proto"
import { describe, expect, test } from "vitest"
import { agUiContentType, encodeAgUiEvent } from "../src/sse.js"

const EVENT = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as const

/** The one frame `bytes` holds: 4-byte big-endian length, then the event. */
function decodeFrame(bytes: Uint8Array) {
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false)
  expect(bytes.length, "frame is exactly its declared length").toBe(4 + length)
  return decode(bytes.subarray(4))
}

describe("the SSE binding", () => {
  test.each([
    ["no Accept", undefined],
    ["text/event-stream", "text/event-stream"],
    ["protobuf listed at q=0", "text/event-stream, application/vnd.ag-ui.event+proto;q=0"],
  ])("is selected by %s", (_label, accept) => {
    expect(agUiContentType(accept)).toBe("text/event-stream")
    const text = new TextDecoder().decode(encodeAgUiEvent(EVENT, accept))
    expect(text.startsWith("data: ")).toBe(true)
    expect(text.endsWith("\n\n")).toBe(true)
    expect(JSON.parse(text.slice("data: ".length))).toEqual(EVENT)
  })
})

describe("the HTTP+protobuf binding", () => {
  test.each([
    ["the protobuf media type", "application/vnd.ag-ui.event+proto"],
    ["both, protobuf first", "application/vnd.ag-ui.event+proto, text/event-stream"],
    ["a wildcard range", "*/*"],
    ["an application wildcard", "application/*"],
  ])("is selected by %s", (_label, accept) => {
    expect(agUiContentType(accept)).toBe(AGUI_MEDIA_TYPE)
    expect(decodeFrame(encodeAgUiEvent(EVENT, accept))).toEqual(EVENT)
  })

  test("the media type is the one the spec names", () => {
    expect(AGUI_MEDIA_TYPE).toBe("application/vnd.ag-ui.event+proto")
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/ag-ui exec vitest --run --config vitest.config.ts test/sse.test.ts`
Expected: FAIL — `encodeAgUiEvent`/`agUiContentType` are not exported from `../src/sse.js`.

- [ ] **Step 4: Replace the module**

Replace `packages/ag-ui/src/sse.ts` with:

```ts
import type { BaseEvent } from "@ag-ui/core"
import { EventEncoder } from "@ag-ui/encoder"

/**
 * The AG-UI HTTP bindings, selected by the request's `Accept` header.
 *
 * SSE (`data: <json>\n\n`) unless `accept` admits
 * `application/vnd.ag-ui.event+proto` with a positive quality — named
 * explicitly, or through an `application` or a wildcard range — in which case
 * each event is a 4-byte unsigned big-endian length followed by exactly that
 * many bytes of one protobuf-encoded event, frames abutting with no separator.
 * The rule is `@ag-ui/encoder`'s own, so the two functions always agree: a
 * producer sets the header from one and writes the frames from the other.
 */
function encoder(accept?: string): EventEncoder {
  return new EventEncoder(accept ? { accept } : {})
}

/** One AG-UI event as the bytes of the binding `accept` selects. */
export function encodeAgUiEvent(event: BaseEvent, accept?: string): Uint8Array {
  return encoder(accept).encodeBinary(event)
}

/** The `content-type` of the binding `accept` selects. */
export function agUiContentType(accept?: string): string {
  return encoder(accept).getContentType()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @b4run/ag-ui exec vitest --run --config vitest.config.ts test/sse.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Follow the rename in `outbound.test.ts`**

In `packages/ag-ui/test/outbound.test.ts`, change the import on line 7:

```ts
import { encodeAgUiEvent } from "../src/sse.js"
```

and replace the block at lines 151–156:

```ts
    // zod output spells optionals as T | undefined; the wire type does not.
    const dataLine = new TextDecoder()
      .decode(encodeAgUiEvent(result as BaseEvent))
      .split("\n")
      .find((line) => line.startsWith("data: "))
    if (dataLine === undefined) throw new Error("SSE frame is missing a data line")
    expect(JSON.parse(dataLine.slice("data: ".length))).toMatchObject({ content: expected })
```

- [ ] **Step 7: Make the conformance test's canned server compile (negotiate from the request)**

In `packages/ag-ui/test/conformance.test.ts`, change the import on line 9:

```ts
import { agUiContentType, encodeAgUiEvent } from "../src/sse.js"
```

and in `startCannedServer`, replace

```ts
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
```

with

```ts
      const accept = req.headers.accept
      res.writeHead(200, { "content-type": agUiContentType(accept), "cache-control": "no-cache" })
```

and replace

```ts
        res.write(encodeAgUiSse(run.mutate ? run.mutate(event) : event))
```

with

```ts
        res.write(encodeAgUiEvent(run.mutate ? run.mutate(event) : event, accept))
```

- [ ] **Step 8: Run the package's tests, lint and typecheck**

Run: `pnpm --filter @b4run/ag-ui test && pnpm --filter @b4run/ag-ui typecheck && pnpm lint`
Expected: all PASS. (`@ag-ui/client` 1.0.1's `HttpAgent` sends `Accept: text/event-stream`, so every existing conformance case still receives SSE.)

- [ ] **Step 9: Commit**

```bash
git add packages/ag-ui/src/sse.ts packages/ag-ui/package.json pnpm-lock.yaml packages/ag-ui/test/sse.test.ts packages/ag-ui/test/outbound.test.ts packages/ag-ui/test/conformance.test.ts
git commit -m "feat(ag-ui)!: encodeAgUiEvent and agUiContentType negotiate the AG-UI HTTP bindings

encodeAgUiSse(event, accept): string is replaced by encodeAgUiEvent(event,
accept): Uint8Array and agUiContentType(accept): string on the same ./sse
subpath. Both delegate to @ag-ui/encoder's EventEncoder, so the header and
the frames follow one rule: SSE unless Accept admits
application/vnd.ag-ui.event+proto with a positive quality, then 4-byte
big-endian length-prefixed protobuf frames.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The real 1.0 client reads B4.run's protobuf frames

**Files:**
- Modify: `packages/ag-ui/test/conformance.test.ts` (`newAgent`, `runThroughClient`, new case)

- [ ] **Step 1: Let the harness choose the binding**

`HttpAgent.requestInit` builds `headers: { ...this.headers, "Content-Type": "application/json", Accept: "text/event-stream" }` — its own `Accept` wins over constructor headers — so the binary binding needs a subclass that sets the header after `super`. In `packages/ag-ui/test/conformance.test.ts`, add the import `import { AGUI_MEDIA_TYPE } from "@ag-ui/encoder"` and replace `newAgent` and `runThroughClient`:

```ts
/**
 * `HttpAgent` names `text/event-stream` after spreading its constructor
 * headers, so asking for the binary binding means overriding `requestInit`.
 * Parsing needs no override: the client picks its parser from the response
 * content type.
 */
class BinaryHttpAgent extends HttpAgent {
  protected override requestInit(input: Parameters<HttpAgent["requestInit"]>[0]): RequestInit {
    const init = super.requestInit(input)
    return { ...init, headers: { ...(init.headers as Record<string, string>), Accept: AGUI_MEDIA_TYPE } }
  }
}

function newAgent(url: string, binding: "sse" | "protobuf" = "sse"): HttpAgent {
  const params = {
    url,
    threadId: "t1",
    initialMessages: [{ id: "1", role: "user", content: "research agents" }],
  }
  return binding === "protobuf" ? new BinaryHttpAgent(params) : new HttpAgent(params)
}

/**
 * Drive the REAL client pipeline — `runAgent`, not a bare `run()` — so
 * CompatibilityBoundary → enforceEvents → chunk expansion → verifyEvents all
 * run, under `withNoWarnings`.
 */
async function runThroughClient(
  url: string,
  parameters: Parameters<HttpAgent["runAgent"]>[0],
  binding: "sse" | "protobuf" = "sse",
) {
  return withNoWarnings(async () => {
    const agent = newAgent(url, binding)
    const events: BaseEvent[] = []
    // Only collect here: the client logs and swallows a throwing subscriber, so assertions belong after runAgent returns.
    const result = await agent.runAgent(parameters, {
      onEvent: ({ event }) => {
        events.push(event)
      },
    })
    return { agent, events, result }
  })
}
```

`requestInit` is `protected` on `HttpAgent` (`dist/index.d.ts:314`), so `Parameters<HttpAgent["requestInit"]>` may be rejected; if it is, type the parameter as `RunAgentInput` imported from `@ag-ui/core`.

- [ ] **Step 2: Write the failing test**

Append after the "a full turn passes 1.0 enforcement with nothing stripped" case:

```ts
it("the HTTP+protobuf binding passes 1.0 enforcement with the same events", async () => {
  const { url } = await startCannedServer([
    { stream: () => toAsync(CANNED) },
    { stream: () => toAsync(CANNED) },
  ])
  const sse = await runThroughClient(url, { runId: "r1" })
  const binary = await runThroughClient(url, { runId: "r2" }, "protobuf")

  // Same turn, two bindings: the client's protobuf parser yields what its SSE
  // parser yields. Ids and run ids differ by construction; the shapes do not.
  const strip = (events: BaseEvent[]) =>
    events.map(({ timestamp: _timestamp, rawEvent: _raw, ...event }) => ({
      ...event,
      ...("runId" in event ? { runId: "r" } : {}),
    }))
  expect(binary.events.length).toBe(sse.events.length)
  expect(strip(binary.events)).toEqual(strip(sse.events))
})
```

If `strip` leaves a differing field (compare the failure diff), normalize exactly that field the same way and leave a comment naming it; do not loosen to a `type`-only comparison.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @b4run/ag-ui exec vitest --run --config vitest.config.ts test/conformance.test.ts -t "protobuf"`
Expected: before Task 1's server change it would have failed on content type; now it must PASS on the first run, because the server and the client already negotiate. If it FAILS, the failure is real (the client stripped a field under protobuf that it keeps under SSE — `withNoWarnings` reports it); investigate the field rather than normalizing it away.

- [ ] **Step 4: Run the whole package**

Run: `pnpm --filter @b4run/ag-ui test && pnpm --filter @b4run/ag-ui typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/test/conformance.test.ts
git commit -m "test(ag-ui): the 1.0 client reads B4.run's protobuf frames as it reads SSE

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The in-flight predicate knows the second media type

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:257-271,1089`
- Modify: `packages/cli/test/request-stores.test.ts:7,244-254`
- Modify: `packages/cli/src/lib/build/targets/vercel-output.ts:22-27`

- [ ] **Step 1: Write the failing test**

In `packages/cli/test/request-stores.test.ts`, change the import on line 7:

```ts
import { createRuntimeFetchHandler, isStreamingBody } from "../src/lib/dev/runtime-fetch-core.js"
```

and replace the test at lines 244–254:

```ts
  it("treats both AG-UI HTTP bindings, with or without parameters, as a stream", () => {
    // A future `; charset=utf-8` on any SSE producer would otherwise silently
    // downgrade a live stream to "settled when fetch() resolves" — disposing
    // the pool mid-stream, the exact bug this seam exists to prevent. The
    // protobuf binding is a live stream for the same reason.
    expect(isStreamingBody("text/event-stream")).toBe(true)
    expect(isStreamingBody("text/event-stream; charset=utf-8")).toBe(true)
    expect(isStreamingBody("Text/Event-Stream ;charset=utf-8")).toBe(true)
    expect(isStreamingBody("application/vnd.ag-ui.event+proto")).toBe(true)
    expect(isStreamingBody("Application/VND.AG-UI.Event+Proto; v=1")).toBe(true)
    expect(isStreamingBody("application/json")).toBe(false)
    expect(isStreamingBody("application/octet-stream")).toBe(false)
    expect(isStreamingBody(null)).toBe(false)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/request-stores.test.ts -t "bindings"`
Expected: FAIL — `isStreamingBody` is not exported.

- [ ] **Step 3: Rename and extend the predicate**

In `packages/cli/src/lib/dev/runtime-fetch-core.ts`, replace lines 257–271 with:

```ts
/**
 * True for a body the runtime is still producing after `fetch` resolves: an
 * AG-UI event stream in either HTTP binding, `text/event-stream` or
 * `application/vnd.ag-ui.event+proto`, with or without parameters
 * (`; charset=utf-8`).
 *
 * Deliberately not an exact compare: this predicate decides whether the
 * response is still producing bytes after `fetch` resolves, and a producer that
 * one day appends a charset would otherwise silently downgrade a live stream to
 * "settled" — releasing sandboxes and disposing per-request stores mid-stream,
 * the exact failure the tracking exists to prevent. The protobuf media type is
 * spelled here rather than imported: `@b4run/ag-ui/sse`'s negotiator owns the
 * rule, and `agui-endpoint.test.ts` checks a protobuf run is held to its end.
 *
 * Exported for the tests: no route produces a parameterized content-type today,
 * so the guard is only reachable directly.
 */
export function isStreamingBody(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase()
  return mediaType === "text/event-stream" || mediaType === "application/vnd.ag-ui.event+proto"
}
```

Then update the one call site (line ~1089):

```ts
        if (body && isStreamingBody(response.headers.get("content-type"))) {
```

and its comment two lines below from "its SSE body is still streaming" to "its event-stream body is still streaming". Also update the shutdown-drain comment near line 1223: replace `(which only holds the slot for text/event-stream bodies)` with `(which only holds the slot for streaming event bodies)`.

Run: `grep -rn "isEventStream" packages/cli/src packages/cli/test`
Expected: no output.

- [ ] **Step 4: Name both media types in the Vercel comment**

In `packages/cli/src/lib/build/targets/vercel-output.ts`, replace lines 22–27 of the doc comment with:

```ts
 * `supportsResponseStreaming` is not optional for this function: the runtime
 * answers `/agui/:routeId` with `text/event-stream` or, when the client asks,
 * `application/vnd.ag-ui.event+proto`, and `/threads/:id/runs/stream` with
 * `text/event-stream`; without the flag Vercel's Node launcher buffers the
 * whole body, so a browser receives nothing until the run finishes rather than
 * tokens as they are produced. It is a fact about what the runtime serves, not
 * a deployment preference, so it is fixed here rather than configurable.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/request-stores.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/request-stores.test.ts packages/cli/src/lib/build/targets/vercel-output.ts
git commit -m "fix(cli): hold the in-flight slot for a protobuf AG-UI body as for SSE

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The handler serves the negotiated binding

**Files:**
- Modify: `packages/cli/src/lib/dev/agui-handler.ts:5,1126-1127,1248,1350-1358,1652-1677`
- Modify: `packages/cli/package.json` (devDependencies)
- Modify: `packages/cli/test/agui-endpoint.test.ts` (helpers + new case)
- Modify: `packages/cli/test/agui-client-tools.test.ts` (`aguiRequest`, `run`, new case)

- [ ] **Step 1: Add the test-only decoder to the CLI**

In `packages/cli/package.json` `devDependencies`, add (alphabetical; before `@b4run/config-typescript`):

```json
    "@ag-ui/proto": "1.0.1",
```

Run: `pnpm install`
Expected: lockfile's `packages/cli` importer gains `@ag-ui/proto`; nothing else changes.

- [ ] **Step 2: Write the failing endpoint test**

In `packages/cli/test/agui-endpoint.test.ts`, add the import (alphabetically among the package imports, before `@b4run/core`):

```ts
import { decode } from "@ag-ui/proto"
```

Add after `parseSseEvents` (line ~91):

```ts
/**
 * Every frame of the HTTP+protobuf binding: a 4-byte unsigned big-endian
 * length, then exactly that many bytes of one event, frames abutting with no
 * separator. The whole body is read first, so frames split across transport
 * chunks arrive here whole.
 */
function parseProtoFrames(bytes: Uint8Array): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  let offset = 0
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) throw new Error(`truncated length prefix at byte ${offset}`)
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false)
    offset += 4
    if (bytes.length - offset < length) throw new Error(`truncated frame at byte ${offset}`)
    events.push(decode(bytes.subarray(offset, offset + length)) as Record<string, unknown>)
    offset += length
  }
  return events
}

async function postProtoRun(
  port: number,
  body: Record<string, unknown>,
): Promise<{ events: Record<string, unknown>[]; response: Response }> {
  const response = await requestRun(port, body, { accept: "application/vnd.ag-ui.event+proto" })
  const bytes = new Uint8Array(await response.arrayBuffer())
  return { events: parseProtoFrames(bytes), response }
}
```

Add after the "streams the canonical AG-UI lifecycle and successful result" case (line ~345):

```ts
it("serves the HTTP+protobuf binding when Accept asks for it, with the same events", async () => {
  // aimock fixtures are matched, not consumed: one script serves both threads.
  const { port } = await setupServer(script().user("hello").replies("Hi there!").build())
  const sse = await postRun(port, {
    threadId: "th-sse",
    runId: "rn-sse",
    messages: [{ id: "1", role: "user", content: "hello" }],
  })
  const binary = await postProtoRun(port, {
    threadId: "th-proto",
    runId: "rn-proto",
    messages: [{ id: "1", role: "user", content: "hello" }],
  })

  expect(sse.response.headers.get("content-type")).toBe("text/event-stream")
  expect(binary.response.status).toBe(200)
  expect(binary.response.headers.get("content-type")).toBe("application/vnd.ag-ui.event+proto")
  expect(binary.response.headers.get("cache-control")).toBe("no-cache")
  expect(binary.events.map((event) => event.type)).toEqual(sse.events.map((event) => event.type))
  expect(binary.events[2]).toMatchObject({ delta: "Hi there!" })
  expect(binary.events.at(-1)).toMatchObject({
    outcome: { type: "success" },
    runId: "rn-proto",
    threadId: "th-proto",
  })
}, 60_000)

it("answers SSE to a client that does not admit protobuf, whatever else it lists", async () => {
  const { port } = await setupServer(script().user("hello").replies("Hi there!").build())
  const response = await requestRun(
    port,
    { threadId: "th2", runId: "rn2", messages: [{ id: "1", role: "user", content: "hello" }] },
    { accept: "text/event-stream, application/vnd.ag-ui.event+proto;q=0" },
  )
  expect(response.headers.get("content-type")).toBe("text/event-stream")
  expect(parseSseEvents(await response.text()).map((event) => event.type)).toContain("RUN_FINISHED")
}, 60_000)
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/agui-endpoint.test.ts -t "protobuf"`
Expected: FAIL — content type is `text/event-stream` and `parseProtoFrames` throws on `data: ` bytes (or the length prefix read from `data` is absurd).

- [ ] **Step 4: Change the handler's three sites**

In `packages/cli/src/lib/dev/agui-handler.ts`:

Line 5 import:

```ts
import { agUiContentType, encodeAgUiEvent } from "@b4run/ag-ui/sse"
```

Lines 1126–1127 — drop the per-request `TextEncoder`:

```ts
    const accept = request.headers.get("accept") ?? undefined
```

(delete `const encoder = new TextEncoder()`).

Line 1248:

```ts
              safeEnqueue(controller, encodeAgUiEvent(event, accept))
```

Lines 1350–1358 — the streaming response:

```ts
    return new Response(stream, {
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": agUiContentType(accept),
      },
      status: 200,
    })
```

Lines 1652–1677 — `clientToolPartialResponse`:

```ts
async function clientToolPartialResponse(
  threadId: string,
  runId: string,
  accept: string | null,
  pendingToolCallIds: readonly string[],
): Promise<Response> {
  async function* done(): AsyncGenerator<B4AgentStreamChunk> {
    yield { type: "done", data: null }
  }
  const frames: Uint8Array[] = []
  let length = 0
  for await (const event of toAguiEvents(
    done(),
    { threadId, runId },
    { pendingToolCallIds: () => pendingToolCallIds },
  )) {
    const frame = encodeAgUiEvent(event, accept ?? undefined)
    frames.push(frame)
    length += frame.length
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const frame of frames) {
    body.set(frame, offset)
    offset += frame.length
  }
  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": agUiContentType(accept ?? undefined),
    },
    status: 200,
  })
}
```

Run: `grep -n "text/event-stream\|TextEncoder\|encodeAgUiSse" packages/cli/src/lib/dev/agui-handler.ts`
Expected: no output.

- [ ] **Step 5: Run the endpoint tests to verify they pass**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/agui-endpoint.test.ts`
Expected: PASS, including every pre-existing case (they send `accept: text/event-stream`).

- [ ] **Step 6: Write the failing partial-response test**

In `packages/cli/test/agui-client-tools.test.ts`:

Add the import `import { decode } from "@ag-ui/proto"` (alphabetically first among package imports).

Extend `aguiRequest`'s options and headers:

```ts
function aguiRequest(
  threadId: string,
  runId: string,
  messages: readonly AguiMessage[],
  options: {
    tools?: readonly unknown[]
    route?: string
    resume?: readonly unknown[]
    accept?: string
  } = {},
): Request {
```

and in its `headers`:

```ts
      headers: {
        accept: options.accept ?? "text/event-stream",
        "content-type": "application/json",
      },
```

Replace the `run` helper's body-reading so it understands both bindings. Change

```ts
  const response = await handler.fetch(request)
  const text = await response.text()
  const isSse = response.headers.get("content-type")?.includes("text/event-stream") ?? false
  return {
    events: isSse ? parseSseEvents(text) : [],
```

to

```ts
  const response = await handler.fetch(request)
  const contentType = response.headers.get("content-type") ?? ""
  const bytes = contentType.startsWith("application/vnd.ag-ui.event+proto")
    ? new Uint8Array(await response.arrayBuffer())
    : undefined
  const text = bytes ? "" : await response.text()
  const isSse = contentType.includes("text/event-stream")
  return {
    events: bytes ? parseProtoFrames(bytes) : isSse ? parseSseEvents(text) : [],
```

and leave every other property of the returned object (`json`, `status`, `text`, …) exactly as it is, so the helper's type does not change.

Add `parseProtoFrames` next to `parseSseEvents` — the same function as in Task 4 Step 2 (copy it; the two test files do not share helpers).

Add a case after "a partial answer records what arrived and ends the run as success without touching the model" (the test at lines ~354–392; use its exact title from the file):

```ts
  it("answers a partial result in the HTTP+protobuf binding when the client asks", async () => {
    const t = await parkedRun([CALL_A, CALL_B])
    expect(t.first.status).toBe(200)

    const partial = await run(
      t.handler,
      aguiRequest(
        t.threadId,
        "run-2",
        [USER_HELLO, assistantCalls(["call_a", "call_b"]), toolResult("m3", "call_a", "A done")],
        { accept: "application/vnd.ag-ui.event+proto" },
      ),
    )
    expect(partial.status).toBe(200)
    expect(partial.events.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"])
    expect(finished(partial.events)?.outcome).toEqual({
      type: "success",
      pendingToolCallIds: ["call_b"],
    })
  })
```

- [ ] **Step 7: Run it**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/agui-client-tools.test.ts`
Expected: PASS (the handler change in Step 4 already serves it; this step proves the partial path, which has no stream, negotiates too).

- [ ] **Step 8: Typecheck, lint, and the AG-UI-adjacent CLI suites**

Run: `pnpm --filter @b4run/cli typecheck && pnpm lint && pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/agui-endpoint.test.ts test/agui-client-tools.test.ts test/agui-run-envelope.test.ts test/agui-response-schema.test.ts test/agui-model-framing.test.ts test/ap-attach-endpoint.test.ts test/client-tool-park-visibility.test.ts test/thread-access-agui-slot-ordering.test.ts`
Expected: PASS. `ap-attach-endpoint` and `client-tool-park-visibility` prove the live-turn attach path is unchanged.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/lib/dev/agui-handler.ts packages/cli/package.json pnpm-lock.yaml packages/cli/test/agui-endpoint.test.ts packages/cli/test/agui-client-tools.test.ts
git commit -m "feat(cli): serve the AG-UI HTTP+protobuf binding on POST /agui/:routeId

Accept decides: text/event-stream unless the header admits
application/vnd.ag-ui.event+proto, then 4-byte big-endian length-prefixed
protobuf frames. The streaming response and the client-tool partial
response read the content type and the frames from one negotiator. The
live-turn tap sits before translation, so attachers are untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Advertise `httpBinary`, `reasoning` and `state`

**Files:**
- Modify: `packages/cli/src/lib/dev/agui-capabilities.ts`
- Modify: `packages/cli/test/agui-capabilities.test.ts`

- [ ] **Step 1: Update the expectations (failing tests)**

In `packages/cli/test/agui-capabilities.test.ts`:

Add near the top, after the `MIDDLEWARE` constant:

```ts
/** Claims every route makes, whatever its module says. */
const TRANSPORT = { httpBinary: true, streaming: true }
const REASONING = { supported: false }
const AGENT_STATE = { deltas: false, persistentState: true, snapshots: false }
const ONE_SHOT_STATE = { deltas: false, persistentState: false, snapshots: false }
```

Then in every `toEqual` document, replace `transport: { streaming: true },` with:

```ts
      reasoning: REASONING,
      state: AGENT_STATE,
      transport: TRANSPORT,
```

for the `/open#agent` and `/raw#agent` cases, and

```ts
      reasoning: REASONING,
      state: ONE_SHOT_STATE,
      transport: TRANSPORT,
```

for the `/echo#graph` case. (`toEqual` ignores key order, but keep the keys alphabetical as the file does.)

Replace the final assertion of "claims nothing about an agent route on a boot that cannot load route modules":

```ts
    expect(response.status).toBe(200)
    // Neither new section reads the route module: reasoning is a fact about
    // the translator, persistentState about the registry's mode.
    expect(await response.json()).toEqual({
      reasoning: REASONING,
      state: AGENT_STATE,
      transport: TRANSPORT,
    })
```

Add to the `describe("GET /agui/:routeId", ...)` block:

```ts
  it("advertises the binary binding only because POST serves it", async () => {
    const handler = await createHandler(await fixtureApp())
    expect((await capabilities(handler, "/echo#graph")).transport).toEqual(TRANSPORT)
  })
```

Add to the `describe("GET /agui/:routeId agrees with what POST enforces", ...)` block, after `it.each(ROUTES)(...)`:

```ts
  it.each(ROUTES)("the binding on %s", async (routeKey) => {
    await withModel()
    const handler = await createHandler(await fixtureApp())
    expect((await capabilities(handler, routeKey)).transport?.httpBinary).toBe(true)

    const response = await handler.fetch(
      new Request(capabilitiesUrl(routeKey), {
        body: JSON.stringify({
          context: [],
          forwardedProps: {},
          messages: [{ content: "hello", id: "m1", role: "user" }],
          runId: "run-binding",
          state: {},
          threadId: `t-binding-${routeKey}`,
          tools: [],
        }),
        headers: {
          accept: "application/vnd.ag-ui.event+proto",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/vnd.ag-ui.event+proto")
    await response.body?.cancel()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/agui-capabilities.test.ts`
Expected: FAIL on every `toEqual` (missing `reasoning`/`state`, `httpBinary`); the "binding on" cases PASS on the `content-type` line already (Task 4) but FAIL on `httpBinary`.

- [ ] **Step 3: Add the claims**

In `packages/cli/src/lib/dev/agui-capabilities.ts`:

Extend the module doc comment's claim list. After the `transport.streaming` bullet, replace it and add:

```ts
 * - `transport.streaming` and `transport.httpBinary` are `true` for every
 *   route: the handler serves the SSE binding, and the HTTP+protobuf binding
 *   whenever the request's `Accept` admits it (`@b4run/ag-ui/sse` owns the
 *   rule; `agui-endpoint.test.ts` proves both). `websocket`, `resumable` and
 *   `pushNotifications` are omitted: nothing serves them, and nothing
 *   settles them as false either.
 * - `reasoning.supported` is `false` for every route: `toAguiEvents` has no
 *   `REASONING_*` branch, and the langchain adapter's `chunkText` keeps only
 *   `text` blocks, so nothing reasoning-shaped reaches the wire. The claim
 *   flips when the translator emits them (AG-UI sub-project 2).
 * - `state.snapshots` and `state.deltas` are `false` for every route: no
 *   code emits `STATE_SNAPSHOT` or `STATE_DELTA`. `state.persistentState` is
 *   `route.mode === "agent"`, the same checkpointer fact as `interrupts`: a
 *   chain, graph or workflow route is invoked once without one, so nothing
 *   of it persists between runs. `state.memory` is omitted: whether an app
 *   wires long-term memory is tool wiring this handler cannot see.
 * - `multiAgent` is omitted: subagent tooling is app-wired, not
 *   route-declared, and no `SUBAGENT_*` event exists yet (sub-project 2).
```

Replace the `TRANSPORT` constant:

```ts
/** What the handler serves, for every route: SSE, and protobuf when asked. */
const TRANSPORT: NonNullable<AgentCapabilities["transport"]> = {
  httpBinary: true,
  streaming: true,
}

/** Nothing reasoning-shaped reaches the wire from any route (module comment). */
const REASONING: NonNullable<AgentCapabilities["reasoning"]> = { supported: false }

/** No route emits state events; persistence is the checkpointer fact. */
function stateCapabilities(mode: string): NonNullable<AgentCapabilities["state"]> {
  return { deltas: false, persistentState: mode === "agent", snapshots: false }
}
```

In `handleAgUiCapabilitiesRequest`, the non-agent document becomes:

```ts
        {
          humanInTheLoop: {
            approvals: false,
            approveWithEdits: false,
            interrupts: false,
            supported: false,
          },
          output: { structuredOutput: false },
          reasoning: REASONING,
          state: stateCapabilities(route.mode),
          tools: { clientProvided: false, supported: false },
          transport: TRANSPORT,
        }
```

In `agentCapabilities`, the unloadable-boot early return becomes:

```ts
    // Without them, and without a static manifest seeding the module cache,
    // this runtime cannot read route modules here at all: nothing the module
    // settles is claimed — only what is true of every route and of its mode.
    return { reasoning: REASONING, state: stateCapabilities(route.mode), transport: TRANSPORT }
```

and the final document gains, in alphabetical position:

```ts
    output: { structuredOutput },
    reasoning: REASONING,
    state: stateCapabilities(route.mode),
    tools: {
```

Check the `route` parameter's type exposes `mode` (it is `RuntimeRegistry["entries"][number]`; the test's fake `lookup` returns `mode: "agent"`). If `mode` is a union, type `stateCapabilities`'s parameter as that union instead of `string`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/agui-capabilities.test.ts && pnpm --filter @b4run/cli typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/agui-capabilities.ts packages/cli/test/agui-capabilities.test.ts
git commit -m "feat(cli): advertise transport.httpBinary and the reasoning and state sections

httpBinary is true in the commit that serves it. reasoning.supported is
false (no REASONING_* reaches the wire) and state reports no snapshots or
deltas with persistentState from the route's mode. multiAgent, state.memory
and the other transport flags stay omitted: nothing settles them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Docs, contract pins, changeset

**Files:**
- Modify: `packages/ag-ui/README.md:21-30`
- Modify: `apps/web/content/docs/ag-ui.mdx:9-15,314-334,361-367`
- Modify: `apps/web/content/docs/api.mdx:331-333`
- Modify: `apps/web/content/docs/api/ag-ui.mdx:72-76,212-214,234-240`
- Modify: `apps/web/app/components/docs/api-reference.ts:996`
- Modify: `apps/web/app/components/docs/api-reference.test.ts:250`
- Modify: `scripts/check-docs.mjs:1208`
- Create: `.changeset/agui-protobuf-transport.md`
- Regenerate: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: README**

In `packages/ag-ui/README.md`, replace the example block (lines 21–30) with:

```md
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
```

(Write the fence as a normal ```` ```ts ```` block in the file — the outer fence above is only for this plan.)

- [ ] **Step 2: `ag-ui.mdx`**

In `apps/web/content/docs/ag-ui.mdx`:

After line 15 (the paragraph ending "streams translated events back as SSE."), change "as SSE." to "as SSE, or as the HTTP+protobuf binding when `accept` admits `application/vnd.ag-ui.event+proto` (see [Transport](#transport))."

Add a new section immediately before `## Envelope validation`:

```mdx
## Transport

`accept` selects the AG-UI HTTP binding, by AG-UI's own rule: `text/event-stream` unless the header admits `application/vnd.ag-ui.event+proto` with a positive quality — named, or through a wildcard range such as `*/*` — in which case the response is `content-type: application/vnd.ag-ui.event+proto` and each event is a 4-byte unsigned big-endian length followed by exactly that many bytes of one protobuf-encoded event, with no separator between frames. A client that cannot read protobuf must name `text/event-stream`; `@ag-ui/client` and CopilotKit do, and so does `b4 threads`. A bare `curl` sends `*/*` and receives protobuf: pass `-H 'accept: text/event-stream'` to read the stream by eye.

Both bindings carry the same events, and a thread's attach stream (`/threads/{id}/runs/{runId}/stream`) is unaffected by which one the primary client chose. WebSocket is not served.
```

In the Capabilities table (lines ~318–326), replace the `transport.streaming` row with these rows:

```mdx
| `transport.streaming`, `transport.httpBinary` | always `true`: the handler serves SSE, and protobuf when `accept` asks (see [Transport](#transport)) |
| `reasoning.supported` | always `false` for now: nothing reasoning-shaped reaches the wire; flips when `REASONING_*` events ship |
| `state.snapshots`, `state.deltas` | always `false`: no `STATE_SNAPSHOT` or `STATE_DELTA` is emitted |
| `state.persistentState` | the route is an agent route, the only kind run under a checkpointer |
```

In the paragraph after the table, replace "answers only `transport` for an agent route" with "answers only `transport`, `reasoning` and `state` for an agent route — the claims that do not read the module". Append one sentence to that paragraph: "`multiAgent`, `state.memory`, `transport.websocket`, `transport.resumable` and `transport.pushNotifications` are omitted: nothing in the runtime settles them."

In the "Consuming it from a web UI" section's closing code block (lines ~361–367), replace:

```ts
import { encodeAgUiSse } from "@b4run/ag-ui/sse"
```
```ts
response.write(encodeAgUiSse(event, request.headers.accept))
```

with

```ts
import { agUiContentType, encodeAgUiEvent } from "@b4run/ag-ui/sse"
```
```ts
response.writeHead(200, { "content-type": agUiContentType(request.headers.accept) })
```
```ts
response.write(encodeAgUiEvent(event, request.headers.accept))
```

(read the surrounding block first and keep its structure; the `writeHead` line goes before the loop).

- [ ] **Step 3: `api.mdx` and `api/ag-ui.mdx`**

`apps/web/content/docs/api.mdx` lines 331–333:

```mdx
### SSE subpath: `encodeAgUiEvent(event, accept?)` and `agUiContentType(accept?)`

See the canonical [SSE subpath inventory](/docs/api/ag-ui#b4runag-uisse).
```

`apps/web/content/docs/api/ag-ui.mdx` lines 72–76 (the `./sse` table):

```mdx
| Export | Responsibility |
|---|---|
| `encodeAgUiEvent` | Encode one AG-UI event as the bytes of the binding `accept` selects: an SSE frame, or a length-prefixed protobuf frame. |
| `agUiContentType` | The `content-type` of the binding `accept` selects. |
```

Lines 212–214 (the contract block) become two blocks:

```mdx
```ts api-contract="@b4run/ag-ui#./sse:encodeAgUiEvent"
export declare function encodeAgUiEvent(event: BaseEvent, accept?: string): Uint8Array
```

```ts api-contract="@b4run/ag-ui#./sse:agUiContentType"
export declare function agUiContentType(accept?: string): string
```
```

Lines 234–240 (the example that `yield`s `encodeAgUiSse(event)`): change the import to `import { encodeAgUiEvent } from "@b4run/ag-ui/sse"` and the yield to `yield encodeAgUiEvent(event)`; if the example constructs a `Response` from the generator, keep it (a `Uint8Array` stream is a valid body).

- [ ] **Step 4: Contract-id pins**

In each of `apps/web/app/components/docs/api-reference.ts:996`, `apps/web/app/components/docs/api-reference.test.ts:250`, and `scripts/check-docs.mjs:1208`, replace the line

```
  "@b4run/ag-ui#./sse:encodeAgUiSse",
```

with

```
  "@b4run/ag-ui#./sse:agUiContentType",
  "@b4run/ag-ui#./sse:encodeAgUiEvent",
```

(two lines, in that order — the lists are sorted within a subpath; check the neighbours and match).

Run: `grep -rn "encodeAgUiSse" --exclude-dir=node_modules --exclude-dir=dist --exclude=CHANGELOG.md . | grep -v "docs/superpowers"`
Expected: no output.

- [ ] **Step 5: Changeset**

Create `.changeset/agui-protobuf-transport.md`:

```md
---
"@b4run/ag-ui": patch
"@b4run/cli": patch
---

Serve the AG-UI HTTP+protobuf binding. `POST /agui/:routeId` answers `application/vnd.ag-ui.event+proto` — 4-byte big-endian length-prefixed protobuf frames — whenever the request's `Accept` admits it with a positive quality (named, or through a wildcard such as `*/*`), and `text/event-stream` otherwise; `@ag-ui/client` and CopilotKit name SSE and are unaffected. `GET /agui/:routeId` advertises `transport.httpBinary`, `reasoning: { supported: false }` and `state: { snapshots: false, deltas: false, persistentState }`.

**Breaking:** `@b4run/ag-ui/sse` no longer exports `encodeAgUiSse(event, accept): string`. Use `encodeAgUiEvent(event, accept): Uint8Array` for the frames and `agUiContentType(accept): string` for the header; both follow one negotiation rule. `response.write(encodeAgUiEvent(event, accept))` is a drop-in in Node.
```

- [ ] **Step 6: Build, docs checks, lastmod**

Run: `pnpm build && node scripts/check-docs.mjs && pnpm --dir apps/web exec vitest --run app/components/docs`
Expected: PASS. (The api-contract blocks are checked against the built `dist/*.d.ts`, hence the build first.)

Then commit the content, regenerate, and amend:

```bash
git add packages/ag-ui/README.md apps/web/content/docs/ag-ui.mdx apps/web/content/docs/api.mdx apps/web/content/docs/api/ag-ui.mdx apps/web/app/components/docs/api-reference.ts apps/web/app/components/docs/api-reference.test.ts scripts/check-docs.mjs .changeset/agui-protobuf-transport.md
git commit -m "docs(ag-ui): the HTTP+protobuf binding, the renamed sse exports, and the new capability claims

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod
git add apps/web/app/seo/lastmod.generated.json
git commit --amend --no-edit
```

Run: `pnpm --dir apps/web seo:lastmod:check`
Expected: PASS.

---

### Task 7: Full verification and the PR

- [ ] **Step 1: The source-validate sequence**

Run: `pnpm lint && pnpm check:build-cache && pnpm build && pnpm typecheck && pnpm test && pnpm check:release-inventory && node scripts/check-docs.mjs`
Expected: every gate PASS. Watch especially `packages/cli/test/edge-bundle-purity.test.ts`, `fetch-entry-purity.test.ts` and `api-reference-compatibility.test.ts` (the `./sse` entry's import graph is unchanged, so they must pass without edits).

- [ ] **Step 2: Pack check and changeset check**

Run: `pnpm pack:check && node scripts/check-changesets.mjs`
Expected: PASS.

- [ ] **Step 3: Push and open the PR against #883's branch**

```bash
git push -u origin blove/agui-transport-capabilities
gh pr create --repo cacheplane/b4run --base blove/agui-capabilities --title "feat(ag-ui)!: serve the AG-UI HTTP+protobuf binding and advertise httpBinary, reasoning and state" --body-file - <<'EOF'
Closes #887 (sub-project 4). Stacked on #883; retarget to `main` after it merges.

Spec: `docs/superpowers/specs/2026-10-01-ag-ui-transport-capabilities-design.md` §3.

- `@b4run/ag-ui/sse`: **breaking** — `encodeAgUiSse` → `encodeAgUiEvent(event, accept): Uint8Array` + `agUiContentType(accept)`, both on `@ag-ui/encoder`'s negotiator (SSE unless `Accept` admits `application/vnd.ag-ui.event+proto`; `*/*` admits it, per the spec).
- `POST /agui/:routeId` serves the binding; the client-tool partial response too. Live-turn attach is untouched (tap precedes translation).
- `isEventStream` → `isStreamingBody`: a protobuf body holds the in-flight slot like SSE (sandboxes and per-request stores would otherwise be released mid-run).
- `GET /agui/:routeId`: `transport.httpBinary: true`, `reasoning: { supported: false }`, `state: { snapshots: false, deltas: false, persistentState: mode === "agent" }`. `multiAgent`, `state.memory`, websocket stay omitted (UNKNOWN) until sub-project 2.
- Tests: encoder negotiation, real `HttpAgent` conformance under protobuf, a protobuf run and partial response through the real server, capabilities vs `POST` content type.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 4: Bind the PR and read CI**

Use the `ccd_pr` tools: `get_status`, then `bind_pr` if it does not report this PR. Report the lanes' results; do not poll.

---

## Self-review against the spec

- §3.1 (two functions, rename, Breaking changeset, edge-safety unchanged) → Tasks 1, 6, 7.
- §3.2 (three handler sites; partial response; attach untouched) → Task 4 (Step 8 runs the attach suites).
- §3.3 (`isStreamingBody`, Vercel comment) → Task 3.
- §3.4 (`httpBinary`, `reasoning`, `state`, omissions documented, unloadable boot) → Task 5.
- §3.5 tests 1–5 → Task 1 (sse, outbound), Task 2 (conformance), Task 4 (endpoint, client-tools), Task 5 (capabilities), Task 3 (predicate; lives in `request-stores.test.ts` where the predicate's test already is).
- §3.6 docs, lastmod, changeset → Task 6.
- §6 verification → Task 7.
