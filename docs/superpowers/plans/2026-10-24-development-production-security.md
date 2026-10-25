# Development and production dependency security plan

> **For agentic workers:** Execute the reviewed plan task by task using the executing-plans workflow; request independent review before integration.

**Goal:** Remove all remaining high/critical development findings and moderate-or-higher production findings, without suppressions or weakening verification.

**Architecture:** Upgrade the smallest affected dependency closure on current main. Prefer compatible owner ranges and lock refreshes; use bounded root policies only for upstream exact pins that still require affected versions. Preserve published package versions and the reviewed TypeScript implementation. Verify the actual owners, including development deployment tools and private CopilotKit examples, rather than treating a clean audit as compatibility proof.

**Tech stack:** pnpm 10.33, Node 24, Vitest 4, Vite 8/6, Vercel, Wrangler/Miniflare, Verdaccio, CopilotKit.

## Baseline and scope

Main: `014918499a9093852f045d3a477cf77dd53ac8d8`. Full audit: 26 high,
45 moderate, 13 low, zero critical. Production: 12 moderate, three low,
zero high/critical. Raw reports are retained under
`/private/tmp/b4run-security-followup-baseline-{full,production}.json`.
User changes in the original checkout must remain untouched.

| Dependency | Intended supported target | Required owner qualification |
| --- | --- | --- |
| minimatch 10 | 10.2.6 | Vercel pattern discovery |
| Undici 5 | 6.29.1 | Both installed Vercel transports: fetch, streaming, multipart, errors; qualify WebSocket handshake/fragment/compression exposure with real regressions or source-backed absence; native Vercel CI |
| @fastify/busboy 2 | Eliminate through patched Undici owner; retain 3.2.2 | Verify no 2.x identity remains and multipart prototype-named headers are handled by the installed remaining owner |
| path-to-regexp 8 | 8.4.2 | Vercel route matching |
| sharp 0.35 | 0.35.5 | Real SVG and AVIF/HEIF transforms through root and Miniflare owners, covering librsvg/libheif |
| smol-toml 1 | 1.9.1 | Vercel config parsing |
| brace-expansion 1/2/5 | 1.1.21 / 2.1.7 / 5.0.12 | Glob owner compatibility; hostile nesting without process termination |
| grpc-js 1.14 | 1.14.6 | Testcontainers/Docker compatibility; no claim of real certificate-authentication qualification |
| Ajv 8 | 8.20.0 | Align the adjacent Vercel static-config development moderate with the supported 8.x API already installed; native Vercel CI |
| http-cache-semantics 4 | 4.3.0 | Read upstream dispute/source; verify legitimate private/no-cache/proxy-revalidate boundaries through installed Verdaccio cache owner |
| compression 1 | 1.8.2 | Verdaccio HTTP lifecycle and registry fault/recovery lanes |
| Vite 8.3 | 8.3.5 | Angular and browser suites; preserve Vite 6.4.4 |
| qs 6 | 6.16.1 | Express/CopilotKit parsing and adversarial parser cases |
| ip-address 10 | 10.7.5 | IPv6 classification, family isolation and bounded malformed input |
| fast-copy 3 | 3.1.0 | Actual pino-pretty copy owner and deep values |
| fast-uri 3 | 3.1.9 | AJV owner URI handling and spoofing cases |
| Vitest/UI/mocker 4 | 4.1.12 | Production path: private CopilotKit runtime → channels-core → Vitest → mocker. Update owned manifests and exact transitive pin together; qualify registration/redirect boundaries, source, Angular and browser suites |

The cache advisory lists no patched version and is disputed by the maintainer.
Do not describe an audit-range exit as proof of a security fix. Inspect current
upstream behavior, verify the application's actual exposure, and retain the
qualification and remaining limits explicitly. Do not remove required features
or rename a vulnerable dependency to make the audit pass.

## Tasks

- [x] Capture fresh audits, exact affected paths, official advisory and registry metadata; review the smallest compatible updates.
- [x] Run the existing dependency graph and owner baseline tests.
- [x] Extend `test/security-dependencies/dependency-resolution.test.ts` with patched floors covering every affected major (including Undici 5 and Busboy 2) and observe its failure against the old lock.
- [x] Add focused real-owner compatibility/security cases in `test/security-dependencies/owner-compatibility.test.ts` or a dedicated test file discovered by the existing security config. Use isolated processes for hostile inputs when a vulnerable dependency can crash or hang.
- [x] Update root/workspace development manifests and `pnpm-lock.yaml` in bounded groups. Refresh compatible transitive versions; add documented bounded overrides only when exact upstream pins prevent remediation. Keep all runtime/public package versions unchanged.
- [x] Compare old/new package identities and owner edges; reject unrelated lock drift, especially the TypeScript wrapper implementation. Synchronize standalone fixture locks only if their manifests or affected graph require it.
- [x] Run `pnpm install --frozen-lockfile`, fresh full/production audits, and all focused graph/owner regressions. Require zero high/critical in the full graph and zero moderate/high/critical in production.
- [ ] Run lint, build-cache, complete build, typecheck, source tests, release inventory, complete controller/integrity, docs, pack, TypeScript tooling pack, harness self-test/framework/runtime/smoke. Use concrete package-manager tools for isolated release harnesses as qualified in the preceding release record; retain every failed run and investigate before changes.
- [ ] Run browser/CopilotKit/Angular verification and affected native Vercel, Docker, Kubernetes and storage lanes in hosted CI. Preserve assertions, timeouts, release pins and workflow authority.
- [ ] Record exact advisory paths, targets, override removal conditions, audit counts/digests, compatibility limits and verification evidence in `docs/superpowers/runbooks/2026-10-24-development-production-security.md`. Keep historical release evidence intact.
- [ ] Obtain independent code/dependency review, create and attach the PR, wait for required exact-head CI, and merge the approved exact head. Confirm final main CI and any automatic release observation are successful; refresh audits and deployment health for affected applications.

## Commands and success criteria

Run commands from the worktree repository root. Focused baseline/red/green:
`pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts test/security-dependencies/owner-compatibility.test.ts`.
New focused files must be included in that configuration's discovery.
Audit commands: `pnpm audit --json` and `pnpm audit --prod --json` (remaining low
or out-of-scope development moderate findings may produce exit 1; inspect JSON).
Final regression command: `pnpm ci:validate`, or retain the equivalent individual
lane evidence plus the complete required hosted CI result. Do not claim the full
local aggregate passed if only individual or hosted lanes were run.

Changes to published runtime dependency declarations require a patch changeset
under the repository's fixed-group convention. Development-only manifests and
private example/root resolution policies do not by themselves require a new
package release; the existing changeset check decides and must remain intact.
