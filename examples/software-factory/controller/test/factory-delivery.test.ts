import { afterEach, describe, expect, it } from "vitest"
import type { FactoryOptions } from "../src/lib/controller/factory.ts"
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
