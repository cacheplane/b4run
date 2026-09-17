# Vercel target: composed Build Output (static, functions, routes)

Issue: cacheplane/b4run#679. Related: #680 (output dir, validator), #687
(function name shadows `/`).

## Problem

`b4 build` with `targets: ["vercel"]` emits exactly one function
(`.vercel/output/functions/index.func`) and a catch-all `config.json`. A real
app also ships a SPA and its own endpoints, so today the published tree has to
be post-processed by an external assembler (hashbrown's
`tools/vercel/assemble.mjs`), which also has to rename the function because
`index.func` is served at `/` and shadows a static `index.html`.

## Approaches considered

1. **Describe the tree in `b4.config.ts` and let the target compose it**
   (chosen). One build, one validated staging tree, one atomic publish. The
   config is data the existing `BuildEmitContext` can carry.
2. Ship an `assemble`-style CLI subcommand that mutates a published tree.
   Rejected: it keeps the two-step dance, cannot reuse the staging/backup
   publication, and leaves `validateVercelOutput` unable to accept the result.
3. Let apps hand-write `.vercel/output/config.json` and merge it. Rejected:
   merging user JSON with generated routes is ambiguous about ordering, which
   is the whole problem.

## Config

```ts
build?: {
  targets?: readonly string[]
  vercel?: {
    /** Runtime function name. Default "index"; "b4" when `static` is set. */
    functionName?: string
    static?: { dir: string; spaFallback?: string }
    functions?: Readonly<Record<string, {
      entry: string
      runtime?: string                  // default "nodejs24.x"
      maxDuration?: number              // positive integer, seconds
      supportsResponseStreaming?: boolean
    }>>
    routes?: readonly VercelRoute[]     // { src: string, dest?, headers?, methods?, status?, ... }
  }
}
```

Paths (`static.dir`, `functions.*.entry`) resolve relative to the app root.
`static.spaFallback` is relative to `static.dir` and must be an existing file.

`build.vercel` is ignored unless `"vercel"` is in `build.targets`.

### Function name (#687)

* No `static` and no `functionName`: `index`, exactly today's output. The
  gated `vercel-native` lane pins that listing and existing deployments rely
  on it, so the bare-runtime default does not move.
* `static` configured and no `functionName`: `b4`, so `/` is served by
  `static/index.html` rather than by the function.
* `functionName: "index"` together with `static` fails the build: it would
  shadow the static root and there is no useful tree to publish.
* Names must match `/^[A-Za-z0-9_-]+$/`; the runtime name and every key of
  `functions` must be distinct.

`outDir` (#680) is deliberately not part of this change; it stays open there.

## Composed tree

```
.vercel/output/
  config.json
  static/**                      (copy of static.dir, symlinks dereferenced)
  functions/<functionName>.func/ .vc-config.json + index.mjs   (runtime)
  functions/<name>.func/         .vc-config.json + index.mjs   (per `functions` entry)
```

Extra functions are bundled with esbuild using the same options as the runtime
bundle (`bundle`, `platform: node`, `format: esm`, `target: node24`, the Vercel
node-compatibility plugin). Their `.vc-config.json` is
`{ handler: "index.mjs", launcherType: "Nodejs", runtime, maxDuration?, supportsResponseStreaming? }`
in that key order.

### Route order

```
[ ...routes,                                   // user routes first
  { handle: "filesystem" },                    // static files and functions by path
  { src: <runtime src>, dest: "/<functionName>" },
  { src: "/(.*)", dest: "/<spaFallback>" } ]   // only when static.spaFallback is set
```

`<runtime src>` is `/(.*)` (today's catch-all) unless `spaFallback` is set, in
which case the runtime is scoped to the surfaces it owns,
`/(healthz|agui|threads|memory)(/.*)?`, so every other path falls through to
the SPA. With no `build.vercel` the config is byte-for-byte today's
`{ routes: [{ dest: "/index", src: "/(.*)" }], version: 3 }`.

User routes may not contain a `handle` phase (the target owns phases). Each
must be an object with a string `src`; other keys are limited to Vercel's
documented route keys (`dest`, `headers`, `methods`, `status`, `continue`,
`check`, `caseSensitive`, `has`, `missing`, `important`, `override`, `locale`,
`middlewarePath`, `middlewareRawSrc`).

### Staging and publication

Everything is written under the existing per-invocation staging directory,
validated there, and published with the existing rename + backup + rollback
(`publishVercelOutput`). Unchanged.

## Validator

`validateVercelOutput(outputDir, { functionName = "index" } = {})`:

* `config.json`: only `version` and `routes`; `version === 3`; `routes` is a
  non-empty array; each entry is exactly `{ handle: "filesystem" }` (at most
  one) or a route object with string `src` and allow-listed keys; at least one
  route has `dest === "/<functionName>"`.
* The runtime function `.vc-config.json` stays exact (`handler`,
  `launcherType`, `runtime: nodejs24.x`, nothing else).
* Every other `functions/*.func` needs `handler: "index.mjs"`,
  `launcherType: "Nodejs"`, `runtime` matching `/^nodejs\d+\.x$/`, optional
  positive-integer `maxDuration`, optional boolean `supportsResponseStreaming`,
  no other keys, a regular-file `index.mjs`, and passes the same symlink
  containment and dependency-containment checks as the runtime function.

The one-argument call in the native lane fixture keeps working.

## Plumbing

`BuildEmitContext` gains optional `config?: B4Config`; `build.ts` passes the
config it already loaded. The vercel target reads `ctx.config?.build?.vercel`.

## Errors

Config shape problems throw `CliError` naming the `build.vercel.<path>` that is
wrong, before any `.vercel` write. Bundle failures of an extra function name
the function and its entry.

## Testing

Pure units: `resolveVercelBuildConfig` (defaults, the `b4` flip, every
rejection), `composeVercelRoutes` (four orderings). Validator: accepts a
composed config, rejects a config without the runtime route, accepts and
rejects extra-function configs; the two existing route-shape rejection tests
keep their locations. Integration through `runBuildCommand`: a fixture with
`static` + `spaFallback` + one extra function + one user route produces the
expected tree, `config.json`, and both `.vc-config.json` files; explicit
`functionName`; `index` + `static` fails before `.vercel` exists; the default
build listing is unchanged.

## Docs

`configuration.mdx` `build` section, `cli.mdx` target list gains the `vercel`
bullet, `deployment/edge.mdx` gains a Vercel section describing the composed
tree and route order, `types.ts` JSDoc. Changeset: `@b4run/cli` and
`@b4run/core`, patch.
