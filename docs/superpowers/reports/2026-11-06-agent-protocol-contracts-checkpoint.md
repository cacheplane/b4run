# Agent Protocol contracts implementation checkpoint

Date: 2026-11-06. C1–C5 and their spec/quality reviews are complete. This records
an implementation checkpoint for downstream runtime work; full repository and
release qualification remain open. No runtime-storage conformance or deployment
is claimed.

## Reviewed implementation

The contracts topic starts from P0 `86b5e2151c5a4ece906f6025999f79748e7aad84`.
Its source checkpoint is `9c9dfc646401b88bd12489bf5d170e0f6bfbf12f`.
Each task received separate spec and independent quality review, including
re-review of fixes. The final cache/documentation repairs also received both
reviews with no remaining findings.

| Task | Final reviewed commit | Result |
| --- | --- | --- |
| C1 | `f749153e85dbe91e4616dcae06a47ea3cdd2f4e9` | Pinned inputs, guarded correction and differential fixtures |
| C2 | `e134abd5c6f8a83148b26aee8571b780b1ea392f` | Portable DTOs, generated schema/corpus and public package assets |
| C3 | `5564e63b32a94ff2e9984555a468354e6e7c680d` | Opt-in protocol message/input/output normalization |
| C4 | `1975ee2171a07bddb344fc6f7a72e5b0b1c0c164` | Authorized agent catalog and canonical/default identity checks |
| C5 | `4a9311d93b8a9f01f4743a76b570d204ac0e98ee` | Request validation, metadata/errors and trusted access context |
| Cache repair | `0062dd8b90fb16770eebd9b40a53b2887b9ea6fd` | Declare actual shared CLI test corpus input |
| SDK documentation | `803c8892ef53785f8efa42795348047f00b9a4d1` | Add required compatibility inventory row |
| Generated documentation metadata | `9c9dfc646401b88bd12489bf5d170e0f6bfbf12f` | Regenerate only the SDK reference record after content commit |

C5 also corrects our CDDL custom-channel translation to full-string matching.
The upstream bytes, normative pins and sole OpenAPI correction remain unchanged;
the source-backed explanation is in wire design §1. OpenAPI StreamingChannel
and REST RunStream stream_mode retain their separate pinned definitions.

## Downstream artifact identity

Agent Protocol commit: `455acf2eb2c55c634350f4c6a8da117d0ecfa7b1`
(OpenAPI 0.1.6 / CDDL 0.0.20). AG-UI commit:
`08eae9dc13546e91272efb2d0ef863e21acc6ee3`.
SHA256 values below were rechecked after the final build.

| Artifact | SHA256 |
| --- | --- |
| `test/agent-protocol/fixtures/upstream/openapi.json` | `7d069e43ca105e8127ce07ba7bd8bd7a78a2fadd6420009f2634a24cfb153f32` |
| `test/agent-protocol/fixtures/upstream/protocol.cddl` | `9cebafc02e523f509f880aa8ebaa2af077f8a7f0589d8063a50d610c3af78fb1` |
| `test/agent-protocol/fixtures/b4-wire-cases.json` | `5785283c1b4cb386d3535b452382962ce0b48d9d105c6e58b352b6e58d30c0e7` |
| `packages/sdk/dist/agent-protocol.schema.json` | `bcea770e7338cf3dbc3c47c5fa2078e802d3042d82e6173225ad6cbb6230c5fb` |
| `packages/sdk/dist/agent-protocol.fixtures.json` | `37fb22423bcfd5eeee951f99f5365f4374d8ae85cc25950f8f308a70c3647248` |

The last two are built package assets, not tracked dist files. They must be
built from the matching source before downstream consumption. They contain
263 definitions and 379 B4 corpus cases plus 11 upstream cases at the C5
checkpoint. DTO tests
and packing checks do not certify real backend transactions or native clients.

## Required repository validation

All 14 contributor gates ran sequentially against clean, frozen commit
`4a9311d93b8a9f01f4743a76b570d204ac0e98ee`; HEAD and worktree stayed unchanged.
Live-test flags, provider credentials and inherited DATABASE_URL were removed.
No gated infrastructure/live-provider qualification was inferred.

| Gate | Frozen-run outcome |
| --- | --- |
| `pnpm lint` | Passed |
| `pnpm check:build-cache` | Failed: missing shared CLI test corpus input; repaired and rerun passed |
| `pnpm build` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test` | Failed: 36 tests across 8 files; audit below |
| `pnpm check:release-inventory` | Passed |
| `pnpm test:release-controller` | Passed: 4184 tests, no failures/cancellations/skips |
| `node scripts/check-docs.mjs` | Passed |
| `pnpm pack:check` | Passed |
| `pnpm verify:typescript-tooling-pack` | Passed |
| `pnpm verify:harness:self-test` | Passed |
| `pnpm verify:harness:framework` | Failed: known Navlog resume symptom below |
| `pnpm verify:harness:runtime` | Passed |
| `pnpm verify:harness:smoke` | Passed |

The frozen source run reports 1049 files: 1010 passed, 8 failed, 31 skipped;
14000 tests: 13579 passed, 36 failed, 385 skipped. Existing controller baseline
failures did not recur; no code-fix claim follows from that nonreproduction.

After the repairs, the cache gate and its actual Turbo hashed input were
verified; SDK inventory/registry tests passed 285 with 1 skipped, targeted rows
passed 14, SEO tests passed 33, docs checks passed and root build passed all
29 tasks. The generated manifest changed only `/docs/api/sdk`, preserving 90
other records. Biome processes no MDX files; no MDX lint pass is claimed.

## Source failure audit and open qualification

Controls ran sequentially at clean `9c9dfc646`, with one Vitest worker and the
original timeout budgets and assertions. No implementation change was made to
address a timeout. Every failed full-run case was covered by the audit.

| Full-run failure family | Isolated result |
| --- | --- |
| 22 Vercel target cases | All 22 passed |
| 3 build-target cases | All 3 passed |
| 4 dev startup/restart cases | All passed; 2 additional startup/restart controls passed |
| Exact-registry compatibility guard | Passed, test elapsed 90.962 seconds against its 240-second budget |
| Process-tree termination dispatch case | Passed |
| 2 smoke fixture cases | Both passed; separate prior orphan control also passed |
| 2 bounded filesystem shell cases | Both still hit their 5-second budgets, matching P0 focused reproductions |
| SDK compatibility row | Deterministic omission repaired and regression passed |

The 33 other full-run failures did not reproduce in isolation. Their cause is
unproven, and this does not establish a passing full source suite or classify
new failures as pre-existing. High host load and concurrent work outside this
task were observed during controls; those processes were not modified. That
observation is relevant evidence, not proof of a shared cause.

The framework lane reports 120 passed, 1 failed and 1 pending. Its packaged npm
Navlog dev-server sequence matches P0: safe AG-UI request 200/41 events, gated
interrupt 200/5 events, then resume 409 with request_error/malformed_checkpoint.
It fails before browser and built-server journeys. A shared root cause remains
unproven. Keep the item with R6/R8/B5/B7/L4, and keep actual native/browser/release
qualification open until it passes.

The user authorized continuing protocol implementation while keeping baseline
failures open. Following the completed audit and reviewed deterministic fixes,
R1 can define the transaction interfaces and real-backend harness. R2/R3 must
supply actual SQLite/Postgres evidence; no mock, interface, skipped test or
historical CI result substitutes for it. Full source-suite timing qualification
and the framework failure remain open for subsequent component/release checks.

Detailed logs, exact commands and machine-readable results are retained in the
private execution evidence root `/private/tmp/b4-ap-implementation-20261105/`:
`contracts-exit/results.json`, `contracts-exit/controls/`,
`contracts-exit/docs-fix/evidence.json`, and `c5/cache-fix/proof.json`.
Original worktrees and their unrelated changes remain preserved. No push, PR,
publish or deployment was performed.
