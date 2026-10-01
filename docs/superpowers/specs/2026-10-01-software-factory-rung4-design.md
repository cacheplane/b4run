# Software factory rung 4: an approved change as a draft pull request

Status: design, 2026-10-01. Amend it as execution changes it, the way rung 3's was.
Program: [the RFC](2026-09-16-software-factory-rfc.md) (§10.2 to §10.4, milestone M3).
Predecessors: [rung 3](2026-09-21-software-factory-rung3-design.md), whose §7 names this rung
"its own spec", and [the framework gaps](2026-09-23-software-factory-framework-gaps-design.md),
as landed through `factory up` and `factory run` (§7) and the live replay of #714.

Rung 3 proved that an issue can enter the factory, become an oracle a person approved, and come
out as a verified candidate that a person approved again. The candidate lands in a JSON file
in a local directory. Rung 4 makes the second approval mean what the program is for: **approving
a bundle publishes exactly that change as a draft pull request on `cacheplane/b4run`, once,
from a credential only the controller holds, and the factory says it is delivered only after it
has read the pull request back and found its bytes.**

This rung is not "the factory opens pull requests". It is "the one remote write the factory makes
is bound to a digest a person approved, survives a lost response or a restart without a
duplicate, refuses rather than guesses when the world moved, and never puts candidate code next
to a secret".

Line references are to `main` at `216befd5a`. Paths starting `controller/` are under
`examples/software-factory/`.

---

## 1. Decisions taken in the design conversation

Brian made these on 2026-10-01. They are recorded so the plans do not relitigate them.

| # | Decision | Chosen | Rejected, and why |
|---|---|---|---|
| D1 | Where the pull request's branch lives | **Same-repository branches `factory/<work-order-id>` on `cacheplane/b4run`, guarded.** Every secret-bearing or approving `pull_request` job (`ci.yml`'s `vercel-native`, `auto-approve.yml`, `claude-review.yml`) skips a PR whose head branch starts `factory/` or whose author is the factory app's bot, and a workflow-contract test pins those guards (§9) | A fork owned by a bot account (a second identity to run and keep in sync; Brian prefers one repository). Same-repository and unguarded (candidate code would run beside the Vercel secrets and be auto-approved by a bot) |
| D2 | The credential | **A GitHub App** that Brian creates and installs on `cacheplane/b4run` with `contents: write`, `pull_requests: write` and `metadata: read` only; a repository ruleset confines it to `factory/*` refs and keeps it off `main`; the controller mints short-lived installation tokens from `FACTORY_GITHUB_APP_ID` and the private key (a file path, or an environment variable). Only the controller holds it: never the builder or the drafter, never logged, never in argv, scrubbed from every child process like the OpenAI key | A fine-grained personal access token on a bot user (a long-lived secret, a seat, no per-request scoping). Brian's own `gh` login (the PRs would be indistinguishable from his, and the credential reaches everything he can) |
| D3 | Base drift | **Branch at the pin.** One commit holding exactly the approved bytes on top of the work order's pin; a draft PR against `main`; never rebase, never force-push; GitHub's `pull_request` CI tests the merge result. Delivery refuses, recorded and not retried, when the change no longer applies cleanly to `main` (the check is §6.4). The PR body states the pin and how far `main` has moved | Strict pin equals tip (with `main` moving about every 30 minutes, almost every delivery would be refused). Rebase, re-verify and ask for a new approval (a third gate, and the approved bytes are no longer the published bytes) |
| D4 | The gate | **One gate, bound in the bundle.** The delivery operation is chosen at `factory create` / `factory run` (`--deliver draft-pr`; the default `local` is today's export, unchanged). The frozen bundle names the operation, the repository, the base branch, the branch name and the pin, and the bundle digest covers them; approving the bundle is the only authorization to publish exactly that PR. Changing any of them needs a new bundle and a new approval | Two gates, export then publish (a person approves the same bytes twice and learns to click through the second). Choosing the operation at approval (the reviewed bundle would not say where it goes) |
| D5 | The adapter | **GitHub's Git Data API, called from the controller**: blobs, a tree on the pin's tree, a commit, a ref, a draft PR. No local working tree, no `git push`; the bytes come from the bundle's candidate artifact; read back and compared by git object hash | Local `git` plus push (a working tree, a credential helper, and a second copy of the bytes to keep honest). The `gh` CLI (a subprocess that needs the token in its environment) |
| D6 | Outbox and reconciliation (RFC §10.3) | **Approval commits an outbox intent under an operation key; a delivery worker advances idempotent steps**: (a) the applies-cleanly check, (b) build the commit, (c) create or confirm the branch, (d) find or create the draft PR by head branch. Each step reads remote state before it writes, so a lost response converges on the one PR that exists. `delivered` only after the PR is read back and its head commit's tree equals the bundle exactly. Reconciled at controller boot (`up`'s boot reconcile) and by `factory reconcile` | Fire-and-forget delivery inside `approve` with a best-effort retry (the RFC's own counterexample: a timeout after PR creation becomes a duplicate or a false failure) |
| D7 | Refusals | **Recorded, not blindly retried**: no longer applies to `main`; branch exists with other content; app permission revoked, token mint fails, 401 or 403; the issue was closed; rate limiting (retried with backoff, then blocked) | Retry until it works (a revoked app or a conflicting branch never heals by waiting, and every retry is another remote write attempt) |
| D8 | The pull request | **Draft; authored by the app's bot; body carries `Refs #N`** (never a closing keyword, so a merge never closes the issue), the approved task (spec and acceptance criteria), the receipts and digests (task, bundle, verification receipts), the pin and the drift, and a line saying the factory produced it and a person approved it; title from the task | Ready-for-review PRs (they invite merging before a person has looked); `Closes #N` (a merge would close the issue on the factory's say-so) |
| D9 | Proof | **Unit tests against a fake GitHub** (dropped responses, 409/422 conflicts, revoked tokens, rate limits, a branch with other content, a PR that already exists); **a recorded or live test against a scratch repository Brian owns** (opt-in by environment, never a CI default); **a live run of one issue end to end into a real draft PR on `cacheplane/b4run`**, Brian at both gates | Only the fake (it encodes my beliefs about GitHub's 422 bodies, which is exactly what needs checking). Only live (no regression guard) |

Decisions the spec author took inside those, each justified where it is made: draft-PR delivery
is for issue work orders only (§3.1); the applies-cleanly check is a file-level disjointness
check through the compare API (§6.4); the delivery-protected paths (§9.3); the new states and
blocked reasons (§4). What could not be settled is in §15.

---

## 2. What the code does today

### 2.1 The bundle, the gate and the export

- **The bundle's operation is a literal.** `BundlePayloadSchema` has
  `operation: z.literal("export-local")` and `destinationId: z.string().min(1)`
  (`controller/src/lib/review/bundle.ts:23-24`); `freezeBundle` writes the literal
  (`bundle.ts:92`). `BundleDigestInput.operation` is typed `"export-local"`
  (`controller/src/lib/domain/digest.ts:115`), and `bundleDigest` digests the whole payload under
  the domain `b4-factory-bundle-v1` (`digest.ts:127-132`). The payload already carries `origin`,
  `pin`, `taskDigest` and `oracleReceiptId` (`bundle.ts:34-38`).
- **`destinationId` is the export directory.** `runVerification` freezes the bundle with
  `destinationId: ctx.exportDir` (`controller/src/lib/controller/verify.ts:270`), and `approve`
  refuses a bundle whose `destinationId` is not the current `exportDir` as `bundle_invalidated`
  (`controller/src/lib/controller/factory.ts:1611-1612`).
- **`repositoryId` is the task id.** `verify.ts:264` passes `repositoryId: row.taskId`. The name
  promises a repository and the value is a catalog or generated task id. Changing it would move
  every export-local digest, so this rung leaves it alone and names the repository in the new
  delivery block (§3.3). Recorded here so nobody reads `repositoryId` as the PR's destination.
- **`approve` is the whole delivery.** `approve` (`factory.ts:1494`) checks the revision, the
  bundle digest and the approval window (`FACTORY_APPROVAL_TTL_MS`, default 15 minutes,
  `factory.ts:1526`), compares every frozen field against the row and the disk (policy,
  specification, candidate, destination, baseline, origin, pin, task digest), re-verifies the
  candidate in the bound image (`factory.ts:1658`), then in one transaction records the approval
  and transitions `awaiting_approval → exporting` (`factory.ts:1714-1724`), then writes the export
  (`factory.ts:1734`) and records the delivery and `exporting → exported`
  (`factory.ts:1753-1760`). There is no outbox: the command's operation key in the two-phase
  command log (`controller/src/lib/registry/commands.ts`) is the only record of intent.
- **The export is write-once by name.** `exportApproved` links a temp file to
  `<bundle digest>.json`, so a retry lands on the same name and differing content is an error
  (`controller/src/lib/delivery/export.ts:18-43`); `exportedState` reads it back as
  `exported | missing | differs` (`export.ts:63-72`).
- **Reconciling an export never writes.** `reconcileExporting`
  (`controller/src/lib/controller/reconcile.ts:584-651`) confirms bytes already on disk and
  otherwise blocks `export_unconfirmed`; a missing export after a restart is not re-attempted
  (`reconcile.ts:647-649`). Rung 4 deliberately differs (§5.4): the outbox intent is the
  authorization, and every step is idempotent, so reconcile continues the delivery.
- **The delivery record is a path.** `DeliverySchema` is `{ workOrderId, candidateDigest,
  receiptPath, observedAt }` (`controller/src/lib/domain/work-order.ts:118-124`); the
  `deliveries` table has those four columns (`controller/src/lib/registry/db.ts:91-96`). The
  registry is at schema version 5 (`db.ts:5`).

### 2.2 States, run and the CLI

- `STATES` has `awaiting_approval`, `exporting` and `exported`
  (`controller/src/lib/domain/states.ts:1-16`); `exported` is terminal (`states.ts:19-24`);
  `exporting` is active time (`states.ts:27-33`). `approve` moves `awaiting_approval →
  exporting`, `receipt_observed` moves `exporting → exported`, `export_unconfirmed` moves
  `exporting → blocked` (`states.ts:142-145`); `cancel` is legal from every non-terminal state
  (`states.ts:146`), `exporting` included.
- `factory create` parses `--task`, `--issue`, `--repo`, `--pin` and `--key` and refuses bad
  combinations before the controller is asked (`controller/src/cli.ts:1546-1563`); the issue and
  the pin are read by the CLI with the operator's own `gh` (`cli.ts:592-625`). Options are
  declared once in `parseArgs` (`cli.ts:1441-1464`).
- `factory run`'s step table (`controller/src/lib/operator/run-steps.ts:81-146`) has no approval
  step; `exported` is `done` (`run-steps.ts:117-118`), and `chooseWorkOrder` treats an exported
  newest work order as the answer already (`run-steps.ts:160-169`). `show` prints the row and
  nothing else (`cli.ts:1650-1655`); the export gate's display is `exportReview`
  (`controller/src/lib/review/operator-review.ts:337`). The factory has no Workbench: nothing
  under `examples/software-factory` renders a work order in a browser.

### 2.3 What a candidate can change

- **The inventory is a set of exact paths.** `assembleCandidate` refuses a candidate that adds
  or removes any path, changes an immutable path, or changes a path not in
  `allowedSourcePaths`, by set membership, not by prefix
  (`controller/src/lib/verification/assemble.ts:113-131`). So a candidate can change only files
  the task names one by one, and can never add a file (a changeset, a workflow, anything).
- **The person sees the inventory.** `task.json` (with `allowedSourcePaths`) is one of the files
  the intake digest covers and `factory review` prints. The task schema already refuses test
  files and `checks/**` as allowed paths (`controller/src/lib/targets/catalog.ts:550-552`) and
  requires allowed and immutable paths to be disjoint (`catalog.ts:573-576`);
  `assertTaskFitsTarget` refuses an allowed path that reaches the runner configuration
  (`catalog.ts:690`). Nothing today refuses `.github/**`.
- **Paths are relative to the target's root.** The candidate's keys are workspace paths under
  the target's `root`; the repository targets have `"root": "."` (for example
  `controller/targets/devkit/target.json:4`), the lab fixture `cli-flags` does not.
- **The baseline is `git archive` of the pin, plus the task's defect patch.**
  `captureTargetBaseline` (`controller/src/lib/verification/baseline.ts`) captures the target's
  pinned subtree with the defect applied (`controller/src/lib/targets/archive.ts:159-215`). For
  a generated task there is no defect, so the baseline's bytes are the pin's blobs, except where
  `.gitattributes` export filters rewrite them; §6.3 checks that per changed path rather than
  assuming it.

### 2.4 Configuration and secrets

- `factory.config.ts` is validated strictly (`ConfigSchema … .strict()`,
  `controller/src/lib/operator/factory-config.ts:45-52`), and keys a reader might expect are
  refused by name with what replaced them (`REPLACED`, `factory-config.ts:59-65`; `token` says
  "the config names no secret").
- `up` keeps provider and GitHub credentials out of the controller with a deny-list
  (`controllerMayNotSee`, `controller/src/lib/operator/up.ts:189-190`) and keeps the key and the
  worker token from being inherited (`NOT_INHERITED`, `up.ts:182`), but **the workers inherit
  every other variable** (`up.ts:198-210`). A `FACTORY_GITHUB_APP_*` variable in `up`'s
  environment would reach the builder and the drafter today. Lines are redacted for the worker
  token and the OpenAI key only (`redactor`, `up.ts:716-727`).
- The controller's own subprocesses (`git` in `archive.ts`, `catalog.ts`, `wide-capture.ts`;
  `docker build` in `controller/src/lib/targets/image-builder.ts:31`) are spawned without an
  `env` option, so they inherit the controller's whole environment.

### 2.5 The CI the PR will meet

Read from the workflows at `216befd5a` and from the repository's settings (read-only `gh api`,
2026-10-01):

- **`vercel-native`** runs on a same-repository `pull_request`
  (`.github/workflows/ci.yml:702-711`), in environment `vercel-preview`, with
  `B4_VERCEL_TOKEN`, `B4_VERCEL_ORG_ID`, `B4_VERCEL_PROJECT_ID` and `B4_VERCEL_DATABASE_URL` in
  three steps (`ci.yml:741-774`), after `pnpm install` and `pnpm build` of the PR's code. The
  environment's deployment-branch policy admits `main` and `refs/pull/*/merge`: **any
  same-repository PR's merge ref may deploy to it.** It is the only `ci.yml` job that reads a
  repository secret. `validate` does not need it (`ci.yml:182-183`), so skipping it does not red
  the required check.
- **`auto-approve.yml`** approves every same-repository PR on `opened`, `reopened` and
  `ready_for_review` with `pull-requests: write` (`auto-approve.yml:24-28`); the repository
  setting `can_approve_pull_request_reviews` is on.
- **`claude-review.yml`** runs on every PR but Dependabot's (`claude-review.yml:36`) with
  `pull-requests: write` (`:41`), `ANTHROPIC_API_KEY` (`:57`, `:109`), and an agent that reads
  the PR's diff and description and posts a comment. It executes no PR code, but the diff and the
  body are model input next to a key and a write token.
- **Workflows on `pull_request` come from the merge commit.** For a same-repository PR, a change
  to `.github/workflows/*` in the PR is the workflow that runs on it. A guard on `main` protects
  a PR only while the PR cannot edit the guard; §9.3 makes that structural.
- **The Vercel Git integration builds previews of pushed branches.** The `Preview` deployments
  on the repository are created by `vercel[bot]`, and `apps/web/vercel.json:4` gates them with
  `ignoreCommand: bash scripts/vercel-ignore-build.sh`, which builds whenever `packages/`,
  `apps/web` or the root workspace files changed since the previous deployment. **A factory
  branch touching `packages/*` would be built on Vercel with the project's Preview environment.**
  The ignore script runs from the commit being built, so it, too, is candidate-reachable unless
  protected (§9.3). This was not in the conversation's list; it is the same exposure as D1 and is
  guarded the same way.
- **The `changesets` job** (`ci.yml:69-85`) requires a changeset for user-facing package
  changes and exempts only `dependabot[bot]` and `github-actions[bot]`
  (`scripts/check-changesets.mjs:29`). A candidate cannot add a file (§2.3), so a factory PR
  that touches a publishable package will red `changesets`. It is not required; §11 says what a
  person does about it.
- **Settings:** `main` is protected (required check `validate`, conversation resolution, no
  force-push, no deletion); there are **no rulesets** today; `delete_branch_on_merge` and
  `allow_auto_merge` are on; the default workflow token is read-only.
- **The audited fixtures pin job conditions.** `scripts/release/test/fixtures/workflow-entrypoints.json`
  records each job's descriptor, `if` included (its line 22 is `auto-approve.yml`'s `if`), and
  `workflow-safe-executables.json` each step's executable; `workflow-contracts.test.mjs:35-42`
  loads both. Editing any job's `if` changes `workflow-entrypoints.json` in the same commit. There
  is no regeneration script: the fixtures are edited by hand and reviewed.

---

## 3. The delivery choice, bound in the bundle

### 3.1 Chosen at create

```
pnpm factory create --issue 912 --deliver draft-pr
pnpm factory run    --issue 912 --deliver draft-pr
```

`--deliver` takes `local` (the default, today's export, unchanged in every byte) or `draft-pr`.
The CLI sends it in the `create` route's input; the controller records it on the row and never
changes it, exactly as it treats `origin` and `pin`.

`create --deliver draft-pr` is refused, before any operation key is spent, when:

- the work order is a catalog task (`--task`). **Author's decision:** catalog tasks are
  historical defects reproduced with a `defect.patch`; their baseline is not the pin's bytes, and
  their repair is already on `main`. A PR of one would be wrong in both directions. Draft-PR
  delivery is for issue work orders.
- the controller has no delivery configuration (§8), or its configured repository is not the
  issue's `origin.repository` (the PR goes to the repository the issue is in, or nowhere).

`run` without `--deliver` resumes the issue's live work order with whatever delivery it was
created with; `run --deliver <x>` resumes it only if `<x>` is that delivery, and otherwise stops
naming the work order's delivery and `--new`. A replay (`--pin`) may deliver
too (§15, the issue-closed policy).

### 3.2 The row

```ts
delivery:
  | { kind: "local" }
  | {
      kind: "draft-pr"
      repository: string          // owner/name, REPOSITORY_PATTERN, = origin.repository
      baseBranch: string          // "main": the configured base, recorded
      branch: string              // "factory/<work-order-id>"
      pathPrefix: string          // the target's root at intake, "." for repository targets
      issueStateAtCreate: "open" | "closed"
    }
```

`branch`, `repository` and `baseBranch` are fixed at create. `pathPrefix` is filled when intake
fits the draft to a target (until then the row's `targetId` is null, so it is not known), in the
same transaction as `targetId`. `issueStateAtCreate` is read by the CLI with the operator's `gh`
alongside the title and body it already reads (`gh issue view --json title,body,url,state`).

Registry migration 6 adds `work_orders.delivery TEXT NOT NULL DEFAULT '{"kind":"local"}'`, so
every existing row is a local export.

### 3.3 The bundle

`BundlePayloadSchema` becomes a union discriminated by `operation`:

- **`export-local`**: exactly today's payload, unchanged field for field, so every bundle frozen
  before this rung parses, digests to the digest it was frozen under, and is approved and
  exported exactly as before. Old bundles stay `export-local`; nothing migrates them.
- **`draft-pr`**: today's fields, with `operation: "draft-pr"`,
  `destinationId: "github:<repository>:refs/heads/<branch>"`, and one more field:

```ts
delivery: {
  repository: string
  baseBranch: string
  branch: string
  pathPrefix: string
  issueStateAtCreate: "open" | "closed"
}
```

The pin is the payload's existing `pin` (`bundle.ts:35`), which is non-null for an issue work
order; it is not repeated. The digest domain stays `b4-factory-bundle-v1`: `canon` is injective
(`digest.ts:23-29`) and the two shapes differ in `operation`, so they cannot collide.
`BundleDigestInput.operation` widens to the union.

`runVerification` (`verify.ts:21`; the freeze is at `:262`) builds the draft-PR payload from the row's `delivery` and refuses to
freeze one whose `pathPrefix` is null (an intake that never fitted a target cannot reach
`verifying`, so this is an assertion).

### 3.4 What approval checks, in order

For a draft-PR bundle, `approve` adds to today's checks (§2.1), all before the re-verification,
so a refusal costs seconds rather than a verification:

1. `canon(frozen.delivery)` equals `canon(row.delivery)`, and `destinationId` equals the one
   derived from it (`bundle_invalidated`, field `Delivery`).
2. The controller's delivery configuration names the same repository and base branch, and its
   credential is present (`Delivery not configured for <repository>` refusal; the row stays in
   `awaiting_approval`).
3. **Preflight:** a token can be minted and the repository read with it, and the app's granted
   permissions are a superset of what delivery needs (§6.1). A failure is a refusal, not a
   block: nothing was committed, and the person can fix the app and approve again inside the
   window.
4. Every changed path, joined to `pathPrefix`, is outside the delivery-protected paths (§9.3).
   Intake already refused such a task; this is the second check, against the candidate itself.

Then the re-verification, unchanged. Then one transaction records the approval, **commits the
outbox intent** (§5.1) and transitions `awaiting_approval → delivering`. Nothing remote has been
written yet.

---

## 4. Lifecycle

```
awaiting_approval ──approve (local)──▶ exporting ──receipt_observed──▶ exported
        │
        └──approve_delivery (draft-pr)──▶ delivering ──delivery_confirmed──▶ delivered
                                              │
                                              └──delivery_refused──▶ blocked(<delivery reason>)
blocked(delivery_unauthorized | delivery_rate_limited | delivery_unconfirmed)
        ──redeliver──▶ delivering
```

- **New states:** `delivering`, `delivered`. `delivered` is terminal.
- **`delivering` is not active time.** The builder's budget is the wrong clock for waiting on
  GitHub, and `budget_exhausted` from `delivering` would cancel a half-done publication. The
  worker has its own bound (§6.5).
- **New events:** `approve_delivery { awaiting_approval → delivering }`,
  `delivery_confirmed { delivering → delivered }`, `delivery_refused { delivering → blocked }`,
  `redeliver { blocked → delivering }` (the command refuses every other blocked reason, as
  `retry` does today with `RETRYABLE_BLOCKED_REASONS`).
- **New blocked reasons:**

| Reason | Meaning | `redeliver`? |
|---|---|---|
| `delivery_base_conflict` | `main` changed a path the change touches or a delivery-protected path since the pin, or the pin is not an ancestor of `main`, or the drift could not be read in full (§6.4). The journal names which and lists the paths | No: a new work order at a fresh pin |
| `delivery_baseline_mismatch` | A changed path's blob at the pin is not the baseline the candidate was diffed against (§6.3) | No |
| `delivery_branch_conflict` | `factory/<id>` exists with a commit that is not this change, or its PR is closed, or has another base | No |
| `delivery_issue_closed` | The issue was open at create and is closed now (§15) | No |
| `delivery_unauthorized` | Token mint failed, the installation is missing, a 401 or a non-rate-limit 403, or granted permissions too narrow | Yes, after the app is fixed |
| `delivery_rate_limited` | Primary or secondary rate limit past the worker's bound | Yes |
| `delivery_unconfirmed` | 5xx or network failure past the bound, or the read-back disagrees with the bundle in a way none of the above explains | Yes |

- **Cancel.** `cancel` from `delivering` is accepted; the worker checks the row before each
  write step and stops. A branch or PR already created is not undone (RFC §7.4: a completed
  remote write cannot be made nonexistent). The journal records the remote ids that exist, the
  row ends `cancelled`, and deleting the branch or closing the PR is a person's compensating act.
- **`factory run`:** `delivering` is `follow`; `delivered` is `done`, exit 0, printing the PR
  URL; a delivery block is `stop` with `factory redeliver <id>` among the next commands when the
  reason allows it, and `factory events <id>`, `factory cancel <id>` otherwise. `run` still
  never approves: the export gate is the same `review` display and typed prefix, now naming the
  operation (§7.4). `chooseWorkOrder` treats a delivered newest work order as the answer, as it
  does an exported one.

---

## 5. The outbox and the delivery worker

### 5.1 The intent

A new table, written only inside `approve`'s transaction:

```sql
CREATE TABLE delivery_outbox (
  operation_key TEXT PRIMARY KEY,         -- deliver:<work order>:<bundle digest>
  work_order_id TEXT NOT NULL UNIQUE REFERENCES work_orders(id),
  bundle_digest TEXT NOT NULL,
  approval_id   TEXT NOT NULL REFERENCES approvals(id),
  intent        TEXT NOT NULL,            -- canonical JSON: repository, base, branch, pin, pathPrefix, approvedAt
  step          TEXT NOT NULL,            -- pending | checked | committed | branched | opened | confirmed
  remote        TEXT NOT NULL,            -- JSON: what each step observed (shas, numbers, urls)
  attempts      INTEGER NOT NULL,
  last_error    TEXT,                     -- scrubbed (§8.3)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

One row per work order (`UNIQUE`): a work order has one bundle it can deliver. The delivery
receipt goes in `deliveries`, which gains nullable `kind`, `pr_number`, `pr_url`, `head_sha`,
`tree_sha` and `base_sha` columns; `receipt_path` stays `NOT NULL` and holds the PR's URL for a
draft-PR delivery, so existing readers keep working.

### 5.2 The steps

Each step reads remote state first, writes only what is missing, and records what it observed in
`remote` with the step advanced, in one registry transaction. A step that finds its write
already done records it and moves on.

| Step | Reads first | Writes when missing | Advances to |
|---|---|---|---|
| (a) check | the issue's state (§15); `main`'s tip; compare `pin...tip` (§6.4); the pin's blobs at the changed paths (§6.3) | nothing | `checked`, with `baseTip`, `aheadBy` |
| (b) commit | nothing remote: the expected blob shas, tree sha and parent are computed locally (§6.3) | blobs, the tree on the pin's tree, the commit | `committed`, with `commitSha`, `treeSha` |
| (c) branch | `refs/heads/factory/<id>` | the ref at `commitSha` | `branched` |
| (d) PR | open and closed PRs with head `cacheplane:factory/<id>` | the draft PR | `opened`, with number, URL, node id |
| confirm | the PR, its head commit, that commit's tree and parents, its closing-issue references | nothing | `confirmed`; then `delivery_confirmed` |

- **(a) runs once.** Its answer is recorded and not re-asked on a resume: `main` moving after the
  check is what the PR's own CI and mergeability are for, and re-checking on every resume would
  let a restart turn a delivered-in-all-but-name PR into a refusal.
- **(b)'s commit is reproducible where GitHub lets it be.** The worker passes the author and
  committer (the app's bot identity, the approval time from the intent) and a message built
  only from the intent, so a repeated create usually yields the same sha. Correctness does not
  depend on it: a commit created twice leaves one unreferenced object, and (c) and confirm judge
  by tree and parent, never by commit sha alone.
- **(c) never moves a ref.** A `422 Reference already exists` is answered by reading the ref: if
  its commit's parents are `[pin]` and its tree is the expected tree, it is ours from a lost
  response and is recorded; anything else is `delivery_branch_conflict`. There is no update or
  force path in the adapter (§6.2).
- **(d) finds before it creates.** An open PR with our head ref, base `main` and head sha equal to
  the branch's commit is ours. A closed one is `delivery_branch_conflict` (a person closed it;
  the factory does not reopen). A `422` on create ("a pull request already exists") is answered
  by listing again.
- **Confirm is the receipt.** `delivered` requires: the PR is open; head ref `factory/<id>`;
  head repository `cacheplane/b4run`; base `main`; author the app's bot; the head commit's
  parents are exactly `[pin]`; its tree sha equals the locally computed expected tree; and its
  closing-issue references are empty (§7.3). Draft is asserted on the creation response; on a
  later read an open PR with our exact head is ours whatever its draft flag, since a person may
  have marked it ready. The receipt (number, URL, head sha, tree sha, base tip at the check,
  `aheadBy`, observed time) is recorded with `delivery_confirmed` in one transaction.

### 5.3 Who runs the worker

`approve` runs it inline after its transaction commits and awaits it, as it awaits the export
today; the route returns the delivered or blocked outcome. A crash, a dropped request or a
controller stop leaves the outbox row at its last step.

### 5.4 Reconciliation

`reconcileWorkOrder` gains `case "delivering"`, which resumes the worker from the outbox row's
step. `reconcileAll` already runs on `up`'s boot reconcile and on `factory reconcile`
(`reconcile.ts:17`), so both reach it. A `delivering` row with no outbox row is impossible by
construction (one transaction) and blocks `delivery_unconfirmed` if met.

This is the deliberate difference from `reconcileExporting`, which never writes after a restart
(§2.1). A local export has nothing to look at but its own directory, and a missing file after a
crash means the write never happened; re-exporting would be a second decision. A remote delivery
has an authoritative remote to read before each write, and RFC §10.3 asks exactly for that:
inspect, reconcile, then continue under the intent already committed. Both rules hold the same
line: no write that the approval did not authorize, and no claim of delivery without a read.

---

## 6. The GitHub adapter

### 6.1 Tokens

- The controller signs a JWT (RS256, `iss` the app id, `iat` 60 s in the past, `exp` 9 minutes
  ahead) with `node:crypto`; no new dependency.
- The installation id is read with the JWT from `GET /repos/{owner}/{repo}/installation`, once
  per worker run.
- The installation token is minted with `POST /app/installations/{id}/access_tokens`, **downscoped
  in the request** to `repositories: [<name>]` and the permissions delivery needs. GitHub refuses
  to mint a token wider than the installation, so a request for exactly these is also a check
  that the installation still grants them. The response's `permissions` are compared to the
  requested set; anything missing is `delivery_unauthorized`.
- A token lives in memory for one worker run (at most an hour, GitHub's limit; the worker's
  bound is shorter). It is never written to the registry, the journal, a log, a file, argv or a
  child's environment.

### 6.2 The allow-list

The adapter's single request function accepts only these method and path shapes, and a unit test
asserts that every other method (`PATCH`, `PUT`, `DELETE`) and path is refused before a socket
opens:

```
GET  /repos/{o}/{r}/installation                      (JWT)
POST /app/installations/{id}/access_tokens            (JWT)
GET  /repos/{o}/{r}
GET  /repos/{o}/{r}/rules/branches/{branch}
GET  /repos/{o}/{r}/issues/{n}                        (§15: needs issues: read)
GET  /repos/{o}/{r}/git/ref/heads/{branch}
GET  /repos/{o}/{r}/compare/{pin}...{sha}
GET  /repos/{o}/{r}/git/commits/{sha}
GET  /repos/{o}/{r}/git/trees/{sha}
POST /repos/{o}/{r}/git/blobs
POST /repos/{o}/{r}/git/trees
POST /repos/{o}/{r}/git/commits
POST /repos/{o}/{r}/git/refs                          (refs/heads/factory/* only)
GET  /repos/{o}/{r}/pulls?head=…&state=all
POST /repos/{o}/{r}/pulls                             (draft: true, base: the configured base)
GET  /repos/{o}/{r}/pulls/{n}
POST /graphql                                         (one fixed read-only query: closingIssuesReferences)
```

`{o}/{r}` must equal the configured repository and `refs/heads/factory/` is checked on the ref
the adapter creates, so a bug elsewhere cannot point a write at another repository or branch.

### 6.3 Building the commit from the bundle

The candidate artifact holds `changes: Record<workspacePath, text>`. For each path:

1. The repository path is `pathPrefix === "." ? path : pathPrefix + "/" + path`.
2. The expected blob sha is git's `sha1("blob " + byteLength + "\0" + utf8Bytes)`, computed
   locally.
3. At step (a), the pin's entry for the path is read by walking the pin's tree one directory at a
   time (`GET git/trees/{sha}`, non-recursive, so a large repository never meets the recursive
   listing's truncation). The entry must exist, be a blob with mode `100644` or `100755`, and its
   sha must equal the git blob sha of **the baseline bytes** for that path. Otherwise
   `delivery_baseline_mismatch`: the candidate was diffed against bytes that are not the pin's
   (an export filter in `.gitattributes`, a target whose capture is not the repository), and the
   approved change cannot be stated as a change to the pin.
4. The expected root tree sha is computed locally from those directory listings with each changed
   entry's sha replaced, bottom-up, in git's tree encoding. Modes are kept from the pin; the
   candidate cannot change them.

Step (b) creates each blob (`encoding: base64` of the UTF-8 bytes; the returned sha must equal
the local one), the tree with `base_tree` set to the pin's tree and one entry per changed path
(the returned sha must equal the expected root tree sha), and the commit with parents `[pin]`.
Any disagreement between a returned sha and the local one is `delivery_unconfirmed` with both
values journalled; it would mean the bytes GitHub holds are not the approved bytes.

### 6.4 The applies-cleanly check (author's decision)

`GET /repos/{o}/{r}/compare/{pin}...{baseTip}`. Delivery proceeds only if:

- `status` is `ahead` or `identical` (the pin is an ancestor of `main`; anything else means the
  pin left `main`'s history, which a force-push to `main` would do);
- the compare is complete: `files` is below GitHub's per-comparison file cap (300) and the
  response does not report truncation; a comparison too large to read in full is refused as
  unverifiable rather than guessed at;
- no file in `files` (by `filename`, and by `previous_filename` for a rename) is one of the
  change's repository paths or a delivery-protected path (§9.3).

Why file-level disjointness and not a line-level three-way merge:

- It is read-only, needs only the app token, and answers about GitHub's `main`, which is where
  the PR goes. A local `git merge-tree` would need `main` fetched into the operator's clone, and
  would answer about that clone.
- It is conservative in the right direction. A same-file change that a three-way merge would
  accept is refused with the overlapping paths named, and the remedy is cheap and honest: a new
  work order at today's tip (`run --issue N --new`), whose candidate is verified against the code
  it will actually merge into. Accepting a textual merge would publish a combination nobody
  verified.
- What it does not catch, a semantic conflict in files the change did not touch, no merge
  algorithm catches either; that is what the PR's own CI on the merge commit is for (§11).

The PR body states the pin, `baseTip`, and `aheadBy` from this response.

### 6.5 Rate limits, errors and the worker's bound

- A `429`, or a `403` carrying `retry-after` or `x-ratelimit-remaining: 0`, is a rate limit:
  wait `retry-after` (or until `x-ratelimit-reset`), at most 60 s per wait, then retry the same
  read-before-write step.
- A `5xx` or a network error is retried the same way with exponential backoff from 2 s.
- A `401`, or any other `403`, is `delivery_unauthorized` at once.
- `409` and `422` are never retried blindly: each is answered by the read the step already
  defines ((c) and (d) above); an unexplained one is `delivery_unconfirmed` with the response
  body journalled (scrubbed).
- The bound: five attempts per step and ten minutes per worker run; past it, the rate-limit case
  blocks `delivery_rate_limited` and the rest `delivery_unconfirmed`. These numbers are §15's.

---

## 7. The pull request

### 7.1 Title

The first `# ` heading of the approved `spec.md`, else the issue's title as recorded in
`issue.md`, with control characters and line separators removed and truncated to 200
characters, prefixed `factory: `. The title is model-influenced text and is treated as such:
it is display only, and it cannot carry a closing keyword's effect because GitHub does not
link issues from titles.

### 7.2 Body

Rendered by the controller from frozen data only, in this order:

```
Refs #<n>

Produced by the B4.run software factory from issue #<n> and approved by a person
(recorded actor: <decidedBy>) on <decidedAt>. This is a draft. The factory never merges.

## Pin and drift
Branched at <pin>. main was at <baseTip> when delivered, <aheadBy> commits ahead of the pin.
No file this change touches changed on main in between.

## Approved task
<spec.md, in a fenced block>

## Digests and receipts
task <taskDigest> · bundle <bundleDigest> · candidate <candidateDigest>
oracle receipt <oracleReceiptId> · verification receipt <receiptId> · re-verification at approval <receiptId>
policy <policyDigest> · environment <environmentIdentity>

<one line per changed path: repository path, before and after blob sha>
```

- `Refs #N` when the issue is in the PR's repository, `Refs owner/name#N` otherwise. Never
  `Closes`, `Fixes` or `Resolves`.
- `spec.md` is model-written. It is rendered inside a fenced block whose fence is the longer of three
  backticks and one more than the longest backtick run in the text, so it cannot close the fence and write
  outside it (a fake "approved by" line, a closing keyword in prose). The spec's bytes are the
  ones whose digest is the frozen `taskDigest`, re-read and re-digested at render.
- A body over GitHub's 65,536-character limit truncates the quoted spec with a line saying so;
  the digests are always present, and they are the authority.

### 7.3 The closing-issue check

Confirm reads the PR's `closingIssuesReferences` through one fixed GraphQL query and requires
it empty. If the fence is ever wrong, the PR exists but would close an issue on merge; the work
order blocks `delivery_unconfirmed` naming the referenced issues, and a person edits the PR
body. The scratch lane (§14) proves GitHub ignores keywords inside a fenced block.

### 7.4 What the person sees before approving

`factory review` on a draft-PR bundle prints, above the diff it already prints: the operation,
the repository, `factory/<id>`, the base, the pin, and "Approving publishes exactly this
change as a draft pull request". The bundle digest the person types the prefix of covers all of
them. `show` prints the row and, when one exists, the delivery receipt with the PR URL; `run`
prints the URL on `delivered`; `list` shows it beside the state.

---

## 8. Configuration and credentials

### 8.1 `factory.config.ts`

```ts
export default {
  state: ".factory",
  controller: { port: 4300 },
  builder: { port: 4100 },
  drafter: { port: 4200 },
  delivery: {
    draftPr: {
      repository: "cacheplane/b4run",
      baseBranch: "main",
      app: { id: 123456, privateKeyFile: "~/.config/b4-factory/app.pem" },
    },
  },
} satisfies FactoryUpConfig
```

- `delivery` is optional; without it, `--deliver draft-pr` is refused at create.
- Validated strictly, following `parseFactoryConfig`: `repository` matches
  `REPOSITORY_PATTERN`; `baseBranch` is a plain branch name; `app.id` a positive integer;
  exactly one of `app.privateKeyFile` (a path; `~` expanded) or `app.privateKeyEnv` (the name of
  a variable `up` reads).
- Near-misses are refused by name in `REPLACED`, so a key the reader might write is never
  silently dropped: `token`, `githubToken`, `pat` ("delivery uses a GitHub App; the config names
  an app id and where its key is"), `privateKey` given inline ("the config names no secret; use
  `privateKeyFile` or `privateKeyEnv`"), `installationId` ("read from the repository at each
  delivery"), `branchPrefix` ("fixed at `factory/`; the CI guards key on it").
- The key file must exist, be a regular file, not be readable by group or other (mode `0600` or
  stricter), and lie outside every app root and the state directory, checked by identity as
  `physicallyInside` already does for the state directory (`factory-config.ts:103-124`).

### 8.2 `up`

- `up` reads the key once (from the file, or the named variable) and gives the controller
  `FACTORY_GITHUB_APP_ID` and `FACTORY_GITHUB_APP_PRIVATE_KEY_FILE` pointing at the file (for
  the env form, `up` writes the key to a `0600` file under `<state>/run/`, removed on stop).
  The controller receives a path, never the key in its environment.
- `NOT_INHERITED` gains every `FACTORY_GITHUB_APP_*` name, so neither worker inherits one
  (§2.4's finding), and `ownSubprocessEnv` drops them too.
- `redactor` gains the private key's body (every line of it) and the app id is not secret.
- A controller started by hand reads the same two variables (`loadConfig`,
  `controller/src/lib/config.ts:164`); `FACTORY_GITHUB_APP_PRIVATE_KEY` with the PEM inline is
  accepted there for tests and deleted from `process.env` as the first act of boot, before any
  `git` or `docker` child is spawned (§2.4: they inherit the environment).

### 8.3 Scrubbing

Everything the delivery path journals or returns (error messages, response bodies, the
`last_error` column) passes through one scrubber that removes the current installation token,
any `ghs_`/`ghu_`/`gho_`/`github_pat_` shaped string, any PEM block, and `Authorization`
headers. The journal is persistent and is printed by `events`; it is the place a leak would last.

---

## 9. CI exposure and the guards

### 9.1 The guard

One conjunct added to the `if` of each guarded job:

```yaml
!startsWith(github.event.pull_request.head.ref, 'factory/') &&
github.event.pull_request.user.login != 'b4-factory[bot]'
```

`b4-factory` is the recommended app name (§15, item 1); the login is whatever Brian names the
app, fixed before sub-project 1 lands.

- `vercel-native` (`ci.yml:702-711`): conjoined to the `pull_request` arm only, so the push-to-`main`
  arm still runs after a factory PR merges.
- `auto-approve.yml` `approve` (`:24`).
- `claude-review.yml` `review` (`:36`).

Both halves, because either alone has a gap: the branch prefix is what the ruleset confines the
app to and what the Vercel guard can see; the author is what a person cannot fake by naming a
branch, and catches the app if it ever wrote outside `factory/`.

### 9.2 The Vercel preview build

`apps/web/scripts/vercel-ignore-build.sh` exits 0 (skip) first thing when `VERCEL_GIT_COMMIT_REF`
starts with `factory/`, before the production check. Its test
(`apps/web/app/vercel-ignore-build.test.ts`) gains the case.

### 9.3 Delivery-protected paths

The guards in §9.1 and §9.2 live in files a same-repository PR could edit, and a `pull_request`
run uses the PR's merge commit's workflows (§2.5); the Vercel build runs the branch commit's
ignore script. So the candidate must never be able to change them. A constant in the controller,
`DELIVERY_PROTECTED_PATHS`:

```
.github/**
apps/web/vercel.json
apps/web/scripts/vercel-ignore-build.sh
```

Enforced three times, by the mechanisms that already exist (§2.3):

1. **Intake fit.** For a draft-PR work order, a draft whose `allowedSourcePaths` (joined to the
   target's root) meets a protected path is `intake_invalid`, naming each path, and redrafts like
   any fit failure. The person approves a `task.json` that cannot name one.
2. **Assembly**, unchanged: the candidate can change only the task's exact allowed paths and can
   add nothing (`assemble.ts:113-131`).
3. **Approval and step (a)**: the changed paths are checked against the list again (§3.4), and
   `main`'s changes since the pin must not touch a protected path either (§6.4). The second
   matters for the Vercel guard: the branch is built from the pin's ignore script, so a pin from
   before the guard landed carries the unguarded script and is refused, because `main` has
   changed that file since.

The workflow guard needs no pin condition: a PR that does not touch `.github/**` runs `main`'s
workflows at the merge commit. And as a backstop GitHub refuses to let an app without the
`workflows` permission create a ref whose commit changes `.github/workflows/**`; the app is not
granted it, and the scratch lane (§14) proves the refusal rather than assuming it.

### 9.4 The test that keeps the guards

A new test in `scripts/release/test/workflow-contracts.test.mjs`, in the file's existing style
(parse every workflow from source, assert, then mutate the parsed source and assert failure):

> Every job reachable from a `pull_request` trigger that references a secret other than
> `GITHUB_TOKEN`, names an `environment`, or is granted any `write` permission other than
> `security-events` must carry the factory guard, both halves, in its `if`.

The rule is generic on purpose: a new secret-bearing job fails the test until it carries the
guard, rather than escaping a list of three names. `codeql.yml`'s `security-events: write` is the
one exempt write. The mutation cases: each guard removed, each half removed, the bot login
misspelt, `startsWith` on `head.label` instead of `head.ref`, and a new job with a secret and no
guard. A second assertion: no workflow listens on `repository_dispatch`, which `contents: write`
can send (§10.1). A third: `DELIVERY_PROTECTED_PATHS` covers `.github/**` and the two Vercel
files named in `apps/web/vercel.json`'s `ignoreCommand` (the test reads both), so moving the
script without moving the protection fails.

`workflow-entrypoints.json` changes in the same commit (each guarded job's `if`);
`workflow-safe-executables.json` is checked and changes only if a step does. Neither has a
generator; both are edited and reviewed by hand.

---

## 10. Trust and security analysis

### 10.1 What the installation token can and cannot do

**Can**, by its permissions, whatever the controller's code does:

- With `contents: write`: create blobs, trees, commits and refs; update or delete refs; create
  tags; **merge a PR** through the API (branch protection still requires `validate`); create,
  edit and delete releases and release assets; send `repository_dispatch`. The ruleset (§10.2)
  limits the ref writes; **nothing limits the release endpoints or `repository_dispatch`** except
  that the token is the controller's alone, lives at most an hour, and the adapter's allow-list
  (§6.2) has no such path. That residual is accepted, stated here, and is the reason the token
  never leaves the controller.
- With `pull_requests: write`: open, edit, close and comment on any PR; mark a draft ready;
  request reviewers; enable auto-merge (`allow_auto_merge` is on). It cannot approve a PR it
  authored.
- With `metadata: read` (and `issues: read`, §15): read.

**Cannot**: touch workflow files (no `workflows` permission); dispatch workflows (no
`actions: write`); read or write secrets, environments or settings; act on another repository
(the token is downscoped to one); outlive an hour.

**The controller's code** narrows that to: one ref creation under `refs/heads/factory/`, one
draft PR on that ref, the objects they need, and reads. No update, force, delete, merge, ready,
comment or close exists in the adapter, and a test proves the allow-list refuses them.

### 10.2 The ruleset

Brian creates it with the app (§13, operator setup). Rulesets cannot target one actor, so the
confinement is a ruleset whose bypass list is everyone the repository needs except the factory
app:

- **"factory app confined"**: target all branches except `refs/heads/factory/**`, and all tags;
  rules: restrict creations, restrict updates, restrict deletions; bypass: the repository Admin,
  Maintain and Write roles, the GitHub Actions integration, Dependabot, and any other identity
  that pushes refs today (§15). The factory app is on no role and on no bypass list, so it can
  create no branch or tag outside `factory/**` and update nothing on `main`, which also stops an
  API merge by the app.
- **"factory branches are append-never"**: target `refs/heads/factory/**`; rules: restrict
  updates, block force pushes; bypass: Admin. Creation is allowed, so the factory can create its
  branch and can never move it, which makes "never rebase or force-push" a property of the
  repository, not only of the code. Deletion stays allowed so `delete_branch_on_merge` and a
  person's cleanup work.

At preflight (§3.4), the controller reads `GET rules/branches/main` and
`GET rules/branches/factory/<id>` and refuses delivery as `delivery_unauthorized` unless the
first lists an `update` rule and the second lists `update` and `non_fast_forward`. That checks the
rulesets exist, not their bypass lists, which a token cannot read; the bypass list is verified
once in the scratch lane and in the live run (§14).

### 10.3 Candidate code and CI

- The candidate runs in CI on a factory PR: `validate`'s lanes, `changesets`, `codeql`,
  `kubernetes-compat`, and the gated lanes that run on PRs. Each holds only the read-only
  `GITHUB_TOKEN` (default workflow permissions are `read`; `ci.yml:9-10`). That is the same
  exposure as any same-repository contributor's PR and is accepted: it is the point of CI.
- The candidate does not run where a secret is: `vercel-native`, the Vercel preview build,
  `claude-review` and `auto-approve` skip it (§9.1, §9.2), and it cannot edit the files that say
  so (§9.3).
- One residual is manual: `workflow_dispatch` lets a maintainer run a workflow against any ref,
  so dispatching, for example, `release.yml`'s `detect` (`contents: write`, no `if:`) on a
  `factory/*` ref would run a write-scoped job in a run keyed to the factory ref, which the
  guard (§9.1, `pull_request` jobs only) does not see. The app has no `actions: write` and
  cannot dispatch it; maintainers must not dispatch workflows on factory refs.
- If a candidate edits `.github/**`: it cannot. The drafted task cannot list such a path (§9.3,
  intake); the assembly refuses any path the task does not list (`assemble.ts:130-131`); approval
  checks again; GitHub refuses the ref for an app without `workflows` (§9.3). Four independent
  refusals, and the guard test (§9.4) fails if the guards themselves are edited by a person.

### 10.4 Model-written text in the PR

The title and the quoted spec are model-written; the issue body is not quoted at all. The fence
(§7.2) keeps the spec from writing outside its block; the closing-issue read (§7.3) is the check
on the fence. A PR body is model input for nobody: `claude-review` skips factory PRs.

### 10.5 Who holds what

| Process | Holds | Never holds |
|---|---|---|
| Controller | the app id, the key file path, at most one installation token in memory per worker run | the OpenAI key (`up.ts:189-190`), a provider key |
| Builder, drafter | the OpenAI key, the worker token | any `FACTORY_GITHUB_APP_*` (§8.2), any token |
| `up` | the key, read once to check it and to write the env form's file | it passes the controller a path |
| CI on a factory PR | a read-only `GITHUB_TOKEN` | the Vercel secrets, the Anthropic key, a write token |

---

## 11. What the human review of the PR is not

- **CI on the PR is not the factory's verifier.** The verifier ran the approved checks in the
  bound image at the pin, and approval re-ran them; that is what the bundle digest attests. The
  PR's CI tests the merge with today's `main`, a different question with a different answer
  allowed. A red CI on a delivered PR is information for the person, not a factory failure, and
  the factory does not react to it.
- **The draft PR is not a second approval.** The approval that mattered was the bundle's; the PR
  is its publication. Nothing the person does on the PR feeds back into the work order, which is
  `delivered` and terminal.
- **A person merges.** The factory never marks the PR ready, never merges, never closes it,
  never pushes to it. Merging is RFC §10.4's release boundary and out of scope here.
- **A release-bearing change needs a person's commit.** A factory PR that touches a publishable
  package has no changeset (a candidate cannot add a file) and skips `vercel-native` (§9.1),
  which AGENTS.md requires green for release-bearing changes. The person who takes it forward
  checks the factory's commit out onto their own branch, adds the changeset, opens their own PR
  (which runs every lane, `vercel-native` and `claude-review` included) and closes the factory
  PR with a link. §15 records the alternative.

---

## 12. Failure modes

| What happens | Where | What the factory does | Ends |
|---|---|---|---|
| Response to blob/tree/commit create lost | (b) | Recreate; same bytes give the same blob and tree shas; a duplicate commit object is harmless | Continues |
| Response to ref create lost; retry gets 422 | (c) | Read the ref; parents `[pin]` and the expected tree mean ours | Continues |
| Response to PR create lost; retry gets 422 | (d) | List PRs by head; ours if base and head match | Continues |
| Controller killed mid-step | any | Boot reconcile resumes from the outbox step; every step reads first | Continues |
| Two `approve` calls for the same bundle | approve | The command log replays the outcome; the outbox row is unique per work order | One delivery |
| `main` changed a touched file since the pin | (a) | Refuse, paths named | `delivery_base_conflict` |
| Pin no longer an ancestor of `main` | (a) | Refuse | `delivery_base_conflict` |
| Comparison too large to read in full | (a) | Refuse as unverifiable | `delivery_base_conflict` |
| A protected path changed on `main` since the pin | (a) | Refuse | `delivery_base_conflict` |
| Pin's blob is not the baseline the candidate was diffed against | (a) | Refuse, both shas journalled | `delivery_baseline_mismatch` |
| `factory/<id>` exists with another commit | (c) | Refuse; never update | `delivery_branch_conflict` |
| The factory's PR was closed by a person | (d), confirm | Refuse; never reopen | `delivery_branch_conflict` |
| App uninstalled, key rotated, permission removed | preflight, any | Refusal at approve; block mid-delivery | refusal, or `delivery_unauthorized` |
| A 401 or a non-rate-limit 403 | any | Stop at once | `delivery_unauthorized` |
| Rulesets missing | preflight | Refuse | refusal at approve |
| Rate limited past the bound | any | Backoff, then block | `delivery_rate_limited` |
| 5xx or network past the bound | any | Backoff, then block | `delivery_unconfirmed` |
| GitHub returns a sha the local computation disagrees with | (b) | Stop; both journalled | `delivery_unconfirmed` |
| The PR would close an issue on merge | confirm | Block; the PR exists; a person edits the body | `delivery_unconfirmed` |
| The issue was closed after create | (a) | Refuse (§15) | `delivery_issue_closed` |
| Cancel during delivery | between steps | Stop before the next write; journal what exists remotely | `cancelled` |
| Bundle expired before approval | approve | Unchanged from today | refusal |
| Candidate lists a protected path | intake fit | Redraft with the paths named | `intake_invalid` or a redraft |

---

## 13. Sub-projects and order

Each is its own plan under `docs/superpowers/plans/`, PR and proof.

| # | Sub-project | Depends on | Proof |
|---|---|---|---|
| 1 | **CI guards.** The `if` conjuncts in `ci.yml`, `auto-approve.yml`, `claude-review.yml`; the Vercel ignore-script guard and its test; the generic guard test in `workflow-contracts.test.mjs`; `workflow-entrypoints.json` (and `workflow-safe-executables.json` if it changes) in the same commit. The guard names the app's bot login, so Brian names the app first (§15, item 1) | the app's slug | §9.4's test, mutation cases included; `pnpm test:release-integrity` and the focused contracts file before the full controller suite, as AGENTS.md asks |
| — | **Operator setup (Brian, not a PR):** create the GitHub App with the three permissions (four, §15), install it on `cacheplane/b4run` and on a scratch repository, create the two rulesets of §10.2 on both | 1 merged before any `factory/*` branch exists on `cacheplane/b4run` | The scratch lane (sub-project 3) |
| 2 | **Delivery bound in the bundle**, controller only, no network: `--deliver` on `create` and `run`; the row's `delivery` and migration 6; the bundle union; freeze and approve checks; protected paths at intake fit; the states, events, reasons and `run` steps; `redeliver`; the outbox table and the worker against a `DeliveryAdapter` interface with a fake; `show`, `review`, `list` displays; config schema for `delivery` (refused at create while no adapter is wired) | — (parallel with 1) | Unit tests: old bundles parse and approve as `export-local` with unchanged digests; a changed delivery field invalidates; the state table; the worker's step table against the fake |
| 3 | **The GitHub adapter**: JWT and token minting, the allow-list, the Git Data API sequence with local hash computation, the compare check, the PR body, the GraphQL read, rate-limit handling, scrubbing; `up`'s credential wiring (§8.2); the fake GitHub with fault injection; the opt-in scratch lane | 2; the operator setup for the lane | §14's unit and scratch-lane proofs |
| 4 | **Live run on `cacheplane/b4run`**, recorded as evidence in the work orders and as an as-landed note in this spec | 1, 3, the operator setup | §14's live proof |

1 and 2 run in parallel worktrees. 3 needs 2. 4 needs everything. Sub-project 1 must be merged
before the first `factory/*` branch is created on `cacheplane/b4run`, which only 4 does.

**As landed (PR 3).** Sub-project 2, implemented by
[the rung 4 plan](../plans/2026-10-01-software-factory-rung4.md) Tasks 5-16 on
`blove/factory-rung4-delivery` (stacked on PR 1's `blove/factory-rung4-ci-guards`, which
provides `guard.json`). Delivery is **not yet usable end to end**: PR 3 runs only against an
in-memory fake GitHub with fault injection and makes no network call. The real adapter, token
minting, the controller's delivery configuration and `up`'s wiring arrive in PR 4; until then
the runtime passes no delivery and `--deliver draft-pr` is refused at create with
`delivery_unavailable` (plan D20). What landed: `--deliver` on `create` and `run`; the row's
`delivery` and registry migration 6; the bundle's operation union, with the draft-PR digest
covering operation, destination, pin and delivery (an existing export-local bundle digests
identically, pinned); `delivering`, `delivered`, the seven delivery reasons and `run`'s steps
for them; the protected paths at intake, approval and step (a); git blob and tree ids computed
locally; the outbox committed with the approval; the worker's read-before-write steps;
`redeliver`; and the delivery in `review`, `show` and `list`. Where it departs from this spec,
the plan's decisions say why:

- **D14 (spec correction 2).** The Git Data API sequence, the hashing, the PR body, the retry
  policy and the scrubber are PR 3's, behind a `DeliveryAdapter` interface, tested once against
  the fake; PR 4's adapter only maps HTTP to it (§13 sub-project 3 had them).
- **D18 (correction 5).** The quoted spec is captured at approval: approve reads the generated
  task once, refuses unless it digests to the frozen `taskDigest`, and stores `spec.md`'s text in
  the outbox intent, so a resumed worker reads no file a person can edit (§7.2 re-read it at
  render).
- **D19 (correction 6).** Reconcile starts a `delivering` row's worker tracked and returns; it
  does not await it (§5.4 "resumes"). `approve` and `redeliver` still await theirs.
- **D21 (correction 10).** Approval's order: delivery equality, configured destination,
  protected paths (no network), preflight (network), the generated task re-read, then the
  re-verification (§3.4 had preflight before the protected paths).
- **D23.** `approve` of a draft-PR bundle answers `ok: true` only when the work order is
  `delivered`; a block answers `ok: false` with the reason and the approval stays recorded. The
  CLI exits 1 and prints `pnpm factory events <id>` and, for a healable reason,
  `pnpm factory redeliver <id>`.
- **D24.** `cancel` during a delivery uses today's `finishCancel` (it asks the builder about the
  row's old thread); the worker checks the row before every write and journals
  `delivery_stopped` with the remote ids that exist.
- **Correction 12.** `pathPrefix` is nullable on the row until intake fills it in the
  `intake_drafted` transaction; the bundle requires it, and `verify` refuses a draft-PR row
  without one as `verification_inconclusive`.

---

## 14. Proof

**Unit, against a fake GitHub** (an in-process HTTP server speaking the allow-listed endpoints,
with a fault script per test):

- A clean delivery: blobs, tree, commit, ref, draft PR, confirm; the receipt's tree sha equals
  the locally computed one.
- A response dropped after each write (blob, tree, commit, ref, PR): the worker resumes and ends
  with exactly one ref and one PR.
- A controller "restart" (a fresh worker over the same registry) at every step boundary.
- `422 Reference already exists` with our commit (confirmed) and with another commit
  (`delivery_branch_conflict`); `422` PR already exists (confirmed); a closed PR on the branch
  (`delivery_branch_conflict`).
- `401`, `403` without rate headers, a mint refusal, a mint whose permissions come back narrower
  (`delivery_unauthorized`); `429` and `403` with `retry-after` within and past the bound; `5xx`
  past the bound.
- A compare with a touched file, a protected path, `diverged`, and a full 300-file page
  (`delivery_base_conflict` each, the journal naming which).
- A pin blob that differs from the baseline (`delivery_baseline_mismatch`).
- A returned blob or tree sha the local computation disagrees with (`delivery_unconfirmed`).
- A spec containing a backtick fence and `Fixes #1`: the body's fence holds; a fake
  `closingIssuesReferences` that is non-empty blocks.
- The allow-list refuses `PATCH`, `PUT`, `DELETE`, another repository and a ref outside
  `factory/`.
- No token, PEM or `Authorization` header in any journal line, outcome or log across the whole
  suite (a scan of the registry and captured output after each test).
- Cancel between steps; `redeliver` from each reason, refused from the non-resumable ones.

**Scratch repository, opt-in** (`FACTORY_TEST_GITHUB_SCRATCH=<owner/name>` plus the app's
credentials; skipped otherwise; never set in CI): the same clean delivery and the lost-response
cases against real GitHub, then: the ruleset refuses the app a branch outside `factory/**`, an
update to its own `factory/*` branch, and a tag; GitHub refuses a ref whose commit changes
`.github/workflows/**` for the app without `workflows`; a fenced `Fixes #N` yields no
closing reference. Each run records the response status codes and body shapes it saw (tokens
stripped) into a fixture the fake's own contract test replays, so the fake cannot drift from
GitHub silently.

**Live, on `cacheplane/b4run`, Brian at both gates**, through `pnpm factory up` and
`pnpm factory run --issue <n> --deliver draft-pr`:

1. A fresh open issue at `main`'s tip, end to end into a real draft PR: confirm the PR's author,
   draft state, branch, body, that `vercel-native`, the Vercel preview, `claude-review` and
   `auto-approve` skipped it, and that `validate` ran. Rerunning `run` answers "Already
   delivered" with no second PR. Brian decides what happens to the PR (§11).
2. A replay of #714 at its old pin (`765e6e16`): its fix is already on `main`, so the touched
   file changed since the pin, and delivery must refuse `delivery_base_conflict` naming it, with
   nothing created on GitHub. This is the refusal path proven live.

---

## 15. Decisions still open

Each with the author's recommendation. None blocks sub-project 2; 1, 3 and 4 each need the
ones marked.

1. **The app's name and bot login** (blocks 1). The guard names `<slug>[bot]`. Recommendation:
   `b4-factory`, so `b4-factory[bot]`.
2. **`issues: read` on the app** (blocks 3). Reading an issue's state with an installation token
   needs the `issues` permission even on a public repository, as far as I know; without it the
   issue-closed check cannot run from the controller. Recommendation: grant `issues: read`
   (read-only; it cannot comment, label or close), and the scratch lane proves whether it is
   needed.
3. **The issue-closed policy for replays.** Recommendation, as designed in §3.2:
   `issueStateAtCreate` is recorded, and delivery refuses only an issue that was open at create
   and is closed now (someone fixed it meanwhile); a replay of an issue already closed at create
   proceeds and the PR body says it was closed. The alternative, refusing every closed issue,
   makes replays undeliverable.
4. **The bypass list of "factory app confined"** (blocks the operator setup). Who pushes refs
   today: version-pr's branch (`RELEASE_GITHUB_TOKEN`; whose identity?), release tags, Dependabot,
   and anything else. Recommendation: before enabling, list the pushers of the last 90 days'
   refs and tags (`gh api` on events), put each identity on the bypass list, enable it on the
   scratch repository first, and watch one release ceremony on `cacheplane/b4run` after enabling.
   If any release identity cannot be listed, scope the ruleset to `main` and `v*` tags only and
   record the remaining branches as a residual.
5. **Draft from the start.** Recommendation: yes, `draft: true` on create. One write, no window in
   which the PR reads as ready, and `auto-approve`'s `ready_for_review` trigger is guarded anyway.
6. **Retry numbers.** Recommendation: five attempts per step, 60 s cap per wait, ten minutes per
   worker run, exponential backoff from 2 s for `5xx`. Revisit after the live run.
7. **`redeliver` and the approval's age.** The approval's `expiresAt` is the bundle's window,
   not the delivery's. Recommendation: `redeliver` requires the bundle digest's prefix typed at a
   terminal (the `review` prompt's own), is allowed for 24 hours after the approval, and beyond
   that the remedy is a new work order. The alternative is no limit, on the argument that the
   bytes and destination are unchanged.
8. **Adopt or merge directly** (§11). Recommendation: for a change touching a publishable package,
   adopt onto a person's branch so the changeset and `vercel-native` happen; for a change touching
   only examples, docs or scripts, a person may merge the factory PR as is. The alternative,
   always adopt, is simpler to state and costs one extra PR per delivery.
9. **Vercel-side protection in addition to the script.** The ignore script is the only Vercel
   gate and it is repository-controlled. Recommendation: keep §9.2 as the gate (it is tested and
   protected), and also check whether the Vercel project's Git settings can exclude `factory/*`
   at the team level; if they can, enable it as a second layer.
10. **Which open issue for the live run.** Recommendation: a small open issue in a package with a
    prepared target, chosen the day of the run, at `main`'s tip, so the base-drift check meets a
    real `aheadBy` but no overlap.

---

## 16. Out of scope

- Merging, marking ready, closing, labelling or commenting on the PR; any reaction to the PR's CI
  or reviews (RFC §10.4).
- Release, publication and deployment of a merged change.
- Rebasing a delivered PR onto a newer `main`; updating a delivered PR for any reason.
- Delivering catalog (lab) tasks as PRs (§3.1).
- Delivering to a repository other than the issue's, to forks, or to more than one repository
  per controller.
- Label-driven or scheduled delivery; a standing token; a Workbench view of deliveries.
- Removing the `repositoryId: taskId` misnomer (§2.1), which would move every export-local
  digest.
- Signed commits: `main` does not require signatures, and whether GitHub signs an app's API
  commit is irrelevant to the receipt, which is by tree and parent.
