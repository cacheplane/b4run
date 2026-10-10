---
"@b4run/ag-ui": patch
---

`B4HttpAgent` takes a `responseSchema`. Every run then carries it as `forwardedProps.responseSchema`, merged with any other `forwardedProps` the run sends, so a CopilotKit runtime route can constrain a route's final answer to a JSON Schema. B4.run binds it as the provider's structured output. The route must allow the key in `server.agui.clientForwardedProps`.
