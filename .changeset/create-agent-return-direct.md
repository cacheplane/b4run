---
"@b4run/langchain": patch
"@b4run/core": patch
"@b4run/cli": patch
---

Agent routes now run on LangChain's `createAgent` instead of LangGraph's deprecated `createReactAgent`, and a `returnDirect` tool ends the run only when it succeeds. A failed call (the tool threw, or the model's arguments failed its schema) now goes back to the model, which can correct the call and retry; the first successful result ends the run. Previously the error ended the run, so a validating tool could not use `returnDirect`.

B4 installs its own `createAgent` middleware for what `createReactAgent` did through options: prompt fragments re-rendered from live state, summarization's condensed history, and tool errors returned to the model as `status: "error"` results in the same `Error: … Please fix your mistakes.` form as before. A route without summarization or a `returnDirect` tool keeps the same number of graph steps per model/tool turn, so `recursionLimit` budgets are unchanged.

`@b4run/langchain` now depends on `langchain` ^1.5.12, and its `@langchain/core` peer range rises from ^1.1.47 to ^1.2.12 (the range `langchain` itself requires).
