# Agent Protocol Documentation and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualify the complete candidate and perform one controlled package/site/app cutover with preserved data.

**Architecture:** Reviewable integration branches produce immutable packed candidates and a cross-repo evidence manifest. Existing release ownership publishes the fixed group; a production-only site hold prevents docs getting ahead of packages. Hub/client activation and project upgrades use explicit postqualification checkpoints.

**Tech Stack:** pnpm/Turbo, existing release controller and package smoke tools, Swift/Xcode/Rust gates, Vercel website previews, Helm, GitHub release tooling.

---

**Spec:** approved coordinated design sections 5–9 and all linked specs.
**Dependencies:** documentation inventory/hold can prepare after P0; final qualification requires C/R/B/S/A component exits. This plan is not an instruction to publish now. Before any actual external publication/promotion/production change, present the exact candidate and evidence for the user's final release instruction.

## Critical current documentation files

Modify `apps/web/content/docs/dev-server/agent-protocol.mdx`, `ag-ui.mdx`,
`api/ag-ui.mdx`, `api/core.mdx`, `api/sdk.mdx`, `api/sqlite-storage.mdx`,
`api/postgres-storage.mdx`, `api/workspace.mdx`, `access-control.mdx`,
`permissions.mdx`, `memory.mdx`, `configuration.mdx`, `upgrading.mdx`,
`deployment.mdx`, `deployment/{node,vercel,edge,kubernetes,langsmith}.mdx`,
`recipes/navlog.mdx`; include additional live consumers found by the P0 inventory.

Update `apps/web/content/templates/AGENTS.md`, `apps/web/app/llms.txt/route.ts`,
`llms-full.txt/route.ts`, `app/components/docs/nav.ts`,
`app/components/homepage/checklist/checklist.ts`,
`app/components/homepage/gates/gate-sources.json`, `app/seo/registry.ts` and the
generated `app/seo/lastmod.generated.json` where affected. CLI bundled docs are
generated, not separately authored. Preserve `/app/`, association/pairing/download
surfaces and historical release/verification evidence.

### L1: Audit current guidance and publish the coherent reference

**Files:** Critical documentation files above, relevant package/example/scaffold READMEs and blueprints; new `docs/superpowers/runbooks/2026-11-05-agent-protocol-cutover.md` draft.

- [ ] Generate current-reference inventory using `rg` for retired paths/body fields/events and compare the approved audit list. Classify each result as live consumer/current guidance/negative test/historical evidence, not an automatic global replacement.
- [ ] Update current reference to exact approved resource schemas/defaults/native binding/extensions/host limits and runtime recovery/privacy rules. Remove current/unreleased promises about old turns/events routes. Keep upstream version pins/correction overlay explicit.
- [ ] Add the breaking upgrade entry with exact-pin workflow, independent client/hub versions, fresh storage and preserved old history. Describe no migration/wipe/alias that does not exist. Update existing dated-post version notes only where old runnable guidance could mislead; preserve bodies/code/publication dates and old changelogs/decisions.
- [ ] Build packages/CLI through `pnpm build` to regenerate bundled docs. Run `node scripts/check-docs.mjs` and existing llms/native documentation tests; expect no unsupported claim, stale current route or malformed generated bundle.
- [ ] Commit authored content first, then run `pnpm --dir apps/web seo:lastmod` and commit the generated manifest as the contributor rules require. Run `pnpm --dir apps/web seo:lastmod:check` and `pnpm --dir apps/web seo:lastmod:routes`; P0 records any verified command drift.
- [ ] Record rendered preview/link checks and commit `docs: describe the coordinated Agent Protocol release`. Do not promote production here.

### L2: Pin packed consumers and cross-repo candidate manifest

**Files:** Create `test/agent-protocol/qualify.ts`, `candidate-schema.json`, `test/agent-protocol/qualification.test.ts`; create `test/agent-protocol/vitest.config.ts`; modify `vitest.workspace.ts`, root `package.json` with `verify:agent-protocol`, existing pack/smoke contracts as needed; update exact-version scaffold manifest emission in devkit/create-b4-app.

- [ ] Write tests rejecting incomplete/mixed-version inventories, stale source/corpus hashes, missing mandatory evidence and a fixture result mislabeled live. Require actual collected test counts/skips and backend/host/profile identity.
- [ ] Run `pnpm exec vitest run --config test/agent-protocol/vitest.config.ts test/agent-protocol/qualification.test.ts` and add that project to `vitest.workspace.ts` (already consumed by scripts/test.mjs); verify it fails on an incomplete candidate rather than silently collecting no tests.
- [ ] Implement a manifest with B4/b4app source SHAs, contract hashes, all 21 package names/versions/tarball checksums, app build/profile/schema minimums, preview identity, per-gate status/evidence and installed project pins. Do not invent a version from the audit baseline.
- [ ] Build/pack the complete candidate and install via the existing isolated loopback-registry consumer mechanism in dependency order. Reuse tooling without invoking the production publisher from a branch or pointing a test registry at npm. Verify no mixed old SDK/storage dependencies and all new exports/assets load from tarballs.
- [ ] Run `pnpm pack:check`, `pnpm verify:typescript-tooling-pack` and generated app/native/Store/generic consumer checks. b4app A10 consumes these exact artifacts; later final candidate changes invalidate affected evidence.
- [ ] Commit `test: qualify immutable protocol consumer candidates`. Keep candidate results outside source except reviewed evidence records; no real secret or raw grant enters the manifest.

### L3: Add and prove the production website hold

**Files:** Modify `apps/web/scripts/vercel-ignore-build.sh` and the existing `apps/web/app/vercel-ignore-build.test.ts` suite; preserve existing factory/* denial and preview behavior. Draft exact operator steps in the cutover runbook.

- [ ] Add script tests: production plus B4_PROTOCOL_RELEASE_HOLD=1 exits 0 (skip); production without hold exits 1 (build); preview unaffected; factory guard remains first and always denies builds. Run `pnpm --filter @b4run/web test vercel-ignore-build` and verify expected failures before implementation. P0 confirmed this existing Vitest suite owns the shell-script regressions; extend it rather than create a second test stack.
- [ ] Add the production-only hold check before the unconditional production-build branch. No universal CI serialization or disabling unrelated release workflows. Default absent hold preserves existing behavior.
- [ ] Run script tests and workflow/shell/docs checks. Review this infrastructure-only change independently if it must reach main ahead of the integration cutover; it changes no public API.
- [ ] At the future release preflight, inspect actual Vercel project's ignored-build command and production settings. Set only the named production hold through reviewed operator tooling, preserving preview environment. Capture redacted setting/skip evidence and verify a new main candidate cannot promote unreviewed docs.
- [ ] Specify and verify the provider's current exact deployment promotion command/UI on the release day against primary docs/tool help; record the selected deployment ID/commit and rollback/hold state. Never guess a CLI flag or promote latest-main by accident.
- [ ] Commit `ci: hold protocol documentation production promotion` and keep the actual external setting action behind the final release checkpoint. Code tests alone do not prove the live hold is configured.

### L4: Run the release acceptance matrix on exact candidates

**Files:** Update actual affected `.github/workflows/ci.yml` test lists where old endpoint suites were renamed; create a dated qualification report via existing docs conventions; run existing scripts rather than introduce a new release owner.

- [ ] Run current `pnpm ci:validate` plus CI-only dependency-security-browser, Changesets, required CopilotKit examples and real Vercel native lanes. Preserve every required gate and release content pin; new failure-path tests must be collected by the root/package runners.
- [ ] Run full Node REST/ASP SSE/commands/WebSocket/native SSE/protobuf/Store suites. Count 27+6 routes and removed-path assertions; prove actual default/authority/input/receipt behavior and no second native terminal.
- [ ] Run SQLite crash/exclusive-owner, actual Postgres two-process lease/fence/control/replay/resume and actual applicable memory backend race suites with required env gates. Record each backend and exact failure boundary, not an environment-gated skip as success.
- [ ] Run bounded replay/history/observer/load cases, retention and preserved-data fixtures, workspace inspection/staging, affected sandbox/provider and chart render/apply/probe/shutdown tests. Additional host claims need deployed evidence; honest unadvertised optional profiles can be not-applicable with a precise reason.
- [ ] Run matching b4app Swift/Rust/build tests and A10's target-Mac/authenticated-remote/physical-phone checks. Keep fixtures/build/simulator/live distinctions and existing app acceptance rows. Missing mandatory access/infrastructure leaves the matrix blocked.
- [ ] Verify no source/package/corpus/host changes after qualification; rerun affected gates for fixes and all required final CI. Commit honest evidence only, with any failed/blocked status intact. Do not proceed to publication with open mandatory prepublish gates.

### L5: Prepare exact versions and the operational runbook

**Files:** New cutover runbook; package Changesets/version output and chart appVersion synchronization; b4app compatibility/version files through its existing process; final candidate manifest/evidence.

- [ ] Observe current registry/controller state and select the next unused 0.x fixed-group patch. Verify all 21 packages match, exact template/project pins and lockfiles, no unreviewed minor→1.0 transition, and independent app/hub/chart versions/minimums.
- [ ] Prepare the normal reviewed Version Packages PR and candidate identities. Review changes since packed tests, rebuild/retest actual merged/versioned artifacts as needed and require main-reachable/tag-exact controller evidence. Do not hand-publish next/latest tarballs to avoid that process.
- [ ] Inventory the projects/deployments deliberately upgraded: source/package pins, owner processes/replicas, old/new storage locations, backups, workspace/sandbox ownership and exact readiness checks. Include live-check; do not implicitly upgrade every attached user repository.
- [ ] Write quiesce/backup/old-owner drain and real unwind/fresh namespace steps using actual paths. SQLite backup is WAL-aware/consistent; b4app migration backup is quiesced; old memory/config/secrets/shared sources are preserved. Explicit cleanup remains separate.
- [ ] Prepare matching signed/notarized Mac artifact and available phone build, staged hub schema/protocol support and reviewed website deployment. Record that protocol-2 production activation waits for matching clients and fences old pulls/links; historical local read-only treatment does not prove old server work stopped.
- [ ] Present the concrete candidate, gate evidence, promotion hold and step-by-step external actions for the user's final release instruction. Do not perform those actions merely because the design/plan was approved.

### L6: Execute the authorized ordered release and verify boundaries

**Files:** Operational candidate/evidence/runbook records; existing release scripts/workflows, b4app `Scripts/release-mac.sh` and normal hub/chart pipeline. Do not create a parallel publisher.

- [ ] After the final release instruction, integrate only the approved completed candidates and use the existing controller/version PR path. Follow its current observed transition commands/runbook; preserve exact tags, inventory, integrity/provenance and postpublication audit. Stop on ambiguous/partial publication.
- [ ] Verify actual registry tarballs/install behavior from the final public version and recheck matching app compatibility. These checks happen after artifacts exist; they block dependent promotion if they fail.
- [ ] Publish the matching app using its existing signed/notarized prod/beta process and Homebrew tap PR as approved. Stage required hub schema/client-protocol support first; activate minimum v2 only with matching Mac/phone availability and the tested HTTP/open-connection fences.
- [ ] Promote the exact reviewed website deployment after published B4 verification, remove/restore the hold deliberately and verify current API/docs/version labels plus app/download/association/pairing routes. Do not advertise an unavailable app build.
- [ ] Cut over explicitly selected projects/runtime replicas after old-owner drain and preserved-data checks; create new protocol profiles/threads. Verify local/remote/native/Store/phone flows on the actual released combination, recording what was truly upgraded.
- [ ] Complete all required postpublication/controller/site/app-install checks and commit the final gate record. On failure hold dependent promotion and record forward-fix/controller-recovery decision; never republish different bytes, erase released versions or silently downgrade new history to old storage.

## Completion boundary

The release is complete only when mandatory pre- and postpublication evidence
matches actual public artifacts/deployments and performed project cutovers.
Retained old data and unknown outcomes remain preserved. No claim of upstream
certification, universal peers or dedicated LangSmith integration is introduced.
