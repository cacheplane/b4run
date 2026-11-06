import { afterEach, describe, expect, it } from "vitest"
import { body, fixture as makeFixture, threadId, token } from "./fixtures/protocol-admission.ts"

function required<T>(value: T | undefined): T {
  expect(value).toBeDefined()
  if (value === undefined) throw new Error("Required fixture record is absent")
  return value
}
const fixtures: Awaited<ReturnType<typeof makeFixture>>[] = []
afterEach(async () => {
  for (const value of fixtures.splice(0)) await value.close()
})
async function setup() {
  const f = await makeFixture()
  fixtures.push(f)
  return { f, body, token, threadId }
}
describe("indexed operation receipt search", () => {
  it("returns the actual Run with query-scoped receipt metadata without changing its stored projection", async () => {
    const { f, token } = await setup()
    const result = await f.admit()
    const rows = await f.lookup()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.run_id).toBe(result.runId)
    expect(rows[0]?.metadata.b4).toMatchObject({
      lookup: { submissionId: token, state: "accepted", receipt: { runId: result.runId } },
    })
    expect(JSON.stringify(rows)).not.toContain("fingerprint")
    expect(JSON.stringify(rows)).not.toContain("scopeKey")
    expect((await f.snapshot(result.threadId)).runs[0]?.metadata.lookup).toBeUndefined()
    expect((await f.search({}))[0]?.metadata.b4).not.toHaveProperty("lookup")
  })
  it("uses literal selectors and ordinary literal metadata equality", async () => {
    const { f, body } = await setup()
    const accepted = await f.admit(
      body({
        metadata: {
          b4: { v: 1, submissionId: "10000000-0000-4000-8000-000000000010" },
          "a.b": { c: 1 },
        },
      }),
    )
    expect(await f.lookup(undefined, { "a.b": { c: 1 } })).toHaveLength(1)
    expect(await f.lookup(undefined, { a: { b: { c: 1 } } })).toEqual([])
    expect(await f.lookup(undefined, { "b4.targetRunId": accepted.runId })).toHaveLength(1)
    expect(await f.lookup(undefined, { "b4.operationThreadId": accepted.threadId })).toHaveLength(1)
    await expect(
      f.search({ "b4.submissionId": "10000000-0000-4000-8000-000000000010" }),
    ).rejects.toMatchObject({ code: "invalid_argument" })
  })
  it.each(["input.inject", "state.fork"])(
    "finds %s from the authoritative operation ledger, not Run admission metadata",
    async (method) => {
      const { f, token } = await setup()
      const accepted = await f.admit()
      const snapshot = await f.snapshot(accepted.threadId)
      const original = required(snapshot.receipts[0])
      const operationId = "10000000-0000-4000-8000-000000000021"
      await f.seedReceipt(accepted.threadId, {
        ...original,
        receiptId: `${original.receiptId}-${method}`,
        receipt: { ...original.receipt, submissionId: operationId, disposition: "applied" },
        operation: {
          ...required(original.operation),
          method,
          targetRunId: accepted.runId,
          operationThreadId: accepted.threadId,
        },
      })
      expect((await f.lookup(operationId))[0]?.run_id).toBe(accepted.runId)
      expect((await f.lookup(operationId))[0]?.metadata.b4).toMatchObject({
        submissionId: token,
        lookup: { receipt: { submissionId: operationId, disposition: "applied" } },
      })
      expect((await f.lookup(token))[0]?.metadata.b4).toMatchObject({
        lookup: { receipt: { submissionId: token, disposition: "accepted" } },
      })
    },
  )
  it("reports expired without receipt and never executes a spent token fresh", async () => {
    const { f } = await setup()
    const accepted = await f.admit()
    const row = required((await f.snapshot(accepted.threadId)).receipts[0])
    await f.seedReceipt(accepted.threadId, { ...row, state: "spent" })
    expect((await f.lookup())[0]?.metadata.b4).toMatchObject({ lookup: { state: "expired" } })
    expect(required((await f.lookup())[0]).metadata.b4).not.toHaveProperty("lookup.receipt")
    await expect(f.admit()).rejects.toMatchObject({ code: "receipt_expired" })
    expect((await f.snapshot(accepted.threadId)).runs).toHaveLength(1)
  })
  it("returns authorized target-gone diagnostics before pagination and conceals them after revocation", async () => {
    const { f } = await setup()
    const result = await f.admit()
    await (await f.store(result.threadId)).transaction((tx) => tx.runs.delete(result.runId))
    await expect(f.lookup()).rejects.toMatchObject({ code: "submission_target_gone" })
    await expect(f.admit()).rejects.toMatchObject({ code: "submission_target_gone" })
    f.deny()
    expect(await f.lookup()).toEqual([])
    await expect(f.admit()).rejects.toMatchObject({ code: "not_found" })
  })
  it("checks authorized ambiguity before pagination and supports target disambiguation", async () => {
    const { f, body, token, threadId } = await setup()
    const first = await f.admit()
    const second = await f.admit(body({ thread_id: threadId, if_not_exists: "create" }))
    await expect(
      f.search({ "b4.submissionId": token, "b4.submissionKind": "b4" }, { limit: 1, offset: 999 }),
    ).rejects.toMatchObject({ code: "submission_ambiguous" })
    expect((await f.lookup(token, { "b4.operationThreadId": threadId }))[0]?.run_id).toBe(
      second.runId,
    )
    expect((await f.lookup(token, { "b4.targetRunId": first.runId }))[0]?.run_id).toBe(first.runId)
    expect(
      await f.search({ "b4.submissionId": token, "b4.submissionKind": "b4" }, {}, "bob"),
    ).toEqual([])
  })
  it("applies standard Thread/agent/status filters to the actual Run", async () => {
    const { f, token } = await setup()
    const accepted = await f.admit()
    const metadata = { "b4.submissionId": token, "b4.submissionKind": "b4" }
    expect(
      await f.search(metadata, {
        thread_id: accepted.threadId,
        agent_id: "/chat#agent",
        status: "pending",
      }),
    ).toHaveLength(1)
    expect(await f.search(metadata, { status: "success" })).toEqual([])
    expect(await f.lookup("10000000-0000-4000-8000-000000000090")).toEqual([])
  })
})

it("uses a fork's original source selector/provenance while returning its actual destination Run", async () => {
  const { f } = await setup()
  const accepted = await f.admit()
  const original = required((await f.snapshot(accepted.threadId)).receipts[0])
  const source = "10000000-0000-4000-8000-000000000080",
    forkToken = "10000000-0000-4000-8000-000000000081"
  await f.seedReceipt(accepted.threadId, {
    ...original,
    receiptId: `${original.receiptId}-fork-source`,
    receipt: { ...original.receipt, submissionId: forkToken },
    operation: {
      ...required(original.operation),
      method: "state.fork",
      operationThreadId: source,
      provenance: { ...required(original.operation).provenance, sourceThreadId: source },
    },
  })
  const rows = await f.lookup(forkToken, { "b4.operationThreadId": source })
  expect(rows[0]?.run_id).toBe(accepted.runId)
  expect(rows[0]?.thread_id).toBe(accepted.threadId)
  expect(f.policyRequests().at(-1)?.provenance?.sourceThreadId).toBe(source)
  expect(
    await f.search(
      { "b4.submissionId": forkToken, "b4.submissionKind": "b4" },
      { thread_id: source },
    ),
  ).toEqual([])
})
it("uses arbitrary native AG-UI submission IDs through the same ledger", async () => {
  const { f } = await setup()
  const accepted = await f.admit()
  const row = required((await f.snapshot(accepted.threadId)).receipts[0])
  await f.seedReceipt(accepted.threadId, {
    ...row,
    receiptId: `${row.receiptId}-native`,
    receipt: { ...row.receipt, submissionKind: "agui", submissionId: "native/session-1" },
  })
  const rows = await f.search({
    "b4.submissionId": "native/session-1",
    "b4.submissionKind": "agui",
  })
  expect(rows[0]?.run_id).toBe(accepted.runId)
})

it("orders Run search by created_at instant descending before pagination, then ID ascending", async () => {
  const { f, body } = await setup()
  const entries = await Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      f.admit(
        body({
          metadata: { b4: { v: 1, submissionId: `10000000-0000-4000-8000-00000000009${index}` } },
        }),
      ),
    ),
  )
  entries.sort((a, b) => a.runId.localeCompare(b.runId))
  const dates = ["2026-01-01T00:00:00Z", "2026-02-01T01:00:00+01:00", "2026-02-01T00:00:00Z"]
  for (const [index, entry] of entries.entries())
    await (await f.store(entry.threadId)).transaction(async (tx) => {
      const row = required(await tx.runs.get(entry.runId))
      await tx.runs.put({ ...row, run: { ...row.run, created_at: required(dates[index]) } })
    })
  expect((await f.search({}, { limit: 1 }))[0]?.run_id).toBe(required(entries[1]).runId)
  expect((await f.search({}, { limit: 1, offset: 1 }))[0]?.run_id).toBe(required(entries[2]).runId)
  expect((await f.search({}, { limit: 1, offset: 2 }))[0]?.run_id).toBe(required(entries[0]).runId)
})
