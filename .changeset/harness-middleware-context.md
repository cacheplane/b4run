---
"@b4run/testing": patch
"@b4run/evals": patch
"@b4run/cli": patch
---

`createAgentHarness` accepts a `middlewareContext` option — a value or a `(run) => context` function evaluated per `run()`/`resume()` — so tools that read `ctx.middleware` can be exercised in-process even though the harness bypasses `middleware.ts`. `defineEval` accepts the same field and `b4 eval` forwards it to the harness.
