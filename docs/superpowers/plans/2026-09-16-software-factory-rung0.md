# Software Factory Rung 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A durable work-order controller in `examples/software-factory/server` that drives the unchanged `examples/code-fixer/server` over the Agent Protocol, with a two-turn worker protocol, operation-scoped approval, cancel, restart reconciliation, and a two-layer proof.

**Architecture:** Plain Node/TypeScript service (not a b4 app). `node:sqlite` registry holds the closed state machine, an append-only event journal, a two-phase command log keyed by operation key, approvals and deliveries. A small HTTP worker client speaks seven Agent Protocol calls to the code-fixer runtime on loopback. Turn 1 asks the worker to produce and verify a candidate; the operator's `approve <digest>` starts turn 2 and the controller resolves the worker's `exportForReview` gate with the recorded approval. Layer 1 tests run against a scripted fake Agent Protocol server; layer 2 runs the real code-fixer under Docker with `aimock` replay fixtures.

**Tech Stack:** Node 24 (`node:sqlite`, `node:http`, `fetch`, `node:util` `parseArgs`), TypeScript 7.0.2 (`noEmit`, run with `tsx`), zod 4.4.3, vitest 4.1.11, biome 2.5.6, `@b4run/testing` (`createAimock`, `createSubprocessApp`, `script`) in tests only.

**Spec:** `docs/superpowers/specs/2026-09-16-software-factory-rung0-design.md`. Read it first. Section names below refer to it.

**Conventions that apply to every task**

- Work in this worktree only. Run `nvm use 24` before any test (Node 22 makes unrelated tests fail spuriously).
- Package root for all relative paths below: `examples/software-factory/server`. Root-of-repo paths are prefixed `<repo>/`.
- Source files import siblings with `.js` extensions (code-fixer convention; `tsx` resolves them). Test files import `../src/....ts`.
- Never run bare `biome check --write` at the repo root. Lint with `pnpm --filter @b4-example/software-factory-server lint`; fix formatting with `pnpm --filter @b4-example/software-factory-server exec biome check --write .` inside the package only.
- `examples/code-fixer` must have no diff at the end. Check with `git status --short examples/code-fixer` after every task that touches tests near it.
- Commit after every task with the message shown. Every commit message ends with the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `vitest.integration.config.ts` | Workspace member wiring, mirrors code-fixer |
| `src/domain/states.ts` | State union, terminal/active sets, blocked/failure reasons, transition table, `nextState` |
| `src/domain/work-order.ts` | zod schemas: `WorkOrderRow`, `FactoryEvent`, `CommandIntent`, `CommandOutcome`, `Approval` |
| `src/worker/wire.ts` | zod schemas for Agent Protocol frames and responses, `isExportGate`, `parsePrepareReviewOutput` |
| `src/worker/sse.ts` | `parseSse` over a `ReadableStream`, `parseBlock` |
| `src/worker/client.ts` | `WorkerClient` interface, `createHttpWorkerClient`, `WorkerHttpError` |
| `src/worker/outbox.ts` | `receiptPath`, `receiptExists`, `waitForReceipt` |
| `src/registry/db.ts` | `openRegistry` (WAL, migrations, version guard) |
| `src/registry/work-orders.ts` | `createWorkOrderStore`: CAS `update`, events, approvals, deliveries, `transaction` |
| `src/registry/commands.ts` | `createCommandLog`: `begin`/`complete`/`open` two-phase log |
| `src/prompts.ts` | `TURN_ONE_PROMPTS`, `turnTwoPrompt(digest)` |
| `src/config.ts` | `loadConfig(env)` for `FACTORY_*` |
| `src/controller/turns.ts` | `consumeTurn(frames, handlers)` stream consumer |
| `src/controller/budget.ts` | `startBudgetTicker` |
| `src/controller/reconcile.ts` | `reconcileWorkOrder(ctx, id)` rules |
| `src/controller/factory.ts` | `createFactory`: commands, turn 1/2 logic, wiring of budget and reconcile |
| `src/http.ts` | `createHttpApi(factory)` on 127.0.0.1 |
| `src/cli.ts` | `factory` command-line entry |
| `test/fake-worker.ts` | Scripted Agent Protocol fake over `node:http` |
| `test/scenarios.ts` | Shared invariant scenarios parameterised by a `ScenarioContext` |
| `test/*.test.ts` | Layer 1 tests |
| `test/code-fixer.integration.test.ts` | Layer 2, Docker-gated |
| `<repo>/vitest.workspace.ts`, `<repo>/.github/workflows/ci.yml`, `<repo>/examples/README.md` | Wiring |

---

### Task 1: Scaffold the workspace member

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `vitest.integration.config.ts`, `src/index.ts`, `test/smoke.test.ts`
- Modify: `<repo>/vitest.workspace.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@b4-example/software-factory-server",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc -p . --noEmit",
    "lint": "biome check .",
    "factory": "tsx src/cli.ts"
  },
  "dependencies": {
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

- [ ] **Step 2: Create `tsconfig.json`** (identical to code-fixer's)

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.AsyncIterable"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest*.ts"]
}
```

`DOM` and `DOM.AsyncIterable` are added because the SSE parser types `ReadableStream<Uint8Array>` from `fetch`.

- [ ] **Step 3: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.6/schema.json",
  "files": {
    "ignoreUnknown": true,
    "includes": ["**", "!**/.factory", "!node_modules"]
  },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "asNeeded" } },
  "linter": { "enabled": true, "rules": { "preset": "recommended" } },
  "root": true
}
```

- [ ] **Step 4: Create the two vitest configs**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "software-factory",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
```

`vitest.integration.config.ts`:

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

- [ ] **Step 5: Create `src/index.ts` and a smoke test**

`src/index.ts`:

```ts
export const RUNG = 0
```

`test/smoke.test.ts`:

```ts
import { expect, it } from "vitest"
import { RUNG } from "../src/index.ts"

it("is rung 0", () => {
  expect(RUNG).toBe(0)
})
```

- [ ] **Step 6: Register in the root vitest workspace**

In `<repo>/vitest.workspace.ts`, after the line `"./examples/code-fixer/server/vitest.config.ts",` add:

```ts
      "./examples/software-factory/server/vitest.config.ts",
```

- [ ] **Step 7: Install and run the gates**

```bash
cd <repo> && pnpm install --frozen-lockfile=false
pnpm --filter @b4-example/software-factory-server typecheck
pnpm --filter @b4-example/software-factory-server lint
pnpm --filter @b4-example/software-factory-server test
```

Expected: install adds the member to `pnpm-lock.yaml`; typecheck and lint pass; `1 passed`.

- [ ] **Step 8: Commit**

```bash
git add examples/software-factory pnpm-lock.yaml vitest.workspace.ts
git commit -m "feat(software-factory): scaffold the rung 0 workspace member"
```

---

### Task 2: State machine

**Files:**
- Create: `src/domain/states.ts`, `test/states.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import {
  ACTIVE_STATES,
  IllegalTransitionError,
  STATES,
  TERMINAL_STATES,
  isTerminal,
  nextState,
} from "../src/domain/states.ts"

describe("transition table", () => {
  it("follows the happy path", () => {
    expect(nextState("received", "dispatch_committed")).toBe("dispatched")
    expect(nextState("dispatched", "run_started")).toBe("running")
    expect(nextState("running", "candidate_ready")).toBe("candidate_ready")
    expect(nextState("candidate_ready", "approve")).toBe("exporting")
    expect(nextState("exporting", "receipt_observed")).toBe("exported")
  })

  it("refuses anything not in the table", () => {
    expect(() => nextState("received", "approve")).toThrow(IllegalTransitionError)
    expect(() => nextState("exported", "cancel")).toThrow(IllegalTransitionError)
    expect(() => nextState("candidate_ready", "run_failed")).toThrow(IllegalTransitionError)
  })

  it("allows cancel from every non-terminal state and nowhere else", () => {
    for (const state of STATES) {
      if (TERMINAL_STATES.has(state)) expect(() => nextState(state, "cancel")).toThrow()
      else expect(nextState(state, "cancel")).toBe("cancel_requested")
    }
  })

  it("separates cancel outcomes by cause", () => {
    expect(nextState("cancel_requested", "run_ended_after_cancel")).toBe("cancelled")
    expect(nextState("cancel_requested", "run_ended_after_budget")).toBe("blocked")
  })

  it("lets deny exit candidate_ready and blocked only", () => {
    expect(nextState("candidate_ready", "deny")).toBe("denied")
    expect(nextState("blocked", "deny")).toBe("denied")
    expect(() => nextState("running", "deny")).toThrow(IllegalTransitionError)
  })

  it("classifies states", () => {
    expect(isTerminal("failed")).toBe(true)
    expect(isTerminal("blocked")).toBe(false)
    expect([...ACTIVE_STATES].sort()).toEqual(["dispatched", "exporting", "running"])
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test states`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/domain/states.ts`**

```ts
export const STATES = [
  "received",
  "dispatched",
  "running",
  "candidate_ready",
  "exporting",
  "exported",
  "denied",
  "cancel_requested",
  "cancelled",
  "blocked",
  "failed",
] as const
export type WorkOrderState = (typeof STATES)[number]

export const TERMINAL_STATES: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
  "exported",
  "denied",
  "cancelled",
  "failed",
])

/** States that count toward the active-time budget. */
export const ACTIVE_STATES: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
  "dispatched",
  "running",
  "exporting",
])

export const BLOCKED_REASONS = ["unexpected_interrupt", "export_unconfirmed", "budget_exhausted"] as const
export type BlockedReason = (typeof BLOCKED_REASONS)[number]

export const FAILURE_REASONS = ["route_error", "ended_without_candidate"] as const
export type FailureReason = (typeof FAILURE_REASONS)[number]

export const TRANSITION_EVENTS = [
  "dispatch_committed",
  "run_started",
  "candidate_ready",
  "run_failed",
  "run_ended_without_candidate",
  "unexpected_interrupt",
  "approve",
  "deny",
  "receipt_observed",
  "export_unconfirmed",
  "cancel",
  "run_ended_after_cancel",
  "run_ended_after_budget",
  "budget_exhausted",
] as const
export type TransitionEvent = (typeof TRANSITION_EVENTS)[number]

type Row = Readonly<Partial<Record<WorkOrderState, WorkOrderState>>>

const NON_TERMINAL = STATES.filter((state) => !TERMINAL_STATES.has(state))
const everyNonTerminalTo = (to: WorkOrderState): Row =>
  Object.fromEntries(NON_TERMINAL.map((from) => [from, to])) as Row

const TABLE: Readonly<Record<TransitionEvent, Row>> = {
  dispatch_committed: { received: "dispatched" },
  run_started: { dispatched: "running" },
  candidate_ready: { dispatched: "candidate_ready", running: "candidate_ready" },
  run_failed: { dispatched: "failed", running: "failed" },
  run_ended_without_candidate: { dispatched: "failed", running: "failed" },
  unexpected_interrupt: { dispatched: "blocked", running: "blocked", exporting: "blocked" },
  approve: { candidate_ready: "exporting" },
  deny: { candidate_ready: "denied", blocked: "denied" },
  receipt_observed: { exporting: "exported" },
  export_unconfirmed: { exporting: "blocked" },
  cancel: everyNonTerminalTo("cancel_requested"),
  run_ended_after_cancel: { cancel_requested: "cancelled" },
  run_ended_after_budget: { cancel_requested: "blocked" },
  budget_exhausted: {
    dispatched: "cancel_requested",
    running: "cancel_requested",
    exporting: "cancel_requested",
  },
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: WorkOrderState,
    readonly event: TransitionEvent,
  ) {
    super(`Illegal transition: ${event} from ${from}`)
    this.name = "IllegalTransitionError"
  }
}

export function nextState(from: WorkOrderState, event: TransitionEvent): WorkOrderState {
  const to = TABLE[event][from]
  if (to === undefined) throw new IllegalTransitionError(from, event)
  return to
}

export function isTerminal(state: WorkOrderState): boolean {
  return TERMINAL_STATES.has(state)
}
```

- [ ] **Step 4: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test states`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/server/src/domain/states.ts examples/software-factory/server/test/states.test.ts
git commit -m "feat(software-factory): closed work-order state machine"
```

---

### Task 3: Domain and wire schemas

**Files:**
- Create: `src/domain/work-order.ts`, `src/worker/wire.ts`, `test/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { CommandOutcomeSchema, WorkOrderRowSchema } from "../src/domain/work-order.ts"
import {
  InterruptFrameSchema,
  isExportGate,
  parsePrepareReviewOutput,
} from "../src/worker/wire.ts"

const digest = "a".repeat(64)

describe("work-order schemas", () => {
  it("accepts a well-formed row and rejects an unknown state", () => {
    const row = {
      id: "wo-1",
      revision: 0,
      state: "received",
      taskId: "cli-flags",
      workerRoute: "/fix#agent",
      workerThreadId: null,
      candidateDigest: null,
      candidateVerified: null,
      blockedReason: null,
      failureReason: null,
      maxCandidateAttempts: 1,
      maxActiveMs: 1000,
      activeMs: 0,
      activeStartedAt: null,
      candidateReadyAt: null,
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
    }
    expect(WorkOrderRowSchema.parse(row)).toEqual(row)
    expect(() => WorkOrderRowSchema.parse({ ...row, state: "shipped" })).toThrow()
    expect(() => WorkOrderRowSchema.parse({ ...row, candidateDigest: "nope" })).toThrow()
  })

  it("requires a message on outcomes", () => {
    expect(() => CommandOutcomeSchema.parse({ ok: true })).toThrow()
    expect(CommandOutcomeSchema.parse({ ok: false, message: "stale" }).ok).toBe(false)
  })
})

describe("wire schemas", () => {
  it("recognises the exportForReview gate and nothing else", () => {
    const gate = InterruptFrameSchema.parse({
      interruptId: "perm-1",
      type: "permission-request",
      kind: "tool",
      detail: { toolName: "exportForReview", argsPreview: "{}", suggestedPattern: "exportForReview" },
    })
    expect(isExportGate(gate)).toBe(true)
    const other = InterruptFrameSchema.parse({
      interruptId: "perm-2",
      type: "permission-request",
      kind: "command",
      detail: { command: "rm", suggestedPattern: "rm" },
    })
    expect(isExportGate(other)).toBe(false)
  })

  it("parses prepareReview output given as an object or a JSON string", () => {
    const output = { candidate: { receiptDigest: digest, changes: {} }, verification: { passed: true } }
    expect(parsePrepareReviewOutput(output).candidate.receiptDigest).toBe(digest)
    expect(parsePrepareReviewOutput(JSON.stringify(output)).verification.passed).toBe(true)
    expect(() => parsePrepareReviewOutput({ candidate: {} })).toThrow()
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test schemas`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/domain/work-order.ts`**

```ts
import { z } from "zod"
import { BLOCKED_REASONS, FAILURE_REASONS, STATES } from "./states.js"

export const DIGEST_PATTERN = /^[a-f0-9]{64}$/

export const WorkOrderRowSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  state: z.enum(STATES),
  taskId: z.string().min(1),
  workerRoute: z.string().min(1),
  workerThreadId: z.string().min(1).nullable(),
  candidateDigest: z.string().regex(DIGEST_PATTERN).nullable(),
  candidateVerified: z.boolean().nullable(),
  blockedReason: z.enum(BLOCKED_REASONS).nullable(),
  failureReason: z.enum(FAILURE_REASONS).nullable(),
  maxCandidateAttempts: z.number().int().positive(),
  maxActiveMs: z.number().int().positive(),
  activeMs: z.number().int().nonnegative(),
  activeStartedAt: z.string().nullable(),
  candidateReadyAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type WorkOrderRow = z.infer<typeof WorkOrderRowSchema>

export const FactoryEventSchema = z.object({
  seq: z.number().int(),
  workOrderId: z.string(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  at: z.string(),
})
export type FactoryEvent = z.infer<typeof FactoryEventSchema>

export const COMMANDS = ["create", "dispatch", "approve", "deny", "cancel"] as const
export type CommandName = (typeof COMMANDS)[number]

export const CommandIntentSchema = z.object({
  command: z.enum(COMMANDS),
  args: z.record(z.string(), z.unknown()),
})
export type CommandIntent = z.infer<typeof CommandIntentSchema>

export const CommandOutcomeSchema = z.object({
  ok: z.boolean(),
  state: z.enum(STATES).optional(),
  message: z.string().min(1),
})
export type CommandOutcome = z.infer<typeof CommandOutcomeSchema>

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  workOrderId: z.string().min(1),
  candidateDigest: z.string().regex(DIGEST_PATTERN),
  decision: z.enum(["approved", "denied"]),
  decidedBy: z.string().min(1),
  decidedAt: z.string(),
  expiresAt: z.string(),
})
export type Approval = z.infer<typeof ApprovalSchema>

export const DeliverySchema = z.object({
  workOrderId: z.string().min(1),
  candidateDigest: z.string().regex(DIGEST_PATTERN),
  receiptPath: z.string().min(1),
  observedAt: z.string(),
})
export type Delivery = z.infer<typeof DeliverySchema>
```

- [ ] **Step 4: Implement `src/worker/wire.ts`**

```ts
import { z } from "zod"
import { DIGEST_PATTERN } from "../domain/work-order.js"

/** One Server-Sent Event as the runtime emits it: `event:` name and parsed `data:`. */
export interface StreamFrame {
  readonly event: string
  readonly data: unknown
}

export const InterruptFrameSchema = z.looseObject({
  interruptId: z.string().min(1),
  type: z.literal("permission-request"),
  kind: z.string().min(1),
  detail: z.record(z.string(), z.unknown()),
})
export type InterruptFrame = z.infer<typeof InterruptFrameSchema>

export const ToolResultFrameSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().min(1),
  output: z.unknown(),
})

export const DoneFrameSchema = z.looseObject({ output: z.unknown() })

export const ThreadSchema = z.looseObject({ thread_id: z.string().min(1), status: z.string() })

export const PendingInterruptsSchema = z.object({ interrupts: z.array(InterruptFrameSchema) })

export const CancelResponseSchema = z.object({
  thread_id: z.string().min(1),
  status: z.literal("interrupted"),
})

export const ErrorBodySchema = z.looseObject({
  error: z.looseObject({
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

export const PrepareReviewOutputSchema = z.looseObject({
  candidate: z.looseObject({ receiptDigest: z.string().regex(DIGEST_PATTERN) }),
  verification: z.looseObject({ passed: z.boolean() }),
})
export type PrepareReviewOutput = z.infer<typeof PrepareReviewOutputSchema>

export const EXPORT_TOOL = "exportForReview"
export const PREPARE_TOOL = "prepareReview"

export function isExportGate(frame: InterruptFrame): boolean {
  return frame.kind === "tool" && frame.detail.toolName === EXPORT_TOOL
}

/** Tool results arrive as the tool's return value or as a JSON string of it. */
export function parsePrepareReviewOutput(output: unknown): PrepareReviewOutput {
  const value = typeof output === "string" ? JSON.parse(output) : output
  return PrepareReviewOutputSchema.parse(value)
}

/** Read `output.error` / `output.cancelled` from a `done` frame without trusting its shape. */
export function classifyDone(data: unknown): { error: string | null; cancelled: boolean } {
  const parsed = DoneFrameSchema.safeParse(data)
  if (!parsed.success || typeof parsed.data.output !== "object" || parsed.data.output === null)
    return { error: null, cancelled: false }
  const output = parsed.data.output as Record<string, unknown>
  return {
    error: typeof output.error === "string" ? output.error : null,
    cancelled: output.cancelled === true,
  }
}
```

- [ ] **Step 5: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test schemas`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add examples/software-factory/server/src examples/software-factory/server/test/schemas.test.ts
git commit -m "feat(software-factory): domain and Agent Protocol wire schemas"
```

---

### Task 4: Server-Sent Events parser

**Files:**
- Create: `src/worker/sse.ts`, `test/sse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { parseBlock, parseSse } from "../src/worker/sse.ts"

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const frames = []
  for await (const frame of parseSse(stream)) frames.push(frame)
  return frames
}

describe("parseSse", () => {
  it("yields event name and parsed JSON data per blank-line block", async () => {
    const frames = await collect(
      streamOf('event: tool_call\ndata: {"name":"x","input":{}}\n\n', 'event: done\ndata: {"output":{}}\n\n'),
    )
    expect(frames).toEqual([
      { event: "tool_call", data: { name: "x", input: {} } },
      { event: "done", data: { output: {} } },
    ])
  })

  it("reassembles a block split across chunks and ignores ping comments", async () => {
    const frames = await collect(streamOf(": ping\n\nevent: chu", 'nk\ndata: "par', 'tial"\n\n'))
    expect(frames).toEqual([{ event: "chunk", data: "partial" }])
  })

  it("keeps non-JSON data as a string and defaults the event name", () => {
    expect(parseBlock("data: hello")).toEqual({ event: "message", data: "hello" })
    expect(parseBlock(": only a comment")).toBeNull()
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test sse`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/worker/sse.ts`**

```ts
import type { StreamFrame } from "./wire.js"

/** Parse one SSE block (lines up to a blank line). Returns null for comment-only blocks. */
export function parseBlock(block: string): StreamFrame | null {
  let event = "message"
  const dataLines: string[] = []
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    if (line === "" || line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    else if (field === "data") dataLines.push(value)
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join("\n")
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    data = raw
  }
  return { event, data }
}

/** Consume a `text/event-stream` body frame by frame. Ends when the body ends. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const frame = parseBlock(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (frame) yield frame
        boundary = buffer.indexOf("\n\n")
      }
    }
    const tail = parseBlock(buffer)
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}
```

- [ ] **Step 4: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test sse`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/server/src/worker/sse.ts examples/software-factory/server/test/sse.test.ts
git commit -m "feat(software-factory): Server-Sent Events parser"
```

---

### Task 5: Registry database and migrations

**Files:**
- Create: `src/registry/db.ts`, `test/registry-db.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { RegistryVersionError, SCHEMA_VERSION, openRegistry } from "../src/registry/db.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "factory-registry-"))
  dirs.push(dir)
  return join(dir, "nested", "registry.sqlite")
}

describe("openRegistry", () => {
  it("creates the file, the tables, and the version row", () => {
    const registry = openRegistry(tempPath())
    const tables = registry.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual([
      "approvals",
      "commands",
      "deliveries",
      "events",
      "schema_version",
      "sqlite_sequence",
      "work_orders",
    ])
    const version = registry.db.prepare("SELECT max(version) AS v FROM schema_version").get() as {
      v: number
    }
    expect(version.v).toBe(SCHEMA_VERSION)
    registry.close()
  })

  it("reopens an existing registry without re-running migrations", () => {
    const path = tempPath()
    openRegistry(path).close()
    const registry = openRegistry(path)
    const rows = registry.db.prepare("SELECT count(*) AS n FROM schema_version").get() as { n: number }
    expect(rows.n).toBe(1)
    registry.close()
  })

  it("refuses a registry written by a newer schema", () => {
    const path = tempPath()
    openRegistry(path).close()
    const db = new DatabaseSync(path)
    db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION + 1)
    db.close()
    expect(() => openRegistry(path)).toThrow(RegistryVersionError)
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test registry-db`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/registry/db.ts`**

```ts
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

export const SCHEMA_VERSION = 1

export interface Registry {
  readonly db: DatabaseSync
  close(): void
}

export class RegistryVersionError extends Error {
  constructor(readonly found: number) {
    super(
      `Registry schema version ${found} is newer than this factory supports (${SCHEMA_VERSION}); upgrade the factory`,
    )
    this.name = "RegistryVersionError"
  }
}

interface Migration {
  readonly version: number
  readonly up: string
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE work_orders (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        task_id TEXT NOT NULL,
        worker_route TEXT NOT NULL,
        worker_thread_id TEXT,
        candidate_digest TEXT,
        candidate_verified INTEGER,
        blocked_reason TEXT,
        failure_reason TEXT,
        max_candidate_attempts INTEGER NOT NULL,
        max_active_ms INTEGER NOT NULL,
        active_ms INTEGER NOT NULL DEFAULT 0,
        active_started_at TEXT,
        candidate_ready_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        work_order_id TEXT NOT NULL REFERENCES work_orders(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX events_by_work_order ON events(work_order_id, seq);
      CREATE TABLE commands (
        operation_key TEXT PRIMARY KEY,
        work_order_id TEXT NOT NULL,
        command TEXT NOT NULL,
        intent TEXT NOT NULL,
        outcome TEXT,
        at TEXT NOT NULL
      );
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        work_order_id TEXT NOT NULL REFERENCES work_orders(id),
        candidate_digest TEXT NOT NULL,
        decision TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE deliveries (
        work_order_id TEXT PRIMARY KEY REFERENCES work_orders(id),
        candidate_digest TEXT NOT NULL,
        receipt_path TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
    `,
  },
]

/** Open (creating if needed) the factory registry. Refuses a newer on-disk schema. */
export function openRegistry(path: string): Registry {
  const isMemory = path === ":memory:"
  if (!isMemory) mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  if (!isMemory) db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)")
  const row = db.prepare("SELECT max(version) AS v FROM schema_version").get() as { v: number | null }
  const current = row.v ?? 0
  if (current > SCHEMA_VERSION) {
    db.close()
    throw new RegistryVersionError(current)
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec("BEGIN")
    try {
      db.exec(migration.up)
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(migration.version)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }
  return { db, close: () => db.close() }
}
```

- [ ] **Step 4: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test registry-db`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/server/src/registry/db.ts examples/software-factory/server/test/registry-db.test.ts
git commit -m "feat(software-factory): sqlite registry with versioned migrations"
```

---

### Task 6: Work-order store with compare-and-swap

**Files:**
- Create: `src/registry/work-orders.ts`, `test/work-orders.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import type { WorkOrderRow } from "../src/domain/work-order.ts"
import { openRegistry } from "../src/registry/db.ts"
import { StaleRevisionError, createWorkOrderStore } from "../src/registry/work-orders.ts"

const at = "2026-09-16T00:00:00.000Z"
const digest = "b".repeat(64)

function freshRow(id = "wo-1"): WorkOrderRow {
  return {
    id,
    revision: 0,
    state: "received",
    taskId: "cli-flags",
    workerRoute: "/fix#agent",
    workerThreadId: null,
    candidateDigest: null,
    candidateVerified: null,
    blockedReason: null,
    failureReason: null,
    maxCandidateAttempts: 1,
    maxActiveMs: 60_000,
    activeMs: 0,
    activeStartedAt: null,
    candidateReadyAt: null,
    createdAt: at,
    updatedAt: at,
  }
}

function store() {
  return createWorkOrderStore(openRegistry(":memory:").db)
}

describe("work-order store", () => {
  it("round-trips a row", () => {
    const s = store()
    s.insert(freshRow())
    expect(s.get("wo-1")).toEqual(freshRow())
    expect(s.get("missing")).toBeNull()
    expect(s.list().map((r) => r.id)).toEqual(["wo-1"])
  })

  it("updates only when the revision matches, and bumps it", () => {
    const s = store()
    s.insert(freshRow())
    const updated = s.update("wo-1", 0, { state: "dispatched", workerThreadId: "t-1" }, at)
    expect(updated.revision).toBe(1)
    expect(updated.state).toBe("dispatched")
    expect(updated.workerThreadId).toBe("t-1")
    expect(() => s.update("wo-1", 0, { state: "running" }, at)).toThrow(StaleRevisionError)
    expect(s.get("wo-1")?.state).toBe("dispatched")
  })

  it("stores booleans and nulls faithfully", () => {
    const s = store()
    s.insert(freshRow())
    const row = s.update("wo-1", 0, { candidateDigest: digest, candidateVerified: false }, at)
    expect(row.candidateVerified).toBe(false)
    expect(s.update("wo-1", 1, { candidateVerified: null }, at).candidateVerified).toBeNull()
  })

  it("appends and reads events in sequence", () => {
    const s = store()
    s.insert(freshRow())
    s.appendEvent("wo-1", "created", { taskId: "cli-flags" }, at)
    s.appendEvent("wo-1", "thread_created", { threadId: "t-1" }, at)
    const events = s.events("wo-1")
    expect(events.map((e) => e.type)).toEqual(["created", "thread_created"])
    expect(events[1]?.seq).toBeGreaterThan(events[0]?.seq ?? Number.POSITIVE_INFINITY)
    expect(events[1]?.payload).toEqual({ threadId: "t-1" })
  })

  it("records approvals and deliveries", () => {
    const s = store()
    s.insert(freshRow())
    s.recordApproval({
      id: "ap-1",
      workOrderId: "wo-1",
      candidateDigest: digest,
      decision: "approved",
      decidedBy: "operator",
      decidedAt: at,
      expiresAt: at,
    })
    expect(s.approvals("wo-1")).toHaveLength(1)
    s.recordDelivery({ workOrderId: "wo-1", candidateDigest: digest, receiptPath: "/x", observedAt: at })
    expect(s.delivery("wo-1")?.receiptPath).toBe("/x")
  })

  it("rolls a transaction back on error", () => {
    const s = store()
    s.insert(freshRow())
    expect(() =>
      s.transaction(() => {
        s.appendEvent("wo-1", "x", {}, at)
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(s.events("wo-1")).toEqual([])
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test work-orders`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/registry/work-orders.ts`**

```ts
import type { DatabaseSync } from "node:sqlite"
import {
  type Approval,
  ApprovalSchema,
  type Delivery,
  DeliverySchema,
  type FactoryEvent,
  FactoryEventSchema,
  type WorkOrderRow,
  WorkOrderRowSchema,
} from "../domain/work-order.js"

export class StaleRevisionError extends Error {
  constructor(
    readonly id: string,
    readonly expectedRevision: number,
  ) {
    super(`Work order ${id} is not at revision ${expectedRevision}`)
    this.name = "StaleRevisionError"
  }
}

/** Fields a command may change. Identity, limits and timestamps are fixed at insert. */
export type WorkOrderPatch = Partial<
  Pick<
    WorkOrderRow,
    | "state"
    | "workerThreadId"
    | "candidateDigest"
    | "candidateVerified"
    | "blockedReason"
    | "failureReason"
    | "activeMs"
    | "activeStartedAt"
    | "candidateReadyAt"
  >
>

export interface WorkOrderStore {
  insert(row: WorkOrderRow): void
  get(id: string): WorkOrderRow | null
  list(): WorkOrderRow[]
  /** Compare-and-swap: applies `patch` only if the row is at `expectedRevision`; increments it. */
  update(id: string, expectedRevision: number, patch: WorkOrderPatch, now: string): WorkOrderRow
  appendEvent(workOrderId: string, type: string, payload: Record<string, unknown>, now: string): void
  events(workOrderId: string): FactoryEvent[]
  recordApproval(approval: Approval): void
  approvals(workOrderId: string): Approval[]
  recordDelivery(delivery: Delivery): void
  delivery(workOrderId: string): Delivery | null
  transaction<T>(fn: () => T): T
}

const COLUMNS: Readonly<Record<keyof WorkOrderRow, string>> = {
  id: "id",
  revision: "revision",
  state: "state",
  taskId: "task_id",
  workerRoute: "worker_route",
  workerThreadId: "worker_thread_id",
  candidateDigest: "candidate_digest",
  candidateVerified: "candidate_verified",
  blockedReason: "blocked_reason",
  failureReason: "failure_reason",
  maxCandidateAttempts: "max_candidate_attempts",
  maxActiveMs: "max_active_ms",
  activeMs: "active_ms",
  activeStartedAt: "active_started_at",
  candidateReadyAt: "candidate_ready_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
}

type SqlValue = string | number | null

function toSql(key: keyof WorkOrderRow, value: unknown): SqlValue {
  if (value === null || value === undefined) return null
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number" || typeof value === "string") return value
  throw new TypeError(`Unsupported value for ${key}`)
}

function fromSql(record: Record<string, unknown>): WorkOrderRow {
  const raw: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(COLUMNS) as [keyof WorkOrderRow, string][]) {
    const value = record[column]
    raw[key] =
      key === "candidateVerified" && value !== null && value !== undefined ? value === 1 : (value ?? null)
  }
  return WorkOrderRowSchema.parse(raw)
}

export function createWorkOrderStore(db: DatabaseSync): WorkOrderStore {
  const keys = Object.keys(COLUMNS) as (keyof WorkOrderRow)[]
  const insertSql = `INSERT INTO work_orders (${keys.map((k) => COLUMNS[k]).join(", ")}) VALUES (${keys
    .map(() => "?")
    .join(", ")})`

  return {
    insert(row) {
      WorkOrderRowSchema.parse(row)
      db.prepare(insertSql).run(...keys.map((k) => toSql(k, row[k])))
    },
    get(id) {
      const record = db.prepare("SELECT * FROM work_orders WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined
      return record ? fromSql(record) : null
    },
    list() {
      const records = db
        .prepare("SELECT * FROM work_orders ORDER BY created_at, id")
        .all() as Record<string, unknown>[]
      return records.map(fromSql)
    },
    update(id, expectedRevision, patch, now) {
      const entries = Object.entries(patch) as [keyof WorkOrderPatch, unknown][]
      const assignments = entries.map(([key]) => `${COLUMNS[key]} = ?`)
      assignments.push("revision = revision + 1", "updated_at = ?")
      const result = db
        .prepare(`UPDATE work_orders SET ${assignments.join(", ")} WHERE id = ? AND revision = ?`)
        .run(...entries.map(([key, value]) => toSql(key, value)), now, id, expectedRevision)
      if (result.changes !== 1) throw new StaleRevisionError(id, expectedRevision)
      const row = this.get(id)
      if (!row) throw new Error(`Work order ${id} vanished during update`)
      return row
    },
    appendEvent(workOrderId, type, payload, now) {
      db.prepare("INSERT INTO events (work_order_id, type, payload, at) VALUES (?, ?, ?, ?)").run(
        workOrderId,
        type,
        JSON.stringify(payload),
        now,
      )
    },
    events(workOrderId) {
      const records = db
        .prepare("SELECT seq, work_order_id, type, payload, at FROM events WHERE work_order_id = ? ORDER BY seq")
        .all(workOrderId) as { seq: number; work_order_id: string; type: string; payload: string; at: string }[]
      return records.map((r) =>
        FactoryEventSchema.parse({
          seq: r.seq,
          workOrderId: r.work_order_id,
          type: r.type,
          payload: JSON.parse(r.payload),
          at: r.at,
        }),
      )
    },
    recordApproval(approval) {
      ApprovalSchema.parse(approval)
      db.prepare(
        "INSERT INTO approvals (id, work_order_id, candidate_digest, decision, decided_by, decided_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        approval.id,
        approval.workOrderId,
        approval.candidateDigest,
        approval.decision,
        approval.decidedBy,
        approval.decidedAt,
        approval.expiresAt,
      )
    },
    approvals(workOrderId) {
      const records = db
        .prepare("SELECT * FROM approvals WHERE work_order_id = ? ORDER BY decided_at")
        .all(workOrderId) as Record<string, string>[]
      return records.map((r) =>
        ApprovalSchema.parse({
          id: r.id,
          workOrderId: r.work_order_id,
          candidateDigest: r.candidate_digest,
          decision: r.decision,
          decidedBy: r.decided_by,
          decidedAt: r.decided_at,
          expiresAt: r.expires_at,
        }),
      )
    },
    recordDelivery(delivery) {
      DeliverySchema.parse(delivery)
      db.prepare(
        "INSERT INTO deliveries (work_order_id, candidate_digest, receipt_path, observed_at) VALUES (?, ?, ?, ?)",
      ).run(delivery.workOrderId, delivery.candidateDigest, delivery.receiptPath, delivery.observedAt)
    },
    delivery(workOrderId) {
      const r = db.prepare("SELECT * FROM deliveries WHERE work_order_id = ?").get(workOrderId) as
        | Record<string, string>
        | undefined
      return r
        ? DeliverySchema.parse({
            workOrderId: r.work_order_id,
            candidateDigest: r.candidate_digest,
            receiptPath: r.receipt_path,
            observedAt: r.observed_at,
          })
        : null
    },
    transaction(fn) {
      db.exec("BEGIN")
      try {
        const result = fn()
        db.exec("COMMIT")
        return result
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
  }
}
```

- [ ] **Step 4: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test work-orders`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/server/src/registry/work-orders.ts examples/software-factory/server/test/work-orders.test.ts
git commit -m "feat(software-factory): work-order store with compare-and-swap writes"
```

---

### Task 7: Two-phase command log

**Files:**
- Create: `src/registry/commands.ts`, `test/commands.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { createCommandLog } from "../src/registry/commands.ts"
import { openRegistry } from "../src/registry/db.ts"

const at = "2026-09-16T00:00:00.000Z"
const intent = { command: "dispatch" as const, args: {} }

describe("command log", () => {
  it("is new the first time, in flight until completed, then done with the recorded outcome", () => {
    const log = createCommandLog(openRegistry(":memory:").db)
    expect(log.begin("k1", "wo-1", intent, at)).toEqual({ status: "new" })
    expect(log.begin("k1", "wo-1", intent, at)).toEqual({ status: "in_flight", intent })
    log.complete("k1", { ok: true, state: "dispatched", message: "dispatched" })
    expect(log.begin("k1", "wo-1", intent, at)).toEqual({
      status: "done",
      outcome: { ok: true, state: "dispatched", message: "dispatched" },
    })
  })

  it("lists open intents for reconciliation", () => {
    const log = createCommandLog(openRegistry(":memory:").db)
    log.begin("k1", "wo-1", intent, at)
    log.begin("k2", "wo-2", { command: "approve", args: { revision: 3 } }, at)
    log.complete("k1", { ok: true, message: "done" })
    expect(log.open()).toEqual([
      { operationKey: "k2", workOrderId: "wo-2", intent: { command: "approve", args: { revision: 3 } } },
    ])
  })

  it("refuses to complete an unknown or already completed key", () => {
    const log = createCommandLog(openRegistry(":memory:").db)
    expect(() => log.complete("nope", { ok: true, message: "x" })).toThrow()
    log.begin("k1", "wo-1", intent, at)
    log.complete("k1", { ok: true, message: "x" })
    expect(() => log.complete("k1", { ok: false, message: "y" })).toThrow()
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test commands`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/registry/commands.ts`**

```ts
import type { DatabaseSync } from "node:sqlite"
import {
  type CommandIntent,
  CommandIntentSchema,
  type CommandOutcome,
  CommandOutcomeSchema,
} from "../domain/work-order.js"

export type BeginResult =
  | { readonly status: "new" }
  | { readonly status: "in_flight"; readonly intent: CommandIntent }
  | { readonly status: "done"; readonly outcome: CommandOutcome }

export interface OpenCommand {
  readonly operationKey: string
  readonly workOrderId: string
  readonly intent: CommandIntent
}

export interface CommandLog {
  /** Record the intent under `operationKey`, or report what is already recorded. */
  begin(operationKey: string, workOrderId: string, intent: CommandIntent, now: string): BeginResult
  /** Record the outcome. Throws if the key is unknown or already has an outcome. */
  complete(operationKey: string, outcome: CommandOutcome): void
  /** Intents committed without an outcome, oldest first. */
  open(): OpenCommand[]
}

export function createCommandLog(db: DatabaseSync): CommandLog {
  return {
    begin(operationKey, workOrderId, intent, now) {
      CommandIntentSchema.parse(intent)
      const existing = db
        .prepare("SELECT intent, outcome FROM commands WHERE operation_key = ?")
        .get(operationKey) as { intent: string; outcome: string | null } | undefined
      if (existing) {
        if (existing.outcome !== null)
          return { status: "done", outcome: CommandOutcomeSchema.parse(JSON.parse(existing.outcome)) }
        return { status: "in_flight", intent: CommandIntentSchema.parse(JSON.parse(existing.intent)) }
      }
      db.prepare(
        "INSERT INTO commands (operation_key, work_order_id, command, intent, outcome, at) VALUES (?, ?, ?, ?, NULL, ?)",
      ).run(operationKey, workOrderId, intent.command, JSON.stringify(intent), now)
      return { status: "new" }
    },
    complete(operationKey, outcome) {
      CommandOutcomeSchema.parse(outcome)
      const result = db
        .prepare("UPDATE commands SET outcome = ? WHERE operation_key = ? AND outcome IS NULL")
        .run(JSON.stringify(outcome), operationKey)
      if (result.changes !== 1) throw new Error(`Command ${operationKey} is unknown or already completed`)
    },
    open() {
      const rows = db
        .prepare("SELECT operation_key, work_order_id, intent FROM commands WHERE outcome IS NULL ORDER BY at, operation_key")
        .all() as { operation_key: string; work_order_id: string; intent: string }[]
      return rows.map((r) => ({
        operationKey: r.operation_key,
        workOrderId: r.work_order_id,
        intent: CommandIntentSchema.parse(JSON.parse(r.intent)),
      }))
    },
  }
}
```

- [ ] **Step 4: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test commands`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/server/src/registry/commands.ts examples/software-factory/server/test/commands.test.ts
git commit -m "feat(software-factory): two-phase command log keyed by operation key"
```

---

### Task 8: Outbox observation, prompts, and configuration

**Files:**
- Create: `src/worker/outbox.ts`, `src/prompts.ts`, `src/config.ts`, `test/outbox.test.ts`, `test/config.test.ts`

- [ ] **Step 1: Write the failing outbox test**

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { receiptExists, receiptPath, waitForReceipt } from "../src/worker/outbox.ts"

const digest = "c".repeat(64)
let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("outbox", () => {
  it("names the receipt by digest and reports presence", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-outbox-"))
    expect(receiptPath(dir, digest)).toBe(join(dir, `${digest}.json`))
    expect(await receiptExists(dir, digest)).toBe(false)
    writeFileSync(receiptPath(dir, digest), "{}")
    expect(await receiptExists(dir, digest)).toBe(true)
  })

  it("waits for a receipt that appears later and gives up on time", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-outbox-"))
    setTimeout(() => writeFileSync(receiptPath(dir, digest), "{}"), 60)
    expect(await waitForReceipt(dir, digest, { timeoutMs: 2_000, intervalMs: 10 })).toBe(
      receiptPath(dir, digest),
    )
    expect(await waitForReceipt(dir, "d".repeat(64), { timeoutMs: 50, intervalMs: 10 })).toBeNull()
  })
})
```

- [ ] **Step 2: Write the failing config test**

```ts
import { describe, expect, it } from "vitest"
import { loadConfig } from "../src/config.ts"

const base = {
  FACTORY_WORKER_URL: "http://127.0.0.1:4100",
  FACTORY_WORKER_OUTBOX: "/tmp/outbox",
  FACTORY_STATE_DIR: "/tmp/state",
}

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(base)
    expect(config.workerRoute).toBe("/fix#agent")
    expect(config.approvalTtlMs).toBe(900_000)
    expect(config.maxActiveMs).toBe(1_200_000)
    expect(config.receiptWaitMs).toBe(180_000)
    expect(config.registryPath).toBe("/tmp/state/registry.sqlite")
    expect(config.httpPort).toBe(4300)
  })

  it("rejects missing or malformed values", () => {
    expect(() => loadConfig({})).toThrow(/FACTORY_WORKER_URL/)
    expect(() => loadConfig({ ...base, FACTORY_APPROVAL_TTL_MS: "soon" })).toThrow(/FACTORY_APPROVAL_TTL_MS/)
    expect(() => loadConfig({ ...base, FACTORY_WORKER_URL: "ftp://x" })).toThrow(/FACTORY_WORKER_URL/)
  })
})
```

- [ ] **Step 3: Run both**

Run: `pnpm --filter @b4-example/software-factory-server test outbox config`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `src/worker/outbox.ts`**

```ts
import { access } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

/** code-fixer writes `<receiptDigest>.json` into its review outbox; that filename is the binding. */
export function receiptPath(outboxDir: string, digest: string): string {
  return join(outboxDir, `${digest}.json`)
}

export async function receiptExists(outboxDir: string, digest: string): Promise<boolean> {
  try {
    await access(receiptPath(outboxDir, digest))
    return true
  } catch {
    return false
  }
}

export async function waitForReceipt(
  outboxDir: string,
  digest: string,
  options: { readonly timeoutMs: number; readonly intervalMs?: number; readonly signal?: AbortSignal },
): Promise<string | null> {
  const deadline = Date.now() + options.timeoutMs
  const interval = options.intervalMs ?? 250
  while (true) {
    if (await receiptExists(outboxDir, digest)) return receiptPath(outboxDir, digest)
    if (Date.now() >= deadline || options.signal?.aborted) return null
    await sleep(Math.min(interval, Math.max(1, deadline - Date.now())))
  }
}
```

- [ ] **Step 5: Implement `src/prompts.ts`**

The turn 1 text must be a constant because `aimock` matches fixtures on the exact user message.

```ts
/** Turn 1 prompt per task id. The worker must stop after prepareReview; the factory asks for export. */
export const TURN_ONE_PROMPTS: Readonly<Record<string, string>> = {
  "cli-flags":
    "Read TASK.md, reproduce the failure, repair the permitted source, verify the preservation requirements, and call prepareReview. Do not call exportForReview; the factory will ask for export separately.",
}

/** Turn 2 prompt. Sent only after the operator approved exactly this digest. */
export function turnTwoPrompt(digest: string): string {
  return `Export the verified candidate whose receiptDigest is ${digest} by calling exportForReview with the exact candidate object returned by prepareReview.`
}
```

- [ ] **Step 6: Implement `src/config.ts`**

```ts
import { join } from "node:path"
import { z } from "zod"

const positiveInt = (name: string) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        ctx.addIssue({ code: "custom", message: `${name} must be a positive integer` })
        return z.NEVER
      }
      return parsed
    })

const EnvSchema = z.object({
  FACTORY_WORKER_URL: z
    .string({ error: "FACTORY_WORKER_URL is required" })
    .url()
    .refine((value) => /^https?:/.test(value), { message: "FACTORY_WORKER_URL must be http(s)" }),
  FACTORY_WORKER_ROUTE: z.string().min(1).default("/fix#agent"),
  FACTORY_WORKER_OUTBOX: z.string({ error: "FACTORY_WORKER_OUTBOX is required" }).min(1),
  FACTORY_STATE_DIR: z.string({ error: "FACTORY_STATE_DIR is required" }).min(1),
  FACTORY_APPROVAL_TTL_MS: positiveInt("FACTORY_APPROVAL_TTL_MS"),
  FACTORY_MAX_ACTIVE_MS: positiveInt("FACTORY_MAX_ACTIVE_MS"),
  FACTORY_RECEIPT_WAIT_MS: positiveInt("FACTORY_RECEIPT_WAIT_MS"),
  FACTORY_HTTP_PORT: positiveInt("FACTORY_HTTP_PORT"),
})

export interface FactoryConfig {
  readonly workerUrl: string
  readonly workerRoute: string
  readonly outboxDir: string
  readonly stateDir: string
  readonly registryPath: string
  readonly approvalTtlMs: number
  readonly maxActiveMs: number
  readonly receiptWaitMs: number
  readonly httpPort: number
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): FactoryConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`)
    throw new Error(`Invalid factory configuration:\n${issues.join("\n")}`)
  }
  const e = parsed.data
  return {
    workerUrl: e.FACTORY_WORKER_URL.replace(/\/$/, ""),
    workerRoute: e.FACTORY_WORKER_ROUTE,
    outboxDir: e.FACTORY_WORKER_OUTBOX,
    stateDir: e.FACTORY_STATE_DIR,
    registryPath: join(e.FACTORY_STATE_DIR, "registry.sqlite"),
    approvalTtlMs: e.FACTORY_APPROVAL_TTL_MS ?? 900_000,
    maxActiveMs: e.FACTORY_MAX_ACTIVE_MS ?? 1_200_000,
    receiptWaitMs: e.FACTORY_RECEIPT_WAIT_MS ?? 180_000,
    httpPort: e.FACTORY_HTTP_PORT ?? 4300,
  }
}
```

If zod 4 rejects the `{ error: "..." }` form for `z.string(...)`, use `z.string({ message: "..." })`; the test only checks that the variable name appears.

- [ ] **Step 7: Run both**

Run: `pnpm --filter @b4-example/software-factory-server test outbox config`
Expected: PASS, 4 tests.

- [ ] **Step 8: Commit**

```bash
git add examples/software-factory/server/src examples/software-factory/server/test
git commit -m "feat(software-factory): outbox observation, prompt constants, configuration"
```

---

### Task 9: Scripted fake Agent Protocol worker (test infrastructure)

The fake implements only the seven calls the controller uses, with the status codes and frame shapes from `apps/web/content/docs/dev-server/agent-protocol.mdx`. It is written from that document, not from the controller. Behaviour is chosen by name so tests read clearly.

**Files:**
- Create: `test/fake-worker.ts`, `test/fake-worker.test.ts`

- [ ] **Step 1: Write the failing test** (exercises the fake directly with `fetch`)

```ts
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type FakeWorker, createFakeWorker } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
afterEach(async () => {
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

async function sseEvents(response: Response): Promise<string[]> {
  const text = await response.text()
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event:"))
    .map((block) => block.split("\n")[0]?.slice("event: ".length) ?? "")
}

describe("fake worker", () => {
  it("runs the happy two-turn protocol and writes the receipt on resume once", async () => {
    dir = mkdtempSync(join(tmpdir(), "fake-worker-"))
    fake = await createFakeWorker({ outboxDir: dir })
    const created = await fetch(`${fake.baseUrl}/threads`, { method: "POST", body: "{}" })
    const { thread_id } = (await created.json()) as { thread_id: string }

    const turnOne = await fetch(`${fake.baseUrl}/threads/${thread_id}/runs/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "/fix#agent", input: { messages: [{ role: "user", content: "go" }] } }),
    })
    expect(await sseEvents(turnOne)).toEqual(["tool_result", "tool_result", "chunk", "done"])

    const turnTwo = await fetch(`${fake.baseUrl}/threads/${thread_id}/runs/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "/fix#agent", input: { messages: [{ role: "user", content: "export" }] } }),
    })
    expect(await sseEvents(turnTwo)).toEqual(["interrupt", "done"])

    const pending = (await (await fetch(`${fake.baseUrl}/threads/${thread_id}/pending_interrupts`)).json()) as {
      interrupts: { interruptId: string; kind: string; detail: { toolName: string } }[]
    }
    expect(pending.interrupts).toHaveLength(1)
    expect(pending.interrupts[0]?.detail.toolName).toBe("exportForReview")

    const resumed = await fetch(`${fake.baseUrl}/threads/${thread_id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resume: [{ interruptId: pending.interrupts[0]?.interruptId, status: "resolved", payload: "once" }],
        route: "/fix#agent",
      }),
    })
    expect(resumed.status).toBe(200)
    await resumed.text()
    expect(readdirSync(dir)).toEqual([`${fake.digest}.json`])
    expect(fake.requests.filter((r) => r.path.endsWith("/resume"))).toHaveLength(1)
  })

  it("returns the documented errors", async () => {
    dir = mkdtempSync(join(tmpdir(), "fake-worker-"))
    fake = await createFakeWorker({ outboxDir: dir })
    expect((await fetch(`${fake.baseUrl}/threads/nope`)).status).toBe(404)
    const cancel = await fetch(`${fake.baseUrl}/threads/nope/cancel`, { method: "POST" })
    expect(cancel.status).toBe(404)
    const created = await fetch(`${fake.baseUrl}/threads`, { method: "POST", body: "{}" })
    const { thread_id } = (await created.json()) as { thread_id: string }
    const idleCancel = await fetch(`${fake.baseUrl}/threads/${thread_id}/cancel`, { method: "POST" })
    expect(idleCancel.status).toBe(409)
    expect(((await idleCancel.json()) as { error: { details: { code: string } } }).error.details.code).toBe(
      "no_run_in_flight",
    )
    const badResume = await fetch(`${fake.baseUrl}/threads/${thread_id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resume: [], route: "/fix#agent" }),
    })
    expect(badResume.status).toBe(409)
  })

  it("cancels a hanging run in band", async () => {
    dir = mkdtempSync(join(tmpdir(), "fake-worker-"))
    fake = await createFakeWorker({ outboxDir: dir, turnOne: "hang" })
    const created = await fetch(`${fake.baseUrl}/threads`, { method: "POST", body: "{}" })
    const { thread_id } = (await created.json()) as { thread_id: string }
    const streamPromise = fetch(`${fake.baseUrl}/threads/${thread_id}/runs/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "/fix#agent", input: {} }),
    }).then((r) => r.text())
    await fake.waitForRunStart(thread_id)
    const cancel = await fetch(`${fake.baseUrl}/threads/${thread_id}/cancel`, { method: "POST" })
    expect(cancel.status).toBe(200)
    expect(await streamPromise).toContain('"cancelled":true')
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test fake-worker`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `test/fake-worker.ts`**

```ts
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

export type TurnOneBehaviour =
  | "happy"
  | "route_error"
  | "no_candidate"
  | "hang"
  | "close_midway"
  | "unexpected_interrupt"
  | "premature_export"
export type TurnTwoBehaviour = "gate" | "route_error" | "hang"
export type ResumeBehaviour = "receipt" | "no_receipt" | "route_error"

export interface FakeWorkerOptions {
  readonly outboxDir: string
  readonly turnOne?: TurnOneBehaviour
  readonly turnTwo?: TurnTwoBehaviour
  readonly resume?: ResumeBehaviour
  /** Milliseconds between frames; keep small in tests. */
  readonly frameDelayMs?: number
}

export interface LoggedRequest {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

interface Thread {
  readonly id: string
  status: "idle" | "busy" | "interrupted"
  turns: number
  runActive: boolean
  resumeActive: boolean
  pending: Record<string, unknown> | null
  /** Ends a hanging stream with the cancelled `done` frame. */
  endHang: (() => void) | null
}

export interface FakeWorker {
  readonly baseUrl: string
  readonly digest: string
  readonly candidate: Record<string, unknown>
  readonly requests: LoggedRequest[]
  behaviour: { turnOne: TurnOneBehaviour; turnTwo: TurnTwoBehaviour; resume: ResumeBehaviour }
  thread(id: string): Readonly<Thread> | undefined
  waitForRunStart(threadId: string): Promise<void>
  close(): Promise<void>
}

const DIGEST = createHash("sha256").update("fake-candidate").digest("hex")
const CANDIDATE = {
  version: 1,
  workspaceId: "fake-workspace",
  sourceDigest: "a".repeat(64),
  changes: { "src/cli.ts": "export const fixed = true\n" },
  receiptDigest: DIGEST,
}

function errorBody(message: string, code?: string) {
  return JSON.stringify({ error: { message, ...(code ? { details: { code } } : {}) } })
}

function json(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString("utf8")
  if (text === "") return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

class Sse {
  constructor(private readonly res: ServerResponse) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  }
  frame(event: string, data: unknown) {
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  comment(text: string) {
    this.res.write(`: ${text}\n\n`)
  }
  end() {
    this.res.end()
  }
  destroy() {
    this.res.destroy()
  }
}

export async function createFakeWorker(options: FakeWorkerOptions): Promise<FakeWorker> {
  const threads = new Map<string, Thread>()
  const requests: LoggedRequest[] = []
  const behaviour = {
    turnOne: options.turnOne ?? "happy",
    turnTwo: options.turnTwo ?? "gate",
    resume: options.resume ?? "receipt",
  }
  const delay = options.frameDelayMs ?? 5
  let counter = 0
  const runStarted = new Map<string, () => void>()

  const gateInterrupt = () => ({
    interruptId: `perm-export-${++counter}`,
    type: "permission-request",
    kind: "tool",
    detail: {
      toolName: "exportForReview",
      argsPreview: JSON.stringify({ candidate: CANDIDATE }).slice(0, 500),
      suggestedPattern: "exportForReview",
    },
  })

  async function streamTurnOne(thread: Thread, sse: Sse) {
    const kind = behaviour.turnOne
    if (kind === "route_error") {
      sse.frame("done", { output: { error: "route exploded" } })
      return finishRun(thread, sse)
    }
    if (kind === "no_candidate") {
      sse.frame("chunk", "I could not repair it.")
      sse.frame("done", { output: {} })
      return finishRun(thread, sse)
    }
    if (kind === "hang") {
      sse.comment("ping")
      await new Promise<void>((resolve) => {
        thread.endHang = () => {
          sse.frame("done", { output: { cancelled: true } })
          resolve()
        }
      })
      return finishRun(thread, sse)
    }
    if (kind === "unexpected_interrupt") {
      thread.pending = {
        interruptId: `perm-cmd-${++counter}`,
        type: "permission-request",
        kind: "command",
        detail: { command: "rm -rf /", suggestedPattern: "rm" },
      }
      sse.frame("interrupt", thread.pending)
      sse.frame("done", { output: {} })
      return parkRun(thread, sse)
    }
    sse.frame("tool_result", { id: "call-1", name: "readFile", output: "TASK.md contents" })
    await sleep(delay)
    sse.frame("tool_result", {
      id: "call-2",
      name: "prepareReview",
      output: JSON.stringify({
        task: "cli-flags",
        candidate: CANDIDATE,
        diff: "--- a/src/cli.ts\n+++ b/src/cli.ts\n",
        verification: { passed: true },
      }),
    })
    if (kind === "close_midway") {
      sse.destroy()
      await sleep(50)
      thread.runActive = false
      thread.status = "idle"
      return
    }
    await sleep(delay)
    if (kind === "premature_export") {
      thread.pending = gateInterrupt()
      sse.frame("interrupt", thread.pending)
      sse.frame("done", { output: {} })
      return parkRun(thread, sse)
    }
    sse.frame("chunk", "Candidate verified and ready for approval.")
    sse.frame("done", { output: {} })
    return finishRun(thread, sse)
  }

  async function streamTurnTwo(thread: Thread, sse: Sse) {
    const kind = behaviour.turnTwo
    if (kind === "route_error") {
      sse.frame("done", { output: { error: "export turn exploded" } })
      return finishRun(thread, sse)
    }
    if (kind === "hang") {
      sse.comment("ping")
      await new Promise<void>((resolve) => {
        thread.endHang = () => {
          sse.frame("done", { output: { cancelled: true } })
          resolve()
        }
      })
      return finishRun(thread, sse)
    }
    thread.pending = gateInterrupt()
    sse.frame("interrupt", thread.pending)
    sse.frame("done", { output: {} })
    return parkRun(thread, sse)
  }

  function finishRun(thread: Thread, sse: Sse) {
    thread.runActive = false
    thread.endHang = null
    thread.status = "idle"
    sse.end()
  }

  function parkRun(thread: Thread, sse: Sse) {
    thread.runActive = false
    thread.status = "interrupted"
    sse.end()
  }

  async function streamResume(thread: Thread, sse: Sse, payload: string) {
    thread.resumeActive = true
    thread.pending = null
    if (payload === "deny") {
      sse.frame("chunk", "Export was denied; stopping.")
      sse.frame("done", { output: {} })
    } else if (behaviour.resume === "route_error") {
      sse.frame("done", { output: { error: "export failed" } })
    } else {
      if (behaviour.resume === "receipt")
        writeFileSync(
          join(options.outboxDir, `${DIGEST}.json`),
          JSON.stringify({ task: "cli-flags", candidate: CANDIDATE, diff: "" }),
        )
      sse.frame("tool_result", { id: "call-3", name: "exportForReview", output: "exported" })
      sse.frame("done", { output: {} })
    }
    thread.resumeActive = false
    thread.status = "idle"
    sse.end()
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const body = await readBody(req)
    requests.push({ method: req.method ?? "", path: url.pathname, body })
    const parts = url.pathname.split("/").filter(Boolean)

    if (req.method === "POST" && url.pathname === "/threads") {
      const id = `fake-thread-${++counter}`
      const thread: Thread = {
        id,
        status: "idle",
        turns: 0,
        runActive: false,
        resumeActive: false,
        pending: null,
        endHang: null,
      }
      threads.set(id, thread)
      return json(res, 200, JSON.stringify({ thread_id: id, status: "idle", metadata: (body as { metadata?: unknown })?.metadata ?? {} }))
    }

    const thread = parts[0] === "threads" && parts[1] ? threads.get(parts[1]) : undefined
    if (!thread) return json(res, 404, errorBody("Thread not found", "thread_not_found"))
    const tail = parts.slice(2).join("/")

    if (req.method === "GET" && tail === "")
      return json(res, 200, JSON.stringify({ thread_id: thread.id, status: thread.status }))

    if (req.method === "GET" && tail === "pending_interrupts")
      return json(res, 200, JSON.stringify({ interrupts: thread.pending ? [thread.pending] : [] }))

    if (req.method === "POST" && tail === "runs/stream") {
      if (thread.runActive || thread.resumeActive) return json(res, 409, errorBody("Run in flight", "run_in_flight"))
      thread.runActive = true
      thread.status = "busy"
      thread.turns += 1
      runStarted.get(thread.id)?.()
      const sse = new Sse(res)
      if (thread.turns === 1) await streamTurnOne(thread, sse)
      else await streamTurnTwo(thread, sse)
      return
    }

    if (req.method === "GET" && tail === "runs/stream") {
      const sse = new Sse(res)
      sse.frame("state", {
        status: thread.status,
        live: thread.runActive,
        interrupts: thread.pending ? [thread.pending] : [],
      })
      if (!thread.runActive) return sse.end()
      await new Promise<void>((resolve) => {
        const previous = thread.endHang
        thread.endHang = () => {
          previous?.()
          sse.frame("done", { output: { cancelled: true } })
          resolve()
        }
      })
      return sse.end()
    }

    if (req.method === "POST" && tail === "resume") {
      const request = body as { resume?: { interruptId: string; status: string; payload?: string }[]; route?: string }
      if (!Array.isArray(request?.resume) || typeof request.route !== "string")
        return json(res, 400, errorBody("Malformed resume body"))
      if (thread.resumeActive) return json(res, 409, errorBody("Resume in progress", "resume_in_progress"))
      if (thread.runActive) return json(res, 409, errorBody("Run in flight", "run_in_flight"))
      const pendingIds = thread.pending ? [thread.pending.interruptId] : []
      const givenIds = request.resume.map((r) => r.interruptId)
      if (pendingIds.length !== givenIds.length || pendingIds.some((id) => !givenIds.includes(id)))
        return json(res, 409, errorBody("Resume set does not match pending interrupts", "interrupt_mismatch"))
      const entry = request.resume[0]
      const payload = entry?.status === "cancelled" ? "deny" : (entry?.payload ?? "deny")
      const sse = new Sse(res)
      await streamResume(thread, sse, payload)
      return
    }

    if (req.method === "POST" && tail === "cancel") {
      if (!thread.runActive) return json(res, 409, errorBody("No run in flight", "no_run_in_flight"))
      thread.endHang?.()
      thread.runActive = false
      thread.status = "interrupted"
      return json(res, 200, JSON.stringify({ thread_id: thread.id, status: "interrupted" }))
    }

    return json(res, 404, errorBody("Not found"))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (typeof address !== "object" || address === null) throw new Error("fake worker did not bind")

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    digest: DIGEST,
    candidate: CANDIDATE,
    requests,
    behaviour,
    thread: (id) => threads.get(id),
    waitForRunStart(threadId) {
      const thread = threads.get(threadId)
      if (thread?.runActive) return Promise.resolve()
      return new Promise((resolve) => runStarted.set(threadId, resolve))
    },
    async close() {
      for (const thread of threads.values()) thread.endHang?.()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
```

- [ ] **Step 4: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test fake-worker`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/server/test/fake-worker.ts examples/software-factory/server/test/fake-worker.test.ts
git commit -m "test(software-factory): scripted fake Agent Protocol worker"
```

---

### Task 10: Worker HTTP client

**Files:**
- Create: `src/worker/client.ts`, `test/worker-client.test.ts`

- [ ] **Step 1: Write the failing test** (against the fake from Task 9)

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type WorkerClient, WorkerHttpError, createHttpWorkerClient } from "../src/worker/client.ts"
import { type FakeWorker, createFakeWorker } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
let client: WorkerClient
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-client-"))
  fake = await createFakeWorker({ outboxDir: dir })
  client = createHttpWorkerClient(fake.baseUrl)
})
afterEach(async () => {
  await fake.close()
  rmSync(dir, { recursive: true, force: true })
})

async function drain<T>(frames: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const frame of frames) out.push(frame)
  return out
}

describe("http worker client", () => {
  it("creates a thread with metadata and reads it back", async () => {
    const threadId = await client.createThread({ factoryWorkOrderId: "wo-1" })
    expect(threadId).toMatch(/^fake-thread-/)
    expect(await client.getThread(threadId)).toEqual({ threadId, status: "idle" })
    expect(await client.getThread("nope")).toBeNull()
    expect(fake.requests[0]?.body).toEqual({ metadata: { factoryWorkOrderId: "wo-1" } })
  })

  it("streams a turn, reads the pending gate, resumes, and cancels with the documented codes", async () => {
    const threadId = await client.createThread({})
    const turnOne = await drain(await client.startRun(threadId, "/fix#agent", "go"))
    expect(turnOne.map((f) => f.event)).toEqual(["tool_result", "tool_result", "chunk", "done"])
    expect(fake.requests.at(-1)?.body).toEqual({
      route: "/fix#agent",
      input: { messages: [{ role: "user", content: "go" }] },
    })
    expect(await client.pendingInterrupts(threadId)).toEqual([])
    expect(await client.cancel(threadId)).toBe("no_run_in_flight")

    await drain(await client.startRun(threadId, "/fix#agent", "export"))
    const pending = await client.pendingInterrupts(threadId)
    expect(pending).toHaveLength(1)
    const resumed = await drain(
      await client.resume(threadId, "/fix#agent", [{ interruptId: pending[0]!.interruptId, payload: "once" }]),
    )
    expect(resumed.at(-1)?.event).toBe("done")
    expect(fake.requests.at(-1)?.body).toEqual({
      resume: [{ interruptId: pending[0]!.interruptId, status: "resolved", payload: "once" }],
      route: "/fix#agent",
    })
    expect(await client.cancel("nope")).toBe("thread_not_found")
  })

  it("surfaces other errors with status and code", async () => {
    const threadId = await client.createThread({})
    await expect(client.resume(threadId, "/fix#agent", [])).rejects.toMatchObject({
      name: "WorkerHttpError",
      status: 409,
      code: "interrupt_mismatch",
    } satisfies Partial<WorkerHttpError>)
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test worker-client`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/worker/client.ts`**

```ts
import { parseSse } from "./sse.js"
import {
  CancelResponseSchema,
  ErrorBodySchema,
  type InterruptFrame,
  PendingInterruptsSchema,
  type StreamFrame,
  ThreadSchema,
} from "./wire.js"

export type ResumePayload = "once" | "deny"

export interface Resolution {
  readonly interruptId: string
  readonly payload: ResumePayload
}

export type CancelResult = "interrupted" | "no_run_in_flight" | "thread_not_found"

/** The seven Agent Protocol calls the controller uses. Nothing else is reachable through this type. */
export interface WorkerClient {
  createThread(metadata: Record<string, unknown>): Promise<string>
  startRun(threadId: string, route: string, content: string, signal?: AbortSignal): Promise<AsyncIterable<StreamFrame>>
  reattach(threadId: string, signal?: AbortSignal): Promise<AsyncIterable<StreamFrame>>
  pendingInterrupts(threadId: string): Promise<InterruptFrame[]>
  resume(
    threadId: string,
    route: string,
    resolutions: readonly Resolution[],
    signal?: AbortSignal,
  ): Promise<AsyncIterable<StreamFrame>>
  cancel(threadId: string): Promise<CancelResult>
  getThread(threadId: string): Promise<{ threadId: string; status: string } | null>
}

export class WorkerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(`Worker responded ${status}${code ? ` (${code})` : ""}: ${message}`)
    this.name = "WorkerHttpError"
  }
}

async function toError(response: Response): Promise<WorkerHttpError> {
  const text = await response.text()
  let message = text
  let code: string | undefined
  try {
    const body = ErrorBodySchema.parse(JSON.parse(text))
    message = body.error.message
    const detailCode = body.error.details?.code
    code = typeof detailCode === "string" ? detailCode : undefined
  } catch {
    // Non-JSON error body: keep the raw text.
  }
  return new WorkerHttpError(response.status, code, message)
}

export function createHttpWorkerClient(baseUrl: string, fetchImpl: typeof fetch = fetch): WorkerClient {
  const base = baseUrl.replace(/\/$/, "")
  const threadPath = (threadId: string, tail = "") =>
    `${base}/threads/${encodeURIComponent(threadId)}${tail}`

  async function jsonRequest(url: string, init: RequestInit): Promise<Response> {
    const response = await fetchImpl(url, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    })
    if (!response.ok) throw await toError(response)
    return response
  }

  async function streamRequest(url: string, init: RequestInit): Promise<AsyncIterable<StreamFrame>> {
    const response = await jsonRequest(url, init)
    if (!response.body) throw new WorkerHttpError(response.status, undefined, "Stream had no body")
    return parseSse(response.body)
  }

  return {
    async createThread(metadata) {
      const response = await jsonRequest(`${base}/threads`, {
        method: "POST",
        body: JSON.stringify({ metadata }),
      })
      return ThreadSchema.parse(await response.json()).thread_id
    },
    startRun(threadId, route, content, signal) {
      return streamRequest(threadPath(threadId, "/runs/stream"), {
        method: "POST",
        body: JSON.stringify({ route, input: { messages: [{ role: "user", content }] } }),
        ...(signal ? { signal } : {}),
      })
    },
    reattach(threadId, signal) {
      return streamRequest(threadPath(threadId, "/runs/stream"), {
        method: "GET",
        ...(signal ? { signal } : {}),
      })
    },
    async pendingInterrupts(threadId) {
      const response = await jsonRequest(threadPath(threadId, "/pending_interrupts"), { method: "GET" })
      return PendingInterruptsSchema.parse(await response.json()).interrupts
    },
    resume(threadId, route, resolutions, signal) {
      return streamRequest(threadPath(threadId, "/resume"), {
        method: "POST",
        body: JSON.stringify({
          resume: resolutions.map((r) => ({ interruptId: r.interruptId, status: "resolved", payload: r.payload })),
          route,
        }),
        ...(signal ? { signal } : {}),
      })
    },
    async cancel(threadId) {
      const response = await fetchImpl(threadPath(threadId, "/cancel"), { method: "POST" })
      if (response.ok) {
        CancelResponseSchema.parse(await response.json())
        return "interrupted"
      }
      const error = await toError(response)
      if (error.status === 404) return "thread_not_found"
      if (error.status === 409 && error.code === "no_run_in_flight") return "no_run_in_flight"
      throw error
    },
    async getThread(threadId) {
      const response = await fetchImpl(threadPath(threadId), { method: "GET" })
      if (response.status === 404) return null
      if (!response.ok) throw await toError(response)
      const thread = ThreadSchema.parse(await response.json())
      return { threadId: thread.thread_id, status: thread.status }
    },
  }
}
```

- [ ] **Step 4: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test worker-client`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/server/src/worker/client.ts examples/software-factory/server/test/worker-client.test.ts
git commit -m "feat(software-factory): Agent Protocol worker client"
```

---

### Task 11: Turn consumer and budget ticker

**Files:**
- Create: `src/controller/turns.ts`, `src/controller/budget.ts`, `test/turns.test.ts`, `test/budget.test.ts`

- [ ] **Step 1: Write the failing turns test**

```ts
import { describe, expect, it } from "vitest"
import { consumeTurn } from "../src/controller/turns.ts"
import type { StreamFrame } from "../src/worker/wire.ts"

async function* frames(list: StreamFrame[], failAfter?: number): AsyncGenerator<StreamFrame> {
  let index = 0
  for (const frame of list) {
    if (failAfter !== undefined && index === failAfter) throw new Error("socket hang up")
    index += 1
    yield frame
  }
}

const gate = {
  interruptId: "perm-1",
  type: "permission-request",
  kind: "tool",
  detail: { toolName: "exportForReview", argsPreview: "{}", suggestedPattern: "exportForReview" },
}

describe("consumeTurn", () => {
  it("dispatches frames to handlers in order and reports a clean end", async () => {
    const seen: string[] = []
    const result = await consumeTurn(
      frames([
        { event: "tool_result", data: { name: "prepareReview", output: "{}" } },
        { event: "interrupt", data: gate },
        { event: "chunk", data: "text" },
        { event: "done", data: { output: {} } },
      ]),
      {
        onFirstFrame: async () => void seen.push("first"),
        onToolResult: async (name) => void seen.push(`tool:${name}`),
        onInterrupt: async (frame) => void seen.push(`interrupt:${frame.interruptId}`),
        onDone: async () => void seen.push("done"),
      },
    )
    expect(seen).toEqual(["first", "tool:prepareReview", "interrupt:perm-1", "done"])
    expect(result).toEqual({ ended: "done", interrupts: [expect.objectContaining({ interruptId: "perm-1" })] })
  })

  it("reports a lost stream without throwing", async () => {
    const result = await consumeTurn(frames([{ event: "chunk", data: "x" }, { event: "done", data: {} }], 1), {})
    expect(result.ended).toBe("lost")
    expect(result.error).toMatch(/socket hang up/)
  })

  it("ignores malformed interrupt frames but records them", async () => {
    const result = await consumeTurn(frames([{ event: "interrupt", data: { nope: true } }, { event: "done", data: {} }]), {})
    expect(result.interrupts).toEqual([])
    expect(result.malformed).toBe(1)
  })
})
```

- [ ] **Step 2: Write the failing budget test**

```ts
import { describe, expect, it } from "vitest"
import { startBudgetTicker } from "../src/controller/budget.ts"
import type { WorkOrderRow } from "../src/domain/work-order.ts"
import { openRegistry } from "../src/registry/db.ts"
import { createWorkOrderStore } from "../src/registry/work-orders.ts"

function row(overrides: Partial<WorkOrderRow>): WorkOrderRow {
  return {
    id: "wo-1",
    revision: 0,
    state: "running",
    taskId: "cli-flags",
    workerRoute: "/fix#agent",
    workerThreadId: "t-1",
    candidateDigest: null,
    candidateVerified: null,
    blockedReason: null,
    failureReason: null,
    maxCandidateAttempts: 1,
    maxActiveMs: 1_000,
    activeMs: 0,
    activeStartedAt: "2026-09-16T00:00:00.000Z",
    candidateReadyAt: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  }
}

describe("budget ticker", () => {
  it("fires once for an active work order over its limit and never for inactive ones", async () => {
    const store = createWorkOrderStore(openRegistry(":memory:").db)
    store.insert(row({ id: "over" }))
    store.insert(row({ id: "under", activeMs: 0, maxActiveMs: 10_000_000 }))
    store.insert(row({ id: "parked", state: "candidate_ready", activeStartedAt: null, activeMs: 999_999 }))
    const fired: string[] = []
    let now = Date.parse("2026-09-16T00:00:02.000Z")
    const ticker = startBudgetTicker({
      store,
      now: () => now,
      tickMs: 5,
      onExhausted: async (id) => {
        fired.push(id)
        store.update(id, 0, { state: "cancel_requested" }, new Date(now).toISOString())
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    now += 5
    await new Promise((resolve) => setTimeout(resolve, 30))
    ticker.stop()
    expect(fired).toEqual(["over"])
  })
})
```

- [ ] **Step 3: Run both**

Run: `pnpm --filter @b4-example/software-factory-server test turns budget`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `src/controller/turns.ts`**

```ts
import {
  type InterruptFrame,
  InterruptFrameSchema,
  type StreamFrame,
  ToolResultFrameSchema,
} from "../worker/wire.js"

export interface TurnHandlers {
  onFirstFrame?: () => Promise<void>
  onToolResult?: (name: string, output: unknown) => Promise<void>
  onInterrupt?: (frame: InterruptFrame) => Promise<void>
  onDone?: (data: unknown) => Promise<void>
}

export interface TurnResult {
  readonly ended: "done" | "lost"
  readonly interrupts: InterruptFrame[]
  readonly error?: string
  readonly malformed?: number
}

/**
 * Drive one Server-Sent Events turn to its end. Handler errors propagate; transport
 * errors are reported as `ended: "lost"` so the caller can reconcile instead of guessing.
 */
export async function consumeTurn(frames: AsyncIterable<StreamFrame>, handlers: TurnHandlers): Promise<TurnResult> {
  const interrupts: InterruptFrame[] = []
  let malformed = 0
  let first = true
  let sawDone = false
  try {
    for await (const frame of frames) {
      if (first) {
        first = false
        await handlers.onFirstFrame?.()
      }
      if (frame.event === "tool_result") {
        const parsed = ToolResultFrameSchema.safeParse(frame.data)
        if (!parsed.success) {
          malformed += 1
          continue
        }
        await handlers.onToolResult?.(parsed.data.name, parsed.data.output)
      } else if (frame.event === "interrupt") {
        const parsed = InterruptFrameSchema.safeParse(frame.data)
        if (!parsed.success) {
          malformed += 1
          continue
        }
        interrupts.push(parsed.data)
        await handlers.onInterrupt?.(parsed.data)
      } else if (frame.event === "done") {
        sawDone = true
        await handlers.onDone?.(frame.data)
      }
    }
  } catch (error) {
    return { ended: "lost", interrupts, error: String(error), ...(malformed ? { malformed } : {}) }
  }
  if (!sawDone) return { ended: "lost", interrupts, error: "stream ended without a done frame", ...(malformed ? { malformed } : {}) }
  return { ended: "done", interrupts, ...(malformed ? { malformed } : {}) }
}
```

- [ ] **Step 5: Implement `src/controller/budget.ts`**

```ts
import { ACTIVE_STATES } from "../domain/states.js"
import type { WorkOrderRow } from "../domain/work-order.js"
import type { WorkOrderStore } from "../registry/work-orders.js"

export interface BudgetTicker {
  stop(): void
}

/** Active time so far: banked `activeMs` plus the open interval, if any. */
export function activeElapsedMs(row: WorkOrderRow, nowMs: number): number {
  const open = row.activeStartedAt ? Math.max(0, nowMs - Date.parse(row.activeStartedAt)) : 0
  return row.activeMs + open
}

export function startBudgetTicker(options: {
  readonly store: WorkOrderStore
  readonly now: () => number
  readonly tickMs: number
  readonly onExhausted: (id: string) => Promise<void>
}): BudgetTicker {
  const firing = new Set<string>()
  const timer = setInterval(() => {
    const nowMs = options.now()
    for (const row of options.store.list()) {
      if (!ACTIVE_STATES.has(row.state) || firing.has(row.id)) continue
      if (activeElapsedMs(row, nowMs) <= row.maxActiveMs) continue
      firing.add(row.id)
      void options.onExhausted(row.id).finally(() => firing.delete(row.id))
    }
  }, options.tickMs)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
```

- [ ] **Step 6: Run both**

Run: `pnpm --filter @b4-example/software-factory-server test turns budget`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add examples/software-factory/server/src/controller examples/software-factory/server/test/turns.test.ts examples/software-factory/server/test/budget.test.ts
git commit -m "feat(software-factory): turn consumer and active-time budget ticker"
```

---

### Task 12: Factory core: create, dispatch, turn 1

This task creates `src/controller/context.ts` (the internal contract shared with reconciliation) and `src/controller/factory.ts` with `create`, `dispatch`, the turn 1 observer, reads, `waitFor` and `close`. Tasks 13 to 15 add `approve`/`deny`, `cancel`/budget, and reconciliation to the same file; each shows the full code it adds.

**Files:**
- Create: `src/controller/context.ts`, `src/controller/factory.ts`, `test/factory-dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type Factory, createFactory } from "../src/controller/factory.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { type FakeWorker, type FakeWorkerOptions, createFakeWorker } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
let factory: Factory

async function boot(options: Omit<FakeWorkerOptions, "outboxDir"> = {}) {
  dir = mkdtempSync(join(tmpdir(), "factory-dispatch-"))
  fake = await createFakeWorker({ outboxDir: join(dir, "outbox"), ...options })
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    worker: createHttpWorkerClient(fake.baseUrl),
    workerRoute: "/fix#agent",
    outboxDir: join(dir, "outbox"),
  })
}
beforeEach(() => {
  // each test boots with its own behaviour
})
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

const settled = (state: string) =>
  ["candidate_ready", "blocked", "failed", "exported", "denied", "cancelled"].includes(state)

describe("create and dispatch", () => {
  it("runs turn 1 to candidate_ready and journals the order of events", async () => {
    await boot()
    const created = await factory.create({ taskId: "cli-flags" })
    expect(created.state).toBe("received")
    const outcome = await factory.dispatch(created.id)
    expect(outcome).toEqual({ ok: true, state: "dispatched", message: "Turn 1 dispatched" })
    const row = await factory.waitFor(created.id, (r) => settled(r.state))
    expect(row.state).toBe("candidate_ready")
    expect(row.candidateDigest).toBe(fake.digest)
    expect(row.candidateVerified).toBe(true)
    expect(row.candidateReadyAt).not.toBeNull()
    expect(row.activeStartedAt).toBeNull()
    const types = factory.events(created.id).map((e) => `${e.type}:${String(e.payload.event ?? "")}`)
    expect(types).toEqual([
      "created:",
      "thread_created:",
      "transition:dispatch_committed",
      "transition:run_started",
      "candidate_observed:",
      "transition:candidate_ready",
    ])
    expect(fake.requests.at(-1)?.body).toMatchObject({ input: { messages: [{ content: expect.stringContaining("Do not call exportForReview") }] } })
  })

  it("is idempotent per operation key and refuses dispatch from the wrong state", async () => {
    await boot()
    const created = await factory.create({ taskId: "cli-flags", operationKey: "create-1" })
    const again = await factory.create({ taskId: "cli-flags", operationKey: "create-1" })
    expect(again.id).toBe(created.id)
    const first = await factory.dispatch(created.id, "dispatch-1")
    const second = await factory.dispatch(created.id, "dispatch-1")
    expect(second).toEqual(first)
    expect(fake.requests.filter((r) => r.method === "POST" && r.path === "/threads")).toHaveLength(1)
    await factory.waitFor(created.id, (r) => settled(r.state))
    const refused = await factory.dispatch(created.id, "dispatch-2")
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/Cannot dispatch from candidate_ready/)
  })

  it("rejects unknown tasks", async () => {
    await boot()
    await expect(factory.create({ taskId: "nope" })).rejects.toThrow(/Unknown task/)
  })

  it("fails on a route error", async () => {
    await boot({ turnOne: "route_error" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => settled(r.state))
    expect(row.state).toBe("failed")
    expect(row.failureReason).toBe("route_error")
  })

  it("fails when the turn ends without a verified candidate", async () => {
    await boot({ turnOne: "no_candidate" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => settled(r.state))
    expect(row.state).toBe("failed")
    expect(row.failureReason).toBe("ended_without_candidate")
  })

  it("blocks on an unexpected interrupt kind and never resolves it", async () => {
    await boot({ turnOne: "unexpected_interrupt" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => settled(r.state))
    expect(row.state).toBe("blocked")
    expect(row.blockedReason).toBe("unexpected_interrupt")
    expect(fake.requests.some((r) => r.path.endsWith("/resume"))).toBe(false)
  })

  it("denies a premature export gate and still reaches candidate_ready", async () => {
    await boot({ turnOne: "premature_export" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => settled(r.state))
    expect(row.state).toBe("candidate_ready")
    const resumes = fake.requests.filter((r) => r.path.endsWith("/resume"))
    expect(resumes).toHaveLength(1)
    expect(resumes[0]?.body).toMatchObject({ resume: [{ payload: "deny" }] })
    expect(factory.events(id).map((e) => e.type)).toContain("premature_export_denied")
  })

  it("records a lost stream without changing state", async () => {
    await boot({ turnOne: "close_midway" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, () => factory.events(id).some((e) => e.type === "stream_lost"))
    const row = factory.show(id)
    expect(row?.state).toBe("running")
    expect(row?.candidateDigest).toBe(fake.digest)
  })
})
```

The last test pins the pre-reconciliation behaviour; Task 15 changes its expectation to `candidate_ready`.

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test factory-dispatch`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/controller/context.ts`**

```ts
import type { TransitionEvent } from "../domain/states.js"
import type { WorkOrderRow } from "../domain/work-order.js"
import type { CommandLog } from "../registry/commands.js"
import type { WorkOrderPatch, WorkOrderStore } from "../registry/work-orders.js"
import type { WorkerClient } from "../worker/client.js"
import type { StreamFrame } from "../worker/wire.js"

/** What reconciliation and the turn observers need from the factory. Kept narrow on purpose. */
export interface ControllerContext {
  readonly store: WorkOrderStore
  readonly commands: CommandLog
  readonly worker: WorkerClient
  readonly workerRoute: string
  readonly outboxDir: string
  readonly receiptWaitMs: number
  readonly signal: AbortSignal
  now(): number
  iso(): string
  require(id: string): WorkOrderRow
  recordEvent(id: string, type: string, payload?: Record<string, unknown>): void
  /** Compare-and-swap transition with active-time accounting. Throws on an illegal or stale move. */
  transition(id: string, event: TransitionEvent, patch?: WorkOrderPatch, payload?: Record<string, unknown>): WorkOrderRow
  /** Observe a turn 1 stream to its end, applying turn 1 rules. */
  observeTurnOne(id: string, frames: AsyncIterable<StreamFrame>): Promise<void>
  /** Resolve the pending exportForReview gate with `once`, then wait for the receipt. Ends in exported or blocked. */
  confirmExport(id: string): Promise<void>
  /** Resolve every pending interrupt on the work order's thread with `deny`. */
  denyPending(id: string): Promise<void>
  /** Wait until the tracked background run for `id` (if any) has settled. */
  settleRun(id: string, timeoutMs: number): Promise<void>
  /** Track a background run so close() and cancel can wait for it. */
  track(id: string, run: Promise<void>): void
}
```

- [ ] **Step 4: Implement `src/controller/factory.ts`**

```ts
import { createHash, randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { ACTIVE_STATES, type TransitionEvent, nextState } from "../domain/states.js"
import type { CommandOutcome, FactoryEvent, WorkOrderRow } from "../domain/work-order.js"
import { TURN_ONE_PROMPTS } from "../prompts.js"
import { type CommandLog, createCommandLog } from "../registry/commands.js"
import { openRegistry } from "../registry/db.js"
import { type WorkOrderPatch, createWorkOrderStore } from "../registry/work-orders.js"
import type { WorkerClient } from "../worker/client.js"
import {
  type InterruptFrame,
  PREPARE_TOOL,
  type StreamFrame,
  classifyDone,
  isExportGate,
  parsePrepareReviewOutput,
} from "../worker/wire.js"
import type { ControllerContext } from "./context.js"
import { consumeTurn } from "./turns.js"

export interface FactoryOptions {
  readonly registryPath: string
  readonly worker: WorkerClient
  readonly workerRoute: string
  readonly outboxDir: string
  /** Task id to turn 1 prompt. Defaults to TURN_ONE_PROMPTS. */
  readonly tasks?: Readonly<Record<string, string>>
  readonly approvalTtlMs?: number
  readonly maxActiveMs?: number
  readonly receiptWaitMs?: number
  readonly budgetTickMs?: number
  readonly now?: () => number
  readonly actor?: string
  readonly log?: (event: string, payload: Record<string, unknown>) => void
}

export interface Factory {
  create(input: { taskId: string; operationKey?: string }): Promise<WorkOrderRow>
  dispatch(id: string, operationKey?: string): Promise<CommandOutcome>
  approve(id: string, input: { revision: number; candidateDigest: string; operationKey?: string }): Promise<CommandOutcome>
  deny(id: string, operationKey?: string): Promise<CommandOutcome>
  cancel(id: string, operationKey?: string): Promise<CommandOutcome>
  show(id: string): WorkOrderRow | null
  list(): WorkOrderRow[]
  events(id: string): FactoryEvent[]
  waitFor(id: string, predicate: (row: WorkOrderRow) => boolean, timeoutMs?: number): Promise<WorkOrderRow>
  close(): Promise<void>
}

export class CommandInFlightError extends Error {
  constructor(readonly operationKey: string) {
    super(`Command ${operationKey} is still in flight; restart the factory to reconcile it`)
    this.name = "CommandInFlightError"
  }
}

export class UnknownTaskError extends Error {
  constructor(taskId: string) {
    super(`Unknown task ${taskId}`)
    this.name = "UnknownTaskError"
  }
}

export class UnknownWorkOrderError extends Error {
  constructor(id: string) {
    super(`Unknown work order ${id}`)
    this.name = "UnknownWorkOrderError"
  }
}

const isTurnOneState = (state: WorkOrderRow["state"]) => state === "dispatched" || state === "running"

export async function createFactory(options: FactoryOptions): Promise<Factory> {
  const registry = openRegistry(options.registryPath)
  const store = createWorkOrderStore(registry.db)
  const commands: CommandLog = createCommandLog(registry.db)
  const tasks = options.tasks ?? TURN_ONE_PROMPTS
  const now = options.now ?? Date.now
  const iso = () => new Date(now()).toISOString()
  const log = options.log ?? (() => {})
  const abort = new AbortController()
  const runs = new Map<string, Promise<void>>()

  const require = (id: string): WorkOrderRow => {
    const row = store.get(id)
    if (!row) throw new UnknownWorkOrderError(id)
    return row
  }

  const recordEvent = (id: string, type: string, payload: Record<string, unknown> = {}) => {
    store.appendEvent(id, type, payload, iso())
    log(type, { id, ...payload })
  }

  const transition = (
    id: string,
    event: TransitionEvent,
    patch: WorkOrderPatch = {},
    payload: Record<string, unknown> = {},
  ): WorkOrderRow =>
    store.transaction(() => {
      const row = require(id)
      const to = nextState(row.state, event)
      const accounting: WorkOrderPatch = {}
      const wasActive = ACTIVE_STATES.has(row.state)
      const willBeActive = ACTIVE_STATES.has(to)
      if (wasActive && !willBeActive) {
        const open = row.activeStartedAt ? Math.max(0, now() - Date.parse(row.activeStartedAt)) : 0
        accounting.activeMs = row.activeMs + open
        accounting.activeStartedAt = null
      } else if (!wasActive && willBeActive) {
        accounting.activeStartedAt = iso()
      }
      const updated = store.update(id, row.revision, { ...accounting, ...patch, state: to }, iso())
      recordEvent(id, "transition", { event, from: row.state, to, ...payload })
      return updated
    })

  const finish = (operationKey: string, outcome: CommandOutcome): CommandOutcome => {
    commands.complete(operationKey, outcome)
    return outcome
  }

  const track = (id: string, run: Promise<void>) => {
    const tracked = run
      .catch((error) => recordEvent(id, "run_observer_error", { error: String(error) }))
      .finally(() => {
        if (runs.get(id) === tracked) runs.delete(id)
      })
    runs.set(id, tracked)
  }

  const settleRun = async (id: string, timeoutMs: number) => {
    const run = runs.get(id)
    if (!run) return
    await Promise.race([run, sleep(timeoutMs)])
  }

  const denyPending = async (id: string) => {
    const row = require(id)
    if (!row.workerThreadId) return
    const pending = await ctx.worker.pendingInterrupts(row.workerThreadId)
    if (pending.length === 0) return
    recordEvent(id, "pending_denied", { interruptIds: pending.map((p) => p.interruptId) })
    const frames = await ctx.worker.resume(
      row.workerThreadId,
      options.workerRoute,
      pending.map((p) => ({ interruptId: p.interruptId, payload: "deny" as const })),
      abort.signal,
    )
    await consumeTurn(frames, {})
  }

  async function observeTurnOne(id: string, frames: AsyncIterable<StreamFrame>): Promise<void> {
    let stream = frames
    while (true) {
      let prematureGate: InterruptFrame | null = null
      const result = await consumeTurn(stream, {
        onFirstFrame: async () => {
          if (require(id).state === "dispatched") transition(id, "run_started")
        },
        onToolResult: async (name, output) => {
          if (name !== PREPARE_TOOL) return
          const row = require(id)
          if (!isTurnOneState(row.state)) return
          try {
            const parsed = parsePrepareReviewOutput(output)
            store.update(
              id,
              row.revision,
              { candidateDigest: parsed.candidate.receiptDigest, candidateVerified: parsed.verification.passed },
              iso(),
            )
            recordEvent(id, "candidate_observed", {
              digest: parsed.candidate.receiptDigest,
              verified: parsed.verification.passed,
              candidate: parsed.candidate,
            })
          } catch (error) {
            recordEvent(id, "candidate_unparseable", { error: String(error) })
          }
        },
        onInterrupt: async (frame) => {
          const row = require(id)
          if (!isTurnOneState(row.state)) return
          if (isExportGate(frame)) {
            prematureGate = frame
            return
          }
          transition(
            id,
            "unexpected_interrupt",
            { blockedReason: "unexpected_interrupt" },
            { interruptId: frame.interruptId, kind: frame.kind },
          )
        },
        onDone: async (data) => {
          const row = require(id)
          if (!isTurnOneState(row.state) || prematureGate) return
          const { error, cancelled } = classifyDone(data)
          if (cancelled) return
          if (error) {
            transition(id, "run_failed", { failureReason: "route_error" }, { error })
            return
          }
          if (row.candidateVerified === true) transition(id, "candidate_ready", { candidateReadyAt: iso() })
          else
            transition(
              id,
              "run_ended_without_candidate",
              { failureReason: "ended_without_candidate" },
              { verified: row.candidateVerified },
            )
        },
      })
      if (result.ended === "lost") {
        recordEvent(id, "stream_lost", { phase: "turn_one", error: result.error ?? null })
        return
      }
      if (!prematureGate) return
      const gate: InterruptFrame = prematureGate
      const row = require(id)
      if (!row.workerThreadId || !isTurnOneState(row.state)) return
      recordEvent(id, "premature_export_denied", { interruptId: gate.interruptId })
      try {
        stream = await ctx.worker.resume(
          row.workerThreadId,
          options.workerRoute,
          [{ interruptId: gate.interruptId, payload: "deny" }],
          abort.signal,
        )
      } catch (error) {
        recordEvent(id, "stream_lost", { phase: "premature_deny", error: String(error) })
        return
      }
    }
  }

  async function confirmExport(_id: string): Promise<void> {
    throw new Error("confirmExport is implemented in Task 13")
  }

  const ctx: ControllerContext = {
    store,
    commands,
    worker: options.worker,
    workerRoute: options.workerRoute,
    outboxDir: options.outboxDir,
    receiptWaitMs: options.receiptWaitMs ?? 180_000,
    signal: abort.signal,
    now,
    iso,
    require,
    recordEvent,
    transition,
    observeTurnOne,
    confirmExport,
    denyPending,
    settleRun,
    track,
  }

  async function startTurnOne(id: string): Promise<void> {
    const row = require(id)
    if (!row.workerThreadId) return
    let frames: AsyncIterable<StreamFrame>
    try {
      frames = await ctx.worker.startRun(row.workerThreadId, options.workerRoute, tasks[row.taskId] ?? "", abort.signal)
    } catch (error) {
      recordEvent(id, "stream_lost", { phase: "turn_one_start", error: String(error) })
      return
    }
    await observeTurnOne(id, frames)
  }

  const factory: Factory = {
    async create({ taskId, operationKey }) {
      if (!(taskId in tasks)) throw new UnknownTaskError(taskId)
      const id = operationKey
        ? `wo-${createHash("sha256").update(operationKey).digest("hex").slice(0, 16)}`
        : `wo-${randomUUID()}`
      const key = operationKey ?? `create:${id}`
      const begun = commands.begin(key, id, { command: "create", args: { taskId } }, iso())
      if (begun.status === "done") return require(id)
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      const at = iso()
      const row: WorkOrderRow = {
        id,
        revision: 0,
        state: "received",
        taskId,
        workerRoute: options.workerRoute,
        workerThreadId: null,
        candidateDigest: null,
        candidateVerified: null,
        blockedReason: null,
        failureReason: null,
        maxCandidateAttempts: 1,
        maxActiveMs: options.maxActiveMs ?? 1_200_000,
        activeMs: 0,
        activeStartedAt: null,
        candidateReadyAt: null,
        createdAt: at,
        updatedAt: at,
      }
      store.transaction(() => {
        store.insert(row)
        recordEvent(id, "created", { taskId })
        commands.complete(key, { ok: true, state: "received", message: "Created" })
      })
      return row
    },

    async dispatch(id, operationKey) {
      const row = require(id)
      const key = operationKey ?? `dispatch:${id}:${row.revision}`
      const begun = commands.begin(key, id, { command: "dispatch", args: {} }, iso())
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      if (row.state !== "received")
        return finish(key, { ok: false, state: row.state, message: `Cannot dispatch from ${row.state}` })
      let threadId: string
      try {
        threadId = await ctx.worker.createThread({ factoryWorkOrderId: id })
      } catch (error) {
        return finish(key, { ok: false, state: row.state, message: `Thread creation failed: ${String(error)}` })
      }
      recordEvent(id, "thread_created", { threadId })
      const dispatched = transition(id, "dispatch_committed", { workerThreadId: threadId })
      const outcome = finish(key, { ok: true, state: dispatched.state, message: "Turn 1 dispatched" })
      track(id, startTurnOne(id))
      return outcome
    },

    async approve() {
      throw new Error("approve is implemented in Task 13")
    },
    async deny() {
      throw new Error("deny is implemented in Task 13")
    },
    async cancel() {
      throw new Error("cancel is implemented in Task 14")
    },

    show: (id) => store.get(id),
    list: () => store.list(),
    events: (id) => store.events(id),

    async waitFor(id, predicate, timeoutMs = 10_000) {
      const deadline = now() + timeoutMs
      while (true) {
        const row = require(id)
        if (predicate(row)) return row
        if (now() >= deadline) throw new Error(`Timed out waiting for ${id}; state is ${row.state}`)
        await sleep(20)
      }
    },

    async close() {
      abort.abort()
      await Promise.allSettled([...runs.values()])
      registry.close()
    },
  }

  return factory
}
```

The three `throw new Error("... implemented in Task N")` bodies are removed by those tasks; they exist so this task typechecks and its tests run. No other placeholder is allowed to survive Task 15.

- [ ] **Step 5: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test factory-dispatch`
Expected: PASS, 8 tests.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm --filter @b4-example/software-factory-server typecheck && pnpm --filter @b4-example/software-factory-server lint`
Expected: both clean. If biome complains about `require` shadowing, rename the local to `mustGet` consistently in this file and in Tasks 13 to 15.

- [ ] **Step 7: Commit**

```bash
git add examples/software-factory/server/src/controller examples/software-factory/server/test/factory-dispatch.test.ts
git commit -m "feat(software-factory): factory core with create, dispatch and turn 1 observer"
```

---

### Task 13: Approve, turn 2, export confirmation, deny

**Files:**
- Modify: `src/controller/factory.ts` (replace the `confirmExport`, `approve`, `deny` bodies)
- Create: `test/factory-approve.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type Factory, createFactory } from "../src/controller/factory.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { type FakeWorker, type FakeWorkerOptions, createFakeWorker } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
let factory: Factory
let nowMs = Date.parse("2026-09-16T10:00:00.000Z")

async function boot(options: Omit<FakeWorkerOptions, "outboxDir"> = {}) {
  dir = mkdtempSync(join(tmpdir(), "factory-approve-"))
  fake = await createFakeWorker({ outboxDir: join(dir, "outbox"), ...options })
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    worker: createHttpWorkerClient(fake.baseUrl),
    workerRoute: "/fix#agent",
    outboxDir: join(dir, "outbox"),
    approvalTtlMs: 60_000,
    receiptWaitMs: 2_000,
    now: () => nowMs,
  })
}
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

async function ready() {
  const { id } = await factory.create({ taskId: "cli-flags" })
  await factory.dispatch(id)
  return factory.waitFor(id, (r) => r.state === "candidate_ready")
}

const resumes = () => fake.requests.filter((r) => r.path.endsWith("/resume"))
const turns = () => fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/runs/stream"))

describe("approve", () => {
  it("starts turn 2, resolves the gate with once, and confirms the receipt", async () => {
    await boot()
    const row = await ready()
    const outcome = await factory.approve(row.id, { revision: row.revision, candidateDigest: row.candidateDigest! })
    expect(outcome).toEqual({ ok: true, state: "exported", message: "Exported" })
    expect(turns()).toHaveLength(2)
    expect(turns()[1]?.body).toMatchObject({ input: { messages: [{ content: expect.stringContaining(fake.digest) }] } })
    expect(resumes()).toHaveLength(1)
    expect(resumes()[0]?.body).toMatchObject({ resume: [{ payload: "once" }] })
    expect(readdirSync(join(dir, "outbox"))).toEqual([`${fake.digest}.json`])
    const final = factory.show(row.id)!
    expect(final.state).toBe("exported")
    expect(final.activeStartedAt).toBeNull()
    expect(factory.events(row.id).map((e) => e.type)).toContain("delivery_observed")
  })

  it("refuses a stale revision, a wrong digest, and an expired candidate without touching the worker", async () => {
    await boot()
    const row = await ready()
    const before = fake.requests.length
    const stale = await factory.approve(row.id, { revision: row.revision - 1, candidateDigest: row.candidateDigest! })
    expect(stale).toMatchObject({ ok: false, message: expect.stringMatching(/revision/) })
    const wrong = await factory.approve(row.id, { revision: row.revision, candidateDigest: "f".repeat(64) })
    expect(wrong).toMatchObject({ ok: false, message: expect.stringMatching(/digest/) })
    nowMs += 61_000
    const expired = await factory.approve(row.id, { revision: row.revision, candidateDigest: row.candidateDigest! })
    expect(expired).toMatchObject({ ok: false, message: expect.stringMatching(/expired/) })
    expect(fake.requests.length).toBe(before)
    expect(factory.show(row.id)).toMatchObject({ state: "candidate_ready", revision: row.revision })
  })

  it("is idempotent per operation key", async () => {
    await boot()
    const row = await ready()
    const input = { revision: row.revision, candidateDigest: row.candidateDigest!, operationKey: "approve-1" }
    const first = await factory.approve(row.id, input)
    const second = await factory.approve(row.id, input)
    expect(second).toEqual(first)
    expect(turns()).toHaveLength(2)
    expect(resumes()).toHaveLength(1)
  })

  it("blocks with export_unconfirmed when the export turn fails", async () => {
    await boot({ turnTwo: "route_error" })
    const row = await ready()
    const outcome = await factory.approve(row.id, { revision: row.revision, candidateDigest: row.candidateDigest! })
    expect(outcome).toMatchObject({ ok: false, state: "blocked" })
    expect(factory.show(row.id)?.blockedReason).toBe("export_unconfirmed")
  })

  it("blocks with export_unconfirmed when no receipt appears", async () => {
    await boot({ resume: "no_receipt" })
    const row = await ready()
    const outcome = await factory.approve(row.id, { revision: row.revision, candidateDigest: row.candidateDigest! })
    expect(outcome).toMatchObject({ ok: false, state: "blocked" })
    expect(factory.show(row.id)?.blockedReason).toBe("export_unconfirmed")
  })
})

describe("deny", () => {
  it("denies from candidate_ready without any worker call", async () => {
    await boot()
    const row = await ready()
    const before = fake.requests.length
    const outcome = await factory.deny(row.id)
    expect(outcome).toEqual({ ok: true, state: "denied", message: "Denied" })
    expect(fake.requests.length).toBe(before)
    expect(readdirSync(join(dir, "outbox"))).toEqual([])
  })

  it("denies from blocked by resolving the pending interrupt with deny", async () => {
    await boot({ turnOne: "unexpected_interrupt" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "blocked")
    const outcome = await factory.deny(id)
    expect(outcome.state).toBe("denied")
    expect(resumes()).toHaveLength(1)
    expect(resumes()[0]?.body).toMatchObject({ resume: [{ payload: "deny" }] })
  })

  it("refuses deny from running", async () => {
    await boot({ turnOne: "hang" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    const outcome = await factory.deny(id)
    expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/Cannot deny from running/) })
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test factory-approve`
Expected: FAIL, "approve is implemented in Task 13".

- [ ] **Step 3: Add imports to `src/controller/factory.ts`**

Add to the existing import block:

```ts
import { turnTwoPrompt } from "../prompts.js"
import { receiptPath, waitForReceipt } from "../worker/outbox.js"
```

and change the existing `import { TURN_ONE_PROMPTS } from "../prompts.js"` to `import { TURN_ONE_PROMPTS, turnTwoPrompt } from "../prompts.js"` (one import line, not two).

- [ ] **Step 4: Replace `confirmExport` in `src/controller/factory.ts`**

```ts
  /**
   * The worker's exportForReview gate is resolved here and in reconciliation only, and only
   * for an `exporting` work order that already has an approval row for its digest.
   */
  async function confirmExport(id: string): Promise<void> {
    const row = require(id)
    if (row.state !== "exporting" || !row.workerThreadId || !row.candidateDigest) return
    const approved = store.approvals(id).some((a) => a.decision === "approved" && a.candidateDigest === row.candidateDigest)
    if (!approved) {
      transition(id, "export_unconfirmed", { blockedReason: "export_unconfirmed" }, { reason: "no approval row" })
      return
    }
    const threadId = row.workerThreadId
    const digest = row.candidateDigest

    const block = (reason: string, extra: Record<string, unknown> = {}) => {
      if (require(id).state === "exporting")
        transition(id, "export_unconfirmed", { blockedReason: "export_unconfirmed" }, { reason, ...extra })
    }

    let pending: InterruptFrame[]
    try {
      pending = await ctx.worker.pendingInterrupts(threadId)
    } catch (error) {
      block("pending_interrupts failed", { error: String(error) })
      return
    }
    if (pending.length === 1 && pending[0] && isExportGate(pending[0])) {
      recordEvent(id, "export_gate_resolved", { interruptId: pending[0].interruptId })
      let frames: AsyncIterable<StreamFrame>
      try {
        frames = await ctx.worker.resume(threadId, options.workerRoute, [{ interruptId: pending[0].interruptId, payload: "once" }], abort.signal)
      } catch (error) {
        block("resume failed", { error: String(error) })
        return
      }
      let routeError: string | null = null
      const result = await consumeTurn(frames, {
        onDone: async (data) => {
          routeError = classifyDone(data).error
        },
      })
      if (result.ended === "lost") recordEvent(id, "stream_lost", { phase: "export_resume", error: result.error ?? null })
      if (routeError) {
        block("resume ended with error", { error: routeError })
        return
      }
    } else if (pending.length > 0) {
      transition(
        id,
        "unexpected_interrupt",
        { blockedReason: "unexpected_interrupt" },
        { interruptIds: pending.map((p) => p.interruptId), kinds: pending.map((p) => p.kind) },
      )
      return
    }

    const receipt = await waitForReceipt(options.outboxDir, digest, { timeoutMs: ctx.receiptWaitMs, signal: abort.signal })
    if (!receipt) {
      block("receipt not observed", { expected: receiptPath(options.outboxDir, digest) })
      return
    }
    if (require(id).state !== "exporting") return
    store.transaction(() => {
      store.recordDelivery({ workOrderId: id, candidateDigest: digest, receiptPath: receipt, observedAt: iso() })
      recordEvent(id, "delivery_observed", { receiptPath: receipt })
      transition(id, "receipt_observed")
    })
  }
```

- [ ] **Step 5: Add `runTurnTwo` next to `startTurnOne`**

```ts
  /** Turn 2: ask the worker to submit the approved candidate, then confirm through the gate and outbox. */
  async function runTurnTwo(id: string): Promise<void> {
    const row = require(id)
    if (!row.workerThreadId || !row.candidateDigest) return
    let frames: AsyncIterable<StreamFrame>
    try {
      frames = await ctx.worker.startRun(row.workerThreadId, options.workerRoute, turnTwoPrompt(row.candidateDigest), abort.signal)
    } catch (error) {
      transition(id, "export_unconfirmed", { blockedReason: "export_unconfirmed" }, { reason: "turn 2 start failed", error: String(error) })
      return
    }
    let routeError: string | null = null
    const result = await consumeTurn(frames, {
      onDone: async (data) => {
        routeError = classifyDone(data).error
      },
    })
    if (result.ended === "lost") recordEvent(id, "stream_lost", { phase: "turn_two", error: result.error ?? null })
    if (routeError) {
      if (require(id).state === "exporting")
        transition(id, "export_unconfirmed", { blockedReason: "export_unconfirmed" }, { reason: "turn 2 ended with error", error: routeError })
      return
    }
    await confirmExport(id)
  }
```

- [ ] **Step 6: Replace the `approve` and `deny` bodies in the `factory` object**

```ts
    async approve(id, { revision, candidateDigest, operationKey }) {
      const row = require(id)
      const key = operationKey ?? `approve:${id}:${revision}`
      const begun = commands.begin(key, id, { command: "approve", args: { revision, candidateDigest } }, iso())
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      const refuse = (message: string) => finish(key, { ok: false, state: row.state, message })
      if (row.state !== "candidate_ready") return refuse(`Cannot approve from ${row.state}`)
      if (row.revision !== revision) return refuse(`Stale revision ${revision}; work order is at ${row.revision}`)
      if (row.candidateDigest !== candidateDigest) return refuse("Candidate digest does not match the recorded candidate")
      const readyAt = row.candidateReadyAt ? Date.parse(row.candidateReadyAt) : Number.NaN
      const ttl = options.approvalTtlMs ?? 900_000
      if (!Number.isFinite(readyAt) || now() > readyAt + ttl) return refuse("Candidate has expired; deny or cancel it")
      store.transaction(() => {
        store.recordApproval({
          id: `ap-${randomUUID()}`,
          workOrderId: id,
          candidateDigest,
          decision: "approved",
          decidedBy: options.actor ?? "operator",
          decidedAt: iso(),
          expiresAt: new Date(readyAt + ttl).toISOString(),
        })
        transition(id, "approve", {}, { candidateDigest, operationKey: key })
      })
      const run = runTurnTwo(id)
      track(id, run)
      await run
      const final = require(id)
      return finish(key, {
        ok: final.state === "exported",
        state: final.state,
        message: final.state === "exported" ? "Exported" : `Export not confirmed: ${final.blockedReason ?? final.state}`,
      })
    },

    async deny(id, operationKey) {
      const row = require(id)
      const key = operationKey ?? `deny:${id}:${row.revision}`
      const begun = commands.begin(key, id, { command: "deny", args: {} }, iso())
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      if (row.state !== "candidate_ready" && row.state !== "blocked")
        return finish(key, { ok: false, state: row.state, message: `Cannot deny from ${row.state}` })
      if (row.state === "blocked") await denyPending(id)
      if (row.candidateDigest)
        store.recordApproval({
          id: `ap-${randomUUID()}`,
          workOrderId: id,
          candidateDigest: row.candidateDigest,
          decision: "denied",
          decidedBy: options.actor ?? "operator",
          decidedAt: iso(),
          expiresAt: iso(),
        })
      const denied = transition(id, "deny", {}, { operationKey: key })
      return finish(key, { ok: true, state: denied.state, message: "Denied" })
    },
```

- [ ] **Step 7: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test factory-approve factory-dispatch`
Expected: PASS, 16 tests.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
pnpm --filter @b4-example/software-factory-server typecheck && pnpm --filter @b4-example/software-factory-server lint
git add examples/software-factory/server/src/controller/factory.ts examples/software-factory/server/test/factory-approve.test.ts
git commit -m "feat(software-factory): approve starts turn 2 and confirms the exact receipt; deny"
```

---

### Task 14: Cancel and budget enforcement

**Files:**
- Modify: `src/controller/factory.ts` (replace the `cancel` body; wire the budget ticker)
- Create: `test/factory-cancel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type Factory, type FactoryOptions, createFactory } from "../src/controller/factory.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { type FakeWorker, type FakeWorkerOptions, createFakeWorker } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
let factory: Factory
let nowMs = Date.parse("2026-09-16T10:00:00.000Z")

async function boot(worker: Omit<FakeWorkerOptions, "outboxDir"> = {}, overrides: Partial<FactoryOptions> = {}) {
  dir = mkdtempSync(join(tmpdir(), "factory-cancel-"))
  fake = await createFakeWorker({ outboxDir: join(dir, "outbox"), ...worker })
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    worker: createHttpWorkerClient(fake.baseUrl),
    workerRoute: "/fix#agent",
    outboxDir: join(dir, "outbox"),
    now: () => nowMs,
    ...overrides,
  })
}
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

const cancels = () => fake.requests.filter((r) => r.path.endsWith("/cancel"))

describe("cancel", () => {
  it("reaches a running worker and ends cancelled only after the run ended", async () => {
    await boot({ turnOne: "hang" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    const outcome = await factory.cancel(id)
    expect(outcome).toEqual({ ok: true, state: "cancelled", message: "Cancelled" })
    expect(cancels()).toHaveLength(1)
    const events = factory.events(id).map((e) => `${e.type}:${String(e.payload.event ?? e.payload.result ?? "")}`)
    expect(events.indexOf("worker_cancel:interrupted")).toBeLessThan(events.indexOf("transition:run_ended_after_cancel"))
  })

  it("cancels a candidate_ready work order without calling the worker", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "candidate_ready")
    const before = fake.requests.length
    expect((await factory.cancel(id)).state).toBe("cancelled")
    expect(fake.requests.length).toBe(before)
  })

  it("cancels a received work order that has no thread", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect((await factory.cancel(id)).state).toBe("cancelled")
    expect(fake.requests).toHaveLength(0)
  })

  it("denies a pending gate left by a cancelled export", async () => {
    await boot({ resume: "no_receipt" }, { receiptWaitMs: 60_000 })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const ready = await factory.waitFor(id, (r) => r.state === "candidate_ready")
    const approving = factory.approve(id, { revision: ready.revision, candidateDigest: ready.candidateDigest! })
    await factory.waitFor(id, (r) => r.state === "exporting")
    await factory.waitFor(id, () => fake.requests.some((r) => r.path.endsWith("/resume")))
    const outcome = await factory.cancel(id)
    expect(outcome.state).toBe("cancelled")
    await expect(approving).resolves.toMatchObject({ ok: false })
  })

  it("refuses cancel on a terminal work order and is idempotent per key", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    const first = await factory.cancel(id, "cancel-1")
    expect(await factory.cancel(id, "cancel-1")).toEqual(first)
    const refused = await factory.cancel(id, "cancel-2")
    expect(refused).toMatchObject({ ok: false, message: expect.stringMatching(/terminal/) })
  })
})

describe("budget", () => {
  it("cancels an over-budget run and blocks it with budget_exhausted", async () => {
    await boot({ turnOne: "hang" }, { maxActiveMs: 1_000, budgetTickMs: 10 })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    nowMs += 5_000
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 5_000)
    expect(row.blockedReason).toBe("budget_exhausted")
    expect(cancels()).toHaveLength(1)
    expect(row.activeMs).toBeGreaterThanOrEqual(5_000)
    const after = fake.requests.length
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fake.requests.length).toBe(after)
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test factory-cancel`
Expected: FAIL, "cancel is implemented in Task 14".

- [ ] **Step 3: Add the import and the cancel helper to `src/controller/factory.ts`**

Add to imports:

```ts
import { startBudgetTicker } from "./budget.js"
```

Add this function after `runTurnTwo`:

```ts
  /**
   * Shared by the cancel command and the budget ticker. `cause` decides the terminal
   * row of the transition table: cancelled, or blocked with budget_exhausted.
   */
  async function finishCancel(id: string, cause: "operator" | "budget"): Promise<WorkOrderRow> {
    const row = require(id)
    if (row.workerThreadId) {
      let result: string
      try {
        result = await ctx.worker.cancel(row.workerThreadId)
      } catch (error) {
        result = `error: ${String(error)}`
      }
      recordEvent(id, "worker_cancel", { result })
      await settleRun(id, 10_000)
      if (result !== "thread_not_found") {
        try {
          await denyPending(id)
        } catch (error) {
          recordEvent(id, "pending_deny_failed", { error: String(error) })
        }
      }
    }
    return cause === "budget"
      ? transition(id, "run_ended_after_budget", { blockedReason: "budget_exhausted" })
      : transition(id, "run_ended_after_cancel")
  }
```

- [ ] **Step 4: Replace the `cancel` body in the `factory` object**

```ts
    async cancel(id, operationKey) {
      const row = require(id)
      const key = operationKey ?? `cancel:${id}:${row.revision}`
      const begun = commands.begin(key, id, { command: "cancel", args: {} }, iso())
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      if (isTerminal(row.state)) return finish(key, { ok: false, state: row.state, message: `Work order is terminal (${row.state})` })
      if (row.state === "cancel_requested") return finish(key, { ok: false, state: row.state, message: "Cancel already in progress" })
      transition(id, "cancel", {}, { operationKey: key })
      const final = await finishCancel(id, "operator")
      return finish(key, { ok: true, state: final.state, message: "Cancelled" })
    },
```

Add `isTerminal` to the `../domain/states.js` import.

- [ ] **Step 5: Wire the budget ticker**

Immediately before `const factory: Factory = {`, add:

```ts
  const ticker = startBudgetTicker({
    store,
    now,
    tickMs: options.budgetTickMs ?? 1_000,
    onExhausted: async (id) => {
      const row = require(id)
      const key = `budget:${id}:${row.revision}`
      const begun = commands.begin(key, id, { command: "cancel", args: { cause: "budget" } }, iso())
      if (begun.status !== "new") return
      try {
        transition(id, "budget_exhausted", { blockedReason: "budget_exhausted" }, { maxActiveMs: row.maxActiveMs })
      } catch (error) {
        commands.complete(key, { ok: false, message: `Budget cancel skipped: ${String(error)}` })
        return
      }
      const final = await finishCancel(id, "budget")
      commands.complete(key, { ok: true, state: final.state, message: "Budget exhausted" })
    },
  })
```

and in `close()` add `ticker.stop()` as the first line.

- [ ] **Step 6: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test factory-cancel factory-approve factory-dispatch`
Expected: PASS, 22 tests.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm --filter @b4-example/software-factory-server typecheck && pnpm --filter @b4-example/software-factory-server lint
git add examples/software-factory/server/src/controller/factory.ts examples/software-factory/server/test/factory-cancel.test.ts
git commit -m "feat(software-factory): cancel propagation and active-time budget enforcement"
```

---

### Task 15: Startup reconciliation and lost-stream recovery

**Files:**
- Create: `src/controller/reconcile.ts`, `test/factory-reconcile.test.ts`
- Modify: `src/controller/context.ts` (add `finishCancel`), `src/controller/factory.ts` (expose it, call reconciliation on boot and on lost streams), `test/fake-worker.ts` (reattach completes when the run ends), `test/factory-dispatch.test.ts` (lost-stream expectation)

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type Factory, type FactoryOptions, createFactory } from "../src/controller/factory.ts"
import { createCommandLog } from "../src/registry/commands.ts"
import { openRegistry } from "../src/registry/db.ts"
import { createWorkOrderStore } from "../src/registry/work-orders.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { type FakeWorker, type FakeWorkerOptions, createFakeWorker } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
let factory: Factory

const registryPath = () => join(dir, "registry.sqlite")
const outbox = () => join(dir, "outbox")

async function bootWorker(options: Omit<FakeWorkerOptions, "outboxDir"> = {}) {
  dir = mkdtempSync(join(tmpdir(), "factory-reconcile-"))
  fake = await createFakeWorker({ outboxDir: outbox(), ...options })
}
async function bootFactory(overrides: Partial<FactoryOptions> = {}) {
  factory = await createFactory({
    registryPath: registryPath(),
    worker: createHttpWorkerClient(fake.baseUrl),
    workerRoute: "/fix#agent",
    outboxDir: outbox(),
    receiptWaitMs: 500,
    ...overrides,
  })
  return factory
}
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Simulate a crash: drop the in-memory factory without letting it finish anything. */
async function crash() {
  await factory.close()
}

describe("reconciliation", () => {
  it("leaves candidate_ready alone and approve still works after a restart", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "candidate_ready")
    const before = fake.requests.length
    await crash()
    await bootFactory()
    expect(fake.requests.length).toBe(before)
    const row = factory.show(id)!
    expect(row.state).toBe("candidate_ready")
    const outcome = await factory.approve(id, { revision: row.revision, candidateDigest: row.candidateDigest! })
    expect(outcome.state).toBe("exported")
  })

  it("marks a dispatch that died before committing a thread as failed and keeps the work order received", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await crash()
    // Forge the crash window: intent committed, no thread id, no outcome.
    const registry = openRegistry(registryPath())
    createCommandLog(registry.db).begin("dispatch-crashed", id, { command: "dispatch", args: {} }, new Date().toISOString())
    registry.close()
    await bootFactory()
    expect(factory.show(id)?.state).toBe("received")
    const replay = await factory.dispatch(id, "dispatch-crashed")
    expect(replay).toMatchObject({ ok: false, message: expect.stringMatching(/dispatch again/) })
    expect(fake.requests.filter((r) => r.path === "/threads")).toHaveLength(0)
  })

  it("resolves a pending export gate from the recorded approval after a restart", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const ready = await factory.waitFor(id, (r) => r.state === "candidate_ready")
    // Approve, but crash as soon as turn 2 has parked on the gate and before the resume.
    fake.behaviour.resume = "receipt"
    const approving = factory.approve(id, { revision: ready.revision, candidateDigest: ready.candidateDigest! })
    await factory.waitFor(id, () => fake.requests.filter((r) => r.path.endsWith("/pending_interrupts")).length > 0)
    await crash()
    await approving.catch(() => undefined)
    const resumesBefore = fake.requests.filter((r) => r.path.endsWith("/resume")).length
    await bootFactory()
    const row = await factory.waitFor(id, (r) => r.state === "exported")
    expect(row.state).toBe("exported")
    expect(fake.requests.filter((r) => r.path.endsWith("/resume")).length).toBeGreaterThanOrEqual(resumesBefore)
    expect(readdirSync(outbox())).toEqual([`${fake.digest}.json`])
    const registry = openRegistry(registryPath())
    expect(createWorkOrderStore(registry.db).approvals(id).filter((a) => a.decision === "approved")).toHaveLength(1)
    registry.close()
  })

  it("marks exporting as exported from an existing receipt without a worker write", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const ready = await factory.waitFor(id, (r) => r.state === "candidate_ready")
    await crash()
    // Forge: approval recorded and transition to exporting happened, receipt already on disk, no confirmation.
    const registry = openRegistry(registryPath())
    const store = createWorkOrderStore(registry.db)
    store.recordApproval({
      id: "ap-forged",
      workOrderId: id,
      candidateDigest: ready.candidateDigest!,
      decision: "approved",
      decidedBy: "operator",
      decidedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    })
    store.update(id, ready.revision, { state: "exporting", activeStartedAt: new Date().toISOString() }, new Date().toISOString())
    registry.close()
    writeFileSync(join(outbox(), `${fake.digest}.json`), "{}")
    const before = fake.requests.filter((r) => r.method === "POST").length
    await bootFactory()
    expect(factory.show(id)?.state).toBe("exported")
    expect(fake.requests.filter((r) => r.method === "POST").length).toBe(before)
  })

  it("finishes a cancel that was requested before the crash", async () => {
    await bootWorker({ turnOne: "hang" })
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    await crash()
    const registry = openRegistry(registryPath())
    const store = createWorkOrderStore(registry.db)
    const row = store.get(id)!
    store.update(id, row.revision, { state: "cancel_requested" }, new Date().toISOString())
    registry.close()
    await bootFactory()
    expect(factory.show(id)?.state).toBe("cancelled")
    expect(fake.requests.filter((r) => r.path.endsWith("/cancel"))).toHaveLength(1)
  })

  it("recovers a lost turn 1 stream by reattaching and reaches candidate_ready", async () => {
    await bootWorker({ turnOne: "close_midway" })
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => r.state === "candidate_ready")
    expect(row.candidateDigest).toBe(fake.digest)
    expect(factory.events(id).map((e) => e.type)).toContain("stream_lost")
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test factory-reconcile`
Expected: FAIL, module not found.

- [ ] **Step 3: Extend `src/controller/context.ts`**

Add to `ControllerContext`:

```ts
  /** Cancel the worker if needed, deny any pending gate, and apply the terminal cancel row. */
  finishCancel(id: string, cause: "operator" | "budget"): Promise<WorkOrderRow>
```

- [ ] **Step 4: Implement `src/controller/reconcile.ts`**

```ts
import { isTerminal } from "../domain/states.js"
import type { WorkOrderRow } from "../domain/work-order.js"
import { receiptExists, receiptPath } from "../worker/outbox.js"
import { isExportGate } from "../worker/wire.js"
import type { ControllerContext } from "./context.js"

/**
 * Startup reconciliation (spec: "Startup reconciliation"). Never starts turn 1 or turn 2.
 * Open command intents are settled first, then every non-terminal work order is inspected.
 */
export async function reconcileAll(ctx: ControllerContext): Promise<void> {
  for (const open of ctx.commands.open()) {
    const row = ctx.store.get(open.workOrderId)
    if (!row) {
      ctx.commands.complete(open.operationKey, { ok: false, message: "Work order missing at reconciliation" })
      continue
    }
    if (open.intent.command === "dispatch" && row.state === "received" && !row.workerThreadId) {
      ctx.recordEvent(row.id, "reconciled", { operationKey: open.operationKey, resolution: "dispatch_incomplete" })
      ctx.commands.complete(open.operationKey, {
        ok: false,
        state: "received",
        message: "Dispatch was interrupted before a thread was committed; dispatch again",
      })
      continue
    }
    await reconcileWorkOrder(ctx, row.id)
    const final = ctx.require(row.id)
    ctx.commands.complete(open.operationKey, {
      ok: final.state === "exported" || final.state === "cancelled" || final.state === "denied",
      state: final.state,
      message: `Reconciled after restart; work order is ${final.state}`,
    })
  }
  for (const row of ctx.store.list()) {
    if (!isTerminal(row.state)) await reconcileWorkOrder(ctx, row.id)
  }
}

export async function reconcileWorkOrder(ctx: ControllerContext, id: string): Promise<void> {
  const row = ctx.require(id)
  switch (row.state) {
    case "dispatched":
    case "running":
      return reconcileTurnOne(ctx, row)
    case "exporting":
      return reconcileExporting(ctx, row)
    case "cancel_requested":
      await ctx.finishCancel(id, row.blockedReason === "budget_exhausted" ? "budget" : "operator")
      return
    default:
      return
  }
}

async function reconcileTurnOne(ctx: ControllerContext, row: WorkOrderRow): Promise<void> {
  const id = row.id
  const fail = (reason: string) =>
    ctx.transition(id, "run_ended_without_candidate", { failureReason: "ended_without_candidate" }, { reconciled: true, reason })
  if (!row.workerThreadId) {
    fail("no thread recorded")
    return
  }
  const threadId = row.workerThreadId
  const thread = await ctx.worker.getThread(threadId)
  if (!thread) {
    fail("thread not found on worker")
    return
  }
  const pending = await ctx.worker.pendingInterrupts(threadId)
  if (pending.length > 0) {
    if (pending.every(isExportGate)) {
      ctx.recordEvent(id, "premature_export_denied", { interruptIds: pending.map((p) => p.interruptId), reconciled: true })
      const frames = await ctx.worker.resume(
        threadId,
        ctx.workerRoute,
        pending.map((p) => ({ interruptId: p.interruptId, payload: "deny" as const })),
        ctx.signal,
      )
      await ctx.observeTurnOne(id, frames)
      return
    }
    ctx.transition(
      id,
      "unexpected_interrupt",
      { blockedReason: "unexpected_interrupt" },
      { reconciled: true, interruptIds: pending.map((p) => p.interruptId), kinds: pending.map((p) => p.kind) },
    )
    return
  }
  if (thread.status === "busy") {
    ctx.recordEvent(id, "reattached", { threadId })
    const frames = await ctx.worker.reattach(threadId, ctx.signal)
    ctx.track(id, ctx.observeTurnOne(id, frames))
    return
  }
  if (row.candidateVerified === true) ctx.transition(id, "candidate_ready", { candidateReadyAt: ctx.iso() }, { reconciled: true })
  else fail(`thread ${thread.status} with no verified candidate`)
}

async function reconcileExporting(ctx: ControllerContext, row: WorkOrderRow): Promise<void> {
  const id = row.id
  if (row.candidateDigest && (await receiptExists(ctx.outboxDir, row.candidateDigest))) {
    const path = receiptPath(ctx.outboxDir, row.candidateDigest)
    ctx.store.transaction(() => {
      if (!ctx.store.delivery(id))
        ctx.store.recordDelivery({ workOrderId: id, candidateDigest: row.candidateDigest as string, receiptPath: path, observedAt: ctx.iso() })
      ctx.recordEvent(id, "delivery_observed", { receiptPath: path, reconciled: true })
      ctx.transition(id, "receipt_observed", {}, { reconciled: true })
    })
    return
  }
  await ctx.confirmExport(id)
}
```

- [ ] **Step 5: Wire it into `src/controller/factory.ts`**

Add the import:

```ts
import { reconcileAll, reconcileWorkOrder } from "./reconcile.js"
```

In the `ctx` object literal add `finishCancel,` (the function from Task 14 is declared after `ctx`; move `finishCancel`'s declaration above the `ctx` literal, or convert the literal's entry to `finishCancel: (id, cause) => finishCancel(id, cause),`).

In `observeTurnOne`, replace both `stream_lost` early returns:

```ts
      if (result.ended === "lost") {
        recordEvent(id, "stream_lost", { phase: "turn_one", error: result.error ?? null })
        await reconcileWorkOrder(ctx, id)
        return
      }
```

and

```ts
      } catch (error) {
        recordEvent(id, "stream_lost", { phase: "premature_deny", error: String(error) })
        await reconcileWorkOrder(ctx, id)
        return
      }
```

Immediately before `return factory` at the end of `createFactory`, add:

```ts
  await reconcileAll(ctx)
```

- [ ] **Step 6: Make the fake's reattach complete when the run ends**

In `test/fake-worker.ts`:

Add to the `Thread` interface:

```ts
  /** Reattached GET streams waiting for this run's terminal `done` frame. */
  waiters: Set<(done: unknown) => void>
```

Initialise `waiters: new Set()` where a thread is created. Add a helper next to `finishRun`:

```ts
  function notify(thread: Thread, done: unknown) {
    for (const waiter of thread.waiters) waiter(done)
    thread.waiters.clear()
  }
```

Call `notify(thread, { output: {} })` as the first line of both `finishRun` and `parkRun`. In the `close_midway` branch, after `thread.status = "idle"`, add `notify(thread, { output: {} })`. In the cancel handler, before `thread.runActive = false`, add `notify(thread, { output: { cancelled: true } })`.

Replace the `GET runs/stream` handler body with:

```ts
    if (req.method === "GET" && tail === "runs/stream") {
      const sse = new Sse(res)
      sse.frame("state", {
        status: thread.status,
        live: thread.runActive,
        interrupts: thread.pending ? [thread.pending] : [],
      })
      if (!thread.runActive) return sse.end()
      await new Promise<void>((resolve) => {
        thread.waiters.add((done) => {
          sse.frame("done", done)
          resolve()
        })
      })
      return sse.end()
    }
```

- [ ] **Step 7: Update the lost-stream expectation from Task 12**

In `test/factory-dispatch.test.ts`, replace the last test with:

```ts
  it("records a lost stream and recovers through reconciliation", async () => {
    await boot({ turnOne: "close_midway" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => settled(r.state))
    expect(row.state).toBe("candidate_ready")
    expect(factory.events(id).map((e) => e.type)).toContain("stream_lost")
  })
```

- [ ] **Step 8: Run everything**

Run: `pnpm --filter @b4-example/software-factory-server test`
Expected: PASS, all files green. If the "resolves a pending export gate" test races, the `waitFor` on `pending_interrupts` requests must observe the request *before* the crash; increase `frameDelayMs` on the fake to 20 for that test.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
pnpm --filter @b4-example/software-factory-server typecheck && pnpm --filter @b4-example/software-factory-server lint
git add examples/software-factory/server
git commit -m "feat(software-factory): startup reconciliation and lost-stream recovery"
```

---

### Task 16: Shared invariant scenarios

The spec requires the same scenarios to run against the fake (layer 1) and the real code-fixer (layer 2). This task extracts them into one module parameterised by a `ScenarioContext`, and runs it against the fake. Task 18 runs it against code-fixer.

**Files:**
- Create: `test/scenarios.ts`, `test/scenarios-fake.test.ts`

- [ ] **Step 1: Write `test/scenarios.ts`**

```ts
import { readdirSync } from "node:fs"
import { expect, it } from "vitest"
import type { Factory } from "../src/controller/factory.ts"

/** What a worker under test must provide. Layer 1 is the fake; layer 2 is the real code-fixer. */
export interface ScenarioContext {
  /** Build (or rebuild, after a simulated crash) a factory over the same registry and worker. */
  readonly makeFactory: () => Promise<Factory>
  readonly outboxDir: string
  readonly taskId: string
  /** Register whatever the worker needs to answer turn 2 for this candidate. No-op for the fake. */
  readonly arrangeTurnTwo: (candidate: Record<string, unknown>, digest: string) => Promise<void>
  /** Upper bound for a whole scenario; the real worker runs Docker. */
  readonly timeoutMs: number
}

async function toCandidateReady(factory: Factory, ctx: ScenarioContext) {
  const { id } = await factory.create({ taskId: ctx.taskId })
  await factory.dispatch(id)
  const row = await factory.waitFor(id, (r) => r.state !== "received" && r.state !== "dispatched" && r.state !== "running", ctx.timeoutMs)
  expect(row.state, JSON.stringify(factory.events(id), null, 2)).toBe("candidate_ready")
  const observed = factory.events(id).find((e) => e.type === "candidate_observed")
  expect(observed).toBeDefined()
  const candidate = observed?.payload.candidate as Record<string, unknown>
  await ctx.arrangeTurnTwo(candidate, row.candidateDigest as string)
  return { id, row, candidate }
}

/** Register the shared scenarios inside the caller's describe block. */
export function sharedScenarios(setup: () => Promise<ScenarioContext>): void {
  it("happy path: received to exported with exactly one receipt named by the approved digest", async () => {
    const ctx = await setup()
    const factory = await ctx.makeFactory()
    try {
      const { id, row } = await toCandidateReady(factory, ctx)
      const outcome = await factory.approve(id, { revision: row.revision, candidateDigest: row.candidateDigest as string })
      expect(outcome, JSON.stringify(factory.events(id), null, 2)).toMatchObject({ ok: true, state: "exported" })
      expect(readdirSync(ctx.outboxDir)).toEqual([`${row.candidateDigest}.json`])
      const types = factory.events(id).map((e) => e.type)
      expect(types.indexOf("thread_created")).toBeLessThan(types.findIndex((t, i) => t === "transition" && factory.events(id)[i]?.payload.event === "run_started"))
    } finally {
      await factory.close()
    }
  })

  it("approve is refused with a stale revision, a wrong digest, or after expiry", async () => {
    const ctx = await setup()
    const factory = await ctx.makeFactory()
    try {
      const { id, row } = await toCandidateReady(factory, ctx)
      const digest = row.candidateDigest as string
      expect((await factory.approve(id, { revision: row.revision + 1, candidateDigest: digest })).ok).toBe(false)
      expect((await factory.approve(id, { revision: row.revision, candidateDigest: "0".repeat(64) })).ok).toBe(false)
      expect(factory.show(id)).toMatchObject({ state: "candidate_ready", revision: row.revision })
      expect(readdirSync(ctx.outboxDir)).toEqual([])
    } finally {
      await factory.close()
    }
  })

  it("approve twice with one operation key yields one export", async () => {
    const ctx = await setup()
    const factory = await ctx.makeFactory()
    try {
      const { id, row } = await toCandidateReady(factory, ctx)
      const input = { revision: row.revision, candidateDigest: row.candidateDigest as string, operationKey: `approve:${id}:shared` }
      const first = await factory.approve(id, input)
      const second = await factory.approve(id, input)
      expect(second).toEqual(first)
      expect(first.state).toBe("exported")
      expect(readdirSync(ctx.outboxDir)).toHaveLength(1)
      expect(factory.events(id).filter((e) => e.type === "export_gate_resolved")).toHaveLength(1)
    } finally {
      await factory.close()
    }
  })

  it("deny from candidate_ready leaves the outbox empty", async () => {
    const ctx = await setup()
    const factory = await ctx.makeFactory()
    try {
      const { id } = await toCandidateReady(factory, ctx)
      expect((await factory.deny(id)).state).toBe("denied")
      expect(readdirSync(ctx.outboxDir)).toEqual([])
    } finally {
      await factory.close()
    }
  })

  it("a restart while candidate_ready changes nothing and approve still works", async () => {
    const ctx = await setup()
    let factory = await ctx.makeFactory()
    let id: string
    let revision: number
    let digest: string
    try {
      const ready = await toCandidateReady(factory, ctx)
      id = ready.id
      revision = ready.row.revision
      digest = ready.row.candidateDigest as string
    } finally {
      await factory.close()
    }
    factory = await ctx.makeFactory()
    try {
      expect(factory.show(id)).toMatchObject({ state: "candidate_ready", revision })
      const outcome = await factory.approve(id, { revision, candidateDigest: digest })
      expect(outcome.state).toBe("exported")
    } finally {
      await factory.close()
    }
  })

  it("cancel while candidate_ready ends cancelled", async () => {
    const ctx = await setup()
    const factory = await ctx.makeFactory()
    try {
      const { id } = await toCandidateReady(factory, ctx)
      expect((await factory.cancel(id)).state).toBe("cancelled")
    } finally {
      await factory.close()
    }
  })
}
```

- [ ] **Step 2: Write `test/scenarios-fake.test.ts`**

```ts
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe } from "vitest"
import { createFactory } from "../src/controller/factory.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { type FakeWorker, createFakeWorker } from "./fake-worker.ts"
import { type ScenarioContext, sharedScenarios } from "./scenarios.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe("shared scenarios against the fake worker (layer 1)", () => {
  sharedScenarios(async (): Promise<ScenarioContext> => {
    const dir = mkdtempSync(join(tmpdir(), "scenarios-fake-"))
    const outboxDir = join(dir, "outbox")
    mkdirSync(outboxDir)
    const fake: FakeWorker = await createFakeWorker({ outboxDir })
    cleanups.push(async () => {
      await fake.close()
      rmSync(dir, { recursive: true, force: true })
    })
    return {
      makeFactory: () =>
        createFactory({
          registryPath: join(dir, "registry.sqlite"),
          worker: createHttpWorkerClient(fake.baseUrl),
          workerRoute: "/fix#agent",
          outboxDir,
          receiptWaitMs: 2_000,
        }),
      outboxDir,
      taskId: "cli-flags",
      arrangeTurnTwo: async () => undefined,
      timeoutMs: 10_000,
    }
  })
})
```

- [ ] **Step 3: Run it**

Run: `pnpm --filter @b4-example/software-factory-server test scenarios-fake`
Expected: PASS, 6 tests.

- [ ] **Step 4: Commit**

```bash
git add examples/software-factory/server/test/scenarios.ts examples/software-factory/server/test/scenarios-fake.test.ts
git commit -m "test(software-factory): shared invariant scenarios, run against the fake worker"
```

---

### Task 17: CLI and loopback HTTP API

**Files:**
- Create: `src/http.ts`, `src/cli.ts`, `test/http.test.ts`, `test/cli.test.ts`

- [ ] **Step 1: Write the failing HTTP test**

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type Factory, createFactory } from "../src/controller/factory.ts"
import { type HttpApi, createHttpApi } from "../src/http.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { type FakeWorker, createFakeWorker } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
let factory: Factory
let api: HttpApi
afterEach(async () => {
  await api?.close()
  await factory?.close()
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("http api", () => {
  it("drives a work order end to end over JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-http-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "outbox") })
    factory = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      worker: createHttpWorkerClient(fake.baseUrl),
      workerRoute: "/fix#agent",
      outboxDir: join(dir, "outbox"),
      receiptWaitMs: 2_000,
    })
    api = await createHttpApi(factory).listen(0)
    const post = (path: string, body: unknown = {}) =>
      fetch(`${api.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

    const created = await post("/work-orders", { taskId: "cli-flags" })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    expect((await post(`/work-orders/${id}/dispatch`)).status).toBe(200)
    const ready = await factory.waitFor(id, (r) => r.state === "candidate_ready")

    const list = (await (await fetch(`${api.baseUrl}/work-orders`)).json()) as { id: string }[]
    expect(list.map((w) => w.id)).toEqual([id])

    const refused = await post(`/work-orders/${id}/approve`, { revision: 0, candidateDigest: ready.candidateDigest })
    expect(refused.status).toBe(409)

    const approved = await post(`/work-orders/${id}/approve`, { revision: ready.revision, candidateDigest: ready.candidateDigest })
    expect(approved.status).toBe(200)
    expect(((await approved.json()) as { state: string }).state).toBe("exported")

    const events = (await (await fetch(`${api.baseUrl}/work-orders/${id}/events`)).json()) as { type: string }[]
    expect(events.some((e) => e.type === "delivery_observed")).toBe(true)
    expect((await fetch(`${api.baseUrl}/work-orders/nope`)).status).toBe(404)
    expect((await post("/work-orders", { taskId: 42 })).status).toBe(400)
  })
})
```

- [ ] **Step 2: Write the failing CLI test**

```ts
import { execFile } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { type FakeWorker, createFakeWorker } from "./fake-worker.ts"

const run = promisify(execFile)
let dir: string
let fake: FakeWorker
afterEach(async () => {
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("cli", () => {
  it("creates, dispatches, shows, approves and lists as JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-cli-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "outbox") })
    const env = {
      ...process.env,
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_WORKER_OUTBOX: join(dir, "outbox"),
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_RECEIPT_WAIT_MS: "2000",
    }
    const cli = async (...args: string[]) => {
      const { stdout } = await run("pnpm", ["exec", "tsx", "src/cli.ts", ...args], { env, cwd: process.cwd() })
      return JSON.parse(stdout)
    }
    const created = await cli("create", "--task", "cli-flags")
    expect(created.state).toBe("received")
    const dispatched = await cli("dispatch", created.id, "--wait")
    expect(dispatched.state).toBe("candidate_ready")
    const approved = await cli("approve", created.id, "--revision", String(dispatched.revision), "--digest", dispatched.candidateDigest)
    expect(approved.state).toBe("exported")
    const list = await cli("list")
    expect(list).toHaveLength(1)
    const events = await cli("events", created.id)
    expect(events.map((e: { type: string }) => e.type)).toContain("delivery_observed")
  }, 60_000)

  it("exits non-zero on a refused command", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-cli-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "outbox") })
    const env = {
      ...process.env,
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_WORKER_OUTBOX: join(dir, "outbox"),
      FACTORY_STATE_DIR: join(dir, "state"),
    }
    const { stdout } = await run("pnpm", ["exec", "tsx", "src/cli.ts", "create", "--task", "cli-flags"], { env })
    const { id } = JSON.parse(stdout)
    await expect(run("pnpm", ["exec", "tsx", "src/cli.ts", "approve", id, "--revision", "0", "--digest", "0".repeat(64)], { env })).rejects.toMatchObject({ code: 1 })
  }, 60_000)
})
```

- [ ] **Step 3: Run both**

Run: `pnpm --filter @b4-example/software-factory-server test http cli`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `src/http.ts`**

```ts
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http"
import { z } from "zod"
import { type Factory, UnknownTaskError, UnknownWorkOrderError } from "./controller/factory.js"
import { DIGEST_PATTERN } from "./domain/work-order.js"

export interface HttpApi {
  readonly baseUrl: string
  close(): Promise<void>
}

const CreateBody = z.object({ taskId: z.string().min(1), operationKey: z.string().min(1).optional() })
const KeyBody = z.object({ operationKey: z.string().min(1).optional() }).default({})
const ApproveBody = z.object({
  revision: z.number().int().nonnegative(),
  candidateDigest: z.string().regex(DIGEST_PATTERN),
  operationKey: z.string().min(1).optional(),
})

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString("utf8")
  return text === "" ? {} : JSON.parse(text)
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

/** Loopback-only JSON surface over the factory commands. No authentication (spec: out of scope). */
export function createHttpApi(factory: Factory): { listen(port: number): Promise<HttpApi> } {
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const parts = url.pathname.split("/").filter(Boolean)
      if (parts[0] !== "work-orders") return send(res, 404, { error: "Not found" })
      const id = parts[1]
      const action = parts[2]

      if (req.method === "GET" && !id) return send(res, 200, factory.list())
      if (req.method === "POST" && !id) {
        const body = CreateBody.parse(await readJson(req))
        return send(res, 201, await factory.create(body))
      }
      if (!id) return send(res, 404, { error: "Not found" })
      if (req.method === "GET" && !action) {
        const row = factory.show(id)
        return row ? send(res, 200, row) : send(res, 404, { error: "Unknown work order" })
      }
      if (req.method === "GET" && action === "events") {
        if (!factory.show(id)) return send(res, 404, { error: "Unknown work order" })
        return send(res, 200, factory.events(id))
      }
      if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" })
      const body = await readJson(req)
      const outcome =
        action === "dispatch"
          ? await factory.dispatch(id, KeyBody.parse(body).operationKey)
          : action === "approve"
            ? await factory.approve(id, ApproveBody.parse(body))
            : action === "deny"
              ? await factory.deny(id, KeyBody.parse(body).operationKey)
              : action === "cancel"
                ? await factory.cancel(id, KeyBody.parse(body).operationKey)
                : null
      if (!outcome) return send(res, 404, { error: "Not found" })
      return send(res, outcome.ok ? 200 : 409, outcome)
    } catch (error) {
      if (error instanceof z.ZodError) return send(res, 400, { error: "Invalid body", issues: error.issues })
      if (error instanceof UnknownTaskError) return send(res, 400, { error: error.message })
      if (error instanceof UnknownWorkOrderError) return send(res, 404, { error: error.message })
      if (error instanceof SyntaxError) return send(res, 400, { error: "Malformed JSON" })
      return send(res, 500, { error: String(error) })
    }
  })
  return {
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, "127.0.0.1", () => {
          const address = server.address()
          if (typeof address !== "object" || address === null) return reject(new Error("did not bind"))
          resolve({
            baseUrl: `http://127.0.0.1:${address.port}`,
            close: () =>
              new Promise<void>((done) => {
                server.closeAllConnections()
                server.close(() => done())
              }),
          })
        })
      })
    },
  }
}
```

- [ ] **Step 5: Implement `src/cli.ts`**

```ts
import { parseArgs } from "node:util"
import { loadConfig } from "./config.js"
import { type Factory, createFactory } from "./controller/factory.js"
import { createHttpApi } from "./http.js"
import { createHttpWorkerClient } from "./worker/client.js"

const USAGE = `factory <command> [options]

  create   --task <id> [--key <operationKey>]
  dispatch <workOrderId> [--wait] [--key <operationKey>]
  approve  <workOrderId> --revision <n> --digest <sha256> [--key <operationKey>]
  deny     <workOrderId> [--key <operationKey>]
  cancel   <workOrderId> [--key <operationKey>]
  show     <workOrderId>
  events   <workOrderId>
  list
  serve    [--port <n>]

Environment: FACTORY_WORKER_URL, FACTORY_WORKER_OUTBOX, FACTORY_STATE_DIR (required);
FACTORY_WORKER_ROUTE, FACTORY_APPROVAL_TTL_MS, FACTORY_MAX_ACTIVE_MS, FACTORY_RECEIPT_WAIT_MS, FACTORY_HTTP_PORT.
Output is JSON. Exit code 1 when a command is refused.`

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: "string" },
      key: { type: "string" },
      revision: { type: "string" },
      digest: { type: "string" },
      port: { type: "string" },
      wait: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })
  const [command, id] = positionals
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`)
    return command ? 0 : 1
  }
  const config = loadConfig(process.env)
  const factory: Factory = await createFactory({
    registryPath: config.registryPath,
    worker: createHttpWorkerClient(config.workerUrl),
    workerRoute: config.workerRoute,
    outboxDir: config.outboxDir,
    approvalTtlMs: config.approvalTtlMs,
    maxActiveMs: config.maxActiveMs,
    receiptWaitMs: config.receiptWaitMs,
  })
  const needId = () => {
    if (!id) throw new Error(`${command} requires a work order id`)
    return id
  }
  try {
    switch (command) {
      case "create": {
        if (!values.task) throw new Error("create requires --task")
        print(await factory.create({ taskId: values.task, ...(values.key ? { operationKey: values.key } : {}) }))
        return 0
      }
      case "dispatch": {
        const outcome = await factory.dispatch(needId(), values.key)
        if (!outcome.ok) {
          print(outcome)
          return 1
        }
        if (values.wait) {
          print(await factory.waitFor(needId(), (r) => !["dispatched", "running"].includes(r.state), config.maxActiveMs + 60_000))
        } else print(outcome)
        return 0
      }
      case "approve": {
        if (!values.revision || !values.digest) throw new Error("approve requires --revision and --digest")
        const outcome = await factory.approve(needId(), {
          revision: Number(values.revision),
          candidateDigest: values.digest,
          ...(values.key ? { operationKey: values.key } : {}),
        })
        print({ ...outcome, ...factory.show(needId()) })
        return outcome.ok ? 0 : 1
      }
      case "deny":
      case "cancel": {
        const outcome = command === "deny" ? await factory.deny(needId(), values.key) : await factory.cancel(needId(), values.key)
        print(outcome)
        return outcome.ok ? 0 : 1
      }
      case "show": {
        const row = factory.show(needId())
        if (!row) throw new Error(`Unknown work order ${id}`)
        print(row)
        return 0
      }
      case "events":
        print(factory.events(needId()))
        return 0
      case "list":
        print(factory.list())
        return 0
      case "serve": {
        const api = await createHttpApi(factory).listen(values.port ? Number(values.port) : config.httpPort)
        process.stderr.write(`factory listening on ${api.baseUrl}\n`)
        await new Promise<void>((resolve) => {
          const stop = () => {
            api.close().then(resolve, resolve)
          }
          process.once("SIGINT", stop)
          process.once("SIGTERM", stop)
        })
        return 0
      }
      default:
        throw new Error(`Unknown command ${command}\n${USAGE}`)
    }
  } finally {
    if (command !== "serve") await factory.close()
    else await factory.close()
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  },
)
```

The `approve` output merges the outcome with the final row so an operator sees both the message and the state in one object.

- [ ] **Step 6: Run both**

Run: `pnpm --filter @b4-example/software-factory-server test http cli`
Expected: PASS, 3 tests. The CLI test spawns `pnpm exec tsx` from the package directory (vitest's cwd), so it needs the package's `node_modules/.bin`; if `pnpm` is not on PATH under vitest, use `process.execPath` with `node_modules/.bin/tsx` resolved from `import.meta.dirname` instead.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm --filter @b4-example/software-factory-server typecheck && pnpm --filter @b4-example/software-factory-server lint
git add examples/software-factory/server/src/http.ts examples/software-factory/server/src/cli.ts examples/software-factory/server/test/http.test.ts examples/software-factory/server/test/cli.test.ts
git commit -m "feat(software-factory): CLI and loopback HTTP API over the factory commands"
```

---

### Task 18: Layer 2, the real code-fixer under Docker, and the CI lane

Boots the unchanged code-fixer with `createSubprocessApp` on a private copy of its app root, feeds it `aimock` replay fixtures, and runs the shared scenarios through the factory. Gated on `B4_TEST_DOCKER=1`; needs the `b4-code-fixer:fixture-v1` image (`pnpm code-fixer:prepare` at the repo root) and the built `@b4run/cli` (`pnpm turbo run build --filter=@b4-example/code-fixer-server...`).

**Files:**
- Create: `test/code-fixer.integration.test.ts`
- Modify: `<repo>/.github/workflows/ci.yml` (sandbox-docker job)

- [ ] **Step 1: Write the integration test**

```ts
import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Aimock, type SubprocessApp, createAimock, createSubprocessApp, script } from "@b4run/testing"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { createFactory } from "../src/controller/factory.ts"
import { TURN_ONE_PROMPTS, turnTwoPrompt } from "../src/prompts.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { type ScenarioContext, sharedScenarios } from "./scenarios.ts"

/** Read-only references into the code-fixer example. Files are read; modules are never imported. */
const CODE_FIXER_ROOT = fileURLToPath(new URL("../../../code-fixer/server/", import.meta.url))
const SAMPLE = join(CODE_FIXER_ROOT, "sample")
const IMAGE = "b4-code-fixer:fixture-v1"
const TASK = "cli-flags"

const enabled = process.env.B4_TEST_DOCKER === "1"

beforeAll(() => {
  if (!enabled) return
  const inspect = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" })
  if (inspect.status !== 0)
    throw new Error(`Image ${IMAGE} is missing. Run \`pnpm code-fixer:prepare\` at the repo root first.`)
})

/** Same shape as code-fixer's own isolatedApp(): copy author files, share only dependencies. */
async function isolatedCodeFixer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "factory-code-fixer-app-"))
  const include = (path: string) =>
    !["node_modules", ".b4", "artifacts"].includes(basename(path)) && !basename(path).startsWith(".env")
  for (const name of await readdir(CODE_FIXER_ROOT)) {
    if (include(name)) await cp(join(CODE_FIXER_ROOT, name), join(root, name), { recursive: true, filter: include })
  }
  await symlink(join(CODE_FIXER_ROOT, "node_modules"), join(root, "node_modules"), "dir")
  return root
}

/**
 * Same steps as code-fixer's replayFixture(), keyed to the factory's turn 1 prompt: apply the
 * historical reference.patch to a scratch copy and script the model to write those exact bytes.
 */
async function turnOneFixtures() {
  const manifest = JSON.parse(await readFile(join(SAMPLE, "manifest.json"), "utf8")) as { allowedSourcePaths: string[] }
  const scratch = await mkdtemp(join(tmpdir(), "factory-replay-"))
  try {
    await cp(join(SAMPLE, "project"), scratch, { recursive: true, filter: (p) => basename(p) !== "node_modules" })
    const applied = spawnSync("git", ["apply", join(SAMPLE, "reference.patch")], { cwd: scratch, encoding: "utf8" })
    if (applied.status !== 0) throw new Error(`reference.patch failed: ${applied.stderr}`)
    let fixture = script()
      .user(TURN_ONE_PROMPTS[TASK] as string)
      .callsTool("readFile", { path: "TASK.md" })
      .callsTool("runBash", { command: "npm test" })
    for (const path of manifest.allowedSourcePaths) {
      fixture = fixture
        .callsTool("readFile", { path })
        .callsTool("writeFile", { path, content: await readFile(join(scratch, path), "utf8") })
    }
    return fixture
      .callsTool("runBash", { command: "npm test" })
      .callsTool("prepareReview", {})
      .replies("Candidate verified and ready for approval.")
      .build()
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe.skipIf(!enabled)("shared scenarios against the real code-fixer (layer 2)", () => {
  sharedScenarios(async (): Promise<ScenarioContext> => {
    const appRoot = await isolatedCodeFixer()
    const mock: Aimock = await createAimock({ fixtures: await turnOneFixtures() })
    const app: SubprocessApp = await createSubprocessApp({
      appRoot,
      env: { OPENAI_BASE_URL: mock.baseUrl, OPENAI_API_KEY: "test-not-used" },
      readyTimeoutMs: 120_000,
    })
    const stateDir = await mkdtemp(join(tmpdir(), "factory-state-"))
    const outboxDir = join(appRoot, ".b4", "code-fixer", "review-outbox")
    await mkdir(outboxDir, { recursive: true })
    cleanups.push(async () => {
      await app.close()
      await mock.close()
      await rm(appRoot, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    })
    return {
      makeFactory: () =>
        createFactory({
          registryPath: join(stateDir, "registry.sqlite"),
          worker: createHttpWorkerClient(app.baseUrl),
          workerRoute: "/fix#agent",
          outboxDir,
          receiptWaitMs: 180_000,
          approvalTtlMs: 900_000,
        }),
      outboxDir,
      taskId: TASK,
      arrangeTurnTwo: async (candidate, digest) => {
        mock.addFixtures(
          script()
            .user(turnTwoPrompt(digest))
            .callsTool("exportForReview", { candidate })
            .replies("Review request handled.")
            .build(),
        )
      },
      timeoutMs: 240_000,
    }
  })

  it("leaves the code-fixer example untouched", () => {
    const status = spawnSync("git", ["status", "--short", "--", CODE_FIXER_ROOT], { encoding: "utf8" })
    expect(status.stdout.trim()).toBe("")
  })
})
```

Notes for the implementer:

- The outbox path mirrors `exportForReview.ts`: `<appRoot>/.b4/code-fixer/review-outbox`. The copy's `.b4` starts empty, so the factory sees only receipts this run produced.
- `createSubprocessApp` runs `b4 dev` from the copied app root; the code-fixer `workspace/` directory (with `.gitkeep`) is copied along, which `resolve-sandbox` requires.
- Two turns on one thread with `script().user(...)` groups is exactly what `examples/code-fixer/server/test/agent.integration.test.ts` does; if the second group does not match, compare the request journal (`mock.getRequests()`) against the fixture's `match` and adjust `turnIndex`, not the prompt.
- Docker verification runs twice (once in `prepareReview`, once in `exportForReview`), so the happy path takes minutes. That is why `timeoutMs` is 240 s and the vitest config allows 300 s.

- [ ] **Step 2: Run it locally**

```bash
cd <repo> && pnpm turbo run build --filter=@b4-example/code-fixer-server... && pnpm code-fixer:prepare
B4_TEST_DOCKER=1 pnpm --filter @b4-example/software-factory-server test:integration
```

Expected: 7 passed. Without `B4_TEST_DOCKER=1` the suite reports skipped.

- [ ] **Step 3: Add the CI step**

In `<repo>/.github/workflows/ci.yml`, in the `sandbox-docker` job, after the step named `Code-fixer approval and verifier recovery` and before `Both historical repair replays`, add:

```yaml
      - name: Software factory rung 0 against the real code-fixer
        run: B4_TEST_DOCKER=1 pnpm --filter @b4-example/software-factory-server test:integration
```

The preceding steps in that job already build the code-fixer example and prepare the image.

- [ ] **Step 4: Confirm the unit lane still runs everything and the example is clean**

```bash
pnpm --filter @b4-example/software-factory-server test
git status --short examples/code-fixer
```

Expected: all unit files pass; the second command prints nothing.

- [ ] **Step 5: Commit**

```bash
git add examples/software-factory/server/test/code-fixer.integration.test.ts .github/workflows/ci.yml
git commit -m "test(software-factory): drive the real code-fixer through the factory under Docker"
```

---

### Task 19: Documentation, live demonstration procedure, and the full gate

**Files:**
- Create: `<repo>/examples/software-factory/README.md`, `<repo>/docs/superpowers/runbooks/software-factory-rung0-live.md`
- Modify: `<repo>/examples/README.md`

- [ ] **Step 1: Write `examples/software-factory/README.md`**

```markdown
# Software factory (rung 0)

A work-order controller that drives the [code-fixer](../code-fixer) example over the
Agent Protocol. It is the first, deliberately narrow rung of the
[software factory program](../../docs/superpowers/specs/2026-09-16-software-factory-rfc.md);
the rung 0 design is in
[its spec](../../docs/superpowers/specs/2026-09-16-software-factory-rung0-design.md).

## What it proves

- The factory owns the lifecycle. A closed state machine, an append-only event journal, and a
  two-phase command log keyed by operation key live in `registry.sqlite`. Retrying a command
  returns the recorded outcome instead of repeating the effect.
- Workers are ordinary B4 `agent` routes reached over the Agent Protocol on loopback. The
  child thread id is committed before the run starts; cancel is propagated explicitly.
- Approval is a factory command against an exact candidate digest. Only then does the
  controller ask the worker to submit that candidate, and it resolves the worker's own
  `exportForReview` gate with the recorded approval. The receipt must carry the approved digest.
- Restart reconciliation never re-dispatches. It inspects the worker and the outbox and
  records what it concluded.

## What it does not do

No authentication (loopback only; do not expose it). No repair loop, no token budgets, one
task (`cli-flags`), no UI, and the code-fixer example is used exactly as shipped. Rung 1 moves
verification into the controller and replaces the shared-host outbox read.

## Run it

Terminal 1, the worker (needs Docker and the fixture image):

    cd examples/code-fixer/server && npm run sandbox:prepare && pnpm dev --port 4100

Terminal 2, the factory:

    cd examples/software-factory/server
    export FACTORY_WORKER_URL=http://127.0.0.1:4100
    export FACTORY_WORKER_OUTBOX=$PWD/../../code-fixer/server/.b4/code-fixer/review-outbox
    export FACTORY_STATE_DIR=$PWD/.factory
    pnpm factory create --task cli-flags
    pnpm factory dispatch <id> --wait
    pnpm factory approve <id> --revision <n> --digest <sha256>
    pnpm factory events <id>

`dispatch --wait` returns when the worker has produced a verified candidate. Approve with the
revision and digest it printed. `pnpm factory serve` exposes the same commands as JSON on
127.0.0.1.

## Tests

    pnpm test                      # layer 1: scripted fake Agent Protocol worker
    B4_TEST_DOCKER=1 pnpm test:integration   # layer 2: the real code-fixer under Docker
```

- [ ] **Step 2: Add the row to `examples/README.md`**

After the `research` row in the table, add:

```markdown
| [software-factory](./software-factory) | Rung 0 of the software factory: an application-owned work-order controller that drives the code-fixer worker over the Agent Protocol with exact-candidate approval, cancel, and restart reconciliation |
```

- [ ] **Step 3: Write the live demonstration runbook (procedure now, results when run)**

`docs/superpowers/runbooks/software-factory-rung0-live.md`:

```markdown
# Software factory rung 0: live demonstration

Status: procedure written; results section is filled in by the one recorded live run.
Spec: ../specs/2026-09-16-software-factory-rung0-design.md, section "Live demonstration".

This is evidence that the controller seam works with a real worker and a real model. It is
not a benchmark and it says nothing about repair quality beyond one fixture.

## Procedure

1. `nvm use 24`, `pnpm install`, `pnpm turbo run build --filter=@b4-example/code-fixer-server...`.
2. `pnpm code-fixer:prepare` (builds `b4-code-fixer:fixture-v1`).
3. Start the worker with a real key: `cd examples/code-fixer/server && OPENAI_API_KEY=... pnpm dev --port 4100`.
4. In `examples/software-factory/server`, with `FACTORY_WORKER_URL=http://127.0.0.1:4100`,
   `FACTORY_WORKER_OUTBOX=<code-fixer>/.b4/code-fixer/review-outbox`, `FACTORY_STATE_DIR=$PWD/.factory`:
   `pnpm factory create --task cli-flags`, then `pnpm factory dispatch <id> --wait`.
5. If the state is `candidate_ready`, `pnpm factory approve <id> --revision <n> --digest <d>`.
6. `pnpm factory events <id> > events.json`; copy the fields below from it and from the outbox.
7. Restart nothing, retry nothing. If the run fails or blocks, record that outcome; it is still evidence.

## Results

| Field | Value |
|---|---|
| Date | |
| Model (B4_CODE_FIXER_MODEL) | |
| Work order id | |
| Worker thread id (`thread_created` event) | |
| Candidate digest (`candidate_observed`) | |
| Final state | |
| Receipt path (`delivery_observed`) | |
| Receipt filename equals digest | yes / no |
| Premature export denied? (`premature_export_denied` present) | |
| Wall-clock from dispatch to candidate_ready | |
| Wall-clock from approve to exported | |
| Anything unexpected in the event log | |
```

- [ ] **Step 4: Run the full gate at the repo root**

```bash
cd <repo> && nvm use 24
pnpm lint && pnpm typecheck && pnpm test
git status --short examples/code-fixer
```

Expected: lint, typecheck and the vitest workspace all green with `software-factory` listed among the projects; the status command prints nothing. Then run `pnpm ci:validate` once; it is long, but the spec's success criterion 4 requires it green. Do not pipe it through `tail` (that hides the exit code).

- [ ] **Step 5: Run the live demonstration and fill in the runbook**

Follow the runbook procedure with a real key once. Paste the values into the results table. Commit the runbook with the results and `events.json` alongside it as `software-factory-rung0-live-events.json`.

- [ ] **Step 6: Commit**

```bash
git add examples/software-factory/README.md examples/README.md docs/superpowers/runbooks/software-factory-rung0-live.md docs/superpowers/runbooks/software-factory-rung0-live-events.json
git commit -m "docs(software-factory): rung 0 README, examples index, and live demonstration ledger"
```

- [ ] **Step 7: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill. The pull request description must list the five success criteria from the spec with evidence for each, and must state explicitly that `examples/code-fixer` is unchanged.

---

## Self-review against the spec

Spec coverage, requirement to task:

| Spec section | Tasks |
|---|---|
| Two processes, configuration | 8, 17 |
| Worker client, seven calls, never `always` | 10 |
| Prompts are constants | 8 |
| States, transition table, active accounting | 2, 12 |
| Where the candidate digest comes from | 12 |
| Commands, operation keys, two-phase | 7, 12, 13, 14 |
| Startup reconciliation rules 1 to 6 | 15 |
| Budgets | 11, 14 |
| Registry schema | 5, 6 |
| Layer 1 fake and behaviours | 9 |
| Layer 2 real code-fixer | 18 |
| Shared invariants | 16 (shared), 12 to 15 (fake-only) |
| Live demonstration | 19 |
| README and operator caveats | 19 |
| Success criteria 4 and 5 | 19 |

Known deviations, decided here:

- `active_started_at` is an extra column beyond the spec's schema; it is how the budget ticker measures the open interval without a separate timer table.
- `approve` waits for export confirmation before returning (spec: "returns only when the export has been confirmed or marked unconfirmed"); the CLI therefore blocks for the duration of two Docker verifications in layer 2. This is acceptable for rung 0 and is stated in the README.
- The fake emits `done` after an `interrupt` frame when a turn parks. If the real runtime is observed not to do this in layer 2, the turn observers already treat the end of the stream as the end of the turn, so no controller change is needed; update the fake to match what was observed.
