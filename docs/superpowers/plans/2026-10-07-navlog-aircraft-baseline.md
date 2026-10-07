# navlog aircraft baseline — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move navlog's demo aircraft (N734ST) out of the system prompt into a read-only workspace
file the agent reads with `readDoc`, and make navlog's reference corpus read-only.

**Architecture:**
- `workspace/aircraft/c172n.md` is the baseline, read through the existing `readDoc` tool.
- A navlog-owned `FilesystemMiddleware` (`readOnlyPaths`) wraps `localFilesystem()` in
  `b4.config.ts` `backends.filesystem`. It refuses mutations under `AGENTS.md`, `aircraft/`, `poh/`
  and `regs/`.
- Every server change is mirrored into the scaffold template
  `packages/devkit/templates/app-navlog/server`.

**Tech stack:** TypeScript (NodeNext ESM), `@b4run/workspace` (`compose`, `localFilesystem`),
vitest, `@b4run/testing` (`createAgentHarness`, `script`), `@b4run/evals`.

**Spec:** `docs/superpowers/specs/2026-10-07-navlog-aircraft-baseline-design.md` (PR
cacheplane/b4run#972).

**Conventions (from AGENTS.md and memory):**
- Run every command from the repo root, on Node 24 (`nvm use 24`).
- Never run bare `biome check --write`. Use `pnpm lint`, or scope Biome with
  `--config-path packages/config-biome/biome.json` to the files you changed, then check
  `git diff --stat`.
- `src/` imports siblings with `.js`; `test/` imports with `.ts`.
- `exactOptionalPropertyTypes` is on, so use conditional spreads, never `{ x: undefined }`.
- In a shared worktree, never `git checkout` or `git stash`. Stage only your own files.

---

## File map

| File | Responsibility |
|---|---|
| `examples/navlog/server/src/lib/read-only-paths.ts` (new) | `readOnlyPaths(protected)`: the filesystem middleware |
| `examples/navlog/server/test/read-only-paths.test.ts` (new) | Unit tests over a recording fake backend |
| `examples/navlog/server/test/workspace-guard.test.ts` (new) | `b4.config.ts`'s real backend against a temp dir, plus one in-process agent turn |
| `examples/navlog/server/b4.config.ts` | Wires `backends.filesystem` |
| `examples/navlog/server/package.json` | Adds `@b4run/workspace` |
| `examples/navlog/server/workspace/aircraft/c172n.md` (new) | The baseline |
| `examples/navlog/server/workspace/AGENTS.md` | Read-only header |
| `examples/navlog/server/src/tools/readDoc.ts` | `aircraft/` root |
| `examples/navlog/server/test/read-doc.test.ts` | `aircraft/` root covered |
| `examples/navlog/server/test/corpus-sync.test.ts` | Baseline matches the POH |
| `examples/navlog/server/src/app/navlog/index.ts` | Prompt step 1 + Assumptions bullet |
| `examples/navlog/server/src/app/navlog/memory.md`, `plan.md` | Baseline vs. overrides wording |
| `examples/navlog/server/src/app/navlog/evals/navlog-quality.eval.ts` | `readDoc` step, new baseline case |
| `packages/devkit/templates/app-navlog/server/**` | Mirror of all of the above (`.template` suffix where the existing file has one) |
| `test/generated/run-generated-navlog-activation.test.ts` | Pinned recall query and todo strings |
| `apps/web/content/docs/recipes/flight-planner.mdx`, `workspace.mdx` | Docs |
| `apps/web/app/seo/lastmod.generated.json` | Regenerated |
| `.changeset/navlog-aircraft-baseline.md` (new) | `@b4run/devkit` patch |

Not changed, after checking:
- `examples/navlog/web/app/components/VerdictCard.test.tsx` and `app/lib/assistant-text.test.ts`.
  They feed the old recall text to a sanitizer as arbitrary echoed tool-call text, and nothing
  binds it to the prompt.
- The N738ZU references in docs, brand and `apps/web/content/templates/AGENTS.md`. Those are the
  teach scenario or generic `computeNavlog` examples.

---

### Task 0: Branch and build

- [ ] **Step 1: Confirm the branch and pull latest main**

```bash
git status -sb
git fetch -q origin main && git rebase origin/main
```
Expected: on `blove/navlog-aircraft-baseline`, clean, rebased.

- [ ] **Step 2: Install and build**

```bash
nvm use 24 && pnpm install && pnpm build
```
Expected: build succeeds. Packages are consumed from `dist/`, so a stale build gives false
negatives.

---

### Task 1: `readOnlyPaths` middleware (TDD)

**Files:**
- Create: `examples/navlog/server/src/lib/read-only-paths.ts`
- Test: `examples/navlog/server/test/read-only-paths.test.ts`
- Modify: `examples/navlog/server/package.json` (dependency)

- [ ] **Step 1: Add the dependency**

In `examples/navlog/server/package.json` `dependencies`, after `"@b4run/sdk": "workspace:*",`, add:

```json
    "@b4run/workspace": "workspace:*",
```

Run: `pnpm install`
Expected: `pnpm-lock.yaml` gains `@b4run/workspace` under `examples/navlog/server`.

- [ ] **Step 2: Write the failing tests**

`examples/navlog/server/test/read-only-paths.test.ts`:

```ts
import type { BackendContext, FilesystemBackend } from "@b4run/workspace"
import { describe, expect, it, vi } from "vitest"
import { readOnlyPaths } from "../src/lib/read-only-paths.ts"

const ROOT = "/app/workspace"
const ctx: BackendContext = { signal: new AbortController().signal, workspaceRoot: ROOT }
const PROTECTED = ["AGENTS.md", "aircraft/", "poh/", "regs/"] as const

function fakeBackend(): FilesystemBackend & Record<string, ReturnType<typeof vi.fn>> {
  return {
    lstat: vi.fn(async () => ({ kind: "file" as const, size: 1, executable: false })),
    readFile: vi.fn(async () => "content"),
    readBinaryFile: vi.fn(async () => new Uint8Array()),
    readBinaryFiles: vi.fn(async () => []),
    writeFile: vi.fn(async () => ({ bytesWritten: 1 })),
    listDir: vi.fn(async () => []),
    realPath: vi.fn(async (p: string) => p),
    statFile: vi.fn(async () => ({ size: 1, mtimeMs: 0 })),
    removeFile: vi.fn(async () => undefined),
    touchFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    walkTree: vi.fn(async () => []),
  }
}

const abs = (rel: string): string => `${ROOT}/${rel}`

describe("readOnlyPaths", () => {
  const PROTECTED_TARGETS = [
    "AGENTS.md",
    "aircraft/c172n.md",
    "aircraft",
    "poh/cruise-performance.md",
    "poh/new/deep.md",
    "regs/vfr-fuel-reserves.md",
    // A case-insensitive filesystem (macOS dev) resolves these to the protected files.
    "POH/cruise-performance.md",
    "agents.md",
  ]

  it("refuses every mutating method on a protected path, before reaching the backend", async () => {
    const next = fakeBackend()
    const fs = readOnlyPaths(PROTECTED)(next)
    for (const rel of PROTECTED_TARGETS) {
      await expect(fs.writeFile(abs(rel), "x", ctx)).rejects.toThrow(
        `${rel} is read-only reference material in this app; write reports under reports/`,
      )
      await expect(fs.removeFile?.(abs(rel), ctx)).rejects.toThrow(/read-only reference material/)
      await expect(fs.touchFile?.(abs(rel), ctx)).rejects.toThrow(/read-only reference material/)
      await expect(fs.mkdir?.(abs(rel), ctx)).rejects.toThrow(/read-only reference material/)
    }
    expect(next.writeFile).not.toHaveBeenCalled()
    expect(next.removeFile).not.toHaveBeenCalled()
    expect(next.touchFile).not.toHaveBeenCalled()
    expect(next.mkdir).not.toHaveBeenCalled()
  })

  it("lets writes through outside the protected entries", async () => {
    const next = fakeBackend()
    const fs = readOnlyPaths(PROTECTED)(next)
    for (const rel of [
      "reports/KSTP-KRST.md",
      "tool-outputs/x.txt",
      "flight-plans/261005-KSTP-KRST.txt",
      "poh2/x.md",
      "reports/AGENTS.md",
      "AGENTS.md.bak",
    ]) {
      await expect(fs.writeFile(abs(rel), "x", ctx)).resolves.toEqual({ bytesWritten: 1 })
    }
    expect(next.writeFile).toHaveBeenCalledTimes(6)
  })

  it("leaves a path outside the workspace root to the runtime's own path gate", async () => {
    const next = fakeBackend()
    const fs = readOnlyPaths(PROTECTED)(next)
    await fs.writeFile("/elsewhere/poh/x.md", "x", ctx)
    expect(next.writeFile).toHaveBeenCalledWith("/elsewhere/poh/x.md", "x", ctx)
  })

  it("forwards reads of protected paths unchanged", async () => {
    const next = fakeBackend()
    const fs = readOnlyPaths(PROTECTED)(next)
    await expect(fs.readFile(abs("poh/cruise-performance.md"), ctx)).resolves.toBe("content")
    await fs.listDir(abs("poh"), ctx)
    await fs.realPath(abs("poh"), ctx)
    await fs.lstat?.(abs("poh"), ctx)
    await fs.readBinaryFile?.(abs("poh/x"), ctx)
    await fs.readBinaryFiles?.([{ path: abs("poh/x"), maxBytes: 10 }], ctx)
    await fs.statFile?.(abs("poh/x"), ctx)
    await fs.walkTree?.(abs("poh"), ctx, { maxEntries: 10 })
    for (const method of [
      "readFile",
      "listDir",
      "realPath",
      "lstat",
      "readBinaryFile",
      "readBinaryFiles",
      "statFile",
      "walkTree",
    ]) {
      expect(next[method], method).toHaveBeenCalledTimes(1)
    }
  })

  it("keeps an optional method absent when the base lacks it", () => {
    const base: FilesystemBackend = {
      readFile: async () => "",
      writeFile: async () => ({ bytesWritten: 0 }),
      listDir: async () => [],
      realPath: async (p) => p,
    }
    const fs = readOnlyPaths(PROTECTED)(base)
    for (const method of [
      "lstat",
      "readBinaryFile",
      "readBinaryFiles",
      "statFile",
      "removeFile",
      "touchFile",
      "mkdir",
      "walkTree",
    ] as const) {
      expect(fs[method], method).toBeUndefined()
    }
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --dir examples/navlog/server exec vitest run test/read-only-paths.test.ts`
Expected: FAIL, because the module `../src/lib/read-only-paths.ts` can't be resolved.

- [ ] **Step 4: Implement**

`examples/navlog/server/src/lib/read-only-paths.ts`:

```ts
import { isAbsolute, relative, sep } from "node:path"
import type { BackendContext, FilesystemBackend, FilesystemMiddleware } from "@b4run/workspace"

/**
 * Workspace paths the agent may read but never change. An entry ending in "/"
 * protects that directory and everything under it; any other entry protects
 * that one file.
 *
 * The workspace is one host directory every visitor's turns share, and the
 * runtime's path gate covers only paths OUTSIDE it. Without this, any visitor
 * could get the agent to rewrite the POH tables, the aircraft baseline or
 * AGENTS.md for everyone. Backend methods receive an already-resolved
 * absolute path inside `ctx.workspaceRoot`; matching is case-insensitive
 * because a case-insensitive filesystem resolves `POH/x.md` to `poh/x.md`.
 */
export function readOnlyPaths(protectedPaths: readonly string[]): FilesystemMiddleware {
  const entries = protectedPaths.map((entry) => entry.toLowerCase())

  const protectedRelative = (path: string, ctx: BackendContext): string | undefined => {
    const rel = relative(ctx.workspaceRoot, path).split(sep).join("/")
    if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return undefined
    const folded = rel.toLowerCase()
    const hit = entries.some((entry) =>
      entry.endsWith("/")
        ? folded === entry.slice(0, -1) || folded.startsWith(entry)
        : folded === entry,
    )
    return hit ? rel : undefined
  }

  const guard = (path: string, ctx: BackendContext): void => {
    const rel = protectedRelative(path, ctx)
    if (rel !== undefined) {
      throw new Error(
        `${rel} is read-only reference material in this app; write reports under reports/`,
      )
    }
  }

  return (next: FilesystemBackend): FilesystemBackend => ({
    readFile: (path, ctx, opts) => next.readFile(path, ctx, opts),
    writeFile: async (path, content, ctx) => {
      guard(path, ctx)
      return await next.writeFile(path, content, ctx)
    },
    listDir: (path, ctx) => next.listDir(path, ctx),
    realPath: (path, ctx) => next.realPath(path, ctx),
    ...(next.lstat && { lstat: (path, ctx) => next.lstat!(path, ctx) }),
    ...(next.readBinaryFile && {
      readBinaryFile: (path, ctx, opts) => next.readBinaryFile!(path, ctx, opts),
    }),
    ...(next.readBinaryFiles && {
      readBinaryFiles: (requests, ctx) => next.readBinaryFiles!(requests, ctx),
    }),
    ...(next.statFile && { statFile: (path, ctx) => next.statFile!(path, ctx) }),
    ...(next.walkTree && { walkTree: (path, ctx, opts) => next.walkTree!(path, ctx, opts) }),
    ...(next.removeFile && {
      removeFile: async (path, ctx) => {
        guard(path, ctx)
        await next.removeFile!(path, ctx)
      },
    }),
    ...(next.touchFile && {
      touchFile: async (path, ctx) => {
        guard(path, ctx)
        await next.touchFile!(path, ctx)
      },
    }),
    ...(next.mkdir && {
      mkdir: async (path, ctx) => {
        guard(path, ctx)
        await next.mkdir!(path, ctx)
      },
    }),
  })
}
```

If Biome's `noNonNullAssertion` rule flags the `!`s, capture each optional method in a `const` first
(`const lstat = next.lstat`), then spread `...(lstat && { lstat: (p, c) => lstat(p, c) })`. Don't
call it unbound: `localFilesystem()` returns a closure-based object today, but don't rely on it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --dir examples/navlog/server exec vitest run test/read-only-paths.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Lint and typecheck**

```bash
pnpm --dir examples/navlog/server lint && pnpm --dir examples/navlog/server typecheck
```
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add examples/navlog/server/package.json pnpm-lock.yaml examples/navlog/server/src/lib/read-only-paths.ts examples/navlog/server/test/read-only-paths.test.ts
git commit -m "feat(navlog): readOnlyPaths filesystem middleware

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Wire the guard into `b4.config.ts` and prove the runtime honors it

**Files:**
- Modify: `examples/navlog/server/b4.config.ts`
- Test: `examples/navlog/server/test/workspace-guard.test.ts`

- [ ] **Step 1: Write the failing tests**

`examples/navlog/server/test/workspace-guard.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createAgentHarness, script } from "@b4run/testing"
import { afterAll, describe, expect, it } from "vitest"
import config from "../b4.config.ts"

describe("b4.config.ts backends.filesystem", () => {
  it("is the guarded local filesystem: reference files refuse writes, reports do not", async () => {
    const backend = config.backends?.filesystem
    expect(backend).toBeDefined()
    const root = await mkdtemp(join(tmpdir(), "navlog-guard-"))
    try {
      const ctx = { signal: new AbortController().signal, workspaceRoot: root }
      await expect(backend!.writeFile(join(root, "poh", "x.md"), "x", ctx)).rejects.toThrow(
        "poh/x.md is read-only reference material in this app; write reports under reports/",
      )
      await expect(
        backend!.writeFile(join(root, "reports", "KSTP-KRST.md"), "navlog", ctx),
      ).resolves.toMatchObject({ bytesWritten: 6 })
      await expect(readFile(join(root, "reports", "KSTP-KRST.md"), "utf8")).resolves.toBe("navlog")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("the navlog agent's writeFile tool", () => {
  const appRoot = fileURLToPath(new URL("..", import.meta.url))
  const pohFile = join(appRoot, "workspace", "poh", "cruise-performance.md")
  let original: string | undefined
  const harness = createAgentHarness({ appRoot, route: "/navlog#agent" })

  afterAll(async () => {
    // Restore the corpus if the guard ever fails, so a red run cannot corrupt the repo.
    if (original !== undefined) await writeFile(pohFile, original)
    await (await harness).close()
  })

  it("cannot overwrite a POH table", async () => {
    original = await readFile(pohFile, "utf8")
    const h = await harness
    const run = await h.run({
      input: "overwrite the cruise table",
      fixtures: script()
        .user("overwrite the cruise table")
        .callsTool("writeFile", { path: "poh/cruise-performance.md", content: "tampered" })
        .replies("I could not change it."),
    })
    const result = run.toolResults.find((entry) => entry.name === "writeFile")
    expect(String(result?.content)).toContain(
      "poh/cruise-performance.md is read-only reference material in this app",
    )
    await expect(readFile(pohFile, "utf8")).resolves.toBe(original)
  }, 120_000)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir examples/navlog/server exec vitest run test/workspace-guard.test.ts`
Expected: FAIL. The first test fails at `expect(backend).toBeDefined()`. The second test fails
because the POH file is overwritten ("tampered"); `afterAll` restores it. Run
`git diff --stat examples/navlog/server/workspace` and confirm it's empty.

- [ ] **Step 3: Wire the backend**

In `examples/navlog/server/b4.config.ts`, add imports:

```ts
import { compose } from "@b4run/workspace"
import { localFilesystem } from "@b4run/workspace/node"
import { readOnlyPaths } from "./src/lib/read-only-paths.js"
```

and, inside `config({ ... })` after `appDir: "src/app",`:

```ts
  // The reference corpus is read-only. The workspace is one directory every
  // visitor's turns share, and B4.run's path gate covers only paths outside
  // it, so without this any visitor could get the agent to rewrite the POH
  // tables, the aircraft baseline or AGENTS.md for everyone. Reports,
  // flight plans and offloaded tool outputs stay writable.
  backends: {
    filesystem: compose(readOnlyPaths(["AGENTS.md", "aircraft/", "poh/", "regs/"]))(
      localFilesystem(),
    ),
  },
```

The `./src/lib/read-only-paths.js` import follows the `src/` `.js` convention. If `b4 typegen` or
`tsc` resolves `b4.config.ts` differently, check how `examples/memory/server/b4.config.ts` or
another config imports app source and match it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --dir examples/navlog/server exec vitest run test/workspace-guard.test.ts`
Expected: PASS, 2 tests, and `git diff --stat examples/navlog/server/workspace` is empty.

If the harness test still overwrites the file while the config test passes, the runtime isn't
using `config.backends`. Read `packages/cli/src/lib/runtime/execute-route-core.ts:1347` and
`:1675` (where `configBackends` becomes `capabilityBackends`), and find the path the harness takes.
Stop and report rather than patching the framework in this PR.

- [ ] **Step 5: Confirm the production entry loads the same config**

`main.mjs` calls `serve({ appRoot, modules, ... })` and passes no config. Check that `serve` loads
`b4.config.ts` itself, the same way the live `memory.store` reaches it today:

```bash
grep -n "loadConfig\|config" packages/cli/src/lib/dev/serve.ts | head -20
```

Expected: `serve` → `runtime-fetch-core` → `prepareRouteExecution`, which loads `b4.config.ts`
through `fallbacks.loadConfig(appRoot)` (`execute-route-core.ts:1346`). Write down the line you
confirmed in the commit message. If `serve` doesn't load it, stop and report.

- [ ] **Step 6: Run the whole server suite**

Run: `pnpm --dir examples/navlog/server test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add examples/navlog/server/b4.config.ts examples/navlog/server/test/workspace-guard.test.ts
git commit -m "feat(navlog): the reference corpus is read-only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The baseline file, kept in sync with the POH

**Files:**
- Create: `examples/navlog/server/workspace/aircraft/c172n.md`
- Modify: `examples/navlog/server/test/corpus-sync.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `examples/navlog/server/test/corpus-sync.test.ts`:

```ts
describe("workspace/aircraft/c172n.md matches the POH", () => {
  const aircraft = readFileSync(
    fileURLToPath(new URL("../workspace/aircraft/c172n.md", import.meta.url)),
    "utf8",
  )
  it("usable fuel for long range and standard tanks", () => {
    const fuel = doc("weights-and-fuel")
    expect(fuel).toContain("| Long range (2) | 27 US gal | 54 US gal | 50 US gal | 4 US gal |")
    expect(fuel).toContain("| Standard (2) | 21.5 US gal | 43 US gal | 40 US gal | 3 US gal |")
    expect(aircraft).toContain(
      "| Usable fuel | 50 US gal | [poh/weights-and-fuel.md] (standard tanks: 40 US gal) |",
    )
  })
  it("start, taxi and takeoff fuel", () => {
    expect(doc("time-fuel-distance-to-climb")).toContain(
      "Add 1.1 gallons for engine start, taxi and takeoff.",
    )
    expect(aircraft).toContain(
      "| Start, taxi and takeoff | 1.1 US gal | [poh/time-fuel-distance-to-climb.md, Figure 5-6] |",
    )
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir examples/navlog/server exec vitest run test/corpus-sync.test.ts`
Expected: FAIL with `ENOENT` for `workspace/aircraft/c172n.md`.

- [ ] **Step 3: Create the baseline**

`examples/navlog/server/workspace/aircraft/c172n.md`:

```markdown
# Demo aircraft: N734ST

The aircraft this planner assumes when the pilot has not said otherwise. What the pilot says in
the request wins; then what this pilot asked the planner to remember; then this file.

| Item | Value | Source |
|---|---|---|
| Tail number | N734ST | Demo aircraft |
| Type | Cessna 172N (1978) | Demo aircraft |
| Tanks | Long range | Demo aircraft |
| Usable fuel | 50 US gal | [poh/weights-and-fuel.md] (standard tanks: 40 US gal) |
| Cruise power | 2400 RPM | Demo aircraft |
| Start, taxi and takeoff | 1.1 US gal | [poh/time-fuel-distance-to-climb.md, Figure 5-6] |
| Reserve | 45 min at planned cruise burn | [regs/vfr-fuel-reserves.md] |

"Full tanks" means all usable fuel. A pilot who says "standard tanks" has 40 US gal usable.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --dir examples/navlog/server exec vitest run test/corpus-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/navlog/server/workspace/aircraft/c172n.md examples/navlog/server/test/corpus-sync.test.ts
git commit -m "feat(navlog): demo aircraft N734ST baseline in workspace/aircraft

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `readDoc` reads `aircraft/`

**Files:**
- Modify: `examples/navlog/server/src/tools/readDoc.ts`
- Test: `examples/navlog/server/test/read-doc.test.ts`

- [ ] **Step 1: Update the tests first**

In `examples/navlog/server/test/read-doc.test.ts`:
- Rename the first test to `"reads the aircraft baseline, POH tables, regulations and offloaded tool outputs"`.
- Add `"aircraft/c172n.md",` as the first path.
- Change `toHaveBeenCalledTimes(3)` to `toHaveBeenCalledTimes(4)`.
- In the second test, add `"aircraft/../AGENTS.md"` to the refused list and change the expected
  message regex to:

```ts
        /readDoc accepts workspace paths under aircraft\/, poh\/, regs\/, tool-outputs\//,
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir examples/navlog/server exec vitest run test/read-doc.test.ts`
Expected: FAIL. `aircraft/c172n.md` is refused, and the message lists `poh/, regs/, tool-outputs/`.

- [ ] **Step 3: Implement**

In `examples/navlog/server/src/tools/readDoc.ts`:

```ts
const ROOTS = ["aircraft/", "poh/", "regs/", "tool-outputs/"]
```

and change the doc comment's first sentence to:

```ts
/**
 * Read the aircraft baseline, a POH table or a regulation excerpt by its
 * workspace path, e.g. "aircraft/c172n.md" or "poh/cruise-performance.md", or
 * an offloaded tool output named by a "Full output saved to: tool-outputs/..." stub.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --dir examples/navlog/server exec vitest run test/read-doc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/navlog/server/src/tools/readDoc.ts examples/navlog/server/test/read-doc.test.ts
git commit -m "feat(navlog): readDoc reads the aircraft baseline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Prompt, memory guidance, plan seed and AGENTS.md

**Files:**
- Modify: `examples/navlog/server/src/app/navlog/index.ts:13,29`
- Modify: `examples/navlog/server/src/app/navlog/memory.md`
- Modify: `examples/navlog/server/src/app/navlog/plan.md`
- Modify: `examples/navlog/server/workspace/AGENTS.md`

- [ ] **Step 1: Replace prompt step 1** (`index.ts` line 13, the whole `1. Start with …` line):

```
1. Start by calling \`readDoc({ path: "aircraft/c172n.md" })\` and \`recall({ query: "pilot aircraft overrides and preferences" })\` together. The baseline file is the demo aircraft. A recalled fact overrides it, and what the pilot says in the request overrides both. Do not stop to ask for anything the three leave open: use the baseline and list each baseline value you relied on under Assumptions. When the pilot states aircraft facts or preferences, \`remember\` them.
```

- [ ] **Step 2: Replace the Assumptions bullet** (line 29). Change
`any POH default you used for usable fuel or cruise RPM;` to
`any baseline value you used (tail number, usable fuel, cruise RPM);`. The rest of the line is
unchanged.

- [ ] **Step 3: Rewrite `memory.md`'s first bullet**

Replace the first bullet (the three lines starting `- The aircraft profile lives in long-term memory`)
with:

```markdown
- The demo aircraft's baseline lives in `aircraft/c172n.md`; read it with
  `readDoc`. Long-term memory holds what this pilot stated: subject `aircraft`
  with predicates `tail_number`, `cruise_rpm`, `usable_fuel_gal`,
  `reserve_minutes`, plus their preferences. A recalled fact overrides the
  baseline; what the pilot says in the request overrides both. Remember new
  facts the pilot states.
```

- [ ] **Step 4: Update `plan.md`'s first todo**

```markdown
- [ ] Read the aircraft baseline, recall the pilot's overrides, and parse the route, altitude and departure time
```

- [ ] **Step 5: Rewrite `workspace/AGENTS.md`'s header**

Replace the first paragraph (lines 3–6) with:

```markdown
B4.run injects this file into the agent's system prompt every turn. It is
read-only house style: the app's `b4.config.ts` refuses writes to it, to
`aircraft/`, `poh/` and `regs/`, so one visitor's turn can never change what
every other visitor's agent is told. Durable facts about a pilot go to memory
with `remember`.
```

- [ ] **Step 6: Run the server suite and typecheck**

```bash
pnpm --dir examples/navlog/server test && pnpm --dir examples/navlog/server typecheck
```
Expected: PASS. Nothing asserts the prompt text in the server tests.

- [ ] **Step 7: Commit**

```bash
git add examples/navlog/server/src/app/navlog/index.ts examples/navlog/server/src/app/navlog/memory.md examples/navlog/server/src/app/navlog/plan.md examples/navlog/server/workspace/AGENTS.md
git commit -m "feat(navlog): plans start from the aircraft baseline and the pilot's overrides

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Eval: the `readDoc` step and a baseline case

**Files:**
- Modify: `examples/navlog/server/src/app/navlog/evals/navlog-quality.eval.ts`

- [ ] **Step 1: Update constants**

- Replace `const PROFILE = "aircraft profile and pilot preferences"` with
  `const PROFILE = "pilot aircraft overrides and preferences"`.
- In `PLAN_TODOS`, change the first todo's `content` to
  `"Read the aircraft baseline, recall the pilot's overrides, and parse the route, altitude and departure time"`.
- Add, after `const AIRCRAFT = …`:

```ts
const BASELINE_AIRCRAFT = { tailNumber: "N734ST", cruiseRpm: 2400, usableFuelGal: 50 }
const BASELINE_INPUT = "Plan KSTP to KRST at 4500 departing 1400Z. Do not file it."
```

- [ ] **Step 2: Thread the aircraft through `planFixtures`**

Add `readonly aircraft?: typeof AIRCRAFT` to `PlanScript`. In `planFixtures`, start the script
with the baseline read:

```ts
  let builder = script()
    .user(plan.input)
    .callsTool("readDoc", { path: "aircraft/c172n.md" })
    .callsTool("recall", { query: PROFILE })
    .callsTool("writeTodos", PLAN_TODOS)
```

and pass `aircraft: plan.aircraft ?? AIRCRAFT,` in the `computeNavlog` arguments instead of
`aircraft: AIRCRAFT,`.

- [ ] **Step 3: Add the baseline case** after "plan without filing" in `dataset`:

```ts
    {
      // No aircraft in the request: the plan runs on the workspace baseline, N734ST.
      name: "plan on the baseline aircraft",
      input: BASELINE_INPUT,
      fixtures: planFixtures({
        input: BASELINE_INPUT,
        aircraft: BASELINE_AIRCRAFT,
        departureTimeUtc: "2026-10-06T14:00:00Z",
        waypoints: [KSTP, KRST],
        navlogTable:
          "| From | To | Segment | MH | GS | Dist | ETE | Fuel |\n|---|---|---|---|---|---|---|---|\n| KSTP | KRST | climb | 158 | 80 | 8 | 6 | 2.3 |\n| KSTP | KRST | cruise | 161 | 129 | 58 | 27 | 3.2 |\n\nTotals: 66 nm, 33 min, 5.5 gal, reserve 380 min.\n",
        brief: [
          "Bottom line: GO — KSTP and KRST are VFR now and at the 1433Z ETA, with no advisory during the flight.",
          "Watch for: none during the flight.",
          "Numbers: 66 nm, ETE 33 min, 5.5 gal burned (includes 1.1 gal for start, taxi and takeoff), 44.5 gal at landing, reserve 380 min [poh/cruise-performance.md, Figure 5-7].",
          "Assumptions: departure 1400Z 6 Oct 2026; 1 person on board assumed — tell me if different; demo aircraft N734ST, 50 gal usable, 2400 RPM.",
          "As asked, I have not filed it; I can try another altitude or re-brief closer to departure.",
        ].join("\n"),
      }),
    },
```

Add a scorer that proves the baseline reached `computeNavlog` on this case:

```ts
    custom(
      (run, testCase) => {
        if (testCase.input !== BASELINE_INPUT) return 1
        const parsed = navlogSchema.safeParse(navlogResult(run))
        return parsed.success && parsed.data.flightPlan.item7 === "N734ST" ? 1 : 0
      },
      { name: "baseline-aircraft", threshold: 1 },
    ),
```

If the existing `navlogSchema.flightPlan.item7` isn't the tail (check `src/lib/navlog.ts`'s
`flightPlan` construction around line 261), assert on the field that carries `tailNumber`.

- [ ] **Step 4: Run the eval in replay**

Run: `pnpm --dir examples/navlog/server eval`
Expected: all 4 cases pass every scorer, including `baseline-aircraft` and `cites-poh`. The baseline
case's Assumptions line contains no workspace path, so `no-echoes-or-paths` stays green.

- [ ] **Step 5: Commit**

```bash
git add examples/navlog/server/src/app/navlog/evals/navlog-quality.eval.ts
git commit -m "test(navlog): the eval reads the baseline and covers a plan on N734ST

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Mirror everything into the scaffold template

**Files** (all under `packages/devkit/templates/app-navlog/server/`):
- Create: `src/lib/read-only-paths.ts`, `test/read-only-paths.test.ts.template`,
  `test/workspace-guard.test.ts.template`, `workspace/aircraft/c172n.md`
- Modify: `b4.config.ts`, `package.json.template`, `src/tools/readDoc.ts`,
  `src/app/navlog/index.ts`, `src/app/navlog/memory.md`, `src/app/navlog/plan.md`,
  `workspace/AGENTS.md`, `test/read-doc.test.ts.template`, `test/corpus-sync.test.ts.template`,
  `src/app/navlog/evals/navlog-quality.eval.ts.template`

- [ ] **Step 1: Copy the identical files**

These template files are byte-identical to the example today. Verify that before overwriting:

```bash
E=examples/navlog/server; T=packages/devkit/templates/app-navlog/server
for f in b4.config.ts src/tools/readDoc.ts src/app/navlog/index.ts src/app/navlog/memory.md src/app/navlog/plan.md workspace/AGENTS.md; do git diff --quiet origin/main -- $T/$f && git show origin/main:$E/$f | cmp -s - $T/$f && echo "identical on main: $f"; done
mkdir -p $T/workspace/aircraft
for f in b4.config.ts src/lib/read-only-paths.ts src/tools/readDoc.ts src/app/navlog/index.ts src/app/navlog/memory.md src/app/navlog/plan.md workspace/AGENTS.md workspace/aircraft/c172n.md; do cp $E/$f $T/$f; done
for f in read-only-paths read-doc corpus-sync workspace-guard; do cp $E/test/$f.test.ts $T/test/$f.test.ts.template; done
cp $E/src/app/navlog/evals/navlog-quality.eval.ts $T/src/app/navlog/evals/navlog-quality.eval.ts.template
```

Expected: six "identical on main" lines. If one isn't printed, diff that file and port the change
by hand instead of copying.

- [ ] **Step 2: Add the dependency to `package.json.template`**

After `"@b4run/sdk": "{{b4SdkSpecifier}}",`:

```json
    "@b4run/workspace": "{{b4WorkspaceSpecifier}}",
```

`b4WorkspaceSpecifier` is already defined in `packages/create-b4-app/src/index.ts:272,300,321`.

- [ ] **Step 3: Check how the template's tests are rendered**

```bash
grep -rn "\.test\.ts\.template\|\.template\"" packages/create-b4-app/src/index.ts packages/devkit/src | head
```

Confirm `.template` files are renamed by dropping the suffix. Then check whether any `{{…}}`
substitution would touch the copied tests: `grep -n "{{" $T/test/*.template` should print nothing.

- [ ] **Step 4: Run the devkit and create-b4-app tests**

```bash
pnpm --filter @b4run/devkit test && pnpm --filter create-b4-app test
```
Expected: PASS. If a template snapshot or file-list test fails, update it to include
`src/lib/read-only-paths.ts`, `workspace/aircraft/c172n.md` and the two new test templates.

- [ ] **Step 5: Commit**

```bash
git add packages/devkit/templates/app-navlog/server
git commit -m "feat(devkit): the navlog template ships the aircraft baseline and the read-only corpus

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Generated-app activation pins

**Files:**
- Modify: `test/generated/run-generated-navlog-activation.test.ts:154,189,854`

- [ ] **Step 1: Update the three pinned strings**

- Line 154: change the todo `content` to
  `"Read the aircraft baseline, recall the pilot's overrides, and parse the route, altitude and departure time"`.
- Line 189: `.callsTool("recall", { query: "pilot aircraft overrides and preferences" })`.
- Line 854: `label: "Recalling “pilot aircraft overrides and preferences”",`.

Don't add a `readDoc` step to this script. It's a framework activation test, and its scripted tool
order needn't follow the prompt. A new root call would shift every positional `call_*` id it
asserts (`call_task_0_2`).

- [ ] **Step 2: Run the lane locally if feasible**

```bash
pnpm build && pnpm vitest run test/generated/run-generated-navlog-activation.test.ts
```
Expected: PASS. If the lane needs CI-only infrastructure (a packed registry or a browser), note
that it runs in `harness-verify` and move on.

- [ ] **Step 3: Commit**

```bash
git add test/generated/run-generated-navlog-activation.test.ts
git commit -m "test(generated): navlog activation pins the new recall query and first todo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs and the lastmod manifest

**Files:**
- Modify: `apps/web/content/docs/recipes/flight-planner.mdx:45,61,143-152`
- Modify: `apps/web/content/docs/workspace.mdx:225-240`
- Modify: `apps/web/app/seo/lastmod.generated.json` (regenerated)

- [ ] **Step 1: `flight-planner.mdx`**

- Line 45: replace the step-1 line with the exact new step 1 from Task 5 Step 1.
- Line 61: apply the exact Assumptions change from Task 5 Step 2.
- In the file tree (around line 143), after the `readDoc.ts` line, change its comment to
  `# reads the aircraft baseline, a POH table or a regulation excerpt`. Under `server/src/lib/`,
  add the line `read-only-paths.ts             # keeps the reference corpus read-only`
  (align with the neighbouring comments). Under `server/workspace/`, add
  `aircraft/                     # the demo aircraft baseline, N734ST`.
- After the bullet `- \`workspace/AGENTS.md\` and the route's \`memory.md\` add persistent prompt guidance.`, add:

```markdown
- `workspace/aircraft/c172n.md` is the demo aircraft the plan starts from. A pilot's own facts, held in memory, override it, and what the pilot says in the request overrides both.
- `b4.config.ts` wraps the workspace filesystem with `readOnlyPaths`, so `AGENTS.md`, `aircraft/`, `poh/` and `regs/` can't be rewritten by the agent. Every visitor's turns share one workspace directory, and B4.run's [path gate](/docs/permissions) covers only paths outside it.
```

- [ ] **Step 2: `workspace.mdx`**

In the navlog tree (line ~225), add after `AGENTS.md`:

```text
  aircraft/          ← the demo aircraft baseline the agent reads
```

and after the bullet list that ends `- The route denies \`runBash\`, so the agent never runs a shell command.`, add:

```markdown
- `b4.config.ts` wraps the local filesystem with a [middleware](#middleware) that refuses writes to `AGENTS.md`, `aircraft/`, `poh/` and `regs/`. The workspace is shared by every thread, so the reference corpus stays read-only.
```

- [ ] **Step 3: Check the docs**

```bash
node scripts/check-docs.mjs
```
Expected: clean. If a banned phrase or pin trips, reword. Don't edit the pin.

- [ ] **Step 4: Commit the content, then regenerate lastmod**

```bash
git add apps/web/content/docs/recipes/flight-planner.mdx apps/web/content/docs/workspace.mdx
git commit -m "docs: navlog's aircraft baseline and read-only reference corpus

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod
pnpm --dir apps/web seo:lastmod:routes
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate the SEO lastmod manifest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Expected: only the two docs routes' entries change, and `seo:lastmod:routes` passes.

---

### Task 10: Changeset, spec correction, follow-up draft

**Files:**
- Create: `.changeset/navlog-aircraft-baseline.md`
- Modify: `docs/superpowers/specs/2026-10-07-navlog-aircraft-baseline-design.md` §5

- [ ] **Step 1: Changeset**

`.changeset/navlog-aircraft-baseline.md`:

```markdown
---
"@b4run/devkit": patch
---

The navlog template plans from a demo aircraft baseline, `workspace/aircraft/c172n.md` (N734ST, 50 gal usable, 2400 RPM), which the agent reads with `readDoc` alongside `recall`; a recalled fact overrides it and the pilot's request overrides both. Its `b4.config.ts` wraps the workspace filesystem with a `readOnlyPaths` middleware, so the agent can no longer rewrite `AGENTS.md`, `aircraft/`, `poh/` or `regs/`, which every thread shares. The template now depends on `@b4run/workspace`.
```

Run: `node scripts/check-changesets.mjs`
Expected: passes.

- [ ] **Step 2: Correct the spec's §5 table to what was built**

In `docs/superpowers/specs/2026-10-07-navlog-aircraft-baseline-design.md` §5:
- Replace the eval row's "non-teach scenarios script `tailNumber: "N734ST"`" with: "every
  existing case names N738ZU in its input and keeps it; a new case, *plan on the baseline
  aircraft*, names no aircraft and asserts `computeNavlog` ran on N734ST".
- Replace the web-tests row with: "unchanged: they feed the old recall text to a sanitizer as
  arbitrary echoed text".
- Change the activation-test row to "the pinned recall query, first todo and step label; no
  `readDoc` step, because a new root call would shift its positional call ids".

- [ ] **Step 3: Draft the framework follow-up, but don't file it**

Write the draft to the PR description under "Follow-ups". **Ask Brian before running
`gh issue create`.**

> **agents-md: an app can't turn off the "update AGENTS.md with writeFile" instruction.**
> `packages/core/src/capabilities/built-in/agents-md.ts:7` always tells the model it may
> `writeFile({ path: "AGENTS.md" })`. navlog now refuses that write (a read-only reference
> corpus, PR #972), so the instruction invites a failing tool call. Proposal: an
> `agentsMd: { writable: false }` config, or detect a refusing backend, so the injected header
> drops the write sentence.

- [ ] **Step 4: Commit**

```bash
git add .changeset/navlog-aircraft-baseline.md docs/superpowers/specs/2026-10-07-navlog-aircraft-baseline-design.md
git commit -m "chore: changeset and spec corrections for the navlog aircraft baseline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Verify and push

- [ ] **Step 1: The gates that cover this change**

```bash
pnpm lint
pnpm build
pnpm typecheck
pnpm --dir examples/navlog/server test
pnpm --dir examples/navlog/server eval
pnpm --filter @b4run/devkit test
pnpm --filter create-b4-app test
node scripts/check-docs.mjs
pnpm --dir apps/web seo:lastmod:routes
```
Expected: all green. Report any failure with its output; don't paper over it.

- [ ] **Step 2: Full local validation, if time allows**

Run: `pnpm ci:validate`
Expected: green. A known load flake (see the timing-flake notes) gets re-run once, alone, before
it's called a flake.

- [ ] **Step 3: Rebase on fresh main and push**

```bash
git fetch -q origin main && git rebase origin/main
pnpm install --frozen-lockfile
git push --force-with-lease
```
The lockfile changed, so re-fetch main right before pushing. A stale lockfile fails Install and
reds every job.

- [ ] **Step 4: Update the PR**

Mark cacheplane/b4run#972 ready for review only when Brian asks. Update its body with what
shipped, the test evidence, and the Follow-ups draft. Then read CI through the PR status tool.
