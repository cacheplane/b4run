import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/controller/factory.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

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
) {
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
    expect(factory.evidence(id)).toEqual({ candidate: null, receipt: null, bundle: null })
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
    expect(factory.evidence(id)).toEqual({ candidate: null, receipt: null, bundle: null })
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
