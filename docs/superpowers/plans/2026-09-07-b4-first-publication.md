# B4.run First Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the first real B4.run fixed-group candidate with the existing integrity and provenance guarantees, then permanently use npm trusted publishing.

**Architecture:** Add an explicit, expiring, candidate-bound bootstrap authentication mode to the existing publisher. Registry authentication alone changes for the initial publication; the GitHub-hosted workflow identity, sealed artifacts, escrow, serial publication, registry verification, reconciliation and smoke gates remain mandatory. Provision the nonsecret authorization after the candidate is sealed, avoiding a commit-hash self-reference.

**Tech Stack:** Node.js ESM, npm 11.17.0, GitHub Actions, npm granular credentials and trusted publishing, existing Node test suite and release content pins.

---

## Status and scope

**Design only; unimplemented.** This document does not enable Actions, create a candidate, authorize a registry mutation, configure trust, provision credentials or change executable gates. The rename includes distribution; implementing the necessary narrow bootstrap is within that work. Owner credential provisioning is a separate operational step, not an implied requirement to ask again before preparing the implementation.

The permanent flow remains tokenless. Do not use the rejected root `.env` credential, read a developer's `.npmrc`, transfer a saved interactive login into CI, introduce automatic token fallback, publish placeholder packages or bypass the controller with `npm publish` in another workflow.

The boundary in [B4.run release identity](./2026-09-07-b4-release-identity.md) remains binding: recovery stays DORMANT, historical records remain unchanged, and the historical security receipt uploader stays disabled.

## Why a bootstrap is necessary

npm requires a package to exist before `npm trust` can configure its publisher. All 21 target names were absent during the initial inventory. npm separately supports a first public publication using a registry credential plus `--provenance --access public` in GitHub-hosted Actions with `id-token: write`. Thus registry authentication can temporarily differ while the required provenance identity remains identical. See [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/) and [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).

The current `scripts/release/npm-audit.mjs` creates empty isolated npm configurations, removes ambient registry credentials and checks the exact GitHub provenance environment. Saved local login neither reaches that publisher nor establishes the required workflow identity. A login session also retains interactive publishing 2FA; use it for the later owner-operated trust configuration, not as unattended publisher authentication. See [npm session authentication](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/).

There is also a concrete registry-observation prerequisite: `scripts/release/adapters/npm.mjs` currently classifies whole-package metadata 404 as ambiguous, and its exact-version absence check requires an existing packument. `scripts/release/publisher.mjs` requires a present metadata observation. Credential plumbing alone therefore cannot publish the absent names. Add a narrowly selected first-publication observation path; do not globally reinterpret arbitrary 404 responses as safe absence.

## Exact authority and package set

Require repository `cacheplane/b4-run`, numeric repository ID `1360603908`, publisher workflow `.github/workflows/release.yml`, `workflow_dispatch`, GitHub-hosted runner, and `refs/tags/v<version>` resolving to the exact selected candidate SHA. Keep the existing environment contract with no GitHub environment configured; adding one would require a separate reviewed change to that contract and later npm trust configuration.

Require exactly these 21 names, compared as a set with no duplicates, in the sealed manifest; a scope wildcard is insufficient:

```text
@b4run/ag-ui
@b4run/cli
@b4run/config-biome
@b4run/config-typescript
@b4run/core
@b4run/devkit
@b4run/evals
@b4run/inspector
@b4run/langchain
@b4run/langgraph
@b4run/memory
@b4run/memory-pgvector
@b4run/permissions
@b4run/postgres-storage
@b4run/sandbox
@b4run/sdk
@b4run/sqlite-storage
@b4run/testing
@b4run/vite-plugin
@b4run/workspace
create-b4-app
```

Do not use the rename commit itself as the release candidate. Existing discovery requires a uniform version increase with the same package set as the candidate's first parent. Land and validate the implementation first; the subsequent version candidate must satisfy normal discovery and CI requirements.

## Activation contract

Use two explicit controls in addition to the existing candidate selection:

1. A boolean `workflow_dispatch` input `npmBootstrap`, default `false`. Scheduled and push executions cannot activate it. Preserve operation `reconcile`; do not create an alternate release state machine.
2. Repository variable `B4_NPM_BOOTSTRAP_AUTHORIZATION`, containing a bounded canonical JSON document with this exact schema:

```typescript
type BootstrapAuthorization = {
  schemaVersion: 1
  status: "enabled"
  repository: "cacheplane/b4-run"
  repositoryId: "1360603908"
  publisherWorkflow: ".github/workflows/release.yml"
  version: string                 // exact selected release version
  commitSha: string               // exact 40-character lowercase SHA
  manifestSha256: string          // SHA256 of canonical sealed manifest
  releaseRecordSha256: string     // SHA256 of canonical release record
  notBefore: string              // canonical UTC timestamp
  expiresAt: string              // canonical UTC timestamp
}
```

Reject unknown keys, malformed timestamps, invalid hashes, noncanonical JSON, oversized input, absent/retired configuration and a validity interval longer than 24 hours. Require `notBefore <= now < expiresAt` before the first npm mutation and again immediately before every subsequent publish spawn. Use existing canonical manifest and release-record hash functions. Match all identity/digest fields to verified artifacts and the actual GitHub environment, including repository ID. The fixed 21-name set is code-owned, not configurable by the variable.

The repository variable is owner-managed operational authority, not signed historical release evidence. Set it only after escrow establishes the exact manifest and release-record bytes. This avoids embedding a commit's own hash or a not-yet-created artifact digest in that commit. A replacement authorization may extend the operational window for the same candidate; it must never silently advance to a newer candidate. Changing candidate identity requires a distinct deliberate owner action and fresh normal release validation.

Add an explicit publisher CLI argument `--npm-auth-mode oidc|bootstrap` with default `oidc`. Only bootstrap mode reads `B4_NPM_BOOTSTRAP_AUTHORIZATION` and `B4_NPM_BOOTSTRAP_TOKEN`. Missing or invalid bootstrap authority fails closed before mutation. OIDC mode ignores these values and continues stripping all npm credentials; it never retries with a token after OIDC failure.

In `release.yml`, set the mode from the literal boolean input and inject the dedicated secret only when that input is true. Keep the existing single publisher step and its exact tag, SHA, transition and upstream-success predicates. Pass expression values through step environment variables, not interpolated shell source. A manual bootstrap flag cannot bypass detect, CI, tagging, hydration or escrow.

Thread the optional boolean through the sealed manual event and the strict parser in `scripts/release/observe.mjs` so read-only observation can select the first-publication reader before artifacts exist. This pre-escrow read mode requires the exact repository and selected 21-name candidate but receives no credential and confers no publishing authority. Do not require the artifact-bound authorization during preparation: its digests cannot exist until escrow. Require it at the publisher boundary, after normal escrow verification. Keep existing default event shapes valid and reject nonboolean input/extra keys; merely adding a workflow input without updating the event seal would silently discard it today.

Implement a dedicated `observeFirstPublicationPackage` adapter operation that returns bounded package existence, the validated complete version-name set and exact candidate-version evidence. An absence result must come from unauthenticated GETs to the exact trusted public registry package and version endpoints with recognized registry not-found responses; redirects to an untrusted origin, generic proxy/HTML 404s, authentication failures, malformed JSON, conflicting endpoint results and network failures remain ambiguous. Validate npm's actual public not-found JSON representation in fixtures; do not require an invented `E404` body field merely because the npm CLI reports that code. Recheck before mutation to handle namespace races. Keep `observePackageMetadata` and `observePackageVersion` default behavior and historical ambiguous-404 assertions intact. Adapt only the explicitly selected bootstrap reader to the publisher's internal absence/latest representation, never represent absence as a fabricated HTTP 200 response.

## Credential isolation and output handling

Use a newly provisioned repository secret named `B4_NPM_BOOTSTRAP_TOKEN`, distinct from GitHub release credentials and any existing `NPM_TOKEN`. npm credentials must have publishing write access and bypass 2FA for unattended use, with the shortest practical lifetime. Choose a one-day expiration where available and revoke immediately after success. See [npm CI authentication](https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow/) and [granular token permissions](https://docs.npmjs.com/creating-and-viewing-access-tokens/).

Verify creation rights for both the `@b4run` scope and the absent unscoped `create-b4-app`. Do not claim the scope covers the scaffold or assume npm can select a not-yet-existing individual package. Confirm the current registry control supports the required unscoped creation grant. If it requires all-package write access, prefer a dedicated publishing identity with only the necessary existing access; document the resulting actual credential scope before provisioning. Do not broaden an unrelated account's token silently.

After candidate/artifact/provenance-environment validation, write only this registry-specific auth entry into the publisher's existing private temporary `.npmrc`:

```ini
//registry.npmjs.org/:_authToken=${B4_NPM_BOOTSTRAP_TOKEN}
```

The file contains a literal environment reference, never the credential. Preserve private directory/file modes, explicit registry, empty global config, separate audit home/cache and existing cleanup. Reject empty, excessive-length or control-character-bearing token values before configuration; never include rejected values in errors. Forward the token only to `npm publish`, not `npm --version`, npm audit, dependency installation, artifact preparation, smoke processes or other child commands. Never put it in argv, package metadata, reports, GitHub outputs, uploaded artifacts or URLs.

GitHub's secret masking is supplemental. Add publisher-boundary redaction of the known credential in captured stdout/stderr and thrown errors, including nested process failure fields and any JSON diagnostic rendering. Do not print npm config, environment dumps or full authorization input on failure. Test literal and common encoded representations; prefer fixed error classifications where untrusted npm diagnostics cannot be safely retained. Never upload npm logs, the isolated home or cache. Cleanup must run on success, rejection, cancellation and deadline failure. JavaScript strings cannot be guaranteed erased from process memory; terminate the ephemeral job normally and rely on credential revocation for retirement.

## Publication and partial-resume semantics

Publish the real fixed-group release with the existing command and order:

```text
npm publish <verified-tarball> --tag latest --access public --provenance --ignore-scripts
```

Preserve local tarball validation immediately before and after publishing, registry tarball digest verification, npm signature auditing, exact repository/workflow/ref/commit provenance verification, bounded registry convergence and existing deadlines. The credential changes no evidence schema and grants no terminal/recovery authority.

Before any bootstrap mutation, obtain fresh observations of all 21 names. For this first-publication mode, each name must either be absent or contain only the exact candidate version, with the already-existing candidate bytes and provenance verified. Reject unrelated preexisting versions, conflicting package identities, ambiguous registry reads or missing/invalid provenance. This is an additional bootstrap restriction; leave generic OIDC release behavior intact. A verified same-candidate publication is a resumable result, not a reason to publish it again.

After a partial failure, preserve the selected candidate, sealed manifest, tarballs, tag and escrow. Re-dispatch the same candidate with explicit bootstrap mode while its authorization is valid. Re-observe and verify already-published entries, skip their mutation, and publish only missing entries. Preserve the existing newer-latest conflict behavior. Never overwrite a version, unpublish, repack, change the candidate version to work around a collision or accept token-authenticated publication without the required provenance.

If authorization or credential expires after some packages succeed, stop further mutations. Provision a replacement credential/window for exactly the same candidate and resume; no automatic extension. A timeout after npm accepts a package is handled by fresh registry observation and verification, not blind retry. If all entries are already verified, complete normal reconciliation without requiring another token mutation. Credential retirement follows all-21 verified npm convergence; the normal release smoke/finalization gates still apply afterward.

## File map and implementation tasks

### Task 1: Strict bootstrap policy and first-publication eligibility

**Create:** `scripts/release/npm-bootstrap.mjs`, `scripts/release/test/npm-bootstrap.test.mjs`.

**Modify:** `scripts/release/publisher.mjs`, `scripts/release/adapters/npm.mjs`, `scripts/release/observe.mjs`, `scripts/release/test/publisher.test.mjs`, `scripts/release/test/npm-adapter.test.mjs`, `scripts/release/test/observe-production.test.mjs`.

- [ ] Write failing tests for exact schema, bounds, timestamps, repository ID/name, workflow, version/SHA, both artifact digests and all 21 names. Include missing/duplicate/unexpected names and old repository identity.
- [ ] Write failing tests that bootstrap requires explicit activation, leaves OIDC behavior unchanged, and cannot use unrelated package versions for initial publication or resume.
- [ ] Add real HTTP fixture cases for whole-package absence, malformed/not-authoritative 404s, conflicting endpoint observations and unrelated packument versions. Prove the existing default adapters retain their fail-closed behavior and only explicit bootstrap observation reaches a valid absent-name state.
- [ ] Extend the strict manual event parser and live observer wiring for the optional bootstrap boolean. Test the pre-escrow observation without secrets or artifact authorization and prove it does not authorize the publisher. Update `scripts/release/cli.mjs` and its current tests only if dependency wiring requires it.
- [ ] Implement the small policy module with a strict parser, identity validator and per-mutation expiry check; use existing hash functions and registry readers rather than inventing another evidence format.
- [ ] Add the optional CLI mode and integrate policy validation after artifact verification but before any credential-bearing npm process. Include the new module in `PUBLISHER_SPARSE_FILES`.
- [ ] Run `node --test scripts/release/test/npm-bootstrap.test.mjs scripts/release/test/npm-adapter.test.mjs scripts/release/test/observe-production.test.mjs scripts/release/test/publisher.test.mjs`; first establish expected failures, then require green. No real registry writes in these tests.

### Task 2: Isolated credential transport and redaction

**Modify:** `scripts/release/npm-audit.mjs`, `scripts/release/publisher.mjs`, `scripts/release/test/npm-audit.test.mjs`, `scripts/release/test/publisher.test.mjs`.

- [ ] Write failing tests for empty OIDC configs despite ambient credentials, explicit bootstrap config, token confinement to publish, preserved OIDC variables, control-character rejection and cleanup.
- [ ] Use fake npm subprocess output to prove no credential appears in returned errors, logs, reports, output files, command arguments or audit environments, including failure and cancellation paths.
- [ ] Implement bootstrap configuration as an explicit verifier-factory option passed only after policy validation. Keep default verifier construction unchanged for observers and reconciliation.
- [ ] Run `node --test scripts/release/test/npm-bootstrap.test.mjs scripts/release/test/npm-audit.test.mjs scripts/release/test/publisher.test.mjs` and require green.

### Task 3: Workflow wiring and mutation-resistant contracts

**Modify:** `.github/workflows/release.yml`, `scripts/release/test/workflow-contracts.test.mjs`; update `scripts/release/test/fixtures/workflow-entrypoints.json` only for a changed reviewed descriptor.

- [ ] Write failing workflow tests for default-off boolean input, explicit mode, bootstrap-only secret injection and no credential in other steps/jobs. Mutation tests remove/change each activation binding and must fail.
- [ ] Wire the existing publisher step to the input, repository authorization variable and dedicated secret without adding another npm mutation site, environment or workflow. Preserve the boolean in the existing manual-event seal for read-only detection; do not pass the token or authorization document to the observer.
- [ ] Retain exact tag/SHA, repository, GitHub-hosted runner, `id-token: write`, sparse checkout, upstream gates, immutable artifact-ID downloads, serialized concurrency and deadlines.
- [ ] Run the workflow and publisher tests; prove non-dispatch executions and default/manual OIDC execution cannot activate bootstrap. A secret present in the repository must not itself activate the mode.

### Task 4: Resume and expiry evidence

**Modify:** `scripts/release/test/publisher.test.mjs`, `scripts/release/test/rehearsal.test.mjs`, and `scripts/release/test/support/release-rehearsal.mjs` for the existing integration fixture boundary.

- [ ] Test all-absent initial publication, a valid partial prefix, missing entries after an accepted-but-timed-out publish, and all-verified replay with no npm writes.
- [ ] Test corrupt existing bytes, unrelated versions, invalid/missing provenance, registry ambiguity and newer latest; each must fail without publishing further packages.
- [ ] Test expiry between packages, expired activation, invalid replacement binding, and replacement credentials for the same candidate. Preserve bounded convergence without duplicate publication.
- [ ] Use the existing fake registry/process fixtures and normal controller transitions to exercise the complete path. Do not test by reserving or publishing real names.

### Task 5: Pins and complete validation

**Modify:** `scripts/release/test/fixtures/release-script-hashes.json`, `scripts/release/test/workflow-contracts.test.mjs`, `scripts/release/test/fixtures/release-workflow-b4-disabled.yml`, and the corresponding current-only digest in `scripts/release/abandonment-workflow-policy.json` if canonical execution changes. `scripts/release/abandonment-workflow-policy.mjs` needs editing only if a new variant is introduced instead of updating the current B4 descriptor.

- [ ] Add the new reachable runtime module to the content-pin inventory and recompute SHA256 for every changed reachable runtime file. Preserve historical pins and fixtures that are outside the current execution closure.
- [ ] Recompute the pin-file SHA256 and update `STARTING_SCRIPT_PIN_SHA256`; use the existing workflow-contract failure output's recompute command. Do not perform blanket pin replacement to suppress failures.
- [ ] Refresh the exact current B4 disabled-abandonment workflow fixture/descriptor as justified by the reviewed workflow change. Preserve historical original workflow variants byte-for-byte; this update grants no abandonment or recovery permission.
- [ ] Run scoped Biome checks, `pnpm test:release-integrity`, `pnpm test:release-controller` and `pnpm check:release-inventory` against the committed implementation. The full controller command already discovers the new `*.test.mjs`; no root script expansion is required.
- [ ] Coordinate the final `pnpm ci:validate` with the main workstream so shared builds do not race. Exact HEAD-dependent inventory must run after the implementation is committed. Keep content-pin checks against the final working-tree bytes as well.

## Operational sequence and retirement

- [ ] Land and validate the implementation; create the ordinary uniform version candidate afterward. Record its exact repo, tag and SHA.
- [ ] Prepare, attest and escrow through normal controller transitions. Read the verified canonical manifest/release-record digests; set the bounded authorization variable for this candidate. Do not edit sealed artifacts to add credentials or bootstrap metadata.
- [ ] The owner provisions the fresh npm credential with confirmed scope/creation rights and saves it in the dedicated repository secret through a secret-safe interface. Separately provision the already-requested repo-scoped GitHub release credentials; those do not substitute for npm authentication.
- [ ] Explicitly dispatch the exact tag/candidate with `npmBootstrap: true`. Record only nonsecret activation identity, validity window and auth-mode events alongside normal run links; existing npm evidence remains authoritative for package verification.
- [ ] Resume only the same candidate as described above until all 21 packages pass normal npm verification.
- [ ] Configure npm trust for each exact package with `npm trust github <package> --repo cacheplane/b4-run --file release.yml --allow-publish`, using supported owner authentication and interactive 2FA. Do not pass `--env` while the publisher has no environment. Verify each configuration with `npm trust list <package>` and preserve nonsecret receipts. No stage-publish permission is needed. The bootstrap bypass-2FA credential is not supported for trust-management commands. See [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
- [ ] Revoke the bootstrap credential at npm, delete the GitHub secret and remove the enabled authorization variable. Verify absence/revocation without printing credential contents. This disables old-tag replay even before source retirement lands.
- [ ] Remove the bootstrap input, auth path and policy module in a follow-up change after publication/trust configuration; update current pins/contracts again. Retain regression tests proving ambient credentials never affect permanent OIDC mode, plus nonsecret operational history.
- [ ] Finish normal smoke/finalization gates for the first release. Verify actual trusted-publisher authentication on the next legitimate version publication; rerunning an already-present version only verifies evidence and does not prove OIDC publishing works. Do not publish a throwaway version solely to test authentication.

## Choices and recommendations to resolve during implementation

| Choice | Recommendation and boundary |
| --- | --- |
| Authorizing a SHA not yet known when code lands | Use the strict owner-managed repository variable after escrow, paired with the default-off explicit dispatch input. Pre-escrow observation uses the explicit input but receives no credential or mutation authority. Do not add a signed-record subsystem or put a self-referential SHA into the candidate commit. |
| Whole-package absence | Add a dedicated bootstrap adapter/observer path; validate trusted registry not-found semantics and retain all default ambiguous-404 tests. Credential injection alone is not sufficient. |
| Bootstrap window | At most 24 hours, checked before every mutation; replacement authorization must retain candidate and artifact identity. Operational expiration does not authorize a different candidate. |
| Unscoped scaffold creation | Confirm npm's actual granular permission controls before provisioning. Use a dedicated identity if all-package access is necessary; never assume `@b4run` scope permission suffices. This is the remaining credential-provisioning detail, not a reason to defer implementation. |
| Secret protection environment | Preserve the existing no-environment publisher contract. Do not add an environment only for bootstrap; secret exposure stays limited to the explicit publisher step and the shortest practical lifetime. |
| Trust rollout after partial publication | Finish and verify the whole fixed group before trust configuration and revocation. This keeps bootstrap resume deterministic. If a credential must be revoked early, pause mutation and replace it for the same candidate rather than relaxing provenance or using local publish. |
| Auditing the exception | Log mode and authorization digest/identity only; keep standard npm evidence schema unchanged. The operational record describes a credential exception, not new authorization for any historical incident. |

Implementation can proceed with these recommendations. Actual owner credentials, the final release candidate and artifact digests are intentionally not supplied by this design.
