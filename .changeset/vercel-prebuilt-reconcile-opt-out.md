---
"@b4run/cli": patch
"@b4run/core": patch
---

Add `build.vercel.reconcileVercelJson` so a prebuilt Vercel flow (`vercel deploy --prebuilt`, no Vercel Git integration) can opt the `vercel` target out of `vercel.json` reconciliation. With it set to `false`, `b4 build` neither requires, writes, nor inspects a committed `vercel.json` whose `buildCommand` would never run; `b4 check` rejects a non-boolean value. Fluid compute guidance is unchanged for the deployed project.
