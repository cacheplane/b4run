---
"@b4run/langchain": patch
"@b4run/sdk": patch
---

`agent({ reasoning: { effort } })` now reaches OpenAI. B4.run passed the effort to `ChatOpenAI` as the constructor field `reasoningEffort`, which `@langchain/openai` reads only as a per-call option, so the setting was silently dropped and every OpenAI agent ran at the model's default effort. It is now passed as `reasoning: { effort }`, which the request carries as `reasoning_effort` (Chat Completions) or `reasoning.effort` (Responses). Routes that set `reasoning` will now actually run at that effort; check their latency and output quality after upgrading.
