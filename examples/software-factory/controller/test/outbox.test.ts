import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createOutboxStore,
  type DeliveryIntent,
  deliveryOperationKey,
  StaleOutboxStepError,
} from "../src/lib/delivery/outbox.ts"
import { openRegistry, type Registry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore } from "../src/lib/registry/work-orders.ts"

let dir: string | undefined
let registry: Registry | undefined
afterEach(() => {
  registry?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
  registry = undefined
  dir = undefined
})

const ID = "wo-0123456789abcdef"
const intent: DeliveryIntent = {
  version: 1,
  workOrderId: ID,
  bundleDigest: "b".repeat(64),
  candidateDigest: "c".repeat(64),
  candidateArtifact: "a".repeat(64),
  repository: "cacheplane/b4run",
  baseBranch: "main",
  branch: `factory/${ID}`,
  pin: "7".repeat(40),
  pathPrefix: ".",
  issue: { number: 912, stateAtCreate: "open" },
  paths: [
    {
      path: "a.ts",
      workspacePath: "a.ts",
      baselineBlob: "1".repeat(40),
      candidateBlob: "2".repeat(40),
    },
  ],
  title: "factory: t",
  specText: "# t\n",
  approvedAt: "2026-10-01T00:00:00.000Z",
  decidedBy: "operator",
  digests: {
    task: "d".repeat(64),
    policy: "e".repeat(64),
    environment: "env",
    oracleReceiptId: null,
    receiptId: "rc",
    reverificationReceiptId: "rc2",
  },
}

function open() {
  dir = mkdtempSync(join(tmpdir(), "outbox-"))
  registry = openRegistry(join(dir, "registry.sqlite"))
  const store = createWorkOrderStore(registry.db)
  const at = "2026-10-01T00:00:00.000Z"
  store.insert({
    id: ID,
    revision: 0,
    state: "awaiting_approval",
    taskId: ID,
    workerRoute: "/build#agent",
    workerThreadId: null,
    interruptId: null,
    candidateDigest: null,
    bundleDigest: null,
    blockedReason: null,
    failureReason: null,
    candidateAttempts: 1,
    maxCandidateAttempts: 2,
    maxActiveMs: 1000,
    activeMs: 0,
    activeStartedAt: null,
    awaitingSince: at,
    origin: {
      kind: "issue",
      repository: "cacheplane/b4run",
      number: 912,
      bodyDigest: "0".repeat(64),
    },
    pin: "7".repeat(40),
    delivery: { kind: "local" },
    targetId: null,
    taskDigest: null,
    intakeAttempts: 0,
    maxIntakeAttempts: 2,
    createdAt: at,
    updatedAt: at,
  })
  store.recordApproval({
    id: "ap-1",
    workOrderId: ID,
    bundleDigest: "b".repeat(64),
    candidateDigest: "c".repeat(64),
    decision: "approved",
    decidedBy: "operator",
    decidedAt: at,
    expiresAt: at,
  })
  return createOutboxStore(registry.db)
}

describe("the delivery outbox", () => {
  it("holds one intent per work order, starting pending", () => {
    const outbox = open()
    outbox.insert({ approvalId: "ap-1", intent, now: "t0" })
    expect(outbox.get(ID)).toMatchObject({
      step: "pending",
      remote: {},
      attempts: 0,
      intent,
      // Derived, never free-form: one work order's delivery of one bundle has one key.
      operationKey: deliveryOperationKey(ID, "b".repeat(64)),
    })
    expect(() => outbox.insert({ approvalId: "ap-1", intent, now: "t1" })).toThrow(/UNIQUE/)
  })

  it("advances one step at a time, merging what each step observed", () => {
    const outbox = open()
    outbox.insert({ approvalId: "ap-1", intent, now: "t0" })
    outbox.advance(ID, "pending", "checked", { commit: { sha: "3".repeat(40) } }, "t1")
    const row = outbox.advance(
      ID,
      "checked",
      "committed",
      { branch: { headSha: "4".repeat(40) } },
      "t2",
    )
    expect(row.remote).toEqual({
      commit: { sha: "3".repeat(40) },
      branch: { headSha: "4".repeat(40) },
    })
    expect(() => outbox.advance(ID, "pending", "checked", {}, "t3")).toThrow(StaleOutboxStepError)
  })

  it("advances only to the next step, and never overwrites what a step observed", () => {
    const outbox = open()
    outbox.insert({ approvalId: "ap-1", intent, now: "t0" })
    expect(() => outbox.advance(ID, "pending", "committed", {}, "t1")).toThrow(/next step/)
    expect(() => outbox.advance(ID, "pending", "pending", {}, "t1")).toThrow(/next step/)
    outbox.advance(ID, "pending", "checked", { commit: { sha: "3".repeat(40) } }, "t1")
    expect(() =>
      outbox.advance(ID, "checked", "committed", { commit: { sha: "4".repeat(40) } }, "t2"),
    ).toThrow(/already observed commit/)
    expect(outbox.get(ID)).toMatchObject({
      step: "checked",
      remote: { commit: { sha: "3".repeat(40) } },
    })
  })

  it("counts attempts with their error, and clears the error without counting", () => {
    const outbox = open()
    outbox.insert({ approvalId: "ap-1", intent, now: "t0" })
    outbox.note(ID, "HTTP 502", "t1")
    outbox.note(ID, "HTTP 502", "t2")
    expect(outbox.get(ID)).toMatchObject({ attempts: 2, lastError: "HTTP 502" })
    outbox.note(ID, null, "t3")
    expect(outbox.get(ID)).toMatchObject({ attempts: 2, lastError: null })
  })

  it("refuses an intent that does not parse", () => {
    const outbox = open()
    expect(() =>
      outbox.insert({
        approvalId: "ap-1",
        intent: { ...intent, branch: "main" } as DeliveryIntent,
        now: "t0",
      }),
    ).toThrow()
    // Paths have one spelling (domain/path.ts): the worker compares them by string equality.
    for (const bad of [
      { ...intent, pathPrefix: "./pkg" },
      { ...intent, pathPrefix: "pkg/" },
      { ...intent, paths: [{ ...intent.paths[0], path: "../a.ts" }] },
      { ...intent, paths: [{ ...intent.paths[0], workspacePath: "/a.ts" }] },
    ])
      expect(() =>
        outbox.insert({
          approvalId: "ap-1",
          intent: bad as DeliveryIntent,
          now: "t0",
        }),
      ).toThrow()
    expect(outbox.get(ID)).toBeNull()
  })
})
