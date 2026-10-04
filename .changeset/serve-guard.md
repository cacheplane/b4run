---
"@b4run/cli": patch
---

`serve()` accepts a `guard`: a handler that runs ahead of the runtime/fallback split for every request and may answer it itself (a 401 for a missing internal token, a 429, an origin rejection). It is the seam a single-process deployment uses to authenticate the whole service, health check included, before any route runs. `ServeGuard` is exported from `@b4run/cli` and `@b4run/cli/runtime`.

`serve({ fallback })` no longer crashes on a request target that does not parse as a URL (such as `GET //`) or on a fallback that throws synchronously; both now reach the fallback or answer 500.
