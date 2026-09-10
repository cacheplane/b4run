# B4.run App — Coding Agent Instructions

This project uses **B4.run**, a TypeScript-first meta-framework for building graph-based AI agents with the ergonomics of Next.js. When working in this project, follow the B4.run conventions below.

## Project Shape

- **`b4.config.ts`** at the B4.run app root. Every path below is relative to that root — the project root in a single-package app, and the `server/` package in an app scaffolded from the default research template. Supported keys include:
  - `appDir` — route directory root; defaults to `src/app`.
  - `backends` — custom filesystem and exec backends for workspace tools.
  - `permissions` — mode plus allow/deny maps for tool and workspace gates.
  - `checkpointer` and `threadsStore` — durable thread/checkpoint overrides.
  - `env` — local env file for `b4 dev` and `b4 verify`; defaults to `./.env`.
  - `toolOutput` — offload large tool results into `workspace/tool-outputs/`.
  - `summarization` — opt-in conversation summary hook for long threads.
  - `sandbox` — execution sandbox configuration.
  - `memory` — long-term memory store, write governance, indexing, and recall tuning.
- **`src/app/`** — all routes live here. A route is a directory containing `index.ts`.
- **`src/app/**/index.ts`** — route entry. MUST export exactly ONE of:
  - `agent` — a `B4Agent` descriptor from `@b4run/sdk`, typically the `default` export. Preferred for LLM-driven routes; tools are wired into the generated graph at build time.
  - `workflow` (async function — explicit code-driven orchestration)
  - `graph` (LangGraph graph instance)
  - `chain` (LangChain LCEL Runnable)
- **`src/app/**/state.ts`** — optional route state schema (default-exported Zod or Standard Schema value). Imported by `index.ts` when the route needs typed state.
- **`src/app/**/tools/*.ts`** — co-located tools. Each file has a default export that is an async function. Types are inferred and written to `.b4/b4.generated.d.ts`.
- **`src/tools/*.ts`** — shared tools (optional). Discovered alongside route-local tools and merged into every route's tool registry. Route-local tools override shared tools with the same name.
- **`src/middleware.ts`** — optional. Default-exports a function returned by `defineMiddleware(...)`. Runs before every local `/threads/:thread_id/runs/wait`, `/threads/:thread_id/runs/stream`, and `/threads/:thread_id/resume` request handled by `b4 dev`.
- **`src/app/**/run.test.ts`** — colocated scenario tests. Default-export a route-scoped suite built with `scenarios("/route").scenario(...)` from `@b4run/sdk/testing`. Each scenario uses `.input()` and an explicit `.expectPassed()` or `.expectFailed()`, followed by expectations such as `.expectOutput()`, `.expectMeta()`, or `.expectError()`. In-process scenarios can use `.mockTool()` and `.expectTool()`; server-backed scenarios use `.server(url)` and cannot use tool mocks.
- **`.b4/b4.generated.d.ts`** — auto-generated. Do NOT edit by hand.
- **`b4:routes`** — virtual module backed by `.b4/b4.generated.d.ts`. If `RouteTools` does not resolve, run `b4 typegen`.

## Pathname Rules

- Directory segments become URL pathname segments.
- Segments in parentheses `(public)` are route groups — excluded from the pathname.
- Segments in brackets `[tenant]` are dynamic — callers pass the matching values in JSON input when invoking the parameterized route id.

Examples:

- Default research scaffold: `src/app/research/index.ts` → route id `/research`; agent route key `/research#agent`.
- Optional basic scaffold (`pnpm create b4-app my-app -- --template basic`): `src/app/(public)/hello/[tenant]/index.ts` → route id `/hello/[tenant]`; callers pass `tenant` in JSON input.

## Defining an Agent Route

```ts
// src/app/research/index.ts
import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt:
    "You are a research coordinator. Search the local corpus, dispatch specialists when useful, and cite every claim.",
  // Optional retry policy:
  // retry: { maxAttempts: 3, baseDelay: 250 },
})
```

- `model` is a `KnownModelId` (autocomplete for listed ids, plus any custom string).
- `provider?: ModelProviderId` is optional. B4.run infers providers for known model families; set it explicitly to one of the supported built-in provider ids for aliases, ambiguous model names, local models, or provider-router model ids. Raw graph/chain routes can still instantiate any provider directly.
- `retry?: { maxAttempts?: number, baseDelay?: number }` — applied per agent call.
- Tools in the same route's `tools/` directory (and shared tools in `src/tools/`) are automatically wired into the generated agent graph at `b4 build` time.

## Tool Authoring

```ts
// src/app/research/tools/searchCorpus.ts
export default async (
  input: { readonly query: string },
  ctx: { signal: AbortSignal; middleware?: Readonly<Record<string, unknown>> },
) => {
  return [
    {
      path: "corpus/agent-architectures.md",
      score: 2,
      snippet: "ReAct and plan-and-execute are common agent architectures.",
    },
  ]
}
```

- Input type is inferred from the parameter annotation; output type from the return.
- The second parameter is optional but recommended:
  - `ctx.signal` — `AbortSignal` for cooperative cancellation. Pass it to `fetch()` and any awaited operations.
  - `ctx.middleware` — readonly bag populated by `allow({ ... })` in `src/middleware.ts`. Request-scoped context (auth, tenancy, etc.) flows through here.
- Use `readonly` on input fields; B4.run preserves it.
- Input and output must be JSON-serializable (no `Date`, `Map`, classes, functions).
- Tools may live in either route-local `tools/` (preferred default) OR shared `src/tools/`. Route-local names override shared names.

## Middleware

```ts
// src/middleware.ts
import { allow, defineMiddleware, reject } from "@b4run/sdk"

export default defineMiddleware(async (req) => {
  if (!req.headers["x-tenant-id"]) {
    return reject(401, { error: "missing x-tenant-id" })
  }
  return allow({ tenantId: req.headers["x-tenant-id"] })
})
```

- `MiddlewareRequest`: `{ assistantId, headers, method, params, routeId, url }`.
- Return `reject(status, body?)` to short-circuit the request, or `allow(context?)` to continue.
- The `context` passed to `allow(...)` is forwarded to every tool as `ctx.middleware`.

## Route Entry — workflow form (alternative to agent)

```ts
// src/app/research/index.ts
import type { RuntimeContext } from "@b4run/sdk"
import type { RouteTools } from "b4:routes"
import type { z } from "zod"
import type state from "./state.js"

type ResearchState = z.infer<typeof state>

export async function workflow(
  state: ResearchState,
  ctx: RuntimeContext<RouteTools<"/research">>,
) {
  // ctx.signal is the request-scoped AbortSignal.
  // ctx.tools.searchCorpus is fully typed from the route's tools/ directory.
  const matches = await ctx.tools.searchCorpus({ query: state.context })
  return {
    ...state,
    context: matches.map((match) => `${match.path}: ${match.snippet}`).join("\n"),
  }
}
```

The `RouteTools<"/research">` lookup uses the route's pathname as the key — these keys are populated by `b4 typegen`. Run `b4 typegen` if `b4:routes` does not resolve.

## Commands (run via `pnpm exec`)

- `b4 add [name]` — add B4.run-authored templates or components.
- `b4 build` — write `.b4/build/langgraph.json` and per-route entry files for LangSmith deployment. Generated route keys are `<routeId>#<kind>` (e.g. `/research#agent`).
- `b4 check` — validate app structure/config (lightweight).
- `b4 dev` — local Agent Protocol runtime server.
- `b4 docs [topic]` — print local documentation snippets.
- `b4 eval [path]` — run eval definitions.
- `b4 memory [subcommand] [args...]` — inspect and manage long-term memory.
- `b4 routes` — list discovered routes.
- `b4 run <routePath>` — execute a route once with JSON stdin/stdout.
- `b4 test [path]` — run colocated scenario tests.
- `b4 typegen` — regenerate `.b4/b4.generated.d.ts` and per-route `tools.json` / `state.json`.
- `b4 verify` — full integrity check across app, routes, typegen, deps. Preferred CI gate.
- `echo '{"messages":[{"role":"user","content":"What are common agent architectures?"}]}' | b4 run /research` — execute the default scaffold route.

## Agent Protocol

`b4 dev` exposes thread-scoped Agent Protocol endpoints:

- `GET /healthz`
- `POST /threads`
- `GET /threads/:thread_id`
- `DELETE /threads/:thread_id`
- `POST /threads/:thread_id/runs/wait`
- `POST /threads/:thread_id/runs/stream`
- `GET /threads/:thread_id/state`
- `POST /threads/:thread_id/resume`

Run and stream bodies require a route key and optional input:

```json
{
  "route": "/research#agent",
  "input": {
    "messages": [{ "role": "user", "content": "What are common agent architectures?" }]
  }
}
```

Resume resolves a parked human-in-the-loop interrupt and streams the continuation:

```json
{
  "resume": [
    {
      "interruptId": "<id from interrupt event>",
      "status": "resolved",
      "payload": "once"
    }
  ],
  "route": "/research#agent"
}
```

The `resume` array must address every currently pending interrupt exactly once. A resolved `payload` must be `once`, `always`, or `deny`; a `cancelled` entry omits `payload` and maps to denial. The complete envelope and `route` are required.

## Packages

- `@b4run/sdk` — authoring contract: `agent`, `defineMiddleware`, `allow`, `reject`, types (`RuntimeContext` carries `signal: AbortSignal`, `AgentConfig`, `ReasoningConfig`, `RetryConfig`, `MiddlewareRequest`, etc.).
- `@b4run/langgraph` — adapter for LangGraph graphs and workflows.
- `@b4run/langchain` — adapter for LangChain LCEL chains.
- `@b4run/cli` — the `b4` CLI. Test helpers live at `@b4run/sdk/testing`.

## Do Not

- Do NOT edit `.b4/b4.generated.d.ts` or files under `.b4/`.
- Do NOT add Zod schemas for tool input/output — types are inferred from TypeScript source.
- Do NOT export more than one of `agent`/`workflow`/`graph`/`chain` from a single `index.ts`.
- Do NOT rely on concrete paths like `/hello/acme` for dynamic segments. Invoke the parameterized route id, such as `/hello/[tenant]` in the optional basic template, and pass values in JSON input.
- Do NOT edit `.b4/build/langgraph.json` by hand. To deploy, run `b4 build` and hand `.b4/build/` to LangSmith.

## Reference

- Full agent-consumable reference: https://b4.run/llms-full.txt
- Compact summary: https://b4.run/llms.txt
- Human docs: https://b4.run/docs/getting-started
