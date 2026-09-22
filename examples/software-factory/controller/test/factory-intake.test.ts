import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
import type { IssueOrigin, WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { digestGeneratedTask } from "../src/lib/intake/generated-task.ts"
import { taskPrompt } from "../src/lib/prompts.ts"
import { openRegistry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore, type WorkOrderPatch } from "../src/lib/registry/work-orders.ts"
import { configureCatalog, loadTask, resetCatalogForTests } from "../src/lib/targets/catalog.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier, type FakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"
import { BAD_DRAFTS, GOOD_DRAFT } from "./intake-fixtures.ts"

let dir: string
let generated: string
let fake: FakeWorker
let factory: Factory
let reader: FakeWorkspaceReader
let verifier: FakeVerifier

const registryPath = () => join(dir, "registry.sqlite")

const ORIGIN: IssueOrigin = {
  kind: "issue",
  repository: "cacheplane/b4run",
  number: 778,
  bodyDigest: "0".repeat(64),
}
const PIN = "a".repeat(40)
const ISSUE = {
  title: "spawnProcess leaks its deadline timer",
  body: "A spawn that fails asynchronously leaves the deadline running.",
}

/** The devkit file the drafted task lets a builder change, and one immutable test file. */
const SOURCE = "packages/devkit/src/testing/process.ts"
const BASELINE = new Map([
  [SOURCE, "export const deadline = 'leaks'\n"],
  ["packages/devkit/test/process.test.ts", "spec\n"],
])
const captureBaseline = async () => ({ digest: "a".repeat(64), files: BASELINE })
/** What the builder is deemed to have left behind on the generated task: the one repair. */
const repaired = () => ({
  ...Object.fromEntries(BASELINE),
  [SOURCE]: "export const deadline = 'cleared'\n",
})

async function bootWorker(options: Omit<FakeWorkerOptions, "outboxDir"> = {}) {
  dir = mkdtempSync(join(tmpdir(), "factory-intake-"))
  generated = join(dir, "state", "tasks")
  mkdirSync(join(dir, "out"), { recursive: true })
  // What the runtime does once per process: every `loadTask(id)` — the policy, the prompt
  // for the builder — then finds the task intake materialises under the work order's id.
  configureCatalog({ generatedTasksDir: generated })
  fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only", ...options })
  // The reader outlives each factory, exactly as the drafter's sandbox outlives a restart.
  reader = createFakeWorkspaceReader({})
  verifier = createFakeVerifier({ independent: "fail" })
}
/** `omit` drops options entirely: exactOptionalPropertyTypes forbids passing `undefined`. */
async function bootFactory(
  overrides: Partial<FactoryOptions> = {},
  omit: readonly (keyof FactoryOptions)[] = [],
) {
  const options: FactoryOptions = {
    registryPath: registryPath(),
    generatedTasksDir: generated,
    worker: createHttpWorkerClient(fake.baseUrl),
    workerRoute: "/build#agent",
    intakeRoute: "/intake#agent",
    intakeTaskId: "devkit-spawn-deadline",
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier,
    workspaceReader: reader,
    captureBaseline,
    ...overrides,
  }
  factory = await createFactory(
    Object.fromEntries(
      Object.entries(options).filter(([key]) => !omit.includes(key as keyof FactoryOptions)),
    ) as unknown as FactoryOptions,
  )
  return factory
}
async function boot(
  worker: Omit<FakeWorkerOptions, "outboxDir"> = {},
  overrides: Partial<FactoryOptions> = {},
) {
  await bootWorker(worker)
  await bootFactory(overrides)
}
afterEach(async () => {
  resetCatalogForTests()
  await factory?.close()
  await fake?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined as unknown as string
  fake = undefined as unknown as FakeWorker
  factory = undefined as unknown as Factory
  reader = undefined as unknown as FakeWorkspaceReader
})

const crash = () => factory.close()
const threadPosts = () => fake.requests.filter((r) => r.path === "/threads")
const runPosts = () =>
  fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/runs/stream"))
const cancels = () => fake.requests.filter((r) => r.path.endsWith("/cancel"))
/** The prompt the worker was sent on run `index`; throws when there was no such run. */
function promptOf(index: number): string {
  const post = runPosts()[index]
  if (!post) throw new Error(`no run ${index} was posted to the worker`)
  const body = post.body as { input: { messages: { content: string }[] } }
  return body.input.messages[0]?.content ?? ""
}
const eventTypes = (id: string) =>
  factory.events(id).map((e) => `${e.type}:${String(e.payload.event ?? "")}`)
const refusals = (id: string) => factory.events(id).filter((e) => e.type === "intake_refused")
const eventSeen = (id: string, type: string) => factory.events(id).some((e) => e.type === type)

const createIssue = () =>
  factory.createFromIssue({ origin: ORIGIN, pin: PIN, issue: ISSUE, operationKey: "issue:778" })

type Draft = Readonly<Record<string, string>>
/** Create from the issue, start intake, then script what the drafter's `draft/` will hold. */
async function intake(
  files: Draft | { readonly queue: readonly Draft[] } = GOOD_DRAFT,
): Promise<{ id: string; threadId: string }> {
  const { id } = await createIssue()
  const outcome = await factory.intake(id)
  expect(outcome).toEqual({ ok: true, state: "intake_running", message: "Intake started" })
  const threadId = (factory.show(id) as WorkOrderRow).workerThreadId as string
  if ("queue" in files && Array.isArray(files.queue)) reader.queue(threadId, files.queue)
  else reader.set(threadId, files as Draft)
  return { id, threadId }
}

/** Rewrite the row directly, the way a crash mid-phase would leave it. */
function forceRow(id: string, patch: WorkOrderPatch): void {
  const registry = openRegistry(registryPath())
  const rows = createWorkOrderStore(registry.db)
  const row = rows.get(id)
  if (!row) throw new Error(`no work order ${id}`)
  rows.update(id, row.revision, patch, new Date().toISOString())
  registry.close()
}

describe("intake", () => {
  it("runs the drafter turn, reads and proves the draft, and parks the generated task", async () => {
    await boot()
    const { id, threadId } = await intake()
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({
      state: "awaiting_intake_approval",
      targetId: "devkit",
      intakeAttempts: 1,
      workerThreadId: threadId,
      taskId: id,
      blockedReason: null,
      activeStartedAt: null,
    })
    // The digest is the directory's own, recomputed here from the bytes intake wrote, and the
    // catalog serves the generated task under the work order's id.
    expect(row.taskDigest).toBe(digestGeneratedTask(join(generated, id)))
    const task = loadTask(id)
    expect(task.target.id).toBe("devkit")
    expect(task.checks.independent.file).toBe("checks/spawn-deadline.test.ts")
    expect(readFileSync(join(generated, id, "issue.md"), "utf8")).toContain(ISSUE.title)

    expect(eventTypes(id)).toEqual([
      "created:",
      "intake_thread_created:",
      "transition:intake_started",
      "intake_run_started:",
      "intake_turn_ended:",
      "task_generated:",
      "oracle_receipt:",
      "transition:intake_drafted",
    ])
    const receipt = factory.events(id).find((e) => e.type === "oracle_receipt")?.payload
    expect(receipt).toMatchObject({ verdict: "fail", checkId: "independent", proven: true })
    expect(receipt?.receiptId).toMatch(/^rc-/)

    // The drafter thread is the intake stage's, on the intake route, prompted with the issue
    // and the four-file instruction.
    expect(threadPosts()).toHaveLength(1)
    expect(threadPosts()[0]?.body).toMatchObject({
      metadata: { factoryWorkOrderId: id, factoryStage: "intake" },
    })
    expect(runPosts()).toHaveLength(1)
    expect(runPosts()[0]?.body).toMatchObject({ route: "/intake#agent" })
    expect(promptOf(0)).toContain(ISSUE.title)
    expect(promptOf(0)).toContain("draft/task.json")
    // The proof ran the independent suite alone, over no changes, on the generated task.
    expect(verifier.calls).toHaveLength(1)
    expect(verifier.calls[0]).toMatchObject({
      mode: "independentOnly",
      changes: {},
      taskId: id,
      workOrderId: id,
      candidateDigest: "a".repeat(64),
    })
    expect(reader.reads).toEqual([threadId])
  })

  it("refuses a catalog work order, the wrong state, and an unconfigured intake", async () => {
    await boot()
    const catalog = await factory.create({ taskId: "cli-flags" })
    expect(await factory.intake(catalog.id)).toEqual({
      ok: false,
      state: "received",
      message: "Cannot intake a catalog work order",
    })
    const { id } = await intake()
    await factory.settleIntake(id, 20_000)
    expect(await factory.intake(id)).toEqual({
      ok: false,
      state: "awaiting_intake_approval",
      message: "Cannot intake from awaiting_intake_approval",
    })
    expect(threadPosts()).toHaveLength(1)

    await factory.close()
    await bootFactory({}, ["intakeTaskId"])
    const fresh = await factory.createFromIssue({ origin: ORIGIN, pin: PIN, issue: ISSUE })
    expect(await factory.intake(fresh.id)).toEqual({
      ok: false,
      state: "received",
      message: "intake is not configured: set FACTORY_INTAKE_TASK",
    })
    // Refused before a thread is spent.
    expect(threadPosts()).toHaveLength(1)
  })

  it("blocks on an unknown target after one attempt: no redraft can prepare one", async () => {
    await boot()
    const { id } = await intake(BAD_DRAFTS.badTarget as Draft)
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({
      state: "blocked",
      blockedReason: "no_target_for_package",
      intakeAttempts: 1,
      targetId: null,
      taskDigest: null,
    })
    expect(runPosts()).toHaveLength(1)
    expect(refusals(id)).toHaveLength(1)
    expect(refusals(id)[0]?.payload).toMatchObject({
      blockedReason: "no_target_for_package",
      attempt: 1,
    })
    expect(String(refusals(id)[0]?.payload.reason)).toMatch(/no-such-target/)
    expect(eventTypes(id)).not.toContain("transition:intake_retry")
    expect(eventTypes(id).at(-1)).toBe("transition:intake_blocked")
  })

  it("retries an invalid draft on the same thread with the refusal quoted, then parks", async () => {
    await boot({}, { maxIntakeAttempts: 2 })
    const { id, threadId } = await intake({
      queue: [BAD_DRAFTS.acceptanceMismatch as Draft, GOOD_DRAFT],
    })
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({
      state: "awaiting_intake_approval",
      intakeAttempts: 2,
      workerThreadId: threadId,
    })
    expect(threadPosts()).toHaveLength(1)
    expect(runPosts()).toHaveLength(2)
    expect(reader.reads).toEqual([threadId, threadId])
    const [refusal] = refusals(id)
    expect(refusal?.payload).toMatchObject({ blockedReason: "intake_invalid", attempt: 1 })
    const reason = String(refusal?.payload.reason)
    expect(reason).toMatch(/spec\.md states/)
    const types = eventTypes(id)
    expect(types.indexOf("intake_refused:")).toBeLessThan(types.indexOf("transition:intake_retry"))
    expect(types.at(-1)).toBe("transition:intake_drafted")
    // The second turn is told what was wrong with the first.
    expect(promptOf(0)).not.toContain("Previous attempt was refused")
    expect(promptOf(1)).toContain("Previous attempt was refused")
    expect(promptOf(1)).toContain(reason)
  })

  it("blocks as attempts exhausted when the redraft is still invalid", async () => {
    await boot({}, { maxIntakeAttempts: 2 })
    const { id } = await intake(BAD_DRAFTS.acceptanceMismatch as Draft)
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({
      state: "blocked",
      blockedReason: "intake_attempts_exhausted",
      intakeAttempts: 2,
    })
    expect(runPosts()).toHaveLength(2)
    expect(refusals(id)).toHaveLength(2)
    // The row says the attempts ran out; the journal says what the last one was refused for.
    expect(refusals(id)[1]?.payload).toMatchObject({ blockedReason: "intake_invalid", attempt: 2 })
    expect(eventTypes(id).filter((t) => t === "transition:intake_retry")).toHaveLength(1)
  })

  it("refuses a check that does not fail on the baseline, and exhausts the attempts on it", async () => {
    await boot({}, { maxIntakeAttempts: 2 })
    verifier.script = { independent: "pass" }
    const { id } = await intake()
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({
      state: "blocked",
      blockedReason: "intake_attempts_exhausted",
      intakeAttempts: 2,
      taskDigest: null,
    })
    expect(verifier.calls).toHaveLength(2)
    expect(refusals(id)).toHaveLength(2)
    expect(refusals(id)[1]?.payload).toMatchObject({ blockedReason: "oracle_did_not_fail" })
    expect(String(refusals(id)[1]?.payload.reason)).toMatch(/did not fail.*pass \(independent\)/)
    const receipts = factory.events(id).filter((e) => e.type === "oracle_receipt")
    expect(receipts).toHaveLength(2)
    expect(receipts[0]?.payload).toMatchObject({ verdict: "pass", proven: false })
    expect(promptOf(1)).toContain("did not fail on the unpatched baseline")
  })

  it("blocks as a failed run, not a spent attempt, when the harness cannot run", async () => {
    await boot()
    verifier.script = { throws: "docker is down" }
    const { id } = await intake()
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({
      state: "blocked",
      blockedReason: "intake_run_failed",
      intakeAttempts: 0,
    })
    expect(refusals(id)).toHaveLength(0)
    expect(eventSeen(id, "verifier_unavailable")).toBe(true)
  })

  it("adopts the thread a crashed intake journalled instead of creating a second one", async () => {
    await boot()
    const { id } = await createIssue()
    // The exact window: the thread exists on the worker and is journalled, but the process
    // died before `intake_started` reached the row.
    const created = await fetch(`${fake.baseUrl}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { factoryWorkOrderId: id, factoryStage: "intake" } }),
    })
    const { thread_id: threadId } = (await created.json()) as { thread_id: string }
    const registry = openRegistry(registryPath())
    createWorkOrderStore(registry.db).appendEvent(
      id,
      "intake_thread_created",
      { threadId },
      new Date().toISOString(),
    )
    registry.close()
    expect(await factory.intake(id)).toMatchObject({ ok: true, state: "intake_running" })
    reader.set(threadId, GOOD_DRAFT)
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({ state: "awaiting_intake_approval", workerThreadId: threadId })
    expect(threadPosts()).toHaveLength(1)
    expect(factory.events(id).filter((e) => e.type === "intake_thread_created")).toHaveLength(1)
  })

  it("blocks as a failed run when the drafter parks on a prompt", async () => {
    await boot({ run: "unexpected_interrupt" })
    const { id } = await intake()
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({
      state: "blocked",
      blockedReason: "intake_run_failed",
      intakeAttempts: 0,
    })
    expect(row.interruptId).toMatch(/^perm-cmd-/)
    expect(eventSeen(id, "intake_unexpected_interrupt")).toBe(true)
    expect(reader.reads).toEqual([])
  })

  it("blocks as a failed run when the drafter turn ends in error", async () => {
    await boot({ run: "route_error" })
    const { id } = await intake()
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({ state: "blocked", blockedReason: "intake_run_failed" })
    expect(factory.events(id).at(-1)?.payload).toMatchObject({
      event: "intake_blocked",
      error: "route exploded",
    })
    expect(reader.reads).toEqual([])
  })

  it("blocks as a failed run when the drafter turn cannot be started", async () => {
    await boot({}, { maxIntakeAttempts: 3 })
    const { id } = await intake()
    await factory.settleIntake(id, 20_000)
    // The worker goes away between the rejection and the redraft it starts.
    await fake.close()
    expect(await factory.rejectIntake(id, { note: "redo" })).toMatchObject({
      ok: true,
      state: "intake_running",
    })
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({ state: "blocked", blockedReason: "intake_run_failed" })
    expect(factory.events(id).find((e) => e.type === "stream_lost")?.payload).toMatchObject({
      phase: "intake_start",
    })
  })
})

describe("the intake gate", () => {
  it("approves only the digest on disk, then dispatch runs rung 2 on the generated task", async () => {
    await boot()
    const { id } = await intake()
    const parked = await factory.settleIntake(id, 20_000)
    const taskDigest = parked.taskDigest as string

    expect(await factory.approveIntake(id, { revision: parked.revision + 1, taskDigest })).toEqual({
      ok: false,
      state: "awaiting_intake_approval",
      message: `Stale revision ${parked.revision + 1}; work order is at ${parked.revision}`,
    })
    expect(
      await factory.approveIntake(id, { revision: parked.revision, taskDigest: "b".repeat(64) }),
    ).toMatchObject({ ok: false, message: "Task digest does not match the work order's" })
    // A file edited under the directory after intake: the gate recomputes, and refuses even
    // the digest the row holds.
    const spec = join(generated, id, "spec.md")
    const original = readFileSync(spec)
    writeFileSync(spec, `${original.toString("utf8")}\nA9: something else\n`)
    const refusedOnDisk = {
      ok: false,
      state: "awaiting_intake_approval",
      message: "Task digest does not match the generated task on disk",
    }
    expect(await factory.approveIntake(id, { revision: parked.revision, taskDigest })).toEqual(
      refusedOnDisk,
    )
    // The same call over the same bytes replays the refusal; a restored file is a new intent
    // under the default key, so the approval below is not the replay of this refusal.
    expect(await factory.approveIntake(id, { revision: parked.revision, taskDigest })).toEqual(
      refusedOnDisk,
    )
    writeFileSync(spec, original)
    expect(factory.show(id)?.state).toBe("awaiting_intake_approval")

    const approved = await factory.approveIntake(id, { revision: parked.revision, taskDigest })
    expect(approved).toEqual({ ok: true, state: "received", message: "Intake approved" })
    expect(factory.show(id)).toMatchObject({ state: "received", taskDigest, targetId: "devkit" })
    expect(factory.events(id).at(-1)).toMatchObject({
      type: "intake_approved",
      payload: { taskDigest },
    })
    // Its own key: the row is now at `parked.revision + 1`, the revision the stale probe above
    // named over the same digests, and under the default key that same intent would replay.
    expect(
      await factory.approveIntake(id, {
        revision: parked.revision + 1,
        taskDigest,
        operationKey: "after-approval",
      }),
    ).toEqual({ ok: false, state: "received", message: "Cannot approve intake from received" })

    // The approved task is bound to the row until dispatch: no redraft over it, and no
    // dispatch of a directory that no longer matches what was approved.
    expect(await factory.intake(id)).toEqual({
      ok: false,
      state: "received",
      message: "Work order already has an approved task; reject-intake is the only way back",
    })
    writeFileSync(spec, `${original.toString("utf8")}\nA9: something else\n`)
    expect(await factory.dispatch(id, "dispatch-edited")).toEqual({
      ok: false,
      state: "received",
      message: "Generated task on disk no longer matches the approved digest",
    })
    expect(factory.events(id).at(-1)).toMatchObject({
      type: "generated_task_changed",
      payload: { phase: "dispatch", approved: taskDigest },
    })
    writeFileSync(spec, original)
    expect(threadPosts()).toHaveLength(1)

    // Rung 2 from here: the builder gets its own thread, the generated task's prompt, and the
    // full verification of what it left behind.
    verifier.script = { verdict: "pass" }
    expect(await factory.dispatch(id)).toEqual({
      ok: true,
      state: "dispatched",
      message: "Dispatched",
    })
    const dispatched = await factory.waitFor(id, (r) => r.state !== "received")
    const builderThread = dispatched.workerThreadId as string
    expect(builderThread).not.toBe(parked.workerThreadId)
    reader.set(builderThread, repaired())
    const row = await factory.settle(id, 20_000)
    expect(row).toMatchObject({ state: "awaiting_approval", taskDigest, targetId: "devkit" })
    expect(row.candidateDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(threadPosts()).toHaveLength(2)
    expect(threadPosts()[1]?.body).toMatchObject({ metadata: { factoryWorkOrderId: id } })
    expect(runPosts()[1]?.body).toMatchObject({
      route: "/build#agent",
      input: { messages: [{ role: "user", content: taskPrompt(loadTask(id)) }] },
    })
    expect(verifier.calls[1]).toMatchObject({
      taskId: id,
      changes: { [SOURCE]: repaired()[SOURCE] },
    })
    expect(verifier.calls[1]?.mode).toBeUndefined()
  })

  it("rejects with a note that the next drafter turn quotes, and blocks once attempts run out", async () => {
    await boot({}, { maxIntakeAttempts: 2 })
    const { id, threadId } = await intake()
    await factory.settleIntake(id, 20_000)
    const note = "the check should exercise the async failure path, not the sync one"
    expect(await factory.rejectIntake(id, { note })).toEqual({
      ok: true,
      state: "intake_running",
      message: "Intake rejected; redrafting",
    })
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({
      state: "awaiting_intake_approval",
      intakeAttempts: 2,
      workerThreadId: threadId,
    })
    expect(threadPosts()).toHaveLength(1)
    expect(runPosts()).toHaveLength(2)
    expect(promptOf(1)).toContain("Previous attempt was refused")
    expect(promptOf(1)).toContain(note)
    expect(factory.events(id).find((e) => e.type === "intake_rejected")?.payload).toEqual({
      note,
      attempt: 1,
    })
    expect(eventTypes(id)).toContain("transition:reject_intake")

    expect(await factory.rejectIntake(id, { note: "still wrong" })).toEqual({
      ok: true,
      state: "blocked",
      message: "Intake rejected; no drafter attempts remain",
    })
    expect(factory.show(id)).toMatchObject({
      state: "blocked",
      blockedReason: "intake_attempts_exhausted",
      intakeAttempts: 2,
    })
    expect(runPosts()).toHaveLength(2)
    expect(await factory.rejectIntake(id, { note: "again" })).toMatchObject({
      ok: false,
      message: "Cannot reject intake from blocked",
    })
  })

  it("cancels a drafter turn in flight", async () => {
    await boot({ run: "hang" })
    const { id, threadId } = await intake()
    await factory.waitFor(id, () => eventSeen(id, "intake_run_started"))
    expect(await factory.cancel(id)).toEqual({ ok: true, state: "cancelled", message: "Cancelled" })
    expect(cancels()).toHaveLength(1)
    expect(cancels()[0]?.path).toContain(threadId)
    const types = eventTypes(id)
    expect(types).toContain("intake_run_cancelled_observed:")
    expect(types.indexOf("worker_cancel:")).toBeLessThan(
      types.indexOf("transition:run_ended_after_cancel"),
    )
    expect(factory.show(id)).toMatchObject({ state: "cancelled", intakeAttempts: 0 })
    // Nothing was drafted: no read, no proof.
    expect(reader.reads).toEqual([])
    expect(verifier.calls).toEqual([])
  })
})

describe("intake reconciliation", () => {
  it("finishes an intake whose turn ended while nobody watched", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await createIssue()
    await crash()
    // The exact window a restart leaves: the drafter thread exists and is idle, the row says
    // intake_running, and no run is tracked.
    const created = await fetch(`${fake.baseUrl}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { factoryWorkOrderId: id, factoryStage: "intake" } }),
    })
    const { thread_id: threadId } = (await created.json()) as { thread_id: string }
    forceRow(id, { state: "intake_running", workerThreadId: threadId })
    reader.set(threadId, GOOD_DRAFT)
    await bootFactory()
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({
      state: "awaiting_intake_approval",
      targetId: "devkit",
      intakeAttempts: 1,
      workerThreadId: threadId,
    })
    expect(row.taskDigest).toBe(digestGeneratedTask(join(generated, id)))
    expect(factory.events(id).find((e) => e.type === "reconciled")?.payload).toMatchObject({
      resolution: "finish_intake",
      status: "idle",
    })
    // Never re-dispatched: no new thread and no new turn.
    expect(runPosts()).toHaveLength(0)
    expect(reader.reads).toEqual([threadId])
  })

  it("blocks an intake_running row with no thread as a failed run", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await createIssue()
    await crash()
    forceRow(id, { state: "intake_running" })
    await bootFactory()
    expect(factory.show(id)).toMatchObject({ state: "blocked", blockedReason: "intake_run_failed" })
    expect(factory.events(id).at(-1)?.payload).toMatchObject({
      event: "intake_blocked",
      reconciled: true,
      reason: "no thread recorded",
    })
    expect(threadPosts()).toHaveLength(0)
  })

  it("blocks an intake_running row whose thread the worker does not have", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await createIssue()
    await crash()
    forceRow(id, { state: "intake_running", workerThreadId: "gone-thread" })
    await bootFactory()
    expect(factory.show(id)).toMatchObject({ state: "blocked", blockedReason: "intake_run_failed" })
    expect(factory.events(id).at(-1)?.payload).toMatchObject({
      reconciled: true,
      reason: "thread not found on worker",
    })
  })

  it("blocks an intake_running row whose thread is parked on a prompt", async () => {
    await bootWorker({ run: "unexpected_interrupt" })
    await bootFactory()
    const { id } = await createIssue()
    await crash()
    const created = await fetch(`${fake.baseUrl}/threads`, { method: "POST" })
    const { thread_id: threadId } = (await created.json()) as { thread_id: string }
    // A turn nobody watched parks the thread on a prompt the drafter route cannot have.
    await fetch(`${fake.baseUrl}/threads/${threadId}/runs/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "/intake#agent", input: { messages: [] } }),
    }).then((r) => r.text())
    expect(fake.thread(threadId)?.pending).not.toBeNull()
    forceRow(id, { state: "intake_running", workerThreadId: threadId })
    await bootFactory()
    const row = factory.show(id)
    expect(row).toMatchObject({ state: "blocked", blockedReason: "intake_run_failed" })
    expect(row?.interruptId).toMatch(/^perm-cmd-/)
    expect(factory.events(id).at(-1)?.payload).toMatchObject({
      reconciled: true,
      reason: "the drafter is parked on an unexpected prompt",
      kinds: ["command"],
    })
    expect(reader.reads).toEqual([])
  })

  it("reattaches once to a drafter turn still live after a restart", async () => {
    await bootWorker({ run: "hang" })
    await bootFactory()
    const { id } = await intake()
    await factory.waitFor(id, () => eventSeen(id, "intake_run_started"))
    await crash()
    await bootFactory()
    const reattaches = fake.requests.filter(
      (r) => r.method === "GET" && r.path.endsWith("/runs/stream"),
    )
    expect(reattaches).toHaveLength(1)
    expect(factory.events(id).filter((e) => e.type === "reattached")).toHaveLength(1)
    expect(factory.show(id)?.state).toBe("intake_running")
    expect(runPosts()).toHaveLength(1)
  })

  it("does not reconcile an intake a live observer already owns", async () => {
    await boot({ run: "hang" })
    const { id, threadId } = await intake()
    await factory.waitFor(id, () => eventSeen(id, "intake_run_started"))
    const before = fake.requests.length
    await factory.reconcileWorkOrder(id)
    expect(fake.requests).toHaveLength(before)
    expect(factory.events(id).at(-1)).toMatchObject({
      type: "reconcile_skipped",
      payload: { threadId, reason: "observer_live" },
    })
    expect(factory.show(id)?.state).toBe("intake_running")
  })
})
