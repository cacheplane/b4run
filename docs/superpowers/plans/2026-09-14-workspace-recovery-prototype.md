# Workspace recovery prototype implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated implementation and review. Track work with the checkboxes below. Run every command from the repository root.

**Goal:** Demonstrate safe private preparation and restart reattachment for both code-fixer fixtures without exporting a new API.

**Architecture:** Test-only manifest, SQLite record/admission, Docker resource adapter, and coordinator modules. One coordinator per canonical local state directory; unpublished attempts are stopped and replaced, selected volumes are reattached without seeding. Real child-process crashes supplement injected provider failures.

**Tech Stack:** Node 24 `node:sqlite`, TypeScript, Vitest, Docker CLI, existing code-fixer image and fixture inputs.

**Spec:** [Approved design](/Users/blove/.codex/worktrees/6f78c71c-8e11-4fce-847d-52818cad5f97/dawn/docs/superpowers/specs/2026-09-14-workspace-recovery-prototype-design.md).

## File responsibilities

All paths below are relative to `packages/sandbox/` unless qualified.

- `test/support/recovery/manifest.ts`: canonical regular-file source manifest and fixture loading. No fixture-specific verification logic.
- `test/support/recovery/store.ts`: admission transaction and committed workspace/attempt records. No Docker commands.
- `test/support/recovery/types.ts`: internal records, resource operations, and fault points shared by test modules.
- `test/support/recovery/docker.ts`: bounded materialization, identity checks, stopped-state confirmation, attachment, cleanup.
- `test/support/recovery/coordinator.ts`: ordered recovery/publication protocol using store and resource operations.
- `test/support/recovery/worker.ts`: child-process driver for crash and admission acceptance tests.
- `test/workspace-recovery-manifest.test.ts`, `test/workspace-recovery-store.test.ts`: input and durable-record tests.
- `test/workspace-recovery.test.ts`: deterministic resource failures and protocol tests.
- `test/workspace-recovery.integration.test.ts`: real Docker and child-process acceptance, gated by `B4_TEST_DOCKER=1`.
- `docs/superpowers/evidence/2026-09-14-workspace-recovery-prototype.md`: measured outcomes and limitations.

No production exports, CLI, provider interfaces, dependencies, or application behavior change. Keep helpers small and source imports `.ts` in tests. Use existing `createDocker` rather than shell interpolation for host operations. Test worker uses Node's type stripping and erasable syntax. Persist the full canonical source manifest in trusted host metadata with the initial create intent; recovery validates its digest and reuses those exact bytes, never current fixture defaults. This is small enough for the two bounded fixtures; production artifact storage remains a later design.

## Task 1: Canonical input and admission records

- [ ] Write manifest tests for deterministic ordering/digest, source-byte change, executable mode, traversal, duplicate paths, invalid links/nonfiles, and both real fixture inventories. Run `pnpm exec vitest run --config packages/sandbox/vitest.config.ts packages/sandbox/test/workspace-recovery-manifest.test.ts`; confirm missing implementation failure.
- [ ] Implement `SourceFile { path: string; content: string; executable: boolean }`, `SourceManifest { digest: string; files: readonly SourceFile[]; dependencyTarget: string }`, and `makeManifest(files, dependencyTarget)`. Digest canonical sorted JSON with SHA256. Restrict UTF-8 fixture input to a strict portable relative-path grammar; reject reserved `.git`, `node_modules`, duplicate and ancestor conflicts. Validate dependency target against the two fixture dependency directories. Fixture loader uses repository-relative URL, manifest inventory, `lstat`, and reads only visible project files plus TASK.md and .gitignore.
- [ ] Write store tests for exclusive second connection/process admission, closed connection reentry, persisted records, and rollback. Run focused test and observe failure before implementation.
- [ ] Implement `RecoveryStore.open(stateDir)` using canonical local path, `admission.sqlite` with lifetime `BEGIN IMMEDIATE`/zero busy timeout, and `state.sqlite` with FULL synchronous metadata transactions. Ensure constructor failure closes all opened connections. Store installation identity in metadata. Rows contain logical ID, environment ID, source digest, status (`preparing|ready|deleting|deleted`), and attempt references. Persist attempt intent before resource creation. Updates verify expected status/attempt. Close metadata before admission. Do not delete lock databases during recovery.
- [ ] Run both focused tests and `pnpm --filter @b4run/sandbox typecheck`. Review and commit task-owned files.

## Task 2: Docker generation operations

- [ ] Define resource seam in `types.ts`: `prepare(attempt, source)`, `stop(attempt)`, `inspect(attempt)`, `attach(attempt)`, `release(attempt)`, `destroy(attempt)`. Attempt includes installation/logical/generation IDs, resolved image ID, and derived unique volume/preparer/session names plus discovered container IDs. Return structured identity/status; nonzero CLI exit must be classified, not swallowed.
- [ ] Add focused fake-Docker tests before implementing operations. Test foreign labels, missing resources versus transport error, failed stop, lost create response, and cleanup failure.
- [ ] Implement adapter with managed installation/generation labels on every resource. Resolve image tag once to image ID. Create volume then stopped preparer with deterministic attempt name; inspect/read its immutable ID before start. On recovery, discover by name only to validate labels and pin ID, then use ID for mutations. No privileged host mounts or Docker socket in sandbox. No network during preparation.
- [ ] Materialize via trusted Node code and JSON stdin into fresh storage, generate Git baseline with fixed author/committer identity and timestamps, make the exact dependency symlink, validate manifest bytes/modes plus Git tracked tree/status and allowed generated entries. Explicitly exclude host Git config/hooks. Stop whole container, inspect stopped state, then return validation result. No success based solely on exec exit.
- [ ] Attach a separately named session with selected volume and recorded image; filesystem writes operate using immutable container ID. Explicit stop/release confirms absence. Destruction checks labels and stops both possible compute resources before volume removal. Inspect absence via daemon inventory plus checked result, never arbitrary error matching as proof of absence.
- [ ] Run unit tests and typecheck. Review and commit task-owned files.

## Task 3: Coordinator and deterministic recovery

- [ ] Write failure tests around a fake resource adapter with durable resource state independent of coordinator instance. Assert no partial attachment, no seed on ready reconnect, and no cleanup of other generations.
- [ ] Implement `create(logicalId, source, imageId)` and `reconnect(logicalId)` separately. Existing create with different intent conflicts. Reconnect uses recorded provenance. New attempts persist before provisioning. Ready publication requires successful preparation and confirmed stop. Crash hook names: `intent`, `created`, `copying`, `validated`, `stopped`, `published`, `deleting`.
- [ ] On restart, inspect/stop any unpublished attempt, confirm ownership and stopped state, destroy only that attempt, and allocate a fresh generation. Retain intent after ordinary preparation failure for later recovery; do not silently destroy on unknown state. Selected missing volume returns lost-workspace. Unknown physical resource returns conflict.
- [ ] Implement release and durable deleting state. Deletion retries do not attach; record completed deletion only after confirmed removal. Preserve primary failure and cleanup outcome distinctly in the test harness.
- [ ] Exercise every deterministic acceptance case from spec, including acknowledgement loss, failed inspection/stop/delete, publication boundary and conflicting defaults. Run unit tests; review and commit.

## Task 4: Real process and Docker qualification

- [ ] Add worker driver using structured argv/IPC or JSON lines, bounded process timeouts, and explicit pause-at-fault messages. Parent kills worker only after requested boundary is observed. Use independent processes for admission and host-restart tests. Always join terminated child and capture stderr/exit.
- [ ] Preserve the original seeded-provider failure as a diagnostic test, importing actual example helper where test compiler boundaries allow, otherwise loading it in an isolated worker. Do not duplicate a pretend version. Run with retained Docker storage and assert observed overwrite/setup failure/destruction rather than leave a red test in CI.
- [ ] Build image before fixture tests: `docker build -t b4-code-fixer-recovery:local examples/code-fixer/server`. Resolve ID and record it. This build installs existing locked fixture dependencies; no model calls.
- [ ] Run both fixtures through fresh create, edit/release/reconnect, fresh-host reconnect, crash during preparation, before publication and after publication. Check initial Git baseline persists. Validate deterministic tests separately cover provider faults unsuitable for reliable real-daemon injection.
- [ ] Run second coordinator contention and killed-coordinator reentry. Confirm abandoned preparation is stopped before replacement and unpublished storage is never attached. Test deletion restart, missing selected volume and foreign resource refusal. Harness cleanup selects only its installation/attempt labels and reports leftovers.
- [ ] Command: `B4_TEST_DOCKER=1 pnpm exec vitest run --config packages/sandbox/vitest.config.ts packages/sandbox/test/workspace-recovery.integration.test.ts`. Record passing/failing cases and resources. Run scoped formatting, sandbox unit suite, typecheck, `node scripts/check-docs.mjs`, and required repository validation before completion. Changeset should not be required for test-only additions; verify scope rather than invent a release.
- [ ] Review complete diff for spec compliance, then code quality. Fix substantive issues and rerun affected tests. Update evidence and plan checkboxes, commit. No push or PR before requested application walkthrough.

## Completion evidence

Record exact tests run, image ID, fixture digests, host/daemon versions, cold preparation and retained attachment timing boundaries, and residual resource count. Separate real process crashes from injected errors. Explicitly state this single-host test prototype does not qualify Kubernetes, live-writer takeover, power-loss durability, shared deployment storage, or a public API.
