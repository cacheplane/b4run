# Managed Workspace Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a trusted, co-located host process read a managed workspace (one created through `sandbox.workspace`), and make the software-factory end-to-end test read the builder's real workspace.

**Architecture:** `ManagedWorkspaceProvider` gains an optional `openWorkspaceReader({ workspace: ReadyWorkspace })`; Docker implements it by verifying the stored record then reusing `openDockerWorkspaceReader` over the managed volume. `@b4run/sqlite-storage` gains `openWorkspaceInstallationReader(appRoot)`, a lock-free read-only view of the association store. `@b4run/cli/workspace` gains `openManagedWorkspaceReader` / `withManagedWorkspaceReader` joining the two. Spec: `docs/superpowers/specs/2026-09-19-managed-workspace-read-design.md`.

**Tech Stack:** TypeScript, vitest, `node:sqlite` (`readOnly`), Docker CLI via the injected `Docker` interface. Node 24 (`nvm use 24`). Run package tests with `pnpm --filter <pkg> test -- <file>`.

---

### Task 1: Type surface in `@b4run/workspace`

**Files:**
- Modify: `packages/workspace/src/managed-workspace.ts` (add `OpenManagedWorkspaceReaderInput`, optional method)
- Modify: `packages/workspace/src/index.ts` (export the type)
- Modify: `packages/workspace/src/with-workspace-reader.ts` (extract `scopedWorkspaceReader`)
- Test: `packages/workspace/test/with-workspace-reader.test.ts`

- [ ] Add to `managed-workspace.ts` (imports `SandboxSecurityPolicy`, `SandboxWorkspaceReader` from `./sandbox-types.js`):

```ts
export interface OpenManagedWorkspaceReaderInput {
  readonly workspace: ReadyWorkspace
  readonly signal: AbortSignal
  readonly runAsNonRoot?: SandboxSecurityPolicy["runAsNonRoot"]
}
// on ManagedWorkspaceProvider:
  /** OPTIONAL capability, same contract as SandboxProvider.openWorkspaceReader, addressed by the published workspace. */
  openWorkspaceReader?(input: OpenManagedWorkspaceReaderInput): Promise<SandboxWorkspaceReader>
```

- [ ] Extract in `with-workspace-reader.ts`:

```ts
export async function scopedWorkspaceReader<T>(
  open: () => Promise<SandboxWorkspaceReader>,
  operation: (reader: SandboxWorkspaceReader) => Promise<T>,
): Promise<T> { /* existing body from `const reader = await ...` down */ }
export async function withWorkspaceReader<T>(provider, input, operation) {
  if (typeof provider.openWorkspaceReader !== "function") throw ...
  return scopedWorkspaceReader(() => provider.openWorkspaceReader!(input), operation)
}
```

- [ ] Add a test that `scopedWorkspaceReader` closes on success, aggregates body+close failures, and surfaces a close failure alone. Run `pnpm --filter @b4run/workspace test`. Commit.

### Task 2: Docker managed reader (unit, injected Docker)

**Files:**
- Modify: `packages/sandbox/src/docker/docker-workspace-reader.ts` (optional `containerPrefix` in deps, default `b4-sbx-rdr-`)
- Modify: `packages/sandbox/src/docker/managed-workspace.ts` (add `openWorkspaceReader`)
- Test: `packages/sandbox/test/managed-workspace.test.ts`

- [ ] Write failing tests using the existing `fixture()` (extend its fake docker: `volume inspect --format {{.Mountpoint}}` returns `/var/lib/docker/volumes/<name>/_data` when the volume object exists, else exit 1; `run` with `--name` records the object; `rm` deletes it):
  - "reads through a bind-readonly reader without naming a session container": create, reconnect (a session exists), `openWorkspaceReader({ workspace: ready, signal })`, `listDir`, `close`. Assert: no call contains a `b4-ws-session-` name, no call is `ps`, the reader `run` args include `--mount type=bind,source=<mountpoint>,target=/workspace,readonly`, `--network none`, `--cap-drop ALL`, `--read-only`, `--label b4.sandbox.reader=<key>`, name starts with `b4-ws-reader-`; and the container object is deleted after close.
  - "rejects a lost record": delete the record object → rejects `{ code: "lost" }`.
  - "rejects mismatched provenance": pass `{ ...ready, provenance: { ...ready.provenance, sourceDigest: "sha256:" + "b".repeat(64) } }` → rejects `{ code: "conflict" }`.
  - "rejects a foreign volume": overwrite the volume object's labels with `{}` → rejects `{ code: "conflict" }`.
- [ ] Implement in `managed-workspace.ts`:

```ts
async openWorkspaceReader(input) {
  const { intent, ready } = await stored(input.workspace.reference, input.signal)
  verifyReadyWorkspace(input.workspace, intent)
  if (JSON.stringify(input.workspace) !== JSON.stringify(ready))
    fail("conflict", "Workspace provenance mismatch")
  const n = names(intent)
  const key = n.volume.slice("b4-ws-volume-".length)
  return openDockerWorkspaceReader(
    { docker, image: intent.environment.identity, volume: n.volume, resourceId: key, containerPrefix: "b4-ws-reader-" },
    { threadId: intent.threadId, signal: input.signal, ...(input.runAsNonRoot === undefined ? {} : { runAsNonRoot: input.runAsNonRoot }) },
  )
}
```

  Note `stored()` already runs `record()` which inspects the volume with `owned()`. The image is the intent's pinned identity, not `opts.image`, so the reader runs the same image the workspace was prepared with.
- [ ] Run `pnpm --filter @b4run/sandbox test -- managed-workspace.test.ts`. Commit.

### Task 3: Docker managed reader (integration, `B4_TEST_DOCKER=1`)

**Files:**
- Test: `packages/sandbox/test/managed-workspace.integration.test.ts`

- [ ] Add a case "reads a live and a released managed workspace without disturbing it": create; reconnect (session A); write `/workspace/produced` through `docker exec` on A's container; `withWorkspaceReader`-style read via `scopedWorkspaceReader(() => provider.openWorkspaceReader!({workspace: ready, signal}), r => inspectWorkspace(r, { excludeRootDirectories: [".git"], expectedRootSymlinks: { node_modules: "/opt/fixtures/cli-flags/node_modules" } }))` → `files.produced === "kept"`; A's container id unchanged and still running; `docker ps --filter label=b4.sandbox.reader=` empty after close; `release(A)`; read again → same bytes; `destroy` → read rejects `{ code: "lost" }`.
- [ ] Run with `B4_TEST_DOCKER=1 pnpm --filter @b4run/sandbox test -- managed-workspace.integration.test.ts` (needs the `b4-code-fixer:fixture-v1` image; see `examples/code-fixer`). Commit.

### Task 4: `openWorkspaceInstallationReader` in `@b4run/sqlite-storage`

**Files:**
- Modify: `packages/sqlite-storage/src/workspace/installation.ts`
- Modify: `packages/sqlite-storage/src/index.ts`
- Test: `packages/sqlite-storage/test/workspace-installation.test.ts`

- [ ] Failing tests: (a) owner open + create association → reader (same process, second connection) `associations.get(threadId)` equals owner's record, `installationId` equal, `list()` works; (b) reader refuses when `.b4/workspaces` does not exist (never creates it: assert directory still absent); (c) refuses when admission phase is `initializing`; (d) reader `close()` is idempotent and `get` after close throws; (e) reader sees a later `markReady` by the owner without reopening.
- [ ] Implement: reuse `inspect`, `databaseExists`, `loadAdmission`, `validateState`; open with `new DatabaseSync(path, { readOnly: true })`, `PRAGMA busy_timeout=2000`; require phase `ready`; build stores with `makeWorkspaceSourceStore`/`makeWorkspaceAssociationStore` (they only `CREATE TABLE` when the tables are missing, which `validateState` has already ruled out). Export `openWorkspaceInstallationReader` and `WorkspaceInstallationReader`.
- [ ] Run `pnpm --filter @b4run/sqlite-storage test -- workspace-installation`. Commit.

### Task 5: `openManagedWorkspaceReader` / `withManagedWorkspaceReader` in `@b4run/cli/workspace`

**Files:**
- Create: `packages/cli/src/lib/runtime/managed-workspace-reader.ts`
- Modify: `packages/cli/src/workspace-exports.ts`
- Modify: `packages/cli/test/support/managed-provider.ts` (fixture gains `openWorkspaceReader` over its `files` map, refusing when the record is gone)
- Test: `packages/cli/test/managed-workspace-reader.test.ts`

- [ ] Failing tests with a tmp `appRoot` (`mkdir .b4/workspaces`), `openWorkspaceInstallation` + `ManagedWorkspaceManager` + `managedProviderFixture()`: after `getForThread(t)`, `withManagedWorkspaceReader({ appRoot, provider, threadId: t, signal }, r => inspectWorkspace(r))` returns the source files; unknown thread → `/no managed workspace/`; provider without `workspaces` → throws naming the provider; `workspaces` without `openWorkspaceReader` → throws "does not support reading"; after `destroyThread` → `WorkspaceLifecycleError` code `lost`.
- [ ] Implement per spec M4; `withManagedWorkspaceReader` = `scopedWorkspaceReader(() => openManagedWorkspaceReader(o), op)`.
- [ ] Run `pnpm --filter @b4run/cli test -- managed-workspace-reader`. Commit.

### Task 6: Software factory reads the builder's own workspace

**Files:**
- Modify: `examples/software-factory/server/src/worker/workspace-reader.ts` (`createThreadWorkspaceReader({ provider, appRoot }, optionsFor)` using `withManagedWorkspaceReader`)
- Modify: `examples/software-factory/server/src/cli.ts`, `test/end-to-end.integration.test.ts`, `test/workspace-reader.test.ts` (call-site signature)
- Modify: `examples/software-factory/README.md`, `docs/superpowers/notes/2026-09-19-software-factory-arc-handoff.md` (gap is closed)
- Verify: `examples/software-factory/server/package.json` depends on `@b4run/cli`

- [ ] Rewrite the e2e test: `isolatedApp()` → harness run with the scripted builder turn (from the deleted refusal test) → `createThreadWorkspaceReader({ provider: builderSandboxProvider(), appRoot }, workspaceInspectionOptions).read({ threadId: run.threadId, taskId })` → the same assertions as before over `observed`, then the factory flow with the fake worker pointed at `run.threadId`. Keep the harness open until the factory has read (it is what holds the installation); `harness.close({ destroyWorkspaces: true })` in cleanup. Delete `materializeThreadWorkspace` and the refusal test.
- [ ] Run `pnpm --filter software-factory-server test` (unit) and `B4_TEST_DOCKER=1 ... test:sandbox` (e2e). Commit.

### Task 7: Repo gates

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` from the root; `pnpm --dir apps/web seo:lastmod` is NOT needed (no apps/web edits). Check `node scripts/check-build-cache-config.mjs` if any test reads files outside its package.
- [ ] Changeset: minor for `@b4run/workspace`, `@b4run/sandbox`, `@b4run/sqlite-storage`, `@b4run/cli`.
