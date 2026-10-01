import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import type { FactoryOptions } from "../src/lib/controller/factory.ts"
import { DeliveryError } from "../src/lib/delivery/adapter.ts"
import { DeliveryUnavailableError } from "../src/lib/domain/errors.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { BundlePayloadSchema } from "../src/lib/review/bundle.ts"
import { createFakeGitHub, type FakeGitHub } from "./fake-delivery-adapter.ts"
import { GOOD_DRAFT } from "./intake-fixtures.ts"
import {
  BASELINE_TEXT,
  ISSUE,
  type IssueHarness,
  issueHarness,
  ORIGIN,
  PIN,
  REPAIRED_TEXT,
  SOURCE,
} from "./issue-work-order.ts"

let harness: IssueHarness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const DRAFT_PR = { kind: "draft-pr", issueState: "open" } as const

/** A fake GitHub holding the pin the harness's work orders are created at. */
function github(): FakeGitHub {
  const fake = createFakeGitHub()
  fake.seed(
    {
      "README.md": "# b4\n",
      [SOURCE]: BASELINE_TEXT,
      "packages/devkit/test/process.test.ts": "spec\n",
      ".github/workflows/ci.yml": "name: CI\n",
    },
    PIN,
  )
  return fake
}

/** The factory's delivery options, with waits that return at once and are recorded. */
function delivery(fake: FakeGitHub, waits: number[] = []): NonNullable<FactoryOptions["delivery"]> {
  return {
    draftPr: { repository: "cacheplane/b4run", baseBranch: "main", adapter: fake },
    sleep: async (ms) => {
      waits.push(ms)
    },
  }
}

const approve = (row: WorkOrderRow & { bundleDigest: string }) =>
  (harness as IssueHarness).factory.approve(row.id, {
    revision: row.revision,
    bundleDigest: row.bundleDigest,
  })
describe("create --deliver draft-pr", () => {
  it("is refused, before anything is created, without delivery or for another repository", async () => {
    harness = await issueHarness()
    const create = () =>
      (harness as IssueHarness).factory.createFromIssue({
        origin: ORIGIN,
        pin: PIN,
        issue: ISSUE,
        deliver: DRAFT_PR,
        operationKey: "issue:912",
      })
    await expect(create()).rejects.toThrow(DeliveryUnavailableError)
    expect(harness.factory.list()).toEqual([])
    await harness.factory.close()
    const fake = github()
    await harness.boot({
      delivery: { ...delivery(fake), draftPr: { ...delivery(fake).draftPr, repository: "x/y" } },
    })
    await expect(create()).rejects.toThrow(/not cacheplane\/b4run/)
    expect(harness.factory.list()).toEqual([])
  })

  it("records where the bundle will go on the row at create", async () => {
    harness = await issueHarness({ delivery: delivery(github()) })
    const created = await harness.factory.createFromIssue({
      origin: ORIGIN,
      pin: PIN,
      issue: ISSUE,
      deliver: DRAFT_PR,
      operationKey: "issue:912",
    })
    expect(created.delivery).toEqual({
      kind: "draft-pr",
      repository: "cacheplane/b4run",
      baseBranch: "main",
      branch: `factory/${created.id}`,
      pathPrefix: null,
      issueStateAtCreate: "open",
    })
  })

  it("freezes the delivery into the bundle the person approves", async () => {
    harness = await issueHarness({ delivery: delivery(github()) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    expect(row.delivery).toMatchObject({ kind: "draft-pr", pathPrefix: "." })
    const payload = BundlePayloadSchema.parse(harness.factory.evidence(row.id).bundle?.payload)
    expect(payload).toMatchObject({
      operation: "draft-pr",
      destinationId: `github:cacheplane/b4run:refs/heads/factory/${row.id}`,
      pin: PIN,
      delivery: { repository: "cacheplane/b4run", baseBranch: "main", pathPrefix: "." },
    })
  })

  it("refuses a draft whose allowed paths reach a delivery-protected path at intake", async () => {
    harness = await issueHarness({ delivery: delivery(github()), maxIntakeAttempts: 1 })
    const task = JSON.parse(GOOD_DRAFT["draft/task.json"] as string) as Record<string, unknown>
    const draft = {
      ...GOOD_DRAFT,
      "draft/task.json": `${JSON.stringify({ ...task, allowedSourcePaths: ["apps/web/vercel.json"] }, null, 2)}\n`,
    }
    await expect(harness.toBundle({ deliver: DRAFT_PR, draft })).rejects.toThrow(
      /intake parked nothing/,
    )
    const refused = harness.factory
      .list()
      .flatMap((r) => harness?.factory.events(r.id) ?? [])
      .find((e) => e.type === "intake_refused")
    expect(refused?.payload.reason).toMatch(
      /apps\/web\/vercel\.json, which a pull request from the factory may never change/,
    )
  })

  it("leaves a local export exactly as it was", async () => {
    harness = await issueHarness({ delivery: delivery(github()) })
    const row = await harness.toBundle()
    expect(row.delivery).toEqual({ kind: "local" })
    const payload = harness.factory.evidence(row.id).bundle?.payload as Record<string, unknown>
    expect(payload.operation).toBe("export-local")
    expect(Object.keys(payload)).not.toContain("delivery")
    expect(await approve(row)).toMatchObject({ ok: true, state: "exported" })
  })
})

describe("approving a draft-PR bundle", () => {
  it("delivers exactly the approved bytes, once, and reads them back", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    expect(row.delivery).toMatchObject({ kind: "draft-pr", pathPrefix: "." })
    const payload = BundlePayloadSchema.parse(harness.factory.evidence(row.id).bundle?.payload)
    expect(payload).toMatchObject({
      operation: "draft-pr",
      destinationId: `github:cacheplane/b4run:refs/heads/factory/${row.id}`,
      pin: PIN,
      delivery: { repository: "cacheplane/b4run", baseBranch: "main", pathPrefix: "." },
    })
    const outcome = await approve(row)
    expect(outcome).toMatchObject({ ok: true, state: "delivered" })
    expect(outcome.message).toContain("https://github.com/cacheplane/b4run/pull/1000")
    const head = fake.refs.get(`factory/${row.id}`) as string
    expect(fake.filesAt(head)[SOURCE]).toBe(REPAIRED_TEXT)
    expect(fake.commits.get(head)?.parents).toEqual([PIN])
    expect(fake.pulls).toHaveLength(1)
    expect(harness.factory.show(row.id)).toMatchObject({ state: "delivered" })
    // One approval, one authorization: the approval row and the outbox intent name each other.
    const [approval] = harness.factory
      .events(row.id)
      .filter((e) => e.type === "transition" && e.payload.event === "approve_delivery")
    expect(approval?.payload).toMatchObject({ bundleDigest: row.bundleDigest })
  })

  it("refuses before re-verifying when preflight fails, and stays at the gate", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    const verified = harness.verifier.verified.length
    fake.fail("open", new DeliveryError("unauthorized", "installation not found", undefined, 404))
    expect(await approve(row)).toMatchObject({
      ok: false,
      state: "awaiting_approval",
      message: expect.stringMatching(/^Delivery preflight: unauthorized/),
    })
    fake.rules.set("main", [])
    const again = await harness.factory.approve(row.id, {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
      operationKey: "approve-again",
    })
    expect(again.message).toMatch(/no ruleset restricts updates to main/)
    expect(harness.verifier.verified).toHaveLength(verified)
    expect(fake.writes()).toEqual([])
  })

  it("is refused when the controller's delivery no longer matches the bundle", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    await harness.factory.close()
    await harness.boot({
      delivery: { ...delivery(fake), draftPr: { ...delivery(fake).draftPr, baseBranch: "next" } },
    })
    expect(await approve(row)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Delivery not configured for cacheplane\/b4run at main/),
    })
  })

  it("resumes a delivery a controller stop interrupted, at boot, creating nothing twice", async () => {
    const fake = github()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    harness = await issueHarness({
      delivery: {
        ...delivery(fake),
        sleep: (_ms, signal) => Promise.race([held, aborted(signal)]),
      },
    })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.fail("createBranch", new DeliveryError("transient", "HTTP 502", undefined, 502))
    const approving = approve(row)
    await harness.factory.waitFor(row.id, (r) => r.state === "delivering")
    await waitForEvent(row.id, "delivery_retry")
    await harness.factory.close()
    await approving.catch(() => undefined)
    release()
    await harness.boot({ delivery: delivery(fake) })
    const final = await harness.factory.waitFor(row.id, (r) => r.state !== "delivering", 10_000)
    expect(final.state).toBe("delivered")
    expect(fake.pulls).toHaveLength(1)
    expect(fake.writes().filter((w) => w === "createDraftPull")).toHaveLength(1)
  })
})

describe("every way a delivery starts", () => {
  /** A delivery whose first createBranch fails, waiting on `release` (or a close) to retry. */
  async function heldAtBranch(overrides: Partial<NonNullable<FactoryOptions["delivery"]>> = {}) {
    const fake = github()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    harness = await issueHarness({
      delivery: {
        ...delivery(fake),
        sleep: (_ms, signal) => Promise.race([held, aborted(signal)]),
        ...overrides,
      },
    })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.fail("createBranch", new DeliveryError("transient", "HTTP 502", undefined, 502))
    const approving = approve(row)
    await waitForEvent(row.id, "delivery_retry")
    return { fake, row, approving, release }
  }
  const opens = (fake: FakeGitHub) => fake.calls.filter((c) => c === "open").length

  it("runs one worker when an approve and reconciles race", async () => {
    const { fake, row, approving, release } = await heldAtBranch()
    const before = opens(fake)
    const h = harness as IssueHarness
    await Promise.all([h.factory.reconcileWorkOrder(row.id), h.factory.reconcileWorkOrder(row.id)])
    release()
    expect(await approving).toMatchObject({ ok: true, state: "delivered" })
    // A second worker would have opened its own session; none did, and none was superseded.
    expect(opens(fake)).toBe(before)
    expect(h.factory.events(row.id).filter((e) => e.type === "delivery_stopped")).toEqual([])
    expect(fake.pulls).toHaveLength(1)
    // Settled: a reconcile of the delivered row starts nothing.
    await h.factory.reconcileWorkOrder(row.id)
    expect(opens(fake)).toBe(before)
  })

  it("closes promptly during a real wait, and the row stays delivering for the next boot", async () => {
    const fake = github()
    harness = await issueHarness({
      // No sleep seam: the controller's own, which must give way to the close.
      delivery: {
        draftPr: delivery(fake).draftPr,
        limits: { backoffStartMs: 60_000, maxWaitMs: 60_000 },
      },
      closeTimeoutMs: 30_000,
    })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.fail("createBranch", new DeliveryError("transient", "HTTP 502", undefined, 502))
    const approving = approve(row)
    await waitForEvent(row.id, "delivery_retry")
    const started = Date.now()
    await harness.factory.close()
    expect(Date.now() - started).toBeLessThan(5_000)
    await approving.catch(() => undefined)
    await harness.boot({ delivery: delivery(fake) })
    const stopped = harness.factory.events(row.id).find((e) => e.type === "delivery_stopped")
    expect(stopped?.payload).toMatchObject({
      state: "delivering",
      reason: "the controller is closing",
    })
    const final = await harness.factory.waitFor(row.id, (r) => r.state !== "delivering", 10_000)
    expect(final.state).toBe("delivered")
    expect(fake.pulls).toHaveLength(1)
  })

  it("does not resume an approval at boot toward another configured destination", async () => {
    const { fake, row, approving, release } = await heldAtBranch()
    const h = harness as IssueHarness
    await h.factory.close()
    await approving.catch(() => undefined)
    release()
    const before = opens(fake)
    await h.boot({
      delivery: { ...delivery(fake), draftPr: { ...delivery(fake).draftPr, baseBranch: "next" } },
    })
    expect(h.factory.show(row.id)).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unauthorized",
    })
    expect(
      h.factory
        .events(row.id)
        .filter((e) => e.type === "delivery_refused")
        .at(-1)?.payload,
    ).toMatchObject({
      detail: expect.stringContaining("the approval names cacheplane/b4run at main"),
    })
    expect(opens(fake)).toBe(before)
    expect(fake.refs.has(`factory/${row.id}`)).toBe(false)
    expect(fake.pulls).toEqual([])
  })

  it("blocks a delivering row at boot when the controller no longer delivers", async () => {
    const fake = github()
    // Booted with delivery by override, so a plain boot() later configures none.
    harness = await issueHarness()
    await harness.factory.close()
    // The 502's wait returns only when the controller closes.
    await harness.boot({
      delivery: { ...delivery(fake), sleep: (_ms, signal) => aborted(signal) },
    })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.fail("createBranch", new DeliveryError("transient", "HTTP 502", undefined, 502))
    const approving = approve(row)
    await waitForEvent(row.id, "delivery_retry")
    await harness.factory.close()
    await approving.catch(() => undefined)
    const before = opens(fake)
    await harness.boot()
    expect(harness.factory.show(row.id)).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unauthorized",
    })
    expect(
      harness.factory
        .events(row.id)
        .filter((e) => e.type === "delivery_refused")
        .at(-1)?.payload.detail,
    ).toMatch(/no draft-PR delivery configured/)
    expect(opens(fake)).toBe(before)
    expect(fake.pulls).toEqual([])
  })
})

describe("redeliver", () => {
  it("redelivers a healable block under the same approval, and refuses the rest", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.fail("compare", new DeliveryError("unauthorized", "HTTP 401", undefined, 401))
    expect(await approve(row)).toMatchObject({ ok: false, state: "blocked" })
    const blocked = harness.factory.show(row.id) as WorkOrderRow
    expect(blocked.blockedReason).toBe("delivery_unauthorized")
    expect(
      await harness.factory.redeliver(row.id, {
        revision: blocked.revision,
        bundleDigest: "f".repeat(64),
      }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/Bundle digest/) })
    expect(
      await harness.factory.redeliver(row.id, {
        revision: blocked.revision,
        bundleDigest: row.bundleDigest,
      }),
    ).toMatchObject({ ok: true, state: "delivered" })
    expect(fake.pulls).toHaveLength(1)
  })

  it("does not deliver to a destination other than the one approved, after a restart", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.fail("compare", new DeliveryError("transient", "HTTP 502", undefined, 502), { times: 9 })
    expect(await approve(row)).toMatchObject({ ok: false, state: "blocked" })
    await harness.factory.close()
    await harness.boot({
      delivery: { ...delivery(fake), draftPr: { ...delivery(fake).draftPr, baseBranch: "next" } },
    })
    const blocked = harness.factory.show(row.id) as WorkOrderRow
    expect(
      await harness.factory.redeliver(row.id, {
        revision: blocked.revision,
        bundleDigest: row.bundleDigest,
      }),
    ).toMatchObject({ ok: false, state: "blocked" })
    expect(
      harness.factory
        .events(row.id)
        .filter((e) => e.type === "delivery_refused")
        .at(-1)?.payload,
    ).toMatchObject({
      detail: expect.stringContaining("the approval names cacheplane/b4run at main"),
    })
    expect(fake.writes()).toEqual([])
  })

  it("does not redeliver more than a day after the approval", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.fail("compare", new DeliveryError("unauthorized", "HTTP 401", undefined, 401))
    expect(await approve(row)).toMatchObject({ ok: false, state: "blocked" })
    await harness.factory.close()
    await harness.boot({ delivery: delivery(fake), now: () => Date.now() + 86_400_001 })
    const blocked = harness.factory.show(row.id) as WorkOrderRow
    expect(blocked.blockedReason).toBe("delivery_unauthorized")
    expect(
      await harness.factory.redeliver(row.id, {
        revision: blocked.revision,
        bundleDigest: row.bundleDigest,
      }),
    ).toMatchObject({ ok: false, state: "blocked", message: expect.stringMatching(/24 hours ago/) })
    expect(fake.writes()).toEqual([])
    expect(fake.pulls).toEqual([])
  })

  it("does not redeliver a base conflict: the remedy is a new work order", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.comparison = { status: "ahead", aheadBy: 2, files: [{ filename: SOURCE }], complete: true }
    expect(await approve(row)).toMatchObject({ ok: false, state: "blocked" })
    const blocked = harness.factory.show(row.id) as WorkOrderRow
    expect(blocked.blockedReason).toBe("delivery_base_conflict")
    expect(
      await harness.factory.redeliver(row.id, {
        revision: blocked.revision,
        bundleDigest: row.bundleDigest,
      }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/waiting does not heal it/) })
    expect(fake.writes()).toEqual([])
  })
})

describe("the approval's start path", () => {
  const approveAs = (row: WorkOrderRow & { bundleDigest: string }, operationKey: string) =>
    (harness as IssueHarness).factory.approve(row.id, {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
      operationKey,
    })

  it("refuses a second approval racing the first under its own key, and delivers once", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    const [first, second] = await Promise.allSettled([approveAs(row, "k1"), approveAs(row, "k2")])
    expect(first).toMatchObject({ status: "fulfilled", value: { ok: true, state: "delivered" } })
    expect(second).toMatchObject({
      status: "fulfilled",
      value: { ok: false, message: "Work order changed state while approving" },
    })
    expect(
      registryRows(
        row.id,
        "SELECT operation_key, outcome FROM commands WHERE work_order_id = ? AND command = 'approve' ORDER BY operation_key",
      ),
    ).toMatchObject([
      { operation_key: "k1", outcome: expect.stringContaining('"ok":true') },
      { operation_key: "k2", outcome: expect.stringContaining('"ok":false') },
    ])
    expect(fake.pulls).toHaveLength(1)
  })

  it("answers an approval a close interrupted with the delivery the next boot finished", async () => {
    const fake = github()
    harness = await issueHarness({
      delivery: { ...delivery(fake), sleep: (_ms, signal) => aborted(signal) },
    })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.fail("createBranch", new DeliveryError("transient", "HTTP 502", undefined, 502))
    const approving = approve(row)
    await waitForEvent(row.id, "delivery_retry")
    await harness.factory.close()
    await expect(approving).rejects.toThrow(/closed while delivering .* resumes it/)
    await harness.boot({ delivery: delivery(fake) })
    const final = await harness.factory.waitFor(row.id, (r) => r.state !== "delivering", 10_000)
    expect(final.state).toBe("delivered")
    // The replay is the approval's answer, and it is the delivery's, not the boot's guess.
    expect(await approve(row)).toMatchObject({
      ok: true,
      state: "delivered",
      message: expect.stringContaining("/pull/1000"),
    })
    expect(fake.pulls).toHaveLength(1)
  })

  it("refuses an intent that does not validate rather than leaving the key in flight", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake), actor: "" })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    expect(await approve(row)).toMatchObject({
      ok: false,
      state: "awaiting_approval",
      message: expect.stringMatching(/^The delivery intent could not be built/),
    })
    expect(outboxRows(row.id)).toBe(0)
    expect(fake.writes()).toEqual([])
  })

  it("refuses a candidate whose recorded changed paths reach a protected path", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    writeRegistry(
      "UPDATE candidates SET changed_paths = ? WHERE work_order_id = ?",
      JSON.stringify([SOURCE, ".github/workflows/ci.yml"]),
      row.id,
    )
    expect(await approve(row)).toMatchObject({
      ok: false,
      state: "awaiting_approval",
      message: expect.stringMatching(/\.github\/workflows\/ci\.yml, which a pull request/),
    })
    expect(outboxRows(row.id)).toBe(0)
    expect(fake.calls).not.toContain("open")
  })

  it("refuses approved bytes that reach a protected path the record does not list", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    // A baseline that holds the workflow too, so nothing but the guard can refuse it.
    await harness.factory.close()
    await harness.boot({
      delivery: delivery(fake),
      captureBaseline: async () => ({
        digest: "a".repeat(64),
        files: new Map([
          [SOURCE, BASELINE_TEXT],
          ["packages/devkit/test/process.test.ts", "spec\n"],
          [".github/workflows/ci.yml", "name: CI\n"],
        ]),
      }),
    })
    // The artifact the candidate names is swapped for bytes that also change a workflow; its
    // recorded changed paths still name only the source.
    const bytes = JSON.stringify({ [SOURCE]: REPAIRED_TEXT, ".github/workflows/ci.yml": "x\n" })
    const digest = createHash("sha256").update(bytes).digest("hex")
    writeFileSync(join((harness as IssueHarness).dir, "artifacts", `${digest}.txt`), bytes)
    writeRegistry(
      "UPDATE candidates SET artifact_digest = ? WHERE work_order_id = ?",
      digest,
      row.id,
    )
    expect(await approve(row)).toMatchObject({
      ok: false,
      state: "awaiting_approval",
      message: expect.stringMatching(/\.github\/workflows\/ci\.yml, which a pull request/),
    })
    expect(outboxRows(row.id)).toBe(0)
    expect(fake.writes()).toEqual([])
  })

  it("refuses a row whose delivery no longer matches the frozen one", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    writeRegistry(
      "UPDATE work_orders SET delivery = json_set(delivery, '$.issueStateAtCreate', 'closed') WHERE id = ?",
      row.id,
    )
    expect(await approve(row)).toMatchObject({
      ok: false,
      state: "awaiting_approval",
      message: "Delivery changed since the bundle was frozen; freeze a new bundle",
    })
    expect(outboxRows(row.id)).toBe(0)
    expect(fake.calls).not.toContain("open")
  })

  it("refuses a specification edited after the freeze (D18)", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    const spec = join(harness.generated, row.id, "spec.md")
    writeFileSync(spec, `${readFileSync(spec, "utf8")}\nEDITED\n`)
    expect(await approve(row)).toMatchObject({
      ok: false,
      state: "awaiting_approval",
      message: expect.stringMatching(/changed since the bundle was frozen/),
    })
    expect(outboxRows(row.id)).toBe(0)
    expect(fake.writes()).toEqual([])
  })

  it("ends a delivery cancelled mid-way cancelled, with no pull request (D24)", async () => {
    const fake = github()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    harness = await issueHarness({
      delivery: {
        ...delivery(fake),
        sleep: (_ms, signal) => Promise.race([held, aborted(signal)]),
      },
    })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    fake.fail("createBranch", new DeliveryError("transient", "HTTP 502", undefined, 502))
    const approving = approve(row)
    await waitForEvent(row.id, "delivery_retry")
    const cancelling = harness.factory.cancel(row.id)
    await harness.factory.waitFor(row.id, (r) => r.state !== "delivering")
    release()
    expect(await cancelling).toMatchObject({ ok: true, state: "cancelled" })
    // The approval answers when its worker stops, as the cancel takes the row.
    const answered = await approving
    expect(answered).toMatchObject({ ok: false })
    expect(["cancel_requested", "cancelled"]).toContain(answered.state)
    expect(harness.factory.show(row.id)).toMatchObject({ state: "cancelled" })
    expect(fake.pulls).toEqual([])
    expect(fake.writes()).not.toContain("createDraftPull")
    // The approval's key is answered once, and a replay returns that answer.
    expect(await approve(row)).toEqual(answered)
  })

  it("leaves no outbox intent when a cancel lands during the re-verification", async () => {
    const fake = github()
    harness = await issueHarness({ delivery: delivery(fake) })
    const row = await harness.toBundle({ deliver: DRAFT_PR })
    harness.verifier.script = { verdict: "pass", delayMs: 300 }
    const approving = approve(row)
    await waitForEvent(row.id, "approve_started")
    await new Promise((r) => setTimeout(r, 50))
    expect(await harness.factory.cancel(row.id)).toMatchObject({ ok: true, state: "cancelled" })
    expect(await approving).toMatchObject({
      ok: false,
      state: "cancelled",
      message: "Work order changed state while approving",
    })
    expect(outboxRows(row.id)).toBe(0)
    expect(fake.writes()).toEqual([])
  })
})

function registryRows(id: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(join((harness as IssueHarness).dir, "registry.sqlite"))
  try {
    return db.prepare(sql).all(id) as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

function outboxRows(id: string): number {
  return registryRows(id, "SELECT 1 FROM delivery_outbox WHERE work_order_id = ?").length
}

function writeRegistry(sql: string, ...params: string[]): void {
  const db = new DatabaseSync(join((harness as IssueHarness).dir, "registry.sqlite"))
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

async function waitForEvent(id: string, type: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(harness as IssueHarness).factory.events(id).some((e) => e.type === type)) {
    if (Date.now() > deadline) throw new Error(`no ${type} on ${id}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
