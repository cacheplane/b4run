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

## Runtime and stability

- `@b4run/langchain` is an edge-safe, supported integration surface.
- Edge-safe describes B4.run's emitted edge target; it is not a promise that every provider integration, application tool, or dynamically loaded package is browser-portable.
- `@b4run/langchain/package.json` exposes package metadata for tooling, not runtime code.

## Related

- [`@b4run/sdk`](https://www.npmjs.com/package/@b4run/sdk) — author-facing agent and chain declarations.
- [`@b4run/langgraph`](https://www.npmjs.com/package/@b4run/langgraph) — raw graph and workflow route adapters.
- [LangChain API reference](https://b4.run/docs/api/langchain) — full exports, peers, and runtime contracts.
- [Agents guide](https://b4.run/docs/agents) — define application agents through the author-facing API.

## Maturity and support

This package is pre-1.0 and releases in B4.run's fixed package group. Review the [changelog](https://github.com/cacheplane/b4-run/blob/main/packages/langchain/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/b4-run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4-run/blob/main/LICENSE).
