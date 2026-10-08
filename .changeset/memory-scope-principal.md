---
"@b4run/core": patch
"@b4run/cli": patch
"@b4run/sdk": patch
---

Long-term memory can now be scoped to the caller. `memory.resolveScope` runs per request and receives `principal`, the caller `src/auth.ts` resolved, so `resolveScope: ({ principal }) => (principal ? { user: principal.id } : {})` gives each caller its own memory.

**Behavior change:** a dimension a route's `memory.ts` declares and `resolveScope` leaves without a value now makes memory unavailable for that request. `remember` and `recall` answer that memory is unavailable, the memory index is empty, and no episode is recorded. The request no longer falls back to the shared `workspace+route` namespace. An app that declared `user` or `tenant` without resolving it must resolve it, or drop the dimension.

With a `src/auth.ts`, `GET /memory/candidates` lists only the caller's own namespaces (and shared ones), and approving or rejecting another caller's candidate answers `404`. `defineAuth` accepts `canReviewMemory(principal)` to let a reviewer see every namespace. Apps without an auth file are unchanged.
