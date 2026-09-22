---
"@b4run/langchain": patch
"@b4run/cli": patch
"@b4run/core": patch
"@b4run/testing": patch
"@b4run/postgres-storage": patch
"@b4run/sqlite-storage": patch
---

LangChain dependencies move to their current releases: `@langchain/core` 1.2.12, `@langchain/langgraph` 1.4.17, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/openai` 1.5.13, `@langchain/anthropic` 1.5.11, `@langchain/google-genai` 2.3.2, `@langchain/xai` 1.4.13 and `@langchain/openrouter` 0.4.13, with the peer ranges raised to match. The lockfile is deduplicated so that every workspace package resolves the same single copy of `@langchain/langgraph` and `@langchain/core`.
