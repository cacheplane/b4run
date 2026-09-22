import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/lib/controller/factory.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier, type FakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"

let dir: string
let fake: FakeWorker
let factory: Factory
const BASE_MS = Date.parse("2026-09-16T10:00:00.000Z")
let nowMs = BASE_MS

const REPAIRED = "export const fixed = true\n"

/**
 * The baseline the controller captures, injected so this layer needs no container. The
 * digest is a variable so a test can make the fixture on disk change between freezing a
 * bundle and approving it, which is one of the two ways consent is invalidated.
 */
let baselineDigest = "a".repeat(64)
const captureRepairable = async () => ({
  digest: baselineDigest,
  files: new Map([
    ["src/cli.ts", "broken\n"],
    ["test/cli.test.ts", "spec\n"],
    ["TASK.md", "task\n"],
  ]),
})

/** What the builder is deemed to have left behind: a repair and two untouched files. */
const repaired = () => ({
  "src/cli.ts": REPAIRED,
  "test/cli.test.ts": "spec\n",
  "TASK.md": "task\n",
})

const out = () => join(dir, "out")

async function boot(
  script: Parameters<typeof createFakeVerifier>[0] = { verdict: "pass" },
  workerOptions: Omit<FakeWorkerOptions, "outboxDir"> = {},
): Promise<{ verifier: FakeVerifier; reader: FakeWorkspaceReader }> {
  dir = mkdtempSync(join(tmpdir(), "factory-approve-"))
  // readdirSync asserts on this directory before anything is written to it.
  mkdirSync(out(), { recursive: true })
  fake = await createFakeWorker({
    outboxDir: join(dir, "unused"),
    run: "edits_only",
    ...workerOptions,
  })
  const verifier = createFakeVerifier(script)
  const reader = createFakeWorkspaceReader({})
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    worker: createHttpWorkerClient(fake.baseUrl),
    workerRoute: "/build#agent",
    exportDir: out(),
    artifactsDir: join(dir, "artifacts"),
    verifier,
    workspaceReader: reader,
    captureBaseline: captureRepairable,
    approvalTtlMs: 60_000,
    now: () => nowMs,
  })
  return { verifier, reader }
}

// The clock is shared state a test may have advanced: every test starts from the same now.
beforeEach(() => {
  nowMs = BASE_MS
  baselineDigest = "a".repeat(64)
})
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Drive a work order through the verifying phase to the frozen bundle, with the bundle
 * digest narrowed to a string.
 */
async function awaiting(
  reader: FakeWorkspaceReader,
  files: Readonly<Record<string, string>> = repaired(),
): Promise<WorkOrderRow & { bundleDigest: string; candidateDigest: string }> {
  const { id } = await factory.create({ taskId: "cli-flags" })
  await factory.dispatch(id)
  const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
  reader.set(dispatched.workerThreadId as string, files)
  const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval", 20_000)
  if (row.bundleDigest === null || row.candidateDigest === null)
    throw new Error(`${id} reached the gate with no frozen bundle`)
  return row as WorkOrderRow & { bundleDigest: string; candidateDigest: string }
}

const resumes = () => fake.requests.filter((r) => r.path.endsWith("/resume"))

describe("approve", () => {
  it("exports exactly the approved bytes, named by the bundle digest", async () => {
    const { reader } = await boot()
    const row = await awaiting(reader)
    const outcome = await factory.approve(row.id, {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
    })
    expect(outcome).toMatchObject({ ok: true, state: "exported" })
    expect(readdirSync(out())).toEqual([`${row.bundleDigest}.json`])
    const written = JSON.parse(readFileSync(join(out(), `${row.bundleDigest}.json`), "utf8"))
    expect(written.changes).toEqual({ "src/cli.ts": REPAIRED })
    expect(written.bundle.digest).toBe(row.bundleDigest)
    expect(factory.show(row.id)).toMatchObject({ state: "exported", activeStartedAt: null })
    expect(factory.events(row.id).map((e) => e.type)).toContain("delivery_written")
    // Nothing was asked of the worker: the controller wrote the bytes itself.
    expect(resumes()).toHaveLength(0)
  })

  it("refuses a stale revision, a wrong bundle digest, and an expired bundle, touching nothing", async () => {
    const { reader, verifier } = await boot()
    const row = await awaiting(reader)
    const verifiedBefore = verifier.verified.length
    expect(
      await factory.approve(row.id, { revision: row.revision - 1, bundleDigest: row.bundleDigest }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/revision/) })
    expect(
      await factory.approve(row.id, { revision: row.revision, bundleDigest: "f".repeat(64) }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/Bundle digest/) })
    nowMs += 61_000
    expect(
      await factory.approve(row.id, { revision: row.revision, bundleDigest: row.bundleDigest }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/expired/) })
    // No re-verification was attempted and nothing was written.
    expect(verifier.verified).toHaveLength(verifiedBefore)
    expect(readdirSync(out())).toEqual([])
    expect(factory.show(row.id)).toMatchObject({
      state: "awaiting_approval",
      revision: row.revision,
    })
  })

  it("re-verifies before writing and refuses when re-verification does not pass", async () => {
    const { reader, verifier } = await boot({ verdict: "pass" })
    const row = await awaiting(reader)
    // The policy or the environment moved under the frozen bundle: the same bytes no longer
    // earn the verdict the operator was shown.
    verifier.script = { verdict: "fail" }
    const outcome = await factory.approve(row.id, {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/Re-verification did not pass/)
    expect(readdirSync(out())).toEqual([])
    expect(factory.events(row.id).map((e) => e.type)).toContain("reverification_rejected")
    // The refusal leaves the review where it was, so the operator can deny or cancel it.
    expect(factory.show(row.id)).toMatchObject({
      state: "awaiting_approval",
      revision: row.revision,
    })
  })

  it("refuses without writing when the re-verification harness cannot run", async () => {
    const { reader, verifier } = await boot({ verdict: "pass" })
    const row = await awaiting(reader)
    verifier.script = { throws: "docker unavailable" }
    expect(
      await factory.approve(row.id, { revision: row.revision, bundleDigest: row.bundleDigest }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/Re-verification could not run/) })
    expect(readdirSync(out())).toEqual([])
    expect(factory.show(row.id)?.state).toBe("awaiting_approval")
  })

  it("is idempotent per operation key, and exports once", async () => {
    const { reader } = await boot()
    const row = await awaiting(reader)
    const input = {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
      operationKey: "approve-1",
    }
    const first = await factory.approve(row.id, input)
    const second = await factory.approve(row.id, input)
    expect(second).toEqual(first)
    expect(readdirSync(out())).toEqual([`${row.bundleDigest}.json`])
  })

  it("blocks with export_unconfirmed when the same bundle was exported with other content", async () => {
    const { reader } = await boot()
    const row = await awaiting(reader)
    // A receipt already on disk under this bundle digest, with different bytes: overwriting it
    // would deliver something the operator never approved.
    writeFileSync(join(out(), `${row.bundleDigest}.json`), "{}\n")
    const outcome = await factory.approve(row.id, {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
    })
    expect(outcome).toMatchObject({ ok: false, state: "blocked" })
    expect(outcome.message).toMatch(/Export failed/)
    expect(factory.show(row.id)?.blockedReason).toBe("export_unconfirmed")
    expect(readFileSync(join(out(), `${row.bundleDigest}.json`), "utf8")).toBe("{}\n")
    expect(factory.events(row.id).map((e) => e.type)).toContain("export_failed")
  })

  it("refuses, rather than stranding the operation key, when the receipt cannot be recorded", async () => {
    // Both receipts carry one id, so the re-verification's differing verdict collides with
    // the receipt already stored by the verifying phase: a synchronous throw out of the
    // registry write, in a command that owns an operation key.
    const { reader, verifier } = await boot({ verdict: "pass", receiptId: "rc-fixed" })
    const row = await awaiting(reader)
    verifier.script = { verdict: "fail", receiptId: "rc-fixed" }
    const input = {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
      operationKey: "approve-collide",
    }
    const outcome = await factory.approve(row.id, input)
    expect(outcome).toMatchObject({ ok: false, state: "awaiting_approval" })
    expect(outcome.message).toMatch(/receipt could not be recorded/i)
    expect(readdirSync(out())).toEqual([])
    expect(factory.events(row.id).map((e) => e.type)).toContain("receipt_unrecorded")
    // The key was completed, so the same key replays the refusal instead of throwing
    // CommandInFlightError forever.
    expect(await factory.approve(row.id, input)).toEqual(outcome)
  })

  it("refuses, rather than stranding the operation key, when the delivery cannot be recorded", async () => {
    const { reader } = await boot()
    const row = await awaiting(reader)
    // A delivery row already under this work order id: the registry write after the bytes
    // land violates the deliveries primary key.
    const planted = new DatabaseSync(join(dir, "registry.sqlite"))
    planted.exec(
      `INSERT INTO deliveries (work_order_id, candidate_digest, receipt_path, observed_at)
       VALUES ('${row.id}', '${row.candidateDigest}', '/elsewhere.json', '2026-09-16T10:00:00.000Z')`,
    )
    planted.close()
    const input = {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
      operationKey: "approve-delivery",
    }
    const outcome = await factory.approve(row.id, input)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/delivery could not be recorded/i)
    // The bytes are on disk, and the journal says the record of them is missing.
    expect(readdirSync(out())).toEqual([`${row.bundleDigest}.json`])
    expect(factory.events(row.id).map((e) => e.type)).toContain("delivery_unrecorded")
    expect(await factory.approve(row.id, input)).toEqual(outcome)
  })

  it("refuses when the stored candidate bytes no longer hash to their digest", async () => {
    const { reader, verifier } = await boot()
    const row = await awaiting(reader)
    const artifactDigest = factory.evidence(row.id).candidate?.artifactDigest as string
    // The bytes under the digest were replaced with other changes. The receipt digest guard
    // cannot see this: a verifier that echoes its input agrees with whatever it is handed.
    writeFileSync(
      join(dir, "artifacts", `${artifactDigest}.txt`),
      JSON.stringify({ "src/cli.ts": "smuggled\n" }, null, 2),
    )
    const verifiedBefore = verifier.verified.length
    const outcome = await factory.approve(row.id, {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/could not be read/i)
    expect(verifier.verified).toHaveLength(verifiedBefore)
    expect(readdirSync(out())).toEqual([])
    expect(factory.events(row.id).map((e) => e.type)).toContain("candidate_unreadable")
  })

  it("refuses to approve from a state that is not awaiting_approval", async () => {
    const { reader } = await boot({ verdict: "fail" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(
      await factory.approve(id, { revision: row.revision, bundleDigest: "a".repeat(64) }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/Cannot approve from blocked/) })
    expect(readdirSync(out())).toEqual([])
  })
})

/**
 * The invariant the spec and the README both state in bold: a policy or environment change
 * invalidates consent even when the candidate bytes are byte-identical. The frozen payload
 * was write-only before this — nothing read `bundle.payload` — so `approve` re-verified
 * under whatever policy and image were current and exported under a bundle asserting the
 * old ones.
 */
describe("approve enforces what the frozen bundle asserts", () => {
  it("refuses when the verifier reports a different environment than the bundle bound", async () => {
    const { reader, verifier } = await boot()
    const row = await awaiting(reader)
    // The same bytes, the same policy, a different image: the pass is earned somewhere the
    // approver never consented to.
    verifier.script = { ...verifier.script, environmentIdentity: "fake:other-image" }
    const outcome = await factory.approve(row.id, {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
    })
    expect(outcome).toMatchObject({
      ok: false,
      state: "awaiting_approval",
      message: expect.stringMatching(/Verifier environment changed/),
    })
    expect(readdirSync(out())).toEqual([])
    expect(factory.events(row.id).map((e) => e.type)).toContain("bundle_invalidated")
  })

  it("refuses when the controller's baseline has moved since the bundle was frozen", async () => {
    const { reader } = await boot()
    const row = await awaiting(reader)
    baselineDigest = "b".repeat(64)
    expect(
      await factory.approve(row.id, { revision: row.revision, bundleDigest: row.bundleDigest }),
    ).toMatchObject({
      ok: false,
      state: "awaiting_approval",
      message: expect.stringMatching(/Baseline changed/),
    })
    expect(readdirSync(out())).toEqual([])
  })

  it("refuses when the bundle's policy digest is not the policy on disk", async () => {
    const { reader, verifier } = await boot()
    const row = await awaiting(reader)
    const verifiedBefore = verifier.verified.length
    // The bundle is edited rather than the fixture: the comparison is the same one either
    // way, and a test must not rewrite a checks fixture the rest of the suite reads.
    const db = new DatabaseSync(join(dir, "registry.sqlite"))
    const stored = db.prepare("SELECT payload FROM bundles WHERE digest = ?").get(row.bundleDigest)
    const payload = JSON.parse(String((stored as { payload: string }).payload))
    payload.policyDigest = "0".repeat(64)
    db.prepare("UPDATE bundles SET payload = ? WHERE digest = ?").run(
      JSON.stringify(payload),
      row.bundleDigest,
    )
    db.close()
    expect(
      await factory.approve(row.id, { revision: row.revision, bundleDigest: row.bundleDigest }),
    ).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Verification policy changed/),
    })
    // Refused before anything ran: a re-verification under the new policy is exactly the
    // thing that must not happen.
    expect(verifier.verified).toHaveLength(verifiedBefore)
    expect(readdirSync(out())).toEqual([])
  })

  it("refuses a bundle payload it cannot read at all", async () => {
    const { reader } = await boot()
    const row = await awaiting(reader)
    const db = new DatabaseSync(join(dir, "registry.sqlite"))
    db.prepare("UPDATE bundles SET payload = ? WHERE digest = ?").run(
      JSON.stringify({ operation: "export-local" }),
      row.bundleDigest,
    )
    db.close()
    expect(
      await factory.approve(row.id, { revision: row.revision, bundleDigest: row.bundleDigest }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/could not be read/) })
    expect(readdirSync(out())).toEqual([])
  })
})

describe("deny", () => {
  it("denies from awaiting_approval without asking the worker for anything", async () => {
    const { reader } = await boot()
    const row = await awaiting(reader)
    const outcome = await factory.deny(row.id)
    expect(outcome).toEqual({ ok: true, state: "denied", message: "Denied" })
    // Rung 1's builder route parks on no gate: there is nothing on the worker to resolve.
    expect(resumes()).toHaveLength(0)
    expect(readdirSync(out())).toEqual([])
  })

  it("denies from blocked, resolving whatever is pending", async () => {
    const { reader } = await boot({ verdict: "pass" }, { run: "unexpected_interrupt" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    await factory.waitFor(id, (r) => r.state === "blocked")
    expect((await factory.deny(id)).state).toBe("denied")
    expect(resumes()).toHaveLength(1)
    expect(resumes()[0]?.body).toMatchObject({ resume: [{ payload: "deny" }] })
  })

  it("refuses deny on a blocked work order with nothing pending", async () => {
    const { reader } = await boot({ verdict: "fail" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const blocked = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(blocked.blockedReason).toBe("verification_failed")
    expect(await factory.deny(id)).toMatchObject({
      ok: false,
      state: "blocked",
      message: "Nothing is pending to deny; cancel the work order instead",
    })
    expect(factory.show(id)).toMatchObject({
      state: "blocked",
      blockedReason: "verification_failed",
      revision: blocked.revision,
    })
    expect(resumes()).toHaveLength(0)
  })

  it("refuses deny from running", async () => {
    await boot({ verdict: "pass" }, { run: "hang" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    expect(await factory.deny(id)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Cannot deny from running/),
    })
    expect(resumes()).toHaveLength(0)
  })
})
