# Software factory, rung 2: developer guide (draft)

Status: DRAFT written alongside the [rung 2 design](../specs/2026-09-19-software-factory-rung2-design.md)
before any rung 2 code exists. Every command below is the intended command;
reconcile this file against the implementation before treating it as a runbook.

This guide is for someone who wants to run the factory against a package in
this repository, add a target or a task, and understand what each moving part
is for. It ends with an honest list of what is missing and where it hurts.

## What the factory is, in one paragraph

A work order names a task. A task names a target and a repair. The controller
captures the target at a pinned commit with a known defect applied, hands that
capture to a builder agent in a container, and waits for the builder's turn to
end. It then reads the builder's workspace itself, diffs it against the
baseline it captured, and verifies the candidate in a second container the
builder never touched: build, the package's own tests, then an independent
check the builder never saw. A passing verdict freezes a review bundle whose
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

### The capture

`captureTarget` runs `git archive` for the pin over the target's include list,
extracts it to a fresh directory, and applies the task's `defect.patch`. That
directory is the baseline. The builder's workspace is captured from it, the
controller's baseline digest is computed from it, and the verifier's fresh
workspace is captured from it. Three consumers, one source, no cache.

The archive is taken from the repository's object store, not its working tree.
If you have uncommitted changes to `packages/devkit`, the factory does not see
them. That is deliberate.

### The image

The image bakes the pnpm dependency closure for the target at the pin. It is
built once per pin by the prepare script and recorded in `target.json` as an
`image` object: the local image id and the inputs that produced it (base
manifest digest, platform, Dockerfile and lockfile hashes, pnpm version). The
verifier writes the digest of that object into every receipt as
`environmentIdentity`, and every bundle binds it. Rebuild the image and every
frozen bundle over the old identity becomes unapprovable, which is the intended
behaviour: consent was given for a claim that named the old environment. The
id is local to the host that built it; another host can check the inputs, not
pull the image. A registry digest is the rung 3 upgrade.

Inside a container, the dependency trees are symlinks from the workspace into
`/opt/targets/<id>/`. There are two for pnpm, the root `node_modules` and the
package's own, because pnpm resolves through per-package symlinks into one
store. Both are declared in `environmentLinks`, and the workspace reader
refuses any root symlink it was not told to expect.

### Verification, in order

1. Write the candidate's changed files into a fresh capture of the baseline.
2. Run `commands.build` at `commands.cwd`. A failure is a failed check with the
   compiler output as evidence.
3. Snapshot the workspace. Run `commands.test`, the visible suite. Snapshot
   again; any change outside `dist`, `.turbo` and the vitest cache is tampering
   and the candidate is rejected.
4. Write the independent checks into the container. Snapshot, run them,
   snapshot again with the same rule.
5. Issue a receipt: `pass`, `fail`, or `inconclusive` when the harness itself
   could not run or ran out of time. Inconclusive blocks; it is never read as
   fail.

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
pnpm exec tsx scripts/prepare-target.ts devkit
```

This pulls the base image, builds `targets/devkit/Dockerfile` for the pinned
platform, asserts the install matches the lockfile, and writes the `image`
object (local image id plus the inputs that produced it) into
`targets/devkit/target.json`. Commit that change. Until the object is present
the target does not load.

### Run one work order end to end

Two processes, as in rung 1. Terminal 1 is the builder, a b4 app whose
`b4.config.ts` reads `FACTORY_TASK_ID` to pick the target and task:

```bash
cd examples/software-factory/server
FACTORY_TASK_ID=devkit-spawn-deadline OPENAI_API_KEY=... pnpm dev --port 4100
```

Terminal 2 is the controller:

```bash
cd examples/software-factory/server
export FACTORY_WORKER_URL=http://127.0.0.1:4100
export FACTORY_STATE_DIR=$PWD/.factory
pnpm factory create --task devkit-spawn-deadline
pnpm factory dispatch <work-order-id> --wait
pnpm factory show <work-order-id>
```

`show` reports the state. When it reads `awaiting_approval`, inspect the
evidence and approve the bundle digest it names:

```bash
pnpm factory evidence <work-order-id>
pnpm factory approve <work-order-id> --revision <n> --bundle <digest>
```

The export lands in the configured export directory as `<digest>.json`,
holding the bundle and the changed files. Approving again with the same key
returns the recorded outcome and writes nothing.

### Add a task against an existing target

1. Create `tasks/<id>/` with `task.json` naming the target, the allowed source
   paths and the immutable paths, all as repository paths.
2. Write `spec.md` with `A1:`-style acceptance IDs and non-goals.
3. Generate `defect.patch` and `reference.patch` from the pin. The easiest way
   is a scratch branch from the pin: make the defect, `git diff` it into
   `defect.patch`; then the fix, and `git diff` from the defective state into
   `reference.patch`.
4. Write one or more checks under `checks/` and map them to acceptance IDs in
   `checks.json`. A check should run the built artifact, not the source, and
   should be a different oracle from the visible test that covers the same ID.
5. Run the layer 1 suite; it will tell you if the patches do not apply to the
   pin or the manifest is inconsistent.

### Add a target

1. Create `targets/<id>/target.json` with the pin, the capture lists, the
   environment links, the runner configuration files and the commands. Leave
   `image` absent; the prepare script writes it.
2. Write the Dockerfile. Copy only what the filtered install needs.
3. Run the prepare script; commit the digest it writes.
4. Measure `commands.build` and `commands.test` in the prepared container
   three times and set the policy's memory, per-command ceiling and verifier
   deadline from the slowest run with at least three times headroom. Record the
   measurements in the plan or the target's README.

The manifest's `commands` argv is trusted on two paths beyond the verifier: the
builder's bash allow-list and the builder's prompt are both derived from it, so
a command the manifest does not name is neither pre-approved nor asked for.

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

## What is missing

- **A pin that advances itself.** Every pin advance is a manual edit, a patch
  regeneration and an image rebuild. Rung 3 needs the factory to target main as
  it moves, which this design does not attempt.
- **A second target.** One target proves the catalog shape; two would prove
  that the shape is not devkit-shaped. `packages/permissions` or
  `packages/sqlite-storage` are the natural candidates.
- **Independent checks with a maintenance owner.** Checks live with the task
  and are written by the operator. When the target's API drifts under them
  they fail, which is loud, but nobody is on the hook to keep them current
  except whoever runs the factory next.
- **Any statement about cost.** The resource limits are measured; the token
  and wall-clock cost of a verification are not recorded anywhere a reviewer
  can see them.
- **A budget for verification itself.** The per-work-order budget counts active
  time, and verification is active, so a long verification burns the builder's
  budget. That is defensible but nobody has decided it on purpose.

## What is difficult

- **Getting the pnpm closure right in the image.** The filtered install has to
  match the lockfile at the pin exactly, or the visible suite fails for reasons
  that have nothing to do with the candidate and the verdict is `fail`, not
  `inconclusive`. The verifier cannot tell an environment defect from a
  candidate defect once the container is up. Layer 2 exists to catch this, and
  it is the layer to run first after any Dockerfile change.
- **Tests that read outside the capture.** Devkit had one. A target with many
  is a target whose visible suite is mostly excluded, and at that point the
  visible surface stops meaning much. The capture include list and the test
  command have to be designed together, and there is no tool that tells you
  which tests read what.
- **Generating honest patches.** `defect.patch` must re-create the historical
  defect on current code, not on the code as it was. When the surrounding code
  has moved, the patch is a re-interpretation, and it is worth writing down in
  `spec.md` that the re-seeded defect is equivalent to, not identical to, the
  historical one.
- **Snapshot exclusions.** Excluding `dist` from the tamper check is necessary
  because the build writes there, and it means a suite that writes into `dist`
  can hide something. For devkit this is acceptable; for a target whose tests
  build into `dist` deliberately it would need thought.

## Where the pain points are

- **Preparing an image finds toolchain assumptions one at a time.** Vite writes a temp
  bundle under the nearest `node_modules`, which is read-only in the sandbox, so the devkit
  image links that directory to `/tmp`. The framework's capture rejects the parentheses
  and brackets in Next.js route paths, so devkit's templates cannot be captured and the nine
  tests that read them are excluded; the visible suite is twelve tests in two files. A host whose Docker Desktop registry proxy is wedged
  hangs `docker pull`; `FACTORY_SKIP_BASE_PULL=1` builds from the local base as an explicit
  opt-in. Run `biome check --write targets` after every prepare. Each of these cost a
  rebuild to discover.

- **The prepare step is a manual, out-of-band action** that mutates a
  checked-in file. Forgetting it gives a target that will not load, which is
  the right failure, but the error will be met by every new contributor.
- **Two containers per verification, each with a 2 GiB limit,** on a
  developer laptop that is also running the test suite. The Docker lanes are
  already the slow part of the factory's own tests; rung 2 makes them slower.
  Expect the layer 2 and layer 3 tests to be the first thing skipped locally.
- **Path semantics changed.** Rung 1 paths were workspace-relative under
  `src/`; rung 2 paths are repository-relative under `packages/<name>/`. Every
  place that assumed the old shape, including the assembly policy and the
  scope-violation tests, has to be re-read rather than re-pointed.
- **Timing.** The verifier's deadline, the sandbox's per-command ceiling and
  the per-work-order active budget are three clocks that all have opinions
  about a ten-minute verification. When one fires first the record is
  correct, because the hardening PR made the abort per work order, but which
  one fired is only visible in the event journal.
- **The example's own tests become the slowest package in `pnpm test`.** The
  rung 1 handoff already noted the process-spawn-contention flake class. Every
  layer 2 and 3 test here spawns a container; keep them under the Docker gate
  and keep their assertions on the thing they mean to be inside, not on a state
  transition that precedes it.
