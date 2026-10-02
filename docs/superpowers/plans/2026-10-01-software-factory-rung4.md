# Software Factory Rung 4 Implementation Plan: An Approved Change as a Draft Pull Request

> **Amended after review (2026-10-01).** An independent review executed PR 1 and PRs 3-4 task by task in a scratch checkout (green at every task but Task 1's lint) and found no Critical issue, nine Important ones and a list of minors. Each is applied in place and listed with where in "Review amendments (2026-10-01)" at the end; the amended code was prototyped again and run green before this revision. Decisions D25-D30 were added and D2, D3 amended.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Prototyped before it was written (2026-10-01).** Every code block in Tasks 1-21 was written, formatted with Biome, typechecked and run in this worktree at `4e4941e4e`, then removed so that only this plan is committed. After the review amendments the controller's unit suite ran green (1,255 passed, 1 skipped: the replay that needs Task 21's recorded fixture) except one test that builds an image and needs Docker, which was not running on the host (`test/runtime.test.ts`, "dispatches to the one builder on its route"; it fails the same way without these changes). The workflow contract file and the evaluator's tests ran green (190 tests), and so did `pnpm test:release-integrity` (33) and the whole `pnpm test:release-controller`. What could not run here: the opt-in scratch lane (Task 21, needs Brian's app and scratch repository) and the live run (Task 23). The code is formatted as Biome left it; a task's diff hunks are against `main` at `4e4941e4e` and apply with `git apply` from the repository root unless a task says to edit by hand.

**Goal:** Approving a bundle publishes exactly that change as a draft pull request on `cacheplane/b4run`, once, from a credential only the controller holds; the factory says `delivered` only after it has read the pull request back and found its bytes, and every way that can fail is a recorded refusal, never a blind retry or a guess.

**Architecture:** Four PRs and one manual setup, in the spec's order. PR 1 adds the CI guard (every secret-bearing, deploying or writing `pull_request` job skips a `factory/*` head and the factory app's bot), proved by a behavioural contract test that evaluates each job's `if:` for a factory pull request, and makes the Vercel ignore script skip `factory/*`. PR 3 binds the delivery into the bundle digest and builds the whole delivery against an interface: a draft-PR work order records where it goes at create, freezes it into the bundle, and approval commits an outbox intent in the approval's own transaction; a worker then advances idempotent read-before-write steps (check, commit, branch, pull request, confirm) against a `DeliveryAdapter`, computing every git object id itself, and blocks with a named reason on anything it cannot reconcile. PR 4 is the transport: GitHub App JWTs, a downscoped installation token, one allow-listed request function (GET and POST only, `factory/*` refs only, draft PRs only), the real adapter, the controller's and `factory up`'s credential wiring, and an opt-in lane against Brian's scratch repository. PR 5 is the live run by hand, Brian at both gates.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), zod 4, `node:sqlite`, `node:crypto` (SHA-1 git object ids, RS256 JWT), `fetch`, vitest 4, `node:test` and the `yaml` package for the workflow contract test, GitHub REST and GraphQL APIs, Bash (the Vercel ignore script).

**Spec:** [`2026-10-01-software-factory-rung4-design.md`](../specs/2026-10-01-software-factory-rung4-design.md) (APPROVED). Its §15 open decisions are carried as D4-D13 below.

**Base:** `main` at `216befd5a` with the spec at `4e4941e4e` (`blove/factory-rung4-spec`). Paths are relative to `examples/software-factory/controller/` unless they start with `examples/`, `docs/`, `scripts/`, `apps/`, `packages/` or `.github/`.

---

## Decisions

**Decided 2026-10-01: Brian accepted every recommendation below (D1-D30, including the review amendments' D25-D30).** "*Decided:*" now reads as "*Decided:*"; the tasks implement exactly these.

**D1. The PR numbering.** *Decided:* the user-facing numbering, mapped to the spec's sub-projects: **PR 1** = spec sub-project 1 (CI guards); **the operator setup** = spec "Operator setup"; **PR 3** = sub-project 2 (delivery bound in the bundle, controller only); **PR 4** = sub-project 3 (the GitHub adapter); **PR 5** = sub-project 4 (the live run). There is no PR 2: the setup is not a PR. PR 1 and PR 3 run in parallel worktrees; PR 4 needs PR 3; PR 5 needs everything, and **PR 1 must be merged before any `factory/*` branch exists on `cacheplane/b4run`** (Task 23 Step 1 checks it).

**D2. One statement of the guard, read by both sides.** *Decided (amended, D30):* `src/lib/delivery/guard.json` holds the branch prefix (`factory/`), the bot login (`b4-factory[bot]`), the delivery-protected paths (what a candidate may never change) and, separately, the run-from-branch paths (what `main` must not have changed since the pin). The controller reads it (`guard.ts`); the workflow contract test reads it and evaluates every guarded job against it. Renaming the app means editing one JSON value and the three workflow `if:`s, and the contract test fails until both agree. Blocks PR 1 (it lands there, as data).

**D3. A behavioural guard test, and the triggers that would bypass it.** *Decided (amended after review, I1):* the contract test does not search the `if:` text. A ~250-line evaluator for the GitHub expression language (`scripts/release/test/github-expression.mjs`, fails closed on anything it does not understand) evaluates each guarded job's `if:` **three-valued** for three factory pull requests (the bot on `factory/*`, a person on `factory/*`, the bot on another branch): the context states only what a factory PR fixes (the event name, the repository, the head ref as `head.ref` and `head_ref`, and the author) and everything else (every job output, `failure()`, `success()`, `cancelled()`, `github.actor`, any other property) is UNKNOWN; the job passes only if its `if:` is **definitely false**. So a secret job gated on `needs.x.outputs.y == 'true'` or on `failure()` is caught, as is a guard behind an `||`. A person's ordinary PR (every context known) must still run the three guarded jobs. Triggers are an **allow-list**: `pull_request`, `push` with `branches: [main]` exactly, `schedule`, `workflow_dispatch`, `workflow_call`, `branch_protection_rule`; anything else fails (`issue_comment`, `pull_request_review`, `create`, `pull_request_target`, `workflow_run`, `repository_dispatch`, …: each can run with secrets for an event a PR causes, and several run with `github.event.pull_request` null, which makes `!startsWith(null, 'factory/')` true). A job calling a **local reusable workflow** takes the reasons of the called workflow's jobs; a non-local `uses:` is a reason in itself. Every `pull_request` workflow must declare a **top-level `permissions`** block. Verified today: the 13 workflows use only allowed triggers, every `push` is `main`-only, and every `pull_request` workflow declares permissions (Today row 11). Blocks PR 1.

**D4. The app's name and bot login** (spec §15 item 1). *Decided:* `b4-factory`, so `b4-factory[bot]`. Blocks PR 1 (the login is in `guard.json` and the three `if:`s) and the operator setup.

**D5. `issues: read` on the app** (§15 item 2). *Decided:* grant it. The adapter mints every token downscoped to `contents: write`, `pull_requests: write`, `metadata: read`, `issues: read`, and refuses a token granted less (Task 18), so without it every delivery blocks `delivery_unauthorized`. The scratch lane shows whether reading a public issue needs it; if it does not, drop it from `DELIVERY_PERMISSIONS` and the setup in one follow-up commit. Blocks the operator setup and PR 4.

**D6. The issue-closed policy** (§15 item 3). *Decided:* as the spec designs it: `issueStateAtCreate` is recorded (the CLI reads it with `gh issue view --json …,state`), and step (a) refuses `delivery_issue_closed` only for an issue open at create and closed now; a replay of an issue closed at create proceeds, never asks GitHub, and the PR body says the issue was already closed. Blocks PR 3.

**D7. The bypass list** (§15 item 4). *Decided:* before enabling on `cacheplane/b4run`, list who pushed refs in the last 90 days (Task 4 Step 2 does it read-only). Read on 2026-10-01 from the last 100 events: `blove` (branches and `main` merges), `github-actions[bot]` (`changeset-release/main`, which `version-pr.yml` pushes with `RELEASE_GITHUB_TOKEN`, and the release tags), `dependabot[bot]`. So the bypass list is the Admin, Maintain and Write repository roles, the GitHub Actions app and Dependabot; enable on the scratch repository first, then on `cacheplane/b4run`, then watch one release ceremony. If a release identity cannot be named, scope the confining rulesets to `main` and `v*` tags only and record the remaining branches as a residual. Blocks the operator setup.

**D8. Draft from the start** (§15 item 5). *Decided:* yes: `POST /pulls` with `draft: true`, and the allow-list refuses any other (Task 17). Blocks PR 4.

**D9. Retry numbers** (§15 item 6). *Decided:* five attempts per step, at most 60 s per wait, ten minutes per worker run, `5xx` backoff from 2 s doubling (`DEFAULT_DELIVERY_LIMITS`, Task 11). Revisit after the live run. Blocks PR 3.

**D10. `redeliver`** (§15 item 7). *Decided:* `factory redeliver <id>` shows what the resumed delivery will publish and takes the bundle digest's first eight hex digits at a terminal (or `--digest <full>`), the controller allows it only for `delivery_unauthorized`, `delivery_rate_limited` and `delivery_unconfirmed`, at the displayed revision and bundle digest, within 24 hours of the approval (`redeliverWindowMs`); `run` never redelivers and its source pin forbids it (Task 15). Blocks PR 3.

**D11. Adopt or merge directly** (§15 item 8). *Decided:* as the spec recommends: a change touching a publishable package is adopted onto a person's branch (changeset, `vercel-native`, `claude-review` all run there); a change touching only examples, docs or scripts may be merged as is. A person's policy, written into the README (Task 16); no code. Blocks PR 5.

**D12. Vercel-side protection** (§15 item 9). *Decided:* keep the ignore script as the gate (tested and delivery-protected); in the setup, look for a Vercel Git setting that excludes `factory/*` at the project or team level and enable it as a second layer if one exists (Task 4 Step 6). Blocks the operator setup.

**D13. The live run's issue** (§15 item 10). *Decided:* a small open issue in a package with a prepared target (`devkit` or `cli`), chosen the day of the run at `main`'s tip. Blocks PR 5.

**D14. The worker owns the sequence and the hashes; the adapter only carries requests.** *Decided:* the spec puts "the Git Data API sequence with local hash computation" in sub-project 3. This plan puts the sequence, the git object ids (`git-objects.ts`, proved against real `git`), the PR body, the retry policy and the scrubber in PR 3, behind a `DeliveryAdapter` interface, and tests every fault against an in-memory repository. PR 4 then only maps HTTP to that interface. The judgement (what is ours, what conflicts, what proves delivery) is then tested once, in PR 3, and cannot drift between adapters. Blocks PR 3.

**D15. Two more reads on the allow-list.** *Decided:* `GET /app` (with the JWT) and `GET /users/<bot login>` (with the token), neither in spec §6.2. The first is how the adapter learns the bot login, which preflight compares with `guard.json` (an app named anything but the guarded login refuses before anything is written). The second gives the bot's numeric id, which makes the commit identity `<id>+<slug>[bot]@users.noreply.github.com` and lets the worker pass author, committer and the approval's time, so a repeated create usually yields the same commit (spec §5.2 (b)). Both are GETs; `GET /users/` is refused for any login but the bot's. Also `GET /pulls` carries `per_page=100` so one page holds every PR on one head. Blocks PR 4.

**D16. The controller takes the key only as a file.** *Decided:* spec §8.2 lets a hand-started controller take `FACTORY_GITHUB_APP_PRIVATE_KEY` (the PEM inline) "for tests". Refuse it by name instead (`RETIRED` in `config.ts`, with the remedy): a key in the controller's environment is inherited by every `git` and `docker` child it spawns until something deletes it, and the tests do not need it (they generate a key and write a 0600 file). `factory up`'s `privateKeyEnv` form still works: `up` writes the file. Blocks PR 4.

**D17. The controller learns its destination from two more variables.** *Decided:* spec §8.2 gives the controller only `FACTORY_GITHUB_APP_ID` and `FACTORY_GITHUB_APP_PRIVATE_KEY_FILE`, but `create` must refuse a repository other than the configured one and approve must compare the configured base, so `up` also passes `FACTORY_DELIVERY_REPOSITORY` and `FACTORY_DELIVERY_BASE_BRANCH`. The controller needs all four or none. The two credential variables are deleted from `process.env` the first time the runtime reads them. Blocks PR 4.

**D18. The quoted spec is captured at approval.** *Decided:* spec §7.2 re-reads `spec.md` at render (step (d)). Instead, approve reads the generated task once with `readGeneratedTask` (the files and the digest of exactly those bytes), refuses unless the digest is the frozen `taskDigest`, and stores `spec.md`'s text in the outbox intent. A resumed worker then renders from frozen data only and never reads a file a person can edit. Blocks PR 3.

**D19. Reconcile starts a delivery; it does not wait for it.** *Decided:* `reconcileWorkOrder` case `delivering` starts the worker tracked and returns: `factory up` bounds its boot reconcile at 120 s, and a delivery can wait on GitHub for ten minutes. `approve` and `redeliver` still await their worker. Blocks PR 3.

**D20. Where the delivery configuration lands.** *Decided:* PR 3 has no configuration at all (the factory takes `delivery` as an option, the runtime passes none, so `--deliver draft-pr` is refused with `delivery_unavailable` in a PR 3 build); `factory.config.ts`'s `delivery` block, the controller's variables and `up`'s wiring all land in PR 4 with the adapter they configure. Blocks PR 3 and PR 4.

**D21. Approval's order of checks.** *Decided:* the spec's four checks (§3.4), with the protected-path check before the preflight: delivery equality, configured destination, protected paths (no network), preflight (network), then the generated task re-read, then the re-verification. A refusal before the re-verification costs seconds. Blocks PR 3.

**D22. Three rulesets, not two.** *Decided:* a ruleset targets branches or tags, not both, so spec §10.2's "factory app confined" is two rulesets ("factory app confined: branches", "factory app confined: tags") beside "factory branches are append-never" (Task 4). Blocks the operator setup.

**D23. What `approve` answers for a draft-PR bundle.** *Decided:* `ok: true` only when the work order is `delivered`; a delivery that blocks returns `ok: false` with the reason, and the approval stays recorded (the approval happened; the publication did not). The CLI's `approve`, `review` and `run` exit 1 on it and print `pnpm factory events <id>` and, when the reason allows, `pnpm factory redeliver <id>` (approve's and review's outcome carries them as `next`, the list `run` prints, from one helper, `blockedNext`). Blocks PR 3.

**D24. Cancel during a delivery.** *Decided:* accept today's `finishCancel` for a `delivering` row (it asks the builder about the row's old thread, exactly as it does for `exporting`); the worker checks the row before every write and journals `delivery_stopped` with the remote ids that exist. A cancel that waits on an unreachable builder stays `cancel_requested` until reconcile, as it does today. Follow-up recorded. Blocks PR 3.

**D25. A per-request timeout of 30 s.** *Decided (added after review, I4):* every GitHub request runs under `AbortSignal.any([the controller's signal, AbortSignal.timeout(30_000)])` (`requestTimeoutMs`, default 30 000); a timeout is a transient failure the step retries within D9's bound. A hung connection otherwise holds the worker past its ten-minute bound, which is only checked between attempts. Blocks PR 4.

**D26. A controller closing mid-delivery leaves it `delivering`.** *Decided (added after review, I3):* an abort of the controller's signal (close, or a stop between steps) is never a refusal: the worker journals `delivery_stopped` with the step and the remote ids it observed and returns; the row stays `delivering`, and the next boot's reconcile resumes it (D19). Before this, an abort mid-request rethrown as a non-`DeliveryError` reached the catch-all and blocked `delivery_unconfirmed` (spiked by the reviewer). Blocks PR 3 and PR 4.

**D27. The adapter is bound to one repository, and so is every start.** *Decided (added after review, I9):* `createGitHubAdapter({ repository, … })` refuses `open()` for any other repository (`unauthorized`), and `startDelivery` (the one path approve, reconcile and redeliver share) refuses, as `delivery_unauthorized`, an intent whose repository or base is not the controller's configured one: a controller restarted with another destination cannot deliver an older approval there. Blocks PR 3 and PR 4.

**D28. No redirects.** *Decided (added after review, I5):* `fetch` is called with `redirect: "manual"` and a 3xx is `unexpected` (blocks `delivery_unconfirmed`, redeliverable): a followed redirect would send the request and the token to a URL the allow-list never checked. The reviewer suggested `redirect: "error"`; `manual` refuses the same and gives the journal the status instead of a bare `fetch failed`. The allow-list also refuses any `.`, `..`, empty or percent-encoded separator segment, and the request checks that `new URL(...)`'s origin and pathname are exactly what was checked (the reviewer's probe reached `/repos/repos/other/secret/contents/x` through a branch name of `..`). Blocks PR 4.

**D29. No issue reference in model-written text.** *Decided (added after review, I6):* `pullTitle` and the commit subject break every issue reference (`#77` → `# 77`, `GH-77` → `GH 77`, an issue or pull URL → `issues 77`), so no closing keyword (`close[sd]?`, `fix(e[sd])?`, `resolve[sd]?`) before one can close anything when a squash merge takes the title as its subject. The words themselves ("Fix the timer") stay readable; the reviewer also asked to neutralise the keywords, which is unnecessary once no reference survives (a keyword alone closes nothing) and would mangle ordinary titles. The body's own `Refs #<n>` is the factory's and stays. Blocks PR 3.

**D30. `guard.json`'s two lists.** *Decided (added after review, I2):* `protectedPaths` (`.github/**` and the two Vercel files) is what a candidate may never change, checked at intake, at approval, and again at step (a) (I8). `runFromBranchPaths` (only `apps/web/vercel.json` and `apps/web/scripts/vercel-ignore-build.sh`) is what `main` must not have changed since the pin: those run from the branch's own commit (Vercel builds it with the pin's ignore script). `.github/**` is not in it: a pull request runs `main`'s workflows at the merge commit, so a workflow change on `main` since the pin is harmless, and `main` had 41 commits touching `.github` in the month before 2026-10-01, which under spec §9.3 as written would have blocked almost every delivery permanently. The contract test pins the second list to the two Vercel files and requires it to be inside the first. Blocks PR 1 and PR 3.

## Today, verified

Read at `4e4941e4e` (its code is `216befd5a`'s; the spec commit touched only the spec). Paths as in the header.

| # | Fact the plan rests on | Where | Holds? |
|---|---|---|---|
| 1 | The bundle's operation is a literal, the digest covers the whole payload | `src/lib/review/bundle.ts:23-24`, freeze at `:92`; `src/lib/domain/digest.ts:115`, `:127-132` | Yes |
| 2 | Freeze names the export directory and the task id | `src/lib/controller/verify.ts:262` (freeze), `:264` (`repositoryId: row.taskId`), `:270` (`destinationId: ctx.exportDir`) | Yes; `repositoryId` stays (spec §2.1) |
| 3 | Approve: window, destination check, re-verification, approval transaction, export, delivery record | `src/lib/controller/factory.ts:1494` (`approve`), `:1526` (TTL), `:1611` (destination), `:1658` (verify), `:1724` (`transition(id, "approve")`), `:1734` (export), `:1753` (`recordDelivery`) | Yes |
| 4 | Reconcile never re-exports; `settledOk` names the terminal successes | `src/lib/controller/reconcile.ts:584` (`reconcileExporting`), `:127` (`settledOk`), `:227` (`case "exporting"`) | Yes; `delivered` added to `settledOk` (Task 13) |
| 5 | The registry is at schema 5; `deliveries` has four columns | `src/lib/registry/db.ts:5`, `:91-96`; store `src/lib/registry/work-orders.ts:83` (`COLUMNS`), `:269` (`recordDelivery`) | Yes; migration 6 (Task 6) |
| 6 | `create --issue` reads `title,body,url` with the operator's `gh` | `src/lib/intake/issue.ts:45` (schema), `:84` (fields); `src/cli.ts:596` (`issueCreateInput`), `:1546` (`create`), `:1441` (`parseArgs`), `:1650` (`show`), `:1662` (`list`) | Yes; `state` read only for a draft PR (Task 15) |
| 7 | `run`'s step table, its `exported` done and `chooseWorkOrder` | `src/lib/operator/run-steps.ts:81`, `:117`, `:160` | Yes |
| 8 | `run`'s source pin lists every helper `run` reaches and the calls none may make | `test/run-steps.test.ts:197-205` (`FORBIDDEN`), `:356-395` (`RUN_REACHES`) | Yes; Task 15 adds `deliverOption` and forbids `.redeliver` |
| 9 | `up` gives workers every variable but four, the controller a deny-listed set, and redacts two secrets | `src/lib/operator/up.ts:182` (`NOT_INHERITED`), `:189` (`controllerMayNotSee`), `:192` (`appProcesses`), `:248` (`preflight`), `:716` (`redactor`), `:38` (`ownSubprocessEnv`) | Yes; Task 20 |
| 10 | The guarded jobs and their current `if:`s | `.github/workflows/ci.yml:702-711` (`vercel-native`, environment `vercel-preview`), `.github/workflows/auto-approve.yml:24`, `.github/workflows/claude-review.yml:36` | Yes |
| 11 | No other `pull_request` job holds a secret, an environment or a write (but `codeql`'s `security-events`); no local reusable workflow is called; every trigger is in D3's allow-list; every `push` is `branches: [main]`; every `pull_request` workflow declares top-level `permissions` | A probe of the evaluator over all 13 workflows before the edits reported exactly the three jobs of row 10, three times each, and every `if:` evaluated; after Task 3 the three-valued check reports nothing | Yes |
| 12 | The audited fixture pins each job's `if:` as the YAML-parsed string | `scripts/release/test/fixtures/workflow-entrypoints.json:22` (`auto-approve`), `:1735` (`vercel-native`, a folded scalar keeping the more-indented line's `\n`), `:1884` (`claude-review`) | Yes; `workflow-safe-executables.json` holds no `if:` and no step changes, so it does not move |
| 13 | The `vercel-preview` environment admits `main` and `refs/pull/*/merge` | `gh api repos/cacheplane/b4run/environments/vercel-preview/deployment-branch-policies` (2026-10-01) | Yes |
| 14 | No rulesets today; `delete_branch_on_merge` and `allow_auto_merge` on; the repository is public | `gh api repos/cacheplane/b4run/rulesets` → `[]`; `gh api repos/cacheplane/b4run` | Yes |
| 15 | The Vercel ignore script runs under `bash` (it uses arrays: `dash -n` fails on it today) and its test runs it with `bash` | `apps/web/vercel.json:4`, `apps/web/scripts/vercel-ignore-build.sh`, `apps/web/app/vercel-ignore-build.test.ts:54` | Yes |
| 16 | An export-local bundle's digest does not move | The freeze at `216befd5a` and the freeze after Task 7 give the same digest for one fixed input, `c7c751845529b7250882912d501ae38fa97e4db80ca0299157c32ba7d69008e6` (run with both sources) | Yes; pinned in Task 7 |
| 17 | `git ls-tree`'s order and modes are what `treeId` must reproduce | Task 8's test computes blob and tree ids of a real repository with every mode (`100644`, `100755`, `120000`, `040000`) and a multibyte file, and predicts a change's root tree before committing it | Yes |

## Spec corrections

1. **§13 numbering**: the user-facing PR numbers differ from the spec's sub-project numbers (D1).
2. **§13 sub-project 3, "the Git Data API sequence with local hash computation"**: the sequence, the hashing, the PR body, the retry policy and the scrubber are PR 3's, behind an interface (D14).
3. **§6.2 allow-list**: add `GET /app` (JWT) and `GET /users/{bot}` (token), and `per_page=100` on the head listing (D15). The listing of a branch name in a path is unencoded (`git/ref/heads/factory/wo-…`, `rules/branches/factory/wo-…`); the scratch lane confirms GitHub accepts it.
4. **§6.4 "the response does not report truncation"**: the compare API has no truncation flag; it stops at 300 files. The adapter calls a comparison complete when it lists fewer than 300 (`complete: files.length < 300`).
5. **§7.2 "re-read and re-digested at render"**: captured at approval with its digest checked, stored in the intent (D18).
6. **§5.4 "resumes the worker"**: started, not awaited (D19).
7. **§8.2 environment**: four controller variables, not two; the inline-PEM variable is refused, not accepted (D16, D17).
8. **§9.4 the guard test**: behavioural, against `guard.json`, plus the trigger refusals (D2, D3). The bot login and the protected paths come from `guard.json`, which is what "the test reads both" becomes.
9. **§10.2 rulesets**: three, not two (D22).
10. **§3.4 order**: protected paths before preflight (D21).
11. **§9.4 "`workflow-safe-executables.json` is checked and changes only if a step does"**: checked; no step changes, so it does not move.
12. **§3.2 `pathPrefix`**: nullable on the row until intake fills it in the `intake_drafted` transaction; the bundle requires it, and `verify` refuses (as `verification_inconclusive`) a draft-PR row without one.
13. **§9.3 item 3 and §6.4 "`main`'s changes since the pin must not touch a protected path"**: only the run-from-branch paths (the two Vercel files), not `.github/**` (D30). The change's own paths are checked against the full protected list again at step (a).
14. **§6.2 "refused before a socket opens"**: also refused are dot, empty and encoded-separator segments, a URL that resolves elsewhere, and any redirect (D28); and every request has a 30 s bound (D25).
15. **§6.5 and §12 "Controller killed mid-step"**: a close mid-request stays `delivering` (D26), it does not block.
16. **§7.1 "cannot carry a closing keyword's effect because GitHub does not link issues from titles"**: a squash merge makes the title the commit subject, where a keyword does close; the title's references are broken (D29).

## PR split

| PR | Branch | Tasks | Size | Merge gate |
|---|---|---|---|---|
| PR 1, CI guards | `blove/factory-ci-guards` | 1-3 | S | `validate` (the `source-validate` lane runs the web test; the `release-controller` lane runs the contract test) |
| Operator setup (Brian) | none | 4 | by hand | Task 4's checklist read back with `gh api` |
| PR 3, delivery bound in the bundle | `blove/factory-delivery-bundle` | 5-16 | L (one package, example-only) | `validate` |
| PR 4, the GitHub adapter | `blove/factory-github-adapter` | 17-22 | M | `validate`; Task 21 Step 3 run by hand with Brian's credentials before merge |
| PR 5, the live run | none (records evidence in the spec) | 23 | by hand | Brian at both gates |

No changeset in any PR: only `examples/`, `scripts/release/test/`, `.github/workflows/` and `apps/web/scripts`+test change, none of them a published package. PR 1 edits `apps/web` outside its routes' sources (`scripts/` and a test), so `seo:lastmod` does not move (checked: `pnpm --dir apps/web seo:lastmod:routes` passes with the change). PR 1 is the only PR that edits a workflow; no release-reachable script changes anywhere, so `release-script-hashes.json` does not move.

## File structure

| File | PR | Responsibility |
|---|---|---|
| `scripts/release/test/github-expression.mjs` (new) | 1 | Evaluator for GitHub `if:` expressions, fail-closed |
| `scripts/release/test/github-expression.test.mjs` (new) | 1 | Its semantics |
| `scripts/release/test/factory-guard.mjs` (new) | 1 | Which jobs need the guard; does each skip every factory PR; forbidden triggers |
| `scripts/release/test/workflow-contracts.test.mjs` | 1 | The guard test, with mutation cases and the protected-path cross-check |
| `scripts/release/test/fixtures/workflow-entrypoints.json` | 1 | The three `if:`s, as parsed |
| `.github/workflows/{ci,auto-approve,claude-review}.yml` | 1 | The guard |
| `apps/web/scripts/vercel-ignore-build.sh`, `apps/web/app/vercel-ignore-build.test.ts` | 1 | Skip `factory/*` first |
| `src/lib/delivery/guard.json` (new) | 1 | Branch prefix, bot login, protected paths: the one statement |
| `src/lib/domain/states.ts` | 3 | `delivering`, `delivered`, events, seven reasons, `REDELIVERABLE_BLOCKED_REASONS` |
| `src/lib/domain/work-order.ts` | 3 | `BRANCH_PATTERN`, `FACTORY_BRANCH`, `RowDeliverySchema`, row `delivery`, `PullRequestReceiptSchema`, `redeliver` command |
| `src/lib/registry/{db,work-orders,reader}.ts` | 3 | Migration 6; the `delivery` column; PR receipt columns; reader `delivery()`, `outbox()` |
| `src/lib/review/bundle.ts`, `src/lib/domain/digest.ts` | 3 | The operation union, `freezeBundle` with `delivery`, `draftPrDestinationId` |
| `src/lib/delivery/git-objects.ts` (new) | 3 | Blob and tree ids, the pin's listings, the predicted tree |
| `src/lib/delivery/outbox.ts` (new) | 3 | Intent and remote schemas, the outbox store |
| `src/lib/delivery/adapter.ts` (new) | 3 | `DeliveryAdapter`, `DeliverySession`, `DeliveryError` |
| `src/lib/delivery/guard.ts`, `scrub.ts`, `pr-body.ts` (new) | 3 | The guard's paths; the scrubber; title, body, commit message |
| `src/lib/delivery/worker.ts` (new) | 3 | The steps, the retry bound, refusals |
| `src/lib/delivery/approval.ts` (new) | 3 | `DraftPrConfig`, protected changes, preflight, the intent |
| `src/lib/controller/{factory,context,intake,verify,reconcile}.ts` | 3 | Create, fit, freeze, approve, start, reconcile, redeliver |
| `src/lib/domain/errors.ts`, `src/lib/routes/{input,outcome}.ts`, `src/app/work-orders/{create,redeliver}/index.ts`, `src/lib/client.ts` | 3 | `--deliver` at the controller; the `redeliver` route |
| `src/lib/intake/issue.ts`, `src/lib/review/operator-review.ts`, `src/lib/operator/run-steps.ts`, `src/cli.ts` | 3 | The issue's state; the review's delivery block; `run` and `redeliver` |
| `test/fake-delivery-adapter.ts`, `test/delivery-harness.ts`, `test/issue-work-order.ts` (new) | 3 | The in-memory GitHub; the worker harness; an issue work order at the gate |
| `src/lib/delivery/github/{jwt,http,adapter}.ts` (new) | 4 | The app's JWT and key; the allow-listed request; the real adapter |
| `src/lib/config.ts`, `src/lib/runtime.ts` | 4 | The four variables; wiring; consuming them |
| `src/lib/operator/{factory-config,up}.ts` | 4 | `delivery.draftPr` config; `up`'s key file, environments, redaction |
| `test/fake-github-server.ts`, `test/github-contract.ts` (new), `vitest.github.config.ts` (new) | 4 | GitHub's shapes on loopback; the recorded contract; the scratch lane's config |
| `examples/software-factory/README.md`, the spec | 3, 4, 5 | Operator docs; as-landed notes |

## Traps (read before starting)

1. **Node 24 and the build closure.** `source ~/.nvm/nvm.sh && nvm use 24` before anything; after install and every rebase, `pnpm turbo run build --filter=@b4-example/software-factory-controller^...` (the controller imports `@b4run/*` `dist/`).
2. **Never `git stash`; add files by path; never bare `biome check --write`.** Root lint for `scripts/`: `pnpm exec biome check --config-path packages/config-biome/biome.json <files>`. Controller: `pnpm --filter @b4-example/software-factory-controller exec biome check --write <the task's files>`. `apps/web` is linted with the shared config too (two spaces, no semicolons): run `pnpm --dir apps/web lint`, never `pnpm --dir apps/web exec biome …` without `--config-path ../../packages/config-biome/biome.json` (apps/web has no Biome config of its own, and Biome's built-in defaults, tabs and semicolons, would reformat the whole file; the first revision of this plan made exactly that mistake).
3. **`exactOptionalPropertyTypes`.** Spread optional fields conditionally (`...(x !== undefined ? { x } : {})`).
4. **An export-local payload must carry no `delivery` key at all.** `canon` refuses `undefined`, and an empty key would move every local bundle's digest. Task 7 pins the digest of a fixed input to the value the `216befd5a` freeze produced.
5. **A workflow edit moves `workflow-entrypoints.json` in the same commit.** The fixture holds each `if:` as the YAML parser returns it: a `>-` folded scalar joins lines with a space, except a more-indented line, which keeps its `\n` (that is why `vercel-native`'s `if:` has `&&\n github…`). Copy the strings Task 3 gives, or print them with the `node -e` command there; never type them. Run `node --test scripts/release/test/workflow-contracts.test.mjs` and `pnpm test:release-integrity` first, then `pnpm test:release-controller` (AGENTS.md).
6. **A plain YAML scalar starting with `!` is a tag.** Every guarded `if:` is written as a `>-` block scalar; never `if: !startsWith(…)`.
7. **No secret in a test fixture, a log line, argv or a child's environment.** Tests generate RSA keys at run time (`generateKeyPairSync`); never commit a PEM (secret scanning flags it) and never print one (CodeQL `js/clear-text-logging` flags a logged value derived from a key or token, fixtures included). Messages name a variable or a path, never a value. Assertions about leaks scan the journal and the outbox (`h.journal()`), not stdout dumps.
8. **The guard must be on `main` before a `factory/*` branch exists on `cacheplane/b4run`.** Only Task 23 creates one, and its Step 1 checks the guard is on `main` first. The scratch lane writes only to the scratch repository.
9. **Real GitHub is never reached by a default test.** Every adapter test passes `baseUrl` (the fake server); the scratch lane is a separate vitest config, excluded from the unit run, and skips without its variables.
10. **Docker.** `test/runtime.test.ts` "dispatches to the one builder on its route" builds an image; with no Docker daemon it fails before and after these changes. Not a regression; do not "fix" it.
11. **`run`'s source pin.** `test/run-steps.test.ts` pins the helpers `run` reaches (`RUN_REACHES`) and the calls none of them may make (`FORBIDDEN`). Task 15's `deliverOption` must be added to the first, and `.redeliver` to the second.
12. **Registry version text.** `test/registry-db.test.ts` and `test/registry-reader.test.ts` pin "needs (5)" and the table list; Task 6 updates them with the migration.
13. **A regex `$` and `.` stop at U+2028.** Take a heading by splitting on `\n` (Task 10's `pullTitle`), or a model-written line separator cuts the title short.
14. **`gh` reports issue state as `OPEN`/`CLOSED`.** `fetchIssue` maps them; a stubbed `gh` in a CLI test must print `state` when the test passes `--deliver draft-pr`.
15. **The delivery's writes are only the five the approval authorized.** The worker tests assert `fake.writes()` exactly; a new write call anywhere fails them. The adapter has no update, delete, merge or close; the allow-list test sweeps PATCH, PUT and DELETE.
16. **Rate-limit waits use the injected sleep and clock.** Never the factory's `now` (an injected test clock would freeze the bound), never a real sleep in a unit test.
17. **The outbox is one row per work order.** A second approval of a delivered or blocked work order is refused by state before anything is inserted; a replayed approve key returns the recorded outcome.
18. **A served controller boots lazily.** The credential variables are consumed on the first `controllerRuntime()` call, which is the first route request, before any `git` or `docker` child; `/readyz` does not open the factory.
19. **Lint warnings for `${{` in strings.** Biome's `noTemplateCurlyInString` warns on `"${{ … }}"`; use the contract file's `workflowExpression(...)` or an escaped template literal (`` `\${{` ``), as the code below does.
20. **Never `pkill -f`; never destructive Docker or `gh` writes.** The scratch lane's raw probes write only to the scratch repository, and only with the app's token.
21. **An abort is a stop, never a refusal (D26).** Anything awaiting GitHub in the worker can reject with an `AbortError` when the controller closes; `attempt` and `runDelivery`'s catch check `ctx.signal.aborted` first. A test that closes mid-request must see the row still `delivering`.
22. **A failing assertion prints its operands.** Assert `includes(...) === false`, never `expect(env).not.toContain(key)`, where the operand holds a key or token (Task 20's tests): vitest would print the key on failure.
23. **`fetch` normalises and follows.** Never hand `fetch` a path the allow-list has not checked in its final form (D28); the request function builds the `URL`, compares it, and passes the `URL` object.

---

# PR 1: CI guards

```bash
git fetch origin
git switch -c blove/factory-ci-guards origin/main
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
node --test scripts/release/test/workflow-contracts.test.mjs   # green before any change
```

### Task 1: The guard's one statement, and the Vercel preview never builds `factory/*`

**Files:**
- Create: `examples/software-factory/controller/src/lib/delivery/guard.json`
- Modify: `apps/web/scripts/vercel-ignore-build.sh`
- Test: `apps/web/app/vercel-ignore-build.test.ts`

- [ ] **Step 1: Write the failing test.** Apply the test hunk (one case before "always builds production", in the file's own style: two spaces, no semicolons, Trap 2):

```diff
diff --git a/apps/web/app/vercel-ignore-build.test.ts b/apps/web/app/vercel-ignore-build.test.ts
index 1c798c465..473b5e2b5 100644
--- a/apps/web/app/vercel-ignore-build.test.ts
+++ b/apps/web/app/vercel-ignore-build.test.ts
@@ -71,6 +71,20 @@ describe("website Vercel ignore-build step", () => {
     expect(config.ignoreCommand).toBe("bash scripts/vercel-ignore-build.sh")
   })
 
+  it("never builds a software factory branch, whatever changed and even as production", () => {
+    const repo = monorepo()
+    commit(repo, { "packages/sdk/index.ts": "v2", "apps/web/page.tsx": "v2" })
+    expect(decide(repo, { VERCEL_GIT_COMMIT_REF: "factory/wo-0123456789abcdef" })).toBe(SKIP)
+    expect(
+      decide(repo, {
+        VERCEL_GIT_COMMIT_REF: "factory/wo-0123456789abcdef",
+        VERCEL_ENV: "production",
+      }),
+    ).toBe(SKIP)
+    // Only the prefix: a person's branch that merely mentions the factory still builds.
+    expect(decide(repo, { VERCEL_GIT_COMMIT_REF: "blove/factory-guards" })).toBe(BUILD)
+  })
+
   it("always builds production", () => {
     const repo = monorepo()
     commit(repo, { "docs/notes.md": "v2" })
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --dir apps/web exec vitest run app/vercel-ignore-build.test.ts`
Expected: FAIL, "never builds a software factory branch…": expected 1 to be 0 (the change to `packages/` builds today).

- [ ] **Step 3: Skip `factory/*` first in the script**

```diff
diff --git a/apps/web/scripts/vercel-ignore-build.sh b/apps/web/scripts/vercel-ignore-build.sh
index d17f51ba6..ad51bd91c 100755
--- a/apps/web/scripts/vercel-ignore-build.sh
+++ b/apps/web/scripts/vercel-ignore-build.sh
@@ -8,6 +8,18 @@
 # only when something the site is built from changed. Production always builds.
 set -u
 
+# The software factory's branches never build here: a factory/* branch holds model
+# output no person has merged, and a preview build runs it with the project's
+# environment. This file is a delivery-protected path the factory cannot change
+# (rung 4 spec §9.2-§9.3), and this check comes first so nothing below can be
+# reached by one.
+case "${VERCEL_GIT_COMMIT_REF:-}" in
+  factory/*)
+    echo "Software factory branch ${VERCEL_GIT_COMMIT_REF}: never built on Vercel."
+    exit 0
+    ;;
+esac
+
 if [ "${VERCEL_ENV:-}" = "production" ]; then
   echo "Production deployment: building."
   exit 1
```

- [ ] **Step 4: Add the guard's statement** (data only in this PR; the controller reads it from PR 3 on, the contract test from Task 3):

`examples/software-factory/controller/src/lib/delivery/guard.json`:

```json
{
  "branchPrefix": "factory/",
  "botLogin": "b4-factory[bot]",
  "protectedPaths": [
    ".github/**",
    "apps/web/vercel.json",
    "apps/web/scripts/vercel-ignore-build.sh"
  ],
  "runFromBranchPaths": ["apps/web/vercel.json", "apps/web/scripts/vercel-ignore-build.sh"]
}
```

- [ ] **Step 5: Run the test and the route check**

Run: `pnpm --dir apps/web exec vitest run app/vercel-ignore-build.test.ts && pnpm --dir apps/web seo:lastmod:routes && pnpm --dir apps/web lint && bash -n apps/web/scripts/vercel-ignore-build.sh`
Expected: 11 passed; the routes check exits 0 (no route's sources changed); lint clean ("No fixes applied"); `bash -n` silent. (Do not check with `dash -n`: the script uses Bash arrays and always has, Today row 15.)

- [ ] **Step 6: Lint and commit**

```bash
pnpm --dir apps/web lint
git add apps/web/scripts/vercel-ignore-build.sh apps/web/app/vercel-ignore-build.test.ts examples/software-factory/controller/src/lib/delivery/guard.json
git commit -m "ci(web): never build a software factory branch on Vercel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: An evaluator for GitHub `if:` expressions

**Files:**
- Create: `scripts/release/test/github-expression.mjs`
- Test: `scripts/release/test/github-expression.test.mjs`

- [ ] **Step 1: Write the failing test**

`scripts/release/test/github-expression.test.mjs`:

```js
import assert from "node:assert/strict"
import test from "node:test"

import { evaluateExpression, UNKNOWN, unwrapExpression } from "./github-expression.mjs"

const context = {
  github: {
    event_name: "pull_request",
    actor: "Blove",
    event: { pull_request: { head: { ref: "factory/wo-1" }, user: { login: "b4-factory[bot]" } } },
  },
  needs: { scope: { result: "success", outputs: { prose_only: "false" } } },
  status: { always: true, success: true, failure: false, cancelled: false },
}
const evaluate = (expression) => evaluateExpression(expression, context)

test("compares strings case-insensitively, as GitHub does", () => {
  assert.equal(evaluate("github.actor == 'blove'"), true)
  assert.equal(evaluate("github.event.pull_request.user.login != 'B4-Factory[bot]'"), false)
  assert.equal(evaluate("startsWith(github.event.pull_request.head.ref, 'FACTORY/')"), true)
})

test("reads missing properties as null and answers the status functions from the context", () => {
  assert.equal(evaluate("github.event.pull_request.head.label == null"), true)
  assert.equal(evaluate("!cancelled() && needs.scope.result == 'success'"), true)
  assert.equal(evaluate("needs.scope.outputs.prose_only != 'true'"), true)
  assert.equal(evaluate("needs['scope'].outputs['prose_only'] == 'false'"), true)
})

test("binds ! tighter than ==, && tighter than ||, and honours parentheses", () => {
  assert.equal(
    evaluate("!startsWith(github.event.pull_request.head.ref, 'factory/') || true"),
    true,
  )
  assert.equal(evaluate("false && false || true"), true)
  assert.equal(evaluate("false && (false || true)"), false)
  assert.equal(evaluate(`\${{ github.event_name == 'pull_request' }}`), true)
})

test("fails closed on what it does not understand", () => {
  assert.throws(() => evaluate("fromJSON('true')"), /Unsupported function/u)
  assert.throws(() => evaluate("github.event_name =="), /end of expression/u)
  assert.throws(() => evaluate("a ~ b"), /Unexpected input/u)
  assert.throws(() => evaluate("success(1)"), /no arguments/u)
  assert.throws(() => unwrapExpression(`x == \${{ y }}`), /partly wrapped/u)
})

test("in three-valued mode, what the context leaves unstated stays unknown", () => {
  const partial = {
    unknownByDefault: true,
    github: { event_name: "pull_request", event: { pull_request: { head: { ref: "factory/x" } } } },
    status: { always: true },
  }
  const ask = (expression) => evaluateExpression(expression, partial)
  assert.equal(ask("needs.scope.outputs.deploy == 'true'"), UNKNOWN)
  assert.equal(ask("failure()"), UNKNOWN)
  assert.equal(ask("!startsWith(github.event.pull_request.head.label, 'x')"), UNKNOWN)
  assert.equal(ask("!startsWith(github.event.pull_request.head.ref, 'factory/')"), false)
  // false && unknown, unknown && false: false. unknown || true: true.
  assert.equal(ask("github.event_name == 'push' && failure()"), false)
  assert.equal(ask("failure() && github.event_name == 'push'"), false)
  assert.equal(ask("failure() || always()"), true)
  assert.equal(ask("failure() || github.event_name == 'push'"), UNKNOWN)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/release/test/github-expression.test.mjs`
Expected: FAIL, `Cannot find module …/github-expression.mjs`.

- [ ] **Step 3: Write the evaluator**

`scripts/release/test/github-expression.mjs`:

```js
// A small evaluator for the GitHub Actions expression language, enough to decide a job's
// `if:` under a stated event. It exists so a contract test can ask what a guard DOES (is
// this job skipped for a factory pull request?) instead of whether its text contains a
// substring: a guard placed on the wrong side of an `||` contains the text and guards
// nothing. Anything it does not understand throws, so an unfamiliar `if:` fails the test
// rather than being guessed at.
//
// Semantics follow GitHub's documentation: `==` and `!=` compare strings case-insensitively,
// `&&` and `||` return an operand (not a boolean), falsy is false, 0, -0, "", null and NaN,
// a missing property is null, and the status functions are answered from the context.
//
// Three-valued when asked (`context.unknownByDefault`): every property the context does not
// state, and every status function it does not answer, is UNKNOWN, and UNKNOWN propagates
// through `!`, comparisons and functions, while `false && x` is still false and `true || x`
// still true. A guard test asks whether a job is DEFINITELY skipped for a factory pull
// request: a job that runs only when some job output is "true", or on `failure()`, is not.

const TOKEN =
  /\s*(?:(?<string>'(?:[^']|'')*')|(?<number>-?\d+(?:\.\d+)?)|(?<op>&&|\|\||==|!=|<=|>=|[!<>()[\].,])|(?<word>[A-Za-z_][A-Za-z0-9_-]*))/y

function tokenize(source) {
  const tokens = []
  TOKEN.lastIndex = 0
  let at = 0
  while (at < source.length) {
    if (/^\s*$/u.test(source.slice(at))) break
    TOKEN.lastIndex = at
    const match = TOKEN.exec(source)
    if (match === null)
      throw new SyntaxError(`Unexpected input at ${at}: ${source.slice(at, at + 20)}`)
    at = TOKEN.lastIndex
    const { string, number, op, word } = match.groups
    if (string !== undefined)
      tokens.push({ kind: "string", value: string.slice(1, -1).replaceAll("''", "'") })
    else if (number !== undefined) tokens.push({ kind: "number", value: Number(number) })
    else if (op !== undefined) tokens.push({ kind: "op", value: op })
    else tokens.push({ kind: "word", value: word })
  }
  return tokens
}

/** How an expression opens when it is wrapped. */
const OPEN = `\${{`

/** The expression inside an `if:`: a bare expression, or one wrapped whole in `${{ }}`. */
export function unwrapExpression(text) {
  const trimmed = String(text).trim()
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/u.exec(trimmed)
  if (wrapped) {
    if (wrapped[1].includes(OPEN)) throw new SyntaxError(`Nested ${OPEN} }} is not one expression`)
    return wrapped[1]
  }
  if (trimmed.includes(OPEN)) throw new SyntaxError("A partly wrapped if: is not one expression")
  return trimmed
}

function parse(source) {
  const tokens = tokenize(unwrapExpression(source))
  let index = 0
  const peek = () => tokens[index]
  const take = (value) => {
    const token = tokens[index]
    if (token?.kind !== "op" || token.value !== value)
      throw new SyntaxError(`Expected ${value} at token ${index}`)
    index += 1
  }
  const isOp = (value) => peek()?.kind === "op" && peek().value === value

  function primary() {
    const token = tokens[index]
    if (token === undefined) throw new SyntaxError("Unexpected end of expression")
    index += 1
    if (token.kind === "string" || token.kind === "number")
      return { type: "literal", value: token.value }
    if (token.kind === "op" && token.value === "(") {
      const inner = or()
      take(")")
      return inner
    }
    if (token.kind === "op" && token.value === "!") return { type: "not", operand: unary() }
    if (token.kind !== "word") throw new SyntaxError(`Unexpected ${token.value}`)
    if (token.value === "true") return { type: "literal", value: true }
    if (token.value === "false") return { type: "literal", value: false }
    if (token.value === "null") return { type: "literal", value: null }
    if (isOp("(")) {
      take("(")
      const args = []
      if (!isOp(")")) {
        args.push(or())
        while (isOp(",")) {
          take(",")
          args.push(or())
        }
      }
      take(")")
      return { type: "call", name: token.value.toLowerCase(), args }
    }
    let node = { type: "path", path: [token.value] }
    for (;;) {
      if (isOp(".")) {
        take(".")
        const name = tokens[index]
        if (name?.kind !== "word") throw new SyntaxError("Expected a property name after .")
        index += 1
        node = { type: "path", path: [...node.path, name.value] }
      } else if (isOp("[")) {
        take("[")
        const key = tokens[index]
        if (key?.kind !== "string") throw new SyntaxError("Only a string index is supported")
        index += 1
        take("]")
        node = { type: "path", path: [...node.path, key.value] }
      } else return node
    }
  }
  function unary() {
    return primary()
  }
  function comparison() {
    let left = unary()
    while (["==", "!=", "<", "<=", ">", ">="].some(isOp)) {
      const op = tokens[index].value
      index += 1
      left = { type: "compare", op, left, right: unary() }
    }
    return left
  }
  function and() {
    let left = comparison()
    while (isOp("&&")) {
      take("&&")
      left = { type: "and", left, right: comparison() }
    }
    return left
  }
  function or() {
    let left = and()
    while (isOp("||")) {
      take("||")
      left = { type: "or", left, right: and() }
    }
    return left
  }
  const tree = or()
  if (index !== tokens.length) throw new SyntaxError(`Trailing input at token ${index}`)
  return tree
}

/** A value the context does not state: neither truthy nor falsy until something decides it. */
export const UNKNOWN = Symbol("unknown")

const isFalsy = (value) =>
  value === false ||
  value === null ||
  value === undefined ||
  value === "" ||
  value === 0 ||
  Number.isNaN(value)

/** true, false, or UNKNOWN. */
const truth = (value) => (value === UNKNOWN ? UNKNOWN : !isFalsy(value))

function looselyEqual(a, b) {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase()
  return a === b
}

/**
 * Evaluate `expression` (an `if:` value) against `context`: an object whose top-level keys
 * are the expression contexts (`github`, `needs`, ...) and whose `status` names the job
 * status functions' answers (`{ cancelled: false, success: true, ... }`). Returns true or
 * false, or UNKNOWN when `context.unknownByDefault` is set and what the context leaves
 * unstated decides the answer.
 */
export function evaluateExpression(expression, context) {
  const tree = parse(expression)
  const unknownByDefault = context.unknownByDefault === true
  const missing = unknownByDefault ? UNKNOWN : null
  const lookup = (path) => {
    let value = context
    for (const segment of path) {
      if (value === UNKNOWN) return UNKNOWN
      if (value === null || value === undefined || typeof value !== "object") return missing
      value = Object.hasOwn(value, segment) ? value[segment] : missing
    }
    return value === undefined ? missing : value
  }
  const evaluate = (node) => {
    switch (node.type) {
      case "literal":
        return node.value
      case "path":
        return lookup(node.path)
      case "not": {
        const value = truth(evaluate(node.operand))
        return value === UNKNOWN ? UNKNOWN : !value
      }
      case "and": {
        const left = evaluate(node.left)
        const l = truth(left)
        if (l === false) return left
        const right = evaluate(node.right)
        if (l === true) return right
        // Unknown on the left: false either way only when the right is definitely falsy.
        return truth(right) === false ? false : UNKNOWN
      }
      case "or": {
        const left = evaluate(node.left)
        const l = truth(left)
        if (l === true) return left
        const right = evaluate(node.right)
        if (l === false) return right
        return truth(right) === true ? true : UNKNOWN
      }
      case "compare": {
        const left = evaluate(node.left)
        const right = evaluate(node.right)
        if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN
        if (node.op === "==") return looselyEqual(left, right)
        if (node.op === "!=") return !looselyEqual(left, right)
        throw new SyntaxError(`Unsupported comparison ${node.op}`)
      }
      case "call": {
        const status = context.status ?? {}
        if (["always", "success", "failure", "cancelled"].includes(node.name)) {
          if (node.args.length !== 0) throw new SyntaxError(`${node.name}() takes no arguments`)
          if (typeof status[node.name] === "boolean") return status[node.name]
          if (unknownByDefault) return UNKNOWN
          throw new SyntaxError(`The context does not answer ${node.name}()`)
        }
        const args = node.args.map(evaluate)
        if (node.name === "startswith" || node.name === "endswith" || node.name === "contains") {
          if (args.length !== 2) throw new SyntaxError(`${node.name}() takes two arguments`)
          if (args.includes(UNKNOWN)) return UNKNOWN
          const [subject, search] = args.map((value) => String(value ?? "").toLowerCase())
          if (node.name === "startswith") return subject.startsWith(search)
          if (node.name === "endswith") return subject.endsWith(search)
          return subject.includes(search)
        }
        throw new SyntaxError(`Unsupported function ${node.name}()`)
      }
      default:
        throw new SyntaxError(`Unknown node ${node.type}`)
    }
  }
  return truth(evaluate(tree))
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test scripts/release/test/github-expression.test.mjs`
Expected: `ℹ pass 5`, `ℹ fail 0`.

- [ ] **Step 5: Lint and commit.** `pnpm test:release-controller` globs `scripts/release/test/*.test.mjs`, so the new test runs in the `release-controller` lane; the helper (no `.test`) is not a release-reachable script (nothing in a workflow loads it), so no pin moves.

```bash
pnpm exec biome check --config-path packages/config-biome/biome.json scripts/release/test/github-expression.mjs scripts/release/test/github-expression.test.mjs
git add scripts/release/test/github-expression.mjs scripts/release/test/github-expression.test.mjs
git commit -m "test(release): evaluate GitHub if: expressions for the workflow contracts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: The guard, its contract test and the audited fixture, in one commit

**Files:**
- Create: `scripts/release/test/factory-guard.mjs`
- Modify: `.github/workflows/ci.yml` (`vercel-native`'s `if:`), `.github/workflows/auto-approve.yml` (`approve`), `.github/workflows/claude-review.yml` (`review`)
- Modify: `scripts/release/test/fixtures/workflow-entrypoints.json` (the three `if:`s)
- Test: `scripts/release/test/workflow-contracts.test.mjs`

- [ ] **Step 1: Write the rule**

`scripts/release/test/factory-guard.mjs`:

```js
// The software factory's CI guard (rung 4 spec §9): a pull request whose head branch is
// `factory/*`, or whose author is the factory app's bot, must never run a job that holds a
// secret, deploys to an environment, or can write to the repository. Its code is model
// output nobody has merged.
//
// The rule is generic on purpose. A job is guarded when its workflow can run on a pull
// request and the job (or a local reusable workflow it calls) references any secret other
// than GITHUB_TOKEN, names an environment, or is granted a write permission other than
// security-events. Each such job's `if:` must be DEFINITELY false for a factory pull request,
// evaluated three-valued: the test states only what a factory PR fixes (the event, the
// repository, the head ref and the author) and leaves every job output, status function and
// other property unknown, so a job that runs "only when an output is true" or "on failure()"
// is not called guarded. A new secret-bearing job therefore fails here until it carries the
// guard, instead of escaping a list of three names. Triggers are an allow-list: anything that
// could reach secrets for an event a pull request causes some other way is refused. The
// branch prefix and the bot login are the controller's
// (examples/software-factory/controller/src/lib/delivery/guard.json), passed in.

import { evaluateExpression } from "./github-expression.mjs"

const REPOSITORY = "cacheplane/b4run"

/** Write scopes a pull-request job may hold without the guard: code scanning's upload. */
const EXEMPT_WRITES = new Set(["security-events"])

/**
 * The only triggers a workflow may declare. `pull_request` runs the PR's code with the
 * guard; `push` only to main; the rest are started by a person or a schedule, never by a PR.
 * Everything else (`pull_request_target`, `workflow_run`, `repository_dispatch`,
 * `issue_comment`, `pull_request_review`, `create`, …) is refused: each can run with secrets
 * for an event a pull request, its author or `contents: write` causes, and several run with
 * `github.event.pull_request` null, which the guard reads.
 */
const ALLOWED_TRIGGERS = new Set([
  "pull_request",
  "push",
  "schedule",
  "workflow_dispatch",
  "workflow_call",
  "branch_protection_rule",
])

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

function triggers(workflow) {
  const on = workflow.on
  if (typeof on === "string") return { [on]: null }
  if (Array.isArray(on)) return Object.fromEntries(on.map((name) => [name, null]))
  return isRecord(on) ? on : {}
}

function writes(permissions) {
  if (permissions === "write-all") return ["*"]
  if (!isRecord(permissions)) return []
  return Object.entries(permissions)
    .filter(([scope, level]) => level === "write" && !EXEMPT_WRITES.has(scope))
    .map(([scope]) => scope)
}

function secretsReferenced(value) {
  const text = JSON.stringify(value ?? null)
  return [
    ...text.matchAll(/secrets\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)|secrets\s*\[\s*'([^']+)'\s*\]/gu),
  ]
    .map((match) => match[1] ?? match[2])
    .filter((name) => name.toUpperCase() !== "GITHUB_TOKEN")
}

/** The file name of a local reusable workflow `job` calls, or undefined. */
function localCall(job) {
  const uses = typeof job.uses === "string" ? job.uses : undefined
  const match = uses === undefined ? null : /^\.\/\.github\/workflows\/([^/@]+\.ya?ml)$/u.exec(uses)
  return match?.[1]
}

/**
 * Why `job` needs the guard, or an empty list when it does not. `workflows` resolves a local
 * reusable workflow the job calls: what its jobs hold, the caller holds.
 */
export function guardReasons(workflow, job, workflows = {}, seen = new Set()) {
  const reasons = []
  const secrets = [...new Set([...secretsReferenced(workflow.env), ...secretsReferenced(job)])]
  if (secrets.length > 0)
    reasons.push(`references ${secrets.map((s) => `secrets.${s}`).join(", ")}`)
  if (job.environment !== undefined) reasons.push("names an environment")
  if (job.uses !== undefined && job.secrets !== undefined)
    reasons.push("passes secrets to a reusable workflow")
  const granted = writes(job.permissions ?? workflow.permissions)
  if (granted.length > 0) reasons.push(`is granted ${granted.join(", ")}: write`)
  const called = localCall(job)
  if (job.uses !== undefined && called === undefined)
    reasons.push(`calls ${job.uses}, which this test cannot read`)
  if (called !== undefined && !seen.has(called)) {
    const target = workflows[called]
    if (!isRecord(target)) reasons.push(`calls ${called}, which does not exist`)
    else
      for (const [id, inner] of Object.entries(target.jobs ?? {}))
        for (const reason of guardReasons(target, inner, workflows, new Set([...seen, called])))
          reasons.push(`calls ${called}, whose job ${id} ${reason}`)
  }
  return reasons
}

/**
 * The `needs` context of a run in which every job of the workflow succeeded and every output
 * reads "false": a person's ordinary pull request, used only to show the guard does not stop
 * what it should not.
 */
function needsOf(jobs) {
  return Object.fromEntries(
    Object.entries(jobs ?? {}).map(([id, job]) => [
      id,
      {
        result: "success",
        outputs: Object.fromEntries(Object.keys(job?.outputs ?? {}).map((name) => [name, "false"])),
      },
    ]),
  )
}

/**
 * A same-repository pull request from `headRef` by `login`, every context known: for the
 * positive control (a person's PR still runs every guarded job).
 */
export function pullRequestContext(headRef, login, jobs = {}) {
  return {
    github: {
      event_name: "pull_request",
      repository: REPOSITORY,
      ref: "refs/pull/1/merge",
      head_ref: headRef,
      base_ref: "main",
      actor: login,
      event: {
        pull_request: {
          number: 1,
          user: { login },
          head: {
            ref: headRef,
            label: `cacheplane:${headRef}`,
            repo: { full_name: REPOSITORY },
          },
          base: { ref: "main" },
        },
      },
    },
    needs: needsOf(jobs),
    status: { always: true, success: true, failure: false, cancelled: false },
  }
}

/**
 * What a factory pull request fixes, and nothing more: the event, the repository, the head
 * ref (as `head.ref` and `head_ref`) and the author. Everything else is unknown.
 */
export function factoryContext(headRef, login) {
  return {
    unknownByDefault: true,
    github: {
      event_name: "pull_request",
      repository: REPOSITORY,
      head_ref: headRef,
      event: {
        pull_request: {
          user: { login },
          head: { ref: headRef, repo: { full_name: REPOSITORY } },
        },
      },
    },
    status: { always: true },
  }
}

/** Each way a factory pull request arrives, every one of which the guard must stop. */
export function factoryPullRequests({ branchPrefix, botLogin }) {
  return [
    ["the factory's own pull request", `${branchPrefix}wo-0123456789abcdef`, botLogin],
    ["a factory branch opened by a person", `${branchPrefix}wo-0123456789abcdef`, "blove"],
    ["the factory bot on another branch", "fix/something", botLogin],
  ]
}

/**
 * Every problem with the workflows' factory guard, as sentences; empty when the guard holds.
 * `workflows` maps a workflow file name to its parsed workflow object; `guard` is the
 * controller's guard.json (`branchPrefix`, `botLogin`).
 */
export function factoryGuardProblems(workflows, guard) {
  const problems = []
  for (const [file, workflow] of Object.entries(workflows)) {
    const on = triggers(workflow)
    for (const name of Object.keys(on))
      if (!ALLOWED_TRIGGERS.has(name))
        problems.push(
          `${file} listens on ${name}: only ${[...ALLOWED_TRIGGERS].join(", ")} are allowed, because anything else can run with secrets for an event a pull request causes`,
        )
    if (Object.hasOwn(on, "push")) {
      const push = isRecord(on.push) ? on.push : {}
      const branches = push.branches
      if (
        !Array.isArray(branches) ||
        branches.length !== 1 ||
        branches[0] !== "main" ||
        push["branches-ignore"] !== undefined ||
        push.tags !== undefined ||
        push["tags-ignore"] !== undefined
      )
        problems.push(
          `${file} runs on a push to a branch other than main: a push to factory/* must run nothing`,
        )
    }
    if (!Object.hasOwn(on, "pull_request")) continue
    if (workflow.permissions === undefined)
      problems.push(
        `${file} runs on pull_request with no top-level permissions block: its jobs would inherit the repository default`,
      )
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      if (!isRecord(job)) continue
      const reasons = guardReasons(workflow, job, workflows)
      if (reasons.length === 0) continue
      const where = `${file} job ${id} (${reasons.join("; ")})`
      if (job.if === undefined) {
        problems.push(`${where} has no if: and so runs for a factory pull request`)
        continue
      }
      for (const [label, headRef, login] of factoryPullRequests(guard)) {
        let runs
        try {
          runs = evaluateExpression(job.if, factoryContext(headRef, login))
        } catch (error) {
          problems.push(`${where}: its if: cannot be evaluated (${error.message})`)
          break
        }
        if (runs !== false)
          problems.push(
            `${where} ${runs === true ? "runs" : "may run"} for ${label}: its if: is not definitely false`,
          )
      }
    }
  }
  return problems
}
```

- [ ] **Step 2: Write the failing contract test.** Two imports after `readBoundedFixture`'s, and the test appended at the end of the file:

```diff
diff --git a/scripts/release/test/workflow-contracts.test.mjs b/scripts/release/test/workflow-contracts.test.mjs
index 7f2f6ddd5..06ac2174e 100644
--- a/scripts/release/test/workflow-contracts.test.mjs
+++ b/scripts/release/test/workflow-contracts.test.mjs
@@ -23,6 +23,8 @@ import { ARTIFACT_STORE_SPARSE_FILES } from "../artifact-store.mjs"
 import { readBoundedFixture } from "../fixture-io.mjs"
 import { PUBLISHER_OVERALL_TIMEOUT_MS, PUBLISHER_SPARSE_FILES } from "../publisher.mjs"
 import { REQUIRED_RELEASE_SMOKE_LANES } from "../smoke-result.mjs"
+import { factoryGuardProblems, pullRequestContext } from "./factory-guard.mjs"
+import { evaluateExpression } from "./github-expression.mjs"
 
 const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
 const requireFromCore = createRequire(path.join(ROOT, "packages", "core", "package.json"))
@@ -4771,3 +4773,247 @@ function unauditedEntrypoint() {
 function isRecord(value) {
   return value !== null && typeof value === "object" && !Array.isArray(value)
 }
+
+test("factory pull requests run no secret-bearing, deploying or writing job (rung 4 §9)", async (t) => {
+  const sources = await readWorkflowSourcesFromRoot(ROOT)
+  // The controller's own statement of the guard: the branch prefix and the bot login every
+  // guarded job skips, and the files a delivery may never change.
+  const guard = JSON.parse(
+    await readBoundedFixture(
+      path.join(ROOT, "examples/software-factory/controller/src/lib/delivery/guard.json"),
+      { root: ROOT },
+    ),
+  )
+  const parsed = () =>
+    Object.fromEntries(
+      Object.entries(sources).map(([file, source]) => [file, parseWorkflowSource(source, file)]),
+    )
+  assert.deepEqual(factoryGuardProblems(parsed(), guard), [])
+
+  // The guard must not stop what it does not mean to: a person's same-repository PR still
+  // runs every guarded job, and a push to main still runs vercel-native.
+  const workflows = parsed()
+  const person = (file) => pullRequestContext("blove/some-change", "blove", workflows[file].jobs)
+  for (const [file, job] of [
+    ["ci.yml", "vercel-native"],
+    ["auto-approve.yml", "approve"],
+    ["claude-review.yml", "review"],
+  ])
+    assert.equal(
+      evaluateExpression(workflows[file].jobs[job].if, person(file)),
+      true,
+      `${file} ${job}`,
+    )
+  const push = {
+    ...person("ci.yml"),
+    github: { event_name: "push", ref: "refs/heads/main", repository: "cacheplane/b4run" },
+  }
+  assert.equal(evaluateExpression(workflows["ci.yml"].jobs["vercel-native"].if, push), true)
+
+  const mutate = (file, edit) => {
+    const next = parsed()
+    edit(next[file], next)
+    return factoryGuardProblems(next, guard)
+  }
+  const ifOf = (workflow, job) => workflow.jobs[job].if
+  const cases = [
+    [
+      "vercel-native without the guard",
+      "ci.yml",
+      (w) => {
+        w.jobs["vercel-native"].if = ifOf(w, "vercel-native").replace(
+          / &&\n !startsWith\([^)]*\) &&\n [^)]*'b4-factory\[bot\]'/u,
+          "",
+        )
+      },
+    ],
+    [
+      "approve without the branch half",
+      "auto-approve.yml",
+      (w) => {
+        w.jobs.approve.if = ifOf(w, "approve").replace(/ && !startsWith\([^)]*\)/u, "")
+      },
+    ],
+    [
+      "approve without the author half",
+      "auto-approve.yml",
+      (w) => {
+        w.jobs.approve.if = ifOf(w, "approve").replace(
+          / && github\.event\.pull_request\.user\.login != '[^']*'/u,
+          "",
+        )
+      },
+    ],
+    [
+      "review with the bot login misspelt",
+      "claude-review.yml",
+      (w) => {
+        w.jobs.review.if = ifOf(w, "review").replace("b4-factory[bot]", "b4-factroy[bot]")
+      },
+    ],
+    [
+      "review keyed on head.label",
+      "claude-review.yml",
+      (w) => {
+        w.jobs.review.if = ifOf(w, "review").replace("head.ref", "head.label")
+      },
+    ],
+    [
+      "the guard on the wrong side of an ||",
+      "auto-approve.yml",
+      (w) => {
+        w.jobs.approve.if =
+          "github.event.pull_request.head.repo.full_name == github.repository || (!startsWith(github.event.pull_request.head.ref, 'factory/') && github.event.pull_request.user.login != 'b4-factory[bot]')"
+      },
+    ],
+    [
+      "a new job with a secret and no guard",
+      "ci.yml",
+      (w) => {
+        w.jobs.leak = {
+          "runs-on": "ubuntu-latest",
+          steps: [{ run: "true", env: { K: workflowExpression("secrets.NEW_KEY") } }],
+        }
+      },
+    ],
+    [
+      "a new job with an environment and an unguarded if",
+      "ci.yml",
+      (w) => {
+        w.jobs.deploy = {
+          if: "github.event_name == 'pull_request'",
+          environment: "x",
+          "runs-on": "ubuntu-latest",
+          steps: [],
+        }
+      },
+    ],
+    [
+      "a new job granted contents: write",
+      "kubernetes-compat.yml",
+      (w) => {
+        const [id] = Object.keys(w.jobs)
+        w.jobs[id].permissions = { contents: "write" }
+      },
+    ],
+    [
+      "a workflow on repository_dispatch",
+      "ci.yml",
+      (w) => {
+        w.on.repository_dispatch = null
+      },
+    ],
+    [
+      "a workflow on pull_request_target",
+      "auto-approve.yml",
+      (w) => {
+        w.on = { pull_request_target: w.on.pull_request }
+        w.jobs.approve.permissions = { "pull-requests": "write" }
+      },
+    ],
+    [
+      "a workflow on workflow_run",
+      "codeql.yml",
+      (w) => {
+        w.on.workflow_run = { workflows: ["CI"] }
+      },
+    ],
+    [
+      "a secret job gated only on a job output",
+      "ci.yml",
+      (w) => {
+        w.jobs.deploy = {
+          if: "needs.metadata_scope.outputs.deploy == 'true'",
+          needs: "metadata_scope",
+          "runs-on": "ubuntu-latest",
+          steps: [{ run: "true", env: { K: workflowExpression("secrets.NEW_KEY") } }],
+        }
+      },
+    ],
+    [
+      "a secret job that runs on failure()",
+      "ci.yml",
+      (w) => {
+        w.jobs.report = {
+          if: "failure()",
+          "runs-on": "ubuntu-latest",
+          steps: [{ run: "true", env: { K: workflowExpression("secrets.NEW_KEY") } }],
+        }
+      },
+    ],
+    [
+      "claude-review also on issue_comment (github.event.pull_request is null there)",
+      "claude-review.yml",
+      (w) => {
+        w.on.issue_comment = { types: ["created"] }
+      },
+    ],
+    [
+      "a local reusable workflow whose job deploys",
+      "ci.yml",
+      (w, all) => {
+        all["deploy.yml"] = {
+          on: { workflow_call: null },
+          permissions: { contents: "read" },
+          jobs: { deploy: { environment: "production", "runs-on": "ubuntu-latest", steps: [] } },
+        }
+        w.jobs.release = { uses: "./.github/workflows/deploy.yml" }
+      },
+    ],
+    [
+      "a pull_request workflow with no top-level permissions",
+      "kubernetes-compat.yml",
+      (w) => {
+        delete w.permissions
+      },
+    ],
+    [
+      "a push trigger widened past main",
+      "ci.yml",
+      (w) => {
+        w.on.push = { branches: ["main", "factory/**"] }
+      },
+    ],
+  ]
+  for (const [label, file, edit] of cases)
+    await t.test(label, () => {
+      assert.notDeepEqual(mutate(file, edit), [], `${label} must be refused`)
+    })
+  // The guard may be spelled with github.head_ref: the test knows it, so it is not a false alarm.
+  assert.deepEqual(
+    mutate("auto-approve.yml", (w) => {
+      w.jobs.approve.if =
+        "github.event.pull_request.head.repo.full_name == github.repository && !startsWith(github.head_ref, 'factory/') && github.event.pull_request.user.login != 'b4-factory[bot]'"
+    }),
+    [],
+  )
+
+  // The guard lives in files a same-repository PR could edit; the controller refuses to
+  // deliver a change to any of them. Moving the Vercel script without moving its protection
+  // fails here.
+  const covered = (file) =>
+    guard.protectedPaths.some((entry) =>
+      entry.endsWith("/**") ? file.startsWith(entry.slice(0, -2)) : file === entry,
+    )
+  const vercel = JSON.parse(
+    await readBoundedFixture(path.join(ROOT, "apps/web/vercel.json"), { root: ROOT }),
+  )
+  const script = /^bash (\S+)$/u.exec(vercel.ignoreCommand)?.[1]
+  assert.ok(script, "apps/web/vercel.json's ignoreCommand must be `bash <script>`")
+  for (const file of [
+    ".github/workflows/ci.yml",
+    ".github/workflows/auto-approve.yml",
+    ".github/workflows/claude-review.yml",
+    "apps/web/vercel.json",
+    path.posix.join("apps/web", script),
+  ])
+    assert.ok(covered(file), `${file} must be a delivery-protected path`)
+  // The files the branch's own Vercel build runs must also not have changed on main since the
+  // pin; the workflows need not (a PR runs main's at the merge commit).
+  assert.deepEqual(guard.runFromBranchPaths, [
+    "apps/web/vercel.json",
+    path.posix.join("apps/web", script),
+  ])
+  for (const file of guard.runFromBranchPaths)
+    assert.ok(covered(file), `${file} must be protected too`)
+})
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --test --test-name-pattern='factory pull requests' scripts/release/test/workflow-contracts.test.mjs`
Expected: FAIL at the first `deepEqual`: nine problems, three per job, for example `ci.yml job vercel-native (references secrets.B4_VERCEL_TOKEN, …; names an environment) may run for the factory's own pull request: its if: is not definitely false`.

- [ ] **Step 4: Guard the three jobs**

```diff
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index f6b6bbfba..97e099c92 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -705,7 +705,9 @@ jobs:
       (!cancelled() && (github.event_name != 'pull_request' || needs.metadata_scope.result != 'success' || needs.metadata_scope.outputs.prose_only != 'true')) && (
       (github.event_name == 'push' && github.ref == 'refs/heads/main') ||
       (github.event_name == 'pull_request' &&
-       github.event.pull_request.head.repo.full_name == github.repository))
+       github.event.pull_request.head.repo.full_name == github.repository &&
+       !startsWith(github.event.pull_request.head.ref, 'factory/') &&
+       github.event.pull_request.user.login != 'b4-factory[bot]'))
     runs-on: ubuntu-latest
     timeout-minutes: 45
     environment: vercel-preview
```

```diff
diff --git a/.github/workflows/auto-approve.yml b/.github/workflows/auto-approve.yml
index 65684fc1b..c7bd4fd45 100644
--- a/.github/workflows/auto-approve.yml
+++ b/.github/workflows/auto-approve.yml
@@ -20,8 +20,12 @@ permissions:
 
 jobs:
   approve:
-    # Only same-repo PRs: fork PRs get a read-only token and cannot approve.
-    if: github.event.pull_request.head.repo.full_name == github.repository
+    # Only same-repo PRs: fork PRs get a read-only token and cannot approve. Never the
+    # software factory's: its code is model output no person has reviewed (rung 4 spec §9).
+    if: >-
+      github.event.pull_request.head.repo.full_name == github.repository &&
+      !startsWith(github.event.pull_request.head.ref, 'factory/') &&
+      github.event.pull_request.user.login != 'b4-factory[bot]'
     runs-on: ubuntu-latest
     timeout-minutes: 5
     permissions:
```

```diff
diff --git a/.github/workflows/claude-review.yml b/.github/workflows/claude-review.yml
index bb66b1811..a0cf68dfd 100644
--- a/.github/workflows/claude-review.yml
+++ b/.github/workflows/claude-review.yml
@@ -32,8 +32,13 @@ jobs:
   review:
     # Dependabot-triggered runs cannot read repo secrets, so the Claude review
     # action always fails with a red X on dependabot PRs. Skip them (same
-    # convention as scripts/check-changesets.mjs).
-    if: github.actor != 'dependabot[bot]'
+    # convention as scripts/check-changesets.mjs). Never the software factory's
+    # PRs: their diff and body are model output, and this job holds a key and a
+    # write token (rung 4 spec §9).
+    if: >-
+      github.actor != 'dependabot[bot]' &&
+      !startsWith(github.event.pull_request.head.ref, 'factory/') &&
+      github.event.pull_request.user.login != 'b4-factory[bot]'
     runs-on: ubuntu-latest
     timeout-minutes: 25
     permissions:
```

- [ ] **Step 5: Move the audited fixture in the same commit** (Trap 5). These are the parsed strings; to print them yourself:

```bash
cd scripts && node -e 'import("yaml").then(({parse})=>{const fs=require("fs");for (const [f,j] of [["ci.yml","vercel-native"],["auto-approve.yml","approve"],["claude-review.yml","review"]]) console.log(f, JSON.stringify(parse(fs.readFileSync("../.github/workflows/"+f,"utf8")).jobs[j].if))})'; cd ..
```

```diff
diff --git a/scripts/release/test/fixtures/workflow-entrypoints.json b/scripts/release/test/fixtures/workflow-entrypoints.json
index 244043590..8c79e5448 100644
--- a/scripts/release/test/fixtures/workflow-entrypoints.json
+++ b/scripts/release/test/fixtures/workflow-entrypoints.json
@@ -19,7 +19,7 @@
           "classification": "safe",
           "id": "approve",
           "descriptor": {
-            "if": "github.event.pull_request.head.repo.full_name == github.repository",
+            "if": "github.event.pull_request.head.repo.full_name == github.repository && !startsWith(github.event.pull_request.head.ref, 'factory/') && github.event.pull_request.user.login != 'b4-factory[bot]'",
             "permissions": {
               "pull-requests": "write"
             },
@@ -1732,7 +1732,7 @@
           "id": "vercel-native",
           "descriptor": {
             "environment": "vercel-preview",
-            "if": "(!cancelled() && (github.event_name != 'pull_request' || needs.metadata_scope.result != 'success' || needs.metadata_scope.outputs.prose_only != 'true')) && ( (github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'pull_request' &&\n github.event.pull_request.head.repo.full_name == github.repository))",
+            "if": "(!cancelled() && (github.event_name != 'pull_request' || needs.metadata_scope.result != 'success' || needs.metadata_scope.outputs.prose_only != 'true')) && ( (github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'pull_request' &&\n github.event.pull_request.head.repo.full_name == github.repository &&\n !startsWith(github.event.pull_request.head.ref, 'factory/') &&\n github.event.pull_request.user.login != 'b4-factory[bot]'))",
             "needs": "metadata_scope",
             "runs-on": "ubuntu-latest",
             "timeout-minutes": 45
@@ -1881,7 +1881,7 @@
           "classification": "safe",
           "id": "review",
           "descriptor": {
-            "if": "github.actor != 'dependabot[bot]'",
+            "if": "github.actor != 'dependabot[bot]' && !startsWith(github.event.pull_request.head.ref, 'factory/') && github.event.pull_request.user.login != 'b4-factory[bot]'",
             "permissions": {
               "contents": "read",
               "pull-requests": "write"
```

- [ ] **Step 6: Run the gates in AGENTS.md's order**

```bash
node --test scripts/release/test/workflow-contracts.test.mjs
pnpm test:release-integrity
pnpm test:release-controller
```

Expected: the contract file `ℹ fail 0` (the new test has 18 mutation subtests, each of which must be refused, plus the `head_ref` spelling, which must not be); integrity `ℹ fail 0`; the controller suite `ℹ fail 0`. `every workflow executable entrypoint matches the readable audited allowlist` passes only with Step 5's fixture.

- [ ] **Step 7: Lint and commit (one commit: workflows, fixture and test together)**

```bash
pnpm exec biome check --config-path packages/config-biome/biome.json scripts/release/test/factory-guard.mjs scripts/release/test/workflow-contracts.test.mjs
git add .github/workflows/ci.yml .github/workflows/auto-approve.yml .github/workflows/claude-review.yml scripts/release/test/factory-guard.mjs scripts/release/test/workflow-contracts.test.mjs scripts/release/test/fixtures/workflow-entrypoints.json
git commit -m "ci: skip every secret-bearing pull_request job for software factory PRs

The software factory (rung 4) delivers approved changes as draft PRs from
factory/* branches authored by the b4-factory app. vercel-native,
auto-approve and claude-review now skip a PR whose head is factory/* or whose
author is the app's bot. The contract test evaluates every guarded job's if:
for factory PRs rather than searching its text, refuses the triggers that would
reach secrets another way, and checks the files holding the guard are
delivery-protected.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Open PR 1** (Brian decides when; at most two PRs with full CI at once, AGENTS.md). The description says: no `factory/*` branch may exist on `cacheplane/b4run` before this merges (Trap 8), and `workflow-safe-executables.json` is unchanged because no step changed.

---

# Operator setup (Brian, not a PR)

### Task 4: The GitHub App, the rulesets and the scratch repository

Done by Brian in GitHub's UI. An agent may run only the read-only `gh api` checks below and show Brian the result; it creates, installs and edits nothing (no GitHub write calls). Decisions D4, D5, D7, D12, D22 apply.

- [ ] **Step 1: Create the app** (organization `cacheplane` → Settings → Developer settings → GitHub Apps → New GitHub App):
  - GitHub App name: `b4-factory` (D4). Homepage URL: `https://b4.run`.
  - Webhook: **uncheck "Active"** (the factory polls nothing and receives nothing).
  - Repository permissions: **Contents: Read and write**; **Pull requests: Read and write**; **Issues: Read-only** (D5); **Metadata: Read-only** (mandatory). Every other permission, including **Workflows** and **Actions**, stays **No access**. No organization or account permissions. No events.
  - Where can this GitHub App be installed: **Only on this account**.
  - Create, note the **App ID**, then "Generate a private key". Move the downloaded file and lock it:

```bash
mkdir -p ~/.config/b4-factory && chmod 700 ~/.config/b4-factory
mv ~/Downloads/b4-factory.*.private-key.pem ~/.config/b4-factory/app.pem
chmod 600 ~/.config/b4-factory/app.pem
```

- [ ] **Step 2: List who pushes refs today** (read-only, D7), and decide the bypass list from it:

```bash
gh api 'repos/cacheplane/b4run/events?per_page=100' --paginate \
  -q '.[] | select(.type=="CreateEvent" or .type=="PushEvent" or .type=="DeleteEvent") | "\(.actor.login) \(.type) \(.payload.ref_type // "") \(.payload.ref)"' \
  | sort | uniq -c | sort -rn
gh api 'repos/cacheplane/b4run/tags?per_page=10' -q '.[].name'
```

Expected (2026-10-01): `blove`, `github-actions[bot]` (`changeset-release/main`, `v*` tags), `dependabot[bot]`. Any other identity goes on the bypass lists below too.

- [ ] **Step 3: Create a scratch repository and prepare it** (`cacheplane/b4-factory-scratch`, private): a `README.md`; `packages/devkit/src/testing/process.ts` containing exactly `export const deadline = 'leaks'` and a newline (the lane's baseline); one open issue (#1, any title). Install the app on it (App settings → Install App → `cacheplane` → Only select repositories → the scratch repository).

- [ ] **Step 4: Create the three rulesets on the scratch repository first** (Settings → Rules → Rulesets → New branch ruleset / New tag ruleset), D22:
  1. **"factory app confined: branches"** (branch ruleset), Enforcement: Active. Target branches: **Include all branches**; **Exclude by pattern** `factory/**`. Rules: **Restrict creations**, **Restrict updates**, **Restrict deletions**. Bypass list: **Repository admin**, **Maintain**, **Write** (roles), **GitHub Actions** (app), **Dependabot** (app), each "Always allow". The factory app is on no list.
  2. **"factory app confined: tags"** (tag ruleset), Active. Target tags: **Include all tags**. Rules: Restrict creations, Restrict updates, Restrict deletions. Same bypass list.
  3. **"factory branches are append-never"** (branch ruleset), Active. Target branches: **Include by pattern** `factory/**`. Rules: **Restrict updates**, **Block force pushes**. Bypass: **Repository admin** only. (Deletion stays allowed so `delete_branch_on_merge` and a person's cleanup work.)

- [ ] **Step 5: Verify each setting read-only.** Run each and compare with the expected value; show Brian the output.

```bash
# The app: name, permissions, no events (public endpoint)
gh api apps/b4-factory -q '{slug, permissions, events}'
# expect: slug "b4-factory"; permissions exactly {contents:"write", issues:"read", metadata:"read", pull_requests:"write"}; events []

# Its installations, and which repositories (needs org owner)
gh api orgs/cacheplane/installations -q '.installations[] | select(.app_slug=="b4-factory") | {id, repository_selection, permissions}'
gh api "user/installations/$(gh api orgs/cacheplane/installations -q '.installations[] | select(.app_slug=="b4-factory") | .id')/repositories" -q '.repositories[].full_name'
# expect: "selected"; the scratch repository (and, after Step 7, cacheplane/b4run) and nothing else

# The rulesets and their bypass lists
for r in $(gh api repos/cacheplane/b4-factory-scratch/rulesets -q '.[].id'); do
  gh api repos/cacheplane/b4-factory-scratch/rulesets/$r -q '{name, target, enforcement, conditions, rules: [.rules[].type], bypass: [.bypass_actors[] | {actor_type, actor_id, bypass_mode}]}'
done
# expect: three rulesets as in Step 4; rule types creation/update/deletion, creation/update/deletion, update/non_fast_forward

# What applies to main and to a factory branch (what preflight reads)
gh api repos/cacheplane/b4-factory-scratch/rules/branches/main -q '[.[].type]'
gh api repos/cacheplane/b4-factory-scratch/rules/branches/factory/wo-0000000000000000 -q '[.[].type]'
# expect: main includes "update"; the factory branch includes "update" and "non_fast_forward"
```

- [ ] **Step 6: Vercel** (D12). First list every Vercel project linked to `cacheplane/b4run`: the Vercel dashboard (Team → Projects, each project's Settings → Git → Connected Git Repository), and, read-only from GitHub, which environments have ever been deployed from it: `gh api 'repos/cacheplane/b4run/deployments?per_page=100' -q '[.[] | {environment, creator: .creator.login}] | unique'`. Every linked project builds every pushed branch unless its own ignore step or a branch rule says otherwise, so each one needs a `factory/*` exclusion; only `apps/web` has an ignore script in the repository (`git ls-files | grep vercel.json`), and any other linked project is a finding to fix before Task 23. Then, in the Vercel project for `apps/web`, Settings → Git: if there is an "Ignored Build Step" override at the project level, leave it as `bash scripts/vercel-ignore-build.sh`; if Vercel offers branch exclusion for preview deployments at the project or team level, add `factory/*`. Record which existed in Task 23's notes.

- [ ] **Step 7: After PR 1 is merged, and only then** (Trap 8): install the app on `cacheplane/b4run` too (Install App → `cacheplane` → Configure → add `b4run`), and create the same three rulesets there. Re-run Step 5 against `cacheplane/b4run`. Then watch the next release ceremony (`release.yml` tags, `version-pr.yml`'s `changeset-release/main` push) succeed with the rulesets on (D7).

---

# PR 3: Delivery bound in the bundle (controller only, against a fake GitHub)

```bash
git fetch origin
git switch -c blove/factory-delivery-bundle origin/main
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@b4-example/software-factory-controller^...
pnpm --filter @b4-example/software-factory-controller test   # green before any change (Trap 10)
```

Every command below runs from `examples/software-factory/controller` unless it says otherwise (`cd examples/software-factory/controller`); `git apply` of a diff runs from the repository root (`git -C ../../.. apply`), since the diffs' paths are repository-relative.

### Task 5: The lifecycle: `delivering`, `delivered`, the delivery reasons, and `run`'s steps

**Files:**
- Modify: `src/lib/domain/states.ts`, `src/lib/operator/run-steps.ts`
- Test: `test/delivery-states.test.ts` (new), `test/run-steps.test.ts`

- [ ] **Step 1: Write the failing tests**

`examples/software-factory/controller/test/delivery-states.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
  ACTIVE_STATES,
  BLOCKED_REASONS,
  isTerminal,
  nextState,
  REDELIVERABLE_BLOCKED_REASONS,
  RETRYABLE_BLOCKED_REASONS,
} from "../src/lib/domain/states.ts"

describe("the delivery lifecycle", () => {
  it("approves a draft-PR bundle into delivering, and confirms or refuses it from there", () => {
    expect(nextState("awaiting_approval", "approve_delivery")).toBe("delivering")
    expect(nextState("delivering", "delivery_confirmed")).toBe("delivered")
    expect(nextState("delivering", "delivery_refused")).toBe("blocked")
    expect(nextState("blocked", "redeliver")).toBe("delivering")
    expect(nextState("delivering", "cancel")).toBe("cancel_requested")
    expect(() => nextState("delivering", "budget_exhausted")).toThrow(/Illegal/)
    expect(() => nextState("exporting", "delivery_confirmed")).toThrow(/Illegal/)
  })

  it("makes delivered terminal and delivering not active time", () => {
    expect(isTerminal("delivered")).toBe(true)
    expect(isTerminal("delivering")).toBe(false)
    expect(ACTIVE_STATES.has("delivering")).toBe(false)
  })

  it("redelivers only the blocks the world can heal, and retries none of them", () => {
    const delivery = BLOCKED_REASONS.filter((r) => r.startsWith("delivery_"))
    expect(delivery).toEqual([
      "delivery_base_conflict",
      "delivery_baseline_mismatch",
      "delivery_branch_conflict",
      "delivery_issue_closed",
      "delivery_unauthorized",
      "delivery_rate_limited",
      "delivery_unconfirmed",
    ])
    expect([...REDELIVERABLE_BLOCKED_REASONS].sort()).toEqual([
      "delivery_rate_limited",
      "delivery_unauthorized",
      "delivery_unconfirmed",
    ])
    for (const reason of delivery) expect(RETRYABLE_BLOCKED_REASONS.has(reason)).toBe(false)
  })
})
```

Append to `test/run-steps.test.ts`:

```ts

describe("run and a draft-PR delivery (rung 4)", () => {
  it("follows a delivery, is done when delivered, and never redelivers by itself", () => {
    expect(at("delivering")).toEqual({ kind: "follow", why: "it is delivering" })
    expect(at("delivered")).toEqual({ kind: "done" })
    const healable = at("blocked", { blockedReason: "delivery_rate_limited" })
    expect(healable).toMatchObject({
      kind: "stop",
      next: [
        "pnpm factory events wo-0000000000000001",
        "pnpm factory redeliver wo-0000000000000001",
        "pnpm factory cancel wo-0000000000000001",
      ],
    })
    const conflict = at("blocked", { blockedReason: "delivery_base_conflict" })
    expect(JSON.stringify(conflict)).not.toContain("redeliver")
  })

  it("answers a delivered newest work order as done", () => {
    const delivered = issueRow({ state: "delivered" })
    expect(chooseWorkOrder([delivered], false)).toEqual({ kind: "done", row: delivered })
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run test/delivery-states.test.ts test/run-steps.test.ts`
Expected: FAIL: the new events are not in the transition table (`nextState` throws), `REDELIVERABLE_BLOCKED_REASONS` is undefined, and `at("delivering")` throws `No run step for state delivering`.

- [ ] **Step 3: The states**

```diff
diff --git a/examples/software-factory/controller/src/lib/domain/states.ts b/examples/software-factory/controller/src/lib/domain/states.ts
index 527c1f1f2..dd7188668 100644
--- a/examples/software-factory/controller/src/lib/domain/states.ts
+++ b/examples/software-factory/controller/src/lib/domain/states.ts
@@ -8,6 +8,8 @@ export const STATES = [
   "awaiting_approval",
   "exporting",
   "exported",
+  "delivering",
+  "delivered",
   "denied",
   "cancel_requested",
   "cancelled",
@@ -18,12 +20,18 @@ export type WorkOrderState = (typeof STATES)[number]
 
 export const TERMINAL_STATES: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
   "exported",
+  "delivered",
   "denied",
   "cancelled",
   "failed",
 ])
 
-/** States that count toward the active-time budget. Waiting on a person is not active time. */
+/**
+ * States that count toward the active-time budget. Waiting on a person is not active time, and
+ * neither is `delivering`: the builder's budget is the wrong clock for waiting on GitHub, and
+ * `budget_exhausted` there would cancel a half-done publication. The delivery worker has its
+ * own bound (rung 4 spec §4, §6.5).
+ */
 export const ACTIVE_STATES: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
   "intake_running",
   "dispatched",
@@ -69,6 +77,24 @@ export const BLOCKED_REASONS = [
   // shrank past half its baseline: the builder rewrote a file it had only partly read.
   // Refused at assembly, before a verification that could only fail on it.
   "candidate_rejected",
+  // Rung 4, a draft-PR delivery (spec §4). Each is recorded, not blindly retried: main
+  // changed a path the change touches (or a protected path), or the pin left main's history,
+  // or the comparison could not be read whole.
+  "delivery_base_conflict",
+  // A changed path's blob at the pin is not the baseline the candidate was diffed against.
+  "delivery_baseline_mismatch",
+  // factory/<id> exists with a commit that is not this change, or its PR is closed or has
+  // another base.
+  "delivery_branch_conflict",
+  // The issue was open at create and is closed now.
+  "delivery_issue_closed",
+  // No token, no installation, a 401 or a non-rate-limit 403, or permissions too narrow.
+  "delivery_unauthorized",
+  // A rate limit outlasted the worker's bound.
+  "delivery_rate_limited",
+  // A 5xx or network failure outlasted the bound, or GitHub answered something the read-back
+  // cannot reconcile with the bundle.
+  "delivery_unconfirmed",
 ] as const
 export type BlockedReason = (typeof BLOCKED_REASONS)[number]
 
@@ -87,6 +113,17 @@ export const RETRYABLE_BLOCKED_REASONS: ReadonlySet<BlockedReason> = new Set<Blo
   "verification_inconclusive",
 ])
 
+/**
+ * The delivery blocks `redeliver` may resume (spec §4): the world can heal (the app fixed, the
+ * limit reset, GitHub back) and every step reads before it writes. The others never heal by
+ * waiting; the remedy is a new work order.
+ */
+export const REDELIVERABLE_BLOCKED_REASONS: ReadonlySet<BlockedReason> = new Set<BlockedReason>([
+  "delivery_unauthorized",
+  "delivery_rate_limited",
+  "delivery_unconfirmed",
+])
+
 export const FAILURE_REASONS = ["route_error", "ended_without_candidate"] as const
 export type FailureReason = (typeof FAILURE_REASONS)[number]
 
@@ -116,6 +153,10 @@ export const TRANSITION_EVENTS = [
   "approve_intake",
   "reject_intake",
   "retry",
+  "approve_delivery",
+  "delivery_confirmed",
+  "delivery_refused",
+  "redeliver",
 ] as const
 export type TransitionEvent = (typeof TRANSITION_EVENTS)[number]
 
@@ -164,6 +205,13 @@ const TABLE: Readonly<Record<TransitionEvent, Row>> = {
   // A candidate failure, attempts permitting, back to where `dispatch` starts a fresh builder
   // thread. The table cannot see the reason; `retry` refuses every block but a candidate's.
   retry: { blocked: "received" },
+  // Rung 4: approving a draft-PR bundle commits the outbox intent; the worker then confirms
+  // the delivery by reading it back, or records why it refused. `redeliver` resumes a block
+  // the world can heal; the command refuses every other reason.
+  approve_delivery: { awaiting_approval: "delivering" },
+  delivery_confirmed: { delivering: "delivered" },
+  delivery_refused: { delivering: "blocked" },
+  redeliver: { blocked: "delivering" },
 }
 
 export class IllegalTransitionError extends Error {
```

- [ ] **Step 4: `run`'s steps** (the `never` check in `nextStep` fails `tsc` until both new states are handled):

```diff
diff --git a/examples/software-factory/controller/src/lib/operator/run-steps.ts b/examples/software-factory/controller/src/lib/operator/run-steps.ts
index d0e76d4b8..131d02db6 100644
--- a/examples/software-factory/controller/src/lib/operator/run-steps.ts
+++ b/examples/software-factory/controller/src/lib/operator/run-steps.ts
@@ -1,5 +1,9 @@
 import { dispatchPreparing } from "../controller/images.js"
-import { RETRYABLE_BLOCKED_REASONS, TERMINAL_STATES } from "../domain/states.js"
+import {
+  REDELIVERABLE_BLOCKED_REASONS,
+  RETRYABLE_BLOCKED_REASONS,
+  TERMINAL_STATES,
+} from "../domain/states.js"
 import type { FactoryEvent, WorkOrderRow } from "../domain/work-order.js"
 
 /** `run`'s exit code when it stopped at a person's gate and approved nothing. */
@@ -98,6 +102,7 @@ export function nextStep(
     case "running":
     case "verifying":
     case "exporting":
+    case "delivering":
     case "cancel_requested":
       return { kind: "follow", why: `it is ${state}` }
     case "awaiting_intake_approval":
@@ -115,6 +120,7 @@ export function nextStep(
         }
       return { kind: "gate", gate: "export" }
     case "exported":
+    case "delivered":
       return { kind: "done" }
     case "blocked": {
       const reason = row.blockedReason
@@ -122,12 +128,21 @@ export function nextStep(
         reason !== null &&
         RETRYABLE_BLOCKED_REASONS.has(reason) &&
         row.candidateAttempts < row.maxCandidateAttempts
+      // A delivery block the world can heal: a person redelivers (it asks for the bundle
+      // digest's prefix, like a review); run never does.
+      const redeliverable = reason !== null && REDELIVERABLE_BLOCKED_REASONS.has(reason)
       return {
         kind: "stop",
         message: `Blocked: ${reason ?? "no reason recorded"}`,
         next: retryable
           ? [`pnpm factory retry ${id}`, `pnpm factory run ${id}`]
-          : [`pnpm factory events ${id}`, `pnpm factory cancel ${id}`],
+          : redeliverable
+            ? [
+                `pnpm factory events ${id}`,
+                `pnpm factory redeliver ${id}`,
+                `pnpm factory cancel ${id}`,
+              ]
+            : [`pnpm factory events ${id}`, `pnpm factory cancel ${id}`],
       }
     }
     case "denied":
@@ -164,6 +179,7 @@ export function chooseWorkOrder(rows: readonly WorkOrderRow[], fresh: boolean):
   const [only] = live
   if (only !== undefined) return { kind: "resume", row: only }
   const newest = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
-  if (newest?.state === "exported") return { kind: "done", row: newest }
+  if (newest?.state === "exported" || newest?.state === "delivered")
+    return { kind: "done", row: newest }
   return { kind: "create" }
 }
```

- [ ] **Step 5: Run the tests, the type check and the existing state tests**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/delivery-states.test.ts test/run-steps.test.ts test/states.test.ts`
Expected: PASS. (`test/states.test.ts`'s "allows cancel from every non-terminal state" now covers `delivering` by construction: `cancel` is built from `NON_TERMINAL`.)

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write src/lib/domain/states.ts src/lib/operator/run-steps.ts test/delivery-states.test.ts test/run-steps.test.ts
git add src/lib/domain/states.ts src/lib/operator/run-steps.ts test/delivery-states.test.ts test/run-steps.test.ts
git commit -m "feat(software-factory): delivering and delivered, the delivery blocks, and run's steps for them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Where a work order delivers, on the row and in the registry (migration 6)

**Files:**
- Modify: `src/lib/domain/work-order.ts`, `src/lib/registry/db.ts`, `src/lib/registry/work-orders.ts`, `src/lib/registry/reader.ts`, `src/lib/controller/factory.ts` (the insert only)
- Modify (the row fixtures gain `delivery: { kind: "local" }`): `test/budget.test.ts`, `test/evidence.test.ts`, `test/factory-up.test.ts`, `test/schemas.test.ts`, `test/work-orders.test.ts`, `test/run-steps.test.ts`; (the version and tables): `test/registry-db.test.ts`, `test/registry-reader.test.ts`
- Test: `test/delivery-row.test.ts` (new)

- [ ] **Step 1: Write the failing test**

`examples/software-factory/controller/test/delivery-row.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { RowDeliverySchema } from "../src/lib/domain/work-order.ts"
import { MIGRATIONS, openRegistry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore } from "../src/lib/registry/work-orders.ts"

const DRAFT_PR = {
  kind: "draft-pr" as const,
  repository: "cacheplane/b4run",
  baseBranch: "main",
  branch: "factory/wo-0123456789abcdef",
  pathPrefix: null,
  issueStateAtCreate: "open" as const,
}

describe("a work order's delivery", () => {
  it("accepts only factory/<work order id> as the branch", () => {
    const draft = DRAFT_PR
    expect(RowDeliverySchema.parse(draft)).toEqual(draft)
    for (const branch of [
      "main",
      "factory/x",
      "factory/wo-0123456789abcdef/y",
      "refs/heads/factory/wo-0123456789abcdef",
    ])
      expect(RowDeliverySchema.safeParse({ ...draft, branch }).success).toBe(false)
  })
})

describe("registry migration 6", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it("reads every existing work order as a local export and adds the outbox", () => {
    dir = mkdtempSync(join(tmpdir(), "migration-6-"))
    const path = join(dir, "registry.sqlite")
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)")
    for (const migration of MIGRATIONS.slice(0, 5)) {
      db.exec(migration.up)
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(migration.version)
    }
    const at = "2026-10-01T00:00:00.000Z"
    db.prepare(
      `INSERT INTO work_orders (id, revision, state, task_id, worker_route, max_candidate_attempts,
         max_active_ms, active_ms, created_at, updated_at)
       VALUES ('wo-legacy', 0, 'exported', 'cli-flags', '/build#agent', 1, 60000, 0, ?, ?)`,
    ).run(at, at)
    db.prepare(
      "INSERT INTO deliveries (work_order_id, candidate_digest, receipt_path, observed_at) VALUES ('wo-legacy', ?, '/x.json', ?)",
    ).run("c".repeat(64), at)
    db.close()
    const registry = openRegistry(path)
    const store = createWorkOrderStore(registry.db)
    expect(store.get("wo-legacy")?.delivery).toEqual({ kind: "local" })
    expect(store.delivery("wo-legacy")).toEqual({
      workOrderId: "wo-legacy",
      candidateDigest: "c".repeat(64),
      receiptPath: "/x.json",
      observedAt: at,
    })
    const tables = (
      registry.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((t) => t.name)
    expect(tables).toContain("delivery_outbox")
    registry.close()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run test/delivery-row.test.ts`
Expected: FAIL: `RowDeliverySchema` is not exported.

- [ ] **Step 3: The schemas.** `src/lib/domain/work-order.ts` (Task 14 adds `"redeliver"` to `COMMANDS` later):

```diff
diff --git a/examples/software-factory/controller/src/lib/domain/work-order.ts b/examples/software-factory/controller/src/lib/domain/work-order.ts
index 790e96ce0..f29c84ca2
--- a/examples/software-factory/controller/src/lib/domain/work-order.ts
+++ b/examples/software-factory/controller/src/lib/domain/work-order.ts
@@ -28,6 +28,39 @@ export const OriginSchema = z.discriminatedUnion("kind", [CatalogOriginSchema, I
 export type Origin = z.infer<typeof OriginSchema>
 export type IssueOrigin = z.infer<typeof IssueOriginSchema>
 
+/**
+ * A branch name the factory targets or writes: git's own refusals (`git check-ref-format
+ * --branch`) for the shapes a config or a row could carry, and never a full `refs/` name.
+ */
+export const BRANCH_PATTERN =
+  /^(?!-)(?!refs\/)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)(?!.*\.lock$)(?!.*@\{)[A-Za-z0-9._/-]+$/
+/** The branch a draft-PR delivery writes: `factory/<work order id>`, and nothing else. */
+export const FACTORY_BRANCH = /^factory\/wo-[0-9a-f]{16}$/
+
+/**
+ * Where an approved bundle goes (rung 4 spec §3.2), chosen at create and never changed: a
+ * local export (today's, the default and every row before migration 6), or a draft pull
+ * request on the issue's repository. `pathPrefix` is the drafted target's root, known only
+ * once intake fits the draft to a target, and filled then; the rest is fixed at create.
+ */
+export const LocalDeliverySchema = z.object({ kind: z.literal("local") }).strict()
+export const DraftPrDeliverySchema = z
+  .object({
+    kind: z.literal("draft-pr"),
+    repository: z.string().regex(REPOSITORY_PATTERN),
+    baseBranch: z.string().regex(BRANCH_PATTERN),
+    branch: z.string().regex(FACTORY_BRANCH),
+    pathPrefix: z.string().min(1).nullable(),
+    issueStateAtCreate: z.enum(["open", "closed"]),
+  })
+  .strict()
+export const RowDeliverySchema = z.discriminatedUnion("kind", [
+  LocalDeliverySchema,
+  DraftPrDeliverySchema,
+])
+export type RowDelivery = z.infer<typeof RowDeliverySchema>
+export type DraftPrDelivery = z.infer<typeof DraftPrDeliverySchema>
+
 export const WorkOrderRowSchema = z.object({
   id: z.string().min(1),
   revision: z.number().int().nonnegative(),
@@ -56,6 +89,8 @@ export const WorkOrderRowSchema = z.object({
    * order, recorded by `create --issue` and never changed.
    */
   pin: z.string().regex(COMMIT_PATTERN).nullable(),
+  /** Where the approved bundle goes; `{ kind: "local" }` for every row before rung 4. */
+  delivery: RowDeliverySchema,
   /** The prepared target the drafted task fits; null until intake resolves it. */
   targetId: z.string().min(1).nullable(),
   /** The digest of the generated task directory the intake gate binds to. */
@@ -115,11 +150,27 @@ export const ApprovalSchema = z.object({
 })
 export type Approval = z.infer<typeof ApprovalSchema>
 
+/** What a draft-PR delivery found when it read the pull request back (spec §5.2, confirm). */
+export const PullRequestReceiptSchema = z
+  .object({
+    number: z.number().int().positive(),
+    url: z.string().url(),
+    headSha: z.string().regex(COMMIT_PATTERN),
+    treeSha: z.string().regex(COMMIT_PATTERN),
+    baseTip: z.string().regex(COMMIT_PATTERN),
+    aheadBy: z.number().int().nonnegative(),
+  })
+  .strict()
+export type PullRequestReceipt = z.infer<typeof PullRequestReceiptSchema>
+
 export const DeliverySchema = z.object({
   workOrderId: z.string().min(1),
   candidateDigest: z.string().regex(DIGEST_PATTERN),
+  /** The export's path, or the pull request's URL for a draft-PR delivery. */
   receiptPath: z.string().min(1),
   observedAt: z.string(),
+  /** Present exactly for a draft-PR delivery. */
+  pullRequest: PullRequestReceiptSchema.optional(),
 })
 export type Delivery = z.infer<typeof DeliverySchema>
 
```

- [ ] **Step 4: Migration 6** (the outbox table lands here so the schema moves once; its store is Task 9):

```diff
diff --git a/examples/software-factory/controller/src/lib/registry/db.ts b/examples/software-factory/controller/src/lib/registry/db.ts
index 920e4bbd6..244f25982 100644
--- a/examples/software-factory/controller/src/lib/registry/db.ts
+++ b/examples/software-factory/controller/src/lib/registry/db.ts
@@ -2,7 +2,7 @@ import { mkdirSync } from "node:fs"
 import { dirname } from "node:path"
 import { DatabaseSync } from "node:sqlite"
 
-export const SCHEMA_VERSION = 5
+export const SCHEMA_VERSION = 6
 
 export interface Registry {
   readonly db: DatabaseSync
@@ -182,6 +182,35 @@ export const MIGRATIONS: readonly Migration[] = [
       );
     `,
   },
+  {
+    // Rung 4: where an approved bundle goes, the outbox intent a draft-PR approval commits,
+    // and the pull request a delivery read back. Every existing row is a local export, which
+    // is what it was; an existing delivery is an export, with no pull request columns.
+    version: 6,
+    up: `
+      ALTER TABLE work_orders ADD COLUMN delivery TEXT NOT NULL DEFAULT '{"kind":"local"}';
+      CREATE TABLE delivery_outbox (
+        operation_key TEXT PRIMARY KEY,
+        work_order_id TEXT NOT NULL UNIQUE REFERENCES work_orders(id),
+        bundle_digest TEXT NOT NULL,
+        approval_id TEXT NOT NULL REFERENCES approvals(id),
+        intent TEXT NOT NULL,
+        step TEXT NOT NULL,
+        remote TEXT NOT NULL,
+        attempts INTEGER NOT NULL,
+        last_error TEXT,
+        created_at TEXT NOT NULL,
+        updated_at TEXT NOT NULL
+      );
+      ALTER TABLE deliveries ADD COLUMN kind TEXT;
+      ALTER TABLE deliveries ADD COLUMN pr_number INTEGER;
+      ALTER TABLE deliveries ADD COLUMN pr_url TEXT;
+      ALTER TABLE deliveries ADD COLUMN head_sha TEXT;
+      ALTER TABLE deliveries ADD COLUMN tree_sha TEXT;
+      ALTER TABLE deliveries ADD COLUMN base_sha TEXT;
+      ALTER TABLE deliveries ADD COLUMN ahead_by INTEGER;
+    `,
+  },
 ]
 
 /** Open (creating if needed) the factory registry. Refuses a newer on-disk schema. */
```

- [ ] **Step 5: The store reads and writes the column, and the receipt's pull request**

```diff
diff --git a/examples/software-factory/controller/src/lib/registry/work-orders.ts b/examples/software-factory/controller/src/lib/registry/work-orders.ts
index d28f3cafc..dbc9770fd 100644
--- a/examples/software-factory/controller/src/lib/registry/work-orders.ts
+++ b/examples/software-factory/controller/src/lib/registry/work-orders.ts
@@ -8,6 +8,7 @@ import {
   FactoryEventSchema,
   type Origin,
   OriginSchema,
+  RowDeliverySchema,
   type WorkOrderRow,
   WorkOrderRowSchema,
 } from "../domain/work-order.js"
@@ -45,6 +46,7 @@ export type WorkOrderPatch = Partial<
     | "taskDigest"
     | "intakeAttempts"
     | "candidateAttempts"
+    | "delivery"
   >
 >
 
@@ -81,6 +83,7 @@ export interface WorkOrderStore {
  * is the one row field with no entry here.
  */
 const COLUMNS: Readonly<Record<Exclude<keyof WorkOrderRow, "origin">, string>> = {
+  delivery: "delivery",
   id: "id",
   revision: "revision",
   state: "state",
@@ -136,6 +139,8 @@ function originFromSql(record: Record<string, unknown>): Origin {
 }
 
 function toSql(key: keyof typeof COLUMNS, value: unknown): SqlValue {
+  // The one object column: stored as JSON, validated on the way in and on the way out.
+  if (key === "delivery") return JSON.stringify(RowDeliverySchema.parse(value))
   if (value === null || value === undefined) return null
   if (typeof value === "number" || typeof value === "string") return value
   throw new TypeError(`Unsupported value for ${key}`)
@@ -146,6 +151,7 @@ function fromSql(record: Record<string, unknown>): WorkOrderRow {
   for (const [key, column] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) {
     raw[key] = record[column] ?? null
   }
+  raw.delivery = JSON.parse(String(record.delivery))
   raw.origin = originFromSql(record)
   return WorkOrderRowSchema.parse(raw)
 }
@@ -268,27 +274,46 @@ export function createWorkOrderStore(db: DatabaseSync): WorkOrderStore {
     },
     recordDelivery(delivery) {
       DeliverySchema.parse(delivery)
+      const pr = delivery.pullRequest
       db.prepare(
-        "INSERT INTO deliveries (work_order_id, candidate_digest, receipt_path, observed_at) VALUES (?, ?, ?, ?)",
+        "INSERT INTO deliveries (work_order_id, candidate_digest, receipt_path, observed_at, kind, pr_number, pr_url, head_sha, tree_sha, base_sha, ahead_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
       ).run(
         delivery.workOrderId,
         delivery.candidateDigest,
         delivery.receiptPath,
         delivery.observedAt,
+        pr ? "draft-pr" : "local",
+        pr?.number ?? null,
+        pr?.url ?? null,
+        pr?.headSha ?? null,
+        pr?.treeSha ?? null,
+        pr?.baseTip ?? null,
+        pr?.aheadBy ?? null,
       )
     },
     delivery(workOrderId) {
       const r = db.prepare("SELECT * FROM deliveries WHERE work_order_id = ?").get(workOrderId) as
-        | Record<string, string>
+        | Record<string, string | number | null>
         | undefined
-      return r
-        ? DeliverySchema.parse({
-            workOrderId: r.work_order_id,
-            candidateDigest: r.candidate_digest,
-            receiptPath: r.receipt_path,
-            observedAt: r.observed_at,
-          })
-        : null
+      if (!r) return null
+      return DeliverySchema.parse({
+        workOrderId: r.work_order_id,
+        candidateDigest: r.candidate_digest,
+        receiptPath: r.receipt_path,
+        observedAt: r.observed_at,
+        ...(r.kind === "draft-pr"
+          ? {
+              pullRequest: {
+                number: r.pr_number,
+                url: r.pr_url,
+                headSha: r.head_sha,
+                treeSha: r.tree_sha,
+                baseTip: r.base_sha,
+                aheadBy: r.ahead_by,
+              },
+            }
+          : {}),
+      })
     },
     transaction(fn) {
       if (open.depth > 0) {
```

- [ ] **Step 6: The reader's `delivery()`.** In `src/lib/registry/reader.ts` add `Delivery` to the `work-order.js` type import, add to `RegistryReader` after `evidence(…)`:

```ts
  /** The recorded delivery: the export's path, or the pull request read back (rung 4). */
  delivery(id: string): Delivery | null
```

and to the returned object after `events: (id) => store.events(id),`:

```ts
    delivery: (id) => store.delivery(id),
```

- [ ] **Step 7: Every create records a local delivery for now.** In `src/lib/controller/factory.ts`, `insertWorkOrder`'s `fields` type gains the field, and both creates name it (Task 12 replaces the issue create's):

```diff
diff --git a/examples/software-factory/controller/src/lib/controller/factory.ts b/examples/software-factory/controller/src/lib/controller/factory.ts
index f34582021..88a2c7f58
--- a/examples/software-factory/controller/src/lib/controller/factory.ts
+++ b/examples/software-factory/controller/src/lib/controller/factory.ts
@@ -838,7 +838,7 @@ export async function createFactory(options: FactoryOptions): Promise<Factory> {
     operationKey: string | undefined,
     /** Both the command's recorded args and the `created` event's payload. */
     payload: Record<string, unknown>,
-    fields: (id: string) => Pick<WorkOrderRow, "taskId" | "origin" | "pin">,
+    fields: (id: string) => Pick<WorkOrderRow, "taskId" | "origin" | "pin" | "delivery">,
   ): WorkOrderRow {
     const id = operationKey
       ? `wo-${createHash("sha256").update(operationKey).digest("hex").slice(0, 16)}`
@@ -1088,6 +1088,7 @@ export async function createFactory(options: FactoryOptions): Promise<Factory> {
         taskId,
         origin: { kind: "catalog" },
         pin: null,
+        delivery: { kind: "local" },
       }))
       // A warning, not a refusal: the row is created (its budget cannot change after), and
       // `dispatch` refuses it. Journalled once, so a replayed key adds nothing. A generated
@@ -1115,6 +1116,7 @@ export async function createFactory(options: FactoryOptions): Promise<Factory> {
         taskId: id,
         origin,
         pin,
+        delivery: { kind: "local" },
       }))
       // The issue text lands after the row: a directory with only `issue.md` is not a task the
       // catalog lists, so nothing can dispatch it. Written only when absent, so a replayed key
```

- [ ] **Step 8: The fixtures and the version pins.** Add `delivery: { kind: "local" },` after the `maxIntakeAttempts: 2,` line of the literal row in each of `test/budget.test.ts` (line 35), `test/evidence.test.ts` (34), `test/factory-up.test.ts` (652), `test/schemas.test.ts` (36), `test/work-orders.test.ts` (33 and 209) and `test/run-steps.test.ts` (41):

```bash
for f in test/budget.test.ts test/evidence.test.ts test/factory-up.test.ts test/run-steps.test.ts test/work-orders.test.ts test/schemas.test.ts; do
  perl -0pi -e 's/^(\s*)maxIntakeAttempts: 2,\n/$1maxIntakeAttempts: 2,\n$1delivery: { kind: "local" },\n/mg' "$f"
done
git diff --stat test/   # 6 files, 7 insertions
```

Then the version and table pins:

```diff
diff --git a/examples/software-factory/controller/test/registry-db.test.ts b/examples/software-factory/controller/test/registry-db.test.ts
index 9d8dc8ab7..dbd5bd5ac 100644
--- a/examples/software-factory/controller/test/registry-db.test.ts
+++ b/examples/software-factory/controller/test/registry-db.test.ts
@@ -32,7 +32,7 @@ describe("openRegistry", () => {
       registry.db.prepare("PRAGMA table_info(work_orders)").all() as { name: string }[]
     ).map((c) => c.name)
     expect(columns).not.toContain("candidate_verified")
-    expect(SCHEMA_VERSION).toBe(5)
+    expect(SCHEMA_VERSION).toBe(6)
     registry.close()
   })
 
@@ -47,6 +47,7 @@ describe("openRegistry", () => {
       "candidates",
       "commands",
       "deliveries",
+      "delivery_outbox",
       "events",
       "receipts",
       "schema_version",
@@ -143,6 +144,7 @@ describe("migration 4", () => {
       intakeAttempts: 0,
       maxIntakeAttempts: 2,
       candidateAttempts: 0,
+      delivery: { kind: "local" },
     }
     const row = createWorkOrderStore(registry.db).get("wo-legacy")
     expect(row).toMatchObject(expected)
@@ -200,7 +202,7 @@ describe("migration 5", () => {
 
     // Only a writer migrates: a reader of the schema-4 file says so rather than misread it.
     expect(() => openRegistryReader(path)).toThrow(
-      "Registry schema version 4 is older than this factory needs (5); start the controller, which migrates it",
+      "Registry schema version 4 is older than this factory needs (6); start the controller, which migrates it",
     )
     const registry = openRegistry(path)
     const store = createWorkOrderStore(registry.db)
```

```diff
diff --git a/examples/software-factory/controller/test/registry-reader.test.ts b/examples/software-factory/controller/test/registry-reader.test.ts
index ea845328f..59f76e022 100644
--- a/examples/software-factory/controller/test/registry-reader.test.ts
+++ b/examples/software-factory/controller/test/registry-reader.test.ts
@@ -114,7 +114,7 @@ describe("registry reader", () => {
     db.close()
     expect(() => openRegistryReader(registryPath)).toThrow(RegistryOutdatedError)
     expect(() => openRegistryReader(registryPath)).toThrow(
-      "Registry schema version 3 is older than this factory needs (5); start the controller, which migrates it",
+      "Registry schema version 3 is older than this factory needs (6); start the controller, which migrates it",
     )
   })
 
```

- [ ] **Step 9: Run the type check and the registry, schema and store tests**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/delivery-row.test.ts test/registry-db.test.ts test/registry-reader.test.ts test/work-orders.test.ts test/schemas.test.ts test/evidence.test.ts test/budget.test.ts test/run-steps.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
pnpm exec biome check --write src/lib/domain/work-order.ts src/lib/registry/db.ts src/lib/registry/work-orders.ts src/lib/registry/reader.ts src/lib/controller/factory.ts test/delivery-row.test.ts test/registry-db.test.ts test/registry-reader.test.ts test/budget.test.ts test/evidence.test.ts test/factory-up.test.ts test/schemas.test.ts test/work-orders.test.ts test/run-steps.test.ts
git add src/lib/domain/work-order.ts src/lib/registry/db.ts src/lib/registry/work-orders.ts src/lib/registry/reader.ts src/lib/controller/factory.ts test/delivery-row.test.ts test/registry-db.test.ts test/registry-reader.test.ts test/budget.test.ts test/evidence.test.ts test/factory-up.test.ts test/schemas.test.ts test/work-orders.test.ts test/run-steps.test.ts
git commit -m "feat(software-factory): a work order records where it delivers (registry migration 6)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: The bundle names its operation; a draft-PR bundle digests its destination

**Files:**
- Modify: `src/lib/review/bundle.ts`, `src/lib/domain/digest.ts`
- Test: `test/bundle-delivery.test.ts` (new)

- [ ] **Step 1: Write the failing test.** Its first case pins the export-local digest of one fixed input to the value the freeze at `216befd5a` produced (Today row 16, Trap 4):

`examples/software-factory/controller/test/bundle-delivery.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { bundleDigest } from "../src/lib/domain/digest.ts"
import { BundlePayloadSchema, freezeBundle } from "../src/lib/review/bundle.ts"

const receipt = {
  id: "rc-1",
  workOrderId: "wo-0123456789abcdef",
  candidateDigest: "c".repeat(64),
  verifierIdentity: "docker",
  policyDigest: "e".repeat(64),
  environmentIdentity: "env-1",
  verdict: "pass" as const,
  checks: [
    {
      id: "visible",
      acceptanceIds: [],
      verdict: "pass" as const,
      evidence: [{ id: "out", digest: "f".repeat(64) }],
    },
  ],
  issuedAt: "2026-10-01T00:00:00.000Z",
}
const freezeInput = {
  workOrderId: "wo-0123456789abcdef",
  repositoryId: "wo-0123456789abcdef",
  baselineDigest: "a".repeat(64),
  specificationDigest: "b".repeat(64),
  policyDigest: "e".repeat(64),
  candidateDigest: "c".repeat(64),
  receipt,
  destinationId: "/state/exports",
  frozenAt: "2026-10-01T00:00:01.000Z",
  origin: {
    kind: "issue" as const,
    repository: "cacheplane/b4run",
    number: 912,
    bodyDigest: "0".repeat(64),
  },
  pin: "7".repeat(40),
  taskDigest: "d".repeat(64),
  oracleReceiptId: "rc-0",
}
const DRAFT_PR = {
  repository: "cacheplane/b4run",
  baseBranch: "main",
  branch: "factory/wo-0123456789abcdef",
  pathPrefix: ".",
  issueStateAtCreate: "open" as const,
}

describe("the bundle", () => {
  it("freezes an export-local bundle exactly as before rung 4, with no delivery key", () => {
    const bundle = freezeBundle(freezeInput)
    // Computed with the freeze at 216befd5a: every bundle frozen before rung 4 still digests
    // to the digest it was approved under.
    expect(bundle.digest).toBe("c7c751845529b7250882912d501ae38fa97e4db80ca0299157c32ba7d69008e6")
    expect(Object.keys(bundle.payload)).not.toContain("delivery")
    expect(BundlePayloadSchema.parse(bundle.payload).operation).toBe("export-local")
  })

  it("binds a draft-PR delivery into the digest, every field of it", () => {
    const bundle = freezeBundle({ ...freezeInput, delivery: DRAFT_PR })
    const payload = BundlePayloadSchema.parse(bundle.payload)
    expect(payload).toMatchObject({
      operation: "draft-pr",
      destinationId: "github:cacheplane/b4run:refs/heads/factory/wo-0123456789abcdef",
      delivery: DRAFT_PR,
    })
    expect(bundleDigest(payload)).toBe(bundle.digest)
    const digests = new Set([bundle.digest, freezeBundle(freezeInput).digest])
    for (const [field, value] of [
      ["repository", "cacheplane/other"],
      ["baseBranch", "next"],
      ["branch", "factory/wo-fedcba9876543210"],
      ["pathPrefix", "packages"],
      ["issueStateAtCreate", "closed"],
    ] as const)
      digests.add(
        freezeBundle({ ...freezeInput, delivery: { ...DRAFT_PR, [field]: value } }).digest,
      )
    expect(digests.size).toBe(7)
  })

  it("refuses a draft-PR bundle with no pin", () => {
    expect(() => freezeBundle({ ...freezeInput, pin: null, delivery: DRAFT_PR })).toThrow(/pin/)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run test/bundle-delivery.test.ts`
Expected: the first case PASSES (nothing changed yet: that is the point of the pin); the other two FAIL (`delivery` is not a freeze input; the payload does not parse as `draft-pr`).

- [ ] **Step 3: The union and the freeze**

```diff
diff --git a/examples/software-factory/controller/src/lib/review/bundle.ts b/examples/software-factory/controller/src/lib/review/bundle.ts
index d4e591c62..6c4ad3ce9 100644
--- a/examples/software-factory/controller/src/lib/review/bundle.ts
+++ b/examples/software-factory/controller/src/lib/review/bundle.ts
@@ -1,7 +1,14 @@
 import { z } from "zod"
 import { bundleDigest } from "../domain/digest.js"
 import type { Bundle, Origin, Receipt } from "../domain/work-order.js"
-import { COMMIT_PATTERN, DIGEST_PATTERN, OriginSchema } from "../domain/work-order.js"
+import {
+  BRANCH_PATTERN,
+  COMMIT_PATTERN,
+  DIGEST_PATTERN,
+  FACTORY_BRANCH,
+  OriginSchema,
+  REPOSITORY_PATTERN,
+} from "../domain/work-order.js"
 
 /**
  * What the frozen payload asserts, as a shape something can read back.
@@ -11,7 +18,7 @@ import { COMMIT_PATTERN, DIGEST_PATTERN, OriginSchema } from "../domain/work-ord
  * environment happened to be current rather than the ones consent was given for. Approval
  * parses the payload with this and compares field by field.
  */
-export const BundlePayloadSchema = z.object({
+const ExportLocalPayloadSchema = z.object({
   workOrderId: z.string().min(1),
   repositoryId: z.string().min(1),
   baselineDigest: z.string().regex(DIGEST_PATTERN),
@@ -37,7 +44,48 @@ export const BundlePayloadSchema = z.object({
   /** The receipt that proved the drafted check fails on the unpatched baseline. */
   oracleReceiptId: z.string().min(1).nullable(),
 })
+
+/**
+ * Where a draft-PR bundle publishes, digested with everything else (rung 4 spec §3.3): the
+ * person who approves the bundle approves exactly this repository, base, branch and path
+ * prefix, at the payload's own `pin`. Changing any of them needs a new bundle.
+ */
+export const DraftPrBundleDeliverySchema = z
+  .object({
+    repository: z.string().regex(REPOSITORY_PATTERN),
+    baseBranch: z.string().regex(BRANCH_PATTERN),
+    branch: z.string().regex(FACTORY_BRANCH),
+    pathPrefix: z.string().min(1),
+    issueStateAtCreate: z.enum(["open", "closed"]),
+  })
+  .strict()
+export type DraftPrBundleDelivery = z.infer<typeof DraftPrBundleDeliverySchema>
+
+const DraftPrPayloadSchema = ExportLocalPayloadSchema.extend({
+  operation: z.literal("draft-pr"),
+  delivery: DraftPrBundleDeliverySchema,
+  // An issue work order has a pin; a draft-PR bundle without one has nothing to branch at.
+  pin: z.string().regex(COMMIT_PATTERN),
+})
+
+/**
+ * The two operations a bundle can authorize. `export-local` is exactly the payload every
+ * bundle before rung 4 was frozen with, field for field, so each still parses and digests to
+ * the digest it was frozen under.
+ */
+export const BundlePayloadSchema = z.discriminatedUnion("operation", [
+  ExportLocalPayloadSchema,
+  DraftPrPayloadSchema,
+])
 export type BundlePayload = z.infer<typeof BundlePayloadSchema>
+export type DraftPrBundlePayload = z.infer<typeof DraftPrPayloadSchema>
+
+/** A draft-PR bundle's destination identity: one repository, one branch. */
+export function draftPrDestinationId(
+  delivery: Pick<DraftPrBundleDelivery, "repository" | "branch">,
+): string {
+  return `github:${delivery.repository}:refs/heads/${delivery.branch}`
+}
 
 export interface FreezeBundleInput {
   readonly workOrderId: string
@@ -53,6 +101,12 @@ export interface FreezeBundleInput {
   readonly pin: string | null
   readonly taskDigest: string | null
   readonly oracleReceiptId: string | null
+  /**
+   * Present: the bundle authorizes a draft pull request (`operation: "draft-pr"`) and its
+   * `destinationId` is derived from this, not taken from `destinationId`. Absent: today's
+   * export, byte for byte.
+   */
+  readonly delivery?: DraftPrBundleDelivery
 }
 
 /**
@@ -80,7 +134,7 @@ export function freezeBundle(input: FreezeBundleInput): Bundle {
     .map(([id, digest]) => ({ id, digest }))
     .sort((a, b) => (a.id < b.id ? -1 : 1))
 
-  const payload = {
+  const common = {
     workOrderId: input.workOrderId,
     repositoryId: input.repositoryId,
     baselineDigest: input.baselineDigest,
@@ -89,8 +143,6 @@ export function freezeBundle(input: FreezeBundleInput): Bundle {
     environmentIdentity: input.receipt.environmentIdentity,
     candidateDigest: input.candidateDigest,
     evidence,
-    operation: "export-local" as const,
-    destinationId: input.destinationId,
     receiptId: input.receipt.id,
     frozenAt: input.frozenAt,
     origin: input.origin,
@@ -98,6 +150,22 @@ export function freezeBundle(input: FreezeBundleInput): Bundle {
     taskDigest: input.taskDigest,
     oracleReceiptId: input.oracleReceiptId,
   }
+  // An export-local payload carries no `delivery` key at all: adding one, even empty, would
+  // move the digest of every bundle a local export freezes.
+  let payload: BundlePayload
+  if (input.delivery === undefined)
+    payload = { ...common, operation: "export-local", destinationId: input.destinationId }
+  else {
+    if (input.pin === null) throw new Error("A draft-PR bundle needs the work order's pin")
+    const delivery = DraftPrBundleDeliverySchema.parse(input.delivery)
+    payload = {
+      ...common,
+      pin: input.pin,
+      operation: "draft-pr",
+      destinationId: draftPrDestinationId(delivery),
+      delivery,
+    }
+  }
 
   return {
     digest: bundleDigest(payload),
```

```diff
diff --git a/examples/software-factory/controller/src/lib/domain/digest.ts b/examples/software-factory/controller/src/lib/domain/digest.ts
index 0e0fe28f4..1e2eecae1 100644
--- a/examples/software-factory/controller/src/lib/domain/digest.ts
+++ b/examples/software-factory/controller/src/lib/domain/digest.ts
@@ -112,7 +112,7 @@ export interface BundleDigestInput {
   readonly environmentIdentity: string
   readonly candidateDigest: string
   readonly evidence: readonly { readonly id: string; readonly digest: string }[]
-  readonly operation: "export-local"
+  readonly operation: "export-local" | "draft-pr"
   readonly destinationId: string
 }
 
```

- [ ] **Step 4: Run the bundle tests, old and new, and every approve test** (they parse frozen payloads with the union now)

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/bundle-delivery.test.ts test/bundle.test.ts test/factory-approve.test.ts test/operator-review.test.ts`
Expected: PASS, and the golden digest unchanged.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write src/lib/review/bundle.ts src/lib/domain/digest.ts test/bundle-delivery.test.ts
git add src/lib/review/bundle.ts src/lib/domain/digest.ts test/bundle-delivery.test.ts
git commit -m "feat(software-factory): a bundle binds its operation; draft-pr names repository, base, branch and path prefix

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Git object ids, computed locally and proved against git

**Files:**
- Create: `src/lib/delivery/git-objects.ts`
- Test: `test/git-objects.test.ts`

- [ ] **Step 1: Write the failing test** (it builds a real repository with every mode and a multibyte file, and predicts a change's root tree before committing it):

`examples/software-factory/controller/test/git-objects.test.ts`:

```ts
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  blobId,
  changedTreeId,
  directoriesOf,
  type GitTreeEntry,
  readPinListings,
  treeId,
} from "../src/lib/delivery/git-objects.ts"

let repo: string | undefined
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
  repo = undefined
})

/** git, isolated from the developer's config, in a fresh repository. */
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", repo as string, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim()

function write(path: string, text: string): void {
  const absolute = join(repo as string, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, text)
}

/** `git ls-tree <sha>` as GitHub's non-recursive `git/trees/<sha>` reports it. */
const lsTree = async (sha: string): Promise<GitTreeEntry[]> =>
  git("ls-tree", "-z", sha)
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const [meta, name] = line.split("\t") as [string, string]
      const [mode, type, id] = meta.split(" ") as [string, GitTreeEntry["type"], string]
      return { name, mode: mode === "040000" ? "040000" : mode, type, sha: id }
    })

function fixture(): string {
  repo = mkdtempSync(join(tmpdir(), "git-objects-"))
  git("init", "-q", "-b", "main")
  write("README.md", "# fixture\n")
  write("packages/devkit/src/testing/process.ts", "export const deadline = 'leaks'\n")
  write("packages/devkit/src/testing/process-utils.ts", "x\n")
  write("packages/devkit/src/testing.ts", "export * from './testing/process.js'\n")
  write("packages/devkit-extra/a.ts", "a\n")
  write("packages/z.ts", "é and ✓\n")
  write("bin/run.sh", "#!/bin/sh\n")
  chmodSync(join(repo, "bin/run.sh"), 0o755)
  symlinkSync("README.md", join(repo, "LINK"))
  git("add", "-A")
  git("commit", "-q", "-m", "pin")
  return git("rev-parse", "HEAD")
}

describe("git object ids", () => {
  it("computes a blob id exactly as git hash-object does, for multibyte text too", () => {
    fixture()
    for (const text of ["", "a\n", "é and ✓\n", "no newline"]) {
      write("probe", text)
      expect(blobId(text)).toBe(git("hash-object", "probe"))
    }
  })

  it("computes a tree id exactly as git does, in git's order, with every mode", async () => {
    const pin = fixture()
    for (const path of ["", "packages", "packages/devkit/src"]) {
      const sha = git("rev-parse", `${pin}:${path}`)
      expect(treeId(await lsTree(sha))).toBe(sha)
    }
  })

  it("predicts the root tree a change produces, before anything is written", async () => {
    const pin = fixture()
    const changes = {
      "packages/devkit/src/testing/process.ts": "export const deadline = 'cleared'\n",
      "packages/z.ts": "é, ✓ and more\n",
      "bin/run.sh": "#!/bin/sh\nexit 0\n",
    }
    const read = await readPinListings(
      git("rev-parse", `${pin}^{tree}`),
      Object.keys(changes),
      lsTree,
    )
    if (!read.ok) throw new Error(read.problems.join("; "))
    expect(read.entries.get("bin/run.sh")?.mode).toBe("100755")
    expect(read.entries.get("packages/z.ts")?.sha).toBe(blobId("é and ✓\n"))
    const predicted = changedTreeId(
      read.listings,
      new Map(Object.entries(changes).map(([path, text]) => [path, blobId(text)])),
    )
    for (const [path, text] of Object.entries(changes)) write(path, text)
    git("commit", "-q", "-am", "change")
    expect(predicted).toBe(git("rev-parse", "HEAD^{tree}"))
    // The executable bit is the pin's: the change kept it.
    expect(git("ls-tree", "HEAD", "bin/run.sh")).toMatch(/^100755 /)
  })

  it("names every path the pin cannot take the change at, and reads nothing it need not", async () => {
    const pin = fixture()
    const reads: string[] = []
    const result = await readPinListings(
      git("rev-parse", `${pin}^{tree}`),
      ["LINK", "packages/nope.ts", "missing/dir/file.ts", "README.md/x"],
      async (sha) => {
        reads.push(sha)
        return lsTree(sha)
      },
    )
    expect(result).toEqual({
      ok: false,
      problems: [
        "README.md is not a directory at the pin",
        "missing is not a directory at the pin",
        "LINK is not a regular file at the pin (mode 120000)",
        "packages/nope.ts does not exist at the pin",
      ],
    })
    expect(reads).toHaveLength(2) // the root and packages/, never the whole repository
  })

  it("orders directories root first and by depth", () => {
    expect(directoriesOf(["a/b/c.ts", "a/d.ts", "e.ts"])).toEqual(["", "a", "a/b"])
  })

  it("refuses a tree it could not encode faithfully", () => {
    const blob = { name: "a", mode: "100644", type: "blob" as const, sha: "0".repeat(40) }
    expect(() => treeId([blob, blob])).toThrow(/twice/)
    expect(() => treeId([{ ...blob, name: "a/b" }])).toThrow(/one path segment/)
    expect(() => treeId([{ ...blob, mode: "040000" }])).toThrow(/mode 040000 for a blob/)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run test/git-objects.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the module**

`examples/software-factory/controller/src/lib/delivery/git-objects.ts`:

```ts
import { createHash } from "node:crypto"

/**
 * Git's object ids, computed here rather than trusted from GitHub (rung 4 spec §6.3): the
 * delivery worker knows the blob and tree ids the approved change must produce before it
 * writes anything, and refuses any answer that disagrees. SHA-1 object format only, which is
 * what `cacheplane/b4run` uses.
 */

/** A git object id: 40 lowercase hex digits. */
export const OBJECT_ID = /^[0-9a-f]{40}$/

/** `git hash-object` of `text` as UTF-8: `sha1("blob <length>\0" + bytes)`. */
export function blobId(text: string): string {
  const bytes = Buffer.from(text, "utf8")
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}

export type GitEntryType = "blob" | "tree" | "commit"

/** One entry of a tree as GitHub's non-recursive `git/trees` lists it. */
export interface GitTreeEntry {
  /** The entry's own name, one path segment. */
  readonly name: string
  /** As GitHub reports it: `100644`, `100755`, `120000`, `160000` or `040000`. */
  readonly mode: string
  readonly type: GitEntryType
  readonly sha: string
}

const MODES: Readonly<Record<string, GitEntryType>> = {
  "100644": "blob",
  "100755": "blob",
  "120000": "blob",
  "160000": "commit",
  "040000": "tree",
}

/** The mode as git writes it inside a tree object: no leading zero. */
const encodedMode = (mode: string) => (mode === "040000" ? "40000" : mode)

/**
 * Git's tree order: by name as bytes, with a tree compared as if its name ended in `/`.
 * Not `localeCompare`, which would order `a-b` and `a/` differently from git.
 */
function treeOrder(a: GitTreeEntry, b: GitTreeEntry): number {
  const key = (entry: GitTreeEntry) =>
    Buffer.from(entry.type === "tree" ? `${entry.name}/` : entry.name, "utf8")
  return Buffer.compare(key(a), key(b))
}

/** `git mktree` of `entries`: the id of the tree object holding exactly them. */
export function treeId(entries: readonly GitTreeEntry[]): string {
  const names = new Set<string>()
  const parts: Buffer[] = []
  for (const entry of [...entries].sort(treeOrder)) {
    if (MODES[entry.mode] !== entry.type)
      throw new Error(`tree entry ${entry.name} has mode ${entry.mode} for a ${entry.type}`)
    if (entry.name === "" || entry.name.includes("/") || entry.name.includes("\0"))
      throw new Error(`tree entry name ${JSON.stringify(entry.name)} is not one path segment`)
    if (names.has(entry.name)) throw new Error(`tree lists ${entry.name} twice`)
    if (!OBJECT_ID.test(entry.sha)) throw new Error(`tree entry ${entry.name} has id ${entry.sha}`)
    names.add(entry.name)
    parts.push(
      Buffer.from(`${encodedMode(entry.mode)} ${entry.name}\0`, "utf8"),
      Buffer.from(entry.sha, "hex"),
    )
  }
  const body = Buffer.concat(parts)
  return createHash("sha1").update(`tree ${body.length}\0`).update(body).digest("hex")
}

/** The directories a set of repository paths passes through, root (`""`) first, then by depth. */
export function directoriesOf(paths: readonly string[]): string[] {
  const directories = new Set<string>([""])
  for (const path of paths) {
    const segments = path.split("/")
    for (let depth = 1; depth < segments.length; depth += 1)
      directories.add(segments.slice(0, depth).join("/"))
  }
  return [...directories].sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : 1))
}
const depthOf = (directory: string) => (directory === "" ? 0 : directory.split("/").length)
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** What the pin holds at one changed path: the entry the change replaces. */
export interface PinEntry {
  readonly mode: string
  readonly sha: string
}

/**
 * Every directory listing the changed paths pass through, read one directory at a time
 * (non-recursive, so a large repository never meets the recursive listing's truncation), and
 * the pin's entry at each changed path. A path whose directory is missing, or whose last
 * segment is missing or is not a regular file, is reported, never guessed: the approved
 * change cannot be stated as a change to the pin.
 */
export async function readPinListings(
  rootTree: string,
  paths: readonly string[],
  readTree: (sha: string) => Promise<readonly GitTreeEntry[]>,
): Promise<
  | {
      readonly ok: true
      readonly listings: ReadonlyMap<string, readonly GitTreeEntry[]>
      readonly entries: ReadonlyMap<string, PinEntry>
    }
  | { readonly ok: false; readonly problems: readonly string[] }
> {
  const listings = new Map<string, readonly GitTreeEntry[]>()
  const problems: string[] = []
  for (const directory of directoriesOf(paths)) {
    let sha: string
    if (directory === "") sha = rootTree
    else {
      const parent = listings.get(parentOf(directory))
      if (parent === undefined) continue // its parent was already reported
      const entry = parent.find((e) => e.name === nameOf(directory))
      if (entry === undefined || entry.type !== "tree") {
        problems.push(`${directory} is not a directory at the pin`)
        continue
      }
      sha = entry.sha
    }
    listings.set(directory, await readTree(sha))
  }
  const entries = new Map<string, PinEntry>()
  for (const path of paths) {
    const listing = listings.get(parentOf(path))
    if (listing === undefined) continue
    const entry = listing.find((e) => e.name === nameOf(path))
    if (entry === undefined) problems.push(`${path} does not exist at the pin`)
    else if (entry.mode !== "100644" && entry.mode !== "100755")
      problems.push(`${path} is not a regular file at the pin (mode ${entry.mode})`)
    else entries.set(path, { mode: entry.mode, sha: entry.sha })
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, listings, entries }
}

/**
 * The root tree id the approved change must produce: the pin's listings with each changed
 * path's blob replaced, recomputed bottom-up. Modes are kept from the pin; nothing is added
 * or removed, which is exactly what a candidate can do (it cannot add a file).
 */
export function changedTreeId(
  listings: ReadonlyMap<string, readonly GitTreeEntry[]>,
  blobs: ReadonlyMap<string, string>,
): string {
  const replaced = new Map<string, string>()
  for (const [path, sha] of blobs) replaced.set(path, sha)
  const directories = [...listings.keys()].sort((a, b) => depthOf(b) - depthOf(a))
  for (const directory of directories) {
    const listing = listings.get(directory) as readonly GitTreeEntry[]
    const entries = listing.map((entry) => {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`
      const sha = replaced.get(path)
      return sha === undefined ? entry : { ...entry, sha }
    })
    replaced.set(directory, treeId(entries))
  }
  const root = replaced.get("")
  if (root === undefined) throw new Error("no root listing")
  return root
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm exec vitest run test/git-objects.test.ts`
Expected: 6 passed. If "orders directories" or the problem order differs, the fault is the sort: root first, then by depth, then by name (git's byte order puts `README.md` before `missing`).

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write src/lib/delivery/git-objects.ts test/git-objects.test.ts
git add src/lib/delivery/git-objects.ts test/git-objects.test.ts
git commit -m "feat(software-factory): compute git blob and tree ids for a delivery before writing anything

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: The outbox, and the interface a delivery talks to GitHub through

**Files:**
- Create: `src/lib/delivery/outbox.ts`, `src/lib/delivery/adapter.ts`
- Test: `test/outbox.test.ts`

- [ ] **Step 1: Write the failing test**

`examples/software-factory/controller/test/outbox.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createOutboxStore,
  type DeliveryIntent,
  StaleOutboxStepError,
} from "../src/lib/delivery/outbox.ts"
import { openRegistry, type Registry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore } from "../src/lib/registry/work-orders.ts"

let dir: string | undefined
let registry: Registry | undefined
afterEach(() => {
  registry?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
  registry = undefined
  dir = undefined
})

const ID = "wo-0123456789abcdef"
const intent: DeliveryIntent = {
  version: 1,
  workOrderId: ID,
  bundleDigest: "b".repeat(64),
  candidateDigest: "c".repeat(64),
  candidateArtifact: "a".repeat(64),
  repository: "cacheplane/b4run",
  baseBranch: "main",
  branch: `factory/${ID}`,
  pin: "7".repeat(40),
  pathPrefix: ".",
  issue: { number: 912, stateAtCreate: "open" },
  paths: [
    {
      path: "a.ts",
      workspacePath: "a.ts",
      baselineBlob: "1".repeat(40),
      candidateBlob: "2".repeat(40),
    },
  ],
  title: "factory: t",
  specText: "# t\n",
  approvedAt: "2026-10-01T00:00:00.000Z",
  decidedBy: "operator",
  digests: {
    task: "d".repeat(64),
    policy: "e".repeat(64),
    environment: "env",
    oracleReceiptId: null,
    receiptId: "rc",
    reverificationReceiptId: "rc2",
  },
}

function open() {
  dir = mkdtempSync(join(tmpdir(), "outbox-"))
  registry = openRegistry(join(dir, "registry.sqlite"))
  const store = createWorkOrderStore(registry.db)
  const at = "2026-10-01T00:00:00.000Z"
  store.insert({
    id: ID,
    revision: 0,
    state: "awaiting_approval",
    taskId: ID,
    workerRoute: "/build#agent",
    workerThreadId: null,
    interruptId: null,
    candidateDigest: null,
    bundleDigest: null,
    blockedReason: null,
    failureReason: null,
    candidateAttempts: 1,
    maxCandidateAttempts: 2,
    maxActiveMs: 1000,
    activeMs: 0,
    activeStartedAt: null,
    awaitingSince: at,
    origin: {
      kind: "issue",
      repository: "cacheplane/b4run",
      number: 912,
      bodyDigest: "0".repeat(64),
    },
    pin: "7".repeat(40),
    delivery: { kind: "local" },
    targetId: null,
    taskDigest: null,
    intakeAttempts: 0,
    maxIntakeAttempts: 2,
    createdAt: at,
    updatedAt: at,
  })
  store.recordApproval({
    id: "ap-1",
    workOrderId: ID,
    bundleDigest: "b".repeat(64),
    candidateDigest: "c".repeat(64),
    decision: "approved",
    decidedBy: "operator",
    decidedAt: at,
    expiresAt: at,
  })
  return createOutboxStore(registry.db)
}

describe("the delivery outbox", () => {
  it("holds one intent per work order, starting pending", () => {
    const outbox = open()
    outbox.insert({ operationKey: "deliver:1", approvalId: "ap-1", intent, now: "t0" })
    expect(outbox.get(ID)).toMatchObject({ step: "pending", remote: {}, attempts: 0, intent })
    expect(() =>
      outbox.insert({ operationKey: "deliver:2", approvalId: "ap-1", intent, now: "t1" }),
    ).toThrow(/UNIQUE/)
  })

  it("advances one step at a time, merging what each step observed", () => {
    const outbox = open()
    outbox.insert({ operationKey: "deliver:1", approvalId: "ap-1", intent, now: "t0" })
    outbox.advance(ID, "pending", "checked", { commit: { sha: "3".repeat(40) } }, "t1")
    const row = outbox.advance(
      ID,
      "checked",
      "committed",
      { branch: { headSha: "4".repeat(40) } },
      "t2",
    )
    expect(row.remote).toEqual({
      commit: { sha: "3".repeat(40) },
      branch: { headSha: "4".repeat(40) },
    })
    expect(() => outbox.advance(ID, "pending", "checked", {}, "t3")).toThrow(StaleOutboxStepError)
  })

  it("counts attempts with their error, and clears the error without counting", () => {
    const outbox = open()
    outbox.insert({ operationKey: "deliver:1", approvalId: "ap-1", intent, now: "t0" })
    outbox.note(ID, "HTTP 502", "t1")
    outbox.note(ID, "HTTP 502", "t2")
    expect(outbox.get(ID)).toMatchObject({ attempts: 2, lastError: "HTTP 502" })
    outbox.note(ID, null, "t3")
    expect(outbox.get(ID)).toMatchObject({ attempts: 2, lastError: null })
  })

  it("refuses an intent that does not parse", () => {
    const outbox = open()
    expect(() =>
      outbox.insert({
        operationKey: "deliver:1",
        approvalId: "ap-1",
        intent: { ...intent, branch: "main" } as DeliveryIntent,
        now: "t0",
      }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run test/outbox.test.ts`
Expected: FAIL, `outbox.ts` does not exist.

- [ ] **Step 3: The interface** (no update, force, delete, merge, ready, comment or close: the worker cannot ask for what the interface cannot say):

`examples/software-factory/controller/src/lib/delivery/adapter.ts`:

```ts
import type { GitTreeEntry } from "./git-objects.js"

/**
 * What the delivery worker asks of GitHub, and nothing more (rung 4 spec §5.2, §6.2). The
 * worker owns the sequence and every judgement (what is ours, what conflicts, what proves
 * delivery); an adapter only carries one request and classifies its failure. Rung 4's real
 * adapter is GitHub's REST and GraphQL APIs under an installation token (`github/adapter.ts`);
 * the tests use an in-memory repository (`test/fake-delivery-adapter.ts`).
 *
 * There is deliberately no update, force, delete, merge, ready, comment or close here: the
 * worker cannot ask for what the interface cannot say.
 */

/** Why a request failed, as the worker needs to know it (spec §6.5). */
export type DeliveryErrorKind =
  /** A 401, a non-rate-limit 403, a mint refusal, a missing installation: never heals by waiting. */
  | "unauthorized"
  /** A 429, or a 403 carrying `retry-after` or `x-ratelimit-remaining: 0`. */
  | "rate_limited"
  /** A 5xx or a network failure: retried with backoff. */
  | "transient"
  /** A 404 where the worker asked for something specific. */
  | "not_found"
  /** A 409 or 422 the request itself could not explain: answered by the step's own read. */
  | "conflict"
  /** Anything else: a response that does not parse, a status nothing expects. */
  | "unexpected"

export class DeliveryError extends Error {
  constructor(
    readonly kind: DeliveryErrorKind,
    message: string,
    /** How long the server asked the caller to wait, when it said. */
    readonly retryAfterMs?: number,
    readonly status?: number,
  ) {
    super(message)
    this.name = "DeliveryError"
  }
}

export interface RemoteCommit {
  readonly sha: string
  readonly tree: string
  readonly parents: readonly string[]
}

export interface Comparison {
  /** `ahead` or `identical` when the base is an ancestor of the head. */
  readonly status: "ahead" | "behind" | "diverged" | "identical"
  readonly aheadBy: number
  readonly files: readonly { readonly filename: string; readonly previousFilename?: string }[]
  /** False when the comparison could not list every changed file (GitHub caps it at 300). */
  readonly complete: boolean
}

export interface RemotePull {
  readonly number: number
  readonly url: string
  readonly nodeId: string
  readonly state: "open" | "closed"
  readonly draft: boolean
  readonly merged: boolean
  readonly author: string
  readonly headRef: string
  /** `owner/name` of the head's repository; null when it was deleted. */
  readonly headRepository: string | null
  readonly headSha: string
  readonly baseRef: string
}

export interface CommitIdentity {
  readonly name: string
  readonly email: string
  /** ISO-8601; the approval's time, so a repeated create usually yields the same commit. */
  readonly date: string
}

/** One worker run's authenticated view of one repository. */
export interface DeliverySession {
  /** The app's bot login (`<slug>[bot]`), as GitHub reports the app. */
  readonly botLogin: string
  /** The commit identity the worker writes as: the app's bot. */
  readonly identity: Omit<CommitIdentity, "date">
  /** Rule types (`update`, `non_fast_forward`, ...) the repository's rulesets apply to `branch`. */
  branchRules(branch: string): Promise<readonly string[]>
  issueState(number: number): Promise<"open" | "closed">
  /** The commit `refs/heads/<branch>` points at, or null when it does not exist. */
  branchHead(branch: string): Promise<string | null>
  compare(base: string, head: string): Promise<Comparison>
  commit(sha: string): Promise<RemoteCommit>
  /** One tree's own entries, non-recursive. */
  tree(sha: string): Promise<readonly GitTreeEntry[]>
  createBlob(text: string): Promise<string>
  createTree(
    baseTree: string,
    entries: readonly { readonly path: string; readonly mode: string; readonly sha: string }[],
  ): Promise<string>
  createCommit(input: {
    readonly message: string
    readonly tree: string
    readonly parents: readonly string[]
    readonly author: CommitIdentity
    readonly committer: CommitIdentity
  }): Promise<string>
  /** Create `refs/heads/<branch>` at `sha`; `exists` when the ref is already there (a 422). */
  createBranch(branch: string, sha: string): Promise<"created" | "exists">
  /** Open and closed pull requests whose head is `<owner>:<branch>`. */
  pullsByHead(branch: string): Promise<readonly RemotePull[]>
  /** A draft pull request; `exists` when GitHub says one already exists for the head (a 422). */
  createDraftPull(input: {
    readonly title: string
    readonly body: string
    readonly head: string
    readonly base: string
  }): Promise<RemotePull | "exists">
  pull(number: number): Promise<RemotePull>
  /** The issue numbers merging the pull request would close. */
  closingIssues(number: number): Promise<readonly number[]>
}

export interface DeliveryAdapter {
  /**
   * Authenticate for `repository` (a token minted for this run, downscoped to it) and check
   * the installation grants what delivery needs; `unauthorized` otherwise.
   */
  open(repository: string, signal: AbortSignal): Promise<DeliverySession>
  /** Secrets the adapter holds now, for the scrubber: never journalled. */
  secrets(): readonly string[]
}
```

- [ ] **Step 4: The outbox**

`examples/software-factory/controller/src/lib/delivery/outbox.ts`:

```ts
import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { canon } from "../domain/digest.js"
import {
  BRANCH_PATTERN,
  COMMIT_PATTERN,
  DIGEST_PATTERN,
  FACTORY_BRANCH,
  REPOSITORY_PATTERN,
} from "../domain/work-order.js"
import { OBJECT_ID } from "./git-objects.js"

/**
 * The delivery outbox (rung 4 spec §5.1): what an approval of a draft-PR bundle authorized,
 * committed in the approval's own transaction, and how far the worker has got. One row per
 * work order. The intent never changes after it is written; `step` and `remote` advance
 * together, one compare-and-swap per step.
 */

export const OUTBOX_STEPS = [
  "pending",
  "checked",
  "committed",
  "branched",
  "opened",
  "confirmed",
] as const
export type OutboxStep = (typeof OUTBOX_STEPS)[number]

const ObjectId = z.string().regex(OBJECT_ID)

/** Everything the worker needs, frozen at approval: it never re-reads a mutable source. */
export const DeliveryIntentSchema = z
  .object({
    version: z.literal(1),
    workOrderId: z.string().min(1),
    bundleDigest: z.string().regex(DIGEST_PATTERN),
    candidateDigest: z.string().regex(DIGEST_PATTERN),
    /** The artifact holding the approved bytes; re-hashed on every read. */
    candidateArtifact: z.string().regex(DIGEST_PATTERN),
    repository: z.string().regex(REPOSITORY_PATTERN),
    baseBranch: z.string().regex(BRANCH_PATTERN),
    branch: z.string().regex(FACTORY_BRANCH),
    pin: z.string().regex(COMMIT_PATTERN),
    pathPrefix: z.string().min(1),
    issue: z
      .object({
        number: z.number().int().positive(),
        stateAtCreate: z.enum(["open", "closed"]),
      })
      .strict(),
    /** One entry per changed path, sorted by `path`. */
    paths: z
      .array(
        z
          .object({
            /** The repository path. */
            path: z.string().min(1),
            /** The candidate's key: the path under the target's root. */
            workspacePath: z.string().min(1),
            /** `git hash-object` of the baseline bytes the candidate was diffed against. */
            baselineBlob: ObjectId,
            /** `git hash-object` of the approved bytes. */
            candidateBlob: ObjectId,
          })
          .strict(),
      )
      .min(1),
    title: z.string().min(1).max(220),
    /** The approved `spec.md`, read with the task digest it was checked against. */
    specText: z.string(),
    approvedAt: z.string().min(1),
    decidedBy: z.string().min(1),
    digests: z
      .object({
        task: z.string().regex(DIGEST_PATTERN),
        policy: z.string().regex(DIGEST_PATTERN),
        environment: z.string().min(1),
        oracleReceiptId: z.string().min(1).nullable(),
        receiptId: z.string().min(1),
        reverificationReceiptId: z.string().min(1),
      })
      .strict(),
  })
  .strict()
export type DeliveryIntent = z.infer<typeof DeliveryIntentSchema>

/** What each step observed, filled as the steps advance. */
export const DeliveryRemoteSchema = z
  .object({
    check: z
      .object({
        baseTip: ObjectId,
        aheadBy: z.number().int().nonnegative(),
        pinTree: ObjectId,
        expectedTree: ObjectId,
        /** The pin's mode at each changed repository path, which the change keeps. */
        modes: z.record(z.string(), z.enum(["100644", "100755"])),
      })
      .strict()
      .optional(),
    commit: z.object({ sha: ObjectId }).strict().optional(),
    branch: z.object({ headSha: ObjectId }).strict().optional(),
    pull: z
      .object({ number: z.number().int().positive(), url: z.string().url(), nodeId: z.string() })
      .strict()
      .optional(),
  })
  .strict()
export type DeliveryRemote = z.infer<typeof DeliveryRemoteSchema>

export interface OutboxRow {
  readonly operationKey: string
  readonly workOrderId: string
  readonly bundleDigest: string
  readonly approvalId: string
  readonly intent: DeliveryIntent
  readonly step: OutboxStep
  readonly remote: DeliveryRemote
  readonly attempts: number
  readonly lastError: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export class StaleOutboxStepError extends Error {
  constructor(
    readonly workOrderId: string,
    readonly expected: OutboxStep,
  ) {
    super(`Delivery outbox of ${workOrderId} is not at step ${expected}`)
    this.name = "StaleOutboxStepError"
  }
}

export interface OutboxStore {
  /** Inside the approval's transaction. A second insert for one work order throws. */
  insert(input: {
    readonly operationKey: string
    readonly approvalId: string
    readonly intent: DeliveryIntent
    readonly now: string
  }): void
  get(workOrderId: string): OutboxRow | null
  /** Compare-and-swap: from `from` to `to`, merging `remote`. Throws when not at `from`. */
  advance(
    workOrderId: string,
    from: OutboxStep,
    to: OutboxStep,
    remote: DeliveryRemote,
    now: string,
  ): OutboxRow
  /** Count an attempt and keep its (scrubbed) error, or clear it with null. */
  note(workOrderId: string, lastError: string | null, now: string): void
}

/** The default operation key of a work order's delivery (spec §5.1). */
export const deliveryOperationKey = (workOrderId: string, bundleDigest: string) =>
  `deliver:${workOrderId}:${bundleDigest}`

export function createOutboxStore(db: DatabaseSync): OutboxStore {
  const get = (workOrderId: string): OutboxRow | null => {
    const r = db
      .prepare("SELECT * FROM delivery_outbox WHERE work_order_id = ?")
      .get(workOrderId) as Record<string, string | number | null> | undefined
    if (!r) return null
    return {
      operationKey: String(r.operation_key),
      workOrderId: String(r.work_order_id),
      bundleDigest: String(r.bundle_digest),
      approvalId: String(r.approval_id),
      intent: DeliveryIntentSchema.parse(JSON.parse(String(r.intent))),
      step: z.enum(OUTBOX_STEPS).parse(r.step),
      remote: DeliveryRemoteSchema.parse(JSON.parse(String(r.remote))),
      attempts: Number(r.attempts),
      lastError: r.last_error === null ? null : String(r.last_error),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }
  }
  return {
    insert({ operationKey, approvalId, intent, now }) {
      const parsed = DeliveryIntentSchema.parse(intent)
      db.prepare(
        "INSERT INTO delivery_outbox (operation_key, work_order_id, bundle_digest, approval_id, intent, step, remote, attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', '{}', 0, NULL, ?, ?)",
      ).run(
        operationKey,
        parsed.workOrderId,
        parsed.bundleDigest,
        approvalId,
        canon(parsed),
        now,
        now,
      )
    },
    get,
    advance(workOrderId, from, to, remote, now) {
      const current = get(workOrderId)
      if (current === null || current.step !== from)
        throw new StaleOutboxStepError(workOrderId, from)
      const merged = DeliveryRemoteSchema.parse({ ...current.remote, ...remote })
      const result = db
        .prepare(
          "UPDATE delivery_outbox SET step = ?, remote = ?, updated_at = ? WHERE work_order_id = ? AND step = ?",
        )
        .run(to, canon(merged), now, workOrderId, from)
      if (result.changes !== 1) throw new StaleOutboxStepError(workOrderId, from)
      return get(workOrderId) as OutboxRow
    },
    note(workOrderId, lastError, now) {
      db.prepare(
        "UPDATE delivery_outbox SET attempts = attempts + ?, last_error = ?, updated_at = ? WHERE work_order_id = ?",
      ).run(lastError === null ? 0 : 1, lastError, now, workOrderId)
    },
  }
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/outbox.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write src/lib/delivery/outbox.ts src/lib/delivery/adapter.ts test/outbox.test.ts
git add src/lib/delivery/outbox.ts src/lib/delivery/adapter.ts test/outbox.test.ts
git commit -m "feat(software-factory): the delivery outbox and the adapter interface it is delivered through

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: The guard's paths, the scrubber, and the pull request's text

**Files:**
- Create: `src/lib/delivery/guard.ts`, `src/lib/delivery/scrub.ts`, `src/lib/delivery/pr-body.ts`
- Test: `test/delivery-text.test.ts`

- [ ] **Step 1: Write the failing test**

`examples/software-factory/controller/test/delivery-text.test.ts`:

``````ts
import { describe, expect, it } from "vitest"
import {
  DELIVERY_PROTECTED_PATHS,
  FACTORY_BOT_LOGIN,
  isProtectedPath,
  isRunFromBranchPath,
  protectedPathsIn,
  RUN_FROM_BRANCH_PATHS,
  repositoryPath,
} from "../src/lib/delivery/guard.ts"
import type { DeliveryIntent } from "../src/lib/delivery/outbox.ts"
import {
  BODY_LIMIT,
  commitMessage,
  fenceFor,
  pullBody,
  pullTitle,
} from "../src/lib/delivery/pr-body.ts"
import { scrub } from "../src/lib/delivery/scrub.ts"

const intent: DeliveryIntent = {
  version: 1,
  workOrderId: "wo-0123456789abcdef",
  bundleDigest: "b".repeat(64),
  candidateDigest: "c".repeat(64),
  candidateArtifact: "a".repeat(64),
  repository: "cacheplane/b4run",
  baseBranch: "main",
  branch: "factory/wo-0123456789abcdef",
  pin: "7".repeat(40),
  pathPrefix: ".",
  issue: { number: 912, stateAtCreate: "open" },
  paths: [
    {
      path: "packages/devkit/src/testing/process.ts",
      workspacePath: "packages/devkit/src/testing/process.ts",
      baselineBlob: "1".repeat(40),
      candidateBlob: "2".repeat(40),
    },
  ],
  title: "factory: spawnProcess leaks its deadline timer",
  specText: "# spawnProcess leaks\n\nA1: cleared.\n",
  approvedAt: "2026-10-01T12:00:00.000Z",
  decidedBy: "operator",
  digests: {
    task: "d".repeat(64),
    policy: "e".repeat(64),
    environment: "env",
    oracleReceiptId: "rc-oracle",
    receiptId: "rc-verify",
    reverificationReceiptId: "rc-reverify",
  },
}
const facts = { baseTip: "9".repeat(40), aheadBy: 4 }

describe("the delivery guard", () => {
  it("asks main not to have changed only the files the branch's own build runs", () => {
    expect(RUN_FROM_BRANCH_PATHS).toEqual([
      "apps/web/vercel.json",
      "apps/web/scripts/vercel-ignore-build.sh",
    ])
    for (const path of RUN_FROM_BRANCH_PATHS) expect(isProtectedPath(path)).toBe(true)
    expect(isRunFromBranchPath(".github/workflows/ci.yml")).toBe(false)
    expect(isRunFromBranchPath("apps/web/scripts/vercel-ignore-build.sh")).toBe(true)
  })

  it("names the bot the workflows skip and protects the files the guard lives in", () => {
    expect(FACTORY_BOT_LOGIN).toBe("b4-factory[bot]")
    expect(DELIVERY_PROTECTED_PATHS).toEqual([
      ".github/**",
      "apps/web/vercel.json",
      "apps/web/scripts/vercel-ignore-build.sh",
    ])
    for (const path of [
      ".github",
      ".github/workflows/ci.yml",
      ".github/CODEOWNERS",
      "apps/web/vercel.json",
    ])
      expect(isProtectedPath(path)).toBe(true)
    for (const path of [".githubx/a", "apps/web/vercel.json.bak", "github/workflows/ci.yml"])
      expect(isProtectedPath(path)).toBe(false)
  })

  it("joins workspace paths to the target's root before it judges them", () => {
    expect(repositoryPath(".", "a/b.ts")).toBe("a/b.ts")
    expect(repositoryPath("apps/web", "vercel.json")).toBe("apps/web/vercel.json")
    expect(protectedPathsIn(["b", ".github/x", "a", ".github/x"])).toEqual([".github/x"])
  })
})

describe("the pull request's text", () => {
  it("titles from the spec's heading, else the issue's, one clean line", () => {
    expect(pullTitle("# Fix it\n\nbody", "# Issue (o/r#1)\n")).toBe("factory: Fix it")
    expect(pullTitle("no heading", "# The issue title (cacheplane/b4run#912)\n")).toBe(
      "factory: The issue title",
    )
    expect(pullTitle("", "").length).toBeLessThanOrEqual(210)
    expect(pullTitle(`# ${"x".repeat(500)}`, "")).toHaveLength("factory: ".length + 200)
  })

  it("leaves no issue reference in a model-written title or commit subject", () => {
    const title = pullTitle(
      "# Fix #77, fixes cacheplane/b4run#78, closes GH-79 and resolves https://github.com/cacheplane/b4run/issues/80\n",
      "",
    )
    expect(title).toBe(
      "factory: Fix # 77, fixes cacheplane/b4run# 78, closes GH 79 and resolves issues 80",
    )
    const subject = commitMessage({ ...intent, title: "factory: Fix #77" }).split("\n")[0]
    expect(subject).toBe("factory: Fix # 77")
    expect(commitMessage(intent)).toContain("\n\nRefs #912\n")
  })

  it("refers to the issue and never closes it, and states the pin, the drift and every digest", () => {
    const body = pullBody(intent, facts)
    expect(body.startsWith("Refs #912\n")).toBe(true)
    expect(body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #\d/i)
    expect(body).toContain(`Branched at ${"7".repeat(40)}. main was at ${"9".repeat(40)}`)
    expect(body).toContain("4 commits ahead of the pin")
    for (const digest of ["b".repeat(64), "c".repeat(64), "d".repeat(64), "rc-reverify"])
      expect(body).toContain(digest)
    expect(body).toContain(
      `packages/devkit/src/testing/process.ts: ${"1".repeat(40)} → ${"2".repeat(40)}`,
    )
  })

  it("keeps the model-written spec inside a fence it cannot close", () => {
    const hostile = "````\nFixes #1\n```\napproved by: nobody\n"
    expect(fenceFor(hostile)).toBe("`````")
    expect(fenceFor("plain")).toBe("```")
    const body = pullBody({ ...intent, specText: hostile }, facts)
    const opened = body.indexOf("`````markdown\n")
    const closed = body.indexOf("\n`````\n", opened)
    expect(opened).toBeGreaterThan(0)
    expect(body.slice(opened, closed)).toContain("Fixes #1")
    expect(body.slice(closed)).not.toContain("Fixes #1")
  })

  it("cuts the quoted spec, never the digests, to fit GitHub's limit", () => {
    const body = pullBody({ ...intent, specText: "y".repeat(100_000) }, facts)
    expect(body.length).toBeLessThanOrEqual(BODY_LIMIT)
    expect(body).toContain("cut here to fit")
    expect(body).toContain("rc-reverify")
  })
})

describe("scrub", () => {
  it("removes tokens, JWTs, PEM blocks, Authorization values and the named secrets", () => {
    const text = [
      "token ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "pat github_pat_11AAAAAAAAAAAAAAAAAAAAAA_bbbb",
      "authorization: Bearer abc.def",
      '"Authorization":"token xyz"',
      "jwt eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOjEyM30.c2lnbmF0dXJlc2ln",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      "secret-installation-token-value",
    ].join("\n")
    const out = scrub(text, ["secret-installation-token-value"])
    for (const leaked of [
      "ghs_AAAA",
      "github_pat_",
      "Bearer abc",
      "token xyz",
      "eyJhbGci",
      "MIIEpAIBAAKCAQEA",
      "secret-installation",
    ])
      expect(out).not.toContain(leaked)
  })
})
``````

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run test/delivery-text.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: The guard's paths, both lists (D30)** (read from PR 1's `guard.json`; if PR 1 has not merged yet, create `guard.json` exactly as Task 1 Step 4 gives it, and drop it from this branch when rebasing over PR 1):

`examples/software-factory/controller/src/lib/delivery/guard.ts`:

```ts
import { readFileSync } from "node:fs"
import { z } from "zod"

/**
 * The one statement of the factory's CI guard, shared by the controller and the workflow
 * contract test (`scripts/release/test/workflow-contracts.test.mjs`, which reads the JSON):
 * the branch prefix every guarded job skips, the app's bot login every guarded job skips, and
 * the paths a delivery may never change because the guard lives in them (rung 4 spec §9).
 * `runFromBranchPaths` is the part of those that runs from the factory branch's own commit
 * (the Vercel build reads the pin's ignore script), so `main` must not have changed them
 * since the pin either: a pin older than the guard carries the unguarded script. The
 * workflows are not in it: a pull request runs `main`'s workflows at the merge commit, so
 * `main` changing `.github/**` since the pin is harmless (it changes about forty times a
 * month) and must not block delivery.
 * Read from disk, not imported: the contract test is plain Node and reads the same file.
 */
const guard = z
  .object({
    branchPrefix: z.literal("factory/"),
    botLogin: z.string().regex(/^[a-z0-9][a-z0-9-]*\[bot\]$/),
    protectedPaths: z.array(z.string().min(1)).min(1),
    runFromBranchPaths: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .parse(JSON.parse(readFileSync(new URL("./guard.json", import.meta.url), "utf8")))

export const FACTORY_BRANCH_PREFIX: string = guard.branchPrefix
export const FACTORY_BOT_LOGIN: string = guard.botLogin
export const DELIVERY_PROTECTED_PATHS: readonly string[] = Object.freeze([...guard.protectedPaths])
export const RUN_FROM_BRANCH_PATHS: readonly string[] = Object.freeze([...guard.runFromBranchPaths])

/** A workspace path as the repository names it: under the target's root. */
export function repositoryPath(pathPrefix: string, path: string): string {
  return pathPrefix === "." ? path : `${pathPrefix}/${path}`
}

const matches = (entries: readonly string[], path: string) =>
  entries.some((entry) =>
    entry.endsWith("/**")
      ? path === entry.slice(0, -3) || path.startsWith(entry.slice(0, -2))
      : path === entry,
  )

/** Is `path` (a repository path) one a delivery may never change, or under one? */
export function isProtectedPath(path: string): boolean {
  return matches(DELIVERY_PROTECTED_PATHS, path)
}

/** Is `path` one the branch's own commit runs, which `main` must not have changed since the pin? */
export function isRunFromBranchPath(path: string): boolean {
  return matches(RUN_FROM_BRANCH_PATHS, path)
}

/** The repository paths among `paths` a delivery may never change, sorted. */
export function protectedPathsIn(paths: Iterable<string>): string[] {
  return [...new Set([...paths].filter(isProtectedPath))].sort()
}
```

- [ ] **Step 4: The scrubber**

`examples/software-factory/controller/src/lib/delivery/scrub.ts`:

```ts
/**
 * Everything the delivery path journals, returns or keeps in `last_error` passes through
 * here (rung 4 spec §8.3): the journal is persistent and `factory events` prints it, so it
 * is where a leaked credential would last. Removes the secrets the caller names (the current
 * installation token), any GitHub token shape, any PEM block, any `Authorization` header and
 * any JWT, whatever else the text says.
 */
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g
const PEM = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g
const AUTHORIZATION = /\b(authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+(?:\s+[^\s"',}]+)?/gi
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of [...secrets]
    .filter((s) => s.length >= 8)
    .sort((a, b) => b.length - a.length))
    out = out.split(secret).join("[REDACTED]")
  return out
    .replace(PEM, "[REDACTED PEM]")
    .replace(GITHUB_TOKEN, "[REDACTED TOKEN]")
    .replace(JWT, "[REDACTED JWT]")
    .replace(AUTHORIZATION, "$1$2[REDACTED]")
}
```

- [ ] **Step 5: The title, the body and the commit message** (Trap 13 for the heading; D29 for the references):

`examples/software-factory/controller/src/lib/delivery/pr-body.ts`:

```ts
import type { DeliveryIntent } from "./outbox.js"

/** GitHub's limit on a pull request body, in characters. */
export const BODY_LIMIT = 65_536
const TITLE_LIMIT = 200

/**
 * Model-influenced text made safe to show in one line: control characters and line and
 * paragraph separators removed, whitespace collapsed.
 */
function oneLine(text: string): string {
  return text
    .replace(/[\p{Cc}\u2028\u2029]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Model-written text made unable to reference an issue (D29): a squash merge takes the PR's
 * title as its commit subject, and GitHub closes `#77` (or `owner/repo#77`, `GH-77`, or an
 * issue or pull request URL) after a closing keyword (`close[sd]?`, `fix(e[sd])?`,
 * `resolve[sd]?`) in a commit landing on the default branch. Every reference is broken, so
 * no keyword before it can close anything; the words themselves ("Fix the timer") stay.
 */
export function neutraliseReferences(text: string): string {
  return text
    .replace(/(?:https?:\/\/)?github\.com\/[^\s/]+\/[^\s/]+\/(issues|pull)\/(\d+)/gi, "$1 $2")
    .replace(/\bGH-(\d)/gi, "GH $1")
    .replace(/#(?=\d)/g, "# ")
}

/**
 * The pull request's title (spec §7.1): the approved spec's first `# ` heading, else the
 * issue's title from `issue.md` (`# <title> (<repo>#<n>)`), cleaned, cut to 200 characters,
 * prefixed `factory: `. Display only: GitHub links no issue from a title.
 */
export function pullTitle(specText: string, issueText: string): string {
  // Split on \n only: a regex `$` (and `.`) also stops at U+2028, which would cut a heading short.
  const heading = (text: string) =>
    text
      .split("\n")
      .find((line) => /^# +\S/.test(line))
      ?.replace(/^# +/, "")
  const fromIssue = heading(issueText)?.replace(/ \([^()]*#\d+\)$/, "")
  const title = oneLine(heading(specText) ?? fromIssue ?? "")
  const safe = neutraliseReferences(title)
  return `factory: ${(safe === "" ? "an approved change" : safe).slice(0, TITLE_LIMIT)}`
}

/** A fence `text` cannot close: one more backtick than its longest run, and at least three. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  return "`".repeat(Math.max(3, longest + 1))
}

export interface BodyFacts {
  readonly baseTip: string
  readonly aheadBy: number
}

/**
 * The pull request's body (spec §7.2), rendered only from frozen data: the intent the
 * approval committed and what step (a) read. `Refs #N`, never a closing keyword, so merging
 * never closes the issue on the factory's say-so. The approved spec is model-written and
 * sits inside a fence it cannot close; when the body would pass GitHub's limit the quoted
 * spec is cut, never the digests, which are the authority.
 */
export function pullBody(intent: DeliveryIntent, facts: BodyFacts): string {
  const head = [
    `Refs #${intent.issue.number}`,
    "",
    `Produced by the B4.run software factory from issue #${intent.issue.number} and approved by a person`,
    `(recorded actor: ${oneLine(intent.decidedBy)}) on ${intent.approvedAt}. This is a draft. The factory never merges.`,
    ...(intent.issue.stateAtCreate === "closed"
      ? ["", `Issue #${intent.issue.number} was already closed when this work order was created.`]
      : []),
    "",
    "## Pin and drift",
    `Branched at ${intent.pin}. main was at ${facts.baseTip} when delivered, ${facts.aheadBy} commits ahead of the pin.`,
    "No file this change touches changed on main in between.",
    "",
    "## Approved task",
  ].join("\n")
  const d = intent.digests
  const tail = [
    "",
    "## Digests and receipts",
    `task ${d.task} · bundle ${intent.bundleDigest} · candidate ${intent.candidateDigest}`,
    `oracle receipt ${d.oracleReceiptId ?? "none"} · verification receipt ${d.receiptId} · re-verification at approval ${d.reverificationReceiptId}`,
    `policy ${d.policy} · environment ${oneLine(d.environment)}`,
    "",
    ...intent.paths.map(
      // Step (a) proved the pin's blob at each path is the baseline's, so "before" is it.
      (p) => `${p.path}: ${p.baselineBlob} → ${p.candidateBlob}`,
    ),
    "",
  ].join("\n")
  const quote = (spec: string) => {
    const fence = fenceFor(spec)
    return `${fence}markdown\n${spec.endsWith("\n") ? spec : `${spec}\n`}${fence}`
  }
  const whole = `${head}\n${quote(intent.specText)}\n${tail}`
  if (whole.length <= BODY_LIMIT) return whole
  const note =
    "\n(The approved spec is cut here to fit GitHub's body limit; its digest above is the authority.)"
  const room = BODY_LIMIT - head.length - tail.length - note.length - 64
  const cut = intent.specText.slice(0, Math.max(0, room))
  return `${head}\n${quote(cut)}${note}\n${tail}`
}

/** The commit message: from the intent alone, so a repeated create writes the same commit. */
export function commitMessage(intent: DeliveryIntent): string {
  return `${neutraliseReferences(intent.title)}\n\nRefs #${intent.issue.number}\n\nWork order ${intent.workOrderId}, bundle ${intent.bundleDigest}.\n`
}
```

- [ ] **Step 6: Run it to see it pass**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/delivery-text.test.ts`
Expected: 9 passed.

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write src/lib/delivery/guard.ts src/lib/delivery/scrub.ts src/lib/delivery/pr-body.ts test/delivery-text.test.ts
git add src/lib/delivery/guard.ts src/lib/delivery/scrub.ts src/lib/delivery/pr-body.ts test/delivery-text.test.ts
git commit -m "feat(software-factory): the delivery-protected paths, the scrubber, and the draft PR's text

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed (Task 10, with the review fixes of 2026-10-01).** Beyond the code above: the changed-path lines are fenced too (`fenceFor`), and `scrub()` runs over the model-written title, the quoted spec (before the length cut) and the commit message. After review: `neutraliseReferences` also runs over the quoted spec and the changed-path lines (the fence stays; the digest remains the authority), so a renderer that reads a fence differently still finds no reference to close; the plan's test that required the raw `Fixes #1` inside the fence now requires `Fixes # 1`. The length cut subtracts both fences and the info string (a spec of 70,000 backticks rendered a 194k-character body before) and never splits a surrogate pair, and neither does the title's 200-character cut (`cutAt`). `oneLine` drops `\p{Cf}` (bidi controls, zero-width spaces and joiners) before it collapses whitespace, so `#\u200B12` cannot hide a reference from `neutraliseReferences`.

### Task 11: The delivery worker, against an in-memory GitHub with fault injection

**Files:**
- Create: `src/lib/delivery/worker.ts`
- Create: `test/fake-delivery-adapter.ts`, `test/delivery-harness.ts`
- Test: `test/delivery-worker.test.ts`

- [ ] **Step 1: The in-memory GitHub** (real git object ids; refs created once, never moved; a fault either fails a call or performs it and loses the answer):

`examples/software-factory/controller/test/fake-delivery-adapter.ts`:

```ts
import { createHash } from "node:crypto"
import {
  type Comparison,
  type DeliveryAdapter,
  DeliveryError,
  type DeliverySession,
  type RemoteCommit,
  type RemotePull,
} from "../src/lib/delivery/adapter.ts"
import { blobId, type GitTreeEntry, treeId } from "../src/lib/delivery/git-objects.ts"

/**
 * An in-memory GitHub repository behind the `DeliveryAdapter` interface: real git object ids
 * (so the worker's local hashes are checked against something that computes them the same
 * way), refs that are created once and never moved, pull requests found by head, and a fault
 * script per method. A fault either fails a call before it does anything, or does it and then
 * loses the response, which is the case the outbox exists for.
 */

export type FakeMethod = Exclude<keyof DeliverySession, "botLogin" | "identity"> | "open"

interface Fault {
  readonly method: FakeMethod
  readonly error: DeliveryError
  /** Perform the call, then throw: the write landed and its answer was lost. */
  readonly after: boolean
  remaining: number
}

export const BOT = "b4-factory[bot]"
export const REPOSITORY = "cacheplane/b4run"

export interface FakeGitHub extends DeliveryAdapter {
  readonly calls: FakeMethod[]
  readonly refs: Map<string, string>
  readonly pulls: RemotePull[]
  readonly issues: Map<number, "open" | "closed">
  readonly commits: Map<string, RemoteCommit>
  readonly rules: Map<string, readonly string[]>
  comparison: Comparison
  closing: readonly number[]
  /** Who `pull` reports as the author; the bot unless a test says otherwise. */
  author: string
  /** Store each blob under this id instead of its own: GitHub disagreeing with the bytes. */
  corruptBlob: string | undefined
  /** Called before each call, with its method: a test aborts or throws mid-request here. */
  onCall: ((method: FakeMethod) => void) | undefined
  /** Fail or lose the next `times` calls of `method`. */
  fail(
    method: FakeMethod,
    error: DeliveryError,
    options?: { after?: boolean; times?: number },
  ): void
  /**
   * Seed `main` with one commit holding `files`; its id is `pin` when given (a test that
   * drives a real work order names the pin the row was created at).
   */
  seed(
    files: Readonly<Record<string, string>>,
    pin?: string,
  ): { readonly pin: string; readonly tree: string }
  /** Advance `main` by one commit changing `files` (repository paths). */
  advanceMain(files: Readonly<Record<string, string>>): string
  /** The files at a commit, flattened, for assertions. */
  filesAt(commit: string): Record<string, string>
  writes(): FakeMethod[]
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex")
const WRITES: ReadonlySet<FakeMethod> = new Set<FakeMethod>([
  "createBlob",
  "createTree",
  "createCommit",
  "createBranch",
  "createDraftPull",
])

export function createFakeGitHub(): FakeGitHub {
  const blobs = new Map<string, string>()
  const trees = new Map<string, GitTreeEntry[]>()
  const commits = new Map<string, RemoteCommit>()
  const refs = new Map<string, string>()
  const pulls: RemotePull[] = []
  const issues = new Map<number, "open" | "closed">()
  const rules = new Map<string, readonly string[]>([
    ["main", ["update", "deletion"]],
    ["factory/*", ["update", "non_fast_forward"]],
  ])
  const faults: Fault[] = []
  const calls: FakeMethod[] = []

  /** Store `files` (path → text) as nested trees; returns the root tree id. */
  function build(files: ReadonlyMap<string, { mode: string; sha: string }>): string {
    const children = new Map<string, Map<string, { mode: string; sha: string }>>()
    const own: GitTreeEntry[] = []
    for (const [path, entry] of files) {
      const slash = path.indexOf("/")
      if (slash === -1) own.push({ name: path, mode: entry.mode, type: "blob", sha: entry.sha })
      else {
        const dir = path.slice(0, slash)
        const inner = children.get(dir) ?? new Map()
        inner.set(path.slice(slash + 1), entry)
        children.set(dir, inner)
      }
    }
    for (const [dir, inner] of children)
      own.push({ name: dir, mode: "040000", type: "tree", sha: build(inner) })
    const sha = treeId(own)
    trees.set(sha, own)
    return sha
  }
  function flatten(tree: string, prefix = ""): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>()
    for (const entry of trees.get(tree) ?? []) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      if (entry.type === "tree") for (const [p, e] of flatten(entry.sha, path)) out.set(p, e)
      else out.set(path, { mode: entry.mode, sha: entry.sha })
    }
    return out
  }
  function putCommit(tree: string, parents: readonly string[], message: string): string {
    const sha = sha1(JSON.stringify({ tree, parents, message }))
    commits.set(sha, { sha, tree, parents: [...parents] })
    return sha
  }

  const fake: FakeGitHub = {
    calls,
    refs,
    pulls,
    issues,
    commits,
    rules,
    comparison: { status: "ahead", aheadBy: 3, files: [{ filename: "README.md" }], complete: true },
    closing: [],
    author: BOT,
    corruptBlob: undefined,
    onCall: undefined,
    fail(method, error, { after = false, times = 1 } = {}) {
      faults.push({ method, error, after, remaining: times })
    },
    seed(files, pinId) {
      const blobsOf = new Map(
        Object.entries(files).map(([path, text]) => {
          const sha = blobId(text)
          blobs.set(sha, text)
          return [path, { mode: "100644", sha }] as const
        }),
      )
      const tree = build(blobsOf)
      const pin = pinId ?? putCommit(tree, [], "pin")
      commits.set(pin, { sha: pin, tree, parents: [] })
      refs.set("main", pin)
      return { pin, tree }
    },
    advanceMain(files) {
      const head = refs.get("main") as string
      const flat = flatten((commits.get(head) as RemoteCommit).tree)
      for (const [path, text] of Object.entries(files)) {
        blobs.set(blobId(text), text)
        flat.set(path, { mode: flat.get(path)?.mode ?? "100644", sha: blobId(text) })
      }
      const next = putCommit(build(flat), [head], "main moves")
      refs.set("main", next)
      return next
    },
    filesAt(commit) {
      const flat = flatten((commits.get(commit) as RemoteCommit).tree)
      return Object.fromEntries([...flat].map(([path, e]) => [path, blobs.get(e.sha) ?? "?"]))
    },
    writes: () => calls.filter((c) => WRITES.has(c)),
    secrets: () => ["ghs_faketokenfaketokenfaketoken0001"],
    async open() {
      return run("open", () => session)
    },
  }

  /** Apply the fault script around one call. */
  async function run<T>(method: FakeMethod, perform: () => T): Promise<T> {
    calls.push(method)
    fake.onCall?.(method)
    const fault = faults.find((f) => f.method === method && f.remaining > 0)
    if (fault !== undefined) {
      fault.remaining -= 1
      if (fault.after) perform()
      throw fault.error
    }
    return perform()
  }
  const notFound = (what: string) =>
    new DeliveryError("not_found", `${what} not found`, undefined, 404)

  const session: DeliverySession = {
    botLogin: BOT,
    identity: { name: BOT, email: `123+${BOT}@users.noreply.github.com` },
    branchRules: (branch) =>
      run(
        "branchRules",
        () => rules.get(branch.startsWith("factory/") ? "factory/*" : branch) ?? [],
      ),
    issueState: (number) => run("issueState", () => issues.get(number) ?? "open"),
    branchHead: (branch) => run("branchHead", () => refs.get(branch) ?? null),
    compare: () => run("compare", () => fake.comparison),
    commit: (sha) =>
      run("commit", () => {
        const found = commits.get(sha)
        if (!found) throw notFound(`commit ${sha}`)
        return found
      }),
    tree: (sha) =>
      run("tree", () => {
        const found = trees.get(sha)
        if (!found) throw notFound(`tree ${sha}`)
        return found
      }),
    createBlob: (text) =>
      run("createBlob", () => {
        const sha = fake.corruptBlob ?? blobId(text)
        blobs.set(sha, text)
        return sha
      }),
    createTree: (baseTree, entries) =>
      run("createTree", () => {
        const flat = flatten(baseTree)
        for (const entry of entries) flat.set(entry.path, { mode: entry.mode, sha: entry.sha })
        return build(flat)
      }),
    createCommit: (input) =>
      run("createCommit", () =>
        putCommit(input.tree, input.parents, `${input.message}${input.author.date}`),
      ),
    createBranch: (branch, sha) =>
      run("createBranch", () => {
        if (refs.has(branch)) return "exists" as const
        if (!commits.has(sha))
          throw new DeliveryError("conflict", "Object does not exist", undefined, 422)
        refs.set(branch, sha)
        return "created" as const
      }),
    pullsByHead: (branch) => run("pullsByHead", () => pulls.filter((p) => p.headRef === branch)),
    createDraftPull: (input) =>
      run("createDraftPull", () => {
        if (pulls.some((p) => p.headRef === input.head && p.state === "open"))
          return "exists" as const
        const head = refs.get(input.head)
        if (head === undefined)
          throw new DeliveryError("conflict", "head does not exist", undefined, 422)
        const number = 1000 + pulls.length
        const pull: RemotePull = {
          number,
          url: `https://github.com/${REPOSITORY}/pull/${number}`,
          nodeId: `PR_${number}`,
          state: "open",
          draft: true,
          merged: false,
          author: fake.author,
          headRef: input.head,
          headRepository: REPOSITORY,
          headSha: head,
          baseRef: input.base,
        }
        pulls.push(pull)
        return pull
      }),
    pull: (number) =>
      run("pull", () => {
        const found = pulls.find((p) => p.number === number)
        if (!found) throw notFound(`pull ${number}`)
        return { ...found, author: fake.author }
      }),
    closingIssues: () => run("closingIssues", () => fake.closing),
  }
  return fake
}
```

- [ ] **Step 2: The harness** (a work order parked in `delivering` with its intent committed, over a real registry; the worker run as approve or a reconcile would run it). Its `remote` and `specText` options serve Task 21's scratch lane:

`examples/software-factory/controller/test/delivery-harness.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DeliveryAdapter } from "../src/lib/delivery/adapter.ts"
import { DeliveryError } from "../src/lib/delivery/adapter.ts"
import { blobId } from "../src/lib/delivery/git-objects.ts"
import {
  createOutboxStore,
  type DeliveryIntent,
  deliveryOperationKey,
  type OutboxStore,
} from "../src/lib/delivery/outbox.ts"
import {
  DEFAULT_DELIVERY_LIMITS,
  type DeliveryContext,
  type DeliveryLimits,
  runDelivery,
} from "../src/lib/delivery/worker.ts"
import { nextState } from "../src/lib/domain/states.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { openRegistry, type Registry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore, type WorkOrderStore } from "../src/lib/registry/work-orders.ts"
import { type ArtifactStore, createArtifactStore } from "../src/lib/storage/artifacts.ts"
import { createFakeGitHub, type FakeGitHub, REPOSITORY } from "./fake-delivery-adapter.ts"

/**
 * One draft-PR work order parked in `delivering` with its outbox intent committed, over a real
 * registry, and the delivery worker run against it as approve or a reconcile would run it. The
 * remote is the in-memory repository, reached through the in-memory adapter by default, or
 * through any adapter a test passes (the real one, over the fake GitHub server).
 */

export const ID = "wo-0123456789abcdef"
export const BRANCH = `factory/${ID}`
export const SOURCE = "packages/devkit/src/testing/process.ts"
export const BASELINE = "export const deadline = 'leaks'\n"
export const REPAIRED = "export const deadline = 'cleared'\n"
export const TOKEN = "ghs_faketokenfaketokenfaketoken0001"

let dir: string | undefined
let registry: Registry | undefined
/** Close the registry and remove the directory of the last harness; call in afterEach. */
export function closeHarness(): void {
  registry?.close()
  registry = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
}

export interface Harness {
  readonly github: FakeGitHub
  readonly store: WorkOrderStore
  readonly outbox: OutboxStore
  readonly waits: number[]
  readonly pin: string
  /** Run the worker once, as approve or a reconcile would, with a fresh signal. */
  deliver(options?: {
    readonly limits?: Partial<DeliveryLimits>
    readonly onEvent?: (type: string, abort: () => void) => void
    /** Before each GitHub call: a test aborts the run, or throws, in the middle of a request. */
    readonly onCall?: (method: string, abort: () => void) => void
  }): Promise<WorkOrderRow>
  events(): string[]
  journal(): string
}

export async function harness(
  options: {
    readonly stateAtCreate?: "open" | "closed"
    readonly pinFiles?: Record<string, string>
    /** The repository to seed; a fresh in-memory one by default. */
    readonly github?: FakeGitHub
    /** How the worker reaches it; the in-memory repository itself by default. */
    readonly adapter?: DeliveryAdapter
    /**
     * A real repository instead (the scratch lane): nothing is seeded, and the work order is
     * `id` at `pin` on `repository`, whose pin must hold SOURCE as BASELINE.
     */
    readonly remote?: { readonly repository: string; readonly pin: string; readonly id: string }
    /** The approved spec the pull request quotes. */
    readonly specText?: string
    /** The one changed path (repository and workspace path, as the root is "."). */
    readonly source?: string
  } = {},
): Promise<Harness> {
  const id = options.remote?.id ?? ID
  const repository = options.remote?.repository ?? REPOSITORY
  const branch = `factory/${id}`
  dir = mkdtempSync(join(tmpdir(), "delivery-worker-"))
  registry = openRegistry(join(dir, "registry.sqlite"))
  const store = createWorkOrderStore(registry.db)
  const outbox = createOutboxStore(registry.db)
  const artifacts: ArtifactStore = createArtifactStore(join(dir, "artifacts"))
  const github = options.github ?? createFakeGitHub()
  const pin =
    options.remote?.pin ??
    github.seed(
      options.pinFiles ?? {
        "README.md": "# b4\n",
        [options.source ?? SOURCE]: BASELINE,
        "packages/devkit/src/testing.ts": "export * from './testing/process.js'\n",
        ".github/workflows/ci.yml": "name: CI\n",
      },
    ).pin
  const source = options.source ?? SOURCE
  const artifact = await artifacts.put(JSON.stringify({ [source]: REPAIRED }, null, 2))
  const at = "2026-10-01T12:00:00.000Z"
  store.insert({
    id: id,
    revision: 0,
    state: "delivering",
    taskId: id,
    workerRoute: "/build#agent",
    workerThreadId: null,
    interruptId: null,
    candidateDigest: "c".repeat(64),
    bundleDigest: "b".repeat(64),
    blockedReason: null,
    failureReason: null,
    candidateAttempts: 1,
    maxCandidateAttempts: 2,
    maxActiveMs: 1_200_000,
    activeMs: 0,
    activeStartedAt: null,
    awaitingSince: at,
    origin: { kind: "issue", repository: repository, number: 912, bodyDigest: "0".repeat(64) },
    pin,
    delivery: {
      kind: "draft-pr",
      repository: repository,
      baseBranch: "main",
      branch,
      pathPrefix: ".",
      issueStateAtCreate: options.stateAtCreate ?? "open",
    },
    targetId: "devkit",
    taskDigest: "d".repeat(64),
    intakeAttempts: 1,
    maxIntakeAttempts: 2,
    createdAt: at,
    updatedAt: at,
  })
  store.recordApproval({
    id: "ap-1",
    workOrderId: id,
    bundleDigest: "b".repeat(64),
    candidateDigest: "c".repeat(64),
    decision: "approved",
    decidedBy: "operator",
    decidedAt: at,
    expiresAt: at,
  })
  const intent: DeliveryIntent = {
    version: 1,
    workOrderId: id,
    bundleDigest: "b".repeat(64),
    candidateDigest: "c".repeat(64),
    candidateArtifact: artifact.digest,
    repository: repository,
    baseBranch: "main",
    branch,
    pin,
    pathPrefix: ".",
    issue: { number: 912, stateAtCreate: options.stateAtCreate ?? "open" },
    paths: [
      {
        path: source,
        workspacePath: source,
        baselineBlob: blobId(BASELINE),
        candidateBlob: blobId(REPAIRED),
      },
    ],
    title: "factory: spawnProcess leaks its deadline timer",
    specText:
      options.specText ?? "# spawnProcess leaks its deadline timer\n\nA1: the timer is cleared.\n",
    approvedAt: at,
    decidedBy: "operator",
    digests: {
      task: "d".repeat(64),
      policy: "e".repeat(64),
      environment: `docker:sha256:${"1".repeat(64)}`,
      oracleReceiptId: "rc-oracle",
      receiptId: "rc-verify",
      reverificationReceiptId: "rc-reverify",
    },
  }
  outbox.insert({
    operationKey: deliveryOperationKey(id, "b".repeat(64)),
    approvalId: "ap-1",
    intent,
    now: at,
  })
  const waits: number[] = []
  const iso = () => new Date().toISOString()
  const deliver: Harness["deliver"] = async (run = {}) => {
    const abort = new AbortController()
    const recordEvent = (id: string, type: string, payload: Record<string, unknown> = {}) => {
      store.appendEvent(id, type, payload, iso())
      run.onEvent?.(type, () => abort.abort())
    }
    github.onCall =
      run.onCall === undefined ? undefined : (method) => run.onCall?.(method, () => abort.abort())
    const ctx: DeliveryContext = {
      store,
      outbox,
      artifacts,
      signal: abort.signal,
      iso,
      mustGet: (id) => store.get(id) as WorkOrderRow,
      recordEvent,
      transition: (id, event, patch = {}, payload = {}) =>
        store.transaction(() => {
          const row = store.get(id) as WorkOrderRow
          const to = nextState(row.state, event)
          const updated = store.update(id, row.revision, { ...patch, state: to }, iso())
          recordEvent(id, "transition", { event, from: row.state, to, ...payload })
          return updated
        }),
    }
    let clock = 0
    await runDelivery(
      ctx,
      {
        adapter: options.adapter ?? github,
        limits: { ...DEFAULT_DELIVERY_LIMITS, ...run.limits },
        sleep: async (ms) => {
          waits.push(ms)
          clock += ms
        },
        clock: () => clock,
      },
      id,
    )
    return store.get(id) as WorkOrderRow
  }
  return {
    github,
    store,
    outbox,
    waits,
    pin,
    deliver,
    events: () => store.events(id).map((e) => e.type),
    journal: () => JSON.stringify(store.events(id)),
  }
}

export const transient = (status = 502) =>
  new DeliveryError("transient", `HTTP ${status}`, undefined, status)
```

- [ ] **Step 3: Write the failing tests** (spec §14's unit list, plus the review's: a `.github` change on `main` since the pin still delivers (D30), a protected path in the change itself refuses at step (a) before any request (I8), and a controller closing mid-request leaves the row `delivering` and the next run delivers (D26); the rest: a clean delivery, a lost response after each write, a stop at each step boundary, 422s, closed PR, 401/403/429/5xx within and past the bound, the run bound, every base-drift refusal, a baseline mismatch, GitHub disagreeing with a hash, a closing keyword, another author, the issue-closed policy, cancel between steps, and no secret in the journal):

`examples/software-factory/controller/test/delivery-worker.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest"
import { DeliveryError } from "../src/lib/delivery/adapter.ts"
import { blobId } from "../src/lib/delivery/git-objects.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import {
  BASELINE,
  BRANCH,
  closeHarness,
  harness,
  ID,
  REPAIRED,
  SOURCE,
  TOKEN,
  transient,
} from "./delivery-harness.ts"
import { BOT } from "./fake-delivery-adapter.ts"

afterEach(closeHarness)

describe("the delivery worker", () => {
  it("publishes exactly the approved bytes as one draft pull request, then reads it back", async () => {
    const h = await harness()
    const row = await h.deliver()
    expect(row).toMatchObject({ state: "delivered", blockedReason: null })
    const head = h.github.refs.get(BRANCH) as string
    expect(h.github.commits.get(head)?.parents).toEqual([h.pin])
    expect(h.github.filesAt(head)[SOURCE]).toBe(REPAIRED)
    expect(h.github.filesAt(head)["README.md"]).toBe("# b4\n")
    expect(h.github.pulls).toHaveLength(1)
    expect(h.github.pulls[0]).toMatchObject({
      draft: true,
      baseRef: "main",
      headRef: BRANCH,
      author: BOT,
    })
    const receipt = h.store.delivery(ID)
    expect(receipt).toMatchObject({
      receiptPath: h.github.pulls[0]?.url,
      pullRequest: { number: 1000, headSha: head, treeSha: h.github.commits.get(head)?.tree },
    })
    expect(h.outbox.get(ID)?.step).toBe("confirmed")
    expect(h.events()).toEqual([
      "delivery_checked",
      "delivery_committed",
      "delivery_branched",
      "delivery_opened",
      "transition",
    ])
    // The only writes are the ones the approval authorized: one blob, one tree, one commit,
    // one ref, one pull request.
    expect(h.github.writes()).toEqual([
      "createBlob",
      "createTree",
      "createCommit",
      "createBranch",
      "createDraftPull",
    ])
  })

  it.each(["createBlob", "createTree", "createCommit", "createBranch", "createDraftPull"] as const)(
    "converges on one branch and one pull request when %s's response is lost",
    async (method) => {
      const h = await harness()
      h.github.fail(method, transient(), { after: true })
      expect((await h.deliver()).state).toBe("delivered")
      expect([...h.github.refs.keys()].filter((r) => r.startsWith("factory/"))).toEqual([BRANCH])
      expect(h.github.pulls).toHaveLength(1)
      expect(h.waits).toEqual([2_000])
    },
  )

  it.each(["delivery_checked", "delivery_committed", "delivery_branched", "delivery_opened"])(
    "resumes after a controller stop at %s and creates nothing twice",
    async (boundary) => {
      const h = await harness()
      const stopped = await h.deliver({ onEvent: (type, abort) => type === boundary && abort() })
      expect(stopped.state).toBe("delivering")
      const writesBefore = h.github.writes().length
      expect((await h.deliver()).state).toBe("delivered")
      expect(h.github.pulls).toHaveLength(1)
      // A resumed run reads first: each write it repeats is idempotent, and the ref and the
      // pull request were each created once.
      expect(h.github.writes().filter((w) => w === "createBranch").length).toBeLessThanOrEqual(1)
      expect(h.github.writes().filter((w) => w === "createDraftPull")).toHaveLength(1)
      expect(h.github.writes().length).toBeGreaterThanOrEqual(writesBefore)
    },
  )

  it("adopts a branch a lost response created, when its commit is this change on the pin", async () => {
    const h = await harness()
    // A first run died after creating the ref: the ref is there, at an equivalent commit.
    await h.deliver({ onEvent: (type, abort) => type === "delivery_committed" && abort() })
    const commit = h.outbox.get(ID)?.remote.commit?.sha as string
    h.github.refs.set(BRANCH, commit)
    expect((await h.deliver()).state).toBe("delivered")
    expect(h.github.writes().filter((w) => w === "createBranch")).toHaveLength(0)
  })

  it("refuses a branch that holds another commit, and never moves it", async () => {
    const h = await harness()
    h.github.refs.set(BRANCH, h.pin)
    const row = await h.deliver()
    expect(row).toMatchObject({ state: "blocked", blockedReason: "delivery_branch_conflict" })
    expect(h.github.refs.get(BRANCH)).toBe(h.pin)
    expect(h.github.pulls).toHaveLength(0)
  })

  it("refuses when a person closed the factory's pull request, and never reopens it", async () => {
    const h = await harness()
    await h.deliver({ onEvent: (type, abort) => type === "delivery_opened" && abort() })
    const pull = h.github.pulls[0] as (typeof h.github.pulls)[number]
    h.github.pulls[0] = { ...pull, state: "closed" }
    const row = await h.deliver()
    expect(row).toMatchObject({ state: "blocked", blockedReason: "delivery_branch_conflict" })
    expect(h.github.pulls).toHaveLength(1)
  })

  it("blocks unauthorized at once on a 401, a 403 or a refused mint", async () => {
    for (const method of ["open", "compare", "createBranch"] as const) {
      const h = await harness()
      h.github.fail(
        method,
        new DeliveryError("unauthorized", "HTTP 401 Bad credentials", undefined, 401),
      )
      expect(await h.deliver()).toMatchObject({
        state: "blocked",
        blockedReason: "delivery_unauthorized",
      })
      expect(h.waits).toEqual([])
      closeHarness()
    }
  })

  it("waits out a rate limit inside the bound, and blocks rate-limited past it", async () => {
    const limited = new DeliveryError("rate_limited", "HTTP 429", 30_000, 429)
    const inside = await harness()
    inside.github.fail("createTree", limited, { times: 2 })
    expect((await inside.deliver()).state).toBe("delivered")
    expect(inside.waits).toEqual([30_000, 30_000])
    closeHarness()

    const past = await harness()
    past.github.fail("compare", new DeliveryError("rate_limited", "HTTP 403", 3_600_000, 403), {
      times: 9,
    })
    expect(await past.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_rate_limited",
    })
    // Each wait is capped at a minute, and five attempts is the step's bound.
    expect(past.waits).toEqual([60_000, 60_000, 60_000, 60_000])
  })

  it("backs off from 2 s on a 5xx and blocks unconfirmed past the bound", async () => {
    const h = await harness()
    h.github.fail("pullsByHead", transient(503), { times: 9 })
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(h.waits).toEqual([2_000, 4_000, 8_000, 16_000])
  })

  it("stops at the run's bound, whatever the step's attempts", async () => {
    const h = await harness()
    h.github.fail("compare", transient(), { times: 9 })
    const row = await h.deliver({ limits: { runMs: 5_000 } })
    expect(row).toMatchObject({ state: "blocked", blockedReason: "delivery_unconfirmed" })
    expect(h.waits).toEqual([2_000])
  })

  it.each([
    ["a touched file", [{ filename: SOURCE }], "ahead", true],
    [
      "a renamed-away touched file",
      [{ filename: "x.ts", previousFilename: SOURCE }],
      "ahead",
      true,
    ],
    [
      "the Vercel ignore script, which the branch's own build runs",
      [{ filename: "apps/web/scripts/vercel-ignore-build.sh" }],
      "ahead",
      true,
    ],
    ["a pin that left main", [{ filename: "README.md" }], "diverged", true],
    ["a comparison too large to read", [{ filename: "README.md" }], "ahead", false],
  ] as const)(
    "refuses base drift: %s, writing nothing",
    async (_label, files, status, complete) => {
      const h = await harness()
      h.github.comparison = { status, aheadBy: 7, files, complete }
      expect(await h.deliver()).toMatchObject({
        state: "blocked",
        blockedReason: "delivery_base_conflict",
      })
      expect(h.github.writes()).toEqual([])
      expect(h.store.events(ID).find((e) => e.type === "delivery_refused")?.payload).toMatchObject({
        reason: "delivery_base_conflict",
      })
    },
  )

  it("delivers although main changed .github since the pin: the PR runs main's workflows", async () => {
    const h = await harness()
    h.github.comparison = {
      status: "ahead",
      aheadBy: 41,
      files: [{ filename: ".github/workflows/ci.yml" }, { filename: ".github/CODEOWNERS" }],
      complete: true,
    }
    expect((await h.deliver()).state).toBe("delivered")
  })

  it("refuses a change to a protected path at delivery, whatever approval saw", async () => {
    const h = await harness({ source: ".github/workflows/ci.yml" })
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_base_conflict",
    })
    expect(h.github.calls).toEqual(["open"])
  })

  it("stays delivering when the controller closes mid-request, and resumes after", async () => {
    const h = await harness()
    const stopped = await h.deliver({
      onCall: (method, abort) => {
        if (method !== "createBranch") return
        abort()
        throw new DOMException("This operation was aborted", "AbortError")
      },
    })
    expect(stopped).toMatchObject({ state: "delivering", blockedReason: null })
    expect(h.store.events(ID).find((e) => e.type === "delivery_stopped")?.payload).toMatchObject({
      step: "committed",
      reason: "the controller is closing",
    })
    expect((await h.deliver()).state).toBe("delivered")
    expect(h.github.pulls).toHaveLength(1)
  })

  it("refuses when the pin's bytes are not the baseline the candidate was diffed against", async () => {
    const h = await harness({
      pinFiles: { "README.md": "# b4\n", [SOURCE]: "export const deadline = 'other'\n" },
    })
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_baseline_mismatch",
    })
    expect(h.github.writes()).toEqual([])
    expect(JSON.stringify(h.store.events(ID).at(-2)?.payload)).toContain(blobId(BASELINE))
  })

  it("refuses when GitHub stores the bytes under another id", async () => {
    const h = await harness()
    h.github.corruptBlob = "f".repeat(40)
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(h.github.writes()).toEqual(["createBlob"])
  })

  it("blocks when the pull request would close an issue, and leaves it for a person", async () => {
    const h = await harness()
    h.github.closing = [912]
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(h.github.pulls).toHaveLength(1)
    expect(h.store.delivery(ID)).toBeNull()
  })

  it("does not call a pull request another author opened on the branch delivered", async () => {
    const h = await harness()
    h.github.author = "blove"
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
  })

  it("refuses an issue closed since create, and delivers a replay of one closed at create", async () => {
    const reopened = await harness()
    reopened.github.issues.set(912, "closed")
    expect(await reopened.deliver()).toMatchObject({ blockedReason: "delivery_issue_closed" })
    closeHarness()
    const replay = await harness({ stateAtCreate: "closed" })
    replay.github.issues.set(912, "closed")
    expect((await replay.deliver()).state).toBe("delivered")
    expect(replay.github.calls).not.toContain("issueState")
  })

  it("stops before its next write when the work order is cancelled, naming what exists", async () => {
    const h = await harness()
    const row = await h.deliver({
      onEvent: (type) => {
        if (type !== "delivery_branched") return
        const current = h.store.get(ID) as WorkOrderRow
        h.store.update(
          ID,
          current.revision,
          { state: "cancel_requested" },
          new Date().toISOString(),
        )
      },
    })
    expect(row.state).toBe("cancel_requested")
    expect(h.github.pulls).toHaveLength(0)
    const stopped = h.store.events(ID).find((e) => e.type === "delivery_stopped")
    expect(stopped?.payload).toMatchObject({ step: "branched" })
    expect(JSON.stringify(stopped?.payload)).toContain(h.github.refs.get(BRANCH) as string)
  })

  it("journals no token, JWT, PEM or Authorization header, whatever GitHub's errors say", async () => {
    const h = await harness()
    h.github.fail(
      "compare",
      new DeliveryError(
        "unexpected",
        `HTTP 500 with ${TOKEN} and Authorization: token ${TOKEN} and eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOjF9.c2lnbmF0dXJlc2ln -----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----`,
      ),
    )
    await h.deliver()
    const everything = `${h.journal()}${JSON.stringify(h.outbox.get(ID))}`
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toMatch(/eyJhbGciOiJSUzI1NiJ9\./)
    expect(everything).not.toContain("BEGIN RSA PRIVATE KEY")
    expect(everything).toContain("[REDACTED")
  })
})
```

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm exec vitest run test/delivery-worker.test.ts`
Expected: FAIL, `worker.ts` does not exist.

- [ ] **Step 5: Write the worker**

`examples/software-factory/controller/src/lib/delivery/worker.ts`:

```ts
import type { BlockedReason, TransitionEvent } from "../domain/states.js"
import type { WorkOrderRow } from "../domain/work-order.js"
import type { WorkOrderPatch, WorkOrderStore } from "../registry/work-orders.js"
import type { ArtifactStore } from "../storage/artifacts.js"
import { type DeliveryAdapter, DeliveryError, type DeliverySession } from "./adapter.js"
import { blobId, changedTreeId, readPinListings } from "./git-objects.js"
import { isRunFromBranchPath, protectedPathsIn } from "./guard.js"
import type { DeliveryRemote, OutboxRow, OutboxStep, OutboxStore } from "./outbox.js"
import { commitMessage, pullBody } from "./pr-body.js"
import { scrub } from "./scrub.js"

/**
 * The delivery worker (rung 4 spec §5.2): advances one work order's outbox intent through
 * idempotent steps, each of which reads remote state before it writes and records what it
 * observed with the step advanced, in one registry transaction. A lost response, a crash or a
 * restart therefore converges on the one branch and the one pull request that exist. The
 * work order is `delivered` only after the pull request is read back and its head commit's
 * tree is exactly the approved tree; anything the worker cannot reconcile is recorded as a
 * blocked reason, never retried blindly.
 */

/** The worker's bound (spec §6.5, §15 item 6). */
export interface DeliveryLimits {
  /** Attempts of one step before a transient or rate-limited failure blocks. */
  readonly attemptsPerStep: number
  /** The longest single wait, whatever the server asked for. */
  readonly maxWaitMs: number
  /** The whole run's bound, from the first request. */
  readonly runMs: number
  /** The first transient backoff; doubled per attempt. */
  readonly backoffStartMs: number
}
export const DEFAULT_DELIVERY_LIMITS: DeliveryLimits = Object.freeze({
  attemptsPerStep: 5,
  maxWaitMs: 60_000,
  runMs: 600_000,
  backoffStartMs: 2_000,
})

export interface DeliveryWorkerDeps {
  readonly adapter: DeliveryAdapter
  readonly limits: DeliveryLimits
  /** Resolves after `ms`, or early when `signal` aborts. Tests record the waits instead. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  /** Wall clock for the run bound; never the factory's injected `now`. */
  readonly clock: () => number
}

/** What the worker needs from the factory; `ControllerContext` provides all of it. */
export interface DeliveryContext {
  readonly store: WorkOrderStore
  readonly outbox: OutboxStore
  readonly artifacts: Pick<ArtifactStore, "read">
  readonly signal: AbortSignal
  iso(): string
  mustGet(id: string): WorkOrderRow
  recordEvent(id: string, type: string, payload?: Record<string, unknown>): void
  transition(
    id: string,
    event: TransitionEvent,
    patch?: WorkOrderPatch,
    payload?: Record<string, unknown>,
  ): WorkOrderRow
}

/** A refusal: the work order blocks with `reason`, and nothing is retried. */
class Stop extends Error {
  constructor(
    readonly reason: BlockedReason,
    readonly detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail)
    this.name = "Stop"
  }
}

/** The row left `delivering` (a cancel): stop before the next write. */
class Halted extends Error {}

const sameParents = (parents: readonly string[], pin: string) =>
  parents.length === 1 && parents[0] === pin

export async function runDelivery(
  ctx: DeliveryContext,
  deps: DeliveryWorkerDeps,
  id: string,
): Promise<void> {
  const started = deps.clock()
  const secrets = () => deps.adapter.secrets()
  const first = ctx.outbox.get(id)
  if (first === null) {
    refuse(new Stop("delivery_unconfirmed", "a delivering work order with no outbox intent"))
    return
  }
  const { intent } = first

  /** Before every write and every recorded step: a cancel stops the worker there. */
  const ensureDelivering = () => {
    if (ctx.mustGet(id).state !== "delivering") throw new Halted()
  }

  /**
   * Run one step, retrying it whole (it reads before it writes) on a transient failure or a
   * rate limit, within the step's attempts and the run's bound.
   */
  async function attempt<T>(step: string, run: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n += 1) {
      try {
        return await run()
      } catch (error) {
        // A controller closing mid-request aborts the request: that is a stop, not a failure,
        // and the row stays `delivering` for the next boot's reconcile to resume.
        if (ctx.signal.aborted) throw new Halted()
        if (!(error instanceof DeliveryError)) throw error
        const message = scrub(`${step}: ${error.message}`, secrets())
        if (error.kind === "unauthorized") throw new Stop("delivery_unauthorized", message)
        if (error.kind !== "rate_limited" && error.kind !== "transient")
          throw new Stop("delivery_unconfirmed", message, { status: error.status ?? null })
        const wait =
          error.kind === "rate_limited"
            ? Math.min(error.retryAfterMs ?? deps.limits.backoffStartMs, deps.limits.maxWaitMs)
            : Math.min(deps.limits.backoffStartMs * 2 ** (n - 1), deps.limits.maxWaitMs)
        const outOfTime = deps.clock() - started + wait > deps.limits.runMs
        ctx.outbox.note(id, message, ctx.iso())
        ctx.recordEvent(id, "delivery_retry", {
          step,
          attempt: n,
          kind: error.kind,
          waitMs: wait,
          detail: message,
        })
        if (n >= deps.limits.attemptsPerStep || outOfTime)
          throw new Stop(
            error.kind === "rate_limited" ? "delivery_rate_limited" : "delivery_unconfirmed",
            `${message} (after ${n} attempt(s))`,
          )
        await deps.sleep(wait, ctx.signal)
        if (ctx.signal.aborted) throw new Halted()
      }
    }
  }

  /**
   * Record one step's observation and advance, in one transaction, or (the row moved)
   * journal what exists remotely and report false.
   */
  function record(from: OutboxStep, to: OutboxStep, remote: DeliveryRemote, event: string) {
    return ctx.store.transaction(() => {
      const state = ctx.mustGet(id).state
      if (state !== "delivering") {
        ctx.recordEvent(id, "delivery_stopped", { state, step: from, observed: remote })
        return false
      }
      const row = ctx.outbox.advance(id, from, to, remote, ctx.iso())
      ctx.recordEvent(id, event, { ...remote })
      ctx.outbox.note(id, null, ctx.iso())
      return row.step === to
    })
  }

  function refuse(stop: Stop): void {
    const detail = scrub(stop.detail, secrets())
    ctx.store.transaction(() => {
      if (ctx.outbox.get(id) !== null) ctx.outbox.note(id, detail, ctx.iso())
      ctx.recordEvent(id, "delivery_refused", {
        reason: stop.reason,
        detail,
        ...stop.extra,
        remote: ctx.outbox.get(id)?.remote ?? {},
      })
      if (ctx.mustGet(id).state === "delivering")
        ctx.transition(
          id,
          "delivery_refused",
          { blockedReason: stop.reason },
          { reason: stop.reason },
        )
    })
  }

  // (a) Is the change still a change to main, stated against the bytes it was verified on?
  async function check(session: DeliverySession): Promise<DeliveryRemote> {
    // Approval refused a protected path; the guard's list may have grown since. Asked again
    // here, before anything is read or written: the change itself may never touch one.
    const reached = protectedPathsIn(intent.paths.map((p) => p.path))
    if (reached.length > 0)
      throw new Stop(
        "delivery_base_conflict",
        `the change touches ${reached.join(", ")}, which a pull request from the factory may never change`,
        { paths: reached },
      )
    if (intent.issue.stateAtCreate === "open") {
      const state = await session.issueState(intent.issue.number)
      if (state === "closed")
        throw new Stop(
          "delivery_issue_closed",
          `issue #${intent.issue.number} was open when the work order was created and is closed now`,
        )
    }
    const baseTip = await session.branchHead(intent.baseBranch)
    if (baseTip === null)
      throw new Stop("delivery_base_conflict", `${intent.baseBranch} does not exist`)
    const comparison = await session.compare(intent.pin, baseTip)
    if (comparison.status !== "ahead" && comparison.status !== "identical")
      throw new Stop(
        "delivery_base_conflict",
        `the pin ${intent.pin} is not an ancestor of ${intent.baseBranch} at ${baseTip} (${comparison.status})`,
        { baseTip },
      )
    if (!comparison.complete)
      throw new Stop(
        "delivery_base_conflict",
        `${intent.baseBranch} changed ${comparison.files.length} or more files since the pin, more than one comparison can list; deliver from a fresh pin`,
        { baseTip, aheadBy: comparison.aheadBy },
      )
    const touched = new Set(intent.paths.map((p) => p.path))
    const overlap = [
      ...new Set(
        comparison.files.flatMap((file) =>
          [file.filename, file.previousFilename].filter(
            (name): name is string =>
              name !== undefined && (touched.has(name) || isRunFromBranchPath(name)),
          ),
        ),
      ),
    ].sort()
    if (overlap.length > 0)
      throw new Stop(
        "delivery_base_conflict",
        `${intent.baseBranch} changed ${overlap.join(", ")} since the pin; run the issue again at today's tip (--new)`,
        { baseTip, aheadBy: comparison.aheadBy, paths: overlap },
      )
    const pin = await session.commit(intent.pin)
    const paths = intent.paths.map((p) => p.path)
    const read = await readPinListings(pin.tree, paths, (sha) => session.tree(sha))
    if (!read.ok)
      throw new Stop("delivery_baseline_mismatch", read.problems.join("; "), {
        problems: read.problems,
      })
    const mismatched = intent.paths
      .map((p) => ({ path: p.path, baseline: p.baselineBlob, pin: read.entries.get(p.path)?.sha }))
      .filter((p) => p.pin !== p.baseline)
    if (mismatched.length > 0)
      throw new Stop(
        "delivery_baseline_mismatch",
        `the candidate was diffed against bytes that are not the pin's at ${mismatched.map((m) => m.path).join(", ")}`,
        { mismatched },
      )
    const modes = Object.fromEntries(
      intent.paths.map((p) => [p.path, read.entries.get(p.path)?.mode as "100644" | "100755"]),
    )
    const expectedTree = changedTreeId(
      read.listings,
      new Map(intent.paths.map((p) => [p.path, p.candidateBlob])),
    )
    return {
      check: { baseTip, aheadBy: comparison.aheadBy, pinTree: pin.tree, expectedTree, modes },
    }
  }

  // (b) The approved bytes as blobs, a tree on the pin's tree and one commit on the pin.
  async function commit(session: DeliverySession, row: OutboxRow): Promise<DeliveryRemote> {
    const checked = row.remote.check
    if (checked === undefined) throw new Stop("delivery_unconfirmed", "no check recorded")
    let changes: Record<string, unknown>
    try {
      changes = JSON.parse(await ctx.artifacts.read(intent.candidateArtifact)) as Record<
        string,
        unknown
      >
    } catch (error) {
      throw new Stop(
        "delivery_unconfirmed",
        `the approved bytes could not be read: ${String(error)}`,
      )
    }
    const texts = intent.paths.map((p) => {
      const text = changes[p.workspacePath]
      if (typeof text !== "string" || blobId(text) !== p.candidateBlob)
        throw new Stop(
          "delivery_unconfirmed",
          `the approved bytes of ${p.workspacePath} are not the ones the approval named`,
        )
      return text
    })
    ensureDelivering()
    for (const [index, p] of intent.paths.entries()) {
      const sha = await session.createBlob(texts[index] as string)
      if (sha !== p.candidateBlob)
        throw new Stop(
          "delivery_unconfirmed",
          `GitHub stored ${p.path} as blob ${sha}; the approved bytes hash to ${p.candidateBlob}`,
          { path: p.path, returned: sha, expected: p.candidateBlob },
        )
    }
    const tree = await session.createTree(
      checked.pinTree,
      intent.paths.map((p) => ({
        path: p.path,
        mode: checked.modes[p.path] ?? "100644",
        sha: p.candidateBlob,
      })),
    )
    if (tree !== checked.expectedTree)
      throw new Stop(
        "delivery_unconfirmed",
        `GitHub built tree ${tree}; the approved change makes ${checked.expectedTree}`,
        { returned: tree, expected: checked.expectedTree },
      )
    const identity = { ...session.identity, date: intent.approvedAt }
    const sha = await session.createCommit({
      message: commitMessage(intent),
      tree,
      parents: [intent.pin],
      author: identity,
      committer: identity,
    })
    const made = await session.commit(sha)
    if (made.tree !== checked.expectedTree || !sameParents(made.parents, intent.pin))
      throw new Stop("delivery_unconfirmed", `commit ${sha} is not the approved tree on the pin`)
    return { commit: { sha } }
  }

  /**
   * Is `sha` a commit of exactly this change: the approved tree, on the pin, alone? Judged by
   * tree and parent, not by author: a commit someone else made with the identical tree on the
   * pin is the approved bytes, and adopting it publishes exactly what was approved. Only the
   * app can create a `factory/*` branch (the rulesets), and confirm still requires the pull
   * request's author to be the app's bot.
   */
  async function isOurs(session: DeliverySession, sha: string, expectedTree: string) {
    const found = await session.commit(sha)
    return found.tree === expectedTree && sameParents(found.parents, intent.pin)
  }

  // (c) The branch at the commit, created once and never moved.
  async function branch(session: DeliverySession, row: OutboxRow): Promise<DeliveryRemote> {
    const want = row.remote.commit?.sha
    const expectedTree = row.remote.check?.expectedTree
    if (want === undefined || expectedTree === undefined)
      throw new Stop("delivery_unconfirmed", "no commit recorded")
    let head = await session.branchHead(intent.branch)
    if (head === null) {
      ensureDelivering()
      const created = await session.createBranch(intent.branch, want)
      head = created === "created" ? want : await session.branchHead(intent.branch)
      if (head === null)
        throw new Stop(
          "delivery_unconfirmed",
          `${intent.branch} was reported to exist and reads absent`,
        )
    }
    if (head !== want && !(await isOurs(session, head, expectedTree)))
      throw new Stop(
        "delivery_branch_conflict",
        `${intent.branch} exists at ${head}, which is not this change; the factory never moves a branch`,
        { head },
      )
    return { branch: { headSha: head } }
  }

  /** The pull request on our head, if there is exactly one we can call ours. */
  async function ourPull(session: DeliverySession, headSha: string) {
    const pulls = (await session.pullsByHead(intent.branch)).filter(
      (p) => p.headRef === intent.branch && p.headRepository === intent.repository,
    )
    const closed = pulls.find((p) => p.state === "closed")
    if (closed !== undefined)
      throw new Stop(
        "delivery_branch_conflict",
        `#${closed.number} on ${intent.branch} was ${closed.merged ? "merged" : "closed"}; the factory never reopens`,
        { number: closed.number },
      )
    const open = pulls.filter((p) => p.state === "open")
    if (open.length > 1)
      throw new Stop(
        "delivery_branch_conflict",
        `${open.length} open pull requests on ${intent.branch}`,
      )
    const [pull] = open
    if (pull === undefined) return undefined
    if (pull.baseRef !== intent.baseBranch || pull.headSha !== headSha)
      throw new Stop(
        "delivery_branch_conflict",
        `#${pull.number} on ${intent.branch} targets ${pull.baseRef} at head ${pull.headSha}, not ${intent.baseBranch} at ${headSha}`,
        { number: pull.number },
      )
    return pull
  }

  // (d) The draft pull request, found before it is created.
  async function open(session: DeliverySession, row: OutboxRow): Promise<DeliveryRemote> {
    const headSha = row.remote.branch?.headSha
    const checked = row.remote.check
    if (headSha === undefined || checked === undefined)
      throw new Stop("delivery_unconfirmed", "no branch recorded")
    let pull = await ourPull(session, headSha)
    if (pull === undefined) {
      ensureDelivering()
      const made = await session.createDraftPull({
        title: intent.title,
        body: pullBody(intent, checked),
        head: intent.branch,
        base: intent.baseBranch,
      })
      if (made === "exists") {
        pull = await ourPull(session, headSha)
        if (pull === undefined)
          throw new Stop(
            "delivery_unconfirmed",
            `GitHub says a pull request exists for ${intent.branch} and lists none`,
          )
      } else {
        pull = made
        if (!made.draft)
          throw new Stop(
            "delivery_unconfirmed",
            `#${made.number} was created as ready, not draft`,
            {
              number: made.number,
            },
          )
      }
    }
    return { pull: { number: pull.number, url: pull.url, nodeId: pull.nodeId } }
  }

  // Confirm: the receipt is what GitHub holds, read back, not what the writes answered.
  async function confirm(session: DeliverySession, row: OutboxRow): Promise<void> {
    const { pull: recorded, branch: branched, check: checked } = row.remote
    if (recorded === undefined || branched === undefined || checked === undefined)
      throw new Stop("delivery_unconfirmed", "no pull request recorded")
    const pull = await session.pull(recorded.number)
    if (pull.state !== "open")
      throw new Stop(
        "delivery_branch_conflict",
        `#${pull.number} was closed before it was confirmed`,
      )
    const problems = [
      pull.headRef === intent.branch ? null : `its head is ${pull.headRef}`,
      pull.headRepository === intent.repository ? null : `its head is in ${pull.headRepository}`,
      pull.baseRef === intent.baseBranch ? null : `its base is ${pull.baseRef}`,
      pull.author === session.botLogin ? null : `its author is ${pull.author}`,
      pull.headSha === branched.headSha ? null : `its head moved to ${pull.headSha}`,
    ].filter((p): p is string => p !== null)
    if (problems.length === 0 && !(await isOurs(session, pull.headSha, checked.expectedTree)))
      problems.push(`its head commit is not the approved tree on the pin`)
    if (problems.length > 0)
      throw new Stop("delivery_unconfirmed", `#${pull.number}: ${problems.join("; ")}`)
    const closing = await session.closingIssues(pull.number)
    if (closing.length > 0)
      throw new Stop(
        "delivery_unconfirmed",
        `#${pull.number} would close ${closing.map((n) => `#${n}`).join(", ")} on merge; edit its body`,
        { closing },
      )
    ctx.store.transaction(() => {
      ctx.outbox.advance(id, "opened", "confirmed", {}, ctx.iso())
      // The PR exists whatever happened to the row meanwhile: the receipt is the truth.
      ctx.store.recordDelivery({
        workOrderId: id,
        candidateDigest: intent.candidateDigest,
        receiptPath: pull.url,
        observedAt: ctx.iso(),
        pullRequest: {
          number: pull.number,
          url: pull.url,
          headSha: pull.headSha,
          treeSha: checked.expectedTree,
          baseTip: checked.baseTip,
          aheadBy: checked.aheadBy,
        },
      })
      if (ctx.mustGet(id).state === "delivering")
        ctx.transition(id, "delivery_confirmed", {}, { number: pull.number, url: pull.url })
      else ctx.recordEvent(id, "delivery_stopped", { state: ctx.mustGet(id).state, step: "opened" })
    })
  }

  try {
    const session = await attempt("session", () => deps.adapter.open(intent.repository, ctx.signal))
    for (;;) {
      // A closing controller stops between steps; the next boot's reconcile resumes here.
      if (ctx.signal.aborted) throw new Halted()
      const row = ctx.outbox.get(id) as OutboxRow
      if (row.step === "confirmed") return
      ensureDelivering()
      switch (row.step) {
        case "pending":
          if (
            !record(
              "pending",
              "checked",
              await attempt("check", () => check(session)),
              "delivery_checked",
            )
          )
            return
          break
        case "checked":
          if (
            !record(
              "checked",
              "committed",
              await attempt("commit", () => commit(session, row)),
              "delivery_committed",
            )
          )
            return
          break
        case "committed":
          if (
            !record(
              "committed",
              "branched",
              await attempt("branch", () => branch(session, row)),
              "delivery_branched",
            )
          )
            return
          break
        case "branched":
          if (
            !record(
              "branched",
              "opened",
              await attempt("pull", () => open(session, row)),
              "delivery_opened",
            )
          )
            return
          break
        case "opened":
          await attempt("confirm", () => confirm(session, row))
          return
      }
    }
  } catch (error) {
    // A cancel, or a controller closing (between steps or mid-request): journal what exists
    // remotely and leave the row as it is. Never a refusal: nothing went wrong with GitHub.
    if (error instanceof Halted || ctx.signal.aborted) {
      const row = ctx.outbox.get(id)
      ctx.recordEvent(id, "delivery_stopped", {
        state: ctx.mustGet(id).state,
        step: row?.step ?? null,
        observed: row?.remote ?? {},
        ...(ctx.signal.aborted ? { reason: "the controller is closing" } : {}),
      })
      return
    }
    refuse(
      error instanceof Stop
        ? error
        : new Stop("delivery_unconfirmed", `delivery failed: ${String(error)}`),
    )
  }
}
```

- [ ] **Step 6: Run them to see them pass**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/delivery-worker.test.ts`
Expected: 32 passed. If a "converges … lost" case creates a second pull request, a step wrote before it read; if a waits array differs, the backoff or the cap is wrong (D9).

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write src/lib/delivery/worker.ts test/fake-delivery-adapter.ts test/delivery-harness.ts test/delivery-worker.test.ts
git add src/lib/delivery/worker.ts test/fake-delivery-adapter.ts test/delivery-harness.ts test/delivery-worker.test.ts
git commit -m "feat(software-factory): the delivery worker: read-before-write steps, delivered only on read-back

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed (Task 11, with the review fixes of 2026-10-01).** A review ran probes and 27 mutations against Task 11 and found these; each is fixed test-first, and a mutation run of 40 mutants over `worker.ts`, `outbox.ts`, `pr-body.ts` and `git-objects.ts` kills all 40.

- **Step (d) reads the branch again right before `createDraftPull`.** A head that is neither the recorded one nor a commit of exactly this change (`isOurs`) refuses `delivery_branch_conflict` and opens no pull request: a push between steps (c) and (d) was otherwise published under the factory's name and only caught at confirm.
- **Confirm separates "not ours" from "not yet confirmed".** Another head ref, a head in another repository, or an author that is not both the session's bot and `guard.json`'s `botLogin` (`FACTORY_BOT_LOGIN`) is `delivery_branch_conflict`: redelivering cannot make it ours, and the factory never closes a pull request. A head that moved is judged by tree and parent as step (c) judges it: another commit of exactly this change is accepted (the receipt records it), any other head is `delivery_branch_conflict`; a commit GitHub does not have is not ours (a 404 in `isOurs` is false, not a refusal). A changed base, a recorded head that reads back off the approved tree, and closing references stay `delivery_unconfirmed` (redeliverable).
- **Two runs of one delivery** (approve and a reconcile): a `StaleOutboxStepError` from `advance`, at any step or at confirm, is a stop (journal `delivery_stopped`, "another run of this delivery advanced the step first"), never a refusal; the run that advanced owns the delivery.
- **The outbox row is read inside the worker's `try`**: a row that does not parse blocks `delivery_unconfirmed` instead of rejecting `runDelivery`, and `refuse` and the stop path read the row without throwing.
- **The protected-path re-check runs before `adapter.open`**: no request at all for a change to a protected path.
- **A commit read-back mismatch journals both values** (`expected` and `returned` tree and parents).
- **The outbox:** `advance` moves only to the next step and refuses a `remote` that would overwrite an observation an earlier step recorded; `insert` derives the operation key with `deliveryOperationKey(intent.workOrderId, intent.bundleDigest)` and takes none. **Task 13's approve must drop its `operationKey:` argument to `outbox.insert`.**
- **`readPinListings` verifies each listing hashes to the tree id it was read from** (`treeId(listing) === sha`); a listing that does not, or that git cannot encode, is a `delivery_baseline_mismatch` problem, never hashed into a guess. Task 18's adapter must still refuse a `truncated: true` tree answer itself (its `tree()` does), so the problem names the cause.
- **Tests that bind the checks that survived mutation:** confirm's tree-and-parent read-back of the head; the closed-PR refusal and the base/head refusal at step (d); GitHub's tree id against the expected tree (no commit is written after a mismatch); the commit read-back (no branch is created after one); the draft assertion; the head-repository filter at step (d) (a fork's pull request on the same branch name is ignored) and at confirm; confirm's base check; the cancel checks before `createBlob`, `createBranch` and `createDraftPull` (a cancel landing while the step reads); and the pin's mode in `createTree` (an executable file keeps `100755`). The fake gained `botLogin`, `corruptTree`, `rewriteCommit`, `createReady`, executable paths in `seed`, and a fork-aware "pull request exists"; the harness exposes the registry's `db` and an `onArtifactRead` hook.

### Task 12: `create --deliver draft-pr` at the controller, the protected paths at intake, and the frozen delivery

**Files:**
- Create: `src/lib/delivery/approval.ts`
- Modify: `src/lib/domain/errors.ts`, `src/lib/routes/outcome.ts`, `src/lib/routes/input.ts`, `src/app/work-orders/create/index.ts`, `src/lib/controller/factory.ts`, `src/lib/controller/intake.ts`, `src/lib/controller/verify.ts`, `src/lib/runtime.ts` (the override only)
- Create: `test/issue-work-order.ts`
- Test: `test/delivery-approval.test.ts`, `test/factory-delivery.test.ts` (new; its first `describe`)

- [ ] **Step 1: An issue work order driven to the gate** (the collaborators `factory-intake.test.ts` fakes, gathered for tests that start at the export gate):

`examples/software-factory/controller/test/issue-work-order.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSourceBundle } from "@b4run/workspace/node"
import { stagedReferenceOf } from "../src/lib/builder-handoff.ts"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
import type { IssueOrigin, WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { DrafterHandoffSchema } from "../src/lib/drafter-handoff.ts"
import { configureCatalog, resetCatalogForTests } from "../src/lib/targets/catalog.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier, type FakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { fakeBuilderHandoff, fakeWorkerMap } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"
import { GOOD_DRAFT } from "./intake-fixtures.ts"
import { shippedPin } from "./temp-repo.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

/**
 * An issue work order driven through the real factory to its frozen bundle, with every
 * collaborator faked as `factory-intake.test.ts` fakes them: a drafter and a builder on loopback,
 * one workspace reader, a scripted verifier, the devkit target at its shipped pin. For tests of
 * what happens at and after the export gate (rung 4's delivery) that do not care how intake works.
 */

export const ORIGIN: IssueOrigin = {
  kind: "issue",
  repository: "cacheplane/b4run",
  number: 912,
  bodyDigest: "0".repeat(64),
}
export const PIN = shippedPin("devkit")
export const ISSUE = {
  title: "spawnProcess leaks its deadline timer",
  body: "A spawn that fails asynchronously leaves the deadline running.",
}
export const SOURCE = "packages/devkit/src/testing/process.ts"
export const BASELINE_TEXT = "export const deadline = 'leaks'\n"
export const REPAIRED_TEXT = "export const deadline = 'cleared'\n"
const BASELINE = new Map([
  [SOURCE, BASELINE_TEXT],
  ["packages/devkit/test/process.test.ts", "spec\n"],
])
const DRAFT_SOURCE = createSourceBundle([
  { path: "repo/README.md", bytes: new TextEncoder().encode("# fixture\n"), executable: false },
])

export interface IssueHarness {
  readonly dir: string
  readonly generated: string
  readonly verifier: FakeVerifier
  readonly reader: FakeWorkspaceReader
  factory: Factory
  /** Open (or reopen, after `factory.close()`) the factory over the same registry. */
  boot(overrides?: Partial<FactoryOptions>): Promise<Factory>
  /** Create, intake, approve the draft, dispatch and verify: the row parked at the export gate. */
  toBundle(input?: {
    readonly deliver?: { readonly kind: "draft-pr"; readonly issueState: "open" | "closed" }
    readonly draft?: Readonly<Record<string, string>>
  }): Promise<WorkOrderRow & { bundleDigest: string }>
  close(): Promise<void>
}

export async function issueHarness(defaults: Partial<FactoryOptions> = {}): Promise<IssueHarness> {
  const dir = mkdtempSync(join(tmpdir(), "factory-issue-"))
  const generated = join(dir, "state", "tasks")
  mkdirSync(join(dir, "out"), { recursive: true })
  configureCatalog({ generatedTasksDir: generated })
  const drafter: FakeWorker = await createFakeWorker({
    outboxDir: join(dir, "unused"),
    run: "edits_only",
  })
  const builder: FakeWorker = await createFakeWorker({
    outboxDir: join(dir, "unused"),
    run: "edits_only",
    threadId: "builder-thread-1",
  })
  const reader = createFakeWorkspaceReader({})
  const verifier = createFakeVerifier({ independent: "fail" })
  const harness: IssueHarness = {
    dir,
    generated,
    verifier,
    reader,
    factory: undefined as unknown as Factory,
    async boot(overrides = {}) {
      harness.factory = await createFactory({
        registryPath: join(dir, "registry.sqlite"),
        generatedTasksDir: generated,
        captureRoot: dir,
        workers: fakeWorkerMap({
          builder: {
            client: createHttpWorkerClient(builder.baseUrl, { token: TEST_WORKER_TOKEN }),
            reader,
          },
          drafter: {
            client: createHttpWorkerClient(drafter.baseUrl, { token: TEST_WORKER_TOKEN }),
            reader,
          },
        }),
        captureBuilderHandoff: fakeBuilderHandoff,
        captureDrafterHandoff: async ({ workOrderId }) => {
          const workspace = { version: 1 as const, source: DRAFT_SOURCE, environmentLinks: [] }
          return {
            handoff: DrafterHandoffSchema.parse({
              version: 2,
              workOrderId,
              workspace: stagedReferenceOf(workspace),
            }),
            workspace,
          }
        },
        exportDir: join(dir, "out"),
        artifactsDir: join(dir, "artifacts"),
        verifier,
        captureBaseline: async () => ({ digest: "a".repeat(64), files: BASELINE }),
        ...defaults,
        ...overrides,
      })
      return harness.factory
    },
    async toBundle(input = {}) {
      const { factory } = harness
      const created = await factory.createFromIssue({
        origin: ORIGIN,
        pin: PIN,
        issue: ISSUE,
        ...(input.deliver !== undefined ? { deliver: input.deliver } : {}),
        operationKey: `issue:${ORIGIN.number}:${Math.random()}`,
      })
      const started = await factory.intake(created.id)
      if (!started.ok) throw new Error(`intake refused: ${started.message}`)
      const intakeThread = (factory.show(created.id) as WorkOrderRow).workerThreadId as string
      reader.set(intakeThread, input.draft ?? GOOD_DRAFT)
      const parked = await factory.settleIntake(created.id, 20_000)
      if (parked.state !== "awaiting_intake_approval")
        throw new Error(`intake parked nothing: ${parked.state} ${parked.blockedReason}`)
      const approved = await factory.approveIntake(created.id, {
        revision: parked.revision,
        taskDigest: parked.taskDigest as string,
      })
      if (!approved.ok) throw new Error(`approve-intake refused: ${approved.message}`)
      verifier.script = { verdict: "pass" }
      const dispatched = await factory.dispatch(created.id)
      if (!dispatched.ok) throw new Error(`dispatch refused: ${dispatched.message}`)
      const running = await factory.waitFor(created.id, (r) => r.state !== "received")
      reader.set(running.workerThreadId as string, {
        ...Object.fromEntries(BASELINE),
        [SOURCE]: REPAIRED_TEXT,
      })
      const row = await factory.settle(created.id, 20_000)
      if (row.state !== "awaiting_approval" || row.bundleDigest === null)
        throw new Error(`verification parked nothing: ${row.state} ${row.blockedReason}`)
      return row as WorkOrderRow & { bundleDigest: string }
    },
    async close() {
      resetCatalogForTests()
      await harness.factory?.close()
      await drafter.close()
      await builder.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  await harness.boot()
  return harness
}
```

- [ ] **Step 2: Write the failing tests.** `test/delivery-approval.test.ts`:

`examples/software-factory/controller/test/delivery-approval.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { DeliveryError } from "../src/lib/delivery/adapter.ts"
import {
  buildDeliveryIntent,
  preflightDelivery,
  protectedChanges,
} from "../src/lib/delivery/approval.ts"
import { blobId } from "../src/lib/delivery/git-objects.ts"
import { DeliveryIntentSchema } from "../src/lib/delivery/outbox.ts"
import type { DraftPrBundlePayload } from "../src/lib/review/bundle.ts"
import { createFakeGitHub } from "./fake-delivery-adapter.ts"

const target = {
  repository: "cacheplane/b4run",
  baseBranch: "main",
  branch: "factory/wo-0123456789abcdef",
}
const signal = new AbortController().signal

const payload: DraftPrBundlePayload = {
  workOrderId: "wo-0123456789abcdef",
  repositoryId: "wo-0123456789abcdef",
  baselineDigest: "a".repeat(64),
  specificationDigest: "b".repeat(64),
  policyDigest: "e".repeat(64),
  environmentIdentity: "env",
  candidateDigest: "c".repeat(64),
  evidence: [],
  operation: "draft-pr",
  destinationId: "github:cacheplane/b4run:refs/heads/factory/wo-0123456789abcdef",
  receiptId: "rc-verify",
  frozenAt: "2026-10-01T00:00:00.000Z",
  origin: {
    kind: "issue",
    repository: "cacheplane/b4run",
    number: 912,
    bodyDigest: "0".repeat(64),
  },
  pin: "7".repeat(40),
  taskDigest: "d".repeat(64),
  oracleReceiptId: "rc-oracle",
  delivery: { ...target, pathPrefix: "packages/app", issueStateAtCreate: "open" },
}

describe("approving a draft-PR bundle", () => {
  it("states every changed path as a repository path with both blob ids, sorted", () => {
    const intent = buildDeliveryIntent({
      workOrderId: "wo-0123456789abcdef",
      bundleDigest: "f".repeat(64),
      payload,
      candidateArtifact: "9".repeat(64),
      changes: { "src/z.ts": "z2\n", "src/a.ts": "a2\n" },
      baseline: new Map([
        ["src/a.ts", "a1\n"],
        ["src/z.ts", "z1\n"],
        ["src/untouched.ts", "u\n"],
      ]),
      issueNumber: 912,
      specText: "# Fix the thing\n",
      issueText: "# Issue title (cacheplane/b4run#912)\n",
      approvedAt: "2026-10-01T01:00:00.000Z",
      decidedBy: "operator",
      reverificationReceiptId: "rc-reverify",
    })
    expect(DeliveryIntentSchema.parse(intent)).toEqual(intent)
    expect(intent.paths).toEqual([
      {
        path: "packages/app/src/a.ts",
        workspacePath: "src/a.ts",
        baselineBlob: blobId("a1\n"),
        candidateBlob: blobId("a2\n"),
      },
      {
        path: "packages/app/src/z.ts",
        workspacePath: "src/z.ts",
        baselineBlob: blobId("z1\n"),
        candidateBlob: blobId("z2\n"),
      },
    ])
    expect(intent).toMatchObject({
      title: "factory: Fix the thing",
      pin: "7".repeat(40),
      branch: target.branch,
    })
    expect(() =>
      buildDeliveryIntent({
        workOrderId: "wo-0123456789abcdef",
        bundleDigest: "f".repeat(64),
        payload,
        candidateArtifact: "9".repeat(64),
        changes: { "src/new.ts": "n\n" },
        baseline: new Map(),
        issueNumber: 912,
        specText: "",
        issueText: "",
        approvedAt: "t",
        decidedBy: "operator",
        reverificationReceiptId: "rc",
      }),
    ).toThrow(/baseline does not hold src\/new\.ts/)
  })

  it("names the protected paths a candidate would change, under its target's root", () => {
    expect(protectedChanges(".", ["src/a.ts", ".github/workflows/ci.yml"])).toEqual([
      ".github/workflows/ci.yml",
    ])
    expect(protectedChanges("apps/web", ["vercel.json", "page.tsx"])).toEqual([
      "apps/web/vercel.json",
    ])
  })

  it("passes preflight only for the guarded bot with both rulesets in place", async () => {
    const github = createFakeGitHub()
    expect(await preflightDelivery(github, target, signal)).toBeUndefined()
    github.rules.set("factory/*", ["update"])
    expect(await preflightDelivery(github, target, signal)).toMatch(/non_fast_forward to factory\//)
    github.rules.set("main", [])
    expect(await preflightDelivery(github, target, signal)).toMatch(
      /no ruleset restricts updates to main/,
    )
    const refused = createFakeGitHub()
    refused.fail(
      "open",
      new DeliveryError("unauthorized", `bad ${"ghs_faketokenfaketokenfaketoken0001"}`),
    )
    const problem = await preflightDelivery(refused, target, signal)
    expect(problem).toMatch(/^unauthorized: bad \[REDACTED/)
  })
})
```

`test/factory-delivery.test.ts`, with only its imports, helpers, the `describe("create --deliver draft-pr", …)` block and the two helper functions at the end for now (Tasks 13 and 14 append the other two `describe`s exactly as the full file below shows):

`examples/software-factory/controller/test/factory-delivery.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest"
import type { FactoryOptions } from "../src/lib/controller/factory.ts"
import { DeliveryError } from "../src/lib/delivery/adapter.ts"
import { DeliveryUnavailableError } from "../src/lib/domain/errors.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { BundlePayloadSchema } from "../src/lib/review/bundle.ts"
import { createFakeGitHub, type FakeGitHub } from "./fake-delivery-adapter.ts"
import { GOOD_DRAFT } from "./intake-fixtures.ts"
import {
  BASELINE_TEXT,
  ISSUE,
  type IssueHarness,
  issueHarness,
  ORIGIN,
  PIN,
  REPAIRED_TEXT,
  SOURCE,
} from "./issue-work-order.ts"

let harness: IssueHarness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const DRAFT_PR = { kind: "draft-pr", issueState: "open" } as const

/** A fake GitHub holding the pin the harness's work orders are created at. */
function github(): FakeGitHub {
  const fake = createFakeGitHub()
  fake.seed(
    {
      "README.md": "# b4\n",
      [SOURCE]: BASELINE_TEXT,
      "packages/devkit/test/process.test.ts": "spec\n",
      ".github/workflows/ci.yml": "name: CI\n",
    },
    PIN,
  )
  return fake
}

/** The factory's delivery options, with waits that return at once and are recorded. */
function delivery(fake: FakeGitHub, waits: number[] = []): NonNullable<FactoryOptions["delivery"]> {
  return {
    draftPr: { repository: "cacheplane/b4run", baseBranch: "main", adapter: fake },
    sleep: async (ms) => {
      waits.push(ms)
    },
  }
}

const approve = (row: WorkOrderRow & { bundleDigest: string }) =>
  (harness as IssueHarness).factory.approve(row.id, {
    revision: row.revision,
    bundleDigest: row.bundleDigest,
  })
describe("create --deliver draft-pr", () => {
  it("is refused, before anything is created, without delivery or for another repository", async () => {
    harness = await issueHarness()
    const create = () =>
      (harness as IssueHarness).factory.createFromIssue({
        origin: ORIGIN,
        pin: PIN,
        issue: ISSUE,
        deliver: DRAFT_PR,
        operationKey: "issue:912",
      })
    await expect(create()).rejects.toThrow(DeliveryUnavailableError)
    expect(harness.factory.list()).toEqual([])
    await harness.factory.close()
    const fake = github()
    await harness.boot({
      delivery: { ...delivery(fake), draftPr: { ...delivery(fake).draftPr, repository: "x/y" } },
    })
    await expect(create()).rejects.toThrow(/not cacheplane\/b4run/)
    expect(harness.factory.list()).toEqual([])
  })

  it("records where the bundle will go on the row at create", async () => {
    harness = await issueHarness({ delivery: delivery(github()) })
    const created = await harness.factory.createFromIssue({
      origin: ORIGIN,
      pin: PIN,
      issue: ISSUE,
      deliver: DRAFT_PR,
      operationKey: "issue:912",
    })
    expect(created.delivery).toEqual({
      kind: "draft-pr",
      repository: "cacheplane/b4run",
      baseBranch: "main",
      branch: `factory/${created.id}`,
      pathPrefix: null,
      issueStateAtCreate: "open",
    })
  })

  it("freezes the delivery into the bundle the person approves", async () => {
    harness = await issueHarness({ delivery: delivery(github()) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    expect(row.delivery).toMatchObject({ kind: "draft-pr", pathPrefix: "." })
    const payload = BundlePayloadSchema.parse(harness.factory.evidence(row.id).bundle?.payload)
    expect(payload).toMatchObject({
      operation: "draft-pr",
      destinationId: `github:cacheplane/b4run:refs/heads/factory/${row.id}`,
      pin: PIN,
      delivery: { repository: "cacheplane/b4run", baseBranch: "main", pathPrefix: "." },
    })
  })

  it("refuses a draft whose allowed paths reach a delivery-protected path at intake", async () => {
    harness = await issueHarness({ delivery: delivery(github()), maxIntakeAttempts: 1 })
    const task = JSON.parse(GOOD_DRAFT["draft/task.json"] as string) as Record<string, unknown>
    const draft = {
      ...GOOD_DRAFT,
      "draft/task.json": `${JSON.stringify({ ...task, allowedSourcePaths: ["apps/web/vercel.json"] }, null, 2)}\n`,
    }
    await expect(harness.toBundle({ deliver: DRAFT_PR, draft })).rejects.toThrow(
      /intake parked nothing/,
    )
    const refused = harness.factory
      .list()
      .flatMap((r) => harness?.factory.events(r.id) ?? [])
      .find((e) => e.type === "intake_refused")
    expect(refused?.payload.reason).toMatch(
      /apps\/web\/vercel\.json, which a pull request from the factory may never change/,
    )
  })

  it("leaves a local export exactly as it was", async () => {
    harness = await issueHarness({ delivery: delivery(github()) })
    const row = await harness.toBundle()
    expect(row.delivery).toEqual({ kind: "local" })
    const payload = harness.factory.evidence(row.id).bundle?.payload as Record<string, unknown>
    expect(payload.operation).toBe("export-local")
    expect(Object.keys(payload)).not.toContain("delivery")
    expect(await approve(row)).toMatchObject({ ok: true, state: "exported" })
  })
})

describe("approving a draft-PR bundle", () => {
  it("delivers exactly the approved bytes, once, and reads them back", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    expect(row.delivery).toMatchObject({ kind: "draft-pr", pathPrefix: "." })
    const payload = BundlePayloadSchema.parse(harness.factory.evidence(row.id).bundle?.payload)
    expect(payload).toMatchObject({
      operation: "draft-pr",
      destinationId: `github:cacheplane/b4run:refs/heads/factory/${row.id}`,
      pin: PIN,
      delivery: { repository: "cacheplane/b4run", baseBranch: "main", pathPrefix: "." },
    })
    const outcome = await approve(row)
    expect(outcome).toMatchObject({ ok: true, state: "delivered" })
    expect(outcome.message).toContain("https://github.com/cacheplane/b4run/pull/1000")
    const head = fake.refs.get(`factory/${row.id}`) as string
    expect(fake.filesAt(head)[SOURCE]).toBe(REPAIRED_TEXT)
    expect(fake.commits.get(head)?.parents).toEqual([PIN])
    expect(fake.pulls).toHaveLength(1)
    expect(harness.factory.show(row.id)).toMatchObject({ state: "delivered" })
    // One approval, one authorization: the approval row and the outbox intent name each other.
    const [approval] = harness.factory
      .events(row.id)
      .filter((e) => e.type === "transition" && e.payload.event === "approve_delivery")
    expect(approval?.payload).toMatchObject({ bundleDigest: row.bundleDigest })
  })

  it("refuses before re-verifying when preflight fails, and stays at the gate", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    const verified = harness.verifier.verified.length
    fake.fail("open", new DeliveryError("unauthorized", "installation not found", undefined, 404))
    expect(await approve(row)).toMatchObject({
      ok: false,
      state: "awaiting_approval",
      message: expect.stringMatching(/^Delivery preflight: unauthorized/),
    })
    fake.rules.set("main", [])
    const again = await harness.factory.approve(row.id, {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
      operationKey: "approve-again",
    })
    expect(again.message).toMatch(/no ruleset restricts updates to main/)
    expect(harness.verifier.verified).toHaveLength(verified)
    expect(fake.writes()).toEqual([])
  })

  it("is refused when the controller's delivery no longer matches the bundle", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    await harness.factory.close()
    await harness.boot({
      delivery: { ...delivery(fake), draftPr: { ...delivery(fake).draftPr, baseBranch: "next" } },
    })
    expect(await approve(row)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Delivery not configured for cacheplane\/b4run at main/),
    })
  })

  it("resumes a delivery a controller stop interrupted, at boot, creating nothing twice", async () => {
    const fake = github()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    harness = await issueHarness({
      delivery: {
        ...delivery(fake),
        sleep: (_ms, signal) => Promise.race([held, aborted(signal)]),
      },
    })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.fail("createBranch", new DeliveryError("transient", "HTTP 502", undefined, 502))
    const approving = approve(row)
    await harness.factory.waitFor(row.id, (r) => r.state === "delivering")
    await waitForEvent(row.id, "delivery_retry")
    await harness.factory.close()
    await approving.catch(() => undefined)
    release()
    await harness.boot({ delivery: delivery(fake) })
    const final = await harness.factory.waitFor(row.id, (r) => r.state !== "delivering", 10_000)
    expect(final.state).toBe("delivered")
    expect(fake.pulls).toHaveLength(1)
    expect(fake.writes().filter((w) => w === "createDraftPull")).toHaveLength(1)
  })
})

describe("redeliver", () => {
  it("redelivers a healable block under the same approval, and refuses the rest", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.fail("compare", new DeliveryError("unauthorized", "HTTP 401", undefined, 401))
    expect(await approve(row)).toMatchObject({ ok: false, state: "blocked" })
    const blocked = harness.factory.show(row.id) as WorkOrderRow
    expect(blocked.blockedReason).toBe("delivery_unauthorized")
    expect(
      await harness.factory.redeliver(row.id, {
        revision: blocked.revision,
        bundleDigest: "f".repeat(64),
      }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/Bundle digest/) })
    expect(
      await harness.factory.redeliver(row.id, {
        revision: blocked.revision,
        bundleDigest: row.bundleDigest,
      }),
    ).toMatchObject({ ok: true, state: "delivered" })
    expect(fake.pulls).toHaveLength(1)
  })

  it("does not deliver to a destination other than the one approved, after a restart", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.fail("compare", new DeliveryError("transient", "HTTP 502", undefined, 502), { times: 9 })
    expect(await approve(row)).toMatchObject({ ok: false, state: "blocked" })
    await harness.factory.close()
    await harness.boot({
      delivery: { ...delivery(fake), draftPr: { ...delivery(fake).draftPr, baseBranch: "next" } },
    })
    const blocked = harness.factory.show(row.id) as WorkOrderRow
    expect(
      await harness.factory.redeliver(row.id, {
        revision: blocked.revision,
        bundleDigest: row.bundleDigest,
      }),
    ).toMatchObject({ ok: false, state: "blocked" })
    expect(
      harness.factory
        .events(row.id)
        .filter((e) => e.type === "delivery_refused")
        .at(-1)?.payload,
    ).toMatchObject({
      detail: expect.stringContaining("the approval names cacheplane/b4run at main"),
    })
    expect(fake.writes()).toEqual([])
  })

  it("does not redeliver a base conflict: the remedy is a new work order", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.comparison = { status: "ahead", aheadBy: 2, files: [{ filename: SOURCE }], complete: true }
    expect(await approve(row)).toMatchObject({ ok: false, state: "blocked" })
    const blocked = harness.factory.show(row.id) as WorkOrderRow
    expect(blocked.blockedReason).toBe("delivery_base_conflict")
    expect(
      await harness.factory.redeliver(row.id, {
        revision: blocked.revision,
        bundleDigest: row.bundleDigest,
      }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/waiting does not heal it/) })
    expect(fake.writes()).toEqual([])
  })
})

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

async function waitForEvent(id: string, type: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(harness as IssueHarness).factory.events(id).some((e) => e.type === type)) {
    if (Date.now() > deadline) throw new Error(`no ${type} on ${id}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm exec vitest run test/delivery-approval.test.ts test/factory-delivery.test.ts`
Expected: FAIL: `approval.ts` and `DeliveryUnavailableError` do not exist; `createFromIssue` takes no `deliver`.

- [ ] **Step 4: The approval's pieces** (used by Task 13; `DraftPrConfig` types the factory's option here):

`examples/software-factory/controller/src/lib/delivery/approval.ts`:

```ts
import type { DraftPrBundlePayload } from "../review/bundle.js"
import { type DeliveryAdapter, DeliveryError } from "./adapter.js"
import { blobId } from "./git-objects.js"
import { FACTORY_BOT_LOGIN, protectedPathsIn, repositoryPath } from "./guard.js"
import type { DeliveryIntent } from "./outbox.js"
import { pullTitle } from "./pr-body.js"
import { scrub } from "./scrub.js"

/**
 * What `approve` checks and commits for a draft-PR bundle (rung 4 spec §3.4), kept out of
 * the factory so each piece is tested on its own. Nothing here writes to GitHub.
 */

/** The configured destination: the controller's, and the only one it delivers to. */
export interface DraftPrConfig {
  readonly repository: string
  readonly baseBranch: string
  readonly adapter: DeliveryAdapter
}

/** The changed paths a delivery may never touch, as repository paths. */
export function protectedChanges(pathPrefix: string, changedPaths: readonly string[]): string[] {
  return protectedPathsIn(changedPaths.map((path) => repositoryPath(pathPrefix, path)))
}

/**
 * Preflight (spec §3.4 item 3, §10.2): a token can be minted for the repository, the app is the
 * one the CI guard skips, and the rulesets that confine it exist. A problem is a refusal, not a
 * block: nothing was committed, and a person can fix the app and approve again in the window.
 * The rulesets' bypass lists cannot be read with the app's token; the scratch lane and the
 * live run check those once.
 */
export async function preflightDelivery(
  adapter: DeliveryAdapter,
  target: { readonly repository: string; readonly baseBranch: string; readonly branch: string },
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const session = await adapter.open(target.repository, signal)
    if (session.botLogin !== FACTORY_BOT_LOGIN)
      return `the app's bot is ${session.botLogin}, but the CI guard skips ${FACTORY_BOT_LOGIN} (controller/src/lib/delivery/guard.json and the workflows): rename one`
    const base = await session.branchRules(target.baseBranch)
    if (!base.includes("update"))
      return `no ruleset restricts updates to ${target.baseBranch}: create "factory app confined" (spec §10.2) before delivering`
    const own = await session.branchRules(target.branch)
    const missing = ["update", "non_fast_forward"].filter((rule) => !own.includes(rule))
    if (missing.length > 0)
      return `the rulesets do not apply ${missing.join(" and ")} to ${target.branch}: create "factory branches are append-never" (spec §10.2)`
    return undefined
  } catch (error) {
    const message =
      error instanceof DeliveryError
        ? `${error.kind}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error)
    return scrub(message, adapter.secrets())
  }
}

/**
 * The outbox intent an approval commits: everything the worker will need, read now from
 * sources the approval just checked (the frozen bundle, the re-captured baseline, the task
 * directory read with the digest it was compared against), so a resumed worker re-reads
 * nothing that could have moved.
 */
export function buildDeliveryIntent(input: {
  readonly workOrderId: string
  readonly bundleDigest: string
  readonly payload: DraftPrBundlePayload
  readonly candidateArtifact: string
  readonly changes: Readonly<Record<string, string>>
  readonly baseline: ReadonlyMap<string, string>
  readonly issueNumber: number
  readonly specText: string
  readonly issueText: string
  readonly approvedAt: string
  readonly decidedBy: string
  readonly reverificationReceiptId: string
}): DeliveryIntent {
  const { payload } = input
  if (payload.taskDigest === null) throw new Error("A draft-PR bundle names no approved task")
  const paths = Object.keys(input.changes)
    .map((workspacePath) => {
      const before = input.baseline.get(workspacePath)
      if (before === undefined)
        throw new Error(`the baseline does not hold ${workspacePath}, which the candidate changes`)
      return {
        path: repositoryPath(payload.delivery.pathPrefix, workspacePath),
        workspacePath,
        baselineBlob: blobId(before),
        candidateBlob: blobId(input.changes[workspacePath] as string),
      }
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1))
  return {
    version: 1,
    workOrderId: input.workOrderId,
    bundleDigest: input.bundleDigest,
    candidateDigest: payload.candidateDigest,
    candidateArtifact: input.candidateArtifact,
    repository: payload.delivery.repository,
    baseBranch: payload.delivery.baseBranch,
    branch: payload.delivery.branch,
    pin: payload.pin,
    pathPrefix: payload.delivery.pathPrefix,
    issue: { number: input.issueNumber, stateAtCreate: payload.delivery.issueStateAtCreate },
    paths,
    title: pullTitle(input.specText, input.issueText),
    specText: input.specText,
    approvedAt: input.approvedAt,
    decidedBy: input.decidedBy,
    digests: {
      task: payload.taskDigest,
      policy: payload.policyDigest,
      environment: payload.environmentIdentity,
      oracleReceiptId: payload.oracleReceiptId,
      receiptId: payload.receiptId,
      reverificationReceiptId: input.reverificationReceiptId,
    },
  }
}
```

- [ ] **Step 5: The refusal, as a route value.** `src/lib/domain/errors.ts`, before `UnknownWorkOrderError`:

```ts
/**
 * `create --deliver draft-pr` that this controller cannot honour: it has no delivery
 * configured, or it delivers to another repository than the issue's (rung 4 §3.1). Thrown
 * before the operation key is spent.
 */
export class DeliveryUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DeliveryUnavailableError"
  }
}
```

```diff
diff --git a/examples/software-factory/controller/src/lib/routes/outcome.ts b/examples/software-factory/controller/src/lib/routes/outcome.ts
index 077b175c8..29e20dabf 100644
--- a/examples/software-factory/controller/src/lib/routes/outcome.ts
+++ b/examples/software-factory/controller/src/lib/routes/outcome.ts
@@ -1,6 +1,11 @@
 import type { z } from "zod"
 import type { Factory } from "../controller/factory.js"
-import { CommandInFlightError, UnknownTaskError, UnknownWorkOrderError } from "../domain/errors.js"
+import {
+  CommandInFlightError,
+  DeliveryUnavailableError,
+  UnknownTaskError,
+  UnknownWorkOrderError,
+} from "../domain/errors.js"
 import type { CommandOutcome, WorkOrderRow } from "../domain/work-order.js"
 import { StaleRevisionError } from "../registry/work-orders.js"
 
@@ -10,6 +15,7 @@ export type Refusal =
   | "unknown_work_order"
   | "command_in_flight"
   | "stale_revision"
+  | "delivery_unavailable"
 
 /**
  * What every mutating route returns. A workflow route's thrown error is a 500 with no
@@ -47,6 +53,8 @@ export async function command<T>(
     if (error instanceof UnknownTaskError) return refused("unknown_task", error.message)
     if (error instanceof UnknownWorkOrderError) return refused("unknown_work_order", error.message)
     if (error instanceof CommandInFlightError) return refused("command_in_flight", error.message)
+    if (error instanceof DeliveryUnavailableError)
+      return refused("delivery_unavailable", error.message)
     // Expected concurrency, not a fault: a background observer or the budget ticker wrote the
     // row between this command's read and its compare-and-swap. The caller re-reads and retries.
     if (error instanceof StaleRevisionError) return refused("stale_revision", error.message)
```

- [ ] **Step 6: The create input and route.** In `src/lib/routes/input.ts` replace `IssueCreateInput`'s `issue:` line and its closing `.strict()`:

```diff
     pin: z.string().regex(COMMIT_PATTERN),
-    issue: z.object({ title: z.string().min(1), body: z.string() }).strict(),
+    issue: z
+      .object({
+        title: z.string().min(1),
+        body: z.string(),
+        /** Required with `deliver: "draft-pr"`: the issue's state when the CLI read it. */
+        state: z.enum(["open", "closed"]).optional(),
+      })
+      .strict(),
+    /** Where the approved bundle goes (rung 4 §3.1). Absent: `local`, today's export. */
+    deliver: z.enum(["local", "draft-pr"]).optional(),
     operationKey: z.string().min(1).optional(),
   })
   .strict()
+  .refine((input) => input.deliver !== "draft-pr" || input.issue.state !== undefined, {
+    message: "deliver draft-pr needs issue.state",
+    path: ["issue", "state"],
+  })
 export type CatalogCreate = z.infer<typeof CatalogCreateInput>
```

```diff
diff --git a/examples/software-factory/controller/src/app/work-orders/create/index.ts b/examples/software-factory/controller/src/app/work-orders/create/index.ts
index 9fa3acd46..220e68b9d 100644
--- a/examples/software-factory/controller/src/app/work-orders/create/index.ts
+++ b/examples/software-factory/controller/src/app/work-orders/create/index.ts
@@ -19,7 +19,15 @@ export async function workflow(input: unknown) {
           : await factory.createFromIssue({
               origin: input.origin,
               pin: input.pin,
-              issue: input.issue,
+              issue: { title: input.issue.title, body: input.issue.body },
+              ...(input.deliver === "draft-pr"
+                ? {
+                    deliver: {
+                      kind: "draft-pr" as const,
+                      issueState: input.issue.state as "open" | "closed",
+                    },
+                  }
+                : {}),
               ...key,
             })
       return { ok: true, state: row.state, message: "Created", row }
```

- [ ] **Step 7: The factory takes a delivery option and records the delivery at create.** In `src/lib/controller/factory.ts`:

Imports (add beside the existing ones):

```ts
import type { DraftPrConfig } from "../delivery/approval.js"
import type { DeliveryLimits } from "../delivery/worker.js"
```

and widen two existing imports: `CommandInFlightError, DeliveryUnavailableError, UnknownTaskError, UnknownWorkOrderError` from `../domain/errors.js`; `type RowDelivery` beside `type Receipt` from `../domain/work-order.js`.

`FactoryOptions`, after `log?`:

```ts
  /**
   * Draft-PR delivery (rung 4). Absent, `createFromIssue` refuses `draft-pr` and a row left
   * `delivering` blocks `delivery_unauthorized` at reconcile. The runtime wires the GitHub
   * adapter (`delivery/github/adapter.ts`); tests inject the in-memory one.
   */
  readonly delivery?: {
    readonly draftPr: DraftPrConfig
    readonly limits?: Partial<DeliveryLimits>
    /** Test seam: the worker's waits. Default: a real, abortable sleep. */
    readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    /** Test seam: the worker's wall clock for its run bound. Default `Date.now`. */
    readonly clock?: () => number
  }
```

`Factory.createFromIssue`'s input, after `issue`:

```ts
    /**
     * Deliver the approved bundle as a draft pull request (rung 4 §3.1) instead of a local
     * export. `issueState` is the issue's state as the CLI read it; the rest of the delivery
     * comes from this controller's configuration and the work order's id.
     */
    deliver?: { readonly kind: "draft-pr"; readonly issueState: "open" | "closed" }
```

`createFromIssue` itself (destructure `deliver`; replace Task 6's insert):

```diff
-    async createFromIssue({ origin, pin, issue, operationKey }) {
+    async createFromIssue({ origin, pin, issue, deliver, operationKey }) {
```

```diff
       if (!COMMIT_PATTERN.test(pin)) throw new Error(`pin must be a 40-hex commit sha, got ${pin}`)
-      const row = insertWorkOrder(operationKey, { origin, pin }, (id) => ({
-        taskId: id,
-        origin,
-        pin,
-        delivery: { kind: "local" },
-      }))
+      // A draft PR goes to the issue's repository from this controller's configuration, or
+      // nowhere (rung 4 §3.1): refused here, before the key is spent, like the checks above.
+      const draftPr = options.delivery?.draftPr
+      if (deliver !== undefined) {
+        if (draftPr === undefined)
+          throw new DeliveryUnavailableError(
+            "This controller has no draft-PR delivery configured (factory.config.ts delivery.draftPr); create it with --deliver local, or configure delivery and restart",
+          )
+        if (draftPr.repository !== origin.repository)
+          throw new DeliveryUnavailableError(
+            `This controller delivers to ${draftPr.repository}, not ${origin.repository}: a pull request goes to the issue's own repository`,
+          )
+      }
+      const delivery = (id: string): RowDelivery =>
+        deliver === undefined || draftPr === undefined
+          ? { kind: "local" }
+          : {
+              kind: "draft-pr",
+              repository: draftPr.repository,
+              baseBranch: draftPr.baseBranch,
+              branch: `factory/${id}`,
+              pathPrefix: null,
+              issueStateAtCreate: deliver.issueState,
+            }
+      const row = insertWorkOrder(
+        operationKey,
+        { origin, pin, ...(deliver !== undefined ? { deliver } : {}) },
+        (id) => ({ taskId: id, origin, pin, delivery: delivery(id) }),
+      )
```

`deliver` is in the command's recorded intent and in the `created` event: replaying a key with another delivery is refused by the command log ("already used with a different intent").

- [ ] **Step 8: Intake refuses a protected allowed path and fills the path prefix**

```diff
diff --git a/examples/software-factory/controller/src/lib/controller/intake.ts b/examples/software-factory/controller/src/lib/controller/intake.ts
index b490b0f9f..fe226e94b 100644
--- a/examples/software-factory/controller/src/lib/controller/intake.ts
+++ b/examples/software-factory/controller/src/lib/controller/intake.ts
@@ -1,5 +1,6 @@
 import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
 import { dirname, join } from "node:path"
+import { protectedPathsIn, repositoryPath } from "../delivery/guard.js"
 import type { BlockedReason } from "../domain/states.js"
 import type { Receipt, WorkOrderRow } from "../domain/work-order.js"
 import { DRAFT_ROOT, parseDraft } from "../intake/draft.js"
@@ -366,6 +367,25 @@ async function proveDraft(
     await refuse(ctx, id, parsed.reason, parsed.blockedReason, draft)
     return
   }
+  // A work order that will be delivered as a pull request may never be allowed to change the
+  // files the CI guard lives in (rung 4 spec §9.3): the person then approves a task.json that
+  // cannot name one. Refused like any fit failure, so the drafter redrafts with the paths named.
+  const { delivery } = ctx.mustGet(id)
+  if (delivery.kind === "draft-pr") {
+    const reached = protectedPathsIn(
+      parsed.manifest.allowedSourcePaths.map((path) => repositoryPath(parsed.target.root, path)),
+    )
+    if (reached.length > 0) {
+      await refuse(
+        ctx,
+        id,
+        `${DRAFT_ROOT}task.json allows ${reached.join(", ")}, which a pull request from the factory may never change (the CI guard lives there); allow other paths`,
+        "intake_invalid",
+        draft,
+      )
+      return
+    }
+  }
   // The fit step's image (spec item 4): the drafted target at the work order's pin, built now
   // if this host has none, journalled with its log, and bound to this attempt, which proves
   // its oracle in it. Its time is not the work order's (the budget is paused around it), and a
@@ -468,6 +488,11 @@ async function proveDraft(
       targetId: parsed.manifest.target,
       taskDigest: generated.digest,
       intakeAttempts: current.intakeAttempts + 1,
+      // Where the target's workspace sits in the repository: known only now, and what a
+      // draft-PR delivery joins every changed path to. Filled with the target, once.
+      ...(current.delivery.kind === "draft-pr"
+        ? { delivery: { ...current.delivery, pathPrefix: parsed.target.root } }
+        : {}),
     },
     { taskDigest: generated.digest, receiptId: receipt.id, attempt: current.intakeAttempts + 1 },
   )
```

- [ ] **Step 9: Verification freezes the delivery**

```diff
diff --git a/examples/software-factory/controller/src/lib/controller/verify.ts b/examples/software-factory/controller/src/lib/controller/verify.ts
index 17fb7b213..63ebea2aa 100644
--- a/examples/software-factory/controller/src/lib/controller/verify.ts
+++ b/examples/software-factory/controller/src/lib/controller/verify.ts
@@ -259,6 +259,12 @@ async function verifyCandidate(
     return
   }
 
+  // A draft-PR work order freezes where it publishes into the bundle the person approves. An
+  // intake that never fitted a target cannot reach `verifying`, so a null prefix is a fault:
+  // it throws into the backstop above and the phase is inconclusive.
+  const { delivery } = row
+  if (delivery.kind === "draft-pr" && delivery.pathPrefix === null)
+    throw new Error(`work order ${id} is a draft-PR delivery with no path prefix`)
   const bundle = freezeBundle({
     workOrderId: id,
     repositoryId: row.taskId,
@@ -273,6 +279,17 @@ async function verifyCandidate(
     pin: row.pin,
     taskDigest: row.taskDigest,
     oracleReceiptId: oracleReceiptIdFor(ctx.store.events(id), row.taskDigest),
+    ...(delivery.kind === "draft-pr"
+      ? {
+          delivery: {
+            repository: delivery.repository,
+            baseBranch: delivery.baseBranch,
+            branch: delivery.branch,
+            pathPrefix: delivery.pathPrefix as string,
+            issueStateAtCreate: delivery.issueStateAtCreate,
+          },
+        }
+      : {}),
   })
 
   ctx.store.transaction(() => {
```

- [ ] **Step 10: A served controller can be given a delivery** (the CLI tests in Task 15 need it). In `src/lib/runtime.ts`, `ControllerRuntimeOverrides`' `Pick` list:

```diff
     | "allowBudgetBelowVerifierDeadline"
+    | "delivery"
   >
```

- [ ] **Step 11: Run the tests**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/delivery-approval.test.ts test/factory-delivery.test.ts test/factory-intake.test.ts test/factory-create.test.ts test/factory-verify.test.ts test/routes.test.ts`
Expected: PASS (`factory-delivery.test.ts`: 5 in its first `describe`).

- [ ] **Step 12: Commit**

```bash
pnpm exec biome check --write src/lib/delivery/approval.ts src/lib/domain/errors.ts src/lib/routes/outcome.ts src/lib/routes/input.ts src/app/work-orders/create/index.ts src/lib/controller/factory.ts src/lib/controller/intake.ts src/lib/controller/verify.ts src/lib/runtime.ts test/issue-work-order.ts test/delivery-approval.test.ts test/factory-delivery.test.ts
git add src/lib/delivery/approval.ts src/lib/domain/errors.ts src/lib/routes/outcome.ts src/lib/routes/input.ts src/app/work-orders/create/index.ts src/lib/controller/factory.ts src/lib/controller/intake.ts src/lib/controller/verify.ts src/lib/runtime.ts test/issue-work-order.ts test/delivery-approval.test.ts test/factory-delivery.test.ts
git commit -m "feat(software-factory): create --deliver draft-pr, protected paths at intake, the delivery frozen into the bundle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Approving a draft-PR bundle commits the intent and runs the worker; reconcile resumes it

**Files:**
- Modify: `src/lib/controller/factory.ts`, `src/lib/controller/context.ts`, `src/lib/controller/reconcile.ts`
- Test: `test/factory-delivery.test.ts` (append the `describe("approving a draft-PR bundle", …)` block from the full file in Task 12)

- [ ] **Step 1: Append the failing tests** (the second `describe` of the file above) and run them

Run: `pnpm exec vitest run test/factory-delivery.test.ts`
Expected: the 4 new tests FAIL: approve answers `exported` or refuses `Export destination changed` (the draft-PR destination is not the export directory).

- [ ] **Step 2: The context carries the outbox and starts deliveries**

```diff
diff --git a/examples/software-factory/controller/src/lib/controller/context.ts b/examples/software-factory/controller/src/lib/controller/context.ts
index 28e99c5dc..ed0e2aeda 100644
--- a/examples/software-factory/controller/src/lib/controller/context.ts
+++ b/examples/software-factory/controller/src/lib/controller/context.ts
@@ -1,3 +1,4 @@
+import type { OutboxStore } from "../delivery/outbox.js"
 import type { TransitionEvent } from "../domain/states.js"
 import type { WorkOrderRow } from "../domain/work-order.js"
 import type { CommandLog } from "../registry/commands.js"
@@ -14,6 +15,13 @@ import type { DrafterWorker, TargetWorker } from "./workers.js"
 /** What reconciliation and the run observer need from the factory. Kept narrow on purpose. */
 export interface ControllerContext {
   readonly store: WorkOrderStore
+  /** The draft-PR delivery outbox (rung 4): one intent per approved work order. */
+  readonly outbox: OutboxStore
+  /**
+   * Run (or join) the delivery worker for a `delivering` work order, tracked like a builder
+   * run. Resolves when the worker stops: delivered, blocked, or halted by a cancel or close.
+   */
+  startDelivery(id: string): Promise<void>
   readonly commands: CommandLog
   readonly evidence: EvidenceStore
   readonly artifacts: ArtifactStore
```

- [ ] **Step 3: The factory: the outbox, the worker's collaborators, `startDelivery`.** In `src/lib/controller/factory.ts`, extend the imports:

```ts
import {
  buildDeliveryIntent,
  type DraftPrConfig,
  preflightDelivery,
  protectedChanges,
} from "../delivery/approval.js"
import {
  createOutboxStore,
  type DeliveryIntent,
  deliveryOperationKey,
  type OutboxStore,
} from "../delivery/outbox.js"
import {
  DEFAULT_DELIVERY_LIMITS,
  type DeliveryLimits,
  type DeliveryWorkerDeps,
  runDelivery,
} from "../delivery/worker.js"
```

(replacing Task 12's two type-only imports), `readGeneratedTask` beside `digestGeneratedTask` from `../intake/generated-task.js`, and `type DraftPrBundlePayload, draftPrDestinationId` beside `BundlePayloadSchema` from `../review/bundle.js`. After `const commands: CommandLog = createCommandLog(registry.db)`:

```ts
  const outbox: OutboxStore = createOutboxStore(registry.db)
```

Before `// The narrow view the run observer, the verifying phase and reconciliation share.`:

```ts
  /** The delivery worker's collaborators, when this controller delivers draft PRs. */
  const deliveryDeps: DeliveryWorkerDeps | undefined =
    options.delivery === undefined
      ? undefined
      : {
          adapter: options.delivery.draftPr.adapter,
          limits: { ...DEFAULT_DELIVERY_LIMITS, ...options.delivery.limits },
          sleep:
            options.delivery.sleep ??
            ((ms, signal) => sleep(ms, undefined, { signal }).catch(() => undefined)),
          clock: options.delivery.clock ?? Date.now,
        }

  /**
   * Run the delivery worker for `id`, tracked (close waits for it, reconcile does not start a
   * second), or join the one already running. A row left `delivering` by a controller that no
   * longer delivers blocks `delivery_unauthorized`: nothing can deliver it here, and
   * `redeliver` resumes it once delivery is configured again.
   */
  function startDelivery(id: string): Promise<void> {
    const running = runs.get(id)
    if (running !== undefined) return running
    const unable = (detail: string) => {
      store.transaction(() => {
        recordEvent(id, "delivery_refused", { reason: "delivery_unauthorized", detail })
        if (mustGet(id).state === "delivering")
          transition(id, "delivery_refused", { blockedReason: "delivery_unauthorized" })
      })
      return Promise.resolve()
    }
    if (deliveryDeps === undefined || options.delivery === undefined)
      return unable("this controller has no draft-PR delivery configured")
    // The approval named one repository and base; the controller may have been restarted
    // configured for another (D27). Approve, reconcile and redeliver all come through here.
    const intent = outbox.get(id)?.intent
    const { repository, baseBranch } = options.delivery.draftPr
    if (intent !== undefined && (intent.repository !== repository || intent.baseBranch !== baseBranch))
      return unable(
        `this controller delivers to ${repository} at ${baseBranch}; the approval names ${intent.repository} at ${intent.baseBranch}`,
      )
    track(id, runDelivery(ctx, deliveryDeps, id))
    return runs.get(id) as Promise<void>
  }

```

and in the `ctx` object, after `store,`:

```ts
    outbox,
    startDelivery,
```

`track`'s journal line can now carry a delivery's fault: scrub it (`import { scrub } from "../delivery/scrub.js"`):

```diff
-          recordEvent(id, "run_observer_error", { error: String(error) })
+          // Scrubbed: a delivery's fault could quote a request (rung 4 §8.3).
+          recordEvent(id, "run_observer_error", { error: scrub(String(error)) })
```

- [ ] **Step 4: `approve`.** Five edits, in order, in `approve`'s body.

(a) The destination check:

```diff
-      if (frozen.destinationId !== options.exportDir)
-        return invalidated("Export destination", frozen.destinationId, options.exportDir)
+      // Where the bundle goes is part of what was approved: this controller's export directory
+      // for a local export, the one branch of one repository for a draft PR.
+      const destination =
+        frozen.operation === "draft-pr" ? draftPrDestinationId(frozen.delivery) : options.exportDir
+      if (frozen.destinationId !== destination)
+        return invalidated(
+          frozen.operation === "draft-pr" ? "Delivery destination" : "Export destination",
+          frozen.destinationId,
+          destination,
+        )
```

(b) Keep the re-captured baseline's files (the intent needs the bytes the candidate was diffed against):

```diff
-      let baselineDigest: string
+      let baseline: Awaited<ReturnType<FactoryOptions["captureBaseline"]>>
       try {
-        baselineDigest = (await options.captureBaseline(row.taskId, abort.signal)).digest
+        baseline = await options.captureBaseline(row.taskId, abort.signal)
       } catch (error) {
         recordEvent(id, "baseline_unavailable", { phase: "export", error: String(error) })
         return refuse(`Baseline could not be captured: ${String(error)}`)
       }
-      if (frozen.baselineDigest !== baselineDigest)
-        return invalidated("Baseline", frozen.baselineDigest, baselineDigest)
+      if (frozen.baselineDigest !== baseline.digest)
+        return invalidated("Baseline", frozen.baselineDigest, baseline.digest)
```

(c) After the generated-task block (the `if (frozen.taskDigest !== null) { … }` that ends with the "Generated task pin" check) and before `let receipt: Receipt`, the draft-PR checks (D21):

```ts
      // A draft-PR bundle (rung 4 §3.4): everything that can refuse in seconds is asked before
      // the re-verification, so a refusal never costs a verification. Nothing is written to
      // GitHub here, and nothing is committed until the approval's own transaction.
      // Both ways: a local bundle on a draft-PR row is as wrong as the reverse.
      if (frozen.operation === "export-local" && row.delivery.kind !== "local")
        return invalidated("Delivery", "export-local", row.delivery.kind)
      let delivery:
        | {
            readonly config: DraftPrConfig
            readonly payload: DraftPrBundlePayload
            readonly specText: string
            readonly issueText: string
            readonly issueNumber: number
          }
        | undefined
      if (frozen.operation === "draft-pr") {
        const rowDelivery = row.delivery
        const fromRow =
          rowDelivery.kind === "draft-pr"
            ? {
                repository: rowDelivery.repository,
                baseBranch: rowDelivery.baseBranch,
                branch: rowDelivery.branch,
                pathPrefix: rowDelivery.pathPrefix,
                issueStateAtCreate: rowDelivery.issueStateAtCreate,
              }
            : rowDelivery
        if (canon(frozen.delivery) !== canon(fromRow))
          return invalidated("Delivery", canon(frozen.delivery), canon(fromRow))
        if (row.origin.kind !== "issue")
          return refuse("A draft-PR bundle must come from an issue work order")
        const config = options.delivery?.draftPr
        if (
          config === undefined ||
          config.repository !== frozen.delivery.repository ||
          config.baseBranch !== frozen.delivery.baseBranch
        )
          return refuse(
            `Delivery not configured for ${frozen.delivery.repository} at ${frozen.delivery.baseBranch}: configure it and restart the controller, then approve again inside the window`,
          )
        const reached = protectedChanges(frozen.delivery.pathPrefix, candidate.changedPaths)
        if (reached.length > 0) {
          recordEvent(id, "delivery_protected_paths", { paths: reached })
          return refuse(
            `The candidate changes ${reached.join(", ")}, which a pull request from the factory may never change; deny it`,
          )
        }
        const problem = await preflightDelivery(config.adapter, frozen.delivery, abort.signal)
        if (problem !== undefined) {
          recordEvent(id, "delivery_preflight_refused", { problem })
          return refuse(`Delivery preflight: ${problem}`)
        }
        // The spec and the issue as approved: read once with the digest they are checked
        // against, so the pull request quotes the bytes the bundle names.
        let task: ReturnType<typeof readGeneratedTask>
        try {
          task = readGeneratedTask(join(options.generatedTasksDir, id))
        } catch (error) {
          return refuse(`Generated task unreadable: ${String(error)}`)
        }
        if (task.digest !== frozen.taskDigest)
          return invalidated("Generated task", String(frozen.taskDigest), task.digest)
        delivery = {
          config,
          payload: frozen,
          specText: task.files.get("spec.md")?.toString("utf8") ?? "",
          issueText: task.files.get("issue.md")?.toString("utf8") ?? "",
          issueNumber: row.origin.number,
        }
      }
```

(d) The approval's transaction commits the intent with the approval and the transition, built first so a refusal cannot leave the key in flight:

```diff
       // The verify above was an await: a cancel (operator or budget) may have moved the row,
       // and `approve` is not a legal move from where it left it.
+      const approvalId = `ap-${randomUUID()}`
+      const decidedAt = iso()
+      const decidedBy = options.actor ?? "operator"
+      // Built before the transaction: a refusal here must not leave the key in flight.
+      let intent: DeliveryIntent | undefined
+      if (delivery !== undefined)
+        try {
+          intent = buildDeliveryIntent({
+            workOrderId: id,
+            bundleDigest,
+            payload: delivery.payload,
+            candidateArtifact: candidate.artifactDigest,
+            changes,
+            baseline: baseline.files,
+            issueNumber: delivery.issueNumber,
+            specText: delivery.specText,
+            issueText: delivery.issueText,
+            approvedAt: decidedAt,
+            decidedBy,
+            reverificationReceiptId: receipt.id,
+          })
+        } catch (error) {
+          return refuse(`The delivery intent could not be built: ${String(error)}`)
+        }
       try {
         store.transaction(() => {
           store.recordApproval({
-            id: `ap-${randomUUID()}`,
+            id: approvalId,
             workOrderId: id,
             bundleDigest,
             candidateDigest: candidate.digest,
             decision: "approved",
-            decidedBy: options.actor ?? "operator",
-            decidedAt: iso(),
+            decidedBy,
+            decidedAt,
             expiresAt: new Date(since + ttl).toISOString(),
           })
-          transition(id, "approve", {}, { bundleDigest, operationKey: key })
+          if (intent === undefined) {
+            transition(id, "approve", {}, { bundleDigest, operationKey: key })
+            return
+          }
+          // The one authorization to publish (rung 4 §5.1): the intent commits with the
+          // approval and the transition, or none of them does.
+          outbox.insert({
+            operationKey: deliveryOperationKey(id, bundleDigest),
+            approvalId,
+            intent,
+            now: decidedAt,
+          })
+          transition(id, "approve_delivery", {}, { bundleDigest, operationKey: key })
         })
```

(e) Right after that `try … catch`, before `let path: string` (the export), the delivery's outcome (D23):

```ts
      if (intent !== undefined) {
        await startDelivery(id)
        const final = mustGet(id)
        const delivered = store.delivery(id)
        return finish(key, {
          ok: final.state === "delivered",
          state: final.state,
          message:
            final.state === "delivered"
              ? `Delivered as ${delivered?.receiptPath ?? "a draft pull request"}`
              : final.state === "blocked"
                ? `Approved; delivery blocked: ${final.blockedReason}. pnpm factory events ${id}`
                : `Approved; delivery stopped with the work order ${final.state}`,
        })
      }
```

- [ ] **Step 5: Reconcile continues a delivery (D19) and counts `delivered` as settled**

```diff
diff --git a/examples/software-factory/controller/src/lib/controller/reconcile.ts b/examples/software-factory/controller/src/lib/controller/reconcile.ts
index c9c93bcc0..eb24ad422 100644
--- a/examples/software-factory/controller/src/lib/controller/reconcile.ts
+++ b/examples/software-factory/controller/src/lib/controller/reconcile.ts
@@ -126,7 +126,12 @@ async function settleIncompleteDispatch(
  */
 function settledOk(row: WorkOrderRow): boolean {
   if (row.state === "blocked") return row.blockedReason === "budget_exhausted"
-  return row.state === "exported" || row.state === "cancelled" || row.state === "denied"
+  return (
+    row.state === "exported" ||
+    row.state === "delivered" ||
+    row.state === "cancelled" ||
+    row.state === "denied"
+  )
 }
 
 /** Journal a reconciliation note that must never itself abort the walk. */
@@ -226,6 +231,12 @@ export async function reconcileWorkOrder(
       return reconcileVerifying(ctx, row)
     case "exporting":
       return reconcileExporting(ctx, row)
+    case "delivering":
+      // Unlike an export, a delivery continues (rung 4 §5.4): the outbox intent is the
+      // authorization, and every step reads the remote before it writes. Started, not
+      // awaited: a boot reconcile under `factory up` is bounded, and GitHub may be slow.
+      if (!ctx.isTracked(row.id)) void ctx.startDelivery(row.id)
+      return
     case "cancel_requested":
       await ctx.finishCancel(id, row.blockedReason === "budget_exhausted" ? "budget" : "operator")
       return
```

- [ ] **Step 6: Run the tests, the approve and reconcile suites**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/factory-delivery.test.ts test/factory-approve.test.ts test/factory-reconcile.test.ts test/factory-cancel.test.ts`
Expected: PASS (`factory-delivery.test.ts`: 9). The "resumes … at boot" case closes the factory while the worker waits out a 502 on `createBranch`, reopens it, and the boot reconcile delivers with one pull request.

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write src/lib/controller/factory.ts src/lib/controller/context.ts src/lib/controller/reconcile.ts test/factory-delivery.test.ts
git add src/lib/controller/factory.ts src/lib/controller/context.ts src/lib/controller/reconcile.ts test/factory-delivery.test.ts
git commit -m "feat(software-factory): approving a draft-PR bundle commits the outbox intent and delivers; reconcile resumes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: `redeliver`

**Files:**
- Modify: `src/lib/domain/work-order.ts` (`COMMANDS`), `src/lib/controller/factory.ts`, `src/lib/routes/input.ts`, `src/lib/client.ts`
- Create: `src/app/work-orders/redeliver/index.ts`
- Test: `test/factory-delivery.test.ts` (append the `describe("redeliver", …)` block from the full file in Task 12)

- [ ] **Step 1: Append the failing tests and run them** (three: a healable block redelivered; a destination other than the approved one refused after a restart, D27; a base conflict not redeliverable)

Run: `pnpm exec vitest run test/factory-delivery.test.ts -t redeliver`
Expected: FAIL, `factory.redeliver is not a function`.

- [ ] **Step 2: The command name.** In `src/lib/domain/work-order.ts`, `COMMANDS` gains `"redeliver"` after `"cancel"`.

- [ ] **Step 3: The factory.** Import `REDELIVERABLE_BLOCKED_REASONS` beside `RETRYABLE_BLOCKED_REASONS` from `../domain/states.js`. In `FactoryOptions`, after `delivery?`:

```ts
  /** How long after its approval a blocked delivery may be redelivered. Default 24 hours. */
  readonly redeliverWindowMs?: number
```

In `Factory`, after `deny(…)`:

```ts
  /**
   * Resume a draft-PR delivery a block the world can heal stopped (`delivery_unauthorized`,
   * `delivery_rate_limited`, `delivery_unconfirmed`), under the approval already given, at the
   * revision and bundle digest the caller displayed, within a day of that approval.
   */
  redeliver(
    id: string,
    input: { revision: number; bundleDigest: string; operationKey?: string },
  ): Promise<CommandOutcome>
```

and in the returned object, before `async cancel(`:

```ts
    async redeliver(id, { revision, bundleDigest, operationKey }) {
      const row = mustGet(id)
      const key = operationKey ?? `redeliver:${id}:${revision}:${bundleDigest}`
      const begun = commands.begin(
        key,
        id,
        { command: "redeliver", args: { revision, bundleDigest } },
        iso(),
      )
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      const refuse = (message: string) =>
        finish(key, { ok: false, state: mustGet(id).state, message })
      if (row.state !== "blocked" || row.blockedReason === null)
        return refuse(`Cannot redeliver from ${row.state}`)
      if (!REDELIVERABLE_BLOCKED_REASONS.has(row.blockedReason))
        return refuse(
          `Cannot redeliver a work order blocked by ${row.blockedReason}: waiting does not heal it; cancel it and run the issue again with --new`,
        )
      if (row.revision !== revision)
        return refuse(`Stale revision ${revision}; work order is at ${row.revision}`)
      if (row.bundleDigest !== bundleDigest)
        return refuse("Bundle digest does not match the approved bundle")
      const approval = store
        .approvals(id)
        .find((a) => a.decision === "approved" && a.bundleDigest === bundleDigest)
      const intent = outbox.get(id)
      if (approval === undefined || intent === null)
        return refuse("Nothing was approved for delivery on this work order")
      const window = options.redeliverWindowMs ?? 86_400_000
      if (now() > Date.parse(approval.decidedAt) + window)
        return refuse(
          `The approval is from ${approval.decidedAt}, more than ${window / 3_600_000} hours ago; cancel it and run the issue again with --new`,
        )
      try {
        transition(
          id,
          "redeliver",
          { blockedReason: null },
          { operationKey: key, previousBlockedReason: row.blockedReason, step: intent.step },
        )
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error
        return refuse("Work order changed state while redelivering")
      }
      await startDelivery(id)
      const final = mustGet(id)
      return finish(key, {
        ok: final.state === "delivered",
        state: final.state,
        message:
          final.state === "delivered"
            ? `Delivered as ${store.delivery(id)?.receiptPath ?? "a draft pull request"}`
            : `Delivery ${final.state === "blocked" ? `blocked again: ${final.blockedReason}` : `stopped; work order is ${final.state}`}`,
      })
    },

```

- [ ] **Step 4: The route, its input and the client.** `src/lib/routes/input.ts`, before `ReconcileInput`:

```ts
/** A delivery resumed under the approval already given (rung 4 §4): what the caller displayed. */
export const RedeliverInput = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    bundleDigest: z.string().regex(DIGEST_PATTERN),
    operationKey: z.string().min(1).optional(),
  })
  .strict()
```

`examples/software-factory/controller/src/app/work-orders/redeliver/index.ts`:

```ts
import { RedeliverInput } from "../../../lib/routes/input.js"
import { command } from "../../../lib/routes/outcome.js"
import { controllerRuntime } from "../../../lib/runtime.js"

/**
 * Resumes a draft-PR delivery a healable block stopped (rung 4 §4), under the approval already
 * given. Runs on the work order's own thread and awaits the worker, as approve does.
 */
export async function workflow(input: unknown) {
  return command(
    RedeliverInput,
    input,
    () => controllerRuntime().factory(),
    async ({ id, revision, bundleDigest, operationKey }, factory) => {
      const outcome = await factory.redeliver(id, {
        revision,
        bundleDigest,
        ...(operationKey ? { operationKey } : {}),
      })
      return { ...outcome, row: factory.show(id) }
    },
  )
}
```

`src/lib/client.ts`, before `deny:`:

```ts
    /** Resumes a healable delivery block; awaits the worker, as approve does. */
    redeliver: (
      id: string,
      input: { revision: number; bundleDigest: string; operationKey?: string },
    ) => run(id, "/work-orders/redeliver#workflow", { id, ...input }),
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/factory-delivery.test.ts test/commands.test.ts`
Expected: PASS (`factory-delivery.test.ts`: 12).

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write src/lib/domain/work-order.ts src/lib/controller/factory.ts src/lib/routes/input.ts src/lib/client.ts src/app/work-orders/redeliver/index.ts test/factory-delivery.test.ts
git add src/lib/domain/work-order.ts src/lib/controller/factory.ts src/lib/routes/input.ts src/lib/client.ts src/app/work-orders/redeliver/index.ts test/factory-delivery.test.ts
git commit -m "feat(software-factory): redeliver a healable delivery block under the approval already given

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed (Tasks 12-14, with the review fixes of 2026-10-01).** Task 12's `buildDeliveryIntent` checks each workspace path and each joined repository path with `relativePath` (the outbox schema requires canonical paths), and intake refuses a redraft whose target root differs from a draft-PR row's already-set `pathPrefix`. Task 13's approve calls `outbox.insert` without an operation key (Task 11's fix derives it). A review of the approval and delivery start path found these; each is fixed test-first in `test/factory-delivery.test.ts` ("the approval's start path"):

- **The `approve_delivery` transition commits before `outbox.insert`.** Two approvals under different keys could both pass the checks during the re-verification; the second then threw the outbox's `UNIQUE` constraint, left its key in flight and answered the route with a 500. It is now refused as an illegal move ("Work order changed state while approving"), its key answered, one pull request.
- **An approve interrupted by a close is answered by the delivery, not by the boot.** Boot reconcile's first loop no longer completes the `approve` or `redeliver` key that committed a row still `delivering` (`deliveryCommandKey`, read from the last `approve_delivery` or `redeliver` transition); when a delivery settles with the row out of `delivering` (or `startDelivery` blocks it `delivery_unauthorized`), `settleDeliveryCommand` answers that key with `deliveryOutcome`, the one D23 mapping `approve`, `redeliver` and this completion share. An approve or redeliver whose controller closed under it throws a clear error (the row stays `delivering`; a restart or `pnpm factory reconcile <id>` resumes it; replay the command) instead of failing on a closed registry, and the replay returns the resumed delivery's answer. Before, the replay returned "Reconciled after restart; work order is delivering" forever. Covering `redeliver` keys too goes beyond the review, which named `approve`: the same defect applied to them.
- **The intent is validated inside `buildDeliveryIntent`** (`DeliveryIntentSchema.parse`), so an invalid field (an empty actor) is a refusal, not a `ZodError` from inside the transaction with the key in flight.
- **Protected paths are checked against the approved bytes' paths** (`Object.keys(changes)`) as well as the candidate record's `changedPaths`.
- **The intent's issue number is the frozen origin's**, not the row's (they are checked equal).
- **The message for a delivery that stopped with the row `delivering`** says a restart or `pnpm factory reconcile <id>` resumes it.
- **`track()` still replaces a live entry**, now documented: a tracked run reconciling itself (`fromTrackedRun`) hands off to its reattached observer that way, so a throw would break it.
- **Tests added for gaps:** approve's protected-path refusal; a row delivery that no longer matches the frozen one; a spec edited after the freeze (D18); a cancel mid-delivery ends `cancelled` with no pull request (D24), the approve answering `ok: false` once its worker stops; a cancel during the re-verification leaves no outbox row.

### Task 15: The CLI: `--deliver`, the review's delivery block, `redeliver`, `show`, `list`, `run`

**Files:**
- Modify: `src/lib/intake/issue.ts`, `src/lib/registry/reader.ts` (`outbox()`), `src/lib/review/operator-review.ts`, `src/cli.ts`
- Test: `test/intake-issue.test.ts`, `test/operator-review.test.ts`, `test/cli.test.ts`, `test/run-steps.test.ts` (the source pin)

- [ ] **Step 1: Write the failing tests**

```diff
diff --git a/examples/software-factory/controller/test/intake-issue.test.ts b/examples/software-factory/controller/test/intake-issue.test.ts
index 318156fda..063fdcbe4 100644
--- a/examples/software-factory/controller/test/intake-issue.test.ts
+++ b/examples/software-factory/controller/test/intake-issue.test.ts
@@ -57,6 +57,22 @@ describe("fetchIssue", () => {
     ])
   })
 
+  it("reads the issue's state only when asked, and refuses an answer without one", async () => {
+    const { exec, calls } = scripted([JSON.stringify({ ...ISSUE, state: "CLOSED" })])
+    const issue = await fetchIssue({
+      repository: "cacheplane/b4run",
+      number: 778,
+      exec,
+      withState: true,
+    })
+    expect(issue.state).toBe("closed")
+    expect(calls[0]?.args.at(-1)).toBe("title,body,url,state")
+    const { exec: stateless } = scripted([JSON.stringify(ISSUE)])
+    await expect(
+      fetchIssue({ repository: "cacheplane/b4run", number: 778, exec: stateless, withState: true }),
+    ).rejects.toThrow(/has no state/)
+  })
+
   it("runs the gh the caller names", async () => {
     const { exec, calls } = scripted([JSON.stringify(ISSUE)])
     await fetchIssue({ repository: "cacheplane/b4run", number: 778, gh: "/opt/bin/gh", exec })
```

```diff
diff --git a/examples/software-factory/controller/test/operator-review.test.ts b/examples/software-factory/controller/test/operator-review.test.ts
index 8da72012b..a1d49fc35 100644
--- a/examples/software-factory/controller/test/operator-review.test.ts
+++ b/examples/software-factory/controller/test/operator-review.test.ts
@@ -218,3 +218,60 @@ describe("relativePath", () => {
       expect(relativePath.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
   })
 })
+
+describe("exportReview of a draft-PR bundle (rung 4)", () => {
+  it("says where approving publishes, above the diff, from the payload the digest covers", async () => {
+    const receipt: Receipt = { ...(await oracle("ok\n")), id: "rc-pass", verdict: "pass" }
+    receipt.checks[0] = { ...receipt.checks[0], verdict: "pass" } as Receipt["checks"][number]
+    const bundle = freezeBundle({
+      workOrderId: ID,
+      repositoryId: ID,
+      baselineDigest: "1".repeat(64),
+      specificationDigest: "2".repeat(64),
+      policyDigest: "b".repeat(64),
+      candidateDigest: "a".repeat(64),
+      receipt,
+      destinationId: "/exports",
+      frozenAt: "2026-10-01T00:00:00.000Z",
+      origin: {
+        kind: "issue",
+        repository: "cacheplane/b4run",
+        number: 912,
+        bodyDigest: "0".repeat(64),
+      },
+      pin: "7".repeat(40),
+      taskDigest: "d".repeat(64),
+      oracleReceiptId: null,
+      delivery: {
+        repository: "cacheplane/b4run",
+        baseBranch: "main",
+        branch: `factory/${ID}`,
+        pathPrefix: ".",
+        issueStateAtCreate: "open",
+      },
+    })
+    const artifact = await artifacts.put(JSON.stringify({ "src/cli.ts": "fixed\n" }))
+    const review = await exportReview({
+      candidate: {
+        digest: "a".repeat(64),
+        workOrderId: ID,
+        baselineDigest: "1".repeat(64),
+        changedPaths: ["src/cli.ts"],
+        bytes: 6,
+        artifactDigest: artifact.digest,
+        assembledAt: "2026-10-01T00:00:00.000Z",
+      },
+      receipt,
+      bundle,
+      artifacts,
+      row: rowOf({ state: "awaiting_approval", bundleDigest: bundle.digest }),
+    })
+    expect(review.problems).toEqual([])
+    expect(review.publishes).toBe(
+      `Approving publishes exactly this change as a draft pull request on cacheplane/b4run, branch factory/${ID}, against main, branched at ${"7".repeat(40)}`,
+    )
+    const delivery = review.text.indexOf("==> Delivery")
+    expect(delivery).toBeGreaterThan(0)
+    expect(delivery).toBeLessThan(review.text.indexOf("src/cli.ts"))
+  })
+})
```

```diff
diff --git a/examples/software-factory/controller/test/cli.test.ts b/examples/software-factory/controller/test/cli.test.ts
index 2b9683043..503bff502 100644
--- a/examples/software-factory/controller/test/cli.test.ts
+++ b/examples/software-factory/controller/test/cli.test.ts
@@ -20,6 +20,7 @@ import { BuilderHandoffSchema } from "../src/lib/builder-handoff.ts"
 import { openRegistryReader } from "../src/lib/registry/reader.ts"
 import { loadTask, loadTaskRecipe, tasksDir } from "../src/lib/targets/catalog.ts"
 import { openImageRegistry } from "../src/lib/targets/images.ts"
+import { createFakeGitHub } from "./fake-delivery-adapter.ts"
 import { fakeImageBuilder } from "./fake-image-builder.ts"
 import { createFakeVerifier } from "./fake-verifier.ts"
 import { BAD_DRAFTS, GOOD_DRAFT } from "./intake-fixtures.ts"
@@ -347,7 +348,7 @@ describe("cli", () => {
   }, 90_000)
 
   /** A `gh` that answers `issue view` with a fixed issue and refuses everything else. */
-  function stubGh(issue: { title: string; body: string; url: string }): string {
+  function stubGh(issue: { title: string; body: string; url: string; state?: string }): string {
     const path = join(dir, "gh")
     writeFileSync(
       path,
@@ -423,6 +424,58 @@ esac
     expect(notANumber.stderr).toContain("positive integer")
   }, 90_000)
 
+  it("creates a draft-PR work order with --deliver, and refuses what cannot be delivered", async () => {
+    const github = createFakeGitHub()
+    const { env } = await boot(
+      {},
+      {
+        delivery: {
+          draftPr: { repository: "cacheplane/b4run", baseBranch: "main", adapter: github },
+        },
+      },
+    )
+    const gh = stubGh({
+      title: "Fix the flag",
+      body: "Body\n",
+      url: "https://github.com/x/778",
+      state: "OPEN",
+    })
+    const { root } = await localRepo()
+    const issueEnv = { ...env, FACTORY_GH: gh, FACTORY_REPO_ROOT: root }
+    const create = (...args: string[]) =>
+      run(process.execPath, [tsxBin, cliEntry, "create", ...args], {
+        env: issueEnv,
+        cwd: packageRoot,
+      })
+    const created = JSON.parse(
+      (await create("--issue", "778", "--repo", "cacheplane/b4run", "--deliver", "draft-pr"))
+        .stdout,
+    )
+    expect(created).toMatchObject({ ok: true, state: "received" })
+    expect(created.row.delivery).toEqual({
+      kind: "draft-pr",
+      repository: "cacheplane/b4run",
+      baseBranch: "main",
+      branch: `factory/${created.row.id}`,
+      pathPrefix: null,
+      issueStateAtCreate: "open",
+    })
+    const catalog = await failing(create("--task", "cli-flags", "--deliver", "draft-pr"))
+    expect(catalog.stderr).toContain("is for issue work orders")
+    const bogus = await failing(create("--issue", "778", "--deliver", "pr"))
+    expect(bogus.stderr).toContain("--deliver takes local or draft-pr")
+    const elsewhere = await failing(
+      create("--issue", "778", "--repo", "someone/else", "--deliver", "draft-pr", "--key", "x"),
+    )
+    expect(JSON.parse(elsewhere.stdout)).toMatchObject({
+      ok: false,
+      refusal: "delivery_unavailable",
+      message: expect.stringContaining("not someone/else"),
+    })
+    // Nothing reached GitHub: create only records where the bundle will go.
+    expect(github.calls).toEqual([])
+  }, 90_000)
+
   it("replays an issue at --pin without consulting origin/main", async () => {
     const { env } = await boot()
     const gh = stubGh({ title: "Fix the flag", body: "Body\n", url: "https://github.com/x/778" })
```

and in `test/run-steps.test.ts` the source pin (Trap 11):

```diff
-  /\.(approve|deny|rejectIntake|cancel|interrupt)\b/,
+  // Rung 4: run never redelivers either; a person does, with the digest's prefix.
+  /\.(approve|deny|rejectIntake|cancel|interrupt|redeliver)\b/,
```

```diff
     "createRacing",
+    "deliverOption",
     "finish",
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run test/intake-issue.test.ts test/operator-review.test.ts test/run-steps.test.ts && pnpm exec vitest run test/cli.test.ts -t "draft-PR work order"`
Expected: FAIL: `withState` is ignored; `publishes` is undefined; the pin lists a helper `run` does not reach yet; the CLI refuses `--deliver` as an unknown option.

- [ ] **Step 3: The issue's state, only when asked**

```diff
diff --git a/examples/software-factory/controller/src/lib/intake/issue.ts b/examples/software-factory/controller/src/lib/intake/issue.ts
index b3f5b5323..aa54e5d27 100644
--- a/examples/software-factory/controller/src/lib/intake/issue.ts
+++ b/examples/software-factory/controller/src/lib/intake/issue.ts
@@ -42,7 +42,12 @@ export function failureText(error: unknown): string {
   return detail ? detail.slice(2) : error.message
 }
 
-const GhIssueSchema = z.object({ title: z.string(), body: z.string(), url: z.string() })
+const GhIssueSchema = z.object({
+  title: z.string(),
+  body: z.string(),
+  url: z.string(),
+  state: z.enum(["OPEN", "CLOSED"]).optional(),
+})
 
 export interface FetchedIssue {
   readonly title: string
@@ -50,6 +55,8 @@ export interface FetchedIssue {
   readonly url: string
   /** sha256 of `title\nbody`: what `origin.bodyDigest` records, so an edited issue is detectable. */
   readonly bodyDigest: string
+  /** Read only when asked (`withState`): a draft-PR work order records it (rung 4 §3.2). */
+  readonly state?: "open" | "closed"
 }
 
 /** The digest `FetchedIssue.bodyDigest` carries. */
@@ -64,6 +71,8 @@ export async function fetchIssue(input: {
   /** The gh executable; the CLI passes `FACTORY_GH` so a test can stub it. */
   readonly gh?: string
   readonly exec?: Exec
+  /** Also read the issue's state, and refuse an answer without one. */
+  readonly withState?: boolean
 }): Promise<FetchedIssue> {
   const { repository, number } = input
   if (!REPOSITORY_PATTERN.test(repository))
@@ -81,7 +90,7 @@ export async function fetchIssue(input: {
       "--repo",
       repository,
       "--json",
-      "title,body,url",
+      input.withState === true ? "title,body,url,state" : "title,body,url",
     ]))
   } catch (error) {
     throw new Error(`gh issue view failed for ${ref}: ${failureText(error)}`)
@@ -97,8 +106,11 @@ export async function fetchIssue(input: {
     const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
     throw new Error(`gh issue view output for ${ref} is not an issue: ${issues.join("; ")}`)
   }
-  const { title, body, url } = parsed.data
-  return { title, body, url, bodyDigest: issueBodyDigest({ title, body }) }
+  const { title, body, url, state } = parsed.data
+  const issue = { title, body, url, bodyDigest: issueBodyDigest({ title, body }) }
+  if (input.withState !== true) return issue
+  if (state === undefined) throw new Error(`gh issue view output for ${ref} has no state`)
+  return { ...issue, state: state === "OPEN" ? "open" : "closed" }
 }
 
 /**
```

- [ ] **Step 4: The reader's `outbox()`.** In `src/lib/registry/reader.ts`: `import { createOutboxStore, type OutboxRow } from "../delivery/outbox.js"`; in `RegistryReader` after `delivery(…)`:

```ts
  /** The draft-PR outbox row: the approved intent and how far the worker got. */
  outbox(id: string): OutboxRow | null
```

after `const evidence = createEvidenceStore(db)`: `const outbox = createOutboxStore(db)`; and after `delivery: (id) => store.delivery(id),`: `outbox: (id) => outbox.get(id),`.

- [ ] **Step 5: The review names where approving publishes**

```diff
diff --git a/examples/software-factory/controller/src/lib/review/operator-review.ts b/examples/software-factory/controller/src/lib/review/operator-review.ts
index 0e9ff2170..75f26e321 100644
--- a/examples/software-factory/controller/src/lib/review/operator-review.ts
+++ b/examples/software-factory/controller/src/lib/review/operator-review.ts
@@ -34,6 +34,11 @@ export interface OperatorReview {
    * (`--allow-missing-evidence`): said loudly beside the prompt, never silently.
    */
   readonly warnings: readonly string[]
+  /**
+   * For a draft-PR bundle, what approving it does, in one line: the prompt names it. Absent for
+   * a local export and an intake review.
+   */
+  readonly publishes?: string
 }
 
 /**
@@ -349,6 +354,29 @@ export async function exportReview(input: {
   const problems: string[] = []
   const warnings: string[] = []
   let text = `Export review of ${row.id} (${row.state}, revision ${row.revision})\n\n`
+  // Where approving sends the change, above everything else (rung 4 §7.4). Read from the frozen
+  // payload, whose digest is the one the person types: the line cannot say one thing while the
+  // bundle authorizes another.
+  const frozen = bundle === null ? undefined : BundlePayloadSchema.safeParse(bundle.payload).data
+  const publishes =
+    frozen?.operation === "draft-pr"
+      ? `Approving publishes exactly this change as a draft pull request on ${frozen.delivery.repository}, branch ${frozen.delivery.branch}, against ${frozen.delivery.baseBranch}, branched at ${frozen.pin}`
+      : undefined
+  if (frozen?.operation === "draft-pr")
+    text += block(
+      "Delivery",
+      [
+        `operation   draft-pr`,
+        `repository  ${frozen.delivery.repository}`,
+        `branch      ${frozen.delivery.branch}`,
+        `base        ${frozen.delivery.baseBranch}`,
+        `pin         ${frozen.pin}`,
+        `paths under ${frozen.delivery.pathPrefix}`,
+        "",
+        `${publishes}.`,
+        "",
+      ].join("\n"),
+    )
   if (candidate === null) {
     problems.push("The work order has no assembled candidate")
     text += "--- Candidate: none recorded\n\n"
@@ -442,5 +470,6 @@ export async function exportReview(input: {
     text,
     problems,
     warnings,
+    ...(publishes !== undefined ? { publishes } : {}),
   }
 }
```

- [ ] **Step 6: The CLI**

```diff
diff --git a/examples/software-factory/controller/src/cli.ts b/examples/software-factory/controller/src/cli.ts
index 728075049..e40cc43f4 100644
--- a/examples/software-factory/controller/src/cli.ts
+++ b/examples/software-factory/controller/src/cli.ts
@@ -52,7 +52,7 @@ import { openImageRegistryReader, recipeTag } from "./lib/targets/images.js"
 const USAGE = `factory <command> [options]
 
   create    --task <id> [--key <operationKey>]
-  create    --issue <n> [--repo <owner/name>] [--pin <sha>] [--key <operationKey>]
+  create    --issue <n> [--repo <owner/name>] [--pin <sha>] [--deliver local|draft-pr] [--key <operationKey>]
   intake          <workOrderId> [--key <operationKey>]
   review    <workOrderId> [--allow-missing-evidence]        (asks for at least the digest's first 8 hex digits)
   review    <workOrderId> --approve --digest <sha256> [--allow-missing-evidence] [--key <operationKey>]
@@ -63,13 +63,14 @@ const USAGE = `factory <command> [options]
   retry     <workOrderId> [--key <operationKey>]
   approve   <workOrderId> --revision <n> --bundle <sha256> [--key <operationKey>]
   deny      <workOrderId> [--key <operationKey>]
+  redeliver <workOrderId> [--digest <sha256>] [--key <operationKey>]   (asks for the bundle digest's first 8 hex digits)
   cancel    <workOrderId> [--key <operationKey>]   (uses BOTH variables)
   reconcile
   show      <workOrderId>
   events    <workOrderId>
   evidence  <workOrderId>
   list
-  run       --issue <n> [--repo <owner/name>] [--pin <sha>] [--new] [--allow-missing-evidence]
+  run       --issue <n> [--repo <owner/name>] [--pin <sha>] [--deliver local|draft-pr] [--new] [--allow-missing-evidence]
   run       --task <id> [--new] [--allow-missing-evidence]
   run       <workOrderId> [--allow-missing-evidence]
   up        [--config <path>]
@@ -100,6 +101,14 @@ create --issue --pin <sha> replays the issue at that commit instead: origin/main
 fetched nor read. The pin is a full sha, or a short one the checkout resolves; a full sha not in
 the object store is fetched from origin by sha, unless FACTORY_NO_FETCH=1, which refuses it.
 
+create --deliver draft-pr (issue work orders only) makes approving the bundle publish exactly
+that change as a draft pull request on the issue's repository, from branch factory/<id>, instead
+of exporting it; the default, local, is the export. The choice is fixed at create and frozen into
+the bundle the person approves. The controller must be configured to deliver to that repository.
+redeliver resumes a delivery blocked by delivery_unauthorized, delivery_rate_limited or
+delivery_unconfirmed, under the approval already given, within a day of it; every other delivery
+block needs a new work order.
+
 intake runs the drafter turn and the oracle proof and waits for them, like dispatch. The draft
 it parks is a task directory under <FACTORY_STATE_DIR>/tasks/<workOrderId>/ (task.json, spec.md,
 checks.json, checks/, issue.md).
@@ -301,8 +310,12 @@ const INTAKE_ACTIVE: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>(["int
 const APPROVE_ACTIVE: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
   "awaiting_approval",
   "exporting",
+  "delivering",
+])
+const APPROVE_SUCCESS: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
+  "exported",
+  "delivered",
 ])
-const APPROVE_SUCCESS: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>(["exported"])
 /** The states an awaited `dispatch` is still working in: the builder's turn and verification. */
 const DISPATCH_ACTIVE: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
   "dispatched",
@@ -597,6 +610,7 @@ async function issueCreateInput(
   issueArg: string,
   repo: string | undefined,
   pinArg: string | undefined,
+  deliver: Deliver = "local",
 ) {
   const number = Number(issueArg)
   if (!/^\d+$/.test(issueArg) || !Number.isInteger(number) || number <= 0)
@@ -607,7 +621,8 @@ async function issueCreateInput(
   const gh = process.env.FACTORY_GH ?? "gh"
   const fetch = process.env.FACTORY_NO_FETCH !== "1"
   const replayPin = pinArg !== undefined ? await replayPinOf(root, pinArg) : undefined
-  const issue = await fetchIssue({ repository, number, gh })
+  // A draft PR records whether the issue was open at create (rung 4 §15 item 3).
+  const issue = await fetchIssue({ repository, number, gh, withState: deliver === "draft-pr" })
   let pin: string
   if (replayPin !== undefined) {
     // A replay: the commit is named, so origin/main is never consulted. A full sha missing from
@@ -620,10 +635,24 @@ async function issueCreateInput(
   return {
     origin: { kind: "issue" as const, repository, number, bodyDigest: issue.bodyDigest },
     pin,
-    issue: { title: issue.title, body: issue.body },
+    issue: {
+      title: issue.title,
+      body: issue.body,
+      ...(issue.state !== undefined ? { state: issue.state } : {}),
+    },
+    ...(deliver === "draft-pr" ? { deliver } : {}),
   }
 }
 
+type Deliver = "local" | "draft-pr"
+
+/** `--deliver`, checked: absent is undefined (each command says what that means). */
+function deliverOption(value: string | undefined): Deliver | undefined {
+  if (value === undefined) return undefined
+  if (value === "local" || value === "draft-pr") return value
+  throw new Error(`--deliver takes local or draft-pr, got ${JSON.stringify(value)}`)
+}
+
 /**
  * The commit `--pin` names: a full sha as given (lowercased; `ensurePin` then finds or fetches
  * it), or a short one resolved in the checkout with `git rev-parse --verify`. A short sha
@@ -902,7 +931,7 @@ async function reviewOutcome(id: string, options: ReviewOptions): Promise<Review
         built.row,
       )
     const answer = await ask(
-      `Approve ${built.kind === "intake" ? "this draft" : "this export"} at revision ${built.revision}? Type at least the first eight hex digits of the ${built.label} (or paste all of it) to approve; anything else sends nothing: `,
+      `Approve ${built.kind === "intake" ? "this draft" : built.publishes !== undefined ? "publishing this as a draft pull request" : "this export"} at revision ${built.revision}? Type at least the first eight hex digits of the ${built.label} (or paste all of it) to approve; anything else sends nothing: `,
     )
     if (answer === null)
       return declined("No answer: stdin ended before one was typed; nothing was sent", built.row)
@@ -935,6 +964,72 @@ async function reviewOutcome(id: string, options: ReviewOptions): Promise<Review
   return { kind: "sent", outcome, code: outcome.ok ? 0 : 1 }
 }
 
+/**
+ * `factory redeliver <id>`: resume a delivery a healable block stopped, under the approval
+ * already given (rung 4 §4, §15 item 7). It shows what the resumed delivery will publish and,
+ * like a review, takes the bundle digest's prefix typed at a terminal (or `--digest` in full):
+ * a resumed delivery is another round of remote writes, and a person says so.
+ */
+async function redeliver(
+  id: string,
+  options: { readonly digest: string | undefined; readonly key: string | undefined },
+): Promise<number> {
+  const { row, outbox } = read((reader) => ({ row: reader.show(id), outbox: reader.outbox(id) }))
+  if (!row) throw new Error(`Unknown work order ${id}`)
+  const refuse = (message: string) => {
+    print({ ok: false, state: row.state, message, row })
+    return 1
+  }
+  if (row.state !== "blocked" || outbox === null || row.bundleDigest === null)
+    return refuse(
+      `Nothing to redeliver: ${id} is ${row.state}${row.blockedReason ? ` (${row.blockedReason})` : ""}`,
+    )
+  const { intent } = outbox
+  process.stderr.write(
+    [
+      `Redeliver ${id} (blocked by ${row.blockedReason}, revision ${row.revision})`,
+      `  ${intent.repository}: branch ${intent.branch} against ${intent.baseBranch}, branched at ${intent.pin}`,
+      `  approved ${intent.approvedAt} by ${intent.decidedBy}; the worker stopped after step ${outbox.step}`,
+      `  last error: ${outbox.lastError ?? "none recorded"}`,
+      `  bundle digest: ${row.bundleDigest}`,
+      "Redelivering resumes the approved delivery; it approves nothing new.",
+      "",
+    ].join("\n"),
+  )
+  if (options.digest !== undefined) {
+    if (options.digest !== row.bundleDigest)
+      return refuse(
+        `--digest ${options.digest} is not the bundle digest shown above; nothing was sent`,
+      )
+  } else {
+    if (!interactive())
+      return refuse(
+        "There is no terminal to type the bundle digest's prefix into; pass --digest <sha256> with the digest shown above",
+      )
+    const answer = (
+      (await ask("Type at least the first eight hex digits of the bundle digest to redeliver: ")) ??
+      ""
+    )
+      .trim()
+      .toLowerCase()
+    if (!(/^[0-9a-f]{8,64}$/.test(answer) && row.bundleDigest.startsWith(answer)))
+      return refuse("The typed prefix does not match the bundle digest shown; nothing was sent")
+  }
+  const outcome = await awaiting(
+    id,
+    (controller) =>
+      controller.redeliver(id, {
+        revision: row.revision,
+        bundleDigest: row.bundleDigest as string,
+        ...(options.key ? { operationKey: options.key } : {}),
+      }),
+    new Set<WorkOrderState>(["delivering"]),
+    new Set<WorkOrderState>(["delivered"]),
+  )
+  print(outcome)
+  return outcome.ok ? 0 : 1
+}
+
 function nothingToReview(id: string, row: WorkOrderRow): string {
   return `Nothing to review: ${id} is ${row.state}. review reads a draft parked in awaiting_intake_approval or a bundle parked in awaiting_approval`
 }
@@ -980,6 +1075,8 @@ async function runWorkOrder(options: {
   readonly repo: string | undefined
   readonly pin: string | undefined
   readonly fresh: boolean
+  /** `--deliver`: undefined resumes whatever delivery the work order was created with. */
+  readonly deliver: Deliver | undefined
 }): Promise<string | { readonly outcome: unknown; readonly code: number }> {
   const rows = listRows()
   let matching: WorkOrderRow[]
@@ -1006,7 +1103,7 @@ async function runWorkOrder(options: {
     let fetched: Awaited<ReturnType<typeof issueCreateInput>> | undefined
     create = async () => {
       // Fetched once: a create retried after a racing run's (below) sends the same input.
-      fetched ??= await issueCreateInput(issueArg, repository, options.pin)
+      fetched ??= await issueCreateInput(issueArg, repository, options.pin, options.deliver)
       const input = fetched
       const generation = rows.filter((r) => sameIssue(r) && r.pin === input.pin).length
       return client().create({
@@ -1016,6 +1113,22 @@ async function runWorkOrder(options: {
     }
   }
   const choice = chooseWorkOrder(matching, options.fresh)
+  // A work order delivers the way it was created to (rung 4 §3.1): run resumes it only when
+  // --deliver says the same or nothing, and otherwise says so rather than switch it.
+  if (
+    (choice.kind === "resume" || choice.kind === "done") &&
+    options.deliver !== undefined &&
+    choice.row.delivery.kind !== options.deliver
+  )
+    return {
+      code: 1,
+      outcome: {
+        ok: false,
+        state: choice.row.state,
+        message: `${choice.row.id} was created to deliver ${choice.row.delivery.kind}, not ${options.deliver}; run it without --deliver, or add --new to start another`,
+        row: choice.row,
+      },
+    }
   switch (choice.kind) {
     case "resume":
       process.stderr.write(
@@ -1028,7 +1141,7 @@ async function runWorkOrder(options: {
         outcome: {
           ok: true,
           state: choice.row.state,
-          message: `Already exported as ${choice.row.id}; --new starts another`,
+          message: `Already ${choice.row.state} as ${choice.row.id}; --new starts another`,
           row: choice.row,
         },
       }
@@ -1208,6 +1321,7 @@ async function runCommand(
     readonly pin?: string | undefined
     readonly new: boolean
     readonly "allow-missing-evidence": boolean
+    readonly deliver?: string | undefined
   } & Readonly<
     Partial<Record<(typeof RUN_REFUSES)[number] | (typeof RUN_IGNORES)[number], unknown>>
   >,
@@ -1246,6 +1360,9 @@ async function runCommand(
     throw new Error("run --repo names an issue's repository: it takes --issue")
   if (values.new && id !== undefined)
     throw new Error("run --new starts a new work order: it takes --issue or --task, not an id")
+  const deliver = deliverOption(values.deliver)
+  if (deliver !== undefined && values.issue === undefined)
+    throw new Error("run --deliver chooses an issue work order's delivery: it takes --issue")
   // Ctrl-C ends the following, never the work: the controller carries on without this process.
   // Installed before anything is asked or sent, so an early Ctrl-C also says how to resume;
   // without --new, which would start yet another work order.
@@ -1270,6 +1387,7 @@ async function runCommand(
       repo: values.repo,
       pin: values.pin,
       fresh: values.new,
+      deliver,
     }))
   if (typeof chosen !== "string") return finish(chosen.outcome, chosen.code)
   following = chosen
@@ -1291,11 +1409,20 @@ async function runCommand(
     const unmoved = () => read((reader) => reader.show(workOrder))?.revision === row.revision
     try {
       switch (step.kind) {
-        case "done":
+        case "done": {
+          const url = read((reader) => reader.delivery(workOrder))?.pullRequest?.url
           return finish(
-            { ok: true, state: row.state, message: `Exported under ${row.bundleDigest}`, row },
+            {
+              ok: true,
+              state: row.state,
+              message:
+                url !== undefined ? `Delivered as ${url}` : `Exported under ${row.bundleDigest}`,
+              row,
+              ...(url !== undefined ? { pullRequest: url } : {}),
+            },
             0,
           )
+        }
         case "stop":
           return finish(
             { ok: false, state: row.state, message: step.message, next: step.next, row },
@@ -1455,6 +1582,7 @@ async function main(argv: string[]): Promise<number> {
       "work-order": { type: "string" },
       "image-id": { type: "string" },
       config: { type: "string" },
+      deliver: { type: "string" },
       approve: { type: "boolean", default: false },
       reject: { type: "boolean", default: false },
       "allow-missing-evidence": { type: "boolean", default: false },
@@ -1551,11 +1679,16 @@ async function main(argv: string[]): Promise<number> {
               ? "create --pin replays an issue: it takes --issue, not --task (a catalog task's pin is its target's)"
               : "create --pin requires --issue",
           )
+        const deliver = deliverOption(values.deliver)
+        if (values.task && deliver === "draft-pr")
+          throw new Error(
+            "create --deliver draft-pr is for issue work orders: a catalog task reproduces a defect already fixed on main",
+          )
         const key = values.key ? { operationKey: values.key } : {}
         const input = values.task
           ? { taskId: values.task }
           : values.issue
-            ? await issueCreateInput(values.issue, values.repo, values.pin)
+            ? await issueCreateInput(values.issue, values.repo, values.pin, deliver)
             : null
         if (!input) throw new Error("create requires --task or --issue")
         const outcome = await client().create({ ...input, ...key })
@@ -1635,6 +1768,8 @@ async function main(argv: string[]): Promise<number> {
         print(outcome)
         return outcome.ok ? 0 : 1
       }
+      case "redeliver":
+        return await redeliver(needId(), { digest: values.digest, key: values.key })
       case "deny": {
         const outcome = await client().deny(needId(), values.key)
         print(outcome)
@@ -1648,9 +1783,13 @@ async function main(argv: string[]): Promise<number> {
         return outcome.ok ? 0 : 1
       }
       case "show": {
-        const row = read((reader) => reader.show(needId()))
+        const { row, receipt } = read((reader) => ({
+          row: reader.show(needId()),
+          receipt: reader.delivery(needId()),
+        }))
         if (!row) throw new Error(`Unknown work order ${id}`)
-        print(row)
+        // A delivered pull request is shown beside the row; an export's path stays in events.
+        print(receipt?.pullRequest ? { ...row, pullRequest: receipt.pullRequest } : row)
         return 0
       }
       case "events":
@@ -1660,7 +1799,14 @@ async function main(argv: string[]): Promise<number> {
         print(read((reader) => reader.evidence(needId())))
         return 0
       case "list":
-        print(read((reader) => reader.list()))
+        print(
+          read((reader) =>
+            reader.list().map((row) => {
+              const url = reader.delivery(row.id)?.pullRequest?.url
+              return url === undefined ? row : { ...row, pullRequest: url }
+            }),
+          ),
+        )
         return 0
       default:
         throw new Error(`Unknown command ${command}\n${USAGE}`)
```

- [ ] **Step 7: Run the tests and the whole CLI file**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/intake-issue.test.ts test/operator-review.test.ts test/run-steps.test.ts test/cli.test.ts`
Expected: PASS (`cli.test.ts` takes a few minutes; it spawns the CLI against a served controller).

- [ ] **Step 8: Commit**

```bash
pnpm exec biome check --write src/lib/intake/issue.ts src/lib/registry/reader.ts src/lib/review/operator-review.ts src/cli.ts test/intake-issue.test.ts test/operator-review.test.ts test/cli.test.ts test/run-steps.test.ts
git add src/lib/intake/issue.ts src/lib/registry/reader.ts src/lib/review/operator-review.ts src/cli.ts test/intake-issue.test.ts test/operator-review.test.ts test/cli.test.ts test/run-steps.test.ts
git commit -m "feat(software-factory): factory create and run --deliver draft-pr, redeliver, and the delivery in review, show and list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed (Task 15, `da927e77f`).** As planned, plus: the run source pin (`test/run-steps.test.ts` `FORBIDDEN`) forbids more than `.redeliver`: a bare `redeliver(` call (the CLI's own command function), the `work-orders/redeliver` route path, and any of the gated methods named by a computed member access (`client()["redeliver"](…)`). `test/cli.test.ts` gained a test the plan did not have, "redelivers only on the bundle digest a person types or names in full, and never otherwise", which serves the CLI against a delivery harness's registry; for it `test/delivery-harness.ts` exports `harnessDir()` (the open harness's directory, used as `FACTORY_STATE_DIR`). The CLI's `redeliver` shows its prompt for any `blocked` row that has an outbox row and a bundle digest, whatever the reason; the controller refuses a reason that is not healable (see the follow-ups).

### Task 16: Docs for PR 3, and the whole gate

**Files:**
- Modify: `examples/software-factory/README.md`, `docs/superpowers/specs/2026-10-01-software-factory-rung4-design.md`

- [ ] **Step 1: README.** Add a section "Delivering as a draft pull request (rung 4)" after the quickstart, saying, in this order: `create`/`run --issue <n> --deliver draft-pr` (issue work orders only; the default `local` is unchanged); that the choice is frozen into the bundle, so approving it publishes exactly that PR from `factory/<id>`, a draft, against `main`, branched at the pin, `Refs #<n>`, never closing the issue; the states `delivering` and `delivered` and the seven blocks with what to do about each (the table of spec §4, with `pnpm factory redeliver <id>` for the three healable ones and `run --issue <n> --new` for the rest); that `run` never approves or redelivers; that the factory never merges, marks ready, closes or pushes again, and what a person does with the PR (D11: adopt a change to a publishable package onto your own branch with a changeset, so `vercel-native` and `claude-review` run; merge an examples/docs/scripts-only change as is); and that in this build the controller has no delivery configured, so `--deliver draft-pr` is refused with `delivery_unavailable` until PR 4 (D20).

- [ ] **Step 2: Spec as-landed note.** Under §13, add "**As landed (PR 3).**" with this plan's link, Decisions D14, D18, D19, D21, D23, D24, and Spec corrections 2, 5, 6, 10, 12.

- [ ] **Step 3: The whole PR's gate** (from the repository root):

```bash
pnpm --filter @b4-example/software-factory-controller lint
pnpm --filter @b4-example/software-factory-controller typecheck
pnpm --filter @b4-example/software-factory-controller test
node scripts/check-docs.mjs
```

Expected: lint and typecheck clean; the unit suite green but for Trap 10 on a host without Docker; `check-docs` passes (the README is not in its scanned set, the spec is under `docs/superpowers/`, which it skips).

- [ ] **Step 4: Commit and open PR 3**

```bash
git add examples/software-factory/README.md docs/superpowers/specs/2026-10-01-software-factory-rung4-design.md
git commit -m "docs(software-factory): draft-PR delivery, and the rung 4 spec's as-landed note for PR 3

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed (Task 16).** The README section and the spec's §13 note as the steps say. The README section opens by saying delivery is not yet usable end to end (PR 3 runs only against the fake GitHub; the real adapter, token minting and `up`'s wiring arrive in PR 4; `--deliver draft-pr` is refused with `delivery_unavailable` until then), and documents, beyond Step 1's list, `run`'s refusal of a `--deliver` that differs from the work order's and `show`/`list`/`run` printing the pull request's URL. The spec note also says what PR 3 landed and that it is not yet usable end to end. This plan gained the as-landed notes for Tasks 15 and 16 and two follow-ups (an empty approval actor; the CLI's `redeliver` prompting for a non-healable block). The gate was run wider than Step 3: the controller's `lint` (254 files, clean), `typecheck` (clean) and `test` (1,288 passed, 1 failed: `test/runtime.test.ts` "dispatches to the one builder on its route, and refuses the retired variables", Trap 10, the Docker daemon not running on the host), the root `pnpm lint` (31 tasks), `node scripts/check-docs.mjs` (passed), `pnpm test:release-integrity` (33 passed) and `node --test scripts/release/test/workflow-contracts.test.mjs` (188 passed). The commit also carries this plan; PR 3 was not opened by it.

---

# PR 4: The GitHub adapter

Needs PR 3 merged (rebase onto it); the scratch lane (Task 21 Step 3) needs Task 4 Steps 1-5.

```bash
git fetch origin
git switch -c blove/factory-github-adapter origin/main
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@b4-example/software-factory-controller^...
cd examples/software-factory/controller
```

### Task 17: The app's JWT and key, and the one allow-listed request

**Files:**
- Create: `src/lib/delivery/github/jwt.ts`, `src/lib/delivery/github/http.ts`
- Test: `test/github-http.test.ts`

- [ ] **Step 1: Write the failing test** (spec §14: PATCH, PUT and DELETE refused on every path; dot, empty and encoded-separator segments refused (D28); another repository, a ref outside `factory/`, a ready or misdirected PR, any other write, any other GraphQL document, any other user; the JWT verified with the public key; the key read only from a private regular file and never quoted):

`examples/software-factory/controller/test/github-http.test.ts`:

```ts
import { generateKeyPairSync, verify } from "node:crypto"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  allowedRoute,
  CLOSING_ISSUES_QUERY,
  DisallowedRequestError,
} from "../src/lib/delivery/github/http.ts"
import { appJwt, loadAppPrivateKey } from "../src/lib/delivery/github/jwt.ts"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const target = { repository: "cacheplane/b4run", baseBranch: "main" }
const SHA = "a".repeat(40)
const BRANCH = "factory/wo-0123456789abcdef"

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("the allow-list", () => {
  it("refuses PATCH, PUT and DELETE on every path, before any socket opens", () => {
    const paths = [
      "/repos/cacheplane/b4run/git/refs/heads/factory/wo-0123456789abcdef",
      "/repos/cacheplane/b4run/pulls/1",
      "/repos/cacheplane/b4run/pulls/1/merge",
      "/repos/cacheplane/b4run/issues/1",
      "/repos/cacheplane/b4run/releases/1",
      "/repos/cacheplane/b4run",
    ]
    for (const method of ["PATCH", "PUT", "DELETE"])
      for (const path of paths)
        expect(() => allowedRoute(method, path, {}, target)).toThrow(DisallowedRequestError)
  })

  it("refuses another repository, a ref outside factory/, a ready or misdirected PR, and any other write", () => {
    const refuse = (method: string, path: string, body?: unknown) =>
      expect(() => allowedRoute(method, path, body, target)).toThrow(DisallowedRequestError)
    refuse("GET", `/repos/cacheplane/other/git/commits/${SHA}`)
    refuse("GET", "/repos/cacheplane/b4run-fork/pulls/1")
    refuse("POST", "/repos/cacheplane/b4run/git/refs", { ref: "refs/heads/main", sha: SHA })
    refuse("POST", "/repos/cacheplane/b4run/git/refs", { ref: "refs/tags/v1", sha: SHA })
    refuse("POST", "/repos/cacheplane/b4run/git/refs", { ref: "refs/heads/factory/x", sha: SHA })
    const pull = {
      head: "factory/wo-0123456789abcdef",
      base: "main",
      draft: true,
      title: "t",
      body: "b",
    }
    refuse("POST", "/repos/cacheplane/b4run/pulls", { ...pull, draft: false })
    refuse("POST", "/repos/cacheplane/b4run/pulls", { ...pull, base: "release" })
    refuse("POST", "/repos/cacheplane/b4run/pulls", { ...pull, head: "blove/x" })
    refuse("POST", "/repos/cacheplane/b4run/issues/1/comments", { body: "x" })
    refuse("POST", "/repos/cacheplane/b4run/dispatches", { event_type: "x" })
    refuse("POST", "/repos/cacheplane/b4run/releases", { tag_name: "v1" })
    refuse("POST", "/repos/cacheplane/b4run/merges", { base: "main", head: SHA })
    refuse("POST", "/graphql", { query: "mutation { mergePullRequest }" })
    refuse("GET", "/users/blove")
    refuse("GET", "/repos/cacheplane/b4run/contents/README.md")
  })

  it("refuses a path fetch would resolve elsewhere: dot, empty and encoded segments", () => {
    for (const path of [
      "/repos/cacheplane/b4run/git/ref/heads/../../../../repos/other/secret/contents/x",
      "/repos/cacheplane/b4run/rules/branches/factory/./wo-0123456789abcdef",
      "/repos/cacheplane/b4run/rules/branches/factory/%2e%2e/x",
      "/repos/cacheplane/b4run/rules/branches/factory//x",
      "/repos/cacheplane/b4run/git/ref/heads/factory%2Fx",
    ])
      expect(() => allowedRoute("GET", path, undefined, target), path).toThrow(
        /dot, empty or encoded/,
      )
  })

  it("accepts exactly the delivery's own requests", () => {
    const accept = (method: string, path: string, body?: unknown) =>
      expect(allowedRoute(method, path, body, target).method).toBe(method)
    accept("GET", "/app")
    accept("POST", "/app/installations/42/access_tokens", { repositories: ["b4run"] })
    accept("GET", "/repos/cacheplane/b4run/installation")
    accept("GET", `/repos/cacheplane/b4run/compare/${SHA}...${"b".repeat(40)}`)
    accept("POST", "/repos/cacheplane/b4run/git/refs", { ref: `refs/heads/${BRANCH}`, sha: SHA })
    accept("POST", "/repos/cacheplane/b4run/pulls", {
      head: BRANCH,
      base: "main",
      draft: true,
      title: "t",
      body: "b",
    })
    accept("POST", "/graphql", { query: CLOSING_ISSUES_QUERY, variables: {} })
    accept("GET", `/users/${encodeURIComponent("b4-factory[bot]")}`)
  })
})

describe("the app's credential", () => {
  it("signs an RS256 JWT GitHub accepts: issued a minute ago, nine minutes to live", () => {
    const now = Date.parse("2026-10-01T12:00:00Z")
    const [header, payload, signature] = appJwt(123456, privateKey, now).split(".") as [
      string,
      string,
      string,
    ]
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    })
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iat: now / 1000 - 60,
      exp: now / 1000 + 540,
      iss: 123456,
    })
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true)
  })

  it("reads only a private, regular PEM file, and never quotes it", () => {
    dir = mkdtempSync(join(tmpdir(), "app-key-"))
    const path = join(dir, "app.pem")
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString()
    writeFileSync(path, pem, { mode: 0o600 })
    expect(loadAppPrivateKey(path).asymmetricKeyType).toBe("rsa")
    chmodSync(path, 0o644)
    expect(() => loadAppPrivateKey(path)).toThrow(/chmod 600/)
    writeFileSync(path, "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n", { mode: 0o600 })
    chmodSync(path, 0o600)
    const error = (() => {
      try {
        loadAppPrivateKey(path)
      } catch (e) {
        return String(e)
      }
    })()
    expect(error).toContain("is not a PEM private key")
    expect(error).not.toContain("not a key")
    expect(() => loadAppPrivateKey(dir as string)).toThrow(/cannot be used/)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run test/github-http.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: The JWT and the key**

`examples/software-factory/controller/src/lib/delivery/github/jwt.ts`:

```ts
import { createPrivateKey, createSign, type KeyObject } from "node:crypto"
import { readFileSync, statSync } from "node:fs"

/**
 * The GitHub App's own credential (rung 4 spec §6.1, §8): an RS256 JWT signed with the app's
 * private key, used only to find the installation and mint an installation token. Signed
 * with `node:crypto`; no dependency.
 */

/** Read the app's private key: a regular file, private to its owner, never echoed. */
export function loadAppPrivateKey(path: string): KeyObject {
  let mode: number
  try {
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error("not a regular file")
    mode = stat.mode
  } catch (error) {
    throw new Error(`the GitHub App key ${path} cannot be used: ${(error as Error).message}`)
  }
  if ((mode & 0o077) !== 0)
    throw new Error(
      `the GitHub App key ${path} is readable by group or other (mode ${(mode & 0o777).toString(8)}): chmod 600 it`,
    )
  try {
    return createPrivateKey(readFileSync(path))
  } catch {
    // Never the parser's message: it can quote the file.
    throw new Error(`the GitHub App key ${path} is not a PEM private key`)
  }
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

/** A JWT GitHub accepts: issued a minute in the past (clock skew), expiring nine minutes on. */
export function appJwt(appId: number, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000)
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iat: now - 60, exp: now + 540, iss: appId })}`
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url")
  return `${unsigned}.${signature}`
}
```

- [ ] **Step 4: The allow-list and the request** (D8, D15; `retry-after` and `x-ratelimit-*` read here, spec §6.5; the per-request bound, D25; the URL checked as `fetch` will send it and redirects never followed, D28; a controller abort rethrown for the worker to stop on, D26):

`examples/software-factory/controller/src/lib/delivery/github/http.ts`:

```ts
import { DeliveryError } from "../adapter.js"
import { FACTORY_BOT_LOGIN } from "../guard.js"

/**
 * The adapter's single request function (rung 4 spec §6.2). It accepts only the method and
 * path shapes below, for the one configured repository, and refuses everything else before a
 * socket opens: no PATCH, PUT or DELETE exists, a ref may be created only under
 * `refs/heads/factory/`, a pull request only as a draft against the configured base, and the
 * one GraphQL document is a fixed read. A bug elsewhere cannot point a write at another
 * repository or branch.
 */

export class DisallowedRequestError extends Error {
  constructor(method: string, path: string, why: string) {
    super(`refused ${method} ${path}: ${why}`)
    this.name = "DisallowedRequestError"
  }
}

/** The one GraphQL document: which issues merging the pull request would close. */
export const CLOSING_ISSUES_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:20){nodes{number}}}}}"

const SHA = "[0-9a-f]{40}"
const FACTORY_REF = /^refs\/heads\/factory\/wo-[0-9a-f]{16}$/
const FACTORY_HEAD = /^factory\/wo-[0-9a-f]{16}$/

export type Auth = "jwt" | "token" | "none"

interface Route {
  readonly method: "GET" | "POST"
  /** Matched against the path after `/repos/<owner>/<name>` has been checked and removed. */
  readonly pattern: RegExp
  readonly auth: Auth
  readonly repository: boolean
  /** A POST body's own rule, beyond its shape. */
  readonly body?: (body: Record<string, unknown>, target: Target) => string | undefined
}

export interface Target {
  readonly repository: string
  readonly baseBranch: string
}

const ROUTES: readonly Route[] = [
  { method: "GET", pattern: /^\/app$/, auth: "jwt", repository: false },
  { method: "GET", pattern: /^\/installation$/, auth: "jwt", repository: true },
  {
    method: "POST",
    pattern: /^\/app\/installations\/\d+\/access_tokens$/,
    auth: "jwt",
    repository: false,
  },
  { method: "GET", pattern: /^$/, auth: "token", repository: true },
  {
    method: "GET",
    pattern: /^\/users\/(?<login>[^/]+)$/,
    auth: "token",
    repository: false,
  },
  {
    method: "GET",
    pattern: /^\/rules\/branches\/[A-Za-z0-9._/-]+$/,
    auth: "token",
    repository: true,
  },
  { method: "GET", pattern: /^\/issues\/\d+$/, auth: "token", repository: true },
  {
    method: "GET",
    pattern: /^\/git\/ref\/heads\/[A-Za-z0-9._/-]+$/,
    auth: "token",
    repository: true,
  },
  {
    method: "GET",
    pattern: new RegExp(`^/compare/${SHA}\\.\\.\\.${SHA}$`),
    auth: "token",
    repository: true,
  },
  { method: "GET", pattern: new RegExp(`^/git/commits/${SHA}$`), auth: "token", repository: true },
  { method: "GET", pattern: new RegExp(`^/git/trees/${SHA}$`), auth: "token", repository: true },
  { method: "POST", pattern: /^\/git\/blobs$/, auth: "token", repository: true },
  { method: "POST", pattern: /^\/git\/trees$/, auth: "token", repository: true },
  { method: "POST", pattern: /^\/git\/commits$/, auth: "token", repository: true },
  {
    method: "POST",
    pattern: /^\/git\/refs$/,
    auth: "token",
    repository: true,
    body: (body) =>
      typeof body.ref === "string" && FACTORY_REF.test(body.ref)
        ? undefined
        : `a ref may be created only as refs/heads/factory/<work order>, not ${String(body.ref)}`,
  },
  {
    method: "GET",
    pattern: /^\/pulls\?head=[^&]+&state=all&per_page=100$/,
    auth: "token",
    repository: true,
  },
  {
    method: "POST",
    pattern: /^\/pulls$/,
    auth: "token",
    repository: true,
    body: (body, target) =>
      body.draft !== true
        ? "a pull request is created only as a draft"
        : body.base !== target.baseBranch
          ? `a pull request targets only ${target.baseBranch}`
          : typeof body.head !== "string" || !FACTORY_HEAD.test(body.head)
            ? "a pull request's head is only factory/<work order>"
            : undefined,
  },
  { method: "GET", pattern: /^\/pulls\/\d+$/, auth: "token", repository: true },
  {
    method: "POST",
    pattern: /^\/graphql$/,
    auth: "token",
    repository: false,
    body: (body) =>
      body.query === CLOSING_ISSUES_QUERY ? undefined : "only the closing-issues query is sent",
  },
]

/**
 * The route `method path` matches for `target`, or a `DisallowedRequestError`. Exported so a
 * test can sweep it with every method and many paths without a server.
 */
export function allowedRoute(method: string, path: string, body: unknown, target: Target): Route {
  // Before any pattern: `fetch` resolves `.` and `..` segments (and their %2e spellings) and
  // would send a checked path somewhere else (`…/heads/../../../other/x`), and an empty
  // segment is not a path GitHub names. The query is the pulls listing's, checked by its route.
  const pathname = path.split("?")[0] as string
  const segments = pathname.split("/").slice(1)
  if (
    !pathname.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    /%2e|%2f|%5c|\\/i.test(pathname)
  )
    throw new DisallowedRequestError(method, path, "a dot, empty or encoded separator segment")
  const prefix = `/repos/${target.repository}`
  const inRepository =
    path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)
  const rest = inRepository ? path.slice(prefix.length) : path
  if (path.startsWith("/repos/") && !inRepository)
    throw new DisallowedRequestError(method, path, `only ${target.repository} is addressed`)
  const route = ROUTES.find(
    (r) => r.method === method && r.repository === inRepository && r.pattern.test(rest),
  )
  if (route === undefined) throw new DisallowedRequestError(method, path, "not on the allow-list")
  const login = route.pattern.exec(rest)?.groups?.login
  if (login !== undefined && decodeURIComponent(login) !== FACTORY_BOT_LOGIN)
    throw new DisallowedRequestError(method, path, `only the factory's bot user is read`)
  if (route.body !== undefined) {
    const problem =
      typeof body === "object" && body !== null
        ? route.body(body as Record<string, unknown>, target)
        : "a body is required"
    if (problem !== undefined) throw new DisallowedRequestError(method, path, problem)
  }
  return route
}

/** How long a rate-limited response asks the caller to wait, in ms, if it says. */
function retryAfterMs(headers: Headers, nowMs: number): number | undefined {
  const after = headers.get("retry-after")
  if (after !== null && /^\d+$/.test(after)) return Number(after) * 1000
  const reset = headers.get("x-ratelimit-reset")
  if (reset !== null && /^\d+$/.test(reset)) return Math.max(0, Number(reset) * 1000 - nowMs)
  return undefined
}

export interface RequestOptions {
  readonly fetch: typeof fetch
  readonly baseUrl: string
  readonly target: Target
  readonly credential: (auth: Auth) => string
  readonly signal: AbortSignal
  readonly now: () => number
  /** One request's bound (D25); past it the request is a transient failure, retried by the step. */
  readonly timeoutMs: number
}

/**
 * One allow-listed request. Returns the parsed JSON body of a 2xx; classifies every other
 * answer as a `DeliveryError` the worker knows how to treat (spec §6.5). The message carries
 * GitHub's own `message` field at most, never a header.
 */
export async function githubRequest(
  options: RequestOptions,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly json: unknown }> {
  const route = allowedRoute(method, path, body, options.target)
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "b4-software-factory",
  }
  if (route.auth !== "none")
    headers.authorization = `${route.auth === "jwt" ? "Bearer" : "token"} ${options.credential(route.auth)}`
  if (body !== undefined) headers["content-type"] = "application/json"
  // The URL fetch will send is the one checked: same origin, same path, nothing normalised.
  const base = new URL(options.baseUrl)
  const url = new URL(`${options.baseUrl}${path}`)
  if (
    url.origin !== base.origin ||
    url.pathname !== `${base.pathname.replace(/\/$/, "")}${path.split("?")[0]}`
  )
    throw new DisallowedRequestError(method, path, `it resolves to ${url.pathname}`)
  let response: Response
  try {
    response = await options.fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // Never followed (D28): a redirect would send the request, and the token, to a URL the
      // allow-list never saw. A 3xx is answered below as unexpected.
      redirect: "manual",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
    })
  } catch (error) {
    // The controller closing is the caller's to see (the worker stops, D26); a timeout or a
    // network failure is transient.
    if (options.signal.aborted) throw error
    const timedOut = (error as Error).name === "TimeoutError"
    throw new DeliveryError(
      "transient",
      `${method} ${path}: ${timedOut ? `no answer within ${options.timeoutMs} ms` : (error as Error).message}`,
    )
  }
  if (response.status >= 300 && response.status < 400)
    throw new DeliveryError(
      "unexpected",
      `${method} ${path}: HTTP ${response.status} redirect, not followed`,
      undefined,
      response.status,
    )
  const text = await response.text()
  let json: unknown = null
  try {
    json = text === "" ? null : JSON.parse(text)
  } catch {
    json = null
  }
  const status = response.status
  if (status >= 200 && status < 300) return { status, json }
  const said = (json as { message?: unknown } | null)?.message
  const message = `${method} ${path}: HTTP ${status}${typeof said === "string" ? ` ${said.slice(0, 300)}` : ""}`
  const wait = retryAfterMs(response.headers, options.now())
  if (status === 429) throw new DeliveryError("rate_limited", message, wait, status)
  if (status === 403) {
    const limited =
      response.headers.get("retry-after") !== null ||
      response.headers.get("x-ratelimit-remaining") === "0"
    throw new DeliveryError(limited ? "rate_limited" : "unauthorized", message, wait, status)
  }
  if (status === 401) throw new DeliveryError("unauthorized", message, undefined, status)
  if (status === 404) throw new DeliveryError("not_found", message, undefined, status)
  if (status === 409 || status === 422)
    throw new DeliveryError("conflict", message, undefined, status)
  if (status >= 500) throw new DeliveryError("transient", message, undefined, status)
  throw new DeliveryError("unexpected", message, undefined, status)
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/github-http.test.ts`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write src/lib/delivery/github/jwt.ts src/lib/delivery/github/http.ts test/github-http.test.ts
git add src/lib/delivery/github/jwt.ts src/lib/delivery/github/http.ts test/github-http.test.ts
git commit -m "feat(software-factory): the GitHub App's JWT and the delivery's allow-listed request

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed (Task 17, `6155b55a6`, with the review fixes of `95452840c`).** As planned, plus: a POST body is serialized once, the string parsed back and checked, and that string sent, so a `toJSON` cannot send bytes other than those checked; every POST route has an exact key set (refs `{ref, sha}`; pulls `{title, body, head, base, draft}` plus `maintainer_can_modify`, which must be `false`; blobs, trees and commits as the adapter sends them; the mint holds `repositories` to `[the configured name]` and `permissions` to exactly `DELIVERY_PERMISSIONS`, which moved here beside the allow-list and is re-exported by the adapter; GraphQL pins the query and owner, name and number); a GET refuses a body. The body is read under the same failure handling as `fetch` (a timeout or reset mid-body is transient, the caller's abort rethrown, D26), capped at 10 MiB (unexpected past it), a 3xx body is cancelled, and a 2xx that is not JSON is unexpected (204 is empty). The URL is checked before any credential is made; a login that does not decode is a disallowed request. A 403 naming a secondary rate limit is `rate_limited`, 60 s by default. The key file is opened once, `fstat`ed and read from the same descriptor, its mode masked with `0o077`, and must be RSA (`appJwt` refuses another type).

### Task 18: The real adapter, against GitHub's shapes on loopback

**Files:**
- Create: `src/lib/delivery/github/adapter.ts`, `test/fake-github-server.ts`
- Test: `test/github-adapter.test.ts`

- [ ] **Step 1: GitHub's endpoints on loopback**, backed by Task 11's in-memory repository, answering in GitHub's shapes (201 on create, 422 "Reference already exists", 422 "A pull request already exists", 404 for a missing ref) and able to answer any request with a scripted status and headers:

`examples/software-factory/controller/test/fake-github-server.ts`:

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { DeliverySession } from "../src/lib/delivery/adapter.ts"
import { BOT, createFakeGitHub, type FakeGitHub, REPOSITORY } from "./fake-delivery-adapter.ts"

/**
 * GitHub's REST and GraphQL endpoints as the real adapter calls them, on loopback, backed by
 * the in-memory repository of `fake-delivery-adapter.ts`. It answers in GitHub's shapes and
 * status codes (201 on create, 422 "Reference already exists", 422 "A pull request already
 * exists", 404 for a missing ref) so the adapter's mapping is tested against them, and it can
 * be told to answer any request with a scripted status and headers instead. Every request is
 * logged with its method, path, authorization scheme and body.
 */

export const INSTALLATION_TOKEN = "ghs_fakeinstallationtokenfake0001"

export interface ScriptedAnswer {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
  /** Perform the request first, then answer this: a response lost after the write. */
  readonly after?: boolean
  /** Hold the answer this long: a request past the adapter's per-request bound. */
  readonly delayMs?: number
}

export interface FakeGitHubServer {
  readonly url: string
  readonly repo: FakeGitHub
  readonly requests: { method: string; path: string; auth: string; body: unknown }[]
  /** Permissions the mint grants; the delivery set by default. */
  granted: Record<string, string>
  installed: boolean
  answer(method: string, path: RegExp, answer: ScriptedAnswer, times?: number): void
  close(): Promise<void>
}

export async function startFakeGitHubServer(): Promise<FakeGitHubServer> {
  const repo = createFakeGitHub()
  const session = await repo.open(REPOSITORY, new AbortController().signal)
  const scripted: { method: string; path: RegExp; answer: ScriptedAnswer; remaining: number }[] = []
  const requests: FakeGitHubServer["requests"] = []
  const prefix = `/repos/${REPOSITORY}`

  const pullJson = (p: Awaited<ReturnType<DeliverySession["pull"]>>) => ({
    number: p.number,
    html_url: p.url,
    node_id: p.nodeId,
    state: p.state,
    draft: p.draft,
    merged_at: p.merged ? "2026-10-01T00:00:00Z" : null,
    user: { login: p.author },
    head: { ref: p.headRef, sha: p.headSha, repo: { full_name: p.headRepository } },
    base: { ref: p.baseRef },
  })

  async function route(method: string, url: URL, body: Record<string, unknown>) {
    const path = url.pathname
    const json = (status: number, value: unknown) => ({ status, value })
    if (method === "GET" && path === "/app") return json(200, { slug: BOT.replace("[bot]", "") })
    if (method === "GET" && path === `${prefix}/installation`)
      return server.installed ? json(200, { id: 42 }) : json(404, { message: "Not Found" })
    if (method === "POST" && path === "/app/installations/42/access_tokens")
      return json(201, { token: INSTALLATION_TOKEN, permissions: server.granted })
    if (method === "GET" && path === `/users/${encodeURIComponent(BOT)}`)
      return json(200, { id: 123 })
    if (method === "GET" && path === prefix) return json(200, { full_name: REPOSITORY })
    let m = /^\/repos\/[^/]+\/[^/]+\/rules\/branches\/(.+)$/.exec(path)
    if (method === "GET" && m)
      return json(
        200,
        (await session.branchRules(m[1] as string)).map((type) => ({ type })),
      )
    m = /\/issues\/(\d+)$/.exec(path)
    if (method === "GET" && m) return json(200, { state: await session.issueState(Number(m[1])) })
    m = /\/git\/ref\/heads\/(.+)$/.exec(path)
    if (method === "GET" && m) {
      const head = await session.branchHead(m[1] as string)
      return head === null
        ? json(404, { message: "Not Found" })
        : json(200, { object: { sha: head } })
    }
    m = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path)
    if (method === "GET" && m) {
      const c = await session.compare(m[1] as string, m[2] as string)
      const files = c.files.map((f) => ({
        filename: f.filename,
        ...(f.previousFilename ? { previous_filename: f.previousFilename } : {}),
      }))
      while (!c.complete && files.length < 300) files.push({ filename: `filler/${files.length}` })
      return json(200, { status: c.status, ahead_by: c.aheadBy, files })
    }
    m = /\/git\/commits\/([0-9a-f]{40})$/.exec(path)
    if (method === "GET" && m) {
      const c = await session.commit(m[1] as string).catch(() => null)
      return c === null
        ? json(404, { message: "Not Found" })
        : json(200, {
            sha: c.sha,
            tree: { sha: c.tree },
            parents: c.parents.map((sha) => ({ sha })),
          })
    }
    m = /\/git\/trees\/([0-9a-f]{40})$/.exec(path)
    if (method === "GET" && m) {
      const entries = await session.tree(m[1] as string)
      return json(200, {
        sha: m[1],
        truncated: false,
        tree: entries.map((e) => ({ path: e.name, mode: e.mode, type: e.type, sha: e.sha })),
      })
    }
    if (method === "POST" && path === `${prefix}/git/blobs`)
      return json(201, {
        sha: await session.createBlob(Buffer.from(String(body.content), "base64").toString("utf8")),
      })
    if (method === "POST" && path === `${prefix}/git/trees`)
      return json(201, {
        sha: await session.createTree(
          String(body.base_tree),
          (body.tree as { path: string; mode: string; sha: string }[]).map((e) => ({
            path: e.path,
            mode: e.mode,
            sha: e.sha,
          })),
        ),
      })
    if (method === "POST" && path === `${prefix}/git/commits`)
      return json(201, {
        sha: await session.createCommit(
          body as unknown as Parameters<DeliverySession["createCommit"]>[0],
        ),
      })
    if (method === "POST" && path === `${prefix}/git/refs`) {
      const made = await session.createBranch(
        String(body.ref).replace("refs/heads/", ""),
        String(body.sha),
      )
      return made === "exists"
        ? json(422, { message: "Reference already exists" })
        : json(201, { ref: body.ref, object: { sha: body.sha } })
    }
    if (method === "GET" && path === `${prefix}/pulls`) {
      const head = (url.searchParams.get("head") ?? "").replace(/^[^:]+:/, "")
      return json(200, (await session.pullsByHead(head)).map(pullJson))
    }
    if (method === "POST" && path === `${prefix}/pulls`) {
      const made = await session.createDraftPull({
        title: String(body.title),
        body: String(body.body),
        head: String(body.head),
        base: String(body.base),
      })
      return made === "exists"
        ? json(422, {
            message: "Validation Failed: A pull request already exists for cacheplane:x.",
          })
        : json(201, pullJson(made))
    }
    m = /\/pulls\/(\d+)$/.exec(path)
    if (method === "GET" && m) return json(200, pullJson(await session.pull(Number(m[1]))))
    if (method === "POST" && path === "/graphql")
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: (await session.closingIssues(0)).map((number) => ({ number })),
              },
            },
          },
        },
      })
    return json(404, { message: `fake GitHub has no ${method} ${path}` })
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString("utf8")
    const body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)
    const url = new URL(req.url ?? "/", "http://fake")
    const method = req.method ?? "GET"
    const path = `${url.pathname}${url.search}`
    requests.push({
      method,
      path,
      auth: String(req.headers.authorization ?? "").split(" ")[0] ?? "",
      body,
    })
    const script = scripted.find((s) => s.method === method && s.path.test(path) && s.remaining > 0)
    let answer: { status: number; value: unknown; headers?: Readonly<Record<string, string>> }
    if (script !== undefined) {
      script.remaining -= 1
      if (script.answer.after) await route(method, url, body)
      if (script.answer.delayMs !== undefined)
        await new Promise((resolve) => setTimeout(resolve, script.answer.delayMs))
      answer = {
        status: script.answer.status,
        value: script.answer.body ?? { message: `scripted ${script.answer.status}` },
        ...(script.answer.headers ? { headers: script.answer.headers } : {}),
      }
    } else {
      try {
        answer = await route(method, url, body)
      } catch (error) {
        answer = { status: 404, value: { message: String(error) } }
      }
    }
    res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers })
    res.end(JSON.stringify(answer.value))
  }

  const http: Server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(500)
      res.end(JSON.stringify({ message: String(error) }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const { port } = http.address() as AddressInfo
  const server: FakeGitHubServer = {
    url: `http://127.0.0.1:${port}`,
    repo,
    requests,
    granted: { contents: "write", pull_requests: "write", metadata: "read", issues: "read" },
    installed: true,
    answer(method, path, answer, times = 1) {
      scripted.push({ method, path, answer, remaining: times })
    },
    close: () => new Promise((resolve) => http.close(() => resolve())),
  }
  return server
}
```

- [ ] **Step 2: Write the failing test**

`examples/software-factory/controller/test/github-adapter.test.ts`:

```ts
import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { DeliveryError } from "../src/lib/delivery/adapter.ts"
import { createGitHubAdapter } from "../src/lib/delivery/github/adapter.ts"
import { allowedRoute } from "../src/lib/delivery/github/http.ts"
import { BRANCH, closeHarness, harness } from "./delivery-harness.ts"
import {
  type FakeGitHubServer,
  INSTALLATION_TOKEN,
  startFakeGitHubServer,
} from "./fake-github-server.ts"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })

let server: FakeGitHubServer | undefined
afterEach(async () => {
  closeHarness()
  await server?.close()
  server = undefined
})

describe("the GitHub adapter against GitHub's shapes", () => {
  /** Every request the adapter sends, as fetch received it. */
  let sent: { method: string; path: string; body: unknown }[] = []
  async function delivery(
    options: {
      readonly requestTimeoutMs?: number
      /** Called as fetch is handed each request: a test closes the controller here. */
      readonly beforeFetch?: (method: string, path: string) => void
    } = {},
  ) {
    server = await startFakeGitHubServer()
    sent = []
    const recording: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      sent.push({
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      options.beforeFetch?.(init?.method ?? "GET", url.pathname)
      return fetch(input, init)
    }
    const adapter = createGitHubAdapter({
      repository: "cacheplane/b4run",
      appId: 123456,
      privateKey,
      baseBranch: "main",
      baseUrl: server.url,
      fetch: recording,
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
    })
    const h = await harness({ github: server.repo, adapter })
    return { h, server, adapter }
  }

  it("delivers end to end with GET and POST only, the JWT only for the app's own endpoints", async () => {
    const { h, server } = await delivery()
    expect((await h.deliver()).state).toBe("delivered")
    expect(new Set(server.requests.map((r) => r.method))).toEqual(new Set(["GET", "POST"]))
    for (const r of server.requests)
      expect(r.auth, r.path).toBe(/^\/app($|\/)|\/installation$/.test(r.path) ? "Bearer" : "token")
    // Every request fetch was handed is one the allow-list accepts, as sent.
    for (const r of sent)
      expect(
        () =>
          allowedRoute(r.method, r.path, r.body, {
            repository: "cacheplane/b4run",
            baseBranch: "main",
          }),
        r.path,
      ).not.toThrow()
    // The token is minted for the installation id the adapter just read, and nothing wider.
    const mint = server.requests.find((r) => r.path === "/app/installations/42/access_tokens")
    expect(mint?.body).toEqual({
      repositories: ["b4run"],
      permissions: { contents: "write", pull_requests: "write", metadata: "read", issues: "read" },
    })
    const created = server.requests.find((r) => r.method === "POST" && r.path.endsWith("/pulls"))
    expect(created?.body).toMatchObject({ draft: true, base: "main", head: BRANCH })
    expect(h.journal()).not.toContain(INSTALLATION_TOKEN)
  })

  it("answers a lost ref create's 422 and a lost PR create's 422 by reading", async () => {
    const { h, server } = await delivery()
    server.answer("POST", /\/git\/refs$/, { status: 502, after: true })
    server.answer("POST", /\/pulls$/, { status: 504, after: true })
    expect((await h.deliver()).state).toBe("delivered")
    expect(server.repo.pulls).toHaveLength(1)
  })

  it("classifies 401, a plain 403, a rate-limit 403 and a 429 as GitHub means them", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 5)
    const limited = await delivery()
    limited.server.answer("GET", /\/compare\//, {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
    })
    limited.server.answer("GET", /\/git\/trees\//, { status: 429, headers: { "retry-after": "7" } })
    expect((await limited.h.deliver()).state).toBe("delivered")
    expect(limited.h.waits[1]).toBe(7_000)
    closeHarness()
    await server?.close()

    const forbidden = await delivery()
    forbidden.server.answer("GET", /\/compare\//, {
      status: 403,
      body: { message: "Resource not accessible by integration" },
    })
    expect(await forbidden.h.deliver()).toMatchObject({ blockedReason: "delivery_unauthorized" })
  })

  it("refuses a mint narrower than delivery needs, and an app not installed", async () => {
    const narrow = await delivery()
    narrow.server.granted = { contents: "read", pull_requests: "write", metadata: "read" }
    expect(await narrow.h.deliver()).toMatchObject({ blockedReason: "delivery_unauthorized" })
    expect(narrow.h.journal()).toContain("contents: write")
    closeHarness()
    await server?.close()

    const absent = await delivery()
    absent.server.installed = false
    expect(await absent.h.deliver()).toMatchObject({ blockedReason: "delivery_unauthorized" })
    expect(absent.h.journal()).toContain("not installed")
  })

  it("refuses a comparison of 300 files as unverifiable", async () => {
    const { h, server } = await delivery()
    server.repo.comparison = { status: "ahead", aheadBy: 400, files: [], complete: false }
    expect(await h.deliver()).toMatchObject({ blockedReason: "delivery_base_conflict" })
  })

  it("never follows a redirect: a 307 blocks, and its target is never asked", async () => {
    const { h, server } = await delivery()
    server.answer("POST", /\/git\/refs$/, {
      status: 307,
      headers: { location: `${server.url}/repos/cacheplane/other/git/refs` },
    })
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(server.requests.some((r) => r.path.includes("/cacheplane/other/"))).toBe(false)
  })

  it("gives up on a request past its bound and retries the step", async () => {
    const { h, server } = await delivery({ requestTimeoutMs: 200 })
    server.answer("GET", /\/compare\//, { status: 200, delayMs: 1_000 })
    expect((await h.deliver()).state, h.journal()).toBe("delivered")
    expect(h.waits).toEqual([2_000])
    expect(h.journal()).toContain("no answer within 200 ms")
  })

  it("stays delivering when the controller closes mid-request, and resumes after", async () => {
    let abort: (() => void) | undefined
    const { h } = await delivery({
      beforeFetch: (method, path) => {
        if (method === "POST" && path.endsWith("/git/refs")) abort?.()
      },
    })
    const stopped = await h.deliver({
      onEvent: (type, a) => {
        if (type === "delivery_committed") abort = a
      },
    })
    expect(stopped).toMatchObject({ state: "delivering", blockedReason: null })
    expect(h.events()).toContain("delivery_stopped")
    abort = undefined
    expect((await h.deliver()).state).toBe("delivered")
  })

  it("delivers only to the repository it was configured for", async () => {
    const { adapter } = await delivery()
    await expect(adapter.open("cacheplane/other", new AbortController().signal)).rejects.toEqual(
      new DeliveryError(
        "unauthorized",
        "this controller delivers to cacheplane/b4run, not cacheplane/other",
      ),
    )
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm exec vitest run test/github-adapter.test.ts`
Expected: FAIL, `github/adapter.ts` does not exist.

- [ ] **Step 4: The adapter** (D5: the token is minted downscoped to exactly `DELIVERY_PERMISSIONS`, and a grant narrower than that refuses; D15: the bot's identity; D27: bound to one repository; each session keeps its own token, and `secrets()` names every token minted, for the scrubber):

`examples/software-factory/controller/src/lib/delivery/github/adapter.ts`:

```ts
import type { KeyObject } from "node:crypto"
import {
  type Comparison,
  type DeliveryAdapter,
  DeliveryError,
  type DeliverySession,
  type RemoteCommit,
  type RemotePull,
} from "../adapter.js"
import type { GitTreeEntry } from "../git-objects.js"
import { type Auth, CLOSING_ISSUES_QUERY, githubRequest, type RequestOptions } from "./http.js"
import { appJwt } from "./jwt.js"

/**
 * The real `DeliveryAdapter` (rung 4 spec §6): GitHub's REST and GraphQL APIs under an
 * installation token minted per worker run, downscoped to the one repository and to exactly
 * the permissions delivery needs. The token lives in this object's memory for the run and
 * nowhere else: not the registry, the journal, a log, a file, argv or a child's environment.
 */

/** What delivery needs, and all a minted token may carry (spec §2 D2, §15 item 2). */
export const DELIVERY_PERMISSIONS: Readonly<Record<string, "read" | "write">> = Object.freeze({
  contents: "write",
  pull_requests: "write",
  metadata: "read",
  issues: "read",
})

export interface GitHubAdapterOptions {
  /** The one repository this adapter delivers to (D27); `open` refuses any other. */
  readonly repository: string
  readonly appId: number
  readonly privateKey: KeyObject
  readonly baseBranch: string
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
  readonly now?: () => number
  /** One request's bound (D25). Default 30 s. */
  readonly requestTimeoutMs?: number
}

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null)
    throw new DeliveryError("unexpected", `${what}: the response is not an object`)
  return value as Record<string, unknown>
}
const asString = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new DeliveryError("unexpected", `${what} is not a string`)
  return value
}

function pullOf(value: unknown): RemotePull {
  const pull = asRecord(value, "pull request")
  const head = asRecord(pull.head, "pull request head")
  const base = asRecord(pull.base, "pull request base")
  const user = asRecord(pull.user, "pull request user")
  const repo = head.repo === null ? null : asRecord(head.repo, "pull request head repository")
  return {
    number: Number(pull.number),
    url: asString(pull.html_url, "html_url"),
    nodeId: asString(pull.node_id, "node_id"),
    state: pull.state === "open" ? "open" : "closed",
    draft: pull.draft === true,
    merged: pull.merged === true || (typeof pull.merged_at === "string" && pull.merged_at !== ""),
    author: asString(user.login, "user.login"),
    headRef: asString(head.ref, "head.ref"),
    headRepository: repo === null ? null : asString(repo.full_name, "head.repo.full_name"),
    headSha: asString(head.sha, "head.sha"),
    baseRef: asString(base.ref, "base.ref"),
  }
}

export function createGitHubAdapter(options: GitHubAdapterOptions): DeliveryAdapter {
  const doFetch = options.fetch ?? fetch
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "")
  const now = options.now ?? Date.now
  /** Every token minted, for the scrubber; each session uses only its own. */
  const minted = new Set<string>()

  return {
    secrets: () => [...minted],
    async open(repository, signal) {
      if (repository !== options.repository)
        throw new DeliveryError(
          "unauthorized",
          `this controller delivers to ${options.repository}, not ${repository}`,
        )
      let token: string | undefined
      const [owner, name] = repository.split("/") as [string, string]
      const target = { repository, baseBranch: options.baseBranch }
      const request: RequestOptions = {
        fetch: doFetch,
        baseUrl,
        target,
        signal,
        now,
        timeoutMs: options.requestTimeoutMs ?? 30_000,
        credential: (auth: Auth) => {
          if (auth === "jwt") return appJwt(options.appId, options.privateKey, now())
          if (token === undefined) throw new DeliveryError("unauthorized", "no installation token")
          return token
        },
      }
      const get = async (path: string) => (await githubRequest(request, "GET", path)).json
      const post = async (path: string, body: unknown) =>
        (await githubRequest(request, "POST", path, body)).json
      const repo = `/repos/${repository}`

      // Who the app is, where it is installed, and a token for exactly this repository and
      // exactly these permissions: GitHub refuses to mint wider than the installation, so the
      // mint is also the check that the installation still grants them.
      const app = asRecord(await get("/app"), "app")
      const botLogin = `${asString(app.slug, "app.slug")}[bot]`
      let installation: Record<string, unknown>
      try {
        installation = asRecord(await get(`${repo}/installation`), "installation")
      } catch (error) {
        if (error instanceof DeliveryError && error.kind === "not_found")
          throw new DeliveryError("unauthorized", `the app is not installed on ${repository}`)
        throw error
      }
      let mint: Record<string, unknown>
      try {
        mint = asRecord(
          await post(`/app/installations/${Number(installation.id)}/access_tokens`, {
            repositories: [name],
            permissions: DELIVERY_PERMISSIONS,
          }),
          "access token",
        )
      } catch (error) {
        if (
          error instanceof DeliveryError &&
          (error.kind === "conflict" || error.kind === "not_found")
        )
          throw new DeliveryError(
            "unauthorized",
            `the installation refused the token: ${error.message}`,
          )
        throw error
      }
      token = asString(mint.token, "token")
      minted.add(token)
      const granted = asRecord(mint.permissions ?? {}, "granted permissions")
      const missing = Object.entries(DELIVERY_PERMISSIONS).filter(
        ([scope, level]) =>
          !(granted[scope] === level || (level === "read" && granted[scope] === "write")),
      )
      if (missing.length > 0)
        throw new DeliveryError(
          "unauthorized",
          `the installation grants too little: ${missing.map(([s, l]) => `${s}: ${l}`).join(", ")}`,
        )
      await get(repo)
      const bot = asRecord(await get(`/users/${encodeURIComponent(botLogin)}`), "bot user")
      const identity = {
        name: botLogin,
        email: `${Number(bot.id)}+${botLogin}@users.noreply.github.com`,
      }

      const session: DeliverySession = {
        botLogin,
        identity,
        async branchRules(branch) {
          const rules = await get(`${repo}/rules/branches/${branch}`)
          return Array.isArray(rules) ? rules.map((r) => String(asRecord(r, "rule").type)) : []
        },
        async issueState(number) {
          const issue = asRecord(await get(`${repo}/issues/${number}`), "issue")
          return issue.state === "closed" ? "closed" : "open"
        },
        async branchHead(branch) {
          try {
            const ref = asRecord(await get(`${repo}/git/ref/heads/${branch}`), "ref")
            return asString(asRecord(ref.object, "ref.object").sha, "ref sha")
          } catch (error) {
            if (error instanceof DeliveryError && error.kind === "not_found") return null
            throw error
          }
        },
        async compare(base, head): Promise<Comparison> {
          const c = asRecord(await get(`${repo}/compare/${base}...${head}`), "comparison")
          const files = Array.isArray(c.files) ? c.files.map((f) => asRecord(f, "file")) : []
          return {
            status:
              (["ahead", "behind", "diverged", "identical"] as const).find((s) => s === c.status) ??
              "diverged",
            aheadBy: Number(c.ahead_by ?? 0),
            files: files.map((f) => ({
              filename: asString(f.filename, "filename"),
              ...(typeof f.previous_filename === "string"
                ? { previousFilename: f.previous_filename }
                : {}),
            })),
            // GitHub lists at most 300 files per comparison and says nothing when it stops.
            complete: files.length < 300,
          }
        },
        async commit(sha): Promise<RemoteCommit> {
          const c = asRecord(await get(`${repo}/git/commits/${sha}`), "commit")
          return {
            sha: asString(c.sha, "commit sha"),
            tree: asString(asRecord(c.tree, "commit tree").sha, "tree sha"),
            parents: Array.isArray(c.parents)
              ? c.parents.map((p) => asString(asRecord(p, "parent").sha, "parent sha"))
              : [],
          }
        },
        async tree(sha): Promise<GitTreeEntry[]> {
          const t = asRecord(await get(`${repo}/git/trees/${sha}`), "tree")
          if (t.truncated === true)
            throw new DeliveryError("unexpected", `tree ${sha} was truncated`)
          return (Array.isArray(t.tree) ? t.tree : []).map((e) => {
            const entry = asRecord(e, "tree entry")
            return {
              name: asString(entry.path, "entry path"),
              mode: asString(entry.mode, "entry mode"),
              type: asString(entry.type, "entry type") as GitTreeEntry["type"],
              sha: asString(entry.sha, "entry sha"),
            }
          })
        },
        async createBlob(text) {
          const blob = asRecord(
            await post(`${repo}/git/blobs`, {
              content: Buffer.from(text, "utf8").toString("base64"),
              encoding: "base64",
            }),
            "blob",
          )
          return asString(blob.sha, "blob sha")
        },
        async createTree(baseTree, entries) {
          const tree = asRecord(
            await post(`${repo}/git/trees`, {
              base_tree: baseTree,
              tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: "blob", sha: e.sha })),
            }),
            "tree",
          )
          return asString(tree.sha, "tree sha")
        },
        async createCommit(input) {
          const commit = asRecord(
            await post(`${repo}/git/commits`, {
              message: input.message,
              tree: input.tree,
              parents: input.parents,
              author: input.author,
              committer: input.committer,
            }),
            "commit",
          )
          return asString(commit.sha, "commit sha")
        },
        async createBranch(branch, sha) {
          try {
            await post(`${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha })
            return "created"
          } catch (error) {
            if (
              error instanceof DeliveryError &&
              error.status === 422 &&
              /already exists/i.test(error.message)
            )
              return "exists"
            throw error
          }
        },
        async pullsByHead(branch) {
          const pulls = await get(
            `${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=100`,
          )
          return Array.isArray(pulls) ? pulls.map(pullOf) : []
        },
        async createDraftPull(input) {
          try {
            return pullOf(
              await post(`${repo}/pulls`, {
                title: input.title,
                body: input.body,
                head: input.head,
                base: input.base,
                draft: true,
                maintainer_can_modify: false,
              }),
            )
          } catch (error) {
            if (
              error instanceof DeliveryError &&
              error.status === 422 &&
              /pull request already exists/i.test(error.message)
            )
              return "exists"
            throw error
          }
        },
        async pull(number) {
          return pullOf(await get(`${repo}/pulls/${number}`))
        },
        async closingIssues(number) {
          const answer = asRecord(
            await post("/graphql", {
              query: CLOSING_ISSUES_QUERY,
              variables: { owner, name, number },
            }),
            "graphql",
          )
          if (Array.isArray(answer.errors) && answer.errors.length > 0)
            throw new DeliveryError("unexpected", "the closing-issues query answered errors")
          const nodes = (
            (
              (answer.data as Record<string, unknown> | undefined)?.repository as
                | Record<string, unknown>
                | undefined
            )?.pullRequest as Record<string, unknown> | undefined
          )?.closingIssuesReferences as { nodes?: { number: number }[] } | undefined
          return (nodes?.nodes ?? []).map((n) => Number(n.number))
        },
      }
      return session
    },
  }
}
```

- [ ] **Step 5: Run it to see it pass, with the worker suite**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/github-adapter.test.ts test/delivery-worker.test.ts`
Expected: 9 + 32 passed. Every request the adapter handed `fetch` passes `allowedRoute` as sent; every request was GET or POST, the JWT only on `/app` and the installation endpoints, the mint body exactly the four permissions for the installation id just read, and the installation token in no journal line; a 307 blocks without its target being asked (D28); a request held past `requestTimeoutMs` is retried as transient (D25); a close as the ref is created leaves the row `delivering` and the next run delivers (D26); `open()` for another repository is refused (D27).

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write src/lib/delivery/github/adapter.ts test/fake-github-server.ts test/github-adapter.test.ts
git add src/lib/delivery/github/adapter.ts test/fake-github-server.ts test/github-adapter.test.ts
git commit -m "feat(software-factory): the GitHub delivery adapter: a downscoped installation token and the Git Data API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed (Task 18, `78d1e6b7f`, with the review fixes of `8def024d0`).** As planned, plus: the adapter refuses a `truncated: true` tree listing, naming the cause. GitHub's "pull request already exists" 422 says so only in `errors[].message` under a top-level `Validation Failed`, so the request carries the first `errors[]` messages (control characters removed, capped) and `createDraftPull` matches them; the fake GitHub answers GitHub's real shapes (both 422s, the 404 and 401 bodies, the pulls `head` filter with its `owner:` prefix required, GraphQL `NOT_FOUND` by PR number, a distinct expiring token per mint, honoured only when minted). `open` checks the app's slug against `guard.json`'s bot login, the installation id, bot id and PR numbers as positive integers, and the repository's `full_name` against the configured one (case included); a closing-issues answer with no pull request is unexpected; the mint's `expires_at` is read and a fresh token minted within five minutes of expiry. The tests drive both 422s for real (the read-back misses once) and kill the mapping mutants the review listed.

### Task 19: The controller's delivery configuration, wired and consumed

**Files:**
- Modify: `src/lib/config.ts`, `src/lib/runtime.ts`
- Test: `test/config-delivery.test.ts`

- [ ] **Step 1: Write the failing test** (all four variables or none; the inline key refused by name without echoing it; the credential variables gone from `process.env` after the first runtime read):

`examples/software-factory/controller/test/config-delivery.test.ts`:

```ts
import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { loadConfig } from "../src/lib/config.ts"
import {
  APP_CREDENTIAL_VARIABLES,
  controllerRuntime,
  resetControllerRuntimeForTests,
} from "../src/lib/runtime.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString()

afterEach(async () => {
  await resetControllerRuntimeForTests()
  for (const name of [
    ...APP_CREDENTIAL_VARIABLES,
    "FACTORY_DELIVERY_REPOSITORY",
    "FACTORY_DELIVERY_BASE_BRANCH",
    "FACTORY_WORKER_URL",
    "FACTORY_STATE_DIR",
    "FACTORY_WORKER_TOKEN",
  ])
    delete process.env[name]
})

describe("the controller's delivery configuration", () => {
  const env = {
    FACTORY_WORKER_URL: "http://127.0.0.1:4100",
    FACTORY_STATE_DIR: "/tmp/state",
    FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
  }
  it("needs all four variables or none, and refuses a key in its environment", () => {
    const all = {
      ...env,
      FACTORY_GITHUB_APP_ID: "7",
      FACTORY_GITHUB_APP_PRIVATE_KEY_FILE: "/k.pem",
      FACTORY_DELIVERY_REPOSITORY: "cacheplane/b4run",
      FACTORY_DELIVERY_BASE_BRANCH: "main",
    }
    expect(loadConfig(all).delivery).toEqual({
      repository: "cacheplane/b4run",
      baseBranch: "main",
      appId: 7,
      privateKeyFile: "/k.pem",
    })
    expect(loadConfig(env).delivery).toBeUndefined()
    const { FACTORY_DELIVERY_BASE_BRANCH: _, ...three } = all
    expect(() => loadConfig(three)).toThrow(/missing FACTORY_DELIVERY_BASE_BRANCH/)
    expect(() => loadConfig({ ...env, FACTORY_GITHUB_APP_PRIVATE_KEY: PEM })).toThrow(
      /FACTORY_GITHUB_APP_PRIVATE_KEY is retired/,
    )
    try {
      loadConfig({ ...env, FACTORY_GITHUB_APP_PRIVATE_KEY: PEM })
    } catch (error) {
      expect(String(error).includes("MII")).toBe(false)
    }
  })
})

describe("the controller's own environment", () => {
  it("consumes the app's credential variables on its first read, before any child is spawned", () => {
    Object.assign(process.env, {
      FACTORY_WORKER_URL: "http://127.0.0.1:4100",
      FACTORY_STATE_DIR: "/tmp/state",
      FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
      FACTORY_GITHUB_APP_ID: "7",
      FACTORY_GITHUB_APP_PRIVATE_KEY_FILE: "/k.pem",
      FACTORY_DELIVERY_REPOSITORY: "cacheplane/b4run",
      FACTORY_DELIVERY_BASE_BRANCH: "main",
    })
    expect(controllerRuntime().config.delivery).toMatchObject({
      appId: 7,
      privateKeyFile: "/k.pem",
    })
    for (const name of APP_CREDENTIAL_VARIABLES) expect(process.env[name], name).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run test/config-delivery.test.ts`
Expected: FAIL: `config.delivery` is undefined; `APP_CREDENTIAL_VARIABLES` is not exported.

- [ ] **Step 3: The configuration** (D16, D17):

```diff
diff --git a/examples/software-factory/controller/src/lib/config.ts b/examples/software-factory/controller/src/lib/config.ts
index bcaa9e319..9c0c6dd88 100644
--- a/examples/software-factory/controller/src/lib/config.ts
+++ b/examples/software-factory/controller/src/lib/config.ts
@@ -1,5 +1,6 @@
 import { join } from "node:path"
 import { z } from "zod"
+import { BRANCH_PATTERN, REPOSITORY_PATTERN } from "./domain/work-order.js"
 import { DEFAULT_IMAGE_BUILD_TIMEOUT_MS, DEFAULT_MAX_IMAGE_BUILDS } from "./targets/images.js"
 
 const positiveInt = (name: string) =>
@@ -70,6 +71,20 @@ const EnvSchema = z.object({
    * The secret every worker's thread-access policy requires: `authorization: Bearer <token>`.
    * Every message below names the variable and never its value.
    */
+  /**
+   * Draft-PR delivery (rung 4 §8.2): all four or none. The key is a path to a file, never the
+   * key itself; `factory up` passes these to the controller alone.
+   */
+  FACTORY_GITHUB_APP_ID: positiveInt("FACTORY_GITHUB_APP_ID"),
+  FACTORY_GITHUB_APP_PRIVATE_KEY_FILE: z.string().min(1).optional(),
+  FACTORY_DELIVERY_REPOSITORY: z
+    .string()
+    .regex(REPOSITORY_PATTERN, { message: "FACTORY_DELIVERY_REPOSITORY must be owner/name" })
+    .optional(),
+  FACTORY_DELIVERY_BASE_BRANCH: z
+    .string()
+    .regex(BRANCH_PATTERN, { message: "FACTORY_DELIVERY_BASE_BRANCH must be a branch name" })
+    .optional(),
   FACTORY_WORKER_TOKEN: z
     .string({ message: WORKER_TOKEN_REQUIRED })
     .min(1, { message: WORKER_TOKEN_REQUIRED })
@@ -126,6 +141,13 @@ export interface FactoryConfig {
   readonly maxCandidateAttempts: number
   /** Sent to every worker as `authorization: Bearer <token>`. Never journalled or logged. */
   readonly workerToken: string
+  /** Draft-PR delivery, when all four of its variables are set. */
+  readonly delivery?: {
+    readonly repository: string
+    readonly baseBranch: string
+    readonly appId: number
+    readonly privateKeyFile: string
+  }
   /** One line per variable set here that the controller ignores; the runtime prints each at boot. */
   readonly warnings: readonly string[]
 }
@@ -149,6 +171,12 @@ const RETIRED: Readonly<Record<string, string>> = {
     "the controller reads the drafter's threads over its URL (sandbox.workspaceRead), not through its app root",
   FACTORY_TARGETS_DIR:
     "target.json is never written any more (images live in <FACTORY_STATE_DIR>/images.sqlite), so there is no copy to point at",
+  // Rung 4: never a key in the controller's environment, where every git and docker child it
+  // spawns would inherit it.
+  FACTORY_GITHUB_APP_PRIVATE_KEY:
+    "the controller reads the app's key from a file: set FACTORY_GITHUB_APP_PRIVATE_KEY_FILE (factory up writes one for privateKeyEnv)",
+  FACTORY_GITHUB_TOKEN:
+    "delivery uses a GitHub App: set FACTORY_GITHUB_APP_ID and FACTORY_GITHUB_APP_PRIVATE_KEY_FILE",
 }
 
 /**
@@ -188,6 +216,17 @@ export function loadConfig(env: Readonly<Record<string, string | undefined>>): F
     throw invalid(
       "FACTORY_DRAFTER_ROUTE is set but the drafter is not: set FACTORY_DRAFTER_URL, or unset it",
     )
+  const deliveryNames = [
+    "FACTORY_GITHUB_APP_ID",
+    "FACTORY_GITHUB_APP_PRIVATE_KEY_FILE",
+    "FACTORY_DELIVERY_REPOSITORY",
+    "FACTORY_DELIVERY_BASE_BRANCH",
+  ] as const
+  const deliverySet = deliveryNames.filter((name) => isSet(name))
+  if (deliverySet.length > 0 && deliverySet.length < deliveryNames.length)
+    throw invalid(
+      `draft-PR delivery needs all of ${deliveryNames.join(", ")}; missing ${deliveryNames.filter((n) => !isSet(n)).join(", ")}`,
+    )
   const drafter: DrafterEndpoint | undefined =
     e.FACTORY_DRAFTER_URL !== undefined
       ? { url: e.FACTORY_DRAFTER_URL.replace(/\/$/, ""), route: e.FACTORY_DRAFTER_ROUTE }
@@ -209,6 +248,16 @@ export function loadConfig(env: Readonly<Record<string, string | undefined>>): F
     maxIntakeAttempts: e.FACTORY_MAX_INTAKE_ATTEMPTS ?? 2,
     maxCandidateAttempts: e.FACTORY_MAX_CANDIDATE_ATTEMPTS ?? 2,
     workerToken: e.FACTORY_WORKER_TOKEN,
+    ...(deliverySet.length > 0
+      ? {
+          delivery: {
+            repository: e.FACTORY_DELIVERY_REPOSITORY as string,
+            baseBranch: e.FACTORY_DELIVERY_BASE_BRANCH as string,
+            appId: e.FACTORY_GITHUB_APP_ID as number,
+            privateKeyFile: e.FACTORY_GITHUB_APP_PRIVATE_KEY_FILE as string,
+          },
+        }
+      : {}),
     warnings: Object.keys(IGNORED)
       .filter((name) => env[name] !== undefined)
       .map((name) => IGNORED[name] as string),
```

- [ ] **Step 4: The runtime builds the adapter from it, and consumes the credential variables.** Apply the `runtime.ts` hunks except the `| "delivery"` line (Task 12's):

```diff
 import { createWorkerMap } from "./controller/workers.js"
+import { createGitHubAdapter } from "./delivery/github/adapter.js"
+import { loadAppPrivateKey } from "./delivery/github/jwt.js"
 import { createArtifactStore } from "./storage/artifacts.js"
```

```diff
       captureBaseline: (taskId, signal) => captureTargetBaseline(taskId, signal, { captureRoot }),
+      // The app's key is read here, once, into memory: a key that will not load stops the
+      // controller from opening (setup answers 500, and `factory up` reports it), rather than
+      // surfacing as a refusal at the first approval.
+      ...(config.delivery !== undefined
+        ? {
+            delivery: {
+              draftPr: {
+                repository: config.delivery.repository,
+                baseBranch: config.delivery.baseBranch,
+                adapter: createGitHubAdapter({
+                  repository: config.delivery.repository,
+                  appId: config.delivery.appId,
+                  privateKey: loadAppPrivateKey(config.delivery.privateKeyFile),
+                  baseBranch: config.delivery.baseBranch,
+                }),
+              },
+            },
+          }
+        : {}),
       // Defined keys only: an explicit `{ verifier: undefined }` must not erase a required
```

```diff
 export function controllerRuntime(): ControllerRuntime {
-  shared ??= createControllerRuntime(process.env, sharedOverrides)
+  if (shared === undefined) {
+    try {
+      shared = createControllerRuntime(process.env, sharedOverrides)
+    } finally {
+      // Read once and gone (rung 4 §8.2), even when the configuration refuses: every git and
+      // docker child the controller spawns inherits its environment, and none needs these.
+      for (const name of APP_CREDENTIAL_VARIABLES) delete process.env[name]
+    }
+  }
   return shared
 }
+
+/** The variables that locate the GitHub App's credential; consumed by the first runtime. */
+export const APP_CREDENTIAL_VARIABLES = [
+  "FACTORY_GITHUB_APP_ID",
+  "FACTORY_GITHUB_APP_PRIVATE_KEY_FILE",
+] as const
```

The test override (`delivery` in `ControllerRuntimeOverrides`) is spread after the configuration's, so a served test controller's injected fake wins.

- [ ] **Step 5: Run it, and the runtime and config suites**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/config-delivery.test.ts test/config.test.ts test/runtime.test.ts`
Expected: PASS (Trap 10 for the one Docker case in `runtime.test.ts`).

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write src/lib/config.ts src/lib/runtime.ts test/config-delivery.test.ts
git add src/lib/config.ts src/lib/runtime.ts test/config-delivery.test.ts
git commit -m "feat(software-factory): the controller reads its delivery from four variables and consumes the credential's

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed (Task 19, `591f76c8b`).** As planned. The controller's two credential variables are deleted from `process.env` the first time the runtime reads them, also when the configuration is then refused (tested in `1835124cb`); a `FACTORY_GITHUB_APP_PRIVATE_KEY_FILE` holding a PEM header, a line break or over 1024 characters is refused by name and never quoted, and `loadAppPrivateKey` reports a read error's code, not its message (which repeated the path).

### Task 20: `factory.config.ts`'s `delivery`, and `up`'s credential wiring

**Files:**
- Modify: `src/lib/operator/factory-config.ts`, `src/lib/operator/up.ts`
- Test: `test/up-delivery.test.ts`

- [ ] **Step 1: Write the failing test** (the config resolves `~` and refuses both, neither, an inline key and the near-misses by name; the key file must be private and outside every app root; the controller gets the four variables and the key as a path; no worker gets any delivery variable or the key's variable; `up`'s own `git`, `ps` and `docker` get neither; every line of the key's body is redacted):

`examples/software-factory/controller/test/up-delivery.test.ts`:

```ts
import { generateKeyPairSync } from "node:crypto"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  deliveryKeyProblems,
  EXAMPLE_ROOT,
  parseFactoryConfig,
  type ResolvedFactoryConfig,
} from "../src/lib/operator/factory-config.ts"
import {
  appProcesses,
  ownSubprocessEnv,
  preflight,
  redactor,
  runKeyFile,
} from "../src/lib/operator/up.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString()
const CONFIG_PATH = join(EXAMPLE_ROOT, "factory.config.ts")
const base = {
  state: ".factory",
  controller: { port: 4300 },
  builder: { port: 4100 },
  drafter: { port: 4200 },
}
const draftPr = (app: Record<string, unknown>) => ({
  ...base,
  delivery: { draftPr: { repository: "cacheplane/b4run", baseBranch: "main", app } },
})

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("factory.config.ts delivery", () => {
  it("resolves the key's file or names its variable, and refuses both, neither or a near-miss", () => {
    const file = parseFactoryConfig(draftPr({ id: 1, privateKeyFile: "~/k.pem" }), CONFIG_PATH)
    expect(file.delivery).toMatchObject({
      appId: 1,
      key: { file: expect.stringMatching(/\/k\.pem$/) },
    })
    expect(file.delivery?.key).not.toEqual({ file: "~/k.pem" })
    const env = parseFactoryConfig(
      draftPr({ id: 1, privateKeyEnv: "B4_FACTORY_APP_KEY" }),
      CONFIG_PATH,
    )
    expect(env.delivery?.key).toEqual({ env: "B4_FACTORY_APP_KEY" })
    expect(() => parseFactoryConfig(draftPr({ id: 1 }), CONFIG_PATH)).toThrow(/exactly one/)
    expect(() =>
      parseFactoryConfig(draftPr({ id: 1, privateKeyFile: "a", privateKeyEnv: "B" }), CONFIG_PATH),
    ).toThrow(/exactly one/)
    expect(() => parseFactoryConfig(draftPr({ id: 1, privateKey: PEM }), CONFIG_PATH)).toThrow(
      /privateKey: the config names no secret/,
    )
    const withToken = { ...draftPr({ id: 1, privateKeyFile: "k" }) }
    ;(withToken.delivery.draftPr as Record<string, unknown>).branchPrefix = "bot/"
    expect(() => parseFactoryConfig(withToken, CONFIG_PATH)).toThrow(
      /branchPrefix: fixed at factory\//,
    )
  })

  it("refuses a key file that is shared, missing, or inside an app root", () => {
    dir = mkdtempSync(join(tmpdir(), "up-key-"))
    const key = join(dir, "app.pem")
    writeFileSync(key, PEM, { mode: 0o600 })
    const at = (path: string) =>
      parseFactoryConfig(draftPr({ id: 1, privateKeyFile: path }), CONFIG_PATH)
    expect(deliveryKeyProblems(at(key))).toEqual([])
    chmodSync(key, 0o640)
    expect(deliveryKeyProblems(at(key)).join()).toMatch(/chmod 600/)
    expect(deliveryKeyProblems(at(join(dir, "nope.pem"))).join()).toMatch(/does not exist/)
    expect(
      deliveryKeyProblems(at(join(EXAMPLE_ROOT, "controller", "package.json"))).join(),
    ).toMatch(/inside .*controller/)
  })
})

describe("up and the GitHub App's key", () => {
  const withEnvKey = (): ResolvedFactoryConfig =>
    parseFactoryConfig(draftPr({ id: 7, privateKeyEnv: "B4_FACTORY_APP_KEY" }), CONFIG_PATH)

  it("gives the controller the four delivery variables, the key as a path, and no worker any of them", () => {
    const config = withEnvKey()
    const env = {
      PATH: "/bin",
      B4_FACTORY_APP_KEY: PEM,
      FACTORY_GITHUB_APP_ID: "999",
      FACTORY_DELIVERY_REPOSITORY: "x/y",
    }
    const apps = appProcesses(config, { token: "t".repeat(64), openaiApiKey: "sk-test" }, env)
    const byName = Object.fromEntries(apps.map((a) => [a.name, a.env]))
    expect(byName.controller).toMatchObject({
      FACTORY_GITHUB_APP_ID: "7",
      FACTORY_GITHUB_APP_PRIVATE_KEY_FILE: runKeyFile(config.stateDir),
      FACTORY_DELIVERY_REPOSITORY: "cacheplane/b4run",
      FACTORY_DELIVERY_BASE_BRANCH: "main",
    })
    // Booleans, never the environment: a failing assertion must not print a key.
    for (const name of ["controller", "builder", "drafter"])
      expect(JSON.stringify(byName[name]).includes("PRIVATE KEY"), name).toBe(false)
    for (const name of ["builder", "drafter"])
      expect(
        Object.keys(byName[name] ?? {}).filter((k) => /GITHUB_APP|DELIVERY|APP_KEY/.test(k)),
      ).toEqual([])
  })

  it("never hands up's own git, ps and docker the key's variable or a delivery variable", async () => {
    const config = withEnvKey()
    const problems: string[] = []
    await preflight(config, {
      env: {
        B4_FACTORY_APP_KEY: PEM,
        FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
        OPENAI_API_KEY: "sk-x",
      },
      dotenvPaths: [],
      checkoutLock: "/nonexistent",
      docker: { info: async () => {}, imagePresent: async () => true },
      drafterImage: "x",
      portFree: async () => true,
      launch: () => ({ command: "true", args: [] }),
      fetch,
      out: (line) => problems.push(line),
      readyTimeoutMs: 1,
      stopTimeoutMs: 1,
    })
    expect(problems.join("\n")).toContain("GitHub App 7: key from $B4_FACTORY_APP_KEY")
    expect(problems.join("\n").includes("MII")).toBe(false)
    const own = ownSubprocessEnv({
      B4_FACTORY_APP_KEY: PEM,
      FACTORY_GITHUB_APP_PRIVATE_KEY_FILE: "/k",
      PATH: "/bin",
    })
    expect(own).toEqual({ PATH: "/bin" })
  })

  it("redacts every line of the key's body from up's output", () => {
    const redact = redactor({
      token: "t".repeat(64),
      openaiApiKey: "sk-test-key",
      githubAppKey: PEM,
    })
    const body = PEM.split("\n")[3] as string
    const redacted = redact(`leaked ${body} here`)
    expect(redacted.includes(body)).toBe(false)
    expect(redacted === "leaked [GITHUB_APP_KEY] here").toBe(true)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run test/up-delivery.test.ts`
Expected: FAIL: `delivery` is an unrecognized key; `deliveryKeyProblems` and `runKeyFile` are not exported.

- [ ] **Step 3: The config**

```diff
diff --git a/examples/software-factory/controller/src/lib/operator/factory-config.ts b/examples/software-factory/controller/src/lib/operator/factory-config.ts
index 00a3923b3..f54a1995b 100644
--- a/examples/software-factory/controller/src/lib/operator/factory-config.ts
+++ b/examples/software-factory/controller/src/lib/operator/factory-config.ts
@@ -1,7 +1,9 @@
 import { existsSync, realpathSync, statSync } from "node:fs"
+import { homedir } from "node:os"
 import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
 import { pathToFileURL } from "node:url"
 import { z } from "zod"
+import { BRANCH_PATTERN, REPOSITORY_PATTERN } from "../domain/work-order.js"
 
 /**
  * What `examples/software-factory/factory.config.ts` default-exports: the one file `factory up`
@@ -15,6 +17,17 @@ export interface FactoryUpConfig {
   readonly controller: { readonly port: number }
   readonly builder: { readonly port: number }
   readonly drafter: { readonly port: number }
+  /** Draft-PR delivery (rung 4 §8.1). Absent: `--deliver draft-pr` is refused at create. */
+  readonly delivery?: {
+    readonly draftPr: {
+      readonly repository: string
+      readonly baseBranch: string
+      /** The GitHub App: its id, and where its private key is (never the key). */
+      readonly app:
+        | { readonly id: number; readonly privateKeyFile: string }
+        | { readonly id: number; readonly privateKeyEnv: string }
+    }
+  }
 }
 
 /** `examples/software-factory`: this file is `controller/src/lib/operator/factory-config.ts`. */
@@ -38,19 +51,85 @@ export interface ResolvedFactoryConfig {
   readonly stateDir: string
   readonly ports: Readonly<Record<AppName, number>>
   readonly urls: Readonly<Record<AppName, string>>
+  /** Resolved: the key file absolute (`~` expanded), or the variable `up` reads it from. */
+  readonly delivery?: {
+    readonly repository: string
+    readonly baseBranch: string
+    readonly appId: number
+    readonly key: { readonly file: string } | { readonly env: string }
+  }
 }
 
 const Port = z.number().int().min(1024).max(65535)
 const App = z.object({ port: Port }).strict()
+const AppCredential = z
+  .object({
+    id: z.number().int().positive(),
+    privateKeyFile: z.string().min(1).optional(),
+    privateKeyEnv: z
+      .string()
+      .regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable's name")
+      .optional(),
+  })
+  .strict()
+  .refine(
+    (app) => (app.privateKeyFile === undefined) !== (app.privateKeyEnv === undefined),
+    "name exactly one of privateKeyFile or privateKeyEnv",
+  )
+const Delivery = z
+  .object({
+    draftPr: z
+      .object({
+        repository: z.string().regex(REPOSITORY_PATTERN, "must be owner/name"),
+        baseBranch: z.string().regex(BRANCH_PATTERN, "must be a branch name"),
+        app: AppCredential,
+      })
+      .strict(),
+  })
+  .strict()
 const ConfigSchema = z
   .object({
     state: z.string().refine((s) => s.trim() !== "", "must name a directory"),
     controller: App,
     builder: App,
     drafter: App,
+    delivery: Delivery.optional(),
   })
   .strict()
 
+/**
+ * Near-misses inside `delivery.draftPr` and its `app`, refused by name like `REPLACED`: a key
+ * the reader might write must never be read as unset (spec §8.1).
+ */
+const DELIVERY_REPLACED: Readonly<Record<string, string>> = {
+  token: "delivery uses a GitHub App; the config names an app id and where its key is",
+  githubToken: "delivery uses a GitHub App; the config names an app id and where its key is",
+  pat: "delivery uses a GitHub App; the config names an app id and where its key is",
+  installationId: "read from the repository at each delivery",
+  branchPrefix: "fixed at factory/; the CI guards key on it",
+}
+const APP_REPLACED: Readonly<Record<string, string>> = {
+  privateKey: "the config names no secret; use privateKeyFile or privateKeyEnv",
+  token: "delivery uses a GitHub App; the config names an app id and where its key is",
+  installationId: "read from the repository at each delivery",
+}
+
+function deliveryNearMisses(value: Record<string, unknown>): string[] {
+  const draftPr = (value.delivery as { draftPr?: unknown } | undefined)?.draftPr
+  if (!isPlainObject(draftPr)) return []
+  const problems = Object.keys(draftPr)
+    .filter((key) => Object.hasOwn(DELIVERY_REPLACED, key))
+    .map((key) => `delivery.draftPr.${key}: ${DELIVERY_REPLACED[key]}`)
+  const app = draftPr.app
+  if (isPlainObject(app))
+    problems.push(
+      ...Object.keys(app)
+        .filter((key) => Object.hasOwn(APP_REPLACED, key))
+        .map((key) => `delivery.draftPr.app.${key}: ${APP_REPLACED[key]}`),
+    )
+  return problems
+}
+
 /**
  * Keys a reader of the spec's first sketch would write, refused with what replaced them
  * rather than as a bare "unrecognized key": each once meant something, and silently dropping
@@ -132,13 +211,14 @@ export function parseFactoryConfig(value: unknown, path: string): ResolvedFactor
   const problems = Object.keys(value)
     .filter((key) => Object.hasOwn(REPLACED, key))
     .map((key) => `${key}: ${REPLACED[key]}`)
+  problems.push(...deliveryNearMisses(value))
   const parsed = ConfigSchema.safeParse(value)
   if (!parsed.success)
     problems.push(
       ...parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
     )
   if (!parsed.success || problems.length > 0) throw fail(problems)
-  const { state, controller, builder, drafter } = parsed.data
+  const { state, controller, builder, drafter, delivery } = parsed.data
   const ports: Record<AppName, number> = {
     controller: controller.port,
     builder: builder.port,
@@ -165,7 +245,63 @@ export function parseFactoryConfig(value: unknown, path: string): ResolvedFactor
   const urls = Object.fromEntries(
     APP_NAMES.map((name) => [name, `http://${LOOPBACK}:${ports[name]}`]),
   ) as Record<AppName, string>
-  return { path, stateDir, ports, urls }
+  if (delivery === undefined) return { path, stateDir, ports, urls }
+  const { app } = delivery.draftPr
+  const file = app.privateKeyFile
+  const key =
+    file !== undefined
+      ? {
+          file: file.startsWith("~/")
+            ? resolve(homedir(), file.slice(2))
+            : isAbsolute(file)
+              ? resolve(file)
+              : resolve(dirname(path), file),
+        }
+      : { env: app.privateKeyEnv as string }
+  return {
+    path,
+    stateDir,
+    ports,
+    urls,
+    delivery: {
+      repository: delivery.draftPr.repository,
+      baseBranch: delivery.draftPr.baseBranch,
+      appId: app.id,
+      key,
+    },
+  }
+}
+
+/**
+ * What is wrong with the delivery key file `up` would give the controller (spec §8.1): it must
+ * exist, be a regular file, be private to its owner (no group or other bits), and lie outside
+ * every app root and the state directory, compared by identity. Empty when it is usable or
+ * when the config names a variable instead. Checked by `up`, not at load: every CLI command
+ * loads the config, and none of them needs the key.
+ */
+export function deliveryKeyProblems(config: ResolvedFactoryConfig): string[] {
+  const key = config.delivery?.key
+  if (key === undefined || !("file" in key)) return []
+  const where = `delivery.draftPr.app.privateKeyFile ${key.file}`
+  let stat: ReturnType<typeof statSync>
+  try {
+    stat = statSync(key.file)
+  } catch {
+    return [`${where} does not exist`]
+  }
+  const problems: string[] = []
+  if (!stat.isFile()) problems.push(`${where} is not a regular file`)
+  if ((stat.mode & 0o077) !== 0)
+    problems.push(
+      `${where} is readable by group or other (mode ${(stat.mode & 0o777).toString(8)}): chmod 600 it`,
+    )
+  const roots = [...APP_NAMES.map((name) => resolve(EXAMPLE_ROOT, APP_DIRS[name])), config.stateDir]
+  for (const root of roots)
+    if (lexicallyInside(root, key.file) || physicallyInside(root, key.file))
+      problems.push(
+        `${where} is inside ${root}; keep the key outside every app root and the state directory`,
+      )
+  return problems
 }
 
 /** Import a config file (tsx compiles it) and validate its default export. */
```

- [ ] **Step 4: `up`** (the key read once and checked; the variable form written to `<state>/run/github-app.pem`, 0600 in a 0700 directory, removed on every stop and, from a crashed run, at the next start. That is inside the state directory while the operator's own key file may not be (`deliveryKeyProblems`): the operator's file is long-lived and theirs, so it must not sit in a directory of run-time files a person may copy, back up or delete; the run copy is `up`'s, lives only while `up` does, and no other process is told where it is; the controller given a path; every child stripped of delivery variables and the key's variable; the key's lines redacted):

```diff
diff --git a/examples/software-factory/controller/src/lib/operator/up.ts b/examples/software-factory/controller/src/lib/operator/up.ts
index 94a389851..996aced19 100644
--- a/examples/software-factory/controller/src/lib/operator/up.ts
+++ b/examples/software-factory/controller/src/lib/operator/up.ts
@@ -1,5 +1,5 @@
 import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process"
-import { randomBytes } from "node:crypto"
+import { createPrivateKey, randomBytes } from "node:crypto"
 import {
   appendFileSync,
   chmodSync,
@@ -23,6 +23,7 @@ import {
   APP_DIRS,
   APP_NAMES,
   type AppName,
+  deliveryKeyProblems,
   EXAMPLE_ROOT,
   LOOPBACK,
   ownedVariableConflicts,
@@ -34,13 +35,24 @@ const message = (error: unknown) => (error instanceof Error ? error.message : St
 /** The prefix of up's own lines, padded like each app's (D10). */
 export const UP = `${"up".padEnd(10)} │`
 
-/** The environment of up's own subprocesses (git, ps, docker): neither secret, which none needs. */
+/**
+ * Variables that hold a secret only this run knows to be one: the one `delivery.draftPr.app.
+ * privateKeyEnv` names. Registered by the preflight that reads it; dropped from every child.
+ */
+const SECRET_VARIABLES = new Set<string>()
+
+/** Rung 4's delivery variables: the controller's alone, never a worker's or a tool's. */
+const isDeliveryVariable = (name: string) => /^FACTORY_(?:GITHUB_APP_|DELIVERY_)/.test(name)
+
+/** The environment of up's own subprocesses (git, ps, docker): no secret, which none needs. */
 export function ownSubprocessEnv(
   env: Readonly<Record<string, string | undefined>> = process.env,
 ): Record<string, string | undefined> {
   const own: Record<string, string | undefined> = { ...env }
   delete own.OPENAI_API_KEY
   delete own.FACTORY_WORKER_TOKEN
+  for (const name of Object.keys(own))
+    if (isDeliveryVariable(name) || SECRET_VARIABLES.has(name)) delete own[name]
   return own
 }
 
@@ -49,8 +61,16 @@ export interface UpSecrets {
   readonly token: string
   /** The builder and the drafter get it; the controller never does. */
   readonly openaiApiKey: string
+  /**
+   * The GitHub App's private key (PEM), read once by the preflight to check it and, for
+   * `privateKeyEnv`, to write the controller's key file. Only redaction reads it after that.
+   */
+  readonly githubAppKey?: string
 }
 
+/** Where `up` writes the key for `privateKeyEnv`: private, under the state directory, removed on stop. */
+export const runKeyFile = (stateDir: string) => join(stateDir, "run", "github-app.pem")
+
 /** The workers' own rule (`server/src/thread-access.ts`): at least 32 characters, no whitespace. */
 export function workerTokenFor(env: Readonly<Record<string, string | undefined>>): {
   readonly token: string
@@ -197,12 +217,26 @@ export function appProcesses(
 ): AppProcess[] {
   const base: Record<string, string | undefined> = { ...env }
   for (const name of NOT_INHERITED) delete base[name]
+  // Rung 4 (§8.2): no child inherits a delivery variable or the variable holding the app's
+  // key; the controller is given the four it needs, the key as a path.
+  for (const name of Object.keys(base)) if (isDeliveryVariable(name)) delete base[name]
+  const delivery = config.delivery
+  if (delivery !== undefined && "env" in delivery.key) delete base[delivery.key.env]
   const controllerEnv = {
     ...Object.fromEntries(Object.entries(base).filter(([name]) => !controllerMayNotSee(name))),
     FACTORY_WORKER_TOKEN: secrets.token,
     FACTORY_WORKER_URL: config.urls.builder,
     FACTORY_DRAFTER_URL: config.urls.drafter,
     FACTORY_STATE_DIR: config.stateDir,
+    ...(delivery !== undefined
+      ? {
+          FACTORY_GITHUB_APP_ID: String(delivery.appId),
+          FACTORY_GITHUB_APP_PRIVATE_KEY_FILE:
+            "file" in delivery.key ? delivery.key.file : runKeyFile(config.stateDir),
+          FACTORY_DELIVERY_REPOSITORY: delivery.repository,
+          FACTORY_DELIVERY_BASE_BRANCH: delivery.baseBranch,
+        }
+      : {}),
   }
   const workerEnv = {
     ...base,
@@ -313,8 +347,64 @@ export async function preflight(
     problems.push(
       `the drafter's base image is not on this Docker daemon: docker pull ${deps.drafterImage} (up never pulls)`,
     )
+  const githubAppKey = appKeyFor(config, deps.env, problems)
+  if (githubAppKey !== undefined)
+    deps.out(
+      `${UP} GitHub App ${config.delivery?.appId}: key from ${config.delivery && "file" in config.delivery.key ? config.delivery.key.file : `$${config.delivery && "env" in config.delivery.key ? config.delivery.key.env : ""}`} (controller only, as a file)`,
+    )
   if (problems.length > 0 || token === undefined || key === undefined) return { problems }
-  return { problems, secrets: { token, openaiApiKey: key.key } }
+  return {
+    problems,
+    secrets: {
+      token,
+      openaiApiKey: key.key,
+      ...(githubAppKey !== undefined ? { githubAppKey } : {}),
+    },
+  }
+}
+
+/**
+ * The app's private key, read once and checked to be a PEM private key, or undefined with the
+ * problem added (never the key in a message). The variable form is registered so no child of
+ * up inherits it.
+ */
+function appKeyFor(
+  config: ResolvedFactoryConfig,
+  env: Readonly<Record<string, string | undefined>>,
+  problems: string[],
+): string | undefined {
+  const delivery = config.delivery
+  if (delivery === undefined) return undefined
+  let pem: string | undefined
+  if ("file" in delivery.key) {
+    const found = deliveryKeyProblems(config)
+    problems.push(...found)
+    if (found.length > 0) return undefined
+    try {
+      pem = readFileSync(delivery.key.file, "utf8")
+    } catch (error) {
+      problems.push(
+        `the GitHub App key could not be read (${(error as NodeJS.ErrnoException).code})`,
+      )
+      return undefined
+    }
+  } else {
+    SECRET_VARIABLES.add(delivery.key.env)
+    pem = env[delivery.key.env]
+    if (pem === undefined || pem === "") {
+      problems.push(
+        `delivery.draftPr.app.privateKeyEnv names ${delivery.key.env}, which is not set`,
+      )
+      return undefined
+    }
+  }
+  try {
+    createPrivateKey(pem)
+  } catch {
+    problems.push("the GitHub App key is not a PEM private key")
+    return undefined
+  }
+  return pem
 }
 
 /** Alive, or someone else's (EPERM): either way not ours to replace. */
@@ -714,10 +804,17 @@ function appendLog(path: string, text: string): void {
  * other.
  */
 export function redactor(secrets: UpSecrets): (line: string) => string {
+  // The app key's body, line by line: a log line can only ever hold one of them.
+  const keyLines = (secrets.githubAppKey ?? "")
+    .split(/\r?\n/)
+    .map((line) => line.trim())
+    .filter((line) => line.length >= 16 && !line.startsWith("-----"))
+    .map((line) => [line, "[GITHUB_APP_KEY]"] as const)
   const pairs = (
     [
       [secrets.token, "[FACTORY_WORKER_TOKEN]"],
       [secrets.openaiApiKey, "[OPENAI_API_KEY]"],
+      ...keyLines,
     ] as const
   )
     .filter(([secret]) => secret.length > 0)
@@ -1051,6 +1148,33 @@ export async function up(
     deps.out(line)
     appendLog(upLog, `${line}\n`)
   }
+  // A key file a crashed up left behind goes first, whatever this start's form is.
+  rmSync(runKeyFile(config.stateDir), { force: true })
+  // The variable form of the app's key becomes a private file for the controller (spec §8.2):
+  // the controller is given a path, never the key in its environment. Removed on every stop.
+  // Under the state directory on purpose, unlike the operator's own key file (which
+  // deliveryKeyProblems keeps out of it): this copy is up's, lives only while up does, in a
+  // 0700 directory the checkout ignores, and no other process is told where it is.
+  const keyFile =
+    config.delivery !== undefined &&
+    "env" in config.delivery.key &&
+    secrets.githubAppKey !== undefined
+      ? runKeyFile(config.stateDir)
+      : undefined
+  if (keyFile !== undefined)
+    try {
+      mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 })
+      chmodSync(dirname(keyFile), 0o700)
+      writeFileSync(keyFile, secrets.githubAppKey as string, { mode: 0o600, flag: "w" })
+      chmodSync(keyFile, 0o600)
+    } catch (error) {
+      say(
+        `${UP} refused: cannot write the controller's key file (${(error as NodeJS.ErrnoException).code})`,
+      )
+      rmSync(keyFile, { force: true })
+      releaseLock(lock, say)
+      return 1
+    }
   const running = new Map<AppName, Running>()
   // Until stop aborts (0) or something fails (1); the stop below runs after either.
   const supervise = async (): Promise<number> => {
@@ -1123,6 +1247,7 @@ export async function up(
     )
   }
   const clean = await stopAll(running, deps, force, say)
+  if (keyFile !== undefined) rmSync(keyFile, { force: true })
   // A survivor keeps the locks, so the next up names it instead of starting beside it. Whether
   // each exited, never pidAlive of a pid it may not have (review I1).
   if ([...running.values()].every((r) => r.hasExited) && !releaseLock(lock, say)) code = 1
```

- [ ] **Step 5: Run it, and every `up` and config suite**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/up-delivery.test.ts test/factory-up.test.ts test/factory-config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write src/lib/operator/factory-config.ts src/lib/operator/up.ts test/up-delivery.test.ts
git add src/lib/operator/factory-config.ts src/lib/operator/up.ts test/up-delivery.test.ts
git commit -m "feat(software-factory): factory.config.ts delivery.draftPr and up's GitHub App key, for the controller alone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed (Task 20, `349aa31ca`, with the security review fixes of `1835124cb` and the follow-up `fix(software-factory): up refuses a key variable that names PATH …`).** As planned, with these departures. `realUpDeps(config)` takes the config and derives the secret variable names from it (`secretVariablesOf`), with no module-level registry the preflight filled late: `up`'s first `git rev-parse` and `docker info` ran before the preflight read the key, so they inherited it. `ownSubprocessEnv` also drops any variable holding a PEM private key (so `ps`, judging a lock with no config in reach, is covered) and every `GITHUB_APP_` variable. The run copy is written by `writeRunKey`: `<state>/run` must be a real directory the user owns, never a link; the copy is created exclusively (`"wx"`); a leftover that is a directory is refused with the locks released; the copy is removed in a `finally` on stop. `notAKeyPath` (in `jwt.ts`, shared by the config schema, `config.ts` and `loadAppPrivateKey`) refuses a PEM header, a line break or over 1024 characters where a path belongs. No worker inherits any `FACTORY_GITHUB_` variable, and `up` refuses to start beside the retired `FACTORY_GITHUB_TOKEN` or `FACTORY_GITHUB_APP_PRIVATE_KEY`. Redaction withholds any line holding a 24-character run of the key's body, the whole PEM in base64, or its DER in hex. The follow-up: `privateKeyEnv` must match `/^[A-Z][A-Z0-9_]*$/` and may not name an essential or factory-owned variable (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `TMPDIR`, `TMP`, `TEMP`, `TERM`, `TZ`, `LANG`, `LANGUAGE`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_ENV`, `INIT_CWD`, `HOST`, `PORT`, `OPENAI_API_KEY`, `B4_PERMISSIONS_MODE`, `GH_TOKEN`, `GITHUB_TOKEN`, or any `LC_`, `FACTORY_`, `DOCKER_`, `GIT_`, `SSH_`, `XDG_` or `GITHUB_APP_` name), because `up` strips the named variable from every child; the message names the field, never the value. No worker gets `GH_TOKEN`, `GITHUB_TOKEN`, their `_ENTERPRISE_` forms or any `GITHUB_APP_` variable, and the controller gets no `GITHUB_APP_` variable: neither worker calls GitHub (`create --issue` reads the issue through `gh` in the operator's CLI process, and the drafter receives the issue from the controller), so `test/factory-up.test.ts`'s "workers inherit the operator's other variables" now excludes those two tokens. Also in this range, `f18ba1ca5` fixed a racing-approvals test to assert one winner, not that the first call wins.

### Task 21: The opt-in scratch lane, and the contract the fake is held to

**Files:**
- Create: `test/github-contract.ts`, `test/github-contract.test.ts`, `test/github-scratch.github.test.ts`, `vitest.github.config.ts`
- Modify: `vitest.config.ts` (exclude the lane), `package.json` (`test:github-scratch`)
- Create (by Step 3, recorded): `test/fixtures/github-contract.json`

- [ ] **Step 1: The contract's shape, its replay against the fake, and the lane**

`examples/software-factory/controller/test/github-contract.ts`:

```ts
/**
 * What GitHub answered, reduced to a shape that holds no value: per request, the method, the
 * path with every id replaced, the status, and the top-level keys of the JSON body. The
 * scratch lane records it (FACTORY_TEST_GITHUB_RECORD=1) into
 * `test/fixtures/github-contract.json`; the fake server's contract test replays the same
 * delivery and requires the fake to answer every recorded request with the same status and at
 * least the same keys, so the fake cannot drift from GitHub silently (rung 4 spec §14).
 */
export interface ContractEntry {
  readonly method: string
  readonly path: string
  readonly status: number
  readonly keys: readonly string[]
}

/** `path` with its variable parts named, so two runs record the same template. */
export function pathTemplate(path: string): string {
  return path
    .replace(/^\/repos\/[^/]+\/[^/?]+/, "/repos/{o}/{r}")
    .replace(/[0-9a-f]{40}/g, "{sha}")
    .replace(/factory\/wo-[0-9a-f]{16}/g, "factory/{id}")
    .replace(/factory%2Fwo-[0-9a-f]{16}/gi, "factory%2F{id}")
    .replace(/\/\d+(?=\/|$|\?)/g, "/{n}")
    .replace(/head=[^&]+/, "head={head}")
    .replace(/\/users\/[^/]+$/, "/users/{bot}")
}

/** A fetch that records every exchange's shape into `into`, and never a value. */
export function recordingFetch(into: ContractEntry[], inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init)
    const url = new URL(String(input instanceof Request ? input.url : input))
    let keys: string[] = []
    try {
      const body: unknown = await response.clone().json()
      keys = Array.isArray(body)
        ? ["[]"]
        : typeof body === "object" && body !== null
          ? Object.keys(body).sort()
          : []
    } catch {
      keys = []
    }
    into.push({
      method: init?.method ?? "GET",
      path: pathTemplate(`${url.pathname}${url.search}`),
      status: response.status,
      keys,
    })
    return response
  }
}
```

`examples/software-factory/controller/test/github-contract.test.ts`:

```ts
import { generateKeyPairSync } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createGitHubAdapter } from "../src/lib/delivery/github/adapter.ts"
import { closeHarness, harness } from "./delivery-harness.ts"
import { type FakeGitHubServer, startFakeGitHubServer } from "./fake-github-server.ts"
import { type ContractEntry, pathTemplate, recordingFetch } from "./github-contract.ts"

const RECORDED = join(import.meta.dirname, "fixtures", "github-contract.json")
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })

let server: FakeGitHubServer | undefined
afterEach(async () => {
  closeHarness()
  await server?.close()
  server = undefined
})

describe("the fake GitHub against what GitHub answered", () => {
  it("names paths by template, never by value", () => {
    expect(pathTemplate(`/repos/o/r/git/commits/${"a".repeat(40)}`)).toBe(
      "/repos/{o}/{r}/git/commits/{sha}",
    )
    expect(
      pathTemplate(
        "/repos/o/r/pulls?head=o%3Afactory%2Fwo-0123456789abcdef&state=all&per_page=100",
      ),
    ).toBe("/repos/{o}/{r}/pulls?head={head}&state=all&per_page=100")
    expect(pathTemplate("/app/installations/42/access_tokens")).toBe(
      "/app/installations/{n}/access_tokens",
    )
  })

  it.skipIf(!existsSync(RECORDED))(
    "answers every request the scratch lane recorded with GitHub's status and at least its keys",
    async () => {
      const recorded = JSON.parse(readFileSync(RECORDED, "utf8")) as ContractEntry[]
      server = await startFakeGitHubServer()
      const seen: ContractEntry[] = []
      const adapter = createGitHubAdapter({
        repository: "cacheplane/b4run",
        appId: 1,
        privateKey,
        baseBranch: "main",
        baseUrl: server.url,
        fetch: recordingFetch(seen),
      })
      const h = await harness({ github: server.repo, adapter })
      expect((await h.deliver()).state).toBe("delivered")
      for (const entry of recorded.filter((e) => e.status < 300)) {
        const ours = seen.find((s) => s.method === entry.method && s.path === entry.path)
        expect(ours, `${entry.method} ${entry.path}`).toBeDefined()
        expect(ours?.status).toBe(entry.status)
        for (const key of entry.keys) expect(ours?.keys, `${entry.path} ${key}`).toContain(key)
      }
    },
  )
})
```

`examples/software-factory/controller/test/github-scratch.github.test.ts`:

````ts
import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { DeliveryError } from "../src/lib/delivery/adapter.ts"
import { createGitHubAdapter } from "../src/lib/delivery/github/adapter.ts"
import { loadAppPrivateKey } from "../src/lib/delivery/github/jwt.ts"
import { closeHarness, harness } from "./delivery-harness.ts"
import { type ContractEntry, recordingFetch } from "./github-contract.ts"

/**
 * The opt-in lane against a scratch repository Brian owns (rung 4 spec §14). Never in CI:
 * it needs FACTORY_TEST_GITHUB_SCRATCH=<owner/name>, FACTORY_TEST_GITHUB_APP_ID and
 * FACTORY_TEST_GITHUB_APP_KEY_FILE (a 0600 PEM), and the scratch repository prepared by the
 * operator setup task: `main` holding packages/devkit/src/testing/process.ts as
 * "export const deadline = 'leaks'\n", issue #1 open, the app installed with the delivery
 * permissions and no `workflows`, and the three rulesets. Each run creates a branch and a
 * draft PR per case and leaves them for the operator to inspect and delete.
 *
 * The negative probes (a branch outside factory/, a tag, an update to its own branch, a
 * workflow change) are sent with raw fetch and the installation token: the adapter refuses to
 * send them at all, which is the point, so only a raw request can show GitHub refuses them too.
 */
const scratch = process.env.FACTORY_TEST_GITHUB_SCRATCH
const appId = Number(process.env.FACTORY_TEST_GITHUB_APP_ID)
const keyFile = process.env.FACTORY_TEST_GITHUB_APP_KEY_FILE
const enabled = scratch !== undefined && Number.isInteger(appId) && keyFile !== undefined
const API = "https://api.github.com"
const contract: ContractEntry[] = []

const freshId = () => `wo-${randomBytes(8).toString("hex")}`

afterAll(() => {
  closeHarness()
  if (!enabled || process.env.FACTORY_TEST_GITHUB_RECORD !== "1") return
  const dir = join(import.meta.dirname, "fixtures")
  mkdirSync(dir, { recursive: true })
  const unique = new Map(contract.map((e) => [`${e.method} ${e.path} ${e.status}`, e]))
  writeFileSync(
    join(dir, "github-contract.json"),
    `${JSON.stringify([...unique.values()], null, 2)}\n`,
  )
})

describe.skipIf(!enabled)("delivery against a real scratch repository", () => {
  const adapter = () =>
    createGitHubAdapter({
      repository: scratch as string,
      appId,
      privateKey: loadAppPrivateKey(keyFile as string),
      baseBranch: "main",
      fetch: recordingFetch(contract),
    })
  const mainTip = async (token: string) => {
    const response = await fetch(`${API}/repos/${scratch}/git/ref/heads/main`, {
      headers: { authorization: `token ${token}`, accept: "application/vnd.github+json" },
    })
    return ((await response.json()) as { object: { sha: string } }).object.sha
  }
  /** A session's token, for the raw probes only. */
  const tokenOf = async (a: ReturnType<typeof adapter>) => {
    await a.open(scratch as string, new AbortController().signal)
    return a.secrets()[0] as string
  }

  it("delivers a change as one draft pull request, and reads it back", async () => {
    const a = adapter()
    const pin = await mainTip(await tokenOf(a))
    const h = await harness({
      adapter: a,
      remote: { repository: scratch as string, pin, id: freshId() },
    })
    const row = await h.deliver()
    expect(row.state, h.journal()).toBe("delivered")
    expect(h.store.delivery(row.id)?.pullRequest?.url).toMatch(/\/pull\/\d+$/)
  }, 120_000)

  it("converges after a lost response to the ref create", async () => {
    let dropped = false
    const lossy: typeof fetch = async (input, init) => {
      const response = await recordingFetch(contract)(input, init)
      if (!dropped && init?.method === "POST" && String(input).endsWith("/git/refs")) {
        dropped = true
        throw new TypeError("fetch failed (dropped by the test)")
      }
      return response
    }
    const a = createGitHubAdapter({
      repository: scratch as string,
      appId,
      privateKey: loadAppPrivateKey(keyFile as string),
      baseBranch: "main",
      fetch: lossy,
    })
    const pin = await mainTip(await tokenOf(a))
    const h = await harness({
      adapter: a,
      remote: { repository: scratch as string, pin, id: freshId() },
    })
    expect((await h.deliver()).state, h.journal()).toBe("delivered")
    expect(dropped).toBe(true)
  }, 120_000)

  it("is refused by the rulesets outside factory/, on a tag, and on moving its own branch", async () => {
    const a = adapter()
    const token = await tokenOf(a)
    const sha = await mainTip(token)
    const post = (path: string, body: unknown, method = "POST") =>
      fetch(`${API}/repos/${scratch}${path}`, {
        method,
        headers: { authorization: `token ${token}`, accept: "application/vnd.github+json" },
        body: JSON.stringify(body),
      })
    const outside = await post("/git/refs", { ref: `refs/heads/not-factory-${freshId()}`, sha })
    expect(outside.status, await outside.text()).toBeGreaterThanOrEqual(400)
    const tag = await post("/git/refs", { ref: `refs/tags/factory-${freshId()}`, sha })
    expect(tag.status, await tag.text()).toBeGreaterThanOrEqual(400)
    const own = freshId()
    const made = await post("/git/refs", { ref: `refs/heads/factory/${own}`, sha })
    expect(made.status, await made.text()).toBe(201)
    const session = await a.open(scratch as string, new AbortController().signal)
    const child = await session.createCommit({
      message: "probe",
      tree: (await session.commit(sha)).tree,
      parents: [sha],
      author: { ...session.identity, date: new Date().toISOString() },
      committer: { ...session.identity, date: new Date().toISOString() },
    })
    // Fast-forward, not even a force: "restrict updates" refuses the app any move.
    const moved = await post(`/git/refs/heads/factory/${own}`, { sha: child }, "PATCH")
    expect(moved.status, await moved.text()).toBeGreaterThanOrEqual(400)
  }, 120_000)

  it("cannot create a branch whose commit changes .github/workflows without the workflows permission", async () => {
    const a = adapter()
    const session = await a.open(scratch as string, new AbortController().signal)
    const pin = (await session.commit(await mainTip(a.secrets()[0] as string))).sha
    const pinTree = (await session.commit(pin)).tree
    const blob = await session.createBlob("name: injected\non: push\njobs: {}\n")
    const tree = await session.createTree(pinTree, [
      { path: ".github/workflows/injected.yml", mode: "100644", sha: blob },
    ])
    const commit = await session.createCommit({
      message: "probe",
      tree,
      parents: [pin],
      author: { ...session.identity, date: new Date().toISOString() },
      committer: { ...session.identity, date: new Date().toISOString() },
    })
    await expect(session.createBranch(`factory/${freshId()}`, commit)).rejects.toBeInstanceOf(
      DeliveryError,
    )
  }, 120_000)

  it("links no issue from a closing keyword inside the spec's fence", async () => {
    const a = adapter()
    const pin = await mainTip(await tokenOf(a))
    const id = freshId()
    const h = await harness({
      adapter: a,
      remote: { repository: scratch as string, pin, id },
      specText: "# Probe\n\n```\nFixes #1\n```\n\nCloses #1\n",
    })
    expect((await h.deliver()).state, h.journal()).toBe("delivered")
  }, 120_000)
})
````

`examples/software-factory/controller/vitest.github.config.ts`:

```ts
import { defineConfig } from "vitest/config"

/**
 * The opt-in lane against a real scratch repository (rung 4 spec §14): never in CI, skipped
 * unless FACTORY_TEST_GITHUB_SCRATCH and the app's credentials are set.
 */
export default defineConfig({
  test: {
    name: "software-factory-controller-github",
    include: ["test/**/*.github.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    env: { FACTORY_CONFIG: "none" },
  },
})
```

```diff
diff --git a/examples/software-factory/controller/vitest.config.ts b/examples/software-factory/controller/vitest.config.ts
index 5a2f4af93..cade2bd2e 100644
--- a/examples/software-factory/controller/vitest.config.ts
+++ b/examples/software-factory/controller/vitest.config.ts
@@ -4,7 +4,9 @@ export default defineConfig({
   test: {
     name: "software-factory-controller",
     include: ["test/**/*.test.ts"],
-    exclude: ["test/**/*.integration.test.ts"],
+    // The Docker lanes run under vitest.sandbox.config.ts, the opt-in GitHub scratch lane under
+    // vitest.github.config.ts: neither belongs in the unit run.
+    exclude: ["test/**/*.integration.test.ts", "test/**/*.github.test.ts"],
     fileParallelism: false,
     testTimeout: 30_000,
     setupFiles: ["test/setup-images.ts"],
```

```diff
diff --git a/examples/software-factory/controller/package.json b/examples/software-factory/controller/package.json
index f431c24b1..00eaa0af4 100644
--- a/examples/software-factory/controller/package.json
+++ b/examples/software-factory/controller/package.json
@@ -6,6 +6,7 @@
   "scripts": {
     "test": "vitest run",
     "test:sandbox": "vitest run --config vitest.sandbox.config.ts",
+    "test:github-scratch": "vitest run --config vitest.github.config.ts",
     "test:sandbox:cli": "FACTORY_TEST_CLI_TARGET=1 vitest run --config vitest.sandbox.config.ts test/target-cli.integration.test.ts test/target-init.integration.test.ts",
     "typecheck": "tsc -p . --noEmit",
     "lint": "biome check .",
```

- [ ] **Step 2: Without credentials, the lane skips and the unit run excludes it**

Run: `pnpm exec tsc -p . --noEmit && pnpm exec vitest run test/github-contract.test.ts && pnpm test:github-scratch`
Expected: the contract test's template case passes and its replay case is skipped (no fixture yet); the lane: 5 skipped.

- [ ] **Step 3: Run the lane against the scratch repository, by hand, with Brian's credentials** (Task 4 Steps 1-5 done; never in CI; the agent never sees the key, it is read from Brian's file):

```bash
FACTORY_TEST_GITHUB_SCRATCH=cacheplane/b4-factory-scratch \
FACTORY_TEST_GITHUB_APP_ID=<the app id> \
FACTORY_TEST_GITHUB_APP_KEY_FILE=$HOME/.config/b4-factory/app.pem \
FACTORY_TEST_GITHUB_RECORD=1 \
pnpm test:github-scratch
```

Expected: 5 passed: a clean delivery; one after a dropped ref response; the rulesets refuse a branch outside `factory/`, a tag and a fast-forward of the app's own branch (each status ≥ 400); GitHub refuses the ref for a commit changing `.github/workflows/` (the app has no `workflows`); a fenced `Fixes #1` and an unfenced `Closes #1` inside the quoted spec link nothing (the delivery confirms, so `closingIssuesReferences` was empty). `test/fixtures/github-contract.json` is written: method, path template, status and top-level keys only, no value (check with `grep -E 'ghs_|eyJ|BEGIN' test/fixtures/github-contract.json` → nothing). If the issues read worked, try it once without `issues: read` (D5) and record the answer. Record the run (date, each case's result, any 4xx body) in the PR description.

If a case fails, it is information about GitHub, not a flake: fix the fake and the adapter to what GitHub does, re-run Task 18's and Task 11's tests, and re-run the lane.

- [ ] **Step 4: The contract replay now runs**

Run: `pnpm exec vitest run test/github-contract.test.ts`
Expected: 2 passed (the fake answers every recorded 2xx request with GitHub's status and at least its keys).

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write test/github-contract.ts test/github-contract.test.ts test/github-scratch.github.test.ts vitest.github.config.ts vitest.config.ts package.json
git add test/github-contract.ts test/github-contract.test.ts test/github-scratch.github.test.ts vitest.github.config.ts vitest.config.ts package.json test/fixtures/github-contract.json
git commit -m "test(software-factory): the opt-in GitHub scratch lane and the contract the fake GitHub replays

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed (Task 21, `cbb16b4ac`).** As planned, with three departures. The contract replay matches each recorded success by method, path template **and status**, since one template is answered 404 then 200 in one delivery. The scratch lane's deliveries come from the scratch repository's issue #1, so `test/delivery-harness.ts` takes an `issue` option on the remote. Each case closes its own harness in an `afterEach`. Steps 3 and 4 have not run: the app and the scratch repository did not exist yet, so `test/fixtures/github-contract.json` is not recorded and the replay case skips; Step 2's skip was confirmed (5 skipped).

### Task 22: Docs for PR 4, and the whole gate

**Files:**
- Modify: `examples/software-factory/README.md`, `docs/superpowers/specs/2026-10-01-software-factory-rung4-design.md`

- [ ] **Step 1: README.** Extend the PR 3 section: setting up the app (point to the spec's §10 and this plan's Task 4, not a copy of it); enabling delivery in a local config (`factory.config.local.ts` via `FACTORY_CONFIG`, as the README already describes for ports) with

```ts
delivery: {
  draftPr: {
    repository: "cacheplane/b4run",
    baseBranch: "main",
    app: { id: 123456, privateKeyFile: "~/.config/b4-factory/app.pem" },
  },
},
```

(or `privateKeyEnv: "B4_FACTORY_APP_KEY"`); what `up` prints for it (`GitHub App <id>: key from <where> (controller only, as a file)`); what the controller holds and never holds (spec §10.5's table); and `pnpm --filter @b4-example/software-factory-controller test:github-scratch` as the opt-in lane. The committed `factory.config.ts` stays without `delivery`: a fresh checkout delivers locally.

- [ ] **Step 2: Spec as-landed note** under §13: "**As landed (PR 4).**", this plan's link, D5, D8, D15, D16, D17, Spec corrections 3, 4, 7, and the scratch lane's recorded results.

- [ ] **Step 3: The gate, then commit and open PR 4**

```bash
cd ../../.. # repository root
pnpm --filter @b4-example/software-factory-controller lint
pnpm --filter @b4-example/software-factory-controller typecheck
pnpm --filter @b4-example/software-factory-controller test
node scripts/check-docs.mjs
git add examples/software-factory/README.md docs/superpowers/specs/2026-10-01-software-factory-rung4-design.md
git commit -m "docs(software-factory): delivering through the GitHub App, and the rung 4 spec's as-landed note for PR 4

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**As landed (Task 22).** The README's rung 4 section no longer says delivery is unusable: it documents setting up the app (pointing at spec §10 and Task 4), enabling `delivery.draftPr` in `factory.config.local.ts` through `FACTORY_CONFIG`, `privateKeyFile` versus `privateKeyEnv` and what each refuses, the line `up` prints, the controller's four variables and the run copy, who holds what (spec §10.5's table, widened to the GitHub tokens and `GITHUB_APP_` variables), the allow-list in brief, the scratch lane with its three variables and `FACTORY_TEST_GITHUB_RECORD=1`, the contract fixture step, what is still manual, and the known follow-ups; `up`'s paragraph says no process gets `GH_TOKEN`, `GITHUB_TOKEN` or a `GITHUB_APP_` variable. The spec gained "As landed (PR 4)" under §13 (D5, D8, D15, D16, D17, corrections 3, 4, 7, the wider scrubbing, and no scratch results yet). This plan gained the as-landed notes for Tasks 17-22 and PR 4's follow-ups. No `apps/web` page changed, so the SEO manifest did not move. The gate, after `pnpm install --frozen-lockfile` and `pnpm build`: the controller's `lint` (266 files, clean), `typecheck` (clean) and `test` (1,359 passed, 1 skipped, 102 files), `test:github-scratch` (5 skipped, no variables set), the root `pnpm lint` (31 tasks), `node scripts/check-docs.mjs` (passed), `pnpm test:release-integrity` (33 passed) and `node --test scripts/release/test/workflow-contracts.test.mjs` (188 passed).

---

# PR 5: The live run, by hand

### Task 23: Two cases on `cacheplane/b4run`, Brian at both gates

Not a CI lane, and never driven past a gate by an agent: an agent runs the commands, shows Brian the draft and the bundle (the display, the digest, the oracle proof or receipt, and for the bundle the Delivery block), and waits; Brian types the prefixes himself (rung 3's Trap 4).

- [ ] **Step 1: Preconditions, read-only**

```bash
git fetch origin && git grep -n "b4-factory\[bot\]" origin/main -- .github/workflows   # PR 1 is on main: three hits
gh api 'repos/cacheplane/b4run/branches?per_page=100' -q '.[].name' | grep '^factory/' || echo "no factory branch yet"
gh api repos/cacheplane/b4run/rules/branches/main -q '[.[].type]'   # includes "update"
gh api repos/cacheplane/b4run/rules/branches/factory/wo-0000000000000000 -q '[.[].type]'   # "update", "non_fast_forward"
```

Stop if PR 1's guard is not on `main` (Trap 8) or a ruleset is missing.

- [ ] **Step 2: Start the factory with delivery** (a local config holding Task 22's `delivery` block; the windows from the up/run plan's D24 and the target's budget):

```bash
cd examples/software-factory
FACTORY_CONFIG=factory.config.local.ts FACTORY_MAX_ACTIVE_MS=18000000 FACTORY_APPROVAL_TTL_MS=86400000 pnpm factory up
```

Expected: `GitHub App <id>: key from … (controller only, as a file)` and `ready … (reconciled)`.

- [ ] **Step 3: Case 1, a fresh open issue at `main`'s tip** (D13; Brian picks it):

```bash
FACTORY_CONFIG=factory.config.local.ts pnpm factory run --issue <n> --deliver draft-pr
```

At the draft and at the bundle, Brian reviews and types the prefix. Expected after the bundle: `delivering`, then `Delivered as https://github.com/cacheplane/b4run/pull/<m>`, exit 0. Then check, read-only, and record each:

```bash
gh pr view <m> --repo cacheplane/b4run --json author,isDraft,headRefName,baseRefName,body,closingIssuesReferences
gh pr checks <m> --repo cacheplane/b4run
```

Author `app/b4-factory`, draft, head `factory/wo-…`, base `main`, body starts `Refs #<n>`, no closing reference; `vercel-native`, `auto-approve` and `claude-review` skipped (or absent), `validate` ran; no Vercel preview deployment for the branch (the Vercel dashboard, or `gh api repos/cacheplane/b4run/deployments?ref=factory/wo-…` empty). Run the same `run` again: "Already delivered as …", exit 0, no second PR. Brian decides the PR's fate (D11).

- [ ] **Step 4: Case 2, the refusal path: a replay of #714 at its old pin**

```bash
FACTORY_CONFIG=factory.config.local.ts pnpm factory run --issue 714 --pin 765e6e16fec86bba0859d3f85edf7136f663f720 --deliver draft-pr --new
```

Brian approves at both gates as before. Expected: `blocked` with `delivery_base_conflict`, the journal naming the touched file (`pnpm factory events <id> | grep delivery_refused`), exit 1, `run`'s next commands without `redeliver`, and nothing created on GitHub (`gh api 'repos/cacheplane/b4run/git/matching-refs/heads/factory/<id>'` → `[]`).

- [ ] **Step 5: Stop the factory between gates** (one Ctrl-C; `<state>/run/github-app.pem` gone if the variable form was used) and **record** in the spec's §14 as-landed note and the PR: both work order ids, the PR URL, each phase's wall clock, the gate decisions, the checks of Step 3, the refusal of Step 4, D12's Vercel finding, and every step that needed knowledge the README does not give.

---

## Proof map

| Proof (spec §14 and the hard rules) | Where |
|---|---|
| Secret-bearing, deploying and writing PR jobs skip every factory PR; a person's PR still runs them; push to `main` still runs `vercel-native` | Task 3 (behavioural test, 13 mutations incl. the guard behind an `||`, a misspelt login, `head.label`, a new secret job, forbidden triggers, a widened push) |
| The Vercel preview never builds `factory/*` | Task 1 |
| The files the guard lives in cannot be changed by a delivery | Task 3 (cross-check against `guard.json` and `vercel.json`), Task 10 (`isProtectedPath`), Task 12 (intake refusal), Task 13 (approval refusal), Task 11 (a protected path changed on `main` refuses) |
| `run` never approves and never redelivers | Task 15 (the source pin forbids `.redeliver`), Task 5 (no step kind redelivers; the next commands only name it) |
| One gate, bound in the bundle digest; old bundles unchanged | Task 7 (golden digest; every delivery field moves the digest), Task 13 (`Delivery` invalidation, configured destination) |
| The approval commits the intent atomically | Task 13 (the one transaction), Task 9 (one row per work order) |
| A clean delivery; the receipt's tree equals the locally computed one | Task 11, Task 18 (over HTTP), Task 13 (through the factory) |
| A response lost after each write converges on one ref and one PR | Task 11 (five writes), Task 18 (422 ref, 422 PR over HTTP), Task 21 (real GitHub) |
| A restart at every step boundary | Task 11 (four boundaries), Task 13 (close and boot reconcile) |
| 422 ref with ours / with another commit; PR exists; PR closed | Task 11 |
| 401, plain 403, mint refusal, narrow mint, app not installed → unauthorized | Task 11, Task 18 |
| 429 and rate-limit 403 within and past the bound; 5xx past the bound; the run bound | Task 11 (waits asserted), Task 18 (headers) |
| Base drift: touched file, rename, protected path, diverged, too large | Task 11, Task 18 (300 files) |
| Pin blob is not the baseline | Task 11 |
| GitHub returns a blob or tree id the local computation disagrees with | Task 11 |
| A fence that holds; a non-empty closing reference blocks | Task 10, Task 11, Task 21 (real GitHub) |
| The allow-list refuses PATCH, PUT, DELETE, another repository, a ref outside `factory/` | Task 17 |
| No token, JWT, PEM or Authorization header in the journal or the outbox | Task 11, Task 18 (the real installation token), Task 12 (preflight's message) |
| The key never reaches a worker, `up`'s own tools, argv or a log; the controller gets a path; its variables are consumed | Task 20, Task 19 |
| Cancel between steps; `redeliver` from each healable reason, refused otherwise and after the window | Task 11, Task 14, Task 5 |
| `delivered` only after the read-back | Task 11 (confirm checks author, head, base, parents, tree, closing references) |
| The rulesets and the missing `workflows` permission refuse what the code never asks | Task 21 (real GitHub) |
| A secret job gated on a job output or `failure()`, a forbidden trigger (`issue_comment` …), a local reusable workflow that deploys, a `pull_request` workflow without top-level permissions: all refused; the `head_ref` spelling of the guard accepted | Task 2 (three-valued evaluation), Task 3 (mutations) |
| A `.github` change on `main` since the pin delivers; a change to the files the branch's own build runs refuses | Task 11, Task 3 (`runFromBranchPaths` pinned) |
| A controller close mid-request or between steps leaves `delivering`, and the next run delivers | Task 11 (in memory), Task 18 (over HTTP), Task 13 (close and boot) |
| A hung request is bounded and retried; a redirect is never followed; a path `fetch` would normalise is refused | Task 18, Task 17 |
| No issue reference survives in the title or the commit subject | Task 10 |
| An approval for one destination is never delivered to another | Task 18 (`open` bound), Task 14 (restart with another base) |
| The fake matches GitHub | Task 21 (recorded contract, replayed) |
| Live: a real draft PR, the guards skipping, no duplicate; the refusal path with nothing created | Task 23 |

## Follow-ups recorded, not in this plan

- **Drop `issues: read`** if the scratch lane shows reading a public issue does not need it (D5).
- **A Vercel-side `factory/*` exclusion**, if Task 4 Step 6 found one, recorded; if not, ask Vercel.
- **A delivery view in `factory events`** (each step's observed ids in one line) once the live run shows what operators read.
- **The `repositoryId: taskId` misnomer** (spec §16) stays: removing it moves every export-local digest.
- **The controller's remaining synchronous calls** (the up/run plan's follow-up) now include `readGeneratedTask` at approve; small, but on the request path.
- **The adapter must refuse a `truncated: true` tree listing** (Task 18's `tree()` does, now as the `incomplete` error kind; keep it): `readPinListings` now also refuses a listing that does not hash to its tree id, which a truncated listing never does, but the adapter's refusal names the cause.
- **PR 4's review follow-ups, not fixed:**
  - The **ruleset read** (`branchRules`) takes the first page only; preflight uses the rule types it reads (`update` on the base branch, `update` and `non_fast_forward` on the factory branch), so a rule listed past the first page would read as missing.
  - A **300-file compare** body is assumed to fit the 10 MiB response cap; a page of large patches could exceed it and read as unexpected rather than `delivery_base_conflict`.
  - The **commit date** is sent as a millisecond ISO string; GitHub's echo may differ in precision, which matters only if a read-back ever compares it.
  - The fake GitHub will need **GitHub's extra top-level keys** once the first scratch run records the contract: the replay requires the fake to answer at least the recorded keys.
  - The `privateKeyEnv` **run copy cannot be removed early** (once the controller is ready): `openFactory`'s retry re-reads the key file, so the copy lives until `up` stops.
  - Whether `GET /repos/{owner}/{repo}` answers `squash_merge_commit_message` and `merge_commit_message` to the app's installation token is for the scratch lane to confirm: preflight refuses only `PR_BODY`, and reads a missing field as not saying.

**Done in the follow-up PR** (`blove/factory-rung4-followups`, stacked on PR 4):

- **Cancel a delivery without the builder** (D24): `finishCancel` skips the builder for a row with an approved bundle, so cancelling a delivery settles `cancelled` with the builder stopped.
- **An empty actor**: `approve` and `deny` check the factory's actor against the approval's `decidedBy` schema before they begin their operation key, so `""` is a refusal and no key is left in flight. (The route's `ApproveInput` still carries no actor.)
- **The CLI's `redeliver`** refuses a reason outside `REDELIVERABLE_BLOCKED_REASONS` before it shows the delivery or asks for the digest's prefix, naming `cancel` and `run … --new`.
- **A truncated tree listing** blocks as `delivery_baseline_mismatch` (not redeliverable), the block a listing that does not hash to its tree already gets: the pin cannot be compared with the baseline. No new reason.
- **A hard link to the key file**: `deliveryKeyProblems` and `loadAppPrivateKey` refuse `nlink > 1`.
- **A transferred (301) or deleted (410) issue**: the adapter answers `gone` (the 301 never followed) and the worker blocks `delivery_issue_closed`.
- **Preflight refuses a repository whose squash or merge commit message is `PR_BODY`**: the session carries both settings from the repository read at open; the allow-list is unchanged.

## Self-review

- **Spec coverage.** §3.1 create and run (Tasks 12, 15), §3.2 row and migration (Task 6), §3.3 bundle (Task 7), §3.4 approval's checks (Task 13, order D21), §4 lifecycle (Task 5) and cancel (Task 11, D24), §5.1 outbox (Tasks 6, 9, 13), §5.2 steps (Task 11), §5.3 inline worker (Task 13), §5.4 reconcile (Task 13, D19), §6.1 tokens (Tasks 17, 18), §6.2 allow-list (Task 17, D15), §6.3 commit building (Tasks 8, 11), §6.4 applies-cleanly (Task 11), §6.5 rate limits and bound (Tasks 11, 17), §7.1-7.3 title, body, closing check (Tasks 10, 11), §7.4 display (Task 15), §8.1 config (Task 20), §8.2 `up` and the controller (Tasks 19, 20, D16, D17), §8.3 scrubbing (Tasks 10, 11, 18), §9.1-9.2 guards (Tasks 1, 3), §9.3 protected paths (Tasks 3, 10, 12, 13), §9.4 the test (Task 3, D3), §10.2 rulesets (Task 4, D22) and preflight's ruleset read (Tasks 12, 13), §11 the person's review (Task 16, D11), §12 every failure mode (Proof map), §13 order (PR split, D1), §14 proof (Proof map), §15 every item (D4-D13). §16 out of scope: nothing in the adapter merges, readies, closes, labels or comments; no Workbench view.
- **Hard rules.** `run` never approves (unchanged) and never redelivers (Task 15 pin). One gate, in the digest (Task 7). The credential: never to a worker (Task 20), never logged (Tasks 11, 18, 20 redaction), never in argv (the key is a file path in an environment variable read once; nothing passes it on a command line), scrubbed from `up`'s children (Task 20 `ownSubprocessEnv`) and consumed from the controller's environment (Task 19). No PATCH/PUT/DELETE (Task 17's sweep; the interface has none). No rebase or force-push (the interface cannot move a ref; the ruleset forbids it, Task 21). `delivered` only after the read-back (Task 11 confirm). Refusals recorded (every `Stop` journals `delivery_refused` with its reason; only transient and rate-limited failures retry, bounded). PR 1 before any `factory/*` branch (Trap 8, Task 23 Step 1).
- **Placeholder scan.** Every code step has its code (new files whole; changes as diffs or exact old/new text). Three values only a person supplies: the app id (Task 4, 21, 23), the live issue number (Task 23, D13), and the PR number the live run creates. Two by-hand outcomes are recorded where they go (Task 21 Step 3, Task 23 Step 5).
- **Type consistency.** `RowDelivery` (Task 6) is what `createFromIssue` builds (Task 12) and approve compares (Task 13). `DraftPrBundleDelivery` and `draftPrDestinationId` (Task 7) are what verify freezes (Task 12) and approve checks (Task 13). `DeliveryIntent` and `DeliveryRemote` (Task 9) are what `buildDeliveryIntent` returns (Task 12), the worker reads (Task 11) and `redeliver`'s CLI displays (Task 15). `DeliveryAdapter`/`DeliverySession` (Task 9) are implemented by the in-memory fake (Task 11) and the real adapter (Task 18) and consumed by `preflightDelivery` (Task 12) and `runDelivery` (Task 11). `DraftPrConfig` (Task 12) is `FactoryOptions.delivery.draftPr` (Task 12) and the runtime's wiring (Task 19). `FACTORY_BOT_LOGIN` (Task 10) is preflight's comparison (Task 12) and `http.ts`'s user check (Task 17), from `guard.json` (Task 1), which the contract test reads (Task 3).
- **YAGNI.** No new dependency (JWT and hashing with `node:crypto`). No Workbench. No standing token. One repository per controller.

## Review amendments (2026-10-01)

An independent review executed PR 1 and PRs 3-4 task by task in a scratch checkout: green at every task but Task 1's lint; no Critical; nine Important; minors. Every item is applied in place; the amended code was prototyped again (the controller's 1,255 unit tests, the contract and evaluator tests, `pnpm test:release-integrity`, `pnpm test:release-controller`, `pnpm --dir apps/web lint` and the web test all green, Trap 10 aside) and removed before this commit.

| # | Finding | Where addressed |
|---|---|---|
| I1a | The guard test's fixed context answered every job output "false" and `failure()` false, so a secret job gated on an output or on `failure()` passed | D3 amended; Task 2: three-valued evaluation (`UNKNOWN`, `unknownByDefault`) and its test; Task 3: `factoryContext` states only event, repository, head ref and author, and a job passes only when its `if:` is definitely false; mutations "a secret job gated only on a job output", "a secret job that runs on failure()" |
| I1b | The trigger deny-list missed `issue_comment`, `pull_request_review`, `create`, … (and `issue_comment` makes `github.event.pull_request` null) | D3: an allow-list (`pull_request`, `push` to `main`, `schedule`, `workflow_dispatch`, `workflow_call`, `branch_protection_rule`); Task 3 `ALLOWED_TRIGGERS`; mutation "claude-review also on issue_comment" |
| I1c | A local reusable workflow whose job names an environment was not flagged | Task 3 `guardReasons` resolves `./.github/workflows/*.yml` and takes its jobs' reasons; a non-local `uses:` is a reason; mutation "a local reusable workflow whose job deploys" |
| I1d | No requirement for top-level `permissions` on a `pull_request` workflow | Task 3; mutation "a pull_request workflow with no top-level permissions" |
| I1 (minor) | `github.head_ref` was unknown to the context: a false positive | Both contexts state `head_ref`; Task 3 asserts the `head_ref` spelling of the guard passes |
| I2 | Any `.github/**` change on `main` since the pin blocked delivery permanently (41 such commits last month) | D30; Spec correction 13; `guard.json` gains `runFromBranchPaths` (Task 1), `guard.ts` `isRunFromBranchPath` (Task 10), the drift check uses it (Task 11), the contract test pins it (Task 3); tests "delivers although main changed .github", "the Vercel ignore script, which the branch's own build runs" |
| I3 | A close during a request became `delivery_unconfirmed` | D26; Trap 21; Task 11 `attempt` and `runDelivery`'s catch check `ctx.signal.aborted` first, the loop's between-step stop journals too; tests in Task 11 (in memory) and Task 18 (over HTTP) |
| I4 | No per-request timeout | D25; Task 17 (`timeoutMs`, `AbortSignal.any`), Task 18 (`requestTimeoutMs`, test "gives up on a request past its bound"); the retry's journal line now carries the scrubbed reason |
| I5 | `..` in a branch reached another path after `fetch` normalised it; redirects were followed | D28; Trap 23; Task 17: segment checks, origin and pathname compared on the `URL` handed to `fetch`, `redirect: "manual"` with a 3xx as `unexpected`; tests in Task 17 and Task 18 ("never follows a redirect") |
| I6 | A model-written title or commit subject could carry `Fix #77` | D29; Spec correction 16; Task 10 `neutraliseReferences` in `pullTitle` and `commitMessage`, and its test. Applied differently: references are broken, keywords left as words (D29 says why) |
| I7 | Task 1's test hunk was in tabs and semicolons; the shared config is two spaces, no semicolons | Task 1 hunk regenerated in the file's style; Step 5 runs `pnpm --dir apps/web lint`; Trap 2 corrected |
| I8 | Protected paths were not re-checked at delivery | Task 11 step (a) refuses `protectedPathsIn(intent.paths)` before any request; test "refuses a change to a protected path at delivery" |
| I9 | The adapter was not bound to the configured repository | D27; Task 18 `repository` option and `open()` refusal; Task 13 `startDelivery` compares the intent with the configuration (approve, reconcile and redeliver all pass through it); tests in Task 18 and Task 14 |
| m1 | Pin the mint body | Task 18: the mint request is asserted at `/app/installations/42/access_tokens` (the id the adapter just read) with exactly `repositories: [name]` and the four permissions |
| m2 | Assert every request passed the allow-list | Task 18: a recording `fetch` checks every request against `allowedRoute` as sent |
| m3 | Compare the bundle's operation with the row's delivery both ways | Task 13 (c): an export-local bundle on a draft-PR row invalidates as `Delivery` |
| m4 | Task 20 key file inside the state directory; key material in failing assertions | Task 20 Step 4 justifies the run copy's place and removes a leftover at start; Trap 22; the tests assert booleans |
| m5 | Delete the credential variables even when the runtime refuses | Task 19: `finally` |
| m6 | One `token` shared across sessions | Task 18: per session; `secrets()` names every minted token |
| m7 | `isOurs` adopts another author's identical commit | Accepted and documented on `isOurs` (Task 11): the bytes are the approved bytes; only the app can create `factory/*`; confirm still requires the bot as the PR's author |
| m8 | Scrub in `track()` | Task 13 Step 3 |
| m9 | Task 6's hunks did not `git apply` | Task 6 Steps 3 and 7 are now whole-file diffs against `main`, checked with `git apply --check` |
| m10 | List every Vercel project linked to the repository | Task 4 Step 6 |
| m11 | The header's test count | Header |

**Where I applied a finding differently.** I5: `redirect: "manual"` with the 3xx refused, rather than `"error"`: the same refusal, with the status in the journal instead of `fetch failed`. I6: references neutralised, keywords not (D29). Neither changes what is refused.

