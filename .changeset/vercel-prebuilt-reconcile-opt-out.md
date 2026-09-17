---
"@b4run/cli": patch
"@b4run/core": patch
---

Add `build.vercel.reconcileVercelJson` so a prebuilt Vercel flow (`vercel deploy --prebuilt`, no Vercel Git integration) can opt the `vercel` target out of `vercel.json` reconciliation. With it set to `false`, `b4 build` neither requires, writes, nor inspects a committed `vercel.json` whose `buildCommand` would never run, and no longer fails on a committed `fluid: false`. Because reconciliation stays on unless the flag is exactly `false`, `b4 check` and `b4 build` reject every near miss with `B4_E1003` — a non-boolean value, a non-object `build.vercel`, an unknown key inside it, or the flag misplaced directly on `build` — rather than reading as configured while still reconciling. Fluid compute guidance is unchanged for the deployed project.
