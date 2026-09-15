# Code-fixer B4 app

An ordinary B4 agent repairs a controlled historical defect in a Docker workspace.
The CLI fixture is the default. The nullable-input fixture remains available for
harder evaluations. Their original source, reference patches, and recordings are
historical evidence and are not rewritten to describe this implementation.

## Run

From the monorepo root, install dependencies and build the libraries, then prepare
the fixture image. Node 24, pnpm, Git, and running Docker are required.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @b4-example/code-fixer-server sandbox:prepare
pnpm --filter @b4-example/code-fixer-server check
pnpm --filter @b4-example/code-fixer-server dev
```

Provide `OPENAI_API_KEY` in the host environment or the server's local `.env`.
The key is not passed into containers. Connect your existing B4 client to the
`/fix` agent and ask it to read TASK.md and repair the defect. The default model
is `gpt-5-mini`. The app uses ordinary B4 route discovery, workspace tools, plans,
skills, and runtime approval. No evaluation process is required to run it.

For built Node execution:

```sh
pnpm --filter @b4-example/code-fixer-server build
pnpm --filter @b4-example/code-fixer-server start
```

Set `B4_CODE_FIXER_TASK=nullable-inputs` on the host to select the other fixture
for new workspaces. Existing threads retain their captured source. The configured
Docker scope identifies this local application; separate installations need
separate scopes. Network is denied, dependencies are prepared read-only links,
and command limits are 1 CPU, 1024 MB, and 120 seconds.

## Review

The agent calls `prepareReview` to return independently verified source changes,
a readable diff, and the complete candidate. It then passes that exact candidate
to `exportForReview`. B4 presents the approval gate before export. Denial writes
nothing; edits while approval is pending require a new candidate and approval.

Approved candidates are checked again in a fresh managed verifier workspace and
written to `.b4/code-fixer/review-outbox/<digest>.json`. Export is local and
idempotent. Tests, configuration, dependencies, additional/deleted files,
symlinks, and oversized changes are rejected. Initial captured bytes—not the
agent-editable Git directory—define the baseline. Named independent assertions
remain outside the agent workspace and are installed only into the verifier.

## Evaluation and contributor checks

```sh
pnpm --filter @b4-example/code-fixer-server test
pnpm --filter @b4-example/code-fixer-server test:sandbox
pnpm --filter @b4-example/code-fixer-server eval:replay
pnpm --filter @b4-example/code-fixer-server eval:live -- --attempts 3
```

Replay uses the historical repair with real route tools and independent Docker
checks. A second scripted turn forwards the candidate returned by the first turn
to the ordinary approval-gated tool. It makes no paid model calls and is labeled
replay. Batch evidence remains separate from normal application execution.
The six criteria are visible tests, independent checks, source scope, failure
reproduction, post-edit verification, and runtime approval. Historical live
results continue to describe their recorded revision, not this correction.

Application responsibilities live in `src/fixtures`, `src/review`, and
`src/evaluation`. B4 owns workspace creation, source capture, reconnection, and
cleanup. See [WALKTHROUGH.md](./WALKTHROUGH.md) for the boundaries. Maintainer
fixture qualification runs only checked-in historical code; submitted repairs
always execute in the isolated verifier.

## Blueprint distribution

The `b4 add code-fixer` guide is not yet published. The
[draft installation guide](../BLUEPRINT.md) describes the intended installation
and the remaining release checks. Publication requires a verified source revision,
a compatible published B4 release, and successful standalone qualification.
Until then, run this checkout using the commands above. This app's passing tests
do not establish that a registry installation works.
