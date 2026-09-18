# Thread workspace read — implementation plan

Spec: `docs/superpowers/specs/2026-09-18-thread-workspace-read-design.md`

Branch: `blove/thread-workspace-read` off `origin/main`. Node 24 (`nvm use 24`).

## Task 1 — Contract in `@b4run/workspace`

- Modify: `packages/workspace/src/sandbox-types.ts`
  - Add `ReadOnlyFilesystemBackend`, `WorkspaceReadSource`,
    `OpenWorkspaceReaderInput`, `SandboxWorkspaceReader`.
  - Add the optional `openWorkspaceReader` member to `SandboxProvider` with the
    contract documented in the doc comment: MUST NOT create, replace, start,
    stop or mutate the thread's sandbox; MUST reject writes; MUST throw when the
    thread has no workspace storage; is NOT an authorization boundary.
- Create: `packages/workspace/src/with-workspace-reader.ts` —
  `withWorkspaceReader`, closing in `finally`, `AggregateError` when both body
  and close fail.
- Modify: `packages/workspace/src/inspect-workspace.ts` — widen the parameter to
  `WorkspaceFs | WorkspaceReadSource`; `reader()` keeps its `"filesystem" in
  source` discriminant.
- Modify: `packages/workspace/src/index.ts` — export the new types and
  `withWorkspaceReader`.
- Test: `packages/workspace/test/with-workspace-reader.test.ts` — closes on
  success, closes on throw, aggregates a close failure, propagates the result.
- Test: `packages/workspace/test/inspect-workspace.test.ts` — add a case proving
  an exec-less `WorkspaceReadSource` is accepted.

## Task 2 — Docker implementation

- Create: `packages/sandbox/src/docker/docker-workspace-reader.ts`
  - `openDockerWorkspaceReader({ docker, image, volume, resourceId, threadId,
    signal, runAsNonRoot })`.
  - `docker volume inspect` probe → `sandboxUnavailable` (`B4_E2001`) when
    absent.
  - `docker run -d --rm --name b4-sbx-rdr-<resourceId>-<8 hex> --label
    b4.sandbox.reader=<resourceId> -v <vol>:/workspace:ro --network none
    --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --read-only
    --tmpfs /tmp --tmpfs /run [--user uid:gid] <image> sleep infinity`.
  - `filesystem`: narrow read-only projection of `dockerFilesystem(docker,
    readerContainer)` — no exec lease, no PID-exhaustion recovery (spec D9).
  - `close()`: idempotent, `docker rm -f`, swallow failure.
- Modify: `packages/sandbox/src/docker/docker-sandbox.ts` — wire
  `openWorkspaceReader` using the existing `volumeName`/`resourceId` closures.
- Test: `packages/sandbox/test/docker-workspace-reader.test.ts` (unit, injected
  spawner)
  - no command names the keeper container (the non-disturbance unit proof);
  - arg assertions: `:ro`, `--network none`, `--read-only`, `--cap-drop ALL`,
    `no-new-privileges`, `--pids-limit`, `--user 1000:1000`, reader label;
  - `runAsNonRoot: false` → no `--user`; explicit uid/gid honoured;
  - missing volume → `B4_E2001`;
  - `close()` removes the reader container and is idempotent;
  - reads route `docker exec` at the reader container, never the keeper.

## Task 3 — Fake provider + conformance

- Modify: `packages/sandbox/src/testing/fake-sandbox.ts`
  - Give the in-memory filesystem `lstat`, `readBinaryFile` and `statFile` so it
    matches `dockerFilesystem`'s real capability set (removes fake-vs-real drift
    and makes `inspectWorkspace` usable against the fake).
  - Implement `openWorkspaceReader`: throws when the thread has no volume,
    returns a snapshot-free read-only view, `close()` idempotent.
- Modify: `packages/sandbox/src/testing/conformance.ts` — capability-conditional
  block, skipped when `openWorkspaceReader` is absent:
  - reads bytes written through the acquired handle;
  - `inspectWorkspace(reader)` returns those files;
  - a destroyed thread's reader open throws;
  - after `close()`, the original handle still reads, writes and execs
    (provider-agnostic non-disturbance).
- Test: `packages/sandbox/test/fake-sandbox.test.ts` — direct fake coverage for
  the new members.

## Task 4 — Real-Docker non-disturbance proof

- Modify: `packages/sandbox/test/docker-sandbox.integration.test.ts`
  - keeper container id before/after unchanged; keeper still running; `exec`
    still exit 0; handle still reads and writes;
  - `inspectWorkspace(reader)` sees the worker's file while the keeper runs;
  - reader container removed after `close()`;
  - a write through a `:ro` mount of the same volume fails (kernel proof);
  - reading works after `release()` (keeper gone, volume retained).

## Task 5 — `@b4run/cli/workspace` subpath

- Create: `packages/cli/src/workspace-exports.ts` re-exporting `withWorkspace`,
  `WithWorkspaceOptions`, `cleanupWorkspaces`.
- Modify: `packages/cli/package.json` — `./workspace` export entry.
- Modify: `apps/web/app/components/docs/api-reference.ts` — `runtimeImport` in
  `ARTIFACT_REGISTRY` and `importAddress` in `PACKAGE_CATALOG`.
- Modify: `apps/web/content/docs/api/cli.mdx` — compatibility row and a
  `### @b4run/cli/workspace` export table.
- Bail-out condition: if the api-reference validators make this more than a
  contained change, drop the task and note it in the PR.

## Task 6 — Docs

- Modify: `apps/web/content/docs/sandbox.mdx` — a "Reading a thread's workspace
  from another process" section: the `withWorkspaceReader` +
  `inspectWorkspace` recipe, the not-an-authorization-boundary statement, the
  Kubernetes absence, and the D6 uid caveat. No new page, so the SEO lastmod
  manifest is untouched.
- Modify: `apps/web/content/docs/api/workspace.mdx` and
  `apps/web/content/docs/api/sandbox.mdx` — export tables and the reader
  contract.
- Modify: `packages/workspace/README.md` if its export list needs it.

## Task 7 — Changeset and gates

- `.changeset/*.md` — `patch` for `@b4run/workspace`, `@b4run/sandbox`,
  `@b4run/cli`. Avoid every phrase in `forbiddenContent`
  (`scripts/check-docs.mjs`): no "byte-identical", no "without translation", no
  "What works locally works in production".
- `pnpm lint`, `pnpm build`, `pnpm typecheck`, `pnpm test`,
  `node scripts/check-docs.mjs`, `node scripts/check-changesets.mjs` from the
  repo root.
- `B4_TEST_DOCKER=1` for the gated real-Docker lane locally.
- Commit spec and plan. Open the PR against `main`. Do **not** merge and do
  **not** enable auto-merge — Version Packages PR #730 is open.
