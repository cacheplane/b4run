---
"@b4run/langchain": minor
"@b4run/ag-ui": minor
"@b4run/cli": patch
---

Tool-call arguments now stream as they are generated. The LangChain agent adapter projects the argument fragments a provider streams into `tool_call_args` chunks, re-serialized token by token so their concatenation matches the `JSON.stringify(args)` delta sent today byte for byte, and the AG-UI translator emits them as one `TOOL_CALL_START`, several `TOOL_CALL_ARGS` deltas and one `TOOL_CALL_END` under the call's logical id. A client that renders from a tool call's arguments can paint progressively, the way it does for assistant text. Tool execution still receives the complete, parsed arguments from the unchanged `tool_call` announce; providers that stream no fragments produce exactly the output they did before; the built-in `writeTodos` and `task` calls stay on the single-delta path. The runtime's middleware `after` hook treats a fragment as proof a held message was not final, and the live tail renders nothing for fragments.
