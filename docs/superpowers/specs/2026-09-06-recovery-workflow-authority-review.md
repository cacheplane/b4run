# Bounded YAML semantic review — 2026-09-06

This review supersedes the provisional nonwriter classifications in review-notes.md. It is a semantic authority judgment for exceptional recovery of candidate `88c01c4afd59866fc0ea4c8f3b8444439a01c8ea` in `cacheplane/dawnai` (ID 1210070282), based on the retained workflow inventory, 102 distinct reachable YAML versions for the six excluded IDs, selected source bindings at main `0da9914c5eb7de60ecb4e410e1957e0ea92cde96`, and the credential/action boundaries below. It is not production admission and does not assert a mechanical proof over every historical ref.

## Recommended complete YAML classification

**Nonwriter:** Auto Approve 298573303; CI 260503755; Claude Review 298573302; CodeQL 298403532; Dependency Security Receipt 341590074; Kubernetes Compatibility 346875937.

**Fenced legacy:** Release 260503756; Published Artifact Verification 310393464; Version Packages 345282578; diag-attestation-verify 350337312; Probe draft visibility 349512629; additionally OpenSSF Scorecard 272837794 and Publish Chart 309127405 for the exceptional recovery window.

**Separate recovery identities:** owner 351097056 and audit 351097053. Two dynamic workflows require their separately reviewed platform records.

`yaml-topology-bindings.reviewed-draft.json` applies this classification. Scorecard and chart receive explicit observed-main commit bindings. It retains the mandatory candidate bindings and historical diag/probe bindings. The separately generated manifests bind the listed exact inputs, not a claim that code analysis establishes authority.

## Shared operational assumptions

1. GitHub enforces the job-scoped GITHUB_TOKEN permissions and runner/job isolation; checked-out code and third-party actions cannot manufacture broader GitHub scope from that token. The six nonwriters have no reviewed workflow path supplying release/npm/policy credentials or an OIDC grant. No independent release credential is preinstalled on their GitHub-hosted runners. These are concrete platform/runner trust assumptions, not conclusions from a workflow's name.
2. Repository administrators preserve credential separation during the recovery window. The supplied CI Vercel token is for Vercel resources; the database URL is for the test database; Anthropic credentials authorize model inference. Those credentials do not double as GitHub/npm credentials, and the Vercel test project/database do not store or expose release credentials. Their actual domains and observed use support this limited assumption; the review does not demand a new general credential audit absent contrary evidence.
3. Historical reruns preserve the original workflow permission shape and do not receive a newly injected release credential. The inspected history is representative of this repository's maintained workflows; there is no known unreviewed historical variant supplying broader release authority. A contrary concrete variant invalidates the exclusion. We explicitly inspected historical action changes and credentials, rather than inferring historical safety from current YAML.
4. During the short recovery window, no administrator introduces new release-capable variants, reusable workflow edges, credentials or runner configurations for the six IDs. Current-default hashes and complete workflow-ID inventories catch current source or identity drift; they are not represented as a scan of every ref. This operational restriction also covers same-repository PR changes that could otherwise alter their YAML permission requests.
5. PR approvals/comments, SARIF/security uploads, CI diagnostics and dependency-security receipts are not accepted as candidate recovery artifacts merely by content or name. Recovery evidence is correlated to the admitted owner/audit workflow and exact run/candidate lineage. These workflows may affect development/review activity but cannot use that activity to impersonate admitted release evidence. Disabling and draining the release-capable IDs prevents their normal downstream release path during recovery.

## Workflow-specific reasoning

### Auto Approve — 298573303 — nonwriter

One exact YAML version in the inspected history. It has no checkout, external action, package install, reusable workflow or dynamic script. An inline command uses the scoped GITHUB_TOKEN only for `gh pr review --approve`; it receives the PR number through an environment variable. It neither merges nor writes contents and has no release credential. The approval is a development review artifact, not admission authority. Historical reruns use the same limited code and token shape. There is no contrary release authority in the inspected source.

### CI — 260503755 — nonwriter

Seventy-four distinct YAML versions were inspected for credential and executable boundaries, rather than checking current permissions alone. Jobs build/test repository code, create disposable containers/clusters/previews and upload their own diagnostics. The observed external credentials are DAWN_VERCEL_TOKEN, DAWN_VERCEL_DATABASE_URL and Vercel project/team identifiers; no RELEASE_GITHUB_TOKEN, NPM_TOKEN, recovery policy token or OIDC grant appeared. Vercel credentials are passed to the native preview test and cleanup paths under `vercel-preview`; native API requests target `https://api.vercel.com`, and database cleanup uses the configured test database. The helper's `NativeReleaseAuthorization` is a newly generated random test HTTP header, not an npm/GitHub release credential.

Arbitrary branch/head/package code can run here, including historical dependencies. That can affect tests and the Vercel/test-database resources, but under the stated credential separation it cannot elevate the read-only GitHub token or authenticate to npm publication. CI check success is a release prerequisite, not a release writer; all release-capable downstream workflow IDs are fenced. Retain CI to avoid unnecessarily blocking required controller checks. No concrete contrary release-capable source was found in the inspected history.

### Claude Review — 298573302 — nonwriter

Fourteen distinct YAML versions were inspected. The workflow runs on `pull_request`, not `pull_request_target`, with read contents and PR write authority, and supplies an Anthropic inference key. Agent/head-controlled instructions and Bash execution are treated as arbitrary code, not assumed obedient to review instructions. Their usable credentials still bound the reachable release authority.

The first historical version at `8ad32775baee1a907dac239b0145cd3456850315` used action `806af32823ef69c8ef357086c573a902af641307` without an explicit github_token input. This deserves specific treatment: the retained action `src/github/token.ts` requests a GitHub OIDC token before its Anthropic app-token exchange, and the exchange can request contents-write app authority. That historical YAML does **not** grant id-token:write, so the exchange cannot obtain its prerequisite. It is not assumed harmless merely because the workflow's ordinary GITHUB_TOKEN is read-only. All other inspected YAML versions explicitly override with secrets.GITHUB_TOKEN; the inspected historical/current token functions return that supplied credential before attempting the exchange. No app private key, app access token, release token or OIDC grant is supplied in the inspected workflow history.

The Anthropic inference key does not itself substitute for the GitHub OIDC prerequisite in that inspected exchange. PR comments/approvals remain outside release/evidence authority. The retained external source files record this boundary; there is no evidence of a successful broader historical token route.

### CodeQL — 298403532 — nonwriter

Eight distinct YAML versions use the CodeQL init/analyze actions and repository checkout. Observed authority is repository read/actions read plus security-events write; no external secret, OIDC or release credential is supplied. Current analysis has build-mode:none. Even if historical analysis or repository contents cause code execution, the available write authority is SARIF/security data, not releases, tags, npm packages or admitted recovery run artifacts. No reusable workflow edge or alternate credential route was found in inspected YAML. This rests on action/job isolation and credential separation, not on a claim that static analysis never executes code.

### Dependency Security Receipt — 341590074 — nonwriter

Two exact YAML versions. Dispatch correlation inputs are checked, the checkout is the supplied exact observation SHA, and the workflow requires GITHUB_SHA and fresh main to match that observation. The local sealing code produces a dependency-security receipt and uploads a run-scoped artifact. The job uses contents-read GITHUB_TOKEN, with no release secret/OIDC. Even a malicious supplied checkout cannot gain release write credentials from these inputs. Its run-scoped artifact is not an owner/audit evidence record under the admitted recovery identity. Historical reruns retain those authority bounds. Source sealing behavior and identity correlation provide a concrete reason to distinguish this receipt upload from release evidence mutation.

### Kubernetes Compatibility — 346875937 — nonwriter

Three distinct YAML versions. Checkout/package installation and local cluster operations are real executable surfaces, including PR-controlled code. The workflow has read-only repository authority, no referenced external secret/OIDC, and uploads only its own compatibility diagnostics. Cluster-admin in a disposable local test cluster does not imply GitHub release or npm authority. Historical/default/dispatch checkout variation cannot create a release credential from these boundaries. No cross-workflow reuse or release-authenticated action was found in inspected YAML.

## Two bounded additional fences

**Scorecard 272837794:** Its intended OIDC use is result publication/Sigstore and its ordinary write scope is security-events. An OIDC grant is nevertheless present in ten inspected versions, including older tag-addressed action versions. Do not infer npm exclusion just from the intended audience: code with an OIDC grant can request an audience. Rather than expand this exceptional review into every external trust relationship, fence this workflow ID and drain all SHAs. This briefly pauses scheduled scorecards; it does not block CI/recovery. This is a conservative operational choice, not a finding that Scorecard has known npm authority.

**Publish Chart 309127405:** Four inspected versions use packages-write GITHUB_TOKEN for OCI Helm publication at `ghcr.io/cacheplane/charts`. That credential is not itself a contents-write GitHub release token or npm token. Nonetheless this job intentionally publishes packages. Temporarily fence it to avoid requiring a broader package-resource separation assertion in this recovery. This pauses automatic chart publication only; no existing chart is modified by preparation. This is not a claim that the GHCR credential can publish npm.

## Actual contrary evidence retained

Diag's real escrow branch has contents-write and a dynamic main checkout. Probe's original actual-run SHA `51a5db745e12be78bfc9c14467916e90fea7226f` has a contents-write job despite being absent from the local reachable-history scan. Version Packages supplies RELEASE_GITHUB_TOKEN. Those are concrete reasons to fence their IDs, rather than exclude diagnostic/PR workflows by their labels. The mandatory release/verifier IDs remain candidate-bound and fenced.

No workflow was disabled, dispatched, rerun, cancelled or admitted by this review. Production use still requires actual revocation/drainage, assembled contract validation, the separate platform records and normal admission authority.
