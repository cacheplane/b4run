---
"@b4run/langchain": patch
---

Assistant text now streams for providers that deliver it as content blocks. LangChain's Anthropic integration coerces a chunk's content to a plain string only when the request binds no tools, and every B4 agent binds tools, so an Anthropic-backed agent produced no assistant text tokens at all; the same shape reaches the adapter from OpenAI's Responses API. The agent adapter now reads a chunk's `text` blocks, ignoring thinking, citation and tool-input deltas, so those models stream their prose like any other.
