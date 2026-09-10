# B4.run cutover status and post-release operations

This is the current operational summary as of **2026-09-10 UTC**. The September 7 planning documents retain historical decisions and observations; their unfinished checkboxes do not describe the current release state.

## Canonical identities and shipped version

| Surface | Current identity |
| --- | --- |
| Product and website | **B4.run**, <https://b4.run> |
| Repository | `cacheplane/b4run`, numeric ID `1210070282` |
| npm | Twenty `@b4run/*` packages and `create-b4-app` |
| CLI and application configuration | `b4`, `b4.config.ts`, `.b4`, `B4_*` |
| Shipped release | **0.8.30**, candidate `4cf369605b2fee8c86aca34570bf45bf8ceccba1` |
| Source baseline for this status | `de01c51e9026cbd831dd9852d580dd3c8663e344`, source manifests at **0.8.30** |

The original repository was renamed in place. A separately created replacement repository was abandoned. Do not create another repository, archive the current one, or treat its inherited numeric ID as sufficient release authorization. Historical readers are bounded by repository name, candidate identity, and exact evidence digests. They do not authorize publication of historical package identities.

The owner explicitly approved retaining the existing automatic GitHub rename redirects and permanent old-website redirects, superseding the initial no-redirect requirement. This resolves the redirect-policy question tracked in [#600](https://github.com/cacheplane/b4run/issues/600). Runtime/package compatibility aliases remain prohibited; the redirect decision does not authorize them.

## Release evidence

- [B4 v0.8.30](https://github.com/cacheplane/b4run/releases/tag/v0.8.30) became public and immutable at **2026-09-10 22:06:58 UTC** (release ID `386616691`). The unchanged annotated tag resolves to candidate `4cf369605b2fee8c86aca34570bf45bf8ceccba1`; version 0.8.29 was not published to npm.
- [Release run 34534130844](https://github.com/cacheplane/b4run/actions/runs/34534130844), attempt 1, passed npm reconciliation, all five existing consumer smoke lanes, audit correlation, and GitHub publication. [Independent audit 34535486748](https://github.com/cacheplane/b4run/actions/runs/34535486748) passed for this exact candidate. [Candidate CI 34523291016](https://github.com/cacheplane/b4run/actions/runs/34523291016) also passed.
- All 21 public packages report `latest: 0.8.30`. The publisher's existing npm evidence verifies valid signatures using npm 11.17.0 and exact repository/workflow/tag/commit provenance. Independent public downloads matched every original tarball's size, SHA-256, SHA-512, and npm integrity.
- Publisher job [`103064001423`](https://github.com/cacheplane/b4run/actions/runs/34534130844/job/103064001423) explicitly recorded `NPM_AUTH_MODE: oidc` and `{"event":"npm-auth-mode","mode":"oidc"}`. Existing artifact [`npm-evidence-34534130844-1`](https://github.com/cacheplane/b4run/actions/runs/34534130844/artifacts/10175102296), ID `10175102296`, has service digest `sha256:ec6d79607b9c699f505e56be9c0c9aa03e7acc6e1a13adcb59d2043a3da51848` and reports `NPM_COMPLETE` for all 21 packages. The original manifest SHA-256 is `c6331cbf03f09af3ca3b1c0bed70430713538ebfd654795316b3135a7a2a6767`.
- Publication used the existing exact-candidate recovery path after two unexpected npm audit-response schema errors and one publisher deadline. Each attempt verified and skipped existing versions, preserving the original tag and tarballs. Fresh npm 11.17.0 checks passed after the schema errors; their original raw responses were unavailable, so the underlying cause remains unconfirmed. At least 21 minutes of the timed-out attempt were recorded registry-visibility waits. No timeout, signature check, workflow, gate, or credential fallback was added. [#621](https://github.com/cacheplane/b4run/pull/621) separately repaired selection past a fully verified historical release; it did not change the published candidate.

### Historical launch evidence

- All 21 public npm identities returned HTTP 200 with `latest: 0.8.28` and provenance-attestation metadata on September 9.
- [B4 v0.8.28](https://github.com/cacheplane/b4run/releases/tag/v0.8.28) remains an immutable historical release with its original package tarballs, attestations, manifest, release record, smoke receipts, and audit results.
- [Release run 34337934470](https://github.com/cacheplane/b4run/actions/runs/34337934470) passed npm reconciliation, all five consumer smoke lanes, audit correlation, and release publication. The smoke lanes cover metadata, scaffold, storage, published harness, and runtime targets.
- [Independent audit 34355216209](https://github.com/cacheplane/b4run/actions/runs/34355216209) passed. Its result binds version 0.8.28 to the shipped candidate, even though the coordinator executes from current main.
- [Controller observation 34350462235](https://github.com/cacheplane/b4run/actions/runs/34350462235) reports `AUDIT_COMPLETE`, no conflicts, and no required transition. Earlier ambiguous candidate-discovery results are historical failures, not the current launch blocker.
- [CI 34288758246](https://github.com/cacheplane/b4run/actions/runs/34288758246) passed at the earlier source baseline, including the release controller and infrastructure lanes.

Use these completed receipts before rerunning expensive checks. Do not publish a throwaway version or retry completed release transitions to test authentication.

## Distribution and publishing follow-up

[#598](https://github.com/cacheplane/b4run/issues/598) tracks the public consumer verification. The final release has complete npm and consumer-smoke evidence; anonymous Helm verification also passed on September 9.

Both GHCR packages `cacheplane/charts/b4-app` and `cacheplane/charts/b4-sandbox-infra` are now **public**, linked to `cacheplane/b4run`. Following the owner’s instruction to continue the proposed sequence, public package creation was temporarily enabled, only these two package visibilities were changed, and the organization restriction was restored. The saved organization form again shows public creation disabled, private enabled, internal disabled, and inherited repository access enabled.

Anonymous `helm pull` used empty Helm and Docker registry configuration files with credential environment variables excluded. All four downloads succeeded after the restriction was restored:

| Chart | Chart version | appVersion | OCI digest |
| --- | --- | --- | --- |
| `b4-app` | 0.2.6 | 0.8.28 | `sha256:10be621c139e7188757b0d7037b2f3e1f8d1b8fffb02511f0210ff22cc6ee579` |
| `b4-sandbox-infra` | 0.1.10 | 0.8.28 | `sha256:37b8e57999dbb6fa4035789c4e809c47bdc0c51998a2c29e2cb1ebf9fe8c6db9` |
| `b4-app` | 0.2.7 | 0.8.29 | `sha256:a904360dfd1897f4a5b10a2057f3e646e675729fd98c2b84f7722368ceb6e385` |
| `b4-sandbox-infra` | 0.1.11 | 0.8.29 | `sha256:ae1ea44aefdfab503a44bd0f7970f26ed99f822f3417c9b6386c76f04b34c133` |

A separate clean consumer check on macOS with Node v24.20.0 ran `npm create --yes b4-app@latest my-agent -- --template basic` using empty npm configuration and no inherited credentials. Dependency installation, typecheck, build, and generated runtime tests passed. `npm run dev -- --port <unused-port>` returned HTTP 200 with `{"status":"ready"}` at `/healthz`; all installed B4 dependencies resolved to 0.8.28, `b4.config.ts` existed, and the generated source had no retired package/config names. The process and temporary app were removed. See [the consumer receipt](./2026-09-09-b4-public-consumer.json). This read-only startup check made no provider inference requests.

In this September 9 inventory, the 0.8.28 rows matched the shipped npm release; the 0.8.29 chart rows referred to the source version at that time. Existing package Actions access and repository inheritance were retained. No workflow was edited, retried, or dispatched for this operation. Exact chart metadata and archive hashes are retained in [the public chart receipt](./2026-09-09-b4-public-charts.json).

For the September 10 release, the existing [chart workflow 34523291007](https://github.com/cacheplane/b4run/actions/runs/34523291007) passed. Registry readback verified these additional versions, both with `appVersion: 0.8.30`:

| Chart | Chart version | OCI digest |
| --- | --- | --- |
| `b4-app` | 0.2.8 | `sha256:3cd0dbb58e12c21cacc09e201f5e3c049767d4150c23d5ec35e27d340b01e949` |
| `b4-sandbox-infra` | 0.1.12 | `sha256:ee6a29435208617288bb3d295208430cac1044b5844a1b39f5a967607663f0f8` |

[#599](https://github.com/cacheplane/b4run/issues/599) is **closed**: npm trusted-publisher configuration and bootstrap retirement were completed and freshly verified on September 10 UTC.

- All 21 B4 npm packages have exactly one GitHub trusted publisher for repository `cacheplane/b4run`, workflow `release.yml`, and permissions `createPackage` and `createStagedPackage`. No publisher has an environment restriction; the `publish-npm` job has no environment.
- Before retirement, candidate 0.8.28 (`bb036c7d57320a04efdebd247070504e06f140d1`) remained `AUDIT_COMPLETE` in controller observation [34350462235](https://github.com/cacheplane/b4run/actions/runs/34350462235), with no active workflow runs.
- The owner confirmed the dedicated npm bootstrap token named `b4run`, public ID `e7390e`. That token was revoked, and a fresh npm token list confirmed its absence. Unrelated tokens were preserved.
- Repository secret `B4_NPM_BOOTSTRAP_TOKEN` and variable `B4_NPM_BOOTSTRAP_AUTHORIZATION` were removed. Fresh repository secret and variable lists confirmed both names absent.

The [trusted-publisher and retirement receipt](./2026-09-10-b4-npm-trusted-publishers.json) contains public publisher IDs and settings, plus retirement results; it contains no credential values. Earlier browser/2FA blockers and configured-bootstrap observations are historical and no longer describe the current state.

Actual production OIDC publication is now verified by the ordinary 0.8.30 release recorded above, completing the observation tracked in [#619](https://github.com/cacheplane/b4run/issues/619) and linked back to [#599](https://github.com/cacheplane/b4run/issues/599). Bootstrap was disabled, and fresh repository secret/variable name inventories contained no npm bootstrap settings. This follow-up read existing logs, metadata, and artifacts; it introduced no publishing prerequisite or extra release.

Historical npm retirement under [#603](https://github.com/cacheplane/b4run/issues/603) is also complete. Exactly 21 obsolete trusted publishers were removed; the 21 B4 publishers remained identical. All 595 historical versions, tarball identities, dist-tags, and owner/team custody were preserved. Historical latest tags remain 0.8.26, with no further old-name releases, wrappers, or unpublishing. Optional deprecation notices were not applied.

## Retained vendor resources and completed cleanup

| Resource | Retained identity / current status |
| --- | --- |
| Vercel team | `cacheplane`, `team_RWMT2bzjj1nkSXI3N3arQ6CP` |
| Documentation project | `b4-run`, `prj_Syd2iGdPVSDoqtZCqqP2XeWnNlLB` |
| Native verification project | `b4-vercel-native`, `prj_VrwpRx6tGYsWDhJEynC87EC79xU5` |
| Blob store | `b4-website-assets`, `store_9RQ8eZyGheVy0wOp`; exactly eight current video objects retained |
| Native verification database | `b4-native-ci`, `store_WrmktlauesKeLfXA`, Neon resource `broad-butterfly-27644260` |
| LangSmith project/session | `b4-research`, `ea61a624-235c-43d8-9ee0-1b91cf2f50ee`; verified in the original vendor assessment |

Team-scoped Vercel API reads need `teamId=team_RWMT2bzjj1nkSXI3N3arQ6CP`; an unscoped 404 does not prove those projects are gone. September 9 reads confirmed both renamed projects and the existing domain bindings.

Completed September 9 under [#601](https://github.com/cacheplane/b4run/issues/601): removed the four pre-rename Vercel environment secrets after checking there were no queued/in-progress runs or executable references. The `vercel-preview` environment retains exactly the four B4 names: `B4_VERCEL_DATABASE_URL`, `B4_VERCEL_ORG_ID`, `B4_VERCEL_PROJECT_ID`, and `B4_VERCEL_TOKEN`. No database, current credential value, workflow, or Vercel resource was replaced.

The Blob store and native verification database labels were renamed to `b4-website-assets` and `b4-native-ci`. Fresh team-scoped API reads confirmed their stable IDs and connections to `b4-run` and `b4-vercel-native`, respectively. All eight current `/b4/demo/` video URLs returned HTTP 200 after the changes. The subsequent obsolete-object cleanup is recorded below. No database data was deleted and no current credentials were rotated.

Two similarly named integration stores, `store_F0sIXh2PbMW02MyE` and `store_cRK2BsvnGzzxf3B8`, are connected to `threadplane-lifecycle`. They belong to a separate product and are excluded from this rename.

Completed the reference audit and retired the native project’s pre-rename domain binding and its team-suffixed deployment alias. The domain was unbound; the deployment alias served only the original bootstrap placeholder. No active source references or registered GitHub/Vercel webhooks used either name. The native CI harness deploys to preview, consumes the returned deployment origin, and retains its configured project ID; it does not use these fixed hostnames. No workflows were queued or running before removal. Fresh project-domain and alias lists are empty, both retired hosts return 404, and `b4-vercel-native` retains its original ID and database connection. The historical deployment itself was retained.

The Blob inventory contained exactly sixteen objects: eight current `/b4/demo/` videos and eight obsolete `/demo/` videos. A crawl of all 83 sitemap pages found no old Blob-prefix references, including escaped forms, and active source pointed to the current catalog. Retired exactly `demo/{author,product-loop,run,test}.{mp4,webm}`. Fresh inventory contains only the eight current objects; all eight old URLs return 404, all eight current URLs return 200, and `b4.run` returns 200. The [retirement receipt](./2026-09-09-b4-vendor-retirement.json) records exact paths and sizes.

The owner-approved website and GitHub redirect policy is recorded above. Broader account ownership and marketing gaps remain in #602. Keep stable resource IDs and historical release evidence intact.

## Marketing and operational backlog

The Cacheplane organization profile still advertised the old framework after the repository rename. It now uses B4.run, `@b4run/sdk`, `b4 build`, the final repository link, and the new documentation URL. The change is scoped to `profile/README.md` in the organization's profile repository: [commit 8040b3c](https://github.com/cacheplane/.github/commit/8040b3c0e35b5efd003999114ca7b6d5852473ff). No B4 release workflow was triggered by that profile edit.

The [marketing and account inventory](./2026-09-09-b4-marketing-inventory.md) records verified public assets, known Resend domains belonging to other products, and explicit ownership gaps. The brand page was intentionally removed in [#137](https://github.com/cacheplane/b4run/pull/137). [PR #618](https://github.com/cacheplane/b4run/pull/618) merged as `777138ccf7b9599f1e7041c9d07d01a8c72d3781`; mobile-menu, not-found-page, and issue-template links point directly to the existing ZIP. September 10 production checks confirmed the homepage and not-found response link to the ZIP, the public manifest homepage is `/`, and the downloaded ZIP matches the merged asset (SHA-256 `5026d1dbb08e85af2710d5ff4b1c326ab1339914c64c9301ed077971dd763571`). The repair adds no route or redirect.

The owner-approved OpenSSF profile update is complete: [project 13317](https://www.bestpractices.dev/en/projects/13317/passing) now names B4.run and links to `https://b4.run` and `https://github.com/cacheplane/b4run`. Exactly ten branding fields changed (three identity fields and seven evidence-link prefixes), plus two server timestamps. All 194 status fields stayed unchanged, and passing remains 100%. See the [OpenSSF receipt](./2026-09-10-b4-openssf-profile.json) and marketing inventory for scope and submission-license disclosure.

- [#619](https://github.com/cacheplane/b4run/issues/619): production OIDC verification complete on ordinary release 0.8.30; evidence is recorded above.
- [#602](https://github.com/cacheplane/b4run/issues/602): external-account inventory is **deferred by the owner**. Unknown accounts remain unknown; do not invent integrations or publish announcements without an explicit request.
- [#603](https://github.com/cacheplane/b4run/issues/603): historical npm retention and publication-authority policy complete, as recorded above.
- [#604](https://github.com/cacheplane/b4run/issues/604): **closed as not planned** under the owner's publishing-simplicity direction. Do not add a security-receipt pipeline or enable the historical disabled uploader as incidental follow-up work.
- [#605](https://github.com/cacheplane/b4run/issues/605): records retained PR decisions, dependency maintenance, validation, and merges. Feature PRs #573, #543, #489, and #506, plus Next.js #617 and Sharp #614, are merged. Refer to the issue for the remaining maintenance results. Reuse [#535](https://github.com/cacheplane/b4run/issues/535) for the documented infrastructure failures; the distinct test-fixture clock race is handled in [#623](https://github.com/cacheplane/b4run/pull/623), preserving existing deadlines and assertions. Other recorded failures remain unresolved.

The original eight follow-ups belong to the [B4.run launch completion milestone](https://github.com/cacheplane/b4run/milestone/1). Close each only against its actual acceptance criteria. Keep signed release records and incident evidence unchanged.
