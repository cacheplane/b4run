---
"@b4run/sdk": patch
"@b4run/cli": patch
---

Add optional `setup(ctx)` and `dispose()` lifecycle hooks to `defineMiddleware`. The object form `defineMiddleware({ setup, dispose, handle })` runs `setup` once, lazily, before the first gated request, shares one in-flight call across concurrent first requests, and retries it on the next request if it rejects, so a transient outage never poisons the process. `dispose` runs from the Node runtimes' shutdown path after in-flight requests drain. The function form is unchanged.
