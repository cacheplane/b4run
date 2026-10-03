---
"@b4run/ag-ui": patch
"@b4run/langchain": patch
---

AG-UI terminal events now report token usage. `RUN_FINISHED` (every outcome) and `RUN_ERROR` carry `usage: TokenUsage[]` — one entry per provider and model, aggregated across the run including subagent calls, with the protocol's inclusive totals and no zeros for counts a provider did not return; the key is omitted when nothing was reported. The langchain agent adapter emits a `usage` stream chunk (`{ provider, model, usage_metadata }`, a `subagent.usage` for a child's call) per finished model call, which also reaches the Agent Protocol stream as `event: usage`.
