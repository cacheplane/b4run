---
"@b4run/cli": patch
"@b4run/core": patch
---

Let the `vercel` build target publish somewhere other than `.vercel/output`: `b4 build --out-dir <dir>` or `build.vercel.outDir` in `b4.config.ts`, resolved relative to the app root, with the flag taking precedence. A directory that contains the app root is rejected before anything is written, and `--out-dir` is an error when `"vercel"` is not a configured target.

Relax the Vercel output validator so a composed Build Output tree still validates: `config.json` must be version 3 and contain a route whose `dest` is `/index`, rather than matching the exact catch-all the build writes. Extra routes and top-level keys added after the build are accepted.
