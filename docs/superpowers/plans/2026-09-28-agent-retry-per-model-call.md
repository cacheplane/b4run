# Agent Retry Per Model Call Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agent({ retry: { maxAttempts, baseDelay } })` do what it says, per model call:

1. `maxAttempts` becomes the chat model's `maxRetries` (`maxAttempts - 1`, default 3 → 2) for every built-in provider, so LangChain's own request retry obeys the knob and `maxAttempts: 1` fails fast.
2. A thin B4 layer in the agent middleware's `wrapModelCall` sends one model call again after a retryable capacity 429 (`RateLimitCapacityError`), with `min(baseDelay * 2^n + jitter, 10s)` or the error's `retryAfterMs` capped at 10s, within `maxAttempts`. This is the only place `baseDelay` applies.
3. The run-level retry in `processEventStream` is removed: a run is never restarted.
4. Docs, `RetryConfig` JSDoc, the homepage checklist tile and a patch changeset say exactly this.

**Architecture:**

- **One new module, `packages/langchain/src/model-call-retry.ts`.** Pure functions: `resolveModelRetryPolicy` (defaults and validation), `providerMaxRetries`, `isCapacityRateLimitError` (LangChain's stamps, never message text), `capacityRetryDelay`, and `retryCapacityErrors(call, policy, { signal, clock })`. The clock (`sleep`, `random`) is injectable for the unit tests; production uses `systemRetryClock` (an abortable `setTimeout`).
- **Construction.** `materializeAgent` (`agent-adapter.ts`) resolves the policy once, passes `maxRetries: providerMaxRetries(policy)` to `createChatModel` (new optional `maxRetries` option, set on the constructor options only when given, so the summarization and `b4 memory` models keep LangChain's default), and passes the policy to `createB4AgentMiddleware`.
- **The capacity layer.** `B4ModelAndTools.wrapModelCall` wraps `handler(next)` in `retryCapacityErrors`, with `request.runtime.signal`. It re-runs only the model call; tools and earlier model calls never re-run. The fast path that returned `handler(request)` untouched now goes through the same wrapper.
- **No run-level retry.** `processEventStream` loses its attempt loop and the `isRetryableError` text match. The `withRetry` fallback for a runnable with no `streamEvents` is unchanged (it never applies to an `agent()` route: a `createAgent` graph always has `streamEvents`).

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), `langchain` 1.5.12 `createAgent` middleware, `@langchain/core` 1.2.12 (`AsyncCaller`, `getRetryable` from `@langchain/core/errors`), `@langchain/openai` 1.5.13, Vitest 4 (fake timers for `setTimeout`, `clearTimeout` and `Date`), Biome, Next.js docs site (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-09-28-agent-retry-per-model-call-design.md`.

**Branch:** `blove/retry-streaming-backoff` (origin/main at `980ba8a37` plus the spec commit `63e95ab73`).

**How this plan was checked:** every code block below was written into the worktree on this branch and run before the plan was committed, then removed. New files are reproduced verbatim; changes to existing files are the exact `git diff` of the verified tree against `63e95ab73`, applied with `git apply`. These all passed on Node 24:

- `pnpm build`
- `pnpm --filter @b4run/langchain test`: 48 files, 336 tests
- `pnpm --filter @b4run/sdk test`: 14 files, 115 tests
- `pnpm --filter @b4run/cli test`: 186 files, 2309 passed, 4 skipped. One run had `vercel-target.test.ts` time out waiting 180s for a testcontainers port while every other suite ran in parallel; alone it passed (133 tests). It never reaches the retry code.
- `pnpm lint`, `pnpm typecheck`
- `pnpm --dir apps/web test`: 64 files, 979 passed, 1 skipped
- `node scripts/check-docs.mjs`, `pnpm check:build-cache`, `BASE_REF=HEAD~1 node scripts/check-changesets.mjs`
- `pnpm verify:harness:runtime` with `OPENAI_API_KEY` unset: passed (aimock, no network)
- the lastmod regeneration in Task 7, from a temporary commit of all the content

Nine mutation checks each turned tests red (see "Mutation checks" at the end): dropping the `maxRetries` mapping in `materializeAgent`, dropping it in `createChatModel`, dropping the capacity layer, retrying every error instead of capacity 429s, removing the 10s cap, ignoring `retryAfterMs`, not passing the abort signal to the wait, a fixed 1000ms base instead of `baseDelay`, and reintroducing the run-level retry.

## Risks and decisions

Items marked **Decision** need Brian.

1. **Decision: raw runnables lose the run-level retry too.** The spec says non-agent runnables keep their behaviour. The only runnables that reached the run-level retry are agent routes that export their own LangChain runnable instead of `agent()` (the "legacy path" in `streamAgent`): the CLI never passes `AgentOptions.retry`, so they got a hard-coded 3-attempt run restart, text-matched with `isRetryableError`, on top of their own model's LangChain retries. `graph`/`chain`/`workflow` routes never went through `streamFromRunnable`. This plan removes the restart for them as well, because it is the same `processEventStream` and the same double-retry and re-run-tools problem, and their model's own `maxRetries` (LangChain default 6) still applies. The one `withRetry` path left is the invoke fallback for a runnable without `streamEvents`. Alternative: keep an opt-in restart for the legacy path only (a flag on `streamFromRunnable`), which keeps a text-matched retry alive.
2. **Decision: an invalid `retry` now throws.** `maxAttempts` that isn't a whole number ≥ 1, or a `baseDelay` that isn't a finite number ≥ 0, throws from `resolveModelRetryPolicy` when the route is first materialized (first request), before any model is built. Before, `maxAttempts: 0` ran the stream loop zero times and returned `done` with `undefined` output, and a negative `maxRetries` would make p-retry throw a `TypeError` at call time. B4Config has no runtime schema, so this is the only guard. Alternative: clamp silently.
3. **Decision: "share the same budget" is per layer.** B4's capacity layer calls the model at most `maxAttempts` times; each of those calls goes through LangChain's `AsyncCaller` with `maxRetries = maxAttempts - 1`. A capacity 429 is thrown by LangChain on the first occurrence without retrying, so a call that keeps hitting capacity limits makes exactly `maxAttempts` requests. A call that alternates 503s and capacity 429s can make more (worst case `maxAttempts²`). A strict shared budget would need a per-call `maxRetries` (`request.modelSettings.maxRetries`, which LangChain's own `modelRetryMiddleware` uses), but only `@langchain/openai` and `@langchain/anthropic` read a per-call `maxRetries`; groq, google, mistral, xai-responses, openrouter and ollama ignore it. The docs say "both read `maxAttempts`", not "share one budget".
4. **Decision: the 10s cap on `retryAfterMs` means B4 retries before the server said to.** A capacity 429 with a `Retry-After` exists only when the header is over 60s (shorter ones are waited out by LangChain), so the spec's "honoured, still capped" always resolves to 10s in practice: B4 re-sends after 10s when the server asked for 60s+, which will usually 429 again and spend an attempt. Alternatives: don't retry a capacity 429 that carries a `Retry-After` at all, or honour it uncapped (LangChain's `modelRetryMiddleware` treats it as a floor). The plan follows the spec.
5. **Ollama isn't retried at all.** `ChatOllama` 1.3.0's chat path calls `this.client.chat` directly, not through its `AsyncCaller` (only `embeddings.js` and `llms.js` use the caller). `maxRetries` is accepted and set on `caller.maxRetries` (the test checks it) but has no effect on chat. Before this change it wasn't retried by LangChain either; only B4's run-level restart covered it. The docs' "Limits" section says so.
6. **Default change, as the spec intends.** A route without `retry` goes from LangChain's 6 request retries plus up to 3 run restarts to 3 attempts per model call. The changeset says so.
7. **Models B4 builds outside agent routes are unchanged.** The summarization model (`summarization/summarize.ts`) and the `b4 memory` distillation model (`packages/cli/src/commands/memory.ts`) call `createChatModel` without `maxRetries`, so they keep LangChain's default of 6. The spec scopes the change to agent routes; say if the route's `retry` should reach its summarization model too.
8. **Errors keep the `MiddlewareError` wrapper they already had.** `createAgent` wraps any error thrown out of a `wrapModelCall` in `MiddlewareError` (message and `name` kept, the original on `.cause`). The old middleware already had `wrapModelCall`, so clients see the same shape as before; the tests unwrap `.cause` to compare identity.
9. **No harness lane exercises retry.** `test/runtime`, `test/smoke` and `test/generated` contain no 429/5xx model fixtures (checked by grep). `pnpm verify:harness:runtime` passes with `OPENAI_API_KEY` unset (aimock). The framework and smoke lanes build generated apps against a local registry and weren't run; they don't touch retry.
10. **`agent-adapter-retry.test.ts` is misnamed.** Its `describe` says "per-agent retry config wiring" but it only tests `withRetry`, which is unchanged. Left alone.

## Deviations from the spec, and why

- **Raw-runnable agent routes lose the run-level retry** (Decision 1).
- **`retry` values are validated** (Decision 2).
- **`createChatModel` takes `maxRetries` as an option** rather than reading `retry` itself, and sets it only when given. Existing factory tests that assert the exact constructor options stay unchanged; the three `agent-adapter.test.ts` and one `agent-descriptor-integration.test.ts` assertions that build through `agent()` gain `maxRetries: 2`.
- **Capacity errors are recognised by `getRetryable(error) === true && error.rateLimitType === "capacity"`**, not by `name`. `coerceError` renames an error to `RateLimitCapacityError` only when its `name` is exactly `"Error"`; a provider SDK error with its own `name` keeps it. `getRetryable` reads a `Symbol.for` key, so the two copies of `@langchain/core` 1.2.12 in the lockfile (zod 4.4.3 and 4.6.5 peers) agree.
- **The homepage "Model retries" tile changes.** Its test pinned the old run-level retry's source text in `agent-adapter.ts`; it now pins the new mapping and middleware, and the tile copy says "Each model call retries a rate limit, a server error or a network error with backoff, and no streamed token is sent twice."
- **The retry page keeps a `## Backoff` section.** `search-index.test.ts` requires a section whose first 320 characters of prose contain "jitter"; the rewritten page's LangChain-backoff sentence opens that section.
- **More docs than `retry.mdx` change**, because they repeated the old behaviour: the `retry-flaky-tools` recipe's notes, the `stream-output` recipe's retry bullet, the `RetryConfig` field table in `api/sdk.mdx`, and the `retry` line in `templates/AGENTS.md` (served at `/AGENTS.md`). `agents.mdx` and `testing.mdx` stay true and are unchanged.
- **lastmod changes four routes, not one**: `/docs/retry`, `/docs/recipes/retry-flaky-tools`, `/docs/recipes/stream-output`, `/docs/api/sdk`. `/` doesn't move (the generator's digest for `/` doesn't include the checklist copy), and `/AGENTS.md` isn't in the manifest.

## Spec assumptions that are wrong in the code

- **"Every LangChain chat model sends each request through `AsyncCaller`" is false for `ChatOllama`** (Risk 5). The other seven do, verified in the installed packages: openai (`completionWithRetry` → `caller.callWithOptions`, SDK `maxRetries: 0`; `ChatOpenAI` delegates to `completions` and `responses` inner models, which inherit `maxRetries`), anthropic (SDK `maxRetries: 0`, `caller.callWithOptions`), google-genai (`caller.callWithOptions`), mistral (a new `AsyncCaller({ maxRetries: this.maxRetries })` per request), groq (SDK `maxRetries: 0`, `caller.call`), xai (`ChatXAI extends ChatOpenAICompletions`), openrouter (`caller.callWithOptions`). All eight constructors accept `maxRetries`.
- **A quota 429 is `InsufficientQuotaError` for OpenAI**, not `RateLimitQuotaExhaustedError`. `defaultFailedAttemptHandler` names an `insufficient_quota` code `InsufficientQuotaError`; `RateLimitQuotaExhaustedError` is only for a quota detected from the message text. Both carry `rateLimitType: "stop"` and `retryable: false`. Verified with the real `ChatOpenAI` and a fake `fetch`: headerless 429 → `name: "RateLimitCapacityError"`, `rateLimitType: "capacity"`, `rateLimitReason: "headerless_429"`, `retryable: true`, one request; `Retry-After: 120` → same plus `retryAfterMs: 120000`, `rateLimitReason: "retry_after_too_large"`; `insufficient_quota` → `InsufficientQuotaError`, `retryable: false`; 503 with `maxRetries: 1` → two requests.
- **The capacity error is thrown before any token for streaming calls**: `_streamResponseChunks` awaits `completionWithRetry(...)` for the stream, and tokens are consumed outside it. Confirmed end to end above (one request, error thrown from `model.stream()` before any chunk).
- **A 429 that LangChain waited on and then ran out of retries surfaces with `rateLimitType: "wait"`**, retryable. With `maxAttempts: 1` (`maxRetries: 0`) a 429 with `Retry-After: 5` is thrown immediately in that shape. B4's layer leaves it alone (only `"capacity"`), consistent with "`maxAttempts: 1` fails fast".
- **`retryAfterMs` can also come from the message text** (`"try again in 20s"`), not only the header (`parseRetryAfterFromMessageMs`).
- **LangChain's backoff is p-retry's with `minTimeout` 1000, `factor` 2, `randomize: true`**: each delay is between 1× and 2× of `1000 * 2^n`, raised to the error's `retryAfterMs` when that's larger.
- **LangChain doesn't retry `400`–`407`, `409` or `413`** (`STATUS_NO_RETRY`); every other status, including `408`, `422` and other 4xx, is retried. The docs say exactly which.
- **An error escaping B4's `wrapModelCall` reaches the client as a `MiddlewareError`** (Risk 8).
- **The run-level retry also ran for raw runnables** exported from an agent route, with a hard-coded default of 3 (Decision 1).
- **The homepage checklist test pinned the old implementation's source text** (`retryConfig?.maxAttempts ?? 3`, the `hasYielded` line, `Math.min(1000 * 2 ** attempt`), and the search-index test needs "jitter" in a section's opening prose. The spec didn't list either.
- **`@langchain/core/utils/async_caller` exports `AsyncCaller`, `classifyRateLimitError` and `parseRetryAfterMs`; `@langchain/core/errors` exports `getRetryable` and `stampRetryable`.** The metadata fields (`rateLimitType`, `rateLimitReason`, `retryAfterMs`) are plain properties with no exported accessor; the plan reads `rateLimitType` and `retryAfterMs` directly.
- **LangChain ships `modelRetryMiddleware`** (`langchain/dist/agents/middleware/modelRetry.js`). It isn't used: its `sleep` ignores the abort signal, it treats `retryAfterMs` as an uncapped floor, its default `onFailure: "continue"` turns the final error into an `AIMessage`, and it sets `modelSettings.maxRetries: 0`, which only some providers read.

**Rules that apply to every task** (from `AGENTS.md` and memory):
- Run commands from the repo root, on Node 24: `source ~/.nvm/nvm.sh && nvm use 24`. A fresh worktree needs `pnpm install --frozen-lockfile` first.
- Build first: `pnpm build`. Other packages' tests load `@b4run/*` from `dist/`.
- `exactOptionalPropertyTypes` is on: conditional spreads, never `{ x: undefined }`.
- `src/` imports siblings with `.js`; `test/` imports with `.ts`.
- Never run bare `biome check --write`. Use `pnpm lint`, or scope Biome to the files you changed: `pnpm --filter @b4run/langchain exec biome check --write --config-path ../config-biome/biome.json <paths>`.
- Don't pipe a gate through `tail` or `grep` when you need its exit code.
- Never `git stash`, never `pkill`, and never kill a process you didn't start. Stage explicit paths only and run `git status --short` before every commit.
- Examples and docs use `gpt-5-mini`. (The existing `agent-adapter.test.ts` assertions use `gpt-4o-mini`; they're test fixtures and stay.)
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- To apply a diff block: save it to a file in your scratchpad (for example `<scratchpad>/task3-adapter.diff`) and run `git apply <file>` from the repo root. If it doesn't apply, the base has moved; apply the hunks by hand.

---

## File Structure

| File | Responsibility |
|---|---|
| Create `packages/langchain/src/model-call-retry.ts` | Policy defaults and validation, `maxRetries` mapping, capacity-429 recognition, backoff, `retryCapacityErrors`. |
| Create `packages/langchain/test/helpers/langchain-errors.ts` | Errors classified by a real `AsyncCaller`: headerless 429, long `Retry-After` 429, quota 429, 503. |
| Create `packages/langchain/test/model-call-retry.test.ts` | Unit tests with a recording clock. |
| Modify `packages/langchain/src/chat-model-factory.ts` | Optional `maxRetries` passed to the provider constructor. |
| Create `packages/langchain/test/chat-model-factory-max-retries.test.ts` | Each of the eight providers, with a fake class and with the installed package's own request caller. |
| Modify `packages/langchain/src/agent-adapter.ts` | Resolve the policy, pass `maxRetries` and the policy; remove the run-level retry. |
| Modify `packages/langchain/src/agent-middleware.ts` | `retry` option; `wrapModelCall` runs `retryCapacityErrors`. |
| Create `packages/langchain/test/agent-retry-per-model-call.test.ts` | Real `createAgent` graph through `streamAgent` with a streaming fake model and fake timers. |
| Modify `packages/langchain/test/agent-adapter.test.ts`, `packages/langchain/test/agent-descriptor-integration.test.ts` | Constructor options now include `maxRetries: 2`. |
| Modify `packages/sdk/src/agent.ts` | `RetryConfig` JSDoc. |
| Create `.changeset/agent-retry-per-model-call.md` | Patch for `@b4run/langchain` and `@b4run/sdk`. |
| Modify `apps/web/content/docs/retry.mdx` | Rewritten. |
| Modify `apps/web/content/docs/recipes/retry-flaky-tools.mdx`, `apps/web/content/docs/recipes/stream-output.mdx`, `apps/web/content/docs/api/sdk.mdx`, `apps/web/content/templates/AGENTS.md` | Lines that repeated the old behaviour. |
| Modify `apps/web/app/components/homepage/checklist/checklist.ts`, `checklist.test.ts` | Tile copy and its source pins. |
| Modify `apps/web/app/seo/lastmod.generated.json` | Four routes (Task 7). |

---

### Task 1: The model-call retry module

**Files:**
- Create: `packages/langchain/test/helpers/langchain-errors.ts`
- Create: `packages/langchain/test/model-call-retry.test.ts`
- Create: `packages/langchain/src/model-call-retry.ts`

- [ ] **Step 1: Write the error helper**

The helper throws each error through a real `AsyncCaller` with `maxRetries: 0`, so the name, the `retryable` stamp and the rate-limit metadata are LangChain's own, not hand-stamped.

`packages/langchain/test/helpers/langchain-errors.ts`:

```ts
/**
 * Provider errors classified by LangChain itself, not hand-stamped: each one
 * is thrown through a real `AsyncCaller` with `maxRetries: 0`, so its name,
 * `retryable` stamp and rate-limit metadata are exactly what a chat model
 * built on `@langchain/core` hands back.
 */
import { AsyncCaller } from "@langchain/core/utils/async_caller"

interface HttpErrorShape {
  readonly status: number
  readonly message: string
  readonly headers?: Readonly<Record<string, string>>
  readonly code?: string
}

function httpError(shape: HttpErrorShape): Error {
  // Mirrors the provider SDKs' APIError: `status`, `headers`, and an
  // `error.code` from the response body.
  return Object.assign(new Error(shape.message), {
    status: shape.status,
    headers: shape.headers ?? {},
    ...(shape.code !== undefined ? { error: { code: shape.code } } : {}),
  })
}

async function classify(shape: HttpErrorShape): Promise<Error> {
  const caller = new AsyncCaller({ maxRetries: 0 })
  try {
    await caller.call(() => Promise.reject(httpError(shape)))
  } catch (error) {
    return error as Error
  }
  throw new Error("AsyncCaller resolved a call that always rejects")
}

/** A 429 with no `Retry-After`: LangChain's `RateLimitCapacityError`. */
export function headerlessRateLimit(): Promise<Error> {
  return classify({ status: 429, message: "Rate limit reached for requests" })
}

/** A 429 whose `Retry-After` (seconds) is too long for LangChain to wait out. */
export function longRetryAfterRateLimit(seconds: number): Promise<Error> {
  return classify({
    status: 429,
    message: "Rate limit reached for requests",
    headers: { "retry-after": String(seconds) },
  })
}

/** A quota 429: LangChain's `InsufficientQuotaError`, stamped not retryable. */
export function quotaExhausted(): Promise<Error> {
  return classify({
    status: 429,
    message: "You exceeded your current quota, please check your plan and billing details.",
    code: "insufficient_quota",
  })
}

/** A 503, which LangChain retries itself; B4's own layer must leave it alone. */
export function serviceUnavailable(): Error {
  return httpError({ status: 503, message: "503 Service Unavailable" })
}
```

- [ ] **Step 2: Write the failing unit tests**

`packages/langchain/test/model-call-retry.test.ts`:

```ts
import { getRetryable } from "@langchain/core/errors"
import { describe, expect, test } from "vitest"
import {
  capacityRetryDelay,
  isCapacityRateLimitError,
  MAX_RETRY_DELAY_MS,
  providerMaxRetries,
  type RetryClock,
  resolveModelRetryPolicy,
  retryCapacityErrors,
} from "../src/model-call-retry.ts"
import {
  headerlessRateLimit,
  longRetryAfterRateLimit,
  quotaExhausted,
  serviceUnavailable,
} from "./helpers/langchain-errors.ts"

/** Records every wait instead of sleeping; `random` is pinned. */
function recordingClock(random = 0): RetryClock & { readonly waits: number[] } {
  const waits: number[] = []
  return {
    waits,
    random: () => random,
    sleep: async (ms, signal) => {
      waits.push(ms)
      if (signal?.aborted) throw signal.reason
    },
  }
}

describe("resolveModelRetryPolicy", () => {
  test("defaults to 3 attempts and a 1000ms base delay", () => {
    expect(resolveModelRetryPolicy(undefined)).toEqual({ maxAttempts: 3, baseDelay: 1000 })
    expect(resolveModelRetryPolicy({})).toEqual({ maxAttempts: 3, baseDelay: 1000 })
  })

  test("keeps the author's values", () => {
    expect(resolveModelRetryPolicy({ maxAttempts: 1, baseDelay: 0 })).toEqual({
      maxAttempts: 1,
      baseDelay: 0,
    })
  })

  test.each([0, -1, 1.5, Number.NaN])("rejects maxAttempts %s", (maxAttempts) => {
    expect(() => resolveModelRetryPolicy({ maxAttempts })).toThrow(/retry\.maxAttempts/)
  })

  test.each([-1, Number.POSITIVE_INFINITY, Number.NaN])("rejects baseDelay %s", (baseDelay) => {
    expect(() => resolveModelRetryPolicy({ baseDelay })).toThrow(/retry\.baseDelay/)
  })
})

describe("providerMaxRetries", () => {
  test("is the attempts after the first", () => {
    expect(providerMaxRetries({ maxAttempts: 1, baseDelay: 1000 })).toBe(0)
    expect(providerMaxRetries({ maxAttempts: 3, baseDelay: 1000 })).toBe(2)
    expect(providerMaxRetries({ maxAttempts: 5, baseDelay: 1000 })).toBe(4)
  })
})

describe("isCapacityRateLimitError", () => {
  test("recognises LangChain's capacity 429s by their stamps", async () => {
    const headerless = await headerlessRateLimit()
    const longWait = await longRetryAfterRateLimit(120)
    expect(headerless.name).toBe("RateLimitCapacityError")
    expect(getRetryable(headerless)).toBe(true)
    expect(isCapacityRateLimitError(headerless)).toBe(true)
    expect(isCapacityRateLimitError(longWait)).toBe(true)
  })

  test("leaves a quota 429 alone", async () => {
    const quota = await quotaExhausted()
    expect(getRetryable(quota)).toBe(false)
    expect(isCapacityRateLimitError(quota)).toBe(false)
  })

  test("does not match on text or name alone", () => {
    expect(isCapacityRateLimitError(new Error("429 rate limit"))).toBe(false)
    const named = Object.assign(new Error("slow down"), { name: "RateLimitCapacityError" })
    expect(isCapacityRateLimitError(named)).toBe(false)
    const unstamped = Object.assign(new Error("slow down"), { rateLimitType: "capacity" })
    expect(isCapacityRateLimitError(unstamped)).toBe(false)
    expect(isCapacityRateLimitError(serviceUnavailable())).toBe(false)
    expect(isCapacityRateLimitError(undefined)).toBe(false)
  })
})

describe("capacityRetryDelay", () => {
  test("doubles baseDelay per retry and adds up to 500ms of jitter", async () => {
    const error = await headerlessRateLimit()
    expect(capacityRetryDelay(error, 0, 200, () => 0)).toBe(200)
    expect(capacityRetryDelay(error, 1, 200, () => 0)).toBe(400)
    expect(capacityRetryDelay(error, 2, 200, () => 0.5)).toBe(1050)
  })

  test("caps the backoff at 10 seconds", async () => {
    const error = await headerlessRateLimit()
    expect(capacityRetryDelay(error, 10, 1000, () => 0)).toBe(MAX_RETRY_DELAY_MS)
  })

  test("uses the error's retryAfterMs when present, capped at 10 seconds", async () => {
    const longWait = await longRetryAfterRateLimit(120)
    expect((longWait as { retryAfterMs?: number }).retryAfterMs).toBe(120_000)
    expect(capacityRetryDelay(longWait, 0, 200, () => 0)).toBe(MAX_RETRY_DELAY_MS)

    const shortWait = Object.assign(await headerlessRateLimit(), { retryAfterMs: 3000 })
    expect(capacityRetryDelay(shortWait, 0, 200, () => 0.9)).toBe(3000)
  })
})

describe("retryCapacityErrors", () => {
  const policy = { maxAttempts: 3, baseDelay: 100 }

  test("sends the call again after a capacity 429 and returns its result", async () => {
    const clock = recordingClock()
    const capacity = await headerlessRateLimit()
    let calls = 0
    const result = await retryCapacityErrors(
      async () => {
        calls += 1
        if (calls < 3) throw capacity
        return "ok"
      },
      policy,
      { clock },
    )
    expect(result).toBe("ok")
    expect(calls).toBe(3)
    expect(clock.waits).toEqual([100, 200])
  })

  test("stops after maxAttempts and rethrows the last error", async () => {
    const clock = recordingClock()
    const capacity = await headerlessRateLimit()
    let calls = 0
    await expect(
      retryCapacityErrors(
        async () => {
          calls += 1
          throw capacity
        },
        policy,
        { clock },
      ),
    ).rejects.toBe(capacity)
    expect(calls).toBe(3)
    expect(clock.waits).toEqual([100, 200])
  })

  test("maxAttempts 1 sends the call once", async () => {
    const clock = recordingClock()
    const capacity = await headerlessRateLimit()
    let calls = 0
    await expect(
      retryCapacityErrors(
        async () => {
          calls += 1
          throw capacity
        },
        { maxAttempts: 1, baseDelay: 100 },
        { clock },
      ),
    ).rejects.toBe(capacity)
    expect(calls).toBe(1)
    expect(clock.waits).toEqual([])
  })

  test.each([
    ["a quota 429", quotaExhausted],
    ["a 503", async () => serviceUnavailable()],
    ["an unclassified error", async () => new Error("429 rate limit")],
  ])("does not retry %s", async (_label, make) => {
    const clock = recordingClock()
    const error = await make()
    let calls = 0
    await expect(
      retryCapacityErrors(
        async () => {
          calls += 1
          throw error
        },
        policy,
        { clock },
      ),
    ).rejects.toBe(error)
    expect(calls).toBe(1)
    expect(clock.waits).toEqual([])
  })

  test("an abort during the wait stops the retry", async () => {
    const controller = new AbortController()
    const capacity = await headerlessRateLimit()
    const clock: RetryClock = {
      random: () => 0,
      sleep: async (_ms, signal) => {
        controller.abort(new Error("client went away"))
        if (signal?.aborted) throw signal.reason
      },
    }
    let calls = 0
    await expect(
      retryCapacityErrors(
        async () => {
          calls += 1
          throw capacity
        },
        policy,
        { signal: controller.signal, clock },
      ),
    ).rejects.toThrow("client went away")
    expect(calls).toBe(1)
  })

  test("an already-aborted signal does not wait at all", async () => {
    const controller = new AbortController()
    controller.abort()
    const clock = recordingClock()
    const capacity = await headerlessRateLimit()
    await expect(
      retryCapacityErrors(
        async () => {
          throw capacity
        },
        policy,
        { signal: controller.signal, clock },
      ),
    ).rejects.toBe(capacity)
    expect(clock.waits).toEqual([])
  })
})
```

- [ ] **Step 3: Run them red**

Run: `pnpm --filter @b4run/langchain exec vitest --run --config vitest.config.ts test/model-call-retry.test.ts`
Expected: FAIL, `Error: Cannot find module '../src/model-call-retry.ts'`, and `Tests no tests`.

- [ ] **Step 4: Write the module**

`packages/langchain/src/model-call-retry.ts`:

```ts
/**
 * `agent({ retry })` for one model call.
 *
 * Two layers, both scoped to a single model request:
 *
 * 1. LangChain's own. Every built-in provider's chat model (except
 *    `ChatOllama`, whose chat requests bypass it) sends each request through
 *    `@langchain/core`'s `AsyncCaller`, which retries 5xx and network errors
 *    and waits out a 429 whose `Retry-After` is 60s or less. B4 sets its
 *    budget with the model's `maxRetries` ({@link providerMaxRetries}).
 * 2. This module's. `AsyncCaller` hands back, without retrying, a 429 it
 *    classifies as a capacity limit (no `Retry-After`, or one over 60s). That
 *    error is raised when the request is made, before any token, so B4 can
 *    send the same model call again without repeating output
 *    ({@link retryCapacityErrors}).
 */
import type { RetryConfig } from "@b4run/sdk"
import { getRetryable } from "@langchain/core/errors"

export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_BASE_DELAY_MS = 1000
export const MAX_RETRY_DELAY_MS = 10_000
const JITTER_MS = 500

export interface ModelRetryPolicy {
  /** Attempts per model call, counting the first. */
  readonly maxAttempts: number
  /** Milliseconds before the first capacity retry; doubles each time. */
  readonly baseDelay: number
}

/**
 * The route's retry policy, defaulted and checked. Throws on a value that
 * cannot mean anything (zero or fractional attempts, a negative delay), so a
 * typo fails the route instead of silently changing how often it retries.
 */
export function resolveModelRetryPolicy(retry: RetryConfig | undefined): ModelRetryPolicy {
  const maxAttempts = retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseDelay = retry?.baseDelay ?? DEFAULT_BASE_DELAY_MS
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      `agent() retry.maxAttempts must be a whole number of at least 1, got ${String(maxAttempts)}.`,
    )
  }
  if (!Number.isFinite(baseDelay) || baseDelay < 0) {
    throw new Error(
      `agent() retry.baseDelay must be a number of milliseconds of at least 0, got ${String(baseDelay)}.`,
    )
  }
  return { maxAttempts, baseDelay }
}

/** The chat model's `maxRetries`: the attempts after the first. */
export function providerMaxRetries(policy: ModelRetryPolicy): number {
  return policy.maxAttempts - 1
}

/**
 * A 429 LangChain classified as a capacity limit and stamped retryable.
 * Recognised by LangChain's own stamps, never by message text: the
 * `retryable` mark (`getRetryable`, a `Symbol.for` key, so duplicate copies
 * of `@langchain/core` agree) and the `rateLimitType` it sets alongside.
 * A quota 429 carries `rateLimitType: "stop"` and `retryable: false`.
 */
export function isCapacityRateLimitError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    getRetryable(error) === true &&
    (error as { rateLimitType?: unknown }).rateLimitType === "capacity"
  )
}

/**
 * The wait before capacity retry `retryIndex` (0 for the first retry): the
 * error's `retryAfterMs` when LangChain parsed one, else
 * `baseDelay * 2^retryIndex` plus up to 500ms of jitter. Capped at 10s either
 * way, so a long `Retry-After` never holds a run open for minutes.
 */
export function capacityRetryDelay(
  error: unknown,
  retryIndex: number,
  baseDelay: number,
  random: () => number,
): number {
  const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs
  const delay =
    typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? retryAfterMs
      : baseDelay * 2 ** retryIndex + random() * JITTER_MS
  return Math.min(delay, MAX_RETRY_DELAY_MS)
}

/** Time source for the backoff; replaced in tests. */
export interface RetryClock {
  readonly sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>
  readonly random: () => number
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Operation aborted")
}

export const systemRetryClock: RetryClock = {
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal))
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortReason(signal as AbortSignal))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      signal?.addEventListener("abort", onAbort, { once: true })
    }),
  random: () => Math.random(),
}

/**
 * Run one model call, sending it again after a capacity 429 until it
 * succeeds, fails another way, or has used `maxAttempts` attempts. An abort
 * during the wait rejects with the signal's reason and sends nothing more.
 */
export async function retryCapacityErrors<T>(
  call: () => T | Promise<T>,
  policy: ModelRetryPolicy,
  options: { readonly signal?: AbortSignal; readonly clock?: RetryClock } = {},
): Promise<T> {
  const clock = options.clock ?? systemRetryClock
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call()
    } catch (error) {
      if (!isCapacityRateLimitError(error) || attempt >= policy.maxAttempts) throw error
      if (options.signal?.aborted) throw error
      await clock.sleep(
        capacityRetryDelay(error, attempt - 1, policy.baseDelay, clock.random),
        options.signal,
      )
    }
  }
}
```

`random: () => Math.random()` is deliberate, not `random: Math.random`: the integration tests spy on `Math.random`, and a captured reference would bypass the spy.

- [ ] **Step 5: Run them green**

Run: `pnpm --filter @b4run/langchain exec vitest --run --config vitest.config.ts test/model-call-retry.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 6: Commit**

```bash
git status --short
git add packages/langchain/src/model-call-retry.ts packages/langchain/test/model-call-retry.test.ts packages/langchain/test/helpers/langchain-errors.ts
git commit -m "feat(langchain): per-model-call retry policy and the capacity-429 layer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `createChatModel` passes `maxRetries`

**Files:**
- Create: `packages/langchain/test/chat-model-factory-max-retries.test.ts`
- Modify: `packages/langchain/src/chat-model-factory.ts`

- [ ] **Step 1: Write the failing tests**

The second `test.each` constructs each installed provider class for real (offline; a dummy key via `vi.stubEnv`) and reads `maxRetries` off the `AsyncCaller` it sends requests through. The model ids are only constructor strings; `warnOnUnknownModelId` may print an advisory warning for some, which is fine.

`packages/langchain/test/chat-model-factory-max-retries.test.ts`:

```ts
import type { BuiltInModelProviderId } from "@b4run/sdk"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createChatModel } from "../src/chat-model-factory.ts"
import { defaultModelImporter } from "../src/default-model-importer.ts"

class FakeModel {
  constructor(readonly options: Record<string, unknown>) {}
}

const providers: ReadonlyArray<{
  readonly provider: BuiltInModelProviderId
  readonly exportName: string
  readonly model: string
  readonly apiKeyEnv?: string
}> = [
  {
    provider: "openai",
    exportName: "ChatOpenAI",
    model: "gpt-5-mini",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    provider: "anthropic",
    exportName: "ChatAnthropic",
    model: "claude-sonnet-4-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  {
    provider: "google",
    exportName: "ChatGoogleGenerativeAI",
    model: "gemini-2.5-flash",
    apiKeyEnv: "GOOGLE_API_KEY",
  },
  {
    provider: "mistral",
    exportName: "ChatMistralAI",
    model: "mistral-large-latest",
    apiKeyEnv: "MISTRAL_API_KEY",
  },
  {
    provider: "groq",
    exportName: "ChatGroq",
    model: "llama-3.3-70b-versatile",
    apiKeyEnv: "GROQ_API_KEY",
  },
  { provider: "ollama", exportName: "ChatOllama", model: "llama3.2" },
  { provider: "xai", exportName: "ChatXAI", model: "grok-4", apiKeyEnv: "XAI_API_KEY" },
  {
    provider: "openrouter",
    exportName: "ChatOpenRouter",
    model: "openai/gpt-5-mini",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
]

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("createChatModel maxRetries", () => {
  test.each(providers)("passes maxRetries to the $provider constructor", async (spec) => {
    for (const maxRetries of [0, 2]) {
      const model = (await createChatModel({
        model: spec.model,
        provider: spec.provider,
        maxRetries,
        importer: async () => ({ [spec.exportName]: FakeModel }),
      })) as FakeModel
      expect(model.options.maxRetries).toBe(maxRetries)
    }
  })

  test("leaves maxRetries unset when the caller passes none", async () => {
    const model = (await createChatModel({
      model: "gpt-5-mini",
      provider: "openai",
      importer: async () => ({ ChatOpenAI: FakeModel }),
    })) as FakeModel
    expect("maxRetries" in model.options).toBe(false)
  })

  // The real provider classes, constructed offline: the value must reach the
  // AsyncCaller each one sends its requests through (ChatOpenAI delegates to
  // two inner models, and ChatMistralAI builds its caller per request from
  // its own `maxRetries` field).
  test.each(providers)(
    "the installed $provider package applies it to its request caller",
    async (spec) => {
      if (spec.apiKeyEnv) vi.stubEnv(spec.apiKeyEnv, "test-key-not-used")
      for (const maxRetries of [0, 2]) {
        const model = (await createChatModel({
          model: spec.model,
          provider: spec.provider,
          maxRetries,
          importer: defaultModelImporter,
        })) as Record<string, unknown> & { caller: { maxRetries: number } }
        expect(model.caller.maxRetries).toBe(maxRetries)
        for (const inner of ["completions", "responses"]) {
          const delegate = model[inner] as { caller: { maxRetries: number } } | undefined
          if (delegate) expect(delegate.caller.maxRetries).toBe(maxRetries)
        }
        if ("maxRetries" in model) expect(model.maxRetries).toBe(maxRetries)
      }
    },
  )
})
```

- [ ] **Step 2: Run them red**

Run: `pnpm --filter @b4run/langchain exec vitest --run --config vitest.config.ts test/chat-model-factory-max-retries.test.ts`
Expected: FAIL: the 8 "passes maxRetries" cases (`expected undefined to be 0`) and the 8 "installed package" cases (`expected 6 to be 0`). "leaves maxRetries unset" passes.

- [ ] **Step 3: Implement**

Apply:

```diff
diff --git a/packages/langchain/src/chat-model-factory.ts b/packages/langchain/src/chat-model-factory.ts
index 11a674487..cd65cdebf 100644
--- a/packages/langchain/src/chat-model-factory.ts
+++ b/packages/langchain/src/chat-model-factory.ts
@@ -234,6 +234,12 @@ export async function createChatModel(options: {
    * providers can. Any other provider rejects BEFORE its package is imported.
    */
   readonly responseFormat?: JsonSchemaResponseFormat
+  /**
+   * The chat model's `maxRetries`: how many times LangChain's `AsyncCaller`
+   * re-sends one failed request. Agent routes pass `retry.maxAttempts - 1`;
+   * left unset, the provider package's own default applies (6).
+   */
+  readonly maxRetries?: number
 }): Promise<unknown> {
   if (options.responseFormat && !supportsJsonSchemaResponseFormat(options.provider)) {
     throw new Error(unsupportedResponseFormatMessage(options.provider))
@@ -260,6 +266,7 @@ export async function createChatModel(options: {
   }
 
   const constructorOptions: Record<string, unknown> = { model: options.model }
+  if (options.maxRetries !== undefined) constructorOptions.maxRetries = options.maxRetries
   if (options.provider === "openai" && options.reasoning?.effort) {
     constructorOptions.reasoningEffort = options.reasoning.effort
   }
```

- [ ] **Step 4: Run them green**

Run: `pnpm --filter @b4run/langchain exec vitest --run --config vitest.config.ts test/chat-model-factory-max-retries.test.ts test/chat-model-factory.test.ts`
Expected: PASS. `chat-model-factory.test.ts` is unchanged because nothing passes `maxRetries` there.

- [ ] **Step 5: Commit**

```bash
git status --short
git add packages/langchain/src/chat-model-factory.ts packages/langchain/test/chat-model-factory-max-retries.test.ts
git commit -m "feat(langchain): createChatModel passes maxRetries to every provider

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Agent routes retry per model call, and never restart the run

**Files:**
- Create: `packages/langchain/test/agent-retry-per-model-call.test.ts`
- Modify: `packages/langchain/src/agent-adapter.ts`, `packages/langchain/src/agent-middleware.ts`
- Modify: `packages/langchain/test/agent-adapter.test.ts`, `packages/langchain/test/agent-descriptor-integration.test.ts`

- [ ] **Step 1: Write the failing integration tests**

A real `createAgent` graph, through `streamAgent`. `@langchain/openai` is mocked with a streaming fake that plays one script step per model call and records the fake-clock time of each call; the capacity backoff then shows up as the gap between calls. Timers are faked for `setTimeout`, `clearTimeout` and `Date` only, and `settle` keeps advancing time until the turn resolves, because LangGraph's error path arms timers of its own. `Math.random` is pinned to 0, so the jitter is 0.

`packages/langchain/test/agent-retry-per-model-call.test.ts`:

```ts
/**
 * `agent({ retry })` on a real `createAgent` graph, through `streamAgent`:
 * retry belongs to each model call, never to the run.
 *
 * The model is a streaming fake that plays a script, one step per model call,
 * and throws errors LangChain itself classified (see `helpers/langchain-errors`).
 * The capacity-429 backoff runs on vitest's fake `setTimeout`, advanced by hand.
 */

import { agent } from "@b4run/sdk"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  __resetMaterializedAgentsForTests,
  type AgentStreamChunk,
  materializeAgentGraph,
  streamAgent,
} from "../src/agent-adapter.ts"
import {
  headerlessRateLimit,
  longRetryAfterRateLimit,
  quotaExhausted,
  serviceUnavailable,
} from "./helpers/langchain-errors.ts"

type Step =
  | { readonly kind: "fail"; readonly error: Error }
  | { readonly kind: "text"; readonly tokens: readonly string[] }
  | { readonly kind: "call"; readonly id: string; readonly name: string; readonly args: object }
  | { readonly kind: "text-then-fail"; readonly tokens: readonly string[]; readonly error: Error }

let script: Step[] = []
let modelCalls = 0
/** Fake-clock time of each model call, in order. */
let callTimes: number[] = []
let constructedWith: Record<string, unknown>[] = []

class ScriptedStreamingModel extends BaseChatModel {
  constructor(options: Record<string, unknown>) {
    super({})
    constructedWith.push(options)
  }
  _llmType(): string {
    return "scripted-streaming-fake"
  }
  // biome-ignore lint/suspicious/noExplicitAny: bindTools signature in the BaseChatModel hierarchy is loose
  bindTools(_tools: any): any {
    return this
  }
  async _generate(): Promise<ChatResult> {
    throw new Error("the agent graph streams every model call")
  }
  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const step = script[modelCalls]
    modelCalls += 1
    callTimes.push(Date.now())
    if (!step) throw new Error("ScriptedStreamingModel ran out of steps")
    if (step.kind === "fail") throw step.error
    if (step.kind === "call") {
      yield new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({
          content: "",
          tool_call_chunks: [
            { id: step.id, name: step.name, args: JSON.stringify(step.args), index: 0 },
          ],
        }),
      })
      return
    }
    for (const token of step.tokens) {
      const chunk = new ChatGenerationChunk({
        text: token,
        message: new AIMessageChunk({ content: token }),
      })
      yield chunk
      await runManager?.handleLLMNewToken(token, undefined, undefined, undefined, undefined, {
        chunk,
      })
    }
    if (step.kind === "text-then-fail") throw step.error
  }
}

let toolRuns = 0
const lookup = {
  name: "lookup",
  description: "Look up an order.",
  schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  run: async (input: unknown) => {
    toolRuns += 1
    return { status: "shipped", id: (input as { id: string }).id }
  },
}

interface TurnResult {
  readonly chunks: AgentStreamChunk[]
  readonly error: unknown
}

function startTurn(options: {
  readonly retry?: { maxAttempts?: number; baseDelay?: number }
  readonly signal?: AbortSignal
}): Promise<TurnResult> {
  const chunks: AgentStreamChunk[] = []
  return (async () => {
    try {
      for await (const chunk of streamAgent({
        checkpointer: new MemorySaver(),
        entry: agent({
          model: "gpt-5-mini",
          systemPrompt: "Answer order questions.",
          ...(options.retry ? { retry: options.retry } : {}),
        }),
        input: { messages: [{ role: "user", content: "where is order 7?" }] },
        routeParamNames: [],
        signal: options.signal ?? new AbortController().signal,
        threadId: `retry-${Math.random()}`,
        tools: [lookup],
      })) {
        chunks.push(chunk)
      }
      return { chunks, error: undefined }
    } catch (error) {
      return { chunks, error }
    }
  })()
}

function tokens(chunks: readonly AgentStreamChunk[]): string[] {
  return chunks.filter((c) => c.type === "token").map((c) => String(c.data))
}

/** Advance fake time 1ms at a time until `modelCalls` reaches `calls`. */
async function advanceUntilCalls(calls: number, limitMs: number): Promise<void> {
  for (let elapsed = 0; modelCalls < calls && elapsed < limitMs; elapsed += 1) {
    await vi.advanceTimersByTimeAsync(1)
  }
}

/** Milliseconds between consecutive model calls. */
function gapsBetweenCalls(): number[] {
  return callTimes.slice(1).map((time, i) => time - (callTimes[i] as number))
}

/** `createAgent` wraps an error thrown out of a middleware; the cause is the model's. */
function modelError(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error
}

/** Let a turn finish, running any timers it (or its error path) arms. */
async function settle<T>(turn: Promise<T>): Promise<T> {
  let settled = false
  let result: T | undefined
  void turn.then((r) => {
    settled = true
    result = r
  })
  for (let i = 0; !settled && i < 1000; i += 1) {
    await vi.advanceTimersByTimeAsync(100)
  }
  if (!settled) throw new Error("the turn never settled")
  return result as T
}

beforeEach(() => {
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ScriptedStreamingModel }))
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.spyOn(Math, "random").mockReturnValue(0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.doUnmock("@langchain/openai")
  script = []
  modelCalls = 0
  callTimes = []
  toolRuns = 0
  constructedWith = []
  __resetMaterializedAgentsForTests()
})

describe("maxAttempts reaches the chat model as maxRetries", () => {
  test.each([
    [undefined, 2],
    [{ maxAttempts: 1 }, 0],
    [{ maxAttempts: 5, baseDelay: 10 }, 4],
  ])("retry %j → maxRetries %i", async (retry, maxRetries) => {
    await materializeAgentGraph({
      descriptor: agent({
        model: "gpt-5-mini",
        systemPrompt: "x",
        ...(retry ? { retry } : {}),
      }),
    })
    expect(constructedWith.at(-1)?.maxRetries).toBe(maxRetries)
  })

  test("an invalid maxAttempts fails the route before any model call", async () => {
    await expect(
      materializeAgentGraph({
        descriptor: agent({ model: "gpt-5-mini", systemPrompt: "x", retry: { maxAttempts: 0 } }),
      }),
    ).rejects.toThrow(/retry\.maxAttempts/)
    expect(constructedWith).toEqual([])
  })
})

describe("the capacity-429 layer", () => {
  test("retries a capacity 429 on the second model call of a tool loop with baseDelay backoff", async () => {
    script = [
      { kind: "call", id: "call_1", name: "lookup", args: { id: "7" } },
      { kind: "fail", error: await headerlessRateLimit() },
      { kind: "fail", error: await headerlessRateLimit() },
      { kind: "text", tokens: ["Order 7 ", "has shipped."] },
    ]
    const { chunks, error } = await settle(startTurn({ retry: { maxAttempts: 3, baseDelay: 200 } }))

    expect(error).toBeUndefined()
    expect(modelCalls).toBe(4)
    // The tool runs between calls 1 and 2 on no timer; then the first retry
    // waits baseDelay (jitter pinned to 0), the second twice that.
    expect(gapsBetweenCalls()).toEqual([0, 200, 400])
    expect(toolRuns).toBe(1)
    expect(tokens(chunks)).toEqual(["Order 7 ", "has shipped."])
    expect(chunks.filter((c) => c.type === "tool_call")).toHaveLength(1)
    expect(chunks.filter((c) => c.type === "tool_result")).toHaveLength(1)
    expect(chunks.at(-1)?.type).toBe("done")
  })

  test("gives up after maxAttempts capacity 429s and surfaces the error", async () => {
    const capacity = await headerlessRateLimit()
    script = [
      { kind: "fail", error: capacity },
      { kind: "fail", error: capacity },
    ]
    const { error } = await settle(startTurn({ retry: { maxAttempts: 2, baseDelay: 50 } }))
    expect(modelError(error)).toBe(capacity)
    expect(modelCalls).toBe(2)
    expect(gapsBetweenCalls()).toEqual([50])
  })

  test("a quota 429 is not retried", async () => {
    const quota = await quotaExhausted()
    script = [{ kind: "fail", error: quota }]
    const { error } = await settle(startTurn({ retry: { maxAttempts: 3, baseDelay: 50 } }))
    expect(modelError(error)).toBe(quota)
    expect(modelCalls).toBe(1)
  })

  test("honours retryAfterMs, capped at 10 seconds", async () => {
    script = [
      { kind: "fail", error: await longRetryAfterRateLimit(120) },
      { kind: "text", tokens: ["done"] },
    ]
    const { chunks, error } = await settle(startTurn({ retry: { maxAttempts: 2, baseDelay: 50 } }))
    expect(error).toBeUndefined()
    // Not the 50ms baseDelay, and not the 120s the header asked for.
    expect(gapsBetweenCalls()).toEqual([10_000])
    expect(tokens(chunks)).toEqual(["done"])
  })

  test("an abort during the backoff wait stops the retry", async () => {
    const controller = new AbortController()
    script = [
      { kind: "fail", error: await headerlessRateLimit() },
      { kind: "text", tokens: ["never"] },
    ]
    const turn = startTurn({
      retry: { maxAttempts: 3, baseDelay: 5000 },
      signal: controller.signal,
    })
    await advanceUntilCalls(1, 1000)
    await vi.advanceTimersByTimeAsync(100)
    const reason = new Error("client went away")
    controller.abort(reason)
    const { chunks, error } = await settle(turn)
    expect(modelError(error)).toBe(reason)
    // The run is over; nothing is left waiting to send the call again.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(modelCalls).toBe(1)
    expect(tokens(chunks)).toEqual([])
  })
})

describe("no run-level retry", () => {
  test("a failure after tokens streamed is not retried, and no token is emitted twice", async () => {
    const dropped = serviceUnavailable()
    script = [
      { kind: "text-then-fail", tokens: ["Order ", "7 "], error: dropped },
      { kind: "text", tokens: ["Order ", "7 ", "has shipped."] },
    ]
    const { chunks, error } = await settle(startTurn({ retry: { maxAttempts: 3, baseDelay: 50 } }))
    expect(modelError(error)).toBe(dropped)
    expect(modelCalls).toBe(1)
    expect(tokens(chunks)).toEqual(["Order ", "7 "])
  })

  test("a failure before anything streamed does not restart the run", async () => {
    // A transient-looking error the old run-level retry matched on its text.
    const early = new Error("503 Service Unavailable")
    script = [
      { kind: "fail", error: early },
      { kind: "text", tokens: ["recovered"] },
    ]
    const { chunks, error } = await settle(startTurn({ retry: { maxAttempts: 3, baseDelay: 50 } }))
    expect(modelError(error)).toBe(early)
    expect(modelCalls).toBe(1)
    expect(chunks).toEqual([])
  })

  test("a raw runnable's stream is opened once, before or after output", async () => {
    for (const yieldFirst of [false, true]) {
      let opened = 0
      const entry = {
        invoke: async () => ({}),
        async *streamEvents() {
          opened += 1
          if (yieldFirst) {
            yield {
              event: "on_chat_model_stream",
              run_id: "m1",
              name: "model",
              data: { chunk: { content: "partial" } },
            }
          }
          throw new Error("503 Service Unavailable")
        },
      }
      const chunks: AgentStreamChunk[] = []
      const error = await settle(
        (async () => {
          try {
            for await (const chunk of streamAgent({
              entry,
              checkpointer: new MemorySaver(),
              input: {},
              tools: [],
              routeParamNames: [],
              signal: new AbortController().signal,
            })) {
              chunks.push(chunk)
            }
            return undefined
          } catch (caught) {
            return caught
          }
        })(),
      )
      expect((error as Error).message).toBe("503 Service Unavailable")
      expect(opened).toBe(1)
      expect(tokens(chunks)).toEqual(yieldFirst ? ["partial"] : [])
    }
  })
})
```

- [ ] **Step 2: Run them red**

Run: `pnpm --filter @b4run/langchain exec vitest --run --config vitest.config.ts test/agent-retry-per-model-call.test.ts`
Expected: FAIL, 9 of 12:

- the three `retry … → maxRetries …` cases: `expected undefined to be 2` (then `+0`, `4`);
- "an invalid maxAttempts…": `promise resolved "ReactAgent{ … }" instead of rejecting`;
- "retries a capacity 429 on the second model call…": the error surfaces (`expected RateLimitCapacityError … to be undefined`);
- "gives up after maxAttempts…" and "honours retryAfterMs…": `expected [ 1000 ] to deeply equal [ 50 ]` / `[ 10000 ]`. The old run-level retry restarted the whole run after its fixed 1000ms, because the message contains "rate limit";
- "a failure before anything streamed does not restart the run": `expected undefined to be Error: 503 Service Unavailable` (the restarted run succeeded);
- "a raw runnable's stream is opened once…": `expected 3 to be 1`.

"a quota 429 is not retried", "a failure after tokens streamed…" and "an abort during the backoff wait…" pass on the old code too: it didn't retry a quota error or a run that had streamed, and after the abort its restart made no second model call. They pin behaviour the change must keep.

- [ ] **Step 3: Wire the policy into the middleware**

Apply:

```diff
diff --git a/packages/langchain/src/agent-middleware.ts b/packages/langchain/src/agent-middleware.ts
index f56239d10..18a0dcd3b 100644
--- a/packages/langchain/src/agent-middleware.ts
+++ b/packages/langchain/src/agent-middleware.ts
@@ -8,6 +8,11 @@ import {
 import { isGraphInterrupt } from "@langchain/langgraph"
 import { type AgentMiddleware, createMiddleware } from "langchain"
 import { z } from "zod"
+import {
+  type ModelRetryPolicy,
+  resolveModelRetryPolicy,
+  retryCapacityErrors,
+} from "./model-call-retry.js"
 import {
   buildSummarizationHook,
   type ResolvedSummarizationConfig,
@@ -33,6 +38,8 @@ export interface B4AgentMiddlewareOptions {
   readonly summarization?: ResolvedSummarizationConfig
   /** Tools that end the run on a successful result. */
   readonly returnDirectToolNames: ReadonlySet<string>
+  /** The route's `retry`, resolved; defaults to 3 attempts and a 1s base delay. */
+  readonly retry?: ModelRetryPolicy
 }
 
 /**
@@ -62,6 +69,7 @@ function modelAndToolMiddleware(options: B4AgentMiddlewareOptions): AgentMiddlew
   const readable: Record<string, z.ZodTypeAny> = { [LLM_INPUT_MESSAGES]: z.any().optional() }
   for (const name of options.stateFieldNames) readable[name] = z.any().optional()
   const composesPrompt = options.promptFragments.length > 0
+  const retry = options.retry ?? resolveModelRetryPolicy(undefined)
 
   return createMiddleware({
     name: "B4ModelAndTools",
@@ -70,7 +78,6 @@ function modelAndToolMiddleware(options: B4AgentMiddlewareOptions): AgentMiddlew
       const state = request.state as Record<string, unknown>
       const view = state[LLM_INPUT_MESSAGES]
       const messages = Array.isArray(view) ? (view as BaseMessage[]) : request.messages
-      if (!composesPrompt && messages === request.messages) return handler(request)
       const systemMessage = composesPrompt
         ? new SystemMessage(
             await composeSystemPrompt(options.systemPrompt, options.promptFragments, {
@@ -79,7 +86,17 @@ function modelAndToolMiddleware(options: B4AgentMiddlewareOptions): AgentMiddlew
             }),
           )
         : request.systemMessage
-      return handler({ ...request, messages, systemMessage })
+      const next =
+        !composesPrompt && messages === request.messages
+          ? request
+          : { ...request, messages, systemMessage }
+      // Only this model call is sent again, never the tools around it, and
+      // only for a capacity 429, which fails before the first token streams.
+      return retryCapacityErrors(
+        () => handler(next),
+        retry,
+        request.runtime.signal ? { signal: request.runtime.signal } : {},
+      )
     },
     wrapToolCall: async (request, handler) => {
       try {
```

- [ ] **Step 4: Resolve the policy in `materializeAgent`, and remove the run-level retry**

Apply:

```diff
diff --git a/packages/langchain/src/agent-adapter.ts b/packages/langchain/src/agent-adapter.ts
index 21176fe5f..354b2c07b 100644
--- a/packages/langchain/src/agent-adapter.ts
+++ b/packages/langchain/src/agent-adapter.ts
@@ -9,8 +9,9 @@ import { type CanonicalJsonStream, createCanonicalJsonStream } from "./canonical
 import { createChatModel, type JsonSchemaResponseFormat } from "./chat-model-factory.js"
 import { trackCheckpointWrites } from "./checkpoint-writes.js"
 import { readLogicalToolCallId } from "./logical-tool-call-id.js"
+import { providerMaxRetries, resolveModelRetryPolicy } from "./model-call-retry.js"
 import { resolveProvider } from "./model-provider-resolver.js"
-import { isRetryableError, withRetry } from "./retry.js"
+import { withRetry } from "./retry.js"
 import { materializeAgentStateSchema, type ResolvedStateField } from "./state-adapter.js"
 import { convertSubagentTaskToLangChain, type SubagentResolver } from "./subagent-tool-bridge.js"
 import type { ResolvedSummarizationConfig } from "./summarization/index.js"
@@ -159,9 +160,11 @@ async function materializeAgent(
     model: descriptor.model,
     ...(descriptor.provider !== undefined ? { provider: descriptor.provider } : {}),
   })
+  const retry = resolveModelRetryPolicy(descriptor.retry)
   const llm = await createChatModel({
     model: descriptor.model,
     provider,
+    maxRetries: providerMaxRetries(retry),
     ...(descriptor.reasoning ? { reasoning: descriptor.reasoning } : {}),
     ...(opts.responseFormat ? { responseFormat: opts.responseFormat } : {}),
   })
@@ -185,6 +188,7 @@ async function materializeAgent(
     returnDirectToolNames: new Set(
       tools.filter((tool) => tool.returnDirect === true).map((tool) => tool.name),
     ),
+    retry,
   })
 
   const agentOptions: Record<string, unknown> = {
@@ -1214,10 +1218,11 @@ export async function* streamAgent(options: AgentOptions): AsyncGenerator<AgentS
         ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
       },
     )
-    const retryConfig = options.entry.retry
+    // `retry` is applied per model call inside the graph (the model's
+    // `maxRetries` and B4's capacity-429 middleware), never to the whole run.
     const runnableInput = isCommandInput ? options.input : { messages }
     const checkpointWrites = trackCheckpointWrites(options.checkpointer)
-    yield* streamFromRunnable(materializedAgent, runnableInput, config, retryConfig, () =>
+    yield* streamFromRunnable(materializedAgent, runnableInput, config, undefined, () =>
       checkpointWrites.settled(),
     )
     return
@@ -1331,93 +1336,74 @@ async function* streamFromRunnable(
 
   // Process a single streamEvents iterator: yield AgentStreamChunks and
   // return whatever __interrupt__ entries appeared in the graph's final
-  // on_chain_end output.
+  // on_chain_end output. A failure ends the run: the run is never started
+  // again, because retry belongs to each model call (see `model-call-retry`),
+  // and a restarted run would re-run tools and re-stream output.
   async function* processEventStream(
     invocationInput: unknown,
     invocationConfig: Record<string, unknown>,
-    allowRetryOnError: boolean,
   ): AsyncGenerator<AgentStreamChunk, PassResult, void> {
     let finalOutput: unknown
     let capturedInterrupts: readonly RawInterruptEntry[] = []
-    let emittedInterruptIds = new Set<string>()
-    let hasYielded = false
-
-    const maxStreamAttempts = allowRetryOnError ? (retryConfig?.maxAttempts ?? 3) : 1
-
-    for (let attempt = 0; attempt < maxStreamAttempts; attempt++) {
-      hasYielded = false
-      finalOutput = undefined
-      capturedInterrupts = []
-      emittedInterruptIds = new Set()
-      const subagentToolRuns: SubagentToolRunContexts = { contextsByToolRunId: new Map() }
-      const rootTools: RootToolProjectionState = {
-        textModelRunIds: new Set(),
-        announcedToolCallIds: new Set(),
-        heldRootToolStarts: new Map(),
-        pendingRootToolErrors: [],
-        streamingArgs: new Map(),
-      }
+    const emittedInterruptIds = new Set<string>()
+    const subagentToolRuns: SubagentToolRunContexts = { contextsByToolRunId: new Map() }
+    const rootTools: RootToolProjectionState = {
+      textModelRunIds: new Set(),
+      announcedToolCallIds: new Set(),
+      heldRootToolStarts: new Map(),
+      pendingRootToolErrors: [],
+      streamingArgs: new Map(),
+    }
 
-      try {
-        for await (const event of streamEventsFn(invocationInput, {
-          ...invocationConfig,
-          version: "v2",
-        })) {
-          const projection = classifyStreamEvent(event, subagentToolRuns, rootTools)
-          if (projection.capturesFinalOutput) {
-            finalOutput = projection.finalOutput
-          }
-          for (const chunk of projection.chunks) {
-            hasYielded = true
-            yield chunk
-          }
-          if (projection.interrupts.length > 0) {
-            capturedInterrupts = projection.interrupts
-          }
-          for (const entry of projection.interrupts) {
-            if (entry.id && emittedInterruptIds.has(entry.id)) continue
-            if (entry.id) emittedInterruptIds.add(entry.id)
-            hasYielded = true
-            if (readRuntimeEnv("B4_DEBUG_INTERRUPTS") === "1") {
-              if (!isRecord(entry.value) || typeof entry.value.interruptId !== "string") {
-                console.warn(
-                  "[b4] interrupt entry.value missing interruptId — capability bug:",
-                  JSON.stringify(entry).slice(0, 300),
-                )
-              }
-            }
-            yield {
-              type: "interrupt",
-              data: projectInterruptValue(entry, projection.child),
+    try {
+      for await (const event of streamEventsFn(invocationInput, {
+        ...invocationConfig,
+        version: "v2",
+      })) {
+        const projection = classifyStreamEvent(event, subagentToolRuns, rootTools)
+        if (projection.capturesFinalOutput) {
+          finalOutput = projection.finalOutput
+        }
+        for (const chunk of projection.chunks) {
+          yield chunk
+        }
+        if (projection.interrupts.length > 0) {
+          capturedInterrupts = projection.interrupts
+        }
+        for (const entry of projection.interrupts) {
+          if (entry.id && emittedInterruptIds.has(entry.id)) continue
+          if (entry.id) emittedInterruptIds.add(entry.id)
+          if (readRuntimeEnv("B4_DEBUG_INTERRUPTS") === "1") {
+            if (!isRecord(entry.value) || typeof entry.value.interruptId !== "string") {
+              console.warn(
+                "[b4] interrupt entry.value missing interruptId — capability bug:",
+                JSON.stringify(entry).slice(0, 300),
+              )
             }
           }
-        }
-        // Stream completed successfully
-        return { finalOutput, interrupts: capturedInterrupts }
-      } catch (error) {
-        const err = error instanceof Error ? error : new Error(String(error))
-        if (hasYielded || !isRetryableError(error) || attempt === maxStreamAttempts - 1) {
-          // Not on cancellation: a cancelled turn's settle already waits for
-          // the abandoned route to unwind, and the writes chained behind a
-          // still-running tool would hold the turn open until it finishes.
-          if (!(invocationConfig.signal as AbortSignal | undefined)?.aborted) {
-            await drainWrites?.()
+          yield {
+            type: "interrupt",
+            data: projectInterruptValue(entry, projection.child),
           }
-          throw err
         }
-        const delay = Math.min(1000 * 2 ** attempt + Math.random() * 500, 10_000)
-        await new Promise((resolve) => setTimeout(resolve, delay))
       }
+      return { finalOutput, interrupts: capturedInterrupts }
+    } catch (error) {
+      // Not on cancellation: a cancelled turn's settle already waits for
+      // the abandoned route to unwind, and the writes chained behind a
+      // still-running tool would hold the turn open until it finishes.
+      if (!(invocationConfig.signal as AbortSignal | undefined)?.aborted) {
+        await drainWrites?.()
+      }
+      throw error instanceof Error ? error : new Error(String(error))
     }
-    // Unreachable: the loop either returns or throws.
-    return { finalOutput, interrupts: capturedInterrupts }
   }
 
   // Invoke the stream. After yielding any interrupt envelopes, return cleanly.
   // Resume is state-based: the caller posts to /threads/:id/resume with the
   // decision, which opens a new SSE stream with Command({resume: decision}) as
   // input. The adapter does NOT park here waiting for an in-process promise.
-  const pass = yield* processEventStream(input, config, /* allowRetryOnError */ true)
+  const pass = yield* processEventStream(input, config)
 
   yield { type: "done", data: pass.finalOutput }
 }
```

The whole `processEventStream` after the change, for reference (the diff above produces exactly this):

```ts
  async function* processEventStream(
    invocationInput: unknown,
    invocationConfig: Record<string, unknown>,
  ): AsyncGenerator<AgentStreamChunk, PassResult, void> {
    let finalOutput: unknown
    let capturedInterrupts: readonly RawInterruptEntry[] = []
    const emittedInterruptIds = new Set<string>()
    const subagentToolRuns: SubagentToolRunContexts = { contextsByToolRunId: new Map() }
    const rootTools: RootToolProjectionState = {
      textModelRunIds: new Set(),
      announcedToolCallIds: new Set(),
      heldRootToolStarts: new Map(),
      pendingRootToolErrors: [],
      streamingArgs: new Map(),
    }

    try {
      for await (const event of streamEventsFn(invocationInput, {
        ...invocationConfig,
        version: "v2",
      })) {
        const projection = classifyStreamEvent(event, subagentToolRuns, rootTools)
        if (projection.capturesFinalOutput) {
          finalOutput = projection.finalOutput
        }
        for (const chunk of projection.chunks) {
          yield chunk
        }
        if (projection.interrupts.length > 0) {
          capturedInterrupts = projection.interrupts
        }
        for (const entry of projection.interrupts) {
          if (entry.id && emittedInterruptIds.has(entry.id)) continue
          if (entry.id) emittedInterruptIds.add(entry.id)
          if (readRuntimeEnv("B4_DEBUG_INTERRUPTS") === "1") {
            if (!isRecord(entry.value) || typeof entry.value.interruptId !== "string") {
              console.warn(
                "[b4] interrupt entry.value missing interruptId — capability bug:",
                JSON.stringify(entry).slice(0, 300),
              )
            }
          }
          yield {
            type: "interrupt",
            data: projectInterruptValue(entry, projection.child),
          }
        }
      }
      return { finalOutput, interrupts: capturedInterrupts }
    } catch (error) {
      // Not on cancellation: a cancelled turn's settle already waits for
      // the abandoned route to unwind, and the writes chained behind a
      // still-running tool would hold the turn open until it finishes.
      if (!(invocationConfig.signal as AbortSignal | undefined)?.aborted) {
        await drainWrites?.()
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }
```

- [ ] **Step 5: Run the new tests green**

Run: `pnpm --filter @b4run/langchain exec vitest --run --config vitest.config.ts test/agent-retry-per-model-call.test.ts`
Expected: PASS, 12 tests. Run it three times; it's deterministic (fake clock, pinned jitter).

- [ ] **Step 6: Run the package suite and fix the four constructor-options assertions**

Run: `pnpm --filter @b4run/langchain test`
Expected: 4 failures, each `expected { model: '…', maxRetries: 2 } to deeply equal { model: '…' }`, in `agent-adapter.test.ts` (3) and `agent-descriptor-integration.test.ts` (1). They build through `agent()` without `retry`, so the default now reaches the constructor. Apply:

```diff
diff --git a/packages/langchain/test/agent-adapter.test.ts b/packages/langchain/test/agent-adapter.test.ts
index 75b318fac..49db476b9 100644
--- a/packages/langchain/test/agent-adapter.test.ts
+++ b/packages/langchain/test/agent-adapter.test.ts
@@ -822,6 +822,8 @@ describe("executeAgent with B4Agent descriptors", () => {
     expect((result as AIMessage).content).toBe("OpenAI!")
     expect((openAIModel as { options: Record<string, unknown> }).options).toEqual({
       model: "gpt-4o-mini",
+      // No `retry` on the descriptor: 3 attempts per model call.
+      maxRetries: 2,
     })
   })
 
@@ -876,6 +878,8 @@ describe("executeAgent with B4Agent descriptors", () => {
     expect((result as AIMessage).content).toBe("Groq!")
     expect((groqModel as { options: Record<string, unknown> }).options).toEqual({
       model: "gpt-4o-mini",
+      // No `retry` on the descriptor: 3 attempts per model call.
+      maxRetries: 2,
     })
   })
 
@@ -962,6 +966,8 @@ describe("executeAgent with B4Agent descriptors", () => {
     expect((result as AIMessage).content).toBe("Anthropic!")
     expect((anthropicModel as { options: Record<string, unknown> }).options).toEqual({
       model: "claude-sonnet-4-5",
+      // No `retry` on the descriptor: 3 attempts per model call.
+      maxRetries: 2,
     })
   })
 
diff --git a/packages/langchain/test/agent-descriptor-integration.test.ts b/packages/langchain/test/agent-descriptor-integration.test.ts
index a1efe315a..0639ebef6 100644
--- a/packages/langchain/test/agent-descriptor-integration.test.ts
+++ b/packages/langchain/test/agent-descriptor-integration.test.ts
@@ -47,6 +47,8 @@ describe("agent() descriptor integration", () => {
     expect((result as AIMessage).content).toBe("Descriptor!")
     expect((openAIModel as { options: Record<string, unknown> }).options).toEqual({
       model: "gpt-4o-mini",
+      // No `retry` on the descriptor: 3 attempts per model call.
+      maxRetries: 2,
     })
   })
 
```

Run: `pnpm --filter @b4run/langchain test`
Expected: PASS, 48 files, 336 tests.

- [ ] **Step 7: Lint and typecheck the package**

Run: `pnpm --filter @b4run/langchain lint`
Expected: exit 0. The 10 warnings it prints are pre-existing, in `test/agent-state-update.test.ts` and `test/openai-embedder.test.ts`.

Run: `pnpm --filter @b4run/langchain typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git status --short
git add packages/langchain/src/agent-adapter.ts packages/langchain/src/agent-middleware.ts packages/langchain/test/agent-retry-per-model-call.test.ts packages/langchain/test/agent-adapter.test.ts packages/langchain/test/agent-descriptor-integration.test.ts
git commit -m "fix(langchain): agent retry applies per model call, never to the whole run

maxAttempts becomes the chat model's maxRetries; B4's middleware sends a
model call again after a capacity 429 with baseDelay backoff; the
run-level restart in processEventStream is gone.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `RetryConfig` JSDoc and the changeset

**Files:**
- Modify: `packages/sdk/src/agent.ts`
- Create: `.changeset/agent-retry-per-model-call.md`

- [ ] **Step 1: Document `RetryConfig`**

Apply:

```diff
diff --git a/packages/sdk/src/agent.ts b/packages/sdk/src/agent.ts
index 40be33798..5c93711f4 100644
--- a/packages/sdk/src/agent.ts
+++ b/packages/sdk/src/agent.ts
@@ -5,8 +5,25 @@ const B4_AGENT: unique symbol = Symbol.for("b4.agent") as unknown as typeof B4_A
 
 declare const brand: unique symbol
 
+/**
+ * How an agent route retries a failed model call. Each model call in the
+ * tool loop retries on its own; B4.run never restarts the run, so tools don't
+ * run twice and streamed tokens are never sent again. See docs/retry.
+ */
 export interface RetryConfig {
+  /**
+   * Attempts per model call, counting the first. Default `3`; `1` sends each
+   * call once. Becomes the chat model's `maxRetries` (`maxAttempts - 1`),
+   * which covers server errors, network errors and rate limits with a short
+   * `Retry-After`, and also caps B4.run's retries of a capacity rate limit.
+   */
   readonly maxAttempts?: number
+  /**
+   * Milliseconds before the first retry of a capacity rate limit (a 429 with
+   * no `Retry-After`, or one over 60 seconds); doubles each retry, plus up to
+   * 500ms of jitter, capped at 10 seconds. Default `1000`. LangChain's own
+   * backoff for other errors is fixed and doesn't read it.
+   */
   readonly baseDelay?: number
 }
 
```

The `api-contract` block for `RetryConfig` in `apps/web/content/docs/api/sdk.mdx` compares declarations without comments, so it still matches (checked by `pnpm --dir apps/web test` and `node scripts/check-docs.mjs` in Task 6).

- [ ] **Step 2: Write the changeset**

`.changeset/agent-retry-per-model-call.md` (patch: the packages are a fixed group, and `minor` on 0.x would take every package to 1.0.0):

```md
---
"@b4run/langchain": patch
"@b4run/sdk": patch
---

`agent({ retry })` now applies to each model call instead of the whole run. `maxAttempts` (default 3) becomes the chat model's `maxRetries` (`maxAttempts - 1`), so LangChain retries each model request, including later calls in a tool loop, up to that many times; `maxAttempts: 1` now fails fast. Before, LangChain's default of 6 retries applied whatever `retry` said, and B4.run restarted the whole run on top of it when nothing had streamed yet.

B4.run also sends a model call again after a capacity rate limit that LangChain hands back without retrying (a `429` with no `Retry-After`, or one over 60 seconds), waiting `min(baseDelay * 2^n + jitter, 10s)`, or the `Retry-After` capped at 10 seconds. This is the only place `baseDelay` applies; it was previously never read on an agent route. A quota `429` isn't retried, an abort during the wait stops it, and a response that fails after part of it streamed isn't retried, so no token is sent twice. The run itself is never restarted, so tools never run twice.

An invalid `retry` (a `maxAttempts` below 1 or not a whole number, a negative `baseDelay`) now fails the route when it first runs. A route that exports its own LangChain runnable keeps its model's own `maxRetries`, and is no longer restarted on a failure either.
```

- [ ] **Step 3: Check**

Run: `pnpm --filter @b4run/sdk test && pnpm --filter @b4run/sdk typecheck && pnpm --filter @b4run/sdk lint`
Expected: exit 0 (14 files, 115 tests).

- [ ] **Step 4: Commit**

```bash
git status --short
git add packages/sdk/src/agent.ts .changeset/agent-retry-per-model-call.md
git commit -m "docs(sdk): RetryConfig describes per-model-call retry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The docs and the homepage tile

**Files:**
- Modify: `apps/web/content/docs/retry.mdx`
- Modify: `apps/web/content/docs/recipes/retry-flaky-tools.mdx`, `apps/web/content/docs/recipes/stream-output.mdx`, `apps/web/content/docs/api/sdk.mdx`, `apps/web/content/templates/AGENTS.md`
- Modify: `apps/web/app/components/homepage/checklist/checklist.ts`, `apps/web/app/components/homepage/checklist/checklist.test.ts`

- [ ] **Step 1: Update the checklist test first (red)**

The old test pinned the run-level retry's source text. Apply the test half:

```diff
diff --git a/apps/web/app/components/homepage/checklist/checklist.test.ts b/apps/web/app/components/homepage/checklist/checklist.test.ts
index 7198772d0..d476be821 100644
--- a/apps/web/app/components/homepage/checklist/checklist.test.ts
+++ b/apps/web/app/components/homepage/checklist/checklist.test.ts
@@ -108,26 +108,24 @@ describe("the checklist shows real code", () => {
     )
   })
 
-  it("retries a failed model call only before anything has streamed", () => {
-    const retry = read("packages/langchain/src/retry.ts")
-    const classify = retry.slice(
-      retry.indexOf("export function isRetryableError"),
-      retry.indexOf("export async function withRetry"),
-    )
-    for (const needle of ["429", "rate limit", "503", "econnreset"]) {
-      expect(classify).toContain(`message.includes("${needle}")`)
-    }
+  it("retries each model call, never the whole run", () => {
+    // maxAttempts becomes the chat model's own maxRetries...
     const adapter = read("packages/langchain/src/agent-adapter.ts")
-    expect(adapter).toContain("retryConfig?.maxAttempts ?? 3")
-    expect(adapter).toContain(
-      "if (hasYielded || !isRetryableError(error) || attempt === maxStreamAttempts - 1) {",
-    )
-    // The streaming path's backoff is fixed, so the excerpt sets no baseDelay.
-    expect(adapter).toContain("const delay = Math.min(1000 * 2 ** attempt")
+    expect(adapter).toContain("maxRetries: providerMaxRetries(retry),")
+    expect(adapter).not.toContain("isRetryableError")
+    const retry = read("packages/langchain/src/model-call-retry.ts")
+    expect(retry).toContain("return policy.maxAttempts - 1")
+    // ...and B4 sends one model call again after a capacity 429, recognised
+    // by LangChain's stamps, before any token of that call has streamed.
+    expect(retry).toContain("getRetryable(error) === true")
+    expect(retry).toContain('rateLimitType === "capacity"')
+    const middleware = read("packages/langchain/src/agent-middleware.ts")
+    expect(middleware).toContain("() => handler(next),\n        retry,")
     const retries = itemOf("retries")
-    expect(retries.code).not.toContain("baseDelay")
-    expect(read(`${CHECKLIST_FIXTURES}src/app/support/index.ts`)).not.toContain("baseDelay")
-    expect(retries.handledBy).toContain("before anything has streamed")
+    expect(retries.code).toBe("retry: { maxAttempts: 5 },")
+    expect(read(`${CHECKLIST_FIXTURES}src/app/support/index.ts`)).toContain(retries.code)
+    expect(retries.handledBy).toContain("Each model call")
+    expect(retries.handledBy).toContain("no streamed token is sent twice")
   })
 
   it("moves the three durable stores to Postgres, which the defaults keep on local disk", () => {
```

Run: `pnpm --dir apps/web exec vitest --run app/components/homepage/checklist/checklist.test.ts`
Expected: FAIL only "retries each model call, never the whole run", on `expected '…before anything has streamed…' to contain 'Each model call'`. (The source pins already pass after Task 3.)

- [ ] **Step 2: Change the tile copy (green)**

```diff
diff --git a/apps/web/app/components/homepage/checklist/checklist.ts b/apps/web/app/components/homepage/checklist/checklist.ts
index 2e87fd9c5..b192bcadf 100644
--- a/apps/web/app/components/homepage/checklist/checklist.ts
+++ b/apps/web/app/components/homepage/checklist/checklist.ts
@@ -125,7 +125,7 @@ export const checklist: readonly ChecklistItem[] = [
     title: "Model retries",
     chore: "Retry the model after a rate limit or a server error.",
     handledBy:
-      "A model call that fails with a rate limit, a server error or a network error, before anything has streamed, retries with backoff.",
+      "Each model call retries a rate limit, a server error or a network error with backoff, and no streamed token is sent twice.",
     file: "src/app/support/index.ts",
     code: "retry: { maxAttempts: 5 },",
     origin: `${CHECKLIST_FIXTURES}src/app/support/index.ts`,
```

Run the same command. Expected: PASS, 17 tests.

- [ ] **Step 3: Rewrite the retry page**

Replace `apps/web/content/docs/retry.mdx` with:

````mdx
# Retry

The `retry` option on `agent()` sets how many times each model call is tried when it fails for a temporary reason: a server error, a network error or a rate limit. Every model call in the tool loop retries on its own. B4.run never restarts the run, so tools never run twice and the client never sees a token twice.

## Configuring retry

Set `retry` in `agent()`:

```ts title="src/app/(public)/research/index.ts"
import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  retry: { maxAttempts: 5, baseDelay: 500 },
  systemPrompt: "You are a helpful assistant.",
})
```

| Field | Default | Notes |
|---|---|---|
| `maxAttempts` | `3` | Attempts per model call, counting the first. `1` sends each call once. |
| `baseDelay` | `1000` (ms) | Wait before the first retry of a capacity rate limit (see below). It doubles each retry. |

If you omit `retry`, each model call gets 3 attempts. `maxAttempts` must be a whole number of at least 1 and `baseDelay` a number of milliseconds of at least 0; any other value fails the route when it first runs.

## What's retried

Two layers retry a model call, and both read `maxAttempts`.

**LangChain retries the request.** B4.run builds the route's chat model with `maxRetries: maxAttempts - 1`, and LangChain re-sends a failed request up to that many times:

- **Server and network errors:** `5xx` responses, dropped connections and timeouts.
- **Rate limits with a short wait:** a `429` whose `Retry-After` is 60 seconds or less.

**B4.run retries a capacity rate limit.** LangChain hands back, without retrying, a `429` with no `Retry-After` or with one over 60 seconds, and marks it retryable. B4.run sends that model call again, up to `maxAttempts` attempts of the call in all.

**These fail right away:**

- A quota `429` (for example OpenAI's `insufficient_quota`). Waiting doesn't bring a quota back.
- An invalid API key, a model that doesn't exist, or a malformed request. LangChain doesn't retry `400` to `407`, `409` or `413`.
- An aborted run.

When a model call runs out of attempts, the run fails with that call's error.

## Backoff

Each layer waits in its own way. LangChain waits about 1 second before its first retry and doubles that each time, with random jitter, or waits out the `Retry-After` when that's longer. `baseDelay` doesn't change LangChain's waits.

Before B4.run sends a call again after a capacity rate limit, the wait before retry `n` (counting from zero) is:

```
delay = min(baseDelay * 2^n + jitter, 10s)
jitter = random(0, 500ms)
```

When the `429` carries a `Retry-After`, B4.run waits that long instead, but never more than 10 seconds.

With the defaults (3 attempts, 1s base), a model call that keeps hitting capacity limits is sent three times:

| Attempt | Wait before this attempt |
|---|---|
| 1 (initial) | 0 |
| 2 | ~1000–1500 ms |
| 3 | ~2000–2500 ms |

## Streaming behavior

Every retry happens before the model's response starts. A failed request never produced a token, so sending it again can't repeat anything the client has seen.

A response that fails partway through, after some of it has streamed, isn't retried. The client already has the first part, and resending the call would show it twice. The error comes through the stream. If partial output is no use to you, retry the run from your client.

Each model call in a tool loop is retried on its own. If the third model call of a run hits a rate limit, only that call is sent again: the earlier model calls and the tools they called don't run again.

## Abort signals

Three things abort a run: an AG-UI client disconnecting, an Agent Protocol cancel (`POST /threads/:id/cancel`), and server shutdown. An Agent Protocol client disconnecting leaves the run going, so the thread can pick it up again.

An abort during B4.run's wait before a retry ends the wait at once, and the call isn't sent again. The abort signal also reaches the agent and its tools as `ctx.signal`. Provider calls and tools have to listen to it for pending I/O to stop quickly.

## Per-route, not global

Each `agent()` sets its own retry policy, and a [subagent](/docs/subagents) uses its own `agent()`'s. There's no global setting:

```ts
// Critical billing route: fail fast on transient errors
export default agent({
  model: "gpt-5-mini",
  retry: { maxAttempts: 1 },
  systemPrompt: "...",
})
```

```ts
// Best-effort summarization route: patient retry
export default agent({
  model: "gpt-5-mini",
  retry: { maxAttempts: 5, baseDelay: 2000 },
  systemPrompt: "...",
})
```

## Limits

- **Your own model instance keeps its own settings.** `retry` applies to the chat model B4.run builds from `agent()`. A route that exports a LangChain runnable you built, with a model you constructed yourself, uses that model's `maxRetries` (LangChain's default is 6), and B4.run doesn't retry it.
- **Ollama isn't retried.** `ChatOllama` sends its chat requests without LangChain's retry layer, so `maxAttempts` has no effect on the `ollama` provider.
- **Tools aren't retried.** `retry` covers model calls. For a tool, write the loop yourself; see [Retry Transient Model Calls](/docs/recipes/retry-flaky-tools).

## Related

<RelatedCards items={[
  { href: "/docs/routes", title: "Routes", subtitle: "agent() descriptor and the four route kinds" },
  { href: "/docs/tools", title: "Tools", subtitle: "tool error handling and the ctx.signal contract" },
  { href: "/docs/deployment", title: "Deployment Options", subtitle: "how retry composes with b4 build output" },
  { href: "/docs/recipes/retry-flaky-tools", title: "Retry Transient Model Calls", subtitle: "recipe applying agent retry policies per route" },
]} />
````

Every claim is checked against code: the defaults and validation (`resolveModelRetryPolicy`), the `maxRetries` mapping (`providerMaxRetries`), what LangChain retries and doesn't (`defaultFailedAttemptHandler`, `STATUS_NO_RETRY`, `RETRY_AFTER_AUTO_RETRY_THRESHOLD_MS = 60000` in `@langchain/core/dist/utils/async_caller.js`), LangChain's backoff (p-retry `minTimeout` 1000, `factor` 2, `randomize`), B4's formula and cap (`capacityRetryDelay`), streaming (the capacity error precedes the first token; no run restart), the abort (`systemRetryClock.sleep`), subagents (materialized from their own descriptor), and Ollama (Risk 5).

- [ ] **Step 4: The recipe, the stream-output bullet, the SDK field table and the AGENTS.md template**

```diff
diff --git a/apps/web/content/docs/recipes/retry-flaky-tools.mdx b/apps/web/content/docs/recipes/retry-flaky-tools.mdx
index acbbe8cc8..a706bcd37 100644
--- a/apps/web/content/docs/recipes/retry-flaky-tools.mdx
+++ b/apps/web/content/docs/recipes/retry-flaky-tools.mdx
@@ -51,16 +51,17 @@ export default agent({
 ## Notes
 
 - **Retry is per route.** Each `agent()` declares its own `retry`, so different routes can have different policies.
-- **Only transient model/provider errors retry.** Rate limits (`429`), server errors (`500`/`502`/`503`), network timeouts, and OpenAI `overloaded`/`server_error` are retried. Invalid API keys, missing models, and schema validation errors fail immediately.
-- **Backoff is exponential with jitter, capped at 10s.** For non-stream fallback, `delay = min(baseDelay * 2^n + jitter, 10s)`. A lower `baseDelay` makes the first retry faster.
+- **Each model call retries on its own.** `maxAttempts` is the attempts per model call, not per run. A failure in a later model call of the tool loop sends only that call again; tools that already ran don't run again.
+- **Only temporary failures retry.** Server errors (`5xx`), network errors, timeouts and rate limits are retried. A quota `429`, an invalid API key, a missing model and a malformed request fail immediately.
+- **`baseDelay` paces capacity rate limits.** A `429` with no `Retry-After`, or one over 60 seconds, waits `min(baseDelay * 2^n + jitter, 10s)` before the next attempt. LangChain paces the other retries with its own backoff, starting around 1 second.
 - **`maxAttempts: 1` disables retry.** If you omit `retry`, the default is `3`.
-- **Streaming routes only retry before the first event.** Once an event has streamed, the response is committed.
+- **A response that fails partway isn't retried.** Retries happen before the model's response starts, so no token is ever sent twice. Once part of a response has streamed, an error comes through the stream.
 - **Tool retry lives in the tool.** Agent retry covers model and provider calls. For a tool, write the loop yourself, as `fetch-doc.ts` does above.
 
 ## Related
 
 <RelatedCards items={[
-  { href: "/docs/retry", title: "Retry", subtitle: "the full backoff formula and the list of retryable errors" },
+  { href: "/docs/retry", title: "Retry", subtitle: "what each retry layer covers, and the backoff" },
   { href: "/docs/routes", title: "Routes", subtitle: "agent() and the other route kinds" },
   { href: "/docs/recipes/stream-output", title: "Stream Output", subtitle: "the streaming retry caveat in context" },
   { href: "/docs/api/sdk#agent-and-agentconfig", title: "SDK Reference", subtitle: "agent() and the RetryConfig type" },
diff --git a/apps/web/content/docs/recipes/stream-output.mdx b/apps/web/content/docs/recipes/stream-output.mdx
index e0c3ed869..131158a3e 100644
--- a/apps/web/content/docs/recipes/stream-output.mdx
+++ b/apps/web/content/docs/recipes/stream-output.mdx
@@ -98,7 +98,7 @@ Every event frame is `event: <type>\ndata: <json>\n\n`. Parse the `event:` line
 - **The response is `text/event-stream`.** Parse the `event:` and `data:` lines in each frame, or use a client like `eventsource-parser`.
 - **Heartbeats are comments.** A `: ping` heartbeat has no `event:` or `data:` line, so clients skip it.
 - **Use `/threads/:id/runs/wait` when you don't need progress.** It returns one JSON result, which is less to parse. Pick `runs/stream` when partial output is useful: long agent reasoning, token-by-token text, intermediate workflow states, [planning](/docs/planning) updates, or [subagent](/docs/subagents) activity.
-- **Retry stops at the first event.** Retry is available only before the first stream event. Any emitted token or event commits the response. See [Retry](/docs/retry).
+- **Retry never repeats a token.** Each model call is retried only before its response starts. A response that fails after part of it has streamed isn't retried; the error comes through the stream. See [Retry](/docs/retry).
 
 ## Related
 
diff --git a/apps/web/content/docs/api/sdk.mdx b/apps/web/content/docs/api/sdk.mdx
index 02420ff82..bc6f790af 100644
--- a/apps/web/content/docs/api/sdk.mdx
+++ b/apps/web/content/docs/api/sdk.mdx
@@ -226,8 +226,8 @@ export interface RetryConfig {
 **Fields: `@b4run/sdk#.:RetryConfig`**
 | Field | Type | Required | Description |
 |---|---|---|---|
-| `readonly maxAttempts` | `number` | no | Cap attempts for a model call. |
-| `readonly baseDelay` | `number` | no | Set the base retry delay. |
+| `readonly maxAttempts` | `number` | no | Set attempts per model call; defaults to `3`. |
+| `readonly baseDelay` | `number` | no | Set the first capacity rate-limit backoff; defaults to `1000`. |
 
 ```ts api-contract="@b4run/sdk#.:isB4Agent"
 export declare function isB4Agent(value: unknown): value is B4Agent
diff --git a/apps/web/content/templates/AGENTS.md b/apps/web/content/templates/AGENTS.md
index d8a30040c..7d2e78f7c 100644
--- a/apps/web/content/templates/AGENTS.md
+++ b/apps/web/content/templates/AGENTS.md
@@ -57,7 +57,7 @@ export default agent({
 
 - `model` is a `KnownModelId` (autocomplete for listed ids, plus any custom string).
 - `provider?: ModelProviderId` is optional. B4.run infers providers for known model families; set it explicitly to one of the supported built-in provider ids for aliases, ambiguous model names, local models, or provider-router model ids. Raw graph/chain routes can still instantiate any provider directly.
-- `retry?: { maxAttempts?: number, baseDelay?: number }`: applied per agent call.
+- `retry?: { maxAttempts?: number, baseDelay?: number }`: attempts and backoff for each model call.
 - Tools in the same route's `tools/` directory (and shared tools in `src/tools/`) are automatically wired into the generated agent graph at `b4 build` time.
 
 ## Tool Authoring
```

- [ ] **Step 5: Run the docs checks**

Run: `pnpm --dir apps/web exec vitest --run app/components/docs app/components/homepage/checklist app/llms-full.txt`
Expected: PASS. `search-index.test.ts` "finds body-text matches for jitter" needs "jitter" in the opening prose of the `## Backoff` section; if you reword that section, keep it in the first 320 characters.

Run: `node scripts/check-docs.mjs`
Expected: `Docs completeness check passed.` Don't run it while another package's tests are running: it reads `packages/cli/.tmp-eval-apps/*`, which the CLI tests create and delete (it failed with `ENOENT … .tmp-eval-apps/app-…/.b4/b4.generated.d.ts` once for that reason).

`seo/generate-lastmod.test.ts` is expected to be red until Task 7.

- [ ] **Step 6: Commit**

```bash
git status --short
git add apps/web/content/docs/retry.mdx apps/web/content/docs/recipes/retry-flaky-tools.mdx apps/web/content/docs/recipes/stream-output.mdx apps/web/content/docs/api/sdk.mdx apps/web/content/templates/AGENTS.md apps/web/app/components/homepage/checklist/checklist.ts apps/web/app/components/homepage/checklist/checklist.test.ts
git commit -m "docs(web): retry is per model call, with the two layers and their backoff

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Gates

**Files:** none new.

- [ ] **Step 1: Build**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 2: Package tests**

Run each; don't pipe them:

```bash
pnpm --filter @b4run/langchain test
pnpm --filter @b4run/sdk test
pnpm --filter @b4run/cli test
```

Expected: langchain 48 files / 336 tests; sdk 14 files / 115 tests; cli 186 files, 2309 passed, 4 skipped. The CLI suite runs the Docker-backed `vercel-target.test.ts`; if it times out waiting for a testcontainers port under load, rerun that file alone (`pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/vercel-target.test.ts`, 133 tests) before suspecting this change.

- [ ] **Step 3: Workspace lint and typecheck**

Run: `pnpm lint` then `pnpm typecheck`
Expected: exit 0 for both.

- [ ] **Step 4: Docs, build cache, changesets**

Run: `node scripts/check-docs.mjs`
Expected: `Docs completeness check passed.`

Run: `pnpm check:build-cache`
Expected: `Build cache config check passed (…)`.

Run: `BASE_REF=origin/main node scripts/check-changesets.mjs`
Expected: `Changesets check passed (… user-facing change(s), 1 changeset(s) added).`

- [ ] **Step 5: The web suite**

Run: `pnpm --dir apps/web test`
Expected: everything passes except the two lastmod cases in `app/seo/generate-lastmod.test.ts` ("covers every route the site renders…" and "exempts blog listings…"), which Task 7 fixes.

- [ ] **Step 6: The runtime harness lane**

Run: `env -u OPENAI_API_KEY pnpm verify:harness:runtime`
Expected: `status: passed`. No lane exercises model retries (Risk 9); this is the smoke check that real agent routes still run end to end on aimock without an API key.

- [ ] **Step 7: Commit any formatting fixes**

If `pnpm lint` reported formatting in files this plan touched, fix with the scoped Biome command from "Rules", then:

```bash
git status --short
git add <only the files Biome changed>
git commit -m "style(langchain): format

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Skip this if nothing changed.

---

### Task 7: Regenerate lastmod for the four changed routes

**Files:**
- Modify: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: Regenerate**

All content is committed (Task 5), so each changed route is dated by its newest commit.

```bash
pnpm --dir apps/web seo:lastmod
git diff --stat apps/web/app/seo/lastmod.generated.json
```

Expected: `1 file changed, 12 insertions(+), 12 deletions(-)`: `lastModified`, `sourceDigest` and `recordDigest` for exactly `/docs/api/sdk`, `/docs/recipes/retry-flaky-tools`, `/docs/recipes/stream-output` and `/docs/retry`. List the changed routes to be sure:

```bash
git show HEAD:apps/web/app/seo/lastmod.generated.json > <scratchpad>/lastmod-head.json
node -e '
const a = require(process.argv[1]).routes
const b = require(process.argv[2]).routes
for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
  if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) console.log(k)
' <scratchpad>/lastmod-head.json "$PWD/apps/web/app/seo/lastmod.generated.json"
```

Expected output, exactly:

```
/docs/api/sdk
/docs/recipes/retry-flaky-tools
/docs/recipes/stream-output
/docs/retry
```

If other routes appear, main's manifest was already stale for them: keep only these four by splicing them into `<scratchpad>/lastmod-head.json` and writing that back (as `2026-09-25-homepage-files-tour-pr3.md` Task 8 Step 7 does for `/`). If the manifest conflicts on a rebase, it's marked `-merge`; regenerate on top rather than hand-editing.

- [ ] **Step 2: Check**

Run: `pnpm --dir apps/web exec vitest --run app/seo`
Expected: PASS (86 tests), including "covers every route the site renders".

Run: `pnpm --dir apps/web test`
Expected: exit 0, 64 files, 979 passed, 1 skipped.

- [ ] **Step 3: Commit**

```bash
git status --short
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate lastmod for the retry docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Mutation checks

Run from `packages/langchain` after Task 3, one mutation at a time, restoring the file between runs (`git checkout -- <file>`). The test command:

```bash
pnpm exec vitest --run --config vitest.config.ts test/agent-retry-per-model-call.test.ts test/model-call-retry.test.ts test/chat-model-factory-max-retries.test.ts test/agent-adapter.test.ts
```

| Mutation | Tests that go red (verified) |
|---|---|
| Delete `maxRetries: providerMaxRetries(retry),` in `materializeAgent` | the three `retry … → maxRetries …` cases, and the three `agent-adapter.test.ts` constructor-options cases |
| Delete the `if (options.maxRetries !== undefined) …` line in `createChatModel` | 22: the above plus all 16 factory cases |
| In `wrapModelCall`, `return handler(next)` instead of `retryCapacityErrors(...)` | the four capacity-layer integration cases (tool loop, gives up, `retryAfterMs`, abort) |
| In `retryCapacityErrors`, drop `!isCapacityRateLimitError(error) \|\|` (retry everything) | quota 429 not retried; mid-stream failure (token emitted twice); failure before streaming; the three unit "does not retry" cases |
| `capacityRetryDelay` returns `delay` uncapped | `retryAfterMs` integration case; two unit cases |
| Ignore `retryAfterMs` (always use the backoff) | `retryAfterMs` integration case; one unit case |
| Pass `undefined` instead of `options.signal` to `clock.sleep` | the abort integration case (a zombie retry makes a second model call after the run ended) and the unit abort case |
| `1000 * 2 ** retryIndex` instead of `baseDelay * 2 ** retryIndex` | tool-loop gaps `[0, 200, 400]`, gives-up gap `[50]`, three unit cases |
| Put back a run-level restart around `processEventStream` (3 attempts, `isRetryableError`, only before the first chunk) | failure before streaming (`expected 2 to be 1`); raw runnable opened once; gives-up (an extra run) |

## Spec coverage checklist

| Spec requirement | Where |
|---|---|
| `maxAttempts` → the chat model's `maxRetries` (`maxAttempts - 1`, default 3 → 2) | Task 1 (`providerMaxRetries`), Task 2 (`createChatModel`), Task 3 (`materializeAgent`) |
| Test: `maxRetries` reaches the constructed model for each built-in provider, incl. `maxAttempts: 1` → 0 | Task 2 (all eight, fake class and the installed package's `AsyncCaller`); Task 3 (`retry %j → maxRetries %i`, through `agent()`) |
| An author-built model instance keeps its own `maxRetries` | `agent()` only accepts a model id; the only author-built models are raw runnables, which `createChatModel` never touches (Decision 1); docs "Limits" |
| Thin B4 layer in `wrapModelCall` for a retryable `RateLimitCapacityError`, `baseDelay` backoff or `retryAfterMs`, capped at 10s, same `maxAttempts` | Task 1 (`retryCapacityErrors`, `capacityRetryDelay`), Task 3 (middleware); budget semantics: Decision 3 |
| Test: capacity 429 on the second model call of a tool loop retried with `baseDelay` backoff; run completes | Task 3 "retries a capacity 429 on the second model call of a tool loop…" (gaps `[0, 200, 400]`, tool ran once) |
| Test: a quota 429 isn't retried | Task 1 unit, Task 3 integration |
| Test: `retryAfterMs` honoured and capped | Task 1 (`3000` honoured, `120000` → `10000`), Task 3 (gap `[10000]`) |
| Test: a mid-stream failure after tokens isn't retried and no token is emitted twice | Task 3 "a failure after tokens streamed…" |
| Test: the run-level retry is gone (no restart after or before streaming) | Task 3 "a failure before anything streamed…", "a raw runnable's stream is opened once…", plus the mid-stream case |
| Test: abort during a backoff wait stops the retry | Task 1 unit; Task 3 integration (no timers left, one model call) |
| Fake models throwing LangChain-shaped errors; fake clock; no network or keys | `helpers/langchain-errors.ts` (real `AsyncCaller`), `ScriptedStreamingModel`, fake timers, `vi.stubEnv` dummy keys |
| No message-string matching where stamps exist; `isRetryableError` stays exported | `isCapacityRateLimitError` uses `getRetryable` + `rateLimitType`; `retry.ts` and `index.ts` unchanged |
| Remove run-level retry for agent routes | Task 3 (`processEventStream`) |
| `exactOptionalPropertyTypes` | conditional spreads in the middleware and `createChatModel`; `pnpm typecheck` |
| Docs: what's retried and where, per call, no repeated tokens, mid-stream limit, `baseDelay`, quota, own model instance | Task 5 (`retry.mdx` and the four other pages) |
| `RetryConfig` JSDoc matches | Task 4 |
| Patch changeset | Task 4 |
| Regenerate lastmod | Task 7 (four routes) |
