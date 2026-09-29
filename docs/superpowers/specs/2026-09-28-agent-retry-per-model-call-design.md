# Agent retry: one knob, per model call

Date: 2026-09-28 · Scope: `@b4run/langchain` (agent routes), `@b4run/sdk`
`RetryConfig` docs, `apps/web/content/docs/retry.mdx`.

## Problem

`agent({ retry: { maxAttempts, baseDelay } })` doesn't do what the docs say.

1. **`baseDelay` is never read on an agent route.** Every agent-route path,
   including `/runs/wait`, goes through `streamAgent` → `processEventStream`
   (`packages/langchain/src/agent-adapter.ts`). Its backoff is hard-coded to
   `min(1000 * 2^n + jitter, 10s)`. The `withRetry` fallback that reads
   `baseDelay` only runs for a runnable with no `streamEvents`, which a
   `createAgent` graph always has.
2. **B4 retries the whole run, and only before anything reaches the client.**
   In a tool loop, the first model call streams, so a later failure is never
   retried by B4.
3. **A second retry layer ignores the knob.** Every LangChain chat model sends
   each request through `@langchain/core`'s `AsyncCaller` (`maxRetries`
   defaults to 6; `@langchain/openai` sets the OpenAI client's own retries to
   0). So `maxAttempts: 1` doesn't fail fast, and B4's run-level retry
   multiplies with LangChain's.

## What LangChain's layer already does (verified in @langchain/core 1.2.12, @langchain/openai 1.5.13)

- Retries **each model request**, including later calls in a tool loop.
- For streaming, wraps only the request that opens the stream
  (`completionWithRetry`); tokens are consumed outside the retry, so it never
  re-emits streamed tokens. A stream that drops mid-response is not retried.
- Classifies errors: 5xx and network errors retry; a 429 with a
  `Retry-After` of 60s or less is waited out; a quota 429 is thrown as not
  retryable (`RateLimitQuotaExhaustedError`); a headerless 429 or a long
  `Retry-After` is thrown as a retryable `RateLimitCapacityError`, leaving the
  decision to the app. Errors are stamped with `retryable` and rate-limit
  metadata.
- Backoff is p-retry's default (1s, doubling, randomised). `AsyncCaller`
  accepts only `maxConcurrency`, `maxRetries` and `onFailedAttempt`, so the
  backoff can't be configured.

## Decision (Brian, 2026-09-28)

Map the knob onto LangChain, and add a thin B4 layer only for what LangChain
hands back.

1. **`maxAttempts` → the chat model's `maxRetries`.** Where B4 constructs a
   chat model for an agent route, it passes `maxRetries: maxAttempts - 1`
   (default `maxAttempts` 3 → 2 retries). `maxAttempts: 1` fails fast. This
   applies to every built-in provider, since every LangChain chat model takes
   `maxRetries`. A model instance the author constructs themselves keeps the
   `maxRetries` they gave it; the docs say so.
2. **A thin B4 layer for capacity 429s.** B4's agent middleware
   (`wrapModelCall`) retries a model call that fails with a retryable
   `RateLimitCapacityError` (headerless 429, or a `Retry-After` too long for
   LangChain to wait out). That error arises when the request is made, before
   any token, so retrying it can't duplicate output. It uses
   `min(baseDelay * 2^n + jitter, 10s)`, or the error's `retryAfterMs` when
   present (still capped). The attempts share the same `maxAttempts` budget.
   This is where `baseDelay` applies.
3. **Remove the run-level retry for agent routes.** `processEventStream` no
   longer restarts a run on error. Non-agent runnables keep their current
   behaviour unless the plan finds they also build chat models through B4.
4. **Docs.** `retry.mdx` describes exactly this: what's retried and where,
   that each model call retries independently, that streamed tokens are never
   repeated and a mid-stream drop isn't retried, what `baseDelay` controls,
   how quota errors behave, and that an author-built model instance keeps its
   own `maxRetries`. Every example is true. `RetryConfig`'s JSDoc matches.
5. **Patch changeset** for `@b4run/langchain` (and `@b4run/sdk` if its JSDoc
   changes). This changes runtime behaviour: the default goes from
   LangChain's silent 6 retries plus B4's run-level retry to 3 attempts per
   model call.

## Non-negotiables

- Tests prove, with fake models that throw LangChain-shaped errors (status,
  headers, `retryable` stamps) and a fake clock:
  - `maxRetries` reaches the constructed model for each built-in provider the
    factory builds, including `maxAttempts: 1` → `maxRetries: 0`;
  - a `RateLimitCapacityError` on the second model call of a tool loop is
    retried with `baseDelay` backoff, and the run completes;
  - a quota 429 isn't retried;
  - `retryAfterMs` is honoured and capped;
  - a mid-stream failure after tokens is not retried and no token is emitted
    twice;
  - the run-level retry is gone (no restart of a run that already streamed,
    and no restart before streaming either);
  - abort during a backoff wait stops the retry.
- No reliance on error-message string matching where LangChain's stamps
  exist; keep `isRetryableError` exported (public API) but don't use it for
  the new layer if the stamps suffice.
- `exactOptionalPropertyTypes`: conditional spreads, never `{ x: undefined }`.
- `apps/web` content change → regenerate the lastmod `/docs/retry` entry.

## Out of scope

- Retrying after partial output (mid-stream drops). Documented as a limit.
- Retry for tools (the `retry-flaky-tools` recipe is separate).
- Configurable backoff for LangChain's request-level retries (not possible
  through `AsyncCaller`).
