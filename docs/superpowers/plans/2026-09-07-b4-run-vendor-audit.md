# B4.run authenticated vendor audit

Date: 2026-09-07. Companion to [the rename plan](2026-09-07-b4-run-rename.md).

This pass used CLI/API reads, with credentials loaded directly from the primary checkout's `/Users/blove/repos/dawn/.env`. The planning worktree has no root `.env`. No credentials were copied into this document or the worktree. The initial audit was read-only; the subsequent authorized changes are recorded below. API response fields were restricted to account/resource metadata; environment variable values and trace contents were not output.

## Credential results

| Credential name | Read check | Result | Consequence |
|---|---|---|---|
| `NPM_TOKEN` | npm identity and `b4run` organization membership | HTTP 401, including a check using the file value directly | Refresh token or establish authenticated npm login; verify `b4run` rights and unscoped `create-b4-app` ownership before package setup |
| `VERCEL_API_TOKEN` | User, teams, projects, domains, DNS and Blob metadata | HTTP 200 | Can inspect Cacheplane's relevant resources through API |
| `LANGSMITH_API_KEY` | Visible workspaces, tracing projects and dataset metadata | HTTP 200 | Can inventory the visible workspace; no broader account/deployment access claim |
| `RESEND_API_KEY` | Domain listing | HTTP 200 | Visible sender domains are for other products; no Dawn/B4 sender domain found |
| `ANTHROPIC_API_KEY` | Model-list endpoint | HTTP 200 | Read authentication works; billing/admin permissions were not tested |
| `OPENAI_API_KEY` | Model-list endpoint | HTTP 401 | Refresh before provider-dependent verification; repository work and offline checks can continue |

The npm/OpenAI failures establish rejected authentication, not the reason for it. Expiry, revocation or credential configuration needs owner-side inspection. No billable model generation or email sending was performed.

## Initial resource snapshot (superseded where noted below)

### Vercel

Team: **cacheplane**, ID `team_RWMT2bzjj1nkSXI3N3arQ6CP`. The project and domain listing pages were complete: nine projects and five domains, with no next page. Only two project names matched Dawn/B4. A separate personal team is visible but was not audited in this pass; resources there remain outside the confirmed inventory.

| Resource | ID/current value | Migration action |
|---|---|---|
| Docs project | `dawnai`, `prj_Syd2iGdPVSDoqtZCqqP2XeWnNlLB` | Prepare B4 project and copy reviewed build/access settings |
| Docs Git connection | `cacheplane/dawnai`, repository ID `1210070282`, production branch `main` | Bind the target repository and record its new numerical ID |
| Docs build settings | Next.js; root `apps/web`; install `pnpm install`; build `pnpm run build` | Preserve verified monorepo settings in the B4 project |
| Docs environment names | `BLOB_READ_WRITE_TOKEN` across production/preview/development | Rebind the selected media store; do not treat the vendor-defined env name as framework branding |
| Docs deployment protection | `all_except_custom_domains` | Preserve protection during preparation and explicitly handle old deployment URLs at retirement |
| Docs domain bindings | `dawnai.org`, `project-239jp.vercel.app`; no redirect configured on either returned binding | Add the new apex to the prepared project at cutover and retire old bindings |
| Native test project | `dawn-vercel-native`, `prj_VrwpRx6tGYsWDhJEynC87EC79xU5`; no Git connection | Prepare the B4 native test target independently of the docs project |
| Native test domain | `dawn-vercel-native.vercel.app`; no redirect configured | Replace test URLs and retire the old domain/project |
| Native test DB integration evidence | Project env names include `NEON_PROJECT_ID`, `DATABASE_URL`, `PGHOST`, pooled/unpooled URLs and related Postgres settings; Cacheplane integration slug `neon` is installed | Neon is evidenced as an integration; exact database/project ownership and whether it is shared still need inspection before any rename or retirement |
| Blob store | `dawnai-website-assets`, `store_9RQ8eZyGheVy0wOp`, type `blob`, region `iad1` | Relabel/rebind if the store can be retained; coordinate uploader identity pins, media regeneration and catalog updates |
| Old domain | `dawnai.org`, verified in Vercel; Vercel nameservers; purchase/expiry fields null | Vercel registration ownership is not established by this response; confirm registrar separately |
| Old DNS zone | Six records: apex TXT, three apex CAA, wildcard ALIAS and apex ALIAS; returned TTLs 60 seconds | Include wildcard retirement and certificate/verification records in the cutover; record values privately when exporting the zone |

No `b4.run` domain appeared in the Cacheplane Vercel domain list. Public DNS from the earlier audit points to Squarespace. No Squarespace/registrar credential is present among the six root `.env` keys, so DNS account access remains an explicit prerequisite. Do not infer inability to add the domain to Vercel from its current absence.

### LangSmith

The key exposes workspace **`angular-agent-framework`**, ID `09384e25-a023-4881-a198-90d51bff77d1`, organization ID `89a301b6-f04f-4ba6-861b-a649c374edd3`, with reported role **Admin**. Its tracing-project response contained 43 entries, and its dataset metadata response was empty, both with a requested limit of 100.

The explicit Dawn tracing project is **`dawn-research`**, ID `ea61a624-235c-43d8-9ee0-1b91cf2f50ee`. Add it to the migration: use `b4-research` for new tracing configuration, and decide whether to relabel the existing project while preserving accurate historical traces or create a fresh project and retire the old configuration. This is not an alias or fallback. Do not rename the shared workspace or the other projects merely because this key can access them. Deployed LangSmith applications and other workspaces have not been inventoried by these tracing endpoints.

### Resend

The domain list was complete (`has_more: false`) and contained two verified domains: `threadplane.ai` and `cacheplane.ai`. Neither is a Dawn/B4 domain. Retain these other-product resources. Creating a B4 sender domain is needed only if the product will use email; a credential's presence does not establish a Dawn mail dependency.

## Next implementation sequence

1. **Prepare source work from current main.** Use an isolated feature branch/worktree; carry over the approved plan and package mapping without disturbing the planning checkout's unrelated edits. Establish a clean baseline, then write the focused package/CLI/config/scaffold implementation checklist and rename contracts.
2. **First source tranche:** replace the package scope with `@b4run`, wire `b4`/`b4.config.ts`/`.b4`, update public branded symbols and templates, and regenerate lockfile/build output. Keep production publishing and domain cutover gated while this is validated.
3. **Prepare account resources alongside source:** confirm GitHub target identity, refresh npm access, establish `b4run` package ownership/trusted publishing, and prepare B4 Vercel projects, Blob configuration and the relevant LangSmith tracing target. Verify exact Neon resource ownership before altering it.
4. **Finish brand/site and release identity changes:** regenerate all media and package artifacts, update release policy and signatures for the new repository, and run the full affected CI/release/deployment verification.
5. **Cut over after a concrete release packet is ready:** publish verified B4 packages/site, verify Vercel DNS delegation, then retire old endpoints and publishing without redirects or compatibility aliases.

Remaining owner inputs/access after the follow-up below: a working OpenAI credential for live provider checks and identification of social/design/marketing accounts outside this API inventory. npm CLI access is verified, and the user has completed domain setup; nameserver propagation still needs verification. These do not block local source preparation.

The globally installed Vercel CLI is `35.2.1` and does not expose the current Blob command used by documentation. This audit used the API instead. Use the repository-pinned CLI version for subsequent deployment verification rather than the outdated global installation.

## Execution follow-up: user login and hosting setup

- User attached `b4.run` to the existing Vercel docs project and requested that project be renamed. API confirmed the domain is verified and has no redirect. User reports switching nameservers to Vercel; the system resolver still observed Squarespace nameservers and a Squarespace HTTP response during the follow-up. Recheck propagation before cutover. Vercel already exposes a five-record B4 zone (three CAA, wildcard ALIAS, apex ALIAS).
- Renamed the existing docs project to **`b4-run`** through PATCH and verified it by ID. Project ID `prj_Syd2iGdPVSDoqtZCqqP2XeWnNlLB`, build root and Git connection are retained. Reuse this project; supersede the earlier replacement-project recommendation.
- `npm whoami` reports **`blove`**; `npm org ls b4run --json` reports **owner**. Use the npm CLI login; do not override it with the stale root-file `NPM_TOKEN`.
- Created **`cacheplane/b4run`**, repository ID **`1210070282`**, with **Actions disabled** during setup. No source was pushed and no existing repository was renamed.
- Root-file OpenAI read check still returns **401**. Offline source checks can continue.
- Created isolated source worktree `/Users/blove/repos/dawn/.worktrees/b4-run-rename`, branch `blove/b4-run-rename`, baseline `2a4ffd99`. Pinned pnpm 10.33.0 installation, full build (25 tasks) and release-integrity baseline (33 tests) pass. The globally selected fallback pnpm has incompatible settings semantics; use the repository-pinned version.

## Source and brand progress

- Source package names, imports, config/state paths, branded API names, scaffold, examples, website content, Helm chart names and current root documentation have been renamed on the isolated branch. The first renamed build passed all 25 tasks; all 12 new config/state negative and positive contract tests pass. Full validation and independent review remain in progress.
- Horizontal SVG wordmarks now say B4.run. PNG exports were rendered from those updated vectors and visually inspected. The downloadable brand ZIP was rebuilt, retaining all original asset categories, with no old branded paths or textual metadata. The existing unlettered symbol is retained.
- Product demo capture is being regenerated through the existing real scaffold/test/Workbench workflow. Media uploads and production cutover remain pending.
- The new repository remains empty with Actions disabled; npm packages have not been published, the Vercel Git connection still points at the old repository, and old domain bindings have not been retired. These steps follow successful source/release validation.

- Authoritative DNS trace now confirms the `.run` registry delegates `b4.run` to `ns1.vercel-dns.com` and `ns2.vercel-dns.com`; Vercel responds authoritatively for the zone. The system resolver still has the older Squarespace answer cached. The registrar change is confirmed, with resolver cache propagation outstanding.

- Renamed the existing Vercel native test project to `b4-vercel-native` and verified stable ID `prj_VrwpRx6tGYsWDhJEynC87EC79xU5`. Existing test-domain retirement is still part of cutover.
- Renamed the product-specific LangSmith tracing project to `b4-research`, verified stable ID `ea61a624-235c-43d8-9ee0-1b91cf2f50ee`, and retained its trace history. Shared workspace and other projects were unchanged.
- The full build/typecheck graph now passes 51 tasks. Focused website SEO/media-link checks pass 47 tests. Strengthened CLI identity tests pass 10 cases, including populated legacy SQLite non-consumption and old/new permission-mode environment behavior. Independent static source review found no significant defect; release/media/full-suite gates remain pending.

- Product-loop capture completed as run `32358b9d-1af3-4f81-b4dd-696bbb69524e`; the new flagship is 25 seconds to preserve the full restoration endpoint. All eight videos, four posters, and GIF pass local media validation; Author and restored Run posters were visually inspected. Media tool tests pass 117 cases. Remote media upload remains pending.
- The first full source test run completed: 5,671 passed, 218 skipped, 13 failed. All failures subsequently passed focused verification after URL/anchor/text-length/source-offset fixes; the timed Docker ownership case passed alone with its original watchdog. Full validation will rerun on the committed source.
- Release review identified a historical security receipt uploader that could still run in B4. It is now unconditionally disabled, with activation/removal/expression rejection tests. Historical security tooling remains unchanged. A separately reviewed B4 receipt implementation is required before re-enabling that optional uploader.
- Vercel Blob label remains `dawnai-website-assets`. The published API exposes no rename operation and the available dashboard browser is unauthenticated; storage data and its opaque URL remain intact. Relabel through an authenticated dashboard during the final vendor cleanup.

## Latest credential and repository follow-up

- User refreshed `OPENAI_API_KEY` in the primary root `.env`; the retry returned HTTP 200 and confirmed `gpt-5-mini` is available. Provider verification is no longer blocked by authentication. The key remains outside this repository.
- Target repository discussion support, disabled wiki and automatic branch deletion now match the source project; neutral repository topics are copied. Actions remain disabled. npm CLI profile confirms `blove` with `auth-and-writes` two-factor mode; first publication may need a fresh npm write authorization.
- Initial preparation commit is `946bd6ed`. A subsequent sitemap test correction validates every date against its content source instead of requiring an arbitrary number of distinct timestamps: a repository-wide rename legitimately updates many pages at once. Focused sitemap tests pass 8 cases.

- Live OpenAI verification completed: 14 tests passed across seven testing suites (agent harness, memory, permissions, constrained tools, recorded evals, episodic memory and distillation).
- The second full source run reached 5,686 passed, 218 skipped and the one sitemap failure already fixed and verified separately. A final complete validation run follows the media staging commit.
- Uploaded all eight regenerated videos under `b4/demo/` in the retained Blob store and verified direct HTTP 200 plus exact MP4/WebM content types for all eight. Updated the catalog only after verification. The uploader and catalog validator now require the exact B4 prefix and reject old upload paths; all 117 media-tool tests and four web catalog tests pass. Existing `demo/` videos await retirement at cutover. Bound Blob credentials were decrypted using the official per-variable Vercel endpoint and held only in memory.
- Native Vercel live verification is running against the renamed dedicated test project, with its bound database and exact cleanup receipts. No docs-production deployment has been changed.

## Validation and environment follow-up

- New GitHub environments now preserve the source repository’s settings: `copilot`, `Preview` and `Production` have no added protection rules; `vercel-preview` accepts only the existing `main` and `refs/pull/*/merge` branch patterns. Actions remain disabled. Branch protection, release credentials and installed-app access are still pending source publication.
- Both renamed Helm charts passed strict lint, rendering assertions and all four kubeconform configurations (28 resources, zero invalid/errors/skipped). The sandbox PVC reaper tests also passed. Subsequent review corrected all Kubernetes label/annotation namespaces from an erroneous `b4.sh` to `b4.run`, including escaped JSONPath/Helm selectors. The reaper stub now verifies the exact annotation selector; 286 focused Kubernetes tests and the updated render/reaper checks pass.
- Native Vercel verification passed 299 unit checks but failed its live source preview because the deployment remained `QUEUED` at the existing readiness deadline. Functional database/streaming and prebuilt phases did not run. Cleanup deleted the sole owned deployment (independent lookup HTTP 404), proved no test database rows remained, and passed artifact preparation/secret scanning. The success receipt correctly remains incomplete. Other team projects had queued/building deployments; none were cancelled.
- That native harness indirectly rebuilt the shared checkout. The concurrent full source run therefore observed a partially regenerated CLI docs directory: one build failed with `ENOTEMPTY`, and the docs inventory was transiently incomplete. A separate upload-generated caption regression was corrected at the caption source and in the selected media manifest/catalog. A cleanup timing test also exceeded its unchanged limit under load. The run ended with 5,683 passing, 218 skipped and four failed tests; it is not a passing gate. A clean rebuild passed all 25 tasks, followed by a source rerun with four workers and no concurrent shared builds.
- Historical npm orphan-version cleanup is restored byte-for-byte to its original Dawn targets and covered by the historical preservation regression. It must never be invoked as a B4 package cleanup operation.

- Browser verification of the local production build passed desktop/mobile homepage and mobile getting-started checks: B4.run title/canonical, no old visible brand, no horizontal overflow. All four hosted video elements reached readyState 4 without media errors. All 83 sitemap pages returned HTTP 200; `/robots.txt`, `/llms.txt`, `/llms-full.txt` and `/blog/rss.xml` returned HTTP 200, with B4 origin in RSS. The repository docs completeness guard passed.
- Removed 26 tracked legacy `.dawn` build/state outputs from examples. These were accidentally added after the ignore pattern moved to `.b4`; they are not historical evidence and must not ship in the B4 source. A dedicated tracked-file branding regression gate is being added.
- Reconfirmed old repository main remains baseline `2a4ffd994db9ce97f21b4e6c41beee393fadd298`. Nine open PRs remain: #573 nullable tool schemas, #543 edge static marker files, #506/#489 stream reattachment, and dependency updates #521/#520/#519/#518/#479. They were inventoried without closing, merging, commenting or transferring them. Preserve/reconcile this open work before archival.

- Complete release-controller verification passed 3,611 tests in 24 suites, zero failures or skips, including all 64 before/after recovery-mutation interruption cases. The subsequent full source run passed every other test file (462 passed, 17 skipped); four failures were confined to the shell ownership/supervisor suite. That entire 94-test suite is being rerun without concurrent heavy verification.
- The tracked-file identity gate passes 15 focused cases and has received an independent review. Its 366 exceptions name exact files, reason categories and digests of only approved historical/negative-test lines; adding old branding to those files still fails. It covers tracked generated files regardless of ignore rules.

## Live deployment lane and first-publication follow-up

- The live native Vercel lane now **passes** against the renamed `b4-vercel-native` project: 300 of 300 checks, both `source` and `prebuilt` previews deployed, a verified project binding, and a closed cleanup receipt that deleted both owned deployments and left no test database rows. Two earlier attempts failed for local-environment reasons, not product defects: the lane requires the four GitHub marker coordinates (`GITHUB_JOB`, `GITHUB_REPOSITORY_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_RUN_ID`), and an inherited `CLAUDECODE` variable made the pinned Vercel CLI emit an extra plugin hint line and crash its auto-update probe, failing the exact-version check. Run this lane in a dedicated checkout with that variable unset; never in a checkout another build is using.
- The generated-app publish harness failed on a stale expectation, not a regression: the renamed typegen header is 12 bytes shorter, so both Verdaccio lifecycle fixtures recorded the old `renderedBytes`. Values corrected to 456 (basic) and 320 (custom appDir); the full lifecycle itself passed at every step, scaffolding through `pnpm build`.
- The npm **first-publication bootstrap is implemented** on `blove/b4-first-publication` and merged into the rename branch. It adds `scripts/release/npm-bootstrap.mjs`, an explicit `--npm-auth-mode oidc|bootstrap` publisher argument defaulting to OIDC, a default-off `npmBootstrap` workflow input, an owner-managed authorization variable bound to repository ID `1210070282` with a bounded window, a dedicated first-publication registry reader that treats only authoritative npm not-found bodies as absence, and credential redaction across nested error fields. Verified: release integrity 33/33, release controller 3,660/3,660, release inventory clean at HEAD, identity boundary 4/4.
- The bootstrap remains inert until the owner provisions `B4_NPM_BOOTSTRAP_TOKEN` and the post-escrow authorization variable. Its npm credential must carry creation rights for the unscoped `create-b4-app`; `@b4run` organization ownership does not cover that name.
- `https://b4.run` currently serves the old Dawn site: the renamed Vercel project still deploys from `cacheplane/dawnai`. This resolves when its Git connection is rebound at cutover, and is expected until then.
