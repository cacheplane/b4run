# Workspace over the Agent Protocol (read a thread's workspace; hand one over at creation): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A B4.run worker serves its threads' workspaces over its own Agent Protocol port, read (`POST /threads/:thread_id/workspace/inspect`) and handed over at creation (`PUT /workspace/sources/:digest`, then `POST /threads` with `workspace`), both behind the app's thread-access policy; the software factory's controller then talks to its workers by URL and token only, with no app root, no installation store and no manifest directory.

**Architecture:** Two opt-in `sandbox` options, `workspaceRead: "http"` (spec item 3) and `stagedWorkspaces` (spec item 2), each refused at `b4 check`, `b4 build` and boot unless the app has a thread-access policy. The read runs the code the controller runs today (the managed reader, then `inspectWorkspace`, now with `root` and typed errors) inside the worker, holding the thread's one run slot. The handover stores a content-addressed `SourceBundle` in the worker's installation content store, records the thread's staged reference in the same SQLite database at create, hands it to the resolver as `WorkspaceResolverInput.staged` at first admission, and reclaims unreferenced sources after a retention window. The factory adopts each in its own PR, after a first PR that puts a bearer-token policy on its workers.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, `node:sqlite`, Web `Request`/`Response`, Docker CLI (factory lanes), zod (examples only), changesets, `node scripts/check-docs.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md` §3 (read) and §2 (handover), the intro (trust constraint), §7 to §9. Follows the as-landed per-thread sandbox plan (`docs/superpowers/plans/2026-09-24-per-thread-sandbox.md`): fail closed; record at first admission, never re-resolve; strict own-property verifiers; `B4Config` has no runtime schema, so every new option gets shape validation and the `sandbox` block refuses unknown keys (D8 there); `signal.throwIfAborted()` after every await that precedes a durable write.

**Standing rules:** `source ~/.nvm/nvm.sh && nvm use 24` before any test run (Node 22 makes unrelated tests fail). Never `git stash`; add files by path; never `git add -A`. Never bare `biome check --write` at the root: use `pnpm --filter <pkg> lint` or `pnpm lint:fix`. Commands run from the repository root. `src/` imports use `.js`, tests use `.ts`. `exactOptionalPropertyTypes` is on: conditional spreads, never `{ x: undefined }`. Tests that import `@b4run/workspace`, `@b4run/workspace/node`, `@b4run/sqlite-storage` or `@b4run/cli/*` by package name read `dist/`: rebuild the changed package (`pnpm --filter <pkg> build`) before running a dependent package's tests. `packages/cli/src/lib/dev/runtime-fetch-core.ts` and everything it imports at runtime must stay free of `node:` imports (`packages/cli/test/fetch-entry-purity.test.ts`); import runtime modules there as types only. Do not pipe a gate through `tail`/`head`: the exit code is the result. Commit after every task with a message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Pin the branch before dispatching subagents (`git switch <branch>`, check `git worktree list`), per `AGENTS.md`.

**Depends on:** PR cacheplane/b4run#836 (one builder, manifest v2) for PRs 1, 3 and 5, which are written against its head `690479c1`. If #836 has not merged when PR 1 starts, branch PR 1 from `origin/blove/factory-one-builder` and rebase onto `main` after it merges. PRs 2 and 4 are framework-only and start from `main`.

---

## Decisions needed (settle before PR 2 starts)

Each has a recommendation, and the plan is written to it. If Brian decides otherwise, the named tasks change.

- **D1. PR split.** Recommendation: **five PRs**, below. The shared prerequisite ("the thread-access token lands on the worker", spec §8) is example code, not framework: `threadAccess` already receives every request's headers (verified below), so a bearer policy needs no framework change. It ships first and on its own (PR 1). Each framework item then ships alone (PRs 2 and 4) and the factory adopts each in its own PR (3 and 5). Order: 1, 2, 3, 4, 5; PR 2 can be developed beside PR 1.
- **D2. Token scheme and where the secret comes from.** (Amended: it is a bearer credential, so the README requires loopback, a private network or TLS, and both clients refuse redirects.) Recommendation: **one shared bearer token, `FACTORY_WORKER_TOKEN`, from the operator's environment** on the controller and on every worker; at least 32 characters, no whitespace; `authorization: Bearer <token>` on every request the controller sends; each worker's `src/thread-access.ts` compares it in constant time and denies everything else with `403`. The token is read when the policy module loads, so a worker without it fails to boot (`B4_E3003`) instead of serving open endpoints. Not in thread metadata, not in a stamp, never logged. One token rather than one per worker: both workers trust exactly one caller, and §7's `factory up` glue can mint it per run later. No framework helper: a policy is ten lines, and a shipped helper would have to pick a header and a comparison for everyone. Caveat recorded in the README: `/healthz`, `/readyz` and the memory-candidate endpoints are not thread endpoints and stay open (`packages/cli/test/thread-access-coverage.test.ts`, `EXEMPT`); the factory's workers have no memory.
- **D3. Request body limits: values and where enforced.** Recommendation: **per endpoint, in the runtime core** (`runtime-fetch-core.ts`, so the dev server, `b4 start`, Hono and Vercel all enforce it), by one bounded reader that refuses a declared `content-length` over the limit before reading anything and otherwise counts streamed bytes and cancels the stream the moment it passes the limit; `413` with `code: "payload_too_large"`. Values: the upload's default and ceiling is **96 MiB**, the installation content store's own payload cap (`packages/sqlite-storage/src/workspace/source-store.ts:10`; a 64 MiB bundle encodes to about 86 MiB), lowerable with `stagedWorkspaces.maxUploadBytes`; `POST /threads` **1 MiB, only in an app with `stagedWorkspaces`** (every other app reads its create body as before); the inspect request **64 KiB**. Uploads run **one at a time per process** (`429 upload_in_flight`) and all uploaded sources together stay within **`maxStagedBytes`** (default 1 GiB; `507`), because verifying and storing an upload holds it four to five times over in memory. On Node the adapter owns the body stream, so a refused body is discarded rather than resetting the socket and the 413 reaches the client (Task 8). The four other body-reading endpoints (`runs/stream`, `runs/wait`, `resume`, `POST /agui/:routeId`) are unbounded today and stay so in this plan: bounding them is a behaviour change for every app, recorded as a follow-up.
- **D4. `staged` in `WorkspaceResolverInput` or `ThreadSandbox`?** Recommendation: **`WorkspaceResolverInput.staged`** (the spec's placement). It is input: both resolver kinds receive `WorkspaceResolverInput` (`packages/workspace/src/sandbox-types.ts:166-185, 231`), and `ThreadSandbox.workspace` already accepts a `CapturedWorkspaceDefinition` (`:209`), so a thread resolver returns `{ workspace: thread.staged, ... }`. A field on `ThreadSandbox` would be an output naming what the input already carries.
- **D5. What the upload carries.** Recommendation: **the upload body is a `SourceBundle` (content-addressed by its own digest); `environmentLinks` and `baseline` travel on `POST /threads` beside the digest.** The spec's body, a whole `CapturedWorkspaceDefinition` keyed by the source digest, cannot work: the source digest covers only the files (`packages/workspace/src/source-bundle.ts:52-61`), so two definitions with the same files and different links or baseline would share a key, and `200 (already held)` would answer for a definition the server does not hold. The content store is already keyed by exactly this digest (`source-store.ts:44-50`).
- **D6. Where the thread's staged reference is recorded.** Recommendation: **in the worker's installation database**, a `workspace_thread_staged` row written right after the thread row, not a reserved metadata key. Reclaim must see every reference in one database (the thread store may be Postgres); the row is written in a savepoint that re-checks the source is still held, and a failure after the thread row exists deletes that row (only when it is the row this request wrote). `DELETE /threads/:id` removes the staged row BEFORE the thread row, so a failed delete fails closed and an id reused through a run endpoint inherits nothing; a boot sweep removes the staged rows of threads whose rows are gone.
- **D7. Retention window and who reclaims.** Recommendation: **24 hours by default (`stagedWorkspaces.retentionMs`, at least 60 s, at most 30 days), reclaimed by the worker that owns the installation, at boot and after each upload, with no timer.** Referenced (never reclaimed): the source of every association not deleted, the source of every staged thread row, the app's static definition, and any upload younger than the window. Everything else goes: an unreferenced upload past the window, and any unreferenced non-upload source at once (rung 3 §9's orphan rows; #832 already stopped most new ones by putting the source after the environment resolves). Only apps that enable `stagedWorkspaces` reclaim; extending the orphan sweep to every managed app is a follow-up. A re-upload of held bytes refreshes the upload time, so a controller that re-stages before creating never races the window.
- **D8. Inspect response size and streaming.** Recommendation: **one JSON response, not streamed, bounded by server caps**: `maxEntries` ≤ 10,000, `maxFileBytes` ≤ 16 MiB, `maxTotalBytes` ≤ 32 MiB; a request over a cap is `400`; defaults are `inspectWorkspace`'s own (10,000; 2 MiB; 16 MiB). The worker's Node adapter buffers a JSON reply whole (`packages/cli/src/lib/dev/node-web-adapter.ts:111-122`), and the controller needs the whole inventory before it can diff, so streaming buys nothing.
- **D9. How the read excludes a run.** Recommendation: **the read holds the thread's run slot** (`RunRegistry.begin`) for its whole duration, not only a check at the start. A run started meanwhile gets the ordinary `409 run_in_flight`, `DELETE` is refused the same way, a `cancel` aborts the read, and shutdown drains it. A check-then-read would let a turn start mid-inspection and return an inventory from two moments.
- **D10. Error classification.** Recommendation: **typed errors in `@b4run/workspace`**: `WorkspaceInspectionError` (`invalid_options`, `root_missing`, `refused`, `changed`) and `WorkspaceReadLimitError` (thrown by B4.run's bounded reads, messages unchanged). The batched read that finds a file larger than its walked size (#829) becomes `changed` → `409 workspace_changed`, never a generic 500; a policy refusal is `422 workspace_inspection_refused`; a missing `root` is `422 workspace_root_missing` with `{ root, kind }`; a backend I/O failure stays untyped and is a 500.
- **D11. Operations and actions.** Recommendation: **`thread.workspace` under `read`** (a denial defaults to the same 404 a missing thread returns), **`workspace.source.put` under `create`** with no thread id and no thread, and a new required **`ThreadAccessRequest.requestedWorkspace`**: the whole reference (`{ sourceDigest, environmentLinks?, baseline? }`) on a `thread.create` that names one, and `{ sourceDigest }` on `workspace.source.put`, so one rule covers staging and choosing. Without it a policy cannot tell "create a thread" from "create a thread and choose its workspace"; with it, an app whose users may create threads can still reserve workspace choice to a service caller. The docs say plainly that enabling `stagedWorkspaces` means auditing the `create` handler. Both workspace endpoints check the feature only after the gate, so an unauthorized caller cannot tell whether it is on.
- **D12. What each option requires, and what a stray `workspace` means.** Recommendation: `workspaceRead` requires `sandbox.workspace` or `sandbox.thread` and a provider whose managed workspaces implement `openWorkspaceReader` (refused at boot otherwise). `stagedWorkspaces` requires a resolver (`sandbox.thread`, or a function `sandbox.workspace`): with a static definition the staged workspace would be silently ignored. A `POST /threads` body carrying `workspace` on an app without the option is `400 workspace_not_accepted`, not ignored: today the runtime ignores unknown body keys (`runtime-fetch-core.ts:1364-1380`), and ignoring this one would hand a client a thread without the workspace it asked for.
- **D13. How the factory's builder target block travels once the manifest is gone.** Recommendation: **in thread metadata, under one key `factoryBuilder`, parsed strictly by the builder and bound to the staged workspace by its whole reference** (`factoryBuilder.workspace`, `{ sourceDigest, environmentLinks, baseline? }`, must equal the staged definition's digest, links and baseline). With PR 1's policy only the controller can create a thread, and metadata is written only at create (run endpoints accept none), so metadata is exactly as controller-authored as the manifest file was, with the boundary moved from filesystem write access to the token. The drafter's handoff is `factoryDrafter: { version, workOrderId, sourceDigest }` under the same rule.
- **D14. The `sourceDigest` check.** Recommendation: the client helper takes `expectedSourceDigest` and refuses a mismatched answer (`code: "source_mismatch"`), and it also refuses an answer whose `threadId` is not the one asked for. The controller passes the digest it journalled when it handed that thread its workspace. Recorded honestly: two threads with the same source (a `retry` of the same task) have the same digest, so the check refuses a worker answering with a different workspace, not every wrong thread; the thread id in the path, the echo and the token are the rest.

## Verification of the spec against main (feaf517b) and #836 (690479c1)

The spec's line references are to 7c7ad3c2. Re-located:

| Spec claim | Where now | Verdict |
|---|---|---|
| §2 `dispatch` captures and writes `<manifestDir>/<workOrderId>.json` (`controller/src/lib/builder-manifest.ts:177-210`) | #836: `writeBuilderManifest` at `examples/software-factory/controller/src/lib/builder-manifest.ts:145-185`, called at `controller/factory.ts:1199-1216` (#836), read by `server/src/builder-manifest.ts` `loadBuilderManifest` in `server/b4.config.ts`'s `sandbox.thread` | Confirmed (moved); since #836 the file also carries the target block (image, pin, policy, permissions) |
| `intake` writes the drafter's (`drafter-manifest.ts:96`), ~20 MiB (README:391-393) | `writeDrafterManifest` at `controller/src/lib/drafter-manifest.ts:99-129`; README "some 20 MiB" at #836 README:460 | Confirmed (moved) |
| Both sides set `FACTORY_*_MANIFEST_DIR`; the controller owns cleanup on block, approval, cancel, reconcile | #836 README:277, 298, 312-316, 326; `controller/manifest-files.ts` (`removeJournalledManifest`, `removeOwnManifest`, `removeUnhandedManifest`); `reconcile.ts:47, 82` | Confirmed |
| `POST /threads` accepts only `metadata` (`runtime-fetch-core.ts:1361-1399`) | `packages/cli/src/lib/dev/runtime-fetch-core.ts:1364-1430` | Confirmed; other body keys are silently ignored, which is why D12 refuses `workspace` on an app without the option |
| "I found no explicit request body limit in `runtime-fetch-core.ts` ... not checked what the Node server enforces" | Unbounded `request.text()` at `runtime-fetch-core.ts:1365` (threads), `:1975` (runs/stream), `:2341` (runs/wait), `:3239` (resume), `agui-handler.ts:252`; the Node adapter hands the `IncomingMessage` through as the body stream (`node-web-adapter.ts:52-56`); `createServer(listener)` with no limit (`runtime-server.ts:206`) | **Confirmed, and wider than stated**: no layer bounds any request body. D3 |
| The server verifies the upload with `verifyCapturedWorkspaceDefinition`, "digest equals the path" | `verifyCapturedWorkspaceDefinition` at `packages/workspace/src/managed-workspace-node.ts:96-107`; the digest is the SourceBundle's (`source-bundle.ts:52-61`) and covers files only; the content store keys on it (`packages/sqlite-storage/src/workspace/source-store.ts:44-50`) with a 96 MiB payload cap (`:10`) over bundle limits of 64 MiB total, 16 MiB a file, 10,000 entries (`packages/workspace/src/source-validation.ts:1-3`) | **Refuted as specified**: a definition is not addressed by its source digest. D5 |
| The policy receives request headers; a bearer token only the controller holds is expressible today | `makeThreadGate` builds `headers` with `headersToRecord` (`packages/cli/src/lib/dev/thread-gate.ts:160-190`); `ThreadAccessRequest.headers` (`packages/sdk/src/thread-access.ts`, lowercase keys, repeats joined with `", "`); `fallback` is required (`validateThreadAccessPolicy`, `thread-access.ts:47-63`); the policy loads at boot and a broken one fails boot (`runtime-fetch-core.ts:465-494`) | Confirmed. Caveats: no policy means every thread endpoint is open (`threadAccessBootLine`); comparison strength is the policy's (D2 uses `timingSafeEqual`); health and memory endpoints are exempt |
| New operations `thread.workspace`, `workspace.source.put` | `ThreadOperation` at `packages/sdk/src/thread-access.ts:45-71`, 11 members, pinned by `packages/sdk/test/thread-access.contract.ts:27-41`; route table pinned at 16 entries by `packages/cli/test/thread-access-coverage.test.ts` | Confirmed absent; both pins move (17 in PR 2, 18 in PR 4) |
| §3 the controller opens the worker's installation store under its app root (`managed-workspace-reader.ts:51-57`) | `openWorkspaceInstallationReader(appRoot)` at `packages/cli/src/lib/runtime/managed-workspace-reader.ts:52-58`, inside `openManagedWorkspaceReader(options: { appRoot, provider, threadId, signal, runAsNonRoot? })` (`:37-91`) | Confirmed |
| The Docker binding check requires the same daemon (`managed-workspace.ts:104-113`) | `binding()` at `packages/sandbox/src/docker/managed-workspace.ts:107-114` compares `docker info` ID with the intent's account | Confirmed (moved) |
| Re-rooting at `draft/` lives in the controller's reader (`workspace-reader.ts:63-71`) | `rootSegments` `:115-128`, `requireDirectory` `:135-152`, used at `:205-222` of `examples/software-factory/controller/src/lib/worker/workspace-reader.ts` | Confirmed (moved) |
| The worker serves it with `openManagedWorkspaceReader`, then `inspectWorkspace` | `inspectWorkspace(source, options)` at `packages/workspace/src/inspect-workspace.ts:196`; #829's batch path `batched()` `:57-140` prefetches every file with `maxBytes` = its walked size (`:122`) | Confirmed. In the worker the manager already owns the installation, so the endpoint reads the association through it, not a second read-only connection |
| (brief) A file growing between walk and read throws "exceeds maxBytes"; how is it classified? | The Docker backend throws a plain `Error("readBinaryFile <path>: content exceeds maxBytes (N).")` (`packages/sandbox/src/bounded-read.ts:27`); `inspectWorkspace` rethrows it; the controller maps every read failure but `WorkspaceRootMissingError` to `workspace_unreadable` / inconclusive (`controller/verify.ts:73-79`, `intake.ts:312-330`) | Unclassified today; over HTTP it would be a generic 500. D10 |
| "It refuses while a run is in flight" | In-memory `RunRegistry` (`packages/cli/src/lib/dev/run-registry.ts`), `has()` used by `DELETE` (`runtime-fetch-core.ts:1505`); the persisted `busy` status is deliberately not used (finding 7) | Confirmed as a mechanism; a check alone races (D9) |
| `root` moves into `inspectWorkspace` | `InspectWorkspaceOptions` has no `root` (`inspect-workspace.ts:5-17`) | Confirmed absent |
| `readThreadWorkspace` ships beside `withManagedWorkspaceReader` in `@b4run/cli/workspace` | `packages/cli/src/workspace-exports.ts`; the subpath is in the API inventory (`scripts/check-docs.mjs:1031`, `apps/web/content/docs/api/cli.mdx:155-166`) | Confirmed; the new exports must be documented there |
| (brief) Does the factory builder return its workspace from the thread resolver? | #836 `server/b4.config.ts`: `sandbox.thread` returns `{ workspace: verifyCapturedWorkspaceDefinition(manifest.workspace), environment, policy, permissions }`; the drafter still uses a `sandbox.workspace` resolver (`drafter/b4.config.ts`) | Yes. So `staged` flows through `WorkspaceResolverInput` to both (D4); the manager passes `{ threadId, metadata, signal }` today (`packages/cli/src/lib/runtime/managed-workspace-manager.ts:61-80`, `#resolve` `:136-176`) |
| The option cannot be enabled without a policy; boot knows both | `threadAccess` resolves at `runtime-fetch-core.ts:472-494`, the sandbox manager at `:517-521`, and a throw in the following `try` releases the manager (`:1143-1152`); `b4 check`/`b4 build` can see a policy file with `findThreadAccessFile` (`packages/cli/src/lib/dev/thread-access-node.ts:85`) | Confirmed: the refusal fits at all three |

## Where I think the spec is wrong or incomplete

1. **The upload's content address.** A `CapturedWorkspaceDefinition` keyed by its source digest is ambiguous (D5).
2. **"A worker answering for the wrong thread is refused" by `sourceDigest`** holds only when the two threads' sources differ; a factory retry reuses the task's source. The echoed `threadId` and the token do the rest (D14).
3. **"Refuses while a run is in flight"** as a check races; the read must hold the slot (D9).
4. **The response list** `409 run_in_flight | 404 lost | 410 expired` omits a thread never run (no workspace yet), a workspace still being created, a missing `root`, a policy refusal, and the grown-file race (D10).
5. **Body limits** are missing everywhere, not only on the new endpoint (D3).
6. **"The resolver may return it as is"** needs two guards the spec leaves out: the option requires a resolver, and a `workspace` sent to an app without the option is refused (D12).
7. **The upload is not thread-scoped**, so it is authorized by the app's `create` handler; an app whose users may create threads would let them choose workspaces unless the policy can see the request (D11's `requestedWorkspace`).
8. **Orphan-source reclaim** (rung 3 §9) is half closed already: #832 moved `sources.put` after the environment resolves. What remains is sources of deleted associations and pre-#832 orphans (D7).
9. **§7's single `worker.token`** leaves `/healthz`, `/readyz` and the memory endpoints open, since they are not thread endpoints; harmless for the factory, worth a line in the README (D2).

## PR split

| PR | Branch | Ships | Stands alone because |
|---|---|---|---|
| **1. The factory's workers answer only the controller** | `blove/factory-worker-token` (off `main` after #836, else off #836) | `src/thread-access.ts` in the builder and the drafter; `FACTORY_WORKER_TOKEN` on both and on the controller; the controller's client sends it on every request | Example-only; closes today's open ports whatever else lands; no changeset (private packages) |
| **2. Read a thread's workspace over HTTP** | `blove/workspace-read-http` (off `main`) | `@b4run/workspace` typed inspection errors and `root`; `@b4run/sandbox` typed read-limit error; `thread.workspace`; `sandbox.workspaceRead`; bounded body reader; `POST /threads/:thread_id/workspace/inspect`; `readThreadWorkspace`; docs; changeset | Off by default, refused without a policy, fully tested with the managed fixture |
| **3. The factory reads its workers over HTTP** | `blove/factory-read-http` (off PR 1 + PR 2 on `main`) | Workers set `workspaceRead`; the controller's reader is URL + token + journalled digest; `FACTORY_BUILDER_APP_ROOT`, `FACTORY_DRAFTER_APP_ROOT`, `FACTORY_DRAFTER_IMAGE` retired; Docker lane with no path to a worker's `.b4` | Example-only; manifests still on disk until PR 5 |
| **4. The workspace travels with thread creation** | `blove/staged-workspaces` (off `main` after PR 2) | `StagedWorkspaceReference`; `WorkspaceResolverInput.staged`; the staged store and reclaim in `@b4run/sqlite-storage`; `workspace.source.put`, `requestedWorkspace`; `sandbox.stagedWorkspaces`; `PUT /workspace/sources/:digest`; `POST /threads` `workspace` and its 1 MiB limit; docs; changeset | Off by default, refused without a policy and without a resolver |
| **5. The factory hands workspaces over the protocol** | `blove/factory-staged-workspaces` (off PR 3 + PR 4 on `main`) | Controller uploads and creates with `workspace` and a metadata handoff; builder and drafter resolvers serve `thread.staged`; manifest directories and their cleanup retired; `ci.yml` and both workflow-audit fixtures; README | Example-only; the last shared-filesystem dependency goes |

Each PR passes its own gate (Tasks 4, 14, 19, 27, 33). PR 2 and PR 4 each carry a patch changeset (fixed group, `AGENTS.md`); PRs 1, 3, 5 touch only private example packages and need none (`node scripts/check-changesets.mjs` confirms).

---

## File map

**PR 1** (under `examples/software-factory/`)

| File | Change |
|---|---|
| `server/src/thread-access.ts`, `drafter/src/thread-access.ts` (new, identical) | bearer-token policy, `workerToken`, `isController` |
| `controller/src/lib/config.ts` | `FACTORY_WORKER_TOKEN` required; `workerToken` |
| `controller/src/lib/worker/client.ts` | `createHttpWorkerClient(url, { token, fetch? })`, header on every call |
| `controller/src/lib/runtime.ts` | pass the token |
| `controller/test/worker-token.test.ts` (new) | the policy, and the two copies equal |
| `controller/test/client.test.ts`, `config.test.ts`, `served-builder.ts`, `serve-controller.ts`, `drafter-end-to-end.integration.test.ts`, `builder.integration.test.ts` | token in helpers; a 403 through the served builder |
| `README.md` | the token |

**PR 2**

| File | Change |
|---|---|
| `packages/workspace/src/inspection-errors.ts` (new) | `WorkspaceReadLimitError`, `WorkspaceInspectionError`, guards |
| `packages/workspace/src/inspect-workspace.ts` | typed errors, `root` |
| `packages/workspace/src/local-filesystem.ts` | throw `WorkspaceReadLimitError` |
| `packages/workspace/src/sandbox-types.ts` | `SandboxConfig.workspaceRead` |
| `packages/workspace/src/index.ts` | exports |
| `packages/workspace/test/inspect-workspace.test.ts` | classification and `root` |
| `packages/sandbox/src/bounded-read.ts`, `packages/sandbox/src/testing/fake-sandbox.ts` | throw `WorkspaceReadLimitError` |
| `packages/sandbox/test/bounded-read.test.ts` (new) | typed error, message kept |
| `packages/sdk/src/thread-access.ts`, `packages/sdk/test/thread-access.contract.ts` | `thread.workspace` |
| `packages/cli/src/lib/dev/bounded-body.ts` (new) | `readBoundedText`, `RequestBodyTooLargeError`, `payloadTooLarge` |
| `packages/cli/src/lib/runtime/workspace-protocol.ts` (new, types and pure helpers) | request/outcome types, option names, policy message |
| `packages/cli/src/lib/dev/thread-workspace-http.ts` (new, pure) | request parser, response builder |
| `packages/cli/src/lib/runtime/sandbox-config-shape.ts` | `workspaceRead` keys and rules |
| `packages/cli/src/lib/runtime/collect-sandbox-errors.ts`, `packages/cli/src/commands/build.ts`, `packages/cli/src/commands/check.ts` | policy file required; report line |
| `packages/cli/src/lib/runtime/resolve-sandbox.ts` | settings; reader capability at boot |
| `packages/cli/src/lib/runtime/managed-workspace-manager.ts` | `inspectThread`, `inspectFailure` |
| `packages/cli/src/lib/runtime/sandbox-manager.ts` | `workspaceProtocol`, `inspectThread` |
| `packages/cli/src/lib/dev/runtime-fetch-core.ts` | boot refusal; the endpoint |
| `packages/cli/src/lib/runtime/read-thread-workspace.ts` (new), `packages/cli/src/workspace-exports.ts` | client |
| `packages/cli/test/bounded-body.test.ts`, `workspace-protocol-config.test.ts`, `managed-workspace-inspect.test.ts`, `thread-workspace-endpoint.test.ts`, `read-thread-workspace.test.ts` (new); `thread-access-coverage.test.ts` | tests |
| `apps/web/content/docs/sandbox.mdx`, `thread-access.mdx`, `dev-server/agent-protocol.mdx`, `api/workspace.mdx`, `api/cli.mdx`, `api/sdk.mdx`; `scripts/check-docs.mjs` | docs and pins (existing pages: no lastmod regeneration) |
| `.changeset/workspace-read-http.md` (new) | patch |

**PR 3** (under `examples/software-factory/`)

| File | Change |
|---|---|
| `server/b4.config.ts`, `drafter/b4.config.ts` | `workspaceRead: "http"` |
| `controller/src/lib/worker/workspace-reader.ts` | `createHttpThreadWorkspaceReader`; `WorkspaceTarget.sourceDigest` |
| `controller/src/lib/controller/source-digest.ts` (new) | `handedSourceDigest` from the journal |
| `controller/src/lib/controller/verify.ts`, `intake.ts` | pass the digest |
| `controller/src/lib/config.ts`, `controller/src/lib/controller/workers.ts`, `controller/src/lib/runtime.ts` | app roots and drafter image retired |
| `controller/test/workspace-reader.test.ts`, `config.test.ts`, `workers.test.ts`, `runtime.test.ts`, `served-builder.ts`, `builder.integration.test.ts`, `drafter-end-to-end.integration.test.ts`, `no-worker-filesystem.test.ts` (new) | tests |
| `README.md` | variables and topology |

**PR 4**

| File | Change |
|---|---|
| `packages/workspace/src/managed-workspace.ts`, `managed-workspace-node.ts`, `sandbox-types.ts`, `index.ts`, `node.ts` | `StagedWorkspaceReference`, `verifyStagedWorkspaceReference`, `stagedWorkspaceDefinition`, `WorkspaceResolverInput.staged`, `SandboxConfig.stagedWorkspaces` |
| `packages/workspace/test/staged-workspace.test.ts` (new) | verifiers |
| `packages/sqlite-storage/src/workspace/staged-source-store.ts` (new), `installation.ts`, `src/index.ts` | uploads, thread references, reclaim |
| `packages/sqlite-storage/test/workspace-staged-sources.test.ts` (new) | store semantics |
| `packages/sdk/src/thread-access.ts`, `test/thread-access.contract.ts`, `packages/cli/src/lib/dev/thread-gate.ts`, `packages/testing/src/thread-access-harness.ts` | `workspace.source.put`, `requestedWorkspace` |
| `packages/cli/src/lib/runtime/workspace-protocol.ts`, `sandbox-config-shape.ts`, `resolve-sandbox.ts`, `managed-workspace-manager.ts`, `sandbox-manager.ts` | option, stage, attach, admission, reclaim |
| `packages/cli/src/lib/dev/runtime-fetch-core.ts`, `thread-workspace-http.ts` | `PUT /workspace/sources/:digest`; `POST /threads` `workspace` |
| `packages/cli/test/staged-workspace-manager.test.ts`, `staged-workspace-endpoint.test.ts` (new); `workspace-protocol-config.test.ts`, `thread-access-coverage.test.ts` | tests |
| docs as PR 2, plus `api/sqlite-storage.mdx`; `scripts/check-docs.mjs` | docs and pins |
| `.changeset/staged-workspaces.md` (new) | patch |

**PR 5** (under `examples/software-factory/` unless noted)

| File | Change |
|---|---|
| `controller/src/lib/builder-manifest.ts` → `controller/src/lib/builder-handoff.ts`; `server/src/builder-manifest.ts` → `server/src/builder-handoff.ts` | capture plus handoff schema (v3), no file |
| `controller/src/lib/drafter-manifest.ts` → `drafter-handoff.ts`; `drafter/src/drafter-manifest.ts` → `drafter-handoff.ts` | same for the drafter |
| `controller/src/lib/worker/client.ts` | `uploadSource`, `createThread(metadata, workspace?)` |
| `controller/src/lib/controller/factory.ts`, `intake.ts`, `reconcile.ts`, `manifest-files.ts` (delete), `source-digest.ts`, `workers.ts`, `config.ts`, `runtime.ts` | stage over the protocol; manifest cleanup gone |
| `server/b4.config.ts`, `drafter/b4.config.ts`, `server/scripts/in-lane.mjs` | `stagedWorkspaces`; resolvers serve `thread.staged`; retired variables |
| controller and worker tests | follow |
| `.github/workflows/ci.yml`, `scripts/release/test/fixtures/workflow-entrypoints.json`, `scripts/release/test/fixtures/workflow-safe-executables.json` | the builder lane lines lose `FACTORY_BUILDER_MANIFEST_DIR` |
| `README.md`, `docs/superpowers/runbooks/software-factory-rung2-developer-guide.md` | no manifest directory |

---

# PR 1: the factory's workers answer only the controller

```bash
git fetch origin
git switch -c blove/factory-worker-token origin/main   # after #836 merged; else origin/blove/factory-one-builder
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@b4-example/software-factory-controller^...
```

Today every Agent Protocol endpoint of the builder and the drafter is open to anyone who reaches the port: neither app has a thread-access policy, and the controller sends no credential. PRs 3 and 5 turn a request to those ports into a read of a workspace and a choice of one, so the policy lands first. D2.

### Task 1: One bearer-token policy, in both worker apps

**Files:**
- Create: `examples/software-factory/server/src/thread-access.ts`
- Create: `examples/software-factory/drafter/src/thread-access.ts` (byte-identical copy)
- Create: `examples/software-factory/controller/test/worker-token.test.ts`

- [ ] **Step 1: Write the failing test**

The two worker apps share no source with each other or the controller (each copy of a schema is pinned equal by a controller test, the pattern `builder-manifest.test.ts` uses), so the test reads both files.

```ts
// examples/software-factory/controller/test/worker-token.test.ts
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

const builderPolicy = fileURLToPath(new URL("../../server/src/thread-access.ts", import.meta.url))
const drafterPolicy = fileURLToPath(new URL("../../drafter/src/thread-access.ts", import.meta.url))
const TOKEN = "t".repeat(40)

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function load(token: string | undefined) {
  vi.resetModules()
  if (token === undefined) vi.stubEnv("FACTORY_WORKER_TOKEN", undefined as unknown as string)
  else vi.stubEnv("FACTORY_WORKER_TOKEN", token)
  // `resetModules` above makes this a fresh evaluation, so the module reads the stubbed token.
  return import("../../server/src/thread-access.ts")
}

const request = (authorization?: string) => ({
  action: "read" as const,
  operation: "thread.get" as const,
  threadId: "t-1",
  thread: undefined,
  headers: authorization === undefined ? {} : { authorization },
  method: "GET",
  url: "/threads/t-1",
  requestedMetadata: undefined,
  // Not yet on the type (PR 4 adds it as required); harmless before, needed after.
  requestedWorkspace: undefined,
  resuming: false,
})

describe("the workers' thread-access policy", () => {
  it("is the same file in the builder and the drafter", () => {
    expect(readFileSync(drafterPolicy, "utf8")).toBe(readFileSync(builderPolicy, "utf8"))
  })

  it("admits exactly `Bearer <FACTORY_WORKER_TOKEN>` and denies everything else with 403", async () => {
    const policy = (await load(TOKEN)).default
    expect(await policy.fallback(request(`Bearer ${TOKEN}`))).toEqual({ decision: "allow" })
    for (const wrong of [undefined, TOKEN, `Bearer ${TOKEN}x`, `bearer ${TOKEN}`, `Bearer ${TOKEN}, Bearer ${TOKEN}`, ""])
      expect(await policy.fallback(request(wrong))).toEqual({ decision: "deny", status: 403 })
  })

  it("has no per-action handler: every operation goes through the one check", async () => {
    const policy = (await load(TOKEN)).default
    expect(Object.keys(policy)).toEqual(["fallback"])
  })

  it("refuses to load without a token of at least 32 characters and no whitespace", async () => {
    await expect(load(undefined)).rejects.toThrow(/FACTORY_WORKER_TOKEN is required/)
    await expect(load("short")).rejects.toThrow(/at least 32/)
    await expect(load(`${"a".repeat(20)} ${"b".repeat(20)}`)).rejects.toThrow(/no whitespace/)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/worker-token.test.ts`
Expected: FAIL, cannot find `../../server/src/thread-access.ts`.

- [ ] **Step 3: Write the policy**

```ts
// examples/software-factory/server/src/thread-access.ts  (and, identical, drafter/src/thread-access.ts)
import { timingSafeEqual } from "node:crypto"
import { defineThreadAccess, deny, permit, type ThreadAccessRequest } from "@b4run/sdk"

/**
 * This worker answers the factory's controller and nobody else. Every thread endpoint (create,
 * read, run, resume, cancel, delete, and later the workspace read and the source upload)
 * requires `authorization: Bearer <FACTORY_WORKER_TOKEN>`, the secret the operator gives the
 * controller and each worker; anything else is 403. `/healthz`, `/readyz` and the memory
 * endpoints are not thread endpoints and stay open: this app keeps no memory.
 *
 * The token is read when B4.run loads this module at boot, so a worker started without one
 * refuses to start (B4_E3003) instead of serving open endpoints. Deliberately a copy in each
 * worker app, pinned equal by `controller/test/worker-token.test.ts`: the workers share no
 * source with each other or with the controller.
 */
const MIN_LENGTH = 32

export function workerToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.FACTORY_WORKER_TOKEN
  if (token === undefined || token === "")
    throw new Error(
      "FACTORY_WORKER_TOKEN is required: the secret the controller sends as `authorization: Bearer <token>` (generate one with `openssl rand -hex 32`)",
    )
  if (token.length < MIN_LENGTH)
    throw new Error(`FACTORY_WORKER_TOKEN must be at least ${MIN_LENGTH} characters`)
  if (/\s/.test(token)) throw new Error("FACTORY_WORKER_TOKEN must contain no whitespace")
  return token
}

/**
 * Strict equality in constant time. Headers arrive lowercase with repeats joined by ", ", so a
 * second `authorization` header makes the value longer and never equal.
 */
export function isController(request: Pick<ThreadAccessRequest, "headers">, token: string): boolean {
  const presented = request.headers.authorization
  if (presented === undefined) return false
  const expected = Buffer.from(`Bearer ${token}`, "utf8")
  const actual = Buffer.from(presented, "utf8")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

const token = workerToken()

export default defineThreadAccess({
  fallback: (request) => (isController(request, token) ? permit() : deny({ status: 403 })),
})
```

Copy it byte for byte: `cp examples/software-factory/server/src/thread-access.ts examples/software-factory/drafter/src/thread-access.ts`.

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/worker-token.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: The worker apps type-check, and `check` gets the token where it evaluates the policy**

`b4 build` only probes for `src/thread-access.ts` (`packages/cli/src/lib/build/targets/web-runtime.ts:52`) and emits an import of it into `.b4/build/modules.mjs`. `b4 check` LOADS that manifest when it exists (`packages/cli/src/commands/check.ts:203-211`), which evaluates the policy module, so a `check` after a `build` needs `FACTORY_WORKER_TOKEN`. CI's lane checks each worker before it builds, in a fresh checkout, so no `modules.mjs` exists there; a developer's checkout usually has one. Turbo runs `check` in strict env mode with only the variables `turbo.json` names, so pass the token through (never hashed into the cache key) for both workers. In `turbo.json`:

```json
    "@b4-example/software-factory-server#check": {
      "dependsOn": ["^check"],
      "env": ["FACTORY_BUILDER_LANE", "FACTORY_BUILDER_MANIFEST_DIR"],
      "passThroughEnv": ["FACTORY_WORKER_TOKEN"]
    },
```

and the same `"passThroughEnv": ["FACTORY_WORKER_TOKEN"]` on `@b4-example/software-factory-drafter#check`. The README line is in Task 3 Step 5.

Run: `pnpm --filter @b4-example/software-factory-server typecheck && pnpm --filter @b4-example/software-factory-drafter typecheck && pnpm --filter @b4-example/software-factory-drafter build && FACTORY_WORKER_TOKEN=$(printf 't%.0s' {1..40}) pnpm --filter @b4-example/software-factory-drafter check`
Expected: exit 0. The same `check` without the variable fails naming `FACTORY_WORKER_TOKEN is required` (B4_E3003): that is the policy failing closed, and the README says so.

- [ ] **Step 6: Commit**

```bash
git add examples/software-factory/server/src/thread-access.ts examples/software-factory/drafter/src/thread-access.ts examples/software-factory/controller/test/worker-token.test.ts turbo.json
git commit -m "feat(software-factory): the workers answer only a caller holding FACTORY_WORKER_TOKEN

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: The controller requires the token and sends it on every request

**Files:**
- Modify: `examples/software-factory/controller/src/lib/config.ts` (`EnvSchema`, `FactoryConfig`, `loadConfig`)
- Modify: `examples/software-factory/controller/src/lib/worker/client.ts:68-153` (`createHttpWorkerClient`)
- Modify: `examples/software-factory/controller/src/lib/runtime.ts:124` (`createClient`)
- Modify: `examples/software-factory/controller/test/fake-worker.ts` (log `authorization`)
- Modify: every test that calls `createHttpWorkerClient(` (list with `git grep -n "createHttpWorkerClient(" examples/software-factory`)
- Test: `examples/software-factory/controller/test/worker-client.test.ts`, `config.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/fake-worker.ts`, add `readonly authorization: string | undefined` to `LoggedRequest` and set it where each request is logged (`authorization: req.headers.authorization`). Then add a shared constant, `test/worker-token-fixture.ts`:

```ts
/** The token every controller test sends and every served worker in a test expects. */
export const TEST_WORKER_TOKEN = "test-worker-token-0123456789abcdef0123"
```

In `test/worker-client.test.ts`, construct the client with it and add:

```ts
  it("never follows a redirect, which would carry the token elsewhere", async () => {
    const seen: Request[] = []
    const capturing = createHttpWorkerClient("http://worker", {
      token: TEST_WORKER_TOKEN,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Request(input, init))
        return Response.json({ thread_id: "t", created_at: "", updated_at: "", metadata: {}, status: "idle" })
      }) as typeof fetch,
    })
    await capturing.createThread({})
    await capturing.getThread("t")
    expect(seen.map((request) => request.redirect)).toEqual(["error", "error"])
  })

  it("sends the worker token on every call, cancel and getThread included", async () => {
    const threadId = await client.createThread({})
    await client.getThread(threadId)
    await client.cancel(threadId)
    await drain(await client.startRun(threadId, "/fix#agent", "go"))
    await client.pendingInterrupts(threadId)
    expect(fake.requests.length).toBeGreaterThanOrEqual(5)
    for (const logged of fake.requests)
      expect(logged.authorization).toBe(`Bearer ${TEST_WORKER_TOKEN}`)
  })
```

`test/config.test.ts` builds its environments from two constants, `base` (`:6-9`) and `pair` (`:34-38`), spread into the rest, plus one one-key literal in "rejects missing or malformed values" (`:21`, `{ FACTORY_STATE_DIR: "/tmp/state" }`, which must still fail on the missing URL). Add `FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN` to `base`, to `pair`, and to that literal (`{ FACTORY_STATE_DIR: "/tmp/state", FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN }`); every other environment in the file spreads one of the two constants. Import `TEST_WORKER_TOKEN` from `./worker-token-fixture.ts`, and add:

```ts
  it("requires FACTORY_WORKER_TOKEN, 32 characters or more, no whitespace", () => {
    const { FACTORY_WORKER_TOKEN: _drop, ...without } = base
    expect(() => loadConfig(without)).toThrow(/FACTORY_WORKER_TOKEN is required/)
    expect(() => loadConfig({ ...base, FACTORY_WORKER_TOKEN: "short" })).toThrow(/at least 32/)
    expect(() => loadConfig({ ...base, FACTORY_WORKER_TOKEN: `${"a".repeat(20)} ${"b".repeat(20)}` })).toThrow(/no whitespace/)
    expect(loadConfig(base).workerToken).toBe(TEST_WORKER_TOKEN)
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/worker-client.test.ts test/config.test.ts`
Expected: FAIL: `authorization` is `undefined`; `workerToken` is `undefined`.

- [ ] **Step 3: Implement**

`config.ts`: add to `EnvSchema`

```ts
  /** The secret every worker's thread-access policy requires: `authorization: Bearer <token>`. */
  FACTORY_WORKER_TOKEN: z
    .string({ message: "FACTORY_WORKER_TOKEN is required: the secret the workers expect (openssl rand -hex 32)" })
    .min(1, { message: "FACTORY_WORKER_TOKEN is required: the secret the workers expect (openssl rand -hex 32)" })
    .min(32, { message: "FACTORY_WORKER_TOKEN must be at least 32 characters" })
    .regex(/^\S+$/, { message: "FACTORY_WORKER_TOKEN must contain no whitespace" }),
```

add to `FactoryConfig`

```ts
  /** Sent to every worker as `authorization: Bearer <token>`. Never journalled or logged. */
  readonly workerToken: string
```

and `workerToken: e.FACTORY_WORKER_TOKEN,` to the object `loadConfig` returns.

`worker/client.ts`: replace the signature and the two places that call `fetchImpl` directly:

```ts
export interface HttpWorkerClientOptions {
  /** `FACTORY_WORKER_TOKEN`: sent as `authorization: Bearer <token>` on every request. */
  readonly token: string
  readonly fetch?: typeof fetch
}

export function createHttpWorkerClient(
  baseUrl: string,
  options: HttpWorkerClientOptions,
): WorkerClient {
  const base = baseUrl.replace(/\/$/, "")
  const fetchImpl = options.fetch ?? fetch
  const authorization = `Bearer ${options.token}`
  /** Every request, with no exception: the worker's policy denies anything without it. */
  const send = (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set("authorization", authorization)
    // A redirect would carry the token to wherever it points: refuse it.
    return fetchImpl(url, { ...init, headers, redirect: "error" })
  }
```

then in `jsonRequest` replace `fetchImpl(url, { ...init, headers })` with `send(url, { ...init, headers })`, in `cancel` replace `fetchImpl(threadPath(threadId, "/cancel"), { method: "POST" })` with `send(threadPath(threadId, "/cancel"), { method: "POST" })`, and in `getThread` replace `fetchImpl(threadPath(threadId), { method: "GET" })` with `send(threadPath(threadId), { method: "GET" })`. After the edit `grep -n "fetchImpl(" src/lib/worker/client.ts` prints only the line inside `send`.

`runtime.ts:124`: `createClient: (url) => createHttpWorkerClient(url, { token: config.workerToken }),`.

Test call sites: `git grep -ln "createHttpWorkerClient(" examples/software-factory/controller/test` and in each, `createHttpWorkerClient(X)` becomes `createHttpWorkerClient(X, { token: TEST_WORKER_TOKEN })` with `import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"`; a call that passed a fetch as the second argument becomes `{ token: TEST_WORKER_TOKEN, fetch: <that fetch> }`.

- [ ] **Step 4: Run the controller unit tests**

Run: `pnpm --filter @b4-example/software-factory-controller test`
Expected: PASS. A failure naming `FACTORY_WORKER_TOKEN` in a test that builds a config from an environment: add the variable to that test's environment (`serve-controller.ts` in Task 3 does this for the served lanes).

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/config.ts examples/software-factory/controller/src/lib/worker/client.ts examples/software-factory/controller/src/lib/runtime.ts examples/software-factory/controller/test
git commit -m "feat(software-factory): the controller sends FACTORY_WORKER_TOKEN to every worker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Served workers in the lanes expect the token, and refuse without it

**Files:**
- Modify: `examples/software-factory/controller/test/served-builder.ts` (env list, headers)
- Modify: `examples/software-factory/controller/test/serve-controller.ts` (`FACTORY_ENV`, sets the token)
- Modify: `examples/software-factory/controller/test/drafter-end-to-end.integration.test.ts`, `drafter-resolver.integration.test.ts` (their served drafter's env and fetches)
- Modify: `examples/software-factory/controller/test/builder.integration.test.ts` (one new case)
- Modify: `examples/software-factory/README.md`

- [ ] **Step 1: Write the failing lane test**

In `builder.integration.test.ts`, beside the existing cases (it already starts one served builder per file):

```ts
  it("answers nothing without the worker token, and 403 with a wrong one", async () => {
    const bare = await fetch(`${served.url}/threads`, { method: "POST", body: "{}" })
    expect(bare.status).toBe(403)
    const wrong = await fetch(`${served.url}/threads`, {
      method: "POST",
      body: "{}",
      headers: { authorization: `Bearer ${"x".repeat(40)}` },
    })
    expect(wrong.status).toBe(403)
    expect((await fetch(`${served.url}/healthz`)).status).toBe(200)
  })
```

- [ ] **Step 2: Run it to see it fail**

Run: `FACTORY_BUILDER_LANE=1 pnpm --filter @b4-example/software-factory-controller exec vitest run --config vitest.sandbox.config.ts test/builder.integration.test.ts -t "worker token"`
Expected: FAIL at boot: `FACTORY_WORKER_TOKEN is required` (the policy now loads and the helper does not set it), which is the fail-closed half working.

- [ ] **Step 3: Set the token in every served worker and send it**

`served-builder.ts`: add `"FACTORY_WORKER_TOKEN"` to `ENV`, set `process.env.FACTORY_WORKER_TOKEN = TEST_WORKER_TOKEN` beside the other variables before `serveRuntime`, and add `authorization: \`Bearer ${TEST_WORKER_TOKEN}\`` to the headers of every `fetch` the helper makes (`createThread`, `runTurn`, `threadStatus`, and the `DELETE`s in `close`). Do the same in the drafter lanes' served drafter and in `serve-controller.ts` (add `"FACTORY_WORKER_TOKEN"` to `FACTORY_ENV` and set it to `TEST_WORKER_TOKEN`). `drafter/test/drafter-config.test.ts` and `server/test/builder-config.test.ts` need no change: they import `b4.config.ts` (which does not import the policy) and spawn only `in-lane.mjs`, never booting the app or loading `modules.mjs`.

- [ ] **Step 4: Run the lanes**

Run: `pnpm --filter @b4-example/software-factory-controller test && FACTORY_BUILDER_LANE=1 pnpm --filter @b4-example/software-factory-controller test:sandbox`
Expected: PASS (the Docker lane needs Docker and the prepared `cli-flags` and `devkit` images; `pnpm --filter @b4-example/software-factory-controller target:prepare cli-flags` and `... devkit` first).

- [ ] **Step 5: README**

In `examples/software-factory/README.md`: add `FACTORY_WORKER_TOKEN` to the controller's variable table ("yes | The secret every worker requires, sent as `authorization: Bearer <token>`; at least 32 characters (`openssl rand -hex 32`)") and to the builder's and the drafter's variable paragraphs ("required: the same value the controller sends; a worker started without it refuses to boot"); add `FACTORY_WORKER_TOKEN=$TOKEN` to each process's command in the quickstart, after a first line `export TOKEN=$(openssl rand -hex 32)`; and add one paragraph under the trust section:

```md
**Who may talk to a worker.** Each worker's `src/thread-access.ts` admits a request only with
`authorization: Bearer <FACTORY_WORKER_TOKEN>`, so only the controller can create, run, read or
delete a worker's threads. `/healthz` and `/readyz` stay open (they disclose nothing), and so do
the memory-candidate endpoints, which are not thread endpoints; neither worker keeps memory.

**The token is a bearer credential: never send it over an untrusted network in the clear.**
Run the workers on loopback or a private network only the controller can reach, or put TLS in
front of them (`https://` in `FACTORY_WORKER_URL`). The controller never follows a redirect, so
a worker URL cannot bounce the token elsewhere.

`b4 check` loads the built manifest when one exists (after `b4 build`), which evaluates the
policy: set `FACTORY_WORKER_TOKEN` for `check` as well as for the running worker.
```

- [ ] **Step 6: Commit**

```bash
git add examples/software-factory/controller/test examples/software-factory/README.md
git commit -m "test(software-factory): served workers expect the token and refuse without it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: The PR 1 gate

- [ ] **Step 1:** `pnpm lint` → exit 0.
- [ ] **Step 2:** `pnpm --filter "@b4-example/software-factory-*" typecheck` → exit 0.
- [ ] **Step 3:** `pnpm --filter "@b4-example/software-factory-*" test` → exit 0.
- [ ] **Step 4:** `node scripts/check-changesets.mjs` → passes with no changeset (private packages only).
- [ ] **Step 5:** The Docker lane as CI runs it (`.github/workflows/ci.yml`, `sandbox-docker` job, the software-factory lines) → exit 0.
- [ ] **Step 6:** `git log --oneline origin/main..` shows only this PR's commits; push, open the PR, and name in its body that PRs 3 and 5 depend on it.

---

# PR 2: read a thread's workspace over HTTP

```bash
git fetch origin
git switch -c blove/workspace-read-http origin/main
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm --filter @b4run/cli... build
```

### Task 5: Typed inspection errors, and `root` inside `inspectWorkspace`

The controller learns why a read failed today only for a missing `draft/` (its own `WorkspaceRootMissingError`); everything else is a plain `Error`, and the batched read's grown-file refusal (#829) is indistinguishable from a broken backend. Over HTTP an untyped error is a 500. This task gives `@b4run/workspace` the vocabulary (D10) and moves the controller's re-rooting into the primitive (spec §3). Error messages are unchanged except the non-UTF-8 refusal, which gains one.

**Files:**
- Create: `packages/workspace/src/inspection-errors.ts`
- Modify: `packages/workspace/src/inspect-workspace.ts` (whole file below)
- Modify: `packages/workspace/src/local-filesystem.ts:31-33, 52` (the two "File too large" throws)
- Modify: `packages/workspace/src/index.ts`
- Test: `packages/workspace/test/inspect-workspace.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/workspace/test/inspect-workspace.test.ts` (it already has `fixture`, `text` and `tree`):

```ts
describe("inspection errors", () => {
  const codeOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    )
    return workspace.isWorkspaceInspectionError(error) ? error.code : error
  }

  it("classifies a file that grew between the walk and the batched read as changed", async () => {
    const f = fixture(tree({ kind: "file", size: 2, bytes: text("grown") }))
    f.batchedBackend.readBinaryFiles = async (requests) => {
      const first = requests[0]
      throw new workspace.WorkspaceReadLimitError(
        `readBinaryFile ${first?.path}: content exceeds maxBytes (${first?.maxBytes}).`,
        first?.path ?? "",
        first?.maxBytes ?? 0,
      )
    }
    expect(await codeOf(workspace.inspectWorkspace(f.batched))).toBe("changed")
  })

  it("classifies a per-entry read over a cap the metadata fit as changed", async () => {
    const f = fixture(tree({ kind: "file", size: 2, bytes: text("hi") }))
    f.backend.readBinaryFile = async (path, _ctx, options) => {
      throw new workspace.WorkspaceReadLimitError(`${path}: grew`, path, options?.maxBytes ?? 0)
    }
    expect(await codeOf(workspace.inspectWorkspace(f.handle))).toBe("changed")
  })

  it("classifies policy refusals as refused and keeps their messages", async () => {
    const executable = workspace.inspectWorkspace(
      fixture(tree({ kind: "file", executable: true, bytes: text("x") })).handle,
    )
    await expect(executable).rejects.toThrow("Executable workspace file: file")
    expect(
      await codeOf(
        workspace.inspectWorkspace(fixture(tree({ kind: "file", size: 9 })).handle, {
          maxFileBytes: 8,
        }),
      ),
    ).toBe("refused")
    expect(
      await codeOf(
        workspace.inspectWorkspace(fixture(tree({ kind: "file", bytes: new Uint8Array([0xff]) })).handle),
      ),
    ).toBe("refused")
  })

  it("classifies bad options as invalid_options before any backend call", async () => {
    const f = fixture(tree({ kind: "file", bytes: text("x") }))
    expect(await codeOf(workspace.inspectWorkspace(f.handle, { maxEntries: -1 }))).toBe(
      "invalid_options",
    )
    expect(
      await codeOf(
        workspace.inspectWorkspace(f.handle, {
          excludeRootDirectories: ["a"],
          expectedRootSymlinks: { a: "/x" },
        }),
      ),
    ).toBe("invalid_options")
    expect(f.calls).toEqual([])
  })

  it("leaves a backend failure untyped", async () => {
    const f = fixture(tree({ kind: "file", bytes: text("x") }))
    f.batchedBackend.readBinaryFiles = async () => {
      throw new Error("docker exec failed")
    }
    const error = await workspace.inspectWorkspace(f.batched).catch((caught: unknown) => caught)
    expect(workspace.isWorkspaceInspectionError(error)).toBe(false)
    expect((error as Error).message).toBe("docker exec failed")
  })

  it("recognizes both errors by name, as a second copy of the package would throw them", () => {
    const limit = Object.assign(new Error("x"), { name: "WorkspaceReadLimitError" })
    const inspection = Object.assign(new Error("x"), {
      name: "WorkspaceInspectionError",
      code: "changed",
    })
    expect(workspace.isWorkspaceReadLimitError(limit)).toBe(true)
    expect(workspace.isWorkspaceInspectionError(inspection)).toBe(true)
    expect(workspace.isWorkspaceInspectionError(new Error("x"))).toBe(false)
  })
})

describe("inspectWorkspace root", () => {
  const nested = () =>
    fixture({
      "/workspace": { kind: "directory", names: ["draft", "repo", "note"] },
      "/workspace/draft": { kind: "directory", names: ["task.json", "checks"] },
      "/workspace/draft/task.json": { kind: "file", bytes: text("{}") },
      "/workspace/draft/checks": { kind: "directory", names: ["a.test.ts"] },
      "/workspace/draft/checks/a.test.ts": { kind: "file", bytes: text("test") },
      "/workspace/repo": { kind: "directory", names: ["secret"] },
      "/workspace/repo/secret": { kind: "file", executable: true, bytes: text("no") },
      "/workspace/note": { kind: "file", bytes: text("n") },
    })

  for (const adapter of ["handle", "batched"] as const) {
    it(`starts at the root through ${adapter} and never touches anything outside it`, async () => {
      const f = nested()
      const result = await workspace.inspectWorkspace(f[adapter], { root: "draft" })
      expect(Object.keys(result.files).sort()).toEqual(["checks/a.test.ts", "task.json"])
      expect(f.calls.some((path) => path.startsWith("/workspace/repo"))).toBe(false)
      if (adapter === "batched") expect(f.batchCalls[0]).toBe("walk /workspace/draft prune=")
    })
  }

  it("names an absent root", async () => {
    const error = await workspace
      .inspectWorkspace(nested().handle, { root: "missing" })
      .catch((caught: unknown) => caught)
    expect(workspace.isWorkspaceInspectionError(error) && error.code).toBe("root_missing")
    expect((error as workspace.WorkspaceInspectionError).detail).toEqual({
      root: "missing",
      kind: "absent",
    })
    expect((error as Error).message).toContain('"missing"')
  })

  it("names a root that is a file", async () => {
    const error = await workspace
      .inspectWorkspace(nested().handle, { root: "note" })
      .catch((caught: unknown) => caught)
    expect((error as workspace.WorkspaceInspectionError).detail).toEqual({
      root: "note",
      kind: "not_directory",
    })
  })

  for (const root of ["..", "draft/..", "/draft", "draft/", "a//b", "", ".", "a\\b", "x\u0000y"]) {
    it(`refuses the root ${JSON.stringify(root)} before any backend call`, async () => {
      const f = nested()
      const error = await workspace
        .inspectWorkspace(f.handle, { root })
        .catch((caught: unknown) => caught)
      expect(workspace.isWorkspaceInspectionError(error) && error.code).toBe("invalid_options")
      expect(f.calls).toEqual([])
    })
  }

  it("refuses a symlink anywhere in the root, first or mid-path, and never looks through it", async () => {
    const f = fixture({
      "/workspace": { kind: "directory", names: ["draft", "a"] },
      "/workspace/draft": { kind: "symlink", target: "/etc" },
      "/workspace/draft/sub": { kind: "directory", names: ["passwd"] },
      "/workspace/a": { kind: "directory", names: ["link"] },
      "/workspace/a/link": { kind: "symlink", target: "/" },
      "/workspace/a/link/x": { kind: "directory", names: [] },
    })
    for (const [root, at] of [
      ["draft", "draft"],
      ["draft/sub", "draft"],
      ["a/link/x", "a/link"],
    ] as const) {
      const error = await workspace
        .inspectWorkspace(f.handle, { root })
        .catch((caught: unknown) => caught)
      expect((error as workspace.WorkspaceInspectionError).detail).toEqual({ root, kind: "not_directory" })
      expect((error as Error).message).toContain(`"${at}" is a symlink`)
    }
    expect(f.calls).not.toContain("/workspace/draft/sub")
    expect(f.calls).not.toContain("/workspace/a/link/x")
  })

  it("re-roots a batch-only backend with lstat alone (its per-entry listDir refuses)", async () => {
    const f = nested()
    const result = await workspace.inspectWorkspace(f.batched, { root: "draft/checks" })
    expect(Object.keys(result.files)).toEqual(["a.test.ts"])
  })

  it("refuses a root for an author filesystem, which has no absolute root to nest", async () => {
    const error = await workspace
      .inspectWorkspace(nested().author, { root: "draft" })
      .catch((caught: unknown) => caught)
    expect(workspace.isWorkspaceInspectionError(error) && error.code).toBe("invalid_options")
  })
})
```

The fixture's `calls` records `lstat` paths only; `listDir` is not recorded, which is why the "outside the root" assertion looks at `lstat` and the batch log.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4run/workspace exec vitest run test/inspect-workspace.test.ts`
Expected: FAIL: `workspace.WorkspaceReadLimitError is not a constructor`, `isWorkspaceInspectionError is not a function`.

- [ ] **Step 3: Add the error module**

```ts
// packages/workspace/src/inspection-errors.ts
/**
 * A bounded read found more bytes than it was allowed. Thrown by B4.run's own
 * backends (`localFilesystem`, the sandbox providers' bounded reads) with their
 * historic messages, so a caller can tell "this file is over the cap" from an
 * I/O failure without matching text. Recognized by NAME as well as by class
 * ({@link isWorkspaceReadLimitError}): a provider package can resolve its own
 * copy of `@b4run/workspace`, and `instanceof` across two copies is false.
 */
export class WorkspaceReadLimitError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly maxBytes: number,
  ) {
    super(message)
    this.name = "WorkspaceReadLimitError"
  }
}

export function isWorkspaceReadLimitError(error: unknown): error is WorkspaceReadLimitError {
  return error instanceof Error && error.name === "WorkspaceReadLimitError"
}

/**
 * Why `inspectWorkspace` refused, as data:
 *
 * - `invalid_options`: the caller's options (a limit, a root, a policy name) are
 *   malformed. Nothing was read.
 * - `root_missing`: `root` names nothing, or names something that is not a
 *   directory (`detail.kind`). The workspace was reached.
 * - `refused`: the workspace holds something the inspection does not admit
 *   (a limit, an executable, binary or non-UTF-8 file, an unexpected link).
 * - `changed`: the workspace changed while it was being read. Retry once the
 *   writer is quiet.
 *
 * Anything else a backend throws is left as it was thrown.
 */
export type WorkspaceInspectionErrorCode = "invalid_options" | "root_missing" | "refused" | "changed"

export interface WorkspaceInspectionErrorDetail {
  readonly root?: string
  readonly kind?: "absent" | "not_directory"
}

export class WorkspaceInspectionError extends Error {
  constructor(
    readonly code: WorkspaceInspectionErrorCode,
    message: string,
    readonly detail: WorkspaceInspectionErrorDetail = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "WorkspaceInspectionError"
  }
}

/**
 * The one rule for an inspection `root`: relative, `/`-separated leaf names, none
 * empty, `.`, `..`, containing `\\` or a control character. Shared by
 * `inspectWorkspace` and by the HTTP endpoint, which refuses a bad root before it
 * starts a reader.
 */
export function isCanonicalWorkspaceRoot(root: string): boolean {
  return (
    typeof root === "string" &&
    root.length > 0 &&
    root.length <= 1024 &&
    root
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          !segment.includes("\\") &&
          ![...segment].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
      )
  )
}

const CODES: ReadonlySet<string> = new Set(["invalid_options", "root_missing", "refused", "changed"])

export function isWorkspaceInspectionError(error: unknown): error is WorkspaceInspectionError {
  return (
    error instanceof Error &&
    error.name === "WorkspaceInspectionError" &&
    CODES.has(String((error as { readonly code?: unknown }).code))
  )
}
```

- [ ] **Step 4: Replace `packages/workspace/src/inspect-workspace.ts`**

```ts
import type { WorkspaceFs } from "@b4run/sdk"
import {
  isCanonicalWorkspaceRoot,
  isWorkspaceReadLimitError,
  WorkspaceInspectionError,
  type WorkspaceInspectionErrorCode,
} from "./inspection-errors.js"
import type { WorkspaceReadSource } from "./sandbox-types.js"
import type { BackendContext, FilesystemBackend } from "./types.js"

export interface InspectWorkspaceOptions {
  readonly signal?: AbortSignal
  /** Maximum entries, including directories and excluded root entries. Default: 10,000. */
  readonly maxEntries?: number
  /** Default: 2 MiB. */
  readonly maxFileBytes?: number
  /** Default: 16 MiB. */
  readonly maxTotalBytes?: number
  /** Root leaf names whose directory subtrees may be omitted. Files and links fail. */
  readonly excludeRootDirectories?: readonly string[]
  /** Required root symlinks and their exact, unnormalized readlink targets. */
  readonly expectedRootSymlinks?: Readonly<Record<string, string>>
  /**
   * A relative directory (`draft`, `a/b`) under the workspace root at which the
   * inspection STARTS. Nothing outside it is walked or read, every returned key
   * is relative to it, and `excludeRootDirectories` and `expectedRootSymlinks`
   * apply at it. Every segment is lstat'ed and must be a real directory: a root
   * that names nothing, or passes through or ends at a file or a symlink, is a
   * `root_missing` refusal naming the root and the segment, never a read that
   * follows a link out of the workspace. Needs a sandbox handle or workspace
   * reader (an absolute root).
   */
  readonly root?: string
}

export interface WorkspaceInspection {
  /** Complete relative-path text inventory outside explicitly omitted roots. */
  readonly files: Readonly<Record<string, string>>
  /** Validated root symlinks, recorded separately from files. */
  readonly symlinks: Readonly<Record<string, string>>
  readonly totalBytes: number
  /** Inspected entries, excluding the root itself. */
  readonly entries: number
}

type Metadata = Awaited<ReturnType<NonNullable<WorkspaceFs["stat"]>>>
interface Plan {
  readonly maxEntries: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly prune: readonly string[]
}
interface Reader {
  stat(path: string): Promise<Metadata>
  list(path: string): Promise<readonly string[]>
  read(path: string, maxBytes: number): Promise<Uint8Array>
  /** Batch-capable readers load the whole tree and its files here, once. */
  prepare?(plan: Plan): Promise<void>
}

function fail(
  code: WorkspaceInspectionErrorCode,
  message: string,
  options?: ErrorOptions,
): WorkspaceInspectionError {
  return new WorkspaceInspectionError(code, message, {}, options)
}

/**
 * A read-limit refusal for a file whose recorded size fit its request means the
 * file grew after it was measured: the workspace changed, it did not break a
 * limit. Anything else the backend threw is its own failure, left untyped.
 */
function grown(error: unknown): unknown {
  return isWorkspaceReadLimitError(error)
    ? fail("changed", `Workspace changed during inspection: ${error.message}`, { cause: error })
    : error
}

/**
 * Serve `list` and `stat` from one `walkTree` and the file reads from one
 * `readBinaryFiles`, so an inspection costs a few backend calls instead of one
 * per entry. The walk is only a cache for the policy loop in
 * {@link inspectWorkspace}, which applies exactly the checks it applies to
 * per-entry calls. Every walked name is validated here, and an entry whose
 * parent is not a walked directory is refused.
 *
 * Files are prefetched with `maxBytes` set to their walked size, so a file that
 * grew between the walk and the read is refused (`changed`) rather than read past
 * its recorded size. Prefetch is skipped when the eligible files together exceed
 * the byte budget; the loop then fails on its own limits exactly as before.
 */
function batched(
  fs: Required<Pick<FilesystemBackend, "walkTree" | "readBinaryFiles">>,
  single: Reader,
  absolute: (path: string) => string,
  ctx: BackendContext,
): Reader {
  let tree: Map<string, Metadata> | undefined
  const children = new Map<string, string[]>()
  const bytes = new Map<string, Uint8Array>()
  return {
    stat: (path) => {
      const entry = path ? tree?.get(path) : undefined
      if (entry) return Promise.resolve(entry)
      if (tree && path) throw fail("changed", `Workspace changed during inspection: ${path}`)
      return single.stat(path)
    },
    list: (path) => {
      if (!tree) return single.list(path)
      const names = children.get(path)
      if (!names) throw fail("changed", `Workspace changed during inspection: ${path}`)
      return Promise.resolve(names)
    },
    read: (path, maxBytes) => {
      const prefetched = bytes.get(path)
      return prefetched ? Promise.resolve(prefetched) : single.read(path, maxBytes)
    },
    async prepare(plan) {
      const walked = await fs.walkTree(absolute(""), ctx, {
        maxEntries: plan.maxEntries,
        prune: plan.prune,
      })
      ctx.signal.throwIfAborted()
      if (walked.length > plan.maxEntries) throw fail("refused", "Workspace entries limit exceeded")
      const found = new Map<string, Metadata>()
      children.set("", [])
      for (const entry of walked) {
        const segments = entry.path.split("/")
        for (const segment of segments) leaf(segment)
        if (found.has(entry.path))
          throw fail("refused", `Workspace duplicate entry name: ${entry.path}`)
        found.set(entry.path, {
          kind: entry.kind,
          size: entry.size,
          executable: entry.executable,
          ...(entry.target !== undefined ? { target: entry.target } : {}),
        } as Metadata)
        if (entry.kind === "directory") children.set(entry.path, [])
      }
      for (const entry of walked) {
        const cut = entry.path.lastIndexOf("/")
        const siblings = children.get(cut < 0 ? "" : entry.path.slice(0, cut))
        if (!siblings)
          throw fail("refused", `Invalid workspace entry name: ${JSON.stringify(entry.path)}`)
        siblings.push(entry.path.slice(cut + 1))
      }
      const files = walked.filter(
        (entry) =>
          entry.kind === "file" &&
          entry.executable === false &&
          Number.isSafeInteger(entry.size) &&
          entry.size >= 0 &&
          entry.size <= plan.maxFileBytes,
      )
      const planned = files.reduce((total, entry) => total + entry.size, 0)
      if (files.length && planned <= plan.maxTotalBytes) {
        let read: Awaited<ReturnType<typeof fs.readBinaryFiles>>
        try {
          read = await fs.readBinaryFiles(
            files.map((entry) => ({ path: absolute(entry.path), maxBytes: entry.size })),
            ctx,
          )
        } catch (error) {
          throw grown(error)
        }
        if (read.length !== files.length) throw new Error("Invalid batch read response")
        files.forEach((entry, index) => {
          bytes.set(entry.path, read[index] as Uint8Array)
        })
      }
      tree = found
    },
  }
}

/**
 * `base`, when set, is the absolute directory `atRoot` established under the
 * workspace root: paths are built under it, while every backend call still
 * reports the WORKSPACE root as its context, which is the jail a backend checks.
 */
function reader(
  source: WorkspaceFs | WorkspaceReadSource,
  signal: AbortSignal,
  base?: string,
): Reader {
  if ("filesystem" in source) {
    const fs = source.filesystem
    const stat = fs.lstat?.bind(fs)
    const read = fs.readBinaryFile?.bind(fs)
    if (!stat) throw fail("invalid_options", "Workspace inspection requires leaf metadata (lstat)")
    if (!read) throw fail("invalid_options", "Workspace inspection requires binary reads")
    const workspace = source.workspaceRoot.replace(/\/$/, "")
    if (
      !source.workspaceRoot.startsWith("/") ||
      /[\\\0]/.test(workspace) ||
      workspace.split("/").some((part) => part === "." || part === "..")
    ) {
      throw fail(
        "invalid_options",
        "Workspace inspection requires an absolute canonical workspace root",
      )
    }
    const root = base ?? workspace
    const ctx = { workspaceRoot: source.workspaceRoot, signal }
    const absolute = (path: string) => (path ? `${root}/${path}` : root || "/")
    const single: Reader = {
      stat: (path) => stat(absolute(path), ctx),
      list: (path) => fs.listDir(absolute(path), ctx),
      read: (path, maxBytes) => read(absolute(path), ctx, { maxBytes }),
    }
    const walkTree = fs.walkTree?.bind(fs)
    const readBinaryFiles = fs.readBinaryFiles?.bind(fs)
    return walkTree && readBinaryFiles
      ? batched({ walkTree, readBinaryFiles }, single, absolute, ctx)
      : single
  }
  const stat = source.stat?.bind(source)
  if (!stat) throw fail("invalid_options", "Workspace inspection requires leaf metadata (stat)")
  if (!source.readBinaryFile) throw fail("invalid_options", "Workspace inspection requires binary reads")
  return {
    stat: (path) => stat(path || "."),
    list: (path) => source.listDir(path || "."),
    read: (path, maxBytes) => source.readBinaryFile(path, { maxBytes }),
  }
}

function leaf(name: string, code: WorkspaceInspectionErrorCode = "refused"): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw fail(code, `Invalid workspace entry name: ${JSON.stringify(name)}`)
  }
}

function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw fail("invalid_options", `Invalid ${name} limit`)
  return value
}

/**
 * The absolute directory `root` names under the workspace root. EVERY segment is
 * lstat'ed and must be a directory: a symlink anywhere in `root` is refused, not
 * followed, because a provider's read-only reader need not jail paths (the Docker
 * reader does not) and a link at `draft` or at `draft/sub` would otherwise point
 * the whole inspection outside the workspace. A segment whose lstat fails is
 * `absent` only when its parent's listing proves the name is not there; any other
 * failure is the backend's own and is rethrown untyped. Only `lstat` is needed on
 * the path that succeeds, so a batch-only backend (whose per-entry `listDir` may
 * refuse) can still be re-rooted.
 */
async function atRoot(
  source: WorkspaceFs | WorkspaceReadSource,
  root: string,
  signal: AbortSignal,
): Promise<string> {
  if (!isCanonicalWorkspaceRoot(root))
    throw new WorkspaceInspectionError(
      "invalid_options",
      `Invalid workspace inspection root: ${JSON.stringify(root)}`,
      { root },
    )
  if (!("filesystem" in source))
    throw new WorkspaceInspectionError(
      "invalid_options",
      "Workspace inspection at a root needs a sandbox handle or workspace reader",
      { root },
    )
  const fs = source.filesystem
  const lstat = fs.lstat?.bind(fs)
  if (!lstat) throw fail("invalid_options", "Workspace inspection requires leaf metadata (lstat)")
  const ctx = { workspaceRoot: source.workspaceRoot, signal }
  let current = source.workspaceRoot.replace(/\/$/, "")
  const walked: string[] = []
  for (const segment of root.split("/")) {
    signal.throwIfAborted()
    const parent = current
    current = `${current}/${segment}`
    walked.push(segment)
    let metadata: Metadata
    try {
      metadata = await lstat(current, ctx)
    } catch (error) {
      signal.throwIfAborted()
      let names: readonly string[]
      try {
        names = await fs.listDir(parent || "/", ctx)
      } catch {
        throw error
      }
      if (names.includes(segment)) throw error
      throw new WorkspaceInspectionError(
        "root_missing",
        `Workspace root ${JSON.stringify(root)} is missing (${JSON.stringify(walked.join("/"))} does not exist)`,
        { root, kind: "absent" },
      )
    }
    signal.throwIfAborted()
    if (metadata.kind !== "directory")
      throw new WorkspaceInspectionError(
        "root_missing",
        `Workspace root ${JSON.stringify(root)} is not a directory (${JSON.stringify(walked.join("/"))} is a ${metadata.kind})`,
        { root, kind: "not_directory" },
      )
  }
  return current
}

/**
 * Inspect text without shell execution, preserving BOM bytes and rejecting unsupported
 * entries. Metadata and raw reads are mandatory. This is not an atomic snapshot:
 * callers must quiesce writers or revalidate before acting on the inventory.
 * Refusals are {@link WorkspaceInspectionError}s; a backend's own failure is
 * rethrown as it was thrown.
 */
export async function inspectWorkspace(
  source: WorkspaceFs | WorkspaceReadSource,
  options: InspectWorkspaceOptions = {},
): Promise<WorkspaceInspection> {
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const maxEntries = limit(options.maxEntries ?? 10_000, "entries")
  const maxFileBytes = limit(options.maxFileBytes ?? 2 * 1024 * 1024, "file bytes")
  const maxTotalBytes = limit(options.maxTotalBytes ?? 16 * 1024 * 1024, "total bytes")
  const excluded = new Set(options.excludeRootDirectories ?? [])
  const expected = new Map(Object.entries(options.expectedRootSymlinks ?? {}))
  for (const name of [...excluded, ...expected.keys()]) leaf(name, "invalid_options")
  for (const [name, target] of expected) {
    if (excluded.has(name)) throw fail("invalid_options", `Conflicting root policy: ${name}`)
    if (!target || target.includes("\0"))
      throw fail("invalid_options", `Invalid symlink target: ${name}`)
  }
  const base = options.root === undefined ? undefined : await atRoot(source, options.root, signal)
  const fs = reader(source, signal, base)
  const files: Record<string, string> = Object.create(null)
  const symlinks: Record<string, string> = Object.create(null)
  let entries = 0
  let totalBytes = 0
  async function checked<T>(operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const result = await operation()
    signal.throwIfAborted()
    return result
  }
  if ((await checked(() => fs.stat(""))).kind !== "directory") {
    throw fail("refused", "Workspace root must be a directory")
  }
  const prepare = fs.prepare?.bind(fs)
  if (prepare)
    await checked(() => prepare({ maxEntries, maxFileBytes, maxTotalBytes, prune: [...excluded] }))
  const pending = [""]
  while (pending.length) {
    const directory = pending.pop() as string
    const names = await checked(() => fs.list(directory))
    if (entries + names.length > maxEntries) throw fail("refused", "Workspace entries limit exceeded")
    const seen = new Set<string>()
    for (const name of names) {
      leaf(name)
      if (seen.has(name)) throw fail("refused", `Workspace duplicate entry name: ${name}`)
      seen.add(name)
    }
    entries += names.length
    for (const name of [...names].sort()) {
      const path = directory ? `${directory}/${name}` : name
      const metadata = await checked(() => fs.stat(path))
      if (!directory && excluded.has(name)) {
        if (metadata.kind !== "directory")
          throw fail("refused", `Excluded root must be a directory: ${name}`)
        continue
      }
      if (!directory && expected.has(name)) {
        if (
          metadata.kind !== "symlink" ||
          metadata.target === undefined ||
          metadata.target !== expected.get(name)
        ) {
          throw fail("refused", `Unexpected root symlink: ${name}`)
        }
        symlinks[name] = metadata.target
        continue
      }
      if (metadata.kind === "directory") {
        pending.push(path)
        continue
      }
      if (metadata.kind !== "file")
        throw fail("refused", `Unsupported workspace entry (${metadata.kind}): ${path}`)
      if (metadata.executable !== false) throw fail("refused", `Executable workspace file: ${path}`)
      const cap = Math.min(maxFileBytes, maxTotalBytes - totalBytes)
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > cap) {
        throw fail("refused", `Workspace file bytes limit exceeded: ${path}`)
      }
      let bytes: Uint8Array
      try {
        bytes = await checked(() => fs.read(path, cap))
      } catch (error) {
        throw grown(error)
      }
      if (bytes.byteLength > cap) throw fail("refused", `Workspace file bytes limit exceeded: ${path}`)
      if (bytes.includes(0)) throw fail("refused", `Binary workspace file: ${path}`)
      try {
        files[path] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch (error) {
        throw fail("refused", `Workspace file is not UTF-8 text: ${path}`, { cause: error })
      }
      totalBytes += bytes.byteLength
    }
  }
  for (const name of expected.keys()) {
    if (!Object.hasOwn(symlinks, name))
      throw fail("refused", `Missing expected root symlink: ${name}`)
  }
  return { files, symlinks, totalBytes, entries }
}
```

- [ ] **Step 5: Throw the typed limit error from `localFilesystem`**

In `packages/workspace/src/local-filesystem.ts`, import `{ WorkspaceReadLimitError } from "./inspection-errors.js"` and change the two throws, keeping their messages:

```ts
      throw new WorkspaceReadLimitError(`File too large: ${s.size} bytes (max ${limit}) at ${path}`, path, limit)
```

```ts
        if (length > limit)
          throw new WorkspaceReadLimitError(`File too large: exceeds ${limit} bytes at ${path}`, path, limit)
```

- [ ] **Step 6: Export**

In `packages/workspace/src/index.ts`, after the `inspectWorkspace` export:

```ts
export {
  isCanonicalWorkspaceRoot,
  isWorkspaceInspectionError,
  isWorkspaceReadLimitError,
  WorkspaceInspectionError,
  type WorkspaceInspectionErrorCode,
  type WorkspaceInspectionErrorDetail,
  WorkspaceReadLimitError,
} from "./inspection-errors.js"
```

- [ ] **Step 7: Run the package's tests**

Run: `pnpm --filter @b4run/workspace test`
Expected: PASS, the new cases and every existing one (the existing grown-file case still sees its fixture's untyped message, which is rethrown unchanged).

- [ ] **Step 8: Commit**

```bash
git add packages/workspace/src/inspection-errors.ts packages/workspace/src/inspect-workspace.ts packages/workspace/src/local-filesystem.ts packages/workspace/src/index.ts packages/workspace/test/inspect-workspace.test.ts
git commit -m "feat(workspace): typed inspection errors, and inspectWorkspace starts at a root

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: The sandbox providers' bounded reads throw the typed limit error

**Files:**
- Modify: `packages/sandbox/src/bounded-read.ts:26-27`
- Modify: `packages/sandbox/src/testing/fake-sandbox.ts:85, 100`
- Create: `packages/sandbox/test/bounded-read.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/sandbox/test/bounded-read.test.ts
import { isWorkspaceReadLimitError } from "@b4run/workspace"
import { describe, expect, it } from "vitest"
import { decodeBoundedRead } from "../src/bounded-read.ts"

describe("decodeBoundedRead", () => {
  it("throws a typed read-limit error with the historic message", () => {
    const framed = Buffer.concat([Buffer.from("abcdef"), Buffer.from("\nB4_READ_STATUS_0\n")])
    let caught: unknown
    try {
      decodeBoundedRead(framed, "/workspace/f", 3, "readBinaryFile", "")
    } catch (error) {
      caught = error
    }
    expect(isWorkspaceReadLimitError(caught)).toBe(true)
    expect((caught as Error).message).toBe(
      "readBinaryFile /workspace/f: content exceeds maxBytes (3).",
    )
  })

  it("keeps a failed read status an ordinary error", () => {
    const framed = Buffer.from("\nB4_READ_STATUS_1\n")
    expect(() => decodeBoundedRead(framed, "/w/f", 3, "readFile", "No such file")).toThrow(
      "readFile failed: No such file",
    )
    try {
      decodeBoundedRead(framed, "/w/f", 3, "readFile", "No such file")
    } catch (error) {
      expect(isWorkspaceReadLimitError(error)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @b4run/workspace build && pnpm --filter @b4run/sandbox exec vitest run test/bounded-read.test.ts`
Expected: FAIL on `isWorkspaceReadLimitError(caught)` → `false`.

- [ ] **Step 3: Implement**

`packages/sandbox/src/bounded-read.ts`: add `import { WorkspaceReadLimitError } from "@b4run/workspace"` and change the overflow throw to

```ts
  if (bytes.length > max)
    throw new WorkspaceReadLimitError(`${operation} ${path}: content exceeds maxBytes (${max}).`, path, max)
```

`packages/sandbox/src/testing/fake-sandbox.ts`: import the same class and change both throws to `new WorkspaceReadLimitError(<the same message>, path, max)`.

- [ ] **Step 4: Run the package's tests**

Run: `pnpm --filter @b4run/sandbox test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/bounded-read.ts packages/sandbox/src/testing/fake-sandbox.ts packages/sandbox/test/bounded-read.test.ts
git commit -m "feat(sandbox): bounded reads throw WorkspaceReadLimitError

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: `thread.workspace` joins the thread operations

**Files:**
- Modify: `packages/sdk/src/thread-access.ts:16-71` (doc list and union)
- Modify: `packages/sdk/test/thread-access.contract.ts:27-41`

- [ ] **Step 1: Write the failing contract**

In `thread-access.contract.ts`, add `| "thread.workspace"` to the `_Operation` union, after `| "run.agui"`.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @b4run/sdk typecheck`
Expected: FAIL: `Type 'false' does not satisfy the constraint 'true'` at `_Operation`.

- [ ] **Step 3: Implement**

In the doc comment's list in `packages/sdk/src/thread-access.ts`, after the `run.agui` bullet:

```ts
 * - `thread.workspace` — `POST /threads/:id/workspace/inspect` — `read`; served
 *   only when the app sets `sandbox.workspaceRead: "http"`
```

and in the union, after `| "run.agui"`:

```ts
  /**
   * `POST /threads/:id/workspace/inspect`: a read of every file under the
   * requested root of the thread's workspace. Discloses at least as much as
   * `thread.state`, so it arrives as a `read` and a denial defaults to the same
   * 404 a missing thread returns. Served only when the app sets
   * `sandbox.workspaceRead: "http"`, which B4.run refuses without a policy.
   */
  | "thread.workspace"
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @b4run/sdk typecheck && pnpm --filter @b4run/sdk test && pnpm --filter @b4run/testing typecheck`
Expected: exit 0. (The testing harness defaults an operation per action and needs no change.)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/thread-access.ts packages/sdk/test/thread-access.contract.ts
git commit -m "feat(sdk): thread.workspace thread operation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: A bounded request-body reader

Every body the runtime reads today is `await request.text()` with no bound (verification table). This task adds the one reader PR 2 and PR 4 use (D3). It is pure (no `node:` import): `runtime-fetch-core.ts` imports it.

**Files:**
- Create: `packages/cli/src/lib/dev/bounded-body.ts`
- Modify: `packages/cli/src/lib/dev/node-web-adapter.ts:52-56` (`drainableBody`)
- Create: `packages/cli/test/bounded-body.test.ts`, `packages/cli/test/bounded-body-node.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/bounded-body.test.ts
import { describe, expect, it } from "vitest"
import {
  payloadTooLarge,
  RequestBodyTooLargeError,
  readBoundedText,
} from "../src/lib/dev/bounded-body.ts"

function streamed(
  chunks: readonly Uint8Array[],
  onPull?: () => void,
  headers: Record<string, string> = {},
) {
  let index = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.()
      const chunk = chunks[index++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
    cancel() {
      cancelled = true
    },
    // No eager pull: a pull only happens when the reader asks, so "nothing was read" is observable.
  }, { highWaterMark: 0 })
  const request = new Request("http://localhost/x", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" })
  return { request, cancelled: () => cancelled }
}

describe("readBoundedText", () => {
  it("returns a body at or under the limit", async () => {
    const request = new Request("http://localhost/x", { method: "POST", body: "abc" })
    expect(await readBoundedText(request, 3)).toBe("abc")
  })

  it("returns an empty string for a request with no body", async () => {
    expect(await readBoundedText(new Request("http://localhost/x", { method: "POST" }), 3)).toBe("")
  })

  it("refuses a declared content-length over the limit without reading", async () => {
    let pulls = 0
    const { request } = streamed(
      [new Uint8Array(10)],
      () => {
        pulls += 1
      },
      { "content-length": "10" },
    )
    await expect(readBoundedText(request, 5)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
    expect(pulls).toBe(0)
  })

  it("counts streamed bytes and cancels the stream once past the limit", async () => {
    const { request, cancelled } = streamed([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)])
    const error = await readBoundedText(request, 6).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RequestBodyTooLargeError)
    expect((error as RequestBodyTooLargeError).maxBytes).toBe(6)
    expect(cancelled()).toBe(true)
  })

  it("decodes UTF-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode("héllo")
    const { request } = streamed([bytes.slice(0, 2), bytes.slice(2)])
    expect(await readBoundedText(request, 64)).toBe("héllo")
  })

  it("answers 413 with the limit named", async () => {
    const response = payloadTooLarge(new RequestBodyTooLargeError(1024))
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { details: { code: "payload_too_large", maxBytes: 1024 } },
    })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @b4run/cli exec vitest run test/bounded-body.test.ts`
Expected: FAIL: cannot find `../src/lib/dev/bounded-body.ts`.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/lib/dev/bounded-body.ts
import { createRequestErrorBody } from "./server-errors.js"

/**
 * A request body over its endpoint's limit. The body was not buffered: a declared
 * `content-length` over the limit is refused before a byte is read, and a
 * streamed body is cancelled the moment it passes the limit.
 */
export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`)
    this.name = "RequestBodyTooLargeError"
  }
}

/**
 * `request.text()` with a ceiling. Decoding matches `text()` (UTF-8, invalid
 * sequences replaced), so an endpoint that switches to this reads the same
 * string it read before for every body under the limit. Pure: every runtime the
 * fetch core serves (Node, Hono, Vercel) enforces the limit the same way.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid request body limit")
  const declared = request.headers.get("content-length")?.trim()
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes)
    throw new RequestBodyTooLargeError(maxBytes)
  const body = request.body
  if (!body) return ""
  const reader = body.getReader()
  // Decoded as it arrives: no second full-size byte buffer is ever assembled.
  const decoder = new TextDecoder()
  const parts: string[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        // On Node this discards the rest of the upload without closing the socket
        // (`toWebRequest`), so the 413 reaches the client.
        await reader.cancel().catch(() => {})
        throw new RequestBodyTooLargeError(maxBytes)
      }
      parts.push(decoder.decode(value, { stream: true }))
    }
  } finally {
    reader.releaseLock()
  }
  parts.push(decoder.decode())
  return parts.join("")
}

/** The one 413 every bounded endpoint answers. */
export function payloadTooLarge(error: RequestBodyTooLargeError): Response {
  return Response.json(
    createRequestErrorBody(error.message, { code: "payload_too_large", maxBytes: error.maxBytes }),
    { status: 413 },
  )
}
```

- [ ] **Step 4: Run it to see it pass, and keep the core pure**

Run: `pnpm --filter @b4run/cli exec vitest run test/bounded-body.test.ts test/fetch-entry-purity.test.ts`
Expected: PASS.

- [ ] **Step 5: A refusal must reach a real client, not a reset**

Today `toWebRequest` hands the `IncomingMessage` itself to `new Request` as the body (`node-web-adapter.ts:52-56`), so cancelling the body stream destroys the socket and a client still uploading sees a reset instead of the 413. Write the failing test over a real socket:

```ts
// packages/cli/test/bounded-body-node.test.ts
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, it } from "vitest"
import { payloadTooLarge, RequestBodyTooLargeError, readBoundedText } from "../src/lib/dev/bounded-body.ts"
import { toWebRequest, writeNodeResponse } from "../src/lib/dev/node-web-adapter.ts"

it("delivers a 413 whole to a client still uploading, and keeps reading the next request", async () => {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const text = await readBoundedText(toWebRequest(req, res), 1024)
        await writeNodeResponse(res, Response.json({ length: text.length }))
      } catch (error) {
        if (!(error instanceof RequestBodyTooLargeError)) throw error
        await writeNodeResponse(res, payloadTooLarge(error))
      }
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  try {
    const refused = await fetch(url, { method: "POST", body: "x".repeat(4 * 1024 * 1024) })
    expect(refused.status).toBe(413)
    expect(await refused.json()).toMatchObject({ error: { details: { code: "payload_too_large" } } })
    const accepted = await fetch(url, { method: "POST", body: "ok" })
    expect(await accepted.json()).toEqual({ length: 2 })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
```

Run: `pnpm --filter @b4run/cli exec vitest run test/bounded-body-node.test.ts`
Expected: FAIL (`fetch failed`, `other side closed` or `ECONNRESET`).

Then give `toWebRequest` its own body stream whose `cancel` discards instead of destroying. In `packages/cli/src/lib/dev/node-web-adapter.ts`:

```ts
/**
 * The request body as a web stream the adapter owns. Backpressure pauses the socket;
 * `cancel` (a handler refusing a body it read only part of) DISCARDS the rest of the
 * upload with `req.resume()` instead of destroying the socket, so a response written
 * before the body was read, such as a 413, reaches the client whole.
 */
function drainableBody(req: IncomingMessage): ReadableStream<Uint8Array> {
  let cancelled = false
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        req.on("data", (chunk: Buffer) => {
          if (cancelled) return
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
          if ((controller.desiredSize ?? 0) <= 0) req.pause()
        })
        req.on("end", () => {
          if (!cancelled) controller.close()
        })
        req.on("error", (error) => {
          if (!cancelled) controller.error(error)
        })
        req.pause()
      },
      pull() {
        req.resume()
      },
      cancel() {
        cancelled = true
        req.resume()
      },
    },
    { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
  )
}
```

and in `toWebRequest` replace `body: req as unknown as ReadableStream<Uint8Array>` with `body: drainableBody(req)`.

Run: `pnpm --filter @b4run/cli exec vitest run test/bounded-body-node.test.ts test/node-web-adapter.test.ts test/runtime-server-host.test.ts test/agui-endpoint.test.ts test/runs-wait-output.test.ts`
Expected: PASS: the refusal arrives whole, and every body the adapter already served (runs, resumes, AG-UI) reads as before.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/dev/bounded-body.ts packages/cli/src/lib/dev/node-web-adapter.ts packages/cli/test/bounded-body.test.ts packages/cli/test/bounded-body-node.test.ts
git commit -m "feat(cli): a bounded request-body reader for the runtime core

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: `sandbox.workspaceRead`: shape, capability, and a policy required at check, build and boot

`B4Config` has no runtime schema, so the option is validated where the sandbox block is (per-thread sandbox plan D8). It opens a disclosure surface, so it is refused wherever B4.run can see there is no thread-access policy: `b4 check` and `b4 build` probe for the policy file (`findThreadAccessFile`, `packages/cli/src/lib/dev/thread-access-node.ts:85`), and boot checks the resolved policy (which also covers an injected one). D12.

**Files:**
- Create: `packages/cli/src/lib/runtime/workspace-protocol.ts`
- Modify: `packages/workspace/src/sandbox-types.ts` (`SandboxConfig`)
- Modify: `packages/cli/src/lib/runtime/sandbox-config-shape.ts`
- Modify: `packages/cli/src/lib/runtime/collect-sandbox-errors.ts`
- Modify: `packages/cli/src/commands/build.ts:100-104`, `packages/cli/src/commands/check.ts:145-148`
- Modify: `packages/cli/src/lib/runtime/resolve-sandbox.ts`, `packages/cli/src/lib/runtime/sandbox-manager.ts`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:526` (boot refusal)
- Create: `packages/cli/test/workspace-protocol-config.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/workspace-protocol-config.test.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { seedB4Config } from "@b4run/core"
import { afterEach, describe, expect, it } from "vitest"
import { runBuildCommand } from "../src/commands/build.ts"
import {
  createRuntimeFetchHandler,
  type RuntimeFetchHandler,
} from "../src/lib/dev/runtime-fetch-handler.ts"
import { collectSandboxErrors } from "../src/lib/runtime/collect-sandbox-errors.ts"
import { sandboxConfigShapeErrors } from "../src/lib/runtime/sandbox-config-shape.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

const roots: string[] = []
const handlers: RuntimeFetchHandler[] = []
afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const resolver = async () => ({ source: { directory: "source", include: ["main.txt"] } })
const allowAll = { fallback: () => ({ decision: "allow" as const }) }

async function app(options: { readonly policyFile?: boolean } = {}) {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-workspace-protocol-"))
  roots.push(appRoot)
  const files: Record<string, string> = {
    "package.json": '{"type":"module"}',
    "b4.config.ts": "export default {}",
    "workspace/.keep": "",
    "source/main.txt": "initial",
    "src/app/hello/index.ts": "export const workflow = async () => ({ ok: true })",
    ...(options.policyFile
      ? { "src/thread-access.ts": "export default { fallback: () => ({ decision: 'allow' }) }" }
      : {}),
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(appRoot, path, ".."), { recursive: true })
    await writeFile(join(appRoot, path), text)
  }
  return appRoot
}

describe("sandbox.workspaceRead shape", () => {
  const provider = managedProviderFixture().provider
  it("accepts exactly \"http\" beside managed workspaces", () => {
    expect(sandboxConfigShapeErrors({ provider, workspace: resolver, workspaceRead: "http" })).toEqual([])
    expect(sandboxConfigShapeErrors({ provider, thread: resolver, workspaceRead: "http" })).toEqual([])
  })
  for (const value of ["HTTP", true, "https", 1, null])
    it(`refuses workspaceRead: ${JSON.stringify(value)}`, () => {
      expect(
        sandboxConfigShapeErrors({ provider, workspace: resolver, workspaceRead: value }).join("\n"),
      ).toMatch(/sandbox.workspaceRead must be "http"/)
    })
  it("refuses it without managed workspaces", () => {
    expect(sandboxConfigShapeErrors({ provider, workspaceRead: "http" }).join("\n")).toMatch(
      /workspaceRead needs managed workspaces/,
    )
  })
  it("refuses a misspelling as an unknown key", () => {
    expect(
      sandboxConfigShapeErrors({ provider, workspace: resolver, workspaceRaed: "http" }).join("\n"),
    ).toMatch(/sandbox.workspaceRaed is not a sandbox option/)
  })
})

describe("sandbox.workspaceRead needs a thread-access policy", () => {
  it("b4 check refuses it without src/thread-access.ts, and accepts it with one", async () => {
    const provider = managedProviderFixture().provider
    const sandbox = { provider, workspace: resolver, workspaceRead: "http" as const }
    const without = await collectSandboxErrors({ sandbox }, await app())
    expect(without.errors.join("\n")).toMatch(/sandbox.workspaceRead .* no thread-access policy/)
    const withPolicy = await collectSandboxErrors({ sandbox }, await app({ policyFile: true }))
    expect(withPolicy.errors).toEqual([])
  })

  it("b4 build refuses it without src/thread-access.ts", async () => {
    const appRoot = await app()
    seedB4Config(appRoot, {
      build: { targets: ["node"] },
      sandbox: { provider: managedProviderFixture().provider, workspace: resolver, workspaceRead: "http" },
    } as never)
    await expect(
      runBuildCommand({ cwd: appRoot, clean: true }, { stdout: () => {}, stderr: () => {} }),
    ).rejects.toThrow(/no thread-access policy/)
  })

  it("boot refuses it without a policy, releases the installation, and boots with one", async () => {
    const appRoot = await app()
    const config = {
      sandbox: { provider: managedProviderFixture().provider, workspace: resolver, workspaceRead: "http" as const },
    }
    await expect(createRuntimeFetchHandler({ appRoot, config })).rejects.toThrow(
      /sandbox.workspaceRead .* no thread-access policy/,
    )
    // The refused boot released the installation's owner lock: a second owner can open it.
    const handler = await createRuntimeFetchHandler({ appRoot, config, threadAccess: allowAll })
    handlers.push(handler)
  })

  it("boot refuses a provider whose managed workspaces cannot be read", async () => {
    const appRoot = await app()
    const config = {
      sandbox: {
        provider: managedProviderFixture({ reads: false }).provider,
        workspace: resolver,
        workspaceRead: "http" as const,
      },
    }
    await expect(
      createRuntimeFetchHandler({ appRoot, config, threadAccess: allowAll }),
    ).rejects.toThrow(/workspaceRead needs a provider whose managed workspaces can be read/)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4run/workspace build && pnpm --filter @b4run/cli exec vitest run test/workspace-protocol-config.test.ts`
Expected: FAIL: `workspaceRead` is reported as an unknown key; boot succeeds without a policy.

- [ ] **Step 3: The config type**

In `packages/workspace/src/sandbox-types.ts`, inside `SandboxConfig` after `thread`:

```ts
  /**
   * `"http"` serves `POST /threads/:thread_id/workspace/inspect`: a bounded,
   * read-only inventory of a thread's managed workspace over the Agent Protocol,
   * authorized by the app's thread-access policy as the `thread.workspace`
   * operation. Off unless set. Needs `workspace` or `thread`, a provider whose
   * managed workspaces implement `openWorkspaceReader`, and a thread-access
   * policy: `b4 check`, `b4 build` and boot refuse it without one.
   */
  readonly workspaceRead?: "http"
```

Rebuild: `pnpm --filter @b4run/workspace build`.

- [ ] **Step 4: The shared names and messages**

```ts
// packages/cli/src/lib/runtime/workspace-protocol.ts
import type { WorkspaceInspection } from "@b4run/workspace"

/**
 * What an app's `sandbox` block opens to HTTP callers. Pure: the runtime core
 * imports it, and `resolve-sandbox.ts` produces it.
 */
export interface WorkspaceProtocolSettings {
  /** `sandbox.workspaceRead: "http"`. */
  readonly read: boolean
}

export const NO_WORKSPACE_PROTOCOL: WorkspaceProtocolSettings = Object.freeze({ read: false })

/** The options a `sandbox` block sets that open a thread's workspace, as the config spells them. */
export function workspaceProtocolOptionNames(sandbox: unknown): string[] {
  if (sandbox === null || typeof sandbox !== "object") return []
  const block = sandbox as Record<string, unknown>
  return block.workspaceRead !== undefined ? ["sandbox.workspaceRead"] : []
}

/** The same names, from resolved settings. */
export function openedWorkspaceProtocol(settings: WorkspaceProtocolSettings): string[] {
  return settings.read ? ["sandbox.workspaceRead"] : []
}

export function workspaceProtocolPolicyMessage(names: readonly string[]): string {
  const subject = names.join(" and ")
  return (
    `${subject} ${names.length === 1 ? "serves" : "serve"} a thread's workspace over HTTP, and this app has ` +
    "no thread-access policy, so anyone who can reach the port could use it. Add src/thread-access.ts " +
    "(see the thread access docs) or remove the option."
  )
}

/** A validated `POST /threads/:thread_id/workspace/inspect` body. */
export interface ThreadWorkspaceInspectRequest {
  readonly root?: string
  readonly excludeRootDirectories: readonly string[]
  readonly expectedRootSymlinks: Readonly<Record<string, string>>
  readonly ignorePrefixes: readonly string[]
  readonly maxEntries: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

export type ThreadWorkspaceInspectFailure =
  | "workspace_not_found"
  | "workspace_lost"
  | "workspace_expired"
  | "workspace_not_ready"
  | "workspace_conflict"
  | "workspace_unavailable"
  | "workspace_root_missing"
  | "workspace_changed"
  | "workspace_inspection_refused"
  | "invalid_request"

export type ThreadWorkspaceInspectOutcome =
  | {
      readonly ok: true
      readonly sourceDigest: string
      readonly intentDigest: string
      readonly inspection: WorkspaceInspection
    }
  | {
      readonly ok: false
      readonly code: ThreadWorkspaceInspectFailure
      readonly message: string
      readonly root?: string
      readonly kind?: "absent" | "not_directory"
    }
```

- [ ] **Step 5: Shape rules**

In `packages/cli/src/lib/runtime/sandbox-config-shape.ts`, add `"workspaceRead"` to `SANDBOX_KEYS` (after `"thread"`), and before `return errors`:

```ts
  if (block.workspaceRead !== undefined) {
    if (block.workspaceRead !== "http")
      errors.push(
        `b4.config sandbox.workspaceRead must be "http" (got: ${JSON.stringify(block.workspaceRead) ?? typeof block.workspaceRead}).`,
      )
    else if (block.workspace === undefined && block.thread === undefined)
      errors.push(
        "b4.config sandbox.workspaceRead needs managed workspaces: set sandbox.workspace or sandbox.thread.",
      )
  }
```

- [ ] **Step 6: `b4 check` and `b4 build` require the policy file**

`collect-sandbox-errors.ts`: import `{ findThreadAccessFile } from "../dev/thread-access-node.js"` and `{ workspaceProtocolOptionNames, workspaceProtocolPolicyMessage } from "./workspace-protocol.js"`; right after the shape check returns:

```ts
  const opened = workspaceProtocolOptionNames(sandbox)
  if (appRoot !== undefined && opened.length > 0 && findThreadAccessFile(appRoot) === undefined)
    errors.push(workspaceProtocolPolicyMessage(opened))
```

(`errors` is declared on the next line today; move its `const errors: string[] = []` above this block.)

`commands/build.ts`, inside the `if (sandbox !== undefined)` block after the shape throw:

```ts
    const opened = workspaceProtocolOptionNames(sandbox)
    if (opened.length > 0 && findThreadAccessFile(manifest.appRoot) === undefined)
      throw new CliError(workspaceProtocolPolicyMessage(opened))
```

with the same two imports (paths `../lib/dev/thread-access-node.js` and `../lib/runtime/workspace-protocol.js`).

`commands/check.ts`, after the two `sandbox:` lines at `:145-148`:

```ts
    if (loadedConfig.sandbox?.workspaceRead === "http")
      writeLine(io.stdout, "sandbox: thread workspaces are readable over HTTP (thread.workspace)")
```

- [ ] **Step 7: The manager carries the settings; boot checks the capability**

`sandbox-manager.ts`: add `import { NO_WORKSPACE_PROTOCOL, type WorkspaceProtocolSettings } from "./workspace-protocol.js"`, a field `readonly #protocol: WorkspaceProtocolSettings`, a constructor option `workspaceProtocol?: WorkspaceProtocolSettings` stored as `this.#protocol = opts.workspaceProtocol ?? NO_WORKSPACE_PROTOCOL`, and

```ts
  /** Which workspace endpoints this app serves. Always off without managed workspaces. */
  get workspaceProtocol(): WorkspaceProtocolSettings {
    return this.#managed ? this.#protocol : NO_WORKSPACE_PROTOCOL
  }
```

`resolve-sandbox.ts`: after the shape check,

```ts
  const workspaceProtocol: WorkspaceProtocolSettings = { read: sandbox.workspaceRead === "http" }
  if (
    workspaceProtocol.read &&
    typeof sandbox.provider.workspaces?.openWorkspaceReader !== "function"
  )
    throw new Error(
      `sandbox.workspaceRead needs a provider whose managed workspaces can be read (openWorkspaceReader); "${sandbox.provider.name}" cannot`,
    )
```

and pass `workspaceProtocol` to the final `new SandboxManager({ ... })`.

- [ ] **Step 8: Boot refuses the option without a policy**

In `runtime-fetch-core.ts`, inside the `try` that follows the sandbox manager's resolution, directly after the `requestStores` refusal (`:526-529`) and BEFORE `reconcileDeletions` (`:530`), so a refused boot performs no deletion work and releases the installation through the existing `catch`:

```ts
    // A workspace endpoint with no policy would be open to anyone who reaches the port.
    // Checked against the RESOLVED policy, so an injected one counts and a missing file does not.
    const opened = openedWorkspaceProtocol(sandboxManager?.workspaceProtocol ?? NO_WORKSPACE_PROTOCOL)
    if (opened.length > 0 && threadAccess === undefined)
      throw new Error(workspaceProtocolPolicyMessage(opened))
```

with `import { NO_WORKSPACE_PROTOCOL, openedWorkspaceProtocol, workspaceProtocolPolicyMessage } from "../runtime/workspace-protocol.js"`.

- [ ] **Step 9: Run the tests**

Run: `pnpm --filter @b4run/cli exec vitest run test/workspace-protocol-config.test.ts test/collect-sandbox-errors.test.ts test/fetch-entry-purity.test.ts test/sandbox-manager.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/workspace/src/sandbox-types.ts packages/cli/src/lib/runtime/workspace-protocol.ts packages/cli/src/lib/runtime/sandbox-config-shape.ts packages/cli/src/lib/runtime/collect-sandbox-errors.ts packages/cli/src/commands/build.ts packages/cli/src/commands/check.ts packages/cli/src/lib/runtime/resolve-sandbox.ts packages/cli/src/lib/runtime/sandbox-manager.ts packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/workspace-protocol-config.test.ts
git commit -m "feat(cli): sandbox.workspaceRead, refused without a thread-access policy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: The manager inspects a thread's workspace from its own record

In the worker the manager already owns the installation, so the read goes through it: no second read-only connection, no app root. It reads the thread's association, refuses anything not published, runs the reader under the APP's `security.runAsNonRoot` (the identity the workspace was written under; a client does not choose it), holds `retain(threadId)` so `destroyThread` refuses while it reads, and classifies every refusal (D10).

**Files:**
- Modify: `packages/cli/src/lib/runtime/managed-workspace-manager.ts` (`inspectThread`, `inspectFailure`)
- Modify: `packages/cli/src/lib/runtime/sandbox-manager.ts` (`inspectThread`)
- Create: `packages/cli/test/managed-workspace-inspect.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/managed-workspace-inspect.test.ts
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorkspaceInstallation } from "@b4run/sqlite-storage"
import {
  WorkspaceInspectionError,
  WorkspaceLifecycleError,
  WorkspaceReadLimitError,
} from "@b4run/workspace"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import {
  inspectFailure,
  ManagedWorkspaceManager,
} from "../src/lib/runtime/managed-workspace-manager.ts"
import type { ThreadWorkspaceInspectRequest } from "../src/lib/runtime/workspace-protocol.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

const roots: string[] = []
const managers: ManagedWorkspaceManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.releaseAll()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const text = (value: string) => new TextEncoder().encode(value)
const request: ThreadWorkspaceInspectRequest = {
  excludeRootDirectories: [],
  expectedRootSymlinks: {},
  ignorePrefixes: [],
  maxEntries: 10_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
}

async function managerWith(options: { readonly runAsNonRoot?: boolean } = {}) {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-inspect-"))
  roots.push(appRoot)
  const physical = managedProviderFixture()
  const source = createSourceBundle([
    { path: "main.txt", bytes: text("initial"), executable: false },
    { path: "draft/task.json", bytes: text("{}"), executable: false },
  ])
  const manager = new ManagedWorkspaceManager({
    installation: openWorkspaceInstallation(appRoot),
    definition: { version: 1, source, environmentLinks: [] },
    provider: physical.workspaces,
    policy: {
      network: { mode: "deny" },
      ...(options.runAsNonRoot === undefined ? {} : { security: { runAsNonRoot: options.runAsNonRoot } }),
    },
    idleTimeoutMs: 60_000,
  })
  managers.push(manager)
  return { manager, physical, source }
}

describe("ManagedWorkspaceManager.inspectThread", () => {
  it("answers the published workspace with its recorded digests", async () => {
    const { manager, physical, source } = await managerWith()
    await manager.getForThread("t-1", new AbortController().signal)
    const outcome = await manager.inspectThread("t-1", request, new AbortController().signal)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.sourceDigest).toBe(source.digest)
    expect(outcome.intentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(outcome.inspection.files).toEqual({ "draft/task.json": "{}", "main.txt": "initial" })
    expect(physical.calls.filter((call) => call === "read")).toHaveLength(1)
    expect(physical.calls.at(-1)).toBe("close")
  })

  it("starts at the requested root", async () => {
    const { manager } = await managerWith()
    await manager.getForThread("t-1", new AbortController().signal)
    const outcome = await manager.inspectThread("t-1", { ...request, root: "draft" }, new AbortController().signal)
    expect(outcome.ok && outcome.inspection.files).toEqual({ "task.json": "{}" })
  })

  it("names a thread with no workspace yet, and a missing root", async () => {
    const { manager } = await managerWith()
    expect(await manager.inspectThread("never-run", request, new AbortController().signal)).toMatchObject({
      ok: false,
      code: "workspace_not_found",
    })
    await manager.getForThread("t-1", new AbortController().signal)
    expect(
      await manager.inspectThread("t-1", { ...request, root: "missing" }, new AbortController().signal),
    ).toMatchObject({ ok: false, code: "workspace_root_missing", root: "missing", kind: "absent" })
  })

  it("refuses a thread being deleted", async () => {
    const { manager } = await managerWith()
    await manager.getForThread("t-1", new AbortController().signal)
    await manager.destroyThread("t-1")
    expect(await manager.inspectThread("t-1", request, new AbortController().signal)).toMatchObject({
      ok: false,
      code: "workspace_lost",
    })
  })
})

describe("inspectFailure", () => {
  const cases: [unknown, string][] = [
    [new WorkspaceInspectionError("changed", "x"), "workspace_changed"],
    [new WorkspaceInspectionError("refused", "x"), "workspace_inspection_refused"],
    [new WorkspaceInspectionError("invalid_options", "x"), "invalid_request"],
    [new WorkspaceInspectionError("root_missing", "x", { root: "d", kind: "absent" }), "workspace_root_missing"],
    [new WorkspaceLifecycleError("lost", "x"), "workspace_lost"],
    [new WorkspaceLifecycleError("expired", "x"), "workspace_expired"],
    [new WorkspaceLifecycleError("conflict", "x"), "workspace_conflict"],
    [new WorkspaceLifecycleError("retryable", "x"), "workspace_unavailable"],
    [new WorkspaceLifecycleError("uncertain", "x"), "workspace_unavailable"],
  ]
  for (const [error, code] of cases)
    it(`maps ${(error as Error).name} ${(error as { code: string }).code} to ${code}`, () => {
      expect(inspectFailure(error)).toMatchObject({ ok: false, code })
    })

  it("leaves an unclassified error (a bare read-limit, an I/O failure) to the caller", () => {
    expect(inspectFailure(new Error("docker exec failed"))).toBeUndefined()
    expect(inspectFailure(new WorkspaceReadLimitError("x", "/p", 1))).toBeUndefined()
    expect(inspectFailure(new WorkspaceLifecycleError("unsupported", "x"))).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4run/cli exec vitest run test/managed-workspace-inspect.test.ts`
Expected: FAIL: `inspectFailure` is not exported; `manager.inspectThread is not a function`.

- [ ] **Step 3: Implement**

In `managed-workspace-manager.ts`, add to the imports `inspectWorkspace`, `isWorkspaceInspectionError` and `scopedWorkspaceReader` from `@b4run/workspace`, and `type ThreadWorkspaceInspectOutcome, type ThreadWorkspaceInspectRequest` from `./workspace-protocol.js`. Above the class:

```ts
/**
 * A refusal of a workspace read, as the protocol names it; `undefined` for an
 * error that is nobody's refusal (a backend failure, an unsupported provider),
 * which the caller rethrows.
 */
export function inspectFailure(error: unknown): ThreadWorkspaceInspectOutcome | undefined {
  if (isWorkspaceInspectionError(error)) {
    const message = error.message
    switch (error.code) {
      case "root_missing":
        return {
          ok: false,
          code: "workspace_root_missing",
          message,
          ...(error.detail.root !== undefined ? { root: error.detail.root } : {}),
          ...(error.detail.kind !== undefined ? { kind: error.detail.kind } : {}),
        }
      case "changed":
        return { ok: false, code: "workspace_changed", message }
      case "refused":
        return { ok: false, code: "workspace_inspection_refused", message }
      case "invalid_options":
        return { ok: false, code: "invalid_request", message }
    }
  }
  if (error instanceof WorkspaceLifecycleError) {
    const message = error.message
    switch (error.code) {
      case "lost":
        return { ok: false, code: "workspace_lost", message }
      case "expired":
        return { ok: false, code: "workspace_expired", message }
      case "conflict":
        return { ok: false, code: "workspace_conflict", message }
      case "retryable":
      case "uncertain":
        return { ok: false, code: "workspace_unavailable", message }
      default:
        return undefined
    }
  }
  return undefined
}
```

Inside the class, after `getWorkspace`:

```ts
  /**
   * A bounded, read-only inventory of the thread's published workspace, through
   * the provider's reader: a separate, networkless container that never touches
   * the thread's session. The reader runs as the APP's `security.runAsNonRoot`,
   * the identity the workspace was written under. `retain` makes a concurrent
   * `destroyThread` refuse until the read ends. The caller excludes runs.
   */
  async inspectThread(
    threadId: string,
    request: ThreadWorkspaceInspectRequest,
    signal: AbortSignal,
  ): Promise<ThreadWorkspaceInspectOutcome> {
    this.#assertOpen()
    const { installation, provider, policy } = this.#options
    const record = installation.associations.get(threadId)
    if (!record)
      return {
        ok: false,
        code: "workspace_not_found",
        message: `Thread ${threadId} has no workspace yet: it has not run`,
      }
    if (record.intent.installationId !== installation.installationId)
      return { ok: false, code: "workspace_conflict", message: "Workspace installation identity mismatch" }
    if (record.state === "deleting" || record.state === "deleted")
      return { ok: false, code: "workspace_lost", message: `Thread ${threadId}'s workspace is deleted` }
    if (record.state === "creating" || !record.ready)
      return {
        ok: false,
        code: "workspace_not_ready",
        message: `Thread ${threadId}'s workspace is not published yet`,
      }
    const open = provider.openWorkspaceReader
    if (typeof open !== "function")
      throw new WorkspaceLifecycleError(
        "unsupported",
        `Managed workspace provider "${provider.name}" cannot read a workspace`,
      )
    let release: (() => void) | undefined
    try {
      const ready = verifyReadyWorkspace(record.ready, record.intent)
      const expiresAt = ready.provenance.retention.expiresAt
      if (expiresAt && Date.parse(expiresAt) <= this.#now())
        return {
          ok: false,
          code: "workspace_expired",
          message: `Thread ${threadId}'s workspace passed its retention deadline`,
        }
      release = this.retain(threadId)
      const runAsNonRoot = policy.security?.runAsNonRoot
      const inspection = await scopedWorkspaceReader(
        () =>
          open.call(provider, {
            workspace: ready,
            signal,
            ...(runAsNonRoot === undefined ? {} : { runAsNonRoot }),
          }),
        (reader) =>
          inspectWorkspace(reader, {
            signal,
            maxEntries: request.maxEntries,
            maxFileBytes: request.maxFileBytes,
            maxTotalBytes: request.maxTotalBytes,
            excludeRootDirectories: request.excludeRootDirectories,
            expectedRootSymlinks: request.expectedRootSymlinks,
            ...(request.root !== undefined ? { root: request.root } : {}),
          }),
      )
      return {
        ok: true,
        sourceDigest: record.intent.sourceDigest,
        intentDigest: record.intent.digest,
        inspection,
      }
    } catch (error) {
      const refusal = signal.aborted ? undefined : inspectFailure(error)
      if (refusal) return refusal
      throw error
    } finally {
      release?.()
    }
  }
```

(`retain` throws a `lost` `WorkspaceLifecycleError` for a thread being deleted between the check and the call; the `catch` classifies it.) `scopedWorkspaceReader` aggregates a close failure with a read failure (`packages/workspace/src/with-workspace-reader.ts:34-60`); an `AggregateError` is unclassified and rethrown.

In `sandbox-manager.ts`:

```ts
  /** See `ManagedWorkspaceManager.inspectThread`. Only a managed app with `workspaceRead` serves it. */
  async inspectThread(
    threadId: string,
    request: ThreadWorkspaceInspectRequest,
    signal: AbortSignal,
  ): Promise<ThreadWorkspaceInspectOutcome> {
    if (!this.#managed || !this.#protocol.read)
      throw new Error("Workspace reads are not served by this app (sandbox.workspaceRead)")
    return this.#managed.inspectThread(threadId, request, signal)
  }
```

with the two types imported from `./workspace-protocol.js`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4run/cli exec vitest run test/managed-workspace-inspect.test.ts test/managed-workspace-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/managed-workspace-manager.ts packages/cli/src/lib/runtime/sandbox-manager.ts packages/cli/test/managed-workspace-inspect.test.ts
git commit -m "feat(cli): the managed workspace manager inspects a thread from its own record

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: `POST /threads/:thread_id/workspace/inspect`

**Files:**
- Create: `packages/cli/src/lib/dev/thread-workspace-http.ts` (pure: request parser, response)
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (route table, after `GET /threads/:thread_id/pending_interrupts`)
- Modify: `packages/cli/test/thread-access-coverage.test.ts` (`GATED`, the count)
- Create: `packages/cli/test/thread-workspace-endpoint.test.ts`

- [ ] **Step 1: Write the failing endpoint tests** (the spec's proof list, plus the refusals D8 to D12 add)

```ts
// packages/cli/test/thread-workspace-endpoint.test.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorkspaceInstallationReader } from "@b4run/sqlite-storage"
import { inspectWorkspace, isCanonicalWorkspaceRoot, WorkspaceReadLimitError } from "@b4run/workspace"
import { afterEach, expect, it } from "vitest"
import {
  createRuntimeFetchHandler,
  type RuntimeFetchHandler,
} from "../src/lib/dev/runtime-fetch-handler.ts"
import { isCanonicalRoot } from "../src/lib/dev/thread-workspace-http.ts"
import { withManagedWorkspaceReader } from "../src/lib/runtime/managed-workspace-reader.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

const TOKEN = "Bearer endpoint-test-token"
const roots: string[] = []
const handlers: RuntimeFetchHandler[] = []
afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  delete (globalThis as { __b4Hold?: unknown }).__b4Hold
  delete (globalThis as { __b4Started?: unknown }).__b4Started
})

/** Admits only `TOKEN`, and denies with 403 as the factory's policy does. */
const tokenPolicy = {
  fallback: (req: { headers: Readonly<Record<string, string>> }) =>
    req.headers.authorization === TOKEN
      ? { decision: "allow" as const }
      : { decision: "deny" as const, status: 403 as const },
}

async function fixture(options: { readonly workspaceRead?: boolean; readonly policy?: unknown } = {}) {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-inspect-endpoint-"))
  roots.push(appRoot)
  const files = {
    "package.json": '{"type":"module"}',
    "b4.config.ts": "export default {}",
    "workspace/.keep": "",
    "source/main.txt": "initial",
    "src/app/edit/index.ts":
      "export const workflow=async (input,ctx)=>ctx.tools.edit(input)",
    "src/app/edit/tools/edit.ts":
      "export default async function edit(input:{path:string;text:string},ctx){await ctx.fs.writeFile(input.path,input.text);return {ok:true}}",
    "src/app/hold/index.ts":
      "export const workflow=async ()=>{globalThis.__b4Started?.();await globalThis.__b4Hold;return {held:true}}",
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(appRoot, path, ".."), { recursive: true })
    await writeFile(join(appRoot, path), text)
  }
  const physical = managedProviderFixture()
  const config = {
    sandbox: {
      provider: physical.provider,
      workspace: { source: { directory: "source", include: ["main.txt"] } },
      ...(options.workspaceRead === false ? {} : { workspaceRead: "http" as const }),
    },
  }
  const handler = await createRuntimeFetchHandler({
    appRoot,
    config,
    threadAccess: (options.policy ?? tokenPolicy) as never,
  })
  handlers.push(handler)
  const call = (method: string, path: string, body?: unknown, authorization: string | null = TOKEN) =>
    handler.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(authorization === null ? {} : { authorization }),
        },
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    )
  const createThread = async () =>
    ((await (await call("POST", "/threads", { metadata: {} })).json()) as { thread_id: string }).thread_id
  const run = (threadId: string, route: string, input = {}) =>
    call("POST", `/threads/${threadId}/runs/wait`, { route, input })
  const inspect = (threadId: string, body: unknown = {}, authorization: string | null = TOKEN) =>
    call("POST", `/threads/${threadId}/workspace/inspect`, body, authorization)
  return { appRoot, physical, handler, call, createThread, run, inspect }
}

it("answers what the local reader reads, on an idle thread, with the recorded digests", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  expect((await f.run(threadId, "/edit#workflow", { path: "draft/out.txt", text: "made" })).status).toBe(200)
  const response = await f.inspect(threadId)
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    threadId: string
    sourceDigest: string
    intentDigest: string
    inspection: unknown
  }
  const local = await withManagedWorkspaceReader(
    { appRoot: f.appRoot, provider: f.physical.provider, threadId, signal: new AbortController().signal },
    (reader) => inspectWorkspace(reader, {}),
  )
  expect(body.inspection).toEqual(JSON.parse(JSON.stringify(local)))
  const installation = openWorkspaceInstallationReader(f.appRoot)
  const intent = installation.associations.get(threadId)?.intent
  installation.close()
  expect(body).toMatchObject({ threadId, sourceDigest: intent?.sourceDigest, intentDigest: intent?.digest })
})

it("holds the run slot: 409 while a run is in flight, and a run cannot start during a read", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  let release!: () => void
  const hold = globalThis as { __b4Hold?: Promise<void>; __b4Started?: () => void }
  hold.__b4Hold = new Promise((resolve) => {
    release = resolve
  })
  // The route reports that it is running (so the run holds the slot) before the read is tried:
  // polling instead would let an early read take the slot and turn the run into the 409.
  const started = new Promise<void>((resolve) => {
    hold.__b4Started = resolve
  })
  const running = f.run(threadId, "/hold#workflow")
  await started
  const busy = await f.inspect(threadId)
  expect(busy.status).toBe(409)
  expect(await busy.json()).toMatchObject({ error: { details: { code: "run_in_flight" } } })
  release()
  expect((await running).status).toBe(200)
  expect((await f.inspect(threadId)).status).toBe(200)
})

it("403 without the token, and without a policy's allow the thread is not disclosed", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  await f.run(threadId, "/edit#workflow", { path: "a.txt", text: "a" })
  expect((await f.inspect(threadId, {}, null)).status).toBe(403)
  expect((await f.inspect(threadId, {}, "Bearer wrong")).status).toBe(403)
  const defaultDeny = await fixture({ policy: { fallback: () => ({ decision: "deny" }) } })
  expect((await defaultDeny.inspect("any-thread", {}, null)).status).toBe(404)
})

it("refuses a root with `..` by name, and names an absent root", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  await f.run(threadId, "/edit#workflow", { path: "a.txt", text: "a" })
  const traversal = await f.inspect(threadId, { root: "../etc" })
  expect(traversal.status).toBe(400)
  expect(JSON.stringify(await traversal.json())).toContain("../etc")
  const absent = await f.inspect(threadId, { root: "draft" })
  expect(absent.status).toBe(422)
  expect(await absent.json()).toMatchObject({
    error: { details: { code: "workspace_root_missing", root: "draft", kind: "absent" } },
  })
})

it("is not served unless the app opts in, and never tells an unauthorized caller which", async () => {
  const off = await fixture({ workspaceRead: false })
  const threadId = await off.createThread()
  const response = await off.inspect(threadId)
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ error: { message: "Not found" } })
  // Unauthorized: the gate's answer, on or off alike, and the body is never read.
  const on = await fixture()
  const onThread = await on.createThread()
  for (const [f, id] of [[off, threadId], [on, onThread]] as const) {
    const denied = await f.inspect(id, "x".repeat(200 * 1024), null)
    expect(denied.status).toBe(403)
  }
})

it("agrees with @b4run/workspace on which roots are canonical", () => {
  for (const root of ["draft", "a/b", "..", "a/../b", "/a", "a/", "a//b", "", ".", "a\\b", "x\u0000y", "é/ü"])
    expect([root, isCanonicalRoot(root)]).toEqual([root, isCanonicalWorkspaceRoot(root)])
})

it("answers 409 workspace_changed when the workspace changes under the read", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  await f.run(threadId, "/edit#workflow", { path: "a.txt", text: "a" })
  const open = f.physical.workspaces.openWorkspaceReader?.bind(f.physical.workspaces)
  if (!open) throw new Error("the fixture reads")
  f.physical.workspaces.openWorkspaceReader = async (input) => {
    const reader = await open(input)
    return {
      ...reader,
      filesystem: {
        ...reader.filesystem,
        readBinaryFile: async (path: string) => {
          throw new WorkspaceReadLimitError(`readBinaryFile ${path}: content exceeds maxBytes (1).`, path, 1)
        },
      },
    }
  }
  const response = await f.inspect(threadId)
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { details: { code: "workspace_changed" } } })
})

it("names a thread that has not run, and a thread that does not exist", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  expect(await (await f.inspect(threadId)).json()).toMatchObject({
    error: { details: { code: "workspace_not_found" } },
  })
  const missing = await f.inspect("no-such-thread")
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({ error: { details: { code: "thread_not_found" } } })
})

it("filters ignorePrefixes, and refuses unknown options, limits over the caps and oversized bodies", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  await f.run(threadId, "/edit#workflow", { path: "dist/out.js", text: "built" })
  const filtered = (await (await f.inspect(threadId, { ignorePrefixes: ["dist/"] })).json()) as {
    inspection: { files: Record<string, string> }
  }
  expect(Object.keys(filtered.inspection.files)).toEqual(["main.txt"])
  expect((await f.inspect(threadId, { rot: "draft" })).status).toBe(400)
  expect((await f.inspect(threadId, { maxTotalBytes: 64 * 1024 * 1024 })).status).toBe(400)
  expect((await f.inspect(threadId, "x".repeat(65 * 1024))).status).toBe(413)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4run/cli build && pnpm --filter @b4run/cli exec vitest run test/thread-workspace-endpoint.test.ts`
Expected: FAIL: every inspect answers `404 Not found` (no route).

- [ ] **Step 3: The pure request and response halves**

```ts
// packages/cli/src/lib/dev/thread-workspace-http.ts
import type {
  ThreadWorkspaceInspectFailure,
  ThreadWorkspaceInspectOutcome,
  ThreadWorkspaceInspectRequest,
} from "../runtime/workspace-protocol.js"
import { createRequestErrorBody } from "./server-errors.js"

/** The inspect request body's own ceiling: it names options, never content. */
export const INSPECT_BODY_MAX_BYTES = 64 * 1024
/** Server caps (D8). A request over one is refused, never silently lowered. */
export const INSPECT_CAPS = Object.freeze({
  maxEntries: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
})
/** Defaults: `inspectWorkspace`'s own. */
export const INSPECT_DEFAULTS = Object.freeze({
  maxEntries: 10_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
})
const KEYS = new Set([
  "root",
  "excludeRootDirectories",
  "expectedRootSymlinks",
  "ignorePrefixes",
  "maxEntries",
  "maxFileBytes",
  "maxTotalBytes",
])
const MAX_NAMES = 64

/**
 * `isCanonicalWorkspaceRoot` from `@b4run/workspace`, restated so this module stays in the
 * runtime core's pure graph without pulling that package's barrel in; the endpoint test
 * pins the two to the same answers over a table of roots.
 */
export function isCanonicalRoot(root: string): boolean {
  return (
    root.length > 0 &&
    root.length <= 1024 &&
    root
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          !segment.includes("\\") &&
          ![...segment].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
      )
  )
}

type Parsed =
  | { readonly ok: true; readonly request: ThreadWorkspaceInspectRequest }
  | { readonly ok: false; readonly message: string }

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function strings(value: unknown, what: string): string[] | string {
  if (!Array.isArray(value) || value.length > MAX_NAMES)
    return `${what} must be an array of at most ${MAX_NAMES} strings`
  for (const item of value)
    if (typeof item !== "string" || item === "" || item.length > 1024)
      return `${what} must hold non-empty strings of at most 1024 characters`
  return [...value] as string[]
}

function bounded(value: unknown, what: keyof typeof INSPECT_CAPS): number | string {
  if (value === undefined) return INSPECT_DEFAULTS[what]
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > INSPECT_CAPS[what])
    return `${what} must be an integer from 0 to ${INSPECT_CAPS[what]}`
  return value as number
}

/**
 * The body, strictly: own keys only, each known and typed. `root` is checked
 * again (segment by segment) by `inspectWorkspace`, which refuses `..` by name.
 */
export function parseThreadWorkspaceRequest(value: unknown): Parsed {
  if (!isPlain(value)) return { ok: false, message: "The request body must be a JSON object" }
  for (const key of Object.keys(value))
    if (!KEYS.has(key)) return { ok: false, message: `Unknown workspace read option: ${key}` }
  const own = (key: string) => (Object.hasOwn(value, key) ? value[key] : undefined)
  const root = own("root")
  if (root !== undefined && (typeof root !== "string" || !isCanonicalRoot(root)))
    return {
      ok: false,
      message: `Invalid workspace inspection root: ${JSON.stringify(root)} (relative leaf names, no "..", ".", empty segment, backslash or control character)`,
    }
  const excluded = own("excludeRootDirectories") === undefined ? [] : strings(own("excludeRootDirectories"), "excludeRootDirectories")
  if (typeof excluded === "string") return { ok: false, message: excluded }
  const ignored = own("ignorePrefixes") === undefined ? [] : strings(own("ignorePrefixes"), "ignorePrefixes")
  if (typeof ignored === "string") return { ok: false, message: ignored }
  if (ignored.some((prefix) => prefix.startsWith("/")))
    return { ok: false, message: "ignorePrefixes are relative to the inspected root" }
  const links = own("expectedRootSymlinks")
  const expectedRootSymlinks: Record<string, string> = Object.create(null)
  if (links !== undefined) {
    if (!isPlain(links) || Object.keys(links).length > MAX_NAMES)
      return { ok: false, message: `expectedRootSymlinks must be an object of at most ${MAX_NAMES} names` }
    for (const [name, target] of Object.entries(links)) {
      if (typeof target !== "string" || target === "" || target.length > 4096)
        return { ok: false, message: `expectedRootSymlinks.${name} must be a non-empty string` }
      Object.defineProperty(expectedRootSymlinks, name, { value: target, enumerable: true })
    }
  }
  const maxEntries = bounded(own("maxEntries"), "maxEntries")
  const maxFileBytes = bounded(own("maxFileBytes"), "maxFileBytes")
  const maxTotalBytes = bounded(own("maxTotalBytes"), "maxTotalBytes")
  for (const limit of [maxEntries, maxFileBytes, maxTotalBytes])
    if (typeof limit === "string") return { ok: false, message: limit }
  return {
    ok: true,
    request: {
      ...(root !== undefined ? { root: root as string } : {}),
      excludeRootDirectories: excluded,
      expectedRootSymlinks,
      ignorePrefixes: ignored,
      maxEntries: maxEntries as number,
      maxFileBytes: maxFileBytes as number,
      maxTotalBytes: maxTotalBytes as number,
    },
  }
}

const STATUS: Readonly<Record<ThreadWorkspaceInspectFailure, number>> = {
  workspace_not_found: 404,
  workspace_lost: 404,
  workspace_expired: 410,
  workspace_not_ready: 409,
  workspace_conflict: 409,
  workspace_changed: 409,
  workspace_unavailable: 503,
  workspace_root_missing: 422,
  workspace_inspection_refused: 422,
  invalid_request: 400,
}

/**
 * The one place an outcome becomes bytes. `ignorePrefixes` are applied here, to keys
 * relative to the root: the files are dropped from `files`, but they were read, so they
 * still count in `totalBytes` and `entries` (and against the byte and entry limits).
 * The two counts describe the inspection, not the answer.
 */
export function threadWorkspaceResponse(
  threadId: string,
  request: ThreadWorkspaceInspectRequest,
  outcome: ThreadWorkspaceInspectOutcome,
): Response {
  if (!outcome.ok)
    return Response.json(
      createRequestErrorBody(outcome.message, {
        code: outcome.code,
        ...(outcome.root !== undefined ? { root: outcome.root } : {}),
        ...(outcome.kind !== undefined ? { kind: outcome.kind } : {}),
      }),
      { status: STATUS[outcome.code] },
    )
  const files: Record<string, string> = Object.create(null)
  for (const [path, text] of Object.entries(outcome.inspection.files))
    if (!request.ignorePrefixes.some((prefix) => path.startsWith(prefix)))
      Object.defineProperty(files, path, { value: text, enumerable: true })
  return Response.json(
    {
      threadId,
      sourceDigest: outcome.sourceDigest,
      intentDigest: outcome.intentDigest,
      ...(request.root !== undefined ? { root: request.root } : {}),
      inspection: {
        files,
        symlinks: outcome.inspection.symlinks,
        totalBytes: outcome.inspection.totalBytes,
        entries: outcome.inspection.entries,
      },
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  )
}
```

- [ ] **Step 4: The route**

In `runtime-fetch-core.ts`, import `{ payloadTooLarge, RequestBodyTooLargeError, readBoundedText } from "./bounded-body.js"` and `{ INSPECT_BODY_MAX_BYTES, parseThreadWorkspaceRequest, threadWorkspaceResponse } from "./thread-workspace-http.js"`; add this element to the array `buildRouteTable` returns, after the `pending_interrupts` element:

```ts
    // ------------------------------------------------------------------
    // POST /threads/:thread_id/workspace/inspect — read a thread's workspace
    // ------------------------------------------------------------------
    // Order: thread lookup, gate, THEN the feature check and the body. An unauthorized
    // caller gets the gate's answer whether the feature is on or off, so the route never
    // tells it which; an authorized caller of an app without `sandbox.workspaceRead`
    // gets the same 404 as a route that does not exist. Nothing is read from the body
    // until the caller is authorized. A `read` of the thread (`thread.workspace`), so a
    // denial defaults to the same 404 a missing thread returns.
    {
      handle: async (request, params) => {
        const threadId = params.thread_id ?? ""
        const thread = await getThreadsStore(request).getThread(threadId)
        const notFound = () =>
          Response.json(createRequestErrorBody("Thread not found", { code: "thread_not_found" }), {
            status: 404,
          })
        const gate = makeThreadGate(threadAccess, request)
        const g = gate({
          action: "read",
          notFound,
          operation: "thread.workspace",
          threadId,
          ...(thread ? { thread } : {}),
        })
        const settled = isThenable(g) ? await g : g
        if (!settled.ok) return settled.response
        if (!sandboxManager?.workspaceProtocol.read)
          return Response.json(createRequestErrorBody("Not found"), { status: 404 })
        if (!thread) return notFound()
        let body: unknown = {}
        try {
          const raw = await readBoundedText(request, INSPECT_BODY_MAX_BYTES)
          if (raw.trim()) {
            const parsed = parseJson(raw)
            if (!parsed.ok)
              return Response.json(createRequestErrorBody("Malformed request body"), { status: 400 })
            body = parsed.value
          }
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) return payloadTooLarge(error)
          throw error
        }
        // Every option, `root` included, is refused here before a reader is started.
        const parsed = parseThreadWorkspaceRequest(body)
        if (!parsed.ok)
          return Response.json(createRequestErrorBody(parsed.message, { code: "invalid_request" }), {
            status: 400,
          })
        // The read holds the thread's one run slot for its whole duration (D9): a run
        // started meanwhile is the ordinary 409, a DELETE is refused, a cancel aborts the
        // read, and shutdown drains it. After the gate, so a 409 never tells an
        // unauthorized caller the thread is busy.
        const slot = getRunRegistry(request).begin(threadId, getShutdownSignal(request))
        if (!slot)
          return Response.json(
            createRequestErrorBody(`A run is already in flight for thread "${threadId}"`, {
              code: "run_in_flight",
            }),
            { status: 409 },
          )
        try {
          const outcome = await sandboxManager.inspectThread(
            threadId,
            parsed.request,
            AbortSignal.any([slot.signal, request.signal]),
          )
          return threadWorkspaceResponse(threadId, parsed.request, outcome)
        } finally {
          slot.release()
        }
      },
      method: "POST",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/workspace\/inspect(?:\?.*)?$/,
    },
```

(`AbortSignal.any` is safe here: both sources live only as long as this request, unlike the process-lifetime shutdown signal the run registry avoids composing with; `run-registry.ts:16-21`.)

- [ ] **Step 5: Classify the route**

In `packages/cli/test/thread-access-coverage.test.ts`, add to `GATED`:

```ts
  routeKey("POST", /^\/threads\/(?<thread_id>[^/?#]+)\/workspace\/inspect(?:\?.*)?$/),
```

and change the count test to 17 with its comment extended by "plus `POST /threads/:thread_id/workspace/inspect` (spec item 3)".

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @b4run/cli exec vitest run test/thread-workspace-endpoint.test.ts test/thread-access-coverage.test.ts test/fetch-entry-purity.test.ts test/runtime-fetch-parity.test.ts`
Expected: PASS. (`runtime-fetch-parity.test.ts` exercises a chat route through both runtimes and enumerates no routes, so it needs no edit; it is run to show the new route changes nothing it covers.)

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/dev/thread-workspace-http.ts packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/thread-workspace-endpoint.test.ts packages/cli/test/thread-access-coverage.test.ts
git commit -m "feat(cli): POST /threads/:thread_id/workspace/inspect behind thread.workspace

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: `readThreadWorkspace`, the client, in `@b4run/cli/workspace`

A caller that holds only a worker's URL and credential reads a thread with one call, and gets either a verified inventory or an error that names why. The response is parsed strictly (own keys, types, digests), so a proxy or a wrong service answering on the port cannot be mistaken for a worker; `expectedSourceDigest` and the `threadId` echo refuse an answer about another workspace (D14).

**Files:**
- Create: `packages/cli/src/lib/runtime/read-thread-workspace.ts`
- Modify: `packages/cli/src/workspace-exports.ts`
- Create: `packages/cli/test/read-thread-workspace.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/read-thread-workspace.test.ts
import { describe, expect, it } from "vitest"
import {
  readThreadWorkspace,
  ThreadWorkspaceReadError,
} from "../src/lib/runtime/read-thread-workspace.ts"

const DIGEST = "a".repeat(64)
const OTHER = "b".repeat(64)
const good = {
  threadId: "t 1",
  sourceDigest: DIGEST,
  intentDigest: OTHER,
  root: "draft",
  inspection: { files: { "task.json": "{}" }, symlinks: {}, totalBytes: 2, entries: 1 },
}

function answering(status: number, body: unknown, seen: Request[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init))
    return Response.json(body, { status })
  }) as typeof fetch
}

describe("readThreadWorkspace", () => {
  it("posts the options with the caller's headers and returns the verified read", async () => {
    const seen: Request[] = []
    const read = await readThreadWorkspace(
      "http://worker:4100/",
      "t 1",
      { root: "draft", maxTotalBytes: 1024 },
      { headers: { authorization: "Bearer x" }, fetch: answering(200, good, seen), expectedSourceDigest: DIGEST },
    )
    expect(read).toEqual(good)
    expect(Object.getPrototypeOf(read.inspection.files)).toBeNull()
    const request = seen[0] as Request
    expect(request.method).toBe("POST")
    expect(request.url).toBe("http://worker:4100/threads/t%201/workspace/inspect")
    expect(request.headers.get("authorization")).toBe("Bearer x")
    expect(request.redirect).toBe("error")
    expect(await request.json()).toEqual({ root: "draft", maxTotalBytes: 1024 })
  })

  it("refuses an answer larger than maxResponseBytes before holding it whole", async () => {
    await expect(
      readThreadWorkspace("http://w", "t 1", {}, { fetch: answering(200, good), maxResponseBytes: 64 }),
    ).rejects.toMatchObject({ code: "response_too_large" })
  })

  it("refuses an answer about another source or another thread", async () => {
    await expect(
      readThreadWorkspace("http://w", "t 1", {}, { fetch: answering(200, good), expectedSourceDigest: OTHER }),
    ).rejects.toMatchObject({ code: "source_mismatch" })
    await expect(
      readThreadWorkspace("http://w", "t 2", {}, { fetch: answering(200, good) }),
    ).rejects.toMatchObject({ code: "thread_mismatch" })
  })

  for (const [label, body] of Object.entries({
    "an extra key": { ...good, extra: 1 },
    "a bad digest": { ...good, sourceDigest: "sha256:x" },
    "a non-string file": { ...good, inspection: { ...good.inspection, files: { a: 1 } } },
    "a missing inspection": { threadId: "t 1", sourceDigest: DIGEST, intentDigest: OTHER },
    "an array": [good],
    "a file key that climbs out": { ...good, inspection: { ...good.inspection, files: { "../x": "" } } },
    "an absolute file key": { ...good, inspection: { ...good.inspection, files: { "/etc/passwd": "" } } },
    "a nested symlink key": { ...good, inspection: { ...good.inspection, symlinks: { "a/b": "/x" } } },
  }))
    it(`refuses a malformed answer: ${label}`, async () => {
      await expect(
        readThreadWorkspace("http://w", "t 1", {}, { fetch: answering(200, body) }),
      ).rejects.toMatchObject({ code: "malformed_response" })
    })

  it("keeps a refusal's status, code and details", async () => {
    const error = await readThreadWorkspace(
      "http://w",
      "t 1",
      { root: "draft" },
      {
        fetch: answering(422, {
          error: {
            kind: "request_error",
            message: 'Workspace root "draft" is missing',
            details: { code: "workspace_root_missing", root: "draft", kind: "absent" },
          },
        }),
      },
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ThreadWorkspaceReadError)
    expect(error).toMatchObject({
      status: 422,
      code: "workspace_root_missing",
      details: { root: "draft", kind: "absent" },
    })
  })

  it("keeps a non-JSON failure's text", async () => {
    const fetchImpl = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch
    await expect(readThreadWorkspace("http://w", "t", {}, { fetch: fetchImpl })).rejects.toMatchObject({
      status: 502,
      code: undefined,
      message: expect.stringContaining("bad gateway"),
    })
  })
})
```

Add one round-trip case to `packages/cli/test/thread-workspace-endpoint.test.ts`, so the client is proven against the real endpoint:

```ts
it("round-trips through readThreadWorkspace", async () => {
  const f = await fixture()
  const threadId = await f.createThread()
  await f.run(threadId, "/edit#workflow", { path: "draft/task.json", text: "{}" })
  const installation = openWorkspaceInstallationReader(f.appRoot)
  const sourceDigest = installation.associations.get(threadId)?.intent.sourceDigest as string
  installation.close()
  const read = await readThreadWorkspace(
    "http://localhost",
    threadId,
    { root: "draft" },
    {
      headers: { authorization: TOKEN },
      expectedSourceDigest: sourceDigest,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        f.handler.fetch(new Request(input, init))) as typeof fetch,
    },
  )
  expect(read.inspection.files).toEqual({ "task.json": "{}" })
})
```

with `import { readThreadWorkspace } from "../src/lib/runtime/read-thread-workspace.ts"`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4run/cli exec vitest run test/read-thread-workspace.test.ts`
Expected: FAIL: cannot find the module.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/lib/runtime/read-thread-workspace.ts
import type { WorkspaceInspection } from "@b4run/workspace"

/** The options `POST /threads/:thread_id/workspace/inspect` accepts. */
export interface ReadThreadWorkspaceOptions {
  /** Start the inspection here (e.g. `"draft"`); keys come back relative to it. */
  readonly root?: string
  readonly excludeRootDirectories?: readonly string[]
  readonly expectedRootSymlinks?: Readonly<Record<string, string>>
  /** Keys under these prefixes (relative to `root`) are left out of the answer. */
  readonly ignorePrefixes?: readonly string[]
  readonly maxEntries?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
}

export interface ReadThreadWorkspaceInit {
  /** Sent with the request: the worker's thread-access policy reads them. */
  readonly headers?: HeadersInit
  readonly signal?: AbortSignal
  /** Refuse an answer whose recorded source is not this digest (`source_mismatch`). */
  readonly expectedSourceDigest?: string
  /** Refuse an answer larger than this (`response_too_large`). Default 80 MiB: 32 MiB of text, JSON-escaped. */
  readonly maxResponseBytes?: number
  readonly fetch?: typeof fetch
}

export interface ThreadWorkspaceRead {
  readonly threadId: string
  /** The source the thread's workspace was created from, as the worker recorded it. */
  readonly sourceDigest: string
  readonly intentDigest: string
  readonly root?: string
  readonly inspection: WorkspaceInspection
}

/**
 * A read that did not produce a verified inventory. `status` is the HTTP status
 * (0 for a local refusal of the answer); `code` is the worker's
 * (`workspace_root_missing`, `run_in_flight`, `workspace_changed`, ...) or the
 * client's own (`source_mismatch`, `thread_mismatch`, `malformed_response`).
 */
export class ThreadWorkspaceReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = "ThreadWorkspaceReadError"
  }
}

const DIGEST = /^[0-9a-f]{64}$/

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function malformed(why: string): ThreadWorkspaceReadError {
  return new ThreadWorkspaceReadError(0, "malformed_response", `Malformed workspace read response: ${why}`)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(value)
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => ![...required, ...optional].includes(key)))
    throw malformed(`expected keys ${[...required, ...optional].join(", ")}, got ${keys.join(", ")}`)
}

const RESPONSE_MAX_BYTES = 80 * 1024 * 1024

/** A leaf name as `inspectWorkspace` admits one: no empty, `.`, `..`, slash, backslash or control character. */
function isLeaf(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    ![...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
}

/**
 * Own string values only, copied onto a null prototype so no key can reach
 * `Object.prototype`. Every key must be a relative path of leaf names (`nested`) or a
 * single leaf: a caller that joins a key to a directory can never be walked out of it.
 */
function textRecord(value: unknown, what: string, nested: boolean): Record<string, string> {
  if (!isPlain(value)) throw malformed(`${what} is not an object`)
  const copy: Record<string, string> = Object.create(null)
  for (const [key, text] of Object.entries(value)) {
    if (!(nested ? key.split("/").every(isLeaf) : isLeaf(key)))
      throw malformed(`${what} key ${JSON.stringify(key)} is not a relative path`)
    if (typeof text !== "string") throw malformed(`${what}.${key} is not a string`)
    Object.defineProperty(copy, key, { value: text, enumerable: true })
  }
  return copy
}

/** The body as text, refusing more than `max` bytes before holding it whole. */
async function boundedText(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  const parts: string[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new ThreadWorkspaceReadError(0, "response_too_large", `The worker's answer exceeds ${max} bytes`)
    }
    parts.push(decoder.decode(value, { stream: true }))
  }
  parts.push(decoder.decode())
  return parts.join("")
}

function count(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw malformed(`${what} is not a count`)
  return value as number
}

function verify(body: unknown, threadId: string, init: ReadThreadWorkspaceInit): ThreadWorkspaceRead {
  if (!isPlain(body)) throw malformed("not an object")
  exactKeys(body, ["threadId", "sourceDigest", "intentDigest", "inspection"], ["root"])
  if (typeof body.sourceDigest !== "string" || !DIGEST.test(body.sourceDigest)) throw malformed("sourceDigest")
  if (typeof body.intentDigest !== "string" || !DIGEST.test(body.intentDigest)) throw malformed("intentDigest")
  if (body.root !== undefined && typeof body.root !== "string") throw malformed("root")
  if (!isPlain(body.inspection)) throw malformed("inspection")
  exactKeys(body.inspection, ["files", "symlinks", "totalBytes", "entries"])
  const read: ThreadWorkspaceRead = {
    threadId: String(body.threadId),
    sourceDigest: body.sourceDigest,
    intentDigest: body.intentDigest,
    ...(typeof body.root === "string" ? { root: body.root } : {}),
    inspection: {
      files: textRecord(body.inspection.files, "files", true),
      symlinks: textRecord(body.inspection.symlinks, "symlinks", false),
      totalBytes: count(body.inspection.totalBytes, "totalBytes"),
      entries: count(body.inspection.entries, "entries"),
    },
  }
  if (body.threadId !== threadId)
    throw new ThreadWorkspaceReadError(
      0,
      "thread_mismatch",
      `The worker answered for thread ${JSON.stringify(body.threadId)}, not ${JSON.stringify(threadId)}`,
    )
  if (init.expectedSourceDigest !== undefined && read.sourceDigest !== init.expectedSourceDigest)
    throw new ThreadWorkspaceReadError(
      0,
      "source_mismatch",
      `Thread ${threadId}'s workspace was created from ${read.sourceDigest}, not the expected ${init.expectedSourceDigest}`,
    )
  return read
}

/**
 * Read a thread's workspace from a worker that serves `sandbox.workspaceRead:
 * "http"`, authorized by whatever `init.headers` carry. The worker runs the
 * read in a separate, networkless, read-only container; this only transports
 * and verifies the answer. Nothing it returns is trusted beyond its shape:
 * diff and verify the bytes before acting on them.
 */
export async function readThreadWorkspace(
  baseUrl: string,
  threadId: string,
  options: ReadThreadWorkspaceOptions = {},
  init: ReadThreadWorkspaceInit = {},
): Promise<ThreadWorkspaceRead> {
  const url = `${baseUrl.replace(/\/$/, "")}/threads/${encodeURIComponent(threadId)}/workspace/inspect`
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json")
  const response = await (init.fetch ?? fetch)(url, {
    method: "POST",
    headers,
    body: JSON.stringify(options),
    // A redirect would carry the credential in `headers` to wherever it points.
    redirect: "error",
    ...(init.signal ? { signal: init.signal } : {}),
  })
  const text = await boundedText(response, init.maxResponseBytes ?? RESPONSE_MAX_BYTES)
  if (!response.ok) {
    let message = text
    let code: string | undefined
    let details: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown; details?: unknown } }
      if (typeof parsed.error?.message === "string") message = parsed.error.message
      if (isPlain(parsed.error?.details)) {
        details = parsed.error.details
        code = typeof details.code === "string" ? details.code : undefined
      }
    } catch {
      // Not JSON: keep the text.
    }
    throw new ThreadWorkspaceReadError(response.status, code, `Worker answered ${response.status}${code ? ` (${code})` : ""}: ${message}`, details)
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw malformed("not JSON")
  }
  return verify(body, threadId, init)
}
```

Export it from `packages/cli/src/workspace-exports.ts`:

```ts
export {
  type ReadThreadWorkspaceInit,
  type ReadThreadWorkspaceOptions,
  readThreadWorkspace,
  ThreadWorkspaceReadError,
  type ThreadWorkspaceRead,
} from "./lib/runtime/read-thread-workspace.js"
```

and extend that file's header comment: "`readThreadWorkspace` reads the same inventory over the worker's Agent Protocol port (`sandbox.workspaceRead`), for a caller with no path to the worker's app root."

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4run/cli exec vitest run test/read-thread-workspace.test.ts test/thread-workspace-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/read-thread-workspace.ts packages/cli/src/workspace-exports.ts packages/cli/test/read-thread-workspace.test.ts packages/cli/test/thread-workspace-endpoint.test.ts
git commit -m "feat(cli): readThreadWorkspace reads a worker's thread over HTTP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Documentation and changeset

Existing pages only, so no lastmod regeneration (`AGENTS.md`). `scripts/check-docs.mjs` pins required phrases per page and the API inventory per export; run it after each page and add what it names.

**Files:**
- Modify: `apps/web/content/docs/sandbox.mdx` (a section after "Reading a thread's workspace from another process", `:189-224`)
- Modify: `apps/web/content/docs/dev-server/agent-protocol.mdx` (endpoint table, `:34-48`)
- Modify: `apps/web/content/docs/thread-access.mdx` (a new section; the page has no list of operations to extend)
- Modify: `apps/web/content/docs/api/workspace.mdx`, `apps/web/content/docs/api/cli.mdx:155-166, 239-258` (`api/sdk.mdx` describes `ThreadOperation` in one generic row, `:95`, and needs no change)
- Modify: `scripts/check-docs.mjs` (the agent-protocol page's `required` list, `:2776-2800`)
- Create: `.changeset/workspace-read-http.md`

- [ ] **Step 1: The sandbox page**

Add after the "Reading a thread's workspace from another process" section:

````mdx
## Reading a thread's workspace over HTTP

A caller with no path to the worker's app root (another host, another container) reads a thread's managed workspace through the worker's own Agent Protocol port. Turn it on in `b4.config.ts`:

```ts
export default config({
  sandbox: {
    provider: dockerSandbox({ scope: "my-app", image: "node:24-slim" }),
    workspace: async (thread) => definitionFor(thread),
    workspaceRead: "http",
  },
})
```

and read with the client from `@b4run/cli/workspace`:

```ts
import { readThreadWorkspace } from "@b4run/cli/workspace"

const read = await readThreadWorkspace(
  "http://worker:4100",
  threadId,
  { root: "draft", excludeRootDirectories: [".git"] },
  { headers: { authorization: `Bearer ${token}` }, expectedSourceDigest },
)
read.inspection.files // relative to `root`
```

The worker serves it with the same reader as above, inside its own process: a separate, networkless, read-only container, never the thread's session, running as the app's `security.runAsNonRoot`. The read holds the thread's run slot, so it never overlaps a turn: a run in flight answers `409 run_in_flight`, and a run started during the read gets the same.

- **It needs a thread-access policy.** `b4 check`, `b4 build` and boot refuse `workspaceRead` without one, because the endpoint discloses every file under the requested root. The policy sees it as the `thread.workspace` operation, a `read`, so a denial answers the same 404 as a missing thread.
- **It needs managed workspaces** (`sandbox.workspace` or `sandbox.thread`) and a provider whose managed workspaces can be read. `dockerSandbox` can.
- **Limits.** `maxEntries` up to 10,000, `maxFileBytes` up to 16 MiB, `maxTotalBytes` up to 32 MiB; the defaults are `inspectWorkspace`'s. The answer is one JSON document. `ignorePrefixes` drops paths from `files`, but they were read, so they count in `totalBytes`, `entries` and the limits.
- **Refusals are named.** `404 workspace_not_found` (the thread has not run), `404 workspace_lost`, `410 workspace_expired`, `409 workspace_not_ready`, `409 workspace_changed` (the workspace changed while it was read; retry), `422 workspace_root_missing` with `root` and `kind`, `422 workspace_inspection_refused` (an executable, binary or oversized file), `400 invalid_request`.
- **Check what you get.** The answer carries the thread's recorded `sourceDigest`. Pass the digest you expect as `expectedSourceDigest` and the client refuses an answer about another workspace; it also refuses an answer for another thread id.
````

- [ ] **Step 2: The Agent Protocol page**

Add a row to the endpoint table after the `pending_interrupts` row:

```md
| `POST /threads/:thread_id/workspace/inspect` | Optional `{ "root", "excludeRootDirectories", "expectedRootSymlinks", "ignorePrefixes", "maxEntries", "maxFileBytes", "maxTotalBytes" }` | `200 { threadId, sourceDigest, intentDigest, root?, inspection }`. Only with `sandbox.workspaceRead: "http"` and a thread-access policy. `409` `run_in_flight` or `workspace_changed`, `422` `workspace_root_missing`, `413` over 64 KiB |
```

and add `"POST /threads/:thread_id/workspace/inspect"` to that page's `required` array in `scripts/check-docs.mjs`.

- [ ] **Step 3: The thread-access page**

Add a section after "What the policy receives":

```md
## Workspace endpoints

`sandbox.workspaceRead: "http"` serves a read of a thread's workspace files as the `thread.workspace` operation, under `read`. B4.run refuses to boot the option without a policy. A policy that authorizes by owner already covers it; a service that reads every thread (a controller, a reviewer) is usually admitted by a credential in `headers`, compared in constant time.
```

- [ ] **Step 4: The API pages**

`api/workspace.mdx`: rows for `WorkspaceInspectionError` ("A named inspection refusal: `invalid_options`, `root_missing`, `refused`, `changed`."), `isWorkspaceInspectionError`, `WorkspaceInspectionErrorCode`, `WorkspaceInspectionErrorDetail`, `WorkspaceReadLimitError` ("A bounded read found more bytes than its limit; thrown by B4.run's backends."), `isWorkspaceReadLimitError`; one sentence under `inspectWorkspace` for `root`; `workspaceRead` in the `SandboxConfig` description. `api/cli.mdx`: rows for `readThreadWorkspace`, `ReadThreadWorkspaceOptions`, `ReadThreadWorkspaceInit`, `ThreadWorkspaceRead`, `ThreadWorkspaceReadError` in the `@b4run/cli/workspace` table, and under "Reading a managed workspace":

```md
`readThreadWorkspace(url, threadId, options, { headers, signal, expectedSourceDigest })`
reads the same inventory over a worker's Agent Protocol port when the worker
sets `sandbox.workspaceRead: "http"`, for a caller that cannot reach the
worker's app root. It verifies the answer's shape, thread and (when given)
source digest, and throws `ThreadWorkspaceReadError` with the worker's status
and code otherwise.
```

- [ ] **Step 5: Check the docs**

Run: `node scripts/check-docs.mjs`
Expected: exit 0. A failure names a page and a missing phrase or an undocumented export: add it where named.

- [ ] **Step 6: The changeset**

```md
---
"@b4run/cli": patch
"@b4run/workspace": patch
"@b4run/sandbox": patch
"@b4run/sdk": patch
---

Read a thread's workspace over HTTP. `sandbox.workspaceRead: "http"` serves `POST /threads/:thread_id/workspace/inspect`, a bounded read-only inventory of a thread's managed workspace, authorized by the app's thread-access policy as the new `thread.workspace` operation; `b4 check`, `b4 build` and boot refuse it without a policy. `readThreadWorkspace` in `@b4run/cli/workspace` is the client. `inspectWorkspace` gains `root` and throws `WorkspaceInspectionError` with a code (`invalid_options`, `root_missing`, `refused`, `changed`); B4.run's bounded reads throw `WorkspaceReadLimitError` with their existing messages. `ThreadOperation` gains a member, so an exhaustive `switch` over it needs a case. On Node, a request body a handler stops reading part-way is now discarded rather than resetting the connection, so a refusal such as a 413 reaches the client.
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/content/docs/sandbox.mdx apps/web/content/docs/dev-server/agent-protocol.mdx apps/web/content/docs/thread-access.mdx apps/web/content/docs/api/workspace.mdx apps/web/content/docs/api/cli.mdx scripts/check-docs.mjs .changeset/workspace-read-http.md
git commit -m "docs(sandbox): reading a thread's workspace over HTTP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: The PR 2 gate

- [ ] **Step 1:** `pnpm lint` → exit 0.
- [ ] **Step 2:** `pnpm build` → exit 0.
- [ ] **Step 3:** `pnpm typecheck` → exit 0.
- [ ] **Step 4:** `pnpm test` → exit 0. (Node 24.)
- [ ] **Step 5:** `node scripts/check-docs.mjs` and `node scripts/check-changesets.mjs` → exit 0.
- [ ] **Step 6:** `pnpm check:release-inventory` and `pnpm pack:check` → exit 0 (the `@b4run/cli/workspace` subpath gained exports).
- [ ] **Step 7:** `git diff origin/main --stat` lists only the files in the PR 2 file map; open the PR. At most two maintainer PRs in full CI at once (`AGENTS.md`).

---

# PR 3: the factory reads its workers over HTTP

```bash
git fetch origin
git switch -c blove/factory-read-http origin/main    # PR 1 and PR 2 merged
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@b4-example/software-factory-controller^...
```

After this PR the controller reads a builder or drafter thread with the worker's URL, the worker token and the source digest it journalled when it handed the thread its workspace, and nothing else: no app root, no installation store, no Docker client of the worker's daemon for reads. Manifests are still written to a shared directory until PR 5; that directory becomes a required variable here, since its default was derived from the retired app root.

### Task 15: Both workers serve `workspaceRead`

**Files:**
- Modify: `examples/software-factory/server/b4.config.ts` (the `sandbox` block)
- Modify: `examples/software-factory/drafter/b4.config.ts` (the `sandbox` block)
- Test: `examples/software-factory/server/test/builder-config.test.ts`, `examples/software-factory/drafter/test/drafter-config.test.ts`

- [ ] **Step 1: Write the failing tests**

In each config test (they already import the app's `b4.config.ts` through `loadConfig`, `builder-config.test.ts:65` and `drafter-config.test.ts:63`), add:

```ts
  it("serves its threads' workspaces over its own port, behind src/thread-access.ts", async () => {
    const config = (await import("../b4.config.ts")).default
    expect(config.sandbox?.workspaceRead).toBe("http")
    expect(existsSync(fileURLToPath(new URL("../src/thread-access.ts", import.meta.url)))).toBe(true)
  })
```

with `existsSync` from `node:fs` and `fileURLToPath` from `node:url`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-server test && pnpm --filter @b4-example/software-factory-drafter test`
Expected: FAIL: `workspaceRead` is `undefined`.

- [ ] **Step 3: Implement**

In both `b4.config.ts` files, inside `sandbox`, after `provider`:

```ts
    // The controller reads a thread's workspace through this app's own port
    // (`POST /threads/:id/workspace/inspect`), authorized by src/thread-access.ts, and
    // never opens this app's installation store or its volumes itself.
    workspaceRead: "http",
```

- [ ] **Step 4: Run the tests and the apps' own checks**

Run: `pnpm --filter @b4-example/software-factory-server test && pnpm --filter @b4-example/software-factory-drafter test && FACTORY_BUILDER_LANE=1 FACTORY_BUILDER_MANIFEST_DIR=$(mktemp -d) pnpm --filter @b4-example/software-factory-server check && pnpm --filter @b4-example/software-factory-drafter check`
Expected: exit 0 (`b4 check` finds `src/thread-access.ts`; without it, it would refuse the option).

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/server/b4.config.ts examples/software-factory/drafter/b4.config.ts examples/software-factory/server/test/builder-config.test.ts examples/software-factory/drafter/test/drafter-config.test.ts
git commit -m "feat(software-factory): the workers serve their threads' workspaces over HTTP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: The controller's reader is a URL, a token and a digest

**Files:**
- Modify: `examples/software-factory/controller/src/lib/worker/workspace-reader.ts` (replace `ThreadWorkspaceSource` and `createThreadWorkspaceReader`; `WorkspaceTarget.sourceDigest`; `WorkspaceReadOptions` loses `runAsNonRoot`)
- Create: `examples/software-factory/controller/src/lib/controller/source-digest.ts`
- Modify: `examples/software-factory/controller/src/lib/controller/verify.ts:73-79`, `intake.ts:309-313`
- Modify: `examples/software-factory/controller/src/lib/targets/workspace.ts` (`targetInspectionOptions` no longer derives `runAsNonRoot`)
- Modify: `examples/software-factory/controller/test/fake-workspace-reader.ts`, `workspace-reader.test.ts`
- Create: `examples/software-factory/controller/test/source-digest.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// examples/software-factory/controller/test/source-digest.test.ts
import { describe, expect, it } from "vitest"
import { handedSourceDigest } from "../src/lib/controller/source-digest.ts"

const A = "a".repeat(64)
const B = "b".repeat(64)
const events = (...list: [string, Record<string, unknown>][]) =>
  list.map(([type, payload]) => ({ type, payload }))

describe("handedSourceDigest", () => {
  it("is the digest written just before the thread that holds it was created", () => {
    const log = events(
      ["builder_manifest_written", { sourceDigest: A }],
      ["thread_created", { threadId: "t-1" }],
      ["builder_manifest_written", { sourceDigest: B }],
      ["thread_created", { threadId: "t-2" }],
    )
    expect(handedSourceDigest(log, "t-1", "builder")).toBe(A)
    expect(handedSourceDigest(log, "t-2", "builder")).toBe(B)
  })

  it("is not a later write whose thread creation failed", () => {
    const log = events(
      ["builder_manifest_written", { sourceDigest: A }],
      ["thread_created", { threadId: "t-1" }],
      ["builder_manifest_written", { sourceDigest: B }],
    )
    expect(handedSourceDigest(log, "t-1", "builder")).toBe(A)
  })

  it("reads a staged upload's digest exactly as a manifest's", () => {
    const log = events(
      ["builder_manifest_written", { sourceDigest: A }],
      ["thread_created", { threadId: "t-1" }],
      ["builder_source_staged", { sourceDigest: B, status: "created" }],
      ["thread_created", { threadId: "t-2" }],
    )
    expect(handedSourceDigest(log, "t-1", "builder")).toBe(A)
    expect(handedSourceDigest(log, "t-2", "builder")).toBe(B)
  })

  it("reads the drafter's events for a drafter thread", () => {
    const log = events(
      ["drafter_manifest_written", { sourceDigest: A }],
      ["intake_thread_created", { threadId: "t-d" }],
    )
    expect(handedSourceDigest(log, "t-d", "drafter")).toBe(A)
  })

  it("refuses when nothing was handed to that thread", () => {
    expect(() => handedSourceDigest(events(["thread_created", { threadId: "t-1" }]), "t-1", "builder")).toThrow(
      /No builder source digest is journalled for thread t-1/,
    )
    expect(() => handedSourceDigest([], "t-9", "builder")).toThrow(/thread t-9/)
  })
})
```

Replace the `describe("the real thread workspace reader", ...)` block of `test/workspace-reader.test.ts` with an HTTP one over a scripted `fetch`:

```ts
describe("the HTTP thread workspace reader", () => {
  const DIGEST = "d".repeat(64)
  const answer = (files: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    threadId: "t-1",
    sourceDigest: DIGEST,
    intentDigest: "e".repeat(64),
    inspection: { files, symlinks: {}, totalBytes: 1, entries: 1 },
    ...extra,
  })
  const scripted = (status: number, body: unknown, seen: Request[] = []) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init))
      return Response.json(body, { status })
    }) as typeof fetch

  it("sends the token and the task's options, and re-prefixes keys with the root", async () => {
    const seen: Request[] = []
    const reader = createHttpThreadWorkspaceReader(
      { url: "http://drafter:4200", token: "tok", fetch: scripted(200, answer({ "task.json": "{}" }, { root: "draft" }), seen) },
      () => ({ excludeRootDirectories: [], expectedRootSymlinks: {}, root: "draft" }),
    )
    const files = await reader.read({ threadId: "t-1", sourceDigest: DIGEST }, AbortSignal.timeout(1_000))
    expect(files).toEqual(new Map([["draft/task.json", "{}"]]))
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer tok")
    expect(await seen[0]?.json()).toMatchObject({ root: "draft", excludeRootDirectories: [] })
  })

  it("maps the worker's missing-root refusal to WorkspaceRootMissingError", async () => {
    const reader = createHttpThreadWorkspaceReader(
      {
        url: "http://drafter:4200",
        token: "tok",
        fetch: scripted(422, {
          error: { kind: "request_error", message: "missing", details: { code: "workspace_root_missing", root: "draft", kind: "not_directory" } },
        }),
      },
      () => ({ excludeRootDirectories: [], expectedRootSymlinks: {}, root: "draft" }),
    )
    const error = await reader.read({ threadId: "t-1", sourceDigest: DIGEST }, AbortSignal.timeout(1_000)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WorkspaceRootMissingError)
    expect(error).toMatchObject({ root: "draft", kind: "not_directory" })
  })

  it("refuses an answer about another source", async () => {
    const reader = createHttpThreadWorkspaceReader(
      { url: "http://builder:4100", token: "tok", fetch: scripted(200, answer({ "a.ts": "" })) },
      () => ({ excludeRootDirectories: [".git"], expectedRootSymlinks: {} }),
    )
    await expect(
      reader.read({ threadId: "t-1", taskId: "cli-flags", sourceDigest: "f".repeat(64) }, AbortSignal.timeout(1_000)),
    ).rejects.toMatchObject({ code: "source_mismatch" })
  })

  it("refuses a malformed root before any request", async () => {
    const seen: Request[] = []
    const reader = createHttpThreadWorkspaceReader(
      { url: "http://w", token: "tok", fetch: scripted(200, answer({}), seen) },
      () => ({ excludeRootDirectories: [], expectedRootSymlinks: {}, root: "../x" }),
    )
    await expect(reader.read({ threadId: "t-1", sourceDigest: DIGEST }, AbortSignal.timeout(1_000))).rejects.toBeInstanceOf(
      InvalidWorkspaceRootError,
    )
    expect(seen).toEqual([])
  })
})
```

Update the file's imports (drop `fakeManagedApp`, `SandboxProvider`, `SandboxWorkspaceReader`, `mkdtemp`, `rm`, `tmpdir`, `join`, `readFileSync`, `targetSandboxPolicy`, whichever `pnpm lint`'s unused-import rule then names; import `createHttpThreadWorkspaceReader`) and the `target` helper to `({ threadId, taskId, sourceDigest: "d".repeat(64) })`. Delete `test/fake-managed-provider.ts` with the old block: `workspace-reader.test.ts` was its only importer (checked at #836's head).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/source-digest.test.ts test/workspace-reader.test.ts`
Expected: FAIL: modules and exports missing.

- [ ] **Step 3: The journal lookup**

```ts
// examples/software-factory/controller/src/lib/controller/source-digest.ts
/**
 * The events that record a capture handed to a worker, and the event that hands it to a
 * thread. Both spellings of the first: `*_manifest_written` (a manifest file, until PR 5) and
 * `*_source_staged` (an upload over the protocol, from PR 5), so a row journalled under either
 * reads the same.
 */
const ROLE = {
  builder: { written: ["builder_manifest_written", "builder_source_staged"], created: "thread_created" },
  drafter: { written: ["drafter_manifest_written", "drafter_source_staged"], created: "intake_thread_created" },
} as const

/**
 * The source digest the controller handed to `threadId`: the last capture written before the
 * event that created that thread. A later capture whose thread creation failed is never the
 * answer, and neither is another thread's. The worker's read must report this digest
 * (`readThreadWorkspace`'s `expectedSourceDigest`), or the answer is about another workspace.
 */
export function handedSourceDigest(
  events: readonly { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }[],
  threadId: string,
  role: keyof typeof ROLE,
): string {
  let last: unknown
  for (const event of events) {
    if ((ROLE[role].written as readonly string[]).includes(event.type)) last = event.payload.sourceDigest
    else if (event.type === ROLE[role].created && event.payload.threadId === threadId) {
      if (typeof last === "string" && /^[0-9a-f]{64}$/.test(last)) return last
      break
    }
  }
  throw new Error(
    `No ${role} source digest is journalled for thread ${threadId}: the controller cannot tell which workspace the worker must answer with`,
  )
}
```

- [ ] **Step 4: The reader**

In `worker/workspace-reader.ts`: drop the `withManagedWorkspaceReader` and `@b4run/workspace` type imports and `requireDirectory`; keep `WorkspaceReader`, `WorkspaceRootMissingError`, `InvalidWorkspaceRootError` and `rootSegments`; add `sourceDigest` to `WorkspaceTarget`; delete `runAsNonRoot` from `WorkspaceReadOptions` (the worker reads as its own app's identity); replace `ThreadWorkspaceSource` and `createThreadWorkspaceReader` with:

```ts
import { readThreadWorkspace, ThreadWorkspaceReadError } from "@b4run/cli/workspace"

export interface WorkspaceTarget {
  readonly threadId: string
  readonly taskId?: string
  /** The source the controller handed this thread: the worker's answer must carry it. */
  readonly sourceDigest: string
}

/** A worker as the reader reaches it: its Agent Protocol base URL and the worker token. */
export interface ThreadWorkspaceEndpoint {
  readonly url: string
  readonly token: string
  readonly fetch?: typeof fetch
}

/**
 * The real reader: `POST /threads/:id/workspace/inspect` on the worker that holds the thread.
 * The worker runs the read in a separate, networkless, read-only container that never touches
 * the thread's session, holding the thread's run slot, so it is safe between turns and refused
 * (`run_in_flight`) during one. This process holds only the URL, the token and the digest it
 * handed over: no installation store, no volume, no daemon of the worker's.
 */
export function createHttpThreadWorkspaceReader(
  endpoint: ThreadWorkspaceEndpoint,
  optionsFor: WorkspaceInspectionOptions,
): WorkspaceReader {
  return {
    async read(target, signal) {
      // Refused before a request: options that cannot be derived, or a malformed root.
      const options = optionsFor(target.taskId)
      const root = options.root
      if (root !== undefined) rootSegments(root)
      let answer: Awaited<ReturnType<typeof readThreadWorkspace>>
      try {
        answer = await readThreadWorkspace(
          endpoint.url,
          target.threadId,
          {
            ...(root !== undefined ? { root } : {}),
            excludeRootDirectories: options.excludeRootDirectories,
            expectedRootSymlinks: options.expectedRootSymlinks,
            ...(options.ignorePrefixes !== undefined ? { ignorePrefixes: options.ignorePrefixes } : {}),
            maxEntries: options.maxEntries ?? 10_000,
            maxFileBytes: options.maxFileBytes ?? 2 * 1024 * 1024,
            maxTotalBytes: options.maxTotalBytes ?? 16 * 1024 * 1024,
          },
          {
            headers: { authorization: `Bearer ${endpoint.token}` },
            signal,
            expectedSourceDigest: target.sourceDigest,
            ...(endpoint.fetch ? { fetch: endpoint.fetch } : {}),
          },
        )
      } catch (error) {
        // The one refusal that is a verdict on the thread's output: the worker reached the
        // workspace and found nothing (or not a directory) at `root`.
        if (
          root !== undefined &&
          error instanceof ThreadWorkspaceReadError &&
          error.code === "workspace_root_missing"
        )
          throw new WorkspaceRootMissingError(
            root,
            target.threadId,
            error.details.kind === "not_directory" ? "not_directory" : "absent",
          )
        throw error
      }
      // Re-prefixed exactly once: the worker's keys are relative to the root.
      const rootPrefix = root === undefined ? "" : `${root}/`
      return new Map(
        Object.entries(answer.inspection.files).map(([path, content]) => [`${rootPrefix}${path}`, content]),
      )
    },
  }
}
```

(`ignorePrefixes` keeps its meaning, prefixes of keys relative to `root`; the worker now applies them.) In `targets/workspace.ts`, `targetInspectionOptions` stops spreading `runAsNonRoot` (delete the `...(policy.security?.runAsNonRoot === undefined ? {} : { runAsNonRoot: ... })` lines and the comment above them) (`test/targets-workspace.test.ts` asserts nothing about `runAsNonRoot` and needs no change for this).

- [ ] **Step 5: The two callers pass the digest**

`verify.ts`, inside the existing `try` around the read, so a missing digest is `workspace_unreadable` like any read the controller cannot make:

```ts
    const sourceDigest = handedSourceDigest(ctx.store.events(id), threadId, "builder")
    observed = await ctx.workerFor(row).reader.read({ threadId, taskId: row.taskId, sourceDigest }, signal)
```

`intake.ts`, inside its read `try`:

```ts
    const sourceDigest = handedSourceDigest(ctx.store.events(id), threadId, "drafter")
    draft = await drafter.reader.read({ threadId, sourceDigest }, signal)
```

with `import { handedSourceDigest } from "./source-digest.js"` in both. `fake-workspace-reader.ts` accepts and ignores `sourceDigest` (its `read(target)` signature follows the interface; record it in `reads` only if a test wants it).

- [ ] **Step 6: Run the controller's tests**

Run: `pnpm --filter @b4-example/software-factory-controller test`
Expected: PASS once every `reader.read(...)` call site in tests passes a `sourceDigest` (typecheck names them: `pnpm --filter @b4-example/software-factory-controller typecheck`).

- [ ] **Step 7: Commit**

```bash
git add examples/software-factory/controller/src/lib/worker/workspace-reader.ts examples/software-factory/controller/src/lib/controller/source-digest.ts examples/software-factory/controller/src/lib/controller/verify.ts examples/software-factory/controller/src/lib/controller/intake.ts examples/software-factory/controller/src/lib/targets/workspace.ts examples/software-factory/controller/test
git commit -m "feat(software-factory): the controller reads a thread by URL, token and handed digest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17: App roots and the drafter image retire from the controller

**Files:**
- Modify: `examples/software-factory/controller/src/lib/config.ts` (`RETIRED`, `EnvSchema`, `WorkerEndpoint`, `DrafterEndpoint`, `FactoryConfig`, `loadConfig`)
- Modify: `examples/software-factory/controller/src/lib/controller/workers.ts` (no `appRoot`; `DRAFTER_UNCONFIGURED`)
- Modify: `examples/software-factory/controller/src/lib/runtime.ts:85-215` (readers by URL; `isDirectory` and `namingDrafterAppRoot` deleted)
- Create: `examples/software-factory/controller/test/no-worker-filesystem.test.ts`
- Modify: `examples/software-factory/controller/test/config.test.ts`, `workers.test.ts`, `runtime.test.ts`, `fake-worker-map.ts`, `serve-controller.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// examples/software-factory/controller/test/no-worker-filesystem.test.ts
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC = fileURLToPath(new URL("../src", import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : []
  })
}

/**
 * The controller reaches a worker by URL and token only. No source file may open a worker's
 * installation store or read its managed volumes directly: that would put the controller back
 * on the worker's host, filesystem and Docker daemon.
 */
describe("the controller has no path to a worker's filesystem", () => {
  for (const pattern of [
    /withManagedWorkspaceReader|openManagedWorkspaceReader/,
    /from "@b4run\/sqlite-storage"/,
    /openWorkspaceInstallation/,
    /\.b4\/workspaces/,
  ])
    it(`no source matches ${pattern}`, () => {
      const hits = sources(SRC).filter((file) => pattern.test(readFileSync(file, "utf8")))
      expect(hits).toEqual([])
    })
})
```

(Comments count: a comment that still describes reading a worker's store is stale after this PR, so reword it rather than weaken the test. The retired variables are pinned by `config.test.ts`, not here.)

In `test/config.test.ts`:

```ts
  for (const name of ["FACTORY_BUILDER_APP_ROOT", "FACTORY_DRAFTER_APP_ROOT", "FACTORY_DRAFTER_IMAGE"])
    it(`refuses ${name} by name: the controller reads workers over HTTP`, () => {
      expect(() => loadConfig({ ...baseEnv(), [name]: "/somewhere" })).toThrow(new RegExp(`${name} is retired`))
    })

  it("needs only a URL per worker, and the manifest directory it writes into", () => {
    const config = loadConfig({ ...baseEnv(), FACTORY_DRAFTER_URL: "http://127.0.0.1:4200", FACTORY_DRAFTER_MANIFEST_DIR: "/m/d" })
    expect(config.builder).toEqual({ url: expect.any(String), route: "/build#agent", manifestDir: expect.any(String) })
    expect(config.drafter).toEqual({ url: "http://127.0.0.1:4200", route: "/intake#agent", manifestDir: "/m/d" })
    expect(() => loadConfig({ ...baseEnv(), FACTORY_DRAFTER_URL: "http://127.0.0.1:4200" })).toThrow(
      /FACTORY_DRAFTER_MANIFEST_DIR is required with FACTORY_DRAFTER_URL/,
    )
  })
```

Then rewrite the file's environments and cases (line numbers at #836's head):
- `base` and `pair`: replace `FACTORY_BUILDER_APP_ROOT` with `FACTORY_BUILDER_MANIFEST_DIR: "/m/b"` (`base`) and `"/srv/builder/manifests"` (`pair`); drop `DRAFTER_IMAGE` from the import (`:3`).
- "is one worker for every target, with its manifest directory defaulted under its app root" (`:40`) becomes "is one worker for every target, at its URL, writing into its manifest directory", asserting `config.builder` equals `{ url: "http://127.0.0.1:4100", route: DEFAULT_WORKER_ROUTE, manifestDir: "/srv/builder/manifests" }`.
- "still needs both halves of the pair" (`:76`) becomes "needs the manifest directory with the URL": dropping `FACTORY_BUILDER_MANIFEST_DIR` from `pair` throws `/FACTORY_BUILDER_MANIFEST_DIR is required/`.
- Delete "refuses a drafter app root that is also the builder's" (`:83`) and "pins the default image to the drafter's own" (`:245`).
- "leaves the drafter unset and defaults the image to the pinned digest" (`:158`): drop the `drafterImage` assertion and rename to "leaves the drafter unset".
- "takes the drafter pair, defaulting the route and the manifest directory" (`:167`): the environment is `FACTORY_DRAFTER_URL` plus `FACTORY_DRAFTER_MANIFEST_DIR` (no app root, no image), and the expected `drafter` has no `appRoot`.
- "refuses a drafter knob without the drafter, naming it" (`:194`): the knobs are `FACTORY_DRAFTER_ROUTE` and `FACTORY_DRAFTER_MANIFEST_DIR`, the message ends "set FACTORY_DRAFTER_URL, or unset it" / "or unset them".
- "refuses half a drafter" (`:212`) becomes the "needs only a URL per worker" case above.
- "rejects a blank or malformed drafter value under its name" (`:222`): drop the `FACTORY_DRAFTER_APP_ROOT` and `FACTORY_DRAFTER_IMAGE` lines, keep the URL and route ones.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/no-worker-filesystem.test.ts test/config.test.ts`
Expected: FAIL: `runtime.ts` still names `FACTORY_DRAFTER_APP_ROOT`; the retired variables are accepted.

- [ ] **Step 3: Implement**

`config.ts`:
- `RETIRED` gains
  ```ts
  FACTORY_BUILDER_APP_ROOT:
    "the controller reads the builder's threads over its URL (sandbox.workspaceRead), not through its app root",
  FACTORY_DRAFTER_APP_ROOT:
    "the controller reads the drafter's threads over its URL (sandbox.workspaceRead), not through its app root",
  FACTORY_DRAFTER_IMAGE:
    "only the drafter needs its image; the controller no longer constructs a drafter provider",
  ```
- `EnvSchema` loses `FACTORY_BUILDER_APP_ROOT`, `FACTORY_DRAFTER_APP_ROOT`, `FACTORY_DRAFTER_IMAGE`; `DRAFTER_IMAGE` is deleted.
- `WorkerEndpoint` and `DrafterEndpoint` lose `appRoot`; `FactoryConfig` loses `drafterImage`; `defaultManifestDir` is deleted.
- `loadConfig`: `FACTORY_WORKER_URL` is required (message `"FACTORY_WORKER_URL is required"`), `FACTORY_BUILDER_MANIFEST_DIR` is required with it (`"FACTORY_BUILDER_MANIFEST_DIR is required: the directory the builder was started with"`); the drafter is configured by `FACTORY_DRAFTER_URL`, and `FACTORY_DRAFTER_MANIFEST_DIR` is required with it (`"FACTORY_DRAFTER_MANIFEST_DIR is required with FACTORY_DRAFTER_URL"`); the stray-variable check lists `FACTORY_DRAFTER_ROUTE` and `FACTORY_DRAFTER_MANIFEST_DIR`; the same-app-root refusal is deleted (each worker's store is its own business now).

`workers.ts`: `TargetWorker` loses `appRoot`; `DRAFTER_UNCONFIGURED = "intake is not configured: set FACTORY_DRAFTER_URL and FACTORY_DRAFTER_MANIFEST_DIR"`; `forTarget` stops setting `appRoot`.

`runtime.ts`: delete the drafter app-root directory check (`:92-95`), `isDirectory`, `namingDrafterAppRoot`, and the two `*SandboxProvider` imports; the readers become

```ts
  function builderReader(entry: WorkerEndpoint): WorkspaceReader {
    return createHttpThreadWorkspaceReader(
      { url: entry.url, token: config.workerToken },
      (taskId) => targetInspectionOptions(loadTask(requireTaskId(taskId))),
    )
  }

  function drafterReader(entry: DrafterEndpoint): WorkspaceReader {
    return createHttpThreadWorkspaceReader(
      { url: entry.url, token: config.workerToken },
      () => ({ ...drafterInspectionOptions(), root: "draft" }),
    )
  }
```

Tests: `fake-worker-map.ts` and every `fakeWorkerMap({ builder: { ..., appRoot } })` drop `appRoot`; `serve-controller.ts`'s `FACTORY_ENV` drops the two app roots and sets `FACTORY_BUILDER_MANIFEST_DIR` and `FACTORY_DRAFTER_MANIFEST_DIR` to directories under its temp dir; `workers.test.ts` and `runtime.test.ts` follow.

- [ ] **Step 4: Run the controller's unit tests**

Run: `pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller test`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src examples/software-factory/controller/test
git commit -m "feat(software-factory): the controller needs no worker app root or drafter image

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 18: The Docker lanes read over HTTP, and the README

The spec's proof: "the controller runs with no path to the worker's `.b4`". The served builder and drafter keep their isolated app roots (tests may peek there to assert what the worker recorded), and the controller side of every lane is built from `served.url` and the token only.

**Files:**
- Modify: `examples/software-factory/controller/test/end-to-end.integration.test.ts:73-77, 122-140`
- Modify: `examples/software-factory/controller/test/devkit-end-to-end.integration.test.ts`, `drafter-end-to-end.integration.test.ts` (their readers)
- Modify: `examples/software-factory/README.md`

- [ ] **Step 1: Point the lanes' readers at the served workers**

In `end-to-end.integration.test.ts` the reader becomes

```ts
  const reader = () =>
    createHttpThreadWorkspaceReader(
      { url: served.url, token: TEST_WORKER_TOKEN },
      () => targetInspectionOptions(task),
    )
```

the `fakeWorkerMap` builder entry loses `appRoot`, and the read after the turn passes the digest the controller journalled:

```ts
  const sourceDigest = handedSourceDigest(factory.events(id), threadId, "builder")
  const observed = await reader().read({ threadId, taskId: "cli-flags", sourceDigest }, AbortSignal.timeout(120_000))
```

Add, right after it, the proof that the controller needed nothing of the worker's filesystem and that the worker refuses a read without the token:

```ts
  // The controller half of this lane was built from `served.url` and the token alone; the
  // worker's own port refuses the same read without the token.
  const bare = await fetch(`${served.url}/threads/${encodeURIComponent(threadId)}/workspace/inspect`, {
    method: "POST",
    body: "{}",
  })
  expect(bare.status).toBe(403)
```

Make the same reader change in `devkit-end-to-end.integration.test.ts` and in `drafter-end-to-end.integration.test.ts` (root `"draft"`, role `"drafter"`). Those lanes, `end-to-end.integration.test.ts`, `targets-workspace.test.ts` and `runtime.ts` (changed in Task 17) were the only importers of `builderSandboxProvider` and `drafterSandboxProvider` (checked at #836's head), so delete both functions and their imports from `controller/src/lib/targets/workspace.ts` now, delete the `targets-workspace.test.ts` cases that construct them, and add `controller/src/lib/targets/workspace.ts` to this task's commit.

- [ ] **Step 2: Run the Docker lane**

Run: `pnpm --filter @b4-example/software-factory-controller target:prepare cli-flags && pnpm --filter @b4-example/software-factory-controller target:prepare devkit && FACTORY_BUILDER_LANE=1 pnpm --filter @b4-example/software-factory-controller test:sandbox`
Expected: PASS. A `workspace_unreadable` journal line with `source_mismatch` would mean the handed digest and the worker's record differ: stop and investigate (it is the check doing its job).

- [ ] **Step 3: README**

In `examples/software-factory/README.md`: delete `FACTORY_BUILDER_APP_ROOT`, `FACTORY_DRAFTER_APP_ROOT` and `FACTORY_DRAFTER_IMAGE` from the controller's table and quickstart; mark `FACTORY_BUILDER_MANIFEST_DIR` and `FACTORY_DRAFTER_MANIFEST_DIR` required on the controller (no default); remove the rule that no two workers share an app root and the drafter-image equality rule; and replace the paragraph on how the controller reads a thread with:

```md
**How the controller reads a thread.** Each worker sets `sandbox.workspaceRead: "http"`. The
controller reads a builder's candidate, or a drafter's `draft/`, with
`POST /threads/:id/workspace/inspect` on that worker's URL, sending the worker token and
checking that the answer's `sourceDigest` is the digest it journalled when it handed the thread
its workspace. The worker runs the read in a separate, networkless, read-only container and
refuses it while a turn runs. The controller holds no worker app root, opens no worker
installation store, and needs Docker only for its own verifier.
```

- [ ] **Step 4: Commit**

```bash
git add examples/software-factory/controller/test examples/software-factory/controller/src/lib/targets/workspace.ts examples/software-factory/README.md
git commit -m "test(software-factory): the lanes read workers over HTTP with no path to their .b4

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 19: The PR 3 gate

- [ ] **Step 1:** `pnpm lint` → exit 0.
- [ ] **Step 2:** `pnpm --filter "@b4-example/software-factory-*" typecheck && pnpm --filter "@b4-example/software-factory-*" test` → exit 0.
- [ ] **Step 3:** the `sandbox-docker` job's software-factory lines (`.github/workflows/ci.yml`) → exit 0. No `ci.yml` change in this PR (the builder's `check`/`build` lines still set `FACTORY_BUILDER_MANIFEST_DIR`, which the builder still reads until PR 5).
- [ ] **Step 4:** `node scripts/check-changesets.mjs` → passes with none.
- [ ] **Step 5:** `docs/superpowers/runbooks/software-factory-rung2-developer-guide.md`: `grep -n "APP_ROOT\|DRAFTER_IMAGE" docs/superpowers/runbooks/software-factory-rung2-developer-guide.md` and update each hit to the URL-only topology (a runbook-only follow-up commit is fine; it rides this PR).

---

# PR 4: the workspace travels with thread creation

```bash
git fetch origin
git switch -c blove/staged-workspaces origin/main    # PR 2 merged
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm --filter @b4run/cli... build
```

The protocol, end to end: the creator uploads the files as a `SourceBundle` (`PUT /workspace/sources/<source digest>`), then creates the thread naming that digest and the definition's small parts (`POST /threads { metadata, workspace: { sourceDigest, environmentLinks?, baseline? } }`). The worker verifies the upload byte for byte against its digest, keeps it in its installation's content store, checks the named definition before any thread row exists, records the thread's staged reference beside the row, and at the thread's first admission hands the verified `CapturedWorkspaceDefinition` to the app's resolver as `thread.staged`. The recorded intent's `sourceDigest` is the uploaded digest when the resolver returns it. D5, D6, D7, D12.

### Task 20: `StagedWorkspaceReference`, its verifiers, and `WorkspaceResolverInput.staged`

**Files:**
- Modify: `packages/workspace/src/managed-workspace.ts` (the type)
- Modify: `packages/workspace/src/managed-workspace-node.ts` (`verifyStagedWorkspaceReference`, `stagedWorkspaceDefinition`)
- Modify: `packages/workspace/src/sandbox-types.ts` (`WorkspaceResolverInput.staged`, `SandboxConfig.stagedWorkspaces`)
- Modify: `packages/workspace/src/index.ts`, `packages/workspace/src/node.ts`
- Create: `packages/workspace/test/staged-workspace.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/workspace/test/staged-workspace.test.ts
import { describe, expect, it } from "vitest"
import {
  createSourceBundle,
  stagedWorkspaceDefinition,
  verifyCapturedWorkspaceDefinition,
  verifyStagedWorkspaceReference,
} from "../src/node.ts"

const bundle = createSourceBundle([
  { path: "src/a.ts", bytes: new TextEncoder().encode("a"), executable: false },
])

describe("verifyStagedWorkspaceReference", () => {
  it("accepts a digest alone and normalizes the links", () => {
    expect(verifyStagedWorkspaceReference({ sourceDigest: bundle.digest })).toEqual({
      sourceDigest: bundle.digest,
      environmentLinks: [],
    })
    expect(
      verifyStagedWorkspaceReference({
        sourceDigest: bundle.digest,
        environmentLinks: [
          { path: "z", target: "/opt/z" },
          { path: "node_modules", target: "/opt/deps" },
        ],
        baseline: "git",
      }),
    ).toEqual({
      sourceDigest: bundle.digest,
      environmentLinks: [
        { path: "node_modules", target: "/opt/deps" },
        { path: "z", target: "/opt/z" },
      ],
      baseline: "git",
    })
  })

  for (const [label, value] of Object.entries({
    "an unknown key": { sourceDigest: bundle.digest, extra: 1 },
    "a prefixed digest": { sourceDigest: `sha256:${bundle.digest}` },
    "a relative link target": { sourceDigest: bundle.digest, environmentLinks: [{ path: "a", target: "rel" }] },
    "another baseline": { sourceDigest: bundle.digest, baseline: "svn" },
    "no digest": {},
    "an array": [bundle.digest],
  }))
    it(`refuses ${label}`, () => {
      expect(() => verifyStagedWorkspaceReference(value)).toThrow()
    })
})

describe("stagedWorkspaceDefinition", () => {
  it("is the captured definition of the held source with the reference's links", () => {
    const definition = stagedWorkspaceDefinition(
      { sourceDigest: bundle.digest, environmentLinks: [{ path: "node_modules", target: "/opt/deps" }] },
      bundle,
    )
    expect(definition).toEqual(
      verifyCapturedWorkspaceDefinition({
        version: 1,
        source: bundle,
        environmentLinks: [{ path: "node_modules", target: "/opt/deps" }],
      }),
    )
  })

  it("refuses a source that is not the one named", () => {
    const other = createSourceBundle([
      { path: "b", bytes: new TextEncoder().encode("b"), executable: false },
    ])
    expect(() => stagedWorkspaceDefinition({ sourceDigest: bundle.digest }, other)).toThrow(
      /does not match/,
    )
  })

  it("refuses a link that collides with a file", () => {
    expect(() =>
      stagedWorkspaceDefinition(
        { sourceDigest: bundle.digest, environmentLinks: [{ path: "src/a.ts", target: "/x" }] },
        bundle,
      ),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4run/workspace exec vitest run test/staged-workspace.test.ts`
Expected: FAIL: `verifyStagedWorkspaceReference` is not exported.

- [ ] **Step 3: Implement**

`managed-workspace.ts`, after `CapturedWorkspaceDefinition`:

```ts
/**
 * What `POST /threads` names to give a new thread a workspace staged with
 * `PUT /workspace/sources/:digest` (`sandbox.stagedWorkspaces`). The files are
 * the held source; the links and baseline, which the source digest does not
 * cover, travel here.
 */
export interface StagedWorkspaceReference {
  readonly sourceDigest: string
  readonly environmentLinks?: readonly { readonly path: string; readonly target: string }[]
  readonly baseline?: "git"
}
```

`managed-workspace-node.ts` (it already has `shape`, `digest`, `links` and `baseline`), importing `StagedWorkspaceReference` and `SourceBundle` types:

```ts
/** Strictly: own keys only, a bare 64-hex digest, links checked and sorted, `baseline` only `"git"`. */
export function verifyStagedWorkspaceReference(value: unknown): StagedWorkspaceReference {
  const input = shape(value, ["sourceDigest"], ["environmentLinks", "baseline"])
  return Object.freeze({
    sourceDigest: digest(input.sourceDigest),
    environmentLinks: links("environmentLinks" in input ? input.environmentLinks : [], false),
    ...baseline(input),
  })
}

/**
 * The definition a staged reference names, over the source the worker holds:
 * verified byte for byte (the bundle against its digest) and as a whole (no link
 * colliding with a file or with `.git`).
 */
export function stagedWorkspaceDefinition(
  reference: StagedWorkspaceReference,
  source: SourceBundle,
): CapturedWorkspaceDefinition {
  const verified = verifyStagedWorkspaceReference(reference)
  if (source.digest !== verified.sourceDigest)
    throw new Error(
      `Staged workspace source ${source.digest} does not match its reference ${verified.sourceDigest}`,
    )
  return verifyCapturedWorkspaceDefinition({
    version: 1,
    source,
    environmentLinks: verified.environmentLinks ?? [],
    ...(verified.baseline ? { baseline: verified.baseline } : {}),
  })
}
```

`sandbox-types.ts`, in `WorkspaceResolverInput` after `metadata`:

```ts
  /**
   * The workspace this thread was created with, when the app sets
   * `sandbox.stagedWorkspaces` and the creator uploaded one: the held source,
   * verified against its digest, with the links and baseline named at create.
   * Absent otherwise. Return it as the thread's workspace to serve exactly what
   * the creator staged. Like `metadata`, it is the creator's choice: a resolver
   * decides whether to accept it, and the app's thread-access policy decides who
   * may create (`requestedWorkspace`).
   */
  readonly staged?: CapturedWorkspaceDefinition
```

and in `SandboxConfig` after `workspaceRead`:

```ts
  /**
   * Accept a thread's workspace at creation: `PUT /workspace/sources/:digest`
   * stages a `SourceBundle`, and `POST /threads` with `workspace` names it; the
   * resolver receives it as `thread.staged`. `true`, or limits: `maxUploadBytes`
   * (default and ceiling 96 MiB) and `retentionMs` (how long an unreferenced
   * upload is kept; default 24 hours, 60 seconds to 30 days). Needs a resolver
   * (`thread`, or a function `workspace`) and a thread-access policy: `b4 check`,
   * `b4 build` and boot refuse it without one. `maxStagedBytes` (default 1 GiB,
   * at most 16 GiB) caps the stored bytes of every uploaded source together.
   */
  readonly stagedWorkspaces?:
    | boolean
    | {
        readonly maxUploadBytes?: number
        readonly retentionMs?: number
        readonly maxStagedBytes?: number
      }
```

`index.ts`: add `StagedWorkspaceReference` to the `./managed-workspace.js` type exports. `node.ts`: add `stagedWorkspaceDefinition` and `verifyStagedWorkspaceReference` to the `./managed-workspace-node.js` exports.

- [ ] **Step 4: Run the package's tests**

Run: `pnpm --filter @b4run/workspace test && pnpm --filter @b4run/workspace build`
Expected: PASS; `dist/` rebuilt for the dependents.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace/src/managed-workspace.ts packages/workspace/src/managed-workspace-node.ts packages/workspace/src/sandbox-types.ts packages/workspace/src/index.ts packages/workspace/src/node.ts packages/workspace/test/staged-workspace.test.ts
git commit -m "feat(workspace): staged workspace references, and thread.staged for resolvers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 21: The installation keeps uploads and thread references, and reclaims what nothing references

**Files:**
- Create: `packages/sqlite-storage/src/workspace/staged-source-store.ts`
- Modify: `packages/sqlite-storage/src/workspace/installation.ts` (owner: ensure schema; `staged` on `WorkspaceInstallation`)
- Modify: `packages/sqlite-storage/src/index.ts`
- Create: `packages/sqlite-storage/test/workspace-staged-sources.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/sqlite-storage/test/workspace-staged-sources.test.ts
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import { openWorkspaceInstallation, WorkspaceStagedSourceError } from "../src/index.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function installation() {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-staged-"))
  roots.push(appRoot)
  return { appRoot, installation: openWorkspaceInstallation(appRoot) }
}
const Q = 64 * 1024 * 1024
const bundle = (text: string) =>
  createSourceBundle([{ path: "a.txt", bytes: new TextEncoder().encode(text), executable: false }])

describe("the staged source store", () => {
  it("keeps an upload, answers held for the same bytes, and serves it from the content store", async () => {
    const { installation: i } = await installation()
    const a = bundle("a")
    expect(i.staged.upload(a, 1_000, Q)).toBe("created")
    expect(i.staged.upload(a, 2_000, Q)).toBe("held")
    expect(i.staged.holds(a.digest)).toBe(true)
    expect(i.sources.get(a.digest)).toEqual(a)
    i.close()
  })

  it("attaches a held source to a thread once, and refuses one it does not hold", async () => {
    const { installation: i } = await installation()
    const a = bundle("a")
    expect(() => i.staged.attach("t-1", { sourceDigest: a.digest })).toThrow(WorkspaceStagedSourceError)
    i.staged.upload(a, 1_000, Q)
    i.staged.attach("t-1", { sourceDigest: a.digest, baseline: "git" })
    expect(i.staged.get("t-1")).toEqual({ sourceDigest: a.digest, environmentLinks: [], baseline: "git" })
    const again = (() => {
      try {
        i.staged.attach("t-1", { sourceDigest: a.digest })
      } catch (error) {
        return error
      }
    })()
    expect(again).toMatchObject({ code: "already_staged" })
    i.staged.detach("t-1")
    expect(i.staged.get("t-1")).toBeUndefined()
    i.close()
  })

  it("reclaims an unreferenced upload only after the window, and never a referenced one", async () => {
    const { installation: i } = await installation()
    const [fresh, old, pinned, inUse] = [bundle("fresh"), bundle("old"), bundle("pinned"), bundle("in use")]
    i.staged.upload(old, 1_000, Q)
    i.staged.upload(pinned, 1_000, Q)
    i.staged.upload(inUse, 1_000, Q)
    i.staged.upload(fresh, 9_000, Q)
    i.staged.attach("t-pinned", { sourceDigest: pinned.digest })
    const removed = i.staged.reclaim(5_000, new Set([inUse.digest]))
    expect(removed).toEqual([old.digest])
    expect(i.staged.holds(old.digest)).toBe(false)
    for (const kept of [fresh, pinned, inUse]) expect(i.staged.holds(kept.digest)).toBe(true)
    i.close()
  })

  it("refuses new bytes past the staged quota, but not a re-upload of held ones", async () => {
    const { installation: i } = await installation()
    const a = bundle("a")
    i.staged.upload(a, 1_000, Q)
    const size = JSON.stringify(a).length
    const again = (() => {
      try {
        i.staged.upload(bundle("b"), 1_000, size + 10)
      } catch (error) {
        return error
      }
    })()
    expect(again).toMatchObject({ code: "quota_exceeded" })
    expect(i.staged.upload(a, 2_000, size)).toBe("held")
    i.close()
  })

  it("lists the threads that have a staged reference", async () => {
    const { installation: i } = await installation()
    const a = bundle("a")
    i.staged.upload(a, 1_000, Q)
    i.staged.attach("t-2", { sourceDigest: a.digest })
    i.staged.attach("t-1", { sourceDigest: a.digest })
    expect(i.staged.threads()).toEqual(["t-1", "t-2"])
    i.close()
  })

  it("reclaims an unreferenced source that was never uploaded at once (an orphan row)", async () => {
    const { installation: i } = await installation()
    const orphan = bundle("orphan")
    i.sources.put(orphan)
    expect(i.staged.reclaim(0, new Set())).toEqual([orphan.digest])
    i.close()
  })

  it("persists across reopen, and adds its tables to an installation that predates them", async () => {
    const { appRoot, installation: first } = await installation()
    const a = bundle("a")
    first.staged.upload(a, 1_000, Q)
    first.staged.attach("t-1", { sourceDigest: a.digest })
    first.close()
    const reopened = openWorkspaceInstallation(appRoot)
    expect(reopened.staged.get("t-1")).toEqual({ sourceDigest: a.digest, environmentLinks: [] })
    reopened.close()
    const db = new DatabaseSync(join(appRoot, ".b4", "workspaces", "state.sqlite"))
    db.exec("DROP TABLE workspace_staged_schema; DROP TABLE workspace_source_uploads; DROP TABLE workspace_thread_staged")
    db.close()
    const upgraded = openWorkspaceInstallation(appRoot)
    expect(upgraded.staged.get("t-1")).toBeUndefined()
    upgraded.staged.upload(bundle("b"), 1_000, Q)
    upgraded.close()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4run/sqlite-storage exec vitest run test/workspace-staged-sources.test.ts`
Expected: FAIL: `staged` is undefined on the installation.

- [ ] **Step 3: The store**

```ts
// packages/sqlite-storage/src/workspace/staged-source-store.ts
import type { DatabaseSync } from "node:sqlite"
import type { SourceBundle, StagedWorkspaceReference } from "@b4run/workspace"
import { verifyStagedWorkspaceReference } from "@b4run/workspace/node"
import type { WorkspaceSourceStore } from "./source-store.js"

/** A staging request the store refuses: the source is not held, or the thread already has one. */
export class WorkspaceStagedSourceError extends Error {
  constructor(
    readonly code: "not_held" | "already_staged" | "quota_exceeded",
    message: string,
  ) {
    super(message)
    this.name = "WorkspaceStagedSourceError"
  }
}

/**
 * Uploaded sources and the workspace each thread was created with
 * (`sandbox.stagedWorkspaces`). The bundles themselves live in the content
 * store (`workspace_sources`); this keeps when each was uploaded and which
 * thread names which, in the same database, so a reclaim sees every reference
 * at once.
 */
export interface WorkspaceStagedSourceStore {
  /**
   * Keep a verified bundle; `held` when these bytes were kept already (nothing is
   * rewritten or re-parsed then: equal digests are equal bytes). Refreshes its upload
   * time either way. Refuses (`quota_exceeded`) new bytes that would take the uploaded
   * sources past `maxStagedBytes` of stored payload.
   */
  upload(bundle: SourceBundle, now: number, maxStagedBytes: number): "created" | "held"
  /** Every thread with a staged reference, for the boot sweep of deleted threads. */
  threads(): readonly string[]
  /** Whether the content store holds this digest (cheap: no payload is read). */
  holds(digest: string): boolean
  /** Record the workspace a new thread was created with. Refuses a source not held, and a second record. */
  attach(threadId: string, reference: StagedWorkspaceReference): void
  get(threadId: string): StagedWorkspaceReference | undefined
  detach(threadId: string): void
  /**
   * Delete every held source nothing references: not in `referenced` (the
   * caller's associations and static definition), not named by a thread here,
   * and not uploaded at or after `uploadedBefore`. A source never uploaded (an
   * orphan admission row) has no upload time, so it goes at once when
   * unreferenced. Returns the digests removed.
   */
  reclaim(uploadedBefore: number, referenced: ReadonlySet<string>): readonly string[]
}

const MAX_REFERENCE_BYTES = 256 * 1024
let nextSavepoint = 0

function savepoint<T>(db: DatabaseSync, operation: () => T): T {
  const name = `b4_workspace_staged_${++nextSavepoint}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const result = operation()
    db.exec(`RELEASE ${name}`)
    return result
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO ${name}`)
      db.exec(`RELEASE ${name}`)
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Workspace staged source rollback failed")
    }
    throw error
  }
}

/** Owner-only and additive, like the thread sandbox tables: an older installation gains them. */
export function ensureWorkspaceStagedSourceSchema(db: DatabaseSync): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace_staged_schema','workspace_source_uploads','workspace_thread_staged')",
    )
    .all()
  if (tables.length === 0) {
    savepoint(db, () =>
      db.exec(`CREATE TABLE workspace_staged_schema(version INTEGER PRIMARY KEY);
   INSERT INTO workspace_staged_schema VALUES (1);
   CREATE TABLE workspace_source_uploads(digest TEXT PRIMARY KEY NOT NULL, uploaded_at INTEGER NOT NULL);
   CREATE TABLE workspace_thread_staged(thread_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);`),
    )
  } else if (tables.length !== 3) throw new Error("Incomplete workspace staged source schema")
  const versions = db.prepare("SELECT version FROM workspace_staged_schema").all()
  if (versions.length !== 1 || versions[0]?.version !== 1)
    throw new Error("Unsupported workspace staged source schema version")
}

function threadIdOf(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error("Invalid staged workspace thread id")
  return value
}

function timeOf(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid staged workspace time")
  return value
}

export function makeWorkspaceStagedSourceStore(
  db: DatabaseSync,
  sources: WorkspaceSourceStore,
): WorkspaceStagedSourceStore {
  const held = db.prepare("SELECT 1 AS one FROM workspace_sources WHERE digest=?")
  const stagedBytes = db.prepare(
    "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes FROM workspace_sources WHERE digest IN (SELECT digest FROM workspace_source_uploads)",
  )
  const everyStagedThread = db.prepare("SELECT thread_id FROM workspace_thread_staged ORDER BY thread_id")
  const upsertUpload = db.prepare(
    "INSERT INTO workspace_source_uploads(digest, uploaded_at) VALUES (?,?) ON CONFLICT(digest) DO UPDATE SET uploaded_at=excluded.uploaded_at",
  )
  const selectStaged = db.prepare("SELECT payload FROM workspace_thread_staged WHERE thread_id=?")
  const insertStaged = db.prepare("INSERT INTO workspace_thread_staged(thread_id, payload) VALUES (?,?)")
  const deleteStaged = db.prepare("DELETE FROM workspace_thread_staged WHERE thread_id=?")
  const everyStaged = db.prepare("SELECT payload FROM workspace_thread_staged")
  const everySource = db.prepare("SELECT digest FROM workspace_sources ORDER BY digest")
  const freshUploads = db.prepare("SELECT digest FROM workspace_source_uploads WHERE uploaded_at >= ?")
  const deleteSource = db.prepare("DELETE FROM workspace_sources WHERE digest=?")
  const deleteUpload = db.prepare("DELETE FROM workspace_source_uploads WHERE digest=?")
  const deleteOrphanUploads = db.prepare(
    "DELETE FROM workspace_source_uploads WHERE digest NOT IN (SELECT digest FROM workspace_sources)",
  )
  function parse(payload: unknown): StagedWorkspaceReference {
    if (typeof payload !== "string" || Buffer.byteLength(payload) > MAX_REFERENCE_BYTES)
      throw new Error("Corrupt staged workspace reference")
    const reference = verifyStagedWorkspaceReference(JSON.parse(payload))
    if (JSON.stringify(reference) !== payload)
      throw new Error("Noncanonical staged workspace reference")
    return reference
  }
  function holds(digest: string): boolean {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
      throw new Error("Invalid workspace source digest")
    return held.get(digest) !== undefined
  }
  return {
    upload(bundle, now, maxStagedBytes) {
      const at = timeOf(now)
      return savepoint(db, () => {
        if (holds(bundle.digest)) {
          // Equal digests are equal bytes: refresh the window and rewrite nothing.
          upsertUpload.run(bundle.digest, at)
          return "held"
        }
        const size = Buffer.byteLength(JSON.stringify(bundle), "utf8")
        const current = Number(stagedBytes.get()?.bytes ?? 0)
        if (current + size > maxStagedBytes)
          throw new WorkspaceStagedSourceError(
            "quota_exceeded",
            `Staging ${size} bytes would exceed the ${maxStagedBytes}-byte staged quota (${current} held)`,
          )
        // Verifies the bundle and stores its canonical JSON.
        sources.put(bundle)
        upsertUpload.run(bundle.digest, at)
        return "created"
      })
    },
    threads() {
      return everyStagedThread.all().map((row) => String(row.thread_id))
    },
    holds,
    attach(threadId, input) {
      const id = threadIdOf(threadId)
      const reference = verifyStagedWorkspaceReference(input)
      const payload = JSON.stringify(reference)
      if (Buffer.byteLength(payload) > MAX_REFERENCE_BYTES)
        throw new Error("Staged workspace reference is too large")
      savepoint(db, () => {
        if (!holds(reference.sourceDigest))
          throw new WorkspaceStagedSourceError(
            "not_held",
            `Workspace source ${reference.sourceDigest} is not held: upload it first`,
          )
        if (selectStaged.get(id))
          throw new WorkspaceStagedSourceError("already_staged", `Thread ${id} already has a staged workspace`)
        insertStaged.run(id, payload)
      })
    },
    get(threadId) {
      const row = selectStaged.get(threadIdOf(threadId))
      return row ? parse(row.payload) : undefined
    },
    detach(threadId) {
      deleteStaged.run(threadIdOf(threadId))
    },
    reclaim(uploadedBefore, referenced) {
      const cutoff = timeOf(uploadedBefore)
      return savepoint(db, () => {
        const keep = new Set(referenced)
        for (const row of everyStaged.all()) keep.add(parse(row.payload).sourceDigest)
        for (const row of freshUploads.all(cutoff)) keep.add(String(row.digest))
        const removed: string[] = []
        for (const row of everySource.all()) {
          const digest = String(row.digest)
          if (keep.has(digest)) continue
          deleteSource.run(digest)
          deleteUpload.run(digest)
          removed.push(digest)
        }
        deleteOrphanUploads.run()
        return removed
      })
    },
  }
}
```

- [ ] **Step 4: Wire it into the installation**

`installation.ts`: import `ensureWorkspaceStagedSourceSchema`, `makeWorkspaceStagedSourceStore` and `type WorkspaceStagedSourceStore`; add to `WorkspaceInstallation`

```ts
  /** Uploaded sources and each thread's staged reference (`sandbox.stagedWorkspaces`). */
  readonly staged: WorkspaceStagedSourceStore
```

in `openWorkspaceInstallation`, after `ensureWorkspaceThreadSandboxSchema(stateDb)`: `ensureWorkspaceStagedSourceSchema(stateDb)`, and after `const sources = ...`: `const staged = makeWorkspaceStagedSourceStore(stateDb, sources)`; in the returned object, after `threadSandboxes`:

```ts
      staged: {
        upload(bundle, now, maxStagedBytes) {
          requireOpen()
          return staged.upload(bundle, now, maxStagedBytes)
        },
        threads() {
          requireOpen()
          return staged.threads()
        },
        holds(digest) {
          requireOpen()
          return staged.holds(digest)
        },
        attach(threadId, reference) {
          requireOpen()
          staged.attach(threadId, reference)
        },
        get(threadId) {
          requireOpen()
          return staged.get(threadId)
        },
        detach(threadId) {
          requireOpen()
          staged.detach(threadId)
        },
        reclaim(uploadedBefore, referenced) {
          requireOpen()
          return staged.reclaim(uploadedBefore, referenced)
        },
      },
```

The read-only `openWorkspaceInstallationReader` is unchanged: it never needs the tables, and `validateState` does not require them (an older reader keeps working against a newer store).

`index.ts`:

```ts
export {
  WorkspaceStagedSourceError,
  type WorkspaceStagedSourceStore,
} from "./workspace/staged-source-store.js"
```

- [ ] **Step 5: Run the package's tests, and rebuild**

Run: `pnpm --filter @b4run/sqlite-storage test && pnpm --filter @b4run/sqlite-storage build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sqlite-storage/src/workspace/staged-source-store.ts packages/sqlite-storage/src/workspace/installation.ts packages/sqlite-storage/src/index.ts packages/sqlite-storage/test/workspace-staged-sources.test.ts
git commit -m "feat(sqlite-storage): staged workspace sources, thread references and reclaim

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 22: `workspace.source.put`, and the policy sees a requested workspace

**Files:**
- Modify: `packages/sdk/src/thread-access.ts` (`ThreadOperation`, `ThreadAccessRequest.requestedWorkspace`)
- Modify: `packages/sdk/test/thread-access.contract.ts`
- Modify: `packages/cli/src/lib/dev/thread-gate.ts` (`GateSpec`, the request it builds)
- Modify: `packages/testing/src/thread-access-harness.ts` (spec and request)
- Modify: every test that builds a `ThreadAccessRequest` literal (the typecheck names them)

- [ ] **Step 1: Write the failing contract**

In `thread-access.contract.ts`: add `ThreadAccessRequestedWorkspace` to its type import from `@b4run/sdk` (rebuild the package, `pnpm --filter @b4run/sdk build`, before the typecheck), `| "workspace.source.put"` to `_Operation`, `requestedWorkspace: undefined,` to the `request` literal, and

```ts
// Required as `T | undefined`, like `requestedMetadata`: set only on a create that names a workspace.
type _RequestedWorkspace = Expect<
  Equal<ThreadAccessRequest["requestedWorkspace"], ThreadAccessRequestedWorkspace | undefined>
>
type _RequestedWorkspaceShape = Expect<
  Equal<
    ThreadAccessRequestedWorkspace,
    Readonly<{
      sourceDigest: string
      environmentLinks?: readonly Readonly<{ path: string; target: string }>[]
      baseline?: "git"
    }>
  >
>
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @b4run/sdk typecheck`
Expected: FAIL on `_Operation`, the literal's excess property, and `_RequestedWorkspace`.

- [ ] **Step 3: Implement**

`packages/sdk/src/thread-access.ts`, in the doc list:

```ts
 * - `workspace.source.put` — `PUT /workspace/sources/:digest` — `create`, with
 *   no `threadId` and no `thread`: an upload is not yet any thread's. Served
 *   only when the app sets `sandbox.stagedWorkspaces`
```

in the union:

```ts
  /**
   * `PUT /workspace/sources/:digest`: an upload of a workspace's files, which a
   * later `thread.create` may name. Arrives as a `create` with no thread, so a
   * policy's `create` handler decides it; a stamp returned here is ignored.
   */
  | "workspace.source.put"
```

the type (exported from `packages/sdk/src/index.ts` beside `ThreadAccessRequest`):

```ts
/** A workspace a request chooses: see `ThreadAccessRequest.requestedWorkspace`. */
export type ThreadAccessRequestedWorkspace = Readonly<{
  sourceDigest: string
  environmentLinks?: readonly Readonly<{ path: string; target: string }>[]
  baseline?: "git"
}>
```

and in `ThreadAccessRequest`, after `requestedMetadata`:

```ts
  /**
   * The workspace this request chooses (`sandbox.stagedWorkspaces`): on a
   * `thread.create` with a `workspace`, the whole reference it names (digest,
   * links, baseline); on `workspace.source.put`, `{ sourceDigest }` of the
   * upload. `undefined` on every other request, on a create without one, and on
   * the create's `update` recheck. One rule in a policy (`if
   * (req.requestedWorkspace)`) therefore covers both staging a workspace and
   * choosing one, and lets a caller create threads without choosing what they
   * run on. Shape-checked, not yet verified against held bytes.
   */
  readonly requestedWorkspace: ThreadAccessRequestedWorkspace | undefined
```

`thread-gate.ts`: `GateSpec` gains `readonly requestedWorkspace?: ThreadAccessRequestedWorkspace`, and the request it builds gains `requestedWorkspace: spec.requestedWorkspace,` beside `requestedMetadata`. `packages/testing/src/thread-access-harness.ts`: `ThreadAccessCheckSpec` gains the same optional field and the request it builds `requestedWorkspace: spec.requestedWorkspace,`.

- [ ] **Step 4: Find and fix every literal**

Run: `pnpm --filter @b4run/cli --filter @b4run/testing --filter @b4run/sdk typecheck && pnpm --filter "@b4-example/*" typecheck`
Expected: FAIL at each test that builds a `ThreadAccessRequest` by hand; add `requestedWorkspace: undefined,` beside its `requestedMetadata`, then rerun to exit 0. (The factory's `worker-token.test.ts` already carries it from PR 1.)

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @b4run/sdk test && pnpm --filter @b4run/testing test && pnpm --filter @b4run/cli exec vitest run test/thread-access-pure.test.ts test/thread-access-endpoints.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk packages/cli/src/lib/dev/thread-gate.ts packages/testing/src/thread-access-harness.ts packages/cli/test packages/testing/test
git commit -m "feat(sdk): workspace.source.put, and requestedWorkspace on a create

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 23: `sandbox.stagedWorkspaces`: shape, resolver required, policy required

**Files:**
- Modify: `packages/cli/src/lib/runtime/workspace-protocol.ts` (settings, names, limits)
- Modify: `packages/cli/src/lib/runtime/sandbox-config-shape.ts`
- Modify: `packages/cli/src/lib/runtime/resolve-sandbox.ts` (settings; `staged` into the manager)
- Modify: `packages/cli/src/commands/check.ts` (report line)
- Test: `packages/cli/test/workspace-protocol-config.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `workspace-protocol-config.test.ts`:

```ts
describe("sandbox.stagedWorkspaces shape", () => {
  const provider = managedProviderFixture().provider
  const staticWorkspace = { source: { directory: "source", include: ["main.txt"] } }
  it("accepts true, false and bounded limits beside a resolver", () => {
    for (const value of [true, false, {}, { maxUploadBytes: 1024 }, { retentionMs: 60_000 }])
      expect(sandboxConfigShapeErrors({ provider, thread: resolver, stagedWorkspaces: value })).toEqual([])
    expect(sandboxConfigShapeErrors({ provider, workspace: resolver, stagedWorkspaces: true })).toEqual([])
  })
  for (const [label, value, message] of [
    ["a string", "true", /must be true, false or/],
    ["an unknown limit", { maxUpload: 1 }, /stagedWorkspaces.maxUpload is not/],
    ["an upload over 96 MiB", { maxUploadBytes: 97 * 1024 * 1024 }, /maxUploadBytes must be/],
    ["a retention under a minute", { retentionMs: 1_000 }, /retentionMs must be/],
    ["a zero quota", { maxStagedBytes: 0 }, /maxStagedBytes must be/],
  ] as const)
    it(`refuses ${label}`, () => {
      expect(sandboxConfigShapeErrors({ provider, thread: resolver, stagedWorkspaces: value }).join("\n")).toMatch(message)
    })
  it("refuses it without a resolver: a static workspace would ignore what was staged", () => {
    expect(sandboxConfigShapeErrors({ provider, workspace: staticWorkspace, stagedWorkspaces: true }).join("\n")).toMatch(
      /stagedWorkspaces needs a resolver/,
    )
  })
})

it("boot refuses stagedWorkspaces without a thread-access policy", async () => {
  const appRoot = await app()
  const config = {
    sandbox: { provider: managedProviderFixture().provider, workspace: resolver, stagedWorkspaces: true },
  }
  await expect(createRuntimeFetchHandler({ appRoot, config })).rejects.toThrow(
    /sandbox.stagedWorkspaces .* no thread-access policy/,
  )
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4run/workspace build && pnpm --filter @b4run/cli exec vitest run test/workspace-protocol-config.test.ts`
Expected: FAIL: unknown key `stagedWorkspaces`.

- [ ] **Step 3: Settings and names**

In `workspace-protocol.ts`:

```ts
/** The content store's own payload cap: nothing larger could be kept anyway. */
export const STAGED_UPLOAD_MAX_BYTES = 96 * 1024 * 1024
export const STAGED_RETENTION_DEFAULT_MS = 24 * 60 * 60 * 1000
export const STAGED_RETENTION_MIN_MS = 60 * 1000
export const STAGED_RETENTION_MAX_MS = 30 * 24 * 60 * 60 * 1000
export const STAGED_QUOTA_DEFAULT_BYTES = 1024 * 1024 * 1024
export const STAGED_QUOTA_MAX_BYTES = 16 * 1024 * 1024 * 1024

export interface StagedWorkspaceSettings {
  readonly maxUploadBytes: number
  readonly retentionMs: number
  readonly maxStagedBytes: number
}
```

`WorkspaceProtocolSettings` gains `readonly staged?: StagedWorkspaceSettings` (present means served). Add:

```ts
/** `sandbox.stagedWorkspaces` as settings: `undefined` when off. Assumes the shape was checked. */
export function stagedWorkspaceSettings(value: unknown): StagedWorkspaceSettings | undefined {
  if (value === undefined || value === false) return undefined
  const limits =
    value === true
      ? {}
      : (value as { maxUploadBytes?: number; retentionMs?: number; maxStagedBytes?: number })
  return {
    maxUploadBytes: limits.maxUploadBytes ?? STAGED_UPLOAD_MAX_BYTES,
    retentionMs: limits.retentionMs ?? STAGED_RETENTION_DEFAULT_MS,
    maxStagedBytes: limits.maxStagedBytes ?? STAGED_QUOTA_DEFAULT_BYTES,
  }
}
```

and extend both name functions:

```ts
export function workspaceProtocolOptionNames(sandbox: unknown): string[] {
  if (sandbox === null || typeof sandbox !== "object") return []
  const block = sandbox as Record<string, unknown>
  return [
    ...(block.workspaceRead !== undefined ? ["sandbox.workspaceRead"] : []),
    ...(block.stagedWorkspaces !== undefined && block.stagedWorkspaces !== false
      ? ["sandbox.stagedWorkspaces"]
      : []),
  ]
}

export function openedWorkspaceProtocol(settings: WorkspaceProtocolSettings): string[] {
  return [
    ...(settings.read ? ["sandbox.workspaceRead"] : []),
    ...(settings.staged ? ["sandbox.stagedWorkspaces"] : []),
  ]
}
```

- [ ] **Step 4: Shape rules**

`sandbox-config-shape.ts`: add `"stagedWorkspaces"` to `SANDBOX_KEYS`, import `STAGED_UPLOAD_MAX_BYTES`, `STAGED_RETENTION_MIN_MS`, `STAGED_RETENTION_MAX_MS` and `STAGED_QUOTA_MAX_BYTES` from `./workspace-protocol.js`, and before `return errors`:

```ts
  const staged = block.stagedWorkspaces
  if (staged !== undefined && staged !== false) {
    if (staged !== true && (staged === null || typeof staged !== "object" || Array.isArray(staged)))
      errors.push("b4.config sandbox.stagedWorkspaces must be true, false or { maxUploadBytes?, retentionMs? }.")
    else {
      if (staged !== true) {
        const limits = staged as Record<string, unknown>
        for (const key of Object.keys(limits))
          if (key !== "maxUploadBytes" && key !== "retentionMs" && key !== "maxStagedBytes")
            errors.push(
              `b4.config sandbox.stagedWorkspaces.${key} is not an option (known: maxUploadBytes, retentionMs, maxStagedBytes).`,
            )
        const quota = limits.maxStagedBytes
        if (
          quota !== undefined &&
          (!Number.isSafeInteger(quota) || (quota as number) < 1 || (quota as number) > STAGED_QUOTA_MAX_BYTES)
        )
          errors.push(`b4.config sandbox.stagedWorkspaces.maxStagedBytes must be an integer from 1 to ${STAGED_QUOTA_MAX_BYTES}.`)
        const bytes = limits.maxUploadBytes
        if (bytes !== undefined && (!Number.isSafeInteger(bytes) || (bytes as number) < 1 || (bytes as number) > STAGED_UPLOAD_MAX_BYTES))
          errors.push(`b4.config sandbox.stagedWorkspaces.maxUploadBytes must be an integer from 1 to ${STAGED_UPLOAD_MAX_BYTES}.`)
        const retention = limits.retentionMs
        if (
          retention !== undefined &&
          (!Number.isSafeInteger(retention) ||
            (retention as number) < STAGED_RETENTION_MIN_MS ||
            (retention as number) > STAGED_RETENTION_MAX_MS)
        )
          errors.push(
            `b4.config sandbox.stagedWorkspaces.retentionMs must be an integer from ${STAGED_RETENTION_MIN_MS} to ${STAGED_RETENTION_MAX_MS}.`,
          )
      }
      if (block.thread === undefined && typeof block.workspace !== "function")
        errors.push(
          "b4.config sandbox.stagedWorkspaces needs a resolver (sandbox.thread, or a function sandbox.workspace): a static workspace would ignore what was staged.",
        )
    }
  }
```

(`sandbox-config-shape.ts` gains its first import; `workspace-protocol.ts` imports only types, so the file stays pure.)

- [ ] **Step 5: Resolve the settings and hand the window to the manager**

`resolve-sandbox.ts`: `const workspaceProtocol: WorkspaceProtocolSettings = { read: sandbox.workspaceRead === "http", ...(staged ? { staged } : {}) }` with `const staged = stagedWorkspaceSettings(sandbox.stagedWorkspaces)` above it (the manager learns the retention window in Task 24 Step 4). `check.ts`: `if (loadedConfig.sandbox?.stagedWorkspaces) writeLine(io.stdout, "sandbox: a thread's workspace may be handed over at creation (workspace.source.put)")`.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli exec vitest run test/workspace-protocol-config.test.ts`
Expected: PASS. (Uploads and creates are not served yet: the routes land in Task 25, and until then the settings only open the boot refusal.)

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/runtime/workspace-protocol.ts packages/cli/src/lib/runtime/sandbox-config-shape.ts packages/cli/src/lib/runtime/resolve-sandbox.ts packages/cli/src/commands/check.ts packages/cli/test/workspace-protocol-config.test.ts
git commit -m "feat(cli): sandbox.stagedWorkspaces, refused without a resolver or a policy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 24: The manager stages, checks, attaches, serves `thread.staged`, and reclaims

**Files:**
- Modify: `packages/cli/src/lib/runtime/managed-workspace-manager.ts`
- Modify: `packages/cli/src/lib/runtime/sandbox-manager.ts`
- Modify: `packages/cli/src/lib/runtime/workspace-protocol.ts` (outcome types)
- Create: `packages/cli/test/staged-workspace-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/staged-workspace-manager.test.ts
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { openWorkspaceInstallation, type WorkspaceInstallation } from "@b4run/sqlite-storage"
import type { CapturedWorkspaceDefinition } from "@b4run/workspace"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import { ManagedWorkspaceManager } from "../src/lib/runtime/managed-workspace-manager.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

const roots: string[] = []
const managers: ManagedWorkspaceManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.releaseAll()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const bundle = (text: string) =>
  createSourceBundle([{ path: "main.txt", bytes: new TextEncoder().encode(text), executable: false }])
const HOUR = 60 * 60 * 1000

async function setup(options: { readonly staged?: boolean; readonly maxStagedBytes?: number } = {}) {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-staged-manager-"))
  roots.push(appRoot)
  let now = 1_000_000
  const seen: { threadId: string; staged: CapturedWorkspaceDefinition | undefined }[] = []
  // One remote-service model for every manager of this app root, as one process after another.
  const physical = managedProviderFixture()
  const open = (staged = options.staged ?? true) => {
    const installation: WorkspaceInstallation = openWorkspaceInstallation(appRoot)
    const manager = new ManagedWorkspaceManager({
      installation,
      provider: physical.workspaces,
      policy: { network: { mode: "deny" } },
      idleTimeoutMs: 60_000,
      clock: () => now,
      ...(staged
        ? { staged: { retentionMs: HOUR, maxStagedBytes: options.maxStagedBytes ?? 64 * 1024 * 1024 } }
        : {}),
      resolveThread: async (thread) => {
        seen.push({ threadId: thread.threadId, staged: thread.staged })
        if (!thread.staged) throw new Error("no staged workspace")
        return { definition: thread.staged }
      },
    })
    managers.push(manager)
    return { manager, installation }
  }
  return { open, seen, advance: (ms: number) => (now += ms) }
}

describe("staged workspaces in the manager", () => {
  it("stages an upload once, refuses one whose bytes are not its digest, and a malformed one", async () => {
    const { open } = await setup()
    const { manager } = open()
    const a = bundle("a")
    expect(manager.stageSource(a, a.digest)).toEqual({ ok: true, status: "created" })
    expect(manager.stageSource(a, a.digest)).toEqual({ ok: true, status: "held" })
    expect(manager.stageSource(a, "f".repeat(64))).toMatchObject({ ok: false, code: "digest_mismatch" })
    expect(manager.stageSource({ version: 1, digest: a.digest, files: "x" }, a.digest)).toMatchObject({
      ok: false,
      code: "workspace_source_invalid",
    })
  })

  it("checks a reference before any thread exists, and serves it as thread.staged at first admission", async () => {
    const { open, seen } = await setup()
    const { manager, installation } = open()
    const a = bundle("a")
    expect(manager.checkStagedWorkspace({ sourceDigest: a.digest })).toMatchObject({
      ok: false,
      code: "workspace_source_not_held",
    })
    manager.stageSource(a, a.digest)
    expect(
      manager.checkStagedWorkspace({ sourceDigest: a.digest, environmentLinks: [{ path: "main.txt", target: "/x" }] }),
    ).toMatchObject({ ok: false, code: "workspace_invalid" })
    const checked = manager.checkStagedWorkspace({ sourceDigest: a.digest })
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(manager.attachStagedWorkspace("t-1", checked.reference)).toEqual({ ok: true })
    await manager.getForThread("t-1", new AbortController().signal)
    expect(seen.map((s) => s.staged?.source.digest)).toEqual([a.digest])
    expect(installation.associations.get("t-1")?.intent.sourceDigest).toBe(a.digest)
    expect(manager.attachStagedWorkspace("t-1", checked.reference)).toMatchObject({ ok: false })
  })

  it("never re-resolves: a restarted manager reads the record", async () => {
    const { open, seen } = await setup()
    const first = open()
    const a = bundle("a")
    first.manager.stageSource(a, a.digest)
    first.manager.attachStagedWorkspace("t-1", { sourceDigest: a.digest })
    await first.manager.getForThread("t-1", new AbortController().signal)
    await first.manager.releaseAll()
    managers.splice(managers.indexOf(first.manager), 1)
    const second = open()
    await second.manager.getForThread("t-1", new AbortController().signal)
    expect(seen).toHaveLength(1)
  })

  it("does not hand a staged workspace to a resolver once the option is off", async () => {
    const { open, seen } = await setup()
    const on = open()
    const a = bundle("a")
    on.manager.stageSource(a, a.digest)
    on.manager.attachStagedWorkspace("t-1", { sourceDigest: a.digest })
    await on.manager.releaseAll()
    managers.splice(managers.indexOf(on.manager), 1)
    const off = open(false)
    await expect(off.manager.getForThread("t-1", new AbortController().signal)).rejects.toThrow(/no staged workspace/)
    expect(seen.at(-1)?.staged).toBeUndefined()
  })

  it("reclaims an unreferenced upload after the window, keeps a staged or admitted one, and forgets a deleted thread's", async () => {
    const { open, advance } = await setup()
    const { manager, installation } = open()
    const [unused, staged, admitted] = [bundle("unused"), bundle("staged"), bundle("admitted")]
    for (const b of [unused, staged, admitted]) manager.stageSource(b, b.digest)
    manager.attachStagedWorkspace("t-staged", { sourceDigest: staged.digest })
    manager.attachStagedWorkspace("t-admitted", { sourceDigest: admitted.digest })
    await manager.getForThread("t-admitted", new AbortController().signal)
    advance(2 * HOUR)
    expect(manager.reclaimStagedSources()).toEqual([unused.digest])
    await manager.destroyThread("t-staged")
    manager.completeDelete("t-staged")
    expect(installation.staged.get("t-staged")).toBeUndefined()
    expect(manager.reclaimStagedSources()).toEqual([staged.digest])
    expect(installation.staged.holds(admitted.digest)).toBe(true)
  })

  it("forgets a thread's staged workspace on request, and sweeps threads whose rows are gone", async () => {
    const { open } = await setup()
    const { manager, installation } = open()
    const a = bundle("a")
    manager.stageSource(a, a.digest)
    for (const id of ["t-kept", "t-gone", "t-forgotten"]) manager.attachStagedWorkspace(id, { sourceDigest: a.digest })
    manager.forgetStagedWorkspace("t-forgotten")
    expect(await manager.sweepStagedThreads(async (id) => id === "t-kept")).toEqual(["t-gone"])
    expect(installation.staged.threads()).toEqual(["t-kept"])
  })

  it("refuses an upload past the staged quota", async () => {
    const first = bundle("x".repeat(100))
    const second = bundle("y".repeat(100))
    const { open } = await setup({ maxStagedBytes: JSON.stringify(first).length + 10 })
    const { manager } = open()
    expect(manager.stageSource(first, first.digest)).toMatchObject({ ok: true, status: "created" })
    expect(manager.stageSource(second, second.digest)).toMatchObject({ ok: false, code: "staged_quota_exceeded" })
    expect(manager.stageSource(first, first.digest)).toMatchObject({ ok: true, status: "held" })
  })

  it("keeps the source write and the association write synchronous: nothing can reclaim between them", () => {
    // `reclaimStagedSources` is synchronous SQLite; it can run between two statements only if
    // an `await` separates them. This pins that `sources.put` and `associations.create` in
    // `getForThread` stay back to back with no `await` between.
    const text = readFileSync(
      fileURLToPath(new URL("../src/lib/runtime/managed-workspace-manager.ts", import.meta.url)),
      "utf8",
    )
    const from = text.indexOf("installation.sources.put(definition.source)")
    const to = text.indexOf("installation.associations.create(", from)
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    expect(text.slice(from, to)).not.toMatch(/\bawait\b/)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4run/cli exec vitest run test/staged-workspace-manager.test.ts`
Expected: FAIL: `stageSource` is not a function.

- [ ] **Step 3: The outcome types**

Append to `workspace-protocol.ts`:

```ts
export type StageSourceOutcome =
  | { readonly ok: true; readonly status: "created" | "held" }
  | {
      readonly ok: false
      readonly code: "digest_mismatch" | "workspace_source_invalid" | "staged_quota_exceeded"
      readonly message: string
    }

export type StagedWorkspaceCheck =
  | { readonly ok: true; readonly reference: StagedWorkspaceReference }
  | { readonly ok: false; readonly code: "workspace_source_not_held" | "workspace_invalid"; readonly message: string }

export type StagedWorkspaceAttach =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "workspace_source_not_held" | "already_staged"; readonly message: string }
```

with `import type { StagedWorkspaceReference, WorkspaceInspection } from "@b4run/workspace"`.

- [ ] **Step 4: The manager**

In `managed-workspace-manager.ts` add the imports `WorkspaceStagedSourceError` (from `@b4run/sqlite-storage`), `type StagedWorkspaceReference` (from `@b4run/workspace`), `stagedWorkspaceDefinition`, `verifySourceBundle`, `verifyStagedWorkspaceReference` (from `@b4run/workspace/node`), and the three outcome types. Options:

```ts
  /**
   * `sandbox.stagedWorkspaces`: a thread created with a staged workspace gets it
   * as `staged` at first admission, and unreferenced sources older than
   * `retentionMs` are reclaimed at construction and after each upload.
   */
  staged?: { readonly retentionMs: number; readonly maxStagedBytes: number }
```

and both resolver input types (`captureDefinition`, `resolveThread`) gain `readonly staged?: CapturedWorkspaceDefinition`. At the end of the constructor: `if (options.staged) this.reclaimStagedSources()`. In `#resolve`, after `metadata` is computed:

```ts
    // Only while the app serves staged workspaces: an app that turned the option off
    // stops handing creators' choices to its resolver.
    const staged = this.#options.staged ? this.#stagedDefinition(threadId) : undefined
    const input = { threadId, metadata, signal, ...(staged ? { staged } : {}) }
```

and pass `input` to `resolveThread(input)` and `captureDefinition?.(input)` in place of the two `{ threadId, metadata, signal }` literals. New members:

```ts
  /** The verified definition a thread was created with, or undefined. A missing source is lost, never skipped. */
  #stagedDefinition(threadId: string): CapturedWorkspaceDefinition | undefined {
    const { installation } = this.#options
    const reference = installation.staged.get(threadId)
    if (!reference) return undefined
    const source = installation.sources.get(reference.sourceDigest)
    if (!source)
      throw new WorkspaceLifecycleError(
        "lost",
        `Thread ${threadId}'s staged workspace source ${reference.sourceDigest} is missing`,
      )
    return stagedWorkspaceDefinition(reference, source)
  }

  /** `PUT /workspace/sources/:digest`: keep a verified bundle under its own digest, then reclaim. */
  stageSource(value: unknown, digest: string): StageSourceOutcome {
    this.#assertOpen()
    if (!this.#options.staged) throw new Error("Staged workspaces are off (sandbox.stagedWorkspaces)")
    let bundle: SourceBundle
    try {
      bundle = verifySourceBundle(value)
    } catch (error) {
      return {
        ok: false,
        code: "workspace_source_invalid",
        message: `Invalid workspace source: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (bundle.digest !== digest)
      return { ok: false, code: "digest_mismatch", message: `The uploaded source's digest is ${bundle.digest}, not ${digest}` }
    // Reclaim first, so expired uploads free their share of the quota before this one is counted.
    this.reclaimStagedSources()
    try {
      const status = this.#options.installation.staged.upload(
        bundle,
        this.#now(),
        this.#options.staged.maxStagedBytes,
      )
      return { ok: true, status }
    } catch (error) {
      if (error instanceof WorkspaceStagedSourceError && error.code === "quota_exceeded")
        return { ok: false, code: "staged_quota_exceeded", message: error.message }
      throw error
    }
  }

  /**
   * Forget the workspace a thread was created with. `DELETE /threads/:id` calls it
   * BEFORE the thread row goes: if the row delete then fails, the thread survives with no
   * staged workspace (its resolver refuses it), and a thread later created under the
   * same id (run endpoints take client-chosen ids) never inherits it.
   */
  forgetStagedWorkspace(threadId: string): void {
    this.#assertOpen()
    this.#options.installation.staged.detach(threadId)
  }

  /** Boot sweep: forget the staged reference of every thread whose row no longer exists. */
  async sweepStagedThreads(exists: (threadId: string) => Promise<boolean>): Promise<readonly string[]> {
    this.#assertOpen()
    const forgotten: string[] = []
    for (const threadId of this.#options.installation.staged.threads()) {
      if (await exists(threadId)) continue
      this.#options.installation.staged.detach(threadId)
      forgotten.push(threadId)
    }
    return forgotten
  }

  /** The reference a create names, checked whole (held, and a valid definition) before any thread row exists. */
  checkStagedWorkspace(value: unknown): StagedWorkspaceCheck {
    this.#assertOpen()
    let reference: StagedWorkspaceReference
    try {
      reference = verifyStagedWorkspaceReference(value)
    } catch (error) {
      return { ok: false, code: "workspace_invalid", message: `Invalid workspace: ${error instanceof Error ? error.message : String(error)}` }
    }
    const source = this.#options.installation.sources.get(reference.sourceDigest)
    if (!source)
      return {
        ok: false,
        code: "workspace_source_not_held",
        message: `Workspace source ${reference.sourceDigest} is not held: PUT /workspace/sources/${reference.sourceDigest} first`,
      }
    try {
      stagedWorkspaceDefinition(reference, source)
    } catch (error) {
      return { ok: false, code: "workspace_invalid", message: `Invalid workspace: ${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, reference }
  }

  /** Record a new thread's staged workspace. Refused for a thread that already has a workspace or a record. */
  attachStagedWorkspace(threadId: string, reference: StagedWorkspaceReference): StagedWorkspaceAttach {
    this.#assertOpen()
    if (!this.#options.staged) throw new Error("Staged workspaces are off (sandbox.stagedWorkspaces)")
    const { installation } = this.#options
    if (installation.associations.get(threadId))
      return { ok: false, code: "already_staged", message: `Thread ${threadId} already has a workspace` }
    try {
      installation.staged.attach(threadId, reference)
      return { ok: true }
    } catch (error) {
      if (!(error instanceof WorkspaceStagedSourceError)) throw error
      return {
        ok: false,
        code: error.code === "not_held" ? "workspace_source_not_held" : "already_staged",
        message: error.message,
      }
    }
  }

  /** Delete held sources nothing references (D7). No-op unless staged workspaces are on. */
  reclaimStagedSources(): readonly string[] {
    const staged = this.#options.staged
    if (!staged) return []
    const { installation } = this.#options
    const referenced = new Set<string>()
    for (const record of installation.associations.list())
      if (record.state !== "deleted") referenced.add(record.intent.sourceDigest)
    if (this.#definition) referenced.add(this.#definition.source.digest)
    return installation.staged.reclaim(Math.max(0, this.#now() - staged.retentionMs), referenced)
  }
```

`completeDelete` gains, after its association branch: `this.#options.installation.staged.detach(threadId)` (unconditional: a thread deleted before it ever ran has no association, and its reference must not pin a source).

In `resolve-sandbox.ts`, both resolver branches (`thread`, and a function `workspace`) pass the window to the manager: `...(staged ? { staged: { retentionMs: staged.retentionMs, maxStagedBytes: staged.maxStagedBytes } } : {})` in the `ManagedWorkspaceManager` options.

In `sandbox-manager.ts`, three pass-throughs:

```ts
  stageSource(value: unknown, digest: string): StageSourceOutcome {
    if (!this.#managed || !this.#protocol.staged) throw new Error("Staged workspaces are off (sandbox.stagedWorkspaces)")
    return this.#managed.stageSource(value, digest)
  }
  checkStagedWorkspace(value: unknown): StagedWorkspaceCheck {
    if (!this.#managed || !this.#protocol.staged) throw new Error("Staged workspaces are off (sandbox.stagedWorkspaces)")
    return this.#managed.checkStagedWorkspace(value)
  }
  attachStagedWorkspace(threadId: string, reference: StagedWorkspaceReference): StagedWorkspaceAttach {
    if (!this.#managed || !this.#protocol.staged) throw new Error("Staged workspaces are off (sandbox.stagedWorkspaces)")
    return this.#managed.attachStagedWorkspace(threadId, reference)
  }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli exec vitest run test/staged-workspace-manager.test.ts test/managed-workspace-manager.test.ts test/workspace-protocol-config.test.ts test/managed-workspace-runtime.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/runtime/managed-workspace-manager.ts packages/cli/src/lib/runtime/sandbox-manager.ts packages/cli/src/lib/runtime/workspace-protocol.ts packages/cli/src/lib/runtime/resolve-sandbox.ts packages/cli/test/staged-workspace-manager.test.ts
git commit -m "feat(cli): the manager stages workspaces, serves thread.staged and reclaims sources

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 25: `PUT /workspace/sources/:digest`, and `POST /threads` with `workspace`

**Files:**
- Modify: `packages/cli/src/lib/dev/thread-workspace-http.ts` (`THREAD_CREATE_BODY_MAX_BYTES`, `stagedWorkspaceField`)
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (the `POST /threads` handler, `:1364-1430`; the `DELETE /threads/:thread_id` handler, `:1466-1539`; the boot sweep after `reconcileDeletions`; a new route)
- Modify: `packages/cli/src/lib/runtime/sandbox-manager.ts` (`forgetStagedWorkspace`, `sweepStagedThreads`)
- Modify: `packages/cli/test/thread-access-coverage.test.ts`
- Create: `packages/cli/test/staged-workspace-endpoint.test.ts`

- [ ] **Step 1: Write the failing tests** (the spec's proof list)

```ts
// packages/cli/test/staged-workspace-endpoint.test.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorkspaceInstallationReader } from "@b4run/sqlite-storage"
import { createSourceBundle } from "@b4run/workspace/node"
import { seedB4Config } from "@b4run/core"
import { afterEach, expect, it, vi } from "vitest"
import {
  createRuntimeFetchHandler,
  type RuntimeFetchHandler,
} from "../src/lib/dev/runtime-fetch-handler.ts"
import { resolveSandboxManager } from "../src/lib/runtime/resolve-sandbox.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

const TOKEN = "Bearer staged-test-token"
const roots: string[] = []
const handlers: RuntimeFetchHandler[] = []
afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const source = (text: string) =>
  createSourceBundle([{ path: "main.txt", bytes: new TextEncoder().encode(text), executable: false }])

async function fixture(
  options: { readonly stagedWorkspaces?: unknown; readonly attachRefusedOnce?: boolean } = {},
) {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-staged-endpoint-"))
  roots.push(appRoot)
  const files = {
    "package.json": '{"type":"module"}',
    "b4.config.ts": "export default {}",
    "workspace/.keep": "",
    "src/app/read/index.ts": "export const workflow=async (input,ctx)=>ctx.tools.read(input)",
    "src/app/read/tools/read.ts":
      "export default async function read(input:{path:string},ctx){return {text:await ctx.fs.readFile(input.path)}}",
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(appRoot, path, ".."), { recursive: true })
    await writeFile(join(appRoot, path), text)
  }
  const physical = managedProviderFixture()
  const resolved: { threadId: string; digest: string | undefined }[] = []
  const decisions: { action: string; operation: string; requestedWorkspace: unknown }[] = []
  /** Thread ids the create recheck saw: the rows this runtime wrote. */
  const written: string[] = []
  const config = {
    sandbox: {
      provider: physical.provider,
      stagedWorkspaces: options.stagedWorkspaces ?? true,
      thread: async (thread: { threadId: string; staged?: { source: { digest: string } } }) => {
        resolved.push({ threadId: thread.threadId, digest: thread.staged?.source.digest })
        if (!thread.staged) throw new Error("this app serves only staged workspaces")
        return { workspace: thread.staged }
      },
    },
  }
  const threadAccess = {
    fallback: (req: {
      action: string
      operation: string
      threadId: string | undefined
      headers: Readonly<Record<string, string>>
      requestedWorkspace: unknown
    }) => {
      decisions.push({ action: req.action, operation: req.operation, requestedWorkspace: req.requestedWorkspace })
      if (req.action === "update" && req.operation === "thread.create" && req.threadId) written.push(req.threadId)
      return req.headers.authorization === TOKEN
        ? { decision: "allow" as const }
        : { decision: "deny" as const, status: 403 as const }
    },
  }
  const boot = async () => {
    // To race a reclaim against a create, a test hands the runtime a manager whose next
    // attach finds the source gone, exactly as a reclaim between the check and the attach would.
    let sandboxManager: Awaited<ReturnType<typeof resolveSandboxManager>> | undefined
    if (options.attachRefusedOnce) {
      seedB4Config(appRoot, config as never)
      sandboxManager = await resolveSandboxManager(appRoot)
      if (!sandboxManager) throw new Error("the fixture configures a sandbox")
      vi.spyOn(sandboxManager, "attachStagedWorkspace").mockReturnValueOnce({
        ok: false,
        code: "workspace_source_not_held",
        message: "Workspace source was reclaimed: upload it again",
      })
    }
    const handler = await createRuntimeFetchHandler({
      appRoot,
      config: config as never,
      threadAccess: threadAccess as never,
      ...(sandboxManager ? { sandboxManager } : {}),
    })
    handlers.push(handler)
    return handler
  }
  let handler = await boot()
  const call = (method: string, path: string, body?: unknown, authorization: string | null = TOKEN) =>
    handler.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json", ...(authorization === null ? {} : { authorization }) },
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    )
  return {
    appRoot,
    resolved,
    decisions,
    written,
    call,
    async restart() {
      await handler.close()
      handler = await boot()
    },
    upload: (bundle: ReturnType<typeof source>, digest = bundle.digest, authorization: string | null = TOKEN) =>
      call("PUT", `/workspace/sources/${digest}`, bundle, authorization),
    create: (workspace: unknown, authorization: string | null = TOKEN) =>
      call("POST", "/threads", { metadata: { purpose: "test" }, workspace }, authorization),
    read: (threadId: string) =>
      call("POST", `/threads/${threadId}/runs/wait`, { route: "/read#workflow", input: { path: "main.txt" } }),
  }
}

/** Rows created: every create that reached the store is followed by its `update` recheck. */
const rowsCreated = (decisions: { action: string; operation: string }[]) =>
  decisions.filter((d) => d.action === "update" && d.operation === "thread.create").length

it("uploads, creates, and serves the staged workspace at the first run, recorded by digest", async () => {
  const f = await fixture()
  const bundle = source("staged bytes")
  expect((await f.upload(bundle)).status).toBe(201)
  expect((await f.upload(bundle)).status).toBe(200)
  const created = await f.create({ sourceDigest: bundle.digest })
  expect(created.status).toBe(200)
  const threadId = ((await created.json()) as { thread_id: string }).thread_id
  const run = await f.read(threadId)
  expect(run.status).toBe(200)
  expect(JSON.stringify(await run.json())).toContain("staged bytes")
  expect(f.resolved).toEqual([{ threadId, digest: bundle.digest }])
  const installation = openWorkspaceInstallationReader(f.appRoot)
  expect(installation.associations.get(threadId)?.intent.sourceDigest).toBe(bundle.digest)
  installation.close()
  await f.restart()
  expect((await f.read(threadId)).status).toBe(200)
  expect(f.resolved).toHaveLength(1)
})

it("refuses a create naming a digest it does not hold, before any thread row", async () => {
  const f = await fixture()
  const response = await f.create({ sourceDigest: "a".repeat(64) })
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ error: { details: { code: "workspace_source_not_held" } } })
  expect(rowsCreated(f.decisions)).toBe(0)
})

it("refuses a body whose digest differs from the path, and a malformed bundle", async () => {
  const f = await fixture()
  const bundle = source("x")
  const mismatch = await f.upload(bundle, "b".repeat(64))
  expect(mismatch.status).toBe(400)
  expect(await mismatch.json()).toMatchObject({ error: { details: { code: "digest_mismatch" } } })
  const invalid = await f.call("PUT", `/workspace/sources/${bundle.digest}`, { ...bundle, files: [{ path: "../x", base64: "", executable: false }] })
  expect(invalid.status).toBe(422)
  expect((await f.call("PUT", "/workspace/sources/not-a-digest", bundle)).status).toBe(400)
})

it("403 without the token, for the upload and for the create, before anything is kept", async () => {
  const f = await fixture()
  const bundle = source("x")
  expect((await f.upload(bundle, bundle.digest, null)).status).toBe(403)
  expect((await f.create({ sourceDigest: bundle.digest }, null)).status).toBe(403)
  expect((await f.create({ sourceDigest: bundle.digest })).status).toBe(422)
})

it("shows the policy the workspace an upload stages and the whole reference a create names", async () => {
  const f = await fixture()
  const bundle = source("x")
  await f.upload(bundle)
  const reference = { sourceDigest: bundle.digest, environmentLinks: [{ path: "deps", target: "/opt/deps" }], baseline: "git" }
  expect((await f.create(reference)).status).toBe(200)
  expect(f.decisions).toContainEqual({
    action: "create",
    operation: "workspace.source.put",
    requestedWorkspace: { sourceDigest: bundle.digest },
  })
  expect(f.decisions).toContainEqual({ action: "create", operation: "thread.create", requestedWorkspace: reference })
  expect(f.decisions).toContainEqual({ action: "update", operation: "thread.create", requestedWorkspace: undefined })
})

it("refuses a workspace the app does not accept instead of ignoring it, and hides the option from the unauthorized", async () => {
  const off = await fixture({ stagedWorkspaces: false })
  const response = await off.create({ sourceDigest: "a".repeat(64) })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { details: { code: "workspace_not_accepted" } } })
  expect((await off.upload(source("x"))).status).toBe(404)
  expect(rowsCreated(off.decisions)).toBe(0)
  // Without the token, off and on answer alike: the gate's 403.
  const on = await fixture()
  for (const f of [off, on]) {
    expect((await f.upload(source("x"), undefined, null)).status).toBe(403)
    expect((await f.create({ sourceDigest: "a".repeat(64) }, null)).status).toBe(403)
  }
  // And an app without the option keeps reading create bodies unbounded, as before.
  expect((await off.call("POST", "/threads", { metadata: { pad: "x".repeat(2 * 1024 * 1024) } })).status).toBe(200)
})

it("takes one upload at a time and caps what is staged", async () => {
  const f = await fixture({ stagedWorkspaces: { maxStagedBytes: 4096 } })
  const [a, b] = [source("a".repeat(1500)), source("b".repeat(1500))]
  const both = await Promise.all([f.upload(a), f.upload(b)])
  expect(both.map((r) => r.status).sort()).toEqual([201, 429])
  expect(both.find((r) => r.status === 429)?.headers.get("retry-after")).toBe("1")
  const later = await f.upload(both[0].status === 201 ? b : a)
  expect(later.status).toBe(507)
  expect(await later.json()).toMatchObject({ error: { details: { code: "staged_quota_exceeded" } } })
})

it("deletes the thread row when its source is reclaimed between the check and the attach", async () => {
  const f = await fixture({ attachRefusedOnce: true })
  const bundle = source("x")
  await f.upload(bundle)
  const response = await f.create({ sourceDigest: bundle.digest })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { details: { code: "workspace_source_not_held" } } })
  expect(f.written).toHaveLength(1)
  expect((await f.call("GET", `/threads/${f.written[0]}`)).status).toBe(404)
})

it("forgets a deleted thread's staged workspace first: a thread reusing the id gets none", async () => {
  const f = await fixture()
  const bundle = source("x")
  await f.upload(bundle)
  const threadId = ((await (await f.create({ sourceDigest: bundle.digest })).json()) as { thread_id: string }).thread_id
  expect((await f.call("DELETE", `/threads/${threadId}`)).status).toBe(204)
  // A run endpoint creates a thread under a client-chosen id: this one.
  await f.read(threadId)
  expect(f.resolved).toEqual([{ threadId, digest: undefined }])
})

it("bounds the upload and the create", async () => {
  const f = await fixture({ stagedWorkspaces: { maxUploadBytes: 1024 } })
  const big = source("x".repeat(4096))
  expect((await f.upload(big)).status).toBe(413)
  expect((await f.call("POST", "/threads", { metadata: { pad: "x".repeat(1024 * 1024) } })).status).toBe(413)
})

it("refuses a definition the held source cannot make: a link over a file", async () => {
  const f = await fixture()
  const bundle = source("x")
  await f.upload(bundle)
  const response = await f.create({ sourceDigest: bundle.digest, environmentLinks: [{ path: "main.txt", target: "/x" }] })
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ error: { details: { code: "workspace_invalid" } } })
  expect(rowsCreated(f.decisions)).toBe(0)
})
```

In `workspace-protocol-config.test.ts`'s route coverage, nothing changes; in `thread-access-coverage.test.ts`, add to `GATED`

```ts
  routeKey("PUT", /^\/workspace\/sources\/(?<digest>[^/?#]+)(?:\?.*)?$/),
```

and change the count to 18 ("plus `PUT /workspace/sources/:digest` (spec item 2), which carries no thread id and is gated as a `create`").

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4run/cli build && pnpm --filter @b4run/cli exec vitest run test/staged-workspace-endpoint.test.ts`
Expected: FAIL: the upload answers 404; the create ignores `workspace`.

- [ ] **Step 3: The pure halves**

Append to `thread-workspace-http.ts`:

```ts
/** `POST /threads` is metadata and a reference, never content (D3). Only when `stagedWorkspaces` is on. */
export const THREAD_CREATE_BODY_MAX_BYTES = 1024 * 1024
const MAX_LINKS = 1024

export interface StagedWorkspaceFieldValue {
  readonly sourceDigest: string
  readonly environmentLinks?: readonly { readonly path: string; readonly target: string }[]
  readonly baseline?: "git"
}

/**
 * The `workspace` field's shape, in the pure core, copied onto fresh objects (own keys
 * only): what the policy sees as `requestedWorkspace`. The manager then verifies the
 * whole reference (path rules, link targets, collisions) against the source it holds
 * before any thread row exists.
 */
export function stagedWorkspaceField(
  value: unknown,
):
  | { readonly ok: true; readonly reference: StagedWorkspaceFieldValue }
  | { readonly ok: false; readonly message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, message: "workspace must be an object naming a staged source" }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record))
    if (key !== "sourceDigest" && key !== "environmentLinks" && key !== "baseline")
      return { ok: false, message: `Unknown workspace field: ${key}` }
  const own = (key: string) => (Object.hasOwn(record, key) ? record[key] : undefined)
  const digest = own("sourceDigest")
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
    return { ok: false, message: "workspace.sourceDigest must be 64 lowercase hex characters" }
  const baseline = own("baseline")
  if (baseline !== undefined && baseline !== "git")
    return { ok: false, message: 'workspace.baseline must be "git"' }
  const links = own("environmentLinks")
  let environmentLinks: { path: string; target: string }[] | undefined
  if (links !== undefined) {
    if (!Array.isArray(links) || links.length > MAX_LINKS)
      return { ok: false, message: `workspace.environmentLinks must be an array of at most ${MAX_LINKS} links` }
    environmentLinks = []
    for (const link of links) {
      if (typeof link !== "object" || link === null || Array.isArray(link))
        return { ok: false, message: "each workspace.environmentLinks entry must be { path, target }" }
      const { path, target } = link as Record<string, unknown>
      if (
        Object.keys(link).length !== 2 ||
        typeof path !== "string" ||
        typeof target !== "string" ||
        path.length > 1024 ||
        target.length > 1024
      )
        return { ok: false, message: "each workspace.environmentLinks entry must be { path, target }" }
      environmentLinks.push({ path, target })
    }
  }
  return {
    ok: true,
    reference: {
      sourceDigest: digest,
      ...(environmentLinks !== undefined ? { environmentLinks } : {}),
      ...(baseline === "git" ? { baseline: "git" as const } : {}),
    },
  }
}
```

- [ ] **Step 4: The upload route**

Add to `buildRouteTable`, after the inspect route, with one per-table flag declared beside `threadRouteMap` at the top of `buildRouteTable`:

```ts
  // One upload at a time per process: a source costs several times its size in memory
  // while it is decoded, parsed, verified and stored (D3), so a second concurrent upload
  // is told to retry rather than doubling that peak.
  let uploadInFlight = false
```

```ts
    // ------------------------------------------------------------------
    // PUT /workspace/sources/:digest — stage a workspace's files
    // ------------------------------------------------------------------
    // Order: digest shape (a 400 that reveals nothing), gate, THEN the feature check, the
    // single-flight check and the body. An unauthorized caller gets the gate's answer
    // whether the feature is on or off and never makes this worker buffer a byte; an
    // authorized caller of an app without `sandbox.stagedWorkspaces` gets the 404 of a
    // route that does not exist. Content-addressed and idempotent: 201 for new bytes,
    // 200 for bytes already held.
    {
      handle: async (request, params) => {
        const digest = params.digest ?? ""
        if (!/^[0-9a-f]{64}$/.test(digest))
          return Response.json(
            createRequestErrorBody("The source digest must be 64 lowercase hex characters", {
              code: "invalid_request",
            }),
            { status: 400 },
          )
        const gate = makeThreadGate(threadAccess, request)
        const g = gate({
          action: "create",
          operation: "workspace.source.put",
          requestedWorkspace: { sourceDigest: digest },
        })
        const settled = isThenable(g) ? await g : g
        if (!settled.ok) return settled.response
        const staged = sandboxManager?.workspaceProtocol.staged
        if (!sandboxManager || !staged)
          return Response.json(createRequestErrorBody("Not found"), { status: 404 })
        if (uploadInFlight)
          return Response.json(
            createRequestErrorBody("Another workspace upload is in progress; retry shortly", {
              code: "upload_in_flight",
            }),
            { status: 429, headers: { "retry-after": "1" } },
          )
        uploadInFlight = true
        try {
          let raw: string
          try {
            raw = await readBoundedText(request, staged.maxUploadBytes)
          } catch (error) {
            if (error instanceof RequestBodyTooLargeError) return payloadTooLarge(error)
            throw error
          }
          const parsed = parseJson(raw)
          if (!parsed.ok)
            return Response.json(createRequestErrorBody("Malformed request body"), { status: 400 })
          const outcome = sandboxManager.stageSource(parsed.value, digest)
          if (!outcome.ok)
            return Response.json(createRequestErrorBody(outcome.message, { code: outcome.code }), {
              status:
                outcome.code === "digest_mismatch" ? 400 : outcome.code === "staged_quota_exceeded" ? 507 : 422,
            })
          return Response.json(
            { digest, status: outcome.status },
            { status: outcome.status === "created" ? 201 : 200 },
          )
        } finally {
          uploadInFlight = false
        }
      },
      method: "PUT",
      pattern: /^\/workspace\/sources\/(?<digest>[^/?#]+)(?:\?.*)?$/,
    },
```

- [ ] **Step 5: `POST /threads` takes a `workspace`, bounded only when the app accepts one**

Replace the handler's opening (from `const rawBody = await request.text()` through the first gate call) with:

```ts
      handle: async (request) => {
        const stagedOn = Boolean(sandboxManager?.workspaceProtocol.staged)
        // The 1 MiB bound applies only to an app that accepts staged workspaces: every other
        // app reads its create body exactly as before (no behaviour change; D3).
        let rawBody: string
        if (stagedOn) {
          try {
            rawBody = await readBoundedText(request, THREAD_CREATE_BODY_MAX_BYTES)
          } catch (error) {
            if (error instanceof RequestBodyTooLargeError) return payloadTooLarge(error)
            throw error
          }
        } else rawBody = await request.text()
        let metadata: Record<string, unknown> | undefined
        let workspaceField: unknown
        if (rawBody.trim()) {
          const parsed = parseJson(rawBody)
          if (!parsed.ok || !isRecord(parsed.value)) {
            return Response.json(createRequestErrorBody("Malformed request body"), { status: 400 })
          }
          const body = parsed.value as Record<string, unknown>
          const bodyMetadata = body.metadata
          if (bodyMetadata !== undefined) {
            if (!isRecord(bodyMetadata)) {
              return Response.json(createRequestErrorBody("metadata must be an object"), {
                status: 400,
              })
            }
            metadata = bodyMetadata
          }
          if (Object.hasOwn(body, "workspace")) workspaceField = body.workspace
        }
        // A malformed field is a 400 whether or not the app accepts workspaces, so the answer
        // reveals nothing about the option.
        let requestedWorkspace: StagedWorkspaceFieldValue | undefined
        if (workspaceField !== undefined) {
          const field = stagedWorkspaceField(workspaceField)
          if (!field.ok)
            return Response.json(createRequestErrorBody(field.message, { code: "invalid_request" }), {
              status: 400,
            })
          requestedWorkspace = field.reference
        }
        // (the existing comment on the reserved key stays here)
        const clientMetadata = stripReservedThreadMetadata(metadata)
        const gate = makeThreadGate(threadAccess, request)
        const created = gate({
          action: "create",
          operation: "thread.create",
          ...(clientMetadata !== undefined ? { requestedMetadata: clientMetadata } : {}),
          ...(requestedWorkspace !== undefined ? { requestedWorkspace } : {}),
        })
        const settled = isThenable(created) ? await created : created
        if (!settled.ok) return settled.response

        // After the gate: a workspace this app will not serve is refused, never ignored (D12).
        if (workspaceField !== undefined && !stagedOn)
          return Response.json(
            createRequestErrorBody(
              "This app does not accept a workspace at thread creation (sandbox.stagedWorkspaces)",
              { code: "workspace_not_accepted" },
            ),
            { status: 400 },
          )
        // Checked whole BEFORE any thread row exists: a source this worker does not hold, or a
        // definition it could not serve, leaves nothing behind.
        let staged: StagedWorkspaceReference | undefined
        if (requestedWorkspace !== undefined && sandboxManager) {
          const checked = sandboxManager.checkStagedWorkspace(requestedWorkspace)
          if (!checked.ok)
            return Response.json(createRequestErrorBody(checked.message, { code: checked.code }), {
              status: 422,
            })
          staged = checked.reference
        }
```

(the `stored`, `input`, `createThread`, retry and recheck lines that follow are unchanged), and before the final `return Response.json(thread, { status: 200 })`:

```ts
        if (staged && sandboxManager) {
          // Only the row this request wrote may be given a workspace, and only that row may be
          // removed again: a collision's existing row is refused and left exactly as it was.
          // A source reclaimed between the check and here (`workspace_source_not_held`) is the
          // same refusal: the row goes and the caller re-uploads.
          const ours = isRowWeJustWrote(thread, stored)
          const attached = ours
            ? sandboxManager.attachStagedWorkspace(thread.thread_id, staged)
            : ({ ok: false, code: "thread_conflict", message: "Thread id collision: retry the create" } as const)
          if (!attached.ok) {
            if (ours) await getThreadsStore(request).deleteThread(thread.thread_id)
            return Response.json(createRequestErrorBody(attached.message, { code: attached.code }), {
              status: 409,
            })
          }
        }
```

Imports: `THREAD_CREATE_BODY_MAX_BYTES`, `stagedWorkspaceField` and `type StagedWorkspaceFieldValue` from `./thread-workspace-http.js`, and `import type { StagedWorkspaceReference } from "@b4run/workspace"`. (`stagedWorkspaces` requires a policy, so a create with `workspace` always takes the policy branch in which `isRowWeJustWrote` already runs.)

In the `DELETE /threads/:thread_id` handler, right after its `run_in_flight` refusal and before `sandboxManager.destroyThread`, forget the staged reference FIRST (item 7 of the review): if the checkpoint or row delete below fails, the surviving thread has no staged workspace and its resolver refuses it; and a thread later created under the same id through a run endpoint (which takes client-chosen ids) never inherits it.

```ts
        if (sandboxManager?.managed) sandboxManager.forgetStagedWorkspace(threadId)
```

`SandboxManager` gains the pass-throughs, with no option check (cleanup must work after the option is turned off):

```ts
  forgetStagedWorkspace(threadId: string): void {
    this.#managed?.forgetStagedWorkspace(threadId)
  }
  async sweepStagedThreads(exists: (threadId: string) => Promise<boolean>): Promise<readonly string[]> {
    return this.#managed ? this.#managed.sweepStagedThreads(exists) : []
  }
```

And at boot, in `runtime-fetch-core.ts` right after `reconcileDeletions` (`:530-535`), sweep the references of threads whose rows are gone (a crash between the detach and the row delete, or rows deleted behind the runtime's back):

```ts
    if (sandboxManager?.workspaceProtocol.staged && threadsStore) {
      const store = threadsStore
      // "Exists" means the store returns a row for the id.
      await sandboxManager.sweepStagedThreads(async (threadId) => Boolean(await store.getThread(threadId)))
    }
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @b4run/cli exec vitest run test/staged-workspace-endpoint.test.ts test/thread-access-coverage.test.ts test/thread-access-endpoints.test.ts test/fetch-entry-purity.test.ts test/managed-workspace-runtime.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/dev/thread-workspace-http.ts packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/src/lib/runtime/sandbox-manager.ts packages/cli/test/staged-workspace-endpoint.test.ts packages/cli/test/thread-access-coverage.test.ts
git commit -m "feat(cli): stage a workspace with PUT /workspace/sources and name it at POST /threads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 26: Documentation and changeset

**Files:**
- Modify: `apps/web/content/docs/sandbox.mdx` (a section after the one PR 2 added)
- Modify: `apps/web/content/docs/dev-server/agent-protocol.mdx` (the `POST /threads` row; a `PUT` row), `scripts/check-docs.mjs` (its `required` list)
- Modify: `apps/web/content/docs/thread-access.mdx` (`requestedWorkspace` row; `workspace.source.put`)
- Modify: `apps/web/content/docs/api/workspace.mdx`, `api/sqlite-storage.mdx` (`api/sdk.mdx` lists `ThreadAccessRequest` in one row and needs no change)
- Create: `.changeset/staged-workspaces.md`

- [ ] **Step 1: The sandbox page**

````mdx
## Handing a thread its workspace at creation

A creator on another host can give a new thread its exact workspace without a shared filesystem. Turn it on beside a resolver:

```ts
export default config({
  sandbox: {
    provider: dockerSandbox({ scope: "my-app", image: "node:24-slim" }),
    stagedWorkspaces: true,
    thread: async (thread) => {
      if (!thread.staged) throw new Error("create threads with a staged workspace")
      return { workspace: thread.staged }
    },
  },
})
```

The creator uploads the files as a `SourceBundle` (from `captureWorkspaceDefinition` or `createSourceBundle` in `@b4run/workspace/node`), then names them when it creates the thread:

```bash
curl -X PUT "$WORKER/workspace/sources/$DIGEST" -H "authorization: Bearer $TOKEN" --data-binary @source.json
curl -X POST "$WORKER/threads" -H "authorization: Bearer $TOKEN" \
  -d '{"metadata":{},"workspace":{"sourceDigest":"'$DIGEST'","environmentLinks":[],"baseline":"git"}}'
```

- **Verified, then recorded.** The upload is checked byte for byte against the digest in its path. The create is refused, before any thread exists, when the worker does not hold the source or the named links cannot sit beside its files. At the thread's first run the resolver receives the definition as `thread.staged`, and what it returns is recorded by digest and never resolved again.
- **Refused, not ignored.** A `workspace` sent to an app without `stagedWorkspaces` is `400 workspace_not_accepted`.
- **It needs a thread-access policy, and turning it on means auditing your `create` handler.** An upload arrives as `workspace.source.put`, a `create` with no thread; both it and a create that names a workspace carry `requestedWorkspace` (the upload's `{ sourceDigest }`, the create's whole reference), so one rule, `if (req.requestedWorkspace)`, decides who may stage and choose a workspace. A `create` handler written before this option admits both unless it checks that field. `b4 check`, `b4 build` and boot refuse the option without a policy.
- **Limits and retention.** An upload is at most `maxUploadBytes` (default and ceiling 96 MiB), and all uploaded sources together at most `maxStagedBytes` (default 1 GiB; `507 staged_quota_exceeded` past it). `POST /threads` bodies are at most 1 MiB in an app with the option. Sources nothing references (no thread names them, no workspace was made from them) are deleted once older than `retentionMs` (default 24 hours), when the worker starts and before each upload; a thread's reference goes when the thread is deleted.
- **Cost.** Verifying and storing an upload holds it several times over in the worker's memory (the body as text, the parsed bundle, its canonical JSON: about four to five times its size at the peak), so a worker takes one upload at a time and answers `429 upload_in_flight` (with `retry-after`) to a second. Lower `maxUploadBytes` on a small worker.
````

- [ ] **Step 2: The Agent Protocol and thread-access pages**

Agent Protocol table: the `POST /threads` row's request becomes ``Optional `{ "metadata": { ... }, "workspace": { "sourceDigest", "environmentLinks"?, "baseline"? } }` body, at most 1 MiB``, and add

```md
| `PUT /workspace/sources/:digest` | A `SourceBundle` whose `digest` is the path's | `201 { digest, status: "created" }` or `200 { digest, status: "held" }`. Only with `sandbox.stagedWorkspaces` and a thread-access policy. `400` `digest_mismatch`, `422` invalid bundle, `413` over `maxUploadBytes` |
```

with `"PUT /workspace/sources/:digest"` added to the page's `required` array in `scripts/check-docs.mjs`. Thread-access page: a `requestedWorkspace` row in "What the policy receives" ("The workspace the request stages or chooses: `{ sourceDigest }` on `workspace.source.put`, the whole reference `{ sourceDigest, environmentLinks?, baseline? }` on a `thread.create` that names one. `undefined` everywhere else. Enabling `stagedWorkspaces` means reviewing your `create` handler: check this field to decide who may stage and choose workspaces."), `workspace.source.put` beside `thread.workspace` in the workspace section.

- [ ] **Step 3: API pages**

`api/workspace.mdx`: `StagedWorkspaceReference`, `verifyStagedWorkspaceReference`, `stagedWorkspaceDefinition`; `WorkspaceResolverInput.staged`; `SandboxConfig.stagedWorkspaces`. `api/sqlite-storage.mdx`: `WorkspaceStagedSourceStore` ("Uploaded sources, each thread's staged reference, and reclaim of sources nothing references.") and `WorkspaceStagedSourceError`; `WorkspaceInstallation.staged`.

- [ ] **Step 4:** `node scripts/check-docs.mjs` → exit 0 (add whatever phrase or export it names).

- [ ] **Step 5: The changeset**

```md
---
"@b4run/cli": patch
"@b4run/workspace": patch
"@b4run/sqlite-storage": patch
"@b4run/sdk": patch
"@b4run/testing": patch
---

Hand a thread its workspace at creation. `sandbox.stagedWorkspaces` serves `PUT /workspace/sources/:digest` (a content-addressed `SourceBundle` upload, verified against its digest, one at a time, within `maxStagedBytes`) and accepts `workspace: { sourceDigest, environmentLinks?, baseline? }` on `POST /threads`; the app's resolver receives it as `thread.staged` at the thread's first admission, and unreferenced sources are reclaimed after `retentionMs`. The option needs a resolver and a thread-access policy; `b4 check`, `b4 build` and boot refuse it otherwise. Thread access gains the `workspace.source.put` operation and `requestedWorkspace` on the request (set on uploads and on creates that name a workspace), which is required: a hand-built `ThreadAccessRequest` needs `requestedWorkspace: undefined`. In an app with the option, `POST /threads` refuses a body over 1 MiB (`413`); in any app it refuses a `workspace` field it will not serve (`400`) rather than ignoring it.
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/content/docs scripts/check-docs.mjs .changeset/staged-workspaces.md
git commit -m "docs(sandbox): handing a thread its workspace at creation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 27: The PR 4 gate

- [ ] **Step 1:** `pnpm lint && pnpm build && pnpm typecheck && pnpm test` → exit 0.
- [ ] **Step 2:** `node scripts/check-docs.mjs && node scripts/check-changesets.mjs` → exit 0.
- [ ] **Step 3:** `pnpm check:release-inventory && pnpm pack:check` → exit 0.
- [ ] **Step 4:** `B4_TEST_DOCKER=1 pnpm --filter @b4run/sandbox test` → exit 0 (the Docker provider's bounded reads and readers, unchanged here, still pass under the typed error from PR 2).
- [ ] **Step 5:** open the PR; name the behaviour change in its body (a `workspace` field on `POST /threads` is refused by an app without the option; the 1 MiB limit applies only with it).

---

# PR 5: the factory hands workspaces over the protocol

```bash
git fetch origin
git switch -c blove/factory-staged-workspaces origin/main    # PR 3 and PR 4 merged
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@b4-example/software-factory-controller^...
```

After this PR no file passes between the controller and a worker. `dispatch` and `intake` capture as today, upload the capture's `SourceBundle` to the worker, and create the thread naming its digest; the builder's target block (image, pin, policy, permissions) travels as one strictly parsed metadata key bound to that digest (D13). Every manifest directory, manifest file, and the controller's removal machinery for them go. **Upgrade by draining**, as #836 did: a work order dispatched under PR 4's controller has a manifest and no staged workspace, and its builder thread (if not yet admitted) would be refused by name at admission after this PR.

### Task 28: The worker client uploads a source and creates a thread with it

**Files:**
- Modify: `examples/software-factory/controller/src/lib/worker/client.ts` (`WorkerClient`, `createHttpWorkerClient`)
- Modify: `examples/software-factory/controller/src/lib/worker/wire.ts` (`StagedSourceResponseSchema`)
- Modify: `examples/software-factory/controller/test/fake-worker.ts` (serve the upload; record `workspace`)
- Test: `examples/software-factory/controller/test/worker-client.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
  it("uploads a source, then creates a thread naming it", async () => {
    const bundle = createSourceBundle([
      { path: "a.txt", bytes: new TextEncoder().encode("a"), executable: false },
    ])
    expect(await client.uploadSource(bundle)).toBe("created")
    expect(await client.uploadSource(bundle)).toBe("held")
    const threadId = await client.createThread(
      { factoryWorkOrderId: "wo-1" },
      { sourceDigest: bundle.digest, environmentLinks: [], baseline: "git" },
    )
    expect(threadId).toMatch(/^fake-thread-/)
    const upload = fake.requests.find((r) => r.method === "PUT")
    expect(upload?.path).toBe(`/workspace/sources/${bundle.digest}`)
    expect(upload?.authorization).toBe(`Bearer ${TEST_WORKER_TOKEN}`)
    expect(fake.requests.at(-1)?.body).toEqual({
      metadata: { factoryWorkOrderId: "wo-1" },
      workspace: { sourceDigest: bundle.digest, environmentLinks: [], baseline: "git" },
    })
  })

  it("creates a thread with no workspace key when none is given", async () => {
    await client.createThread({ a: 1 })
    expect(fake.requests.at(-1)?.body).toEqual({ metadata: { a: 1 } })
  })
```

(`createSourceBundle` from `@b4run/workspace/node`; `LoggedRequest` already logs `method` and `path`, and PR 1 added `authorization`.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/worker-client.test.ts`
Expected: FAIL: `client.uploadSource is not a function`.

- [ ] **Step 3: Implement**

`wire.ts`:

```ts
/** `PUT /workspace/sources/:digest`'s answer. */
export const StagedSourceResponseSchema = z
  .object({ digest: z.string().regex(/^[0-9a-f]{64}$/), status: z.enum(["created", "held"]) })
  .strict()
```

`client.ts`: the interface gains

```ts
  /** Stage a workspace's files on the worker, content-addressed: `held` when it had them. */
  uploadSource(bundle: SourceBundle): Promise<"created" | "held">
  createThread(metadata: Record<string, unknown>, workspace?: StagedWorkspaceReference): Promise<string>
```

(its doc comment's count "seven" becomes "eight"), with `import type { SourceBundle, StagedWorkspaceReference } from "@b4run/workspace"`, and the implementation

```ts
    async uploadSource(bundle) {
      const response = await jsonRequest(`${base}/workspace/sources/${bundle.digest}`, {
        method: "PUT",
        body: JSON.stringify(bundle),
      })
      const staged = StagedSourceResponseSchema.parse(await response.json())
      if (staged.digest !== bundle.digest)
        throw new WorkerHttpError(response.status, "digest_mismatch", `The worker staged ${staged.digest}, not ${bundle.digest}`)
      return staged.status
    },
    async createThread(metadata, workspace) {
      const response = await jsonRequest(`${base}/threads`, {
        method: "POST",
        body: JSON.stringify({ metadata, ...(workspace !== undefined ? { workspace } : {}) }),
      })
      return ThreadSchema.parse(await response.json()).thread_id
    },
```

`fake-worker.ts`: answer `PUT /workspace/sources/:digest` by parsing the body, keeping the digest in a `Set`, and replying `201 { digest, status: "created" }` or `200 { digest, status: "held" }`; log it like every other request.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/worker-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/worker examples/software-factory/controller/test/fake-worker.ts examples/software-factory/controller/test/worker-client.test.ts
git commit -m "feat(software-factory): the worker client stages a source and creates a thread with it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 29: Handoffs replace manifests, on both sides

A handoff is what a manifest carried minus the workspace's files, plus the full reference the thread is created with (`workspace: { sourceDigest, environmentLinks, baseline? }`): the builder's target block, or the drafter's work order. The worker parses it strictly from one metadata key and refuses a staged workspace whose digest, links or baseline differ from the handoff's, so metadata and the whole staged definition are bound (D13).

**Files:**
- Rename: `examples/software-factory/controller/src/lib/builder-manifest.ts` → `builder-handoff.ts`; `drafter-manifest.ts` → `drafter-handoff.ts` (`git mv`)
- Rename: `examples/software-factory/server/src/builder-manifest.ts` → `builder-handoff.ts`; `examples/software-factory/drafter/src/drafter-manifest.ts` → `drafter-handoff.ts`
- Rename and modify: `controller/test/builder-manifest.test.ts` → `builder-handoff.test.ts`; `drafter-manifest.test.ts` → `drafter-handoff.test.ts`

- [ ] **Step 1: Write the failing tests**

In `builder-handoff.test.ts` (keep the existing "the two schema texts are identical" test, pointed at the renamed files and at `BuilderHandoffSchema`), add:

```ts
import { createSourceBundle } from "@b4run/workspace/node"
import {
  builderHandoffOf,
  refuseRetiredVariables,
  stagedBuilderWorkspace,
} from "../../server/src/builder-handoff.ts"

const DIGEST_SOURCE = createSourceBundle([{ path: "a.ts", bytes: new TextEncoder().encode("a"), executable: false }])
const handoff = {
  version: 3,
  workOrderId: "wo-1",
  taskId: "cli-flags",
  targetId: "cli-flags",
  workspace: { sourceDigest: DIGEST_SOURCE.digest, environmentLinks: [], baseline: "git" },
  target: {
    image: `b4-factory-cli-flags:${"a".repeat(12)}-${"b".repeat(12)}`,
    pin: "a".repeat(40),
    policy: {
      network: { mode: "deny" },
      env: {},
      resources: { memoryMb: 1024, cpus: 1, timeoutMs: 60_000 },
    },
    permissions: { bash: ["node "] },
  },
}
const staged = { version: 1 as const, source: DIGEST_SOURCE, environmentLinks: [], baseline: "git" as const }

describe("the builder's handoff", () => {
  it("reads factoryBuilder strictly from the thread's metadata", () => {
    expect(builderHandoffOf({ factoryWorkOrderId: "wo-1", factoryBuilder: handoff, route: "/build#agent" })).toEqual(handoff)
    expect(() => builderHandoffOf({ factoryWorkOrderId: "wo-1" })).toThrow(/factoryBuilder is required/)
    expect(() => builderHandoffOf({ factoryWorkOrderId: "wo-2", factoryBuilder: handoff })).toThrow(/names work order wo-1/)
    expect(() =>
      builderHandoffOf({ factoryWorkOrderId: "wo-1", factoryBuilder: { ...handoff, target: { ...handoff.target, netwrok: 1 } } }),
    ).toThrow(/factoryBuilder is invalid/)
  })

  it("serves only the staged workspace the handoff names", () => {
    expect(stagedBuilderWorkspace(staged, handoff as never).source.digest).toBe(DIGEST_SOURCE.digest)
    expect(() => stagedBuilderWorkspace(undefined, handoff as never)).toThrow(/without a staged workspace/)
    for (const workspace of [
      { ...handoff.workspace, sourceDigest: "f".repeat(64) },
      { ...handoff.workspace, environmentLinks: [{ path: "node_modules", target: "/opt/deps" }] },
      { sourceDigest: DIGEST_SOURCE.digest, environmentLinks: [] },
    ])
      expect(() => stagedBuilderWorkspace(staged, { ...handoff, workspace } as never)).toThrow(
        /is not the one work order wo-1 names/,
      )
  })

  it("refuses the retired manifest directory by name", () => {
    expect(() => refuseRetiredVariables({ FACTORY_BUILDER_MANIFEST_DIR: "/m" })).toThrow(/FACTORY_BUILDER_MANIFEST_DIR is retired/)
  })
})
```

and the drafter's equivalent in `drafter-handoff.test.ts` (`drafterHandoffOf`, `stagedDrafterWorkspace`, which also refuses a staged workspace carrying a `baseline`, and `refuseRetiredVariables` for `FACTORY_DRAFTER_MANIFEST_DIR`).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/builder-handoff.test.ts test/drafter-handoff.test.ts`
Expected: FAIL: the modules do not exist.

- [ ] **Step 3: The builder side** (`examples/software-factory/server/src/builder-handoff.ts`)

Keep `CATALOG_ID`, `FACTORY_IMAGE`, `isFactoryImage`, `describe` and `workOrderIdOf` from the manifest module. Replace `BuilderManifestSchema` with `BuilderHandoffSchema`, identical except `version: z.literal(3)`, and in place of `workspace: z.unknown()` the reference the thread is created with:

```ts
    workspace: z
      .object({
        sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
        environmentLinks: z.array(z.object({ path: z.string().min(1), target: z.string().min(1) }).strict()),
        baseline: z.literal("git").optional(),
      })
      .strict(),
```

and its doc comment ("the builder's one input per thread besides its staged workspace, carried in thread metadata under `factoryBuilder`"). Delete `builderManifestDir` and `loadBuilderManifest`. Add:

```ts
/**
 * The work order's target, from the thread's metadata. Metadata is client input, and only
 * the controller can create a thread (src/thread-access.ts), so this key is as
 * controller-authored as the manifest file was; it is still parsed strictly, and a key this
 * schema does not model is a refusal at admission, never a drop to a broader default.
 */
export function builderHandoffOf(metadata: Readonly<Record<string, unknown>>): BuilderHandoff {
  const workOrderId = workOrderIdOf(metadata)
  const raw = Object.hasOwn(metadata, "factoryBuilder") ? metadata.factoryBuilder : undefined
  if (raw === undefined)
    throw new Error(
      "thread metadata factoryBuilder is required: the controller creates a builder thread with its work order's target",
    )
  let handoff: BuilderHandoff
  try {
    handoff = BuilderHandoffSchema.parse(raw)
  } catch (error) {
    throw new Error(`thread metadata factoryBuilder is invalid: ${describe(error)}`, { cause: error })
  }
  if (handoff.workOrderId !== workOrderId)
    throw new Error(`thread metadata factoryBuilder names work order ${handoff.workOrderId}, not ${workOrderId}`)
  return handoff
}

/** The staged workspace, only when it is the one the handoff names. */
export function stagedBuilderWorkspace(
  staged: CapturedWorkspaceDefinition | undefined,
  handoff: BuilderHandoff,
): CapturedWorkspaceDefinition {
  if (staged === undefined)
    throw new Error(`work order ${handoff.workOrderId}'s thread was created without a staged workspace`)
  // The whole reference, not only the digest: links and baseline change what the thread runs.
  const named = JSON.stringify([
    handoff.workspace.sourceDigest,
    [...handoff.workspace.environmentLinks].sort((a, b) => (a.path < b.path ? -1 : 1)),
    handoff.workspace.baseline ?? null,
  ])
  const got = JSON.stringify([staged.source.digest, staged.environmentLinks, staged.baseline ?? null])
  if (got !== named)
    throw new Error(
      `the staged workspace ${got} is not the one work order ${handoff.workOrderId} names (${named})`,
    )
  return verifyCapturedWorkspaceDefinition(staged)
}
```

and `refuseRetiredVariables` refuses `FACTORY_BUILDER_MANIFEST_DIR` too, in the same form as its existing refusal: `"FACTORY_BUILDER_MANIFEST_DIR is retired: the controller stages each work order's workspace over the Agent Protocol. Unset it"`.

- [ ] **Step 4: The controller side** (`controller/src/lib/builder-handoff.ts`)

The same schema text (the equality test pins it). `writeBuilderManifest` becomes:

```ts
export interface CapturedBuilderHandoff {
  readonly handoff: BuilderHandoff
  readonly workspace: CapturedWorkspaceDefinition
}

/**
 * Capture `task`'s workspace (the target's pinned subtree with the task's defect applied) and
 * its handoff. Nothing is written: `dispatch` uploads the source and creates the thread with
 * the handoff. The staging directory is per call and removed once the capture has read it.
 */
export async function captureBuilderHandoff(
  task: Task,
  options: CaptureBuilderHandoffOptions,
): Promise<CapturedBuilderHandoff>
```

with the body of `writeBuilderManifest` up to the capture unchanged, then

```ts
  const handoff = BuilderHandoffSchema.parse({
    version: 3,
    workOrderId,
    taskId: task.id,
    targetId: task.target.id,
    workspace: stagedReferenceOf(workspace),
    target: {
      image: imageTag(task.target),
      pin: task.target.pin,
      policy: targetSandboxPolicy(task.target),
      permissions: builderPermissions(task.target),
    },
  })
  return { handoff, workspace }
```

(`CaptureBuilderHandoffOptions` is `WriteBuilderManifestOptions` without the directory.) Add the reference helper both handoff modules use:

```ts
/** What `POST /threads` names: the links and baseline, which the source digest does not cover. */
export function stagedReferenceOf(workspace: CapturedWorkspaceDefinition): StagedWorkspaceReference {
  return {
    sourceDigest: workspace.source.digest,
    environmentLinks: workspace.environmentLinks,
    ...(workspace.baseline !== undefined ? { baseline: workspace.baseline } : {}),
  }
}
```

- [ ] **Step 5: The drafter, both sides**

`DrafterHandoffSchema = z.object({ version: z.literal(2), workOrderId: z.string().regex(CATALOG_ID), workspace: z.object({ sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), environmentLinks: z.array(z.object({ path: z.string().min(1), target: z.string().min(1) }).strict()) }).strict() }).strict()` in both copies (no `baseline`: the drafter's capture has none); the controller's `captureDrafterHandoff({ workOrderId, pin, repositoryRoot, captureRoot, signal })` returns `{ handoff, workspace }` from the existing capture; the drafter's `drafterHandoffOf(metadata)` reads `factoryDrafter` exactly as `builderHandoffOf` reads `factoryBuilder`, and

```ts
export function stagedDrafterWorkspace(
  staged: CapturedWorkspaceDefinition | undefined,
  handoff: DrafterHandoff,
): CapturedWorkspaceDefinition {
  if (staged === undefined)
    throw new Error(`work order ${handoff.workOrderId}'s intake thread was created without a staged workspace`)
  // The drafter's capture has no `.git` to diff against; a baseline would be a different workspace.
  if (staged.baseline !== undefined) throw new Error("a drafter workspace carries no baseline")
  const named = JSON.stringify([
    handoff.workspace.sourceDigest,
    [...handoff.workspace.environmentLinks].sort((a, b) => (a.path < b.path ? -1 : 1)),
  ])
  const got = JSON.stringify([staged.source.digest, staged.environmentLinks])
  if (got !== named)
    throw new Error(`the staged workspace ${got} is not the one work order ${handoff.workOrderId} names (${named})`)
  return verifyCapturedWorkspaceDefinition(staged)
}
```

plus a drafter `refuseRetiredVariables(env = process.env)` that throws `"FACTORY_DRAFTER_MANIFEST_DIR is retired: the controller stages each intake's workspace over the Agent Protocol. Unset it"` when the variable is set.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/builder-handoff.test.ts test/drafter-handoff.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A examples/software-factory/controller/src/lib/builder-handoff.ts examples/software-factory/controller/src/lib/builder-manifest.ts examples/software-factory/controller/src/lib/drafter-handoff.ts examples/software-factory/controller/src/lib/drafter-manifest.ts examples/software-factory/server/src examples/software-factory/drafter/src examples/software-factory/controller/test/builder-handoff.test.ts examples/software-factory/controller/test/builder-manifest.test.ts examples/software-factory/controller/test/drafter-handoff.test.ts examples/software-factory/controller/test/drafter-manifest.test.ts
git commit -m "feat(software-factory): handoffs in thread metadata replace manifest files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`git add -A <paths>` stages the renames' deletions under exactly these paths; never a bare `git add -A`.)

### Task 30: Dispatch and intake stage over the protocol; the manifest machinery goes

**Files:**
- Modify: `examples/software-factory/controller/src/lib/controller/factory.ts` (dispatch `:1194-1256`, intake `:920-990`, the `leftIntake`/`leftBuild` removals `:390-412`, `removeBuilderManifest` `:563-567`, `finishCancel` `:644-651`, the options `writeDrafterManifest`/`writeBuilderManifest`)
- Modify: `examples/software-factory/controller/src/lib/controller/intake.ts` (`removeDrafterManifest`, `:14`, `:441-450`)
- Modify: `examples/software-factory/controller/src/lib/controller/reconcile.ts` (`:6`, `:47`, `:82`)
- Delete: `examples/software-factory/controller/src/lib/controller/manifest-files.ts`
- Modify: `examples/software-factory/server/b4.config.ts`, `examples/software-factory/drafter/b4.config.ts`
- Test: `factory-builder-manifest.test.ts` → `factory-builder-handoff.test.ts`, `factory-dispatch.test.ts`, `factory-intake.test.ts`, `factory-cancel.test.ts`, `factory-reconcile.test.ts`

- [ ] **Step 1: Write the failing tests**

In `factory-builder-handoff.test.ts` (the renamed file; its fake worker map now carries no `manifestDir`):

```ts
  it("stages the workspace, then creates the thread with the handoff and the reference", async () => {
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
    const staged = factory.events(id).find((e) => e.type === "builder_source_staged")?.payload
    expect(staged).toMatchObject({ sourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/), status: "created" })
    const create = fake.requests.find((r) => r.method === "POST" && r.path === "/threads")?.body as {
      metadata: {
        factoryWorkOrderId: string
        factoryBuilder: { workOrderId: string; workspace: { sourceDigest: string; baseline?: string } }
      }
      workspace: { sourceDigest: string; baseline?: string }
    }
    expect(create.metadata.factoryWorkOrderId).toBe(id)
    expect(create.metadata.factoryBuilder.workOrderId).toBe(id)
    // The handoff carries exactly the reference the thread is created with.
    expect(create.metadata.factoryBuilder.workspace).toEqual(create.workspace)
    expect(create.workspace).toMatchObject({ sourceDigest: staged?.sourceDigest, baseline: "git" })
    expect(factory.events(id).map((e) => e.type).filter((t) => t.includes("manifest"))).toEqual([])
  })

  it("refuses the dispatch, with no thread, when the upload fails", async () => {
    fake.failNext("PUT", 500)
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect(await factory.dispatch(id)).toMatchObject({ ok: false, message: expect.stringMatching(/could not be staged/) })
    expect(fake.requests.some((r) => r.method === "POST" && r.path === "/threads")).toBe(false)
  })
```

(`failNext(method, status)` is a small addition to `fake-worker.ts`: the next request of that method answers that status with an error body.) `source-digest.test.ts` already covers `builder_source_staged` (PR 3 accepts both spellings) and needs no change. Delete the cases in `factory-cancel.test.ts`, `factory-reconcile.test.ts` and `factory-intake.test.ts` that assert `*_manifest_removed`, `*_manifest_kept`, `*_manifest_remove_failed` or a file under a manifest directory; the equivalent obligation is gone, and an upload no thread names is reclaimed by the worker (D7).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-builder-handoff.test.ts`
Expected: FAIL: no `builder_source_staged` event.

- [ ] **Step 3: Dispatch**

Replace the manifest block and the thread creation in `dispatch` with:

```ts
      // The workspace first: the builder serves only the staged source the thread names, and
      // refuses a create naming one it does not hold. The pin is already in the object store
      // (the prompt lookup above fetched it), so this fails only on the capture or the upload.
      let captured: CapturedBuilderHandoff
      try {
        captured = await (options.captureBuilderHandoff ?? captureBuilderHandoffFromCatalog)({
          taskId: row.taskId,
          workOrderId: id,
          signal: abort.signal,
        })
        const status = await worker.client.uploadSource(captured.workspace.source)
        recordEvent(id, "builder_source_staged", {
          sourceDigest: captured.handoff.workspace.sourceDigest,
          status,
        })
      } catch (error) {
        recordEvent(id, "builder_source_failed", { error: String(error) })
        return finish(key, {
          ok: false,
          state: row.state,
          message: `builder workspace could not be staged: ${String(error)}`,
        })
      }
      let threadId: string
      try {
        threadId = await worker.client.createThread(
          { factoryWorkOrderId: id, factoryBuilder: captured.handoff },
          stagedReferenceOf(captured.workspace),
        )
      } catch (error) {
        // Nothing to remove: an upload no thread names is reclaimed by the builder once it
        // is older than its retention window.
        return finish(key, { ok: false, state: row.state, message: `Thread creation failed: ${String(error)}` })
      }
```

and in the orphan branch below delete the `removeOwnManifest(...)` call and its comment. `options.writeBuilderManifest` becomes `captureBuilderHandoff?: (input: { taskId: string; workOrderId: string; signal: AbortSignal }) => Promise<CapturedBuilderHandoff>`, and `writeBuilderManifestFromCatalog` becomes `captureBuilderHandoffFromCatalog` (the same catalog lookup, calling `captureBuilderHandoff(task, { workOrderId, captureRoot: options.captureRoot, signal })`).

- [ ] **Step 4: Intake**

The same shape in `intake`: `captureDrafterHandoff` (injected as `options.captureDrafterHandoff`, default the real one), `drafterWorker.client.uploadSource(captured.workspace.source)`, event `drafter_source_staged { sourceDigest, status }`, failure event `drafter_source_failed` and refusal `drafter workspace could not be staged: …`, and

```ts
          threadId = await drafterWorker.client.createThread(
            { factoryWorkOrderId: id, factoryStage: "intake", factoryDrafter: captured.handoff },
            stagedReferenceOf(captured.workspace),
          )
```

with the two `removeOwnManifest` calls deleted.

- [ ] **Step 5: Delete the manifest machinery**

Delete `manifest-files.ts`; in `factory.ts` delete `leftIntake`, `leftBuild`, `pendingRemovals`, `pendingBuilderRemovals` and the code that flushes them, `removeBuilderManifest`, and the two removals (plus `removeUnhandedManifest` twice) in `finishCancel`; in `intake.ts` delete `removeDrafterManifest` and its callers; in `reconcile.ts` delete both `removeUnhandedManifest` calls and their comments. Then:

Run: `git grep -n -i "manifest" examples/software-factory/controller/src`
Expected: no hit except words in comments that describe the old design; reword those to "handoff" or delete them.

`source-digest.ts` needs no change: it has read both event spellings since PR 3.

- [ ] **Step 6: The workers resolve from the staged workspace**

`server/b4.config.ts`:

```ts
import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import {
  builderHandoffOf,
  isFactoryImage,
  refuseRetiredVariables,
  stagedBuilderWorkspace,
} from "./src/builder-handoff.js"

refuseRetiredVariables()

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    provider: dockerSandbox({ scope: "software-factory-builder", images: isFactoryImage }),
    network: { mode: "deny" },
    workspaceRead: "http",
    // The controller uploads each work order's captured source and creates the thread naming
    // it, with the work order's target in `factoryBuilder`. Both are checked here, bound by
    // digest, and recorded at first admission; nothing is read from disk.
    stagedWorkspaces: true,
    thread: async (thread) => {
      const handoff = builderHandoffOf(thread.metadata)
      return {
        workspace: stagedBuilderWorkspace(thread.staged, handoff),
        environment: { image: handoff.target.image },
        policy: handoff.target.policy,
        permissions: { allow: handoff.target.permissions },
      }
    },
  },
  // toolOutput and permissions unchanged
})
```

`drafter/b4.config.ts`: drop `drafterManifestDir`, call the drafter's `refuseRetiredVariables()`, add `stagedWorkspaces: true`, and resolve with

```ts
    workspace: async (thread) => stagedDrafterWorkspace(thread.staged, drafterHandoffOf(thread.metadata)),
```

`server/package.json` and `drafter/package.json`: the `check`, `build` and `dev` scripts drop their `FACTORY_*_MANIFEST_DIR=...` prefixes (`"check": "node scripts/in-lane.mjs b4 check"`, `"build": "node scripts/in-lane.mjs b4 build"`, `"dev": "b4 dev"` for the builder; `"check": "b4 check"`, `"build": "b4 build"` for the drafter); `server/scripts/in-lane.mjs`'s header drops the sentence about the manifest directory.

- [ ] **Step 7: Run the controller's and the workers' tests**

Run: `pnpm --filter "@b4-example/software-factory-*" typecheck && pnpm --filter "@b4-example/software-factory-*" test`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A examples/software-factory/controller/src examples/software-factory/controller/test examples/software-factory/server examples/software-factory/drafter
git commit -m "feat(software-factory): dispatch and intake stage workspaces over the protocol

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 31: The controller's configuration, the CI lane, and both workflow-audit fixtures

**Files:**
- Modify: `examples/software-factory/controller/src/lib/config.ts` (`RETIRED`; `manifestDir` gone)
- Modify: `examples/software-factory/controller/src/lib/controller/workers.ts`, `runtime.ts`, `test/config.test.ts`, `test/serve-controller.ts`, `test/fake-worker-map.ts`
- Modify: `.github/workflows/ci.yml:461-476` (comment and the `run` block)
- Modify: `turbo.json:59-76` (the workers' `env` lists)
- Modify: `scripts/release/test/fixtures/workflow-entrypoints.json`, `scripts/release/test/fixtures/workflow-safe-executables.json`

- [ ] **Step 1: The configuration**

`config.ts`: `RETIRED` gains

```ts
  FACTORY_BUILDER_MANIFEST_DIR:
    "dispatch stages the workspace over the builder's Agent Protocol port; no directory is shared",
  FACTORY_DRAFTER_MANIFEST_DIR:
    "intake stages the workspace over the drafter's Agent Protocol port; no directory is shared",
```

`EnvSchema` loses both; `WorkerEndpoint` and `DrafterEndpoint` lose `manifestDir`; the drafter is configured by `FACTORY_DRAFTER_URL` alone, and the stray-variable check lists only `FACTORY_DRAFTER_ROUTE`. `workers.ts`: `TargetWorker` and `DrafterWorker` lose `manifestDir`; `DRAFTER_UNCONFIGURED = "intake is not configured: set FACTORY_DRAFTER_URL"`. Tests follow: `config.test.ts` gains the two refusals (`toThrow(/FACTORY_BUILDER_MANIFEST_DIR is retired/)` and the drafter's) and `baseEnv()` loses the variable; `serve-controller.ts` and `fake-worker-map.ts` drop it.

Run: `pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller test` → exit 0.

- [ ] **Step 2: `turbo.json`**

The retired variables leave the workers' cache keys: `@b4-example/software-factory-server#build` and `#check` keep `["FACTORY_BUILDER_LANE"]` (and `#check` its `passThroughEnv` from PR 1); `@b4-example/software-factory-drafter#build` and `#check` keep `["FACTORY_DRAFTER_IMAGE"]`, which the drafter still reads for its own image (only the controller stopped reading it, in PR 3), and `#check` its `passThroughEnv`. `FACTORY_BUILDER_MANIFEST_DIR` and `FACTORY_DRAFTER_MANIFEST_DIR` appear nowhere in `turbo.json` afterwards.

- [ ] **Step 3: Edit `ci.yml` and both fixtures with one script, in raw text**

The fixtures embed each workflow step's `run` block as one JSON string; a JSON round trip would re-escape non-ASCII and show a phantom diff (memory of #763 and `project_workflow_entrypoint_audit`), so edit raw text and check the counts:

```bash
python3 - <<'EOF'
import pathlib
edits = {
    ".github/workflows/ci.yml": [
        ('          mkdir -p "$RUNNER_TEMP/factory-builder/manifests"\n', ""),
        ('FACTORY_BUILDER_MANIFEST_DIR="$RUNNER_TEMP/factory-builder/manifests" ', ""),
    ],
    "scripts/release/test/fixtures/workflow-entrypoints.json": [
        ('mkdir -p \\"$RUNNER_TEMP/factory-builder/manifests\\"\\n', ""),
        ('FACTORY_BUILDER_MANIFEST_DIR=\\"$RUNNER_TEMP/factory-builder/manifests\\" ', ""),
    ],
    "scripts/release/test/fixtures/workflow-safe-executables.json": [
        ('mkdir -p \\"$RUNNER_TEMP/factory-builder/manifests\\"\\n', ""),
        ('FACTORY_BUILDER_MANIFEST_DIR=\\"$RUNNER_TEMP/factory-builder/manifests\\" ', ""),
    ],
}
expected = {0: 1, 1: 2}  # one mkdir line, two variable prefixes, in each file
for path, pairs in edits.items():
    file = pathlib.Path(path)
    text = file.read_text()
    for index, (old, new) in enumerate(pairs):
        found = text.count(old)
        assert found == expected[index], f"{path}: expected {expected[index]} of {old!r}, found {found}"
        text = text.replace(old, new)
    file.write_text(text)
    print(f"{path}: edited")
EOF
git diff --stat .github/workflows/ci.yml scripts/release/test/fixtures
```

Expected: `ci.yml` 3 lines changed; each fixture exactly 1 line changed (its one `run` string). Then update the step's comment above `run:` in `ci.yml` (the sentence that says `check` and `build` "default their manifest directory"): the builder checks and builds with no manifest directory; its threads are staged over the protocol.

If `pnpm --filter @b4-example/software-factory-server check` refuses `FACTORY_BUILDER_MANIFEST_DIR` in a developer's shell, unset it: `refuseRetiredVariables` is doing its job.

- [ ] **Step 4: The workflow audit**

Run: `node --test scripts/release/test/workflow-contracts.test.mjs && pnpm test:release-integrity`
Expected: PASS. On a failure the audit prints one opaque string; to see the difference, copy the repository to a scratch directory, run the fixture generator the test names against the edited `ci.yml`, and diff its output with the committed fixture, then apply only the differing `run` line by the script above.

Run: `pnpm test:release-controller`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/config.ts examples/software-factory/controller/src/lib/controller/workers.ts examples/software-factory/controller/src/lib/runtime.ts examples/software-factory/controller/test turbo.json .github/workflows/ci.yml scripts/release/test/fixtures/workflow-entrypoints.json scripts/release/test/fixtures/workflow-safe-executables.json
git commit -m "ci(software-factory): no manifest directory for the builder lane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 32: The Docker lanes run with no manifest directory, and the README

**Files:**
- Modify: `examples/software-factory/controller/test/served-builder.ts` (no `manifestDir`; a `handOff` helper), `isolated-drafter.ts` or the drafter lanes' own helper
- Modify: `examples/software-factory/controller/test/builder.integration.test.ts`, `end-to-end.integration.test.ts`, `devkit-end-to-end.integration.test.ts`, `drafter-end-to-end.integration.test.ts`, `drafter-resolver.integration.test.ts`
- Modify: `examples/software-factory/README.md`, `docs/superpowers/runbooks/software-factory-rung2-developer-guide.md`

- [ ] **Step 1: The served builder hands a work order over the protocol**

`served-builder.ts`: drop `FACTORY_BUILDER_MANIFEST_DIR` from `ENV` and the `manifestDir` field; replace `createThread(workOrderId)` with

```ts
    /** Upload a captured handoff's source and create its thread, as `dispatch` does. */
    async handOff(captured: CapturedBuilderHandoff) {
      const client = createHttpWorkerClient(url, { token: TEST_WORKER_TOKEN })
      await client.uploadSource(captured.workspace.source)
      return client.createThread(
        { factoryWorkOrderId: captured.handoff.workOrderId, factoryBuilder: captured.handoff },
        stagedReferenceOf(captured.workspace),
      )
    },
```

and every lane that wrote a manifest and created a thread (`writeBuilderManifest(task, served.manifestDir, …)` then `served.createThread(id)`) calls `served.handOff(await captureBuilderHandoff(task, { workOrderId: id, captureRoot: dir }))`. The builder lane's refusal case becomes "refuses, at admission and by name, a thread created without a staged workspace, or with a foreign image", creating one thread with `{ factoryWorkOrderId, factoryBuilder }` and no `workspace` (its first run fails naming "without a staged workspace") and one with a handoff whose image names another target (refused by the schema). Do the same for the drafter's lanes.

- [ ] **Step 2: The proof: no manifest directory anywhere**

In `end-to-end.integration.test.ts`, replace the manifest assertions (`builder_manifest_written`, `readdir(served.manifestDir)`, `builder_manifest_removed`) with:

```ts
  // Handed over the protocol: the digest the controller staged is the one the builder
  // recorded, and nothing was written for the builder to read.
  const staged = factory.events(id).find((e) => e.type === "builder_source_staged")?.payload
  const installation = openWorkspaceInstallationReader(served.appRoot)
  try {
    expect(installation.associations.get(threadId)?.intent.sourceDigest).toBe(staged?.sourceDigest)
  } finally {
    installation.close()
  }
  expect(existsSync(join(served.appRoot, ".factory"))).toBe(false)
  expect(process.env.FACTORY_BUILDER_MANIFEST_DIR).toBeUndefined()
```

and the same in `drafter-end-to-end.integration.test.ts` for `drafter_source_staged` and the drafter's app root.

- [ ] **Step 3: Run the Docker lane as CI does**

Run: the `sandbox-docker` job's software-factory `run` block, locally, as edited in Task 31 (`pnpm turbo run build --filter=@b4-example/software-factory-controller^...`, both `target:prepare` lines, `FACTORY_BUILDER_LANE=1 pnpm --filter @b4-example/software-factory-server check`, `... build`, the drafter image pull, the drafter `check` and `build`, and `pnpm --filter @b4-example/software-factory-controller test:sandbox`).
Expected: exit 0.

- [ ] **Step 4: README and runbook**

`examples/software-factory/README.md`: delete every `FACTORY_*_MANIFEST_DIR` (tables, quickstart, the paragraphs on manifest lifetimes and cleanup); in the builder's and drafter's sections, replace "reads `<dir>/<workOrderId>.json`" with the handoff; and replace the handover paragraph with

```md
**How a worker gets its workspace.** `dispatch` (and `intake`) capture the workspace in the
controller, upload its files to the worker (`PUT /workspace/sources/<digest>`), and create the
thread naming that digest, with the work order's target in `factoryBuilder` (the drafter's in
`factoryDrafter`). The worker verifies the upload byte for byte, refuses a create naming a
source it does not hold, checks that the target block and the files name the same digest, and
records both at the thread's first run. An upload no thread names is deleted by the worker after
24 hours. No directory, file or host is shared between the controller and a worker: set
`FACTORY_WORKER_URL`, `FACTORY_DRAFTER_URL` and `FACTORY_WORKER_TOKEN`, and the workers may run
anywhere the controller can reach.
```

plus an "Upgrading" line: drain in-flight work orders before upgrading past this change (a thread dispatched with a manifest and not yet run is refused at admission). Update the rung 2 developer guide the same way (`grep -n "MANIFEST" docs/superpowers/runbooks/software-factory-rung2-developer-guide.md`).

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/test examples/software-factory/README.md docs/superpowers/runbooks/software-factory-rung2-developer-guide.md
git commit -m "test(software-factory): the lanes run with no manifest directory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 33: The PR 5 gate

- [ ] **Step 1:** `pnpm lint` → exit 0.
- [ ] **Step 2:** `pnpm --filter "@b4-example/software-factory-*" typecheck && pnpm --filter "@b4-example/software-factory-*" test` → exit 0.
- [ ] **Step 3:** `node --test scripts/release/test/workflow-contracts.test.mjs && pnpm test:release-integrity && pnpm test:release-controller` → exit 0 (`ci.yml` changed).
- [ ] **Step 4:** the `sandbox-docker` software-factory block (Task 32 Step 3) → exit 0.
- [ ] **Step 5:** `node scripts/check-changesets.mjs` → passes with none; `node scripts/check-docs.mjs` → exit 0 (the runbook is under `docs/superpowers/`, outside its scan).
- [ ] **Step 6:** `git grep -n "MANIFEST_DIR\|_APP_ROOT" examples/software-factory .github turbo.json docs/superpowers/runbooks scripts/release/test/fixtures` → hits only in the controller's `RETIRED` table, the workers' `refuseRetiredVariables`, and the tests that pin those refusals. `git grep -n "FACTORY_DRAFTER_IMAGE" examples/software-factory/controller turbo.json` → only the controller's `RETIRED` table and the drafter's `turbo.json` entries.

---

## Follow-ups recorded, not in this plan

- **Bound every request body.** `runs/stream`, `runs/wait`, `resume` and `POST /agui/:routeId` still read `request.text()` unbounded (`runtime-fetch-core.ts:1975, 2341, 3239`, `agui-handler.ts:252`). `readBoundedText` is ready; the limit is a behaviour change for every app and needs its own changeset and a documented default.
- **Reclaim orphan sources in every managed app.** D7 reclaims only when `stagedWorkspaces` is on. The same sweep (sources of deleted associations; pre-#832 orphans) could run at boot for every managed installation.
- **A stale thread pins its source forever.** A thread created with a staged workspace and never deleted keeps its source past the window; a thread-retention policy (or the factory deleting settled threads) is what bounds it.
- **CORS for uploads.** `server.cors.methods` defaults to `GET, POST, DELETE, OPTIONS` (`packages/cli/src/lib/dev/cors.ts:31`); a browser that stages a workspace cross-origin needs `PUT` added. Server-to-server callers are unaffected.
- **`factory up`/`run` glue** (spec §7): with PRs 1 to 5 the glue needs one URL per worker and one token; it can mint the token per run.
- **The drafter folded into the builder app** (per-thread sandbox plan's follow-up) is now purely a packaging choice: both apps take their workspace the same way.

## Self-review against the spec

- §3 "Change": the endpoint (Task 11) with `root` moved into `inspectWorkspace` (Task 5); served with the controller's code, `openManagedWorkspaceReader`-equivalent through the manager's own installation, then `inspectWorkspace` (Task 10); refuses while a run is in flight, holding the slot (Task 11, D9); `thread.workspace` under `read` (Task 7); off unless `sandbox.workspaceRead: "http"`, refused at boot without a policy (Task 9, and at check and build too), shape-validated so a misspelling fails closed (Task 9); `readThreadWorkspace(url, threadId, options, { headers })` beside `withManagedWorkspaceReader` (Task 12).
- §3 "Trust impact": same networkless read-only reader, no exec, no write (Task 10 uses the provider's reader only); `sourceDigest` checked against the handed source (Task 12 `expectedSourceDigest`, Task 16 `handedSourceDigest`); opt-in and gated (Task 9).
- §3 "Proof": inspection equals the local reader's on an idle thread; 409 during a run; 403 without the token; `root` refuses `..` and an absent directory by name (Task 11); factory Docker lane with no path to the worker's `.b4` (Tasks 17, 18).
- §2 "Change": content-addressed upload into the installation's content store (Tasks 21, 24, 25; body a `SourceBundle`, D5); a reference at creation (Task 25); verification with digest equal to the path (Task 24 `stageSource`); refusal of an unheld digest (Task 25, before any row); digest recorded outside client metadata (Task 21 `workspace_thread_staged`, D6); `WorkspaceResolverInput.staged` (Task 20, returned as is by the factory's resolvers, Task 30); off unless `sandbox.stagedWorkspaces`, refused at boot without a policy (Task 23); `workspace.source.put` (Task 22); retention-window reclaim including rung 3 §9's orphan sources (Tasks 21, 24, D7).
- §2 "Trust impact": source captured by the controller, verified by digest at the worker, recorded in the intent (Tasks 24, 25 proof); control point moved to the policy's token (PR 1); option impossible without a policy (Task 23); request body limit (Task 8, used in Tasks 11 and 25, D3).
- §2 "Proof": upload, create, first run, `intent.sourceDigest` equal to the upload; an unheld digest refused before any thread row; a body whose digest differs refused; 403 without the token (Task 25); the option without a policy refused at boot (Task 23); factory lanes with no manifest directory (Task 32).
- §8 order and "one policy": PR 1 lands the token before either item; 3 before 2 (PRs 2 and 3 before 4 and 5); both items gated by the same policy file.
- Conventions: shape validation that fails closed (Tasks 9, 23), `sandbox` unknown keys still refused (the two keys added to `SANDBOX_KEYS`), `exactOptionalPropertyTypes` spreads throughout, `.js`/`.ts` specifiers, core purity checked (Tasks 8, 9, 11, 25), patch changesets in the fixed group (Tasks 13, 26; none for private examples), docs on existing pages with no lastmod regeneration, workflow-audit fixtures edited in raw text with counts (Task 31), `test:release-controller` when `ci.yml` changes (Tasks 31, 33).
- Names used consistently: `WorkspaceReadLimitError`, `isWorkspaceReadLimitError`, `WorkspaceInspectionError`, `isWorkspaceInspectionError`, `WorkspaceInspectionErrorCode`, `WorkspaceInspectionErrorDetail`, `readBoundedText`, `RequestBodyTooLargeError`, `payloadTooLarge`, `WorkspaceProtocolSettings`, `NO_WORKSPACE_PROTOCOL`, `workspaceProtocolOptionNames`, `openedWorkspaceProtocol`, `workspaceProtocolPolicyMessage`, `ThreadWorkspaceInspectRequest`, `ThreadWorkspaceInspectOutcome`, `ThreadWorkspaceInspectFailure`, `inspectFailure`, `inspectThread`, `parseThreadWorkspaceRequest`, `threadWorkspaceResponse`, `INSPECT_BODY_MAX_BYTES`, `INSPECT_CAPS`, `INSPECT_DEFAULTS`, `readThreadWorkspace`, `ThreadWorkspaceReadError`, `ThreadWorkspaceRead`, `StagedWorkspaceReference`, `verifyStagedWorkspaceReference`, `stagedWorkspaceDefinition`, `WorkspaceStagedSourceStore`, `WorkspaceStagedSourceError`, `STAGED_UPLOAD_MAX_BYTES`, `StagedWorkspaceSettings`, `stagedWorkspaceSettings`, `StageSourceOutcome`, `StagedWorkspaceCheck`, `StagedWorkspaceAttach`, `stageSource`, `checkStagedWorkspace`, `attachStagedWorkspace`, `reclaimStagedSources`, `THREAD_CREATE_BODY_MAX_BYTES`, `stagedWorkspaceField`, `createHttpThreadWorkspaceReader`, `handedSourceDigest`, `BuilderHandoffSchema`, `builderHandoffOf`, `stagedBuilderWorkspace`, `captureBuilderHandoff`, `stagedReferenceOf`, `DrafterHandoffSchema`, `drafterHandoffOf`, `stagedDrafterWorkspace`, `captureDrafterHandoff`, `TEST_WORKER_TOKEN`, and from the review amendments `isCanonicalWorkspaceRoot`, `isCanonicalRoot`, `drainableBody`, `ThreadAccessRequestedWorkspace`, `StagedWorkspaceFieldValue`, `STAGED_QUOTA_DEFAULT_BYTES`, `STAGED_QUOTA_MAX_BYTES`, `forgetStagedWorkspace`, `sweepStagedThreads`, `threads()` on the staged store, `maxResponseBytes`.

## Review amendments (2026-09-25)

An independent review found no critical issues. Each item it raised, and where the plan now answers it:

1. **and 2. `root` could escape through a symlink, and needed per-entry `listDir`.** `atRoot` (Task 5) now lstats EVERY segment and requires a real directory, so a link at any depth (`draft`, or `a/link` in `a/link/x`) is refused as `root_missing` naming the segment and is never looked through; this matters because the Docker reader does not jail paths. The success path needs only `lstat`, so a batch-only backend (whose per-entry `listDir` refuses, `inspect-workspace.test.ts:76-79`) can be re-rooted; `listDir` is consulted only after a failed `lstat`, to tell "absent" from a backend failure. New tests: first-segment and mid-path symlinks with no lstat past the link, and re-rooting the batched backend. The option's doc comment says what the code does. `isCanonicalWorkspaceRoot` is exported from `@b4run/workspace`, and `parseThreadWorkspaceRequest` refuses a malformed `root` (400, the root named) before any reader starts, through a pure local copy (`isCanonicalRoot`) pinned to the same answers by a table test (Task 11).
3. **The inspect route's order.** Thread lookup, gate, then the feature check, then the body (Task 11). An unauthorized caller gets the gate's answer whether the feature is on or off, and the body is never read for it; an authorized caller of an app without the option gets the 404 of a missing route. Test: 403 from both an "off" and an "on" app for an unauthenticated caller sending a 200 KiB body. The upload route and `POST /threads`' `workspace_not_accepted` follow the same rule (Task 25).
4. **Upload cost.** One upload in flight per process (`429 upload_in_flight`, `retry-after: 1`); a `stagedWorkspaces.maxStagedBytes` quota (default 1 GiB, at most 16 GiB, shape-validated) checked in the store's `upload` after a reclaim (`507 staged_quota_exceeded`); a re-upload of held bytes rewrites and re-parses nothing; `readBoundedText` decodes as it reads instead of assembling a second full byte buffer. The sandbox page states the cost (four to five times the upload at the peak). Tasks 8, 21, 23, 24, 25, 26; tests for the 429, the 507 and the quota at store and manager level.
5. **One rule for upload and create.** `requestedWorkspace` is set on `workspace.source.put` (`{ sourceDigest }`) and carries the whole reference on `thread.create` (`{ sourceDigest, environmentLinks?, baseline? }`), typed as `ThreadAccessRequestedWorkspace` (Task 22; D11). The pure `stagedWorkspaceField` shape-checks the whole field before the gate (Task 25). Docs say that enabling `stagedWorkspaces` means auditing the `create` handler (Task 26).
6. **A bearer token over plain HTTP.** The factory README requires loopback, a private network or TLS (Task 3). Both clients refuse redirects: the factory client's `send` (Task 2, with a test) and `readThreadWorkspace` (Task 12, with a test).
7. **DELETE ordering.** `DELETE /threads/:id` forgets the staged reference before the thread row (Task 25), so a failed delete fails closed and an id reused through a run endpoint inherits nothing (test); a boot sweep (`sweepStagedThreads`) forgets the references of threads whose rows are gone (manager test). The detach in `completeDelete` stays, idempotent.

Minor:
- Task 1 Step 5 no longer claims `b4 check` never evaluates the policy: it does once `.b4/build/modules.mjs` exists (`check.ts:203-211`). `turbo.json` passes `FACTORY_WORKER_TOKEN` through to both workers' `check`, and the README says to set it for `check`. CI's lane checks before it builds in a fresh checkout, so `ci.yml` needs no change in PR 1.
- `config.test.ts` has no `baseEnv()`: Tasks 2 and 17 now name the real `base` and `pair` constants, the one-key literal at `:21`, and every case Task 17 rewrites or deletes.
- PR 5 updates `turbo.json`: both `*_MANIFEST_DIR` leave the workers' env lists. `FACTORY_DRAFTER_IMAGE` stays on the drafter's, because the drafter still reads it; only the controller stopped in PR 3. Task 33's grep now covers `turbo.json`, the runbooks and the fixtures.
- The 1 MiB `POST /threads` cap applies only when `stagedWorkspaces` is on, so other apps see no behaviour change (Task 25, with a test that an app without the option still accepts a 2 MiB create; D3; changeset).
- `readThreadWorkspace` bounds the response (`maxResponseBytes`, default 80 MiB, `response_too_large`) and refuses file keys that are not relative leaf paths and symlink keys that are not single leaves (Task 12 tests).
- A 413 reaching a real client: Task 8 adds a real-socket test and gives `toWebRequest` its own body stream (`drainableBody`) whose cancel discards the rest of the upload instead of destroying the socket; the existing adapter, AG-UI and runs tests run against it. The PR 2 changeset says so.
- Paths removed by `ignorePrefixes` still count in `totalBytes` and `entries` (they were read): documented on `threadWorkspaceResponse` and on the sandbox page.
- Task 9's boot refusal runs before `reconcileDeletions` and reads `sandboxManager?.workspaceProtocol ?? NO_WORKSPACE_PROTOCOL`.
- `handedSourceDigest` accepts both `*_manifest_written` and `*_source_staged` from PR 3 on (test), so rows journalled under either read alike; PR 5 no longer edits it.
- D13 carries the full reference in `factoryBuilder.workspace` (and `factoryDrafter.workspace`), and the workers compare digest, links and baseline against the staged definition (Task 29 tests).
- Missing tests added: a reclaim racing a create (the attach reports `workspace_source_not_held`, the create answers 409 and the row is gone; Task 25), `workspace_changed` end to end as a 409 (Task 11), mid-path symlinks (Task 5), and a pin that `sources.put` and `associations.create` in `getForThread` stay synchronous with no `await` between (Task 24).
- Conditional instructions resolved: Task 3 (the two worker config tests import `b4.config.ts` and spawn only `in-lane.mjs`: no change), Task 11 Step 6 (`runtime-fetch-parity.test.ts` enumerates no routes: run, no edit), Task 13 and Task 26 (`api/sdk.mdx` describes `ThreadOperation` and `ThreadAccessRequest` in one generic row each: no change; `thread-access.mdx` has no operation list, so a section is added), Task 16 (`fake-managed-provider.ts` is deleted, its only importer being the replaced block) and Tasks 17/18 (`builderSandboxProvider` and `drafterSandboxProvider` are deleted in Task 18 with their last importers, `targets-workspace.test.ts` cases included).
