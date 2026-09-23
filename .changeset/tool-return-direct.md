---
"@b4run/langchain": minor
"@b4run/cli": minor
"@b4run/core": minor
---

A tool module can export `returnDirect = true` to end the run on its result instead of handing control back to the model for another turn. LangGraph's prebuilt agent already routes such a tool straight to the end of the graph; B4 now reads the export during tool discovery, carries it on the tool definition, and sets it on the LangChain tool. The run's last message is then the tool result: no closing assistant message is produced, the AG-UI stream ends after `TOOL_CALL_RESULT`, and a middleware `after` hook sees an empty final message. A non-boolean export is a discovery error.
