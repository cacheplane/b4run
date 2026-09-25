# Environment Images Built When First Needed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A work order that needs a target's image at a pin gets it without an operator step: the controller builds it the first time any work order needs it, records it in a host-local registry, binds it to the work order, and the builder and the verifier run exactly that image, by ID.

**Architecture:** A new image registry (`<FACTORY_STATE_DIR>/images.sqlite`, `node:sqlite`) keyed by a digest of the target's image recipe at a pin, with one build per key at a time, a global build limit, a build timeout and refcounted cancellation. `target.json` stops carrying images at all: it carries the recipe, including the base image pinned by digest. The controller calls the registry at intake's fit step and at dispatch, journals the build, stores its log as evidence, pauses the work order's budget while it waits, and binds the image to the work order (`image_bound`). The binding is authoritative: the verifier runs the bound image by ID in PR 1, and its policy and environment identity are computed from the bound image object, never from whatever the registry records later. PR 2 moves the builder to the same ID: the handoff names the bound image ID, the builder's provider accepts only image IDs, and the builder's resolver checks the ID's build labels name the handoff's own target, pin and recipe key.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), `node:sqlite`, `node:child_process` `spawn` with `AbortSignal`, zod 4, vitest 4, Docker (BuildKit), git.

**Spec:** [`2026-09-23-software-factory-framework-gaps-design.md`](../specs/2026-09-23-software-factory-framework-gaps-design.md) §4 (this item), §7, §8, §9 findings 3 and 5.

**Base:** `main` at `38fcb3dd` (PR #843, "workspaces travel with thread creation; no manifest directory", merged 2026-09-25). Paths and lines were read at `f92607ef` (the #843 head, identical to `38fcb3dd` for every file this plan touches) and `79c5f63d`.

> **Amended after review (2026-09-25).** An independent review found eight Important issues and several minors; all are addressed in place, and "Review amendments (2026-09-25)" at the end lists each with where it landed. The largest changes: the verifier runs the bound image by ID in PR 1 (Task 13a, moved from PR 2), the binding is authoritative (policy and identity come from the bound image object), tags are recipe-key-scoped and a build reads its own ID from `--iidfile`, the CLI and the review's pin diff load tasks without an image (`loadTaskRecipe`), `dispatch` honours the route's cancel and re-checks the approved digest after the build, waiters have a total wait bound, the lanes' registry is per run, PR 2's builder checks build labels, and `FACTORY_SKIP_BASE_PULL` is kept.

---

## Decisions needed

Brian decides these before PR 1 starts. Each has a recommendation; the tasks below implement the recommendation.

**D1. Registry: where and what shape.** *Recommend:* its own SQLite file, `<FACTORY_STATE_DIR>/images.sqlite`, one table `images` keyed by the recipe digest, holding the full `Image` object (`localId`, `platform`, `baseManifestDigest`, `dockerfileSha256`, `lockfileSha256`, `pnpmVersion`) plus `target_id`, `pin`, `tag`, `built_at`, `build_ms`, versioned by the repository's own idiom, a `schema_version` table (as `registry/db.ts:195-209`), refused when newer. Not a table in `registry.sqlite`: images outlive work orders, the `target:prepare` script and `factory builder-handoff` read or write the image registry without opening the work-order registry (and without its migrations), and a host-level fact should not ride a work-order schema version. (Spec §4 names this file; kept.)

**D2. The key.** *Recommend:* `imageRecipeDigest` over `{targetId, pin, platform, baseImage, dockerfileSha256, imageContext (sorted), lockfile (path), imageAssertResolves (sorted), commandsCwd}`, domain `b4-factory-image-recipe-v1`. Not the lockfile hash and not an `imageContext` tree hash: a pin is an immutable commit, so (pin, path list) already determines both, and computing them would put a `git show` of a multi-MB lockfile in every `loadTarget`. The lockfile hash stays in the recorded `Image` (it is an identity input). The key deliberately covers more than today's tag and identity do: `imageContext`, `imageAssertResolves` and `commands.cwd` are recipe inputs in `target.json` that neither `imageTag` nor `environmentIdentityDigest` sees, so today an `imageContext` edit that leaves the Dockerfile alone silently reuses a stale image under the old identity.

**D3. `target.json` stops carrying images; what pins the default image.** *Recommend:* drop `images` (and 3a's single `image`) from `target.json` entirely, refused by name with a message that says where images live now; add `baseImage: "node:24-slim@sha256:<index digest>"`. What pins the default image is the committed recipe: the Dockerfile, the `imageContext` and lockfile at the default `pin`, and the base by digest. `localId` is host-specific and never belonged in the repository; committing it is exactly the rewrite churn (and the CI "manifest diff is expected here" comment). Pinning the base is what makes the key computable offline: with a floating `node:24-slim`, a lookup would need a pull to learn which base it would build on. *Also recommend* unifying all three targets on the drafter's pinned base (`node:24-slim@sha256:0e0ff40c…`, `drafter/src/drafter-image.ts:10`), which is already `cli`'s: CI pulls it for the drafter lane anyway, and on this host `devkit` and `cli-flags` must rebuild regardless (their committed `localId`s are not on the daemon; "Today, verified", row 12). The builder pulls the base only when `docker image inspect <baseImage>` says it is absent. `FACTORY_SKIP_BASE_PULL` is **kept** (amended): whether pull-only-when-absent avoids the Docker Desktop pull wedge is unverified, because BuildKit may still contact the registry to load metadata for a digest-pinned `FROM`. With the variable set the builder never pulls, and an absent base fails the build naming it. The check that would retire it is recorded under Follow-ups.

**D4. One image identity for builder and verifier: by image ID.** *Recommend:* the verifier runs `dockerSandbox({ image: <bound id> })` with policy and environment identity computed from the bound image object (PR 1, Task 13a, amended from PR 2); a bound ID the daemon no longer holds refuses the verification (`verifier_unavailable` → `verification_inconclusive`). PR 2: the builder handoff's `target.image` becomes the bound image ID (`sha256:<64 hex>`) and gains `target.tag`; the builder's `dockerSandbox({ images })` predicate accepts only `^sha256:[0-9a-f]{64}$`, so the framework's `docker image inspect <id>` records exactly that ID as the thread's `environment.identity`; and the builder's resolver reads the ID's `b4.factory.target`, `b4.factory.pin` and `b4.factory.key` labels (stamped at build, D10) and refuses an image whose labels do not name the handoff's own target, pin and the tag's key. Labels are part of the image config the ID content-addresses, so checking them by ID has no time-of-check gap. No framework hook is needed: the resolver is the builder app's own code and may call Docker; a framework predicate that received the inspected labels (`images: (reference, inspected) => …`) would be tidier and is recorded as a follow-up. Rejected alternative: have the builder resolve a tag and check its `RepoTags`; it races a moved tag.

**D5. Binding, and the binding is authoritative.** *Recommend:* a work order binds its image the first time it needs one, journalled as `image_bound {targetId, pin, key, tag, image}`; the last `image_bound` is the binding. Intake rebinds on every attempt (a redraft may name another target, and each oracle proof runs in the image that attempt bound). Once bound, the work order's policy and environment identity are computed from the bound image object, and the bound ID is what dispatch, the verifier, the oracle proof and approve's re-verification run: never whatever the registry records later. The only refusal is a bound ID the daemon no longer holds (`image_changed` at dispatch, row stays `received`, nothing spent; `verification_inconclusive` at verify): the oracle was proved in that image, and it cannot be proved again in a rebuild without a new proof. The remedy is a new work order; a `reprove` command is a follow-up. A registry record replaced by a later build of the same key does not strand a bound work order while its image exists (amended: the review's key-stranding minor).

**D6. Single flight, the global limit, and a wait bound.** *Recommend:* one in-process build per key (a second caller joins the first's promise, journalled `shared: true`); `FACTORY_MAX_IMAGE_BUILDS` (default 1) bounds builds across keys, queued callers still cancellable; each waiter's total wait (queue plus build) is bounded by `queueTimeoutMs + buildTimeoutMs`, with `queueTimeoutMs` defaulting to twice the build timeout, and journalled as `deadlineMs` on `image_prepare_started` so a follower (the CLI) knows how long to wait. The spec's cost bound ("bound it with a build concurrency limit") is this. Cross-process single flight (the script and a controller building one key at once) is not attempted: both builds succeed and the later record wins; a work order that bound the earlier ID keeps running it (D5), and that image keeps its ID tag (D10).

**D7. Cancellation.** *Recommend:* each caller waits with its own signal (intake: the phase signal; dispatch: a per-row image-wait signal combined with the dispatch route's own `ctx.signal`, aborted by any transition out of `received`, by the route's cancel, and by `close()`); the build itself has its own controller, aborted only when its last waiter leaves. An abort of the dispatch route's signal during the build records a cancel exactly as `settleOutcome` does (`cancel:<id>:aborted-dispatch`). Aborting kills the `docker build` client, which cancels the BuildKit session. A cancelled build records nothing.

**D8. Timeout.** *Recommend:* `FACTORY_IMAGE_BUILD_TIMEOUT_MS`, default 1,800,000 (30 min), started when the build takes its slot (queue time excluded, and bounded separately, D6). Measure the `cli` target's cold build during PR 1 and raise the default if it needs more; the timeout is a wedge detector, not a stopwatch.

**D9. Build log to evidence.** *Recommend:* the builder streams every command's stdout and stderr into a bounded log (last 1 MiB kept, with a note of what was dropped); on success and on failure the controller stores it in the artifact store and journals its digest (`image_prepared.logDigest`, `image_prepare_failed.logDigest`).

**D10. Tags, the build's own ID, and drift.** *Recommend (amended):* a build reads its image ID from `docker build --iidfile`, never from a tag another build may have moved. Each image gets two tags: the recipe tag `b4-factory-<target>:<pin[:12]>-<key[:12]>` (key-scoped, so one tag belongs to one recipe and D10's re-pointing can never move a tag between keys; it still matches the builder's `FACTORY_IMAGE` pattern) and an ID tag `b4-factory-<target>:<pin[:12]>-<key[:12]>-<id[:12]>` that never moves, so a bound image superseded by a later build of its key keeps a tag and a dangling-image prune cannot remove it. Every build is labelled `b4.factory.target`, `b4.factory.pin`, `b4.factory.key` (D4). Every `ensure` re-verifies a recorded image with `docker image inspect <localId>`; missing → `image_missing` journalled, the record deleted, a rebuild. A recipe tag moved off the recorded image is pointed back. `loadTarget` (synchronous, called everywhere) reads the record only and never calls Docker.

**D11. Journal and budget.** *Recommend:* events `image_prepare_started {targetId, pin, key, shared, deadlineMs}`, `image_prepared {… localId, tag, ms, logDigest, shared}`, `image_prepare_failed {… error, logDigest}`, `image_prepare_aborted`, `image_missing`, `image_bound`, `image_changed`, and `dispatch_refused` (Task 14). Budget: only intake waits in an active state; the controller pauses the row's clock when a build starts or is joined for it (not for a recorded image re-verified in milliseconds), and resumes it when the wait ends (`budget_paused` banks the open interval and leaves `activeStartedAt` null; `budget_resumed` reopens it), persisted. Reconciliation, for a row with no tracked run, resumes a paused active clock and journals `image_prepare_aborted {reason: "restart"}` for a build the journal shows started and never ended. Dispatch waits in `received`, which is not active, so nothing is charged there. A failed build at intake blocks the row `image_prepare_failed` without spending a drafter attempt; at dispatch it is a refusal and the row stays `received`, so dispatching again retries the build. Either way the next need rebuilds: a failure is never recorded as the key's answer, so nothing blocks "for good".

**D12. The git object store (spec §9 finding 3).** *Recommend: defer* to its own item. The factory reads pins from the developer's clone in five places (the image context archive, the wide capture, the baseline, the pin diff base, the replay pin), and `ensurePin` fetches into it; an image registry that owned a bare mirror only for image builds would leave four readers on the developer's clone and add a second store to keep in step. The immediate foot-gun (a `--depth=1` fetch making a full clone shallow) is fixed (`catalog.ts:372-390`). PR 1 changes nothing about where pins are read or fetched.

**D13. CI lanes.** *Recommend:* drop the two explicit `target:prepare` lines from the `sandbox-docker` step (`ci.yml:472-473`). The `test:sandbox` run's `globalSetup` creates a fresh registry directory for the run (`mkdtemp`, handed to every lane file through vitest's `provide`/`inject`, removed at teardown), so two worktrees or two runs on one host never share a registry, and builds `cli-flags` and `devkit` at their default pins in it through the same `ensure` the controller calls; every lane that boots a controller reaches `ensure` itself. The opt-in `test:sandbox:cli` run (`FACTORY_TEST_CLI_TARGET=1`) skips those two prebuilds; its lane builds `cli` itself. The step's comment is rewritten (no "manifest diff is expected here"), and both workflow-audit fixtures change in the same commit.

**D14. Measured verifier time per (target, pin) (spec §9 finding 5).** *Recommend: defer.* The budget's unit is the target's verifier deadline, which the target already carries; a measured time belongs to the verifier's receipts, not to the image registry, and deriving budgets from it is its own design.

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
7. **§4 Trust impact** omits two new exposures. Automatic rebuilds make a moved tag (and a changed ID) routine rather than an operator act, which is what makes D4/D5 necessary rather than tidy. And a build is now model-triggerable: the drafter chooses which available target a draft names, so each drafter attempt can cause one build of a reviewed recipe at the work order's pin (at most `maxIntakeAttempts` per work order, each bounded by the build limit, the queue bound and the timeout, D6/D8). The drafter never chooses the pin or the recipe; the exposure is cost, not content.
8. **§9 finding 3 "item 4's image registry should own its own object store"**: the object store serves captures, baselines and pin diffs as well as images; it is its own item (D12).
9. **§9 finding 5 "item 4's registry should record measured verifier time"**: deferred (D14).

## PR split

- **PR 1 — images built on demand, verified by ID** (`blove/images-on-demand`, Tasks 1-17, with 8a and 13a). Standalone: the registry, the Docker builder, `target.json` without images, `loadTaskRecipe` for everything that needs no image (the CLI, the review's pin diff, prompts, budgets), intake and dispatch building on first need with journal, log evidence, budget pause and binding (`image_bound`; `image_changed` when the bound image is gone), and the verifier, the oracle proof and approve's re-verification running the bound image by ID with policy and identity from the binding (Task 13a); the thin script, the lanes, CI, docs. The builder still runs the tag, which is recipe-key-scoped and names the bound image unless someone retags it by hand: identity is enforced where the verdict is earned.
- **PR 2 — the builder runs the bound ID** (`blove/images-by-id`, Tasks 18-21). Needs PR 1's binding. Handoff version 4 names the image ID, the builder's provider accepts only IDs, the builder's resolver checks the ID's `b4.factory.*` labels against the handoff, and `factory builder-handoff` takes `--image-id` or reads the registry. Closes the per-thread-sandbox follow-up.

No changeset: examples only. No release-pinned script is touched (the factory's scripts are not reachable from the release workflows); PR 1 edits `ci.yml`, so both workflow-audit fixtures change in the same commit (Task 16).

## File structure

| File | PR | Responsibility |
|---|---|---|
| `controller/src/lib/domain/digest.ts` | 1 | `imageRecipeDigest` |
| `controller/src/lib/targets/catalog.ts` | 1 | `baseImage`; `images` retired; `TargetRecipe`, `loadTargetRecipe`, `TaskRecipe`, `loadTaskRecipe`; `loadTarget` reads the configured registry or `options.image`; `ImageNotBuiltError`; `tagFor`, `idTagFor`; `configureImages` |
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
| `controller/src/cli.ts` | 1, 2 | `builder-handoff` loads a `TaskRecipe` (1) and takes `--image-id` or reads the registry (2); `dispatch` follows an image build (1) |
| `controller/src/lib/review/pin-diff-base.ts`, `verification/baseline.ts`, `prompts.ts`, `targets/workspace.ts`, `targets/permissions.ts` | 1 | load and take a `TaskRecipe` (Task 8a) |
| `controller/src/app/work-orders/dispatch/index.ts` | 1 | passes the route's signal to `dispatch` |
| `controller/test/static-images.ts`, `setup-images.ts`, `fake-image-builder.ts` (new) | 1 | unit-suite registry, fake builder |
| `controller/test/lane-images.ts`, `lane-images.global.ts`, `setup-lane-images.ts` (new) | 1 | one registry per `test:sandbox` run |
| `controller/test/images-on-demand.integration.test.ts` (new) | 1 | spec §4's Docker proof |
| `.github/workflows/ci.yml`, `scripts/release/test/fixtures/workflow-{entrypoints,safe-executables}.json` | 1 | no explicit prepare |
| `examples/software-factory/README.md`, `docs/superpowers/runbooks/software-factory-rung2-developer-guide.md`, the spec | 1, 2 | docs |
| `controller/src/lib/builder-handoff.ts` | 1, 2 | `TaskRecipe` and the bound tag (1); handoff v4 by image ID (2) |
| `server/src/builder-handoff.ts`, `server/b4.config.ts` | 2 | handoff v4 by image ID; `builderThreadSandbox` checks build labels |
| `controller/src/lib/verification/{verifier,docker-verifier,policy}.ts`, `controller/{verify,factory,intake}.ts`, `intake/oracle.ts` | 1 | the bound image as `VerifyInput.image`, the policy's image, run by id (Task 13a) |

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
10. **No destructive Docker commands on this host.** No `docker builder prune`, `docker image prune`, `docker rm`, `docker rmi` or `docker image rm`: the host's daemon and build cache are shared by other sessions (an earlier `docker builder prune -f` while writing this plan affected them), and the "identity equals the script's" proof relies on the build cache. The lanes move a tag and put it back; nothing in this plan deletes an image.

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

above it, and the import list gains `loadTargetRecipe`, `tagFor` and `idTagFor`. Add, inside `describe("target catalog", …)`:

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

  it("names a recipe tag after the target, the pin and the recipe key, and an id tag that never moves", () => {
    const pin = "1".repeat(40)
    const key = "c".repeat(64)
    expect(tagFor("devkit", pin, key)).toBe(`b4-factory-devkit:${"1".repeat(12)}-${"c".repeat(12)}`)
    expect(idTagFor("devkit", pin, key, `sha256:${"9".repeat(64)}`)).toBe(
      `b4-factory-devkit:${"1".repeat(12)}-${"c".repeat(12)}-${"9".repeat(12)}`,
    )
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

Add beside `imageTag` (`:404-411`), which Task 2 moves to `images.ts`:

```ts
/**
 * The recipe tag of `id` at `pin` whose recipe key (`recipeKey`, Task 2) is `key`. One tag per
 * recipe: a changed Dockerfile, base, context or pin is another key and so another tag, and
 * re-pointing a tag (the registry does, D10) can never move it between recipes. Still the
 * builder's `FACTORY_IMAGE` shape (`<target>:<12 hex>-<12 hex>`). Readable, and what keeps a
 * built image from being a dangling one a prune removes; never the identity.
 */
export function tagFor(id: string, pin: string, key: string): string {
  return `b4-factory-${id}:${pin.slice(0, 12)}-${key.slice(0, 12)}`
}

/**
 * The tag that stays on one build for good: the recipe tag plus the image id's first twelve
 * hex digits. A bound image a later build of its key superseded keeps this tag, so no
 * dangling-image prune removes an image a work order is bound to.
 */
export function idTagFor(id: string, pin: string, key: string, localId: string): string {
  return `${tagFor(id, pin, key)}-${localId.slice("sha256:".length, "sha256:".length + 12)}`
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
import { type TargetRecipe, tagFor } from "../src/lib/targets/catalog.ts"
import {
  baseDigestOf,
  dockerfileSha256Of,
  hostPlatform,
  imageTag,
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

  it("tags a loaded target by its recipe key on its image's platform", () => {
    const recipe = recipeFixture()
    const image = {
      localId: `sha256:${"a".repeat(64)}`,
      platform: "linux/amd64",
      baseManifestDigest: baseDigestOf(recipe.baseImage),
      dockerfileSha256: dockerfileSha256Of(recipe),
      lockfileSha256: "d".repeat(64),
      pnpmVersion: "10.33.0",
    }
    expect(imageTag({ ...recipe, image })).toBe(
      tagFor(recipe.id, recipe.pin, recipeKey(recipe, "linux/amd64")),
    )
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
import { type Target, type TargetRecipe, tagFor } from "./catalog.js"

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

/**
 * The recipe tag of a loaded target: its recipe key on its image's platform. Moved here from
 * `catalog.ts` (which cannot import this module at runtime); every importer of `imageTag`
 * now imports it from `targets/images.js`.
 */
export function imageTag(target: Target): string {
  return tagFor(target.id, target.pin, recipeKey(target, target.image.platform))
}

/** The recipe tag `recipe` builds under on `platform` (this host's by default). */
export function recipeTag(recipe: TargetRecipe, platform: string = hostPlatform()): string {
  return tagFor(recipe.id, recipe.pin, recipeKey(recipe, platform))
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

Delete `imageTag` from `catalog.ts` and change every import of it to `targets/images.js` (`.ts` in tests): `git grep -ln "imageTag" examples/software-factory` lists `controller/src/lib/builder-handoff.ts`, `controller/src/lib/verification/docker-verifier.ts`, and the tests `builder-handoff.test.ts`, `targets-workspace.test.ts`, `targets-catalog.test.ts`, `builder.integration.test.ts`, `target-devkit-pin.integration.test.ts`. `targets-catalog.test.ts`'s "selects the image prepared at the pin asked for" expectation becomes `tagFor("t", second, recipeKey(atSecond, atSecond.image.platform))` (the tag is key-scoped now).

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/images-recipe.test.ts test/digest.test.ts && pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/domain/digest.ts examples/software-factory/controller/src/lib/targets/images.ts examples/software-factory/controller/src/lib/targets/catalog.ts examples/software-factory/controller/src/lib/builder-handoff.ts examples/software-factory/controller/src/lib/verification/docker-verifier.ts examples/software-factory/controller/test
git commit -m "feat(software-factory): an image's registry key and tag are its whole recipe at a pin

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
    const key = recipeKey(recipe, "linux/arm64")
    const tag = tagFor(recipe.id, recipe.pin, key)
    expect(builder.requests).toHaveLength(1)
    expect(builder.requests[0]).toMatchObject({ platform: "linux/arm64", tag, key, repositoryRoot: "/repo" })
    expect(first.key).toBe(recipeKey(recipe, "linux/arm64"))
    expect(first.tag).toBe(tag)
    expect(first.build?.shared).toBe(false)
    expect(first.build?.log).toContain(`building ${tag}`)
    expect(started).toEqual([{ key: first.key, shared: false, deadlineMs: expect.any(Number) }])

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
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY); INSERT INTO schema_version(version) VALUES (99)")
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

Append to `controller/src/lib/targets/images.ts` (and extend its imports to `import { mkdirSync, readFileSync } from "node:fs"`, `import { dirname, join } from "node:path"`, `import { DatabaseSync } from "node:sqlite"`, and `import { type Image, ImageSchema, repositoryRoot, type Target, type TargetRecipe, tagFor } from "./catalog.js"` in place of Task 2's import):

```ts
/** What one build is asked for. */
export interface BuildRequest {
  readonly recipe: TargetRecipe
  readonly platform: string
  /** The recipe key: stamped on the image as the `b4.factory.key` label and part of both tags. */
  readonly key: string
  /** The recipe tag (`tagFor`); the builder also stamps the id tag (`idTagFor`) once it knows the id. */
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
  /**
   * Once, when this call starts a build (`shared: false`) or joins one in flight (`shared: true`).
   * `deadlineMs` is how long this call will wait for it at most (queue and build, D6).
   */
  readonly onBuild?: (event: {
    readonly key: string
    readonly shared: boolean
    readonly deadlineMs: number
  }) => void
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
  /** Does the daemon hold `localId`? What a bound work order asks instead of `ensure` (D5). */
  present(localId: string, signal: AbortSignal): Promise<boolean>
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
  /**
   * How long a caller may wait for a slot before its build starts; twice the build timeout
   * when absent. A caller's whole wait is bounded by this plus the build timeout (D6).
   */
  readonly queueTimeoutMs?: number
  /** The repository the build context is archived from; `repositoryRoot()` when absent. */
  readonly repositoryRoot?: string
  /** `hostPlatform()` when absent. */
  readonly platform?: string
  readonly now?: () => number
}

/**
 * Versioned like the work-order registry (`registry/db.ts`): a `schema_version` table, one row
 * per applied version, rather than `PRAGMA user_version`, so the two stores on one state
 * directory read the same way and a person inspecting either finds the version where the other
 * keeps it.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
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
  db.exec(SCHEMA)
  const found = Number(
    (db.prepare("SELECT max(version) AS v FROM schema_version").get() as { v: number | null }).v ?? 0,
  )
  if (found > IMAGE_REGISTRY_VERSION) {
    db.close()
    throw new Error(
      `The image registry schema version ${found} is newer than this factory supports (${IMAGE_REGISTRY_VERSION}): upgrade the factory, or give it another FACTORY_STATE_DIR`,
    )
  }
  if (found < IMAGE_REGISTRY_VERSION)
    db.prepare("INSERT OR IGNORE INTO schema_version(version) VALUES (?)").run(IMAGE_REGISTRY_VERSION)
  const platform = options.platform ?? hostPlatform()
  const now = options.now ?? Date.now

  const describe = (recipe: TargetRecipe): Described => {
    const dockerfileSha256 = dockerfileSha256Of(recipe)
    const key = recipeKey(recipe, platform, dockerfileSha256)
    return { key, tag: tagFor(recipe.id, recipe.pin, key), dockerfileSha256 }
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
          key: described.key,
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
      ensureOptions.onBuild?.({ key: described.key, shared: false, deadlineMs: 0 })
      const built = await build(described, recipe, signal)
      return {
        key: described.key,
        tag: described.tag,
        image: built.image,
        build: { shared: false, ms: built.ms, log: built.log },
      }
    },
    async present(localId, signal) {
      return (await options.builder.inspect(localId, signal)) !== null
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

  it("bounds a caller's whole wait, queue included, and says what it waited on", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const registry = open(builder, { maxConcurrentBuilds: 1, buildTimeoutMs: 5_000, queueTimeoutMs: 100 })
    const ahead = ensure(registry, recipeFixture({ pin: "5".repeat(40) })).catch((e: unknown) => e)
    await until(() => builder.running === 1)
    const behind = recipeFixture({ pin: "6".repeat(40) })
    const started: number[] = []
    const failure = await ensure(registry, behind, {
      onBuild: ({ deadlineMs }) => started.push(deadlineMs),
    }).catch((error: unknown) => error)
    expect(started).toEqual([5_100])
    expect(failure).toBeInstanceOf(ImagePrepareError)
    expect((failure as ImagePrepareError).message).toBe(
      `Target devkit at ${behind.pin}: waited more than 5100 ms for the image (queued behind other builds, then built); FACTORY_MAX_IMAGE_BUILDS and FACTORY_IMAGE_BUILD_TIMEOUT_MS bound this`,
    )
    // Nothing was recorded for it: the next need starts afresh. (The build ahead timed out at
    // 5,000 ms and freed the slot, so the queued build may have started before its only
    // waiter left and cancelled it; either way it recorded nothing.)
    expect(registry.recorded(behind)).toBeUndefined()
    builder.release()
    await ahead
  }, 15_000)

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
  /** A caller's whole wait: a slot, then the build. Journalled, so a follower knows the bound. */
  const waitBoundMs = (options.queueTimeoutMs ?? 2 * timeoutMs) + timeoutMs
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
      ensureOptions.onBuild?.({ key: described.key, shared, deadlineMs: waitBoundMs })
      flight.waiters += 1
      // This caller's own bound: queued behind other keys' builds, then this build. Leaving at
      // it is leaving like a cancel: the build goes on only if another caller still waits.
      const waited = AbortSignal.timeout(waitBoundMs)
      try {
        const built = await abortable(flight.promise, AbortSignal.any([signal, waited])).catch(
          (error: unknown) => {
            if (waited.aborted && !signal.aborted)
              throw new ImagePrepareError(
                `Target ${recipe.id} at ${recipe.pin}: waited more than ${waitBoundMs} ms for the image (queued behind other builds, then built); FACTORY_MAX_IMAGE_BUILDS and FACTORY_IMAGE_BUILD_TIMEOUT_MS bound this`,
                described.key,
                "",
                { cause: error },
              )
            throw error
          },
        )
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

  it("answers whether the daemon holds an image, by id", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const first = await ensure(registry, recipeFixture())
    const signal = AbortSignal.timeout(1_000)
    expect(await registry.present(first.image.localId, signal)).toBe(true)
    builder.daemon.delete(first.image.localId)
    expect(await registry.present(first.image.localId, signal)).toBe(false)
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

The build steps move from `scripts/prepare-target.ts:34-186` into `src/lib/targets/image-builder.ts`, unchanged in substance except: the base is pulled only when absent unless `FACTORY_SKIP_BASE_PULL=1` forbids pulling (D3); the Dockerfile and the lockfile are hashed from the context the build saw; the build's own id comes from `--iidfile`, never a tag (D10); the image is labelled with its target, pin and key and gets an id tag that never moves (D10); the module assertions run the image by ID; every command's output goes to the log; and every command is cancellable. The pre-build refusals become one function in `prepare.ts`.

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
import { idTagFor, tagFor } from "../src/lib/targets/catalog.ts"
import { dockerImageBuilder, type Run, spawnRun } from "../src/lib/targets/image-builder.ts"
import { dockerfileSha256Of, recipeKey } from "../src/lib/targets/images.ts"
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
      // What BuildKit does with --iidfile: this build's id, whatever the tag names.
      writeFileSync(args[args.indexOf("--iidfile") + 1] as string, LOCAL_ID)
      runOptions.onOutput?.("#5 DONE 0.1s\n")
      return ""
    }
    if (verb === "tag" || verb === "run") return ""
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
    const key = recipeKey(recipe, "linux/arm64")
    const tag = tagFor(recipe.id, pin, key)
    const log: string[] = []
    const image = await dockerImageBuilder({ run: docker.run, tmp }).build(
      { recipe, platform: "linux/arm64", key, tag, repositoryRoot: root },
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
      ["tag", LOCAL_ID],
      ["run", "--rm"],
    ])
    expect(docker.calls[1]).toEqual(["pull", "--platform", "linux/arm64", BASE])
    expect(build).toEqual(
      expect.arrayContaining([
        `BASE_IMAGE=${BASE}`,
        "PLATFORM=linux/arm64",
        "PNPM_VERSION=10.33.0",
        "b4.factory.target=devkit",
        `b4.factory.pin=${pin}`,
        `b4.factory.key=${key}`,
        "--iidfile",
        "-t",
        tag,
      ]),
    )
    // The id file lives beside the context, never inside it (it would enter the build).
    expect(build[build.indexOf("--iidfile") + 1]).not.toContain(build.at(-1) as string)
    // The context is the pin's archive of imageContext plus the Dockerfile, and nothing else.
    expect(docker.context()).toEqual(["Dockerfile", "package.json", "pnpm-lock.yaml"])
    expect(existsSync(build.at(-1) as string)).toBe(false)
    expect(readdirSync(tmp)).toEqual([])
    // The id is the build's own (--iidfile), never a tag's: no `image inspect <tag>` after it.
    expect(docker.calls[3]).toEqual(["tag", LOCAL_ID, idTagFor("devkit", pin, key, LOCAL_ID)])
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
      { recipe: recipeAt(pin), platform: "linux/arm64", key: "k".repeat(64), tag: "b4-factory-devkit:x", repositoryRoot: root },
      () => {},
      AbortSignal.timeout(30_000),
    )
    expect(docker.calls.some((call) => call[0] === "pull")).toBe(false)
  })

  it("never pulls under FACTORY_SKIP_BASE_PULL, and says so when the base is absent", async () => {
    const { root, pin } = repo()
    const docker = scriptedDocker({ basePresent: false })
    process.env.FACTORY_SKIP_BASE_PULL = "1"
    try {
      await expect(
        dockerImageBuilder({ run: docker.run }).build(
          { recipe: recipeAt(pin), platform: "linux/arm64", key: "k".repeat(64), tag: "t", repositoryRoot: root },
          () => {},
          AbortSignal.timeout(30_000),
        ),
      ).rejects.toThrow(`base image ${BASE} is not on the daemon and FACTORY_SKIP_BASE_PULL=1 forbids pulling it`)
    } finally {
      delete process.env.FACTORY_SKIP_BASE_PULL
    }
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
        { recipe, platform: "linux/arm64", key: "k".repeat(64), tag: "t", repositoryRoot: root },
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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { idTagFor, ImageSchema } from "./catalog.js"
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
    async build({ recipe, platform, key, tag, repositoryRoot: repo }, log, signal) {
      const problem = recipeProblem(recipe, repo)
      if (problem !== undefined) throw new Error(problem)
      const base = recipe.baseImage
      // Pulled only when absent: pinned by digest, a present copy is the one the recipe names.
      // FACTORY_SKIP_BASE_PULL=1 never pulls (a host whose registry path wedges: Docker Desktop,
      // twice in the live run); an absent base then fails the build, naming the variable.
      if (!(await present(base, signal))) {
        if (process.env.FACTORY_SKIP_BASE_PULL === "1")
          throw new Error(
            `base image ${base} is not on the daemon and FACTORY_SKIP_BASE_PULL=1 forbids pulling it: pull it by hand (docker pull --platform ${platform} ${base}) or unset the variable`,
          )
        log(`pulling ${base} for ${platform}\n`)
        await run("docker", ["pull", "--platform", platform, base], { signal, onOutput: log })
      }
      // One directory per build: the context, and beside it (never inside it) the id file.
      const work = mkdtempSync(join(options.tmp ?? tmpdir(), `factory-image-${recipe.id}-`))
      try {
        const context = join(work, "context")
        const iidFile = join(work, "image.iid")
        mkdirSync(context)
        const tar = join(work, "context.tar")
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
        // Over the bytes the build saw: the Dockerfile copy in the context (the registry refuses
        // the image if it differs from the one the key was computed from), and the lockfile
        // `recipeProblem` proved is inside the context.
        const dockerfileSha256 = sha256(readFileSync(join(context, "Dockerfile")))
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
            // Part of the image config the id content-addresses: PR 2's builder checks them.
            "--label",
            `b4.factory.target=${recipe.id}`,
            "--label",
            `b4.factory.pin=${recipe.pin}`,
            "--label",
            `b4.factory.key=${key}`,
            // This build's own id, whatever any tag names by the time it is read (D10).
            "--iidfile",
            iidFile,
            "-t",
            tag,
            context,
          ],
          { signal, onOutput: log },
        )
        const localId = readFileSync(iidFile, "utf8").trim()
        if (!/^sha256:[0-9a-f]{64}$/.test(localId))
          throw new Error(`docker build wrote no image id to ${iidFile}`)
        // The tag that never moves: a bound image a later build of its key supersedes keeps it.
        await run("docker", ["tag", localId, idTagFor(recipe.id, recipe.pin, key, localId)], { signal })
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
        rmSync(work, { recursive: true, force: true })
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

`factory-intake.test.ts`: delete the test at `:407` ("blocks image_unprepared after one attempt …"). Its replacement ("offers and fits a target at a pin no image was built at") needs `loadTask` to load at any pin, which Task 9's registry-backed catalog provides; Task 9 adds it.

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

  it("refuses FACTORY_TARGETS_DIR, which named a copy the prepare script no longer writes", () => {
    expect(() => loadConfig({ ...baseEnv(), FACTORY_TARGETS_DIR: "/x" })).toThrow(
      /FACTORY_TARGETS_DIR is retired/,
    )
    // Kept (D3): the builder reads it, and whether it is still needed is unverified.
    expect(() => loadConfig({ ...baseEnv(), FACTORY_SKIP_BASE_PULL: "1" })).not.toThrow()
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

(`configuredImages` from the catalog; `staticImageRegistry` from `./static-images.ts`, created here.) The test registries, used from here on:

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
    return { key, tag: tagFor(recipe.id, recipe.pin, key), image }
  }
  return {
    recorded: answer,
    async ensure(recipe, { signal }) {
      signal.throwIfAborted()
      return answer(recipe)
    },
    async present() {
      return true
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
    async present() {
      return false
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
```

(`FACTORY_SKIP_BASE_PULL` is not retired: the image builder, which runs in the controller's process now, reads it, D3.)

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
      releaseImages()
    },
```

with, inside `createControllerRuntime` beside `openFactory`,

```ts
  /** Put back the registry configured before this runtime opened its own, and close its own. */
  function releaseImages(): void {
    if (images === undefined) return
    if (configuredImages() === images) configureImages(previousImages)
    if (ownsImages) images.close()
    images = undefined
  }
```

and the `.catch` at the end of `openFactory` becomes

```ts
    }).catch((error) => {
      // A failed open is retried by the next caller, like middleware setup itself, and leaves
      // no registry configured or open behind it.
      opening = undefined
      releaseImages()
      throw error
    })
```

A runtime test for the failed open: `createControllerRuntime` over a state directory whose `registry.sqlite` is a directory (`mkdirSync(join(state, "registry.sqlite"), { recursive: true })`) rejects `factory()`, and afterwards `configuredImages()` is the registry configured before it. The factory needs no option for it: it builds through `configuredImages()`, the same registry `loadTarget` reads (Task 11), so the two can never be different registries.

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

### Task 8a: Everything that needs no image loads a task without one (`loadTaskRecipe`)

Added after review (item 1). Once Task 9 makes `loadTarget` read the registry, every `loadTask` in a process with no registry configured throws `ImagesUnconfiguredError`, and every `loadTask` of a task whose image this host has not built throws `ImageNotBuiltError`. Most callers never read the image: the CLI's `builder-handoff` (`cli.ts:798`, driven as a subprocess by `cli.test.ts:1046-1100`, with no setup file), the export review's pin diff (`review/pin-diff-base.ts:26`, from `cli.ts:604`, which would silently show every file `unavailable`), the prompts, the budget checks, the builder's inspection options and the baseline capture. They move to a task loaded without its image, before Task 9 switches the catalog, so none of them can break.

Only three things read `task.target.image`: the builder handoff's tag (PR 1: the recipe tag, computable without an image), the verifier and the policy (Task 13a: from the work order's binding). Everything else takes a `TaskRecipe`.

**Files:**
- Modify: `controller/src/lib/targets/catalog.ts` (`TaskRecipe`, `loadTaskRecipe`; `loadTask` built on it)
- Modify: `controller/src/lib/review/pin-diff-base.ts:26` (`loadTaskRecipe`)
- Modify: `controller/src/lib/verification/baseline.ts:35` (`loadTaskRecipe`)
- Modify: `controller/src/lib/runtime.ts` (`builderReader`: `targetInspectionOptions(loadTaskRecipe(...))`)
- Modify: `controller/src/lib/prompts.ts` (`promptFor` loads a `TaskRecipe`; `taskPrompt`, `builderRules` take one)
- Modify: `controller/src/lib/targets/workspace.ts` (`targetWorkspace`, `targetInspectionOptions`, `targetSandboxPolicy` take `TaskRecipe`/`TargetRecipe`), `controller/src/lib/targets/permissions.ts:42` (`builderPermissions(target: TargetRecipe)`)
- Modify: `controller/src/lib/builder-handoff.ts` (`captureBuilderHandoff(task: TaskRecipe, options)`; `options.tag`, default `recipeTag(task.target)`)
- Modify: `controller/src/lib/controller/factory.ts` (`targetOf`, `budgetShortfall`, `captureBuilderHandoffFromCatalog` use `loadTaskRecipe`; the capture input gains `tag?: string`)
- Modify: `controller/src/cli.ts:795-815` (`builder-handoff`: `loadTaskRecipe(values.task)`)
- Test: `controller/test/targets-catalog.test.ts`, `controller/test/builder-handoff.test.ts`

- [ ] **Step 1: Write the failing tests**

`targets-catalog.test.ts`, in `describe("task catalog")` (it has `tasksDirFor` and `targetsDir`):

```ts
  it("loads a task without its image, where loadTask needs one", () => {
    const { root, pin } = repo()
    // A target with no image at the pin: loadTask cannot load it, loadTaskRecipe can.
    const targets = targetsDir(pin, { images: undefined })
    const tasks = tasksDirFor()
    const options = { targetsDir: targets, tasksDir: tasks, repositoryRoot: root }
    expect(() => loadTask("k", options)).toThrow()
    const recipe = loadTaskRecipe("k", options)
    expect(recipe.id).toBe("k")
    expect(recipe.target.id).toBe("t")
    expect(recipe.target.pin).toBe(pin)
    expect(recipe.target).not.toHaveProperty("image")
    expect(recipe.checks.independent.file).toBe("checks/k.test.ts")
    expect(recipe.specText).toContain("A1:")
  })
```

`builder-handoff.test.ts`, in the first test, the capture is `captureBuilderHandoff(loadTaskRecipe("cli-flags"), { workOrderId, captureRoot: app })` and its target block expectation is `image: recipeTag(task.target)` (import `recipeTag` from `../src/lib/targets/images.ts`, `loadTaskRecipe` from the catalog); add:

```ts
  it("names the tag it is given: the one the work order bound", async () => {
    const { handoff } = await captureBuilderHandoff(loadTaskRecipe("cli-flags"), {
      captureRoot: tempDir("factory-handoff-app-"),
      tag: `b4-factory-cli-flags:${loadTaskRecipe("cli-flags").target.pin.slice(0, 12)}-0123456789ab`,
    })
    expect(handoff.target.image).toMatch(/-0123456789ab$/)
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/targets-catalog.test.ts test/builder-handoff.test.ts`
Expected: FAIL (`loadTaskRecipe` is not exported; `captureBuilderHandoff` has no `tag`).

- [ ] **Step 3: Implement**

`catalog.ts`: after the `Task` interface,

```ts
/**
 * A task with its target at the task's pin, without the target's image: what everything that
 * never reads the image loads (the CLI, the review's pin diff, prompts, budgets, the builder's
 * inspection options, the baseline capture). Loads whether or not this host has built the
 * image, and with no image registry configured at all.
 */
export interface TaskRecipe extends Omit<Task, "target"> {
  readonly target: TargetRecipe
}
```

Rename the body of `loadTask` to `export function loadTaskRecipe(id: string, options: CatalogOptions = {}): TaskRecipe`, with its one `loadTarget(...)` call becoming `loadTargetRecipe(...)` (same arguments), and make `loadTask`:

```ts
/** `loadTaskRecipe` with the target's image: for the few callers that run or digest it. */
export function loadTask(id: string, options: CatalogOptions = {}): Task {
  const recipe = loadTaskRecipe(id, options)
  return {
    ...recipe,
    target: loadTarget(recipe.target.id, { ...options, pin: recipe.target.pin }),
  }
}
```

`pin-diff-base.ts:26`, `baseline.ts:35`: `loadTask(…)` → `loadTaskRecipe(…)` (imports follow). `runtime.ts` `builderReader`: `targetInspectionOptions(loadTaskRecipe(requireTaskId(taskId)))`. `prompts.ts`: `promptFor` returns `taskPrompt(loadTaskRecipe(id, options))`; `taskPrompt` and `builderRules` take `TaskRecipe`. `workspace.ts`: `targetWorkspace(task: TaskRecipe, …)`, `targetInspectionOptions(task: TaskRecipe)`, `targetSandboxPolicy(target: TargetRecipe)`; `permissions.ts`: `builderPermissions(target: TargetRecipe)`. None of them reads `image`; `pnpm typecheck` confirms it.

`builder-handoff.ts`: `CaptureBuilderHandoffOptions` gains

```ts
  /**
   * The image tag the handoff names: the work order's bound tag (`image_bound`). This host's
   * recipe tag for the task when absent (`recipeTag`), which is what `factory builder-handoff`
   * writes for a lane with no controller.
   */
  readonly tag?: string
```

`captureBuilderHandoff(task: TaskRecipe, options)` builds its target block with `image: options.tag ?? recipeTag(task.target)` in place of `imageTag(task.target)`.

`factory.ts`: `targetOf` and `budgetShortfall` call `loadTaskRecipe(row.taskId, options.promptCatalog ?? {})`; the `captureBuilderHandoff` option's input gains `readonly tag?: string`, and `captureBuilderHandoffFromCatalog` passes `loadTaskRecipe(input.taskId, …)` and `...(input.tag !== undefined ? { tag: input.tag } : {})` (Task 13 supplies the bound tag).

`cli.ts` `builder-handoff`: `captureBuilderHandoff(loadTaskRecipe(values.task), …)`. Its output is unchanged in shape (`cli.test.ts:1053-1056` asserts a tag with `:<pin[:12]>-`, which the recipe tag keeps).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src examples/software-factory/controller/test/targets-catalog.test.ts examples/software-factory/controller/test/builder-handoff.test.ts
git commit -m "refactor(software-factory): everything that reads no image loads a task without one

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: `target.json` carries no images; `loadTarget` reads the registry; the script only warms it

The switch. After this task no file in the repository records an image id, and nothing but the registry does.

**Files:**
- Modify: `controller/src/lib/targets/catalog.ts` (schema; `loadTarget`; errors; `targetsDir`)
- Modify: `controller/src/lib/targets/prepare.ts` (delete `withImageAt`, `formatManifest`, `recordImage` and their imports)
- Modify: `controller/scripts/prepare-target.ts` (rewrite)
- Modify: `controller/targets/{cli,cli-flags,devkit}/target.json` (delete `images`)
- Create: `controller/test/setup-images.ts`, `controller/test/lane-images.ts`, `controller/test/lane-images.global.ts`, `controller/test/setup-lane-images.ts`
- Modify: `controller/vitest.config.ts`, `controller/vitest.sandbox.config.ts`, `controller/test/recipe-fixture.ts`
- Modify: `controller/test/devkit-second-pin.ts`, `controller/test/target-devkit-pin.integration.test.ts`, `controller/test/builder.integration.test.ts:290-300`
- Test: `controller/test/targets-catalog.test.ts:247-330,383-447`, `controller/test/targets-prepare.test.ts:136-245`, `controller/test/task-prompts.test.ts:60-100,131-135,235-280`, `controller/test/intake-draft.test.ts:305-369`, `controller/test/factory-intake.test.ts`, `controller/test/pin-diff-base.test.ts` (new)

- [ ] **Step 1: The setup files** (`test/static-images.ts` is Task 8's)

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
import { join } from "node:path"
import { configuredImages, loadTargetRecipe } from "../src/lib/targets/catalog.ts"
import { dockerImageBuilder } from "../src/lib/targets/image-builder.ts"
import { type EnsuredImage, type ImageRegistry, openImageRegistry } from "../src/lib/targets/images.ts"

declare module "vitest" {
  export interface ProvidedContext {
    /** The directory of this `test:sandbox` run's own image registry (`lane-images.global.ts`). */
    readonly laneImagesDir: string
  }
}

/**
 * The registry one `test:sandbox` run shares across its lane files, in a directory the run's
 * global setup created for it alone (`mkdtemp`): two worktrees, or two runs, on one host never
 * share a registry, and nothing survives the run but the images themselves on the daemon, which
 * the next run's `ensure` re-verifies and, by the build cache, rebuilds in seconds.
 */
export function openLaneImages(dir: string): ImageRegistry {
  return openImageRegistry({
    path: join(dir, "images.sqlite"),
    builder: dockerImageBuilder(),
    buildTimeoutMs: 1_140_000,
  })
}

/** Build (or re-verify) `targetId` at `pin` (its default pin when absent) in the run's registry. */
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
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestProject } from "vitest/node"
import { loadTargetRecipe } from "../src/lib/targets/catalog.ts"
import { openLaneImages } from "./lane-images.ts"

/**
 * Once per `test:sandbox` run: a registry directory of the run's own, handed to every lane file
 * (`provide`), and the two targets the lanes run at their default pins built (or re-verified)
 * in it. The opt-in `cli` run (`FACTORY_TEST_CLI_TARGET=1`, `test:sandbox:cli`) needs neither
 * and builds `cli` in its own lane. The teardown removes the registry file, never an image.
 */
export default async function setup(project: TestProject): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), "b4-factory-lane-images-"))
  project.provide("laneImagesDir", dir)
  if (process.env.FACTORY_TEST_CLI_TARGET !== "1") {
    const registry = openLaneImages(dir)
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
  return () => rmSync(dir, { recursive: true, force: true })
}
```

`test/setup-lane-images.ts`:

```ts
import { inject } from "vitest"
import { configureImages } from "../src/lib/targets/catalog.ts"
import { openLaneImages } from "./lane-images.ts"

configureImages(openLaneImages(inject("laneImagesDir")))
```

`vitest.sandbox.config.ts` gains, inside `test`:

```ts
    globalSetup: ["test/lane-images.global.ts"],
    setupFiles: ["test/setup-lane-images.ts"],
```

- [ ] **Step 2: Write the failing tests**

`targets-catalog.test.ts`: the fixture `manifest()` loses `images: { [pin]: image }`; the import list loses `ImageUnpreparedError`, `TargetUnpreparedError`, gains `configureImages`, `ImageNotBuiltError`, `ImagesUnconfiguredError`, `type TargetRecipe`; add `import { emptyImageRegistry, useImages } from "./static-images.ts"` and `import type { ImageRegistry } from "../src/lib/targets/images.ts"`. Replace the four tests at `:247-320` with:

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

  it("loads a task without an image where the registry has none", () => {
    const restore = useImages(emptyImageRegistry())
    try {
      const recipe = loadTaskRecipe("devkit-spawn-deadline")
      expect(recipe.target.id).toBe("devkit")
      expect(recipe.target).not.toHaveProperty("image")
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

  it("requires FACTORY_STATE_DIR and refuses FACTORY_TARGETS_DIR by name", async () => {
    const env = { ...process.env, PATH: pathWithoutDocker() }
    delete env.FACTORY_STATE_DIR
    expect((await run(["scripts/prepare-target.ts", "devkit"], env)).stderr).toContain(
      "FACTORY_STATE_DIR is required",
    )
    for (const name of ["FACTORY_TARGETS_DIR"])
      expect(
        (await run(["scripts/prepare-target.ts", "devkit"], { ...env, FACTORY_STATE_DIR: "/tmp/x", [name]: "1" })).stderr,
      ).toContain(`${name} is retired`)
  }, 90_000)
})
```

`task-prompts.test.ts`: `catalogs()` loses its `prepared` flag (both targets get `baseImage: \`node:24-slim@sha256:${"e".repeat(64)}\`` and no `images`). Prompts load a `TaskRecipe` since Task 8a, so a target without an image no longer stops a prompt: delete "throws for a task whose target is unprepared, naming why" (`:131`). "refuses, rather than throws, a dispatch whose task stopped loading after create" (`:235`) keeps its point (refused before the key, not replayed once the task loads again) but breaks the task another way: it overwrites `ready/target.json` with `"{"` between create and dispatch, expects `{ ok: false, state: "received", message: expect.stringMatching(/^Unknown task served: /) }`, restores the file, and expects the next `dispatch` to succeed.

`test/pin-diff-base.test.ts` (new): the export review's pin diff does not need an image.

```ts
import { afterEach, describe, expect, it } from "vitest"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { pinDiffBase } from "../src/lib/review/pin-diff-base.ts"
import { loadTaskRecipe } from "../src/lib/targets/catalog.ts"
import { emptyImageRegistry, useImages } from "./static-images.ts"

let restore: (() => void) | undefined
afterEach(() => restore?.())

describe("the export review's pin diff", () => {
  it("reads the target's files at the pin on a host that has built no image of it", () => {
    restore = useImages(emptyImageRegistry())
    const task = loadTaskRecipe("cli-flags")
    const base = pinDiffBase({ taskId: "cli-flags", pin: null } as unknown as WorkOrderRow)
    expect(base.label).toBe(`pin ${task.target.pin.slice(0, 12)}`)
    const path = task.manifest.allowedSourcePaths[0] as string
    expect(base.read(path).kind).toBe("bytes")
  })
})
```

The two subprocess tests of `factory builder-handoff` (`cli.test.ts:1046-1100`, which run the CLI with no setup file and so no registry) are the check that the CLI needs none: they must pass unchanged.

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

Task 8 declared the `images` variable after `resetCatalogForTests`, which is above `loadTarget` in `catalog.ts` (`:532-538` against `:315`): the function reads it at call time, so no move is needed.

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
git add examples/software-factory/controller/src/lib/targets/catalog.ts examples/software-factory/controller/src/lib/targets/prepare.ts examples/software-factory/controller/scripts/prepare-target.ts examples/software-factory/controller/targets examples/software-factory/controller/test/static-images.ts examples/software-factory/controller/test/setup-images.ts examples/software-factory/controller/test/lane-images.ts examples/software-factory/controller/test/lane-images.global.ts examples/software-factory/controller/test/setup-lane-images.ts examples/software-factory/controller/vitest.config.ts examples/software-factory/controller/vitest.sandbox.config.ts examples/software-factory/controller/test/recipe-fixture.ts examples/software-factory/controller/test/devkit-second-pin.ts examples/software-factory/controller/test/target-devkit-pin.integration.test.ts examples/software-factory/controller/test/builder.integration.test.ts examples/software-factory/controller/test/drafter-end-to-end.integration.test.ts examples/software-factory/controller/test/intake-oracle.integration.test.ts examples/software-factory/controller/test/target-cli.integration.test.ts examples/software-factory/controller/test/targets-catalog.test.ts examples/software-factory/controller/test/targets-prepare.test.ts examples/software-factory/controller/test/task-prompts.test.ts examples/software-factory/controller/test/intake-draft.test.ts examples/software-factory/controller/test/factory-intake.test.ts examples/software-factory/controller/test/pin-diff-base.test.ts
git commit -m "feat(software-factory): targets record no images; the host's registry does

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: A work order's budget can be paused, and a restart resumes it and ends a build it interrupted

**Files:**
- Modify: `controller/src/lib/controller/context.ts` (two members)
- Modify: `controller/src/lib/controller/factory.ts` (implement them beside `transition`; add them to `ctx`)
- Modify: `controller/src/lib/controller/reconcile.ts` (`reconcileWorkOrder`, before the `switch`)
- Test: `controller/test/factory-intake.test.ts`

- [ ] **Step 1: Write the failing test**

In `factory-intake.test.ts` (it has `forceRow`, `crash` and `bootFactory`; add `journalEvent(id, type, payload)` beside `journalHandoff`, with the same body appending one event):

```ts
  it("resumes, before any rule, a budget a restart left paused", async () => {
    await boot()
    const { id } = await createIssue()
    await crash()
    // What a controller killed mid-build leaves: an active row with its clock stopped, and a
    // build the journal shows started and never ended.
    forceRow(id, { state: "intake_running", activeMs: 1_234, activeStartedAt: null })
    journalEvent(id, "image_prepare_started", { targetId: "devkit", pin: PIN, key: "a".repeat(64), shared: false, deadlineMs: 1 })
    await bootFactory()
    const aborted = factory.events(id).filter((e) => e.type === "image_prepare_aborted")
    expect(aborted.map((e) => e.payload)).toEqual([{ targetId: "devkit", pin: PIN, reason: "restart" }])
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
  if (!ctx.isTracked(id)) {
    // A build the journal shows started and never ended, with nothing in this process waiting
    // on it: the controller died mid-build. Its end is written now, so the journal (and the
    // CLI's follower, which reads it) never shows a build in flight that nothing is running.
    const events = ctx.store.events(id)
    const last = [...events].reverse().find((e) => e.type.startsWith("image_prepare_"))
    if (last?.type === "image_prepare_started")
      ctx.recordEvent(id, "image_prepare_aborted", {
        targetId: last.payload.targetId,
        pin: last.payload.pin,
        reason: "restart",
      })
    if (ACTIVE_STATES.has(current.state) && current.activeStartedAt === null)
      ctx.resumeBudget(id, "reconcile")
  }
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
   * Intake: every attempt builds (or re-verifies) and binds what it proves its oracle in.
   * Dispatch: a work order already bound keeps its binding while the daemon holds that image
   * (D5), and only an unbound one prepares and binds.
   */
  readonly rebind: boolean
}

/**
 * The image work order `id` runs in. Bound already (and not rebinding): the bound image, if
 * the daemon still holds it, else `image_changed`. Otherwise `recipe`'s image (a target at the
 * work order's pin): the registry's recorded image re-verified on the daemon, or a build of it,
 * sharing any build of the same recipe in flight; journalled (`image_prepare_started` with its
 * wait bound, `image_prepared`, `image_prepare_failed`, `image_prepare_aborted`,
 * `image_missing`), its log stored as evidence, the work order's budget paused while a build
 * runs for it, and the result bound (`image_bound`).
 */
export async function prepareWorkOrderImage(
  ctx: ControllerContext,
  id: string,
  recipe: TargetRecipe,
  signal: AbortSignal,
  options: PrepareWorkOrderImageOptions,
): Promise<WorkOrderImage> {
  if (!options.rebind) {
    const bound = boundImageOf(ctx.store.events(id))
    if (bound !== undefined) {
      if (await requireImages().present(bound.image.localId, signal)) return { ok: true, bound }
      ctx.recordEvent(id, "image_changed", {
        bound: bound.image.localId,
        boundKey: bound.key,
        reason: "gone",
      })
      return {
        ok: false,
        kind: "changed",
        reason: `work order ${id} is bound to image ${bound.image.localId} (target ${bound.targetId} at ${bound.pin}), the one an earlier phase ran in, and this host no longer holds it: running and verifying in a rebuild would bind two environments. Cancel it and create a new work order`,
      }
    }
  }
  const need = { targetId: recipe.id, pin: recipe.pin }
  // Paused only when a build starts or is joined for this work order: re-verifying a recorded
  // image takes milliseconds and is the work order's own time.
  let paused = false
  let ensured: EnsuredImage
  try {
    ensured = await requireImages().ensure(recipe, {
      signal,
      onMissing: ({ key, localId }) => ctx.recordEvent(id, "image_missing", { ...need, key, localId }),
      onBuild: ({ key, shared, deadlineMs }) => {
        ctx.recordEvent(id, "image_prepare_started", { ...need, key, shared, deadlineMs })
        paused = ctx.pauseBudget(id, "image_prepare")
      },
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
  const bound: BoundImage = { ...need, key: ensured.key, tag: ensured.tag, image: ensured.image }
  ctx.recordEvent(id, "image_bound", { ...bound })
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
      // Paused as the build started for this work order, resumed as its wait ended.
      expect(types.indexOf("budget_paused")).toBe(types.indexOf("image_prepare_started") + 1)
      expect(types.indexOf("budget_resumed")).toBeGreaterThan(types.indexOf("budget_paused"))
      expect(eventsOf(id, "image_prepare_started")[0]?.payload.deadlineMs).toBeGreaterThan(0)
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
Expected: PASS once the one whole-journal assertion in `factory-intake.test.ts` ("runs the drafter turn, reads and proves the draft, and parks the generated task", `:257`; its `expect(eventTypes(id)).toEqual([…])` at `:278`) gains `"image_bound:"` between `"draft_read:"` and `"task_generated:"`. Under the static registry nothing is built, so no `image_prepare_*` or `budget_*` events appear there; no other intake test lists the whole journal.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/controller/intake.ts examples/software-factory/controller/src/lib/domain/states.ts examples/software-factory/controller/test/factory-intake.test.ts examples/software-factory/controller/test/states.test.ts
git commit -m "feat(software-factory): intake builds the drafted target's image at the fit step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Dispatch prepares the task's image before anything is spent, honours the route's cancel, and re-checks the approved digest

**Files:**
- Modify: `controller/src/lib/controller/factory.ts` (`Factory.dispatch` gains `options?: { signal?: AbortSignal }`; `dispatch`: `const row` → `let row`, the approved-digest check factored into `approvedDigestRefusal` and run before and after the image step, the image before `prompt`, the bound tag into the capture; `transition`: abort a waiting image; `imageWaitSignal`; `prepareDispatchImage`)
- Modify: `controller/src/app/work-orders/dispatch/index.ts` (pass `{ signal: ctx.signal }`)
- Test: `controller/test/factory-dispatch.test.ts`, `controller/test/factory-intake.test.ts`, `controller/test/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

In `factory-dispatch.test.ts`, copy Task 12's `fakeImages`, `until` and `eventsOf` helpers, add a `journal(id, type, payload)` helper beside `boot` (the body of `factory-intake.test.ts`'s `journalHandoff`: `openRegistry(join(dir, "registry.sqlite"))`, `createWorkOrderStore(registry.db).appendEvent(id, type, payload, new Date().toISOString())`, `registry.close()`), and:

```ts
describe("the task's image at dispatch", () => {
  it("builds it while the row waits in received, binds it, and hands the builder its tag", async () => {
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
      expect(handoffTags).toEqual([bound?.payload.tag])
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
      expect(refused.message).toMatch(
        /^the image of target cli-flags at [0-9a-f]{40} could not be built: .*docker build failed \(build log: artifact [0-9a-f]{64}\)$/,
      )
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

  it("cancels the work order when the caller's signal aborts during the build", async () => {
    await boot()
    const images = fakeImages()
    images.builder.hold()
    try {
      const { id } = await factory.create({ taskId: "cli-flags" })
      const route = new AbortController()
      const dispatching = factory.dispatch(id, undefined, { signal: route.signal })
      await until(() => eventsOf(id, "image_prepare_started").length === 1)
      route.abort(new Error("the runtime cancelled the dispatch run"))
      expect(await dispatching).toMatchObject({ ok: false, state: "cancelled" })
      await until(() => images.builder.aborted === 1)
      const cancel = factory.events(id).find((e) => e.type === "transition" && e.payload.event === "cancel")
      expect(cancel?.payload.operationKey).toBe(`cancel:${id}:aborted-dispatch`)
    } finally {
      images.builder.release()
      images.restore()
    }
  })

  it("keeps a binding whose image the daemon holds, and refuses one it no longer holds", async () => {
    await boot()
    const images = fakeImages()
    try {
      const { id } = await factory.create({ taskId: "cli-flags" })
      const recipe = loadTaskRecipe("cli-flags").target
      const built = await images.registry.ensure(recipe, { signal: AbortSignal.timeout(5_000) })
      // Bound earlier to an image a later build of the same key superseded, still on the daemon.
      const earlier = { ...built.image, localId: `sha256:${"7".repeat(64)}` }
      images.builder.daemon.set(earlier.localId, [])
      journal(id, "image_bound", { targetId: "cli-flags", pin: recipe.pin, key: built.key, tag: built.tag, image: earlier })
      expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
      expect(images.builder.requests).toHaveLength(1)
      expect(eventsOf(id, "image_bound")).toHaveLength(1)

      const { id: other } = await factory.create({ taskId: "cli-flags", operationKey: "other" })
      const gone = { ...built.image, localId: `sha256:${"6".repeat(64)}` }
      journal(other, "image_bound", { targetId: "cli-flags", pin: recipe.pin, key: built.key, tag: built.tag, image: gone })
      const refused = await factory.dispatch(other)
      expect(refused).toMatchObject({ ok: false, state: "received" })
      expect(refused.message).toMatch(/is bound to image sha256:6{64} .* no longer holds it: .* Cancel it and create a new work order$/)
      expect(eventsOf(other, "image_changed")[0]?.payload).toEqual({ bound: gone.localId, boundKey: built.key, reason: "gone" })
    } finally {
      images.restore()
    }
  })
})
```

`handoffTags` is a `string[]` the file's `boot` fills by wrapping `fakeBuilderHandoff`: `captureBuilderHandoff: async (input) => { handoffTags.push(input.tag ?? "(none)"); return fakeBuilderHandoff(input) }`, reset in `afterEach`. The whole-journal assertion in "runs the worker turn into the verifying phase and journals the order of events" (`:104`, its `expect(types).toEqual([…])` at `:125`) gains `"image_bound:"` between `"created:"` and `"builder_source_staged:"`.

In `factory-intake.test.ts`, after "approves only the digest on disk, then dispatch runs rung 2 on the generated task" (`:1016`):

```ts
  it("re-checks the approved digest after the image step, however long it took", async () => {
    await boot()
    const { id } = await intake()
    const parked = await factory.settleIntake(id, 20_000)
    const taskDigest = parked.taskDigest as string
    expect((await factory.approveIntake(id, { revision: parked.revision, taskDigest })).ok).toBe(true)
    const spec = join(generated, id, "spec.md")
    // The generated task changes on disk while dispatch waits on its image.
    const base = configuredImages() as ImageRegistry
    const restore = useImages({
      recorded: (recipe) => base.recorded(recipe),
      ensure: (recipe, options) => base.ensure(recipe, options),
      close: () => {},
      async present() {
        writeFileSync(spec, `${readFileSync(spec, "utf8")}\nA9: edited during the wait\n`)
        return true
      },
    })
    try {
      expect(await factory.dispatch(id)).toEqual({
        ok: false,
        state: "received",
        message: "Generated task on disk no longer matches the approved digest",
      })
      expect(eventsOf(id, "generated_task_changed").at(-1)?.payload).toMatchObject({ phase: "dispatch_after_image" })
      expect(threadPosts()).toHaveLength(1)
    } finally {
      restore()
    }
  })
```

(`configuredImages` from the catalog; `useImages` from `./static-images.ts`; `ImageRegistry` from `../src/lib/targets/images.ts`.)

In `cli.test.ts`, through the route: `boot` accepts `images` (Task 14 adds the option; add it here), and

```ts
  it("cancels a dispatch the operator cancels while it builds its image", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const imagesDir = mkdtempSync(join(tmpdir(), "factory-cli-images-"))
    const images = openImageRegistry({ path: join(imagesDir, "images.sqlite"), builder, platform: "linux/arm64" })
    const restore = useImages(images)
    try {
      const { env, stateDir } = await boot({ images })
      const { stdout: createdOut } = await run(process.execPath, [tsxBin, cliEntry, "create", "--task", "cli-flags"], { env, cwd: packageRoot })
      const id = JSON.parse(createdOut).row.id as string
      const dispatching = run(process.execPath, [tsxBin, cliEntry, "dispatch", id], { env, cwd: packageRoot })
      await pollEvents(stateDir, id, (types) => types.includes("image_prepare_started"))
      const cancelled = await run(process.execPath, [tsxBin, cliEntry, "cancel", id], { env, cwd: packageRoot })
      expect(JSON.parse(cancelled.stdout)).toMatchObject({ ok: true })
      const { stdout } = await dispatching
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "cancelled" })
      expect(await pollState(stateDir, id, (state) => state === "cancelled")).toBe("cancelled")
      expect(builder.aborted).toBe(1)
    } finally {
      builder.release()
      restore()
      images.close()
      rmSync(imagesDir, { recursive: true, force: true })
    }
  }, 90_000)
```

`pollEvents(stateDir, id, predicate)` sits beside the file's `pollState` with the same shape, reading `openRegistryReader(join(stateDir, "registry.sqlite")).events(id).map((e) => e.type)`. The CLI's `cancel` interrupts the dispatch's run (`controller.interrupt(id)`), which aborts the route's `ctx.signal`: before this task nothing listened to it until `settleOutcome`, after the build.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-dispatch.test.ts test/factory-intake.test.ts test/cli.test.ts -t "image|approved digest after"`
Expected: FAIL (no build at dispatch; `loadTask` throws `ImageNotBuiltError` in the capture; the route's abort is ignored; the digest is not re-checked).

- [ ] **Step 3: Implement**

`factory.ts`, the `Factory` interface's `dispatch`:

```ts
  /**
   * `signal`: the caller's own (the dispatch route's `ctx.signal`). Aborted while dispatch waits
   * on the task's image, it cancels the work order as `settleOutcome` would after the wait.
   */
  dispatch(
    id: string,
    operationKey?: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CommandOutcome>
```

Beside `phases`:

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
   * The image the row's task runs in: its binding if it has one the daemon still holds, else
   * prepared (built, joined or re-verified) and bound. `undefined` when the task does not load:
   * `prompt` then refuses it with the catalog's own reason.
   */
  async function prepareDispatchImage(
    id: string,
    row: WorkOrderRow,
    signal: AbortSignal,
  ): Promise<{ readonly refusal: string } | { readonly bound: BoundImage } | undefined> {
    let recipe: TargetRecipe
    try {
      recipe = loadTaskRecipe(row.taskId, options.promptCatalog ?? {}).target
    } catch {
      return undefined
    }
    const result = await prepareWorkOrderImage(ctx, id, recipe, signal, { rebind: false })
    if (result.ok) return { bound: result.bound }
    return {
      refusal:
        result.kind === "aborted"
          ? `Work order ${id} left received while its image was being prepared`
          : result.reason,
    }
  }

  /** The approved generated task's digest, re-read from disk: a refusal, or undefined when it holds. */
  function approvedDigestRefusal(id: string, row: WorkOrderRow, phase: string): CommandOutcome | undefined {
    if (row.taskDigest === null || row.state !== "received") return undefined
    const onDisk = diskTaskDigest(id)
    if ("error" in onDisk) {
      recordEvent(id, "generated_task_unreadable", { phase, error: String(onDisk.error) })
      return { ok: false, state: row.state, message: `Generated task unreadable: ${String(onDisk.error)}` }
    }
    if (onDisk.digest !== row.taskDigest) {
      recordEvent(id, "generated_task_changed", { phase, approved: row.taskDigest, onDisk: onDisk.digest })
      return { ok: false, state: row.state, message: "Generated task on disk no longer matches the approved digest" }
    }
    return undefined
  }
```

In `dispatch(id, operationKey, dispatchOptions = {})`: `const row = mustGet(id)` becomes `let row = mustGet(id)`; the inline digest block at the top (`if (row.taskDigest !== null && row.state === "received") { … }`) becomes

```ts
      const changed = approvedDigestRefusal(id, row, "dispatch")
      if (changed !== undefined) return changed
```

and directly after it:

```ts
      // The image the task runs in (spec item 4), before anything is spent: its binding if it
      // has one the daemon still holds, else built (or re-verified) and bound. The row waits in
      // `received`, which is not active, so a build costs its budget nothing. A cancel (any
      // transition out of `received`) or the caller's own signal (the route, cancelled by the
      // runtime when the operator cancels) abandons the wait; the caller's abort also cancels
      // the work order, as `settleOutcome` does once a dispatch is running. Before the key: a
      // failed build is not a function of the row's revision, and the dispatch after it must
      // build again, not replay this refusal.
      let bound: BoundImage | undefined
      if (row.state === "received" && !options.tasks) {
        const signal = AbortSignal.any([
          imageWaitSignal(id),
          ...(dispatchOptions.signal !== undefined ? [dispatchOptions.signal] : []),
        ])
        const image = await prepareDispatchImage(id, row, signal)
        if (dispatchOptions.signal?.aborted && isNonTerminalAndNotCancelling(mustGet(id)))
          await factory.cancel(id, `cancel:${id}:aborted-dispatch`).catch(() => undefined)
        row = mustGet(id)
        if (image !== undefined && "refusal" in image)
          return { ok: false, state: row.state, message: image.refusal }
        if (row.state !== "received")
          return { ok: false, state: row.state, message: `Cannot dispatch from ${row.state}` }
        bound = image?.bound
        // The wait may have been long: what the person approved must still be what is on disk.
        const changedDuring = approvedDigestRefusal(id, row, "dispatch_after_image")
        if (changedDuring !== undefined) return changedDuring
      }
```

with `const isNonTerminalAndNotCancelling = (r: WorkOrderRow) => !isTerminal(r.state) && r.state !== "cancel_requested"` beside `mustGet`. The capture call passes the bound tag: `…({ taskId: row.taskId, workOrderId: id, signal: abort.signal, ...(bound !== undefined ? { tag: bound.tag } : {}) })`. Imports: `prepareWorkOrderImage`, `type BoundImage` from `./images.js`; `loadTaskRecipe`, `type TargetRecipe` from the catalog.

`app/work-orders/dispatch/index.ts`: `const outcome = await factory.dispatch(id, operationKey, { signal: ctx.signal })`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/controller/factory.ts examples/software-factory/controller/src/app/work-orders/dispatch/index.ts examples/software-factory/controller/test/factory-dispatch.test.ts examples/software-factory/controller/test/factory-intake.test.ts examples/software-factory/controller/test/cli.test.ts
git commit -m "feat(software-factory): dispatch prepares the task's image before anything is spent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

> **As landed:** also updated the `factory-cancel` and `factory-builder-handoff` test
> expectations: a cancel during the image wait refuses the dispatch before any thread is created.

### Task 13a: The verifier, the oracle proof and approve's re-verification run the bound image by ID

Moved into PR 1 after review (item 3), so identity is never half enforced: from this task on, every verdict is earned in the image the work order bound, by ID, and the receipt, the policy and the bundle all digest that image object. The binding is authoritative (D5): a registry record replaced by a later build of the key strands nothing while the bound image exists; a bound ID the daemon no longer holds is refused. PR 2 then only moves the builder.

**Files:**
- Modify: `controller/src/lib/targets/catalog.ts` (`CatalogOptions.image`)
- Modify: `controller/src/lib/verification/verifier.ts` (`VerifyInput.image`)
- Modify: `controller/src/lib/verification/policy.ts:19-53` (`loadPolicy(taskId, image)`)
- Modify: `controller/src/lib/verification/docker-verifier.ts:40-53` (run by id; `ImageGoneError`; `present` option)
- Modify: `controller/src/lib/intake/oracle.ts` (`ProveOracleInput.image`)
- Modify: `controller/src/lib/controller/intake.ts:385-405` (policy and proof from the fit step's binding)
- Modify: `controller/src/lib/controller/verify.ts:44-60,170-180` (the binding, `image_unbound`, `loadPolicy` inside a guard)
- Modify: `controller/src/lib/controller/factory.ts:1369-1376,1455-1464` (approve: the binding for the policy and the re-verification)
- Test: `controller/test/docker-verifier.test.ts` (new, no Docker), `controller/test/factory-verify.test.ts`, `controller/test/factory-intake.test.ts`, `controller/test/factory-approve.test.ts`, `controller/test/targets-catalog.test.ts`; every direct caller of `verify`, `proveOracle` or `loadPolicy` in `controller/test` (`grep -rn "\.verify(\|proveOracle(\|loadPolicy(" examples/software-factory/controller/test` lists them) passes the image: `loadTask(<taskId>).target.image`

- [ ] **Step 1: Write the failing tests**

`targets-catalog.test.ts`:

```ts
  it("loads a target with the image it is given, without asking the registry", () => {
    const { root, pin } = repo()
    const restore = useImages(emptyImageRegistry())
    try {
      const target = loadTarget("t", { targetsDir: targetsDir(pin), repositoryRoot: root, image })
      expect(target.image).toEqual(image)
    } finally {
      restore()
    }
  })
```

`test/docker-verifier.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createArtifactStore } from "../src/lib/storage/artifacts.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { createDockerVerifier, ImageGoneError } from "../src/lib/verification/docker-verifier.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("the verifier's image", () => {
  it("refuses, before any container, a bound image the daemon no longer holds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-verifier-unit-"))
    dirs.push(dir)
    const asked: string[] = []
    const verifier = createDockerVerifier(createArtifactStore(join(dir, "artifacts")), {
      stagingRoot: dir,
      present: async (localId) => {
        asked.push(localId)
        return false
      },
    })
    const image = { ...loadTask("cli-flags").target.image, localId: `sha256:${"7".repeat(64)}` }
    const verifying = verifier.verify(
      { workOrderId: "wo-1", taskId: "cli-flags", candidateDigest: "a".repeat(64), changes: {}, policyDigest: "b".repeat(64), image },
      AbortSignal.timeout(5_000),
    )
    await expect(verifying).rejects.toThrow(ImageGoneError)
    await expect(verifying).rejects.toThrow(
      `The work order is bound to image ${image.localId} (target cli-flags), which this host no longer holds: its verdict cannot be earned in the environment it is bound to`,
    )
    expect(asked).toEqual([image.localId])
  })
})
```

`factory-verify.test.ts`: in the file's first dispatch-to-verification test, `verifier.calls.at(-1)?.image` equals `boundImageOf(factory.events(id))?.image`; add a test that forces a row into `verifying` with no `image_bound` in its journal (the file's `forceRow`, on a work order created but never dispatched, with `workerThreadId` set to a thread its reader serves) and expects it to settle `blocked` / `verification_inconclusive` with one `image_unbound` event and no verifier call. `factory-intake.test.ts`: in "runs the drafter turn, reads and proves the draft, and parks the generated task" (`:257`), `verifier.calls[0]?.image` equals the `image_bound` payload's `image`. `factory-approve.test.ts`: the re-verification's `verifier.calls.at(-1)?.image` equals the binding's image.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/docker-verifier.test.ts test/targets-catalog.test.ts test/factory-verify.test.ts test/factory-intake.test.ts test/factory-approve.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`catalog.ts`, `CatalogOptions` gains

```ts
  /**
   * The image to load the target with, instead of the registry's record: a work order's
   * binding (`image_bound`), which is authoritative for everything that runs or digests it.
   */
  readonly image?: Image
```

and `loadTarget` becomes `const recorded = options.image ?? images?.recorded(recipe)?.image`, throwing `ImagesUnconfiguredError` only when neither is available and `ImageNotBuiltError` when the registry has none: 

```ts
export function loadTarget(id: string, options: CatalogOptions = {}): Target {
  const recipe = loadTargetRecipe(id, options)
  if (options.image !== undefined) return { ...recipe, image: options.image }
  if (images === undefined) throw new ImagesUnconfiguredError()
  const recorded = images.recorded(recipe)
  if (recorded === undefined) throw new ImageNotBuiltError(recipe.id, recipe.pin)
  return { ...recipe, image: recorded.image }
}
```

(`loadTask` already forwards its options to `loadTarget`, Task 8a.)

`verifier.ts`, `VerifyInput` gains

```ts
  /**
   * The image the work order bound (`image_bound`): the verdict is earned in this image, by
   * its id, and the receipt's environment identity digests this object.
   */
  readonly image: Image
```

`policy.ts`: `loadPolicy(taskId: string, image: Image)` loads `loadTask(taskId, { image })`; `policyEnvironment` is unchanged (it reads `task.target.image`, now the bound one).

`docker-verifier.ts`:

```ts
/** The work order's bound image is gone from the daemon. */
export class ImageGoneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ImageGoneError"
  }
}
```

`DockerVerifierOptions` gains

```ts
  /** Does the daemon hold an image id? The configured registry's `present` when absent. */
  readonly present?: (localId: string, signal: AbortSignal) => Promise<boolean>
```

and the top of `verify` becomes:

```ts
      const task = loadTask(input.taskId, { image: input.image })
      const target = task.target
      const present = options.present ?? ((localId, signal) => requireImages().present(localId, signal))
      if (!(await present(input.image.localId, signal)))
        throw new ImageGoneError(
          `The work order is bound to image ${input.image.localId} (target ${target.id}), which this host no longer holds: its verdict cannot be earned in the environment it is bound to`,
        )
      const deadlineMs = options.deadlineMs ?? target.resources.verifierDeadlineMs
      // By id, never by tag: a tag names whatever was built or tagged last.
      const provider = dockerSandbox({ scope: "software-factory-verifier", image: input.image.localId })
      const identity = environmentIdentity(target)
```

(`requireImages` from `../controller/images.js`; `imageTag` is no longer imported). A throw here rejects `verify`, which every caller already journals as `verifier_unavailable` and settles `inconclusive`.

`oracle.ts`: `ProveOracleInput` gains `readonly image: Image`, passed into the `verify` input.

`intake.ts`: `const policy = loadPolicy(id)` becomes `const policy = loadPolicy(id, image.bound.image)` (the fit step's binding, Task 12), and `proveOracle` receives `image: image.bound.image`.

`verify.ts` `verifyCandidate`: replace `const policy = loadPolicy(row.taskId)` (`:46`, outside any guard today; a throw there reached only the phase backstop) with

```ts
  // The image the work order bound: the verdict is earned in it or not at all, and the policy
  // digests it. A row with no binding (dispatched before images were bound) is not verified
  // in whatever the registry names now.
  const bound = boundImageOf(ctx.store.events(id))
  if (bound === undefined) {
    ctx.recordEvent(id, "image_unbound", { phase: "verify" })
    if (ctx.mustGet(id).state === "verifying")
      ctx.transition(id, "receipt_inconclusive", { blockedReason: "verification_inconclusive" })
    return
  }
  let policy: ReturnType<typeof loadPolicy>
  try {
    policy = loadPolicy(row.taskId, bound.image)
  } catch (error) {
    ctx.recordEvent(id, "policy_unavailable", { phase: "verify", error: String(error) })
    if (ctx.mustGet(id).state === "verifying")
      ctx.transition(id, "receipt_inconclusive", { blockedReason: "verification_inconclusive" })
    return
  }
```

and the `verify` input gains `image: bound.image`.

`factory.ts` approve: before the policy guard (`:1369`),

```ts
      const bound = boundImageOf(store.events(id))
      if (bound === undefined) {
        recordEvent(id, "image_unbound", { phase: "export" })
        return refuse("The work order has no bound image to re-verify in")
      }
```

the guarded `loadPolicy(row.taskId)` becomes `loadPolicy(row.taskId, bound.image)`, and the re-verification input (`:1455-1464`) gains `image: bound.image`. The frozen-policy comparison (`:1398`) is now a comparison of two digests of the same bound image, so a registry record replaced since the freeze no longer invalidates consent; a changed recipe (another key) still cannot, because the binding does not change after dispatch.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src examples/software-factory/controller/test
git commit -m "feat(software-factory): every verdict is earned in the bound image, by id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

> **As landed:** review added a guarded read of the binding in approve (an unreadable or missing
> binding is `image_unbound`), `bindingMoved` (`image_changed`, reason `target_moved`, for a
> binding naming another target or pin than the task), `ImageGoneError` journalled as
> `image_changed` with reason `gone`, and a test that the bound image beats a later registry
> record of the same key.

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
describe("imageWaitBoundMs", () => {
  it("is the longest journalled wait bound, or 0", () => {
    expect(imageWaitBoundMs([event("transition", {})])).toBe(0)
    expect(
      imageWaitBoundMs([
        event("image_prepare_started", { deadlineMs: 5_400_000 }),
        event("image_prepare_started", { deadlineMs: 90_000 }),
      ]),
    ).toBe(5_400_000)
  })
})

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

`cli.test.ts` (`boot`'s `images` option came in Task 13); add, after the dispatch-follow test at `:444`:

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

/** The longest wait bound (`deadlineMs`: queue and build) any `image_prepare_started` in `events` journalled. */
export function imageWaitBoundMs(events: readonly Pick<FactoryEvent, "type" | "payload">[]): number {
  let bound = 0
  for (const event of events)
    if (event.type === "image_prepare_started" && typeof event.payload.deadlineMs === "number")
      bound = Math.max(bound, event.payload.deadlineMs)
  return bound
}
```

`factory.ts`: rename the `dispatch` method's body to a local `async function dispatchOnce(id: string, operationKey?: string, dispatchOptions: { readonly signal?: AbortSignal } = {}): Promise<CommandOutcome>` (Task 13's body, unchanged; its `factory.cancel` call is unaffected), and make the method

```ts
    async dispatch(id, operationKey, dispatchOptions) {
      const mark = store.events(id).at(-1)?.seq ?? 0
      const outcome = await dispatchOnce(id, operationKey, dispatchOptions)
      // A refusal after an image build started for this dispatch is journalled, so a caller
      // that lost the request (the CLI's fallback) can tell a dispatch that ended in `received`
      // from one still preparing its image. Other refusals write nothing new, as before.
      if (
        !outcome.ok &&
        store.events(id).some((e) => e.seq > mark && e.type === "image_prepare_started")
      )
        recordEvent(id, "dispatch_refused", { message: outcome.message })
      return outcome
    },
```

No existing test's journal changes: under the static registry nothing is built, so no refusal is preceded by an `image_prepare_started`.

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
   * deadline is extended by `workingGraceMs` of those events.
   */
  readonly working?: (events: readonly FactoryEvent[]) => boolean
  readonly workingGraceMs?: (events: readonly FactoryEvent[]) => number
}
```

In `followRow`, after `journalled`:

```ts
  const after = () => read((reader) => reader.events(id)).filter((e) => e.seq > before.seq)
  const working = () => events?.working?.(after()) ?? false
```

and the second `pollRow` becomes

```ts
  const row = await pollRow(
    id,
    (r) =>
      r !== null &&
      ((!active.has(r.state) && !working()) || journalled(events?.refused) !== undefined),
    (r) => (r?.maxActiveMs ?? 0) + POLL_GRACE_MS + (events?.workingGraceMs?.(after()) ?? 0),
    1_000,
  )
```

The `dispatch` case passes as `awaiting`'s fifth argument

```ts
          {
            arrived: "image_prepare_started",
            refused: "dispatch_refused",
            working: dispatchPreparing,
            // The controller journals each wait's own bound (queue and build, from ITS
            // configuration), so the CLI never guesses the controller's settings.
            workingGraceMs: imageWaitBoundMs,
          },
```

(imports: `dispatchPreparing`, `imageWaitBoundMs` from `./lib/controller/images.js`, `type FactoryEvent` from the domain). A dispatch that builds nothing writes no `image_prepare_started`; its arrival is still read from the revision as before. Add to the usage text's `dispatch …` paragraph (`:92`): "A dispatch that first builds its target's image (the first time this host needs it) is followed through the build: its journal lines are the arrival, and `dispatch_refused` is its end when it refuses."

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/controller/images.ts examples/software-factory/controller/src/lib/controller/factory.ts examples/software-factory/controller/src/cli.ts examples/software-factory/controller/test/work-order-images.test.ts examples/software-factory/controller/test/factory-dispatch.test.ts examples/software-factory/controller/test/task-prompts.test.ts examples/software-factory/controller/test/cli.test.ts
git commit -m "feat(software-factory): the CLI follows a dispatch through its image build

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

> **As landed:** review added: the follow ends when reconciliation aborts the build on a restart
> (`image_prepare_aborted`, reason `restart`); `dispatch_refused` is journalled on a throw too,
> except `CommandInFlightError` (the key holder journals its own end); the follow's wait is
> clamped to the journalled `deadlineMs`; and a follow that runs out says the work order is
> "still preparing its image".

### Task 15: The Docker proofs: an unprepared pin built at intake with the script's identity; a moved tag moves nothing

Spec §4's Docker proof; the moved-tag half of drift against a real daemon (the deleted-image half is Task 5's, in the unit suite, because this plan runs no `docker rmi`); and the verifier running the bound image by ID (Task 13a) whatever the recipe tag names.

**Files:**
- Create: `controller/test/images-on-demand.integration.test.ts`
- Modify: `controller/test/docker-verifier.integration.test.ts`

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

  it("re-points a moved recipe tag without rebuilding", async () => {
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

The deleted-image half of drift is proved in the unit suite (Task 5): this plan runs no `docker rmi`, `docker image rm` or prune on the shared host, and removing a real image would cost a rebuild the lane budget cannot spare.

In `docker-verifier.integration.test.ts`, every `verify` input gains `image: task.target.image` (the file's module-level `const task = loadTask("cli-flags")`, which the lanes' registry answers), and `policy` becomes `loadPolicy("cli-flags", task.target.image)`. Add, using the file's `verifierFor()` and the input shape of its "passes the reference repair" test:

```ts
  it("verifies in the bound image by id whatever the recipe tag names, and refuses one the daemon lacks", async () => {
    const tag = imageTag(task.target)
    // Point the recipe tag at another image (the drafter's base, already on the daemon); the
    // finally puts it back on the bound image, as the registry's next `ensure` would.
    execFileSync("docker", ["tag", loadTargetRecipe("cli-flags").baseImage, tag])
    try {
      const receipt = await (await verifierFor()).verify(
        {
          workOrderId: "wo-tag",
          taskId: "cli-flags",
          candidateDigest: "a".repeat(64),
          changes: { [allowed]: await applyReference() },
          policyDigest: policy.policyDigest,
          image: task.target.image,
        },
        AbortSignal.timeout(280_000),
      )
      expect(receipt.verdict).toBe("pass")
      expect(receipt.environmentIdentity).toBe(environmentIdentity(task.target))
      await expect(
        (await verifierFor()).verify(
          {
            workOrderId: "wo-gone",
            taskId: "cli-flags",
            candidateDigest: "a".repeat(64),
            changes: {},
            policyDigest: policy.policyDigest,
            image: { ...task.target.image, localId: `sha256:${"7".repeat(64)}` },
          },
          AbortSignal.timeout(60_000),
        ),
      ).rejects.toThrow(ImageGoneError)
    } finally {
      execFileSync("docker", ["tag", task.target.image.localId, tag])
    }
  }, 600_000)
```

(imports: `execFileSync`; `imageTag` from `../src/lib/targets/images.ts`; `environmentIdentity`, `loadTargetRecipe` from the catalog; `ImageGoneError` from the verifier.) A pass here, in the image the tag no longer names, is the proof the verdict was earned in the bound id.

- [ ] **Step 2: Run the lanes (Docker required)**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run --config vitest.sandbox.config.ts test/images-on-demand.integration.test.ts test/docker-verifier.integration.test.ts`
Expected: PASS. The first run on a host without the `SECOND_PIN` devkit image takes minutes; a second run is fast (cache). If `script.printed.localId` differs from the bound one, check that nothing pruned the build cache between the two builds (trap 10) before suspecting the code.

- [ ] **Step 3: Commit**

```bash
git add examples/software-factory/controller/test/images-on-demand.integration.test.ts examples/software-factory/controller/test/docker-verifier.integration.test.ts
git commit -m "test(software-factory): an unprepared pin is built at intake; a moved tag moves no verdict

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

> **As landed:** also updated `drafter-end-to-end.integration.test.ts`'s expected event list for
> the fit-step build and binding, and added a verifier test that runs the bound image by id
> whatever the recipe tag names.

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

Expected: `ci.yml` 2 lines removed; each fixture exactly 1 line changed (its one `run` string). Each string occurs exactly once in each file at `38fcb3dd` (checked 2026-09-25 with `grep -c`); the script's assertion stops the edit if a later change to the step has moved them, and the step's current `run` block is then the one to read.

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

> **As landed:** no deviations.

### Task 17: The README, the developer guide and the spec say what changed

**Files:**
- Modify: `examples/software-factory/README.md` (`:135`, `:155`, `:171`, `:283-290`, `:316`, `:630`, `:660`, `:673`, `:695`, `:703`, and every `target:prepare`)
- Modify: `docs/superpowers/runbooks/software-factory-rung2-developer-guide.md` (`:219`, `:464`, and every `target:prepare`)
- Modify: `docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md` (§4 "As landed", §7 table row)

- [ ] **Step 1: The README**

Replace the "prepare a target" instructions (`:283-290`, `:316`) with one paragraph:

> Images are built when a work order first needs them. The first intake or dispatch at a (target, pin) this host has never built builds the target's image from its committed recipe (the Dockerfile, the `imageContext` and lockfile at the pin, and the base image `target.json` pins by digest), records it in `<FACTORY_STATE_DIR>/images.sqlite`, journals the build (`image_prepare_started`, `image_prepared` with the build log's artifact digest, or `image_prepare_failed`) and binds it to the work order (`image_bound`). Concurrent work orders at one pin share one build; `FACTORY_MAX_IMAGE_BUILDS` (default 1) bounds builds across pins and `FACTORY_IMAGE_BUILD_TIMEOUT_MS` (default 30 minutes) each build. The build's time is not charged to the work order's budget. A failed build blocks an intake as `image_prepare_failed` (no drafter attempt spent) and refuses a dispatch (the row stays `received`; dispatch again to retry); the next need builds again. `target.json` records no image: `pnpm --filter @b4-example/software-factory-controller target:prepare <id> [--pin <sha>]` (with `FACTORY_STATE_DIR` set) warms the registry by hand and prints the image; nothing requires it.

Replace `:171`'s `image_unprepared` sentence with the fit step's behaviour (`image_prepare_failed`), `:155`'s "Nothing proves that image is the one `target:prepare` built" with "the verifier runs the work order's bound image by id (its verdict and receipt digest that image); the builder runs the recipe tag until PR 2 of the images plan moves it to the id", the CI paragraph (`:695`) with the per-run global-setup build, and `:703`'s `cli` instructions with `FACTORY_TEST_CLI_TARGET=1 pnpm --filter @b4-example/software-factory-controller test:sandbox:cli` (the lane builds `cli` itself; the global setup builds nothing for it). Delete every `FACTORY_TARGETS_DIR` mention and list it as retired where the README lists retired variables. `FACTORY_SKIP_BASE_PULL` stays documented: with it set, the controller's builder never pulls, and an absent base fails the build naming it.

- [ ] **Step 2: The developer guide**

`:219` and `:464` (the `FACTORY_SKIP_BASE_PULL` workaround): the base is pinned by digest in `target.json` and pulled only when absent; the variable still works and now means "never pull" (pull the base once by hand, `docker pull --platform <platform> <baseImage>`, then set it). Whether pull-only-when-absent alone avoids the wedge is unverified (BuildKit may still load registry metadata for a digest-pinned `FROM`). Every `target:prepare` step becomes optional warming, with `FACTORY_STATE_DIR`.

- [ ] **Step 3: The spec**

Under §4, append:

```markdown
**As landed** ([plan](../plans/2026-09-25-images-built-on-demand.md), PR 1). `target.json`
records no image; it pins its base by digest (`baseImage`). The registry key is the recipe
digest (target, pin, platform, base, Dockerfile, `imageContext`, lockfile path, asserted
modules, commands' cwd), not the lockfile hash, which the pin already decides. Intake builds at the fit step with the budget paused while a build runs (persisted;
reconciliation resumes it after a restart); dispatch builds before its key with the row in
`received`, honours the route's cancel, and re-checks the approved digest after the wait. A
work order binds its image (`image_bound`; intake rebinds each attempt), and the binding is
authoritative: the verifier, the oracle proof and approve's re-verification run the bound
image by ID, and the policy and receipt digest it; only a bound image gone from the daemon is
refused. Tags are recipe-key-scoped and a build reads its own ID from `--iidfile`. The drafter
is offered every target whose files exist at the pin. CI's explicit prepares are gone: each
lane run builds through a registry of its own. PR 2 moves the builder to the bound ID, checked
against the image's build labels. Deferred: the factory's own git
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

# PR 2: the builder runs the bound image by ID

```bash
git fetch origin
git switch -c blove/images-by-id origin/main    # after PR 1 merged
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@b4-example/software-factory-controller^...
```

Closes the per-thread-sandbox plan's review follow-up (`2026-09-24-per-thread-sandbox.md:4862,4895`): with PR 1 the verifier already runs the bound image by ID; here the builder resolves exactly that ID, and checks the ID's build labels name the handoff's own target, pin and recipe key.

### Task 18: The builder handoff names the bound image by ID (version 4), and `factory builder-handoff` supplies one

**Files:**
- Modify: `controller/src/lib/builder-handoff.ts` (schema; `isFactoryImage` → `isFactoryImageId`; `CaptureBuilderHandoffOptions.image` replaces `tag`)
- Modify: `server/src/builder-handoff.ts` (the identical schema; `isFactoryImageId`)
- Modify: `server/b4.config.ts` (`images: isFactoryImageId`)
- Modify: `controller/src/lib/targets/images.ts` (`openImageRegistryReader`, read-only)
- Modify: `controller/src/lib/controller/factory.ts` (the capture input's `tag` becomes `image: { localId, tag }`; dispatch passes the binding's)
- Modify: `controller/src/cli.ts` (`builder-handoff`: `--image-id`, else the registry under `FACTORY_STATE_DIR`; usage text `:45-58`)
- Modify: `controller/test/fake-worker-map.ts` (`fakeBuilderHandoff` writes version 4)
- Test: `controller/test/builder-handoff.test.ts` (fixture `handoff`, `:110-126`), `server/test/builder-config.test.ts`, `controller/test/targets-workspace.test.ts:170-175`, `controller/test/factory-dispatch.test.ts`, `controller/test/cli.test.ts:1043-1110`, `controller/test/images-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

`builder-handoff.test.ts`: the fixture `handoff` (`:110`) becomes version 4 with `image: \`sha256:${"0".repeat(64)}\`` and `tag` set to the tag it named before. The first test captures with `image: { localId: \`sha256:${"1".repeat(64)}\`, tag: recipeTag(task.target) }` and expects

```ts
    expect(handoff.version).toBe(4)
    expect(handoff.target).toEqual({
      image: `sha256:${"1".repeat(64)}`,
      tag: recipeTag(task.target),
      pin: task.target.pin,
      policy: targetSandboxPolicy(task.target),
      permissions: builderPermissions(task.target),
    })
```

and add:

```ts
  it("names an image only by id, and its tag only as its own target's at its own pin", () => {
    const id = `sha256:${"a".repeat(64)}`
    const parse = (target: Record<string, unknown>) =>
      TheBuildersHandoffSchema.safeParse({ ...handoff, target: { ...handoff.target, ...target } }).success
    expect(parse({ image: id })).toBe(true)
    for (const image of [handoff.target.tag, "alpine:latest", `sha256:${"a".repeat(63)}`, `b4-factory-t@sha256:${"a".repeat(64)}`])
      expect(parse({ image }), image).toBe(false)
    expect(parse({ tag: `b4-factory-${handoff.targetId}:${"f".repeat(12)}-0123456789ab` })).toBe(false)
    expect(isFactoryImageId(id)).toBe(true)
    expect(isFactoryImageId(handoff.target.tag)).toBe(false)
  })
```

`images-registry.test.ts`:

```ts
  it("is read, read-only, by a reader that never creates or migrates", async () => {
    const builder = fakeImageBuilder()
    const recipe = recipeFixture()
    expect(() => openImageRegistryReader(join(dir, "absent.sqlite"))).toThrow(/no image registry at/)
    const ensured = await ensure(open(builder), recipe)
    const reader = openImageRegistryReader(join(dir, "images.sqlite"), "linux/arm64")
    try {
      expect(reader.recorded(recipe)).toEqual({ key: ensured.key, tag: ensured.tag, image: ensured.image })
    } finally {
      reader.close()
    }
  })
```

`cli.test.ts`, the two builder-handoff tests (`:1043-1110`): each run passes `--image-id sha256:${"1".repeat(64)}`, and the target-block expectation becomes `expect(handoff.target.image).toBe(\`sha256:${"1".repeat(64)}\`)` with `expect(handoff.target.tag).toContain(\`:${task.target.pin.slice(0, 12)}-\`)`. Add:

```ts
  it("names the image the state directory's registry recorded, and refuses to guess one", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-cli-"))
    const { FACTORY_CONTROLLER_URL, FACTORY_WORKER_URL, ...rest } = process.env
    const out = join(dir, "handoffs")
    const refused = await failing(
      run(process.execPath, [tsxBin, cliEntry, "builder-handoff", "--task", "cli-flags", "--out", out], { env: rest, cwd: packageRoot }),
    )
    expect(refused.stderr).toContain("builder-handoff needs --image-id, or FACTORY_STATE_DIR whose images.sqlite records")
    const state = join(dir, "state")
    const registry = openImageRegistry({ path: join(state, "images.sqlite"), builder: fakeImageBuilder() })
    const ensured = await registry.ensure(loadTaskRecipe("cli-flags").target, { signal: AbortSignal.timeout(5_000) })
    registry.close()
    const { stdout } = await run(
      process.execPath,
      [tsxBin, cliEntry, "builder-handoff", "--task", "cli-flags", "--out", out],
      { env: { ...rest, FACTORY_STATE_DIR: state }, cwd: packageRoot },
    )
    const handoff = BuilderHandoffSchema.parse(JSON.parse(readFileSync(JSON.parse(stdout).handoff, "utf8")))
    expect(handoff.target).toMatchObject({ image: ensured.image.localId, tag: ensured.tag })
  }, 60_000)
```

(`failing` is the file's helper for a run expected to exit non-zero, used at `:400`.)

`server/test/builder-config.test.ts`: the predicate string becomes `'dockerSandbox({ scope: "software-factory-builder", images: isFactoryImageId })'`; `:182-185` becomes

```ts
    const { isFactoryImageId } = await import("../src/builder-handoff.ts")
    expect(isFactoryImageId(`sha256:${"0".repeat(64)}`)).toBe(true)
    expect(isFactoryImageId("b4-factory-devkit:6a59e00aed46-0123456789ab")).toBe(false)
    expect(isFactoryImageId("alpine:latest")).toBe(false)
```

and its handoffs carry `image: sha256:…` plus `tag` (the "refuses a handoff whose image names another target or another pin" test moves its two tags to `tag`). `targets-workspace.test.ts:170-175`: `isFactoryImage(imageTag(...))` becomes `isFactoryImageId(task("0".repeat(40)).target.image.localId)`. `factory-dispatch.test.ts`: Task 13's `handoffTags` records `input.image?.tag` and a new `handoffImages` records `input.image?.localId`, expected to equal the `image_bound` payload's `image.localId`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/builder-handoff.test.ts test/images-registry.test.ts test/targets-workspace.test.ts test/factory-dispatch.test.ts test/cli.test.ts && pnpm --filter @b4-example/software-factory-server test`
Expected: FAIL (version 3; `image` is a tag; no reader; no `--image-id`).

- [ ] **Step 3: Implement**

In BOTH `controller/src/lib/builder-handoff.ts` and `server/src/builder-handoff.ts`, identically: `FACTORY_IMAGE` captures the key segment too, `/^b4-factory-([A-Za-z0-9][A-Za-z0-9._-]*):([0-9a-f]{12})-([0-9a-f]{12})$/`, documented as the recipe tag's shape, and add

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
        /** Its recipe tag; target and pin segments must be this handoff's own. */
        tag: z.string().regex(FACTORY_IMAGE),
        /** The commit that image was prepared at. */
        pin: z.string().regex(/^[a-f0-9]{40}$/),
        policy: z
          .object({
            network: z.object({ mode: z.literal("deny") }).strict(),
            env: z.record(z.string(), z.string()),
            resources: z
              .object({
                memoryMb: z.number().int().positive(),
                cpus: z.number().positive(),
                timeoutMs: z.number().int().positive(),
              })
              .strict(),
          })
          .strict(),
        /** Keyed by tool name, so the key set is open; the values are always patterns naming something. */
        permissions: z.record(z.string(), z.array(z.string().regex(/\S/))),
      })
      .strict(),
```

the `superRefine` reads `handoff.target.tag` (`const [, target, pin] = FACTORY_IMAGE.exec(handoff.target.tag) ?? []`, message `tag ${handoff.target.tag} is not target … at pin …`), and

```ts
/** Whether `reference` is an image id: the builder's `dockerSandbox({ images })`. */
export const isFactoryImageId = (reference: string): boolean => IMAGE_ID.test(reference)
```

replaces `isFactoryImage`.

Controller only: `CaptureBuilderHandoffOptions.tag` (Task 8a) becomes

```ts
  /** The bound image (`image_bound`): its id is what the builder runs, its tag what it is named. */
  readonly image: { readonly localId: string; readonly tag: string }
```

and the handoff is built with `version: 4`, `image: options.image.localId`, `tag: options.image.tag`.

`images.ts`: factor `openImageRegistry`'s `read` into a module-level `readRecorded(db, key): Image | undefined`, and add

```ts
/**
 * The registry, read-only: what a command that must not create, migrate or write a host's
 * registry opens (`factory builder-handoff`). Refuses a path with no registry, and one written
 * by a newer factory.
 */
export function openImageRegistryReader(
  path: string,
  platform: string = hostPlatform(),
): { recorded(recipe: TargetRecipe): RecordedImage | undefined; close(): void } {
  if (!existsSync(path)) throw new Error(`no image registry at ${path}`)
  const db = new DatabaseSync(path, { readOnly: true })
  const found = Number(
    (db.prepare("SELECT max(version) AS v FROM schema_version").get() as { v: number | null }).v ?? 0,
  )
  if (found > IMAGE_REGISTRY_VERSION) {
    db.close()
    throw new Error(`The image registry schema version ${found} is newer than this factory supports (${IMAGE_REGISTRY_VERSION})`)
  }
  return {
    recorded(recipe) {
      const key = recipeKey(recipe, platform)
      const image = readRecorded(db, key)
      return image === undefined ? undefined : { key, tag: tagFor(recipe.id, recipe.pin, key), image }
    },
    close: () => db.close(),
  }
}
```

`factory.ts`: the capture input's `tag?: string` becomes `image?: { readonly localId: string; readonly tag: string }` (absent only for the `tasks` test seam); `captureBuilderHandoffFromCatalog` throws `new Error("dispatch bound no image")` without it; `dispatch` passes `...(bound !== undefined ? { image: { localId: bound.image.localId, tag: bound.tag } } : {})`.

`cli.ts`: `parseArgs` options gain `"image-id": { type: "string" }`; the usage line becomes `builder-handoff --task <id> --out <dir> [--work-order <workOrderId>] [--image-id sha256:<64 hex>]`, with the paragraph at `:53` gaining: "The image is `--image-id`, or the one `<FACTORY_STATE_DIR>/images.sqlite` records for the task's target at its pin (read-only); with neither, the command refuses rather than guess." The `builder-handoff` branch, before the capture:

```ts
    const task = loadTaskRecipe(values.task)
    let image: { localId: string; tag: string }
    const imageId = values["image-id"]
    if (imageId !== undefined) {
      if (!/^sha256:[0-9a-f]{64}$/.test(imageId))
        throw new Error(`--image-id must be sha256:<64 hex>, got ${JSON.stringify(imageId)}`)
      image = { localId: imageId, tag: recipeTag(task.target) }
    } else {
      if (!stateDir)
        throw new Error(
          "builder-handoff needs --image-id, or FACTORY_STATE_DIR whose images.sqlite records the task's image (target:prepare writes it)",
        )
      const reader = openImageRegistryReader(join(stateDir, "images.sqlite"))
      try {
        const recorded = reader.recorded(task.target)
        if (recorded === undefined)
          throw new Error(
            `builder-handoff needs --image-id, or FACTORY_STATE_DIR whose images.sqlite records the task's image: none is recorded for target ${task.target.id} at ${task.target.pin}`,
          )
        image = { localId: recorded.image.localId, tag: recorded.tag }
      } finally {
        reader.close()
      }
    }
```

and the capture receives `image`. `server/b4.config.ts`: import and pass `isFactoryImageId`. `fake-worker-map.ts` `fakeBuilderHandoff`: `version: 4`, `image: image?.localId ?? \`sha256:${"0".repeat(64)}\``, `tag: image?.tag ?? \`b4-factory-fake-target:${"0".repeat(12)}-${"0".repeat(12)}\``.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-server test && pnpm --filter @b4-example/software-factory-server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src examples/software-factory/server/src/builder-handoff.ts examples/software-factory/server/b4.config.ts examples/software-factory/controller/test examples/software-factory/server/test/builder-config.test.ts
git commit -m "feat(software-factory): the builder handoff names the bound image by id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 19: The builder checks the image's build labels against its handoff

Added after review (item 7). An image ID alone binds no target: the provider's predicate admits any `sha256:` the daemon holds. PR 1's builds carry `b4.factory.target`, `b4.factory.pin` and `b4.factory.key` labels (Task 6); the builder's thread resolver reads them by ID and refuses an image whose labels are not the handoff's own target, pin and the tag's key. Labels are part of the image config the ID content-addresses, so a check by ID has no time-of-check gap. No framework hook is needed: the resolver is the builder app's own code, and the check runs there before the framework resolves the image. Trust impact, stated: the labels bind an ID to a target, pin and recipe as the controller built it; whoever can build or load images on the daemon can forge labels, which is the bound the handoff had before (anyone who can tag an image can already run anything as root there). Without this task, PR 2's ID-only predicate would be a narrower bound than the tag shape it replaces for the target and pin segments; with it, it is at least as narrow. A framework-level `images: (reference, inspected) => …` predicate would let the provider make the same check and is recorded as a follow-up.

**Files:**
- Modify: `server/src/builder-handoff.ts` (`FACTORY_LABELS`, `dockerLabels`, `assertFactoryImage`, `builderThreadSandbox`)
- Modify: `server/b4.config.ts` (`thread: (thread) => builderThreadSandbox(thread)`)
- Test: `server/test/builder-config.test.ts` (`describe("the builder's thread resolver")`, `:145-260`)

- [ ] **Step 1: Write the failing tests**

In `builder-config.test.ts`, the thread-resolver tests call `builderThreadSandbox(thread(…), { inspect })` instead of `(await resolver())(thread(…))`, with

```ts
/** The labels a factory build stamps, for `handoff`: what a fake daemon answers for its id. */
const labelsOf = (handoff: BuilderHandoff): Record<string, string> => ({
  "b4.factory.target": handoff.targetId,
  "b4.factory.pin": handoff.target.pin,
  "b4.factory.key": `${handoff.target.tag.slice(-12)}${"0".repeat(52)}`,
})
const inspectFor =
  (answers: Record<string, Record<string, string> | null>) => async (id: string) =>
    Object.hasOwn(answers, id) ? (answers[id] ?? null) : null
```

and adds:

```ts
  it("refuses an image whose build labels are not the handoff's own target, pin and recipe", async () => {
    const order = workOrder("wo-alpha", "x\n")
    const good = labelsOf(order.handoff)
    const cases: [string, Record<string, string> | null, RegExp][] = [
      ["absent", null, /is not on this daemon/],
      ["unlabelled (a base image)", {}, /carries no factory labels/],
      ["another target", { ...good, "b4.factory.target": "devkit" }, /target devkit, not fixture-target/],
      ["another pin", { ...good, "b4.factory.pin": "d".repeat(40) }, /pin d{40}, not /],
      ["another recipe", { ...good, "b4.factory.key": "f".repeat(64) }, /recipe key f{12}…, not /],
    ]
    for (const [name, labels, message] of cases)
      await expect(
        builderThreadSandbox(thread(order), { inspect: inspectFor({ [order.handoff.target.image]: labels }) }),
        name,
      ).rejects.toThrow(message)
    await expect(
      builderThreadSandbox(thread(order), { inspect: inspectFor({ [order.handoff.target.image]: good }) }),
    ).resolves.toMatchObject({ environment: { image: order.handoff.target.image } })
  })

  it("runs the label check for every thread the config resolves", async () => {
    const text = readFileSync(join(serverRoot, "b4.config.ts"), "utf8")
    expect(text).toContain("thread: (thread) => builderThreadSandbox(thread)")
  })
```

(`workOrder`, `thread` and the fixture target id `fixture-target` are the file's existing helpers and fixture; `serverRoot` is the path the file's text assertions already read `b4.config.ts` from.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-server test`
Expected: FAIL (`builderThreadSandbox` is not exported).

- [ ] **Step 3: Implement**

`server/src/builder-handoff.ts`:

```ts
import { execFile } from "node:child_process"

/** The labels every factory image build stamps (the controller's `dockerImageBuilder`). */
export const FACTORY_LABELS = {
  target: "b4.factory.target",
  pin: "b4.factory.pin",
  key: "b4.factory.key",
} as const

/** An image id's labels, or null when the daemon does not hold it. */
export type InspectLabels = (localId: string) => Promise<Record<string, string> | null>

export const dockerLabels: InspectLabels = (localId) =>
  new Promise((resolve, reject) => {
    execFile(
      "docker",
      ["image", "inspect", "--format", "{{json .Config.Labels}}", localId],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) return /No such image/i.test(String(stderr)) ? resolve(null) : reject(error)
        resolve((JSON.parse(stdout) as Record<string, string> | null) ?? {})
      },
    )
  })

/**
 * Refuse, by name, an image the handoff names by id whose build labels are not the handoff's
 * own target, pin and recipe key (the tag's key segment). By id, so the labels read are the
 * image's own: an id content-addresses the config the labels live in.
 */
export async function assertFactoryImage(
  handoff: BuilderHandoff,
  inspect: InspectLabels = dockerLabels,
): Promise<void> {
  const id = handoff.target.image
  const labels = await inspect(id)
  if (labels === null) throw new Error(`image ${id} is not on this daemon`)
  if (!(FACTORY_LABELS.target in labels))
    throw new Error(`image ${id} carries no factory labels: it was not built by the factory`)
  const [, , , key] = FACTORY_IMAGE.exec(handoff.target.tag) ?? []
  const problems: string[] = []
  if (labels[FACTORY_LABELS.target] !== handoff.targetId)
    problems.push(`target ${labels[FACTORY_LABELS.target]}, not ${handoff.targetId}`)
  if (labels[FACTORY_LABELS.pin] !== handoff.target.pin)
    problems.push(`pin ${labels[FACTORY_LABELS.pin]}, not ${handoff.target.pin}`)
  const built = labels[FACTORY_LABELS.key] ?? ""
  if (key === undefined || !built.startsWith(key))
    problems.push(`recipe key ${built.slice(0, 12)}…, not ${key ?? "(no key in the tag)"}…`)
  if (problems.length > 0) throw new Error(`image ${id} was built for ${problems.join("; ")}`)
}

/**
 * The builder's whole per-thread sandbox, from the thread's handoff: what `b4.config.ts`'s
 * `sandbox.thread` returns, after the image's labels are checked. `inspect` is a test seam.
 */
export async function builderThreadSandbox(
  thread: {
    readonly metadata: Readonly<Record<string, unknown>>
    readonly staged: Parameters<typeof stagedBuilderWorkspace>[0]
  },
  options: { readonly inspect?: InspectLabels } = {},
) {
  const handoff = builderHandoffOf(thread.metadata)
  await assertFactoryImage(handoff, options.inspect)
  return {
    workspace: stagedBuilderWorkspace(thread.staged, handoff),
    environment: { image: handoff.target.image },
    policy: handoff.target.policy,
    permissions: { allow: handoff.target.permissions },
  }
}
```

The framework's thread argument has these two fields (and more), so `b4.config.ts` passes it straight through. The label code lives only in the server copy: it is not part of the schema text the two copies share.

`server/b4.config.ts`: the `thread` resolver becomes `thread: (thread) => builderThreadSandbox(thread),` (its comment gains: "after the image's build labels are checked against the handoff").

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-server test && pnpm --filter @b4-example/software-factory-server typecheck && pnpm --filter @b4-example/software-factory-controller test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/server/src/builder-handoff.ts examples/software-factory/server/b4.config.ts examples/software-factory/server/test/builder-config.test.ts
git commit -m "feat(software-factory): the builder admits only an image built for its handoff

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 20: The Docker proof: a moved tag moves nothing, and an image not built for the handoff is refused

**Files:**
- Modify: `controller/test/builder.integration.test.ts:288-370` ("serves a cli-flags thread and devkit threads at two pins from one process")

- [ ] **Step 1: The builder lane**

In that test, every handoff is captured with its bound image: `captureBuilderHandoff(devkitTask, { workOrderId: "wo-devkit", captureRoot: root, image: { localId: devkitTask.target.image.localId, tag: imageTag(devkitTask.target) } })`, and `wo-devkit-2`'s re-pinned handoff sets `image: atSecond.image.localId, tag: imageTag(atSecond)`. After the existing loop over `expected` (each thread's recorded identity and session image equal its `localId`, unchanged), add, inside the same `try`:

```ts
    // A handoff admitted or refused: upload its source, create its thread, run one turn.
    const admitted = async (workOrderId: string, factoryBuilder: unknown): Promise<boolean> => {
      await builder.client.uploadSource(devkit.workspace.source)
      try {
        const threadId = await builder.client.createThread(
          { factoryWorkOrderId: workOrderId, factoryBuilder },
          stagedReferenceOf(devkit.workspace),
        )
        threads.push(threadId)
        builder.aimock.addFixtures(
          script().user(LIST).callsTool("listDir", { path: "." }).replies("Listed.").build(),
        )
        return (await builder.runTurn(threadId, LIST)).status === 200
      } catch {
        return false
      }
    }
    const tag = imageTag(devkitTask.target)
    const base = loadTargetRecipe("devkit").baseImage
    const baseId = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", base], { encoding: "utf8" }).trim()
    execFileSync("docker", ["tag", base, tag])
    try {
      // The recipe tag now names the base image; a thread handed the bound id runs the bound id.
      const moved = { ...devkit.handoff, workOrderId: "wo-devkit-3" }
      expect(await admitted("wo-devkit-3", moved)).toBe(true)
      const record = openWorkspaceInstallationReader(builder.appRoot)
      let operation: string
      try {
        operation = record.associations.get(threads.at(-1) as string)?.intent.operationId as string
      } finally {
        record.close()
      }
      expect(sessionOf(operation).Image).toBe(devkitTask.target.image.localId)
      // The pre-version-4 shape (a tag in `image`) is refused by the schema at admission.
      expect(await admitted("wo-devkit-4", { ...moved, workOrderId: "wo-devkit-4", version: 3, target: { ...moved.target, image: tag } })).toBe(false)
      // An id the daemon holds but the factory did not build for this handoff is refused by its labels.
      expect(await admitted("wo-devkit-5", { ...moved, workOrderId: "wo-devkit-5", target: { ...moved.target, image: baseId } })).toBe(false)
    } finally {
      // Put the recipe tag back on the bound image, as the registry's next `ensure` would.
      execFileSync("docker", ["tag", devkitTask.target.image.localId, tag])
    }
```

(`builder.client`, `builder.handOff`, `builder.runTurn`, `builder.aimock`, `sessionOf`, `threads`, `LIST`, `script` and `openWorkspaceInstallationReader` are the file's; `stagedReferenceOf` from `../src/lib/builder-handoff.ts`, `imageTag` from `../src/lib/targets/images.ts`, `loadTargetRecipe` from the catalog. The refused threads are pushed to `threads` only when created, so the file's `afterAll` deletes what exists.)

- [ ] **Step 2: Run the lane (Docker required)**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run --config vitest.sandbox.config.ts test/builder.integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add examples/software-factory/controller/test/builder.integration.test.ts
git commit -m "test(software-factory): a moved tag moves no builder, and an unlabelled image is refused

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 21: Docs: the follow-up is closed

**Files:**
- Modify: `examples/software-factory/README.md` (the builder's image bound, `:150-160` at main)
- Modify: `docs/superpowers/plans/2026-09-24-per-thread-sandbox.md` (`:4862`, `:4895`: append "Closed by the images plan")
- Modify: `docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md` (§4 As landed, PR 2 sentence)

- [ ] **Step 1: Edit**

README: the paragraph on the builder's image bound says: the handoff names the image the work order bound by id (`sha256:…`) with its recipe tag; the builder's provider accepts only ids; the builder's resolver refuses an id whose `b4.factory.*` build labels are not the handoff's target, pin and recipe key; the framework records that id as the thread's identity; and the verifier runs the same id (since PR 1). A tag is a name for people and prunes, never the identity. `factory builder-handoff` takes `--image-id`, or reads the state directory's registry. The per-thread plan's two follow-up paragraphs each gain one line: "Closed by `2026-09-25-images-built-on-demand.md`: the verifier runs the bound image id (PR 1, Task 13a); the builder's handoff names it and its labels are checked (PR 2)." The spec's As-landed paragraph replaces "PR 2 moves the builder to the bound ID, checked against the image's build labels" with what landed.

- [ ] **Step 2: Commit and verify**

```bash
git add examples/software-factory/README.md docs/superpowers/plans/2026-09-24-per-thread-sandbox.md docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md
git commit -m "docs(software-factory): the builder runs the bound image by id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

PR 2 verification: the PR 1 table, plus `pnpm --filter @b4-example/software-factory-server test` and Task 20's lane. Push `blove/images-by-id` and open the PR only when Brian asks.

---

## Proof map

| Proof (spec §4, this plan, and the review) | Where |
|---|---|
| Two concurrent work orders at one pin build once | Task 4 "builds a key once however many need it at once" (registry); Task 12 "builds a pin once for two work orders that need it at once" (intake) |
| A failed build settles the work order with the log in evidence | Task 3 (the error carries the log); Task 12 (intake blocks `image_prepare_failed`, the artifact holds the log, no attempt spent, the next work order builds); Task 13 (dispatch refuses, retries on the next dispatch) |
| Docker: intake at an unprepared devkit pin builds it, and the recorded identity equals the script's | Task 15 |
| Identity by id: a retagged image is refused | Task 13a (the verifier runs the bound id; a bound id the daemon lacks is refused); Task 15 (Docker: a verdict earned while the recipe tag names another image); Task 18 (a handoff naming a tag is refused by schema; the provider accepts only ids); Task 19 (an id not built for the handoff is refused by its labels); Task 20 (Docker: a moved tag moves no builder; an unlabelled id is refused) |
| A build's own id | Task 6 (`--iidfile`; no `image inspect <tag>` after the build) |
| Concurrency limit and wait bound | Task 4 "never runs more builds at once than its limit"; "leaves a queued waiter's cancel costing nothing"; "bounds a caller's whole wait, queue included" |
| Cancellation | Task 4 (last waiter cancels; a shared build survives one waiter); Task 12 (intake cancel mid-build); Task 13 (dispatch cancel mid-build, in process, by the caller's signal, and through the route with `factory cancel`) |
| Registry / local image drift | Task 5 (deleted image rebuilt; moved tag pointed back; `recorded` never asks Docker; `present`); Task 15 (moved tag against a real daemon); Task 13 (a superseded bound image kept while present; `image_changed` when gone) |
| Budget exclusion | Task 10 (restart resumes a paused clock and ends an interrupted build in the journal); Task 12 (an hour of building charges nothing) |
| Timeout | Task 4 "fails a build past its timeout" |
| No image in the repository | Task 9 (schema refuses `images`/`image`; `git grep localId` empty) |
| The CLI and the review need no image | Task 8a (`loadTaskRecipe`); Task 9 (`pin-diff-base.test.ts`; `cli.test.ts:1046-1100` pass with no registry) |
| The approved digest holds after a long wait | Task 13 "re-checks the approved digest after the image step" |

## Follow-ups recorded, not in this plan

- **The factory's own git object store** (spec §9 finding 3, D12): a bare mirror under `FACTORY_STATE_DIR` that `ensurePin`, the image context archive, the wide capture, the baseline and the pin diff all read, so the factory never fetches into the developer's clone.
- **`reprove`** (D5): a command that re-runs the oracle proof in the image the host now builds, rebinding, for a work order refused `image_changed` because its bound image is gone; today the remedy is a new work order.
- **Budgets from measured verifier time** (spec §9 finding 5, D14).
- **Cross-process single flight** (D6): a lock row in `images.sqlite` if running the script beside a live controller ever builds one key twice in practice.
- **A reaper for superseded images**: every recipe change leaves the previous image tagged (recipe tag and id tag) on the daemon; a `factory images prune` that removes images no registry row and no live work order's binding names. Deliberately not in this plan (no image deletion on a shared host).
- **Build output as a live journal tail**: the CLI shows `image_prepare_started` and then nothing until the build ends; streaming log lines as events would make a multi-minute build visible.
- **A framework `images` predicate that sees the inspected image** (`dockerSandbox({ images: (reference, inspected) => … })`), so the provider itself, not the builder's resolver, can check labels (Task 19).
- **Whether `FACTORY_SKIP_BASE_PULL` is still needed** (D3). The check: on Docker Desktop, with the base present locally by digest and the network to the registry blocked (or the registry path in the wedged state the live run saw), run a `dockerImageBuilder` build of `devkit` without the variable. If `docker build` completes without contacting the registry (BuildKit's "load metadata for docker.io/library/node" step is the one to watch in the log), the variable can retire; if it stalls there, it stays, and its message should say so.

## Self-review

- **Spec coverage.** §4 Change: the build lifted into `src/lib/targets` (Tasks 3-6) as `ImageRegistry.ensure(recipe, { signal })` rather than a free `prepareImage(target, pin, { signal })`, because single flight and the limit need shared state; called at intake's fit step (Task 12) and at dispatch (Task 13); one build per key (Task 4); registry at `<FACTORY_STATE_DIR>/images.sqlite` (Task 3, Task 8); journal events (Task 11); budget exclusion (Tasks 10, 12); `image_unprepared` retired as a standing block (Tasks 7, 12, 13); no B4-level `dockerSandbox({ build })` (none added). Trust impact: inputs unchanged and reviewed (the base is now reviewed too, Task 1); the drafter still never chooses a pin; the model-triggerable build cost is bounded by the limit, the wait bound and the timeout (Task 4; Spec corrections 7). Proof: the proof map above. §7's row "`target:prepare` per pin | 4" is removed by Tasks 9, 13 and 16. §9 findings 3 and 5: deferred with reasons (D12, D14).
- **Placeholder scan.** Code steps carry code. Helpers are named as the files name them (`handoff` at `builder-handoff.test.ts:110`; `builder.handOff`, `builder.runTurn`, `builder.client`, `sessionOf`, `threads`, `LIST`, `script` in `builder.integration.test.ts`; `verifierFor`, `applyReference`, `allowed`, `policy` in `docker-verifier.integration.test.ts`; `forceRow`, `journalHandoff`, `crash`, `bootFactory`, `intake`, `refusals` in `factory-intake.test.ts`; `failing`, `pollState`, `run`, `boot` in `cli.test.ts`). Two small helpers are new and specified by body: `journalEvent`/`journal` (the body of `journalHandoff`) and `pollEvents` (the shape of `pollState`).
- **Type consistency.** `TargetRecipe` (Task 1) is what `recipeKey`, `recipeTag`, `ImageRegistry.recorded/ensure`, `BuildRequest.recipe`, `recipeProblem`, `availableTargets`, `ParsedDraft.target`, `TaskRecipe.target` and `prepareWorkOrderImage` take. `tagFor(id, pin, key)` is the one tag function (Task 1); `imageTag(target)` and `recipeTag(recipe, platform)` derive it from the key (Task 2). `EnsuredImage.build` is optional everywhere; `onBuild` carries `deadlineMs` (Task 4) and `image_prepare_started` journals it (Task 11), which `imageWaitBoundMs` reads (Task 14). `BoundImage` (Task 11) is what `boundImageOf` returns and `image_bound` carries; Task 13a passes `bound.image` (the whole `Image`) as `VerifyInput.image`, `CatalogOptions.image` and `loadPolicy`'s second argument; Task 18 passes `{ localId: bound.image.localId, tag: bound.tag }` to the capture. `isFactoryImage` is renamed `isFactoryImageId` in both handoff copies and in `b4.config.ts` in one task (18). The registry's `recorded` takes the recipe alone (its pin is `recipe.pin`).

## Review amendments (2026-09-25)

An independent review of this plan found no Critical issues, eight Important ones and several minors. Each is addressed in place; this list says where.

1. **The CLI loses `loadTask` in PR 1** (`builder-handoff` at `cli.ts:798` and its subprocess tests `cli.test.ts:1046-1100` would throw `ImagesUnconfiguredError`; `pinDiffBase` at `pin-diff-base.ts:26`, from `cli.ts:604`, would show every file unavailable). New Task 8a adds `TaskRecipe`/`loadTaskRecipe` and moves every caller that reads no image onto it (the pin diff, the baseline, prompts, budgets, the builder's inspection options, the handoff capture, the CLI) before Task 9 switches the catalog; Task 9 adds `pin-diff-base.test.ts` and names the two CLI tests as the check. PR 1's `builder-handoff` writes the recipe tag (computable without an image); PR 2's (Task 18, which lists `cli.ts`) takes `--image-id` or reads `<FACTORY_STATE_DIR>/images.sqlite` read-only (`openImageRegistryReader`), refusing to guess.
2. **The builder could record another build's image.** Task 6 reads the id from `docker build --iidfile` (written beside, never inside, the context) and no longer inspects the tag. Tags are recipe-key-scoped (`tagFor(id, pin, key)`, Task 1, still matching `FACTORY_IMAGE`), so re-pointing (Task 5) cannot move a tag between keys; each build also gets an id tag that never moves (`idTagFor`), so a bound image a later build of its key superseded keeps a tag (D10).
3. **Identity was half enforced in PR 1.** The verifier's run-by-id and binding check moved from PR 2 into PR 1 as Task 13a, together with the oracle proof and approve's re-verification. PR 2 now only moves the builder (Tasks 18-20).
4. **An operator cancel during a dispatch build was ignored** (the route's `ctx.signal` had no listener until `settleOutcome`). Task 13: `Factory.dispatch` takes `{ signal }`, the route passes `ctx.signal`, the image wait includes it, and an abort cancels the work order with `settleOutcome`'s key (`cancel:<id>:aborted-dispatch`); tested in process and through the route with the CLI's `cancel` (`cli.test.ts`).
5. **The approved digest could change during the wait.** Task 13 factors the check into `approvedDigestRefusal` and runs it again after the image step (`phase: "dispatch_after_image"`), with a test that edits the generated task during the wait.
6. **The lanes' registry was shared across worktrees and runs.** Task 9: the global setup makes a registry directory per run (`mkdtemp`), hands it to the lane files with `provide`/`inject`, and removes it at teardown; the misleading comment is gone.
7. **PR 2's id-only predicate bound no target.** Task 6 labels every build `b4.factory.target`/`pin`/`key`; new Task 19 has the builder's resolver check an id's labels against the handoff. No framework hook is needed (the resolver is the app's code; labels are content-addressed by the id); the trust bound is stated in Task 19, and a framework predicate that sees the inspected image is a follow-up.
8. **Waits were unbounded, and the CLI's grace ignored queue time and the controller's settings.** Task 4 bounds each waiter's whole wait (`queueTimeoutMs`, default twice the build timeout, plus the build timeout) and reports it as `deadlineMs`; Task 11 journals it on `image_prepare_started`; Task 14's follower extends its deadline by the journalled bound (`imageWaitBoundMs`), so it never guesses the controller's configuration.

Minors:

- **Key stranding / `loadPolicy` outside any guard.** The binding is authoritative (D5): Task 13a computes policy and identity from the bound image object (`CatalogOptions.image`, `loadPolicy(taskId, image)`), refuses only a bound id the daemon no longer holds, and moves `verify.ts:46`'s `loadPolicy` into a guard (`policy_unavailable` → inconclusive). Dispatch keeps a binding whose image is present (Task 11, Task 13 test).
- **Model-triggerable build cost** is stated in Spec corrections 7.
- **The Dockerfile hash** is taken from the copy in the context (Task 6); the registry refuses a mismatch with the key's.
- **A crash mid-build** leaves `image_prepare_aborted {reason: "restart"}` in the journal at reconciliation (Task 10).
- **`user_version` vs `schema_version`.** The image registry now uses the repository's `schema_version` table idiom (D1, Task 3), so both stores read the same way.
- **Wrong task references.** Task 7 now defers to Task 9 (was "Task 8"); the PR split names Task 16 for CI (was "Task 17"); Task 15's title says what it proves (the deleted-image half of drift is Task 5's, in the unit suite).
- **`test:sandbox:cli` built `devkit` and `cli-flags`.** The global setup skips both prebuilds under `FACTORY_TEST_CLI_TARGET=1` (Task 9).
- **The pull-wedge claim was unverified.** D3 says so; `FACTORY_SKIP_BASE_PULL` is kept (the builder never pulls under it and names it when the base is absent, Task 6), the config no longer retires it (Task 8), and the check that could retire it is recorded under Follow-ups.
- **Placeholders.** Task 8's `.catch` is code (`releaseImages`) with a failed-open test; `static-images.ts` is written in Task 8, where it is first used, with `present`; Task 9's conditionals are definite (the `images` variable's placement is stated); Tasks 12 and 13 name the one whole-journal test each changes (`factory-intake.test.ts:257`, `factory-dispatch.test.ts:104`), and Task 14 journals `dispatch_refused` only after a build started, so no other journal assertion changes; Task 16's "adapt" is replaced by the verified counts; Tasks 18 and 20 name the files' real helpers.
- **A process note.** While writing the first version of this plan, `docker builder prune -f` was run on this shared host during an experiment; it affected other sessions' build caches. Trap 10 now forbids destructive Docker commands, and no task deletes an image.
