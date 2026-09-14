# Code-fixer Blueprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the current session. Steps use checkbox syntax for tracking. Use independent review at the defined checkpoints.

**Goal:** Deliver one runnable B4 coding agent that repairs two faithful historical fixtures, with independent evaluations and exportable real-run evidence.

**Architecture:** A private example application powers both tasks. A host-owned runner seeds isolated Docker workspaces, collects permitted source changes, and verifies them against pristine fixtures in separate sandboxes. The same application is used for scripted tests and live attempts; the homepage consumes evidence later.

**Tech Stack:** TypeScript, B4 SDK/CLI/testing/evals/workspace/sandbox public exports, Docker, Git, Commander, Zod, Vitest, Node 24, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-13-code-fixer-blueprint-design.md` (approved).

## Implementation checkpoint — September 13, 2026

The executable blueprint is implemented on `blove/code-fixer-blueprint`.
The checklist below remains the original detailed acceptance plan; this ledger
records the verified state rather than implying every completion gate has passed.
Some planned modules were consolidated (`fixture-catalog.ts` owns contracts;
`exportForReview.ts` owns the small outbox action). Fixture commits were combined.

| Area | Verified state |
|---|---|
| Fixture contracts and historical qualification | Both faulty baselines fail as intended; reference repairs pass visible and independent checks. |
| Docker, workspace, and approval | Eight integration tests pass, including isolation, preserved edits, actual allow/deny, exit-zero bypass rejection, runtime file tampering, and assertion tampering. |
| Runner and evaluations | Both fixtures pass full replay and stop at approval-pending; all six deterministic criteria pass. Failed batches exit nonzero, cancellation stops the batch, cleanup attempts every owned ID, and artifact failures retain fallback accounting. |
| Unit and root discovery | 42 unit tests pass after live-workflow fixes; the preceding 34-test suite also passed root-workspace discovery. |
| Standalone consumer | Published B4 `0.8.31` passes install, check, build, typecheck, unit tests, and both Docker replay cases outside the monorepo. |
| Independent review | Verifier and runner findings fixed and re-reviewed with no remaining findings in those scopes. |
| Repository validation | Full `pnpm ci:validate` passes on sequential rerun: 5,916 source tests, release-controller checks, packaging, and all three harness lanes. Changeset check reports no user-facing package changes. |
| Live evaluation and recordings | First six-attempt live batch retained: zero full-workflow successes, with two independently correct CLI repairs. Generic workflow fixes are reviewed and tested; a fresh batch and successful per-fixture recordings remain required. See the live-evaluations runbook. |

Recorded replay durations were 5,984 ms (CLI) and 10,127 ms (nullable), including
independent verification. These are scripted wiring measurements, not inference
or live-agent speed claims. No replay is eligible for live recording export.

Verifier assertions now run in a separate process from submitted target source.
Named test receipts and post-execution file snapshots additionally reject early
exit and runtime tampering. Export includes a host-generated unified review diff.
A real terminal replay displayed that diff, accepted denial, and created no outbox.

The first full validation attempt failed two existing CLI marker tests when a
build hit `ENOTEMPTY` while regenerating `packages/cli/docs`. A sequential rerun
passed all required gates without changing framework or release code. This first
failure is retained here rather than omitted from the verification history.

## Execution rules and boundaries

All commands run from the repository root. Use the existing isolated worktree;
start implementation on `blove/code-fixer-blueprint` after preserving this plan.
Do not modify release scripts, framework APIs, the research example, or the
homepage as incidental fixes. Never execute a submitted patch on the host.

The commands below introduce package scripts as part of Task 1. They are planned
interfaces, not commands claimed to exist today. Use source imports with `.js`
and tests with `.ts`, respect exact optional property types, and scope formatter
writes. Build before importing workspace package `dist` output.

Run tasks sequentially through fixture qualification. A fixture that cannot
retain its real failure boundary is a design checkpoint, not permission to
replace it with a toy. Use @superpowers:systematic-debugging for unexpected
failures and @superpowers:verification-before-completion for delivery claims.

## File map

All new application paths are under `examples/code-fixer/server/`:

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Private workspace package, scripts, sequential harness tests |
| `b4.config.ts`, `.env.example`, `Dockerfile` | Public API configuration and prepared fixture runtime |
| `src/app/fix/index.ts`, `plan.md`, `skills/verify-change/SKILL.md` | One agent, plan, reusable verification guidance |
| `src/app/fix/tools/exportForReview.ts` | Approval-gated local outbox action |
| `src/blueprint/contracts.ts`, `fixture-catalog.ts` | Validated task and receipt contracts |
| `src/blueprint/seeded-provider.ts` | Public SandboxProvider decorator, seeding, observation, cleanup |
| `src/blueprint/patch.ts`, `verifier.ts` | Source-only patch extraction and isolated verification |
| `src/blueprint/run-attempt.ts`, `evaluate.ts` | Lifecycle, budgets, eval integration |
| `src/blueprint/evidence.ts`, `review-outbox.ts` | Sanitized evidence and approved export |
| `scripts/qualify.ts`, `prepare.ts`, `run.ts`, `eval.ts`, `export.ts`, `consumer.ts` | Thin command entry points |
| `fixtures/cli-flags/manifest.json`, `task.md`, `project/`, `checks/`, `reference.patch` | CLI fixture, public tests, evaluator checks, historical repair |
| `fixtures/nullable-inputs/manifest.json`, `task.md`, `project/`, `checks/`, `reference.patch` | Schema fixture with the same contract |
| `test/*.test.ts` | Focused regression and integration coverage named per task |
| `README.md` | Runnable commands, prerequisites, capability/code tour |

Also create `examples/code-fixer/README.md`; update the root lockfile and only
the repository discovery/configuration entries shown necessary by validation.
Ignored run outputs belong to `artifacts/code-fixer/`, outside the agent target.
Reference patches and evaluator-only checks are never seeded into that target.

## Task 1: Package and manifest contract

- [ ] Inspect root test discovery, `turbo.json`, and the research package scripts.
  Add the private package `@b4-example/code-fixer-server` using existing exact
  dependency versions. Add explicit `tsx` if used by scripts; do not rely on a
  transitive executable. Include `src`, `scripts`, and `test` in typechecking.
- [ ] Define scripts: `check`, `build`, `typecheck`, `lint`, `test`,
  `fixtures:qualify`, `sandbox:prepare`, `test:sandbox`, `run:agent`, `eval:live`,
  `evidence:export`, and `verify:consumer`. `test` excludes real Docker/live
  files; `test:sandbox` selects them explicitly. Disable harness file parallelism.
- [ ] Write `test/fixture-catalog.test.ts`: reject unknown IDs, missing source
  revisions, paths escaping the fixture, duplicate entries, unpinned dependencies,
  and an allowlist containing tests/configuration. Assert no solution/checks
  directory appears in the seeded file list. Run to red.
- [ ] Implement `contracts.ts` and `fixture-catalog.ts` with runtime validation.
  A manifest carries `id`, `version`, `sourcePr`, `sourceCommit`, `extractionNotes`,
  `allowedSourcePaths`, `immutablePaths`, and test command argv. Paths must be
  relative normalized regular-file paths; commands use executable/argv pairs.
- [ ] Install, build workspace dependencies, run the focused test and typecheck:
  `pnpm install`, `pnpm build`,
  `pnpm --filter @b4-example/code-fixer-server test -- test/fixture-catalog.test.ts`.
  Expected: contract tests pass. Commit `feat(example): scaffold code-fixer fixture contracts`.

## Task 2: Faithful CLI fixture

- [ ] Inspect PR #399 merge `7088072b6181e7da8b84faba35a623e444f40c94` and its
  parent. Extract only CLI registration/dispatch behavior. Pin Commander to the
  source-compatible version and preserve source license/provenance.
- [ ] Implement the tiny target CLI with the historical faulty registration.
  Its handler supports representative `consolidate --dry-run` and `prune --cap`
  behavior without a model or durable database. Unknown flags are rejected by
  the appropriate handler rather than indiscriminately forwarded as success.
- [ ] Add visible tests spawning the actual CLI and reproducing supported flag
  rejection. Add evaluator checks for value forwarding, invalid option rejection,
  global option placement, and no mutation on dry-run. Keep these outside project/.
- [ ] Implement `scripts/qualify.ts` for baseline and reference-patch copies in
  disposable execution environments. Qualification requires the intended failure
  signature before repair and all visible/additional checks after repair.
- [ ] Run `pnpm --filter @b4-example/code-fixer-server fixtures:qualify -- --task cli-flags`.
  Expected: qualification succeeds because faulty behavior is proven red and
  reference behavior green; record setup/test duration separately.
- [ ] Commit `test(example): add historical CLI flag fixture`.

## Task 3: Faithful nullable-input fixture

- [ ] Inspect `6039fd29ebd3b4aa264d3375ae5cf9d1bf0c0cac` and its parent.
  Extract the TypeScript type/schema pipeline and validator conversion, retaining
  real compiler parsing and Zod validation rather than handwritten acceptance mocks.
- [ ] Add the faulty snapshot, provenance manifest, and reference patch. Pin
  compiler/validation dependencies. Visible test: nullable tool input is rejected.
- [ ] Add independent checks for null/string acceptance, required/optional
  distinction, nested nulls, wrong primitive/object/array values, and unchanged
  non-nullable behavior. Avoid testing existing widened literal behavior as though
  the historical fix repaired it.
- [ ] Run `pnpm --filter @b4-example/code-fixer-server fixtures:qualify -- --task nullable-inputs`.
  Expected: intended failure before repair, both suites pass after reference repair.
- [ ] Run qualification for both tasks and commit
  `test(example): add nullable tool input fixture`. Checkpoint: compare measured
  fixture complexity with the spec before continuing.

## Task 4: Prepared sandbox and consistent workspace

- [ ] Write `test/seeded-provider.test.ts` to prove seeding once per thread,
  re-acquisition preserves edits, a new thread starts clean, seeding failure
  destroys owned resources, and all acquired IDs are destroyed at final cleanup.
- [ ] Implement a public `SandboxProvider` decorator around `dockerSandbox`.
  Follow `packages/workspace/src/sandbox-types.ts`: implement `acquire`, `release`,
  `destroy`, and optional `preflight`, delegating policy and AbortSignal unchanged.
  Seed using the acquired handle filesystem/exec; record handles by thread ID
  for host collection. Do not import CLI internals or use an agent tool to seed.
- [ ] Prepare a Node 24 image containing Git and both locked dependency sets.
  Resolve and record base image identity during preparation. Install dependencies
  at image-build time, not in the network-denied attempt. Initialize only the
  faulty target's Git baseline; exclude solution history and evaluator checks.
- [ ] Configure network deny, 1 CPU, 1024 MB, 120-second command timeout, and
  secure provider defaults. Explicit environment allowlist excludes host secrets.
  No host checkout or Docker socket mounts. Use example-specific env names.
- [ ] Write `test/sandbox.integration.test.ts`: the same file written through
  the workspace is read by a command, two attempts cannot see each other's files,
  keys are absent, and normal/cancelled/failed attempts remove owned volumes.
  Harness `close()` releases compute; explicitly call provider `destroy()` after
  artifact collection because release preserves volumes.
- [ ] Run `pnpm --filter @b4-example/code-fixer-server sandbox:prepare`, then
  `pnpm --filter @b4-example/code-fixer-server test:sandbox -- test/sandbox.integration.test.ts`.
  Expected: real Docker behavior passes. Commit `feat(example): isolate code-fixer workspaces`.

## Task 5: Independent patch verification

- [ ] Write `test/verifier.test.ts` before implementation. Cases: known repair
  passes; unchanged source fails; different correct repair passes; changed tests,
  locks/config, new paths, deletions outside scope, symlinks, path traversal,
  binary/oversized files, and missing receipts are rejected.
- [ ] Implement `patch.ts` by comparing actual regular file bytes with the host
  manifest, including additions/deletions. Do not trust agent-controlled Git
  metadata, a claimed diff, or test logs. Build the review diff from host baseline
  and validated source bytes. Maximum source export: 1 MiB per attempt.
- [ ] Implement `verifier.ts`: create a fresh verifier sandbox, seed original
  tests/config and authoritative checks, overlay permitted source bytes, and run
  both suites. Never execute patched code on the host. Collect exit codes/output
  and destroy the verifier in finally. Retain explicit infrastructure-failure status.
- [ ] Run focused unit tests and add real Docker checks for faulty/reference
  snapshots and test-tampering rejection. Expected: authentic fixes pass and
  weakened agent-side tests cannot influence the verdict.
- [ ] Commit `feat(example): verify patches against pristine fixtures`.

## Task 6: Agent and approval boundary

- [ ] Write scripted `test/agent.test.ts` proving real read/edit/execute calls,
  task-independent instructions, and rejection of final-answer-only success.
  Write `test/review-outbox.test.ts` proving no export before approval, denial
  creates no outbox entry, and approved export uses the host-verified prepared
  patch rather than arbitrary path/content supplied by the model. Attempt A
  cannot select or export attempt B's receipt, even with forged tool arguments.
- [ ] Author the route using the existing SDK shape:

  ```ts
  import { agent } from "@b4run/sdk"
  export default agent({
    model: process.env.B4_CODE_FIXER_MODEL ?? "gpt-5-mini",
    recursionLimit: 60,
    description: "Repairs a failing test and verifies the change.",
    tools: { approve: ["exportForReview"] },
    systemPrompt: "Read the task. Reproduce the failure before editing. Inspect the relevant code. Make a focused source change without modifying tests or configuration. Run the specified checks. Explain the patch and request exportForReview only after verification. Report failures honestly.",
  })
  ```

- [ ] Add the plan and verification skill. Scope file permissions to the target
  and commands to the prepared workflow using existing B4 policy patterns.
  Configure the seeded provider. Consult `apps/web/content/docs/permissions.mdx`
  for actual policy shapes; tests must prove ordinary fixture work does not
  accidentally pause on every operation. No automatic blanket approval.
- [ ] Implement `exportForReview.ts` as an authored tool calling host-owned
  outbox logic keyed by a runner-generated attempt ID. Run each attempt in its
  own host child process; pass its trusted artifact directory via
  `B4_CODE_FIXER_ATTEMPT_DIR`, never via model arguments or sandbox environment.
  The seeded provider associates its single active thread with that attempt.
  B4ToolContext exposes no thread ID: do not invent `ctx.threadId`. Before export,
  independently verify the current source snapshot and use that prepared receipt.
  Gate via B4 `tools.approve`, not a prompt-only instruction. Use unique outbox
  destinations; never overwrite an existing receipt.
- [ ] Run typegen/check, focused tests, and Docker approval allow/deny through
  `harness.resume` with documented interrupt entries. Expected: actual permission
  interruption before mutation. Commit `feat(example): add runnable test-fixing agent`.

## Task 7: Attempt runner and evaluation accounting

- [ ] Write `test/run-attempt.test.ts` for success, behavior failure, intentional
  approval-pending, infrastructure failure, timeout, cancellation, and artifact
  failure. Assert each attempted run appears once in the summary.
- [ ] Implement `run-attempt.ts`: fixture qualification/preflight, fresh sandbox,
  `createAgentHarness({ appRoot, route: "/fix#agent", live: true })` for live,
  scripted fixtures for offline, patch collection, independent verification,
  evidence, and cleanup. Harnesses run sequentially because they modify process
  environment/caches. A thin parent process enforces a 10-minute wall deadline;
  on timeout terminate the owned child and destroy registered owned sandboxes.
- [ ] Initial enforced live limits: 60 agent supersteps, 120 seconds per command,
  and 10 minutes per attempt. Token reporting budget: 100,000 reported tokens per
  attempt, evaluated after completion; if exceeded, record it and halt the batch
  before another attempt. This is not a hard in-flight token ceiling: the public
  harness does not expose one. If usage is unavailable, record that limitation
  explicitly; wall-time and step limits still apply. Do not add framework hooks
  or mislabel streamed text fragments as billable token counts.
- [ ] Use `runEval` with a custom `runCase` wrapping the lifecycle and deterministic
  scorers over independent receipts and trace. Test all five spec criteria and
  distinguish correctness from approval-pending execution state. Do not require
  exact patch equality or an LLM judge for deterministic correctness.
- [ ] Implement `run.ts --task <id>` and `eval.ts --attempts 3`. The first defaults
  to live with key preflight; no silent replay fallback. Approval is interactive
  only in the single-run CLI; evaluations stop before outbox export.
- [ ] Run focused tests and both scripted cases. Commit
  `feat(example): evaluate code-fixer attempts with independent receipts`.

## Task 8: Evidence bundle and run instructions

- [ ] Write `test/evidence.test.ts`: required identifiers and receipts, stable
  activity/source mapping, incomplete-run status, stripping secret values and
  private host paths, missing usage preserved as unavailable, recorded timing
  retained, and no evidence overwritten across attempts.
- [ ] Implement `evidence.ts` and `export.ts`. Bundle agent commit, fixture hash,
  model/config, image/dependency identity, actual source snapshots, activity,
  patch, checks, approval state, and timings. Refuse “successful recording” export
  for replay or failed live cases. Capture public harness results/record facilities
  without leaking raw provider headers. No homepage code in this task.
- [ ] Write READMEs with exact root commands: install/build/typegen/check,
  fixture qualification, image preparation, single live run, offline tests,
  Docker tests, evals, and evidence export. Separate target and agent file tours.
  State live key/Docker prerequisites and that recorded examples are historical.
- [ ] Run evidence tests, docs check, and scoped lint. Commit
  `docs(example): document blueprint and versioned run evidence`.

## Task 9: Consumer and live verification

- [ ] Implement `consumer.ts` to copy only the example into a temporary external
  app, replace workspace dependencies with one explicitly resolved published B4
  release, install without workspace links, and build/check/run an offline case
  plus a real Docker fixture check. Record exact versions. Do not publish a repo
  or claim current unpublished code exists on npm. If published APIs lag, report
  the consumer check as incomplete rather than substituting local package links.
- [ ] Run `pnpm --filter @b4-example/code-fixer-server verify:consumer`.
  Expected: standalone documented consumer path works on recorded versions.
- [ ] Run `pnpm --filter @b4-example/code-fixer-server eval:live -- --attempts 3`.
  This is six sequential attempts. Check key availability without printing it.
  Report every failure and measured duration/usage; do not promise all attempts
  succeed or tune against withheld cases. Any prompt change requires a fresh
  clearly identified evaluation batch.
- [ ] Export one successful live run per fixture, if available. If no run
  succeeds, retain failures and repair the application before recording; never
  replace live evidence with scripted success. Commit sanitized completion
  receipts only, with raw artifacts ignored.

## Task 10: Repository verification and review

- [ ] Run `pnpm ci:validate`, `node scripts/check-changesets.mjs`, and
  `git diff --check`. Resolve example integration/discovery failures without
  weakening root gates. Run Docker checks separately; root validate is not a
  substitute. Add a changeset only if publishable user-facing code changes.
- [ ] Request independent implementation review against the approved spec,
  especially workspace/tool correspondence, verifier independence, actual
  approval behavior, and honest evidence provenance. Fix substantive findings.
- [ ] Record exact successful commands and limitations. Open the implementation
  PR after checking active CI submission capacity. Keep homepage implementation,
  new remote repos, live issue selection, and advanced capability additions for
  their planned follow-ups. No automatic remote patch publishing from this agent.

## Completion gates

Do not call the blueprint fully verified without both qualified fixtures,
offline and real Docker tests, independent patch verification, approval tests,
consumer verification, and the six-attempt live report. Live failures may be
reported honestly as evaluation outcomes; at least one independently passing
live attempt per fixture is required for successful demonstration evidence.
Unavailable infrastructure/credentials remain explicit outstanding work.
