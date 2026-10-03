# Ordered uploads with deferred verification — rollout

## Why

The 0.10.0 publisher uploaded one package and waited for its public version,
tarball and audit evidence before uploading the next. Upload acceptance to npm's
recorded version timestamps totaled 36m36.861s across 21 packages. npm documents
publish-time scanning before availability. Serial waiting accumulates those delays.
The evidence is in [issue #668](https://github.com/cacheplane/b4run/issues/668) and
[the 0.10.0 analysis](2026-09-22-release-010-performance.md).

## Change boundary

Keep upload commands serial in canonical order. Newly accepted ordinary OIDC
uploads enter a manifest-bounded pending list. After uploads, verify those entries
in order, then run the unchanged final fresh evidence sweep. No downstream release
step can proceed without complete canonical evidence for every package.

Preserve checks before each upload, artifact integrity, OIDC, command/overall
limits and cleanup. The ten-minute pending-convergence allowance counts from
acceptance, including time queued behind other uploads; an already complete
observation is still acceptable. First-publication bootstrap keeps its existing
upload-and-wait behavior. No new settings, jobs, services or credentials.

Failures stop further work when observed. More uploads may precede detection of a
deferred verification failure. No rollback or completion claim is made on failure.
Visible exact accepted versions are reverified and skipped on retry. If a previous
upload was accepted but both version and latest remain invisible, this publisher
has no durable acceptance receipt: it cannot promise exactly-once external attempts.
A duplicate rejection remains an error. See the approved
[design](../specs/2026-09-22-ordered-upload-verification-design.md).

## Recovery-contract review

Independent review traced started-job history through observation, evidence,
NPM_PARTIAL classification and resume-npm-publish routing. A started job remains
partial even when registry versions are invisible. capturePublicationState rejects
already-started publication only during escrow, preventing resealing; it does not
prohibit resume against the existing payload. No preceding-package verification
requirement exists in pre-write authority. The existing runner-loss fixture makes
versions immediately visible, so new hidden-acceptance coverage is necessary.

## Validation and rollout

The deterministic publisher test models 21 packages, zero upload/network cost and
exactly 120 seconds of readiness delay per accepted package. It exercises both
version absence and audit-pending independently. The retained bootstrap
upload-and-wait schedule is the control: 2,520,000 ms (42 minutes). Ordinary
ordered uploads with deferred verification take 120,000 ms (2 minutes). All 21
writes precede the first convergence sleep, at most one publish command is active,
and canonical final evidence bytes match the control.

This is a controlled scheduling test, not replayed npm timing. Production includes
upload cost, variable scans, fresh sweeps, audits and other release phases. The
complete publisher/audit test files pass 217 tests. New regressions cover hidden
acceptance/duplicate rejection, runner loss, queued pending deadlines, valid late
evidence and absence of completion files after deferred/final verification failure.
Existing bootstrap and pre-write checks remain covered. Full controller, integrity,
review and hosted results are recorded in the pull request.
Simulated savings are not a production forecast. After required CI and independent
review, merge normally and observe main. Measure the next ordinary release from
candidate merge to public release, along with tag discovery, publishing, accepted
uploads, pending reasons and terminal evidence. Do not dispatch a release just to
benchmark this change. Existing #783 audit freshness is a separate optimization.
