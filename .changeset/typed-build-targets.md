---
"@b4run/core": patch
"@b4run/cli": patch
---

Type `build.targets` in `config()` as the union of known build target names (`"node" | "langsmith" | "hono" | "vercel"`, exported as `BuildTargetName`) instead of `readonly string[]`, so a misspelled target such as `"vercell"` fails to type-check rather than at `b4 build`. The union is derived from the new `BUILD_TARGET_NAMES` tuple in `@b4run/core`, and the CLI's target registry is typed over it, so the two cannot drift. Untyped configs are still validated at build and check time with the same error message.
