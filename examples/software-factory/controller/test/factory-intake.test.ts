import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadWorkspaceReadError } from "@b4run/cli/workspace"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import { stagedReferenceOf } from "../src/lib/builder-handoff.ts"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
import { DRAFTER_UNCONFIGURED } from "../src/lib/controller/workers.ts"
import type { IssueOrigin, WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { DrafterHandoffSchema } from "../src/lib/drafter-handoff.ts"
import { digestGeneratedTask } from "../src/lib/intake/generated-task.ts"
import { taskPrompt } from "../src/lib/prompts.ts"
import { createCommandLog } from "../src/lib/registry/commands.ts"
import { openRegistry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore, type WorkOrderPatch } from "../src/lib/registry/work-orders.ts"
import { createArtifactStore } from "../src/lib/storage/artifacts.ts"
import {
  configureCatalog,
  configuredImages,
  loadTargetRecipe,
  loadTask,
  resetCatalogForTests,
} from "../src/lib/targets/catalog.ts"
import { type ImageRegistry, openImageRegistry } from "../src/lib/targets/images.ts"
import { assembleReceipt, evidenceRef } from "../src/lib/verification/receipt.ts"
import type { Verifier } from "../src/lib/verification/verifier.ts"
import { createHttpWorkerClient, type WorkerClient } from "../src/lib/worker/client.ts"
import {
  type WorkspaceReader,
  WorkspaceRootMissingError,
} from "../src/lib/worker/workspace-reader.ts"
import { fakeImageBuilder } from "./fake-image-builder.ts"
import { createFakeVerifier, type FakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"
import { fakeBuilderHandoff, fakeWorkerMap } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"
import { BAD_DRAFTS, GOOD_DRAFT } from "./intake-fixtures.ts"
import { useImages } from "./static-images.ts"
import { createEmptyRepo, repositoryHead, shippedPin } from "./temp-repo.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

let dir: string
let generated: string
/** The DRAFTER: the worker the intake thread lives on, and the one a test's run behaviour scripts. */
let fake: FakeWorker
/** The builder: a second process, where dispatch creates the builder thread. */
let builder: FakeWorker
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
/**
 * The pin every issue here names: a commit this repository holds (`intake` checks the pin
 * is one the controller can find before it captures the workspace, and an invented sha would
 * send it fetching), and the one the shipped targets hold images at (the draft's target is
 * looked up at the work order's pin).
 */
const PIN = shippedPin("devkit")
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

/** The drafter's staged source in these tests: one small file, where the real one is tens of MiB. */
const DRAFT_SOURCE = createSourceBundle([
  { path: "repo/README.md", bytes: new TextEncoder().encode("# fixture\n"), executable: false },
])
/** The captures taken this test, in order: what the drafter would be handed. */
let captures: { workOrderId: string; pin: string }[]
/**
 * Stands in for the wide capture: the pin here is not a commit of any repository, and the
 * real capture is tens of MiB. Returns a real source and the handoff naming it, which intake
 * uploads and creates the thread with, as it does the real one.
 */
const fakeDrafterHandoff: NonNullable<FactoryOptions["captureDrafterHandoff"]> = async ({
  workOrderId,
  pin,
}) => {
  captures.push({ workOrderId, pin })
  const workspace = { version: 1 as const, source: DRAFT_SOURCE, environmentLinks: [] }
  const handoff = DrafterHandoffSchema.parse({
    version: 2,
    workOrderId,
    workspace: stagedReferenceOf(workspace),
  })
  return { handoff, workspace }
}

async function bootWorker(options: Omit<FakeWorkerOptions, "outboxDir"> = {}) {
  dir = mkdtempSync(join(tmpdir(), "factory-intake-"))
  generated = join(dir, "state", "tasks")
  mkdirSync(join(dir, "out"), { recursive: true })
  // What the runtime does once per process: every `loadTask(id)` — the policy, the prompt
  // for the builder — then finds the task intake materialises under the work order's id.
  configureCatalog({ generatedTasksDir: generated })
  // Two processes, as deployed: the run behaviour a test scripts is the DRAFTER's turn.
  fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only", ...options })
  // Its first thread is named apart from the drafter's: each fake numbers its own threads,
  // and a test that compares the two ids must not be fooled by two `fake-thread-1`s.
  builder = await createFakeWorker({
    outboxDir: join(dir, "unused"),
    run: "edits_only",
    threadId: "builder-thread-1",
  })
  // The reader outlives each factory, exactly as the drafter's sandbox outlives a restart.
  reader = createFakeWorkspaceReader({})
  verifier = createFakeVerifier({ independent: "fail" })
  captures = []
}
interface BootOverrides extends Partial<Omit<FactoryOptions, "workers">> {
  /** The drafter's reader; the shared fake by default. */
  readonly drafterReader?: WorkspaceReader
  /** `false`: no drafter in the map, as a controller without the drafter pair boots. */
  readonly withDrafter?: boolean
  /** Wraps the drafter's client, e.g. to hold or fail a thread creation. */
  readonly drafterClient?: (client: WorkerClient) => WorkerClient
}
async function bootFactory(overrides: BootOverrides = {}) {
  const { drafterReader, withDrafter = true, drafterClient = (c) => c, ...rest } = overrides
  factory = await createFactory({
    registryPath: registryPath(),
    generatedTasksDir: generated,
    captureRoot: dir,
    workers: fakeWorkerMap({
      // One reader serves both stages: the drafter's `draft/` and the builder's candidate are
      // scripted under their own thread ids, and the fake ignores the task and the root.
      builder: {
        client: createHttpWorkerClient(builder.baseUrl, { token: TEST_WORKER_TOKEN }),
        reader,
      },
      ...(withDrafter
        ? {
            drafter: {
              client: drafterClient(
                createHttpWorkerClient(fake.baseUrl, { token: TEST_WORKER_TOKEN }),
              ),
              reader: drafterReader ?? reader,
            },
          }
        : {}),
    }),
    captureBuilderHandoff: fakeBuilderHandoff,
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier,
    captureBaseline,
    captureDrafterHandoff: fakeDrafterHandoff,
    ...rest,
  })
  return factory
}
async function boot(
  worker: Omit<FakeWorkerOptions, "outboxDir"> = {},
  overrides: BootOverrides = {},
) {
  await bootWorker(worker)
  await bootFactory(overrides)
}
afterEach(async () => {
  resetCatalogForTests()
  delete process.env.FACTORY_REPO_ROOT
  delete process.env.FACTORY_NO_FETCH
  await factory?.close()
  await fake?.close()
  await builder?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined as unknown as string
  fake = undefined as unknown as FakeWorker
  builder = undefined as unknown as FakeWorker
  factory = undefined as unknown as Factory
  reader = undefined as unknown as FakeWorkspaceReader
})

const crash = () => factory.close()
/** The drafter's requests: every intake thread and turn lands on it. */
const threadPosts = () => fake.requests.filter((r) => r.path === "/threads")
const runPosts = () =>
  fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/runs/stream"))
const cancels = () => fake.requests.filter((r) => r.path.endsWith("/cancel"))
const resumes = () => fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/resume"))
/** The builder's: nothing before dispatch. */
const builderThreadPosts = () => builder.requests.filter((r) => r.path === "/threads")
const builderRunPosts = () =>
  builder.requests.filter((r) => r.method === "POST" && r.path.endsWith("/runs/stream"))
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
/**
 * What intake journals when it hands a thread its workspace: the staged source's digest,
 * then the thread that holds it. A test that fakes a crash window journals both, as intake
 * does, because the controller reads the thread back only with the digest it handed.
 */
function journalHandoff(id: string, threadId: string): void {
  const registry = openRegistry(registryPath())
  const events = createWorkOrderStore(registry.db)
  const at = new Date().toISOString()
  events.appendEvent(
    id,
    "drafter_source_staged",
    { sourceDigest: DRAFT_SOURCE.digest, status: "created" },
    at,
  )
  events.appendEvent(id, "intake_thread_created", { threadId }, at)
  registry.close()
}

/** Append one event to the journal directly, as a controller that died mid-step left it. */
function journalEvent(id: string, type: string, payload: Record<string, unknown>): void {
  const registry = openRegistry(registryPath())
  const events = createWorkOrderStore(registry.db)
  events.appendEvent(id, type, payload, new Date().toISOString())
  registry.close()
}

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
      "drafter_source_staged:",
      "intake_thread_created:",
      "transition:intake_started",
      "intake_run_started:",
      "intake_turn_ended:",
      "draft_read:",
      "image_bound:",
      "task_generated:",
      "oracle_receipt:",
      "transition:intake_drafted",
    ])
    const receipt = factory.events(id).find((e) => e.type === "oracle_receipt")?.payload
    expect(receipt).toMatchObject({ verdict: "fail", checkId: "independent", proven: true })
    expect(receipt?.receiptId).toMatch(/^rc-/)

    // The drafter thread is the intake stage's, on the DRAFTER and its route, prompted with
    // the issue and the four-file instruction; the builder heard nothing.
    expect(threadPosts()).toHaveLength(1)
    // With its handoff, and the staged workspace the handoff names.
    const created = threadPosts()[0]?.body as {
      metadata: Record<string, unknown>
      workspace: unknown
    }
    expect(created.metadata).toEqual({
      factoryWorkOrderId: id,
      factoryStage: "intake",
      factoryDrafter: {
        version: 2,
        workOrderId: id,
        workspace: { sourceDigest: DRAFT_SOURCE.digest, environmentLinks: [] },
      },
    })
    expect(created.workspace).toEqual({ sourceDigest: DRAFT_SOURCE.digest, environmentLinks: [] })
    expect(builder.requests).toEqual([])
    expect(row.workerRoute).toBe("/intake#agent")
    expect(runPosts()).toHaveLength(1)
    expect(runPosts()[0]?.body).toMatchObject({ route: "/intake#agent" })
    // The workspace was captured for this work order, at the row's pin, and uploaded to the
    // drafter BEFORE the thread was created, with the token.
    expect(captures).toEqual([{ workOrderId: id, pin: PIN }])
    const upload = fake.requests.findIndex((r) => r.method === "PUT")
    expect(fake.requests[upload]?.path).toBe(`/workspace/sources/${DRAFT_SOURCE.digest}`)
    expect(fake.requests[upload]?.authorization).toBe(`Bearer ${TEST_WORKER_TOKEN}`)
    expect(upload).toBeLessThan(fake.requests.findIndex((r) => r.path === "/threads"))
    expect(factory.events(id).find((e) => e.type === "drafter_source_staged")?.payload).toEqual({
      sourceDigest: DRAFT_SOURCE.digest,
      status: "created",
    })
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
    // The read named the source intake handed the thread: the worker must answer with it.
    expect(reader.targets).toEqual([{ threadId, sourceDigest: DRAFT_SOURCE.digest }])
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
    await bootFactory({ withDrafter: false })
    const fresh = await factory.createFromIssue({ origin: ORIGIN, pin: PIN, issue: ISSUE })
    expect(await factory.intake(fresh.id)).toEqual({
      ok: false,
      state: "received",
      message: DRAFTER_UNCONFIGURED,
    })
    // Refused before a thread is spent, before a workspace is staged, and before the key is:
    // the operator configures the drafter and restarts, and the same call under the default
    // key is not a replayed refusal.
    expect(threadPosts()).toHaveLength(1)
    expect(captures).toHaveLength(1)
    await factory.close()
    await bootFactory()
    expect(await factory.intake(fresh.id)).toEqual({
      ok: true,
      state: "intake_running",
      message: "Intake started",
    })
    reader.set((factory.show(fresh.id) as WorkOrderRow).workerThreadId as string, GOOD_DRAFT)
    expect((await factory.settleIntake(fresh.id, 20_000)).state).toBe("awaiting_intake_approval")
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
    // The block is the last word: nothing was written for the drafter, so nothing is removed.
    expect(eventTypes(id).at(-1)).toBe("transition:intake_blocked")
  })

  it("offers and fits a target at a pin no image was built at", async () => {
    await boot({}, { maxIntakeAttempts: 2 })
    const head = repositoryHead().pin
    expect(head).not.toBe(PIN)
    const { id } = await factory.createFromIssue({ origin: ORIGIN, pin: head, issue: ISSUE })
    expect(await factory.intake(id)).toMatchObject({ ok: true, state: "intake_running" })
    const threadId = (factory.show(id) as WorkOrderRow).workerThreadId as string
    reader.set(threadId, GOOD_DRAFT)
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({ state: "awaiting_intake_approval", targetId: "devkit" })
    expect(promptOf(0)).toContain("- `devkit`")
    expect(refusals(id)).toHaveLength(0)
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
    // The refused draft is kept where the operator can read it after the retry overwrote
    // the drafter's own `draft/`, beside the reason, and the journal says where.
    const kept = join(generated, ".refused", id, "attempt-1")
    expect(refusal?.payload).toMatchObject({
      keptAt: kept,
      keptFiles: ["checks.json", "checks/spawn-deadline.test.ts", "spec.md", "task.json"],
    })
    expect(readFileSync(join(kept, "spec.md"), "utf8")).toBe(
      (BAD_DRAFTS.acceptanceMismatch as Draft)["draft/spec.md"],
    )
    expect(readFileSync(join(kept, "reason.txt"), "utf8")).toBe(`attempt 1: ${reason}\n`)
    // Outside the task directory: the approved digest is over the task alone.
    const row2 = factory.show(id) as WorkOrderRow
    expect(digestGeneratedTask(join(generated, id))).toBe(row2.taskDigest)
    expect(existsSync(join(generated, id, "refused"))).toBe(false)
    // The second turn is told what was wrong with the first.
    expect(promptOf(0)).not.toContain("Previous attempt was refused")
    expect(promptOf(1)).toContain("Previous attempt was refused")
    expect(promptOf(1)).toContain(reason)
  })

  it("keeps a refused draft's hostile keys inside its own directory", async () => {
    await boot({}, { maxIntakeAttempts: 2 })
    const hostile = { ...GOOD_DRAFT, "draft/../../escape.txt": "x", "draft/reason.txt": "forged" }
    const { id } = await intake({ queue: [hostile, GOOD_DRAFT] })
    expect(await factory.settleIntake(id, 20_000)).toMatchObject({
      state: "awaiting_intake_approval",
    })
    const kept = join(generated, ".refused", id, "attempt-1")
    expect(refusals(id)[0]?.payload.keptFiles).toEqual([
      "checks.json",
      "checks/spawn-deadline.test.ts",
      "spec.md",
      "task.json",
    ])
    expect(existsSync(join(generated, ".refused", "escape.txt"))).toBe(false)
    expect(existsSync(join(generated, "escape.txt"))).toBe(false)
    const reasonText = readFileSync(join(kept, "reason.txt"), "utf8")
    expect(reasonText).toMatch(/^attempt 1: draft file .* is not a canonical relative path/)
    expect(reasonText).toContain(
      'Not copied (not a canonical path under draft/): "draft/../../escape.txt", "draft/reason.txt"',
    )
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
    // The blocking transition agrees with the row, and carries the last refusal beside it.
    const blocked = factory
      .events(id)
      .find((e) => e.type === "transition" && e.payload.event === "intake_blocked")
    expect(blocked?.payload).toMatchObject({
      blockedReason: "intake_attempts_exhausted",
      lastRefusal: "intake_invalid",
      attempt: 2,
    })
    // Both attempts' drafts are kept, each with its own reason.
    for (const attempt of [1, 2])
      expect(
        readFileSync(join(generated, ".refused", id, `attempt-${attempt}`, "reason.txt"), "utf8"),
      ).toMatch(new RegExp(`^attempt ${attempt}: draft/spec\\.md states \\[A1, A2\\]`))
    expect(eventTypes(id).filter((t) => t === "transition:intake_retry")).toHaveLength(1)
    // The retry redrafted on the same thread: one capture, one upload, for both attempts.
    expect(captures).toHaveLength(1)
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(1)
  })

  it("refuses the intake, with nothing to remove, when the drafter thread cannot be created", async () => {
    await boot()
    const { id } = await createIssue()
    await factory.close()
    await bootFactory({
      drafterClient: (client) => ({
        ...client,
        createThread: async () => {
          throw new Error("drafter down")
        },
      }),
    })
    expect(await factory.intake(id)).toMatchObject({
      ok: false,
      state: "received",
      message: expect.stringMatching(/^Thread creation failed/),
    })
    expect(captures).toHaveLength(1)
    // The upload stays on the drafter, unnamed, until its retention window reclaims it.
    expect(eventTypes(id)).toEqual(["created:", "drafter_source_staged:"])
  })

  it("refuses the intake, with no thread, when the upload fails", async () => {
    await boot()
    const { id } = await createIssue()
    fake.failNext("PUT", 507, "staged_quota_exceeded")
    expect(await factory.intake(id)).toEqual({
      ok: false,
      state: "received",
      message: expect.stringMatching(/^drafter workspace could not be staged: .*507/),
    })
    expect(threadPosts()).toHaveLength(0)
    expect(factory.events(id).at(-1)?.type).toBe("drafter_source_failed")
  })

  it("cancels its orphaned thread when a cancel lands before the intake thread is committed", async () => {
    await bootWorker()
    // The cancel arrives in the window after the workspace is captured and before the thread
    // is committed to the row: the capture is the one seam inside that window.
    await bootFactory({
      captureDrafterHandoff: async (options) => {
        const written = await fakeDrafterHandoff(options)
        expect(await factory.cancel(options.workOrderId)).toMatchObject({
          ok: true,
          state: "cancelled",
        })
        return written
      },
    })
    const { id } = await createIssue()
    expect(await factory.intake(id)).toEqual({
      ok: false,
      state: "cancelled",
      message: "Work order changed state while starting intake",
    })
    // The thread was made, orphaned, cancelled and deleted on the drafter: undeleted, it would
    // keep its staged capture referenced, and so unreclaimable, for good.
    expect(threadPosts()).toHaveLength(1)
    expect(eventTypes(id)).toContain("thread_orphaned:")
    const threadId = factory.events(id).find((e) => e.type === "thread_orphaned")?.payload
      .threadId as string
    expect(fake.requests.filter((r) => r.method === "DELETE")).toEqual([
      expect.objectContaining({
        path: `/threads/${threadId}`,
        authorization: `Bearer ${TEST_WORKER_TOKEN}`,
      }),
    ])
    expect(fake.thread(threadId)).toBeUndefined()
    expect(factory.events(id).find((e) => e.type === "thread_deleted")?.payload).toEqual({
      threadId,
      result: "deleted",
    })
    expect(factory.show(id)).toMatchObject({ state: "cancelled", workerThreadId: null })
  })

  it("deletes the intake thread a crashed intake journalled but never committed, when the row is cancelled", async () => {
    // The crash window: the drafter made the thread and intake journalled it, but the row never
    // took it. A rerun of `intake` would adopt it; a cancel abandons it, so the cancel deletes
    // it (idempotently: the worker answers 204 for a thread it no longer has).
    await boot()
    const { id } = await createIssue()
    await crash()
    const created = await fetch(`${fake.baseUrl}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_WORKER_TOKEN}` },
      body: JSON.stringify({ metadata: { factoryWorkOrderId: id } }),
    })
    const threadId = ((await created.json()) as { thread_id: string }).thread_id
    journalHandoff(id, threadId)
    await bootFactory()
    expect(factory.show(id)).toMatchObject({ state: "received", workerThreadId: null })
    expect(await factory.cancel(id)).toMatchObject({ ok: true, state: "cancelled" })
    expect(fake.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([
      `/threads/${threadId}`,
    ])
    expect(fake.thread(threadId)).toBeUndefined()
    expect(factory.events(id).find((e) => e.type === "thread_deleted")?.payload).toEqual({
      threadId,
      result: "deleted",
    })
  })

  it("refuses a pin the repository cannot reach without spending the key, and proceeds once it can", async () => {
    await boot()
    const { id } = await createIssue()
    // The controller's repository does not hold the pin and may not fetch: the one transient
    // precondition of the capture, refused before the key.
    const empty = createEmptyRepo(join(dir, "empty-"))
    process.env.FACTORY_REPO_ROOT = empty
    process.env.FACTORY_NO_FETCH = "1"
    expect(await factory.intake(id)).toEqual({
      ok: false,
      state: "received",
      message: expect.stringMatching(
        new RegExp(
          `^pin ${PIN} is not in the repository and could not be fetched: .*FACTORY_NO_FETCH=1`,
        ),
      ),
    })
    expect(captures).toEqual([])
    expect(threadPosts()).toHaveLength(0)
    expect(factory.events(id).at(-1)).toMatchObject({
      type: "pin_unavailable",
      payload: { pin: PIN },
    })
    // The pin becomes reachable (here: the controller's repository is the one that holds
    // it again): the SAME call, under the default key, is not a replayed refusal.
    delete process.env.FACTORY_REPO_ROOT
    delete process.env.FACTORY_NO_FETCH
    expect(await factory.intake(id)).toEqual({
      ok: true,
      state: "intake_running",
      message: "Intake started",
    })
    expect(captures).toEqual([{ workOrderId: id, pin: PIN }])
    reader.set((factory.show(id) as WorkOrderRow).workerThreadId as string, GOOD_DRAFT)
    expect((await factory.settleIntake(id, 20_000)).state).toBe("awaiting_intake_approval")
  })

  it("refuses the intake, key spent, when the drafter workspace cannot be captured", async () => {
    await boot()
    const { id } = await createIssue()
    await factory.close()
    await bootFactory({
      captureDrafterHandoff: async () => {
        throw new Error("git archive failed")
      },
    })
    expect(await factory.intake(id)).toEqual({
      ok: false,
      state: "received",
      message: "drafter workspace could not be staged: Error: git archive failed",
    })
    // No thread was spent on a workspace nothing can serve.
    expect(threadPosts()).toHaveLength(0)
    expect(factory.events(id).at(-1)).toMatchObject({
      type: "drafter_source_failed",
      payload: { error: "Error: git archive failed" },
    })
    // The key is spent: the same call replays the refusal, and a fresh key (a restart after
    // the operator fixes the repository) writes and starts.
    expect(await factory.intake(id)).toMatchObject({ ok: false, state: "received" })
    await factory.close()
    await bootFactory()
    expect(await factory.intake(id, "intake-again")).toMatchObject({
      ok: true,
      state: "intake_running",
    })
    expect(eventTypes(id)).toContain("drafter_source_staged:")
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
    const blocked = factory
      .events(id)
      .find((e) => e.type === "transition" && e.payload.event === "intake_blocked")
    expect(blocked?.payload).toMatchObject({
      blockedReason: "intake_attempts_exhausted",
      lastRefusal: "oracle_did_not_fail",
    })
    // A draft the oracle did not prove is kept too: it parsed, so every file is there.
    expect(readFileSync(join(generated, ".refused", id, "attempt-2", "checks.json"), "utf8")).toBe(
      GOOD_DRAFT["draft/checks.json"],
    )
    expect(String(refusals(id)[1]?.payload.reason)).toMatch(/did not fail.*pass \(independent\)/)
    const receipts = factory.events(id).filter((e) => e.type === "oracle_receipt")
    expect(receipts).toHaveLength(2)
    expect(receipts[0]?.payload).toMatchObject({ verdict: "pass", proven: false })
    expect(promptOf(1)).toContain("did not fail on the unpatched baseline")
  })

  it("quotes what the check failed with in the refusal and the redraft's prompt", async () => {
    // Attempt 4: the check's fixture route had only a default export, so A1 failed with the
    // runtime's B4_E1007 before reaching the behaviour. The receipt is the real verifier's
    // own decision over those events, and its evidence lands in the factory's artifact store.
    await bootWorker()
    const artifacts = createArtifactStore(join(dir, "artifacts"))
    const name = "A1: runs/wait answers 200"
    const message =
      "Route entry /tmp/fixture/src/app/noop/index.ts has no recognisable export (found: default)."
    const realShaped: Verifier = {
      async verify(input) {
        const plan = assembleReceipt({
          visible: null,
          mode: "independentOnly",
          acceptanceIds: { visible: [], independent: [name] },
          independent: {
            build: { ok: true, output: "" },
            tampered: false,
            result: {
              verdict: "fail",
              output: "stderr\n",
              events: [{ type: "test:fail", name, failure: "B4_E1007", message }],
            },
          },
        })
        return {
          id: `rc-${input.workOrderId}-${Math.random().toString(36).slice(2)}`,
          workOrderId: input.workOrderId,
          candidateDigest: input.candidateDigest,
          verifierIdentity: "test:real-plan",
          policyDigest: input.policyDigest,
          environmentIdentity: "test:none",
          issuedAt: new Date().toISOString(),
          verdict: plan.verdict,
          checks: await Promise.all(
            plan.checks.map(async (check) => ({
              id: check.id,
              acceptanceIds: [...check.acceptanceIds],
              verdict: check.verdict,
              evidence: [evidenceRef(check.id, (await artifacts.put(check.evidence)).digest)],
            })),
          ),
        }
      },
    }
    await bootFactory({ verifier: realShaped, maxIntakeAttempts: 2 })
    const { id } = await intake()
    await factory.settleIntake(id, 20_000)
    const quoted = `A1 failed with B4_E1007 (${JSON.stringify(message)}), not an assertion failure: the check must reach the behaviour and fail on an assert`
    expect(String(refusals(id)[0]?.payload.reason)).toBe(
      `the drafted check did not fail on the unpatched baseline: inconclusive (independent): ${quoted}`,
    )
    expect(promptOf(1)).toContain(quoted)
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
    journalHandoff(id, threadId)
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

describe("the drafter thread's draft/", () => {
  /** A drafter reader whose thread has no `draft/` at all: the reader reports the root missing. */
  const noDraft: WorkspaceReader = {
    async read(target) {
      throw new WorkspaceRootMissingError("draft", target.threadId, "absent")
    },
  }

  it("refuses a missing draft/ as an invalid draft: the attempt is spent and the retry quotes it", async () => {
    await bootWorker()
    await bootFactory({ drafterReader: noDraft })
    const { id, threadId } = await createIssue().then(async ({ id }) => {
      expect(await factory.intake(id)).toMatchObject({ ok: true })
      return { id, threadId: (factory.show(id) as WorkOrderRow).workerThreadId as string }
    })
    const row = await factory.settleIntake(id, 20_000)
    // Two attempts by default, both refused the same way: the second exhausts them.
    expect(row).toMatchObject({
      state: "blocked",
      blockedReason: "intake_attempts_exhausted",
      intakeAttempts: 2,
      workerThreadId: threadId,
    })
    expect(refusals(id).map((e) => e.payload)).toEqual([
      expect.objectContaining({ blockedReason: "intake_invalid", attempt: 1 }),
      expect.objectContaining({ blockedReason: "intake_invalid", attempt: 2 }),
    ])
    expect(refusals(id)[0]?.payload.reason).toBe(
      "draft/ is missing: the drafter wrote nothing under it",
    )
    // Nothing to copy, but the reason is still kept where an operator looks.
    expect(refusals(id)[0]?.payload.keptFiles).toEqual([])
    expect(readFileSync(join(generated, ".refused", id, "attempt-1", "reason.txt"), "utf8")).toBe(
      "attempt 1: draft/ is missing: the drafter wrote nothing under it\n",
    )
    // Not a failed run: a reader that could not read is `intake_run_failed`; this one read
    // the thread and found nothing where the draft belongs.
    expect(eventSeen(id, "workspace_unreadable")).toBe(false)
    expect(runPosts()).toHaveLength(2)
    expect(promptOf(1)).toContain("draft/ is missing")
    // The builder's reader was never consulted for the drafter thread.
    expect(reader.reads).toEqual([])
  })

  it("refuses a draft/ that is a file, not a directory, with its own reason", async () => {
    await bootWorker()
    const fileNotDirectory: WorkspaceReader = {
      async read(target) {
        throw new WorkspaceRootMissingError("draft", target.threadId, "not_directory")
      },
    }
    await bootFactory({ drafterReader: fileNotDirectory })
    const { id } = await createIssue()
    expect(await factory.intake(id)).toMatchObject({ ok: true })
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({ state: "blocked", blockedReason: "intake_attempts_exhausted" })
    expect(refusals(id)[0]?.payload).toMatchObject({
      blockedReason: "intake_invalid",
      reason: "draft/ is not a directory: the drafter must write files under it",
    })
    expect(promptOf(1)).toContain("draft/ is not a directory")
  })

  it("keeps every other read failure a failed run, not a spent attempt", async () => {
    await bootWorker()
    const broken: WorkspaceReader = {
      async read() {
        throw new Error("the sandbox is gone")
      },
    }
    await bootFactory({ drafterReader: broken })
    const { id } = await createIssue()
    expect(await factory.intake(id)).toMatchObject({ ok: true })
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({
      state: "blocked",
      blockedReason: "intake_run_failed",
      intakeAttempts: 0,
    })
    expect(eventSeen(id, "workspace_unreadable")).toBe(true)
    expect(refusals(id)).toEqual([])
  })

  it("fails closed when the journal holds no digest it handed the thread", async () => {
    // The controller reads a thread only with the source it handed it. A journal whose
    // handoff carries no digest is one it cannot check an answer against: the read is never
    // made, and the row is a failed run, not a draft the drafter is charged for.
    await bootWorker()
    await bootFactory({
      // The workspace is staged and named as ever; only the digest the journal records is not
      // one, as a journal written by something other than `intake` could leave it.
      captureDrafterHandoff: async (input) => {
        const captured = await fakeDrafterHandoff(input)
        return {
          ...captured,
          handoff: {
            ...captured.handoff,
            workspace: { ...captured.handoff.workspace, sourceDigest: "not-a-digest" },
          },
        }
      },
    })
    const { id } = await createIssue()
    expect(await factory.intake(id)).toMatchObject({ ok: true })
    const threadId = (factory.show(id) as WorkOrderRow).workerThreadId as string
    reader.set(threadId, GOOD_DRAFT)
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({
      state: "blocked",
      blockedReason: "intake_run_failed",
      intakeAttempts: 0,
    })
    expect(
      String(factory.events(id).find((e) => e.type === "workspace_unreadable")?.payload.error),
    ).toMatch(new RegExp(`No drafter source digest is journalled for thread ${threadId}`))
    expect(reader.reads).toEqual([])
    expect(refusals(id)).toEqual([])
  })

  it("keeps a worker's timeout a failed run with its code on the record, not a spent attempt", async () => {
    await bootWorker()
    const timedOut: WorkspaceReader = {
      async read() {
        throw new ThreadWorkspaceReadError(504, "workspace_read_timeout", "Worker answered 504")
      },
    }
    await bootFactory({ drafterReader: timedOut })
    const { id } = await createIssue()
    expect(await factory.intake(id)).toMatchObject({ ok: true })
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({
      state: "blocked",
      blockedReason: "intake_run_failed",
      intakeAttempts: 0,
    })
    expect(
      factory.events(id).find((e) => e.type === "workspace_unreadable")?.payload,
    ).toMatchObject({ phase: "intake", status: 504, code: "workspace_read_timeout" })
    expect(refusals(id)).toEqual([])
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
    // The approval's own transaction commits the move and its journal line together, and
    // leaves nothing after them: no file was written for the drafter.
    expect(
      factory
        .events(id)
        .slice(-2)
        .map((e) => e.type),
    ).toEqual(["transition", "intake_approved"])
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
    // Under the default key, on purpose: the refusal spends no key, so the dispatch below,
    // after the file is restored, is the same call and not a replay of this refusal.
    expect(await factory.dispatch(id)).toEqual({
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

    // Rung 2 from here: the builder gets its own thread ON THE BUILDER, the generated task's
    // prompt, and the full verification of what it left behind. The drafter hears nothing
    // more.
    verifier.script = { verdict: "pass" }
    expect(builderThreadPosts()).toHaveLength(0)
    expect(await factory.dispatch(id)).toEqual({
      ok: true,
      state: "dispatched",
      message: "Dispatched",
    })
    const dispatched = await factory.waitFor(id, (r) => r.state !== "received")
    const builderThread = dispatched.workerThreadId as string
    expect(builderThread).not.toBe(parked.workerThreadId)
    expect(dispatched.workerRoute).toBe("/build#agent")
    reader.set(builderThread, repaired())
    const row = await factory.settle(id, 20_000)
    expect(row).toMatchObject({ state: "awaiting_approval", taskDigest, targetId: "devkit" })
    expect(row.candidateDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(threadPosts()).toHaveLength(1)
    expect(runPosts()).toHaveLength(1)
    expect(builderThreadPosts()).toHaveLength(1)
    expect(builderThreadPosts()[0]?.body).toMatchObject({ metadata: { factoryWorkOrderId: id } })
    expect(builderRunPosts()[0]?.body).toMatchObject({
      route: "/build#agent",
      input: { messages: [{ role: "user", content: taskPrompt(loadTask(id)) }] },
    })
    expect(verifier.calls[1]).toMatchObject({
      taskId: id,
      changes: { [SOURCE]: repaired()[SOURCE] },
    })
    expect(verifier.calls[1]?.mode).toBeUndefined()
  })

  it("re-checks the approved digest after the image step, however long it took", async () => {
    await boot()
    const { id } = await intake()
    const parked = await factory.settleIntake(id, 20_000)
    const taskDigest = parked.taskDigest as string
    expect((await factory.approveIntake(id, { revision: parked.revision, taskDigest })).ok).toBe(
      true,
    )
    const spec = join(generated, id, "spec.md")
    // The generated task changes on disk while dispatch waits on its image.
    const base = configuredImages() as ImageRegistry
    const restore = useImages({
      recorded: (recipe) => base.recorded(recipe),
      ensure: (recipe, options) => base.ensure(recipe, options),
      close: () => {},
      async present() {
        writeFileSync(spec, `${readFileSync(spec, "utf8")}\nA9: edited during the wait\n`)
        return true
      },
    })
    try {
      expect(await factory.dispatch(id)).toEqual({
        ok: false,
        state: "received",
        message: "Generated task on disk no longer matches the approved digest",
      })
      expect(eventsOf(id, "generated_task_changed").at(-1)?.payload).toMatchObject({
        phase: "dispatch_after_image",
      })
      expect(threadPosts()).toHaveLength(1)
    } finally {
      restore()
    }
  })
  it("freezes the origin, the pin, the task digest and the oracle proof into the bundle, and approve re-checks the task on disk", async () => {
    await boot()
    const { id } = await intake()
    const parked = await factory.settleIntake(id, 20_000)
    const taskDigest = parked.taskDigest as string
    const oracle = factory.events(id).find((e) => e.type === "oracle_receipt")?.payload
      .receiptId as string
    expect(
      await factory.approveIntake(id, { revision: parked.revision, taskDigest }),
    ).toMatchObject({ ok: true, state: "received" })
    verifier.script = { verdict: "pass" }
    expect(await factory.dispatch(id)).toMatchObject({ ok: true })
    const dispatched = await factory.waitFor(id, (r) => r.state !== "received")
    reader.set(dispatched.workerThreadId as string, repaired())
    const row = await factory.settle(id, 20_000)
    expect(row.state).toBe("awaiting_approval")

    // Approving the export consents to the issue text, the approved task and the candidate
    // together (spec §6.6), and names the receipt that proved the check fails on the baseline.
    const { bundle, oracleReceipt } = factory.evidence(id)
    expect(oracleReceipt).toMatchObject({ id: oracle, verdict: "fail" })
    expect(bundle?.payload).toMatchObject({
      origin: ORIGIN,
      pin: PIN,
      taskDigest,
      oracleReceiptId: oracle,
    })

    // The generated task edited after the freeze: the bundle asserts the task the person
    // approved, and the export must not go out under it. `issue.md` is the file to edit
    // here, because it is the one file of the directory no other frozen digest covers (the
    // spec and the checks are in the specification and policy digests): only the task
    // digest sees it, so only the task comparison can refuse.
    const issue = join(generated, id, "issue.md")
    const original = readFileSync(issue, "utf8")
    writeFileSync(issue, `${original}\nEdited after approval.\n`)
    expect(
      await factory.approve(id, {
        revision: row.revision,
        bundleDigest: row.bundleDigest as string,
      }),
    ).toMatchObject({
      ok: false,
      state: "awaiting_approval",
      message: expect.stringMatching(/Generated task changed/),
    })
    // The invalidation, then the refusal line a following CLI reads.
    expect(factory.events(id).at(-1)).toMatchObject({ type: "approve_refused" })
    expect(factory.events(id).at(-2)).toMatchObject({
      type: "bundle_invalidated",
      payload: { field: "Generated task", frozen: taskDigest },
    })
    expect(factory.show(id)?.state).toBe("awaiting_approval")
  })

  it("rejects with a note that the next drafter turn quotes, and blocks once attempts run out", async () => {
    await boot({}, { maxIntakeAttempts: 2 })
    const { id, threadId } = await intake()
    await factory.settleIntake(id, 20_000)
    const note = "the check should exercise the async failure path, not the sync one"
    const before = factory.evidence(id).oracleReceipt
    expect(before).not.toBeNull()
    expect(await factory.rejectIntake(id, { note })).toEqual({
      ok: true,
      state: "intake_running",
      message: "Intake rejected; redrafting",
    })
    // The rejected draft is nobody's from here: the row's digest and target are cleared, and
    // its proof is no longer the row's evidence, until the redraft parks a new one.
    expect(factory.show(id)).toMatchObject({ taskDigest: null, targetId: null })
    expect(factory.evidence(id).oracleReceipt).toBeNull()
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({
      state: "awaiting_intake_approval",
      intakeAttempts: 2,
      workerThreadId: threadId,
    })
    // The redraft reuses the admitted thread: nothing is captured or uploaded again.
    expect(threadPosts()).toHaveLength(1)
    expect(captures).toHaveLength(1)
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(1)
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
    expect(
      factory
        .events(id)
        .find((e) => e.type === "transition" && e.payload.event === "intake_blocked")?.payload,
    ).toMatchObject({ blockedReason: "intake_attempts_exhausted", lastRefusal: "intake_rejected" })
    expect(runPosts()).toHaveLength(2)
    expect(await factory.rejectIntake(id, { note: "again" })).toMatchObject({
      ok: false,
      message: "Cannot reject intake from blocked",
    })
  })

  it("carries the notes that rejected earlier work orders of the same issue into a new intake", async () => {
    await boot({}, { maxIntakeAttempts: 3 })
    const { id } = await intake()
    await factory.settleIntake(id, 20_000)
    const older = "answer 200 with the JSON body null, not an empty body"
    expect((await factory.rejectIntake(id, { note: older })).ok).toBe(true)
    await factory.settleIntake(id, 20_000)
    const newer = "A2 must not depend on a deleted fixture directory"
    expect((await factory.rejectIntake(id, { note: newer })).ok).toBe(true)
    await factory.settleIntake(id, 20_000)
    expect(await factory.cancel(id)).toMatchObject({ ok: true, state: "cancelled" })
    // The replacement work order starts with neither note on its own row.
    const other = await factory.createFromIssue({
      origin: { ...ORIGIN, number: 779 },
      pin: PIN,
      issue: ISSUE,
    })
    expect((await factory.intake(other.id)).ok).toBe(true)
    await factory.settleIntake(other.id, 20_000)
    const unrelated = promptOf(runPosts().length - 1)
    expect(unrelated).not.toContain("Maintainer decisions")
    await factory.cancel(other.id)
    const second = await factory.createFromIssue({ origin: ORIGIN, pin: PIN, issue: ISSUE })
    expect((await factory.intake(second.id)).ok).toBe(true)
    await factory.settleIntake(second.id, 20_000)
    const prompt = promptOf(runPosts().length - 1)
    expect(prompt).toContain("## Maintainer decisions from earlier reviews of this issue")
    expect(prompt).toContain(older)
    expect(prompt).toContain(newer)
    // Newest first, and not mistaken for a refusal of this work order's own draft.
    expect(prompt.indexOf(newer)).toBeLessThan(prompt.indexOf(older))
    expect(prompt).not.toContain("Previous attempt was refused")
    expect(
      factory.events(second.id).find((e) => e.type === "intake_decisions_carried")?.payload,
    ).toEqual({ count: 2 })
  })

  it("keeps an operator's note in front of the drafter after a refusal replaces it as the note", async () => {
    await boot({}, { maxIntakeAttempts: 3 })
    const check = "draft/checks/spawn-deadline.test.ts"
    const failsPrecheck = {
      ...GOOD_DRAFT,
      [check]: (GOOD_DRAFT[check] as string).replace('import test from "node:test"\n', ""),
    }
    const { id } = await intake({ queue: [GOOD_DRAFT, failsPrecheck, GOOD_DRAFT] })
    await factory.settleIntake(id, 20_000)
    const decision = "answer 200 with the JSON body null, never an empty body"
    expect((await factory.rejectIntake(id, { note: decision })).ok).toBe(true)
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({ state: "awaiting_intake_approval", intakeAttempts: 3 })
    expect(runPosts()).toHaveLength(3)
    // Turn 2 quotes the rejection as its note, and only there.
    expect(promptOf(1)).toContain("Previous attempt was refused")
    expect(promptOf(1)).toContain(decision)
    expect(promptOf(1)).not.toContain("Maintainer decisions")
    // Turn 3's note is the pre-check's refusal; the operator's decision is still in front of it.
    expect(promptOf(2)).toContain("fails the static pre-check")
    expect(promptOf(2)).toContain("## Maintainer decisions from earlier reviews of this issue")
    expect(promptOf(2)).toContain(decision)
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
    // The cancel went to the DRAFTER, which holds the thread; the builder was never asked.
    expect(builder.requests).toEqual([])
    // Nothing was drafted: no read, no proof.
    expect(reader.reads).toEqual([])
    expect(verifier.calls).toEqual([])
  })

  it("settles a cancel as cancelled, journalled, when the row's worker has left the map", async () => {
    await boot({ run: "hang" })
    const { id } = await intake()
    await factory.waitFor(id, () => eventSeen(id, "intake_run_started"))
    await factory.close()
    // The drafter pair unset under a draft in flight: the boot walk cannot reach the thread
    // and says so; the row waits.
    await bootFactory({ withDrafter: false })
    expect(factory.show(id)?.state).toBe("intake_running")
    expect(factory.events(id).at(-1)).toMatchObject({
      type: "reconcile_failed",
      payload: { error: expect.stringMatching(/intake is not configured/) },
    })
    // The operator's escape: nothing to cancel on, nothing to deny, and the row settles.
    expect(await factory.cancel(id)).toEqual({ ok: true, state: "cancelled", message: "Cancelled" })
    expect(factory.events(id).find((e) => e.type === "worker_unavailable")?.payload).toMatchObject({
      phase: "cancel",
      error: expect.stringMatching(/intake is not configured/),
    })
    expect(cancels()).toHaveLength(0)
    expect(resumes()).toHaveLength(0)
    expect(factory.show(id)).toMatchObject({ state: "cancelled" })
  })

  it("denies a prompt the drafter parked on, on the drafter's route, whether by deny or by cancel", async () => {
    await boot({ run: "unexpected_interrupt" })
    const { id, threadId } = await intake()
    const blocked = await factory.settleIntake(id, 20_000)
    expect(blocked).toMatchObject({ state: "blocked", blockedReason: "intake_run_failed" })
    expect(fake.thread(threadId)?.pending).not.toBeNull()
    // The state alone no longer says whose thread this is: the journal does.
    expect(await factory.deny(id)).toEqual({ ok: true, state: "denied", message: "Denied" })
    expect(resumes()).toHaveLength(1)
    expect(resumes()[0]).toMatchObject({
      path: `/threads/${threadId}/resume`,
      body: { route: "/intake#agent" },
    })
    expect(fake.thread(threadId)?.pending).toBeNull()
    expect(builder.requests).toEqual([])

    // The same through cancel: a second blocked row, its parked prompt denied by the cancel.
    const second = await factory.createFromIssue({ origin: ORIGIN, pin: PIN, issue: ISSUE })
    expect(await factory.intake(second.id)).toMatchObject({ ok: true })
    await factory.settleIntake(second.id, 20_000)
    const secondThread = (factory.show(second.id) as WorkOrderRow).workerThreadId as string
    expect(await factory.cancel(second.id)).toMatchObject({ ok: true, state: "cancelled" })
    expect(resumes()).toHaveLength(2)
    expect(resumes()[1]).toMatchObject({
      path: `/threads/${secondThread}/resume`,
      body: { route: "/intake#agent" },
    })
    expect(builder.requests).toEqual([])
  })
})

describe("intake reconciliation", () => {
  it("resumes, before any rule, a budget a restart left paused", async () => {
    await boot()
    const { id } = await createIssue()
    await crash()
    // What a controller killed mid-build leaves: an active row with its clock stopped, and a
    // build the journal shows started and never ended.
    forceRow(id, { state: "intake_running", activeMs: 1_234, activeStartedAt: null })
    journalEvent(id, "image_prepare_started", {
      targetId: "devkit",
      pin: PIN,
      key: "a".repeat(64),
      shared: false,
      deadlineMs: 1,
    })
    await bootFactory()
    const aborted = factory.events(id).filter((e) => e.type === "image_prepare_aborted")
    expect(aborted.map((e) => e.payload)).toEqual([
      { targetId: "devkit", pin: PIN, reason: "restart" },
    ])
    const events = factory.events(id)
    const resumed = events.findIndex((e) => e.type === "budget_resumed")
    expect(resumed).toBeGreaterThanOrEqual(0)
    expect(events[resumed]?.payload).toEqual({ reason: "reconcile" })
    const firstRule = events.findIndex((e, i) => i > resumed - 1 && e.type === "transition")
    expect(firstRule === -1 || firstRule > resumed).toBe(true)
    const row = factory.show(id) as WorkOrderRow
    // Still active: the clock runs. Settled: the resumed interval was banked by the transition.
    if (["intake_running", "dispatched", "running", "verifying", "exporting"].includes(row.state))
      expect(row.activeStartedAt).not.toBeNull()
    else expect(row.activeMs).toBeGreaterThanOrEqual(1_234)
  })

  it("adopts a builder thread a crashed dispatch journalled behind the lingering drafter thread", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await intake()
    const parked = await factory.settleIntake(id, 20_000)
    const intakeThread = parked.workerThreadId as string
    expect(
      await factory.approveIntake(id, {
        revision: parked.revision,
        taskDigest: parked.taskDigest as string,
      }),
    ).toMatchObject({ ok: true, state: "received" })
    await crash()
    // The window a crashed dispatch leaves on an approved-draft row: the builder thread
    // exists and is journalled, the command is open, and the row still holds the drafter's.
    const created = await fetch(`${builder.baseUrl}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { factoryWorkOrderId: id } }),
    })
    const builderThread = ((await created.json()) as { thread_id: string }).thread_id
    expect(builderThread).not.toBe(intakeThread)
    const registry = openRegistry(registryPath())
    createWorkOrderStore(registry.db).appendEvent(
      id,
      "builder_source_staged",
      { sourceDigest: "0".repeat(64), status: "created" },
      new Date().toISOString(),
    )
    createWorkOrderStore(registry.db).appendEvent(
      id,
      "thread_created",
      { threadId: builderThread },
      new Date().toISOString(),
    )
    const commands = createCommandLog(registry.db)
    commands.begin(
      "dispatch-orphan",
      id,
      { command: "dispatch", args: {} },
      new Date().toISOString(),
    )
    registry.close()
    reader.set(builderThread, repaired())
    verifier.script = { verdict: "pass" }
    await bootFactory()
    // No second builder thread: the journalled one is adopted, on the builder's route.
    expect(builderThreadPosts()).toHaveLength(1)
    expect(
      factory.events(id).find((e) => e.payload.resolution === "thread_adopted")?.payload,
    ).toMatchObject({ threadId: builderThread, operationKey: "dispatch-orphan" })
    const row = await factory.settle(id, 20_000)
    expect(row).toMatchObject({
      state: "awaiting_approval",
      workerThreadId: builderThread,
      workerRoute: "/build#agent",
    })
    expect(await factory.dispatch(id, "dispatch-orphan")).toMatchObject({
      ok: true,
      state: "dispatched",
      message: "Adopted thread after restart",
    })
  })

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
    journalHandoff(id, threadId)
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
    journalHandoff(id, threadId)
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

  /** The live run's window: the drafter was killed mid-turn and came back reading `busy`. */
  async function staleBusyIntake(): Promise<{ id: string; threadId: string }> {
    await bootWorker()
    await bootFactory()
    const { id } = await createIssue()
    await crash()
    const created = await fetch(`${fake.baseUrl}/threads`, { method: "POST" })
    const { thread_id: threadId } = (await created.json()) as { thread_id: string }
    fake.markStaleBusy(threadId)
    journalHandoff(id, threadId)
    forceRow(id, { state: "intake_running", workerThreadId: threadId })
    return { id, threadId }
  }

  it("finishes an intake whose thread reads busy with no run behind it", async () => {
    const { id, threadId } = await staleBusyIntake()
    reader.set(threadId, GOOD_DRAFT)
    await bootFactory()
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({ state: "awaiting_intake_approval", intakeAttempts: 1 })
    const types = factory.events(id).map((e) => e.type)
    expect(types).toContain("reattach_not_live")
    expect(types).not.toContain("reattached")
    expect(types).not.toContain("intake_still_live")
    expect(factory.events(id).find((e) => e.type === "reconciled")?.payload).toMatchObject({
      resolution: "finish_intake",
      status: "busy",
    })
    // One reattach, answered `live: false`; never a new turn.
    expect(
      fake.requests.filter((r) => r.method === "GET" && r.path.endsWith("/runs/stream")),
    ).toHaveLength(1)
    expect(runPosts()).toHaveLength(0)
  })

  it("refuses the missing draft a stale busy intake left, spending an attempt", async () => {
    const { id, threadId } = await staleBusyIntake()
    // The killed turn wrote nothing; the redraft the refusal starts writes the draft.
    reader.queue(threadId, [{}, GOOD_DRAFT])
    await bootFactory()
    const row = await factory.settleIntake(id, 20_000)
    expect(row).toMatchObject({ state: "awaiting_intake_approval", intakeAttempts: 2 })
    expect(refusals(id)).toHaveLength(1)
    expect(refusals(id)[0]?.payload).toMatchObject({ blockedReason: "intake_invalid", attempt: 1 })
    expect(String(refusals(id)[0]?.payload.reason)).toContain("draft/task.json is missing")
    expect(factory.events(id).map((e) => e.type)).not.toContain("intake_still_live")
    expect(runPosts()).toHaveLength(1)
  })

  it("leaves an intake a closing factory aborted for the next boot, not blocked", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await createIssue()
    await crash()
    const created = await fetch(`${fake.baseUrl}/threads`, { method: "POST" })
    const { thread_id: threadId } = (await created.json()) as { thread_id: string }
    journalHandoff(id, threadId)
    forceRow(id, { state: "intake_running", workerThreadId: threadId })
    // A read that holds until the factory's own signal aborts it: `finishIntake` is then
    // mid-phase when close() lands, which is exactly when a backstop would wrongly block.
    let asked: (() => void) | undefined
    const askedOnce = new Promise<void>((resolve) => {
      asked = resolve
    })
    const holding: WorkspaceReader = {
      read: (_target, signal) =>
        new Promise((_resolve, reject) => {
          asked?.()
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
    }
    await bootFactory({ drafterReader: holding })
    await askedOnce
    expect(factory.show(id)?.state).toBe("intake_running")
    await factory.close()
    const registry = openRegistry(registryPath())
    const rows = createWorkOrderStore(registry.db)
    expect(rows.get(id)).toMatchObject({ state: "intake_running", workerThreadId: threadId })
    const types = rows.events(id).map((e) => e.type)
    expect(types).toContain("intake_aborted")
    expect(types).not.toContain("intake_phase_error")
    expect(rows.events(id).at(-1)?.type).toBe("intake_aborted")
    registry.close()
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

/** A registry over a fake builder, configured process-wide for this test (the factory builds through it). */
function fakeImages(): {
  builder: ReturnType<typeof fakeImageBuilder>
  registry: ImageRegistry
  restore(): void
} {
  const builder = fakeImageBuilder()
  const registry = openImageRegistry({
    path: join(dir, "images.sqlite"),
    builder,
    platform: "linux/arm64",
  })
  const restore = useImages(registry)
  return {
    builder,
    registry,
    restore: () => {
      restore()
      registry.close()
    },
  }
}
const eventsOf = (id: string, type: string) => factory.events(id).filter((e) => e.type === type)
async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error("condition never held")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("the fit step's image", () => {
  it("builds the drafted target's image, journals the build with its log, and binds it before the proof", async () => {
    await boot()
    const images = fakeImages()
    try {
      const { id } = await intake()
      const row = await factory.settleIntake(id, 20_000)
      expect(row.state).toBe("awaiting_intake_approval")
      expect(images.builder.requests).toHaveLength(1)
      const [started] = eventsOf(id, "image_prepare_started")
      const [prepared] = eventsOf(id, "image_prepared")
      const [bound] = eventsOf(id, "image_bound")
      expect(started?.payload).toMatchObject({ targetId: "devkit", pin: PIN, shared: false })
      expect(prepared?.payload).toMatchObject({ targetId: "devkit", pin: PIN, shared: false })
      const log = await createArtifactStore(join(dir, "artifacts")).read(
        String(prepared?.payload.logDigest),
      )
      expect(log).toContain("building b4-factory-devkit:")
      expect(bound?.payload).toMatchObject({
        targetId: "devkit",
        pin: PIN,
        image: { localId: prepared?.payload.localId },
      })
      const types = factory.events(id).map((e) => e.type)
      expect(types.indexOf("image_bound")).toBeLessThan(types.indexOf("oracle_receipt"))
    } finally {
      images.restore()
    }
  })

  it("builds a pin once for two work orders that need it at once", async () => {
    await boot()
    const images = fakeImages()
    images.builder.hold()
    try {
      const first = await intake()
      const { id: second } = await factory.createFromIssue({
        origin: { ...ORIGIN, number: 779 },
        pin: PIN,
        issue: ISSUE,
        operationKey: "issue:779",
      })
      await factory.intake(second)
      reader.set((factory.show(second) as WorkOrderRow).workerThreadId as string, GOOD_DRAFT)
      await until(
        () =>
          eventsOf(first.id, "image_prepare_started").length === 1 &&
          eventsOf(second, "image_prepare_started").length === 1,
      )
      images.builder.release()
      const rows = await Promise.all([
        factory.settleIntake(first.id, 20_000),
        factory.settleIntake(second, 20_000),
      ])
      expect(rows.map((r) => r.state)).toEqual([
        "awaiting_intake_approval",
        "awaiting_intake_approval",
      ])
      expect(images.builder.requests).toHaveLength(1)
      const shared = [first.id, second]
        .map((id) => eventsOf(id, "image_prepare_started")[0]?.payload.shared)
        .sort()
      expect(shared).toEqual([false, true])
      const localIds = [first.id, second].map(
        (id) => (eventsOf(id, "image_bound")[0]?.payload.image as { localId?: string })?.localId,
      )
      expect(localIds[0]).toMatch(/^sha256:/)
      expect(localIds[0]).toBe(localIds[1])
    } finally {
      images.builder.release()
      images.restore()
    }
  })

  it("blocks a failed build with its log in evidence, spends no drafter attempt, and the next work order builds again", async () => {
    await boot()
    const images = fakeImages()
    try {
      images.builder.failNext("pnpm install failed", "ERR_PNPM_OUTDATED_LOCKFILE\n")
      const { id } = await intake()
      const row = await factory.settleIntake(id, 20_000)
      expect(row).toMatchObject({
        state: "blocked",
        blockedReason: "image_prepare_failed",
        intakeAttempts: 0,
      })
      const [failed] = eventsOf(id, "image_prepare_failed")
      expect(failed?.payload).toMatchObject({
        targetId: "devkit",
        pin: PIN,
        error: `Target devkit at ${PIN}: pnpm install failed`,
      })
      const log = await createArtifactStore(join(dir, "artifacts")).read(
        String(failed?.payload.logDigest),
      )
      expect(log).toContain("ERR_PNPM_OUTDATED_LOCKFILE")
      expect(verifier.calls).toHaveLength(0)
      expect(refusals(id)).toHaveLength(0)

      const { id: next } = await factory.createFromIssue({
        origin: { ...ORIGIN, number: 780 },
        pin: PIN,
        issue: ISSUE,
        operationKey: "issue:780",
      })
      await factory.intake(next)
      reader.set((factory.show(next) as WorkOrderRow).workerThreadId as string, GOOD_DRAFT)
      expect((await factory.settleIntake(next, 20_000)).state).toBe("awaiting_intake_approval")
      expect(images.builder.requests).toHaveLength(2)
    } finally {
      images.restore()
    }
  })

  it("abandons the build when the work order is cancelled mid-build, recording nothing", async () => {
    await boot()
    const images = fakeImages()
    images.builder.hold()
    try {
      const { id } = await intake()
      await until(() => eventsOf(id, "image_prepare_started").length === 1)
      expect((await factory.cancel(id)).ok).toBe(true)
      await until(() => images.builder.aborted === 1)
      expect(factory.show(id)?.state).toBe("cancelled")
      expect(eventsOf(id, "image_prepare_aborted")).toHaveLength(1)
      expect(images.registry.recorded(loadTargetRecipe("devkit", { pin: PIN }))).toBeUndefined()
    } finally {
      images.builder.release()
      images.restore()
    }
  })

  it("does not charge the build's time to the work order's budget", async () => {
    let clock = Date.parse("2026-09-25T00:00:00.000Z")
    await bootWorker()
    await bootFactory({ now: () => clock, maxActiveMs: 1_200_000 })
    const images = fakeImages()
    images.builder.hold()
    try {
      const { id } = await intake()
      await until(() => eventsOf(id, "image_prepare_started").length === 1)
      clock += 3_600_000 // an hour of building: three times the whole budget
      images.builder.release()
      const row = await factory.settleIntake(id, 20_000)
      expect(row.state).toBe("awaiting_intake_approval")
      expect(row.activeMs).toBeLessThan(60_000)
      const types = factory.events(id).map((e) => e.type)
      // Paused as the build started for this work order, resumed as its wait ended.
      expect(types.indexOf("budget_paused")).toBe(types.indexOf("image_prepare_started") + 1)
      expect(types.indexOf("budget_resumed")).toBeGreaterThan(types.indexOf("budget_paused"))
      expect(eventsOf(id, "image_prepare_started")[0]?.payload.deadlineMs).toBeGreaterThan(0)
    } finally {
      images.builder.release()
      images.restore()
    }
  })
})
