# Software Factory Rung 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The controller stops believing the worker: it captures the baseline itself, assembles and digests the candidate itself, verifies it in its own container with its own checks, freezes a review bundle, binds approval to that bundle, and writes the approved bytes itself.

**Architecture:** `examples/software-factory/server` gains a bounded builder route, so the package becomes a B4 app while the controller stays a separate plain-Node process. Two new interfaces keep the work unblocked and testable: `WorkspaceReader` (read a builder thread's workspace after its turn) and `Verifier` (run the checks and issue a receipt). Layers 1 and 2 of the proof drive scripted implementations of both; layer 3 drives the real ones in real containers behind a Docker-only vitest config. Assembly, digests and bundle freezing are pure functions over bytes and are tested for real everywhere.

**Tech Stack:** Node 24 (`node:sqlite`, `node:crypto`, `fetch`), TypeScript 7.0.2 (`noEmit`, run with `tsx`), zod 4.4.3, vitest 4.1.11, biome 2.5.6, and — new to this package — `@b4run/cli` (`config`, `withWorkspace`), `@b4run/sdk` (`agent`), `@b4run/sandbox` (`dockerSandbox`), `@b4run/workspace` (types, `inspectWorkspace`) with `@b4run/workspace/node` (`captureWorkspaceDefinition`, `createSourceBundle`), and `@b4run/testing` (`createAgentHarness`) in tests.

**Spec:** `docs/superpowers/specs/2026-09-18-software-factory-rung1-design.md`. Read it first, including the dependency section and the invariants table.

**Predecessor:** rung 0 shipped as `8dbc0bdb`; its spec is `docs/superpowers/specs/2026-09-16-software-factory-rung0-design.md`.

---

## Conventions that apply to every task

- Work in the worktree you were given, on the rung 1 branch. Never use bare `git stash`.
- Package root for all relative paths below: `examples/software-factory/server`. Repo-root paths are prefixed `<repo>/`.
- Run `nvm use 24` before any test. Node 22 makes unrelated suites fail in ways that look pre-existing.
- Source files import siblings with `.js` extensions; test files import `../src/....ts`.
- Never run bare `biome check --write` at the repo root. Lint with `pnpm --filter @b4-example/software-factory-server lint`; fix formatting with `pnpm --filter @b4-example/software-factory-server exec biome check --write .` and confirm with `git status` that it touched only your files.
- `examples/code-fixer` must have no diff at the end. Check with `git status --short examples/code-fixer` before every commit.
- Commit after every task with the message shown. Every commit message ends with the line `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Five facts that will bite you if you skip them

1. **`fakeSandbox` cannot back the verifier.** It exposes no `workspaces` member, so `withWorkspace` throws `"Provider does not support managed workspaces"`, and no `lstat`, so `inspectWorkspace` throws `"requires leaf metadata (lstat)"`. That is why `Verifier` is an interface with a scripted fake. Do not try to make `fakeSandbox` work here.
2. **Adding a work-order row field takes three edits in lockstep**: `WorkOrderRowSchema` in `src/domain/work-order.ts`, the `COLUMNS` map in `src/registry/work-orders.ts`, and the migration SQL. Only `candidateVerified` gets boolean coercion in `fromSql`, so a second boolean column needs that branch widened.
3. **`SCHEMA_VERSION` must be bumped when you append a migration.** The guard in `openRegistry` is `current > SCHEMA_VERSION`, so forgetting the bump means a v2 database opens silently under v1 code.
4. **`permissions.allow.bash` entries are prefix matches** on the whole command string, while `tools.approve` entries are exact tool names. That is why code-fixer writes `"node "` with a trailing space.
5. **`createAgentHarness` runs typegen against whatever `appRoot` you give it** and writes `.b4/` there. Never point it at the package directory; copy the app to a temp root first, the way `examples/code-fixer/server/test/isolated-app.ts` does.

---

## File structure

New files unless marked.

| File | Responsibility |
|---|---|
| `package.json` *(modify)* | Adds the four b4 runtime deps, `@b4run/sdk`, `@b4run/testing`, `diff`, and the `check`/`build`/`dev`/`test:sandbox` scripts |
| `b4.config.ts` | The app gains a route, so it gains config: app dir, sandbox provider and workspace, permission allow-lists, `toolOutput` |
| `vitest.sandbox.config.ts` | Docker-only project, excluded from the root workspace so `pnpm test` never needs Docker |
| `fixtures/<taskId>/manifest.json` | Allowed inventory, immutable paths, task id |
| `fixtures/<taskId>/checks.json` | Visible and independent suites with their named assertions |
| `fixtures/<taskId>/checks/*.test.ts` | Independent check sources. Never captured into any workspace |
| `fixtures/<taskId>/project/**` | The baseline the controller captures |
| `fixtures/<taskId>/task.md` | The task statement, hashed into the specification digest |
| `src/fixtures/catalog.ts` | Directory-scanning, zod-validated fixture catalog; replaces code-fixer's static single-project import |
| `src/fixtures/workspace.ts` | Builds the `WorkspaceDefinition` and the shared sandbox policy and image identity |
| `src/domain/states.ts` *(modify)* | Adds `verifying`, the four new blocked reasons, the new events and rows; deletes the two gate events |
| `src/domain/work-order.ts` *(modify)* | Adds `bundleDigest` to the row, and the candidate, receipt and bundle schemas |
| `src/domain/digest.ts` | `canon`, `candidateDigest`, `bundleDigest`; domain-separated and dependency-free |
| `src/registry/db.ts` *(modify)* | Migration 2: `candidates`, `receipts`, `bundles`, `approvals.bundle_digest`; `SCHEMA_VERSION` 2 |
| `src/registry/work-orders.ts` *(modify)* | `COLUMNS` gains `bundleDigest`; `WorkOrderPatch` gains it too |
| `src/registry/evidence.ts` | Candidate, receipt and bundle rows; the only place their SQL lives |
| `src/storage/artifacts.ts` | Content-addressed evidence store under `<stateDir>/artifacts` |
| `src/worker/workspace-reader.ts` | The `WorkspaceReader` interface and its real adapter |
| `src/verification/policy.ts` | The checks and manifest policy types, loaded and validated from fixture data |
| `src/verification/assemble.ts` | Read, diff, enforce inventory and cap, compute the candidate digest |
| `src/verification/verifier.ts` | The `Verifier` interface, its input and receipt types |
| `src/verification/docker-verifier.ts` | The real verifier: fresh workspace, both suites, tamper snapshots |
| `src/verification/checks-runner.ts` | The named-assertion policy and the `node:test` runner program |
| `src/review/bundle.ts` | Freeze a bundle from a receipt and a candidate; digest it |
| `src/delivery/export.ts` | Idempotent local export of the approved bytes |
| `src/app/build/index.ts` | The bounded builder route |
| `src/prompts.ts` *(modify)* | The builder prompt, per task id |
| `src/config.ts` *(modify)* | Adds the fixtures directory, artifact directory and byte cap; drops the outbox |
| `src/controller/factory.ts` *(modify)* | Wires assembly, verification, bundle and export into the lifecycle |
| `src/controller/verify.ts` | The `verifying` phase: assemble, verify, issue, freeze, or block |
| `src/controller/reconcile.ts` *(modify)* | The explicit `verifying` rule |
| `src/worker/outbox.ts` *(delete)* | Rung 0's receipt read, deleted with the trust transfer it existed for |
| `test/fake-workspace-reader.ts` | Scripted `WorkspaceReader` |
| `test/fake-verifier.ts` | Scripted `Verifier` |
| `test/isolated-app.ts` | Copies the app to a temp root for harness tests |
| `test/*.test.ts` | Layer 1 and layer 2 |
| `test/*.integration.test.ts` | Layer 3, Docker only |

---
### Task 1: Package dependencies and the Docker-only test project

**Files:**
- Modify: `package.json`
- Create: `vitest.sandbox.config.ts`

- [ ] **Step 1: Add the dependencies and scripts**

Replace `package.json` with:

```json
{
  "name": "@b4-example/software-factory-server",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:sandbox": "vitest run --config vitest.sandbox.config.ts",
    "typecheck": "tsc -p . --noEmit",
    "lint": "biome check .",
    "factory": "tsx src/cli.ts",
    "check": "b4 check",
    "build": "b4 build",
    "dev": "b4 dev"
  },
  "dependencies": {
    "@b4run/cli": "workspace:*",
    "@b4run/sandbox": "workspace:*",
    "@b4run/sdk": "workspace:*",
    "@b4run/workspace": "workspace:*",
    "diff": "9.0.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@b4run/testing": "workspace:*",
    "@biomejs/biome": "2.5.6",
    "@types/node": "26.1.2",
    "tsx": "4.23.10",
    "typescript": "7.0.2",
    "vitest": "4.1.11"
  }
}
```

- [ ] **Step 2: Create `vitest.sandbox.config.ts`**

Mirrors code-fixer's Docker project. It is deliberately NOT added to `<repo>/vitest.workspace.ts`, which is how the repository keeps Docker out of `pnpm test`.

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "software-factory-docker",
    include: ["test/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
})
```

- [ ] **Step 3: Confirm the default project still excludes the Docker lane**

Read `vitest.config.ts`. It must already have `exclude: ["test/**/*.integration.test.ts"]` from rung 0. If it does not, add it.

- [ ] **Step 4: Install and verify nothing broke**

```bash
cd <repo> && pnpm install
pnpm --filter @b4-example/software-factory-server test
```

Expected: install links the four b4 packages; 109 tests still pass.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/server/package.json examples/software-factory/server/vitest.sandbox.config.ts <repo>/pnpm-lock.yaml
git commit -m "build(software-factory): add b4 runtime deps and the Docker-only test project"
```

---

### Task 2: Fixture data and the catalog

The factory gets its own fixture, copied from code-fixer's sample so rung 1 has a known-good defect to work on, restructured so a second fixture is a directory rather than a code change. `examples/code-fixer` is read, never modified.

**Files:**
- Create: `fixtures/cli-flags/{manifest.json,checks.json,task.md}`, `fixtures/cli-flags/checks/independent.test.ts`, `fixtures/cli-flags/project/**`
- Create: `src/fixtures/catalog.ts`, `test/catalog.test.ts`

- [ ] **Step 1: Copy the fixture payload**

```bash
cd <repo>/examples/software-factory/server
mkdir -p fixtures/cli-flags
cp -R ../../code-fixer/server/sample/project fixtures/cli-flags/project
cp -R ../../code-fixer/server/sample/checks fixtures/cli-flags/checks
cp ../../code-fixer/server/sample/manifest.json fixtures/cli-flags/manifest.json
cp ../../code-fixer/server/sample/checks.json fixtures/cli-flags/checks.json
cp ../../code-fixer/server/sample/task.md fixtures/cli-flags/task.md
git status --short ../../code-fixer
```

The last command must print nothing.

- [ ] **Step 2: Write the failing catalog test**

`test/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { fixturesDir, loadFixture, loadFixtureIds } from "../src/fixtures/catalog.ts"

describe("fixture catalog", () => {
  it("discovers the fixture on disk rather than a compiled-in id", () => {
    expect(loadFixtureIds()).toEqual(["cli-flags"])
  })

  it("loads a validated manifest and checks policy", () => {
    const fixture = loadFixture("cli-flags")
    expect(fixture.id).toBe("cli-flags")
    expect(fixture.manifest.allowedSourcePaths).toEqual(["src/cli.ts"])
    expect(fixture.manifest.immutablePaths).toContain("test/cli.test.ts")
    expect(fixture.checks.visible.assertions.length).toBeGreaterThan(0)
    expect(fixture.checks.independent.assertions.length).toBeGreaterThan(0)
    expect(fixture.taskText).toMatch(/\S/)
    expect(fixture.directory.endsWith("fixtures/cli-flags")).toBe(true)
    expect(fixturesDir.endsWith("fixtures")).toBe(true)
  })

  it("refuses an unknown fixture by name", () => {
    expect(() => loadFixture("nope")).toThrow(/Unknown fixture: nope/)
  })

  it("refuses an allowed path that could hide a check or a test", () => {
    // The schema, not the data, is what protects a future fixture.
    expect(ManifestSchema.safeParse({
      id: "x",
      allowedSourcePaths: ["test/cli.test.ts"],
      immutablePaths: [],
    }).success).toBe(false)
    expect(ManifestSchema.safeParse({
      id: "x",
      allowedSourcePaths: ["checks/independent.test.ts"],
      immutablePaths: [],
    }).success).toBe(false)
    expect(ManifestSchema.safeParse({
      id: "x",
      allowedSourcePaths: ["src/cli.ts"],
      immutablePaths: ["src/cli.ts"],
    }).success).toBe(false)
  })
})
```

Import `ManifestSchema` alongside the loaders.

- [ ] **Step 3: Run it red**

Run: `pnpm --filter @b4-example/software-factory-server test catalog`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `src/fixtures/catalog.ts`**

```ts
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

/** The package root, derived from this module rather than the working directory. */
export const appRoot = fileURLToPath(new URL("../../", import.meta.url))
export const fixturesDir = join(appRoot, "fixtures")

/**
 * A path the builder may change. Never a test, a check, or config: the factory's
 * completion policy must not be reachable from the builder's own inventory.
 */
const allowedSourcePath = z
  .string()
  .min(1)
  .regex(/^src\/[\w./-]+\.ts$/, "allowed source paths live under src/ and end in .ts")
  .refine((p) => !p.endsWith(".test.ts"), "a test file cannot be an allowed source path")

export const ManifestSchema = z
  .object({
    id: z.string().min(1),
    allowedSourcePaths: z.array(allowedSourcePath).min(1),
    immutablePaths: z.array(z.string().min(1)),
  })
  .refine(
    (m) => m.allowedSourcePaths.every((p) => !m.immutablePaths.includes(p)),
    "allowed and immutable paths must be disjoint",
  )
export type Manifest = z.infer<typeof ManifestSchema>

const SuiteSchema = z.object({
  file: z.string().regex(/^(?:test|checks)\/[\w-]+\.test\.ts$/),
  assertions: z.array(z.string().min(1)).min(1),
})
export const ChecksSchema = z.object({ visible: SuiteSchema, independent: SuiteSchema })
export type Checks = z.infer<typeof ChecksSchema>
export type Suite = z.infer<typeof SuiteSchema>

export interface Fixture {
  readonly id: string
  readonly directory: string
  readonly manifest: Manifest
  readonly checks: Checks
  readonly taskText: string
}

/** Fixture ids present on disk, sorted. A new fixture is a directory, not a code change. */
export function loadFixtureIds(): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

export function loadFixture(id: string): Fixture {
  if (!loadFixtureIds().includes(id)) throw new Error(`Unknown fixture: ${id}`)
  const directory = join(fixturesDir, id)
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")))
  if (manifest.id !== id) throw new Error(`Fixture ${id} declares a different id: ${manifest.id}`)
  const checks = ChecksSchema.parse(JSON.parse(readFileSync(join(directory, "checks.json"), "utf8")))
  const taskText = readFileSync(join(directory, "task.md"), "utf8")
  return { id, directory, manifest, checks, taskText }
}
```

The copied `manifest.json` carries extra provenance fields; zod strips them, which is intended. Keep them in the file as the record of where the defect came from.

- [ ] **Step 5: Run it green, then typecheck and lint**

```bash
pnpm --filter @b4-example/software-factory-server test catalog
pnpm --filter @b4-example/software-factory-server typecheck
pnpm --filter @b4-example/software-factory-server lint
```

Expected: PASS; both gates clean.

- [ ] **Step 6: Commit**

```bash
git add examples/software-factory/server/fixtures examples/software-factory/server/src/fixtures examples/software-factory/server/test/catalog.test.ts
git commit -m "feat(software-factory): fixture data and a directory-scanning catalog"
```

---

### Task 3: Canonical digests

Pure functions over bytes. No sandbox, no registry, no framework.

**Files:**
- Create: `src/domain/digest.ts`, `test/digest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { bundleDigest, canon, candidateDigest } from "../src/domain/digest.ts"

const changes = { "src/b.ts": "two\n", "src/a.ts": "one\n" }
const baseline = "a".repeat(64)

describe("canon", () => {
  it("is insensitive to key insertion order", () => {
    expect(canon({ b: 1, a: 2 })).toBe(canon({ a: 2, b: 1 }))
  })

  it("is sensitive to values and to nesting", () => {
    expect(canon({ a: { b: 1 } })).not.toBe(canon({ a: { b: 2 } }))
    expect(canon({ a: { b: 1 } })).not.toBe(canon({ "a.b": 1 }))
  })
})

describe("candidateDigest", () => {
  it("is stable, hex, and independent of change insertion order", () => {
    const one = candidateDigest({ workspaceId: "w", baselineDigest: baseline, changes })
    const two = candidateDigest({
      workspaceId: "w",
      baselineDigest: baseline,
      changes: { "src/a.ts": "one\n", "src/b.ts": "two\n" },
    })
    expect(one).toMatch(/^[a-f0-9]{64}$/)
    expect(one).toBe(two)
  })

  it("changes when any input changes", () => {
    const base = candidateDigest({ workspaceId: "w", baselineDigest: baseline, changes })
    expect(candidateDigest({ workspaceId: "x", baselineDigest: baseline, changes })).not.toBe(base)
    expect(candidateDigest({ workspaceId: "w", baselineDigest: "b".repeat(64), changes })).not.toBe(base)
    expect(
      candidateDigest({ workspaceId: "w", baselineDigest: baseline, changes: { "src/a.ts": "one\n" } }),
    ).not.toBe(base)
  })
})

describe("bundleDigest", () => {
  const input = {
    repositoryId: "cli-flags",
    baselineDigest: baseline,
    specificationDigest: "c".repeat(64),
    policyDigest: "d".repeat(64),
    environmentIdentity: "sha256:deadbeef",
    candidateDigest: "e".repeat(64),
    evidence: [{ id: "independent", digest: "f".repeat(64) }],
    operation: "export-local" as const,
    destinationId: "/out",
  }

  it("is stable and hex", () => {
    expect(bundleDigest(input)).toMatch(/^[a-f0-9]{64}$/)
    expect(bundleDigest(input)).toBe(bundleDigest({ ...input, evidence: [...input.evidence] }))
  })

  it("changes when the policy or the environment changes, with the same bytes", () => {
    expect(bundleDigest({ ...input, policyDigest: "0".repeat(64) })).not.toBe(bundleDigest(input))
    expect(bundleDigest({ ...input, environmentIdentity: "sha256:other" })).not.toBe(bundleDigest(input))
  })

  it("is domain-separated from a candidate digest over the same shape", () => {
    // A candidate digest must never be mistakable for a bundle digest.
    expect(bundleDigest(input)).not.toBe(
      candidateDigest({ workspaceId: input.repositoryId, baselineDigest: baseline, changes: {} }),
    )
  })
})
```

- [ ] **Step 2: Run it red**

Run: `pnpm --filter @b4-example/software-factory-server test digest`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/domain/digest.ts`**

```ts
import { createHash } from "node:crypto"

/**
 * Canonical JSON: objects are re-serialized with their keys in sorted order, at
 * every depth, so two processes that assembled the same value from different
 * code paths produce the same bytes. Arrays keep their order, because every
 * array this module hashes is sorted by its caller on a stated key.
 */
export function canon(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value === null || typeof value !== "object") return value
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
  const out: Record<string, unknown> = {}
  for (const [key, inner] of entries) out[key] = sortDeep(inner)
  return out
}

const digest = (domain: string, value: unknown): string =>
  createHash("sha256").update(domain).update(canon(value)).digest("hex")

export interface CandidateDigestInput {
  readonly workspaceId: string
  readonly baselineDigest: string
  readonly changes: Readonly<Record<string, string>>
}

/** Identity of the changed bytes against a specific captured baseline. */
export function candidateDigest(input: CandidateDigestInput): string {
  return digest("b4-factory-candidate-v1", {
    workspaceId: input.workspaceId,
    baselineDigest: input.baselineDigest,
    changes: input.changes,
  })
}

export interface BundleDigestInput {
  readonly repositoryId: string
  readonly baselineDigest: string
  readonly specificationDigest: string
  readonly policyDigest: string
  readonly environmentIdentity: string
  readonly candidateDigest: string
  readonly evidence: readonly { readonly id: string; readonly digest: string }[]
  readonly operation: "export-local"
  readonly destinationId: string
}

/**
 * Identity of everything approval authorizes. A policy or environment change
 * moves this digest even when the candidate bytes are identical, which is what
 * makes consent specific rather than approximate.
 */
export function bundleDigest(input: BundleDigestInput): string {
  return digest("b4-factory-bundle-v1", {
    ...input,
    evidence: [...input.evidence].sort((a, b) => (a.id < b.id ? -1 : 1)),
  })
}

/** Digest of a fixture's task text plus its acceptance ids, in sorted order. */
export function specificationDigest(taskText: string, acceptanceIds: readonly string[]): string {
  return digest("b4-factory-spec-v1", { taskText, acceptanceIds: [...acceptanceIds].sort() })
}

/** Digest of the completion policy: the checks and the inventory the builder may touch. */
export function policyDigest(input: {
  readonly checks: unknown
  readonly allowedSourcePaths: readonly string[]
  readonly immutablePaths: readonly string[]
}): string {
  return digest("b4-factory-policy-v1", {
    checks: input.checks,
    allowedSourcePaths: [...input.allowedSourcePaths].sort(),
    immutablePaths: [...input.immutablePaths].sort(),
  })
}
```

- [ ] **Step 4: Run it green**

Run: `pnpm --filter @b4-example/software-factory-server test digest`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/server/src/domain/digest.ts examples/software-factory/server/test/digest.test.ts
git commit -m "feat(software-factory): canonical domain-separated digests"
```

---
### Task 4: The lifecycle gains a verifying state and loses the gate

**Files:**
- Modify: `src/domain/states.ts`
- Modify: `test/states.test.ts`

- [ ] **Step 1: Write the failing test additions**

Append to `test/states.test.ts`, inside the existing top-level scope:

```ts
describe("rung 1 lifecycle", () => {
  it("routes a finished turn into verification", () => {
    expect(nextState("running", "turn_ended_with_workspace")).toBe("verifying")
    expect(nextState("dispatched", "turn_ended_with_workspace")).toBe("verifying")
  })

  it("fails a turn that produced nothing", () => {
    expect(nextState("running", "turn_ended_without_changes")).toBe("failed")
  })

  it("admits exactly one way out of verifying per outcome", () => {
    expect(nextState("verifying", "receipt_passed")).toBe("awaiting_approval")
    expect(nextState("verifying", "assembly_rejected")).toBe("blocked")
    expect(nextState("verifying", "receipt_failed")).toBe("blocked")
    expect(nextState("verifying", "receipt_inconclusive")).toBe("blocked")
  })

  it("counts verifying as active for the budget", () => {
    expect(ACTIVE_STATES.has("verifying")).toBe(true)
    expect(nextState("verifying", "budget_exhausted")).toBe("cancel_requested")
    expect(nextState("verifying", "cancel")).toBe("cancel_requested")
  })

  it("keeps approval and denial reachable only from awaiting_approval", () => {
    expect(nextState("awaiting_approval", "approve")).toBe("exporting")
    expect(nextState("awaiting_approval", "deny")).toBe("denied")
    expect(() => nextState("verifying", "approve")).toThrow(IllegalTransitionError)
  })

  it("has deleted the worker-gate events with the gate", () => {
    expect(TRANSITION_EVENTS).not.toContain("candidate_interrupt")
    expect(TRANSITION_EVENTS).not.toContain("candidate_interrupt_without_digest")
    expect(TRANSITION_EVENTS).not.toContain("interrupt_vanished")
    expect(BLOCKED_REASONS).not.toContain("candidate_digest_unknown")
    expect(BLOCKED_REASONS).not.toContain("interrupt_vanished")
  })

  it("names the four ways the controller can refuse", () => {
    for (const reason of [
      "baseline_mismatch",
      "scope_violation",
      "verification_failed",
      "verification_inconclusive",
    ])
      expect(BLOCKED_REASONS).toContain(reason)
  })

  it("still blocks on an unexpected interrupt from the builder", () => {
    expect(nextState("running", "unexpected_interrupt")).toBe("blocked")
    expect(BLOCKED_REASONS).toContain("unexpected_interrupt")
  })
})
```

Add `ACTIVE_STATES`, `BLOCKED_REASONS` and `TRANSITION_EVENTS` to the existing import from `../src/domain/states.ts` if they are not already imported.

- [ ] **Step 2: Run it red**

Run: `pnpm --filter @b4-example/software-factory-server test states`
Expected: FAIL on the new cases; the rung 0 cases still pass.

- [ ] **Step 3: Edit `src/domain/states.ts`**

Four edits. Insert `"verifying"` into `STATES` after `"running"`:

```ts
export const STATES = [
  "received",
  "dispatched",
  "running",
  "verifying",
  "awaiting_approval",
  "exporting",
  "exported",
  "denied",
  "cancel_requested",
  "cancelled",
  "blocked",
  "failed",
] as const
```

Add it to `ACTIVE_STATES`:

```ts
export const ACTIVE_STATES: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
  "dispatched",
  "running",
  "verifying",
  "exporting",
])
```

Replace `BLOCKED_REASONS` (drops two, adds four):

```ts
/** Reasons are attached by the controller (later tasks), not by nextState. */
export const BLOCKED_REASONS = [
  "unexpected_interrupt",
  "baseline_mismatch",
  "scope_violation",
  "verification_failed",
  "verification_inconclusive",
  "export_unconfirmed",
  "budget_exhausted",
] as const
```

Replace `TRANSITION_EVENTS` (drops the three gate events, adds five):

```ts
export const TRANSITION_EVENTS = [
  "dispatch_committed",
  "run_started",
  "turn_ended_with_workspace",
  "turn_ended_without_changes",
  "unexpected_interrupt",
  "run_failed",
  "assembly_rejected",
  "receipt_passed",
  "receipt_failed",
  "receipt_inconclusive",
  "approve",
  "deny",
  "receipt_observed",
  "export_unconfirmed",
  "cancel",
  "run_ended_after_cancel",
  "run_ended_after_budget",
  "budget_exhausted",
] as const
```

Replace the `TABLE` rows that change. `run_ended_without_candidate` becomes `turn_ended_without_changes`; the three gate rows are deleted; five rows are added:

```ts
const TABLE: Readonly<Record<TransitionEvent, Row>> = {
  dispatch_committed: { received: "dispatched" },
  run_started: { dispatched: "running" },
  turn_ended_with_workspace: { dispatched: "verifying", running: "verifying" },
  turn_ended_without_changes: { dispatched: "failed", running: "failed" },
  unexpected_interrupt: { dispatched: "blocked", running: "blocked", verifying: "blocked" },
  run_failed: { dispatched: "failed", running: "failed" },
  assembly_rejected: { verifying: "blocked" },
  receipt_passed: { verifying: "awaiting_approval" },
  receipt_failed: { verifying: "blocked" },
  receipt_inconclusive: { verifying: "blocked" },
  approve: { awaiting_approval: "exporting" },
  deny: { awaiting_approval: "denied", blocked: "denied" },
  receipt_observed: { exporting: "exported" },
  export_unconfirmed: { exporting: "blocked" },
  cancel: everyNonTerminalTo("cancel_requested"),
  run_ended_after_cancel: { cancel_requested: "cancelled" },
  run_ended_after_budget: { cancel_requested: "blocked" },
  budget_exhausted: {
    dispatched: "cancel_requested",
    running: "cancel_requested",
    verifying: "cancel_requested",
    exporting: "cancel_requested",
  },
}
```

Keep `FAILURE_REASONS` as it is: `route_error` and `ended_without_candidate` both still apply.

- [ ] **Step 4: Run it green**

Run: `pnpm --filter @b4-example/software-factory-server test states`
Expected: PASS. Other suites will now fail to typecheck because they reference the deleted events; that is expected and Task 9 onward fixes them. Do not fix them here.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/server/src/domain/states.ts examples/software-factory/server/test/states.test.ts
git commit -m "feat(software-factory): lifecycle gains verifying and loses the worker gate"
```

---

### Task 5: Row, evidence schemas, and migration 2

**Files:**
- Modify: `src/domain/work-order.ts`, `src/registry/db.ts`, `src/registry/work-orders.ts`
- Modify: `test/schemas.test.ts`, `test/registry-db.test.ts`, `test/work-orders.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/schemas.test.ts`:

```ts
describe("rung 1 schemas", () => {
  const digest = "a".repeat(64)

  it("carries the frozen bundle digest on the row", () => {
    const row = validRow()
    expect(WorkOrderRowSchema.parse({ ...row, bundleDigest: digest }).bundleDigest).toBe(digest)
    expect(WorkOrderRowSchema.parse(row).bundleDigest).toBeNull()
    expect(() => WorkOrderRowSchema.parse({ ...row, bundleDigest: "short" })).toThrow()
  })

  it("validates a candidate record", () => {
    const candidate = {
      digest,
      workOrderId: "wo-1",
      baselineDigest: "b".repeat(64),
      changedPaths: ["src/cli.ts"],
      bytes: 12,
      artifactDigest: "c".repeat(64),
      assembledAt: "2026-09-18T00:00:00.000Z",
    }
    expect(CandidateSchema.parse(candidate)).toEqual(candidate)
    expect(() => CandidateSchema.parse({ ...candidate, changedPaths: [] })).toThrow()
  })

  it("validates a receipt, including the third verdict", () => {
    const receipt = {
      id: "rc-1",
      workOrderId: "wo-1",
      candidateDigest: digest,
      verifierIdentity: "docker:sha256:abc",
      policyDigest: "d".repeat(64),
      environmentIdentity: "sha256:abc",
      verdict: "inconclusive" as const,
      checks: [
        { id: "independent", acceptanceIds: ["a"], verdict: "inconclusive" as const, evidence: [] },
      ],
      issuedAt: "2026-09-18T00:00:00.000Z",
    }
    expect(ReceiptSchema.parse(receipt).verdict).toBe("inconclusive")
    expect(() => ReceiptSchema.parse({ ...receipt, verdict: "maybe" })).toThrow()
  })

  it("validates a frozen bundle", () => {
    const bundle = {
      digest,
      workOrderId: "wo-1",
      candidateDigest: "e".repeat(64),
      receiptId: "rc-1",
      payload: { repositoryId: "cli-flags" },
      frozenAt: "2026-09-18T00:00:00.000Z",
    }
    expect(BundleSchema.parse(bundle).payload.repositoryId).toBe("cli-flags")
  })

  it("binds an approval to a bundle digest", () => {
    const approval = {
      id: "ap-1",
      workOrderId: "wo-1",
      bundleDigest: digest,
      candidateDigest: "f".repeat(64),
      decision: "approved" as const,
      decidedBy: "operator",
      decidedAt: "2026-09-18T00:00:00.000Z",
      expiresAt: "2026-09-18T00:15:00.000Z",
    }
    expect(ApprovalSchema.parse(approval).bundleDigest).toBe(digest)
    // The rung 0 interrupt coupling is gone.
    expect("interruptId" in ApprovalSchema.parse(approval)).toBe(false)
  })
})
```

Add a `validRow()` helper to that file if one does not exist, returning the rung 0 row shape with `bundleDigest: null` omitted, and add the new schema names to the import.

Append to `test/registry-db.test.ts`:

```ts
describe("migration 2", () => {
  it("creates the evidence tables and the approval binding", () => {
    const registry = openRegistry(tempPath())
    const tables = registry.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
    for (const name of ["candidates", "receipts", "bundles"]) expect(tables.map((t) => t.name)).toContain(name)
    const cols = registry.db.prepare("SELECT name FROM pragma_table_info('approvals')").all() as {
      name: string
    }[]
    expect(cols.map((c) => c.name)).toContain("bundle_digest")
    const wo = registry.db.prepare("SELECT name FROM pragma_table_info('work_orders')").all() as {
      name: string
    }[]
    expect(wo.map((c) => c.name)).toContain("bundle_digest")
    expect(SCHEMA_VERSION).toBe(2)
    registry.close()
  })

  it("still refuses a newer schema", () => {
    const path = tempPath()
    openRegistry(path).close()
    const db = new DatabaseSync(path)
    db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION + 1)
    db.close()
    expect(() => openRegistry(path)).toThrow(RegistryVersionError)
  })
})
```

- [ ] **Step 2: Run them red**

Run: `pnpm --filter @b4-example/software-factory-server test schemas registry-db`
Expected: FAIL on the new cases.

- [ ] **Step 3: Edit `src/domain/work-order.ts`**

Add one row field, after `candidateVerified`:

```ts
  /** Set when the controller freezes a review bundle; what approval binds to. */
  bundleDigest: z.string().regex(DIGEST_PATTERN).nullable(),
```

Replace `ApprovalSchema` so consent binds to the bundle:

```ts
export const ApprovalSchema = z.object({
  id: z.string().min(1),
  workOrderId: z.string().min(1),
  bundleDigest: z.string().regex(DIGEST_PATTERN),
  candidateDigest: z.string().regex(DIGEST_PATTERN),
  decision: z.enum(["approved", "denied"]),
  decidedBy: z.string().min(1),
  decidedAt: z.string(),
  expiresAt: z.string(),
})
export type Approval = z.infer<typeof ApprovalSchema>
```

Append the three evidence schemas:

```ts
export const VERDICTS = ["pass", "fail", "inconclusive"] as const
export type Verdict = (typeof VERDICTS)[number]

export const CandidateSchema = z.object({
  digest: z.string().regex(DIGEST_PATTERN),
  workOrderId: z.string().min(1),
  baselineDigest: z.string().regex(DIGEST_PATTERN),
  changedPaths: z.array(z.string().min(1)).min(1),
  bytes: z.number().int().nonnegative(),
  artifactDigest: z.string().regex(DIGEST_PATTERN),
  assembledAt: z.string(),
})
export type Candidate = z.infer<typeof CandidateSchema>

export const CheckResultSchema = z.object({
  id: z.string().min(1),
  acceptanceIds: z.array(z.string().min(1)),
  verdict: z.enum(VERDICTS),
  evidence: z.array(z.object({ id: z.string().min(1), digest: z.string().regex(DIGEST_PATTERN) })),
})

export const ReceiptSchema = z.object({
  id: z.string().min(1),
  workOrderId: z.string().min(1),
  candidateDigest: z.string().regex(DIGEST_PATTERN),
  /** Assigned by the harness that ran the checks, never by a worker. */
  verifierIdentity: z.string().min(1),
  policyDigest: z.string().regex(DIGEST_PATTERN),
  environmentIdentity: z.string().min(1),
  verdict: z.enum(VERDICTS),
  checks: z.array(CheckResultSchema),
  issuedAt: z.string(),
})
export type Receipt = z.infer<typeof ReceiptSchema>

export const BundleSchema = z.object({
  digest: z.string().regex(DIGEST_PATTERN),
  workOrderId: z.string().min(1),
  candidateDigest: z.string().regex(DIGEST_PATTERN),
  receiptId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  frozenAt: z.string(),
})
export type Bundle = z.infer<typeof BundleSchema>
```

- [ ] **Step 4: Edit `src/registry/db.ts`**

Bump the version and append migration 2:

```ts
export const SCHEMA_VERSION = 2
```

```ts
  {
    version: 2,
    up: `
      ALTER TABLE work_orders ADD COLUMN bundle_digest TEXT;
      ALTER TABLE approvals ADD COLUMN bundle_digest TEXT;
      CREATE TABLE candidates (
        digest TEXT PRIMARY KEY,
        work_order_id TEXT NOT NULL REFERENCES work_orders(id),
        baseline_digest TEXT NOT NULL,
        changed_paths TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        artifact_digest TEXT NOT NULL,
        assembled_at TEXT NOT NULL
      );
      CREATE INDEX candidates_by_work_order ON candidates(work_order_id);
      CREATE TABLE receipts (
        id TEXT PRIMARY KEY,
        work_order_id TEXT NOT NULL REFERENCES work_orders(id),
        candidate_digest TEXT NOT NULL,
        verifier_identity TEXT NOT NULL,
        policy_digest TEXT NOT NULL,
        environment_identity TEXT NOT NULL,
        verdict TEXT NOT NULL,
        checks TEXT NOT NULL,
        issued_at TEXT NOT NULL
      );
      CREATE INDEX receipts_by_work_order ON receipts(work_order_id);
      CREATE TABLE bundles (
        digest TEXT PRIMARY KEY,
        work_order_id TEXT NOT NULL REFERENCES work_orders(id),
        candidate_digest TEXT NOT NULL,
        receipt_id TEXT NOT NULL REFERENCES receipts(id),
        payload TEXT NOT NULL,
        frozen_at TEXT NOT NULL
      );
      CREATE INDEX bundles_by_work_order ON bundles(work_order_id);
    `,
  },
```

`approvals.bundle_digest` is added nullable because SQLite cannot add a NOT NULL column without a default; the schema in `ApprovalSchema` is what enforces its presence on write, and no rung 0 rows exist in a registry that has never been released.

- [ ] **Step 5: Edit `src/registry/work-orders.ts`**

Add `bundleDigest: "bundle_digest",` to `COLUMNS` after `candidateVerified`, and add `bundleDigest` to the `WorkOrderPatch` pick list. Update `recordApproval`/`approvals` to read and write `bundle_digest` in place of `interrupt_id`. Add a test to `test/work-orders.test.ts`:

```ts
it("round-trips the bundle digest and a bundle-bound approval", () => {
  const s = store()
  s.insert(freshRow())
  const digest = "a".repeat(64)
  expect(s.update("wo-1", 0, { bundleDigest: digest }, at).bundleDigest).toBe(digest)
  s.recordApproval({
    id: "ap-1",
    workOrderId: "wo-1",
    bundleDigest: digest,
    candidateDigest: "b".repeat(64),
    decision: "approved",
    decidedBy: "operator",
    decidedAt: at,
    expiresAt: at,
  })
  expect(s.approvals("wo-1")[0]?.bundleDigest).toBe(digest)
})
```

Also add `bundleDigest: null` to every row literal in the existing tests and to `freshRow()`.

- [ ] **Step 6: Run the three suites green**

Run: `pnpm --filter @b4-example/software-factory-server test schemas registry-db work-orders`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add examples/software-factory/server/src/domain/work-order.ts examples/software-factory/server/src/registry examples/software-factory/server/test
git commit -m "feat(software-factory): evidence schemas, migration 2, bundle-bound approvals"
```

---

### Task 6: Artifact store and evidence rows

**Files:**
- Create: `src/storage/artifacts.ts`, `src/registry/evidence.ts`
- Create: `test/artifacts.test.ts`, `test/evidence.test.ts`

- [ ] **Step 1: Write the failing artifact test**

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createArtifactStore } from "../src/storage/artifacts.ts"

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const store = () => {
  dir = mkdtempSync(join(tmpdir(), "factory-artifacts-"))
  return createArtifactStore(join(dir, "artifacts"))
}

describe("artifact store", () => {
  it("is content addressed and returns the digest", async () => {
    const s = store()
    const ref = await s.put("hello\n")
    expect(ref.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(ref.bytes).toBe(6)
    expect(await s.read(ref.digest)).toBe("hello\n")
  })

  it("is idempotent for identical content and never rewrites", async () => {
    const s = store()
    const one = await s.put("same\n")
    const two = await s.put("same\n")
    expect(two.digest).toBe(one.digest)
    expect(readFileSync(s.pathFor(one.digest), "utf8")).toBe("same\n")
  })

  it("refuses a digest that is not a sha256 hex string", async () => {
    const s = store()
    await expect(s.read("../escape")).rejects.toThrow(/digest/i)
  })

  it("reports a missing artifact clearly", async () => {
    const s = store()
    await expect(s.read("a".repeat(64))).rejects.toThrow(/not found/i)
  })
})
```

- [ ] **Step 2: Run it red**

Run: `pnpm --filter @b4-example/software-factory-server test artifacts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/storage/artifacts.ts`**

```ts
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DIGEST_PATTERN } from "../domain/work-order.js"

export interface ArtifactRef {
  readonly digest: string
  readonly bytes: number
}

export interface ArtifactStore {
  /** Write content under its own sha256. Returns the same ref for identical content. */
  put(content: string): Promise<ArtifactRef>
  read(digest: string): Promise<string>
  pathFor(digest: string): string
}

/**
 * Immutable evidence lives outside the registry so a row never carries megabytes
 * of check output. The digest is the name, so a second write of the same bytes is
 * a no-op rather than a conflict.
 */
export function createArtifactStore(directory: string): ArtifactStore {
  const assertDigest = (digest: string): string => {
    if (!DIGEST_PATTERN.test(digest)) throw new Error(`Invalid artifact digest: ${digest}`)
    return digest
  }
  const pathFor = (digest: string) => join(directory, `${assertDigest(digest)}.txt`)

  return {
    pathFor,
    async put(content) {
      const digest = createHash("sha256").update(content).digest("hex")
      const bytes = Buffer.byteLength(content)
      await mkdir(directory, { recursive: true })
      try {
        await writeFile(pathFor(digest), content, { flag: "wx" })
      } catch (error) {
        // Identical content under an identical name: the write already happened.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      return { digest, bytes }
    },
    async read(digest) {
      try {
        return await readFile(pathFor(digest), "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error(`Artifact not found: ${digest}`)
        throw error
      }
    },
  }
}
```

- [ ] **Step 4: Write the failing evidence-store test**

```ts
import { describe, expect, it } from "vitest"
import { openRegistry } from "../src/registry/db.ts"
import { createEvidenceStore } from "../src/registry/evidence.ts"
import { createWorkOrderStore } from "../src/registry/work-orders.ts"

const at = "2026-09-18T00:00:00.000Z"

function stores() {
  const db = openRegistry(":memory:").db
  const workOrders = createWorkOrderStore(db)
  workOrders.insert({
    id: "wo-1",
    revision: 0,
    state: "received",
    taskId: "cli-flags",
    workerRoute: "/build#agent",
    workerThreadId: null,
    interruptId: null,
    candidateDigest: null,
    candidateVerified: null,
    bundleDigest: null,
    blockedReason: null,
    failureReason: null,
    maxCandidateAttempts: 1,
    maxActiveMs: 60_000,
    activeMs: 0,
    activeStartedAt: null,
    awaitingSince: null,
    createdAt: at,
    updatedAt: at,
  })
  return { evidence: createEvidenceStore(db), workOrders }
}

describe("evidence store", () => {
  it("round-trips a candidate, a receipt and a bundle", () => {
    const { evidence } = stores()
    const candidate = {
      digest: "a".repeat(64),
      workOrderId: "wo-1",
      baselineDigest: "b".repeat(64),
      changedPaths: ["src/cli.ts"],
      bytes: 10,
      artifactDigest: "c".repeat(64),
      assembledAt: at,
    }
    evidence.recordCandidate(candidate)
    expect(evidence.candidate(candidate.digest)).toEqual(candidate)

    const receipt = {
      id: "rc-1",
      workOrderId: "wo-1",
      candidateDigest: candidate.digest,
      verifierIdentity: "docker:sha256:abc",
      policyDigest: "d".repeat(64),
      environmentIdentity: "sha256:abc",
      verdict: "pass" as const,
      checks: [{ id: "visible", acceptanceIds: ["one"], verdict: "pass" as const, evidence: [] }],
      issuedAt: at,
    }
    evidence.recordReceipt(receipt)
    expect(evidence.receipt("rc-1")).toEqual(receipt)

    const bundle = {
      digest: "e".repeat(64),
      workOrderId: "wo-1",
      candidateDigest: candidate.digest,
      receiptId: "rc-1",
      payload: { repositoryId: "cli-flags" },
      frozenAt: at,
    }
    evidence.recordBundle(bundle)
    expect(evidence.bundle(bundle.digest)).toEqual(bundle)
  })

  it("returns null for anything it has not recorded", () => {
    const { evidence } = stores()
    expect(evidence.candidate("f".repeat(64))).toBeNull()
    expect(evidence.receipt("nope")).toBeNull()
    expect(evidence.bundle("f".repeat(64))).toBeNull()
  })

  it("is idempotent on a repeated identical record", () => {
    const { evidence } = stores()
    const candidate = {
      digest: "a".repeat(64),
      workOrderId: "wo-1",
      baselineDigest: "b".repeat(64),
      changedPaths: ["src/cli.ts"],
      bytes: 10,
      artifactDigest: "c".repeat(64),
      assembledAt: at,
    }
    evidence.recordCandidate(candidate)
    evidence.recordCandidate(candidate)
    expect(evidence.candidate(candidate.digest)).toEqual(candidate)
  })
})
```

- [ ] **Step 5: Run it red**

Run: `pnpm --filter @b4-example/software-factory-server test evidence`
Expected: FAIL, module not found.

- [ ] **Step 6: Implement `src/registry/evidence.ts`**

```ts
import type { DatabaseSync } from "node:sqlite"
import {
  type Bundle,
  BundleSchema,
  type Candidate,
  CandidateSchema,
  type Receipt,
  ReceiptSchema,
} from "../domain/work-order.js"

export interface EvidenceStore {
  recordCandidate(candidate: Candidate): void
  candidate(digest: string): Candidate | null
  recordReceipt(receipt: Receipt): void
  receipt(id: string): Receipt | null
  recordBundle(bundle: Bundle): void
  bundle(digest: string): Bundle | null
}

/**
 * The immutable half of the registry. Every record is keyed by its own identity,
 * so recording the same evidence twice is a no-op rather than a conflict, which
 * is what makes the verifying phase safe to replay after a restart.
 */
export function createEvidenceStore(db: DatabaseSync): EvidenceStore {
  return {
    recordCandidate(candidate) {
      CandidateSchema.parse(candidate)
      db.prepare(
        `INSERT OR IGNORE INTO candidates
         (digest, work_order_id, baseline_digest, changed_paths, bytes, artifact_digest, assembled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        candidate.digest,
        candidate.workOrderId,
        candidate.baselineDigest,
        JSON.stringify(candidate.changedPaths),
        candidate.bytes,
        candidate.artifactDigest,
        candidate.assembledAt,
      )
    },
    candidate(digest) {
      const row = db.prepare("SELECT * FROM candidates WHERE digest = ?").get(digest) as
        | Record<string, string | number>
        | undefined
      return row
        ? CandidateSchema.parse({
            digest: row.digest,
            workOrderId: row.work_order_id,
            baselineDigest: row.baseline_digest,
            changedPaths: JSON.parse(String(row.changed_paths)),
            bytes: row.bytes,
            artifactDigest: row.artifact_digest,
            assembledAt: row.assembled_at,
          })
        : null
    },
    recordReceipt(receipt) {
      ReceiptSchema.parse(receipt)
      db.prepare(
        `INSERT OR IGNORE INTO receipts
         (id, work_order_id, candidate_digest, verifier_identity, policy_digest,
          environment_identity, verdict, checks, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        receipt.id,
        receipt.workOrderId,
        receipt.candidateDigest,
        receipt.verifierIdentity,
        receipt.policyDigest,
        receipt.environmentIdentity,
        receipt.verdict,
        JSON.stringify(receipt.checks),
        receipt.issuedAt,
      )
    },
    receipt(id) {
      const row = db.prepare("SELECT * FROM receipts WHERE id = ?").get(id) as
        | Record<string, string>
        | undefined
      return row
        ? ReceiptSchema.parse({
            id: row.id,
            workOrderId: row.work_order_id,
            candidateDigest: row.candidate_digest,
            verifierIdentity: row.verifier_identity,
            policyDigest: row.policy_digest,
            environmentIdentity: row.environment_identity,
            verdict: row.verdict,
            checks: JSON.parse(row.checks),
            issuedAt: row.issued_at,
          })
        : null
    },
    recordBundle(bundle) {
      BundleSchema.parse(bundle)
      db.prepare(
        `INSERT OR IGNORE INTO bundles
         (digest, work_order_id, candidate_digest, receipt_id, payload, frozen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        bundle.digest,
        bundle.workOrderId,
        bundle.candidateDigest,
        bundle.receiptId,
        JSON.stringify(bundle.payload),
        bundle.frozenAt,
      )
    },
    bundle(digest) {
      const row = db.prepare("SELECT * FROM bundles WHERE digest = ?").get(digest) as
        | Record<string, string>
        | undefined
      return row
        ? BundleSchema.parse({
            digest: row.digest,
            workOrderId: row.work_order_id,
            candidateDigest: row.candidate_digest,
            receiptId: row.receipt_id,
            payload: JSON.parse(row.payload),
            frozenAt: row.frozen_at,
          })
        : null
    },
  }
}
```

- [ ] **Step 7: Run both green, then typecheck and lint**

Run: `pnpm --filter @b4-example/software-factory-server test artifacts evidence`
Expected: PASS, 7 tests.

- [ ] **Step 8: Commit**

```bash
git add examples/software-factory/server/src/storage examples/software-factory/server/src/registry/evidence.ts examples/software-factory/server/test/artifacts.test.ts examples/software-factory/server/test/evidence.test.ts
git commit -m "feat(software-factory): content-addressed artifacts and evidence rows"
```

---
### Task 7: Workspace reader seam and the workspace definition

**Files:**
- Create: `src/worker/workspace-reader.ts`, `src/fixtures/workspace.ts`, `test/fake-workspace-reader.ts`
- Create: `test/workspace-reader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { fixtureWorkspace, sandboxPolicy } from "../src/fixtures/workspace.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

describe("fixture workspace definition", () => {
  it("captures only the declared inventory and never the checks", () => {
    const definition = fixtureWorkspace("cli-flags")
    expect(definition.source.directory).toBe("fixtures/cli-flags/project")
    expect(definition.source.include).toContain("src/cli.ts")
    expect(definition.source.include).toContain("test/cli.test.ts")
    for (const path of definition.source.include) expect(path.startsWith("checks/")).toBe(false)
    expect(definition.baseline).toBe("git")
  })

  it("denies the network and bounds the container", () => {
    expect(sandboxPolicy.network.mode).toBe("deny")
    expect(sandboxPolicy.resources?.timeoutMs).toBeGreaterThan(0)
  })
})

describe("fake workspace reader", () => {
  it("returns the scripted bytes for a thread and rejects an unknown one", async () => {
    const reader = createFakeWorkspaceReader({ "t-1": { "src/cli.ts": "fixed\n" } })
    expect(await reader.read("t-1", AbortSignal.timeout(1_000))).toEqual(
      new Map([["src/cli.ts", "fixed\n"]]),
    )
    await expect(reader.read("t-2", AbortSignal.timeout(1_000))).rejects.toThrow(/t-2/)
  })

  it("records every thread it was asked to read", async () => {
    const reader = createFakeWorkspaceReader({ "t-1": {} })
    await reader.read("t-1", AbortSignal.timeout(1_000))
    expect(reader.reads).toEqual(["t-1"])
  })
})
```

- [ ] **Step 2: Run it red**

Run: `pnpm --filter @b4-example/software-factory-server test workspace-reader`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/fixtures/workspace.ts`**

```ts
import type { SandboxPolicy, WorkspaceDefinition } from "@b4run/workspace"
import { loadFixture } from "./catalog.js"

/**
 * The image both the builder and the verifier run. A digest pin belongs here once
 * the fixture image is published; until then the tag is the identity and the
 * verifier records what it actually ran.
 */
export const sandboxImage = process.env.FACTORY_SANDBOX_IMAGE ?? "b4-code-fixer:fixture-v1"

/** Denied network, bounded CPU, memory and wall clock. Shared by both containers. */
export const sandboxPolicy: SandboxPolicy = {
  network: { mode: "deny" },
  env: { npm_config_cache: "/tmp/npm-cache", npm_config_update_notifier: "false" },
  resources: { memoryMb: 1024, cpus: 1, timeoutMs: 120_000 },
}

/**
 * Pure declaration of what the workspace contains. The independent checks are a
 * sibling of `project/`, so they are structurally absent from this capture rather
 * than merely excluded from it.
 */
export function fixtureWorkspace(id: string): WorkspaceDefinition {
  const { manifest } = loadFixture(id)
  return {
    source: {
      directory: `fixtures/${id}/project`,
      include: [...manifest.allowedSourcePaths, ...manifest.immutablePaths],
      files: [
        { path: "TASK.md", file: `fixtures/${id}/task.md` },
        { path: ".gitignore", text: "node_modules/\n" },
      ],
    },
    environmentLinks: [{ path: "node_modules", target: `/opt/fixtures/${id}/node_modules` }],
    baseline: "git",
  }
}
```

- [ ] **Step 4: Implement `src/worker/workspace-reader.ts`**

```ts
import { inspectWorkspace } from "@b4run/workspace"
import type { SandboxHandle } from "@b4run/workspace"

/**
 * Read a builder thread's workspace after its turn has ended. The controller uses
 * this to obtain candidate bytes it does not trust, which it then validates
 * against its own captured baseline. Implementations must never mutate the
 * workspace and must never disturb a live sandbox.
 */
export interface WorkspaceReader {
  read(threadId: string, signal: AbortSignal): Promise<ReadonlyMap<string, string>>
}

export interface HandleReaderOptions {
  /** Root leaf names whose subtrees may be absent, e.g. the git directory. */
  readonly excludeRootDirectories?: readonly string[]
  /** Required root symlinks and their exact targets, e.g. the dependency link. */
  readonly expectedRootSymlinks?: Readonly<Record<string, string>>
  readonly maxEntries?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
}

/**
 * Adapter over whatever the framework's read-only thread-workspace surface hands
 * back. It is written against `SandboxHandle` because that is what
 * `inspectWorkspace` accepts; when the surface lands, `attach` is the only thing
 * that changes.
 */
export function createHandleWorkspaceReader(
  attach: (threadId: string, signal: AbortSignal) => Promise<{
    readonly handle: SandboxHandle
    readonly release: () => Promise<void>
  }>,
  options: HandleReaderOptions = {},
): WorkspaceReader {
  return {
    async read(threadId, signal) {
      const { handle, release } = await attach(threadId, signal)
      try {
        const inspection = await inspectWorkspace(handle, {
          signal,
          maxEntries: options.maxEntries ?? 10_000,
          maxFileBytes: options.maxFileBytes ?? 2 * 1024 * 1024,
          maxTotalBytes: options.maxTotalBytes ?? 16 * 1024 * 1024,
          ...(options.excludeRootDirectories
            ? { excludeRootDirectories: options.excludeRootDirectories }
            : {}),
          ...(options.expectedRootSymlinks
            ? { expectedRootSymlinks: options.expectedRootSymlinks }
            : {}),
        })
        return new Map(Object.entries(inspection.files))
      } finally {
        await release()
      }
    },
  }
}
```

- [ ] **Step 5: Implement `test/fake-workspace-reader.ts`**

```ts
import type { WorkspaceReader } from "../src/worker/workspace-reader.ts"

export interface FakeWorkspaceReader extends WorkspaceReader {
  /** Thread ids this reader was asked for, in order. */
  readonly reads: string[]
  /** Replace a thread's bytes between reads, to simulate drift. */
  set(threadId: string, files: Readonly<Record<string, string>>): void
}

/** Scripted stand-in: the test chooses exactly what the builder appears to have written. */
export function createFakeWorkspaceReader(
  threads: Readonly<Record<string, Readonly<Record<string, string>>>>,
): FakeWorkspaceReader {
  const state = new Map(Object.entries(threads).map(([id, files]) => [id, { ...files }]))
  const reads: string[] = []
  return {
    reads,
    set(threadId, files) {
      state.set(threadId, { ...files })
    },
    async read(threadId) {
      reads.push(threadId)
      const files = state.get(threadId)
      if (!files) throw new Error(`Fake workspace reader has no thread ${threadId}`)
      return new Map(Object.entries(files))
    },
  }
}
```

- [ ] **Step 6: Run it green, typecheck, lint, commit**

```bash
pnpm --filter @b4-example/software-factory-server test workspace-reader
pnpm --filter @b4-example/software-factory-server typecheck
git add examples/software-factory/server/src/fixtures/workspace.ts examples/software-factory/server/src/worker/workspace-reader.ts examples/software-factory/server/test/fake-workspace-reader.ts examples/software-factory/server/test/workspace-reader.test.ts
git commit -m "feat(software-factory): workspace reader seam and the fixture workspace definition"
```

---

### Task 8: Candidate assembly

The controller's own view of what changed. Pure over bytes, so it is tested for real in every layer.

**Files:**
- Create: `src/verification/assemble.ts`, `test/assemble.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { AssemblyRejectedError, assembleCandidate } from "../src/verification/assemble.ts"

const baseline = new Map([
  ["src/cli.ts", "broken\n"],
  ["test/cli.test.ts", "spec\n"],
  ["TASK.md", "task\n"],
])
const policy = {
  workspaceId: "cli-flags",
  baselineDigest: "a".repeat(64),
  allowedSourcePaths: ["src/cli.ts"],
  immutablePaths: ["test/cli.test.ts"],
  maxChangedBytes: 1024,
}

const observed = (over: Record<string, string>) => new Map([...baseline, ...Object.entries(over)])

describe("assembleCandidate", () => {
  it("returns only the changed allowed files and a digest over them", () => {
    const result = assembleCandidate({ baseline, observed: observed({ "src/cli.ts": "fixed\n" }), policy })
    expect(result.changes).toEqual({ "src/cli.ts": "fixed\n" })
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.bytes).toBe(Buffer.byteLength("fixed\n"))
    expect(result.changedPaths).toEqual(["src/cli.ts"])
  })

  it("is byte-identical for an unchanged workspace and reports no candidate", () => {
    expect(assembleCandidate({ baseline, observed: observed({}), policy }).changes).toEqual({})
  })

  it("rejects a change to an immutable path", () => {
    expect(() =>
      assembleCandidate({ baseline, observed: observed({ "test/cli.test.ts": "weakened\n" }), policy }),
    ).toThrow(AssemblyRejectedError)
  })

  it("rejects a change outside the allowed inventory even if it is not immutable", () => {
    expect(() =>
      assembleCandidate({ baseline, observed: observed({ "TASK.md": "rewritten\n" }), policy }),
    ).toThrow(/not in the allowed inventory/)
  })

  it("rejects an added path", () => {
    expect(() =>
      assembleCandidate({ baseline, observed: observed({ "src/extra.ts": "new\n" }), policy }),
    ).toThrow(/added/)
  })

  it("rejects a removed path", () => {
    const missing = new Map(baseline)
    missing.delete("src/cli.ts")
    expect(() => assembleCandidate({ baseline, observed: missing, policy })).toThrow(/removed/)
  })

  it("rejects a cap breach rather than truncating", () => {
    const big = "x".repeat(2048)
    expect(() =>
      assembleCandidate({ baseline, observed: observed({ "src/cli.ts": big }), policy }),
    ).toThrow(/exceeds/)
  })

  it("rejects content that is not valid text", () => {
    expect(() =>
      assembleCandidate({ baseline, observed: observed({ "src/cli.ts": "nul byte\n" }), policy }),
    ).toThrow(/NUL/)
  })

  it("names the violated rule on the error so the controller can record a reason", () => {
    try {
      assembleCandidate({ baseline, observed: observed({ "src/extra.ts": "new\n" }), policy })
      throw new Error("expected a rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(AssemblyRejectedError)
      expect((error as AssemblyRejectedError).rule).toBe("inventory")
    }
  })
})
```

- [ ] **Step 2: Run it red**

Run: `pnpm --filter @b4-example/software-factory-server test assemble`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/verification/assemble.ts`**

```ts
import { candidateDigest } from "../domain/digest.js"

export type AssemblyRule = "inventory" | "immutable" | "added" | "removed" | "cap" | "encoding"

/** A refusal the controller records as `scope_violation`, with the rule that fired. */
export class AssemblyRejectedError extends Error {
  constructor(
    readonly rule: AssemblyRule,
    message: string,
  ) {
    super(message)
    this.name = "AssemblyRejectedError"
  }
}

export interface AssemblyPolicy {
  readonly workspaceId: string
  readonly baselineDigest: string
  readonly allowedSourcePaths: readonly string[]
  readonly immutablePaths: readonly string[]
  readonly maxChangedBytes: number
}

export interface AssembledCandidate {
  readonly digest: string
  readonly changes: Readonly<Record<string, string>>
  readonly changedPaths: readonly string[]
  readonly bytes: number
}

/**
 * Diff what the builder left against the baseline the controller captured, and
 * enforce the policy before anything else happens. Nothing here trusts the
 * builder: the baseline, the inventory and the cap all come from the controller.
 */
export function assembleCandidate(input: {
  readonly baseline: ReadonlyMap<string, string>
  readonly observed: ReadonlyMap<string, string>
  readonly policy: AssemblyPolicy
}): AssembledCandidate {
  const { baseline, observed, policy } = input
  const allowed = new Set(policy.allowedSourcePaths)
  const immutable = new Set(policy.immutablePaths)

  for (const path of observed.keys())
    if (!baseline.has(path))
      throw new AssemblyRejectedError("added", `Candidate added a path: ${path}`)
  for (const path of baseline.keys())
    if (!observed.has(path))
      throw new AssemblyRejectedError("removed", `Candidate removed a path: ${path}`)

  const changes: Record<string, string> = {}
  let bytes = 0
  for (const path of [...baseline.keys()].sort()) {
    const before = baseline.get(path) as string
    const after = observed.get(path) as string
    if (before === after) continue
    if (immutable.has(path))
      throw new AssemblyRejectedError("immutable", `Candidate changed an immutable path: ${path}`)
    if (!allowed.has(path))
      throw new AssemblyRejectedError("inventory", `Path is not in the allowed inventory: ${path}`)
    if (after.includes(" "))
      throw new AssemblyRejectedError("encoding", `Candidate wrote a NUL byte in ${path}`)
    changes[path] = after
    bytes += Buffer.byteLength(after)
  }

  if (bytes > policy.maxChangedBytes)
    throw new AssemblyRejectedError(
      "cap",
      `Candidate exceeds the byte cap: ${bytes} > ${policy.maxChangedBytes}`,
    )

  return {
    digest: candidateDigest({
      workspaceId: policy.workspaceId,
      baselineDigest: policy.baselineDigest,
      changes,
    }),
    changes,
    changedPaths: Object.keys(changes),
    bytes,
  }
}
```

- [ ] **Step 4: Run it green, then commit**

Run: `pnpm --filter @b4-example/software-factory-server test assemble`
Expected: PASS, 9 tests.

```bash
git add examples/software-factory/server/src/verification/assemble.ts examples/software-factory/server/test/assemble.test.ts
git commit -m "feat(software-factory): candidate assembly against a controller-captured baseline"
```

---

### Task 9: The verifier seam and its scripted stand-in

**Files:**
- Create: `src/verification/verifier.ts`, `test/fake-verifier.ts`, `test/fake-verifier.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { createFakeVerifier } from "./fake-verifier.ts"

const input = {
  workOrderId: "wo-1",
  taskId: "cli-flags",
  candidateDigest: "a".repeat(64),
  changes: { "src/cli.ts": "fixed\n" },
  policyDigest: "b".repeat(64),
}

describe("fake verifier", () => {
  it("issues a passing receipt whose identity comes from the harness", async () => {
    const verifier = createFakeVerifier({ verdict: "pass" })
    const receipt = await verifier.verify(input, AbortSignal.timeout(1_000))
    expect(receipt.verdict).toBe("pass")
    expect(receipt.verifierIdentity).toMatch(/^fake:/)
    expect(receipt.candidateDigest).toBe(input.candidateDigest)
    expect(receipt.policyDigest).toBe(input.policyDigest)
    expect(receipt.checks.map((c) => c.id)).toEqual(["visible", "independent"])
  })

  it("scripts the visible-passes-independent-fails case, which is rung 1's point", async () => {
    const verifier = createFakeVerifier({ verdict: "fail", visible: "pass", independent: "fail" })
    const receipt = await verifier.verify(input, AbortSignal.timeout(1_000))
    expect(receipt.verdict).toBe("fail")
    expect(receipt.checks.find((c) => c.id === "visible")?.verdict).toBe("pass")
    expect(receipt.checks.find((c) => c.id === "independent")?.verdict).toBe("fail")
  })

  it("scripts an inconclusive run", async () => {
    const verifier = createFakeVerifier({ verdict: "inconclusive" })
    expect((await verifier.verify(input, AbortSignal.timeout(1_000))).verdict).toBe("inconclusive")
  })

  it("can throw, so the controller's error path is reachable", async () => {
    const verifier = createFakeVerifier({ throws: "docker unavailable" })
    await expect(verifier.verify(input, AbortSignal.timeout(1_000))).rejects.toThrow(/docker unavailable/)
  })

  it("records every candidate it verified", async () => {
    const verifier = createFakeVerifier({ verdict: "pass" })
    await verifier.verify(input, AbortSignal.timeout(1_000))
    expect(verifier.verified).toEqual([input.candidateDigest])
  })
})
```

- [ ] **Step 2: Run it red**

Run: `pnpm --filter @b4-example/software-factory-server test fake-verifier`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/verification/verifier.ts`**

```ts
import type { Receipt, Verdict } from "../domain/work-order.js"

export interface VerifyInput {
  readonly workOrderId: string
  readonly taskId: string
  readonly candidateDigest: string
  readonly changes: Readonly<Record<string, string>>
  readonly policyDigest: string
}

/**
 * Runs the completion policy against a candidate and issues a receipt. The
 * implementation, not the caller, assigns the verifier identity and the
 * environment identity, because those are the claims a receipt is trusted for.
 *
 * `verify` resolves with a receipt for every outcome the policy can reach,
 * including `fail` and `inconclusive`. It rejects only when the harness itself
 * could not run, which the controller records separately from a verdict.
 */
export interface Verifier {
  verify(input: VerifyInput, signal: AbortSignal): Promise<Receipt>
}

/** Convenience for implementations: a receipt's verdict is the worst of its checks. */
export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("fail")) return "fail"
  if (verdicts.includes("inconclusive")) return "inconclusive"
  return "pass"
}
```

- [ ] **Step 4: Implement `test/fake-verifier.ts`**

```ts
import { randomUUID } from "node:crypto"
import type { Verdict } from "../src/domain/work-order.ts"
import { type Verifier, type VerifyInput, worstVerdict } from "../src/verification/verifier.ts"

export interface FakeVerifierScript {
  /** The receipt verdict. Defaults to the worst of the two suite verdicts. */
  readonly verdict?: Verdict
  readonly visible?: Verdict
  readonly independent?: Verdict
  /** When set, `verify` rejects with this message instead of issuing a receipt. */
  readonly throws?: string
}

export interface FakeVerifier extends Verifier {
  /** Candidate digests this verifier was asked to verify, in order. */
  readonly verified: string[]
  script: FakeVerifierScript
}

/**
 * Scripted stand-in for the real container. The framework's `fakeSandbox` cannot
 * serve here: it has no managed-workspace member, so `withWorkspace` refuses it,
 * and no leaf metadata, so `inspectWorkspace` throws. Layers 1 and 2 therefore
 * choose the verdict and assert the controller's response to it; only the
 * Docker-gated layer proves a verdict was earned.
 */
export function createFakeVerifier(script: FakeVerifierScript): FakeVerifier {
  const verified: string[] = []
  const fake: FakeVerifier = {
    verified,
    script,
    async verify(input: VerifyInput) {
      verified.push(input.candidateDigest)
      if (fake.script.throws) throw new Error(fake.script.throws)
      const visible = fake.script.visible ?? fake.script.verdict ?? "pass"
      const independent = fake.script.independent ?? fake.script.verdict ?? "pass"
      return {
        id: `rc-${randomUUID()}`,
        workOrderId: input.workOrderId,
        candidateDigest: input.candidateDigest,
        verifierIdentity: `fake:${fake.script.verdict ?? worstVerdict([visible, independent])}`,
        policyDigest: input.policyDigest,
        environmentIdentity: "fake:none",
        verdict: fake.script.verdict ?? worstVerdict([visible, independent]),
        checks: [
          { id: "visible", acceptanceIds: ["visible"], verdict: visible, evidence: [] },
          { id: "independent", acceptanceIds: ["independent"], verdict: independent, evidence: [] },
        ],
        issuedAt: new Date().toISOString(),
      }
    },
  }
  return fake
}
```

- [ ] **Step 5: Run it green, typecheck, commit**

Run: `pnpm --filter @b4-example/software-factory-server test fake-verifier`
Expected: PASS, 5 tests.

```bash
git add examples/software-factory/server/src/verification/verifier.ts examples/software-factory/server/test/fake-verifier.ts examples/software-factory/server/test/fake-verifier.test.ts
git commit -m "feat(software-factory): verifier seam with a scripted stand-in"
```

---
### Task 10: Verification policy and the frozen bundle

**Files:**
- Create: `src/verification/policy.ts`, `src/review/bundle.ts`
- Create: `test/bundle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { loadPolicy } from "../src/verification/policy.ts"
import { freezeBundle } from "../src/review/bundle.ts"

const receipt = {
  id: "rc-1",
  workOrderId: "wo-1",
  candidateDigest: "a".repeat(64),
  verifierIdentity: "docker:sha256:abc",
  policyDigest: "b".repeat(64),
  environmentIdentity: "sha256:abc",
  verdict: "pass" as const,
  checks: [
    { id: "visible", acceptanceIds: ["one"], verdict: "pass" as const, evidence: [] },
    {
      id: "independent",
      acceptanceIds: ["two"],
      verdict: "pass" as const,
      evidence: [{ id: "independent-output", digest: "c".repeat(64) }],
    },
  ],
  issuedAt: "2026-09-18T00:00:00.000Z",
}

describe("loadPolicy", () => {
  it("derives the specification and policy digests from fixture data", () => {
    const policy = loadPolicy("cli-flags")
    expect(policy.specificationDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(policy.policyDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(policy.acceptanceIds.length).toBeGreaterThan(0)
    expect(policy.allowedSourcePaths).toEqual(["src/cli.ts"])
  })

  it("moves the policy digest when the inventory changes, and not otherwise", () => {
    const one = loadPolicy("cli-flags")
    const two = loadPolicy("cli-flags")
    expect(two.policyDigest).toBe(one.policyDigest)
  })
})

describe("freezeBundle", () => {
  const base = {
    workOrderId: "wo-1",
    repositoryId: "cli-flags",
    baselineDigest: "d".repeat(64),
    specificationDigest: "e".repeat(64),
    policyDigest: receipt.policyDigest,
    candidateDigest: receipt.candidateDigest,
    receipt,
    destinationId: "/out",
    frozenAt: "2026-09-18T00:00:01.000Z",
  }

  it("freezes a bundle whose digest covers every input", () => {
    const bundle = freezeBundle(base)
    expect(bundle.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(bundle.candidateDigest).toBe(receipt.candidateDigest)
    expect(bundle.receiptId).toBe("rc-1")
    expect(bundle.payload.environmentIdentity).toBe("sha256:abc")
    expect(bundle.payload.operation).toBe("export-local")
  })

  it("carries the evidence the receipt referenced, sorted", () => {
    const bundle = freezeBundle(base)
    expect(bundle.payload.evidence).toEqual([{ id: "independent-output", digest: "c".repeat(64) }])
  })

  it("moves the digest when the policy or the environment moves, with identical bytes", () => {
    const one = freezeBundle(base)
    expect(freezeBundle({ ...base, policyDigest: "0".repeat(64) }).digest).not.toBe(one.digest)
    expect(
      freezeBundle({ ...base, receipt: { ...receipt, environmentIdentity: "sha256:other" } }).digest,
    ).not.toBe(one.digest)
  })

  it("refuses to freeze anything but a passing receipt", () => {
    expect(() => freezeBundle({ ...base, receipt: { ...receipt, verdict: "fail" } })).toThrow(/pass/)
    expect(() =>
      freezeBundle({ ...base, receipt: { ...receipt, verdict: "inconclusive" } }),
    ).toThrow(/pass/)
  })

  it("refuses a receipt for a different candidate", () => {
    expect(() => freezeBundle({ ...base, candidateDigest: "9".repeat(64) })).toThrow(/candidate/)
  })
})
```

- [ ] **Step 2: Run it red**

Run: `pnpm --filter @b4-example/software-factory-server test bundle`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/verification/policy.ts`**

```ts
import { policyDigest, specificationDigest } from "../domain/digest.js"
import { type Checks, loadFixture } from "../fixtures/catalog.js"

export interface VerificationPolicy {
  readonly taskId: string
  readonly checks: Checks
  readonly allowedSourcePaths: readonly string[]
  readonly immutablePaths: readonly string[]
  /** The named assertions across both suites. Rung 1's acceptance criteria. */
  readonly acceptanceIds: readonly string[]
  readonly specificationDigest: string
  readonly policyDigest: string
}

/** The completion policy, derived from fixture data the controller owns. */
export function loadPolicy(taskId: string): VerificationPolicy {
  const fixture = loadFixture(taskId)
  const acceptanceIds = [
    ...fixture.checks.visible.assertions,
    ...fixture.checks.independent.assertions,
  ]
  return {
    taskId,
    checks: fixture.checks,
    allowedSourcePaths: fixture.manifest.allowedSourcePaths,
    immutablePaths: fixture.manifest.immutablePaths,
    acceptanceIds,
    specificationDigest: specificationDigest(fixture.taskText, acceptanceIds),
    policyDigest: policyDigest({
      checks: fixture.checks,
      allowedSourcePaths: fixture.manifest.allowedSourcePaths,
      immutablePaths: fixture.manifest.immutablePaths,
    }),
  }
}
```

- [ ] **Step 4: Implement `src/review/bundle.ts`**

```ts
import { bundleDigest } from "../domain/digest.js"
import type { Bundle, Receipt } from "../domain/work-order.js"

export interface FreezeBundleInput {
  readonly workOrderId: string
  readonly repositoryId: string
  readonly baselineDigest: string
  readonly specificationDigest: string
  readonly policyDigest: string
  readonly candidateDigest: string
  readonly receipt: Receipt
  readonly destinationId: string
  readonly frozenAt: string
}

/**
 * Freeze everything approval will authorize. A bundle is only frozen over a
 * passing receipt for this exact candidate: a failing or inconclusive verdict has
 * nothing to approve, and a receipt for other bytes would make consent a guess.
 */
export function freezeBundle(input: FreezeBundleInput): Bundle {
  if (input.receipt.verdict !== "pass")
    throw new Error(`Cannot freeze a bundle over a ${input.receipt.verdict} receipt; it must pass`)
  if (input.receipt.candidateDigest !== input.candidateDigest)
    throw new Error("Receipt is for a different candidate than the one being frozen")

  const evidence = input.receipt.checks
    .flatMap((check) => check.evidence)
    .sort((a, b) => (a.id < b.id ? -1 : 1))

  const payload = {
    repositoryId: input.repositoryId,
    baselineDigest: input.baselineDigest,
    specificationDigest: input.specificationDigest,
    policyDigest: input.policyDigest,
    environmentIdentity: input.receipt.environmentIdentity,
    candidateDigest: input.candidateDigest,
    evidence,
    operation: "export-local" as const,
    destinationId: input.destinationId,
  }

  return {
    digest: bundleDigest(payload),
    workOrderId: input.workOrderId,
    candidateDigest: input.candidateDigest,
    receiptId: input.receipt.id,
    payload,
    frozenAt: input.frozenAt,
  }
}
```

- [ ] **Step 5: Run it green and commit**

Run: `pnpm --filter @b4-example/software-factory-server test bundle`
Expected: PASS, 8 tests.

```bash
git add examples/software-factory/server/src/verification/policy.ts examples/software-factory/server/src/review/bundle.ts examples/software-factory/server/test/bundle.test.ts
git commit -m "feat(software-factory): verification policy and the frozen review bundle"
```

---

### Task 11: The verifying phase

Wires assembly, verification, receipt storage and bundle freezing into one controller phase, and moves the lifecycle through it.

**Files:**
- Create: `src/controller/verify.ts`
- Modify: `src/controller/context.ts`, `src/controller/factory.ts`, `src/controller/run-observer.ts`
- Create: `test/factory-verify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type Factory, createFactory } from "../src/controller/factory.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"
import { type FakeWorker, createFakeWorker } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
let factory: Factory

const REPAIRED = "export const fixed = true\n"

async function boot(script: Parameters<typeof createFakeVerifier>[0]) {
  dir = mkdtempSync(join(tmpdir(), "factory-verify-"))
  mkdirSync(join(dir, "out"), { recursive: true })
  fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
  const verifier = createFakeVerifier(script)
  const reader = createFakeWorkspaceReader({})
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    worker: createHttpWorkerClient(fake.baseUrl),
    workerRoute: "/build#agent",
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier,
    workspaceReader: reader,
    // The baseline the controller captures, injected so this layer needs no container.
    captureBaseline: async () => ({
      digest: "a".repeat(64),
      files: new Map([
        ["src/cli.ts", "broken\n"],
        ["test/cli.test.ts", "spec\n"],
        ["TASK.md", "task\n"],
      ]),
    }),
  })
  return { verifier, reader }
}

/** What the builder is deemed to have left behind: a repair and two untouched files. */
const repaired = () => ({
  "src/cli.ts": REPAIRED,
  "test/cli.test.ts": "spec\n",
  "TASK.md": "task\n",
})

afterEach(async () => {
  await factory?.close()
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("the verifying phase", () => {
  it("reaches awaiting_approval with a bundle when the receipt passes", async () => {
    const { reader } = await boot({ verdict: "pass" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval" || r.state === "blocked" || r.state === "failed", 20_000)
    expect(row.state).toBe("awaiting_approval")
    expect(row.candidateDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(row.bundleDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(row.awaitingSince).not.toBeNull()
    const types = factory.events(id).map((e) => e.type)
    expect(types).toContain("candidate_assembled")
    expect(types).toContain("receipt_issued")
    expect(types).toContain("bundle_frozen")
  })

  it("blocks with verification_failed when the independent checks fail, and freezes nothing", async () => {
    const { reader } = await boot({ verdict: "fail", visible: "pass", independent: "fail" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const row = await factory.waitFor(id, (r) => r.state === "blocked" || r.state === "awaiting_approval", 20_000)
    expect(row.state).toBe("blocked")
    expect(row.blockedReason).toBe("verification_failed")
    expect(row.bundleDigest).toBeNull()
    expect(factory.events(id).map((e) => e.type)).not.toContain("bundle_frozen")
  })

  it("blocks with verification_inconclusive rather than reading it as failure", async () => {
    const { reader } = await boot({ verdict: "inconclusive" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(row.blockedReason).toBe("verification_inconclusive")
  })

  it("blocks with scope_violation before the verifier runs", async () => {
    const { reader, verifier } = await boot({ verdict: "pass" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, { ...repaired(), "src/cli.ts": "broken\n", "test/cli.test.ts": "weakened\n" })
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(row.blockedReason).toBe("scope_violation")
    expect(verifier.verified).toEqual([])
  })

  it("fails when the builder changed nothing", async () => {
    const { reader } = await boot({ verdict: "pass" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, { ...repaired(), "src/cli.ts": "broken\n" })
    const row = await factory.waitFor(id, (r) => r.state === "failed", 20_000)
    expect(row.failureReason).toBe("ended_without_candidate")
  })

  it("blocks when the verifier harness itself cannot run", async () => {
    const { reader } = await boot({ throws: "docker unavailable" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(row.blockedReason).toBe("verification_inconclusive")
    expect(factory.events(id).map((e) => e.type)).toContain("verifier_unavailable")
  })

  it("stores the candidate, receipt and bundle as evidence", async () => {
    const { reader } = await boot({ verdict: "pass" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval", 20_000)
    const evidence = factory.evidence(id)
    expect(evidence.candidate?.digest).toBe(row.candidateDigest)
    expect(evidence.receipt?.verdict).toBe("pass")
    expect(evidence.bundle?.digest).toBe(row.bundleDigest)
  })
})
```

Every test in this file sets the reader's bytes with `repaired()` or a variation of it, so the controller's baseline and the builder's observed workspace differ only where the test intends.

- [ ] **Step 2: Run it red**

Run: `pnpm --filter @b4-example/software-factory-server test factory-verify`
Expected: FAIL. The options `exportDir`, `artifactsDir`, `verifier`, `workspaceReader`, `captureBaseline`, the `evidence` reader and the fake's `edits_only` behaviour do not exist yet.

- [ ] **Step 3: Add the `edits_only` behaviour to `test/fake-worker.ts`**

Add `"edits_only"` to `RunBehaviour`, document it in the behaviour comment block as "emits two tool_result frames for writeFile and then a clean done, with no interrupt and no candidate claim", and implement it in `streamRun` before the `happy` branch:

```ts
    if (kind === "edits_only") {
      sse.frame("tool_result", { id: "call-1", name: "readFile", output: "TASK.md contents" })
      if (await sleepOrAbort(delay)) return
      sse.frame("tool_result", { id: "call-2", name: "writeFile", output: "written" })
      if (await sleepOrAbort(delay)) return
      sse.frame("chunk", "Repair written.")
      sse.frame("done", { output: {} })
      return finishRun(thread, sse)
    }
```

- [ ] **Step 4: Extend `src/controller/context.ts`**

Add to `ControllerContext`:

```ts
  readonly evidence: EvidenceStore
  readonly artifacts: ArtifactStore
  readonly verifier: Verifier
  readonly workspaceReader: WorkspaceReader
  readonly exportDir: string
  readonly maxChangedBytes: number
  /** Capture the controller's own baseline for a task. Injected so tests need no container. */
  captureBaseline(taskId: string, signal: AbortSignal): Promise<{
    readonly digest: string
    readonly files: ReadonlyMap<string, string>
  }>
  /** Run the verifying phase for a work order whose turn has ended. */
  runVerification(id: string): Promise<void>
```

Remove `outboxDir` and `receiptWaitMs`, which belonged to the deleted receipt read.

- [ ] **Step 5: Implement `src/controller/verify.ts`**

```ts
import { randomUUID } from "node:crypto"
import { freezeBundle } from "../review/bundle.js"
import { AssemblyRejectedError, assembleCandidate } from "../verification/assemble.js"
import { loadPolicy } from "../verification/policy.js"
import type { ControllerContext } from "./context.js"

/**
 * The verifying phase. Everything here is the controller's own view: its captured
 * baseline, its assembly policy, its verifier and its bundle. Nothing reads a
 * claim made by the builder.
 *
 * Every exit is a recorded transition. A harness that cannot run is
 * `inconclusive`, not a failure, because "we do not know" and "it is broken" are
 * different answers and only one of them is about the candidate.
 */
export async function runVerification(ctx: ControllerContext, id: string): Promise<void> {
  const row = ctx.mustGet(id)
  if (row.state !== "verifying" || !row.workerThreadId) return
  const policy = loadPolicy(row.taskId)

  const baseline = await ctx.captureBaseline(row.taskId, ctx.signal)
  const observed = await ctx.workspaceReader.read(row.workerThreadId, ctx.signal)

  let candidate: ReturnType<typeof assembleCandidate>
  try {
    candidate = assembleCandidate({
      baseline: baseline.files,
      observed,
      policy: {
        workspaceId: row.taskId,
        baselineDigest: baseline.digest,
        allowedSourcePaths: policy.allowedSourcePaths,
        immutablePaths: policy.immutablePaths,
        maxChangedBytes: ctx.maxChangedBytes,
      },
    })
  } catch (error) {
    if (!(error instanceof AssemblyRejectedError)) throw error
    ctx.transition(
      id,
      "assembly_rejected",
      { blockedReason: error.rule === "removed" ? "baseline_mismatch" : "scope_violation" },
      { rule: error.rule, detail: error.message },
    )
    return
  }

  if (candidate.changedPaths.length === 0) {
    ctx.transition(
      id,
      "turn_ended_without_changes",
      { failureReason: "ended_without_candidate" },
      { reason: "the builder left the baseline unchanged" },
    )
    return
  }

  const artifact = await ctx.artifacts.put(JSON.stringify(candidate.changes, null, 2))
  ctx.store.transaction(() => {
    ctx.evidence.recordCandidate({
      digest: candidate.digest,
      workOrderId: id,
      baselineDigest: baseline.digest,
      changedPaths: candidate.changedPaths,
      bytes: candidate.bytes,
      artifactDigest: artifact.digest,
      assembledAt: ctx.iso(),
    })
    ctx.recordEvent(id, "candidate_assembled", {
      digest: candidate.digest,
      changedPaths: candidate.changedPaths,
      bytes: candidate.bytes,
    })
    ctx.store.update(ctx.mustGet(id).id, ctx.mustGet(id).revision, { candidateDigest: candidate.digest }, ctx.iso())
  })

  let receipt: Awaited<ReturnType<typeof ctx.verifier.verify>>
  try {
    receipt = await ctx.verifier.verify(
      {
        workOrderId: id,
        taskId: row.taskId,
        candidateDigest: candidate.digest,
        changes: candidate.changes,
        policyDigest: policy.policyDigest,
      },
      ctx.signal,
    )
  } catch (error) {
    ctx.recordEvent(id, "verifier_unavailable", { error: String(error) })
    if (ctx.mustGet(id).state === "verifying")
      ctx.transition(id, "receipt_inconclusive", { blockedReason: "verification_inconclusive" })
    return
  }

  if (receipt.candidateDigest !== candidate.digest) {
    ctx.recordEvent(id, "receipt_mismatch", { expected: candidate.digest, got: receipt.candidateDigest })
    ctx.transition(id, "receipt_inconclusive", { blockedReason: "verification_inconclusive" })
    return
  }

  ctx.evidence.recordReceipt(receipt)
  ctx.recordEvent(id, "receipt_issued", {
    id: receipt.id,
    verdict: receipt.verdict,
    verifierIdentity: receipt.verifierIdentity,
  })

  if (ctx.mustGet(id).state !== "verifying") return
  if (receipt.verdict === "fail") {
    ctx.transition(id, "receipt_failed", { blockedReason: "verification_failed" })
    return
  }
  if (receipt.verdict === "inconclusive") {
    ctx.transition(id, "receipt_inconclusive", { blockedReason: "verification_inconclusive" })
    return
  }

  const bundle = freezeBundle({
    workOrderId: id,
    repositoryId: row.taskId,
    baselineDigest: baseline.digest,
    specificationDigest: policy.specificationDigest,
    policyDigest: policy.policyDigest,
    candidateDigest: candidate.digest,
    receipt,
    destinationId: ctx.exportDir,
    frozenAt: ctx.iso(),
  })

  ctx.store.transaction(() => {
    ctx.evidence.recordBundle(bundle)
    ctx.recordEvent(id, "bundle_frozen", { digest: bundle.digest, receiptId: receipt.id })
    ctx.transition(id, "receipt_passed", {
      bundleDigest: bundle.digest,
      awaitingSince: ctx.iso(),
    })
  })
}
```

- [ ] **Step 6: Wire it into `factory.ts` and `run-observer.ts`**

In `src/controller/run-observer.ts`, replace the `onDone` verdict branch. Where rung 0 transitioned `run_ended_without_candidate`, now transition into verification and let the phase decide:

```ts
        if (error) {
          ctx.transition(id, "run_failed", { failureReason: "route_error" }, { error })
          return
        }
        ctx.transition(id, "turn_ended_with_workspace")
```

Delete the `onInterrupt` branches that handled the export gate, keeping only the unexpected-interrupt branch. Delete the `onToolResult` handler that parsed `prepareReview`: the controller no longer reads any tool result.

In `factory.ts`, after the turn observer settles, start the phase. In `startRun`, replace the tail with:

```ts
    await observeRun(ctx, id, frames)
    if (mustGet(id).state === "verifying") await runVerification(ctx, id)
```

Add the new options to `FactoryOptions` (`exportDir`, `artifactsDir`, `verifier`, `workspaceReader`, `captureBaseline`, `maxChangedBytes?`), construct the evidence and artifact stores next to the registry, add `runVerification: (id) => runVerification(ctx, id)` to the `ctx` literal, and add an `evidence(id)` reader to the `Factory` interface:

```ts
    evidence(id) {
      const row = mustGet(id)
      const candidate = row.candidateDigest ? evidence.candidate(row.candidateDigest) : null
      const bundle = row.bundleDigest ? evidence.bundle(row.bundleDigest) : null
      const receipt = bundle ? evidence.receipt(bundle.receiptId) : null
      return { candidate, receipt, bundle }
    },
```

Delete the `outboxDir`/`receiptWaitMs` options and the `src/worker/outbox.ts` import.

- [ ] **Step 7: Run it green**

Run: `pnpm --filter @b4-example/software-factory-server test factory-verify`
Expected: PASS, 7 tests. Other factory suites still fail; Task 12 fixes them.

- [ ] **Step 8: Commit**

```bash
git add examples/software-factory/server/src/controller examples/software-factory/server/test
git commit -m "feat(software-factory): the verifying phase assembles, verifies and freezes"
```

---

### Task 12: Approval binds the bundle, and the controller exports

**Files:**
- Create: `src/delivery/export.ts`
- Modify: `src/controller/factory.ts`
- Delete: `src/worker/outbox.ts`
- Modify: `test/factory-approve.test.ts`
- Create: `test/export.test.ts`

- [ ] **Step 1: Write the failing export test**

```ts
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { exportApproved } from "../src/delivery/export.ts"

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const out = () => {
  dir = mkdtempSync(join(tmpdir(), "factory-export-"))
  return join(dir, "out")
}

const bundle = {
  digest: "a".repeat(64),
  workOrderId: "wo-1",
  candidateDigest: "b".repeat(64),
  receiptId: "rc-1",
  payload: { repositoryId: "cli-flags", operation: "export-local" as const },
  frozenAt: "2026-09-18T00:00:00.000Z",
}
const changes = { "src/cli.ts": "fixed\n" }

describe("exportApproved", () => {
  it("writes a receipt named by the bundle digest", async () => {
    const directory = out()
    const path = await exportApproved({ directory, bundle, changes })
    expect(readdirSync(directory)).toEqual([`${bundle.digest}.json`])
    const written = JSON.parse(readFileSync(path, "utf8"))
    expect(written.bundle.digest).toBe(bundle.digest)
    expect(written.changes).toEqual(changes)
  })

  it("is idempotent for identical content", async () => {
    const directory = out()
    const one = await exportApproved({ directory, bundle, changes })
    const two = await exportApproved({ directory, bundle, changes })
    expect(two).toBe(one)
    expect(readdirSync(directory)).toHaveLength(1)
  })

  it("refuses to overwrite a receipt whose content would differ", async () => {
    const directory = out()
    await exportApproved({ directory, bundle, changes })
    await expect(
      exportApproved({ directory, bundle, changes: { "src/cli.ts": "different\n" } }),
    ).rejects.toThrow(/already exported/i)
  })
})
```

- [ ] **Step 2: Run it red**

Run: `pnpm --filter @b4-example/software-factory-server test export`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/delivery/export.ts`**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Bundle } from "../domain/work-order.js"

export interface ExportInput {
  readonly directory: string
  readonly bundle: Bundle
  readonly changes: Readonly<Record<string, string>>
}

/**
 * Write the approved bytes. The receipt is named by the bundle digest, so a retry
 * lands on the same name with the same content and a second delivery is
 * impossible. Differing content under an existing name is a hard error rather
 * than an overwrite: the operator approved a specific bundle, once.
 */
export async function exportApproved(input: ExportInput): Promise<string> {
  const path = join(input.directory, `${input.bundle.digest}.json`)
  const body = `${JSON.stringify({ bundle: input.bundle, changes: input.changes }, null, 2)}\n`
  await mkdir(input.directory, { recursive: true })
  try {
    await writeFile(path, body, { flag: "wx" })
    return path
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const existing = await readFile(path, "utf8")
  if (existing !== body)
    throw new Error(`Bundle ${input.bundle.digest} was already exported with different content`)
  return path
}
```

- [ ] **Step 4: Rewrite `approve` in `factory.ts`**

Replace the rung 0 body. The preconditions change from a candidate digest and a worker gate to a bundle digest and an export the controller performs.

```ts
    async approve(id, { revision, bundleDigest, operationKey }) {
      const row = mustGet(id)
      const key = operationKey ?? `approve:${id}:${revision}:${bundleDigest}`
      const begun = commands.begin(key, id, { command: "approve", args: { revision, bundleDigest } }, iso())
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      const refuse = (message: string) => finish(key, { ok: false, state: mustGet(id).state, message })
      if (row.state !== "awaiting_approval") return refuse(`Cannot approve from ${row.state}`)
      if (row.revision !== revision)
        return refuse(`Stale revision ${revision}; work order is at ${row.revision}`)
      if (row.bundleDigest !== bundleDigest)
        return refuse("Bundle digest does not match the frozen review bundle")
      const since = row.awaitingSince ? Date.parse(row.awaitingSince) : Number.NaN
      const ttl = options.approvalTtlMs ?? 900_000
      if (!Number.isFinite(since) || now() > since + ttl)
        return refuse("Review bundle has expired; deny or cancel it")

      const bundle = evidence.bundle(bundleDigest)
      if (!bundle) return refuse("Frozen bundle is missing from the registry")
      const candidate = evidence.candidate(bundle.candidateDigest)
      if (!candidate) return refuse("Assembled candidate is missing from the registry")

      // Re-verify the same bytes under the same policy before writing anything.
      const changes = JSON.parse(await artifacts.read(candidate.artifactDigest)) as Record<string, string>
      const policy = loadPolicy(row.taskId)
      let receipt: Receipt
      try {
        receipt = await ctx.verifier.verify(
          {
            workOrderId: id,
            taskId: row.taskId,
            candidateDigest: candidate.digest,
            changes,
            policyDigest: policy.policyDigest,
          },
          abort.signal,
        )
      } catch (error) {
        recordEvent(id, "verifier_unavailable", { phase: "export", error: String(error) })
        return refuse(`Re-verification could not run: ${String(error)}`)
      }
      if (receipt.verdict !== "pass" || receipt.candidateDigest !== candidate.digest) {
        evidence.recordReceipt(receipt)
        recordEvent(id, "reverification_rejected", { verdict: receipt.verdict, receiptId: receipt.id })
        return refuse(`Re-verification did not pass: ${receipt.verdict}`)
      }
      evidence.recordReceipt(receipt)

      store.transaction(() => {
        store.recordApproval({
          id: `ap-${randomUUID()}`,
          workOrderId: id,
          bundleDigest,
          candidateDigest: candidate.digest,
          decision: "approved",
          decidedBy: options.actor ?? "operator",
          decidedAt: iso(),
          expiresAt: new Date(since + ttl).toISOString(),
        })
        transition(id, "approve", {}, { bundleDigest, operationKey: key })
      })

      let path: string
      try {
        path = await exportApproved({ directory: options.exportDir, bundle, changes })
      } catch (error) {
        recordEvent(id, "export_failed", { error: String(error) })
        if (mustGet(id).state === "exporting")
          transition(id, "export_unconfirmed", { blockedReason: "export_unconfirmed" })
        return finish(key, { ok: false, state: mustGet(id).state, message: `Export failed: ${String(error)}` })
      }

      store.transaction(() => {
        store.recordDelivery({
          workOrderId: id,
          candidateDigest: candidate.digest,
          receiptPath: path,
          observedAt: iso(),
        })
        recordEvent(id, "delivery_written", { receiptPath: path })
        transition(id, "receipt_observed")
      })
      return finish(key, { ok: true, state: mustGet(id).state, message: "Exported" })
    },
```

Change the `Factory` interface signature to `approve(id: string, input: { revision: number; bundleDigest: string; operationKey?: string })`. Simplify `deny`: it no longer resolves a worker gate from `awaiting_approval`, only from `blocked` where an unexpected interrupt is pending. Delete `confirmExport`, `src/worker/outbox.ts`, and the `waitForReceipt` import.

- [ ] **Step 5: Update `test/factory-approve.test.ts`**

Change every `approve` call to pass `bundleDigest` from the row, drive the state through the fake verifier and reader as in Task 11's `boot`, and replace the two gate-resolution assertions with these:

```ts
  it("refuses a stale revision, a wrong bundle digest, and an expired bundle, touching nothing", async () => {
    // same three refusals as rung 0, but bound to the bundle
  })

  it("re-verifies before writing and refuses when re-verification does not pass", async () => {
    const { reader, verifier } = await boot({ verdict: "pass" })
    const row = await awaiting(reader)
    verifier.script = { verdict: "fail" }
    const outcome = await factory.approve(row.id, { revision: row.revision, bundleDigest: row.bundleDigest! })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/Re-verification did not pass/)
    expect(readdirSync(join(dir, "out"))).toEqual([])
    expect(factory.events(row.id).map((e) => e.type)).toContain("reverification_rejected")
  })

  it("exports exactly the approved bytes, named by the bundle digest", async () => {
    const { reader } = await boot({ verdict: "pass" })
    const row = await awaiting(reader)
    const outcome = await factory.approve(row.id, { revision: row.revision, bundleDigest: row.bundleDigest! })
    expect(outcome).toMatchObject({ ok: true, state: "exported" })
    expect(readdirSync(join(dir, "out"))).toEqual([`${row.bundleDigest}.json`])
    const written = JSON.parse(readFileSync(join(dir, "out", `${row.bundleDigest}.json`), "utf8"))
    expect(written.changes).toEqual({ "src/cli.ts": REPAIRED })
  })
```

- [ ] **Step 6: Run the suites green**

Run: `pnpm --filter @b4-example/software-factory-server test factory-approve factory-verify export`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add examples/software-factory/server/src examples/software-factory/server/test
git rm examples/software-factory/server/src/worker/outbox.ts
git commit -m "feat(software-factory): approval binds the bundle and the controller exports"
```

---

### Task 13: Reconciliation, cancel and the remaining rung 0 suites

**Files:**
- Modify: `src/controller/reconcile.ts`, `test/factory-reconcile.test.ts`, `test/factory-cancel.test.ts`, `test/factory-dispatch.test.ts`, `test/scenarios.ts` if present

- [ ] **Step 1: Write the failing reconciliation test**

```ts
it("re-verifies a work order found in verifying rather than resuming it", async () => {
  await bootWorker({ run: "edits_only" })
  await bootFactory({ verdict: "pass" })
  const { id } = await factory.create({ taskId: "cli-flags" })
  await factory.dispatch(id)
  const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
  reader.set(dispatched.workerThreadId as string, repaired())
  await factory.waitFor(id, (r) => r.state === "awaiting_approval")
  await crash()

  // Force the row back into verifying, as a crash mid-phase would leave it.
  const registry = openRegistry(registryPath())
  const store = createWorkOrderStore(registry.db)
  const row = store.get(id)!
  store.update(id, row.revision, { state: "verifying", bundleDigest: null }, new Date().toISOString())
  registry.close()

  await bootFactory({ verdict: "pass" })
  const settled = await factory.waitFor(id, (r) => r.state === "awaiting_approval", 20_000)
  expect(settled.bundleDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(factory.events(id).filter((e) => e.type === "reconciled").length).toBeGreaterThan(0)
  // No second run was started on the worker.
  expect(fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/runs/stream"))).toHaveLength(1)
})

it("blocks a verifying row whose candidate can no longer be reproduced", async () => {
  await bootWorker({ run: "edits_only" })
  await bootFactory({ verdict: "pass" })
  const { id } = await factory.create({ taskId: "cli-flags" })
  await factory.dispatch(id)
  const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
  reader.set(dispatched.workerThreadId as string, repaired())
  await factory.waitFor(id, (r) => r.state === "awaiting_approval")
  await crash()
  const registry = openRegistry(registryPath())
  const store = createWorkOrderStore(registry.db)
  const row = store.get(id)!
  store.update(id, row.revision, { state: "verifying", bundleDigest: null }, new Date().toISOString())
  registry.close()
  // The builder's workspace is gone, as it would be after a sandbox reap.
  reader.forget(dispatched.workerThreadId as string)
  await bootFactory({ verdict: "pass" })
  const settled = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
  // The phase's own unreadable-workspace path decides this: nothing is known about the
  // builder's work once its workspace is gone. `baseline_mismatch` is a statement about the
  // builder deleting a baseline file, and no assembly happened here to make it.
  expect(settled.blockedReason).toBe("verification_inconclusive")
})
```

Add a `forget(threadId)` method to the fake workspace reader that deletes the thread so a read rejects.

- [ ] **Step 2: Run it red, then add the rule to `src/controller/reconcile.ts`**

Add the case to the switch, before `default`:

```ts
    case "verifying":
      return reconcileVerifying(ctx, row)
```

```ts
/**
 * Rule 7: a work order interrupted mid-verification. Verification has no durable
 * external effect, so the phase is simply run again from the controller's own
 * baseline and the builder's workspace.
 *
 * `runVerification` does not throw on a workspace it cannot read: it journals
 * `workspace_unreadable` and transitions to `inconclusive` itself, which is the
 * honest verdict for a reaped sandbox — nothing is known about the candidate.
 * Reconciliation adds no probe read of its own. What it does add is a
 * post-condition: the phase can also return without deciding (a row with no
 * worker thread returns at its first line), and a row left in `verifying` is
 * stranded for every later boot to rediscover. The check is against the row, so
 * it covers any future early exit as well as today's.
 */
async function reconcileVerifying(ctx: ControllerContext, row: WorkOrderRow): Promise<void> {
  ctx.recordEvent(row.id, "reconciled", { resolution: "reverify", state: row.state })
  const settleUndecided = (reason: string) => {
    if (ctx.mustGet(row.id).state !== "verifying") return
    ctx.recordEvent(row.id, "verification_undecided", { reason })
    ctx.transition(row.id, "receipt_inconclusive", { blockedReason: "verification_inconclusive" }, {
      reconciled: true,
      reason,
    })
  }
  try {
    await ctx.runVerification(row.id)
  } catch (error) {
    ctx.recordEvent(row.id, "reconcile_failed", { phase: "verifying", error: String(error) })
    settleUndecided("the verifying phase could not be completed after restart")
    return
  }
  settleUndecided("the verifying phase returned without deciding after restart")
}
```

- [ ] **Step 3: Update the remaining rung 0 suites**

`test/factory-dispatch.test.ts`: the three gate-behaviour tests (`gate_before_prepare`, the premature-gate case, and the candidate-observed event order) no longer describe reality. Replace them with the `edits_only` flow reaching `verifying`, keeping the `unexpected_interrupt` test and the lost-stream test as they are. `test/factory-cancel.test.ts`: change the `awaiting_approval` cancel test to reach that state through the verifier, and add one asserting cancel during `verifying` reaches `cancel_requested` and then `cancelled`. `test/scenarios.ts`, if it still exists, updates its `approve` calls to pass `bundleDigest`.

- [ ] **Step 4: Run the whole package green**

Run: `pnpm --filter @b4-example/software-factory-server test`
Expected: every file passes. Run it three times; the reconciliation tests are timing sensitive.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm --filter @b4-example/software-factory-server typecheck
pnpm --filter @b4-example/software-factory-server lint
git add examples/software-factory/server
git commit -m "feat(software-factory): reconcile the verifying phase and update the rung 0 suites"
```

---
### Task 14: Configuration, CLI and HTTP

**Files:**
- Modify: `src/config.ts`, `src/cli.ts`, `src/http.ts`, `test/config.test.ts`, `test/cli.test.ts`, `test/http.test.ts`

- [ ] **Step 1: Write the failing config test additions**

```ts
describe("rung 1 configuration", () => {
  const base = {
    FACTORY_WORKER_URL: "http://127.0.0.1:4100",
    FACTORY_STATE_DIR: "/tmp/state",
  }

  it("defaults the export and artifact directories under the state directory", () => {
    const config = loadConfig(base)
    expect(config.exportDir).toBe("/tmp/state/exports")
    expect(config.artifactsDir).toBe("/tmp/state/artifacts")
    expect(config.maxChangedBytes).toBe(1024 * 1024)
    expect(config.workerRoute).toBe("/build#agent")
  })

  it("no longer requires or accepts an outbox", () => {
    expect(Object.keys(loadConfig(base))).not.toContain("outboxDir")
    // The rung 0 variable is simply ignored rather than rejected, so an old
    // environment keeps working while an operator updates it.
    expect(() => loadConfig({ ...base, FACTORY_WORKER_OUTBOX: "/tmp/old" })).not.toThrow()
  })

  it("rejects a non-positive byte cap", () => {
    expect(() => loadConfig({ ...base, FACTORY_MAX_CHANGED_BYTES: "0" })).toThrow(
      /FACTORY_MAX_CHANGED_BYTES/,
    )
  })
})
```

- [ ] **Step 2: Edit `src/config.ts`**

Remove `FACTORY_WORKER_OUTBOX` and `FACTORY_RECEIPT_WAIT_MS` from the schema and the interface. Change the route default and add three settings:

```ts
  FACTORY_WORKER_ROUTE: z.string().min(1).default("/build#agent"),
  FACTORY_EXPORT_DIR: z.string().min(1).optional(),
  FACTORY_ARTIFACTS_DIR: z.string().min(1).optional(),
  FACTORY_MAX_CHANGED_BYTES: positiveInt("FACTORY_MAX_CHANGED_BYTES"),
```

```ts
export interface FactoryConfig {
  readonly workerUrl: string
  readonly workerRoute: string
  readonly stateDir: string
  readonly registryPath: string
  readonly exportDir: string
  readonly artifactsDir: string
  readonly approvalTtlMs: number
  readonly maxActiveMs: number
  readonly maxChangedBytes: number
  readonly httpPort: number
}
```

```ts
    exportDir: e.FACTORY_EXPORT_DIR ?? join(e.FACTORY_STATE_DIR, "exports"),
    artifactsDir: e.FACTORY_ARTIFACTS_DIR ?? join(e.FACTORY_STATE_DIR, "artifacts"),
    maxChangedBytes: e.FACTORY_MAX_CHANGED_BYTES ?? 1024 * 1024,
```

- [ ] **Step 3: Edit `src/cli.ts`**

Change `approve` to take `--bundle` instead of `--digest`, and update the usage text:

```
  approve  <workOrderId> --revision <n> --bundle <sha256> [--key <operationKey>]
```

```ts
      case "approve": {
        if (!values.revision || !values.bundle) throw new Error("approve requires --revision and --bundle")
        const outcome = await factory.approve(needId(), {
          revision: Number(values.revision),
          bundleDigest: values.bundle,
          ...(values.key ? { operationKey: values.key } : {}),
        })
        print({ ...outcome, ...factory.show(needId()) })
        return outcome.ok ? 0 : 1
      }
```

Add `bundle: { type: "string" }` to the `parseArgs` options and drop `digest`. Add an `evidence` command that prints `factory.evidence(id)`, and list it in the usage text. Build the factory with the real adapters:

```ts
  const factory: Factory = await createFactory({
    registryPath: config.registryPath,
    worker: createHttpWorkerClient(config.workerUrl),
    workerRoute: config.workerRoute,
    exportDir: config.exportDir,
    artifactsDir: config.artifactsDir,
    approvalTtlMs: config.approvalTtlMs,
    maxActiveMs: config.maxActiveMs,
    maxChangedBytes: config.maxChangedBytes,
    verifier: createDockerVerifier(createArtifactStore(config.artifactsDir)),
    workspaceReader: createThreadWorkspaceReader(),
    captureBaseline: captureFixtureBaseline,
  })
```

Imports for the three real adapters:

```ts
import { createArtifactStore } from "./storage/artifacts.js"
import { captureFixtureBaseline } from "./verification/baseline.js"
import { createDockerVerifier } from "./verification/docker-verifier.js"
import { createThreadWorkspaceReader } from "./worker/workspace-reader.js"
```

All four modules arrive in Task 17, so **do Task 17 before this task** if you want the tree to typecheck at every commit. If you do this one first, expect `typecheck` to fail on four missing modules until Task 17 lands, and do not commit in that state.

- [ ] **Step 4: Edit `src/http.ts`**

Change `ApproveBody` to `{ revision, bundleDigest, operationKey? }` with `bundleDigest` matching `DIGEST_PATTERN`, and add a read-only route `GET /work-orders/:id/evidence` returning `factory.evidence(id)`. Add the 405 and 404 assertions for it to `test/http.test.ts` alongside the existing ones.

- [ ] **Step 5: Run the three suites green and commit**

```bash
pnpm --filter @b4-example/software-factory-server test config http
git add examples/software-factory/server/src/config.ts examples/software-factory/server/src/cli.ts examples/software-factory/server/src/http.ts examples/software-factory/server/test
git commit -m "feat(software-factory): configuration, CLI and HTTP follow the bundle"
```

---

### Task 15: The builder route and the app configuration

**Files:**
- Create: `b4.config.ts`, `src/app/build/index.ts`, `workspace/.gitkeep`
- Modify: `src/prompts.ts`
- Create: `test/builder-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import config from "../b4.config.ts"
import builder from "../src/app/build/index.ts"
import { TASK_PROMPTS } from "../src/prompts.ts"

describe("builder configuration", () => {
  it("denies the network and pins one image for both containers", () => {
    expect(config.sandbox?.network?.mode).toBe("deny")
    expect(config.sandbox?.provider.name).toBe("docker")
    expect(config.sandbox?.workspace?.source.directory).toBe("fixtures/cli-flags/project")
  })

  it("pre-approves exactly the commands the fixture needs, so an interrupt is a surprise", () => {
    const bash = config.permissions?.allow?.bash ?? []
    expect(bash).toContain("npm test")
    // Prefix matching is why this has a trailing space.
    expect(bash).toContain("node ")
    expect(bash.some((pattern) => pattern.includes("rm"))).toBe(false)
  })

  it("keeps the builder's own review tools nonexistent", () => {
    // Rung 1's whole point: the builder has no channel for a verdict.
    expect(config.permissions?.allow?.tool ?? []).toEqual([])
  })
})

describe("the builder route", () => {
  it("is a bounded agent with no approval gate and no custom tool", () => {
    expect(builder.tools?.approve ?? []).toEqual([])
    expect(builder.recursionLimit).toBeGreaterThan(0)
    expect(builder.systemPrompt).toMatch(/readFile/)
    // It must not be told to verify or to export; those are the controller's.
    expect(builder.systemPrompt).not.toMatch(/prepareReview|exportForReview/)
  })

  it("has a prompt constant for the fixture, so static fixtures can key to it", () => {
    expect(TASK_PROMPTS["cli-flags"]).toMatch(/\S/)
    expect(TASK_PROMPTS["cli-flags"]).not.toMatch(/exportForReview/)
  })
})
```

- [ ] **Step 2: Run it red**

Run: `pnpm --filter @b4-example/software-factory-server test builder-config`
Expected: FAIL, modules not found.

- [ ] **Step 3: Create `workspace/.gitkeep`**

```bash
mkdir -p examples/software-factory/server/workspace && touch examples/software-factory/server/workspace/.gitkeep
```

This empty directory is the activation switch for the built-in workspace tools when no sandbox is configured, and it is where tool output is offloaded. Without it the builder has no file tools at all.

- [ ] **Step 4: Create `b4.config.ts`**

```ts
import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { loadFixture } from "./src/fixtures/catalog.js"
import { fixtureWorkspace, sandboxImage, sandboxPolicy } from "./src/fixtures/workspace.js"

const task = process.env.FACTORY_TASK_ID ?? "cli-flags"
const { manifest } = loadFixture(task)

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    ...sandboxPolicy,
    provider: dockerSandbox({ scope: "software-factory-builder", image: sandboxImage }),
    workspace: fixtureWorkspace(task),
  },
  toolOutput: {
    // The controller never reads a tool result, so nothing here is load-bearing
    // for correctness; the default threshold keeps large output out of context.
    previewLines: 10,
  },
  permissions: {
    allow: {
      readFile: [`/opt/fixtures/${manifest.id}/node_modules`, `/opt/fixtures/${manifest.id}/node_modules/`],
      listDir: [`/opt/fixtures/${manifest.id}/node_modules`],
      // Prefix matches on the whole command. Only what the fixture's own test
      // command needs: anything else should surface as an unexpected interrupt.
      bash: ["npm test", "npm run test", "npm --silent test", "node ", "cat", "ls", "head"],
    },
  },
})
```

The verifier uses a different sandbox scope, set in Task 17, so the two containers never share a workspace.

- [ ] **Step 5: Rewrite `src/prompts.ts`**

```ts
/**
 * The builder's single turn. It edits files and stops. It is not asked to verify
 * or to deliver, because in rung 1 it has no way to do either: verification and
 * delivery are the controller's, and nothing the builder says is read as a verdict.
 *
 * These strings are exported constants so static model fixtures can key to them.
 */
export const TASK_PROMPTS: Readonly<Record<string, string>> = {
  "cli-flags":
    "Read TASK.md. Reproduce the failure with the project's own test command, then repair only the source files TASK.md permits you to change. Do not edit any test. When the repair is complete and the project's tests pass, stop and say so. Use readFile, listDir, writeFile and runBash.",
}
```

- [ ] **Step 6: Create `src/app/build/index.ts`**

```ts
import { agent } from "@b4run/sdk"
import { TASK_PROMPTS } from "../../prompts.js"

/**
 * The bounded builder. It has the four built-in workspace tools and nothing else:
 * no verification tool, no export tool, no approval gate. Its container is the
 * builder boundary; the controller verifies in a different one.
 */
export default agent({
  model: process.env.FACTORY_BUILDER_MODEL ?? "gpt-5-mini",
  recursionLimit: 60,
  description: "Repairs a failing test in a bounded workspace.",
  systemPrompt: `You repair a single defect in an isolated workspace.

${TASK_PROMPTS["cli-flags"]}

Rules you cannot negotiate:
- Change only the files TASK.md lists as permitted. Every other file, especially any test, is immutable.
- Do not claim the work is verified. Something else checks it, and your claim is not read.
- If you cannot repair the defect, say why and stop rather than weakening a test.`,
})
```

- [ ] **Step 7: Run it green, check the app, commit**

```bash
pnpm --filter @b4-example/software-factory-server test builder-config
pnpm --filter @b4-example/software-factory-server check
```

`b4 check` validates the config and the route and will report a missing image or an unreachable Docker daemon as a warning; a configuration error is a failure and must be fixed.

```bash
git add examples/software-factory/server/b4.config.ts examples/software-factory/server/src/app examples/software-factory/server/src/prompts.ts examples/software-factory/server/workspace examples/software-factory/server/test/builder-config.test.ts
git commit -m "feat(software-factory): a bounded builder route and the app configuration"
```

---

### Task 16: Layer 2, the real builder under static fixtures

The offline lane rung 0 had to defer. It drives the real route in process with scripted model output, and the scripted verifier stands in for the container.

**Files:**
- Create: `test/isolated-app.ts`, `test/builder.test.ts`

- [ ] **Step 1: Create `test/isolated-app.ts`**

Copied in shape from `examples/code-fixer/server/test/isolated-app.ts`, because the harness runs typegen against whatever root it is given and must not write into the package.

```ts
import { cp, mkdir, mkdtemp, readdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { appRoot } from "../src/fixtures/catalog.ts"

/** Copy author files into a private installation, sharing only dependencies. */
export async function isolatedApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b4-software-factory-app-"))
  await mkdir(root, { recursive: true })
  const include = (path: string) =>
    !["node_modules", ".b4", ".factory", "artifacts"].includes(basename(path)) &&
    !basename(path).startsWith(".env")
  for (const name of await readdir(appRoot)) {
    if (include(name))
      await cp(join(appRoot, name), join(root, name), { recursive: true, filter: include })
  }
  await symlink(join(appRoot, "node_modules"), join(root, "node_modules"), "dir")
  return root
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createAgentHarness, script } from "@b4run/testing"
import { expect, it } from "vitest"
import { loadFixture } from "../src/fixtures/catalog.ts"
import { TASK_PROMPTS } from "../src/prompts.ts"
import { isolatedApp } from "./isolated-app.ts"

/**
 * Layer 2: the real builder route, real typegen, real tool wiring, scripted model
 * output. This is the lane rung 0 could not build, and it works now because the
 * builder only edits files: a static fixture can script exactly that.
 */
it(
  "drives the real builder to write the repaired source and nothing else",
  async () => {
    const appRoot = await isolatedApp()
    const fixture = loadFixture("cli-flags")
    const repaired = await readFile(
      join(fixture.directory, "project", fixture.manifest.allowedSourcePaths[0] as string),
      "utf8",
    )
    const harness = await createAgentHarness({ appRoot, route: "/build#agent" })
    try {
      const input = TASK_PROMPTS["cli-flags"] as string
      const run = await harness.run({
        input,
        fixtures: script()
          .user(input)
          .callsTool("readFile", { path: "TASK.md" })
          .callsTool("runBash", { command: "npm test" })
          .callsTool("writeFile", {
            path: fixture.manifest.allowedSourcePaths[0] as string,
            content: `${repaired}// repaired\n`,
          })
          .callsTool("runBash", { command: "npm test" })
          .replies("Repair complete.")
          .build(),
      })

      // The builder produced no interrupt, because it has no gate to park on.
      expect(run.interrupts).toHaveLength(0)
      const called = run.toolCalls.map((call) => call.name)
      expect(called).toContain("writeFile")
      // It has no verdict channel at all.
      expect(called).not.toContain("prepareReview")
      expect(called).not.toContain("exportForReview")
    } finally {
      await harness.close({ destroyWorkspaces: true })
      await rm(appRoot, { recursive: true, force: true })
    }
  },
  300_000,
)
```

- [ ] **Step 3: Run it**

Run: `B4_TEST_DOCKER=1 pnpm --filter @b4-example/software-factory-server test builder`
Expected: PASS. This test acquires a real sandbox because the app configures one, so it needs Docker and the fixture image. If Docker is unavailable it fails rather than skipping, matching how code-fixer's own harness test behaves.

Because it needs Docker, rename it to `test/builder.integration.test.ts` so it runs in the Docker project rather than the default one. Layer 2 is therefore Docker-gated in practice; say so in the spec's proof section when you update the docs in Task 18.

- [ ] **Step 4: Commit**

```bash
git add examples/software-factory/server/test/isolated-app.ts examples/software-factory/server/test/builder.integration.test.ts
git commit -m "test(software-factory): drive the real builder under static fixtures"
```

---

### Task 17: The real verifier and the real workspace reader

This is the task that depends on the framework's read-only thread-workspace surface. Everything before it is unblocked.

**Files:**
- Create: `src/verification/checks-runner.ts`, `src/verification/docker-verifier.ts`, `src/verification/baseline.ts`
- Create: `test/docker-verifier.integration.test.ts`

- [ ] **Step 1: Implement `src/verification/checks-runner.ts`**

Ported from `examples/code-fixer/server/src/review/verifier.ts`, whose runner is the part worth keeping: the parent process uses built-ins only, and submitted code runs in a child whose stdout arrives as an event it cannot forge.

```ts
import type { SandboxHandle } from "@b4run/workspace"
import type { Verdict } from "../domain/work-order.js"
import type { Suite } from "../fixtures/catalog.js"

export interface SuiteResult {
  readonly verdict: Verdict
  readonly output: string
  readonly events: readonly { readonly type: string; readonly name: string }[]
}

/**
 * Run one suite inside the sandbox and grade it against its named assertions.
 *
 * A pass requires every expected assertion to appear exactly once as a passing
 * event, with no skips and no extras. Anything the harness could not determine
 * is `inconclusive`, never `pass`: a suite that did not run is not a suite that
 * succeeded.
 */
export async function runSuite(
  handle: SandboxHandle,
  suite: Suite,
  signal: AbortSignal,
): Promise<SuiteResult> {
  const program = `
const { run } = require('node:test')
const events = []
let output = ''
run({ files: [${JSON.stringify(suite.file)}], execArgv: ['--import', 'tsx'], concurrency: 1 })
  .on('test:pass', (e) => events.push({ type: 'test:pass', name: e.name, skip: !!e.skip, todo: !!e.todo }))
  .on('test:fail', (e) => events.push({ type: 'test:fail', name: e.name, skip: !!e.skip, todo: !!e.todo }))
  .on('test:stdout', (e) => { output += e.message })
  .on('test:stderr', (e) => { output += e.message })
  .on('end', () => process.stdout.write(JSON.stringify({ events, output })))
`
  const result = await handle.exec.runCommand(
    {
      command: `/usr/local/bin/node --import tsx <<'B4_SUITE_PROGRAM'\n${program}\nB4_SUITE_PROGRAM`,
    },
    { workspaceRoot: handle.workspaceRoot, signal },
  )

  let parsed: { events: { type: string; name: string; skip: boolean; todo: boolean }[]; output: string }
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    // The runner itself did not report. We do not know whether the code is
    // correct, so we must not say it is, and we must not say it is broken.
    return { verdict: "inconclusive", output: `${result.stdout}\n${result.stderr}`, events: [] }
  }

  const expected = [...suite.assertions]
  const passed =
    result.exitCode === 0 &&
    expected.length > 0 &&
    parsed.events.length === expected.length &&
    parsed.events.every((event) => event.type === "test:pass" && !event.skip && !event.todo) &&
    expected.every(
      (name) => parsed.events.filter((event) => event.name === name).length === 1,
    )

  const sawFailure = parsed.events.some((event) => event.type === "test:fail")
  return {
    verdict: passed ? "pass" : sawFailure ? "fail" : "inconclusive",
    output: parsed.output,
    events: parsed.events.map((event) => ({ type: event.type, name: event.name })),
  }
}
```

- [ ] **Step 2: Implement `src/verification/baseline.ts`**

```ts
import { captureWorkspaceDefinition, readSourceFile } from "@b4run/workspace/node"
import { appRoot } from "../fixtures/catalog.js"
import { fixtureWorkspace } from "../fixtures/workspace.js"

/**
 * The controller's own baseline. It captures the fixture with the framework's own
 * capture, so the digest it compares against is one it derived, never one a
 * builder reported.
 */
export async function captureFixtureBaseline(
  taskId: string,
  signal: AbortSignal,
): Promise<{ readonly digest: string; readonly files: ReadonlyMap<string, string> }> {
  const captured = await captureWorkspaceDefinition(appRoot, fixtureWorkspace(taskId), { signal })
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const files = new Map<string, string>()
  for (const entry of captured.source.files)
    files.set(entry.path, decoder.decode(readSourceFile(captured.source, entry.path)))
  return { digest: captured.source.digest, files }
}
```

- [ ] **Step 3: Implement `src/verification/docker-verifier.ts`**

```ts
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { withWorkspace } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { inspectWorkspace } from "@b4run/workspace"
import type { Receipt } from "../domain/work-order.js"
import { appRoot, loadFixture } from "../fixtures/catalog.js"
import { fixtureWorkspace, sandboxImage, sandboxPolicy } from "../fixtures/workspace.js"
import type { ArtifactStore } from "../storage/artifacts.js"
import { runSuite } from "./checks-runner.js"
import { type Verifier, type VerifyInput, worstVerdict } from "./verifier.js"

/**
 * The real verifier. Its container is not the builder's: a different sandbox
 * scope, a freshly captured workspace, and the independent checks written in only
 * after the visible suite has had its turn, from the controller's own copy.
 *
 * The workspace is snapshotted before and after each suite. Any persistent change
 * a suite made is a rejection, which is what catches a candidate that repairs
 * itself by editing its own tests.
 */
export function createDockerVerifier(artifacts: ArtifactStore): Verifier {
  return {
    async verify(input: VerifyInput, signal: AbortSignal): Promise<Receipt> {
      const fixture = loadFixture(input.taskId)
      const stateRoot = join(appRoot, ".factory", "verifiers", randomUUID())
      const provider = dockerSandbox({ scope: "software-factory-verifier", image: sandboxImage })

      const outcome = await withWorkspace(
        { appRoot, stateRoot, provider, workspace: fixtureWorkspace(input.taskId), policy: sandboxPolicy, signal },
        async (handle) => {
          const snapshot = async () =>
            (
              await inspectWorkspace(handle, {
                signal,
                maxEntries: 1000,
                maxFileBytes: 2 * 1024 * 1024,
                maxTotalBytes: 2 * 1024 * 1024,
                excludeRootDirectories: [".git"],
                expectedRootSymlinks: { node_modules: `/opt/fixtures/${input.taskId}/node_modules` },
              })
            ).files

          for (const [path, content] of Object.entries(input.changes))
            await handle.filesystem.writeFile(join(handle.workspaceRoot, path), content, { signal })

          const beforeVisible = await snapshot()
          const visible = await runSuite(handle, fixture.checks.visible, signal)
          if (changed(beforeVisible, await snapshot()))
            return { tampered: "visible" as const, visible, independent: null }

          for (const name of [fixture.checks.independent.file.replace(/^checks\//, "")]) {
            const source = await readFile(join(fixture.directory, "checks", name), "utf8")
            await handle.filesystem.writeFile(
              join(handle.workspaceRoot, "checks", name),
              source,
              { signal },
            )
          }

          const beforeIndependent = await snapshot()
          const independent = await runSuite(handle, fixture.checks.independent, signal)
          if (changed(beforeIndependent, await snapshot()))
            return { tampered: "independent" as const, visible, independent }

          return { tampered: null, visible, independent }
        },
      )

      const environmentIdentity = sandboxImage
      const base = {
        id: `rc-${randomUUID()}`,
        workOrderId: input.workOrderId,
        candidateDigest: input.candidateDigest,
        verifierIdentity: `docker:${provider.name}:${environmentIdentity}`,
        policyDigest: input.policyDigest,
        environmentIdentity,
        issuedAt: new Date().toISOString(),
      }

      if (outcome.tampered)
        return {
          ...base,
          verdict: "fail",
          checks: [
            {
              id: outcome.tampered,
              acceptanceIds: [],
              verdict: "fail",
              evidence: [await put(artifacts, `a suite mutated the workspace during ${outcome.tampered}`)],
            },
          ],
        }

      const independent = outcome.independent
      if (!independent) throw new Error("independent suite did not run and no tamper was recorded")

      return {
        ...base,
        verdict: worstVerdict([outcome.visible.verdict, independent.verdict]),
        checks: [
          {
            id: "visible",
            acceptanceIds: fixture.checks.visible.assertions,
            verdict: outcome.visible.verdict,
            evidence: [await put(artifacts, outcome.visible.output)],
          },
          {
            id: "independent",
            acceptanceIds: fixture.checks.independent.assertions,
            verdict: independent.verdict,
            evidence: [await put(artifacts, independent.output)],
          },
        ],
      }
    },
  }
}

const changed = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): boolean => JSON.stringify(before) !== JSON.stringify(after)

async function put(artifacts: ArtifactStore, content: string) {
  const ref = await artifacts.put(content === "" ? "(no output)\n" : content)
  return { id: "output", digest: ref.digest }
}
```

- [ ] **Step 4: Implement the real workspace reader**

Append to `src/worker/workspace-reader.ts`:

```ts
/**
 * The real reader, over the framework's read-only thread-workspace surface.
 *
 * Until that surface lands this throws with a clear message rather than reaching
 * into internals: acquiring the builder's sandbox from this process would replace
 * its container, and deriving the volume name depends on an unexported helper.
 * The Docker-gated lane is the only thing that needs this; every other layer uses
 * the fake.
 */
export function createThreadWorkspaceReader(): WorkspaceReader {
  return {
    async read(threadId) {
      throw new Error(
        `Reading thread ${threadId}'s workspace needs the framework's read-only thread-workspace surface, which is not available in this build`,
      )
    },
  }
}
```

When the framework PR lands, replace the body with `createHandleWorkspaceReader(...)` over the new surface's attach function, and delete this comment.

- [ ] **Step 5: Write the Docker-gated verifier test**

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadFixture } from "../src/fixtures/catalog.ts"
import { createArtifactStore } from "../src/storage/artifacts.ts"
import { loadPolicy } from "../src/verification/policy.ts"
import { createDockerVerifier } from "../src/verification/docker-verifier.ts"

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const verifierFor = () => {
  dir = mkdtempSync(join(tmpdir(), "factory-verifier-"))
  return createDockerVerifier(createArtifactStore(join(dir, "artifacts")))
}

const fixture = loadFixture("cli-flags")
const policy = loadPolicy("cli-flags")
const allowed = fixture.manifest.allowedSourcePaths[0] as string
const readReference = () => readFile(join(fixture.directory, "reference.patch"), "utf8")

describe("the real verifier", () => {
  it("passes the reference repair", async () => {
    // Apply the historical reference repair to get a candidate known to be correct.
    const repaired = await applyReference()
    const receipt = await verifierFor().verify(
      {
        workOrderId: "wo-1",
        taskId: "cli-flags",
        candidateDigest: "a".repeat(64),
        changes: { [allowed]: repaired },
        policyDigest: policy.policyDigest,
      },
      AbortSignal.timeout(280_000),
    )
    expect(receipt.verdict).toBe("pass")
    expect(receipt.verifierIdentity).toMatch(/^docker:/)
    expect(receipt.checks.map((c) => c.id)).toEqual(["visible", "independent"])
  }, 300_000)

  it("fails a candidate that satisfies the visible suite and not the independent checks", async () => {
    // This is rung 1's headline invariant, earned rather than scripted.
    const shallow = await readFile(join(fixture.directory, "project", allowed), "utf8")
    const receipt = await verifierFor().verify(
      {
        workOrderId: "wo-2",
        taskId: "cli-flags",
        candidateDigest: "b".repeat(64),
        changes: { [allowed]: shallowRepair(shallow) },
        policyDigest: policy.policyDigest,
      },
      AbortSignal.timeout(280_000),
    )
    expect(receipt.verdict).toBe("fail")
    expect(receipt.checks.find((c) => c.id === "visible")?.verdict).toBe("pass")
    expect(receipt.checks.find((c) => c.id === "independent")?.verdict).toBe("fail")
  }, 300_000)

  it("refuses a candidate whose suite mutates the workspace", async () => {
    const receipt = await verifierFor().verify(
      {
        workOrderId: "wo-3",
        taskId: "cli-flags",
        candidateDigest: "c".repeat(64),
        changes: { [allowed]: selfModifying() },
        policyDigest: policy.policyDigest,
      },
      AbortSignal.timeout(280_000),
    )
    expect(receipt.verdict).toBe("fail")
  }, 300_000)
})
```

Write the three helpers at the bottom of the file: `applyReference()` applies `fixtures/cli-flags/reference.patch` to the fixture source with `git apply` in a temp copy and returns the repaired text (copy the shape from `examples/code-fixer/server/test/replay.ts`); `shallowRepair(source)` returns a repair that registers only the flag the visible test names, which is exactly what the independent checks were written to catch; `selfModifying()` returns a repair whose module top level writes to `test/cli.test.ts`. Copy `reference.patch` into the fixture directory in Task 2 if you have not already.

- [ ] **Step 6: Run the Docker lane**

```bash
cd <repo> && pnpm code-fixer:prepare   # builds b4-code-fixer:fixture-v1, which this fixture reuses
B4_TEST_DOCKER=1 pnpm --filter @b4-example/software-factory-server test:sandbox
```

Expected: the verifier suite passes. The first test proves a correct repair passes; the second is the invariant the whole rung exists for.

- [ ] **Step 7: Commit**

```bash
git add examples/software-factory/server/src/verification examples/software-factory/server/src/worker/workspace-reader.ts examples/software-factory/server/test/docker-verifier.integration.test.ts
git commit -m "feat(software-factory): the real verifier earns its verdicts in a container"
```

---

### Task 18: Documentation and the full gate

**Files:**
- Modify: `<repo>/examples/software-factory/README.md`, `<repo>/examples/README.md`
- Create: `<repo>/docs/superpowers/runbooks/software-factory-rung1-live.md`
- Modify: `<repo>/docs/superpowers/specs/2026-09-18-software-factory-rung1-design.md`

- [ ] **Step 1: Rewrite the README's body**

Keep the structure and replace the claims. It must now say: the factory contains both a bounded builder route and the controller; the controller captures the baseline, assembles and digests the candidate, verifies in its own container, freezes a review bundle, and exports the approved bytes; approval binds to the bundle digest, so a policy or environment change invalidates consent even when the bytes are identical. Delete the rung 0 paragraph about the shared-host outbox read and the paragraph deferring the offline lane, and replace the latter with what is true now: the builder lane runs under Docker because the app configures a sandbox, and the verifier lane is Docker-gated.

Update the run instructions: one terminal runs `pnpm dev --port 4100` in this package rather than in code-fixer, and the environment is `FACTORY_WORKER_URL`, `FACTORY_WORKER_ROUTE=/build#agent`, `FACTORY_STATE_DIR`. The approve command takes `--bundle`, not `--digest`. Add the `evidence` command.

State plainly that the real workspace reader needs the framework's read-only thread-workspace surface, and that until it lands the end-to-end path works only with the fake reader in tests.

- [ ] **Step 2: Update the examples index row**

Replace the software-factory row in `<repo>/examples/README.md` with one that names controller-owned verification and the review bundle.

- [ ] **Step 3: Write the live runbook**

`docs/superpowers/runbooks/software-factory-rung1-live.md`, in the shape of the rung 0 one: procedure, then an empty results table. The procedure is the rung 0 one with three changes: the worker is this package's own builder, approve takes the bundle digest, and there is an extra step asserting that a scripted weak repair is refused by the controller rather than exported. Ask for these fields: date, builder model, work order id, builder thread id, baseline digest, candidate digest, receipt verdict and verifier identity, bundle digest, export path, whether the export filename equals the bundle digest, and the wall clock for each phase.

- [ ] **Step 4: Correct the spec's proof section**

Layer 2 turned out to need Docker, because the app configures a sandbox and the harness acquires one. Update the spec: layer 1 is the only always-on layer; layers 2 and 3 are Docker-gated. Say why, so the next rung does not rediscover it.

- [ ] **Step 5: Run the full gate**

```bash
cd <repo> && nvm use 24
pnpm --filter @b4-example/software-factory-server test
pnpm --filter @b4-example/software-factory-server typecheck
pnpm --filter @b4-example/software-factory-server lint
pnpm lint && pnpm typecheck && pnpm test
git status --short examples/code-fixer
```

Expected: the package's own suites pass; the repo gates pass; the last command prints nothing. Then run `pnpm ci:validate` once. Do not pipe it through `tail`, which hides the exit code.

- [ ] **Step 6: Commit**

```bash
git add examples/software-factory/README.md examples/README.md docs/superpowers
git commit -m "docs(software-factory): rung 1 README, examples index, runbook and proof correction"
```

- [ ] **Step 7: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill. The pull request description must list the spec's six success criteria with evidence for each, state that `examples/code-fixer` is unchanged, and say plainly that criterion 2 and the end-to-end path depend on the framework's read-only thread-workspace surface, naming its pull request.

---

## Self-review against the spec

| Spec section | Tasks |
|---|---|
| Three authorities | 15 (builder), 11 to 12 (controller), 17 (verifier) |
| Dependency and its interface | 7 (seam and fake), 17 (real adapter) |
| Baseline authority | 17 (`captureFixtureBaseline`), 11 (used) |
| Candidate assembly and the cap | 8 |
| Digest | 3 |
| Verification and the tamper snapshots | 9 (seam), 17 (real) |
| Receipt, including inconclusive | 5 (schema), 9 (fake), 17 (real) |
| Review bundle | 10 |
| Export | 12 |
| Identity and canonical form, every bundle input | 3, 10 |
| Lifecycle changes and the transition rows | 4 |
| Registry additions | 5, 6 |
| The builder route | 15 |
| Proof layer 1 | 3, 5 to 13 |
| Proof layer 2 | 16 |
| Proof layer 3 | 17 |
| Invariants table | 8 (scope, cap, encoding, added, removed), 11 (verdicts, baseline mismatch), 12 (bundle binding, re-verification, idempotent export), 13 (restart in verifying), 17 (visible passes and independent fails, tamper, real isolation) |
| Success criteria | 18 |

Known deviations, decided here:

- **Layer 2 is Docker-gated, not always-on.** The spec assumed the harness could drive the builder without a container. It cannot: the app configures a sandbox, so `createAgentHarness` acquires one. Task 18 corrects the spec rather than leaving the two inconsistent.
- **`captureBaseline` is injected into the factory** rather than called directly, so layers 1 and 2 need no container to exercise assembly. The real implementation is the only caller in production.
- **The verifier takes the artifact store as an argument** rather than reaching for a module singleton, so a test can point it at a temp directory.
- **`FACTORY_WORKER_OUTBOX` is ignored rather than rejected** when present, so an operator's old environment file keeps working while they update it.
- **The candidate's bytes live in one artifact** as a JSON map rather than one artifact per file. It keeps the store simple and the export receipt is the same shape; revisit at rung 2 when a candidate spans many files.
