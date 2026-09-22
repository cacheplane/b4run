# Software factory intake lifecycle (sub-project 3a): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An open GitHub issue becomes a work order by an operator's command; a drafter turn produces a task directory the controller validates, fits to a target, and proves as an oracle by running only the independent check against the unpatched baseline; a person approves or rejects the draft by digest; an approved draft dispatches through the rung 2 lifecycle unchanged. Proven end to end with the scripted fakes. The real drafter (its own app and image, the wide capture, the per-target worker map, per-pin images) is sub-project 3b.

**Architecture:** Intake is a prefix on the existing lifecycle, not a fork: two new states, four blocked reasons, three commands. The registry gains an origin, a pin, a target id, a task digest and an attempt counter (schema 4). Generated tasks live under `<stateDir>/tasks/<workOrderId>/` in the same shape as the shipped catalog, found by a catalog search path the runtime configures once, so every existing `loadTask` call site resolves them without signature churn; the boot-time prompt map becomes a lazy lookup. The drafter is reached the way the builder is: a worker thread created with the work order id in its metadata, a run on a configurable route, observed to its end, then read back through the byte channel; the controller reads only `draft/`. The verifier gains an `independentOnly` mode. Refusals stay values; reconcile learns the two states.

**Tech Stack:** TypeScript, vitest, zod, `node:sqlite`, the controller's own fakes (`fake-worker.ts`, `fake-workspace-reader.ts`, `fake-verifier.ts`, `serve-controller.ts`), `gh` on the operator's PATH for `create --issue`.

**Spec:** `docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md` §6, amended by Task 1 with the decisions of 2026-09-22 (the 3a/3b split, intake as a third process in 3b, per-pin images in 3b, Jev deferred). Deviations this plan makes from §6's text, each recorded as an "As landed" note in Task 8: the draft omits `id` and `visible` and the controller fills them; a generated task needs no `reference.patch`; acceptance ids are parsed from `spec.md` as `A<n>:` lines and must equal the independent check's assertion names; in 3a the pin is recorded but the target's prepared image is what verification runs in (3b honours the pin with per-pin images); in 3a the drafter route runs in the SAME worker process as the builder on a configurable route (3b moves it to its own app).

**Standing rules:** `nvm use 24` before any test run. Never bare `git stash`; never bare `biome check --write` at the repo root (scoped `--write` on changed files is fine). Run package scripts with `pnpm --filter @b4-example/software-factory-controller <script>` (the `controller` package below) and `pnpm --filter @b4-example/software-factory-server <script>` (`server`). Commit after every task; the controller's unit suite, typecheck and lint must be green at every commit. Docker lanes run only in Task 8. All paths are relative to the repository root; `C/` abbreviates `examples/software-factory/controller/`. Work in the worktree `.claude/worktrees/factory-intake` on branch `blove/software-factory-intake`. Subagents' Edit/Write tools refuse a sibling worktree; use shell edits and read files back.

---

## File map

| Path | Change |
|---|---|
| `docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md` | §6 decision notes (Task 1), as-landed notes (Task 8) |
| `C/src/lib/domain/states.ts` | `intake_running`, `awaiting_intake_approval`; four blocked reasons; six events (Task 2) |
| `C/src/lib/domain/work-order.ts` | Row fields `origin*`, `pin`, `targetId`, `taskDigest`, `intakeAttempts`, `maxIntakeAttempts`; commands `intake`, `approve_intake`, `reject_intake` (Task 2) |
| `C/src/lib/registry/db.ts`, `registry/work-orders.ts` | Migration 4; columns, patch fields (Task 2) |
| `C/src/lib/targets/catalog.ts`, `src/lib/prompts.ts`, `src/lib/controller/factory.ts`, `src/lib/runtime.ts` | Catalog search path (`configureCatalog`), optional `reference.patch`, lazy prompt lookup (Task 3) |
| `C/src/lib/intake/draft.ts`, `src/lib/intake/generated-task.ts` | Parse a draft, fill what the drafter does not write, materialise and digest a generated task (Task 4) |
| `C/src/lib/verification/verifier.ts`, `docker-verifier.ts`, `receipt.ts`, `C/test/fake-verifier.ts` | `independentOnly` mode (Task 5) |
| `C/src/lib/intake/oracle.ts` | The oracle proof (Task 5) |
| `C/src/lib/intake/issue.ts`, `src/lib/controller/factory.ts` | `createFromIssue`, the pin, `issue.md` (Task 6) |
| `C/src/lib/controller/intake.ts`, `factory.ts`, `context.ts`, `config.ts` | The intake run: drafter thread, observe, read `draft/`, validate, fit, materialise, prove, park or retry (Task 7) |
| `C/src/lib/controller/reconcile.ts` | Rules for the two states (Task 7) |
| `C/src/app/work-orders/{intake,approve-intake,reject-intake}/index.ts`, `src/lib/routes/input.ts`, `src/lib/client.ts`, `src/cli.ts` | Routes, client, CLI (Task 8) |
| `C/src/lib/review/bundle.ts`, `factory.ts` approve | `origin`, `pin`, `taskDigest` in the bundle (Task 8) |
| `C/test/*` | Tests per task; `test/intake-fixtures.ts` shared drafts (Tasks 4 to 8) |
| `examples/software-factory/README.md` | Intake documented (Task 8) |

---

### Task 1: Record the decisions in the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md` (§6, §7, §9)

- [ ] **Step 1: Amend §6 and §7**

At the top of §6 add:

```markdown
> **Decisions of 2026-09-22, before execution.** Sub-project 3 is two plans. **3a** builds the
> intake lifecycle in the controller and proves it with the scripted fakes: states, registry,
> `create --issue`, generated tasks, draft validation and fit, the oracle proof, the two gate
> routes, reconcile rules. **3b** builds the drafter for real: its own app and fixed image (a
> third process, because a builder process serves one target and intake runs before a target
> is chosen), the wide read-only capture staged under the drafter's root, the re-rooted
> `draft/` read, a per-target worker map in the controller's config, the builder's per-thread
> resolver keyed by the work order, and per-pin images with `target:prepare --pin` and an
> `image_unprepared` block. TypeSafe AI's Jev was researched as an intake aid and deferred to
> a later phase: it cannot run in the network-denied drafter, and as a controller-side gate a
> planted fact in its state moves its verdict; see the research report of 2026-09-22.
```

In §7's table, replace row 3 with two rows: `3a` (Intake lifecycle with a scripted drafter; depends on 1, 2; proof §6.8's scripted lanes) and `3b` (The drafter for real; depends on 3a; proof: a two-thread run of the builder app plus one intake turn against the wide capture, Docker lane). Renumber nothing else.

In §9 add: "**3a runs verification in the target's prepared image, not at the work order's pin.** The pin is recorded on the row and in the bundle; 3b honours it with per-pin images. Until then a work order created against a newer `origin/main` is verified in the environment the target was last prepared at, and the bundle says both."

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md
git commit -m "docs(software-factory): rung 3 spec, the sub-project 3 decisions of 2026-09-22

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: States, commands, and registry schema 4

**Files:**
- Modify: `C/src/lib/domain/states.ts`, `C/src/lib/domain/work-order.ts`, `C/src/lib/registry/db.ts`, `C/src/lib/registry/work-orders.ts`, `C/src/lib/controller/factory.ts` (the `create` row literal only)
- Test: `C/test/states.test.ts` (append), `C/test/registry.test.ts` or the existing store test (find it: `grep -l createWorkOrderStore C/test/*.test.ts`), `C/test/registry-reader.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to the states test (read it first for its style; it enumerates legal moves):

```ts
it("intake is a prefix on the lifecycle", () => {
  expect(nextState("received", "intake_started")).toBe("intake_running")
  expect(nextState("intake_running", "intake_drafted")).toBe("awaiting_intake_approval")
  expect(nextState("intake_running", "intake_retry")).toBe("intake_running")
  expect(nextState("intake_running", "intake_blocked")).toBe("blocked")
  expect(nextState("awaiting_intake_approval", "approve_intake")).toBe("received")
  expect(nextState("awaiting_intake_approval", "reject_intake")).toBe("intake_running")
  expect(nextState("awaiting_intake_approval", "intake_blocked")).toBe("blocked")
  expect(nextState("intake_running", "cancel")).toBe("cancel_requested")
  expect(nextState("awaiting_intake_approval", "cancel")).toBe("cancel_requested")
  expect(ACTIVE_STATES.has("intake_running")).toBe(true)
  expect(ACTIVE_STATES.has("awaiting_intake_approval")).toBe(false)
  expect(() => nextState("received", "intake_drafted")).toThrow()
  expect(() => nextState("dispatched", "approve_intake")).toThrow()
})
```

Append to the work-order store test:

```ts
it("persists the intake fields and reads a schema-3 row as null origin", async () => {
  const row = { ...baseRow("wo-a"), origin: { kind: "issue", repository: "cacheplane/b4run", number: 778, bodyDigest: "0".repeat(64) }, pin: "a".repeat(40), targetId: "devkit", taskDigest: "b".repeat(64), intakeAttempts: 1, maxIntakeAttempts: 2 }
  store.insert(row)
  expect(store.get("wo-a")).toEqual(row)
  const updated = store.update("wo-a", 0, { intakeAttempts: 2, taskDigest: "c".repeat(64), targetId: "devkit" }, iso)
  expect(updated.intakeAttempts).toBe(2)
  // A catalog work order has no origin: the columns are null and the row reads { kind: "catalog" }.
  const catalog = { ...baseRow("wo-b") }
  store.insert(catalog)
  expect(store.get("wo-b")?.origin).toEqual({ kind: "catalog" })
  expect(store.get("wo-b")?.pin).toBeNull()
})
```

Adapt `baseRow` to whatever helper the file uses to build a `WorkOrderRow` (it must now include `origin: { kind: "catalog" }`, `pin: null`, `targetId: null`, `taskDigest: null`, `intakeAttempts: 0`, `maxIntakeAttempts: 2`). Append to `registry-reader.test.ts` a case that opens a registry written at schema 3 (copy `test/fixtures/registry-v3.sqlite` if the tests have such a fixture; otherwise create one in the test by opening a registry with `SCHEMA_VERSION` temporarily unreachable — simplest: write a v3 database by running the first three migrations by hand from `MIGRATIONS` in the test) and asserts the writer migrates it to 4 and reads its rows with `origin.kind === "catalog"`.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm --filter @b4-example/software-factory-controller exec vitest run test/states.test.ts test/registry-reader.test.ts
```

(and the store test). Expected: unknown events, unknown columns, zod rejects the new fields.

- [ ] **Step 3: States and events**

In `C/src/lib/domain/states.ts`:

```ts
export const STATES = [
  "received",
  "intake_running",
  "awaiting_intake_approval",
  "dispatched",
  ...unchanged
] as const
```

`ACTIVE_STATES` gains `"intake_running"`. `BLOCKED_REASONS` gains, with comments in the file's voice: `"intake_invalid"` (the draft failed the task schema or does not fit the target), `"oracle_did_not_fail"` (the drafted check passed or was inconclusive on the unpatched baseline), `"intake_attempts_exhausted"`, `"no_target_for_package"`, `"intake_run_failed"` (the drafter turn ended without a draft or the stream was lost past its retries). `TRANSITION_EVENTS` gains `"intake_started"`, `"intake_drafted"`, `"intake_retry"`, `"intake_blocked"`, `"approve_intake"`, `"reject_intake"`. `TABLE` gains:

```ts
  intake_started: { received: "intake_running" },
  intake_drafted: { intake_running: "awaiting_intake_approval" },
  intake_retry: { intake_running: "intake_running" },
  intake_blocked: { intake_running: "blocked", awaiting_intake_approval: "blocked" },
  approve_intake: { awaiting_intake_approval: "received" },
  reject_intake: { awaiting_intake_approval: "intake_running" },
```

`budget_exhausted` gains `intake_running: "cancel_requested"`. `cancel` already covers every non-terminal state.

- [ ] **Step 4: Row and commands**

In `C/src/lib/domain/work-order.ts` add before `WorkOrderRowSchema`:

```ts
export const OriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog") }).strict(),
  z
    .object({
      kind: z.literal("issue"),
      repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      number: z.number().int().positive(),
      bodyDigest: z.string().regex(DIGEST_PATTERN),
    })
    .strict(),
])
export type Origin = z.infer<typeof OriginSchema>
```

and to the row: `origin: OriginSchema`, `pin: z.string().regex(/^[a-f0-9]{40}$/).nullable()`, `targetId: z.string().min(1).nullable()`, `taskDigest: z.string().regex(DIGEST_PATTERN).nullable()`, `intakeAttempts: z.number().int().nonnegative()`, `maxIntakeAttempts: z.number().int().positive()`. `COMMANDS` gains `"intake"`, `"approve_intake"`, `"reject_intake"`.

- [ ] **Step 5: Migration 4 and the store**

In `C/src/lib/registry/db.ts`: `SCHEMA_VERSION = 4` and a migration (SQLite cannot add a NOT NULL column without a default, so counters default and the rest are nullable):

```ts
  {
    version: 4,
    up: `
      ALTER TABLE work_orders ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'catalog';
      ALTER TABLE work_orders ADD COLUMN origin_repository TEXT;
      ALTER TABLE work_orders ADD COLUMN origin_number INTEGER;
      ALTER TABLE work_orders ADD COLUMN origin_body_digest TEXT;
      ALTER TABLE work_orders ADD COLUMN pin TEXT;
      ALTER TABLE work_orders ADD COLUMN target_id TEXT;
      ALTER TABLE work_orders ADD COLUMN task_digest TEXT;
      ALTER TABLE work_orders ADD COLUMN intake_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE work_orders ADD COLUMN max_intake_attempts INTEGER NOT NULL DEFAULT 2;
    `,
  },
```

In `C/src/lib/registry/work-orders.ts`: `toSql` rejects objects, so `origin` is split. Replace the `COLUMNS` map's single-key assumption with explicit handling: keep `COLUMNS` for the scalar fields (add `pin`, `targetId: "target_id"`, `taskDigest: "task_digest"`, `intakeAttempts: "intake_attempts"`, `maxIntakeAttempts: "max_intake_attempts"`), and add the four origin columns in `insertSql`/`fromSql` by hand:

```ts
const ORIGIN_COLUMNS = ["origin_kind", "origin_repository", "origin_number", "origin_body_digest"] as const
function originToSql(origin: Origin): [string, string | null, number | null, string | null] {
  return origin.kind === "catalog"
    ? ["catalog", null, null, null]
    : ["issue", origin.repository, origin.number, origin.bodyDigest]
}
function originFromSql(record: Record<string, unknown>): Origin {
  if (record.origin_kind !== "issue") return { kind: "catalog" }
  return OriginSchema.parse({
    kind: "issue",
    repository: record.origin_repository,
    number: record.origin_number,
    bodyDigest: record.origin_body_digest,
  })
}
```

`fromSql` sets `raw.origin = originFromSql(record)` and maps a missing scalar column to `null` as today (a v3 row read before migration cannot happen, since `openRegistry` migrates, but `fromSql`'s `?? null` keeps the reader honest). `WorkOrderPatch` gains `targetId`, `taskDigest`, `intakeAttempts`, `pin`. `update` must write the origin columns only if `origin` is in the patch (it never is; keep origin immutable after insert).

`C/src/lib/controller/factory.ts` `create`: the row literal gains `origin: { kind: "catalog" }, pin: null, targetId: null, taskDigest: null, intakeAttempts: 0, maxIntakeAttempts: options.maxIntakeAttempts ?? 2`; add `maxIntakeAttempts?: number` to `FactoryOptions`.

- [ ] **Step 6: Run**

```bash
pnpm --filter @b4-example/software-factory-controller test
pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint
```

Expected: every existing test still passes (rows gain defaulted fields; tests that build rows by hand need the six new fields; fix those fixtures, do not weaken assertions). Typecheck will name every literal `WorkOrderRow` in tests; add the fields there.

- [ ] **Step 7: Commit**

```bash
git add examples/software-factory/controller
git commit -m "feat(software-factory): intake states, commands and registry schema 4

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Generated tasks are found by a catalog search path

**Files:**
- Modify: `C/src/lib/targets/catalog.ts`, `C/src/lib/prompts.ts`, `C/src/lib/controller/factory.ts`, `C/src/lib/runtime.ts`, `C/src/lib/config.ts`, `C/src/cli.ts` (the `builder-manifest` command needs no change)
- Test: `C/test/catalog-search-path.test.ts`, `C/test/factory-dispatch.test.ts` (append)

Today `loadTask(id, options)` reads `options.tasksDir ?? tasksDir`, `taskPrompts()` builds a prompt map once at boot, and eight runtime call sites call `loadTask(id)` with defaults. A generated task must be found by all of them with no signature churn.

- [ ] **Step 1: Write the failing tests**

`C/test/catalog-search-path.test.ts`:

```ts
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { configureCatalog, loadTask, loadTaskIds, resetCatalogForTests, tasksDir } from "../src/lib/targets/catalog.ts"

let dir: string
afterEach(() => {
  resetCatalogForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe("catalog search path", () => {
  it("finds a generated task after the shipped ones, and the shipped one wins a name clash", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    // A generated task is a shipped task's directory copied under a new id, minus reference.patch.
    cpSync(join(tasksDir, "devkit-spawn-deadline"), join(dir, "wo-0123456789abcdef"), { recursive: true })
    rmSync(join(dir, "wo-0123456789abcdef", "reference.patch"))
    const manifest = JSON.parse(readFileSync(join(dir, "wo-0123456789abcdef", "task.json"), "utf8"))
    writeFileSync(join(dir, "wo-0123456789abcdef", "task.json"), JSON.stringify({ ...manifest, id: "wo-0123456789abcdef" }))
    configureCatalog({ generatedTasksDir: dir })
    expect(loadTaskIds()).toContain("wo-0123456789abcdef")
    const task = loadTask("wo-0123456789abcdef")
    expect(task.directory).toBe(join(dir, "wo-0123456789abcdef"))
    expect(task.referencePatch).toBeNull()
    expect(loadTask("devkit-spawn-deadline").directory).toBe(join(tasksDir, "devkit-spawn-deadline"))
  })

  it("refuses a generated task that is missing its check or spec, like a shipped one", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    mkdirSync(join(dir, "wo-aaaaaaaaaaaaaaaa"))
    writeFileSync(join(dir, "wo-aaaaaaaaaaaaaaaa", "task.json"), JSON.stringify({ id: "wo-aaaaaaaaaaaaaaaa", target: "devkit", allowedSourcePaths: ["packages/devkit/src/testing/process.ts"], immutablePaths: [] }))
    configureCatalog({ generatedTasksDir: dir })
    expect(() => loadTask("wo-aaaaaaaaaaaaaaaa")).toThrow(/checks\.json|ENOENT/)
  })
})
```

Append to `C/test/factory-dispatch.test.ts` a case that creates a work order for a GENERATED task id (configured as above before `boot()`), dispatches it with the fake worker, and reaches `awaiting_approval`: this proves the prompt lookup is lazy and the verifier/baseline/reader resolve the generated directory. (The fake verifier and fake baseline do not read the directory; the prompt does, through `taskPrompt(loadTask(id))`.)

- [ ] **Step 2: Run to verify they fail**

Expected: `configureCatalog`, `resetCatalogForTests` do not exist; `loadTask` throws "Unknown task" for the generated id; `referencePatch` is required.

- [ ] **Step 3: The search path**

In `C/src/lib/targets/catalog.ts`:

```ts
/**
 * Where tasks are looked up: the shipped catalog first, then the directory the controller
 * writes generated tasks into. Configured once by the runtime from the state directory;
 * every `loadTask(id)` call site then resolves a generated task with no signature change.
 * A shipped id shadows a generated one, so a generated task can never impersonate a task
 * an operator prepared by hand.
 */
let generatedTasksDir: string | undefined
export function configureCatalog(options: { readonly generatedTasksDir?: string }): void {
  generatedTasksDir = options.generatedTasksDir
}
export function resetCatalogForTests(): void {
  generatedTasksDir = undefined
}
function taskRoots(options: CatalogOptions): readonly string[] {
  if (options.tasksDir) return [options.tasksDir]
  return generatedTasksDir ? [tasksDir, generatedTasksDir] : [tasksDir]
}
/** Task ids present on disk across the search path, shipped first, deduplicated. */
export function loadTaskIds(dir?: string): string[] {
  const roots = dir ? [dir] : taskRoots({})
  const seen = new Set<string>()
  for (const root of roots) if (existsSync(root)) for (const id of readIds(root, "task")) seen.add(id)
  return [...seen].sort()
}
function taskDirectory(id: string, options: CatalogOptions): string {
  for (const root of taskRoots(options)) if (existsSync(join(root, id, "task.json"))) return join(root, id)
  throw new Error(`Unknown task: ${id}`)
}
```

`loadTask` uses `taskDirectory(id, options)` instead of `options.tasksDir ?? tasksDir` + the `loadTaskIds` membership check. `reference.patch` becomes optional: `referencePatch: string | null`, read with the same `ENOENT`-tolerant helper as `defect.patch`. Update `test/tasks.test.ts` and `test/reference-repair.ts` (they use `task.referencePatch` for shipped tasks; add `if (task.referencePatch === null) throw new Error("shipped task without reference.patch")` in the shipped-task law so the invariant stays for the catalog).

`readIds` exists in the file (`loadTargetIds` uses it); confirm its signature. Keep `tasksDir` exported (tests use it).

- [ ] **Step 4: Lazy prompts and the runtime**

In `C/src/lib/prompts.ts`, add `export function promptFor(id: string, options?: CatalogOptions): string { return taskPrompt(loadTask(id, options ?? {})) }`. In `factory.ts`, replace the boot-time `tasks` map with a lazy lookup that keeps the "unprepared sibling must not stop boot" property: `create` and `dispatch` call `promptFor(row.taskId)` inside a try, and refuse with `Unknown task ${id}` (create throws `UnknownTaskError`; dispatch returns the refusal outcome) when it throws. Keep `FactoryOptions.tasks` as a test override (`tasks?: Readonly<Record<string, string>>` consulted first). Remove the `taskPrompts` boot call and its `task_unavailable` log; log `task_unavailable` at the point of use instead.

In `C/src/lib/config.ts` add `generatedTasksDir: join(stateDir, "tasks")` to `FactoryConfig`. In `C/src/lib/runtime.ts`, before `createFactory`, call `configureCatalog({ generatedTasksDir: config.generatedTasksDir })`. The CLI's read commands do not load tasks; `builder-manifest --task` should also find a generated task, so `cli.ts` calls `configureCatalog` with `join(FACTORY_STATE_DIR, "tasks")` when the variable is set (read it directly; do not require the full config).

- [ ] **Step 5: Run**

```bash
pnpm --filter @b4-example/software-factory-controller test
pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint
```

- [ ] **Step 6: Commit**

```bash
git add examples/software-factory/controller
git commit -m "feat(software-factory): generated tasks are found by a catalog search path

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Parse a draft, fill what the drafter does not write, materialise a generated task

**Files:**
- Create: `C/src/lib/intake/draft.ts`, `C/src/lib/intake/generated-task.ts`, `C/test/intake-fixtures.ts`
- Test: `C/test/intake-draft.test.ts`

The drafter writes four files under `draft/`: `task.json` (`target`, `allowedSourcePaths`, `immutablePaths`; no `id`), `spec.md` (with `A<n>:` acceptance lines), `checks.json` (`independent` only), and `checks/<name>.test.ts`. The controller fills `id` (the work order id) and `visible` (the target's own suite as a regression guard), parses the acceptance ids, and requires them to equal the independent assertion names.

- [ ] **Step 1: Write the fixtures and the failing tests**

`C/test/intake-fixtures.ts` exports `GOOD_DRAFT: Record<string, string>`, a draft for the `devkit` target modelled on `C/tasks/devkit-spawn-deadline/` (copy its `task.json` minus `id`, its `spec.md`, a `checks.json` with only the `independent` entry, and its `checks/spawn-deadline.test.ts`; read those files and embed their text), keyed by `draft/`-relative paths: `draft/task.json`, `draft/spec.md`, `draft/checks.json`, `draft/checks/spawn-deadline.test.ts`. Also `BAD_DRAFTS`: `missingTask` (no `task.json`), `badTarget` (`target: "no-such-target"`), `editsTests` (an allowed path under `packages/devkit/test`), `acceptanceMismatch` (spec says `A1:`/`A2:`, check names only `A1:`), `visibleSupplied` (a `checks.json` that also names `visible`: rejected, the controller owns it).

`C/test/intake-draft.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseDraft } from "../src/lib/intake/draft.ts"
import { writeGeneratedTask } from "../src/lib/intake/generated-task.ts"
import { configureCatalog, loadTask, resetCatalogForTests } from "../src/lib/targets/catalog.ts"
import { BAD_DRAFTS, GOOD_DRAFT } from "./intake-fixtures.ts"

let dir: string
afterEach(() => { resetCatalogForTests(); if (dir) rmSync(dir, { recursive: true, force: true }) })

describe("parseDraft", () => {
  it("accepts the good draft and fills id, visible and acceptance ids", () => {
    const parsed = parseDraft(new Map(Object.entries(GOOD_DRAFT)), { workOrderId: "wo-0123456789abcdef" })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.manifest.id).toBe("wo-0123456789abcdef")
    expect(parsed.checks.visible).toEqual({ runner: "vitest", assertions: [] })
    expect(parsed.acceptanceIds).toEqual(["A1", "A2"])
    expect(parsed.checkFiles).toEqual(["checks/spawn-deadline.test.ts"])
  })
  for (const [name, files] of Object.entries(BAD_DRAFTS)) {
    it(`refuses ${name} with a reason naming the file`, () => {
      const parsed = parseDraft(new Map(Object.entries(files)), { workOrderId: "wo-0123456789abcdef" })
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.reason).toMatch(/task\.json|spec\.md|checks\.json|checks\//)
    })
  }
})

describe("writeGeneratedTask", () => {
  it("materialises a loadable task, deterministically digested, with the issue text", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    const parsed = parseDraft(new Map(Object.entries(GOOD_DRAFT)), { workOrderId: "wo-0123456789abcdef" })
    if (!parsed.ok) throw new Error(parsed.reason)
    const first = await writeGeneratedTask(dir, parsed, { issueText: "# Issue 778\n\nbody\n" })
    const second = await writeGeneratedTask(dir, parsed, { issueText: "# Issue 778\n\nbody\n" })
    expect(first.digest).toBe(second.digest)
    expect(readFileSync(join(first.directory, "issue.md"), "utf8")).toContain("Issue 778")
    configureCatalog({ generatedTasksDir: dir })
    const task = loadTask("wo-0123456789abcdef")
    expect(task.checks.independent.file).toBe("checks/spawn-deadline.test.ts")
    expect(task.referencePatch).toBeNull()
    // The digest covers exactly the files a builder or verifier can see.
    expect(first.files).toEqual(["checks.json", "checks/spawn-deadline.test.ts", "issue.md", "spec.md", "task.json"])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement `draft.ts`**

```ts
import { z } from "zod"
import { ChecksSchema, type Checks, loadTarget, type TaskManifest, TaskSchema, assertTaskFitsTarget } from "../targets/catalog.js"

/** The draft's own checks manifest: the independent suite only. The visible suite is the controller's. */
const DraftChecksSchema = z.object({ independent: ChecksSchema.shape.independent }).strict()
/** The draft's task manifest: everything but the id, which is the work order's. */
const DraftTaskSchema = TaskSchema.innerType().omit({ id: true }).strict()

export interface ParsedDraft {
  readonly manifest: TaskManifest
  readonly checks: Checks
  readonly specText: string
  readonly acceptanceIds: readonly string[]
  /** `checks/...` paths present in the draft, relative to the draft root. */
  readonly checkFiles: readonly string[]
  readonly files: ReadonlyMap<string, string>
}
export type ParseResult = { ok: true } & ParsedDraft | { ok: false; reason: string; blockedReason: "intake_invalid" | "no_target_for_package" }

/** `A<n>:` at the start of a line in spec.md, in order of first appearance. */
export function acceptanceIdsOf(specText: string): string[] { ... /^A\d+:/gm ... dedupe ... }

export function parseDraft(files: ReadonlyMap<string, string>, input: { readonly workOrderId: string }): ParseResult {
  const read = (name: string) => files.get(`draft/${name}`)
  const taskRaw = read("task.json"); if (taskRaw === undefined) return invalid("draft/task.json is missing")
  // parse JSON, DraftTaskSchema; a supplied `id` is a strict-schema failure naming task.json
  const manifest = TaskSchema.parse({ id: input.workOrderId, ...draftTask })   // re-runs the disjointness refine
  let target; try { target = loadTarget(manifest.target) } catch { return { ok: false, reason: `draft/task.json names target ${manifest.target}, which has no prepared target`, blockedReason: "no_target_for_package" } }
  const checksRaw = read("checks.json") ... DraftChecksSchema (a `visible` key is a strict failure naming checks.json)
  const checks: Checks = { visible: { runner: "vitest", assertions: [] }, independent: draftChecks.independent }
  // assertTaskFitsTarget(manifest.id, manifest, checks, target) wrapped into invalid(...)
  const specText = read("spec.md"); if (!specText?.trim()) return invalid("draft/spec.md is missing or empty")
  const acceptanceIds = acceptanceIdsOf(specText)
  const named = checks.independent.assertions.map((a) => a.match(/^(A\d+):/)?.[1]).filter(Boolean)
  if (acceptanceIds.length === 0 || named.sort().join() !== [...acceptanceIds].sort().join())
    return invalid(`draft/spec.md acceptance ids [${acceptanceIds}] do not match draft/checks.json independent assertions [${named}]`)
  if (!files.has(`draft/${checks.independent.file}`)) return invalid(`draft/checks.json names ${checks.independent.file}, which the draft does not contain`)
  const checkFiles = [...files.keys()].filter((p) => p.startsWith("draft/checks/")).map((p) => p.slice("draft/".length)).sort()
  return { ok: true, manifest, checks, specText, acceptanceIds, checkFiles, files }
}
```

`ChecksSchema.visible` is `SuiteSchema`, whose vitest arm requires `assertions.min(1)`. A generated task's visible suite is the regression guard with NO named assertions, so widen the vitest arm to `.min(0)` and make the checks runner grade an empty expectation as "the suite ran and nothing failed": in `checks-runner.ts` `gradeVitestReport`, when `expected.length === 0`, `pass` iff the report is valid, `numFailedTests === 0`, `numTotalTests > 0` and the exit code is 0; `fail` iff any failure; else `inconclusive`. Add a unit test for that arm in the existing checks-runner test. Shipped tasks are unaffected (they name assertions).

- [ ] **Step 4: Implement `generated-task.ts`**

```ts
export interface GeneratedTask { readonly directory: string; readonly digest: string; readonly files: readonly string[] }
/**
 * Materialise a parsed draft as a task directory the catalog can load, and digest it. The
 * digest is over the exact files a builder or verifier can see (sorted path + bytes), so
 * `approve-intake --digest` binds what the person read to what runs. Written to a temp
 * sibling and renamed into place, so a crash cannot leave a half-written task loadable.
 */
export async function writeGeneratedTask(generatedTasksDir: string, draft: ParsedDraft, input: { readonly issueText: string }): Promise<GeneratedTask>
```

Files written: `task.json` (the filled manifest, stable key order), `checks.json` (filled checks), `spec.md`, `issue.md` (the exact issue text), and every `checks/*` file from the draft. No `reference.patch`, no `defect.patch`. Digest: `sha256` over `path\0bytes\0` for each file in sorted order, exported as `digestGeneratedTask(directory)` so the gate can recompute it from disk.

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint
git add examples/software-factory/controller
git commit -m "feat(software-factory): parse an intake draft and materialise a generated task

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The oracle proof

**Files:**
- Modify: `C/src/lib/verification/verifier.ts`, `docker-verifier.ts`, `receipt.ts`, `C/test/fake-verifier.ts`
- Create: `C/src/lib/intake/oracle.ts`
- Test: `C/test/receipt.test.ts` (append), `C/test/fake-verifier.test.ts` (append), `C/test/intake-oracle.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `receipt.test.ts`: `assembleReceipt` with `mode: "independentOnly"` and a visible session of `null` returns a receipt with one check `independent` and the verdict equal to that check's; with `mode` omitted the existing "independent did not run" throw stands. Append to `fake-verifier.test.ts`: `verify({ ..., mode: "independentOnly" })` returns a receipt whose `checks` is exactly `[independent]`. `intake-oracle.test.ts`: `proveOracle` with a fake verifier scripted `{ independent: "fail" }` resolves `{ proven: true, receipt }`; with `{ independent: "pass" }` and with `{ independent: "inconclusive" }` resolves `{ proven: false, verdict }`; with `{ throws: "docker down" }` rejects.

- [ ] **Step 2: Implement**

`verifier.ts`: `VerifyInput` gains `readonly mode?: "full" | "independentOnly"`. `docker-verifier.ts`: when `input.mode === "independentOnly"`, skip the visible session (`visible = null`) and grade only `independent`; the `changes` are `{}`, so `gradeSuite` writes nothing and runs the build then the check against the captured baseline. `receipt.ts` `assembleReceipt` accepts `visible: SuiteSession | null` plus `mode`; in `independentOnly` mode: build failure in the independent session is `fail` (there is no earlier session to disagree with), tamper as today, and the single `independent` check carries the verdict. `fake-verifier.ts` honours `mode` by emitting only the independent check.

`C/src/lib/intake/oracle.ts`:

```ts
/**
 * A drafted check is an oracle only if it FAILS on the unpatched baseline: run the independent
 * suite alone, with no candidate changes, in the target's environment. `inconclusive` is not a
 * failure: a check that could not run proves nothing.
 */
export async function proveOracle(input: { readonly verifier: Verifier; readonly workOrderId: string; readonly taskId: string; readonly policyDigest: string; readonly baselineDigest: string; readonly signal: AbortSignal }): Promise<{ proven: true; receipt: Receipt } | { proven: false; verdict: Verdict; receipt: Receipt }> {
  const receipt = await input.verifier.verify({ workOrderId: input.workOrderId, taskId: input.taskId, candidateDigest: input.baselineDigest, changes: {}, policyDigest: input.policyDigest, mode: "independentOnly" }, input.signal)
  const verdict = receipt.checks.find((c) => c.id === "independent")?.verdict ?? "inconclusive"
  return verdict === "fail" ? { proven: true, receipt } : { proven: false, verdict, receipt }
}
```

`candidateDigest` is the baseline's digest: the receipt then names the bytes it graded, which is the unpatched pin.

- [ ] **Step 3: Run and commit**

```bash
git add examples/software-factory/controller
git commit -m "feat(software-factory): the verifier runs the independent suite alone; the oracle proof

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `create --issue`

**Files:**
- Create: `C/src/lib/intake/issue.ts`
- Modify: `C/src/lib/controller/factory.ts` (`Factory.createFromIssue`), `C/src/lib/routes/input.ts`, `C/src/app/work-orders/create/index.ts`, `C/src/lib/client.ts`, `C/src/cli.ts`
- Test: `C/test/intake-issue.test.ts`, `C/test/factory-create.test.ts` (append or the file where `create` is tested), `C/test/cli.test.ts` (append), `C/test/routes.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

`intake-issue.test.ts`: `fetchIssue({ repository, number, exec })` with an injected `exec` returning `gh issue view` JSON yields `{ title, body, bodyDigest, url }` and rejects a non-JSON or errored `exec`; `resolvePin({ repositoryRoot, exec })` runs `git fetch --depth=1 origin main` then `git rev-parse origin/main` and returns a 40-hex sha; `issueText(issue)` renders `# <title> (cacheplane/b4run#778)\n\n<body>\n` deterministically.

Factory test: `createFromIssue({ origin: { kind: "issue", repository, number, bodyDigest }, pin, issue: { title, body }, operationKey })` creates a row in `received` with `origin`, `pin`, `taskId === row.id`, `targetId: null`, journals `created` with `{ origin, pin }`, and writes `<generatedTasksDir>/<id>/issue.md`; the same operation key replays the recorded row.

Routes test: `create` with `{ origin, pin, issue }` returns the row; with both `taskId` and `origin` it is `invalid_input`.

CLI test: `factory create --issue 778` with `FACTORY_GH=<path to a stub script>` (see below) prints the created row and exits 0.

- [ ] **Step 2: Implement**

`issue.ts`: `fetchIssue` uses `execFile("gh", ["issue", "view", String(number), "--repo", repository, "--json", "title,body,url"], { timeout: 30_000, maxBuffer: 1 << 20 })` (promisified), `bodyDigest = sha256(title + "\n" + body)`. The binary is `process.env.FACTORY_GH ?? "gh"` so tests inject a stub script, and so an operator can point at a wrapper. `resolvePin` uses `git` with `repositoryRoot()` from the catalog. `issueText` as above. The CLI's `create --issue <n> [--repo owner/name]` (default repository from `git remote get-url origin` parsed, or `FACTORY_REPOSITORY`) fetches and resolves, then calls the route; `--task` and `--issue` are mutually exclusive.

`Factory.createFromIssue(input)`: like `create` but `taskId = id`, `origin`, `pin`, and after the transaction writes `issue.md` under `join(config.generatedTasksDir, id)` (the Factory needs `generatedTasksDir` in `FactoryOptions`; the runtime passes `config.generatedTasksDir`). `CreateInput` becomes `z.union([CatalogCreate, IssueCreate])` where `IssueCreate = { origin: OriginSchema.options[1], pin, issue: { title, body }, operationKey? }.strict()`. Client `create` accepts either shape.

- [ ] **Step 3: Run and commit**

```bash
git add examples/software-factory/controller
git commit -m "feat(software-factory): create --issue records the origin, the pin and the issue text

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The intake run, and reconcile

**Files:**
- Create: `C/src/lib/controller/intake.ts`
- Modify: `C/src/lib/controller/factory.ts` (`Factory.intake`, `approveIntake`, `rejectIntake`, `settleIntake`), `context.ts`, `config.ts` (`FACTORY_INTAKE_ROUTE`, default `/intake#agent`), `runtime.ts`, `reconcile.ts`, `run-observer.ts` (only if the observer needs a "no candidate expected" mode; read it first)
- Test: `C/test/factory-intake.test.ts`, `C/test/factory-reconcile.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

`factory-intake.test.ts`, with the file's usual `boot()` over the fake worker (`run: "edits_only"`), a fake reader scripted for the intake thread with `GOOD_DRAFT`, a fake verifier `{ independent: "fail" }`, and a fake baseline:

- `intake(id)` on an issue work order: journals `intake_started`, creates a worker thread with `{ factoryWorkOrderId: id, factoryStage: "intake" }` on the intake route, observes the turn, reads the workspace, and ends in `awaiting_intake_approval` with `targetId: "devkit"`, `taskDigest` set, `intakeAttempts: 1`, and the generated task loadable; the journal has `oracle_proven` with the receipt id.
- Reader scripted with `BAD_DRAFTS.badTarget`: `blocked` with `no_target_for_package` (no retry: a wrong target is not something a redraft fixes... decide: retry is for `intake_invalid` and `oracle_did_not_fail` only).
- Reader scripted with `BAD_DRAFTS.acceptanceMismatch` and `maxIntakeAttempts: 2`: first attempt journals `intake_rejected_by_check { reason }` and `intake_retry`, second attempt (reader re-scripted good) parks; with the reader left bad, the second attempt ends `blocked` with `intake_attempts_exhausted`.
- Fake verifier `{ independent: "pass" }`: `oracle_did_not_fail` after the attempts.
- `approveIntake(id, { revision, taskDigest })` with the digest recomputed from disk equal: `received`, and `dispatch` then reaches `awaiting_approval` (the whole rung 2 path on a generated task). With a mismatched digest: refusal "Task digest does not match the generated task on disk". With a file edited on disk after intake: the same refusal (the gate recomputes).
- `rejectIntake(id, { note })`: journals `intake_rejected { note }`, transitions to `intake_running`, and runs another drafter turn whose prompt contains the note (assert on the fake worker's received messages), attempts permitting; when exhausted, `blocked`.
- Cancel during intake: `cancel(id)` while the fake is `hang` cancels the intake thread and settles `cancelled`.
- Reconcile: a row left `intake_running` with a thread id (restart mid-turn) is adopted like `reconcileRun` (reattach if busy, else finish the read-and-prove step); a row left `intake_running` with no thread is `intake_blocked` with `intake_run_failed`; `awaiting_intake_approval` has no rule.

- [ ] **Step 2: Implement**

`C/src/lib/controller/intake.ts` mirrors `verify.ts` in shape:

```ts
export async function runIntake(ctx: ControllerContext, id: string): Promise<void>
```

1. `transition(id, "intake_started")` (from `received`, issue origin only; a catalog work order is refused by the command).
2. Create the drafter thread `worker.createThread({ factoryWorkOrderId: id, factoryStage: "intake" })`, journal `intake_thread_created`, store it as `workerThreadId`, start the run on `config.intakeRoute` with the intake prompt (`intakePrompt(issueText, note?)` in `prompts.ts`: the four-file instruction from spec §6.4, plus the previous attempt's rejection reason or the operator's note when retrying), observe with `observeRun` in a mode that expects NO candidate claim (read `run-observer.ts`; if it treats a turn without edits as failure, add an option; the drafter's edits are under `draft/` and the observer's turn rules must accept them).
3. Read the workspace through `ctx.workspaceReader.read({ threadId, taskId: <the target's id is unknown yet> })`: the reader is keyed by task id for its provider and inspection options; for intake pass the INTAKE inspection options (`intakeInspectionOptions()` in `targets/workspace.ts`: `excludeRootDirectories: ["repo", ".git"]`, no expected symlinks) and the intake provider (`FACTORY_INTAKE_TARGET`, default the target named by the drafter's own manifest is unknown, so 3a uses the builder's provider for the `devkit` target; 3b gives intake its own). Filter the map to `draft/*`.
4. `parseDraft`; on `ok: false` journal `intake_rejected_by_check { reason }` and either `intake_retry` (attempts left: `intakeAttempts < maxIntakeAttempts`, and the reason is `intake_invalid`) or `intake_blocked { blockedReason }`.
5. `writeGeneratedTask(config.generatedTasksDir, parsed, { issueText })`; `configureCatalog` already points at that directory, so `loadTask(id)` now resolves it; `loadPolicy(id)`; `captureBaseline(id)`; `proveOracle`; on `proven: false` journal `oracle_not_proven { verdict, receiptId }` and retry or block with `oracle_did_not_fail`; on a thrown verify (harness down) journal and block with `intake_run_failed`.
6. `transition(id, "intake_drafted", { targetId, taskDigest, intakeAttempts: +1 })`, journal `oracle_proven { receiptId, taskDigest }`, record the receipt in the evidence store.

A retry re-runs from step 2 on the SAME thread (a new run on the drafter thread, with the reason in the prompt) so the drafter keeps its `draft/`; the reader reads the new state. The generated task directory is rewritten atomically on each attempt.

`Factory.intake(id, key)` (command `intake`): refuses unless `received` with an issue origin; tracks `runIntake` like `dispatch` tracks `startRun`; `settleIntake(id, timeoutMs)` waits for it. `Factory.approveIntake(id, { revision, taskDigest, key })`: `awaiting_intake_approval` only; recompute `digestGeneratedTask(dir)`; compare with both the row's `taskDigest` and the caller's; `transition("approve_intake")`; journal `intake_approved`. `Factory.rejectIntake(id, { note, key })`: `transition("reject_intake")`, journal `intake_rejected { note }`, then `runIntake` again (tracked) if attempts remain, else `intake_blocked`.

`context.ts` gains `intakeRoute`, `generatedTasksDir`, `intakeInspection`. `reconcile.ts`: `case "intake_running"`: if `workerThreadId` and the worker reports the thread busy, reattach with a variant of `reconcileRun` that hands off to `runIntake`'s read-and-prove step on turn end (factor `runIntake` into `startDrafterTurn` and `finishIntake(ctx, id)`); if not busy, call `finishIntake`; if no thread id, `intake_blocked { intake_run_failed }`. `finishCancel` must cancel the intake thread the same way it cancels a builder thread (it already uses `row.workerThreadId`).

- [ ] **Step 3: Run and commit**

```bash
pnpm --filter @b4-example/software-factory-controller test && pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint
git add examples/software-factory/controller
git commit -m "feat(software-factory): the intake run, its gate commands, and reconcile rules

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Routes, client, CLI, the bundle, docs and the gate

**Files:**
- Create: `C/src/app/work-orders/intake/index.ts`, `approve-intake/index.ts`, `reject-intake/index.ts`
- Modify: `C/src/lib/routes/input.ts`, `C/src/lib/client.ts`, `C/src/cli.ts`, `C/src/lib/review/bundle.ts`, `C/src/lib/controller/factory.ts` (freeze and approve), `examples/software-factory/README.md`, the spec
- Test: `C/test/routes.test.ts` (append), `C/test/cli.test.ts` (append), `C/test/bundle.test.ts` (append), `C/test/factory-approve.test.ts` (append)

- [ ] **Step 1: Routes and client**

`intake` (runs on the work order id; awaits `settleIntake` like `dispatch` awaits `settle`; the settled row is `awaiting_intake_approval` or `blocked`), `approve-intake` (`ApproveIntakeInput = { id, revision, taskDigest, operationKey? }`), `reject-intake` (`{ id, note, operationKey? }`). Client methods `intake`, `approveIntake`, `rejectIntake`. CLI commands `intake <id>` (awaits, tails events, exits 0 only on `awaiting_intake_approval`), `approve-intake <id> --revision <n> --digest <sha256>`, `reject-intake <id> --note "<text>"`, and `create --issue <n> [--repo]`. `show` prints the generated task's directory and digest for a parked row (read from the row; the operator inspects the draft on disk before approving; `evidence` includes the oracle receipt).

`b4 check` must list nine routes.

- [ ] **Step 2: The bundle**

`BundlePayloadSchema` and `freezeBundle` gain `origin: OriginSchema`, `pin: string | null`, `taskDigest: string | null`; `factory.ts` approve compares `frozen.taskDigest` with `digestGeneratedTask(dir)` for a generated task (and `null` for a catalog task) and invalidates on mismatch. Append to `bundle.test.ts` (digest changes when `taskDigest` changes) and `factory-approve.test.ts` (a generated task edited on disk after freeze is invalidated).

- [ ] **Step 3: Docs**

README: an "Intake" section (create from an issue, intake, inspect the draft under `<state>/tasks/<id>/`, approve-intake by digest or reject-intake with a note, then dispatch as before), the new env (`FACTORY_INTAKE_ROUTE`, `FACTORY_GH`, `FACTORY_REPOSITORY`), the exit codes, and what 3a does not do (the drafter runs in the builder process on a scripted route until 3b; the pin is recorded, not honoured). Spec §6: as-landed notes for every deviation listed at the top of this plan, plus §9 follow-ups: intake threads accumulate on the worker (one per work order, never deleted), and the drafter's `repo/` copy is readable by its tools (3b confines writes to `draft/` and reads to the capture; in 3a the scripted fake has no filesystem).

- [ ] **Step 4: The gate**

```bash
pnpm --filter @b4-example/software-factory-controller test
pnpm --filter @b4-example/software-factory-controller typecheck && pnpm --filter @b4-example/software-factory-controller lint
pnpm --filter @b4-example/software-factory-server test && pnpm --filter @b4-example/software-factory-server typecheck && pnpm --filter @b4-example/software-factory-server lint
pnpm --filter @b4-example/software-factory-controller target:prepare cli-flags && pnpm --filter @b4-example/software-factory-controller target:prepare devkit && pnpm --filter @b4-example/software-factory-controller test:sandbox
git checkout -- examples/software-factory/controller/targets
node scripts/check-docs.mjs
pnpm check:build-cache
```

Plus one Docker-lane test added in this task: `C/test/intake-oracle.integration.test.ts`, which runs `proveOracle` with the REAL Docker verifier against the shipped `devkit-spawn-deadline` task materialised as a generated task (its check fails on the defect baseline: `proven: true`) and against the same task with its `defect.patch` dropped and the reference applied... simpler: against `cli-flags` (whose pinned bytes are already defective, so the check fails on baseline: `proven: true`) and, for the negative, a generated copy whose independent check is rewritten to a trivially passing test (`proven: false`, verdict `pass`). Both in one container each; expect under two minutes.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/controller examples/software-factory/README.md docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md
git commit -m "feat(software-factory): intake routes, CLI, the bundle's origin and task digest, docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review against §6

- §6.1 lifecycle: Task 2 (states, events, blocked reasons), Task 7 (transitions in `runIntake`, retry bound, cancel), catalog work orders skip intake (`create` lands in `received`; `intake` refuses a catalog origin).
- §6.2 row: Task 2 (`origin`, `pin`, `targetId`, `taskDigest`, `intakeAttempts`, `maxIntakeAttempts`).
- §6.3 `create --issue`: Task 6 (operator's `gh`, pin from `origin/main`, `issue.md`, `bodyDigest`, idempotent key).
- §6.4 the intake route: 3b. In 3a the drafter is the fake worker on a configurable route (Task 7); the prompt text is the spec's four-file instruction (`intakePrompt`).
- §6.5 what the controller does with the draft: Task 4 (parse, fit, materialise, digest), Task 5 (prove), Task 7 (the sequence, retries, blocks).
- §6.6 the gate: Task 7 (commands) and Task 8 (routes, CLI, bundle fields, approve comparison).
- §6.7 targets: the drafter chooses among prepared targets (`loadTarget` refuses unprepared, `no_target_for_package`); the pin is recorded, honoured in 3b.
- §6.8 proof: Tasks 4 to 7's unit lanes, Task 8's Docker oracle lane; the live issue is sub-project 4.
- Names used consistently: `intake_running`, `awaiting_intake_approval`, `intake_invalid`, `oracle_did_not_fail`, `intake_attempts_exhausted`, `no_target_for_package`, `intake_run_failed`; events `intake_started`, `intake_drafted`, `intake_retry`, `intake_blocked`, `approve_intake`, `reject_intake`; `configureCatalog`, `resetCatalogForTests`, `promptFor`, `parseDraft`, `acceptanceIdsOf`, `writeGeneratedTask`, `digestGeneratedTask`, `proveOracle`, `fetchIssue`, `resolvePin`, `issueText`, `createFromIssue`, `runIntake`, `finishIntake`, `settleIntake`, `approveIntake`, `rejectIntake`, `intakePrompt`, `intakeInspectionOptions`; env `FACTORY_INTAKE_ROUTE`, `FACTORY_GH`, `FACTORY_REPOSITORY`; `VerifyInput.mode`.

## Follow-ups this plan records, not in scope

- Everything in 3b (the drafter app and image, the wide capture, the re-rooted read, the per-target worker map, the per-thread builder resolver, per-pin images).
- Intake threads accumulate on the worker, one per work order; a sweep of settled intake threads.
- The first live issue (sub-project 4) needs a prepared target for the package it touches; neither #774 nor #778 has one, and #774 may be stale build output rather than a defect.
- Jev as an advisory target-routing aid, deferred; preconditions in the research report of 2026-09-22.
