---
"@b4run/ag-ui": patch
"@b4run/cli": patch
"@b4run/langchain": patch
"@b4run/sdk": patch
---

Keep resumed browser tools attached to their existing client history without
inventing a new parent or appending the argument JSON again. Add a validated
`agent({ maxOutputTokens })` option and apply it to every provider model call,
including browser-tool continuations and structured output.
