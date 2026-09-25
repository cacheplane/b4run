# Software factory: what the developer should not have to do

Status: design, 2026-09-23. Program: [the RFC](2026-09-16-software-factory-rfc.md).
Predecessor: [rung 3](2026-09-21-software-factory-rung3-design.md), as landed through
sub-project 3b. Written beside
[sub-project 4](../plans/2026-09-23-software-factory-first-live-issue.md), the live replay of
#714, whose findings are appended in §9.

Running the factory today takes four processes, about fifteen environment variables, one
copy of the builder package per target, a `target:prepare` per pin, a target file per
builder, manifest directories shared by path between processes, and a controller that reads
each worker's `.b4/workspaces` store by app root. Most of that is the framework's per-app
limits leaking into an operator runbook. **The goal: one command starts everything, and one
command runs an issue.**

**The constraint: every trust property the factory has survives.** Nothing model-written is
trusted; the controller captures, diffs, digests and verifies in its own containers;
approval binds a digest; each thread's workspace is fixed at first admission and recorded by
digest. Each item below says which of these it touches and how it holds.

Line references are to `main` at 7c7ad3c2. "S/M/L" is relative effort: S is one PR in one
package, M is one PR across two or three, L is a design plus more than one PR.

---

## 1. Sandbox image, policy and permissions per thread

**Today.** `SandboxConfig` takes one `provider` and one policy per app
(`packages/workspace/src/sandbox-types.ts:183-199`); `resolveSandboxManager` builds that one
policy at boot (`packages/cli/src/lib/runtime/resolve-sandbox.ts:33-38`) and hands it to every
`provider.reconnect` (`managed-workspace-manager.ts:209`). Permissions are one store per app
(`resolvePermissionsStore`, `packages/cli/src/lib/runtime/execute-route.ts:282`). The rung 3
resolver varies only the workspace (§5.6). So the builder reads a per-process target file
(`FACTORY_BUILDER_TARGET`, `server/b4.config.ts`, `server/src/builder-manifest.ts:110`), one
process serves one (target, pin), and the operator writes `builder-target` per pair, copies
the `server` package per builder so each has its own installation store (README:252-275),
writes a `FACTORY_WORKERS` JSON map with `url`, `appRoot`, `manifestDir` and `pin` per entry
(README:311-334), and restarts a builder when `dispatch` refuses a task at another pin
(`builder_environment_differs`, `controller/src/lib/controller/factory.ts:240-275`).

**Change** (`@b4run/workspace`, `@b4run/cli`, `@b4run/sqlite-storage`, `@b4run/sandbox`).
The resolver may return the thread's whole sandbox, not only its workspace:

```ts
export interface ThreadSandbox {
  readonly workspace: WorkspaceDefinition | CapturedWorkspaceDefinition
  /** Provider-interpreted. The Docker provider reads `image`. */
  readonly environment?: { readonly image: string }
  readonly policy?: Pick<SandboxPolicy, "network" | "env" | "resources">
  readonly permissions?: {
    readonly allow?: Readonly<Record<string, readonly string[]>>
    readonly deny?: Readonly<Record<string, readonly string[]>>
  }
}
export type ThreadSandboxResolver = (thread: WorkspaceResolverInput) => Promise<ThreadSandbox>

interface SandboxConfig {
  readonly workspace?: WorkspaceDefinition | WorkspaceResolver
  /** Exclusive with a resolver `workspace`. Called once per thread, at first admission. */
  readonly thread?: ThreadSandboxResolver
}

// ManagedWorkspaceProvider (packages/workspace/src/managed-workspace.ts:93)
resolveEnvironment(signal: AbortSignal, request?: { readonly image?: string }): Promise<WorkspaceEnvironment>

// @b4run/sandbox
dockerSandbox({ scope, image, images?: (reference: string) => boolean })
```

The image half is already per thread in storage. `resolveEnvironment` records the image's
digest in the thread's intent (`managed-workspace-manager.ts:148-158`), and the Docker managed
provider reads its own configured `image` only there (`packages/sandbox/src/docker/managed-workspace.ts:202`);
resource names hash the binding (provider, scope, daemon id) with the installation and
operation ids (`:27-30`), and sessions and readers run `intent.environment.identity`
(`:260`, `:499`). So the example's statement that the image is half of the address a reader
needs (README:447, `server/b4.config.ts`, `controller/src/lib/targets/workspace.ts:84-87`)
looks conservative for managed workspaces; that is a reading of the code, not proved by a test. Policy and permissions are not in
the intent: they get a per-thread record in the installation store, written in the same
transaction as the association, and `getForThread` passes the recorded policy to `reconnect`
instead of the app's. The permission gate takes a thread-scoped store built from the record;
the mode stays per app, and an "Always" grant in such a thread is kept in the thread's record,
never written to `.b4/permissions.json`.

The factory's builder then boots with no target file; the manifest (or item 2's handoff)
carries what the target file carries today, and one builder serves every target and pin. The
drafter's reason to be a third process ("a builder process serves one target and intake runs
before a target is chosen", rung 3 §6) also goes; folding it into the same app is optional.

**Trust impact.** Today the operator's file chooses a builder's policy and permissions and
the controller's manifest chooses its workspace (README:120-128). After, the controller's
manifest chooses all four, per thread, through host code that validates it strictly (the
existing `BuilderTargetSchema`, which refuses unknown policy keys and any network allowlist).
The boundary merges into one: who can hand the builder a manifest. Each thread's choice is
recorded at first admission and never re-resolved, as the workspace is now; `images` bounds
which images a resolver may name. The dispatch pin guard retires, because the build now runs
in the image the verifier uses.

**Proof.** Unit: two threads with different image, policy and permissions get different
`environment.identity`, `reconnect` receives each thread's own policy, and a command allowed
in one thread is denied in the other; re-admission after restart uses the record without
calling the resolver; an image refused by `images` fails before any provider create. Docker
lane: one served builder runs a `cli-flags` thread and two `devkit` threads at two pins.

**Size: L.** A new storage record, the manager, the provider interface, the permission path
in `execute-route-core`, the build artifact's resolver form, and `b4 check`'s report.

## 2. The workspace travels with thread creation

**Today.** Handoff is a file in a directory both processes name. `dispatch` captures and
writes `<manifestDir>/<workOrderId>.json` (`controller/src/lib/builder-manifest.ts:177-210`);
`intake` writes the drafter's (`drafter-manifest.ts:96`), some 20 MiB on this repository
(README:391-393). The operator sets `FACTORY_BUILDER_MANIFEST_DIR` and
`FACTORY_DRAFTER_MANIFEST_DIR` identically on both sides, and the controller owns the files'
lifetimes and their cleanup on block, approval, cancel and reconcile (README:334-337). The
Agent Protocol's `POST /threads` accepts only `metadata`
(`packages/cli/src/lib/dev/runtime-fetch-core.ts:1361-1399`).

**Change** (`@b4run/cli`, `@b4run/sqlite-storage`, `@b4run/sdk`). A content-addressed
upload into the worker's installation content store, and a reference at creation:

```
PUT  /workspace/sources/:digest    body: CapturedWorkspaceDefinition  → 201 | 200 (already held)
POST /threads  { "metadata": {…}, "workspace": { "sourceDigest": "sha256:…" } }
```

The server verifies the upload (`verifyCapturedWorkspaceDefinition`, digest equals the path),
refuses a create naming a digest it does not hold, and records the digest on the thread
outside client metadata. `WorkspaceResolverInput` gains
`readonly staged?: CapturedWorkspaceDefinition`, which the resolver may return as is. Both
endpoints are off unless the app sets `sandbox.stagedWorkspaces: true`, and boot refuses that
option without a `threadAccess` policy; uploads get a new `ThreadOperation`,
`workspace.source.put`. Unreferenced uploads are reclaimed after a retention window, which
is where rung 3 §9's orphan-source reclaim belongs too.

**Trust impact.** The source is still captured by the controller from the object store at the
pin, verified by digest at the worker and recorded in the intent: unchanged. The control point
moves from filesystem write access to the manifest directory to the worker's thread-access
policy (a bearer token only the controller holds, checked from the request headers the policy
already receives). Without that policy, anyone who reaches the port could choose a thread's
workspace, which is why the option cannot be enabled without one. I found no explicit request
body limit in `runtime-fetch-core.ts`; a 20 MiB upload needs one, and I have not checked what
the Node server enforces.

**Proof.** Runtime tests: upload, create, first run, `intent.sourceDigest` equal to the
upload; an unheld digest refused before any thread row; a body whose digest differs refused;
403 without the token; the option without a policy refused at boot. Factory: the builder and
drafter lanes run with no manifest directory.

**Size: M.**

## 3. Read a thread's workspace over HTTP

**Today.** The controller reads a worker's thread by opening that worker's installation
store under its app root (`packages/cli/src/lib/runtime/managed-workspace-reader.ts:51-57`)
and its volume through its own Docker client, whose binding check requires the same daemon
(`packages/sandbox/src/docker/managed-workspace.ts:104-113`). Hence `appRoot` per worker
entry, `FACTORY_BUILDER_APP_ROOT`, `FACTORY_DRAFTER_APP_ROOT`, a `FACTORY_DRAFTER_IMAGE` that
must equal the drafter's (README:436-447), the rule that no two workers share an app root,
and one host, filesystem and daemon for everything. Re-rooting at `draft/` lives in the
controller's reader, not the framework (`controller/src/lib/worker/workspace-reader.ts:63-71`).

**Change** (`@b4run/cli`, `@b4run/workspace`, `@b4run/sdk`).

```
POST /threads/:thread_id/workspace/inspect
  { "root"?: "draft", "excludeRootDirectories"?: [...], "expectedRootSymlinks"?: {...},
    "ignorePrefixes"?: [...], "maxTotalBytes"?: n }
→ 200 { "threadId", "sourceDigest", "intentDigest", "inspection": WorkspaceInspection }
→ 409 run_in_flight | 404 lost | 410 expired
```

The worker serves it with the code the controller runs now (`openManagedWorkspaceReader`,
then `inspectWorkspace`), with `root` moved into `inspectWorkspace`. It refuses while a run is
in flight: the controller reads only between turns today. Gated as a new `thread.workspace`
operation under `read`; off unless `sandbox.workspaceRead: "http"`, refused at boot without a
`threadAccess` policy, and shape-validated so a misspelt option fails closed. A client,
`readThreadWorkspace(url, threadId, options, { headers })`, ships beside
`withManagedWorkspaceReader` in `@b4run/cli/workspace`.

**Trust impact.** Non-disturbance is kept by construction: the same networkless read-only
container, no exec backend, no write operation. What changes is that the bytes pass through
the worker's host process. That process is operator code the model cannot reach (the model
acts only inside the sandbox), so "nothing model-written is trusted" holds: the controller
still diffs, digests and verifies what it receives, in its own containers, and exports only
that. The controller checks `sourceDigest` against the source it handed over (item 2), so a
worker answering for the wrong thread is refused. The endpoint is a disclosure surface, hence
opt-in and gated.

**Proof.** Runtime tests: the endpoint's inspection equals the local reader's on an idle
thread; 409 during a run; 403 without the token; `root` refuses `..` and an absent directory
by name. Factory Docker lane: the controller runs with no path to the worker's `.b4`.

**Size: M.** With item 2, the controller and the workers no longer share a host or a
filesystem; the controller still needs Docker for the verifier and the git object store for
captures.

## 4. Environment images built when first needed

**Today.** The operator runs `target:prepare <id>` and `target:prepare <id> --pin <sha>` per
pin (README:210-224); a `--pin` prepare edits the checked-in `target.json` with a
host-specific `localId` (3b plan, Task 8 follow-ups). An intake at an unprepared pin blocks
`image_unprepared` for good, naming the command (`controller/src/lib/controller/intake.ts:416-424`,
`targets/catalog.ts:187`); then a builder restart at that pin (item 1).

**Change** (`examples/software-factory/controller`). Lift the build out of
`scripts/prepare-target.ts` into `src/lib/targets/prepare.ts`, where its pure parts already
live, as `prepareImage(target, pin, { signal }): Promise<Image>`. The controller calls it when
a work order first needs (target, pin): at the fit step of intake and at `dispatch`. One build
per key at a time; results in a host-local registry, `<FACTORY_STATE_DIR>/images.sqlite`,
keyed by target, pin, Dockerfile and lockfile hashes, with only the default pin committed in
`target.json`. Journal `image_prepare_started`, `image_prepared`, `image_prepare_failed`;
build time is not charged to the work order's active budget. `image_unprepared` becomes a
build failure, not a standing block. A B4-level `dockerSandbox({ build })` is not proposed:
the controller owns the environment identity, so it owns the build.

**Trust impact.** The image is a verification input (`environmentIdentity` digests image and
pin). Its inputs are unchanged and none is model-written: a git archive of `imageContext` at
the pin, and the committed Dockerfile. The drafter picks a target from the catalog and never a
pin (the draft schema omits it), so a draft can cause a build of a reviewed recipe, not choose
one. That is a cost exposure; bound it with a build concurrency limit.

**Proof.** Unit with a fake builder: two concurrent work orders at one pin build once; a
failed build settles the work order with the log in evidence. Docker lane: intake at an
unprepared `devkit` pin builds it, and the recorded identity equals the script's.

**Size: M.**

**As landed** ([plan](../plans/2026-09-25-images-built-on-demand.md), PR 1). `target.json`
records no image; it pins its base by digest (`baseImage`). The registry key is the recipe
digest (target, pin, platform, base, Dockerfile, `imageContext`, lockfile path, asserted
modules, commands' cwd), not the lockfile hash, which the pin already decides. Intake builds
at the fit step with the budget paused while a build runs (persisted; reconciliation resumes
it after a restart); dispatch builds before its key with the row in `received`, honours the
route's cancel, and re-checks the approved digest after the wait. A work order binds its image
(`image_bound`; intake rebinds each attempt), and the binding is authoritative: the verifier,
the oracle proof and approve's re-verification run the bound image by ID, and the policy and
receipt digest it. A bound image gone from the daemon (`image_changed`, reason `gone`), a
binding for another target or pin (`image_changed`, reason `target_moved`) and a missing
binding (`image_unbound`) are refused on the record, never rebuilt. Tags are
recipe-key-scoped and a build reads its own ID from `--iidfile`. The drafter is offered every
target whose files exist at the pin. `FACTORY_MAX_IMAGE_BUILDS` (default 1) bounds builds and
`FACTORY_IMAGE_BUILD_TIMEOUT_MS` (default 30 minutes) each one; the build log is evidence.
`target:prepare` only warms the registry; `FACTORY_TARGETS_DIR` is retired. The CLI's
`dispatch` follows a build past its request timeout, bounded by the journalled `deadlineMs`.
CI's explicit prepares are gone: each lane run builds through a registry of its own. PR 2
moves the builder to the bound ID, checked against the image's build labels. Deferred: the
factory's own git object store (§9 finding 3) and budgets from measured verifier time (§9
finding 5).

## 5. Targets generated from the package, reviewed by a person

**Today.** `targets/<id>/target.json` and its Dockerfile are hand-written: `capture.include`,
`imageContext`, `lockfile`, `imageAssertResolves`, `environmentLinks`, `commands` (devkit's
test command carries nine `--exclude` flags), `runnerConfig` and measured `resources`
(`controller/targets/devkit/target.json`); the same paths recur across three lists. The
sub-project 4 `cli` target is this by hand for a package with nine workspace dependencies and
177 test files.

**Change** (`examples/software-factory/controller`). Two commands, both deterministic code:

```
factory target:init <package> [--pin <sha>]   # writes targets/<id>/target.json + Dockerfile
factory target:measure <id> [--pin <sha>]     # prepares, runs, proposes excludes + resources
```

`init` reads `package.json` files and `pnpm-workspace.yaml` at the pin from the object store:
capture is the root manifests plus, for the package and each workspace dependency,
`package.json`, `tsconfig*.json` and `src`, plus the package's tests and runner config;
`imageContext` is the root manifests, lockfile and the dependencies' `package.json`; `build`
follows dependency order (`tsc -b` where project references exist, else a filtered
`pnpm -r run build`). `measure` runs the suite per file in the prepared image with the network
denied and proposes an exclude for each file that fails or hangs, with its reason, and
resources from cgroup `memory.peak` and wall clock with headroom. The output is a diff.

**Trust impact.** A target is an oracle input: its test command is the visible suite and its
commands are the verifier's. It stays a reviewed, committed file; the generator proposes and a
person accepts. An exclude hides a test from both suites, so each proposed exclude carries its
failure output for the reviewer. No model is involved.

**Proof.** `init` reproduces the committed `devkit` target and the sub-project 4 `cli` target,
differences listed and explained; `measure` on `devkit` proposes its committed excludes or
explains each difference.

**Size: L.** Measuring is the hard part, as the `cli` target showed.

## 6. The CLI shows what is approved and approves exactly that

**Today.** The operator lists `<FACTORY_STATE_DIR>/tasks/<id>/`, copies `taskDigest` from
`show` into `approve-intake <id> --revision <n> --digest <sha256>`, then copies the bundle
digest from `dispatch`'s output into `approve <id> --revision <n> --bundle <sha256>`
(`controller/src/cli.ts:30-33`, `:400-427`; README:350-370).

**Change** (`examples/software-factory/controller/src/cli.ts`).

```
factory review <id>                                  # interactive
factory review <id> --approve --digest <sha256>      # scripts; the current contract
factory review <id> --reject --note "…"
```

For intake, `review` prints the issue, `spec.md`, `task.json`, the check file and the oracle
proof's failing output, computes the task digest from the bytes it printed and refuses if it
differs from the row's. For export it prints the candidate diff, the receipt and the bundle.
The prompt asks for the digest's first eight hex digits, then sends the revision and full
digest it displayed. Without a TTY it requires `--digest`. The routes do not change.

**Trust impact.** Approval by digest is unchanged at the route: `approve-intake` still
recomputes at call time and `approve` still compares the frozen bundle. The CLI now digests
the bytes it displayed, so "what the person read is what is approved" is checked rather than
assumed. The typed prefix keeps a deliberate act.

**Proof.** CLI tests against `serve-controller.ts`: a file changed between display and
approval is refused; non-TTY without `--digest` refuses; the prefix must match.

**Size: S.**

> **As landed:** `factory review` in `controller/src/cli.ts`, rendering in
> `controller/src/lib/review/operator-review.ts`, with the routes unchanged. The task digest
> reuses the gate's own function: `readGeneratedTask` (beside `digestGeneratedTask` in
> `lib/intake/generated-task.ts`) reads the directory once and digests those buffers, and the
> display is decoded from the same buffers, so the digest matches the route's by construction.
> The intake display is every file the digest covers (`issue.md`, `spec.md`, `task.json`,
> `checks.json`, the check file) plus the oracle receipt and each check's output from the
> artifact store. The export display recomputes `bundleDigest` from the payload it printed and
> cross-checks the candidate and receipt it printed against it. Each changed file is shown as
> a unified diff (the example's existing `diff` dependency) of the candidate's bytes against
> the target's file at the work order's pin (the target's pin for a catalog work order), read
> once with `git ls-tree`/`git cat-file` from the object store `create` uses; a path the pin
> lacks is shown all-added. The diff is display only: the digest and every refusal are still
> over the bundle. Deviations: (1) the diff base is the pin, not the controller's captured
> baseline, which the CLI does not take: for a catalog task with a `defect.patch` the diff
> also shows the defect being undone, and the review says so above the diffs. Loading the
> task's target ensures its pin as the catalog always does (fetched on a miss unless
> `FACTORY_NO_FETCH=1`); a pin that still cannot be read falls back to the whole file, with a
> line saying why. The candidate model has no deletions, so there is no deleted-file case;
> (2) `review --reject --note` on an export is `deny`, whose route
> takes no note, so the note is echoed in the output and not journalled; (3) review also
> refuses, after displaying, when an evidence artifact does not hash to its name, a file is
> not UTF-8, or the bundle names a different candidate or receipt than the one shown; an
> evidence item the store does not hold (the oracle proof's output on an intake, the
> receipt's check output on an export; the fake verifier records digests it never writes) is
> shown as missing and refuses approval unless
> `--allow-missing-evidence` is passed (with a loud warning): the
> verifier identity is a free-form string, so there is no reliable marker of a verifier that
> never writes its output, and a flag is the honest option; (4) every line of content is shown
> behind a `│ ` gutter (runs of more than three blank lines collapsed into a count), and
> controls, bidi marks and overrides, zero-width characters, a byte order mark, line and
> paragraph separators and tag characters are shown as `\u{…}` escapes in bodies and titles,
> so neither model-written files nor the issue can fake a title or digest line or hide a line;
> `relativePath` now also refuses control characters and line separators, so a drafter cannot
> name a check file with one; the prompt takes at least eight hex digits of the digest, or all
> of it pasted, and `--digest` without `--approve` is refused; (5) the
> display goes to stderr and the outcome JSON to stdout, keeping every command's stdout
> contract; (6) `FACTORY_CLI_INTERACTIVE=1` is the test seam that lets the prompt answer on a
> pipe, like the CLI's other test-only variables. Proof: three CLI tests in `cli.test.ts`
> against `serve-controller.ts` (intake review with the raced edit, the pre-edit refusal, the
> wrong prefix, non-TTY and wrong `--digest` refusals and nothing-to-review; the scripting and
> reject paths; the export review with the pin diff's hunk and the unreadable-pin fallback,
> approval and deny), and unit tests in `operator-review.test.ts` for the gutter against a fake
> title and digest line in `issue.md`, the blank-run collapse, the escapes (ESC, bidi, BOM, a
> control character in a title), the missing-evidence refusals on both sides, the export's
> bundle-digest mismatch refusal and `relativePath`'s refusal of control characters.

---

## 7. Quickstart after

```ts
// examples/software-factory/factory.config.ts
export default {
  state: ".factory",
  controller: { port: 4300 },
  worker: { url: "http://127.0.0.1:4100", token: { env: "FACTORY_WORKER_TOKEN" } },
}
```

```
OPENAI_API_KEY=… pnpm factory up                  # controller + one worker app
pnpm factory run --issue 714 [--pin <sha>]        # create, intake, review, dispatch, review
```

`up` and `run` are glue in the example (S), possible only once items 1 to 3 land. What is
left: work order, task, target, pin, oracle, bundle, digest. Gone: worker map, target file,
manifest, manifest directory, app root, installation store.

| Today's step | Removed by |
|---|---|
| `target:prepare <id>` and `--pin <sha>` per pin | 4 |
| `builder-target` per (target, pin) | 1 |
| `rsync` a copy of `server/` per builder, symlink `node_modules` | 1 (one builder), 3 (no app roots) |
| One builder process per (target, pin), each with its own port | 1 |
| `FACTORY_BUILDER_TARGET` on the builder and the controller | 1 |
| Restart a builder at the task's pin on `builder_environment_differs` | 1 |
| `FACTORY_BUILDER_MANIFEST_DIR`, `FACTORY_DRAFTER_MANIFEST_DIR` on both sides | 2 |
| `FACTORY_WORKERS` entries (`url`, `appRoot`, `manifestDir`, `pin`) | 1, 2, 3; one `url` remains |
| `FACTORY_DRAFTER_APP_ROOT`, `FACTORY_DRAFTER_IMAGE` equal to the drafter's | 3 |
| Separate drafter process | 1 (optional fold) |
| Controller and workers on one host, filesystem and Docker daemon | 2 + 3 |
| Hand-writing `target.json` and the Dockerfile | 5 |
| `ls tasks/<id>`, copy revision and digest into `approve-intake` | 6 |
| Copy revision and bundle into `approve` | 6 |
| Four terminals, `export` of URL and state dir, an alias | `up`/`run` glue |
| `factory reconcile` after a controller restart (no boot hook) | Not removed; rung 3 §4.5 |

## 8. Order

1. **Item 6** first: S, example-only, independent, ships now.
2. **Item 1** next: it removes the most steps (six rows above) and is the long pole. It can
   ship on today's manifest files, which then carry the target spec.
3. **Item 3**, independent of 1: removes app roots and, with 2, the shared host.
4. **Item 2** after the thread-access token lands on the worker, which 3 also needs; ship
   2 and 3 against one policy.
5. **Item 4**, independent; full value after 1, since until then a new pin still means a
   builder restart.
6. **Item 5**, independent and L; benefits from 4 for `measure`.
7. The `up`/`run` glue last.

Independent of everything: 4, 5, 6. Items 2 and 3 share the authorization prerequisite.

## 9. Live run findings (sub-project 4)

Appended as the live replay of #714 runs.

1. **Building a target for one package cost hours, not minutes** (plan Task 2 as-landed). The
   `cli` target needed a hand-built Dockerfile that relinks every workspace package, hoists
   three conflicting nested dependencies to the root, and shims a second TypeScript; a
   `tsc -b --builders 1` build because TypeScript 7 builds unrelated projects in parallel; a
   hand-chosen set of eight hermetic test files; and measured resources. Item 5 (targets
   generated from the package) is the answer, and this target is its hardest fixture.
2. **The verifier's snapshot is too slow to be the product.** One session over the `cli`
   target's 951-file workspace made 4,181 `docker exec` calls at about 170 ms each, because
   `ManagedWorkspaceManager.getForThread` re-verifies the whole source bundle before each
   filesystem call: 717 s per session, about 24 minutes to grade one candidate. The capture was
   narrowed to the scoped test files to keep the run workable. Fix: verify once per admission
   and batch snapshot reads (tracked as its own task; a framework defect, not a factory one).
3. **A shared clone had been shallow for three days.** `ensurePin` fetched a missing pin with
   `--depth=1`, which made the full clone shallow for every worktree on the host (history cut
   at 89dec62d). Fixed in `ensurePin` (depth only on an already shallow checkout) and repaired
   with `git fetch --unshallow`. A factory that fetches into the developer's own clone is a
   foot-gun: item 4's image registry should own its own object store.
4. **The controller wrote run-time files into its own app root, and `b4 dev` restarted it
   mid-request.** Started with `b4 dev` as the README prescribes, `intake` staged the
   drafter's wide capture under `controller/.factory/captures/drafter/`; the dev watcher,
   which ignores only `.b4/`, `workspace/`, `node_modules/`, lockfiles and `.pnpm-store`,
   restarted the server, and the CLI got `Request canceled during server shutdown`. The
   builder capture, the baseline capture and the verifier's staging (`.factory/verifiers`)
   had the same shape. Fixed by staging all of them under `FACTORY_STATE_DIR` (`captures/`,
   `verifiers/`), with the capture root a required argument rather than a default, and a
   regression test that watches the app root through intake and dispatch. Framework
   follow-ups: `b4 dev`'s ignore list is hard-coded (`classify-change.ts`), so an app should
   be able to declare its run-time directories (e.g. `dev.watch.ignore` in `b4.config.ts`);
   and tests built on `serveRuntime`, which does not watch, cannot catch a watch-mode defect
   at all, so the framework's testing surface needs a watching variant. The builder's and
   drafter's default manifest directories (`<app root>/.factory/manifests`, which the
   controller writes into) are the same shape against those processes' own watchers.
5. **The work-order budget did not know the target.** `FACTORY_MAX_ACTIVE_MS` defaults to 20
   minutes and is fixed on the row at create, but one verification of the `cli` target is two
   sessions of about 12 minutes each, so a work order created under the default would have
   been exhausted mid-verification with no warning. Now journalled at create and refused
   unspent at dispatch. Item 4's registry should record measured verifier time per (target,
   pin) and derive the budget, so an operator never sizes it by hand.
6. **Preparing a heavy package's image is fragile work.** The `cli` Dockerfile hoists nested
   dependencies over the root's copies (now declared and checked), duplicates the capture's
   package list by hand (now checked at prepare), and the base-image pull wedged twice on
   Docker Desktop. Each of these is evidence for item 5: the generator, not the operator,
   should produce the image recipe from the lockfile.
7. **A restarted runtime keeps a crashed thread `busy` forever.** The drafter was killed
   (`kill -9`) mid-turn on work order `wo-d0da5fc9a2ac402f`, thread `t-db391b07`, and started
   again. The runtime had persisted the thread's status as `busy`, and nothing on restart
   corrects it: there is no run in memory behind it, so a reattach (`GET .../runs/stream`)
   answers a first `state` frame with `live: false`, a `retry` and `done { output: null }`,
   and ends. The controller's reconcile treated `busy` as a live run, reattached, saw the
   stream end, and on the bounded second pass journalled `intake_still_live`; every later
   pass would do the same (journal, 22:12:26: `reattached`, `intake_turn_ended
   {reattached:true}`, `intake_still_live {attempt:1}`). The work order was cancelled by hand
   at 22:18. Fixed in the controller: a reattach whose first frame says `live: false` (or that
   ends with no frame) is a turn that ended (`reattach_not_live`), so intake reads and proves
   `draft/` (a missing or partial draft is refused and spends an attempt) and a builder turn
   goes to verification. The framework fix: on startup the runtime should mark every thread
   whose persisted status is `busy` and that has no in-memory run as `idle` (or `interrupted`,
   if a checkpoint shows the turn did not finish), so `GET /threads/:id` stops lying and every
   client does not need this rule.
8. **Another process on the host killed the workers.** Mid-run, the drafter and builder
   processes were killed by another process on the same host, outside the factory; nothing
   in the factory observed it until a request failed. Four long-lived processes on a
   developer's host, each a `b4 dev` found by port, are fragile by
   construction. Items 2 and 3 (the workspace handed over and read over the Agent Protocol)
   are what let the workers run somewhere the host's other processes cannot reach, and a
   supervisor that owns and restarts them (with finding 7's startup rule) would contain the
   rest.
9. **Active time accrued while the processes were down.** `wo-d0da5fc9a2ac402f` recorded
   `activeMs` 903,588: the whole span from `intake_started` (22:03:12) to the cancel
   (22:18:16), including the time the drafter was down and the six minutes the row then sat
   in `intake_still_live`. The budget ticker counts wall clock in an active state, so the
   outage was counted as work. A budget meant to bound model and container time should pause while the worker
   is unreachable (or reconcile the interval out on restart); otherwise an outage can exhaust
   a work order that did nothing.
10. **`create --issue` stages nothing until `intake`.** Recorded because it was checked, not
    because it is wrong: the wide capture and the manifest are written by `intake`, so a
    created work order costs a row and nothing else, and a stale one is free to leave.
11. **One drafter turn cost about 1.45M input tokens.** One live drafter turn made 28 model calls for about 1.45M input and 19k output tokens. The
    input grew to about 80k tokens a call once the drafter had read
    `packages/cli/src/lib/dev/runtime-fetch-core.ts` (about 2,600 lines) whole: every later
    call carried it again. A framework item: context management for large files in agent
    tools, e.g. `readFile` with line ranges and a size cap that returns an outline instead,
    grep-first guidance in the built-in tool descriptions, and eviction of tool output the
    turn no longer needs.
12. **A draft learned the target's runner configuration one refusal at a time.** On
    `wo-60fd3ddf2eaf28ad` the first draft was refused for `.npmrc` (runner configuration not
    immutable) and the redraft for `pnpm-workspace.yaml`, which spent both attempts on policy
    the drafter could not know. Fixed in the controller: the runner configuration is filled
    into `immutablePaths` like the id and the pin, and `assertTaskFitsTarget` now lists every
    problem in one refusal. The prompt also names each target's root with a concrete path
    (`cli`: a root of `.` means `packages/cli/src/...`), because the drafter had read the old
    wording ("not relative to the repository's root") as "relative to the package".
13. **A drafted check that could not load was read as a failing oracle.** The oracle proof
    took any `independent: fail` as proof, and node:test reports a file that fails to load
    (a wrong `dist/` import, `ERR_MODULE_NOT_FOUND`) as one failing test named after the file.
    Fixed in the verifier's independent-only grading (rung 3 spec §6.5, as landed): a
    failure proves the oracle only when a named assertion failed by assertion and nothing
    unnamed failed; anything else is `inconclusive`, and the refusal quotes why.
    The rule guards against accidental load failures only. A check that deliberately always
    fails (`assert.fail()` in its `A1`, or an assertion no code could satisfy) is still
    "proven": it fails by assertion on the baseline like a real oracle. That is safe, not
    merely tolerated: such a check can never pass full-mode grading, so no candidate is ever
    exported against it, and a person reads and approves every draft before a builder spends
    anything on it. The review of d6cb0d06 found one more hole, now closed: a `todo` or
    `skip` test no longer counts as the failing assertion that proves, because node:test
    reports a failing `test.todo` without failing the run.
14. **Scope stated as an acceptance criterion looped the refusal.** In attempt 3 of the #714
    replay the drafter wrote "only `runtime-fetch-core.ts` changes" as `A2`, which no test can
    assert, so its check covered `[A1]` against a spec stating `[A1, A2]`. The refusal named
    only the mismatch; the retry repeated it and the work order exhausted its attempts. Fixed
    both ways: the drafter's system prompt says an acceptance criterion is an observable
    behaviour asserted by one named top-level test and that scope belongs in `task.json`
    (`allowedSourcePaths`, `immutablePaths`), and the refusal itself now teaches that rule
    rather than only naming the ids.
15. **Denied read commands drove about 1.5M input tokens per work order.** The drafter's
    allow-list (`ls cat head tail grep wc`, a prefix match on the whole line) denied every
    `bash -lc "nl -ba <file> | sed -n 'a,bp'"` the drafter tried in attempt 3, so it fell
    back to `readFile` on the 3,600-line `runtime-fetch-core.ts` whole, in each of three
    threads, and every later call carried it again (finding 11's cost, repeated per
    attempt). Fixed in the drafter: `sed -n` and `nl` are on the list, and the system prompt
    says to run commands without a `bash -lc` wrapper and to read large files in ranges
    (`grep -n`, then `sed -n 'a,bp'`). The list still bounds only which commands start a
    line; the boundary is the re-rooted read and the denied network. Finding 11's framework
    item (`readFile` with ranges and a size cap) would make the prompt rule unnecessary.
16. **Refused drafts were not kept.** A retry runs on the same thread and rewrites `draft/`
    in place, so after a refusal the only record of what the model produced was the one line
    of the refusal. Fixed: each refused attempt's `draft/` files and a `reason.txt` are copied
    to `<FACTORY_STATE_DIR>/tasks/.refused/<id>/attempt-<n>/` and the path is journalled on
    `intake_refused` (`keptAt`). Not under `tasks/<id>/`: that directory is replaced wholesale
    by the next attempt and digested wholesale by the approval gate. The final
    `intake_blocked` transition now carries `blockedReason: intake_attempts_exhausted`
    (matching the row) and `lastRefusal` (the refusal that spent the last attempt).
17. **A killed controller left orphan drafter session containers.** Killing the processes
    mid-intake left the drafter's per-thread sandbox containers running with nothing to own
    them until someone noticed. A follow-up: a sweep, on drafter (and builder)
    startup, of the provider scope's containers whose thread has no live run, in the same
    spirit as finding 7's startup rule for `busy` threads.
18. **Attempt 4 ran end to end through the oracle proof, and the proof refused correctly.**
    On `wo-d05f62938d288cb4` the pipeline drafted, captured the baseline and ran the oracle
    proof in the `cli` image (10.5 minutes). The drafted check wrote a fixture route
    `src/app/noop/index.ts` exporting only `export default async function handler()` and ran
    route `/noop#graph`; the runtime refused the fixture at route discovery with `B4_E1007`
    (no recognisable export), so `A1` failed by a throw before reaching the behaviour, and the
    proof graded it `inconclusive`. That is the rule of finding 13 doing its job.
19. **Refusal text quality decides whether a redraft can succeed.** Attempt 4's refusal read
    `no named assertion failed by assertion (ERR_ASSERTION): "A1: …" (B4_E1007)`: it read as
    if A1 had failed by assertion and carried no message, so a redraft could not tell what
    the runtime rejected. Fixed in the controller: the node-test grading keeps each failure's
    code and the first line of its message (ANSI-stripped, 300 characters at most; for a file
    that fails to load, the first error line of its stderr), and the refusal says, per failing
    test, `A1 failed with B4_E1007 ("Route entry … has no recognisable export (found:
    default)."), not an assertion failure: the check must reach the behaviour and fail on an
    assert`, or `the check file failed to load (…): <error line>`. The drafter's retry prompt
    quotes that line.
20. **Project knowledge a drafter lacks belongs to the target.** How a route exports its
    entry, how a run names its route (`/noop#workflow`), and which helper the package's own
    tests drive the runtime with are facts about the target's code, not about one issue, and
    a drafter should not have to rediscover them from 3,000-line files each attempt. Targets
    now carry optional `draftingNotes` (at most ten one-line facts, rendered under the
    target's line in the intake prompt, not an image input); the `cli` target's are verified
    against its pin. Item 5's generator should draft these notes from the package's own tests
    (fixture helpers, route shapes, request builders) for a person to review with the rest of
    the target.
21. **`b4 dev` restarts on `.turbo/*.log` writes.** Running a turbo-driven command
    (`pnpm lint`, `pnpm build`) in the repository that holds the live factory apps writes
    each package's `.turbo/*.log` under the app roots, and the dev watcher restarts every
    live service. Another instance of finding 4's framework item: the watcher's ignore list
    should cover tool caches (`.turbo/`) and let an app declare its own run-time directories.
22. **A blocked intake leaves its generated task on disk.** After the last refusal the
    generated `tasks/<id>/` stays beside the kept refused copy under
    `tasks/.refused/<id>/attempt-<n>/`. Acceptable: it is inert, because only
    `approve-intake` by digest puts a generated task in front of a builder, and a blocked
    row cannot be approved. Noted so nobody reads the directory as live. The attempt cap is
    now `FACTORY_MAX_INTAKE_ATTEMPTS` (default 2, fixed on the row at create), so an operator
    replaying an issue can grant a redraft more room without a code change.
23. **The first proven oracle, and why the human gate is not ceremony.** Attempt 5 produced
    an oracle the controller proved (its check failed on the unpatched pin by assertion), in
    the second of three drafter attempts, after a refusal that quoted a load error. The
    operator still rejected it: its A1 asserted an empty body and a content type matching
    `/application\/.+json/`, which no response can satisfy, so every repair would have failed
    it. The proof establishes "fails now", never "can pass". The rejection also decided the
    question the issue left open (200 with JSON `null`, because B4's own client,
    `normalizeServerResult`, reads an empty 200 body as a malformed payload), which is a
    maintainer's decision the drafter could not make. Framework item: a satisfiability probe
    for drafted checks (run the check against a trivially "fixed" stub where one can be
    synthesised, or at least lint for contradictory assertions), and a way for the issue
    author to record such decisions before intake.
24. **The gate needed a satisfiability probe, done by hand.** For the final draft (attempt 3),
    the operator applied the shipped fix (b090ad42) at the pin in a scratch worktree, built the
    `cli` package, and ran the drafted check: A1 failed at the pin by assertion (`500` vs
    `200`) and passed with the fix; A2 passed on both. That evidence, not a reading, decided
    the approval, overruling a plausible-looking concern that A2 would fail a correct repair
    (it runs against a deleted fixture directory, yet the stream endpoint still answers 200,
    so A2 is a weak guard rather than a false failure). For a replay the reference fix makes
    this probe free; for a live issue there is no reference, which is why finding 23 asks for
    a mechanical probe. The receipt also records only stderr for the oracle run, not which
    named test failed with what message, so an approver cannot read the proof without
    re-running it: record per-test results in the receipt's evidence.
25. **The builder destroyed the one file it may change, then parked.** Dispatch of
    `wo-2a67180a359c7f85` (gpt-5-mini): the builder read the 3,644-line
    `packages/cli/src/lib/dev/runtime-fetch-core.ts` whole, wrote it back with `writeFile`
    truncated to 670 lines ending in `... (file truncated, unchanged)`, then ran
    `sed -n '1,2400p' …`, which its allow-list (only the target's build and test invocations,
    `node `, `cat`, `ls`, `head`) did not admit, so the turn parked on a permission prompt the
    controller has no gate for: `blocked / unexpected_interrupt`, spending the row's one
    candidate attempt and stranding an approved task. Four causes, four fixes. (a) **B4 has no
    partial edit.** The workspace capability offered whole-file `writeFile` and whole-file
    `readFile`, so any change to a large file is a rewrite of text the model must reproduce
    exactly: framework item, landing as `editFile` (exact text replacement) and ranged
    `readFile` (`startLine`/`endLine`) in the workspace capability; the builder's prompt now
    names them, forbids rewriting an existing file with `writeFile`, forbids placeholder
    text, and lists the commands it may run (`builderRules`, rendered under `Rules:` in the
    task prompt). (b) **The builder asked a person nobody assigned.** Its permissions are now
    `non-interactive` (`server/b4.config.ts`: a fixed property of the builder app, not of the
    target file), so an unlisted command is a tool error the model reads, and its list gains
    the drafter's read-only commands (`ls`, `cat`, `head`, `tail`, `grep`, `wc`, `sed -n`,
    `nl`), kept equal to the drafter's by test. The controller still blocks on any interrupt
    that reaches it. (c) **One attempt stranded the approval.** `FACTORY_MAX_CANDIDATE_ATTEMPTS`
    (default 2, fixed on the row at create; registry migration 5 adds `candidateAttempts`,
    backfilled from committed dispatches) and `factory retry <id>`: a row blocked by a
    candidate failure goes back to `received` (the old thread's prompt denied and its run
    cancelled; thread, interrupt, candidate, bundle and reason cleared; `retry { attempt,
    previousBlockedReason }` journalled), and `dispatch` starts a fresh builder thread from
    the same approved, re-checked task digest. (d) **The truncation would have cost a full
    verification to discover.** The controller's assembly now refuses a changed file carrying
    an elision placeholder its baseline did not, or (from 1 KiB) smaller than half its
    baseline, as `blocked / candidate_rejected`, with the file and line journalled, in seconds
    rather than after a verification whose snapshots alone take about 12 minutes a session on
    this target (Task 2's trap 9). The stranded row was created with one attempt and has spent
    it; it is not hand-edited, and the live run creates a new work order.
26. **One defect per ten-minute proof, and a decision that did not survive its work order.**
    The rerun (`wo-c7cbe172b6017faf`) spent all three drafter attempts, each ending in an
    oracle proof of about ten minutes, to surface one defect at a time. Attempt 1 was refused
    for its spec (an `A4` no test asserted), attempt 2's check loaded the build through
    `../repo/packages/cli/dist/...` and failed with `ERR_MODULE_NOT_FOUND`, and attempt 3's,
    which loaded it correctly through `process.cwd()`, never imported `test` from `node:test`
    (`ReferenceError: test is not defined`). The missing import and the relative path had been
    in the file since attempt 1, readable in its text. And the drafter asserted "an empty body"
    again, the shape the operator had rejected on the previous work order (finding 23: 200 with
    a JSON `null`), because the rejection note lived on the old row. Three fixes. (a) A
    **static pre-check** of the drafted check in `parseDraft`, before any container: it must
    parse (Node's own type stripper), import `test` from `node:test`, reach the build only
    through `join(process.cwd(), ...)`, use no relative specifier outside `checks/`, and name
    its top-level tests with exactly the `A<n>` ids `checks.json` lists. Every broken rule is
    named with its line in one `intake_invalid` refusal, which spends an attempt like any
    draft verdict. On the three kept drafts it refuses attempts 1 and 2 for the missing
    import, the relative path and the artifact not loaded through `process.cwd()` (the last two on line 5), and
    attempt 3 for the import alone, in milliseconds each. (b) A **check skeleton** in the
    drafter's system prompt (the imports, the build through `process.cwd()`, one named test,
    cleanup that cannot throw), which a controller test runs through the pre-check so the two
    cannot drift. (c) **Issue-level decisions carry over**: a new work order's intake prompt
    quotes the `reject-intake` notes of earlier work orders of the same issue (repository and
    number), newest first, at most four of 1,500 characters. Framework item: an issue's
    review decisions belong to the issue (or a thread the maintainer owns), not to one run of
    one agent; and a check contract a drafter must satisfy deserves a machine-readable
    template the framework ships, not a prompt paragraph.
27. **The factory repaired #714 end to end with real models, and the grade is 5 of 6.** Work
    order `wo-90f2b7069971f7c5`: the drafter's first draft passed the pre-check and carried the
    maintainer's decision; the operator rejected it once (an empty body still passed A1) and
    approved the minimal redraft after a satisfiability probe; the builder read in ranges and
    made one `editFile` at line 2632 (17 calls, 1 min 29 s); verification passed (visible 175
    tests, independent A1 and A2); the bundle froze the origin, pin, task and both receipts. The
    shipped reference test (b090ad42's `runs-wait-output.test.ts`) passes 5 of 6 on the
    candidate; the failing case is serialization of circular or BigInt outputs, which the
    maintainer's fix added beyond the issue's stated scope. The factory did what the issue asked
    and nothing more: a drafted oracle can only be as complete as the issue it is drafted from.
    Framework item: let an issue's intake draw on the maintainer's review (the carried notes
    already do this for decisions) to widen the acceptance criteria before the builder starts.
28. **One model call stalled for exactly 15 minutes** and returned corrupted tool arguments; the
    turn recovered. B4 has no per-call timeout shorter than the provider client's default, so a
    stalled stream costs a quarter hour of active budget. Framework item: a configurable model
    call timeout with a retry.

29. **Two read outcomes are mis-charged once the controller reads over HTTP** (found in the
    review of the workspace-over-the-protocol plan's PR 3; recorded, not fixed there).
    (a) *A transient read failure costs a candidate attempt.* A verification whose read the
    worker refused for a reason about the moment, not the candidate (`run_in_flight`,
    `workspace_changed`, `workspace_read_timeout`, `workspace_unavailable`, `shutting_down`),
    settles `verification_inconclusive`; the only way on is `retry`, which dispatches a new
    builder thread and spends one of `maxCandidateAttempts`. Proposal: a `reverify` command,
    legal from `verification_inconclusive` when the journalled failure is a read (not a
    verifier or receipt fault), that re-reads the SAME builder thread with the same handed
    digest and re-enters verification without a new dispatch or a spent attempt. (b) *A
    model-caused inspection refusal is journalled as an infrastructure fault.* A
    `workspace_inspection_refused` or `workspace_response_too_large` answer is the model's
    output breaking the inspection's rules (an unexpected symlink or executable, a file or a
    tree over the limits), in the drafter's `draft/` or the builder's workspace, yet it lands
    as `workspace_unreadable` → `intake_run_failed` (no attempt spent, and the redraft prompt
    never learns why) or `verification_inconclusive`. Proposal: classify them as a draft
    defect (`intake_invalid`, the refusal text in the redraft prompt, an attempt spent) and a
    scope violation (`assembly_rejected` with `scope_violation`), respectively, keyed on the
    worker's code and never on its message.
