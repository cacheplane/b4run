# B4.run source identity implementation checklist

> For execution, use the approved B4.run migration program and focused regression tests. Run commands at this worktree's root using pnpm 10.33.0. This branch starts from `2a4ffd99`; the old planning worktree contains unrelated edits and must not be reset or merged wholesale.

**Goal:** Make the framework's source, generated apps and developer interfaces use the B4.run naming contract, with no compatibility aliases. Publishing remains gated until the separate release-trust and brand/media workstreams are verified.

## Completed preparation

- [x] Create isolated `blove/b4-run-rename` branch/worktree from current main.
- [x] Install with the pinned package manager and frozen lockfile.
- [x] Build baseline successfully (25 tasks) and verify 33 release-integrity tests.
- [x] Verify npm CLI owner membership of `b4run`.
- [x] Rename the existing Vercel docs project to `b4-run` by its stable ID.
- [x] Create `cacheplane/b4run` (ID `1210070282`) with Actions disabled.

## Source changes

- [x] Run new `packages/core/test/b4-config-contract.test.ts` and `packages/cli/test/b4-state-contract.test.ts` against old code; verify expected assertion failures. Preserve their literal old-name negative cases during replacements.
- [x] Map `@dawn-ai/*` → `@b4run/*`, private examples → `@b4-example/*`, scaffolder → `create-b4-app`, root package → `b4-run` and package metadata → `cacheplane/b4run`/`b4.run`.
- [x] Rename branded source identifiers (`DawnConfig` → `B4Config`, `loadDawnConfig` → `loadB4Config`, `dawnDir` → `b4Dir`, `DAWN_*` → `B4_*`), config/typegen/state filenames and machine namespaces. Preserve neutral/vendor-defined contracts.
- [x] Rename CLI executable/help text and generated scaffold scripts, imports, config filenames, defaults and ambient declarations. Rename `packages/create-dawn-app` → `packages/create-b4-app` and all relevant tracked fixture paths.
- [x] Update consumers across examples, test harnesses, Inspector/Workbench and build targets together. Read new `.b4` state only; never import old `.dawn` state implicitly.
- [x] Update maintained docs, package docs, templates, website text/metadata and charts that must match the developer surface. Preserve historical release records and signed evidence as historical evidence; do not transform them into authority for the new repository.
- [x] Regenerate the lockfile with pinned pnpm and rebuild all consumers before exercising emitted output. Re-run the new contracts to green.

## Validation and review

- [x] Run relevant core/CLI tests, lint and typecheck. Confirm new generated apps use no old package names or config/state paths.
- [x] Classify all remaining Dawn strings and file paths: pending brand/media work, authentic history/attribution, explicit negative tests, or defects. Do not hide live-code remnants with a broad allowlist.
- [x] Reconcile release scripts, workflow fixtures, signer/repository IDs and content pins as a separately reviewed change. No publication or automatic deployment from intermediate commits.
- [x] Run full `pnpm ci:validate` plus required affected deployment lanes before declaring the migration release-ready. Record unavailable live checks and actual failures distinctly. **Complete:** `pnpm ci:validate` passes end to end (exit 0) on the merged branch, and the live `vercel-native` lane passes 300 of 300 with a closed cleanup receipt. Both Helm charts and all live OpenAI provider checks pass. The Kubernetes and Docker cluster lanes remain gated on infrastructure that is not available locally.
- [x] Obtain spec-compliance and code-quality reviews; fix substantive findings before integrating.

## Remaining external work

Preserve the existing Vercel docs project and B4 domain binding. Rebind its Git connection only after the target repository has verified source. Recheck DNS delegation/propagation. Configure npm package publishers against the new repository ID/workflow; finish branding and media regeneration before public cutover. Remove old domains and release permissions at that cutover without forwarding or compatibility wrappers.
