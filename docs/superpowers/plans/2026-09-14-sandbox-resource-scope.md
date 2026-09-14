# Required Sandbox Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Inline execution is the user's established preference; delegate independent review only.

**Goal:** Require explicit application scope and collision-resistant resource addressing in both reference providers.

**Architecture:** Both factories require `scope: string`, validate it synchronously, and derive resource names through one internal SHA-256 helper. Logical thread identity and provider lifecycle behavior remain unchanged. No legacy naming path survives.

**Tech Stack:** TypeScript, Node crypto, Vitest, pnpm, Docker/Kubernetes provider fakes and gated integration tests.

---

### Task 1: Contract and red tests

- [x] Add `packages/sandbox/test/resource-scope.test.ts`: factories reject missing/invalid scope before I/O; distinct scopes and normalization-colliding thread IDs create distinct resources; logical IDs survive; fresh provider reattachment and deletion isolation work using the Kubernetes fake.
- [x] Add independent fixed-vector assertions for both provider resource names and process-restart stability. Load the actual scope helper in a fresh Node process, with an independently calculated literal vector as the oracle.
- [x] Run `pnpm --filter @b4run/sandbox exec vitest run test/resource-scope.test.ts`; confirm failures from ignored/missing scope.

### Task 2: Shared identity and provider integration

- [x] Create `packages/sandbox/src/resource-scope.ts`. Validate `typeof scope === "string" && scope.trim().length > 0`, else throw TypeError. Return a closure mapping thread ID to `createHash("sha256").update(JSON.stringify(["b4-sandbox-scope-v1", scope, threadId])).digest("hex").slice(0, 40)`.
- [x] Modify `packages/sandbox/src/docker/docker-sandbox.ts` and `packages/sandbox/src/kubernetes/kube-sandbox.ts`: required documented option, validate before constructing clients; replace global sanitizer/name functions with factory-local names using the shared closure, including labels, network selectors and Docker PID recovery. Preserve original thread IDs in handles and lifecycle maps.
- [x] Update existing sandbox tests to supply scope and assert hashed names. Replace sanitizer tests with collision coverage, keeping unrelated policy and recovery assertions intact.
- [x] Extend real Docker/Kubernetes integration tests with two scopes sharing a thread, fresh-provider reattachment, retained edits, and destruction isolation, with finally cleanup.
- [x] Run sandbox tests and package typecheck after full build.

### Task 3: Repository consumers and documentation

- [x] Update active calls in examples/research, examples/code-fixer, packages/devkit/templates/app-research, test/k8s-smoke, package tests, scripts/published-artifact-smoke.mjs and related release smoke fixtures. Use stable explicit scopes; the research example/template requires an installation-specific environment value when optional Docker mode is enabled, while its Docker test supplies a disposable value; code-fixer parent cleanup and child execution must use the same scope. Preserve historical homepage evidence and changelogs.
- [x] Update sandbox README, docs overview/API/Kubernetes, configuration/access-control examples, and chart usage snippets. Explain required scope, intentional storage cutover, and authorization/concurrency limits. Remove current sanitizer claims.
- [x] Add patch changeset with explicit breaking-change note under repository 0.x policy. Update generated documentation metadata using existing script.
- [x] If the published smoke script is content-pinned, regenerate its reviewed pin and digest via the existing release procedure and run release integrity plus workflow-contract tests. Do not weaken pin enforcement.

### Task 4: Verification and review

- [ ] Run scoped Biome, `pnpm build`, typecheck, sandbox tests, relevant consumer/release tests, docs checks and changeset validation. Run full `pnpm ci:validate` before merge; report unavailable Docker/Kubernetes infrastructure explicitly.
- [x] Request independent review of the final diff; resolve substantive findings and rerun affected checks.
- [ ] Show the new public API and remaining library work to the user before creating a PR, as previously requested. Keep changes local until that walkthrough.

## Verification record

- Red: all eight initial scope tests failed against the old providers; two scopes
  overwrote the same retained workspace. The corrected tests pass.
- Provider suite: 203 passed, 25 gated tests skipped in ordinary execution.
- Real Docker: scoped restart/edit retention/destruction-isolation test passed.
- Kubernetes: no configured cluster locally; gated coverage added, not executed.
- Devkit: 47 tests passed, including example/template parity after scope config fix.
- Research Docker: actual example harness test passed with its disposable scope;
  direct config loads rejected missing installation scope and accepted an explicit value.
- Full build: 26 tasks passed. Repository typecheck: 53 tasks and root tests passed.
- Release integrity: 33 passed; workflow contracts: 165 passed; published Docker
  smoke/cleanup regression tests: 14 passed. Independent reviewer verified both
  changed script hashes and the pin fixture digest.
- Independent review: approved after fixing scaffold shared scope and stale overview.
- Full `pnpm ci:validate`: in progress; final status recorded before delivery.
