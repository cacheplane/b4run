# Completing an npm-complete release with a reviewed verifier

The existing release controller can finish an npm-complete candidate using
reviewed verification code from main. A verifier repair therefore does not require
republishing packages or changing the release tag. The normal release workflow
selects this path automatically after observing durable npm completion.

The candidate version, commit, manifest, npm tarballs and provenance remain the
original release identity. Each smoke receipt still records that candidate; its
Actions run ID and attempt separately identify the code that executed the smoke.
The independently dispatched audit records and verifies its own executor in the
same way. Its main commit may be newer than the smoke executor.

Main execution requires the exact repository and workflow identity, the candidate
as an ancestor of the executor, the executor on main, matching source content pins,
and successful CI for that exact main commit. Pending CI is awaited within the
existing deadline. Durable smoke evidence is independently checked against its
exact workflow attempt during observation and audit, including after the original
Actions archives expire.

## Scope and normal operation

Main execution is limited to running or reconciling the five smoke lanes,
dispatching or completing the independent audit, and publishing the GitHub
release. Preparation, attestation, escrow and npm publication/reconciliation retain
the existing candidate/tag route. Existing workflow concurrency, credentials and
timeouts remain in effect. Abandonment remains disabled and the separate recovery
service remains dormant.

Merge the verifier repair through normal CI. The main release controller then
observes the incomplete candidate and continues from its durable state. If another
invocation is needed after a completed run, use the existing release workflow on
main with the exact version and candidate SHA. Avoid overlapping invocations.
An old run retains its original code; rerunning it does not load a later repair.

Completion requires five real passing smoke receipts and a successful independent
audit before immutable GitHub publication. Failed historical Actions evidence
remains in place. A manual marker edit or a smoke-exception record does not supply
the missing successful receipts.

## Initial use: 0.8.31

Candidate: `96552800bf4bbd85c156eab12bdf2e6ade90a0a7`.
Manifest SHA256: `1a362c6c2bd9dfd4aea97292d7556d4f0524d2a735842b7f346774b1bf2a01c9`.
GitHub draft ID: `387455114`.

All 21 packages reached npm completion at 2026-09-12 05:49:49 UTC, 1h 48m 33s
after the candidate merged. The metadata smoke exposed a verifier process-result
bug fixed in PR #632. The frozen candidate cannot execute that later repair, which
is why this post-publication handoff is needed. PR #633's proposed exception is
not required by this path.

At implementation review, the draft retained its 45 original assets and
`NPM_COMPLETE` revision 3 marker. The lifecycle regression exercises production
modules with simulated external services: five durable smoke receipts, a separate
main audit executor, advancing main, expired Actions smoke archives, rejection of
mismatched evidence before mutation, replay, and unchanged original asset bytes.
A read-only production observation on September 12 selected the exact 0.8.31
candidate with no diagnostics or adapter failures. Its plan was
`RELEASE_DRAFT_COMPLETE` → `run-release-smokes`, with no conflicts and no remote
mutations. Actual hosted smokes and publication remain the final live verification.

Report npm completion and complete-release elapsed time separately. The repair
and validation delay is part of the observed end-to-end duration; it must not be
excluded to claim a release speed improvement.
