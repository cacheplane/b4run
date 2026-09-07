# B4.run Rename Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task after the proposed naming and account decisions are resolved. Steps use checkboxes for tracking. This document is a migration program plan; each code workstream needs a focused implementation checklist against the selected cutover commit.

**Goal:** Replace Dawn AI with **B4.run** across the framework, repository, distribution, website, marketing, domains, and operated vendor resources, with no redirects or backward compatibility.

**Architecture:** Prepare the B4.run source, distribution identities, and infrastructure together; validate them in isolation; then execute one coordinated public cutover. Use a new GitHub repository to avoid automatic repository-rename redirects. Reuse vendor accounts where practical, but retire all active Dawn-facing resources and identities.

**Tech stack:** TypeScript, pnpm/Turbo, Next.js, GitHub Actions and attestations, npm, Vercel hosting and Blob, Squarespace DNS, Helm/GHCR, Docker/Kubernetes, LangGraph/LangChain, SQLite/Postgres.

**Status:** Migration direction approved; npm organization **`b4run`** confirmed by the product owner. Read-only discovery and package-name preflight are complete. Execution has begun: the existing Vercel docs project was renamed to `b4-run`, npm CLI login confirms `blove` owns `b4run`, and `cacheplane/b4-run` was created with Actions disabled. Source migration is in the isolated `blove/b4-run-rename` worktree. Per-package publishing configuration remains an execution prerequisite.

**Follow-up:** The [authenticated vendor audit](2026-09-07-b4-run-vendor-audit.md) records CLI/API checks using the primary checkout's root `.env`, exact Vercel resources, LangSmith and Resend findings, remaining credential issues and the next source work tranche. Its later observations supersede the initial access limitations below. Prefer CLI and API for execution. **User-directed hosting decision:** retain and rename the existing Vercel project; `b4.run` is already attached and verified. The user changed nameservers to Vercel; the audit resolver still observed Squarespace during propagation. Do not create a replacement docs project or return DNS management to Squarespace.

---

## 1. Constraints and recommended approach

The product name is exactly **B4.run**: capital B, numeral 4, lowercase `.run`. The canonical site is `https://b4.run`.

- No Dawn-to-B4 redirects, redirecting repository rename, forwarding packages, old CLI aliases, dual config discovery, old environment-variable fallbacks, old API/type exports, or automatic loading/migration of Dawn runtime state.
- All new installations, examples, documentation, release artifacts, and first-party deployment resources must use B4.run identities exclusively.
- An old package remaining available as an immutable historical artifact is distinct from a compatibility package. B4.run must never depend on it. Retirement does not promise erasure of third-party caches, historical downloads, or signed records.
- Preserve legal attribution and the integrity of old signed release evidence. Do not relabel old signatures, recovery authorizations, or releases as B4.run evidence.
- This is a rename program, not a rewrite of the underlying framework or a change of infrastructure provider for its own sake.

Three approaches were considered:

| Approach | Benefit | Constraint/tradeoff |
|---|---|---|
| **New repository + new package identities + coordinated cutover — recommended** | Clear boundary, no automatic GitHub rename redirects, independently testable launch | GitHub stars/watchers and existing issue/PR identities remain with the old repository; settings and integrations must be recreated |
| Rename the existing GitHub repository | Retains repository identity and community metadata | GitHub automatically redirects web and Git operations; violates the stated constraint without additional platform-specific intervention |
| Rename marketing first, developer interfaces later | Smaller initial release | Prolongs mixed branding and requires old identities to remain active; unsuitable for the requested clean break |

GitHub's redirect behavior is documented in [Renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository). A new repository can retain commit history without renaming the old repository. Import the reviewed source history and selected branch, not old release tags, release automation state, or signed records as active B4.run state.

**Proposed historical policy:** Archive the old repository as a historical record, disable its deployment/publishing integrations, and retain old npm packages without further releases. Remove historical Dawn-only plans and incident tools from B4.run's active tree when they have no ongoing purpose; their originals remain in history/the old repository. Rebrand maintained docs and guides. The migration plan, explicit rejection tests, and required legal notices can contain narrowly scoped historical references. If the desired scope includes taking the old archive offline, make that a separate explicit retirement decision; do not delete it as an incidental rename step.

## 2. Proposed naming contract

| Surface | Current | Proposed |
|---|---|---|
| Product and prose | Dawn / Dawn AI | B4.run |
| Canonical origin | `https://dawnai.org` | `https://b4.run` |
| GitHub repository | `cacheplane/dawnai` | `cacheplane/b4-run` initially; dedicated organization is optional |
| npm organization/scope | `@dawn-ai` | **`b4run` / `@b4run` — confirmed** |
| Framework packages | `@dawn-ai/sdk`, etc. | `@b4run/sdk`, etc. |
| CLI executable | `dawn` | `b4` |
| Scaffolder | `create-dawn-ai-app` | `create-b4-app` |
| Scaffold command | `npm create dawn-ai-app@latest` | `npm create b4-app@latest` |
| CLI outside an installed app | Existing Dawn invocations | `npm exec --package=@b4run/cli -- b4 ...` |
| Root package | `dawn` | `b4-run` |
| Private examples | `@dawn-example/*` | `@b4-example/*` |
| Config | `dawn.config.ts` | `b4.config.ts` |
| Generated/local state | `.dawn/` | `.b4/` |
| Public identifiers | `DawnConfig`, `loadDawnConfig`, etc. | `B4Config`, `loadB4Config`, etc. |
| Framework env/error identifiers | `DAWN_*`, `DAWN_E1005` | `B4_*`, `B4_E1005` |
| Framework-owned machine names | `dawn-*`, `dawn_*`, `dawn:*` | Corresponding `b4-*`, `b4_*`, `b4:*` |
| Charts and chart directories | `dawn-app`, `dawn-sandbox-infra` | `b4-app`, `b4-sandbox-infra` |
| Chart registry | `ghcr.io/cacheplane/charts/dawn-*` | `ghcr.io/cacheplane/charts/b4-*`, adjusted if owner changes |
| Scaffolder source directory | `packages/create-dawn-app` | `packages/create-b4-app` |

The npm organization is **`b4run`**, and every scoped framework package will use **`@b4run/`**. Continue with the other naming defaults in the table; the npm organization spelling does not change the product name, repository slug, CLI executable or scaffolder name.

Follow-up public registry checks on 2026-09-07 returned 404 for all 20 target scoped packages and `create-b4-app`. This establishes that no public package metadata was returned at those names; it does **not** establish organization ownership, name availability or publishing rights. The local `npm whoami` check returned HTTP 401, so this session cannot yet verify authenticated membership or configure publishing. The subsequent user login resolved this: npm CLI reports `blove` as an owner of `b4run`. Use that CLI login rather than the rejected root-file token; verify package-specific publishing configuration before release.

The unscoped npm package **`b4` already exists**, so do not document bare `npx b4` as a safe bootstrap command. A scoped CLI can still provide a local `b4` binary.

### Confirmed npm package mapping

All package suffixes are retained. Public metadata checks returned 404 for every target listed below; repeat the check at execution time and verify ownership through authenticated npm access.

| Current package | Target package |
|---|---|
| `@dawn-ai/ag-ui` | `@b4run/ag-ui` |
| `@dawn-ai/cli` | `@b4run/cli` |
| `@dawn-ai/config-biome` | `@b4run/config-biome` |
| `@dawn-ai/config-typescript` | `@b4run/config-typescript` |
| `@dawn-ai/core` | `@b4run/core` |
| `@dawn-ai/devkit` | `@b4run/devkit` |
| `@dawn-ai/evals` | `@b4run/evals` |
| `@dawn-ai/inspector` | `@b4run/inspector` |
| `@dawn-ai/langchain` | `@b4run/langchain` |
| `@dawn-ai/langgraph` | `@b4run/langgraph` |
| `@dawn-ai/memory` | `@b4run/memory` |
| `@dawn-ai/memory-pgvector` | `@b4run/memory-pgvector` |
| `@dawn-ai/permissions` | `@b4run/permissions` |
| `@dawn-ai/postgres-storage` | `@b4run/postgres-storage` |
| `@dawn-ai/sandbox` | `@b4run/sandbox` |
| `@dawn-ai/sdk` | `@b4run/sdk` |
| `@dawn-ai/sqlite-storage` | `@b4run/sqlite-storage` |
| `@dawn-ai/testing` | `@b4run/testing` |
| `@dawn-ai/vite-plugin` | `@b4run/vite-plugin` |
| `@dawn-ai/workspace` | `@b4run/workspace` |
| `create-dawn-ai-app` | `create-b4-app` |

`create-b4-app` remains unscoped to support `npm create b4-app`; assign its maintainer access explicitly because organization membership does not establish ownership of an unscoped name.

Keep neutral API names such as `agent()` and third-party identities such as `OPENAI_API_KEY`, `LANGSMITH_*`, `.vercel/`, and `langgraph.json`. Rename framework-owned identifiers, not vendor protocols. Use a written mapping for every public symbol, route, schema, and storage prefix, rather than indiscriminate replacement.

**Version proposal:** Continue the pre-1.0 fixed-group version train, choosing the next unused patch from the final source baseline under the new package names. Current main and the public SDK report `0.8.26`; do not hard-code the cutover version now. A new name does not imply a 1.0 stability promise. If a fresh `0.1.0` train or an intentional `1.0.0` launch is preferred, choose it before rebuilding release state. Pending changesets and every package must agree with that choice.

## 3. Audit evidence and limits

Audit date: **2026-09-07**. Local checkout started at `260920ca`; fetched `origin/main` is **`2a4ffd994db9ce97f21b4e6c41beee393fadd298`**. The current main tree contains **1,621 text files matching Dawn** and **121 tracked paths containing dawn**, including historical material and fixtures. These are scope indicators, not estimates of semantic changes.

The current release system is substantially newer than this checkout. All execution must start from a freshly selected main commit; do not implement against the older local release scripts or the old four-script pin inventory. See the companion authenticated audit for the subsequent account verification results; the table below preserves the initial discovery evidence.

### Vendor and account register

“Confirmed” identifies the evidence actually observed; it does not imply full billing/admin access. Every row needs an assigned owner and a completed migration receipt before cutover.

| Service | Evidence / confidence | Required action and remaining audit |
|---|---|---|
| **GitHub** | Live public repo `cacheplane/dawnai`; homepage `dawnai.org`; Actions and deployment history inspected | Create new repo; copy branch policy, permissions, environments, templates, topics, descriptions, social preview and installed-app access. Current main requires `validate`; enumerate org policies too. Inventory open PRs/issues/discussions/projects, release assets, LFS/wiki/submodules if present. Recreate selected open work with attribution; do not transfer issues through a mechanism that creates redirects. Stars/watchers remain historical. |
| **GitHub Actions / release identity** | Live repo secrets named `ANTHROPIC_API_KEY`, `RELEASE_GITHUB_TOKEN`, `RELEASE_POLICY_READ_TOKEN`; environments `copilot`, `Preview`, `Production`, `vercel-preview` | Reissue or authorize credentials for the new repo; configure environment policies and app access. Update numerical repository IDs, exact signer/workflow identities, OIDC claims, audit/recovery policy and concurrency groups. Secret values were not read. |
| **npm** | 21 publishable packages in fixed group; live `@dawn-ai/sdk@0.8.26`; target org `b4run` confirmed; all 21 target public metadata checks returned 404; local authentication returned 401 | Establish authenticated `b4run` membership and publish rights, plus ownership of unscoped `create-b4-app`; apply the package mapping above; verify each trusted publisher against the new repo/workflow and allowed publish actions. Plan first-publish bootstrap, dependency ordering, dist-tags, provenance and complete-set verification. Retire old publishing authorization. |
| **Vercel hosting** | `dawnai.org` returns 200 with Vercel headers; GitHub status links to `vercel.com/cacheplane/dawnai`; successful production deployment observed | Inspect production project settings, build root (`apps/web` expected, verify), team, Git integration, env names, preview protection, domains, redirects, branch aliases, certificates, cache/analytics settings and billing. Prepare the existing project, renamed to `b4-run`, connected to the new repo; old preview URLs and project domains must be retired or protected. |
| **Vercel preview CI + database** | `vercel-preview` contains `DAWN_VERCEL_TOKEN`, `DAWN_VERCEL_ORG_ID`, `DAWN_VERCEL_PROJECT_ID`, `DAWN_VERCEL_DATABASE_URL` | Identify the actual preview project and database vendor/resource in the vendor console; the DB host is not proven by its secret name. Create/relabel B4 resources, provision `B4_VERCEL_*` secrets, preserve branch restrictions, and verify cleanup receipts. Do not assume the preview project is the docs project. |
| **Vercel Blob** | Current media catalog references `https://9rq8ezyghevy0wop.public.blob.vercel-storage.com`; product-loop MP4 returns 200; uploader pins store `store_9RQ8eZyGheVy0wOp` | Inspect ownership and attached projects. Re-record all clips, posters and transcripts; update catalog and upload authorization together. Prefer reusing/relabeling the opaque-ID store if it belongs to the same team and can be detached from retired resources; otherwise create a new store and update exact pins. Retire old branded media after cutover; no redirect URLs. |
| **Squarespace DNS** | `b4.run` nameservers are `nsb1`–`nsb4.squarespacedns.com`; apex serves Squarespace; `www` CNAME points to `ext-sq.squarespace.com` | Confirm registrar, registrant account, renewal, DNS control and whether parking or a paid website is attached. The user switched nameservers to Vercel DNS; verify parent delegation and propagation, then manage the zone in Vercel. Domain purchase does not require transferring registration. Remove parking/forwarding/unused `www` records at cutover. |
| **Vercel DNS / old domain registrar** | `dawnai.org` NS are `ns1.vercel-dns.com` and `ns2.vercel-dns.com`; registrar not established | Export full zone and verify registration ownership/renewal. Inventory all old subdomains, not just apex/www. Remove old app bindings and forwarding; retain domain ownership with no B4 redirect. Select terminal 410 service or non-resolving web records for retirement. |
| **GHCR / Helm** | Chart workflow targets `ghcr.io/cacheplane/charts`; latest inspected publish-chart run succeeded Sep 4 | Publish two new chart names; inspect actual registry artifacts and access inheritance. GitHub package listing returned no entries to this token, so publication/visibility needs a registry-level check. Stop old chart publications. No chart aliases or automatic release adoption. |
| **Anthropic** | Claude review workflow plus configured `ANTHROPIC_API_KEY`; recent run exists | Inspect API organization/project label, billing/contact and GitHub access. Reuse a shared organization; relabel/reissue product-specific project/key if needed. Latest inspected review run failed; assess separately before using it as a launch check. |
| **OpenAI** | Runtime examples and provider support; checkout had a workflow reference, but no repo-level key was listed | Determine whether a product-owned project/key or billable live test remains in use. Update labels/billing contacts and app access only if relevant. Do not rename third-party `OPENAI_API_KEY`. |
| **OpenSSF / badges** | Scorecard workflow, README badges and best-practices link | Recompute checks for the new repository; update badge URLs and any registered project URL. Verify project ownership before editing externally maintained listings. |
| **LangSmith, Cloudflare, Neon, other model/vector vendors** | Supported runtime/deployment integrations and dependencies exist | Inventory actual organization-owned projects, deployments, traces/datasets, OAuth callbacks and bills. Repository support is not proof of an operated account. Relabel/move only confirmed product resources; test framework integrations regardless. |
| **Email, analytics, design, social/community, CRM and billing** | No MX answer for either apex; targeted first-party scan found no common analytics/CRM/social integrations | Confirm with account owner and account/billing inventory. Check Google Workspace/Microsoft 365, transactional email, Search Console/Bing, analytics, monitoring, Figma/design source, social handles, Discord/Slack, newsletters, directories, sponsor pages, invoicing and password-manager records. These are audit categories, not claims that any specific vendor is used. |

An empty hooks response does not enumerate installed GitHub Apps. Missing MX or source integrations does not prove the absence of an account. Subsequent CLI/API inspection verified the relevant Cacheplane Vercel projects/store and visible LangSmith/Resend resources; see the companion audit. The root-file npm token remains rejected, but the user login now supplies working npm CLI access and verified `b4run` ownership. Squarespace, billing, social/design accounts and resources outside the inspected API scopes still need inspection before scheduling the public switch.

For each confirmed external resource, record: vendor, account/team, owner, resource ID/URL, current label, target label, dependencies, change mechanism, validation evidence, retirement action and status. Store secret **names and vault references only**, never values, in the inventory.

## 4. Workstreams and deliverables

### A. Naming, access and cutover baseline

**Owner:** Product owner + release maintainer. **Depends on:** none.

- [x] Confirm npm organization `b4run` and record the complete `@dawn-ai/*` → `@b4run/*` package mapping.
- [x] Check all 21 proposed package names against public npm metadata; record authenticated-access limitation.
- [ ] Record the selected GitHub owner, first B4.run version and historical archive policy using the approved direction and defaults above.
- [ ] Select current main as the implementation baseline and reconcile in-flight PRs/changesets. The existing local `.gitignore` change and untracked requirements document are unrelated work.
- [ ] Complete the vendor register through owner/admin-console inspection; mark each candidate vendor confirmed, unused, or unresolved.
- [ ] Verify target package/account names and access; establish accounts for immediate project use, not placeholder package squatting.
- [ ] Capture existing DNS/project/repository settings, a source backup, and owned persistent-data backups. Identify each database/storage resource as shared, retained, replaced or retired.
- [ ] Assign named owners for source, releases, site/media, DNS/accounts and final cutover; set the release freeze window.

**Exit:** One agreed naming contract and resource register; no unidentified dependency on an account slated for retirement.

### B. Framework and repository identity

**Owner:** Framework maintainer. **Depends on:** A naming decisions.

**Files:** root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `.changeset/`; every `packages/*/package.json`; `packages/{sdk,core,cli,devkit,testing,inspector,sandbox,workspace,memory,memory-pgvector,postgres-storage,sqlite-storage}/`; `examples/`; `test/`; root contributor docs and agent instructions. Rename `packages/create-dawn-app/` and branded fixtures/filenames.

- [ ] Enumerate package/import names, public exports, binaries, config filenames, env names, error codes, protocol/event metadata, HTTP paths/headers, schema/table prefixes, browser storage keys, log namespaces and generated artifact names.
- [ ] Add focused contract tests for the new interfaces and rejection/non-consumption of the old ones. Cover old config alone, old environment alone, old exports, and old runtime-state directories.
- [ ] Rename all 20 scoped packages plus scaffolder, private workspace identities, internal dependencies, exports and package metadata URLs. Regenerate the lockfile with pnpm.
- [ ] Rename CLI/help/version banners, config loading and typegen, branded API symbols, built-in prompts, error docs, schema names and build emitters. Keep numeric error meanings stable while changing the prefix.
- [ ] Update runtime and Workbench/Inspector routes, UI text, title, storage keys, labels and browser tests. Keep any neutral names unless product branding requires a change.
- [ ] Update scaffold templates, generated app scripts, filenames, gitignore entries, tests and examples. No old-name fallback paths or import shims.
- [ ] Start B4.run with fresh `.b4` state and fresh framework-owned DB namespaces by default. It must not silently discover or import `.dawn`, old checkpoints/memory, or old browser sessions. Preserve backups; any owner-requested data conversion is a separate offline operation, not runtime compatibility.
- [ ] Rebuild from a clean checkout before inspecting `dist`, tarballs or generated apps. Scan source, generated declarations, bundles and package tarballs for missed identity strings.

**Exit:** Fresh users can scaffold, install, typecheck, run, test, build and use the Workbench using only B4.run names. Old interfaces do not resolve through B4.run.

### C. Release automation, repository and registry

**Owner:** Release maintainer. **Depends on:** A, B package map; coordinated with D.

**Files:** `.github/workflows/{ci,version-pr,release,release-postpublication,release-postpublication-audit,published-artifact-verify,publish-chart,dependency-security-receipt,kubernetes-compat,scorecard,claude-review}.yml`; `scripts/release/`; `scripts/lib/published-artifacts.mjs`; `scripts/{published-artifact-smoke,published-artifact-verify,sync-chart-appversion}.mjs`; `scripts/release/test/fixtures/release-script-hashes.json`; `.changeset/config.json`.

- [ ] Create the target repository with workflows and auto-deployment disabled during setup. Import reviewed source history/branch; recreate settings, `validate` protection, environments, apps, labels and selected open work.
- [ ] Record the new numerical repository ID and all exact workflow/signer identities. Update hard-coded repository names and IDs in release, artifact-store, audit, recovery, verification and security evidence code.
- [ ] Separate live release policy from Dawn-specific incident tooling, authorizations and signed receipts. Remove obsolete incident tools from active B4.run workflows; preserve original evidence unchanged in the historical record. Generate new policy/fence/authorization records where required instead of editing old evidence to fit.
- [ ] Recompute the complete workflow-reachable script/data hash inventory, recovery verifier closure, fence contracts and policy hashes through reviewed generation procedures. All reachable scripts are pinned on current main; do not weaken checks to make renaming pass.
- [ ] Configure new npm packages and trusted publishers, including first-publication authentication. Verify the configured owner/repo/workflow/environment and permission for the actual publish operation. Do not copy old registry receipts or treat old version tags as proof of a B4 publication.
- [ ] Rehearse initial publishing against a disposable registry, then a real prerelease under the target scope. Publish dependency packages before consumers and scaffolder; verify the entire 21-package set before promoting its launch dist-tags. Prepare partial-publication recovery without falling back to Dawn packages.
- [ ] Verify npm provenance, GitHub attestations, release tarball hashes, release-controller recovery and independent postpublication checks for the new repository identity.
- [ ] Update chart publish paths/permissions; verify target artifacts are retrievable directly. Keep release credentials scoped to the B4 repository and remove old publishing access at retirement.

**Exit:** An independently verified B4.run prerelease and a rehearsed final release path. Old repository authorization cannot publish or attest a new B4.run release.

npm trusted publisher settings are specific to a package and workflow; changing repo identity requires new settings. Current docs also distinguish stage and direct-publish permissions, so inspect the actual configuration rather than assuming old defaults. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

### D. Deployment resources and runtime infrastructure

**Owner:** Infrastructure maintainer. **Depends on:** A, B; prepare alongside C.

**Files:** `charts/dawn-app/` → `charts/b4-app/`; `charts/dawn-sandbox-infra/` → `charts/b4-sandbox-infra/`; `packages/sandbox/`; `packages/cli/src/lib/build/targets/`; `test/k8s-smoke/`; `test/k8s-compat/`; related CI and deployment docs.

- [ ] Rename chart metadata/templates/helpers, labels/selectors, namespaces, service accounts, RBAC subjects, environment names, pod/container/PVC prefixes, image tags, reaper selectors and smoke fixtures together.
- [ ] Install fresh B4 chart releases and use new resource identities; do not auto-adopt existing Dawn releases or relabel live PVCs implicitly. Verify all selector/RBAC relationships and reaper ownership boundaries.
- [ ] Retain the existing Vercel docs project under its new `b4-run` name and prepare the native preview-test project; update Git connections, build filters, secrets, preview protection and resource cleanup rules.
- [ ] Inventory any actual LangSmith/Cloudflare/database/model-provider resources owned by the framework team. Apply the rename to deployed app labels, origins, callbacks, allowlists, webhooks, monitoring and billing contacts as relevant.
- [ ] Decide per persistent resource whether a label-only change suffices or a new resource is required. Test new resources before retiring old ones, and do not touch unrelated Cacheplane resources.

**Exit:** Node, edge, Vercel and Kubernetes artifacts use B4 identities; real test resources are created and cleaned up correctly.

### E. Website, documentation and marketing assets

**Owner:** Website/brand maintainer. **Depends on:** A naming; final capture depends on B.

**Files:** `README.md`, `docs/brand/`, `docs/marketing/author-persona.md`, `apps/web/app/`, `apps/web/content/`, `apps/web/lib/github-{stars,contributors}.ts`, `apps/web/public/brand/`, `apps/web/public/social/`, `apps/web/public/demo/`, favicon files and `site.webmanifest`; `docs/brand/demo/`; `apps/web/app/lib/demo-media.json`; `scripts/check-docs.mjs`; package README/docs/SKILL files.

- [ ] Produce a B4.run brand specification: wordmark, compact mark, clearspace/minimum size, light/dark versions, colors/type and accessibility. Review a concrete asset sheet before generating final exports.
- [ ] Replace logo SVG/PNG files, social avatar, favicon sizes, Apple/Android icons, web manifest, brand asset JSON and downloadable ZIP including filenames and embedded metadata. Inspect the ZIP contents, not just its name.
- [ ] Update all landing pages, navigation/footer, install snippets, README badges, package docs, contributor/security/community text, blueprints, agent-facing templates and maintained marketing copy.
- [ ] Update canonical URLs, metadataBase, Open Graph/Twitter image text and inline logo paths, blog OG images, JSON-LD where present, sitemap, robots, RSS, `llms.txt`, `llms-full.txt`, markdown APIs, copy/open-in-AI actions and GitHub star/contributor source.
- [ ] Decide each old branded blog/page slug: publish an honestly updated B4 version at a new path, or retire it. Do not add route aliases, compatibility anchors or redirects to preserve retired Dawn URLs. Keep historical quotations accurate; move Dawn-only historical announcements out of the active B4 site if they cannot be truthfully updated.
- [ ] Re-record the product loop and author/test/run clips against the renamed scaffold/Workbench: eight MP4/WebM outputs, posters, GIF, captions and transcripts. Rename capture paths and media environment names; update exact Blob authorization and catalog together.
- [ ] Run `pnpm test:brand-demo`, `pnpm media:readme:check`, and `pnpm media:readme:upload -- --dry-run` against regenerated local media before any approved upload. Validate remote playback and catalog after upload during implementation.
- [ ] Inventory and prepare external profile changes: GitHub/npm, social headers/avatars/bios, community descriptions/invites, developer directories, search listings, newsletter templates, presentations, design libraries and email signatures. Assign an owner to every off-repo asset; prepare launch copy but do not send announcements during planning.

**Exit:** The website and downloadable/embedded media all show B4.run, including pixels, spoken words, terminal commands, metadata and links.

### F. Domains, email and discoverability

**Owner:** Domain/account owner. **Depends on:** validated C–E.

- [ ] Export full old/new DNS zones with TTLs; inspect A/AAAA/CNAME, wildcard records, TXT ownership verification, CAA, DNSSEC, MX/SPF/DKIM/DMARC, delegated subdomains and domain forwarding.
- [ ] Add `b4.run` to the prepared Vercel project and verify ownership/certificate readiness using the project's current DNS instructions. Use Vercel DNS as directed by the user; no registrar transfer is necessary for the rename.
- [ ] Serve directly at the apex. Do not accept an automatic `www` forwarding rule. Retire the existing Squarespace parking/`www` setup; the proposed endpoint set exposes only the apex unless a new subdomain has a specific purpose.
- [ ] If email exists or is being introduced, provision the agreed B4 mailboxes/senders and verification records, update vendor recovery/billing contacts and test delivery. Do not add forwarding from Dawn addresses. No MX records were observed, so email setup is conditional on the account audit.
- [ ] Verify Search Console/Bing and any installed analytics under the new origin; submit the new sitemap. Expect fresh indexing and broken historical inbound links because redirects are intentionally excluded. Update owned links and listings directly.
- [ ] Retire every old website/subdomain/preview alias and old branded asset endpoint according to the resource register. Old URLs must terminate without a B4 `Location` header, meta refresh or JavaScript redirect. Remove DNS records that would dangle after a vendor resource is removed.
- [ ] Retain ownership of old domains and account names; disable active services and forwarding. Domain retention does not imply serving the old application.

Vercel can introduce domain redirects during setup; inspect both project settings and source rules. See [Vercel domain behavior](https://vercel.com/docs/domains/working-with-domains/deploying-and-redirecting) and [removing a project domain](https://vercel.com/docs/domains/working-with-domains/remove-a-domain).

## 5. Validation and cutover runbook

### Preflight acceptance

- [ ] Fresh `pnpm install --frozen-lockfile` and `pnpm ci:validate` pass against the selected implementation commit. Current-main validation includes release-integrity, source, release-controller, pack and harness gates; also satisfy the changeset check.
- [ ] Because this change touches release identity and deployment resources, run the real `vercel-native` and `copilotkit-examples-e2e` jobs, plus affected Docker/Postgres/pgvector/edge/Inspector/Kubernetes/chart lanes. Required coverage comes from the final baseline's AGENTS.md/CI, not the stale checkout.
- [ ] Install all published B4 packages from the registry outside the monorepo. Exercise basic and research scaffolds, npm/pnpm documented commands, typegen, runtime, Workbench, tests, Node/edge builds and storage without resolving any Dawn package.
- [ ] Compile-time import checks reject old branded exports; runtime fixtures prove old config/env/state names are not consumed. Negative tests containing old strings are narrowly allowlisted.
- [ ] Scan tracked contents **and filenames**, generated output, package manifests/tarballs, emitted deployment artifacts and media/ZIP contents. Add a dedicated stale-brand gate with explicit, reasoned exceptions for the migration document, negative tests and required legal/history records; no broad exclusion of active docs or packages.
- [ ] Crawl the B4 preview: links, canonical/OG/RSS/LLM endpoints, downloads, light/dark layouts, mobile layouts, fonts/images, captions/transcripts and video playback. Recheck renamed blog slugs and provider marks.
- [ ] Verify the repository/registry signer identity and every release policy/pin. A new repo must reject Dawn provenance as authorization for a B4 release.
- [ ] Complete every external resource row with owner and receipt; no unverified production dependency may be silently assumed unused.

Useful baseline inventory commands, run from repository root:

```sh
git rev-parse HEAD
git grep -n -i dawn -- . ':!pnpm-lock.yaml'
git ls-files '*dawn*' '*Dawn*' '*DAWN*'
pnpm -r list --depth -1
pnpm ci:validate
node scripts/check-changesets.mjs
```

The generic grep is an inventory aid; after migration the reviewed stale-brand gate must distinguish explicit exceptions from active remnants. Generated artifacts need their own scan because `git grep` excludes them.

### Coordinated public cutover

1. **Freeze and checkpoint.** Stop source/release changes; pin commit, package versions, artifact hashes and DNS/settings exports. Drain or explicitly resolve pending Dawn release-controller operations before disabling them.
2. **Prepare the public identities.** Ensure the new GitHub repository, required apps, package scope, publishers and infrastructure are ready; release permissions and branch protection are verified. Keep production deployment/publishing gated until preflight passes.
3. **Publish B4.run.** Release the complete package set and charts, verify signed artifacts and clean installs, then promote launch tags. Do not announce while the set is partially published.
4. **Publish the site and assets.** Deploy the verified B4 site/media and point `b4.run` at it. Check certificate, apex response, docs/install flows and external asset playback from an independent client.
5. **Retire Dawn.** Remove old project/domain bindings and forwarding; retire/protect old Vercel deployment URLs; disable old Actions publishing/deployment, npm trusted publishers and chart automation. Archive the old repository and apply the agreed old-package retirement policy. Probe every known old URL without following redirects.
6. **Update external profiles and announce.** Apply the reviewed account/profile/listing changes and send approved launch announcements. Supply new install/repository URLs directly; do not link users through old domains.
7. **Close the register.** Verify DNS after its prior TTL expires, site errors, registry install/provenance, media, email if configured, search submissions, billing ownership and absence of old publishing jobs. Record results at cutover, the next day and one week later.

No historical compatibility window is planned. DNS propagation can leave cached old answers temporarily; old infrastructure must already return a terminal response during that interval, not forward visitors or resume serving Dawn. The final owner action is approval of the concrete tested release/site/resource-change packet, not approval to begin preparing it.

### Failure handling

Before the public switch, hold launch until failed checks are resolved. After switching, fix forward or roll back to a previously validated **B4.run** artifact; do not restore the Dawn domain/app/aliases. If no valid B4 artifact exists, use a temporary B4 maintenance response. Published npm versions and signed evidence are immutable: recover partial releases through the existing verified controller or a new version as appropriate, never by editing published tarballs.

Old npm publication cannot be assumed deletable. Default to cessation and an explicit retirement/deprecation notice, with no dependency wrapper or replacement executable. If complete removal is requested, check eligibility separately; [npm's unpublish policy](https://docs.npmjs.com/policies/unpublish/) restricts deletion and reuse of published versions.

## 6. Delivery sequencing and remaining decisions

Suggested review units on an integration branch: **(1)** naming + complete inventory, **(2)** package/CLI/runtime/scaffold rename, **(3)** release identities and infrastructure, **(4)** site/docs/brand/media, **(5)** validation and cutover receipts. Keep mixed-brand intermediate work from triggering production or npm publication. Code and brand preparation can proceed independently after the naming contract; final demo capture and public cutover are sequential.

Planning allowance: roughly **8–15 engineering days plus brand production and account-owner turnaround**, based on the breadth of current source and release-policy coupling, not a delivery commitment. Refine after the account audit and first mechanical rename diff. Scope ownership/bootstrap and release-policy regeneration are the critical path; source replacement alone is not.

Execution prerequisites and defaults:

1. **Naming confirmed:** npm organization `b4run`, scope `@b4run/*`. Retain the plan's other defaults: `b4`, `create-b4-app`, `.b4`, and `b4.config.ts`.
2. **Account access:** npm CLI ownership is verified. Verify unscoped scaffolder ownership and configure package publishers. The target repository is now `cacheplane/b4-run`, numerical ID `1360603908`; configure new release trust against that identity.
3. **Release baseline:** select the actual unused pre-1.0 version at freeze time and apply the archived-history treatment described above.
4. **Vendor completeness:** identify account owners and off-repo services/assets missing from the register; choose actual cutover date once preflight is green.

The plan is complete as a proposed migration program. The vendor register remains an explicit execution prerequisite; this read-only audit does not certify that every vendor account has been inspected.
