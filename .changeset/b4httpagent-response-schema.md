---
"@b4run/ag-ui": patch
---

`B4HttpAgent` takes a `responseSchema`: every run then carries `hashbrown: { ui: true, responseSchema }`, so a CopilotKit runtime route can constrain a route's final answer to a JSON Schema (B4.run binds it as the provider's structured output).
