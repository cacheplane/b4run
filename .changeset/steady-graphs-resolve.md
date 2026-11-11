---
"@b4run/core": patch
"@b4run/langchain": patch
"@b4run/langgraph": patch
---

Keep the published LangChain runtime dependencies on compatible versions so standalone installs can use the supported minimum of `@langchain/core` and load the CLI.

Preserve raw graph resume when the application and the adapter load different copies of LangGraph.
