# Runnable code-fixer blueprint

One readable B4 agent repairs two historical defects. The same route uses a real
workspace, Docker sandbox, verification skill, plan, and approval-gated tool.
This is the runnable foundation for a future recorded developer walkthrough.
The homepage is a separate phase.

The CLI fixture reproduces argument forwarding from PR #399. The nullable-input
fixture runs the real TypeScript compiler → JSON schema → Zod pipeline from
PR #573 and its refreshed repair tracked in issue #605. Their manifests pin the
faulty source revisions, extraction notes, dependency locks, and permitted edits.
These are controlled historical fixtures, not claims about current defects.

## Run from the monorepo root

Prerequisites: Node 24, pnpm, Git, and Docker. Docker must be running. Image
preparation needs network access; agent and verifier containers deny network
access. Live mode additionally requires an OpenAI API key available to the host.
The key is never added to the sandbox environment.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @b4-example/code-fixer-server check
pnpm --filter @b4-example/code-fixer-server fixtures:qualify -- --task cli-flags
pnpm --filter @b4-example/code-fixer-server fixtures:qualify -- --task nullable-inputs
pnpm --filter @b4-example/code-fixer-server sandbox:prepare
pnpm --filter @b4-example/code-fixer-server test
pnpm --filter @b4-example/code-fixer-server test:sandbox
```

Qualification is maintainer tooling: it executes only the checked-in historical
source and reference patches in temporary directories. Agent-submitted patches
are executed exclusively in Docker verifier environments.

Run the whole application without a provider call:

```sh
pnpm --filter @b4-example/code-fixer-server eval:live -- --replay --attempts 1
```

Replay drives real tools with a scripted historical repair. It tests wiring,
permissions, execution, verification, and cleanup. It is explicitly labeled
`replay` and cannot be exported as a successful live recording.

For a real model run, copy `.env.example` to `.env` inside this server directory
and provide your key locally, or export `OPENAI_API_KEY` in your shell. Never
commit the key. Run either task:

```sh
pnpm --filter @b4-example/code-fixer-server run:agent -- --task cli-flags
pnpm --filter @b4-example/code-fixer-server run:agent -- --task nullable-inputs
```

The default model is `gpt-5-mini`. Set `B4_CODE_FIXER_MODEL=gpt-5` for the
model comparison used in the live-evaluation report. Initial small batches did
not establish reliable success: the revised mini configuration passed 0/6 full
workflows, while the same configuration with gpt-5 passed 3/6. See the
[retained evaluation report](../../../docs/superpowers/runbooks/2026-09-13-code-fixer-live-evaluations.md).

An interactive terminal shows the verified source diff and asks before exporting it to the local
review outbox. Answer `y` to approve once. Any other answer denies export.
Without a terminal, the run stops at `approval-pending`. No remote publication
occurs. An unavailable key produces an error; there is no silent replay fallback.

The evaluation command makes three sequential attempts for each fixture:

```sh
pnpm --filter @b4-example/code-fixer-server eval:live -- --attempts 3
```

Each attempt has its own host process and Docker workspace. Limits are 60 agent
supersteps, 120 seconds per sandbox command, 1 CPU, 1024 MB, and a ten-minute
parent-enforced deadline. The parent records acquired thread IDs before container
acquisition and destroys owned resources even if the child times out or is
cancelled. Evaluations stop before approval and preserve every attempt outcome.

The public harness does not expose authoritative billable token usage. Receipts
record it as unavailable; streamed text fragments are not counted as tokens.
The planned 100,000-token reporting threshold is checked only when actual usage
is available; it is not a hard in-flight ceiling.

## What the code demonstrates

| File | Responsibility |
|---|---|
| `src/app/fix/index.ts` | One short, task-independent agent definition |
| `src/app/fix/plan.md` | Reproduce → inspect → repair → verify → request export |
| `src/app/fix/skills/verify-change/SKILL.md` | Reusable verification guidance |
| `src/app/fix/tools/exportForReview.ts` | Actual approval-gated local export |
| `b4.config.ts` | Workspace commands and sandbox policy |
| `src/blueprint/seeded-provider.ts` | A fresh fixture per thread; edits survive reacquisition |
| `src/blueprint/verifier.ts` | Pristine tests and independent assertion receipts |
| `src/blueprint/evaluate.ts` | Deterministic B4 eval scorers over real tool observations |
| `src/blueprint/run-attempt.ts` | Process deadline, outcomes, and owned-resource cleanup |

The agent sees only the faulty target project and TASK.md. Reference repairs and
independent checks stay outside its workspace. Export compares actual file
contents against the baseline, permits only source paths in the manifest, and
rejects changed tests/configuration, added/deleted files, symlinks, and oversized
patches. It then verifies in a fresh sandbox.

Verifier assertions run outside the process that loads submitted source. Exact
named test completions are required, and project mutations during verification
are rejected. Passing demonstrates the checks covered by these fixtures; it does
not prove arbitrary software correct or replace human patch review.

## Evidence and standalone check

Outputs live under `examples/code-fixer/server/artifacts/code-fixer/` by default.
Every attempt has a UUID, outcome, captured tool activity, source changes,
independent receipts, measured durations, model/fixture/image identity, and source
provenance when available. Known host secrets and home paths are redacted before
writing results. Batch summaries retain failed attempts alongside successes.

A successful live recording requires a clean committed agent source snapshot:

```sh
pnpm --filter @b4-example/code-fixer-server evidence:export -- --input artifacts/code-fixer/ATTEMPT/result.json --output artifacts/code-fixer/recording.json
pnpm --filter @b4-example/code-fixer-server verify:consumer
```

Export refuses replay, failure, dirty/missing source provenance, incomplete
verification, and overwriting an existing file. Review a recording before using
it in public material. Consumer verification copies the app outside the monorepo,
resolves one published B4 release, installs registry packages without workspace
links, and runs check/build/typecheck/unit tests plus both Docker replay cases.
A published API mismatch is reported as incomplete consumer verification.

Current development evidence and remaining completion gates are recorded in
`docs/superpowers/plans/2026-09-13-code-fixer-blueprint.md` at the repository root.
