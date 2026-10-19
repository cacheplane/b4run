---
"@b4run/sdk": patch
"@b4run/langchain": patch
"@b4run/ag-ui": patch
---

A tool's `display` can word a call that threw: `failed(input, error)` labels the failed step, live and after a reload. Without it, B4.run's chat components read "searchCorpus failed" instead of "Used searchCorpus · failed".

The activity kit's `labels` overrides take `fields`, readable names for a tool's argument keys, which the approval card and the step's detail use for their rows (`{ fileFlightPlan: { fields: { item7: "7 Aircraft ID" } } }`).

A settled subagent row keeps the sentence it ran with: "Asked researcher · 5 steps" or "Asked researcher · failed · boom", instead of "researcher finished · 5 steps". `stepMeta` takes the step's `labels` as an optional second argument.
