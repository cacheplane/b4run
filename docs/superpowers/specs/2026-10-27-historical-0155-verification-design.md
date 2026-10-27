# Historical completion proof for B4 0.15.5

Status: proposed security-policy change; design review and owner approval required before implementation. This document does not authorize publication or supply a production approval record.

## Goal and scope

Allow ordinary arbitration to recognize the already published 0.15.5 release as historically complete when exactly one npm registry publish attestation is unavailable, using authenticated original verification evidence and fresh checks. Then resume the existing, unchanged 0.15.7 candidate through its normal publication gates.

This is an incident-specific historical-completion policy, not a generic provenance-only verifier. It does not repair or recreate npm's missing signed bundle. It does not declare 0.15.5 abandoned, modify its published assets/body/tag, move the 0.15.7 tag, publish another version, activate the dormant recovery controller, or change production application settings.

## Evidence and previous incidents

The original 0.15.5 publisher and independent audit succeeded at the exact tagged candidate. The authenticated original npm-evidence Actions artifact is still available. Its archive digest matches the service digest; its canonical receipt parses under the existing evidence parser, and all 21 entries match the actual sealed manifest's names, versions, sizes, SHA-256, SHA-512, SRI and provenance identities. The original candidate's verifier already required exactly one npm publish bundle and one provenance bundle. The receipt records that verifier's successful assertion; it is not the raw signed npm publish bundle.

Fresh npm 11.17.0 audit and direct registry reads now return only a provenance bundle for `create-b4-app@0.15.5`. The other 20 packages retain both bundle types. All 21 metadata integrity values still match the manifest; the affected package's freshly downloaded bytes also match size and both digests. Fresh verification of all 21 tarballs remains a required capture/admission check, not a claim already made by that limited byte probe.

The receipt digest also matches today's Release body marker. Release bodies and titles are editable even for immutable Releases, so that match is corroboration only. Authority must bind the original authenticated run/artifact and the independently reviewed record, not derive solely from today's marker.

Relevant history:

- [PR #493](https://github.com/cacheplane/b4run/pull/493) intentionally introduced the strict official npm verification contract.
- [#1097](https://github.com/cacheplane/b4run/pull/1097) repaired paginated historical reads without reducing trust checks.
- [#627](https://github.com/cacheplane/b4run/pull/627), [#635](https://github.com/cacheplane/b4run/pull/635), and [#783](https://github.com/cacheplane/b4run/pull/783) handle transient errors, propagation and cached metadata; none accepts missing final attestation proof.
- [#567](https://github.com/cacheplane/b4run/pull/567) provides a reviewed, candidate-bound smoke adjudication. It cannot waive npm evidence.
- [#1107](https://github.com/cacheplane/b4run/pull/1107) and [#1108](https://github.com/cacheplane/b4run/pull/1108) separate incident-specific code from a captured, reviewed record. Their prepublication abandonment conditions cannot apply to published 0.15.5.
- [#572](https://github.com/cacheplane/b4run/pull/572) preserves independent verification in a separate dormant recovery controller; activating it does not solve this missing-proof condition.

## Alternatives

1. Restore npm's registry-held publish attestation. This retains the existing policy, but requires registry cooperation or restoration outside this repository. Keep monitoring and prefer normal verification if the bundle returns.
2. Add the narrowly pinned historical-completion path described here. This explicitly changes historical trust policy, preserves current-candidate gates, and uses original authenticated completion evidence. Recommended for review because the original receipt and independent audit remain available.
3. Accept provenance-only output generally, skip old releases, create a false abandonment record, or issue another version. Reject these approaches: they remove unrelated protections or fail to resolve arbitration of the existing tagged candidate.

## Exact incident identity

Implementation must contain one code-owned incident tuple. The record must match every field; schema acceptance alone never adds another incident.

| Identity | Required value |
| --- | --- |
| Repository | `cacheplane/b4run`, numeric ID `1210070282` |
| Historical version/source | `0.15.5`, `877ce4899406cebabc150e80309cb5dbf2299bee` |
| Historical tag/object | `v0.15.5`, annotated object `124be1a3f847cd19aa049ffd678e9a5df1343a63` |
| Immutable Release ID | `424591222` |
| Manifest SHA-256 | `81b7df4408a73b1e236570cace34efbfdd9cea5848dc2f8145cd6d730c29429e` |
| Original publisher | run `40370125207`, attempt `1`, `.github/workflows/release.yml`, tag ref `refs/tags/v0.15.5` |
| Original npm evidence artifact | ID `12675176514`, name `npm-evidence-40370125207-1` |
| Artifact archive service digest | `sha256:0f51da9687083ee0dddfbac37139732253409f23832457d2a8ea8119f129a29d` |
| Canonical npm evidence SHA-256 | `1401b7303458f1a9f31f325711b3275a5b765e0baaee4ab7d6c285d646cc4d1e` |
| Original independent audit | run `40376822663`, attempt `1`, `.github/workflows/published-artifact-verify.yml`, same tagged source |
| Exceptional package/proof | `create-b4-app@0.15.5`; missing npm keyed publish attestation only |
| Current candidate to resume | `0.15.7`, `e67a92e4dc3b0f5ffc884ecee3fa8d87d5d788c4` |
| Current annotated tag/object | `v0.15.7`, `46c8f5322cc2fdba38d1c40c5c2b1415541e2527` |

Live capture must re-establish these identities rather than copy this table as observed evidence. Any mismatch stops capture/admission. The 0.15.7 fields identify the already tagged candidate this operation intends to resume; they do not authorize its publication or become a moving prerequisite for historical verification. After 0.15.7 completes, the same record can continue proving only 0.15.5's historical completion under the same fresh checks. It cannot admit another historical version, change the proof obligations, or grant any later candidate a release permission.

## Trust model and durable record

There are two distinct claims:

1. The original release completed verification under the original strict policy. Establish this through the authenticated publisher run/attempt/job history, original immutable Actions artifact bytes/service digest, canonical complete receipt, sealed manifest, and independent successful audit with exact immutable receipt assets.
2. The current registry bytes and remaining proofs still describe that release. Establish this freshly, allowing only the precisely identified absence of its registry-generated keyed publish bundle.

Neither claim alone is sufficient. A successful npm exit code alone is insufficient. The original receipt is a historical verifier assertion, not a replacement npm signature. Owner approval explicitly admits that historical assertion for this exact missing-proof case.

Use a new, separate `historical-publications` record family; never reuse abandonment or smoke adjudication schemas. The implementation PR contains the parser, pinned incident, read-only collector, verifier and tests, but no admitted production record. A later record-only PR supplies captured evidence.

The record uses exact-key bounded canonical JSON. It contains the full incident identity, schema/policy revision, capture operator and reviewed controller SHA, capture interval, original run/job/artifact metadata, original archive digest, exact embedded original canonical receipt, original audit receipt identities/digests, and two fresh registry observation summaries. It pins a digest of each retained supporting evidence file. Preserve the original archive and canonical receipt durably in the record-only PR's evidence directory before Actions expiry. Read bytes with no-follow/regular-file checks, bounded ZIP expansion and exact member/path/count validation; the npm evidence ZIP must contain exactly `npm-evidence.json`.

Authenticate the original repository IDs, run IDs, attempt, exact workflow path/ref and candidate SHA, completed success, producing `publish-npm` job, artifact name/ID/run association, archive bytes/service digest, and receipt-to-manifest relation. Verify the original independent audit's repository/path/ref/SHA/attempt/success and canonical/attempt receipt asset identity, size and digest. Conflicting original evidence blocks admission. Current Release body/marker digest disagreement also blocks, but agreement cannot substitute for these independent bindings.

Admitted records are selected only from the controller's exact trusted Git checkout, with a canonical byte digest, code-owned tuple and pinned policy revision. Do not load user-supplied record paths or enable the path by environment variable/dispatch input. The reviewed Git record becomes the explicitly granted historical authority. Retained exact archive/receipt bytes remain available if the original Actions artifact subsequently expires; missing retained bytes or broken digest bindings fail closed. Mutable run/job metadata still has to match freshly; disappearance or ambiguity is not silently treated as success.

## Fresh verification and exceptional shape

Prefer normal complete verification. If both npm bundle types are available and all ordinary checks pass, use the unchanged ordinary completion path.

The historical path requires an admitted record, exact immutable Release/tag/source/manifest identity, and all of the following on every use:

- Fresh all-21 package inventory, size, SHA-256, SHA-512 and SRI equality to the sealed manifest; exact public registry origin and redirect restrictions remain.
- Fresh complete official npm 11.17.0 signature/provenance verification for the unaffected 20 packages, including both bundle types and their existing source/subject identity checks.
- For `create-b4-app@0.15.5`, official npm audit must itself succeed with exactly one verified entry for the exact package, correct registry/location/version/descriptor, and exactly one cryptographically verified SLSA provenance bundle. Preserve the existing certificate, builder, workflow/tag/source and subject-digest checks. The same actual complete official output must feed the historical parser; never synthesize or filter output into an apparent normal pass.
- The affected package's registry signature and remaining provenance must be valid under official npm verification. A different missing proof, two provenance bundles, an invalid/foreign/extra bundle, conflicting subject/source, authentication/transport failure, malformed output, pending package, or nonzero audit exit blocks the historical path. The known one-provenance/no-publish shape is the only exception.
- Preserve the currently required GitHub manifest/tarball attestation verification, exact assets/digests and canonical Release metadata, real smoke receipts, original audit/dispatch correlation and all other terminal-publication checks. No missing non-npm evidence is converted into historical success.

The strict `parseNpmAuditSignatures` API stays unchanged. Add a separate incident-bound historical verification API, inaccessible to publisher convergence/current candidate verification. Share existing validation primitives rather than copy a weakened parser. Its result must identify the historical receipt, policy and admitted-record digest and explicitly say that fresh keyed publish proof is unavailable. Never label this result as a fresh ordinary `signature: valid` proof.

## Integration and state semantics

Implement the policy in a focused historical-publication module with read-only dependencies, separate exact-key record parsing, and a collector entrypoint. `observe.mjs` remains the owner of terminal evidence composition; `candidate.mjs` consumes only its validated result.

Refactor existing verification into shared validation units where necessary so the historical path reuses every non-exception terminal obligation. Do not accept a failed normal observer by removing selected diagnostic codes: digest mismatches and ambiguous Release status can be derivative of incomplete npm proof, and an allowlist could conceal an independent failure. Validate obligations positively and compose a distinct typed `historical-completion` proof.

Define that proof's exact-key schema before integrating it: incident identity, `kind: historical-completion`, policy revision, admitted record digest, authenticated original receipt digest, original publisher/audit identity, fresh 21-package byte verification, unaffected-package complete signature verification, affected-package official audit/provenance verification, explicit unavailable keyed publish proof, and positively verified non-npm terminal obligations. Keep the schema incompatible with ordinary npm evidence. Its historical signature assertion must name its source receipt; its fresh provenance assertion must name the actual verified remaining bundle. Neither is a fresh keyed publish assertion.

The non-npm obligation inventory must include candidate inventory and exact CI identity; annotated tag and source; immutable Release ID/state, exact assets and canonical metadata; manifest/record/payload/attestation identities; selected complete smoke receipts and their run/artifact bindings; independent audit dispatch, run/attempt, receipt and canonical marker correlation; and absence of contradictory recovery/adoption/abandonment state. Compare the marker's npm evidence digest to the authenticated original complete receipt, not to a fabricated complete result assembled from today's partial proofs. Validate audit composition against that explicit historical evidence source while retaining all other audit requirements. A missing or contradictory obligation blocks the proof.

Only terminal discovery/direct observation for the exact admitted 0.15.5 identity may consume that proof. It can derive `AUDIT_COMPLETE` with a no-op disposition and an explicitly reported historical policy/receipt binding; it cannot derive draft preparation, `NPM_COMPLETE` publisher permission, new publication, successful missing signatures, or authority for any other version. The current candidate remains subject to normal selection, unique exact CI, live authority, release preparation, both npm attestations for all 21 packages, smoke lanes and independent audit.

No production historical record means the existing missing-proof failure remains blocking. Code-only and design-only pushes must never manufacture a terminal result or auto-admit private staging evidence. No persistent cache of a previous green boolean is introduced. Existing within-observation immutable read reuse is allowed; each invocation still performs its required fresh checks.

## Capture, review and release sequence

1. Approve this design and the explicit new trust policy. Implement with failing regressions first, content-pin updates and independent code review. Merge only after the complete normal CI, native Vercel and CopilotKit gates pass.
2. Let all ordinary release owners settle. Keep an operator release edit freeze during capture, record review and immediate premerge recheck; no overlapping reconciliation or publisher rerun. Capture from an exact clean reviewed controller checkout reachable from live main using authenticated read-only boundaries.
3. The collector validates original evidence and captures two fresh exact all-package/attestation sweeps at least 60 seconds apart, bracketed by matching GitHub identity/state snapshots. Use a 15-minute total capture budget, existing per-request/cancellation/byte/history bounds, fresh requests and exclusive mode-0600 output. Abort on active/queued release owners, drift, incomplete proof, bounds exhaustion or any unexpected shape. No credentials enter records/logs.
4. Review a separate record/evidence-only PR. Preserve genuine captured bytes and their hashes; no fixture-derived records or hand-edited facts. Record capture age is historical metadata, not a freshness override. Immediately before merge, independently repeat the required live checks and verify all stable facts still match. If they drift, preserve the original record and recapture for review; do not edit evidence to conceal drift.
5. From merged trusted main, run read-only terminal observation and full global discovery. Require positively verified historical 0.15.5 completion and exact selection of existing 0.15.7 without conflicts. A local diagnostic or owner approval alone never authorizes a release effect.
6. With no active release owner, use one supported exact-version/source reconciliation only if the ordinary controller has not already advanced. Preserve annotated tags, candidate bytes, prior failed runs and records. Verify the complete immutable public 0.15.7 release, all 21 registry tarballs/integrities, attestation subjects, smoke receipts and correlated audit before the Hashbrown upgrade.
7. Continue the already authorized published-package Hashbrown update and hosted no-op/partial callback validation. No production backend rollout or Hashbrown package publication is included.

If record admission or any fresh validation fails, keep the release blocked and emit bounded credential-redacted diagnostics identifying the failed obligation. Do not retry publication as a substitute for proof. Reverting/removing an admitted record removes this historical acceptance path; it never undoes an already completed release or mutates its packages.

## Required validation

Tests must demonstrate that the feature cannot escape its incident boundary:

- Baseline normal verification continues rejecting provenance-only output, including 0.15.7 and all other packages/versions.
- Positive historical completion requires the exact code tuple, admitted canonical record, authenticated original archive/receipt/audit, fresh matching 21-package bytes, unaffected full proofs, and the affected exact remaining verified provenance.
- Reject each identity/digest/mode/path/member/size/schema/policy/manifest/package drift independently, including foreign repository/run, wrong attempt/workflow/tag, artifact replacement/expiry without retained bytes, incomplete job inventories, failed original publisher/audit, and editable marker-only authority.
- Reject malformed, duplicate, unknown, extra, invalid or incorrectly sourced attestation bundles, public-registry redirect drift, changed tarball bytes, wrong npm version, failed official exit, and transport/authentication/pending observations.
- Show all existing non-npm terminal obligations still gate historical completion by deleting/corrupting each asset/signature/smoke/audit binding. No diagnostic-code filtering may turn these red cases green.
- Show direct, scheduled and exact-dispatch arbitration report the same historical completion identity and choose only the existing qualified next candidate. Missing record, incompatible policy or evidence drift leaves all mutations absent.
- Capture tests cover both sweeps/bracketing reads, original artifact/job authentication, active coordinators, aliasing, timestamps, canonical bytes, exclusive writes, cancellation and total budget. Tests use dependency-injected synthetic evidence; no synthetic record is admitted to production.
- Run focused suites, full release-integrity/controller/workflow-contract suites, inventory, docs and lint. Update every changed release-reachable content pin and its reviewed snapshot. The actual final-head CI and live Vercel/CopilotKit gates remain mandatory.

## Completion and limits

Success means the existing 0.15.7 release finishes through normal current-candidate verification and the Hashbrown hosted tests can use its real published packages. It does not mean npm's missing historical signed bundle has been restored or freshly reverified. The record deliberately admits a bounded original verifier assertion about a prior completed release; that distinction must remain visible in reports.

General historical-completion caching, arbitrary incident admission, new dependency/toolchain upgrades, permanent exemption of old releases, raw-attestation archival for all future versions, and production rollout are separate work. No new dependency is required by this design.
