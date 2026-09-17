---
"@b4run/cli": patch
"@b4run/core": patch
---

Rename the `vercel` build target's function from `index.func` to `b4.func` and add `build.vercel.functionName`.

In the Vercel Build Output API a function named `index` is also served at `/`, so `.vercel/output/functions/index.func` shadowed a static `index.html` for any app shipping a frontend beside the runtime (#687). `b4 build` now emits `.vercel/output/functions/b4.func` with `config.json` routing `/(.*)` to `/b4`, and the output validator checks that name and route as a pair.

`build.vercel.functionName` picks another name: one path segment of letters, digits, `_` or `-`. It is validated by the same `build.vercel` resolver as `reconcileVercelJson`, so `b4 check` and `b4 build` both reject a bad value with `B4_E1003` before anything is written.

**Compatibility:** the output path changes for every existing `vercel` deployment. Anything that reads `.vercel/output` by path (deploy scripts, assemblers that copy the function, CI checks) must use the new name, or set `build: { vercel: { functionName: "index" } }` to keep the old layout.
