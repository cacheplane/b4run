# Handoff: software factory, rung 4 (delivery as a draft pull request)

**Snapshot date: 2026-10-02.** This is a point-in-time note. The PR and setup states below go stale once someone acts on them. The sections on decisions, on what is proven, on traps and on follow-ups stay true.

---

## 1. State at a glance

All of rung 4's code is merged to `main`. No branch has unmerged work, and no PR is open. **What's left is an operator step and a live run.** Both wait on Brian creating the GitHub App and its rulesets (plan Task 4).

| Change | PR | Commit on `main` |
|---|---|---|
| PR 1: CI guards so a `factory/*` branch or the bot never reaches a secret-bearing job | [#884](https://github.com/cacheplane/b4run/pull/884) | `5bc69004` |
| PR 3: delivery bound in the bundle, against a fake GitHub | [#894](https://github.com/cacheplane/b4run/pull/894) | `df718980` |
| PR 4: GitHub App JWT and the allow-listed request, the real adapter, controller config, `up` credential wiring, opt-in scratch lane | [#900](https://github.com/cacheplane/b4run/pull/900) | `c14be623` |
| Rung 4 follow-ups (empty actor, redeliver advice, issue gone, hard-linked key, `PR_BODY` preflight, cancel without builder) | [#901](https://github.com/cacheplane/b4run/pull/901) | `1b25f074` |
| Flaky approval-race test (it asserted call order instead of one winner) | [#899](https://github.com/cacheplane/b4run/pull/899) | `60d40665` |

There is no PR 2: in the plan's split, "PR 2" is Brian's GitHub setup (Task 4).

Earlier in the same arc, also merged:
- [#868](https://github.com/cacheplane/b4run/pull/868) `0d70d89a`: `factory up`/`run`, plus the tsx and controller-stall fixes.
- [#878](https://github.com/cacheplane/b4run/pull/878) `b0605d73`: a one-pass base64 check in `@b4run/workspace`.

The rung 3 live replay of #714 exported work order `wo-90261db33dd81830`, and the reference test scored 5/6. Spec §7 of the rung 3 gaps work records it.

**Documents:**
- Spec, approved: `docs/superpowers/specs/2026-10-01-software-factory-rung4-design.md`. §13 has as-landed notes for PR 3 and PR 4.
- Plan, with D1–D30 accepted: `docs/superpowers/plans/2026-10-01-software-factory-rung4.md`. It has as-landed notes for Tasks 5–22, the follow-up list, and Tasks 4 and 23, which are still to do.
- Operator docs: `examples/software-factory/README.md`, section "Delivering as a draft pull request (rung 4)".

---

## 2. What rung 4 is

An approved factory change is delivered as a **draft PR** from a same-repo branch `factory/<work-order-id>` in `cacheplane/b4run`. The PR is opened by the GitHub App `b4-factory`, whose bot login is `b4-factory[bot]`.

Decisions on record (Brian's):

- **Same repository, guarded branches, not a fork.** A same-repo PR runs workflows from its merge commit. So PR 1 adds `if:` guards to `vercel-native`, `auto-approve` and `claude-review`, which skip a head ref starting `factory/` or a PR authored by the bot. The Vercel ignore script also skips `factory/` branches. A behavioural guard test evaluates every pull_request-reachable job's `if:` with three-valued logic, a trigger allowlist and reusable-workflow resolution. That test lives in `scripts/release/test/factory-guard.mjs`, with `github-expression.mjs` as its evaluator.
- **A GitHub App, confined by rulesets.** The app has `contents: write`, `pull_requests: write`, `issues: read` and `metadata: read`, and nothing else. Rulesets confine it to `factory/**` and make those branches append-never.
- **The branch is cut at the pin.** It holds one commit with exactly the approved bytes, whose parent is the pin. The factory never rebases or force-pushes. Delivery is refused if `main` has touched a changed path, or a `runFromBranchPaths` file, since the pin.
- **There is one gate, and it is bound in the bundle digest.** `--deliver draft-pr` is chosen at create. The operation, repository, base, branch, pin and pathPrefix are frozen into the bundle and covered by its digest, so approving the bundle authorizes exactly that delivery. `run` never approves and never redelivers; a source-pin test enforces this.
- **Outbox and worker.** Each step reads before it writes, so a repeated step changes nothing: checked → committed → branched → opened → confirmed. A row becomes `delivered` only after the PR is read back: its tree equals the bundle's locally computed git hashes, its author, head, base and parents match, and it carries no closing references. An abort leaves the row `delivering`, journalled as `delivery_stopped`.
- **Redeliver.** Of the seven `delivery_*` block reasons, three can heal by waiting: unauthorized, rate_limited and unconfirmed. `pnpm factory redeliver <id>` retries one of those under the approval already given. It needs the typed 8-hex digest prefix and works only within 24 h of the approval.

The credential boundary, as built:

| Who | Holds |
|---|---|
| Controller | The app key as a `KeyObject`, read from a file path. Every installation token it mints stays in memory so it can be scrubbed from logs. |
| `up` | The key only long enough to write a run copy, when the key comes in an environment variable. The copy is `<state>/run/github-app.pem`, 0600 inside a 0700 directory, written with `wx`, never through a symlink, and removed in a `finally`. |
| Builder, drafter, and `up`'s own `git`/`docker`/`ps` | Nothing. They are stripped of every `FACTORY_GITHUB_*`, `GH_TOKEN`, `GITHUB_TOKEN` and `GITHUB_APP_*` variable. |

Every GitHub request goes through `githubRequest`, in `controller/src/lib/delivery/github/http.ts`:
- Only GET and POST, on a fixed list of routes, for the configured repository.
- The URL actually handed to `fetch` is checked before any credential is made.
- Each POST body is checked in the form actually sent, against an exact set of keys.
- A token mint is limited to the one repository and the four permissions.
- No redirects, a timeout on every request, and a bounded body size.

---

## 3. What is proven, and what is not

**Proven, in tests, against fakes:**
- The whole lifecycle, refusals and idempotency, against an in-memory fake GitHub with fault injection.
- The real adapter, real JWTs and a real allow-list against a loopback fake, which answers GitHub's real response shapes, including the 422 bodies. The end-to-end path covered is config → runtime → approve → `delivered` (`test/github-delivery-e2e.test.ts`).
- A mutation pass on every reviewed task: each surviving mutant was killed.
- Counts at the last full run: 1378 controller tests pass and 1 is skipped (the contract replay, which needs a recorded fixture).

**Not proven yet:**
- **No step has ever called real GitHub.** The scratch lane, `pnpm --filter @b4-example/software-factory-controller test:github-scratch`, skips unless its three variables are set. They are `FACTORY_TEST_GITHUB_SCRATCH=<owner/name>`, `FACTORY_TEST_GITHUB_APP_ID` and `FACTORY_TEST_GITHUB_APP_KEY_FILE`, which must be a 0600 PEM.
- **Whether GitHub shows an app installation token the repository's `squash_merge_commit_message` and `merge_commit_message`.** Since #901, preflight fails closed: if either field is missing, it refuses *every* draft-PR approval. The scratch lane asserts both fields are strings, so its first run settles this. If GitHub hides them from the app, decide whether to keep failing closed or to read the settings another way.
- **The fake GitHub answers fewer top-level keys than real GitHub.** For example, `GET /app` carries `owner`, `permissions` and `events`. The contract replay requires the fake to answer at least the recorded keys. **Expect to add keys to `test/fake-github-server.ts` after the first recorded run.** That is the plan's intended "fix the fake to what GitHub does" step, not a defect.

---

## 4. Next steps, in order

1. **Brian: plan Task 4, Steps 1–4 and 6.** All of it is done in GitHub's and Vercel's UI; an agent creates nothing.
   - Create the app `b4-factory`. Webhook off; the four permissions above, with every other permission (including Workflows and Actions) left at no access; "Only on this account". Put the key at `~/.config/b4-factory/app.pem` with mode 600.
   - Create the private repo `cacheplane/b4-factory-scratch`. Give it a `README.md`, and `packages/devkit/src/testing/process.ts` containing exactly `export const deadline = 'leaks'` followed by a newline. Open one issue, which must be #1. Install the app on it.
   - Create the three rulesets on the scratch repo first. Their exact rules and bypass lists are in Task 4 Step 4.
   - The Vercel check (Step 6): every Vercel project linked to `cacheplane/b4run` needs a `factory/*` exclusion.
2. **An agent: Task 4 Step 5.** These are read-only `gh api` checks of the app, its installations, the rulesets and the branch rules; the commands and expected values are in the plan. Show Brian the output.
3. **Brian: Task 4 Step 7.** #884 is merged, so this is safe now. Install the app on `cacheplane/b4run` and create the same three rulesets there. Re-run Step 5 against b4run. Then watch the next release ceremony succeed with the rulesets on (D7). The release pushes `v*` tags and `changeset-release/main`.
4. **The first recorded scratch run** (plan Task 21 Step 3). Run the lane with `FACTORY_TEST_GITHUB_RECORD=1` plus the three variables, using Brian's key. **The agent must not read or print the key.** Commit the recorded `test/github-contract.json`, then fix the fake until the contract replay passes. Settle the merge-settings question from §3 here.
5. **PR 5: the live run** (plan Task 23). **Brian makes both gate decisions himself.** An agent shows the draft and the bundle, including the Delivery block, and waits.
   - **Case 1:** a fresh open issue that Brian picks, run at `main`'s tip with `--deliver draft-pr`. Expected:
     - the PR is a draft authored by `app/b4-factory`, with head `factory/wo-…`, base `main`, a body that starts `Refs #<n>`, and no closing reference;
     - `vercel-native`, `auto-approve` and `claude-review` are skipped, `validate` runs, and no Vercel preview is built;
     - a second `run` answers "Already delivered".
   - **Case 2:** a replay of #714 at its old pin `765e6e16fec86bba0859d3f85edf7136f663f720` with `--new`. It **must be refused** with `delivery_base_conflict`, and nothing may be created on GitHub.
   - Record everything in the spec's §14 as-landed note, as Task 23 Step 5 says.

---

## 5. Open decisions for Brian

- **Local-export reruns still suggest the old pin.** Since #901, a draft-PR row's suggested rerun is `run --issue N --repo R --deliver draft-pr`, with no `--pin`, so it runs at today's tip. A cancelled or denied *export-local* issue run still suggests `--pin <old pin>`. It was left as is because that is consistent with existing behaviour. Change it if a rerun should start from today's `main`.
- **Drop `issues: read`** if the scratch lane shows that reading a public issue doesn't need it (D5).
- **Merge-settings visibility.** See §3.

---

## 6. Traps learned this stretch

- **Squash-merging stacked PRs causes conflicts.** After the base PR is squash-merged, merging `main` into the next PR conflicts in every file both branches touched. Check that `main`'s copy equals the old base tip (`git diff --quiet origin/main <old-base-tip> -- <paths>`) and resolve with `--ours`. zsh doesn't word-split `$var`, so feed file lists through `xargs`.
- **GitHub's "pull request already exists" 422** carries its text in `errors[0].message`; the top-level `message` is just `"Validation Failed"`. "Reference already exists" is in the top-level `message`. The fake used to get this wrong, which hid the bug.
- **A branch-ref read answers 404 before the branch exists and 200 after.** Any replay that matches a request by method and path alone breaks on this. The replay now matches on method, path template and status.
- **`up`'s own child processes run before its config-derived secrets are known.** Secret names now come from the config (`realUpDeps(config)`). Don't reintroduce module-level secret state.
- **Never echo a value that might be a key.** A PEM pasted into a path field was printed back by the "does not exist" error. `notAKeyPath` now guards this.
- **Two racing approvals: whichever commits first wins, not whichever was called first.** Under process-spawn load the second call sometimes wins. Assert "exactly one winner, one PR".
- **CI facts still in force:**
  - On Linux, `/bin/sh` is dash.
  - Run node with `node --import tsx`, not the tsx CLI, whose signal relay SIGKILLs children.
  - pnpm turns one Ctrl-C into SIGINT, SIGTERM, SIGINT.
  - A workflow edit must move `scripts/release/test/fixtures/workflow-entrypoints.json` and the workflow-contracts digest in the same commit.
- **The advisory `review` check fails** whenever the org's review credits run out. `validate` is the merge signal.

---

## 7. Follow-ups not done

Each of these is recorded in the plan's "Follow-ups recorded, not in this plan":

- The ruleset read (`branchRules`) takes only the first page.
- A 300-file compare body is assumed to fit the 10 MiB response cap.
- Commit dates are sent as millisecond ISO strings.
- The `privateKeyEnv` run copy can't be removed early, because `openFactory`'s retry re-reads the key file.
- A delivery view in `factory events`.
- The controller's remaining synchronous calls, e.g. `readGeneratedTask` at approve.
- The `repositoryId: taskId` misnomer stays, because removing it would change every export-local digest.

---

## 8. Rules for whoever picks this up

- **The factory gates are Brian's.** At `approve-intake` and `approve`, show the draft, the check file, the oracle evidence and the satisfiability probe, with a recommendation and the exact command. Never approve on his behalf unless he explicitly says so.
- **Never read, print or log the app key, a JWT or an installation token.** Tests generate keys at run time and assert booleans only. The OpenAI key lives in the gitignored main-worktree `.env`; only source it into workers.
- **No GitHub writes from an agent during Task 4.** Only the read-only `gh api` checks.
- **Repo hygiene:**
  - No bare `git stash`.
  - No bare `biome check --write` at the root.
  - Never `pkill -f vitest`.
  - No destructive Docker commands.
  - `examples/code-fixer` stays without a diff.
  - Keep at most two full-CI PRs active at once.
