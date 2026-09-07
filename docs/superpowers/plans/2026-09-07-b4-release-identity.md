# B4.run release identity boundary

The approved clean-break rename changes current tooling and CI to `@b4run/*`,
`create-b4-app`, `b4`, `b4.config.ts`, `.b4`, `B4_*`, and repository
`cacheplane/b4-run` (1360603908). It does not publish or admit a recovery owner.

## Historical boundary

The immutable historical baseline is
`2a4ffd994db9ce97f21b4e6c41beee393fadd298` in the original Dawn repository
`cacheplane/dawnai` (1210070282). Preserve committed terminal records,
smoke adjudications, recovery adoptions, verifier repairs, fence contracts,
fence evidence, platform reviews, audit executor authorizations, recorded
incident fixtures and archives, and incident-specific destructive tooling.
Do not replace their identities or recompute their authorized digests.

Historical admission and audit assertions read their executable inputs from
that exact baseline. Current assertions prove old authorization fails against
B4.run identity and preserve the original record bytes. Incident operations
remain bound to their original repository; they are not B4.run release tools.

## Current policy and integrity

The B4.run recovery policy is DORMANT, has no admitted fence contracts and no
accepted verifier digest. Its executable closure remains exhaustively checked.
Any future B4.run admission requires fresh repository-specific evidence.

Update current content pins only for reviewed executable changes and update
the pin-file checksum in the workflow contract test. Update exact workflow
allowlist descriptors while retaining their reviewed classifications. Historical
workflow variants remain unchanged; the renamed disabled workflow is a distinct
current variant rather than a rewritten historical approval.

## Verification

First add failing tests for dormant recovery and old-record rejection. Run the
current release controller and tooling tests after renaming. Frozen historical
checks use Git objects, whereas current integrity checks read working-tree bytes.
The release inventory command reads a Git ref (HEAD by default), so rerun it
against the final committed rename; a precommit pass alone is insufficient.

## Implemented historical test boundary

The dated `duplicate-draft-*`, `abandon-v0.8.22-candidate`,
`terminal-recovery-adapters`, and `recovery-legacy-fence` test bodies remain
intact. Their imports and resource URLs resolve to an isolated Git archive at
the baseline above. The shared `frozen-history.mjs` helper extracts only that
immutable source and links the existing installed dependencies; it neither
publishes nor changes the checkout. The v0.8.24 admission tests use the same
frozen source, including their tamper rejection assertions. The v0.8.26 audit
record test hashes original Git objects. Generic controller, publisher,
observer, recovery, transport, policy-parser and workflow tests remain live.

`b4-identity.test.mjs` separately requires the current historical evidence,
incident modules (including terminal recovery), and `scripts/security/` to
remain byte-identical to the baseline. It proves that the current audit executor
rejects the old repository and old v0.8.26 authorization, and that the current
recovery policy has no admission. The original parse-only X.509 fixture stays
unchanged; new synthetic B4.run certificates live in a distinct test fixture.

The abandonment classifier preserves its old canonicalization domain and
both original variants. The distinct `renamed-b4-disabled-2026-09-07` variant
classifies only the reviewed current workflow, which still exposes no
abandonment job or operation. This is not a recovery admission.

## Historical security receipt uploader

The `dependency-security-receipt.yml` upload job is unconditionally disabled
with literal `if: false`. Its original receipt validators under
`scripts/security/` are Dawn-only historical tooling; accepting their receipts
in the B4.run repository would misrepresent the repository they describe.
The workflow contract requires the disabled condition and rejects activation,
condition removal, expressions, and string substitutions. Re-enabling the job
requires a separately reviewed B4.run receipt pipeline with fresh repository
identity validation and tests. Repository-wide Actions settings are not a
substitute for this job-level boundary.
