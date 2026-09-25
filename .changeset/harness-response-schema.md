---
"@b4run/testing": patch
"@b4run/evals": patch
"@b4run/cli": patch
---

`createAgentHarness` and `defineEval` accept a `responseSchema`: the JSON Schema a Hashbrown client sends as `hashbrown.responseSchema`. The harness binds it on the root model exactly as the server does for an AG-UI run, with the same validation and provider-facing name. Scripted, live and recorded runs then send the model the same `response_format` production sends. Before, a recording made through the harness ran unconstrained, so it could capture replies production never produces, such as an empty final message. A route or provider that cannot constrain its output fails the run instead of running unconstrained. `@b4run/cli/runtime` now exports `readResponseFormat`, the server's parser for that field.
