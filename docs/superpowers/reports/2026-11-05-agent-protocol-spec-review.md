# Coordinated Agent Protocol specification review

Date: 2026-11-05

Scope: documentation-only design consolidation. Behavioral approvals are
recorded in the conversation; written-spec approval by Brian is pending.

## Independent review

The brainstorming skill requires independent specification review before the
written user review. Three read-only reviewers received bounded task context
and artifact/source paths without inheriting the author conversation.

| Review | Rounds | Final result | Material corrections |
| --- | --- | --- | --- |
| Wire against pinned OpenAPI/CDDL | 2 | Approved | Exact authorized RunSearch operation lookup for initial/resume/fork/injection receipts; expired/deleted/no-match outcomes; arbitrary native token typing; receipt-before-consumed-pause retry order |
| Runtime/Store/policy consistency | 2 | Approved | Preserve lost-execution/tool-effect uncertainty while retiring future authority; only claim not-executed from durable evidence |
| Client/sync/release consistency | 3 | Approved | Gate new-kind activity in joined v1 scopes; do not filter-and-consume deferred changes; enforce v2 before new local scope joins; delay mirrored retirement writes until activation while applying local read-only behavior immediately; distinguish generic recovery |

Editorial follow-up identifies existing hub GET /readyz for active protocol
minimum verification and limits receipt-search disclosure to authorized public
correlation. No runtime code, store, secret, live peer or external resource was
changed by reviewers. Review approval establishes planning readiness, not
protocol conformance or implementation verification.

## Local checks

- Pinned OpenAPI operation inventory: 27.
- Python jsonschema validation reproduced five erroneous required response
  fields on an empty original RunStream request; removing only that required
  array allowed the request while Run response required fields remained enforced.
- A suspected Message text-block overlap was ruled out: its block branch uses
  anyOf and the unmodified text-array Message validates. No speculative Message
  correction is included.
- b4app Scripts/docs-index.sh --check passed: 169 decisions and 76 verification
  records are well formed.
- JSON examples parse; Markdown fences, local document links and trailing
  whitespace were checked. Final copy/hash and staged diff checks are recorded
  at commit preparation. These are document/schema checks, not runtime tests.
- Full node scripts/check-docs.mjs could not start in the clean B4 worktree:
  packages/core/node_modules/typescript/lib/typescript.js is absent. Dependencies
  were not installed for this documentation-only task. This gate is not claimed
  passed.

## Artifact boundaries

B4 worktree: .worktrees/agent-protocol-coordinated-design-20261105 on
docs/agent-protocol-coordinated-design-20261105, based on the approved Store
design commit 5b35ebbc7 and audited B4 source.

b4app worktree: .worktrees/b4app-agent-protocol-design-20261105 (under the B4
workspace, belonging to the b4app Git repository), branch
docs/agent-protocol-design-20261105, based on audited b4app e15c113.
The client document is byte-identical in both worktrees. No original working
branch was switched; unrelated dirty files remain untouched. No pushes, PRs,
tags, publication, deployments, project upgrades or data deletion occurred.

After Brian reviews/approves the written specs, the next deliverable is
implementation plans with explicit dependency/test/release checkpoints.
