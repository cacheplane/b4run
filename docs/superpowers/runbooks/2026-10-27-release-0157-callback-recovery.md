# Replace the untouched 0.15.6 callback-release candidate

The callback cleanup fix from #1116 merged as `5d471fb6549d89ebc92f8e67c47df6e5c5a38e90`. Version Packages #1115 then created uniform 0.15.6 candidate `b9d722c6e4252c8b022265c05327474606099faa`.

Two distinct first-attempt main/push CI executions, `40537986582` and `40537987664`, both passed on that exact SHA. Both use workflow ID `260503755`, path `.github/workflows/ci.yml`, actor `blove`, and created-at `2026-10-27T16:08:38Z`. There is one active CI workflow definition. These observations establish duplicate executions, not their underlying delivery cause.

The existing release controller intentionally requires exactly one matching main/push CI identity. Owner `40537987680` therefore failed its detect gate with `REQUIRED_CI_FAILED` / ambiguous observation. Owner `40537986586` had completed detect with every tag/preparation/publication job skipped. No failed check or history was removed, and no CI identity was selected manually.

## Supported recovery

The existing [release design](../specs/2026-08-09-release-integrity-controller-design.md) permits an older candidate with no tag, draft Release, attested artifact, or npm package to become `SUPERSEDED_NOOP` when a newer fixed-group version exists. Discovery selects the newest version-change commit. A same-version refresh is not a new candidate, and ordinary dispatch exposes no CI-run-ID override.

[Read-only absence evidence](./2026-10-27-unpublished-0156-absence.json) was captured from `2026-10-27T17:13:27.870Z` to `2026-10-27T17:14:49.772Z`. Its exact SHA-256 is `778d7720b413caf1f2590199031f2211133d3db5bb45aba4a98dcb12fd9819c4`.

- Authenticated GitHub reads bracketed both npm sweeps and matched: no v0.15.6 tag or draft/published Release.
- Both candidate release runs were terminal; every mutation job was skipped or absent. Their only artifacts were production observations, with no prepared payload or release record.
- Two sweeps at least 60 seconds apart returned HTTP 404 for all 21 exact npm versions, 42 absence observations total.

This document and JSON are historical observation evidence, not a release authority, terminal record, or exception to any gate. The ordinary controller must independently re-observe state before public mutation.

## Replacement candidate

The 0.15.7 metadata was generated using the ordinary `pnpm run version` command and a CLI patch changeset. All 21 fixed-group package manifests advance uniformly, with normal example/changelog and chart synchronization. Runtime code, dependency declarations, workflows, release-controller policy, compiler pins, and historical 0.15.6 state are unchanged.

Require all normal PR gates before a single ordinary merge, followed by an unambiguous exact-main CI identity, native Vercel/CopilotKit qualification, and the existing controller. Do not enable a competing auto-merge path or overlap release owners. If duplicate exact-main identities recur, stop publication and investigate that trigger rather than generating more replacement versions or weakening identity checks.

Before treating the release as complete, verify its annotated tag/candidate, immutable public Release, signed manifest, all 21 npm tarballs, smoke receipts, and independent audit. Then update Hashbrown from published packages and repeat hosted no-op and partial-answer callback validation. Production backend selection remains a separate rollout decision.
