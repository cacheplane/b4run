# Ordered uploads with deferred verification

## Scope and decision

Design for the next performance change after #783. Keep one publisher process,
one existing job, one npm publish command at a time, canonical dependency order,
and create-b4-app last. After npm accepts an upload, move to the next upload
instead of waiting for that version to become publicly readable. Once uploads
finish, verify pending packages in canonical order and run the existing final
fresh evidence sweep. No parallel worker pool, service, credential, durable queue,
new user step, or larger deadline.

0.10.0 accumulated 36m36.861s between upload acceptance and registry version
timestamps across 21 packages. npm documents publish-time scanning before
availability. Separate uploads allow npm's own scanning to overlap. These
measurements support the direction, not a predicted total release time.

Alternatives: a bounded rolling window needs scheduling and more state transitions;
parallel npm commands widen mutation races. Keeping upload-and-wait unchanged has
no opportunity to overlap scanning. Two ordered loops are the smallest design.

## Algorithm and invariants

Keep the existing candidate, canonical record, sealed manifest and tarball checks.
Keep the initial full inventory observations, supersession logic, and every fresh
version check and all-package latest sweep immediately before an upload. Retain
local tarball checks before and after npm publish, OIDC binding, and all command
and overall deadlines. Successful command exit is only acceptance, never evidence
of completed publication.

At an entry's existing ordered turn, retain current reconciliation for a version
already visible or a latest tag already pointing to the candidate: wait for exact
bytes, signature and provenance before skipping that entry. Do not substitute
acceptance logs for registry evidence. This may delay a resumed run, deliberately.

For a missing entry that passes the existing checks, await publishTarball and its
post-command tarball check. Record the name and acceptance time in a bounded
in-memory list (at most the manifest's 21 entries), log package-publish-accepted,
and proceed. If any command throws, times out, or is cancelled, stop immediately;
never upload a later entry in that invocation. No optimistic success handling for
npm conflict/duplicate errors.

After the upload loop, call the existing convergence verifier for each newly
accepted entry. Its pending-wait budget starts at that entry's acceptance time,
so queued time does not grant an additional ten minutes. An already complete
observation may succeed; a still-pending observation at/after the deadline fails
without another poll. Keep the overall 60-minute process and 65-minute job bounds,
ten-minute pending-convergence allowance, five-minute npm command limit, and
existing abort/cleanup behavior. Each awaited operation retains its current
transport/command/overall deadline protections. This is not a new strict TTL on
valid immutable evidence.

Keep the final full fresh sweep unchanged: exact identity, latest, registry
bytes/digests, signatures and provenance for all 21 packages. Only this produces
canonical NPM_COMPLETE evidence. Downstream smokes/audit/GitHub publication remain
gated on that evidence. A verification failure emits no success report, performs
no rollback and leaves accepted packages for the existing recovery path.

The first-publication bootstrap exception retains its existing upload-and-verify
behavior in this first change. It is rarely used and has distinct whole-package
absence/expiring authorization semantics. Use the existing firstPublication mode;
do not introduce a new user-facing switch or silently change credentials.

## Recovery and limits

A late failure can leave more accepted packages than today. This is intentional:
there is already no atomic 21-package npm transaction or rollback. Preserve all
fail-closed behavior when a mismatch or ambiguity is observed. Deferring verification
also defers detection of a new upload's invalid evidence; later uploads may already
have occurred before detection. No complete release may escape that failure.

Within a live invocation, never upload an accepted name twice. Across invocations,
visible exact versions are reverified and skipped. A candidate latest tag with an
absent exact version takes the existing convergence path, not another upload.

An accepted upload whose version and latest tag are both still invisible after
runner loss is observationally indistinguishable from an unperformed upload to
this publisher. The current code has no durable per-package acceptance receipt.
Do not claim exactly-once attempts or that a 404 proves no acceptance. A later
attempt may submit the same sealed name/version under the existing absence rules;
if npm rejects it as already accepted, the command failure stops that invocation
and produces no completion evidence. Never catch that rejection as success.

The [September 4 reliability architecture](2026-09-04-release-reliability-architecture.md)
explicitly rejects an exactly-once external API claim. The broader wording in the
[September 12 propagation design](2026-09-12-release-propagation-waits-design.md)
should be read as no repeated publication within one live convergence loop; it
does not establish cross-run hidden-acceptance proof. Existing runner-loss fixtures
make accepted versions immediately visible and cannot prove that stronger claim.

Before implementation is approved for merge, add an explicit regression for this
hidden-acceptance case and verify this matches the current retry contract. If the
controller or product requirement demands no repeated publish attempts even while
both observations are absent, this design cannot meet it without durable authority;
stop and revise the design rather than introducing a journal implicitly.

## Verification and acceptance

Use fake time and registry state tied to acceptance times, not poll counts. With
all 21 scans becoming ready after a fixed interval, verify ordered uploads occur
before the first convergence sleep, there is never more than one publish command
in flight, elapsed convergence follows overlapping readiness rather than 21 summed
waits, and final evidence is identical to the baseline.

Cover runner loss before/after acceptance at first, middle and last entries;
visible and hidden acceptance on resume; delayed latest/version/tarball/audit;
invalid integrity/provenance; newer latest appearing between writes; cancellation
and command/overall deadlines; earliest and late package pending-budget expiry;
final sweep regressions; all bootstrap regression tests unchanged. Stop-on-error
must explicitly assert no further uploads after the error is observed and no
NPM_COMPLETE report/output. A deferred verification error can follow all uploads;
the test must not retroactively prohibit those already accepted writes.

Update tests that intentionally assert verification before advancing only for
ordinary OIDC mode. Do not broadly loosen serial ordering or evidence assertions.
Refresh content pins and their digest for changed release modules only; avoid
workflow/policy changes. Run focused publisher/audit tests, integrity and workflow
contracts, full controller suite, scoped lint and hosted release-bearing gates.
Independent design/spec/code reviews precede merge. Submit only after #783 rollout,
then monitor main and measure the next ordinary release. No benchmark release.

## Review

Independent spec and plan review found no blockers. Clarifications about error
detection timing and the historical exactly-once wording are incorporated. No
production publisher behavior has changed in this design branch.
