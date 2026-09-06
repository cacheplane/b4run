# Repairing the adopted 0.8.24 verifier

The production adoption at f18eb041e157ce42c281c9dad70b8a3c18290fa7 succeeded in run 34011200215. Metadata verification passed. Independent public-package reproductions found verifier defects in edge imports, harness setup and adapter assertions, and Docker cleanup diagnostics. Scaffold failed in production but succeeds locally; preserve diagnostic detail and reproduce on Linux before changing its behavior.

The accepted policy, adoption intent, release receipt, legacy archive and payload remain unchanged. Resetting adoption would destroy evidence; ordinary policy refresh is rejected by the existing chain. Recovery-specific duplicate probes would hide divergence and retain shared defects. Use one explicit, reviewed forward repair record instead.

## Exact forward authorization

A canonical record under scripts/release/recovery-verifier-repairs/v0.8.24.json is read from the immutable executor SHA, never supplied as CLI data. Bind it to the complete candidate, accepted policy digest, original f18 controller and closure, replacement closure, complete sorted old/new hashes for the unchanged closure input list, and original/replacement fence contract digests. It is outside the closure inputs to avoid a self-hash cycle; authorization comes from the exact merged-main commit and required CI. It does not create independent authority or waive any CI check.

Original exact-closure executors retain their existing admission path. Replacement executors must prove the baseline policy and closure, unchanged current policy bytes, forward ancestry, every original/current source hash, exact replacement closure, and exact reviewed contract transformation. Authority capture and historical executor observation use the same validation. Receipts retain their actual executor closure, so original adoption and new smoke/audit receipts can be verified together. The record is a narrowly scoped trust-model extension, not an implicit interpretation of the original policy.

The replacement fence contract preserves repository, candidate, topology, dispositions, workflow identities and bytes, historical source bindings, platform review references, probe closure, fixtures, mechanism and service evidence. Only enumerated current-default execution input hashes affected by reviewed source fixes may change. The shared service witness remains applicable only because its probe and mechanism are unchanged. Every actual write still requires a new live fence against exact replacement source bindings. No wildcard source approval, fallback acceptance, lowered checks or receipt replacement.

## Smoke repairs and diagnostics

Fix shared edge probe import to @dawn-ai/sdk; install explicit Vitest 4.1.10 for the published testing helpers; assert graphAdapter's object/kind/execute/stream contract; use systemd-run --quiet and validate exact actual Docker missing-volume diagnostics with status and resource name. Preserve cleanup and containment checks. Retain bounded, redacted command failure details separately from proof data; a failed lane remains failed. Avoid changing scaffold until Linux evidence identifies its failure.

## Verification and completion

Use regression tests that fail for the real defects and negative authorization tests for every identity/hash/ancestry/contract mismatch. Prove old admission and mixed old/new receipt chains still work and that accepted files stay byte-identical. Rehearse actual shared smoke operations on Linux using public 0.8.24 packages; diagnostic results do not constitute production authority. Run required PR CI and exact merged-main CI. Resume the production workflow normally, then verify immutable publication, zero-write replay, next-candidate arbitration, and restoration of the five routine workflows. Keep removed diagnostics disabled and leave personal lab deletion to the user.
