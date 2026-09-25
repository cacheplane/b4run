# Software factory, rung 2: developer guide

> **Superseded in part.** One builder process now serves every target and pin. The steps
> below that write a builder target file (`factory builder-target`), set
> `FACTORY_BUILDER_TARGET`, or map builders per target with `FACTORY_WORKERS` no longer
> apply: the command is gone and both variables are refused by name. Each work order's
> handoff carries its target's image, policy and permissions. The controller also reads each
> worker's threads over the worker's URL now (`sandbox.workspaceRead: "http"`), with the
> worker token: `FACTORY_BUILDER_APP_ROOT` and `FACTORY_DRAFTER_APP_ROOT` are refused on the
> controller by name (it ignores `FACTORY_DRAFTER_IMAGE`, the drafter's). And no manifest
> directory is shared any more: `dispatch` and `intake` upload each work order's workspace
> over the worker's port and create the thread naming it (`sandbox.stagedWorkspaces`), so
> `FACTORY_BUILDER_MANIFEST_DIR` and `FACTORY_DRAFTER_MANIFEST_DIR` are refused by name on the
> controller and on both workers, and the controller needs only each worker's URL and
> `FACTORY_WORKER_TOKEN`. Drain in-flight work orders before upgrading past that change: a
> thread dispatched with a manifest and not yet run is refused at admission. Follow the
> [software factory README](../../../examples/software-factory/README.md#run-it) to run it.

Reconciled against the implementation on branch `blove/software-factory-rung2-spec`.
The design is the [rung 2 spec](../specs/2026-09-19-software-factory-rung2-design.md);
what changed while it was built is recorded per task in the
[plan](../plans/2026-09-20-software-factory-rung2.md)'s "as landed" notes.

This guide is for someone who wants to run the factory against a package in
this repository, add a target or a task, and understand what each moving part
is for. It ends with an honest list of what is missing and where it hurts.

## What the factory is, in one paragraph

A work order names a task. A task names a target and a repair. The controller
captures the target at a pinned commit with a known defect applied, hands that
capture to a builder agent in a container, and waits for the builder's turn to
end. It then reads the builder's workspace itself, diffs it against the
baseline it captured, and verifies the candidate in containers the builder
never touched — one per suite: build and the package's own tests in the first,
build and an independent check the builder never saw in the second. A passing verdict freezes a review bundle whose
digest binds the candidate, the policy, the specification and the exact image.
An operator approves that digest, the controller re-verifies, and only then do
the approved bytes leave, as a file named by the bundle digest. The builder has
no way to claim its own result at any point.

## How it works

### The three authorities

| Authority | Owns | Cannot |
|---|---|---|
| Builder | Editing files in its managed workspace | See the independent checks, report a verdict, export |
| Controller | Baseline, workspace read, assembly, verification, bundle, export | Trust anything the builder says |
| Operator | Approving a bundle digest | Approve bytes that were not verified under that digest |

Everything in rung 2 preserves this table. If a change would let the builder
influence a verdict, it is wrong regardless of how convenient it is.

### Targets and tasks

A **target** is an environment: which commit of this repository, which paths to
capture, which image to run in, where the dependency trees mount, and how to
build and test. A **task** is one repair against one target: what may change,
what must not, the specification with acceptance IDs, the defect and reference
patches, and the independent checks.

The split matters because they change at different rates and for different
reasons. A target changes when the pin advances or the image is rebuilt. A task
changes when the acceptance criteria change. The checks live with the task
because they are the executable form of its acceptance criteria, which is also
why they never live in the target repository: anything in the repository is in
the builder's capture, and the whole point of the independent suite is that it
is not.

`targets/<id>/target.json` has these fields, all validated strictly (an unknown
key is a load failure, not a warning):

| Field | Meaning |
|---|---|
| `id` | Must equal the directory name |
| `pin` | 40 hex characters; must exist in this repository's object store |
| `root` | Repository-relative root the capture paths are read under (`.` for a monorepo target) |
| `capture.include` | The inventory: exactly what `git archive` takes at the pin |
| `snapshotIgnore` | Root-relative directory prefixes the build legitimately writes (devkit: `packages/devkit/dist/`) |
| `image` | Written by the prepare script; absent means the target does not load |
| `imageContext` | The paths the image build context is archived from; must cover `lockfile` |
| `lockfile` | The lockfile whose sha256 is recorded in `image` |
| `imageAssertResolves` | Specifiers the prepare script `require.resolve`s inside the built image |
| `environmentLinks` | Root symlinks the workspace gets, and their exact targets |
| `commands.cwd` | Workspace-relative directory `build` and `test` run in |
| `commands.build` | argv, run through a quoting join; empty means no build step |
| `commands.test` | argv; a `vitest` invocation when the visible suite's runner is `vitest` |
| `commands.nodeTestExecArgv` | `execArgv` for `node:test` suites (`["--import","tsx"]` for cli-flags, `[]` for devkit, whose checks rely on Node 24 type stripping) |
| `runnerConfig` | Files the runner needs; no task may make them writable, every task must list them immutable |
| `resources` | `memoryMb`, `cpus`, `commandTimeoutMs`, `verifierDeadlineMs` |

A task directory holds `task.json` (`id`, `target`, `allowedSourcePaths`,
`immutablePaths` — all repository-relative), `spec.md`, `defect.patch`,
`reference.patch`, `checks.json`, and `checks/` with the independent suite.

`checks.json` names two suites and their runners. There are two runner kinds:

- `node-test`: `{ "runner": "node-test", "file": ..., "assertions": [...] }`.
  The independent suite is always this kind, and its `file` is always under
  `checks/`.
- `vitest`: `{ "runner": "vitest", "assertions": [...] }` with **no** `file` —
  a vitest visible suite is the target's own `commands.test`, graded from the
  JSON report, not a single file the verifier invokes.

**The node-test root-run rule.** A `node:test` suite runs at the **workspace
root** whatever `commands.cwd` says; only the build and a vitest visible suite
`cd` into `commands.cwd`. So a check file names the built artifact by its full
root-relative path (`packages/devkit/dist/testing/index.js`). A cwd-relative
import in a check grades `inconclusive`, not `fail`.

### The capture

`captureTarget(task, role, options)` runs `git archive` for the pin over the
target's include list, extracts it to a fresh directory, and applies the task's
`defect.patch`. `role` is one of `builder`, `controller`, `verifier`,
`reference` or `test`: each gets its own capture, so the builder's workspace,
the controller's baseline digest and the verifier's fresh workspace are three
independent extractions of one source, with no cache. The capture is built in a
scratch sibling and renamed into place, so a failed capture leaves nothing
behind, and it asserts every include path is present after extraction because
`git archive` honours `export-ignore` silently.

The archive is taken from the repository's object store, not its working tree.
If you have uncommitted changes to `packages/devkit`, the factory does not see
them. That is deliberate.

### The image

The image bakes the pnpm dependency closure for the target at the pin. It is
built once per pin by the prepare script and recorded in `target.json` as an
`image` object with exactly these fields: `localId`, `platform`,
`baseManifestDigest`, `dockerfileSha256`, `lockfileSha256`, `pnpmVersion`. The
verifier writes the digest of that object into every receipt as
`environmentIdentity`, and every bundle binds it. Rebuild the image and every
frozen bundle over the old identity becomes unapprovable, which is the intended
behaviour: consent was given for a claim that named the old environment.
`localId` is local to the host that built it; another host can check the
inputs, not pull the image. A registry digest is the rung 3 upgrade.

Inside a container, the dependency trees are symlinks from the workspace into
`/opt/targets/<id>/`. Both shipped targets declare exactly one,
`node_modules` → `/opt/targets/<id>/node_modules`; pnpm resolves through
per-package symlinks inside that one hoisted tree. Every link is declared in
`environmentLinks`, and the workspace reader refuses any root symlink it was
not told to expect.

### Verification, in order

Verification is **two container sessions**, one per suite, run in order. Each
is a whole verification of its own — its own capture instance, its own
container, its own build — and nothing crosses between them but the candidate's
bytes, which the controller holds. The oracle is graded where the candidate's
test code never ran, which is why a process the visible suite leaves behind has
nothing to act on. One deadline covers both sessions.

Session A, the visible suite:

1. Write the candidate's changed files into a fresh capture of the baseline.
2. Run `commands.build` at `commands.cwd`, when the target has one. A failure
   is a failed check (`build:fail`) with the compiler output as evidence; no
   suite runs and session B is not started.
3. Snapshot the workspace. Run `commands.test`, the visible suite — at
   `commands.cwd` for a vitest suite, at the workspace root for a `node-test`
   one. Snapshot again; **any** change at all is tampering and the candidate is
   rejected, session B again not started. Nothing is excluded, the target's
   build output included: the build ran at step 2, before the first snapshot, so
   nothing legitimate writes there while a suite runs — and for devkit it is the
   directory the independent oracle reads.

Session B, the independent check, in a new container:

4. Write the candidate's changed files into a *fresh* capture and run
   `commands.build` again. This build already succeeded in session A, so a
   failure here is two containers disagreeing about the same bytes — a fact
   about the harness, reported as an `inconclusive` `build` check, never as a
   `fail`.
5. Write the independent checks into the container, **before** the first
   snapshot: they are then present in both snapshots of the window, so the two
   collapse into one continuous observation with no gap to write in. Snapshot,
   run them, snapshot again with the same tamper rule.
6. Issue a receipt: `pass`, `fail`, or `inconclusive` when the harness itself
   could not run or ran out of time. Inconclusive blocks; it is never read as
   fail.

The second session costs a capture, a container start and a build — about 1.7 s
on the devkit lane, where a whole verification is ~51 s and each workspace
snapshot alone is ~9.7 s.

The controller's **reader** is where `snapshotIgnore` does apply, one step
earlier. A builder that runs the target's build writes `packages/devkit/dist/**`
into its own workspace, and the assembly rule rejects any path the baseline
lacks — so without a filter every one of those paths would be a
`scope_violation`. The reader drops paths under the target's `snapshotIgnore`
prefixes
(`ignorePrefixes` in `WorkspaceReadOptions`). It is a reader-side filter
applied **after** the walk, because the framework's inspection can exclude root
directories only, so build output still counts against the reader's entry and
byte limits. A target with large build output must raise those limits rather
than expect exclusion.

## How to use it

### Prerequisites

- Node 24 (`nvm use 24`), pnpm at the root `packageManager` version, Docker
  running.
- `pnpm install` at the repository root. A fresh worktree without it fails the
  Docker lanes with "Cannot find package '@b4run/cli'"; that is an install
  problem, not a code problem.

### Prepare a target

```bash
cd examples/software-factory/server
pnpm target:prepare devkit
```

This pulls the base image, builds `targets/devkit/Dockerfile` for the host's
platform, `require.resolve`s each `imageAssertResolves` specifier inside the
built image, and writes the `image` object into `targets/devkit/target.json`.
Commit that change. Until the object is present the target does not load.

`FACTORY_SKIP_BASE_PULL=1` skips the `docker pull` of `node:24-slim` and reads
the digest of whatever copy the host already holds. It exists for a host whose
Docker Desktop registry proxy is wedged and `docker pull` hangs. It is an
explicit opt-in, never a fallback, because it records a base digest nobody
refreshed.

A shallow checkout that lacks the pin fetches that one commit from `origin` on
first load; `FACTORY_NO_FETCH=1` turns a missing pin into a hard error.

### Run one work order end to end

Three processes: the builder, the controller, and the CLI that drives it.

**1. Write the builder's target file.** The builder is a b4 app configured by two inputs the
controller writes: a per-process target file (the target's image, scope, sandbox policy and
permissions, which the framework fixes per app) and, per work order, the captured workspace
bytes, which `dispatch` now uploads over the builder's port before it creates the thread
naming them (this guide's manifest directory is retired). The builder resolves no pin and reads no task catalog of its
own. Writing the target file needs neither a controller nor a registry:

```bash
pnpm --filter @b4-example/software-factory-controller factory builder-target \
  --target devkit --out /tmp/factory-builder
```

**2. Start the builder** (terminal 1). `b4.config.ts` read `FACTORY_BUILDER_TARGET` at
module load in this rung (both it and the manifest directory are refused by name now), and
one builder process served one target:

```bash
FACTORY_BUILDER_TARGET=/tmp/factory-builder/devkit.target.json \
OPENAI_API_KEY=... \
  pnpm --filter @b4-example/software-factory-server dev --port 4100
```

**3. Start the controller** (terminal 2). It is a b4 app too: its mutating commands are
`workflow` routes, and it owns the targets, the task catalog and the registry. Its
environment names the builder to dispatch to (it reads the builder's threads over that URL,
with the worker token) and where its state lives:

```bash
FACTORY_WORKER_URL=http://127.0.0.1:4100 \
FACTORY_STATE_DIR=$PWD/.factory \
FACTORY_WORKER_TOKEN=$TOKEN \
  pnpm --filter @b4-example/software-factory-controller dev --port 4300
```

**4. Drive it** (terminal 3), from the repository root. The CLI's write commands are requests
to the running controller (`FACTORY_CONTROLLER_URL`); its read commands open
`<FACTORY_STATE_DIR>/registry.sqlite` read-only and never reach the controller at all, so both
variables are set:

```bash
export FACTORY_CONTROLLER_URL=http://127.0.0.1:4300
export FACTORY_STATE_DIR=$PWD/.factory
alias factory='pnpm --filter @b4-example/software-factory-controller factory'

factory create --task devkit-spawn-deadline
factory dispatch <work-order-id>     # awaits the run; journal events on stderr
factory show <work-order-id>
```

`dispatch` awaits: the route creates the builder thread, observes the turn, verifies, and
answers only when the work order has stopped moving. There is no `--wait` flag and no
fire-and-forget mode. A client that disconnects does not stop the run; reconnect with `show`.

`FACTORY_REPO_ROOT` is the repository the targets pin into. It defaults to
`git rev-parse --show-toplevel` from the package, so you normally leave it
unset; the Docker-lane tests set it because they copy the app outside the
repository, and so must anything else that runs the controller from a copied
app root.

`show` reports the state. When it reads `awaiting_approval`, inspect the
evidence and approve the bundle digest it names:

```bash
factory evidence <work-order-id>
factory approve <work-order-id> --revision <n> --bundle <digest>
```

The export lands in the configured export directory as `<digest>.json`,
holding the bundle and the changed files. Approving again with the same key
returns the recorded outcome and writes nothing.

One unprepared target does not stop the controller: the task table is built per
task and a task that cannot load is omitted and reported, so a work order
naming it is refused as unknown while every other task keeps working.

### Add a task against an existing target

1. Create `tasks/<id>/` with `task.json` naming the target, the allowed source
   paths and the immutable paths, all as repository paths. Every one of the
   target's `runnerConfig` files must appear in `immutablePaths`, and none may
   be reachable from an allowed path.
2. Write `spec.md` with `A1:`-style acceptance IDs and non-goals.
3. Generate `defect.patch` and `reference.patch` from the pin. The easiest way
   is a scratch branch from the pin: make the defect, `git diff` it into
   `defect.patch`; then the fix, and `git diff` from the defective state into
   `reference.patch`.
4. Write one or more checks under `checks/` and map them to acceptance IDs in
   `checks.json`. A check should run the built artifact by its root-relative
   path, not the source, and should be a different oracle from the visible test
   that covers the same ID.
5. Run the layer 1 suite; it will tell you if the patches do not apply to the
   pin, do not round-trip, or the manifest is inconsistent.

### Add a target

1. Create `targets/<id>/target.json` with the pin, the capture lists, the
   environment links, the runner configuration files and the commands. Leave
   `image` absent; the prepare script writes it.
2. Write the Dockerfile. Copy only what the filtered install needs.
3. Run `pnpm target:prepare <id>` and commit the `image` object it writes. You
   do **not** need to run `biome check --write targets` afterwards: the script
   writes the manifest and then runs `npx biome format --write <manifest>` from
   the app root itself, keeping `image` last, so the tree is left lint-clean.
4. Add the target to CI: the `sandbox-docker` job prepares every target the
   factory's lanes need, before `test:sandbox`. A new target needs a line
   there or its lanes fail on "has not been prepared".
5. Measure `commands.build` and `commands.test` in the prepared container
   three times and set the memory, per-command ceiling and verifier deadline
   from the slowest run with real headroom.

Devkit is the worked example. Three green runs under the prepared image
measured build **355 ms**, test **7393 ms** and peak **367 MiB**, which became
`commandTimeoutMs` 60000 and `memoryMb` 768 — the per-command ceiling is about
8× the slowest command and the memory limit is about 2× peak. The deadline is
measured differently, because it covers a whole verification end to end: two
captures, two containers, two builds, both suites and four snapshots. The
slowest measured verification is 59.8 s, which with the three-times rule and a
margin for a loaded host gives `verifierDeadlineMs` **240000**.

The manifest's `commands` argv is trusted on two paths beyond the verifier: the
builder's bash allow-list and the builder's prompt are both derived from it, so
a command the manifest does not name is neither pre-approved nor asked for. The
allow-list admits each invocation both at the workspace root and under
`cd <cwd> && `, which is the form the prompt tells the builder to type.

### Advance a pin

Edit `pin`, regenerate both patches if they no longer apply (layer 1 tells
you), re-run the prepare script, commit all three changes together. Every
bundle frozen under the old digest is now unapprovable, which is correct.

## Does it make sense?

Yes, with one honest qualification. The design is the rung 1 controller with
its inputs generalized, and every rung 1 property carries over unchanged. The
part that is genuinely new is small: an archive step, an image recipe, two
catalogs, and a build command before the tests. That is the right size for a
rung whose job is to prove the factory can face a real package at all.

The qualification is that rung 2 proves a scripted repair, not a produced one.
The ladder is explicit about this, and the guide should be too: at the end of
rung 2 nobody has watched a model repair devkit. What has been shown is that if
a builder wrote the right bytes, the controller would find them, verify them
under a policy the builder cannot see, and export exactly those bytes and no
others.

What execution added to that claim is worth stating, because it was not
obviously true beforehand: the builder's *own* build and test invocations run
inside its container, against the real dependency link, and are admitted by the
permissions derived from the target's manifest. That is proven in
`test/devkit-end-to-end.integration.test.ts`, where the scripted turn reads,
writes, builds and tests before the controller ever looks.

## What is missing

- **A pin that advances itself.** Every pin advance is a manual edit, a patch
  regeneration and an image rebuild. Rung 3 needs the factory to target main as
  it moves, which this design does not attempt.
- **A second monorepo target.** Two targets ship, but one of them (`cli-flags`)
  is a fixture project, so devkit alone carries the monorepo shape.
  `packages/permissions` or `packages/sqlite-storage` would prove the shape is
  not devkit-shaped.
- **A visible surface that covers the package.** Nine of devkit's eleven test
  files are excluded, so the visible suite is twelve tests in two files. It
  contains the graded regression test, which is what the admission gate needs,
  but it is not devkit's suite.
- **`test:fail` detail in the check output.** The node-test runner captures
  stdout and stderr events only, so a failing independent check has to print
  its own diagnosis; carrying the structured failure into the receipt is a
  follow-up.
- **Independent checks with a maintenance owner.** Checks live with the task
  and are written by the operator. When the target's API drifts under them
  they fail, which is loud, but nobody is on the hook to keep them current
  except whoever runs the factory next.
- **Any statement about cost.** The resource limits are measured; the token
  and wall-clock cost of a verification are not recorded anywhere a reviewer
  can see them.
- **A budget for verification itself.** The per-work-order budget counts active
  time, and verification is active, so a long verification burns the budget.
  The devkit end-to-end lane has to allow four times the target's own deadline
  for what is one builder turn and two verifications. That is defensible but
  nobody has decided it on purpose.

## What is difficult

- **Getting the pnpm closure right in the image.** The filtered install has to
  match the lockfile at the pin exactly, or the visible suite fails for reasons
  that have nothing to do with the candidate and the verdict is `fail`, not
  `inconclusive`. The verifier cannot tell an environment defect from a
  candidate defect once the container is up. Layer 2 exists to catch this, and
  it is the layer to run first after any Dockerfile change.
- **The container is not the host.** Devkit's tests spawn processes, and the
  Docker sandbox had no PID 1 reaper, so its process-tree tests failed only
  inside a container and nowhere else. `packages/sandbox` now starts the
  session container with `--init` (a changeset ships with this branch). A
  target whose tests observe process state will find this class of difference
  before anything else does.
- **Tests that read outside the capture.** Devkit has nine. The framework's
  capture rejects the parentheses and brackets in Next.js route paths, so
  `packages/devkit/templates` cannot be captured at all, and every test that
  reads the templates or compares them against `examples/research` had to be
  excluded in `commands.test`. The capture include list and the test command
  have to be designed together, and there is no tool that tells you which tests
  read what.
- **Generating honest patches.** `defect.patch` must re-create the historical
  defect on current code, not on the code as it was. When the surrounding code
  has moved, the patch is a re-interpretation, and it is worth writing down in
  `spec.md` that the re-seeded defect is equivalent to, not identical to, the
  historical one.
- **Snapshot exclusions were a real hole, and not a small one.** The tamper
  comparison used to honour `snapshotIgnore`, so a suite could hide a write
  under `dist` — which is precisely where the independent oracle reads the
  built artifact from. A candidate that spawned a detached writer could
  therefore choose its own verdict. The comparison now excludes nothing;
  `snapshotIgnore` is a reader-side and `.gitignore` concern only.
  `test/verifier-tamper.integration.test.ts` is the adversarial proof.
- **The vitest report channel.** The runner names its JSON report path and its
  stdout marker with a per-run nonce and validates the parsed report with a
  schema, so a suite cannot hand the grader a forged summary by writing a file
  at a guessable path. The residual is recorded in the spec: a background
  writer that reads the nonce out of its own argv could still overwrite the
  report after vitest exits.

## Where the pain points are

- **Preparing an image finds toolchain assumptions one at a time.** Vite writes
  a temp bundle under the nearest `node_modules`, which is a read-only mount in
  the sandbox and from which Vite tolerates only `EACCES`, so the devkit image
  links `node_modules/.vite-temp` to `/tmp`. A host whose Docker Desktop
  registry proxy is wedged hangs `docker pull`, which is what
  `FACTORY_SKIP_BASE_PULL=1` is for. Each of these cost a rebuild to discover,
  and none of them is visible from the manifest.
- **The prepare step is a manual, out-of-band action** that mutates a
  checked-in file. Forgetting it gives a target that will not load, which is
  the right failure, but the error will be met by every new contributor. CI
  runs it too, which means CI's `target.json` diff (its own `localId` and
  `linux/amd64`) is expected and nothing in that job may assert a clean tree.
- **Two containers per verification** on a developer laptop that is also
  running the test suite. Measured on this branch: the devkit layer 2 lane
  about 110 s, the devkit end-to-end lane about 130 s, the full Docker lane
  (five files) about five minutes. Expect it to be the first thing skipped
  locally.
- **Path semantics changed.** Rung 1 paths were workspace-relative under
  `src/`; rung 2 paths are repository-relative under `packages/<name>/`. Every
  place that assumed the old shape, including the assembly policy and the
  scope-violation tests, had to be re-read rather than re-pointed.
- **Timing.** The verifier's deadline, the sandbox's per-command ceiling and
  the per-work-order active budget are three clocks that all have opinions
  about a ten-minute verification. When one fires first the record is
  correct, because the hardening PR made the abort per work order, but which
  one fired is only visible in the event journal.
- **The example's own tests are the slowest package in `pnpm test:sandbox`.**
  The rung 1 handoff already noted the process-spawn-contention flake class.
  Every layer 2 and 3 test here spawns a container; keep them under the Docker
  gate and keep their assertions on the thing they mean to be inside, not on a
  state transition that precedes it.
