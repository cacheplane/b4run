import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadWorkspaceReadError } from "@b4run/cli/workspace"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/lib/controller/factory.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { fakeBuilderHandoff, fakeWorkerMap } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

let dir: string
let fake: FakeWorker
let factory: Factory

const REPAIRED = "export const fixed = true\n"

type CaptureBaseline = Parameters<typeof createFactory>[0]["captureBaseline"]

/** The baseline the controller captures, injected so this layer needs no container. */
const captureRepairable: CaptureBaseline = async () => ({
  digest: "a".repeat(64),
  files: new Map([
    ["src/cli.ts", "broken\n"],
    ["test/cli.test.ts", "spec\n"],
    ["TASK.md", "task\n"],
  ]),
})

async function boot(
  script: Parameters<typeof createFakeVerifier>[0],
  captureBaseline: CaptureBaseline = captureRepairable,
  /** Called with the temp directory before the factory opens, to break something in it. */
  sabotage: (dir: string) => void = () => {},
) {
  dir = mkdtempSync(join(tmpdir(), "factory-verify-"))
  mkdirSync(join(dir, "out"), { recursive: true })
  sabotage(dir)
  fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
  const verifier = createFakeVerifier(script)
  const reader = createFakeWorkspaceReader({})
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    generatedTasksDir: join(dir, "tasks"),
    captureRoot: dir,
    workers: fakeWorkerMap({
      builder: {
        client: createHttpWorkerClient(fake.baseUrl, { token: TEST_WORKER_TOKEN }),
        reader,
      },
    }),
    captureBuilderHandoff: fakeBuilderHandoff,
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier,
    captureBaseline,
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
    const row = await factory.waitFor(
      id,
      (r) => r.state === "awaiting_approval" || r.state === "blocked" || r.state === "failed",
      20_000,
    )
    expect(row.state).toBe("awaiting_approval")
    expect(row.candidateDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(row.bundleDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(row.awaitingSince).not.toBeNull()
    const types = factory.events(id).map((e) => e.type)
    expect(types).toContain("candidate_assembled")
    expect(types).toContain("receipt_issued")
    expect(types).toContain("bundle_frozen")
    // The read named the source dispatch handed the thread: the worker must answer with it.
    expect(reader.targets).toEqual([
      {
        threadId: dispatched.workerThreadId,
        taskId: "cli-flags",
        sourceDigest: factory.events(id).find((e) => e.type === "builder_source_staged")?.payload
          .sourceDigest,
      },
    ])
  })

  it("blocks with verification_failed when the independent checks fail, and freezes nothing", async () => {
    const { reader } = await boot({ verdict: "fail", visible: "pass", independent: "fail" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const row = await factory.waitFor(
      id,
      (r) => r.state === "blocked" || r.state === "awaiting_approval",
      20_000,
    )
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
    reader.set(dispatched.workerThreadId as string, {
      ...repaired(),
      "src/cli.ts": "broken\n",
      "test/cli.test.ts": "weakened\n",
    })
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(row.blockedReason).toBe("scope_violation")
    expect(verifier.verified).toEqual([])
  })

  it("blocks a removed path as a scope violation, not as a baseline mismatch", async () => {
    // The spec's own invariant table puts "builder adds or removes a path" under
    // `scope_violation`. `baseline_mismatch` meant something else entirely — a workspace
    // whose own recorded source digest disagrees with the controller's — and rung 1 makes
    // no such check, so the reason cannot be reported honestly.
    const { reader, verifier } = await boot({ verdict: "pass" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    const { "TASK.md": _gone, ...withoutTask } = repaired()
    reader.set(dispatched.workerThreadId as string, withoutTask)
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(row.blockedReason).toBe("scope_violation")
    expect(verifier.verified).toEqual([])
  })

  it("blocks unrepresentable content as an encoding violation of its own", async () => {
    // A NUL byte in an allowed path is not the builder writing where it may not: the path
    // was in its inventory. Reporting it as `scope_violation` sends an operator looking for
    // a stray write that never happened.
    const { reader, verifier } = await boot({ verdict: "pass" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, {
      ...repaired(),
      "src/cli.ts": "export const fixed = true\u0000\n",
    })
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(row.blockedReason).toBe("encoding_violation")
    expect(verifier.verified).toEqual([])
    expect(
      factory.events(id).find((e) => e.type === "transition" && e.payload.rule === "encoding"),
    ).toBeDefined()
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

  it("blocks when the builder's workspace cannot be read", async () => {
    // The reader is scripted with no threads at all, so the read rejects.
    await boot({ verdict: "pass" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(row.blockedReason).toBe("verification_inconclusive")
    expect(factory.events(id).map((e) => e.type)).toContain("workspace_unreadable")
    // Nothing was assembled and nothing was verified: the controller never saw any bytes.
    expect(row.candidateDigest).toBeNull()
    expect(factory.evidence(id)).toEqual({
      candidate: null,
      receipt: null,
      bundle: null,
      oracleReceipt: null,
    })
  })

  it("blocks, retryably, when the worker's workspace changed under the read", async () => {
    // The worker's `409 workspace_changed`: a file grew between the walk and the read. The
    // controller does not know what the candidate is, so it is inconclusive, the same answer
    // any read it could not make gets, and the code is on the record for an operator.
    const { reader, verifier } = await boot({ verdict: "pass" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.fail(
      dispatched.workerThreadId as string,
      new ThreadWorkspaceReadError(409, "workspace_changed", "Worker answered 409"),
    )
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(row.blockedReason).toBe("verification_inconclusive")
    expect(
      factory.events(id).find((e) => e.type === "workspace_unreadable")?.payload,
    ).toMatchObject({ status: 409, code: "workspace_changed" })
    expect(row.candidateDigest).toBeNull()
    expect(verifier.calls).toHaveLength(0)
  })

  it("fails closed when the journal holds no digest it handed the thread", async () => {
    // The builder's bytes are scripted and would verify; the handoff journalled no digest, so
    // the controller cannot tell which workspace the worker must answer with and never asks.
    dir = mkdtempSync(join(tmpdir(), "factory-verify-"))
    mkdirSync(join(dir, "out"), { recursive: true })
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const verifier = createFakeVerifier({ verdict: "pass" })
    const reader = createFakeWorkspaceReader({})
    factory = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      generatedTasksDir: join(dir, "tasks"),
      captureRoot: dir,
      workers: fakeWorkerMap({
        builder: {
          client: createHttpWorkerClient(fake.baseUrl, { token: TEST_WORKER_TOKEN }),
          reader,
        },
      }),
      // The workspace is staged and named as ever; only the digest the journal records is not
      // one, as a journal written by something other than `dispatch` could leave it.
      captureBuilderHandoff: async (input) => {
        const captured = await fakeBuilderHandoff(input)
        return {
          ...captured,
          handoff: {
            ...captured.handoff,
            workspace: { ...captured.handoff.workspace, sourceDigest: "" },
          },
        }
      },
      exportDir: join(dir, "out"),
      artifactsDir: join(dir, "artifacts"),
      verifier,
      captureBaseline: captureRepairable,
    })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    const threadId = dispatched.workerThreadId as string
    reader.set(threadId, repaired())
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(row.blockedReason).toBe("verification_inconclusive")
    expect(
      String(factory.events(id).find((e) => e.type === "workspace_unreadable")?.payload.error),
    ).toMatch(new RegExp(`No builder source digest is journalled for thread ${threadId}`))
    expect(reader.reads).toEqual([])
    expect(row.candidateDigest).toBeNull()
    expect(verifier.calls).toHaveLength(0)
  })

  it("blocks when the controller cannot capture its own baseline", async () => {
    const { reader, verifier } = await boot({ verdict: "pass" }, async () => {
      throw new Error("baseline container unavailable")
    })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(row.blockedReason).toBe("verification_inconclusive")
    expect(factory.events(id).map((e) => e.type)).toContain("baseline_unavailable")
    expect(row.candidateDigest).toBeNull()
    expect(verifier.verified).toEqual([])
    expect(factory.evidence(id)).toEqual({
      candidate: null,
      receipt: null,
      bundle: null,
      oracleReceipt: null,
    })
  })

  it("blocks rather than stranding the row when the phase throws where nothing expects it", async () => {
    // A file where the artifacts directory should be: `artifacts.put` cannot even mkdir, so
    // the write of the assembled candidate throws in a place with no handler of its own.
    // Nothing about that throw is a verdict on the candidate, and leaving the row in
    // `verifying` would hang it until a restart.
    const { reader, verifier } = await boot({ verdict: "pass" }, captureRepairable, (base) =>
      writeFileSync(join(base, "artifacts"), "not a directory\n"),
    )
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(row.blockedReason).toBe("verification_inconclusive")
    const types = factory.events(id).map((e) => e.type)
    expect(types).toContain("verification_phase_error")
    expect(types).not.toContain("run_observer_error")
    // The candidate was never stored, and the verifier was never asked about bytes the
    // controller could not keep.
    expect(factory.evidence(id)).toEqual({
      candidate: null,
      receipt: null,
      bundle: null,
      oracleReceipt: null,
    })
    expect(verifier.verified).toEqual([])
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
