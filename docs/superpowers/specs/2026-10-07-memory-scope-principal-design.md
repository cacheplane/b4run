# Memory scope from the request principal (#940) — design proposal

Status: **decided 2026-10-07 (§5); implementation waits for resolver-spec PR 1 (#970).** No code changes. Issue: cacheplane/b4run#940. Builds on
draft PR #970, `docs/superpowers/specs/2026-10-07-app-principal-resolver-design.md` (the app-level
principal resolver; referred to below as "the resolver spec"). This is that spec's PR 2 ("Memory
(#940)"), worked out far enough to see what it still needs decided.

## 1. Why this is not implemented yet

#940 proposes passing the middleware context into `resolveScope`. The resolver spec rejects that
as the long-term shape (its §4, "Rejected — just pass middleware context through"):
- Middleware does not run on `/memory/*` or on thread CRUD, so the candidate routes could not
  see the same principal.
- Thread access runs before middleware on resume, reads and attach.

It replaces it with a `principal` resolved once per request by `defineAuth` in `src/auth.ts`. The
resolver spec is a draft with open questions. Three of them decide this API, so implementing now
would build against a moving target:

| Resolver spec open question | What it decides here |
|---|---|
| Q1 `/memory/*` gate | Who may list and approve candidates outside their own namespace (§3.3) |
| Q3 anonymous default | Whether `principal === undefined` can reach a route that declares `user` at all (§3.2) |
| Q5 principal typing | The type of `ctx.principal` in `resolveScope` (`B4Register` augmentation or `b4:auth`) |

## 2. What happens today

- `memory.resolveScope?: (ctx: { routePath; appRoot }) => Record<string, string>`
  (`packages/core/src/types.ts:445`). It is called in `prepareRouteExecution`
  (`packages/cli/src/lib/runtime/execute-route-core.ts:1607`), next to `buildMemoryContext`. On
  the node and web runtimes that runs per request. On the LangSmith target,
  `materializeResolvedRouteGraph` runs it once at module load (resolver spec §5.4).
- **A declared dimension with no value is dropped silently.** `buildMemoryContext`
  (`packages/cli/src/lib/runtime/memory-context.ts:41`) keeps only the declared dimensions that
  have a value. A route declaring `["workspace", "route", "user"]` whose `resolveScope` returns
  no `user` therefore writes to and recalls from the shared `workspace+route` namespace. Today
  that is harmless, because `user` can't vary per request yet. Once it comes from a principal,
  every anonymous caller would share one namespace, and so would any caller whose resolver
  forgot the key.
- The memory tools and the memory index prompt fragment are built from that one `MemoryContext`
  (`applyCapabilities(..., { memory })`, `:1705`). The LangChain adapter caches a materialized
  agent per descriptor and checkpointer unless the request carries middleware context, a
  subagent resolver, a response format or stream transformers
  (`packages/langchain/src/agent-adapter.ts:180`). A per-principal namespace would be baked into
  whichever graph got cached first.
- `GET /memory/candidates` lists candidates across **every** namespace
  (`packages/cli/src/lib/dev/memory-handler.ts:19`, `listCandidates("")`). Approve and reject take
  a bare id, and none of the three is gated (resolver spec §2.1).

## 3. Proposal (lands after resolver-spec PR 1)

### 3.1 API

```ts
memory: {
  resolveScope?: (ctx: {
    readonly routePath: string
    readonly appRoot: string
    /** The request's principal from src/auth.ts; undefined with no auth file or an anonymous caller. */
    readonly principal: B4Principal | undefined
  }) => Record<string, string>
}
```

Additive: an existing `resolveScope` ignores the new key. We don't add `middleware` to the
context, because the principal is what the candidate routes can also see. If Brian defers the
resolver spec, `middleware` is the stopgap (decision D1).

### 3.2 Per-request namespace, failing closed

1. `prepareRouteExecution` passes the request principal (from resolver-spec PR 1) into
   `resolveScope`. No caching change is needed on node/web, since that runs per request already.
2. **A declared dimension left unresolved fails closed.** If a route declares `user` or `tenant`
   and `resolveScope` returns no value for it, the memory capability is built in a "no
   namespace" state: `remember` and `recall` return a tool error saying the caller has no memory
   scope, and the memory index fragment is omitted. The shared fallback namespace is never used.
   - `workspace` and `route` stay as they are, because they always have values.
   - This is a **behavior change** for an app that declares `user` today and never resolves it.
     Such an app currently writes to the shared namespace and would start erroring. The
     alternative is an explicit opt-in, `memory.anonymousScope: "shared"` (decision D2).
3. **Graph cache.** Bypass the materialized-agent cache whenever the memory namespace came from a
   principal, keyed off "`resolveScope` read `principal`". Simplest form: bypass whenever
   `principal !== undefined` and the route has memory. Resolver-spec PR 1 already bypasses on a
   principal for tools, so this may need nothing extra; the implementation must assert it with
   a two-principal test.
4. **LangSmith.** Out of scope here and deferred to resolver-spec PR 4, which resolves the
   namespace inside the remember/recall tools from `config.configurable`. Until then a route
   whose `resolveScope` reads `principal` fails the LangSmith build. It must not compile to one
   module-load namespace.

### 3.3 Candidate review

- `GET /memory/candidates`: for each route with `memory.ts`, compute the namespace from the
  request principal as in §3.2, and list candidates only in those namespaces.
  - A caller with no resolvable namespace gets an empty list, not every namespace.
- `POST /memory/candidates/:id/approve|reject`: load the record and refuse with 404, not 403, when
  its namespace isn't one of the caller's. A 404 doesn't reveal which ids exist.
- **Cross-namespace review (owner/admin) needs resolver-spec Q1.** Today's
  list-everything behavior becomes whatever that gate allows: a fixed rule, a
  `canReviewMemory(principal)` predicate, or policy actions. Until it's decided, cross-namespace
  review is unavailable over HTTP whenever an auth file exists. The `b4 memory` CLI (local,
  operator-run) keeps listing everything.

### 3.4 Docs and pins

The resolver spec §7 already lists most of the docs pages and the `check-docs.mjs` pins that
change. For this part:
- `memory/long-term.mdx` loses the deferred bullet "`resolveScope` gets no verified request
  principal" and documents `principal`, fail-closed scopes, and candidate scoping. Its
  `check-docs` requirement for "does not receive verified identity" is
  replaced.
- `memory/retrieval.mdx` has a forbidden phrase, "`resolveScope` receives verified identity".
  It becomes the documented behavior, so the pin flips.
- `memory/browse.mdx` covers the candidate list scoping.
- `security-architecture.mdx` drops "/memory/candidates … bypass".
- `configuration.mdx` documents the `resolveScope` ctx row. The SDK/API reference row for
  `B4Config.memory.resolveScope` changes accordingly.
- Changeset: patch, `@b4run/core` + `@b4run/cli`.

## 4. Tests (when implemented)

- Two concurrent requests with different principals on one route: each recalls only its own
  record, on both a cold and a warm graph cache.
- A route declaring `user` with an anonymous request: remember and recall fail closed, and nothing
  is written to the `workspace+route` namespace.
- A route declaring only `workspace`/`route`: behavior is unchanged with or without a principal.
- Candidates: principal A lists only A's candidates, and approving or rejecting B's candidate
  id returns 404.
- LangSmith build of a route whose `resolveScope` reads `principal`: build error.

## 5. Decisions (Brian, 2026-10-07)

- **D1. Sequencing:** wait for resolver-spec PR 1 and land this as its PR 2. No `middleware`
  stopgap.
- **D2. Unresolved declared dimension:** fail closed (§3.2 step 2). An app that declares `user`
  or `tenant` and never resolves it gets a tool error instead of the shared namespace. The
  changeset and the upgrade notes must call this out.
- **D3. Cross-namespace candidate review:** unavailable over HTTP whenever an auth file exists,
  until resolver-spec Q1 settles the `/memory/*` gate. The `b4 memory` CLI keeps listing
  everything.
