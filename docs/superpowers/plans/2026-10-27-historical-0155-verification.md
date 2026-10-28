# Historical 0.15.5 verification implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the owner-approved historical 0.15.5 proof policy, finish the unchanged 0.15.7 release, upgrade Hashbrown from published packages, and validate hosted no-op and partial callbacks.

**Architecture:** A separate code-pinned historical record and proof distinguish original verifier assertions from fresh registry signatures. The observer positively composes every current non-exception obligation; only exact published 0.15.5 can become terminal through this proof. Separate code and captured-record PRs precede normal 0.15.7 publication.

**Tech Stack:** Existing Node ESM, node:test, official npm 11.17.0 verifier, GitHub reader and artifact verifier, canonical Git evidence; existing Hashbrown Nx/Vitest/Vercel/Postgres tooling. No new dependency.

Approved spec: `docs/superpowers/specs/2026-10-27-historical-0155-verification-design.md` at `fb2d68a716c43363a99f48a34efb6b47aa5dff4d`. Existing isolated checkout: `/private/tmp/b4run-atc-compat`, implementation branch `blove/historical-0155-verification`. Never touch dirty `~/repos/b4run`. Baseline: 33 integrity and 219 npm-audit/candidate tests pass. Use exact file staging and spec-compliance then quality review after each code task. All production evidence remains outside the code PR.

## Task 1: Separate historical record and fresh provenance contract

Files: create `scripts/release/historical-publication-record.mjs`, `scripts/release/test/historical-publication-record.test.mjs`; modify `scripts/release/npm-audit.mjs` and `scripts/release/test/npm-audit.test.mjs`.

- [ ] Write top-level tests for a code-owned exact 0.15.5 tuple, canonical exact-key record, distinct proof kind, original complete receipt/archive/manifest bindings, retained-byte bounds, immutable snapshots and absent/malformed record behavior. Production tuple and every identity/digest come from the approved spec; no environment-controlled overrides. Keep actual record path `scripts/release/historical-publications/v0.15.5.json` absent.
- [ ] Add RED tests that ordinary `parseNpmAuditSignatures` still rejects provenance-only output; a separate historical API accepts only `create-b4-app@0.15.5`, exact verified entry/source/subject/certificate and one provenance/no publish bundle. Wrong identity, missing/invalid/extra/duplicate bundles, failed official audit and unknown fields must fail.
- [ ] Run `node --test scripts/release/test/historical-publication-record.test.mjs scripts/release/test/npm-audit.test.mjs` and retain expected failures.
- [ ] Implement `parseHistoricalPublicationRecord`, `canonicalHistoricalPublicationRecordBytes`, `readHistoricalPublicationRecord`, incident constants and the historical audit API. Share strict primitive validators; do not relax the ordinary parser, publisher verifier or signature status. The distinct result carries original-receipt/record/policy bindings and explicit unavailable fresh keyed publish proof.
- [ ] Read retained evidence only from the trusted controller Git ref; use existing Git tree/read patterns, regular-mode and canonical-byte limits. Validate original canonical npm receipt using `parseNpmEvidence` with actual sealed manifest, not hash-only context. Unknown/absent production record cannot admit private evidence.
- [ ] Re-run focused tests, scoped formatting/lint and self-review; commit only task files. Dispatch spec then quality reviewers and resolve all blockers before Task 2.

## Task 2: Positive terminal observation and arbitration integration

Files: create `scripts/release/historical-publication.mjs`, `scripts/release/test/historical-publication.test.mjs`; modify `observe.mjs`, `candidate.mjs`, `observation-schema.mjs`, `evidence.mjs`, `conflicts.mjs`, `state.mjs` only as required, their corresponding tests, and `cli.mjs` only for dependency/wiring changes.

- [ ] First map existing `observeProductionCandidate`, `mapProductionRegistryPackage`, `createObservedNpmEvidence`, `correlateReleaseEvidence` and terminal discovery callback. Extract shared validation units rather than copy an observer or filter failed diagnostics.
- [ ] Specify the exact proof schema and positive shared validator interfaces before multi-module edits; intermediate commits must remain fail-closed. Explicitly test retained artifact expiry separately from missing live run/job metadata: only authenticated retained artifact bytes permit the former fallback, never the latter.
- [ ] Write RED integration tests: no record leaves current missing-proof hold unchanged; exact admitted record plus every positive fresh obligation permits published 0.15.5 `AUDIT_COMPLETE`/noop; each non-npm evidence corruption independently blocks. Direct, scheduled and exact-dispatch discovery agree. Existing 0.15.7 provenance-only evidence remains rejected.
- [ ] Run focused observer/evidence/schema/state/candidate tests to observe failures.
- [ ] Authenticate original publisher/audit run/attempt/path/tag/SHA/repository/success and producing job; verify original artifact name/ID/run association and ZIP service digest, exact bounded members and canonical receipt/manifest relation. Retained Git bytes survive artifact expiry only under the admitted record; mutable run/job drift remains blocking.
- [ ] Implement positively verified historical package result and explicit `historical-completion` proof schema, incompatible with ordinary npm evidence. It records the historical signature assertion separately from fresh remaining-provenance verification. A historical result cannot set a fresh ordinary signature-valid claim or confer publisher permission.
- [ ] Add optional exact-key `historicalCompletion` observation evidence composed from pristine observer inputs before the ordinary npm digest mismatch can downgrade Release state. Share positive non-npm correlators from `evidence.mjs` and inventory/CI/tag/identity/arbitration checks from `conflicts.mjs`. Explicitly separate npm-dependent progression checks; never run failed ordinary correlation and remove named conflicts. `analyzeNpm`, ordinary `createObservedNpmEvidence`, and publisher convergence stay strict and receive no synthetic historical pass. Historical state analysis can return only positively proved `AUDIT_COMPLETE` or blocked; the existing planner then produces noop. No new mutation transition is introduced.
- [ ] Preserve live published-history latest semantics, including a valid newer latest without rollback; missing/ambiguous latest still fails. Do not emit historical receipt as `productionRecovery.npmEvidence` or ordinary `NPM_COMPLETE`; keep a separate report field and ordinary recovery evidence unavailable when fresh ordinary proof is incomplete.
- [ ] Reuse all ordinary non-exception validations: exact CI/tag/source, immutable Release and assets, manifest/record/payload/GitHub attestations, canonical metadata, selected real smoke receipts, independent audit/dispatch/run/attempt/canonical correlation, contradictory recovery/abandonment exclusion. Compare marker npm digest with authenticated original receipt, never fabricated current complete evidence.
- [ ] A typed historical branch may yield terminal noop only when exact published 0.15.5 and all positive obligations pass. It cannot yield draft states, `NPM_COMPLETE`, publish/resume/reconcile permission, other-version acceptance or extra mutations. Missing record/incompatible policy/any ambiguity leaves mutations absent. Prefer normal full verification if both bundles return. Existing publisher and current-candidate APIs remain strict.
- [ ] Add mutation regressions for each identity/proof/asset/smoke/audit boundary and wrong draft/version/candidate, snapshot tampering and forged proof fields. Verify production observer binding rather than trusting a caller-supplied boolean.
- [ ] Run all focused suites and baseline regressions; self-review, commit and complete spec then quality reviews before Task 3.

## Task 3: Read-only collector and incident runbook

Files: create `scripts/release/capture-v0.15.5-historical.mjs`, `scripts/release/test/capture-v0.15.5-historical.test.mjs`, `docs/superpowers/runbooks/2026-10-27-historical-0155-verification.md`; reuse existing bounded GitHub, ZIP, npm and process boundaries.

- [ ] Write RED tests for clean exact reviewed checkout/main ancestry/operator/repository identity, original artifact/job/audit authentication, 15-minute total capture, two fresh all-21 byte/attestation sweeps at least 60 seconds apart, matching bracketed GitHub snapshots, active/queued release owners, aliasing, credential redaction, cancellation, exclusive canonical mode-0600 output and member/path/expansion limits.
- [ ] Implement a read-only collector with injected clock/readers/filesystem. It emits original archive, exact canonical receipt and support digests plus the proposed record; it never mutates GitHub/npm or writes an admitted repository record. Every production fact comes from actual service reads; any drift or unknown shape aborts rather than editing a capture.
- [ ] Run collector tests to GREEN and independent spec/quality review. Document code-only merge, owner drainage, edit freeze, capture, separate record PR, immediate premerge recheck and ordinary recovery; code merge alone cannot grant terminal authority.
- [ ] Update changed reachable-script hashes and pin snapshot using existing inventory tooling. Extend reachability declarations if record data are newly read, with reader/data anchors. Do not hide changed scripts or blanket regenerate unrelated files.

## Task 4: Complete code PR validation and normal merge

- [ ] Run focused new suites; `pnpm test:release-integrity`; `node --test scripts/release/test/workflow-contracts.test.mjs`; full `pnpm test:release-controller`; repository lint/inventory/docs and appropriate build/typecheck/source/package/harness gates under repository guidance. Retain real failures and fix their causes; do not weaken tests or deadlines.
- [ ] Run final independent spec and code-quality review of the whole diff, including code-owned tuple, historical trust boundary, collector, content pins and no admitted production record.
- [ ] Commit exact scoped changes; verify clean head and no unrelated drift. Push/open/attach a code PR with concrete trust changes and validation. Respect at most two maintainer full-CI submissions; do not cancel release owners. Wait for all normal required checks plus real native Vercel/CopilotKit.
- [ ] Verify exact reviewed matching head and normally merge once. No admin bypass. Let automatic/scheduled release observers settle; confirm missing record still cannot advance the affected historical case. Preserve all old tag/source/artifact/history identities.

## Task 5: Capture and separately admit genuine historical evidence

- [ ] From exact clean merged implementation SHA, inspect every active/queued Release owner and wait for drainage. Begin operator edit freeze; never dispatch 0.15.7 during capture/review. Scheduled owners are subject to the same checks.
- [ ] Run the real read-only collector with private ephemeral credentials and concrete npm 11.17.0 binary. Inspect both fresh sweeps, bracketing snapshots, original proof bindings, every digest, candidate identity, canonical bytes and retained archive/receipt. Stop on any incomplete/drifting observation.
- [ ] Create a separate branch from merged main and copy exact captured record/supporting bytes to the code-owned paths. Parse/validate canonical record and run full relevant integrity/controller checks. Independently review data and source admission. Open/attach a record-only PR, preserving genuine bytes and capture interval/hash.
- [ ] Wait for all normal PR CI and real hosted gates. Immediately before exact-head normal merge independently repeat required live checks and stable-identity comparisons. On drift recapture/re-review without modifying old evidence to conceal it. Release edit freeze only ends after record merge and required postmerge observations.
- [ ] Observe historical 0.15.5 completion and complete fresh global discovery from merged trusted main. Require exact 0.15.7 selection with no conflicts. Neither a private diagnostic nor approval alone authorizes publication.

## Task 6: Finish and independently verify ordinary 0.15.7

- [ ] Inspect actual active owners and let the ordinary controller proceed. If settled and still necessary, dispatch one supported `release.yml` reconciliation for exact version `0.15.7` and source `e67a92e4dc3b0f5ffc884ecee3fa8d87d5d788c4`. Never move tags, mint a replacement, pick a CI ID, or rerun a publisher.
- [ ] Verify exact annotated tag/object, unique qualified candidate CI, immutable public Release, signed manifest/subject set and source/workflow/ref/hosted-runner identity, all 21 public npm tarball sizes/SHA-256/SHA-512/SRI, five successful real smoke receipts and correlated independent audit. Use `verify-registry.mjs` only with actual final manifest/candidate. Do not create positive receipt flags until facts are checked.
- [ ] Record historical completion as original verifier assertion with explicit unavailable old publish bundle; never claim that missing signature was restored. Preserve failed controller runs. New 0.15.7 must have full ordinary proof for every package.

## Task 7: Hashbrown published upgrade, previews and callback tests

Workspace: `/Users/blove/.codex/worktrees/a147/hashbrown`. Private harness: `/private/tmp/atc-callback-release-validation`. User authorizes opening/attaching upgrade/report PR, not merging it or #799; no production backend selection or Hashbrown publishing.

- [ ] Confirm expected clean Hashbrown branch/base before edits; preserve any intervening work. Rename owned branch for 0.15.7 if still safe. Upgrade only the four existing root CLI/core/SDK/Postgres exact pins and lockfile from verified registry packages; no source overlay/unpublished install.
- [ ] Run affected core/openai/typesafe/ATC shared/server/Angular/React/lifecycle build/test/lint via `npx nx`, lifecycle check, default OpenAI and B4 builds, owned disposable Postgres integration and isolated generated-artifact checks. Retain warnings/failures and fix only real compatibility causes.
- [ ] Commit exact Hashbrown source before building a fresh complete ATC prebuilt artifact. Deploy identical staged output to two distinct dedicated B4 previews sharing only dedicated preview Postgres/cookie configuration. Never change production settings. Pull credentials only when needed into mode-0600 preview.env, never print them.
- [ ] Authenticate READY preview IDs/origins/project/preview target and full function-tree/artifact hashes. Complete actual publication proof first; run `seal-previews.mjs` and independently inspect its manifest. This proves prebuilt upload provenance, not independent remote-byte attestation.
- [ ] Execute approved `noop.mts` against verified published 0.15.7 artifact: three genuine discovery/highlight threads, 18 settled same/different/conflicting callbacks, zero admissions on first DB query after EOF, canonical invariance and 75-second snapshots. Execute `partial.mts`: three explicitly synthetic three-park fixtures, five phases across replicas, C forever unanswered, no new user, exact pending sets, first-query zero admissions and 75-second snapshots. No real model parallel-call claim.
- [ ] Review sanitized evidence, exact-value credential/DSN/cookie absence, cleanup owned credentials/processes/containers, open/attach Hashbrown upgrade/report PR with actual limits and remaining rollout steps. Do not merge. Delete the temporary heartbeat only when all authorized work is complete; leave chat open.

## Execution rules

Only one implementation writer at a time; fresh focused subagents and spec-then-quality review per task. Parent owns integration, PR/release mutations and evidence admission. Keep worktrees clean at branch transitions, use body files for PR prose, preserve original dirty checkouts and shared resources, and keep current progress/heartbeat instructions synchronized to prevent duplicate actors.

Test commands run from B4 root; all Nx commands run from Hashbrown root with `npx nx`. Any incomplete trust obligation blocks progress; do not replace it with a successful exit code, elapsed time, copied fixture, filtered error list or owner approval alone.
