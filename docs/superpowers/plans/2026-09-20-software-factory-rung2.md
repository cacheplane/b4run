# Software Factory Rung 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point the rung 1 controller at `packages/devkit` at a pinned commit of this repository, prove it can baseline, build and test that package in its own container, and prove that a scripted repair of a known past defect in it verifies end to end.

**Architecture:** Rung 1's single `fixtures/<id>` directory splits into a `targets/` catalog (environment: pin, root, capture list, image, links, commands, resources) and a `tasks/` catalog (repair: spec with acceptance IDs, defect and reference patches, independent checks). A synchronous archive step produces the baseline from `git archive <pin>:<root>` plus the defect patch, under `.factory/captures/<role>/<task>`. The verifier gains a build step, a vitest suite runner beside the `node:test` one, a tamper filter for build output, and an environment identity that is the digest of an image-inputs object. `cli-flags` is re-expressed as a target rooted at its fixture directory plus a task, so every rung 1 test keeps its paths.

**Tech Stack:** Node 24 (`node:sqlite`, `node:child_process`, native type stripping), TypeScript 7.0.2 (`noEmit`, run with `tsx`), zod 4.4.3, vitest 4.1.11 (JSON reporter), biome 2.5.6, `@b4run/cli` (`config`, `withWorkspace`), `@b4run/sandbox` (`dockerSandbox`), `@b4run/workspace` (`inspectWorkspace`) with `@b4run/workspace/node` (`captureWorkspaceDefinition`, `readSourceFile`), `@b4run/testing` (`createAgentHarness`, `script`), Docker, pnpm 10.33.0 with the hoisted linker inside the image.

**Spec:** `docs/superpowers/specs/2026-09-19-software-factory-rung2-design.md` at `97e48b5f`. Read it first, including "Suite runners", "Capture and image" and "Research alignment".

**Predecessors on main:** rung 1 `c8e4f952`, byte channel `1e54414c`, hardening `9d676522`, managed-workspace read `516c038c`.

---

## Conventions that apply to every task

- Work in the worktree you were given, on a branch off `origin/main`. Never use bare `git stash`.
- Package root for all relative paths below: `examples/software-factory/server`. Repo-root paths are prefixed `<repo>/`.
- Run `nvm use 24` before any test. Node 22 makes unrelated suites fail in ways that look pre-existing.
- Source files import siblings with `.js` extensions; test files import `../src/....ts`.
- Layer 1 (always on): `npx vitest run` from the package root. Docker lanes: `npx vitest run --config vitest.sandbox.config.ts`. Typecheck: `npx tsc -p . --noEmit`. Lint: `npx biome check .`; format only your own files with `npx biome check --write <files>`. Never run bare `biome check --write` at the repo root.
- `examples/code-fixer` must have no diff at the end. Check with `git status --short examples/code-fixer` before every commit.
- Commit after every task with the message shown. Every commit message ends with the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **The package's layer 1 suite (`npx vitest run`) and typecheck are green at every commit.** A plan step that predicts a red gate is wrong; make it green in the same task.
- Docker must be running for Tasks 10 onward. If it is not, stop at Task 9 and say so; do not fake a Docker result.

## Nine facts that will bite you if you skip them

1. **The framework's capture takes an app-relative, portable source directory.** `captureWorkspaceDefinition(appRoot, definition)` rejects absolute paths (`portablePath`). That is why captures live under `.factory/captures/<role>/<task>` inside the package and why `captureTarget` returns a relative path.
2. **Inspection validates root symlinks only.** `expectedRootSymlinks` covers the workspace root; a nested symlink such as `packages/devkit/node_modules` makes `inspectWorkspace` throw. The devkit image therefore installs with pnpm's hoisted linker and links one root `node_modules`.
3. **The suite runner drives `node:test`, not vitest.** `runSuite` in `src/verification/checks-runner.ts` runs `node:test`'s `run()` over one file. Devkit's suite is vitest, so Task 7 adds a vitest runner that grades a JSON report. Do not try to run vitest through the `node:test` runner.
4. **`tsx` is not in devkit's closure.** The independent check for devkit runs under plain `node` and relies on Node 24 stripping types. Write it without TS-only syntax: no enums, no parameter properties, no `namespace`. Type annotations and `import type` are fine.
5. **Corepack does not survive `USER node` with the network denied.** Install pnpm with `npm install -g pnpm@<version>` in the Dockerfile.
6. **The root filesystem in a sandbox is read-only** with tmpfs at `/tmp` and `/run`. Anything a tool writes under `node_modules` fails; that is why the vitest invocation carries `--no-cache`.
7. **`git apply` outside a repository works** and applies paths relative to the working directory, which is what the archive extraction directory is. Do not `git init` the capture directory.
8. **`git archive <pin>:<root> -- <paths>`** archives the subtree at `<root>` with `<paths>` relative to it. When `root` is `.`, use `<pin>` alone.
9. **`policyDigest` grows a required `environment` field** in Task 2, and its domain tag moves to `v2`. Every caller must pass it; the rung 1 fixture-based digests change value, which is intended.

---

## File structure

New files unless marked.

| File | Responsibility |
|---|---|
| `src/targets/catalog.ts` | `appRoot`, `targetsDir`, `tasksDir`, `repositoryRoot()`, target and task zod schemas, `loadTargetIds`, `loadTarget`, `loadTaskIds`, `loadTask`, `imageTag`, `environmentIdentity` |
| `src/targets/archive.ts` | `captureTarget(task, role)`: `git archive` + `git apply`, synchronous |
| `src/targets/workspace.ts` | `targetWorkspace`, `targetSandboxPolicy`, `targetInspectionOptions`, `builderSandboxProvider`, `builderSandboxScope`; replaces `src/fixtures/workspace.ts` |
| `src/domain/digest.ts` *(modify)* | `policyDigest` gains `environment`; new `environmentIdentityDigest` |
| `src/verification/policy.ts` *(modify)* | Loads from the task catalog; binds environment, patch and allowlist |
| `src/verification/baseline.ts` *(modify)* | `captureTargetBaseline` over the controller's capture |
| `src/verification/checks-runner.ts` *(modify)* | `runNodeTestSuite` with `execArgv`, `runVitestSuite` + pure `gradeVitestReport`, `runBuild`, `shellJoin` |
| `src/verification/docker-verifier.ts` *(modify)* | Target-driven: build step, runner dispatch, `snapshotIgnore`, identity from the image object, per-target deadline |
| `src/cli.ts`, `b4.config.ts`, `src/app/build/index.ts`, `src/prompts.ts` *(modify)* | Wire the catalogs; prompts keyed by task id |
| `targets/cli-flags/{target.json,Dockerfile}` | The rung 1 fixture as a target rooted at `fixtures/cli-flags/project` |
| `tasks/cli-flags/{task.json,spec.md,checks.json,reference.patch,checks/independent.test.ts}` | The rung 1 task, moved |
| `targets/devkit/{target.json,Dockerfile}` | The monorepo target |
| `tasks/devkit-spawn-deadline/{task.json,spec.md,defect.patch,reference.patch,checks.json,checks/spawn-deadline.test.ts}` | The rung 2 task |
| `scripts/prepare-target.ts` | Build a target's image at its pin; write the `image` object |
| `src/fixtures/` *(delete)* | Retired |
| `test/targets-catalog.test.ts`, `test/targets-archive.test.ts`, `test/checks-runner.test.ts`, `test/target-devkit.integration.test.ts`, `test/devkit-end-to-end.integration.test.ts` | New tests |
| `test/reference-repair.ts`, `test/isolated-app.ts`, existing tests *(modify)* | Re-pointed at the catalogs |

---

### Task 1: `environmentIdentityDigest` and `policyDigest` v2

**Files:**
- Modify: `src/domain/digest.ts`
- Test: `test/digest.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/digest.test.ts` (keep its existing imports; add `environmentIdentityDigest` to the import from `../src/domain/digest.ts`):

```ts
describe("policyDigest v2", () => {
  const base = {
    checks: { visible: { runner: "vitest", assertions: ["a"] } },
    allowedSourcePaths: ["packages/devkit/src/testing/process.ts"],
    immutablePaths: ["packages/devkit/package.json"],
    environment: {
      identity: "e".repeat(64),
      pin: "1".repeat(40),
      root: ".",
      captureInclude: ["packages/devkit"],
      defectPatchSha256: "2".repeat(64),
    },
  }

  it("moves when only the environment binding moves", () => {
    const one = policyDigest(base)
    expect(policyDigest({ ...base, environment: { ...base.environment, identity: "f".repeat(64) } })).not.toBe(one)
    expect(policyDigest({ ...base, environment: { ...base.environment, defectPatchSha256: null } })).not.toBe(one)
    expect(policyDigest({ ...base, environment: { ...base.environment, captureInclude: ["packages/devkit", "x"] } })).not.toBe(one)
  })

  it("is order-independent over the include list", () => {
    expect(
      policyDigest({ ...base, environment: { ...base.environment, captureInclude: ["b", "a"] } }),
    ).toBe(policyDigest({ ...base, environment: { ...base.environment, captureInclude: ["a", "b"] } }))
  })
})

describe("environmentIdentityDigest", () => {
  const image = {
    localId: `sha256:${"a".repeat(64)}`,
    platform: "linux/arm64",
    baseManifestDigest: `sha256:${"b".repeat(64)}`,
    dockerfileSha256: "c".repeat(64),
    lockfileSha256: "d".repeat(64),
    pnpmVersion: "10.33.0",
  }
  it("is a 64-hex digest that moves with any field", () => {
    const one = environmentIdentityDigest(image)
    expect(one).toMatch(/^[a-f0-9]{64}$/)
    expect(environmentIdentityDigest({ ...image, platform: "linux/amd64" })).not.toBe(one)
    expect(environmentIdentityDigest({ ...image, pnpmVersion: "10.33.1" })).not.toBe(one)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/digest.test.ts`
Expected: FAIL. `environmentIdentityDigest` is not exported, and `policyDigest` has no `environment` field so TypeScript complains and the "moves when only the environment binding moves" test fails.

- [ ] **Step 3: Implement**

In `src/domain/digest.ts`, replace the `policyDigest` function with:

```ts
/** What the verifier ran in and what it ran over, bound into the policy. */
export interface PolicyEnvironment {
  /** `environmentIdentityDigest` of the target's image object. */
  readonly identity: string
  readonly pin: string
  readonly root: string
  readonly captureInclude: readonly string[]
  /** sha256 of `defect.patch`, or null when the pinned bytes are already the baseline. */
  readonly defectPatchSha256: string | null
}

/**
 * Digest of the completion policy: the checks, the inventory the builder may
 * touch, and the environment the verdict is earned in. `checks` must be a plain
 * object; `canon` validates its contents (see {@link DigestInputError}) so two
 * policies that differ only by an unrepresentable value cannot collide. The
 * environment is included because a bundle frozen over one baseline definition
 * or one image must not be approvable after either changed.
 */
export function policyDigest(input: {
  readonly checks: Readonly<Record<string, unknown>>
  readonly allowedSourcePaths: readonly string[]
  readonly immutablePaths: readonly string[]
  readonly environment: PolicyEnvironment
}): string {
  return digest("b4-factory-policy-v2", {
    checks: input.checks,
    allowedSourcePaths: [...input.allowedSourcePaths].sort(),
    immutablePaths: [...input.immutablePaths].sort(),
    environment: {
      identity: input.environment.identity,
      pin: input.environment.pin,
      root: input.environment.root,
      captureInclude: [...input.environment.captureInclude].sort(),
      defectPatchSha256: input.environment.defectPatchSha256,
    },
  })
}

/** The inputs that determined a target image, as the prepare script recorded them. */
export interface ImageInputs {
  readonly localId: string
  readonly platform: string
  readonly baseManifestDigest: string
  readonly dockerfileSha256: string
  readonly lockfileSha256: string
  readonly pnpmVersion: string
}

/**
 * The environment identity every receipt and bundle binds. A local Docker image
 * id alone is host-specific and unverifiable elsewhere; digesting it together
 * with the inputs that produced it lets a second host verify the inputs.
 */
export function environmentIdentityDigest(image: ImageInputs): string {
  return digest("b4-factory-environment-v1", {
    localId: image.localId,
    platform: image.platform,
    baseManifestDigest: image.baseManifestDigest,
    dockerfileSha256: image.dockerfileSha256,
    lockfileSha256: image.lockfileSha256,
    pnpmVersion: image.pnpmVersion,
  })
}
```

- [ ] **Step 4: Run the digest tests**

Run: `npx vitest run test/digest.test.ts`
Expected: PASS for the new tests. If an existing test pins a literal `policyDigest` value, update the literal: the tag moved to v2 and that is the intended change.

**Keep layer 1 green.** vitest transpiles without typechecking, so `loadPolicy` in `src/verification/policy.ts` would reach `policyDigest` without an `environment` and throw at runtime, failing `test/bundle.test.ts` for the five tasks until Task 6. Give it a placeholder in this task:

```ts
    // Rung 1 has no target catalog yet; Task 6 derives this from the task's target.
    environment: { identity: "fixture", pin: "0".repeat(40), root: ".", captureInclude: [], defectPatchSha256: null },
```

Then `npx vitest run` (whole package) and `npx tsc -p . --noEmit` must both be clean. Every later task holds the same gate: the package suite is green at every commit.

**Test every digested field.** Generate one assertion per field of `PolicyEnvironment` and of `ImageInputs` (loop over `Object.keys`), so a field dropped from a digest body fails a test rather than passing silently.

- [ ] **Step 5: Commit**

```bash
git add src/domain/digest.ts test/digest.test.ts
git commit -m "feat(software-factory): bind the environment into the policy digest

policyDigest v2 carries the target's environment identity, pin, root,
capture list and defect patch hash, so a bundle frozen over one baseline
definition or one image is not approvable after either changed.
environmentIdentityDigest digests the image-inputs object the prepare
script records, because a local image id alone is host-specific.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The target catalog

**Files:**
- Create: `src/targets/catalog.ts`
- Test: `test/targets-catalog.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/targets-catalog.test.ts`:

```ts
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  environmentIdentity,
  imageTag,
  loadTarget,
  loadTargetIds,
  TargetSchema,
} from "../src/targets/catalog.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway repository with one commit, so a pin can be real without touching this repo. */
function repo(): { root: string; pin: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-targets-repo-"))
  dirs.push(root)
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  writeFileSync(join(root, "a.txt"), "a\n")
  git("add", ".")
  git("commit", "-q", "-m", "one")
  return { root, pin: git("rev-parse", "HEAD") }
}

const image = {
  localId: `sha256:${"a".repeat(64)}`,
  platform: "linux/arm64",
  baseManifestDigest: `sha256:${"b".repeat(64)}`,
  dockerfileSha256: "c".repeat(64),
  lockfileSha256: "d".repeat(64),
  pnpmVersion: "10.33.0",
}

function manifest(pin: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "t",
    pin,
    root: ".",
    capture: { include: ["a.txt"] },
    snapshotIgnore: [],
    image,
    imageContext: ["package.json"],
    lockfile: "pnpm-lock.yaml",
    imageAssertResolves: [],
    environmentLinks: [{ path: "node_modules", target: "/opt/targets/t/node_modules" }],
    commands: {
      cwd: ".",
      build: [],
      test: ["pnpm", "exec", "vitest", "--run"],
      nodeTestExecArgv: [],
    },
    runnerConfig: ["package.json"],
    resources: { memoryMb: 1024, cpus: 1, commandTimeoutMs: 120_000, verifierDeadlineMs: 300_000 },
    ...overrides,
  }
}

/** Write a targets directory holding one target manifest. */
function targetsDir(pin: string, overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-targets-"))
  dirs.push(dir)
  mkdirSync(join(dir, "t"))
  writeFileSync(join(dir, "t", "target.json"), JSON.stringify(manifest(pin, overrides)))
  return dir
}

describe("target catalog", () => {
  it("lists the targets shipped with the factory", () => {
    expect(loadTargetIds()).toEqual(["cli-flags", "devkit"])
  })

  it("loads a target whose pin the repository holds", () => {
    const { root, pin } = repo()
    const target = loadTarget("t", { targetsDir: targetsDir(pin), repositoryRoot: root })
    expect(target.pin).toBe(pin)
    expect(target.directory.endsWith("/t")).toBe(true)
    expect(imageTag(target)).toBe(`b4-factory-t:${pin.slice(0, 12)}-${"c".repeat(12)}`)
    expect(environmentIdentity(target)).toMatch(/^[a-f0-9]{64}$/)
  })

  it("refuses a pin that is not a full commit sha", () => {
    expect(TargetSchema.safeParse(manifest("abc123")).success).toBe(false)
    expect(TargetSchema.safeParse(manifest("A".repeat(40))).success).toBe(false)
  })

  it("refuses a pin the repository's object store does not contain", () => {
    const { root } = repo()
    const absent = "1".repeat(40)
    expect(() => loadTarget("t", { targetsDir: targetsDir(absent), repositoryRoot: root })).toThrow(
      /not in the repository/,
    )
  })

  it("refuses a target that has not been prepared", () => {
    const { root, pin } = repo()
    expect(() =>
      loadTarget("t", { targetsDir: targetsDir(pin, { image: undefined }), repositoryRoot: root }),
    ).toThrow(/not been prepared/)
  })

  it("refuses an unknown target and an id that disagrees with its directory", () => {
    const { root, pin } = repo()
    const dir = targetsDir(pin, { id: "other" })
    expect(() => loadTarget("nope", { targetsDir: dir, repositoryRoot: root })).toThrow(/Unknown target: nope/)
    expect(() => loadTarget("t", { targetsDir: dir, repositoryRoot: root })).toThrow(/declares a different id/)
  })

  it("refuses a root or an include path that escapes or is absolute", () => {
    expect(TargetSchema.safeParse(manifest("1".repeat(40), { root: "../x" })).success).toBe(false)
    expect(TargetSchema.safeParse(manifest("1".repeat(40), { root: "/x" })).success).toBe(false)
    expect(
      TargetSchema.safeParse(manifest("1".repeat(40), { capture: { include: ["../a"] } })).success,
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/targets-catalog.test.ts`
Expected: FAIL, "Cannot find module '../src/targets/catalog.ts'".

- [ ] **Step 3: Implement the catalog (targets half)**

Create `src/targets/catalog.ts`:

```ts
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { environmentIdentityDigest } from "../domain/digest.js"

/** The package root, derived from this module rather than the working directory. */
export const appRoot = fileURLToPath(new URL("../../", import.meta.url))
export const targetsDir = join(appRoot, "targets")
export const tasksDir = join(appRoot, "tasks")

const HEX_64 = /^[a-f0-9]{64}$/
const SHA_256_REF = /^sha256:[a-f0-9]{64}$/

/** A relative, forward-slash path with no `..` segment and no leading slash. */
const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\\"), {
    message: "must be a relative forward-slash path with no `..` segment",
  })

export const ImageSchema = z.object({
  localId: z.string().regex(SHA_256_REF),
  platform: z.string().min(1),
  baseManifestDigest: z.string().regex(SHA_256_REF),
  dockerfileSha256: z.string().regex(HEX_64),
  lockfileSha256: z.string().regex(HEX_64),
  pnpmVersion: z.string().min(1),
})
export type Image = z.infer<typeof ImageSchema>

export const TargetSchema = z.object({
  id: z.string().min(1),
  pin: z.string().regex(/^[a-f0-9]{40}$/, "pin must be a full lowercase commit sha"),
  root: z.union([z.literal("."), relativePath]),
  capture: z.object({ include: z.array(relativePath).min(1) }),
  /** Root-relative prefixes a suite may write under; the tamper comparison skips them. */
  snapshotIgnore: z.array(relativePath),
  /** Absent until `scripts/prepare-target.ts` has run for this pin. */
  image: ImageSchema.optional(),
  /** Repository paths copied into the image build context at the pin. */
  imageContext: z.array(relativePath).min(1),
  /** Repository path of the lockfile whose sha256 enters the image object. */
  lockfile: relativePath,
  /** Module specifiers that must resolve from `commands.cwd` inside the built image. */
  imageAssertResolves: z.array(z.string().min(1)),
  environmentLinks: z.array(z.object({ path: relativePath, target: z.string().min(1) })).min(1),
  commands: z.object({
    cwd: z.union([z.literal("."), relativePath]),
    build: z.array(z.string().min(1)),
    test: z.array(z.string().min(1)).min(1),
    nodeTestExecArgv: z.array(z.string().min(1)),
  }),
  /** Files the test command reads to decide what to run; every task must keep them immutable. */
  runnerConfig: z.array(relativePath).min(1),
  resources: z.object({
    memoryMb: z.number().int().positive(),
    cpus: z.number().positive(),
    commandTimeoutMs: z.number().int().positive(),
    verifierDeadlineMs: z.number().int().positive(),
  }),
})
export type TargetManifest = z.infer<typeof TargetSchema>

export interface Target extends TargetManifest {
  readonly directory: string
  /** Present: `loadTarget` refuses a manifest without one. */
  readonly image: Image
}

export interface CatalogOptions {
  readonly targetsDir?: string
  readonly tasksDir?: string
  readonly repositoryRoot?: string
}

/**
 * The repository the factory targets: this one. `FACTORY_REPO_ROOT` exists because the
 * Docker-lane tests copy the app to a temporary root outside the repository, where
 * `git rev-parse` has nothing to find.
 */
export function repositoryRoot(): string {
  const fromEnv = process.env.FACTORY_REPO_ROOT
  if (fromEnv) return fromEnv
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
}

/** Target ids present on disk, sorted. A new target is a directory, not a code change. */
export function loadTargetIds(dir = targetsDir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

export function loadTarget(id: string, options: CatalogOptions = {}): Target {
  const dir = options.targetsDir ?? targetsDir
  if (!loadTargetIds(dir).includes(id)) throw new Error(`Unknown target: ${id}`)
  const directory = join(dir, id)
  const manifest = TargetSchema.parse(
    JSON.parse(readFileSync(join(directory, "target.json"), "utf8")),
  )
  if (manifest.id !== id) throw new Error(`Target ${id} declares a different id: ${manifest.id}`)
  if (!manifest.image)
    throw new Error(`Target ${id} has not been prepared: run scripts/prepare-target.ts ${id}`)
  const repo = options.repositoryRoot ?? repositoryRoot()
  if (!commitExists(repo, manifest.pin))
    throw new Error(`Target ${id} pins ${manifest.pin}, which is not in the repository at ${repo}`)
  return { ...manifest, image: manifest.image, directory }
}

function commitExists(repo: string, pin: string): boolean {
  try {
    execFileSync("git", ["-C", repo, "cat-file", "-e", `${pin}^{commit}`], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/** The tag the prepare script builds and the sandbox provider runs. Derived, never stored. */
/**
 * Binds the pin AND the Dockerfile, so a changed Dockerfile at the same pin never runs under
 * the old recorded identity. Computable before a build from a provisional image object.
 */
export function imageTag(target: Pick<Target, "id" | "pin" | "image">): string {
  return `b4-factory-${target.id}:${target.pin.slice(0, 12)}-${target.image.dockerfileSha256.slice(0, 12)}`
}

/** The environment identity every receipt and bundle binds for this target. */
export function environmentIdentity(target: Pick<Target, "image">): string {
  return environmentIdentityDigest(target.image)
}

export { existsSync as _existsSync }
```

Remove the last line (`export { existsSync as _existsSync }`) and the `existsSync` import; they are placeholders for nothing. The file should import only what it uses.

- [ ] **Step 4: Create the two target directories so `loadTargetIds` passes**

The first test expects `["cli-flags", "devkit"]`. Create both directories now with their `target.json`; the `image` objects are written by Task 10. Run `git rev-parse origin/main` and use that 40-hex value wherever `<PIN>` appears below. Both targets share it.

Create `targets/cli-flags/target.json`:

```json
{
  "id": "cli-flags",
  "pin": "<PIN>",
  "root": "examples/software-factory/server/fixtures/cli-flags/project",
  "capture": { "include": ["LICENSE", "package-lock.json", "package.json", "src", "test"] },
  "snapshotIgnore": [],
  "imageContext": [
    "examples/software-factory/server/fixtures/cli-flags/project/package.json",
    "examples/software-factory/server/fixtures/cli-flags/project/package-lock.json"
  ],
  "lockfile": "examples/software-factory/server/fixtures/cli-flags/project/package-lock.json",
  "imageAssertResolves": ["commander", "tsx"],
  "environmentLinks": [{ "path": "node_modules", "target": "/opt/targets/cli-flags/node_modules" }],
  "commands": {
    "cwd": ".",
    "build": [],
    "test": ["npm", "test"],
    "nodeTestExecArgv": ["--import", "tsx"]
  },
  "runnerConfig": ["package.json"],
  "resources": { "memoryMb": 1024, "cpus": 1, "commandTimeoutMs": 120000, "verifierDeadlineMs": 300000 }
}
```

Create `targets/devkit/target.json`:

```json
{
  "id": "devkit",
  "pin": "<PIN>",
  "root": ".",
  "capture": {
    "include": ["package.json", "pnpm-workspace.yaml", ".npmrc", "packages/devkit", "packages/config-typescript"]
  },
  "snapshotIgnore": ["packages/devkit/dist/"],
  "imageContext": [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    ".npmrc",
    "packages/devkit/package.json",
    "packages/config-typescript"
  ],
  "lockfile": "pnpm-lock.yaml",
  "imageAssertResolves": ["vitest", "typescript", "@types/node/package.json"],
  "environmentLinks": [{ "path": "node_modules", "target": "/opt/targets/devkit/node_modules" }],
  "commands": {
    "cwd": "packages/devkit",
    "build": ["pnpm", "exec", "tsc", "-b", "tsconfig.json"],
    "test": [
      "pnpm", "exec", "vitest", "--run", "--no-cache", "--config", "vitest.config.ts",
      "--exclude", "test/template-thread-access.test.ts"
    ],
    "nodeTestExecArgv": []
  },
  "runnerConfig": [
    "packages/devkit/package.json",
    "packages/devkit/vitest.config.ts",
    "packages/devkit/tsconfig.json",
    "packages/devkit/tsconfig.test.json"
  ],
  "resources": { "memoryMb": 2048, "cpus": 2, "commandTimeoutMs": 300000, "verifierDeadlineMs": 600000 }
}
```

The `--exclude` in devkit's test command exists because `test/template-thread-access.test.ts` reads `examples/research/server/src`, which is outside the capture. The resources are placeholders until Task 10 measures them.

- [ ] **Step 5: Run the catalog tests**

Run: `npx vitest run test/targets-catalog.test.ts`
Expected: PASS for all seven.

- [ ] **Step 6: Commit**

```bash
git add src/targets/catalog.ts test/targets-catalog.test.ts targets/
git commit -m "feat(software-factory): target catalog

A target describes an environment and how to reproduce it: a pin the
repository must hold, the workspace root within it, what to capture, the
image inputs the prepare script records, one root dependency link, the
per-package commands with their runner arguments, the runner configuration
files every task must keep immutable, and measured resources. cli-flags
and devkit are declared; their image objects arrive with the prepare
script.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The task catalog

**Files:**
- Modify: `src/targets/catalog.ts`
- Test: `test/targets-catalog.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/targets-catalog.test.ts` (add `loadTask`, `loadTaskIds`, `TaskSchema`, `ChecksSchema` to the import):

```ts
/** Write a tasks directory holding one task against target `t`. */
function tasksDirFor(
  overrides: Record<string, unknown> = {},
  files: Record<string, string> = {},
): string {
  const dir = mkdtemp(join(tmpdir(), "factory-tasks-"))
  dirs.push(dir)
  mkdirSync(join(dir, "k", "checks"), { recursive: true })
  writeFileSync(
    join(dir, "k", "task.json"),
    JSON.stringify({
      id: "k",
      target: "t",
      allowedSourcePaths: ["src/a.ts"],
      immutablePaths: ["package.json", "test/a.test.ts"],
      ...overrides,
    }),
  )
  writeFileSync(
    join(dir, "k", "checks.json"),
    JSON.stringify({
      visible: { runner: "vitest", assertions: ["a passes"] },
      independent: { runner: "node-test", file: "checks/k.test.ts", assertions: ["A1"] },
    }),
  )
  writeFileSync(join(dir, "k", "spec.md"), "# k\n\nA1: something holds.\n")
  writeFileSync(join(dir, "k", "reference.patch"), "--- a/src/a.ts\n+++ b/src/a.ts\n")
  writeFileSync(join(dir, "k", "checks", "k.test.ts"), "")
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, "k", name), content)
  return dir
}
const mkdtemp = mkdtempSync

describe("task catalog", () => {
  it("lists the tasks shipped with the factory", () => {
    expect(loadTaskIds()).toEqual(["cli-flags", "devkit-spawn-deadline"])
  })

  it("loads a task with its target, spec, checks and patches", () => {
    const { root, pin } = repo()
    const task = loadTask("k", {
      targetsDir: targetsDir(pin),
      tasksDir: tasksDirFor({}, { "defect.patch": "--- a/src/a.ts\n+++ b/src/a.ts\n" }),
      repositoryRoot: root,
    })
    expect(task.target.id).toBe("t")
    expect(task.specText).toMatch(/A1/)
    expect(task.checks.visible.runner).toBe("vitest")
    expect(task.defectPatch).toMatch(/^--- a/)
    expect(task.referencePatch).toMatch(/^--- a/)
    expect(task.directory.endsWith("/k")).toBe(true)
  })

  it("treats a missing defect patch as a baseline that is already defective", () => {
    const { root, pin } = repo()
    const task = loadTask("k", { targetsDir: targetsDir(pin), tasksDir: tasksDirFor(), repositoryRoot: root })
    expect(task.defectPatch).toBeNull()
  })

  it("refuses an allowed path that is a test, a check, or overlaps immutable", () => {
    expect(TaskSchema.safeParse({ id: "k", target: "t", allowedSourcePaths: ["test/a.test.ts"], immutablePaths: [] }).success).toBe(false)
    expect(TaskSchema.safeParse({ id: "k", target: "t", allowedSourcePaths: ["checks/k.test.ts"], immutablePaths: [] }).success).toBe(false)
    expect(TaskSchema.safeParse({ id: "k", target: "t", allowedSourcePaths: ["src/a.ts"], immutablePaths: ["src/a.ts"] }).success).toBe(false)
  })

  it("refuses a task that may edit the target's runner configuration", () => {
    const { root, pin } = repo()
    expect(() =>
      loadTask("k", {
        targetsDir: targetsDir(pin),
        tasksDir: tasksDirFor({ allowedSourcePaths: ["package.json"], immutablePaths: [] }),
        repositoryRoot: root,
      }),
    ).toThrow(/runner configuration/)
  })

  it("refuses a task that leaves a runner configuration file mutable", () => {
    const { root, pin } = repo()
    expect(() =>
      loadTask("k", {
        targetsDir: targetsDir(pin),
        tasksDir: tasksDirFor({ immutablePaths: ["test/a.test.ts"] }),
        repositoryRoot: root,
      }),
    ).toThrow(/must be immutable/)
  })

  it("refuses an independent check that is not a node-test suite, or whose file is missing", () => {
    expect(
      ChecksSchema.safeParse({
        visible: { runner: "vitest", assertions: ["x"] },
        independent: { runner: "vitest", assertions: ["x"] },
      }).success,
    ).toBe(false)
    const { root, pin } = repo()
    const dir = tasksDirFor()
    rmSync(join(dir, "k", "checks", "k.test.ts"))
    expect(() => loadTask("k", { targetsDir: targetsDir(pin), tasksDir: dir, repositoryRoot: root })).toThrow(
      /checks\/k.test.ts/,
    )
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/targets-catalog.test.ts`
Expected: FAIL, `loadTask` is not exported.

- [ ] **Step 3: Implement the tasks half**

Append to `src/targets/catalog.ts`:

```ts
const NodeTestSuiteSchema = z.object({
  runner: z.literal("node-test"),
  file: z.string().regex(/^(?:test|checks)\/[\w./-]+\.test\.(?:ts|mjs|js)$/),
  assertions: z.array(z.string().min(1)).min(1),
})
const VitestSuiteSchema = z.object({
  runner: z.literal("vitest"),
  assertions: z.array(z.string().min(1)).min(1),
})
export const SuiteSchema = z.discriminatedUnion("runner", [NodeTestSuiteSchema, VitestSuiteSchema])
export type Suite = z.infer<typeof SuiteSchema>
export type NodeTestSuite = z.infer<typeof NodeTestSuiteSchema>
export type VitestSuite = z.infer<typeof VitestSuiteSchema>

/** The independent suite is always a node-test file the verifier writes in itself. */
export const ChecksSchema = z.object({ visible: SuiteSchema, independent: NodeTestSuiteSchema })
export type Checks = z.infer<typeof ChecksSchema>

/**
 * A path the builder may change. Never a test or a check: the factory's completion policy
 * must not be reachable from the builder's own inventory. The target's runner configuration
 * is checked in `loadTask`, where the target is known.
 */
const allowedSourcePath = relativePath
  .refine((p) => !p.endsWith(".test.ts"), "a test file cannot be an allowed source path")
  .refine((p) => !p.startsWith("checks/"), "a check cannot be an allowed source path")

export const TaskSchema = z
  .object({
    id: z.string().min(1),
    target: z.string().min(1),
    allowedSourcePaths: z.array(allowedSourcePath).min(1),
    immutablePaths: z.array(relativePath),
  })
  .refine(
    (m) => m.allowedSourcePaths.every((p) => !m.immutablePaths.includes(p)),
    "allowed and immutable paths must be disjoint",
  )
export type TaskManifest = z.infer<typeof TaskSchema>

export interface Task {
  readonly id: string
  readonly directory: string
  readonly target: Target
  readonly manifest: TaskManifest
  readonly checks: Checks
  /** `spec.md`; hashed into the specification digest and shown to the builder as TASK.md. */
  readonly specText: string
  /** Null when the pinned bytes are already the defective baseline. */
  readonly defectPatch: string | null
  readonly referencePatch: string
}

export function loadTaskIds(dir = tasksDir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

export function loadTask(id: string, options: CatalogOptions = {}): Task {
  const dir = options.tasksDir ?? tasksDir
  if (!loadTaskIds(dir).includes(id)) throw new Error(`Unknown task: ${id}`)
  const directory = join(dir, id)
  const manifest = TaskSchema.parse(JSON.parse(readFileSync(join(directory, "task.json"), "utf8")))
  if (manifest.id !== id) throw new Error(`Task ${id} declares a different id: ${manifest.id}`)
  const target = loadTarget(manifest.target, options)
  for (const path of manifest.allowedSourcePaths)
    if (target.runnerConfig.includes(path))
      throw new Error(`Task ${id} may edit ${path}, which is the target's runner configuration`)
  for (const path of target.runnerConfig)
    if (!manifest.immutablePaths.includes(path))
      throw new Error(`Task ${id}: runner configuration file ${path} must be immutable`)
  const checks = ChecksSchema.parse(JSON.parse(readFileSync(join(directory, "checks.json"), "utf8")))
  const checkFile = join(directory, checks.independent.file)
  if (!existsSync(checkFile)) throw new Error(`Task ${id} names a missing check: ${checks.independent.file}`)
  const defectPath = join(directory, "defect.patch")
  return {
    id,
    directory,
    target,
    manifest,
    checks,
    specText: readFileSync(join(directory, "spec.md"), "utf8"),
    defectPatch: existsSync(defectPath) ? readFileSync(defectPath, "utf8") : null,
    referencePatch: readFileSync(join(directory, "reference.patch"), "utf8"),
  }
}
```

Keep the `existsSync` import at the top of the file (it is used now).

- [ ] **Step 4: Create the two task directories so `loadTaskIds` passes**

Move the rung 1 fixture's task files (the bytes are unchanged; only their location and the manifest shape change):

```bash
mkdir -p tasks/cli-flags/checks tasks/devkit-spawn-deadline/checks
git mv fixtures/cli-flags/task.md tasks/cli-flags/spec.md
git mv fixtures/cli-flags/reference.patch tasks/cli-flags/reference.patch
git mv fixtures/cli-flags/checks/independent.test.ts tasks/cli-flags/checks/independent.test.ts
git rm -q fixtures/cli-flags/manifest.json fixtures/cli-flags/checks.json
```

Create `tasks/cli-flags/task.json`:

```json
{
  "id": "cli-flags",
  "target": "cli-flags",
  "allowedSourcePaths": ["src/cli.ts"],
  "immutablePaths": ["LICENSE", "package-lock.json", "package.json", "src/memory.ts", "test/cli.test.ts"]
}
```

Create `tasks/cli-flags/checks.json`:

```json
{
  "visible": {
    "runner": "node-test",
    "file": "test/cli.test.ts",
    "assertions": ["documented dry-run flag reaches the handler"]
  },
  "independent": {
    "runner": "node-test",
    "file": "checks/independent.test.ts",
    "assertions": [
      "forwards cap and memory-level cwd",
      "rejects unknown and incomplete arguments",
      "dry-run preserves memory state and creates no files"
    ]
  }
}
```

For `tasks/devkit-spawn-deadline/`, create placeholders that Task 11 fills with real content; the loader only needs them to exist and parse:

`tasks/devkit-spawn-deadline/task.json`:

```json
{
  "id": "devkit-spawn-deadline",
  "target": "devkit",
  "allowedSourcePaths": ["packages/devkit/src/testing/process.ts"],
  "immutablePaths": [
    "package.json",
    "pnpm-workspace.yaml",
    ".npmrc",
    "packages/config-typescript",
    "packages/devkit/package.json",
    "packages/devkit/vitest.config.ts",
    "packages/devkit/tsconfig.json",
    "packages/devkit/tsconfig.test.json",
    "packages/devkit/templates",
    "packages/devkit/test",
    "packages/devkit/src/index.ts",
    "packages/devkit/src/templates.ts",
    "packages/devkit/src/write-template.ts",
    "packages/devkit/src/testing/artifacts.ts",
    "packages/devkit/src/testing/generated-app.ts",
    "packages/devkit/src/testing/index.ts",
    "packages/devkit/src/testing/reporting.ts",
    "packages/devkit/src/testing/result-types.ts"
  ]
}
```

`tasks/devkit-spawn-deadline/checks.json`:

```json
{
  "visible": {
    "runner": "vitest",
    "assertions": ["spawnProcess clears the deadline when spawning fails asynchronously"]
  },
  "independent": {
    "runner": "node-test",
    "file": "checks/spawn-deadline.test.ts",
    "assertions": ["A1: a spawn that fails asynchronously leaves no deadline timer running"]
  }
}
```

`tasks/devkit-spawn-deadline/spec.md`, `defect.patch`, `reference.patch` and `checks/spawn-deadline.test.ts`: create each as an empty file for now with `touch`; Task 11 writes them. `reference.patch` must be non-empty to be a patch, so write the single line `# written in Task 11` into it.

- [ ] **Step 5: Run the catalog tests**

Run: `npx vitest run test/targets-catalog.test.ts`
Expected: PASS. (`test/catalog.test.ts` now fails to import; it is deleted in Task 9.)

- [ ] **Step 6: Commit**

```bash
git add src/targets/catalog.ts test/targets-catalog.test.ts tasks/ fixtures/
git commit -m "feat(software-factory): task catalog, cli-flags re-expressed as a task

A task is one repair against one target: allowed and immutable paths, a
spec with acceptance ids, optional defect and reference patches, and the
independent checks, which are always a node-test file the verifier writes
in itself. Loading cross-checks the target's runner configuration: a task
may not edit it and must keep it immutable, or the immutable-tests
guarantee is hollow. The rung 1 fixture's task files move under tasks/
byte for byte.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

> **Task 3 as landed (review-driven).** The catalog's path rules reuse `relativePath` and a prefix-aware `covers(entries, path)`: suite files are canonical relative paths with distinct schemas for the visible file (never under `checks/`) and the independent file (always under `checks/`); allowed-versus-protected overlap is symmetric (`overlaps`), so an allowed directory cannot swallow a protected file; a `node-test` visible suite must be immutable; and `assertTaskFitsTarget(id, manifest, checks, target)` carries the cross-checks so the shipped tasks are checked in layer 1 without a prepared target. `.strict()` on every schema. `src/fixtures` keeps loading through a commented bridge until Task 9.

### Task 4: The archive step

**Files:**
- Create: `src/targets/archive.ts`
- Test: `test/targets-archive.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/targets-archive.test.ts`:

```ts
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { captureTarget } from "../src/targets/archive.ts"
import type { Task } from "../src/targets/catalog.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A repository with a subdirectory, an untracked file, and one commit. */
function repo(): { root: string; pin: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-archive-repo-"))
  dirs.push(root)
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  mkdirSync(join(root, "pkg", "src"), { recursive: true })
  writeFileSync(join(root, "pkg", "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(root, "pkg", "package.json"), "{}\n")
  writeFileSync(join(root, "other.txt"), "other\n")
  git("add", ".")
  git("commit", "-q", "-m", "one")
  writeFileSync(join(root, "pkg", "src", "untracked.ts"), "not committed\n")
  writeFileSync(join(root, "pkg", "src", "a.ts"), "export const a = 2 // dirty working tree\n")
  return { root, pin: git("rev-parse", "HEAD") }
}

const defect = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = 1
+export const a = 0
`

function task(root: string, pin: string, overrides: Partial<Task> = {}): Task {
  return {
    id: "k",
    directory: "/unused",
    manifest: { id: "k", target: "t", allowedSourcePaths: ["src/a.ts"], immutablePaths: [] },
    checks: {
      visible: { runner: "vitest", assertions: ["x"] },
      independent: { runner: "node-test", file: "checks/k.test.ts", assertions: ["x"] },
    },
    specText: "spec",
    defectPatch: null,
    referencePatch: "",
    target: {
      id: "t",
      directory: "/unused",
      pin,
      root: "pkg",
      capture: { include: ["src", "package.json"] },
      snapshotIgnore: [],
      image: {
        localId: `sha256:${"a".repeat(64)}`,
        platform: "linux/arm64",
        baseManifestDigest: `sha256:${"b".repeat(64)}`,
        dockerfileSha256: "c".repeat(64),
        lockfileSha256: "d".repeat(64),
        pnpmVersion: "10.33.0",
      },
      imageContext: ["package.json"],
      lockfile: "package.json",
      imageAssertResolves: [],
      environmentLinks: [{ path: "node_modules", target: "/opt/targets/t/node_modules" }],
      commands: { cwd: ".", build: [], test: ["x"], nodeTestExecArgv: [] },
      runnerConfig: ["package.json"],
      resources: { memoryMb: 1, cpus: 1, commandTimeoutMs: 1, verifierDeadlineMs: 1 },
    },
    ...overrides,
  }
}

describe("captureTarget", () => {
  it("archives the pinned subtree, not the working tree, into an app-relative directory", () => {
    const { root, pin } = repo()
    const appRoot = mkdtempSync(join(tmpdir(), "factory-archive-app-"))
    dirs.push(appRoot)
    const captured = captureTarget(task(root, pin), "controller", { appRoot, repositoryRoot: root })
    expect(captured.directory).toBe(".factory/captures/controller/k")
    expect(captured.absolute).toBe(join(appRoot, ".factory", "captures", "controller", "k"))
    expect(readFileSync(join(captured.absolute, "src", "a.ts"), "utf8")).toBe("export const a = 1\n")
    expect(existsSync(join(captured.absolute, "src", "untracked.ts"))).toBe(false)
    expect(existsSync(join(captured.absolute, "other.txt"))).toBe(false)
    expect(readdirSync(captured.absolute).sort()).toEqual(["package.json", "src"])
  })

  it("applies the defect patch, and rebuilds the directory on every capture", () => {
    const { root, pin } = repo()
    const appRoot = mkdtempSync(join(tmpdir(), "factory-archive-app-"))
    dirs.push(appRoot)
    const first = captureTarget(task(root, pin, { defectPatch: defect }), "builder", { appRoot, repositoryRoot: root })
    expect(readFileSync(join(first.absolute, "src", "a.ts"), "utf8")).toBe("export const a = 0\n")
    writeFileSync(join(first.absolute, "stray.txt"), "left behind\n")
    const second = captureTarget(task(root, pin, { defectPatch: defect }), "builder", { appRoot, repositoryRoot: root })
    expect(second.absolute).toBe(first.absolute)
    expect(existsSync(join(second.absolute, "stray.txt"))).toBe(false)
  })

  it("keeps the builder's and the controller's copies apart", () => {
    const { root, pin } = repo()
    const appRoot = mkdtempSync(join(tmpdir(), "factory-archive-app-"))
    dirs.push(appRoot)
    const builder = captureTarget(task(root, pin), "builder", { appRoot, repositoryRoot: root })
    const controller = captureTarget(task(root, pin), "controller", { appRoot, repositoryRoot: root })
    expect(builder.absolute).not.toBe(controller.absolute)
  })

  it("throws when the defect patch does not apply", () => {
    const { root, pin } = repo()
    const appRoot = mkdtempSync(join(tmpdir(), "factory-archive-app-"))
    dirs.push(appRoot)
    const wrong = defect.replace("-export const a = 1", "-export const a = 9")
    expect(() =>
      captureTarget(task(root, pin, { defectPatch: wrong }), "builder", { appRoot, repositoryRoot: root }),
    ).toThrow(/defect patch/)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/targets-archive.test.ts`
Expected: FAIL, "Cannot find module '../src/targets/archive.ts'".

- [ ] **Step 3: Implement**

Create `src/targets/archive.ts`:

```ts
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appRoot as defaultAppRoot, repositoryRoot as defaultRepositoryRoot, type Task } from "./catalog.js"

export interface CapturedTarget {
  /** App-relative, forward-slash: what the framework's capture accepts. */
  readonly directory: string
  readonly absolute: string
}

export interface CaptureTargetOptions {
  readonly appRoot?: string
  readonly repositoryRoot?: string
}

/**
 * The baseline for a task: the target's pinned subtree with the task's defect applied.
 *
 * Archived from the repository's object store, never its working tree, so uncommitted
 * edits are invisible and two captures of one pin are byte-identical. Extracted under the
 * app root because the framework's capture takes an app-relative path, and per `role`
 * because the builder's process and the controller's process each capture for themselves
 * and must not rebuild one directory under each other. Synchronous because `b4.config.ts`
 * needs the builder's copy at load time. Rebuilt on every call: there is no cache to
 * invalidate.
 */
export function captureTarget(
  task: Task,
  role: string,
  options: CaptureTargetOptions = {},
): CapturedTarget {
  if (!/^[\w-]+$/.test(role)) throw new Error(`Invalid capture role: ${role}`)
  const appRoot = options.appRoot ?? defaultAppRoot
  const repo = options.repositoryRoot ?? defaultRepositoryRoot()
  const directory = `.factory/captures/${role}/${task.id}`
  const absolute = join(appRoot, ".factory", "captures", role, task.id)
  rmSync(absolute, { recursive: true, force: true })
  mkdirSync(absolute, { recursive: true })

  const { pin, root, capture } = task.target
  const treeish = root === "." ? pin : `${pin}:${root}`
  const tar = join(absolute, "..", `${task.id}.${role}.tar`)
  execFileSync("git", ["-C", repo, "archive", "--format=tar", "-o", tar, treeish, "--", ...capture.include])
  try {
    execFileSync("tar", ["-xf", tar, "-C", absolute])
  } finally {
    rmSync(tar, { force: true })
  }

  if (task.defectPatch !== null) {
    const patch = join(absolute, "..", `${task.id}.${role}.defect.patch`)
    writeFileSync(patch, task.defectPatch)
    try {
      const applied = spawnSync("git", ["apply", patch], { cwd: absolute, encoding: "utf8" })
      if (applied.status !== 0)
        throw new Error(`Task ${task.id}: defect patch did not apply to ${pin}:\n${applied.stderr}`)
    } finally {
      rmSync(patch, { force: true })
    }
  }
  return { directory, absolute }
}
```

- [ ] **Step 4: Run the archive tests**

Run: `npx vitest run test/targets-archive.test.ts`
Expected: PASS for all four.

- [ ] **Step 5: Commit**

```bash
git add src/targets/archive.ts test/targets-archive.test.ts
git commit -m "feat(software-factory): capture a target's baseline from the pinned commit

git archive <pin>:<root> over the target's include list, extracted under
.factory/captures/<role>/<task> and patched with the task's defect. The
working tree is never read, so the baseline depends on the pin alone;
the builder's and the controller's copies are kept apart so two processes
never rebuild one directory under each other.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

> **Task 4 as landed (review-driven).** `captureTarget(task, role: CaptureRole, options)` where `CaptureRole = "builder" | "controller" | "verifier" | "reference" | "test"`; builds in a scratch sibling and renames into place (a failed capture leaves nothing); `git apply --whitespace=nowarn` with `core.autocrlf=false`; asserts every include path is present after extraction because `git archive` honours `export-ignore` silently.

### Task 5: Target workspace, sandbox policy, inspection options, provider

**Files:**
- Create: `src/targets/workspace.ts`
- Test: `test/targets-workspace.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/targets-workspace.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { loadTask } from "../src/targets/catalog.ts"
import {
  builderSandboxProvider,
  builderSandboxScope,
  targetInspectionOptions,
  targetSandboxPolicy,
  targetWorkspace,
} from "../src/targets/workspace.ts"

// These load the real catalogs; they need the image objects Task 10 writes. Until then, run
// them after Task 10 or accept the "has not been prepared" failure as expected.
describe("targetWorkspace", () => {
  it("captures from the role's archive with the task spec as TASK.md and one root link", () => {
    const task = loadTask("cli-flags")
    const definition = targetWorkspace(task, "controller")
    expect(definition.source.directory).toBe(".factory/captures/controller/cli-flags")
    expect(definition.source.include).toEqual(task.target.capture.include)
    expect(definition.source.files).toEqual([
      { path: "TASK.md", text: task.specText },
      { path: ".gitignore", text: "node_modules/\n" },
    ])
    expect(definition.environmentLinks).toEqual([
      { path: "node_modules", target: "/opt/targets/cli-flags/node_modules" },
    ])
    expect(definition.baseline).toBe("git")
  })

  it("derives the inspection options from the definition", () => {
    const options = targetInspectionOptions(loadTask("devkit-spawn-deadline"))
    expect(options.excludeRootDirectories).toEqual([".git"])
    expect(options.expectedRootSymlinks).toEqual({ node_modules: "/opt/targets/devkit/node_modules" })
  })

  it("derives the sandbox policy from the target's resources and denies the network", () => {
    const policy = targetSandboxPolicy(loadTask("devkit-spawn-deadline").target)
    expect(policy.network?.mode).toBe("deny")
    expect(policy.resources?.timeoutMs).toBe(300_000)
    expect(policy.resources?.memoryMb).toBe(2048)
  })

  it("builds the provider on the target's derived tag and the builder scope", () => {
    const provider = builderSandboxProvider(loadTask("cli-flags").target)
    expect(provider.name).toBe("docker")
    expect(builderSandboxScope).toBe("software-factory-builder")
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/targets-workspace.test.ts`
Expected: FAIL, "Cannot find module '../src/targets/workspace.ts'". (After implementation and before Task 10 the failure becomes "has not been prepared"; that is expected until the image objects exist.)

- [ ] **Step 3: Implement**

Create `src/targets/workspace.ts`:

```ts
import { dockerSandbox } from "@b4run/sandbox"
import type { SandboxPolicy, SandboxProvider, WorkspaceDefinition } from "@b4run/workspace"
import type { WorkspaceReadOptions } from "../worker/workspace-reader.js"
import { type CaptureRole, captureTarget, type CaptureTargetOptions } from "./archive.js"
import { imageTag, type Target, type Task } from "./catalog.js"

/**
 * Storage identity for the builder's sandboxes. Both the builder's own configuration and the
 * controller's reader construct a provider from this, in different processes: the scope and
 * the image are what address a thread's workspace, so a reader built with either different
 * would open a different (or no) workspace. One constructor, so they cannot drift apart.
 */
export const builderSandboxScope = "software-factory-builder"

/** The builder's sandbox provider for a target. Construct one per process; it holds no shared state. */
export function builderSandboxProvider(target: Target): SandboxProvider {
  return dockerSandbox({ scope: builderSandboxScope, image: imageTag(target) })
}

/** Denied network, and the target's measured CPU, memory and per-command ceiling. */
export function targetSandboxPolicy(target: Target): SandboxPolicy {
  return {
    network: { mode: "deny" },
    env: { npm_config_cache: "/tmp/npm-cache", npm_config_update_notifier: "false" },
    resources: {
      memoryMb: target.resources.memoryMb,
      cpus: target.resources.cpus,
      timeoutMs: target.resources.commandTimeoutMs,
    },
  }
}

/**
 * Pure declaration of what the workspace contains: the role's archive of the pinned subtree
 * with the defect applied, the task spec as TASK.md, and the image's dependency tree linked
 * at the root. The independent checks are not in the capture at all: the verifier writes
 * them into its own container after the visible suite has run.
 */
export function targetWorkspace(
  task: Task,
  role: CaptureRole,
  options: CaptureTargetOptions = {},
): WorkspaceDefinition {
  const captured = captureTarget(task, role, options)
  return {
    source: {
      directory: captured.directory,
      include: [...task.target.capture.include],
      files: [
        { path: "TASK.md", text: task.specText },
        // Build output the target declares is ignored in the workspace's own git repo too, so
        // the builder's `git status` is not noise; the baseline commit force-adds sources.
        { path: ".gitignore", text: `${["node_modules/", ...task.target.snapshotIgnore].join("\n")}\n` },
      ],
    },
    environmentLinks: task.target.environmentLinks.map((link) => ({ ...link })),
    baseline: "git",
  }
}

/**
 * How a workspace built from {@link targetWorkspace} must be inspected, derived from the
 * target rather than restated by each caller: `baseline: "git"` puts a `.git` directory in
 * the workspace that is not part of the capture, and each environment link is a root symlink
 * inspection refuses to walk unless told its exact target. The reader and the verifier share
 * this so they cannot drift apart.
 */
export function targetInspectionOptions(task: Task): WorkspaceReadOptions {
  const expectedRootSymlinks: Record<string, string> = {}
  for (const link of task.target.environmentLinks) expectedRootSymlinks[link.path] = link.target
  const policy = targetSandboxPolicy(task.target)
  // Inspection can exclude root directories only: build output under a package is walked and
  // counts toward the reader's default limits; `snapshotIgnore` is consumed by the verifier's
  // tamper comparison, not here.
  return {
    excludeRootDirectories: [".git"],
    expectedRootSymlinks,
    ...(policy.security?.runAsNonRoot === undefined
      ? {}
      : { runAsNonRoot: policy.security.runAsNonRoot }),
  }
}
```

- [ ] **Step 4: Typecheck this file alone**

Run: `npx tsc -p . --noEmit 2>&1 | grep "src/targets/" || echo "targets clean"`
Expected: `targets clean`. (Other files still fail until Task 6 and Task 9.)

- [ ] **Step 5: Commit**

```bash
git add src/targets/workspace.ts test/targets-workspace.test.ts
git commit -m "feat(software-factory): workspace, policy, inspection and provider from a target

One derivation for the builder config, the reader and the verifier: the
role's archive as the source, the spec as TASK.md, the target's root link,
resources from the target's measured limits, inspection options from the
definition itself. The workspace test runs green once the targets are
prepared in Task 10.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

> **Ordering change during execution.** Task 10 (Dockerfiles, prepare script, image objects, measured resources) runs BEFORE Task 6. `loadPolicy` in Task 6 loads a target, and `loadTarget` refuses a target without an `image` object, so running Task 6 first would red every layer 1 test that calls `loadPolicy` until Task 10, violating the green-at-every-commit gate. Task 10 depends only on the catalog (Task 2) and Docker.

### Task 6: Policy and baseline over the catalogs

**Files:**
- Modify: `src/verification/policy.ts`
- Modify: `src/verification/baseline.ts`
- Test: `test/bundle.test.ts` (the `loadPolicy` describe)

- [ ] **Step 1: Update the failing tests**

In `test/bundle.test.ts`, the `describe("loadPolicy")` block calls `loadPolicy("cli-flags")` and asserts digests and that "the policy digest moves when the inventory changes". Read it, keep its intent, and add one test inside that describe:

```ts
  it("binds the target's environment, so a changed image or baseline definition moves the policy", () => {
    const policy = loadPolicy("cli-flags")
    expect(policy.environment.identity).toMatch(/^[a-f0-9]{64}$/)
    expect(policy.environment.pin).toMatch(/^[a-f0-9]{40}$/)
    expect(policy.environment.defectPatchSha256).toBeNull()
    expect(policy.environment.root).toBe("examples/software-factory/server/fixtures/cli-flags/project")
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/bundle.test.ts -t "binds the target"`
Expected: FAIL, `policy.environment` is undefined (and TypeScript errors on the property).

- [ ] **Step 3: Rewrite `policy.ts`**

Replace `src/verification/policy.ts` with:

```ts
import { createHash } from "node:crypto"
import {
  type PolicyEnvironment,
  policyDigest,
  specificationDigest,
} from "../domain/digest.js"
import { type Checks, environmentIdentity, loadTask, type Task } from "../targets/catalog.js"

export interface VerificationPolicy {
  readonly taskId: string
  readonly task: Task
  readonly checks: Checks
  readonly allowedSourcePaths: readonly string[]
  readonly immutablePaths: readonly string[]
  /** The named assertions across both suites: the acceptance criteria. */
  readonly acceptanceIds: readonly string[]
  readonly environment: PolicyEnvironment
  readonly specificationDigest: string
  readonly policyDigest: string
}

/** The completion policy, derived from catalog data the controller owns. */
export function loadPolicy(taskId: string): VerificationPolicy {
  const task = loadTask(taskId)
  const acceptanceIds = [...task.checks.visible.assertions, ...task.checks.independent.assertions]
  const environment: PolicyEnvironment = {
    identity: environmentIdentity(task.target),
    pin: task.target.pin,
    root: task.target.root,
    captureInclude: task.target.capture.include,
    defectPatchSha256:
      task.defectPatch === null ? null : createHash("sha256").update(task.defectPatch).digest("hex"),
  }
  return {
    taskId,
    task,
    checks: task.checks,
    allowedSourcePaths: task.manifest.allowedSourcePaths,
    immutablePaths: task.manifest.immutablePaths,
    acceptanceIds,
    environment,
    specificationDigest: specificationDigest(task.specText, acceptanceIds),
    policyDigest: policyDigest({
      checks: task.checks,
      allowedSourcePaths: task.manifest.allowedSourcePaths,
      immutablePaths: task.manifest.immutablePaths,
      environment,
    }),
  }
}
```

- [ ] **Step 4: Rewrite `baseline.ts`**

Replace `src/verification/baseline.ts` with:

```ts
import { captureWorkspaceDefinition, readSourceFile } from "@b4run/workspace/node"
import { appRoot, loadTask } from "../targets/catalog.js"
import { targetWorkspace } from "../targets/workspace.js"

export interface CapturedBaseline {
  readonly digest: string
  readonly files: ReadonlyMap<string, string>
}

/**
 * The controller's own baseline: the target's pinned subtree with the task's defect applied,
 * archived into the controller's own capture directory and captured with the framework's own
 * capture, so the digest it compares against is one it derived, never one a builder reported.
 *
 * The decoder is `fatal`, so a file that is not valid UTF-8 is a capture failure rather than
 * a silent field of replacement characters that would then diff against whatever the builder
 * actually wrote.
 */
export async function captureTargetBaseline(
  taskId: string,
  signal: AbortSignal,
): Promise<CapturedBaseline> {
  const task = loadTask(taskId)
  const captured = await captureWorkspaceDefinition(appRoot, targetWorkspace(task, "controller"), {
    signal,
  })
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const files = new Map<string, string>()
  for (const entry of captured.source.files)
    files.set(entry.path, decoder.decode(readSourceFile(captured.source, entry.path)))
  return { digest: captured.source.digest, files }
}
```

- [ ] **Step 5: Run the bundle tests**

Run: `npx vitest run test/bundle.test.ts`
Expected: the `loadPolicy` describe passes only once Task 10 has written the image objects (loading a target refuses an unprepared one). Until then the failure is "has not been prepared"; record that and move on. The `freezeBundle` describe must still pass now.

- [ ] **Step 6: Commit**

```bash
git add src/verification/policy.ts src/verification/baseline.ts test/bundle.test.ts
git commit -m "feat(software-factory): policy and baseline over the target and task catalogs

The policy binds the target's environment identity, pin, root, capture list
and defect patch hash; the baseline is the framework's capture of the
controller's own archive of the pinned subtree.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

> **Task 6 as landed (review-driven).** `policyEnvironment(task)` is exported and tested per field. The framework's capture requires an exact flat file inventory, so `targetWorkspace` derives `source.include` by walking the extracted archive (`capturedFiles`), refuses the reserved `TASK.md`/`.gitignore` names, and only accepts regular files. `captureTargetBaseline` captures into a per-call `instance` directory and removes it once the bytes are in memory (two work orders on one task may verify concurrently). A fast-lane test pins the controller's pinned archive to the builder's working-tree fixture for as long as the `src/fixtures` bridge lives.

### Task 7: Suite runners: node-test with execArgv, vitest with a JSON report, build

**Files:**
- Modify: `src/verification/checks-runner.ts`
- Test: `test/checks-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/checks-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { gradeNodeTestEvents, gradeVitestReport, shellJoin } from "../src/verification/checks-runner.ts"

describe("shellJoin", () => {
  it("single-quotes every argument so a manifest cannot smuggle shell syntax", () => {
    expect(shellJoin(["pnpm", "exec", "vitest", "--run"])).toBe("'pnpm' 'exec' 'vitest' '--run'")
    expect(shellJoin(["echo", "a b; rm -rf /", "it's"])).toBe("'echo' 'a b; rm -rf /' 'it'\\''s'")
  })
})

const report = (results: { fullName: string; status: string }[], failed = 0) =>
  JSON.stringify({
    numFailedTests: failed,
    numTotalTests: results.length,
    testResults: [{ name: "test/a.test.ts", status: failed ? "failed" : "passed", assertionResults: results }],
  })

describe("gradeVitestReport", () => {
  it("passes when every named assertion passed exactly once and nothing failed", () => {
    const graded = gradeVitestReport(0, report([{ fullName: "a passes", status: "passed" }, { fullName: "b passes", status: "passed" }]), ["a passes"])
    expect(graded.verdict).toBe("pass")
    expect(graded.events).toEqual([
      { type: "test:pass", name: "a passes" },
      { type: "test:pass", name: "b passes" },
    ])
  })

  it("fails when a named assertion failed, or any test failed", () => {
    expect(gradeVitestReport(1, report([{ fullName: "a passes", status: "failed" }], 1), ["a passes"]).verdict).toBe("fail")
    expect(gradeVitestReport(1, report([{ fullName: "a passes", status: "passed" }, { fullName: "c", status: "failed" }], 1), ["a passes"]).verdict).toBe("fail")
  })

  it("is inconclusive when a named assertion is missing, skipped, or the report is unreadable", () => {
    expect(gradeVitestReport(0, report([{ fullName: "b passes", status: "passed" }]), ["a passes"]).verdict).toBe("inconclusive")
    expect(gradeVitestReport(0, report([{ fullName: "a passes", status: "skipped" }]), ["a passes"]).verdict).toBe("inconclusive")
    expect(gradeVitestReport(0, "not json", ["a passes"]).verdict).toBe("inconclusive")
    expect(gradeVitestReport(0, report([{ fullName: "a passes", status: "passed" }, { fullName: "a passes", status: "passed" }]), ["a passes"]).verdict).toBe("inconclusive")
  })

  it("is inconclusive on a zero exit code with a failure count, which is a runner defect", () => {
    expect(gradeVitestReport(0, report([{ fullName: "a passes", status: "passed" }], 1), ["a passes"]).verdict).toBe("inconclusive")
  })
})

describe("gradeNodeTestEvents", () => {
  const ev = (type: string, name: string, skip = false) => ({ type, name, skip, todo: false })
  it("passes only on exactly the named passing events", () => {
    expect(gradeNodeTestEvents(0, [ev("test:pass", "x")], ["x"]).verdict).toBe("pass")
    expect(gradeNodeTestEvents(0, [ev("test:pass", "x"), ev("test:pass", "y")], ["x"]).verdict).toBe("inconclusive")
    expect(gradeNodeTestEvents(1, [ev("test:fail", "x")], ["x"]).verdict).toBe("fail")
    expect(gradeNodeTestEvents(0, [ev("test:pass", "x", true)], ["x"]).verdict).toBe("inconclusive")
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/checks-runner.test.ts`
Expected: FAIL, `gradeVitestReport`, `gradeNodeTestEvents` and `shellJoin` are not exported.

- [ ] **Step 3: Rewrite the runner**

Replace `src/verification/checks-runner.ts` with:

```ts
import type { SandboxHandle } from "@b4run/workspace"
import type { Verdict } from "../domain/work-order.js"
import type { NodeTestSuite, Target, VitestSuite } from "../targets/catalog.js"

export interface SuiteEvent {
  readonly type: string
  readonly name: string
}

export interface SuiteResult {
  readonly verdict: Verdict
  readonly output: string
  readonly events: readonly SuiteEvent[]
}

export interface RawEvent {
  readonly type: string
  readonly name: string
  readonly skip: boolean
  readonly todo: boolean
}

/** Single-quote every argument. A manifest's argv is data, never shell syntax. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ")
}

const VITEST_REPORT = "/tmp/b4-factory-vitest-report.json"

/**
 * Grade a `node:test` event list against the suite's named assertions.
 *
 * A pass requires every expected assertion to appear exactly once as a passing event, with
 * no skips and no extras. Anything the harness could not determine is `inconclusive`, never
 * `pass`: a suite that did not run is not a suite that succeeded.
 */
export function gradeNodeTestEvents(
  exitCode: number,
  events: readonly RawEvent[],
  expected: readonly string[],
): { verdict: Verdict; events: SuiteEvent[] } {
  const passed =
    exitCode === 0 &&
    expected.length > 0 &&
    events.length === expected.length &&
    events.every((event) => event.type === "test:pass" && !event.skip && !event.todo) &&
    expected.every((name) => events.filter((event) => event.name === name).length === 1)
  const sawFailure = events.some((event) => event.type === "test:fail")
  return {
    verdict: passed ? "pass" : sawFailure ? "fail" : "inconclusive",
    events: events.map((event) => ({ type: event.type, name: event.name })),
  }
}

/**
 * Grade a vitest JSON report against the suite's named assertions.
 *
 * Unlike a node-test suite, a package suite is not enumerated: extra passing tests are fine.
 * A pass requires a zero exit, zero failures, and every named assertion passed exactly once.
 * Any failure anywhere is `fail`. A named assertion that is missing or skipped, an unreadable
 * report, or a zero exit that nonetheless counts failures (a runner defect) is
 * `inconclusive`.
 */
export function gradeVitestReport(
  exitCode: number,
  reportJson: string,
  expected: readonly string[],
): { verdict: Verdict; events: SuiteEvent[] } {
  let report: {
    numFailedTests?: unknown
    testResults?: { assertionResults?: { fullName?: unknown; status?: unknown }[] }[]
  }
  try {
    report = JSON.parse(reportJson)
  } catch {
    return { verdict: "inconclusive", events: [] }
  }
  const results = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? [])
  const events: SuiteEvent[] = results.map((r) => ({
    type: r.status === "passed" ? "test:pass" : r.status === "failed" ? "test:fail" : `test:${String(r.status)}`,
    name: String(r.fullName ?? ""),
  }))
  const failed = typeof report.numFailedTests === "number" ? report.numFailedTests : Number.NaN
  const sawFailure = failed > 0 || events.some((e) => e.type === "test:fail")
  if (sawFailure && exitCode !== 0) return { verdict: "fail", events }
  if (sawFailure) return { verdict: "inconclusive", events }
  const passed =
    exitCode === 0 &&
    failed === 0 &&
    expected.length > 0 &&
    expected.every((name) => events.filter((e) => e.type === "test:pass" && e.name === name).length === 1)
  return { verdict: passed ? "pass" : "inconclusive", events }
}

/** Run a command at the target's cwd and capture its exit code and output. */
async function runAt(
  handle: SandboxHandle,
  target: Target,
  argv: readonly string[],
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cd = target.commands.cwd === "." ? "" : `cd ${shellJoin([target.commands.cwd])} && `
  return handle.exec.runCommand(
    { command: `${cd}${shellJoin(argv)}` },
    { workspaceRoot: handle.workspaceRoot, signal },
  )
}

export interface BuildResult {
  readonly ok: boolean
  readonly output: string
}

/** The target's build step. An empty build argv is a target with nothing to build. */
export async function runBuild(handle: SandboxHandle, target: Target, signal: AbortSignal): Promise<BuildResult> {
  if (target.commands.build.length === 0) return { ok: true, output: "(no build step)\n" }
  const result = await runAt(handle, target, target.commands.build, signal)
  return { ok: result.exitCode === 0, output: `${result.stdout}\n${result.stderr}` }
}

/**
 * Run one `node:test` suite inside the sandbox. The parent runner uses built-ins only; the
 * suite runs in a child process with the target's `nodeTestExecArgv`, so its stdout arrives as
 * a `test:stdout` event and cannot forge a `test:pass` receipt.
 */
export async function runNodeTestSuite(
  handle: SandboxHandle,
  target: Target,
  suite: NodeTestSuite,
  signal: AbortSignal,
): Promise<SuiteResult> {
  const program = `
const { run } = require('node:test')
;(async () => {
  const events = []
  let output = ''
  for await (const event of run({ files: [${JSON.stringify(suite.file)}], execArgv: ${JSON.stringify(target.commands.nodeTestExecArgv)}, concurrency: 1 })) {
    if (event.type === 'test:pass' || event.type === 'test:fail')
      events.push({ type: event.type, name: event.data.name, skip: !!event.data.skip, todo: !!event.data.todo })
    if (event.type === 'test:stdout' || event.type === 'test:stderr') output += event.data.message
  }
  process.stdout.write(JSON.stringify({ events, output }))
})().catch((error) => { console.error(error); process.exitCode = 1 })
`
  let result: { stdout: string; stderr: string; exitCode: number }
  try {
    result = await handle.exec.runCommand(
      { command: `/usr/local/bin/node <<'B4_SUITE_PROGRAM'\n${program}\nB4_SUITE_PROGRAM` },
      { workspaceRoot: handle.workspaceRoot, signal },
    )
  } catch (error) {
    if (signal.aborted) throw error
    return { verdict: "inconclusive", output: `suite did not run: ${String(error)}`, events: [] }
  }
  let parsed: { events: RawEvent[]; output: string }
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { verdict: "inconclusive", output: `${result.stdout}\n${result.stderr}`, events: [] }
  }
  const graded = gradeNodeTestEvents(result.exitCode, parsed.events, suite.assertions)
  return { verdict: graded.verdict, output: parsed.output, events: graded.events }
}

/**
 * Run the target's vitest invocation with a JSON reporter appended, and grade the report.
 * The report goes to `/tmp`, the one writable place in a read-only container, and is read
 * back in the same command so the runner sees exactly the file that run produced.
 */
export async function runVitestSuite(
  handle: SandboxHandle,
  target: Target,
  suite: VitestSuite,
  signal: AbortSignal,
): Promise<SuiteResult> {
  const argv = [...target.commands.test, "--reporter=json", `--outputFile=${VITEST_REPORT}`]
  const cd = target.commands.cwd === "." ? "" : `cd ${shellJoin([target.commands.cwd])} && `
  const command = `rm -f ${VITEST_REPORT}; ${cd}${shellJoin(argv)}; code=$?; echo; echo B4_FACTORY_REPORT; cat ${VITEST_REPORT} 2>/dev/null; exit $code`
  let result: { stdout: string; stderr: string; exitCode: number }
  try {
    result = await handle.exec.runCommand({ command }, { workspaceRoot: handle.workspaceRoot, signal })
  } catch (error) {
    if (signal.aborted) throw error
    return { verdict: "inconclusive", output: `suite did not run: ${String(error)}`, events: [] }
  }
  const marker = result.stdout.lastIndexOf("B4_FACTORY_REPORT\n")
  const output = marker === -1 ? result.stdout : result.stdout.slice(0, marker)
  const reportJson = marker === -1 ? "" : result.stdout.slice(marker + "B4_FACTORY_REPORT\n".length)
  const graded = gradeVitestReport(result.exitCode, reportJson, suite.assertions)
  return { verdict: graded.verdict, output: `${output}\n${result.stderr}`, events: graded.events }
}

/** Dispatch on the suite's runner. */
export function runSuite(
  handle: SandboxHandle,
  target: Target,
  suite: NodeTestSuite | VitestSuite,
  signal: AbortSignal,
): Promise<SuiteResult> {
  return suite.runner === "vitest"
    ? runVitestSuite(handle, target, suite, signal)
    : runNodeTestSuite(handle, target, suite, signal)
}
```

- [ ] **Step 4: Run the runner tests**

Run: `npx vitest run test/checks-runner.test.ts`
Expected: PASS for all six.

- [ ] **Step 5: Commit**

```bash
git add src/verification/checks-runner.ts test/checks-runner.test.ts
git commit -m "feat(software-factory): vitest and build runners beside the node-test runner

A suite names its runner. The node-test runner takes the target's execArgv
instead of a hard-coded --import tsx; the vitest runner appends a JSON
reporter to the target's invocation and grades the report as pure data;
the build step runs the target's build argv at its cwd. Every argv is
single-quoted, so a manifest is never shell syntax.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

> **Task 7 as landed (review-driven).** `runVitestSuite` names its report path and stdout marker with a per-run nonce, runs `--reporter=default` beside `--reporter=json` so the tests' output and vitest's failure rendering reach the pre-marker stream, and folds `failureMessages` into the output on a non-pass. `gradeVitestReport` validates the parsed report with zod (a parseable non-report grades inconclusive, never throws), requires `numTotalTests ≥ expected.length`, and treats an absent `numFailedTests` as inconclusive. The residual (a background writer that reads the nonce from argv) is in the spec's risks. `runFixtureSuite` is the rung 1 bridge the verifier calls until Task 8 rewrites it; `captureDirectory(taskId, role, instance?)` is exported from `archive.ts`.

### Task 8: The verifier over targets

**Files:**
- Modify: `src/verification/docker-verifier.ts`
- Test: `test/docker-verifier.test.ts` (new, layer 1, pure helpers)

- [ ] **Step 1: Write the failing test for the tamper filter**

Create `test/docker-verifier.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { changedOutside } from "../src/verification/docker-verifier.ts"

describe("changedOutside", () => {
  const before = { "packages/devkit/src/a.ts": "1", "packages/devkit/dist/a.js": "old" }
  it("ignores changes under the snapshotIgnore prefixes and nothing else", () => {
    expect(changedOutside(before, { ...before, "packages/devkit/dist/a.js": "new" }, ["packages/devkit/dist/"])).toBe(false)
    expect(changedOutside(before, { ...before, "packages/devkit/dist/b.js": "added" }, ["packages/devkit/dist/"])).toBe(false)
    expect(changedOutside(before, { ...before, "packages/devkit/src/a.ts": "2" }, ["packages/devkit/dist/"])).toBe(true)
    expect(changedOutside(before, { "packages/devkit/src/a.ts": "1" }, ["packages/devkit/dist/"])).toBe(false)
    expect(changedOutside(before, { ...before, "packages/devkit/dist/a.js": "new" }, [])).toBe(true)
  })
  it("compares over sorted entries so key order is never a change", () => {
    const reordered = { "packages/devkit/dist/a.js": "old", "packages/devkit/src/a.ts": "1" }
    expect(changedOutside(before, reordered, [])).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/docker-verifier.test.ts`
Expected: FAIL, `changedOutside` is not exported.

- [ ] **Step 3: Rewrite the verifier**

Replace the imports and the body of `createDockerVerifier` in `src/verification/docker-verifier.ts`. The full file becomes:

```ts
import { randomUUID } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { withWorkspace } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { inspectWorkspace } from "@b4run/workspace"
import type { Receipt } from "../domain/work-order.js"
import type { ArtifactStore } from "../storage/artifacts.js"
import { appRoot, environmentIdentity, imageTag, loadTask } from "../targets/catalog.js"
import { targetInspectionOptions, targetSandboxPolicy, targetWorkspace } from "../targets/workspace.js"
import { runBuild, runSuite, type SuiteResult } from "./checks-runner.js"
import { type Verifier, type VerifyInput, worstVerdict } from "./verifier.js"

export interface DockerVerifierOptions {
  /** Overrides the target's own deadline; only so a test can prove the deadline fires. */
  readonly deadlineMs?: number
}

interface Outcome {
  readonly build: { ok: boolean; output: string }
  readonly tampered: "visible" | "independent" | null
  readonly visible: SuiteResult | null
  readonly independent: SuiteResult | null
}

/**
 * The real verifier. Its container is not the builder's: a different sandbox scope, a
 * freshly captured workspace, and the independent checks written in only after the visible
 * suite has had its turn, from the controller's own copy.
 *
 * The workspace is snapshotted before and after each suite. Any persistent change a suite
 * made outside the target's `snapshotIgnore` prefixes is a rejection, which is what catches
 * a candidate that repairs itself by editing its own tests.
 */
export function createDockerVerifier(
  artifacts: ArtifactStore,
  options: DockerVerifierOptions = {},
): Verifier {
  return {
    async verify(input: VerifyInput, signal: AbortSignal): Promise<Receipt> {
      const task = loadTask(input.taskId)
      const target = task.target
      const deadlineMs = options.deadlineMs ?? target.resources.verifierDeadlineMs
      const stateRoot = join(appRoot, ".factory", "verifiers", randomUUID())
      // Per-call capture: two work orders on one task may verify concurrently.
      const workspace = targetWorkspace(task, "verifier", { instance: randomUUID() })
      const provider = dockerSandbox({ scope: "software-factory-verifier", image: imageTag(target) })
      const identity = environmentIdentity(target)
      const base = () => ({
        id: `rc-${randomUUID()}`,
        workOrderId: input.workOrderId,
        candidateDigest: input.candidateDigest,
        verifierIdentity: `${provider.name}:${identity}`,
        policyDigest: input.policyDigest,
        environmentIdentity: identity,
        issuedAt: new Date().toISOString(),
      })

      const deadline = AbortSignal.timeout(deadlineMs)
      const bounded = AbortSignal.any([signal, deadline])
      const inspection = targetInspectionOptions(task)

      let outcome: Outcome
      try {
        outcome = await withWorkspace(
          {
            appRoot,
            stateRoot,
            provider,
            workspace,
            policy: targetSandboxPolicy(target),
            signal: bounded,
          },
          async (handle) => {
            const snapshot = async () =>
              (
                await inspectWorkspace(handle, {
                  signal: bounded,
                  maxEntries: inspection.maxEntries ?? 10_000,
                  maxFileBytes: inspection.maxFileBytes ?? 2 * 1024 * 1024,
                  maxTotalBytes: inspection.maxTotalBytes ?? 16 * 1024 * 1024,
                  excludeRootDirectories: inspection.excludeRootDirectories,
                  expectedRootSymlinks: inspection.expectedRootSymlinks,
                })
              ).files

            for (const [path, content] of Object.entries(input.changes))
              await handle.filesystem.writeFile(join(handle.workspaceRoot, path), content, {
                workspaceRoot: handle.workspaceRoot,
                signal: bounded,
              })

            const build = await runBuild(handle, target, bounded)
            if (!build.ok) return { build, tampered: null, visible: null, independent: null }

            const beforeVisible = await snapshot()
            const visible = await runSuite(handle, target, task.checks.visible, bounded)
            if (changedOutside(beforeVisible, await snapshot(), target.snapshotIgnore))
              return { build, tampered: "visible" as const, visible, independent: null }

            // Installed here and not before: the visible suite must not be able to read,
            // edit or delete the checks it is graded against a moment later.
            const name = task.checks.independent.file.replace(/^checks\//, "")
            await handle.filesystem.writeFile(
              join(handle.workspaceRoot, "checks", name),
              await readFile(join(task.directory, "checks", name), "utf8"),
              { workspaceRoot: handle.workspaceRoot, signal: bounded },
            )

            const beforeIndependent = await snapshot()
            const independent = await runSuite(handle, target, task.checks.independent, bounded)
            if (changedOutside(beforeIndependent, await snapshot(), target.snapshotIgnore))
              return { build, tampered: "independent" as const, visible, independent }

            return { build, tampered: null, visible, independent }
          },
        )
      } catch (error) {
        // Our own deadline fired: the harness ran out of time, which is a fact about the
        // harness and not about the candidate. A caller cancel is re-thrown untouched.
        if (!deadline.aborted || signal.aborted) throw error
        return {
          ...base(),
          verdict: "inconclusive",
          checks: [
            {
              id: "deadline",
              acceptanceIds: [],
              verdict: "inconclusive",
              evidence: [await put(artifacts, "deadline", `verification exceeded its ${deadlineMs}ms deadline`)],
            },
          ],
        }
      } finally {
        await rm(stateRoot, { recursive: true, force: true })
        await rm(join(appRoot, workspace.source.directory), { recursive: true, force: true })
      }

      // A build that fails is a fact about the candidate, graded as a failed visible check.
      if (!outcome.build.ok)
        return {
          ...base(),
          verdict: "fail",
          checks: [
            {
              id: "build",
              acceptanceIds: [],
              verdict: "fail",
              evidence: [await put(artifacts, "build", outcome.build.output)],
            },
          ],
        }

      if (outcome.tampered)
        return {
          ...base(),
          verdict: "fail",
          checks: [
            {
              id: outcome.tampered,
              acceptanceIds: [],
              verdict: "fail",
              evidence: [
                await put(
                  artifacts,
                  outcome.tampered,
                  `a suite mutated the workspace during ${outcome.tampered}\n${outcome.visible?.output ?? ""}`,
                ),
              ],
            },
          ],
        }

      const visible = outcome.visible
      const independent = outcome.independent
      if (!visible || !independent)
        throw new Error("a suite did not run and no build failure or tamper was recorded")

      return {
        ...base(),
        verdict: worstVerdict([visible.verdict, independent.verdict]),
        checks: suiteChecks({
          visible: {
            verdict: visible.verdict,
            acceptanceIds: task.checks.visible.assertions,
            outputDigest: (await put(artifacts, "visible", visible.output)).digest,
          },
          independent: {
            verdict: independent.verdict,
            acceptanceIds: task.checks.independent.assertions,
            outputDigest: (await put(artifacts, "independent", independent.output)).digest,
          },
        }),
      }
    },
  }
}

/**
 * Any persistent difference outside the ignored prefixes, compared over sorted entries so
 * that a change of key ORDER in an inspection result can never be mistaken for a mutation.
 */
export function changedOutside(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  ignore: readonly string[],
): boolean {
  const keep = (files: Readonly<Record<string, string>>): [string, string][] =>
    Object.entries(files)
      .filter(([path]) => !ignore.some((prefix) => path.startsWith(prefix)))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(keep(before)) !== JSON.stringify(keep(after))
}
```

Keep the existing `put`, `evidenceRef`, `suiteChecks` and `SuiteEvidence` definitions below it unchanged. Delete the old `VERIFIER_DEADLINE_MS` constant and the `changed`/`sorted` helpers.

- [ ] **Step 4: Run the layer 1 verifier test and typecheck**

Run: `npx vitest run test/docker-verifier.test.ts && npx tsc -p . --noEmit 2>&1 | grep -v "fixtures/" | head`
Expected: the test passes. Typecheck errors remaining must all be in files that still import `src/fixtures/` (cli.ts, b4.config.ts, workspace-reader is fine, tests); Task 9 removes them. Any error elsewhere is yours to fix now.

- [ ] **Step 5: Commit**

```bash
git add src/verification/docker-verifier.ts test/docker-verifier.test.ts
git commit -m "feat(software-factory): verifier over targets, with a build step

The verifier loads the task and its target: image tag and environment
identity from the target's image object, deadline and resources from the
target, a build step before the visible suite whose failure is a failed
check with the compiler output as evidence, runner dispatch per suite, and
a tamper comparison that skips the target's snapshotIgnore prefixes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

> **Task 8 as landed.** The verifier is target-driven end to end (`c3bd7861`): per-call verifier capture removed after `withWorkspace` returns, build step, runner dispatch, `changedOutside` with the target's `snapshotIgnore`, identity from the image object, deadline from the target. The rung 1 runner bridge is deleted. The cli-flags Docker lane passes all five tests against the pin archive in about 25 seconds. The build-failure branch has no caller until the devkit target (Task 12). **Rule from review:** `node-test` suites run at the WORKSPACE ROOT whatever `commands.cwd` is; only build and vitest `cd` into it. A check file therefore names the built artifact by its full root-relative path (`packages/devkit/dist/...`), and a cwd-relative import would grade inconclusive.

### Task 9: Retire `src/fixtures`; rewire the CLI, the builder config and every test

**Files:**
- Delete: `src/fixtures/catalog.ts`, `src/fixtures/workspace.ts`, `test/catalog.test.ts`
- Modify: `src/cli.ts`, `b4.config.ts`, `src/app/build/index.ts`, `src/prompts.ts`, `test/reference-repair.ts`, `test/isolated-app.ts`, `test/builder-config.test.ts`, `test/end-to-end.integration.test.ts`, `test/docker-verifier.integration.test.ts`, `test/builder.integration.test.ts`, and any other file `grep` finds
- Modify: `README.md` (this package's parent, `examples/software-factory/README.md`)

- [ ] **Step 1: Find every reference**

Run: `grep -rln "fixtures/catalog\|fixtures/workspace\|captureFixtureBaseline\|fixtureWorkspace\|workspaceInspectionOptions\|sandboxImage\|FACTORY_SANDBOX_IMAGE" src test b4.config.ts ../README.md`
Expected: a list including `src/cli.ts`, `b4.config.ts`, `test/reference-repair.ts`, `test/isolated-app.ts`, `test/builder-config.test.ts`, `test/end-to-end.integration.test.ts`, `test/docker-verifier.integration.test.ts`, `test/builder.integration.test.ts`, `test/catalog.test.ts`, `../README.md`. Every file in the list is handled below; if one is not, handle it the same way.

- [ ] **Step 2: Delete the fixture layer**

```bash
git rm -q src/fixtures/catalog.ts src/fixtures/workspace.ts test/catalog.test.ts
```

- [ ] **Step 3: Rewire `src/cli.ts`**

Replace the import block's fixture lines and the `createFactory` call. Imports become:

```ts
import { appRoot, loadTask } from "./targets/catalog.js"
import { builderSandboxProvider, targetInspectionOptions } from "./targets/workspace.js"
import { captureTargetBaseline } from "./verification/baseline.js"
```

and the two options in `createFactory` become:

```ts
    workspaceReader: createThreadWorkspaceReader(
      // The builder is THIS package (`pnpm dev` here), so its installation store is under
      // this package's root. The provider is per target, so the reader resolves it per task.
      { providerFor: (taskId) => builderSandboxProvider(loadTask(taskId).target), appRoot },
      (taskId) => targetInspectionOptions(loadTask(taskId)),
    ),
    captureBaseline: captureTargetBaseline,
```

`ThreadWorkspaceSource` currently holds one `provider`. Change `src/worker/workspace-reader.ts` so the source is `{ providerFor(taskId: string): SandboxProvider; appRoot: string }` and `read` calls `source.providerFor(target.taskId)`. Update the doc comment: "same kind, scope and image as the builder's `b4.config.ts` for that task". Update `test/workspace-reader.test.ts` wherever it builds a source with `provider:`, to `providerFor: () => provider`.

- [ ] **Step 4: Rewrite `b4.config.ts`**

```ts
import { config } from "@b4run/cli"
import { loadTask } from "./src/targets/catalog.js"
import { builderSandboxProvider, targetSandboxPolicy, targetWorkspace } from "./src/targets/workspace.js"

const task = loadTask(process.env.FACTORY_TASK_ID ?? "cli-flags")

export default config({
  appDir: "src/app",
  build: { targets: ["node"] },
  sandbox: {
    ...targetSandboxPolicy(task.target),
    // Same constructor the controller's workspace reader uses, so the scope and image that
    // address this thread's workspace are one declaration, not two.
    provider: builderSandboxProvider(task.target),
    // The builder's own archive of the pinned subtree; the controller captures its own.
    workspace: targetWorkspace(task, "builder"),
  },
  toolOutput: { previewLines: 10 },
  permissions: {
    allow: {
      // The image's dependency tree is readable inside the container, never writable.
      readFile: task.target.environmentLinks.flatMap((link) => [link.target, `${link.target}/`]),
      listDir: task.target.environmentLinks.map((link) => link.target),
      // Prefix matches on the whole command. Only what the target's own commands need.
      bash: [
        ...(task.target.commands.build.length ? [`${task.target.commands.build.slice(0, 2).join(" ")} `] : []),
        `${task.target.commands.test.slice(0, 2).join(" ")} `,
        "node ",
        "cat",
        "ls",
        "head",
      ],
    },
  },
})
```

For cli-flags the bash list is `["npm test ", "node ", ...]`; for devkit `["pnpm exec ", "pnpm exec ", ...]`. A builder that runs `pnpm exec vitest --run` at `packages/devkit` needs `cd packages/devkit && pnpm exec ...`, which the prefix `pnpm exec ` does not match. Add `"cd packages/devkit && pnpm exec "` by deriving: if `commands.cwd !== "."`, also allow `` `cd ${cwd} && ${first two words} ` ``. Write that derivation inline in the config with a comment.

- [ ] **Step 5: Prompts keyed by task**

Replace `src/prompts.ts` with:

```ts
/**
 * The builder's single turn per task. It edits files and stops. It is not asked to verify
 * or to deliver: verification and delivery are the controller's, and nothing the builder
 * says is read as a verdict. Exported constants so static model fixtures can key to them.
 */
export const TASK_PROMPTS: Readonly<Record<string, string>> = {
  "cli-flags":
    "Read TASK.md. Reproduce the failure with the project's own test command, then repair only the source files TASK.md permits you to change. Do not edit any test. When the repair is complete and the project's tests pass, stop and say so. Use readFile, listDir, writeFile and runBash.",
  "devkit-spawn-deadline":
    "Read TASK.md. The package under repair is packages/devkit; build it with `cd packages/devkit && pnpm exec tsc -b tsconfig.json` and run its tests with `cd packages/devkit && pnpm exec vitest --run --no-cache --config vitest.config.ts --exclude test/template-thread-access.test.ts`. Repair only the source file TASK.md permits you to change. Do not edit any test or configuration. When the repair is complete and the package's tests pass, stop and say so. Use readFile, listDir, writeFile and runBash.",
}
```

In `src/app/build/index.ts`, replace `${TASK_PROMPTS["cli-flags"]}` with `${TASK_PROMPTS[process.env.FACTORY_TASK_ID ?? "cli-flags"] ?? TASK_PROMPTS["cli-flags"]}`.

- [ ] **Step 6: Rewire the test helpers**

Replace `test/reference-repair.ts` with:

```ts
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureTarget } from "../src/targets/archive.ts"
import { loadTask } from "../src/targets/catalog.ts"

/**
 * The reference repair: apply `tasks/<id>/reference.patch` over a throwaway capture of the
 * task's baseline and read the repaired allowed file back. A candidate known to be correct,
 * so a failing verdict over it is the harness's fault and not the candidate's.
 */
export async function applyReference(id = "cli-flags"): Promise<string> {
  const task = loadTask(id)
  const allowed = task.manifest.allowedSourcePaths[0] as string
  const scratch = await mkdtemp(join(tmpdir(), "factory-reference-"))
  try {
    const captured = captureTarget(task, "reference", { appRoot: scratch })
    const patch = join(scratch, "reference.patch")
    await writeFile(patch, task.referencePatch)
    const applied = spawnSync("git", ["apply", patch], { cwd: captured.absolute, encoding: "utf8", timeout: 10_000 })
    if (applied.status !== 0) throw new Error(`Reference patch failed: ${applied.stderr}`)
    return await readFile(join(captured.absolute, allowed), "utf8")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
```

In `test/isolated-app.ts`, change the import to `import { appRoot } from "../src/targets/catalog.ts"`. The copy filter already excludes `.factory`, so captures are not copied; the copied `b4.config.ts` rebuilds the builder's capture at load. The copied app is outside the repository, so every Docker-lane test that opens an isolated app must set `process.env.FACTORY_REPO_ROOT` to the real repository root before `createAgentHarness`. Add to `isolated-app.ts`:

```ts
import { repositoryRoot } from "../src/targets/catalog.ts"
// Called from inside the repository, so this resolves; the copied app cannot.
process.env.FACTORY_REPO_ROOT ??= repositoryRoot()
```

- [ ] **Step 7: Rewire the tests**

`test/builder-config.test.ts`: replace `expect(config.sandbox?.workspace?.source.directory).toBe("fixtures/cli-flags/project")` with `.toBe(".factory/captures/builder/cli-flags")`, and `expect(bash).toContain("npm test")` with `expect(bash).toContain("npm test ")`.

`test/docker-verifier.integration.test.ts`: replace the `loadFixture` import and lines 12-14 with:

```ts
import { loadTask } from "../src/targets/catalog.ts"
const task = loadTask("cli-flags")
const policy = loadPolicy("cli-flags")
const allowed = task.manifest.allowedSourcePaths[0] as string
```

`test/builder.integration.test.ts`: replace `loadFixture` with `loadTask`; `fixture.directory, "project", source` becomes the controller's own capture: replace the `baseline` and `repaired` lines with

```ts
  const task = loadTask("cli-flags")
  const source = task.manifest.allowedSourcePaths[0] as string
  const repaired = await readFile(join(captureTarget(task, "test", { appRoot: await mkdtemp(join(tmpdir(), "factory-b-")) }).absolute, source), "utf8")
```

(import `captureTarget`, `mkdtemp`, `tmpdir`). The final assertion that "the fixture the route captures is still the baseline" becomes: read `join(appRoot, ".factory/captures/builder/cli-flags", source)` and expect it to equal `repaired`.

`test/end-to-end.integration.test.ts`: replace `loadFixture`/`fixtureWorkspace` imports with `loadTask` and `builderSandboxProvider`, `targetInspectionOptions`; `const fixture = loadFixture("cli-flags")` becomes `const task = loadTask("cli-flags")`; every `builderSandboxProvider()` becomes `builderSandboxProvider(task.target)` inside a `providerFor: () => ...` source; `workspaceInspectionOptions` becomes `() => targetInspectionOptions(task)`; `captureFixtureBaseline` becomes `captureTargetBaseline`; `readFile(join(fixture.directory, "task.md"))` becomes `task.specText`.

- [ ] **Step 8: Update the README**

In `examples/software-factory/README.md`: replace the `sandbox:prepare` line with `pnpm exec tsx scripts/prepare-target.ts cli-flags   # builds b4-factory-cli-flags:<pin>` (the script arrives in Task 10; write the line now). Replace the `FACTORY_SANDBOX_IMAGE` row of the environment table with a `FACTORY_REPO_ROOT` row: "no | The repository the targets pin into; default `git rev-parse --show-toplevel`. Set by the Docker-lane tests, which copy the app outside the repository." Change the `FACTORY_TASK_ID` row's text to "Which task `b4.config.ts` configures the builder for; default `cli-flags`". Add a short "Targets and tasks" subsection under "What it proves" pointing at the spec.

- [ ] **Step 9: Run layer 1, typecheck and lint**

Run: `npx tsc -p . --noEmit && npx biome check . && npx vitest run`
Expected: typecheck and lint clean. Layer 1 fails only in tests that load a target, with "has not been prepared", until Task 10. Every other test passes. Record the exact list of "not prepared" failures; it must be empty after Task 10.

- [ ] **Step 10: Commit**

```bash
git status --short examples/code-fixer   # must print nothing
git add -A src test b4.config.ts ../README.md
git commit -m "refactor(software-factory): retire the fixture layer for the target and task catalogs

The controller, the builder config, the reader and every test now derive
from loadTask: the builder's workspace is its own archive of the pinned
subtree, the reader's provider is per target, prompts are keyed by task,
and the copied-app tests set FACTORY_REPO_ROOT because the copy is outside
the repository.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

> **Task 9 as landed (review-driven).** `src/fixtures/` is gone; `fixtures/cli-flags/project` stays as the cli-flags target's source. `ThreadWorkspaceSource.providerFor(taskId)` gives the reader a provider per target. `src/targets/permissions.ts` `builderPermissions(target)` derives the allow-lists: bash entries are the target's FULL build and test invocations, at the root and under `cd <cwd> && `, deduplicated, plus `node `, `cat`, `ls`, `head`; tested exactly for both shipped targets. `src/prompts.ts` `taskPrompt(task)` derives the builder prompt from the same commands (reproduce first, build, test); `taskPrompts(onUnavailable, options)` builds the controller's task table per task and never throws, so an unprepared sibling task is reported as `task_unavailable` and refused as unknown rather than preventing boot. The CLI writes factory events as NDJSON to stderr. The full Docker lane passes (about 56 s). CI still builds only the code-fixer image; Task 14 Step 2b adds `target:prepare`.

### Task 10: Dockerfiles, the prepare script, and measured resources

**Files:**
- Create: `targets/cli-flags/Dockerfile`, `targets/devkit/Dockerfile`, `scripts/prepare-target.ts`
- Modify: `targets/cli-flags/target.json`, `targets/devkit/target.json` (the script writes `image`; you write measured `resources`)
- Modify: `package.json` (script)

- [ ] **Step 1: Write the Dockerfiles**

`targets/cli-flags/Dockerfile` (the same install as code-fixer's, at the target's own path):

```dockerfile
ARG BASE_IMAGE=node:24-slim
ARG PLATFORM=linux/arm64
FROM --platform=${PLATFORM} ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY examples/software-factory/server/fixtures/cli-flags/project/package*.json /opt/targets/cli-flags/
RUN npm ci --prefix /opt/targets/cli-flags --ignore-scripts --no-audit --no-fund
USER node
WORKDIR /workspace
```

`targets/devkit/Dockerfile`:

```dockerfile
ARG BASE_IMAGE=node:24-slim
ARG PLATFORM=linux/arm64
FROM --platform=${PLATFORM} ${BASE_IMAGE}
ARG PNPM_VERSION
# git for the workspace baseline; pnpm via npm, not corepack, because corepack caches the
# binary in the enabling user's home and the container runs as `node` with no network.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@${PNPM_VERSION}
WORKDIR /opt/targets/devkit
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/devkit/package.json packages/devkit/package.json
# Workspace siblings are copied in full: pnpm links a workspace dependency to the sibling
# directory, and a stub copy would resolve to an empty package.
COPY packages/config-typescript packages/config-typescript
# Hoisted, so one root node_modules holds everything and the workspace needs one link.
RUN pnpm install --frozen-lockfile --filter @b4run/devkit... --ignore-scripts --config.node-linker=hoisted \
 && chmod -R a+rX /opt/targets/devkit
USER node
WORKDIR /workspace
```

- [ ] **Step 2: Write the prepare script**

Create `scripts/prepare-target.ts`:

```ts
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { imageTag, repositoryRoot, TargetSchema, targetsDir } from "../src/targets/catalog.js"

/**
 * Build a target's image at its pin and record the inputs that produced it.
 *
 * The build context is a git archive of the target's `imageContext` at the pin plus the
 * Dockerfile, never the working tree. The recorded `image` object is what
 * `environmentIdentity` digests: a local image id is host-specific, so the inputs travel
 * with it.
 */
const id = process.argv[2]
if (!id) throw new Error("usage: prepare-target.ts <target-id>")
const directory = join(targetsDir, id)
const manifestPath = join(directory, "target.json")
const manifest = TargetSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")))
const repo = repositoryRoot()
const sh = (cmd: string, args: string[], opts: { cwd?: string } = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }).trim()

const platform = `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`
execFileSync("docker", ["pull", "--platform", platform, "node:24-slim"], { stdio: "inherit" })
const baseRef = JSON.parse(sh("docker", ["image", "inspect", "node:24-slim"]))[0].RepoDigests[0]
if (typeof baseRef !== "string" || !/^node@sha256:[a-f0-9]{64}$/.test(baseRef))
  throw new Error("Missing base image digest")
const baseManifestDigest = baseRef.slice("node@".length)

const context = mkdtempSync(join(tmpdir(), `factory-prepare-${id}-`))
try {
  const tar = join(context, "context.tar")
  execFileSync("git", ["-C", repo, "archive", "--format=tar", "-o", tar, manifest.pin, "--", ...manifest.imageContext])
  execFileSync("tar", ["-xf", tar, "-C", context])
  rmSync(tar)
  cpSync(join(directory, "Dockerfile"), join(context, "Dockerfile"))

  const rootPackage = JSON.parse(sh("git", ["-C", repo, "show", `${manifest.pin}:package.json`]))
  const pnpmVersion = String(rootPackage.packageManager ?? "").replace(/^pnpm@/, "")
  if (!/^\d+\.\d+\.\d+$/.test(pnpmVersion)) throw new Error(`No pnpm version at ${manifest.pin}`)

  const sha = (text: string) => createHash("sha256").update(text).digest("hex")
  const dockerfileSha256 = sha(readFileSync(join(directory, "Dockerfile"), "utf8"))
  const lockfileSha256 = sha(sh("git", ["-C", repo, "show", `${manifest.pin}:${manifest.lockfile}`]))
  // The tag binds the pin and the Dockerfile (see `imageTag`), so it is computable before the
  // build from a provisional image object; `localId` is the only field the build supplies.
  const provisional = { localId: `sha256:${"0".repeat(64)}`, platform, baseManifestDigest, dockerfileSha256, lockfileSha256, pnpmVersion }
  const tag = imageTag({ id: manifest.id, pin: manifest.pin, image: provisional })
  execFileSync(
    "docker",
    ["build", "--platform", platform, "--build-arg", `BASE_IMAGE=${baseRef}`, "--build-arg", `PLATFORM=${platform}`, "--build-arg", `PNPM_VERSION=${pnpmVersion}`, "-t", tag, context],
    { stdio: "inherit" },
  )
  const localId = sh("docker", ["image", "inspect", tag, "--format", "{{.Id}}"])

  // The install must have produced what the commands need: a frozen install can silently
  // skip a platform-matched optional dependency, and the verifier would blame the builder.
  const cwd = manifest.commands.cwd === "." ? `/opt/targets/${id}` : `/opt/targets/${id}/${manifest.commands.cwd}`
  for (const specifier of manifest.imageAssertResolves)
    execFileSync("docker", ["run", "--rm", "--network", "none", "-w", cwd, tag, "node", "-e", `require.resolve(${JSON.stringify(specifier)})`], { stdio: "inherit" })

  const image = { ...provisional, localId }
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, image }, null, 2)}\n`)
  console.log(JSON.stringify({ tag, ...image }, null, 2))
} finally {
  rmSync(context, { recursive: true, force: true })
}
```

Add to `package.json` scripts: `"target:prepare": "tsx scripts/prepare-target.ts"`.

- [ ] **Step 3: Prepare both targets**

Run: `npx tsx scripts/prepare-target.ts cli-flags && npx tsx scripts/prepare-target.ts devkit`
Expected: two builds, the resolve assertions pass, both `target.json` files gain an `image` object. If the devkit resolve assertion fails, the hoisted install is wrong; inspect with `docker run --rm -it b4-factory-devkit:<pin12> ls /opt/targets/devkit/node_modules | head` before changing anything.

- [ ] **Step 4: Measure devkit's build and test in the image**

Run each three times and record the slowest wall clock:

```bash
TAG=$(node -e 'const t=require("./targets/devkit/target.json");console.log(`b4-factory-devkit:${t.pin.slice(0,12)}-${t.image.dockerfileSha256.slice(0,12)}`)')
ARCH=$(mktemp -d) && git -C "$(git rev-parse --show-toplevel)" archive --format=tar "$(node -e 'console.log(require("./targets/devkit/target.json").pin)')" -- package.json pnpm-workspace.yaml .npmrc packages/devkit packages/config-typescript | tar -x -C "$ARCH"
time docker run --rm --network none --read-only --tmpfs /tmp -v "$ARCH":/workspace -w /workspace/packages/devkit -e HOME=/tmp $TAG sh -c 'ln -s /opt/targets/devkit/node_modules /workspace/node_modules 2>/dev/null; pnpm exec tsc -b tsconfig.json && pnpm exec vitest --run --no-cache --config vitest.config.ts --exclude test/template-thread-access.test.ts'
```

The `-v` mount is writable, which the real workspace volume also is. If `vitest` complains about a cache or a write under `node_modules`, that is the read-only tree; note the exact message and add the flag that avoids it to `commands.test`. Set `resources.commandTimeoutMs` to at least three times the slowest single command and `verifierDeadlineMs` to at least three times the slowest build-plus-test, rounded up to a whole minute; set `memoryMb` from `docker stats` peak times two. Write the three measurements into a comment at the top of the plan's Task 10 in your PR description and into `targets/devkit/target.json` only as numbers (JSON has no comments).

- [ ] **Step 5: Run layer 1 again**

Run: `npx vitest run`
Expected: PASS, including every test that Task 9 recorded as "not prepared". `npx tsc -p . --noEmit && npx biome check .` clean.

- [ ] **Step 6: Commit**

```bash
git add targets scripts package.json
git commit -m "feat(software-factory): target images built at the pin, recorded as inputs

prepare-target.ts archives the target's image context at its pin, builds
the Dockerfile for the host platform from a digest-pinned base, asserts
the modules the commands need resolve inside the image, and writes the
image object (local id plus the inputs that produced it) into target.json.
devkit installs hoisted so one root link serves the workspace. Resources
are measured, three runs, three times headroom.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

> **Task 10 as landed (review-driven).** Both targets prepared (`FACTORY_SKIP_BASE_PULL=1`, the host's registry proxy was wedged). The prepare script formats the manifest it writes, keeps `image` last, refuses a lockfile outside `imageContext`, and refuses an unknown host architecture. The devkit Dockerfile links `node_modules/.vite-temp` to `/tmp` (Vite tolerates only `EACCES` under a read-only tree); `commands.test` also excludes `test/templates.test.ts` (compares against `examples/research`). The review found the Docker sandbox had no PID 1 reaper, which made devkit's process-tree tests fail only inside the container; `packages/sandbox` now launches with `--init` (commit `4c9aff13`, changeset). Measured from three green runs under `--init`: build 355 ms, test 7393 ms, peak 367 MiB → `commandTimeoutMs` 60000, `verifierDeadlineMs` 120000, `memoryMb` 768.

### Task 11: The task `devkit-spawn-deadline`

**Files:**
- Modify: `tasks/devkit-spawn-deadline/{spec.md,defect.patch,reference.patch,checks/spawn-deadline.test.ts}`
- Test: `test/tasks.test.ts` (new)

- [ ] **Step 1: Write the failing test: both patches apply to the pin and round-trip**

Create `test/tasks.test.ts`:

```ts
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { captureTarget } from "../src/targets/archive.ts"
import { loadTask, loadTaskIds } from "../src/targets/catalog.ts"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const apply = (patch: string, cwd: string, ...extra: string[]) =>
  spawnSync("git", ["apply", ...extra, patch], { cwd, encoding: "utf8" })

describe("every shipped task", () => {
  for (const id of loadTaskIds()) {
    it(`${id}: its patches apply to the pin, and defect then reference restores the pinned bytes`, async () => {
      const task = loadTask(id)
      const scratch = await mkdtemp(join(tmpdir(), "factory-tasks-"))
      dirs.push(scratch)
      const allowed = task.manifest.allowedSourcePaths[0] as string
      // The pristine pin: the capture without the defect.
      const pristine = captureTarget({ ...task, defectPatch: null }, "pristine", { appRoot: scratch })
      const before = await readFile(join(pristine.absolute, allowed), "utf8")
      // The baseline the builder sees: the capture with the defect, as the factory makes it.
      const baseline = captureTarget(task, "baseline", { appRoot: scratch })
      const reference = join(scratch, "reference.patch")
      await writeFile(reference, task.referencePatch)
      expect(apply(reference, baseline.absolute, "--check").status, "reference applies to the baseline").toBe(0)
      expect(apply(reference, baseline.absolute).status).toBe(0)
      const after = await readFile(join(baseline.absolute, allowed), "utf8")
      if (task.defectPatch !== null) expect(after).toBe(before)
      else expect(after).not.toBe(before)
    })

    it(`${id}: every acceptance id in checks.json appears in spec.md`, () => {
      const task = loadTask(id)
      for (const name of task.checks.independent.assertions) {
        const acceptance = name.match(/^(A\d+):/)?.[1]
        if (acceptance) expect(task.specText).toContain(`${acceptance}:`)
      }
    })
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/tasks.test.ts`
Expected: `cli-flags` passes; `devkit-spawn-deadline` fails because its patches are the Task 3 placeholders.

- [ ] **Step 3: Write the spec**

`tasks/devkit-spawn-deadline/spec.md`:

```markdown
# Clear the deadline when a spawn fails asynchronously

`spawnProcess` in `packages/devkit/src/testing/process.ts` arms a deadline timer
when `timeoutMs` is given. When the child cannot be spawned at all, the `error`
event rejects the close promise, but the timer it armed is left running for the
whole `timeoutMs`, keeping the event loop alive long after the rejection. Repair
it so the timer is cleared on every exit from the race, including the spawn
error.

Reproduce it with the package's own tests (`spawnProcess clears the deadline
when spawning fails asynchronously` fails), then repair only
`packages/devkit/src/testing/process.ts`. Do not change tests, configuration,
templates, or any other file.

A1: a spawn that fails asynchronously rejects with the spawn error and leaves no
deadline timer running.
A2: the existing behaviour of `spawnProcess` is unchanged: a process that exits
within its deadline resolves with its exit code and output, and a process that
exceeds its deadline is terminated with `timedOut` set.

Non-goal: no change to the exported types and no new options.
```

- [ ] **Step 4: Generate the two patches from the pin**

The defect narrows the `finally` that clears the timer so it runs only when the child closed. Generate on a scratch checkout of the pin so the hunk context is exact:

```bash
PIN=$(node -e 'console.log(require("./targets/devkit/target.json").pin)')
REPO=$(git rev-parse --show-toplevel)
SCRATCH=$(mktemp -d)
git -C "$REPO" archive "$PIN" -- packages/devkit/src/testing/process.ts | tar -x -C "$SCRATCH"
cp "$SCRATCH/packages/devkit/src/testing/process.ts" "$SCRATCH/pristine.ts"
# The defect: clear only when the child closed, so a spawn error leaks the timer.
perl -0pi -e 's/  \} finally \{\n    if \(timeoutHandle !== undefined\) clearTimeout\(timeoutHandle\)\n    if \(abortListener !== undefined\)/  } finally {\n    if (timeoutHandle !== undefined \&\& closed) clearTimeout(timeoutHandle)\n    if (abortListener !== undefined)/' "$SCRATCH/packages/devkit/src/testing/process.ts"
diff -u "$SCRATCH/pristine.ts" "$SCRATCH/packages/devkit/src/testing/process.ts" | sed '1s|.*|--- a/packages/devkit/src/testing/process.ts|;2s|.*|+++ b/packages/devkit/src/testing/process.ts|' > tasks/devkit-spawn-deadline/defect.patch
diff -u "$SCRATCH/packages/devkit/src/testing/process.ts" "$SCRATCH/pristine.ts" | sed '1s|.*|--- a/packages/devkit/src/testing/process.ts|;2s|.*|+++ b/packages/devkit/src/testing/process.ts|' > tasks/devkit-spawn-deadline/reference.patch
rm -rf "$SCRATCH"
grep -c "closed) clearTimeout" tasks/devkit-spawn-deadline/defect.patch   # expect 1
```

Open both patches and confirm each has exactly one hunk touching the `finally` in the timeout race (the first of the two `clearTimeout` sites in the file, inside `spawnProcess`, not the one in the termination helper). If `perl` matched nothing, the pinned file differs from this plan's snapshot; read the file and adjust the pattern, keeping the same defect.

- [ ] **Step 5: Write the independent check**

`tasks/devkit-spawn-deadline/checks/spawn-deadline.test.ts` (plain `node`, so no TS-only syntax):

```ts
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import test from "node:test"

// Runs the BUILT artifact from the workspace root, the way a consumer would, in a child whose
// event loop is left to drain: a timer the repair forgot keeps that child alive. Inputs are
// disjoint from the visible regression test (a different path, a different deadline), so a
// repair that special-cases the visible fixture does not pass here.
const dist = join(process.cwd(), "packages/devkit/dist/testing/index.js")

test("A1: a spawn that fails asynchronously leaves no deadline timer running", () => {
  const program = `
    import(${JSON.stringify(dist)}).then(async ({ spawnProcess }) => {
      const missing = "/nonexistent/b4-factory-check-" + process.pid
      let rejected = false
      try { await spawnProcess({ command: missing, timeoutMs: 170000 }) } catch { rejected = true }
      if (!rejected) { console.error("did not reject"); process.exitCode = 2 }
    })
  `
  const started = Date.now()
  const result = spawnSync(process.execPath, ["-e", program], { encoding: "utf8", timeout: 8_000 })
  const elapsed = Date.now() - started
  assert.equal(result.status, 0, `child exit ${String(result.status)} signal ${String(result.signal)}: ${result.stderr}`)
  assert.ok(elapsed < 2_000, `the child's event loop stayed alive for ${elapsed}ms after the rejection`)
})
```

- [ ] **Step 6: Run the task tests**

Run: `npx vitest run test/tasks.test.ts test/targets-catalog.test.ts`
Expected: PASS. The defect-then-reference round trip proves the two patches are inverses on the pinned bytes.

- [ ] **Step 7: Commit**

```bash
git add tasks/devkit-spawn-deadline test/tasks.test.ts
git commit -m "feat(software-factory): the devkit-spawn-deadline task

Re-seeds the dangling-deadline defect on the pinned commit: the finally
that clears spawnProcess's timer runs only when the child closed, so a
spawn error leaks the timer. The reference patch is the inverse. One
independent check runs the built artifact in a child and asserts its
event loop drains, with inputs disjoint from the visible regression test.
A layer 1 test proves both patches apply to the pin and round-trip.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

> **Task 11 as landed.** `defect.patch` is one hunk on the pinned `process.ts`: the race's `finally` clears the timer only when the child closed; `reference.patch` is the inverse; both generated from the object store. The check runs the built `packages/devkit/dist/testing/index.js` from the workspace root under plain `node`. Admission gate run by hand outside the container: with the defect the check FAILS at about 8 s (the child is killed by the check's own timeout), with the reference it PASSES in about 40 ms, and the visible suite with the defect fails exactly the one named regression test. `test/tasks.test.ts` proves both patches apply to the pin and round-trip for every shipped task.

### Task 12: Layer 2: the real image builds and tests devkit, and admits the task

**Files:**
- Create: `test/target-devkit.integration.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadTask } from "../src/targets/catalog.ts"
import { createArtifactStore } from "../src/storage/artifacts.ts"
import { createDockerVerifier } from "../src/verification/docker-verifier.ts"
import { loadPolicy } from "../src/verification/policy.ts"
import { applyReference } from "./reference-repair.ts"

/**
 * Layer 2 for the monorepo target: the prepared image really builds and tests the pinned
 * package, the visible regression test really fails on the defect-patched baseline, and the
 * task is admitted: its independent check fails on the defect and passes on the reference.
 */
const task = loadTask("devkit-spawn-deadline")
const policy = loadPolicy("devkit-spawn-deadline")
const allowed = task.manifest.allowedSourcePaths[0] as string

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
const verifier = async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-devkit-"))
  dirs.push(dir)
  return createDockerVerifier(createArtifactStore(join(dir, "artifacts")))
}
const verify = async (changes: Record<string, string>, id: string) =>
  (await verifier()).verify(
    { workOrderId: id, taskId: "devkit-spawn-deadline", candidateDigest: "a".repeat(64), changes, policyDigest: policy.policyDigest },
    AbortSignal.timeout(task.target.resources.verifierDeadlineMs),
  )

describe("the devkit target in its prepared image", () => {
  it("builds, tests and admits the task: the reference repair passes both suites", async () => {
    const receipt = await verify({ [allowed]: await applyReference("devkit-spawn-deadline") }, "wo-ref")
    expect(receipt.checks.map((c) => `${c.id}:${c.verdict}`)).toEqual(["visible:pass", "independent:pass"])
    expect(receipt.verdict).toBe("pass")
    expect(receipt.environmentIdentity).toBe(policy.environment.identity)
  }, task.target.resources.verifierDeadlineMs + 60_000)

  it("fails the defect-patched baseline on the visible regression test and the independent check", async () => {
    // No changes: the candidate IS the baseline with the defect. Both oracles must see it.
    const receipt = await verify({}, "wo-defect")
    expect(receipt.checks.map((c) => `${c.id}:${c.verdict}`)).toEqual(["visible:fail", "independent:fail"])
  }, task.target.resources.verifierDeadlineMs + 60_000)

  it("grades a candidate that does not compile as a failed build, not inconclusive", async () => {
    const receipt = await verify({ [allowed]: "export const broken: number = 'no'\n" }, "wo-build")
    expect(receipt.verdict).toBe("fail")
    expect(receipt.checks.map((c) => c.id)).toEqual(["build"])
  }, task.target.resources.verifierDeadlineMs + 60_000)
})
```

The `assembleCandidate` rule "changed nothing" never reaches the verifier in production; here `verify` is called directly, so an empty `changes` is a legitimate way to verify the baseline itself.

- [ ] **Step 2: Run it**

Run: `npx vitest run --config vitest.sandbox.config.ts test/target-devkit.integration.test.ts`
Expected: PASS, three tests. If the first fails in the build step, read the evidence artifact under the temp `artifacts/` directory: it is the compiler output from inside the container, and the usual cause is a module the hoisted install did not place where `tsc` looks. If the independent check is `inconclusive`, the runner could not parse its own program's output; run the check by hand with `docker run` as in Task 10 Step 4 to see the error.

- [ ] **Step 3: Commit**

```bash
git add test/target-devkit.integration.test.ts
git commit -m "test(software-factory): the devkit target builds, tests and admits its task in the real image

Layer 2 for rung 2: the reference repair passes both suites in the
prepared image, the defect-patched baseline fails both, and a candidate
that does not compile is a failed build, not inconclusive.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

> **Task 12 as landed.** The first devkit workspace ever built failed the framework's portable-path rule on `templates/` route paths (`(public)`, `[tenant]`, `[...path]`), so devkit's `capture.include` names its own `package.json`, the three config files, `src` and `test`, and `commands.test` excludes the nine tests that read templates or `examples/research`. The visible suite is twelve tests in two files; the graded regression test survives. Three lane tests pass in about 110 s: reference repair (both suites pass), defect baseline (both fail, evidence names the regression test and A1), non-compiling candidate (`build:fail` only). The node-test runner captures only stdout/stderr events, so the check prints its own diagnosis; carrying `test:fail` details into the output is a follow-up.

### Task 13: Layer 3: the scripted builder repairs devkit end to end

**Files:**
- Create: `test/devkit-end-to-end.integration.test.ts`

- [ ] **Step 1: Write the test**

Model it on `test/end-to-end.integration.test.ts` after Task 9, with these differences:

```ts
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentHarness, script } from "@b4run/testing"
import { afterEach, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/controller/factory.ts"
import { TASK_PROMPTS } from "../src/prompts.ts"
import { createArtifactStore } from "../src/storage/artifacts.ts"
import { loadTask } from "../src/targets/catalog.ts"
import { builderSandboxProvider, targetInspectionOptions } from "../src/targets/workspace.ts"
import { captureTargetBaseline } from "../src/verification/baseline.ts"
import { createDockerVerifier } from "../src/verification/docker-verifier.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { createThreadWorkspaceReader } from "../src/worker/workspace-reader.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { isolatedApp } from "./isolated-app.ts"
import { applyReference } from "./reference-repair.ts"

/** Rung 2's ladder proof: a scripted repair of a known past defect in packages/devkit verifies. */
const TASK = "devkit-spawn-deadline"
const task = loadTask(TASK)
const source = task.manifest.allowedSourcePaths[0] as string

let factory: Factory | undefined
let worker: FakeWorker | undefined
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await factory?.close()
  factory = undefined
  await worker?.close()
  worker = undefined
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it("repairs devkit from a real builder workspace through verification, approval and export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-devkit-e2e-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const exportDir = join(dir, "out")
  await mkdir(exportDir, { recursive: true })
  const repaired = await applyReference(TASK)

  process.env.FACTORY_TASK_ID = TASK
  const appRoot = await isolatedApp()
  cleanups.push(() => rm(appRoot, { recursive: true, force: true }))
  const harness = await createAgentHarness({ appRoot, route: "/build#agent" })
  cleanups.push(() => harness.close({ destroyWorkspaces: true }))
  const input = TASK_PROMPTS[TASK] as string
  const run = await harness.run({
    input,
    fixtures: script()
      .user(input)
      .callsTool("readFile", { path: "TASK.md" })
      .callsTool("readFile", { path: source })
      .callsTool("writeFile", { path: source, content: repaired })
      .replies("Repair complete.")
      .build(),
  })
  expect(run.toolResults.map((result) => result.isError)).toEqual([false, false, false])
  const threadId = run.threadId

  const readerSource = { providerFor: () => builderSandboxProvider(task.target), appRoot }
  worker = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only", threadId })
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    worker: createHttpWorkerClient(worker.baseUrl),
    workerRoute: "/build#agent",
    exportDir,
    artifactsDir: join(dir, "artifacts"),
    verifier: createDockerVerifier(createArtifactStore(join(dir, "artifacts"))),
    workspaceReader: createThreadWorkspaceReader(readerSource, () => targetInspectionOptions(task)),
    captureBaseline: captureTargetBaseline,
    maxActiveMs: 2 * task.target.resources.verifierDeadlineMs,
  })
  const { id } = await factory.create({ taskId: TASK })
  await factory.dispatch(id)
  const reviewed = await factory.waitFor(
    id,
    (row) => row.state === "awaiting_approval" || row.state === "blocked" || row.state === "failed",
    task.target.resources.verifierDeadlineMs + 120_000,
  )
  expect({ state: reviewed.state, blocked: reviewed.blockedReason }).toEqual({ state: "awaiting_approval", blocked: null })

  const evidence = factory.evidence(id)
  expect(evidence.candidate?.changedPaths).toEqual([source])
  expect(evidence.candidate?.baselineDigest).toBe((await captureTargetBaseline(TASK, AbortSignal.timeout(60_000))).digest)
  expect(evidence.receipt?.verdict).toBe("pass")
  expect(evidence.receipt?.checks.map((check) => check.id)).toEqual(["visible", "independent"])

  const approved = await factory.approve(id, { revision: reviewed.revision, bundleDigest: reviewed.bundleDigest as string })
  expect({ ok: approved.ok, state: approved.state }).toEqual({ ok: true, state: "exported" })
  expect(await readdir(exportDir)).toEqual([`${reviewed.bundleDigest}.json`])
  const exported = JSON.parse(await readFile(join(exportDir, `${reviewed.bundleDigest}.json`), "utf8")) as { changes: Record<string, string> }
  // The exported bytes are the reference repair applied to the baseline: nothing more.
  expect(exported.changes).toEqual({ [source]: repaired })
}, 3 * 600_000)
```

`isolatedApp` copies `b4.config.ts`, which reads `FACTORY_TASK_ID` at load; the env var is set before the copy is loaded by the harness. Reset it in `afterEach` with `delete process.env.FACTORY_TASK_ID`.

- [ ] **Step 2: Run it**

Run: `npx vitest run --config vitest.sandbox.config.ts test/devkit-end-to-end.integration.test.ts`
Expected: PASS. Approval re-verifies, so this test runs the verifier twice; budget for that in wall clock.

- [ ] **Step 3: Run every lane**

Run: `npx vitest run && npx vitest run --config vitest.sandbox.config.ts && npx tsc -p . --noEmit && npx biome check .`
Expected: all green. Run the Docker lane twice more; the two devkit tests must be stable.

- [ ] **Step 4: Commit**

```bash
git add test/devkit-end-to-end.integration.test.ts
git commit -m "test(software-factory): scripted repair of a devkit defect verifies end to end

Rung 2's ladder proof: the builder writes the reference repair into its
own managed workspace, the controller reads it through the byte channel,
assembles it against its own archive of the pin, verifies it in the
prepared image, freezes a bundle, approves and exports exactly those bytes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

> **Task 13 as landed.** The rung 2 ladder proof passes on the first attempt: the scripted builder writes the reference repair into its own managed workspace of the devkit archive, the controller reads it, assembles it against its own capture, verifies it in the prepared image, freezes, approves (re-verifies) and exports exactly those bytes. Lane wall clock about 115 s, dominated by the two verifications; the full Docker lane (five files) about 283 s. `applyReference` refuses a task with more than one allowed path. **Gap found in review, fixed before Task 14:** a builder that runs the target's build writes `packages/devkit/dist/**` into its workspace, and the controller's reader returned those paths, which the assembly rule rejects as "added". The reader now drops paths under the target's `snapshotIgnore` prefixes (the verifier's tamper comparison already did), and the devkit end-to-end lane's scripted builder now runs the real build and test inside its container, which is the first proof of the derived permissions and the dependency link against a real container.

### Task 14: Docs, gates and the handoff

**Files:**
- Modify: `docs/superpowers/runbooks/software-factory-rung2-developer-guide.md`, `docs/superpowers/specs/2026-09-19-software-factory-rung2-design.md` (status line only), `examples/software-factory/README.md`
- Verify: `<repo>/turbo.json` inputs, `<repo>/scripts/check-build-cache-config.mjs`, `examples/code-fixer` diff

- [ ] **Step 1: Reconcile the developer guide with what was built**

Remove the DRAFT status line. Fix every command and field name against the code: `image` object fields, `prepare-target.ts` usage, the vitest invocation, the `--exclude`, the `FACTORY_TASK_ID` bring-up. Add the measured resource numbers from Task 10 to "Add a target" as the worked example. Keep the "What is missing", "What is difficult" and "Where the pain points are" sections; update any point that Tasks 10 to 13 resolved or contradicted, with what actually happened.

- [ ] **Step 2: Spec status**

Change the spec's status line to `Status: implemented; see the plan and the developer guide`.

- [ ] **Step 2b: CI builds the target images before the factory's Docker lane**

`.github/workflows/ci.yml`'s `sandbox-docker` job runs `pnpm --filter @b4-example/software-factory-server test:sandbox` after a step that builds `b4-code-fixer:fixture-v1`. The factory's lanes now need `b4-factory-cli-flags:<pin12>-<sha12>` and `b4-factory-devkit:<pin12>-<sha12>`. Add, immediately before the factory's `test:sandbox` step:

```yaml
      - name: Prepare the software factory's target images
        run: |
          pnpm --filter @b4-example/software-factory-server target:prepare cli-flags
          pnpm --filter @b4-example/software-factory-server target:prepare devkit
```

The prepare script pulls the base image (CI has network), builds for the runner's platform (`linux/amd64`), asserts the modules resolve, and rewrites `target.json` with the runner's local image id; that manifest diff is expected in CI and must not fail any step (check nothing runs `git diff --exit-code` after it). Keep the code-fixer image step: code-fixer's own lane still uses it. Fix the README's "Tests" sentence that names `b4-code-fixer:fixture-v1` as what CI builds for the factory. **Workflow-edit trap (memory):** the workflow-contracts audit pins descriptors of every workflow; run `node --test scripts/release/test/workflow-contracts.test.mjs` (or whatever `pnpm lint` at the root invokes; find it with `grep -rn "workflow-contracts" package.json scripts`) and, if it fails, splice the two audited allowlist fixtures surgically for the new step rather than re-serialising them.

- [ ] **Step 3: Gates that live outside the package**

Run from `<repo>`:

```bash
node scripts/check-build-cache-config.mjs
git status --short examples/code-fixer
pnpm --filter @b4-example/software-factory-server lint typecheck test
```

Expected: the cache gate passes (the new tests read the object store through `git`, not files outside the package, so no new turbo input is needed; if the gate names one, add it as `$TURBO_ROOT$/<path>` to the package's `test` task inputs in `turbo.json`); code-fixer has no diff; the three package gates are green.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers examples/software-factory/README.md turbo.json
git commit -m "docs(software-factory): rung 2 guide reconciled with the implementation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Open the PR**

Title: `feat(software-factory): rung 2, the builder retargeted at packages/devkit`. Body: the spec's "Decision" paragraph, the three ladder proofs and which test carries each (Task 12 for build-and-test, Task 13 for the scripted repair), the measured resources, and the list of what the proof does not claim from the spec. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

> **Task 14 as landed (CI-driven).** Seven CI jobs failed on the same root cause: most
> jobs in `.github/workflows/ci.yml` check out at the default shallow depth (only
> `changesets`, `harness-verify`, `pack-smoke`, `push`, `release-controller` and
> `source-validate` set `fetch-depth: 0`), so the targets' pin is absent from their object
> stores. `target:prepare` failed in `git archive`, and every "Build packages" step failed
> too, because turbo builds the example, whose `b4.config.ts` calls `loadTask` →
> `loadTarget` → `commitExists`. Fix: `ensurePin(repo, id, pin)` in
> `src/targets/catalog.ts` fetches a missing pin from `origin` by SHA
> (`git fetch --depth=1 origin <pin>`, which GitHub allows for a reachable commit) once,
> on first load, and is used by both `loadTarget` and `scripts/prepare-target.ts` (which
> parses the manifest itself because the image may be absent). `FACTORY_NO_FETCH=1` keeps
> a missing pin a hard error for offline or determinism runs. Deepening every job's
> checkout was the alternative and was rejected: the pin is the factory's business, not
> the repository's CI configuration.

---

## Self-review against the spec

- **Two catalogs** with the spec's fields: Tasks 2 and 3. `runnerConfig` enforcement: Task 3. `snapshotIgnore`: Tasks 2 and 8.
- **Archive from the pin, defect applied, app-relative, per role, synchronous**: Task 4.
- **Image: platform-pinned base, npm-installed pnpm, hoisted install, siblings in full, resolve assertion, image object written back**: Task 10.
- **One root link; inspection derived from the definition**: Task 5.
- **Suite runners**: Task 7. **Build step, identity from the image object, tamper filter, per-target deadline**: Task 8.
- **Policy binds environment, patch hash, allowlist**: Tasks 1 and 6.
- **The task, its patches, its one check, the admission gate**: Tasks 11 and 12.
- **Proof layers 1, 2, 3**: Tasks 2 to 8 and 11 (layer 1), 12 (layer 2), 13 (layer 3).
- **cli-flags re-expressed, `src/fixtures` deleted**: Tasks 3, 9, 10.
- **Resources measured with three times headroom**: Task 10 Step 4; success criterion 6.
- **Reader unchanged in behaviour**: the source gains `providerFor` (Task 9) because the provider is now per target; inspection logic is untouched.
- **`FACTORY_REPO_ROOT`**: Tasks 2 and 9.

Type consistency checked: `Task`, `Target`, `Image`, `Checks`, `NodeTestSuite`, `VitestSuite` (Tasks 2 and 3) are what Tasks 4 to 8 import; `captureTarget(task, role, options)` (Task 4) is what Tasks 5, 9 and 11 call; `targetWorkspace(task, role)`, `targetInspectionOptions(task)`, `targetSandboxPolicy(target)`, `builderSandboxProvider(target)` (Task 5) are what Tasks 8, 9 and 13 call; `gradeVitestReport(exitCode, json, expected)` and `runSuite(handle, target, suite, signal)` (Task 7) are what Task 8 calls; `changedOutside(before, after, ignore)` (Task 8) is what its test calls.
