---
"@b4run/sdk": patch
"@b4run/langchain": patch
"@b4run/ag-ui": patch
"@b4run/cli": patch
"@b4run/testing": patch
---

**Breaking:** `agent()`'s `reasoning` is keyed by provider. `reasoning: { effort }` becomes `reasoning: { openai: { effort } }`; a flat `effort`, an unknown key, or a block for a provider the route does not resolve to now fails the route when its model is built (before, a misplaced setting was silently ignored — and the OpenAI effort itself never reached the request, because it was passed as the constructor field `reasoningEffort`, which `@langchain/openai` reads only per call). New controls make reasoning visible: `openai.summary: "auto" | "concise" | "detailed"` streams a reasoning summary (and moves the route to the Responses API); `anthropic.budgetTokens` enables extended thinking. The langchain adapter carries thinking and reasoning blocks as `reasoning` stream chunks; `@b4run/ag-ui` frames them as AG-UI 1.0 `REASONING_START` / `REASONING_MESSAGE_*` / `REASONING_END`, one span and one `role: "reasoning"` message per model invocation, every one closed before the run ends. `GET /agui/:routeId` advertises `reasoning: { supported: true, streaming: true, encrypted: false }` exactly when the route's config makes reasoning stream, `{ supported: false }` otherwise. `IdFactory` gains the `reasoning` and `reasoningSpan` kinds.

`@b4run/testing`'s `finalMessage` now reads an assistant message whose `content` is a list of blocks (the OpenAI Responses API, Anthropic with tools bound), joining its `text` blocks; before, such a run reported an empty final message.
