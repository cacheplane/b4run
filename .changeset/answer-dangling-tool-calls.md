---
"@b4run/langchain": patch
---

A thread whose last run was cut off between a model turn and its tool calls (by `recursionLimit`, an abort or a crash) no longer fails every later turn. The checkpoint keeps that assistant message with `tool_calls` and no results, which providers refuse (OpenAI: "An assistant message with 'tool_calls' must be followed by tool messages"). Agent routes now give each such call an error result in the history the model is sent, so the next turn runs; the checkpoint itself is unchanged.
