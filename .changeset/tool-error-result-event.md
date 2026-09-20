---
"@b4run/langchain": patch
"@b4run/testing": patch
---

Emit a `tool_result` when a tool throws, so AG-UI clients see `TOOL_CALL_RESULT`.

`@b4run/langchain`'s agent adapter mapped `on_tool_end` to a `tool_result`
chunk and emitted nothing for a non-interrupt `on_tool_error`, so a client saw
`TOOL_CALL_START`, `TOOL_CALL_ARGS` and `TOOL_CALL_END` for a failing tool and
never a `TOOL_CALL_RESULT`; the error ToolMessage LangGraph hands the model
appeared only inside `RUN_FINISHED.result.messages`. The adapter now holds a
thrown root execution and resolves it from the `status: "error"` ToolMessage
the tool node appends for the model, emitting a `tool_result` keyed by the same
tool-call id whose `output` is that ToolMessage — serialized exactly like a
successful result. `interrupt()` throws are unaffected.

`@b4run/testing`'s `collectRunResult` now builds `run.toolResults` from the
streamed `tool_result` chunks (reading a ToolMessage, a Command's ToolMessage,
or a plain output), so a thrown tool is marked `isError` without reading the
final messages; a stream that carried no tool results still falls back to
`deriveToolResults` over the final messages.
