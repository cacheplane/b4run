# Security prerequisites for B4.run 0.15.0

## Release decision

Do not publish the initial draft candidate in PR #1077. Its source base is main
`12b83e7572bf87947aae7a571de55f2cda97d29b`; the following dependency repairs must
land first, then the version/changelog output must be regenerated from main.
The latest main CI for that base completed successfully in run 39828686241.
Passing CI is not evidence that these newer advisories are remediated.

## Outstanding PR audit

- #976 proposes Next 16.4.1 across the four applications. #977 is an older,
  Inspector-only Next 16.3.8 update and does not reach the patched 16.x version.
- #1054 proposes Hono 4.13.11. The Node static adapter also needs its patched
  2.x minimum, and the lock must not retain older Hono under CopilotKit.
- #1049 proposes Vite 6.4.4. The existing workspace Vite override must move to
  the same patched floor; changing only vite-plugin's manifest leaves that
  policy behind.
- #1064 overlaps the already merged port-validation fix #1066 and polish #1075.
  It proposes fallback behavior instead of the shipped invalid-port diagnostic;
  do not merge it as an additional prerequisite.
- #1013 is the bot's 0.14.1 Version Packages PR, superseded by the requested
  owned minor cut. Close it after the real minor candidate merges.
- #1031, #1032, #1033, #770 and #651 change reviewed workflow/action pins and
  have failed checks. Keep them separate from active publication and reconcile
  their fixtures through normal review. CodeQL action halves must stay aligned.
- #646, #861, #862 and #863 are tooling/library major updates; #965 is a Sharp
  update. None is an established release prerequisite. Vitest runner/UI and
  release-tooling migrations need coordinated validation, not blind merges.

## Verified upstream evidence

GitHub advisory API reads on October 22, 2026 confirm:

- [GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr):
  critical Next.js `use cache` typed-array RCE, affected >=16.0.0 <=16.4.0,
  first patched 16.4.1.
- [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw):
  critical Next.js SVG image-optimization RCE; the affected 16.x range is
  >=16.0.0 <=16.4.0, first patched 16.4.1.
- [GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7):
  Hono static-path middleware bypass, affected >=4.12.4 <4.13.11.

These are affected-version findings, not proof that every application exposes
each vulnerable feature. Main pins Next 16.3.6 in four applications and the
published navlog scaffold pins 16.3.0, so repair both. Next/MDX move together to
16.4.1; the existing all-app pin test now also covers the published scaffold.

The CLI's minimum Hono version becomes 4.13.11 and its Node adapter minimum
2.1.3. The lock resolves Hono 4.13.13 and the direct adapter 2.1.5. Compatible
transitive Hono ranges reuse that same verified patched resolution; no public
owner override is introduced. The existing Hono patched-floor check was seen
failing on the remaining transitive 4.13.5 before deduplication and passing after.

## Failed dependency-PR checks

The sampled #976, #1054 and #1049 source jobs all independently report the
TypeScript 6 compatibility wrapper loading implementation 6.0.3 where Core and
the workflow parser require 6.0.2. Their controller jobs stop with `The
packages/core TypeScript compiler parser is unavailable`. #976 also leaves the
existing all-app Next pin test at 16.3.6, which fails in source and Inspector CI.

The repaired lock starts from main's current lock and retains the wrapper's
original 6.0.2 implementation. Frozen installation and the existing compiler
boundary checks must pass. Do not relax the compiler/version assertions to hide
a dependency update's unrelated drift. Dependabot's Vercel failures also need
the trusted maintainer-branch production-boundary check; do not expose protected
credentials to the dependency-bot context.

## Validation status

The Next and scaffold pin checks were observed failing before their manifest
updates and passing afterward. The dependency-floor suite passes 22 tests;
compiler/Next checks pass 7 tests. Full build and typecheck pass, the published
template suite passes 12 tests, release integrity passes 33, and scoped lint,
documentation and whitespace checks pass. Independent review found no blocking
dependency/lock-graph defect and confirmed zero unresolved snapshot references.

The complete standalone security suite initially reported 300 passing, 75 failing
and one skipped test. Review found inherited repository-identity contradictions,
28 brand paths identical to base, and a stale exact package-script assertion.
Two audit-CLI cases additionally require a clean committed lockfile and must be
rerun after commit. Do not classify those two as inherited failures based on a
dirty-tree run, or claim the complete security suite passed. The workspace is
configured to include these tests, so collection must be reconciled with hosted
source logs before claiming comprehensive CI health. Preserve historical
fixtures and evidence authority; no gate or production policy is weakened here.

Hosted merge gates and the clean-tree rerun remain to be recorded on the
prerequisite PR before merge. This note is neither a completed release nor a
clean audit of every dependency advisory.
