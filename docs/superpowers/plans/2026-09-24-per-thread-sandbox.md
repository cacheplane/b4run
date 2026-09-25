# Per-thread sandbox (image, policy, permissions): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A B4.run app may decide each thread's whole sandbox (workspace, image, policy, permissions) once, at the thread's first admission, and record it; the software factory then runs one builder process for every target and pin.

**Architecture:** A new `sandbox.thread` resolver (exclusive with `sandbox.workspace`) returns a `ThreadSandbox`. The manager resolves it where it resolves a workspace today (first admission only), asks the provider for the thread's image through a new presence-probed `ManagedWorkspaceProvider.resolveImageEnvironment`, and writes a per-thread record (image reference, policy overrides, and in PR 2 the permission lists) into the installation store in the same SQLite savepoint as the association. Every later admission reads the record: `reconnect` gets the thread's policy, and in PR 2 the permission gate gets a thread-scoped store whose "Always" grants live in the record. PR 3 moves the factory's builder onto it.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, `node:sqlite`, Docker CLI, zod (examples only), changesets, `node scripts/check-docs.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md` §1 (the item), the intro (trust constraint), §7 to §9. Extends the rung 3 per-thread workspace resolver (`docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md` §5, plan `docs/superpowers/plans/2026-09-21-per-thread-workspace-resolver.md`) and follows its patterns: the tagged artifact form `{ version: 2, kind }`, the lazy `WorkspaceAdmissionContext.metadata(signal)`, record-at-first-admission, and `signal.throwIfAborted()` after every await that precedes a durable write.

**Standing rules:** `source ~/.nvm/nvm.sh && nvm use 24` before any test run (Node 22 makes unrelated tests fail). Never `git stash`; add files by path; never `git add -A`. Never bare `biome check --write` at the root: use `pnpm --filter <pkg> lint` or `pnpm lint:fix`. Commands run from the repository root. `src/` imports use `.js`, tests use `.ts`. `exactOptionalPropertyTypes` is on: use conditional spreads, never `{ x: undefined }`. Tests that import `@b4run/workspace/node` or `@b4run/sqlite-storage` by package name read `dist/`: rebuild the changed package (`pnpm --filter <pkg> build`) before running a dependent package's tests. Do not pipe a gate through `tail`/`head`: the exit code is the result. Commit after every task with a message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## Decisions needed (settle before PR 1 starts)

Each has a recommendation; the plan is written to the recommendation. If Brian decides otherwise, the named tasks change.

> **Amended after review (2026-09-24).** D1 now merges `resources` key by key and keeps the app's network object when the mode matches; D9 also refuses `resources.diskGb`; D8 runs on every `sandbox` block at build; D11 (missing record) is new. Tasks 4, 5, 7, 9, 10, 15, 20, 21, 22, 23 and the PR 3 README changed accordingly; see "Review amendments" at the end.

- **D1. May a thread's policy only narrow the app's, or replace it?** Recommendation: **merge, with monotone network.** A thread may set `network`, `env` and `resources`; `security` is always the app's (not settable per thread). `resources` merge key by key (the thread's keys win, the app's other keys stay: a thread that sets only `memoryMb` keeps the app's `timeoutMs`). `env` replaces the app's whole (a partial merge would leave variables nobody asked for). `network` can only stay or narrow: a thread `deny` under an app `allow` becomes `{ mode: "deny" }`; a thread whose mode equals the app's keeps the app's network object, so an app `allow` keeps its `denylist`; a thread `allow` under an app `deny` is refused, at first admission and again at every reconnect (an app that later denies the network also stops old threads that asked for it). Pure narrowing is not workable for resources: the `cli` target needs more memory than `cli-flags`. Tasks 5 (`threadPolicy`) and 8.
- **D2. How do per-thread permissions combine with the app's?** Recommendation: **the thread's `allow` replaces the app's config allow-list; denials add up; the mode is the app's.** Concretely `match` = deny if the thread's `deny` matches, deny if the app's store says deny (its config denials and any hand-written runtime denials), then allow if the thread's `allow` or (interactive mode only) the thread's recorded grants match, else unknown; `bypass` returns unknown as every store does. The app's runtime allow-list in `.b4/permissions.json` is NOT consulted for such a thread (another thread's "Always" must not leak in) and an "Always" in such a thread is written to the thread's record only. Works over any `PermissionsStore` (the file store, a config `permissions.store`, the Postgres store), because it only reads the base store's `mode` and its `deny` verdicts. PR 2, Tasks 11 to 15.
- **D3. Provider interface: the spec's `resolveEnvironment(signal, { image })` or a separate method?** Recommendation: **a separate optional method, `resolveImageEnvironment(image, signal)`, whose presence is the capability probe** (the pattern `openWorkspaceReader` already uses). An extra argument to an existing method is silently ignored by every provider written before it, so a third-party provider would run a thread that asked for image B in its default image A: a fail-open. With a probe, the manager refuses a per-thread image on a provider without the method before anything is created. Tasks 2, 3, 5.
- **D4. Kubernetes and Postgres parity.** No decision needed, recorded because the question was asked: `kubernetesSandbox` has no `workspaces` (no `ManagedWorkspaceProvider`; `packages/sandbox/src/kubernetes/kube-sandbox.ts` never sets it), and `resolveSandboxManager` already refuses a managed configuration on such a provider ("Sandbox provider does not support managed workspaces", `resolve-sandbox.ts:42-43`). `sandbox.thread` always carries a workspace, so it is refused on Kubernetes by the same check; Task 7 adds tests that construct a real `kubernetesSandbox` (with a stub `client`, so no cluster is touched) and see it refused at check and at boot. `@b4run/postgres-storage` has no workspace installation store (its stores are checkpointer, threads, permissions); the installation is always `openWorkspaceInstallation(appRoot)` (SQLite under `.b4/workspaces`), so the record has one home. Thread grants therefore live in SQLite even when the app's permissions store is Postgres; that is the "kept in the thread's record" rule, not a parity gap.
- **D5. Is `sandbox.thread` exclusive with any `sandbox.workspace`, or only with a resolver?** Recommendation: **with any.** A `ThreadSandbox` always names its workspace, so a static `workspace` beside `thread` could only be dead configuration or a fallback nobody asked for. Refused at `b4 check`, `b4 build` and boot. Task 7.
- **D6. May `dockerSandbox` have no default image?** The factory's one builder serves every target, so no image is "the" builder's. Recommendation: **`image` becomes optional when an `images` predicate is given**, and every use of the missing default fails closed by name (`resolveEnvironment` → `unsupported`; `acquire` and the provider-storage reader → `sandboxUnavailable`). Alternative if refused: keep `image` required and have PR 3 pass one target's image as an unused default; drop Task 3 Step 5, the `dockerSandbox image options` tests and the "without a default image" test of Task 3 Step 2. Task 3.
- **D7. Artifact form.** Recommendation: **a third tagged form, `{ version: 2, kind: "thread" }`**, distinct from `{ version: 2, kind: "resolver" }`, and a mismatch in any direction among the three forms fails boot with the rebuild error. Task 6.
- **D8. Refuse unknown keys in the `sandbox` block?** Recommendation: **yes, at check, build and boot.** `B4Config` has no runtime schema; a misspelt `thred:` would today be silently ignored and the app would run every thread in a non-managed per-app sandbox under the app's (possibly broader) policy and permissions: exactly the near-miss fail-open class recorded for config opt-outs. Known keys: `workspace`, `thread`, `provider`, `network`, `env`, `resources`, `security`, `idleTimeoutMs`. Checked whenever `config.sandbox` exists (a lone `thred:` beside a provider fails `b4 build` too, not only a block that also has `workspace` or `thread`). Risk: an app that carries an extra key in `sandbox` stops checking, building and booting; TypeScript already flags excess properties in literals, and no app in this repository has one. The changeset names this as a behaviour change. Task 7.
- **D9. May a thread policy carry a network `allowlist` or `denylist`, or `resources.diskGb`?** Recommendation: **no, each refused by name.** The Docker managed `reconnect` maps `deny` to `--network none` and `allow` to `bridge` and enforces neither list, and it never reads `diskGb` (`packages/sandbox/src/docker/managed-workspace.ts`, `reconnect`); managed workspaces are Docker-only today, so any of the three in a thread policy would read as a guarantee nobody enforces. The factory's schema already refuses both lists and never emits `diskGb`. Task 2.
- **D11. What does a missing record mean?** Recommendation: **in thread mode, always a refusal.** A thread-mode manager writes a record for every thread it admits, `{ version: 1 }` when the resolver chose nothing, so "no record" can only mean the thread was admitted before the app switched to `sandbox.thread` (from `sandbox.workspace`) or its record was lost (a dropped or recreated table). Either way re-admitting it would silently run the app's defaults in place of what the thread was given; the manager refuses it as `conflict`, naming the thread and the remedy (delete the thread). The schema's recreate path stays additive rather than refusing when associations exist, deliberately: an installation that predates PR 1 has associations and no tables, and refusing it would stop every existing managed-workspace app from starting after the upgrade. The admission refusal is what makes a lost record fail closed. Tasks 4 and 5.
- **D10. PR split.** Recommendation: three PRs, below.

## Verification of the spec against main (f2ee6cf6)

The spec's line references are to 7c7ad3c2. Re-located on f2ee6cf6:

| Spec claim | Where now | Verdict |
|---|---|---|
| `SandboxConfig` takes one provider and one policy (`sandbox-types.ts:183-199`) | `packages/workspace/src/sandbox-types.ts:186-202` | Confirmed (moved 3 lines) |
| `resolveSandboxManager` builds the one policy at boot (`resolve-sandbox.ts:33-38`) | `packages/cli/src/lib/runtime/resolve-sandbox.ts:33-38` | Confirmed |
| ...and hands it to every `provider.reconnect` (`managed-workspace-manager.ts:209`) | `packages/cli/src/lib/runtime/managed-workspace-manager.ts:228` (`provider.reconnect(ready, policy, signal)`); moved by #826 (verify once, lines 160-178) | Confirmed |
| Permissions are one store per app (`resolvePermissionsStore`, `execute-route.ts:282`) | `packages/cli/src/lib/runtime/execute-route.ts:282-299`; per request in `execute-route-core.ts:1056-1071`, which runs AFTER sandbox admission (`:995-1012`) | Confirmed; the ordering is what makes a thread-scoped store a local change |
| The resolver varies only the workspace (rung 3 §5.6) | rung 3 spec §5.6 | Confirmed |
| `FACTORY_BUILDER_TARGET`, `server/src/builder-manifest.ts:110` | `examples/software-factory/server/src/builder-manifest.ts:110` (`loadBuilderTarget`), read at `server/b4.config.ts:14` | Confirmed |
| Copy `server/` per builder (README:252-275), `FACTORY_WORKERS` (README:311-334) | `examples/software-factory/README.md:249-313` and `:327-377` | Confirmed (moved) |
| `builder_environment_differs` (`controller/src/lib/controller/factory.ts:240-275`) | `builderEnvironmentRefusal` at `factory.ts:266-311`, called at `:1287-1294` | Confirmed (moved). The spec omits its sibling `stalePermissionsRefusal` (`:313-358`, `builder_permissions_stale`), which also retires in PR 3 |
| `ManagedWorkspaceProvider` at `managed-workspace.ts:93` | `packages/workspace/src/managed-workspace.ts:91-117`, `resolveEnvironment(signal)` at `:93` | Confirmed |
| `resolveEnvironment` records the image's digest in the intent (`managed-workspace-manager.ts:148-158`) | same lines: `provider.resolveEnvironment(signal)` then `createWorkspaceIntent({ ..., environment })` | Confirmed |
| The Docker managed provider reads its configured `image` only in `resolveEnvironment` (`packages/sandbox/src/docker/managed-workspace.ts:202`) | `:202` is the only `opts.image` in the file | Confirmed |
| Resource names hash binding, installation and operation (`:27-30`) | `names()` at `:27-37` | Confirmed; the identity is NOT in the name, the per-thread operation id is |
| Sessions and readers run `intent.environment.identity` (`:260`, `:499`) | volume check in `create` `:224`, prepare container `:260`, record container `:330`, session `:411` (`reconnect`), reader `:499` | Confirmed; `:260` is the preparation container, not the session, and three more sites use the identity |
| (implied) Nothing compares a stored intent's identity with the configured image | `binding()` at `:103-114` checks provider, scope, daemon account and the identity's shape only | Confirmed; this is the missing half of the spec's argument |
| The image is half of a reader's address (README:447, `server/b4.config.ts`, `controller/src/lib/targets/workspace.ts:84-87`) | comments at `server/b4.config.ts:24-27`, `targets/workspace.ts:46-53` and `:82-92`, README "What is joined" | **Refuted for managed workspaces** by the rows above: the code reads the image from the intent. Task 1 proves it with a test that fails if it is false. The statement stays true for the non-managed provider-storage reader (`docker-sandbox.ts:367-378` uses `opts.image`) |

Not in the spec, found while verifying:

- `packages/postgres-storage` has no workspace installation store (D4); `kubernetesSandbox` has no managed workspaces (D4).
- The manager stores the source bundle BEFORE `resolveEnvironment` (`managed-workspace-manager.ts:147-148`). A refused image would add orphan source rows (the rung 3 follow-up "orphan source rows"). Task 5 moves `sources.put` after the environment resolves, which closes that follow-up for every failure in `resolveEnvironment` too.
- The factory's Docker lane can already prepare a second `devkit` pin: `controller/test/target-devkit-pin.integration.test.ts` prepares `bfaf0c2b3030eebb572703c8f70f0e063593b1fa` into a copy of `targets/` under `test:sandbox`. The spec's two-pin proof is therefore buildable in CI (PR 3, Task 21).
- `examples/software-factory/server/scripts/with-target.mjs` and `.github/workflows/ci.yml:474-477` key the builder's real `b4 check`/`b4 build` on `FACTORY_BUILDER_TARGET`; PR 3 must move that guard (Tasks 18 and 22).

## Where I think the spec is wrong or incomplete

1. `resolveEnvironment(signal, request?: { image })` fails open for any provider written before it (D3).
2. `policy?: Pick<SandboxPolicy, "network" | "env" | "resources">` makes `network` required inside a thread policy; the plan's `ThreadSandboxPolicy` makes every field optional (a thread that only sets resources keeps the app's network).
3. It leaves the policy composition (D1) and permission composition (D2) unstated; both decide what a manifest can widen.
4. It retires `builder_environment_differs` but not `builder_permissions_stale`, the target-file build guard, or the CI lane lines (PR 3 handles all four).
5. "The image is half of the address" was already false for managed workspaces; the README and three comments say otherwise and PR 3 corrects them.
6. The Docker managed `reconnect` ignores `resources.diskGb` and both network lists; a per-thread policy cannot make them mean more than the app-level one does (D9).

## PR split

| PR | Branch | Ships | Why separate |
|---|---|---|---|
| **1. Per-thread sandbox: image, policy, workspace** | `blove/thread-sandbox` | `@b4run/workspace` types and verifiers; Docker `resolveImageEnvironment`, `images`, optional default image; the SQLite thread-sandbox record; manager, config shape validation, artifact, `b4 check`; docs; changeset | The storage record and the provider method are the load-bearing change; it is reviewable alone and useful alone (an app can already vary image and resources per thread). `permissions` in a resolver result is refused as an unknown key, so nothing fails open before PR 2 lands |
| **2. Per-thread permissions** | `blove/thread-permissions` (off PR 1) | `createThreadPermissionsStore` in `@b4run/permissions`; `permissions` in `ThreadSandbox` and the record; the grants table; the gate wiring in `execute-route-core`; docs; changeset | A different reviewer concern (the HITL gate and `.b4/permissions.json`), with its own invariants; small once PR 1 exists |
| **3. The factory runs one builder** | `blove/factory-one-builder` (off PR 2) | Manifest v2 carries image, policy and permissions; builder boots with no target file; controller has one builder endpoint; `builder_environment_differs` and `builder_permissions_stale` retired; Docker lane with `cli-flags` and `devkit` at two pins; README; CI lane lines | Example-only (no changeset, private packages); depends on both framework PRs being released to the workspace |

Each PR must pass its gates on its own (Tasks 10, 16, 23). Pin the branch before dispatching subagents (`git switch <branch>`, `git worktree list`), per `AGENTS.md`.

---

## File map

**PR 1**

| File | Change |
|---|---|
| `packages/sandbox/test/managed-workspace.test.ts` | Task 1 proof; Task 3 image tests; fixture takes `image`, `identities`, `images` |
| `packages/workspace/src/sandbox-types.ts` | `ThreadSandboxPolicy`, `ThreadSandbox`, `ThreadSandboxResolver`, `ThreadSandboxRecord`; `SandboxConfig.thread` |
| `packages/workspace/src/managed-workspace.ts` | optional `ManagedWorkspaceProvider.resolveImageEnvironment` |
| `packages/workspace/src/thread-sandbox.ts` (new) | `verifyImageReference`, `verifyThreadSandboxPolicy`, `verifyThreadSandbox`, `verifyThreadSandboxRecord` |
| `packages/workspace/src/index.ts`, `packages/workspace/src/node.ts` | exports |
| `packages/workspace/test/thread-sandbox.test.ts` (new) | types and verifiers |
| `packages/sandbox/src/docker/managed-workspace.ts` | `resolveImageEnvironment`, `images`, optional default image |
| `packages/sandbox/src/docker/docker-sandbox.ts` | `DockerSandboxOptions.images`, optional `image`, `defaultImage()` |
| `packages/sandbox/test/docker-sandbox.unit.test.ts` | option validation |
| `packages/sandbox/test/managed-workspace.integration.test.ts` | real Docker: two images, two policies |
| `packages/sqlite-storage/src/workspace/thread-sandbox-store.ts` (new) | schema, `get`, internal `insert`/`remove` |
| `packages/sqlite-storage/src/workspace/association-store.ts` | `create(intent, sandbox?)` in one savepoint; `completeDelete` drops the record |
| `packages/sqlite-storage/src/workspace/installation.ts` | owner ensures the schema; `threadSandboxes` on `WorkspaceInstallation` |
| `packages/sqlite-storage/src/index.ts` | export `WorkspaceThreadSandboxStore` |
| `packages/sqlite-storage/test/workspace-thread-sandbox.test.ts` (new) | record semantics, migration, reader |
| `packages/cli/src/lib/runtime/thread-policy.ts` (new) | `threadPolicy(app, thread)` |
| `packages/cli/src/lib/runtime/managed-workspace-manager.ts` | `resolveThread` option; image; record; per-thread policy at reconnect; source after environment |
| `packages/cli/test/managed-workspace-manager.test.ts` | thread-sandbox semantics |
| `packages/cli/src/lib/runtime/sandbox-config-shape.ts` (new) | `sandboxConfigShapeErrors` |
| `packages/cli/src/lib/runtime/collect-sandbox-errors.ts` | shape errors; `thread` validation |
| `packages/cli/src/lib/runtime/resolve-sandbox.ts` | shape check; `thread` branch |
| `packages/cli/src/lib/runtime/execute-route-core.ts:979` | managed guard covers `thread` |
| `packages/cli/src/commands/check.ts:145-146` | report the per-thread sandbox |
| `packages/cli/src/lib/build/workspace-artifact.ts` | `ThreadSandboxBuildArtifact`, `threadSandboxArtifact`, kind-aware verify |
| `packages/cli/src/commands/build.ts:93-102` | build a `thread` app |
| `packages/cli/test/collect-sandbox-errors.test.ts`, `resolve-sandbox.test.ts`, `workspace-build-artifact.test.ts`, `managed-workspace-runtime.test.ts`, `support/managed-provider.ts` | tests |
| `apps/web/content/docs/sandbox.mdx`, `api/workspace.mdx`, `api/sandbox.mdx`, `api/sqlite-storage.mdx` | docs (existing pages: no lastmod regeneration) |
| `.changeset/per-thread-sandbox.md` (new) | patch |

**PR 2**

| File | Change |
|---|---|
| `packages/permissions/src/thread-store.ts` (new), `src/index.ts` | `createThreadPermissionsStore`, `ThreadPermissions`, `ThreadPermissionGrants` |
| `packages/permissions/test/thread-store.test.ts` (new) | composition and "Always" |
| `packages/testing/test/permissions-conformance.test.ts` | run the conformance suite over the thread store |
| `packages/workspace/src/sandbox-types.ts`, `src/thread-sandbox.ts`, `test/thread-sandbox.test.ts` | `permissions` in `ThreadSandbox` and the record |
| `packages/sqlite-storage/src/workspace/thread-sandbox-store.ts`, `installation.ts`, `association-store.ts`, test | grants table, `grants`, `addGrant` |
| `packages/cli/src/lib/runtime/managed-workspace-manager.ts`, `sandbox-manager.ts`, `resolve-sandbox.ts` | carry permissions; `threadPermissions(threadId)` |
| `packages/cli/src/lib/runtime/execute-route-core.ts:1056-1071` | wrap the store for a thread-scoped thread |
| `packages/cli/test/managed-workspace-manager.test.ts`, `managed-workspace-runtime.test.ts` | tests |
| `apps/web/content/docs/permissions.mdx`, `api/permissions.mdx`, `api/workspace.mdx`, `api/sqlite-storage.mdx`, `sandbox.mdx` | docs |
| `.changeset/per-thread-permissions.md` (new) | patch |

**PR 3** (all under `examples/software-factory/` unless noted)

| File | Change |
|---|---|
| `controller/src/lib/builder-manifest.ts`, `server/src/builder-manifest.ts` | manifest v2 with a `target` block; target file retired |
| `controller/test/builder-manifest.test.ts`, `controller/test/builder-target-file.ts` (delete) | schema tests |
| `server/b4.config.ts`, `server/test/builder-config.test.ts`, `server/scripts/with-target.mjs` → `server/scripts/in-lane.mjs`, `server/package.json` | one builder for every target |
| `controller/src/lib/targets/workspace.ts` | `builderSandboxProvider()` takes no target; `isFactoryImage` |
| `controller/src/lib/config.ts`, `controller/src/lib/controller/workers.ts`, `controller/src/lib/runtime.ts`, `controller/src/cli.ts` | one builder endpoint; retired variables refused by name |
| `controller/src/lib/controller/factory.ts` | the two guards removed |
| `controller/test/config.test.ts`, `factory-builder-environment.test.ts` (delete), `factory-retry.test.ts`, `runtime.test.ts`, `cli.test.ts`, `served-builder.ts`, `serve-controller.ts`, `drafter-end-to-end.integration.test.ts` | tests follow |
| `controller/test/devkit-second-pin.ts` (new), `target-devkit-pin.integration.test.ts` | shared second-pin preparation |
| `controller/test/builder.integration.test.ts` | one builder, three threads, two targets, two pins |
| `README.md`, `.github/workflows/ci.yml:471-477` | quickstart and lane |

---

# PR 1: per-thread sandbox (image, policy, workspace)

```bash
git switch -c blove/thread-sandbox origin/main
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm --filter @b4run/cli... build
```

### Task 1: Prove the image already lives in the thread's record

The whole design rests on one reading of the Docker managed provider: its configured `image` is used only to resolve a NEW intent's identity, and everything after (create, reconnect, read, release, destroy) runs the identity recorded in the intent. This task turns that reading into a test. It passes on main; if it fails, STOP and report: the per-thread image then needs the image in `binding()` and a different plan.

**Files:**
- Modify: `packages/sandbox/test/managed-workspace.test.ts:44-111` (the `fixture()` helper) and append a `describe`

- [ ] **Step 1: Let the fixture build providers with other images**

Replace the signature and the `image` branch of `fixture()` (currently `function fixture() {` at line 48 and the `if (args[0] === "image")` line) and its tail:

```ts
function fixture(
  options: {
    /** The provider's configured image. */
    readonly image?: string
    /** What `docker image inspect --format {{.Id}} <ref>` answers per reference. */
    readonly identities?: Readonly<Record<string, string>>
  } = {},
) {
```

```ts
      if (args[0] === "image")
        return ok(
          args.includes("{{json .Config.Volumes}}")
            ? "null"
            : (options.identities?.[String(args.at(-1))] ?? `sha256:${"a".repeat(64)}`),
        )
```

and replace `const provider = createDockerManagedWorkspaces({ scope: "app", image: "tag", docker })` with:

```ts
  /** A provider over the SAME daemon and scope, as another process would construct it. */
  const providerFor = (image: string) =>
    createDockerManagedWorkspaces({ scope: "app", image, docker })
  const provider = providerFor(options.image ?? "tag")
```

and add `providerFor,` to the returned object (after `provider,`).

- [ ] **Step 2: Write the proof**

Append to the file:

```ts
describe("managed Docker: the image is the intent's, not the provider's", () => {
  const one = `sha256:${"a".repeat(64)}`
  const two = `sha256:${"b".repeat(64)}`

  it("reconnects, reads, releases and destroys in the recorded image, whatever image the provider was built with", async () => {
    const f = fixture({
      image: "factory:one",
      identities: { "factory:one": one, "factory:two": two },
    })
    const intent = await f.intent()
    expect(intent.environment.identity).toBe(one)
    const ready = await f.provider.create(intent, source, signal)
    // Another process's provider: same daemon, same scope, a different configured image.
    const other = f.providerFor("factory:two")
    const before = f.calls.length
    const session = await other.reconnect(ready, { network: { mode: "deny" } }, signal)
    const reader = (await other.openWorkspaceReader?.({
      workspace: ready,
      signal,
    })) as SandboxWorkspaceReader
    await reader.close()
    await other.release(session.reference, signal)
    await other.destroy({ intent, reference: ready.reference }, signal)
    const after = f.calls.slice(before)
    const started = after.filter((call) => call[0] === "run")
    // The session and the reader: each started from the recorded identity.
    expect(started.length).toBeGreaterThanOrEqual(2)
    for (const call of started) expect(call).toContain(one)
    // The other provider's image was never looked up, named or run.
    expect(after.some((call) => call.includes("factory:two") || call.includes(two))).toBe(false)
    expect(f.objects.size).toBe(0)
  })
})
```

- [ ] **Step 3: Run it**

```bash
source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @b4run/sandbox exec vitest --run --config vitest.config.ts test/managed-workspace.test.ts
```

Expected: PASS, every test in the file. If the new test FAILS, stop: report which call named `factory:two` or `two`.

- [ ] **Step 4: Prove the test binds (mutation check, not committed)**

In `packages/sandbox/src/docker/managed-workspace.ts`, inside `reconnect`, change the `intent.environment.identity,` argument before `"-c"` (line 411) to `opts.image,`. Rerun Step 3's command.

Expected: FAIL in "the image is the intent's" (the session was started from `factory:two`). Then restore the line exactly and confirm with `git diff --stat packages/sandbox/src` that the source file is unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/test/managed-workspace.test.ts
git commit -m "test(sandbox): a managed workspace runs in the image its intent recorded

A provider built with another image reconnects, reads, releases and
destroys a thread's workspace in the identity the intent recorded and
never names its own image: the image half of a per-thread sandbox is
already per thread in storage.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The thread-sandbox types and their verifiers in `@b4run/workspace`

**Files:**
- Modify: `packages/workspace/src/sandbox-types.ts:162-202`
- Modify: `packages/workspace/src/managed-workspace.ts:91-117`
- Create: `packages/workspace/src/thread-sandbox.ts`
- Modify: `packages/workspace/src/index.ts:23-35`, `packages/workspace/src/node.ts:14-21`
- Test: `packages/workspace/test/thread-sandbox.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/workspace/test/thread-sandbox.test.ts`:

```ts
import { describe, expect, expectTypeOf, it } from "vitest"
import type {
  ManagedWorkspaceProvider,
  SandboxConfig,
  ThreadSandbox,
  ThreadSandboxPolicy,
  ThreadSandboxResolver,
  WorkspaceEnvironment,
  WorkspaceResolverInput,
} from "../src/index.ts"
import {
  verifyImageReference,
  verifyThreadSandbox,
  verifyThreadSandboxPolicy,
  verifyThreadSandboxRecord,
} from "../src/node.ts"

describe("thread sandbox types", () => {
  it("SandboxConfig.thread is a resolver from the thread to its whole sandbox", () => {
    expectTypeOf<SandboxConfig["thread"]>().toEqualTypeOf<ThreadSandboxResolver | undefined>()
    expectTypeOf<Parameters<ThreadSandboxResolver>[0]>().toEqualTypeOf<WorkspaceResolverInput>()
    expectTypeOf<ReturnType<ThreadSandboxResolver>>().toEqualTypeOf<Promise<ThreadSandbox>>()
    expectTypeOf<ThreadSandbox["policy"]>().toEqualTypeOf<ThreadSandboxPolicy | undefined>()
    // `security` is the app's, never a thread's.
    expectTypeOf<keyof ThreadSandboxPolicy>().toEqualTypeOf<"network" | "env" | "resources">()
  })
  it("resolveImageEnvironment is an optional, presence-probed capability", () => {
    expectTypeOf<
      NonNullable<ManagedWorkspaceProvider["resolveImageEnvironment"]>
    >().toEqualTypeOf<(image: string, signal: AbortSignal) => Promise<WorkspaceEnvironment>>()
    const provider = {} as ManagedWorkspaceProvider
    expect(provider.resolveImageEnvironment).toBeUndefined()
  })
})

const workspace = { source: { directory: "src", include: ["a.ts"] } }

describe("verifyThreadSandbox", () => {
  it("accepts a workspace, an image and a policy, and freezes the result", () => {
    const verified = verifyThreadSandbox({
      workspace,
      environment: { image: "b4-factory-devkit:6a59e00aed46-0123456789ab" },
      policy: {
        network: { mode: "deny" },
        env: { B: "2", A: "1" },
        resources: { memoryMb: 2048, cpus: 1.5, timeoutMs: 60_000 },
      },
    })
    expect(verified.workspace).toBe(workspace)
    expect(verified.environment).toEqual({ image: "b4-factory-devkit:6a59e00aed46-0123456789ab" })
    expect(Object.keys(verified.policy?.env ?? {})).toEqual(["A", "B"])
    expect(Object.isFrozen(verified)).toBe(true)
    expect(Object.isFrozen(verified.policy)).toBe(true)
  })
  it("accepts a workspace alone", () => {
    expect(verifyThreadSandbox({ workspace })).toEqual({ workspace })
  })
  it.each([
    [{}, /must name its workspace/],
    [{ workspace, permissions: { allow: {} } }, /unsupported key permissions/],
    [{ workspace, polcy: {} }, /unsupported key polcy/],
    [{ workspace, environment: { image: "x", pull: true } }, /unsupported key pull/],
    [{ workspace, policy: { security: { runAsNonRoot: false } } }, /unsupported key security/],
    [null, /must be an object/],
  ])("refuses %j", (value, message) => {
    expect(() => verifyThreadSandbox(value)).toThrow(message)
  })
})

describe("verifyThreadSandboxPolicy", () => {
  it.each([
    [{ network: { mode: "deny", allowlist: ["10.0.0.0/8"] } }, /not enforced/],
    [{ network: { mode: "allow", denylist: ["169.254.169.254"] } }, /not enforced/],
    [{ network: { mode: "open" } }, /network.mode/],
    [{ env: { "1BAD": "x" } }, /not a valid variable name/],
    [{ env: { OK: "a\u0000b" } }, /without NUL/],
    [{ env: { OK: 1 } }, /without NUL/],
    [{ resources: { memoryMb: 0 } }, /memoryMb must be a positive integer/],
    [{ resources: { cpus: Number.NaN } }, /cpus must be a positive number/],
    [{ resources: { timeoutMs: 1.5 } }, /timeoutMs must be a positive integer/],
    [{ resources: { gpus: 1 } }, /unsupported key gpus/],
    [{ resources: { diskGb: 4 } }, /diskGb is not enforced/],
  ])("refuses %j", (value, message) => {
    expect(() => verifyThreadSandboxPolicy(value)).toThrow(message)
  })
})

describe("verifyImageReference", () => {
  it.each(["node:24-slim", "ghcr.io/org/app@sha256:" + "a".repeat(64), "b4-factory-cli:0123456789ab-ba9876543210"])(
    "accepts %s",
    (reference) => expect(verifyImageReference(reference)).toBe(reference),
  )
  it.each(["", "--privileged", "-x", "a b", "tag\n", "x".repeat(513), 42])("refuses %j", (reference) => {
    expect(() => verifyImageReference(reference)).toThrow(/image reference/)
  })
})

describe("verifyThreadSandboxRecord", () => {
  it("round-trips to one canonical text whatever the input's key order", () => {
    const a = verifyThreadSandboxRecord({
      policy: { resources: { memoryMb: 1 }, env: { B: "2", A: "1" } },
      image: "x:1",
      version: 1,
    })
    const b = verifyThreadSandboxRecord({
      version: 1,
      image: "x:1",
      policy: { env: { A: "1", B: "2" }, resources: { memoryMb: 1 } },
    })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(a)).toBe(
      '{"version":1,"image":"x:1","policy":{"env":{"A":"1","B":"2"},"resources":{"memoryMb":1}}}',
    )
  })
  it("refuses another version and unknown keys", () => {
    expect(() => verifyThreadSandboxRecord({ version: 2 })).toThrow(/version/)
    expect(() => verifyThreadSandboxRecord({ version: 1, extra: 1 })).toThrow(/unsupported key extra/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @b4run/workspace typecheck
pnpm --filter @b4run/workspace exec vitest --run --config vitest.config.ts test/thread-sandbox.test.ts
```

Expected: typecheck errors (`ThreadSandbox`, `ThreadSandboxResolver`, `ThreadSandboxPolicy` not exported; `thread` not in `SandboxConfig`; `resolveImageEnvironment` not in `ManagedWorkspaceProvider`); vitest fails to import `verifyThreadSandbox` from `../src/node.ts`.

- [ ] **Step 3: Add the types**

In `packages/workspace/src/sandbox-types.ts`, insert after the `WorkspaceResolver` type (line 185) and before `export interface SandboxConfig`:

```ts
/**
 * The part of a {@link SandboxPolicy} one thread may set for itself. `resources`
 * merge over the app's key by key, `env` replaces the app's whole, and `network`
 * may only keep or narrow the app's: a thread may not open a network the app's
 * policy denies. `security` is always the app's.
 */
export interface ThreadSandboxPolicy {
  readonly network?: SandboxPolicy["network"]
  readonly env?: SandboxPolicy["env"]
  /** Merged over the app's key by key. `diskGb` is not settable per thread: managed workspaces ignore it. */
  readonly resources?: Omit<NonNullable<SandboxPolicy["resources"]>, "diskGb">
}

/** One thread's whole sandbox, as a {@link ThreadSandboxResolver} decides it. */
export interface ThreadSandbox {
  /** The thread's initial workspace, exactly as a {@link WorkspaceResolver} returns one. */
  readonly workspace: WorkspaceDefinition | CapturedWorkspaceDefinition
  /**
   * Provider-interpreted. The Docker provider reads `image`, and runs it only if
   * it is the provider's own image or its `images` predicate allows it.
   */
  readonly environment?: { readonly image: string }
  readonly policy?: ThreadSandboxPolicy
}

/**
 * Host code that decides one thread's whole sandbox. Called once per thread, at
 * the thread's first admission, never again: the workspace is captured and
 * recorded by digest in the thread's creation intent, the image's immutable
 * identity is recorded there too, and the image reference and policy are kept
 * in a per-thread record beside it. Every later turn, restart and reader uses
 * the records. Exclusive with `SandboxConfig.workspace`.
 */
export type ThreadSandboxResolver = (thread: WorkspaceResolverInput) => Promise<ThreadSandbox>

/** What B4.run keeps for a thread whose sandbox was resolved per thread. Written once, with the association. */
export interface ThreadSandboxRecord {
  readonly version: 1
  /** The reference the resolver named. Its immutable identity is in the thread's intent. */
  readonly image?: string
  readonly policy?: ThreadSandboxPolicy
}
```

In the same file, add to `SandboxConfig` after `workspace`:

```ts
  /**
   * Decide each thread's whole sandbox (workspace, image, policy) once, at its
   * first admission. Exclusive with `workspace`. Requires a provider with
   * managed workspaces.
   */
  readonly thread?: ThreadSandboxResolver
```

In `packages/workspace/src/managed-workspace.ts`, add inside `ManagedWorkspaceProvider` after `resolveEnvironment`:

```ts
  /**
   * OPTIONAL capability: the environment for a thread that names its own image
   * (`SandboxConfig.thread` returning `environment.image`). Presence of the
   * method IS the capability probe: B4.run refuses a per-thread image on a
   * provider without it rather than run the thread in the default image. An
   * implementation MUST refuse, before any side effect, an image its operator
   * did not allow.
   */
  resolveImageEnvironment?(image: string, signal: AbortSignal): Promise<WorkspaceEnvironment>
```

In `packages/workspace/src/index.ts`, add to the `./sandbox-types.js` type export list: `ThreadSandbox`, `ThreadSandboxPolicy`, `ThreadSandboxRecord`, `ThreadSandboxResolver` (alphabetical, after `SandboxWorkspaceReader`).

- [ ] **Step 4: Add the verifiers**

Create `packages/workspace/src/thread-sandbox.ts`:

```ts
import type {
  SandboxPolicy,
  ThreadSandbox,
  ThreadSandboxPolicy,
  ThreadSandboxRecord,
} from "./sandbox-types.js"

/**
 * Validation for what a thread-sandbox resolver returns and what B4.run stores
 * for it. Strict everywhere: an unknown key is refused by name, never dropped,
 * because a dropped key is a thread silently running under the app's broader
 * default instead of what its resolver asked for.
 */

/** Letters, digits and `._/:@-`, not starting with a symbol: never readable as a CLI flag. */
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/

function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${what} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${what} must be a plain object`)
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Reflect.ownKeys(value).filter(
    (key) => typeof key !== "string" || !allowed.includes(key),
  )
  if (extra.length > 0)
    throw new Error(
      `${what} has unsupported key ${extra.map(String).join(", ")} (allowed: ${allowed.join(", ")})`,
    )
}

function positive(value: unknown, what: string, integer: boolean): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(`${what} must be a positive ${integer ? "integer" : "number"}`)
  return value
}

export function verifyImageReference(value: unknown): string {
  if (typeof value !== "string" || !IMAGE_REFERENCE.test(value))
    throw new Error(
      "A thread's image must be an image reference: letters, digits and ._/:@-, starting with a letter or digit, at most 512 characters",
    )
  return value
}

function network(value: unknown): SandboxPolicy["network"] {
  const n = plainObject(value, "policy.network")
  if ("allowlist" in n || "denylist" in n)
    throw new Error(
      "policy.network lists are not enforced by managed workspaces: a thread's network is deny or allow",
    )
  onlyKeys(n, ["mode"], "policy.network")
  if (n.mode !== "deny" && n.mode !== "allow")
    throw new Error('policy.network.mode must be "deny" or "allow"')
  return Object.freeze({ mode: n.mode })
}

function env(value: unknown): Readonly<Record<string, string>> {
  const e = plainObject(value, "policy.env")
  if (Reflect.ownKeys(e).some((key) => typeof key !== "string"))
    throw new Error("policy.env names must be strings")
  const names = Object.keys(e).sort()
  if (names.length > 256) throw new Error("policy.env has more than 256 variables")
  const out: Record<string, string> = {}
  for (const name of names) {
    if (!ENV_NAME.test(name))
      throw new Error(`policy.env name ${JSON.stringify(name)} is not a valid variable name`)
    const text = e[name]
    if (typeof text !== "string" || text.length > 32_768 || text.includes("\u0000"))
      throw new Error(`policy.env.${name} must be a string without NUL, at most 32768 characters`)
    out[name] = text
  }
  return Object.freeze(out)
}

function resources(value: unknown): NonNullable<ThreadSandboxPolicy["resources"]> {
  const r = plainObject(value, "policy.resources")
  if ("diskGb" in r)
    throw new Error(
      "policy.resources.diskGb is not enforced by managed workspaces: a thread cannot size its disk",
    )
  onlyKeys(r, ["memoryMb", "cpus", "timeoutMs"], "policy.resources")
  return Object.freeze({
    ...(r.memoryMb !== undefined
      ? { memoryMb: positive(r.memoryMb, "policy.resources.memoryMb", true) }
      : {}),
    ...(r.cpus !== undefined ? { cpus: positive(r.cpus, "policy.resources.cpus", false) } : {}),
    ...(r.timeoutMs !== undefined
      ? { timeoutMs: positive(r.timeoutMs, "policy.resources.timeoutMs", true) }
      : {}),
  })
}

/** A thread's policy overrides, normalized: fixed key order, sorted env names, frozen. */
export function verifyThreadSandboxPolicy(value: unknown): ThreadSandboxPolicy {
  const policy = plainObject(value, "A thread's sandbox policy")
  onlyKeys(policy, ["network", "env", "resources"], "A thread's sandbox policy")
  return Object.freeze({
    ...(policy.network !== undefined ? { network: network(policy.network) } : {}),
    ...(policy.env !== undefined ? { env: env(policy.env) } : {}),
    ...(policy.resources !== undefined ? { resources: resources(policy.resources) } : {}),
  })
}

/**
 * What a `ThreadSandboxResolver` returned, checked. The workspace is left as
 * returned: the caller captures a `WorkspaceDefinition` or verifies a
 * `CapturedWorkspaceDefinition` with the functions that own those shapes.
 */
export function verifyThreadSandbox(value: unknown): ThreadSandbox {
  const sandbox = plainObject(value, "A thread sandbox")
  onlyKeys(sandbox, ["workspace", "environment", "policy"], "A thread sandbox")
  const workspace = sandbox.workspace
  if (workspace === null || typeof workspace !== "object" || Array.isArray(workspace))
    throw new Error("A thread sandbox must name its workspace")
  let environment: ThreadSandbox["environment"]
  if (sandbox.environment !== undefined) {
    const e = plainObject(sandbox.environment, "environment")
    onlyKeys(e, ["image"], "environment")
    environment = Object.freeze({ image: verifyImageReference(e.image) })
  }
  const policy =
    sandbox.policy === undefined ? undefined : verifyThreadSandboxPolicy(sandbox.policy)
  return Object.freeze({
    workspace: workspace as ThreadSandbox["workspace"],
    ...(environment !== undefined ? { environment } : {}),
    ...(policy !== undefined ? { policy } : {}),
  })
}

/** The stored record, normalized so `JSON.stringify` of it is its one canonical text. */
export function verifyThreadSandboxRecord(value: unknown): ThreadSandboxRecord {
  const record = plainObject(value, "A thread sandbox record")
  onlyKeys(record, ["version", "image", "policy"], "A thread sandbox record")
  if (record.version !== 1) throw new Error("Unsupported thread sandbox record version")
  return Object.freeze({
    version: 1,
    ...(record.image !== undefined ? { image: verifyImageReference(record.image) } : {}),
    ...(record.policy !== undefined ? { policy: verifyThreadSandboxPolicy(record.policy) } : {}),
  })
}
```

In `packages/workspace/src/node.ts`, add:

```ts
export {
  verifyImageReference,
  verifyThreadSandbox,
  verifyThreadSandboxPolicy,
  verifyThreadSandboxRecord,
} from "./thread-sandbox.js"
```

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @b4run/workspace typecheck
pnpm --filter @b4run/workspace exec vitest --run --config vitest.config.ts test/thread-sandbox.test.ts
pnpm --filter @b4run/workspace test
pnpm --filter @b4run/workspace lint
```

Expected: all PASS. If `expectTypeOf<keyof ThreadSandboxPolicy>()` fails, the interface has a key other than the three: remove it.

- [ ] **Step 6: Build and commit**

```bash
pnpm --filter @b4run/workspace build
git add packages/workspace/src/sandbox-types.ts packages/workspace/src/managed-workspace.ts packages/workspace/src/thread-sandbox.ts packages/workspace/src/index.ts packages/workspace/src/node.ts packages/workspace/test/thread-sandbox.test.ts
git commit -m "feat(workspace): thread sandbox types and strict verifiers

SandboxConfig.thread resolves a thread's workspace, image and policy
once; ManagedWorkspaceProvider.resolveImageEnvironment is a presence-
probed capability. Unknown keys, network lists and flag-like image
references are refused by name.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The Docker provider resolves a thread's image, bounded by `images`

**Files:**
- Modify: `packages/sandbox/src/docker/managed-workspace.ts:50-54, 199-207`
- Modify: `packages/sandbox/src/docker/docker-sandbox.ts:13-20, 112-126, 221, 252, 315, 372`
- Test: `packages/sandbox/test/managed-workspace.test.ts`, `packages/sandbox/test/docker-sandbox.unit.test.ts`

- [ ] **Step 1: Let the fixture pass an `images` predicate**

In `fixture()` (Task 1), add to the options type:

```ts
    readonly images?: (reference: string) => boolean
```

and change `providerFor` to:

```ts
  const providerFor = (image: string | undefined, images = options.images) =>
    createDockerManagedWorkspaces({
      scope: "app",
      ...(image !== undefined ? { image } : {}),
      ...(images !== undefined ? { images } : {}),
      docker,
    })
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/sandbox/test/managed-workspace.test.ts`:

```ts
describe("managed Docker: per-thread images", () => {
  const one = `sha256:${"a".repeat(64)}`
  const two = `sha256:${"b".repeat(64)}`
  const identities = { "factory:one": one, "factory:two": two }

  it("resolves an allowed image to its own identity", async () => {
    const f = fixture({ image: "factory:one", identities, images: (ref) => ref === "factory:two" })
    const environment = await f.provider.resolveImageEnvironment?.("factory:two", signal)
    expect(environment).toEqual({
      binding: { provider: "docker", scope: "app", account: "daemon" },
      identity: two,
    })
    expect(f.calls).toContainEqual(["image", "inspect", "--format", "{{.Id}}", "factory:two"])
  })
  it("needs no predicate for its own image", async () => {
    const f = fixture({ image: "factory:one", identities })
    expect((await f.provider.resolveImageEnvironment?.("factory:one", signal))?.identity).toBe(one)
  })
  it.each([
    ["an image the predicate refuses", "factory:three"],
    ["a reference that reads as a flag", "--privileged"],
    ["a reference with whitespace", "factory two"],
  ])("refuses %s before any Docker call", async (_why, reference) => {
    const f = fixture({ image: "factory:one", identities, images: (ref) => ref === "factory:two" })
    await expect(f.provider.resolveImageEnvironment?.(reference, signal)).rejects.toMatchObject({
      code: "unsupported",
    })
    expect(f.calls).toEqual([])
  })
  it("refuses every other image when no predicate is configured", async () => {
    const f = fixture({ image: "factory:one", identities })
    await expect(f.provider.resolveImageEnvironment?.("factory:two", signal)).rejects.toMatchObject(
      { code: "unsupported" },
    )
    expect(f.calls).toEqual([])
  })
  it("lets a throwing predicate fail the admission rather than allow", async () => {
    const f = fixture({
      image: "factory:one",
      identities,
      images: () => {
        throw new Error("catalog unavailable")
      },
    })
    await expect(f.provider.resolveImageEnvironment?.("factory:two", signal)).rejects.toThrow(
      /catalog unavailable/,
    )
    expect(f.calls).toEqual([])
  })
  it("without a default image, refuses a thread that names none", async () => {
    const f = fixture({ identities, images: () => true })
    const bare = f.providerFor(undefined)
    await expect(bare.resolveEnvironment(signal)).rejects.toMatchObject({ code: "unsupported" })
    expect(f.calls).toEqual([])
    expect((await bare.resolveImageEnvironment?.("factory:two", signal))?.identity).toBe(two)
  })
})
```

Append to `packages/sandbox/test/docker-sandbox.unit.test.ts`:

```ts
describe("dockerSandbox image options", () => {
  test("needs an image, or an images predicate", () => {
    expect(() => dockerSandbox({ scope: "s" })).toThrow(/an image, or an images predicate/)
    expect(() => dockerSandbox({ scope: "s", image: " " })).toThrow(/an image, or an images/)
    expect(() => dockerSandbox({ scope: "s", images: "yes" as never })).toThrow(/images must be/)
  })
  test("with no default image, the per-app lifecycle refuses rather than guesses", async () => {
    const { docker, runs } = recordingDocker()
    const provider = dockerSandbox({ scope: "sandbox-test", images: () => true, docker })
    await expect(
      provider.acquire({ threadId: "t", policy: { network: { mode: "deny" } }, signal: signal() }),
    ).rejects.toThrow(/no default image/)
    await expect(
      provider.openWorkspaceReader?.({ threadId: "t", signal: signal() }),
    ).rejects.toThrow(/no default image/)
    expect(runs).toEqual([])
    await expect(provider.workspaces?.resolveEnvironment(signal())).rejects.toMatchObject({
      code: "unsupported",
    })
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

```bash
pnpm --filter @b4run/sandbox exec vitest --run --config vitest.config.ts test/managed-workspace.test.ts test/docker-sandbox.unit.test.ts
```

Expected: FAIL. `resolveImageEnvironment` is undefined (the optional-chained calls resolve to `undefined`, so `rejects` fails with "promise-like expected"), and `dockerSandbox({ scope: "s" })` does not throw.

- [ ] **Step 4: Implement the managed provider half**

In `packages/sandbox/src/docker/managed-workspace.ts`, add `verifyImageReference` to the `@b4run/workspace/node` import, change the options type:

```ts
export function createDockerManagedWorkspaces(opts: {
  scope: string
  /** The default image: what a thread that names none runs. Absent: every thread must name one. */
  image?: string
  /** Which other references a thread may name. The default image needs no entry. */
  images?: (reference: string) => boolean
  docker: Docker
}): ManagedWorkspaceProvider {
```

add, before `return {` (line 197):

```ts
  async function environmentFor(reference: string, signal: AbortSignal) {
    const account = (await run(["info", "--format", "{{.ID}}"], signal)).stdout.trim()
    const identity = (
      await run(["image", "inspect", "--format", "{{.Id}}", reference], signal)
    ).stdout.trim()
    if (!account || !/^sha256:[0-9a-f]{64}$/.test(identity))
      fail("unsupported", "Docker daemon/image identity unavailable")
    return { binding: { provider: "docker", scope: opts.scope, account }, identity }
  }
```

and replace the `resolveEnvironment` method with:

```ts
    async resolveEnvironment(signal) {
      if (opts.image === undefined)
        return fail(
          "unsupported",
          "This Docker provider has no default image: every thread must name its own (sandbox.thread)",
        )
      return environmentFor(opts.image, signal)
    },
    async resolveImageEnvironment(image, signal) {
      let reference: string
      try {
        reference = verifyImageReference(image)
      } catch (error) {
        return fail("unsupported", error instanceof Error ? error.message : String(error))
      }
      // Checked before any Docker call: a refused image costs nothing and creates nothing.
      if (reference !== opts.image && opts.images?.(reference) !== true)
        return fail(
          "unsupported",
          `Image ${reference} is not one this provider may run: allow it with dockerSandbox({ images })`,
        )
      return environmentFor(reference, signal)
    },
```

- [ ] **Step 5: Implement the provider options half**

In `packages/sandbox/src/docker/docker-sandbox.ts`, replace `DockerSandboxOptions`:

```ts
export interface DockerSandboxOptions {
  /** Stable application/environment identity. Changing it selects different storage. */
  readonly scope: string
  /**
   * Container image for the sandbox (must include a POSIX shell). Optional only
   * with `images`, for an app whose every thread names its own image
   * (`sandbox.thread`); the per-app lifecycle then refuses to start.
   */
  readonly image?: string
  /**
   * Managed workspaces: which image references a per-thread sandbox may name.
   * Called before any Docker call; anything but `true` refuses the thread.
   */
  readonly images?: (reference: string) => boolean
  /** Injected for tests; defaults to the real docker CLI. */
  readonly docker?: Docker
}
```

At the top of `dockerSandbox` (line 112), before `const resourceId`:

```ts
  if (opts.images !== undefined && typeof opts.images !== "function")
    throw new Error("dockerSandbox images must be a function of the image reference")
  if (
    opts.image === undefined
      ? opts.images === undefined
      : typeof opts.image !== "string" || !opts.image.trim()
  )
    throw new Error(
      "dockerSandbox needs an image, or an images predicate when every thread names its own image",
    )
  /** The per-app image. Absent only when every thread names its own, and then nothing here may guess one. */
  const defaultImage = (): string => {
    if (opts.image === undefined)
      throw sandboxUnavailable(
        "Sandbox unavailable: this Docker provider has no default image. Configure sandbox.thread so each thread names one.",
      )
    return opts.image
  }
```

Replace `opts.image` with `defaultImage()` at `keeperIdentity(opts.image, launchConfig)` (line 125), in both `docker run` argument lists (lines 221 and 252), and in `openWorkspaceReader` (`image: opts.image`, line 372). Make `openWorkspaceReader` reject rather than throw synchronously:

```ts
    openWorkspaceReader(input) {
      // Intentionally NOT inside lifecycle.runExclusive: a read must never wait
      // on (or be able to influence) the thread's keeper lifecycle.
      let image: string
      try {
        image = defaultImage()
      } catch (error) {
        return Promise.reject(error)
      }
      return openDockerWorkspaceReader(
        { docker, image, volume: volumeName(input.threadId), resourceId: resourceId(input.threadId) },
        input,
      )
    },
```

and replace the `workspaces:` line (315):

```ts
    workspaces: createDockerManagedWorkspaces({
      scope: opts.scope,
      ...(opts.image !== undefined ? { image: opts.image } : {}),
      ...(opts.images !== undefined ? { images: opts.images } : {}),
      docker,
    }),
```

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @b4run/sandbox typecheck
pnpm --filter @b4run/sandbox exec vitest --run --config vitest.config.ts test/managed-workspace.test.ts test/docker-sandbox.unit.test.ts
pnpm --filter @b4run/sandbox test
pnpm --filter @b4run/sandbox lint
```

Expected: all PASS (the whole package suite, not only the new tests: `keeperIdentity` is on the acquire path of every Docker unit test).

- [ ] **Step 7: Build and commit**

```bash
pnpm --filter @b4run/sandbox build
git add packages/sandbox/src/docker/managed-workspace.ts packages/sandbox/src/docker/docker-sandbox.ts packages/sandbox/test/managed-workspace.test.ts packages/sandbox/test/docker-sandbox.unit.test.ts
git commit -m "feat(sandbox): Docker managed workspaces resolve a thread's own image

resolveImageEnvironment runs the provider's image or one its images
predicate allows, and refuses anything else, flag-like references
included, before any Docker call. The default image becomes optional
with images; every per-app use of a missing default fails by name.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The installation store records a thread's sandbox with its association

**Files:**
- Create: `packages/sqlite-storage/src/workspace/thread-sandbox-store.ts`
- Modify: `packages/sqlite-storage/src/workspace/association-store.ts:11-18, 22-25, 139-156, 172-179`
- Modify: `packages/sqlite-storage/src/workspace/installation.ts:11-16, 242-296`
- Modify: `packages/sqlite-storage/src/index.ts`
- Test: `packages/sqlite-storage/test/workspace-thread-sandbox.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/sqlite-storage/test/workspace-thread-sandbox.test.ts`:

```ts
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ThreadSandboxRecord } from "@b4run/workspace"
import { createSourceBundle, createWorkspaceIntent } from "@b4run/workspace/node"
import { afterEach, expect, it } from "vitest"
import { openWorkspaceInstallation, openWorkspaceInstallationReader } from "../src/index.ts"

const roots: string[] = []
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "b4-thread-sandbox-"))
  roots.push(path)
  return path
}
const bundle = createSourceBundle([
  { path: "main.ts", bytes: new TextEncoder().encode("hello"), executable: false },
])
function intentFor(installationId: string, threadId: string) {
  return createWorkspaceIntent({
    operationId: randomUUID(),
    installationId,
    threadId,
    definition: { version: 1, source: bundle, environmentLinks: [] },
    environment: {
      binding: { provider: "fake", scope: "test", account: "local" },
      identity: "env-1",
    },
  })
}
const record: ThreadSandboxRecord = {
  version: 1,
  image: "factory:one",
  policy: { network: { mode: "deny" }, resources: { memoryMb: 512 } },
}

it("records a thread's sandbox with its association and reads it back after reopen", () => {
  const path = root()
  const owner = openWorkspaceInstallation(path)
  owner.sources.put(bundle)
  owner.associations.create(intentFor(owner.installationId, "one"), record)
  owner.associations.create(intentFor(owner.installationId, "two"))
  owner.close()
  const reopened = openWorkspaceInstallation(path)
  try {
    expect(reopened.threadSandboxes.get("one")).toEqual(record)
    expect(reopened.threadSandboxes.get("two")).toBeUndefined()
  } finally {
    reopened.close()
  }
})

it("writes no record when the association cannot be created", () => {
  const owner = openWorkspaceInstallation(root())
  try {
    // No retained source: the association refuses, and the record goes with it.
    expect(() =>
      owner.associations.create(intentFor(owner.installationId, "one"), record),
    ).toThrow(/source/i)
    expect(owner.associations.get("one")).toBeUndefined()
    expect(owner.threadSandboxes.get("one")).toBeUndefined()
  } finally {
    owner.close()
  }
})

it("writes no association when the record is invalid", () => {
  const owner = openWorkspaceInstallation(root())
  try {
    owner.sources.put(bundle)
    const invalid = { version: 1, policy: { network: { mode: "deny", allowlist: ["10.0.0.0/8"] } } }
    expect(() =>
      owner.associations.create(intentFor(owner.installationId, "one"), invalid as never),
    ).toThrow(/not enforced/)
    expect(owner.associations.get("one")).toBeUndefined()
  } finally {
    owner.close()
  }
})

it("is idempotent for the same record and refuses another one", () => {
  const owner = openWorkspaceInstallation(root())
  try {
    owner.sources.put(bundle)
    const intent = intentFor(owner.installationId, "one")
    owner.associations.create(intent, record)
    expect(owner.associations.create(intent, record).revision).toBe(1)
    expect(() => owner.associations.create(intent, { version: 1, image: "factory:two" })).toThrow(
      /thread sandbox conflict/i,
    )
    expect(() => owner.associations.create(intent)).toThrow(/thread sandbox conflict/i)
  } finally {
    owner.close()
  }
})

it("drops the record when the thread's deletion completes", () => {
  const owner = openWorkspaceInstallation(root())
  try {
    owner.sources.put(bundle)
    owner.associations.create(intentFor(owner.installationId, "one"), record)
    const deleting = owner.associations.beginDelete("one")
    expect(owner.threadSandboxes.get("one")).toEqual(record)
    owner.associations.completeDelete("one", deleting?.revision ?? 0)
    expect(owner.threadSandboxes.get("one")).toBeUndefined()
  } finally {
    owner.close()
  }
})

it("adds its tables to an installation whose associations predate them, recording nothing for those", () => {
  // The upgrade path: an installation from before per-thread sandboxes has associations and
  // no tables. Opening it must work (every existing managed-workspace app upgrades through
  // here); its old threads simply have no record. In thread mode the MANAGER refuses such a
  // thread at admission (Task 5), which is what keeps a lost record from failing open.
  const path = root()
  const first = openWorkspaceInstallation(path)
  first.sources.put(bundle)
  first.associations.create(intentFor(first.installationId, "old"))
  first.close()
  const db = new DatabaseSync(join(path, ".b4", "workspaces", "state.sqlite"))
  db.exec("DROP TABLE workspace_thread_sandboxes; DROP TABLE workspace_thread_sandbox_schema")
  db.close()
  const reopened = openWorkspaceInstallation(path)
  try {
    expect(reopened.associations.get("old")?.state).toBe("creating")
    expect(reopened.threadSandboxes.get("old")).toBeUndefined()
    reopened.associations.create(intentFor(reopened.installationId, "one"), record)
    expect(reopened.threadSandboxes.get("one")).toEqual(record)
  } finally {
    reopened.close()
  }
})

it("refuses a half-present schema", () => {
  const path = root()
  openWorkspaceInstallation(path).close()
  const db = new DatabaseSync(join(path, ".b4", "workspaces", "state.sqlite"))
  db.exec("DROP TABLE workspace_thread_sandboxes")
  db.close()
  expect(() => openWorkspaceInstallation(path)).toThrow(/Incomplete workspace thread sandbox schema/)
})

it("leaves the lock-free reader working beside the owner", () => {
  const path = root()
  const owner = openWorkspaceInstallation(path)
  try {
    owner.sources.put(bundle)
    owner.associations.create(intentFor(owner.installationId, "one"), record)
    const reader = openWorkspaceInstallationReader(path)
    try {
      expect(reader.associations.get("one")?.state).toBe("creating")
    } finally {
      reader.close()
    }
  } finally {
    owner.close()
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @b4run/sqlite-storage exec vitest --run --config vitest.config.ts test/workspace-thread-sandbox.test.ts
```

Expected: FAIL: `owner.threadSandboxes` is undefined; `create` ignores its second argument.

- [ ] **Step 3: Write the store**

Create `packages/sqlite-storage/src/workspace/thread-sandbox-store.ts`:

```ts
import type { DatabaseSync } from "node:sqlite"
import type { ThreadSandboxRecord } from "@b4run/workspace"
import { verifyThreadSandboxRecord } from "@b4run/workspace/node"

/** A thread's sandbox record: written once, with its association, and read on every admission. */
export interface WorkspaceThreadSandboxStore {
  get(threadId: string): ThreadSandboxRecord | undefined
}
/** Internal: rows change only inside the association store's own transactions. */
export interface WorkspaceThreadSandboxWriter extends WorkspaceThreadSandboxStore {
  insert(threadId: string, record: ThreadSandboxRecord): void
  remove(threadId: string): void
}

const MAX_RECORD_BYTES = 256 * 1024

/**
 * Create the record's tables if the installation predates them. Owner-only: it
 * runs under the admission lock, so no other writer races it; a reader never
 * calls it and never needs the tables.
 */
export function ensureWorkspaceThreadSandboxSchema(db: DatabaseSync): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace_thread_sandbox_schema','workspace_thread_sandboxes')",
    )
    .all()
  if (tables.length === 0) {
    db.exec("SAVEPOINT workspace_thread_sandbox_init")
    try {
      db.exec(`CREATE TABLE workspace_thread_sandbox_schema(version INTEGER PRIMARY KEY);
   INSERT INTO workspace_thread_sandbox_schema VALUES (1);
   CREATE TABLE workspace_thread_sandboxes(thread_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);`)
      db.exec("RELEASE workspace_thread_sandbox_init")
    } catch (error) {
      db.exec("ROLLBACK TO workspace_thread_sandbox_init; RELEASE workspace_thread_sandbox_init")
      throw error
    }
  } else if (tables.length !== 2) throw new Error("Incomplete workspace thread sandbox schema")
  const versions = db.prepare("SELECT version FROM workspace_thread_sandbox_schema").all()
  if (versions.length !== 1 || versions[0]?.version !== 1)
    throw new Error("Unsupported workspace thread sandbox schema version")
}

export function makeWorkspaceThreadSandboxStore(db: DatabaseSync): WorkspaceThreadSandboxWriter {
  const select = db.prepare("SELECT payload FROM workspace_thread_sandboxes WHERE thread_id=?")
  const insert = db.prepare("INSERT INTO workspace_thread_sandboxes VALUES (?,?)")
  const remove = db.prepare("DELETE FROM workspace_thread_sandboxes WHERE thread_id=?")
  function get(threadId: string): ThreadSandboxRecord | undefined {
    const row = select.get(threadId)
    if (!row) return undefined
    if (typeof row.payload !== "string" || Buffer.byteLength(row.payload) > MAX_RECORD_BYTES)
      throw new Error("Corrupt workspace thread sandbox")
    const record = verifyThreadSandboxRecord(JSON.parse(row.payload))
    if (JSON.stringify(record) !== row.payload)
      throw new Error("Noncanonical workspace thread sandbox")
    return record
  }
  return {
    get,
    insert(threadId, input) {
      const payload = JSON.stringify(verifyThreadSandboxRecord(input))
      if (Buffer.byteLength(payload) > MAX_RECORD_BYTES)
        throw new Error("Workspace thread sandbox exceeds size limit")
      insert.run(threadId, payload)
    },
    remove(threadId) {
      remove.run(threadId)
    },
  }
}
```

- [ ] **Step 4: Write it in the association's transaction**

In `packages/sqlite-storage/src/workspace/association-store.ts`:

Add imports:

```ts
import type { ThreadSandboxRecord } from "@b4run/workspace"
import { verifyReadyWorkspace, verifyThreadSandboxRecord, verifyWorkspaceIntent } from "@b4run/workspace/node"
import type { WorkspaceThreadSandboxWriter } from "./thread-sandbox-store.js"
```

(replace the existing `@b4run/workspace/node` import line). Change the interface's `create`:

```ts
  /** With `sandbox`, the thread's sandbox record is written in the same transaction. */
  create(intent: WorkspaceCreateIntent, sandbox?: ThreadSandboxRecord): WorkspaceAssociation
```

and the factory signature:

```ts
export function makeWorkspaceAssociationStore(
  db: DatabaseSync,
  sources: WorkspaceSourceStore,
  sandboxes?: WorkspaceThreadSandboxWriter,
): WorkspaceAssociationStore {
```

Replace `create(input) { ... }` with:

```ts
    create(input, sandbox) {
      return transaction(() => {
        const intent = verifyWorkspaceIntent(input)
        const record = sandbox === undefined ? undefined : verifyThreadSandboxRecord(sandbox)
        if (record !== undefined && sandboxes === undefined)
          throw new Error("Workspace thread sandbox storage is unavailable")
        const existing = get(intent.threadId)
        if (existing) {
          if (JSON.stringify(existing.intent) !== JSON.stringify(intent))
            throw new Error("Workspace creation intent conflict")
          if (JSON.stringify(sandboxes?.get(intent.threadId)) !== JSON.stringify(record))
            throw new Error("Workspace thread sandbox conflict")
          return existing
        }
        if (!sources.get(intent.sourceDigest))
          throw new Error("Workspace creation requires retained source")
        db.prepare("INSERT INTO workspace_associations VALUES (?,1,'creating',?)").run(
          intent.threadId,
          payload({ intent }),
        )
        if (record !== undefined) sandboxes?.insert(intent.threadId, record)
        return get(intent.threadId) as WorkspaceAssociation
      })
    },
```

and in `completeDelete`, before `return update(record, "deleted")`:

```ts
        const deleted = update(record, "deleted")
        sandboxes?.remove(threadId)
        return deleted
```

(replacing the `return update(record, "deleted")` line).

- [ ] **Step 5: Wire the owner**

In `packages/sqlite-storage/src/workspace/installation.ts`, import:

```ts
import {
  ensureWorkspaceThreadSandboxSchema,
  makeWorkspaceThreadSandboxStore,
  type WorkspaceThreadSandboxStore,
} from "./thread-sandbox-store.js"
```

add to `WorkspaceInstallation`:

```ts
  /** Per-thread sandbox records (`sandbox.thread`). Written by `associations.create`. */
  readonly threadSandboxes: WorkspaceThreadSandboxStore
```

In `openWorkspaceInstallation`, replace the two lines after `validateState(stateDb, id)` (line 242-244):

```ts
    validateState(stateDb, id)
    // Additive: an installation from before per-thread sandboxes gains the tables here.
    ensureWorkspaceThreadSandboxSchema(stateDb)
    const sources = makeWorkspaceSourceStore(stateDb)
    const sandboxes = makeWorkspaceThreadSandboxStore(stateDb)
    const associations = makeWorkspaceAssociationStore(stateDb, sources, sandboxes)
```

In the returned object, change `create(intent)` to pass the record through, and add the store:

```ts
        create(intent, sandbox) {
          requireOpen()
          if (intent.installationId !== id)
            throw new Error("Workspace installation identity mismatch")
          return associations.create(intent, sandbox)
        },
```

```ts
      threadSandboxes: {
        get(threadId) {
          requireOpen()
          return sandboxes.get(threadId)
        },
      },
```

`openWorkspaceInstallationReader` is unchanged: it neither creates nor reads the new tables.

In `packages/sqlite-storage/src/index.ts`, add:

```ts
export type { WorkspaceThreadSandboxStore } from "./workspace/thread-sandbox-store.js"
```

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @b4run/sqlite-storage typecheck
pnpm --filter @b4run/sqlite-storage exec vitest --run --config vitest.config.ts test/workspace-thread-sandbox.test.ts
pnpm --filter @b4run/sqlite-storage test
pnpm --filter @b4run/sqlite-storage lint
```

Expected: all PASS, including the existing `workspace-installation.test.ts` cases that drop or add tables (they check the five original tables, which are unchanged).

- [ ] **Step 7: Build and commit**

```bash
pnpm --filter @b4run/sqlite-storage build
git add packages/sqlite-storage/src/workspace/thread-sandbox-store.ts packages/sqlite-storage/src/workspace/association-store.ts packages/sqlite-storage/src/workspace/installation.ts packages/sqlite-storage/src/index.ts packages/sqlite-storage/test/workspace-thread-sandbox.test.ts
git commit -m "feat(sqlite-storage): record a thread's sandbox with its association

One savepoint writes the association and the thread's sandbox record,
or neither; a second creation must name the same record; completing a
deletion drops it. Older installations gain the tables on open.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The manager resolves a thread's sandbox once and reconnects it under its own policy

**Files:**
- Create: `packages/cli/src/lib/runtime/thread-policy.ts`
- Modify: `packages/cli/src/lib/runtime/managed-workspace-manager.ts:1-77, 112-159, 227-228`
- Test: `packages/cli/test/managed-workspace-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/thread-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { threadPolicy } from "../src/lib/runtime/thread-policy.ts"

describe("threadPolicy", () => {
  const app = {
    network: { mode: "allow" as const, denylist: ["169.254.169.254"] },
    env: { A: "1", B: "2" },
    resources: { memoryMb: 1024, timeoutMs: 60_000 },
    security: { runAsNonRoot: true },
  }
  it("is the app's policy when the thread set nothing", () => {
    expect(threadPolicy(app, undefined)).toBe(app)
    expect(threadPolicy(app, {})).toEqual(app)
  })
  it("merges resources key by key, the thread's keys winning", () => {
    expect(threadPolicy(app, { resources: { memoryMb: 4096, cpus: 2 } }).resources).toEqual({
      memoryMb: 4096,
      cpus: 2,
      timeoutMs: 60_000,
    })
  })
  it("replaces env whole", () => {
    expect(threadPolicy(app, { env: { C: "3" } }).env).toEqual({ C: "3" })
  })
  it("keeps the app's network object, denylist included, when the thread asks for the same mode", () => {
    expect(threadPolicy(app, { network: { mode: "allow" } }).network).toBe(app.network)
  })
  it("narrows an allowed network to deny", () => {
    expect(threadPolicy(app, { network: { mode: "deny" } }).network).toEqual({ mode: "deny" })
  })
  it("refuses to open a network the app denies", () => {
    expect(() =>
      threadPolicy({ ...app, network: { mode: "deny" } }, { network: { mode: "allow" } }),
    ).toThrow(/may not open the network/)
  })
  it("never takes security from the thread", () => {
    expect(threadPolicy(app, { resources: { cpus: 1 } }).security).toBe(app.security)
  })
})
```

Append to `packages/cli/test/managed-workspace-manager.test.ts` (add `SandboxPolicy` to the `@b4run/workspace` type import, `WorkspaceLifecycleError` as a value import from `@b4run/workspace`, and `type ResolvedThreadSandbox` to the manager import; `DatabaseSync` is already imported from `node:sqlite`):

```ts
function threadFixture(
  resolveThread: (thread: {
    readonly threadId: string
    readonly metadata: Readonly<Record<string, unknown>>
    readonly signal: AbortSignal
  }) => Promise<ResolvedThreadSandbox>,
  options: {
    readonly root?: string
    readonly refuse?: (image: string) => boolean
    readonly imageSupport?: boolean
    readonly appPolicy?: SandboxPolicy
  } = {},
) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "b4-managed-thread-"))
  if (options.root === undefined) roots.push(root)
  const installation = openWorkspaceInstallation(root)
  const physical = new Map<string, ReadyWorkspace>()
  const calls: string[] = []
  const base = makeProvider(installation, physical, calls)
  const policies = new Map<string, SandboxPolicy>()
  const provider: ManagedWorkspaceProvider = {
    ...base,
    async reconnect(workspace, policy, signal) {
      policies.set(workspace.reference.threadId, policy)
      return base.reconnect(workspace, policy, signal)
    },
    ...(options.imageSupport === false
      ? {}
      : {
          async resolveImageEnvironment(image: string) {
            calls.push(`image:${image}`)
            if (options.refuse?.(image))
              throw new WorkspaceLifecycleError("unsupported", `Image ${image} is not allowed`)
            return {
              binding: { provider: "fake", scope: "scope", account: "service" },
              identity: `snapshot@${image}`,
            }
          },
        }),
  }
  const manager = new ManagedWorkspaceManager({
    installation,
    provider,
    policy: options.appPolicy ?? { network: { mode: "deny" }, resources: { memoryMb: 1024 } },
    idleTimeoutMs: 0,
    resolveThread,
  })
  managers.push(manager)
  return { manager, installation, calls, policies, root }
}

const captured = (text: string): CapturedWorkspaceDefinition => ({
  version: 1,
  source: bundle(text),
  environmentLinks: [],
})

it("gives two threads their own image and policy, and reconnects each under its own", async () => {
  const { manager, installation, policies } = threadFixture(async (thread) =>
    thread.metadata.target === "b"
      ? { definition: captured("b"), image: "factory:b", policy: { resources: { memoryMb: 4096, cpus: 4 } } }
      : { definition: captured("a"), image: "factory:a", policy: { env: { TARGET: "a" } } },
  )
  const signal = new AbortController().signal
  await manager.getForThread("one", signal, { metadata: async () => ({ target: "a" }) })
  await manager.getForThread("two", signal, { metadata: async () => ({ target: "b" }) })
  expect(installation.associations.get("one")?.intent.environment.identity).toBe("snapshot@factory:a")
  expect(installation.associations.get("two")?.intent.environment.identity).toBe("snapshot@factory:b")
  expect(policies.get("one")).toEqual({
    network: { mode: "deny" },
    env: { TARGET: "a" },
    resources: { memoryMb: 1024 },
  })
  expect(policies.get("two")).toEqual({
    network: { mode: "deny" },
    resources: { memoryMb: 4096, cpus: 4 },
  })
  expect(installation.threadSandboxes.get("one")).toEqual({
    version: 1,
    image: "factory:a",
    policy: { env: { TARGET: "a" } },
  })
})

it("re-admits after a restart from the record, never calling the resolver again", async () => {
  let resolved = 0
  const first = threadFixture(async () => {
    resolved += 1
    return { definition: captured("a"), image: "factory:a", policy: { resources: { memoryMb: 2048 } } }
  })
  const signal = new AbortController().signal
  await first.manager.getForThread("one", signal)
  await first.manager.releaseAll()
  const second = threadFixture(
    async () => {
      throw new Error("the resolver must not run on re-admission")
    },
    { root: first.root },
  )
  await second.manager.getForThread("one", signal)
  expect(resolved).toBe(1)
  expect(second.policies.get("one")).toEqual({
    network: { mode: "deny" },
    resources: { memoryMb: 2048 },
  })
  expect(second.calls).toEqual(["reconnect"])
})

it("refuses an image the provider does not allow before creating anything", async () => {
  const { manager, installation, calls } = threadFixture(
    async () => ({ definition: captured("a"), image: "evil:latest" }),
    { refuse: (image) => image.startsWith("evil") },
  )
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toMatchObject({
    code: "unsupported",
  })
  expect(calls).toEqual(["image:evil:latest"])
  expect(installation.associations.get("one")).toBeUndefined()
  expect(installation.threadSandboxes.get("one")).toBeUndefined()
  expect(installation.sources.get(bundle("a").digest)).toBeUndefined()
})

it("refuses a per-thread image on a provider that cannot select one", async () => {
  const { manager, installation, calls } = threadFixture(
    async () => ({ definition: captured("a"), image: "factory:a" }),
    { imageSupport: false },
  )
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toThrow(
    /cannot run a per-thread image/,
  )
  expect(calls).toEqual([])
  expect(installation.associations.get("one")).toBeUndefined()
})

it("refuses a thread policy that opens the network the app denies, before any provider call", async () => {
  const { manager, installation, calls } = threadFixture(async () => ({
    definition: captured("a"),
    policy: { network: { mode: "allow" } },
  }))
  await expect(manager.getForThread("one", new AbortController().signal)).rejects.toThrow(
    /may not open the network/,
  )
  expect(calls).toEqual([])
  expect(installation.associations.get("one")).toBeUndefined()
})

it("keeps the app's policy for a thread whose resolver set none", async () => {
  const { manager, policies, calls } = threadFixture(async () => ({
    definition: captured("a"),
  }))
  await manager.getForThread("one", new AbortController().signal)
  expect(policies.get("one")).toEqual({ network: { mode: "deny" }, resources: { memoryMb: 1024 } })
  expect(calls).toEqual(["inspect", "create", "reconnect"])
})

it("resolves a thread's sandbox once when two first admissions overlap", async () => {
  let resolved = 0
  const { manager } = threadFixture(async () => {
    resolved += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { definition: captured("a"), image: "factory:a" }
  })
  const signal = new AbortController().signal
  await Promise.all([manager.getForThread("one", signal), manager.getForThread("one", signal)])
  expect(resolved).toBe(1)
})

it("records every thread it admits, { version: 1 } when the resolver chose nothing", async () => {
  const { manager, installation } = threadFixture(async () => ({ definition: captured("a") }))
  await manager.getForThread("one", new AbortController().signal)
  expect(installation.threadSandboxes.get("one")).toEqual({ version: 1 })
})

it("refuses a thread admitted before the app resolved sandboxes per thread", async () => {
  // The app ran with a static workspace, then switched to sandbox.thread: its old thread has an
  // association and no sandbox record, and must not run under the app's defaults silently.
  const root = mkdtempSync(join(tmpdir(), "b4-managed-thread-"))
  roots.push(root)
  const before = fixture(root)
  await before.manager.getForThread("one", new AbortController().signal)
  await before.manager.releaseAll()
  let resolved = 0
  const after = threadFixture(
    async () => {
      resolved += 1
      return { definition: captured("a") }
    },
    { root },
  )
  await expect(after.manager.getForThread("one", new AbortController().signal)).rejects.toMatchObject({
    code: "conflict",
    message: expect.stringMatching(/thread one has no sandbox record/i),
  })
  expect(resolved).toBe(0)
  expect(after.calls).toEqual([])
})

it("refuses a thread whose record was lost with its table", async () => {
  const first = threadFixture(async () => ({ definition: captured("a"), image: "factory:a" }))
  await first.manager.getForThread("one", new AbortController().signal)
  await first.manager.releaseAll()
  const db = new DatabaseSync(join(first.root, ".b4", "workspaces", "state.sqlite"))
  db.exec("DROP TABLE workspace_thread_sandboxes; DROP TABLE workspace_thread_sandbox_schema")
  db.close()
  // Reopening recreates the tables empty (the upgrade path); admission is what refuses.
  const second = threadFixture(async () => ({ definition: captured("a") }), { root: first.root })
  await expect(second.manager.getForThread("one", new AbortController().signal)).rejects.toMatchObject({
    code: "conflict",
  })
  expect(second.calls).toEqual([])
})

it("refuses a thread resolver beside a workspace definition or resolver", () => {
  const root = mkdtempSync(join(tmpdir(), "b4-managed-thread-"))
  roots.push(root)
  const installation = openWorkspaceInstallation(root)
  try {
    const provider = makeProvider(installation, new Map(), [])
    const common = { installation, provider, policy: { network: { mode: "deny" as const } }, idleTimeoutMs: 0 }
    const resolveThread = async () => ({ definition: captured("a") })
    expect(
      () => new ManagedWorkspaceManager({ ...common, resolveThread, definition: captured("a") }),
    ).toThrow(/exclusive/)
    expect(
      () =>
        new ManagedWorkspaceManager({ ...common, resolveThread, captureDefinition: async () => captured("a") }),
    ).toThrow(/exclusive/)
  } finally {
    installation.close()
  }
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-manager.test.ts test/thread-policy.test.ts
```

Expected: FAIL. `thread-policy.test.ts` cannot import `../src/lib/runtime/thread-policy.ts` (the file does not exist yet). In the manager file the type-only `ResolvedThreadSandbox` import is erased at run time, so the new cases fail at construction: the manager ignores the unknown `resolveThread` option and its constructor throws "Managed workspaces need a definition or a resolver". (`pnpm --filter @b4run/cli typecheck` would also refuse the option.)

- [ ] **Step 3: Write `threadPolicy`**

Create `packages/cli/src/lib/runtime/thread-policy.ts`:

```ts
import {
  type SandboxPolicy,
  type ThreadSandboxPolicy,
  WorkspaceLifecycleError,
} from "@b4run/workspace"

/**
 * The policy one thread's session runs under, from the app's and the thread's
 * recorded overrides:
 * - `resources` merge key by key; the thread's keys win.
 * - `env` replaces the app's whole.
 * - `network` keeps or narrows the app's. A thread mode equal to the app's keeps
 *   the app's network object (an app `allow` keeps its `denylist`); a thread
 *   `deny` under an app `allow` is `{ mode: "deny" }`; a thread `allow` under an
 *   app `deny` is refused rather than narrowed, so a resolver asking for more
 *   than the app grants hears about it. Checked again at every reconnect, so an
 *   app that later denies the network also stops threads that asked earlier.
 * - `security` is always the app's.
 */
export function threadPolicy(
  app: SandboxPolicy,
  thread: ThreadSandboxPolicy | undefined,
): SandboxPolicy {
  if (thread === undefined) return app
  const asked = thread.network?.mode
  if (app.network.mode === "deny" && asked === "allow")
    throw new WorkspaceLifecycleError(
      "unsupported",
      "A thread's sandbox policy may not open the network the app's policy denies",
    )
  const network: SandboxPolicy["network"] =
    asked === undefined || asked === app.network.mode ? app.network : { mode: "deny" }
  const env = thread.env ?? app.env
  const resources =
    thread.resources === undefined ? app.resources : { ...app.resources, ...thread.resources }
  return {
    network,
    ...(env !== undefined ? { env } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(app.security !== undefined ? { security: app.security } : {}),
  }
}
```

- [ ] **Step 4: Teach the manager**

In `packages/cli/src/lib/runtime/managed-workspace-manager.ts`:

Extend the imports:

```ts
import {
  type CapturedWorkspaceDefinition,
  type ManagedWorkspaceProvider,
  type ReadyWorkspace,
  type SandboxHandle,
  type SandboxPolicy,
  type SourceBundle,
  type ThreadSandboxPolicy,
  type ThreadSandboxRecord,
  type WorkspaceEnvironment,
  WorkspaceLifecycleError,
  type WorkspaceSession,
  type WorkspaceSessionReference,
} from "@b4run/workspace"
import {
  createWorkspaceIntent,
  readSourceFile,
  verifyCapturedWorkspaceDefinition,
  verifyCreationStatus,
  verifyReadyWorkspace,
  verifyThreadSandboxRecord,
} from "@b4run/workspace/node"
import { threadPolicy } from "./thread-policy.js"
```

Add after `WorkspaceAdmissionContext`:

```ts
/** What a thread-sandbox resolver decided, with its workspace already captured. */
export interface ResolvedThreadSandbox {
  readonly definition: CapturedWorkspaceDefinition
  /** Handed to `provider.resolveImageEnvironment`; the identity it answers is recorded in the intent. */
  readonly image?: string
  readonly policy?: ThreadSandboxPolicy
}
```

Add to `ManagedWorkspaceManagerOptions`, after `captureDefinition`:

```ts
  /**
   * Called once per thread, at first admission, to decide the thread's whole
   * sandbox. Exclusive with `definition` and `captureDefinition`. Its image
   * and policy are recorded with the association; every later admission,
   * restart included, reads the record and never calls this again.
   */
  resolveThread?: (thread: {
    readonly threadId: string
    readonly metadata: Readonly<Record<string, unknown>>
    readonly signal: AbortSignal
  }) => Promise<ResolvedThreadSandbox>
```

Replace the two constructor checks (lines 71-72) with:

```ts
    if (options.resolveThread && (options.definition || options.captureDefinition))
      throw new Error(
        "A thread sandbox resolver is exclusive with a workspace definition or workspace resolver",
      )
    if (!options.definition && !options.captureDefinition && !options.resolveThread)
      throw new Error("Managed workspaces need a definition or a resolver")
```

Before that block, right after the `deleting`/`deleted` refusal (line 126), add the missing-record refusal (D11):

```ts
      // In thread mode every admitted thread has a record ({ version: 1 } at least). A thread
      // with an association and none was admitted before the app switched to sandbox.thread,
      // or its record was lost: re-admitting it would silently run the app's defaults.
      if (record && this.#options.resolveThread && !installation.threadSandboxes.get(threadId))
        throw new WorkspaceLifecycleError(
          "conflict",
          `Thread ${threadId} has no sandbox record: it was admitted before sandbox.thread was configured, or its record was lost. Delete the thread to resolve its sandbox again.`,
        )
```

Then replace the whole `if (!record) { ... }` block (lines 127-159) with:

```ts
      if (!record) {
        // The resolver runs exactly here: a thread with no record. Every later
        // admission of this thread finds the record and never reaches this branch.
        const resolved = await this.#resolve(threadId, context, signal)
        const definition = verifyCapturedWorkspaceDefinition(resolved.definition)
        signal.throwIfAborted()
        // Refused before any provider call: a thread may not widen the app's network.
        threadPolicy(policy, resolved.sandbox?.policy)
        const environment =
          resolved.sandbox?.image === undefined
            ? await provider.resolveEnvironment(signal)
            : await this.#imageEnvironment(resolved.sandbox.image, signal)
        signal.throwIfAborted()
        // Stored only once the environment resolved: a refused image or an
        // unavailable daemon leaves no source row behind.
        installation.sources.put(definition.source)
        record = installation.associations.create(
          createWorkspaceIntent({
            installationId: installation.installationId,
            operationId: randomUUID(),
            threadId,
            definition,
            environment,
          }),
          resolved.sandbox,
        )
      }
```

Replace `const session = await provider.reconnect(ready, policy, signal)` (line 228) with:

```ts
      const session = await provider.reconnect(
        ready,
        threadPolicy(policy, installation.threadSandboxes.get(threadId)?.policy),
        signal,
      )
```

Add the two private methods after `#serial`:

```ts
  /** The thread's definition and, for a thread-sandbox resolver, its record. */
  async #resolve(
    threadId: string,
    context: WorkspaceAdmissionContext,
    signal: AbortSignal,
  ): Promise<{ definition: CapturedWorkspaceDefinition; sandbox?: ThreadSandboxRecord }> {
    const { captureDefinition, resolveThread } = this.#options
    if (!captureDefinition && !resolveThread) {
      if (!this.#definition) throw new Error("Managed workspaces need a definition or a resolver")
      return { definition: this.#definition }
    }
    const raw: unknown = await context.metadata?.(signal)
    const metadata: Readonly<Record<string, unknown>> =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? Object.freeze({ ...(raw as Record<string, unknown>) })
        : Object.freeze({})
    if (resolveThread) {
      const result = await resolveThread({ threadId, metadata, signal })
      if (!result?.definition)
        throw new Error("The thread sandbox resolver returned no workspace definition")
      // Always a record, even an empty one: "no record" must only ever mean "not admitted in
      // thread mode" or "lost", both of which admission refuses (D11).
      const sandbox = verifyThreadSandboxRecord({
        version: 1,
        ...(result.image !== undefined ? { image: result.image } : {}),
        ...(result.policy !== undefined ? { policy: result.policy } : {}),
      })
      return { definition: result.definition, sandbox }
    }
    const definition = await captureDefinition?.({ threadId, metadata, signal })
    if (!definition) throw new Error("The workspace resolver returned no workspace definition")
    return { definition }
  }
  /** The environment for a thread that names its image. A provider without the capability refuses it. */
  async #imageEnvironment(image: string, signal: AbortSignal): Promise<WorkspaceEnvironment> {
    const { provider } = this.#options
    if (typeof provider.resolveImageEnvironment !== "function")
      throw new WorkspaceLifecycleError(
        "unsupported",
        `Managed workspace provider "${provider.name}" cannot run a per-thread image`,
      )
    return provider.resolveImageEnvironment(image, signal)
  }
```

The `const { installation, provider, policy } = this.#options` line stays: `policy` is now the app policy handed to `threadPolicy`.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @b4run/cli typecheck
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-manager.test.ts test/thread-policy.test.ts test/cleanup-workspaces.test.ts test/managed-workspace-reader.test.ts
```

Expected: all PASS, the existing resolver cases included ("leaves no source when the resolver ignores the abort signal" now also holds because the source is stored later).

- [ ] **Step 6: Commit**

```bash
pnpm --filter @b4run/cli lint
git add packages/cli/src/lib/runtime/thread-policy.ts packages/cli/src/lib/runtime/managed-workspace-manager.ts packages/cli/test/managed-workspace-manager.test.ts packages/cli/test/thread-policy.test.ts
git commit -m "feat(cli): the managed workspace manager resolves a thread's whole sandbox once

A thread-sandbox resolver's image goes through the provider's
resolveImageEnvironment and its identity into the intent; its image and
policy are recorded with the association, { version: 1 } at least, and a thread-mode admission of a
thread with no record is refused. Every reconnect runs the thread's
recorded policy over the app's (resources merged, env replaced, network
kept or narrowed). The source is stored only after the environment
resolves.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The build artifact gains a thread form

**Files:**
- Modify: `packages/cli/src/lib/build/workspace-artifact.ts:18-23, 91-103`
- Modify: `packages/cli/src/lib/runtime/resolve-sandbox.ts:50`
- Test: `packages/cli/test/workspace-build-artifact.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/workspace-build-artifact.test.ts` (add `threadSandboxArtifact` to the imports from `../src/lib/build/workspace-artifact.ts`, and `describe` to the `vitest` import):

```ts
describe("thread sandbox artifact", () => {
  const definition = { source: { directory: ".", include: [] as string[] } }
  it("is a tagged record with nothing captured", () => {
    expect(threadSandboxArtifact()).toEqual({ version: 2, kind: "thread" })
    expect(Object.isFrozen(threadSandboxArtifact())).toBe(true)
  })
  it("verifies as its own form only", () => {
    expect(() => verifyWorkspaceResolverArtifact({ version: 2, kind: "thread" }, "thread")).not.toThrow()
    expect(() => verifyWorkspaceResolverArtifact({ version: 2, kind: "resolver" }, "resolver")).not.toThrow()
    expect(() => verifyWorkspaceResolverArtifact({ version: 2, kind: "resolver" }, "thread")).toThrow(
      /configuration changed; rebuild/,
    )
    expect(() => verifyWorkspaceResolverArtifact({ version: 2, kind: "thread" }, "resolver")).toThrow(
      /configuration changed; rebuild/,
    )
    expect(() => verifyWorkspaceArtifact({ version: 2, kind: "thread" }, definition)).toThrow(
      /configuration changed; rebuild/,
    )
    expect(() => verifyWorkspaceResolverArtifact({ version: 2, kind: "other" }, "thread")).toThrow(
      /Invalid workspace build artifact/,
    )
    expect(() =>
      verifyWorkspaceResolverArtifact({ version: 2, kind: "thread", extra: 1 }, "thread"),
    ).toThrow(/Invalid workspace build artifact/)
  })
})
```

The parameter becomes required: add `"resolver"` as the second argument to the four existing one-argument calls at lines 62, 72, 78 and 79 of the same file.

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/workspace-build-artifact.test.ts
```

Expected: FAIL: `threadSandboxArtifact` is not exported.

- [ ] **Step 3: Implement**

In `packages/cli/src/lib/build/workspace-artifact.ts`, replace the `WorkspaceBuildArtifact` alias (line 23) with:

```ts
/** A thread-sandbox resolver: nothing to capture at build time. Boot verifies the config is still one. */
export interface ThreadSandboxBuildArtifact {
  readonly version: 2
  readonly kind: "thread"
}
export type WorkspaceBuildArtifact =
  | CapturedWorkspaceBuildArtifact
  | ResolverWorkspaceBuildArtifact
  | ThreadSandboxBuildArtifact

export function threadSandboxArtifact(): ThreadSandboxBuildArtifact {
  return Object.freeze({ version: 2, kind: "thread" })
}
```

Replace `verifyWorkspaceResolverArtifact` (lines 91-103):

```ts
/**
 * Verify a resolver artifact of `kind`. A static artifact, or the other
 * resolver kind, means the config changed form since the build.
 */
export function verifyWorkspaceResolverArtifact(
  value: unknown,
  kind: "resolver" | "thread",
): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workspace build artifact; rebuild the app")
  const record = value as Record<string, unknown>
  if (record.version === 1) throw new Error("Workspace configuration changed; rebuild the app")
  if (
    Object.keys(record).sort().join(",") !== "kind,version" ||
    record.version !== 2 ||
    (record.kind !== "resolver" && record.kind !== "thread")
  )
    throw new Error("Invalid workspace build artifact; rebuild the app")
  if (record.kind !== kind) throw new Error("Workspace configuration changed; rebuild the app")
}
```

`verifyWorkspaceArtifact` already refuses any `version: 2` as a change of form; leave it. In `packages/cli/src/lib/runtime/resolve-sandbox.ts:50`, `verifyWorkspaceResolverArtifact(options.artifact)` becomes `verifyWorkspaceResolverArtifact(options.artifact, "resolver")`.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @b4run/cli typecheck
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/workspace-build-artifact.test.ts test/managed-workspace-runtime.test.ts
```

Expected: all PASS (the existing "refuses to boot a resolver app from a stale static artifact" and its reverse still read "rebuild").

- [ ] **Step 5: Commit**

```bash
pnpm --filter @b4run/cli lint
git add packages/cli/src/lib/build/workspace-artifact.ts packages/cli/src/lib/runtime/resolve-sandbox.ts packages/cli/test/workspace-build-artifact.test.ts
git commit -m "feat(cli): a { version: 2, kind: \"thread\" } workspace build artifact

The resolver verifier takes the kind it expects; any mismatch among the
static, resolver and thread forms is the rebuild error.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `sandbox.thread` in configuration: shape validation, boot, build, `b4 check`

**Files:**
- Create: `packages/cli/src/lib/runtime/sandbox-config-shape.ts`
- Modify: `packages/cli/src/lib/runtime/collect-sandbox-errors.ts:12-43`
- Modify: `packages/cli/src/lib/runtime/resolve-sandbox.ts:20-106`
- Modify: `packages/cli/src/lib/runtime/execute-route-core.ts:979`
- Modify: `packages/cli/src/commands/check.ts:145-146`
- Modify: `packages/cli/src/commands/build.ts:93-102`
- Test: `packages/cli/test/collect-sandbox-errors.test.ts`, `packages/cli/test/resolve-sandbox.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/collect-sandbox-errors.test.ts` (add `import { managedProviderFixture } from "./support/managed-provider.ts"` and `import { kubernetesSandbox } from "@b4run/sandbox"`; `@b4run/sandbox` is already a dependency of `@b4run/cli`. If the Kubernetes provider's `preflight` also reports an error against the stub client, that is an extra line in `errors`, not a failure of this assertion):

```ts
describe("collectSandboxErrors: thread sandbox", () => {
  const appRootWithWorkspace = async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "b4-thread-check-"))
    await mkdir(join(appRoot, "workspace"))
    return appRoot
  }
  const workspace = { source: { directory: ".", include: [] as string[] } }
  it("accepts a thread resolver on a managed provider without calling it", async () => {
    let called = false
    const { errors } = await collectSandboxErrors(
      {
        sandbox: {
          provider: managedProviderFixture().provider,
          thread: async () => {
            called = true
            throw new Error("never at check time")
          },
        },
      },
      await appRootWithWorkspace(),
    )
    expect(errors).toEqual([])
    expect(called).toBe(false)
  })
  it.each([
    [
      "thread beside a static workspace",
      { thread: async () => ({ workspace }), workspace },
      /sandbox.thread and sandbox.workspace are exclusive/,
    ],
    ["a thread that is not a function", { thread: { image: "x" } }, /sandbox.thread must be a function/],
    ["a misspelt key", { thred: async () => ({ workspace }) }, /sandbox.thred is not a sandbox option/],
  ])("refuses %s", async (_name, extra, message) => {
    const { errors } = await collectSandboxErrors(
      { sandbox: { provider: managedProviderFixture().provider, ...extra } as never },
      await appRootWithWorkspace(),
    )
    expect(errors.join("\n")).toMatch(message)
  })
  it("refuses a thread resolver on a provider without managed workspaces", async () => {
    const { errors } = await collectSandboxErrors(
      { sandbox: { provider: fakeSandbox(), thread: async () => ({ workspace }) } },
      await appRootWithWorkspace(),
    )
    expect(errors.join("\n")).toMatch(/does not support managed workspaces/)
  })
  it("refuses a thread resolver on the real Kubernetes provider (D4)", async () => {
    // A stub client: construction touches no cluster, and the refusal comes before any call.
    const provider = kubernetesSandbox({ scope: "k8s-thread-test", image: "i", client: {} as never })
    expect(provider.workspaces).toBeUndefined()
    const { errors } = await collectSandboxErrors(
      { sandbox: { provider, thread: async () => ({ workspace }) } },
      await appRootWithWorkspace(),
    )
    expect(errors.join("\n")).toMatch(/does not support managed workspaces/)
  })
})
```

Append to `packages/cli/test/resolve-sandbox.test.ts`, inside the `describe("resolveSandboxManager", ...)` (add `stat` to the `node:fs/promises` import):

```ts
  async function writeThreadApp(sandboxBody: string): Promise<string> {
    const appRoot = await mkdtemp(join(tmpdir(), "b4-sbx-thread-"))
    await mkdir(join(appRoot, "workspace"), { recursive: true })
    await writeFile(
      join(appRoot, "b4.config.ts"),
      [
        `import { managedProviderFixture } from ${JSON.stringify(fixtureUrl)}`,
        `import { fakeSandbox } from "@b4run/sandbox/testing"`,
        `import { kubernetesSandbox } from "@b4run/sandbox"`,
        `export default { sandbox: ${sandboxBody} }`,
      ].join("\n"),
      "utf8",
    )
    return appRoot
  }

  test("builds a managed manager from a thread resolver in development mode", async () => {
    const appRoot = await writeThreadApp(
      `{ provider: managedProviderFixture().provider, thread: async () => ({ workspace: { source: { directory: ".", include: ["b4.config.ts"], excludeDirectories: [".b4"] } } }) }`,
    )
    const mgr = await resolveSandboxManager(appRoot)
    expect(mgr?.managed).toBe(true)
    await mgr?.releaseAll()
  })

  test.each([
    [
      "a thread resolver beside a workspace",
      `{ provider: managedProviderFixture().provider, thread: async () => ({}), workspace: { source: { directory: ".", include: [] } } }`,
      /exclusive/,
    ],
    [
      "a misspelt key",
      `{ provider: managedProviderFixture().provider, thred: async () => ({}) }`,
      /sandbox.thred is not a sandbox option/,
    ],
    [
      "a thread resolver on a provider without managed workspaces",
      `{ provider: fakeSandbox(), thread: async () => ({}) }`,
      /does not support managed workspaces/,
    ],
    [
      "a thread resolver on the real Kubernetes provider (stub client, no cluster)",
      `{ provider: kubernetesSandbox({ scope: "k8s-thread-test", image: "i", client: {} }), thread: async () => ({}) }`,
      /does not support managed workspaces/,
    ],
  ])("refuses %s at boot, before opening the installation", async (_name, body, message) => {
    const appRoot = await writeThreadApp(body)
    await expect(resolveSandboxManager(appRoot)).rejects.toThrow(message)
    await expect(stat(join(appRoot, ".b4", "workspaces"))).rejects.toThrow()
  })
```

Append to `packages/cli/test/managed-workspace-runtime.test.ts` (it already has `fixture`, `seedB4Config` and `runBuildCommand`):

```ts
it("fails b4 build on a misspelt sandbox key even with no workspace or thread", async () => {
  const { appRoot } = await fixture()
  const physical = managedProviderFixture()
  seedB4Config(appRoot, {
    build: { targets: ["node"] },
    sandbox: { provider: physical.provider, thred: async () => ({}) },
  } as never)
  await expect(
    runBuildCommand({ cwd: appRoot, clean: true }, { stdout: () => {}, stderr: () => {} }),
  ).rejects.toThrow(/sandbox.thred is not a sandbox option/)
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/collect-sandbox-errors.test.ts test/resolve-sandbox.test.ts test/managed-workspace-runtime.test.ts
```

Expected: FAIL: no errors for the refused shapes; `resolveSandboxManager` returns a non-managed manager for a `thread` app.

- [ ] **Step 3: Write the shape check**

Create `packages/cli/src/lib/runtime/sandbox-config-shape.ts`:

```ts
/**
 * The `sandbox` block's shape, checked where the config is used: `b4 check`,
 * `b4 build` and boot. B4Config has no runtime schema, so without this a
 * misspelt `thred:` would be dropped silently and every thread would run in a
 * per-app sandbox under the app's policy and permissions: a fail-open on a typo.
 */
const SANDBOX_KEYS = [
  "workspace",
  "thread",
  "provider",
  "network",
  "env",
  "resources",
  "security",
  "idleTimeoutMs",
] as const

export function sandboxConfigShapeErrors(sandbox: unknown): string[] {
  if (sandbox === undefined) return []
  if (sandbox === null || typeof sandbox !== "object" || Array.isArray(sandbox))
    return ["b4.config sandbox must be an object."]
  const block = sandbox as Record<string, unknown>
  const errors: string[] = []
  for (const key of Object.keys(block))
    if (!(SANDBOX_KEYS as readonly string[]).includes(key))
      errors.push(
        `b4.config sandbox.${key} is not a sandbox option (known: ${SANDBOX_KEYS.join(", ")}).`,
      )
  if (block.thread !== undefined && typeof block.thread !== "function")
    errors.push(
      "b4.config sandbox.thread must be a function of the thread (a ThreadSandboxResolver).",
    )
  if (block.thread !== undefined && block.workspace !== undefined)
    errors.push(
      "b4.config sandbox.thread and sandbox.workspace are exclusive: a thread resolver returns the thread's workspace itself.",
    )
  if (
    block.workspace !== undefined &&
    typeof block.workspace !== "function" &&
    (block.workspace === null ||
      typeof block.workspace !== "object" ||
      Array.isArray(block.workspace))
  )
    errors.push(
      "b4.config sandbox.workspace must be a workspace definition or a resolver function.",
    )
  return errors
}
```

- [ ] **Step 4: Use it in `b4 check`**

In `packages/cli/src/lib/runtime/collect-sandbox-errors.ts`, import `sandboxConfigShapeErrors` from `./sandbox-config-shape.js`; after `if (!sandbox) return { errors: [], warnings: [] }` add:

```ts
  const shape = sandboxConfigShapeErrors(sandbox)
  if (shape.length > 0) return { errors: shape, warnings: [] }
```

Replace `if (sandbox.workspace) {` with `if (sandbox.workspace || sandbox.thread) {`, and inside it replace

```ts
        if (typeof sandbox.workspace !== "function")
          await captureWorkspaceDefinition(appRoot, sandbox.workspace)
```

with

```ts
        // A resolver's result, workspace or whole sandbox, exists only once a thread does.
        if (sandbox.workspace !== undefined && typeof sandbox.workspace !== "function")
          await captureWorkspaceDefinition(appRoot, sandbox.workspace)
```

In `packages/cli/src/commands/check.ts`, after the resolver line (145-146):

```ts
    if (typeof loadedConfig.sandbox?.thread === "function")
      writeLine(io.stdout, "sandbox: workspace, image and policy are resolved per thread")
```

- [ ] **Step 5: Use it at boot**

In `packages/cli/src/lib/runtime/resolve-sandbox.ts`: import `sandboxConfigShapeErrors` from `./sandbox-config-shape.js` and add `verifyThreadSandbox` to the `@b4run/workspace/node` import. After the `if (!sandbox) { ... }` block add:

```ts
  const shape = sandboxConfigShapeErrors(sandbox)
  if (shape.length > 0) throw new Error(`Invalid sandbox config:\n${shape.join("\n")}`)
```

Change `if (!sandbox.workspace && options.artifact != null)` to `if (!sandbox.workspace && !sandbox.thread && options.artifact != null)`. Replace

```ts
  let managed: ManagedWorkspaceManager | undefined
  const workspace = sandbox.workspace
  if (workspace) {
```

with a leading `thread` branch, leaving the workspace branch's body as it is:

```ts
  let managed: ManagedWorkspaceManager | undefined
  const thread = sandbox.thread
  const workspace = sandbox.workspace
  if (thread) {
    if (!sandbox.provider.workspaces)
      throw new Error("Sandbox provider does not support managed workspaces")
    if (!(await stat(join(appRoot, "workspace"))).isDirectory())
      throw new Error("Managed workspaces require app-root workspace/ capability")
    // Verified before opening the installation, so a mismatched config never creates sqlite files.
    if (options.built) verifyWorkspaceResolverArtifact(options.artifact, "thread")
    const installation = openWorkspaceInstallation(appRoot)
    try {
      managed = new ManagedWorkspaceManager({
        installation,
        resolveThread: async (input) => {
          // The workspace resolver's contract: name the thread when the host's
          // result is unusable; rethrow a cancellation unwrapped.
          try {
            const result = verifyThreadSandbox(await thread(input))
            const definition =
              "version" in result.workspace
                ? verifyCapturedWorkspaceDefinition(result.workspace)
                : await captureWorkspaceDefinition(appRoot, result.workspace, {
                    signal: input.signal,
                  })
            return {
              definition,
              ...(result.environment !== undefined ? { image: result.environment.image } : {}),
              ...(result.policy !== undefined ? { policy: result.policy } : {}),
            }
          } catch (error) {
            if (input.signal.aborted) throw error
            throw new Error(
              `Thread sandbox resolver for thread ${input.threadId}: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            )
          }
        },
        provider: sandbox.provider.workspaces,
        policy,
        idleTimeoutMs: sandbox.idleTimeoutMs ?? DEFAULT_IDLE_MS,
      })
    } catch (error) {
      installation.close()
      throw error
    }
  } else if (workspace) {
```

In `packages/cli/src/lib/runtime/execute-route-core.ts:979`, change the guard's condition to:

```ts
  if (
    (loadedB4Config?.sandbox?.workspace || loadedB4Config?.sandbox?.thread) &&
    (!options.sandboxManager?.managed || !sandboxKey)
  ) {
```

- [ ] **Step 6: Use it in `b4 build`**

In `packages/cli/src/commands/build.ts`, import `threadSandboxArtifact` and `type WorkspaceBuildArtifact` from `../lib/build/workspace-artifact.js` and `sandboxConfigShapeErrors` from `../lib/runtime/sandbox-config-shape.js`; replace lines 93-102 with:

```ts
  let workspaceArtifact: WorkspaceBuildArtifact | undefined
  const sandbox = config?.sandbox
  // Every sandbox block, not only a managed one: a lone misspelt `thred:` must fail the build.
  if (sandbox !== undefined) {
    const shape = sandboxConfigShapeErrors(sandbox)
    if (shape.length > 0) throw new CliError(`Invalid sandbox config:\n${shape.join("\n")}`)
  }
  if (sandbox && (sandbox.workspace || sandbox.thread)) {
    if (targetNames.some((name) => name !== "node"))
      throw new CliError('Managed workspaces require build.targets: ["node"]')
    if (!sandbox.provider.workspaces)
      throw new CliError("Sandbox provider does not support managed workspaces")
    if (!(await stat(join(manifest.appRoot, "workspace"))).isDirectory())
      throw new CliError("Managed workspaces require app-root workspace/ capability")
    if (sandbox.thread) workspaceArtifact = threadSandboxArtifact()
    else if (sandbox.workspace)
      workspaceArtifact = await captureWorkspaceArtifact(manifest.appRoot, sandbox.workspace)
  }
```

- [ ] **Step 7: Run the tests**

```bash
pnpm --filter @b4run/cli typecheck
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/collect-sandbox-errors.test.ts test/resolve-sandbox.test.ts test/check-command.test.ts test/managed-workspace-runtime.test.ts
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
pnpm --filter @b4run/cli lint
git add packages/cli/src/lib/runtime/sandbox-config-shape.ts packages/cli/src/lib/runtime/collect-sandbox-errors.ts packages/cli/src/lib/runtime/resolve-sandbox.ts packages/cli/src/lib/runtime/execute-route-core.ts packages/cli/src/commands/check.ts packages/cli/src/commands/build.ts packages/cli/test/collect-sandbox-errors.test.ts packages/cli/test/resolve-sandbox.test.ts packages/cli/test/managed-workspace-runtime.test.ts
git commit -m "feat(cli): sandbox.thread at check, build and boot

The sandbox block's shape is checked where it is used: unknown keys, a
non-function thread, and thread beside workspace are refused by name. A
thread resolver needs a provider with managed workspaces, so Kubernetes
refuses it as it refuses a workspace resolver; b4 build records the
thread artifact and b4 check reports the per-thread sandbox.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: End to end through the Agent Protocol, in development and from a build

**Files:**
- Modify: `packages/cli/test/support/managed-provider.ts:10-24, 61-63, 199`
- Test: `packages/cli/test/managed-workspace-runtime.test.ts`

- [ ] **Step 1: Give the shared fake provider images and a policy log**

In `packages/cli/test/support/managed-provider.ts`: add `SandboxPolicy` to the type import; after `const calls: string[] = []` add `const policies = new Map<string, SandboxPolicy>()`; add to `workspaces` after `resolveEnvironment`:

```ts
    async resolveImageEnvironment(image) {
      calls.push(`image:${image}`)
      return {
        binding: { provider: "test-service", scope: "example", account: "account" },
        identity: `immutable-template@${image}`,
      }
    },
```

change `async reconnect(ready) {` to `async reconnect(ready, policy) {` with `policies.set(ready.reference.threadId, policy)` after `calls.push("reconnect")`; and return `{ provider, workspaces, records, calls, policies }`.

- [ ] **Step 2: Write the failing tests**

Append to `packages/cli/test/managed-workspace-runtime.test.ts` (add `import { openWorkspaceInstallationReader } from "@b4run/sqlite-storage"`):

```ts
function threadConfig(physical: ReturnType<typeof managedProviderFixture>, seen: string[]) {
  return {
    sandbox: {
      provider: physical.provider,
      network: { mode: "deny" as const },
      thread: async (thread: { threadId: string; metadata: Record<string, unknown> }) => {
        seen.push(thread.threadId)
        const big = thread.metadata.size === "big"
        return {
          workspace: { source: { directory: "source", include: ["main.txt"] } },
          environment: { image: big ? "factory:big" : "factory:small" },
          policy: { resources: { memoryMb: big ? 8192 : 512 } },
        }
      },
    },
  }
}
function identityOf(appRoot: string, threadId: string): string | undefined {
  const reader = openWorkspaceInstallationReader(appRoot)
  try {
    return reader.associations.get(threadId)?.intent.environment.identity
  } finally {
    reader.close()
  }
}

it("resolves each thread's image, policy and workspace once, and keeps them across restart", async () => {
  const { appRoot } = await fixture()
  const seen: string[] = []
  const physical = managedProviderFixture()
  const config = threadConfig(physical, seen)
  const boot = async () => {
    const handler = await createRuntimeFetchHandler({ appRoot, config })
    handlers.push(handler)
    return handler
  }
  const first = await boot()
  const small = await createThread(first, { size: "small" })
  const big = await createThread(first, { size: "big" })
  expect((await run(first, small)).body).toMatchObject({ source: "initial" })
  expect((await run(first, big)).body).toMatchObject({ source: "initial" })
  expect(identityOf(appRoot, small)).toBe("immutable-template@factory:small")
  expect(identityOf(appRoot, big)).toBe("immutable-template@factory:big")
  expect(physical.policies.get(small)).toEqual({ network: { mode: "deny" }, resources: { memoryMb: 512 } })
  expect(physical.policies.get(big)).toEqual({ network: { mode: "deny" }, resources: { memoryMb: 8192 } })
  await first.close()
  physical.policies.clear()
  const restarted = await boot()
  expect((await run(restarted, big)).body).toMatchObject({ source: "initial" })
  expect(physical.policies.get(big)).toEqual({ network: { mode: "deny" }, resources: { memoryMb: 8192 } })
  expect(seen).toEqual([small, big])
})

it("builds a thread-sandbox app to the thread artifact and resolves per thread from the built manifest", async () => {
  const { appRoot } = await fixture()
  await mkdir(join(appRoot, "node_modules/@b4run"), { recursive: true })
  await symlink(new URL("..", import.meta.url), join(appRoot, "node_modules/@b4run/cli"), "dir")
  const seen: string[] = []
  const physical = managedProviderFixture()
  const config = { build: { targets: ["node"] as const }, ...threadConfig(physical, seen) }
  seedB4Config(appRoot, config)
  await runBuildCommand({ cwd: appRoot, clean: true }, { stdout: () => {}, stderr: () => {} })
  const workspace = JSON.parse(await readFile(join(appRoot, ".b4/build/workspace.json"), "utf8"))
  expect(workspace).toEqual({ version: 2, kind: "thread" })
  const modules = await loadStaticModules(pathToFileURL(join(appRoot, ".b4/build/modules.mjs")))
  const handler = await createRuntimeFetchHandler({ appRoot, config, modules: { ...modules, workspace } })
  handlers.push(handler)
  const big = await createThread(handler, { size: "big" })
  expect((await run(handler, big)).body).toMatchObject({ source: "initial" })
  expect(identityOf(appRoot, big)).toBe("immutable-template@factory:big")
  expect(seen).toEqual([big])
  await handler.close()
  // The same build, booted with a workspace resolver instead: the form changed.
  await expect(
    createRuntimeFetchHandler({
      appRoot,
      config: {
        sandbox: {
          provider: physical.provider,
          workspace: async () => ({ source: { directory: "source", include: ["main.txt"] } }),
        },
      },
      modules: { ...modules, workspace },
    }),
  ).rejects.toThrow(/rebuild/i)
})
```

- [ ] **Step 3: Run them**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-runtime.test.ts
```

Expected: PASS if Tasks 5 to 7 are complete. If the first test fails with "Managed workspace execution requires an admitted Node runtime", the `execute-route-core.ts:979` guard edit from Task 7 is missing.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/test/support/managed-provider.ts packages/cli/test/managed-workspace-runtime.test.ts
git commit -m "test(cli): two threads get their own image and policy through the Agent Protocol

In development and from a build: each thread's intent records its own
image identity, each reconnect gets its own policy, a restart re-admits
from the record without the resolver, and a thread artifact booted with
a workspace resolver is refused.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Documentation and changeset

**Files:**
- Modify: `apps/web/content/docs/sandbox.mdx` (new subsection after "### Per-thread workspaces", before "## Security hardening", line 95)
- Modify: `apps/web/content/docs/api/workspace.mdx` (export tables at lines 29-78 and 80-102; the `SandboxConfig` contract and fields at 410-431; "Managed workspace lifecycle" at 557-600)
- Modify: `apps/web/content/docs/api/sandbox.mdx:38`, `apps/web/content/docs/api/sqlite-storage.mdx:42-46`
- Modify: `packages/cli/src/workspace-exports.ts:11-13`, `packages/cli/src/lib/runtime/managed-workspace-reader.ts:23-24` (doc comments)
- Create: `.changeset/per-thread-sandbox.md`

Existing pages only: per `AGENTS.md`, do NOT run `pnpm --dir apps/web seo:lastmod` (no page is added or removed). Do not edit or remove any phrase `scripts/check-docs.mjs` pins for `sandbox.mdx` (its `required` and `retainedHeading` arrays); this task only adds.

- [ ] **Step 1: The guide subsection**

Insert in `apps/web/content/docs/sandbox.mdx` after the paragraph that ends `a built app carries a resolver marker instead of captured source.`:

````mdx
### Per-thread sandboxes

When threads also need different images or limits (say, one toolchain per target), let `sandbox.thread` decide each thread's whole sandbox instead of `sandbox.workspace`:

```ts title="b4.config.ts"
const targets: Record<string, { image: string; memoryMb: number }> = {
  small: { image: "builder-small:1a2b3c4d5e6f", memoryMb: 1024 },
  large: { image: "builder-large:6f5e4d3c2b1a", memoryMb: 8192 },
}

export default config({
  sandbox: {
    provider: dockerSandbox({
      scope: "builder",
      images: (reference) => Object.values(targets).some((t) => t.image === reference),
    }),
    network: { mode: "deny" },
    thread: async ({ threadId, metadata }) => {
      const target = targets[String(metadata.target ?? "")]
      if (!target) throw new Error(`thread ${threadId} names no known target`)
      return {
        workspace: { source: { directory: "project", include: ["package.json", "src/index.ts"] } },
        environment: { image: target.image },
        policy: { resources: { memoryMb: target.memoryMb } },
      }
    },
  },
})
```

Let's quickly review:

- `sandbox.thread` and `sandbox.workspace` are exclusive. `b4 check`, `b4 build` and startup refuse both together, and refuse any key the `sandbox` block doesn't define.
- The resolver runs once, when the thread is first admitted. B4.run records the image's immutable identity in the thread's creation intent, and the image reference and policy in a record written in the same transaction. Later turns, restarts and readers use the records, so changing the resolver or `images` never changes a thread that already exists.
- `images` bounds what a resolver may name. The Docker provider refuses any other reference before it runs a Docker command, and always allows its own `image`. Without `image`, every thread must name one.
- A thread's `resources` merge over the app's key by key, and its `env` replaces the app's. Its `network` can keep or narrow the app's but never open a network the app denies. `security` stays the app's. Network allow and deny lists and `resources.diskGb` aren't accepted per thread, because managed workspaces don't enforce them.
- Every thread admitted under `sandbox.thread` gets a record, even when the resolver chose no image or policy. A thread that has a workspace but no record (it was created before the app switched to `sandbox.thread`, or its record was lost) is refused rather than run with the app's defaults: delete it to resolve it again.
- A provider supports per-thread images by implementing `resolveImageEnvironment`. A provider without it refuses a thread that names an image. Kubernetes has no managed workspaces, so it refuses `sandbox.thread` entirely.

`b4 check` reports "workspace, image and policy are resolved per thread", and a built app carries a thread marker instead of captured source.
````

- [ ] **Step 2: The API reference**

In `apps/web/content/docs/api/workspace.mdx`:

In the `@b4run/workspace` export table, after the `WorkspaceResolverInput` row, add:

```md
| `ThreadSandboxResolver` | Decide one thread's workspace, image and policy from its id and client metadata, once, at first admission. |
| `ThreadSandbox` | Declare one thread's workspace, an optional provider-interpreted image, and optional policy overrides. |
| `ThreadSandboxPolicy` | Name the network, environment and resource fields a thread may set for itself. |
| `ThreadSandboxRecord` | Hold the image reference and policy B4.run recorded for a thread at its first admission. |
```

Change the `ManagedWorkspaceProvider` row's text to `Own physical workspace creation, inspection, reconnection, release, destruction, optional reads, and optional per-thread images.`

In the `@b4run/workspace/node` table, after `verifyCreationStatus`, add:

```md
| `verifyImageReference` | Validate an image reference a thread names; flag-like references are refused. |
| `verifyThreadSandbox` | Validate what a thread-sandbox resolver returned, refusing unknown keys by name. |
| `verifyThreadSandboxPolicy` | Validate and normalize a thread's policy overrides. |
| `verifyThreadSandboxRecord` | Validate and normalize a stored thread-sandbox record. |
```

Replace the `SandboxConfig` contract block and add its field row:

````mdx
```ts api-contract="@b4run/workspace#.:SandboxConfig"
export interface SandboxConfig {
  readonly workspace?: WorkspaceDefinition | WorkspaceResolver
  readonly thread?: ThreadSandboxResolver
  readonly provider: SandboxProvider
  readonly network?: SandboxPolicy["network"]
  readonly env?: SandboxPolicy["env"]
  readonly resources?: SandboxPolicy["resources"]
  readonly security?: SandboxSecurityPolicy
  readonly idleTimeoutMs?: number
}
```
````

```md
| `readonly thread` | `ThreadSandboxResolver` | no | Decide each thread's workspace, image and policy once, at first admission; exclusive with `workspace`. |
```

(the row goes after the `readonly workspace` row). At the end of "### Managed workspace lifecycle", before "## Examples and related guides", add:

```md
`sandbox.thread` goes one step further: a `ThreadSandboxResolver` returns the thread's
workspace, an optional image and optional policy overrides, once, at first admission.
Every thread admitted this way has a record, and a thread-mode admission of a thread
without one is refused as a conflict.
The provider's `resolveImageEnvironment` turns the image into the identity recorded in
the creation intent, and B4.run writes the image reference and the policy to a
per-thread record in the same transaction as the association. Every reconnect runs the
thread's recorded policy over the app's; nothing is re-resolved. A provider without
`resolveImageEnvironment` refuses a thread that names an image.
```

In `apps/web/content/docs/api/sandbox.mdx:38`, change the `DockerSandboxOptions` row's text to `Configure the default Docker image, the images a per-thread sandbox may name, and the optional injected Docker seam.`

In `apps/web/content/docs/api/sqlite-storage.mdx`, change the `WorkspaceInstallation` row's text to `Hold installation identity, guarded stores, per-thread sandbox records, and close.`, the `WorkspaceAssociationStore` row's to `Insert source-backed intents, with an optional thread sandbox record in the same transaction, and transition associations by revision.`, and add after it:

```md
| `WorkspaceThreadSandboxStore` | Read the sandbox record a thread's first admission wrote. |
```

- [ ] **Step 3: The reader's doc comments**

Both still say a managed workspace is one "the app declares `sandbox.workspace`". In `packages/cli/src/workspace-exports.ts:11-13` change "(the app declares `sandbox.workspace`)" to "(the app declares `sandbox.workspace` or `sandbox.thread`)", and in `packages/cli/src/lib/runtime/managed-workspace-reader.ts:23-24` change "one an app created through `sandbox.workspace`" to "one an app created through `sandbox.workspace` or `sandbox.thread`, whose image is read from the thread's own record". Doc comments only; `pnpm --filter @b4run/cli build` regenerates nothing checked in from them, but run `node scripts/check-docs.mjs` in Step 5 anyway.

- [ ] **Step 4: The changeset**

Create `.changeset/per-thread-sandbox.md`:

```markdown
---
"@b4run/workspace": patch
"@b4run/sandbox": patch
"@b4run/sqlite-storage": patch
"@b4run/cli": patch
---

`sandbox.thread` decides each thread's whole sandbox (workspace, image and policy) once, at the thread's first admission. The image goes through the new optional `ManagedWorkspaceProvider.resolveImageEnvironment`, and its identity is recorded in the thread's creation intent; the image reference and the policy overrides are recorded beside the association in the same transaction, and every reconnect runs the thread's recorded policy over the app's. `dockerSandbox({ images })` bounds which images a thread may name and refuses anything else before any Docker call; `image` is optional when `images` is given. A thread may not open a network the app denies, and `security` stays per app. `b4 check`, `b4 build` and startup refuse unknown `sandbox` keys and `thread` beside `workspace`; a thread-sandbox app builds to a `{ version: 2, kind: "thread" }` artifact. The installation now stores a workspace's source only after its environment resolves, so a refused image leaves no source behind.

**Behaviour change:** `b4 check`, `b4 build` and startup now refuse any key in the `sandbox` block other than `workspace`, `thread`, `provider`, `network`, `env`, `resources`, `security` and `idleTimeoutMs`. A misspelt key used to be ignored silently, which left every thread in a per-app sandbox; rename or remove any other key.
```

- [ ] **Step 5: Run the docs and changeset checks**

```bash
pnpm --filter @b4run/workspace... build
node scripts/check-docs.mjs
node scripts/check-changesets.mjs
```

Expected: both exit 0. If `check-docs` names a missing ownership row or a contract fingerprint mismatch for a symbol above, fix that row or block to match the built declaration and rerun; do not add rows for symbols it does not name.

- [ ] **Step 6: Commit**

```bash
git add apps/web/content/docs/sandbox.mdx apps/web/content/docs/api/workspace.mdx apps/web/content/docs/api/sandbox.mdx apps/web/content/docs/api/sqlite-storage.mdx .changeset/per-thread-sandbox.md packages/cli/src/workspace-exports.ts packages/cli/src/lib/runtime/managed-workspace-reader.ts
git commit -m "docs(workspace): per-thread sandboxes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The PR 1 gate, and the real Docker lane

**Files:**
- Modify: `packages/sandbox/test/managed-workspace.integration.test.ts` (append a `describe`)

- [ ] **Step 1: Write the Docker proof**

Append to `packages/sandbox/test/managed-workspace.integration.test.ts` (add `import { execFileSync } from "node:child_process"` and `import type { WorkspaceEnvironment } from "@b4run/workspace"`):

```ts
describe.skipIf(process.env.B4_TEST_DOCKER !== "1")(
  "managed Docker per-thread images",
  { timeout: 180000 },
  () => {
    it("runs two threads of one provider in two images under two policies", async () => {
      const docker = createDocker(),
        signal = new AbortController().signal
      const base = managedTestImage()
      // A second image with its own id: the base plus labels, built from the local base only.
      // The base carries org.b4run.code-fixer.project=cli-flags, which managedTestImage() selects
      // by (newest first): override it, or every other Docker test file would pick this variant
      // up as "the" managed image, and this test's cleanup would delete it under them.
      const variant = `b4-managed-variant:${randomUUID().slice(0, 12)}`
      execFileSync("docker", ["build", "-t", variant, "-"], {
        input: `FROM ${base}\nLABEL org.b4run.code-fixer.project="b4-managed-variant" org.b4run.test.variant="${variant}"\n`,
        stdio: ["pipe", "ignore", "inherit"],
      })
      const provider = createDockerManagedWorkspaces({
        scope: `per-thread-${randomUUID()}`,
        image: base,
        images: (reference) => reference === variant,
        docker,
      })
      const source = createSourceBundle([
        { path: "main.txt", bytes: Buffer.from("x"), executable: false },
      ])
      const installationId = randomUUID()
      const intentFor = (threadId: string, environment: WorkspaceEnvironment) =>
        createWorkspaceIntent({
          operationId: randomUUID(),
          installationId,
          threadId,
          definition: { version: 1, source, environmentLinks: [] },
          environment,
        })
      const one = intentFor("one", await provider.resolveEnvironment(signal))
      const two = intentFor("two", await (provider.resolveImageEnvironment?.(variant, signal) as Promise<WorkspaceEnvironment>))
      await expect(
        provider.resolveImageEnvironment?.("b4-not-allowed:latest", signal),
      ).rejects.toMatchObject({ code: "unsupported" })
      try {
        expect(two.environment.identity).not.toBe(one.environment.identity)
        const a = await provider.reconnect(
          await provider.create(one, source, signal),
          { network: { mode: "deny" }, resources: { memoryMb: 256 } },
          signal,
        )
        const b = await provider.reconnect(
          await provider.create(two, source, signal),
          { network: { mode: "deny" }, resources: { memoryMb: 512 } },
          signal,
        )
        const session = async (incarnation: string) => {
          const id = (
            await docker.run(["ps", "-q", "--filter", `label=b4.workspace.incarnation=${incarnation}`])
          ).stdout.trim()
          return JSON.parse(
            (await docker.run(["inspect", "--format", "{{json .}}", id])).stdout,
          ) as { Image: string; HostConfig: { Memory: number } }
        }
        const sa = await session(a.reference.incarnation)
        const sb = await session(b.reference.incarnation)
        expect(sa.Image).toBe(one.environment.identity)
        expect(sb.Image).toBe(two.environment.identity)
        expect(sa.HostConfig.Memory).toBe(256 * 1024 * 1024)
        expect(sb.HostConfig.Memory).toBe(512 * 1024 * 1024)
      } finally {
        await provider.destroy({ intent: one }, signal)
        await provider.destroy({ intent: two }, signal)
        // Best effort: a failure to untag must not mask the test's own result.
        try {
          execFileSync("docker", ["image", "rm", variant], { stdio: "ignore" })
        } catch {}
      }
    })
  },
)
```

- [ ] **Step 2: Run the Docker lanes**

Docker Desktop must be running and the managed test image prepared (`pnpm code-fixer:prepare` if `managedTestImage()` finds none).

```bash
pnpm --filter @b4run/sandbox build
B4_TEST_DOCKER=1 pnpm --filter @b4run/sandbox exec vitest --run --config vitest.config.ts test/managed-workspace.integration.test.ts
docker image ls --filter label=org.b4run.code-fixer.project=cli-flags --format "{{.Repository}}:{{.Tag}}"
B4_TEST_DOCKER=1 pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-process.test.ts test/managed-workspace-reader.test.ts
```

Expected: PASS. The `docker image ls` line must list no `b4-managed-variant` tag (the label override worked). The last command proves the static path under the real provider is untouched.

- [ ] **Step 3: Run the repository gates this PR reaches**

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm --filter @b4run/workspace test && pnpm --filter @b4run/sandbox test && pnpm --filter @b4run/sqlite-storage test && pnpm --filter @b4run/cli test
pnpm --filter @b4-example/software-factory-server typecheck && pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/code-fixer-server typecheck
node scripts/check-docs.mjs
pnpm test:release-integrity
pnpm pack:check
```

Expected: every command exits 0. `pnpm build` first: the example typechecks read the packages' `dist/`.

- [ ] **Step 4: Commit the Docker proof**

```bash
git add packages/sandbox/test/managed-workspace.integration.test.ts
git commit -m "test(sandbox): one Docker provider runs two threads in two images under two policies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Open PR 1**

Push `blove/thread-sandbox` and open the PR only when Brian asks (his rule). The body lists D1 to D10 as decided, the verification table, and the follow-up that PR 2 adds permissions.

---

# PR 2: per-thread permissions

```bash
git switch -c blove/thread-permissions blove/thread-sandbox
source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @b4run/cli... build
```

Until this PR, a resolver that returns `permissions` is refused as an unknown key (Task 2), so PR 1 never runs a thread under permissions nobody enforces.

### Task 11: A thread-scoped permissions store in `@b4run/permissions`

**Files:**
- Create: `packages/permissions/src/thread-store.ts`
- Modify: `packages/permissions/src/index.ts`
- Test: `packages/permissions/test/thread-store.test.ts` (new), `packages/testing/test/permissions-conformance.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/permissions/test/thread-store.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
  createThreadPermissionsStore,
  type PermissionMode,
  type PermissionsStore,
  type ThreadPermissionGrants,
} from "../src/index.ts"

/** An app store with fixed verdicts that records any grant handed to it. */
function appStore(
  mode: PermissionMode,
  verdicts: Readonly<Record<string, "allow" | "deny">> = {},
): PermissionsStore & { readonly granted: string[] } {
  const granted: string[] = []
  return {
    mode,
    granted,
    async load() {},
    match: (tool, candidate) => verdicts[`${tool} ${candidate}`] ?? "unknown",
    async addAllow(tool, pattern) {
      granted.push(`${tool} ${pattern}`)
    },
  }
}
function recordGrants(
  initial: Record<string, string[]> = {},
): ThreadPermissionGrants & { readonly stored: Record<string, string[]> } {
  const stored = structuredClone(initial)
  return {
    stored,
    list: () => stored,
    add(tool, pattern) {
      const list = stored[tool] ?? []
      if (!list.includes(pattern)) list.push(pattern)
      stored[tool] = list
    },
  }
}

describe("createThreadPermissionsStore", () => {
  it("allows what the thread allows, and nothing the app alone allows", async () => {
    const store = createThreadPermissionsStore({
      base: appStore("non-interactive", { "bash npm test": "allow" }),
      permissions: { allow: { bash: ["ls"] } },
      grants: recordGrants(),
    })
    await store.load()
    expect(store.match("bash", "ls -la")).toBe("allow")
    expect(store.match("bash", "npm test")).toBe("unknown")
  })
  it("denies what the thread or the app denies, over any allow", async () => {
    const store = createThreadPermissionsStore({
      base: appStore("interactive", { "bash rm ./secret": "deny" }),
      permissions: { allow: { bash: ["rm"] }, deny: { bash: ["rm -rf"] } },
      grants: recordGrants(),
    })
    await store.load()
    expect(store.match("bash", "rm -rf /tmp")).toBe("deny")
    expect(store.match("bash", "rm ./secret")).toBe("deny")
    expect(store.match("bash", "rm ./file")).toBe("allow")
  })
  it("keeps the app's mode, and ignores the thread's grants outside interactive mode", async () => {
    const grants = recordGrants({ bash: ["make"] })
    const store = createThreadPermissionsStore({
      base: appStore("non-interactive"),
      permissions: {},
      grants,
    })
    await store.load()
    expect(store.mode).toBe("non-interactive")
    expect(store.match("bash", "make all")).toBe("unknown")
  })
  it("keeps an Always grant in the thread's record, never in the app's store", async () => {
    const app = appStore("interactive")
    const grants = recordGrants()
    const store = createThreadPermissionsStore({ base: app, permissions: {}, grants })
    await store.load()
    await store.addAllow("bash", "npm install")
    expect(app.granted).toEqual([])
    expect(grants.stored).toEqual({ bash: ["npm install"] })
    expect(store.match("bash", "npm install react")).toBe("allow")
  })
  it("reads grants an earlier store recorded for the same thread", async () => {
    const store = createThreadPermissionsStore({
      base: appStore("interactive"),
      permissions: {},
      grants: recordGrants({ bash: ["make"] }),
    })
    await store.load()
    expect(store.match("bash", "make all")).toBe("allow")
  })
  it("answers unknown for everything in bypass mode, as every store does", async () => {
    const store = createThreadPermissionsStore({
      base: appStore("bypass", { "bash rm": "deny" }),
      permissions: { allow: { bash: ["ls"] }, deny: { bash: ["rm"] } },
      grants: recordGrants(),
    })
    await store.load()
    expect(store.match("bash", "ls")).toBe("unknown")
    expect(store.match("bash", "rm")).toBe("unknown")
  })
})
```

Append to `packages/testing/test/permissions-conformance.test.ts` (add `import { createThreadPermissionsStore } from "@b4run/permissions"`):

```ts
runPermissionsStoreConformance({
  name: "createThreadPermissionsStore (thread record over an empty app store)",
  makeStore: (init) => {
    // The thread's lists play the config's part; the app store denies nothing and must
    // never receive a thread's grant.
    const stored: Record<string, string[]> = {}
    return createThreadPermissionsStore({
      base: {
        mode: init.mode,
        async load() {},
        match: () => "unknown",
        async addAllow() {
          throw new Error("a thread's grant reached the app's store")
        },
      },
      permissions: { allow: init.config?.allow ?? {}, deny: init.config?.deny ?? {} },
      grants: {
        list: () => stored,
        add(tool, pattern) {
          const list = stored[tool] ?? []
          if (!list.includes(pattern)) list.push(pattern)
          stored[tool] = list
        },
      },
    })
  },
  describe,
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4run/permissions exec vitest --run --config vitest.config.ts test/thread-store.test.ts
```

Expected: FAIL: `createThreadPermissionsStore` is not exported.

- [ ] **Step 3: Implement**

Create `packages/permissions/src/thread-store.ts`:

```ts
import { matchPermission } from "./pattern-matching.js"
import type { PermissionsStore } from "./types.js"

type PatternMap = Readonly<Record<string, readonly string[]>>

/** One thread's own lists, in the vocabulary of `permissions.allow` and `permissions.deny`. */
export interface ThreadPermissions {
  readonly allow?: PatternMap
  readonly deny?: PatternMap
}

/** Where a thread's "Always" grants live: the thread's own record, never `.b4/permissions.json`. */
export interface ThreadPermissionGrants {
  list(): PatternMap
  add(tool: string, pattern: string): void | Promise<void>
}

function concat(a: PatternMap, b: PatternMap): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [tool, list] of Object.entries(a)) out[tool] = [...list]
  for (const [tool, list] of Object.entries(b)) out[tool] = [...(out[tool] ?? []), ...list]
  return out
}

/**
 * The store one thread's permission gates consult when its sandbox was
 * resolved with its own permissions. The mode is the app's. A candidate is
 * denied when the thread's `deny` or the app's store denies it; otherwise
 * allowed when the thread's `allow`, or in interactive mode a grant the thread
 * recorded, matches; otherwise unknown. The app's allow-lists (config and
 * runtime) are not consulted: another thread's "Always" must not reach this
 * one. `addAllow` writes to the thread's grants only.
 */
export function createThreadPermissionsStore(options: {
  readonly base: PermissionsStore
  readonly permissions: ThreadPermissions
  readonly grants: ThreadPermissionGrants
}): PermissionsStore {
  const { base, permissions, grants } = options
  const allow = permissions.allow ?? {}
  const deny = permissions.deny ?? {}
  let granted: PatternMap = {}
  return {
    mode: base.mode,
    async load() {
      granted = concat(grants.list(), {})
    },
    match(tool, candidate) {
      if (base.mode === "bypass") return "unknown"
      if (matchPermission(tool, candidate, {}, deny) === "deny") return "deny"
      if (base.match(tool, candidate) === "deny") return "deny"
      return matchPermission(
        tool,
        candidate,
        base.mode === "interactive" ? concat(allow, granted) : allow,
        {},
      )
    },
    async addAllow(tool, pattern) {
      await grants.add(tool, pattern)
      granted = concat(granted, { [tool]: [pattern] })
    },
  }
}
```

In `packages/permissions/src/index.ts`, add:

```ts
export {
  createThreadPermissionsStore,
  type ThreadPermissionGrants,
  type ThreadPermissions,
} from "./thread-store.js"
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @b4run/permissions typecheck
pnpm --filter @b4run/permissions test
pnpm --filter @b4run/permissions build
pnpm --filter @b4run/testing exec vitest --run --config vitest.config.ts test/permissions-conformance.test.ts
```

Expected: all PASS, including `entry-purity.test.ts` (the new module imports nothing from Node) and both conformance runs.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @b4run/permissions lint && pnpm --filter @b4run/testing lint
git add packages/permissions/src/thread-store.ts packages/permissions/src/index.ts packages/permissions/test/thread-store.test.ts packages/testing/test/permissions-conformance.test.ts
git commit -m "feat(permissions): a thread-scoped store over any app store

The app's mode and denials apply, the thread's own allow-list replaces
the app's, and an Always grant goes to the thread's record only. Passes
the PermissionsStore conformance suite.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: `permissions` in the thread sandbox and its record

**Files:**
- Modify: `packages/workspace/src/sandbox-types.ts`, `packages/workspace/src/thread-sandbox.ts`, `packages/workspace/src/index.ts`, `packages/workspace/src/node.ts`
- Test: `packages/workspace/test/thread-sandbox.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/workspace/test/thread-sandbox.test.ts`, delete the `[{ workspace, permissions: { allow: {} } }, /unsupported key permissions/]` row from the `verifyThreadSandbox` refusals, add `verifyThreadSandboxPermissions` to the `../src/node.ts` import, and append:

```ts
describe("thread permissions", () => {
  it("accepts allow and deny lists and normalizes their tool order", () => {
    const verified = verifyThreadSandbox({
      workspace,
      permissions: { deny: { bash: ["rm -rf"] }, allow: { readFile: ["/deps"], bash: ["npm test", "ls"] } },
    })
    expect(JSON.stringify(verified.permissions)).toBe(
      '{"allow":{"bash":["npm test","ls"],"readFile":["/deps"]},"deny":{"bash":["rm -rf"]}}',
    )
  })
  it.each([
    [{ allow: { bash: [""] } }, /empty pattern matches every candidate/],
    [{ allow: { bash: "ls" } }, /must be a list/],
    [{ allow: { "": ["ls"] } }, /tool name/],
    [{ grant: {} }, /unsupported key grant/],
  ])("refuses %j", (value, message) => {
    expect(() => verifyThreadSandboxPermissions(value)).toThrow(message)
  })
  it("is part of the canonical record", () => {
    const record = verifyThreadSandboxRecord({ version: 1, permissions: { allow: { bash: ["ls"] } } })
    expect(JSON.stringify(record)).toBe('{"version":1,"permissions":{"allow":{"bash":["ls"]}}}')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @b4run/workspace exec vitest --run --config vitest.config.ts test/thread-sandbox.test.ts
```

Expected: FAIL: `verifyThreadSandboxPermissions` is not exported and `permissions` is an unsupported key.

- [ ] **Step 3: Implement**

In `packages/workspace/src/sandbox-types.ts`, before `ThreadSandbox`:

```ts
/** One thread's permission lists, in the vocabulary of `permissions.allow` and `permissions.deny`. */
export interface ThreadSandboxPermissions {
  readonly allow?: Readonly<Record<string, readonly string[]>>
  readonly deny?: Readonly<Record<string, readonly string[]>>
}
```

and add `readonly permissions?: ThreadSandboxPermissions` to both `ThreadSandbox` (with the doc comment "Replaces the app's allow-list for this thread; the app's mode and denials still apply. Grants are kept in the thread's record.") and `ThreadSandboxRecord`. Export `ThreadSandboxPermissions` from `index.ts`.

In `packages/workspace/src/thread-sandbox.ts`, add before `verifyThreadSandbox`:

```ts
function patterns(value: unknown, what: string): Readonly<Record<string, readonly string[]>> {
  const map = plainObject(value, what)
  if (Reflect.ownKeys(map).some((key) => typeof key !== "string"))
    throw new Error(`${what} tool names must be strings`)
  const tools = Object.keys(map).sort()
  if (tools.length > 64) throw new Error(`${what} names more than 64 tools`)
  const out: Record<string, readonly string[]> = {}
  for (const tool of tools) {
    if (!tool || tool.length > 256 || /[\u0000-\u001f]/.test(tool))
      throw new Error(`${what} tool name ${JSON.stringify(tool)} is invalid`)
    const list = map[tool]
    if (
      !Array.isArray(list) ||
      list.length > 1024 ||
      list.some((pattern) => typeof pattern !== "string" || pattern.length > 4096 || pattern.includes("\u0000"))
    )
      throw new Error(`${what}.${tool} must be a list of at most 1024 patterns without NUL`)
    if (list.includes(""))
      throw new Error(`${what}.${tool}: an empty pattern matches every candidate; name what to allow`)
    out[tool] = Object.freeze([...(list as string[])])
  }
  return Object.freeze(out)
}

export function verifyThreadSandboxPermissions(value: unknown): ThreadSandboxPermissions {
  const permissions = plainObject(value, "A thread's permissions")
  onlyKeys(permissions, ["allow", "deny"], "A thread's permissions")
  return Object.freeze({
    ...(permissions.allow !== undefined ? { allow: patterns(permissions.allow, "permissions.allow") } : {}),
    ...(permissions.deny !== undefined ? { deny: patterns(permissions.deny, "permissions.deny") } : {}),
  })
}
```

(import `ThreadSandboxPermissions`). In `verifyThreadSandbox`, allow the key (`["workspace", "environment", "policy", "permissions"]`) and add to the returned object, after `policy`:

```ts
    ...(sandbox.permissions !== undefined
      ? { permissions: verifyThreadSandboxPermissions(sandbox.permissions) }
      : {}),
```

In `verifyThreadSandboxRecord`, allow `"permissions"` and add after `policy`:

```ts
    ...(record.permissions !== undefined
      ? { permissions: verifyThreadSandboxPermissions(record.permissions) }
      : {}),
```

Export `verifyThreadSandboxPermissions` from `node.ts`.

- [ ] **Step 4: Run the tests and commit**

```bash
pnpm --filter @b4run/workspace typecheck && pnpm --filter @b4run/workspace test && pnpm --filter @b4run/workspace lint
pnpm --filter @b4run/workspace build
git add packages/workspace/src/sandbox-types.ts packages/workspace/src/thread-sandbox.ts packages/workspace/src/index.ts packages/workspace/src/node.ts packages/workspace/test/thread-sandbox.test.ts
git commit -m "feat(workspace): a thread sandbox may carry its own permission lists

Empty patterns, which would allow every candidate, are refused.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: all PASS.

---

### Task 13: The installation keeps a thread's grants beside its record

**Files:**
- Modify: `packages/sqlite-storage/src/workspace/thread-sandbox-store.ts`, `packages/sqlite-storage/src/workspace/installation.ts`
- Test: `packages/sqlite-storage/test/workspace-thread-sandbox.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/sqlite-storage/test/workspace-thread-sandbox.test.ts`:

```ts
const scoped: ThreadSandboxRecord = { version: 1, permissions: { allow: { bash: ["ls"] } } }

it("keeps a thread's grants across reopen, idempotently, and only for a thread with its own permissions", () => {
  const path = root()
  const owner = openWorkspaceInstallation(path)
  owner.sources.put(bundle)
  owner.associations.create(intentFor(owner.installationId, "one"), scoped)
  owner.associations.create(intentFor(owner.installationId, "two"), record)
  owner.threadSandboxes.addGrant("one", "bash", "make")
  owner.threadSandboxes.addGrant("one", "bash", "make")
  owner.threadSandboxes.addGrant("one", "readFile", "/tmp/")
  expect(() => owner.threadSandboxes.addGrant("two", "bash", "make")).toThrow(/permissions of its own/)
  expect(() => owner.threadSandboxes.addGrant("three", "bash", "make")).toThrow(/permissions of its own/)
  owner.close()
  const reopened = openWorkspaceInstallation(path)
  try {
    expect(reopened.threadSandboxes.grants("one")).toEqual({ bash: ["make"], readFile: ["/tmp/"] })
    expect(reopened.threadSandboxes.grants("two")).toEqual({})
  } finally {
    reopened.close()
  }
})

it("drops a thread's grants with its record", () => {
  const owner = openWorkspaceInstallation(root())
  try {
    owner.sources.put(bundle)
    owner.associations.create(intentFor(owner.installationId, "one"), scoped)
    owner.threadSandboxes.addGrant("one", "bash", "make")
    const deleting = owner.associations.beginDelete("one")
    owner.associations.completeDelete("one", deleting?.revision ?? 0)
    expect(owner.threadSandboxes.grants("one")).toEqual({})
  } finally {
    owner.close()
  }
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4run/sqlite-storage exec vitest --run --config vitest.config.ts test/workspace-thread-sandbox.test.ts
```

Expected: FAIL: `addGrant` and `grants` do not exist.

- [ ] **Step 3: Implement**

In `packages/sqlite-storage/src/workspace/thread-sandbox-store.ts`:

Extend the public interface:

```ts
export interface WorkspaceThreadSandboxStore {
  get(threadId: string): ThreadSandboxRecord | undefined
  /** The thread's recorded "Always" grants, by tool, in the order they were granted. */
  grants(threadId: string): Readonly<Record<string, readonly string[]>>
  /** Record an "Always" grant. Only for a thread whose record carries its own permissions. */
  addGrant(threadId: string, tool: string, pattern: string): void
}
```

At the end of `ensureWorkspaceThreadSandboxSchema`, add (the owner holds the admission lock, so `IF NOT EXISTS` cannot race):

```ts
  db.exec(
    "CREATE TABLE IF NOT EXISTS workspace_thread_permission_grants(thread_id TEXT NOT NULL, tool TEXT NOT NULL, pattern TEXT NOT NULL, PRIMARY KEY(thread_id, tool, pattern))",
  )
```

In `makeWorkspaceThreadSandboxStore`, add statements and methods:

```ts
  const selectGrants = db.prepare(
    "SELECT tool, pattern FROM workspace_thread_permission_grants WHERE thread_id=? ORDER BY tool, rowid",
  )
  const insertGrant = db.prepare(
    "INSERT OR IGNORE INTO workspace_thread_permission_grants VALUES (?,?,?)",
  )
  const removeGrants = db.prepare(
    "DELETE FROM workspace_thread_permission_grants WHERE thread_id=?",
  )
  const text = (value: string, what: string) => {
    if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\u0000"))
      throw new Error(`Invalid workspace thread grant ${what}`)
    return value
  }
```

```ts
    grants(threadId) {
      const out: Record<string, string[]> = {}
      for (const row of selectGrants.all(threadId)) {
        const tool = String(row.tool)
        ;(out[tool] ??= []).push(String(row.pattern))
      }
      return out
    },
    addGrant(threadId, tool, pattern) {
      if (!get(threadId)?.permissions)
        throw new Error(`Thread ${threadId} has no permissions of its own to grant into`)
      insertGrant.run(threadId, text(tool, "tool"), text(pattern, "pattern"))
    },
```

and make `remove` also run `removeGrants.run(threadId)`.

In `packages/sqlite-storage/src/workspace/installation.ts`, extend the returned `threadSandboxes`:

```ts
        grants(threadId) {
          requireOpen()
          return sandboxes.grants(threadId)
        },
        addGrant(threadId, tool, pattern) {
          requireOpen()
          sandboxes.addGrant(threadId, tool, pattern)
        },
```

- [ ] **Step 4: Run the tests and commit**

```bash
pnpm --filter @b4run/sqlite-storage typecheck && pnpm --filter @b4run/sqlite-storage test && pnpm --filter @b4run/sqlite-storage lint
pnpm --filter @b4run/sqlite-storage build
git add packages/sqlite-storage/src/workspace/thread-sandbox-store.ts packages/sqlite-storage/src/workspace/installation.ts packages/sqlite-storage/test/workspace-thread-sandbox.test.ts
git commit -m "feat(sqlite-storage): a thread's Always grants live beside its sandbox record

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: all PASS.

---

### Task 14: The manager carries a thread's permissions and exposes them with their grants

**Files:**
- Modify: `packages/cli/src/lib/runtime/managed-workspace-manager.ts` (`ResolvedThreadSandbox`, `#resolve`, new `threadPermissions`)
- Modify: `packages/cli/src/lib/runtime/sandbox-manager.ts:106-117`
- Modify: `packages/cli/src/lib/runtime/resolve-sandbox.ts` (the `thread` branch's return)
- Test: `packages/cli/test/managed-workspace-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/managed-workspace-manager.test.ts` (add `import { existsSync } from "node:fs"`, `import { createThreadPermissionsStore } from "@b4run/permissions"` and `import { createPermissionsStore } from "@b4run/permissions/node"`):

```ts
it("allows a command in one thread that it denies in the other", async () => {
  const { manager } = threadFixture(async (thread) => ({
    definition: captured(String(thread.metadata.target)),
    permissions:
      thread.metadata.target === "a" ? { allow: { bash: ["npm test"] } } : { allow: { bash: ["make"] } },
  }))
  const signal = new AbortController().signal
  await manager.getForThread("one", signal, { metadata: async () => ({ target: "a" }) })
  await manager.getForThread("two", signal, { metadata: async () => ({ target: "b" }) })
  const app = createPermissionsStore({ appRoot: tmpdir(), config: undefined, mode: "non-interactive" })
  const storeFor = async (threadId: string) => {
    const scoped = manager.threadPermissions(threadId)
    if (!scoped) throw new Error(`no permissions recorded for ${threadId}`)
    const store = createThreadPermissionsStore({ base: app, ...scoped })
    await store.load()
    return store
  }
  expect((await storeFor("one")).match("bash", "npm test")).toBe("allow")
  expect((await storeFor("two")).match("bash", "npm test")).toBe("unknown")
  expect((await storeFor("two")).match("bash", "make all")).toBe("allow")
})

it("keeps a thread's Always grant in its record across restart, never in .b4/permissions.json", async () => {
  const first = threadFixture(async () => ({ definition: captured("a"), permissions: { allow: {} } }))
  const signal = new AbortController().signal
  await first.manager.getForThread("one", signal)
  const app = createPermissionsStore({ appRoot: first.root, config: undefined, mode: "interactive" })
  await app.load()
  const scoped = first.manager.threadPermissions("one")
  if (!scoped) throw new Error("no permissions recorded")
  const store = createThreadPermissionsStore({ base: app, ...scoped })
  await store.load()
  await store.addAllow("bash", "make")
  expect(existsSync(join(first.root, ".b4", "permissions.json"))).toBe(false)
  await first.manager.releaseAll()
  const second = threadFixture(
    async () => {
      throw new Error("the resolver must not run on re-admission")
    },
    { root: first.root },
  )
  await second.manager.getForThread("one", signal)
  expect(second.manager.threadPermissions("one")?.grants.list()).toEqual({ bash: ["make"] })
})

it("has no thread permissions for a thread whose resolver set none", async () => {
  const { manager } = threadFixture(async () => ({ definition: captured("a") }))
  await manager.getForThread("one", new AbortController().signal)
  expect(manager.threadPermissions("one")).toBeUndefined()
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-manager.test.ts
```

Expected: FAIL: `permissions` is not a `ResolvedThreadSandbox` field; `threadPermissions` does not exist.

- [ ] **Step 3: Implement**

In `managed-workspace-manager.ts`: add `type ThreadSandboxPermissions` to the `@b4run/workspace` import and `import type { ThreadPermissionGrants } from "@b4run/permissions"`. Add to `ResolvedThreadSandbox`:

```ts
  readonly permissions?: ThreadSandboxPermissions
```

In `#resolve`, change the record construction to include permissions:

```ts
      const sandbox = verifyThreadSandboxRecord({
        version: 1,
        ...(result.image !== undefined ? { image: result.image } : {}),
        ...(result.policy !== undefined ? { policy: result.policy } : {}),
        ...(result.permissions !== undefined ? { permissions: result.permissions } : {}),
      })
```

Add the public method after `getWorkspace`:

```ts
  /**
   * The permissions a thread-sandbox resolver recorded for `threadId`, with the
   * store its "Always" grants go to. Undefined for a thread without its own
   * permissions: it runs under the app's store unchanged.
   */
  threadPermissions(
    threadId: string,
  ): { readonly permissions: ThreadSandboxPermissions; readonly grants: ThreadPermissionGrants } | undefined {
    this.#assertOpen()
    const sandboxes = this.#options.installation.threadSandboxes
    const permissions = sandboxes.get(threadId)?.permissions
    if (!permissions) return undefined
    return {
      permissions,
      grants: {
        list: () => sandboxes.grants(threadId),
        add: (tool, pattern) => sandboxes.addGrant(threadId, tool, pattern),
      },
    }
  }
```

In `sandbox-manager.ts`, add after `getWorkspace`:

```ts
  threadPermissions(threadId: string) {
    return this.#managed?.threadPermissions(threadId)
  }
```

In `resolve-sandbox.ts`, the `thread` branch's returned object gains:

```ts
              ...(result.permissions !== undefined ? { permissions: result.permissions } : {}),
```

- [ ] **Step 4: Run the tests and commit**

```bash
pnpm --filter @b4run/cli typecheck
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-manager.test.ts test/sandbox-manager.test.ts test/resolve-sandbox.test.ts
pnpm --filter @b4run/cli lint
git add packages/cli/src/lib/runtime/managed-workspace-manager.ts packages/cli/src/lib/runtime/sandbox-manager.ts packages/cli/src/lib/runtime/resolve-sandbox.ts packages/cli/test/managed-workspace-manager.test.ts
git commit -m "feat(cli): a thread's resolved permissions are recorded and exposed with its grants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: all PASS.

---

### Task 15: The permission gate runs a thread-scoped thread under its own store

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route-core.ts` (after the store resolution at `:1056-1071`)
- Modify: `packages/cli/test/subagent-sandbox.test.ts:56` (its fake `sandboxManager` gains `threadPermissions`)
- Test: `packages/cli/test/managed-workspace-runtime.test.ts`, `packages/cli/test/subagent-thread-permissions.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

First keep the existing subagent test compiling against the wider manager: in `packages/cli/test/subagent-sandbox.test.ts:56`, change the fake to

```ts
      sandboxManager: {
        getForThread,
        getWorkspace: () => undefined,
        threadPermissions: () => undefined,
      } as never,
```

(without it, Step 3's `options.sandboxManager?.threadPermissions(...)` throws "threadPermissions is not a function" in that test).

Create `packages/cli/test/subagent-thread-permissions.test.ts`. Copy `fixtureApp`, `findTaskTool` and `invokeTask` verbatim from `packages/cli/test/subagent-sandbox.test.ts` (lines 94-143 on f2ee6cf6) to the bottom of the new file, with the same imports they use, then add above them:

```ts
import type { PermissionsStore, ThreadPermissionGrants } from "@b4run/permissions"
import { AIMessage } from "@langchain/core/messages"
import { afterEach, expect, it, vi } from "vitest"
import { materializeResolvedRouteGraph } from "../src/lib/runtime/execute-route.js"

// Every thread-scoped store the runtime builds, in order: the parent's preparation first,
// then one per subagent dispatch.
const built = vi.hoisted(() => [] as PermissionsStore[])
vi.mock("@b4run/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@b4run/permissions")>()
  return {
    ...actual,
    createThreadPermissionsStore: (
      options: Parameters<typeof actual.createThreadPermissionsStore>[0],
    ) => {
      const store = actual.createThreadPermissionsStore(options)
      built.push(store)
      return store
    },
  }
})

afterEach(() => {
  built.splice(0)
  vi.doUnmock("langchain")
  vi.doUnmock("@langchain/openai")
})

it("gates a subagent with its parent thread's permissions and records its Always grant there", async () => {
  delete process.env.B4_PERMISSIONS_MODE // the app's default mode, interactive
  const appRoot = await fixtureApp()
  // The parent thread's record: one allow-list and one grant store, keyed by the SANDBOX key.
  const parentGrants: Record<string, string[]> = {}
  const grants: ThreadPermissionGrants = {
    list: () => parentGrants,
    add(tool, pattern) {
      ;(parentGrants[tool] ??= []).push(pattern)
    },
  }
  const threadPermissions = vi.fn((_key: string) => ({
    permissions: { allow: { bash: ["npm test"] } },
    grants,
  }))
  const getForThread = vi.fn(async () => ({
    exec: { execute: vi.fn() },
    filesystem: { list: vi.fn(), mkdir: vi.fn(), read: vi.fn(), remove: vi.fn(), stat: vi.fn(), write: vi.fn() },
    workspaceRoot: "/workspace",
  }))
  const createAgent = vi.fn((_options: unknown) => ({
    invoke: vi.fn(async () => ({ messages: [new AIMessage("Child complete.")] })),
  }))
  vi.doMock("langchain", async (importOriginal) => ({
    ...(await importOriginal<typeof import("langchain")>()),
    createAgent,
  }))
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: class {} }))

  await materializeResolvedRouteGraph({
    appRoot,
    routeFile: `${appRoot}/src/app/parent/index.ts`,
    routeId: "/parent",
    routePath: "src/app/parent/index.ts",
    sandboxManager: { getForThread, getWorkspace: () => undefined, threadPermissions } as never,
    sandboxThreadId: "sandbox-root",
  })
  await invokeTask(findTaskTool(createAgent.mock.calls[0]?.[0]), "child-call")

  // The parent's preparation and the child's both asked for the PARENT's record.
  expect(threadPermissions.mock.calls.map(([key]) => key)).toEqual(["sandbox-root", "sandbox-root"])
  expect(built).toHaveLength(2)
  const [parent, child] = built as [PermissionsStore, PermissionsStore]
  expect(child.match("bash", "npm test")).toBe("allow")
  expect(child.match("bash", "make all")).toBe("unknown")
  // The child's Always lands in the parent thread's record, and the parent's next
  // preparation (a load of the same record) honours it.
  await child.addAllow("bash", "make")
  expect(parentGrants).toEqual({ bash: ["make"] })
  await parent.load()
  expect(parent.match("bash", "make all")).toBe("allow")
})
```

If `vi.mock` does not take effect because `execute-route-core` binds `@b4run/permissions` from the built `dist/` of another package, the `built` array stays empty and the test fails on `toHaveLength(2)`: that is a harness problem, not a pass. Fix it by importing `createThreadPermissionsStore` in `execute-route-core.ts` exactly as the mock names it (`import { createThreadPermissionsStore } from "@b4run/permissions"`), which vitest intercepts for `src/` modules.

Then append to `packages/cli/test/managed-workspace-runtime.test.ts`:

```ts
it("gates each thread's filesystem calls with its own permissions", async () => {
  const { appRoot } = await fixture()
  await mkdir(join(appRoot, "src/app/probe/tools"), { recursive: true })
  await writeFile(
    join(appRoot, "src/app/probe/index.ts"),
    "export const workflow=async (input,ctx)=>ctx.tools.probe(input)",
  )
  await writeFile(
    join(appRoot, "src/app/probe/tools/probe.ts"),
    "export default async function probe(input:{path:string},ctx){try{await ctx.fs.writeFile(input.path,'x');return {ok:true}}catch(error){return {error:error instanceof Error?error.message:String(error)}}}",
  )
  const physical = managedProviderFixture()
  const config = {
    permissions: { mode: "non-interactive" as const, allow: { writeFile: ["/everyone/"] } },
    sandbox: {
      provider: physical.provider,
      thread: async (thread: { metadata: Record<string, unknown> }) => ({
        workspace: { source: { directory: "source", include: ["main.txt"] } },
        permissions: thread.metadata.role === "writer" ? { allow: { writeFile: ["/outside/"] } } : { allow: {} },
      }),
    },
  }
  const handler = await createRuntimeFetchHandler({ appRoot, config })
  handlers.push(handler)
  const probe = async (id: string, path: string) => {
    const response = await handler.fetch(
      new Request(`http://localhost/threads/${id}/runs/wait`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "/probe#workflow", input: { path } }),
      }),
    )
    return (await response.json()) as { ok?: true; error?: string }
  }
  const writer = await createThread(handler, { role: "writer" })
  const reader = await createThread(handler, { role: "reader" })
  expect(await probe(writer, "/outside/file.txt")).toEqual({ ok: true })
  expect((await probe(reader, "/outside/file.txt")).error).toMatch(/Permission denied \(fail-closed\)/)
  // The app's own allow-list does not reach a thread with permissions of its own.
  expect((await probe(writer, "/everyone/file.txt")).error).toMatch(/Permission denied \(fail-closed\)/)
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-runtime.test.ts test/subagent-thread-permissions.test.ts -t "permissions"
```

Expected: FAIL. The writer's write is denied and the `/everyone/` write is allowed, because the gate still consults the app's store; and `threadPermissions` is never called, so the subagent test fails on its first `expect`.

- [ ] **Step 3: Implement**

In `packages/cli/src/lib/runtime/execute-route-core.ts`, add `createThreadPermissionsStore` as a value import from `@b4run/permissions` (the barrel is edge-safe), and immediately after the `if (typeof providedPermissions === "function") { ... } else { ... }` block that assigns `permissionsStore` (ending at line 1071), add:

```ts
  // A thread whose sandbox was resolved with its own permissions runs under a
  // store built from that record: the app's mode and denials, the thread's own
  // allow-list, and "Always" grants kept in the thread's record, never in
  // `.b4/permissions.json`. Keyed by the SANDBOX key, so a subagent runs under
  // its parent thread's permissions, as it runs in its parent's workspace.
  const threadPermissions = sandboxKey
    ? options.sandboxManager?.threadPermissions(sandboxKey)
    : undefined
  if (threadPermissions) {
    permissionsStore = createThreadPermissionsStore({ base: permissionsStore, ...threadPermissions })
    await permissionsStore.load()
  }
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @b4run/cli typecheck
pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/managed-workspace-runtime.test.ts test/subagent-thread-permissions.test.ts test/store-injection.test.ts test/boot-instance-passthrough.test.ts test/subagent-sandbox.test.ts
```

Expected: all PASS; `store-injection` still counts zero permissions-store constructions for an app with no thread sandbox (the wrapper is built only when a record carries permissions).

- [ ] **Step 5: Commit**

```bash
pnpm --filter @b4run/cli lint
git add packages/cli/src/lib/runtime/execute-route-core.ts packages/cli/test/managed-workspace-runtime.test.ts packages/cli/test/subagent-thread-permissions.test.ts packages/cli/test/subagent-sandbox.test.ts
git commit -m "feat(cli): a thread with its own permissions is gated by them

The gate's store for such a thread keeps the app's mode and denials,
replaces the app's allow-list with the thread's, and keeps Always
grants in the thread's record. A subagent inherits its parent thread's.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: PR 2 documentation, changeset and gate

**Files:**
- Modify: `apps/web/content/docs/permissions.mdx` (new section before "## Testing", line 297)
- Modify: `apps/web/content/docs/sandbox.mdx` (the "Per-thread sandboxes" subsection from Task 9)
- Modify: `apps/web/content/docs/api/permissions.mdx:30-45`, `apps/web/content/docs/api/workspace.mdx`, `apps/web/content/docs/api/sqlite-storage.mdx`
- Create: `.changeset/per-thread-permissions.md`

- [ ] **Step 1: The guide sections**

Insert in `apps/web/content/docs/permissions.mdx` before `## Testing`:

```mdx
## Per-thread permissions

An app whose `sandbox.thread` resolver returns `permissions` gives that thread its own lists:

- The thread's `allow` replaces the app's `permissions.allow` for that thread. The app's allow-list, and grants other threads saved to `.b4/permissions.json`, don't apply to it.
- Denials add up: the thread's `deny` and the app's denials both apply, and a denial wins over any allow.
- The mode is the app's. In `bypass` mode nothing is checked, as for any thread.
- An **Always** decision in such a thread is saved to that thread's record in the workspace installation, never to `.b4/permissions.json`. It applies to later turns of that thread and to its subagents, not to other threads.
- An empty pattern (`""`) is refused, because it would allow every candidate.

A thread whose resolver returns no `permissions` uses the app's store unchanged.
```

In `apps/web/content/docs/sandbox.mdx`, add `permissions: { allow: { bash: ["npm test"] } },` after the `policy:` line of the Task 9 example, and this bullet after the policy bullet:

```md
- `permissions` gives the thread its own allow-list, on top of the app's mode and denials. See [Per-thread permissions](/docs/permissions#per-thread-permissions).
```

- [ ] **Step 2: The API reference**

`apps/web/content/docs/api/permissions.mdx`, `@b4run/permissions` table, add after `PermissionsStore`:

```md
| `createThreadPermissionsStore` | Build one thread's store over the app's: the app's mode and denials, the thread's allow-list, grants kept in the thread's record. |
| `ThreadPermissions` | Describe one thread's allow and deny lists. |
| `ThreadPermissionGrants` | List and add one thread's recorded "Always" grants. |
```

`apps/web/content/docs/api/workspace.mdx`: add `| \`ThreadSandboxPermissions\` | Describe one thread's own allow and deny lists. |` after `ThreadSandboxPolicy`, and `| \`verifyThreadSandboxPermissions\` | Validate and normalize a thread's permission lists; empty patterns are refused. |` after `verifyThreadSandboxPolicy`. `apps/web/content/docs/api/sqlite-storage.mdx`: the `WorkspaceThreadSandboxStore` row's text becomes `Read the sandbox record a thread's first admission wrote, and keep that thread's "Always" grants.`

- [ ] **Step 3: The changeset**

Create `.changeset/per-thread-permissions.md`:

```markdown
---
"@b4run/permissions": patch
"@b4run/workspace": patch
"@b4run/sqlite-storage": patch
"@b4run/cli": patch
---

A `sandbox.thread` resolver may return `permissions`: that thread's permission gates then use its own allow-list in place of the app's, keep the app's mode and every denial (the app's and the thread's), and save an "Always" decision to the thread's record in the workspace installation, never to `.b4/permissions.json`. A subagent runs under its parent thread's permissions. `createThreadPermissionsStore` builds such a store over any `PermissionsStore` and passes the store conformance suite. Empty permission patterns are refused in a thread's lists because they would allow every candidate.
```

- [ ] **Step 4: The gate**

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm --filter @b4run/permissions test && pnpm --filter @b4run/testing test && pnpm --filter @b4run/workspace test && pnpm --filter @b4run/sqlite-storage test && pnpm --filter @b4run/cli test
node scripts/check-docs.mjs
node scripts/check-changesets.mjs
pnpm test:release-integrity
pnpm pack:check
```

Expected: every command exits 0. No lastmod regeneration: only existing pages changed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/content/docs/permissions.mdx apps/web/content/docs/sandbox.mdx apps/web/content/docs/api/permissions.mdx apps/web/content/docs/api/workspace.mdx apps/web/content/docs/api/sqlite-storage.mdx .changeset/per-thread-permissions.md
git commit -m "docs(permissions): per-thread permissions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# PR 3: the factory runs one builder for every target and pin

```bash
git switch -c blove/factory-one-builder blove/thread-permissions
source ~/.nvm/nvm.sh && nvm use 24
pnpm build
```

Example-only: `@b4-example/*` packages are private, so no changeset. All paths below are under `examples/software-factory/` unless they start with `.github/`.

**Trust, restated for review.** Today the operator's target file chooses a builder's image, policy and permissions and the controller's manifest chooses its workspace. After this PR the controller's manifest chooses all four, per thread, and the builder validates it strictly (`BuilderManifestSchema`, `.strict()` throughout, a network of `deny` only, factory-shaped images only). Three bounds hold that the manifest cannot move: the builder app's own `network: { mode: "deny" }` (a thread may not open it, Task 5), `dockerSandbox({ images: isFactoryImage })` (Task 3), and the app's `non-interactive` mode (a manifest supplies an allow-list, never a mode). The boundary becomes one: who can write into the builder's manifest directory. That writer controls the thread's whole allow-list, including the `tool` and `subagent` keys, not only commands and paths. Each thread's choice is recorded at first admission and never re-resolved.

### Task 17: The manifest carries the target

**Files:**
- Modify: `controller/src/lib/builder-manifest.ts:13-105, 164-208`
- Modify: `server/src/builder-manifest.ts:13-97, 150-188`
- Test: `controller/test/builder-manifest.test.ts`, `server/test/builder-config.test.ts:40-46`

- [ ] **Step 1: Write the failing tests**

In `controller/test/builder-manifest.test.ts`, in the test "is named by the work order and carries the workspace, the task and the target, no prompt" (line 87), add after the existing assertions on `raw`:

```ts
    expect(raw.version).toBe(2)
    expect(raw.target).toEqual({
      image: imageTag(task.target),
      pin: task.target.pin,
      policy: targetSandboxPolicy(task.target),
      permissions: builderPermissions(task.target),
    })
    expect(Object.keys(raw).sort()).toEqual(
      ["target", "targetId", "taskId", "version", "workOrderId", "workspace"].sort(),
    )
```

(import `imageTag` from `../src/lib/targets/catalog.ts`, `targetSandboxPolicy` from `../src/lib/targets/workspace.ts`, `builderPermissions` from `../src/lib/targets/permissions.ts`, and `BuilderManifestSchema` from `../src/lib/builder-manifest.ts` if the file does not import it yet), and replace the "is identical" test's slicing with:

```ts
    const schemas = (text: string) =>
      text.slice(
        text.indexOf("export const BuilderManifestSchema"),
        text.indexOf("export type BuilderManifest ="),
      )
    const block = schemas(here)
    expect(block).toContain("export const BuilderManifestSchema")
    expect(block).toContain("target: z")
    expect(schemas(there)).toBe(block)
    const rule = (text: string, name: string) =>
      text.match(new RegExp(`^const ${name} = (.*)$`, "m"))?.[1]
    for (const name of ["CATALOG_ID", "FACTORY_IMAGE"]) {
      expect(rule(here, name)).toBeDefined()
      expect(rule(there, name)).toBe(rule(here, name))
    }
```

Add to the same file:

```ts
describe("the manifest's target block", () => {
  const good = () => ({
    version: 2,
    workOrderId: "wo-a",
    taskId: "cli-flags",
    targetId: "cli-flags",
    target: {
      image: "b4-factory-cli-flags:6a59e00aed46-0123456789ab",
      pin: "6".repeat(40),
      policy: {
        network: { mode: "deny" },
        env: {},
        resources: { memoryMb: 1024, cpus: 1, timeoutMs: 60_000 },
      },
      permissions: { bash: ["npm test"] },
    },
    workspace: {},
  })
  it("parses what the controller writes", () => {
    expect(() => BuilderManifestSchema.parse(good())).not.toThrow()
  })
  it.each([
    ["an open network", (m: ReturnType<typeof good>) => ({ ...m, target: { ...m.target, policy: { ...m.target.policy, network: { mode: "allow" } } } })],
    ["a network list", (m: ReturnType<typeof good>) => ({ ...m, target: { ...m.target, policy: { ...m.target.policy, network: { mode: "deny", allowlist: ["10.0.0.0/8"] } } } })],
    ["an image that is not the factory's", (m: ReturnType<typeof good>) => ({ ...m, target: { ...m.target, image: "alpine:latest" } })],
    ["a security key", (m: ReturnType<typeof good>) => ({ ...m, target: { ...m.target, policy: { ...m.target.policy, security: {} } } })],
    ["an empty pattern", (m: ReturnType<typeof good>) => ({ ...m, target: { ...m.target, permissions: { bash: [""] } } })],
    ["version 1", (m: ReturnType<typeof good>) => ({ ...m, version: 1 })],
  ])("refuses %s", (_name, edit) => {
    expect(() => BuilderManifestSchema.parse(edit(good()))).toThrow()
  })
})
```

In `server/test/builder-config.test.ts`, change the `manifest()` fixture (lines 40-46) to version 2 with a target block:

```ts
const manifest = (workOrderId: string, text: string, image = "b4-factory-fixture-target:deadbeefcafe-0123456789ab"): BuilderManifest => ({
  version: 2,
  workOrderId,
  taskId: "fixture-task",
  targetId: "fixture-target",
  target: {
    image,
    pin: "d".repeat(40),
    policy: {
      network: { mode: "deny" },
      env: { npm_config_cache: "/tmp/npm-cache" },
      resources: { memoryMb: 2048, cpus: 2, timeoutMs: 120_000 },
    },
    permissions: { bash: ["npm test", "node ", "cat"], readFile: ["/deps"], listDir: ["/deps"] },
  },
  workspace: { version: 1, source: bundle(text), environmentLinks: [] },
})
```

and in "refuses a manifest that still carries a prompt, or is of another version", change `version: 2` to `version: 1`.

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4-example/software-factory-controller exec vitest run test/builder-manifest.test.ts
pnpm --filter @b4-example/software-factory-server exec vitest run test/builder-config.test.ts
```

Expected: FAIL: the written manifest is version 1 with no `target`; the schemas refuse version 2.

- [ ] **Step 3: Implement both copies**

In `controller/src/lib/builder-manifest.ts` AND `server/src/builder-manifest.ts`, add beside `CATALOG_ID` (same text in both files):

```ts
/**
 * An image the factory prepared: `b4-factory-<target>:<pin[:12]>-<dockerfile[:12]>`, the tag
 * `imageTag` writes and the verifier runs. The builder's provider allows no other image, so a
 * manifest can choose among the factory's own images and nothing else.
 */
const FACTORY_IMAGE = /^b4-factory-[A-Za-z0-9][A-Za-z0-9._-]*:[0-9a-f]{12}-[0-9a-f]{12}$/
```

and replace `BuilderManifestSchema` (same text in both files):

```ts
/**
 * One work order's builder thread, whole: the workspace the controller captured, and what the
 * retired per-process target file carried (the image the task is verified in, the pin it was
 * prepared at, the sandbox policy and the permission allow-list). The builder hands the target
 * block to the framework as the thread's sandbox, recorded at the thread's first admission.
 *
 * Strict throughout, and narrower than the framework: a key this schema does not model is a
 * refusal at admission, never a silent drop to a broader default. The network is `deny` only
 * (the builder app denies it too, and a thread may not open what its app denies); the image
 * must be one the factory prepared; an empty pattern, which would allow every command, is
 * refused. `workspace` is left to `verifyCapturedWorkspaceDefinition`, which checks it byte for
 * byte against its own digest.
 */
export const BuilderManifestSchema = z
  .object({
    version: z.literal(2),
    workOrderId: z.string().regex(CATALOG_ID),
    taskId: z.string().regex(CATALOG_ID),
    targetId: z.string().regex(CATALOG_ID),
    target: z
      .object({
        image: z.string().regex(FACTORY_IMAGE),
        pin: z.string().regex(/^[a-f0-9]{40}$/),
        policy: z
          .object({
            network: z.object({ mode: z.literal("deny") }).strict(),
            env: z.record(z.string(), z.string()),
            resources: z
              .object({
                memoryMb: z.number().int().positive(),
                cpus: z.number().positive(),
                timeoutMs: z.number().int().positive(),
              })
              .strict(),
          })
          .strict(),
        /** Keyed by tool name, so the key set is open; the values are always non-empty patterns. */
        permissions: z.record(z.string(), z.array(z.string().min(1))),
      })
      .strict(),
    workspace: z.unknown(),
  })
  .strict()
```

Also export the predicate from both files:

```ts
/** Whether `reference` is an image the factory prepared. The builder's `dockerSandbox({ images })`. */
export const isFactoryImage = (reference: string): boolean => FACTORY_IMAGE.test(reference)
```

In `controller/src/lib/builder-manifest.ts`'s `writeBuilderManifest`, replace the `BuilderManifestSchema.parse({ ... })` argument with:

```ts
  const manifest: BuilderManifest = BuilderManifestSchema.parse({
    version: 2,
    workOrderId,
    taskId: task.id,
    targetId: task.target.id,
    target: {
      image: imageTag(task.target),
      pin: task.target.pin,
      policy: targetSandboxPolicy(task.target),
      permissions: builderPermissions(task.target),
    },
    workspace,
  })
```

Leave `BuilderTargetSchema`, `writeBuilderTarget` and the server's `loadBuilderTarget` in place for now (Tasks 18 and 19 remove them); the server's `loadBuilderManifest` keeps its `targetId` check until Task 18.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-server typecheck
pnpm --filter @b4-example/software-factory-controller test
pnpm --filter @b4-example/software-factory-server test
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @b4-example/software-factory-controller lint && pnpm --filter @b4-example/software-factory-server lint
git add controller/src/lib/builder-manifest.ts server/src/builder-manifest.ts controller/test/builder-manifest.test.ts server/test/builder-config.test.ts
git commit -m "feat(software-factory): the builder manifest carries its target's image, policy and permissions

Manifest v2 moves what the per-process target file carried into each
work order's manifest, strictly: a deny-only network, a factory image,
non-empty patterns.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Run `git` from the repository root with paths prefixed `examples/software-factory/`; the short paths above are for reading.)

---

### Task 18: The builder boots with no target file and resolves each thread's sandbox

**Files:**
- Modify: `server/b4.config.ts` (whole file)
- Modify: `server/src/builder-manifest.ts` (delete `BuilderTargetSchema`, `BuilderTarget`, `loadBuilderTarget`; `loadBuilderManifest` loses `targetId`)
- Rename: `server/scripts/with-target.mjs` → `server/scripts/in-lane.mjs`; modify `server/package.json` scripts
- Test: `server/test/builder-config.test.ts`

- [ ] **Step 1: Write the failing tests**

In `server/test/builder-config.test.ts`: delete the `target` constant and every `FACTORY_BUILDER_TARGET` line in `beforeEach`/`afterEach`; replace the `resolver` helper with:

```ts
const resolver = async () => {
  const sandbox = (await loadConfig()).sandbox
  if (typeof sandbox?.thread !== "function")
    throw new Error("builder config must resolve each thread's whole sandbox")
  expect(sandbox.workspace).toBeUndefined()
  return sandbox.thread
}
const digestOf = (resolved: unknown) =>
  (resolved as { workspace: { source: { digest: string } } }).workspace.source.digest
```

Replace the "builder configuration" `describe` with:

```ts
describe("builder configuration", () => {
  it("boots with no target file and denies the network to every thread", async () => {
    delete process.env.FACTORY_BUILDER_TARGET
    const config = await loadConfig()
    expect(config.sandbox?.network?.mode).toBe("deny")
    expect(config.sandbox?.provider.name).toBe("docker")
  })
  it("refuses an unlisted command as a tool error instead of parking it for nobody", async () => {
    const config = await loadConfig()
    expect(config.permissions?.mode).toBe("non-interactive")
    // The allow-list is each thread's own, from its manifest; the app pre-approves nothing.
    expect(config.permissions?.allow).toBeUndefined()
  })
  it("addresses the controller's reader's storage: one scope, no default image", async () => {
    const text = readFileSync(new URL("../b4.config.ts", import.meta.url), "utf8")
    // Scope and allowed images, and no default image: the controller's reader builds the same.
    expect(text).toContain(
      'dockerSandbox({ scope: "software-factory-builder", images: isFactoryImage })',
    )
  })
})
```

Replace "serves each work order its own captured workspace, unchanged" and "refuses a work order routed to the wrong builder" with:

```ts
  it("serves each work order its own workspace, image, policy and permissions", async () => {
    const alpha = manifest("wo-alpha", "export const run = () => 0\n")
    const beta = {
      ...manifest("wo-beta", "export const run = () => 1\n", "b4-factory-other:0123456789ab-ba9876543210"),
      targetId: "other-target",
    }
    beta.target = {
      ...beta.target,
      policy: { ...beta.target.policy, resources: { memoryMb: 8192, cpus: 4, timeoutMs: 600_000 } },
      permissions: { bash: ["make"] },
    }
    writeManifest(alpha, "wo-alpha")
    writeManifest(beta, "wo-beta")
    const resolve = await resolver()
    const first = await resolve(thread({ factoryWorkOrderId: "wo-alpha" }, "t-alpha"))
    const second = await resolve(thread({ factoryWorkOrderId: "wo-beta" }, "t-beta"))
    expect(digestOf(first)).toBe(digestOf({ workspace: alpha.workspace }))
    expect(digestOf(second)).toBe(digestOf({ workspace: beta.workspace }))
    expect(first.environment).toEqual({ image: alpha.target.image })
    expect(second.environment).toEqual({ image: "b4-factory-other:0123456789ab-ba9876543210" })
    expect(first.policy).toEqual(alpha.target.policy)
    expect(second.policy?.resources).toEqual({ memoryMb: 8192, cpus: 4, timeoutMs: 600_000 })
    expect(first.permissions).toEqual({ allow: alpha.target.permissions })
    expect(second.permissions).toEqual({ allow: { bash: ["make"] } })
  })

  it("allows only the factory's own images", async () => {
    const { isFactoryImage } = await import("../src/builder-manifest.ts")
    expect(isFactoryImage("b4-factory-devkit:6a59e00aed46-0123456789ab")).toBe(true)
    expect(isFactoryImage("alpine:latest")).toBe(false)
    expect(isFactoryImage("b4-factory-devkit:latest")).toBe(false)
  })
```

and change `digestOf(first)`-style uses elsewhere in the file (the tampered-digest test needs none). Delete the "pre-approves exactly what the target allows" and "keeps the builder's own review tools nonexistent" tests: the app no longer carries an allow-list (the review-tools property moves to the route test, which already asserts `tools.approve` is empty).

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4-example/software-factory-server exec vitest run test/builder-config.test.ts
```

Expected: FAIL: the config throws "FACTORY_BUILDER_TARGET is required" and has no `sandbox.thread`.

- [ ] **Step 3: Implement**

Replace `server/b4.config.ts` with:

```ts
import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import {
  builderManifestDir,
  isFactoryImage,
  loadBuilderManifest,
  workOrderIdOf,
} from "./src/builder-manifest.js"

// Boot refuses without the directory; an empty one is fine, because a thread with no
// manifest is refused at admission, by name.
const manifestDir = builderManifestDir()

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    // No default image: every thread runs the image its manifest names, and only an image the
    // factory prepared may be named. The scope is the whole of the storage address the
    // controller's reader needs; a managed workspace's image is read from its own record.
    provider: dockerSandbox({ scope: "software-factory-builder", images: isFactoryImage }),
    // The ceiling every thread's policy is held to: a thread may not open what the app denies.
    network: { mode: "deny" },
    // Per thread, once, at its first admission: the controller writes `<dir>/<workOrderId>.json`
    // before it creates the thread with `{ factoryWorkOrderId }`, and the thread runs that
    // manifest's workspace, image, policy and permissions, recorded, and no other.
    thread: async (thread) => {
      const manifest = await loadBuilderManifest(manifestDir, workOrderIdOf(thread.metadata), {
        signal: thread.signal,
      })
      return {
        workspace: verifyCapturedWorkspaceDefinition(manifest.workspace),
        environment: { image: manifest.target.image },
        policy: manifest.target.policy,
        permissions: { allow: manifest.target.permissions },
      }
    },
  },
  toolOutput: {
    // The controller never reads a tool result, so nothing here is load-bearing
    // for correctness; the default threshold keeps large output out of context.
    previewLines: 10,
  },
  permissions: {
    // Nobody answers a builder's prompt (the first live run parked on one and blocked its work
    // order). A fixed property of the builder app, never of a manifest: a command off a
    // thread's list is a tool error the model reads and recovers from.
    mode: "non-interactive",
  },
})
```

In `server/src/builder-manifest.ts`: delete `BuilderTargetSchema`, `BuilderTarget` and `loadBuilderTarget` (and the `readFileSync` import if now unused); update the file's header comment to say the manifest is the builder's one input per thread; change `loadBuilderManifest(dir, workOrderId, targetId, options)` to `loadBuilderManifest(dir, workOrderId, options)` and delete its `manifest.targetId !== targetId` refusal (the builder serves every target).

Rename the build guard and key it on the lane rather than on a target file:

```bash
git mv examples/software-factory/server/scripts/with-target.mjs examples/software-factory/server/scripts/in-lane.mjs
```

In `server/scripts/in-lane.mjs`, replace the header comment's first paragraph and the guard:

```js
/**
 * Run a `b4` command only in the software-factory Docker lane.
 *
 * The builder's real `b4 check` runs the Docker provider's preflight, which needs a daemon,
 * and its `b4 build` is only meaningful where its images exist: both belong to ci.yml's
 * software-factory lane, which sets FACTORY_BUILDER_LANE=1. The repository's unfiltered
 * `build` and `check` walk every workspace package with no Docker in hand, and skip this one.
 *
 * Deliberately not a shell one-liner: the exit code has to reach turbo unchanged, and a
 * signal has to stay a signal.
 */
```

```js
if (process.env.FACTORY_BUILDER_LANE !== "1") {
  console.log(`builder: FACTORY_BUILDER_LANE is not 1; skipping ${command.join(" ")}`)
  process.exit(0)
}
```

(the error prefix `with-target:` in the two remaining messages becomes `in-lane:`). In `server/package.json`, replace `node scripts/with-target.mjs` with `node scripts/in-lane.mjs` in the `check` and `build` scripts.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @b4-example/software-factory-server typecheck
pnpm --filter @b4-example/software-factory-server test
pnpm --filter @b4-example/software-factory-server build
```

Expected: tests PASS; `build` prints `builder: FACTORY_BUILDER_LANE is not 1; skipping b4 build` and exits 0. Also run `pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller test`: both still pass, because the controller shares no source with the server (its schema-identity test compares only the `BuilderManifestSchema` block, which Task 17 made identical) and a served builder simply ignores the `FACTORY_BUILDER_TARGET` its test helper still sets until Task 19.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @b4-example/software-factory-server lint
git add examples/software-factory/server/b4.config.ts examples/software-factory/server/src/builder-manifest.ts examples/software-factory/server/test/builder-config.test.ts examples/software-factory/server/scripts/in-lane.mjs examples/software-factory/server/package.json
git commit -m "feat(software-factory): one builder serves every target and pin

The builder boots with no target file: sandbox.thread runs each work
order's manifest (workspace, image, policy, permissions), recorded at
the thread's first admission, under a deny-network, non-interactive app
that allows only the factory's own images.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: The controller talks to one builder and stops guarding pins

**Files:**
- Modify: `controller/src/lib/builder-manifest.ts` (delete `BuilderTargetSchema`, `BuilderTarget`, `builderTargetPath`, `writeBuilderTarget`)
- Modify: `controller/src/lib/config.ts:40-70, 140-200, 225-360` (one `builder` endpoint)
- Modify: `controller/src/lib/controller/workers.ts` (every target maps to the one builder)
- Modify: `controller/src/lib/runtime.ts:95-120, 160-175`
- Modify: `controller/src/lib/targets/workspace.ts:46-80` (`builderSandboxProvider()`; delete `builderTarget`, `builderTargetForTask`)
- Modify: `controller/src/lib/controller/factory.ts:266-358, 1282-1294` (delete both guards and their call)
- Modify: `controller/src/cli.ts:51-65, 790-801` (delete `builder-target`)
- Delete: `controller/test/factory-builder-environment.test.ts`, `controller/test/builder-target-file.ts`
- Test: `controller/test/config.test.ts`, `controller/test/factory-retry.test.ts`, `controller/test/runtime.test.ts`, `controller/test/cli.test.ts`, `controller/test/served-builder.ts`, `controller/test/serve-controller.ts`, `controller/test/drafter-end-to-end.integration.test.ts`, `controller/test/fake-worker-map.ts`, `controller/test/targets-workspace.test.ts`

- [ ] **Step 1: Write the failing config tests**

In `controller/test/config.test.ts`, replace every `FACTORY_WORKERS` and `FACTORY_BUILDER_TARGET` case (lines 20-230; they assert the retired worker map) with:

```ts
describe("the builder endpoint", () => {
  const base = {
    FACTORY_STATE_DIR: "/tmp/state",
    FACTORY_WORKER_URL: "http://127.0.0.1:4100/",
    FACTORY_BUILDER_APP_ROOT: "/srv/builder",
  }
  it("is one worker for every target, with its manifest directory defaulted under its app root", () => {
    expect(loadConfig(base).builder).toEqual({
      url: "http://127.0.0.1:4100",
      appRoot: "/srv/builder",
      route: "/build#agent",
      manifestDir: "/srv/builder/.factory/manifests",
    })
  })
  it.each([
    ["FACTORY_WORKERS", '{"cli-flags":{"url":"http://x","appRoot":"/a"}}', /one builder serves every target/],
    ["FACTORY_BUILDER_TARGET", "/tmp/factory-builder/cli-flags.target.json", /no target file/],
  ])("refuses the retired %s by name", (name, value, message) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(message)
  })
  it("still needs both halves of the pair", () => {
    const { FACTORY_BUILDER_APP_ROOT: _root, ...urlOnly } = base
    expect(() => loadConfig(urlOnly)).toThrow(/FACTORY_BUILDER_APP_ROOT is required/)
    const { FACTORY_WORKER_URL: _url, ...rootOnly } = base
    expect(() => loadConfig(rootOnly)).toThrow(/FACTORY_WORKER_URL is required/)
  })
})
```

(check `DEFAULT_WORKER_ROUTE` in `config.ts` for the route literal and use it). Keep the file's drafter and budget cases unchanged.

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4-example/software-factory-controller exec vitest run test/config.test.ts
```

Expected: FAIL: `builder` is undefined and the retired variables are accepted.

- [ ] **Step 3: Implement the configuration**

In `controller/src/lib/config.ts`:

- `WorkerEndpoint` loses `pin` and `permissions` (and their doc comments); its `manifestDir` comment says "the builder's `FACTORY_BUILDER_MANIFEST_DIR`".
- `EnvSchema`: delete `FACTORY_WORKERS` and `FACTORY_BUILDER_TARGET` from the schema, and before `EnvSchema.safeParse` in `loadConfig` add:

```ts
  const retired: Readonly<Record<string, string>> = {
    FACTORY_WORKERS:
      "one builder serves every target and pin: set FACTORY_WORKER_URL and FACTORY_BUILDER_APP_ROOT",
    FACTORY_BUILDER_TARGET:
      "the builder boots with no target file; each work order's manifest carries its target",
  }
  const stale = Object.keys(retired).filter((name) => env[name] !== undefined)
  if (stale.length > 0)
    throw new Error(
      `Invalid factory configuration:\n${stale.map((name) => `${name} is retired: ${retired[name]}`).join("\n")}`,
    )
```

- `FactoryConfig.workers` becomes `readonly builder: WorkerEndpoint` ("The one builder worker: every target's work orders, at every pin."); delete `workerEndpointFor`, `builderTargetOf`, the `WorkersEnv` schema and the `FACTORY_WORKERS` branch of `loadConfig`; the legacy-pair branch keeps its two "is required" refusals, drops the `FACTORY_BUILDER_TARGET` requirement, and returns:

```ts
  const builder: WorkerEndpoint = {
    url: e.FACTORY_WORKER_URL.replace(/\/$/, ""),
    appRoot: e.FACTORY_BUILDER_APP_ROOT,
    route: e.FACTORY_WORKER_ROUTE,
    manifestDir: e.FACTORY_BUILDER_MANIFEST_DIR ?? defaultManifestDir(e.FACTORY_BUILDER_APP_ROOT),
  }
```

In `controller/src/lib/controller/workers.ts`: `TargetWorker` loses `pin` and `permissions`; `createWorkerMap(config: Pick<FactoryConfig, "builder" | "drafter">, deps)`; replace `resolve`, `readerFor` and `forTarget` with:

```ts
  /** One reader for the one builder: the provider it needs is the same for every thread. */
  const reader = memoized((entry: WorkerEndpoint) => deps.createBuilderReader(entry))
  /** Every target's work orders go to the one builder, at any pin. */
  const forTarget = (_targetId: string): TargetWorker => ({
    client: client(config.builder.url),
    route: config.builder.route,
    reader: reader(config.builder),
    appRoot: config.builder.appRoot,
    manifestDir: config.builder.manifestDir,
  })
```

`WorkerMap.forTarget`'s return type becomes `TargetWorker` (never undefined). Update the module comment ("one builder worker for every target and one drafter"). In `factory.ts`, the two `forTarget(targetId) === undefined` refusals become unreachable: delete the pre-key `no_worker_for_target` block (lines 1243-1251) and the under-key one after `targetId ??= targetOf(row)`, and delete `NoWorkerForTargetError` and its re-export if nothing else imports it (`grep -rn NoWorkerForTargetError examples/software-factory` must print nothing afterwards).

In `controller/src/lib/targets/workspace.ts`, import `isFactoryImage` from `../builder-manifest.js`, delete `builderTarget` and `builderTargetForTask`, and replace `builderSandboxProvider`:

```ts
/**
 * The builder's sandbox provider, as the controller's reader constructs it. The scope is the
 * whole of the address a managed workspace needs: the image is read from the thread's own
 * record (proved in @b4run/sandbox's managed-workspace test "the image is the intent's"), so
 * this provider has no default image and serves every target's threads.
 */
export function builderSandboxProvider(): SandboxProvider {
  return dockerSandbox({ scope: builderSandboxScope, images: isFactoryImage })
}
```

and rewrite the `builderSandboxScope` comment: "Storage identity for the builder's sandboxes: the builder's `b4.config.ts` and the controller's reader both use it, in different processes. A managed workspace is addressed by this scope, the daemon and the thread's recorded operation; its image is in its record."

In `controller/src/lib/runtime.ts`: the `for (const [key, entry] of Object.entries(config.workers))` manifest-directory loop becomes one `mkdirSync(config.builder.manifestDir, { recursive: true })` with the error message `the builder's manifest directory could not be created (${config.builder.manifestDir})`; `builderReader`'s provider becomes `providerFor: () => builderSandboxProvider()`, and its doc comment says the provider is the same for every task; drop the `builderTargetForTask` import.

In `controller/src/lib/controller/factory.ts`: delete `builderEnvironmentRefusal` (266-311), `stalePermissionsRefusal` (313-358) and the block that calls them (the comment beginning "The builder process boots from its target file" through line 1294), then remove the imports they alone used (`builderTarget`, `builderPermissions`, `prepareCommand`, `canon` if unused: let `pnpm --filter @b4-example/software-factory-controller lint` name them).

In `controller/src/lib/builder-manifest.ts`: delete `BuilderTargetSchema`, `BuilderTarget`, `builderTargetPath`, `writeBuilderTarget` and the `builderSandboxScope` import if unused; update the header comment ("One file per work order: the builder's only input").

In `controller/src/cli.ts`: delete the `builder-target` usage lines (51, 58's mention, 60-63) and its handler (790-801); the `builder-manifest` text says the manifest carries the target.

- [ ] **Step 4: Follow the tests**

Delete `controller/test/factory-builder-environment.test.ts` and `controller/test/builder-target-file.ts`. Then make each remaining failure a deliberate edit, not a deletion of intent:

- `controller/test/fake-worker-map.ts`: build from `{ builder: endpoint, drafter }`; `forTarget` returns the one fake worker.
- `controller/test/factory-retry.test.ts`: delete the case asserting "fresh `factory builder-target`" (line ~359): the stale-list refusal no longer exists because the list travels with each manifest.
- `controller/test/runtime.test.ts`, `controller/test/serve-controller.ts`, `controller/test/drafter-end-to-end.integration.test.ts`: replace `FACTORY_BUILDER_TARGET: writeTargetFile(...)` and any `FACTORY_WORKERS` with the pair (`FACTORY_WORKER_URL`, `FACTORY_BUILDER_APP_ROOT`).
- `controller/test/cli.test.ts`: a `builder-target` case becomes "refuses the retired builder-target command" (the CLI's unknown-command error).
- `controller/test/targets-workspace.test.ts`: delete `builderTarget`/`builderTargetForTask` cases; add

```ts
it("gives the reader a provider with no default image that allows only factory images", () => {
  const provider = builderSandboxProvider()
  expect(provider.name).toBe("docker")
  expect(provider.workspaces?.resolveImageEnvironment).toBeTypeOf("function")
})
```

- `controller/test/served-builder.ts`: `serveBuilder()` takes no target; delete `writeBuilderTarget`, the target directory and `FACTORY_BUILDER_TARGET` from `ENV`; the module comment says one builder for every target.

Find every remaining reference:

```bash
grep -rn "FACTORY_WORKERS\|FACTORY_BUILDER_TARGET\|writeBuilderTarget\|BuilderTargetSchema\|builder-target\|builderTargetForTask\|builder_environment_differs\|builder_permissions_stale" examples/software-factory --include='*.ts' --include='*.mjs' --include='*.json'
```

Expected after the edits: only the retired-variable refusals in `config.ts` and their tests.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @b4-example/software-factory-controller typecheck
pnpm --filter @b4-example/software-factory-controller test
pnpm --filter @b4-example/software-factory-controller lint
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -u examples/software-factory/controller
git add examples/software-factory/controller/src examples/software-factory/controller/test
git status --short examples/software-factory
git commit -m "feat(software-factory): the controller dispatches every target and pin to one builder

FACTORY_WORKERS and FACTORY_BUILDER_TARGET are retired and refused by
name; builder_environment_differs and builder_permissions_stale go,
because each thread now runs its own task's image, policy and
permissions from its manifest. The reader's provider needs only the
scope: a managed workspace's image is in its record.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`git add -u` stages the two deletions; check `git status --short` shows nothing outside `examples/software-factory/controller` before committing.)

---

### Task 20: One helper prepares devkit's second pin for every lane that needs it

**Files:**
- Create: `controller/test/devkit-second-pin.ts`
- Modify: `controller/test/target-devkit-pin.integration.test.ts:1-58`

- [ ] **Step 1: Extract the preparation**

Create `controller/test/devkit-second-pin.ts`:

```ts
import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appRoot, targetsDir } from "../src/lib/targets/catalog.ts"

/**
 * `Release 0.10.0 (#782)` on main: after the devkit target was introduced, with every devkit
 * path the target names present. In a shallow checkout `ensurePin` fetches it by sha.
 */
export const SECOND_PIN = "bfaf0c2b3030eebb572703c8f70f0e063593b1fa"

/**
 * Prepare `devkit` at {@link SECOND_PIN} into a COPY of `targets/devkit`
 * (`FACTORY_TARGETS_DIR`), so the working tree is never written. The image stays, and the next
 * lane's build is served from Docker's layer cache. Requires Docker; `test:sandbox` only.
 */
export function prepareDevkitSecondPin(): {
  readonly targetsDir: string
  cleanup(): void
} {
  const copy = mkdtempSync(join(tmpdir(), "factory-devkit-pin-targets-"))
  cpSync(join(targetsDir, "devkit"), join(copy, "devkit"), { recursive: true })
  const started = Date.now()
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/prepare-target.ts", "devkit", "--pin", SECOND_PIN],
    {
      cwd: appRoot,
      env: { ...process.env, FACTORY_TARGETS_DIR: copy },
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 1_140_000,
    },
  )
  process.stderr.write(`target:prepare devkit --pin ${SECOND_PIN}: ${Date.now() - started} ms\n`)
  return { targetsDir: copy, cleanup: () => rmSync(copy, { recursive: true, force: true }) }
}
```

In `controller/test/target-devkit-pin.integration.test.ts`, replace the local `SECOND_PIN`, `copy`, `beforeAll` and `afterAll` with:

```ts
let prepared: ReturnType<typeof prepareDevkitSecondPin>
let copy: string
let manifestPath: string
beforeAll(() => {
  original = readFileSync(shippedPath, "utf8")
  prepared = prepareDevkitSecondPin()
  copy = prepared.targetsDir
  manifestPath = join(copy, "devkit", "target.json")
}, 1_200_000)
afterAll(() => prepared?.cleanup())
```

(import `SECOND_PIN` and `prepareDevkitSecondPin` from `./devkit-second-pin.ts`; `original` is read from the shipped file, which the copy starts equal to). Delete the file's local `let prepareMs = 0` and remove the imports only the moved code used: `cpSync`, `mkdtempSync` and `rmSync` from `node:fs`, `tmpdir` from `node:os`, and `appRoot` from the catalog import. `execFileSync`, `createHash`, `readFileSync` and `join` stay (the tests still use them); `pnpm --filter @b4-example/software-factory-controller lint` names anything left unused.

- [ ] **Step 2: Typecheck and commit**

```bash
pnpm --filter @b4-example/software-factory-controller typecheck
pnpm --filter @b4-example/software-factory-controller lint
git add examples/software-factory/controller/test/devkit-second-pin.ts examples/software-factory/controller/test/target-devkit-pin.integration.test.ts
git commit -m "test(software-factory): one helper prepares devkit's second pin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: typecheck and lint exit 0. The lane itself runs in Task 21.

---

### Task 21: Docker lane: one served builder runs `cli-flags` and `devkit` at two pins

**CI budget (decided: fits, stays in the required lane, no timeout change).** This lane runs in `.github/workflows/ci.yml`'s `sandbox-docker` job (`timeout-minutes: 30`, line 392), step "Software factory controller-owned verification" (`test:sandbox`, line 481). Measured on the last five green `main` runs (2026-09-23 to 2026-09-25, runs 36079578150, 36063550096, 36059617046, 35954981717, 35942418197): the whole job took 10.0, 15.3, 12.3, 11.8 and 12.2 minutes, and the factory step 5.5, 10.0, 7.7, 7.7 and 8.0. The expensive part of this proof, preparing `devkit` at the second pin, is already inside those numbers: `target-devkit-pin.integration.test.ts` prepares it in the same job. The second call here runs the same `prepare-target` on the same runner and is served from Docker's layer cache (it rewrites only the copied `target.json`), then adds two thread admissions (a devkit capture and a `create` each) and five scripted turns with no model latency. Estimate: 1 to 4 minutes more, so 11 to 19 minutes against 30 at the worst observed run. Task 23 Step 2 measures it and makes the test opt-in, like the `cli` target, if it ever passes 24 minutes; the timeout is not raised, because the job's other lanes share it.

**Files:**
- Modify: `controller/test/builder.integration.test.ts` (the header comment, `beforeAll`, the "wrong target" case; add a test)

- [ ] **Step 1: Adapt the existing lane to one builder**

In `controller/test/builder.integration.test.ts`: `builder = await serveBuilder()` (no target); rewrite the header comment's last paragraph to "The builder is configured by one MANIFEST per work order (`writeBuilderManifest(task, dir, { workOrderId })`), which carries the workspace, image, policy and permissions; the resolver loads it by the thread's `metadata.factoryWorkOrderId`." In `beforeAll`, delete the `wo-elsewhere` manifest; in "refuses, at admission and by name, a work order with no manifest or another target's", keep only the `wo-none` row and rename the test "refuses, at admission and by name, a work order with no manifest".

- [ ] **Step 2: Write the proof**

Add at the end of the file (imports: `SECOND_PIN`, `prepareDevkitSecondPin` from `./devkit-second-pin.ts`; `loadTarget`, `imageTag` from `../src/lib/targets/catalog.ts`; `createDocker` is not needed, use `execFileSync` from `node:child_process`):

```ts
// ORDER-COUPLED like the tests above: reuses the file's served builder and aimock journal.
it("serves a cli-flags thread and devkit threads at two pins from one process", async () => {
  const second = prepareDevkitSecondPin()
  const root = await mkdtemp(join(tmpdir(), "factory-builder-capture-"))
  try {
    const devkitTask = loadTask("devkit-spawn-deadline")
    const devkit = await writeBuilderManifest(devkitTask, builder.manifestDir, {
      workOrderId: "wo-devkit",
      captureRoot: root,
    })
    // The same capture at the second pin: only the target block changes, which is all the
    // image and the policy are drawn from. Written as dispatch would, then re-pinned.
    const atSecond = loadTarget("devkit", { targetsDir: second.targetsDir, pin: SECOND_PIN })
    const parsed = BuilderManifestSchema.parse(JSON.parse(await readFile(devkit.path, "utf8")))
    await writeFile(
      join(builder.manifestDir, "wo-devkit-2.json"),
      JSON.stringify({
        ...parsed,
        workOrderId: "wo-devkit-2",
        target: { ...parsed.target, image: imageTag(atSecond), pin: SECOND_PIN },
      }),
    )
    const expected: Record<string, { image: string; localId: string; memoryMb: number }> = {
      "wo-alpha": { image: imageTag(task.target), localId: task.target.image.localId, memoryMb: task.target.resources.memoryMb },
      "wo-devkit": { image: imageTag(devkitTask.target), localId: devkitTask.target.image.localId, memoryMb: devkitTask.target.resources.memoryMb },
      "wo-devkit-2": { image: imageTag(atSecond), localId: atSecond.image.localId, memoryMb: atSecond.resources.memoryMb },
    }
    const threadOf: Record<string, string> = { "wo-alpha": threads[0] as string }
    for (const workOrderId of ["wo-devkit", "wo-devkit-2"]) {
      builder.aimock.addFixtures(
        script().user(LIST).callsTool("listDir", { path: "." }).replies("Listed.").build(),
      )
      const threadId = await builder.createThread(workOrderId)
      threads.push(threadId)
      threadOf[workOrderId] = threadId
      expect((await builder.runTurn(threadId, LIST)).status).toBe(200)
    }
    // Each thread's intent records its own target's image, at its own pin: the image the
    // verifier runs for that task, so no dispatch needs a pin guard.
    const installation = openWorkspaceInstallationReader(builder.appRoot)
    const operations: Record<string, string> = {}
    try {
      for (const [workOrderId, want] of Object.entries(expected)) {
        const record = installation.associations.get(threadOf[workOrderId] as string)
        expect(record?.intent.environment.identity).toBe(want.localId)
        operations[workOrderId] = record?.intent.operationId as string
      }
    } finally {
      installation.close()
    }
    expect(new Set(Object.values(expected).map((want) => want.localId)).size).toBe(3)
    // And each thread's live session runs that image under its own target's memory limit.
    for (const [workOrderId, want] of Object.entries(expected)) {
      builder.aimock.addFixtures(
        script().user(LIST).callsTool("listDir", { path: "." }).replies("Listed.").build(),
      )
      expect((await builder.runTurn(threadOf[workOrderId] as string, LIST)).status).toBe(200)
      const id = execFileSync(
        "docker",
        ["ps", "-q", "--filter", `label=b4.workspace.operation=${operations[workOrderId]}`, "--filter", "label=b4.workspace.role=session"],
        { encoding: "utf8" },
      ).trim()
      const inspected = JSON.parse(
        execFileSync("docker", ["inspect", "--format", "{{json .}}", id], { encoding: "utf8" }),
      ) as { Image: string; HostConfig: { Memory: number } }
      expect(inspected.Image).toBe(want.localId)
      expect(inspected.HostConfig.Memory).toBe(want.memoryMb * 1024 * 1024)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    second.cleanup()
  }
}, 1_500_000)
```

Before running, confirm the devkit task id with `ls examples/software-factory/controller/tasks` (it is `devkit-spawn-deadline` on f2ee6cf6) and that `task.target.resources.memoryMb` is the field `targetSandboxPolicy` reads (`controller/src/lib/targets/workspace.ts:113-123`).

- [ ] **Step 3: Run the lane**

Docker must be running; the lane prepares images it lacks.

```bash
pnpm --filter @b4-example/software-factory-controller target:prepare cli-flags
pnpm --filter @b4-example/software-factory-controller target:prepare devkit
pnpm --filter @b4-example/software-factory-controller exec vitest run --config vitest.sandbox.config.ts test/builder.integration.test.ts
```

Expected: PASS, all tests in the file. The first run spends up to about 20 minutes preparing the second pin; later runs hit the layer cache.

- [ ] **Step 4: Commit**

```bash
git add examples/software-factory/controller/test/builder.integration.test.ts
git commit -m "test(software-factory): one served builder runs cli-flags and devkit at two pins

Each thread's intent records its own target's prepared image at its
own pin, and its session runs that image under its target's memory
limit, from one builder process.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 22: The CI lane and the README

**Files:**
- Modify: `.github/workflows/ci.yml:457-477`
- Modify: `examples/software-factory/README.md` (sections at 17-58, 137-230, 231-377, 587-658)

- [ ] **Step 1: The lane**

The step's `run:` text is fingerprinted, verbatim, by two audited fixtures: `scripts/release/test/fixtures/workflow-entrypoints.json` (the `run` at about line 1090) and `scripts/release/test/fixtures/workflow-safe-executables.json` (the `value` at about line 532). Both must move in the same commit as `ci.yml`, byte for byte. The audit does not help find the difference (it throws one opaque string with no diff), and a naive `JSON.parse`/`JSON.stringify` round trip of a fixture rewrites its `\uXXXX` escapes of non-ASCII text (the fixtures escape `—` and friends) into a phantom diff over the whole file. So the edit is made once, as a function, and applied to the YAML and to the JSON-encoded string in each fixture's raw text.

Save as `$SCRATCH/regen-ci-lane.mjs` (the session scratchpad, not the repository):

```js
import { readFileSync, writeFileSync } from "node:fs"

/** The whole change to the lane: the target-file line goes, the build guard keys on the lane. */
const edit = (text) =>
  text
    .split("\n")
    .filter((line) => !line.includes("factory builder-target --target cli-flags"))
    .join("\n")
    .replaceAll(
      'FACTORY_BUILDER_TARGET="$RUNNER_TEMP/factory-builder/cli-flags.target.json" ',
      "FACTORY_BUILDER_LANE=1 ",
    )

const ci = ".github/workflows/ci.yml"
const yaml = readFileSync(ci, "utf8")
const edited = edit(yaml)
if (edited === yaml) throw new Error("ci.yml: nothing to edit")
writeFileSync(ci, edited)

for (const [file, key] of [
  ["scripts/release/test/fixtures/workflow-entrypoints.json", "run"],
  ["scripts/release/test/fixtures/workflow-safe-executables.json", "value"],
]) {
  const text = readFileSync(file, "utf8")
  const found = []
  JSON.parse(text, (k, v) => {
    if (k === key && typeof v === "string" && v.includes("factory builder-target")) found.push(v)
    return v
  })
  if (found.length !== 1) throw new Error(`${file}: expected one audited run to edit, found ${found.length}`)
  // The lane's text is ASCII, so JSON.stringify encodes it exactly as the fixture does;
  // replace that encoding in the raw text and leave every other byte alone.
  const before = JSON.stringify(found[0])
  const after = JSON.stringify(edit(found[0]))
  if (text.split(before).length !== 2) throw new Error(`${file}: encoded run not found exactly once`)
  writeFileSync(file, text.replace(before, () => after))
}
```

Run it from the repository root and look at the whole change:

```bash
node "$SCRATCH/regen-ci-lane.mjs"
git diff --stat .github/workflows/ci.yml scripts/release/test/fixtures
git diff scripts/release/test/fixtures
```

Expected: three files changed; in each fixture exactly one line differs, and that line differs only by the removed `factory builder-target` command and the two `FACTORY_BUILDER_TARGET=... ` → `FACTORY_BUILDER_LANE=1 ` substitutions. No `\u` escape anywhere in the diff.

Then rewrite the step's comment block (`ci.yml` 457-463, the paragraph beginning "The builder's OWN `check` and `build` run here") to: "The builder's OWN `check` and `build` run here and nowhere else (`FACTORY_BUILDER_LANE=1`; outside this job `scripts/in-lane.mjs` skips them). The builder has no target file: it checks and builds as it runs, against an empty manifest directory. `check` runs the provider preflight, which needs Docker; this lane has it." Comments are not fingerprinted, but rerun the audits after every edit of the file:

```bash
node --test scripts/release/test/workflow-contracts.test.mjs
pnpm test:release-integrity
```

Expected: both pass. If `workflow-contracts` still fails, find the difference by dumping what the audit computes rather than guessing: copy the test to a scratch file beside it (`cp scripts/release/test/workflow-contracts.test.mjs scripts/release/test/zz-dump.test.mjs`, so its relative imports resolve), and in the copy, at each `assert.deepEqual` whose expected side was read from `ENTRYPOINT_ALLOWLIST_PATH` or is `EXECUTABLE_ALLOWLIST` (lines near 2021, 2111, 2328, 2525-2624 on f2ee6cf6), write the actual side first with `writeFileSync(process.env.DUMP, JSON.stringify(actual, null, 2))`; run `DUMP="$SCRATCH/actual.json" node --test scripts/release/test/zz-dump.test.mjs`, diff the `ci.yml` part of `$SCRATCH/actual.json` against the fixture, fix the fixture by the same raw-text method, and DELETE `zz-dump.test.mjs` before committing (`git status --short scripts/release` must show only the two fixtures).

- [ ] **Step 2: The README**

Rewrite, keeping the surrounding prose style:

- "## Run it", steps 1 and 2 (lines 249-313): one step, "Start the builder", with no target file, no per-target copy and no `rsync`:

```
    FACTORY_BUILDER_MANIFEST_DIR=/tmp/builder-manifests \
      OPENAI_API_KEY=… pnpm --filter @b4-example/software-factory-server dev --port 4100
```

  and the paragraph: "One builder serves every target and pin. Each work order's manifest names the image its task is verified in, the sandbox policy and the permission allow-list; the builder records them at the thread's first admission and runs that thread in them, and only an image the factory prepared (`b4-factory-…`) can be named."
- Step 4 (controller): the worker map paragraph and the `FACTORY_WORKERS` example (327-377) go; the pair `FACTORY_WORKER_URL` + `FACTORY_BUILDER_APP_ROOT` (+ `FACTORY_BUILDER_MANIFEST_DIR`) is the builder. Say that `FACTORY_WORKERS` and `FACTORY_BUILDER_TARGET` are refused by name.
- "## What it does not do" and "## What is joined" (137-230): delete "a builder runs at ONE pin" and the `builder_environment_differs` rule; correct "the scope and the image address a thread's workspace" to "the scope addresses it; the image is in the thread's record"; the trust paragraph (around 146) now reads: whoever can write the builder's manifest directory chooses a thread's workspace, image, policy and permissions, within the builder's own bounds (network denied, factory images only, non-interactive). Say plainly that this includes the WHOLE allow-list: `permissions` is a record keyed by any tool name, so a manifest writer also decides the `tool` and `subagent` keys (which tools run without approval and which subagents may be dispatched), not only `bash` and the path keys; the builder's `non-interactive` mode means anything off that list is refused, never asked about.
- "### Environment" (587-658): delete `FACTORY_WORKERS` and `FACTORY_BUILDER_TARGET` rows; add a note that both are retired.

Check the result for the words that must be gone:

```bash
grep -n "builder-target\|FACTORY_BUILDER_TARGET\|FACTORY_WORKERS\|builder_environment_differs\|one pin" examples/software-factory/README.md
```

Expected: only the sentence saying the two variables are retired.

- [ ] **Step 3: Commit**

```bash
pnpm test:release-controller
git add .github/workflows/ci.yml examples/software-factory/README.md scripts/release/test/fixtures/workflow-entrypoints.json scripts/release/test/fixtures/workflow-safe-executables.json
git commit -m "docs(software-factory): one builder in the quickstart and the CI lane

The lane's run text moves with both audited workflow fixtures.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `pnpm test:release-controller` (which runs `workflow-contracts.test.mjs` with the rest of the controller suite) passes before the commit.

---

### Task 23: The PR 3 gate

- [ ] **Step 1: Run it**

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm --filter @b4-example/software-factory-controller test
pnpm --filter @b4-example/software-factory-server test
pnpm --filter @b4-example/software-factory-controller test:sandbox
FACTORY_BUILDER_LANE=1 FACTORY_BUILDER_MANIFEST_DIR=/tmp/factory-lane-manifests pnpm --filter @b4-example/software-factory-server check
FACTORY_BUILDER_LANE=1 FACTORY_BUILDER_MANIFEST_DIR=/tmp/factory-lane-manifests pnpm --filter @b4-example/software-factory-server build
node scripts/check-docs.mjs
pnpm test:release-integrity
pnpm test:release-controller
```

Expected: every command exits 0. `test:sandbox` is the whole Docker lane: the end-to-end lanes dispatch through the controller to the one served builder, the builder lane of Task 21, and the second-pin lane.

- [ ] **Step 2: Measure the Docker job once CI has run the PR**

When Brian asks for the PR and CI has run it, read the `sandbox-docker` job's duration and its "Software factory controller-owned verification" step:

```bash
gh run view <run-id> --json jobs --jq '.jobs[] | select(.name == "sandbox-docker") | {startedAt, completedAt, steps: [.steps[] | select(.name | test("Software factory")) | {startedAt, completedAt}]}'
```

Expected: the job well under its 30-minute `timeout-minutes` (the budget in Task 21 predicts about 13-19 minutes). If it exceeds 24 minutes (80% of the limit), make Task 21's test opt-in exactly as the `cli` target's lane is: wrap it in `it.skipIf(process.env.FACTORY_TEST_TWO_PINS !== "1")`, add `"test:sandbox:two-pins": "FACTORY_TEST_TWO_PINS=1 vitest run --config vitest.sandbox.config.ts test/builder.integration.test.ts"` to `controller/package.json`, say so in the lane comment in `ci.yml` (comments are not fingerprinted), and record the measured minutes in the commit message. Do not raise `timeout-minutes`.

- [ ] **Step 3: No commit unless a gate found something.** Fix it in the task it belongs to, amend that task's commit, rerun this task.

---

## Follow-ups recorded, not in this plan

- **The drafter as the same app.** With `sandbox.thread`, the drafter's reason to be a separate process (rung 3 §6: a builder serves one target, intake runs before a target is chosen) is gone. Folding it in is optional (spec §1) and changes the drafter's image and inspection root handling; its own PR.
- **A controller-side identity check.** The Docker lane proves each builder thread's intent records its target's `localId`. The controller could also refuse, after a turn, a builder thread whose recorded identity differs from `task.target.image.localId` (a moved tag between prepare and dispatch). Cheap with `openWorkspaceInstallationReader`; worth it once item 4's image registry owns tags.
- **Per-thread `images` re-check on reconnect.** A thread admitted under an `images` predicate the operator later narrows keeps running its recorded image (never re-resolved, by design). If that ever needs revoking, it is a deletion of the thread, not a re-resolution.
- **Parent-and-subagent grant sharing.** Under `permissionsMode: "boot"` a subagent's file-store grant is visible to its parent at once; a thread-scoped grant is visible to the parent at its next preparation (each preparation builds its own thread store over the same record). If a turn needs the immediate form, cache the thread store per sandbox key in the manager.

## Self-review against the spec

- §1 "Change": `ThreadSandbox` (Task 2, permissions Task 12), `ThreadSandboxResolver` and `SandboxConfig.thread` exclusive with a resolver `workspace` (Tasks 2, 7; widened to any `workspace`, D5), the provider's image capability (Tasks 2, 3; separate method, D3), `dockerSandbox({ scope, image, images })` (Task 3).
- "The image half is already per thread in storage ... not proved by a test": Task 1, with a mutation check.
- "Policy and permissions ... a per-thread record in the installation store, written in the same transaction as the association": Tasks 4, 13.
- "`getForThread` passes the recorded policy to `reconnect`": Task 5.
- "The permission gate takes a thread-scoped store ... the mode stays per app ... an Always grant ... never written to `.b4/permissions.json`": Tasks 11, 14, 15 (composition, D2).
- "The factory's builder then boots with no target file; ... one builder serves every target and pin": Tasks 17, 18, 19.
- Trust impact: strict manifest validation refusing unknown policy keys and network allowlists (Task 17 tests); recorded at first admission and never re-resolved (Tasks 5 and 8 restart tests); `images` bounds images (Task 3, and before any provider create, Task 5); the dispatch pin guard retires (Task 19) because each thread runs its task's image (Task 21 proves identity equals `localId`).
- Missing record (review item 1): always a record in thread mode, refused at admission when absent (Tasks 4, 5; D11).
- Proof list: two threads with different image, policy and permissions → different `environment.identity` (Tasks 5, 8, 10); `reconnect` receives each thread's policy (Tasks 5, 8, 10); a command allowed in one thread and denied in the other (Task 14; the gate end to end, Task 15); re-admission after restart uses the record without the resolver (Tasks 5, 8, 14); an image refused by `images` fails before any provider create (Tasks 3, 5); Docker lane, one served builder, a `cli-flags` thread and two `devkit` threads at two pins (Task 21).
- Size L: the storage record (4, 13), the manager (5, 14), the provider interface (2, 3), the permission path in `execute-route-core` (15), the build artifact (6), `b4 check` (7).
- Conventions: shape validation that fails closed (Task 7, D8), `exactOptionalPropertyTypes` spreads throughout, `.js`/`.ts` specifiers, changesets patch in the fixed group (Tasks 9, 16; none for the private examples), docs on existing pages without lastmod regeneration (Tasks 9, 16).
- Names used consistently: `ThreadSandbox`, `ThreadSandboxPolicy`, `ThreadSandboxPermissions`, `ThreadSandboxRecord`, `ThreadSandboxResolver`, `resolveImageEnvironment`, `ResolvedThreadSandbox`, `resolveThread`, `threadPolicy`, `threadSandboxes` (`get`, `grants`, `addGrant`), `threadPermissions`, `createThreadPermissionsStore`, `ThreadPermissions`, `ThreadPermissionGrants`, `threadSandboxArtifact`, `verifyWorkspaceResolverArtifact(value, kind)`, `sandboxConfigShapeErrors`, `isFactoryImage`, `FACTORY_IMAGE`, `builderSandboxProvider()`, `prepareDevkitSecondPin`, `SECOND_PIN`, `FACTORY_BUILDER_LANE`.

## Review amendments (2026-09-24)

An independent review found no critical issues. Each item it raised, and where the plan now answers it:

1. **Fail-open on a missing record.** A thread-mode manager now writes a record for every thread, `{ version: 1 }` when the resolver chose nothing (Task 5 `#resolve`, Task 14 kept in step). Admitting an existing association in thread mode with no record is refused as `conflict` (Task 5, D11). Tests: "records every thread it admits", "refuses a thread admitted before the app resolved sandboxes per thread" (static app switched to `sandbox.thread`), "refuses a thread whose record was lost with its table" (Task 5), and the upgrade case in Task 4. **Deviation:** the schema's recreate path does not refuse when associations exist. Every installation from before PR 1 has associations and no tables, so that refusal would stop every existing managed-workspace app from starting after the upgrade. The admission refusal already makes a lost record fail closed in thread mode, and outside thread mode a missing record changes nothing.
2. **Subagents.** Task 15 adds `threadPermissions: () => undefined` to the fake manager in `subagent-sandbox.test.ts:56`, and a new `subagent-thread-permissions.test.ts`: the parent's and the child's preparations both ask for the parent's key, the child is gated by the parent's recorded allow-list, and the child's "Always" lands in the parent's record, where the parent's next load honours it.
3. **Workflow-audit fixtures.** Task 22 now edits `ci.yml` and both fixtures with one scripted function, applied to the YAML and to the JSON-encoded run string in each fixture's raw text (no JSON round trip, so no `\uXXXX` phantom diff). It checks that exactly one line differs per fixture, gives a scratch-copy descriptor dump for when the audit's single opaque failure string needs a diff, and commits all three files together. `pnpm test:release-controller` is in Tasks 22 and 23.
4. **Docker variant image.** Task 10's variant overrides `org.b4run.code-fixer.project`, so `managedTestImage()` never selects it. Its `docker image rm` is best effort, and a check confirms no variant carries the `cli-flags` label.
5. **Policy composition.** D1 now merges `resources` key by key and replaces `env` whole. A `network` mode equal to the app's keeps the app's network object, so an app `allow` keeps its `denylist`; `deny` narrows; `allow` under an app `deny` is refused. D9 also refuses `resources.diskGb`. Tasks 2 and 5, with a new `thread-policy.test.ts`; the docs bullets in Task 9 follow.
6. **Unknown sandbox keys.** `b4 build` runs `sandboxConfigShapeErrors` whenever `config.sandbox` exists, and a test builds an app with a lone `thred:` (Task 7). The changeset names the refusal as a behaviour change (Task 9).
7. **CI time.** Measured on the last five green `main` runs, the `sandbox-docker` job took 10.0 to 15.3 minutes against its 30. The second-pin preparation is already in that job and is served from the layer cache the second time. Decision: the proof stays in the required lane without changing the timeout. Task 23 measures the PR's run and makes the test opt-in (like the `cli` target) past 24 minutes (Task 21 header, Task 23 Step 2).

Minor: Task 5 Step 2 names the real failure (the constructor throws, since a type-only import is erased); Task 8 Step 3 points at Task 7; Task 20 drops `prepareMs` and the imports only the moved code used; D4's refusal is tested with a real `kubernetesSandbox` over a stub client, at check and at boot (Task 7); the PR 3 README trust paragraph and the PR 3 preamble say the manifest writer controls the whole allow-list, `tool` and `subagent` keys included; `b4 check` prints "sandbox: workspace, image and policy are resolved per thread"; the `withManagedWorkspaceReader` doc comments name `sandbox.thread` (Task 9 Step 3).

**PR 3 review follow-up (recorded, not implemented).** The builder's intent records the image ID the manifest's tag resolved to at the thread's first admission, and the verifier resolves the same tag again at verify time; nothing compares either with the target's recorded `target.image.localId`. A tag moved between prepare, admission and verification would build in one image and verify in another with no refusal. The fix is the controller-side identity check already listed under "Follow-ups recorded" (compare the thread's recorded `environment.identity` and the verifier's resolved ID with `task.target.image.localId`, refuse on a mismatch), best done once item 4's image registry owns tags. The PR 3 review also tightened the manifest: its image tag's target and pin segments must equal its own `targetId` and `pin[:12]`.
