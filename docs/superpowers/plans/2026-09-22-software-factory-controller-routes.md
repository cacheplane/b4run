# Software factory controller as a b4 app of workflow routes: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The software factory's controller becomes its own b4 app, `examples/software-factory/controller`, whose mutating commands are `workflow` routes invoked over the Agent Protocol with one thread per work order; reads stay direct read-only registry reads; the builder app becomes thin and consumes a manifest the controller writes, so the two packages share no source.

**Architecture:** The controller code moves unchanged into `controller/src/lib/`. A module-scope `Factory` singleton is opened by the app's middleware `setup` hook and closed in `dispose`; each route parses its input, calls one Factory command, and returns a `CommandOutcome`-shaped value, never throwing an expected refusal. `dispatch` awaits its run and reports the settled row. The builder's `b4.config.ts` no longer imports the catalog: it reads a JSON manifest (`workspace` as a `CapturedWorkspaceDefinition`, `target` policy and permissions, `prompt`) that the controller writes per task, through the per-thread resolver form shipped in sub-project 1. The factory CLI becomes an HTTP client for writes and a read-only registry reader for reads.

**Tech Stack:** TypeScript, vitest, `@b4run/cli` (`serveRuntime` for in-test serving), `@b4run/workspace/node` (`verifyCapturedWorkspaceDefinition`, `captureWorkspaceDefinition`), `@b4run/sandbox`, `node:sqlite`, zod.

**Spec:** `docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md` §4 (revised 2026-09-22). Two amendments this plan makes, recorded in Task 9: the budget ticker stays in the singleton Factory (a process-lived object exists after all, behind `setup`), and the builder/controller boundary is a JSON manifest rather than a cross-package import.

**Standing rules:** `nvm use 24` before any test run. Never bare `git stash`; never bare `biome check --write` at the repo root (scoped `--write` on files you changed is fine). Run package scripts with `pnpm --filter <pkg> <script>`. Commit after every task; both example packages must typecheck and lint at every commit, and the controller's unit suite must be green from Task 2 on. Docker lanes (`*.integration.test.ts`) run only in Task 8. All paths are relative to the repository root. Work in the worktree `.claude/worktrees/factory-controller-routes` on branch `blove/software-factory-controller-routes`.

**Vocabulary:** "server" is the existing package `@b4-example/software-factory-server`, which becomes the builder only. "controller" is the new package `@b4-example/software-factory-controller`.

---

## File map

| Path | Change |
|---|---|
| `examples/software-factory/controller/{package.json,tsconfig.json,biome.json,vitest.config.ts,vitest.sandbox.config.ts,b4.config.ts}` | New package scaffolding (Task 1) |
| `examples/software-factory/controller/src/lib/**` | The moved controller code: `controller/`, `delivery/`, `domain/`, `registry/`, `review/`, `storage/`, `targets/`, `verification/`, `worker/`, `prompts.ts`, `config.ts` (Task 2) |
| `examples/software-factory/controller/{targets,tasks,fixtures}/`, `scripts/prepare-target.ts` | Moved from server (Task 2) |
| `examples/software-factory/controller/test/**` | Moved tests, fakes and integration lanes (Tasks 2, 5, 7, 8) |
| `examples/software-factory/controller/src/lib/builder-manifest.ts` | Writes the builder manifest per task (Task 3) |
| `examples/software-factory/server/b4.config.ts`, `src/app/build/index.ts`, `src/builder-manifest.ts`, `package.json`, `test/builder-config.test.ts`, `test/isolated-app.ts` | Thin builder reading the manifest (Task 3) |
| `examples/software-factory/controller/src/lib/controller/factory.ts` | `settle(id, timeoutMs)` and `reconcileWorkOrder(id)` on the `Factory` surface (Task 4) |
| `examples/software-factory/controller/src/middleware.ts`, `src/lib/runtime.ts` | The singleton behind `setup`/`dispose` (Task 4) |
| `examples/software-factory/controller/src/lib/routes/{input.ts,outcome.ts}` | Route input schemas and the outcome shape (Task 5) |
| `examples/software-factory/controller/src/app/work-orders/{create,dispatch,approve,deny,cancel}/index.ts`, `src/app/reconcile/index.ts` | The routes (Task 5) |
| `examples/software-factory/controller/src/lib/registry/reader.ts` | Read-only registry reads (Task 6) |
| `examples/software-factory/controller/src/lib/client.ts`, `src/cli.ts` | Controller HTTP client and the rewritten CLI; `http.ts` deleted (Task 7) |
| `vitest.workspace.ts`, `turbo.json`, `.github/workflows/ci.yml`, `scripts/release/test/fixtures/{workflow-entrypoints,workflow-safe-executables}.json` | Registration of the new package and the CI lane (Tasks 1, 8) |
| `examples/software-factory/README.md`, `examples/software-factory/server/CHANGELOG.md`, `examples/software-factory/controller/CHANGELOG.md`, `docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md` | Docs and as-landed notes (Task 9) |

---

### Task 1: Scaffold the controller package

**Files:**
- Create: `examples/software-factory/controller/package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `vitest.sandbox.config.ts`, `b4.config.ts`, `src/app/.gitkeep`
- Modify: `vitest.workspace.ts` (the list near line 26)

- [ ] **Step 1: Write the package files**

`examples/software-factory/controller/package.json`:

```json
{
  "name": "@b4-example/software-factory-controller",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "test:sandbox": "vitest run --config vitest.sandbox.config.ts",
    "typecheck": "tsc -p . --noEmit",
    "lint": "biome check .",
    "factory": "tsx src/cli.ts",
    "target:prepare": "tsx scripts/prepare-target.ts",
    "check": "b4 check",
    "build": "b4 build",
    "dev": "b4 dev"
  },
  "dependencies": {
    "@b4run/cli": "workspace:*",
    "@b4run/sandbox": "workspace:*",
    "@b4run/sdk": "workspace:*",
    "@b4run/workspace": "workspace:*",
    "diff": "9.0.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@b4run/sqlite-storage": "workspace:*",
    "@b4run/testing": "workspace:*",
    "@biomejs/biome": "2.5.6",
    "@types/node": "26.1.2",
    "tsx": "4.23.10",
    "typescript": "7.0.2",
    "vitest": "4.1.11"
  }
}
```

(`--passWithNoTests` is for this task only; Task 2 removes it once tests exist.)

Copy `tsconfig.json` and `biome.json` verbatim from `examples/software-factory/server/` (both are standalone; there is no base to extend). `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "software-factory-controller",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
```

`vitest.sandbox.config.ts`: copy from server, renaming `name` to `"software-factory-controller-docker"`.

`b4.config.ts` (no `sandbox`: the controller runs its verifier containers itself from `src/lib`, never through the app's own sandbox):

```ts
import { config } from "@b4run/cli"

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
})
```

Create `src/app/.gitkeep` so `b4 check` finds an app directory (routes arrive in Task 5).

- [ ] **Step 2: Register with the root vitest workspace**

In `vitest.workspace.ts`, after the line `"./examples/software-factory/server/vitest.config.ts",` add `"./examples/software-factory/controller/vitest.config.ts",`.

- [ ] **Step 3: Install and verify**

```bash
pnpm install --prefer-offline
pnpm --filter @b4-example/software-factory-controller typecheck
pnpm --filter @b4-example/software-factory-controller lint
pnpm --filter @b4-example/software-factory-controller test
```

Expected: install links the new package; all three exit 0.

- [ ] **Step 4: Commit**

```bash
git add examples/software-factory/controller vitest.workspace.ts pnpm-lock.yaml
git commit -m "feat(software-factory): scaffold the controller as its own b4 app

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(`pnpm-lock.yaml` changes because a new workspace package appears; the lockfile-staleness trap applies: re-fetch main right before the PR merges.)

---

### Task 2: Move the controller code, catalog and tests

**Files:**
- Move (with `git mv`): from `examples/software-factory/server/src/{controller,delivery,domain,registry,review,storage,targets,verification,worker}` and `src/{prompts.ts,config.ts,cli.ts,http.ts}` to `examples/software-factory/controller/src/lib/...` (the four files land at `src/lib/prompts.ts`, `src/lib/config.ts`, and `src/cli.ts`, `src/http.ts`)
- Move: `server/{targets,tasks,fixtures}` to `controller/{targets,tasks,fixtures}`; `server/scripts/prepare-target.ts` to `controller/scripts/prepare-target.ts`
- Move: every `server/test/*` EXCEPT `builder-config.test.ts`, `builder.integration.test.ts`, `isolated-app.ts` to `controller/test/`
- Modify: import paths in every moved file; `controller/src/lib/targets/catalog.ts` (`appRoot` depth); `server/b4.config.ts` and `server/src/app/build/index.ts` (temporary relative imports, replaced in Task 3)

- [ ] **Step 1: Move**

```bash
cd examples/software-factory
mkdir -p controller/src/lib controller/test controller/scripts
for d in controller delivery domain registry review storage targets verification worker; do git mv server/src/$d controller/src/lib/$d; done
git mv server/src/prompts.ts controller/src/lib/prompts.ts
git mv server/src/config.ts controller/src/lib/config.ts
git mv server/src/cli.ts controller/src/cli.ts
git mv server/src/http.ts controller/src/http.ts
git mv server/targets controller/targets
git mv server/tasks controller/tasks
git mv server/fixtures controller/fixtures
git mv server/scripts/prepare-target.ts controller/scripts/prepare-target.ts
for f in server/test/*; do case "$(basename "$f")" in builder-config.test.ts|builder.integration.test.ts|isolated-app.ts) ;; *) git mv "$f" controller/test/;; esac; done
```

- [ ] **Step 2: Fix paths**

- In `controller/src/lib/targets/catalog.ts`: `export const appRoot = fileURLToPath(new URL("../../../", import.meta.url))` (one more `../` than before, since the module is now under `src/lib/targets/`). Check every other `new URL("..", import.meta.url)` in the moved code with `grep -rn 'import.meta.url' controller/src` and adjust each by one level.
- In `controller/src/cli.ts` and `controller/src/http.ts`: imports change from `./controller/...` to `./lib/controller/...`, etc.
- In `controller/test/*.ts`: imports `../src/controller/...` become `../src/lib/controller/...`; `../src/cli.ts` and `../src/http.ts` stay. `cli.test.ts` resolves `tsxBin` from `../node_modules/tsx/dist/cli.mjs`, which exists after Task 1's install.
- In `controller/scripts/prepare-target.ts`: `../src/targets/...` becomes `../src/lib/targets/...`.
- In `server/b4.config.ts` and `server/src/app/build/index.ts`: TEMPORARILY import from `../controller/src/lib/targets/catalog.js` etc. by relative path so the builder still typechecks. Task 3 removes these imports. Add a `// TEMPORARY until the builder manifest lands (Task 3)` comment on each.
- `server/test/builder-config.test.ts` imports `../b4.config.ts`; it keeps working through the temporary imports.
- `server/vitest.sandbox.config.ts` keeps only `builder.integration.test.ts` for now (Task 8 moves it).
- Remove `--passWithNoTests` from the controller's `test` script.

- [ ] **Step 3: Run**

```bash
pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint && pnpm --filter @b4-example/software-factory-controller test
pnpm --filter @b4-example/software-factory-server typecheck && pnpm --filter @b4-example/software-factory-server lint && pnpm --filter @b4-example/software-factory-server test
```

Expected: controller: all moved unit tests pass exactly as they did in the server (they construct `createFactory` directly, drive the fake worker, or spawn `src/cli.ts`; none of that changed). Server: `builder-config.test.ts` passes. If `cli.test.ts` fails on `FACTORY_REPO_ROOT` or catalog paths, the `appRoot` depth in Step 2 is wrong; fix it there rather than in the test.

- [ ] **Step 4: Commit**

```bash
git add -A examples/software-factory
git commit -m "refactor(software-factory): move the controller, catalog and tests into the controller package

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The builder reads a manifest the controller writes

**Files:**
- Create: `examples/software-factory/controller/src/lib/builder-manifest.ts`
- Test: `examples/software-factory/controller/test/builder-manifest.test.ts`
- Modify: `examples/software-factory/controller/src/cli.ts` (a `builder-manifest` command)
- Create: `examples/software-factory/server/src/builder-manifest.ts`
- Rewrite: `examples/software-factory/server/b4.config.ts`, `server/src/app/build/index.ts`, `server/package.json` (dependencies), `server/test/builder-config.test.ts`, `server/test/isolated-app.ts`; create `controller/test/isolated-builder.ts`

The boundary: the builder must not import controller code. Everything the builder's config needs is data: the captured workspace (which the per-thread resolver form accepts as a `CapturedWorkspaceDefinition`), the sandbox policy and image, the permissions allow-list, and the prompt.

- [ ] **Step 1: Write the failing test**

`controller/test/builder-manifest.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import { BuilderManifestSchema, writeBuilderManifest } from "../src/lib/builder-manifest.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { builderPermissions } from "../src/lib/targets/permissions.ts"
import { targetSandboxPolicy } from "../src/lib/targets/workspace.ts"

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("builder manifest", () => {
  it("writes everything the builder's config needs, as data", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-manifest-"))
    const task = loadTask("cli-flags")
    const path = await writeBuilderManifest(task, dir)
    const manifest = BuilderManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    expect(manifest.taskId).toBe("cli-flags")
    expect(manifest.target.image).toMatch(/^b4-/)
    expect(manifest.target.policy).toEqual(targetSandboxPolicy(task.target))
    expect(manifest.target.permissions).toEqual(builderPermissions(task.target))
    expect(manifest.prompt).toContain("Read TASK.md")
    const workspace = verifyCapturedWorkspaceDefinition(manifest.workspace)
    expect(workspace.source.files.some((f) => f.path === "TASK.md")).toBe(true)
  })

  it("keeps the builder's copy of the schema identical", () => {
    const here = readFileSync(new URL("../src/lib/builder-manifest.ts", import.meta.url), "utf8")
    const there = readFileSync(new URL("../../server/src/builder-manifest.ts", import.meta.url), "utf8")
    const schema = (text: string) =>
      text.slice(text.indexOf("export const BuilderManifestSchema"), text.indexOf("export type BuilderManifest"))
    expect(schema(there)).toBe(schema(here))
  })
})
```

Read `src/lib/targets/workspace.ts` for the real names: `builderSandboxProvider(target)` builds `dockerSandbox({ scope, image })`; the image tag comes from `imageTag(target)` in `catalog.ts`. `targetSandboxPolicy` returns the network, resources and security policy. `builderPermissions` is in `targets/permissions.ts`. Adjust the assertions to the actual shapes; the intent is that the manifest carries the same values those functions compute.

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @b4-example/software-factory-controller exec vitest run test/builder-manifest.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement the manifest writer**

`controller/src/lib/builder-manifest.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { z } from "zod"
import { taskPrompt } from "./prompts.js"
import { appRoot, imageTag, type Task } from "./targets/catalog.js"
import { builderPermissions } from "./targets/permissions.js"
import { builderSandboxScope, targetSandboxPolicy, targetWorkspace } from "./targets/workspace.js"

/**
 * Everything the builder app's `b4.config.ts` needs, as data. The builder imports no
 * controller code: it verifies this file and serves it. The workspace is captured HERE,
 * so the builder never sees the target archive or the task catalog, only the bytes the
 * controller decided it should start from.
 */
export const BuilderManifestSchema = z.object({
  version: z.literal(1),
  taskId: z.string().min(1),
  target: z.object({
    id: z.string().min(1),
    scope: z.string().min(1),
    image: z.string().min(1),
    policy: z.record(z.string(), z.unknown()),
    permissions: z.record(z.string(), z.array(z.string())),
  }),
  workspace: z.unknown(),
  prompt: z.string().min(1),
})
export type BuilderManifest = z.infer<typeof BuilderManifestSchema>

/** Write `<dir>/<taskId>.json` and return its path. */
export async function writeBuilderManifest(task: Task, dir: string): Promise<string> {
  const workspace = await captureWorkspaceDefinition(appRoot, targetWorkspace(task, "builder"))
  const manifest: BuilderManifest = {
    version: 1,
    taskId: task.id,
    target: {
      id: task.target.id,
      scope: builderSandboxScope,
      image: imageTag(task.target),
      policy: targetSandboxPolicy(task.target) as Record<string, unknown>,
      permissions: builderPermissions(task.target) as Record<string, string[]>,
    },
    workspace,
    prompt: taskPrompt(task),
  }
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${task.id}.json`)
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return path
}
```

`targetWorkspace(task, "builder")` writes the capture under the controller's `appRoot` (`.factory/captures/builder/<task>`), which is what `captureWorkspaceDefinition(appRoot, ...)` reads; that is why the manifest is written from the controller. If `builderSandboxScope` or `imageTag` are not exported, export them (they exist as `const builderSandboxScope = "software-factory-builder"` in `targets/workspace.ts:44` and `imageTag` in `catalog.ts:238`). Check what `builderSandboxProvider` passes to `dockerSandbox` beyond `scope` and `image` (for example `prepareImage` or `runAsNonRoot`); carry every such field into `manifest.target` and the builder config below, so the builder produces the SAME `SandboxConfig` values it did before, from data.

Add to `controller/src/cli.ts` a command `builder-manifest --task <id> --out <dir>` that calls `writeBuilderManifest(loadTask(id), dir)` and prints `{ path }`. It needs no Factory; restructure `main` minimally so the factory is only created for commands that need it (Task 7 rewrites `main` anyway).

- [ ] **Step 4: Rewrite the builder**

`server/package.json` dependencies become exactly `@b4run/cli`, `@b4run/sandbox`, `@b4run/sdk`, `@b4run/workspace`, `zod`; devDependencies keep biome, types, typescript, vitest, and whatever `builder.integration.test.ts` still imports until Task 8 moves it. Scripts: keep `test`, `test:sandbox`, `typecheck`, `lint`, `check`, `build`, `dev`; drop `factory` and `target:prepare`.

`server/src/builder-manifest.ts` (the builder's own copy of the schema, deliberately duplicated so the packages share no source; the sync test in Step 1 keeps the two identical):

```ts
import { readFileSync } from "node:fs"
import { z } from "zod"

export const BuilderManifestSchema = z.object({
  version: z.literal(1),
  taskId: z.string().min(1),
  target: z.object({
    id: z.string().min(1),
    scope: z.string().min(1),
    image: z.string().min(1),
    policy: z.record(z.string(), z.unknown()),
    permissions: z.record(z.string(), z.array(z.string())),
  }),
  workspace: z.unknown(),
  prompt: z.string().min(1),
})
export type BuilderManifest = z.infer<typeof BuilderManifestSchema>

/** The manifest this builder process serves. One builder process per task, as before. */
export function loadBuilderManifest(): BuilderManifest {
  const path = process.env.FACTORY_BUILDER_MANIFEST
  if (!path)
    throw new Error(
      "FACTORY_BUILDER_MANIFEST is required: the controller writes it with `factory builder-manifest`",
    )
  return BuilderManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}
```

`server/b4.config.ts`:

```ts
import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import type { SandboxPolicy } from "@b4run/workspace"
import { verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import { loadBuilderManifest } from "./src/builder-manifest.js"

const manifest = loadBuilderManifest()
const policy = manifest.target.policy as Pick<SandboxPolicy, "network" | "resources" | "security">

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    ...policy,
    provider: dockerSandbox({ scope: manifest.target.scope, image: manifest.target.image }),
    // The controller captured this workspace; the builder verifies and serves it. A resolver
    // rather than a static definition because a captured definition is what the controller
    // hands over, and sub-project 3 makes this a per-thread choice.
    workspace: async () => verifyCapturedWorkspaceDefinition(manifest.workspace),
  },
  toolOutput: { previewLines: 10 },
  permissions: { allow: { ...manifest.target.permissions } },
})
```

`server/src/app/build/index.ts`:

```ts
import { agent } from "@b4run/sdk"
import { loadBuilderManifest } from "../../builder-manifest.js"

export default agent({
  model: process.env.FACTORY_BUILDER_MODEL ?? "gpt-5-mini",
  recursionLimit: 60,
  description: "Repairs a failing test in a bounded workspace.",
  systemPrompt: `You repair a single defect in an isolated workspace.

${loadBuilderManifest().prompt}

Rules you cannot negotiate:
- Change only the files TASK.md lists as permitted. Every other file, especially any test, is immutable.
- Do not claim the work is verified. Something else checks it, and your claim is not read.
- If you cannot repair the defect, say why and stop rather than weakening a test.`,
})
```

- [ ] **Step 5: Update the builder's tests and the isolated-app helpers**

`server/test/builder-config.test.ts`: the server test must not import controller code. It builds a minimal manifest fixture inline (a `CapturedWorkspaceDefinition` from `createSourceBundle([...])` in `@b4run/workspace/node`, `target.policy` `{ network: { mode: "deny" } }`, an empty permissions map, a prompt), writes it to a temp file, sets `process.env.FACTORY_BUILDER_MANIFEST`, dynamically imports `../b4.config.ts`, and asserts: provider name is `docker`; `typeof config.sandbox.workspace === "function"`; `await config.sandbox.workspace({ threadId: "t", metadata: {}, signal: new AbortController().signal })` returns a definition whose `source.digest` equals the fixture's; `permissions.allow` equals the manifest's. `b4.config.ts` reads the env at import time, so set the env before the dynamic import and use `vi.resetModules()` between cases.

`server/test/isolated-app.ts`: keep `isolatedApp()` copying the SERVER root, drop the catalog import and the `FACTORY_REPO_ROOT` line. Note from the Task 2 review: until this task lands, the isolated copy of the builder cannot load its `b4.config.ts` at all, because the temporary `../controller/...` imports resolve outside the copy; that is why the Docker lanes run only in Task 8. After this task, the copied builder imports nothing outside itself; add an assertion to `builder-config.test.ts` that `b4.config.ts` and `src/**` contain no `../controller/` import (a grep over the files), so the boundary cannot regress silently. Create `controller/test/isolated-builder.ts` exporting `isolatedBuilder()` that copies `../../server` the same way and sets `process.env.FACTORY_REPO_ROOT ??= repositoryRoot()` from the controller's catalog; the controller's integration tests import it (Task 8 wires them).

- [ ] **Step 6: Run**

```bash
pnpm --filter @b4-example/software-factory-controller exec vitest run test/builder-manifest.test.ts
pnpm --filter @b4-example/software-factory-server typecheck && pnpm --filter @b4-example/software-factory-server lint && pnpm --filter @b4-example/software-factory-server test
pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint && pnpm --filter @b4-example/software-factory-controller test
```

Expected: all green. Then one manual check that the builder's own `b4 check` accepts a real manifest: `pnpm --filter @b4-example/software-factory-controller factory builder-manifest --task cli-flags --out /tmp/claude-501/manifests` then `FACTORY_BUILDER_MANIFEST=/tmp/claude-501/manifests/cli-flags.json pnpm --filter @b4-example/software-factory-server check` exits 0 (Docker must be running for the provider preflight; if it is not, report the preflight message and move on).

- [ ] **Step 7: Commit**

```bash
git add -A examples/software-factory
git commit -m "feat(software-factory): the builder serves a manifest the controller writes; the packages share no source

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The Factory learns to settle a run, and lives behind middleware setup

**Files:**
- Modify: `examples/software-factory/controller/src/lib/controller/factory.ts` (`Factory` interface + implementation), `src/lib/config.ts`
- Create: `examples/software-factory/controller/src/lib/runtime.ts`, `src/middleware.ts`
- Test: `examples/software-factory/controller/test/factory-dispatch.test.ts` (append), `test/runtime.test.ts`, `test/config.test.ts` (fixtures)

- [ ] **Step 1: Write the failing tests**

Append to `controller/test/factory-dispatch.test.ts` (read its `boot()` helper: it builds a Factory over a fake worker with `run: "edits_only"` and a passing fake verifier, and its other tests show exactly how the fake reader is seeded with the repaired files, typically after `waitFor(id, (r) => r.workerThreadId !== null)`; copy that):

```ts
  it("settle waits for the tracked run and returns the settled row", async () => {
    await boot()
    const row = await factory.create({ taskId: "cli-flags" })
    expect((await factory.dispatch(row.id)).ok).toBe(true)
    const dispatched = await factory.waitFor(row.id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId!, repaired())
    const settled = await factory.settle(row.id, 10_000)
    expect(ACTIVE_STATES.has(settled.state)).toBe(false)
    expect(settled.state).toBe("awaiting_approval")
  })

  it("reconcileWorkOrder is exposed and is a no-op on a settled row", async () => {
    await boot()
    const row = await factory.create({ taskId: "cli-flags" })
    await factory.reconcileWorkOrder(row.id)
    expect(factory.show(row.id)?.state).toBe("received")
  })
```

Import `ACTIVE_STATES` from `../src/lib/domain/states.ts`.

`controller/test/runtime.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createControllerRuntime } from "../src/lib/runtime.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
afterEach(async () => {
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("controller runtime", () => {
  it("opens one Factory for the process and closes it on dispose", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const runtime = createControllerRuntime({
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_BUILDER_APP_ROOT: join(dir, "builder"),
    })
    const a = await runtime.factory()
    const b = await runtime.factory()
    expect(a).toBe(b)
    await runtime.dispose()
    await expect(runtime.factory()).rejects.toThrow(/disposed/)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-dispatch.test.ts test/runtime.test.ts
```

Expected: FAIL: `settle`/`reconcileWorkOrder` are not on `Factory`; `../src/lib/runtime.ts` does not exist.

- [ ] **Step 3: Extend the Factory**

In `factory.ts`, add to the `Factory` interface:

```ts
  /**
   * Wait for the tracked background run of `id` (the builder turn and the verification
   * that follows it) to settle, then return the row once it has left the active states.
   * Times out with the row's current state in the message.
   */
  settle(id: string, timeoutMs: number): Promise<WorkOrderRow>
  /** Reconcile one work order now (what boot does for all of them). */
  reconcileWorkOrder(id: string): Promise<void>
```

and implement them in the returned object:

```ts
    async settle(id, timeoutMs) {
      await settleRun(id, timeoutMs)
      return factory.waitFor(id, (r) => !ACTIVE_STATES.has(r.state), timeoutMs)
    },
    reconcileWorkOrder: (id) => reconcileWorkOrder(ctx, id),
```

`settleRun` already exists at `factory.ts:215`; `reconcileWorkOrder` is exported from `./reconcile.js` (import it next to `reconcileAll`).

- [ ] **Step 4: Config and the runtime singleton**

`controller/src/lib/config.ts`: add `FACTORY_BUILDER_APP_ROOT: z.string({ message: "FACTORY_BUILDER_APP_ROOT is required" }).min(1)` to `EnvSchema` and `builderAppRoot` to `FactoryConfig` (the reader addresses the builder's installation store, which is no longer this package). Drop `FACTORY_HTTP_PORT` and `httpPort`. Update `test/config.test.ts` fixtures: every valid environment gains `FACTORY_BUILDER_APP_ROOT`, and the required-keys assertion gains the new message.

`controller/src/lib/runtime.ts`:

```ts
import { loadConfig } from "./config.js"
import { createFactory, type Factory } from "./controller/factory.js"
import { createArtifactStore } from "./storage/artifacts.js"
import { loadTask } from "./targets/catalog.js"
import { builderSandboxProvider, targetInspectionOptions } from "./targets/workspace.js"
import { captureTargetBaseline } from "./verification/baseline.js"
import { createDockerVerifier } from "./verification/docker-verifier.js"
import { createHttpWorkerClient } from "./worker/client.js"
import { createThreadWorkspaceReader } from "./worker/workspace-reader.js"

export interface ControllerRuntime {
  /** The process's one Factory, opened on first use. Concurrent first calls share the open. */
  factory(): Promise<Factory>
  dispose(): Promise<void>
}

/**
 * One Factory per process, opened lazily because b4 has no boot hook: the app's middleware
 * `setup` calls `factory()` before the first request and `dispose()` on shutdown. Every
 * route reaches the same instance, so the registry has exactly one writer.
 */
export function createControllerRuntime(
  env: Readonly<Record<string, string | undefined>>,
): ControllerRuntime {
  const config = loadConfig(env)
  let opening: Promise<Factory> | undefined
  let disposed = false
  return {
    factory() {
      if (disposed) return Promise.reject(new Error("Controller runtime is disposed"))
      opening ??= createFactory({
        registryPath: config.registryPath,
        worker: createHttpWorkerClient(config.workerUrl),
        workerRoute: config.workerRoute,
        exportDir: config.exportDir,
        artifactsDir: config.artifactsDir,
        approvalTtlMs: config.approvalTtlMs,
        maxActiveMs: config.maxActiveMs,
        maxChangedBytes: config.maxChangedBytes,
        verifier: createDockerVerifier(createArtifactStore(config.artifactsDir)),
        workspaceReader: createThreadWorkspaceReader(
          {
            providerFor: (taskId) => builderSandboxProvider(loadTask(taskId).target),
            appRoot: config.builderAppRoot,
          },
          (taskId) => targetInspectionOptions(loadTask(taskId)),
        ),
        captureBaseline: captureTargetBaseline,
        log: (event, payload) =>
          process.stderr.write(`${JSON.stringify({ event, ...payload })}\n`),
      }).catch((error) => {
        // A failed open is retried by the next caller, like middleware setup itself.
        opening = undefined
        throw error
      })
      return opening
    },
    async dispose() {
      disposed = true
      const factory = await opening?.catch(() => undefined)
      await factory?.close()
    },
  }
}

/** The module-scope instance the app's middleware and routes share. */
let shared: ControllerRuntime | undefined
export function controllerRuntime(): ControllerRuntime {
  shared ??= createControllerRuntime(process.env)
  return shared
}
/** Tests boot several controllers in one process with different environments. Disposes the previous one first. */
export async function resetControllerRuntimeForTests(): Promise<void> {
  const previous = shared
  shared = undefined
  await previous?.dispose()
}
```

`controller/src/middleware.ts` (read `apps/web/content/docs/middleware.mdx:120-150` for the exact `handle` signature and `allow()` usage, and match it):

```ts
import { allow, defineMiddleware } from "@b4run/sdk"
import { controllerRuntime } from "./lib/runtime.js"

/**
 * Not authorization (out of scope for this rung): the only lifecycle hook b4 gives an app.
 * `setup` opens the process's Factory, which reconciles the registry as it opens, so the
 * first request finds a reconciled registry; `dispose` closes it on shutdown.
 */
export default defineMiddleware({
  async setup() {
    await controllerRuntime().factory()
  },
  async dispose() {
    await controllerRuntime().dispose()
  },
  handle: () => allow(),
})
```

- [ ] **Step 5: Run**

```bash
pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-dispatch.test.ts test/runtime.test.ts test/config.test.ts test/cli.test.ts
pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint
```

Expected: PASS. `cli.test.ts` still spawns the old CLI, which now needs `FACTORY_BUILDER_APP_ROOT` in its env; add it to that test's env for now (Task 7 rewrites the test).

- [ ] **Step 6: Commit**

```bash
git add examples/software-factory/controller
git commit -m "feat(software-factory): the Factory settles runs on request and lives behind middleware setup

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The routes

**Files:**
- Create: `examples/software-factory/controller/src/lib/routes/input.ts`, `src/lib/routes/outcome.ts`
- Create: `src/app/work-orders/{create,dispatch,approve,deny,cancel}/index.ts`, `src/app/reconcile/index.ts`
- Create (minimal, completed in Task 6): `src/lib/registry/reader.ts`
- Delete: `src/app/.gitkeep`
- Test: `examples/software-factory/controller/test/routes.test.ts`, `test/serve-controller.ts` (helper)

- [ ] **Step 1: Write the failing test and its helper**

`controller/test/serve-controller.ts` boots the controller app in-process with `serveRuntime` from `@b4run/cli` against a fake worker (check `ServeRuntimeOptions` in `packages/cli/src/lib/dev/serve-runtime.ts:1-35` for the exact option names; `installSignalHandlers` defaults to false):

```ts
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { serveRuntime, type ServeRuntimeHandle } from "@b4run/cli"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"

const appRoot = fileURLToPath(new URL("../", import.meta.url))

export interface ServedController {
  readonly url: string
  readonly fake: FakeWorker
  readonly stateDir: string
  /** POST /threads/<threadId>/runs/wait with a route and input; returns status and parsed body. */
  run(threadId: string, route: string, input: unknown): Promise<{ status: number; body: unknown }>
  /** POST /threads/<threadId>/cancel; returns the status. */
  cancel(threadId: string): Promise<number>
  close(): Promise<void>
}

export async function serveController(
  dir: string,
  worker: Omit<FakeWorkerOptions, "outboxDir"> = {},
): Promise<ServedController> {
  const stateDir = join(dir, "state")
  mkdirSync(join(dir, "builder"), { recursive: true })
  const fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only", ...worker })
  process.env.FACTORY_WORKER_URL = fake.baseUrl
  process.env.FACTORY_STATE_DIR = stateDir
  process.env.FACTORY_BUILDER_APP_ROOT = join(dir, "builder")
  const { controllerRuntime, resetControllerRuntimeForTests } = await import("../src/lib/runtime.ts")
  await resetControllerRuntimeForTests() // disposes any previous runtime, then clears it
  const handle: ServeRuntimeHandle = await serveRuntime({ appRoot, host: "127.0.0.1", port: 0 })
  const run = async (threadId: string, route: string, input: unknown) => {
    const response = await fetch(`${handle.url}/threads/${encodeURIComponent(threadId)}/runs/wait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route, input }),
    })
    return { status: response.status, body: await response.json() }
  }
  return {
    url: handle.url,
    fake,
    stateDir,
    run,
    cancel: async (threadId) =>
      (await fetch(`${handle.url}/threads/${encodeURIComponent(threadId)}/cancel`, { method: "POST" })).status,
    close: async () => {
      await handle.close()
      await controllerRuntime().dispose()
      await fake.close()
    },
  }
}
```

`controller/test/routes.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openRegistryReader } from "../src/lib/registry/reader.ts"
import { type ServedController, serveController } from "./serve-controller.ts"

let dir: string
let served: ServedController
afterEach(async () => {
  await served?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("controller routes", () => {
  it("creates, dispatches (awaiting the run), and refuses a stale approval, all as outcomes", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-routes-"))
    served = await serveController(dir)
    const created = await served.run("create-1", "/work-orders/create#workflow", { taskId: "cli-flags" })
    expect(created.status).toBe(200)
    const { row } = created.body as { row: { id: string; state: string } }
    expect(row.state).toBe("received")
    const id = row.id

    const dispatched = await served.run(id, "/work-orders/dispatch#workflow", { id })
    expect(dispatched.status).toBe(200)
    expect(dispatched.body).toMatchObject({ ok: true })
    // The route awaited the run: the row it returns has left the active states.
    expect((dispatched.body as { row: { state: string } }).row.state).toBe("awaiting_approval")

    const stale = await served.run(id, "/work-orders/approve#workflow", {
      id,
      revision: 0,
      bundleDigest: "0".repeat(64),
    })
    expect(stale.status).toBe(200)
    expect(stale.body).toMatchObject({ ok: false, message: expect.stringMatching(/Stale revision|does not match/) })
  })

  it("returns refusals for an unknown work order, an unknown task and bad input, never a 500", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-routes-"))
    served = await serveController(dir)
    const unknown = await served.run("nope", "/work-orders/dispatch#workflow", { id: "nope" })
    expect(unknown.status).toBe(200)
    expect(unknown.body).toMatchObject({ ok: false, refusal: "unknown_work_order" })
    const badTask = await served.run("create-2", "/work-orders/create#workflow", { taskId: "no-such-task" })
    expect(badTask.body).toMatchObject({ ok: false, refusal: "unknown_task" })
    const badInput = await served.run("create-3", "/work-orders/create#workflow", { nope: 1 })
    expect(badInput.body).toMatchObject({ ok: false, refusal: "invalid_input" })
  })

  it("serialises commands per work order through the runtime's one-run-per-thread rule", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-routes-"))
    served = await serveController(dir, { run: "hang" })
    const { row } = (await served.run("create-4", "/work-orders/create#workflow", { taskId: "cli-flags" })).body as { row: { id: string } }
    const id = row.id
    const inflight = served.run(id, "/work-orders/dispatch#workflow", { id })
    await new Promise((r) => setTimeout(r, 300))
    const second = await served.run(id, "/work-orders/cancel#workflow", { id })
    expect(second.status).toBe(409) // run_in_flight from the runtime
    expect(await served.cancel(id)).toBe(200)
    const result = await inflight
    expect(result.status).toBe(409) // run_cancelled: the caller re-reads the row
    const reader = openRegistryReader(join(served.stateDir, "registry.sqlite"))
    try {
      expect(["cancel_requested", "cancelled"]).toContain(reader.show(id)?.state)
    } finally {
      reader.close()
    }
  })
})
```

The fake worker's `hang` behaviour keeps the run open until cancelled (`fake-worker.ts` doc block). In this task, create `src/lib/registry/reader.ts` with only `openRegistryReader(path)` returning `{ show, close }` over a read-only `DatabaseSync`; Task 6 completes it.

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @b4-example/software-factory-controller exec vitest run test/routes.test.ts
```

Expected: FAIL: the app has no routes.

- [ ] **Step 3: Implement the shared route pieces**

`controller/src/lib/routes/input.ts`:

```ts
import { z } from "zod"
import { DIGEST_PATTERN } from "../domain/work-order.js"

export const CreateInput = z
  .object({ taskId: z.string().min(1), operationKey: z.string().min(1).optional() })
  .strict()
export const IdInput = z
  .object({ id: z.string().min(1), operationKey: z.string().min(1).optional() })
  .strict()
export const ApproveInput = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    bundleDigest: z.string().regex(DIGEST_PATTERN),
    operationKey: z.string().min(1).optional(),
  })
  .strict()
export const ReconcileInput = z.object({}).strict()
```

`controller/src/lib/routes/outcome.ts`:

```ts
import type { z } from "zod"
import {
  CommandInFlightError,
  type Factory,
  UnknownTaskError,
  UnknownWorkOrderError,
} from "../controller/factory.js"
import type { CommandOutcome, WorkOrderRow } from "../domain/work-order.js"

export type Refusal = "invalid_input" | "unknown_task" | "unknown_work_order" | "command_in_flight"

/**
 * What every mutating route returns. A workflow route's thrown error is a 500 with no
 * structure, so refusals are values: `ok: false` plus a `refusal` for the cases the old
 * HTTP layer mapped to 400/404/409, and the plain `CommandOutcome` fields otherwise.
 */
export interface RouteOutcome extends CommandOutcome {
  readonly refusal?: Refusal
  readonly issues?: readonly unknown[]
  /** The row after the command, when it exists. */
  readonly row?: WorkOrderRow | null
}

export function refused(
  refusal: Refusal,
  message: string,
  extra: Partial<RouteOutcome> = {},
): RouteOutcome {
  return { ok: false, message, refusal, ...extra }
}

/** Parse, run, and turn the three expected error classes into refusals. */
export async function command<T>(
  schema: z.ZodType<T>,
  input: unknown,
  factory: () => Promise<Factory>,
  run: (parsed: T, factory: Factory) => Promise<RouteOutcome>,
): Promise<RouteOutcome> {
  const parsed = schema.safeParse(input)
  if (!parsed.success)
    return refused("invalid_input", "Invalid input", { issues: parsed.error.issues })
  try {
    return await run(parsed.data, await factory())
  } catch (error) {
    if (error instanceof UnknownTaskError) return refused("unknown_task", error.message)
    if (error instanceof UnknownWorkOrderError) return refused("unknown_work_order", error.message)
    if (error instanceof CommandInFlightError) return refused("command_in_flight", error.message)
    throw error
  }
}
```

`CommandOutcome` has `ok`, optional `state`, `message` (see `CommandOutcomeSchema` in `domain/work-order.ts:49-52`); confirm the field names.

- [ ] **Step 4: Implement the routes**

`src/app/work-orders/create/index.ts`:

```ts
import { controllerRuntime } from "../../../lib/runtime.js"
import { CreateInput } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"

/**
 * Creates a work order. The thread this runs on is the caller's choice (the work order
 * does not exist yet); the created id is the thread for every command after.
 */
export async function workflow(input: unknown) {
  return command(CreateInput, input, () => controllerRuntime().factory(), async ({ taskId, operationKey }, factory) => {
    const row = await factory.create({ taskId, ...(operationKey ? { operationKey } : {}) })
    return { ok: true, state: row.state, message: "Created", row }
  })
}
```

`src/app/work-orders/dispatch/index.ts`:

```ts
import type { RuntimeContext } from "@b4run/sdk"
import { controllerRuntime } from "../../../lib/runtime.js"
import { IdInput } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"

/**
 * Dispatches and AWAITS the run: the builder turn, then verification. The route returns
 * when the work order has left its active states. It runs on the work order's own thread,
 * so a second command on it while this is in flight is the runtime's `run_in_flight`, and
 * the runtime's cancel of this thread aborts `ctx.signal`, which cancels the work order.
 */
export async function workflow(input: unknown, ctx: RuntimeContext) {
  return command(IdInput, input, () => controllerRuntime().factory(), async ({ id, operationKey }, factory) => {
    await factory.reconcileWorkOrder(id)
    const outcome = await factory.dispatch(id, operationKey)
    if (!outcome.ok) return { ...outcome, row: factory.show(id) }
    const onAbort = () => {
      void factory.cancel(id, `cancel:${id}:aborted-dispatch`).catch(() => undefined)
    }
    ctx.signal.addEventListener("abort", onAbort, { once: true })
    try {
      const budget = factory.show(id)?.maxActiveMs ?? 1_200_000
      let row: WorkOrderRow
      try {
        row = await factory.settle(id, budget + 60_000)
      } catch (error) {
        // `settle` throws on timeout and when the factory is aborted mid-wait; both are
        // expected here and a route must not throw. The row is the outcome either way.
        const current = factory.show(id)
        return {
          ok: false,
          ...(current ? { state: current.state } : {}),
          message: `Dispatch did not settle: ${error instanceof Error ? error.message : String(error)}`,
          row: current,
        }
      }
      // Settled means "not active", which includes `cancel_requested`: say so rather than
      // report a work order that is still owed a cancel confirmation as finished.
      return {
        ok: row.state !== "cancel_requested",
        state: row.state,
        message: row.state === "cancel_requested" ? "Cancel requested; reconciliation will finish it" : "Settled",
        row,
      }
    } finally {
      ctx.signal.removeEventListener("abort", onAbort)
    }
  })
}
```

Import `WorkOrderRow` from `../../../lib/domain/work-order.js`. The reconcile-before-dispatch is load-bearing, not belt-and-braces: a work order orphaned by a restart is re-tracked only by `reconcileWorkOrder` (`reconcile.ts` `reconcileRun`), and without it `settle` would wait the whole budget on a row nothing is driving.

`approve`, `deny`, `cancel`: the same shape with `ApproveInput` or `IdInput`, calling `factory.reconcileWorkOrder(id)` then the command, returning `{ ...outcome, row: factory.show(id) }`. `approve` passes `{ revision, bundleDigest, ...(operationKey ? { operationKey } : {}) }`.

`src/app/reconcile/index.ts`:

```ts
import { controllerRuntime } from "../../lib/runtime.js"
import { ReconcileInput } from "../../lib/routes/input.js"
import { command } from "../../lib/routes/outcome.js"

/** Reconciles every work order. Called by the operator or a supervisor; the app cannot do it at boot unasked. */
export async function workflow(input: unknown) {
  return command(ReconcileInput, input, () => controllerRuntime().factory(), async (_parsed, factory) => {
    const rows = factory.list()
    for (const row of rows) await factory.reconcileWorkOrder(row.id)
    return { ok: true, message: `Reconciled ${rows.length} work orders` }
  })
}
```

Delete `src/app/.gitkeep`. Run `pnpm --filter @b4-example/software-factory-controller check` once and confirm the route list is exactly `/work-orders/create#workflow`, `/work-orders/dispatch#workflow`, `/work-orders/approve#workflow`, `/work-orders/deny#workflow`, `/work-orders/cancel#workflow`, `/reconcile#workflow`.

- [ ] **Step 5: Run**

```bash
pnpm --filter @b4-example/software-factory-controller exec vitest run test/routes.test.ts
pnpm --filter @b4-example/software-factory-controller test
pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint
```

Expected: PASS. If `serveRuntime` refuses to boot because `.b4/` typegen output is missing, run `pnpm --filter @b4-example/software-factory-controller exec b4 typegen` in the helper before serving, and report it; the runtime's doc says it falls back to discovered tools when `.b4/*` is absent, and there are none here.

- [ ] **Step 6: Commit**

```bash
git add -A examples/software-factory/controller
git commit -m "feat(software-factory): the controller's commands are workflow routes, one thread per work order

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Reads are read-only registry reads

**Files:**
- Complete: `examples/software-factory/controller/src/lib/registry/reader.ts`
- Test: `examples/software-factory/controller/test/registry-reader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/lib/controller/factory.ts"
import { openRegistryReader } from "../src/lib/registry/reader.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

let dir: string
let fake: FakeWorker
let factory: Factory
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("registry reader", () => {
  it("reads rows, events and evidence while the writer holds the registry, and cannot write", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-reader-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const registryPath = join(dir, "registry.sqlite")
    factory = await createFactory({
      registryPath,
      worker: createHttpWorkerClient(fake.baseUrl),
      workerRoute: "/build#agent",
      exportDir: join(dir, "out"),
      artifactsDir: join(dir, "artifacts"),
      verifier: createFakeVerifier({ verdict: "pass" }),
      workspaceReader: createFakeWorkspaceReader({}),
      captureBaseline: async () => ({ digest: "a".repeat(64), files: new Map() }),
    })
    const row = await factory.create({ taskId: "cli-flags" })
    const reader = openRegistryReader(registryPath)
    try {
      expect(reader.show(row.id)?.state).toBe("received")
      expect(reader.list().map((r) => r.id)).toEqual([row.id])
      expect(reader.events(row.id).map((e) => e.type)).toContain("created")
      expect(reader.evidence(row.id)).toEqual({ candidate: null, receipt: null, bundle: null })
      expect(reader.show("nope")).toBeNull()
      expect(() => reader.evidence("nope")).toThrow(/Unknown work order/)
      expect(() => reader.db.exec("DELETE FROM work_orders")).toThrow(/readonly|read-only/i)
    } finally {
      reader.close()
    }
  })

  it("refuses to create a registry that does not exist", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-reader-"))
    expect(() => openRegistryReader(join(dir, "missing.sqlite"))).toThrow(/does not exist/)
  })
})
```

Check the work-orders table name in `src/lib/registry/db.ts` migrations for the DELETE line.

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @b4-example/software-factory-controller exec vitest run test/registry-reader.test.ts
```

- [ ] **Step 3: Implement**

`controller/src/lib/registry/reader.ts`:

```ts
import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { UnknownWorkOrderError } from "../controller/factory.js"
import type { Bundle, Candidate, FactoryEvent, Receipt, WorkOrderRow } from "../domain/work-order.js"
import { createEvidenceStore } from "./evidence.js"
import { createWorkOrderStore } from "./work-orders.js"

export interface RegistryReader {
  show(id: string): WorkOrderRow | null
  list(): WorkOrderRow[]
  events(id: string): FactoryEvent[]
  evidence(id: string): { candidate: Candidate | null; receipt: Receipt | null; bundle: Bundle | null }
  /** Exposed for tests that prove the connection cannot write. */
  readonly db: DatabaseSync
  close(): void
}

/**
 * Read-only view of a registry another process writes. SQLite in WAL mode serves readers
 * alongside one writer; `readOnly` makes a write a SQLite error rather than a second writer.
 * The file must already exist: a reader never creates a registry, and a path typo must not
 * look like an empty factory.
 */
export function openRegistryReader(path: string): RegistryReader {
  if (!existsSync(path)) throw new Error(`Registry ${path} does not exist`)
  const db = new DatabaseSync(path, { readOnly: true })
  const store = createWorkOrderStore(db)
  const evidence = createEvidenceStore(db)
  const mustGet = (id: string) => {
    const row = store.get(id)
    if (!row) throw new UnknownWorkOrderError(id)
    return row
  }
  return {
    db,
    show: (id) => store.get(id),
    list: () => store.list(),
    events: (id) => store.events(id),
    evidence(id) {
      const row = mustGet(id)
      const candidate = row.candidateDigest ? evidence.candidate(row.candidateDigest) : null
      const bundle = row.bundleDigest ? evidence.bundle(row.bundleDigest) : null
      const receipt = bundle ? evidence.receipt(bundle.receiptId) : null
      return { candidate, receipt, bundle }
    },
    close: () => db.close(),
  }
}
```

Two cases the Task 5 review asks this task to define and test: (a) a state dir the controller has never opened: the file does not exist, so `openRegistryReader` throws "does not exist" (already specified); (b) a hot WAL left by a crashed writer: a read-only connection can fail with `SQLITE_READONLY_RECOVERY` when the WAL needs recovery. Document that the reader then reports "registry needs recovery; start the controller" rather than retrying, and add a test that opens the reader while the writer is still open (WAL present) and reads successfully (the common case).

If `createWorkOrderStore` or `createEvidenceStore` executes a write at construction (a `CREATE TABLE` or migration), the read-only open throws; in that case split the SELECT statements into a `createWorkOrderReads(db)` and `createEvidenceReads(db)` used by both the stores and the reader, and report it. Preparing an INSERT on a read-only connection is allowed; only executing it fails. If importing `UnknownWorkOrderError` from `factory.ts` drags the verifier and Docker modules into the CLI's read path, move the three error classes into `src/lib/domain/errors.ts` and re-export them from `factory.ts`.

- [ ] **Step 4: Run and commit**

```bash
pnpm --filter @b4-example/software-factory-controller exec vitest run test/registry-reader.test.ts test/routes.test.ts
pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint
git add examples/software-factory/controller
git commit -m "feat(software-factory): read-only registry reads for show, list, events and evidence

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The CLI becomes a client; the HTTP layer goes

**Files:**
- Create: `examples/software-factory/controller/src/lib/client.ts`
- Rewrite: `examples/software-factory/controller/src/cli.ts`
- Delete: `examples/software-factory/controller/src/http.ts`, `test/http.test.ts`
- Rewrite: `examples/software-factory/controller/test/cli.test.ts`

- [ ] **Step 1: Write the failing CLI test**

Rewrite `controller/test/cli.test.ts` so `boot()` serves the controller in-process (`serveController` from Task 5) and spawns the CLI with `FACTORY_CONTROLLER_URL=<served.url>` and `FACTORY_STATE_DIR=<served.stateDir>` (the CLI reads the registry read-only from the state dir for `show`, `list`, `events`, `evidence`). Keep the assertions: create prints a row in `received`; `dispatch` (now awaiting) prints the settled row with `state: "awaiting_approval"` for the `edits_only` fake; `show`, `list`, `events`, `evidence` shapes as before; a refused command exits 1 with the outcome on stdout. Add: `dispatch` prints journal events to stderr while it waits (assert stderr contains `"type":"transition"`), and `cancel` of a hanging dispatch (a second `boot` with `run: "hang"`, `dispatch` spawned without awaiting, then `cancel <id>`) prints a row in `cancel_requested` or `cancelled` and exits 0.

- [ ] **Step 2: Implement the client**

`controller/src/lib/client.ts`:

```ts
import { randomUUID } from "node:crypto"
import type { RouteOutcome } from "./routes/outcome.js"

export class ControllerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = "ControllerHttpError"
  }
}

/** The controller's routes over the Agent Protocol. One thread per work order; `create` runs on a key-derived thread. */
export function createControllerClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/$/, "")
  async function run(
    threadId: string,
    route: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<RouteOutcome> {
    const response = await fetchImpl(
      `${base}/threads/${encodeURIComponent(threadId)}/runs/wait`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route, input }),
        ...(signal ? { signal } : {}),
      },
    )
    const body: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      const failed = body as { error?: { message?: string; details?: { code?: string } } }
      throw new ControllerHttpError(
        response.status,
        failed.error?.details?.code,
        failed.error?.message ?? `HTTP ${response.status}`,
      )
    }
    return body as RouteOutcome
  }
  const withKey = (id: string, operationKey?: string) => ({
    id,
    ...(operationKey ? { operationKey } : {}),
  })
  return {
    create: (input: { taskId: string; operationKey?: string }) =>
      run(`create:${input.operationKey ?? randomUUID()}`, "/work-orders/create#workflow", input),
    dispatch: (id: string, operationKey?: string, signal?: AbortSignal) =>
      run(id, "/work-orders/dispatch#workflow", withKey(id, operationKey), signal),
    approve: (id: string, input: { revision: number; bundleDigest: string; operationKey?: string }) =>
      run(id, "/work-orders/approve#workflow", { id, ...input }),
    deny: (id: string, operationKey?: string) =>
      run(id, "/work-orders/deny#workflow", withKey(id, operationKey)),
    cancel: (id: string, operationKey?: string) =>
      run(id, "/work-orders/cancel#workflow", withKey(id, operationKey)),
    reconcile: () => run("controller", "/reconcile#workflow", {}),
    /** The runtime's cancel of the work order's in-flight run, for a dispatch that is still awaiting. */
    async interrupt(id: string): Promise<"interrupted" | "no_run_in_flight"> {
      const response = await fetchImpl(`${base}/threads/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      })
      return response.ok ? "interrupted" : "no_run_in_flight"
    },
  }
}
export type ControllerClient = ReturnType<typeof createControllerClient>
```

`create` runs on a thread derived from the operation key so a retried create lands on the same thread and the same command key; without a key it is a fresh thread per call.

- [ ] **Step 3: Rewrite the CLI**

`controller/src/cli.ts`: the same commands and usage as before minus `serve`, plus `reconcile` and `builder-manifest`. Environment: `FACTORY_CONTROLLER_URL` (required for write commands), `FACTORY_STATE_DIR` (required for reads: `registry.sqlite` under it). `dispatch` prints the settled row; while its request is in flight it polls `openRegistryReader(...).events(id)` every 500 ms and writes each NEW event as one JSON line to stderr, then closes the reader. `cancel` first calls `client.interrupt(id)`; on `interrupted` it waits briefly (poll `show` until the state is `cancel_requested` or `cancelled`, up to 5 s) and prints the row; otherwise it calls the `cancel` route. Exit code 1 when `ok` is false or `refusal` is set; a `ControllerHttpError` with status 409 prints `{ ok: false, refusal: "run_in_flight", message }` and exits 1. Keep `print` and the stderr-diagnostics convention.

Delete `src/http.ts` and `test/http.test.ts`.

Exit-code contract, from the Task 5 review. There are two body shapes: route refusals (HTTP 200, `{ ok: false, refusal, message }`) and runtime 409s with no `refusal` (`{ error: { kind, message, details: { code } } }`, the code under `details` because of the runtime defect in the follow-ups: `run_in_flight` for a second command on a busy work order, `run_cancelled` for a cancelled dispatch). Both exit 1, printing the body. A `dispatch` that returns 200 with `ok: false` and "Dispatch did not settle" means the work order is still live, not refused: exit 1 and say so. Cancelling a LIVE dispatch is the runtime cancel (`client.interrupt`), not the `cancel` route, which would 409; the CLI's `cancel` needs both, as specified above. Decision for this task: `dispatch` exits non-zero when the settled row is `blocked` or `failed`, using `settledOk` from `src/lib/controller/reconcile.ts` (the semantics reconciliation already uses); today's CLI exits 0 regardless, and that hides a failed work order from a script.

- [ ] **Step 4: Run**

```bash
pnpm --filter @b4-example/software-factory-controller test
pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint
```

Expected: PASS; the CLI test's stderr assertion proves the event tail works and the cancel test proves the interrupt path.

- [ ] **Step 5: Commit**

```bash
git add -A examples/software-factory/controller
git commit -m "feat(software-factory): the factory CLI is a client of the controller routes and a read-only registry reader

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The Docker lanes and CI

**Files:**
- Modify: `examples/software-factory/controller/test/{end-to-end,devkit-end-to-end,verifier-tamper,docker-verifier,target-devkit}.integration.test.ts` (imports; the builder boot)
- Move: `examples/software-factory/server/test/builder.integration.test.ts` to the controller package; delete `server/vitest.sandbox.config.ts` and the server's `test:sandbox` script
- Modify: `.github/workflows/ci.yml` (the factory lane near line 433; it has named the server's `target:prepare` and `test:sandbox` since Task 2 removed them, so CI is red for this branch until this task lands), `scripts/release/test/fixtures/workflow-entrypoints.json`, `scripts/release/test/fixtures/workflow-safe-executables.json`, `turbo.json`

- [ ] **Step 1: Point the integration lanes at the new layout**

The e2e lanes boot the builder from an isolated copy of the builder app root and run the controller in the test process against it. Now: `isolatedBuilder()` (Task 3) copies the server package; the test writes the builder manifest with `writeBuilderManifest(loadTask(id), <tmp>)` and starts the builder harness with `FACTORY_BUILDER_MANIFEST` in its env (read how `createAgentHarness` from `@b4run/testing` is given an app root and env in `end-to-end.integration.test.ts`, and pass the env through). The controller side of those tests constructs `createFactory` directly with the workspace reader's `appRoot` set to the isolated builder root; unchanged otherwise. `builder.integration.test.ts` already moved into the controller package in Task 3 (it cannot exist in the server without controller imports); Task 3 left three `// TODO(Task 8)` markers at the builder boot sites (`builder.integration.test.ts`, `end-to-end.integration.test.ts`, `devkit-end-to-end.integration.test.ts`): write the manifest with `writeBuilderManifest` and pass `FACTORY_BUILDER_MANIFEST` to the harness env at each. `builder.integration.test.ts` also asserts that the BUILDER captured its workspace under `<appRoot>/.factory/captures/builder/<task>`; the builder no longer captures anything (the controller does, at manifest time), so rewrite that assertion to check the workspace the builder served matches the manifest's captured source digest.

- [ ] **Step 2: Run the Docker lanes locally**

```bash
pnpm --filter @b4-example/software-factory-controller target:prepare cli-flags
pnpm --filter @b4-example/software-factory-controller target:prepare devkit
pnpm --filter @b4-example/software-factory-controller test:sandbox
```

Expected: every lane green, including tamper, delayed-writer and weak-repair. `target:prepare` rewrites `targets/*/target.json` with this host's image id; do NOT commit that diff (`git checkout -- examples/software-factory/controller/targets` after the run) unless the pin or Dockerfile changed.

- [ ] **Step 2b: The builder package in the unfiltered turbo graph**

Root `pnpm build` runs `@b4-example/software-factory-server#build` (`b4 build`), and `check` runs `b4 check`; both load `b4.config.ts`, which now throws without `FACTORY_BUILDER_MANIFEST`. (At the Task 2 commit the same build already failed for a different reason, so this is a branch regression to fix here, not a Task 3 one.) Make the builder's `build` and `check` scripts guard on the manifest: create `server/scripts/with-manifest.mjs` that exits 0 with `builder: FACTORY_BUILDER_MANIFEST is not set; skipping <command>` when the variable is unset, and otherwise spawns the given `b4` command with the same stdio and exit code; scripts become `"build": "node scripts/with-manifest.mjs b4 build"` and `"check": "node scripts/with-manifest.mjs b4 check"`. The Docker lane in CI sets the variable (from the manifest it writes with `factory builder-manifest`) so the real build runs there. Add `scripts/**` back to the server's tsconfig `include` only if the script is TypeScript; keep it `.mjs`. Test: a vitest case in `server/test/builder-config.test.ts` that spawns the script without the variable and asserts exit 0 and the notice on stdout, and with the variable pointing at a nonexistent file and a harmless command (`node -e "process.exit(3)"`) asserts exit 3 (the exit code is passed through).

Also in this task: delete `server/test/isolated-app.ts` (no importer remains; the controller has `isolated-builder.ts`), and move the `$TURBO_ROOT$/examples/software-factory/README.md` turbo input from `@b4-example/software-factory-server#test` to the controller's entry (the README-reading test moved).

- [ ] **Step 3: CI**

In `.github/workflows/ci.yml`, replace the four `software-factory-server` commands in the factory lane with the controller equivalents:

```yaml
        run: |
          pnpm turbo run build --filter=@b4-example/software-factory-controller^...
          pnpm --filter @b4-example/software-factory-controller target:prepare cli-flags
          pnpm --filter @b4-example/software-factory-controller target:prepare devkit
          pnpm --filter @b4-example/software-factory-controller test:sandbox
```

Then regenerate both audited fixtures: run `pnpm test:release-controller`; the audit throws one opaque string with no diff, so on failure dump the descriptor from a scratch copy the way the repo's workflow-entrypoint audit note describes, and remember the fixtures escape non-ASCII as `\uXXXX`. Add to `turbo.json`, beside the server's entry:

```json
    "@b4-example/software-factory-controller#test": {
      "dependsOn": ["build", "^test"],
      "inputs": ["$TURBO_DEFAULT$", "$TURBO_ROOT$/examples/software-factory/README.md"]
    },
```

(The moved `workspace-reader.test.ts` reads the shared README.)

- [ ] **Step 4: Run the repo gates the change can reach**

```bash
pnpm test:release-controller
pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-server test
pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-server typecheck
pnpm --filter @b4-example/software-factory-controller lint && pnpm --filter @b4-example/software-factory-server lint
node scripts/check-docs.mjs
```

- [ ] **Step 5: Commit**

```bash
git add -A examples/software-factory .github/workflows/ci.yml scripts/release/test/fixtures turbo.json
git commit -m "ci(software-factory): the Docker lane runs the controller package

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: README, changelogs and the spec's as-landed notes

**Files:**
- Modify: `examples/software-factory/README.md` ("Run it" and "Tests" sections; the package layout), `examples/software-factory/server/CHANGELOG.md`; create `examples/software-factory/controller/CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md` §4

- [ ] **Step 1: README**

Update "Run it": start the controller with `pnpm --filter @b4-example/software-factory-controller dev --port 4300` with `FACTORY_WORKER_URL`, `FACTORY_STATE_DIR`, `FACTORY_BUILDER_APP_ROOT` set; write the builder manifest with `pnpm --filter @b4-example/software-factory-controller factory builder-manifest --task cli-flags --out <dir>`; start the builder with `FACTORY_BUILDER_MANIFEST=<dir>/cli-flags.json pnpm --filter @b4-example/software-factory-server dev --port 4100`; then `FACTORY_CONTROLLER_URL=http://127.0.0.1:4300 FACTORY_STATE_DIR=... pnpm --filter @b4-example/software-factory-controller factory create --task cli-flags`, `dispatch <id>` (awaits and tails events), `approve ...`. Update "Tests" for the two packages. Do not remove any sentence `workspace-reader.test.ts` asserts against (it reads the README for the replacement-reader options; run that test after editing).

- [ ] **Step 2: Spec as-landed notes**

In §4.2 after the "The budget ticker lives in the route" bullet add:

```markdown
> **As landed:** the ticker stays in the Factory. A process-lived Factory exists after all,
> opened by middleware `setup` and closed by `dispose`, so the ticker, tracked runs and
> `close()` keep their rung 2 shape; `dispatch` awaits its run through `Factory.settle`.
> Per-command reconcile skips the reattach when an observer for that work order is already
> live in this process (`ControllerContext.isTracked`), so it cannot evict the observer a
> `dispatch` left running; the `reconcile` route is the boot reconcile (`reconcileAll`),
> not a per-row loop. A `StaleRevisionError` is a refusal (`stale_revision`), not a 500.
```

And in §4.3 replace "**The Factory object becomes per-route.** ... disposed in `dispose`." with an as-landed note: one Factory per process, opened by middleware `setup` and closed by `dispose`; routes reach it through the runtime singleton; the verifier and reader are constructed once inside it.

Also add to §4.1's as-landed note (or §9): the targets' `target.json` paths (`root`, `imageContext`, `lockfile`) and the target Dockerfiles' `COPY` lines name the tree at the PINNED commit, where the fixtures lived under `examples/software-factory/server/`; they are correct as long as the pin predates this move. The next re-pin to a commit at or after this branch must rewrite them to `examples/software-factory/controller/fixtures/...` in the same edit; a missed `root` fails loudly at archive time, a missed `imageContext` entry silently builds a smaller image.

In §4.1 after "the builder's `b4.config.ts` imports it from the controller package" add:

```markdown
> **As landed:** the packages share no source. The controller writes a JSON manifest per
> task (`factory builder-manifest`): the captured workspace, the target's image, sandbox
> policy and permissions, and the prompt. The builder's `b4.config.ts` verifies and serves
> it through the resolver form from §5, which is also how sub-project 3 will pick a task
> per thread.
```

- [ ] **Step 3: Run the docs checks and commit**

```bash
node scripts/check-docs.mjs
pnpm --filter @b4-example/software-factory-controller exec vitest run test/workspace-reader.test.ts
git add examples/software-factory docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md
git commit -m "docs(software-factory): the controller app, the builder manifest, and the spec's as-landed notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The full gate

- [ ] Run, in the worktree, each exiting 0 and none piped through `tail`:

```bash
pnpm turbo run build --filter='@b4-example/software-factory-controller^...' --output-logs=errors-only
pnpm --filter @b4-example/software-factory-controller lint && pnpm --filter @b4-example/software-factory-server lint
pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-server typecheck
pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-server test
pnpm --filter @b4-example/software-factory-controller test:sandbox
pnpm test:release-controller
node scripts/check-docs.mjs
git status --short examples/code-fixer
```

- [ ] Confirm `git status --short examples/software-factory/controller/targets` prints nothing (no host image ids committed) and `examples/code-fixer` has no diff.

---

## Self-review against §4

- §4.1 shape: Tasks 1, 2, 5 (routes), 6 (reads not routes), 3 (the builder boundary, amended in Task 9).
- §4.2 one thread per work order: Task 5 (`create` on a caller thread, everything else on the id; the third routes test proves `run_in_flight` and the cancel path); `dispatch` awaits: Tasks 4, 5; cancel: Task 5's abort handler plus Task 7's `interrupt`; ticker: amended (Task 9); scoped reconcile plus the `reconcile` route: Task 5; refusals as values: Task 5's `outcome.ts`; input validated in the route: `input.ts`.
- §4.3 idempotency: operation keys ride in input (Task 5); single writer: Tasks 6, 7 (reads read-only, writes via routes); Factory behind `setup`/`dispose`: Task 4; no live model: none of the tests use one.
- §4.4 proof: Tasks 2 (unit suite unchanged), 8 (Docker lanes including the adversarial cases), 5 (cancelled dispatch recorded), 7 (CLI drives it end to end).
- §4.5 findings: already in the spec.
- Names used consistently: `Factory.settle`, `Factory.reconcileWorkOrder`, `createControllerRuntime`, `controllerRuntime`, `resetControllerRuntimeForTests`, `RouteOutcome`, `command`, `refused`, `openRegistryReader`, `createControllerClient`, `writeBuilderManifest`, `BuilderManifestSchema`, `loadBuilderManifest`, `isolatedBuilder`, `serveController`, `FACTORY_BUILDER_APP_ROOT`, `FACTORY_BUILDER_MANIFEST`, `FACTORY_CONTROLLER_URL`.

## Follow-ups this plan records, not in scope

- **Latent flake found by the Task 6 review:** `test/baseline.test.ts` calls `captureTargetBaseline`, which captures the LIVE controller source tree under `appRoot`; a concurrent write under the package (an editor, another agent) fails it with a capture mismatch. Pre-existing. Fix is to capture from a temp copy or a pinned archive in that test.
- **Reader schema check:** `openRegistryReader` does not check `schema_version`; a registry written by a newer controller reads until a zod parse fails. Add the same `RegistryVersionError` refusal the writer has.

- **Runtime defect found by Task 5:** `runtime-fetch-core.ts` passes `{ code }` as `createRequestErrorBody`'s second positional (`details`) for the `run_in_flight` (~line 2426) and `run_cancelled` (~line 2493) 409s, so the body is `{ error: { details: { code }, kind, message } }` and the top-level `error.code` (with its docs URL) is never set. Clients must read `error.details.code` for these two. Fix in `@b4run/cli` as its own PR; the CLI in Task 7 reads `details.code` until then.

- The registry has no owner record; a second controller process is undetected. A `controller_owner` row with a heartbeat, refused on open when live, is the fix.
- Authorization on the controller's routes (`src/thread-access.ts` or the middleware `handle`) is out of scope for this rung, as the RFC scopes it.
- `dispatch` holds one HTTP request open for the run's whole duration; a client behind a proxy with a shorter idle timeout reconnects by `show`, which is the documented behaviour, not a bug.
