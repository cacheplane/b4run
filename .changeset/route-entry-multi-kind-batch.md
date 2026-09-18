---
"@b4run/sdk": patch
"@b4run/core": patch
---

Route discovery reports every route `index.ts` that exports more than one of `agent`, `workflow`, `graph`, or `chain` in a single run, as the new `B4_E1008`, naming each file and the kinds it exported. The message used to omit the file path and threw from inside the route walk, so an app with several of these surfaced them one per run.
