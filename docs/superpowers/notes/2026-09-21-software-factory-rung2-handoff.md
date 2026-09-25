# Handoff — software factory, rung 2 and the verifier's own integrity

**Snapshot date: 2026-09-21.** Point-in-time note. The merge SHAs below are stable;
the *decisions on record*, *what is actually proven*, *traps* and *open follow-ups*
sections are the durable part. Supersedes the
[rung 0/1 handoff](2026-09-19-software-factory-arc-handoff.md), whose §4 blocker and
follow-ups 2, 7 and 8 are closed here.

---

## 1. State at a glance

Everything below is merged to `main`. Nothing is in flight.

| Change | Merge | What it did |
|---|---|---|
| Byte channel wired into the example, [#747](https://github.com/cacheplane/b4run/pull/747) | `1e54414c` | The controller reads a thread's workspace for real |
| Rung 1 hardening, [#748](https://github.com/cacheplane/b4run/pull/748) | `9d676522` | Per-work-order verifier abort, boot without awaiting containers, content-compared exports |
| Managed-workspace read, [#749](https://github.com/cacheplane/b4run/pull/749) | `516c038c` | A peer session's framework read path; the builder's own workspace becomes readable |
| **Rung 2**, [#763](https://github.com/cacheplane/b4run/pull/763) | `185ae3c3` | The controller retargeted at `packages/devkit` at a pinned commit |
| Tamper comparison excludes nothing, [#767](https://github.com/cacheplane/b4run/pull/767) | `71715156` | Closed a hole rung 2 shipped with |
| One container per suite, [#768](https://github.com/cacheplane/b4run/pull/768) | `b4084553` | The oracle is graded where the visible suite's code never ran |

Two framework changes rode along, both found by pointing the factory at real code:
`@b4run/sandbox` now launches with `--init` (patch changeset, in #763), and the
rung 2 spec records the capture's portable-path limit that `@b4run/workspace`
still has.

**`review` was red on every one of these** and all six were admin-merged. The
Anthropic org credit balance is exhausted; `validate` is the only required check,
but a red advisory check makes GitHub report `UNSTABLE`, which blocks auto-merge.
Every PR merged today shipped without the advisory review — six changes, including
two that alter how a verdict is reached. This is the same outage the previous
handoff recorded on 2026-09-19, still unresolved. Top up the credits, and when
`review` is red decide deliberately whether a change is safe to land without it
rather than letting the habit decide.

---

## 2. Arc status

| Rung | Status |
|---|---|
| 0 — controller in front of the unchanged code-fixer | MERGED `8dbc0bdb` |
| 1 — controller-owned verification and the review bundle | MERGED `c8e4f952` |
| 2 — builder retargeted at the monorepo | **MERGED `185ae3c3`**, plus `71715156` and `b4084553` |
| 3 — first dogfood work order with a live model | Not started. Needs a model key and, in my judgement, the uid separation in §7 first |
| 4 — draft pull request delivery with an outbox | Not started |

---

## 3. What rung 2 actually is

Rung 1's single `fixtures/<id>` directory became two catalogs under
`examples/software-factory/server`:

- **`targets/<id>/target.json`** is an environment: a pinned 40-hex commit, the
  workspace `root` within the repository, the `capture.include` pathspec, an
  `image` object, `environmentLinks`, per-package `commands`, the `runnerConfig`
  every task must keep immutable, and measured `resources`.
- **`tasks/<id>/`** is one repair against one target: `task.json` (allowed and
  immutable paths), `spec.md` with acceptance ids, optional `defect.patch`,
  `reference.patch`, `checks.json`, and `checks/` — the independent suite, which
  is never in the builder's capture.

The baseline is `git archive <pin>:<root>` with the defect patch applied, into a
per-call instance directory. The image bakes the pnpm closure at the pin and is
recorded by its inputs. The verifier is target-driven: build, then the package's
own suite, then the independent check, each in its own container.

Two tasks ship: `cli-flags` (rung 1's fixture, re-expressed) and
`devkit-spawn-deadline`, which re-seeds the dangling-deadline defect fixed in
`67a15d2b`.

---

## 4. What is proven, stated precisely

Do not overstate this in a demo or a PR description.

**Proven, in real containers.** A scripted builder builds and tests
`packages/devkit` inside its own container, writes the reference repair, and the
controller reads those bytes through the byte channel, drops the target's build
output, assembles against its own archive of the pin, verifies in a fresh
container from the prepared image, freezes a bundle, approves (which
re-verifies) and exports exactly the reference bytes. A candidate that does not
compile is a failed build, not inconclusive. The defect-patched baseline fails
both suites, with evidence naming the regression test and the acceptance id.

**Also proven.** A candidate that mutates the workspace during a suite is
rejected, asserted on the tamper evidence text rather than on the verdict alone.
A candidate that plants a delayed writer cannot reach the independent oracle,
because the oracle runs in a container that writer's process never existed in.

**Not proven.** No live model produced a repair; every builder turn is scripted.
The visible suite is twelve tests in two files, not devkit's suite — nine of its
eleven test files read `templates/` or `examples/research`, and `templates/`
cannot be captured at all (see §6). The environment identity is a local Docker
image id plus the inputs that produced it, not a registry manifest digest — and
it is the identity of whatever host prepared it. The objects committed on `main`
are `linux/arm64`, built on a developer machine; CI rewrites them for its own run
and does not commit that. A host of a different architecture must run
`target:prepare` before it can verify anything. One pin, one target shape, no
authentication, no separation of duties between the principal that creates a work
order and the one that approves it.

**Still open in the verifier itself,** and stated in the spec's risks: candidate
code *does* run in the oracle's container, because the check imports the built
artifact. A mutation applied and reverted inside a single window is undetected,
and the vitest report in `/tmp` is untouched.

---

## 5. Decisions on record — do not relitigate without new information

- **A target is an environment; a task is a repair.** They change at different
  rates. Independent checks live with the *task*, never committed into the target
  repository, because anything in the repository is in the builder's capture and
  the whole point of the independent suite is that it is not.
- **`capture.include` is the capture's *definition*** and enters the policy
  digest as such. The framework's capture requires an exact flat file inventory,
  so the workspace definition derives that list by walking the extracted archive.
  These are two different things and conflating them was a latent break.
- **Pinned archive capture**, not a checkout baked into the image (which would
  leave the byte channel nothing to read) and not a whole-repository capture
  (10,000 entries and 64 MiB limits, and the builder would see the factory).
- **`node-test` suites run at the workspace root**, whatever `commands.cwd` is;
  only the build and the vitest invocation `cd` into it. A check reaches the built
  artifact by its full root-relative path.
- **The tamper comparison excludes nothing.** `snapshotIgnore` is not a knob for
  it. See §6; this is the one decision most likely to be "helpfully" reverted.
- **Each suite is graded in its own container.** This is RFC §9.3's separate
  oracle. It costs ~1.7 s, because four workspace snapshots at ~9.7 s each already
  dominated a 51 s verification.
- **The image tag binds the pin *and* the Dockerfile hash**, so a changed
  Dockerfile at the same pin can never run under the old recorded identity.
- **A missing pin is fetched from origin by SHA**, once, on first load
  (`FACTORY_NO_FETCH=1` makes it a hard error). Most CI jobs are shallow; see §6.
- **An unprepared sibling task must not prevent boot.** `taskPrompts` never
  throws: a task that fails to load is reported and omitted, and a work order for
  it is refused as unknown.
- **Prompts and permissions are derived from the same `commands` argv**, so the
  builder cannot be told to run something its allow-list does not admit.
- **Deadlines are measured, with headroom over the *measurement's* conditions.**
  devkit's verifier deadline is four minutes, not the rule's floor of three,
  because the measurement is a warm unloaded developer machine and CI is not.

---

## 6. Traps that cost real time

- **The Docker sandbox had no PID 1 reaper.** `sleep infinity` as PID 1 never
  waits, so orphaned descendants stayed zombies: `kill(pid, 0)` kept succeeding,
  process-tree termination looked like it failed, and each zombie held a
  `--pids-limit` slot. devkit's own tests failed *only* inside a container. Fixed
  with `--init`, hashed into the keeper identity. If a suite that kills process
  trees fails only in a sandbox, look for zombies first.
- **An exclusion in an integrity check is a hole the moment the excluded path is
  an input to the verdict.** The tamper comparison skipped the target's build
  output, which is exactly what the independent oracle grades. Measured against
  the merged code, an adversarial candidate produced `visible:pass,
  independent:fail` with no tamper check at all. Ask of every exclusion: what
  reads this?
- **The workspace capture accepts only portable ASCII paths**
  (`^[A-Za-z0-9._ /-]+$`), so Next.js route paths — `(public)`, `[tenant]`,
  `[...path]` — cannot be captured. devkit's `templates/` hit this and nine of its
  eleven test files were excluded as a consequence.
- **Most CI jobs check out shallowly.** Only `changesets`, `harness-verify`,
  `pack-smoke`, `push`, `release-controller` and `source-validate` set
  `fetch-depth: 0`. Anything that names a commit by SHA fails elsewhere — and
  because the example's `b4.config.ts` resolves its target at load, this broke the
  *build* step of six jobs that never run the factory. Seven jobs red at once.
- **Vite bundles a TS config into `<nearest node_modules>/.vite-temp`** and
  tolerates only `EACCES`, not a read-only filesystem. The devkit image links that
  directory to `/tmp`.
- **corepack does not survive `USER node` with the network denied** (it caches
  pnpm in the enabling user's home). Install with `npm install -g pnpm@<version>`.
- **pnpm `workspace:` deps are relative symlinks to the sibling directory.** Copy
  siblings into the image in full and install with `--config.node-linker=hoisted`:
  the workspace inspector validates *root* symlinks only, so nested per-package
  `node_modules` links make inspection throw.
- **`git apply` honours ambient config.** A developer's `apply.whitespace=fix`
  rewrites the applied bytes. Use `-c core.autocrlf=false ... --whitespace=nowarn`.
- **`git archive` honours in-tree `export-ignore` silently.** Assert every include
  path is present after extraction.
- **A timing-based adversarial test is a bad proof.** The shape that worked: the
  payload waits on a *workspace event*, then mutates continuously with a counter,
  so detection never has to win a race.
- **Measure container memory with cgroup `memory.peak`**, not
  `docker stats --no-stream`, which samples too slowly for a ten-second run.
- **Docker Desktop's registry proxy can wedge**: every `docker pull` hangs while
  local builds work. `FACTORY_SKIP_BASE_PULL=1` is the documented opt-in.
- **Node 24 is required** (`nvm use 24`), and a fresh worktree has no
  `node_modules` — the Docker lanes fail with "Cannot find package '@b4run/cli'"
  until `pnpm install` runs. That is not a code defect.

---

## 7. Open follow-ups

Ordered by what I would do first.

1. **Run a target's tests as a second identity.** This is the only thing that
   closes the two residuals in §4: a uid that can reach neither the workspace nor
   the vitest report. **Blocked on a design decision, not on effort.** It needs a
   `user` option on `ExecBackend.runCommand` in `@b4run/workspace`, and two of the
   four backends — `kube-exec` (kubectl exec has no per-exec user) and
   `local-exec` (needs root) — cannot honour it. Settle first what an unsupported
   backend does: refuse the call, ignore the option, or advertise a capability the
   verifier checks. Refusing is the only one that cannot fail open, which is the
   shape this repo keeps getting bitten by.
2. **Rung 3: a live model produces the repair.** Needs a model key, and rung 2
   never got a live runbook either — `runbooks/` has `software-factory-rung0-live.md`
   and `software-factory-rung1-live.md` (the latter still blocked when it was
   written) plus rung 2's developer guide. Rung 1's is the template to follow.
3. **Carry `test:fail` details into the receipt.** `runNodeTestSuite` collects
   only `test:stdout`/`test:stderr`, so an assertion message never reaches the
   evidence unless the check prints it itself. The vitest path already does this
   correctly; mirror it. ~5 lines plus a test.
4. **Assert the image tag still resolves to the recorded `localId`** at
   verification time — one `docker image inspect`, closing the gap between the
   recorded environment identity and what actually ran.
5. **Widen `portablePath`'s charset in `@b4run/workspace`** so route paths
   capture, which would restore devkit's full suite (§6).
6. **A second, non-devkit-shaped target.** One target proves the catalog shape;
   two would prove it is not devkit-shaped.
7. **Memoize `loadTask`.** Each call spawns two `git` subprocesses, and the reader
   resolves the task twice per read.
8. **From the previous handoff, still open:** the flake class where tests
   synchronize on a state transition rather than on the thing they mean to be
   inside (one was a real false red; the others were never audited), and the
   managed workspace volume that survives `harness.close({ destroyWorkspaces: true })`.

---

## 8. How this was built, and what that cost

Rung 2 was executed from a written plan of fourteen tasks, one subagent per task,
each task reviewed twice — spec compliance, then quality — before the next began.
**Every single review found something real.** That is not a compliment to the
reviewers so much as a fact about plans: mine predicted a green gate that was
actually red at runtime, restated paths in a shape the framework rejects, assumed
an exclusion was safe, and put a suite's working directory in the wrong place. The
two integrity fixes in §1 were both found *after* rung 2 merged, by continuing to
ask what an attacker could do rather than whether the tests passed.

Concretely, if you execute a plan this way:

- **Gate on "the package suite is green at every commit."** A plan step that
  predicts a red gate is a wrong plan step, not a known inconvenience. Task 1
  predicted only a typecheck failure; vitest does not typecheck, so the whole
  suite threw at runtime and would have stayed red for five tasks.
- **Make a guard prove it binds.** Several reviews found tests that would have
  passed with the rule deleted. Generate one assertion per field, mutate the
  input, or check the evidence text — not just the verdict.
- **Re-read the plan's assumptions against the framework before coding.** Four of
  the fourteen tasks had to change shape because the plan described behaviour the
  framework does not have.

---

## 9. Where the durable knowledge lives

- Spec: `docs/superpowers/specs/2026-09-19-software-factory-rung2-design.md` —
  amended throughout execution; its "Risks accepted" section is the honest residual list.
- Plan: `docs/superpowers/plans/2026-09-20-software-factory-rung2.md` — each task
  carries a `> **Task N as landed**` note recording what review changed.
- Guide: `docs/superpowers/runbooks/software-factory-rung2-developer-guide.md` —
  how to prepare a target, add a task, run a work order; its closing sections are
  the honest "what is missing / difficult / painful".
- Research: `docs/superpowers/notes/2026-09-19-software-factory-rung2-research-alignment.md`
  — how the design grades against published factory, verification and provenance practice.
- Program: `docs/superpowers/specs/2026-09-16-software-factory-rfc.md`, and the
  rung 0 design's increment ladder.
- The example's own front door: `examples/software-factory/README.md`.

**Standing constraints.** Never bare `git stash` (the stack is shared across
worktrees) and never bare `biome check --write` at the repo root.
`examples/code-fixer` must have no diff. Many sessions run concurrently in their
own worktrees; check `git worktree list` and `gh pr list` before starting.
