---
"@b4run/sdk": patch
"@b4run/ag-ui": patch
"@b4run/langchain": patch
"@b4run/cli": patch
"@b4run/testing": patch
---

Carry AG-UI 1.0 content parts to the model. A user message's `image`, `audio`, `video` and `document` parts — inline, by URL, or as a provider file handle — reach the route's model as LangChain content blocks; what the model cannot take (read from its LangChain profile) is dropped and announced, in the server log and on the stream as `CUSTOM` `b4.content_parts_dropped`, never refused: the `422` envelope rejection of media parts is gone. Tools may return `B4ContentPart[]` (new in `@b4run/sdk`), which travels as `TOOL_CALL_RESULT.content`. The Agent Protocol run endpoints now bound their bodies at the same 8 MiB as `/agui`. `B4Message.content` (`@b4run/ag-ui`) and `UnwrappedToolResult.content` (`@b4run/langchain`) widened from `string` to `string | readonly B4ContentPart[]`, so code that narrows on `string` must handle the array.
