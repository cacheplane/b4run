# Migrate agent routes from `createReactAgent` to `createAgent`

**Goal:** a `returnDirect` tool ends the run only when it succeeds. LangGraph's
prebuilt `createReactAgent` routes a returnDirect tool's result to `END` by
tool name and cannot tell a failed call from a successful one (upstream:
langchain-ai/langgraphjs#2878, fix PR #2879). LangChain's `createAgent` has
the same name-only router (langchain-ai/langchainjs#11711, PR #11712), but its
middleware lets B4 decide the routing itself. Moving `materializeAgent` to
`createAgent` puts end-on-success under B4's control today.

## What `createReactAgent` gave B4, and the `createAgent` equivalent

| Today (`createReactAgent`) | After (`createAgent`) |
|---|---|
| `llm` (a model or `RunnableBinding` carrying a response format) | `model`, same object; `createAgent` binds tools through a `RunnableBinding` the same way |
| `prompt` string | `systemPrompt` string |
| `prompt` function (fragments re-rendered from live state every turn) | `wrapModelCall` sets `systemMessage` from the current state |
| `stateSchema` as `Annotation.Root` | `stateSchema` as `StateSchema` with a `ReducedValue` per field (`createAgent` rejects annotations) |
| `preModelHook` summarization returning `llmInputMessages` | `beforeModel` updates `runningSummary` and writes the condensed view to a private untracked field; `wrapModelCall` sends that view |
| `ToolNode` turns every tool error into `status: "error"` ToolMessage (`Error: <msg>\n Please fix your mistakes.`) | `wrapToolCall` produces the same message; without it, `createAgent` makes an uncaught tool error fatal once any `wrapToolCall` exists, and its own error messages carry no status |
| `returnDirect` flag on the LangChain tool, routed by name | the flag is no longer set on the LangChain tool; `beforeModel` (`canJumpTo: ["end"]`) jumps to end when the trailing tool results include a successful result from a returnDirect tool |
| `version: "v2"` (one `Send` per tool call) | `createAgent` always dispatches one `Send` per tool call |

Everything B4 reads off the event stream is unaffected: projection keys off
event types and ids, not graph node names.

## Superstep budget

Each `beforeModel` middleware is its own graph node, so it costs one superstep
per loop against `recursionLimit`. B4 registers ONE middleware, and gives it a
`beforeModel` hook only when the route has summarization or a returnDirect
tool, so the per-loop cost is unchanged: `model_request + tools` without
either, one extra node with either (summarization already cost one).

## Dependencies

`@b4run/langchain` gains `langchain` ^1.5.12 and its `@langchain/core` peer
floor rises from ^1.1.47 to ^1.2.12 (`langchain`'s own peer).

## Found during implementation

- **Middleware node write-back.** A `beforeModel` node returns
  `{ ...state, ...update }` over the fields its middleware declares, so a
  non-idempotent reducer (`append`) would re-apply. Hence two middlewares: the
  node-free model/tool middleware declares the route's fields to read them; the
  loop-entry middleware declares only replace-semantics fields.
- **String system prompts become content blocks.** `createAgent` turns a
  string `systemPrompt` into `[{ type: "text", text }]`; B4 passes a
  `SystemMessage` so the provider payload stays the plain string it was.
- **One `@langchain/langgraph` copy.** Adding `zod` resolved `^4.4.3` to 4.6.5
  and split `@langchain/langgraph` into two peer-variant copies, so the CLI's
  `Command` failed `instanceof` in `@b4run/langchain` and resumes stopped
  resuming. The lockfile keeps zod 4.4.3; `@b4run/cli` declares `zod` and
  `langchain` dev dependencies so its resolution matches.
- **Failed turns still write.** LangGraph persists checkpoints asynchronously,
  and the checkpoint owning a parked interrupt can be put after the run's
  stream rejects. `/runs/wait`'s failure arm read the checkpoint at rejection
  and missed the park (the gate's "resultPromise has resolved, so the route is
  done writing" assumption). It passed on `createReactAgent` by microseconds.
  `trackCheckpointWrites` wraps the graph's checkpointer and the adapter drains
  in-flight writes before a failure propagates.
- **Vercel self-contained bundle.** `createAgent` imports `initChatModel`,
  whose `import(config.package)` is a non-literal dynamic import the Vercel
  function validator rejects. The Vercel esbuild plugin rewrites that one
  expression into a clear failure (B4 always passes a model instance) and
  fails the build if a future `langchain` changes it.

## Tasks

1. Dependency and peer floor (`packages/langchain/package.json`, lockfile).
2. `state-adapter.ts`: `materializeStateSchema` returns a `StateSchema`.
3. `agent-middleware.ts` (new): prompt fragments, summarization split, tool
   error status, returnDirect end-on-success. Unit tests.
4. `agent-adapter.ts`: `materializeAgent` builds with `createAgent`.
5. `tool-converter.ts`: stop setting `returnDirect` on the LangChain tool.
6. Tests: rewrite the `@langchain/langgraph/prebuilt` mocks as `langchain`
   mocks; `return-direct-graph.test.ts` pins end-on-success (the failed call
   goes back to the model) through the real materialized graph.
7. Docs (`tools.mdx`, the core `returnDirect` JSDoc) and a patch changeset.
8. Full `pnpm ci:validate`-equivalent gates, harness lanes included.
