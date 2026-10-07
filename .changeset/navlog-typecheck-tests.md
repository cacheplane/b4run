---
"@b4run/devkit": patch
---

The navlog template's server `tsconfig.json` now typechecks its `test/` files too (with `allowImportingTsExtensions`, since the tests import their sources with a `.ts` extension), so `pnpm typecheck` in a generated navlog app covers the tests as well as `src/`.
