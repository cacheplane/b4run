# Targets Generated From a Package Implementation Plan

> **Amended after review (2026-09-25).** An independent review found no Critical issues, nine Important ones and a list of minors; each is addressed in place, and "Review amendments (2026-09-25)" at the end lists each with where it landed. The largest changes: `measure` gives a fresh container after any file that wrote, hung or was killed, re-runs every non-pass once (a disagreement is `flaky`, listed and never excluded), never proposes resources below the target's own without `--allow-decrease`, and confirms its proposal with a run at exactly those values; a re-generation carries hand additions as supersets; `measure --write` also writes a committed `targets/<id>/measurement.md` (D2); two new decisions (D15, D16).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person adds a target for a pnpm workspace package by running two deterministic commands and reviewing a diff, not by hand-deriving four path lists, a build order, a Dockerfile, a test scope and resources: `target:init <package>` writes `targets/<id>/target.json` and its `Dockerfile` from the package's manifests at a pin, and `target:measure <id>` runs the suite file by file in the target's own image and proposes the excludes (each with its failure output) and the resources.

**Architecture:** `init` reads the repository at the pin through a `PinTree` over the git object store (never the working tree), builds the workspace graph from `pnpm-workspace.yaml` and the packages' `package.json` files, and derives every field from three closures (the build closure over `dependencies`, the install closure pnpm's `--filter <pkg>...` installs, and the config packages a `tsconfig` `extends` reads) plus each package's `build` and `test` scripts. The Dockerfile is one template, the `cli` target's Dockerfile generalised, with every trap the hand-written ones learned baked in. What a manifest cannot say (which tests pass in the sandbox, how much memory the suite needs, which nested dependencies pnpm's hoisting promotes) `measure` learns by running: it builds through the same `ImageRegistry.ensure` the controller calls, runs each test file alone in the verifier's session shape (capture, network denied, snapshot before and after), then the whole proposed suite in fresh containers reading cgroup `memory.peak`. Both commands print a unified diff and write only with `--write`; the target stays a reviewed, committed file, because it is an oracle input.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), git plumbing (`ls-tree`, `cat-file`), zod 4, the `diff` package (already a dependency), Biome (formatting `target.json`), vitest 4, Docker via `@b4run/sandbox`'s `dockerSandbox` and `@b4run/cli`'s `withWorkspace`.

**Spec:** [`2026-09-23-software-factory-framework-gaps-design.md`](../specs/2026-09-23-software-factory-framework-gaps-design.md) §5 (this item), §4 as landed (images on demand), §7, §8, §9 findings 1, 5, 6, 12, 20.

**Base:** `main` at `1da86aec` (after #852, images on demand PR 1; #855, PR 2, is open and touches only the builder handoff, not anything this plan edits). Paths and lines were read at `1da86aec`. The two pins the proofs read are `6a59e00aed466330c182989265786af396f39d80` (`devkit`) and `765e6e16fec86bba0859d3f85edf7136f663f720` (`cli`).

---

## Decisions

**Decided 2026-09-25: Brian accepted every recommendation below, as amended by the independent review (D2, D8, D11, D12, D13) and including the two decisions the review added (D15, D16).** Each entry keeps its reasoning; "*Decided:*" now reads as "*Decided:*". The tasks below implement exactly these.

**D1. Where the commands live.** *Decided:* package scripts beside `target:prepare`: `pnpm --filter @b4-example/software-factory-controller target:init <package> [--pin <sha>] [--id <id>] [--targets-dir <dir>] [--with-dev-builds] [--write]` and `... target:measure <id> [--pin <sha>] [--targets-dir <dir>] [--write] [--allow-decrease] [--runs <n>] [--file-timeout-ms <ms>] [--memory-mb <mb>] [--cpus <n>]`, thin scripts over `src/lib/targets/init/` and `src/lib/targets/measure/`. `--targets-dir` points both at a scratch catalog (a measurement nobody commits, Task 18) instead of the controller's `targets/`; it is an argument, not the retired `FACTORY_TARGETS_DIR` variable. Not `factory target:init`: every `factory` command is a request to a running controller or a read of `registry.sqlite` (`controller/src/cli.ts:36-56`; `builder-handoff` is the one local exception, `:820-851`), and these need neither. `target:prepare` is the precedent for a target command that is a script (`controller/package.json:13`), and `measure` opens `<FACTORY_STATE_DIR>/images.sqlite` exactly as it does (`scripts/prepare-target.ts:21-31`).

**D2. What "the output is a diff" means, and where each exclude's reason lives.** *Recommend (amended, the reviewer's alternative adopted):* both commands compute the files they would write, print a unified diff of them against what is on disk (against `/dev/null` for a new target) on stdout, and write only with `--write`. The person's review is `git diff` and a commit. `measure` needs the target's files on disk to build (the registry reads the Dockerfile and `target.json` from the targets directory, not from git: `targets/catalog.ts:334-345`, `targets/image-builder.ts:112`), so the flow is `init --write`, `measure`, `measure --write`, review, commit. `measure --write` writes two files: `target.json` (the test command and resources) and `targets/<id>/measurement.md`, committed beside it: each excluded file with its verdict class, its reason and the first error lines of its output, and each flaky file listed as not excluded; no timings, image ids or hosts, so a re-measurement that agrees rewrites it byte for byte. That puts the reason for hiding a test from both suites next to the oracle input it changes, where a reviewer of the next re-pin sees it, instead of in a commit message. The full evidence (every file's output, the samples, the resources table) goes to `<FACTORY_STATE_DIR>/measurements/<id>/<pin12>-<utc>/report.md`, whose path it prints. *Not recommended:* a `target.json` field for the reasons (a second list to keep in step with the `--exclude` flags, inside the file the recipe tools parse).

**D3. Scope.** *Decided:* pnpm workspace packages under `packages/` whose `test` script is a plain `vitest` invocation using only `run`, `--run`, `--config <file>`, `--no-cache` and `--passWithNoTests` (every other token is refused by name: it might select other files), and whose built packages each compile with one `tsc -b <tsconfig>`. Everything else is refused by name, never guessed. Every pnpm workspace package in this repository tests with vitest (checked: `packages/*/package.json`, `examples/*/*/package.json` at `1da86aec`), so `node:test` has no pnpm consumer; `cli-flags` (an npm project fixture with a `package-lock.json`, `targets/cli-flags/target.json:4-15`) stays hand-written. Packages outside `packages/` are refused because the Dockerfile's `CAPTURED` check names packages by `packages/<dir>` (`targets/prepare.ts:83-90`).

**D4. The closures.** *Decided:*
- **Build closure**: the target package and its workspace `dependencies`, transitively, minus config packages (plus, with `--with-dev-builds`, the target's workspace devDependencies that have builds and their runtime closures: D16). Each is captured as `package.json`, the tsconfig its `build` script compiles plus the in-package files that tsconfig `extends`, and `src`. The target package additionally captures every `tsconfig*.json` in its directory, its vitest config, and its whole `test` directory. `init` names, in a note, every package subdirectory the capture leaves out (with file counts: `cli`'s `bin/` and `scripts/`, `devkit`'s `templates/`) and every sibling package the vitest config reaches by a `../<dir>/` path that the capture omits (`cli`'s alias to `../sandbox/src`), so an omission is visible before a test trips on it.
- **Install closure**: what `pnpm install --filter <pkg>...` installs: `dependencies`, `devDependencies` and `optionalDependencies`, transitively. Each member's `package.json` goes into `imageContext`. A member with a build of its own that is not in the build closure (the `cli` package's devDependency `@b4run/sandbox`) is installed, not captured; `init` says so in a note.
- **Config packages**: install-closure members with no `build` script (`@b4run/config-typescript`). Captured, put into `imageContext` and into `runnerConfig` whole, because a `tsconfig` reads them by a relative `extends` path, which is what the hand-written targets do and why (the sandbox-image trap "siblings copied in full").
- **Test scope**: the whole `test` directory. A person narrows it by hand when a package's suite is too large (the `cli` target's eight files were a cost decision made when a snapshot took 170 ms an operation; #826 and #829 made the whole-directory capture affordable). `init` carries a hand-narrowed scope on re-generation (D8).

**D5. The build command.** *Decided:* one `pnpm exec tsc -b` over every built package's own tsconfig (a sibling as `../<dir>`, or `../<dir>/<file>` when its build uses another file), in topological order over runtime (`dependencies`) edges with alphabetical ties, the target package last, with `--builders 1` when there is more than one project and the root's TypeScript is 7 or later. Not the spec's "`tsc -b` where project references exist, else a filtered `pnpm -r run build`": references are partial at the `cli` pin (its `tsconfig.build.json` references seven of nine; `sdk` and `workspace` are reached only through `node_modules`), and build scripts do more than compile (`cli`'s ends in `scripts/generate-docs.mjs`, which reads `apps/web`; `ag-ui`'s deletes and copies files around its `tsc -b`). TypeScript 7 builds unreferenced projects concurrently, hence `--builders 1` (the `cli` target's trap 4). A `tsBuildInfoFile` outside a package's `outDir` is refused (`snapshotIgnore` holds directory prefixes, so it could not cover it), and each package whose build script does more than `tsc -b <file>` is named in a note (`cli`, `ag-ui`). No `--declarationMap false`: it shrank the snapshot when snapshots were slow, which #826/#829 fixed.

**D6. Where the Dockerfile comes from.** *Decided:* one template for every pnpm target (`src/lib/targets/init/dockerfile.ts`), the `cli` Dockerfile generalised: pnpm through npm (not corepack), `COPY packages packages` from a context that holds only `imageContext`, a hoisted `--filter <name>...` install with the `chmod` in the same layer, then one `RUN` that moves the root's TypeScript aside behind a `tsc` shim *only when a captured package nests its own* `typescript`, promotes nested dependencies over the root's against a reviewed `EXPECTED_PROMOTED` set, relinks every captured workspace package to `/workspace/packages/<dir>` by its real name (no `@b4run` assumption), then the `.vite-temp` link, `USER node`, `WORKDIR /workspace`. The `CAPTURED` list stays, so `recipeProblem`'s existing check (`targets/prepare.ts:97-116`) guards generated Dockerfiles too. The shipped `devkit` and `cli` Dockerfiles are not replaced in this plan (D14).

**D7. The promotion set.** *Decided:* keep it as a reviewed tripwire, learned by `measure`. Which nested dependencies pnpm's hoisted linker leaves under `packages/<p>/node_modules` is a function of the whole lockfile that only pnpm computes; reading the lockfile needs a YAML parser the example does not carry (and adding a dependency to an example re-keys the lockfile). So `init` writes `EXPECTED_PROMOTED=""` (or carries the existing Dockerfile's set, D8); the template prints the actual set on a marker line and fails when it differs; `measure`, on an `ImagePrepareError` whose log shows that failure, proposes the Dockerfile with the set the build printed, and stops. The person reviews it (a promotion replaces a root package every other package resolves, so it is worth a look) and runs `measure` again. *Consequence, recorded, not new:* the set is a fact about one lockfile, so a work order at a later pin whose lockfile nests differently fails its image build naming the set (`image_prepare_failed`), exactly as the hand-written `cli` Dockerfile does today; `measure --pin <that pin>` proposes the new set.

**D8. What a re-generation keeps.** *Decided (amended):* when `targets/<id>/` exists and is the same package's target (`commands.cwd` equal; otherwise refuse and ask for `--id`), `init` carries `baseImage`, `resources`, `draftingNotes`, the test command's positional files and `--exclude` entries that still name files at the pin, and the Dockerfile's `EXPECTED_PROMOTED`; and it keeps `imageAssertResolves`, `capture.include` and `runnerConfig` as *supersets*: every existing entry still present at the pin (for the capture, root files and entries under a package this generation captures) is kept beside the derived ones. A hand-added module assertion (`cli`'s `commander`) or capture entry survives, and a hand-added `runnerConfig` entry is never silently dropped, which would make a file the tasks kept immutable editable. A carried test scope keeps the carried capture of the test directory instead of widening it to the whole directory the command does not run. Whatever names nothing at the pin is dropped with a note. Everything else is regenerated. So re-running `init` on an unchanged target prints an empty diff (Task 9 proves it for both shipped targets but for `cli`'s build order), and a re-pin shows exactly what the new pin changes.

**D9. Defaults for a new target.** *Decided:* `baseImage` is the base every shipped target pins (`node:24-slim@sha256:0e0ff40c…`, asserted by `test/targets-catalog.test.ts:479-482`); resources are placeholders `{ memoryMb: 2048, cpus: 2, commandTimeoutMs: 600000, verifierDeadlineMs: 3600000 }` with a note while they are the placeholder values (detected by value, not by whether they were carried); `--pin` defaults to `origin/main` through the existing `resolvePin` (fetch skipped under `FACTORY_NO_FETCH=1`), as `create --issue` pins; `--id` defaults to the package directory's name.

**D10. Fields `init` derives by rule, and the extras it does not guess.** *Decided:* `imageAssertResolves` is `vitest`, `typescript` when there is a build, and `@types/node/package.json` when the root or the package depends on `@types/node` (exactly `devkit`'s, and the first three of `cli`'s; `cli`'s `commander` and `@langchain/langgraph` were hand-picked extras a person may add). `runnerConfig` is the root `package.json`, `pnpm-workspace.yaml` and `.npmrc` (what `pnpm exec` and the build read; the rule the `cli` target's review adopted, first-live-issue plan Task 2 review fix (d)), the target package's `package.json`, vitest config and `tsconfig*.json`, and the config packages. `commands.nodeTestExecArgv` is `[]` (Node 24 strips types; both pnpm targets already use `[]`). `snapshotIgnore` is each built package's `outDir`. `draftingNotes` are not generated: spec §9 finding 20 asks for them, but nothing deterministic can write "facts a drafter needs" from a test file, and §5 says no model; `init` carries existing notes (D8).

**D11. How `measure` classifies a file.** *Decided (amended):* each file the target's vitest command lists (`vitest list --filesOnly`, run in the image with the command's own config and filters, so the file set is vitest's, not a guess) runs alone in a sandbox session with the network denied, a per-file timeout (`--file-timeout-ms`, default 180000) and a generous memory limit (`--memory-mb`, default 4096), the workspace snapshotted before and after with the verifier's own inspection options. Verdicts: **pass**; **fail** (non-zero exit); **hang** (the sandbox's timeout, exit 124); **killed** (exit 137 with no report); **writes**: it passes but changes the workspace, which the verifier refuses as tampering on every verification (`verification/grade-suite.ts:137-139`, `:170-177`), a class the spec does not name. What a run changed is reported whatever the verdict, so a file that fails and writes shows both. The next file gets a fresh container after any file that changed the workspace, hung or was killed, so no file is measured in a workspace another dirtied. Every non-pass then runs once more, alone, in a fresh container: two non-passes keep the first verdict; a pass on the second run makes the file **flaky**, listed in the report and in `measurement.md` and never proposed for exclusion (a person decides). An `ENOENT` on a `/workspace/...` path that exists at the pin is named in the reason as a capture omission, and each file's per-test passed, failed and skipped counts are in the report. The per-file run must report exactly the file it was given (vitest's positional argument is a substring filter); anything else is a harness error, never an exclude.

**D12. How `measure` proposes resources.** *Decided (amended):* the whole suite with the proposed excludes runs `--runs` times (default 3) in fresh containers, each timed from open to close, reading `memory.peak` last. Per-file sessions cannot measure memory: `memory.peak` is the container's lifetime peak, and vitest runs the files of one suite in parallel workers in one process. A suite that fails or writes as a whole when every file passed alone is reported with its output and gets no resource proposal. The *measured* resources, from the highest sample of each: `memoryMb` = twice the peak rounded up to 256 MiB, at least 512; `cpus` = the value the sessions ran with (`--cpus`, else the target's); `commandTimeoutMs` = eight times the slower of build and suite, rounded up to 10 s, at least 60 s (the `cli` target's rule); `verifierDeadlineMs` = two sessions (visible and independent) at 2.5 times the slowest session, rounded up to a minute, at least 2 minutes. The *proposed* resources are, field by field, the larger of the measured and the target's own, unless `--allow-decrease`: one host's measurement is not every host's (the prototype measured `devkit`'s `memory.peak` at 181 to 184 MiB where rung 2 measured 369, and so proposed 512 where 768 is committed). Placeholder resources are no prior. The proposal is then **tried**: one more whole-suite session at exactly the proposed memory, CPUs and per-command timeout, which must pass, write nothing, and fit twice within the proposed `verifierDeadlineMs`; otherwise `measure` refuses to propose. The report sets before, measured and proposed side by side.

**D13. Where the proofs run.** *Decided (amended):* `init`'s reproduction of `devkit` and `cli` is a unit test against the two real pins, whole-object with each difference applied (`source-validate` checks out full history, `.github/workflows/ci.yml:98`, and `test/targets-catalog.test.ts:471-498` already requires the shipped pins; `initTarget` also makes its pin present itself, so a lane never depends on the global setup having fetched it). The Docker proofs for `devkit` (the generated Dockerfile builds; `measure` proposes the committed nine excludes) run in `test:sandbox`, so CI's `sandbox-docker` job carries them, with `--runs 1` to stay inside its 30 minutes (`ci.yml:392`); record the lanes' wall clock in each PR. The generated `cli` Dockerfile's build (learning the committed promotion set, then building: the only exercise of the TypeScript shim and of relinks by name) is opt-in under `FACTORY_TEST_CLI_TARGET=1` like the existing `cli` lane, **run by hand before PR 1 merges**; a full `measure` of the generated `cli` target's 169 files is run by hand in PR 2, in a scratch catalog, results recorded in the spec's as-landed note.

**D15. Excludes are per file, not per test.** *Decided:* keep the file as the unit. vitest's `--exclude` takes files, and a file's tests share its module-level setup, so a per-test exclusion (`-t`/`--testNamePattern`, or `.skip` edits) would be a second mechanism with its own drift. The cost: a file with one failing test loses its passing ones too. The mitigation is visibility: the report gives each file's passed, failed and skipped counts (D11), so a reviewer sees what an exclude hides, and a person may narrow the scope by hand instead. Per-test exclusion is a follow-up.

**D16. Built devDependencies that tests import.** *Decided:* an opt-in `target:init --with-dev-builds`, off by default. The `cli` package's tests import `@b4run/sandbox` (a devDependency with a build) in 8 files, and its vitest config aliases `@b4run/sandbox/testing` to `../sandbox/src`; by default `sandbox` is installed, not captured, so those files fail and `measure` proposes excluding them (named as capture omissions or as import failures in the report). With the flag, each workspace devDependency of the target that has a build, and its runtime closure, is captured and built like a dependency (the target still compiled last). Off by default because it widens the capture and every verification's build for suites the hand-written targets chose not to run, and because it is a person's call which tests matter. A re-generation needs the flag again; without it, carried capture entries under an uncaptured package are dropped with a note.

**D14. The shipped targets.** *Decided:* not regenerated in this plan. A generated Dockerfile is a new recipe key, so every host rebuilds; the lanes and the shipped tasks are pinned to the current recipes; and the proof is that the generator *reproduces* them with explained differences, not that it replaces them. Regenerate each one the next time it is re-pinned (a follow-up). The `devkit` task already keeps the root manifests immutable (`tasks/devkit-spawn-deadline/task.json`), so the generated, wider `runnerConfig` would still fit it.

## Today, verified

Each claim of spec §5's "Today", of the findings it cites, and of what item 4 changed, re-located at `1da86aec`.

| # | Claim | Where it is now | Holds? |
|---|---|---|---|
| 1 | `target.json` and its Dockerfile are hand-written; the schema's fields | `controller/src/lib/targets/catalog.ts:114-175` (`TargetObjectSchema`); three targets under `controller/targets/{cli-flags,devkit,cli}/` | Yes |
| 2 | "The same paths recur across three lists" | `capture.include`, `imageContext`, `runnerConfig` (`targets/cli/target.json:5-52`, `:67-84`, `:140-149`) and a fourth: the Dockerfile's `CAPTURED` (`targets/cli/Dockerfile:36`), now checked against the capture before a build (`targets/prepare.ts:97-116`, via `recipeProblem` `:138-154`, called at `targets/image-builder.ts:74`) | Yes, four lists |
| 3 | `devkit`'s test command carries nine `--exclude` flags | `targets/devkit/target.json:40-66`. Each of the nine reads `packages/devkit/templates` (grep at `6a59e00a`: 1 to 7 references each; the two files kept, `process-artifacts` and `reporting`, have none), which the capture omits because the workspace capture accepts only portable ASCII paths (`packages/workspace/src/source-validation.ts:46-66`) and `templates/` holds `(public)` and `[tenant]` paths at that pin | Yes |
| 4 | The `cli` target: nine workspace dependencies, 177 test files | At `765e6e16`, `packages/cli/test` holds 178 files, 169 of them `*.test.ts`, 2.5 MB; the target runs 8 (`targets/cli/target.json:121-137`) and captures those plus one helper | Yes (169 test files, 178 in the directory) |
| 5 | Item 4 changed `target.json` | No images (refused by name, `catalog.ts:182-192`); `baseImage` pinned by digest (`:128`); images built on first need through `ImageRegistry.ensure` (`targets/images.ts:126-136`, `:504-571`); `target:prepare` only warms the registry (`scripts/prepare-target.ts:1-61`) | Yes |
| 6 | A build reads the target from disk, not git | `loadTargetRecipe` parses `<targetsDir>/<id>/target.json` from the filesystem (`catalog.ts:334-345`); the builder copies the Dockerfile from `recipe.directory` into a context archived from git (`image-builder.ts:95-112`) | Yes: `measure` can build an uncommitted `init` output |
| 7 | The recipe key | `recipeKey` digests target, pin, platform, base, Dockerfile, `imageContext`, lockfile path, `imageAssertResolves`, `commands.cwd` (`images.ts:49-65`); not `commands.test`, `commands.build`, the capture or resources | Yes: `measure`'s proposal to `commands.test` and `resources` needs no rebuild; a Dockerfile edit does |
| 8 | What the verifier grades | One session per suite: capture, build, snapshot, suite, snapshot; any persistent change is tampering (`verification/grade-suite.ts:75-157`, `changedDuringSuite` `:170-177`); the visible vitest suite is `commands.test` plus reporter flags (`verification/checks-runner.ts:355-400`) | Yes |
| 9 | The sandbox's shape | Network denied, the target's CPU, memory and per-command timeout (`targets/workspace.ts:56-66`); one environment link at the root (`:100`, `:122-130`); a timed-out command exits 124 with `Command timed out after` on stderr (`packages/sandbox/src/docker/docker-exec.ts:72-92`) | Yes |
| 10 | Where a target's fields are read | `builderPermissions` pre-approves the full build and test invocations (`targets/permissions.ts:42-58`); the drafter's target line reads `<cwd>/src` from the capture and `<cwd>/dist/` from `snapshotIgnore` (`prompts.ts:104-130`); `nodeTestExecArgv` feeds the check pre-check and the node-test runner (`intake/draft.ts:328`, `verification/checks-runner.ts:295`); `verifierDeadlineMs` feeds the verifier deadline and the budget refusal (`verification/docker-verifier.ts:65`, `controller/factory.ts:487-513`) | Yes |
| 11 | Every pnpm workspace package tests with vitest | `packages/*/package.json` and `examples/*/*/package.json` at `1da86aec`: every `test` script is `vitest ...` | Yes |
| 12 | The closures reproduce the hand-written lists | A throwaway script over `git show` at the two pins (this plan's research, not committed): `cli`'s install closure (deps + devDeps + optional, transitively) is exactly its committed `imageContext` (config-typescript whole plus eleven manifests, `@b4run/sandbox` included); its build closure over `dependencies` is its ten captured packages; topological order with alphabetical ties is `ag-ui sdk langgraph permissions workspace sqlite-storage core langchain memory cli`; each built package's build script names exactly one `tsc -b <file>` (`tsconfig.json` for all nine dependencies, `tsconfig.build.json` for `cli`, whose chain `extends ./tsconfig.json`), every `outDir` is `dist`; the only config package is `config-typescript` (no `build` script). `devkit`'s install closure is `config-typescript` and itself; its build closure is itself | Yes |
| 13 | The root's TypeScript | `devDependencies.typescript` is `7.0.2` at both pins; `packageManager` is `pnpm@10.33.0` | Yes |
| 14 | CI can read both pins in the unit suite | `source-validate` checks out with `fetch-depth: 0` (`ci.yml:98`); `targets-catalog.test.ts:471-498` already `cat-file -e`s every shipped pin | Yes |
| 15 | CI's Docker lane budget | `sandbox-docker`: `timeout-minutes: 30` (`ci.yml:392`), runs `test:sandbox` (`ci.yml:476`); the `cli` lane is opt-in (`controller/package.json:9`) | Yes |
| 16 | `memory.peak` is readable in the sandbox's container shape | Experiment on this host (Docker 27.4.0): `docker run --rm --network none --read-only --memory 512m node:24-slim@sha256:0e0ff40c… sh -c 'cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.max; stat -fc %T /sys/fs/cgroup'` printed `4702208`, `536870912`, `cgroup2fs` | Yes |
| 17 | vitest can list and report per file | Experiment in `packages/devkit` at `1da86aec` (vitest 4.1.11): `vitest list --run --no-cache --filesOnly --json=<file> --config vitest.config.ts --exclude test/templates.test.ts` exits 0 and writes `[{ "file": "<absolute path>" }, …]` (10 files); `vitest --run --no-cache --config vitest.config.ts test/reporting.test.ts --reporter=json --outputFile=<file>` writes `testResults: [{ name: "<absolute path>", status: "passed" }]` | Yes |
| 18 | What the example can use | `diff` (`review/operator-review.ts:2`, `createTwoFilesPatch`); Biome formats target files (the removed `formatManifest`, `npx biome format --stdin-file-path=target.json` from the app root, `git show 7c7ad3c2:examples/software-factory/controller/src/lib/targets/prepare.ts:97-106`); no YAML parser among the controller's dependencies (`controller/package.json:18-34`) | Yes |
| 19 | `inspectWorkspace`'s output is a path-to-digest map | `grade-suite.ts:95-114` spreads `targetInspectionOptions`; `changedDuringSuite` compares `Record<string, string>` | Yes |

**Prototype run (2026-09-25, this host, not committed).** Every code block of Tasks 1-10 and 12-17 was extracted from this plan into the worktree as written, run, and removed again before this plan was committed. Typecheck clean; the PR 1 unit tests (47, including Task 9's reproduction of `devkit` and `cli` against the real pins) and the PR 2 unit tests (38) pass; one assertion was corrected (`--cpus -1` is refused by `parseArgs` itself as an ambiguous option, so the test uses `0`). Biome reports formatting only (Trap 3). The two `devkit` Docker lanes (Tasks 10 and 17) passed together in 77 s after the lane setup's own builds: the generated `devkit` Dockerfile built with an empty promotion set (nothing nests at `6a59e00a`), and `measure` listed 11 files, proposed exactly the committed nine excludes (each failing alone with `ENOENT … /workspace/packages/devkit/templates/…`), kept `process-artifacts` and `reporting`, and proposed `512/2/70000/120000` against the committed `768/2/60000/240000` (build 0.4 s, suite 7.5 s, session 10 s, `memory.peak` 181 MiB: half of rung 2's 369 MiB measurement, from which the formula gives the committed 768). Not run: the `cli` lanes and hand measurement (Task 18).

**Prototype run after the review amendments (2026-09-25).** The amended code blocks were extracted and run the same way, then removed: typecheck clean, Biome lint clean, 93 unit tests pass (16 files, including the whole-object reproductions of both targets and their in-place regenerations). The `devkit` lanes passed again (92 s): nine excludes, each now also named as a capture omission of `templates/`; measured and proposed `512/2/70000/120000` (the generated target's resources are placeholders, so there is no prior to keep), confirmed by a session at those values (7.6 s suite, `memory.peak` 162 MiB). Against the committed target (prior `768/2/60000/240000`) the proposal would be `768/2/70000/240000`. The `cli` lanes were not run (the coordinator's instruction).

## Spec corrections

1. **§5 "`factory target:init` / `factory target:measure`"**: the `factory` CLI is a controller client and a registry reader; these are package scripts beside `target:prepare` (D1).
2. **§5 "capture is … for the package and each workspace dependency, `package.json`, `tsconfig*.json` and `src`"** conflates two closures and misses a third. Only the build closure (over `dependencies`) is captured; the install closure (what `--filter <pkg>...` installs, devDependencies included) contributes only manifests to `imageContext` (the `cli` target's `@b4run/sandbox`); config packages are captured, `imageContext`'d and `runnerConfig`'d whole. A dependency contributes the tsconfig its build compiles and what that extends inside its package, not every `tsconfig*.json` (`tsconfig.test.json` of a dependency is never read), which is also what the hand-written `cli` capture holds (D4).
3. **§5 "`imageContext` is the root manifests, lockfile and the dependencies' `package.json`"** omits config packages in full, which the image needs (a `tsconfig` in the image's copy is never read, but pnpm links the package, and the `devkit` and `cli` Dockerfiles copy it whole).
4. **§5 "`build` follows dependency order (`tsc -b` where project references exist, else a filtered `pnpm -r run build`)"** fails on both hand-written targets: references are partial and build scripts do more than compile (D5).
5. **§5 "`measure` runs the suite per file in the prepared image"**: there is no "prepared" image since item 4. `measure` calls `ImageRegistry.ensure` with the target's on-disk files, which builds an uncommitted `init` output on first need (Today, rows 5-6).
6. **§5 "proposes an exclude for each file that fails or hangs"**: a third class, a file that passes but writes the workspace, fails every verification as tampering (D11).
7. **§5 "resources from cgroup `memory.peak` and wall clock"**: not from the per-file runs; from separate whole-suite sessions with the proposed command (D12).
8. **§5 Proof "`init` reproduces the committed `devkit` target and the sub-project 4 `cli` target"**: exact reproduction is impossible for what a measurement or a person decides (excludes, resources, the `cli` target's eight-file scope, its extra `imageAssertResolves`, its promotion set, its drafting notes, and cosmetic list order). The proof asserts the exact set of differences and what each is (Task 9).
9. **§9 finding 6 "the generator … should produce the image recipe from the lockfile"**: everything in the `cli` Dockerfile but the promotion set is now generated from the manifests; the promotion set needs pnpm's hoisting, so `measure` learns it from a build (D7).
10. **§9 finding 12** is already fixed in the controller (the runner configuration is filled into `immutablePaths`); what item 5 adds is that `runnerConfig` is derived, so it is complete by construction (D10).
11. **§9 finding 20 "Item 5's generator should draft these notes"**: not deterministic; carried, not generated (D10). Follow-up.
12. **§9 finding 5 "the registry should record measured verifier time"**: `measure` now measures a session's wall clock and proposes `verifierDeadlineMs` from it; budgets derived from it remain deferred, as item 4 deferred them.
13. **§5 "`cli` … 177 test files"**: 169 test files in a 178-file directory at `765e6e16` (Today, row 4).

## PR split

- **PR 1 — `target:init`** (`blove/targets-init`, Tasks 1-11). Pure except for one Docker lane: the pin tree, the workspace graph, build tsconfigs, the vitest command, the Dockerfile template (its shell step executed in a temporary directory, no Docker), `deriveTarget`, proposals (format, diff, write), `initTarget` with carry-over and the same checks `target:prepare` runs before a build, the script, the reproduction proof against the two real pins, a lane that builds the generated `devkit` Dockerfile and an opt-in one for `cli` run by hand before merging, docs. Standalone: useful the day it merges, since a person can `init --write`, then `target:prepare`, then edit.
- **PR 2 — `target:measure`** (`blove/targets-measure`, Tasks 12-19). Needs PR 1's template markers, vitest command parser and proposals. The workspace capture takes any task-shaped object, file classification (fresh containers, a second run for each non-pass, flaky, capture omissions), resource proposal (never below the target's own, confirmed at the proposed values), the report and `measurement.md`, `measureSuite` over an injected session (unit-tested with a fake), Docker sessions, `measureTarget` with promotion learning and a partial report on a stop, the script, the `devkit` lane (the committed nine excludes), a full measurement of the generated `cli` target by hand, docs.

No changeset: examples only. No release-pinned script and no workflow file is touched (the new lanes are picked up by `test:sandbox`'s include glob; `test:sandbox:cli`'s file list is a package script).

## File structure

All paths are relative to `examples/software-factory/controller/` unless they start with `docs/`, `packages/` or `.github/`.

| File | PR | Responsibility |
|---|---|---|
| `src/lib/targets/init/pin-tree.ts` (new) | 1 | `PinTree`, `gitPinTree`: reads, kinds, children and sized file lists at a pin from the object store |
| `src/lib/targets/init/workspace-graph.ts` (new) | 1 | `workspaceGlobs`, `expandGlob`, `readWorkspace`, `resolvePackage`, `workspaceDependencies`, `closure`, `isConfigPackage`, `topologicalOrder` |
| `src/lib/targets/init/tsconfig.ts` (new) | 1 | `buildScriptTsconfig`, `buildConfig`, `packageTsconfigs` |
| `src/lib/targets/vitest-command.ts` (new) | 1, 2 | `vitestTestArgv`, `parseVitestCommand`, `withExcludes` (1); `perFileArgv`, `listArgv` (2) |
| `src/lib/targets/init/dockerfile.ts` (new) | 1 | `renderDockerfile`, the markers, `expectedPromotedOf`, `withExpectedPromoted`, `promotionMismatch` |
| `src/lib/targets/init/derive.ts` (new) | 1 | `deriveTarget`, `DEFAULT_BASE_IMAGE`, `PLACEHOLDER_RESOURCES`, `CarriedFields` |
| `src/lib/targets/proposal.ts` (new) | 1 | `FileProposal`, `formatManifest`, `renderDiff`, `writeProposal` |
| `src/lib/targets/init/init.ts` (new) | 1 | `initTarget` (carry-over, derive, check, format), `parseInitArgs` |
| `scripts/target-init.ts` (new), `package.json` | 1 | the `target:init` script |
| `test/pin-repo.ts` (new) | 1 | `pinRepo`, `cleanupPinRepos`, `json`, the `MINI` workspace fixture |
| `test/target-init-*.test.ts` (new) | 1 | unit tests per module; `target-init-reproduces.test.ts` is spec §5's `init` proof |
| `test/target-init.integration.test.ts` (new), `package.json` | 1 | the generated `devkit` Dockerfile builds; the `cli` one (opt-in, `test:sandbox:cli`) learns its promotion set and builds |
| `src/lib/targets/archive.ts`, `src/lib/targets/workspace.ts` | 2 | `WorkspaceTask`; `CaptureRole` gains `measure` |
| `src/lib/targets/measure/classify.ts` (new) | 2 | `MeasureError`, `changedPaths`, `captureOmissions`, `classifyFile`, `settleFile`, `proposeResources`, `settleResources`, `renderReport`, `renderMeasurementRecord` |
| `src/lib/targets/measure/session.ts` (new) | 2 | `MeasureSession`, `OpenSession`, `measureTask`, `dockerSessions` |
| `src/lib/targets/measure/measure.ts` (new) | 2 | `measureSuite`, `measureTarget`, `parseMeasureArgs` |
| `scripts/target-measure.ts` (new), `package.json` | 2 | the `target:measure` script |
| `targets/<id>/measurement.md` (written by `measure --write`, per target) | later | each exclude's class and reason, committed with `target.json` (D2) |
| `test/fake-measure-session.ts` (new), `test/target-measure-*.test.ts` (new) | 2 | fake sessions; unit tests |
| `test/target-measure.integration.test.ts` (new) | 2 | spec §5's `measure` proof on `devkit` |
| `examples/software-factory/README.md`, the spec | 1, 2 | docs |

## Traps (read before starting)

1. **Node 24.** `source ~/.nvm/nvm.sh && nvm use 24` before any test; Node 22 fails unrelated tests.
2. **Build the closure first.** `pnpm turbo run build --filter=@b4-example/software-factory-controller^...` after install and after every rebase: the controller imports `@b4run/*` `dist/`.
3. **Never `git stash`; add files by path; never bare `biome check --write`.** The lint is `pnpm --filter @b4-example/software-factory-controller lint`. The code in this plan is correct but not Biome-formatted (line breaks differ): before each commit run `pnpm --filter @b4-example/software-factory-controller exec biome check --write <the task's files>`, scoped to exactly the files the task names.
4. **`exactOptionalPropertyTypes`.** Spread optional fields conditionally; never assign `undefined` to an optional key.
5. **`init` reads the object store, never the working tree.** Every read goes through `PinTree`; a test edits the working tree after the commit and proves the read ignores it. `measure`, by contrast, reads the target files from disk on purpose (D2).
6. **`git ls-tree` pathspecs.** The root's children are `git ls-tree <pin>` with no pathspec; a directory's are `git ls-tree <pin> -- <dir>/` (the trailing slash lists its contents, not the directory entry). Always `-z`: a path may contain a space.
7. **Biome formats `target.json`.** Never write `JSON.stringify` output unformatted: `pnpm lint` fails on it. `formatManifest` pipes through the controller's own `node_modules/.bin/biome format --stdin-file-path=target.json` from the controller's root (the precedent #852 removed from `prepare.ts` used `npx`, which may resolve another Biome).
8. **The reproduction tests need both real pins.** They are in the object store of a full clone and of CI's `source-validate` checkout. A shallow local clone must not be deepened with `--depth=1` (it makes a full clone shallow, spec §9 finding 3): `ensurePin` already fetches by sha.
9. **BuildKit echoes the `RUN` line into the log.** The echoed promotion step contains both markers followed by `$actual` and `$expected`. `promotionMismatch` therefore matches only a marker followed by names to the end of the line, never a `$` or a quote (Task 5's test uses a real-shaped log).
10. **vitest's positional argument is a filter.** `test/a.test.ts` also selects `test/x/test/a.test.ts`. A per-file run must report exactly the file it was given, or `measure` stops with a harness error (never an exclude). "No test files found" is the same error.
11. **`memory.peak` is per container lifetime.** Only a fresh container's last reading after one whole suite means anything; the per-file session's peak is not used.
12. **The tamper rule.** A test that writes the workspace and passes would fail every verification; `measure` snapshots each file with the verifier's own inspection options (`targetInspectionOptions`), and so sees exactly what the verifier sees.
13. **Staging under `FACTORY_STATE_DIR`, never the app root.** `measure`'s captures and session state go under the state directory (spec §9 finding 4: `b4 dev` restarts on writes under the app root).
14. **No destructive Docker commands on this host.** No `prune`, `rm`, `rmi`: the daemon and the build cache are shared. The lanes build new recipe keys and delete nothing.
15. **`fileParallelism: false` and the process-wide registry.** The lanes reach the run's registry through `configuredImages()`; `measureTarget` takes the registry as an argument and never reads the configured one itself.
16. **CI's 30-minute `sandbox-docker` budget.** The `devkit` lanes run `--runs 1` and a 120 s file timeout; record each lane's wall clock in the PR description. If the job's time approaches the budget, stop and ask: moving a lane to opt-in is Brian's call, and raising `timeout-minutes` edits `ci.yml`, which also moves both audited workflow fixtures.
17. **A measurement runs each non-pass twice and the suite `--runs` + 1 times.** `devkit`'s nine excludes cost nine extra sessions (about 3 s each); the generated `cli` target's may cost many more. Budget the hand measurement accordingly (Task 18).

---

# PR 1: `target:init`

```bash
git fetch origin
git switch -c blove/targets-init origin/main
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@b4-example/software-factory-controller^...
pnpm --filter @b4-example/software-factory-controller test   # green before any change
git -C "$(git rev-parse --show-toplevel)" cat-file -e 6a59e00aed466330c182989265786af396f39d80^{commit}
git -C "$(git rev-parse --show-toplevel)" cat-file -e 765e6e16fec86bba0859d3f85edf7136f663f720^{commit}
```

### Task 1: A pin tree over the object store, and a fixture workspace

Everything `init` reads, it reads at the pin through this interface. The fixture is a miniature pnpm monorepo every later PR 1 task derives from.

**Files:**
- Create: `controller/src/lib/targets/init/pin-tree.ts`
- Create: `controller/test/pin-repo.ts`
- Test: `controller/test/target-init-pin-tree.test.ts`

- [ ] **Step 1: Write the fixture helper**

`test/pin-repo.ts`:

```ts
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const roots: string[] = []

/** `value` as the repository writes JSON files: two-space indent, trailing newline. */
export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/**
 * A throwaway repository holding `files` (and `links`: path to symlink target) in one commit,
 * so a pin is real without touching this repository.
 */
export function pinRepo(
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {},
): { root: string; pin: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-pin-repo-"))
  roots.push(root)
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  git("config", "commit.gpgsign", "false")
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    symlinkSync(target, join(root, path))
  }
  git("add", "-A")
  git("commit", "-q", "-m", "fixture")
  return { root, pin: git("rev-parse", "HEAD") }
}

export function cleanupPinRepos(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/**
 * A miniature pnpm monorepo shaped like this one: `@m/app` (the target: a build script that
 * does more than compile, a vitest test script) depends on `@m/core`, which depends on
 * `@m/util`; `@m/config` is a config package (no build script) every tsconfig extends;
 * `@m/tooling` is a devDependency of `@m/app` with a build of its own (installed, not
 * captured); `@m/lint` lives outside `packages/` and nothing depends on it.
 */
export const MINI: Readonly<Record<string, string>> = {
  "package.json": json({
    name: "mono",
    private: true,
    packageManager: "pnpm@10.33.0",
    devDependencies: { "@types/node": "26.1.2", typescript: "7.0.2", vitest: "4.1.11" },
  }),
  "pnpm-workspace.yaml":
    'packages:\n  - packages/*\n  - "tools/*"\n\n# built on install\nonlyBuiltDependencies:\n  - workerd\n',
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  ".npmrc": "package-manager-strict=true\n",
  "README.md": "mono\n",
  "packages/config/package.json": json({ name: "@m/config", private: true }),
  "packages/config/base.json": json({ compilerOptions: { strict: true } }),
  "packages/util/package.json": json({
    name: "@m/util",
    scripts: { build: "tsc -b tsconfig.json", test: "vitest --run" },
    devDependencies: { "@m/config": "workspace:*" },
  }),
  "packages/util/tsconfig.json": json({
    extends: "../config/base.json",
    compilerOptions: { outDir: "dist" },
  }),
  "packages/util/tsconfig.test.json": json({ extends: "./tsconfig.json" }),
  "packages/util/src/index.ts": "export const one = 1\n",
  "packages/util/test/util.test.ts": 'import { test } from "vitest"\ntest("u", () => {})\n',
  "packages/core/package.json": json({
    name: "@m/core",
    scripts: { build: "tsc -b tsconfig.json" },
    dependencies: { "@m/util": "workspace:^" },
    devDependencies: { "@m/config": "workspace:*" },
  }),
  "packages/core/tsconfig.json": json({
    extends: "../config/base.json",
    compilerOptions: { outDir: "lib" },
  }),
  "packages/core/src/index.ts": "export const two = 2\n",
  "packages/tooling/package.json": json({
    name: "@m/tooling",
    scripts: { build: "tsc -b tsconfig.json" },
    dependencies: { "@m/util": "workspace:*" },
  }),
  "packages/tooling/tsconfig.json": json({ compilerOptions: { outDir: "dist" } }),
  "packages/tooling/src/index.ts": "export {}\n",
  "packages/app/package.json": json({
    name: "@m/app",
    scripts: {
      build: "tsc -b tsconfig.build.json && node scripts/docs.mjs",
      test: "vitest --run --config vitest.config.ts",
    },
    dependencies: { "@m/core": "workspace:*", zod: "4.4.3" },
    devDependencies: {
      "@m/config": "workspace:*",
      "@m/tooling": "workspace:*",
      "@types/node": "26.1.2",
    },
  }),
  "packages/app/tsconfig.json": json({
    extends: "../config/base.json",
    compilerOptions: { noEmit: true },
  }),
  "packages/app/tsconfig.build.json": json({
    extends: "./tsconfig.json",
    compilerOptions: { noEmit: false, outDir: "dist" },
  }),
  "packages/app/vitest.config.ts": "export default {}\n",
  "packages/app/src/index.ts": "export const three = 3\n",
  "packages/app/test/app.test.ts": 'import { test } from "vitest"\ntest("a", () => {})\n',
  "packages/app/test/helpers/h.ts": "export {}\n",
  "packages/app/scripts/docs.mjs": "\n",
  "tools/lint/package.json": json({ name: "@m/lint", private: true }),
}
```

- [ ] **Step 2: Write the failing tests**

`test/target-init-pin-tree.test.ts`:

```ts
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { gitPinTree } from "../src/lib/targets/init/pin-tree.ts"
import { cleanupPinRepos, pinRepo } from "./pin-repo.ts"

afterEach(cleanupPinRepos)

describe("a pin tree", () => {
  it("reads files, kinds, children and sized file lists at the pin", () => {
    const { root, pin } = pinRepo({
      "package.json": "{}\n",
      "packages/a/package.json": '{"name":"a"}\n',
      "packages/a/src/x.ts": "export {}\n",
      "has space/f.txt": "f\n",
    })
    const tree = gitPinTree(root, pin)
    expect(tree.pin).toBe(pin)
    expect(tree.read("package.json")).toBe("{}\n")
    expect(tree.read("packages/a")).toBeUndefined()
    expect(tree.read("nope.json")).toBeUndefined()
    expect(tree.kind("packages/a")).toBe("dir")
    expect(tree.kind("packages/a/package.json")).toBe("file")
    expect(tree.kind("nope")).toBeUndefined()
    expect(tree.children("")).toEqual([
      { name: "has space", kind: "dir" },
      { name: "package.json", kind: "file" },
      { name: "packages", kind: "dir" },
    ])
    expect(tree.children("packages")).toEqual([{ name: "a", kind: "dir" }])
    expect(tree.files("packages/a")).toEqual([
      { path: "packages/a/package.json", bytes: 13, mode: "100644" },
      { path: "packages/a/src/x.ts", bytes: 10, mode: "100644" },
    ])
    expect(tree.files("has space")).toEqual([{ path: "has space/f.txt", bytes: 2, mode: "100644" }])
  })

  it("never reads the working tree", () => {
    const { root, pin } = pinRepo({ "package.json": "{}\n" })
    writeFileSync(join(root, "package.json"), '{"edited":true}\n')
    writeFileSync(join(root, "untracked.json"), "{}\n")
    const tree = gitPinTree(root, pin)
    expect(tree.read("package.json")).toBe("{}\n")
    expect(tree.kind("untracked.json")).toBeUndefined()
  })

  it("names a symlink a link", () => {
    const { root, pin } = pinRepo({ "src/a.ts": "export {}\n" }, { "src/b.ts": "a.ts" })
    const tree = gitPinTree(root, pin)
    expect(tree.children("src")).toEqual([
      { name: "a.ts", kind: "file" },
      { name: "b.ts", kind: "link" },
    ])
    expect(tree.files("src").map((f) => f.mode)).toEqual(["100644", "120000"])
  })

  it("refuses a pin the repository does not hold", () => {
    const { root } = pinRepo({ "a.txt": "a\n" })
    expect(() => gitPinTree(root, "f".repeat(40))).toThrow(/is not a commit in/)
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init-pin-tree.test.ts`
Expected: FAIL (`Cannot find module '../src/lib/targets/init/pin-tree.ts'`).

- [ ] **Step 4: Implement**

`src/lib/targets/init/pin-tree.ts`:

```ts
import { execFileSync } from "node:child_process"

/**
 * The repository at one commit, read from the object store and never from the working tree:
 * what `target:init` derives a target from. A target is an oracle input, and an edit a person
 * has not committed must not reach it.
 */
export interface PinTree {
  readonly repositoryRoot: string
  readonly pin: string
  /** A file's text at the pin; undefined when the pin holds no file there. */
  read(path: string): string | undefined
  kind(path: string): "file" | "dir" | undefined
  /** The immediate entries of `dir` ("" is the root), sorted by name. */
  children(dir: string): TreeEntry[]
  /** Every file under `path` (or `path` itself), repository-relative, sorted. */
  files(path: string): TreeFile[]
}

export interface TreeEntry {
  readonly name: string
  readonly kind: "file" | "dir" | "link" | "submodule"
}

export interface TreeFile {
  readonly path: string
  readonly bytes: number
  /** Git's mode: `100644`, `100755`, `120000` (a symlink) or `160000` (a submodule). */
  readonly mode: string
}

const MAX_BUFFER = 256 * 1024 * 1024
const byName = <T extends { readonly name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0

export function gitPinTree(repositoryRoot: string, pin: string): PinTree {
  const git = (args: readonly string[]) =>
    execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
  try {
    git(["cat-file", "-e", `${pin}^{commit}`])
  } catch {
    throw new Error(`${pin} is not a commit in ${repositoryRoot}`)
  }
  /** `git ls-tree -z [-l]` records: `<mode> <type> <object>[ <size>]\t<path>`. */
  const lsTree = (args: readonly string[]) =>
    git(["ls-tree", "-z", ...args])
      .split("\0")
      .filter((record) => record.length > 0)
      .map((record) => {
        const tab = record.indexOf("\t")
        const [mode, type, , size] = record.slice(0, tab).trim().split(/\s+/)
        return { mode: mode as string, type: type as string, size, path: record.slice(tab + 1) }
      })
  const kind = (path: string): "file" | "dir" | undefined => {
    let type: string
    try {
      type = git(["cat-file", "-t", `${pin}:${path}`]).trim()
    } catch {
      return undefined
    }
    return type === "tree" ? "dir" : type === "blob" ? "file" : undefined
  }
  return {
    repositoryRoot,
    pin,
    kind,
    read(path) {
      if (kind(path) !== "file") return undefined
      return git(["cat-file", "blob", `${pin}:${path}`])
    },
    children(dir) {
      return lsTree(dir === "" ? [pin] : [pin, "--", `${dir}/`])
        .map((record) => ({
          name: record.path.slice(record.path.lastIndexOf("/") + 1),
          kind:
            record.type === "tree"
              ? ("dir" as const)
              : record.type === "commit"
                ? ("submodule" as const)
                : record.mode === "120000"
                  ? ("link" as const)
                  : ("file" as const),
        }))
        .sort(byName)
    },
    files(path) {
      return lsTree(["-r", "-l", pin, "--", path])
        .map((record) => ({
          path: record.path,
          bytes: record.size === undefined || record.size === "-" ? 0 : Number(record.size),
          mode: record.mode,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    },
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init-pin-tree.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/init/pin-tree.ts examples/software-factory/controller/test/pin-repo.ts examples/software-factory/controller/test/target-init-pin-tree.test.ts
git commit -m "feat(software-factory): read a repository at a pin from the object store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (review-driven; commits `2ee18d8af`, `5ab3e4fc4`). `gitPinTree` resolves the pin once to the full 40-hex sha (`tree.pin`) and lists the tree once (`git ls-tree -r -t -z -l --full-tree`), so paths are relative to the repository's top level whatever the working directory. `kind()` returns `"file" | "dir" | "link" | "submodule" | undefined`; `read()` returns `undefined` for an absent path and throws for a directory, link or submodule; a git failure throws rather than reading as "absent". `files()` still lists link (120000) and submodule (160000) entries, so the capture checks keep refusing those modes.

### Task 2: The workspace graph at a pin

**Files:**
- Create: `controller/src/lib/targets/init/workspace-graph.ts`
- Test: `controller/test/target-init-graph.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/target-init-graph.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest"
import { gitPinTree } from "../src/lib/targets/init/pin-tree.ts"
import {
  closure,
  expandGlob,
  INSTALL,
  isConfigPackage,
  PROD,
  readWorkspace,
  resolvePackage,
  topologicalOrder,
  workspaceGlobs,
} from "../src/lib/targets/init/workspace-graph.ts"
import { cleanupPinRepos, json, MINI, pinRepo } from "./pin-repo.ts"

afterEach(cleanupPinRepos)

const graphOf = (files: Readonly<Record<string, string>>) => {
  const { root, pin } = pinRepo(files)
  const tree = gitPinTree(root, pin)
  return { tree, graph: readWorkspace(tree) }
}
const dirs = (packages: readonly { readonly dir: string }[]) => packages.map((p) => p.dir)

describe("pnpm-workspace.yaml", () => {
  it("reads the block packages list, quoted or not, and stops at the next key", () => {
    expect(workspaceGlobs(MINI["pnpm-workspace.yaml"] as string)).toEqual(["packages/*", "tools/*"])
    expect(workspaceGlobs("packages:\n  - 'a/*' # the apps\n  -   b\nother: 1\n")).toEqual(["a/*", "b"])
  })

  it("refuses what it does not read rather than guessing", () => {
    expect(() => workspaceGlobs("packages: [a, b]\n")).toThrow(/block `packages:` list/)
    expect(() => workspaceGlobs("packages:\n  - a: b\n")).toThrow(/unsupported line/)
    expect(() => workspaceGlobs("packages:\nother: 1\n")).toThrow(/lists no packages/)
  })

  it("expands whole-segment stars against the pin and refuses every other pattern", () => {
    const { tree } = graphOf(MINI)
    expect(expandGlob(tree, "packages/*")).toEqual([
      "packages/app",
      "packages/config",
      "packages/core",
      "packages/tooling",
      "packages/util",
    ])
    expect(expandGlob(tree, "tools/lint")).toEqual(["tools/lint"])
    expect(expandGlob(tree, "nowhere/*")).toEqual([])
    for (const glob of ["!packages/x", "packages/**", "packages/a*", "packages/{a,b}", "../x"])
      expect(() => expandGlob(tree, glob), glob).toThrow(/literal segments and whole-segment \*/)
  })
})

describe("the workspace graph", () => {
  it("names every package by name and by directory", () => {
    const { graph } = graphOf(MINI)
    expect([...graph.packages.keys()].sort()).toEqual([
      "@m/app",
      "@m/config",
      "@m/core",
      "@m/lint",
      "@m/tooling",
      "@m/util",
    ])
    expect(resolvePackage(graph, "@m/app").dir).toBe("packages/app")
    expect(resolvePackage(graph, "packages/app/").name).toBe("@m/app")
    expect(resolvePackage(graph, "./packages/core").name).toBe("@m/core")
    expect(() => resolvePackage(graph, "@m/ghost")).toThrow(/No workspace package is named or lives at/)
  })

  it("closes over dependencies for the build and over every kind for the install", () => {
    const { graph } = graphOf(MINI)
    const app = resolvePackage(graph, "@m/app")
    expect(dirs(closure(graph, app, PROD))).toEqual(["packages/app", "packages/core", "packages/util"])
    expect(dirs(closure(graph, app, INSTALL))).toEqual([
      "packages/app",
      "packages/config",
      "packages/core",
      "packages/tooling",
      "packages/util",
    ])
    expect(isConfigPackage(resolvePackage(graph, "@m/config"))).toBe(true)
    expect(isConfigPackage(app)).toBe(false)
  })

  it("orders a build closure dependencies first, ties by directory", () => {
    const { graph } = graphOf(MINI)
    const app = resolvePackage(graph, "@m/app")
    expect(dirs(topologicalOrder(graph, closure(graph, app, PROD), PROD))).toEqual([
      "packages/util",
      "packages/core",
      "packages/app",
    ])
    // Two packages with no edge between them come out in directory order.
    const both = [resolvePackage(graph, "@m/tooling"), resolvePackage(graph, "@m/config")]
    expect(dirs(topologicalOrder(graph, both, PROD))).toEqual(["packages/config", "packages/tooling"])
  })

  it("refuses a workspace dependency no package is named, and a cycle", () => {
    const ghost = graphOf({
      ...MINI,
      "packages/core/package.json": json({
        name: "@m/core",
        scripts: { build: "tsc -b tsconfig.json" },
        dependencies: { "@m/ghost": "workspace:*" },
      }),
    })
    const core = resolvePackage(ghost.graph, "@m/core")
    expect(() => closure(ghost.graph, core, PROD)).toThrow(/depends on @m\/ghost as workspace:\*/)
    const cyclic = graphOf({
      ...MINI,
      "packages/util/package.json": json({
        name: "@m/util",
        scripts: { build: "tsc -b tsconfig.json" },
        dependencies: { "@m/core": "workspace:*" },
      }),
    })
    const app = resolvePackage(cyclic.graph, "@m/app")
    expect(() => topologicalOrder(cyclic.graph, closure(cyclic.graph, app, PROD), PROD)).toThrow(
      /dependency cycle: none of @m\/app, @m\/core, @m\/util can be built first/,
    )
  })

  it("refuses two packages of one name, and skips a matched directory with no name", () => {
    expect(() =>
      graphOf({ ...MINI, "tools/lint/package.json": json({ name: "@m/util" }) }),
    ).toThrow(/Two workspace packages are named @m\/util: packages\/util and tools\/lint/)
    const { graph } = graphOf({ ...MINI, "tools/lint/package.json": json({ private: true }) })
    expect(graph.packages.has("@m/lint")).toBe(false)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init-graph.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/targets/init/workspace-graph.ts`:

```ts
import { z } from "zod"
import type { PinTree } from "./pin-tree.js"

const Dependencies = z.record(z.string(), z.string()).optional()

/** A workspace package's `package.json`, as far as `init` reads it. */
const PackageManifestSchema = z.looseObject({
  name: z.string().min(1).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: Dependencies,
  devDependencies: Dependencies,
  optionalDependencies: Dependencies,
})
export type PackageManifest = z.infer<typeof PackageManifestSchema>

const RootManifestSchema = z.looseObject({
  packageManager: z.string().optional(),
  dependencies: Dependencies,
  devDependencies: Dependencies,
})
export type RootManifest = z.infer<typeof RootManifestSchema>

export interface WorkspacePackage {
  readonly name: string
  /** Repository-relative: `packages/devkit`. */
  readonly dir: string
  readonly manifest: PackageManifest
}

export interface WorkspaceGraph {
  readonly root: RootManifest
  /** By package name. */
  readonly packages: ReadonlyMap<string, WorkspacePackage>
}

export type DependencyKind = "dependencies" | "devDependencies" | "optionalDependencies"
/** What a package's build compiles against: its runtime dependencies. */
export const PROD: readonly DependencyKind[] = ["dependencies"]
/** What `pnpm install --filter <pkg>...` installs: every kind, transitively (`--filter-prod` is the other). */
export const INSTALL: readonly DependencyKind[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
]

const byDir = (a: WorkspacePackage, b: WorkspacePackage) =>
  a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0
const under = (dir: string, name: string) => (dir === "" ? name : `${dir}/${name}`)

/**
 * The `packages:` globs of a `pnpm-workspace.yaml`. Deliberately not a YAML parser (the example
 * carries none, and adding a dependency to an example re-keys the lockfile): the block form,
 * `packages:` then `  - <glob>` lines, quoted or not, is what pnpm documents and what this
 * repository writes. Anything else under `packages:` is refused by line, never guessed.
 */
export function workspaceGlobs(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/.test(line))
  if (start === -1) throw new Error("pnpm-workspace.yaml has no block `packages:` list")
  const globs: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue
    if (!/^\s/.test(line)) break
    const match = /^\s+-\s+(?:"([^"]+)"|'([^']+)'|([^\s#"':]+))\s*(?:#.*)?$/.exec(line)
    if (!match)
      throw new Error(`pnpm-workspace.yaml: unsupported line under packages: ${JSON.stringify(line)}`)
    globs.push((match[1] ?? match[2] ?? match[3]) as string)
  }
  if (globs.length === 0) throw new Error("pnpm-workspace.yaml lists no packages")
  return globs
}

/**
 * The package directories `glob` names at the pin. Literal segments and whole-segment `*` only:
 * the patterns this repository's workspace file uses. A negation, `**`, a partial wildcard or a
 * brace is refused, because expanding it wrongly would silently add or drop a package.
 */
export function expandGlob(tree: PinTree, glob: string): string[] {
  const clean = glob.replace(/\/+$/, "")
  const segments = clean.split("/")
  if (
    clean.startsWith("!") ||
    clean.startsWith("/") ||
    /[?[\]{}]/.test(clean) ||
    segments.some((s) => s === "" || s === "." || s === ".." || (s.includes("*") && s !== "*"))
  )
    throw new Error(
      `pnpm-workspace.yaml glob ${JSON.stringify(glob)}: target:init reads literal segments and whole-segment * only`,
    )
  let found = [""]
  for (const segment of segments)
    found = found.flatMap((dir) =>
      segment === "*"
        ? tree
            .children(dir)
            .filter((entry) => entry.kind === "dir")
            .map((entry) => under(dir, entry.name))
        : tree.kind(under(dir, segment)) === "dir"
          ? [under(dir, segment)]
          : [],
    )
  return found.filter((dir) => tree.kind(`${dir}/package.json`) === "file")
}

function parseManifest<T>(schema: z.ZodType<T>, tree: PinTree, path: string): T {
  const text = tree.read(path)
  if (text === undefined) throw new Error(`${path} does not exist at ${tree.pin}`)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} at ${tree.pin} is not JSON: ${String(error)}`)
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new Error(`${path} at ${tree.pin}: ${parsed.error.message}`)
  return parsed.data
}

/** The root manifest and every named workspace package at the pin. */
export function readWorkspace(tree: PinTree): WorkspaceGraph {
  const root = parseManifest(RootManifestSchema, tree, "package.json")
  const yaml = tree.read("pnpm-workspace.yaml")
  if (yaml === undefined)
    throw new Error(
      `pnpm-workspace.yaml does not exist at ${tree.pin}: target:init generates targets for pnpm workspaces`,
    )
  const packages = new Map<string, WorkspacePackage>()
  const found = [...new Set(workspaceGlobs(yaml).flatMap((glob) => expandGlob(tree, glob)))].sort()
  for (const dir of found) {
    const manifest = parseManifest(PackageManifestSchema, tree, `${dir}/package.json`)
    // An unnamed package (an orchestration-only manifest) cannot be depended on by name.
    if (manifest.name === undefined) continue
    const other = packages.get(manifest.name)
    if (other)
      throw new Error(`Two workspace packages are named ${manifest.name}: ${other.dir} and ${dir}`)
    packages.set(manifest.name, { name: manifest.name, dir, manifest })
  }
  return { root, packages }
}

/** The package `ref` names: a package name, or its directory (`packages/devkit`, `./packages/devkit/`). */
export function resolvePackage(graph: WorkspaceGraph, ref: string): WorkspacePackage {
  const named = graph.packages.get(ref)
  if (named) return named
  const dir = ref.replace(/^\.\//, "").replace(/\/+$/, "")
  for (const pkg of graph.packages.values()) if (pkg.dir === dir) return pkg
  throw new Error(`No workspace package is named or lives at ${JSON.stringify(ref)}`)
}

/** `pkg`'s `workspace:` dependencies of `kinds`, sorted by directory. */
export function workspaceDependencies(
  graph: WorkspaceGraph,
  pkg: WorkspacePackage,
  kinds: readonly DependencyKind[],
): WorkspacePackage[] {
  const found = new Map<string, WorkspacePackage>()
  for (const kind of kinds)
    for (const [name, spec] of Object.entries(pkg.manifest[kind] ?? {})) {
      if (!spec.startsWith("workspace:")) continue
      const dep = graph.packages.get(name)
      if (!dep)
        throw new Error(
          `${pkg.name} (${pkg.dir}) depends on ${name} as ${spec}, which no workspace package is named`,
        )
      found.set(name, dep)
    }
  return [...found.values()].sort(byDir)
}

/** `from` and every workspace package it reaches through `kinds`, transitively, by directory. */
export function closure(
  graph: WorkspaceGraph,
  from: WorkspacePackage,
  kinds: readonly DependencyKind[],
): WorkspacePackage[] {
  const seen = new Map([[from.name, from]])
  const queue = [from]
  for (let next = queue.pop(); next !== undefined; next = queue.pop())
    for (const dep of workspaceDependencies(graph, next, kinds))
      if (!seen.has(dep.name)) {
        seen.set(dep.name, dep)
        queue.push(dep)
      }
  return [...seen.values()].sort(byDir)
}

/**
 * A package with nothing to build: `@b4run/config-typescript`, which tsconfig files read by a
 * relative `extends`. Captured and put into the image whole, never compiled.
 */
export function isConfigPackage(pkg: WorkspacePackage): boolean {
  return pkg.manifest.scripts?.build === undefined
}

/**
 * `packages` with every package after the ones it depends on through `kinds` (among
 * `packages`), ties broken by directory, so the order is a function of the manifests alone.
 * A build orders by runtime edges (`PROD`): a devDependency never orders a compile.
 */
export function topologicalOrder(
  graph: WorkspaceGraph,
  packages: readonly WorkspacePackage[],
  kinds: readonly DependencyKind[],
): WorkspacePackage[] {
  const members = new Set(packages.map((p) => p.name))
  const edges = new Map(
    packages.map((p) => [
      p.name,
      workspaceDependencies(graph, p, kinds)
        .map((d) => d.name)
        .filter((name) => members.has(name)),
    ]),
  )
  const done = new Set<string>()
  const order: WorkspacePackage[] = []
  while (order.length < packages.length) {
    const next = packages
      .filter((p) => !done.has(p.name) && (edges.get(p.name) ?? []).every((d) => done.has(d)))
      .sort(byDir)[0]
    if (next === undefined)
      throw new Error(
        `Workspace dependency cycle: none of ${packages
          .filter((p) => !done.has(p.name))
          .map((p) => p.name)
          .sort()
          .join(", ")} can be built first`,
      )
    done.add(next.name)
    order.push(next)
  }
  return order
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init-graph.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/init/workspace-graph.ts examples/software-factory/controller/test/target-init-graph.test.ts
git commit -m "feat(software-factory): the pnpm workspace graph at a pin, its closures and build order

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (review-driven; commits `8f0c71c77`, `516079afc`). Manifests read `peerDependencies`: INSTALL follows dependencies, devDependencies, optionalDependencies and peerDependencies, and PROD is `["dependencies", "peerDependencies"]`. This is an interpretation of D4, not a change of it: D4's reasoning (the build closure is what the build compiles against) covers workspace peers, which are imported, so they are built and captured. Globs are stricter: extglob characters are refused, `*` skips dot directories, `node_modules` and `bower_components`, and a symlink or submodule under a glob is refused. Dependency specs `init` cannot read are refused: workspace aliases, `workspace:./path`, and `link:`/`file:` specs pointing at workspace directories.

### Task 3: Which tsconfig each package builds with, and where it writes

**Files:**
- Create: `controller/src/lib/targets/init/tsconfig.ts`
- Test: `controller/test/target-init-tsconfig.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/target-init-tsconfig.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest"
import { gitPinTree } from "../src/lib/targets/init/pin-tree.ts"
import {
  buildConfig,
  buildScriptTsconfig,
  packageTsconfigs,
} from "../src/lib/targets/init/tsconfig.ts"
import { readWorkspace, resolvePackage } from "../src/lib/targets/init/workspace-graph.ts"
import { cleanupPinRepos, json, MINI, pinRepo } from "./pin-repo.ts"

afterEach(cleanupPinRepos)

const at = (files: Readonly<Record<string, string>>) => {
  const { root, pin } = pinRepo(files)
  const tree = gitPinTree(root, pin)
  const graph = readWorkspace(tree)
  return { tree, pkg: (ref: string) => resolvePackage(graph, ref) }
}
const withBuild = (build: string | undefined) => ({
  name: "@m/x",
  dir: "packages/x",
  manifest: { name: "@m/x", ...(build === undefined ? {} : { scripts: { build } }) },
})

describe("the tsconfig a build script compiles", () => {
  it("is the one file its `tsc -b` names, whatever runs around it", () => {
    expect(buildScriptTsconfig(withBuild("tsc -b tsconfig.json"))).toBe("tsconfig.json")
    expect(buildScriptTsconfig(withBuild("tsc -b tsconfig.build.json && node scripts/docs.mjs"))).toBe(
      "tsconfig.build.json",
    )
    // ag-ui's shape: a quoted node -e holding its own && before and after the compile.
    expect(
      buildScriptTsconfig(
        withBuild(
          `node -e "if (a && b) rm()" && tsc --build tsconfig.json && node -e "copy()"`,
        ),
      ),
    ).toBe("tsconfig.json")
    expect(buildScriptTsconfig(withBuild(undefined))).toBeUndefined()
  })

  it("refuses a build it cannot read as exactly one tsc -b", () => {
    expect(() => buildScriptTsconfig(withBuild("tsup src/index.ts"))).toThrow(/found 0/)
    expect(() => buildScriptTsconfig(withBuild("tsc -b a.json && tsc -b b.json"))).toThrow(/found 2/)
  })
})

describe("a package's build configuration at the pin", () => {
  it("follows extends inside the package, stops at a config package, and finds the outDir", () => {
    const { tree, pkg } = at(MINI)
    expect(buildConfig(tree, pkg("@m/app"))).toEqual({
      tsconfig: "tsconfig.build.json",
      files: ["packages/app/tsconfig.build.json", "packages/app/tsconfig.json"],
      outDir: "packages/app/dist/",
      externalExtends: ["packages/config/base.json"],
    })
    expect(buildConfig(tree, pkg("@m/core")).outDir).toBe("packages/core/lib/")
    expect(buildConfig(tree, pkg("@m/tooling")).externalExtends).toEqual([])
  })

  it("lists every tsconfig*.json in the package directory", () => {
    const { tree, pkg } = at(MINI)
    expect(packageTsconfigs(tree, pkg("@m/app"))).toEqual([
      "packages/app/tsconfig.build.json",
      "packages/app/tsconfig.json",
    ])
    expect(packageTsconfigs(tree, pkg("@m/util"))).toEqual([
      "packages/util/tsconfig.json",
      "packages/util/tsconfig.test.json",
    ])
  })

  it("refuses a build that says nothing about where it writes, or writes outside the package", () => {
    const none = at({ ...MINI, "packages/core/tsconfig.json": json({ extends: "../config/base.json" }) })
    expect(() => buildConfig(none.tree, none.pkg("@m/core"))).toThrow(/sets no compilerOptions.outDir/)
    const outside = at({
      ...MINI,
      "packages/core/tsconfig.json": json({ compilerOptions: { outDir: "../../out" } }),
    })
    expect(() => buildConfig(outside.tree, outside.pkg("@m/core"))).toThrow(/outside the package/)
    const info = at({
      ...MINI,
      "packages/core/tsconfig.json": json({
        compilerOptions: { outDir: "lib", tsBuildInfoFile: "build.tsbuildinfo" },
      }),
    })
    expect(() => buildConfig(info.tree, info.pkg("@m/core"))).toThrow(
      /writes packages\/core\/build.tsbuildinfo, outside its outDir packages\/core\/lib/,
    )
    const jsonc = at({ ...MINI, "packages/core/tsconfig.json": "{ // a comment\n}\n" })
    expect(() => buildConfig(jsonc.tree, jsonc.pkg("@m/core"))).toThrow(/is not plain JSON/)
    const bare = at({
      ...MINI,
      "packages/core/tsconfig.json": json({
        extends: "@tsconfig/node24",
        compilerOptions: { outDir: "lib" },
      }),
    })
    expect(() => buildConfig(bare.tree, bare.pkg("@m/core"))).toThrow(/follows only relative extends/)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init-tsconfig.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/targets/init/tsconfig.ts`:

```ts
import { posix } from "node:path"
import type { PinTree } from "./pin-tree.js"
import type { WorkspacePackage } from "./workspace-graph.js"

/**
 * One `tsc -b <file>` (or `--build`) in a build script, at its start or after `&&`. The target's
 * own build script is not run as a whole: `cli`'s ends in a docs generator that reads
 * `apps/web`, and `ag-ui`'s moves files around its compile. The compile is what a target needs.
 */
const TSC_BUILD = /(?:^|&&)\s*tsc\s+(?:-b|--build)\s+([A-Za-z0-9._/-]+\.json)(?=\s|$)/g

export interface BuildConfig {
  /** Package-relative: the file the build script's `tsc -b` names. */
  readonly tsconfig: string
  /** Repository-relative: that file and the files it extends inside the package, in order. */
  readonly files: readonly string[]
  /** Repository-relative directory prefix the build writes, with its trailing slash. */
  readonly outDir: string
  /** Repository-relative files outside the package the chain extends (a config package's). */
  readonly externalExtends: readonly string[]
}

/** The tsconfig `pkg`'s build compiles; undefined when it has no build script. */
export function buildScriptTsconfig(
  pkg: Pick<WorkspacePackage, "name" | "dir" | "manifest">,
): string | undefined {
  const script = pkg.manifest.scripts?.build
  if (script === undefined) return undefined
  const found = [...script.matchAll(TSC_BUILD)].map((match) => match[1] as string)
  if (found.length !== 1)
    throw new Error(
      `${pkg.name} (${pkg.dir}): its build script must run exactly one \`tsc -b <tsconfig>\` for target:init to build it (found ${found.length}): ${script}`,
    )
  return found[0]
}

/** Every `tsconfig*.json` directly in `pkg`'s directory at the pin, repository-relative. */
export function packageTsconfigs(tree: PinTree, pkg: Pick<WorkspacePackage, "dir">): string[] {
  return tree
    .children(pkg.dir)
    .filter((entry) => entry.kind === "file" && /^tsconfig.*\.json$/.test(entry.name))
    .map((entry) => `${pkg.dir}/${entry.name}`)
}

const MAX_EXTENDS = 8

/**
 * What `pkg`'s build reads and writes: its build tsconfig, the chain it `extends` inside the
 * package, and the nearest `outDir` along that chain (a child's overrides its parent's). The
 * chain stops at the first `extends` that leaves the package; that file must belong to a config
 * package the target captures, which `deriveTarget` checks. tsconfig files are read as plain
 * JSON: every one in this repository is, and a JSONC one is refused rather than misread.
 */
export function buildConfig(tree: PinTree, pkg: WorkspacePackage): BuildConfig {
  const tsconfig = buildScriptTsconfig(pkg)
  if (tsconfig === undefined) throw new Error(`${pkg.name} (${pkg.dir}) has no build script`)
  const files: string[] = []
  const externalExtends: string[] = []
  let outDir: string | undefined
  let buildInfo: string | undefined
  let current = posix.normalize(`${pkg.dir}/${tsconfig}`)
  for (let depth = 0; ; depth++) {
    if (depth === MAX_EXTENDS)
      throw new Error(`${pkg.name}: ${files[0]} extends more than ${MAX_EXTENDS} deep`)
    const text = tree.read(current)
    if (text === undefined)
      throw new Error(`${pkg.name}: ${current} does not exist at ${tree.pin}`)
    let parsed: {
      extends?: unknown
      compilerOptions?: { outDir?: unknown; tsBuildInfoFile?: unknown }
    }
    try {
      parsed = JSON.parse(text) as typeof parsed
    } catch (error) {
      throw new Error(
        `${current} is not plain JSON (target:init reads tsconfig files with JSON.parse): ${String(error)}`,
      )
    }
    files.push(current)
    const own = parsed.compilerOptions?.outDir
    if (outDir === undefined && typeof own === "string")
      outDir = posix.normalize(posix.join(posix.dirname(current), own))
    const info = parsed.compilerOptions?.tsBuildInfoFile
    if (buildInfo === undefined && typeof info === "string")
      buildInfo = posix.normalize(posix.join(posix.dirname(current), info))
    const parent = parsed.extends
    if (parent === undefined) break
    if (typeof parent !== "string" || !parent.startsWith("."))
      throw new Error(
        `${current} extends ${JSON.stringify(parent)}: target:init follows only relative extends`,
      )
    const next = posix.normalize(posix.join(posix.dirname(current), parent))
    if (!next.startsWith(`${pkg.dir}/`)) {
      externalExtends.push(next)
      break
    }
    current = next
  }
  if (outDir === undefined)
    throw new Error(
      `${pkg.name}: ${files[0]} (and what it extends inside the package) sets no compilerOptions.outDir, so target:init cannot tell where its build writes`,
    )
  if (!outDir.startsWith(`${pkg.dir}/`))
    throw new Error(`${pkg.name}: its build writes ${outDir}, outside the package`)
  // snapshotIgnore holds directory prefixes: a build-info file outside the outDir would read,
  // after a builder's build, as a file the baseline lacks.
  if (buildInfo !== undefined && !buildInfo.startsWith(`${outDir}/`))
    throw new Error(
      `${pkg.name}: its build writes ${buildInfo}, outside its outDir ${outDir}, where snapshotIgnore cannot cover it`,
    )
  return { tsconfig, files, outDir: `${outDir}/`, externalExtends }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init-tsconfig.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/init/tsconfig.ts examples/software-factory/controller/test/target-init-tsconfig.test.ts
git commit -m "feat(software-factory): read which tsconfig a package builds with and where it writes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (review-driven; commits `84a881b56`, `d2742c528`). The build info lands where TypeScript puts it by default (its `getTsBuildInfoEmitOutputFilePath`; checked against a real `tsc -b` 7.0.2), and `declarationDir`, `outFile` and the build info are each refused outside `outDir`; an `outDir` overlapping `src` or `test` is refused. The whole `extends` chain is read: `externalExtends` lists every external file along it (at the pins, `config-typescript`'s `node.json`, `library.json` and `base.json`), and an `extends` naming a directory throws. Also refused: `${` values, a build script whose `tsc` is not `-b`, a `cd` in the chain, and anything after the one config. `BuildConfig` gains `references` (repository-relative), which Task 6 checks.

### Task 4: The vitest command

A target's `commands.test` is a vitest argv: a base (the package's own `test` script, run through `pnpm exec`, with `--no-cache`), then positional files (a scope a person chose), then `--exclude` pairs (what `measure` proposed). One module builds it and reads it back, so `init`, the carry-over and `measure` agree on its shape.

**Files:**
- Create: `controller/src/lib/targets/vitest-command.ts`
- Test: `controller/test/target-vitest-command.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/target-vitest-command.test.ts`:

```ts
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { TargetSchema, targetsDir } from "../src/lib/targets/catalog.ts"
import {
  parseVitestCommand,
  vitestTestArgv,
  withExcludes,
} from "../src/lib/targets/vitest-command.ts"

const pkg = (test: string | undefined) => ({
  name: "@m/x",
  dir: "packages/x",
  manifest: { name: "@m/x", ...(test === undefined ? {} : { scripts: { test } }) },
})
const shipped = (id: string) =>
  TargetSchema.parse(JSON.parse(readFileSync(join(targetsDir, id, "target.json"), "utf8")))

describe("a package's test script as a target's test command", () => {
  it("runs it through pnpm exec, once, without vitest's cache", () => {
    expect(vitestTestArgv(pkg("vitest --run --config vitest.config.ts"))).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "--run",
      "--no-cache",
      "--config",
      "vitest.config.ts",
    ])
    expect(vitestTestArgv(pkg("vitest run"))).toEqual(["pnpm", "exec", "vitest", "run", "--no-cache"])
    expect(vitestTestArgv(pkg("vitest"))).toEqual(["pnpm", "exec", "vitest", "--run", "--no-cache"])
    expect(vitestTestArgv(pkg("vitest --run --no-cache --passWithNoTests"))).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "--run",
      "--no-cache",
      "--passWithNoTests",
    ])
  })

  it("refuses what is not a plain vitest run", () => {
    expect(() => vitestTestArgv(pkg(undefined))).toThrow(/has no test script/)
    expect(() => vitestTestArgv(pkg("node --test test"))).toThrow(/vitest targets only/)
    expect(() => vitestTestArgv(pkg("vitest --run && echo done"))).toThrow(/is a shell line/)
    expect(() => vitestTestArgv(pkg("vitest watch"))).toThrow(/passes "watch"/)
    expect(() => vitestTestArgv(pkg("vitest --run --coverage"))).toThrow(/passes "--coverage"/)
    expect(() => vitestTestArgv(pkg("vitest --run test/a.test.ts"))).toThrow(/passes "test\/a.test.ts"/)
  })
})

describe("reading a test command back", () => {
  it("splits the shipped devkit command into its base and nine excludes, and rebuilds it exactly", () => {
    const test = shipped("devkit").commands.test
    const command = parseVitestCommand(test)
    expect(command.base).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "--run",
      "--no-cache",
      "--config",
      "vitest.config.ts",
    ])
    expect(command.config).toBe("vitest.config.ts")
    expect(command.files).toEqual([])
    expect(command.excludes).toHaveLength(9)
    expect(withExcludes(command, command.excludes)).toEqual(test)
  })

  it("keeps the shipped cli command's scope of eight files", () => {
    const test = shipped("cli").commands.test
    const command = parseVitestCommand(test)
    expect(command.files).toHaveLength(8)
    expect(command.excludes).toEqual([])
    expect(withExcludes(command, [])).toEqual(test)
  })

  it("sorts and de-duplicates excludes, and refuses a shape it cannot read", () => {
    const command = parseVitestCommand(["pnpm", "exec", "vitest", "--run", "--exclude=b", "a.test.ts"])
    expect(command.excludes).toEqual(["b"])
    expect(withExcludes(command, ["z", "b", "z"])).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "--run",
      "a.test.ts",
      "--exclude",
      "b",
      "--exclude",
      "z",
    ])
    expect(() => parseVitestCommand(["npm", "test"])).toThrow(/pnpm exec vitest/)
    expect(() => parseVitestCommand(["pnpm", "exec", "vitest", "--exclude"])).toThrow(/--exclude with no value/)
    expect(() => parseVitestCommand(["pnpm", "exec", "vitest", "--project", "a"])).toThrow(/--project/)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-vitest-command.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/targets/vitest-command.ts`:

```ts
/**
 * A target's `commands.test` for a vitest suite: `pnpm exec vitest <flags> [files...]
 * [--exclude <glob>...]`. The base is the package's own `test` script; the files are a scope a
 * person chose; the excludes are what `target:measure` proposed, each with its failure output
 * in the measurement's report. The verifier appends its reporter flags after all of it
 * (`verification/checks-runner.ts`), so nothing here may depend on being last.
 */
export interface VitestCommand {
  /** `pnpm exec vitest` and every flag, in order. */
  readonly base: readonly string[]
  /** The `--config` value, when the command names one. */
  readonly config: string | undefined
  /** Positional filters: the files a narrowed suite runs. */
  readonly files: readonly string[]
  readonly excludes: readonly string[]
}

const SHELL = /[&|;<>$`"'\\()]/
/**
 * The only test-script flags read (plan D3): what this repository's packages pass. Anything
 * else might select other files or change the run, and is refused rather than guessed at.
 */
const SCRIPT_FLAGS = new Set(["--run", "--no-cache", "--passWithNoTests"])
/** Flags that take a value and would change which files run: refused rather than half-read. */
const UNREAD = ["--project", "--root", "--dir", "-r"]

/** `pkg`'s `test` script as a target's test command: through `pnpm exec`, in run mode, cacheless. */
export function vitestTestArgv(pkg: {
  readonly name: string
  readonly dir: string
  readonly manifest: { readonly scripts?: Readonly<Record<string, string>> | undefined }
}): string[] {
  const script = pkg.manifest.scripts?.test
  if (script === undefined) throw new Error(`${pkg.name} (${pkg.dir}) has no test script`)
  if (SHELL.test(script))
    throw new Error(
      `${pkg.name}: its test script is a shell line (${script}); target:init takes a plain \`vitest ...\` invocation`,
    )
  const [runner, ...words] = script.trim().split(/\s+/)
  if (runner !== "vitest")
    throw new Error(
      `${pkg.name}: its test script runs ${JSON.stringify(runner)}; target:init generates vitest targets only (every pnpm package in this repository tests with vitest)`,
    )
  const args: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string
    if ((i === 0 && word === "run") || SCRIPT_FLAGS.has(word) || word.startsWith("--config="))
      args.push(word)
    else if (word === "--config") {
      const value = words[++i]
      if (value === undefined) throw new Error(`${pkg.name}: its test script ends in --config`)
      args.push(word, value)
    } else
      throw new Error(
        `${pkg.name}: its test script passes ${JSON.stringify(word)}; target:init reads only run, --run, --config <file>, --no-cache and --passWithNoTests, and will not guess what anything else selects`,
      )
  }
  let runAt = args[0] === "run" ? 0 : args.indexOf("--run")
  if (runAt === -1) {
    args.unshift("--run")
    runAt = 0
  }
  // vitest writes its results cache under the nearest node_modules, which in the sandbox is
  // the image's read-only one.
  if (!args.includes("--no-cache")) args.splice(runAt + 1, 0, "--no-cache")
  return ["pnpm", "exec", "vitest", ...args]
}

/** Read `argv` back into its parts. Refuses any shape it would have to guess at. */
export function parseVitestCommand(argv: readonly string[]): VitestCommand {
  if (argv[0] !== "pnpm" || argv[1] !== "exec" || argv[2] !== "vitest")
    throw new Error(
      `A generated target's test command is \`pnpm exec vitest ...\`; this one is ${JSON.stringify(argv.join(" "))}`,
    )
  const base = ["pnpm", "exec", "vitest"]
  const files: string[] = []
  const excludes: string[] = []
  let config: string | undefined
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === "--exclude") {
      const value = argv[++i]
      if (value === undefined) throw new Error("The test command ends in --exclude with no value")
      excludes.push(value)
    } else if (arg.startsWith("--exclude=")) excludes.push(arg.slice("--exclude=".length))
    else if (arg === "--config") {
      const value = argv[++i]
      if (value === undefined) throw new Error("The test command ends in --config with no value")
      config = value
      base.push(arg, value)
    } else if (arg.startsWith("--config=")) {
      config = arg.slice("--config=".length)
      base.push(arg)
    } else if (i === 3 && arg === "run") base.push(arg)
    else if (UNREAD.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))
      throw new Error(`The test command passes ${arg}, which changes which files run: not read here`)
    else if (arg.startsWith("-")) base.push(arg)
    else files.push(arg)
  }
  return { base, config, files, excludes }
}

/** `command` with exactly `excludes` (sorted, de-duplicated) in place of its own. */
export function withExcludes(command: VitestCommand, excludes: readonly string[]): string[] {
  return [
    ...command.base,
    ...command.files,
    ...[...new Set(excludes)].sort().flatMap((glob) => ["--exclude", glob]),
  ]
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-vitest-command.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/vitest-command.ts examples/software-factory/controller/test/target-vitest-command.test.ts
git commit -m "feat(software-factory): build and read back a target's vitest command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (review-driven; commits `498a07e11`, `0da9c9134`). `parseVitestCommand` reads only the named flags (`run` first, `--run`, `--no-cache`, `--passWithNoTests`, `--config`, `--exclude`) and positionals; any other flag is refused by name (Task 7's catch turns that into the "not read" note). `withExcludes` accepts only literal paths: it throws on glob characters, a leading `-`, `..`, an absolute path or a character outside the portable set.

### Task 5: The Dockerfile template

**Files:**
- Create: `controller/src/lib/targets/init/dockerfile.ts`
- Test: `controller/test/target-init-dockerfile.test.ts`

- [ ] **Step 1: Write the failing tests**

The promotion step's shell is executed for real, in a temporary directory laid out like the image after `pnpm install`: no Docker, and every branch of the step (the TypeScript shim, a scoped promotion, a workspace link skipped, a mismatch, a double promotion, the relinks) is observed.

`test/target-init-dockerfile.test.ts`:

```ts
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  type DockerfileSpec,
  EXPECTED_MARKER,
  expectedPromotedOf,
  PROMOTED_MARKER,
  promotionMismatch,
  renderDockerfile,
  withExpectedPromoted,
} from "../src/lib/targets/init/dockerfile.ts"
import { capturedListMismatch, dockerfileCapturedPackages } from "../src/lib/targets/prepare.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SPEC: DockerfileSpec = {
  id: "app",
  filter: "@m/app",
  captured: [
    { dir: "app", name: "@m/app" },
    { dir: "config", name: "@m/config" },
    { dir: "core", name: "@m/core" },
    { dir: "util", name: "@m/util" },
  ],
  expectedPromoted: [],
  npmrc: true,
}

/** The promotion RUN's shell as the image's /bin/sh receives it: continuations joined. */
function promotionStep(dockerfile: string): string {
  const lines = dockerfile.split("\n")
  const start = lines.findIndex((line) => line.startsWith("RUN set -eu"))
  const body: string[] = []
  for (let i = start; ; i++) {
    const line = lines[i] as string
    body.push(line.endsWith("\\") ? line.slice(0, -1) : line)
    if (!line.endsWith("\\")) break
  }
  return body.join("").replace(/^RUN /, "")
}

const file = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** `/opt/targets/<id>` after a hoisted install: root packages, and what hoisting nested. */
function installed(nested: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "factory-dockerfile-"))
  dirs.push(root)
  file(root, "node_modules/typescript/package.json", "root-ts")
  file(root, "node_modules/.bin/tsc", "root tsc")
  file(root, "node_modules/commander/package.json", "root-commander")
  mkdirSync(join(root, "node_modules/@m"), { recursive: true })
  symlinkSync("../../packages/app", join(root, "node_modules/@m/app"))
  for (const [path, text] of Object.entries(nested)) file(root, path, text)
  // A workspace link hoisting nested: a symlink, never promoted.
  mkdirSync(join(root, "packages/app/node_modules/@m"), { recursive: true })
  symlinkSync("../../../core", join(root, "packages/app/node_modules/@m/core"))
  file(root, "packages/app/node_modules/.bin/x", "bin")
  return root
}

const run = (dockerfile: string, cwd: string) =>
  spawnSync("sh", ["-c", promotionStep(dockerfile)], { cwd, encoding: "utf8" })

const NESTED = {
  "packages/app/node_modules/commander/package.json": "app-commander",
  "packages/app/node_modules/typescript/package.json": "app-ts",
  "packages/core/node_modules/@scope/pkg/package.json": "core-scoped",
}

describe("the generated Dockerfile", () => {
  it("keeps every trap the hand-written Dockerfiles learned", () => {
    const text = renderDockerfile(SPEC)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the Dockerfile's own build args
    expect(text).toContain("FROM --platform=${PLATFORM} ${BASE_IMAGE}")
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the Dockerfile's own build arg
    expect(text).toContain("npm install -g pnpm@${PNPM_VERSION}")
    expect(text).toContain("COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./")
    expect(text).toContain(
      "RUN pnpm install --frozen-lockfile --filter @m/app... --ignore-scripts --config.node-linker=hoisted \\\n && chmod -R a+rX /opt/targets/app\n",
    )
    expect(text).toContain("RUN ln -s /tmp /opt/targets/app/node_modules/.vite-temp\n")
    expect(text.endsWith("USER node\nWORKDIR /workspace\n")).toBe(true)
    expect(renderDockerfile({ ...SPEC, npmrc: false })).toContain(
      "COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./",
    )
  })

  it("declares its captured packages as target:prepare checks them", () => {
    const text = renderDockerfile(SPEC)
    expect(dockerfileCapturedPackages(text)).toEqual(["app", "config", "core", "util"])
    const capture = {
      include: ["packages/app/src", "packages/config", "packages/core/src", "packages/util/src"],
    }
    expect(capturedListMismatch({ id: "app", capture }, text)).toBeUndefined()
  })

  it("promotes what hoisting nested, shims the root's tsc, and relinks the workspace", () => {
    const root = installed(NESTED)
    const text = renderDockerfile({ ...SPEC, expectedPromoted: ["typescript", "commander", "@scope/pkg"] })
    const result = run(text, root)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`${PROMOTED_MARKER} @scope/pkg commander typescript \n`)
    expect(readFileSync(join(root, "tools/node_modules/typescript/package.json"), "utf8")).toBe("root-ts")
    expect(readFileSync(join(root, "node_modules/typescript/package.json"), "utf8")).toBe("app-ts")
    expect(readFileSync(join(root, "node_modules/commander/package.json"), "utf8")).toBe("app-commander")
    expect(readFileSync(join(root, "node_modules/@scope/pkg/package.json"), "utf8")).toBe("core-scoped")
    expect(readFileSync(join(root, "node_modules/.bin/tsc"), "utf8")).toBe(
      '#!/bin/sh\nexec node /opt/targets/app/tools/node_modules/typescript/bin/tsc "$@"\n',
    )
    expect(existsSync(join(root, "packages/app/node_modules"))).toBe(false)
    for (const { dir, name } of SPEC.captured)
      expect(readlinkSync(join(root, "node_modules", name))).toBe(`/workspace/packages/${dir}`)
  })

  it("leaves the root's typescript alone when nothing nests one", () => {
    const root = installed({ "packages/core/node_modules/hono/package.json": "core-hono" })
    const result = run(renderDockerfile({ ...SPEC, expectedPromoted: ["hono"] }), root)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(root, "tools"))).toBe(false)
    expect(readFileSync(join(root, "node_modules/.bin/tsc"), "utf8")).toBe("root tsc")
  })

  it("fails the build, printing both sets, when the promotion differs from the reviewed set", () => {
    const result = run(renderDockerfile(SPEC), installed(NESTED))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`${PROMOTED_MARKER} @scope/pkg commander typescript `)
    expect(result.stderr).toContain(`${EXPECTED_MARKER}  `)
  })

  it("fails the build when two captured packages nest one name", () => {
    const root = installed({
      "packages/app/node_modules/hono/package.json": "app-hono",
      "packages/core/node_modules/hono/package.json": "core-hono",
    })
    const result = run(renderDockerfile({ ...SPEC, expectedPromoted: ["hono"] }), root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("promoted twice: hono (again from packages/core)")
  })

  it("refuses to write a value the shell would read as syntax", () => {
    for (const bad of ["a b", "$(id)", "x;y", 'q"'])
      expect(() => renderDockerfile({ ...SPEC, expectedPromoted: [bad] }), bad).toThrow(
        /will not write/,
      )
  })
})

describe("the promotion set", () => {
  it("is read from and written into a Dockerfile", () => {
    const text = renderDockerfile({ ...SPEC, expectedPromoted: ["typescript", "commander"] })
    expect(expectedPromotedOf(text)).toEqual(["commander", "typescript"])
    expect(expectedPromotedOf(withExpectedPromoted(text, ["hono"]))).toEqual(["hono"])
    expect(expectedPromotedOf("FROM x\n")).toBeUndefined()
    expect(() => withExpectedPromoted("FROM x\n", ["hono"])).toThrow(/declares no EXPECTED_PROMOTED/)
  })

  it("is learned from a failed build's log, never from BuildKit's echo of the RUN line", () => {
    const echoed = `#9 [6/7] RUN set -eu  && CAPTURED="app core"  && EXPECTED_PROMOTED=""  && echo "${PROMOTED_MARKER} $actual"  && if [ "$actual" != "$expected" ]; then echo "${EXPECTED_MARKER} $expected" >&2; exit 1; fi`
    const failed = [
      echoed,
      `#9 0.412 ${PROMOTED_MARKER} @hono/node-server commander hono typescript `,
      `#9 0.413 ${EXPECTED_MARKER}  `,
      `#9 ERROR: process "/bin/sh -c set -eu ... echo \\"${EXPECTED_MARKER} $expected\\"" did not complete successfully: exit code: 1`,
      "",
    ].join("\n")
    expect(promotionMismatch(failed)).toEqual(["@hono/node-server", "commander", "hono", "typescript"])
    // The echo alone (a build that failed elsewhere, before the step printed anything).
    expect(promotionMismatch(`${echoed}\n#9 ERROR: exit code: 100\n`)).toBeUndefined()
    // A build that passed the check.
    expect(promotionMismatch(`${echoed}\n#9 0.4 ${PROMOTED_MARKER}  \n#10 DONE\n`)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init-dockerfile.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/targets/init/dockerfile.ts`:

```ts
/**
 * What the generated Dockerfile needs from the target: its id (the image's `/opt/targets/<id>`),
 * the package pnpm installs for, the workspace packages the capture holds (directory under
 * `packages/` and package name, for the relinks), the reviewed promotion set, and whether the
 * pin has a `.npmrc`.
 */
export interface DockerfileSpec {
  readonly id: string
  readonly filter: string
  readonly captured: readonly { readonly dir: string; readonly name: string }[]
  readonly expectedPromoted: readonly string[]
  readonly npmrc: boolean
}

/** Printed by the promotion step with the set it promoted, whether or not it then fails. */
export const PROMOTED_MARKER = "b4-factory promoted:"
/** Printed on stderr, with the reviewed set, when the promoted set differs from it. */
export const EXPECTED_MARKER = "b4-factory expected promoted:"

/**
 * Each marker as the step PRINTS it: followed by names to the end of the line. BuildKit echoes
 * the RUN line into the log, where both markers are followed by `$actual"` and `$expected"`,
 * so a match may hold no `$` and no quote.
 */
const PROMOTED_LINE = /b4-factory promoted:([^\n$"]*)$/gm
const EXPECTED_LINE = /b4-factory expected promoted:[^\n$"]*$/m

/** Package names, directories and ids: what may appear unquoted in the step's shell. */
const SAFE = /^[@A-Za-z0-9._/-]+$/

export function renderDockerfile(spec: DockerfileSpec): string {
  for (const value of [
    spec.id,
    spec.filter,
    ...spec.captured.flatMap((p) => [p.dir, p.name]),
    ...spec.expectedPromoted,
  ])
    if (!SAFE.test(value))
      throw new Error(`target:init will not write ${JSON.stringify(value)} into a Dockerfile's shell`)
  const opt = `/opt/targets/${spec.id}`
  const roots = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]
  if (spec.npmrc) roots.push(".npmrc")
  const captured = spec.captured.map((p) => p.dir).join(" ")
  const links = spec.captured.map((p) => `${p.name}=${p.dir}`).join(" ")
  const expected = [...spec.expectedPromoted].sort().join(" ")
  return `# Generated by target:init for ${spec.filter}: a target file, reviewed and committed by a person.
ARG BASE_IMAGE=node:24-slim
ARG PLATFORM=linux/arm64
FROM --platform=\${PLATFORM} \${BASE_IMAGE}
ARG PNPM_VERSION
# git for the workspace baseline; pnpm via npm, not corepack, because corepack caches the
# binary in the enabling user's home and the container runs as node with no network.
# git is resolved by apt at build time and is not part of the recorded image inputs; an
# accepted gap, recorded in the rung 2 spec's risks.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \\
 && npm install -g pnpm@\${PNPM_VERSION}
WORKDIR ${opt}
COPY ${roots.join(" ")} ./
# The context is the target's imageContext: the manifest of every package the install below
# reaches, and config packages whole.
COPY packages packages
# Hoisted, so one root node_modules holds everything and the workspace needs one link. The
# chmod stays in this layer: in a layer of its own it copies the install up and doubles the image.
RUN pnpm install --frozen-lockfile --filter ${spec.filter}... --ignore-scripts --config.node-linker=hoisted \\
 && chmod -R a+rX ${opt}
# The workspace holds exactly ONE environment link (node_modules, at its root): the inspection
# that snapshots it refuses a symlink anywhere else. So everything a captured package resolves
# must be in the ROOT node_modules:
#  1. When a captured package nests its own typescript, the root's (the tsc every package
#     builds with) moves aside first and tsc becomes a shim onto it.
#  2. A dependency hoisting left under packages/<p>/node_modules (its version conflicts with
#     the root's) is promoted over the root's. EXPECTED_PROMOTED is that set, reviewed: any
#     other set, or one name promoted twice, fails the build rather than silently replacing a
#     root package the other packages resolve. target:measure proposes it from a failed build.
#  3. Workspace links are pointed from the image's manifest-only copies at the workspace's own
#     packages. CAPTURED is the packages the capture holds; target:prepare checks it.
RUN set -eu \\
 && CAPTURED="${captured}" \\
 && EXPECTED_PROMOTED="${expected}" \\
 && NESTED_TS="" \\
 && for p in $CAPTURED; do if [ -d "packages/$p/node_modules/typescript" ]; then NESTED_TS=1; fi; done \\
 && if [ -n "$NESTED_TS" ] && [ -d node_modules/typescript ]; then \\
      mkdir -p tools/node_modules && mv node_modules/typescript tools/node_modules/typescript \\
      && rm -f node_modules/.bin/tsc \\
      && printf '#!/bin/sh\\nexec node ${opt}/tools/node_modules/typescript/bin/tsc "$@"\\n' > node_modules/.bin/tsc \\
      && chmod 755 node_modules/.bin/tsc; \\
    fi \\
 && PROMOTED="" \\
 && for p in $CAPTURED; do \\
      nm="packages/$p/node_modules"; [ -d "$nm" ] || continue; \\
      for entry in "$nm"/* "$nm"/@*/*; do \\
        [ -e "$entry" ] || continue; \\
        if [ -L "$entry" ]; then continue; fi; \\
        rel="\${entry#"$nm"/}"; \\
        case "$rel" in @*/*) ;; @*) continue ;; esac; \\
        case " $PROMOTED " in *" $rel "*) echo "promoted twice: $rel (again from packages/$p)" >&2; exit 1 ;; esac; \\
        PROMOTED="$PROMOTED $rel"; \\
        rm -rf "node_modules/$rel" && mkdir -p "node_modules/$(dirname "$rel")" && mv "$entry" "node_modules/$rel"; \\
      done; \\
      rm -rf "$nm"; \\
    done \\
 && actual="$(printf '%s\\n' $PROMOTED | LC_ALL=C sort | tr '\\n' ' ')" \\
 && expected="$(printf '%s\\n' $EXPECTED_PROMOTED | LC_ALL=C sort | tr '\\n' ' ')" \\
 && echo "${PROMOTED_MARKER} $actual" \\
 && if [ "$actual" != "$expected" ]; then echo "${EXPECTED_MARKER} $expected" >&2; exit 1; fi \\
 && for link in ${links}; do \\
      name="\${link%%=*}"; dir="\${link#*=}"; \\
      rm -rf "node_modules/$name" && mkdir -p "node_modules/$(dirname "$name")" \\
      && ln -s "/workspace/packages/$dir" "node_modules/$name"; \\
    done
# vite bundles a TypeScript config to a temp file under the NEAREST node_modules, which here is
# the image's read-only one, and it only tolerates EACCES there. Point that one scratch
# directory at /tmp, which the sandbox mounts as a writable tmpfs.
RUN ln -s /tmp ${opt}/node_modules/.vite-temp
USER node
WORKDIR /workspace
`
}

/** The reviewed promotion set a Dockerfile declares, sorted; undefined when it declares none. */
export function expectedPromotedOf(dockerfile: string): string[] | undefined {
  const match = /\bEXPECTED_PROMOTED="([^"]*)"/.exec(dockerfile)
  if (!match) return undefined
  return (match[1] as string)
    .split(/\s+/)
    .filter((name) => name.length > 0)
    .sort()
}

/** `dockerfile` declaring `names` as its promotion set. */
export function withExpectedPromoted(dockerfile: string, names: readonly string[]): string {
  if (expectedPromotedOf(dockerfile) === undefined)
    throw new Error("The Dockerfile declares no EXPECTED_PROMOTED to replace")
  for (const name of names)
    if (!SAFE.test(name))
      throw new Error(`target:init will not write ${JSON.stringify(name)} into a Dockerfile's shell`)
  return dockerfile.replace(
    /\bEXPECTED_PROMOTED="[^"]*"/,
    `EXPECTED_PROMOTED="${[...names].sort().join(" ")}"`,
  )
}

/**
 * The set a build promoted, when the build failed at the promotion check; undefined when it
 * did not reach the check or passed it. Read from the last printed marker line.
 */
export function promotionMismatch(log: string): string[] | undefined {
  if (!EXPECTED_LINE.test(log)) return undefined
  const printed = [...log.matchAll(PROMOTED_LINE)].at(-1)
  if (printed === undefined) return undefined
  return (printed[1] as string)
    .split(/\s+/)
    .filter((name) => name.length > 0)
    .sort()
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init-dockerfile.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0. If the shell test fails on macOS only, the host `/bin/sh` is bash in POSIX mode; the image's is dash. Run the same step once in the base image to be sure both agree (no Docker deletion involved): `docker run --rm -v "$PWD/<fixture>":/opt/targets/app -w /opt/targets/app node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 sh -c '<step>'`.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/init/dockerfile.ts examples/software-factory/controller/test/target-init-dockerfile.test.ts
git commit -m "feat(software-factory): one Dockerfile template for pnpm targets, with a learnable promotion set

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (review-driven; commits `05e2e6a72`, `4fffb54fc`). The plan's `SAFE` became two checks: `SEGMENT` (id, directory) and `NAME` (filter, captured names, promotion set; each segment starts with a letter or digit). The promotion and relink loops sit inside the RUN's top-level `&&` list, where the shell ignores `set -e`, so each chain in them ends `|| exit 1` (the shell tests run under dash where the host has it). A promoted name that is also a captured, relinked name fails the build by name; a repeated promotion name is refused by `renderDockerfile` and `withExpectedPromoted`; `CAPTURED` and the links are sorted by directory. `promotionMismatch` reads the promoted marker only from the BuildKit `#N` step that printed the expected one.

### Task 6: `deriveTarget`: every field from the graph

**Files:**
- Create: `controller/src/lib/targets/init/derive.ts`
- Test: `controller/test/target-init-derive.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/target-init-derive.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest"
import {
  type CarriedFields,
  DEFAULT_BASE_IMAGE,
  type DeriveOptions,
  deriveTarget,
  isPlaceholderResources,
  PLACEHOLDER_RESOURCES,
} from "../src/lib/targets/init/derive.ts"
import { gitPinTree } from "../src/lib/targets/init/pin-tree.ts"
import { readWorkspace, resolvePackage } from "../src/lib/targets/init/workspace-graph.ts"
import { cleanupPinRepos, json, MINI, pinRepo } from "./pin-repo.ts"

afterEach(cleanupPinRepos)

const derive = (
  files: Readonly<Record<string, string>>,
  ref = "@m/app",
  carried: CarriedFields = {},
  links: Readonly<Record<string, string>> = {},
  extra: Partial<DeriveOptions> = {},
) => {
  const { root, pin } = pinRepo(files, links)
  const tree = gitPinTree(root, pin)
  const graph = readWorkspace(tree)
  const pkg = resolvePackage(graph, ref)
  return {
    pin,
    ...deriveTarget(tree, graph, pkg, { id: pkg.dir.split("/").at(-1) as string, carried, ...extra }),
  }
}

describe("deriveTarget", () => {
  it("derives the whole target of a package from its manifests at the pin", () => {
    const { pin, manifest, dockerfile, notes } = derive(MINI)
    expect(manifest).toEqual({
      id: "app",
      pin,
      root: ".",
      capture: {
        include: [
          "package.json",
          "pnpm-workspace.yaml",
          ".npmrc",
          "packages/app/package.json",
          "packages/app/src",
          "packages/app/test",
          "packages/app/tsconfig.build.json",
          "packages/app/tsconfig.json",
          "packages/app/vitest.config.ts",
          "packages/config",
          "packages/core/package.json",
          "packages/core/src",
          "packages/core/tsconfig.json",
          "packages/util/package.json",
          "packages/util/src",
          "packages/util/tsconfig.json",
        ],
      },
      snapshotIgnore: ["packages/app/dist/", "packages/core/lib/", "packages/util/dist/"],
      baseImage: DEFAULT_BASE_IMAGE,
      imageContext: [
        "package.json",
        "pnpm-workspace.yaml",
        "pnpm-lock.yaml",
        ".npmrc",
        "packages/app/package.json",
        "packages/config",
        "packages/core/package.json",
        "packages/tooling/package.json",
        "packages/util/package.json",
      ],
      lockfile: "pnpm-lock.yaml",
      imageAssertResolves: ["vitest", "typescript", "@types/node/package.json"],
      environmentLinks: [{ path: "node_modules", target: "/opt/targets/app/node_modules" }],
      commands: {
        cwd: "packages/app",
        build: ["pnpm", "exec", "tsc", "-b", "--builders", "1", "../util", "../core", "tsconfig.build.json"],
        test: ["pnpm", "exec", "vitest", "--run", "--no-cache", "--config", "vitest.config.ts"],
        nodeTestExecArgv: [],
      },
      runnerConfig: [
        "package.json",
        "pnpm-workspace.yaml",
        ".npmrc",
        "packages/app/package.json",
        "packages/app/tsconfig.build.json",
        "packages/app/tsconfig.json",
        "packages/app/vitest.config.ts",
        "packages/config",
      ],
      resources: PLACEHOLDER_RESOURCES,
    })
    expect(dockerfile).toEqual({
      id: "app",
      filter: "@m/app",
      captured: [
        { dir: "app", name: "@m/app" },
        { dir: "config", name: "@m/config" },
        { dir: "core", name: "@m/core" },
        { dir: "util", name: "@m/util" },
      ],
      expectedPromoted: [],
      npmrc: true,
    })
    expect(notes).toEqual([
      "@m/tooling (packages/tooling) is installed, not captured: a test importing it resolves the image's manifest-only copy and fails, and target:measure proposes excluding that test (or pass --with-dev-builds)",
      "@m/app's build script does more than compile (tsc -b tsconfig.build.json && node scripts/docs.mjs): the target runs only its `tsc -b tsconfig.build.json`",
      expect.stringMatching(/^capture: 18 files, \d+ bytes$/),
      "packages/app: not captured: scripts/ (1 file)",
      "packages/util: not captured: test/ (1 file)",
      "resources are placeholders until target:measure proposes them",
      "no test is excluded: target:measure runs each file alone and proposes the excludes (none, if every file passes)",
    ])
  })

  it("derives a single-project target without a build order flag or a vitest config", () => {
    const { manifest } = derive(MINI, "@m/util")
    expect(manifest.commands.build).toEqual(["pnpm", "exec", "tsc", "-b", "tsconfig.json"])
    expect(manifest.commands.test).toEqual(["pnpm", "exec", "vitest", "--run", "--no-cache"])
    expect(manifest.capture.include).toEqual([
      "package.json",
      "pnpm-workspace.yaml",
      ".npmrc",
      "packages/config",
      "packages/util/package.json",
      "packages/util/src",
      "packages/util/test",
      "packages/util/tsconfig.json",
      "packages/util/tsconfig.test.json",
    ])
    expect(manifest.runnerConfig).toEqual([
      "package.json",
      "pnpm-workspace.yaml",
      ".npmrc",
      "packages/config",
      "packages/util/package.json",
      "packages/util/tsconfig.json",
      "packages/util/tsconfig.test.json",
    ])
  })

  it("omits --builders before TypeScript 7", () => {
    const root = JSON.parse(MINI["package.json"] as string)
    const { manifest } = derive({
      ...MINI,
      "package.json": json({ ...root, devDependencies: { ...root.devDependencies, typescript: "5.9.3" } }),
    })
    expect(manifest.commands.build).toEqual(["pnpm", "exec", "tsc", "-b", "../util", "../core", "tsconfig.build.json"])
  })

  it("builds and captures devDependencies with builds only when asked, the target still compiled last", () => {
    const { manifest, dockerfile, notes } = derive(MINI, "@m/app", {}, {}, { withDevBuilds: true })
    expect(manifest.commands.build).toEqual([
      "pnpm", "exec", "tsc", "-b", "--builders", "1", "../util", "../core", "../tooling", "tsconfig.build.json",
    ])
    expect(manifest.capture.include).toEqual(
      expect.arrayContaining(["packages/tooling/package.json", "packages/tooling/src", "packages/tooling/tsconfig.json"]),
    )
    expect(dockerfile.captured.map((p) => p.dir)).toEqual(["app", "config", "core", "tooling", "util"])
    expect(notes.some((note) => note.includes("is installed, not captured"))).toBe(false)
  })

  it("carries what a person or a measurement decided, as supersets, dropping what the pin no longer has", () => {
    const resources = { memoryMb: 768, cpus: 2, commandTimeoutMs: 60_000, verifierDeadlineMs: 240_000 }
    const baseImage = `node@sha256:${"e".repeat(64)}`
    const { manifest, dockerfile, notes } = derive(MINI, "@m/app", {
      baseImage,
      resources,
      draftingNotes: ["A route is a directory."],
      scope: ["test/app.test.ts"],
      excludes: ["test/helpers/h.ts", "test/gone.test.ts"],
      expectedPromoted: ["zod"],
      imageAssertResolves: ["commander", "vitest"],
      captureInclude: [
        "package.json",
        "packages/app/test/app.test.ts",
        "packages/app/scripts",
        "packages/tooling/src",
        "gone.txt",
      ],
      runnerConfig: ["packages/app/scripts/docs.mjs", "packages/app/gone.json"],
    })
    expect(manifest.baseImage).toBe(baseImage)
    expect(manifest.resources).toEqual(resources)
    expect(manifest.draftingNotes).toEqual(["A route is a directory."])
    expect(manifest.commands.test).toEqual([
      "pnpm", "exec", "vitest", "--run", "--no-cache", "--config", "vitest.config.ts",
      "test/app.test.ts", "--exclude", "test/helpers/h.ts",
    ])
    expect(manifest.imageAssertResolves).toEqual(["vitest", "typescript", "@types/node/package.json", "commander"])
    // A carried scope keeps the carried test capture instead of the whole directory.
    expect(manifest.capture.include).toContain("packages/app/test/app.test.ts")
    expect(manifest.capture.include).toContain("packages/app/scripts")
    expect(manifest.capture.include).not.toContain("packages/app/test")
    expect(manifest.capture.include).not.toContain("packages/tooling/src")
    expect(manifest.runnerConfig).toContain("packages/app/scripts/docs.mjs")
    expect(dockerfile.expectedPromoted).toEqual(["zod"])
    expect(notes).toEqual(
      expect.arrayContaining([
        "dropped test/gone.test.ts from the test command: no such file under packages/app at the pin",
        "dropped packages/tooling/src from capture.include: it belongs to no package this target captures",
        "dropped gone.txt from capture.include: not at the pin",
        "dropped packages/app/gone.json from runnerConfig: not at the pin",
      ]),
    )
    expect(notes.some((note) => note.startsWith("resources are placeholders"))).toBe(false)
    expect(isPlaceholderResources(PLACEHOLDER_RESOURCES)).toBe(true)
    expect(isPlaceholderResources(resources)).toBe(false)
  })

  it("names a sibling package the vitest config reads that the capture omits", () => {
    const { notes } = derive({
      ...MINI,
      "packages/app/vitest.config.ts": 'export default { resolve: { alias: { x: "../tooling/src/index.ts", y: "../core/src" } } }\n',
    })
    expect(notes).toContain(
      "packages/app/vitest.config.ts reads ../tooling/ (packages/tooling), which the capture omits: a test that reaches it fails, and target:measure proposes excluding it",
    )
    expect(notes.some((note) => note.includes("reads ../core/"))).toBe(false)
  })

  it("refuses what it cannot generate, naming it", () => {
    const root = JSON.parse(MINI["package.json"] as string)
    expect(() => derive({ ...MINI, "package.json": json({ ...root, packageManager: "npm@10.0.0" }) })).toThrow(
      /generates pnpm targets only/,
    )
    const app = JSON.parse(MINI["packages/app/package.json"] as string)
    expect(() =>
      derive({
        ...MINI,
        "packages/app/package.json": json({
          ...app,
          dependencies: { ...app.dependencies, "@m/lint": "workspace:*" },
        }),
      }),
    ).toThrow(/@m\/lint lives at tools\/lint: target:init captures packages under packages\/ only/)
    expect(() => derive({ ...MINI, "packages/app/test/[id].test.ts": "\n" })).toThrow(
      /packages\/app\/test\/\[id\]\.test\.ts/,
    )
    expect(() => derive(MINI, "@m/app", {}, { "packages/app/src/link.ts": "index.ts" })).toThrow(
      /packages\/app\/src\/link\.ts/,
    )
    expect(() =>
      derive({
        ...MINI,
        "packages/core/tsconfig.json": json({
          extends: "../tooling/tsconfig.json",
          compilerOptions: { outDir: "lib" },
        }),
      }),
    ).toThrow(/extends packages\/tooling\/tsconfig.json, which no captured config package holds/)
    expect(() =>
      derive({
        ...MINI,
        "packages/app/package.json": json({
          ...app,
          scripts: { ...app.scripts, test: "vitest --run --config vitest.other.ts" },
        }),
      }),
    ).toThrow(/names --config vitest.other.ts, which does not exist/)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init-derive.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/targets/init/derive.ts`:

```ts
import { posix } from "node:path"
import type { TargetManifest } from "../catalog.js"
import { parseVitestCommand, vitestTestArgv, withExcludes } from "../vitest-command.js"
import type { DockerfileSpec } from "./dockerfile.js"
import type { PinTree } from "./pin-tree.js"
import { type BuildConfig, buildConfig, buildScriptTsconfig, packageTsconfigs } from "./tsconfig.js"
import {
  closure,
  INSTALL,
  isConfigPackage,
  PROD,
  topologicalOrder,
  type WorkspaceGraph,
  type WorkspacePackage,
  workspaceDependencies,
} from "./workspace-graph.js"

/** The base every shipped target pins (`targets-catalog.test.ts`): the drafter's, by digest. */
export const DEFAULT_BASE_IMAGE =
  "node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6"

/** Generous until `target:measure` replaces them: a person reviews the numbers it proposes. */
export const PLACEHOLDER_RESOURCES: TargetManifest["resources"] = {
  memoryMb: 2048,
  cpus: 2,
  commandTimeoutMs: 600_000,
  verifierDeadlineMs: 3_600_000,
}

/** Are `resources` `init`'s placeholders, never measured? (Detected by value, not by origin.) */
export function isPlaceholderResources(resources: TargetManifest["resources"]): boolean {
  return (Object.keys(PLACEHOLDER_RESOURCES) as (keyof TargetManifest["resources"])[]).every(
    (key) => resources[key] === PLACEHOLDER_RESOURCES[key],
  )
}

/** What a re-generation keeps from the target already on disk (plan D8). */
export interface CarriedFields {
  readonly baseImage?: string
  readonly resources?: TargetManifest["resources"]
  readonly draftingNotes?: readonly string[]
  /** The test command's positional files: a scope a person chose. */
  readonly scope?: readonly string[]
  /** The test command's `--exclude` entries: what a measurement proposed. */
  readonly excludes?: readonly string[]
  readonly expectedPromoted?: readonly string[]
  /** Kept as supersets: a person's additions survive a re-generation (plan D8). */
  readonly imageAssertResolves?: readonly string[]
  readonly captureInclude?: readonly string[]
  readonly runnerConfig?: readonly string[]
}

export interface DeriveOptions {
  readonly id: string
  readonly carried: CarriedFields
  /** Build and capture the target's workspace devDependencies that have builds (plan D16). */
  readonly withDevBuilds?: boolean
}

export interface DerivedTarget {
  readonly manifest: TargetManifest
  readonly dockerfile: DockerfileSpec
  /** Facts the person reviewing the proposal should read, one line each. */
  readonly notes: readonly string[]
}

const VITEST_CONFIGS = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
]

/**
 * `@b4run/workspace`'s portable source path (`packages/workspace/src/source-validation.ts`,
 * not exported): the capture refuses any other, so `init` refuses it first, by name.
 */
function portable(path: string): boolean {
  return (
    /^[A-Za-z0-9._ /-]+$/.test(path) &&
    path
      .split("/")
      .every(
        (s) =>
          s.length > 0 &&
          s.length <= 255 &&
          s !== "." &&
          s !== ".." &&
          !s.startsWith(" ") &&
          !/[ .]$/.test(s) &&
          !s.includes("  ") &&
          !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s),
      )
  )
}

const sortPaths = (paths: Iterable<string>): string[] =>
  [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
/** `paths` without any entry another entry already covers (a file inside a captured directory). */
const withoutCovered = (paths: readonly string[]): string[] =>
  paths.filter((path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`)))
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

export function deriveTarget(
  tree: PinTree,
  graph: WorkspaceGraph,
  pkg: WorkspacePackage,
  options: DeriveOptions,
): DerivedTarget {
  const { id, carried } = options
  const notes: string[] = []
  const manager = graph.root.packageManager ?? ""
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(manager))
    throw new Error(
      `The root package.json at ${tree.pin} names packageManager ${JSON.stringify(manager)}: target:init generates pnpm targets only, and the image installs the pnpm@<x.y.z> it names`,
    )
  for (const file of ["pnpm-workspace.yaml", "pnpm-lock.yaml"])
    if (tree.kind(file) !== "file") throw new Error(`${file} does not exist at ${tree.pin}`)
  const npmrc = tree.kind(".npmrc") === "file"
  const rootManifests = ["package.json", "pnpm-workspace.yaml", ...(npmrc ? [".npmrc"] : [])]
  const atPin = (path: string) => tree.kind(path) !== undefined

  // The closures (plan D4, D16).
  const installed = closure(graph, pkg, INSTALL)
  const configs = installed.filter((p) => p !== pkg && isConfigPackage(p))
  const roots = [
    pkg,
    ...(options.withDevBuilds
      ? workspaceDependencies(graph, pkg, ["devDependencies"]).filter((p) => !isConfigPackage(p))
      : []),
  ]
  const builtByName = new Map<string, WorkspacePackage>()
  for (const root of roots)
    for (const p of closure(graph, root, PROD)) if (!isConfigPackage(p)) builtByName.set(p.name, p)
  // Runtime edges order the build (a devDependency edge never orders a compile); the target
  // itself compiles last, from its own directory.
  const ordered = topologicalOrder(graph, [...builtByName.values()], PROD)
  const built = [...ordered.filter((p) => p !== pkg), ...ordered.filter((p) => p === pkg)]
  const captured = [...new Set([pkg, ...configs, ...built])].sort((a, b) =>
    a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0,
  )
  for (const p of captured)
    if (!/^packages\/[^/]+$/.test(p.dir))
      throw new Error(
        `${p.name} lives at ${p.dir}: target:init captures packages under packages/ only (the Dockerfile's CAPTURED list and target:prepare's check name them by that directory)`,
      )
  for (const p of installed)
    if (!captured.includes(p))
      notes.push(
        `${p.name} (${p.dir}) is installed, not captured: a test importing it resolves the image's manifest-only copy and fails, and target:measure proposes excluding that test (or pass --with-dev-builds)`,
      )

  // The build (plan D5).
  const builds = new Map<WorkspacePackage, BuildConfig>(built.map((p) => [p, buildConfig(tree, p)]))
  for (const [p, config] of builds) {
    for (const file of config.externalExtends)
      if (!configs.some((c) => file.startsWith(`${c.dir}/`)))
        throw new Error(
          `${config.files.at(-1)} extends ${file}, which no captured config package holds`,
        )
    const script = (p.manifest.scripts?.build ?? "").trim()
    if (script !== `tsc -b ${buildScriptTsconfig(p)}` && script !== `tsc --build ${buildScriptTsconfig(p)}`)
      notes.push(
        `${p.name}'s build script does more than compile (${script}): the target runs only its \`tsc -b ${config.tsconfig}\``,
      )
  }
  const typescript =
    graph.root.devDependencies?.typescript ?? pkg.manifest.devDependencies?.typescript ?? ""
  const typescriptMajor = Number(/(\d+)\./.exec(typescript)?.[1] ?? 0)
  const projects = built.map((p) => {
    const config = builds.get(p) as BuildConfig
    if (p === pkg) return config.tsconfig
    const relative = posix.relative(pkg.dir, p.dir)
    return config.tsconfig === "tsconfig.json" ? relative : `${relative}/${config.tsconfig}`
  })
  const build =
    projects.length === 0
      ? []
      : [
          "pnpm",
          "exec",
          "tsc",
          "-b",
          ...(projects.length > 1 && typescriptMajor >= 7 ? ["--builders", "1"] : []),
          ...projects,
        ]

  // The test command and the runner configuration it reads.
  const command = parseVitestCommand(vitestTestArgv(pkg))
  let runner: string | undefined
  if (command.config !== undefined) {
    runner = `${pkg.dir}/${command.config}`
    if (tree.kind(runner) !== "file")
      throw new Error(
        `${pkg.name}: its test script names --config ${command.config}, which does not exist at ${tree.pin}`,
      )
  } else {
    const found = VITEST_CONFIGS.find((name) => tree.kind(`${pkg.dir}/${name}`) === "file")
    runner = found === undefined ? undefined : `${pkg.dir}/${found}`
  }
  const present = (file: string) => tree.kind(`${pkg.dir}/${file}`) === "file"
  for (const file of [...(carried.scope ?? []), ...(carried.excludes ?? [])])
    if (!present(file))
      notes.push(`dropped ${file} from the test command: no such file under ${pkg.dir} at the pin`)
  const scope = (carried.scope ?? []).filter(present)
  const test = withExcludes({ ...command, files: scope }, (carried.excludes ?? []).filter(present))

  // The capture. A carried scope keeps the carried capture of the test directory rather than
  // widening it to the whole directory the command does not run (plan D8).
  const scoped = scope.length > 0 && carried.captureInclude !== undefined
  const dir = (path: string) => (tree.kind(path) === "dir" ? [path] : [])
  const own = [
    `${pkg.dir}/package.json`,
    ...packageTsconfigs(tree, pkg),
    ...(builds.get(pkg)?.files ?? []),
    ...(runner === undefined ? [] : [runner]),
    ...dir(`${pkg.dir}/src`),
    ...(scoped ? [] : dir(`${pkg.dir}/test`)),
  ]
  const dependencies = built
    .filter((p) => p !== pkg)
    .flatMap((p) => [
      `${p.dir}/package.json`,
      ...(builds.get(p) as BuildConfig).files,
      ...dir(`${p.dir}/src`),
    ])
  const carriedCapture = (carried.captureInclude ?? []).filter((path) => {
    if (rootManifests.includes(path)) return false
    const owner = captured.find((p) => path === p.dir || path.startsWith(`${p.dir}/`))
    if (!atPin(path)) notes.push(`dropped ${path} from capture.include: not at the pin`)
    else if (owner === undefined && path.includes("/"))
      notes.push(
        `dropped ${path} from capture.include: it belongs to no package this target captures`,
      )
    else return true
    return false
  })
  const include = [
    ...rootManifests,
    ...withoutCovered(
      sortPaths([...own, ...dependencies, ...configs.map((c) => c.dir), ...carriedCapture]),
    ).filter((path) => !rootManifests.includes(path)),
  ]
  const files = include.flatMap((path) => tree.files(path))
  const refused = files.filter(
    (f) => !portable(f.path) || f.mode === "120000" || f.mode === "160000",
  )
  if (refused.length > 0)
    throw new Error(
      `target:init cannot capture ${refused.length} path(s) the workspace capture refuses (portable ASCII names only; no symlinks or submodules): ${refused
        .slice(0, 10)
        .map((f) => f.path)
        .join(", ")}${refused.length > 10 ? ", ..." : ""}`,
    )
  notes.push(`capture: ${files.length} files, ${files.reduce((sum, f) => sum + f.bytes, 0)} bytes`)

  // What the capture leaves out, so an omission is visible before a test trips on it (I5).
  const touches = (path: string) =>
    include.some((e) => e === path || e.startsWith(`${path}/`) || path.startsWith(`${e}/`))
  for (const p of captured.filter((c) => !configs.includes(c))) {
    const omitted = tree
      .children(p.dir)
      .filter((entry) => entry.kind === "dir" && !touches(`${p.dir}/${entry.name}`))
      .map((entry) => `${entry.name}/ (${plural(tree.files(`${p.dir}/${entry.name}`).length, "file")})`)
    if (omitted.length > 0) notes.push(`${p.dir}: not captured: ${omitted.join(", ")}`)
  }
  if (runner !== undefined) {
    const text = tree.read(runner) ?? ""
    const siblings = new Set([...text.matchAll(/["'`]\.\.\/([A-Za-z0-9._-]+)\//g)].map((m) => m[1] as string))
    for (const sibling of [...siblings].sort()) {
      const path = `packages/${sibling}`
      if (atPin(path) && !captured.some((p) => p.dir === path))
        notes.push(
          `${runner} reads ../${sibling}/ (${path}), which the capture omits: a test that reaches it fails, and target:measure proposes excluding it`,
        )
    }
  }

  const typesNode = [
    graph.root.devDependencies,
    graph.root.dependencies,
    pkg.manifest.devDependencies,
    pkg.manifest.dependencies,
  ].some((deps) => deps?.["@types/node"] !== undefined)
  const derivedAsserts = [
    "vitest",
    ...(build.length > 0 ? ["typescript"] : []),
    ...(typesNode ? ["@types/node/package.json"] : []),
  ]
  const resources = { ...(carried.resources ?? PLACEHOLDER_RESOURCES) }
  if (isPlaceholderResources(resources))
    notes.push("resources are placeholders until target:measure proposes them")
  if (parseVitestCommand(test).excludes.length === 0)
    notes.push(
      "no test is excluded: target:measure runs each file alone and proposes the excludes (none, if every file passes)",
    )
  const carriedRunner = (carried.runnerConfig ?? []).filter((path) => {
    if (atPin(path)) return true
    notes.push(`dropped ${path} from runnerConfig: not at the pin`)
    return false
  })

  const manifest: TargetManifest = {
    id,
    pin: tree.pin,
    root: ".",
    capture: { include },
    snapshotIgnore: sortPaths([...builds.values()].map((config) => config.outDir)),
    baseImage: carried.baseImage ?? DEFAULT_BASE_IMAGE,
    imageContext: [
      "package.json",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      ...(npmrc ? [".npmrc"] : []),
      ...sortPaths([
        ...configs.map((c) => c.dir),
        ...installed.filter((p) => !configs.includes(p)).map((p) => `${p.dir}/package.json`),
      ]),
    ],
    lockfile: "pnpm-lock.yaml",
    imageAssertResolves: [...new Set([...derivedAsserts, ...(carried.imageAssertResolves ?? [])])],
    environmentLinks: [{ path: "node_modules", target: `/opt/targets/${id}/node_modules` }],
    commands: { cwd: pkg.dir, build, test, nodeTestExecArgv: [] },
    runnerConfig: [
      ...rootManifests,
      ...sortPaths([
        `${pkg.dir}/package.json`,
        ...packageTsconfigs(tree, pkg),
        ...(runner === undefined ? [] : [runner]),
        ...configs.map((c) => c.dir),
        ...carriedRunner,
      ]).filter((path) => !rootManifests.includes(path)),
    ],
    ...(carried.draftingNotes !== undefined && carried.draftingNotes.length > 0
      ? { draftingNotes: [...carried.draftingNotes] }
      : {}),
    resources,
  }
  return {
    manifest,
    dockerfile: {
      id,
      filter: pkg.name,
      captured: captured.map((p) => ({ dir: p.dir.slice("packages/".length), name: p.name })),
      expectedPromoted: [...(carried.expectedPromoted ?? [])],
      npmrc,
    },
    notes,
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init-derive.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/init/derive.ts examples/software-factory/controller/test/target-init-derive.test.ts
git commit -m "feat(software-factory): derive a target's fields from a package's manifests at a pin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (review-driven; commits `3b6dd1427`, `763387421`). The vitest config is found by walking up from the package to the repository root, per directory then per name, as vitest does; a root config is captured and kept immutable with a note, and one between the package and the root is refused. The target package's uncaptured top-level files are noted, as is every relative path the vitest config names that the capture does not hold. A capture or `runnerConfig` entry overlapping a build output (`snapshotIgnore` prefix) is refused. TypeScript's version is read from the package, then the root's devDependencies and dependencies, and a version whose major cannot be read is refused. Each build config's `references` must name a build config of a package the target builds, or it is refused (`tsc -b` would build it too). A carried capture entry that is a link or submodule is dropped with a note; a carried scope file the capture does not hold is noted; `--with-dev-builds` is suggested only for packages it would capture.

### Task 7: `initTarget`: carried, derived, checked, formatted, proposed

**Files:**
- Create: `controller/src/lib/targets/proposal.ts`
- Create: `controller/src/lib/targets/init/init.ts`
- Test: `controller/test/target-init.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/target-init.test.ts`:

```ts
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { TargetSchema } from "../src/lib/targets/catalog.ts"
import { expectedPromotedOf, withExpectedPromoted } from "../src/lib/targets/init/dockerfile.ts"
import { initTarget, parseInitArgs } from "../src/lib/targets/init/init.ts"
import { formatManifest, renderDiff, writeProposal } from "../src/lib/targets/proposal.ts"
import { cleanupPinRepos, MINI, pinRepo } from "./pin-repo.ts"

const dirs: string[] = []
afterEach(() => {
  cleanupPinRepos()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const targetsDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-init-targets-"))
  dirs.push(dir)
  return dir
}

describe("initTarget", () => {
  it("proposes a new target as two added files, formatted as committed ones are, and writes nothing", () => {
    const { root, pin } = pinRepo(MINI)
    const targets = targetsDir()
    const result = initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets })
    expect(result.id).toBe("app")
    expect(result.files.map((f) => [relative(targets, f.path), f.before])).toEqual([
      ["app/target.json", null],
      ["app/Dockerfile", null],
    ])
    expect(readdirSync(targets)).toEqual([])
    const [manifest, dockerfile] = result.files as [(typeof result.files)[0], (typeof result.files)[0]]
    expect(TargetSchema.parse(JSON.parse(manifest.after)).commands.cwd).toBe("packages/app")
    expect(formatManifest(manifest.after)).toBe(manifest.after)
    expect(dockerfile.after).toContain('CAPTURED="app config core util"')
    const diff = renderDiff(result.files, targets)
    expect(diff).toContain("--- /dev/null\n+++ b/app/target.json\n")
    expect(diff).toContain("--- /dev/null\n+++ b/app/Dockerfile\n")
    expect(result.notes).toContain("resources are placeholders until target:measure proposes them")
  })

  it("is a fixed point: written, then generated again, it proposes nothing", () => {
    const { root, pin } = pinRepo(MINI)
    const targets = targetsDir()
    writeProposal(initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets }).files)
    const again = initTarget({ packageRef: "packages/app", pin, repositoryRoot: root, targetsDir: targets })
    expect(renderDiff(again.files, targets)).toBe("")
    expect(writeProposal(again.files)).toEqual([])
  })

  it("carries what a person or a measurement decided", () => {
    const { root, pin } = pinRepo(MINI)
    const targets = targetsDir()
    writeProposal(initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets }).files)
    const manifestPath = join(targets, "app", "target.json")
    const dockerfilePath = join(targets, "app", "Dockerfile")
    const current = JSON.parse(readFileSync(manifestPath, "utf8"))
    // Parsed, so the keys come out in the schema's order, as init writes them.
    const edited = TargetSchema.parse({
      ...current,
      resources: { memoryMb: 768, cpus: 2, commandTimeoutMs: 60_000, verifierDeadlineMs: 240_000 },
      draftingNotes: ["The app's tests build a fixture under os.tmpdir()."],
      commands: {
        ...current.commands,
        test: [...current.commands.test, "--exclude", "test/app.test.ts"],
      },
    })
    writeFileSync(manifestPath, formatManifest(`${JSON.stringify(edited, null, 2)}\n`))
    writeFileSync(dockerfilePath, withExpectedPromoted(readFileSync(dockerfilePath, "utf8"), ["zod"]))
    const again = initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets })
    expect(renderDiff(again.files, targets)).toBe("")
    expect(expectedPromotedOf(again.files[1]?.after ?? "")).toEqual(["zod"])
    expect(again.notes.some((note) => note.startsWith("carried from targets/app:"))).toBe(true)
  })

  it("refuses a target directory that belongs to another package, and an id that is not a name", () => {
    const { root, pin } = pinRepo(MINI)
    const targets = targetsDir()
    writeProposal(initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets }).files)
    expect(() =>
      initTarget({ packageRef: "@m/util", id: "app", pin, repositoryRoot: root, targetsDir: targets }),
    ).toThrow(/targets\/app is the target of packages\/app, not packages\/util: pass --id/)
    expect(() =>
      initTarget({ packageRef: "@m/util", id: "../x", pin, repositoryRoot: root, targetsDir: targets }),
    ).toThrow(/is not a target id/)
  })
})

describe("target:init's arguments", () => {
  it("takes a package, and optionally a full pin, an id, a catalog, --with-dev-builds and --write", () => {
    expect(parseInitArgs(["@b4run/devkit"])).toEqual({
      packageRef: "@b4run/devkit",
      withDevBuilds: false,
      write: false,
    })
    expect(
      parseInitArgs([
        "packages/cli", "--pin", "a".repeat(40), "--id", "cli2", "--targets-dir", "/tmp/t", "--with-dev-builds", "--write",
      ]),
    ).toEqual({
      packageRef: "packages/cli",
      pin: "a".repeat(40),
      id: "cli2",
      targetsDir: "/tmp/t",
      withDevBuilds: true,
      write: true,
    })
    expect(() => parseInitArgs([])).toThrow(/usage: target-init.ts/)
    expect(() => parseInitArgs(["a", "b"])).toThrow(/usage: target-init.ts/)
    expect(() => parseInitArgs(["a", "--pin", "abc"])).toThrow(/full lowercase commit sha/)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/lib/targets/proposal.ts`:

```ts
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { createTwoFilesPatch } from "diff"
import { appRoot } from "./catalog.js"

/**
 * A file `target:init` or `target:measure` would write. Nothing is written until the person
 * asks (`--write`); the diff of `before` and `after` is the proposal, and `git diff` after a
 * write is the review.
 */
export interface FileProposal {
  /** Absolute. */
  readonly path: string
  /** What is on disk now; null when there is no such file. */
  readonly before: string | null
  readonly after: string
}

export function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/**
 * `json` formatted as the checked-in target files are: the controller's own Biome (never
 * `npx`, which may resolve another version) with its own configuration, over stdin, so nothing
 * is written to be formatted.
 */
export function formatManifest(json: string): string {
  return execFileSync(join(appRoot, "node_modules", ".bin", "biome"), ["format", "--stdin-file-path=target.json"], {
    cwd: appRoot,
    input: json,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    timeout: 60_000,
  })
}

/** A unified diff of every proposal that changes its file, named relative to `base`. */
export function renderDiff(files: readonly FileProposal[], base: string): string {
  return files
    .filter((file) => file.before !== file.after)
    .map((file) => {
      const name = relative(base, file.path)
      return createTwoFilesPatch(
        file.before === null ? "/dev/null" : `a/${name}`,
        `b/${name}`,
        file.before ?? "",
        file.after,
        undefined,
        undefined,
        { context: 3 },
      )
    })
    .join("")
}

/** Write every proposal that changes its file; returns the paths written. */
export function writeProposal(files: readonly FileProposal[]): string[] {
  const written: string[] = []
  for (const file of files) {
    if (file.before === file.after) continue
    mkdirSync(dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.after)
    written.push(file.path)
  }
  return written
}
```

`src/lib/targets/init/init.ts`:

```ts
import { join } from "node:path"
import { parseArgs } from "node:util"
import {
  commitSha,
  covers,
  ensurePin,
  isCatalogId,
  type TargetManifest,
  TargetSchema,
} from "../catalog.js"
import { capturedListMismatch, firstMissingPath, pathsRequiredAtPin } from "../prepare.js"
import { type FileProposal, formatManifest, readIfPresent } from "../proposal.js"
import { parseVitestCommand } from "../vitest-command.js"
import { type CarriedFields, deriveTarget } from "./derive.js"
import { expectedPromotedOf, renderDockerfile } from "./dockerfile.js"
import { gitPinTree, type PinTree } from "./pin-tree.js"
import { readWorkspace, resolvePackage, type WorkspacePackage } from "./workspace-graph.js"

export interface InitOptions {
  /** A package name (`@b4run/devkit`) or its directory (`packages/devkit`). */
  readonly packageRef: string
  /** The target id; the package directory's name when absent. */
  readonly id?: string
  readonly pin: string
  readonly repositoryRoot: string
  readonly targetsDir: string
  /** Build and capture the package's workspace devDependencies that have builds (plan D16). */
  readonly withDevBuilds?: boolean
}

export interface InitResult {
  readonly id: string
  readonly directory: string
  /** `target.json`, then the `Dockerfile`. */
  readonly files: readonly FileProposal[]
  readonly notes: readonly string[]
}

/**
 * The target a package at a pin would have: `targets/<id>/target.json` and its `Dockerfile`,
 * as proposals against what is on disk. Deterministic: the manifests at the pin and what the
 * existing target carries (plan D8) decide every byte. The pin is made present first (fetched
 * by sha on a miss, as every catalog read does), so a shallow checkout can generate. The
 * proposal is refused, before anything is written, for anything `target:prepare` would refuse
 * before a build.
 */
export function initTarget(options: InitOptions): InitResult {
  ensurePin(options.repositoryRoot, "target:init", options.pin, {
    label: `target:init ${options.packageRef}`,
  })
  const tree = gitPinTree(options.repositoryRoot, options.pin)
  const graph = readWorkspace(tree)
  const pkg = resolvePackage(graph, options.packageRef)
  const id = options.id ?? pkg.dir.slice(pkg.dir.lastIndexOf("/") + 1)
  if (!isCatalogId(id))
    throw new Error(`${JSON.stringify(id)} is not a target id: it must be a plain directory name`)
  const directory = join(options.targetsDir, id)
  const manifestPath = join(directory, "target.json")
  const dockerfilePath = join(directory, "Dockerfile")
  const beforeManifest = readIfPresent(manifestPath)
  const beforeDockerfile = readIfPresent(dockerfilePath)
  const carried = carriedFrom(beforeManifest, beforeDockerfile, pkg, id)
  const derived = deriveTarget(tree, graph, pkg, {
    id,
    carried: carried.fields,
    ...(options.withDevBuilds ? { withDevBuilds: true } : {}),
  })
  const manifest: TargetManifest = TargetSchema.parse(derived.manifest)
  const dockerfile = renderDockerfile(derived.dockerfile)
  const problem = proposalProblem(manifest, dockerfile, tree)
  if (problem !== undefined) throw new Error(problem)
  return {
    id,
    directory,
    notes: [...carried.notes, ...derived.notes],
    files: [
      {
        path: manifestPath,
        before: beforeManifest,
        after: formatManifest(`${JSON.stringify(manifest, null, 2)}\n`),
      },
      { path: dockerfilePath, before: beforeDockerfile, after: dockerfile },
    ],
  }
}

/** What `recipeProblem` (`targets/prepare.ts`) would refuse, asked of the proposal itself. */
function proposalProblem(
  manifest: TargetManifest,
  dockerfile: string,
  tree: PinTree,
): string | undefined {
  const missing = firstMissingPath(pathsRequiredAtPin(manifest), (path) => tree.kind(path) !== undefined)
  if (missing !== undefined) return `The proposal names ${missing}, which does not exist at ${tree.pin}`
  const captured = capturedListMismatch(manifest, dockerfile)
  if (captured !== undefined) return captured
  if (!covers(manifest.imageContext, manifest.lockfile))
    return `The proposal's imageContext does not cover its lockfile ${manifest.lockfile}`
  return undefined
}

/**
 * What the target already on disk decided and a re-generation keeps (plan D8). A target of
 * another package at this id is refused; one that does not parse carries nothing, and says so.
 * `deriveTarget` drops what names nothing at the pin, with a note each.
 */
function carriedFrom(
  manifestText: string | null,
  dockerfileText: string | null,
  pkg: WorkspacePackage,
  id: string,
): { readonly fields: CarriedFields; readonly notes: string[] } {
  const notes: string[] = []
  const promoted = dockerfileText === null ? undefined : expectedPromotedOf(dockerfileText)
  const fromDockerfile: CarriedFields = promoted === undefined ? {} : { expectedPromoted: promoted }
  if (manifestText === null) return { fields: fromDockerfile, notes }
  let raw: unknown
  try {
    raw = JSON.parse(manifestText)
  } catch {
    notes.push(`targets/${id}/target.json is not JSON; nothing is carried from it`)
    return { fields: fromDockerfile, notes }
  }
  const parsed = TargetSchema.safeParse(raw)
  if (!parsed.success) {
    notes.push(`targets/${id}/target.json does not parse; nothing is carried from it`)
    return { fields: fromDockerfile, notes }
  }
  const existing = parsed.data
  if (existing.commands.cwd !== pkg.dir)
    throw new Error(
      `targets/${id} is the target of ${existing.commands.cwd}, not ${pkg.dir}: pass --id to name another`,
    )
  let scope: readonly string[] = []
  let excludes: readonly string[] = []
  try {
    const command = parseVitestCommand(existing.commands.test)
    scope = command.files
    excludes = command.excludes
  } catch (error) {
    notes.push(
      `the existing test command is not read (${(error as Error).message}); its scope and excludes are not carried`,
    )
  }
  notes.push(
    `carried from targets/${id}: baseImage, resources${existing.draftingNotes ? ", draftingNotes" : ""}, ${scope.length} scoped file(s), ${excludes.length} exclude(s), imageAssertResolves, capture.include and runnerConfig as supersets${promoted === undefined ? "" : ", EXPECTED_PROMOTED"}`,
  )
  return {
    notes,
    fields: {
      ...fromDockerfile,
      baseImage: existing.baseImage,
      resources: existing.resources,
      ...(existing.draftingNotes !== undefined ? { draftingNotes: existing.draftingNotes } : {}),
      scope,
      excludes,
      imageAssertResolves: existing.imageAssertResolves,
      captureInclude: existing.capture.include,
      runnerConfig: existing.runnerConfig,
    },
  }
}

export interface InitArgs {
  readonly packageRef: string
  readonly id?: string
  readonly pin?: string
  /** The target catalog to propose into; the controller's `targets/` when absent. */
  readonly targetsDir?: string
  readonly withDevBuilds: boolean
  readonly write: boolean
}

export function parseInitArgs(argv: readonly string[]): InitArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      pin: { type: "string" },
      id: { type: "string" },
      "targets-dir": { type: "string" },
      "with-dev-builds": { type: "boolean", default: false },
      write: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  })
  const [packageRef, ...extra] = positionals
  if (!packageRef || extra.length > 0)
    throw new Error(
      "usage: target-init.ts <package name or directory> [--pin <sha>] [--id <id>] [--targets-dir <dir>] [--with-dev-builds] [--write]",
    )
  if (values.pin !== undefined && !commitSha.safeParse(values.pin).success)
    throw new Error(`--pin must be a full lowercase commit sha, got ${JSON.stringify(values.pin)}`)
  return {
    packageRef,
    withDevBuilds: values["with-dev-builds"],
    write: values.write,
    ...(values.pin !== undefined ? { pin: values.pin } : {}),
    ...(values.id !== undefined ? { id: values.id } : {}),
    ...(values["targets-dir"] !== undefined ? { targetsDir: values["targets-dir"] } : {}),
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0. If "is a fixed point" fails, the first thing to check is that `TargetSchema.parse` returns keys in the schema's order and that `formatManifest` is a fixed point on its own output (`formatManifest(x) === x` for a formatted `x`).

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/proposal.ts examples/software-factory/controller/src/lib/targets/init/init.ts examples/software-factory/controller/test/target-init.test.ts
git commit -m "feat(software-factory): propose a package's target as a diff, carrying what was decided

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (review-driven; commit `8050706c8`, shared with Task 8). A `target.json` that is not JSON or fails the schema is refused, naming the parse error, instead of being replaced with defaults that `--write` would have used to destroy decided resources, excludes and drafting notes. `writeProposal` re-reads each file and refuses one changed since the proposal, refuses a symlinked target directory, and writes through a temporary file renamed into place. A carried test scope replaces the "no test is excluded" note; notes say when only a Dockerfile's `EXPECTED_PROMOTED` is carried; `initTarget` validates the pin itself.

### Task 8: The `target:init` script

**Files:**
- Create: `controller/scripts/target-init.ts`
- Modify: `controller/package.json` (scripts)
- Test: `controller/test/target-init-script.test.ts`

- [ ] **Step 1: Write the failing test**

`test/target-init-script.test.ts`:

```ts
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { appRoot, targetsDir } from "../src/lib/targets/catalog.ts"
import { cleanupPinRepos, MINI, pinRepo } from "./pin-repo.ts"

afterEach(cleanupPinRepos)
const run = promisify(execFile)
// `.bin/tsx` is a shell shim `execFile(process.execPath, ...)` cannot run: tsx's own entry.
const tsxBin = join(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs")

describe("target-init.ts", () => {
  it("prints the proposal as a diff and writes nothing without --write", async () => {
    const { root, pin } = pinRepo(MINI)
    const { stdout, stderr } = await run(
      process.execPath,
      [tsxBin, "scripts/target-init.ts", "@m/app", "--pin", pin],
      { cwd: appRoot, env: { ...process.env, FACTORY_REPO_ROOT: root, FACTORY_NO_FETCH: "1" } },
    )
    expect(stdout).toContain("--- /dev/null\n+++ b/targets/app/target.json\n")
    expect(stdout).toContain("+++ b/targets/app/Dockerfile\n")
    expect(stderr).toContain("target:init: nothing written")
    expect(existsSync(join(targetsDir, "app"))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init-script.test.ts`
Expected: FAIL (the script does not exist; `Cannot find module`).

- [ ] **Step 3: Implement**

`scripts/target-init.ts`:

```ts
import { resolvePin } from "../src/lib/intake/issue.js"
import { appRoot, repositoryRoot, targetsDir } from "../src/lib/targets/catalog.js"
import { initTarget, parseInitArgs } from "../src/lib/targets/init/init.js"
import { renderDiff, writeProposal } from "../src/lib/targets/proposal.js"

/**
 * Generate a target for a pnpm workspace package: `targets/<id>/target.json` and its
 * `Dockerfile`, derived from the package's manifests at a pin read from the object store.
 *
 * `target-init.ts <package name or directory> [--pin <sha>] [--id <id>] [--targets-dir <dir>]
 * [--with-dev-builds] [--write]`
 *
 * Prints the proposal as a unified diff against what is on disk (stdout) and its notes
 * (stderr); writes only with --write. The pin defaults to origin/main, as `create --issue`
 * pins (FACTORY_NO_FETCH=1 reads the checkout's origin/main without fetching). --targets-dir
 * proposes into another catalog (a scratch measurement) instead of the controller's. A target
 * is an oracle input: the person reviews the diff and commits it; run target:measure first.
 */
const args = parseInitArgs(process.argv.slice(2))
const repo = repositoryRoot()
const pin =
  args.pin ?? (await resolvePin({ repositoryRoot: repo, fetch: process.env.FACTORY_NO_FETCH !== "1" }))
const result = initTarget({
  packageRef: args.packageRef,
  pin,
  repositoryRoot: repo,
  targetsDir: args.targetsDir ?? targetsDir,
  ...(args.id !== undefined ? { id: args.id } : {}),
  ...(args.withDevBuilds ? { withDevBuilds: true } : {}),
})
process.stdout.write(renderDiff(result.files, args.targetsDir === undefined ? appRoot : args.targetsDir))
process.stderr.write(`target:init: ${result.id} at ${pin}\n`)
for (const note of result.notes) process.stderr.write(`target:init: ${note}\n`)
if (args.write)
  for (const path of writeProposal(result.files)) process.stderr.write(`target:init: wrote ${path}\n`)
else
  process.stderr.write(
    "target:init: nothing written; --write writes the files above, and git diff is the review\n",
  )
```

In `controller/package.json`'s `scripts`, after `"target:prepare"`:

```json
    "target:init": "tsx scripts/target-init.ts",
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init-script.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/scripts/target-init.ts examples/software-factory/controller/package.json examples/software-factory/controller/test/target-init-script.test.ts
git commit -m "feat(software-factory): target:init prints a package's target as a diff

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (commits `c891cc06c`, `8050706c8`). A relative `--targets-dir` resolves against pnpm's `INIT_CWD`, else the working directory. A refusal prints as one `target:init: …` line and exits 1. The carried-scope and malformed-target behaviour is Task 7's as-landed note.

### Task 9: The proof: `init` reproduces `devkit` and `cli` at their pins

Spec §5's proof for `init`. Each difference from the hand-written target is asserted as exactly what it is, so a change to the generator that moves any of them fails here with the field named.

**Files:**
- Test: `controller/test/target-init-reproduces.test.ts`

- [ ] **Step 1: Write the test**

`test/target-init-reproduces.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  repositoryRoot,
  type TargetManifest,
  TargetSchema,
  targetsDir,
} from "../src/lib/targets/catalog.ts"
import { PLACEHOLDER_RESOURCES } from "../src/lib/targets/init/derive.ts"
import { expectedPromotedOf } from "../src/lib/targets/init/dockerfile.ts"
import { initTarget } from "../src/lib/targets/init/init.ts"
import { dockerfileCapturedPackages } from "../src/lib/targets/prepare.ts"
import { parseVitestCommand } from "../src/lib/targets/vitest-command.ts"

/** Several hundred git reads and a Biome format per generation: over vitest's 10 s hook default. */
const GENERATE_MS = 120_000

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const committed = (id: string): TargetManifest =>
  TargetSchema.parse(JSON.parse(readFileSync(join(targetsDir, id, "target.json"), "utf8")))
const committedDockerfile = (id: string) => readFileSync(join(targetsDir, id, "Dockerfile"), "utf8")

/** `init` of `packageRef` at `pin` into `into` (an empty directory unless given): nothing carried. */
function generate(packageRef: string, pin: string, into?: string) {
  const dir = into ?? mkdtempSync(join(tmpdir(), "factory-init-repro-"))
  if (into === undefined) dirs.push(dir)
  const result = initTarget({ packageRef, pin, repositoryRoot: repositoryRoot(), targetsDir: dir })
  const [manifest, dockerfile] = result.files
  return {
    manifest: TargetSchema.parse(JSON.parse(manifest?.after ?? "")) as TargetManifest,
    dockerfile: dockerfile?.after ?? "",
    notes: result.notes,
  }
}
const sorted = (paths: readonly string[]) => [...paths].sort()
/** Order-free lists sorted: init's order is canonical, a hand-written target's is not. */
const normalise = (m: TargetManifest): TargetManifest => ({
  ...m,
  capture: { include: sorted(m.capture.include) },
  imageContext: sorted(m.imageContext),
  runnerConfig: sorted(m.runnerConfig),
})

const CLI_BUILD = [
  "pnpm", "exec", "tsc", "-b", "--builders", "1",
  "../ag-ui", "../sdk", "../langgraph", "../permissions", "../workspace",
  "../sqlite-storage", "../core", "../langchain", "../memory", "tsconfig.build.json",
]

describe("target:init reproduces the hand-written devkit target", () => {
  const want = committed("devkit")
  let got: ReturnType<typeof generate>
  beforeAll(() => {
    got = generate("@b4run/devkit", want.pin)
  }, GENERATE_MS)

  it("is the committed target with exactly the named differences applied", () => {
    const committedCommand = parseVitestCommand(want.commands.test)
    // 1. The nine excludes are target:measure's to propose (Task 17 proves it proposes them).
    expect(committedCommand.files).toEqual([])
    expect(committedCommand.excludes).toHaveLength(9)
    expect(normalise(got.manifest)).toEqual(
      normalise({
        ...want,
        commands: { ...want.commands, test: [...committedCommand.base] },
        // 2. runnerConfig gains the root manifests: the rule the cli target's review adopted.
        //    The devkit task already keeps them immutable.
        runnerConfig: [...want.runnerConfig, "package.json", "pnpm-workspace.yaml", ".npmrc"],
        // 3. Resources are placeholders until target:measure proposes them.
        resources: PLACEHOLDER_RESOURCES,
      }),
    )
  })

  it("writes the template Dockerfile, and names what the capture leaves out", () => {
    // 4. The Dockerfile is the one template: both captured packages relinked, nothing to
    //    promote until a build says otherwise.
    expect(got.dockerfile).not.toBe(committedDockerfile("devkit"))
    expect(dockerfileCapturedPackages(got.dockerfile)).toEqual(["config-typescript", "devkit"])
    expect(got.dockerfile).toContain("--filter @b4run/devkit... --ignore-scripts --config.node-linker=hoisted")
    expect(expectedPromotedOf(got.dockerfile)).toEqual([])
    expect(got.notes).toContainEqual(expect.stringMatching(/^packages\/devkit: not captured: templates\/ \(\d+ files\)$/))
  })

  it("carries everything decided when it regenerates the committed target in place", () => {
    const again = generate("@b4run/devkit", want.pin, targetsDir)
    expect(normalise(again.manifest)).toEqual(
      normalise({ ...want, runnerConfig: [...want.runnerConfig, "package.json", "pnpm-workspace.yaml", ".npmrc"] }),
    )
  }, GENERATE_MS)
})

describe("target:init reproduces the hand-written cli target", () => {
  const want = committed("cli")
  let got: ReturnType<typeof generate>
  beforeAll(() => {
    got = generate("@b4run/cli", want.pin)
  }, GENERATE_MS)

  it("is the committed target with exactly the named differences applied", () => {
    const scoped = want.capture.include.filter((path) => path.startsWith("packages/cli/test/"))
    const committedCommand = parseVitestCommand(want.commands.test)
    expect(scoped).toHaveLength(9)
    expect(committedCommand.files).toHaveLength(8)
    // Two hand-picked module assertions (commander checks the promotion), a build that
    // disables declaration maps (a snapshot-cost mitigation #826 and #829 made unnecessary),
    // and eight hand-verified drafting notes.
    expect(want.imageAssertResolves.slice(3)).toEqual(["@langchain/langgraph", "commander"])
    expect(want.commands.build).toContain("--declarationMap")
    expect(want.draftingNotes).toHaveLength(8)
    const { draftingNotes: _notes, ...undecided } = want
    expect(normalise(got.manifest)).toEqual(
      normalise({
        ...undecided,
        // 1. Scope: the whole test directory, not eight files and their helper (plan D4).
        capture: {
          include: [...want.capture.include.filter((path) => !scoped.includes(path)), "packages/cli/test"],
        },
        // 2. The derived module assertions only.
        imageAssertResolves: want.imageAssertResolves.slice(0, 3),
        // 3. The same ten projects in another topological order; the base test command.
        commands: { ...want.commands, build: CLI_BUILD, test: [...committedCommand.base] },
        // 4. Resources are placeholders until target:measure proposes them.
        resources: PLACEHOLDER_RESOURCES,
      }),
    )
  })

  it("relinks the same packages, learns its promotion set later, and names what it omits", () => {
    expect(dockerfileCapturedPackages(got.dockerfile)).toEqual(
      dockerfileCapturedPackages(committedDockerfile("cli")),
    )
    expect(expectedPromotedOf(got.dockerfile)).toEqual([])
    expect(expectedPromotedOf(committedDockerfile("cli"))).toEqual([
      "@hono/node-server", "commander", "hono", "typescript",
    ])
    expect(got.notes).toContain(
      "@b4run/sandbox (packages/sandbox) is installed, not captured: a test importing it resolves the image's manifest-only copy and fails, and target:measure proposes excluding that test (or pass --with-dev-builds)",
    )
    expect(got.notes).toContain(
      "packages/cli/vitest.config.ts reads ../sandbox/ (packages/sandbox), which the capture omits: a test that reaches it fails, and target:measure proposes excluding it",
    )
    expect(got.notes).toContainEqual(
      expect.stringMatching(/^packages\/cli: not captured: bin\/ \(\d+ files?\), scripts\/ \(\d+ files?\)$/),
    )
  })

  it("carries everything decided when it regenerates the committed target in place", () => {
    const again = generate("@b4run/cli", want.pin, targetsDir)
    // Scope, capture, module assertions, runner configuration, resources, drafting notes and
    // the promotion set all carried; only the build is regenerated.
    expect(normalise(again.manifest)).toEqual(normalise({ ...want, commands: { ...want.commands, build: CLI_BUILD } }))
    expect(again.manifest.imageAssertResolves).toEqual(want.imageAssertResolves)
    expect(sorted(again.manifest.capture.include)).toEqual(sorted(want.capture.include))
    expect(expectedPromotedOf(again.dockerfile)).toEqual(expectedPromotedOf(committedDockerfile("cli")))
  }, GENERATE_MS)
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-init-reproduces.test.ts`
Expected: PASS. A failure here is a finding about the generator or about the plan's claim, never a reason to loosen an assertion: stop, record what differs and why in the PR description, and ask before changing the expectation.

- [ ] **Step 3: Commit**

```bash
git add examples/software-factory/controller/test/target-init-reproduces.test.ts
git commit -m "test(software-factory): target:init reproduces the devkit and cli targets, differences named

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (commit `f71622df1`). Passed on its first run. Bound by mutation: breaking the placeholder resources and the `cli` build order each reds the test.

### Task 10: Docker lanes: the generated `devkit` Dockerfile builds; the `cli` one, by hand, before PR 1 merges

`devkit` exercises neither the nested-TypeScript shim nor a relink by a name other than its own; only `cli` does (review I9). So the `cli` build is part of PR 1, opt-in like the `cli` target's own lane, and run once by hand before the PR merges.

**Files:**
- Test: `controller/test/target-init.integration.test.ts`
- Modify: `controller/package.json` (`test:sandbox:cli`)

- [ ] **Step 1: Write the lane**

`test/target-init.integration.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  configuredImages,
  loadTargetRecipe,
  repositoryRoot,
  targetsDir,
} from "../src/lib/targets/catalog.ts"
import {
  expectedPromotedOf,
  promotionMismatch,
  withExpectedPromoted,
} from "../src/lib/targets/init/dockerfile.ts"
import { initTarget } from "../src/lib/targets/init/init.ts"
import { type EnsuredImage, ImagePrepareError } from "../src/lib/targets/images.ts"
import { writeProposal } from "../src/lib/targets/proposal.ts"
import { shippedPin } from "./temp-repo.ts"

/**
 * Generate `packageRef`'s target at `id`'s shipped pin into a scratch catalog and build it
 * through the run's registry, learning the promotion set once if the first build names one
 * (what a person does with target:measure's proposal). initTarget makes the pin present
 * itself, so this holds on a shallow checkout whatever the global setup built first.
 */
async function buildGenerated(packageRef: string, id: string) {
  const registry = configuredImages()
  if (registry === undefined) throw new Error("the lane setup configured no image registry")
  const targets = mkdtempSync(join(tmpdir(), `factory-init-lane-${id}-`))
  try {
    writeProposal(
      initTarget({ packageRef, pin: shippedPin(id), repositoryRoot: repositoryRoot(), targetsDir: targets }).files,
    )
    const ensure = () =>
      registry.ensure(loadTargetRecipe(id, { targetsDir: targets }), { signal: AbortSignal.timeout(2_400_000) })
    let learned: string[] | undefined
    let ensured: EnsuredImage
    try {
      ensured = await ensure()
    } catch (error) {
      learned = error instanceof ImagePrepareError ? promotionMismatch(error.log) : undefined
      if (learned === undefined) throw error
      process.stderr.write(`lane: the generated ${id} Dockerfile promotes [${learned.join(" ")}]\n`)
      const path = join(targets, id, "Dockerfile")
      writeFileSync(path, withExpectedPromoted(readFileSync(path, "utf8"), learned))
      ensured = await ensure()
    }
    return { ensured, learned }
  } finally {
    rmSync(targets, { recursive: true, force: true })
  }
}

describe("a devkit target generated by target:init", () => {
  it(
    "builds through the registry",
    async () => {
      const { ensured } = await buildGenerated("@b4run/devkit", "devkit")
      expect(ensured.image.localId).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(ensured.image.baseManifestDigest).toBe(
        "sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6",
      )
      // The build ran the promotion step, and every module assertion passed in the image.
      if (ensured.build !== undefined) expect(ensured.build.log).toMatch(/b4-factory promoted:[^\n$"]*$/m)
    },
    5_000_000,
  )
})

/**
 * The template's nested-typescript shim and its relinks by package name are exercised only by
 * cli (plan I9). Opt-in like the cli target's own lane (a 2 GB image): `test:sandbox:cli`
 * sets the variable, and PR 1 runs it once by hand before it merges.
 */
describe.skipIf(process.env.FACTORY_TEST_CLI_TARGET !== "1")("a cli target generated by target:init", () => {
  it(
    "learns the hand-written Dockerfile's promotion set from its first build, then builds",
    async () => {
      const { ensured, learned } = await buildGenerated("@b4run/cli", "cli")
      expect(learned).toEqual(expectedPromotedOf(readFileSync(join(targetsDir, "cli", "Dockerfile"), "utf8")))
      expect(ensured.image.localId).toMatch(/^sha256:[0-9a-f]{64}$/)
    },
    5_000_000,
  )
})
```

In `controller/package.json`, `test:sandbox:cli` becomes:

```json
    "test:sandbox:cli": "FACTORY_TEST_CLI_TARGET=1 vitest run --config vitest.sandbox.config.ts test/target-cli.integration.test.ts test/target-init.integration.test.ts",
```

- [ ] **Step 2: Run the `devkit` lane**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run --config vitest.sandbox.config.ts test/target-init.integration.test.ts`
Expected: PASS, the `cli` case skipped. Record in the PR description the wall clock and whether the build learned a promotion set (the prototype: none at `6a59e00a`).

- [ ] **Step 3: Run the `cli` lane once, by hand, before PR 1 merges**

Run: `FACTORY_TEST_CLI_TARGET=1 pnpm --filter @b4-example/software-factory-controller exec vitest run --config vitest.sandbox.config.ts test/target-init.integration.test.ts`
Expected: PASS: the first build fails at the promotion check naming `@hono/node-server commander hono typescript` (the hand-written set), the second builds (the shim and the relinks by name in a real image). Record the wall clock and both builds' outcome in PR 1's description. If it fails anywhere else, the template is wrong for `cli`: fix it in PR 1, not later.

- [ ] **Step 4: Commit**

```bash
git add examples/software-factory/controller/test/target-init.integration.test.ts examples/software-factory/controller/package.json
git commit -m "test(software-factory): generated devkit and (opt-in) cli Dockerfiles build through the registry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (commit `5c03661dd`). The plan's log regex (`/b4-factory promoted:[^\n$"]*$/m`) did not handle BuildKit's `#N <seconds>` line prefixes or a cached step, which prints nothing; `promotionStepOutcome` finds the promotion step's number from its RUN line and returns the printed set, `cached` or `absent`. The `devkit` lane builds with the empty set `init` writes (it learns none). The `cli` lane was run once by hand (`FACTORY_TEST_CLI_TARGET=1`, `test:sandbox:cli`): the first build learned exactly `@hono/node-server commander hono typescript`, the hand-written `cli` set, and the second build succeeded. All timings recorded were on a warm cache.

### Task 11: Docs for PR 1

**Files:**
- Modify: `examples/software-factory/README.md` (after the paragraph ending "…nothing requires it." in "Run it", `README.md:331`)
- Modify: `docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md` (§5, after "**Size: L.**")

- [ ] **Step 1: README**

Insert after the `target:prepare` paragraph:

```markdown
Adding a target for a pnpm workspace package is two commands and a review.
`pnpm --filter @b4-example/software-factory-controller target:init <package> [--pin <sha>] [--id <id>] [--write]`
derives `targets/<id>/target.json` and its `Dockerfile` from the package's manifests at the pin
(read from the object store, never the working tree; the pin defaults to `origin/main`): the
capture (the root manifests; the package's manifest, tsconfig files, vitest config, `src` and
`test`; each runtime dependency's manifest, build tsconfig and `src`; config packages whole),
the image context (every installed package's manifest), the build (one `tsc -b` over the
dependency closure in dependency order), the test command, the runner configuration and the
build outputs. It prints a diff and writes only with `--write`. Resources are placeholders and
no test is excluded until `target:measure` proposes them. Re-running it on an existing target
keeps what was decided there (base image, resources, drafting notes, the test command's scope
and excludes, the Dockerfile's promotion set), so an unchanged target prints an empty diff.
Its notes name what the capture leaves out (package subdirectories, a sibling the vitest config
reads) and each package installed but not captured; `--with-dev-builds` captures and builds the
package's workspace devDependencies that have builds. Only packages under `packages/` whose
tests run with vitest are generated; `cli-flags` stays hand-written.
```

- [ ] **Step 2: Spec as-landed (PR 1)**

Append after §5's "**Size: L.**":

```markdown
**As landed** ([plan](../plans/2026-09-25-targets-generated-from-a-package.md), PR 1).
`target:init` is a package script beside `target:prepare`, not a `factory` command (the CLI
talks to a controller). It derives three closures, not one: the build closure over
`dependencies` (captured), the install closure pnpm's `--filter <pkg>...` installs
(`imageContext`; `cli`'s devDependency `@b4run/sandbox` is installed, not captured) and config
packages (captured, in the image and in `runnerConfig` whole). The build is one `tsc -b` over
each package's own build tsconfig in topological order with `--builders 1`, not references or
`pnpm -r run build` (references are partial and build scripts do more than compile). The
Dockerfile is one template, the `cli` Dockerfile generalised; its promotion set cannot be
derived without pnpm, so `target:measure` learns it from a build. Proof: at their pins, `init`
reproduces `devkit` except its nine excludes, its resources, its narrower `runnerConfig` and its
Dockerfile, and `cli` except its eight-file scope, two extra module assertions, its build's
project order and `--declarationMap false`, its resources, promotion set and drafting notes
(`test/target-init-reproduces.test.ts`); the generated `devkit` Dockerfile builds
(`test/target-init.integration.test.ts`<, learning the promotion set [...]: fill in from the
lane's output, or delete this clause if it learned none>).
```

- [ ] **Step 3: SEO lastmod check**

These files are not under `apps/web`, so no lastmod regeneration is needed. Confirm: `git diff --name-only origin/main | grep '^apps/web' || echo none`.
Expected: `none`.

- [ ] **Step 4: Commit**

```bash
git add examples/software-factory/README.md docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md
git commit -m "docs(software-factory): target:init in the README and the spec's as-landed note

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (final review of PR 1). The README paragraph was reworded: `target:measure` comes in PR 2, so a generated target must not be committed until it is measured, a re-generation does not carry `--with-dev-builds`, and the scope also requires a root `packageManager: pnpm@x.y.z` and a build script of exactly one `tsc -b <file>`; `scripts/target-init.ts`'s header says the same. Final-review fixes: (1) `--builders` reads only the root's TypeScript, the `tsc` the image builds with (the Dockerfile shims nested copies onto it), superseding Task 8's "from the package, then the root's": `packages/core`, which nests `npm:@typescript/typescript6@6.0.2`, was refused and now generates (`--builders 1` from the root's 7.0.2); (2) a target whose resources are `PLACEHOLDER_RESOURCES` (moved to `catalog.ts`, re-exported from `derive.ts`) is never offered to the drafter, and a draft or task naming it is refused by `unmeasuredProblem` ("resources are placeholders: run target:measure"); `recipeProblem` is unchanged, so such a target still builds, which `target:measure` needs; every shipped target is measured and unaffected; (3) a vitest `setupFiles` or `globalSetup` entry the capture omits is refused by name ("every test would fail") instead of noted per file, which now refuses `create-b4-app` at `980ba8a3` (its `globalSetup` is the repository's `test/harness/registry-global-setup.ts`); (4) refusals no longer repeat `target:init` under the script's own prefix (the missing-pin label is the package asked for) and start lowercase.

**PR 1 verification** (all from the repository root):

```bash
source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @b4-example/software-factory-controller typecheck
pnpm --filter @b4-example/software-factory-controller lint
pnpm --filter @b4-example/software-factory-controller test
pnpm --filter @b4-example/software-factory-controller exec vitest run --config vitest.sandbox.config.ts test/target-init.integration.test.ts
FACTORY_TEST_CLI_TARGET=1 pnpm --filter @b4-example/software-factory-controller exec vitest run --config vitest.sandbox.config.ts test/target-init.integration.test.ts   # once, by hand (Task 10 Step 3)
node scripts/check-docs.mjs
```

Push `blove/targets-init` and open the PR only when Brian asks.

---

# PR 2: `target:measure`

```bash
git fetch origin
git switch -c blove/targets-measure origin/main    # after PR 1 merged
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@b4-example/software-factory-controller^...
pnpm --filter @b4-example/software-factory-controller test
```

### Task 12: A workspace for anything task-shaped; a `measure` capture role

`measure` runs the verifier's session shape without a task: it has a target recipe and nothing else. The capture and workspace functions read only a task's id, target, spec text and defect patch, so their parameter types say exactly that. No behaviour changes.

**Files:**
- Modify: `controller/src/lib/targets/archive.ts` (`CaptureRole` `:38`; `captureTarget` `:172-176`)
- Modify: `controller/src/lib/targets/workspace.ts` (`targetWorkspace` `:75-79`, `targetInspectionOptions` `:122`)
- Test: `controller/test/target-measure-workspace.test.ts`

- [ ] **Step 1: Write the failing test**

`test/target-measure-workspace.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadTargetRecipe } from "../src/lib/targets/catalog.ts"
import { initTarget } from "../src/lib/targets/init/init.ts"
import { writeProposal } from "../src/lib/targets/proposal.ts"
import { targetInspectionOptions, targetWorkspace } from "../src/lib/targets/workspace.ts"
import { cleanupPinRepos, MINI, pinRepo } from "./pin-repo.ts"

const dirs: string[] = []
afterEach(() => {
  cleanupPinRepos()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe("a workspace for target:measure", () => {
  it("captures a generated target with no task behind it, and inspects it as the verifier does", () => {
    const { root, pin } = pinRepo(MINI)
    const targets = temp("factory-measure-targets-")
    writeProposal(initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets }).files)
    const recipe = loadTargetRecipe("app", { targetsDir: targets, repositoryRoot: root })
    const definition = targetWorkspace(
      { id: "measure-app", target: recipe, specText: "measuring\n", defectPatch: null },
      "measure",
      { captureRoot: temp("factory-measure-captures-"), repositoryRoot: root },
    )
    // Every capture entry init proposed is present at the pin and archives.
    expect(definition.source.include).toEqual([
      ".npmrc",
      "package.json",
      "packages/app/package.json",
      "packages/app/src/index.ts",
      "packages/app/test/app.test.ts",
      "packages/app/test/helpers/h.ts",
      "packages/app/tsconfig.build.json",
      "packages/app/tsconfig.json",
      "packages/app/vitest.config.ts",
      "packages/config/base.json",
      "packages/config/package.json",
      "packages/core/package.json",
      "packages/core/src/index.ts",
      "packages/core/tsconfig.json",
      "packages/util/package.json",
      "packages/util/src/index.ts",
      "packages/util/tsconfig.json",
      "pnpm-workspace.yaml",
    ])
    expect(definition.environmentLinks).toEqual([
      { path: "node_modules", target: "/opt/targets/app/node_modules" },
    ])
    expect(targetInspectionOptions({ target: recipe }).ignorePrefixes).toEqual(recipe.snapshotIgnore)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-measure-workspace.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: the typecheck FAILS (`"measure"` is not a `CaptureRole`; the object literal lacks `manifest`, `checks`, `directory`, `referencePatch`).

- [ ] **Step 3: Implement**

In `archive.ts`, replace `:38`:

```ts
export type CaptureRole =
  | "builder"
  | "controller"
  | "verifier"
  | "reference"
  | "test"
  | "drafter"
  | "measure"
```

and `captureTarget`'s first parameter (`:173`):

```ts
  task: Pick<TaskRecipe, "id" | "target" | "defectPatch">,
```

In `workspace.ts`, above `targetWorkspace`:

```ts
/**
 * What a workspace is built from: a task, or anything task-shaped. `target:measure` builds the
 * verifier's session for a target with no task behind it (no defect, a placeholder spec).
 */
export type WorkspaceTask = Pick<TaskRecipe, "id" | "target" | "specText" | "defectPatch">
```

change `targetWorkspace`'s first parameter to `task: WorkspaceTask`, and `targetInspectionOptions`'s to `task: Pick<TaskRecipe, "target">`. Callers (`builder-handoff.ts:174`, `verification/grade-suite.ts:82,90`, `verification/baseline.ts:39`, `runtime.ts:177`) pass whole tasks and need no change.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-measure-workspace.test.ts test/targets-workspace.test.ts test/targets-archive.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/archive.ts examples/software-factory/controller/src/lib/targets/workspace.ts examples/software-factory/controller/test/target-measure-workspace.test.ts
git commit -m "refactor(software-factory): a target workspace for anything task-shaped; a measure capture role

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Classifying a file, proposing resources, the report

**Files:**
- Modify: `controller/src/lib/targets/vitest-command.ts` (add `perFileArgv`, `listArgv`)
- Create: `controller/src/lib/targets/measure/classify.ts`
- Test: `controller/test/target-vitest-command.test.ts` (extend), `controller/test/target-measure-classify.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/target-vitest-command.test.ts` (and add `listArgv`, `perFileArgv` to its import):

```ts
describe("the commands target:measure runs", () => {
  it("lists what the command would run, excludes ignored, and runs one file with the base alone", () => {
    const devkit = parseVitestCommand(shipped("devkit").commands.test)
    expect(listArgv(devkit)).toEqual([
      "pnpm", "exec", "vitest", "list", "--filesOnly", "--run", "--no-cache", "--config", "vitest.config.ts",
    ])
    expect(perFileArgv(devkit, "test/reporting.test.ts")).toEqual([...devkit.base, "test/reporting.test.ts"])
    const cli = parseVitestCommand(shipped("cli").commands.test)
    expect(listArgv(cli).slice(-8)).toEqual(cli.files)
    expect(listArgv(parseVitestCommand(["pnpm", "exec", "vitest", "run", "--no-cache"]))).toEqual([
      "pnpm", "exec", "vitest", "list", "--filesOnly", "--no-cache",
    ])
  })
})
```

`test/target-measure-classify.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
  captureOmissions,
  changedPaths,
  classifyFile,
  errorLines,
  MeasureError,
  type Measurement,
  outputTail,
  proposeResources,
  renderMeasurementRecord,
  renderReport,
  settleFile,
  settleResources,
  type VitestRun,
} from "../src/lib/targets/measure/classify.ts"

const MiB = 1024 * 1024
const LIMITS = { fileTimeoutMs: 180_000, memoryMb: 4096 }
const COUNTS = { passed: 3, failed: 0, skipped: 0 }
const run = (overrides: Partial<VitestRun> = {}): VitestRun => ({
  exitCode: 0,
  output: "\u001b[32m✓\u001b[0m test/a.test.ts (3 tests)\n",
  timedOut: false,
  files: [{ file: "test/a.test.ts", passed: true, tests: COUNTS }],
  ms: 1_234,
  ...overrides,
})
const failing = (output: string): VitestRun =>
  run({ exitCode: 1, output, files: [{ file: "test/a.test.ts", passed: false, tests: { passed: 0, failed: 2, skipped: 1 } }] })

describe("a file run alone", () => {
  it("passes when it passes and leaves the workspace as it found it", () => {
    expect(classifyFile("test/a.test.ts", run(), [], LIMITS)).toEqual({
      file: "test/a.test.ts",
      verdict: "pass",
      reason: "passes run alone",
      output: "",
      ms: 1_234,
      changed: [],
      tests: COUNTS,
      omissions: [],
    })
  })

  it("is proposed for exclusion when it fails, hangs, is killed or writes, with its output", () => {
    expect(classifyFile("test/a.test.ts", failing("AssertionError: nope\n"), [], LIMITS)).toMatchObject({
      verdict: "fail",
      reason: "fails run alone (exit 1)",
      output: "AssertionError: nope",
      tests: { passed: 0, failed: 2, skipped: 1 },
    })
    expect(classifyFile("test/a.test.ts", run({ exitCode: 124, timedOut: true, files: null }), [], LIMITS)).toMatchObject({
      verdict: "hang",
      reason: "did not finish within 180000 ms run alone",
    })
    expect(classifyFile("test/a.test.ts", run({ exitCode: 137, files: null }), [], LIMITS)).toMatchObject({
      verdict: "killed",
      reason: "was killed (exit 137; the session's memory limit was 4096 MB)",
    })
    const writes = classifyFile("test/a.test.ts", run(), ["packages/app/test/out.json"], LIMITS)
    expect(writes.verdict).toBe("writes")
    expect(writes.reason).toBe(
      "passes, but changes the workspace, which the verifier refuses as tampering: packages/app/test/out.json",
    )
  })

  it("reports what a failing file changed too, and names a capture omission", () => {
    const output = "Error: ENOENT: no such file or directory, open '/workspace/packages/devkit/templates/app-basic/AGENTS.md'\n"
    const result = classifyFile(
      "test/a.test.ts",
      failing(output),
      ["packages/app/test/out.json"],
      LIMITS,
      (path) => path === "packages/devkit/templates/app-basic/AGENTS.md",
    )
    expect(result.verdict).toBe("fail")
    expect(result.changed).toEqual(["packages/app/test/out.json"])
    expect(result.omissions).toEqual(["packages/devkit/templates/app-basic/AGENTS.md"])
    expect(result.reason).toBe(
      "fails run alone (exit 1); it also changed the workspace: packages/app/test/out.json; capture omission: packages/devkit/templates/app-basic/AGENTS.md exist(s) at the pin but not in the capture",
    )
    expect(captureOmissions(output, () => false)).toEqual([])
    expect(captureOmissions("ENOENT: open '/tmp/x'\n", () => true)).toEqual([])
  })

  it("is a harness error, never an exclude, when the run did not select exactly that file", () => {
    expect(() =>
      classifyFile(
        "test/a.test.ts",
        run({
          files: [
            { file: "test/x/test/a.test.ts", passed: true, tests: COUNTS },
            { file: "test/a.test.ts", passed: true, tests: COUNTS },
          ],
        }),
        [],
        LIMITS,
      ),
    ).toThrow(MeasureError)
    expect(() => classifyFile("test/a.test.ts", run({ files: [], exitCode: 1 }), [], LIMITS)).toThrow(
      /must select exactly this file/,
    )
    expect(() => classifyFile("test/a.test.ts", run({ files: null, exitCode: 2 }), [], LIMITS)).toThrow(
      /wrote no report/,
    )
  })

  it("settles two runs: a disagreement is flaky, never excluded", () => {
    const first = classifyFile("test/a.test.ts", failing("Error: once\n"), [], LIMITS)
    const pass = classifyFile("test/a.test.ts", run(), [], LIMITS)
    expect(settleFile(first, pass)).toMatchObject({
      verdict: "flaky",
      reason: "fails run alone (exit 1) on its first run, but passed a second run in a fresh container: listed, not excluded",
    })
    expect(settleFile(first, first)).toMatchObject({
      verdict: "fail",
      reason: "fails run alone (exit 1) (a second run in a fresh container: fail)",
    })
    expect(settleFile(pass, first)).toBe(pass)
  })

  it("keeps the tail of the output, without terminal escapes, and its error lines without durations", () => {
    expect(outputTail("\u001b[31mred\u001b[0m\n")).toBe("red")
    expect(outputTail("x".repeat(5_000))).toBe(`…${"x".repeat(4_000)}`)
    expect(changedPaths({ a: "1", b: "2" }, { a: "1", b: "3", c: "4" })).toEqual(["b", "c"])
    expect(changedPaths({ a: "1" }, {})).toEqual(["a"])
    expect(errorLines(" × a test 3ms\nError: ENOENT: no such file 12ms\nError: ENOENT: no such file 9ms\nTypeError: x\n")).toEqual([
      "Error: ENOENT: no such file",
      "TypeError: x",
    ])
  })
})

describe("the resources a measured suite proposes", () => {
  it("gives devkit's committed memory and verifier deadline from rung 2's measurement", () => {
    // Rung 2: build 1.4 s, suite 8.9 s, memory.peak 369 MiB; a session of 40 s. The committed
    // commandTimeoutMs (60000) is 6.7 times the suite, under this rule's eight times (80000).
    expect(
      proposeResources([{ buildMs: 1_400, suiteMs: 8_900, sessionMs: 40_000, memoryPeakBytes: 369 * MiB }], 2),
    ).toEqual({ memoryMb: 768, cpus: 2, commandTimeoutMs: 80_000, verifierDeadlineMs: 240_000 })
  })

  it("takes the worst of every sample, and never goes below its floors", () => {
    expect(
      proposeResources(
        [
          { buildMs: 3_700, suiteMs: 12_300, sessionMs: 60_000, memoryPeakBytes: 449 * MiB },
          { buildMs: 2_800, suiteMs: 15_300, sessionMs: 45_000, memoryPeakBytes: 487 * MiB },
        ],
        2,
      ),
    ).toEqual({ memoryMb: 1024, cpus: 2, commandTimeoutMs: 130_000, verifierDeadlineMs: 300_000 })
    expect(proposeResources([{ buildMs: 1, suiteMs: 1, sessionMs: 1, memoryPeakBytes: 1 }], 1)).toEqual({
      memoryMb: 512,
      cpus: 1,
      commandTimeoutMs: 60_000,
      verifierDeadlineMs: 120_000,
    })
    expect(() => proposeResources([], 2)).toThrow(/no suite sample/)
  })

  it("never proposes below the target's own resources unless asked", () => {
    const measured = { memoryMb: 512, cpus: 2, commandTimeoutMs: 70_000, verifierDeadlineMs: 120_000 }
    const prior = { memoryMb: 768, cpus: 2, commandTimeoutMs: 60_000, verifierDeadlineMs: 240_000 }
    expect(settleResources(measured, prior, false)).toEqual({
      memoryMb: 768,
      cpus: 2,
      commandTimeoutMs: 70_000,
      verifierDeadlineMs: 240_000,
    })
    expect(settleResources(measured, prior, true)).toEqual(measured)
    expect(settleResources(measured, undefined, false)).toEqual(measured)
  })
})

describe("what a measurement writes", () => {
  const measurement: Measurement = {
    files: [
      { file: "test/a.test.ts", verdict: "pass", reason: "passes run alone", output: "", ms: 10, changed: [], omissions: [] },
      { file: "test/b.test.ts", verdict: "fail", reason: "fails run alone (exit 1)", output: "```\nError: boom 4ms", ms: 20, changed: [], omissions: [] },
      { file: "test/c.test.ts", verdict: "flaky", reason: "fails run alone (exit 1) on its first run, but passed a second run in a fresh container: listed, not excluded", output: "Error: once", ms: 30, changed: [], omissions: [] },
    ],
    excludes: ["test/b.test.ts"],
    test: ["pnpm", "exec", "vitest", "--run", "--exclude", "test/b.test.ts"],
    samples: [{ buildMs: 1_000, suiteMs: 2_000, sessionMs: 30_000, memoryPeakBytes: 300 * MiB }],
    measured: { memoryMb: 768, cpus: 2, commandTimeoutMs: 60_000, verifierDeadlineMs: 180_000 },
    prior: undefined,
    resources: { memoryMb: 768, cpus: 2, commandTimeoutMs: 60_000, verifierDeadlineMs: 180_000 },
    confirmation: { buildMs: 900, suiteMs: 2_100, sessionMs: 29_000, memoryPeakBytes: 310 * MiB },
  }

  it("a report that names every file, fences each output, and sets before, measured and proposed side by side", () => {
    const report = renderReport({
      target: { id: "app", pin: "a".repeat(40) },
      image: { localId: `sha256:${"b".repeat(64)}`, tag: "b4-factory-app:aaaaaaaaaaaa-cccccccccccc" },
      measurement,
      limits: LIMITS,
      notes: ["measured at another pin"],
    })
    expect(report).toContain(`# target:measure app at ${"a".repeat(40)}`)
    expect(report).toContain("> measured at another pin")
    expect(report).toContain("## Files: 3, 1 pass, 1 proposed for exclusion, 1 flaky")
    expect(report).toContain("### `test/b.test.ts`: fail\n\nfails run alone (exit 1)\n\n````\n```\nError: boom 4ms\n````\n")
    expect(report).toContain("| 1 | 1000 | 2000 | 30000 | 300 |")
    expect(report).toContain("| at the proposed resources | 900 | 2100 | 29000 | 310 |")
    expect(report).toContain("| memoryMb | (placeholder) | 768 | 768 |")
  })

  it("a committed record with each exclude's class and error lines, and no timing", () => {
    expect(renderMeasurementRecord("app", measurement.files)).toBe(
      [
        "# Measured excludes: app",
        "",
        "Written by `target:measure --write` and reviewed with `target.json`. Each file below is excluded from the target's suite, and so from every verification of a task on this target. The measurement's `report.md` holds the full output.",
        "",
        "- `test/b.test.ts`: fail. fails run alone (exit 1)",
        "  > Error: boom",
        "",
        "## Flaky: listed, not excluded",
        "",
        "- `test/c.test.ts`: flaky. fails run alone (exit 1) on its first run, but passed a second run in a fresh container: listed, not excluded",
        "  > Error: once",
        "",
      ].join("\n"),
    )
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-vitest-command.test.ts test/target-measure-classify.test.ts`
Expected: FAIL (`listArgv` not exported; module not found).

- [ ] **Step 3: Implement**

Append to `src/lib/targets/vitest-command.ts`:

```ts
/** `file` run alone: the base and the file. The scope and the excludes do not apply to it. */
export function perFileArgv(command: VitestCommand, file: string): string[] {
  return [...command.base, file]
}

/**
 * `vitest list --filesOnly` over what `command` runs, its excludes ignored: `measure` measures
 * every file the config and the scope select, and proposes the excludes from scratch (a
 * person's own additions show as removed in the diff, to be restored by hand if intended).
 */
export function listArgv(command: VitestCommand): string[] {
  const flags = command.base.slice(3)
  return [
    "pnpm",
    "exec",
    "vitest",
    "list",
    "--filesOnly",
    ...(flags[0] === "run" ? flags.slice(1) : flags),
    ...command.files,
  ]
}
```

`src/lib/targets/measure/classify.ts`:

```ts
import type { TargetManifest, TargetRecipe } from "../catalog.js"

export type Resources = TargetManifest["resources"]

/** One file's per-test counts from vitest's JSON report (`assertionResults`). */
export interface TestCounts {
  readonly passed: number
  readonly failed: number
  readonly skipped: number
}

/** One vitest run in a measurement session, as `MeasureSession.vitest` reports it. */
export interface VitestRun {
  readonly exitCode: number
  /** stdout then stderr, the JSON report cut off. */
  readonly output: string
  /** The sandbox's per-command timeout fired (exit 124). */
  readonly timedOut: boolean
  /** The files the JSON report names, relative to the command directory; null with no report. */
  readonly files:
    | readonly { readonly file: string; readonly passed: boolean; readonly tests: TestCounts }[]
    | null
  readonly ms: number
}

/**
 * `fail`, `hang`, `killed` and `writes` are proposed for exclusion; `flaky` (a non-pass whose
 * second run, in a fresh container, disagreed) is listed and never proposed (plan D11).
 */
export type FileVerdict = "pass" | "fail" | "hang" | "killed" | "writes" | "flaky"
export const EXCLUDED: ReadonlySet<FileVerdict> = new Set(["fail", "hang", "killed", "writes"])

export interface FileMeasurement {
  readonly file: string
  readonly verdict: FileVerdict
  readonly reason: string
  /** The run's output tail: empty for a pass, the evidence a reviewer reads otherwise. */
  readonly output: string
  readonly ms: number
  /** What the run changed in the workspace, whatever its verdict. */
  readonly changed: readonly string[]
  /** Per-test counts, when vitest reported them. */
  readonly tests?: TestCounts
  /** Paths the run could not find that exist at the pin: what the capture left out. */
  readonly omissions: readonly string[]
}

export interface SuiteSample {
  readonly buildMs: number
  readonly suiteMs: number
  /** From opening the session to closing it: capture, start, build, two snapshots, the suite. */
  readonly sessionMs: number
  readonly memoryPeakBytes: number
}

export interface Measurement {
  readonly files: readonly FileMeasurement[]
  readonly excludes: readonly string[]
  /** The proposed `commands.test`. */
  readonly test: readonly string[]
  readonly samples: readonly SuiteSample[]
  /** From the samples alone (`proposeResources`). */
  readonly measured: Resources
  /** The target's resources before this measurement; undefined for placeholders. */
  readonly prior: Resources | undefined
  /** What is proposed: `settleResources(measured, prior, allowDecrease)`, confirmed by a run at these values. */
  readonly resources: Resources
  readonly confirmation: SuiteSample
}

export interface MeasureLimits {
  readonly fileTimeoutMs: number
  readonly memoryMb: number
}

/** Something about the harness or the target, not a verdict on a test file: `measure` stops. */
export class MeasureError extends Error {
  /** The files measured before the stop, when the per-file phase got that far. */
  files: readonly FileMeasurement[] | undefined
  /** A partial report of those files, which `measureTarget` renders for the script to write. */
  report: string | undefined
  constructor(
    message: string,
    readonly output = "",
  ) {
    super(message)
    this.name = "MeasureError"
  }
}

export const OUTPUT_LIMIT = 4_000
const MiB = 1024 * 1024
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes is the point
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
/** The workspace root inside a target's container (every generated Dockerfile's WORKDIR). */
const WORKSPACE = "/workspace/"

/** The last `limit` characters of `text` without terminal escapes: where a failure explains itself. */
export function outputTail(text: string, limit = OUTPUT_LIMIT): string {
  const plain = text.replace(ANSI, "").trimEnd()
  return plain.length <= limit ? plain : `…${plain.slice(-limit)}`
}

/** Paths added, removed or changed between two snapshots, sorted. */
export function changedPaths(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort()
}

/**
 * Workspace paths an `ENOENT` in `output` names that exist at the pin (`existsAtPin`, over
 * repository paths): not a defect of the test but of the capture, said so to the reviewer.
 */
export function captureOmissions(output: string, existsAtPin: (path: string) => boolean): string[] {
  const found = new Set<string>()
  for (const match of output.replace(ANSI, "").matchAll(/ENOENT[^\n]*?'(\/[^'\n]+)'/g)) {
    const absolute = match[1] as string
    if (!absolute.startsWith(WORKSPACE)) continue
    const path = absolute.slice(WORKSPACE.length)
    if (existsAtPin(path)) found.add(path)
  }
  return [...found].sort()
}

const list = (paths: readonly string[]) =>
  `${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ` and ${paths.length - 10} more` : ""}`

/**
 * What one file run alone says about it. `changed` is reported whatever the verdict, so a file
 * that fails AND writes shows both. A run that did not select exactly `file` (vitest's
 * positional argument is a filter), or wrote no report without being killed or timed out, is
 * the harness's failure, not the file's: it throws.
 */
export function classifyFile(
  file: string,
  run: VitestRun,
  changed: readonly string[],
  limits: MeasureLimits,
  existsAtPin: (path: string) => boolean = () => false,
): FileMeasurement {
  const omissions = captureOmissions(run.output, existsAtPin)
  const also = [
    ...(changed.length > 0 ? [`it also changed the workspace: ${list(changed)}`] : []),
    ...(omissions.length > 0
      ? [`capture omission: ${list(omissions)} exist(s) at the pin but not in the capture`]
      : []),
  ]
  const because = (reason: string) => [reason, ...also].join("; ")
  const base = { file, ms: run.ms, output: outputTail(run.output), changed: [...changed], omissions }
  if (run.timedOut)
    return { ...base, verdict: "hang", reason: because(`did not finish within ${limits.fileTimeoutMs} ms run alone`) }
  if (run.files === null && run.exitCode === 137)
    return {
      ...base,
      verdict: "killed",
      reason: because(`was killed (exit 137; the session's memory limit was ${limits.memoryMb} MB)`),
    }
  if (run.files === null)
    throw new MeasureError(
      `vitest wrote no report for ${file} (exit ${run.exitCode}): a harness failure, not a verdict on the file`,
      run.output,
    )
  const named = run.files.map((f) => f.file)
  if (named.length !== 1 || named[0] !== file)
    throw new MeasureError(
      `The run of ${file} alone reported ${JSON.stringify(named)}: vitest's positional argument is a filter, and it must select exactly this file`,
      run.output,
    )
  const tests = run.files[0]?.tests
  const counted = { ...base, ...(tests !== undefined ? { tests } : {}) }
  if (run.exitCode !== 0 || run.files[0]?.passed !== true)
    return { ...counted, verdict: "fail", reason: because(`fails run alone (exit ${run.exitCode})`) }
  if (changed.length > 0)
    return {
      ...counted,
      verdict: "writes",
      reason: [
        `passes, but changes the workspace, which the verifier refuses as tampering: ${list(changed)}`,
        ...also.slice(1),
      ].join("; "),
    }
  return { ...counted, verdict: "pass", reason: "passes run alone", output: "" }
}

/**
 * A file's two runs, the second in a fresh container, as one verdict: a non-pass the second
 * run contradicts is `flaky` (listed, never excluded); two non-passes keep the first verdict.
 */
export function settleFile(first: FileMeasurement, second: FileMeasurement): FileMeasurement {
  if (first.verdict === "pass") return first
  if (second.verdict === "pass")
    return {
      ...first,
      verdict: "flaky",
      reason: `${first.reason} on its first run, but passed a second run in a fresh container: listed, not excluded`,
    }
  return { ...first, reason: `${first.reason} (a second run in a fresh container: ${second.verdict})` }
}

const roundUp = (value: number, step: number) => Math.ceil(value / step) * step

/** Resources from the worst of every whole-suite sample (plan D12). */
export function proposeResources(samples: readonly SuiteSample[], cpus: number): Resources {
  if (samples.length === 0) throw new Error("There is no suite sample to propose resources from")
  const peakMiB = Math.max(...samples.map((s) => s.memoryPeakBytes)) / MiB
  const slowest = Math.max(...samples.flatMap((s) => [s.buildMs, s.suiteMs]))
  const session = Math.max(...samples.map((s) => s.sessionMs))
  return {
    memoryMb: Math.max(512, roundUp(2 * peakMiB, 256)),
    cpus,
    commandTimeoutMs: Math.max(60_000, roundUp(8 * slowest, 10_000)),
    verifierDeadlineMs: Math.max(120_000, roundUp(2 * 2.5 * session, 60_000)),
  }
}

/**
 * What is proposed (plan D12): never below the target's own resources unless the person asks
 * (`allowDecrease`), because one host's measurement is not every host's (rung 2 measured 369
 * MiB on devkit where the prototype measured 181). Placeholders are no prior (`prior` undefined).
 */
export function settleResources(
  measured: Resources,
  prior: Resources | undefined,
  allowDecrease: boolean,
): Resources {
  if (prior === undefined || allowDecrease) return measured
  return {
    memoryMb: Math.max(measured.memoryMb, prior.memoryMb),
    cpus: Math.max(measured.cpus, prior.cpus),
    commandTimeoutMs: Math.max(measured.commandTimeoutMs, prior.commandTimeoutMs),
    verifierDeadlineMs: Math.max(measured.verifierDeadlineMs, prior.verifierDeadlineMs),
  }
}

/** The first lines of `output` that say what went wrong, without durations: for measurement.md. */
export function errorLines(output: string, count = 3): string[] {
  const lines = output
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.trim().replace(/\s+\d+(?:\.\d+)?m?s$/, ""))
    .filter((line) => /\b(?:\w*Error|ENOENT|EACCES|ECONNREFUSED|Command timed out)\b/.test(line))
  return [...new Set(lines)].slice(0, count)
}

const fenceFor = (text: string) =>
  "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((r) => r[0].length + 1)))

/** The per-file part of a report: also what a stopped measurement writes (a partial report). */
export function renderFiles(files: readonly FileMeasurement[]): string[] {
  const passed = files.filter((f) => f.verdict === "pass").length
  const excluded = files.filter((f) => EXCLUDED.has(f.verdict)).length
  const lines = [
    `## Files: ${files.length}, ${passed} pass, ${excluded} proposed for exclusion, ${files.filter((f) => f.verdict === "flaky").length} flaky`,
    "",
    ...files.map(
      (f) =>
        `- \`${f.file}\`: ${f.verdict} (${f.ms} ms${f.tests ? `; tests ${f.tests.passed} passed, ${f.tests.failed} failed, ${f.tests.skipped} skipped` : ""})`,
    ),
    "",
  ]
  for (const f of files.filter((f) => f.verdict !== "pass")) {
    const fence = fenceFor(f.output)
    lines.push(`### \`${f.file}\`: ${f.verdict}`, "", f.reason, "", fence, f.output, fence, "")
  }
  return lines
}

/** The evidence a person reads before accepting the proposal: `report.md`. */
export function renderReport(input: {
  readonly target: Pick<TargetRecipe, "id" | "pin">
  readonly image: { readonly localId: string; readonly tag: string }
  readonly measurement: Measurement
  readonly limits: MeasureLimits
  readonly notes?: readonly string[]
}): string {
  const { target, image, measurement: m, limits } = input
  const row = (name: keyof Resources) =>
    `| ${name} | ${m.prior?.[name] ?? "(placeholder)"} | ${m.measured[name]} | ${m.resources[name]} |`
  const lines = [
    `# target:measure ${target.id} at ${target.pin}`,
    "",
    `Image ${image.localId} (${image.tag}), the network denied. Each test file ran alone (${limits.fileTimeoutMs} ms, ${limits.memoryMb} MB), and each non-pass once more in a fresh container; the suite with the proposed excludes then ran ${m.samples.length} time(s), each in a fresh container, and once more at the proposed resources.`,
    "",
    ...(input.notes ?? []).flatMap((note) => [`> ${note}`, ""]),
    ...renderFiles(m.files),
    "## The suite with the proposed excludes",
    "",
    "| run | build ms | suite ms | session ms | memory.peak MiB |",
    "|---|---|---|---|---|",
    ...[...m.samples, m.confirmation].map(
      (s, i) =>
        `| ${i < m.samples.length ? i + 1 : "at the proposed resources"} | ${s.buildMs} | ${s.suiteMs} | ${s.sessionMs} | ${Math.ceil(s.memoryPeakBytes / MiB)} |`,
    ),
    "",
    "## Resources",
    "",
    "| field | before | measured | proposed |",
    "|---|---|---|---|",
    row("memoryMb"),
    row("cpus"),
    row("commandTimeoutMs"),
    row("verifierDeadlineMs"),
    "",
    "Measured: memoryMb is twice the highest memory.peak, rounded up to 256 MiB, at least 512 (memory.peak includes page cache, so it errs high); cpus is what the sessions ran with; commandTimeoutMs is eight times the slower of the build and the suite, rounded up to 10 s, at least 60 s; verifierDeadlineMs is two sessions (visible and independent) at 2.5 times the slowest, rounded up to a minute, at least 2 minutes. Proposed: never below before unless --allow-decrease, and confirmed by a whole-suite run at exactly these values.",
    "",
  ]
  return lines.join("\n")
}

/**
 * `targets/<id>/measurement.md`: why each file is excluded, committed and reviewed with
 * `target.json` (plan D2). Deterministic across hosts and runs: no timings, no image ids.
 */
export function renderMeasurementRecord(id: string, files: readonly FileMeasurement[]): string {
  const excluded = files.filter((f) => EXCLUDED.has(f.verdict))
  const flaky = files.filter((f) => f.verdict === "flaky")
  const entry = (f: FileMeasurement) => [
    `- \`${f.file}\`: ${f.verdict}. ${f.reason.replace(/ \(\d+ ms\)/g, "")}`,
    ...errorLines(f.output).map((line) => `  > ${line}`),
  ]
  return `${[
    `# Measured excludes: ${id}`,
    "",
    "Written by `target:measure --write` and reviewed with `target.json`. Each file below is excluded from the target's suite, and so from every verification of a task on this target. The measurement's `report.md` holds the full output.",
    "",
    ...(excluded.length === 0 ? ["No file is excluded: every file passed run alone."] : excluded.flatMap(entry)),
    ...(flaky.length === 0 ? [] : ["", "## Flaky: listed, not excluded", "", ...flaky.flatMap(entry)]),
  ].join("\n")}\n`
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-vitest-command.test.ts test/target-measure-classify.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/vitest-command.ts examples/software-factory/controller/src/lib/targets/measure/classify.ts examples/software-factory/controller/test/target-vitest-command.test.ts examples/software-factory/controller/test/target-measure-classify.test.ts
git commit -m "feat(software-factory): classify a test file run alone and propose resources from suite samples

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (review-driven, with small changes to Task 14's `measure.ts`). Test output reaches `report.md`, `measurement.md` and the printed diff only through one `sanitize()` (used by `outputTail` and `errorLines`): every escape sequence (CSI with any parameter and intermediate bytes, 7-bit or C1; OSC ending in BEL or ST; DCS/SOS/PM/APC strings; single-character escapes such as `ESC M`) and every C0/C1 control but `\n` and `\t` are stripped (a NUL made git show `measurement.md` as binary; `\r` and OSC links rewrote what a terminal shows), and `<` is escaped (`<!--` hid the rest of a rendered page). Workspace paths in a `reason` are JSON-quoted with `<` escaped, so a path holding a newline cannot inject a heading; `measureSuite` refuses a listed file name holding a control character. The error lines in `measurement.md` are code spans (`codeSpan`, whatever backticks they hold). `classifyFile` drops its `limits` parameter: a hang or kill reason names the option (`--file-timeout-ms`, `--memory-mb`), not its value, so the committed record does not change with the run's limits; the report's header still states them. A second run's verdict and the paths only it changed move from `reason` to a new `secondRun` field that the report prints and the record does not; the record sorts its entries by file, and the dead `/ \(\d+ ms\)/g` strip is gone. Exit 0 with the file reported as not passed throws `MeasureError` (a contradiction is the harness's), never an exclude. `proposeResources` throws `MeasureError` unless every sample field and `cpus` is a finite positive number; `settleResources` treats placeholder resources as no prior however passed. `captureOmissions` normalises each path (`posix.normalize`), ignores `/workspace` itself and paths leaving it, and still names only paths that exist at the pin. A `MeasureError` in the first per-file pass now carries the files measured so far (`MeasureError.files`), for the partial report. Guard tests bind each by mutation: a report naming one different file, exit 0 with the file failed, `settleResources` lowering `cpus` or `commandTimeoutMs`, an exit 137 with a report (fail, not killed), placeholder priors, and the 512 MiB memory floor. Not solved: a file that writes a differently named temporary path on every run still changes the `writes` or "also changed" paths its record entry lists.

### Task 14: `measureSuite` over sessions

The orchestration is pure over an injected `OpenSession`, so every rule (the list, one file at a time, a fresh container after a hang, the suite samples, every stop) is tested without Docker. Task 15 supplies the Docker sessions.

**Files:**
- Create: `controller/src/lib/targets/measure/session.ts` (types only in this task)
- Create: `controller/src/lib/targets/measure/measure.ts`
- Create: `controller/test/fake-measure-session.ts`
- Test: `controller/test/target-measure-suite.test.ts`

- [ ] **Step 1: Write the session types**

`src/lib/targets/measure/session.ts` (Task 15 adds `dockerSessions` below these):

```ts
import type { VitestRun } from "./classify.js"

/**
 * One container session over a fresh capture of the target, in the verifier's shape: the
 * target's image by id, the network denied, the workspace inspected as the verifier inspects it.
 */
export interface MeasureSession {
  /** The target's build (`commands.build`) from its command directory. */
  build(): Promise<{ readonly ok: boolean; readonly output: string; readonly ms: number }>
  /** The files a `vitest list --filesOnly` argv lists, relative to the command directory, sorted. */
  listFiles(argv: readonly string[]): Promise<string[]>
  /** A vitest argv run with a JSON report attached. */
  vitest(argv: readonly string[]): Promise<VitestRun>
  /** The workspace's files and digests, as the verifier's tamper check sees them. */
  snapshot(): Promise<Readonly<Record<string, string>>>
  /** The container's cgroup v2 `memory.peak`, in bytes. */
  memoryPeakBytes(): Promise<number>
}

export interface SessionLimits {
  readonly memoryMb: number
  readonly cpus: number
  /** The sandbox's per-command timeout. */
  readonly commandTimeoutMs: number
}

/** Open a session with `limits`, run `use` in it, and tear it down whatever happens. */
export type OpenSession = <T>(
  limits: SessionLimits,
  use: (session: MeasureSession) => Promise<T>,
) => Promise<T>
```

- [ ] **Step 2: Write the fake and the failing tests**

`test/fake-measure-session.ts`:

```ts
import type { VitestRun } from "../src/lib/targets/measure/classify.ts"
import type { MeasureSession, OpenSession, SessionLimits } from "../src/lib/targets/measure/session.ts"

export interface FakeFile {
  readonly exitCode?: number
  readonly timedOut?: boolean
  /** Paths the run writes into the workspace. */
  readonly writes?: readonly string[]
  readonly ms?: number
  /** The files the run's report names; the file itself when absent. */
  readonly reports?: readonly string[]
  /** Fails its first run only (exit 1), then passes. */
  readonly flakyOnce?: boolean
}

export interface FakeScript {
  readonly files: Readonly<Record<string, FakeFile>>
  readonly build?: { readonly ok: boolean; readonly output?: string }
  readonly suite?: {
    readonly exitCode?: number
    readonly writes?: readonly string[]
    readonly ms?: number
    /** Killed (exit 137) in a session with less memory than this. */
    readonly minMemoryMb?: number
  }
  readonly peakBytes?: number
}

const COUNTS = { passed: 1, failed: 0, skipped: 0 }

/**
 * Sessions over a scripted suite. A vitest argv naming exactly one of the script's files as a
 * positional (and no --exclude) is that file's run; anything else is the whole suite. Tests
 * with a scope therefore scope at least two files. `sessionOf` records, per vitest run, the
 * number of the session it ran in (1-based).
 */
export function fakeSessions(script: FakeScript) {
  const opened: SessionLimits[] = []
  const commands: string[][] = []
  const sessionOf: { readonly argv: readonly string[]; readonly session: number }[] = []
  const calls = new Map<string, number>()
  const names = Object.keys(script.files).sort()
  const open: OpenSession = async (limits, use) => {
    opened.push(limits)
    const session = opened.length
    let workspace: Record<string, string> = { "packages/app/src/index.ts": "v0" }
    let version = 0
    const write = (paths: readonly string[] = []) => {
      for (const path of paths) workspace = { ...workspace, [path]: `v${++version}` }
    }
    const measure: MeasureSession = {
      build: async () => ({ ok: script.build?.ok ?? true, output: script.build?.output ?? "built", ms: 1_000 }),
      listFiles: async (argv) => {
        commands.push([...argv])
        return [...names]
      },
      vitest: async (argv): Promise<VitestRun> => {
        commands.push([...argv])
        sessionOf.push({ argv: [...argv], session })
        const positional = argv.filter((arg, i) => names.includes(arg) && argv[i - 1] !== "--exclude")
        const file = positional.length === 1 && !argv.includes("--exclude") ? positional[0] : undefined
        if (file === undefined) {
          write(script.suite?.writes)
          const killed = script.suite?.minMemoryMb !== undefined && limits.memoryMb < script.suite.minMemoryMb
          return {
            exitCode: killed ? 137 : (script.suite?.exitCode ?? 0),
            output: "suite output",
            timedOut: false,
            files: [],
            ms: script.suite?.ms ?? 9_000,
          }
        }
        const scripted = script.files[file] as FakeFile
        const call = (calls.get(file) ?? 0) + 1
        calls.set(file, call)
        write(scripted.writes)
        if (scripted.timedOut)
          return { exitCode: 124, output: `${file} hung\nCommand timed out after 180s`, timedOut: true, files: null, ms: scripted.ms ?? 180_000 }
        const exitCode = scripted.flakyOnce ? (call === 1 ? 1 : 0) : (scripted.exitCode ?? 0)
        return {
          exitCode,
          output: `${file} output\nError: scripted`,
          timedOut: false,
          files: (scripted.reports ?? [file]).map((name) => ({ file: name, passed: exitCode === 0, tests: COUNTS })),
          ms: scripted.ms ?? 2_000,
        }
      },
      snapshot: async () => ({ ...workspace }),
      memoryPeakBytes: async () => script.peakBytes ?? 400 * 1024 * 1024,
    }
    return await use(measure)
  }
  return { open, opened, commands, sessionOf }
}
```

`test/target-measure-suite.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import type { TargetRecipe } from "../src/lib/targets/catalog.ts"
import { MeasureError } from "../src/lib/targets/measure/classify.ts"
import { type MeasureSuiteOptions, measureSuite } from "../src/lib/targets/measure/measure.ts"
import { type FakeScript, fakeSessions } from "./fake-measure-session.ts"

const BASE = ["pnpm", "exec", "vitest", "--run", "--no-cache", "--config", "vitest.config.ts"]
const FILE_LIMITS = { memoryMb: 4096, cpus: 2, commandTimeoutMs: 180_000 }
const recipe = (test: readonly string[] = BASE): Pick<TargetRecipe, "id" | "commands"> => ({
  id: "app",
  commands: { cwd: "packages/app", build: ["pnpm", "exec", "tsc", "-b", "tsconfig.json"], test: [...test], nodeTestExecArgv: [] },
})
/** A clock that advances 30 s per reading: every sampled session lasts 30 s. */
const clock = () => {
  let t = 0
  return () => (t += 30_000)
}
const measure = (
  script: FakeScript,
  test?: readonly string[],
  extra: Partial<MeasureSuiteOptions> = {},
) => {
  const fake = fakeSessions(script)
  return {
    fake,
    result: measureSuite({
      recipe: recipe(test),
      open: fake.open,
      fileTimeoutMs: 180_000,
      memoryMb: 4096,
      cpus: 2,
      runs: 1,
      allowDecrease: false,
      now: clock(),
      ...extra,
    }),
  }
}

describe("measureSuite", () => {
  it("runs each file alone, re-runs each non-pass, proposes an exclude per fail, hang or write, then samples and confirms the suite", async () => {
    const { fake, result } = measure({
      files: {
        "test/a.test.ts": {},
        "test/b.test.ts": { timedOut: true },
        "test/c.test.ts": { exitCode: 1 },
        "test/d.test.ts": { writes: ["packages/app/test/out.json"] },
      },
    })
    const m = await result
    expect(m.files.map((f) => [f.file, f.verdict])).toEqual([
      ["test/a.test.ts", "pass"],
      ["test/b.test.ts", "hang"],
      ["test/c.test.ts", "fail"],
      ["test/d.test.ts", "writes"],
    ])
    expect(m.excludes).toEqual(["test/b.test.ts", "test/c.test.ts", "test/d.test.ts"])
    expect(m.test).toEqual([
      ...BASE,
      "--exclude", "test/b.test.ts",
      "--exclude", "test/c.test.ts",
      "--exclude", "test/d.test.ts",
    ])
    // Two file sessions (fresh after the hang; d's write ends the second), three re-runs, one
    // suite sample, one confirmation at the proposed resources.
    expect(fake.opened).toEqual([
      FILE_LIMITS, FILE_LIMITS, FILE_LIMITS, FILE_LIMITS, FILE_LIMITS, FILE_LIMITS,
      { memoryMb: 1024, cpus: 2, commandTimeoutMs: 80_000 },
    ])
    expect(fake.commands[0]).toEqual([
      "pnpm", "exec", "vitest", "list", "--filesOnly", "--run", "--no-cache", "--config", "vitest.config.ts",
    ])
    expect(fake.commands.at(-1)).toEqual(m.test)
    expect(m.samples).toEqual([{ buildMs: 1_000, suiteMs: 9_000, sessionMs: 30_000, memoryPeakBytes: 400 * 1024 * 1024 }])
    expect(m.measured).toEqual({ memoryMb: 1024, cpus: 2, commandTimeoutMs: 80_000, verifierDeadlineMs: 180_000 })
    expect(m.resources).toEqual(m.measured)
    expect(m.confirmation.sessionMs).toBe(30_000)
  })

  it("gives the next file a fresh container after a file that writes, and reports a failing file's writes", async () => {
    const { fake, result } = measure({
      files: {
        "test/a.test.ts": { exitCode: 1, writes: ["packages/app/tmp.txt"] },
        "test/b.test.ts": {},
        "test/c.test.ts": {},
      },
    })
    const m = await result
    const sessionOf = (file: string) => fake.sessionOf.find((run) => run.argv.at(-1) === file)?.session
    expect(sessionOf("test/a.test.ts")).toBe(1)
    expect(sessionOf("test/b.test.ts")).toBe(2)
    expect(sessionOf("test/c.test.ts")).toBe(2)
    const a = m.files[0]
    expect(a?.verdict).toBe("fail")
    expect(a?.changed).toEqual(["packages/app/tmp.txt"])
    expect(a?.reason).toContain("it also changed the workspace: packages/app/tmp.txt")
  })

  it("lists a file that fails once and then passes as flaky, and does not exclude it", async () => {
    const { result } = measure({ files: { "test/a.test.ts": { flakyOnce: true }, "test/b.test.ts": {} } })
    const m = await result
    expect(m.files.map((f) => f.verdict)).toEqual(["flaky", "pass"])
    expect(m.excludes).toEqual([])
    expect(m.test).toEqual(BASE)
  })

  it("never proposes below the target's own resources unless asked, and confirms at what it proposes", async () => {
    const prior = { memoryMb: 2048, cpus: 2, commandTimeoutMs: 120_000, verifierDeadlineMs: 3_600_000 }
    const kept = measure({ files: { "test/a.test.ts": {} } }, BASE, { prior })
    expect((await kept.result).resources).toEqual(prior)
    expect(kept.fake.opened.at(-1)).toEqual({ memoryMb: 2048, cpus: 2, commandTimeoutMs: 120_000 })
    const shrunk = measure({ files: { "test/a.test.ts": {} } }, BASE, { prior, allowDecrease: true })
    expect((await shrunk.result).resources).toEqual({ memoryMb: 1024, cpus: 2, commandTimeoutMs: 80_000, verifierDeadlineMs: 180_000 })
  })

  it("refuses a proposal that does not hold when tried, keeping the files for a partial report", async () => {
    const { result } = measure({ files: { "test/a.test.ts": {}, "test/b.test.ts": { exitCode: 1 } }, suite: { minMemoryMb: 2000 } })
    const error = await result.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MeasureError)
    expect((error as MeasureError).message).toMatch(/the proposed resources did not hold/)
    expect((error as MeasureError).files?.map((f) => f.verdict)).toEqual(["pass", "fail"])
  })

  it("keeps a scope, and samples the suite as many times as asked, each in a fresh container", async () => {
    const scope = ["test/a.test.ts", "test/b.test.ts"]
    const { fake, result } = measure(
      { files: { "test/a.test.ts": {}, "test/b.test.ts": { exitCode: 1 } } },
      [...BASE, ...scope],
      { runs: 3 },
    )
    const m = await result
    expect(fake.commands[0]?.slice(-2)).toEqual(scope)
    expect(m.test).toEqual([...BASE, ...scope, "--exclude", "test/b.test.ts"])
    expect(m.samples).toHaveLength(3)
    // One file session, b's re-run, three samples, one confirmation.
    expect(fake.opened).toHaveLength(6)
  })

  it("stops, proposing nothing, when the harness or the target is at fault", async () => {
    await expect(
      measure({ files: { "test/a.test.ts": { reports: ["test/x/test/a.test.ts"] } } }).result,
    ).rejects.toThrow(/must select exactly this file/)
    await expect(
      measure({ files: { "test/a.test.ts": {} }, build: { ok: false, output: "TS2307" } }).result,
    ).rejects.toThrow(/target's build fails in its own image/)
    await expect(
      measure({ files: { "test/a.test.ts": {} }, suite: { exitCode: 1 } }).result,
    ).rejects.toThrow(/The suite with the proposed excludes failed \(exit 1\) on run 1/)
    await expect(
      measure({ files: { "test/a.test.ts": {} }, suite: { writes: ["packages/app/x"] } }).result,
    ).rejects.toThrow(/changed the workspace \(packages\/app\/x\)/)
    await expect(measure({ files: { "test/a.test.ts": { exitCode: 1 } } }).result).rejects.toThrow(
      /no test file passes run alone/,
    )
    await expect(measure({ files: {} }).result).rejects.toThrow(MeasureError)
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-measure-suite.test.ts`
Expected: FAIL (`measure.ts` not found).

- [ ] **Step 4: Implement**

`src/lib/targets/measure/measure.ts`:

```ts
import type { TargetRecipe } from "../catalog.js"
import { listArgv, parseVitestCommand, perFileArgv, withExcludes } from "../vitest-command.js"
import {
  changedPaths,
  classifyFile,
  EXCLUDED,
  type FileMeasurement,
  MeasureError,
  type Measurement,
  proposeResources,
  type Resources,
  type SuiteSample,
  settleFile,
  settleResources,
} from "./classify.js"
import type { MeasureSession, OpenSession, SessionLimits } from "./session.js"

export interface MeasureSuiteOptions {
  readonly recipe: Pick<TargetRecipe, "id" | "commands">
  readonly open: OpenSession
  readonly fileTimeoutMs: number
  readonly memoryMb: number
  readonly cpus: number
  readonly runs: number
  /** The target's resources before this measurement; undefined when they are placeholders. */
  readonly prior?: Resources
  /** Propose below `prior` when the measurement says so (plan D12). */
  readonly allowDecrease: boolean
  /** Does a repository path exist at the measured pin? Names capture omissions (plan D11). */
  readonly existsAtPin?: (path: string) => boolean
  readonly log?: (line: string) => void
  readonly now?: () => number
}

async function buildOrThrow(session: MeasureSession) {
  const build = await session.build()
  if (!build.ok)
    throw new MeasureError(
      "The target's build fails in its own image: a defect of the target (its Dockerfile, capture or build command) to fix before anything is measured, not a test to exclude",
      build.output,
    )
  return build
}

/** One file alone in `session`, snapshotted before and after with the verifier's options. */
async function measureFile(
  session: MeasureSession,
  file: string,
  argv: readonly string[],
  options: MeasureSuiteOptions,
): Promise<FileMeasurement> {
  const before = await session.snapshot()
  const run = await session.vitest(argv)
  const after = await session.snapshot()
  return classifyFile(file, run, changedPaths(before, after), options, options.existsAtPin)
}

/** The whole `test` in a fresh session at `limits`: a sample, or a stop with the suite's output. */
async function sampleSuite(
  open: OpenSession,
  limits: SessionLimits,
  test: readonly string[],
  now: () => number,
  what: string,
): Promise<SuiteSample> {
  const started = now()
  const sample = await open(limits, async (session) => {
    const build = await buildOrThrow(session)
    const before = await session.snapshot()
    const suite = await session.vitest(test)
    const changed = changedPaths(before, await session.snapshot())
    const failure = suite.timedOut
      ? `did not finish within ${limits.commandTimeoutMs} ms`
      : suite.exitCode !== 0
        ? `failed (exit ${suite.exitCode})`
        : changed.length > 0
          ? `changed the workspace (${changed.slice(0, 10).join(", ")})`
          : undefined
    if (failure !== undefined)
      throw new MeasureError(`The suite with the proposed excludes ${failure} ${what}`, suite.output)
    return { buildMs: build.ms, suiteMs: suite.ms, memoryPeakBytes: await session.memoryPeakBytes() }
  })
  return { ...sample, sessionMs: Math.round(now() - started) }
}

/**
 * Every file the target's vitest command lists, run alone in the verifier's session shape and
 * classified; each non-pass run once more in a fresh container (plan D11). Then the whole suite
 * with the proposed excludes, `runs` times in fresh containers, for the measured resources, and
 * once more at the resources proposed (plan D12). Throws `MeasureError`, proposing nothing,
 * when the fault is the harness's or the target's rather than a file's; after the per-file
 * phase the error carries the files measured, for a partial report.
 */
export async function measureSuite(options: MeasureSuiteOptions): Promise<Measurement> {
  const { recipe, open } = options
  const log = options.log ?? (() => {})
  const now = options.now ?? (() => performance.now())
  const command = parseVitestCommand(recipe.commands.test)
  const limits = { memoryMb: options.memoryMb, cpus: options.cpus, commandTimeoutMs: options.fileTimeoutMs }

  // Phase 1: each file alone. A file that changed the workspace, hung or was killed leaves
  // the container dirty or busy, so the next file gets a fresh one.
  const queue: { files: string[] | null } = { files: null }
  const first: FileMeasurement[] = []
  while (queue.files === null || queue.files.length > 0) {
    await open(limits, async (session) => {
      await buildOrThrow(session)
      if (queue.files === null) {
        const listed = await session.listFiles(listArgv(command))
        if (listed.length === 0) throw new MeasureError(`vitest lists no test file for ${recipe.id}'s command`)
        log(`${listed.length} test files`)
        queue.files = listed
      }
      const pending = queue.files
      for (let file = pending.shift(); file !== undefined; file = pending.shift()) {
        const result = await measureFile(session, file, perFileArgv(command, file), options)
        first.push(result)
        log(`${result.verdict.padEnd(6)} ${file} (${result.ms} ms)`)
        if (result.changed.length > 0 || result.verdict === "hang" || result.verdict === "killed") return
      }
    })
  }

  const files: FileMeasurement[] = []
  try {
    // Phase 2: each non-pass once more, alone in a fresh container; a disagreement is flaky.
    for (const result of first) {
      if (result.verdict === "pass") {
        files.push(result)
        continue
      }
      const again = await open(limits, async (session) => {
        await buildOrThrow(session)
        return await measureFile(session, result.file, perFileArgv(command, result.file), options)
      })
      const settled = settleFile(result, again)
      files.push(settled)
      log(`${settled.verdict.padEnd(6)} ${result.file} (second run: ${again.verdict})`)
    }

    const excludes = files
      .filter((m) => EXCLUDED.has(m.verdict))
      .map((m) => m.file)
      .sort()
    if (excludes.length === files.length)
      throw new MeasureError(
        `no test file passes run alone (${files.length} measured): there is no suite to propose resources for; read each file's output in the report`,
      )
    const test = withExcludes(command, excludes)

    // Phase 3: the suite, for the measured resources.
    const passingMs = files.filter((m) => m.verdict === "pass").reduce((sum, m) => sum + m.ms, 0)
    const suiteLimits = { ...limits, commandTimeoutMs: Math.max(options.fileTimeoutMs, 2 * passingMs) }
    const samples: SuiteSample[] = []
    for (let run = 1; run <= options.runs; run++) {
      const sample = await sampleSuite(open, suiteLimits, test, now, `on run ${run}: no resources are proposed for a suite that does not pass`)
      samples.push(sample)
      log(`suite run ${run}: ${JSON.stringify(sample)}`)
    }
    const measured = proposeResources(samples, options.cpus)
    const resources = settleResources(measured, options.prior, options.allowDecrease)

    // Phase 4: the proposal, tried. A verification session must also fit twice in the deadline.
    const confirmation = await sampleSuite(
      open,
      { memoryMb: resources.memoryMb, cpus: resources.cpus, commandTimeoutMs: resources.commandTimeoutMs },
      test,
      now,
      `at the proposed resources ${JSON.stringify(resources)}: the proposed resources did not hold`,
    )
    if (2 * confirmation.sessionMs > resources.verifierDeadlineMs)
      throw new MeasureError(
        `A session at the proposed resources took ${confirmation.sessionMs} ms; two of them do not fit the proposed verifierDeadlineMs ${resources.verifierDeadlineMs}: the proposed resources did not hold`,
      )
    log(`confirmed at ${JSON.stringify(resources)}: ${JSON.stringify(confirmation)}`)
    return {
      files,
      excludes,
      test,
      samples,
      measured,
      prior: options.prior,
      resources,
      confirmation,
    }
  } catch (error) {
    // Settled where phase 2 reached, first runs after that.
    if (error instanceof MeasureError) error.files = [...files, ...first.slice(files.length)]
    throw error
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-measure-suite.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/measure/session.ts examples/software-factory/controller/src/lib/targets/measure/measure.ts examples/software-factory/controller/test/fake-measure-session.ts examples/software-factory/controller/test/target-measure-suite.test.ts
git commit -m "feat(software-factory): measure a target's suite file by file, then as a whole

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (review-driven; commits `a8b567ebb`, `a6d15df16`, and the review-fix commit after `cc1abc372`). The listing runs in a session of its own, so the first file starts from the verifier's state (not from whatever `vitest list` left); files are then run alone, and a file that passed keeps the container: its `/tmp` files and stray processes carry to the next file, which is bounded because the workspace is compared around every file, a non-pass is re-run alone in a fresh container, and the proposed suite is then sampled whole in fresh containers. A suite sample or the confirmation must be graded `pass` by the verifier's own `gradeVitestReport(exitCode, report, [])`, not merely exit 0 with the workspace unchanged: a missing report, a report with no totals, or a suite whose tests are all skipped or todo is refused by name (the verifier would grade it `inconclusive` on every verification). A proposed exclude that `withExcludes` cannot write (anything outside `[A-Za-z0-9._/-]`, e.g. `test/[id].test.ts`) is a `MeasureError` naming the file, raised in phase 2 so the partial report keeps every file; each such name is also logged as a note when it is listed. A build killed (137) or timed out (124) in a session says it exceeded that session's limits (the proposed resources, in the confirmation) instead of calling the target defective. Tests added: a `killed` fake file (a fresh session follows), a clock that slows only the confirmation (deleting the `2 × verifierDeadlineMs` refusal reds it), a suite that times out in the samples or only at the proposed resources.

### Task 15: Docker sessions

The real `OpenSession`: the verifier's session machinery (`withWorkspace` over `dockerSandbox` by image id, the target's capture, `inspectWorkspace` with the verifier's options), with the measurement's own limits. Exercised end to end by Task 17's lane; its one pure helper is unit-tested here.

**Files:**
- Modify: `controller/src/lib/targets/measure/session.ts`
- Test: `controller/test/target-measure-session.test.ts`

- [ ] **Step 1: Write the failing test**

`test/target-measure-session.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import type { TargetRecipe } from "../src/lib/targets/catalog.ts"
import { measureTask } from "../src/lib/targets/measure/session.ts"

describe("the task a measurement session captures", () => {
  it("is task-shaped with no defect, and its id is a capture-safe name", () => {
    const recipe = { id: "cli.v2", pin: "a".repeat(40) } as TargetRecipe
    expect(measureTask(recipe)).toEqual({
      id: "measure-cli_v2",
      target: recipe,
      specText: `target:measure of cli.v2 at ${"a".repeat(40)}\n`,
      defectPatch: null,
    })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-measure-session.test.ts`
Expected: FAIL (`measureTask` is not exported).

- [ ] **Step 3: Implement**

Add to the top of `src/lib/targets/measure/session.ts`:

```ts
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { withWorkspace } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { inspectWorkspace } from "@b4run/workspace"
import { shellJoin } from "../../verification/checks-runner.js"
import { captureDirectory } from "../archive.js"
import type { TargetRecipe } from "../catalog.js"
import {
  targetInspectionOptions,
  targetSandboxPolicy,
  targetWorkspace,
  type WorkspaceTask,
} from "../workspace.js"
import { MeasureError, type VitestRun } from "./classify.js"
```

(replacing the existing `import type { VitestRun } from "./classify.js"`), and append:

```ts
/** What a measurement session captures: the target with no task behind it, no defect. */
export function measureTask(recipe: TargetRecipe): WorkspaceTask {
  return {
    id: `measure-${recipe.id.replace(/[^\w-]/g, "_")}`,
    target: recipe,
    specText: `target:measure of ${recipe.id} at ${recipe.pin}\n`,
    defectPatch: null,
  }
}

/**
 * Sessions in `imageId` (by id, never by tag) over a fresh capture of `recipe` each, staged
 * under `stagingRoot` (`FACTORY_STATE_DIR`, never the app root), with the network denied as in
 * every target session and the measurement's own memory, CPUs and per-command timeout.
 */
export function dockerSessions(options: {
  readonly recipe: TargetRecipe
  readonly imageId: string
  readonly stagingRoot: string
  /** The repository the capture is archived from: the one the recipe's pin was read in. */
  readonly repositoryRoot: string
  readonly signal: AbortSignal
}): OpenSession {
  const { recipe, stagingRoot, signal } = options
  const provider = dockerSandbox({ scope: "software-factory-measure", image: options.imageId })
  const task = measureTask(recipe)
  const inspection = targetInspectionOptions(task)
  const cd = recipe.commands.cwd === "." ? "" : `${shellJoin(["cd", recipe.commands.cwd])} && `
  return async (limits, use) => {
    const instance = randomUUID()
    const stateRoot = join(stagingRoot, "measurements", "sessions", randomUUID())
    try {
      return await withWorkspace(
        {
          appRoot: stagingRoot,
          stateRoot,
          provider,
          workspace: targetWorkspace(task, "measure", {
            instance,
            captureRoot: stagingRoot,
            repositoryRoot: options.repositoryRoot,
          }),
          policy: {
            ...targetSandboxPolicy(recipe),
            resources: {
              memoryMb: limits.memoryMb,
              cpus: limits.cpus,
              timeoutMs: limits.commandTimeoutMs,
            },
          },
          signal,
        },
        async (handle) => {
          const shell = async (command: string) => {
            const started = performance.now()
            const result = await handle.exec.runCommand(
              { command },
              { workspaceRoot: handle.workspaceRoot, signal },
            )
            return { ...result, ms: Math.round(performance.now() - started) }
          }
          /** `line`, then a marker and the file at `path`: a report the run's output cannot forge. */
          const withReport = async (line: string, path: string) => {
            const marker = `B4_FACTORY_MEASURE_${randomUUID().replaceAll("-", "")}`
            const result = await shell(
              [`rm -f ${path}`, line, "code=$?", "echo", `echo ${marker}`, `cat ${path} 2>/dev/null`, "exit $code"].join("; "),
            )
            const at = result.stdout.lastIndexOf(`${marker}\n`)
            return {
              ...result,
              output: `${at === -1 ? result.stdout : result.stdout.slice(0, at)}\n${result.stderr}`,
              report: at === -1 ? "" : result.stdout.slice(at + marker.length + 1),
            }
          }
          const prefix = `${handle.workspaceRoot}/${recipe.commands.cwd === "." ? "" : `${recipe.commands.cwd}/`}`
          const relativeFile = (absolute: string) => {
            if (!absolute.startsWith(prefix))
              throw new MeasureError(`vitest named ${absolute}, which is not under ${prefix}`)
            return absolute.slice(prefix.length)
          }
          return await use({
            async build() {
              if (recipe.commands.build.length === 0) return { ok: true, output: "(no build step)\n", ms: 0 }
              const result = await shell(`${cd}${shellJoin(recipe.commands.build)}`)
              return { ok: result.exitCode === 0, output: `${result.stdout}\n${result.stderr}`, ms: result.ms }
            },
            async listFiles(argv) {
              const path = `/tmp/b4-factory-measure-list.${randomUUID()}.json`
              const result = await withReport(`${cd}${shellJoin([...argv, `--json=${path}`])}`, path)
              if (result.exitCode !== 0 || result.report.trim() === "")
                throw new MeasureError(`vitest list failed (exit ${result.exitCode})`, result.output)
              const listed = JSON.parse(result.report) as { readonly file: string }[]
              return listed.map((entry) => relativeFile(entry.file)).sort()
            },
            async vitest(argv): Promise<VitestRun> {
              const path = `/tmp/b4-factory-measure-report.${randomUUID()}.json`
              const result = await withReport(
                `${cd}${shellJoin([...argv, "--reporter=default", "--reporter=json", `--outputFile=${path}`])}`,
                path,
              )
              const report =
                result.report.trim() === ""
                  ? null
                  : (JSON.parse(result.report) as {
                      readonly testResults?: readonly {
                        readonly name: string
                        readonly status: string
                        readonly assertionResults?: readonly { readonly status: string }[]
                      }[]
                    })
              return {
                exitCode: result.exitCode,
                output: result.output,
                timedOut: result.exitCode === 124 && /Command timed out after/.test(result.stderr),
                files:
                  report === null
                    ? null
                    : (report.testResults ?? []).map((t) => {
                        const statuses = (t.assertionResults ?? []).map((a) => a.status)
                        const passed = statuses.filter((status) => status === "passed").length
                        const failed = statuses.filter((status) => status === "failed").length
                        return {
                          file: relativeFile(t.name),
                          passed: t.status === "passed",
                          // skipped, pending and todo alike: tests that did not run
                          tests: { passed, failed, skipped: statuses.length - passed - failed },
                        }
                      }),
                ms: result.ms,
              }
            },
            async snapshot() {
              return (
                await inspectWorkspace(handle, {
                  signal,
                  // The verifier's own limits and options (grade-suite.ts), so a measurement
                  // sees exactly what a verification's tamper check sees.
                  maxEntries: 10_000,
                  maxFileBytes: 2 * 1024 * 1024,
                  maxTotalBytes: 16 * 1024 * 1024,
                  ...inspection,
                })
              ).files
            },
            async memoryPeakBytes() {
              const result = await shell("cat /sys/fs/cgroup/memory.peak")
              const bytes = Number(result.stdout.trim())
              if (result.exitCode !== 0 || !Number.isSafeInteger(bytes) || bytes <= 0)
                throw new MeasureError(
                  `Cannot read this session's cgroup v2 memory.peak (exit ${result.exitCode}): target:measure proposes memory from it and will not guess`,
                  `${result.stdout}\n${result.stderr}`,
                )
              return bytes
            },
          })
        },
      )
    } finally {
      // Settled, never awaited alone: a failed cleanup must not replace the measurement's error.
      await Promise.allSettled([
        rm(stateRoot, { recursive: true, force: true }),
        rm(join(stagingRoot, captureDirectory(task.id, "measure", instance)), { recursive: true, force: true }),
      ])
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-measure-session.test.ts test/target-measure-suite.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/measure/session.ts examples/software-factory/controller/test/target-measure-session.test.ts
git commit -m "feat(software-factory): measurement sessions in the target's image, shaped like the verifier's

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (review-driven; commits `8c2dd6636` and the review-fix commit after `cc1abc372`). `vitest()` also returns the report's raw text (`VitestRun.report`) for the grade above, and `build()` its exit code. The report is read through a per-run nonce path and marker as the verifier's `runVitestSuite` reads it, with the same documented limitation: the nonce is in the run's argv, so a process the run leaves behind can write the report in `/tmp`. **Follow-up** (shared with the verifier): run the tests as a separate uid that cannot reach the report. `test/no-worker-filesystem.test.ts` pins the provider as `dockerSandbox({ scope: "software-factory-measure", image: options.imageId })`, never `images:`.

### Task 16: `measureTarget` and the `target:measure` script

**Files:**
- Modify: `controller/src/lib/targets/measure/measure.ts`
- Create: `controller/scripts/target-measure.ts`
- Modify: `controller/package.json` (scripts)
- Test: `controller/test/target-measure.test.ts`

`measureTarget` passes `measureSuite` the target's own resources as the prior (none when they are the placeholders), a pin reader for capture omissions, and `--allow-decrease`; it proposes `measurement.md` beside `target.json`, notes a `--pin` other than the target's default in the log and the report, and on a `MeasureError` after the per-file phase renders a partial report onto the error for the script to write.

- [ ] **Step 1: Write the failing tests**

`test/target-measure.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { TargetSchema } from "../src/lib/targets/catalog.ts"
import { type ImageRegistry, ImagePrepareError } from "../src/lib/targets/images.ts"
import { EXPECTED_MARKER, expectedPromotedOf, PROMOTED_MARKER } from "../src/lib/targets/init/dockerfile.ts"
import { initTarget } from "../src/lib/targets/init/init.ts"
import { MeasureError } from "../src/lib/targets/measure/classify.ts"
import { measureTarget, parseMeasureArgs } from "../src/lib/targets/measure/measure.ts"
import { formatManifest, writeProposal } from "../src/lib/targets/proposal.ts"
import { fakeSessions } from "./fake-measure-session.ts"
import { cleanupPinRepos, MINI, pinRepo } from "./pin-repo.ts"

const dirs: string[] = []
afterEach(() => {
  cleanupPinRepos()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-measure-"))
  dirs.push(dir)
  return dir
}
const IMAGE = {
  localId: `sha256:${"a".repeat(64)}`,
  platform: "linux/arm64",
  baseManifestDigest: `sha256:${"b".repeat(64)}`,
  dockerfileSha256: "c".repeat(64),
  lockfileSha256: "d".repeat(64),
  pnpmVersion: "10.33.0",
}
const registry = (ensure: ImageRegistry["ensure"]): ImageRegistry => ({
  recorded: () => undefined,
  ensure,
  present: async () => true,
  close: () => {},
})
const built = registry(async () => ({ key: "k".repeat(64), tag: "b4-factory-app:x-y", image: IMAGE }))
/** MINI's `@m/app` generated into a temporary targets directory. */
function generated() {
  const { root, pin } = pinRepo(MINI)
  const targets = temp()
  writeProposal(initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets }).files)
  return { root, pin, targets }
}
const options = (root: string, targets: string) => {
  let t = 0
  return {
    id: "app",
    targetsDir: targets,
    repositoryRoot: root,
    stagingRoot: temp(),
    signal: AbortSignal.timeout(60_000),
    fileTimeoutMs: 180_000,
    memoryMb: 4096,
    runs: 1,
    allowDecrease: false,
    now: () => (t += 30_000),
  }
}

describe("measureTarget", () => {
  it("proposes the promotion set a failed build printed, and writes nothing", async () => {
    const { root, targets } = generated()
    const dockerfile = readFileSync(join(targets, "app", "Dockerfile"), "utf8")
    const log = `#9 0.4 ${PROMOTED_MARKER} commander hono \n#9 0.4 ${EXPECTED_MARKER}  \n`
    const outcome = await measureTarget({
      ...options(root, targets),
      registry: registry(async () => {
        throw new ImagePrepareError("docker build failed", "k".repeat(64), log)
      }),
    })
    if (outcome.kind !== "promotion") throw new Error(`expected a promotion, got ${outcome.kind}`)
    expect(outcome.promoted).toEqual(["commander", "hono"])
    expect(outcome.files).toHaveLength(1)
    expect(outcome.files[0]?.before).toBe(dockerfile)
    expect(expectedPromotedOf(outcome.files[0]?.after ?? "")).toEqual(["commander", "hono"])
    expect(readFileSync(join(targets, "app", "Dockerfile"), "utf8")).toBe(dockerfile)
  })

  it("rethrows a build that failed anywhere else", async () => {
    const { root, targets } = generated()
    await expect(
      measureTarget({
        ...options(root, targets),
        registry: registry(async () => {
          throw new ImagePrepareError("docker build failed", "k".repeat(64), "#7 ERROR: apt-get\n")
        }),
      }),
    ).rejects.toThrow(ImagePrepareError)
  })

  it("proposes the measured test command and resources, formatted, with a record and a report", async () => {
    const { root, pin, targets } = generated()
    const fake = fakeSessions({ files: { "test/app.test.ts": {} } })
    const outcome = await measureTarget({ ...options(root, targets), registry: built, sessions: () => fake.open })
    if (outcome.kind !== "measured") throw new Error(`expected a measurement, got ${outcome.kind}`)
    const after = outcome.files[0]?.after ?? ""
    expect(formatManifest(after)).toBe(after)
    const proposed = TargetSchema.parse(JSON.parse(after))
    expect(proposed.commands.test).toEqual(["pnpm", "exec", "vitest", "--run", "--no-cache", "--config", "vitest.config.ts"])
    // The placeholders are no prior: the measurement is proposed as it is.
    expect(proposed.resources).toEqual({ memoryMb: 1024, cpus: 2, commandTimeoutMs: 80_000, verifierDeadlineMs: 180_000 })
    expect(proposed.pin).toBe(pin)
    expect(outcome.files[1]?.path).toBe(join(targets, "app", "measurement.md"))
    expect(outcome.files[1]?.before).toBeNull()
    expect(outcome.files[1]?.after).toContain("No file is excluded: every file passed run alone.")
    expect(outcome.report).toContain(`# target:measure app at ${pin}`)
  })

  it("keeps measured resources at or above the target's own", async () => {
    const { root, targets } = generated()
    const path = join(targets, "app", "target.json")
    const current = TargetSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    const own = { memoryMb: 1536, cpus: 2, commandTimeoutMs: 60_000, verifierDeadlineMs: 240_000 }
    writeProposal([
      { path, before: null, after: formatManifest(`${JSON.stringify({ ...current, resources: own }, null, 2)}\n`) },
    ])
    const fake = fakeSessions({ files: { "test/app.test.ts": {} } })
    const outcome = await measureTarget({ ...options(root, targets), registry: built, sessions: () => fake.open })
    if (outcome.kind !== "measured") throw new Error(`expected a measurement, got ${outcome.kind}`)
    expect(outcome.measurement.resources).toEqual({ memoryMb: 1536, cpus: 2, commandTimeoutMs: 80_000, verifierDeadlineMs: 240_000 })
    expect(outcome.report).toContain("| memoryMb | 1536 | 1024 | 1536 |")
  })

  it("leaves a partial report on a stop after the per-file phase", async () => {
    const { root, targets } = generated()
    const fake = fakeSessions({ files: { "test/app.test.ts": {} }, suite: { exitCode: 1 } })
    const error = await measureTarget({ ...options(root, targets), registry: built, sessions: () => fake.open }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(MeasureError)
    expect((error as MeasureError).report).toContain("- `test/app.test.ts`: pass")
  })
})

describe("target:measure's arguments", () => {
  it("takes a target, and optionally a pin, a catalog, --write, --allow-decrease and the measurement's limits", () => {
    expect(parseMeasureArgs(["devkit"])).toEqual({
      id: "devkit",
      write: false,
      allowDecrease: false,
      runs: 3,
      fileTimeoutMs: 180_000,
      memoryMb: 4096,
    })
    expect(
      parseMeasureArgs([
        "cli", "--pin", "a".repeat(40), "--targets-dir", "/tmp/t", "--write", "--allow-decrease", "--runs", "1",
        "--file-timeout-ms", "120000", "--memory-mb", "2048", "--cpus", "1.5",
      ]),
    ).toEqual({
      id: "cli",
      pin: "a".repeat(40),
      targetsDir: "/tmp/t",
      write: true,
      allowDecrease: true,
      runs: 1,
      fileTimeoutMs: 120_000,
      memoryMb: 2048,
      cpus: 1.5,
    })
    expect(() => parseMeasureArgs([])).toThrow(/usage: target-measure.ts/)
    expect(() => parseMeasureArgs(["a", "--runs", "0"])).toThrow(/--runs must be a positive integer/)
    expect(() => parseMeasureArgs(["a", "--runs", "1.5"])).toThrow(/--runs must be a positive integer/)
    expect(() => parseMeasureArgs(["a", "--cpus", "0"])).toThrow(/--cpus must be a positive number/)
    expect(() => parseMeasureArgs(["a", "--pin", "abc"])).toThrow(/full lowercase commit sha/)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-measure.test.ts`
Expected: FAIL (`measureTarget` not exported).

- [ ] **Step 3: Implement**

Append to `src/lib/targets/measure/measure.ts` (and merge these imports into its import block):

```ts
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { commitSha, loadTargetRecipe, TargetSchema } from "../catalog.js"
import { type EnsuredImage, type ImageRegistry, ImagePrepareError } from "../images.js"
import { isPlaceholderResources } from "../init/derive.js"
import { promotionMismatch, withExpectedPromoted } from "../init/dockerfile.js"
import { gitPinTree } from "../init/pin-tree.js"
import { type FileProposal, formatManifest, readIfPresent } from "../proposal.js"
import { renderFiles, renderMeasurementRecord, renderReport } from "./classify.js"
import { dockerSessions } from "./session.js"

export interface MeasureTargetOptions {
  readonly id: string
  /** The target's default pin when absent. */
  readonly pin?: string
  readonly targetsDir: string
  readonly repositoryRoot: string
  /** The registry the image is built through: the controller's own `ensure` (plan D2). */
  readonly registry: ImageRegistry
  /** Where captures and session state are staged: `FACTORY_STATE_DIR`, never the app root. */
  readonly stagingRoot: string
  readonly signal: AbortSignal
  readonly fileTimeoutMs: number
  readonly memoryMb: number
  /** The target's own `resources.cpus` when absent. */
  readonly cpus?: number
  readonly runs: number
  /** Propose resources below the target's own (plan D12). */
  readonly allowDecrease: boolean
  readonly log?: (line: string) => void
  readonly now?: () => number
  /** Test seam: the sessions a measurement runs in. `dockerSessions` otherwise. */
  readonly sessions?: (recipe: TargetRecipe, imageId: string) => OpenSession
}

export type MeasureOutcome =
  | {
      readonly kind: "measured"
      readonly pin: string
      readonly image: EnsuredImage
      readonly measurement: Measurement
      readonly report: string
      /** `target.json` with the measured test command and resources, and `measurement.md`. */
      readonly files: readonly FileProposal[]
    }
  | {
      readonly kind: "promotion"
      readonly pin: string
      readonly promoted: readonly string[]
      readonly log: string
      /** The `Dockerfile` declaring the set the build promoted (plan D7). */
      readonly files: readonly FileProposal[]
    }

/**
 * Measure target `id` as it is on disk (so an uncommitted `target:init` output can be measured
 * before it is reviewed): build its image through the registry, then `measureSuite`. A build
 * that failed at the promotion check proposes the Dockerfile's set instead, and stops. A
 * `MeasureError` after the per-file phase leaves a partial report on the error (`report`).
 */
export async function measureTarget(options: MeasureTargetOptions): Promise<MeasureOutcome> {
  const log = options.log ?? (() => {})
  const recipe = loadTargetRecipe(options.id, {
    targetsDir: options.targetsDir,
    repositoryRoot: options.repositoryRoot,
    ...(options.pin !== undefined ? { pin: options.pin } : {}),
  })
  const manifestPath = join(recipe.directory, "target.json")
  const before = readFileSync(manifestPath, "utf8")
  const current = TargetSchema.parse(JSON.parse(before))
  const notes: string[] = []
  if (recipe.pin !== current.pin) {
    notes.push(
      `Measured at ${recipe.pin}, not the target's default pin ${current.pin}; the proposal keeps the default pin.`,
    )
    log(notes[0] as string)
  }
  let image: EnsuredImage
  try {
    image = await options.registry.ensure(recipe, {
      signal: options.signal,
      onBuild: () => log(`building ${recipe.id} at ${recipe.pin}`),
    })
  } catch (error) {
    if (!(error instanceof ImagePrepareError)) throw error
    const promoted = promotionMismatch(error.log)
    if (promoted === undefined) throw error
    const path = join(recipe.directory, "Dockerfile")
    const dockerfile = readFileSync(path, "utf8")
    return {
      kind: "promotion",
      pin: recipe.pin,
      promoted,
      log: error.log,
      files: [{ path, before: dockerfile, after: withExpectedPromoted(dockerfile, promoted) }],
    }
  }
  const tree = gitPinTree(options.repositoryRoot, recipe.pin)
  const sessions =
    options.sessions ??
    ((r: TargetRecipe, imageId: string) =>
      dockerSessions({
        recipe: r,
        imageId,
        stagingRoot: options.stagingRoot,
        repositoryRoot: options.repositoryRoot,
        signal: options.signal,
      }))
  let measurement: Measurement
  try {
    measurement = await measureSuite({
      recipe,
      open: sessions(recipe, image.image.localId),
      fileTimeoutMs: options.fileTimeoutMs,
      memoryMb: options.memoryMb,
      cpus: options.cpus ?? recipe.resources.cpus,
      runs: options.runs,
      allowDecrease: options.allowDecrease,
      ...(isPlaceholderResources(current.resources) ? {} : { prior: current.resources }),
      existsAtPin: (path) => tree.kind(recipe.root === "." ? path : `${recipe.root}/${path}`) !== undefined,
      log,
      ...(options.now !== undefined ? { now: options.now } : {}),
    })
  } catch (error) {
    if (error instanceof MeasureError && error.files !== undefined)
      error.report = [
        `# target:measure ${recipe.id} at ${recipe.pin}: stopped`,
        "",
        `> ${error.message}`,
        "",
        ...notes.flatMap((note) => [`> ${note}`, ""]),
        ...renderFiles(error.files),
      ].join("\n")
    throw error
  }
  const proposed = TargetSchema.parse({
    ...current,
    commands: { ...current.commands, test: [...measurement.test] },
    resources: measurement.resources,
  })
  const recordPath = join(recipe.directory, "measurement.md")
  return {
    kind: "measured",
    pin: recipe.pin,
    image,
    measurement,
    report: renderReport({
      target: recipe,
      image: { localId: image.image.localId, tag: image.tag },
      measurement,
      limits: options,
      notes,
    }),
    files: [
      { path: manifestPath, before, after: formatManifest(`${JSON.stringify(proposed, null, 2)}\n`) },
      {
        path: recordPath,
        before: readIfPresent(recordPath),
        after: renderMeasurementRecord(recipe.id, measurement.files),
      },
    ],
  }
}

export interface MeasureArgs {
  readonly id: string
  readonly pin?: string
  /** The target catalog to measure in; the controller's `targets/` when absent. */
  readonly targetsDir?: string
  readonly write: boolean
  readonly allowDecrease: boolean
  readonly runs: number
  readonly fileTimeoutMs: number
  readonly memoryMb: number
  readonly cpus?: number
}

export function parseMeasureArgs(argv: readonly string[]): MeasureArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      pin: { type: "string" },
      "targets-dir": { type: "string" },
      write: { type: "boolean", default: false },
      "allow-decrease": { type: "boolean", default: false },
      runs: { type: "string" },
      "file-timeout-ms": { type: "string" },
      "memory-mb": { type: "string" },
      cpus: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  })
  const [id, ...extra] = positionals
  if (!id || extra.length > 0)
    throw new Error(
      "usage: target-measure.ts <target-id> [--pin <sha>] [--targets-dir <dir>] [--write] [--allow-decrease] [--runs <n>] [--file-timeout-ms <ms>] [--memory-mb <mb>] [--cpus <n>]",
    )
  if (values.pin !== undefined && !commitSha.safeParse(values.pin).success)
    throw new Error(`--pin must be a full lowercase commit sha, got ${JSON.stringify(values.pin)}`)
  const integer = (name: string, value: string | undefined, fallback: number): number => {
    if (value === undefined) return fallback
    const n = Number(value)
    if (!Number.isInteger(n) || n <= 0)
      throw new Error(`--${name} must be a positive integer, got ${JSON.stringify(value)}`)
    return n
  }
  let cpus: number | undefined
  if (values.cpus !== undefined) {
    cpus = Number(values.cpus)
    if (!Number.isFinite(cpus) || cpus <= 0)
      throw new Error(`--cpus must be a positive number, got ${JSON.stringify(values.cpus)}`)
  }
  return {
    id,
    write: values.write,
    allowDecrease: values["allow-decrease"],
    runs: integer("runs", values.runs, 3),
    fileTimeoutMs: integer("file-timeout-ms", values["file-timeout-ms"], 180_000),
    memoryMb: integer("memory-mb", values["memory-mb"], 4096),
    ...(values.pin !== undefined ? { pin: values.pin } : {}),
    ...(values["targets-dir"] !== undefined ? { targetsDir: values["targets-dir"] } : {}),
    ...(cpus !== undefined ? { cpus } : {}),
  }
}
```

`scripts/target-measure.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { appRoot, repositoryRoot, targetsDir } from "../src/lib/targets/catalog.js"
import { dockerImageBuilder } from "../src/lib/targets/image-builder.js"
import { ImagePrepareError, openImageRegistry } from "../src/lib/targets/images.js"
import { MeasureError } from "../src/lib/targets/measure/classify.js"
import { measureTarget, parseMeasureArgs } from "../src/lib/targets/measure/measure.js"
import { renderDiff, writeProposal } from "../src/lib/targets/proposal.js"

/**
 * Measure a target in its own image and propose its excludes and resources.
 *
 * `target-measure.ts <id> [--pin <sha>] [--targets-dir <dir>] [--write] [--allow-decrease]
 * [--runs <n>] [--file-timeout-ms <ms>] [--memory-mb <mb>] [--cpus <n>]`
 *
 * Builds (or re-verifies) the target's image through <FACTORY_STATE_DIR>/images.sqlite, as the
 * controller does; runs each test file alone with the network denied (each non-pass twice),
 * then the proposed suite --runs times in fresh containers and once at the proposed resources.
 * Prints the proposal (target.json and measurement.md) as a diff on stdout, writes the full
 * evidence to <FACTORY_STATE_DIR>/measurements/<id>/<pin12>-<utc>/report.md (a partial one
 * when it stops after the per-file phase), and writes the target only with --write. Resources
 * never fall below the target's own without --allow-decrease. A build that fails at the
 * Dockerfile's promotion check proposes the set it printed instead; apply it and run again.
 */
const stateDir = process.env.FACTORY_STATE_DIR
if (!stateDir)
  throw new Error(
    "FACTORY_STATE_DIR is required: the image is built into <FACTORY_STATE_DIR>/images.sqlite, and the captures and the report are staged under it",
  )
const args = parseMeasureArgs(process.argv.slice(2))
const catalog = args.targetsDir ?? targetsDir
const registry = openImageRegistry({
  path: join(stateDir, "images.sqlite"),
  builder: dockerImageBuilder(),
})
const interrupted = new AbortController()
process.once("SIGINT", () => interrupted.abort(new Error("interrupted")))
const log = (line: string) => process.stderr.write(`target:measure: ${line}\n`)
const reportPath = (pin: string) => {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
  const path = join(stateDir, "measurements", args.id, `${pin.slice(0, 12)}-${stamp}`, "report.md")
  mkdirSync(dirname(path), { recursive: true })
  return path
}
try {
  const outcome = await measureTarget({
    id: args.id,
    targetsDir: catalog,
    repositoryRoot: repositoryRoot(),
    registry,
    stagingRoot: resolve(stateDir),
    signal: interrupted.signal,
    fileTimeoutMs: args.fileTimeoutMs,
    memoryMb: args.memoryMb,
    runs: args.runs,
    allowDecrease: args.allowDecrease,
    log,
    ...(args.pin !== undefined ? { pin: args.pin } : {}),
    ...(args.cpus !== undefined ? { cpus: args.cpus } : {}),
  })
  process.stdout.write(renderDiff(outcome.files, args.targetsDir === undefined ? appRoot : catalog))
  if (outcome.kind === "promotion") {
    log(
      `the build promoted [${outcome.promoted.join(" ")}] over the root's node_modules, which the Dockerfile does not declare: review the diff above (a promotion replaces a package every other package resolves)`,
    )
    if (args.write) {
      writeProposal(outcome.files)
      log("written; run target:measure again")
    } else log("--write applies it; then run target:measure again")
    process.exitCode = 1
  } else {
    const report = reportPath(outcome.pin)
    writeFileSync(report, outcome.report)
    log(`report: ${report}`)
    if (args.write) for (const path of writeProposal(outcome.files)) log(`wrote ${path}`)
    else log("nothing written; --write writes the proposal above, and git diff is the review")
  }
} catch (error) {
  if (error instanceof MeasureError) {
    if (error.output !== "") process.stderr.write(`${error.output}\n`)
    if (error.report !== undefined) {
      const report = reportPath(args.pin ?? "default-pin")
      writeFileSync(report, error.report)
      log(`stopped; partial report: ${report}`)
    }
  }
  if (error instanceof ImagePrepareError) process.stderr.write(error.log)
  throw error
} finally {
  registry.close()
}
```

In `controller/package.json`'s `scripts`, after `"target:init"`:

```json
    "target:measure": "tsx scripts/target-measure.ts",
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/target-measure.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller/src/lib/targets/measure/measure.ts examples/software-factory/controller/scripts/target-measure.ts examples/software-factory/controller/package.json examples/software-factory/controller/test/target-measure.test.ts
git commit -m "feat(software-factory): target:measure proposes a target's excludes, resources and promotion set

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (review-driven; commits `a299a0959` and the review-fix commit after `cc1abc372`). `scripts/target-measure.ts` aborts its sessions on SIGTERM as on SIGINT, so a supervisor's stop tears down each container, capture and session state. **Follow-up**: a SIGKILL (or a crash) still leaves `<FACTORY_STATE_DIR>/measurements/sessions/*` and the measure captures behind; sweep abandoned ones at startup. `writeProposal`'s refusals are neutral, since `target:measure` calls it too ("run the command again"; "a proposal is written only into a real directory"). `measurement.md` no longer says every file passed run alone when flaky files are listed.

**As landed** (found by the hand measurement of the generated `cli` target at `765e6e16`, which stopped after 16 files on `Executable workspace file: packages/cli/dist/index.js`). `packages/cli/test/check-command.test.ts` chmods the built CLI `0755`, and the verifier's inspection (the same `targetInspectionOptions`; the tamper check excludes nothing since #767) refuses an executable file, so every verification with that file in the suite would be refused. A snapshot refused by the inspection (`isWorkspaceInspectionError` with code `refused`: an executable, binary or non-UTF-8 file, an unexpected link, or a limit exceeded) after a file's run makes the file `writes`, whatever else the run said, with the reason `the verifier's workspace inspection refuses the workspace after it: "<message>"` (sanitised, one line, JSON-quoted; a failing run's own reason follows it), and the next file gets a fresh session; its re-run follows the usual rules. A refusal right after a session's build, before any test ran, is a `MeasureError` naming the target; a refusal after the suite, in the samples or the confirmation, is a `MeasureError` (no resources for a suite every verification would refuse). Any other snapshot failure (I/O, the workspace changing while read) is a `MeasureError` naming when it happened, so the partial report keeps the files measured. The fake session gained `refuses` (build, file, suite) and `snapshotFails`.

### Task 17: The proof: `measure` on a generated `devkit` proposes its committed excludes

Spec §5's proof for `measure`, on the generated target (so it proves `init` and `measure` together) against the committed one.

**Files:**
- Test: `controller/test/target-measure.integration.test.ts`

- [ ] **Step 1: Write the lane**

`test/target-measure.integration.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  configuredImages,
  repositoryRoot,
  TargetSchema,
  targetsDir,
} from "../src/lib/targets/catalog.ts"
import { initTarget } from "../src/lib/targets/init/init.ts"
import { measureTarget } from "../src/lib/targets/measure/measure.ts"
import { writeProposal } from "../src/lib/targets/proposal.ts"
import { parseVitestCommand } from "../src/lib/targets/vitest-command.ts"
import { shippedPin } from "./temp-repo.ts"

describe("target:measure on a devkit target generated by target:init", () => {
  it(
    "proposes exactly the committed nine excludes, each failing alone on the templates the capture omits",
    async () => {
      const registry = configuredImages()
      if (registry === undefined) throw new Error("the lane setup configured no image registry")
      const targets = mkdtempSync(join(tmpdir(), "factory-measure-lane-"))
      const staging = mkdtempSync(join(tmpdir(), "factory-measure-staging-"))
      const started = Date.now()
      try {
        // initTarget makes the pin present itself (plan I8).
        writeProposal(
          initTarget({
            packageRef: "@b4run/devkit",
            pin: shippedPin("devkit"),
            repositoryRoot: repositoryRoot(),
            targetsDir: targets,
          }).files,
        )
        const measure = () =>
          measureTarget({
            id: "devkit",
            targetsDir: targets,
            repositoryRoot: repositoryRoot(),
            registry,
            stagingRoot: staging,
            signal: AbortSignal.timeout(2_400_000),
            fileTimeoutMs: 120_000,
            memoryMb: 2048,
            cpus: 2,
            runs: 1,
            allowDecrease: false,
            log: (line) => process.stderr.write(`lane: ${line}\n`),
          })
        let outcome = await measure()
        if (outcome.kind === "promotion") {
          // A person reviews and applies this; the lane records it and applies it.
          process.stderr.write(`lane: devkit promotes [${outcome.promoted.join(" ")}]\n`)
          writeProposal(outcome.files)
          outcome = await measure()
        }
        if (outcome.kind !== "measured") throw new Error("a second build proposed another promotion set")
        const committed = TargetSchema.parse(
          JSON.parse(readFileSync(join(targetsDir, "devkit", "target.json"), "utf8")),
        )
        const m = outcome.measurement
        expect(m.excludes).toEqual(parseVitestCommand(committed.commands.test).excludes)
        expect(m.test).toEqual(committed.commands.test)
        expect(m.files.filter((f) => f.verdict === "pass").map((f) => f.file)).toEqual([
          "test/process-artifacts.test.ts",
          "test/reporting.test.ts",
        ])
        for (const file of m.files.filter((f) => f.verdict !== "pass")) {
          expect(file.verdict, file.file).toBe("fail")
          expect(file.output, file.file).toMatch(/templates\//)
          expect(file.omissions.length, file.file).toBeGreaterThan(0)
        }
        expect(outcome.files[1]?.after.match(/^- `test\//gm)).toHaveLength(9)
        expect(m.resources.cpus).toBe(2)
        expect(m.resources.memoryMb).toBeGreaterThanOrEqual(512)
        expect(m.resources.memoryMb).toBeLessThanOrEqual(2048)
        process.stderr.write(
          `lane: measured ${JSON.stringify(m.measured)}; proposed ${JSON.stringify(m.resources)}; committed ${JSON.stringify(committed.resources)}; ${Math.round((Date.now() - started) / 1000)} s\n${outcome.report}\n`,
        )
      } finally {
        rmSync(targets, { recursive: true, force: true })
        rmSync(staging, { recursive: true, force: true })
      }
    },
    2_500_000,
  )
})
```

- [ ] **Step 2: Run the lane**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run --config vitest.sandbox.config.ts test/target-measure.integration.test.ts`
Expected: PASS. Record in the PR description the lane's wall clock, the proposed resources beside the committed ones (`768/2/60000/240000`), and one excluded file's output (it should name `templates/`). If the proposed excludes differ from the committed nine, that is spec §5's "explains each difference": stop, read each differing file's output in the report, record why, and ask before changing the assertion.

- [ ] **Step 3: Commit**

```bash
git add examples/software-factory/controller/test/target-measure.integration.test.ts
git commit -m "test(software-factory): target:measure proposes devkit's committed excludes on a generated target

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed** (commit `cc1abc372`). On the generated `devkit` target, `target:measure` proposed exactly the nine committed excludes and the committed test command. Proposed resources: `memoryMb` 512, `cpus` 2, `commandTimeoutMs` 60000 to 70000 across runs, `verifierDeadlineMs` 120000; `commandTimeoutMs` sits on a 10 s rounding boundary (eight times a suite of 7.5 s or less rounds up to 60 s; a suite a few milliseconds longer rounds up to 70 s), so the lane does not assert it (only `cpus` and memory bounds). The lane took about 80 s; the full `test:sandbox` about 300 s locally.

### Task 18: A full measurement of the generated `cli` target, by hand

No code: the `cli` template build moved into PR 1 (Task 10 Step 3), and `measureTarget`'s promotion path is unit-tested (Task 16). What remains is one measurement of the generated `cli` target (the whole test directory, where the committed target runs eight hand-picked files), recorded, in a scratch catalog so the real one is never written (review minor: `--targets-dir`).

- [ ] **Step 1: Measure in a scratch catalog**

```bash
export FACTORY_STATE_DIR="$(mktemp -d)/factory-measure-cli"
mkdir -p "$FACTORY_STATE_DIR/targets"
pnpm --filter @b4-example/software-factory-controller target:init @b4run/cli --pin 765e6e16fec86bba0859d3f85edf7136f663f720 --targets-dir "$FACTORY_STATE_DIR/targets" --write
pnpm --filter @b4-example/software-factory-controller target:measure cli --targets-dir "$FACTORY_STATE_DIR/targets" --runs 1 --write   # proposes the promotion set; exit 1
pnpm --filter @b4-example/software-factory-controller target:measure cli --targets-dir "$FACTORY_STATE_DIR/targets" --runs 1           # measures 169 files; prints the proposal
git status --short examples/software-factory/controller/targets   # expected: nothing
```

(`target:init` with no existing target in the scratch catalog carries nothing, so the whole test directory is captured. The image is `/opt/targets/cli`, the same recipe key as Task 10's `cli` lane when the promotion set matches, so a warm host reuses it.)

- [ ] **Step 2: Record**

In the PR description and in the spec's as-landed note (Task 19): the wall clock; how many of the 169 files pass alone and how many are flaky; the excludes grouped by the report's reasons (capture omissions naming `packages/sandbox` or `packages/testing`, the network, writes to the workspace); the measured and proposed resources beside the committed `1536/2/120000/3600000`; and whether the eight committed files are among those that pass. Nothing is committed in this task.

**As landed** (not committed; run by hand on 2026-09-26 in a scratch catalog, `git status` on `targets/` clean afterwards). The generated `cli` target at `765e6e16` captures the whole test directory. Its first `--write` measurement learned the promotion set `@hono/node-server commander hono typescript`, the hand-written one. The first full run then stopped after 16 files: `check-command.test.ts` does `chmod(distEntry, 0o755)` on the built CLI, and the verifier's inspection refuses an executable workspace file. That exposed a defect, fixed in `993cbab3d`: a snapshot the inspection refuses after a file's run is now that file's `writes` verdict, not a stop. The rerun measured all 169 files in 1369 s (warm image):

| Verdict | Files |
|---|---|
| pass | 114 |
| proposed exclude | 55 |
| flaky | 0 |

The excludes by cause:

| Cause | Files |
|---|---|
| imports `@b4run/testing`'s build output (a devDependency the build does not include; `--with-dev-builds` is the remedy to try) | 29 |
| another module or package the image lacks | 11 |
| packages the image does not install (pnpm, Vercel and Postgres lanes) | 5 |
| assertion or other failure | 5 |
| a capture omission (including one under `packages/devkit/templates`) | 3 |
| writes the workspace (`check-command`, `import-diagnostics-integration`) | 2 |

All eight files the hand-written target runs pass alone. Proposed resources are `1280/2/420000/300000` (no prior; placeholders) beside the committed `1536/2/120000/3600000`. `commandTimeoutMs` above `verifierDeadlineMs` is legal (the deadline bounds a whole verification, the timeout one command), but a reviewer should look at it; recorded as a follow-up.

### Task 19: Docs for PR 2

**Files:**
- Modify: `examples/software-factory/README.md` (after Task 11's paragraph)
- Modify: `docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md` (§5 as landed; §7's table row)

- [ ] **Step 1: README**

Append to Task 11's paragraph:

```markdown
`pnpm --filter @b4-example/software-factory-controller target:measure <id> [--pin <sha>] [--write]`
(with `FACTORY_STATE_DIR` set) builds the target's image through the same registry the
controller uses (the target's files as they are on disk, so an uncommitted `target:init` output
can be measured), lists the test files the target's vitest command selects, runs each one alone
in the verifier's session shape (network denied, the workspace snapshotted before and after),
and proposes an exclude for each file that fails, hangs, or passes but changes the workspace
(which every verification would refuse as tampering); each non-pass runs once more in a
fresh container, and a file that then passes is listed as flaky, never excluded. It then runs
the suite with those excludes (`--runs`, default 3) in fresh containers, proposes resources from
cgroup `memory.peak` and the wall clock, never below the target's own without
`--allow-decrease`, and tries the proposal once at exactly those values. `--write` writes
`target.json` and `targets/<id>/measurement.md` (each exclude's class, reason and first error
lines, committed with the target); the full evidence is in
`<FACTORY_STATE_DIR>/measurements/<id>/<pin>-<time>/report.md`. When the build fails at the
Dockerfile's promotion check (a nested dependency pnpm's hoisting left under a package), it
proposes the set the build printed instead: review it, apply it with `--write`, and measure
again. A target stays a reviewed, committed file: it is an input to every verification.
```

- [ ] **Step 2: Spec as-landed (PR 2)**

Append to §5's as-landed note:

```markdown
PR 2: `target:measure` builds through `ImageRegistry.ensure` (no separate build path), lists
files with `vitest list --filesOnly`, classifies each file run alone as pass, fail, hang,
killed or writes (a class the verifier's tamper check makes necessary), in a fresh container
after any file that dirtied or wedged one, re-runs each non-pass once (a disagreement is
flaky, never excluded), then samples the whole proposed suite in fresh containers: per-file
runs cannot measure memory, because `memory.peak` is per container and vitest runs a suite's
files in parallel workers. Resources: twice the peak (256 MiB steps), eight times the slower
of build and suite, two sessions at 2.5 times the slowest; never below the target's own
without `--allow-decrease`; confirmed by a run at the proposed values. Each exclude's reason is
committed as `targets/<id>/measurement.md`. Proof: on a `devkit` target generated by `init`,
`measure` proposes exactly the committed nine excludes, each named as a capture omission of
`templates/` (`test/target-measure.integration.test.ts`<: measured and proposed resources
..., committed 768/2/60000/240000; fill in from the lane>). A full measurement of the generated `cli` target by hand: <wall clock; N of 169 pass
alone; excludes by reason; proposed resources beside 1536/2/120000/3600000>. Deferred:
`draftingNotes` stay hand-written (§9 finding 20).
```

In §7's table, the row `| Hand-writing target.json and the Dockerfile | 5 |` becomes:

```markdown
| Hand-writing target.json and the Dockerfile | 5 (`target:init`, `target:measure`; a person still reviews and commits) |
```

- [ ] **Step 3: Commit**

```bash
git add examples/software-factory/README.md docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md
git commit -m "docs(software-factory): target:measure in the README and the spec's as-landed note

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**PR 2 verification** (all from the repository root):

```bash
source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @b4-example/software-factory-controller typecheck
pnpm --filter @b4-example/software-factory-controller lint
pnpm --filter @b4-example/software-factory-controller test
pnpm --filter @b4-example/software-factory-controller test:sandbox     # includes Tasks 10 and 17; record the wall clock
node scripts/check-docs.mjs
```

Push `blove/targets-measure` and open the PR only when Brian asks.

---

## Proof map

| Proof (spec §5, and this plan's additions) | Where |
|---|---|
| `init` reads `package.json` files and `pnpm-workspace.yaml` at the pin from the object store | Task 1 ("never reads the working tree"); Task 2 |
| capture, `imageContext`, build order derived from the manifests | Task 6 (every field of a fixture monorepo); Task 12 (the capture archives at the pin) |
| `init` reproduces the committed `devkit` target, differences listed and explained | Task 9: the whole target equal to the committed one with exactly these applied: the nine excludes, the three root manifests in `runnerConfig`, placeholder resources; the template Dockerfile |
| `init` reproduces the committed `cli` target, differences listed and explained | Task 9: the whole target equal to the committed one with exactly these applied: the whole test directory for the eight-file scope, the derived module assertions without the two extras, the build's project order without `--declarationMap false`, the base test command, placeholder resources, no drafting notes; `CAPTURED` equal; a regeneration in place differs only in the build |
| The generated Dockerfile works | Task 5 (its shell executed on a fixture: shim, promotion, double promotion, mismatch, relinks); Task 10 (the generated `devkit` Dockerfile builds in Docker; the generated `cli` one learns the committed promotion set and builds, by hand before PR 1 merges) |
| `measure` runs per file in the prepared image with the network denied | Task 15 (`targetSandboxPolicy`'s denied network, the image by id); Task 17 |
| proposes an exclude per failing or hanging file, with its reason | Task 13 (classification, the report's fenced output); Task 14 (orchestration, a fresh container after a hang); Task 17 (devkit: the committed nine, each failing with output) |
| … and per file that writes the workspace (plan D11) | Task 13; Task 14 |
| A file measured in a clean workspace; a failing file's writes reported (review I1) | Task 13 ("reports what a failing file changed too"); Task 14 ("gives the next file a fresh container after a file that writes") |
| One flaky failure is not an exclude (review I3) | Task 13 (`settleFile`); Task 14 ("lists a file that fails once and then passes as flaky") |
| Resources never shrink unasked, and are tried at the proposed values (review I2) | Task 13 (`settleResources`); Task 14 ("never proposes below …", "refuses a proposal that does not hold when tried"); Task 16 ("keeps measured resources at or above the target's own") |
| Hand additions survive a re-generation (review I4) | Task 6 ("carries … as supersets"); Task 9 (both targets regenerated in place, whole-object) |
| Omissions are visible (review I5) | Task 6 (subdirectory and sibling notes); Task 9 (`cli`'s `bin/`, `scripts/`, `../sandbox/`; `devkit`'s `templates/`); Task 13 (capture omissions, per-test counts); Task 17 (each of devkit's nine named) |
| Each exclude's reason is committed (D2) | Task 13 (`renderMeasurementRecord`); Task 16 (`measurement.md` proposed); Task 17 (nine entries) |
| The template works for cli before PR 1 ships (review I9) | Task 10 Step 3 |
| resources from cgroup `memory.peak` and wall clock with headroom | Task 13 (the formula reproduces devkit's 768/80000/240000 from rung 2's measurement); Task 14 (samples in fresh containers); Task 15 (`memory.peak` read, refused rather than guessed) |
| The output is a diff; nothing is written unasked | Task 7 (`renderDiff`, nothing on disk); Task 8 (the script writes nothing without `--write`); Task 16 (a promotion proposal writes nothing) |
| No model is involved | No module in `targets/init/` or `targets/measure/` imports a model or a worker |
| The promotion set, the one hand-written part `init` cannot derive (§9 finding 6) | Task 5 (`promotionMismatch` ignores BuildKit's echo); Task 16; Task 18 (the `cli` set learned equals the hand-written one) |

## Follow-ups recorded, not in this plan

- **`commandTimeoutMs` can exceed `verifierDeadlineMs`** (the `cli` hand measurement proposed 420000 beside 300000): the two formulas are independent. Consider clamping the command timeout to the deadline, or deriving the deadline from both.

- **The shipped `targets/cli/Dockerfile` ignores a failed move** in its promotion and relink loops (the `rm -rf … && mkdir -p … && mv …` chain, the `rm -rf "$nm"`, and the relink `rm -rf … && ln -s …`, lines ~52, 54, 61): inside the RUN's top-level `&&` list the shell ignores `set -e`, the bug the template fixed in Task 5 (`|| exit 1`). Not changed here (D14); fix it when `cli` is next re-pinned or regenerated.
- **Regenerate the shipped targets** (D14) when each is next re-pinned: `devkit` gains the root manifests in `runnerConfig` and the template Dockerfile; `cli` gains the whole test directory if the full measurement (Task 18) says it is affordable, or keeps its scope (carried).
- **Drafting notes from a package's tests** (spec §9 finding 20). Nothing deterministic writes them; a model-drafted proposal reviewed like the rest of the target is its own item.
- **Per-test exclusion** (D15): `--testNamePattern` or reviewed `.skip`s, if a file whose one failing test hides many passing ones proves common in the reports' per-test counts.
- **Carry `--with-dev-builds`** (D16) across a re-generation, if a target generated with it is re-pinned often enough that retyping the flag is a trap.
- **Widen the workspace capture's path charset** in `@b4run/workspace` (`source-validation.ts:46-66`), so `devkit`'s `templates/` can be captured and its nine tests run; `measure` would then propose none of them.
- **The promotion set at later pins** (D7): a work order at a pin whose lockfile nests differently fails its build naming the set. Deriving the set from the lockfile (a YAML parser in the example) or measuring at the work order's pin automatically would remove that step.
- **Packages outside `packages/`** (D3): generalise `capturedPackages` and the Dockerfile's `CAPTURED` to workspace directories, if an `examples/*/*` package ever becomes a target.
- **npm and `node:test` targets** (D3), if a second `cli-flags`-shaped target appears.
- **Share one core between `proposalProblem` and `recipeProblem`**: `init.ts`'s `proposalProblem` repeats `recipeProblem`'s checks (paths at the pin, the `CAPTURED` list, the lockfile inside `imageContext`) over a proposal, with different wording; one function over a manifest, a Dockerfile's text and an `exists` would keep them from drifting.
- **Measure files in parallel**: 169 files one at a time is slow; several sessions at once would need a per-session memory budget that does not distort the per-file verdicts.
- **A capture omission could stop `measure`** instead of proposing an exclude: an `ENOENT` on a path that exists at the pin is the capture's defect, not the test's; D11 keeps it as a labelled exclude (the reason names the omission) so one missing template does not block measuring the rest.
- **Tell a memory kill from a test's own SIGKILL**: exit 137 with no report is `killed` whichever it was; the container's cgroup `memory.events` `oom_kill` count would say whether the memory limit did it.
- **Budgets from measured time** (spec §9 finding 5): `measure`'s session wall clock is the number a derived `FACTORY_MAX_ACTIVE_MS` would start from.

## Self-review

- **Spec coverage.** §5 Change: both commands exist, deterministic, as package scripts (D1; Spec corrections 1); `init` reads manifests and the workspace file at the pin from the object store (Tasks 1-2); capture, `imageContext` and build order from three closures (Tasks 2, 3, 6; corrections 2-4); `measure` per file with the network denied, excludes with reasons, resources from `memory.peak` and wall clock with headroom (Tasks 13-15; corrections 5-7); the output is a diff (Tasks 7, 8, 16). §5 Trust impact: the target stays a reviewed, committed file (nothing is written without `--write`, nothing is committed by a command); each exclude carries its failure output (the report); no model (Proof map). §5 Proof: Task 9 (both reproductions, each difference asserted) and Task 17 (`devkit`'s nine). §4 as landed: `measure` builds through `ImageRegistry.ensure` and records nothing in `target.json` beyond reviewed fields (Task 16). §7: the table row changes (Task 19). §8: item 5 after item 4 (done). §9 findings 1 (every hand-derived field of the `cli` target is now derived or measured, Task 9's list), 5 (session time measured; budgets deferred), 6 (the Dockerfile generated, the promotion set learned), 12 (runner configuration derived, complete by construction), 20 (deferred with the reason).
- **Placeholder scan.** Every code step carries its code, and every run step its command and expected result. The two spec as-landed notes carry `<...>` slots for numbers only a run produces (the lanes' wall clock, a learned promotion set, the hand measurement); each slot names where its value comes from. Helpers used from existing files are named as the files name them (`ensurePin` is now also called inside `initTarget`): `shippedPin` (`test/temp-repo.ts`), `configuredImages`, `loadTargetRecipe`, `repositoryRoot`, `targetsDir`, `appRoot`, `ensurePin`, `commitSha`, `covers`, `isCatalogId`, `TargetSchema` (`catalog.ts`), `capturedListMismatch`, `dockerfileCapturedPackages`, `firstMissingPath`, `pathsRequiredAtPin` (`prepare.ts`), `resolvePin` (`intake/issue.ts`), `shellJoin` (`verification/checks-runner.ts`), `captureDirectory` (`archive.ts`), `targetWorkspace`, `targetInspectionOptions`, `targetSandboxPolicy` (`workspace.ts`), `ImagePrepareError`, `openImageRegistry`, `EnsuredImage`, `ImageRegistry` (`images.ts`), `dockerImageBuilder` (`image-builder.ts`).
- **Type consistency.** `PinTree` (Task 1) is what `readWorkspace`, `expandGlob`, `buildConfig`, `packageTsconfigs` and `deriveTarget` read. `WorkspacePackage` (Task 2) is what `buildScriptTsconfig`, `buildConfig`, `vitestTestArgv` (structurally) and `deriveTarget` take. `VitestCommand` (Task 4) is produced by `parseVitestCommand` and consumed by `withExcludes` (Tasks 4, 6, 7), `perFileArgv` and `listArgv` (Task 13, used by Task 14). `CarriedFields` (Task 6) is what `carriedFrom` (Task 7) builds: `baseImage`, `resources`, `draftingNotes`, `scope`, `excludes`, `expectedPromoted`, and the supersets `imageAssertResolves`, `captureInclude`, `runnerConfig`. `DockerfileSpec` (Task 5) is what `deriveTarget` returns and `renderDockerfile` takes. `FileProposal` (Task 7) is what `initTarget` and `measureTarget` return and `renderDiff`/`writeProposal` take. `VitestRun`, `FileMeasurement`, `SuiteSample`, `Measurement`, `MeasureLimits` live in `classify.ts` (Task 13); `MeasureSession`, `SessionLimits`, `OpenSession` in `session.ts` (Task 14), which Task 15 extends with `measureTask` and `dockerSessions`; `WorkspaceTask` (Task 12) is what `measureTask` returns. `measureSuite` passes its whole options object as `classifyFile`'s `MeasureLimits` and `measureTarget` passes its own as `renderReport`'s `limits` (both read only `fileTimeoutMs` and `memoryMb`). `FileMeasurement` carries `changed`, `omissions` and optional `tests` (`TestCounts`, from `VitestRun.files[].tests`); `Measurement` carries `measured`, `prior`, `resources` and `confirmation`; `MeasureError` carries `files` and `report` for a partial report. `topologicalOrder` takes the dependency kinds it orders by (`PROD` for a build).
- **Review amendments.** Each of the review's nine Important findings and its minors is addressed in place and listed, with where, in "Review amendments (2026-09-25)" below; the amended code was prototyped again (the second prototype note).
- **Checked against the pins.** The closures, build order, tsconfig chains, `outDir`s, the one config package and the root TypeScript version were computed from `git show` at `6a59e00a` and `765e6e16` while writing this plan (Today, rows 12-13); every captured path at both pins is portable and none is a symlink (`git ls-tree -r`: 487 files, 4.2 MB under the `cli` target's generated capture directories); no two workspace packages share a name and every matched `package.json` parses at either pin. Task 9's expected build order for `cli` is that computation's output.

## Review amendments (2026-09-25)

An independent review of this plan (at `211684688`) found no Critical issues, nine Important ones and several minors. Each is addressed in place; this list says where.

1. **I1: one container across files let a write dirty the next file's workspace, and a failing file's writes were hidden.** `measureSuite` gives the next file a fresh container after any file that changed the workspace, hung or was killed (Task 14); `classifyFile` reports `changed` whatever the verdict, and a failing file's reason says what it also changed (Task 13). Tests: "reports what a failing file changed too" (Task 13), "gives the next file a fresh container after a file that writes" (Task 14, through the fake's `sessionOf`). D11 amended.
2. **I2: resource proposals were never tried and could shrink.** The proposal is, field by field, the larger of the measured and the target's own resources unless `--allow-decrease` (`settleResources`, Task 13); placeholders are no prior (`isPlaceholderResources`, Task 6); one more whole-suite session at exactly the proposed memory, CPUs and timeout must pass, write nothing and fit twice in the proposed deadline, or `measure` refuses (Task 14); the report sets before, measured and proposed side by side (Task 13). Tests in Tasks 13, 14 and 16. D12 amended, with the prototype's own evidence (181 against 369 MiB).
3. **I3: one flaky failure became an exclude.** Every non-pass runs once more, alone, in a fresh container; a pass makes it `flaky`, listed and never proposed (`settleFile`, Tasks 13-14); exit 137 with no report is its own verdict, `killed`. D11 amended.
4. **I4: a re-generation dropped hand additions, and would widen a scoped capture.** `imageAssertResolves`, `capture.include` and `runnerConfig` are carried as supersets of existing entries still present at the pin (capture entries only when root-level or under a captured package); a carried scope keeps the carried capture of the test directory (Tasks 6-7). Task 9 regenerates both shipped targets in place and compares whole objects (`cli` differs only in its build's order, `devkit` only in the wider `runnerConfig`), asserting `imageAssertResolves` and `capture.include` explicitly. D8 amended.
5. **I5: uncaptured directories were invisible.** `init` notes each captured package's subdirectories the capture omits, with file counts, and each sibling a vitest config reaches by `../<dir>/` that the capture omits (Task 6; asserted for `cli`'s `bin/`, `scripts/` and `../sandbox/` and `devkit`'s `templates/` in Task 9). `measure` records each file's passed, failed and skipped test counts from `assertionResults` (Task 15's session, Task 13's report) and names an `ENOENT` on a path that exists at the pin as a capture omission (`captureOmissions`, Task 13; Task 17 asserts it for all nine). D4 amended; D15 added.
6. **I6: Task 9 compared named fields only.** It now compares the whole normalised target with the committed one, each named difference applied (Task 9).
7. **I7: Task 9's `beforeAll` ran under vitest's 10 s hook default.** Every generation in Task 9 runs under `GENERATE_MS` (120 s).
8. **I8: the lanes found the pins only because the global setup fetched them.** `initTarget` calls `ensurePin` itself (Task 7), so every caller, the lanes included, works on a shallow checkout; the script's own call is gone (Task 8).
9. **I9: the template was proven only on devkit before PR 1 ships.** Task 10 gains the opt-in `cli` case (learns the committed promotion set, then builds: the TypeScript shim and relinks by name) and `test:sandbox:cli` runs it; Step 3 runs it by hand before PR 1 merges and records the result. The PR 2 lane that did this moved here; Task 18 is now the hand measurement only. D13 amended.

Minors:

- **Test-script tokens.** Only `run`, `--run`, `--config <file>`, `--no-cache` and `--passWithNoTests` are read; anything else is refused by name (Task 4; D3). The reviewer's list (`--config` and `run` only) would refuse `devkit`'s and most packages' `--run` and `--passWithNoTests`, which every hand-written target already runs; the three are named, not guessed.
- **Build scripts that do more than compile** are named in a note (Task 6; D5).
- **Build order by runtime edges**: `topologicalOrder` takes its dependency kinds, and a build orders by `PROD` (Task 2, Task 6; D5).
- **Placeholder and exclude warnings by value**: `isPlaceholderResources` and an empty exclude list, not whether a field was carried (Task 6; D9).
- **A partial report on a stop after the per-file phase**: `MeasureError.files` and `.report`, written by the script (Tasks 13, 14, 16).
- **`measure --pin` other than the default** is said in the log and the report (Task 16).
- **`dockerSessions` takes `repositoryRoot`** and archives the capture from it (Task 15).
- **`formatManifest` runs the controller's own Biome** (`node_modules/.bin/biome`), not `npx` (Task 7).
- **A `tsBuildInfoFile` outside the `outDir` is refused** (Task 3; D5): `snapshotIgnore` holds directory prefixes and cannot cover a file.
- **Overclaiming test names**: Task 13's resource test is "gives devkit's committed memory and verifier deadline from rung 2's measurement", and its comment says the committed timeout is 6.7 times the suite, under the rule's eight.
- **Task 17 asserts each excluded file's output names `templates/`** and that each is a named capture omission, and that `measurement.md` lists nine.
- **Task 18 no longer writes into the real catalog**: both commands take `--targets-dir`, and the hand measurement uses a scratch catalog under `FACTORY_STATE_DIR` (Task 18; D1).

Decisions: **D2** now recommends the reviewer's alternative, a committed `targets/<id>/measurement.md` (each exclude's class, reason and first error lines; no timings or ids); the report stays under the state directory. **D8, D11, D12** amended per I4, I1 and I3, and I2. **D15** (excludes per file, per-test counts as the mitigation) and **D16** (`--with-dev-builds`, opt-in) added.

Nothing in the review was declined. One point was narrowed, not reversed: the test-script allow-list (first minor) keeps the three flags every hand-written target already uses.
