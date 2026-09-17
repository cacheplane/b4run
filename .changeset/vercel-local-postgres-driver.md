---
"@b4run/cli": patch
"@b4run/postgres-storage": patch
---

Let the `vercel` target's generated stores reach a plain Postgres without a WebSocket proxy, and document `B4_PG_WS_PROXY`.

- The Vercel `stores.mjs` now selects a driver per request: `@neondatabase/serverless` for a `*.neon.tech` host or when `B4_PG_WS_PROXY` is set, and a pooled `pg` connection (through the new `createPostgresPool` export of `@b4run/postgres-storage/node`) for every other host, so the built bundle runs against a local database with no proxy. `B4_PG_DRIVER=neon|pg` overrides the detection; `pg` is refused on the `hono` target.
- `B4_PG_WS_PROXY` accepts `host:port`, `ws://host:port`, or `wss://host:port` (the last keeps TLS on) on both targets, and any other scheme, path, or query is rejected with a message naming the variable and the accepted forms instead of failing inside the driver.
- `normalizeWsProxy` and `selectPostgresDriver` are exported from `@b4run/cli/fetch` for hand-composed store factories.
