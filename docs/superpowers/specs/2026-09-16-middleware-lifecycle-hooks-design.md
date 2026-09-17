# Middleware lifecycle hooks

Issue: cacheplane/b4run#683.

## Problem

`defineMiddleware` accepts only a request handler. A middleware that needs a
connection pool can open it at module scope, which runs I/O at import time and
turns a transient outage into a `B4_E3004` boot failure, or behind a
hand-written memoised getter that resets itself on rejection. Nothing releases
the pool on shutdown. Every app reinvents the same getter.

## Design

`defineMiddleware` keeps its function form unchanged and gains an object form:

```ts
export default defineMiddleware({
  async setup(ctx) { pool = new Pool(...) },
  async dispose() { await pool?.end() },
  handle(req) { ... },
})
```

- `setup(ctx)` runs at most once per runtime, lazily, before the first request
  the middleware gates. Concurrent first requests share one in-flight setup.
  `ctx` carries `appRoot`. It deliberately carries no shutdown `AbortSignal`:
  the fetch core mints signals per request because a signal shared across
  requests is not safe on workerd, and the same hazard would apply here.
- A `setup` rejection fails only the request that awaited it (the existing
  opaque `500`, cause logged to stderr) and clears the memo, so the next
  request retries. `handle` never runs before a successful `setup`.
- `dispose()` runs once from the runtime's shutdown path, after in-flight
  requests drain. It runs when there is no `setup`, or when `setup` completed
  successfully; an in-flight `setup` is awaited first. It never runs for a
  `setup` that never started or only ever failed, so a `dispose` does not have
  to guard against resources that were never opened. A `dispose` rejection is
  logged and does not wedge shutdown.
- State stays in module closures; `setup` returns nothing.

`B4Middleware` becomes the union of the handler function and the definition
object. `selectMiddlewareExport` (shared by the dynamic probe and the static
manifest) accepts either shape, so dev and every built target bind identically.

The runtime binds the definition once at boot (`bindMiddleware` in the pure
`dev/middleware.ts`, edge-safe), producing a handler with the lazy `setup`
folded in plus a `dispose`. Route handlers keep calling `runMiddleware` with a
plain handler and cannot bypass `setup` by construction.

## Shutdown wiring per target

| Target | Shutdown path | `dispose` |
|---|---|---|
| `b4 dev` child, `b4 start`, generated `server.mjs` | `SIGTERM`/`SIGINT` → `server.close()` → fetch-core `close()` | runs after the request drain |
| Hono/edge (`app.mjs`) | none: the host has no shutdown hook, and per-isolate pools are wrong on workerd anyway (`stores.mjs` opens one pool per request) | not invoked; documented |
| `langsmith` | no middleware materialized | n/a |

## Alternatives

- Runtime-owned memoised getter helper: still leaves shutdown unreleased.
- `setup` returning typed state threaded into `handle`: more API than the
  issue asks for; closures already carry the state.
- Eager `setup` at boot: makes an unreachable database a boot failure and
  would run I/O in global scope on edge.

## Validation

SDK tests for both forms. CLI unit tests for lazy setup, single-flight
concurrency, failure retry, dispose ordering and idempotence. A fetch-core
integration test proving a request triggers `setup` and `close()` triggers
`dispose`. Docs: middleware guide, SDK API page, SDK README. Patch changeset.
