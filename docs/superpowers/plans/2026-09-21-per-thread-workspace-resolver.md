# Per-thread workspace resolver: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `sandbox.workspace` in `b4.config.ts` may be a host function that decides one thread's initial workspace at first admission, from the thread's id and client metadata, so one running app can serve threads with different captured sources.

**Architecture:** The storage layer already records one `WorkspaceCreateIntent` with its own `sourceDigest` per thread; `ManagedWorkspaceManager.getForThread` already has a zero-argument `captureDefinition` hook it calls when a thread has no record. This plan gives that hook the thread, threads the thread's stored metadata from the runtime into it, teaches the build artifact to record "resolver" instead of a captured definition, and documents the new form. Nothing about admission, provenance, reading, deletion or reconciliation changes: a thread's definition is still fixed at creation and addressed by digest afterwards.

**Tech Stack:** TypeScript, vitest, `@b4run/workspace`, `@b4run/cli`, `@b4run/sqlite-storage`, changesets, the docs checker (`node scripts/check-docs.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md` §5. One amendment made by this plan: the artifact's resolver form is `{ version: 2, kind: "resolver" }` rather than a digest of the string `"resolver"` (Task 4 records it in the spec).

**Standing rules:** `nvm use 24` before any test run. Never bare `git stash`; never bare `biome check --write` at the repo root. Run package scripts with `pnpm --filter <pkg> <script>`. Commit after every task; the package suite must be green at every commit. All paths below are relative to the repository root.

---

## File map

| File | Change |
|---|---|
| `packages/workspace/src/sandbox-types.ts` | Add `WorkspaceResolverInput`, `WorkspaceResolver`; widen `SandboxConfig.workspace` |
| `packages/workspace/src/index.ts` | Export the two new types |
| `examples/software-factory/server/test/builder-config.test.ts` | Narrow `sandbox.workspace` to the static form before reading `.source` (the one reader outside `@b4run/cli`) |
| `packages/cli/src/lib/runtime/managed-workspace-manager.ts` | `definition` optional; `captureDefinition(thread)`; `getForThread(threadId, signal, context?)` |
| `packages/cli/src/lib/runtime/sandbox-manager.ts` | Pass `context` through |
| `packages/cli/src/lib/build/workspace-artifact.ts` | Resolver artifact form; `verifyWorkspaceResolverArtifact` |
| `packages/cli/src/lib/runtime/resolve-sandbox.ts` | Build the manager from a resolver in dev and built modes |
| `packages/cli/src/lib/runtime/collect-sandbox-errors.ts` | Validate a resolver config without capturing |
| `packages/cli/src/commands/check.ts` | Report the per-thread form |
| `packages/cli/src/lib/runtime/execute-route-core.ts` | Load the thread's metadata lazily and pass it to admission |
| `packages/cli/test/managed-workspace-manager.test.ts` | Resolver semantics |
| `packages/cli/test/workspace-build-artifact.test.ts` | Artifact forms |
| `packages/cli/test/resolve-sandbox.test.ts` | Dev and built resolution |
| `packages/cli/test/collect-sandbox-errors.test.ts` | Resolver config validation |
| `packages/cli/test/managed-workspace-runtime.test.ts` | End to end through the Agent Protocol, dev and built |
| `apps/web/content/docs/api/workspace.mdx` | Contract block, fields table, exports table, lifecycle paragraph |
| `apps/web/content/docs/sandbox.mdx` | A "Per-thread workspaces" subsection |
| `apps/web/content/seo/lastmod.generated.json` | Regenerated |
| `.changeset/workspace-resolver.md` | `@b4run/workspace` minor, `@b4run/cli` minor |

---

### Task 1: The resolver type in `@b4run/workspace`

**Files:**
- Modify: `packages/workspace/src/sandbox-types.ts:152-161`
- Modify: `packages/workspace/src/index.ts:25-35`

- [ ] **Step 1: Write the failing type test**

Create `packages/workspace/test/workspace-resolver.test.ts` (sibling tests import from `../src/index.ts`, not the package name, so the test compiles against source rather than a stale `dist`):

```ts
import { expect, expectTypeOf, it } from "vitest"
import type {
  CapturedWorkspaceDefinition,
  SandboxConfig,
  WorkspaceDefinition,
  WorkspaceResolver,
  WorkspaceResolverInput,
} from "../src/index.ts"
import { createSourceBundle } from "../src/node.ts"

it("SandboxConfig.workspace is a definition, a resolver, or absent", async () => {
  expectTypeOf<SandboxConfig["workspace"]>().toEqualTypeOf<
    WorkspaceDefinition | WorkspaceResolver | undefined
  >()
  const definition: WorkspaceDefinition = { source: { directory: ".", include: ["a"] } }
  const captured: CapturedWorkspaceDefinition = {
    version: 1,
    source: createSourceBundle([]),
    environmentLinks: [],
  }
  const resolver: WorkspaceResolver = async (thread: WorkspaceResolverInput) => {
    expectTypeOf(thread.metadata).toEqualTypeOf<Readonly<Record<string, unknown>>>()
    expectTypeOf(thread.signal).toEqualTypeOf<AbortSignal>()
    return thread.metadata.kind === "captured" ? captured : definition
  }
  const withDefinition: Pick<SandboxConfig, "workspace"> = { workspace: definition }
  const withResolver: Pick<SandboxConfig, "workspace"> = { workspace: resolver }
  // @ts-expect-error a resolver must be a function or a definition, never a bare value
  const rejected: Pick<SandboxConfig, "workspace"> = { workspace: 42 }
  expect(rejected.workspace).toBe(42)
  expect(withDefinition.workspace).toBe(definition)
  const signal = new AbortController().signal
  expect(await resolver({ threadId: "t1", metadata: {}, signal })).toBe(definition)
  expect(await resolver({ threadId: "t1", metadata: { kind: "captured" }, signal })).toBe(captured)
  expect(typeof withResolver.workspace).toBe("function")
})
```

Also narrow the one reader outside `@b4run/cli`, `examples/software-factory/server/test/builder-config.test.ts:11`, which reads `config.sandbox?.workspace?.source.directory`:

```ts
const workspace = config.sandbox?.workspace
if (typeof workspace === "function") throw new Error("builder config must declare a static workspace")
```

and read `workspace?.source.directory` where the old expression was.

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @b4run/workspace typecheck
```

Expected: errors that `WorkspaceResolver` and `WorkspaceResolverInput` are not exported and that a function is not assignable to `WorkspaceDefinition | undefined`.

- [ ] **Step 3: Add the types**

In `packages/workspace/src/sandbox-types.ts`, replace the `SandboxConfig` interface with:

```ts
/**
 * What a {@link WorkspaceResolver} is told about the thread it is deciding for.
 * `metadata` is the client-supplied thread metadata as stored, with B4.run's
 * reserved key stripped. It is client input: a resolver validates it and
 * decides from it, it never trusts it.
 */
export interface WorkspaceResolverInput {
  readonly threadId: string
  readonly metadata: Readonly<Record<string, unknown>>
  /** Aborted when the admitting run is cancelled. Pass it to any I/O the resolver does. */
  readonly signal: AbortSignal
}

/**
 * Host code that decides one thread's initial workspace. Called once per
 * thread, at the thread's first admission, never again: the result is
 * captured, recorded by digest in the thread's creation intent, and every
 * later turn of that thread reads the record. A subagent runs under its
 * parent's thread and resolves through the parent's record, so a resolver
 * never sees a subagent's thread id. A returned `WorkspaceDefinition` is
 * captured from the app root at that moment; a returned
 * `CapturedWorkspaceDefinition` is verified and used as is.
 */
export type WorkspaceResolver = (
  thread: WorkspaceResolverInput,
) => Promise<WorkspaceDefinition | CapturedWorkspaceDefinition>

export interface SandboxConfig {
  /**
   * The initial managed workspace: one definition for every thread, or a
   * {@link WorkspaceResolver} that decides per thread. `b4 build` captures a
   * definition into the build artifact; a resolver is captured at run time
   * and the artifact records only that a resolver is configured.
   */
  readonly workspace?: WorkspaceDefinition | WorkspaceResolver
  readonly provider: SandboxProvider
  readonly network?: SandboxPolicy["network"]
  readonly env?: SandboxPolicy["env"]
  readonly resources?: SandboxPolicy["resources"]
  readonly security?: SandboxSecurityPolicy
  /** Manager-level idle reap window. Default 600_000 (10 min). */
  readonly idleTimeoutMs?: number
}
```

`CapturedWorkspaceDefinition` and `WorkspaceDefinition` are already imported in that file from `./managed-workspace.js`; confirm with `grep -n "managed-workspace" packages/workspace/src/sandbox-types.ts` and add them to the import if absent.

In `packages/workspace/src/index.ts`, extend the `sandbox-types.js` type export block:

```ts
export type {
  OpenWorkspaceReaderInput,
  ReadOnlyFilesystemBackend,
  SandboxConfig,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
  SandboxSecurityPolicy,
  SandboxWorkspaceReader,
  WorkspaceReadSource,
  WorkspaceResolver,
  WorkspaceResolverInput,
} from "./sandbox-types.js"
```

- [ ] **Step 4: Verify**

```bash
pnpm --filter @b4run/workspace typecheck && pnpm --filter @b4run/workspace test && pnpm --filter @b4run/workspace lint
```

Expected: all pass. Then confirm downstream still compiles before the CLI changes:

```bash
pnpm --filter @b4run/workspace build && pnpm --filter @b4run/cli typecheck
```

Expected: `@b4run/cli` typecheck FAILS in `resolve-sandbox.ts`, `collect-sandbox-errors.ts` and `build.ts`, because those pass `sandbox.workspace` to `captureWorkspaceDefinition`, which takes a `WorkspaceDefinition`. That is the work of Tasks 3 to 5. **Also expected red until later tasks:** `node scripts/check-docs.mjs` (the `SandboxConfig` contract block and the undocumented exports, fixed in Task 7). If the CLI typecheck shows errors in OTHER files (missing exports from `@b4run/sdk` or `@b4run/langchain`), that is stale `dist` in the worktree: run `pnpm turbo run build --filter='@b4run/cli^...' --output-logs=errors-only` once and re-run the typecheck. Commit Task 1 with the workspace package, its test and the example test narrowed, and complete Tasks 2 to 5 before the next `pnpm typecheck` at the root.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace/src/sandbox-types.ts packages/workspace/src/index.ts packages/workspace/test/workspace-resolver.test.ts examples/software-factory/server/test/builder-config.test.ts
git commit -m "feat(workspace): SandboxConfig.workspace accepts a per-thread resolver

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `ManagedWorkspaceManager` resolves per thread

**Files:**
- Modify: `packages/cli/src/lib/runtime/managed-workspace-manager.ts:21-53, 89-113`
- Modify: `packages/cli/src/lib/runtime/sandbox-manager.ts:41-42`
- Test: `packages/cli/test/managed-workspace-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/managed-workspace-manager.test.ts`. The file's `fixture()` builds a manager with a static `definition`; these tests need one built with a resolver, so add a second helper next to `fixture` (reuse its provider by calling `fixture()` and constructing a second manager over the same installation is NOT possible: the installation is locked to one manager, so the helper builds its own):

```ts
function resolverFixture(
  captureDefinition: (thread: {
    readonly threadId: string
    readonly metadata: Readonly<Record<string, unknown>>
    readonly signal: AbortSignal
  }) => Promise<CapturedWorkspaceDefinition>,
) {
  const base = fixture()
  // fixture() already registered its manager for cleanup; release it and build
  // a resolver-driven manager over a fresh installation in the same root.
  const root = mkdtempSync(join(tmpdir(), "b4-managed-resolver-"))
  roots.push(root)
  const installation = openWorkspaceInstallation(root)
  const manager = new ManagedWorkspaceManager({
    installation,
    provider: base.provider,
    policy: { network: { mode: "deny" } },
    idleTimeoutMs: 0,
    captureDefinition,
  })
  managers.push(manager)
  return { manager, installation, calls: base.calls }
}

function bundle(text: string) {
  return createSourceBundle([
    { path: "main.ts", bytes: new TextEncoder().encode(text), executable: false },
  ])
}

it("calls the resolver once per thread, at first admission only", async () => {
  const seen: string[] = []
  const { manager } = resolverFixture(async (thread) => {
    seen.push(`${thread.threadId}:${String(thread.metadata.task)}`)
    return { version: 1, source: bundle(String(thread.metadata.task)), environmentLinks: [] }
  })
  const signal = new AbortController().signal
  await manager.getForThread("one", signal, { metadata: async () => ({ task: "alpha" }) })
  await manager.getForThread("one", signal, { metadata: async () => ({ task: "changed" }) })
  const handle = await manager.getForThread("one", signal)
  await handle.filesystem.readFile("main.ts", { signal })
  expect(seen).toEqual(["one:alpha"])
  expect(new TextDecoder().decode(manager.getWorkspace("one")?.readInitialFile("main.ts"))).toBe("alpha")
})

it("gives two threads different sources from their own metadata", async () => {
  const { manager, installation } = resolverFixture(async (thread) => ({
    version: 1,
    source: bundle(String(thread.metadata.task)),
    environmentLinks: [],
  }))
  const signal = new AbortController().signal
  await manager.getForThread("one", signal, { metadata: async () => ({ task: "alpha" }) })
  await manager.getForThread("two", signal, { metadata: async () => ({ task: "beta" }) })
  const one = installation.associations.get("one")!.intent.sourceDigest
  const two = installation.associations.get("two")!.intent.sourceDigest
  expect(one).not.toBe(two)
  expect(new TextDecoder().decode(manager.getWorkspace("two")?.readInitialFile("main.ts"))).toBe("beta")
})

it("hands the resolver the admission signal", async () => {
  const controller = new AbortController()
  const seen: AbortSignal[] = []
  const { manager } = resolverFixture(async (thread) => {
    seen.push(thread.signal)
    return { version: 1, source: bundle("x"), environmentLinks: [] }
  })
  await manager.getForThread("one", controller.signal)
  expect(seen).toEqual([controller.signal])
})

it("passes an empty metadata object when the runtime has none", async () => {
  const seen: unknown[] = []
  const { manager } = resolverFixture(async (thread) => {
    seen.push(thread.metadata)
    return { version: 1, source: bundle("x"), environmentLinks: [] }
  })
  await manager.getForThread("one", new AbortController().signal)
  expect(seen).toEqual([{}])
})

it("leaves no association and calls no provider when the resolver throws", async () => {
  const { manager, installation, calls } = resolverFixture(async () => {
    throw new Error("no task for this thread")
  })
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toThrow(
    /no task for this thread/,
  )
  expect(installation.associations.get("one")).toBeUndefined()
  expect(calls).not.toContain("create")
})

it("rejects a resolver result that is not a captured definition before any provider call", async () => {
  const { manager, installation, calls } = resolverFixture(
    async () => ({ version: 1, source: bundle("x") }) as never,
  )
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toThrow()
  expect(installation.associations.get("one")).toBeUndefined()
  expect(calls).not.toContain("create")
})

it("refuses to construct with neither a definition nor a resolver", () => {
  const root = mkdtempSync(join(tmpdir(), "b4-managed-none-"))
  roots.push(root)
  const installation = openWorkspaceInstallation(root)
  const { provider } = fixture()
  expect(
    () =>
      new ManagedWorkspaceManager({
        installation,
        provider,
        policy: { network: { mode: "deny" } },
        idleTimeoutMs: 0,
      }),
  ).toThrow(/definition or a resolver/i)
  installation.close()
})
```

Add `CapturedWorkspaceDefinition` to the `@b4run/workspace` type import at the top of the file.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-manager.test.ts
```

Expected: typecheck-level failures in vitest (`definition` is required; `getForThread` takes 2 arguments; `captureDefinition` takes 0 arguments), or a thrown "Cannot read properties of undefined" from the constructor.

- [ ] **Step 3: Implement**

In `packages/cli/src/lib/runtime/managed-workspace-manager.ts`, replace the options interface and constructor:

```ts
/** What admission tells the resolver about the thread. Metadata is loaded lazily: only a thread with no record needs it. */
export interface WorkspaceAdmissionContext {
  /** Loads the thread's stored client metadata. Called only for a thread with no workspace record. */
  readonly metadata?: (signal: AbortSignal) => Promise<Readonly<Record<string, unknown>>>
}

export interface ManagedWorkspaceManagerOptions {
  installation: WorkspaceInstallation
  /** One definition for every thread. Omit when `captureDefinition` decides per thread. */
  definition?: CapturedWorkspaceDefinition
  provider: ManagedWorkspaceProvider
  policy: SandboxPolicy
  idleTimeoutMs: number
  clock?: () => number
  /**
   * Called once per thread, at first admission, to produce that thread's
   * definition. With `definition` also set, this wins and `definition` is NOT
   * a fallback: a resolver that returns nothing is an error, never a silent
   * switch to the app-root capture (development mode recaptures the static
   * definition through this hook). Without `definition`, it is required.
   */
  captureDefinition?: (thread: {
    readonly threadId: string
    readonly metadata: Readonly<Record<string, unknown>>
    readonly signal: AbortSignal
  }) => Promise<CapturedWorkspaceDefinition>
}
```

```ts
  readonly #definition: CapturedWorkspaceDefinition | undefined
  ...
  constructor(options: ManagedWorkspaceManagerOptions) {
    this.#options = options
    if (!options.definition && !options.captureDefinition)
      throw new Error("Managed workspaces need a definition or a resolver")
    this.#definition = options.definition
      ? verifyCapturedWorkspaceDefinition(options.definition)
      : undefined
    if (this.#definition) options.installation.sources.put(this.#definition.source)
  }
```

Replace the signature and the `if (!record)` block of `getForThread`:

```ts
  async getForThread(
    threadId: string,
    signal: AbortSignal,
    context: WorkspaceAdmissionContext = {},
  ): Promise<SandboxHandle> {
    this.#assertOpen()
    const release = this.retain(threadId)
    return this.#serial(threadId, async () => {
      signal.throwIfAborted()
      const { installation, provider, policy } = this.#options
      let record = installation.associations.get(threadId)
      if (record && record.intent.installationId !== installation.installationId)
        throw new WorkspaceLifecycleError("conflict", "Workspace installation identity mismatch")
      if (record?.state === "deleting" || record?.state === "deleted")
        throw new WorkspaceLifecycleError("lost", "Workspace is deleting or deleted")
      if (!record) {
        // The resolver runs exactly here: a thread with no record. Every later
        // admission of this thread finds the record and never reaches this branch.
        let resolved: CapturedWorkspaceDefinition | undefined = this.#definition
        if (this.#options.captureDefinition) {
          const raw: unknown = await context.metadata?.(signal)
          const metadata: Readonly<Record<string, unknown>> =
            raw !== null && typeof raw === "object" && !Array.isArray(raw)
              ? (raw as Readonly<Record<string, unknown>>)
              : {}
          resolved = await this.#options.captureDefinition({ threadId, metadata, signal })
          // An admission aborted during the resolver must not leave an orphan source row.
          signal.throwIfAborted()
        }
        if (!resolved)
          throw new Error(
            this.#options.captureDefinition
              ? "The workspace resolver returned no workspace definition"
              : "Managed workspaces need a definition or a resolver",
          )
        const definition = verifyCapturedWorkspaceDefinition(resolved)
        installation.sources.put(definition.source)
        const environment = await provider.resolveEnvironment(signal)
        signal.throwIfAborted()
        record = installation.associations.create(
          createWorkspaceIntent({
            installationId: installation.installationId,
            operationId: randomUUID(),
            threadId,
            definition,
            environment,
          }),
        )
      }
```

The rest of the method is unchanged. The proxy in `#handle` calls `this.getForThread(threadId, context.signal)` for re-admission with no context; that is correct, because a re-admitted thread has a record.

In `packages/cli/src/lib/runtime/sandbox-manager.ts`, change `getForThread`:

```ts
  async getForThread(
    threadId: string,
    signal: AbortSignal,
    context?: WorkspaceAdmissionContext,
  ): Promise<SandboxHandle> {
    if (this.#managed) return this.#managed.getForThread(threadId, signal, context)
```

and import the type: `import { ManagedWorkspaceManager, type WorkspaceAdmissionContext } from "./managed-workspace-manager.js"` (adjust to the file's existing import line for the manager).

- [ ] **Step 4: Run the manager tests and the whole CLI suite**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-manager.test.ts test/sandbox-manager.test.ts test/with-workspace.test.ts
```

Expected: PASS, including every pre-existing test (the static `definition` path is untouched).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/managed-workspace-manager.ts packages/cli/src/lib/runtime/sandbox-manager.ts packages/cli/test/managed-workspace-manager.test.ts
git commit -m "feat(cli): managed workspace admission resolves a definition per thread

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The build artifact records a resolver

**Files:**
- Modify: `packages/cli/src/lib/build/workspace-artifact.ts`
- Test: `packages/cli/test/workspace-build-artifact.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/workspace-build-artifact.test.ts`:

```ts
import { verifyWorkspaceResolverArtifact } from "../src/lib/build/workspace-artifact.ts"

it("records a resolver as a resolver, with no captured source", async () => {
  const root = await mkdtemp(join(tmpdir(), "b4-workspace-build-"))
  roots.push(root)
  const resolver = async () => ({ source: { directory: ".", include: ["a"] } })
  const artifact = await captureWorkspaceArtifact(root, resolver)
  expect(artifact).toEqual({ version: 2, kind: "resolver" })
  expect(() => verifyWorkspaceResolverArtifact(JSON.parse(JSON.stringify(artifact)))).not.toThrow()
})

it("refuses to boot a static artifact under a resolver config, and the reverse", async () => {
  const root = await mkdtemp(join(tmpdir(), "b4-workspace-build-"))
  roots.push(root)
  await writeFile(join(root, "a"), "a")
  const definition = { source: { directory: ".", include: ["a"] } }
  const staticArtifact = await captureWorkspaceArtifact(root, definition)
  const resolverArtifact = await captureWorkspaceArtifact(root, async () => definition)
  expect(() => verifyWorkspaceResolverArtifact(staticArtifact)).toThrow(/rebuild/i)
  expect(() => verifyWorkspaceArtifact(resolverArtifact, definition)).toThrow(/rebuild/i)
  expect(() => verifyWorkspaceResolverArtifact(null)).toThrow(/rebuild/i)
  expect(() => verifyWorkspaceResolverArtifact({ version: 2, kind: "other" })).toThrow(/rebuild/i)
})
```

Move the new `import` to the top of the file with the existing import from `workspace-artifact.ts`.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/workspace-build-artifact.test.ts
```

Expected: FAIL, `verifyWorkspaceResolverArtifact` is not exported; `captureWorkspaceArtifact` throws on a function.

- [ ] **Step 3: Implement**

In `packages/cli/src/lib/build/workspace-artifact.ts`, replace the interface and the two exported functions (keep `descriptorDigest` as is):

```ts
import type {
  CapturedWorkspaceDefinition,
  WorkspaceDefinition,
  WorkspaceResolver,
} from "@b4run/workspace"

/** A static definition, captured at build time. Version 1 is unchanged so existing builds keep booting. */
export interface CapturedWorkspaceBuildArtifact {
  readonly version: 1
  readonly descriptorDigest: string
  readonly workspace: CapturedWorkspaceDefinition
}
/** A resolver: nothing to capture at build time. Boot verifies the config is still a resolver. */
export interface ResolverWorkspaceBuildArtifact {
  readonly version: 2
  readonly kind: "resolver"
}
export type WorkspaceBuildArtifact = CapturedWorkspaceBuildArtifact | ResolverWorkspaceBuildArtifact

export async function captureWorkspaceArtifact(
  appRoot: string,
  workspace: WorkspaceDefinition | WorkspaceResolver,
): Promise<WorkspaceBuildArtifact> {
  if (typeof workspace === "function") return Object.freeze({ version: 2, kind: "resolver" })
  const digest = descriptorDigest(workspace)
  const captured = await captureWorkspaceDefinition(appRoot, workspace)
  return Object.freeze({ version: 1, descriptorDigest: digest, workspace: captured })
}

/** Verify a static artifact against a static definition. A resolver artifact here means the config changed form. */
export function verifyWorkspaceArtifact(
  value: unknown,
  definition: WorkspaceDefinition,
): CapturedWorkspaceDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workspace build artifact; rebuild the app")
  const record = value as Record<string, unknown>
  if (record.version === 2)
    throw new Error("Workspace configuration changed; rebuild the app")
  if (
    Object.keys(record).sort().join(",") !== "descriptorDigest,version,workspace" ||
    record.version !== 1
  )
    throw new Error("Invalid workspace build artifact; rebuild the app")
  if (record.descriptorDigest !== descriptorDigest(definition))
    throw new Error("Workspace configuration changed; rebuild the app")
  return verifyCapturedWorkspaceDefinition(record.workspace)
}

/** Verify a resolver artifact. A static artifact here means the config changed form. */
export function verifyWorkspaceResolverArtifact(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workspace build artifact; rebuild the app")
  const record = value as Record<string, unknown>
  if (record.version === 1)
    throw new Error("Workspace configuration changed; rebuild the app")
  if (
    Object.keys(record).sort().join(",") !== "kind,version" ||
    record.version !== 2 ||
    record.kind !== "resolver"
  )
    throw new Error("Invalid workspace build artifact; rebuild the app")
}
```

`packages/cli/src/commands/build.ts:101` already passes `config.sandbox.workspace` and now typechecks against the union. No change there.

- [ ] **Step 4: Run**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/workspace-build-artifact.test.ts
```

Expected: PASS, all four tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/build/workspace-artifact.ts packages/cli/test/workspace-build-artifact.test.ts
git commit -m "feat(cli): the workspace build artifact records a resolver configuration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Resolving the manager from a resolver config, dev and built

**Files:**
- Modify: `packages/cli/src/lib/runtime/resolve-sandbox.ts:33-56`
- Modify: `packages/cli/src/lib/runtime/collect-sandbox-errors.ts:28-40`
- Modify: `packages/cli/src/commands/check.ts:135-144`
- Modify: `docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md` §5.3 (the artifact form amendment)
- Test: `packages/cli/test/resolve-sandbox.test.ts`, `packages/cli/test/collect-sandbox-errors.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/resolve-sandbox.test.ts` inside the `describe`:

```ts
  test("builds a managed manager from a resolver in development mode", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "b4-sbx-cfg-"))
    await mkdir(join(appRoot, "workspace"), { recursive: true })
    await writeFile(
      join(appRoot, "b4.config.ts"),
      [
        `import { managedProviderFixture } from ${JSON.stringify(fixtureUrl)}`,
        `export default { sandbox: { provider: managedProviderFixture().provider, workspace: async () => ({ source: { directory: ".", include: ["b4.config.ts"] } }) } }`,
      ].join("\n"),
      "utf8",
    )
    const mgr = await resolveSandboxManager(appRoot)
    expect(mgr?.managed).toBeDefined()
    await mgr?.releaseAll()
  })

  test("refuses a built static artifact under a resolver config", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "b4-sbx-cfg-"))
    await mkdir(join(appRoot, "workspace"), { recursive: true })
    await writeFile(
      join(appRoot, "b4.config.ts"),
      [
        `import { managedProviderFixture } from ${JSON.stringify(fixtureUrl)}`,
        `export default { sandbox: { provider: managedProviderFixture().provider, workspace: async () => ({ source: { directory: ".", include: ["b4.config.ts"] } }) } }`,
      ].join("\n"),
      "utf8",
    )
    await expect(
      resolveSandboxManager(appRoot, {
        built: true,
        artifact: { version: 1, descriptorDigest: "0".repeat(64), workspace: {} },
      }),
    ).rejects.toThrow(/rebuild/i)
  })
```

Add `mkdir` to the `node:fs/promises` import, and above the `describe` add the fixture's URL so the on-disk config can import it (there is no managed fake in `@b4run/sandbox/testing`; `fakeSandbox()` has no `workspaces`):

```ts
const fixtureUrl = new URL("./support/managed-provider.ts", import.meta.url).href
```

The config loader compiles TypeScript imports, so a `file:` URL to the test support file resolves. `SandboxManager`'s shutdown method is `releaseAll()`.

Append to `packages/cli/test/collect-sandbox-errors.test.ts` (read its existing imports and fake-provider helper first and reuse them):

```ts
it("accepts a resolver without capturing anything at check time", async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-sbx-check-"))
  await mkdir(join(appRoot, "workspace"), { recursive: true })
  const provider = { ...fakeSandbox(), workspaces: {} as never }
  const result = await collectSandboxErrors(
    { sandbox: { provider, workspace: async () => ({ source: { directory: "missing", include: ["x"] } }) } },
    appRoot,
  )
  expect(result.errors).toEqual([])
})

it("still rejects a resolver on a provider without managed workspaces", async () => {
  const result = await collectSandboxErrors({
    sandbox: { provider: fakeSandbox(), workspace: async () => ({ source: { directory: ".", include: [] } }) },
  })
  expect(result.errors).toContain("Sandbox provider does not support managed workspaces")
})
```

The first test's `directory: "missing"` is the point: a static definition naming a missing directory fails `b4 check` today; a resolver's result cannot be checked until a thread exists, so check must not try.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/resolve-sandbox.test.ts test/collect-sandbox-errors.test.ts
```

Expected: FAIL. `resolve-sandbox` throws from `captureWorkspaceDefinition` on a function; `collect-sandbox-errors` reports "Invalid managed workspace".

- [ ] **Step 3: Implement `resolve-sandbox.ts`**

Replace the `if (sandbox.workspace) { ... }` block:

```ts
  let managed: ManagedWorkspaceManager | undefined
  const workspace = sandbox.workspace
  if (workspace) {
    if (!sandbox.provider.workspaces)
      throw new Error("Sandbox provider does not support managed workspaces")
    if (!(await stat(join(appRoot, "workspace"))).isDirectory())
      throw new Error("Managed workspaces require app-root workspace/ capability")
    const installation = openWorkspaceInstallation(appRoot)
    try {
      if (typeof workspace === "function") {
        // A resolver has nothing to capture at boot. In a built app the artifact
        // must say so, or the config changed form since the build.
        if (options.built) verifyWorkspaceResolverArtifact(options.artifact)
        managed = new ManagedWorkspaceManager({
          installation,
          captureDefinition: async (thread) => {
            const resolved = await workspace(thread)
            return "version" in resolved
              ? verifyCapturedWorkspaceDefinition(resolved)
              : await captureWorkspaceDefinition(appRoot, resolved)
          },
          provider: sandbox.provider.workspaces,
          policy,
          idleTimeoutMs: sandbox.idleTimeoutMs ?? DEFAULT_IDLE_MS,
        })
      } else {
        const definition = options.built
          ? verifyWorkspaceArtifact(options.artifact, workspace)
          : await captureWorkspaceDefinition(appRoot, workspace)
        managed = new ManagedWorkspaceManager({
          installation,
          definition,
          ...(!options.built
            ? { captureDefinition: () => captureWorkspaceDefinition(appRoot, workspace) }
            : {}),
          provider: sandbox.provider.workspaces,
          policy,
          idleTimeoutMs: sandbox.idleTimeoutMs ?? DEFAULT_IDLE_MS,
        })
      }
    } catch (error) {
      installation.close()
      throw error
    }
  }
```

Update imports: add `verifyWorkspaceResolverArtifact` from `../build/workspace-artifact.js` and `verifyCapturedWorkspaceDefinition` from `@b4run/workspace/node`.

- [ ] **Step 4: Implement `collect-sandbox-errors.ts`**

Replace the `if (sandbox.workspace) { ... }` block:

```ts
  if (sandbox.workspace) {
    if (!p.workspaces) errors.push("Sandbox provider does not support managed workspaces")
    if (appRoot) {
      try {
        if (!(await stat(join(appRoot, "workspace"))).isDirectory())
          throw new Error("workspace/ must be a directory")
        // A resolver's result exists only once a thread does; there is nothing to capture here.
        if (typeof sandbox.workspace !== "function")
          await captureWorkspaceDefinition(appRoot, sandbox.workspace)
      } catch (error) {
        errors.push(
          `Invalid managed workspace: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
```

- [ ] **Step 5: Report the form in `b4 check`**

In `packages/cli/src/commands/check.ts`, after the `for (const w of sandboxWarnings)` line:

```ts
    if (typeof loadedConfig?.sandbox?.workspace === "function")
      writeLine(io.stdout, "sandbox: managed workspace is resolved per thread")
```

`writeLine` and `io` are already in scope in that function (they are used a few lines above for the edge notice). If `loadedConfig` is typed such that `.sandbox` is not reachable, use the same expression `collectSandboxErrors` is called with.

- [ ] **Step 6: Amend the spec's §5.3**

In `docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md`, replace the fenced `WorkspaceBuildArtifact` block and the sentence after it with:

```markdown
```ts
type WorkspaceBuildArtifact =
  | { version: 1; descriptorDigest: string; workspace: CapturedWorkspaceDefinition }  // static, unchanged
  | { version: 2; kind: "resolver" }                                                  // nothing to capture
```

Boot verification is unchanged for the static form. For a resolver, boot verifies the artifact is
the resolver form and the loaded config is a function; the "configuration changed; rebuild"
error fires on a mismatch in either direction. A version-1 artifact is accepted for the static
form (no forced rebuild).

> **As landed:** the resolver form is a tagged version-2 record, not a digest of the string
> `"resolver"`, so the two forms cannot be confused by a digest collision on a constant.

Also amend §5.1's `WorkspaceResolver` block to add `readonly signal: AbortSignal` to the input
(aborted when the admitting run is cancelled; the resolver does I/O) and keep the return type
`Promise<...>` only, with a matching `> **As landed:**` note.
```

- [ ] **Step 7: Run**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/resolve-sandbox.test.ts test/collect-sandbox-errors.test.ts test/check-command.test.ts && pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli lint
```

Expected: PASS and clean. This is the first point since Task 1 where the CLI typechecks again.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/lib/runtime/resolve-sandbox.ts packages/cli/src/lib/runtime/collect-sandbox-errors.ts packages/cli/src/commands/check.ts packages/cli/test/resolve-sandbox.test.ts packages/cli/test/collect-sandbox-errors.test.ts docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md
git commit -m "feat(cli): boot a managed workspace from a per-thread resolver in dev and built apps

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The runtime hands the thread's metadata to admission

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route-core.ts:983-990`
- Test: `packages/cli/test/managed-workspace-runtime.test.ts`

- [ ] **Step 1: Write the failing end-to-end test**

Append to `packages/cli/test/managed-workspace-runtime.test.ts`. It reuses the file's `fixture()` and `run()` helpers; the resolver picks the initial file from thread metadata.

```ts
async function createThread(handler: RuntimeFetchHandler, id: string, metadata: Record<string, unknown>) {
  const response = await handler.fetch(
    new Request("http://localhost/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thread_id: id, metadata }),
    }),
  )
  expect(response.status).toBe(200)
}

it("resolves each thread's workspace from its own metadata, once, and keeps it across restart", async () => {
  const { appRoot, boot: bootStatic } = await fixture()
  await writeFile(join(appRoot, "source/alpha.txt"), "alpha")
  await writeFile(join(appRoot, "source/beta.txt"), "beta")
  const seen: string[] = []
  const physical = managedProviderFixture()
  const config = {
    sandbox: {
      provider: physical.provider,
      workspace: async (thread: { threadId: string; metadata: Record<string, unknown> }) => {
        seen.push(thread.threadId)
        const file = thread.metadata.task === "beta" ? "beta.txt" : "alpha.txt"
        return { source: { directory: "source", include: [file], files: [{ path: "main.txt", text: file }] } }
      },
    },
  }
  void bootStatic
  const boot = async () => {
    const handler = await createRuntimeFetchHandler({ appRoot, config })
    handlers.push(handler)
    return handler
  }
  const first = await boot()
  await createThread(first, "a", { task: "alpha" })
  await createThread(first, "b", { task: "beta" })
  expect((await run(first, "a")).body).toMatchObject({ source: "alpha.txt", current: "alpha.txt" })
  expect((await run(first, "b")).body).toMatchObject({ source: "beta.txt", current: "beta.txt" })
  await run(first, "a")
  expect(seen).toEqual(["a", "b"])
  await first.close()
  const restarted = await boot()
  expect((await run(restarted, "b")).body).toMatchObject({ source: "beta.txt" })
  expect(seen).toEqual(["a", "b"])
})

it("passes the stored metadata with the reserved key stripped and treats a run without a prior thread as empty metadata", async () => {
  const { appRoot } = await fixture()
  const seen: Record<string, unknown>[] = []
  const physical = managedProviderFixture()
  const config = {
    sandbox: {
      provider: physical.provider,
      workspace: async (thread: { threadId: string; metadata: Record<string, unknown> }) => {
        seen.push(thread.metadata)
        return { source: { directory: "source", include: ["main.txt"] } }
      },
    },
  }
  const handler = await createRuntimeFetchHandler({ appRoot, config })
  handlers.push(handler)
  await createThread(handler, "with", { task: "x", [THREAD_ACCESS_METADATA_KEY]: { forged: true } })
  await run(handler, "with")
  await run(handler, "without")
  expect(seen[0]).toEqual({ task: "x" })
  expect(seen[0]).not.toHaveProperty(THREAD_ACCESS_METADATA_KEY)
  expect(seen[1]).toEqual({})
})
```

Add `import { THREAD_ACCESS_METADATA_KEY } from "@b4run/sdk"` at the top. Note on the second test: the runtime may itself write a `route` key into thread metadata after the first run; `seen[0]` is captured at first admission, before that write, so the equality holds. If the assertion fails because the runtime stamps metadata at thread creation, change `toEqual({ task: "x" })` to `toMatchObject({ task: "x" })` and keep the reserved-key assertion.

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-runtime.test.ts
```

Expected: the new tests FAIL: `seen` receives `{}` for every thread (metadata not plumbed), so both threads resolve to `alpha.txt`.

- [ ] **Step 3: Implement**

In `packages/cli/src/lib/runtime/execute-route-core.ts`, replace the admission call:

```ts
  if (options.sandboxManager && sandboxKey) {
    const threadsStore = options.threadsStore ?? configThreadsStore
    const handle = await options.sandboxManager.getForThread(
      sandboxKey,
      options.signal ?? new AbortController().signal,
      {
        // Loaded only when the thread has no workspace record yet. The key is
        // the SANDBOX key, so a subagent resolves through its parent's thread.
        metadata: async () => {
          // The store read takes no signal today; the manager re-checks the
          // admission signal after the resolver returns.
          const thread = await threadsStore?.getThread(sandboxKey)
          return stripReservedThreadMetadata(thread?.metadata) ?? {}
        },
      },
    )
    sandboxBackends = { filesystem: handle.filesystem, exec: handle.exec }
    sandboxWorkspaceRoot = handle.workspaceRoot
  }
```

Add `import { stripReservedThreadMetadata } from "../dev/thread-metadata.js"` (the module is pure, no `node:` imports, so it is safe to import from the runtime core; confirm there is no existing import cycle with `grep -n "runtime/" packages/cli/src/lib/dev/thread-metadata.ts`, which should print nothing).

- [ ] **Step 4: Run the runtime tests and the full CLI suite**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-runtime.test.ts
pnpm --filter @b4run/cli test
```

Expected: PASS. The full suite is the check that the extra `getThread` per admission broke nothing that counts store calls.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route-core.ts packages/cli/test/managed-workspace-runtime.test.ts
git commit -m "feat(cli): admission hands the thread's stored metadata to the workspace resolver

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: A built app with a resolver boots and resolves at run time

**Files:**
- Test: `packages/cli/test/managed-workspace-runtime.test.ts`

This is the proof that the artifact form from Task 3 and the boot path from Task 4 agree in a real `b4 build` output, not only in unit tests.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/managed-workspace-runtime.test.ts`, modelled on the existing "boots the emitted Node manifest" test:

```ts
it("builds a resolver app to a resolver artifact and resolves per thread from the built manifest", async () => {
  const { appRoot } = await fixture()
  await writeFile(join(appRoot, "source/beta.txt"), "beta")
  await mkdir(join(appRoot, "node_modules/@b4run"), { recursive: true })
  await symlink(new URL("..", import.meta.url), join(appRoot, "node_modules/@b4run/cli"), "dir")
  const physical = managedProviderFixture()
  const config = {
    build: { targets: ["node"] as const },
    sandbox: {
      provider: physical.provider,
      workspace: async (thread: { threadId: string; metadata: Record<string, unknown> }) => ({
        source: {
          directory: "source",
          include: [thread.metadata.task === "beta" ? "beta.txt" : "main.txt"],
          files: [{ path: "main.txt", text: String(thread.metadata.task ?? "main") }],
        },
      }),
    },
  }
  seedB4Config(appRoot, config)
  await runBuildCommand({ cwd: appRoot, clean: true }, { stdout: () => {}, stderr: () => {} })
  const workspace = JSON.parse(await readFile(join(appRoot, ".b4/build/workspace.json"), "utf8"))
  expect(workspace).toEqual({ version: 2, kind: "resolver" })
  const modules = await loadStaticModules(pathToFileURL(join(appRoot, ".b4/build/modules.mjs")))
  const handler = await createRuntimeFetchHandler({ appRoot, config, modules: { ...modules, workspace } })
  handlers.push(handler)
  await createThread(handler, "built-beta", { task: "beta" })
  expect((await run(handler, "built-beta")).body).toMatchObject({ source: "beta", current: "beta" })
  await handler.close()
})
```

`seedB4Config` is an in-memory cache (`packages/core/src/config.ts:73`), so the resolver function survives; the build reads the seeded object, not a file.

- [ ] **Step 2: Run to verify it fails or passes**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-runtime.test.ts
```

Expected: PASS if Tasks 3 to 5 are complete. If `runBuildCommand` throws on the function, the failure is in `packages/cli/src/commands/build.ts:94-102`; that block only calls `captureWorkspaceArtifact`, which Task 3 made accept a function, so a failure here points at config serialisation (see the note in Step 1), not at the build.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/managed-workspace-runtime.test.ts
git commit -m "test(cli): a built resolver app boots from its artifact and resolves per thread

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Documentation and changeset

**Files:**
- Modify: `apps/web/content/docs/api/workspace.mdx:29-40, 366-381, 513-521`
- Modify: `apps/web/content/docs/sandbox.mdx:40-70` (the Lifecycle section)
- Regenerate: `apps/web/content/seo/lastmod.generated.json`
- Create: `.changeset/workspace-resolver.md`

- [ ] **Step 1: Update the API contract block**

The fenced block tagged `api-contract="@b4run/workspace#.:SandboxConfig"` is compared against the source by `scripts/lib/docs-api-inventory.mjs`. Replace its body so it matches Task 1's interface exactly, comments excluded:

```ts
export interface SandboxConfig {
  readonly workspace?: WorkspaceDefinition | WorkspaceResolver
  readonly provider: SandboxProvider
  readonly network?: SandboxPolicy["network"]
  readonly env?: SandboxPolicy["env"]
  readonly resources?: SandboxPolicy["resources"]
  readonly security?: SandboxSecurityPolicy
  readonly idleTimeoutMs?: number
}
```

Change the `workspace` row of the fields table beneath it to:

```markdown
| `readonly workspace` | `WorkspaceDefinition \| WorkspaceResolver` | no | Declare the initial managed workspace: one definition for every thread, or a resolver that decides per thread at first admission. |
```

- [ ] **Step 2: Add the two exports to the public exports table**

In the `### \`@b4run/workspace\`` table, after the `CapturedWorkspaceDefinition` row:

```markdown
| `WorkspaceResolver` | Decide one thread's initial workspace from its id and client metadata, once, at first admission. |
| `WorkspaceResolverInput` | What a resolver is told: the thread id, its stored client metadata with the reserved key stripped, and the admitting run's abort signal. |
```

The docs check keeps a hardcoded list of required contract keys for `@b4run/workspace` at `scripts/check-docs.mjs:1295-1306`. If Step 6 reports the new exports as undocumented or demands contracts for them, add `"@b4run/workspace#.:WorkspaceResolver"` and `"@b4run/workspace#.:WorkspaceResolverInput"` to that list and add matching `api-contract` blocks in the "Key contracts" section, copying their source text from Task 1 without comments.

- [ ] **Step 3: Extend "Managed workspace lifecycle"**

After the first paragraph of `### Managed workspace lifecycle` in `apps/web/content/docs/api/workspace.mdx`, add:

```markdown
`sandbox.workspace` may instead be a `WorkspaceResolver`: host code called once per
thread, at the thread's first admission, with the thread id and its stored client
metadata. What it returns is captured (or verified, if already captured), recorded by
digest in that thread's creation intent, and never re-resolved: later turns, restarts and
readers all use the record. `b4 build` cannot capture a resolver, so the artifact records
only that one is configured, and startup refuses an artifact whose form disagrees with the
loaded config. The result is decided by deployed host code, never by the client or the
model; a resolver treats the metadata it is given as input to validate, not as authority.
```

- [ ] **Step 4: Add a subsection to the sandbox guide**

In `apps/web/content/docs/sandbox.mdx`, at the end of the `## Lifecycle` section (before `## Security hardening`), add:

```markdown
### Per-thread workspaces

One app usually gives every thread the same initial workspace. When threads need
different starting points — one repository pin per work order, say — make
`sandbox.workspace` a function of the thread:

```ts title="b4.config.ts"
export default config({
  sandbox: {
    provider: dockerSandbox({ scope: "factory", image: "factory-builder:pinned" }),
    workspace: async ({ threadId, metadata, signal }) => {
      const task = String(metadata.task ?? "")
      signal.throwIfAborted()
      if (!/^[a-z0-9-]+$/.test(task)) throw new Error(`thread ${threadId} names no task`)
      return { source: { directory: `tasks/${task}`, include: ["src", "TASK.md"] }, baseline: "git" }
    },
  },
})
```

The resolver runs once, when the thread is first admitted, and its result is recorded by
digest; every later turn of that thread reads the record. Deleting the thread deletes the
record, so a thread id reused after deletion is resolved again. The resolver runs inside
the thread's admission critical section: honour `signal` and return promptly, because a
resolver that hangs holds that thread's admission open. Thread metadata is client
input, so validate it as the example does. `b4 check` reports a resolver as
"managed workspace is resolved per thread", and a built app carries a resolver marker
instead of captured source.
```

Do not edit or remove any phrase listed for `sandbox.mdx` in `scripts/check-docs.mjs` (the `required` array around line 2474 and the `retainedHeading` entries); this task only adds.

- [ ] **Step 5: Changeset**

Create `.changeset/workspace-resolver.md`:

```markdown
---
"@b4run/workspace": minor
"@b4run/cli": minor
---

`sandbox.workspace` may now be a `WorkspaceResolver`: host code called once per thread, at first admission, with the thread id and its stored client metadata, returning that thread's initial workspace definition. The result is captured and recorded by digest exactly as a static definition is; `b4 build` records a resolver marker in place of captured source and startup refuses an artifact whose form disagrees with the config; `b4 check` reports the per-thread form.
```

- [ ] **Step 6: Regenerate lastmod and run the docs check**

```bash
pnpm --dir apps/web seo:lastmod
node scripts/check-docs.mjs
```

Expected: the check passes. If it reports a missing contract block for `WorkspaceResolver` or `WorkspaceResolverInput`, add the blocks as described in Step 2 and rerun.

- [ ] **Step 7: Commit**

```bash
git add apps/web/content/docs/api/workspace.mdx apps/web/content/docs/sandbox.mdx apps/web/content/seo/lastmod.generated.json .changeset/workspace-resolver.md
git commit -m "docs(workspace): per-thread workspace resolvers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The full gate

**Files:** none new.

- [ ] **Step 1: Run the repository gates that this change can reach**

```bash
pnpm --filter @b4run/workspace... build
pnpm --filter @b4run/workspace lint && pnpm --filter @b4run/cli lint
pnpm --filter @b4run/workspace typecheck && pnpm --filter @b4run/cli typecheck
pnpm --filter @b4run/workspace test && pnpm --filter @b4run/cli test
node scripts/check-docs.mjs
```

Expected: every command exits 0. Do not pipe any of them through `tail` or `head`; the exit code is the result.

- [ ] **Step 2: Run the Docker-backed sandbox lane, which exercises the real provider's admission path**

```bash
B4_TEST_DOCKER=1 pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-process.test.ts test/managed-workspace-reader.test.ts
```

Expected: PASS. Those tests use static definitions; passing proves the static path is untouched under the real provider. Docker Desktop must be running.

- [ ] **Step 3: Confirm the code-fixer and software-factory examples are unaffected**

```bash
pnpm --filter @b4-example/code-fixer-server typecheck && pnpm --filter @b4-example/software-factory-server typecheck
git status --short examples/code-fixer
```

Expected: both typecheck; `git status` prints nothing for `examples/code-fixer`.

- [ ] **Step 4: No commit here unless a gate found something.** If one did, fix it in the task it belongs to and amend that task's commit message with what changed, then rerun this task.

---

## Follow-ups recorded by review, not in this plan

- **Orphan source rows.** `installation.sources.put` runs before `provider.resolveEnvironment`; an
  admission that fails or aborts in `resolveEnvironment` leaves a source row no association
  references, and nothing reclaims `workspace_sources`. Pre-existing for the dev-mode hook; the
  per-thread resolver makes the rows vary per thread. Fix is a reclaim of digests referenced by no
  association, or putting the source after a successful `resolveEnvironment`. Design item for
  `@b4run/sqlite-storage` + the manager; record in the rung 3 spec's follow-ups.
- **Per-thread permissions** (spec §5.4), unchanged.

## Self-review against the spec

- §5.1 resolver type, once per thread, captured or verified, recorded by digest: Tasks 1, 2.
- §5.2 metadata from the thread store, reserved key stripped, subagents via the parent's sandbox key: Task 5.
- §5.3 artifact records the form, mismatch refused both ways, version 1 still accepted: Tasks 3, 4 (with the recorded amendment).
- §5.4 permissions stay static: no task, deliberately; the follow-up is the spec's.
- §5.5 unit and artifact proofs: Tasks 2, 3, 4. The sandbox-lane "two-thread factory builder" proof belongs to sub-project 3, since it needs the builder's resolver; this plan's Task 5 and Task 6 are the two-thread proofs through the Agent Protocol with the fake managed provider.
- §5.6 no per-thread permissions, policy or provider: nothing here adds one.
- `b4 check` reports the form: Task 4 Step 5.
- Type names used consistently: `WorkspaceResolver`, `WorkspaceResolverInput` (Task 1, Tasks 4 to 7), `WorkspaceAdmissionContext` (Tasks 2, 5), `verifyWorkspaceResolverArtifact` (Tasks 3, 4), `captureDefinition(thread)` (Tasks 2, 4).
