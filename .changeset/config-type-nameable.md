---
"@b4run/cli": patch
"@b4run/devkit": patch
---

`@b4run/cli` now exports the `B4Config` type alongside `config()`. Under pnpm's isolated `node_modules`, an app depends only on `@b4run/cli` and cannot resolve `@b4run/core`, so `export default config({})` in `b4.config.ts` failed `tsc` with TS2883 (the inferred `B4Config` type could not be named). This affected the research template. The basic template's `b4.config.ts` now uses `config({})` too.
