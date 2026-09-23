# Code-fixer live evaluations

## Baseline batch

- Batch: `batch-1305a1c3-7b72-43bb-85bb-6ca649852234`
- Agent commit: `15af7323cef9691ffba9da261fec2dd23d405577` (clean)
- Model: `gpt-5-mini`; three sequential attempts per fixture.
- All six attempts are retained under the ignored `artifacts/code-fixer/` root.
- No successful live recordings were exported from this batch.
- Authoritative billable usage is unavailable from the public harness. Durations
  include agent execution, independent verification, and cleanup.

| Attempt | Duration (s) | Visible checks | Independent checks | Runtime export gate | Full workflow |
|---|---:|---|---|---|---|
| cli-flags 1 | 145.657 | Fail | Fail | Not reached | Fail |
| cli-flags 2 | 93.328 | Pass | Pass | Not reached | Fail |
| cli-flags 3 | 87.580 | Pass | Pass | Not reached | Fail |
| nullable-inputs 1 | 106.510 | Fail | Fail | Not reached | Fail |
| nullable-inputs 2 | 163.355 | Pass | Fail | Not reached | Fail |
| nullable-inputs 3 | 105.782 | Pass | Fail | Reached | Fail |

Two CLI repairs independently passed, using different valid source changes.
No attempt completed the full workflow. The original scorer also undercounted
reproduction/verification because all attempts used `npm test --silent` while
it recognized only exact `npm test`; these original receipts are not rewritten.
The full-workflow result remains failed even after accounting for that scorer
limitation because each attempt failed another required criterion.

Observed workflow problems: agents sometimes asked for permission in prose
instead of calling the approval-gated tool, and diagnostics encountered additional
command permissions. Two nullable repairs passed visible checks but failed the
independent suites, so they are not acceptable demonstrations.

## Follow-up configuration

Recognize equivalent full-suite npm commands while rejecting compounds and
forwarded test filters. Document and narrowly allow existing fixture diagnostics.
Clarify that calling `exportForReview` raises the runtime approval request; the
runtime still pauses before export. Ask the agent to verify the task's public
preservation requirements. No reference repair or withheld check is exposed.
Preserve verifier error messages and include TASK.md in fixture identity.

A fresh six-attempt batch is required after committing this configuration. The
original six observations remain part of the evaluation record.

## Revised workflow: gpt-5-mini

- Batch: `batch-abe73ab7-ccdf-44ef-a034-6e36ed33a372`
- Agent commit: `f8e98f2496235c0c9a151a521b41ba1281af9022` (clean)
- Same default model, three sequential attempts per fixture.
- Full-workflow success: 0/6. No recordings exported.

| Attempt | Duration (s) | Visible checks | Independent checks | Runtime export gate | Full workflow |
|---|---:|---|---|---|---|
| cli-flags 1 | 166.992 | Unavailable | Unavailable | Not reached | Fail |
| cli-flags 2 | 61.321 | Fail | Fail | Not reached | Fail |
| cli-flags 3 | 143.870 | Fail | Fail | Not reached | Fail |
| nullable-inputs 1 | 105.965 | Pass | Fail | Reached | Fail |
| nullable-inputs 2 | 128.645 | Pass | Fail | Reached | Fail |
| nullable-inputs 3 | 88.664 | Pass | Fail | Reached | Fail |

The first CLI attempt exhausted the 60-step limit; the runner currently labels
that exception infrastructure-failed and has no completed harness trace for it.
The remaining CLI attempts stopped at additional permissions: reading installed
Commander source and running an ad-hoc Node diagnostic.

All three nullable attempts reproduced the failure, passed the visible suite,
re-ran verification, and reached the actual export approval gate. All three
failed independent correctness checks. This confirms workflow progress without
claiming reliable repairs. No original or withheld checks were changed.

## Same configuration: gpt-5 comparison

- Batch: `batch-e1681a34-6452-4358-b79f-21af477d1d39`
- Same clean `f8e98f2496235c0c9a151a521b41ba1281af9022` commit; only the model override changed to `gpt-5`.
- Full-workflow success: 3/6 (CLI 2/3, nullable 1/3). This small sample does not establish a reliability rate.

| Attempt | Duration (s) | Visible checks | Independent checks | Runtime export gate | Full workflow |
|---|---:|---|---|---|---|
| cli-flags 1 | 56.058 | Fail | Fail | Not reached | Fail |
| cli-flags 2 | 150.655 | Pass | Pass | Reached | Pass |
| cli-flags 3 | 124.483 | Pass | Pass | Reached | Pass |
| nullable-inputs 1 | 126.085 | Pass | Fail | Reached | Fail |
| nullable-inputs 2 | 91.827 | Pass | Fail | Reached | Fail |
| nullable-inputs 3 | 84.127 | Pass | Pass | Reached | Pass |

Verified live recordings were exported for CLI attempt 2 and nullable attempt 3.
They capture the runtime paused for approval, not a human-approved or published
patch. Full recordings remain under ignored `artifacts/code-fixer/recordings/`;
their embedded source snapshots and commit identify the evaluated configuration.
All 18 attempts across these three batches are retained, including every failure.

## Final diagnostic permissions

Public traces identified legitimate diagnostics stopping for extra approval.
The final configuration allows reading/listing the task's prepared dependency
directory and running Node diagnostics inside the existing isolated sandbox.
Dependency writes remain unapproved, source scope and independent verification
remain enforced, and export still requires runtime approval. Step exhaustion is
now reported as `step-limit`, not infrastructure failure. A fresh six-attempt
comparison below tested this final configuration; earlier recordings retain their
original commit and source snapshots.

## Final configuration results

- Batch: `batch-9377dec7-1792-40f7-a721-645d4caa9959`
- Agent commit: `cbe93c9b53ac6981436b20814b544aa4ce38f4b5` (clean)
- Model: `gpt-5`; three sequential attempts per fixture.
- Full-workflow success: **4/6**, comprising **CLI 3/3** and **nullable 1/3**.
- All 24 attempts across four batches are retained. No tests or reference repairs were altered to improve live outcomes.

| Attempt | Duration (s) | Visible checks | Independent checks | Runtime export gate | Full workflow |
|---|---:|---|---|---|---|
| cli-flags 1 | 113.145 | Pass | Pass | Reached | Pass |
| cli-flags 2 | 235.000 | Pass | Pass | Reached | Pass |
| cli-flags 3 | 274.860 | Pass | Pass | Reached | Pass |
| nullable-inputs 1 | 152.401 | Pass | Fail | Reached | Fail |
| nullable-inputs 2 | 195.919 | Pass | Fail | Reached | Fail |
| nullable-inputs 3 | 171.713 | Pass | Pass | Reached | Pass |

All six final attempts reproduced the failure, re-ran the visible suite, stayed
within source scope, and reached the actual runtime export gate. Two nullable
repairs failed independent correctness. The CLI fixture is the stronger initial
walkthrough; nullable remains a useful harder evaluation case. These samples
are too small for a reliability claim, and durations are not development-speed
measurements. Authoritative billable token usage remains unavailable.

The implementation checkpoint in the plan is superseded by this final live
ledger: required six-attempt execution and one qualifying recording per fixture
are complete. No human patch approval or remote patch publication is claimed.

Final recordings (local ignored evidence, source and verdict included):

| Recording | Attempt ID | SHA-256 |
|---|---|---|
| `cli-flags-final-gpt5.json` | `90532f93-a8b9-43ff-9d94-b664a37af813` | `1a1dd2187554737ef3401e4c63fcd5d4e746c3506b9dc01eb9dfaa3db57c95db` |
| `nullable-inputs-final-gpt5.json` | `535e134f-a05c-498c-811b-15b2dae6bd9c` | `db05121db10d5e0353ccfee174e24c5ea34c0aa07076c88c489b3bbe8aaf07f7` |

The known credential and local host path were checked absent from exported
recordings. Each recording remains pinned to its own clean source commit.

## Homepage re-recording: v0.10.0 example

The homepage walkthrough recording predated the example restructure (#670), so
its agent, configuration, and plan no longer matched the example. This batch
re-recorded the current example for the homepage.

- Batch: `batch-d1a45c11-c8f7-4652-b452-a61f52c6e8ae`
- Agent commit: `d6a2dc01ebf4f605fc089131557f735f2a6ccf4e` (clean). Its
  `examples/code-fixer` and `test/code-fixer` trees equal v0.10.0
  (`bfaf0c2b3030eebb572703c8f70f0e063593b1fa`) and main at the time.
- Model: `gpt-5`. Fixture: `cli-flags` only, through the same `runAttempt` as
  `pnpm code-fixer:live`. Sandbox image `b4-code-fixer:fixture-v1`
  (`sha256:0141987aed6b…`), reused locally without a base pull.
- Budget: at most six attempts, stopping at the first full-workflow pass.

| Attempt | Duration (s) | Visible checks | Independent checks | Runtime export gate | Full workflow |
|---|---:|---|---|---|---|
| cli-flags 1 | 374.150 | Pass | Pass | Reached | Pass |

The first attempt reproduced the failure with `npm test --silent`, added
`.allowUnknownOption(true)` to the `memory` command in `src/cli.ts`, re-ran the
visible suite, exercised the preservation requirements with Node diagnostics,
and paused at the `exportForReview` approval gate. No patch was approved or
exported. One attempt is not a reliability sample.

| Recording | Attempt ID | SHA-256 |
|---|---|---|
| `cli-flags-v0.10-gpt5.json` | `de4487ee-d4c9-443b-be34-70afcafcb203` | `cbfc5455b732051b53a93399c6e3f7c926271e543f8e17ace1d03303b2a99c13` |

`apps/web/scripts/export-homepage-evidence.mjs` is pinned to this recording and
requires each published source file and the fixture's `src/cli.ts` to equal
v0.10.0, so the walkthrough links to the same revision as the narrative. The
credential and local host paths were checked absent from the recording.
