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
