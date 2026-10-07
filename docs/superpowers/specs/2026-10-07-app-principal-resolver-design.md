# One app-level principal resolver — design proposal

Status: **proposal, not decided.** Research for a single "who is calling" seam that every
authorization consumer reads, so no consumer parses headers itself. Related: cacheplane/b4run#940
(memory scope cannot see the request principal).

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

   `headers` stays on both request types (no breaking change), but the docs mark it as "transport
   detail; authorize against `principal`".
4. **Never persisted.** It is captured the way `middlewareContext` is: closures only, never
   `configurable` or the checkpoint. A resume runs under the resumer's principal, matching today's
   middleware semantics. A non-`undefined` principal must bypass the materialized-graph cache the
   same way a middleware context does (`agent-adapter.ts:175`). **That cache key is the
   cross-thread leakage risk, and it needs a test.**
5. **Typing.** Typegen discovers `src/auth.ts` and emits an ambient
   `declare module "@b4run/sdk" { interface B4Register { principal: Exclude<Awaited<ReturnType<typeof auth.authenticate>>, RejectResult | undefined> } }`.
   SDK types read `B4Register["principal"]`, falling back to `B4PrincipalShape` when there is no
   auth file. Typegen already emits ambient `declare module "b4:routes"` blocks (`core/src/typegen/render-route-types.ts:31`). Augmenting `@b4run/sdk` itself would be new. The alternative is a `b4:auth` virtual module the SDK types import, which is open question 8.

**Pros:**
- Matches the two existing discovered files.
- Works on node and web builds (unlike a function in `b4.config.ts`).
- The `src/auth.ts` filename is already where scaffolded apps keep `principalOf`, so migration is
  one added export.

**Cons:**
- A third reserved file.
- Reusing `src/auth.ts` means apps that already have a non-B4 `auth.ts` with a default export would
  break. Mitigate with a branded `defineAuth` return: an unbranded default is a boot error (`B4_E3005`),
  and a file with no default export is inert with no warning, so today's navlog and scaffold
  `auth.ts` files (named export only) keep working unchanged.

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

## 5. Recommendation

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
     itself is open question 3.
   - Scope candidate listing by namespace when `resolveScope` uses the principal.
3. **Migration.** navlog, the scaffold templates, the software-factory server, and docs.

serve's `guard` stays a transport-level, pre-routing gate (it also covers non-runtime paths and is
defense in depth). It isn't folded into the resolver.

## 6. Migration and compatibility

- **Optional, defaulting to today.** No `src/auth.ts` default export means `principal` is
  `undefined` everywhere and every existing policy behaves exactly as now.
  `examples/chat`, `examples/memory`, and `examples/code-fixer` have no auth files and need no
  change.
- **navlog** (`examples/navlog/server` and `packages/devkit/templates/app-navlog/server`):
  - `auth.ts` gains the default export.
  - `middleware.ts` drops `principalOf`. Since auth now rejects untokened requests globally, it
    becomes redundant and can be deleted (no tool reads `ctx.middleware.visitorId`; grep finds no
    reader).
  - `thread-access.ts` reads `req.principal`.
  - `memory.ts` adds the `user` dimension once PR 2 lands. **This is a product change**: per-visitor
    memory instead of shared candidates, so it's Brian's call (open question 4).
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
- **LangSmith target.** `src/auth.ts` with a default export is refused like thread access
  (`B4_E1005`-style). Middleware is silently dropped there, and an auth file dropped silently
  would fail open. See open question 1 for the better long-term answer.

## 7. Security properties to preserve

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
- **LangSmith.** Refuse the build when an auth file exists, until open question 1 is answered.

## 8. Open questions

1. **LangSmith.** LangGraph's `auth.authenticate` has almost exactly this resolver's shape. Should
   the langsmith target *compile* `src/auth.ts` into the deployment's `auth.path` (and, later,
   thread access into `auth.on("threads")` handlers), turning today's refusal into parity? This
   needs a spike on how the LangSmith build packages app modules.
2. **Filename.** Should it reuse `src/auth.ts`, which has the migration win but an ambiguity risk
   with existing default exports, or use a fresh `src/principal.ts`?
3. **`/memory/*` gate.** Should it be a fixed rule (principal required when an auth file exists), a
   predicate on `defineAuth` (`canReviewMemory(principal)`), or thread-access-style policy actions
   (`memory.candidates.list|approve|reject`)?
4. **navlog per-visitor memory.** Should navlog switch from shared candidate memory to per-visitor
   memory once #940 lands, or keep the shared memory as the demo?
5. **Grant audit.** Should a consumed approval grant record `consumedBy: principal.id`? The grant
   stays caller-unbound by design; this would be audit only.
6. **Anonymous default.** Is "`undefined` = anonymous, consumers decide" right, or should an
   existing auth file make `undefined` a global 401 unless `defineAuth({ anonymous: "allow" })` is
   set? The latter is safer by default, but it can't express navlog's public `/healthz`-style
   paths without a per-endpoint escape hatch.
7. **CopilotKit runner.** `createB4AgentRunner` deliberately forwards no browser headers. Should
   the runner forward a server-minted principal assertion instead (signed, short-lived), so replay
   requests resolve the same principal?
8. **Principal typing.** Should typegen augment `@b4run/sdk`'s `B4Register`, or emit a `b4:auth`
   ambient module like `b4:routes`?
