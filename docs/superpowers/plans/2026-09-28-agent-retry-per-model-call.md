# Agent Retry Per Model Call Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-09-28).** This supersedes the first version of this plan (commit `37e1e2f5c`) and adds Brian's decisions on it:

- **Kept as planned:** raw-runnable agent routes lose the run-level retry too; the attempt budget is per layer (documented); an invalid `retry` throws on first use.
- **Changed, Retry-After:** a capacity 429 whose `retryAfterMs` is longer than the 10s cap is **not** retried. It surfaces at once and keeps its `retryAfterMs`. A headerless capacity 429 still retries with `baseDelay` backoff, and one whose `retryAfterMs` is within the cap waits exactly that.
- **Changed, other models:** the route's `retry` now reaches the summarization model, and the `b4 memory consolidate`/`reflect` model gets `maxRetries` too (see Decision 1 for what "the route's retry" means there).

**Goal:** Make `agent({ retry: { maxAttempts, baseDelay } })` do what it says, per model call:

1. `maxAttempts` becomes the chat model's `maxRetries` (`maxAttempts - 1`, default 3 → 2) for every built-in provider, so LangChain's own request retry obeys the knob and `maxAttempts: 1` fails fast. The route's summarization model gets the same `maxRetries`; the `b4 memory` distillation model gets the default (2).
2. A thin B4 layer in the agent middleware's `wrapModelCall` sends one model call again after a retryable capacity 429, within `maxAttempts`: with `min(baseDelay * 2^n + jitter, 10s)` when the error has no `retryAfterMs`, after exactly `retryAfterMs` when that is 10s or less, and not at all when it is longer (the error surfaces at once). This is the only place `baseDelay` applies.
3. The run-level retry in `processEventStream` is removed: a run is never restarted.
4. Docs, `RetryConfig` JSDoc, the homepage checklist tile and a patch changeset say exactly this.

**Architecture:**

- **One new module, `packages/langchain/src/model-call-retry.ts`.** Pure functions: `resolveModelRetryPolicy` (defaults and validation), `providerMaxRetries`, `modelMaxRetries(retry)` (the two composed; exported from `@b4run/langchain` for the CLI), `isCapacityRateLimitError` (LangChain's stamps, never message text), `capacityRetryDelay` (returns `undefined` for "don't retry"), and `retryCapacityErrors(call, policy, { signal, clock })`. The clock (`sleep`, `random`) is injectable for the unit tests; production uses `systemRetryClock` (an abortable `setTimeout`).
- **Construction.** `materializeAgent` (`agent-adapter.ts`) resolves the policy once, passes `maxRetries: providerMaxRetries(policy)` to `createChatModel` (new optional `maxRetries` option, set on the constructor options only when given), and passes the policy to `createB4AgentMiddleware`.
- **The capacity layer.** `B4ModelAndTools.wrapModelCall` wraps `handler(next)` in `retryCapacityErrors`, with `request.runtime.signal`. It re-runs only the model call; tools and earlier model calls never re-run. The fast path that returned `handler(request)` untouched now goes through the same wrapper.
- **The summarizer.** `SummarizeFn`'s arguments gain an optional `maxRetries`. `buildSummarizationHook(cfg, { maxRetries })` forwards it to every `summarize` call, `defaultSummarize` passes it to `createChatModel`, and B4's loop-entry middleware builds the hook with `providerMaxRetries(route policy)`. A custom `summarize` receives it and may ignore it.
- **`b4 memory consolidate` / `reflect`.** `createDistillModel` (`packages/cli/src/commands/memory.ts`) passes `maxRetries: modelMaxRetries(undefined)`, the default policy (Decision 1).
- **No run-level retry.** `processEventStream` loses its attempt loop and the `isRetryableError` text match. The `withRetry` fallback for a runnable with no `streamEvents` is unchanged (it never applies to an `agent()` route: a `createAgent` graph always has `streamEvents`).

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), `langchain` 1.5.12 `createAgent` middleware, `@langchain/core` 1.2.12 (`AsyncCaller`, `getRetryable` from `@langchain/core/errors`), `@langchain/openai` 1.5.13, Vitest 4 (fake timers for `setTimeout`, `clearTimeout` and `Date`), Biome, Next.js docs site (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-09-28-agent-retry-per-model-call-design.md`.

**Branch:** `blove/retry-streaming-backoff` (origin/main at `980ba8a37` plus the spec commit `63e95ab73`).

**How this plan was checked:** every code block below was written into the worktree on this branch and run, then removed. New files are reproduced verbatim; changes to existing files are the exact `git diff` of the verified tree against `63e95ab73`, applied with `git apply`. After the gates passed, the tree was reset to `63e95ab73` and rebuilt from this plan's own code blocks, task by task: each "run red" step failed with exactly the output quoted, each "run green" step passed, and the rebuilt tree matched the verified one file for file. These all passed on Node 24:

- `pnpm build`
- `pnpm --filter @b4run/langchain test`: 49 files, 351 tests
- `pnpm --filter @b4run/sdk test`: 14 files, 115 tests
- `pnpm --filter @b4run/cli test`: 187 files (2 skipped), 2312 passed, 4 skipped. (In the first verification one run had the Docker-backed `vercel-target.test.ts` time out waiting 180s for a testcontainers port while every other suite ran in parallel; alone it passed. It never reaches the retry code.)
- `pnpm lint`, `pnpm typecheck`
- `pnpm --dir apps/web test`: 64 files, 979 passed, 1 skipped (after Task 9)
- `node scripts/check-docs.mjs`, `pnpm check:build-cache`, `BASE_REF=HEAD~1 node scripts/check-changesets.mjs` (9 user-facing changes, 1 changeset)
- `pnpm verify:harness:runtime` with `OPENAI_API_KEY` unset: passed (aimock, no network)
- the lastmod regeneration in Task 9, from a temporary commit of all the content

Fourteen mutation checks each turned tests red (see "Mutation checks" at the end).

## Risks and decisions

Items marked **Decision** need Brian.

1. **Decision: the `b4 memory` model gets the default policy, not a route's.** `b4 memory consolidate` and `reflect` build **one** chat model per pass (`createModel()` is called once in `runConsolidation`/`runReflection`, `packages/cli/src/lib/memory/distill.ts`) and use it for every namespace the pass selects. There is no route in the command's context, and a namespace names a route only when that route's `memory.ts` declares the `route` scope (`buildMemoryContext` serializes only the declared dimensions, so a `scope: ["user"]` memory is shared by every route that declares it). The distillation model is also chosen separately (`memory.distill.model`, default `gpt-5-mini`), not the route's model. So the plan gives it an agent's default: `modelMaxRetries(undefined)`, 3 attempts per call (`maxRetries: 2`) instead of LangChain's 6. Alternatives if Brian wants it configurable: (a) a `memory.distill.retry: RetryConfig` key in `b4.config.ts` (needs its own shape validation, since `B4Config` has no runtime schema), or (b) per-namespace models keyed by the `route=` dimension, falling back to the default, which changes the engine's one-model-per-pass shape.
2. **Decision: only `maxRetries` reaches the summarizer and distillation models, not B4's capacity-429 layer.** Their calls aren't model calls in the agent graph, so `wrapModelCall` never sees them. A capacity 429 on the summarizer makes the hook fall back to the full history for that turn (existing behaviour); on distillation it fails that batch, and the next cron pass picks it up. Wrapping `defaultSummarize`'s and the distill engine's `invoke` in `retryCapacityErrors` is small if wanted.
3. **In practice, B4 retries only headerless capacity 429s.** LangChain 1.2.12 classifies a 429 as `capacity` with a `retryAfterMs` only when the `Retry-After` (or a "try again in …" message) is over 60s (`RETRY_AFTER_AUTO_RETRY_THRESHOLD_MS`); anything up to 60s it waits out itself. Every capacity 429 that carries a `retryAfterMs` is therefore over the 10s cap and now surfaces at once. The "within the cap → wait exactly `retryAfterMs`" branch exists and is tested (with a `retryAfterMs` set on the error directly), but LangChain never produces that shape today; it would matter only if the threshold changes or another layer sets `retryAfterMs`.
4. **New public export `modelMaxRetries`** from `@b4run/langchain` (listed in `/docs/api/langchain`), used by the CLI. `@b4run/cli` joins the changeset. `SummarizeFn`'s args and `buildSummarizationHook` gain optional parameters (backward compatible).
5. **Ollama isn't retried at all.** `ChatOllama` 1.3.0's chat path calls `this.client.chat` directly, not through its `AsyncCaller` (only `embeddings.js` and `llms.js` use the caller). `maxRetries` is accepted and set on `caller.maxRetries` (the test checks it) but has no effect on chat. Before this change only B4's run-level restart covered it. The docs' "Limits" section says so.
6. **Default change, as the spec intends.** A route without `retry` goes from LangChain's 6 request retries plus up to 3 run restarts to 3 attempts per model call; the summarizer and distillation models go from 6 retries to 2. The changeset says so.
7. **The memory embedder is unchanged.** `openaiEmbedder` builds `OpenAIEmbeddings`, which has its own `maxRetries` (default 6). It isn't a chat model and the spec doesn't cover it.
8. **Errors keep the `MiddlewareError` wrapper they already had.** `createAgent` wraps any error thrown out of a `wrapModelCall` in `MiddlewareError` (message and `name` kept, the original on `.cause`, so `retryAfterMs` is on `error.cause`). The old middleware already had `wrapModelCall`, so clients see the same shape as before; the tests unwrap `.cause`.
9. **No harness lane exercises retry.** `test/runtime`, `test/smoke` and `test/generated` contain no 429/5xx model fixtures (checked by grep). `pnpm verify:harness:runtime` passes with `OPENAI_API_KEY` unset (aimock). The framework and smoke lanes build generated apps against a local registry and weren't run; they don't touch retry.
10. **`agent-adapter-retry.test.ts` is misnamed.** Its `describe` says "per-agent retry config wiring" but it only tests `withRetry`, which is unchanged. Left alone.

Settled by Brian (for the record): raw-runnable agent routes lose the run-level retry; the budget is per layer, so a call that alternates 503s and capacity 429s can make up to `maxAttempts²` requests (a strict shared budget would need a per-call `maxRetries`, which only `@langchain/openai` and `@langchain/anthropic` read); an invalid `retry` (`maxAttempts` not a whole number ≥ 1, `baseDelay` not a finite number ≥ 0) throws from `resolveModelRetryPolicy` when the route is first materialized, before any model is built.

## Deviations from the spec, and why

- **A long `Retry-After` isn't retried** (Brian's decision), where the spec said "honoured, still capped".
- **The summarizer and distillation models get `maxRetries`** (Brian's decision); the spec scoped the change to the route's model.
- **Raw-runnable agent routes lose the run-level retry** (Brian accepted).
- **`retry` values are validated** (Brian accepted).
- **`createChatModel` takes `maxRetries` as an option** rather than reading `retry` itself, and sets it only when given. Existing factory tests that assert the exact constructor options stay unchanged; the three `agent-adapter.test.ts` and one `agent-descriptor-integration.test.ts` assertions that build through `agent()` gain `maxRetries: 2`.
- **Capacity errors are recognised by `getRetryable(error) === true && error.rateLimitType === "capacity"`**, not by `name`. `coerceError` renames an error to `RateLimitCapacityError` only when its `name` is exactly `"Error"`; a provider SDK error with its own `name` keeps it. `getRetryable` reads a `Symbol.for` key, so the two copies of `@langchain/core` 1.2.12 in the lockfile (zod 4.4.3 and 4.6.5 peers) agree.
- **The homepage "Model retries" tile changes.** Its test pinned the old run-level retry's source text in `agent-adapter.ts`; it now pins the new mapping and middleware, and the tile copy says "Each model call retries a rate limit, a server error or a network error with backoff, and no streamed token is sent twice."
- **The retry page keeps a `## Backoff` section.** `search-index.test.ts` requires a section whose first 320 characters of prose contain "jitter"; the rewritten page's LangChain-backoff sentence opens that section.
- **More docs than `retry.mdx` change**, because they repeated the old behaviour or now need the new one: the `retry-flaky-tools` recipe's notes, the `stream-output` recipe's retry bullet, the `RetryConfig` field table in `api/sdk.mdx`, the `retry` line in `templates/AGENTS.md` (served at `/AGENTS.md`), the `summarize` row in `context-management.mdx`, the model flags in `memory/distillation.mdx`, and `api/langchain.mdx` (the `modelMaxRetries` row and `defaultSummarize`'s arguments). `agents.mdx` and `testing.mdx` stay true and are unchanged.
- **lastmod changes seven routes**: `/docs/api/langchain`, `/docs/api/sdk`, `/docs/context-management`, `/docs/memory/distillation`, `/docs/recipes/retry-flaky-tools`, `/docs/recipes/stream-output`, `/docs/retry`. `/` doesn't move (the generator's digest for `/` doesn't include the checklist copy), and `/AGENTS.md` isn't in the manifest.

## Spec assumptions that are wrong in the code

- **"Every LangChain chat model sends each request through `AsyncCaller`" is false for `ChatOllama`** (Risk 5). The other seven do, verified in the installed packages: openai (`completionWithRetry` → `caller.callWithOptions`, SDK `maxRetries: 0`; `ChatOpenAI` delegates to `completions` and `responses` inner models, which inherit `maxRetries`), anthropic (SDK `maxRetries: 0`, `caller.callWithOptions`), google-genai (`caller.callWithOptions`), mistral (a new `AsyncCaller({ maxRetries: this.maxRetries })` per request), groq (SDK `maxRetries: 0`, `caller.call`), xai (`ChatXAI extends ChatOpenAICompletions`), openrouter (`caller.callWithOptions`). All eight constructors accept `maxRetries`.
- **A quota 429 is `InsufficientQuotaError` for OpenAI**, not `RateLimitQuotaExhaustedError`. `defaultFailedAttemptHandler` names an `insufficient_quota` code `InsufficientQuotaError`; `RateLimitQuotaExhaustedError` is only for a quota detected from the message text. Both carry `rateLimitType: "stop"` and `retryable: false`. Verified with the real `ChatOpenAI` and a fake `fetch`: headerless 429 → `name: "RateLimitCapacityError"`, `rateLimitType: "capacity"`, `rateLimitReason: "headerless_429"`, `retryable: true`, one request; `Retry-After: 120` → same plus `retryAfterMs: 120000`, `rateLimitReason: "retry_after_too_large"`; `insufficient_quota` → `InsufficientQuotaError`, `retryable: false`; 503 with `maxRetries: 1` → two requests.
- **The capacity error is thrown before any token for streaming calls**: `_streamResponseChunks` awaits `completionWithRetry(...)` for the stream, and tokens are consumed outside it. Confirmed end to end above (one request, error thrown from `model.stream()` before any chunk).
- **A capacity 429 with a `retryAfterMs` always has one over 60s** (Risk 3), so "`retryAfterMs` honoured, capped" had no in-cap case to honour.
- **A 429 that LangChain waited on and then ran out of retries surfaces with `rateLimitType: "wait"`**, retryable. With `maxAttempts: 1` (`maxRetries: 0`) a 429 with `Retry-After: 5` is thrown immediately in that shape. B4's layer leaves it alone (only `"capacity"`), consistent with "`maxAttempts: 1` fails fast".
- **`retryAfterMs` can also come from the message text** (`"try again in 20s"`), not only the header (`parseRetryAfterFromMessageMs`).
- **LangChain's backoff is p-retry's with `minTimeout` 1000, `factor` 2, `randomize: true`**: each delay is between 1× and 2× of `1000 * 2^n`, raised to the error's `retryAfterMs` when that's larger.
- **LangChain doesn't retry `400`–`407`, `409` or `413`** (`STATUS_NO_RETRY`); every other status, including `408`, `422` and other 4xx, is retried. The docs say exactly which.
- **An error escaping B4's `wrapModelCall` reaches the client as a `MiddlewareError`** (Risk 8).
- **The run-level retry also ran for raw runnables** exported from an agent route, with a hard-coded default of 3.
- **The `b4 memory` commands have no route context** (Decision 1), and B4 builds no other chat models: the only `createChatModel` callers are `materializeAgent`, `defaultSummarize` and `createDistillModel`. (The factory's JSDoc mentions a "memory extractor"; no such construction site exists.)
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
- To apply a diff block: save it to a file in your scratchpad (for example `<scratchpad>/task4-adapter.diff`) and run `git apply <file>` from the repo root. If it doesn't apply, the base has moved; apply the hunks by hand.
- When mutating a file to check a test binds, back it up first and restore from the backup. `git checkout -- <file>` restores the last **commit**, which throws away uncommitted work.

---

## File Structure

| File | Responsibility |
|---|---|
| Create `packages/langchain/src/model-call-retry.ts` | Policy defaults and validation, `maxRetries` mapping, capacity-429 recognition, backoff and the long-`Retry-After` rule, `retryCapacityErrors`. |
| Create `packages/langchain/test/helpers/langchain-errors.ts` | Errors classified by a real `AsyncCaller`: headerless 429, long `Retry-After` 429, quota 429, 503. |
| Create `packages/langchain/test/model-call-retry.test.ts` | Unit tests with a recording clock. |
| Modify `packages/langchain/src/chat-model-factory.ts` | Optional `maxRetries` passed to the provider constructor. |
| Create `packages/langchain/test/chat-model-factory-max-retries.test.ts` | Each of the eight providers, with a fake class and with the installed package's own request caller. |
| Modify `packages/langchain/src/summarization/hook.ts`, `packages/langchain/src/summarization/summarize.ts` | `maxRetries` from the hook to `summarize` to the summarizer's model. |
| Create `packages/langchain/test/summarization-max-retries.test.ts` | The hook forwards it; `defaultSummarize` builds its model with it. |
| Modify `packages/langchain/src/agent-adapter.ts` | Resolve the policy, pass `maxRetries` and the policy; remove the run-level retry. |
| Modify `packages/langchain/src/agent-middleware.ts` | `retry` option; `wrapModelCall` runs `retryCapacityErrors`; the summarization hook gets the route's `maxRetries`. |
| Create `packages/langchain/test/agent-retry-per-model-call.test.ts` | Real `createAgent` graph through `streamAgent` with a streaming fake model and fake timers. |
| Modify `packages/langchain/test/agent-adapter.test.ts`, `packages/langchain/test/agent-descriptor-integration.test.ts` | Constructor options now include `maxRetries: 2`. |
| Modify `packages/langchain/src/index.ts`, `apps/web/content/docs/api/langchain.mdx` | Export and document `modelMaxRetries`; `defaultSummarize`'s new argument. |
| Modify `packages/cli/src/commands/memory.ts` | The distillation model gets `maxRetries: modelMaxRetries(undefined)`. |
| Create `packages/cli/test/distill-model-retry.test.ts` | `consolidate` and `reflect` build their model with `maxRetries: 2`. |
| Modify `packages/sdk/src/agent.ts` | `RetryConfig` JSDoc. |
| Create `.changeset/agent-retry-per-model-call.md` | Patch for `@b4run/langchain`, `@b4run/sdk` and `@b4run/cli`. |
| Modify `apps/web/content/docs/retry.mdx` | Rewritten. |
| Modify `apps/web/content/docs/recipes/retry-flaky-tools.mdx`, `recipes/stream-output.mdx`, `api/sdk.mdx`, `context-management.mdx`, `memory/distillation.mdx`, `apps/web/content/templates/AGENTS.md` | Lines that repeated the old behaviour or describe the new. |
| Modify `apps/web/app/components/homepage/checklist/checklist.ts`, `checklist.test.ts` | Tile copy and its source pins. |
| Modify `apps/web/app/seo/lastmod.generated.json` | Seven routes (Task 9). |

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
  modelMaxRetries,
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

describe("modelMaxRetries", () => {
  test("maps an agent's retry, defaulting to 3 attempts", () => {
    expect(modelMaxRetries(undefined)).toBe(2)
    expect(modelMaxRetries({ baseDelay: 10 })).toBe(2)
    expect(modelMaxRetries({ maxAttempts: 1 })).toBe(0)
    expect(modelMaxRetries({ maxAttempts: 6 })).toBe(5)
  })

  test("rejects an invalid retry like the route does", () => {
    expect(() => modelMaxRetries({ maxAttempts: 0 })).toThrow(/retry\.maxAttempts/)
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

  test("waits exactly the error's retryAfterMs when it is within 10 seconds", async () => {
    const shortWait = Object.assign(await headerlessRateLimit(), { retryAfterMs: 3000 })
    expect(capacityRetryDelay(shortWait, 0, 200, () => 0.9)).toBe(3000)
    const atCap = Object.assign(await headerlessRateLimit(), { retryAfterMs: MAX_RETRY_DELAY_MS })
    expect(capacityRetryDelay(atCap, 2, 200, () => 0)).toBe(MAX_RETRY_DELAY_MS)
  })

  test("does not retry when retryAfterMs is longer than 10 seconds", async () => {
    const longWait = await longRetryAfterRateLimit(120)
    expect((longWait as { retryAfterMs?: number }).retryAfterMs).toBe(120_000)
    expect(capacityRetryDelay(longWait, 0, 200, () => 0)).toBeUndefined()
    const justOver = Object.assign(await headerlessRateLimit(), { retryAfterMs: 10_001 })
    expect(capacityRetryDelay(justOver, 0, 200, () => 0)).toBeUndefined()
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

  test("surfaces a capacity 429 with a Retry-After over the cap at once", async () => {
    const clock = recordingClock()
    const longWait = await longRetryAfterRateLimit(120)
    let calls = 0
    await expect(
      retryCapacityErrors(
        async () => {
          calls += 1
          throw longWait
        },
        policy,
        { clock },
      ),
    ).rejects.toBe(longWait)
    expect(calls).toBe(1)
    expect(clock.waits).toEqual([])
    expect((longWait as { retryAfterMs?: number }).retryAfterMs).toBe(120_000)
  })

  test("waits a within-cap retryAfterMs, then sends the call again", async () => {
    const clock = recordingClock()
    const shortWait = Object.assign(await headerlessRateLimit(), { retryAfterMs: 4000 })
    let calls = 0
    const result = await retryCapacityErrors(
      async () => {
        calls += 1
        if (calls === 1) throw shortWait
        return "ok"
      },
      policy,
      { clock },
    )
    expect(result).toBe("ok")
    expect(clock.waits).toEqual([4000])
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
 *    ({@link retryCapacityErrors}). A capacity 429 whose `retryAfterMs` is
 *    longer than B4's 10s cap is surfaced at once instead: retrying sooner
 *    than the server asked would only spend an attempt on another 429.
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
 * The `maxRetries` for a chat model B4.run builds from an `agent()`'s
 * `retry`: `maxAttempts - 1`, with `maxAttempts` defaulting to 3. Throws on an
 * invalid `retry`, like the route itself. Used for the models B4 builds
 * besides the route's own: the summarizer, and the `b4 memory` distillation
 * model (which has no route and passes `undefined`, the default policy).
 */
export function modelMaxRetries(retry: RetryConfig | undefined): number {
  return providerMaxRetries(resolveModelRetryPolicy(retry))
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
 * The wait before capacity retry `retryIndex` (0 for the first retry), or
 * `undefined` when B4 must not retry at all.
 *
 * - The error carries a `retryAfterMs` (LangChain parsed a `Retry-After`
 *   header, or a "try again in …" message): wait exactly that when it is 10s
 *   or less; otherwise `undefined`, so the error surfaces right away with its
 *   `retryAfterMs` for the caller to act on.
 * - No `retryAfterMs`: `baseDelay * 2^retryIndex` plus up to 500ms of jitter,
 *   capped at 10s.
 */
export function capacityRetryDelay(
  error: unknown,
  retryIndex: number,
  baseDelay: number,
  random: () => number,
): number | undefined {
  const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return retryAfterMs <= MAX_RETRY_DELAY_MS ? retryAfterMs : undefined
  }
  return Math.min(baseDelay * 2 ** retryIndex + random() * JITTER_MS, MAX_RETRY_DELAY_MS)
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
 * succeeds, fails another way, has used `maxAttempts` attempts, or hits a
 * capacity 429 whose `retryAfterMs` is over the 10s cap. An abort during the
 * wait rejects with the signal's reason and sends nothing more.
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
      const delay = capacityRetryDelay(error, attempt - 1, policy.baseDelay, clock.random)
      if (delay === undefined) throw error
      await clock.sleep(delay, options.signal)
    }
  }
}
```

`random: () => Math.random()` is deliberate, not `random: Math.random`: the integration tests spy on `Math.random`, and a captured reference would bypass the spy.

- [ ] **Step 5: Run them green**

Run: `pnpm --filter @b4run/langchain exec vitest --run --config vitest.config.ts test/model-call-retry.test.ts`
Expected: PASS, 29 tests.

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
Expected: FAIL, 16 of 17: the 8 "passes maxRetries" cases (`expected undefined to be +0`) and the 8 "installed package" cases (`expected 6 to be +0`). "leaves maxRetries unset" passes.

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
Expected: PASS, 29 tests. `chat-model-factory.test.ts` is unchanged because nothing passes `maxRetries` there.

- [ ] **Step 5: Commit**

```bash
git status --short
git add packages/langchain/src/chat-model-factory.ts packages/langchain/test/chat-model-factory-max-retries.test.ts
git commit -m "feat(langchain): createChatModel passes maxRetries to every provider

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The summarizer takes `maxRetries`

**Files:**
- Create: `packages/langchain/test/summarization-max-retries.test.ts`
- Modify: `packages/langchain/src/summarization/hook.ts`, `packages/langchain/src/summarization/summarize.ts`

- [ ] **Step 1: Write the failing tests**

`@langchain/openai` is mocked, so `defaultSummarize`'s real `createChatModel` path builds a fake that records its constructor options.

`packages/langchain/test/summarization-max-retries.test.ts`:

```ts
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { afterEach, describe, expect, test, vi } from "vitest"
import { buildSummarizationHook, type SummarizeFn } from "../src/summarization/hook.ts"
import { defaultSummarize } from "../src/summarization/summarize.ts"

let constructedWith: Record<string, unknown>[] = []

class FakeChatOpenAI {
  constructor(readonly options: Record<string, unknown>) {
    constructedWith.push(options)
  }
  async invoke(): Promise<{ content: string }> {
    return { content: "the summary" }
  }
}

afterEach(() => {
  vi.doUnmock("@langchain/openai")
  constructedWith = []
})

describe("defaultSummarize maxRetries", () => {
  test.each([0, 2, 4])("builds the summarizer model with maxRetries %i", async (maxRetries) => {
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: FakeChatOpenAI }))
    const summary = await defaultSummarize({
      messages: [new HumanMessage("where is order 6?")],
      model: "gpt-5-mini",
      signal: new AbortController().signal,
      maxRetries,
    })
    expect(summary).toBe("the summary")
    expect(constructedWith.at(-1)?.maxRetries).toBe(maxRetries)
  })

  test("leaves maxRetries to the provider when none is given", async () => {
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: FakeChatOpenAI }))
    await defaultSummarize({
      messages: [new HumanMessage("where is order 6?")],
      model: "gpt-5-mini",
      signal: new AbortController().signal,
    })
    expect("maxRetries" in (constructedWith.at(-1) ?? {})).toBe(false)
  })
})

describe("buildSummarizationHook maxRetries", () => {
  const messages = [new HumanMessage("u1"), new AIMessage("a1"), new HumanMessage("u2")]
  const config = {
    maxTokens: 1,
    keepRecentTurns: 1,
    model: "gpt-5-mini",
    tokenCounter: (text: string) => text.length,
  }

  test("hands maxRetries to every summarize call", async () => {
    const summarize = vi.fn<SummarizeFn>(async () => "S")
    await buildSummarizationHook({ ...config, summarize }, { maxRetries: 4 })({ messages })
    expect(summarize.mock.calls[0]?.[0].maxRetries).toBe(4)
  })

  test("passes no maxRetries when the hook was given none", async () => {
    const summarize = vi.fn<SummarizeFn>(async () => "S")
    await buildSummarizationHook({ ...config, summarize })({ messages })
    expect("maxRetries" in (summarize.mock.calls[0]?.[0] ?? {})).toBe(false)
  })
})
```

- [ ] **Step 2: Run them red**

Run: `pnpm --filter @b4run/langchain exec vitest --run --config vitest.config.ts test/summarization-max-retries.test.ts`
Expected: FAIL, 4 of 6: the three "builds the summarizer model with maxRetries …" cases (`expected undefined to be +0`, `2`, `4`) and "hands maxRetries to every summarize call" (`expected undefined to be 4`). The two "no maxRetries" cases pass already.

- [ ] **Step 3: Implement**

Apply:

```diff
diff --git a/packages/langchain/src/summarization/hook.ts b/packages/langchain/src/summarization/hook.ts
index 62751f2f7..5e93ca692 100644
--- a/packages/langchain/src/summarization/hook.ts
+++ b/packages/langchain/src/summarization/hook.ts
@@ -15,6 +15,12 @@ export type SummarizeFn = (args: {
   readonly model: string
   readonly previousSummary?: string
   readonly signal: AbortSignal
+  /**
+   * The route's `retry` as the summarizer model's `maxRetries`
+   * (`maxAttempts - 1`). `defaultSummarize` passes it to the chat model it
+   * builds; a custom summarizer may use or ignore it.
+   */
+  readonly maxRetries?: number
 }) => Promise<string>
 
 export interface ResolvedSummarizationConfig {
@@ -35,7 +41,14 @@ export interface PreModelHookResult {
   runningSummary?: RunningSummary
 }
 
-export function buildSummarizationHook(cfg: ResolvedSummarizationConfig) {
+/**
+ * `options.maxRetries` is handed to every `summarize` call; see
+ * {@link SummarizeFn}.
+ */
+export function buildSummarizationHook(
+  cfg: ResolvedSummarizationConfig,
+  options: { readonly maxRetries?: number } = {},
+) {
   return async (
     state: PreModelHookState,
     nodeConfig?: { readonly signal?: AbortSignal },
@@ -57,6 +70,7 @@ export function buildSummarizationHook(cfg: ResolvedSummarizationConfig) {
           model: cfg.model,
           ...(prev?.summary ? { previousSummary: prev.summary } : {}),
           signal: nodeConfig?.signal ?? new AbortController().signal,
+          ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
         })
       } catch (error) {
         // Summarization failed this turn — fall back to the FULL history.
diff --git a/packages/langchain/src/summarization/summarize.ts b/packages/langchain/src/summarization/summarize.ts
index 5e0744fb4..008bf20c6 100644
--- a/packages/langchain/src/summarization/summarize.ts
+++ b/packages/langchain/src/summarization/summarize.ts
@@ -31,6 +31,8 @@ export async function defaultSummarize(args: {
   readonly model: string
   readonly previousSummary?: string
   readonly signal: AbortSignal
+  /** The chat model's `maxRetries`; the route's `retry.maxAttempts - 1`. */
+  readonly maxRetries?: number
   /** Test seam: override the model invocation. */
   readonly invokeModel?: (prompt: string) => Promise<string>
 }): Promise<string> {
@@ -38,7 +40,11 @@ export async function defaultSummarize(args: {
   if (args.invokeModel) return args.invokeModel(prompt)
 
   const provider = resolveProvider({ model: args.model })
-  const llm = (await createChatModel({ model: args.model, provider })) as {
+  const llm = (await createChatModel({
+    model: args.model,
+    provider,
+    ...(args.maxRetries !== undefined ? { maxRetries: args.maxRetries } : {}),
+  })) as {
     invoke: (input: unknown, options?: unknown) => Promise<{ content: unknown }>
   }
   const res = await llm.invoke([{ role: "user", content: prompt }], { signal: args.signal })
```

- [ ] **Step 4: Run them green**

Run: `pnpm --filter @b4run/langchain exec vitest --run --config vitest.config.ts test/summarization-max-retries.test.ts test/summarization-hook.test.ts test/summarization-summarize.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git status --short
git add packages/langchain/src/summarization/hook.ts packages/langchain/src/summarization/summarize.ts packages/langchain/test/summarization-max-retries.test.ts
git commit -m "feat(langchain): the summarizer's model takes maxRetries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Agent routes retry per model call, and never restart the run

**Files:**
- Create: `packages/langchain/test/agent-retry-per-model-call.test.ts`
- Modify: `packages/langchain/src/agent-adapter.ts`, `packages/langchain/src/agent-middleware.ts`
- Modify: `packages/langchain/test/agent-adapter.test.ts`, `packages/langchain/test/agent-descriptor-integration.test.ts`

- [ ] **Step 1: Write the failing integration tests**

A real `createAgent` graph, through `streamAgent`. `@langchain/openai` is mocked with a streaming fake that plays one script step per model call and records the fake-clock time of each call; the capacity backoff then shows up as the gap between calls. Timers are faked for `setTimeout`, `clearTimeout` and `Date` only, and `settle` keeps advancing time until the turn resolves, because LangGraph's error path arms timers of its own. `Math.random` is pinned to 0, so the jitter is 0. The summarizer cases turn summarization on with a one-token threshold and a spy `summarize`, and read the `maxRetries` it was handed.

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
import type { ResolvedSummarizationConfig, SummarizeFn } from "../src/summarization/index.ts"
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
  readonly summarization?: ResolvedSummarizationConfig
  readonly userMessages?: readonly string[]
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
        input: {
          messages: (options.userMessages ?? ["where is order 7?"]).map((content) => ({
            role: "user",
            content,
          })),
        },
        routeParamNames: [],
        signal: options.signal ?? new AbortController().signal,
        threadId: `retry-${Math.random()}`,
        tools: [lookup],
        ...(options.summarization ? { summarization: options.summarization } : {}),
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

describe("the route's retry reaches the summarizer", () => {
  test.each([
    [undefined, 2],
    [{ maxAttempts: 1 }, 0],
    [{ maxAttempts: 5 }, 4],
  ])("retry %j → summarize gets maxRetries %i", async (retry, maxRetries) => {
    const summarize = vi.fn<SummarizeFn>(async () => "earlier: asked about order 6")
    script = [{ kind: "text", tokens: ["Order 7 has shipped."] }]
    const { error } = await settle(
      startTurn({
        ...(retry ? { retry } : {}),
        userMessages: ["where is order 6?", "where is order 7?"],
        summarization: {
          maxTokens: 1,
          keepRecentTurns: 1,
          model: "gpt-5-mini",
          tokenCounter: (text) => text.length,
          summarize,
        },
      }),
    )
    expect(error).toBeUndefined()
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(summarize.mock.calls[0]?.[0].maxRetries).toBe(maxRetries)
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

  test("a Retry-After longer than 10 seconds is surfaced at once, not retried", async () => {
    const longWait = await longRetryAfterRateLimit(120)
    script = [
      { kind: "fail", error: longWait },
      { kind: "text", tokens: ["never"] },
    ]
    const { chunks, error } = await settle(startTurn({ retry: { maxAttempts: 3, baseDelay: 50 } }))
    // Exactly one request, and the error keeps the server's wait.
    expect(modelCalls).toBe(1)
    expect(modelError(error)).toBe(longWait)
    expect((modelError(error) as { retryAfterMs?: number }).retryAfterMs).toBe(120_000)
    expect(tokens(chunks)).toEqual([])
  })

  test("a retryAfterMs within 10 seconds is waited out, then the call is sent again", async () => {
    const shortWait = Object.assign(await headerlessRateLimit(), { retryAfterMs: 3000 })
    script = [
      { kind: "fail", error: shortWait },
      { kind: "text", tokens: ["done"] },
    ]
    const { chunks, error } = await settle(startTurn({ retry: { maxAttempts: 2, baseDelay: 50 } }))
    expect(error).toBeUndefined()
    // The server's 3000ms, not the 50ms baseDelay.
    expect(gapsBetweenCalls()).toEqual([3000])
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
Expected: FAIL, 13 of 16:

- the three `retry … → maxRetries …` cases: `expected undefined to be 2` (then `+0`, `4`);
- "an invalid maxAttempts…": `promise resolved "ReactAgent{ … }" instead of rejecting`;
- the three `retry … → summarize gets maxRetries …` cases: `expected undefined to be 2` (then `+0`, `4`);
- "retries a capacity 429 on the second model call…": the error surfaces (`expected RateLimitCapacityError … to be undefined`);
- "gives up after maxAttempts…" and "a retryAfterMs within 10 seconds…": `expected [ 1000 ] to deeply equal [ 50 ]` / `[ 3000 ]`. The old run-level retry restarted the whole run after its fixed 1000ms, because the message contains "rate limit";
- "a Retry-After longer than 10 seconds…": `expected 2 to be 1` (the old run-level retry restarted the run);
- "a failure before anything streamed does not restart the run": `expected undefined to be Error: 503 Service Unavailable` (the restarted run succeeded);
- "a raw runnable's stream is opened once…": `expected 3 to be 1`.

"a quota 429 is not retried", "a failure after tokens streamed…" and "an abort during the backoff wait…" pass on the old code too: it didn't retry a quota error or a run that had streamed, and after the abort its restart made no second model call. They pin behaviour the change must keep.

- [ ] **Step 3: Wire the policy into the middleware**

Apply:

```diff
diff --git a/packages/langchain/src/agent-middleware.ts b/packages/langchain/src/agent-middleware.ts
index f56239d10..615462941 100644
--- a/packages/langchain/src/agent-middleware.ts
+++ b/packages/langchain/src/agent-middleware.ts
@@ -8,6 +8,12 @@ import {
 import { isGraphInterrupt } from "@langchain/langgraph"
 import { type AgentMiddleware, createMiddleware } from "langchain"
 import { z } from "zod"
+import {
+  type ModelRetryPolicy,
+  providerMaxRetries,
+  resolveModelRetryPolicy,
+  retryCapacityErrors,
+} from "./model-call-retry.js"
 import {
   buildSummarizationHook,
   type ResolvedSummarizationConfig,
@@ -33,6 +39,8 @@ export interface B4AgentMiddlewareOptions {
   readonly summarization?: ResolvedSummarizationConfig
   /** Tools that end the run on a successful result. */
   readonly returnDirectToolNames: ReadonlySet<string>
+  /** The route's `retry`, resolved; defaults to 3 attempts and a 1s base delay. */
+  readonly retry?: ModelRetryPolicy
 }
 
 /**
@@ -62,6 +70,7 @@ function modelAndToolMiddleware(options: B4AgentMiddlewareOptions): AgentMiddlew
   const readable: Record<string, z.ZodTypeAny> = { [LLM_INPUT_MESSAGES]: z.any().optional() }
   for (const name of options.stateFieldNames) readable[name] = z.any().optional()
   const composesPrompt = options.promptFragments.length > 0
+  const retry = options.retry ?? resolveModelRetryPolicy(undefined)
 
   return createMiddleware({
     name: "B4ModelAndTools",
@@ -70,7 +79,6 @@ function modelAndToolMiddleware(options: B4AgentMiddlewareOptions): AgentMiddlew
       const state = request.state as Record<string, unknown>
       const view = state[LLM_INPUT_MESSAGES]
       const messages = Array.isArray(view) ? (view as BaseMessage[]) : request.messages
-      if (!composesPrompt && messages === request.messages) return handler(request)
       const systemMessage = composesPrompt
         ? new SystemMessage(
             await composeSystemPrompt(options.systemPrompt, options.promptFragments, {
@@ -79,7 +87,17 @@ function modelAndToolMiddleware(options: B4AgentMiddlewareOptions): AgentMiddlew
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
@@ -119,7 +137,12 @@ export function toolErrorMessage(
 function loopEntryMiddleware(options: B4AgentMiddlewareOptions): AgentMiddleware | undefined {
   const { returnDirectToolNames, summarization } = options
   if (returnDirectToolNames.size === 0 && !summarization) return undefined
-  const summarize = summarization ? buildSummarizationHook(summarization) : undefined
+  // The summarizer's model gets the route's `retry` too, as its `maxRetries`.
+  const summarize = summarization
+    ? buildSummarizationHook(summarization, {
+        maxRetries: providerMaxRetries(options.retry ?? resolveModelRetryPolicy(undefined)),
+      })
+    : undefined
 
   return createMiddleware({
     name: "B4LoopEntry",
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
Expected: PASS, 16 tests. Run it three times; it's deterministic (fake clock, pinned jitter).

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
Expected: PASS, 49 files, 351 tests.

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

maxAttempts becomes the chat model's maxRetries, and the summarizer's;
B4's middleware sends a model call again after a capacity 429 with
baseDelay backoff, and surfaces one whose Retry-After is over 10s; the
run-level restart in processEventStream is gone.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `modelMaxRetries` for the `b4 memory` model

**Files:**
- Create: `packages/cli/test/distill-model-retry.test.ts`
- Modify: `packages/langchain/src/index.ts`, `apps/web/content/docs/api/langchain.mdx`, `packages/cli/src/commands/memory.ts`

- [ ] **Step 1: Write the failing test**

The CLI's vitest config aliases `@b4run/langchain` to its `src` (no build needed between tasks), so the command's real `createChatModel` path runs, and `@langchain/openai` is mocked. The seeded episodes and the config's low thresholds give each command one batch; the scratch app lives under `packages/cli/.tmp-distill-retry-apps`, like the other CLI memory tests' scratch apps, and is removed after each test.

`packages/cli/test/distill-model-retry.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { type MemoryRecord, sqliteMemoryStore } from "@b4run/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runMemoryCommand } from "../src/commands/memory.js"

/**
 * `b4 memory consolidate` / `reflect` build their chat model with an agent's
 * default retry (3 attempts per call → `maxRetries: 2`), not LangChain's 6:
 * a distillation pass has no single route whose `retry` could apply.
 * `@langchain/openai` is mocked, so no network and no API key.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const scratchRoot = resolve(repoRoot, "packages", "cli", ".tmp-distill-retry-apps")

let constructedWith: Record<string, unknown>[] = []

class FakeChatOpenAI {
  constructor(options: Record<string, unknown>) {
    constructedWith.push(options)
  }
  async invoke(prompt: unknown): Promise<{ content: string }> {
    return String(JSON.stringify(prompt)).includes("deriving durable insights")
      ? { content: '{"insights":[]}' }
      : { content: '{"summary":"five billing deploys"}' }
  }
}

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  vi.doUnmock("@langchain/openai")
  constructedWith = []
})

async function makeApp(): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  const root = await mkdtemp(join(scratchRoot, "app-"))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  await writeFile(join(root, "package.json"), '{ "name": "distill-retry-app", "type": "module" }\n')
  await writeFile(
    join(root, "b4.config.ts"),
    [
      "export default {",
      "  memory: {",
      "    distill: {",
      "      consolidate: { olderThanMs: 0, minBatchSize: 2, maxBatchSize: 50 },",
      "      reflect: { minNewRecords: 2, maxRecords: 100 },",
      "    },",
      "  },",
      "}",
      "",
    ].join("\n"),
  )
  const store = sqliteMemoryStore({ path: join(root, ".b4/memory.sqlite") })
  for (const day of [6, 7, 8]) {
    const at = `2026-07-0${day}T09:00:00.000Z`
    const record: MemoryRecord = {
      id: `e${day}`,
      kind: "episodic",
      namespace: "ws=app|route=/chat",
      content: `run e${day}: deployed the billing service`,
      data: {},
      source: { type: "run", id: `e${day}` },
      confidence: 1,
      tags: [],
      status: "active",
      createdAt: at,
      updatedAt: at,
      effectiveAt: at,
    }
    await store.put(record)
  }
  return root
}

describe("distillation model retry", () => {
  it.each(["consolidate", "reflect"])(
    "%s builds its model with maxRetries 2",
    async (command) => {
      vi.doMock("@langchain/openai", () => ({ ChatOpenAI: FakeChatOpenAI }))
      const appRoot = await makeApp()
      const err: string[] = []
      await runMemoryCommand(
        [command],
        { cwd: appRoot },
        { stdout: () => {}, stderr: (m) => err.push(m) },
      )
      expect(err.join("")).toBe("")
      expect(constructedWith).toHaveLength(1)
      expect(constructedWith[0]?.maxRetries).toBe(2)
    },
    60_000,
  )
})
```

- [ ] **Step 2: Run it red**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/distill-model-retry.test.ts`
Expected: FAIL, 2 of 2, `expected undefined to be 2`.

- [ ] **Step 3: Export `modelMaxRetries`, document it, and use it**

Apply:

```diff
diff --git a/packages/langchain/src/index.ts b/packages/langchain/src/index.ts
index cc8427998..33dadb506 100644
--- a/packages/langchain/src/index.ts
+++ b/packages/langchain/src/index.ts
@@ -22,6 +22,7 @@ export {
   supportsJsonSchemaResponseFormat,
   unsupportedResponseFormatMessage,
 } from "./chat-model-factory.js"
+export { modelMaxRetries } from "./model-call-retry.js"
 export { inferProvider, resolveProvider } from "./model-provider-resolver.js"
 export type { OffloadStoreOptions } from "./offload/offload-store.js"
 export { buildOffloadFileName, OffloadStore } from "./offload/offload-store.js"
diff --git a/apps/web/content/docs/api/langchain.mdx b/apps/web/content/docs/api/langchain.mdx
index 774eafeac..995164c71 100644
--- a/apps/web/content/docs/api/langchain.mdx
+++ b/apps/web/content/docs/api/langchain.mdx
@@ -56,6 +56,7 @@ The runtime root is edge-safe for B4.run's emitted Hono/workerd target. The evid
 | `seedModelImporter` | Install the process-global fallback provider importer. |
 | `inferProvider` | Re-export SDK provider inference. |
 | `resolveProvider` | Resolve an explicit provider or infer one from a model ID. |
+| `modelMaxRetries` | Map an agent's `retry` to a chat model's `maxRetries` (`maxAttempts - 1`, default 2). |
 | `RetryOptions` | Configure retry attempts, backoff, cap, and cancellation. |
 | `isRetryableError` | Classify known transient error messages. |
 | `withRetry` | Retry transient async failures with jittered exponential backoff. |
@@ -224,7 +225,7 @@ type BuildStubArgs = {
 }
 ```
 
-The larger inline `AgentOptions` shape used by `executeAgent` and `streamAgent` requires `checkpointer`, `entry`, `input`, `routeParamNames`, `signal`, and `tools`. It also accepts middleware, retry, state, prompt, offload, summarization, subagent, thread, sandbox, and cache-bypass controls. The subagent converter accepts a private `{ name, description?, schema? }` placeholder, and the tool converter accepts the same basic tool definition plus a `run` callback. `defaultSummarize` accepts messages, model, optional previous summary, and signal.
+The larger inline `AgentOptions` shape used by `executeAgent` and `streamAgent` requires `checkpointer`, `entry`, `input`, `routeParamNames`, `signal`, and `tools`. It also accepts middleware, retry, state, prompt, offload, summarization, subagent, thread, sandbox, and cache-bypass controls. The subagent converter accepts a private `{ name, description?, schema? }` placeholder, and the tool converter accepts the same basic tool definition plus a `run` callback. `defaultSummarize` accepts messages, model, optional previous summary, signal, and optional `maxRetries` for the model it builds.
 
 Materialized graphs are cached by descriptor plus checkpointer. Sandbox-bound tools, subagents, stream transformers, and explicit bypass requests skip reuse. A checkpointer is mandatory at runtime. `threadId` is also required for an interrupted run to resume. Generated edge assembly must seed its static provider importer before model construction.
 
diff --git a/packages/cli/src/commands/memory.ts b/packages/cli/src/commands/memory.ts
index becb06888..de186f078 100644
--- a/packages/cli/src/commands/memory.ts
+++ b/packages/cli/src/commands/memory.ts
@@ -355,11 +355,21 @@ function selectProvider(
  * exactly `ModelLike`'s shape (the engine normalizes string vs content-part
  * array content). Imported lazily so `b4 memory list` never pays for the
  * LangChain barrel.
+ *
+ * Retry: one model serves a whole pass, across every namespace it selects, and
+ * a namespace names a route only when that route's memory declares the
+ * `route` scope, so there is no single route whose `agent({ retry })` could
+ * apply. The model gets an agent's default instead: 3 attempts per call
+ * (`maxRetries: 2`), rather than LangChain's 6.
  */
 async function createDistillModel(config: ResolvedDistillConfig): Promise<ModelLike> {
-  const { createChatModel, resolveProvider } = await import("@b4run/langchain")
+  const { createChatModel, modelMaxRetries, resolveProvider } = await import("@b4run/langchain")
   const provider = resolveProvider({ model: config.model, provider: config.provider })
-  const model = await createChatModel({ model: config.model, provider })
+  const model = await createChatModel({
+    model: config.model,
+    provider,
+    maxRetries: modelMaxRetries(undefined),
+  })
   return model as ModelLike
 }
 
```

The docs row goes in with the export: the API-reference tests fail on an exported name the page doesn't list.

- [ ] **Step 4: Run it green**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/distill-model-retry.test.ts test/memory-command.test.ts test/distill-aimock.test.ts`
Expected: PASS, 33 tests.

- [ ] **Step 5: Commit**

```bash
git status --short
git add packages/langchain/src/index.ts apps/web/content/docs/api/langchain.mdx packages/cli/src/commands/memory.ts packages/cli/test/distill-model-retry.test.ts
git commit -m "feat(cli): b4 memory distillation model gets maxRetries 2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `RetryConfig` JSDoc and the changeset

**Files:**
- Modify: `packages/sdk/src/agent.ts`
- Create: `.changeset/agent-retry-per-model-call.md`

- [ ] **Step 1: Document `RetryConfig`**

Apply:

```diff
diff --git a/packages/sdk/src/agent.ts b/packages/sdk/src/agent.ts
index 40be33798..e9f6686db 100644
--- a/packages/sdk/src/agent.ts
+++ b/packages/sdk/src/agent.ts
@@ -5,8 +5,27 @@ const B4_AGENT: unique symbol = Symbol.for("b4.agent") as unknown as typeof B4_A
 
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
+   * The route's summarization model gets the same `maxRetries`.
+   */
   readonly maxAttempts?: number
+  /**
+   * Milliseconds before the first retry of a capacity rate limit (a 429 with
+   * no `Retry-After`); doubles each retry, plus up to 500ms of jitter, capped
+   * at 10 seconds. Default `1000`. A 429 whose `Retry-After` is over 10
+   * seconds isn't retried. LangChain's own backoff for other errors is fixed
+   * and doesn't read it.
+   */
   readonly baseDelay?: number
 }
 
```

The `api-contract` block for `RetryConfig` in `apps/web/content/docs/api/sdk.mdx` compares declarations without comments, so it still matches (checked by `pnpm --dir apps/web test` and `node scripts/check-docs.mjs` in Task 8).

- [ ] **Step 2: Write the changeset**

`.changeset/agent-retry-per-model-call.md` (patch: the packages are a fixed group, and `minor` on 0.x would take every package to 1.0.0):

```md
---
"@b4run/langchain": patch
"@b4run/sdk": patch
"@b4run/cli": patch
---

`agent({ retry })` now applies to each model call instead of the whole run. `maxAttempts` (default 3) becomes the chat model's `maxRetries` (`maxAttempts - 1`), so LangChain retries each model request, including later calls in a tool loop, up to that many times; `maxAttempts: 1` now fails fast. Before, LangChain's default of 6 retries applied whatever `retry` said, and B4.run restarted the whole run on top of it when nothing had streamed yet.

B4.run also sends a model call again after a capacity rate limit that LangChain hands back without retrying (a `429` with no `Retry-After`), waiting `min(baseDelay * 2^n + jitter, 10s)`. A `429` whose `Retry-After` is over 10 seconds isn't retried: the error surfaces at once, keeping the wait in `retryAfterMs`. This is the only place `baseDelay` applies; it was previously never read on an agent route. A quota `429` isn't retried, an abort during the wait stops it, and a response that fails after part of it streamed isn't retried, so no token is sent twice. The run itself is never restarted, so tools never run twice.

The route's summarization model gets the same `maxRetries` (`defaultSummarize` and a custom `summarize` receive it as `maxRetries`), and the `b4 memory consolidate` / `reflect` model gets the default of 3 attempts per call instead of LangChain's 6. `modelMaxRetries(retry)` is exported for other code that builds a chat model from an agent's `retry`.

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

### Task 7: The docs and the homepage tile

**Files:**
- Modify: `apps/web/content/docs/retry.mdx`
- Modify: `apps/web/content/docs/recipes/retry-flaky-tools.mdx`, `apps/web/content/docs/recipes/stream-output.mdx`, `apps/web/content/docs/api/sdk.mdx`, `apps/web/content/docs/context-management.mdx`, `apps/web/content/docs/memory/distillation.mdx`, `apps/web/content/templates/AGENTS.md`
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
Expected: FAIL only "retries each model call, never the whole run", on `expected 'A model call that fails with a rate l…' to contain 'Each model call'`. (The source pins already pass after Task 4.)

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

**B4.run retries a capacity rate limit.** LangChain hands back, without retrying, a `429` with no `Retry-After` or with one over 60 seconds, and marks it retryable. B4.run sends that model call again, up to `maxAttempts` attempts of the call in all, unless the `Retry-After` is longer than 10 seconds.

**These fail right away:**

- A quota `429` (for example OpenAI's `insufficient_quota`). Waiting doesn't bring a quota back.
- A `429` whose `Retry-After` is longer than 10 seconds. B4.run won't send the call sooner than the provider asked, or hold the run open that long, so the error comes back at once. It keeps the wait in `retryAfterMs` (milliseconds), so your client can retry the run once it's over.
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

When the error carries a `Retry-After` of 10 seconds or less, B4.run waits exactly that long instead. Over 10 seconds, it doesn't retry (see above). LangChain itself waits out any `Retry-After` up to 60 seconds, so in practice the `429`s B4.run retries are the ones with no `Retry-After`.

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

## Other models B4.run builds

- **Summarization.** When [summarization](/docs/context-management#conversation-summarization) is on, the model that writes the summary gets the route's `maxAttempts` as its `maxRetries` too. A custom `summarize` function receives it as `maxRetries`. B4.run's own capacity rate-limit retry covers only the route's model calls, not the summarizer; a failed summary falls back to the full history for that turn.
- **Memory distillation.** `b4 memory consolidate` and `b4 memory reflect` run outside any route, over every namespace they select, so no route's `retry` applies. Their model gets the default: 3 attempts per call.

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

Every claim is checked against code: the defaults and validation (`resolveModelRetryPolicy`), the `maxRetries` mapping (`providerMaxRetries`), what LangChain retries and doesn't (`defaultFailedAttemptHandler`, `STATUS_NO_RETRY`, `RETRY_AFTER_AUTO_RETRY_THRESHOLD_MS = 60000` in `@langchain/core/dist/utils/async_caller.js`), LangChain's backoff (p-retry `minTimeout` 1000, `factor` 2, `randomize`), B4's formula, cap and long-`Retry-After` rule (`capacityRetryDelay`), streaming (the capacity error precedes the first token; no run restart), the abort (`systemRetryClock.sleep`), subagents (materialized from their own descriptor), the summarizer and distillation models (Tasks 3–5), and Ollama (Risk 5). The `#other-models-b4run-builds` anchor is what `memory/distillation.mdx` links to.

- [ ] **Step 4: The other pages**

```diff
diff --git a/apps/web/content/docs/recipes/retry-flaky-tools.mdx b/apps/web/content/docs/recipes/retry-flaky-tools.mdx
index acbbe8cc8..229571f70 100644
--- a/apps/web/content/docs/recipes/retry-flaky-tools.mdx
+++ b/apps/web/content/docs/recipes/retry-flaky-tools.mdx
@@ -51,16 +51,17 @@ export default agent({
 ## Notes
 
 - **Retry is per route.** Each `agent()` declares its own `retry`, so different routes can have different policies.
-- **Only transient model/provider errors retry.** Rate limits (`429`), server errors (`500`/`502`/`503`), network timeouts, and OpenAI `overloaded`/`server_error` are retried. Invalid API keys, missing models, and schema validation errors fail immediately.
-- **Backoff is exponential with jitter, capped at 10s.** For non-stream fallback, `delay = min(baseDelay * 2^n + jitter, 10s)`. A lower `baseDelay` makes the first retry faster.
+- **Each model call retries on its own.** `maxAttempts` is the attempts per model call, not per run. A failure in a later model call of the tool loop sends only that call again; tools that already ran don't run again.
+- **Only temporary failures retry.** Server errors (`5xx`), network errors, timeouts and rate limits are retried. A quota `429`, an invalid API key, a missing model and a malformed request fail immediately.
+- **`baseDelay` paces capacity rate limits.** A `429` with no `Retry-After` waits `min(baseDelay * 2^n + jitter, 10s)` before the next attempt. A `429` whose `Retry-After` is over 10 seconds isn't retried: the error comes back at once with the wait in `retryAfterMs`. LangChain paces the other retries with its own backoff, starting around 1 second.
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
diff --git a/apps/web/content/docs/context-management.mdx b/apps/web/content/docs/context-management.mdx
index b68fca06f..38c9b0b42 100644
--- a/apps/web/content/docs/context-management.mdx
+++ b/apps/web/content/docs/context-management.mdx
@@ -86,7 +86,7 @@ export default {
 | `keepRecentTurns` | `number` | `6` | Recent turns (each starting at a `HumanMessage`) that are never summarized. |
 | `model` | `string` | Route's model | Model that writes the summary. |
 | `tokenCounter` | `(text: string) => number \| Promise<number>` | `gpt-tokenizer` (o200k_base), loaded on demand | Your own token counter. |
-| `summarize` | `(args) => Promise<string>` | One model call | Your own summarizer. Receives `messages`, `model`, `previousSummary`, and `signal`. |
+| `summarize` | `(args) => Promise<string>` | One model call | Your own summarizer. Receives `messages`, `model`, `previousSummary`, `signal`, and `maxRetries` (the route's [`retry.maxAttempts`](/docs/retry) minus one). |
 
 Use `tokenCounter` to plug in a different tokenizer. `summarize` replaces the whole summary step, for example to use a cheaper model, compress in a way that suits your domain, or call a different provider.
 
diff --git a/apps/web/content/docs/memory/distillation.mdx b/apps/web/content/docs/memory/distillation.mdx
index 94d8d54ec..97d78b33b 100644
--- a/apps/web/content/docs/memory/distillation.mdx
+++ b/apps/web/content/docs/memory/distillation.mdx
@@ -20,7 +20,7 @@ b4 memory reflect --dry-run --namespace 'workspace=my-app|route=/support' --max-
 
 - `--dry-run` selects and reports work, but constructs no model, makes no model calls, and writes nothing.
 - `--namespace <prefix>` narrows the pass to matching namespaces.
-- `--model <id>` and `--provider <id>` override model selection.
+- `--model <id>` and `--provider <id>` override model selection. The model gets 3 attempts per call, an agent's [default retry](/docs/retry#other-models-b4run-builds); no route's `retry` applies to a pass.
 - `--max-batches <n>` caps batches for consolidation and namespaces for reflection.
 - `--cwd <path>` selects another app root, as in other B4.run commands.
 
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

Run: `pnpm build && node scripts/check-docs.mjs`
Expected: `Docs completeness check passed.` Don't run it while another package's tests are running: it reads `packages/cli/.tmp-eval-apps/*`, which the CLI tests create and delete (it failed with `ENOENT … .tmp-eval-apps/app-…/.b4/b4.generated.d.ts` once for that reason).

`seo/generate-lastmod.test.ts` is expected to be red until Task 9.

- [ ] **Step 6: Commit**

```bash
git status --short
git add apps/web/content/docs/retry.mdx apps/web/content/docs/recipes/retry-flaky-tools.mdx apps/web/content/docs/recipes/stream-output.mdx apps/web/content/docs/api/sdk.mdx apps/web/content/docs/context-management.mdx apps/web/content/docs/memory/distillation.mdx apps/web/content/templates/AGENTS.md apps/web/app/components/homepage/checklist/checklist.ts apps/web/app/components/homepage/checklist/checklist.test.ts
git commit -m "docs(web): retry is per model call, with the two layers and their backoff

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Gates

**Files:** none new.

- [ ] **Step 1: Build**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 2: Package tests**

Run each, one at a time; don't pipe them:

```bash
pnpm --filter @b4run/langchain test
pnpm --filter @b4run/sdk test
pnpm --filter @b4run/cli test
```

Expected: langchain 49 files / 351 tests; sdk 14 files / 115 tests; cli 187 files (2 skipped), 2312 passed, 4 skipped. The CLI suite runs the Docker-backed `vercel-target.test.ts`; if it times out waiting for a testcontainers port under load, rerun that file alone (`pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/vercel-target.test.ts`, 133 tests) before suspecting this change.

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
Expected: everything passes except the two lastmod cases in `app/seo/generate-lastmod.test.ts` ("covers every route the site renders…" and "exempts blog listings…"), which Task 9 fixes.

- [ ] **Step 6: The runtime harness lane**

Run: `env -u OPENAI_API_KEY pnpm verify:harness:runtime`
Expected: `status: passed`. No lane exercises model retries (Risk 9); this is the smoke check that real agent routes still run end to end on aimock without an API key.

- [ ] **Step 7: Commit any formatting fixes**

If `pnpm lint` reported formatting in files this plan touched, fix with the scoped Biome command from "Rules", then:

```bash
git status --short
git add <only the files Biome changed>
git commit -m "style: format

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Skip this if nothing changed.

---

### Task 9: Regenerate lastmod for the seven changed routes

**Files:**
- Modify: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: Regenerate**

All content is committed (Tasks 5 and 7), so each changed route is dated by its newest commit.

```bash
pnpm --dir apps/web seo:lastmod
git diff --stat apps/web/app/seo/lastmod.generated.json
```

Expected: `1 file changed, 21 insertions(+), 21 deletions(-)`: `lastModified`, `sourceDigest` and `recordDigest` for exactly seven routes. List them to be sure:

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
/docs/api/langchain
/docs/api/sdk
/docs/context-management
/docs/memory/distillation
/docs/recipes/retry-flaky-tools
/docs/recipes/stream-output
/docs/retry
```

If other routes appear, main's manifest was already stale for them: keep only these seven by splicing them into `<scratchpad>/lastmod-head.json` and writing that back (as `2026-09-25-homepage-files-tour-pr3.md` Task 8 Step 7 does for `/`). If the manifest conflicts on a rebase, it's marked `-merge`; regenerate on top rather than hand-editing.

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

Run after Task 5, one mutation at a time. Copy the file aside first and restore it from the copy afterwards (not `git checkout`, which would drop uncommitted work). For `packages/langchain` mutations, from `packages/langchain`:

```bash
pnpm exec vitest --run --config vitest.config.ts test/agent-retry-per-model-call.test.ts test/model-call-retry.test.ts test/chat-model-factory-max-retries.test.ts test/agent-adapter.test.ts test/summarization-max-retries.test.ts
```

For the CLI mutation, from `packages/cli`: `pnpm exec vitest --run --config vitest.config.ts test/distill-model-retry.test.ts`.

| Mutation | Tests that go red (verified) |
|---|---|
| Delete `maxRetries: providerMaxRetries(retry),` in `materializeAgent` | 6: the three `retry … → maxRetries …` cases and the three `agent-adapter.test.ts` constructor-options cases |
| Delete the `if (options.maxRetries !== undefined) …` line in `createChatModel` | 25: the above, all 16 factory cases, and the three `defaultSummarize` cases |
| In `wrapModelCall`, `return handler(next)` before `retryCapacityErrors(...)` | 4: tool loop, gives up, within-cap `retryAfterMs`, abort |
| In `retryCapacityErrors`, drop `!isCapacityRateLimitError(error) \|\|` (retry everything) | 6: quota 429 not retried; mid-stream failure (token emitted twice); failure before streaming; the three unit "does not retry" cases |
| In `capacityRetryDelay`, `Math.min(retryAfterMs, MAX_RETRY_DELAY_MS)` instead of `undefined` over the cap (the first plan's behaviour) | 3: the long-`Retry-After` integration case and two unit cases |
| Remove the 10s cap on the `baseDelay` backoff | 1: "caps the backoff at 10 seconds" |
| Ignore `retryAfterMs` (always use the backoff) | 6: both `Retry-After` integration cases and four unit cases |
| Pass `undefined` instead of `options.signal` to `clock.sleep` | 2: the abort integration case (a zombie retry makes a second model call after the run ended) and the unit abort case |
| `1000 * 2 ** retryIndex` instead of `baseDelay * 2 ** retryIndex` | 5: tool-loop gaps `[0, 200, 400]`, gives-up gap `[50]`, three unit cases |
| Put back a run-level restart around `processEventStream` (3 attempts, `isRetryableError`, only before the first chunk) | 4: failure before streaming (`expected 2 to be 1`); raw runnable opened once; gives-up and long-`Retry-After` (an extra run) |
| In `loopEntryMiddleware`, `buildSummarizationHook(summarization)` without the route's `maxRetries` | 3: the three "summarize gets maxRetries" cases |
| In the hook, drop the `maxRetries` spread into `summarize` | 4: the three "summarize gets maxRetries" cases and "hands maxRetries to every summarize call" |
| In `defaultSummarize`, drop the `maxRetries` spread into `createChatModel` | 3: the three "builds the summarizer model with maxRetries" cases |
| In `createDistillModel`, drop `maxRetries: modelMaxRetries(undefined),` | 2: `consolidate` and `reflect` |

## Spec coverage checklist

| Requirement (spec, or Brian's decisions on the first plan) | Where |
|---|---|
| `maxAttempts` → the chat model's `maxRetries` (`maxAttempts - 1`, default 3 → 2) | Task 1 (`providerMaxRetries`), Task 2 (`createChatModel`), Task 4 (`materializeAgent`) |
| Test: `maxRetries` reaches the constructed model for each built-in provider, incl. `maxAttempts: 1` → 0 | Task 2 (all eight, fake class and the installed package's `AsyncCaller`); Task 4 (`retry %j → maxRetries %i`, through `agent()`) |
| The route's `retry` reaches the summarization model | Task 3 (hook and `defaultSummarize`), Task 4 (loop-entry middleware; "summarize gets maxRetries" through `agent()`) |
| The `b4 memory` models get `maxRetries`; no route context → default, flagged | Task 5; Decision 1 |
| An author-built model instance keeps its own `maxRetries` | `agent()` only accepts a model id; the only author-built models are raw runnables, which `createChatModel` never touches; docs "Limits" |
| Thin B4 layer in `wrapModelCall` for a retryable capacity 429, `baseDelay` backoff, same `maxAttempts` | Task 1 (`retryCapacityErrors`, `capacityRetryDelay`), Task 4 (middleware) |
| A capacity 429 with `retryAfterMs` over the cap isn't retried; one request; error surfaced with `retryAfterMs` | Task 1 unit ("surfaces … at once", "does not retry when retryAfterMs is longer"), Task 4 ("a Retry-After longer than 10 seconds is surfaced at once") |
| Within-cap `retryAfterMs` is waited | Task 1 ("waits exactly …", "waits a within-cap retryAfterMs …"), Task 4 (gap `[3000]`) |
| Test: capacity 429 on the second model call of a tool loop retried with `baseDelay` backoff; run completes | Task 4 (gaps `[0, 200, 400]`, tool ran once) |
| Test: a quota 429 isn't retried | Task 1 unit, Task 4 integration |
| Test: a mid-stream failure after tokens isn't retried and no token is emitted twice | Task 4 "a failure after tokens streamed…" |
| Test: the run-level retry is gone (no restart after or before streaming) | Task 4 "a failure before anything streamed…", "a raw runnable's stream is opened once…", plus the mid-stream case |
| Test: abort during a backoff wait stops the retry | Task 1 unit; Task 4 integration (no timers left, one model call) |
| Fake models throwing LangChain-shaped errors; fake clock; no network or keys | `helpers/langchain-errors.ts` (real `AsyncCaller`), `ScriptedStreamingModel`, fake timers, mocked `@langchain/openai`, `vi.stubEnv` dummy keys |
| No message-string matching where stamps exist; `isRetryableError` stays exported | `isCapacityRateLimitError` uses `getRetryable` + `rateLimitType`; `retry.ts` unchanged, still exported |
| Remove run-level retry for agent routes (and raw runnables, Brian) | Task 4 (`processEventStream`) |
| Invalid `retry` throws on first use (Brian) | Task 1 (`resolveModelRetryPolicy`, `modelMaxRetries`), Task 4 ("an invalid maxAttempts fails the route…") |
| `exactOptionalPropertyTypes` | conditional spreads in the middleware, hook, `defaultSummarize` and `createChatModel`; `pnpm typecheck` |
| Docs: what's retried and where, per call, no repeated tokens, mid-stream limit, `baseDelay`, quota, long `Retry-After`, other models, own model instance | Task 7 (`retry.mdx` and six other pages), Task 5 (`api/langchain.mdx`) |
| `RetryConfig` JSDoc matches | Task 6 |
| Patch changeset | Task 6 |
| Regenerate lastmod | Task 9 (seven routes) |
