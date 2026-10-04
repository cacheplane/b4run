# Navlog PR 1 + PR 2: `serve()` guard and the mechanical rename

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the first two PRs of the navlog series from
`docs/superpowers/specs/2026-10-04-navlog-example-design.md`: a request guard
for `serve()` in `@b4run/cli` (PR 1), and the mechanical rename of the research
example, template and template id to `navlog` (PR 2).

**Architecture:** PR 1 adds one option, `guard`, to `serve()`: a handler that
runs before the runtime/fallback split and may answer the request itself. The
spec named "export the runtime request listener"; a `guard` option is the same
seam with `serve()`'s ordered shutdown and signal handling kept, so the
deployment entry point does not re-implement them. PR 2 is a scripted rename
with an explicit mapping table and no content changes beyond identifiers.
Recipe-page slugs, titles and prose stay as they are (PR 6 rewrites them); only
literal identifiers that would otherwise be false (`/research#agent`,
`src/app/research/`, `--template research`) change across docs.

**Tech Stack:** TypeScript, Node 24, pnpm workspaces, Vitest, Biome, Next.js,
turbo, changesets.

**Branching:** one branch per PR off `main`. Before each PR, `git fetch origin
main` and start from it. The lockfile re-keys in PR 2, so re-fetch main right
before merging PR 2 (a stale lockfile fails Install and reds every job).

**Run every command from the repo root. Use Node 24 (`nvm use 24`).**

---

## PR 1: `serve({ guard })`

### Files

- Modify: `packages/cli/src/lib/dev/serve.ts`
- Modify: `packages/cli/test/serve.test.ts`
- Modify: `apps/web/content/docs/embedding.mdx`
- Create: `.changeset/serve-guard.md`
- Regenerate: `apps/web/app/seo/lastmod.generated.json`

### Task 1: the `guard` option

**Files:**
- Modify: `packages/cli/src/lib/dev/serve.ts:12-30` (options) and `:84-102` (server callback)
- Test: `packages/cli/test/serve.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `packages/cli/test/serve.test.ts` directly after
the `describe("serve route split", …)` block (before `describe("serve lifecycle", …)`):

```ts
describe("serve guard", () => {
  test("runs before the split and sees runtime-owned and fallback paths alike", async () => {
    const guarded: string[] = []
    const fallbackPaths: string[] = []
    const handle = await startServe(recordingFallback(fallbackPaths), {
      guard: (request) => {
        guarded.push(request.url ?? "")
        return false
      },
    })

    const health = await fetch(new URL("/healthz", handle.url))
    expect(health.status).toBe(200)
    const other = await fetch(new URL("/app/page?x=1", handle.url))
    expect(await other.text()).toBe("fallback")

    expect(guarded).toEqual(["/healthz", "/app/page?x=1"])
    expect(fallbackPaths).toEqual(["/app/page?x=1"])
  })

  test("a guard that answers the request stops it reaching the runtime or the fallback", async () => {
    const fallbackPaths: string[] = []
    const handle = await startServe(recordingFallback(fallbackPaths), {
      guard: (request, response) => {
        if (request.headers["x-internal-token"] === "secret") return false
        response.writeHead(401, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "unauthorized" }))
        return true
      },
    })

    const denied = await fetch(new URL("/healthz", handle.url))
    expect(denied.status).toBe(401)
    expect(await denied.json()).toEqual({ error: "unauthorized" })

    const allowed = await fetch(new URL("/healthz", handle.url), {
      headers: { "x-internal-token": "secret" },
    })
    expect(allowed.status).toBe(200)

    const deniedFallback = await fetch(new URL("/app", handle.url))
    expect(deniedFallback.status).toBe(401)
    expect(fallbackPaths).toEqual([])
  })

  test("an async guard is awaited", async () => {
    const handle = await startServe(undefined, {
      guard: async (_request, response) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        response.writeHead(403)
        response.end()
        return true
      },
    })

    const response = await fetch(new URL("/healthz", handle.url))
    expect(response.status).toBe(403)
  })

  test("a guard that throws answers 500 and never reaches the runtime", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const handle = await startServe(undefined, {
        guard: () => {
          throw new Error("guard exploded")
        },
      })

      const response = await fetch(new URL("/healthz", handle.url))
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: "Request guard failed" })
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
```

Extend the `startServe` helper's `overrides` type and call so the tests can
pass a guard. Replace the helper's signature and the `serve({...})` call with:

```ts
async function startServe(
  fallback: ((request: IncomingMessage, response: ServerResponse) => void) | undefined,
  overrides: {
    readonly onListening?: (url: string) => void
    /** Omit `installSignalHandlers` entirely, to exercise the default. */
    readonly defaultSignalHandlers?: boolean
    readonly guard?: ServeGuard
  } = {},
) {
  const appRoot = await createFixtureApp({
    "b4.config.ts": "export default {};\n",
    "package.json": '{"type":"module"}\n',
    "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
  })

  const handle = await serve({
    appRoot,
    host: "127.0.0.1",
    ...(overrides.defaultSignalHandlers === true ? {} : { installSignalHandlers: false }),
    onListening: overrides.onListening ?? (() => undefined),
    port: 0,
    ...(fallback ? { fallback } : {}),
    ...(overrides.guard ? { guard: overrides.guard } : {}),
  })
  handles.push(handle)
  return handle
}
```

And change the import line to pull in the new type:

```ts
import { serve, type ServeGuard, shutdownServe } from "../src/lib/dev/serve.js"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/serve.test.ts
```
Expected: a TypeScript/ESM failure that `ServeGuard` is not exported, or the
four new tests fail with the guard never being called (`guarded` is `[]`).

- [ ] **Step 3: Implement the option**

In `packages/cli/src/lib/dev/serve.ts`, add the type after `ServeFallback`:

```ts
/**
 * A handler that runs before every request, runtime-owned or not.
 *
 * Return `true` when the guard answered the request itself (a 401, a 429, a
 * redirect) and nothing else should run. Return `false` to let the request
 * continue to the runtime or the fallback. May be async.
 */
export type ServeGuard = (
  request: IncomingMessage,
  response: ServerResponse,
) => boolean | Promise<boolean>
```

Add the option to `ServeOptions`, after `fallback`:

```ts
  /**
   * Runs ahead of the runtime/fallback split for every request.
   *
   * The place for what the whole process requires of a caller before any
   * route runs: an internal token the proxy in front injects, an origin
   * check, a rate limit. Health checks included — exempt `/healthz` inside
   * the guard when the platform's probe carries no credentials. A guard that
   * throws answers 500 and the request goes no further.
   */
  readonly guard?: ServeGuard
```

Destructure it in `serve()`:

```ts
  const {
    fallback,
    guard,
    installSignalHandlers = true,
    onListening = defaultOnListening,
    ...runtimeOptions
  } = options
```

Replace the `createServer` callback with:

```ts
  const dispatch = (request: IncomingMessage, response: ServerResponse): void => {
    if (fallback === undefined || isRuntimeOwnedPath(pathnameOf(request.url))) {
      runtime.listener(request, response)
      return
    }
    void Promise.resolve(fallback(request, response)).catch((error: unknown) => {
      failFallback(response, error)
    })
  }

  const server = createServer((request, response) => {
    if (guard === undefined) {
      dispatch(request, response)
      return
    }
    void Promise.resolve()
      .then(() => guard(request, response))
      .then((handled) => {
        if (!handled) dispatch(request, response)
      })
      .catch((error: unknown) => {
        failGuard(response, error)
      })
  })
```

Add `failGuard` next to `failFallback`:

```ts
function failGuard(response: ServerResponse, error: unknown): void {
  console.error(error instanceof Error ? error.stack : error)
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(500, { "content-type": "application/json" })
  response.end(JSON.stringify({ error: "Request guard failed" }))
}
```

Export the type from `packages/cli/src/index.ts` by changing the existing
block to:

```ts
export {
  type ServeFallback,
  type ServeGuard,
  type ServeHandle,
  type ServeOptions,
  serve,
} from "./lib/dev/serve.js"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/serve.test.ts
```
Expected: every test in the file passes, including the four new ones.

- [ ] **Step 5: Lint and typecheck the package**

Run:
```bash
pnpm --filter @b4run/cli lint && pnpm --filter @b4run/cli build && pnpm --filter @b4run/cli typecheck
```
Expected: no errors. (`build` before `typecheck`, as the CI order does.)

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/dev/serve.ts packages/cli/src/index.ts packages/cli/test/serve.test.ts
git commit -m "feat(cli): serve() takes a guard that runs ahead of every request

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: document the guard

**Files:**
- Modify: `apps/web/content/docs/embedding.mdx` (after the paragraph that
  begins "`serve` defaults `installSignalHandlers` to `true`")
- Regenerate: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: Add the paragraph and example**

Insert after the `installSignalHandlers` paragraph and before "Every other
option is the runtime server's":

````mdx
`guard` runs ahead of the split, for every request the process receives. It is where a single-process deployment checks what the whole service requires of a caller before any route runs: the internal token a proxy in front injects, an origin check, a rate limit. Return `true` once the guard has answered the request itself, `false` to let it continue. A guard that throws answers 500. Exempt the health path when the platform's probe carries no credentials:

```ts title="main.ts"
await serve({
  appRoot: process.cwd(),
  guard: (request, response) => {
    if (request.url === "/healthz") return false
    if (request.headers["x-internal-token"] === process.env.B4_INTERNAL_TOKEN) return false
    response.writeHead(401, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: "unauthorized" }))
    return true
  },
})
```

The guard sees the raw Node request, so it reads headers the way `src/middleware.ts` cannot: middleware is a route-execution hook and never sees the thread-management, memory or workspace surfaces. See [Security Architecture](/docs/security-architecture) for which gate owns what.
````

- [ ] **Step 2: Run the docs checks**

Run:
```bash
node scripts/check-docs.mjs && pnpm --filter @b4run/web test -- app/components/docs
```
Expected: check-docs exits 0 (the embedding page's pinned phrases are all still
present); the web docs tests pass.

- [ ] **Step 3: Commit the content, then regenerate lastmod and commit again**

```bash
git add apps/web/content/docs/embedding.mdx
git commit -m "docs(embedding): serve() guard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate SEO lastmod for embedding

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: only the `/docs/embedding` entry changes in the manifest. If other
entries move, the sources were committed after a content edit elsewhere; stop
and check `git status`.

### Task 3: changeset and gate

**Files:**
- Create: `.changeset/serve-guard.md`

- [ ] **Step 1: Write the changeset**

```md
---
"@b4run/cli": patch
---

`serve()` accepts a `guard`: a handler that runs ahead of the runtime/fallback split for every request and may answer it itself (a 401 for a missing internal token, a 429, an origin rejection). It is the seam a single-process deployment uses to authenticate the whole service, health check included, before any route runs.
```

- [ ] **Step 2: Run the full local gate**

Run:
```bash
pnpm lint && pnpm check:build-cache && pnpm build && pnpm typecheck && pnpm test && node scripts/check-docs.mjs && node scripts/check-changesets.mjs
```
Expected: all green. `pnpm test` runs the whole workspace; budget 15 minutes.
Do not run other heavy commands in parallel (contention causes spurious
timeouts).

- [ ] **Step 3: Commit and open the PR**

```bash
git add .changeset/serve-guard.md
git commit -m "chore: changeset for serve() guard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin HEAD
gh pr create --title "feat(cli): serve() guard runs ahead of every request" --body "$(cat <<'EOF'
## Summary
- `serve({ guard })`: a handler that runs before the runtime/fallback split for every request and may answer it (401/429/redirect) so nothing else runs.
- Docs: one paragraph and an example on the embedding page.
- First PR of the navlog series (`docs/superpowers/specs/2026-10-04-navlog-example-design.md`, section 6.2). The deployment entry point in PR 5 uses it for the internal-token check.

## Test plan
- [ ] `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/serve.test.ts`
- [ ] `pnpm ci:validate` locally

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PR 2: mechanical rename `research` to `navlog`

**Branch from `main` after PR 1 merges** (PR 2 does not depend on PR 1's code,
but serializing keeps at most one lockfile-touching PR in flight).

### The mapping

Identifiers that change, in replacement order (longer, more specific tokens
first so a shorter token never half-rewrites a longer one):

| Token | Replacement | Where |
|---|---|---|
| `examples/research/` | `examples/navlog/` | paths everywhere |
| `examples/research` | `examples/navlog` | paths everywhere |
| `templates/app-research` | `templates/app-navlog` | paths everywhere |
| `"app-research"` | `"app-navlog"` | devkit tests, harness tests |
| `app-research/` | `app-navlog/` | path fragments in comments and docs |
| `@b4-example/research-server` | `@b4-example/navlog-server` | manifests, CI, docs, tests |
| `@b4-example/research-web` | `@b4-example/navlog-web` | manifests, CI, docs, tests |
| `@b4-example/research` | `@b4-example/navlog` | orchestration manifest |
| `/research#agent` | `/navlog#agent` | route key everywhere |
| `src/app/research/` | `src/app/navlog/` | paths everywhere |
| `src/app/research` | `src/app/navlog` | paths everywhere |
| `"/research"` (route id, quoted) | `"/navlog"` | state types, scenarios, generated d.ts, docs |
| `/research/subagents/researcher` | `/navlog/subagents/researcher` | generated d.ts |
| `route=/research` | `route=/navlog` | memory namespace in tests |
| `b4 run /research` | `b4 run /navlog` | docs, templates AGENTS.md |
| `--template research` | `--template navlog` | docs, tests, CLI output |
| `"research"` as a template id | `"navlog"` | `TEMPLATE_NAMES`, create-b4-app, tests |
| `research.test.ts` | `navlog.test.ts` | the server scenario test and its template twin |
| `research-quality.eval.ts` | `navlog-quality.eval.ts` | eval file |
| `(research template)` | `(navlog template)` | create-b4-app output and tests |

What does **not** change in PR 2:

- The subagent named `researcher`, its folder, and every reference to it. PR 3
  replaces it with `weather` and `performance`.
- Prose: "research assistant", "research scaffold", "deep-research", README
  sentences, docs sentences. PR 6 rewrites them.
- Recipe page slugs, titles, nav labels, SEO registry entries, check-docs
  pins on those files. PR 6 moves them.
- Generic docs examples that use `/research` as an illustrative route in code
  blocks unrelated to the scaffold (e.g. `support/[tenant]/research` in
  check-docs line 5077). Leave them.
- `docs/superpowers/**`, `docs/brand/demo/evidence-matrix.md`, CHANGELOGs,
  `scripts/release/recovery-platform-reviews/**`,
  `test/security-dependencies/fixtures/brand-migration-exceptions.json` (a
  historical allowlist; its `examples/research/server/CHANGELOG.md` entry is
  verified in Task 7).
- `pnpm-lock.yaml` by hand: it is regenerated.
- `apps/web/app/seo/lastmod.generated.json` by hand: it is regenerated.

### Task 4: move the directories

**Files:**
- Move: `examples/research` → `examples/navlog`
- Move: `packages/devkit/templates/app-research` → `packages/devkit/templates/app-navlog`
- Move: `examples/navlog/server/src/app/research` → `examples/navlog/server/src/app/navlog`
- Move: `packages/devkit/templates/app-navlog/server/src/app/research` → `.../src/app/navlog`
- Move: `examples/navlog/server/test/research.test.ts` → `navlog.test.ts`
- Move: `packages/devkit/templates/app-navlog/server/test/research.test.ts.template` → `navlog.test.ts.template`
- Move: `examples/navlog/server/src/app/navlog/evals/research-quality.eval.ts` → `navlog-quality.eval.ts`
- Move: the template twin of that eval.

- [ ] **Step 1: Move with git so history follows**

```bash
git mv examples/research examples/navlog
git mv packages/devkit/templates/app-research packages/devkit/templates/app-navlog
git mv examples/navlog/server/src/app/research examples/navlog/server/src/app/navlog
git mv packages/devkit/templates/app-navlog/server/src/app/research packages/devkit/templates/app-navlog/server/src/app/navlog
git mv examples/navlog/server/test/research.test.ts examples/navlog/server/test/navlog.test.ts
git mv packages/devkit/templates/app-navlog/server/test/research.test.ts.template packages/devkit/templates/app-navlog/server/test/navlog.test.ts.template
git mv examples/navlog/server/src/app/navlog/evals/research-quality.eval.ts examples/navlog/server/src/app/navlog/evals/navlog-quality.eval.ts
git mv packages/devkit/templates/app-navlog/server/src/app/navlog/evals/research-quality.eval.ts packages/devkit/templates/app-navlog/server/src/app/navlog/evals/navlog-quality.eval.ts
git status --short | head -20
```

Expected: `git status` shows renames (`R`), no deletions. If the template's
eval file has a `.template` suffix, use that exact name; check with
`ls packages/devkit/templates/app-navlog/server/src/app/navlog/evals/`.

- [ ] **Step 2: Remove stale build and dependency output under the moved trees**

```bash
rm -rf examples/navlog/server/.b4/build examples/navlog/server/node_modules examples/navlog/web/node_modules examples/navlog/web/.next examples/navlog/node_modules
```

Expected: no output. (These are gitignored; a stale `node_modules` under the
old name confuses pnpm's importer re-key.)

- [ ] **Step 3: Commit the moves alone**

```bash
git add -A examples packages/devkit/templates
git commit -m "refactor: move examples/research and app-research to navlog (no content change)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: rewrite identifiers with one script

**Files:**
- Create (gitignored, never committed): `.superpowers/navlog-rename.mjs`
  (`.superpowers/` is in the root `.gitignore`).
- Modify: every file the script touches (listed by the dry run).

- [ ] **Step 1: Write the rename script**

```js
// .superpowers/navlog-rename.mjs — run from the repo root: node .superpowers/navlog-rename.mjs [--write]
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const root = process.cwd()
const write = process.argv.includes("--write")

// Longer, more specific tokens first.
const replacements = [
  ["examples/research/", "examples/navlog/"],
  ["examples/research", "examples/navlog"],
  ["templates/app-research", "templates/app-navlog"],
  ['"app-research"', '"app-navlog"'],
  ["app-research/", "app-navlog/"],
  ["@b4-example/research-server", "@b4-example/navlog-server"],
  ["@b4-example/research-web", "@b4-example/navlog-web"],
  ["@b4-example/research", "@b4-example/navlog"],
  ["/research#agent", "/navlog#agent"],
  ["src/app/research/", "src/app/navlog/"],
  ["src/app/research", "src/app/navlog"],
  ["/research/subagents/researcher", "/navlog/subagents/researcher"],
  ['"/research"', '"/navlog"'],
  ["route=/research", "route=/navlog"],
  ["b4 run /research", "b4 run /navlog"],
  ["--template research", "--template navlog"],
  ["research.test.ts", "navlog.test.ts"],
  ["research-quality.eval", "navlog-quality.eval"],
  ["(research template)", "(navlog template)"],
  ["generated-research-activation", "generated-navlog-activation"],
]

// Directories never rewritten.
const skipDirs = new Set([
  ".git", "node_modules", "dist", ".next", ".turbo", ".b4", ".worktrees",
  ".superpowers", "docs/superpowers", "docs/brand/demo", "scripts/release",
  "artifacts",
])
// Files never rewritten.
const skipFiles = new Set([
  "pnpm-lock.yaml",
  "apps/web/app/seo/lastmod.generated.json",
  "test/security-dependencies/fixtures/brand-migration-exceptions.json",
  "scripts/check-docs.mjs",
])
// Only these top-level areas are in scope.
const roots = ["examples/navlog", "packages", "apps/web", "test", "scripts", ".github", "README.md", "CONTRIBUTORS.md", "AGENTS.md", "examples/README.md", "turbo.json", "vitest.workspace.ts"]

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = relative(root, full)
    if (skipDirs.has(name) || skipDirs.has(rel)) continue
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full)
    else if (!/\.(png|jpg|jpeg|gif|webp|mp4|webm|woff2?|ico|sqlite|zip|pdf)$/i.test(name)) yield full
  }
}

const changed = []
for (const r of roots) {
  const full = join(root, r)
  const entries = statSync(full).isDirectory() ? [...walk(full)] : [full]
  for (const file of entries) {
    const rel = relative(root, file)
    if (skipFiles.has(rel)) continue
    const before = readFileSync(file, "utf8")
    let after = before
    for (const [from, to] of replacements) after = after.split(from).join(to)
    if (after !== before) {
      changed.push(rel)
      if (write) writeFileSync(file, after)
    }
  }
}
console.log(`${write ? "rewrote" : "would rewrite"} ${changed.length} files`)
for (const f of changed) console.log(f)
```

- [ ] **Step 2: Dry run and read the list**

```bash
node .superpowers/navlog-rename.mjs | tee .superpowers/rename-dry-run.txt
```

Expected: roughly 60 to 90 files. Every listed file must be one of: under
`examples/navlog`, under `packages/devkit/templates/app-navlog`, a devkit /
cli / create-b4-app / harness / security-dependencies test, a docs content
file, `turbo.json`, `vitest.workspace.ts`, `.github/workflows/ci.yml`,
`README.md`, `CONTRIBUTORS.md`, `AGENTS.md`, `examples/README.md`. If a file
outside that set appears, add it to `skipFiles` and re-run; do not widen the
scope.

- [ ] **Step 3: Write**

```bash
node .superpowers/navlog-rename.mjs --write
git diff --stat | tail -3
```

- [ ] **Step 4: Spot-check the hazards**

```bash
grep -rn "researcher" examples/navlog/server/src/app/navlog/subagents | head -3
grep -rn '"/navlog/subagents/researcher"' packages/devkit/templates/app-navlog/server/.b4/b4.generated.d.ts
grep -rn "research-assistant\|research-web-ui" apps/web/app/components/docs/nav.ts
grep -n "navlog" .github/workflows/ci.yml turbo.json vitest.workspace.ts
```

Expected: the `researcher` subagent folder and name are intact; the generated
d.ts names the moved route; the nav still points at the old recipe slugs (PR 6
moves them); CI, turbo and the vitest workspace reference the new paths.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: rename research identifiers to navlog (paths, packages, route key, template id)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: template id with the `research` alias

**Files:**
- Modify: `packages/devkit/src/templates.ts`
- Modify: `packages/create-b4-app/src/index.ts:154-220`
- Modify: `packages/devkit/test/templates.test.ts` (the `TEMPLATE_NAMES` and `resolveTemplateDir` tests, already rewritten by Task 5 to `navlog`)
- Modify: `packages/create-b4-app/test/create-app.test.ts`

After Task 5, `TEMPLATE_NAMES` reads `["basic", "navlog"]` and every test and
usage string says `navlog`. This task adds the alias.

- [ ] **Step 1: Write the failing test in create-b4-app**

Add to `packages/create-b4-app/test/create-app.test.ts`, next to the existing
`--template navlog` internal-mode test (the one that was
"shell-quotes POSIX research target paths"):

```ts
  test("accepts the deprecated research template id as an alias for navlog", async () => {
    const tempRoot = await createTrackedTempDir("create-b4-app-alias-", tempDirs)
    const targetDir = join(tempRoot, "alias-app")
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    const exitCode = await withMockedPlatform("linux", () =>
      run([targetDir, "--mode", "internal", "--template", "research"]),
    )
    const stdout = stdoutWrite.mock.calls.map(([chunk]) => String(chunk)).join("")
    const stderr = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join("")

    expect(exitCode).toBe(0)
    await assertExists(join(targetDir, "server/src/app/navlog/index.ts"))
    expect(stdout).toContain("✔ Created alias-app (navlog template)")
    expect(stderr).toContain(
      'The "research" template id is deprecated and now scaffolds "navlog"; pass --template navlog.',
    )
  })
```

`createTrackedTempDir`, `tempDirs`, `withMockedPlatform`, `assertExists` and
`run` are already imported or defined in that file; the `afterEach` at the top
restores spies and cleans the tracked dirs.

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter create-b4-app test -- -t "deprecated research template id"
```
Expected: FAIL, `Unsupported B4.run template "research"`.

- [ ] **Step 3: Implement the alias in create-b4-app**

In `packages/create-b4-app/src/index.ts`, where `--template` is parsed
(`template = value`), replace with:

```ts
      template = value === "research" ? "navlog" : value
      if (value === "research") {
        process.stderr.write(
          'The "research" template id is deprecated and now scaffolds "navlog"; pass --template navlog.\n',
        )
      }
```

Update the usage string to `[--template basic|navlog]`.

- [ ] **Step 4: Run the create-b4-app tests**

```bash
pnpm --filter create-b4-app test
```
Expected: all pass, including the alias test and the renamed `navlog` tests.

- [ ] **Step 5: Run the devkit tests (parity and template registry)**

```bash
pnpm --filter @b4run/devkit test
```
Expected: all pass. The parity tests compare `examples/navlog/{server,web}`
with `templates/app-navlog/{server,web}`; both sides moved and were rewritten
by the same script, so they match.

- [ ] **Step 6: Commit**

```bash
git add packages/create-b4-app packages/devkit
git commit -m "feat(create-b4-app): navlog template id; research kept as a deprecated alias

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: lockfile, typegen, lastmod, and the leftovers

**Files:**
- Regenerate: `pnpm-lock.yaml`
- Regenerate: `examples/navlog/server/.b4/b4.generated.d.ts` (gitignored in the example; the template's copy is committed)
- Regenerate: `apps/web/app/seo/lastmod.generated.json`
- Modify: `test/security-dependencies/fixtures/brand-migration-exceptions.json` only if Step 4 says so
- Modify: `apps/web/next.config.ts` is NOT touched (no slug moved)

- [ ] **Step 1: Re-key the lockfile**

```bash
pnpm install --lockfile-only
git diff --stat pnpm-lock.yaml
grep -n "^  examples/navlog" pnpm-lock.yaml
```

Expected: the two importer keys `examples/navlog/server` and
`examples/navlog/web` exist and `examples/research/*` are gone. No dependency
versions change. If any version moved, run `git checkout pnpm-lock.yaml` and
re-run with `--frozen-lockfile=false --lockfile-only` after confirming
`node_modules` is fresh (`pnpm install`).

- [ ] **Step 2: Install, build, and regenerate the template's generated types**

```bash
pnpm install
pnpm build
pnpm --filter @b4-example/navlog-server exec b4 typegen
diff <(sed 's#\.\./src#../src#' examples/navlog/server/.b4/b4.generated.d.ts) packages/devkit/templates/app-navlog/server/.b4/b4.generated.d.ts && echo "generated types match"
```

Expected: `generated types match`. If they differ only in the route key
(`/navlog`), copy the example's file over the template's and re-run the devkit
parity test; the template's `.b4/b4.generated.d.ts` is committed and the script
in Task 5 already rewrote it, so a diff means typegen output changed shape and
needs a look.

- [ ] **Step 3: Verify the historical allowlist still resolves**

```bash
grep -n "examples/research/server/CHANGELOG.md" test/security-dependencies/fixtures/brand-migration-exceptions.json
ls examples/navlog/server/CHANGELOG.md
grep -rn "brand-migration-exceptions" test/security-dependencies/*.ts | head -3
```

Then read how the test consumes the fixture. If it asserts each listed path
exists, change that one entry to `examples/navlog/server/CHANGELOG.md`. If it
only allowlists content found at listed paths, leave it alone.

- [ ] **Step 4: Regenerate the lastmod manifest after committing content**

```bash
git add -A
git commit -m "chore: re-key lockfile and generated types for navlog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate SEO lastmod after navlog identifier rename

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: entries change only for docs pages whose content the script touched
(the two recipe pages, ag-ui, evals, testing-agents, agents, tools, memory,
permissions, subagents, dispatch-from-route, add-a-tool, mental-model, cli,
dev-server pages, getting-started, recipes index, and so on). No entry is
added or removed, because no route moved.

### Task 8: the full gate for PR 2

- [ ] **Step 1: Lint, build, typecheck, test, docs**

```bash
pnpm lint && pnpm check:build-cache && pnpm build && pnpm typecheck && pnpm test && pnpm check:release-inventory && node scripts/check-docs.mjs
```

Expected: green. Known places that fail if the script missed something, and
what each failure means:

| Failure | Cause | Fix |
|---|---|---|
| devkit `templates.test.ts` parity drift | a file rewritten on one side only | diff the two paths it names; the script skipped a binary-looking extension |
| `packages/cli/test/docs-bundle.test.ts` | `examples/research` root no longer exists | the script rewrote it to `examples/navlog`; if not, edit the `roots` array by hand |
| `apps/web` `nav.test.ts` | nav labels or hrefs changed | they must not change in PR 2; revert the nav edit |
| `scripts/check-docs.mjs` journey-link checks on `recipes/research-assistant.mdx` | required link text changed | the recipe file keeps its slug and links; restore the exact phrase it names |
| `test/security-dependencies/*` importer names | `examples/research/web` still referenced | rerun the script; those tests are in scope |
| `readme-contracts.test.mjs` | README link `./examples/research/README.md` not rewritten | the script covers `README.md`; confirm the link reads `./examples/navlog/README.md` |

- [ ] **Step 2: Run the brand demo test and the two harness lanes that scaffold the template**

```bash
pnpm test:brand-demo
pnpm verify:harness:self-test
pnpm verify:harness:framework
```

Expected: green. `verify:harness:framework` scaffolds with
`--template navlog` and runs the generated app's lifecycle; budget 20 minutes
and run it alone. If `docs/brand/demo/demo.test.mjs` fails on the file list it
pins (`server/src/app/research/index.ts` and friends), update those four path
strings in that file to `server/src/app/navlog/...` and
`server/test/navlog.test.ts`; `docs/brand/demo` was skipped by the script on
purpose so the evidence matrix stays historical, and this test file is the one
exception.

- [ ] **Step 3: Changesets**

Create `.changeset/navlog-template-id.md`:

```md
---
"create-b4-app": patch
"@b4run/devkit": patch
---

The research scaffold is now the `navlog` template: `npm create b4-app -- --template navlog`. The `research` id still works for one release and prints a deprecation notice. Only names changed in this release; the flight-planning retheme follows.
```

Run `node scripts/check-changesets.mjs`. Expected: exit 0.

- [ ] **Step 4: Commit, push, open the PR**

```bash
git add .changeset/navlog-template-id.md docs/brand/demo/demo.test.mjs
git commit -m "chore: changeset and demo test paths for the navlog rename

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git fetch origin main && git merge origin/main
pnpm install --lockfile-only && git diff --quiet pnpm-lock.yaml || { git add pnpm-lock.yaml; git commit -m "chore: re-key lockfile after merging main"; }
git push -u origin HEAD
gh pr create --title "refactor: rename the research example and template to navlog" --body "$(cat <<'EOF'
## Summary
- `examples/research` → `examples/navlog`, `app-research` → `app-navlog`, packages `@b4-example/navlog-{server,web}`, route `/navlog`, template id `navlog` with `research` kept as a deprecated alias for one release.
- Identifiers only. Prose, recipe slugs, nav labels and the `researcher` subagent are untouched; PR 3 and PR 6 of the navlog series change those.
- Lockfile re-keyed; generated types and SEO lastmod regenerated.
- Series: `docs/superpowers/specs/2026-10-04-navlog-example-design.md`, section 9, PR 2.

## Test plan
- [ ] `pnpm ci:validate`
- [ ] `pnpm verify:harness:framework` (scaffolds `--template navlog`)
- [ ] `npm create b4-app@<packed> x -- --template research` prints the deprecation notice and scaffolds navlog

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR open. Re-fetch main right before merging; if `pnpm-lock.yaml`
conflicts, re-run `pnpm install --lockfile-only` on the merged tree rather
than resolving by hand.

---

## Self-review against the spec

- Spec 6.2 names "export the runtime request listener". This plan implements
  the seam as `serve({ guard })` instead, for the reason in the header. The
  spec is updated by a one-line edit in PR 1 (`docs/superpowers/specs/2026-10-04-navlog-example-design.md`, section 6.2): replace "exports the runtime request listener (today internal to `serve()`), so an entry point can wrap it. `serve()` itself is unchanged." with "gains a `guard` option on `serve()` that runs ahead of every request and may answer it, so an entry point authenticates the whole service without re-implementing `serve()`'s shutdown." Include that edit in PR 1's docs commit.
- Spec 3 (naming) is covered by Tasks 4 to 7, except recipe slugs, which the
  spec assigns to PR 2 and this plan defers to PR 6 so titles and content move
  together. Section 9 of the spec should say so; make that edit in PR 2's
  changeset commit: in the PR 2 bullet, replace "docs slugs and all eight
  pinned places" with "and every literal identifier in docs; recipe slugs and
  the eight pinned places move with the content in PR 6".
- Spec 8 changeset list names `@b4run/cli`, `@b4run/devkit`, `create-b4-app`:
  PR 1 covers cli, PR 2 covers the other two.
