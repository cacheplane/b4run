# B4.run cutover status and post-release operations

This is the current operational summary as of **2026-09-09**. The September 7 planning documents retain historical decisions and observations; their unfinished checkboxes do not describe the current release state.

## Canonical identities and shipped version

| Surface | Current identity |
| --- | --- |
| Product and website | **B4.run**, <https://b4.run> |
| Repository | `cacheplane/b4run`, numeric ID `1210070282` |
| npm | Twenty `@b4run/*` packages and `create-b4-app` |
| CLI and application configuration | `b4`, `b4.config.ts`, `.b4`, `B4_*` |
| Shipped release | **0.8.28**, candidate `bb036c7d57320a04efdebd247070504e06f140d1` |
| Current main | `811cd0402a478f3d541bd60572b24a34ddd6665b`, source manifests at **0.8.29** |

The original repository was renamed in place. A separately created replacement repository was abandoned. Do not create another repository, archive the current one, or treat its inherited numeric ID as sufficient release authorization. Historical readers are bounded by repository name, candidate identity, and exact evidence digests. They do not authorize publication of historical package identities.

The recorded handoff decision preserves automatic repository redirects and permanent old-website redirects. Those settings are live; their reconciliation with the initial no-redirect request remains tracked in [#600](https://github.com/cacheplane/b4run/issues/600). Runtime/package compatibility aliases remain prohibited. This runbook does not authorize changing domain policy.

## Release evidence

- All 21 public npm identities returned HTTP 200 with `latest: 0.8.28` and provenance-attestation metadata on September 9. Source version 0.8.29 is not yet published.
- [B4 v0.8.28](https://github.com/cacheplane/b4run/releases/tag/v0.8.28) is the latest public release and retains package tarballs, attestations, manifest, release record, smoke receipts, and audit results.
- [Release run 34337934470](https://github.com/cacheplane/b4run/actions/runs/34337934470) passed npm reconciliation, all five consumer smoke lanes, audit correlation, and release publication. The smoke lanes cover metadata, scaffold, storage, published harness, and runtime targets.
- [Independent audit 34355216209](https://github.com/cacheplane/b4run/actions/runs/34355216209) passed. Its result binds version 0.8.28 to the shipped candidate, even though the coordinator executes from current main.
- [Controller observation 34350462235](https://github.com/cacheplane/b4run/actions/runs/34350462235) reports `AUDIT_COMPLETE`, no conflicts, and no required transition. Earlier ambiguous candidate-discovery results are historical failures, not the current launch blocker.
- [CI 34288758246](https://github.com/cacheplane/b4run/actions/runs/34288758246) passed at current main, including the release controller and infrastructure lanes.

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

The 0.8.28 rows match the shipped npm release; the newer chart versions refer to current main. Existing package Actions access and repository inheritance were retained. No workflow was edited, retried, or dispatched for this operation. Exact chart metadata and archive hashes are retained in [the public chart receipt](./2026-09-09-b4-public-charts.json).

[#599](https://github.com/cacheplane/b4run/issues/599) owns the transition to normal npm trusted publishing:

1. Complete npm’s separate browser/2FA escalation. The renewed CLI login identifies the owner as `blove`, but trusted-publisher inspection requires additional authentication. The initial browser authorization expired while the browser remained at the sign-in form; start a fresh authorization after browser sign-in.
2. Inspect all 21 packages with `npm trust list <package> --json`. Verify GitHub owner/repository `cacheplane/b4run`, workflow `release.yml`, permission `--allow-publish`, and no environment restriction while the publisher job has no environment.
3. Configure missing settings with `npm trust github <package> --repo cacheplane/b4run --file release.yml --allow-publish`, using owner authentication and the required 2FA. A bypass-2FA granular bootstrap token is not supported for trust management. See [npm trust documentation](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
4. Once all publishers are verified and no admitted candidate needs bootstrap, revoke the dedicated npm bootstrap token and remove the repository secret `B4_NPM_BOOTSTRAP_TOKEN` and variable `B4_NPM_BOOTSTRAP_AUTHORIZATION`.
5. Record the next ordinary release's actual OIDC publication as a separate future verification. Provenance metadata on the bootstrap release does not prove trusted-publisher settings are configured.

The bootstrap secret and authorization variable are still configured at this runbook's initial writing. Do not delete them merely because an unrelated chart check passes. Conversely, an unresolved Helm visibility issue need not block retirement once npm trust and candidate dependencies are verified.

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

The website redirect-policy question remains separate and unresolved. Broader account ownership and marketing gaps remain in #602. Keep stable resource IDs and historical release evidence intact.

## Marketing and operational backlog

The Cacheplane organization profile still advertised the old framework after the repository rename. It now uses B4.run, `@b4run/sdk`, `b4 build`, the final repository link, and the new documentation URL. The change is scoped to `profile/README.md` in the organization's profile repository: [commit 8040b3c](https://github.com/cacheplane/.github/commit/8040b3c0e35b5efd003999114ca7b6d5852473ff). No B4 release workflow was triggered by that profile edit.

The [marketing and account inventory](./2026-09-09-b4-marketing-inventory.md) records verified public assets, the stale `/brand` links, known Resend domains belonging to other products, and explicit ownership gaps. The brand page was intentionally removed in [#137](https://github.com/cacheplane/b4run/pull/137); remaining mobile-menu, not-found-page, and issue-template links now point directly to the existing ZIP in this change. The public and archived manifests use the product homepage `/`. Deployment verification remains pending; this change adds no route or redirect.

- [#602](https://github.com/cacheplane/b4run/issues/602): finish owner-backed inventory of social profiles, design libraries, email/contact paths, search consoles, and analytics. Unknown accounts remain unknown; do not invent integrations or publish announcements without an explicit request.
- [#603](https://github.com/cacheplane/b4run/issues/603): finalize historical npm package retention and publication-authority policy. No compatibility wrappers or incidental unpublishing.
- [#604](https://github.com/cacheplane/b4run/issues/604): design a fresh dependency-security receipt path. Successful release audits do not justify enabling the historical disabled uploader.
- [#605](https://github.com/cacheplane/b4run/issues/605): triage retained branches independently; preserve the #489 to #506 dependency and reuse [#535](https://github.com/cacheplane/b4run/issues/535) for known infrastructure flakes.

All eight follow-ups belong to the [B4.run launch completion milestone](https://github.com/cacheplane/b4run/milestone/1). Close each only against its actual acceptance criteria. Keep signed release records and incident evidence unchanged.
