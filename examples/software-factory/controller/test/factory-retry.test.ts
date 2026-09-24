import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier, type FakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"
import { fakeWorkerMap, noopBuilderManifestWriter } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"

/**
 * `retry` (the first live run's approved task stranded on its one candidate attempt): a
 * candidate failure goes back to `received`, attempts permitting, and `dispatch` starts a
 * fresh builder thread from there. Also the elision guard, the cheap refusal that runs before
 * verification and blocks as `candidate_rejected`.
 */

let dir: string
let fake: FakeWorker
let factory: Factory
let reader: FakeWorkspaceReader
let verifier: FakeVerifier
let manifestsWritten: string[]

const REPAIRED = "export const fixed = true\n"
const captureRepairable = async () => ({
  digest: "a".repeat(64),
  files: new Map([
    ["src/cli.ts", "broken\n"],
    ["test/cli.test.ts", "spec\n"],
    ["TASK.md", "task\n"],
  ]),
})
const repaired = (cli = REPAIRED) => ({
  "src/cli.ts": cli,
  "test/cli.test.ts": "spec\n",
  "TASK.md": "task\n",
})

async function boot(
  options: Omit<FakeWorkerOptions, "outboxDir"> = {},
  overrides: Partial<FactoryOptions> = {},
) {
  dir = mkdtempSync(join(tmpdir(), "factory-retry-"))
  mkdirSync(join(dir, "out"), { recursive: true })
  fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only", ...options })
  reader = createFakeWorkspaceReader({})
  verifier = createFakeVerifier({ verdict: "pass" })
  manifestsWritten = []
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    generatedTasksDir: join(dir, "tasks"),
    captureRoot: dir,
    workers: fakeWorkerMap({ builder: { client: createHttpWorkerClient(fake.baseUrl), reader } }),
    writeBuilderManifest: async (input) => {
      manifestsWritten.push(input.workOrderId)
      return noopBuilderManifestWriter(input)
    },
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier,
    captureBaseline: captureRepairable,
    ...overrides,
  })
}
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined as unknown as string
  fake = undefined as unknown as FakeWorker
  factory = undefined as unknown as Factory
})

const settled = (state: string) =>
  !["received", "dispatched", "running", "verifying"].includes(state)

/** Dispatch, script what the builder's workspace will be found to contain, and settle. */
async function dispatchAndSettle(id: string, files: Record<string, string> = repaired()) {
  const before = factory.show(id)?.workerThreadId ?? null
  const outcome = await factory.dispatch(id)
  expect(outcome).toMatchObject({ ok: true, state: "dispatched" })
  const dispatched = await factory.waitFor(
    id,
    (r) => r.workerThreadId !== null && r.workerThreadId !== before,
  )
  const threadId = dispatched.workerThreadId as string
  reader.set(threadId, files)
  return { threadId, row: await factory.waitFor(id, (r) => settled(r.state), 20_000) }
}

/** Put a row where only another phase could have left it: a test-only write to the registry. */
function forceBlocked(id: string, reason: string) {
  const db = new DatabaseSync(join(dir, "registry.sqlite"))
  try {
    db.prepare(
      "UPDATE work_orders SET state = 'blocked', blocked_reason = ?, revision = revision + 1 WHERE id = ?",
    ).run(reason, id)
  } finally {
    db.close()
  }
}

describe("retry", () => {
  it("returns a work order blocked on an unexpected interrupt to received, and dispatch starts a fresh builder thread", async () => {
    await boot({ run: "unexpected_interrupt" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect(factory.show(id)).toMatchObject({ candidateAttempts: 0, maxCandidateAttempts: 2 })
    const first = await dispatchAndSettle(id)
    expect(first.row).toMatchObject({
      state: "blocked",
      blockedReason: "unexpected_interrupt",
      candidateAttempts: 1,
    })
    expect(first.row.interruptId).not.toBeNull()

    // The next builder turn behaves; the parked one is denied and released by the retry.
    fake.behaviour.run = "edits_only"
    const outcome = await factory.retry(id)
    expect(outcome).toEqual({
      ok: true,
      state: "received",
      message: "Retry 2 of 2 ready; dispatch it",
    })
    expect(factory.show(id)).toMatchObject({
      state: "received",
      workerThreadId: null,
      interruptId: null,
      candidateDigest: null,
      bundleDigest: null,
      blockedReason: null,
      candidateAttempts: 1,
    })
    const resumes = fake.requests.filter((r) => r.path.endsWith("/resume"))
    expect(resumes).toHaveLength(1)
    expect(resumes[0]?.path).toBe(`/threads/${first.threadId}/resume`)
    expect(resumes[0]?.body).toMatchObject({
      route: "/build#agent",
      resume: [{ payload: "deny" }],
    })
    expect(fake.requests.some((r) => r.path === `/threads/${first.threadId}/cancel`)).toBe(true)
    const retry = factory.events(id).find((e) => e.type === "retry")
    expect(retry?.payload).toMatchObject({
      attempt: 2,
      previousBlockedReason: "unexpected_interrupt",
      previousThreadId: first.threadId,
    })

    const second = await dispatchAndSettle(id)
    expect(second.threadId).not.toBe(first.threadId)
    expect(second.row).toMatchObject({ state: "awaiting_approval", candidateAttempts: 2 })
    // A fresh manifest for the fresh thread: one per dispatch.
    expect(manifestsWritten).toEqual([id, id])
    expect(reader.reads).toEqual([second.threadId])
  })

  it("refuses once the row's candidate attempts are spent", async () => {
    await boot({ run: "unexpected_interrupt" }, { maxCandidateAttempts: 1 })
    const { id } = await factory.create({ taskId: "cli-flags" })
    const { row } = await dispatchAndSettle(id)
    expect(row).toMatchObject({ state: "blocked", candidateAttempts: 1, maxCandidateAttempts: 1 })
    const refused = await factory.retry(id)
    expect(refused).toMatchObject({ ok: false, state: "blocked" })
    expect(refused.message).toMatch(/^No candidate attempts remain: 1 of 1 spent/)
    // Refused before anything was said to the worker or spent under a key.
    expect(fake.requests.some((r) => r.path.endsWith("/resume"))).toBe(false)
    expect(factory.show(id)?.revision).toBe(row.revision)
  })

  it("spends the default two attempts and then refuses", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    verifier.script = { verdict: "fail" }
    expect((await dispatchAndSettle(id)).row).toMatchObject({
      state: "blocked",
      blockedReason: "verification_failed",
    })
    expect(await factory.retry(id)).toMatchObject({ ok: true, state: "received" })
    expect((await dispatchAndSettle(id)).row).toMatchObject({
      state: "blocked",
      blockedReason: "verification_failed",
      candidateAttempts: 2,
    })
    expect((await factory.retry(id)).message).toMatch(/^No candidate attempts remain: 2 of 2/)
  })

  it.each([
    "intake_invalid",
    "oracle_did_not_fail",
    "intake_attempts_exhausted",
    "budget_exhausted",
    "export_unconfirmed",
  ])("refuses a work order blocked by %s: not a candidate failure", async (reason) => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    forceBlocked(id, reason)
    const refused = await factory.retry(id)
    expect(refused).toMatchObject({ ok: false, state: "blocked" })
    expect(refused.message).toContain(`blocked by ${reason}`)
    expect(factory.show(id)).toMatchObject({ state: "blocked", blockedReason: reason })
  })

  it("refuses a work order that is not blocked", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect(await factory.retry(id)).toMatchObject({
      ok: false,
      state: "received",
      message: "Cannot retry from received",
    })
  })

  it("never adopts the abandoned thread when the dispatch after a retry crashes", async () => {
    await boot({ run: "unexpected_interrupt" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    const { threadId } = await dispatchAndSettle(id)
    expect((await factory.retry(id)).ok).toBe(true)
    await factory.close()
    // A dispatch that recorded its intent and died before it created a thread: the only
    // `thread_created` in the journal is the abandoned attempt's.
    const db = new DatabaseSync(join(dir, "registry.sqlite"))
    db.prepare(
      "INSERT INTO commands (operation_key, work_order_id, command, intent, outcome, at) VALUES (?, ?, 'dispatch', ?, NULL, ?)",
    ).run(
      "dispatch:crashed",
      id,
      JSON.stringify({ command: "dispatch", args: {} }),
      new Date().toISOString(),
    )
    db.close()
    factory = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      generatedTasksDir: join(dir, "tasks"),
      captureRoot: dir,
      workers: fakeWorkerMap({ builder: { client: createHttpWorkerClient(fake.baseUrl), reader } }),
      writeBuilderManifest: noopBuilderManifestWriter,
      exportDir: join(dir, "out"),
      artifactsDir: join(dir, "artifacts"),
      verifier,
      captureBaseline: captureRepairable,
    })
    expect(factory.show(id)).toMatchObject({ state: "received", workerThreadId: null })
    expect(factory.events(id).at(-1)?.payload).toMatchObject({
      resolution: "dispatch_incomplete",
    })
    expect(
      factory.events(id).some((e) => e.payload.threadId === threadId && e.type === "reconciled"),
    ).toBe(false)
  })

  it("retries once per blocked revision, whatever the caller repeats", async () => {
    await boot({ run: "unexpected_interrupt" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await dispatchAndSettle(id)
    expect((await factory.retry(id, "retry-1")).ok).toBe(true)
    // From `received` there is nothing to retry, and the refusal says so.
    expect((await factory.retry(id, "retry-1")).message).toBe("Cannot retry from received")
    expect(factory.events(id).filter((e) => e.type === "retry")).toHaveLength(1)
  })
})

describe("the elision guard", () => {
  it("blocks a truncated file as candidate_rejected before verification, and a retry follows", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    const { row } = await dispatchAndSettle(
      id,
      repaired("export const fixed = true\n... (file truncated, unchanged)\n"),
    )
    expect(row).toMatchObject({ state: "blocked", blockedReason: "candidate_rejected" })
    expect(verifier.calls).toEqual([])
    const rejected = factory
      .events(id)
      .find((e) => e.type === "transition" && e.payload.event === "assembly_rejected")
    expect(rejected?.payload).toMatchObject({
      rule: "elided",
      detail: expect.stringContaining("The builder elided src/cli.ts: line 2"),
    })
    expect(await factory.retry(id)).toMatchObject({ ok: true, state: "received" })
  })
})
