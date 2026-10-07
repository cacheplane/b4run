# One app-level principal resolver — design proposal

Status: **proposal.** Research for a single "who is calling" seam that every authorization consumer
reads, so no consumer parses headers itself. Related: cacheplane/b4run#940 (memory scope cannot see
the request principal).

Decided with Brian on 2026-10-07:

- **Reuse `src/auth.ts`.** It must default-export `defineAuth(...)`.
- **Breaking changes are allowed.** No compatibility shims.
- **The LangSmith target compiles `src/auth.ts` into `langgraph.json` `auth.path`** instead of
  refusing it. The spike (§5) shows this works, with three caveats that the build must handle.
- **Ship `ownedThreads({ owner, adminsRead })`** (§5.4) as a branded `defineThreadAccess` value.
  Both runtimes understand it, and it becomes the scaffold default.
- **On LangSmith, clients create the thread with `POST /threads` first.** A run on an unknown
  client-chosen id returns 404 there, and the docs say so. The node runtime keeps implicit create.
- **navlog memory becomes per-visitor, with auto writes, and its baseline moves into `workspace/`**
  (§7.1).

## 1. Problem

The navlog example authorizes in three places, and each one reads request headers itself:

| Consumer | File | What it reads |
|---|---|---|
| Route middleware | `examples/navlog/server/src/middleware.ts` | `principalOf(req.headers)` → `allow({ visitorId })` / `reject(401)` |
| Thread access | `examples/navlog/server/src/thread-access.ts` | `principalOf(req.headers)` in `create` and in `fallback` |
| Process guard | `examples/navlog/server/main.mjs` (`tokenGuard`) | `request.headers["x-internal-token"]`, with its own `timingSafeEqual` |

`src/auth.ts` keeps the first two consistent by convention, and its comment says so: "Nothing makes
them agree". The scaffold ships the same convention (`packages/devkit/templates/app-basic/src/auth.ts.example`,
`app-navlog/server/src/auth.ts`). `examples/software-factory/server/src/thread-access.ts` parses
`authorization` inline instead. Memory has no access to the caller at all (#940), and the
`/memory/*` review routes have no gate.

## 2. Current state: where B4.run reads "who is calling"

**There is no principal concept in the runtime.** Identity exists only as whatever a consumer
derives from `headers` and passes on.

### 2.1 Header reads for identity

All of these go through `headersToRecord(request.headers)` (`packages/cli/src/lib/dev/middleware.ts:159`):
lowercase keys, repeated headers joined with `", "`. **On a run endpoint the same `Request` is
converted at least twice** (once for middleware, once in `makeThreadGate`, `thread-gate.ts:176`).

| Site | Where | Endpoints |
|---|---|---|
| Middleware `handle` | `runMiddleware` (`middleware.ts:147`) | `POST /threads/:id/runs/{stream,wait}` (`runtime-fetch-core.ts:2664`, `:3142`), `POST /threads/:id/resume` (`:4371`), `GET …/pending_interrupts`, `/turns`, `/events` (`gateThreadRead`, `:3795`; context discarded), `GET …/runs/stream` attach (`:4024`, once per owning route), `POST /agui/:routeId` (`agui-handler.ts:539`), `GET /agui/:routeId` (`agui-capabilities.ts:162`) |
| Thread-access policy | `makeThreadGate` (`thread-gate.ts:171`) | Every `/threads/*` endpoint, `/agui/:routeId`, `/workspace/inspect`, `PUT /workspace/sources/:digest` |
| `serve({ guard })` | `packages/cli/src/lib/dev/serve.ts:30,145` | Every request including health checks; Node `IncomingMessage`; returns `boolean` only, so **it cannot pass anything downstream** |
| `/memory/candidates*` | `runtime-fetch-core.ts:2075-2114` | **No identity read, no gate** (listed `EXEMPT` in `packages/cli/test/thread-access-coverage.test.ts:59`) |

Non-identity header reads (`accept`, `origin`, CORS preflight, `content-length`, inspector's
`host`/`origin` localhost guard) are out of scope.

### 2.2 Ordering

- Stream, wait, and AG-UI run **middleware, then thread access** (`:2674`→`:2690`, `:3152`→`:3166`,
  `agui-handler.ts:548`→`:633`).
- Resume, `pending_interrupts`/`turns`/`events`, and attach run **thread access, then middleware**
  (`:4225`→`:4381`, `:3660`→`:3808`, `:3941`→`:4026`).
- Thread CRUD, cancel, `/state`, and workspace endpoints run **thread access only**.

So neither existing hook can be the identity source for the other. Middleware is route-keyed and
doesn't run on thread CRUD. Thread access runs only where there is a thread.

### 2.3 Where identity flows after it is read

- **Middleware context → tools.** `allow(ctx)` becomes `middlewareContext`, then
  `createB4Context({ middleware })` (`execute-route-core.ts:646,2115`) or
  `convertToolToLangChain(tool, middlewareContext)`, which sets `ctx.middleware`
  (`langchain/src/tool-converter.ts:162`). Subagents inherit it (`execute-route-core.ts:1900`). It is
  captured in tool closures and never written to the checkpoint. A middleware context bypasses
  the materialized-graph cache (`agent-adapter.ts:175`). On resume, middleware runs again, so the
  remaining tools run under the *resumer's* context.
- **Thread-access stamp → thread row.** A `permit(stamp)` on `create` is stored under `b4:access`
  and surfaced as `req.thread.access`. This is the only persisted identity, and staged-workspace
  uploads reuse it as `principal` (`staged-source-store.ts:117,170`).
- **Memory.** `resolveScope?: (ctx: { routePath; appRoot }) => Record<string,string>`
  (`core/src/types.ts:421`) is called once per request at `execute-route-core.ts:1606`. The
  function's options already hold `middlewareContext` (`:432`); only the callback type keeps it
  out. `resolveScope` is a function in `b4.config.ts`, so it is stripped from web-runtime builds
  (`build/targets/web-runtime.ts:938`).
- **Approval grants and permissions.** Keyed by `(threadId, interruptId)` and `(tool, pattern)`.
  They are deliberately not bound to a caller ("thread access answers who",
  `approval-grants.ts:15`). Nothing records who approved.

### 2.4 Failure behavior today

- A middleware or thread-access throw propagates to the `serveRoutes` catch-all and returns an
  opaque 500 (fail closed).
- A middleware return that isn't `reject` counts as continue. An `undefined` return throws
  `TypeError`, which returns 500.
- A malformed thread-access return is a deny.
- **LangSmith target:** `assertNoThreadAccessPolicy` refuses the build (`B4_E1005`,
  `build/targets/langsmith.ts:17`). Middleware is **silently dropped**; there is no equivalent
  refusal.

## 3. How comparable frameworks do it

| Framework | Shape | Borrow | Avoid |
|---|---|---|---|
| **LangGraph Platform custom auth** | `auth.authenticate(request) → { identity, permissions, …}` runs once per request. `auth.on("threads:create", …)` handlers receive `ctx.user` and stamp/filter metadata. The user reaches graphs as `config.configurable.langgraph_auth_user`. A raised `HTTPException` maps to its status. The handler is registered by path in `langgraph.json` (`auth.path`). | Authenticate-once, then authorize per resource with the *resolved* user. Exceptions map to statuses. The same identity reaches resource policies and the graph. | Handlers that return query *filters* (B4 has no thread search, and filter semantics leak into store queries). Putting the user in `configurable`, where it is checkpointed alongside run config. |
| **Next.js middleware + Auth.js** | Middleware runs separately (Edge) from route handlers. `auth()` is re-derived wherever it is called. | Nothing structural. | The well-known gap where middleware-only checks (CVE-2025-29927, `x-middleware-subrequest`) are bypassed and handlers re-parse the session. This is the two-parser confused deputy B4 wants to remove. |
| **tRPC** | `createContext({ req })` runs once per request. Procedures receive `ctx`; middleware narrows `ctx.user` from nullable to non-null (`protectedProcedure`). | One context factory. Type narrowing gives "authenticated" handlers a non-null principal. | Nothing significant. |
| **Hono** | `app.use(auth)` calls `c.set("user", …)`. `Variables` typing makes `c.get("user")` typed downstream. | Typed per-request variable bag. | Order-dependent `set`/`get`, where a handler mounted before the middleware sees `undefined`. |

The common shape: **one resolver per request, resolved before any authorization decision, with the
result typed and passed down rather than re-derived.** LangGraph's split, `authenticate` vs.
`on(resource)`, maps almost one to one onto B4's split between a resolver and
middleware/thread-access policies.

## 4. Options

### Option A — `src/auth.ts` default export, `defineAuth()` (recommended)

A third discovered file, loaded exactly like `middleware.ts` and `thread-access.ts`: fixed-path
probe, `default ?? auth` export, emitted by `modules-emitter.ts` for node and web targets.

```ts
// @b4run/sdk
export interface AuthRequest {
  readonly headers: Readonly<Record<string, string>> // lowercase, ", "-joined
  readonly method: string
  readonly url: string
}
export type AuthResult<P> = P | undefined | RejectResult // reject() reused from middleware
export interface AuthDefinition<P extends B4PrincipalShape> {
  readonly authenticate: (req: AuthRequest) => Promise<AuthResult<P>> | AuthResult<P>
  readonly setup?: (ctx: { appRoot: string }) => Promise<void> | void // same semantics as middleware
  readonly dispose?: () => Promise<void> | void
}
export interface B4PrincipalShape { readonly id: string }
export function defineAuth<P extends B4PrincipalShape>(def: AuthDefinition<P>): AuthDefinition<P>
```

```ts
// examples/navlog/server/src/auth.ts
export default defineAuth({
  async authenticate({ headers }) {
    const user = await principalOf(headers) // body unchanged
    return user ?? reject(401, { error: "unauthorized" })
  },
})

// middleware.ts: no header parsing. Or delete it; see migration.
export default defineMiddleware((req) => (req.principal ? allow() : reject(401)))

// thread-access.ts
create: (req) => (req.principal ? permit({ ownerId: req.principal.id }) : deny()),

// b4.config.ts (#940). The principal arrives as an argument.
memory: { resolveScope: ({ principal }) => (principal ? { user: principal.id } : {}) }

// any tool
execute: async (input, ctx) => ctx.principal?.id
```

**Runtime contract:**

1. **Once per request, before every gate.** `runtime-fetch-core.ts` resolves the principal at the
   top of `serveRoutes`, for every runtime endpoint except `/healthz`, `/readyz`, and CORS
   preflight. It is memoized per `Request` in a `WeakMap<Request, Promise<…>>`, so the
   middleware-first and thread-access-first orderings both read the same value, and attach (which
   runs middleware once per route) never re-resolves. `headersToRecord` runs once.
2. **Result handling:**
   - `reject(...)`: that response is returned before any endpoint logic runs.
   - `undefined`: an *anonymous* request. `req.principal` is `undefined`, and every consumer decides
     what that means, which is today's behavior.
   - A throw or rejection: opaque 500, consistent with middleware. **Never** downgraded to
     anonymous.
   - A non-object, or an object without a string `id`: 500 with a boot-style error code, not
     anonymous.
3. **Passed, never re-derived.** The principal is frozen (`Object.freeze`, shallow) and passed as:
   - `principal` on `MiddlewareRequest`, `MiddlewareAfterRun`, and `ThreadAccessRequest`
   - the `resolveScope` ctx
   - `B4ToolContext.principal`, including subagents
   - the `/memory/*` handlers

   **Breaking:** `headers` is removed from `ThreadAccessRequest`. Its only job there was identity,
   and leaving it in keeps the second-parser hazard alive. `MiddlewareRequest` keeps `headers` for
   non-identity uses such as locale, feature flags and rate-limit keys, and its docs say "authorize
   against `principal`".
4. **Never persisted.** It is captured the way `middlewareContext` is: closures only, never
   `configurable` or the checkpoint. A resume runs under the resumer's principal, matching today's
   middleware semantics. A non-`undefined` principal must bypass the materialized-graph cache the
   same way a middleware context does (`agent-adapter.ts:175`). **That cache key is the
   cross-thread leakage risk, and it needs a test.**
5. **Typing.** Typegen discovers `src/auth.ts` and emits an ambient
   `declare module "@b4run/sdk" { interface B4Register { principal: Exclude<Awaited<ReturnType<typeof auth.authenticate>>, RejectResult | undefined> } }`.
   SDK types read `B4Register["principal"]`, falling back to `B4PrincipalShape` when there is no
   auth file. Typegen already emits ambient `declare module "b4:routes"` blocks (`core/src/typegen/render-route-types.ts:31`). Augmenting `@b4run/sdk` itself would be new. The alternative is a `b4:auth` virtual module the SDK types import, which is open question 5.

**Pros:**
- Matches the two existing discovered files.
- Works on node and web builds (unlike a function in `b4.config.ts`).
- The `src/auth.ts` filename is already where scaffolded apps keep `principalOf`, so migration is
  one added export.

**Cons:**
- A third reserved file.
- `src/auth.ts` becomes reserved. **Decided: it must default-export a branded `defineAuth(...)`.**
  A missing or unbranded default is a boot and build error (`B4_E3005`, currently unused), with a
  message pointing at `defineAuth`. There is no inert mode, because an `auth.ts` the runtime ignores
  is exactly the convention-only state this design removes. So today's navlog and scaffold
  `auth.ts` files (named `principalOf` only) migrate in the same PR that lands the runtime.

### Option B — `config({ auth })` in `b4.config.ts`

```ts
export default config({ auth: { authenticate: ({ headers }) => principalOf(headers) } })
```

The runtime contract is the same as A. Rejected as the primary option:

- Functions in `b4.config.ts` are stripped from web-runtime builds today (`resolveScope`,
  `web-runtime.ts:938`), so this needs new serialization machinery that A gets for free from
  `modules-emitter.ts`.
- `B4Config` has no runtime schema, so every key needs bespoke shape validation.
- It splits authorization code between config and `src/`.

### Rejected — "just pass middleware context through" (#940's proposal alone)

Passing `middleware` to `resolveScope` fixes #940 for run endpoints and is a one-line change at
`execute-route-core.ts:1606`. But it doesn't remove the duplicate parse:
- Thread access runs *before* middleware on resume, reads, and attach.
- Middleware doesn't run at all on thread CRUD or `/memory/*`.

So thread access would still have to parse headers itself. It's a reasonable stopgap only if A is
deferred.

## 5. LangSmith: compiling `src/auth.ts` to `auth.path` (spike, 2026-10-07)

### 5.1 What LangGraph does

These facts come from `@langchain/langgraph-api` source (`src/auth/index.mts`, `custom.mts`,
`utils/run-auth.mts`), checked against `langgraphjs dev` (`@langchain/langgraph-cli` latest,
Node 24):

- **Loading.** `langgraph.json` `auth.path` (`"./file.ts:export"`) is imported once at boot and
  must be an `Auth` instance from `@langchain/langgraph-sdk/auth`. The check is `"~handlerCache" in
  module`.
- **`authenticate`.** `authenticate(request: Request)` runs once per request on every path except
  `/info` and `GET /ui*`. It must return a string or `{ identity, permissions?, ...extra }`.
  - Anything else, including `undefined`, throws and becomes a **500**.
  - A thrown `HTTPException(status, { message })` becomes that status with the message as body.
  - Any other throw becomes a 500.
- **`auth.on(event, cb)` handlers.** They see `{ user, permissions, value }`. For threads, `value` is
  the request payload (`thread_id`, `metadata`). **They never see the stored row.**
  - Returning `false` → 403.
  - Returning `undefined` or `true` → allowed.
  - Returning an object → a metadata **filter** (`{ key: value }` or `$eq`/`$contains`) that the
    server matches against the stored thread's `metadata`. A mismatch reads as 404.
  - Mutating `value.metadata` on `threads:create` stamps the row.
  - Handler lookup goes `resource:action` → `resource` → `*:action` → `*`. With no handler at all,
    the request is allowed.
- **User in graphs.** The user reaches graphs as `config.configurable.langgraph_auth_user`, with
  `langgraph_auth_user_id` and `langgraph_auth_permissions` alongside it.
- **Header copying.** Every `x-*` request header except `x-api-key`, `x-tenant-id` and
  `x-service-key`, plus `user-agent`, is **copied into `config.configurable`**.
- **Studio bypass.** `x-auth-scheme: langsmith` skips `authenticate` entirely and authenticates as
  `langgraph-studio-user`, unless `auth.disable_studio_auth: true`.

### 5.2 The compiled adapter

What `b4 build --target langsmith` would emit as `.b4/build/auth.ts`, with `auth.path` pointing at
it:

```ts
import { Auth, HTTPException } from "@langchain/langgraph-sdk/auth" // via a @b4run/langgraph re-export
import app from "../../src/auth.js"

export const auth = new Auth()
  .authenticate(async (request) => {
    const url = new URL(request.url)
    const result = await app.authenticate({
      headers: headersToRecord(request.headers),
      method: request.method,
      url: url.pathname + url.search,
    })
    if (isReject(result)) throw new HTTPException(result.status, { message: JSON.stringify(result.body ?? {}) })
    if (result === undefined) throw new HTTPException(401) // LangGraph cannot represent anonymous
    return { identity: result.id, permissions: [], b4_principal: result }
  })
  // Compiled only from the declarative owner policy (§5.4).
  .on("threads:create", ({ user, value }) => { value.metadata ??= {}; value.metadata["b4:owner"] = user.identity })
  .on("threads:update", ({ user, value }) =>
    value.metadata && "b4:owner" in value.metadata ? false : { "b4:owner": user.identity })
  .on(["threads:read", "threads:delete", "threads:search", "threads:create_run"], ({ user }) => ({ "b4:owner": user.identity }))
  .on(["assistants:read", "assistants:search"], () => true)
  .on("*", () => false) // deny-by-default floor, like thread access's required `fallback`
```

`langgraph.json` gets `"auth": { "path": "./.b4/build/auth.ts:auth", "disable_studio_auth": true }`.

### 5.3 Results

The probes ran against a `langgraphjs dev` server. Visitors A and B each send a valid token.

| # | Probe | Result |
|---|---|---|
| 1 | No token | **401** with the app's `reject` body |
| 2 | Resolver throws | **500** (fail closed) |
| 3 | Resolver returns `undefined` | **401** (mapped) |
| 4 | A creates a thread with forged `metadata["b4:owner"] = B` | Stamp overwritten to A ✓ |
| 5 | A runs on it | Graph sees `langgraph_auth_user.b4_principal = { id, isAdmin, org }` ✓ |
| 6–8 | B reads, runs on, or searches A's thread | 404 / 404 / `[]` ✓ |
| 9 | A `PATCH`es `b4:owner` to B (first version, no update guard) | **200, and B could then read the thread.** Fixed by the `threads:update` reserved-key guard → 403 |
| 10 | B creates A's id via `runs/wait` `if_not_exists: "create"` | 404 ✓ |
| 11 | `x-auth-scheme: langsmith`, no token (`disable_studio_auth: false`) | **200, thread created as `langgraph-studio-user`.** Fixed by `disable_studio_auth: true` → 401 |
| 12 | `assistants/search` under the bare `*` floor | 403. That breaks LangGraph SDK clients, hence the explicit `assistants:read/search` allow |
| 13 | `store` put | 403. B4 memory doesn't use the LangGraph store, so this is correct |

**Three caveats the build must handle:**

1. **Implicit thread creation is lost.** A run on a new client-chosen id (`if_not_exists: "create"`)
   returns 404 under the owner filter. `threads:create_run` filters before the row exists, and
   stamping its `value.metadata` stamps the run, not the thread.
   - B4's node runtime creates and stamps in this case. On LangSmith, clients must `POST /threads`
     first.
   - This is fail closed. It's a documented divergence, not a hole.
2. **Header secrets leak to thread owners.** The `x-*` copy put `x-internal-token` (navlog's shared
   proxy secret) into the run config, stored on the thread. **Any authenticated visitor can read it
   back** with `GET`/`PATCH /threads/:id`, then mint any visitor id. navlog's pattern is therefore
   unsafe on LangSmith.
   - The build should refuse (or at least loudly warn) when `src/auth.ts` reads an `x-*` header as a
     secret. Detection is heuristic: a `headers["x-…"]` read inside a `safeEqual`/`timingSafeEqual`
     call.
   - The docs should say to use `authorization` there. It isn't copied.
3. **The principal is persisted.** `langgraph_auth_user`, including the full `b4_principal`, is stored
   in the thread's config and returned to the owner.
   - "Never persisted" holds on node and web targets, not on LangSmith.
   - The rule becomes target-independent: **a principal must carry no secrets.**

### 5.4 What compiles and what doesn't

- **`defineAuth` compiles fully.**
  - `reject` → `HTTPException`; throw → 500.
  - `undefined` → 401. LangGraph has no anonymous user, so a B4 app that relies on anonymous
    callers can't target LangSmith, and the build says so when the resolver's return type includes
    `undefined`.
  - `setup` runs lazily on first `authenticate`, as on node.
  - `dispose` has no hook on that target.
- **`defineThreadAccess` does not compile in general.** B4 policies are arbitrary functions over the
  stored row (`req.thread.access`). LangGraph handlers never see the row and can only return
  equality filters on metadata. Only the owner policy compiles, and only from a **declarative**
  form B4 can recognize without reading user code. Sketch:

  ```ts
  export default ownedThreads({ owner: (p) => p.id, adminsRead: (p) => p.isAdmin })
  ```

  - This needs a B4 helper that returns a branded `defineThreadAccess` value. On node it is the
    navlog policy above; on LangSmith it compiles to the §5.2 handlers.
  - `adminsRead` can't be expressed as a filter, so on LangSmith admins read nothing. The build
    warns.
  - A hand-written `defineThreadAccess` keeps today's `B4_E1005` refusal on this target.
- **The principal reaches tools.** `convertToolToLangChain` already reads `threadId`/`params` from
  `config.configurable` per call, so `ctx.principal` comes from
  `configurable.langgraph_auth_user.b4_principal` on this target. Graphs are materialized once at
  module load, so nothing is cached per principal.
- **Memory scope (#940) needs invoke-time resolution here.** `materializeResolvedRouteGraph` runs
  `prepareRouteExecution` once at module load (`execute-route-core.ts:519`), which fixes the
  namespace before any request. Per-principal scope on LangSmith means resolving the memory
  namespace in the remember/recall tools from `config.configurable`, not at preparation.
- **Middleware** is still not materialized on this target. With `src/auth.ts` compiled, an app that
  used middleware only for authentication no longer needs it there. The silent drop of
  `src/middleware.ts` should become a build warning in the same PR.
- **Dependency.** The emitted file imports `@langchain/langgraph-sdk/auth`. Re-export it from
  `@b4run/langgraph` so the app's dependency set (`extractDeploymentConfig`) doesn't need a new
  direct dependency.
- **What the spike did not verify:** hosted LangSmith Deployment, only the open-source
  `langgraphjs dev` server. Whether the hosted platform also trusts `x-auth-scheme` and copies `x-*`
  headers the same way needs one deploy before the docs make claims. `disable_studio_auth: true`
  and the `x-*` refusal are safe either way.


## 6. Recommendation

**Option A**, landed in three PRs:

1. **SDK + runtime.**
   - `defineAuth`/`AuthRequest`/`AuthDefinition` exports.
   - Discovery, the build emitter, once-per-request resolution with the WeakMap memo.
   - `principal` on the middleware, thread-access, and tool contexts.
   - Graph-cache bypass.
   - Tests:
     - throw → 500
     - malformed → 500
     - `reject` precedes every gate
     - one call per request across both orderings
     - two concurrent threads with different principals never share a materialized graph
   - Typegen `B4Register`.
2. **Memory (#940).**
   - Add `principal` to the `resolveScope` ctx.
   - Gate `/memory/*` on the principal. The default when an auth file exists is open; the gate
     itself is open question 1.
   - Scope candidate listing by namespace when `resolveScope` uses the principal.
3. **Migration.** navlog, the scaffold templates, the software-factory server, and docs. This must
   land together with PR 1, because PR 1 makes a named-export-only `src/auth.ts` a boot error.
   In practice PRs 1 and 3 are one PR, or PR 3 is stacked on PR 1 and merged with it.
4. **LangSmith compile (§5).**
   - The `auth.path` emitter.
   - The thread-access compile, or the refusal for policies it can't compile.
   - `ctx.principal` from `langgraph_auth_user` (the user record LangGraph puts in `config.configurable`).
   - The `x-*` secret refusal.
   - Invoke-time memory namespace.
   - A `langgraphjs dev` harness lane.

serve's `guard` stays a transport-level, pre-routing gate (it also covers non-runtime paths and is
defense in depth). It isn't folded into the resolver.

## 7. Migration and compatibility

- **Optional, but not convention-only.** With no `src/auth.ts`, `principal` is `undefined`
  everywhere and every policy behaves as now, apart from the removed `ThreadAccessRequest.headers`.
  If a `src/auth.ts` exists, it must default-export `defineAuth`.
  - `examples/chat`, `examples/memory`, and `examples/code-fixer` have no auth files and need no
    change.
  - Any thread-access policy that read `req.headers` must move that read into `src/auth.ts`. This
    applies to navlog, software-factory `server` and `drafter`, and the app-basic example.
- **navlog** (`examples/navlog/server` and `packages/devkit/templates/app-navlog/server`):
  - `auth.ts` gains the default export.
  - `middleware.ts` drops `principalOf`. Since auth now rejects untokened requests globally, it
    becomes redundant and can be deleted (no tool reads `ctx.middleware.visitorId`; grep finds no
    reader).
  - `thread-access.ts` reads `req.principal`.
  - `memory.ts` adds the `user` dimension once PR 2 lands. The decision and its consequences are
    in §7.1.
  - `main.mjs` keeps `tokenGuard`.
- **app-basic template:**
  - `auth.ts.example` gains `export default defineAuth(...)`.
  - `thread-access.ts.example` reads `req.principal`.
  - Comments about "two parsers by convention" become "one resolver, enforced".
- **software-factory server:** its inline `authorization` parse moves into an `auth.ts`.
- **Docs and pins to update:**
  - `apps/web/content/docs/`:
    - new section in `access-control.mdx`, or a new `authentication.mdx` page
    - updates to `middleware.mdx`, `thread-access.mdx`, `memory/long-term.mdx`,
      `memory/retrieval.mdx`, `security-architecture.mdx`, `recipes/auth-middleware.mdx`,
      `configuration.mdx`, `persistence.mdx`, `memory/browse.mdx`, and
      `deployment/langsmith.mdx`
    - `api/sdk.mdx`: rows for `defineAuth`, `AuthRequest`, `AuthDefinition`, `AuthResult`, and
      `B4PrincipalShape`, plus an `api-contract` fence. `scripts/lib/docs-api-inventory.mjs` fails
      on any undocumented export.
  - `scripts/check-docs.mjs` pins that must change when #940 lands:
    - `memory/long-term.mdx` and `memory/retrieval.mdx` require "does not receive verified
      identity"
    - `retrieval.mdx` forbids "`resolveScope` receives verified identity"
    - `security-architecture.mdx` requires "/memory/candidates" + "bypass"
    - `recipes/auth-middleware.mdx` forbids "pass the verified user identity to every tool call"
      and requires "memory-candidate management"
    - nav labels, if a page is added
  - A new docs page also touches `nav.ts`, the CLI docs-bundle count (`docs-bundle.test.ts:435`,
    80), and the SEO lastmod manifest.
  - The `b4 docs` topic for the new page.
  - A patch changeset (fixed group).
- **LangSmith target.** `src/auth.ts` compiles to `auth.path` (§5).
  - `deployment/langsmith.mdx` loses "enforce authentication on the platform" as the only story.
  - `check-docs.mjs` pins on that page (`:2626-2634`) change with it.
  - navlog itself stays on the node target, because its auth pattern is the `x-*` secret the
    LangSmith build refuses (§5.3, item 2).

### 7.1 navlog per-visitor memory (decided 2026-10-07)

**Today.** One namespace is shared by every visitor (`["workspace", "route"]`) with
`writes: "candidate"`. A visitor's `remember` only proposes a write, and only the demo owner can
approve it (owner cookie, `web/app/lib/proxy-guard.ts:138`). Approved facts then apply to everyone.
For example, an approved `aircraft.tail_number` becomes every visitor's tail number.

**Decided.**

- **Scope.**
  - `memory.ts` declares `scope: ["workspace", "route", "user"]`.
  - `b4.config.ts` sets `resolveScope: ({ principal }) => (principal ? { user: principal.id } : {})`.
  - Each visitor (one browser: the `__Host-b4_visitor` cookie, one-year `Max-Age`) gets their own
    namespace.
  - `LOCAL_PRINCIPAL` (`local`) owns the namespace in development, harness and test runs.
- **`writes: "auto"`.** Isolation is what makes unreviewed writes acceptable on a public demo. A
  prompt-injected fact reaches only the visitor who planted it. The model still trusts its own
  memory, but the blast radius is one browser.
- **Baseline into `workspace/`.**
  - The C172N defaults the prompt now inlines (usable fuel 40/50 gal, cruise 2400 RPM, and the
    rest of `src/app/navlog/index.ts:13`) move to a workspace file, for example
    `workspace/aircraft/c172n.md`. The agent reads it alongside the POH tables.
  - `memory.md` and `plan.md` change from "recall the aircraft profile" to "read the baseline,
    then recall this pilot's overrides".
  - Memory holds only what the visitor said.
  - This part doesn't depend on the resolver and can land first.
- **The owner review flow leaves navlog.** No candidates are created, so the web proxy's
  owner-only `/memory/*` approve/reject branch, the owner cookie, and
  `npm run memory:approve` go. The docs drop "candidate review" as a navlog feature, and
  `examples/memory` remains the candidate-review example.
- **The principal must be resolvable wherever memory is.** Per-visitor memory on node and web
  targets needs PR 2. navlog stays on the node target, so the LangSmith invoke-time namespace work
  (§5.4) isn't on its critical path.

**Follow-ups this creates:**

- **Semantic records never expire.** `memory.episodes.ttlMs` covers episodes only, and
  `b4 memory prune` deletes only expired and over-cap episodic rows. Abandoned visitor namespaces
  accumulate forever in the demo's Postgres. This needs a semantic TTL, or a prune by
  namespace-last-write, before the change ships to the live demo.
- **Per-namespace caps.** A visitor can write unboundedly into their own namespace. This needs a
  write cap per namespace, enforced by `remember`.
- **Evals.** `navlog-quality.eval.ts` and the harness fixtures that seed or expect a shared aircraft
  profile must seed it per principal (`local`), or read it from the workspace file.

## 8. Security properties to preserve

- **Fail closed.**
  - A resolver throw, a malformed return, or a `setup` failure → 500 for that request (the `setup`
    failure is retried next request, as middleware does).
  - Never anonymous.
  - `undefined` is anonymous only when the resolver *returned* it.
- **Constant-time compare.** This stays the resolver author's job, but B4 should make the right
  thing easy. Offer an edge-pure `safeEqual(a, b)` in `@b4run/sdk`, since `node:crypto` is barred
  from B4 package source and `crypto.subtle` has no timing-safe compare. Use HMAC-both-then-compare
  or a length-checked XOR loop. Navlog's `sameSecret` and `main.mjs` would use it.
- **No cross-thread leakage.**
  - The principal is per request, frozen, and never written to checkpoints, `configurable`, thread
    metadata, or memory entries (except as a scope key the app chose).
  - Graph-cache bypass when it is set (§4.A.4).
  - The thread-access stamp remains the only persisted identity, and it remains the policy's
    explicit choice.
- **Strict header semantics.** The lowercase, `", "`-joined shape and the strict-equality guidance
  stay.
- **Existence oracle.** A global `reject` from `authenticate` happens before thread lookup, so it
  can't distinguish "not yours" from "never existed". Policies keep the
  `thread === undefined → deny` line.
- **LangSmith.** On this target "never persisted" can't hold. LangGraph stamps the user into the
  run's `config.configurable`, which is stored on the thread and returned to its owner (§5.3,
  item 3). The principal must therefore carry no secrets on any target, and the docs say so.
  Studio auth is disabled in the emitted config, and `x-*` header secrets are refused at build
  time.

## 9. Open questions

1. **`/memory/*` gate.** Should it be a fixed rule (principal required when an auth file exists), a
   predicate on `defineAuth` (`canReviewMemory(principal)`), or thread-access-style policy actions
   (`memory.candidates.list|approve|reject`)?
2. **Grant audit.** Should a consumed approval grant record `consumedBy: principal.id`? The grant
   stays caller-unbound by design; this would be audit only.
3. **Anonymous default.** Is "`undefined` = anonymous, consumers decide" right, or should an
   existing auth file make `undefined` a global 401 unless `defineAuth({ anonymous: "allow" })` is
   set? The latter is safer by default, but it can't express navlog's public `/healthz`-style
   paths without a per-endpoint escape hatch.
4. **CopilotKit runner.** `createB4AgentRunner` deliberately forwards no browser headers. Should
   the runner forward a server-minted principal assertion instead (signed, short-lived), so replay
   requests resolve the same principal?
5. **Principal typing.** Should typegen augment `@b4run/sdk`'s `B4Register`, or emit a `b4:auth`
   ambient module like `b4:routes`?
