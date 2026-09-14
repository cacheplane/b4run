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
comparison will test this final configuration; earlier recordings retain their
original commit and source snapshots.
