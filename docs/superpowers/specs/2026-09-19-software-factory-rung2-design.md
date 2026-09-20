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
| `root` | The repository directory that becomes the workspace root, `.` for the repository itself. `git archive <pin>:<root>` produces an archive rooted there, so task paths are root-relative and a target whose root is a subdirectory keeps short paths. `cli-flags` uses `examples/software-factory/server/fixtures/cli-flags/project`; devkit uses `.`. |
| `capture` | `{ include: string[] }`, paths relative to `root`, the pathspec for `git archive`. It is the capture's definition and enters the policy digest as such. The framework's workspace capture requires an exact flat file inventory, so the workspace definition derives that list by walking the extracted archive rather than passing this field through. For devkit: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `packages/devkit`, `packages/config-typescript`. The lockfile is not captured: the image already holds the install, and nothing at run time reads it. There is no exclude list: an archive of a commit contains only tracked files, so `dist`, `node_modules` and `.turbo` are absent by construction. |
| `snapshotIgnore` | Path prefixes, root-relative, that a suite may legitimately write under: for devkit `packages/devkit/dist/`. The verifier's before-and-after tamper comparison skips them; everything else that changes during a suite is still tampering. Inspection can only exclude root directories, which is why this is a verifier-side filter. |
| `image` | Written by the prepare script: `{ localId, platform, baseManifestDigest, dockerfileSha256, lockfileSha256, pnpmVersion }`. `localId` is the Docker image id and is named as such: it is the hash of the image's config JSON, host-specific and not a registry digest. The environment identity every bundle binds is the sha256 of this whole object, so a second host can verify that the same inputs were used even though it cannot pull the image. A missing `image` is a load error: a target is not usable until it has been prepared. Pushing to a registry and binding the manifest digest instead is the rung 3 upgrade. |
| `environmentLinks` | Where the image's dependency tree mounts into the workspace: one root link, `node_modules` to `/opt/targets/<id>/node_modules`. The image installs with pnpm's hoisted linker so every dependency, including workspace siblings, resolves from that one tree. Inspection validates root symlinks only and refuses nested ones, which rules out pnpm's default per-package `node_modules` links. |
| `imageContext`, `lockfile`, `imageAssertResolves` | What the prepare script needs: the repository paths copied into the build context at the pin, the lockfile path whose sha256 enters the image object, and module specifiers that must resolve from `commands.cwd` inside the built image (for devkit `vitest`, `typescript`, `@types/node/package.json`). The resolve assertion is what catches an install that silently skipped a platform-matched optional dependency. |
| `commands` | `{ cwd, build: string[], test: string[], nodeTestExecArgv: string[] }`. `build` and `test` are argv arrays run at `cwd` relative to the workspace root through a quoting join, never a shell string from the manifest. For devkit: `cwd` `packages/devkit`, build `["pnpm","exec","tsc","-b","tsconfig.json"]`, test `["pnpm","exec","vitest","--run","--no-cache","--config","vitest.config.ts","--exclude","test/template-thread-access.test.ts"]`. `test` must be a vitest invocation: the runner appends `--reporter=json --outputFile=<path>` and grades the report. The exclusion carries a comment: that test reads `examples/research/server/src`, which is outside the capture. `--no-cache` because the dependency tree is a read-only mount. `nodeTestExecArgv` is what a `node:test` suite (the independent checks, and cli-flags's visible suite) is run with: `["--import","tsx"]` for cli-flags, `[]` for devkit, whose checks rely on Node 24's native type stripping because tsx is not in its closure. No turbo runs inside the container. |
| `resources` | `{ memoryMb, cpus, commandTimeoutMs, verifierDeadlineMs }`, the sandbox policy and verifier deadline for this target. Measured, see "Resources". |
| `runnerConfig` | The files the test command reads to decide what to run: for devkit `packages/devkit/package.json`, `packages/devkit/vitest.config.ts`, `packages/devkit/tsconfig.json`, `packages/devkit/tsconfig.test.json`. Every task against this target must list them as immutable, and the task loader refuses a task whose allowed paths include any of them. Without this the "tests are immutable" guarantee is hollow: a builder that may edit the runner's configuration can exclude the test it fails. |

The repository is not a field. Rung 2 is a dogfood: the target repository is the
one the factory is running inside, resolved once from `FACTORY_REPO_ROOT` or,
absent that, `git rev-parse --show-toplevel` from the working directory. The
environment override exists because the layer 2 and 3 tests copy the app to a
temporary root outside the repository. An external repository is rung 4's
concern.

### Suite runners

Rung 1's suite runner drives `node:test` over one file and grades named
assertions from its event stream. Devkit's tests are vitest tests, so a suite
now names its runner. `checks.json` becomes:

- `{ "runner": "vitest", "assertions": [...] }`: runs the target's
  `commands.test` with a JSON reporter appended, and passes when the exit code
  is zero, no test failed, and every named assertion appears exactly once as
  passed. Assertion names are vitest full names, e.g.
  `spawnProcess clears the deadline when spawning fails asynchronously`.
- `{ "runner": "node-test", "file": "...", "assertions": [...] }`: rung 1's
  runner, with the target's `nodeTestExecArgv` instead of a hard-coded
  `--import tsx`.

The independent suite is always a `node-test` suite written to `checks/` at the
workspace root, as in rung 1; it reaches the built artifact through
`commands.cwd`.

### `tasks/<id>/`

| Entry | Meaning |
|---|---|
| `task.json` | `id`, `target`, `allowedSourcePaths`, `immutablePaths`. Paths are repository paths, e.g. `packages/devkit/src/testing/process.ts`. The rung 1 regex that required `src/*.ts` at the workspace root is replaced by the rule that already carried the weight: allowed and immutable are disjoint, and an allowed path never ends in `.test.ts`. |
| `spec.md` | What to change and what to preserve, with acceptance IDs in the RFC's `A1:` form and explicit non-goals. Its digest is `specificationDigest`. |
| `defect.patch` | Applied to the archive before capture. Re-seeds the known regression on top of the pin, so the baseline is current code with one known defect rather than an old commit. Optional: `cli-flags` has none, because its pinned bytes are already the defective baseline. |
| `reference.patch` | The forward repair. Used only by the scripted builder in layer 3 and never read by the verifier. |
| `checks.json` | Maps the visible suite and the independent suite to the acceptance IDs they cover, as in rung 1. |
| `checks/` | The independent suite. Structurally absent from the capture; the verifier writes it into its own container after the visible suite has run. |

`policyDigest` is computed over `task.json`, `checks.json`, the bytes of every
file under `checks/`, the bytes of `defect.patch`, the target's `capture`
lists and the target's environment identity. A change to any of them
invalidates a frozen bundle at approve, which rung 1 already enforces. The
patch and the allowlist are included because they determine the baseline: a
bundle frozen over one baseline must not be approvable after the baseline's
definition changed.

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
  exercises the built artifact, which is what a consumer runs. Its inputs (the
  missing command's path, the deadline) are disjoint from the visible test's,
  so a repair that special-cases the visible fixture does not pass it.
- **Task admission.** A task is admitted only when, in the real container, its
  independent suite fails on the defect-patched baseline and passes on the
  reference repair. A check that cannot tell the defect from the fix proves
  nothing and is refused. This is the smallest form of the oracle-strengthening
  the literature asks for; mutation-scoring a task against deliberately wrong
  repairs is a rung 3 addition, when a model produces repairs.
- The scripted builder is one model script: read the file, write the repaired
  file, stop.

## Capture and image

### Archive

A new module `src/targets/archive.ts` exports one synchronous function,
`captureTarget(task, role)`. It resolves the repository root, runs
`git archive <pin>:<root> -- <include...>`, extracts it into
`.factory/captures/<role>/<taskId>/` under the app root after removing whatever
was there, runs `git apply` with the task's `defect.patch` if present (a reject
is a thrown error), and returns the directory as an app-relative path. The
directory is app-relative and not a temporary directory because the framework's
capture takes a portable path under the app root, and it is synchronous because
`b4.config.ts` needs the builder's copy at load time. The `role` keeps the
builder's copy and the controller's copy apart so two processes never rebuild
one directory under each other; both derive from the same pin and patch, so
their digests agree. There is no cache: the directory is rebuilt on every
capture.

`captureBaseline` reads that directory. The builder's workspace definition
points its `source.directory` at that directory, so both containers see the
same defective bytes and the baseline digest is over the archive, never over
the host's working tree. The controller's and the verifier's captures take a
per-call `instance` suffix and are removed once consumed, because two work
orders on one task may verify concurrently and a capture rebuilt under an
in-flight walk fails the framework's change detection; the builder's copy is
captured once per process at config load.

Why an archive and not the checkout: the factory runs inside the repository it
targets. A baseline read from the working tree would depend on whatever the
operator has uncommitted, and a work order reconciled on another day would see
different bytes. The pin is the only source of truth.

### Image

`targets/devkit/Dockerfile` starts from `node:24-slim` pinned by manifest
digest **and** `--platform`, because the digest of a multi-arch tag names a
manifest index and an arm64 laptop and an amd64 runner would otherwise pull
different images under one pin. It installs git, enables corepack at the
`packageManager` version from the root manifest, copies the root manifests and
the lockfile at the pin, copies **every workspace package in devkit's filtered
closure in full** (not only its `package.json`), and runs
`pnpm install --frozen-lockfile --filter @b4run/devkit... --ignore-scripts`,
then the build script of any closure sibling that has one. Siblings are copied
in full because pnpm links a `workspace:` dependency as a relative symlink to
the sibling directory; inside the image that resolves to the image's copy, and
a stub copy would give the builder an empty package. For devkit the one sibling
is `@b4run/config-typescript`, json only, no build.

The install uses `--config.node-linker=hoisted`, so `/opt/targets/devkit/node_modules`
is one flat tree and the only link target. pnpm is installed with
`npm install -g pnpm@<packageManager version>` rather than corepack, because
corepack caches the binary in the enabling user's home and the container runs
as `node` with the network denied.

`scripts/prepare-target.ts <id>` mirrors code-fixer's prepare script: pull and
digest-pin the base image, `docker build`, `docker image inspect`, assert the
install matches the lockfile (`pnpm ls --depth 0` inside the image against the
filtered lockfile, which catches a platform-matched optional dependency the
frozen install silently skipped), and write the `image` object into
`target.json`. A rebuilt image has a new local id; the manifest names the old
one until the script is run again, and approve already refuses a bundle whose
environment moved.

Two findings from preparing the devkit image, recorded because they are the kind of
thing a re-prepare on another host will hit again:

- **Vite bundles a TypeScript config into `<nearest node_modules>/.vite-temp`** and its
  guard tolerates only `EACCES`, not a read-only filesystem. With `node_modules` a symlink
  into the read-only image, vitest could not start. The devkit Dockerfile therefore links
  `/opt/targets/devkit/node_modules/.vite-temp` to `/tmp`, the sandbox's tmpfs. `--no-cache`
  is still needed for vitest's own cache.
- **Two devkit test files compare templates against `examples/research/*`**, which is outside
  the capture: `test/template-thread-access.test.ts` and `test/templates.test.ts`. Both are
  excluded in `commands.test`. Nine of eleven files run; the regression test the task grades
  on is in `test/process-artifacts.test.ts` and is not excluded. Widening the capture to pull
  in the research example was rejected: it is not the package under repair.

`docker pull` can hang on a host whose Docker Desktop registry proxy is wedged; the prepare
script accepts `FACTORY_SKIP_BASE_PULL=1` as an explicit opt-in to build from the locally
held base image, and the recorded base digest is then whatever that host holds. It is never
a fallback. After every prepare run, `biome check --write targets` reformats the manifest
the script wrote.

`--ignore-scripts` also skips the target's own lifecycle scripts. Devkit and
its sibling declare none, and the repository's `onlyBuiltDependencies` names
only `workerd`, which is outside the closure. A target whose closure needs a
build script must list it in the Dockerfile explicitly; the prepare-time
assertion is what catches the omission.

### Links inside the workspace

One root symlink, `node_modules`, derived into the inspection options from the
target's `environmentLinks` exactly as rung 1 does, so the reader and the
verifier cannot disagree about what a legitimate root symlink is. The hoisted
install is what makes one link enough: with pnpm's default linker every
workspace package has its own `node_modules` of relative symlinks, inspection
refuses nested symlinks it was not told about, and there is no option to tell
it.

### Resources

Measured in the prepared image under the sandbox's real constraints (read-only
root, tmpfs `/tmp`, no network, user `node`), three runs each, slowest taken:

| | slowest |
|---|---|
| build (`tsc -b`) | 1.4 s |
| test (vitest, 9 files) | 8.9 s |
| peak memory (cgroup `memory.peak`) | 369 MiB |

The written limits give at least three times that headroom, rounded up to a
whole minute (the wedge-detector rule from the timing-flake work, not a
stopwatch): `commandTimeoutMs` 60 000, `verifierDeadlineMs` 120 000 (two
minutes rather than one, so a single slow command cannot consume the whole
verifier budget), `memoryMb` 768 (twice the peak, rounded up to 256). Network
stays denied; the frozen install is the point.

## What changes in the verifier and the reader

- `loadFixture(taskId)` becomes `loadTask(taskId)`, which also loads the task's
  target. One function, `targetWorkspace(taskId)`, the successor of
  `fixtureWorkspace`, yields the workspace definition, the inspection options
  and the sandbox policy for the builder config, the reader and the verifier.
- The verifier runs `commands.build` once at `commands.cwd` after writing the
  candidate and before the visible suite. A build failure is a failed visible
  check with the compiler output as evidence, not inconclusive: it is a fact
  about the candidate.
- `environmentIdentity` is the sha256 of the target's `image` object. The rung 1
  caveat about mutable tags comes out of the README and the verifier, replaced
  by the narrower caveat that the identity is a local id plus its inputs, not a
  registry digest.
- The before-and-after snapshot around each suite skips the target's
  `snapshotIgnore` prefixes, because the build writes there legitimately. Any
  other change during a suite is still tampering. The verifier's inspection
  limits rise to the reader's (16 MiB total), since a monorepo capture is
  larger than a fixture.
- The reader needs no code change.

## One framework change: the sandbox reaps orphans

Preparing the devkit image exposed a defect in `packages/sandbox`: the Docker
session container was started without `--init`, so a command's orphaned
descendants were reparented to a `sleep` that never waits for them. They
stayed as zombies, `kill(pid, 0)` kept succeeding, and devkit's own
process-tree tests failed deterministically inside the factory's container
while passing everywhere else. Each zombie also held a `--pids-limit` slot
for the life of the container. The sandbox now launches with `--init`, the
flag is part of the launch identity so an old keeper is replaced, and the
change ships as a patch changeset for `@b4run/sandbox`. This is the kind of
finding the dogfood exists to produce.

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
  immutable paths, an allowed path ending in `.test.ts`, an allowed path that is
  one of the target's `runnerConfig` files, a task that does not list every
  `runnerConfig` file as immutable, a target without an `image` object.
- The archive module, against a throwaway git repository built in the test:
  the archive contains exactly the include list, the defect patch is applied,
  and the baseline digest is identical across two captures.
- The task's two patches apply cleanly to the pin, and applying the defect
  patch then the reference patch yields the pinned bytes again.
- The suite graders, as pure functions over a captured vitest JSON report and a
  captured `node:test` event list: a missing assertion, an extra failure and a
  skipped named test each grade as they should.
- The rung 1 invariants re-asserted through the new catalogs with the fake
  verifier: visible pass plus independent fail cannot reach
  `awaiting_approval`; an immutable-path edit is a scope violation; a changed
  environment identity invalidates a frozen bundle at approve.

### Layer 2: the real image, Docker-gated

In a real container from the prepared image: `commands.build` then
`commands.test` pass on the unpatched pin, and the visible regression test
fails on the defect-patched baseline. This is the ladder's "baseline, build and
test one `packages/*` member in the sandbox". The task admission gate runs here
too: the independent suite fails on the defect-patched baseline and passes on
the reference repair.

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

The rung 1 `cli-flags` fixture is re-expressed as a target rooted at
`fixtures/cli-flags/project` in this repository and a task, so every rung 1
path and test stays valid, and `src/fixtures/` is deleted. Its image is built
by the same prepare script from its own Dockerfile, so the README no longer
sends the reader to code-fixer's. That retirement is what closes the handoff's
seam-leak item.

## Research alignment

The design was graded against four literature and product surveys after it was
approved in conversation; the findings, the amendments they produced (the
`image` object, sibling packages copied in full, `runnerConfig`, the task
admission gate, patch and allowlist in `policyDigest`) and the gaps deferred to
named rungs are in the
[research alignment note](../notes/2026-09-19-software-factory-rung2-research-alignment.md).

## Risks accepted for rung 2

- **Same host, no authentication, no separation of duties.** The principal that
  creates a work order can approve it. Copilot's requester-cannot-approve rule
  is the model to adopt in the authentication rung, before any external
  delivery.
- **The environment identity is a local image id plus its inputs**, not a
  registry manifest digest. Another host can verify the inputs, not the image.
- **A running verifier has no liveness signal** beyond its start-to-close
  deadline. A wedged container costs up to the deadline before it is
  inconclusive.
- **One pin.** Advancing it is a manual edit plus a prepare run; nothing
  automates or verifies the advance beyond the layer 1 patch-applies test.
- **The image trusts its build.** The Dockerfile is pinned to a base digest, a
  platform and a frozen lockfile, but the image is built on the operator's
  machine and the id recorded is whatever that build produced. The `git`
  binary `apt-get` installs is resolved at build time and is not among the
  recorded inputs: two builds of the same inputs a month apart can hold
  different `git` versions under one environment identity. Accepted for this
  rung; pinning it or recording `git --version` in the image object is the
  fix if it ever matters.
- **The verifier still shares an image with the builder.** As in rung 1; an
  untrusted candidate can observe its runtime.
- **Two excluded tests.** The visible suite is devkit's suite minus the two
  files that compare against `examples/research`, and the exclusion is a fact
  about the capture, recorded in the command.
- **The vitest report channel is forgeable by a determined builder.** The
  visible suite's JSON report is written to `/tmp` inside the builder-reachable
  container and read back in the same command. The path and the stdout marker
  carry a per-run nonce, so a test cannot forge them blind, but a test that
  reads the nonce from the vitest process's argv and leaves a background writer
  could still replace the report. This affects only the visible suite (the
  independent suite is always `node-test`, graded from its event stream), and
  it still requires vitest's real exit code to be zero. The fix is to run the
  target's tests as a uid that cannot reach the report; deferred.

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
8. The task admission gate passes for `devkit-spawn-deadline`: its independent
   suite fails on the defect and passes on the reference repair, in the real
   container.
7. `examples/code-fixer` has no diff, and `pnpm ci:validate` is green.
