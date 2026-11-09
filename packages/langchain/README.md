# @b4run/langchain

LangChain adapters for materializing B4.run agents and chains, converting tools, streaming, embeddings, and retry.

**Use this when:** You are materializing or extending B4.run's LangChain agent and chain bridge. Application routes normally declare agents through [`@b4run/sdk`](https://www.npmjs.com/package/@b4run/sdk) and let the runtime use this layer.

## Install

```bash
pnpm add @b4run/langchain @langchain/core @langchain/langgraph-checkpoint
```

Install the optional LangChain provider package selected by your agents. `@langchain/openai` is included; Anthropic, Google, Mistral, Groq, Ollama, xAI, and OpenRouter integrations are optional peers.

## Example

```ts
import { chainAdapter, openaiEmbedder } from "@b4run/langchain"

export const adapter = chainAdapter
export const embedder = openaiEmbedder({ model: "text-embedding-3-small" })
```

`chainAdapter` adapts a LangChain runnable to B4.run's chain backend contract. `openaiEmbedder` supplies the memory embedding seam and reads provider configuration when first used.

Agent descriptors can enable provider-owned search, code and image capabilities
with `builtInTools`. Provider calls are normalized separately from app functions,
retained in native v0 AIMessage history, and projected live and after restore as
`b4.step` activity with `b4.answer` citations. Google routes use the optional
`@langchain/google` integration with retained native chunks and grounding
attribution. Applications must render Google Search Suggestions unchanged.
See [provider built-ins](https://b4.run/docs/agents#provider-built-ins). File search
remains deferred; Anthropic fetch/code execution are disabled.

## Cooperative Stop

Adapters accept optional `stopSignal` separately from the hard `signal`. Native
LangGraph Stop finishes the active superstep and checkpoint writes, then prevents
the next step. Stop-capable calls use synchronous checkpoint durability; this
adds persistence latency before each next step and preserves write failures.
A request alone is not a stopped outcome: natural completion and independent
errors keep their meanings. Awaited parallel tools, retries and opaque nested
calls belong to their parent step. Detached callbacks, remote effects and
subprocess quiescence are outside this guarantee.

Supported compiled state graphs and adapter-materialized B4 agents retire
pending actions without executing them before reporting Stop, and check again
before fresh input. State/history and uncertainty remain; live permission parks
require their existing explicit authorized `Command` resume. A standalone chain
adapter's explicit `null` remains native continuation. Opaque invocation contexts
receive `stopSignal`; B4 tool contexts keep their existing hard signal.

The staged coordinated runtime preserves its durable stopped head and retires
pending tasks through guarded reconciliation before accepting a fresh turn.
A hard-aborted invocation can return before abort-ignoring work finishes; its
effects remain uncertain. These internal hooks do not activate new transports.

## Runtime and stability

- `@b4run/langchain` is an edge-safe, supported integration surface.
- `@b4run/langchain/internal/runtime` is edge-safe internal boot-owned adapter binding; it is not an application route or caller-configurable execution API.
- Edge-safe describes B4.run's emitted edge target; it is not a promise that every provider integration, application tool, or dynamically loaded package is browser-portable.
- `@b4run/langchain/package.json` exposes package metadata for tooling, not runtime code.

## Related

- [`@b4run/sdk`](https://www.npmjs.com/package/@b4run/sdk) — author-facing agent and chain declarations.
- [`@b4run/langgraph`](https://www.npmjs.com/package/@b4run/langgraph) — raw graph and workflow route adapters.
- [LangChain API reference](https://b4.run/docs/api/langchain) — full exports, peers, and runtime contracts.
- [Agents guide](https://b4.run/docs/agents) — define application agents through the author-facing API.

## Maturity and support

This package is pre-1.0 and releases in B4.run's fixed package group. Review the [changelog](https://github.com/cacheplane/b4run/blob/main/packages/langchain/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
