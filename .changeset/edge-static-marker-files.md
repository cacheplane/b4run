---
"@b4run/core": patch
"@b4run/cli": patch
---

Route skills, `plan.md`, and `memory.md` now work on the `hono` and `vercel` targets: `b4 build` bundles them into the static manifest and the runtime serves them through the new `staticMarkerFs` in `@b4run/core`. The build no longer gates skills off those targets; instead `b4 build` and `b4 check` enforce a per-file size limit (32 KiB for `SKILL.md` and `memory.md`, 64 KiB for `plan.md`) and fail with `B4_E1005` by name. `@b4run/core` also exports `MAX_PLAN_BYTES` and `MAX_MEMORY_BYTES`.
