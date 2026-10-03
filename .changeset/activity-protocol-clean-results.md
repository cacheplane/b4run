---
"@b4run/ag-ui": patch
"@b4run/core": patch
---

AG-UI `TOOL_CALL_RESULT.content` now carries the tool's output — the text the model received — instead of the serialized LangChain `ToolMessage`. Permission interrupts name the tool call they gate (`toolCallId`; command, tool and memory gates), a tool, command, path or memory gate raised inside a subagent also carries `subagentRunId`, and every permission prompt advertises its answers as `responseSchema: { enum: ["once", "always", "deny"] }`.
