# Environment Images Built When First Needed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A work order that needs a target's image at a pin gets it without an operator step: the controller builds it the first time any work order needs it, records it in a host-local registry, binds it to the work order, and the builder and the verifier run exactly that image, by ID.

**Architecture:** A new image registry (`<FACTORY_STATE_DIR>/images.sqlite`, `node:sqlite`) keyed by a digest of the target's image recipe at a pin, with one build per key at a time, a global build limit, a build timeout and refcounted cancellation. `target.json` stops carrying images at all: it carries the recipe, including the base image pinned by digest. The controller calls the registry at intake's fit step and at dispatch, journals the build, stores its log as evidence, pauses the work order's budget while it waits, and binds the image to the work order (`image_bound`). PR 2 moves identity from tag to image ID: the builder's handoff names the bound image ID, the builder's provider accepts only image IDs, and the verifier runs the bound ID and refuses if the registry now names another.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), `node:sqlite`, `node:child_process` `spawn` with `AbortSignal`, zod 4, vitest 4, Docker (BuildKit), git.

**Spec:** [`2026-09-23-software-factory-framework-gaps-design.md`](../specs/2026-09-23-software-factory-framework-gaps-design.md) §4 (this item), §7, §8, §9 findings 3 and 5.

**Base:** `main` after PR #843 ("workspaces travel with thread creation; no manifest directory") merges. Every path and line below that names `builder-handoff.ts`, `drafter-handoff.ts` or the #843 `factory.ts` was read at `f92607ef` (the #843 head); everything else at `main` `79c5f63d`. If #843 has not merged when PR 1 starts, rebase this plan's PR 1 onto it first: PR 1 edits `factory.ts` `dispatch` as #843 leaves it.

---

## Decisions needed

Brian decides these before PR 1 starts. Each has a recommendation; the tasks below implement the recommendation.

**D1. Registry: where and what shape.** *Recommend:* its own SQLite file, `<FACTORY_STATE_DIR>/images.sqlite`, one table `images` keyed by the recipe digest, holding the full `Image` object (`localId`, `platform`, `baseManifestDigest`, `dockerfileSha256`, `lockfileSha256`, `pnpmVersion`) plus `target_id`, `pin`, `tag`, `built_at`, `build_ms`; `PRAGMA user_version = 1`, refused when newer. Not a table in `registry.sqlite`: images outlive work orders, the `target:prepare` script writes the image registry without opening the work-order registry (and without its migrations), and a host-level fact should not ride a work-order schema version. (Spec §4 names this file; kept.)

**D2. The key.** *Recommend:* `imageRecipeDigest` over `{targetId, pin, platform, baseImage, dockerfileSha256, imageContext (sorted), lockfile (path), imageAssertResolves (sorted), commandsCwd}`, domain `b4-factory-image-recipe-v1`. Not the lockfile hash and not an `imageContext` tree hash: a pin is an immutable commit, so (pin, path list) already determines both, and computing them would put a `git show` of a multi-MB lockfile in every `loadTarget`. The lockfile hash stays in the recorded `Image` (it is an identity input). The key deliberately covers more than today's tag and identity do: `imageContext`, `imageAssertResolves` and `commands.cwd` are recipe inputs in `target.json` that neither `imageTag` nor `environmentIdentityDigest` sees, so today an `imageContext` edit that leaves the Dockerfile alone silently reuses a stale image under the old identity.

**D3. `target.json` stops carrying images; what pins the default image.** *Recommend:* drop `images` (and 3a's single `image`) from `target.json` entirely, refused by name with a message that says where images live now; add `baseImage: "node:24-slim@sha256:<index digest>"`. What pins the default image is the committed recipe: the Dockerfile, the `imageContext` and lockfile at the default `pin`, and the base by digest. `localId` is host-specific and never belonged in the repository; committing it is exactly the rewrite churn (and the CI "manifest diff is expected here" comment). Pinning the base is what makes the key computable offline: with a floating `node:24-slim`, a lookup would need a pull to learn which base it would build on. *Also recommend* unifying all three targets on the drafter's pinned base (`node:24-slim@sha256:0e0ff40c…`, `drafter/src/drafter-image.ts:10`), which is already `cli`'s: CI pulls it for the drafter lane anyway, and on this host `devkit` and `cli-flags` must rebuild regardless (their committed `localId`s are not on the daemon; see "Today, verified", row 12). `FACTORY_SKIP_BASE_PULL` retires: the base is pulled only when `docker image inspect <baseImage>` says it is absent, which is also the Docker Desktop pull-wedge workaround.

**D4. One image identity for builder and verifier: by image ID.** *Recommend (PR 2):* the builder handoff's `target.image` becomes the bound image ID (`sha256:<64 hex>`) and gains `target.tag` (the factory tag, whose target and pin segments the schema still checks against `targetId` and `pin`); the builder's `dockerSandbox({ images })` predicate accepts only `^sha256:[0-9a-f]{64}$`, so the framework's `docker image inspect <id>` records exactly that ID as the thread's `environment.identity`; `VerifyInput` gains `imageId`, and the Docker verifier runs `dockerSandbox({ image: imageId })` and refuses (`verifier_unavailable` → `verification_inconclusive`) when the task's current registry image is not that ID. This closes the per-thread-sandbox plan's review follow-up. Rejected alternative: have the builder resolve the tag and check its `RepoTags` against the manifest; it adds a Docker call to the untrusted side and still races a moved tag.

**D5. Binding.** *Recommend:* a work order binds its image the first time it needs one, journalled as `image_bound {targetId, pin, key, tag, image}`; the last `image_bound` is the binding. Intake rebinds on every attempt (a redraft may name another target, and each oracle proof runs in the image that attempt bound); dispatch binds when nothing is bound and otherwise requires the registry's current image to equal the binding, refusing with `image_changed` (row stays `received`, nothing spent, journalled). PR 2's verifier and approve's re-verification run the binding. Fail-closed on a rebuild between intake and dispatch: the oracle was proved in the old image, and running the builder and verifier in a new one without re-proving would bind two environments into one bundle. The remedy is a new work order; a `reprove` command is a follow-up.

**D6. Single flight and the global limit.** *Recommend:* one in-process build per key (a second caller joins the first's promise, journalled `shared: true`); `FACTORY_MAX_IMAGE_BUILDS` (default 1) bounds builds across keys, queued callers still cancellable. The spec's cost bound ("bound it with a build concurrency limit") is this. Cross-process single flight (the script and a controller building one key at once) is not attempted: both builds succeed, the later write wins, and a work order that bound the earlier ID is refused at its next use (`image_changed` / PR 2's verifier check), which is safe.

**D7. Cancellation.** *Recommend:* each caller waits with its own signal (intake: the phase signal; dispatch: a per-row image-wait signal aborted by any transition out of `received`, and by `close()`); the build itself has its own controller, aborted only when its last waiter leaves. Aborting kills the `docker build` client, which cancels the BuildKit session. A cancelled build records nothing.

**D8. Timeout.** *Recommend:* `FACTORY_IMAGE_BUILD_TIMEOUT_MS`, default 1,800,000 (30 min), started when the build takes its slot (queue time excluded). Measure the `cli` target's cold build during PR 1 and raise the default if it needs more; the timeout is a wedge detector, not a stopwatch.

**D9. Build log to evidence.** *Recommend:* the builder streams every command's stdout and stderr into a bounded log (last 1 MiB kept, with a note of what was dropped); on success and on failure the controller stores it in the artifact store and journals its digest (`image_prepared.logDigest`, `image_prepare_failed.logDigest`).

**D10. Drift: the local image deleted out from under the registry.** *Recommend:* every `ensure` re-verifies a recorded image with `docker image inspect <localId>`; missing → `image_missing` journalled, the record deleted, a rebuild. A tag moved off the recorded image is pointed back (`docker tag <localId> <tag>`) without a rebuild, so a dangling-image prune cannot remove it. `loadTarget` itself (synchronous, called everywhere) reads the record only and never calls Docker; the dispatch-time `ensure` is the verification point, and PR 2's verifier fails a run whose image is gone.

**D11. Journal and budget.** *Recommend:* events `image_prepare_started {targetId, pin, key, shared}`, `image_prepared {… localId, tag, ms, logDigest, shared}`, `image_prepare_failed {… error, logDigest}`, `image_prepare_aborted`, `image_missing`, `image_bound`, `image_changed`. Budget: only intake waits in an active state; the controller pauses the row's clock around the wait (`budget_paused` banks the open interval and leaves `activeStartedAt` null; `budget_resumed` reopens it), persisted, and reconciliation resumes a paused active row that has no tracked run (a restart mid-build). Dispatch waits in `received`, which is not active, so nothing is charged there. A failed build at intake blocks the row `image_prepare_failed` without spending a drafter attempt; at dispatch it is a refusal and the row stays `received`, so dispatching again retries the build. Either way the next need rebuilds: a failure is never recorded as the key's answer, so nothing blocks "for good".

**D12. The git object store (spec §9 finding 3).** *Recommend: defer* to its own item. The factory reads pins from the developer's clone in five places (the image context archive, the wide capture, the baseline, the pin diff base, the replay pin), and `ensurePin` fetches into it; an image registry that owned a bare mirror only for image builds would leave four readers on the developer's clone and add a second store to keep in step. The immediate foot-gun (a `--depth=1` fetch making a full clone shallow) is fixed (`catalog.ts:372-390`). PR 1 changes nothing about where pins are read or fetched.

**D13. CI lanes.** *Recommend:* drop the two explicit `target:prepare` lines from the `sandbox-docker` step (`ci.yml:472-473`). The `test:sandbox` run builds `cli-flags` and `devkit` at their default pins in a vitest `globalSetup` through the same `ensure` the controller calls, into one lane registry every lane file shares, and every lane that boots a controller reaches `ensure` itself. The step's comment is rewritten (no "manifest diff is expected here"), and both workflow-audit fixtures change in the same commit.

**D14. Measured verifier time per (target, pin) (spec §9 finding 5).** *Recommend: defer.* The budget's unit is the target's verifier deadline, which the target already carries; a measured time belongs to the verifier's receipts, not to the image registry, and deriving budgets from it is its own design.

---

## Today, verified

Each claim of spec §4's "Today" and of the follow-up this plan closes, re-located. "main" is `79c5f63d`; "#843" is `f92607ef`.

| # | Claim | Where it is now | Holds? |
|---|---|---|---|
| 1 | The operator runs `target:prepare <id>` and `--pin <sha>` per pin | `examples/software-factory/README.md:283-290` (run), `:316` (before dispatch), `:171` (the command an `image_unprepared` names); `controller/package.json` `target:prepare` | Yes |
| 2 | A `--pin` prepare edits the checked-in `target.json` with a host-specific `localId` | `controller/scripts/prepare-target.ts:152` (`localId` from `docker image inspect`), `:178-182` (`recordImage`); `src/lib/targets/prepare.ts:131-172` (`withImageAt`, `recordImage`, which also shells out to `npx biome format`) | Yes; the default-pin prepare edits it too |
| 3 | Intake at an unprepared pin blocks `image_unprepared` for good, naming the command | `src/lib/intake/draft.ts:245-259` (`parseDraft` → `image_unprepared` with `prepareCommand`); `src/lib/controller/intake.ts:513-551` (`refuse`: `final`, no retry); `src/lib/domain/states.ts:59-62` | Yes (spec's `intake.ts:416-424` moved to `draft.ts`) |
| 4 | The error names the command | `src/lib/targets/catalog.ts:204-244` (`prepareCommand`, `ImageUnpreparedError`, `TargetUnpreparedError`) | Yes (spec's `catalog.ts:187` moved) |
| 5 | Then a builder restart at that pin (item 1) | Retired by item 1 (#832/#834/#836): one builder, and each thread's handoff names its image (`#843 controller/src/lib/builder-handoff.ts` `captureBuilderHandoff`, `image: imageTag(task.target)`) | No longer true |
| 6 | The drafter is offered only targets prepared at the pin | `src/lib/prompts.ts:141-170` (`preparedTargets` skips any target `loadTarget` refuses) | Yes; spec §4 does not mention it |
| 7 | The builder's intent records the image ID the tag resolved to at first admission | `packages/sandbox/src/docker/managed-workspace.ts:226-233` (`environmentFor`: `docker image inspect --format {{.Id}} <reference>`), `:245-258` (`resolveImageEnvironment`, predicate before any Docker call) | Yes |
| 8 | The verifier resolves the tag again at verify time | `src/lib/verification/docker-verifier.ts:46-53` (`dockerSandbox({ image: imageTag(target) })`, `environmentIdentity(target)` from `target.json`'s `localId`) | Yes |
| 9 | Nothing compares either with `target.image.localId` | No caller compares a receipt's or a thread's image with the catalog's `localId`; `per-thread-sandbox.md:4895` records it | Yes |
| 10 | The builder accepts only factory-shaped tags naming its own target and pin | `server/src/builder-manifest.ts:23,88-102` on main; `#843 server/src/builder-handoff.ts:21,96-107` | Yes |
| 11 | CI prepares both lane targets explicitly and tolerates the manifest rewrite | `.github/workflows/ci.yml:434-448` (comment: "That manifest diff is expected here"), `:472-473` | Yes |
| 12 | The committed `localId`s describe some host's images | On this host (2026-09-25): `targets/devkit/target.json`'s `sha256:e132a2b1…` and `targets/cli-flags/target.json`'s `sha256:6cebb9c5…` are **not on the daemon**; the tags `b4-factory-devkit:6a59e00aed46-981424fcce21` and `b4-factory-cli-flags:6a59e00aed46-74e1ff3ded50` name `73a82fb4…` and `d1032309…`; their recorded base `node:24-slim@sha256:2fe369e9…` is absent too. Only `cli`'s `36de4996…` matches its tag. | Worse than "annoyance": a receipt for a devkit work order on this host binds an identity digesting `e132a2b1…` while builder and verifier ran `73a82fb4…` |
| 13 | `ensurePin` fetches into the developer's clone | `catalog.ts:346-370`; depth only on a shallow clone, `:372-390` (finding 3's fix) | Yes; deferred (D12) |
| 14 | A lane prepares a second pin through the script into a copy of the targets directory | `controller/test/devkit-second-pin.ts:18-41` (`FACTORY_TARGETS_DIR`), `test/target-devkit-pin.integration.test.ts`, `test/builder.integration.test.ts:290-363` | Yes |

**What items 1, 2 and 3 changed for this item.** Item 1 (#832/#834/#836) removed the per-pin builder restart: the one builder runs whatever image each thread's handoff names, which is why an image can now appear mid-run without an operator. Items 3 and 2 (#838 token; #840/#841 reads over HTTP; #842 staged uploads; #843 handoff in thread metadata) moved the builder's image from a manifest file to the `factoryBuilder` thread metadata (`BuilderHandoffSchema` version 3, kept identical in `controller/src/lib/builder-handoff.ts` and `server/src/builder-handoff.ts` by `test/builder-handoff.test.ts`). PR 2 edits that handoff (version 4), not a manifest file, and must keep the two schema texts identical.

**Experiment (2026-09-25, this host, Docker 27.4.0, BuildKit).** A three-line Dockerfile built as `idtest:a`, then `idtest:b`, then (after `docker rmi` of both) `idtest:c` produced the same image ID all three times (`sha256:a2147d40…`): an identical recipe rebuilt on a warm build cache yields the same ID, which is what lets the spec's Docker proof compare the script's recorded identity with the controller's across two registries. It does not survive a build-cache prune; the lane test runs both builds back to back.

## Spec corrections

1. **§4 "keyed by target, pin, Dockerfile and lockfile hashes"** under-keys and over-keys at once: the lockfile hash is a function of the pin, while `imageContext`, `imageAssertResolves`, `commands.cwd` and the base image are recipe inputs the key must include (D2). With a floating base the key cannot be computed without a pull (D3).
2. **§4 "with only the default pin committed in `target.json`"**: commit no image at all. The default pin is already committed (`pin`); a committed `localId` for it is the same host-specific churn for one pin instead of several (D3, and "Today" row 12).
3. **§4 is silent on three places the change must reach**: the drafter's target list (today "prepared at the pin", must become "available at the pin"), the verifier (must run the bound image and never build), and the builder's identity (D4, D5).
4. **§4 "build time is not charged to the work order's active budget"**: only intake needs a mechanism (dispatch waits in `received`, which is not active), and a persisted pause needs a restart rule (D11).
5. **§4 "`image_unprepared` becomes a build failure, not a standing block"**: at intake a failed build still blocks that row (the intake has no path back for a non-draft failure), under a new reason `image_prepare_failed`; what stops being standing is the cause, since the next work order rebuilds. `image_unprepared` stays in `BLOCKED_REASONS` because existing rows carry it and the row schema is a `z.enum`.
6. **§4 Proof "the recorded identity equals the script's"** holds only because Docker's build cache makes an identical rebuild yield the same ID (Experiment above); the lane runs the controller's build and the script's back to back.
7. **§4 Trust impact** omits the new exposure: automatic rebuilds make a moved tag (and a changed ID) routine rather than an operator act, which is what makes D4/D5 necessary rather than tidy.
8. **§9 finding 3 "item 4's image registry should own its own object store"**: the object store serves captures, baselines and pin diffs as well as images; it is its own item (D12).
9. **§9 finding 5 "item 4's registry should record measured verifier time"**: deferred (D14).

## PR split

- **PR 1 — images built on demand** (`blove/images-on-demand`, Tasks 1-17). Standalone: the registry, the Docker builder, `target.json` without images, intake and dispatch building on first need with journal, log evidence, budget pause and binding (`image_bound`, `image_changed` at dispatch), the thin script, the lanes, CI, docs. The builder and verifier still run the tag, which the registry points at the current ID on every `ensure`: no weaker than today.
- **PR 2 — identity by image ID** (`blove/images-by-id`, Tasks 18-21). Needs PR 1's binding. Handoff version 4 names the image ID, the builder accepts only IDs, the verifier runs the bound ID and refuses a changed one, approve's re-verification likewise. Closes the per-thread-sandbox follow-up.

No changeset: examples only. No release-pinned script is touched (the factory's scripts are not reachable from the release workflows); PR 1 edits `ci.yml`, so both workflow-audit fixtures change in the same commit (Task 17).

## File structure

| File | PR | Responsibility |
|---|---|---|
| `controller/src/lib/domain/digest.ts` | 1 | `imageRecipeDigest` |
| `controller/src/lib/targets/catalog.ts` | 1 | `baseImage`; `images` retired; `TargetRecipe`, `loadTargetRecipe`, `loadTaskTargetRecipe`; `loadTarget` reads the configured registry; `ImageNotBuiltError`; `tagFor`; `configureImages` |
| `controller/src/lib/targets/images.ts` (new) | 1 | recipe key helpers, `ImageBuilder` interface, `openImageRegistry` (single flight, slots, timeout, refcounted cancel, drift), `BuildLog`, `ImagePrepareError` |
| `controller/src/lib/targets/image-builder.ts` (new) | 1 | `dockerImageBuilder` (lifted from the script), `spawnRun` |
| `controller/src/lib/targets/prepare.ts` | 1 | keeps the pure checks; `recipeProblem`; loses `withImageAt`/`recordImage`/`formatManifest` |
| `controller/scripts/prepare-target.ts` | 1 | thin: `ensure` into `<FACTORY_STATE_DIR>/images.sqlite` |
| `controller/targets/{cli,cli-flags,devkit}/target.json` | 1 | `baseImage` added, `images` removed |
| `controller/src/lib/prompts.ts` | 1 | `availableTargets` replaces `preparedTargets` |
| `controller/src/lib/intake/draft.ts` | 1 | fits against the recipe; `ParsedDraft.target` |
| `controller/src/lib/controller/images.ts` (new) | 1 | `prepareWorkOrderImage`, `boundImageOf` |
| `controller/src/lib/controller/context.ts`, `factory.ts` | 1 | `images`, `pauseBudget`/`resumeBudget`, dispatch pre-key image, image-wait signals |
| `controller/src/lib/controller/intake.ts` | 1 | the fit step builds; `image_prepare_failed` |
| `controller/src/lib/controller/reconcile.ts` | 1 | resume a paused budget after a restart |
| `controller/src/lib/domain/states.ts` | 1 | `image_prepare_failed` |
| `controller/src/lib/config.ts`, `runtime.ts` | 1 | `imagesPath`, `FACTORY_MAX_IMAGE_BUILDS`, `FACTORY_IMAGE_BUILD_TIMEOUT_MS`, retired variables; open and configure the registry |
| `controller/src/cli.ts` | 1 | `dispatch` follows an image build |
| `controller/test/static-images.ts`, `setup-images.ts`, `fake-image-builder.ts` (new) | 1 | unit-suite registry, fake builder |
| `controller/test/lane-images.ts`, `lane-images.global.ts`, `setup-lane-images.ts` (new) | 1 | the Docker lanes' shared registry |
| `controller/test/images-on-demand.integration.test.ts` (new) | 1 | spec §4's Docker proof |
| `.github/workflows/ci.yml`, `scripts/release/test/fixtures/workflow-{entrypoints,safe-executables}.json` | 1 | no explicit prepare |
| `examples/software-factory/README.md`, `docs/superpowers/runbooks/software-factory-rung2-developer-guide.md`, the spec | 1, 2 | docs |
| `controller/src/lib/builder-handoff.ts`, `server/src/builder-handoff.ts`, `server/b4.config.ts` | 2 | handoff v4 by image ID |
| `controller/src/lib/verification/{verifier,docker-verifier}.ts`, `controller/{verify,factory}.ts`, `intake/oracle.ts` | 2 | `imageId` |

All paths below are relative to `examples/software-factory/` unless they start with `.github/`, `docs/`, `packages/` or `scripts/`.

## Traps (read before starting)

1. **Node 24.** `source ~/.nvm/nvm.sh && nvm use 24` before any test; Node 22 fails unrelated tests.
2. **Build the closure first.** `pnpm turbo run build --filter=@b4-example/software-factory-controller^...` after install and after every rebase: the controller imports `@b4run/*` `dist/`.
3. **Never `git stash`; add files by path; never bare `biome check --write`.** `pnpm --filter @b4-example/software-factory-controller lint` (and `lint -- --write` scoped to the package) is the lint.
4. **`exactOptionalPropertyTypes`.** Spread optional fields conditionally.
5. **`loadTarget` must stay synchronous and Docker-free.** It runs in prompts, budget checks, policy and every `loadTask`; the registry's `recorded` is a SQLite read. Only `ensure` calls Docker.
6. **`fileParallelism: false`** in both vitest configs: the process-wide catalog configuration (`configureCatalog`, `configureImages`) relies on it.
7. **The two handoff schema texts must stay identical** (PR 2): `test/builder-handoff.test.ts` compares them.
8. **`ci.yml` and both audit fixtures in one commit**, edited as raw text (a JSON round trip re-escapes non-ASCII): `node --test scripts/release/test/workflow-contracts.test.mjs` is the fast gate; it runs under `pnpm test:release-controller`, not `test:release-integrity`.
9. **A lane's image build can take minutes**: every `ensure` in a lane gets an explicit signal timeout (`AbortSignal.timeout(1_200_000)`) and every `beforeAll` that builds gets `1_200_000` ms.
10. **Do not prune the Docker build cache** while developing this: the "identity equals the script's" proof relies on it.

---

# PR 1: images built on demand

```bash
git fetch origin
git switch -c blove/images-on-demand origin/main    # after #843 merged
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@b4-example/software-factory-controller^...
pnpm --filter @b4-example/software-factory-controller test   # green before any change
```

### Task 1: The recipe: `baseImage`, `TargetRecipe`, `loadTargetRecipe`, `tagFor`

The target gains the one recipe input that is not in the repository, and the catalog gains a way to load a target at a pin without an image. `images` stays for now (Task 7 removes it); nothing changes behaviour yet.

**Files:**
- Modify: `controller/src/lib/targets/catalog.ts` (schema `:121-183`, types `:185-202`, `loadTarget` `:315-334`, `imageTag` `:404-411`)
- Modify: `controller/targets/cli/target.json`, `controller/targets/cli-flags/target.json`, `controller/targets/devkit/target.json`
- Test: `controller/test/targets-catalog.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/targets-catalog.test.ts`, the fixture `manifest()` (`:57-80`) gains `baseImage: BASE_IMAGE` after `snapshotIgnore`, with

```ts
const BASE_IMAGE = `node:24-slim@sha256:${"e".repeat(64)}`
```

above it, and the import list gains `loadTargetRecipe` and `tagFor`. Add, inside `describe("target catalog", …)`:

```ts
  it("requires the base image pinned by digest", () => {
    const { pin } = repo()
    for (const baseImage of ["node:24-slim", "node@sha256:abc", "Node:24@sha256:" + "e".repeat(64)])
      expect(TargetSchema.safeParse(manifest(pin, { baseImage })).success, baseImage).toBe(false)
    const { baseImage: _omitted, ...without } = manifest(pin)
    expect(TargetSchema.safeParse(without).success).toBe(false)
    for (const baseImage of [BASE_IMAGE, `node@sha256:${"e".repeat(64)}`, `docker.io/library/node:24-slim@sha256:${"e".repeat(64)}`])
      expect(TargetSchema.safeParse(manifest(pin, { baseImage })).success, baseImage).toBe(true)
  })

  it("loads a target's recipe at a pin without its image", () => {
    const { root, first, second } = twoCommitRepo()
    const dir = targetsDir(first, { images: undefined })
    const recipe = loadTargetRecipe("t", { targetsDir: dir, repositoryRoot: root, pin: second })
    expect(recipe.pin).toBe(second)
    expect(recipe.directory).toBe(join(dir, "t"))
    expect(recipe.baseImage).toBe(BASE_IMAGE)
    expect(recipe).not.toHaveProperty("image")
    expect(recipe).not.toHaveProperty("images")
    expect(loadTargetRecipe("t", { targetsDir: dir, repositoryRoot: root }).pin).toBe(first)
    expect(() => loadTargetRecipe("nope", { targetsDir: dir, repositoryRoot: root })).toThrow(
      UnknownTargetError,
    )
  })

  it("names a tag after the target, the pin and the Dockerfile", () => {
    const pin = "1".repeat(40)
    expect(tagFor("devkit", pin, "c".repeat(64))).toBe(`b4-factory-devkit:${"1".repeat(12)}-${"c".repeat(12)}`)
    expect(imageTag({ id: "devkit", pin, image })).toBe(tagFor("devkit", pin, image.dockerfileSha256))
  })
```

and inside `describe("shipped manifests", …)`'s per-target `it` (`:385`), after the parse:

```ts
      // One base for every shipped target: the drafter's, pinned by digest (plan D3).
      expect(parsed.baseImage).toBe(
        "node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6",
      )
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/targets-catalog.test.ts`
Expected: FAIL (`loadTargetRecipe` / `tagFor` not exported; `baseImage` unrecognized key).

- [ ] **Step 3: Implement**

In `catalog.ts`, above `ImageSchema`:

```ts
/**
 * An image reference pinned by digest: `<name>[:<tag>]@sha256:<64 hex>`. The base is the one
 * image input that is not in the repository, so it is pinned here, where a person reviews it,
 * and never resolved from a floating tag at build time.
 */
const BASE_IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/
```

In `TargetObjectSchema`, after `snapshotIgnore`:

```ts
    /**
     * The image the Dockerfile builds FROM (`BASE_IMAGE` build arg), pinned by digest. A
     * multi-platform index digest, so one value serves every host platform. Part of the image
     * recipe (the registry's key) and of the image object (`baseManifestDigest`).
     */
    baseImage: z.string().regex(BASE_IMAGE, "baseImage must be <name>[:<tag>]@sha256:<64 hex>"),
```

Replace the `Target` interface (`:190-194`) with:

```ts
/**
 * A target AT one pin, without its image: what the capture, the prompt, the fit checks and
 * the image recipe read. `pin` is the chosen pin (the work order's, or the manifest's default).
 */
export interface TargetRecipe extends Omit<TargetManifest, "images"> {
  readonly directory: string
}

/**
 * A target as loaded AT one pin with the image built for it on this host, so everything
 * downstream (`imageTag`, the providers, the environment identity) reads one pin and one image.
 */
export interface Target extends TargetRecipe {
  /** Present: `loadTarget` refuses a pin without one. */
  readonly image: Image
}
```

Add above `loadTarget`:

```ts
/**
 * `id` at `options.pin` (the manifest's own pin when absent), without its image: the pin is
 * made present in the object store, nothing else is looked up. A new target is a directory,
 * not a code change.
 */
export function loadTargetRecipe(id: string, options: CatalogOptions = {}): TargetRecipe {
  const dir = options.targetsDir ?? targetsDir
  if (!loadTargetIds(dir).includes(id)) throw new UnknownTargetError(id)
  const directory = join(dir, id)
  const manifest = TargetSchema.parse(
    JSON.parse(readFileSync(join(directory, "target.json"), "utf8")),
  )
  if (manifest.id !== id) throw new Error(`Target ${id} declares a different id: ${manifest.id}`)
  const pin = options.pin ?? manifest.pin
  ensurePin(options.repositoryRoot ?? repositoryRoot(), id, pin)
  const { images: _images, ...recipe } = manifest
  return { ...recipe, pin, directory }
}
```

Replace `imageTag` (`:404-411`) with:

```ts
/**
 * The tag an image of `id` at `pin` from a Dockerfile hashing to `dockerfileSha256` is built
 * under. Binds the pin and the Dockerfile: a changed Dockerfile at the same pin is never the
 * old tag. Readable, and what keeps a built image from being a dangling one a prune removes;
 * never the identity (PR 2 runs images by ID).
 */
export function tagFor(id: string, pin: string, dockerfileSha256: string): string {
  return `b4-factory-${id}:${pin.slice(0, 12)}-${dockerfileSha256.slice(0, 12)}`
}

/** {@link tagFor} of a loaded target. Derived, never stored in the target. */
export function imageTag(target: Pick<Target, "id" | "pin" | "image">): string {
  return tagFor(target.id, target.pin, target.image.dockerfileSha256)
}
```

`loadTarget` needs no change in this task: its spread of the manifest already carries `baseImage`.

In each of the three `targets/<id>/target.json`, add after `"snapshotIgnore"`:

```json
  "baseImage": "node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6",
```

(For `cli` this is the base its recorded image already used; for `devkit` and `cli-flags` it replaces `2fe369e9…`, which Task 7's rebuild absorbs. The Dockerfiles need no change: they already take `ARG BASE_IMAGE`.)

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/targets-catalog.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/catalog.ts examples/software-factory/controller/targets/cli/target.json examples/software-factory/controller/targets/cli-flags/target.json examples/software-factory/controller/targets/devkit/target.json examples/software-factory/controller/test/targets-catalog.test.ts
git commit -m "feat(software-factory): a target's recipe pins its base image, and loads without an image

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: The recipe key

**Files:**
- Modify: `controller/src/lib/domain/digest.ts` (after `environmentIdentityDigest`, `:199-209`)
- Create: `controller/src/lib/targets/images.ts` (the recipe helpers only; Task 3 adds the registry)
- Create: `controller/test/recipe-fixture.ts` (shared by Tasks 2 to 6)
- Test: `controller/test/images-recipe.test.ts`

- [ ] **Step 1: Write the failing test**

`test/recipe-fixture.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type TargetRecipe, TargetSchema, targetsDir } from "../src/lib/targets/catalog.ts"

const dirs: string[] = []
/** Remove every directory `recipeFixture` made; an `afterEach`. */
export function cleanupRecipeFixtures(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/**
 * The shipped devkit recipe at its default pin, with `overrides`, and its Dockerfile (`dockerfile`)
 * in a directory of the test's own: a recipe a registry can key and a fake builder can
 * "build" with no git and no Docker.
 */
export function recipeFixture(
  overrides: Partial<TargetRecipe> = {},
  dockerfile = "FROM scratch\n",
): TargetRecipe {
  const directory = mkdtempSync(join(tmpdir(), "factory-recipe-"))
  dirs.push(directory)
  writeFileSync(join(directory, "Dockerfile"), dockerfile)
  const parsed = TargetSchema.parse(
    JSON.parse(readFileSync(join(targetsDir, "devkit", "target.json"), "utf8")),
  ) as Record<string, unknown>
  // Task 7 removes `images` from the schema; until then the shipped manifest still carries it.
  const { images: _images, ...shipped } = parsed
  return { ...(shipped as Omit<TargetRecipe, "directory">), directory, ...overrides }
}
```

`test/images-recipe.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest"
import { imageRecipeDigest } from "../src/lib/domain/digest.ts"
import type { TargetRecipe } from "../src/lib/targets/catalog.ts"
import {
  baseDigestOf,
  dockerfileSha256Of,
  hostPlatform,
  recipeKey,
} from "../src/lib/targets/images.ts"
import { cleanupRecipeFixtures, recipeFixture } from "./recipe-fixture.ts"

afterEach(cleanupRecipeFixtures)

describe("the image recipe key", () => {
  it("is stable for one recipe and platform", () => {
    const recipe = recipeFixture()
    expect(recipeKey(recipe, "linux/arm64")).toMatch(/^[a-f0-9]{64}$/)
    expect(recipeKey(recipe, "linux/arm64")).toBe(recipeKey({ ...recipe }, "linux/arm64"))
  })

  it("changes with every recipe input, including the ones today's tag does not see", () => {
    const recipe = recipeFixture()
    const key = recipeKey(recipe, "linux/arm64")
    const variants: TargetRecipe[] = [
      { ...recipe, pin: "1".repeat(40) },
      { ...recipe, baseImage: `node:24-slim@sha256:${"f".repeat(64)}` },
      { ...recipe, imageContext: [...recipe.imageContext, "packages/sdk/package.json"] },
      { ...recipe, lockfile: "other-lock.yaml" },
      { ...recipe, imageAssertResolves: [...recipe.imageAssertResolves, "zod"] },
      { ...recipe, commands: { ...recipe.commands, cwd: "packages/devkit" } },
      { ...recipe, id: "devkit2" },
      recipeFixture({}, "FROM scratch\nRUN true\n"),
    ]
    for (const variant of variants) expect(recipeKey(variant, "linux/arm64")).not.toBe(key)
    expect(recipeKey(recipe, "linux/amd64")).not.toBe(key)
  })

  it("ignores list order where order does not change the build, and every non-recipe field", () => {
    const recipe = recipeFixture()
    const key = recipeKey(recipe, "linux/arm64")
    expect(recipeKey({ ...recipe, imageContext: [...recipe.imageContext].reverse() }, "linux/arm64")).toBe(key)
    expect(recipeKey({ ...recipe, draftingNotes: ["a note"] }, "linux/arm64")).toBe(key)
    expect(recipeKey({ ...recipe, resources: { ...recipe.resources, cpus: 7 } }, "linux/arm64")).toBe(key)
    expect(recipeKey({ ...recipe, capture: { include: ["x"] } }, "linux/arm64")).toBe(key)
  })

  it("reads the Dockerfile's bytes, the base's digest, and the host's platform", () => {
    const recipe = recipeFixture({}, "FROM scratch\n")
    // sha256 of the 13 bytes `FROM scratch\n` (`printf 'FROM scratch\n' | shasum -a 256`).
    expect(dockerfileSha256Of(recipe)).toBe(
      "bb57c7da220a8753d7bdabac0d3afdb6efa742e4c736c5bc93ab40dfd5e23b9b",
    )
    expect(baseDigestOf(`node:24-slim@sha256:${"e".repeat(64)}`)).toBe(`sha256:${"e".repeat(64)}`)
    expect(hostPlatform("arm64")).toBe("linux/arm64")
    expect(hostPlatform("x64")).toBe("linux/amd64")
    expect(() => hostPlatform("ia32")).toThrow(/Unsupported host architecture ia32/)
  })

  it("is the domain-separated digest of its inputs", () => {
    const recipe = recipeFixture()
    expect(recipeKey(recipe, "linux/arm64")).toBe(
      imageRecipeDigest({
        targetId: recipe.id,
        pin: recipe.pin,
        platform: "linux/arm64",
        baseImage: recipe.baseImage,
        dockerfileSha256: dockerfileSha256Of(recipe),
        imageContext: recipe.imageContext,
        lockfile: recipe.lockfile,
        imageAssertResolves: recipe.imageAssertResolves,
        commandsCwd: recipe.commands.cwd,
      }),
    )
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/images-recipe.test.ts`
Expected: FAIL (`../src/lib/targets/images.ts` does not exist).

- [ ] **Step 3: Implement**

`digest.ts`, after `environmentIdentityDigest`:

```ts
/** The inputs a target's image is built from at a pin: what the image registry keys on. */
export interface ImageRecipeInputs {
  readonly targetId: string
  readonly pin: string
  readonly platform: string
  readonly baseImage: string
  readonly dockerfileSha256: string
  readonly imageContext: readonly string[]
  readonly lockfile: string
  readonly imageAssertResolves: readonly string[]
  readonly commandsCwd: string
}

/**
 * The image registry's key. Everything in `target.json` that changes what `docker build`
 * produces, or what the build is checked against, is here, including three inputs today's
 * tag and environment identity never saw (`imageContext`, `imageAssertResolves`, the
 * commands' working directory). Not the lockfile's hash: the pin is an immutable commit, so
 * the pin and the lockfile's path already decide it. Order-free lists are sorted.
 */
export function imageRecipeDigest(input: ImageRecipeInputs): string {
  return digest("b4-factory-image-recipe-v1", {
    ...input,
    imageContext: [...input.imageContext].sort(),
    imageAssertResolves: [...input.imageAssertResolves].sort(),
  })
}
```

`controller/src/lib/targets/images.ts`:

```ts
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { imageRecipeDigest } from "../domain/digest.js"
import type { TargetRecipe } from "./catalog.js"

/** The Docker platform this host builds and runs: the image object's `platform`. */
export function hostPlatform(arch: string = process.arch): string {
  if (arch === "arm64") return "linux/arm64"
  if (arch === "x64") return "linux/amd64"
  throw new Error(`Unsupported host architecture ${arch}`)
}

/** sha256 of the target's Dockerfile, over its exact bytes. */
export function dockerfileSha256Of(recipe: Pick<TargetRecipe, "directory">): string {
  return createHash("sha256")
    .update(readFileSync(join(recipe.directory, "Dockerfile")))
    .digest("hex")
}

/** `sha256:<hex>` of a `<name>[:<tag>]@sha256:<hex>` reference the schema already checked. */
export function baseDigestOf(baseImage: string): string {
  return baseImage.slice(baseImage.indexOf("@") + 1)
}

/** The registry key of `recipe` (at its own pin) on `platform`: see `imageRecipeDigest`. */
export function recipeKey(
  recipe: TargetRecipe,
  platform: string,
  dockerfileSha256: string = dockerfileSha256Of(recipe),
): string {
  return imageRecipeDigest({
    targetId: recipe.id,
    pin: recipe.pin,
    platform,
    baseImage: recipe.baseImage,
    dockerfileSha256,
    imageContext: recipe.imageContext,
    lockfile: recipe.lockfile,
    imageAssertResolves: recipe.imageAssertResolves,
    commandsCwd: recipe.commands.cwd,
  })
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/images-recipe.test.ts test/digest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/domain/digest.ts examples/software-factory/controller/src/lib/targets/images.ts examples/software-factory/controller/test/images-recipe.test.ts examples/software-factory/controller/test/recipe-fixture.ts
git commit -m "feat(software-factory): an image's registry key is its whole recipe at a pin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: The image registry: record, look up, build, and a failed build's log

**Files:**
- Modify: `controller/src/lib/targets/images.ts`
- Create: `controller/test/fake-image-builder.ts`
- Test: `controller/test/images-registry.test.ts`

- [ ] **Step 1: The fake builder**

`test/fake-image-builder.ts`:

```ts
import { createHash } from "node:crypto"
import type { Image } from "../src/lib/targets/catalog.ts"
import {
  type BuildRequest,
  baseDigestOf,
  dockerfileSha256Of,
  type ImageBuilder,
} from "../src/lib/targets/images.ts"

/**
 * The registry's Docker side, scripted: a daemon that is a Map, builds that can be held open
 * (to line concurrent callers up behind them), failed, and counted.
 */
export interface FakeImageBuilder extends ImageBuilder {
  /** Every build asked for, in order. */
  readonly requests: BuildRequest[]
  /** The fake daemon: image id to its tags. */
  readonly daemon: Map<string, string[]>
  /** Builds running now, and the most that ever ran at once. */
  readonly running: number
  readonly maxRunning: number
  /** Builds that ended because their signal aborted. */
  readonly aborted: number
  /** Hold every build that starts from now on until `release()`. */
  hold(): void
  release(): void
  /** The next build writes `log` and then fails with `message`. */
  failNext(message: string, log?: string): void
}

export function fakeImageBuilder(): FakeImageBuilder {
  let gate: Promise<void> | undefined
  let open: (() => void) | undefined
  const failures: { message: string; log: string }[] = []
  const requests: BuildRequest[] = []
  const daemon = new Map<string, string[]>()
  let serial = 0
  let running = 0
  let maxRunning = 0
  let aborted = 0
  const untag = (tag: string) => {
    for (const [id, tags] of daemon) daemon.set(id, tags.filter((t) => t !== tag))
  }
  const waitGate = (held: Promise<void> | undefined, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (held === undefined) return resolve()
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      held.then(resolve)
    })
  return {
    requests,
    daemon,
    get running() {
      return running
    },
    get maxRunning() {
      return maxRunning
    },
    get aborted() {
      return aborted
    },
    hold() {
      gate = new Promise((resolve) => {
        open = resolve
      })
    },
    release() {
      open?.()
      gate = undefined
      open = undefined
    },
    failNext(message, log = "") {
      failures.push({ message, log })
    },
    async build(request, log, signal) {
      requests.push(request)
      running += 1
      maxRunning = Math.max(maxRunning, running)
      try {
        log(`building ${request.tag}\n`)
        await waitGate(gate, signal)
        signal.throwIfAborted()
        const failure = failures.shift()
        if (failure) {
          log(failure.log)
          throw new Error(failure.message)
        }
        serial += 1
        const localId = `sha256:${createHash("sha256").update(`${request.tag}#${serial}`).digest("hex")}`
        untag(request.tag)
        daemon.set(localId, [request.tag])
        const image: Image = {
          localId,
          platform: request.platform,
          baseManifestDigest: baseDigestOf(request.recipe.baseImage),
          dockerfileSha256: dockerfileSha256Of(request.recipe),
          lockfileSha256: "d".repeat(64),
          pnpmVersion: "10.33.0",
        }
        return image
      } catch (error) {
        if (signal.aborted) aborted += 1
        throw error
      } finally {
        running -= 1
      }
    },
    async inspect(localId) {
      const tags = daemon.get(localId)
      return tags === undefined ? null : { tags: [...tags] }
    },
    async tag(localId, tag) {
      untag(tag)
      daemon.get(localId)?.push(tag)
    },
  }
}
```

- [ ] **Step 2: Write the failing tests**

`test/images-registry.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tagFor } from "../src/lib/targets/catalog.ts"
import {
  dockerfileSha256Of,
  type EnsureOptions,
  type ImageBuilder,
  ImagePrepareError,
  type ImageRegistry,
  type ImageRegistryOptions,
  openImageRegistry,
  recipeKey,
} from "../src/lib/targets/images.ts"
import { fakeImageBuilder } from "./fake-image-builder.ts"
import { cleanupRecipeFixtures, recipeFixture } from "./recipe-fixture.ts"

let dir: string
const registries: ImageRegistry[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "factory-images-"))
})
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close()
  rmSync(dir, { recursive: true, force: true })
  cleanupRecipeFixtures()
})

function open(builder: ImageBuilder, extra: Partial<ImageRegistryOptions> = {}): ImageRegistry {
  const registry = openImageRegistry({
    path: join(dir, "images.sqlite"),
    builder,
    platform: "linux/arm64",
    repositoryRoot: "/repo",
    ...extra,
  })
  registries.push(registry)
  return registry
}
const ensure = (
  registry: ImageRegistry,
  recipe: ReturnType<typeof recipeFixture>,
  extra: Partial<EnsureOptions> = {},
) => registry.ensure(recipe, { signal: AbortSignal.timeout(10_000), ...extra })

describe("the image registry", () => {
  it("builds on first need, records the image, and answers the next need from the record", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const recipe = recipeFixture()
    expect(registry.recorded(recipe)).toBeUndefined()
    const started: unknown[] = []
    const first = await ensure(registry, recipe, { onBuild: (event) => started.push(event) })
    const tag = tagFor(recipe.id, recipe.pin, dockerfileSha256Of(recipe))
    expect(builder.requests).toHaveLength(1)
    expect(builder.requests[0]).toMatchObject({ platform: "linux/arm64", tag, repositoryRoot: "/repo" })
    expect(first.key).toBe(recipeKey(recipe, "linux/arm64"))
    expect(first.tag).toBe(tag)
    expect(first.build?.shared).toBe(false)
    expect(first.build?.log).toContain(`building ${tag}`)
    expect(started).toEqual([{ key: first.key, shared: false }])

    const second = await ensure(registry, recipe)
    expect(builder.requests).toHaveLength(1)
    expect(second).toEqual({ key: first.key, tag, image: first.image })

    // On disk: a second connection (the next controller, or the script) reads it back.
    expect(open(builder).recorded(recipe)).toEqual({ key: first.key, tag, image: first.image })
  })

  it("keeps one image per recipe: another pin or another Dockerfile is another build", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const a = recipeFixture()
    const b = recipeFixture({ pin: "1".repeat(40) })
    const c = recipeFixture({}, "FROM scratch\nRUN true\n")
    const images = [await ensure(registry, a), await ensure(registry, b), await ensure(registry, c)]
    expect(builder.requests).toHaveLength(3)
    expect(new Set(images.map((i) => i.image.localId)).size).toBe(3)
    for (const [recipe, ensured] of [[a, images[0]], [b, images[1]], [c, images[2]]] as const)
      expect(registry.recorded(recipe)?.image).toEqual(ensured?.image)
  })

  it("records nothing for a failed build, carries its log, and builds again on the next need", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const recipe = recipeFixture()
    builder.failNext("pnpm install failed", "ERR_PNPM_OUTDATED_LOCKFILE\n")
    const failure = await ensure(registry, recipe).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ImagePrepareError)
    const error = failure as ImagePrepareError
    expect(error.message).toBe(`Target devkit at ${recipe.pin}: pnpm install failed`)
    expect(error.key).toBe(recipeKey(recipe, "linux/arm64"))
    expect(error.log).toContain("ERR_PNPM_OUTDATED_LOCKFILE")
    expect(registry.recorded(recipe)).toBeUndefined()
    await ensure(registry, recipe)
    expect(builder.requests).toHaveLength(2)
    expect(registry.recorded(recipe)).toBeDefined()
  })

  it("refuses an image the builder reports for another recipe", async () => {
    const builder = fakeImageBuilder()
    const lying: ImageBuilder = {
      inspect: builder.inspect,
      tag: builder.tag,
      async build(request, log, signal) {
        return { ...(await builder.build(request, log, signal)), platform: "linux/amd64" }
      },
    }
    const recipe = recipeFixture()
    const registry = open(lying)
    await expect(ensure(registry, recipe)).rejects.toThrow(
      /the builder reported an image of another recipe \(platform linux\/amd64, not linux\/arm64\)/,
    )
    expect(registry.recorded(recipe)).toBeUndefined()
  })

  it("refuses a registry written by a newer factory", () => {
    const db = new DatabaseSync(join(dir, "images.sqlite"))
    db.exec("PRAGMA user_version = 99")
    db.close()
    expect(() => open(fakeImageBuilder())).toThrow(
      /image registry schema version 99 is newer than this factory supports \(1\)/,
    )
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/images-registry.test.ts`
Expected: FAIL (`openImageRegistry` is not exported).

- [ ] **Step 4: Implement**

Append to `controller/src/lib/targets/images.ts` (and extend its imports to `import { mkdirSync, readFileSync } from "node:fs"`, `import { dirname, join } from "node:path"`, `import { DatabaseSync } from "node:sqlite"`, and `import { type Image, ImageSchema, repositoryRoot, type TargetRecipe, tagFor } from "./catalog.js"` in place of the type-only import):

```ts
/** What one build is asked for. */
export interface BuildRequest {
  readonly recipe: TargetRecipe
  readonly platform: string
  readonly tag: string
  readonly repositoryRoot: string
}

/**
 * The Docker side of the registry, injectable so the registry's rules (one build per key, the
 * limit, cancellation, drift) are testable without a daemon. `dockerImageBuilder` is the real one.
 */
export interface ImageBuilder {
  /** Build `request`'s image, writing its output to `log`. Rejects when `signal` aborts. */
  build(request: BuildRequest, log: (chunk: string) => void, signal: AbortSignal): Promise<Image>
  /** The daemon's tags for `localId`, or null when the daemon does not hold that image. */
  inspect(localId: string, signal: AbortSignal): Promise<{ readonly tags: readonly string[] } | null>
  /** Point `tag` at `localId`. */
  tag(localId: string, tag: string, signal: AbortSignal): Promise<void>
}

export interface RecordedImage {
  readonly key: string
  readonly tag: string
  readonly image: Image
}

export interface EnsuredImage extends RecordedImage {
  /** Present when this call built the image, or waited on a build another call started. */
  readonly build?: { readonly shared: boolean; readonly ms: number; readonly log: string }
}

export interface EnsureOptions {
  readonly signal: AbortSignal
  /** Once, when this call starts a build (`shared: false`) or joins one in flight (`shared: true`). */
  readonly onBuild?: (event: { readonly key: string; readonly shared: boolean }) => void
  /** When the recorded image is gone from the daemon; it is then forgotten and built again. */
  readonly onMissing?: (event: { readonly key: string; readonly localId: string }) => void
}

/**
 * This host's images, one per recipe (`recipeKey`): `<FACTORY_STATE_DIR>/images.sqlite`. The
 * controller asks it when a work order first needs a target at a pin; `target:prepare` asks it
 * to warm a pin by hand. Nothing here is model-written: a recipe is the reviewed target, the
 * committed Dockerfile and the repository at a pin.
 */
export interface ImageRegistry {
  /** The image recorded for `recipe` at its pin on this platform. A SQLite read: no Docker. */
  recorded(recipe: TargetRecipe): RecordedImage | undefined
  /** The recorded image, or a build of it. See `openImageRegistry`. */
  ensure(recipe: TargetRecipe, options: EnsureOptions): Promise<EnsuredImage>
  /** Abort every build in flight and close the database. */
  close(): void
}

/** A build that produced no image. `log` is what it printed, kept as evidence. */
export class ImagePrepareError extends Error {
  constructor(
    message: string,
    readonly key: string,
    readonly log: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ImagePrepareError"
  }
}

export const IMAGE_REGISTRY_VERSION = 1
export const DEFAULT_MAX_IMAGE_BUILDS = 1
export const DEFAULT_IMAGE_BUILD_TIMEOUT_MS = 30 * 60_000
/** The most of one build's output kept: its tail, which is where a failure explains itself. */
export const BUILD_LOG_LIMIT = 1024 * 1024

export interface ImageRegistryOptions {
  /** `<FACTORY_STATE_DIR>/images.sqlite`. */
  readonly path: string
  readonly builder: ImageBuilder
  /** Builds running at once across every key (`FACTORY_MAX_IMAGE_BUILDS`). */
  readonly maxConcurrentBuilds?: number
  /** Per build, from when it takes its slot (`FACTORY_IMAGE_BUILD_TIMEOUT_MS`). */
  readonly buildTimeoutMs?: number
  /** The repository the build context is archived from; `repositoryRoot()` when absent. */
  readonly repositoryRoot?: string
  /** `hostPlatform()` when absent. */
  readonly platform?: string
  readonly now?: () => number
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS images (
    key TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    pin TEXT NOT NULL,
    tag TEXT NOT NULL,
    local_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    base_manifest_digest TEXT NOT NULL,
    dockerfile_sha256 TEXT NOT NULL,
    lockfile_sha256 TEXT NOT NULL,
    pnpm_version TEXT NOT NULL,
    built_at TEXT NOT NULL,
    build_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS images_by_target_pin ON images(target_id, pin);
`

interface ImageRow {
  readonly tag: string
  readonly local_id: string
  readonly platform: string
  readonly base_manifest_digest: string
  readonly dockerfile_sha256: string
  readonly lockfile_sha256: string
  readonly pnpm_version: string
}

/** A build's output, bounded to its last `BUILD_LOG_LIMIT` characters, with a note of what was cut. */
export class BuildLog {
  private text_ = ""
  private dropped = 0
  write(chunk: string): void {
    this.text_ += chunk
    if (this.text_.length > 2 * BUILD_LOG_LIMIT) {
      const cut = this.text_.length - BUILD_LOG_LIMIT
      this.text_ = this.text_.slice(cut)
      this.dropped += cut
    }
  }
  text(): string {
    const cut = Math.max(0, this.text_.length - BUILD_LOG_LIMIT)
    const tail = this.text_.slice(cut)
    const dropped = this.dropped + cut
    return dropped > 0 ? `[${dropped} earlier characters of the build log dropped]\n${tail}` : tail
  }
}

/** Why `image` is not what `recipe` builds on `platform`, or undefined when it is. */
function recipeMismatch(
  image: Image,
  recipe: TargetRecipe,
  platform: string,
  dockerfileSha256: string,
): string | undefined {
  if (image.platform !== platform) return `platform ${image.platform}, not ${platform}`
  if (image.dockerfileSha256 !== dockerfileSha256) return "another Dockerfile"
  const base = baseDigestOf(recipe.baseImage)
  if (image.baseManifestDigest !== base) return `base ${image.baseManifestDigest}, not ${base}`
  return undefined
}

interface Described {
  readonly key: string
  readonly tag: string
  readonly dockerfileSha256: string
}
interface Built {
  readonly image: Image
  readonly ms: number
  readonly log: string
}

export function openImageRegistry(options: ImageRegistryOptions): ImageRegistry {
  mkdirSync(dirname(options.path), { recursive: true })
  const db = new DatabaseSync(options.path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  const found = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)
  if (found > IMAGE_REGISTRY_VERSION) {
    db.close()
    throw new Error(
      `The image registry schema version ${found} is newer than this factory supports (${IMAGE_REGISTRY_VERSION}): upgrade the factory, or give it another FACTORY_STATE_DIR`,
    )
  }
  db.exec(SCHEMA)
  db.exec(`PRAGMA user_version = ${IMAGE_REGISTRY_VERSION}`)
  const platform = options.platform ?? hostPlatform()
  const now = options.now ?? Date.now

  const describe = (recipe: TargetRecipe): Described => {
    const dockerfileSha256 = dockerfileSha256Of(recipe)
    return {
      key: recipeKey(recipe, platform, dockerfileSha256),
      tag: tagFor(recipe.id, recipe.pin, dockerfileSha256),
      dockerfileSha256,
    }
  }
  const read = (key: string): Image | undefined => {
    const row = db
      .prepare(
        "SELECT tag, local_id, platform, base_manifest_digest, dockerfile_sha256, lockfile_sha256, pnpm_version FROM images WHERE key = ?",
      )
      .get(key) as unknown as ImageRow | undefined
    if (row === undefined) return undefined
    return ImageSchema.parse({
      localId: row.local_id,
      platform: row.platform,
      baseManifestDigest: row.base_manifest_digest,
      dockerfileSha256: row.dockerfile_sha256,
      lockfileSha256: row.lockfile_sha256,
      pnpmVersion: row.pnpm_version,
    })
  }
  const write = (described: Described, recipe: TargetRecipe, image: Image, ms: number) => {
    db.prepare(
      `INSERT OR REPLACE INTO images (key, target_id, pin, tag, local_id, platform, base_manifest_digest, dockerfile_sha256, lockfile_sha256, pnpm_version, built_at, build_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      described.key,
      recipe.id,
      recipe.pin,
      described.tag,
      image.localId,
      image.platform,
      image.baseManifestDigest,
      image.dockerfileSha256,
      image.lockfileSha256,
      image.pnpmVersion,
      new Date(now()).toISOString(),
      ms,
    )
  }

  /** One build, start to record. A failure of any kind is an `ImagePrepareError` with the log. */
  async function build(described: Described, recipe: TargetRecipe, signal: AbortSignal): Promise<Built> {
    const log = new BuildLog()
    const started = now()
    const fail = (reason: string, cause?: unknown): never => {
      throw new ImagePrepareError(
        `Target ${recipe.id} at ${recipe.pin}: ${reason}`,
        described.key,
        log.text(),
        cause === undefined ? undefined : { cause },
      )
    }
    let image: Image
    try {
      image = await options.builder.build(
        {
          recipe,
          platform,
          tag: described.tag,
          repositoryRoot: options.repositoryRoot ?? repositoryRoot(),
        },
        (chunk) => log.write(chunk),
        signal,
      )
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), error)
    }
    const mismatch = recipeMismatch(image, recipe, platform, described.dockerfileSha256)
    if (mismatch !== undefined) fail(`the builder reported an image of another recipe (${mismatch})`)
    const ms = now() - started
    write(described, recipe, image, ms)
    return { image, ms, log: log.text() }
  }

  return {
    recorded(recipe) {
      const described = describe(recipe)
      const image = read(described.key)
      return image === undefined ? undefined : { key: described.key, tag: described.tag, image }
    },
    async ensure(recipe, ensureOptions) {
      const { signal } = ensureOptions
      signal.throwIfAborted()
      const described = describe(recipe)
      const image = read(described.key)
      if (image !== undefined) return { key: described.key, tag: described.tag, image }
      ensureOptions.onBuild?.({ key: described.key, shared: false })
      const built = await build(described, recipe, signal)
      return {
        key: described.key,
        tag: described.tag,
        image: built.image,
        build: { shared: false, ms: built.ms, log: built.log },
      }
    },
    close() {
      db.close()
    },
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/images-registry.test.ts test/images-recipe.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/images.ts examples/software-factory/controller/test/fake-image-builder.ts examples/software-factory/controller/test/images-registry.test.ts
git commit -m "feat(software-factory): a host-local registry of the images each recipe built

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: One build per key, a global limit, a timeout, and cancellation that waits for the last waiter

**Files:**
- Modify: `controller/src/lib/targets/images.ts` (`openImageRegistry`'s `ensure` and `close`; new `BuildSlots`, `abortable`)
- Test: `controller/test/images-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/images-registry.test.ts` (and import `setTimeout as sleep` from `node:timers/promises`):

```ts
/** Wait until `condition` holds, polling; a test's own bound on a background build. */
async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error("condition never held")
    await sleep(5)
  }
}

describe("builds in flight", () => {
  it("builds a key once however many need it at once", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const registry = open(builder)
    const recipe = recipeFixture()
    const events: { key: string; shared: boolean }[] = []
    const onBuild = (event: { key: string; shared: boolean }) => events.push(event)
    const first = ensure(registry, recipe, { onBuild })
    await until(() => builder.requests.length === 1)
    const second = ensure(registry, recipe, { onBuild })
    await until(() => events.length === 2)
    builder.release()
    const [a, b] = await Promise.all([first, second])
    expect(builder.requests).toHaveLength(1)
    expect(a.image).toEqual(b.image)
    expect(events.map((e) => e.shared)).toEqual([false, true])
    expect([a.build?.shared, b.build?.shared]).toEqual([false, true])
  })

  it("never runs more builds at once than its limit, and queues the rest", async () => {
    for (const limit of [1, 2]) {
      const builder = fakeImageBuilder()
      builder.hold()
      const registry = open(builder, { maxConcurrentBuilds: limit, path: join(dir, `limit-${limit}.sqlite`) })
      const recipes = [0, 1, 2].map((n) => recipeFixture({ pin: String(n).repeat(40) }))
      const all = Promise.all(recipes.map((recipe) => ensure(registry, recipe)))
      await until(() => builder.running === limit)
      await sleep(50)
      expect(builder.running).toBe(limit)
      builder.release()
      await all
      expect(builder.maxRunning).toBe(limit)
      expect(builder.requests).toHaveLength(3)
    }
  })

  it("keeps a shared build running when one waiter leaves, and cancels it when the last does", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const registry = open(builder)
    const recipe = recipeFixture()
    const leaving = new AbortController()
    const staying = ensure(registry, recipe)
    const left = registry.ensure(recipe, { signal: leaving.signal }).catch((error: unknown) => error)
    await until(() => builder.requests.length === 1)
    leaving.abort(new Error("work order cancelled"))
    expect(await left).toEqual(new Error("work order cancelled"))
    expect(builder.aborted).toBe(0)
    builder.release()
    expect((await staying).image.localId).toMatch(/^sha256:/)

    const alone = new AbortController()
    builder.hold()
    const other = recipeFixture({ pin: "2".repeat(40) })
    const cancelled = registry.ensure(other, { signal: alone.signal }).catch((error: unknown) => error)
    await until(() => builder.requests.length === 2)
    alone.abort(new Error("work order cancelled"))
    await cancelled
    await until(() => builder.aborted === 1)
    expect(registry.recorded(other)).toBeUndefined()
    // A cancelled build left nothing behind: the next need builds afresh.
    builder.release()
    await ensure(registry, other)
    expect(builder.requests).toHaveLength(3)
  })

  it("leaves a queued waiter's cancel costing nothing", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const registry = open(builder, { maxConcurrentBuilds: 1 })
    const running = ensure(registry, recipeFixture({ pin: "3".repeat(40) }))
    await until(() => builder.running === 1)
    const queued = new AbortController()
    const waiting = registry
      .ensure(recipeFixture({ pin: "4".repeat(40) }), { signal: queued.signal })
      .catch((error: unknown) => error)
    queued.abort(new Error("gone"))
    expect(await waiting).toEqual(new Error("gone"))
    builder.release()
    await running
    expect(builder.requests).toHaveLength(1)
  })

  it("fails a build past its timeout, naming the limit, with the log so far", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const registry = open(builder, { buildTimeoutMs: 50 })
    const recipe = recipeFixture()
    const failure = await ensure(registry, recipe).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ImagePrepareError)
    expect((failure as ImagePrepareError).message).toBe(
      `Target devkit at ${recipe.pin}: the build exceeded 50 ms (FACTORY_IMAGE_BUILD_TIMEOUT_MS)`,
    )
    expect((failure as ImagePrepareError).log).toContain("building b4-factory-devkit:")
    expect(builder.aborted).toBe(1)
    expect(registry.recorded(recipe)).toBeUndefined()
    builder.release()
  })

  it("aborts its builds when it closes", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const registry = open(builder)
    const pending = ensure(registry, recipeFixture()).catch((error: unknown) => error)
    await until(() => builder.running === 1)
    registry.close()
    registries.splice(registries.indexOf(registry), 1)
    expect(await pending).toBeInstanceOf(Error)
    await until(() => builder.aborted === 1)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/images-registry.test.ts -t "builds in flight"`
Expected: FAIL: two builds instead of one; the limit is not held; no timeout.

- [ ] **Step 3: Implement**

In `images.ts`, above `openImageRegistry`:

```ts
/** A counting semaphore whose waiters leave the queue when their signal aborts. */
export class BuildSlots {
  private free: number
  private readonly queue: (() => void)[] = []
  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1)
      throw new Error(`the image build limit must be a positive integer, got ${size}`)
    this.free = size
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.free > 0) {
      this.free -= 1
      return this.releaser()
    }
    return await new Promise<() => void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort)
        resolve(this.releaser())
      }
      const onAbort = () => {
        const at = this.queue.indexOf(grant)
        if (at >= 0) this.queue.splice(at, 1)
        reject(signal.reason)
      }
      this.queue.push(grant)
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }
  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next) next()
      else this.free += 1
    }
  }
}

/** `promise`, or `signal`'s reason as soon as it aborts; the promise itself runs on. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

interface Flight {
  readonly promise: Promise<Built>
  readonly controller: AbortController
  waiters: number
  settled: boolean
}
```

Inside `openImageRegistry`, after `const now = …`:

```ts
  const slots = new BuildSlots(options.maxConcurrentBuilds ?? DEFAULT_MAX_IMAGE_BUILDS)
  const timeoutMs = options.buildTimeoutMs ?? DEFAULT_IMAGE_BUILD_TIMEOUT_MS
  /** The build in flight per key. A later caller joins it rather than building again. */
  const inflight = new Map<string, Flight>()
```

and, after `build`:

```ts
  /**
   * Start `described`'s build: queued for a slot, then bounded by the timeout from when it
   * runs. Its controller aborts only when the last waiter leaves (`ensure`) or the registry
   * closes, so one work order's cancel never kills a build another still waits on.
   */
  function startFlight(described: Described, recipe: TargetRecipe): Flight {
    const controller = new AbortController()
    const run = async (): Promise<Built> => {
      let release: () => void
      try {
        release = await slots.acquire(controller.signal)
      } catch (error) {
        throw new ImagePrepareError(
          `Target ${recipe.id} at ${recipe.pin}: the build was abandoned before it started`,
          described.key,
          "",
          { cause: error },
        )
      }
      try {
        const deadline = AbortSignal.timeout(timeoutMs)
        try {
          return await build(described, recipe, AbortSignal.any([controller.signal, deadline]))
        } catch (error) {
          if (deadline.aborted && !controller.signal.aborted && error instanceof ImagePrepareError)
            throw new ImagePrepareError(
              `Target ${recipe.id} at ${recipe.pin}: the build exceeded ${timeoutMs} ms (FACTORY_IMAGE_BUILD_TIMEOUT_MS)`,
              described.key,
              error.log,
              { cause: error },
            )
          throw error
        }
      } finally {
        release()
      }
    }
    const flight: Flight = {
      controller,
      waiters: 0,
      settled: false,
      promise: run().finally(() => {
        flight.settled = true
        if (inflight.get(described.key) === flight) inflight.delete(described.key)
      }),
    }
    // Every waiter may have left: the rejection is then nobody's, and must not be unhandled.
    flight.promise.catch(() => {})
    inflight.set(described.key, flight)
    return flight
  }
```

Replace `ensure` and `close`:

```ts
    async ensure(recipe, ensureOptions) {
      const { signal } = ensureOptions
      signal.throwIfAborted()
      const described = describe(recipe)
      const image = read(described.key)
      if (image !== undefined) return { key: described.key, tag: described.tag, image }
      const joined = inflight.get(described.key)
      const flight = joined ?? startFlight(described, recipe)
      const shared = joined !== undefined
      ensureOptions.onBuild?.({ key: described.key, shared })
      flight.waiters += 1
      try {
        const built = await abortable(flight.promise, signal)
        return {
          key: described.key,
          tag: described.tag,
          image: built.image,
          build: { shared, ms: built.ms, log: built.log },
        }
      } finally {
        flight.waiters -= 1
        if (flight.waiters === 0 && !flight.settled) {
          // Nobody waits on it any more: a later need starts afresh rather than joining a
          // build that is being cancelled.
          if (inflight.get(described.key) === flight) inflight.delete(described.key)
          flight.controller.abort(new Error("no work order is waiting on this image build"))
        }
      }
    },
    close() {
      for (const flight of inflight.values())
        flight.controller.abort(new Error("the image registry closed"))
      inflight.clear()
      db.close()
    },
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/images-registry.test.ts`
Expected: PASS (all of Task 3's and Task 4's).

Mutation check (not committed): change `const flight = joined ?? startFlight(…)` to `const flight = startFlight(…)` and see "builds a key once" fail with 2 requests; change the `waiters === 0` guard to `true` and see "keeps a shared build running" fail with `aborted === 1`. Restore both.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/images.ts examples/software-factory/controller/test/images-registry.test.ts
git commit -m "feat(software-factory): one image build per recipe, bounded, timed, cancelled by its last waiter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Drift: a recorded image the daemon lost is rebuilt; a moved tag is pointed back

**Files:**
- Modify: `controller/src/lib/targets/images.ts` (`ensure`'s recorded branch; a `forget` helper)
- Test: `controller/test/images-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("a registry that disagrees with the daemon", () => {
  it("rebuilds an image the daemon no longer holds, and says so", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const recipe = recipeFixture()
    const first = await ensure(registry, recipe)
    builder.daemon.delete(first.image.localId)
    const missing: unknown[] = []
    const second = await ensure(registry, recipe, { onMissing: (event) => missing.push(event) })
    expect(missing).toEqual([{ key: first.key, localId: first.image.localId }])
    expect(builder.requests).toHaveLength(2)
    expect(second.build?.shared).toBe(false)
    expect(second.image.localId).not.toBe(first.image.localId)
    expect(registry.recorded(recipe)?.image.localId).toBe(second.image.localId)
  })

  it("points a moved tag back at the recorded image without rebuilding it", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const recipe = recipeFixture()
    const first = await ensure(registry, recipe)
    // Someone tagged another image with the factory's tag.
    builder.daemon.set(`sha256:${"9".repeat(64)}`, [])
    await builder.tag(`sha256:${"9".repeat(64)}`, first.tag, AbortSignal.timeout(1_000))
    expect(builder.daemon.get(first.image.localId)).toEqual([])
    const again = await ensure(registry, recipe)
    expect(again).toEqual({ key: first.key, tag: first.tag, image: first.image })
    expect(builder.requests).toHaveLength(1)
    expect(builder.daemon.get(first.image.localId)).toEqual([first.tag])
  })

  it("answers `recorded` from the registry alone, never the daemon", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const recipe = recipeFixture()
    const first = await ensure(registry, recipe)
    builder.daemon.clear()
    expect(registry.recorded(recipe)?.image).toEqual(first.image)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/images-registry.test.ts -t "disagrees with the daemon"`
Expected: FAIL: the first two (no rebuild, no re-tag); the third passes already (it pins `recorded`'s contract).

- [ ] **Step 3: Implement**

Inside `openImageRegistry`, after `write`:

```ts
  /** Drop `key`'s record, but only if it still names `localId`: another writer may have replaced it. */
  const forget = (key: string, localId: string) => {
    db.prepare("DELETE FROM images WHERE key = ? AND local_id = ?").run(key, localId)
  }
```

In `ensure`, replace

```ts
      const image = read(described.key)
      if (image !== undefined) return { key: described.key, tag: described.tag, image }
```

with

```ts
      const image = read(described.key)
      if (image !== undefined) {
        // Re-verified on every need: an image pruned or removed since it was recorded is not
        // this key's answer any more, and a tag another image took is pointed back so a
        // dangling-image prune cannot remove the recorded one.
        const found = await options.builder.inspect(image.localId, signal)
        if (found !== null) {
          if (!found.tags.includes(described.tag))
            await options.builder.tag(image.localId, described.tag, signal)
          return { key: described.key, tag: described.tag, image }
        }
        ensureOptions.onMissing?.({ key: described.key, localId: image.localId })
        forget(described.key, image.localId)
      }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/images-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/images.ts examples/software-factory/controller/test/images-registry.test.ts
git commit -m "feat(software-factory): a recorded image is re-verified on every need, and rebuilt when gone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: The Docker builder, lifted out of the script

The build steps move from `scripts/prepare-target.ts:34-186` into `src/lib/targets/image-builder.ts`, unchanged in substance except: the base is pulled only when absent (D3), the lockfile is hashed from the context the build saw, the module assertions run the image by ID, every command's output goes to the log, and every command is cancellable. The pre-build refusals become one function in `prepare.ts`.

**Files:**
- Create: `controller/src/lib/targets/image-builder.ts`
- Modify: `controller/src/lib/targets/prepare.ts` (add `recipeProblem`)
- Test: `controller/test/image-builder.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/image-builder.test.ts`:

```ts
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { tagFor } from "../src/lib/targets/catalog.ts"
import { dockerImageBuilder, type Run, spawnRun } from "../src/lib/targets/image-builder.ts"
import { dockerfileSha256Of } from "../src/lib/targets/images.ts"
import { recipeProblem } from "../src/lib/targets/prepare.ts"
import { cleanupRecipeFixtures, recipeFixture } from "./recipe-fixture.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  cleanupRecipeFixtures()
})
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const BASE = `node:24-slim@sha256:${"e".repeat(64)}`
const LOCAL_ID = `sha256:${"1".repeat(64)}`
const LOCK = "lockfileVersion: '9.0'\n"

/** A repository with the three files the recipe below names, committed once. */
function repo(): { root: string; pin: string } {
  const root = temp("factory-builder-repo-")
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  writeFileSync(join(root, "package.json"), '{"packageManager":"pnpm@10.33.0"}\n')
  writeFileSync(join(root, "pnpm-lock.yaml"), LOCK)
  mkdirSync(join(root, "packages", "devkit"), { recursive: true })
  writeFileSync(join(root, "packages", "devkit", "package.json"), "{}\n")
  git("add", ".")
  git("commit", "-q", "-m", "one")
  return { root, pin: git("rev-parse", "HEAD") }
}

function recipeAt(pin: string, overrides: Parameters<typeof recipeFixture>[0] = {}) {
  return recipeFixture({
    pin,
    root: ".",
    baseImage: BASE,
    imageContext: ["package.json", "pnpm-lock.yaml"],
    lockfile: "pnpm-lock.yaml",
    capture: { include: ["package.json", "packages/devkit/package.json"] },
    runnerConfig: ["package.json"],
    commands: { cwd: ".", build: [], test: ["true"], nodeTestExecArgv: [] },
    imageAssertResolves: ["vitest"],
    ...overrides,
  })
}

/** git and tar for real; docker scripted, every call recorded. */
function scriptedDocker(options: { readonly basePresent: boolean }) {
  const calls: string[][] = []
  let context: string[] = []
  const run: Run = async (command, args, runOptions) => {
    if (command !== "docker") return spawnRun(command, args, runOptions)
    calls.push([...args])
    const [verb, ...rest] = args
    if (verb === "image" && rest.at(-1) === BASE) {
      if (!options.basePresent)
        throw new Error(`docker image failed (exit 1): Error response from daemon: No such image: ${BASE}`)
      return "sha256:base\n"
    }
    if (verb === "pull") {
      runOptions.onOutput?.("pulled\n")
      return ""
    }
    if (verb === "build") {
      context = readdirSync(args.at(-1) as string).sort()
      runOptions.onOutput?.("#5 DONE 0.1s\n")
      return ""
    }
    if (verb === "image") return `${LOCAL_ID}\n`
    if (verb === "run") return ""
    throw new Error(`unscripted: docker ${args.join(" ")}`)
  }
  return { run, calls, context: () => context }
}

describe("dockerImageBuilder", () => {
  it("pulls an absent base, builds the pin's archive with the recipe's arguments, and checks the modules by id", async () => {
    const { root, pin } = repo()
    const recipe = recipeAt(pin)
    const docker = scriptedDocker({ basePresent: false })
    const tmp = temp("factory-builder-tmp-")
    const tag = tagFor(recipe.id, pin, dockerfileSha256Of(recipe))
    const log: string[] = []
    const image = await dockerImageBuilder({ run: docker.run, tmp }).build(
      { recipe, platform: "linux/arm64", tag, repositoryRoot: root },
      (chunk) => log.push(chunk),
      AbortSignal.timeout(30_000),
    )
    expect(image).toEqual({
      localId: LOCAL_ID,
      platform: "linux/arm64",
      baseManifestDigest: `sha256:${"e".repeat(64)}`,
      dockerfileSha256: dockerfileSha256Of(recipe),
      lockfileSha256: createHash("sha256").update(LOCK).digest("hex"),
      pnpmVersion: "10.33.0",
    })
    const build = docker.calls.find((call) => call[0] === "build") ?? []
    expect(docker.calls.map((call) => call.slice(0, 2))).toEqual([
      ["image", "inspect"],
      ["pull", "--platform"],
      ["build", "--platform"],
      ["image", "inspect"],
      ["run", "--rm"],
    ])
    expect(docker.calls[1]).toEqual(["pull", "--platform", "linux/arm64", BASE])
    expect(build).toEqual(
      expect.arrayContaining([
        `BASE_IMAGE=${BASE}`,
        "PLATFORM=linux/arm64",
        "PNPM_VERSION=10.33.0",
        "-t",
        tag,
      ]),
    )
    // The context is the pin's archive of imageContext plus the Dockerfile, and nothing else.
    expect(docker.context()).toEqual(["Dockerfile", "package.json", "pnpm-lock.yaml"])
    expect(existsSync(build.at(-1) as string)).toBe(false)
    expect(readdirSync(tmp)).toEqual([])
    expect(docker.calls[3]).toEqual(["image", "inspect", "--format", "{{.Id}}", tag])
    expect(docker.calls[4]).toEqual([
      "run", "--rm", "--network", "none", "-w", "/opt/targets/devkit",
      LOCAL_ID, "node", "-e", 'require.resolve("vitest")',
    ])
    expect(log.join("")).toContain("pulling")
    expect(log.join("")).toContain("pulled")
    expect(log.join("")).toContain("#5 DONE")
  })

  it("does not pull a base the daemon already holds", async () => {
    const { root, pin } = repo()
    const docker = scriptedDocker({ basePresent: true })
    await dockerImageBuilder({ run: docker.run }).build(
      { recipe: recipeAt(pin), platform: "linux/arm64", tag: "b4-factory-devkit:x", repositoryRoot: root },
      () => {},
      AbortSignal.timeout(30_000),
    )
    expect(docker.calls.some((call) => call[0] === "pull")).toBe(false)
  })

  it("refuses a recipe that does not apply at the pin before any Docker call", async () => {
    const { root, pin } = repo()
    const docker = scriptedDocker({ basePresent: true })
    const recipe = recipeAt(pin, { imageContext: ["package.json", "pnpm-lock.yaml", "missing.txt"] })
    expect(recipeProblem(recipe, root)).toBe(
      `Target "devkit" names missing.txt, which does not exist at ${pin}: it cannot be prepared at that pin`,
    )
    await expect(
      dockerImageBuilder({ run: docker.run }).build(
        { recipe, platform: "linux/arm64", tag: "t", repositoryRoot: root },
        () => {},
        AbortSignal.timeout(30_000),
      ),
    ).rejects.toThrow("names missing.txt, which does not exist at")
    expect(docker.calls).toEqual([])
    expect(recipeProblem(recipeAt(pin, { imageContext: ["package.json"] }), root)).toBe(
      'Target "devkit" records lockfile "pnpm-lock.yaml", which its imageContext does not cover',
    )
    expect(recipeProblem(recipeAt(pin), root)).toBeUndefined()
  })

  it("reads an image the daemon does not hold as missing, and any other failure as a failure", async () => {
    const answers: Record<string, Error | string> = {
      gone: new Error("docker image failed (exit 1): Error response from daemon: No such image: gone"),
      down: new Error("docker image failed (exit 1): Cannot connect to the Docker daemon"),
      here: '["b4-factory-devkit:x"]\n',
    }
    const run: Run = async (_command, args) => {
      const answer = answers[args.at(-1) as string]
      if (answer instanceof Error) throw answer
      return answer ?? ""
    }
    const builder = dockerImageBuilder({ run })
    const signal = AbortSignal.timeout(5_000)
    expect(await builder.inspect("gone", signal)).toBeNull()
    expect(await builder.inspect("here", signal)).toEqual({ tags: ["b4-factory-devkit:x"] })
    await expect(builder.inspect("down", signal)).rejects.toThrow(/Cannot connect/)
  })

  it("kills a command when its signal aborts", async () => {
    const controller = new AbortController()
    const running = spawnRun("sleep", ["30"], { signal: controller.signal })
    controller.abort(new Error("cancelled"))
    await expect(running).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/image-builder.test.ts`
Expected: FAIL (`image-builder.ts` and `recipeProblem` do not exist).

- [ ] **Step 3: Implement**

`prepare.ts`: extend the catalog import to `import { appRoot, commitSha, covers, type Image, type TargetManifest, type TargetRecipe, TargetSchema } from "./catalog.js"`, add `import { join } from "node:path"`, and append:

```ts
/**
 * Why `recipe` cannot be built at its pin, or undefined. Each is refused by name before any
 * pull or build: a path the target names that the pin does not hold (`git archive` of it would
 * fail naming nothing useful, and the `cli-flags` fixture's paths moved); a Dockerfile whose
 * `CAPTURED` list disagrees with the capture; a lockfile outside the build context, whose hash
 * would record an input that did not produce the image.
 */
export function recipeProblem(
  recipe: TargetRecipe,
  repo: string,
  exists: (path: string) => boolean = (path) => pathExistsAtPin(repo, recipe.pin, path),
): string | undefined {
  const missing = firstMissingPath(pathsRequiredAtPin(recipe), exists)
  if (missing !== undefined)
    return `Target "${recipe.id}" names ${missing}, which does not exist at ${recipe.pin}: it cannot be prepared at that pin`
  const captured = capturedListMismatch(
    recipe,
    readFileSync(join(recipe.directory, "Dockerfile"), "utf8"),
  )
  if (captured !== undefined) return captured
  if (!covers(recipe.imageContext, recipe.lockfile))
    return `Target "${recipe.id}" records lockfile "${recipe.lockfile}", which its imageContext does not cover`
  return undefined
}
```

`controller/src/lib/targets/image-builder.ts`:

```ts
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ImageSchema } from "./catalog.js"
import { baseDigestOf, type ImageBuilder } from "./images.js"
import { recipeProblem } from "./prepare.js"

/** Run a command to completion: its stdout, or an Error naming the exit and stderr's tail. */
export type Run = (
  command: string,
  args: readonly string[],
  options: { readonly signal: AbortSignal; readonly onOutput?: (chunk: string) => void },
) => Promise<string>

/** `Run` over `spawn`: output streamed to `onOutput` as it arrives, killed when `signal` aborts. */
export const spawnRun: Run = (command, args, { signal, onOutput }) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], { signal, stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk)
      onOutput?.(chunk.toString("utf8"))
    })
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      stderr = (stderr + text).slice(-8_192)
      onOutput?.(text)
    })
    child.on("error", reject)
    child.on("close", (code, killedBy) => {
      if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"))
      const tail = stderr.trim().split("\n").slice(-5).join("\n")
      reject(
        new Error(`${command} ${args[0] ?? ""} failed (${killedBy ?? `exit ${code}`})${tail ? `: ${tail}` : ""}`),
      )
    })
  })

export interface DockerImageBuilderOptions {
  /** Test seam: the process runner. `spawnRun` otherwise. */
  readonly run?: Run
  /** Where build contexts are staged. The OS temporary directory otherwise. */
  readonly tmp?: string
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const NO_SUCH_IMAGE = /No such image/i

/**
 * The real `ImageBuilder`: what `scripts/prepare-target.ts` did, as a function of a recipe. The
 * context is a git archive of the recipe's `imageContext` at its pin plus the committed
 * Dockerfile, never the working tree; the base is the recipe's, by digest; the modules the
 * commands need are asserted to resolve inside the built image, by its id.
 */
export function dockerImageBuilder(options: DockerImageBuilderOptions = {}): ImageBuilder {
  const run = options.run ?? spawnRun
  const present = async (reference: string, signal: AbortSignal): Promise<boolean> => {
    try {
      await run("docker", ["image", "inspect", "--format", "{{.Id}}", reference], { signal })
      return true
    } catch (error) {
      if (!signal.aborted && error instanceof Error && NO_SUCH_IMAGE.test(error.message)) return false
      throw error
    }
  }
  return {
    async build({ recipe, platform, tag, repositoryRoot: repo }, log, signal) {
      const problem = recipeProblem(recipe, repo)
      if (problem !== undefined) throw new Error(problem)
      const base = recipe.baseImage
      // Pulled only when absent: pinned by digest, a present copy is the one the recipe names,
      // and a daemon whose registry path wedges (Docker Desktop, twice in the live run) is not
      // asked. This retires FACTORY_SKIP_BASE_PULL.
      if (!(await present(base, signal))) {
        log(`pulling ${base} for ${platform}\n`)
        await run("docker", ["pull", "--platform", platform, base], { signal, onOutput: log })
      }
      const context = mkdtempSync(join(options.tmp ?? tmpdir(), `factory-image-${recipe.id}-`))
      try {
        const tar = join(context, "context.tar")
        await run(
          "git",
          ["-C", repo, "archive", "--format=tar", "-o", tar, recipe.pin, "--", ...recipe.imageContext],
          { signal },
        )
        await run("tar", ["-xf", tar, "-C", context], { signal })
        rmSync(tar, { force: true })
        cpSync(join(recipe.directory, "Dockerfile"), join(context, "Dockerfile"))
        const rootPackage = JSON.parse(
          await run("git", ["-C", repo, "show", `${recipe.pin}:package.json`], { signal }),
        ) as { packageManager?: unknown }
        const pnpmVersion = String(rootPackage.packageManager ?? "").replace(/^pnpm@/, "")
        if (!/^\d+\.\d+\.\d+$/.test(pnpmVersion))
          throw new Error(`No pnpm version in package.json at ${recipe.pin}`)
        const dockerfileSha256 = sha256(readFileSync(join(recipe.directory, "Dockerfile")))
        // Over the bytes the build saw: `recipeProblem` proved the lockfile is in the context.
        const lockfileSha256 = sha256(readFileSync(join(context, recipe.lockfile)))
        await run(
          "docker",
          [
            "build",
            "--platform",
            platform,
            "--build-arg",
            `BASE_IMAGE=${base}`,
            "--build-arg",
            `PLATFORM=${platform}`,
            "--build-arg",
            `PNPM_VERSION=${pnpmVersion}`,
            "-t",
            tag,
            context,
          ],
          { signal, onOutput: log },
        )
        const localId = (
          await run("docker", ["image", "inspect", "--format", "{{.Id}}", tag], { signal })
        ).trim()
        // A frozen install can silently skip a platform-matched optional dependency, and the
        // verifier would blame the builder: the modules the commands need must resolve.
        const cwd =
          recipe.commands.cwd === "."
            ? `/opt/targets/${recipe.id}`
            : `/opt/targets/${recipe.id}/${recipe.commands.cwd}`
        for (const specifier of recipe.imageAssertResolves)
          await run(
            "docker",
            ["run", "--rm", "--network", "none", "-w", cwd, localId, "node", "-e", `require.resolve(${JSON.stringify(specifier)})`],
            { signal, onOutput: log },
          )
        return ImageSchema.parse({
          localId,
          platform,
          baseManifestDigest: baseDigestOf(base),
          dockerfileSha256,
          lockfileSha256,
          pnpmVersion,
        })
      } finally {
        rmSync(context, { recursive: true, force: true })
      }
    },
    async inspect(localId, signal) {
      try {
        const tags = JSON.parse(
          await run("docker", ["image", "inspect", "--format", "{{json .RepoTags}}", localId], { signal }),
        ) as unknown
        return {
          tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
        }
      } catch (error) {
        if (!signal.aborted && error instanceof Error && NO_SUCH_IMAGE.test(error.message)) return null
        throw error
      }
    },
    async tag(localId, tag, signal) {
      await run("docker", ["tag", localId, tag], { signal })
    },
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/image-builder.test.ts test/targets-prepare.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint`
Expected: PASS, exit 0. (If Biome reformats the long `run(...)` argument arrays, run `pnpm --filter @b4-example/software-factory-controller lint -- --write` and re-run.)

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/image-builder.ts examples/software-factory/controller/src/lib/targets/prepare.ts examples/software-factory/controller/test/image-builder.test.ts
git commit -m "feat(software-factory): the Docker image build as a cancellable function of a recipe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: The drafter is offered the targets available at the pin, and a draft fits against the recipe

Independent of images: a target is offered when its recipe applies at the pin (every path it names exists there), whether or not an image was ever built. `image_unprepared` stops being produced.

**Files:**
- Modify: `controller/src/lib/prompts.ts:141-170` (`preparedTargets` → `availableTargets`), `:189-205` (wording)
- Modify: `controller/src/lib/intake/draft.ts:1-22,53-66,245-275` (recipe; refusal)
- Modify: `controller/src/lib/controller/intake.ts:513-551` (`refuse`'s union and `final`)
- Modify: `drafter/src/app/intake/index.ts:5` (comment: "the list of available targets")
- Test: `controller/test/intake-prompt.test.ts:205-243`, `controller/test/intake-draft.test.ts:292-369`, `controller/test/factory-intake.test.ts:407-437`

- [ ] **Step 1: Write the failing tests**

`intake-prompt.test.ts`: replace the `preparedTargets` import with `availableTargets`, and the test at `:210` with:

```ts
  it("lists the targets whose recipe applies at the work order's pin, image or not, and says so", () => {
    // PIN (the shipped devkit pin) holds both targets' paths; HEAD no longer holds cli-flags'
    // fixture, which moved when the controller split from the server.
    const head = repositoryHead().pin
    const atPin = availableTargets(PIN)
    expect(atPin).toContain(targetLine(loadTargetRecipe("devkit", { pin: PIN })))
    expect(atPin).toContain(targetLine(loadTargetRecipe("cli-flags", { pin: PIN })))
    const atHead = availableTargets(head)
    expect(atHead.some((line) => line.startsWith("- `devkit`"))).toBe(true)
    expect(atHead.some((line) => line.startsWith("- `cli-flags`"))).toBe(false)
    const prompt = intakePrompt({ pin: head, issueText: ISSUE })
    expect(prompt).toContain(`checked out at ${head}`)
    expect(prompt).toContain("Available targets, those whose files exist at that commit")
    const empty = mkdtempSync(join(tmpdir(), "factory-prompt-targets-"))
    try {
      expect(intakePrompt({ pin: head, issueText: ISSUE, catalog: { targetsDir: empty } })).toContain(
        "- (none available)",
      )
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
```

(import `repositoryHead` from `./temp-repo.ts` and `loadTargetRecipe` from the catalog; the `images`-rewriting fixture of the old test goes.) Every other assertion in the file that reads `those prepared at that commit` or `(none prepared)` changes to the new wording.

`intake-draft.test.ts`: replace the tests at `:292` and `:305` with:

```ts
  it("accepts a known target at a pin no image was built at: the image is built at the fit step", () => {
    const head = repositoryHead().pin
    const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId: WO, pin: head })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.target.id).toBe("devkit")
    expect(parsed.target.pin).toBe(head)
    expect(parsed.target).not.toHaveProperty("image")
  })

  it("refuses a target whose files do not exist at the work order's pin as no_target_for_package", () => {
    const head = repositoryHead().pin
    const draft = {
      ...GOOD_DRAFT,
      "draft/task.json": GOOD_DRAFT["draft/task.json"]?.replace('"devkit"', '"cli-flags"') ?? "",
    }
    const parsed = parseDraft(files(draft), { workOrderId: WO, pin: head })
    expect(parsed).toMatchObject({ ok: false, blockedReason: "no_target_for_package" })
    if (parsed.ok) return
    expect(parsed.reason).toMatch(
      /^draft\/task\.json names target cli-flags, which is not available at [0-9a-f]{40}: Target "cli-flags" names examples\/software-factory\/server\/fixtures\/cli-flags\/project, which does not exist at /,
    )
  })
```

In the test at `:322` ("blocks as intake_run_failed … when the catalog fails the controller"), replace the two `images`-rewriting blocks: the unfetchable pin needs no image entry any more (`writeFileSync(join(dir, "devkit", "target.json"), JSON.stringify(shipped))` before the `FACTORY_NO_FETCH` block), and the closing "A target with no image at all is image_unprepared" block is deleted.

`factory-intake.test.ts`: delete the test at `:407` ("blocks image_unprepared after one attempt …"). Its replacement ("offers and fits a target at a pin no image was built at") needs `loadTask` to load at any pin, which Task 8's registry-backed catalog provides; Task 8 adds it.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/intake-prompt.test.ts test/intake-draft.test.ts test/factory-intake.test.ts`
Expected: FAIL (`availableTargets` missing; `image_unprepared` still produced; `parsed.target` absent).

- [ ] **Step 3: Implement**

`prompts.ts`: replace `preparedTargets` (`:141-170`) with

```ts
/**
 * The targets a draft at `pin` may name, one line each (`targetLine`), each followed by its
 * drafting notes (`targetNotes`): every target whose recipe applies at the pin, that is, every
 * path it names exists there (`recipeProblem`). Whether an image was ever built is not asked:
 * the controller builds it at the fit step. A target that does not apply (the `cli-flags`
 * fixture's paths moved) is left out: `parseDraft` would refuse a draft naming it.
 */
export function availableTargets(
  pin: string,
  /** Test-only: the catalog to list; the shipped one otherwise. */
  catalog: Pick<CatalogOptions, "targetsDir" | "repositoryRoot"> = {},
): string[] {
  const repo = catalog.repositoryRoot ?? repositoryRoot()
  const lines: string[] = []
  for (const id of loadTargetIds(catalog.targetsDir)) {
    let target: TargetRecipe
    try {
      target = loadTargetRecipe(id, { ...catalog, pin })
    } catch {
      continue
    }
    if (recipeProblem(target, repo) !== undefined) continue
    lines.push(targetLine(target), ...targetNotes(target))
  }
  return lines
}
```

(imports: `loadTargetRecipe`, `repositoryRoot`, `type TargetRecipe` from the catalog, `recipeProblem` from `./targets/prepare.js`; drop `loadTarget` if nothing else uses it). `targetLine` and `targetNotes` already take `Pick<Target, …>` of fields a `TargetRecipe` has; change their parameter types to `Pick<TargetRecipe, …>`. In `intakePrompt`, `const targets = availableTargets(input.pin, input.catalog)` and the two strings become:

```ts
      `The repository is under \`repo/\`, checked out at ${input.pin}. Available targets, those whose files exist at that commit (choose the one whose package the issue is about), each with its root inside the repository:`,
      ...(targets.length > 0 ? targets : ["- (none available)"]),
```

and the doc comment above `intakePrompt` says "the targets available at the work order's pin" instead of "prepared on this machine".

`draft.ts`: imports lose `ImageUnpreparedError`, `loadTarget`, `prepareCommand`; gain `loadTargetRecipe`, `type TargetRecipe`, and `recipeProblem` from `../targets/prepare.js`. `ParsedDraft` gains

```ts
  /** The drafted target at the work order's pin, without an image: intake builds that next. */
  readonly target: TargetRecipe
```

`DraftRefusal.blockedReason` loses `"image_unprepared"`. The lookup (`:245-275`) becomes:

```ts
  // Before checks.json on purpose: an unknown target, or one whose files are not at the work
  // order's pin, is the least fixable defect, so its refusal (`no_target_for_package`) wins on
  // precedence over anything a redraft could mend. Whether this host has an image of it is not
  // asked here: intake builds one at the fit step.
  let target: TargetRecipe
  try {
    target = loadTargetRecipe(drafted.target, { ...input.catalog, pin })
  } catch (error) {
    if (error instanceof UnknownTargetError)
      return {
        ok: false,
        reason: `${DRAFT_ROOT}task.json names target ${JSON.stringify(drafted.target)}: ${error.message}`,
        blockedReason: "no_target_for_package",
      }
    // Anything else is the controller's own trouble, not the draft's: a manifest it could
    // not read or parse (a bad edit), or a pin it could not fetch.
    return {
      ok: false,
      reason: `target ${JSON.stringify(drafted.target)} could not be loaded at ${pin}: ${error instanceof Error ? error.message : String(error)}`,
      blockedReason: "intake_run_failed",
    }
  }
  const inapplicable = recipeProblem(target, input.catalog?.repositoryRoot ?? repositoryRoot())
  if (inapplicable !== undefined)
    return {
      ok: false,
      reason: `${DRAFT_ROOT}task.json names target ${target.id}, which is not available at ${pin}: ${inapplicable}`,
      blockedReason: "no_target_for_package",
    }
```

and the success return adds `target`. `repositoryRoot` is already imported.

`controller/intake.ts` `refuse`: the `refusal` parameter's union drops `"image_unprepared"`, `final` is `refusal === "no_target_for_package"`, and its doc comment drops "or an `image_unprepared`".

`states.ts`: leave `"image_unprepared"` in `BLOCKED_REASONS` with its comment changed to: `// Retired (images are built when first needed); kept because rows blocked before that carry it and the row schema is an enum.`

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0. (`cli.test.ts:576`'s comment about a "prepared target" may stay; its assertion is about `no_target_for_package`.)

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/prompts.ts examples/software-factory/controller/src/lib/intake/draft.ts examples/software-factory/controller/src/lib/controller/intake.ts examples/software-factory/controller/src/lib/domain/states.ts examples/software-factory/drafter/src/app/intake/index.ts examples/software-factory/controller/test/intake-prompt.test.ts examples/software-factory/controller/test/intake-draft.test.ts examples/software-factory/controller/test/factory-intake.test.ts
git commit -m "feat(software-factory): the drafter is offered every target available at the pin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: The runtime opens the registry; the configuration's new and retired variables

**Files:**
- Modify: `controller/src/lib/config.ts` (`EnvSchema`, `FactoryConfig`, `RETIRED` `:129-152`, the returned object `:185-205`)
- Modify: `controller/src/lib/targets/catalog.ts` (add `configureImages`, `configuredImages`)
- Modify: `controller/src/lib/runtime.ts` (`ControllerRuntimeOverrides`, `openFactory`, `dispose`)
- Modify: `controller/test/serve-controller.ts` (pass the configured registry through)
- Test: `controller/test/config.test.ts`, `controller/test/runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

`config.test.ts` (use the file's existing base environment helper, `baseEnv()`):

```ts
  it("reads the image build limit and timeout, defaulting to one build and thirty minutes", () => {
    const defaults = loadConfig(baseEnv())
    expect(defaults.imagesPath).toBe(join(defaults.stateDir, "images.sqlite"))
    expect(defaults.maxImageBuilds).toBe(1)
    expect(defaults.imageBuildTimeoutMs).toBe(1_800_000)
    const set = loadConfig({
      ...baseEnv(),
      FACTORY_MAX_IMAGE_BUILDS: "2",
      FACTORY_IMAGE_BUILD_TIMEOUT_MS: "2700000",
    })
    expect(set.maxImageBuilds).toBe(2)
    expect(set.imageBuildTimeoutMs).toBe(2_700_000)
    expect(() => loadConfig({ ...baseEnv(), FACTORY_MAX_IMAGE_BUILDS: "0" })).toThrow(
      /FACTORY_MAX_IMAGE_BUILDS must be a positive integer/,
    )
  })

  it("refuses the variables the prepare script retired", () => {
    expect(() => loadConfig({ ...baseEnv(), FACTORY_TARGETS_DIR: "/x" })).toThrow(
      /FACTORY_TARGETS_DIR is retired/,
    )
    expect(() => loadConfig({ ...baseEnv(), FACTORY_SKIP_BASE_PULL: "1" })).toThrow(
      /FACTORY_SKIP_BASE_PULL is retired/,
    )
  })
```

`runtime.test.ts`:

```ts
  it("opens the image registry under the state directory, configures the catalog with it, and restores on dispose", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const before = configuredImages()
    const runtime = createControllerRuntime({
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
    })
    await runtime.factory()
    expect(existsSync(join(dir, "state", "images.sqlite"))).toBe(true)
    expect(configuredImages()).not.toBe(before)
    await runtime.dispose()
    expect(configuredImages()).toBe(before)
  })

  it("uses an injected image registry and leaves it open", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const images = staticImageRegistry()
    const runtime = createControllerRuntime(
      {
        FACTORY_WORKER_URL: fake.baseUrl,
        FACTORY_STATE_DIR: join(dir, "state"),
        FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
      },
      { images },
    )
    await runtime.factory()
    expect(configuredImages()).toBe(images)
    expect(existsSync(join(dir, "state", "images.sqlite"))).toBe(false)
    await runtime.dispose()
  })
```

(`configuredImages` from the catalog; `staticImageRegistry` from `./static-images.ts`, which Task 9 Step 1 gives in full: write that file now and commit it here.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/config.test.ts test/runtime.test.ts`
Expected: FAIL (`imagesPath` undefined; the retired variables accepted; `configuredImages` missing).

- [ ] **Step 3: Implement**

`config.ts`: `EnvSchema` gains

```ts
  FACTORY_MAX_IMAGE_BUILDS: positiveInt("FACTORY_MAX_IMAGE_BUILDS"),
  FACTORY_IMAGE_BUILD_TIMEOUT_MS: positiveInt("FACTORY_IMAGE_BUILD_TIMEOUT_MS"),
```

`FactoryConfig` gains

```ts
  /** The host's image registry: `<stateDir>/images.sqlite`. */
  readonly imagesPath: string
  /** Image builds running at once across every target and pin. Default 1. */
  readonly maxImageBuilds: number
  /** One image build's limit, from when it starts. Default 30 minutes. */
  readonly imageBuildTimeoutMs: number
```

`RETIRED` gains

```ts
  FACTORY_TARGETS_DIR:
    "target.json is never written any more (images live in <FACTORY_STATE_DIR>/images.sqlite), so there is no copy to point at",
  FACTORY_SKIP_BASE_PULL:
    "the base image is pinned by digest in target.json and pulled only when the daemon lacks it",
```

and the returned object gains

```ts
    imagesPath: join(e.FACTORY_STATE_DIR, "images.sqlite"),
    maxImageBuilds: e.FACTORY_MAX_IMAGE_BUILDS ?? DEFAULT_MAX_IMAGE_BUILDS,
    imageBuildTimeoutMs: e.FACTORY_IMAGE_BUILD_TIMEOUT_MS ?? DEFAULT_IMAGE_BUILD_TIMEOUT_MS,
```

(import both defaults from `./targets/images.js`).

`catalog.ts`, after `resetCatalogForTests`:

```ts
/**
 * The host's image registry, which `loadTarget` reads a target's image from (a SQLite read,
 * never Docker) and the factory builds through. Process-wide like the task search path: the
 * runtime configures it once per process, and the test setup files configure a static one
 * (unit) or the lanes' shared one (Docker).
 */
let images: ImageRegistry | undefined
export function configureImages(registry: ImageRegistry | undefined): void {
  images = registry
}
export function configuredImages(): ImageRegistry | undefined {
  return images
}
```

with `import type { ImageRegistry } from "./images.js"` at the top (type-only: `images.ts` imports catalog values, and a runtime cycle must not form).

`runtime.ts`: `ControllerRuntimeOverrides` gains, beside `readers`,

```ts
  /** Replaces the registry the runtime would open at `<stateDir>/images.sqlite`; left open on dispose. */
  readonly images?: ImageRegistry
```

`openFactory` destructures `const { readers, images: injected, ...factoryOverrides } = overrides` and, right after `configureCatalog(…)`:

```ts
    // The host's images: opened here (or injected by a test), and configured process-wide so
    // every `loadTarget` reads the image recorded for its recipe. Restored on dispose.
    previousImages = configuredImages()
    images =
      injected ??
      openImageRegistry({
        path: config.imagesPath,
        builder: dockerImageBuilder(),
        maxConcurrentBuilds: config.maxImageBuilds,
        buildTimeoutMs: config.imageBuildTimeoutMs,
      })
    ownsImages = injected === undefined
    configureImages(images)
```

with `let images: ImageRegistry | undefined`, `let ownsImages = false` and `let previousImages: ImageRegistry | undefined` declared beside `let opening`. `dispose` becomes:

```ts
    async dispose() {
      disposed = true
      const factory = await opening?.catch(() => undefined)
      await factory?.close()
      if (images !== undefined) {
        if (configuredImages() === images) configureImages(previousImages)
        if (ownsImages) images.close()
        images = undefined
      }
    },
```

and the `.catch` that clears `opening` on a failed open also runs the same restore-and-close (a failed open must not leave a registry configured or open). The factory needs no option for it: it builds through `configuredImages()`, the same registry `loadTarget` reads (Task 11), so the two can never be different registries.

`test/serve-controller.ts`: where it calls `resetControllerRuntimeForTests(overrides)`, pass `{ images: configuredImages(), ...overrides }` so a served controller in the unit suite reads the static registry and in the lanes the shared one, never a Docker registry of its own.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/config.test.ts test/runtime.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/config.ts examples/software-factory/controller/src/lib/targets/catalog.ts examples/software-factory/controller/src/lib/runtime.ts examples/software-factory/controller/test/serve-controller.ts examples/software-factory/controller/test/static-images.ts examples/software-factory/controller/test/config.test.ts examples/software-factory/controller/test/runtime.test.ts
git commit -m "feat(software-factory): the controller opens the host's image registry under its state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: `target.json` carries no images; `loadTarget` reads the registry; the script only warms it

The switch. After this task no file in the repository records an image id, and nothing but the registry does.

**Files:**
- Modify: `controller/src/lib/targets/catalog.ts` (schema; `loadTarget`; errors; `loadTaskTargetRecipe`; `targetsDir`)
- Modify: `controller/src/lib/targets/prepare.ts` (delete `withImageAt`, `formatManifest`, `recordImage` and their imports)
- Modify: `controller/scripts/prepare-target.ts` (rewrite)
- Modify: `controller/targets/{cli,cli-flags,devkit}/target.json` (delete `images`)
- Create: `controller/test/static-images.ts` (if Task 8 did not), `controller/test/setup-images.ts`, `controller/test/lane-images.ts`, `controller/test/lane-images.global.ts`, `controller/test/setup-lane-images.ts`
- Modify: `controller/vitest.config.ts`, `controller/vitest.sandbox.config.ts`, `controller/test/recipe-fixture.ts`
- Modify: `controller/test/devkit-second-pin.ts`, `controller/test/target-devkit-pin.integration.test.ts`, `controller/test/builder.integration.test.ts:290-300`
- Test: `controller/test/targets-catalog.test.ts:247-330,383-447`, `controller/test/targets-prepare.test.ts:136-245`, `controller/test/task-prompts.test.ts:60-100,250-280`, `controller/test/intake-draft.test.ts:305-369`, `controller/test/factory-intake.test.ts`

- [ ] **Step 1: The test registries**

`test/static-images.ts`:

```ts
import { createHash } from "node:crypto"
import { configuredImages, configureImages, type Image, tagFor } from "../src/lib/targets/catalog.ts"
import {
  baseDigestOf,
  dockerfileSha256Of,
  ImagePrepareError,
  type ImageRegistry,
  type RecordedImage,
  recipeKey,
} from "../src/lib/targets/images.ts"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/**
 * The unit suite's registry: every target at every pin has an image, synthesised from its
 * recipe (the local id is `sha256:<recipe key>`), and nothing touches Docker. So `loadTarget`
 * loads everywhere a unit test reaches, and two recipes never share an image.
 */
export function staticImageRegistry(platform = "linux/arm64"): ImageRegistry {
  const answer = (recipe: Parameters<ImageRegistry["recorded"]>[0]): RecordedImage => {
    const dockerfileSha256 = dockerfileSha256Of(recipe)
    const key = recipeKey(recipe, platform, dockerfileSha256)
    const image: Image = {
      localId: `sha256:${key}`,
      platform,
      baseManifestDigest: baseDigestOf(recipe.baseImage),
      dockerfileSha256,
      lockfileSha256: sha(`${recipe.pin}:${recipe.lockfile}`),
      pnpmVersion: "10.33.0",
    }
    return { key, tag: tagFor(recipe.id, recipe.pin, dockerfileSha256), image }
  }
  return {
    recorded: answer,
    async ensure(recipe, { signal }) {
      signal.throwIfAborted()
      return answer(recipe)
    },
    close() {},
  }
}

/** A registry that has built nothing and cannot build: `loadTarget` finds no image anywhere. */
export function emptyImageRegistry(): ImageRegistry {
  return {
    recorded: () => undefined,
    async ensure(recipe) {
      throw new ImagePrepareError(`Target ${recipe.id} at ${recipe.pin}: this test builds nothing`, "", "")
    },
    close() {},
  }
}

/** Configure `registry` process-wide; the returned function puts the previous one back. */
export function useImages(registry: ImageRegistry): () => void {
  const previous = configuredImages()
  configureImages(registry)
  return () => configureImages(previous)
}
```

`test/setup-images.ts`:

```ts
import { configureImages } from "../src/lib/targets/catalog.ts"
import { staticImageRegistry } from "./static-images.ts"

// Every unit test file starts with a registry that has an image of every recipe and no Docker.
configureImages(staticImageRegistry())
```

`vitest.config.ts` gains `setupFiles: ["test/setup-images.ts"],` inside `test`.

`test/lane-images.ts`:

```ts
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configuredImages, loadTargetRecipe } from "../src/lib/targets/catalog.ts"
import { dockerImageBuilder } from "../src/lib/targets/image-builder.ts"
import { type EnsuredImage, type ImageRegistry, openImageRegistry } from "../src/lib/targets/images.ts"

/**
 * One registry for a whole `test:sandbox` run, shared by every lane file: what CI's two
 * `target:prepare` steps used to produce, now built through the same `ensure` the controller
 * calls. `FACTORY_LANE_IMAGES_DIR` moves it; a fresh temporary directory otherwise.
 */
export const LANE_IMAGES_DIR =
  process.env.FACTORY_LANE_IMAGES_DIR ?? join(tmpdir(), "b4-factory-lane-images")

export function openLaneImages(): ImageRegistry {
  mkdirSync(LANE_IMAGES_DIR, { recursive: true })
  return openImageRegistry({
    path: join(LANE_IMAGES_DIR, "images.sqlite"),
    builder: dockerImageBuilder(),
    buildTimeoutMs: 1_140_000,
  })
}

/** Build (or re-verify) `targetId` at `pin` (its default pin when absent) in the lanes' registry. */
export async function ensureLaneImage(targetId: string, pin?: string): Promise<EnsuredImage> {
  const registry = configuredImages()
  if (registry === undefined) throw new Error("the lane setup did not configure an image registry")
  return await registry.ensure(loadTargetRecipe(targetId, pin !== undefined ? { pin } : {}), {
    signal: AbortSignal.timeout(1_200_000),
    onBuild: () => process.stderr.write(`lane: building ${targetId}${pin ? ` at ${pin}` : ""}\n`),
  })
}
```

`test/lane-images.global.ts`:

```ts
import { loadTargetRecipe } from "../src/lib/targets/catalog.ts"
import { openLaneImages } from "./lane-images.ts"

/**
 * Before any lane file: the two targets the lanes run at their default pins, built (or
 * re-verified) once. A lane that needs another pin calls `ensureLaneImage` itself.
 */
export default async function setup(): Promise<void> {
  const registry = openLaneImages()
  try {
    for (const id of ["cli-flags", "devkit"]) {
      const started = Date.now()
      const ensured = await registry.ensure(loadTargetRecipe(id), {
        signal: AbortSignal.timeout(1_200_000),
      })
      process.stderr.write(
        `lane images: ${id} ${ensured.image.localId} (${ensured.build ? `built in ${Date.now() - started} ms` : "recorded"})\n`,
      )
    }
  } finally {
    registry.close()
  }
}
```

`test/setup-lane-images.ts`:

```ts
import { configureImages } from "../src/lib/targets/catalog.ts"
import { openLaneImages } from "./lane-images.ts"

configureImages(openLaneImages())
```

`vitest.sandbox.config.ts` gains, inside `test`:

```ts
    globalSetup: ["test/lane-images.global.ts"],
    setupFiles: ["test/setup-lane-images.ts"],
```

- [ ] **Step 2: Write the failing tests**

`targets-catalog.test.ts`: the fixture `manifest()` loses `images: { [pin]: image }`; the import list loses `ImageUnpreparedError`, `TargetUnpreparedError`, gains `configureImages`, `ImageNotBuiltError`, `ImagesUnconfiguredError`, `loadTaskTargetRecipe`, `type TargetRecipe`; add `import { emptyImageRegistry, useImages } from "./static-images.ts"` and `import type { ImageRegistry } from "../src/lib/targets/images.ts"`. Replace the four tests at `:247-320` with:

```ts
  /** A registry answering every recipe with `answer(recipe)`, recording the pins it was asked. */
  function lookup(answer: (recipe: TargetRecipe) => typeof image | undefined) {
    const asked: string[] = []
    const registry: ImageRegistry = {
      recorded(recipe) {
        asked.push(recipe.pin)
        const found = answer(recipe)
        return found === undefined ? undefined : { key: "k", tag: "t", image: found }
      },
      async ensure() {
        throw new Error("unused")
      },
      close() {},
    }
    return { registry, asked }
  }

  it("reads a target's image from the configured registry, at the pin asked for", () => {
    const { root, first, second } = twoCommitRepo()
    const dir = targetsDir(first)
    const other = { ...image, localId: `sha256:${"9".repeat(64)}`, dockerfileSha256: "8".repeat(64) }
    const { registry, asked } = lookup((recipe) => (recipe.pin === first ? image : other))
    const restore = useImages(registry)
    try {
      expect(loadTarget("t", { targetsDir: dir, repositoryRoot: root }).image).toEqual(image)
      const atSecond = loadTarget("t", { targetsDir: dir, repositoryRoot: root, pin: second })
      expect(atSecond.image).toEqual(other)
      expect(imageTag(atSecond)).toBe(`b4-factory-t:${second.slice(0, 12)}-${"8".repeat(12)}`)
      expect(asked).toEqual([first, second])
    } finally {
      restore()
    }
  })

  it("names who builds an image the registry does not hold, and refuses to load without a registry", () => {
    const { root, pin } = repo()
    const dir = targetsDir(pin)
    const restoreEmpty = useImages(emptyImageRegistry())
    try {
      let caught: unknown
      try {
        loadTarget("t", { targetsDir: dir, repositoryRoot: root })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ImageNotBuiltError)
      expect(caught).toMatchObject({ targetId: "t", pin })
      expect(String((caught as Error).message)).toBe(
        `Target t has no image built at ${pin} on this host yet: the controller builds it when a work order first needs it (or warm it with pnpm --filter @b4-example/software-factory-controller target:prepare t --pin ${pin})`,
      )
      // The recipe loads regardless: nothing about it needs an image.
      expect(loadTargetRecipe("t", { targetsDir: dir, repositoryRoot: root }).pin).toBe(pin)
    } finally {
      restoreEmpty()
    }
    const restoreNone = useImages(undefined as unknown as ImageRegistry)
    try {
      expect(() => loadTarget("t", { targetsDir: dir, repositoryRoot: root })).toThrow(
        ImagesUnconfiguredError,
      )
    } finally {
      restoreNone()
    }
  })

  it("refuses a target.json that still records images, saying where they live now", () => {
    const { pin } = repo()
    for (const key of ["image", "images"]) {
      const result = TargetSchema.safeParse({ ...manifest(pin), [key]: key === "image" ? image : { [pin]: image } })
      expect(result.success).toBe(false)
      // The one issue: a preprocess issue stops the parse before the strict shape's own.
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([
        `"${key}" is retired: images are built when a work order first needs them and recorded in <FACTORY_STATE_DIR>/images.sqlite, never in the target. Delete the key`,
      ])
    }
  })

  it("gives two pins with identical image inputs two environment identities", () => {
    const { root, first, second } = twoCommitRepo()
    const dir = targetsDir(first)
    const restore = useImages(lookup(() => image).registry)
    try {
      const a = loadTarget("t", { targetsDir: dir, repositoryRoot: root, pin: first })
      const b = loadTarget("t", { targetsDir: dir, repositoryRoot: root, pin: second })
      expect(environmentIdentity(a)).not.toBe(environmentIdentity(b))
    } finally {
      restore()
    }
  })

  it("loads a task's target recipe at the task's pin without an image", () => {
    const restore = useImages(emptyImageRegistry())
    try {
      const recipe = loadTaskTargetRecipe("devkit-spawn-deadline")
      expect(recipe.id).toBe("devkit")
      expect(recipe).not.toHaveProperty("image")
      expect(() => loadTask("devkit-spawn-deadline")).toThrow(ImageNotBuiltError)
    } finally {
      restore()
    }
  })
```

(`useImages(undefined as unknown as ImageRegistry)` is how the test clears the configuration; `configureImages(undefined)` is the same.) In `describe("shipped manifests")` replace the `images` block (`:399-412`) with:

```ts
        // No image is recorded in the repository: images are this host's (plan D3).
        const raw = JSON.parse(readFileSync(join(directory, "target.json"), "utf8"))
        expect(raw).not.toHaveProperty("image")
        expect(raw).not.toHaveProperty("images")
        expect(existsSync(join(directory, "Dockerfile"))).toBe(true)
```

`targets-prepare.test.ts`: delete `describe("withImageAt")` and `describe("recordImage")` (`:136-190`) and their imports; replace the script test at `:220` with:

```ts
describe("prepare-target.ts at a pin its paths do not exist at", () => {
  it("refuses cli-flags at HEAD by the path that moved, before any build, recording nothing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "factory-prepare-state-"))
    dirs.push(stateDir)
    const shipped = readFileSync(join(targetsDir, "cli-flags", "target.json"), "utf8")
    const head = execFileSync("git", ["-C", repositoryRoot(), "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim()
    const { status, stderr } = await run(["scripts/prepare-target.ts", "cli-flags", "--pin", head], {
      ...process.env,
      PATH: pathWithoutDocker(),
      FACTORY_STATE_DIR: stateDir,
    })
    expect(status).not.toBe(0)
    expect(stderr).toContain(
      `Target "cli-flags" names examples/software-factory/server/fixtures/cli-flags/project, which does not exist at ${head}: it cannot be prepared at that pin`,
    )
    // Nothing recorded, and the target file untouched: the script never writes it any more.
    const registry = openImageRegistry({ path: join(stateDir, "images.sqlite"), builder: fakeImageBuilder() })
    try {
      expect(registry.recorded(loadTargetRecipe("cli-flags", { pin: head }))).toBeUndefined()
    } finally {
      registry.close()
    }
    expect(readFileSync(join(targetsDir, "cli-flags", "target.json"), "utf8")).toBe(shipped)
  }, 90_000)

  it("requires FACTORY_STATE_DIR and refuses the retired variables by name", async () => {
    const env = { ...process.env, PATH: pathWithoutDocker() }
    delete env.FACTORY_STATE_DIR
    expect((await run(["scripts/prepare-target.ts", "devkit"], env)).stderr).toContain(
      "FACTORY_STATE_DIR is required",
    )
    for (const name of ["FACTORY_TARGETS_DIR", "FACTORY_SKIP_BASE_PULL"])
      expect(
        (await run(["scripts/prepare-target.ts", "devkit"], { ...env, FACTORY_STATE_DIR: "/tmp/x", [name]: "1" })).stderr,
      ).toContain(`${name} is retired`)
  }, 90_000)
})
```

`task-prompts.test.ts`: `catalogs()` loses its `prepared` flag (both targets get `baseImage: \`node:24-slim@sha256:${"e".repeat(64)}\`` and no `images`); the tests that distinguished `ready` from `raw` (`:79`, `:250-280`) configure `useImages(emptyImageRegistry())` for the `raw` case instead of deleting `images` from the manifest, and expect the message `/^Unknown task served: .*has no image built at/` in place of `has not been prepared`; restoring the static registry (the `restore()` the helper returns) is what "prepared again" becomes. Task 13 rewrites this test once `dispatch` builds.

`intake-draft.test.ts` (`:305-369`): the "looks the target up in the catalog it is given" test writes the shipped manifest without `images` and proves the catalog is honoured by capture instead: a copy whose `capture.include` gains `"packages/devkit/no-such-dir"` is refused `no_target_for_package` at `PIN`, the unmodified copy is accepted. In the "catalog fails the controller" test the unfetchable pin's manifest is `JSON.stringify(shipped)` (no images).

`factory-intake.test.ts`: add the test Task 7 deferred:

```ts
  it("offers and fits a target at a pin no image was built at", async () => {
    await boot({}, { maxIntakeAttempts: 2 })
    const head = repositoryHead().pin
    expect(head).not.toBe(PIN)
    const { id } = await factory.createFromIssue({ origin: ORIGIN, pin: head, issue: ISSUE })
    expect(await factory.intake(id)).toMatchObject({ ok: true, state: "intake_running" })
    const threadId = (factory.show(id) as WorkOrderRow).workerThreadId as string
    reader.set(threadId, GOOD_DRAFT)
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({ state: "awaiting_intake_approval", targetId: "devkit" })
    expect(promptOf(0)).toContain("- `devkit`")
    expect(refusals(id)).toHaveLength(0)
  })
```

`recipe-fixture.ts`: drop the `images` destructure and the cast (`const shipped = TargetSchema.parse(…)` spreads straight into the recipe).

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/targets-catalog.test.ts test/targets-prepare.test.ts`
Expected: FAIL (`images` still accepted; `ImageNotBuiltError` missing; the script still writes the target).

- [ ] **Step 4: Implement**

`catalog.ts`:

- `targetsDir` becomes `export const targetsDir = join(appRoot, "targets")`, its comment saying the catalog is always the app's own (the only writer of a copy, the old prepare script, is gone).
- Delete `images` from `TargetObjectSchema` and `migrateSingleImage`; `TargetSchema` becomes:

```ts
/**
 * `target.json` records no image: images are this host's, built when a work order first needs
 * them and kept in the registry. A manifest still carrying 3a's `image` or 3b's `images` (a
 * local `target:prepare` from before, an unrebased branch) is refused by name, so the fix
 * is obvious rather than an "unrecognized key".
 */
export const TargetSchema = z.preprocess((raw, ctx) => {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw))
    for (const key of ["image", "images"])
      if (Object.hasOwn(raw, key))
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `"${key}" is retired: images are built when a work order first needs them and recorded in <FACTORY_STATE_DIR>/images.sqlite, never in the target. Delete the key`,
        })
  return raw
}, TargetObjectSchema)
```

- `TargetRecipe` becomes `export interface TargetRecipe extends TargetManifest { readonly directory: string }`, and `loadTargetRecipe` returns `{ ...manifest, pin, directory }` (no `images` to strip).
- Delete `prepareCommand`, `ImageUnpreparedError`, `TargetUnpreparedError`; add:

```ts
/** `loadTarget` ran in a process that never configured an image registry (`configureImages`). */
export class ImagesUnconfiguredError extends Error {
  constructor() {
    super(
      "No image registry is configured: the controller runtime (or a test's setup file) calls configureImages before a target is loaded with its image",
    )
    this.name = "ImagesUnconfiguredError"
  }
}

/**
 * No image of the target's recipe at the pin is recorded on this host. Not an operator's to
 * mend: the controller builds it when a work order first needs it (intake's fit step,
 * `dispatch`); `target:prepare` can warm it by hand.
 */
export class ImageNotBuiltError extends Error {
  constructor(
    readonly targetId: string,
    readonly pin: string,
  ) {
    super(
      `Target ${targetId} has no image built at ${pin} on this host yet: the controller builds it when a work order first needs it (or warm it with pnpm --filter @b4-example/software-factory-controller target:prepare ${targetId} --pin ${pin})`,
    )
    this.name = "ImageNotBuiltError"
  }
}
```

- `loadTarget` becomes:

```ts
/**
 * `id` at `options.pin` with the image this host recorded for its recipe there. Synchronous and
 * Docker-free (a registry read): it runs in prompts, budget checks, policies and every
 * `loadTask`. Only `ImageRegistry.ensure`, which the factory calls at a work order's first need,
 * builds or re-verifies.
 */
export function loadTarget(id: string, options: CatalogOptions = {}): Target {
  const recipe = loadTargetRecipe(id, options)
  if (images === undefined) throw new ImagesUnconfiguredError()
  const recorded = images.recorded(recipe)
  if (recorded === undefined) throw new ImageNotBuiltError(recipe.id, recipe.pin)
  return { ...recipe, image: recorded.image }
}
```

- After `loadTask`, add:

```ts
/**
 * The target a task runs on, at the task's pin (its target's default for a shipped task),
 * without an image: what `dispatch` builds before `loadTask`, which needs the image, can load.
 */
export function loadTaskTargetRecipe(id: string, options: CatalogOptions = {}): TargetRecipe {
  const directory = taskDirectory(id, options)
  const manifest = parseTaskFile(
    TaskSchema,
    JSON.parse(readFileSync(join(directory, "task.json"), "utf8")),
    id,
    "task.json",
  )
  if (manifest.id !== id) throw new Error(`Task ${id} declares a different id: ${manifest.id}`)
  return loadTargetRecipe(
    manifest.target,
    manifest.pin !== undefined ? { ...options, pin: manifest.pin } : options,
  )
}
```

(the `images` variable Task 8 declared must be declared above `loadTarget`; move the block if Task 8 put it lower).

`prepare.ts`: delete `withImageAt`, `formatManifest`, `recordImage`, and the imports only they used (`writeFileAtomic`, `appRoot`, `type Image`, `TargetSchema`).

Each `targets/<id>/target.json`: delete the `images` object (and the comma before it).

`scripts/prepare-target.ts`, whole:

```ts
import { join } from "node:path"
import { environmentIdentity, loadTargetRecipe } from "../src/lib/targets/catalog.js"
import { dockerImageBuilder } from "../src/lib/targets/image-builder.js"
import { ImagePrepareError, openImageRegistry } from "../src/lib/targets/images.js"
import { parsePrepareArgs } from "../src/lib/targets/prepare.js"

/**
 * Warm this host's image registry: build (or re-verify) a target's image at a pin, exactly as
 * the controller does the first time a work order needs it, into
 * `<FACTORY_STATE_DIR>/images.sqlite`. Optional: nothing requires it. Writes nothing under the
 * target; the image is recorded in the registry the controller reads, never in `target.json`.
 *
 * `prepare-target.ts <id> [--pin <sha>]`: the target's default pin unless `--pin` names another.
 * Prints the recorded image as JSON on stdout; the build's output goes to stderr.
 */
const RETIRED: Readonly<Record<string, string>> = {
  FACTORY_TARGETS_DIR: "the script writes no target file, so there is no copy to point it at",
  FACTORY_SKIP_BASE_PULL:
    "the base is pinned by digest in target.json and pulled only when the daemon lacks it",
}
for (const [name, why] of Object.entries(RETIRED))
  if (process.env[name] !== undefined) throw new Error(`${name} is retired: ${why}. Unset it`)
const stateDir = process.env.FACTORY_STATE_DIR
if (!stateDir)
  throw new Error(
    "FACTORY_STATE_DIR is required: the image is recorded in <FACTORY_STATE_DIR>/images.sqlite, the registry the controller with that state directory reads",
  )
const args = parsePrepareArgs(process.argv.slice(2))
const recipe = loadTargetRecipe(args.id, args.pin !== undefined ? { pin: args.pin } : {})
const registry = openImageRegistry({
  path: join(stateDir, "images.sqlite"),
  builder: dockerImageBuilder(),
})
const interrupted = new AbortController()
process.once("SIGINT", () => interrupted.abort(new Error("interrupted")))
try {
  const ensured = await registry.ensure(recipe, {
    signal: interrupted.signal,
    onMissing: ({ localId }) =>
      process.stderr.write(`recorded image ${localId} is gone from the daemon; rebuilding\n`),
    onBuild: () => process.stderr.write(`building ${recipe.id} at ${recipe.pin}\n`),
  })
  if (ensured.build) process.stderr.write(ensured.build.log)
  console.log(
    JSON.stringify(
      {
        key: ensured.key,
        tag: ensured.tag,
        pin: recipe.pin,
        built: ensured.build !== undefined,
        identity: environmentIdentity({ image: ensured.image, pin: recipe.pin }),
        ...ensured.image,
      },
      null,
      2,
    ),
  )
} catch (error) {
  if (error instanceof ImagePrepareError) process.stderr.write(error.log)
  throw error
} finally {
  registry.close()
}
```

`test/devkit-second-pin.ts`, whole:

```ts
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Image } from "../src/lib/targets/catalog.ts"
import { appRoot } from "../src/lib/targets/catalog.ts"

/**
 * `Release 0.10.0 (#782)` on main: after the devkit target was introduced, with every devkit
 * path the target names present. In a shallow checkout `ensurePin` fetches it by sha.
 */
export const SECOND_PIN = "bfaf0c2b3030eebb572703c8f70f0e063593b1fa"

/** What `target:prepare` prints on stdout. */
export interface PreparedImage extends Image {
  readonly key: string
  readonly tag: string
  readonly pin: string
  readonly built: boolean
  readonly identity: string
}

/**
 * Run `target:prepare devkit --pin SECOND_PIN` against a registry of its own (a fresh
 * `FACTORY_STATE_DIR`), as an operator warming a pin would. The image stays on the daemon, so a
 * later build of the same recipe is served from Docker's build cache. Requires Docker.
 */
export function prepareDevkitSecondPin(): {
  readonly stateDir: string
  readonly printed: PreparedImage
  cleanup(): void
} {
  const stateDir = mkdtempSync(join(tmpdir(), "factory-devkit-pin-state-"))
  const cleanup = () => rmSync(stateDir, { recursive: true, force: true })
  try {
    const started = Date.now()
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/prepare-target.ts", "devkit", "--pin", SECOND_PIN],
      {
        cwd: appRoot,
        env: { ...process.env, FACTORY_STATE_DIR: stateDir },
        stdio: ["ignore", "pipe", "inherit"],
        encoding: "utf8",
        timeout: 1_140_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    process.stderr.write(`target:prepare devkit --pin ${SECOND_PIN}: ${Date.now() - started} ms\n`)
    return { stateDir, printed: JSON.parse(out) as PreparedImage, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
```

`test/target-devkit-pin.integration.test.ts`: the `beforeAll` keeps `prepared = prepareDevkitSecondPin()` (timeout `1_200_000`); the first test becomes:

```ts
  it("records the image in the script's registry, never in the target, and loadTarget at that pin selects it", () => {
    expect(readFileSync(shippedPath, "utf8")).toBe(original)
    const registry = openImageRegistry({
      path: join(prepared.stateDir, "images.sqlite"),
      builder: dockerImageBuilder(),
    })
    const restore = useImages(registry)
    try {
      const atSecond = loadTarget("devkit", { pin: SECOND_PIN })
      expect(atSecond.image.localId).toBe(prepared.printed.localId)
      expect(environmentIdentity(atSecond)).toBe(prepared.printed.identity)
      expect(imageTag(atSecond)).toBe(prepared.printed.tag)
      const localId = execFileSync("docker", ["image", "inspect", prepared.printed.tag, "--format", "{{.Id}}"], {
        encoding: "utf8",
      }).trim()
      expect(localId).toBe(atSecond.image.localId)
      const lockfile = execFileSync("git", ["-C", repositoryRoot(), "show", `${SECOND_PIN}:pnpm-lock.yaml`], {
        maxBuffer: 256 * 1024 * 1024,
      })
      expect(atSecond.image.lockfileSha256).toBe(createHash("sha256").update(lockfile).digest("hex"))
      // The script's registry holds only what it built: the default pin is not in it.
      expect(() => loadTarget("devkit")).toThrow(ImageNotBuiltError)
    } finally {
      restore()
      registry.close()
    }
  })
```

and the second test ("still refuses a pin nobody prepared") is deleted: a pin nobody built is not refused any more, it is built. Imports follow (`openImageRegistry`, `dockerImageBuilder`, `useImages`, `ImageNotBuiltError`; `TargetSchema`, `targetsDir` only as still used).

`test/builder.integration.test.ts:290-300`: replace `const second = prepareDevkitSecondPin()` and `loadTarget("devkit", { targetsDir: second.targetsDir, pin: SECOND_PIN })` with `await ensureLaneImage("devkit", SECOND_PIN)` then `loadTarget("devkit", { pin: SECOND_PIN })`, delete the `second.cleanup()` call, and import `ensureLaneImage` from `./lane-images.ts` in place of `prepareDevkitSecondPin`.

Comments that say a lane "requires `target:prepare cli-flags`" (`drafter-end-to-end.integration.test.ts:47,96-98`, `intake-oracle.integration.test.ts:13-18`, `target-cli.integration.test.ts:24-36`) now say the image is built (or re-verified) by the lanes' global setup, or, for `cli`, by the test's own `ensureLaneImage("cli")` in its `beforeAll` (add that call, timeout `1_200_000`, to `target-cli.integration.test.ts`, which is opt-in and not in the global setup).

- [ ] **Step 5: Run the unit suite, the typecheck and the lint**

Run: `pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint`
Expected: PASS, exit 0. Then `git grep -n '"localId"' examples/software-factory/controller/targets` prints nothing.

- [ ] **Step 6: Run one Docker lane (Docker required)**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run --config vitest.sandbox.config.ts test/target-devkit-pin.integration.test.ts`
Expected: PASS; stderr shows `lane images: cli-flags …` and `lane images: devkit …` from the global setup, then the script's timing line.

- [ ] **Step 7: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/catalog.ts examples/software-factory/controller/src/lib/targets/prepare.ts examples/software-factory/controller/scripts/prepare-target.ts examples/software-factory/controller/targets examples/software-factory/controller/test/static-images.ts examples/software-factory/controller/test/setup-images.ts examples/software-factory/controller/test/lane-images.ts examples/software-factory/controller/test/lane-images.global.ts examples/software-factory/controller/test/setup-lane-images.ts examples/software-factory/controller/vitest.config.ts examples/software-factory/controller/vitest.sandbox.config.ts examples/software-factory/controller/test/recipe-fixture.ts examples/software-factory/controller/test/devkit-second-pin.ts examples/software-factory/controller/test/target-devkit-pin.integration.test.ts examples/software-factory/controller/test/builder.integration.test.ts examples/software-factory/controller/test/drafter-end-to-end.integration.test.ts examples/software-factory/controller/test/intake-oracle.integration.test.ts examples/software-factory/controller/test/target-cli.integration.test.ts examples/software-factory/controller/test/targets-catalog.test.ts examples/software-factory/controller/test/targets-prepare.test.ts examples/software-factory/controller/test/task-prompts.test.ts examples/software-factory/controller/test/intake-draft.test.ts examples/software-factory/controller/test/factory-intake.test.ts
git commit -m "feat(software-factory): targets record no images; the host's registry does

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: A work order's budget can be paused, and a restart resumes it

**Files:**
- Modify: `controller/src/lib/controller/context.ts` (two members)
- Modify: `controller/src/lib/controller/factory.ts` (implement them beside `transition`; add them to `ctx`)
- Modify: `controller/src/lib/controller/reconcile.ts` (`reconcileWorkOrder`, before the `switch`)
- Test: `controller/test/factory-intake.test.ts`

- [ ] **Step 1: Write the failing test**

In `factory-intake.test.ts` (it has `forceRow`, `crash` and `bootFactory`):

```ts
  it("resumes, before any rule, a budget a restart left paused", async () => {
    await boot()
    const { id } = await createIssue()
    await crash()
    // What a controller killed mid-build leaves: an active row with its clock stopped.
    forceRow(id, { state: "intake_running", activeMs: 1_234, activeStartedAt: null })
    await bootFactory()
    const events = factory.events(id)
    const resumed = events.findIndex((e) => e.type === "budget_resumed")
    expect(resumed).toBeGreaterThanOrEqual(0)
    expect(events[resumed]?.payload).toEqual({ reason: "reconcile" })
    const firstRule = events.findIndex((e, i) => i > resumed - 1 && e.type === "transition")
    expect(firstRule === -1 || firstRule > resumed).toBe(true)
    const row = factory.show(id) as WorkOrderRow
    // Still active: the clock runs. Settled: the resumed interval was banked by the transition.
    if (["intake_running", "dispatched", "running", "verifying", "exporting"].includes(row.state))
      expect(row.activeStartedAt).not.toBeNull()
    else expect(row.activeMs).toBeGreaterThanOrEqual(1_234)
  })
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-intake.test.ts -t "budget a restart left paused"`
Expected: FAIL (no `budget_resumed`).

- [ ] **Step 3: Implement**

`context.ts`, in `ControllerContext` after `transition`:

```ts
  /**
   * Stop the row's active clock while the controller builds an image for it (spec item 4:
   * build time is not the work order's). Banks the open interval and leaves `activeStartedAt`
   * null, which the budget ticker reads as nothing open. Persisted, so a restart mid-build is
   * visible and reconciliation resumes it. False when the row is not active or already paused:
   * then there is nothing for the caller to resume.
   */
  pauseBudget(id: string, reason: string): boolean
  /** Reopen a paused row's clock at now; a no-op for a row that is not active, or running. */
  resumeBudget(id: string, reason: string): void
```

`factory.ts`, after `transition`:

```ts
  const pauseBudget = (id: string, reason: string): boolean =>
    store.transaction(() => {
      const row = mustGet(id)
      if (!ACTIVE_STATES.has(row.state) || row.activeStartedAt === null) return false
      const activeMs = row.activeMs + Math.max(0, now() - Date.parse(row.activeStartedAt))
      store.update(id, row.revision, { activeMs, activeStartedAt: null }, iso())
      recordEvent(id, "budget_paused", { reason, activeMs })
      return true
    })
  const resumeBudget = (id: string, reason: string): void =>
    store.transaction(() => {
      const row = mustGet(id)
      if (!ACTIVE_STATES.has(row.state) || row.activeStartedAt !== null) return
      store.update(id, row.revision, { activeStartedAt: iso() }, iso())
      recordEvent(id, "budget_resumed", { reason })
    })
```

and `ctx` gains `pauseBudget,` and `resumeBudget,`.

`reconcile.ts`, in `reconcileWorkOrder` after the `ctx.signal.aborted` guard and before `const row = ctx.mustGet(id)`:

```ts
  // A clock paused around an image build that no tracked run will resume: the controller
  // restarted mid-build. Resumed before any rule, so an active row always accrues time and the
  // budget cannot fail open. A tracked run (the build still in flight in this process) resumes
  // its own pause; reconciliation called from inside it must not.
  const current = ctx.mustGet(id)
  if (ACTIVE_STATES.has(current.state) && current.activeStartedAt === null && !ctx.isTracked(id))
    ctx.resumeBudget(id, "reconcile")
```

(import `ACTIVE_STATES` from `../domain/states.js`).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-intake.test.ts test/factory-reconcile.test.ts test/budget.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/controller/context.ts examples/software-factory/controller/src/lib/controller/factory.ts examples/software-factory/controller/src/lib/controller/reconcile.ts examples/software-factory/controller/test/factory-intake.test.ts
git commit -m "feat(software-factory): a work order's budget pauses, and a restart resumes it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: A work order's image: prepared, journalled, evidenced, bound

**Files:**
- Create: `controller/src/lib/controller/images.ts`
- Modify: `controller/src/lib/controller/context.ts` (`images`)
- Modify: `controller/src/lib/controller/factory.ts` (`ctx.images`)
- Test: `controller/test/work-order-images.test.ts`

- [ ] **Step 1: Write the failing test**

`test/work-order-images.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { boundImageOf } from "../src/lib/controller/images.ts"
import type { FactoryEvent } from "../src/lib/domain/work-order.ts"

const image = (n: string) => ({
  localId: `sha256:${n.repeat(64)}`,
  platform: "linux/arm64",
  baseManifestDigest: `sha256:${"b".repeat(64)}`,
  dockerfileSha256: "c".repeat(64),
  lockfileSha256: "d".repeat(64),
  pnpmVersion: "10.33.0",
})
const bound = (n: string) => ({
  targetId: "devkit",
  pin: "1".repeat(40),
  key: n.repeat(64).slice(0, 64),
  tag: "b4-factory-devkit:111111111111-cccccccccccc",
  image: image(n),
})
let seq = 0
const event = (type: string, payload: Record<string, unknown>): FactoryEvent =>
  ({ seq: ++seq, workOrderId: "wo-1", type, payload, at: new Date().toISOString() }) as FactoryEvent

describe("boundImageOf", () => {
  it("is the last image_bound in the journal, or undefined", () => {
    expect(boundImageOf([event("transition", {})])).toBeUndefined()
    const events = [event("image_bound", bound("a")), event("oracle_receipt", {}), event("image_bound", bound("e"))]
    expect(boundImageOf(events)).toEqual(bound("e"))
  })

  it("refuses a malformed binding rather than guessing", () => {
    expect(() => boundImageOf([event("image_bound", { ...bound("a"), image: { localId: "x" } })])).toThrow()
  })
})
```

(check `FactoryEvent`'s real field names in `domain/work-order.ts` and match them; the cast covers extra fields.)

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/work-order-images.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`controller/src/lib/controller/images.ts`:

```ts
import { z } from "zod"
import type { FactoryEvent } from "../domain/work-order.js"
import {
  commitSha,
  configuredImages,
  ImageSchema,
  ImagesUnconfiguredError,
  type TargetRecipe,
} from "../targets/catalog.js"
import { type EnsuredImage, ImagePrepareError, type ImageRegistry } from "../targets/images.js"
import type { ControllerContext } from "./context.js"

/**
 * The image a work order runs in, as journalled (`image_bound`): the target, the pin, the
 * registry key and tag, and the image object whose `localId` the builder and the verifier
 * must run. The LAST binding is the binding: intake rebinds on every attempt.
 */
export const BoundImageSchema = z
  .object({
    targetId: z.string().min(1),
    pin: commitSha,
    key: z.string().regex(/^[a-f0-9]{64}$/),
    tag: z.string().min(1),
    image: ImageSchema,
  })
  .strict()
export type BoundImage = z.infer<typeof BoundImageSchema>

export function boundImageOf(events: readonly FactoryEvent[]): BoundImage | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as FactoryEvent
    if (event.type === "image_bound") return BoundImageSchema.parse(event.payload)
  }
  return undefined
}

/** The registry the factory builds through: the one `loadTarget` reads, never a second one. */
export function requireImages(): ImageRegistry {
  const registry = configuredImages()
  if (registry === undefined) throw new ImagesUnconfiguredError()
  return registry
}

export type WorkOrderImage =
  | { readonly ok: true; readonly bound: BoundImage }
  | { readonly ok: false; readonly kind: "failed" | "changed" | "aborted"; readonly reason: string }

export interface PrepareWorkOrderImageOptions {
  /**
   * Intake: every attempt binds what it proves its oracle in. Dispatch: bind when nothing is
   * bound, and otherwise require the registry's image to be the one already bound.
   */
  readonly rebind: boolean
}

/**
 * The image `recipe` (a target at the work order's pin) runs in, for work order `id`: the
 * registry's recorded image re-verified on the daemon, or a build of it, sharing any build of
 * the same recipe already in flight. Journals the build (`image_prepare_started`,
 * `image_prepared`, `image_prepare_failed`, `image_prepare_aborted`, `image_missing`), stores its
 * log as evidence, pauses the work order's budget around the wait (only an active row has one
 * running), and binds the result (`image_bound`) or refuses a change (`image_changed`).
 */
export async function prepareWorkOrderImage(
  ctx: ControllerContext,
  id: string,
  recipe: TargetRecipe,
  signal: AbortSignal,
  options: PrepareWorkOrderImageOptions,
): Promise<WorkOrderImage> {
  const need = { targetId: recipe.id, pin: recipe.pin }
  const paused = ctx.pauseBudget(id, "image_prepare")
  let ensured: EnsuredImage
  try {
    ensured = await requireImages().ensure(recipe, {
      signal,
      onMissing: ({ key, localId }) => ctx.recordEvent(id, "image_missing", { ...need, key, localId }),
      onBuild: ({ key, shared }) =>
        ctx.recordEvent(id, "image_prepare_started", { ...need, key, shared }),
    })
  } catch (error) {
    if (signal.aborted) {
      ctx.recordEvent(id, "image_prepare_aborted", { ...need, reason: String(signal.reason) })
      return { ok: false, kind: "aborted", reason: "the image build was abandoned" }
    }
    const log = error instanceof ImagePrepareError ? error.log : ""
    const logDigest = log === "" ? null : (await ctx.artifacts.put(log)).digest
    const message = error instanceof Error ? error.message : String(error)
    ctx.recordEvent(id, "image_prepare_failed", {
      ...need,
      ...(error instanceof ImagePrepareError && error.key !== "" ? { key: error.key } : {}),
      error: message,
      logDigest,
    })
    return {
      ok: false,
      kind: "failed",
      reason: `the image of target ${recipe.id} at ${recipe.pin} could not be built: ${message}${logDigest === null ? "" : ` (build log: artifact ${logDigest})`}`,
    }
  } finally {
    if (paused) ctx.resumeBudget(id, "image_prepare")
  }
  if (ensured.build !== undefined) {
    const log = ensured.build.log === "" ? "(no output)\n" : ensured.build.log
    ctx.recordEvent(id, "image_prepared", {
      ...need,
      key: ensured.key,
      tag: ensured.tag,
      localId: ensured.image.localId,
      shared: ensured.build.shared,
      ms: ensured.build.ms,
      logDigest: (await ctx.artifacts.put(log)).digest,
    })
  }
  const current: BoundImage = { ...need, key: ensured.key, tag: ensured.tag, image: ensured.image }
  const bound = options.rebind ? undefined : boundImageOf(ctx.store.events(id))
  if (bound === undefined) {
    ctx.recordEvent(id, "image_bound", { ...current })
    return { ok: true, bound: current }
  }
  if (bound.key !== current.key || bound.image.localId !== current.image.localId) {
    ctx.recordEvent(id, "image_changed", {
      bound: bound.image.localId,
      boundKey: bound.key,
      current: current.image.localId,
      currentKey: current.key,
    })
    return {
      ok: false,
      kind: "changed",
      reason: `work order ${id} is bound to image ${bound.image.localId} (target ${bound.targetId} at ${bound.pin}), the one an earlier phase ran in, and this host now builds ${current.image.localId} for it: running and verifying in another image would bind two environments. Cancel it and create a new work order`,
    }
  }
  return { ok: true, bound }
}
```

`context.ts`: no new member is needed for the registry (`requireImages()` reads the process-wide one); the pause members came in Task 10.

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/work-order-images.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/controller/images.ts examples/software-factory/controller/test/work-order-images.test.ts
git commit -m "feat(software-factory): a work order's image is journalled, evidenced and bound

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Intake builds the drafted target's image at the fit step

**Files:**
- Modify: `controller/src/lib/controller/intake.ts` (`proveDraft`, after `parseDraft`)
- Modify: `controller/src/lib/domain/states.ts` (`BLOCKED_REASONS` gains `image_prepare_failed`)
- Test: `controller/test/factory-intake.test.ts`, `controller/test/states.test.ts`

- [ ] **Step 1: Write the failing tests**

In `factory-intake.test.ts`, import `fakeImageBuilder`, `openImageRegistry`, `useImages`, `createArtifactStore` (already imported) and add a helper and a `describe`:

```ts
/** A registry over a fake builder, configured process-wide for this test (the factory builds through it). */
function fakeImages(): { builder: ReturnType<typeof fakeImageBuilder>; registry: ImageRegistry; restore(): void } {
  const builder = fakeImageBuilder()
  const registry = openImageRegistry({ path: join(dir, "images.sqlite"), builder, platform: "linux/arm64" })
  const restore = useImages(registry)
  return { builder, registry, restore: () => { restore(); registry.close() } }
}
const eventsOf = (id: string, type: string) => factory.events(id).filter((e) => e.type === type)
async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error("condition never held")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("the fit step's image", () => {
  it("builds the drafted target's image, journals the build with its log, and binds it before the proof", async () => {
    await boot()
    const images = fakeImages()
    try {
      const { id } = await intake()
      const row = await factory.settleIntake(id, 20_000)
      expect(row.state).toBe("awaiting_intake_approval")
      expect(images.builder.requests).toHaveLength(1)
      const [started] = eventsOf(id, "image_prepare_started")
      const [prepared] = eventsOf(id, "image_prepared")
      const [bound] = eventsOf(id, "image_bound")
      expect(started?.payload).toMatchObject({ targetId: "devkit", pin: PIN, shared: false })
      expect(prepared?.payload).toMatchObject({ targetId: "devkit", pin: PIN, shared: false })
      const log = await createArtifactStore(join(dir, "artifacts")).read(String(prepared?.payload.logDigest))
      expect(log).toContain("building b4-factory-devkit:")
      expect(bound?.payload).toMatchObject({ targetId: "devkit", pin: PIN, image: { localId: prepared?.payload.localId } })
      const types = factory.events(id).map((e) => e.type)
      expect(types.indexOf("image_bound")).toBeLessThan(types.indexOf("oracle_receipt"))
    } finally {
      images.restore()
    }
  })

  it("builds a pin once for two work orders that need it at once", async () => {
    await boot()
    const images = fakeImages()
    images.builder.hold()
    try {
      const first = await intake()
      const { id: second } = await factory.createFromIssue({
        origin: { ...ORIGIN, number: 779 },
        pin: PIN,
        issue: ISSUE,
        operationKey: "issue:779",
      })
      await factory.intake(second)
      reader.set((factory.show(second) as WorkOrderRow).workerThreadId as string, GOOD_DRAFT)
      await until(() => eventsOf(first.id, "image_prepare_started").length === 1 && eventsOf(second, "image_prepare_started").length === 1)
      images.builder.release()
      const rows = await Promise.all([factory.settleIntake(first.id, 20_000), factory.settleIntake(second, 20_000)])
      expect(rows.map((r) => r.state)).toEqual(["awaiting_intake_approval", "awaiting_intake_approval"])
      expect(images.builder.requests).toHaveLength(1)
      const shared = [first.id, second].map((id) => eventsOf(id, "image_prepare_started")[0]?.payload.shared).sort()
      expect(shared).toEqual([false, true])
      const localIds = [first.id, second].map((id) => (eventsOf(id, "image_bound")[0]?.payload.image as { localId: string }).localId)
      expect(localIds[0]).toBe(localIds[1])
    } finally {
      images.builder.release()
      images.restore()
    }
  })

  it("blocks a failed build with its log in evidence, spends no drafter attempt, and the next work order builds again", async () => {
    await boot()
    const images = fakeImages()
    try {
      images.builder.failNext("pnpm install failed", "ERR_PNPM_OUTDATED_LOCKFILE\n")
      const { id } = await intake()
      const row = await factory.settleIntake(id, 20_000)
      expect(row).toMatchObject({ state: "blocked", blockedReason: "image_prepare_failed", intakeAttempts: 0 })
      const [failed] = eventsOf(id, "image_prepare_failed")
      expect(failed?.payload).toMatchObject({ targetId: "devkit", pin: PIN, error: `Target devkit at ${PIN}: pnpm install failed` })
      const log = await createArtifactStore(join(dir, "artifacts")).read(String(failed?.payload.logDigest))
      expect(log).toContain("ERR_PNPM_OUTDATED_LOCKFILE")
      expect(verifier.calls).toHaveLength(0)
      expect(refusals(id)).toHaveLength(0)

      const { id: next } = await factory.createFromIssue({ origin: { ...ORIGIN, number: 780 }, pin: PIN, issue: ISSUE, operationKey: "issue:780" })
      await factory.intake(next)
      reader.set((factory.show(next) as WorkOrderRow).workerThreadId as string, GOOD_DRAFT)
      expect((await factory.settleIntake(next, 20_000)).state).toBe("awaiting_intake_approval")
      expect(images.builder.requests).toHaveLength(2)
    } finally {
      images.restore()
    }
  })

  it("abandons the build when the work order is cancelled mid-build, recording nothing", async () => {
    await boot()
    const images = fakeImages()
    images.builder.hold()
    try {
      const { id } = await intake()
      await until(() => eventsOf(id, "image_prepare_started").length === 1)
      expect((await factory.cancel(id)).ok).toBe(true)
      await until(() => images.builder.aborted === 1)
      expect(factory.show(id)?.state).toBe("cancelled")
      expect(eventsOf(id, "image_prepare_aborted")).toHaveLength(1)
      expect(images.registry.recorded(loadTargetRecipe("devkit", { pin: PIN }))).toBeUndefined()
    } finally {
      images.builder.release()
      images.restore()
    }
  })

  it("does not charge the build's time to the work order's budget", async () => {
    let clock = Date.parse("2026-09-25T00:00:00.000Z")
    await bootWorker()
    await bootFactory({ now: () => clock, maxActiveMs: 1_200_000 })
    const images = fakeImages()
    images.builder.hold()
    try {
      const { id } = await intake()
      await until(() => eventsOf(id, "image_prepare_started").length === 1)
      clock += 3_600_000 // an hour of building: three times the whole budget
      images.builder.release()
      const row = await factory.settleIntake(id, 20_000)
      expect(row.state).toBe("awaiting_intake_approval")
      expect(row.activeMs).toBeLessThan(60_000)
      const types = factory.events(id).map((e) => e.type)
      expect(types.indexOf("budget_paused")).toBeLessThan(types.indexOf("image_prepare_started"))
      expect(types.indexOf("budget_resumed")).toBeGreaterThan(types.indexOf("image_prepare_started"))
    } finally {
      images.builder.release()
      images.restore()
    }
  })
})
```

(`ImageRegistry` type from `../src/lib/targets/images.ts`; `loadTargetRecipe` from the catalog.) `states.test.ts:197`'s list of reasons gains `"image_prepare_failed"`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-intake.test.ts -t "fit step's image"`
Expected: FAIL (nothing builds: no `image_prepare_started`, the static-free registry never asked).

- [ ] **Step 3: Implement**

`states.ts` `BLOCKED_REASONS`, after `"image_unprepared"`:

```ts
  // The fit step could not build the drafted target's image at the work order's pin (the log
  // is in evidence). Not the drafter's doing, so no attempt is spent; not standing either: a
  // failure is never recorded, and the next work order at the pin builds again.
  "image_prepare_failed",
```

`intake.ts`: import `prepareWorkOrderImage` from `./images.js`; in `proveDraft`, directly after the `if (!parsed.ok) { … }` block:

```ts
  // The fit step's image (spec item 4): the drafted target at the work order's pin, built now
  // if this host has none, journalled with its log, and bound to this attempt, which proves
  // its oracle in it. Its time is not the work order's (the budget is paused around it), and a
  // failure is not the drafter's: the row blocks with no attempt spent.
  const image = await prepareWorkOrderImage(ctx, id, parsed.target, signal, { rebind: true })
  if (!image.ok) {
    if (image.kind === "aborted") {
      ctx.recordEvent(id, "intake_aborted", { reason: String(signal.reason) })
      return
    }
    block(ctx, id, "image_prepare_failed", { reason: image.reason })
    return
  }
  if (!isIntake(ctx.mustGet(id).state)) return
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS. Any existing intake test that asserts the whole journal gains `image_bound` (and, under the static registry, no `image_prepare_*` events) after `draft_read`; update those expectations, nothing else.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/controller/intake.ts examples/software-factory/controller/src/lib/domain/states.ts examples/software-factory/controller/test/factory-intake.test.ts examples/software-factory/controller/test/states.test.ts
git commit -m "feat(software-factory): intake builds the drafted target's image at the fit step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Dispatch builds the task's image before anything is spent

**Files:**
- Modify: `controller/src/lib/controller/factory.ts` (`dispatch`: `const row` → `let row`, the image before `prompt`; `transition`: abort a waiting image; `imageWaitSignal`; `prepareDispatchImage`)
- Test: `controller/test/factory-dispatch.test.ts`, `controller/test/task-prompts.test.ts:250-280`

- [ ] **Step 1: Write the failing tests**

In `factory-dispatch.test.ts` (same `fakeImages`/`until`/`eventsOf` helpers as Task 12, copied into this file):

```ts
describe("the task's image at dispatch", () => {
  it("builds it while the row waits in received, then dispatches in it", async () => {
    await boot()
    const images = fakeImages()
    images.builder.hold()
    try {
      const { id } = await factory.create({ taskId: "cli-flags" })
      const dispatching = factory.dispatch(id)
      await until(() => eventsOf(id, "image_prepare_started").length === 1)
      expect(factory.show(id)?.state).toBe("received")
      images.builder.release()
      expect(await dispatching).toEqual({ ok: true, state: "dispatched", message: "Dispatched" })
      expect(images.builder.requests).toHaveLength(1)
      const [bound] = eventsOf(id, "image_bound")
      expect(bound?.payload).toMatchObject({ targetId: "cli-flags" })
      const types = factory.events(id).map((e) => e.type)
      expect(types.indexOf("image_bound")).toBeLessThan(types.indexOf("builder_source_staged"))
    } finally {
      images.builder.release()
      images.restore()
    }
  })

  it("refuses a failed build before the key is spent, and builds again on the next dispatch", async () => {
    await boot()
    const images = fakeImages()
    try {
      const { id } = await factory.create({ taskId: "cli-flags" })
      images.builder.failNext("docker build failed", "#7 ERROR: failed to solve\n")
      const refused = await factory.dispatch(id)
      expect(refused).toMatchObject({ ok: false, state: "received" })
      expect(refused.message).toMatch(/^the image of target cli-flags at [0-9a-f]{40} could not be built: .*docker build failed \(build log: artifact [0-9a-f]{64}\)$/)
      expect(fake.requests.filter((r) => r.path === "/threads")).toHaveLength(0)
      expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
      expect(images.builder.requests).toHaveLength(2)
    } finally {
      images.restore()
    }
  })

  it("abandons the build when the work order is cancelled while it waits", async () => {
    await boot()
    const images = fakeImages()
    images.builder.hold()
    try {
      const { id } = await factory.create({ taskId: "cli-flags" })
      const dispatching = factory.dispatch(id)
      await until(() => eventsOf(id, "image_prepare_started").length === 1)
      expect((await factory.cancel(id)).ok).toBe(true)
      expect(await dispatching).toMatchObject({ ok: false, state: "cancelled" })
      await until(() => images.builder.aborted === 1)
    } finally {
      images.builder.release()
      images.restore()
    }
  })

  it("refuses an image other than the one the work order bound", async () => {
    await boot()
    const images = fakeImages()
    try {
      const { id } = await factory.create({ taskId: "cli-flags" })
      const recipe = loadTaskTargetRecipe("cli-flags")
      const built = await images.registry.ensure(recipe, { signal: AbortSignal.timeout(5_000) })
      // What an earlier phase bound: the same recipe, an image this host no longer builds.
      journal(id, "image_bound", {
        targetId: "cli-flags",
        pin: recipe.pin,
        key: built.key,
        tag: built.tag,
        image: { ...built.image, localId: `sha256:${"7".repeat(64)}` },
      })
      const refused = await factory.dispatch(id)
      expect(refused).toMatchObject({ ok: false, state: "received" })
      expect(refused.message).toMatch(/is bound to image sha256:7{64} .* Cancel it and create a new work order$/)
      expect(eventsOf(id, "image_changed")[0]?.payload).toMatchObject({
        bound: `sha256:${"7".repeat(64)}`,
        current: built.image.localId,
      })
      expect(fake.requests.filter((r) => r.path === "/threads")).toHaveLength(0)
    } finally {
      images.restore()
    }
  })
})
```

with a `journal(id, type, payload)` helper beside `boot` that opens `join(dir, "registry.sqlite")` with `openRegistry`, appends through `createWorkOrderStore(db).appendEvent(id, type, payload, new Date().toISOString())` and closes (the shape of `factory-intake.test.ts`'s `journalHandoff`). Tests in this file that assert a whole journal gain `image_bound` before `builder_source_staged`.

`task-prompts.test.ts:250-280` (the test Task 9 moved onto `emptyImageRegistry`): a target with no image is no longer a refusal; replace it with the build-failure refusal and its non-replay: configure `useImages` with a fake-builder registry whose builder `failNext`s once, expect `dispatch` to refuse with `/could not be built/` in `received`, then expect the next `dispatch` (same default key) to build and succeed.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-dispatch.test.ts -t "image at dispatch"`
Expected: FAIL (no build at dispatch; `loadTask` throws `ImageNotBuiltError` inside `prompt`).

- [ ] **Step 3: Implement**

`factory.ts`, beside `phases`:

```ts
  /**
   * One per work order waiting on an image at `dispatch` (in `received`, before the key):
   * aborted by any transition that moves the row (a cancel) and by close().
   */
  const imageWaits = new Map<string, AbortController>()
  const imageWaitSignal = (id: string): AbortSignal => {
    let controller = imageWaits.get(id)
    if (!controller) {
      controller = new AbortController()
      imageWaits.set(id, controller)
    }
    return AbortSignal.any([abort.signal, controller.signal])
  }
```

In `transition`, after the `PHASE_STATES` abort:

```ts
      if (to !== row.state) {
        imageWaits.get(id)?.abort(new Error(`work order ${id} left ${row.state}`))
        imageWaits.delete(id)
      }
```

After `budgetRefusal`:

```ts
  /**
   * The image the row's task runs in, prepared (built, joined or re-verified) and bound, or the
   * refusal that says why not. Undefined also when the task does not load: `prompt` then
   * refuses it with the catalog's own reason.
   */
  async function prepareDispatchImage(id: string, row: WorkOrderRow): Promise<string | undefined> {
    let recipe: TargetRecipe
    try {
      recipe = loadTaskTargetRecipe(row.taskId, options.promptCatalog ?? {})
    } catch {
      return undefined
    }
    const result = await prepareWorkOrderImage(ctx, id, recipe, imageWaitSignal(id), {
      rebind: false,
    })
    if (result.ok) return undefined
    return result.kind === "aborted"
      ? `Work order ${id} left received while its image was being prepared`
      : result.reason
  }
```

In `dispatch`, `const row = mustGet(id)` becomes `let row = mustGet(id)`, and directly before the comment that begins "Refuse rather than send an empty prompt":

```ts
      // The image the task runs in (spec item 4), before anything is spent: built if this host
      // has none for the task's target at its pin, re-verified if it has one, and bound to the
      // work order, or refused against the image the work order already bound. The row waits
      // in `received`, which is not active, so the build costs its budget nothing; a cancel
      // abandons the wait. Before the key: a failed build is not a function of the row's
      // revision, and the dispatch after it must build again, not replay this refusal.
      if (row.state === "received" && !options.tasks) {
        const refusal = await prepareDispatchImage(id, row)
        row = mustGet(id)
        if (refusal !== undefined) return { ok: false, state: row.state, message: refusal }
        if (row.state !== "received")
          return { ok: false, state: row.state, message: `Cannot dispatch from ${row.state}` }
      }
```

(imports: `prepareWorkOrderImage` from `./images.js`; `loadTaskTargetRecipe`, `type TargetRecipe` from the catalog). The pre-key `prompt(row.taskId)` that follows now loads the task with its image.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/controller/factory.ts examples/software-factory/controller/test/factory-dispatch.test.ts examples/software-factory/controller/test/task-prompts.test.ts
git commit -m "feat(software-factory): dispatch builds the task's image before anything is spent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: `factory dispatch` follows an image build past its request timeout

A dispatch that builds holds its request for the build (minutes for `cli`), with the row in `received` at its revision: today's fallback reads that as "the request did not reach the controller" once its arrival window passes, and, had it arrived, as "settled" because `received` is not an active state. The journal can say both, if dispatch says when it ends without moving the row: `image_prepare_started` is arrival, and a dispatch that started preparing an image is working until it either moves the row (a `transition`) or refuses (`dispatch_refused`, new).

**Files:**
- Modify: `controller/src/lib/controller/images.ts` (add `dispatchPreparing`)
- Modify: `controller/src/lib/controller/factory.ts` (`dispatch` journals `dispatch_refused` for every refusal)
- Modify: `controller/src/cli.ts` (`FollowEvents` `:256-262`, `followRow` `:367-420`, the `dispatch` case `:835-845`, the usage text `:92`)
- Test: `controller/test/work-order-images.test.ts`, `controller/test/factory-dispatch.test.ts`, `controller/test/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

`work-order-images.test.ts`:

```ts
describe("dispatchPreparing", () => {
  it("is true from an image build's start until the dispatch moves the row or refuses", () => {
    expect(dispatchPreparing([])).toBe(false)
    expect(dispatchPreparing([event("image_prepare_started", {})])).toBe(true)
    // The build ending is not the dispatch ending: the thread is still to be created.
    expect(dispatchPreparing([event("image_prepare_started", {}), event("image_prepared", {}), event("image_bound", {})])).toBe(true)
    for (const end of ["transition", "dispatch_refused"])
      expect(dispatchPreparing([event("image_prepare_started", {}), event("image_prepared", {}), event(end, {})])).toBe(false)
    expect(
      dispatchPreparing([
        event("image_prepare_started", {}),
        event("dispatch_refused", {}),
        event("image_prepare_started", {}),
      ]),
    ).toBe(true)
  })
})
```

`factory-dispatch.test.ts`, in Task 13's "refuses a failed build before the key is spent" test, after the first refusal:

```ts
      const [journalled] = eventsOf(id, "dispatch_refused")
      expect(journalled?.payload).toEqual({ message: refused.message })
```

`cli.test.ts`: `boot` gains an `images?: ImageRegistry` option passed to the served controller's overrides; add, after the dispatch-follow test at `:444`:

```ts
  it("follows a dispatch that is still building its image when its request times out", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const imagesDir = mkdtempSync(join(tmpdir(), "factory-cli-images-"))
    const images = openImageRegistry({ path: join(imagesDir, "images.sqlite"), builder, platform: "linux/arm64" })
    const restore = useImages(images)
    try {
      const { env, stateDir } = await boot({ images })
      const { stdout: createdOut } = await run(process.execPath, [tsxBin, cliEntry, "create", "--task", "cli-flags"], { env, cwd: packageRoot })
      const id = JSON.parse(createdOut).row.id as string
      // The build outlives the request (500 ms) and the arrival window (1 s): only the journal
      // says the request arrived and the work goes on.
      setTimeout(() => builder.release(), 3_000)
      const { stdout, stderr } = await run(process.execPath, [tsxBin, cliEntry, "dispatch", id], {
        env: { ...env, FACTORY_CLI_REQUEST_TIMEOUT_MS: "500", FACTORY_CLI_ARRIVAL_WINDOW_MS: "1000" },
        cwd: packageRoot,
      })
      expect(stderr).toContain("the request ended before its answer")
      expect(stderr).toContain("image_prepare_started")
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, state: "awaiting_approval" })
      expect(await pollState(stateDir, id, () => true)).toBe("awaiting_approval")
    } finally {
      builder.release()
      restore()
      images.close()
      rmSync(imagesDir, { recursive: true, force: true })
    }
  }, 90_000)
```

(`useImages` makes the test's own catalog reads agree with the served controller's.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/work-order-images.test.ts test/factory-dispatch.test.ts test/cli.test.ts -t "image|dispatchPreparing"`
Expected: FAIL (`dispatchPreparing` missing; no `dispatch_refused`; the CLI answers "The request did not reach the controller").

- [ ] **Step 3: Implement**

`images.ts` (controller):

```ts
/**
 * Is a dispatch that began by preparing an image still going on, by its journal lines
 * (`events` after the caller's mark)? From `image_prepare_started` until the dispatch moves
 * the row (`transition`) or refuses (`dispatch_refused`); the build's own end is not the
 * dispatch's, which still captures, uploads and creates the thread.
 */
export function dispatchPreparing(events: readonly Pick<FactoryEvent, "type">[]): boolean {
  let preparing = false
  for (const { type } of events) {
    if (type === "image_prepare_started") preparing = true
    else if (type === "transition" || type === "dispatch_refused") preparing = false
  }
  return preparing
}
```

`factory.ts`: rename the `dispatch` method's body to a local `async function dispatchOnce(id: string, operationKey?: string): Promise<CommandOutcome>` (unchanged), and make the method

```ts
    async dispatch(id, operationKey) {
      const outcome = await dispatchOnce(id, operationKey)
      // Every refusal is journalled, so a caller that lost the request (the CLI's fallback)
      // can tell a dispatch that ended in `received` from one still preparing its image.
      if (!outcome.ok) recordEvent(id, "dispatch_refused", { message: outcome.message })
      return outcome
    },
```

(tests in `factory-dispatch.test.ts` and `task-prompts.test.ts` that assert a refused dispatch's whole journal gain `dispatch_refused` last).

`cli.ts`: `FollowEvents` becomes

```ts
interface FollowEvents {
  /** Written as the command starts: the request arrived. */
  readonly arrived: string
  /** Written when the command refuses: it is over, whatever the row's state. */
  readonly refused?: string
  /**
   * Work the command does before its row moves (a dispatch's image build): while it holds of
   * the events after the mark, the row is not settled however it looks, and the follow's
   * deadline is extended by `workingGraceMs`.
   */
  readonly working?: (events: readonly FactoryEvent[]) => boolean
  readonly workingGraceMs?: number
}
```

In `followRow`, after `journalled`:

```ts
  const working = () =>
    events?.working?.(read((reader) => reader.events(id)).filter((e) => e.seq > before.seq)) ?? false
```

and the second `pollRow` becomes

```ts
  const row = await pollRow(
    id,
    (r) =>
      r !== null &&
      ((!active.has(r.state) && !working()) || journalled(events?.refused) !== undefined),
    (r) => (r?.maxActiveMs ?? 0) + POLL_GRACE_MS + (events?.workingGraceMs ?? 0),
    1_000,
  )
```

The `dispatch` case passes as `awaiting`'s fifth argument

```ts
          {
            arrived: "image_prepare_started",
            refused: "dispatch_refused",
            working: dispatchPreparing,
            // The controller's build limit is its own configuration; the default is what an
            // operator who never set it runs with.
            workingGraceMs: DEFAULT_IMAGE_BUILD_TIMEOUT_MS,
          },
```

(imports: `dispatchPreparing` from `./lib/controller/images.js`, `DEFAULT_IMAGE_BUILD_TIMEOUT_MS` from `./lib/targets/images.js`, `type FactoryEvent` from the domain). A dispatch that builds nothing writes no `image_prepare_started`; its arrival is still read from the revision as before. Add to the usage text's `dispatch …` paragraph (`:92`): "A dispatch that first builds its target's image (the first time this host needs it) is followed through the build: its journal lines are the arrival, and `dispatch_refused` is its end when it refuses."

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/controller/images.ts examples/software-factory/controller/src/lib/controller/factory.ts examples/software-factory/controller/src/cli.ts examples/software-factory/controller/test/work-order-images.test.ts examples/software-factory/controller/test/factory-dispatch.test.ts examples/software-factory/controller/test/task-prompts.test.ts examples/software-factory/controller/test/cli.test.ts
git commit -m "feat(software-factory): the CLI follows a dispatch through its image build

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: The Docker proof: intake at an unprepared devkit pin builds it, and its identity is the script's

Spec §4's Docker proof, plus drift against a real daemon.

**Files:**
- Create: `controller/test/images-on-demand.integration.test.ts`

- [ ] **Step 1: Write the lane**

```ts
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { stagedReferenceOf } from "../src/lib/builder-handoff.ts"
import { boundImageOf } from "../src/lib/controller/images.ts"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { DrafterHandoffSchema } from "../src/lib/drafter-handoff.ts"
import { configureCatalog, environmentIdentity, loadTargetRecipe, resetCatalogForTests } from "../src/lib/targets/catalog.ts"
import { dockerImageBuilder } from "../src/lib/targets/image-builder.ts"
import { type ImageRegistry, openImageRegistry } from "../src/lib/targets/images.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { prepareDevkitSecondPin, SECOND_PIN } from "./devkit-second-pin.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { fakeBuilderHandoff, fakeWorkerMap } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"
import { GOOD_DRAFT } from "./intake-fixtures.ts"
import { useImages } from "./static-images.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

/**
 * An image built when a work order first needs it, against the real daemon: an intake at a
 * devkit pin this controller's registry has never built builds it at the fit step and binds
 * it, and the identity it records is the one `target:prepare` records for the same recipe in
 * a registry of its own (Docker's build cache makes an identical rebuild the same image).
 * The drafter, the builder and the verifier are fakes: the build is what is under test.
 *
 * Requires Docker. Runs only under `test:sandbox`.
 */
let dir: string
let drafter: FakeWorker
let builderWorker: FakeWorker
let factory: Factory
let images: ImageRegistry
let restore: () => void
let reader: FakeWorkspaceReader

const SOURCE = createSourceBundle([
  { path: "repo/README.md", bytes: new TextEncoder().encode("# fixture\n"), executable: false },
])
const captureDrafterHandoff: NonNullable<FactoryOptions["captureDrafterHandoff"]> = async ({ workOrderId }) => {
  const workspace = { version: 1 as const, source: SOURCE, environmentLinks: [] }
  return {
    handoff: DrafterHandoffSchema.parse({ version: 2, workOrderId, workspace: stagedReferenceOf(workspace) }),
    workspace,
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "factory-images-on-demand-"))
  mkdirSync(join(dir, "out"), { recursive: true })
  configureCatalog({ generatedTasksDir: join(dir, "state", "tasks") })
  // A registry of this controller's own, empty: nothing is built at SECOND_PIN in it.
  images = openImageRegistry({
    path: join(dir, "state", "images.sqlite"),
    builder: dockerImageBuilder(),
    buildTimeoutMs: 1_140_000,
  })
  restore = useImages(images)
  drafter = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
  builderWorker = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only", threadId: "b-1" })
  reader = createFakeWorkspaceReader({})
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    generatedTasksDir: join(dir, "state", "tasks"),
    captureRoot: dir,
    workers: fakeWorkerMap({
      builder: { client: createHttpWorkerClient(builderWorker.baseUrl, { token: TEST_WORKER_TOKEN }), reader },
      drafter: { client: createHttpWorkerClient(drafter.baseUrl, { token: TEST_WORKER_TOKEN }), reader },
    }),
    captureBuilderHandoff: fakeBuilderHandoff,
    captureDrafterHandoff,
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier: createFakeVerifier({ independent: "fail" }),
    captureBaseline: async () => ({ digest: "a".repeat(64), files: new Map() }),
  })
}, 120_000)

afterAll(async () => {
  await factory?.close()
  await drafter?.close()
  await builderWorker?.close()
  restore?.()
  images?.close()
  resetCatalogForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe("an image built when a work order first needs it", () => {
  it("intake at an unprepared devkit pin builds it at the fit step, and the identity equals the script's", async () => {
    const recipe = loadTargetRecipe("devkit", { pin: SECOND_PIN })
    expect(images.recorded(recipe)).toBeUndefined()
    const { id } = await factory.createFromIssue({
      origin: { kind: "issue", repository: "cacheplane/b4run", number: 9001, bodyDigest: "0".repeat(64) },
      pin: SECOND_PIN,
      issue: { title: "t", body: "b" },
    })
    expect(await factory.intake(id)).toMatchObject({ ok: true, state: "intake_running" })
    reader.set((factory.show(id) as WorkOrderRow).workerThreadId as string, GOOD_DRAFT)
    const row = await factory.settleIntake(id, 1_200_000)
    expect(row.state).toBe("awaiting_intake_approval")
    const types = factory.events(id).map((e) => e.type)
    expect(types).toContain("image_prepare_started")
    expect(types).toContain("image_prepared")
    const bound = boundImageOf(factory.events(id))
    if (bound === undefined) throw new Error("intake bound no image")
    expect(bound).toMatchObject({ targetId: "devkit", pin: SECOND_PIN })
    // The daemon holds exactly the bound image, under the recipe's tag.
    const onDaemon = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", bound.tag], {
      encoding: "utf8",
    }).trim()
    expect(onDaemon).toBe(bound.image.localId)

    // The script, on a registry of its own, records the same image for the same recipe.
    const script = prepareDevkitSecondPin()
    try {
      expect(script.printed.key).toBe(bound.key)
      expect(script.printed.localId).toBe(bound.image.localId)
      expect(script.printed.identity).toBe(environmentIdentity({ image: bound.image, pin: SECOND_PIN }))
    } finally {
      script.cleanup()
    }
  }, 1_500_000)

  it("rebuilds an image deleted from the daemon, and re-points a moved tag without rebuilding", async () => {
    const recipe = loadTargetRecipe("devkit", { pin: SECOND_PIN })
    const recorded = images.recorded(recipe)
    if (recorded === undefined) throw new Error("the first test recorded no image")
    // A moved tag: pointed back, no build.
    const base = loadTargetRecipe("devkit").baseImage
    execFileSync("docker", ["tag", base, recorded.tag])
    const again = await images.ensure(recipe, { signal: AbortSignal.timeout(60_000) })
    expect(again.build).toBeUndefined()
    expect(
      execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", recorded.tag], { encoding: "utf8" }).trim(),
    ).toBe(recorded.image.localId)
  }, 120_000)
})
```

The deleted-image half of drift is proved in the unit suite (Task 5): removing a real image here would cost a rebuild the lane budget cannot spare, and `docker rmi` of an image a concurrent lane may be using is not safe.

- [ ] **Step 2: Run the lane (Docker required)**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run --config vitest.sandbox.config.ts test/images-on-demand.integration.test.ts`
Expected: PASS. The first run on a host without the `SECOND_PIN` devkit image takes minutes; a second run is fast (cache). If `script.printed.localId` differs from the bound one, check that nothing pruned the build cache between the two builds (trap 10) before suspecting the code.

- [ ] **Step 3: Commit**

```bash
git add examples/software-factory/controller/test/images-on-demand.integration.test.ts
git commit -m "test(software-factory): an intake at an unprepared pin builds its image, identical to the script's

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: CI builds on demand: the explicit prepare steps go

**Files:**
- Modify: `.github/workflows/ci.yml:434-479`
- Modify: `scripts/release/test/fixtures/workflow-entrypoints.json`, `scripts/release/test/fixtures/workflow-safe-executables.json`

- [ ] **Step 1: Edit `ci.yml` and both fixtures with one script, in raw text**

```bash
python3 - <<'EOF'
import pathlib
edits = {
    ".github/workflows/ci.yml": [
        ("          pnpm --filter @b4-example/software-factory-controller target:prepare cli-flags\n", ""),
        ("          pnpm --filter @b4-example/software-factory-controller target:prepare devkit\n", ""),
    ],
    "scripts/release/test/fixtures/workflow-entrypoints.json": [
        ("pnpm --filter @b4-example/software-factory-controller target:prepare cli-flags\\n", ""),
        ("pnpm --filter @b4-example/software-factory-controller target:prepare devkit\\n", ""),
    ],
    "scripts/release/test/fixtures/workflow-safe-executables.json": [
        ("pnpm --filter @b4-example/software-factory-controller target:prepare cli-flags\\n", ""),
        ("pnpm --filter @b4-example/software-factory-controller target:prepare devkit\\n", ""),
    ],
}
for path, pairs in edits.items():
    file = pathlib.Path(path)
    text = file.read_text()
    for old, new in pairs:
        found = text.count(old)
        assert found == 1, f"{path}: expected 1 of {old!r}, found {found}"
        text = text.replace(old, new)
    file.write_text(text)
    print(f"{path}: edited")
EOF
git diff --stat .github/workflows/ci.yml scripts/release/test/fixtures
```

Expected: `ci.yml` 2 lines removed; each fixture exactly 1 line changed (its one `run` string). If a count is not 1, #843 or a later PR changed the step: read the current `run` block and adapt the strings, never the assertion.

Then rewrite the step's comment (`ci.yml:434-448`, the part from "`target:prepare <id>` pulls the pinned base" to "nothing in this job asserts a clean tree", and the sentence "`cli-flags` and `devkit` are prepared because the Docker lanes here cover them. The `cli` target is not:") as:

```yaml
        # The software-factory example runs its builder and its verifier in the
        # image of the TARGET a task names, not in code-fixer's fixture image.
        # Nothing prepares those images here: `test:sandbox`'s global setup
        # builds `cli-flags` and `devkit` at their default pins through the same
        # image registry the controller uses (for this runner's platform,
        # linux/amd64, on the base each target pins by digest), and a lane that
        # needs another pin builds it when it first needs it, as the controller
        # does. Nothing writes the working tree. The `cli` target is not built:
```

keeping the rest of the comment (the `cli` lane's opt-in, the builder's own `check` and `build`, the drafter's pull) as it is.

- [ ] **Step 2: The workflow audit**

Run: `node --test scripts/release/test/workflow-contracts.test.mjs && pnpm test:release-integrity`
Expected: PASS. On a failure the audit prints one opaque string; copy the repository to a scratch directory, run the fixture generator the test names against the edited `ci.yml`, diff its output with the committed fixture, and apply only the differing `run` line with the script above. The comment lines are not in the fixtures (only `run` blocks are).

Run: `pnpm test:release-controller`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml scripts/release/test/fixtures/workflow-entrypoints.json scripts/release/test/fixtures/workflow-safe-executables.json
git commit -m "ci(software-factory): the Docker lanes build target images on demand

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17: The README, the developer guide and the spec say what changed

**Files:**
- Modify: `examples/software-factory/README.md` (`:135`, `:155`, `:171`, `:283-290`, `:316`, `:630`, `:660`, `:673`, `:695`, `:703`, and every `target:prepare`)
- Modify: `docs/superpowers/runbooks/software-factory-rung2-developer-guide.md` (`:219`, `:464`, and every `target:prepare`)
- Modify: `docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md` (§4 "As landed", §7 table row)

- [ ] **Step 1: The README**

Replace the "prepare a target" instructions (`:283-290`, `:316`) with one paragraph:

> Images are built when a work order first needs them. The first intake or dispatch at a (target, pin) this host has never built builds the target's image from its committed recipe (the Dockerfile, the `imageContext` and lockfile at the pin, and the base image `target.json` pins by digest), records it in `<FACTORY_STATE_DIR>/images.sqlite`, journals the build (`image_prepare_started`, `image_prepared` with the build log's artifact digest, or `image_prepare_failed`) and binds it to the work order (`image_bound`). Concurrent work orders at one pin share one build; `FACTORY_MAX_IMAGE_BUILDS` (default 1) bounds builds across pins and `FACTORY_IMAGE_BUILD_TIMEOUT_MS` (default 30 minutes) each build. The build's time is not charged to the work order's budget. A failed build blocks an intake as `image_prepare_failed` (no drafter attempt spent) and refuses a dispatch (the row stays `received`; dispatch again to retry); the next need builds again. `target.json` records no image: `pnpm --filter @b4-example/software-factory-controller target:prepare <id> [--pin <sha>]` (with `FACTORY_STATE_DIR` set) warms the registry by hand and prints the image; nothing requires it.

Replace `:171`'s `image_unprepared` sentence with the fit step's behaviour (`image_prepare_failed`), `:155`'s "Nothing proves that image is the one `target:prepare` built" with "the tag names the image the registry recorded; PR 2 of the images plan runs it by ID", the CI paragraph (`:695`) with the global-setup build, and `:703`'s `cli` instructions with `FACTORY_TEST_CLI_TARGET=1 pnpm --filter @b4-example/software-factory-controller test:sandbox:cli` (the lane builds `cli` itself). Delete every `FACTORY_TARGETS_DIR` and `FACTORY_SKIP_BASE_PULL` mention; list both as retired where the README lists retired variables.

- [ ] **Step 2: The developer guide**

`:219` and `:464` (the `FACTORY_SKIP_BASE_PULL` workaround): the base is pinned by digest and pulled only when absent, so a wedged pull is avoided by pulling it once by hand (`docker pull --platform <platform> <baseImage>`); the variable is retired. Every `target:prepare` step becomes optional warming, with `FACTORY_STATE_DIR`.

- [ ] **Step 3: The spec**

Under §4, append:

```markdown
**As landed** ([plan](../plans/2026-09-25-images-built-on-demand.md), PR 1). `target.json`
records no image; it pins its base by digest (`baseImage`). The registry key is the recipe
digest (target, pin, platform, base, Dockerfile, `imageContext`, lockfile path, asserted
modules, commands' cwd), not the lockfile hash, which the pin already decides. Intake builds
at the fit step with the budget paused (persisted; reconciliation resumes it after a
restart); dispatch builds before its key with the row in `received`. A work order binds its
image (`image_bound`; intake rebinds each attempt) and dispatch refuses a changed one
(`image_changed`). The drafter is offered every target whose files exist at the pin. CI's
explicit prepares are gone: the lanes' global setup builds through the same registry. PR 2
runs the bound image by ID in the builder and the verifier. Deferred: the factory's own git
object store (§9 finding 3) and budgets from measured verifier time (§9 finding 5).
```

and the §7 table row "`target:prepare <id>` and `--pin <sha>` per pin | 4" stays, now true.

- [ ] **Step 4: Check the docs gate and the lint**

Run: `node scripts/check-docs.mjs && pnpm --filter @b4-example/software-factory-controller lint`
Expected: exit 0 (the README is under `examples/`, outside the banned-phrase scan, but the check is cheap).

- [ ] **Step 5: Commit, then the PR-level verification**

```bash
git add examples/software-factory/README.md docs/superpowers/runbooks/software-factory-rung2-developer-guide.md docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md
git commit -m "docs(software-factory): images are built when a work order first needs them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

PR 1 verification, all from the repository root:

| Gate | Command | Expected |
|---|---|---|
| Controller unit suite | `pnpm --filter @b4-example/software-factory-controller test` | pass |
| Typecheck, lint | `pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint` | exit 0 |
| Docker lanes | `pnpm --filter @b4-example/software-factory-controller test:sandbox` (after `pnpm turbo run build --filter=@b4-example/software-factory-controller^...` and the drafter base pull, as CI does) | pass; global setup logs both builds |
| Workflow audit | `node --test scripts/release/test/workflow-contracts.test.mjs && pnpm test:release-controller` | pass |
| No image in the repo | `git grep -n 'localId' examples/software-factory/controller/targets` | no output |
| Full local CI | `pnpm ci:validate` | exit 0 (do not pipe through `tail`) |

Push `blove/images-on-demand` and open the PR only when Brian asks.

---

# PR 2: identity by image ID

```bash
git fetch origin
git switch -c blove/images-by-id origin/main    # after PR 1 merged
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@b4-example/software-factory-controller^...
```

Closes the per-thread-sandbox plan's review follow-up (`2026-09-24-per-thread-sandbox.md:4862,4895`): the builder resolves exactly the image the controller bound, and the verifier runs exactly that image, by ID.

### Task 18: The builder handoff names the bound image by ID (version 4)

**Files:**
- Modify: `controller/src/lib/builder-handoff.ts` (schema, `isFactoryImage` → `isFactoryImageId`, `CaptureBuilderHandoffOptions`, `captureBuilderHandoff`)
- Modify: `server/src/builder-handoff.ts` (the identical schema, `isFactoryImageId`)
- Modify: `server/b4.config.ts` (`images: isFactoryImageId`)
- Modify: `controller/src/lib/controller/factory.ts` (`captureBuilderHandoff` option input gains `imageId`; `prepareDispatchImage` returns the binding; `dispatch` passes it)
- Modify: `controller/test/fake-worker-map.ts` (`fakeBuilderHandoff` writes version 4)
- Test: `controller/test/builder-handoff.test.ts`, `server/test/builder-config.test.ts`, `controller/test/targets-workspace.test.ts:170-175`, `controller/test/factory-dispatch.test.ts`

- [ ] **Step 1: Write the failing tests**

`builder-handoff.test.ts`, the first test: `captureBuilderHandoff(task, { workOrderId, captureRoot: app, imageId: task.target.image.localId })`, and

```ts
    expect(handoff.version).toBe(4)
    expect(handoff.target).toEqual({
      image: task.target.image.localId,
      tag: imageTag(task.target),
      pin: task.target.pin,
      policy: targetSandboxPolicy(task.target),
      permissions: builderPermissions(task.target),
    })
```

and a new test:

```ts
  it("names an image only by id, and its tag only as its own target's at its own pin", () => {
    const base = BuilderHandoffSchema.parse(validHandoff())   // the file's fixture handoff, now version 4
    const id = `sha256:${"a".repeat(64)}`
    expect(TheBuildersHandoffSchema.parse({ ...base, target: { ...base.target, image: id } }).target.image).toBe(id)
    for (const image of [base.target.tag, "alpine:latest", `sha256:${"a".repeat(63)}`, `b4-factory-t@sha256:${"a".repeat(64)}`])
      expect(TheBuildersHandoffSchema.safeParse({ ...base, target: { ...base.target, image } }).success, image).toBe(false)
    const otherPin = `b4-factory-${base.targetId}:${"f".repeat(12)}-0123456789ab`
    expect(TheBuildersHandoffSchema.safeParse({ ...base, target: { ...base.target, tag: otherPin } }).success).toBe(false)
    expect(isFactoryImageId(id)).toBe(true)
    expect(isFactoryImageId(base.target.tag)).toBe(false)
  })

  it("refuses to capture a handoff for an image the catalog does not record for the task", async () => {
    const task = loadTask("cli-flags")
    await expect(
      captureBuilderHandoff(task, { captureRoot: tempDir("factory-handoff-app-"), imageId: `sha256:${"7".repeat(64)}` }),
    ).rejects.toThrow(/is not the image this host records for target cli-flags/)
  })
```

(`validHandoff()` stands for the fixture handoff object the file already builds at `:110-130`, whatever its local name; it gains `version: 4`, `image: \`sha256:${"0".repeat(64)}\`` and `tag: \`b4-factory-<its target>:<its pin[:12]>-0123456789ab\``.) The schema-text equality test needs no change: it compares whatever both files hold.

`server/test/builder-config.test.ts`: the predicate string becomes `'dockerSandbox({ scope: "software-factory-builder", images: isFactoryImageId })'`; `:182-185` becomes

```ts
    const { isFactoryImageId } = await import("../src/builder-handoff.ts")
    expect(isFactoryImageId(`sha256:${"0".repeat(64)}`)).toBe(true)
    expect(isFactoryImageId("b4-factory-devkit:6a59e00aed46-0123456789ab")).toBe(false)
    expect(isFactoryImageId("alpine:latest")).toBe(false)
```

and its handoffs (`alpha`, the second target) carry `image: sha256:…` plus `tag`, with `first.environment` expected to be `{ image: <that id> }`; the "names another target or another pin" test moves its tags to `tag`.

`targets-workspace.test.ts:170-175`: `isFactoryImage(imageTag(...))` becomes `isFactoryImageId(task("0".repeat(40)).target.image.localId)`.

`factory-dispatch.test.ts`: in "builds it while the row waits in received, then dispatches in it" (Task 13), capture the handoff the builder was created with (`fake.requests` for `POST /threads`, `metadata.factoryBuilder`) and assert `target.image` equals the `image_bound` payload's `image.localId`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/builder-handoff.test.ts test/targets-workspace.test.ts test/factory-dispatch.test.ts && pnpm --filter @b4-example/software-factory-server test`
Expected: FAIL (version 3; `image` is a tag; no `tag`; `isFactoryImageId` missing).

- [ ] **Step 3: Implement**

In BOTH `controller/src/lib/builder-handoff.ts` and `server/src/builder-handoff.ts`, identically: keep `FACTORY_IMAGE`, now documented as the tag's shape, and add

```ts
/**
 * An image by its id, `sha256:<64 hex>`: what a handoff names and the builder's provider runs.
 * The framework records `docker image inspect <id>`'s `.Id` as the thread's environment
 * identity, which for an id is the id itself, so the builder runs exactly the image the
 * controller bound, whatever any tag names by then.
 */
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/
```

In the schema: `version: z.literal(4)`; `target` becomes

```ts
    target: z
      .object({
        /** The bound image, by id: the one the controller prepared and verifies in. */
        image: z.string().regex(IMAGE_ID),
        /** The factory tag it was built under; its target and pin must be this handoff's own. */
        tag: z.string().regex(FACTORY_IMAGE),
        /** The commit that image was prepared at. */
        pin: z.string().regex(/^[a-f0-9]{40}$/),
        policy: /* unchanged */,
        permissions: /* unchanged */,
      })
      .strict(),
```

the `superRefine` reads `handoff.target.tag` instead of `handoff.target.image` (message: `tag ${handoff.target.tag} is not target … at pin …`), and

```ts
/** Whether `reference` is an image id: the builder's `dockerSandbox({ images })`. */
export const isFactoryImageId = (reference: string): boolean => IMAGE_ID.test(reference)
```

replaces `isFactoryImage`. The doc comments that said the provider "allows no other shape" than a factory tag now say it allows only an image id, and that a moved tag moves nothing.

Controller only: `CaptureBuilderHandoffOptions` gains

```ts
  /** The image the work order bound (`image_bound`): the handoff names it, and it must be the catalog's. */
  readonly imageId: string
```

and `captureBuilderHandoff`, before the capture:

```ts
  if (options.imageId !== task.target.image.localId)
    throw new Error(
      `image ${options.imageId} is not the image this host records for target ${task.target.id} at ${task.target.pin} (${task.target.image.localId})`,
    )
```

and builds the handoff with `version: 4`, `image: options.imageId`, `tag: imageTag(task.target)`.

`server/b4.config.ts`: import and pass `isFactoryImageId`.

`factory.ts`: the `captureBuilderHandoff` option's input gains `readonly imageId?: string` (absent only for the `tasks` test seam, which binds no image); `captureBuilderHandoffFromCatalog` throws `new Error("dispatch bound no image")` when it is absent and passes it on; `prepareDispatchImage` returns `{ refusal: string } | { bound: BoundImage | undefined }` (`bound` undefined when the task does not load), and `dispatch` keeps the binding and passes `...(bound !== undefined ? { imageId: bound.image.localId } : {})` into the capture call.

`fake-worker-map.ts` `fakeBuilderHandoff`: `version: 4`, `image: imageId ?? \`sha256:${"0".repeat(64)}\``, `tag: \`b4-factory-fake-target:${"0".repeat(12)}-${"0".repeat(12)}\``.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-server test && pnpm --filter @b4-example/software-factory-server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/builder-handoff.ts examples/software-factory/server/src/builder-handoff.ts examples/software-factory/server/b4.config.ts examples/software-factory/controller/src/lib/controller/factory.ts examples/software-factory/controller/test/fake-worker-map.ts examples/software-factory/controller/test/builder-handoff.test.ts examples/software-factory/server/test/builder-config.test.ts examples/software-factory/controller/test/targets-workspace.test.ts examples/software-factory/controller/test/factory-dispatch.test.ts
git commit -m "feat(software-factory): the builder runs the bound image by id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 19: The verifier runs the bound image by ID and refuses a changed one

**Files:**
- Modify: `controller/src/lib/verification/verifier.ts` (`VerifyInput.imageId`)
- Modify: `controller/src/lib/verification/docker-verifier.ts:40-53` (`verifierImage`; run by id)
- Modify: `controller/src/lib/intake/oracle.ts` (`ProveOracleInput.imageId`, passed through)
- Modify: `controller/src/lib/controller/intake.ts` (pass `image.bound.image.localId` to `proveOracle`)
- Modify: `controller/src/lib/controller/verify.ts:44-60,170-180` (the binding; `image_unbound`)
- Modify: `controller/src/lib/controller/factory.ts` (approve's re-verification, `:1455-1464` at #843)
- Test: `controller/test/docker-verifier.test.ts` (new, unit), `controller/test/factory-verify.test.ts`, `controller/test/factory-intake.test.ts`, `controller/test/factory-approve.test.ts`; callers of `verify`/`proveOracle` in `test/*.integration.test.ts` and `test/intake-oracle.test.ts` pass `imageId: loadTask(<id>).target.image.localId`

- [ ] **Step 1: Write the failing tests**

`test/docker-verifier.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { ImageChangedError, verifierImage } from "../src/lib/verification/docker-verifier.ts"

describe("the verifier's image", () => {
  it("is the bound id when the catalog records the same image", () => {
    const task = loadTask("cli-flags")
    expect(verifierImage(task, task.target.image.localId)).toBe(task.target.image.localId)
  })

  it("refuses a bound id the catalog no longer records, naming both", () => {
    const task = loadTask("cli-flags")
    const stale = `sha256:${"7".repeat(64)}`
    expect(() => verifierImage(task, stale)).toThrow(ImageChangedError)
    expect(() => verifierImage(task, stale)).toThrow(
      `The work order is bound to image ${stale}, and this host now records ${task.target.image.localId} for target cli-flags at ${task.target.pin}: the verdict would be earned in another environment`,
    )
  })
})
```

`factory-verify.test.ts`: after a dispatch that reaches `verifying`, `verifier.calls.at(-1)?.imageId` equals `boundImageOf(factory.events(id))?.image.localId`; and a new test that removes the binding (a row whose journal has no `image_bound`, forced with the file's `forceRow`/journal helpers into `verifying`) settles `blocked` / `verification_inconclusive` with an `image_unbound` event and no verifier call. `factory-intake.test.ts`: the oracle call (`verifier.calls[0]`) carries `imageId` equal to the `image_bound` payload's. `factory-approve.test.ts`: the re-verification call carries the bound id.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/docker-verifier.test.ts test/factory-verify.test.ts test/factory-intake.test.ts test/factory-approve.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`verifier.ts`, in `VerifyInput`:

```ts
  /**
   * The image the work order bound (`image_bound`), by id: the one image the verdict may be
   * earned in. The verifier refuses to run when the catalog records another for the task.
   */
  readonly imageId: string
```

`docker-verifier.ts`:

```ts
/** The work order's bound image is not the one this host now records for its task. */
export class ImageChangedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ImageChangedError"
  }
}

/**
 * The image a verification runs: the work order's bound id, and only when the catalog still
 * records that image for the task's target at its pin. A receipt binds the environment
 * identity the catalog computes (`environmentIdentity`), so a verdict earned in any other image
 * would bind an identity that did not produce it.
 */
export function verifierImage(task: Task, imageId: string): string {
  if (imageId !== task.target.image.localId)
    throw new ImageChangedError(
      `The work order is bound to image ${imageId}, and this host now records ${task.target.image.localId} for target ${task.target.id} at ${task.target.pin}: the verdict would be earned in another environment`,
    )
  return imageId
}
```

and in `verify`: `const provider = dockerSandbox({ scope: "software-factory-verifier", image: verifierImage(task, input.imageId) })` (the `imageTag` import goes). A throw here rejects `verify`, which every caller already journals as `verifier_unavailable` and settles `inconclusive`: the harness could not run in the environment the work order is bound to.

`oracle.ts`: `ProveOracleInput` gains `readonly imageId: string`, passed into the `verify` input. `intake.ts` passes `imageId: image.bound.image.localId` (the `image` from Task 12's fit step).

`verify.ts`, in `verifyCandidate` after `const policy = loadPolicy(row.taskId)`:

```ts
  // The image the work order bound at dispatch: the verdict is earned in it or not at all. A
  // row with no binding (dispatched before images were bound) is not verified in whatever the
  // catalog names now.
  const bound = boundImageOf(ctx.store.events(id))
  if (bound === undefined) {
    ctx.recordEvent(id, "image_unbound", { phase: "verify" })
    if (ctx.mustGet(id).state === "verifying")
      ctx.transition(id, "receipt_inconclusive", { blockedReason: "verification_inconclusive" })
    return
  }
```

and the `verify` input gains `imageId: bound.image.localId`. `factory.ts`'s approve re-verification does the same: no binding → `recordEvent(id, "image_unbound", { phase: "export" })` and `refuse("The work order has no bound image to re-verify in")`; otherwise `imageId: bound.image.localId`.

`test/fake-verifier.ts` needs no change (it records `calls`). Every direct caller of `verify` or `proveOracle` in the tests passes `imageId: loadTask(<taskId>).target.image.localId`: `grep -rn "\.verify(\|proveOracle(" examples/software-factory/controller/test` lists them.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/verification/verifier.ts examples/software-factory/controller/src/lib/verification/docker-verifier.ts examples/software-factory/controller/src/lib/intake/oracle.ts examples/software-factory/controller/src/lib/controller/intake.ts examples/software-factory/controller/src/lib/controller/verify.ts examples/software-factory/controller/src/lib/controller/factory.ts examples/software-factory/controller/test
git commit -m "feat(software-factory): the verifier runs the bound image by id, and refuses a changed one

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 20: The Docker proof: a moved tag moves nothing

**Files:**
- Modify: `controller/test/builder.integration.test.ts:290-363`
- Modify: `controller/test/docker-verifier.integration.test.ts`

- [ ] **Step 1: The builder lane**

In the multi-target lane (`:290-363`), the handoffs are built with `imageId` (each work order's `task.target.image.localId`), and after the three threads are admitted and their records checked (`record?.intent.environment.identity` equals `want.localId`, as today), add:

```ts
    // A moved tag moves nothing: point devkit's factory tag at another image, then admit a
    // fourth thread from the same handoff. It runs the bound id, not what the tag names now.
    execFileSync("docker", ["tag", loadTargetRecipe("devkit").baseImage, imageTag(devkitTask.target)])
    try {
      const fourth = await admit("wo-devkit-3", { ...devkit.handoff, workOrderId: "wo-devkit-3" })
      const session = inspectSession(fourth)
      expect(session.Image).toBe(devkitTask.target.image.localId)
      // And a handoff naming the tag, the pre-version-4 shape, is refused at admission.
      await expect(
        admit("wo-devkit-4", {
          ...devkit.handoff,
          workOrderId: "wo-devkit-4",
          target: { ...devkit.handoff.target, image: imageTag(devkitTask.target) },
        }),
      ).rejects.toThrow(/image/)
    } finally {
      // Put the tag back on the registry's image, as the next `ensure` would.
      execFileSync("docker", ["tag", devkitTask.target.image.localId, imageTag(devkitTask.target)])
    }
```

(`admit` and `inspectSession` stand for the lane's existing steps that create a thread from a handoff and read its session container's `docker inspect`; factor them out of the three-thread loop if they are inline.)

- [ ] **Step 2: The verifier lane**

In `docker-verifier.integration.test.ts`, every `verify` input gains `imageId: task.target.image.localId`, and add:

```ts
  it("verifies in the bound image by id, and refuses to verify in a changed one", async () => {
    const task = loadTask("cli-flags")
    const tag = imageTag(task.target)
    execFileSync("docker", ["tag", loadTargetRecipe("cli-flags").baseImage, tag])
    try {
      const receipt = await verifier.verify({ ...baselineInput(), imageId: task.target.image.localId }, AbortSignal.timeout(600_000))
      expect(receipt.environmentIdentity).toBe(environmentIdentity(task.target))
      await expect(
        verifier.verify({ ...baselineInput(), imageId: `sha256:${"7".repeat(64)}` }, AbortSignal.timeout(60_000)),
      ).rejects.toThrow(ImageChangedError)
    } finally {
      execFileSync("docker", ["tag", task.target.image.localId, tag])
    }
  }, 900_000)
```

(`baselineInput()` stands for the file's existing verify input for the unpatched baseline; reuse its construction.)

- [ ] **Step 3: Run the lanes (Docker required)**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run --config vitest.sandbox.config.ts test/builder.integration.test.ts test/docker-verifier.integration.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add examples/software-factory/controller/test/builder.integration.test.ts examples/software-factory/controller/test/docker-verifier.integration.test.ts
git commit -m "test(software-factory): a moved tag moves neither the builder nor the verifier

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 21: Docs: the follow-up is closed

**Files:**
- Modify: `examples/software-factory/README.md` (the builder's image bound, `:150-160` at main)
- Modify: `docs/superpowers/plans/2026-09-24-per-thread-sandbox.md` (`:4862`, `:4895`: append "Closed by the images plan, PR 2")
- Modify: `docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md` (§4 As landed, PR 2 sentence)

- [ ] **Step 1: Edit**

README: the paragraph on the builder's image bound says: the handoff names the image the work order bound by id (`sha256:…`), the builder's provider accepts only ids, the framework records that id as the thread's identity, and the verifier runs the same id and refuses (`verification_inconclusive`) when the host now records another image for the task; a tag is a name for people and prunes, never the identity. The per-thread plan's two follow-up paragraphs each gain one line: "Closed by `2026-09-25-images-built-on-demand.md` PR 2: handoff version 4 names the bound image id; the verifier runs it and refuses a changed one." The spec's As-landed paragraph replaces "PR 2 runs the bound image by ID in the builder and the verifier" with what landed.

- [ ] **Step 2: Commit and verify**

```bash
git add examples/software-factory/README.md docs/superpowers/plans/2026-09-24-per-thread-sandbox.md docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md
git commit -m "docs(software-factory): builder and verifier run the bound image by id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

PR 2 verification: the PR 1 table, plus `pnpm --filter @b4-example/software-factory-server test` and the two lanes of Task 20. Push `blove/images-by-id` and open the PR only when Brian asks.

---

## Proof map

| Proof (spec §4 and this plan) | Where |
|---|---|
| Two concurrent work orders at one pin build once | Task 4 "builds a key once however many need it at once" (registry); Task 12 "builds a pin once for two work orders that need it at once" (intake) |
| A failed build settles the work order with the log in evidence | Task 3 (the error carries the log); Task 12 (intake blocks `image_prepare_failed`, the artifact holds the log, no attempt spent, the next work order builds); Task 13 (dispatch refuses, retries on the next dispatch) |
| Docker: intake at an unprepared devkit pin builds it, and the recorded identity equals the script's | Task 15 |
| Identity by id: a retagged image is refused | Task 18 (a handoff naming a tag is refused by schema; the provider accepts only ids); Task 19 (a bound id the catalog no longer records is refused by the verifier); Task 20 (Docker: a moved tag moves neither) |
| Concurrency limit | Task 4 "never runs more builds at once than its limit"; "leaves a queued waiter's cancel costing nothing" |
| Cancellation | Task 4 (last waiter cancels; a shared build survives one waiter); Task 12 (intake cancel mid-build); Task 13 (dispatch cancel mid-build) |
| Registry / local image drift | Task 5 (deleted image rebuilt; moved tag pointed back; `recorded` never asks Docker); Task 15 (moved tag against a real daemon); Task 13 (`image_changed` at dispatch) |
| Budget exclusion | Task 10 (restart resumes a paused clock); Task 12 (an hour of building charges nothing) |
| Timeout | Task 4 "fails a build past its timeout" |
| No image in the repository | Task 9 (schema refuses `images`/`image`; `git grep localId` empty) |

## Follow-ups recorded, not in this plan

- **The factory's own git object store** (spec §9 finding 3, D12): a bare mirror under `FACTORY_STATE_DIR` that `ensurePin`, the image context archive, the wide capture, the baseline and the pin diff all read, so the factory never fetches into the developer's clone.
- **`reprove`** (D5): a command that re-runs the oracle proof in the image the host now builds, rebinding, for a work order refused `image_changed` after a prune; today the remedy is a new work order.
- **Budgets from measured verifier time** (spec §9 finding 5, D14).
- **Cross-process single flight** (D6): a lock row in `images.sqlite` if running the script beside a live controller ever builds one key twice in practice.
- **A reaper for superseded images**: every recipe change leaves the previous image tagged on the daemon; a `factory images prune` that removes images no registry row and no live work order names.
- **Build output as a live journal tail**: the CLI shows `image_prepare_started` and then nothing until the build ends; streaming log lines as events would make a multi-minute build visible.

## Self-review

- **Spec coverage.** §4 Change: the build lifted into `src/lib/targets` (Tasks 3-6) as `ImageRegistry.ensure(recipe, { signal })` rather than a free `prepareImage(target, pin, { signal })`, because single flight and the limit need shared state; called at intake's fit step (Task 12) and at dispatch (Task 13); one build per key (Task 4); registry at `<FACTORY_STATE_DIR>/images.sqlite` (Task 3, Task 8); journal events (Task 11); budget exclusion (Tasks 10, 12); `image_unprepared` retired as a standing block (Tasks 7, 12, 13); no B4-level `dockerSandbox({ build })` (none added). Trust impact: inputs unchanged and reviewed (the base is now reviewed too, Task 1); the drafter still never chooses a pin; the cost exposure is bounded by the limit (Task 4). Proof: the proof map above. §7's row "`target:prepare` per pin | 4" is removed by Tasks 9, 13 and 16. §9 findings 3 and 5: deferred with reasons (D12, D14).
- **Placeholder scan.** Code steps carry code. Three places reference an existing test helper by role rather than name (`validHandoff()` in Task 18, `admit`/`inspectSession` and `baselineInput()` in Task 20) because the helpers exist under file-local names the executor reads in place; each says so.
- **Type consistency.** `TargetRecipe` (Task 1) is what `recipeKey`, `ImageRegistry.recorded/ensure`, `BuildRequest.recipe`, `recipeProblem`, `availableTargets`, `ParsedDraft.target`, `loadTaskTargetRecipe` and `prepareWorkOrderImage` take. `EnsuredImage.build` is optional everywhere. `BoundImage` (Task 11) is what `boundImageOf` returns and `image_bound` carries; Task 18 and Task 19 read `bound.image.localId`. `isFactoryImage` is renamed `isFactoryImageId` in both handoff copies and in `b4.config.ts` in the same task. The registry's `recorded` takes the recipe alone (its pin is `recipe.pin`); no task passes a separate pin.
