# Code fixer

A runnable B4 agent that repairs a real historical CLI defect. Read the task,
reproduce the failure, edit source, verify the repair, and approve a local export.
Start with [`src/app/fix/index.ts`](./src/app/fix/index.ts).

## Start the app

Requires Node 24+, pnpm, Git, Docker, and an OpenAI API key. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @b4-example/code-fixer-server sandbox:prepare
pnpm --filter @b4-example/code-fixer-server check
pnpm --filter @b4-example/code-fixer-server dev --port 3001
```

Set `OPENAI_API_KEY` in the host environment or the server's local `.env` before
starting. The default model is `gpt-5-mini`. The key stays on the host.
`sandbox:prepare` builds the sample's dependencies into a Docker image; it runs
once, and again when you change those dependencies.

In a second terminal, create a thread and run the agent:

```sh
THREAD=$(curl -fsS http://127.0.0.1:3001/threads \
  -H 'Content-Type: application/json' -d '{}' | \
  node -e 'let s=""; for await (const c of process.stdin) s+=c; console.log(JSON.parse(s).thread_id)')

curl -N --fail-with-body http://127.0.0.1:3001/threads/$THREAD/runs/stream \
  -H 'Content-Type: application/json' \
  -d '{"route":"/fix#agent","input":{"messages":[{"role":"user","content":"Read TASK.md, reproduce and repair the defect, verify the change, and request approval to export the exact candidate."}]}}'
```

The stream shows tool calls, test results, and the review diff. An agent client
can use these same endpoints. No custom runner or evaluation process is needed.

## Review and approve

`prepareReview` returns a contextual diff, independent test results, and a
candidate containing the exact source changes. `exportForReview` pauses at B4's
approval gate. Inspect the prepared diff and candidate before deciding.

Read the pending request and copy its `interruptId`:

```sh
curl -fsS http://127.0.0.1:3001/threads/$THREAD/pending_interrupts
```

Then approve that request once, replacing `PASTE_INTERRUPT_ID`:

```sh
curl -N --fail-with-body http://127.0.0.1:3001/threads/$THREAD/resume \
  -H 'Content-Type: application/json' \
  -d '{"route":"/fix#agent","resume":[{"interruptId":"PASTE_INTERRUPT_ID","status":"resolved","payload":"once"}]}'
```

Use `"deny"` to decline. If a different permission request appears, inspect its
operation first; approval applies to the pending operation. The resume body must
address every currently pending interrupt exactly once.

Approved source changes are verified again in a fresh workspace, then written to
`examples/code-fixer/server/.b4/code-fixer/review-outbox/<digest>.json`.
The receipt contains the candidate and diff. Export does not
commit, push, or modify another checkout. Editing the workspace while approval
is pending invalidates the candidate; the agent must prepare it again.

When finished, delete the thread and its managed workspace:

```sh
curl --fail-with-body -X DELETE http://127.0.0.1:3001/threads/$THREAD
```

For built execution, run `pnpm --filter @b4-example/code-fixer-server build`,
then `PORT=3001 pnpm --filter @b4-example/code-fixer-server start`. The API is the same.

## Read and adapt the code

- `src/app/fix/`: the agent, tools, skill, planning, and eval definition.
- `src/project/`: declares the sample's source and workspace policy.
- `src/review/`: restricts changes, creates the review candidate, and verifies it.
- `sample/`: the broken project, task, reference repair, and independent checks.
- `scripts/prepare.ts`: the single Docker preparation step.
- `test/`: focused tests and an offline replay of this sample.

B4 owns workspace capture, lifecycle, filesystem access, inspection, and approval.
The app owns which source may change and what proves a repair. The sample's
`manifest.json` lists editable and immutable files. `checks.json` names the
assertions that must pass. Independent checks enter only the verifier workspace.
See [WALKTHROUGH.md](./WALKTHROUGH.md) for the execution path.

To adapt it, replace the sample project, task, source inventory, reference repair,
and check policy; update the Docker dependency location to match its ID. Preserve
independent verification and exact-candidate approval. Use a distinct Docker scope
for each installation. The example's policy denies network access during execution
and limits commands to 1 CPU, 1024 MB, and 120 seconds.

## Test and evaluate

```sh
pnpm --filter @b4-example/code-fixer-server test
pnpm --filter @b4-example/code-fixer-server test:sandbox
pnpm --filter @b4-example/code-fixer-server eval --live
```

The Docker tests replay the checked-in repair through real tools, independent
verification, and approval/denial. They make no paid model calls. `eval --live`
uses your model key and scores reproduction, post-edit tests, independent checks,
source scope, and approval. Offline `b4 eval` requires recorded fixtures; the
Docker tests cover the replay because candidate identities change each run.

The second historical defect, batch attempts, qualification, recordings, and
publication checks belong to the repository's
[maintainer suite](../../../test/code-fixer/), not this application.

## Install through the blueprint

`b4 add code-fixer` provides the installation instructions for your coding agent.
The published blueprint remains pinned to its qualified B4 0.8.32 source.
This checkout introduces a shared workspace API that must be released and
qualified before that installation pin advances. Use this checkout's built
packages while contributing; do not combine this source with older published B4
packages. Maintainers verify a copied app against packed packages with
`pnpm code-fixer:consumer --packed`.
