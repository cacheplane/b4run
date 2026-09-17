---
"@b4run/sdk": patch
"@b4run/core": patch
"@b4run/cli": patch
---

`b4 check` no longer reports a clean `0 routes discovered` for an app whose `package.json` lacks `"type": "module"`. Route discovery now fails with `B4_E1006` naming the app root's `package.json`, and a route `index.ts` with no recognisable export fails with `B4_E1007` naming the file, the exports it found, and, when the module was loaded as CommonJS, the nested `package.json` that caused it. Closes #685.
