# Navlog PR 5: the live demo on Railway and Vercel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the navlog example as a public demo: the server on Railway with Postgres stores behind an internal-token guard, the web client on Vercel with threadplane's three proxy guardrails (origin allowlist, per-visitor rate limit, token injection) plus per-visitor thread isolation, and a manual smoke of the live site recorded in the PR.

**Architecture:** The server gets a committed `main.mjs` entry (plain ESM, no compile step) that loads the `b4 build` manifest exactly as the generated `server.mjs` does, composes Postgres stores when `DATABASE_URL` is set, and starts `serve()` with a `guard` that requires `X-Internal-Token` on everything but `/healthz`. `src/middleware.ts` turns the proxy-supplied visitor id into per-request context and `src/thread-access.ts` makes threads visitor-owned. All of it is inert in local development: with no `B4_INTERNAL_TOKEN` the guard passes everything and the policies fall back to one local principal, so `b4 dev`, the harness lanes and the scaffold keep working unchanged. The web proxies gain a pure guard module that decides origin, visitor cookie, rate limit and upstream headers; the CopilotKit route forwards the visitor id through an `AsyncLocalStorage`-backed `fetch` on `B4HttpAgent`. A monorepo-aware `Dockerfile.railway` and `railway.json` build the server from the repo root; a `vercel.json` builds the web client from the monorepo like `apps/web` does.

**Tech Stack:** `@b4run/cli` `serve({ guard })` (PR 1), `@b4run/postgres-storage/node`, `@b4run/memory-pgvector`, `@b4run/langchain` `openaiEmbedder`, Next.js route handlers, `@upstash/ratelimit` + `@upstash/redis`, Railway (Dockerfile builder, Postgres plugin), Vercel (pnpm monorepo project), Docker multi-stage with pnpm 10.

**Spec:** `docs/superpowers/specs/2026-10-04-navlog-example-design.md` section 6. **Branch:** `blove/navlog-deploy` from `origin/main` after PR 4 (#939) merges, or stacked on `blove/navlog-web` before that.

**Plan-level decisions (fold into the spec's section 6 in this PR's docs commit):**
- **No Railway volume.** The spec put a volume at `/app/workspace`, but `workspace/` holds the POH corpus the tools read, so a volume mounted there would hide it. Reports and recorded flight plans written by the agent are ephemeral per deploy; the navlog itself lives in the Postgres checkpoint and the Workbench reads it from the thread. Documented in the README.
- **Long-term memory stays shared across visitors; approval is the demo owner's.** Memory scope is resolved at route preparation without the request principal (`packages/cli/src/lib/runtime/execute-route-core.ts`, the `resolveScope` call), so per-visitor memory needs a framework seam that passes middleware context into `resolveScope` and resolves the namespace per request. That is filed as its own issue (Task 7) and not built here. In the demo, visitors can propose memories (`writes: "candidate"`), and only a request carrying the demo-owner cookie may approve or reject; the memory panel explains the 403. Approved memories are the demo's curated aircraft profile, which is what a public demo wants anyway.
- **Approval grants and client tool-call records stay in SQLite on the container disk.** The runtime server injects the checkpointer, threads, permissions and memory stores; the interrupt-grant and client-tool-call stores have no injection seam on the Node server, so "Always allow" grants last until the next deploy. Acceptable for a demo; noted in the README.
- **Local development is unchanged.** Every guard, policy and store switch keys off an environment variable that is unset in development and in CI.

**Run every command from the repo root with Node 24.** Template mirror: `main.mjs`, `Dockerfile.railway`, `railway.json`, `vercel.json` and the deploy README section are **example-only**; the parity test compares `src/`, `workspace/`, `b4.config.ts`, `test/` and the web `app/`, so the parity-scoped changes (`src/middleware.ts`, `src/thread-access.ts`, `src/auth.ts`, `b4.config.ts`, web `app/lib/proxy-guard.ts` and both proxy routes) must be mirrored into `packages/devkit/templates/app-navlog/`. Check `SERVER_PARITY_SCOPE` and `WEB_PARITY_SCOPE` in `packages/devkit/test/templates.test.ts` before deciding what to mirror, and run `pnpm --filter @b4run/devkit test` after each task.

---

## File structure

```
examples/navlog/server/
  main.mjs                         production entry: manifest + Postgres stores + serve({ guard })
  Dockerfile.railway               multi-stage build from the monorepo root
  railway.json                     Dockerfile builder, /healthz healthcheck, restart policy
  b4.config.ts                     + memory store/embedder switch on DATABASE_URL / OPENAI_API_KEY
  src/auth.ts                      principalOf(headers): visitor id from X-B4-Visitor, or the local principal
  src/middleware.ts                allow({ visitorId }) / reject when the guard is active and the header is missing
  src/thread-access.ts             visitor-owned threads (from the .example)
  test/deploy-entry.test.ts        boots main.mjs with a token and asserts 401/200
  test/auth.test.ts                principalOf in both modes
  README.md                        "Deploy" section
examples/navlog/web/
  vercel.json                      monorepo build command + ignored-build script
  scripts/vercel-ignore-build.sh
  app/lib/proxy-guard.ts           pure: origin check, visitor cookie, limiter decision, upstream headers
  app/lib/proxy-guard.test.ts
  app/lib/visitor-context.ts       AsyncLocalStorage for the CopilotKit route
  app/api/b4/[...path]/route.ts    uses the guard; owner-only approve/reject
  app/api/copilotkit/[...path]/route.ts  uses the guard; B4HttpAgent with a header-injecting fetch
  app/api/admin/route.ts           sets the demo-owner cookie from a token
  app/components/MemoryPanel.tsx   shows the owner-only message on 403
  .env.example                     the Vercel project variables
  README.md                        "Deploy" section
```

---

## Task 1: `main.mjs`, the production entry

**Files:**
- Create: `examples/navlog/server/main.mjs`
- Modify: `examples/navlog/server/package.json` (`start` script, dependencies), `b4.config.ts`
- Test: `examples/navlog/server/test/deploy-entry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const appRoot = fileURLToPath(new URL("..", import.meta.url))
let child: ReturnType<typeof spawn>
let url = ""

async function waitForListening(proc: ReturnType<typeof spawn>): Promise<string> {
  let buffer = ""
  for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
    buffer += chunk.toString()
    const m = /listening on (http:\/\/[^\s]+)/.exec(buffer)
    if (m) return m[1] as string
  }
  throw new Error(`entry exited before listening:\n${buffer}`)
}

describe("main.mjs behind the internal-token guard", () => {
  beforeAll(async () => {
    // `b4 build` must have run (the test script does it; see package.json).
    child = spawn(process.execPath, ["main.mjs"], {
      cwd: appRoot,
      env: { ...process.env, PORT: "0", B4_INTERNAL_TOKEN: "test-secret", DATABASE_URL: "" },
      stdio: ["ignore", "pipe", "inherit"],
    })
    url = await waitForListening(child)
  }, 60_000)
  afterAll(async () => {
    child.kill("SIGTERM")
    await once(child, "exit")
  })

  it("answers the health check without a token", async () => {
    const res = await fetch(new URL("/healthz", url))
    expect(res.status).toBe(200)
  })
  it("refuses a runtime route without the token", async () => {
    const res = await fetch(new URL("/threads", url))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unauthorized" })
  })
  it("serves a runtime route with the token", async () => {
    const res = await fetch(new URL("/threads", url), { headers: { "x-internal-token": "test-secret", "x-b4-visitor": "v-test" } })
    expect(res.status).toBe(200)
  })
})
```

Add to `package.json` scripts: `"start": "node main.mjs"` and `"pretest": "node node_modules/@b4run/cli/dist/index.js build"` so the entry test has a manifest (if `pretest` slows the unit suite too much, give this test its own script `test:deploy` that builds first and call it from the gate instead; say which in the PR). Add dependencies: `"@b4run/postgres-storage": "workspace:*"`, `"@b4run/memory-pgvector": "workspace:*"`, `"@b4run/langchain"` is already present. Run `pnpm install` (the lockfile gains the two workspace links only).

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @b4-example/navlog-server exec vitest run test/deploy-entry.test.ts
```
Expected: `main.mjs` not found.

- [ ] **Step 3: Write `main.mjs`**

```js
// Production entry for the navlog server. Plain ESM so the Docker image needs
// no compile step. Mirrors the generated `.b4/build/server.mjs` (manifest +
// workspace), then adds what a public deployment needs:
//   - Postgres stores when DATABASE_URL is set (checkpointer, threads, permissions);
//   - an internal-token guard on every request but /healthz when B4_INTERNAL_TOKEN is set.
// With neither variable set it behaves like `b4 start`.
import { readFile, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadStaticModules, serve } from "@b4run/cli"
import {
  createPostgresPermissionsStore,
  createPostgresPool,
  createPostgresThreadsStore,
  postgresCheckpointer,
} from "@b4run/postgres-storage/node"

const appRoot = dirname(fileURLToPath(import.meta.url))
const buildDir = resolve(appRoot, ".b4", "build")

const loadedModules = await loadStaticModules(new URL("./.b4/build/modules.mjs", import.meta.url))
const workspacePath = resolve(buildDir, "workspace.json")
if ((await stat(workspacePath)).size > 100 * 1024 * 1024) throw new Error("Workspace artifact exceeds size limit")
const modules = { ...loadedModules, workspace: JSON.parse(await readFile(workspacePath, "utf8")) }

const token = process.env.B4_INTERNAL_TOKEN
const databaseUrl = process.env.DATABASE_URL

const stores = databaseUrl ? postgresStores(databaseUrl) : {}

const handle = await serve({
  appRoot,
  modules,
  threadAccessExpected: true,
  permissionsMode: "boot",
  ...stores,
  guard: token ? tokenGuard(token) : undefined,
  onListening: (url) => console.log(`B4.run navlog listening on ${url}${token ? " (guarded)" : ""}${databaseUrl ? " (postgres)" : " (sqlite)"}`),
})

process.on("SIGTERM", () => void handle.close())

function postgresStores(connectionString) {
  const pool = createPostgresPool({ connectionString })
  const schema = process.env.B4_PG_SCHEMA ?? "public"
  const tablePrefix = process.env.B4_PG_TABLE_PREFIX ?? "b4"
  return {
    checkpointer: postgresCheckpointer({ pool, schema, tablePrefix }),
    threadsStore: createPostgresThreadsStore({ pool, schema, tablePrefix }),
    permissionsStore: createPostgresPermissionsStore({ pool, schema, tablePrefix }),
  }
}

function tokenGuard(secret) {
  return (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname
    if (pathname === "/healthz") return false
    if (request.headers["x-internal-token"] === secret) return false
    response.writeHead(401, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: "unauthorized" }))
    return true
  }
}
```

If `serve` rejects `guard: undefined` under `exactOptionalPropertyTypes` at runtime it does not (JS), but keep the spread form `...(token ? { guard: tokenGuard(token) } : {})` for symmetry with the stores. The `threadAccessExpected: true` matches what `b4 build` writes once `src/thread-access.ts` exists (Task 2); until Task 2 lands, set it from the manifest: `threadAccessExpected: loadedModules.threadAccess !== undefined`.

- [ ] **Step 4: Memory store switch in `b4.config.ts`**

Add at the top:

```ts
import { openaiEmbedder } from "@b4run/langchain"
import { pgvectorMemoryStore } from "@b4run/memory-pgvector"

// Memory backend: SQLite by default; Postgres + pgvector when DATABASE_URL is
// set (the live demo); vector recall when OPENAI_API_KEY is set. Both connect
// lazily, so constructing them here does no I/O. Same switch as examples/memory.
const databaseUrl = process.env.DATABASE_URL
const embedder = process.env.OPENAI_API_KEY ? openaiEmbedder() : undefined
```

and in `memory:` add `...(embedder ? { vector: { embedder } } : {})` and `...(databaseUrl ? { store: pgvectorMemoryStore({ connectionString: databaseUrl, dimensions: 1536 }) } : {})`. Mirror `b4.config.ts` to the template; the template's `package.json.template` gets the two new dependencies with the same version placeholder the other `@b4run/*` entries use.

- [ ] **Step 5: Run the test, lint, parity, commit**

```bash
pnpm build
pnpm --filter @b4-example/navlog-server exec b4 build
pnpm --filter @b4-example/navlog-server exec vitest run test/deploy-entry.test.ts
pnpm --filter @b4-example/navlog-server lint && pnpm --filter @b4-example/navlog-server check
pnpm --filter @b4run/devkit test
git add examples/navlog/server/main.mjs examples/navlog/server/package.json examples/navlog/server/b4.config.ts examples/navlog/server/test/deploy-entry.test.ts packages/devkit/templates/app-navlog/server pnpm-lock.yaml
git commit -m "feat(navlog): production entry with Postgres stores and the internal-token guard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: visitor identity on the server

**Files:**
- Create: `src/auth.ts`, `src/middleware.ts`, `src/thread-access.ts` (from the `.example` files, which are deleted)
- Test: `test/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { LOCAL_PRINCIPAL, principalOf } from "../src/auth.ts"

afterEach(() => vi.unstubAllEnvs())

describe("principalOf", () => {
  it("is the visitor named by X-B4-Visitor when the guard is active", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "secret")
    expect(await principalOf({ "x-b4-visitor": "v-abc" })).toEqual({ id: "v-abc", isAdmin: false, org: "demo" })
  })
  it("is nobody when the guard is active and the header is missing or malformed", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "secret")
    expect(await principalOf({})).toBeUndefined()
    expect(await principalOf({ "x-b4-visitor": "v-abc, v-def" })).toBeUndefined()
    expect(await principalOf({ "x-b4-visitor": "../x" })).toBeUndefined()
  })
  it("is the local principal when no guard is configured", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "")
    expect(await principalOf({})).toEqual(LOCAL_PRINCIPAL)
    expect(await principalOf({ "x-b4-visitor": "v-abc" })).toEqual(LOCAL_PRINCIPAL)
  })
})
```

- [ ] **Step 2: Implement**

`src/auth.ts`:

```ts
/**
 * The one place this app turns a request into a principal.
 *
 * Behind the deployed proxy (B4_INTERNAL_TOKEN set), the proxy mints a visitor
 * id into an HTTP-only cookie and forwards it as X-B4-Visitor on every upstream
 * call; the guard in main.mjs has already proven the request came through the
 * proxy, so the header is trustworthy. In local development (no token) there
 * is no proxy and one local principal owns everything, which is what `b4 dev`,
 * the harness lanes and the tests expect.
 */
export interface Principal {
  readonly id: string
  readonly isAdmin: boolean
  readonly org: string
}

export const LOCAL_PRINCIPAL: Principal = { id: "local", isAdmin: true, org: "local" }

const VISITOR_ID = /^v-[A-Za-z0-9_-]{8,64}$/

export async function principalOf(headers: Readonly<Record<string, string>>): Promise<Principal | undefined> {
  if (!process.env.B4_INTERNAL_TOKEN) return LOCAL_PRINCIPAL
  const id = headers["x-b4-visitor"]
  // Repeated headers arrive joined with ", "; a strict pattern rejects that too.
  if (id === undefined || !VISITOR_ID.test(id)) return undefined
  return { id, isAdmin: false, org: "demo" }
}
```

`src/middleware.ts`:

```ts
import { allow, defineMiddleware, reject } from "@b4run/sdk"
import { principalOf } from "./auth.js"

/** Route execution needs a principal; tools get it as ctx.middleware.visitorId. */
export default defineMiddleware(async (req) => {
  const user = await principalOf(req.headers)
  if (!user) return reject(401, { error: "unauthorized" })
  return allow({ visitorId: user.id })
})
```

`src/thread-access.ts`: rename `src/thread-access.ts.example` with `git mv`, change its import to `./auth.js`, and keep its body (it already implements owner-or-admin with the semantics the file explains). Delete `src/auth.ts.example`.

- [ ] **Step 3: Run tests, check, parity, commit**

```bash
pnpm --filter @b4-example/navlog-server exec vitest run test/auth.test.ts test/deploy-entry.test.ts
pnpm --filter @b4-example/navlog-server check && pnpm --filter @b4-example/navlog-server test
```
Expected: `b4 check` reports the middleware and the thread-access policy; the keyless eval and the unit tests still pass (no token in the environment means the local principal). Mirror `src/` to the template (the `.example` files disappear from the template too; check `packages/devkit/test/template-thread-access.test.ts`, which asserts the template ships the `.example` files, and update it to assert the real files instead). Commit:

```bash
git add -A examples/navlog/server/src examples/navlog/server/test/auth.test.ts packages/devkit/templates/app-navlog/server packages/devkit/test
git commit -m "feat(navlog): visitor principal, middleware and thread-access policy, inert in development

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: web proxy guards

**Files:**
- Create: `examples/navlog/web/app/lib/proxy-guard.ts`, `app/lib/proxy-guard.test.ts`, `app/lib/visitor-context.ts`, `app/api/admin/route.ts`
- Modify: both proxy routes, `MemoryPanel.tsx`, `package.json` (add `@upstash/ratelimit`, `@upstash/redis`), `.env.example`

- [ ] **Step 1: Write the failing tests** (`app/lib/proxy-guard.test.ts`)

```ts
import { describe, expect, test } from "vitest"
import { decideRequest, isOwnerApprovalPath, mintVisitorId, upstreamHeaders } from "./proxy-guard"

const base = { allowedOrigins: ["https://navlog.b4.run"], internalToken: "secret" }

describe("decideRequest", () => {
  test("rejects a cross-origin request when an allowlist is configured", () => {
    expect(decideRequest({ ...base, origin: "https://evil.example", visitorId: "v-1", limiterVerdict: "allow" })).toEqual({ kind: "reject", status: 403, error: "origin_not_allowed" })
  })
  test("allows a same-origin request and a request with no Origin header", () => {
    expect(decideRequest({ ...base, origin: "https://navlog.b4.run", visitorId: "v-1", limiterVerdict: "allow" })).toEqual({ kind: "allow" })
    expect(decideRequest({ ...base, origin: undefined, visitorId: "v-1", limiterVerdict: "allow" })).toEqual({ kind: "allow" })
  })
  test("allows everything when no allowlist is configured (local development)", () => {
    expect(decideRequest({ allowedOrigins: [], internalToken: undefined, origin: "http://localhost:3010", visitorId: "v-1", limiterVerdict: "allow" })).toEqual({ kind: "allow" })
  })
  test("rejects with 429 when the limiter says so", () => {
    expect(decideRequest({ ...base, origin: undefined, visitorId: "v-1", limiterVerdict: "limit" })).toEqual({ kind: "reject", status: 429, error: "rate_limit_exceeded" })
  })
})

describe("mintVisitorId", () => {
  test("produces ids the server's pattern accepts and never repeats", () => {
    const a = mintVisitorId()
    const b = mintVisitorId()
    expect(a).toMatch(/^v-[A-Za-z0-9_-]{8,64}$/)
    expect(a).not.toBe(b)
  })
})

describe("upstreamHeaders", () => {
  test("injects the token and the visitor id when configured, and only the visitor id otherwise", () => {
    expect(upstreamHeaders({ internalToken: "secret", visitorId: "v-1" })).toEqual({ "x-internal-token": "secret", "x-b4-visitor": "v-1" })
    expect(upstreamHeaders({ internalToken: undefined, visitorId: "v-1" })).toEqual({ "x-b4-visitor": "v-1" })
  })
})

describe("isOwnerApprovalPath", () => {
  test("names the memory candidate approve and reject paths only", () => {
    expect(isOwnerApprovalPath(["memory", "candidates", "abc", "approve"])).toBe(true)
    expect(isOwnerApprovalPath(["memory", "candidates", "abc", "reject"])).toBe(true)
    expect(isOwnerApprovalPath(["memory", "candidates"])).toBe(false)
    expect(isOwnerApprovalPath(["threads", "t1", "state"])).toBe(false)
  })
})
```

- [ ] **Step 2: Implement `proxy-guard.ts`**

```ts
import { randomBytes } from "node:crypto"

export interface GuardConfig {
  /** Origins allowed to call the proxy; empty means no origin check (development). */
  readonly allowedOrigins: readonly string[]
  /** The server's B4_INTERNAL_TOKEN; undefined means no token injection (development). */
  readonly internalToken: string | undefined
}

export type LimiterVerdict = "allow" | "limit" | "unconfigured"

export type Decision = { readonly kind: "allow" } | { readonly kind: "reject"; readonly status: number; readonly error: string }

/** The pure policy: origin first, then the limiter. Fails open when the limiter is unconfigured. */
export function decideRequest(input: GuardConfig & { readonly origin: string | undefined; readonly visitorId: string; readonly limiterVerdict: LimiterVerdict }): Decision {
  if (input.allowedOrigins.length > 0 && input.origin !== undefined && !input.allowedOrigins.includes(input.origin)) {
    return { kind: "reject", status: 403, error: "origin_not_allowed" }
  }
  if (input.limiterVerdict === "limit") return { kind: "reject", status: 429, error: "rate_limit_exceeded" }
  return { kind: "allow" }
}

export const VISITOR_COOKIE = "b4_visitor"
export const OWNER_COOKIE = "b4_demo_owner"

export function mintVisitorId(): string {
  return `v-${randomBytes(12).toString("base64url")}`
}

export function upstreamHeaders(input: { readonly internalToken: string | undefined; readonly visitorId: string }): Record<string, string> {
  return {
    ...(input.internalToken ? { "x-internal-token": input.internalToken } : {}),
    "x-b4-visitor": input.visitorId,
  }
}

/** Memory candidate approve/reject: reserved for the demo owner in the deployed demo. */
export function isOwnerApprovalPath(path: readonly string[]): boolean {
  return path.length === 4 && path[0] === "memory" && path[1] === "candidates" && (path[3] === "approve" || path[3] === "reject")
}

export function guardConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GuardConfig {
  return {
    allowedOrigins: (env.B4_DEMO_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    internalToken: env.B4_INTERNAL_TOKEN || undefined,
  }
}
```

Add a small `app/lib/rate-limit.ts` with the Upstash wiring, lazy and fail-open exactly like threadplane's proxy:

```ts
import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"
import type { LimiterVerdict } from "./proxy-guard"

let limiter: Ratelimit | null | undefined

function getLimiter(): Ratelimit | null {
  if (limiter !== undefined) return limiter
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    limiter = null
    return limiter
  }
  limiter = new Ratelimit({
    redis: new Redis({ url, token }),
    // Ten requests a minute per visitor with a burst of ten: a planning turn is
    // one request, so this is generous for a person and tight for a script.
    limiter: Ratelimit.tokenBucket(10, "60 s", 10),
    analytics: false,
    prefix: "navlog",
  })
  return limiter
}

/** Per visitor id; "unconfigured" when Upstash is absent, so the proxy fails open. */
export async function limiterVerdict(visitorId: string): Promise<LimiterVerdict> {
  const rl = getLimiter()
  if (rl === null) return "unconfigured"
  const { success } = await rl.limit(visitorId)
  return success ? "allow" : "limit"
}
```

`app/lib/visitor-context.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks"

export interface VisitorContext {
  readonly visitorId: string
}

/** Carries the visitor id from a route handler to the CopilotKit agent's fetch. */
export const visitorContext = new AsyncLocalStorage<VisitorContext>()
```

- [ ] **Step 3: Wire the routes**

Both routes share a helper (put it in `app/lib/proxy-guard.ts` too, since it is Next-specific but tiny; or `app/lib/guarded-request.ts`):

```ts
import { type NextRequest, NextResponse } from "next/server"
import { limiterVerdict } from "./rate-limit"
import { decideRequest, guardConfigFromEnv, mintVisitorId, VISITOR_COOKIE } from "./proxy-guard"

export interface GuardedRequest {
  readonly visitorId: string
  /** Set on the response when the cookie was minted on this request. */
  readonly setCookie: ((response: Response) => void) | undefined
  readonly rejection: Response | undefined
}

export async function guardRequest(request: NextRequest): Promise<GuardedRequest> {
  const config = guardConfigFromEnv()
  const existing = request.cookies.get(VISITOR_COOKIE)?.value
  const visitorId = existing && /^v-[A-Za-z0-9_-]{8,64}$/.test(existing) ? existing : mintVisitorId()
  const setCookie = existing === visitorId ? undefined : (response: Response) => {
    response.headers.append("set-cookie", `${VISITOR_COOKIE}=${visitorId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${config.internalToken ? "; Secure" : ""}`)
  }
  const decision = decideRequest({ ...config, origin: request.headers.get("origin") ?? undefined, visitorId, limiterVerdict: await limiterVerdict(visitorId) })
  const rejection = decision.kind === "reject" ? NextResponse.json({ error: decision.error }, { status: decision.status, ...(decision.status === 429 ? { headers: { "retry-after": "60" } } : {}) }) : undefined
  return { visitorId, setCookie, rejection }
}
```

`api/b4/[...path]/route.ts`: call `guardRequest` first; return the rejection if any; if `isOwnerApprovalPath(path)` and the guard is active (`internalToken` set) and the request lacks the owner cookie (`OWNER_COOKIE` equal to `process.env.B4_DEMO_ADMIN_TOKEN`), return `403 { error: "owner_only", message: "Approving memories is reserved for the demo owner." }`; otherwise forward with `headers: upstreamHeaders({ internalToken, visitorId })` added to the fetch, and apply `setCookie` to the returned Response. Keep the allowlist and every existing comment.

`api/copilotkit/[...path]/route.ts`: build the agent once with a header-injecting fetch:

```ts
import { visitorContext } from "../../../lib/visitor-context"
import { guardConfigFromEnv, upstreamHeaders } from "../../../lib/proxy-guard"

const config = guardConfigFromEnv()
const agent = new B4HttpAgent({
  url: agUiUrl,
  fetch: (input, init) => {
    const visitorId = visitorContext.getStore()?.visitorId ?? "v-unknown-missing"
    const headers = new Headers(init?.headers)
    for (const [k, v] of Object.entries(upstreamHeaders({ internalToken: config.internalToken, visitorId }))) headers.set(k, v)
    return fetch(input, { ...init, headers })
  },
})
```

and wrap the exported handlers: `export const POST = async (request: NextRequest, ctx) => { const g = await guardRequest(request); if (g.rejection) return g.rejection; const response = await visitorContext.run({ visitorId: g.visitorId }, () => handler(request, ctx)); g.setCookie?.(response); return response }` (same for GET). The capabilities probe (`getCapabilities`, called on `/info`) runs inside the same context, so it carries the headers too.

`api/admin/route.ts`: `GET /api/admin?token=…` compares the token to `B4_DEMO_ADMIN_TOKEN` with a constant-time comparison (`timingSafeEqual` on equal-length buffers), sets `OWNER_COOKIE` (HttpOnly, Secure when guarded, SameSite=Lax, 30 days) and redirects to `/`; a wrong token answers 403 with no cookie. With `B4_DEMO_ADMIN_TOKEN` unset the route answers 404.

`MemoryPanel.tsx`: when approve/reject returns 403 with `owner_only`, show the server's `message` in the panel's existing outcome line instead of a generic failure (one branch; add a test in `MemoryPanel.test.tsx` that renders the message).

`.env.example` (web):

```
# Where the B4.run server is. Local: the dev server; Vercel: the Railway service's public URL.
B4_SERVER_URL=http://127.0.0.1:3002
# Shared with the server's B4_INTERNAL_TOKEN. Unset locally: the proxy injects nothing and the server guards nothing.
B4_INTERNAL_TOKEN=
# Comma-separated origins allowed to call the proxy. Unset locally.
B4_DEMO_ORIGINS=https://navlog.b4.run
# Upstash Redis for the per-visitor rate limit. Unset: the proxy fails open.
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
# Visiting /api/admin?token=<this> sets the demo-owner cookie that may approve memories.
B4_DEMO_ADMIN_TOKEN=
```

- [ ] **Step 4: Tests, parity, commit**

```bash
pnpm install
pnpm --filter @b4-example/navlog-web test && pnpm --filter @b4-example/navlog-web lint && pnpm --filter @b4-example/navlog-web typecheck && pnpm --filter @b4-example/navlog-web build
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/copilotkit-v2-runtime.test.ts
pnpm --filter @b4run/devkit test
```
The copilotkit-v2-runtime gate test imports the route module; with no env it must behave exactly as before (no token, no origin check, a visitor cookie minted). Mirror `app/` to the template (its `package.json.template` gets the two Upstash deps). Commit:

```bash
git add -A examples/navlog/web packages/devkit/templates/app-navlog/web pnpm-lock.yaml
git commit -m "feat(navlog-web): proxy guards (origin, visitor cookie, rate limit, token), owner-only memory approval

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4: Railway build

**Files:**
- Create: `examples/navlog/server/Dockerfile.railway`, `examples/navlog/server/railway.json`
- Modify: repo-root `.dockerignore` (create if absent)

- [ ] **Step 1: `Dockerfile.railway`** (build context is the repository root; Railway's service "Root Directory" stays `/` and `railway.json` names this file)

```dockerfile
# syntax=docker/dockerfile:1
# Builds the navlog server from the monorepo: workspace packages are built from
# source, the example runs `b4 build`, and the runtime image carries the whole
# installed workspace (simplest correct answer for workspace: links; size is a
# non-goal for a demo). Railway builds this with the repository root as context.
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* turbo.json tsconfig*.json ./
COPY packages ./packages
COPY examples/navlog/server ./examples/navlog/server
COPY examples/navlog/package.json ./examples/navlog/package.json
# The lockfile names every workspace importer, including ones this image does
# not copy; `--filter` with `...` installs only the server and its workspace deps.
RUN pnpm install --frozen-lockfile --filter @b4-example/navlog-server...
RUN pnpm turbo run build --filter=@b4-example/navlog-server...
# `b4 build` writes .b4/build (modules.mjs, workspace.json, server.mjs) for main.mjs.
RUN pnpm --filter @b4-example/navlog-server exec b4 build

FROM node:24-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/examples/navlog/server
RUN chown -R 1000:1000 /app/examples/navlog/server/.b4 /app/examples/navlog/server/workspace
USER 1000:1000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "main.mjs"]
```

If `pnpm install --filter … --frozen-lockfile` refuses because the lockfile's importer set differs from the copied tree, drop the `--filter` on install (install the whole workspace; the copy already excludes the other examples and `apps/web`, so add `COPY apps/web/package.json ./apps/web/package.json` and the other examples' `package.json` files as needed, or copy the whole repo with a `.dockerignore` that excludes `node_modules`, `.git`, `apps/web/.next`, `**/.turbo`). Choose whichever builds; record it in the PR.

- [ ] **Step 2: `railway.json`**

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "examples/navlog/server/Dockerfile.railway"
  },
  "deploy": {
    "healthcheckPath": "/healthz",
    "healthcheckTimeout": 120,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

Railway reads `railway.json` from the service's root directory; set the service root to `examples/navlog/server` in the Railway dashboard **only if** Railway then still builds with the repository root as Docker context (it does not: with a root directory set, the context is that directory). So keep the service root at `/` and set the config path in the dashboard to `examples/navlog/server/railway.json` (Railway's "Config as code" path setting). Record the exact setting used in the README.

- [ ] **Step 3: Build the image locally and smoke it**

```bash
docker build -f examples/navlog/server/Dockerfile.railway -t navlog-server .
docker run --rm -e B4_INTERNAL_TOKEN=s -e PORT=8000 -p 8000:8000 navlog-server &
sleep 10; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/healthz; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/threads; curl -s -o /dev/null -w "%{http_code}\n" -H "x-internal-token: s" -H "x-b4-visitor: v-smoketest1" http://127.0.0.1:8000/threads
```
Expected: 200, 401, 200. Stop the container. If Docker is unavailable in the session, report NEEDS_CONTEXT and leave this step for the controller.

- [ ] **Step 4: Commit**

```bash
git add examples/navlog/server/Dockerfile.railway examples/navlog/server/railway.json .dockerignore
git commit -m "feat(navlog): Railway Dockerfile and service config

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: Vercel project config

**Files:**
- Create: `examples/navlog/web/vercel.json`, `examples/navlog/web/scripts/vercel-ignore-build.sh`

- [ ] **Step 1: `vercel.json`** (the project's Root Directory is `examples/navlog/web`, with "Include source files outside of the Root Directory" enabled, as `apps/web` is set up)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "cd ../../.. && pnpm turbo run build --filter=@b4-example/navlog-web...",
  "ignoreCommand": "bash scripts/vercel-ignore-build.sh"
}
```

- [ ] **Step 2: the ignore script**

Copy `apps/web/scripts/vercel-ignore-build.sh`, keep its factory-branch and production clauses, and set `paths=( examples/navlog/web packages/ag-ui packages/sdk package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json .npmrc )`. Make it executable (`chmod +x`).

- [ ] **Step 3: Commit**

```bash
git add examples/navlog/web/vercel.json examples/navlog/web/scripts/vercel-ignore-build.sh
git commit -m "feat(navlog-web): Vercel project config for the monorepo build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: READMEs, spec, changeset, gate

- [ ] **Step 1: "Deploy" sections**

`examples/navlog/server/README.md`: a "Deploy (Railway)" section: the service (Dockerfile builder from the repo root, config path), the Postgres plugin (`DATABASE_URL` is injected by Railway), the variables (`B4_INTERNAL_TOKEN` shared with the web project, `OPENAI_API_KEY` with a monthly cap, optional `B4_PG_SCHEMA`), what is ephemeral (reports, flight plans, approval grants), what `main.mjs` does, and how to run it locally (`DATABASE_URL=… B4_INTERNAL_TOKEN=… node main.mjs` after `b4 build`).

`examples/navlog/web/README.md`: a "Deploy (Vercel)" section: the project root, the build command, the variables from `.env.example`, the owner cookie (`/api/admin?token=…`), the three guards and the fail-open rule, the visitor cookie and thread isolation.

Template root README: one sentence that the example repo shows a Railway + Vercel deployment and where to look.

- [ ] **Step 2: Spec**

Section 6 of `docs/superpowers/specs/2026-10-04-navlog-example-design.md`: replace the volume sentence with the ephemeral-workspace decision; replace "scoped to the visitor's own candidates through the same principal" with the owner-cookie rule and the pointer to the memory-scope issue; add the grants note. Section 9 PR 5 bullet unchanged.

- [ ] **Step 3: Changeset** `.changeset/navlog-deploy.md`

```md
---
"@b4run/devkit": patch
"create-b4-app": patch
---

The `navlog` scaffold ships a visitor principal (`src/auth.ts`), route middleware and a thread-access policy that are inert in development and turn on behind a proxy that sets `B4_INTERNAL_TOKEN`, a memory backend switch to Postgres + pgvector on `DATABASE_URL`, and proxy guards in the Workbench (origin allowlist, per-visitor cookie and rate limit, token injection, owner-only memory approval). The example repository adds a Railway Dockerfile and a Vercel project config for the live demo.
```

- [ ] **Step 4: Gate**

```bash
pnpm lint && pnpm check:build-cache && pnpm build && pnpm typecheck && pnpm test && pnpm check:release-inventory && node scripts/check-docs.mjs && node scripts/check-changesets.mjs
pnpm verify:harness:self-test && pnpm verify:harness:framework
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/copilotkit-v2-runtime.test.ts
```
The framework lane scaffolds the template and runs the journeys with no token set, so the guards must be invisible there. Known load flakes as before.

---

## Task 7: the per-visitor memory issue

- [ ] File a GitHub issue "Memory scope cannot see the request principal (per-visitor memory for multi-tenant deployments)" describing: `memory.resolveScope` receives `{ routePath, appRoot }` at route preparation (`execute-route-core.ts`), middleware context is available on the same options object (`options.middlewareContext`) but is not passed, and the memory context is built at preparation time rather than per request; propose passing `middleware` into `resolveScope` and resolving the namespace per request; cite the navlog demo's owner-only approval workaround.

---

## Task 8: deploy, smoke, PR

These steps touch real accounts; they are the controller's (and the owner's), not a subagent's.

- [ ] Railway: new service `navlog-server` in the threadplane project from the `cacheplane/b4run` repo, config path `examples/navlog/server/railway.json`, Postgres plugin attached, variables set (`B4_INTERNAL_TOKEN` generated with `openssl rand -base64 32`, `OPENAI_API_KEY` the dedicated capped key, `B4_AWC_BASE_URL` unset). Public domain noted.
- [ ] Vercel: new project `navlog-web` from the repo, Root Directory `examples/navlog/web`, "Include source files outside of the Root Directory" on, variables from `.env.example` (`B4_SERVER_URL` = the Railway domain, the same `B4_INTERNAL_TOKEN`, `B4_DEMO_ORIGINS` = the Vercel domain, Upstash URL and token from the existing instance, `B4_DEMO_ADMIN_TOKEN` generated). Deploy.
- [ ] Smoke: open the site, run "Teach it the aircraft", visit `/api/admin?token=…`, approve the candidate in the memory panel, run "Plan a flight", confirm the map, strip and sheet render with live weather, open a second browser profile and confirm it cannot see the first profile's threads. Attach the transcript and a screenshot to the PR.
- [ ] PR body: summary of the five tasks, the three plan-level decisions, the smoke evidence, the test plan with the gate.

## Self-review against the spec

- 6.1 topology: Tasks 4, 5, 8. 6.2 entry and stores: Task 1 (`main.mjs`, Postgres via `@b4run/postgres-storage/node`, pgvector via config), Task 2 (policies). The spec's `main.ts` became `main.mjs` to avoid a compile step. 6.3 proxy guards: Task 3, in the spec's order; the memory-candidate scoping became owner-only (decision above). 6.4 verification: Task 6 gate plus Task 8 manual smoke. Spend and abuse (spec "Spend and abuse"): dedicated capped key (Task 8), per-visitor limiter (Task 3), AWC cache already in PR 3; the daily run quota from the spec is folded into the token bucket for now and noted.
- Placeholders: none. Types: `GuardConfig`/`Decision`/`LimiterVerdict` are used consistently by `proxy-guard.ts`, `rate-limit.ts` and the routes; `Principal`/`LOCAL_PRINCIPAL` by `auth.ts`, the middleware and the policy.
