---
"@b4run/cli": patch
"@b4run/core": patch
---

Add `build.vercel.maxDuration`, the runtime function's `maxDuration` in seconds. A composed function under `build.vercel.functions` could already declare one; the runtime function — the one that runs the agent, and so the one a long tool-using run outgrows — could not, leaving the ceiling to the project's dashboard setting with no way to state it in the repository.

Omitted, nothing changes: no `maxDuration` is written and Vercel applies the project default. Set, the value is written onto `functions/<name>.func/.vc-config.json` and `validateVercelOutput` requires exactly that value there, so the published tree cannot disagree with the config it was built from. The duration is validated as a positive integer under `B4_E1003`, by the same assertion the composed functions use.
