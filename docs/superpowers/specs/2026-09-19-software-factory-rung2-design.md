# Software factory, rung 2: the builder retargeted at the b4run monorepo

Date: 2026-09-19
Status: design approved in conversation; awaiting written review
Program document: [b4.run Software Factory RFC 001](2026-09-16-software-factory-rfc.md)
Predecessors: [rung 0](2026-09-16-software-factory-rung0-design.md) `8dbc0bdb`, [rung 1](2026-09-18-software-factory-rung1-design.md) `c8e4f952`, byte channel `1e54414c`, hardening `9d676522`, managed-workspace read `516c038c`
Source snapshot: `3a26d1a2`

## Decision

Point the rung 1 controller at one member of this repository, `packages/devkit`,
at a pinned commit, and prove that the controller can baseline, build and test
it in its own container and that a scripted repair of a known past defect in it
verifies. The ladder row this rung completes reads: "Worker retargeted at the
b4run monorepo: pinned image with the pnpm dependency closure baked in, source
capture of an allowlisted package, per-package checks, resources sized for
turbo."

Nothing about the controller's authority split changes. The builder still edits
a managed workspace it cannot report a verdict from; the controller still reads
those bytes itself, verifies them in its own container under a policy the
builder cannot see, freezes a bundle and exports on approval. What changes is
where the bytes come from and what the checks are.

## Decisions taken in conversation

- **First target: `packages/devkit`.** Nine source files, eleven test files,
  no container references, one workspace dependency (`@b4run/config-typescript`).
  The smallest dependency closure in the repository that has real tests.
- **First defect: the dangling deadline on asynchronous spawn failure**, fixed
  in `67a15d2b` (2026-08-10). Before that fix, `spawnProcess` on a missing
  command rejected with `ENOENT` while the deadline timer it had armed stayed
  armed. The defect is in `src/testing/process.ts`, so rung 1's source-only
  write policy holds, and the fix has an existing regression test.
- **Independent checks are specification-owned, not target-owned.** RFC 5.3
  makes the approved specification a versioned contract carrying acceptance
  IDs; RFC 9.2 says authoritative checks come from maintainers or a reviewed
  check-authoring process. The checks are therefore the executable form of a
  task's acceptance criteria, live with the task, and are structurally absent
  from the builder's capture. Checks committed into a target repository land in
  the visible surface, never the independent one.
- **Two catalogs replace the fixture directory.** A target describes an
  environment and how to reproduce it; a task describes one repair against one
  target. Rung 1's single `fixtures/<id>` directory collapsed both, which is the
  seam leak the rung 1 handoff flagged.
- **Pinned archive capture, not a checkout in the image and not a whole-repo
  capture.** See "Alternatives rejected".
- **The scope was trimmed twice during design.** A second weak-repair check and
  a second scripted builder, a capture cache, a `git apply --check` pass, a
  tag-versus-digest guard in the prepare script, a visible-suite exclusion field
  and a host path in the target manifest were all removed. Each solved a
  problem this rung does not have.

## What the two catalogs are

Both live under `examples/software-factory/server`, are plain directories read
at boot, are validated with zod, and are digested into the bundle.

### `targets/<id>/target.json`

| Field | Meaning |
|---|---|
| `id` | The target id; must equal the directory name. |
| `pin` | A full 40-hex commit SHA in the repository the factory runs inside. The loader refuses anything else and refuses a pin the local object store does not contain. |
| `capture` | `{ include: string[], excludeDirectories: string[] }`, paths relative to the repository root, passed to `git archive` and then to the workspace capture. For devkit: include `packages/devkit`, `packages/config-typescript`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`; exclude `dist`, `node_modules`, `.turbo`. |
| `image` | `{ digest: string }`, the image id the prepare script wrote back, `sha256:` plus 64 hex. The verifier records it verbatim as `environmentIdentity`. A missing digest is a load error: a target is not usable until it has been prepared. |
| `environmentLinks` | Where the image's dependency trees mount into the workspace. For pnpm this is two links: `node_modules` and `packages/devkit/node_modules`, both under `/opt/targets/<id>/`. |
| `commands` | `{ cwd, build: string[], test: string[] }`, argv arrays run at `cwd` relative to the workspace root, no shell. For devkit: `cwd` `packages/devkit`, build `["pnpm","build"]`, test `["pnpm","test","--","--exclude","test/template-thread-access.test.ts"]`. The exclusion carries a comment: that test reads `examples/research/server/src`, which is outside the capture. No turbo runs inside the container. |

The repository is not a field. Rung 2 is a dogfood: the target repository is the
one the factory is running inside, resolved once with
`git rev-parse --show-toplevel`. An external repository is rung 4's concern.

### `tasks/<id>/`

| Entry | Meaning |
|---|---|
| `task.json` | `id`, `target`, `allowedSourcePaths`, `immutablePaths`. Paths are repository paths, e.g. `packages/devkit/src/testing/process.ts`. The rung 1 regex that required `src/*.ts` at the workspace root is replaced by the rule that already carried the weight: allowed and immutable are disjoint, and an allowed path never ends in `.test.ts`. |
| `spec.md` | What to change and what to preserve, with acceptance IDs in the RFC's `A1:` form and explicit non-goals. Its digest is `specificationDigest`. |
| `defect.patch` | Applied to the archive before capture. Re-seeds the known regression on top of the pin, so the baseline is current code with one known defect rather than an old commit. |
| `reference.patch` | The forward repair. Used only by the scripted builder in layer 3 and never read by the verifier. |
| `checks.json` | Maps the visible suite and the independent suite to the acceptance IDs they cover, as in rung 1. |
| `checks/` | The independent suite. Structurally absent from the capture; the verifier writes it into its own container after the visible suite has run. |

`policyDigest` is computed over `task.json`, `checks.json`, the bytes of every
file under `checks/`, and the target's `image.digest`. A change to any of them
invalidates a frozen bundle at approve, which rung 1 already enforces.

### The task in this rung: `devkit-spawn-deadline`

- `defect.patch` removes the `clearTimeout` on the spawn-error path in
  `spawnProcess`; `reference.patch` restores it. Both are generated once from
  the pin and checked in. A layer 1 test applies both to the pin and fails if
  either no longer applies, so a pin advance that breaks the task fails the
  task's own test rather than the verifier.
- `spec.md` has two criteria. A1: a spawn that fails asynchronously rejects with
  the spawn error and leaves no deadline timer running. A2: the existing
  behaviour of `spawnProcess` is unchanged, evidenced by the package's own
  suite. Non-goal: nothing outside `packages/devkit/src/testing/process.ts`.
- The visible suite is devkit's own `vitest --run` minus the excluded parity
  test. It already contains the regression test added by `67a15d2b`, which
  uses fake timers and asserts a zero timer count.
- The independent suite is one file. It runs a child `node` that imports the
  built `dist/`, calls `spawnProcess` on a missing command with a long
  deadline, and lets its event loop drain; the check asserts the child exits
  within two seconds. It is a different oracle from the fake-timer test and it
  exercises the built artifact, which is what a consumer runs.
- The scripted builder is one model script: read the file, write the repaired
  file, stop.

## Capture and image

### Archive

A new module `src/targets/archive.ts` exports one function,
`captureTarget(taskId, signal)`. It resolves the repository root, runs
`git archive <pin> -- <include...>` into a fresh temporary directory under
`.factory/captures/`, extracts it, runs `git apply` with the task's
`defect.patch` (a reject is a thrown error), and returns the directory. There
is no cache: `git archive` of a hundred files is milliseconds, and a cache
would need invalidation the rung does not otherwise need.

`captureBaseline` reads that directory. The builder's workspace definition
points its `source.directory` at that directory with the target's include and
exclude lists, so both containers see the same defective bytes and the
baseline digest is over the archive, never over the host's working tree.

Why an archive and not the checkout: the factory runs inside the repository it
targets. A baseline read from the working tree would depend on whatever the
operator has uncommitted, and a work order reconciled on another day would see
different bytes. The pin is the only source of truth.

### Image

`targets/devkit/Dockerfile` starts from a digest-pinned `node:24-slim`,
installs git, enables corepack at the `packageManager` version from the root
manifest, copies the root manifests, the lockfile and the two `package.json`
files in devkit's closure at the pin, and runs
`pnpm install --frozen-lockfile --filter @b4run/devkit... --ignore-scripts`.
The resulting `/opt/targets/devkit/node_modules` and
`/opt/targets/devkit/packages/devkit/node_modules` are the two link targets.

`scripts/prepare-target.ts <id>` mirrors code-fixer's prepare script: pull and
digest-pin the base image, `docker build`, `docker image inspect`, and write
the image id into `target.json` as `image.digest`. A rebuilt image has a new
digest; the manifest names the old one until the script is run again, and
approve already refuses a bundle whose environment moved.

### Links inside the workspace

pnpm resolves a package's dependencies through the package's own
`node_modules` symlinks into the root `.pnpm` store, so both directories must
be present and must come from one install. The inspection options derive every
expected root symlink from the target's `environmentLinks`, the same derivation
rung 1 uses for one link, so the reader and the verifier cannot disagree about
what a legitimate root symlink is.

### Resources

The sandbox policy for this target sets memory to 2048 MiB, the per-command
ceiling to 300 s, and the verifier deadline to 600 s. These are placeholders
for the plan to replace with measured values: the plan runs
`pnpm build` and `pnpm test` for devkit in the prepared container three times
and records the slowest run, and the written limits must give at least three
times that headroom (the wedge-detector rule from the timing-flake work, not a
stopwatch). Network stays denied; the frozen install is the point.

## What changes in the verifier and the reader

- `loadFixture(taskId)` becomes `loadTask(taskId)`, which also loads the task's
  target. One function, `targetWorkspace(taskId)`, the successor of
  `fixtureWorkspace`, yields the workspace definition, the inspection options
  and the sandbox policy for the builder config, the reader and the verifier.
- The verifier runs `commands.build` once at `commands.cwd` after writing the
  candidate and before the visible suite. A build failure is a failed visible
  check with the compiler output as evidence, not inconclusive: it is a fact
  about the candidate.
- `environmentIdentity` is the target's `image.digest`. The rung 1 caveat about
  mutable tags comes out of the README and the verifier.
- The before-and-after snapshot around each suite excludes `dist`, `.turbo` and
  the vitest cache under the package directory, because the build writes there
  legitimately. Any other change during a suite is still tampering.
- The reader needs no code change.

## Lifecycle, cancel, budget and reconciliation

Unchanged from rung 1 plus the hardening in `9d676522`: per-work-order
verification abort, re-verification as a tracked background run, exports
compared by content. Verification is longer for this target, which is why the
per-work-order abort matters here: a cancelled work order must not hold a
2 GiB container for ten minutes.

## Proof

Three layers, the shape rung 1 established. Layer 1 is the only always-on
layer; an invariant that must hold on every push is asserted there.

### Layer 1: fakes, always on

- Catalog loading rejects: a pin that is not 40 hex, a pin absent from the
  object store, a task naming an unknown target, overlapping allowed and
  immutable paths, an allowed path ending in `.test.ts`, a target without an
  image digest.
- The archive module, against a throwaway git repository built in the test:
  the archive contains exactly the include list, the defect patch is applied,
  and the baseline digest is identical across two captures.
- The task's two patches apply cleanly to the pin.
- The rung 1 invariants re-asserted through the new catalogs with the fake
  verifier: visible pass plus independent fail cannot reach
  `awaiting_approval`; an immutable-path edit is a scope violation; a changed
  image digest invalidates a frozen bundle at approve.

### Layer 2: the real image, Docker-gated

In a real container from the prepared image: `commands.build` then
`commands.test` pass on the unpatched pin, and the visible regression test
fails on the defect-patched baseline. This is the ladder's "baseline, build and
test one `packages/*` member in the sandbox".

### Layer 3: end to end, Docker-gated

The scripted builder writes the reference repair into its own managed
workspace; the controller reads it through the byte channel, verifies in its
container, freezes, approves and exports. The exported changes equal
`reference.patch` applied to the baseline. This is the ladder's "a scripted
repair of a known past defect verifies".

### What the proof does not claim

No live model, no repair loop, no target other than devkit at one pin, no
external repository, nothing about verification cost beyond the measured
limits, and nothing about repair quality beyond one scripted repair. Rung 3 is
where a model produces the repair.

## Alternatives rejected

- **A checkout baked into the image, no capture.** Fastest to start, but the
  builder's workspace is then not a managed capture, so the byte channel has
  nothing to read, the baseline digest must come from inside a container the
  builder can touch, and every task needs a new image. It undoes the rung 1
  authority split.
- **Whole-repository capture.** The capture limits are 10,000 entries and
  64 MiB; the repository exceeds both, and a builder would see the factory's
  own source.
- **Checks committed into `packages/devkit`.** Independence would rest on an
  exclusion rule rather than on structural absence, and an external target has
  no equivalent.

## Repository layout

```
examples/software-factory/server/
  targets/
    devkit/
      target.json
      Dockerfile
  tasks/
    devkit-spawn-deadline/
      task.json
      spec.md
      defect.patch
      reference.patch
      checks.json
      checks/
        spawn-deadline.test.ts
  scripts/
    prepare-target.ts
  src/
    targets/
      catalog.ts        # loadTarget, loadTask, targetWorkspace
      archive.ts        # captureTarget
    fixtures/           # removed; cli-flags moves to tasks/ + targets/
```

The rung 1 `cli-flags` fixture is re-expressed as a target and a task so layer 1
keeps a fast, container-free path, and `src/fixtures/` is deleted. That
retirement is what closes the handoff's seam-leak item.

## Risks accepted for rung 2

- **Same host, no authentication.** Unchanged.
- **One pin.** Advancing it is a manual edit plus a prepare run; nothing
  automates or verifies the advance beyond the layer 1 patch-applies test.
- **The image trusts its build.** The Dockerfile is pinned to a base digest and
  a frozen lockfile, but the image is built on the operator's machine and the
  digest recorded is whatever that build produced.
- **The verifier still shares an image with the builder.** As in rung 1; an
  untrusted candidate can observe its runtime.
- **One excluded test.** The visible suite is devkit's suite minus one file,
  and the exclusion is a fact about the capture, recorded in the command.

## Success criteria

1. Layer 1 passes in CI on every push; layers 2 and 3 pass under the Docker
   gate.
2. `targets/devkit` builds and tests in its container from the prepared image
   on the unpatched pin, and the visible regression test fails on the
   defect-patched baseline.
3. The scripted repair of `devkit-spawn-deadline` reaches `exported` through
   the byte channel, and the exported changes equal the reference repair.
4. A candidate that passes the visible suite and fails the independent check
   cannot reach `awaiting_approval`, asserted in layer 1 through the new
   catalogs.
5. `src/fixtures/` is gone and `cli-flags` runs as a target and a task.
6. Every resource limit in the target's policy is a measured value with the
   measurement recorded in the plan.
7. `examples/code-fixer` has no diff, and `pnpm ci:validate` is green.
