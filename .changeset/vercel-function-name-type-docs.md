---
"@b4run/core": patch
---

Correct the `build.vercel` type documentation for the unconditional runtime function name. `functionName` documented its old conditional default, and `build.vercel` described a bare build as emitting `functions/index.func`. Both now say `b4`, matching what the target emits.
