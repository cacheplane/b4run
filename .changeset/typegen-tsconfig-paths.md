---
"@b4run/core": patch
"@b4run/cli": patch
"@b4run/vite-plugin": patch
---

Derive tool schemas with the app's own `tsconfig.json` and fail loudly on unresolved input types. The tool program `extractToolSchemasForRoute` / `extractToolTypesForRoute` build now reads the nearest `tsconfig.json` above the app root (honoring `extends`, `paths`, and `baseUrl`; an explicit `tsconfig` option is also accepted), so an input type imported through a path alias no longer resolves to `any` and derives its real schema. When a declared input type still resolves to `any`/`unknown`, or an import it depends on does not resolve, extraction throws `UnresolvedToolInputTypeError` naming the tool file, the type, and the tsconfig used; `b4 typegen` and `b4 verify` surface it as a failure instead of writing `{ properties: {} }`. Tools that take no input (`{}`, `Record<string, never>`, no parameter) keep working.
